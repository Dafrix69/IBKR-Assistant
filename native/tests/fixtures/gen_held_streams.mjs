// 生成 held_streams.json:engine-ts 的 heldStreams.ts(原模块现跑):持仓常驻行情订阅的账——还能不能用、订上并记下、确认不了的不反复试、平掉的撤掉。
// 场景 = 一份脚本(execsupport_world.mjs 的假会话、盘口事件、各步)+ 期望(会话上每一次调用与日志行、各步结果、每步之后账里的样子)。
// 钱路径:哪些流被当作活的,决定盯盘信任哪份数据;阈值(30 秒 / 120 秒 / 30 秒)由场景里的钟推过去。C++ 一半:tests/tst_held_streams.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_held_streams.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drain, enc, loadWorld, norm, outcome, rng, runToDone, track } from './execsupport_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const X = await import(pathToFileURL(join(engine, 'dist/src/heldStreams.js')).href);
const { World, tickerKey } = await loadWorld(engine);
const START = Date.parse('2026-10-12T09:40:00-04:00');
const r = rng(0x4e1d_57ea);

const opt = (strike, right = 'C', tradingClass = 'SPXW') => ({ secType: 'OPT', symbol: 'SPX', exchange: 'SMART', currency: 'USD', lastTradeDateOrContractMonth: '20261012', strike, right, multiplier: '100', tradingClass });
const stk = (symbol) => ({ secType: 'STK', symbol, exchange: 'SMART', currency: 'USD' });
const keyOf = (c) => `${c.symbol}|${c.strike ?? ''}|${c.right ?? ''}`;

