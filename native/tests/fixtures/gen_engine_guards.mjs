// 生成 engine_guards.json:engine-ts 的 engine/wakeGuard、engine/exits(TrackExits)、engine/accountGuard(原模块现跑)的答案。
//   wake:种子固定的墙钟 / 醒着钟 / 连接 / 追踪序列(睡眠、卡住、维护唤醒、边界上的 30 / 60 / 20 / 120 秒、墙钟倒拨),每一步的结论与全部给人看的话、reportWake 的日志 / 留痕 / 通知。
//   exits:真交易库上的一串操作(推峰值的价、标的止损确认、judge、分批止盈的标记与解闩、到点平仓作废、提醒去重)。
//   account:假 router(持仓 / 会话)与假库(在途单、日内亏损到线记录)上的 validatorExtras / isReduceOnly / dailyPnl / protections / withLatch。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_engine_guards.mjs <编过的 engine-ts 目录>
import cryptoDefault from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASE_CONFIG, deepMerge, enc, rng } from './engine_world.mjs';
import { stk, trk } from './engine_scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const imp = (f) => import(pathToFileURL(join(engine, `dist/src/${f}.js`)).href);

let T = Date.UTC(2026, 8, 11, 16, 0, 0);
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(T); else super(...a); }
  static now() { return T; }
}
globalThis.Date = FakeDate;
let uuidN = 0;
cryptoDefault.randomUUID = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`;
syncBuiltinESMExports();

const [wake, exitsMod, accountMod, config, tk, storeMod, notifyMod, protections, positions, openRisk] =
  await Promise.all(['engine/wakeGuard', 'engine/exits', 'engine/accountGuard', 'config', 'tracker', 'store', 'notify', 'protections', 'positions', 'openRisk'].map(imp));
const jn = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));
const out = { base: enc(deepMerge({ ...BASE_CONFIG, storage: { db_path: '/tmp/x.db' } }, {})), wake: [], awake: [], texts: [], live: [], exits: [], account: [] };

// ======================================================================= wake
{
  const wakeCase = (samples) => {
  const wg = new wake.WakeGuard();
  const steps = [];
  for (const s of samples) {
    if (s.pause) wg.pause();
    const { pause, ...sample } = s;
    const step = wg.step(sample);
    const logs = [], audits = [], notes = [];
    wake.reportWake(step, { audit: (a, b, c) => audits.push([a, b, jn(c)]) }, { notify: (t, b, sub) => notes.push([t, b, sub ?? null]) }, (l) => logs.push(l));
    const texts = {
      gap: step.gap ? wake.gapLogLine(step.gap) : null, released: step.released ? wake.releasedLogLine(step.released) : null,
      episode: step.episode ? wake.episodeLogLine(step.episode) : null, audit: step.episode ? wake.episodeAudit(step.episode) : null, notice: step.episode ? wake.episodeNotice(step.episode) : null,
    };
    steps.push(enc({ step, texts, logs, audits, notes }));
  }
  out.wake.push({ samples: enc(samples), expected: steps });
  };
  for (let seed = 1; seed <= 32; seed += 1) {
    const r = rng(seed * 7919);
    let wall = Date.UTC(2026, 8, 11, 13, 30, 0), mono = 5_000_000;
    const links = ['', 'paper', 'paper,live', '2'];
    let link = 'paper';
    const samples = [];
    const nS = r.range(20, 70);
    for (let i = 0; i < nS; i += 1) {
      const x = r.next();
      let dw = 1000, dm = 1000;
      if (x < 0.12) { dw = r.pick([30_000, 30_001, 29_999, 45_000, 600_000, 3_600_000, 14_400_000]); dm = r.pick([0, 10, dw, dw + 5000, dw + 31000, Math.floor(dw / 2), Math.floor(dw / 2) - 1, Math.floor(dw / 2) + 1, 5000]); }
      else if (x < 0.2) { dw = r.pick([2000, 15_000, 21_000, 59_000, 60_000, 61_000, 119_000, 120_000, 121_000]); dm = dw; }
      else if (x < 0.23) { dw = -r.pick([1000, 40_000]); dm = 1000; }
      else if (x < 0.27) { dw = r.pick([20_000, 20_001, 19_999]); dm = dw; }
      wall += dw; mono += dm;
      if (r.chance(0.15)) link = r.pick(links);
      const syms = ['NVDA', 'AMD', 'AAPL', 'SPX', 'QQQ', 'TSLA', 'META'].slice(0, r.range(0, 7));
      const total = syms.length ? r.range(1, 5) : r.pick([0, 0, 1]);
      samples.push({ wall, mono, link, live: { total, hosted: Math.min(total, r.range(0, 3)), symbols: syms } });
      if (r.chance(0.04)) samples[samples.length - 1].pause = true;
    }
    wakeCase(samples);
  }

  // 手写的:边界与聚合
  {
    const tick = (wall, mono, over = {}) => ({ wall, mono, link: 'paper', live: { total: 2, hosted: 1, symbols: ['NVDA', 'AMD'] }, ...over });
    const run = (events, over = {}) => {
      let wall = Date.UTC(2026, 8, 11, 13, 30, 0), mono = 9_000_000;
      const samples = [tick(wall, mono, over)];
      for (const [dw, dm, o] of events) { wall += dw; mono += dm; samples.push(tick(wall, mono, { ...over, ...(o ?? {}) })); }
      for (let i = 0; i < 70; i += 1) { wall += 1000; mono += 1000; samples.push(tick(wall, mono, over)); }
      wakeCase(samples);
    };
    run([[100_000, 50_000]]);
    run([[100_000, 50_000], [5000, 5000], [100_000, 50_000]]);
    run([[100_000, 0], [5000, 5000], [100_000, 100_000]]);
    run([[100_000, 0]], { live: { total: 1, hosted: 0, symbols: ['NVDA'] } });
    run([[100_000, 0]], { live: { total: 1, hosted: 1, symbols: ['A', 'B', 'C', 'D', 'E', 'F'] } });
    run([[59_999, 0]], { live: { total: 3, hosted: 0, symbols: ['NVDA'] } });
    run([[60_000, 0]], { live: { total: 3, hosted: 0, symbols: ['NVDA'] } });
    run([[100_000, 130_000]]);
    run([[40_000, 40_000], [20_000, 20_000, { link: '' }], [20_000, 20_000]]);
    run([[100_000, 0], [1000, 1000, { link: '' }], [19_999, 19_999, { link: 'paper' }], [1000, 1000], [20_000, 20_000]]);
  }
  // 纯函数
  for (const ms of [0, 499, 500, 1500, 29_999, 59_499, 59_500, 60_000, 89_999, 90_000, 3_599_999, 3_600_000, 3_660_000, 5_400_000, 86_400_000 * 2.5, 12.5, 1e9]) out.texts.push({ f: 'duration', a: [ms], expected: wake.durationText(ms) });
  for (const [a, b, sec] of [[Date.UTC(2026, 8, 11, 13, 30, 5), Date.UTC(2026, 8, 11, 14, 0, 59), false], [Date.UTC(2026, 8, 11, 13, 30, 5), Date.UTC(2026, 8, 11, 14, 0, 59), true],
    [Date.UTC(2026, 8, 11, 23, 30, 5), Date.UTC(2026, 8, 12, 12, 1, 9), false], [Date.UTC(2026, 11, 31, 23, 30, 5), Date.UTC(2027, 0, 1, 12, 1, 9), true], [Date.UTC(2026, 2, 8, 6, 59, 0), Date.UTC(2026, 2, 8, 7, 1, 0), true]]) {
    out.texts.push({ f: 'span', a: [a, b, sec], expected: wake.spanText(a, b, sec) });
  }
  out.texts.push({ f: 'hold', a: [], expected: wake.HOLD_REASON });
  const cpus = [[{ times: { user: 1, nice: 0, sys: 0, idle: 0, irq: 0 } }], [{ times: { user: 0, nice: 1, sys: 0, idle: 0, irq: 0 } }], [{ times: { user: 5, nice: 3, sys: 0, idle: 0, irq: 0 } }, { times: { user: 4, nice: 4, sys: 0, idle: 0, irq: 0 } }], [{ times: { user: 10, nice: 1, sys: 5, idle: 100, irq: 0 } }, { times: { user: 50, nice: 0, sys: 5, idle: 100, irq: 1 } }], [], [{ times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }]];
  for (const c of cpus) for (const platform of ['darwin', 'linux', 'win32']) out.awake.push({ cpus: c.map((x) => x.times), platform, expected: wake.awakeClockMs(() => c, platform, () => 4242.5) });
  const rt = [null, { sessions: () => [] }, { sessions: () => [1, 2] }, { sessions: () => [1] }, { connectedNames: () => ['live', 'paper'], sessions: () => [] }, { connectedNames: () => [], sessions: () => [1] }];
  const caps = ['null', 'none', 'two', 'one', 'names', 'emptynames'];
  rt.forEach((router, i) => out.live.push({ f: 'link', caps: caps[i], names: i >= 4 ? router.connectedNames() : [], count: router && !router.connectedNames ? router.sessions().length : 0, expected: wake.linkOf(router) }));
  const tracks = [{ id: 'a', enabled: true, fired_at: null, auto_close: { host_at_broker: true }, symbol: 'NVDA' }, { id: 'b', enabled: true, fired_at: 'x', symbol: 'AMD' }, { id: 'c', enabled: false, fired_at: null, auto_close: { host_at_broker: false }, symbol: 'NVDA' },
    { id: 'd', enabled: 1, fired_at: '', auto_close: null, symbol: 'SPX' }, { id: 'e', enabled: false, fired_at: 'z', symbol: 'AAPL', auto_close: { host_at_broker: 1 } }, { id: 7, enabled: false, symbol: 'QQQ' }];
  for (const chasing of [[], ['b'], ['b', 'e', '7'], ['c']]) out.live.push({ f: 'liveTracks', tracks, chasing, expected: wake.liveTracksOf(tracks, (id) => chasing.includes(id)) });
}

// ======================================================================= exits
{
  const dir = mkdtempSync(join(tmpdir(), 'dafri-exits-'));
  const Database = createRequire(join(engine, 'package.json'))('better-sqlite3');
  void Database;
  const mkTargets = (s) => tk.makeTargets(s);
  const posOf = (p) => tk.makePosition(p);
  const spotSpec = [{}, { spot_stop_below: 7400, spot_stop_confirm_s: 3 }, { spot_stop_above: 7600 }, { spot_stop_below: 7400, spot_stop_above: 7600, spot_stop_confirm_s: 2 }];
  const targetSpecs = [{ take_profit: 250, stop_loss: 160 }, { stop_loss: 160, spot_stop_confirm_s: 3 }, { trail_pct: 10 }, { profit_drawdown_pct: 30 },
    { take_profit_tiers: [{ price: 240, fraction_pct: 50 }, { price: 260, fraction_pct: 100 }] }, { exit_at: '15:30' }, { exit_at: '09:31', exit_at_ms: T - 3_600_000 }, { exit_at: '15:30', exit_at_ms: T + 3_600_000 }, {}];
  const posSpecs = [
    { account: '模拟', symbol: 'NVDA', sec_type: 'STK', quantity: 100, avg_cost: 180, market_price: 220 },
    { account: '模拟', symbol: 'NVDA', sec_type: 'STK', quantity: -100, avg_cost: 180, market_price: 175 },
    { account: '模拟', symbol: 'SPX', sec_type: 'OPT', quantity: 2, avg_cost: 800, multiplier: 100, market_price: 9, contract: { secType: 'OPT', right: 'C', strike: 7500 } },
    { account: '模拟', symbol: 'SPX', sec_type: 'BAG', quantity: 3, avg_cost: 300, multiplier: 100, market_price: 2.5 },
  ];
  let caseNo = 0;
  const runExits = (ops) => {
    const seed = (caseNo += 1);
    // 运行
    uuidN = 0; T = Date.UTC(2026, 8, 11, 16, 0, 0);
    const store = new storeMod.TradeStore(join(dir, `e${seed}.db`));
    const notes = [];
    const notifier = new notifyMod.Notifier(false, [(t, s, b) => notes.push([t, s, b])]);
    const ex = new exitsMod.TrackExits({ store, notifier });
    const names = {}, recs = {};
    const sub = (v) => JSON.parse(JSON.stringify(v).replace(/\$\{rec:([^}]+)\}/g, (_m, n) => recs[n] ?? 'none'));
    const steps = [];
    for (const o of ops) {
      notes.length = 0;
      let res = null;
      const trackOf = () => store.getTrack(names[o.track]);
      const at = (ms) => config.etNowFromEpoch(ms);
      if (o.op === 'track') names[o.name] = store.addTrack(sub(o.spec)).id;
      else if (o.op === 'record') { recs[o.name] = store.createRecord({ signature: 'x' }); if (o.final) store.setFinalStatus(recs[o.name], o.final); }
      else if (o.op === 'upd') store.updateTrack(names[o.track], sub(o.fields));
      else if (o.op === 'round') ex.nextRound();
      else if (o.op === 'peak') res = ex.peakMark(names[o.track], posOf(o.pos), o.price, o.confirm);
      else if (o.op === 'confirmSpot') res = ex.confirmSpot(names[o.track], mkTargets(o.targets), o.nullRow ? null : o.row, o.now);
      else if (o.op === 'judge') {
        const args = { track: trackOf(), position: posOf(o.pos), targets: mkTargets(o.targets), auto: tk.makeAutoClose(o.auto), price: o.price, at: at(o.at), spotTarget: o.spotTarget ?? null, spotStop: o.spotStop ?? null };
        if ('natural' in o) args.natural = o.natural;
        res = ex.judge(args);
      } else if (o.op === 'warn') res = ex.warnBlocked(trackOf(), o.state);
      else if (o.op === 'tierAuto') res = ex.tierAuto(trackOf(), mkTargets(o.targets), o.result, tk.makeAutoClose(o.auto), posOf(o.pos));
      else if (o.op === 'tierNotSent') ex.tierNotSent(trackOf());
      else if (o.op === 'rearm') res = ex.rearmTier(trackOf(), posOf(o.pos));
      else if (o.op === 'forget') ex.forget(new Set(o.alive.map((n) => names[n])));
      steps.push(enc({ r: res, notes: [...notes], tracks: store.listTracks() }));
    }
    const audits = store.db.prepare('SELECT actor, action, detail FROM audit_log ORDER BY seq').all();
    out.exits.push({ ops: enc(ops), expected: steps, audits: enc(audits) });
    store.close?.();
  };
  for (let seed = 1; seed <= 22; seed += 1) {
    const r = rng(seed * 104729);
    const ops = [];
    ops.push({ op: 'track', name: 'A', spec: { account: '模拟', symbol: 'NVDA', sec_type: 'STK', targets: r.pick(targetSpecs), auto_close: { enabled: true }, peak: r.pick([null, 220, 250]) } });
    ops.push({ op: 'track', name: 'B', spec: { account: '模拟', symbol: 'SPX', sec_type: 'OPT', targets: r.pick(targetSpecs), auto_close: { enabled: true, peak_confirm: true } } });
    const nOps = r.range(15, 40);
    for (let i = 0; i < nOps; i += 1) {
      const name = r.pick(['A', 'B']);
      const x = r.next();
      const pos = r.pick(posSpecs);
      const at = T + r.pick([0, 60_000, 3_600_000, 7_200_000, 90_000_000]);
      if (x < 0.1) ops.push({ op: 'round' });
      else if (x < 0.25) ops.push({ op: 'peak', track: name, pos, price: r.pick([null, 200, 210, 220, 230, 190]), confirm: r.chance(0.6) });
      else if (x < 0.4) ops.push({ op: 'confirmSpot', track: name, targets: { ...r.pick(spotSpec) }, nullRow: r.chance(0.15), row: { below: r.chance(0.5) ? 7400 : null, above: r.chance(0.3) ? 7600 : null, spot: r.pick([7390, 7610, 7500]), spot_note: '', hit: r.pick(['below', 'above', null]), reason: '越线' }, now: at });
      else if (x < 0.58) ops.push({ op: 'judge', track: name, pos, targets: r.pick(targetSpecs), auto: r.pick([{ enabled: true }, { enabled: true, peak_confirm: true }]), price: r.pick([null, 150, 165, 180, 220, 245, 255, 265]),
        ...(r.chance(0.5) ? { natural: r.pick([null, 150, 245, 300]) } : {}), at, ...(r.chance(0.3) ? { spotTarget: { spot: 7500, spot_note: '', reached: false } } : {}), ...(r.chance(0.2) ? { spotStop: { below: 7400, above: null, spot: 7390, spot_note: '', hit: 'below', reason: '破位' } } : {}) });
      else if (x < 0.66) ops.push({ op: 'warn', track: name, state: r.pick(['take_profit', 'stop_loss', 'time_exit']) });
      else if (x < 0.76) ops.push({ op: 'tierAuto', track: name, pos, targets: { take_profit_tiers: [{ price: 240, fraction_pct: 50 }, { price: 260, fraction_pct: 100 }] }, result: r.pick([{ tier: 0 }, { tier: 1 }, { tier: 5 }, {}]), auto: { enabled: true, close_fraction_pct: 100 } });
      else if (x < 0.8) ops.push({ op: 'tierNotSent', track: name });
      else if (x < 0.9) ops.push({ op: 'rearm', track: name, pos: { ...pos, quantity: r.pick([100, 60, 50, 0]) } });
      else if (x < 0.94) ops.push({ op: 'upd', track: name, fields: r.pick([{ enabled: false, fired_state: 'take_profit', fired_record: '${rec:R}' }, { fired_at: 'x' }, { targets: { take_profit_tiers: [{ price: 240, fraction_pct: 50, pending: true, pending_qty: 100 }, { price: 260, fraction_pct: 100 }] } },
        { targets: { take_profit_tiers: [{ price: 240, fraction_pct: 50, done: true }, { price: 260, fraction_pct: 100, pending: true, pending_qty: 50 }] } }, { enabled: true, fired_at: null, fired_state: '' }, { fired_state: 'sweep:take_profit', enabled: false, fired_record: '${rec:R}' }]) });
      else if (x < 0.97) ops.push({ op: 'record', name: 'R', final: r.pick(['filled', 'cancelled', null]) });
      else ops.push({ op: 'forget', alive: r.pick([[], ['A'], ['A', 'B']]) });
    }
    ops.splice(2, 0, { op: 'record', name: 'R', final: r.pick(['filled', null]) });
    runExits(ops);

  }
  // 手写的:分批止盈解闩的每个条件、到点平仓作废
  {
    const T0 = Date.UTC(2026, 8, 11, 16, 0, 0);
    const tiers = (a, b) => [{ price: 240, fraction_pct: 50, ...a }, { price: 260, fraction_pct: 100, ...b }];
    const base = (over = {}, rec = 'filled') => [
      { op: 'track', name: 'A', spec: { account: '模拟', symbol: 'NVDA', sec_type: 'STK', targets: { take_profit_tiers: tiers({}, {}) }, auto_close: { enabled: true }, peak: 220 } },
      { op: 'record', name: 'R', final: rec },
      { op: 'upd', track: 'A', fields: { targets: { take_profit_tiers: tiers({ pending: true, pending_qty: 100 }, {}) }, enabled: false, fired_at: 'x', fired_state: 'take_profit', fired_record: '${rec:R}', ...over } },
    ];
    const pos = (q) => ({ account: '模拟', symbol: 'NVDA', sec_type: 'STK', quantity: q, avg_cost: 180, market_price: 220 });
    runExits([...base(), { op: 'rearm', track: 'A', pos: pos(60) }, { op: 'rearm', track: 'A', pos: pos(60) }]);
    runExits([...base(), { op: 'rearm', track: 'A', pos: pos(100) }, { op: 'rearm', track: 'A', pos: pos(99.5) }]);
    runExits([...base({ enabled: true }), { op: 'rearm', track: 'A', pos: pos(60) }]);
    runExits([...base({ fired_state: 'stop_loss' }), { op: 'rearm', track: 'A', pos: pos(60) }]);
    runExits([...base({ fired_record: '' }), { op: 'rearm', track: 'A', pos: pos(60) }]);
    runExits([...base({}, 'cancelled'), { op: 'rearm', track: 'A', pos: pos(60) }]);
    runExits([...base({}, null), { op: 'rearm', track: 'A', pos: pos(60) }]);
    runExits([...base({ fired_state: 'sweep:take_profit' }), { op: 'rearm', track: 'A', pos: pos(60) }]);
    runExits([...base({ targets: { take_profit_tiers: tiers({ done: true }, { pending: true, pending_qty: 50 }) } }), { op: 'rearm', track: 'A', pos: pos(20) }]);
    runExits([...base({ targets: { take_profit_tiers: tiers({ pending: true }, {}) } }), { op: 'rearm', track: 'A', pos: pos(500) }]);
    runExits([...base({ targets: { take_profit_tiers: tiers({}, {}) } }), { op: 'rearm', track: 'A', pos: pos(60) }]);
    runExits([...base({ enabled: true }), { op: 'tierNotSent', track: 'A' }, { op: 'upd', track: 'A', fields: { fired_at: null, fired_state: '', targets: { take_profit_tiers: tiers({ pending: true, pending_qty: 100 }, {}) } } }, { op: 'tierNotSent', track: 'A' }, { op: 'tierNotSent', track: 'A' }]);
    // 到点平仓作废
    const lapse = [{ op: 'track', name: 'A', spec: { account: '模拟', symbol: 'NVDA', sec_type: 'STK', targets: { exit_at: '09:31', exit_at_ms: T0 - 2 * 86_400_000 }, auto_close: { enabled: true } } },
      { op: 'judge', track: 'A', pos: pos(100), targets: { exit_at: '09:31', exit_at_ms: T0 - 2 * 86_400_000 }, auto: { enabled: true }, price: 220, at: T0 },
      { op: 'judge', track: 'A', pos: pos(100), targets: { exit_at: '09:31', exit_at_ms: T0 - 2 * 86_400_000 }, auto: { enabled: true }, price: 220, at: T0 }];
    runExits(lapse);
    runExits([{ op: 'track', name: 'A', spec: { account: '模拟', symbol: 'NVDA', sec_type: 'STK', targets: {}, auto_close: { enabled: true } } }, { op: 'warn', track: 'A', state: 'a' }, { op: 'warn', track: 'A', state: 'a' }, { op: 'warn', track: 'A', state: 'b' }, { op: 'upd', track: 'A', fields: { fired_state: 'blocked' } },
      { op: 'warn', track: 'A', state: 'b' }, { op: 'warn', track: 'A', state: 'c' }, { op: 'forget', alive: [] }, { op: 'warn', track: 'A', state: 'c' }]);
  }
  rmSync(dir, { recursive: true, force: true });
}

// ======================================================================= account guard
{
  const r = rng(424242);
  const NOW = Date.UTC(2026, 8, 11, 16, 0, 0);
  const optRow = (account, strike, right, qty, avgCost, symbol = 'SPX', expiry = '20261016') => {
    const contract = { secType: 'OPT', symbol, lastTradeDateOrContractMonth: expiry, strike, right, multiplier: '100' };
    const ident = positions.legOf(contract);
    return { key: positions.makeKey(account, symbol, 'OPT', ident), account, symbol, sec_type: 'OPT', leg: ident, quantity: qty, avg_cost: avgCost, multiplier: 100, currency: 'USD', market_price: null, market_value: null, unrealized_pnl: null, contract };
  };
  const fly = (account, lots) => [optRow(account, 7725, 'C', lots, 800), optRow(account, 7750, 'C', -2 * lots, 200), optRow(account, 7775, 'C', lots, 50)];
  const probeOrders = (account) => [
    { contract: { secType: 'OPT', symbol: 'SPX', lastTradeDateOrContractMonth: '20261016', strike: 7725, right: 'C' }, order: { action: 'SELL', totalQuantity: 1 }, alias: account },
    { contract: { secType: 'OPT', symbol: 'SPX', lastTradeDateOrContractMonth: '20261016', strike: 7725, right: 'C' }, order: { action: 'SELL', totalQuantity: 5 }, alias: account },
    { contract: { secType: 'BAG', symbol: 'SPX', legs: [{ lastTradeDateOrContractMonth: '20261016', strike: 7725, right: 'C', action: 'SELL', ratio: 1 }, { lastTradeDateOrContractMonth: '20261016', strike: 7750, right: 'C', action: 'BUY', ratio: 2 }] }, order: { action: 'BUY', totalQuantity: 1 }, alias: account },
  ];
  for (let n = 0; n < 130; n += 1) {
    const cfgPatch = {};
    const capped = r.chance(0.6);
    if (capped) cfgPatch.limits = r.pick([{ max_open_risk_usd: 1 }, { max_underlying_contracts: 1 }, { by_account: { 主账户: { max_open_risk_usd: 1 } } }, { by_account: { 主账户: { max_underlying_contracts: 1 } } }, { max_open_risk_usd: 0, by_account: { 模拟: { max_underlying_contracts: 3 } } }, { max_open_risk_usd: 5000, by_account: { 模拟: { max_underlying_contracts: 1 } } }, { max_open_risk_usd: 5000 }, { max_underlying_contracts: 4 }, { max_open_risk_usd: 5000, max_underlying_contracts: 4, by_account: { 主账户: { max_open_risk_usd: 100 } } }]);
    else if (r.chance(0.3)) cfgPatch.limits = { by_account: { 主账户: { max_underlying_contracts: 2 } } };
    if (r.chance(0.5)) cfgPatch.risk_budget = { enabled: true, equity_usd: { 模拟: 50000 }, max_risk_pct: 5, max_position_pct: 20 };
    cfgPatch.protections = { daily_loss: { enabled: r.chance(0.7), max_loss_usd: 500, basis: r.pick(['account', 'realized']) }, cooldown: { enabled: r.chance(0.5), minutes: 30, scope: r.pick(['symbol', 'position']) }, stoploss_guard: { enabled: r.chance(0.4), lookback_minutes: 120, trigger_count: 2, pause_minutes: 30 } };
    const settings = config.fromDict(deepMerge({ ...BASE_CONFIG, storage: { db_path: '/tmp/x.db' } }, cfgPatch));
    const rows = [...fly('模拟', r.pick([1, 2, 3])), ...(r.chance(0.5) ? fly('主账户', 1) : []), optRow('模拟', 7500, 'P', r.pick([-1, 2]), 100, 'NDX')];
    const routerKind = r.pick(['ok', 'ok', 'throw', 'null', 'futu']);
    const sessionSpecs = r.chance(0.8) ? [{ connected: r.chance(0.9), accounts: ['DU7654321'], caps: { pnl: r.chance(0.9), equity: r.chance(0.9) }, pnl: { DU7654321: r.pick([{ daily: -600, currency: 'USD', atMs: NOW - 5000 }, { daily: -100, currency: 'USD', atMs: NOW - 5000 }, { daily: -900, currency: 'USD', atMs: NOW - 90_000 }, { daily: -700, currency: 'HKD', atMs: NOW }, null]) },
      equity: { DU7654321: r.pick([{ amount: 52340.12, currency: 'USD' }, { amount: 0, currency: 'USD' }, { amount: 100, currency: 'EUR' }, null]) } },
    ...(r.chance(0.4) ? [{ connected: true, accounts: ['U1234567'], caps: { pnl: true, equity: true }, pnl: { U1234567: { daily: -501, currency: 'USD', atMs: NOW - 1000 } }, equity: { U1234567: { amount: 30000, currency: 'USD' } } }] : [])] : [];
    const working = r.chance(0.5) ? [{ alias: '模拟', contract: { secType: 'OPT', symbol: 'SPX', lastTradeDateOrContractMonth: '20261016', strike: 7725, right: 'C' }, order: { action: 'BUY', totalQuantity: 2 }, notional: 900 },
      { alias: '模拟', contract: { secType: 'BAG', symbol: 'SPX', legs: [{ lastTradeDateOrContractMonth: '20261016', strike: 7725, right: 'C', action: 'SELL', ratio: 1 }, { lastTradeDateOrContractMonth: '20261016', strike: 7750, right: 'C', action: 'BUY', ratio: 2 }] }, order: { action: 'BUY', totalQuantity: 'x' }, notional: 450 },
      { alias: '主账户', contract: { secType: 'STK', symbol: 'AAPL' }, order: { totalQuantity: 10 }, notional: 2000 },
      { alias: '副账户', contract: { secType: 'OPT', symbol: 'NDX', lastTradeDateOrContractMonth: '2026101612', strike: 100, right: 'C' }, order: { action: 'BUY', totalQuantity: 3 }, notional: 77 },
      { alias: '模拟', contract: { secType: 'OPT', symbol: 'SPY', lastTradeDateOrContractMonth: '20261016', strike: 100, right: 'P' }, order: { action: 'BUY', totalQuantity: 1 }, notional: 12 }, { alias: '模拟', contract: { secType: 'OPT', symbol: 'SPX', lastTradeDateOrContractMonth: '20261016', strike: 7725, right: 'C' }, order: { action: 'SELL', totalQuantity: 1 }, notional: 10 }] : [];
    const trips = r.chance(0.5) ? [{ alias: '主账户', reason: '日内亏损到线', untilMs: NOW + 5 * 3600_000 }, { alias: '模拟', reason: 'r2', untilMs: NOW + 1000 }] : [];
    const tripsThrow = r.chance(0.1);
    const ops = [];
    const nOps = r.range(3, 8);
    for (let i = 0; i < nOps; i += 1) {
      const x = r.next();
      const nowMs = NOW + r.pick([0, 0, 86_400_000, 3600_000]);
      if (x < 0.3) ops.push({ op: 'extras', nowMs: r.chance(0.7) ? nowMs : undefined, rowsNext: r.pick(['same', 'throw', 'ok']) });
      else if (x < 0.45) ops.push({ op: 'reduceOnly', alias: r.pick(['模拟', '主账户']), idx: r.range(0, 2) });
      else if (x < 0.6) ops.push({ op: 'dailyPnl', nowMs });
      else if (x < 0.85) ops.push({ op: 'protections', nowMs, closes: r.chance(0.6) ? [{ atMs: nowMs - 10 * 60_000, symbol: 'NVDA', state: 'stop_loss', leg: '' }, { atMs: nowMs - 20 * 60_000, symbol: 'NVDA', state: 'stop_loss', leg: '' }, { atMs: nowMs - 5 * 60_000, symbol: 'AAPL', state: 'take_profit' }] : [], pnl: r.chance(0.5) ? [{ atMs: nowMs - 60_000, pnl: -700 }] : [] });
      else ops.push({ op: 'latch', nowMs, pauses: r.chance(0.5) ? { 模拟: { rule: 'daily_loss', reason: 'x', untilMs: nowMs + 1000 } } : {} });
    }
    // ---- 运行
    const calls = [];
    const mkSession = (s) => {
      const o = { isConnected: () => s.connected, managedAccounts: () => s.accounts };
      if (s.caps.pnl) o.accountPnl = (id) => { const v = s.pnl[id]; return v ? { daily: v.daily, unrealized: null, realized: null, currency: v.currency, atMs: v.atMs } : null; };
      if (s.caps.equity) o.netLiquidation = (id) => s.equity[id] ?? null;
      return o;
    };
    let rowsMode = 'ok';
    const router = routerKind === 'null' ? null : {
      BROKER: routerKind === 'futu' ? 'futu' : 'ibkr',
      async positions() { calls.push(['positions']); if (routerKind === 'throw' || rowsMode === 'throw') throw new Error('读不到'); return structuredClone(rows); },
      sessions: () => sessionSpecs.map(mkSession),
    };
    const store = { audit: (a, b, c) => calls.push(['audit', a, b, jn(c)]), risk: {
      workingOrders: (since, now) => { calls.push(['workingOrders', since, now]); return structuredClone(working); },
      dailyLossTrips: (since, now) => { calls.push(['dailyLossTrips', since, now]); if (tripsThrow) throw new Error('库坏了'); return structuredClone(trips); } } };
    T = NOW;
    const guard = new accountMod.AccountGuard({ settings, router, store });
    const results = [];
    let lastExtras = null;
    for (const o of ops) {
      if (o.op === 'extras') {
        rowsMode = o.rowsNext === 'throw' ? 'throw' : 'ok';
        const ex = await guard.validatorExtras(o.nowMs);
        lastExtras = ex;
        const probes = ex.isReduction ? probeOrders('模拟').map((p) => ex.isReduction({ contract: p.contract, order: p.order }, p.alias)) : null;
        if (ex.consumeReduction) { const p0 = probeOrders('模拟')[0]; ex.consumeReduction({ contract: p0.contract, order: p0.order }, p0.alias); }
        const probes2 = ex.isReduction ? probeOrders('模拟').map((p) => ex.isReduction({ contract: p.contract, order: p.order }, p.alias)) : null;
        results.push(enc({ exposure: ex.exposure, equity: ex.equity, capNote: ex.capNote, has: [Boolean(ex.isReduction), Boolean(ex.consumeReduction)], probes, probes2 }));
      } else if (o.op === 'reduceOnly') {
        const p = probeOrders(o.alias)[o.idx];
        rowsMode = 'ok';
        results.push(enc(await guard.isReduceOnly({ order: { contract: p.contract, order: p.order }, account: { alias: o.alias } })));
      } else if (o.op === 'dailyPnl') results.push(enc(guard.dailyPnl(o.nowMs)));
      else if (o.op === 'protections') results.push(enc(guard.protections(settings.protections, o.closes, o.pnl, o.nowMs)));
      else if (o.op === 'latch') results.push(enc(guard.withLatch({ pause: null, cooldowns: {}, accountPauses: o.pauses }, o.nowMs)));
    }
    void lastExtras;
    out.account.push({ cfgPatch, rows: enc(rows), routerKind, sessions: enc(sessionSpecs), working: enc(working), trips: enc(trips), tripsThrow, ops: enc(ops), expected: { results, calls: enc(calls) } });
  }
}
const text = JSON.stringify(out);
writeFileSync(join(here, process.env.OUT ?? 'engine_guards.json'), text);
console.log(`engine_guards.json:wake ${out.wake.length} exits ${out.exits.length} account ${out.account.length},${(text.length / 1024).toFixed(0)} KB`);
