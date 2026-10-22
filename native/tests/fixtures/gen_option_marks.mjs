// 生成 option_marks.json:engine-ts 的 optionMarks.ts(原模块现跑):几条期权腿的盘口与模型 IV——只订自己那一条流(generic "106")、
// 留一分钟、最多 24 条、换了会话 / 被拒 / 太久没盘口的摘掉重订、合约确认的三种失败、等盘口与 IV 的轮询、同时来的两次读排队。
// 场景 = 一份脚本(execsupport_world.mjs 的假会话、盘口事件、各步)+ 期望(会话上每一次调用、setInterval / clearInterval、各步结果与流的条数)。
// setInterval 换成世界里的假钟(settle 与 advance 才让它走)。C++ 一半:tests/tst_option_marks.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_option_marks.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drain, enc, loadWorld, outcome, rng, runToDone, track } from './execsupport_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const imp = (f) => import(pathToFileURL(join(engine, `dist/src/${f}.js`)).href);
const X = await imp('optionMarks');
const C = await imp('ibContracts');
const { World, tickerKey } = await loadWorld(engine);
const START = Date.parse('2026-09-28T14:00:00Z');
const r = rng(0x0b7a_11ce);

const leg = (strike, right = 'C') => ({ symbol: 'SPX', expiry: '20260928', strike, right, exchange: 'SMART', tradingClass: 'SPXW' });
const fullKey = (l) => tickerKey(C.optionContract(l.symbol, l.expiry, l.strike, l.right, l.exchange, 'USD', '100', l.tradingClass), '106');
const hot = (legs, patch = { bid: 1.0, ask: 1.2, iv: 0.15 }) => Object.fromEntries(legs.map((l) => [fullKey(l), patch]));

async function run(script) {
  const world = new World(script, tickerKey);
  const origSet = globalThis.setInterval, origClear = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => { world.rec(null, 'setInterval', [ms]); return world.every(ms, fn); };
  globalThis.clearInterval = (e) => { world.rec(null, 'clearInterval', []); world.cancel(e); };
  const streams = new X.OptionMarkStreams();
  const steps = [];
  const started = new Map();
  const reported = new Set();
  try {
    for (const step of script.steps) {
      const rec = { op: step.op };
      if (step.id !== undefined) rec.id = step.id;
      if (!world.commonStep(step)) {
        if (step.op === 'read') {
          const p = streams.read(world.session(step.session), step.legs.map((l) => ({ ...l })), step.delayedOk ?? false, step.limit ?? 0);
          const s = track(p);
          if (step.start) started.set(step.id, s);
          else { await runToDone(world, s); rec.result = outcome(s); }
        } else if (step.op === 'close') streams.close();
        else throw new Error(`不认识的步 ${step.op}`);
      }
      await drain();
      const done = [];
      for (const [id, s] of [...started.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (s.done && !reported.has(id)) { reported.add(id); done.push({ id, result: outcome(s) }); }
      }
      if (done.length) rec.done = done;
      rec.size = streams.size;
      rec.T = world.T;
      steps.push(rec);
    }
    return { log: [...world.log], steps };
  } finally {
    globalThis.setInterval = origSet;
    globalThis.clearInterval = origClear;
    streams.close();
    world.restore();
  }
}

const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, events: [], ...script } });
const sess = (name = 'A', initial = {}, extra = {}) => ({ name, connected: true, accounts: ['DU7654321'], times: true, initial, ...extra });
const rd = (legs, extra = {}) => ({ op: 'read', session: 'A', legs, ...extra });
const FLY = [leg(7725), leg(7750), leg(7775)];

