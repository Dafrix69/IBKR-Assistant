// 生成 qualify_gate.json:engine-ts 的 qualifyGate.ts(原模块现跑)对着脚本驱动的假会话(execsupport_world.mjs)。
// 每个场景 = 一份脚本(会话怎么答、各步做什么)+ 期望(会话上每一次调用的日志、各步的结果、计数)。C++ 一半:tests/tst_qualify_gate.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_qualify_gate.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drain, enc, loadWorld, norm, outcome, rng, runToDone, track } from './execsupport_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const X = await import(pathToFileURL(join(engine, 'dist/src/qualifyGate.js')).href);
const { World, tickerKey } = await loadWorld(engine);

const START = Date.parse('2026-10-12T09:40:00-04:00');
const stock = (symbol) => ({ secType: 'STK', symbol, exchange: 'SMART', currency: 'USD' });

async function run(script) {
  const world = new World(script, tickerKey);
  X.takeQualifyGateStats();
  const steps = [];
  const started = new Map();
  const reported = new Set();
  try {
    for (const step of script.steps) {
      const rec = { op: step.op };
      if (step.id !== undefined) rec.id = step.id;
      if (!world.commonStep(step)) {
        if (step.op === 'gate') {
          const contracts = step.contracts.map((c) => ({ ...c }));
          const now = step.now === undefined ? undefined : () => step.now;
          const p = X.qualifyGated(world.session(step.session), contracts, step.timeout, step.wait, now);
          const s = track(p);
          if (step.start) started.set(step.id, s);
          else { await runToDone(world, s); rec.result = outcome(s); }
          rec.contracts = contracts.map(norm);
        } else if (step.op === 'take') rec.stats = X.takeQualifyGateStats();
        else throw new Error(`不认识的步 ${step.op}`);
      }
      await drain();
      const done = [];
      for (const [id, s] of [...started.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (s.done && !reported.has(id)) { reported.add(id); done.push({ id, result: outcome(s) }); }
      }
      if (done.length) rec.done = done;
      rec.T = world.T;
      steps.push(rec);
    }
    return { log: world.log, steps, stats: X.takeQualifyGateStats() };
  } finally {
    world.restore();
  }
}

const ok = { kind: 'ok' };
const TIMEOUT = 12000;
const gate = (session, symbols, wait = false, extra = {}) => ({ op: 'gate', session, contracts: symbols.map(stock), timeout: TIMEOUT, wait, ...extra });
const sess = (name, qualify) => ({ name, connected: true, accounts: ['DU1'], qualify });

const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, events: [], ...script } });

