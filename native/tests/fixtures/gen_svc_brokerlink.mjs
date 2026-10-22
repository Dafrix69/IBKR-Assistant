// 生成 svc_brokerlink.json:engine-ts 的 services/brokerLink.ts(原模块现跑)对着真的 BrokerRouter 与脚本驱动的假会话、虚拟钟、真的交易库。
// 场景:连 / 断 / 启动自动连 / 从没连上的连接定时再试 / 掉线重连的提醒 / 反复断开时收声 / 连接动作排队,再加种子固定的随机交错。
// C++ 一半:tests/tst_svc_brokerlink.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_svc_brokerlink.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadMods, makeFactory, rng, runScript } from './svc_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const mods = await loadMods(engine);
const { BrokerLinkService } = await mods.imp('services/brokerLink');

function build(world, host) {
  const svc = new BrokerLinkService(host);
  svc.makeRouter = () => new mods.broker.BrokerRouter(host.settings, makeFactory(world, host.settings));
  return {
    methods: {
      connect: (a) => svc.connect(a.names).then((r) => r),
      disconnect: () => svc.disconnect().then(() => null),
      retryOnce: () => svc.retryOnce().then(() => null),
      external: async (a) => { host.router = new mods.broker.BrokerRouter(host.settings, makeFactory(world, host.settings)); await host.router.connect(a.name); return null; },
    },
    gets: { router: () => (host.router === null ? null : 'router'), connected: () => (host.router === null ? [] : host.router.connectedNames()) },
    ops: {
      start: () => svc.start(),
      stop: () => svc.stop(),
      forget: () => svc.forget(),
      router: () => { host.router = null; },
    },
    stop: () => svc.stop(),
  };
}

const START = Date.parse('2026-10-12T09:40:00-04:00');
const SEC = 1000;
const call = (id, m, a = {}) => ({ op: 'call', id, m, a });
const S = (name, over = {}) => ({ name, accounts: [], caps: ['OnLink', 'SetBaselineMarketDataType'], ...over });
const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, trackEngine: true, dump: ['audit_log'], ...script } });