add('订的是自己的流:带 generic 订;读到盘口与模型 IV;合约先确认过', { sessions: [sess('A', hot(FLY))], steps: [rd(FLY)] });
add('热的时候再读:不重订、不再确认合约、读到的是最新的 tick', {
  sessions: [sess('A', hot(FLY))],
  steps: [rd(FLY), { op: 'patch', session: 'A', key: fullKey(FLY[1]), patch: { bid: 2.5, ask: 2.7, iv: 0.2 } }, rd(FLY), rd(FLY)],
});
add('一直有人读就一直留着;一分钟没人读才撤', {
  sessions: [sess('A', hot(FLY))],
  steps: [rd(FLY), { op: 'advance', ms: 30000 }, rd(FLY), { op: 'advance', ms: 30000 }, rd(FLY), { op: 'advance', ms: 59999 }, { op: 'advance', ms: 1 }, { op: 'advance', ms: 30000 }, { op: 'advance', ms: 30000 }],
});
add('换了一只蝶:共用的那条腿接着用,新腿才订;旧腿过了一分钟撤掉', {
  sessions: [sess('A', hot([...FLY, leg(7800)]))],
  steps: [rd(FLY), rd([leg(7750), leg(7775), leg(7800)]), { op: 'advance', ms: 59000 }, rd([leg(7750), leg(7775), leg(7800)]), { op: 'advance', ms: 60000 }],
});
{
  const many = Array.from({ length: 9 }, (_, i) => [leg(8000 + i * 25), leg(8000 + i * 25 + 5, 'P'), leg(8000 + i * 25 + 10)]);
  add('行情线路有配额:留着的流超过上限,从最久没读的撤起', {
    sessions: [sess('A', hot(many.flat()))],
    steps: [...many.flatMap((g) => [rd(g), { op: 'advance', ms: 1000 }]), rd(many[0]), rd(many[8])],
  });
}
add('重连换了会话:旧会话上的流摘掉,在新会话上重订', {
  sessions: [sess('A', hot(FLY)), sess('B', hot(FLY))],
  steps: [rd(FLY), { op: 'read', session: 'B', legs: FLY }, { op: 'read', session: 'A', legs: FLY }],
});
add('没有盘口、没有 IV 的腿给 null,不编;买价恰好为 0 照实给 0;负价与 NaN 给 null', {
  sessions: [sess('A', { [fullKey(leg(1))]: {}, [fullKey(leg(2))]: { bid: 0, ask: 0.05 }, [fullKey(leg(3))]: { bid: 0.1, ask: 0.2 }, [fullKey(leg(4))]: { bid: -1, ask: 1, iv: -0.2 }, [fullKey(leg(5))]: { bid: 0.5, ask: 0, iv: 0 }, [fullKey(leg(6))]: { bid: NaN, ask: NaN, iv: NaN } })],
  steps: [rd([leg(1)]), rd([leg(2), leg(3)]), rd([leg(4)]), rd([leg(5)]), rd([leg(6)])],
});
add('订阅被 TWS 拒了:原文带出去;下一次读把那条摘掉重订', {
  sessions: [sess('A', { [fullKey(leg(1))]: { error: '10197 competing live session' } })],
  steps: [rd([leg(1)]), rd([leg(1)]), { op: 'advance', ms: 1000 }, rd([leg(1)])],
});
add('流在订上之后才被拒:读到 error;下一次读摘掉重订', {
  sessions: [sess('A', hot(FLY))],
  steps: [rd(FLY), { op: 'patch', session: 'A', key: fullKey(FLY[0]), patch: { error: '354 no subscription' } }, rd(FLY), rd(FLY)],
});
add('error 是空串:不算被拒', {
  sessions: [sess('A', hot(FLY))],
  steps: [rd(FLY), { op: 'patch', session: 'A', key: fullKey(FLY[0]), patch: { error: '' } }, rd(FLY)],
});
add('合约确认不了:说是哪一张;一条流都不订;缓存的 conId 不再问', {
  sessions: [sess('A', hot(FLY), {}), ], qualify: undefined,
  steps: [rd(FLY)],
});
scenarios[scenarios.length - 1].script.sessions[0].qualify = [{ kind: 'ok', conIds: [900001, 0, 900003] }, { kind: 'ok', conIds: [0] }, { kind: 'ok', conIds: [900002] }];
scenarios[scenarios.length - 1].script.steps = [rd(FLY), rd(FLY), rd(FLY)];
add('TWS 不回应合约确认:说清楚是连接的事;刚超时过当场报;任何错都按没回应报;一次读失败不堵住下一次', {
  sessions: [sess('A', hot(FLY), { qualify: [{ kind: 'timeout' }, { kind: 'error', message: '连接断了' }, { kind: 'timeoutName' }, { kind: 'ok' }] })],
  steps: [rd(FLY), rd(FLY), { op: 'advance', ms: 30000 }, rd(FLY), { op: 'advance', ms: 30000 }, rd(FLY), { op: 'advance', ms: 30000 }, rd(FLY), rd(FLY)],
});
add('盘口和 IV 都在:几乎不等', { sessions: [sess('A', hot(FLY))], steps: [rd(FLY)] });
add('盘口先到、IV 晚一拍:等到 IV 来', {
  sessions: [sess('A', {})],
  events: FLY.flatMap((l, i) => [{ at: 400 + i * 10, session: 'A', key: fullKey(l), patch: { bid: 1, ask: 1.2 } }, { at: 1000 + i * 10, session: 'A', key: fullKey(l), patch: { iv: 0.2 } }]),
  steps: [rd(FLY), { op: 'advance', ms: 5000 }],
});
add('IV 一直不来(休市):盘口齐了之后最多再等一秒半', {
  sessions: [sess('A', hot(FLY, { bid: 1, ask: 1.2 }))], steps: [rd(FLY)],
});
add('盘口一直不来:等满四秒', { sessions: [sess('A', {})], steps: [rd(FLY)] });
add('盘口来得很晚(3.9 秒)', {
  sessions: [sess('A', {})], events: FLY.map((l) => ({ at: 3900, session: 'A', key: fullKey(l), patch: { bid: 1, ask: 1.2, iv: 0.1 } })), steps: [rd(FLY)],
});
add('纸面会话:新订的时候切到类型 3,订完切回去;流是热的时候不切;实盘绝不切', {
  sessions: [sess('A', hot(FLY))],
  steps: [rd(FLY, { delayedOk: true }), rd(FLY, { delayedOk: true }), { op: 'advance', ms: 120000 }, rd(FLY, { delayedOk: true }), { op: 'advance', ms: 120000 }, rd(FLY, { delayedOk: false })],
});
add('delayedOk 的读完切回类型 1', {
  sessions: [sess('A', hot(FLY))],
  steps: [rd(FLY, { delayedOk: true })],
});
add('两次读同时来:一前一后跑,流只订一遍', {
  sessions: [sess('A', hot(FLY), { qualify: [{ kind: 'ok', delay: 2000 }] })],
  steps: [rd(FLY, { start: true, id: 'a' }), rd(FLY, { start: true, id: 'b' }), { op: 'advance', ms: 1000 }, { op: 'advance', ms: 1500 }, { op: 'advance', ms: 3000 }, rd(FLY)],
});
add('第一次读失败:第二次照样跑', {
  sessions: [sess('A', hot(FLY), { qualify: [{ kind: 'timeout', delay: 500 }, { kind: 'ok' }] })],
  steps: [rd(FLY, { start: true, id: 'a' }), rd(FLY, { start: true, id: 'b' }), { op: 'advance', ms: 600 }, { op: 'advance', ms: 5000 }],
});
add('太久没盘口:连着却过了时限没盘口,下次读撤掉自己那条重订;不给时限不判;断着的时候不判', {
  sessions: [sess('A', hot(FLY, { bid: 1, ask: 1.2, iv: 0.15 }))],
  steps: [
    rd(FLY, { limit: 30000 }), { op: 'advance', ms: 29000 }, rd(FLY, { limit: 30000 }), { op: 'advance', ms: 31000 }, rd(FLY),
    { op: 'advance', ms: 31000 }, { op: 'connected', session: 'A', v: false }, rd(FLY, { limit: 30000 }), { op: 'connected', session: 'A', v: true },
    { op: 'patch', session: 'A', key: fullKey(FLY[0]), patch: { quotedAt: START + 200000 } }, rd(FLY, { limit: 30000 }),
  ],
});
add('会话断了:清扫把它的流撤掉', {
  sessions: [sess('A', hot(FLY))],
  steps: [rd(FLY), { op: 'connected', session: 'A', v: false }, { op: 'advance', ms: 30000 }, { op: 'advance', ms: 30000 }],
});
add('close:撤掉所有还留着的流、停掉清扫;撤抛了也不影响', {
  sessions: [sess('A', hot(FLY), { throwCancel: true })],
  steps: [rd(FLY), { op: 'close' }, { op: 'advance', ms: 100000 }, rd(FLY), { op: 'close' }, { op: 'close' }],
});
add('同一条腿在一次读里出现两次', {
  sessions: [sess('A', hot([leg(7725)]))], steps: [rd([leg(7725), leg(7725), leg(7750)])],
});
add('Infinity 的盘口 / IV 不算价', {
  sessions: [sess('A', { [fullKey(leg(1))]: { bid: Infinity, ask: Infinity, iv: Infinity }, [fullKey(leg(2))]: { bid: 1, ask: Infinity, iv: 0.1 } })], steps: [rd([leg(1), leg(2)])],
});
add('同一行权价的看涨 / 看跌 / 不同交易类各是各的流', {
  sessions: [sess('A', hot([leg(7725), leg(7725, 'P'), { ...leg(7725), tradingClass: 'SPX' }]))],
  steps: [rd([leg(7725), leg(7725, 'P'), { ...leg(7725), tradingClass: 'SPX' }]), rd([leg(7725, 'P')])],
});
add('一次读 26 条腿:都在 keep 里,清扫挑不出可撤的', {
  sessions: [sess('A', hot(Array.from({ length: 26 }, (_, i) => leg(9000 + i))))],
  steps: [rd(Array.from({ length: 26 }, (_, i) => leg(9000 + i))), { op: 'advance', ms: 31000 }, rd([leg(9000)]), rd(Array.from({ length: 26 }, (_, i) => leg(9000 + i)))],
});
add('合约确认后 conId 没写上(undefined):按确认不了报', {
  sessions: [sess('A', hot(FLY), { qualify: [{ kind: 'ok', conIds: [null, 900002, 900003] }, { kind: 'ok' }] })], steps: [rd(FLY), rd(FLY)],
});
add('沉默恰好等于时限:撤掉重订', {
  sessions: [sess('A', hot(FLY, { bid: 1, ask: 1.2, iv: 0.15 }))],
  steps: [rd(FLY, { limit: 30000 }), { op: 'advance', ms: 29950 }, rd(FLY, { limit: 30000 }), { op: 'advance', ms: 29949 }, rd(FLY, { limit: 30000 })],
});
for (const [label, x] of [['少 1 毫秒', 59999], ['恰好', 60000], ['多 1 毫秒', 60001]]) {
  add(`留一分钟的边界:${label}`, {
    sessions: [sess('A', hot([...FLY, leg(7800)]))],
    steps: [rd(FLY), { op: 'advance', ms: x }, rd([leg(7800)])],
  });
}
{
  const g = (base) => [leg(base), leg(base + 5, 'P'), leg(base + 10)];
  const groups = [g(8000), g(8100), g(8200), g(8300)];
  add('流条数上限边界:24 条不撤,第 25 条撤最久没读的', {
    sessions: [sess('A', hot(groups.flat()))],
    steps: [rd([...groups[0], ...groups[1]].slice(0, 5)), rd(groups[0]), { op: 'advance', ms: 1000 },
      ...Array.from({ length: 8 }, (_, i) => rd(Array.from({ length: 3 }, (_, k) => leg(9500 + i * 10 + k)))), { op: 'advance', ms: 1000 }, rd([leg(9700)]), rd([leg(9710)])],
  });
}
for (const t of [3750, 3800, 3801, 4050, 4051]) {
  add(`等盘口的边界:盘口在第 ${t} 毫秒到`, {
    sessions: [sess('A', {})], events: FLY.map((l) => ({ at: t, session: 'A', key: fullKey(l), patch: { bid: 1, ask: 1.2, iv: 0.1 } })), steps: [rd(FLY)],
  });
}
for (const t of [1049, 1050, 1051, 1299, 1300, 1301, 1549, 1550, 1551, 1799, 1800, 1801, 2049, 2050]) {
  add(`等 IV 的边界:盘口在 50 毫秒到,IV 在第 ${t} 毫秒到`, {
    sessions: [sess('A', {})],
    events: FLY.flatMap((l) => [{ at: 10, session: 'A', key: fullKey(l), patch: { bid: 1, ask: 1.2 } }, { at: t, session: 'A', key: fullKey(l), patch: { iv: 0.2 } }]),
    steps: [rd(FLY)],
  });
}
add('沉默时限边界再补一条:多 1 毫秒', {
  sessions: [sess('A', hot(FLY, { bid: 1, ask: 1.2, iv: 0.15 }))],
  steps: [rd(FLY, { limit: 30000 }), { op: 'advance', ms: 29951 }, rd(FLY, { limit: 30000 })],
});
add('清扫掉了正在读的流:Cannot read properties of undefined (reading handle)(TS 原样)', {
  sessions: [sess('A', hot(FLY))],
  steps: [rd(FLY), { op: 'patch', session: 'A', key: fullKey(FLY[0]), patch: { bid: NaN, ask: NaN } }, { op: 'patch', session: 'A', key: fullKey(FLY[1]), patch: { bid: NaN, ask: NaN } },
    { op: 'patch', session: 'A', key: fullKey(FLY[2]), patch: { bid: NaN, ask: NaN } }, { op: 'advance', ms: 89000 }, rd(FLY), rd(FLY)],
});
add('空腿列表', { sessions: [sess('A', {})], steps: [rd([]), rd([])] });