// ---- 对着 tests/qualify-gate.spec.ts 的几条
add('两秒一次读了半分钟:只发出去一次确认,其余当场答', {
  sessions: [sess('A', [{ kind: 'timeout' }, ok])],
  steps: [gate('A', ['SPY']), ...Array.from({ length: 14 }, () => [gate('A', ['SPY']), { op: 'advance', ms: 2000 }]).flat(), { op: 'take' }],
});
add('到了间隔只放一路去试探;试探还没回,同时进来的当场答', {
  sessions: [sess('A', [{ kind: 'timeout' }, { kind: 'timeout', delay: 12000 }])],
  steps: [gate('A', ['SPY']), { op: 'advance', ms: 30000 }, gate('A', ['QQQ'], false, { start: true, id: 'probe' }), gate('A', ['IWM']), { op: 'advance', ms: 12000 }, { op: 'take' }],
});
add('TWS 好了:到了间隔那一次试探就确认得了,之后读的照常', {
  sessions: [sess('A', [{ kind: 'timeout' }, ok])],
  steps: [gate('A', ['SPY']), gate('A', ['SPY']), { op: 'advance', ms: 30000 }, gate('A', ['SPY']), gate('A', ['QQQ']), { op: 'take' }],
});
add('刚超时过,下单的确认照样去问;问回来了,读的那几路不用等满间隔', {
  sessions: [sess('A', [{ kind: 'timeout' }, ok, ok])],
  steps: [gate('A', ['SPY']), gate('A', ['AAPL'], true), gate('A', ['SPY']), { op: 'take' }],
});
add('TWS 还卡着:下单照样等满一个超时', {
  sessions: [sess('A', [{ kind: 'timeout' }, { kind: 'timeout', delay: 12000 }])],
  steps: [gate('A', ['SPY']), gate('A', ['AAPL'], true, { start: true, id: 'order' }), { op: 'advance', ms: 11000 }, { op: 'advance', ms: 1000 }, gate('A', ['SPY']), { op: 'take' }],
});
add('qualifyGated:只有超时才记;报错也算回了话(显式的 now)', {
  sessions: [sess('A', [{ kind: 'timeoutName' }, { kind: 'error', message: '连接断了' }, ok])],
  steps: [
    gate('A', [], false, { now: 0 }), gate('A', [], false, { now: 0 }),
    gate('A', [], false, { now: 30000 }), gate('A', [], false, { now: 30000 }), { op: 'take' }, { op: 'take' },
  ],
});
add('话里带 timeout(大小写不论)算超时;别的话不算', {
  sessions: [sess('A', [{ kind: 'error', message: 'Qualify TIMEOUT after 12s' }, { kind: 'error', message: 'timed out' }, { kind: 'error', message: 'Timeout' }, ok])],
  steps: [gate('A', ['A']), gate('A', ['B'], true), gate('A', ['C'], true), gate('A', ['D'], true), gate('A', ['E']), { op: 'take' }],
});
add('两条会话各记各的', {
  sessions: [sess('A', [{ kind: 'timeout' }, ok]), sess('B', [ok, { kind: 'timeout' }, ok])],
  steps: [gate('A', ['X']), gate('B', ['X']), gate('A', ['X']), gate('B', ['X']), gate('B', ['X']), { op: 'advance', ms: 29999 }, gate('A', ['X']), { op: 'advance', ms: 1 }, gate('A', ['X']), gate('B', ['X']), { op: 'take' }],
});
add('时刻恰好等于间隔:不再当场答(< 而不是 ≤)', {
  sessions: [sess('A', [{ kind: 'timeout' }, ok])],
  steps: [gate('A', ['X']), { op: 'advance', ms: 29999 }, gate('A', ['X']), { op: 'advance', ms: 1 }, gate('A', ['X']), { op: 'take' }],
});
add('试探又超时:间隔从试探那一刻重新算', {
  sessions: [sess('A', [{ kind: 'timeout' }, { kind: 'timeout', delay: 5000 }, ok])],
  steps: [gate('A', ['X']), { op: 'advance', ms: 30000 }, gate('A', ['X'], false, { start: true, id: 'p' }), { op: 'advance', ms: 5000 }, gate('A', ['X']), { op: 'advance', ms: 24999 }, gate('A', ['X']), { op: 'advance', ms: 1 }, gate('A', ['X']), { op: 'take' }],
});

for (const [label, ms] of [['少 1 毫秒', 29999], ['恰好', 30000], ['多 1 毫秒', 30001]]) {
  add(`间隔边界:${label}`, {
    sessions: [sess('A', [{ kind: 'timeout' }, ok])],
    steps: [gate('A', ['X']), { op: 'advance', ms }, gate('A', ['X']), { op: 'take' }],
  });
}
// ---- 随机序列(固定种子):两条会话、随机的回答与步
{
  const r = rng(0x9a7e_c0de);
  const kinds = [
    () => ({ kind: 'ok' }), () => ({ kind: 'ok', conIds: [0] }), () => ({ kind: 'timeout' }), () => ({ kind: 'timeoutName' }),
    () => ({ kind: 'error', message: r.pick(['连接断了', 'Timeout waiting', 'boom', 'TIMEOUT', 'time out']) }),
  ];
  for (let n = 0; n < 90; n += 1) {
    const mk = () => Array.from({ length: 1 + r.int(7) }, () => {
      const o = r.pick(kinds)();
      if (r.chance(0.25)) o.delay = r.pick([1, 500, 5000, 12000, 31000]);
      return o;
    });
    const steps = [];
    let id = 0;
    for (let i = 0; i < 6 + r.int(14); i += 1) {
      const pickStep = r.next();
      if (pickStep < 0.55) {
        steps.push(gate(r.pick(['A', 'B']), Array.from({ length: r.int(3) }, () => r.pick(['SPY', 'QQQ', 'IWM'])), r.chance(0.2),
          r.chance(0.3) ? { start: true, id: `g${id++}` } : (r.chance(0.15) ? { now: r.pick([0, 29999, 30000, 60000]) } : {})));
      } else if (pickStep < 0.9) steps.push({ op: 'advance', ms: r.pick([1, 999, 2000, 12000, 29999, 30000, 30001, 45000, 61000]) });
      else steps.push({ op: 'take' });
    }
    add(`随机 ${n}`, { sessions: [sess('A', mk()), sess('B', mk())], steps });
  }
}

const out = scenarios.map((s) => ({ name: s.name, script: enc(s.script), expected: enc(null) }));
for (let i = 0; i < scenarios.length; i += 1) out[i].expected = enc(await run(scenarios[i].script));
const text = JSON.stringify({ scenarios: out });
writeFileSync(join(here, 'qualify_gate.json'), text);
console.log(`qualify_gate.json:${scenarios.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