add('connect 全部:按名字排序连、记账、先碰引擎再丢再取、审计', {
  sessions: [S('L'), S('P')],
  factory: { live: ['L'], paper: ['P'] },
  steps: [call('c', 'connect'), { op: 'get', what: 'connected' }, call('c2', 'connect'), { op: 'get', what: 'router' }],
});
add('connect 指定名字;不存在的连接是 failed;连不上的是 failed 且原因逐字', {
  sessions: [S('L')],
  factory: { live: ['L'], paper: [{ error: 'connect ECONNREFUSED' }] },
  steps: [call('c', 'connect', { names: ['paper', 'live', 'nope'] }), call('c2', 'connect', { names: ['paper'] }), call('c3', 'connect', { names: [] })],
});
add('一条都没连上:不暖机不碰引擎的那一步,但丢引擎、挂监听、审计照做', {
  sessions: [],
  factory: {},
  steps: [call('c', 'connect'), { op: 'get', what: 'router' }],
});
add('连接带延迟:两个 connect 排队,后一个等前一个', {
  sessions: [S('L'), S('P')],
  factory: { live: [{ error: 'slow', delay: 5000 }, 'L'], paper: ['P'] },
  steps: [call('a', 'connect', { names: ['live'] }), call('b', 'connect'), { op: 'advance', ms: 4000 }, { op: 'advance', ms: 2000 }, { op: 'advance', ms: 1000 }],
});
add('start:auto_connect 开着 → 启动即连、定时器 30 秒一轮;从没连上的才重连', {
  sessions: [S('L'), S('P')],
  factory: { live: ['L'], paper: [{ error: 'connect ECONNREFUSED' }, { error: 'again' }, 'P'] },
  steps: [{ op: 'start' }, { op: 'advance', ms: 29999 }, { op: 'advance', ms: 1 }, { op: 'advance', ms: 30000 }, { op: 'advance', ms: 30000 }, { op: 'advance', ms: 60000 }, { op: 'stop' }, { op: 'advance', ms: 60000 }],
});
add('start:auto_connect 关着什么都不做', {
  settings: { broker: { auto_connect: false } },
  sessions: [S('L')], factory: { live: ['L'] },
  steps: [{ op: 'start' }, { op: 'advance', ms: 100000 }],
});
add('disconnect:之后不再自动连;重新 connect 又开始', {
  sessions: [S('L'), S('P')],
  factory: { live: ['L', 'L'], paper: [{ error: 'x' }, 'P'] },
  steps: [{ op: 'start' }, { op: 'advance', ms: 1000 }, call('d', 'disconnect'), { op: 'advance', ms: 100000 }, { op: 'get', what: 'router' }, call('c', 'connect'), { op: 'advance', ms: 31000 }, call('d2', 'disconnect'), call('d3', 'disconnect')],
});
add('disconnect 排在连接动作后面;disconnectAll 带延迟 / 抛错', {
  sessions: [S('L', { disconnectDelay: 3000 }), S('P', { throwDisconnect: true })],
  factory: { live: ['L'], paper: ['P'] },
  steps: [call('c', 'connect'), call('d', 'disconnect'), { op: 'advance', ms: 4000 }, call('c2', 'connect'), call('d2', 'disconnect'), { op: 'advance', ms: 4000 }],
});
add('forget:换券商后不再自动连', {
  sessions: [S('L')], factory: { live: ['L'] },
  steps: [{ op: 'start' }, { op: 'advance', ms: 1000 }, { op: 'forget' }, { op: 'advance', ms: 100000 }],
});
add('掉线一次、重连一次:各说一句、审计、推事件;重连还触发对账', {
  sessions: [S('L')], factory: { live: ['L'] },
  steps: [call('c', 'connect', { names: ['live'] }), { op: 'advance', ms: 20000 }, { op: 'emitLink', session: 'L', up: false }, { op: 'advance', ms: 5000 }, { op: 'emitLink', session: 'L', up: true }, { op: 'advance', ms: 20000 }],
});
add('掉线时重复报掉线只说一次', {
  sessions: [S('L')], factory: { live: ['L'] },
  steps: [call('c', 'connect', { names: ['live'] }), { op: 'emitLink', session: 'L', up: false }, { op: 'emitLink', session: 'L', up: false }, { op: 'emitLink', session: 'L', up: true }, { op: 'emitLink', session: 'L', up: true }],
});
add('反复断开:连上不到 10 秒又断两次算抖动,提醒一次、之后安静,汇总每分钟一行,稳定 10 秒后再说一声', {
  sessions: [S('L')], factory: { live: ['L'] },
  steps: [call('c', 'connect', { names: ['live'] }),
    { op: 'emitLink', session: 'L', up: false }, { op: 'advance', ms: 5000 }, { op: 'emitLink', session: 'L', up: true }, { op: 'advance', ms: 2000 },
    { op: 'emitLink', session: 'L', up: false }, { op: 'advance', ms: 1000 }, { op: 'emitLink', session: 'L', up: true }, { op: 'advance', ms: 1000 },
    { op: 'emitLink', session: 'L', up: false }, { op: 'advance', ms: 1000 }, { op: 'emitLink', session: 'L', up: true }, { op: 'advance', ms: 3000 },
    { op: 'emitLink', session: 'L', up: false }, { op: 'advance', ms: 70000 }, { op: 'emitLink', session: 'L', up: false },
    { op: 'emitLink', session: 'L', up: true }, { op: 'advance', ms: 9999 }, { op: 'advance', ms: 2 },
    { op: 'emitLink', session: 'L', up: false }, { op: 'emitLink', session: 'L', up: true }, { op: 'advance', ms: 30000 }],
});
add('反复断开期间稳定计时被新的断开打断', {
  sessions: [S('L')], factory: { live: ['L'] },
  steps: [call('c', 'connect', { names: ['live'] }),
    { op: 'emitLink', session: 'L', up: true }, { op: 'advance', ms: 1000 }, { op: 'emitLink', session: 'L', up: false }, { op: 'emitLink', session: 'L', up: true }, { op: 'advance', ms: 1000 },
    { op: 'emitLink', session: 'L', up: false }, { op: 'emitLink', session: 'L', up: true }, { op: 'advance', ms: 8000 }, { op: 'emitLink', session: 'L', up: false },
    { op: 'advance', ms: 20000 }, { op: 'emitLink', session: 'L', up: true }, { op: 'advance', ms: 11000 }, { op: 'stop' }, { op: 'advance', ms: 5000 }],
});
add('两条连接各记各的账', {
  sessions: [S('L'), S('P')], factory: { live: ['L'], paper: ['P'] },
  steps: [call('c', 'connect'), { op: 'emitLink', session: 'L', up: false }, { op: 'emitLink', session: 'P', up: false }, { op: 'emitLink', session: 'L', up: true }, { op: 'emitLink', session: 'P', up: true }],
});
add('重试:排队期间用户点了断开 / 换了 router,这一轮放手;重试里抛的话进 stderr', {
  sessions: [S('L'), S('P')],
  factory: { live: ['L'], paper: [{ error: 'e1', delay: 2000 }, { error: 'e2' }, 'P'] },
  steps: [call('c', 'connect', { names: ['live'] }), { op: 'start' }, { op: 'advance', ms: 1000 }, call('d', 'disconnect'), { op: 'advance', ms: 5000 }, { op: 'advance', ms: 70000 }],
});
add('重试:router 已有但换了(external)的情形:router 被外部置空后一轮重连', {
  sessions: [S('L'), S('P')], factory: { live: ['L', 'L'], paper: ['P'] },
  steps: [call('c', 'connect'), { op: 'start' }, { op: 'router' }, { op: 'advance', ms: 30000 }, { op: 'advance', ms: 30000 }, { op: 'get', what: 'connected' }],
});
add('连接配置里新增了一条:定时重试把新增的连上', {
  sessions: [S('L'), S('P'), S('X')], factory: { live: ['L'], paper: ['P'], extra: ['X'] },
  steps: [call('c', 'connect'), { op: 'start' }, { op: 'settings', patch: { connections: { extra: { host: '127.0.0.1', port: 7499, client_id: 13 } } } }, { op: 'advance', ms: 30000 }, { op: 'advance', ms: 30000 }, { op: 'stop' }],
});
add('夜里连上:暖机分支(这里期货设空,不进暖机)', {
  start: Date.parse('2026-10-12T20:00:00-04:00'),
  settings: { index_symbols: { SPX: { futures: '' } } },
  sessions: [S('L')], factory: { live: ['L'] },
  steps: [call('c', 'connect', { names: ['live'] })],
});