async function run(script) {
  const world = new World(script, tickerKey);
  const held = new Map();
  for (const [name, variant] of Object.entries(script.held ?? { main: null })) held.set(name, new X.HeldStreams(variant === null ? undefined : variant));
  const handles = new Map();
  const qlist = script.qualifies ?? [{ v: true }];
  let qIdx = 0;
  const steps = [];
  const started = new Map();
  const reported = new Set();
  const snap = (h) => ({
    keys: [...h.keys()],
    entries: [...h.entries()].map(([k, e]) => [k, { handle: e.handle ? e.handle.id : null, contract: e.contract ? norm(e.contract) : null, session: e.session ? e.session.name : null }]),
  });
  try {
    for (const step of script.steps) {
      const rec = { op: step.op };
      if (step.id !== undefined) rec.id = step.id;
      if (!world.commonStep(step)) {
        const hs = held.get(step.hs ?? 'main');
        const session = step.session ? world.session(step.session) : undefined;
        if (step.op === 'usable') {
          rec.result = step.now === undefined ? hs.usable(session, step.key, step.limit ?? 0) : hs.usable(session, step.key, step.limit ?? 0, step.now);
        } else if (step.op === 'subscribe') hs.subscribe(session, step.key, { ...step.contract });
        else if (step.op === 'ensure') {
          const p = hs.ensure(
            session, step.key,
            () => { world.rec(null, 'target', [step.key]); return { ...step.contract }; },
            async (contract) => {
              const o = qlist[Math.min(qIdx, qlist.length - 1)];
              const idx = qIdx;
              qIdx += 1;
              world.rec(null, 'qualifies', [norm(contract)]);
              if (o.delay) await world.sleep(o.delay);
              if (o.throw) throw new Error(o.throw);
              if (o.v === true) contract.conId = 880000 + idx;
              return o.v;
            },
            step.limit ?? 0,
          );
          const s = track(p);
          if (step.start) started.set(step.id, s);
          else { await runToDone(world, s); rec.result = outcome(s); }
        } else if (step.op === 'sub') handles.set(step.as, session.subscribeTicker({ ...step.contract }, step.generic));
        else if (step.op === 'setRaw') {
          hs.set(step.key, { handle: step.handle ? handles.get(step.handle) : null, contract: step.contract ? { ...step.contract } : null, session: step.session ? world.session(step.session) : undefined });
        } else if (step.op === 'delete') hs.delete(step.key);
        else if (step.op === 'clear') hs.clear();
        else if (step.op === 'size') rec.result = hs.size;
        else if (step.op === 'release') {
          const shared = step.shared ?? {};
          rec.result = hs.release(step.keep, (k) => (shared[k] ?? []).map((name) => (name === null ? null : handles.get(name))));
        } else throw new Error(`不认识的步 ${step.op}`);
      }
      await drain();
      const done = [];
      for (const [id, s] of [...started.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (s.done && !reported.has(id)) { reported.add(id); done.push({ id, result: outcome(s) }); }
      }
      if (done.length) rec.done = done;
      const state = {};
      for (const [name, h] of [...held.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) state[name] = snap(h);
      rec.state = state;
      rec.T = world.T;
      steps.push(rec);
    }
    return { log: world.log, steps };
  } finally {
    world.restore();
  }
}

const scenarios = [];
const add = (name, script) => scenarios.push({ name, script: { start: START, events: [], ...script } });
const sess = (name = 'A', extra = {}) => ({ name, connected: true, accounts: ['U1'], times: true, ...extra });
const k = (c) => tickerKey(c);
const ens = (key, contract, extra = {}) => ({ op: 'ensure', session: 'A', key, contract, ...extra });

add('订上、留着:第二次读不重订、不再确认合约、target 不再拼', {
  sessions: [sess()],
  steps: [ens('c7725', opt(7725)), ens('c7725', opt(7725)), ens('c7750', opt(7750)), { op: 'usable', session: 'A', key: 'c7725' }, { op: 'usable', session: 'A', key: 'nope' }, { op: 'size' }],
});
add('确认不了的合约(handle 为空)算有,不反复试', {
  sessions: [sess()], qualifies: [{ v: false }, { v: true }],
  steps: [ens('x', opt(1)), ens('x', opt(1)), { op: 'usable', session: 'A', key: 'x' }, ens('y', opt(2))],
});
add('TWS 没响应:不记账、日志只写一次;间隔内不去撞;到了间隔试探;恢复时写一行', {
  sessions: [sess()], qualifies: [{ v: 'stalled' }, { v: 'stalled' }, { v: true }, { v: true }],
  steps: [ens('a', opt(1)), ens('b', opt(2)), { op: 'advance', ms: 29999 }, ens('a', opt(1)), { op: 'advance', ms: 1 }, ens('a', opt(1)), ens('b', opt(2)),
    { op: 'advance', ms: 30001 }, ens('b', opt(2)), ens('c', opt(3))],
});
add('试探还没出结果时另一路进来不排队;试探又 stalled 不再写日志', {
  sessions: [sess()], qualifies: [{ v: 'stalled' }, { v: 'stalled', delay: 5000 }, { v: true }],
  steps: [ens('a', opt(1)), { op: 'advance', ms: 30000 }, ens('a', opt(1), { start: true, id: 'p' }), ens('b', opt(2)), { op: 'advance', ms: 5000 }, ens('a', opt(1)), { op: 'advance', ms: 30000 }, ens('a', opt(1)), ens('b', opt(2))],
});
add('合约确认抛错:照抛、不改账、不改间隔', {
  sessions: [sess()], qualifies: [{ throw: '连接断了' }, { v: true }],
  steps: [ens('a', opt(1)), ens('a', opt(1)), { op: 'size' }],
});
add('两本账(期权腿 / 正股)共用同一个会话的间隔;两条会话各记各的', {
  sessions: [sess('A'), sess('B')], held: { opt: null, stock: '' }, qualifies: [{ v: 'stalled' }, { v: true }, { v: true }, { v: true }],
  steps: [
    { op: 'ensure', hs: 'opt', session: 'A', key: 'o1', contract: opt(1) }, { op: 'ensure', hs: 'stock', session: 'A', key: 's1', contract: stk('BE') },
    { op: 'ensure', hs: 'stock', session: 'B', key: 's1', contract: stk('BE') }, { op: 'advance', ms: 30000 },
    { op: 'ensure', hs: 'stock', session: 'A', key: 's1', contract: stk('BE') }, { op: 'ensure', hs: 'opt', session: 'A', key: 'o1', contract: opt(1) },
  ],
});

// ---- 流死了:error / 太久没盘口
const silent = (variant, status) => ({
  sessions: [sess()], held: { main: variant },
  steps: [
    ens('c1', opt(7725)), { op: 'advance', ms: 29999 }, { op: 'usable', session: 'A', key: 'c1', limit: 30000 },
    { op: 'advance', ms: 1 }, { op: 'usable', session: 'A', key: 'c1', limit: 30000 }, ens('c1', opt(7725), { limit: 30000 }),
    { op: 'advance', ms: 31000 }, { op: 'usable', session: 'A', key: 'c1', limit: 30000 }, ens('c1', opt(7725), { limit: 30000 }),
    { op: 'patch', session: 'A', key: k(opt(7725)), patch: { quotedAt: START + 70000, bid: 1, ask: 1.2 } }, { op: 'usable', session: 'A', key: 'c1', limit: 30000 },
    { op: 'advance', ms: 40000 }, { op: 'usable', session: 'A', key: 'c1', limit: 30000 },
  ],
});
add('太久没盘口(期权腿,不指定 variant:撤掉这张合约的所有变体)', silent(null));
add('太久没盘口(正股,variant "":只撤不带 generic 的)', silent(''));
add('太久没盘口(variant "106")', silent('106'));
add('读到 error:被 TWS 拒了,按 variant 撤', {
  sessions: [sess()], held: { a: null, b: '', c: '106' },
  steps: [
    { op: 'ensure', hs: 'a', session: 'A', key: 'k', contract: opt(1) }, { op: 'patch', session: 'A', key: k(opt(1)), patch: { error: '10197 competing' } }, { op: 'usable', hs: 'a', session: 'A', key: 'k' },
    { op: 'ensure', hs: 'b', session: 'A', key: 'k', contract: opt(1) }, { op: 'patch', session: 'A', key: k(opt(1)), patch: { error: '354 no sub' } }, { op: 'usable', hs: 'b', session: 'A', key: 'k' },
    { op: 'ensure', hs: 'c', session: 'A', key: 'k', contract: opt(1) }, { op: 'patch', session: 'A', key: k(opt(1)), patch: { error: '101' } }, { op: 'usable', hs: 'c', session: 'A', key: 'k' },
  ],
});
add('error 是空串:不算有错', {
  sessions: [sess()],
  steps: [ens('k', opt(1)), { op: 'patch', session: 'A', key: k(opt(1)), patch: { error: '' } }, { op: 'usable', session: 'A', key: 'k', limit: 30000 }, { op: 'advance', ms: 31000 }, { op: 'usable', session: 'A', key: 'k', limit: 30000 }],
});
add('会话断着时不判太久没盘口', {
  sessions: [sess()],
  steps: [ens('k', opt(1)), { op: 'advance', ms: 100000 }, { op: 'connected', session: 'A', v: false }, { op: 'usable', session: 'A', key: 'k', limit: 30000 }, { op: 'connected', session: 'A', v: true }, { op: 'usable', session: 'A', key: 'k', limit: 30000 }],
});
add('会话不报时刻(替身):不判它死', {
  sessions: [sess('A', { times: false })],
  steps: [ens('k', opt(1)), { op: 'advance', ms: 100000 }, { op: 'usable', session: 'A', key: 'k', limit: 30000 }, { op: 'patch', session: 'A', key: k(opt(1)), patch: { quotedAt: START } }, { op: 'usable', session: 'A', key: 'k', limit: 30000 }],
});
add('显式的 now', {
  sessions: [sess()],
  steps: [ens('k', opt(1)), { op: 'usable', session: 'A', key: 'k', limit: 30000, now: START + 29999 }, { op: 'usable', session: 'A', key: 'k', limit: 30000, now: START + 30000 }, ens('k', opt(1))],
});
add('日志:一段没盘口只在头一次写一行,盘口回来再写一行;秒数四舍五入', {
  sessions: [sess()],
  steps: [
    ens('k', opt(1)), { op: 'advance', ms: 30499 }, { op: 'usable', session: 'A', key: 'k', limit: 30000 },
    ens('k', opt(1), { limit: 30000 }), { op: 'advance', ms: 30500 }, { op: 'usable', session: 'A', key: 'k', limit: 30000 },
    { op: 'patch', session: 'A', key: k(opt(1)), patch: { quotedAt: START + 70000 } }, { op: 'usable', session: 'A', key: 'k', limit: 30000 }, { op: 'usable', session: 'A', key: 'k', limit: 30000 },
    { op: 'patch', session: 'A', key: k(opt(1)), patch: { quotedAt: 0 } }, { op: 'usable', session: 'A', key: 'k', limit: 30000 },
  ],
});
add('撤不掉也要重订(cancelTicker 抛)', {
  sessions: [sess('A', { throwCancel: true })],
  steps: [ens('k', opt(1)), { op: 'patch', session: 'A', key: k(opt(1)), patch: { error: 'boom' } }, { op: 'usable', session: 'A', key: 'k' }, ens('k', opt(1)), { op: 'size' }],
});
add('同一条流挂在别的键上、那边是好的:不撤,让调用方接到那一条上', {
  sessions: [sess()],
  steps: [
    ens('acc1', opt(7725)), { op: 'subscribe', session: 'A', key: 'acc2', contract: opt(7725) },
    { op: 'advance', ms: 100000 }, { op: 'usable', session: 'A', key: 'acc1', limit: 30000 }, { op: 'usable', session: 'A', key: 'acc2', limit: 30000 },
    { op: 'subscribe', session: 'A', key: 'acc2', contract: opt(7725) }, { op: 'patch', session: 'A', key: k(opt(7725)), patch: { quotedAt: START + 100000 } },
    { op: 'usable', session: 'A', key: 'acc1', limit: 30000 }, { op: 'usable', session: 'A', key: 'acc2', limit: 30000 },
  ],
});
add('另一个会话上的同一张合约不算共享', {
  sessions: [sess('A'), sess('B')],
  steps: [ens('k1', opt(1)), { op: 'ensure', session: 'B', key: 'k2', contract: opt(1) }, { op: 'advance', ms: 100000 }, { op: 'usable', session: 'A', key: 'k1', limit: 30000 }, { op: 'usable', session: 'B', key: 'k2', limit: 30000 }],
});

add('流有 handle 没有合约:坏了也不撤(contract 为空就跳过)', {
  sessions: [sess()],
  steps: [{ op: 'sub', session: 'A', as: 'h', contract: opt(1) }, { op: 'setRaw', key: 'x', handle: 'h', contract: null, session: 'A' }, { op: 'patch', session: 'A', key: k(opt(1)), patch: { error: 'gone' } }, { op: 'usable', session: 'A', key: 'x' }, { op: 'size' }],
});
add('两路同时从无到有去确认、都 stalled:日志只写一次', {
  sessions: [sess()], qualifies: [{ v: 'stalled', delay: 1000 }, { v: 'stalled', delay: 2000 }],
  steps: [ens('a', opt(1), { start: true, id: 'p' }), ens('b', opt(2), { start: true, id: 'q' }), { op: 'advance', ms: 1000 }, { op: 'advance', ms: 1000 }, { op: 'advance', ms: 30000 }, ens('a', opt(1))],
});
add('release 之后计数清零:同一个键再沉默又写一行', {
  sessions: [sess()], held: { main: '' },
  steps: [ens('k', stk('BE')), { op: 'advance', ms: 31000 }, { op: 'usable', session: 'A', key: 'k', limit: 30000 }, ens('k', stk('BE')), { op: 'release', keep: [] },
    ens('k', stk('BE')), { op: 'advance', ms: 31000 }, { op: 'usable', session: 'A', key: 'k', limit: 30000 }],
});
add('秒数四舍五入:30.5 秒写 31', {
  sessions: [sess()], steps: [ens('k', opt(1)), { op: 'advance', ms: 30500 }, { op: 'usable', session: 'A', key: 'k', limit: 30000 }],
});
add('沉默记过账、盘口时刻是 0 / 空 / NaN:不写"回来了"', {
  sessions: [sess()],
  steps: [
    ens('k', opt(1)), { op: 'advance', ms: 31000 }, { op: 'usable', session: 'A', key: 'k', limit: 30000 },
    ens('k', opt(1), { limit: 30000 }), { op: 'usable', session: 'A', key: 'k', limit: 0 },
    { op: 'patch', session: 'A', key: k(opt(1)), patch: { quotedAt: 0 } }, { op: 'usable', session: 'A', key: 'k', limit: 0 },
    { op: 'patch', session: 'A', key: k(opt(1)), patch: { quotedAt: NaN } }, { op: 'usable', session: 'A', key: 'k', limit: 0 },
    { op: 'patch', session: 'A', key: k(opt(1)), patch: { quotedAt: START + 40000 } }, { op: 'usable', session: 'A', key: 'k', limit: 0 },
  ],
});
for (const limit of [30000, 120000]) {
  for (const [label, d] of [['少 1 毫秒', -1], ['恰好', 0], ['多 1 毫秒', 1]]) {
    add(`沉默时限 ${limit} 毫秒边界:${label}`, {
      sessions: [sess()],
      steps: [ens('k', opt(1)), { op: 'usable', session: 'A', key: 'k', limit, now: START + limit + d }, { op: 'size' }],
    });
  }
}
for (const [label, ms] of [['少 1 毫秒', 29999], ['恰好', 30000], ['多 1 毫秒', 30001]]) {
  add(`确认间隔 30 秒边界:${label}`, {
    sessions: [sess()], qualifies: [{ v: 'stalled' }, { v: true }],
    steps: [ens('a', opt(1)), { op: 'advance', ms }, ens('a', opt(1))],
  });
}
// ---- 平掉的撤掉
add('release:撤不在 keep 里的;只撤不带 generic 的那条', {
  sessions: [sess()], held: { main: '' },
  steps: [ens('a', stk('BE')), ens('b', stk('QQQ')), ens('c', stk('AAPL')), { op: 'release', keep: ['b'] }, { op: 'release', keep: [] }, { op: 'release', keep: ['zzz'] }],
});
add('release:别人还在用就只销账不撤流(同会话另一个键 / 别处的句柄)', {
  sessions: [sess()], held: { main: '' },
  steps: [
    ens('acc1', stk('BE')), { op: 'subscribe', session: 'A', key: 'acc2', contract: stk('BE') }, ens('x', stk('QQQ')), ens('y', stk('IWM')), ens('z', stk('SPY')),
    { op: 'sub', session: 'A', as: 'bar', contract: stk('QQQ') }, { op: 'sub', session: 'A', as: 'dead', contract: stk('IWM') },
    { op: 'patch', session: 'A', key: k(stk('IWM')), patch: { error: 'gone' } },
    { op: 'release', keep: ['acc2', 'z'], shared: { x: ['bar'], y: ['dead'] } },
    { op: 'release', keep: [], shared: { z: [null] } },
  ],
});
add('release:自己那条已经读到 error 就不撤;没有 session / 合约 / handle 的跳过;撤抛了不计数', {
  sessions: [sess(), sess('B', { throwCancel: true })], held: { main: null },
  steps: [
    ens('e', opt(1)), { op: 'patch', session: 'A', key: k(opt(1)), patch: { error: 'rejected' } },
    { op: 'sub', session: 'A', as: 'h1', contract: opt(2) },
    { op: 'setRaw', key: 'nosession', handle: 'h1', contract: opt(2), session: null }, { op: 'setRaw', key: 'nocontract', handle: 'h1', contract: null, session: 'A' },
    { op: 'setRaw', key: 'nohandle', handle: null, contract: null, session: null },
    { op: 'ensure', session: 'B', key: 'throws', contract: opt(5) }, ens('ok', opt(6)),
    { op: 'release', keep: [] },
  ],
});
add('release 之后又开回同一只蝶:重新订上', {
  sessions: [sess()], held: { main: '' },
  steps: [ens('a', stk('BE')), { op: 'release', keep: [] }, ens('a', stk('BE')), { op: 'patch', session: 'A', key: k(stk('BE')), patch: { bid: 10, ask: 10.1, quotedAt: START } }, { op: 'usable', session: 'A', key: 'a', limit: 120000 }],
});
add('clear 清掉账和"太久没盘口"的计数', {
  sessions: [sess()],
  steps: [ens('k', opt(1)), { op: 'advance', ms: 31000 }, ens('k', opt(1), { limit: 30000 }), { op: 'clear' }, ens('k', opt(1)), { op: 'advance', ms: 31000 }, ens('k', opt(1), { limit: 30000 }), { op: 'size' }],
});
add('Map 的那一半:重设已有的键位置不动,删了再设排到最后', {
  sessions: [sess()],
  steps: [{ op: 'sub', session: 'A', as: 'h', contract: opt(1) }, { op: 'setRaw', key: 'a', handle: 'h', contract: opt(1), session: 'A' }, { op: 'setRaw', key: 'b', handle: null, contract: null, session: null },
    { op: 'setRaw', key: 'a', handle: null, contract: null, session: null }, { op: 'delete', key: 'a' }, { op: 'setRaw', key: 'a', handle: 'h', contract: opt(1), session: 'A' }, { op: 'delete', key: 'nope' }],
});

// ---- 随机序列
{
  const contracts = [opt(7700), opt(7725), opt(7750, 'P'), opt(7775, 'P', 'SPX'), stk('BE'), stk('QQQ')];
  const keys = ['a', 'b', 'c', 'd'];
  const statuses = [0, 30000, 120000, 5000];
  for (let n = 0; n < 70; n += 1) {
    const variants = [null, '', '106'];
    const sessions = [sess('A', { times: r.chance(0.85), throwCancel: r.chance(0.07) }), sess('B', { times: r.chance(0.85) })];
    const qualifies = Array.from({ length: 1 + r.int(5) }, () => {
      const o = { v: r.pick([true, true, true, false, 'stalled']) };
      if (r.chance(0.1)) { delete o.v; o.throw = 'boom'; }
      if (r.chance(0.2)) o.delay = r.pick([100, 3000, 20000]);
      return o;
    });
    const events = [];
    for (let i = 0; i < 6; i += 1) {
      const c = r.pick(contracts);
      for (const sn of ['A', 'B']) {
        if (r.chance(0.5)) events.push({ at: r.int(300000), session: sn, key: tickerKey(c), patch: r.chance(0.12) ? { error: r.pick(['10197', '354']) } : { quotedAt: START + r.int(300000), bid: 1, ask: 1.1 } });
      }
    }
    events.sort((x, y) => x.at - y.at);
    const hsNames = ['main', 'stock'];
    const held = { main: r.pick(variants), stock: r.pick(variants) };
    const steps = [{ op: 'sub', session: 'A', as: 'h0', contract: stk('BE') }, { op: 'sub', session: 'B', as: 'h1', contract: opt(7725) }];
    for (let i = 0; i < 24; i += 1) {
      const p = r.next();
      const base = { hs: r.pick(hsNames), session: r.pick(['A', 'B']), key: r.pick(keys) };
      if (p < 0.35) steps.push({ op: 'ensure', ...base, contract: r.pick(contracts), limit: r.pick(statuses) });
      else if (p < 0.55) steps.push({ op: 'usable', ...base, limit: r.pick(statuses), ...(r.chance(0.3) ? { now: START + r.int(300000) } : {}) });
      else if (p < 0.65) steps.push({ op: 'subscribe', ...base, contract: r.pick(contracts) });
      else if (p < 0.82) steps.push({ op: 'advance', ms: r.pick([1, 1000, 29999, 30000, 31000, 60000, 119999, 120000, 150000]) });
      else if (p < 0.9) steps.push({ op: 'release', hs: base.hs, keep: keys.filter(() => r.chance(0.5)), shared: r.chance(0.5) ? { [r.pick(keys)]: r.pick([['h0'], ['h1'], [null], ['h0', 'h1']]) } : {} });
      else if (p < 0.94) steps.push({ op: 'connected', session: base.session, v: r.chance(0.5) });
      else if (p < 0.97) steps.push({ op: 'delete', hs: base.hs, key: base.key });
      else steps.push({ op: 'clear', hs: base.hs });
    }
    add(`随机 ${n}`, { sessions, held, qualifies, events, steps });
  }
}

const pure = {
  limit: ['盘中', '盘外', '盘前', '盘后', '休市', '', '认不出', ' 盘中', '盘中 ', 'closed'].map((s) => [s, X.silenceLimitMs(s)]),
  silence: [],
};
const nums = [undefined, null, 0, -5, 1, 1000, 1e12, NaN, START, START - 1];
for (let i = 0; i < 200; i += 1) {
  const t = { quotedAt: r.pick(nums), requestedAt: r.pick(nums) };
  const now = r.pick([0, 1, 1000, START, START + 30000, NaN, -1]);
  pure.silence.push({ t: enc(t), now: enc(now), out: enc(X.quoteSilenceMs(t, now)) });
}
const out = scenarios.map((s) => ({ name: s.name, script: enc(s.script), expected: enc(null) }));
for (let i = 0; i < scenarios.length; i += 1) out[i].expected = enc(await run(scenarios[i].script));
const text = JSON.stringify({ scenarios: out, pure });
writeFileSync(join(here, 'held_streams.json'), text);
console.log(`held_streams.json:${scenarios.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
void keyOf;
