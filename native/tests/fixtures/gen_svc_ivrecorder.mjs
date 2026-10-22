// 生成 svc_ivrecorder.json:engine-ts 的 services/ivRecorder.ts(原模块现跑)对着脚本驱动的假 router 与假盘口读取、真的交易库(开关偏好)与日文件 fly-iv/、虚拟钟:
// 每五分钟记一笔、行权价锚、什么时候不记及原因、测算顺带记、状态。C++ 一半:tests/tst_svc_ivrecorder.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_svc_ivrecorder.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, enc, loadMods, makeMarks, rng, runScript } from './svc_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const mods = await loadMods(engine);
const { IvRecorderService } = await mods.imp('services/ivRecorder');

function build(world, host) {
  const svc = new IvRecorderService(host, makeMarks(world));
  return {
    methods: {
      tickOnce: (a) => svc.tickOnce(a.now),
      setEnabled: (a) => svc.setEnabled(a.on),
      recordPlan: (a) => svc.recordPlan(a.sample),
      status: () => svc.status(),
    },
    gets: { status: () => svc.status(), enabled: () => svc.enabled() },
    ops: { start: (step) => svc.start(step.tickMs), stop: () => svc.stop() },
    stop: () => svc.stop(),
  };
}

const ET = (iso) => Date.parse(iso);
const START = ET('2026-10-12T10:30:00-04:00');
const call = (id, m, a = {}) => ({ op: 'call', id, m, a });
const st = (m, a) => ({ op: 'store', m, a });
const R = (value, extra = {}) => ({ value, ...extra });
const E = (error, extra = {}) => ({ error, ...extra });
const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, dump: ['audit_log', 'app_prefs'], files: ['fly-iv'], ...script } });
const router = (over = {}) => ({ results: { indexPrice: [R(7752.5)] }, spotInfo: { SPX: { source: 'index' } }, marketSession: { accounts: ['U1234567'] }, ...over });
const GOOD = { dflt: { bid: 5.1, ask: 5.5, iv: 0.12 } };
const sample = (over = {}) => ({ t: START, symbol: 'SPX', expiry: '20261012', trading_class: 'SPXW', spot: 7750, spot_source: 'quote',
  legs: [{ strike: 7730, right: 'C', bid: 1, ask: 1.2, iv: 0.1 }, { strike: 7750, right: 'C', bid: 2, ask: 2.2, iv: 0.11 }], ...over });