const UP = (s) => ({ op: 'emitLink', session: s, up: true });
const DOWN = (s) => ({ op: 'emitLink', session: s, up: false });
const ADV = (ms) => ({ op: 'advance', ms });
add('抖动判定的边界:连上恰好 10 秒才断不算抖动', {
  sessions: [S('L')], factory: { live: ['L'] },
  steps: [call('c', 'connect', { names: ['live'] }), UP('L'), ADV(10000), DOWN('L'), UP('L'), ADV(10000), DOWN('L'), UP('L'), ADV(9999), DOWN('L')],
});
add('一分钟窗口的边界:第一次抖动恰好 60 秒前的不算', {
  sessions: [S('L')], factory: { live: ['L'] },
  steps: [call('c', 'connect', { names: ['live'] }), UP('L'), ADV(1000), DOWN('L'), ADV(58000), UP('L'), ADV(2000), DOWN('L'), ADV(1000), UP('L'), ADV(1000), DOWN('L')],
});
add('反复断开期间的汇总:恰好隔 60 秒就写一行', {
  sessions: [S('L')], factory: { live: ['L'] },
  steps: [call('c', 'connect', { names: ['live'] }), UP('L'), ADV(1000), DOWN('L'), UP('L'), ADV(500), DOWN('L'), ADV(59999), DOWN('L'), ADV(1), DOWN('L'), ADV(60000), DOWN('L')],
});
add('反复断开期间连上两次:前一个稳定计时被取消', {
  sessions: [S('L')], factory: { live: ['L'] },
  steps: [call('c', 'connect', { names: ['live'] }), UP('L'), ADV(1000), DOWN('L'), UP('L'), ADV(500), DOWN('L'), UP('L'), ADV(5000), UP('L'), ADV(6000), ADV(5000), ADV(10000)],
});
add('重试循环里 router 被换掉:这一轮放手,不再连后面的', {
  settings: { connections: { extra: { host: '127.0.0.1', port: 7499, client_id: 13 } } },
  sessions: [S('L'), S('P'), S('X')], factory: { live: ['L'], paper: ['P'], extra: [{ error: 'slow', delay: 2000 }] },
  steps: [call('c', 'connect', { names: ['live'] }), { op: 'start' }, ADV(1000), { op: 'router' }, ADV(3000), ADV(60000)],
});
add('router 不是服务自己建的(外部换上):重试时认下它,已连的不重连、掉线提醒接上', {
  sessions: [S('L'), S('P')], factory: { live: ['L', 'L'], paper: ['P'] },
  steps: [call('c', 'connect', { names: [] }), call('ext', 'external', { name: 'live' }), call('r', 'retryOnce'), DOWN('L'), UP('L')],
});
add('夜里连上:暖机(期货推算)走一圈(同一时刻内的先后不比)', {
  sortLog: true,
  start: Date.parse('2026-10-12T20:00:00-04:00'),
  sessions: [S('L')], factory: { live: ['L'] },
  steps: [call('c', 'connect', { names: ['live'] }), ADV(1000), ADV(4000), ADV(20000)],
});