// ---- 随机序列
{
  const pool = Array.from({ length: 8 }, (_, i) => leg(7700 + i * 25, i % 2 ? 'P' : 'C'));
  for (let n = 0; n < 60; n += 1) {
    const sessions = ['A', 'B'].map((nm) => sess(nm, Object.fromEntries(pool.filter(() => r.chance(0.7)).map((l) => [fullKey(l), r.pick([
      { bid: 1, ask: 1.2, iv: 0.15 }, { bid: 1, ask: 1.2 }, { bid: 0, ask: 0.05 }, {}, { error: '10197 x' }, { bid: 0.5, ask: 0.6, iv: 0.3, quotedAt: START }])])),
    {
      throwCancel: r.chance(0.06),
      qualify: [...Array.from({ length: r.int(3) }, () => r.pick([{ kind: 'ok', conIds: [900001, 0] }, { kind: 'timeout' }, { kind: 'error', message: 'x' }, { kind: 'ok' }])), { kind: 'ok' }],
    }));
    const events = [];
    for (let i = 0; i < 10; i += 1) {
      const l = r.pick(pool);
      for (const sn of ['A', 'B']) {
        if (r.chance(0.4)) events.push({ at: r.int(400000), session: sn, key: fullKey(l), patch: r.chance(0.1) ? { error: '354 x' } : r.pick([{ bid: 1, ask: 1.1 }, { iv: 0.2 }, { quotedAt: START + r.int(400000) }, { bid: 2, ask: 2.2, iv: 0.25 }]) });
      }
    }
    events.sort((x, y) => x.at - y.at);
    const steps = [];
    for (let i = 0; i < 18; i += 1) {
      const p = r.next();
      if (p < 0.5) steps.push({ op: 'read', session: r.pick(['A', 'A', 'B']), legs: pool.filter(() => r.chance(0.3)).slice(0, 5), delayedOk: r.chance(0.3), limit: r.pick([0, 0, 30000, 120000]) });
      else if (p < 0.8) steps.push({ op: 'advance', ms: r.pick([500, 1000, 10000, 29999, 30000, 31000, 59999, 60000, 61000, 90000]) });
      else if (p < 0.9) steps.push({ op: 'connected', session: r.pick(['A', 'B']), v: r.chance(0.4) });
      else if (p < 0.95) steps.push({ op: 'patch', session: r.pick(['A', 'B']), key: fullKey(r.pick(pool)), patch: r.pick([{ error: '10197 y' }, { bid: 3, ask: 3.1, iv: 0.4, quotedAt: START + 250000 }]) });
      else steps.push({ op: 'close' });
    }
    add(`随机 ${n}`, { sessions, events, steps });
  }
}

const out = scenarios.map((s) => ({ name: s.name, script: enc(s.script), expected: enc(null) }));
for (let i = 0; i < scenarios.length; i += 1) out[i].expected = enc(await run(scenarios[i].script));
const text = JSON.stringify({ scenarios: out });
writeFileSync(join(here, 'option_marks.json'), text);
console.log(`option_marks.json:${scenarios.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