add('tickOnce:记一笔(锚 = 现价取整,一圈行权价);五分钟内不再记;到点再记;文件与状态', {
  router: router(), marks: [GOOD],
  steps: [{ op: 'port', v: 'make' }, call('a', 'tickOnce'), call('b', 'tickOnce'), { op: 'advance', ms: 300000 }, call('c', 'tickOnce'), { op: 'get', what: 'status' }, { op: 'advance', ms: 299999 }, call('d', 'tickOnce'), { op: 'advance', ms: 2 }, call('e', 'tickOnce'), call('f', 'status')],
});
add('锚:现价走远加一对平值;重启后从今天的文件里读回锚', {
  router: router({ results: { indexPrice: [R(7752.5), R(7790.2), R(7802)] } }), marks: [GOOD],
  steps: [{ op: 'port', v: 'make' }, call('a', 'tickOnce', { now: START }), call('b', 'tickOnce', { now: START + 300000 }), call('c', 'tickOnce', { now: START + 600000 })],
});
add('不记的原因:关闭 / 没连 / 非 IBKR(这里用盘外)/ 盘外 / 没现价 / 昨收 / 只有模型 IV / 一条都没来 / 订阅被拒 / 出错', {
  router: router({ results: { indexPrice: [R(null), R(7752.5), R(7752.5), R(7752.5), R(7752.5), E('指数价挂了'), R(7752.5)] } }),
  marks: [{ dflt: { bid: null, ask: null, iv: 0.1 } }, {}, { byLeg: { '7750P': { error: 'TWS 10197', bid: null, ask: null, iv: null } } }, E('读盘口失败'), GOOD],
  steps: [call('n', 'tickOnce'), { op: 'port', v: 'make' }, call('o', 'setEnabled', { on: false }), call('o1', 'tickOnce'), call('o2', 'setEnabled', { on: true }),
    call('p', 'tickOnce', { now: ET('2026-10-12T08:00:00-04:00') }), call('q1', 'tickOnce', { now: START }), call('q2', 'tickOnce', { now: START + 300000 }), call('q3', 'tickOnce', { now: START + 600000 }), call('q4', 'tickOnce', { now: START + 900000 }),
    call('q5', 'tickOnce', { now: START + 1200000 }), call('q6', 'tickOnce', { now: START + 1500000 }), call('q7', 'tickOnce', { now: START + 1800000 }), call('st', 'status')],
});
add('现价取不到(spotInfo 昨收)/ 没有 SPX 配置', {
  router: router({ spotInfo: { SPX: { source: 'index_stale' } } }), marks: [GOOD],
  steps: [{ op: 'port', v: 'make' }, call('a', 'tickOnce'), { op: 'settings', patch: { index_symbols: { SPX: { exchange: 'CBOE', daily_trading_class: 'SPXW', monthly_trading_class: 'SPX' }, VIX: { exchange: 'CBOE', daily_trading_class: 'VIXW', monthly_trading_class: 'VIX' } } } }, call('b', 'tickOnce', { now: START + 400000 })],
});
add('recordPlan:当日到期、有 IV、一分钟一笔;新的一天第一笔顺手清老文件', {
  router: router(), marks: [GOOD],
  steps: [call('a', 'recordPlan', { sample: sample() }), call('b', 'recordPlan', { sample: sample() }), { op: 'advance', ms: 60001 }, call('c', 'recordPlan', { sample: sample({ t: START + 60001 }) }),
    call('d', 'recordPlan', { sample: sample({ t: START + 120002, expiry: '20261013' }) }), call('e', 'recordPlan', { sample: sample({ t: START + 120003, legs: [{ strike: 1, right: 'C', bid: 1, ask: 2, iv: null }] }) }),
    call('f', 'setEnabled', { on: false }), call('g', 'recordPlan', { sample: sample({ t: START + 200000 }) }), call('h', 'status'), call('i', 'recordPlan', { sample: { t: 'x' } })],
});
add('recordPlan 一分钟的边界:恰好 60 秒就记;锚的漫游边界:锚 7755,离锚恰好 20 点(7775)就添平值,7774.9 不添', {
  router: router({ results: { indexPrice: [R(7752.5), R(7775), R(7774.9)] } }), marks: [GOOD],
  steps: [{ op: 'port', v: 'make' }, call('a', 'recordPlan', { sample: sample() }), call('b', 'recordPlan', { sample: sample({ t: START + 60000 }) }), call('c', 'recordPlan', { sample: sample({ t: START + 120000 - 1 }) }),
    call('t1', 'tickOnce', { now: START }), call('t2', 'tickOnce', { now: START + 300000 }), call('t3', 'tickOnce', { now: START + 600000 })],
});
const dayFile = (anchor) => `fly-iv/2026-10-12.jsonl`;
add('锚:重启后从今天的文件里读回;锚离 0 / 1 很近时负行权价与 0 不记;现价离锚不到 20 点不添平值;一圈里的订阅被拒原因写进状态', {
  router: router({ results: { indexPrice: [R(80), R(7757), R(0), R(null)] } }),
  marks: [GOOD, { byLeg: { '7750P': { error: 'TWS 10197', bid: null, ask: null, iv: null } } }, GOOD, GOOD],
  steps: [{ op: 'file', path: 'fly-iv/2026-10-12.jsonl', content: JSON.stringify(sample({ t: START - 300000, by: 'loop', anchor: 76 })) + '\n' }, { op: 'port', v: 'make' },
    call('a', 'tickOnce', { now: START }), call('st1', 'status'), { op: 'file', path: 'fly-iv/2026-10-12.jsonl', content: '' },
    call('b', 'tickOnce', { now: START + 300000 }), call('st2', 'status'), call('c', 'tickOnce', { now: START + 600000 }), call('st3', 'status'), call('d', 'tickOnce', { now: START + 900000 }), call('st4', 'status')],
});
add('长报错只留 200 码元', {
  router: router(), marks: [E('x'.repeat(250), { kind: 'plain' })],
  steps: [{ op: 'port', v: 'make' }, call('a', 'tickOnce'), call('st', 'status')],
});
add('recordPlan:同一标的不同腿各记各的(键含腿)', {
  router: router(), marks: [GOOD],
  steps: [call('a', 'recordPlan', { sample: sample() }), call('b', 'recordPlan', { sample: sample({ legs: [{ strike: 7700, right: 'P', bid: 1, ask: 2, iv: 0.2 }] }) }), call('c', 'recordPlan', { sample: sample({ legs: [{ strike: 7700, right: 'C', bid: 1, ask: 2, iv: 0.2 }] }) })],
});
add('循环:start 之后每 tickMs 一轮;stop', {
  router: router(), marks: [GOOD],
  steps: [{ op: 'port', v: 'make' }, { op: 'start', tickMs: 30000 }, { op: 'start', tickMs: 1 }, { op: 'advance', ms: 30000 }, { op: 'advance', ms: 600000 }, { op: 'stop' }, { op: 'advance', ms: 300000 }, { op: 'get', what: 'enabled' }, { op: 'get', what: 'status' }],
});
add('开关偏好存坏了按开', {
  router: router(), marks: [GOOD],
  steps: [st('setPref', ['fly.iv_recorder', { enabled: 'no' }]), { op: 'get', what: 'enabled' }, st('setPref', ['fly.iv_recorder', 7]), { op: 'get', what: 'enabled' }, st('setPref', ['fly.iv_recorder', { enabled: false }]), { op: 'get', what: 'enabled' }],
});
{
  const r = rng(0x17ec_0a0d);
  for (let n = 0; n < 40; n += 1) {
    const marks = Array.from({ length: 3 }, () => (r.chance(0.15) ? E('读失败') : { dflt: r.pick([{ bid: 5, ask: 5.4, iv: 0.1 }, { bid: null, ask: null, iv: 0.1 }, {}]), ...(r.chance(0.2) ? { delay: r.pick([10, 3000]) } : {}) }));
    const rt = router({ results: { indexPrice: Array.from({ length: 4 }, () => (r.chance(0.1) ? E('x') : R(r.pick([7752.5, 7790, 7700, null])))) }, spotInfo: { SPX: r.pick([{ source: 'index' }, { source: 'futures' }, { source: 'index_stale' }]) }, marketSession: r.pick([{ accounts: ['U1'] }, { accounts: ['DU1'] }]) });
    const steps = [{ op: 'port', v: r.chance(0.9) ? 'make' : 'null' }];
    let t = r.pick([START, ET('2026-10-12T09:25:00-04:00'), ET('2026-10-12T15:50:00-04:00')]);
    for (let i = 0; i < 14; i += 1) {
      const p = r.next();
      if (p < 0.4) { t += r.pick([1, 30000, 299999, 300001]); steps.push(call(`t${i}`, 'tickOnce', r.chance(0.7) ? { now: t } : {})); }
      else if (p < 0.55) steps.push(call(`r${i}`, 'recordPlan', { sample: sample({ t: t + r.int(100000), expiry: r.pick(['20261012', '20261013']), legs: r.pick([sample().legs, [{ strike: 1, right: 'C', bid: 1, ask: 2, iv: null }]]) }) }));
      else if (p < 0.65) steps.push(call(`e${i}`, 'setEnabled', { on: r.chance(0.7) }));
      else if (p < 0.8) steps.push({ op: 'advance', ms: r.pick([1, 30000, 300000]) });
      else if (p < 0.85) steps.push({ op: 'start', tickMs: r.pick([30000, 1000]) });
      else if (p < 0.9) steps.push({ op: 'stop' });
      else if (p < 0.95) steps.push(call(`s${i}`, 'status'));
      else steps.push({ op: 'portSet', set: { sessions: r.pick([0, 1]) } });
    }
    steps.push({ op: 'stop' }, call('last', 'status'));
    scenarios.push({ name: `随机 ${n}`, script: { start: START, seed: n + 1, dump: ['audit_log', 'app_prefs'], files: ['fly-iv'], router: rt, marks, steps } });
  }
}
const out = [];
for (const s of scenarios) {
  const script = enc(s.script);
  const expected = await runScript(structuredClone(s.script), mods, build);
  out.push({ name: s.name, script, expected: enc(expected) });
}
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out });
writeFileSync(join(here, 'svc_ivrecorder.json'), text);
console.log(`svc_ivrecorder.json:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