add('stop():反复断开之后稳定计时还在等的,stop 就撤掉,之后不再报「稳定」', {
  sessions: [S('L')], factory: { live: ['L'] },
  steps: [call('c', 'connect', { names: ['live'] }), UP('L'), ADV(1000), DOWN('L'), UP('L'), ADV(500), DOWN('L'), UP('L'), ADV(2000), { op: 'stop' }, ADV(30000)],
});

// ---- 种子固定的随机交错
{
  const r = rng(0x11ee_c0de);
  for (let n = 0; n < 60; n += 1) {
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const sessions = names.map((nm) => S(nm, { disconnectDelay: r.chance(0.2) ? r.pick([100, 3000]) : 0, throwDisconnect: r.chance(0.05) }));
    let nextSession = 0; // 每个工厂位用自己的会话:真会话不会被两个 router 共用
    const fac = () => Array.from({ length: 1 + r.int(4) }, () => (r.chance(0.35) ? { error: r.pick(['connect ECONNREFUSED', 'boom']), ...(r.chance(0.3) ? { delay: r.pick([200, 5000, 12000]) } : {}) } : names[Math.min(nextSession++, names.length - 1)]));
    const factory = { live: fac(), paper: fac() };
    const steps = [];
    for (let i = 0; i < 28; i += 1) {
      const p = r.next();
      const sess = r.pick(names);
      if (p < 0.14) steps.push(call(`c${i}`, 'connect', r.chance(0.5) ? {} : { names: ['live', 'paper'].filter(() => r.chance(0.6)) }));
      else if (p < 0.19) steps.push(call(`d${i}`, 'disconnect'));
      else if (p < 0.27) steps.push(call(`r${i}`, 'retryOnce'));
      else if (p < 0.43) steps.push({ op: 'advance', ms: r.pick([1, 500, 3000, 9999, 10001, 29999, 30000, 65000]) });
      else if (p < 0.70) steps.push({ op: 'emitLink', session: sess, up: r.chance(0.5) });
      else if (p < 0.75) steps.push({ op: 'start' });
      else if (p < 0.79) steps.push({ op: 'stop' });
      else if (p < 0.82) steps.push({ op: 'forget' });
      else if (p < 0.85) steps.push({ op: 'advance', ms: 1000 });
      else if (p < 0.90) steps.push({ op: 'sess', session: sess, set: { connected: r.chance(0.6) } });
      else if (p < 0.95) steps.push({ op: 'get', what: 'connected' });
      else steps.push({ op: 'settings', patch: { broker: { auto_connect: r.chance(0.5) } } });
    }
    steps.push({ op: 'stop' }, { op: 'advance', ms: 60000 });
    scenarios.push({ name: `随机 ${n}`, script: { start: START, seed: n + 1, trackEngine: r.chance(0.5), dump: ['audit_log'], factory, sessions, steps } });
  }
}

const out = [];
for (const s of scenarios) {
  const script = enc(s.script);
  const expected = await runScript(structuredClone(s.script), mods, build);
  out.push({ name: s.name, script, expected: enc(expected) });
}
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out });
writeFileSync(join(here, 'svc_brokerlink.json'), text);
console.log(`svc_brokerlink.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
