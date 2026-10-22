// 生成 svc_playbook.json:engine-ts 的 PlaybookService(services/playbook.ts,原模块现跑)对着脚本驱动的假宿主的场景(见 svc1_world.mjs、svc1_playbook_world.mjs
// 开头的约定)。场景照 engine-ts/tests/playbook-service.spec.ts 里的用例写,再加种子固定的随机交错(随机的 tickOnce 序列跨日子、早收盘日、假日、周末、
// 昨日口径的取价窗口、DST 切换;现价的随机游走与跳变,盘口 / 分钟线 / 期权墙 / 收盘价各种缺与错;重启、开关、循环、并发)。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_svc_playbook.mjs <编过的 engine-ts 目录>
// 脚本 steps 的方法:tickOnce(nowMs?) snapshot() enabled() setEnabled(on) start(tickMs?) stop();步:见两份 world 文件。
// 规矩:每个 start:true 的调用后面紧跟 advance 或 await(C++ 的 tickInner 当场开始,JS 晚一个微任务,见 playbook_service.h 的头注释)。
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeWall } from './svc1_data.mjs';
import { makeExtraOps, makeMarks, makeSession, makeSettings, patchRouter } from './svc1_playbook_world.mjs';
import {
  BASE_CONFIG, World, dumpDb, enc, loadMods, makeMarket, makeNotifier, makeRouter, rng, runSteps,
} from './svc1_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engineDir = process.argv[2];
if (!engineDir) throw new Error('要给编过的 engine-ts 目录');
const OUT = process.env.OUT ?? 'svc_playbook.json';
const only = process.env.ONLY;

const mods = await loadMods(engineDir, ['config', 'rpcError', 'broker', 'optionMarks', 'store', 'services/playbook']);
mods.BrokerError = mods.broker.BrokerError;
mods.OptionMarksError = mods.optionMarks.OptionMarksError;

// ---------------------------------------------------------------- 跑一个场景
async function runScenario(script) {
  const world = new World(script);
  try {
    const box = { settings: makeSettings(mods.config, world) };
    const store = new mods.store.TradeStore(join(world.dir, 't.db'));
    const routerState = { ...(script.router ?? {}) };
    const session = makeSession(world, mods);
    const ctx = { world, script, mods, engineDir, store, routerState };
    ctx.rebuildRouter = () => { ctx.router = patchRouter(world, mods, makeRouter(world, mods, routerState, () => session)); };
    ctx.rebuildRouter();
    const engine = { store, notifier: makeNotifier(world) };
    const host = {
      get settings() { return box.settings; },
      get router() { return routerState.on === false ? null : ctx.router; },
      get engine() { return engine; },
      emit(event, payload) { world.rec('emit', [event, payload]); },
    };
    const marks = makeMarks(world, mods);
    const market = makeMarket(world, mods);
    const make = () => new mods.playbook.PlaybookService(host, marks, market);
    let svc = make();
    ctx.setSettings = (patch) => { box.settings = makeSettings(mods.config, world, patch); };
    ctx.shape = (m, v) => (v === undefined ? null : v);
    ctx.extraOps = makeExtraOps(world, () => { svc.stop(); svc = make(); });
    ctx.methods = {
      tickOnce: ([nowMs]) => svc.tickOnce(nowMs ?? undefined),
      snapshot: () => svc.snapshot(),
      enabled: () => svc.enabled(),
      setEnabled: ([on]) => svc.setEnabled(on),
      start: ([ms]) => { svc.start(ms ?? undefined); },
      stop: () => { svc.stop(); },
    };
    const steps = await runSteps(ctx);
    const db = dumpDb(engineDir, join(world.dir, 't.db'), world);
    svc.stop();
    store.close();
    return { log: world.log, steps, db };
  } finally {
    world.restore();
  }
}

// ---------------------------------------------------------------- 脚本的小零件
/** 美东某天某时刻(epoch 毫秒);2026-03-08 ~ 11-01 之间是夏令时 */
const offsetOf = (day) => (day >= '2026-03-08' && day < '2026-11-01' ? '-04:00' : '-05:00');
const D0 = '2026-10-21'; // 周三
const et = (hhmm, day = D0, sec = 0) => Date.parse(`${day}T${hhmm}:${String(sec).padStart(2, '0')}${offsetOf(day)}`);
const ok = (v, delay) => (delay ? { ok: v, delay } : { ok: v });
const err = (kind, message, delay, code) => ({ err: { kind, message, ...(code !== undefined ? { code } : {}) }, ...(delay ? { delay } : {}) });
const call = (m, a = [], extra = {}) => ({ op: 'call', m, a, ...extra });
const adv = (ms) => ({ op: 'advance', ms });
const to = (t) => ({ op: 'advance', to: t });
const tick = (ms) => call('tickOnce', ms === undefined ? [] : [ms]);
const snap = () => call('snapshot');
const files = (extra = {}) => ({ op: 'files', ...extra });
const db = () => ({ op: 'db' });
const fake = (key, list) => ({ op: 'fake', key, list });
const setPref = (value) => ({ op: 'store', m: 'setPref', a: ['playbook', value] });
const rawExec = (sql) => ({ op: 'store', m: 'rawExec', a: [sql] });
const logwrite = (date, lines) => ({ op: 'logwrite', date, lines });
const IDX = { price: 0, source: 'index', note: '' };
const info = (source = 'index') => ok({ price: 0, source, note: '' });
const EM = Math.sqrt(Math.PI / 2);
const FUTU = { broker: { provider: 'futu' }, connections: { futu: { broker: 'futu', host: '127.0.0.1', port: 11111, client_id: 13 } } };

/** 平值跨式两条腿的盘口(中间价 c / p) */
const pair = (c, p, strike = 7720, w = 0.1) => [
  { strike, right: 'C', bid: c - w, ask: c + w, iv: 0.15, error: null },
  { strike, right: 'P', bid: p - w, ask: p + w, iv: 0.15, error: null },
];
/** 写进底账的一条区间(与 makeBand 同键序) */
const bandOf = (at, anchor, c, p, expiry, source = 'live') => {
  const em = EM * (c + p);
  return { at, anchor, strike: Math.round(anchor / 5) * 5, expiry, call: c, put: p, source, em, lower: anchor - em, upper: anchor + em };
};

/** 期权墙:analyze 现算,只留剧本用的 11 个字段 */
async function wall(spot, seed, opts = {}) {
  const w = await makeWall(engineDir, rng(seed), spot, 'SPX', opts.expiry ?? '20261021', 0, { step: 5, half: opts.half ?? 3, tradingClass: 'SPXW' });
  return {
    expiry: w.expiry, call_wall: w.call_wall, put_wall: w.put_wall, gamma_flip: w.gamma_flip, net_gex: w.net_gex, net_gex_ratio: w.net_gex_ratio,
    regime: w.regime, strikes: w.strikes, coverage: w.coverage, oi_missing: w.oi_missing, warnings: opts.warn ? w.warnings : ['OI 是隔夜存量'],
  };
}
const W7720 = await wall(7718, 3);
/** 手捏的期权墙:strikes 里的 net_gex 由调用方给(加速档 / T2 的用例要确定的符号) */
const handWall = (strikes) => ({ ...W7720, strikes: strikes.map(([strike, gex]) => ({ strike, call_oi: 100, put_oi: 100, call_vol: 10, put_vol: 10, net_gex: gex })) });

/** 一个场景的默认答案 */
const F = (o = {}) => ({
  'router.indexPrice': [ok(7718.4)],
  'router.spotInfo': [info()],
  'marks.read': [ok(pair(10, 10))],
  'market.wallFor|SPX': [ok(W7720)],
  'router.historicalBars|2026-10-20': [ok([{ date: '2026-10-20', close: 7701.2 }])],
  ...o,
});
const minuteBar = (date, hhmm, open, tz = true) => ({ date: `${date.replace(/-/g, '')} ${hhmm}:00${tz ? ' US/Eastern' : ''}`, open, high: open, low: open, close: open });

const scenarios = [];
const sc = (name, body) => scenarios.push({ name, ...body });

// ---------------------------------------------------------------- 盘初与当前区间
sc('open_basic', {
  start: et('09:20'), fakes: F(),
  steps: [
    to(et('09:35')), tick(et('09:35')), snap(), files(),
    fake('router.indexPrice', [ok(7731)]), to(et('09:38')), tick(et('09:38')), snap(),
    fake('marks.read', [ok(pair(8, 8, 7730))]), to(et('09:40')), tick(et('09:40')), snap(), files(), db(),
  ],
});
sc('slot_and_today_band', {
  start: et('09:20'), fakes: F({ 'marks.read': [ok(pair(10, 10)), ok(pair(8, 8, 7730)), ok(pair(6, 7, 7735))] }),
  steps: [
    tick(et('09:35')), fake('router.indexPrice', [ok(7731)]), tick(et('09:38')), tick(et('09:40')),
    fake('router.indexPrice', [ok(7737.5)]), tick(et('09:45')), snap(), tick(et('09:44', D0, 59)), tick(et('09:50')), snap(), files(), db(),
  ],
});
sc('anchor_late_then_backfilled', {
  start: et('09:20'),
  fakes: F({
    'router.indexPrice': [ok(7712.3)],
    'session.historicalData|SPX': [ok([minuteBar(D0, '09:35', 7700)])],
    'session.historicalData|*': [ok([minuteBar(D0, '09:35', 15), minuteBar('2026-10-20', '16:10', 11)])],
  }),
  steps: [tick(et('09:35', D0, 20)), snap(), tick(et('09:36')), snap(), files(), db()],
});
sc('anchor_on_time_ten_seconds', {
  start: et('09:20'), fakes: F(),
  steps: [tick(et('09:35', D0, 10)), snap(), tick(et('09:35', D0, 11)), files(), db()],
});
sc('anchor_boundary_ten_seconds_exact_and_over', {
  start: et('09:20'), fakes: F({ 'session.historicalData|SPX': [ok([minuteBar(D0, '09:35', 7701, false)])] }),
  steps: [tick(et('09:35', D0, 10)), snap()],
});
sc('anchor_boundary_eleven_seconds_late', {
  start: et('09:20'),
  fakes: F({ 'session.historicalData|SPX': [ok([minuteBar(D0, '09:35', 7701, false)])], 'session.historicalData|*': [ok([minuteBar(D0, '09:35', 14, false)])] }),
  steps: [tick(et('09:35', D0, 11)), snap(), tick(et('09:36', D0, 0)), snap(), files()],
});
sc('anchor_missing_notes_and_retry_gaps', {
  start: et('09:20'), fakes: F({ 'router.indexPrice': [ok(7790)] }),
  steps: [
    tick(et('10:00')), snap(), tick(et('10:01')), snap(), tick(et('10:09', D0, 59)), tick(et('10:10')), snap(),
    fake('session.historicalData|SPX', [ok([minuteBar(D0, '09:35', 7709.6)])]), tick(et('10:11')), tick(et('10:20')), snap(), files(), db(),
  ],
});
sc('half_quote_anchor_kept_open_backfilled', {
  start: et('09:20'),
  fakes: F({
    'marks.read': [ok([pair(10, 10)[0], { strike: 7720, right: 'P', bid: NaN, ask: NaN, iv: null, error: null }]), ok(pair(10, 10))],
    'session.historicalData|*': [ok([minuteBar(D0, '09:35', 14), minuteBar('2026-10-20', '16:10', 13)])],
  }),
  steps: [
    tick(et('09:35')), files(), fake('router.indexPrice', [ok(7721)]), tick(et('09:35', D0, 10)), snap(), tick(et('09:35', D0, 40)), snap(),
    tick(et('09:36')), snap(), files(), db(),
  ],
});
sc('index_bar_present_option_bar_missing_b2', {
  start: et('09:20'), fakes: F({ 'router.indexPrice': [ok(7790)], 'session.historicalData|SPX': [ok([minuteBar(D0, '09:35', 7709.6)])] }),
  steps: [tick(et('10:00')), snap(), files()],
});
sc('pre_open_reads_only', {
  start: et('09:00'), fakes: F({ 'session.historicalData|*': [ok([minuteBar('2026-10-20', '16:10', 13)])] }),
  steps: [tick(et('09:31')), snap(), tick(et('09:34')), snap(), tick(et('09:29')), snap(), tick(et('09:30')), tick(et('09:34', D0, 59)), files()],
});
sc('spot_equals_prior_close', {
  start: et('09:20'),
  fakes: F({
    'router.indexPrice': [ok(7718.4)],
    'session.historicalData|*': [ok([minuteBar('2026-10-20', '16:10', 11)])],
  }),
  steps: [
    tick(et('09:34')), fake('router.indexPrice', [ok(7701.2)]), tick(et('09:35')), snap(), fake('router.indexPrice', [ok(7702.6)]), tick(et('09:35', D0, 5)), snap(), files(),
  ],
});
sc('spot_unusable_variants', {
  start: et('09:20'),
  fakes: F({
    'router.indexPrice': [ok(null), ok(0), ok(NaN), ok(-5), ok(7718.4), err('plain', '行情没来'), err('rpc', 'TWS 断了', 0, -32017), ok(7718.4)],
    'router.spotInfo': [info(), info(), info(), info(), info('index_stale'), info(), info(), ok(null), { ok: { price: 1, source: 5 } }, { ok: {} }, err('plain', 'spotInfo 炸了'), info('futures'), info()],
  }),
  steps: [
    tick(et('10:00')), snap(), tick(et('10:00', D0, 5)), tick(et('10:00', D0, 10)), tick(et('10:00', D0, 15)), snap(), tick(et('10:00', D0, 20)), snap(),
    tick(et('10:00', D0, 25)), snap(), tick(et('10:00', D0, 30)), snap(), tick(et('10:00', D0, 35)), snap(),
  ],
});
sc('spot_info_odd_shapes', {
  start: et('09:20'),
  fakes: F({ 'router.spotInfo': [ok(null), ok({ price: 1, source: 5 }), ok({}), err('plain', 'spotInfo 炸了'), info('futures'), info()] }),
  steps: [tick(et('10:00')), snap(), tick(et('10:00', D0, 5)), snap(), tick(et('10:00', D0, 10)), snap(), tick(et('10:00', D0, 15)), snap(), tick(et('10:00', D0, 20)), snap(), tick(et('10:00', D0, 25)), snap()],
});
sc('frame_retry_gap_thirty_seconds', {
  start: et('09:20'),
  fakes: F({ 'marks.read': [ok([pair(10, 10)[0], { strike: 7720, right: 'P', bid: NaN, ask: NaN, iv: null, error: null }]), ok(pair(10, 10))] }),
  steps: [tick(et('09:35')), snap(), tick(et('09:35', D0, 10)), snap(), tick(et('09:35', D0, 40)), snap(), files()],
});
sc('marks_variants', {
  start: et('09:20'),
  fakes: F({
    'marks.read': [
      ok([{ strike: 7720, right: 'C', bid: null, ask: null, iv: null, error: '10197 无行情订阅' }, pair(1, 1)[1]]),
      ok([{ strike: 7720, right: 'C', bid: 9, ask: 11, iv: null, error: '354 未订阅' }, pair(10, 10)[1]]),
      ok([{ strike: 7720, right: 'C', bid: null, ask: null, iv: null, error: '' }, pair(10, 10)[1]]),
      ok([pair(10, 10)[0]]), ok([]), err('marks', 'OptionMarksError 超时'), err('plain', '读盘口炸了'), err('rpc', '没权限', 0, -32017),
      ok([{ strike: 7720, right: 'C', bid: 12, ask: 10, iv: null, error: null }, pair(10, 10)[1]]),
      ok([{ strike: 7720, right: 'C', bid: 0, ask: 0, iv: null, error: null }, pair(10, 10)[1]]),
      ok([{ strike: 7720, right: 'C', bid: 0, ask: 0.2, iv: null, error: null }, { strike: 7720, right: 'P', bid: 0, ask: 0.1, iv: null, error: null }]),
      ok(pair(10, 10)),
    ],
  }),
  steps: Array.from({ length: 12 }, (_, i) => [tick(et('09:35') + i * 300_000), snap()]).flat().concat([files()]),
});
sc('not_ibkr_session_accounts', {
  start: et('09:20'),
  fakes: F({ 'session.managed': [ok(['U1234567']), ok([]), ok(['DU1', 'U2']), ok(['DU7654321', 'DU2']), err('plain', 'managed 炸了')] }),
  steps: [
    tick(et('09:35')), tick(et('09:35', D0, 31)), tick(et('09:36', D0, 1)), tick(et('09:36', D0, 32)), tick(et('09:37', D0, 3)), snap(), files(),
  ],
});
sc('no_session_throws_in_live_band', {
  start: et('09:20'), fakes: F({ 'session.historicalData|*': [ok([minuteBar('2026-10-20', '16:10', 13)])] }),
  steps: [
    tick(et('09:34')), { op: 'router', set: { noSession: true } }, tick(et('09:35')), snap(), { op: 'router', set: { noSession: false } }, tick(et('09:35', D0, 40)), snap(), files(),
  ],
});

// ---------------------------------------------------------------- 期权墙与加速档
sc('wall_ok_spans_and_window', {
  start: et('09:20'),
  fakes: F({ 'router.indexPrice': [ok(7718.4), ok(7790), ok(7650)], 'session.historicalData|*': [ok([minuteBar('2026-10-20', '16:10', 13)])] }),
  steps: [tick(et('09:34')), tick(et('09:35')), snap(), tick(et('09:40')), snap(), tick(et('09:45')), snap(), files()],
});
sc('wall_errors_keep_previous', {
  start: et('09:20'),
  fakes: F({
    'market.wallFor|SPX': [ok(W7720), err('rpc', '期权链取不到(没有行情权限)', 0, -32017), err('plain', '长'.repeat(200)), ok(null), ok(W7720)],
    'marks.read': [ok(pair(10, 10))],
  }),
  steps: [tick(et('09:35')), snap(), tick(et('09:40')), snap(), tick(et('09:45')), snap(), tick(et('09:50')), snap(), tick(et('09:55')), snap(), files()],
});
sc('accel_cross_and_rearm', {
  start: et('09:20'),
  fakes: F({
    'market.wallFor|SPX': [ok(handWall([[7700, 5e6], [7710, -4e6], [7715, -9e6], [7720, 3e6], [7725, -2e6], [7730, 8e6], [7760, -9e9]]))],
    'router.indexPrice': [ok(7718.4), ok(7714), ok(7716.9), ok(7715), ok(7712), ok(7718), ok(7720), ok(7714.9)],
  }),
  steps: [tick(et('09:35')), snap(), tick(et('09:36')), tick(et('09:37')), tick(et('09:38')), tick(et('09:39')), tick(et('09:44')), tick(et('09:45')), tick(et('09:51')), snap(), files()],
});
sc('wall_rows_odd_net_gex', {
  start: et('09:20'),
  fakes: F({ 'market.wallFor|SPX': [ok({ ...W7720, strikes: [{ strike: 7715, net_gex: null }, { strike: 7720 }, { strike: 7725, net_gex: -1 }, { strike: 7710, net_gex: 0 }] })] }),
  steps: [tick(et('09:35')), snap()],
});

// ---------------------------------------------------------------- 昨日区间
const PRIOR_FAKES = (extra = {}) => F({
  'router.historicalBars|2026-10-21': [ok([{ date: '2026-10-21', close: 7733.3 }])],
  'marks.read': [ok(pair(12, 11, 7735))],
  ...extra,
});
sc('prior_capture_basic', {
  start: et('16:00'), fakes: PRIOR_FAKES(),
  steps: [
    tick(et('16:09')), snap(), tick(et('16:10')), snap(), files(), tick(et('16:10', D0, 20)), tick(et('16:14', D0, 59)), tick(et('16:15')), tick(et('16:30')),
    fake('router.indexPrice', [ok(7740)]), { op: 'settings', patch: { market_holidays: ['2026-09-07'] } },
    to(et('09:34', '2026-10-22')), tick(et('09:34', '2026-10-22')), snap(), files(),
  ],
});
sc('prior_capture_friday_to_monday', {
  start: et('16:00', '2026-10-23'),
  fakes: PRIOR_FAKES({ 'router.historicalBars|2026-10-23': [ok([{ date: '2026-10-23', close: 7750.5 }])] }),
  steps: [tick(et('16:10', '2026-10-23')), files(), tick(et('16:12', '2026-10-23')), files({ namesOnly: true })],
});
sc('prior_capture_across_dst', {
  start: et('16:00', '2026-10-30'),
  fakes: PRIOR_FAKES({ 'router.historicalBars|2026-10-30': [ok([{ date: '2026-10-30', close: 7750.5 }])] }),
  steps: [tick(et('16:10', '2026-10-30')), files(), tick(et('16:10', '2026-11-02')), tick(et('16:10', '2026-11-02')), snap()],
});
sc('prior_capture_early_close_and_holiday', {
  start: et('13:00', '2026-11-25'),
  settings: { early_close_days: ['2026-11-27'], market_holidays: ['2026-09-07', '2026-11-26'] },
  fakes: PRIOR_FAKES({
    'router.historicalBars|2026-11-25': [ok([{ date: '2026-11-25', close: 7700 }])],
    'router.historicalBars|2026-11-27': [ok([{ date: '2026-11-27', close: 7710 }])],
  }),
  steps: [
    tick(et('16:10', '2026-11-25')), files(), tick(et('13:10', '2026-11-27')), tick(et('16:10', '2026-11-27')), files(),
    tick(et('13:09', '2026-11-27')), tick(et('13:15', '2026-11-27')), snap(),
  ],
});
sc('prior_capture_failures_and_retry', {
  start: et('16:00'),
  fakes: PRIOR_FAKES({
    'router.historicalBars|2026-10-21': [ok([]), ok([{ date: '2026-10-21', close: 0 }]), ok([{ date: '2026-10-20', close: 7700 }]), ok([{ date: '2026-10-21', close: '7733.3' }]), ok([{ date: '2026-10-21', close: 7733.3 }])],
    'marks.read': [ok([{ strike: 7735, right: 'C', bid: null, ask: null, iv: null, error: '10197 x' }, pair(1, 1)[1]]), ok([pair(1, 1)[0]]), ok(pair(12, 11, 7735))],
  }),
  steps: [
    tick(et('16:10')), snap(), tick(et('16:10', D0, 10)), tick(et('16:10', D0, 31)), tick(et('16:11', D0, 2)), tick(et('16:11', D0, 33)), tick(et('16:12', D0, 4)),
    tick(et('16:12', D0, 35)), tick(et('16:13', D0, 6)), snap(), files(), db(),
  ],
});
sc('prior_capture_session_missing_and_errors', {
  start: et('16:00'),
  fakes: PRIOR_FAKES({ 'router.historicalBars|2026-10-21': [err('plain', '日线限速'), ok([{ date: '2026-10-21', close: 7733.3 }])], 'marks.read': [err('marks', '读盘口超时'), ok(pair(12, 11, 7735))] }),
  steps: [
    tick(et('16:10')), snap(), tick(et('16:10', D0, 31)), snap(), { op: 'router', set: { noSession: true } }, tick(et('16:11', D0, 2)), snap(),
    { op: 'router', set: { noSession: false } }, tick(et('16:11', D0, 33)), snap(), files(),
  ],
});
sc('prior_capture_already_in_log', {
  start: et('16:00'), fakes: PRIOR_FAKES(),
  steps: [
    logwrite('2026-10-22', [{ kind: 'prior', band: bandOf(et('16:10'), 7733.3, 12, 11, '20261022') }]),
    tick(et('16:10')), tick(et('16:10', D0, 40)), files(),
  ],
});
sc('prior_capture_prune_over_limit', {
  start: et('16:00'), fakes: PRIOR_FAKES(),
  steps: [
    { op: 'logwrite', dates: Array.from({ length: 405 }, (_, i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10)).filter((d) => d < '2026-10-21'), lines: ['x'] },
    tick(et('16:10')), files({ namesOnly: true }),
  ],
});
sc('prior_capture_existing_file_not_prior_prunes_nothing', {
  start: et('16:00'), fakes: PRIOR_FAKES(),
  steps: [logwrite('2026-10-22', [{ kind: 'frame', band: bandOf(et('09:40'), 7730, 9, 9, '20261022') }]), tick(et('16:10')), files()],
});
sc('prior_capture_no_next_day', {
  start: et('16:00'),
  settings: { market_holidays: Array.from({ length: 16 }, (_, i) => new Date(Date.UTC(2026, 9, 22 + i)).toISOString().slice(0, 10)) },
  fakes: PRIOR_FAKES(),
  steps: [tick(et('16:10')), snap(), files()],
});

// ---------------------------------------------------------------- 没赶上的补
const MIN_PRIOR = (extra = {}) => F({ 'session.historicalData|*': [ok([minuteBar('2026-10-20', '16:10', 11), minuteBar(D0, '09:35', 14)])], ...extra });
sc('backfill_prior_ok', {
  start: et('09:20'), fakes: MIN_PRIOR(),
  steps: [tick(et('09:34')), snap(), tick(et('09:35')), files(), db()],
});
sc('backfill_prior_utc_end_and_contracts_logged', {
  start: et('09:20'),
  fakes: MIN_PRIOR({ 'session.qualify': [ok(true), ok(777777)] }),
  steps: [tick(et('09:34'))],
});
sc('backfill_prior_no_close_then_retry_after_ten_minutes', {
  start: et('09:20'), fakes: F({ 'router.historicalBars|2026-10-20': [ok([]), ok([{ date: '2026-10-20', close: 7701.2 }])], 'session.historicalData|*': [ok([minuteBar('2026-10-20', '16:10', 11)])] }),
  steps: [tick(et('09:34')), snap(), tick(et('09:40')), tick(et('09:43', D0, 59)), tick(et('09:44')), snap(), files()],
});
sc('backfill_prior_minute_missing_call_or_put', {
  start: et('09:20'),
  fakes: F({ 'session.historicalData|*': [ok([minuteBar('2026-10-20', '16:10', 11)]), ok([]), ok([minuteBar('2026-10-20', '16:11', 11)]), ok([minuteBar('2026-10-20', '16:10', 0)])] }),
  steps: [tick(et('09:34')), snap(), tick(et('09:44')), snap(), tick(et('09:54')), snap()],
});
sc('backfill_prior_errors', {
  start: et('09:20'),
  fakes: F({
    'router.historicalBars|2026-10-20': [err('plain', '日线炸了'), ok([{ date: '2026-10-20', close: 7701.2 }])],
    'session.historicalData|*': [err('plain', '历史限速'.repeat(50)), ok([minuteBar('2026-10-20', '16:10', 11)])],
    'session.qualify': [ok(true), ok(true), err('plain', 'timeout'), ok(false), ok(true)],
  }),
  steps: [tick(et('09:34')), snap(), tick(et('09:44')), snap(), tick(et('09:54')), snap(), tick(et('10:04')), snap(), tick(et('10:14')), snap(), files()],
});
sc('backfill_prior_qualify_variants', {
  start: et('09:20'),
  fakes: F({ 'session.qualify': [ok(false), ok(null), ok(5), ok(true)], 'session.historicalData|*': [ok([minuteBar('2026-10-20', '16:10', 11)])] }),
  steps: [tick(et('09:34')), tick(et('09:44')), tick(et('09:54')), tick(et('10:04')), snap()],
});
sc('backfill_prior_after_early_close', {
  start: et('09:20', '2026-11-30'),
  settings: { early_close_days: ['2026-11-27'] },
  fakes: F({
    'router.historicalBars|2026-11-27': [ok([{ date: '2026-11-27', close: 7710 }])],
    'session.historicalData|*': [ok([minuteBar('2026-11-27', '13:10', 12), minuteBar('2026-11-27', '16:10', 99)])],
  }),
  steps: [tick(et('09:34', '2026-11-30')), snap(), files()],
});
sc('backfill_prior_no_prev_trading_day', {
  start: et('09:20'),
  settings: { market_holidays: Array.from({ length: 16 }, (_, i) => new Date(Date.UTC(2026, 9, 4 + i)).toISOString().slice(0, 10)).filter((d) => d !== D0) },
  fakes: F(),
  steps: [tick(et('09:34')), snap(), tick(et('09:44')), snap()],
});
sc('backfill_prior_monday_looks_at_friday', {
  start: et('09:20', '2026-10-26'),
  fakes: F({ 'router.historicalBars|2026-10-23': [ok([{ date: '2026-10-23', close: 7750.5 }])], 'session.historicalData|*': [ok([minuteBar('2026-10-23', '16:10', 12)])] }),
  steps: [tick(et('09:34', '2026-10-26')), snap(), files()],
});
sc('backfill_open_only_when_anchor_exists', {
  start: et('09:20'), fakes: F({ 'router.indexPrice': [ok(7712.3)], 'session.historicalData|*': [ok([minuteBar(D0, '09:35', 14)])] }),
  steps: [tick(et('09:36')), snap(), tick(et('09:37')), snap(), tick(et('09:47')), snap()],
});

// ---------------------------------------------------------------- 状态与事件
const PRIOR_7700 = bandOf(et('16:10', '2026-10-20'), 7700, 10, 10, '20261021'); // 下沿 7674.93
const priorLog = [{ kind: 'prior', band: PRIOR_7700 }];
sc('machine_b3_enter_invalid_quiet', {
  start: et('09:20'),
  fakes: F({
    'router.indexPrice': [ok(7705), ok(7680), ok(7674), ok(7673), ok(7690), ok(7670), ok(7690), ok(7690), ok(7660), ok(7690)],
  }),
  steps: [
    logwrite(D0, priorLog), tick(et('09:35')), snap(), tick(et('09:36')), tick(et('09:36', D0, 5)), snap(), tick(et('09:37')), tick(et('09:38')), snap(),
    tick(et('09:39')), snap(), tick(et('09:45')), tick(et('09:46')), tick(et('09:47')), snap(), tick(et('09:52')), files(), db(),
  ],
});
sc('machine_b2_frames_invalid_rearm', {
  start: et('09:20'),
  fakes: F({
    'marks.read': [ok(pair(10, 10)), ok(pair(6, 6)), ok(pair(6, 6)), ok(pair(6, 6)), ok(pair(6, 6)), ok(pair(6, 6)), ok(pair(6, 6))],
    'router.indexPrice': [ok(7705), ok(7721), ok(7719), ok(7715), ok(7716), ok(7719), ok(7740), ok(7722), ok(7714), ok(7740)],
  }),
  steps: [
    logwrite(D0, priorLog), tick(et('09:35')), tick(et('09:40')), snap(), tick(et('09:41')), tick(et('09:45')), snap(), tick(et('09:50')), snap(),
    tick(et('09:51')), tick(et('09:55')), snap(), tick(et('10:00')), tick(et('10:05')), snap(), tick(et('10:10')), snap(), files(), db(),
  ],
});
sc('machine_b3_overrides_b2_and_targets', {
  start: et('09:20'),
  fakes: F({
    'market.wallFor|SPX': [ok(handWall([[7650, 1e6], [7660, 2e6], [7670, -1e6], [7680, 3e6], [7740, 4e6], [7750, -2e6]]))],
    'router.indexPrice': [ok(7705), ok(7740), ok(7660), ok(7665), ok(7640)],
  }),
  steps: [logwrite(D0, priorLog), tick(et('09:35')), tick(et('09:40')), snap(), tick(et('09:45')), snap(), tick(et('09:50')), snap(), tick(et('09:55')), snap(), files()],
});
sc('machine_restart_resumes', {
  start: et('09:20'),
  fakes: F({
    'marks.read': [ok(pair(10, 10)), ok(pair(6, 6)), ok(pair(6, 6)), ok(pair(6, 6)), ok(pair(6, 6)), ok(pair(6, 6))],
    'router.indexPrice': [ok(7705), ok(7721), ok(7722), ok(7714), ok(7715), ok(7740), ok(7741)],
  }),
  steps: [
    logwrite(D0, priorLog), tick(et('09:35')), tick(et('09:40')), snap(), { op: 'restart' }, snap(), tick(et('09:41')), tick(et('09:45')), snap(),
    { op: 'restart' }, tick(et('09:46')), snap(), tick(et('09:50')), { op: 'restart' }, snap(), tick(et('09:55')), { op: 'restart' }, tick(et('10:00')), snap(), files(),
  ],
});
sc('log_old_formats_and_corruption', {
  start: et('10:30'),
  fakes: F({ 'router.indexPrice': [ok(7730)] }),
  steps: [
    logwrite(D0, [
      { kind: 'open', band: { ...bandOf(et('09:35'), 7710, 10, 10, '20261021'), extra: 1 } },
      { kind: 'frame', band: bandOf(et('10:00'), 7712, 9, 9, '20261021') },
      { kind: 'frame', band: bandOf(et('10:05'), 7714, 8, 8, '20261021') },
      '{"kind":"anchor","anchor":{"at":1,"price":-5,"source":"live"}}',
      '{"kind":"nonsense"}', 'not json', '', '   ', '{"kind":"frame","band":{"at":1}}',
      { kind: 'event', event: { at: et('10:01'), kind: 'enter', state: 'B2', level: 7730.5, price: 7731, extra: 'x' } },
      { kind: 'event', event: { at: et('10:02'), kind: 'accel', state: 'B2', level: 7720, price: 7721 } },
      { kind: 'machine', machine: { at: et('10:03'), state: 'B2', trigger: 7730.5, since: et('10:01'), lost: null } },
      { kind: 'prior', band: bandOf(et('16:10', '2026-10-20'), 7690, 10, 10, '20261021', 'backfill') },
    ]),
    snap(), tick(et('10:30')), snap(), files(),
  ],
});
sc('log_machine_mark_older_than_events', {
  start: et('10:30'), fakes: F(),
  steps: [
    logwrite(D0, [
      { kind: 'machine', machine: { at: et('10:00'), state: 'R', trigger: null, since: et('10:00'), lost: null } },
      { kind: 'event', event: { at: et('10:01'), kind: 'enter', state: 'B3', level: 7674.9, price: 7674 } },
      { kind: 'event', event: { at: et('10:02'), kind: 'invalid', state: 'B2', level: 7731, price: 7729 } },
    ]),
    snap(),
  ],
});
sc('log_events_over_fifty_and_no_mark', {
  start: et('12:30'), fakes: F(),
  steps: [
    logwrite(D0, Array.from({ length: 60 }, (_, i) => ({ kind: 'event', event: { at: et('10:00') + i * 400_000, kind: i % 3 === 0 ? 'accel' : i % 2 ? 'enter' : 'invalid', state: i % 2 ? 'B2' : 'B3', level: 7700 + i, price: 7701 + i } }))),
    snap(),
  ],
});
sc('log_event_only_invalid_b2_lost', {
  start: et('10:30'), fakes: F(),
  steps: [logwrite(D0, [{ kind: 'event', event: { at: et('10:02'), kind: 'invalid', state: 'B2', level: 7731.5, price: 7729 } }]), snap()],
});
sc('log_anchor_from_open_when_missing', {
  start: et('10:30'), fakes: F(),
  steps: [logwrite(D0, [{ kind: 'open', band: bandOf(et('09:35'), 7710, 10, 10, '20261021', 'backfill') }, { kind: 'frame', band: bandOf(et('10:00'), 7712, 9, 9, '20261021') }]), snap()],
});
sc('log_other_day_ignored_and_clock_day_switch', {
  start: et('10:30'), fakes: F(),
  steps: [
    logwrite('2026-10-20', [{ kind: 'frame', band: bandOf(et('10:00', '2026-10-20'), 7700, 9, 9, '20261020') }]),
    logwrite('2026-10-22', [{ kind: 'frame', band: bandOf(et('10:00', '2026-10-22'), 7800, 9, 9, '20261022') }]),
    snap(), to(et('10:00', '2026-10-22')), snap(), to(et('10:00', '2026-10-20') + 6 * 86_400_000), snap(),
  ],
});
sc('tick_for_other_day_while_clock_moves', {
  start: et('09:20'), fakes: F({ 'router.historicalBars|2026-10-21': [ok([{ date: '2026-10-21', close: 7733.3 }])] }),
  steps: [
    tick(et('09:35')), snap(), tick(et('09:40', '2026-10-22')), snap(), tick(et('09:41')), snap(), to(et('09:50', '2026-10-22')), snap(), tick(et('09:45')), snap(), files(),
  ],
});

// ---------------------------------------------------------------- 什么时候不动
sc('gates_all_reasons', {
  start: et('09:20'), fakes: F(),
  steps: [
    { op: 'router', set: { on: false } }, tick(et('10:00')), snap(),
    { op: 'router', set: { on: true, sessions: false } }, tick(et('10:00')), snap(),
    { op: 'router', set: { sessions: true } }, { op: 'settings', patch: FUTU }, tick(et('10:00')), snap(),
    { op: 'settings', patch: {} }, tick(et('10:00', '2026-10-24')), snap(), tick(et('10:00', '2026-10-25')), snap(),
    { op: 'settings', patch: { market_holidays: ['2026-09-07', D0] } }, tick(et('10:00')), snap(),
    { op: 'settings', patch: {} }, tick(et('09:29')), snap(), tick(et('16:00')), snap(), tick(et('16:05')), snap(), tick(et('20:00')), snap(),
    tick(et('08:00')), snap(), files({ namesOnly: true }),
  ],
});
sc('gates_no_index_config', {
  start: et('09:20'), base: { ...BASE_CONFIG, index_symbols: { VIX: BASE_CONFIG.index_symbols.VIX } }, fakes: F(),
  steps: [tick(et('10:00')), snap(), tick(et('16:10'))],
});
sc('trading_class_and_exchange_from_config', {
  start: et('09:20'),
  base: { ...BASE_CONFIG, index_symbols: { SPX: { exchange: 'CBOE', daily_trading_class: '', monthly_trading_class: 'SPX', futures: 'ES', futures_exchange: 'CME' } } },
  fakes: F({ 'session.historicalData|*': [ok([minuteBar('2026-10-20', '16:10', 11)])] }),
  steps: [tick(et('09:34')), tick(et('09:35'))],
});
sc('early_close_day_session_window', {
  start: et('12:00', '2026-11-27'), settings: { early_close_days: ['2026-11-27'] },
  fakes: F({ 'router.historicalBars|2026-11-27': [ok([{ date: '2026-11-27', close: 7710 }])] }),
  steps: [tick(et('12:59', '2026-11-27')), tick(et('13:00', '2026-11-27')), tick(et('13:09', '2026-11-27', 59)), tick(et('13:10', '2026-11-27')), tick(et('13:14', '2026-11-27', 59)), tick(et('13:15', '2026-11-27')), files()],
});
sc('enable_switch_and_pref_shapes', {
  start: et('09:20'), fakes: F(),
  steps: [
    call('enabled'), call('setEnabled', [false]), call('enabled'), tick(et('09:35')), snap(), call('setEnabled', [true]), tick(et('09:35')), call('enabled'),
    setPref({ enabled: 'false' }), call('enabled'), setPref({ enabled: 0 }), call('enabled'), setPref({}), call('enabled'), setPref(5), call('enabled'), setPref('abc'), call('enabled'),
    setPref(null), call('enabled'), setPref(false), call('enabled'), setPref([]), call('enabled'), setPref({ enabled: false, other: 1 }), call('enabled'), snap(),
    rawExec("UPDATE app_prefs SET value='{not json' WHERE key='playbook'"), call('enabled'), tick(et('09:36')), snap(),
    rawExec('DROP TABLE app_prefs'), call('enabled'), call('setEnabled', [false]), tick(et('09:37')), snap(), db(),
  ],
});
sc('tick_error_recovery', {
  start: et('09:20'),
  fakes: F({ 'router.indexPrice': [err('plain', '行情炸了'), ok(7718.4)] }),
  steps: [tick(et('09:35')), snap(), tick(et('09:35', D0, 5)), snap(), files()],
});
sc('log_write_fails_eacces', {
  start: et('09:20'), fakes: F(),
  steps: [
    logwrite('2026-10-19', ['x']), { op: 'chmod', path: 'playbook', mode: 0o500 }, tick(et('09:35')), snap(), { op: 'chmod', path: 'playbook', mode: 0o700 }, tick(et('09:35', D0, 31)), snap(), files(),
  ],
});

sc('tick_invalid_time_values', {
  start: et('09:20'), fakes: F(),
  steps: [tick(NaN), snap(), tick(Infinity), tick(-Infinity), tick(8.64e15 + 1), tick(et('09:35')), snap()],
});

// ---------------------------------------------------------------- 变异检验补的场景(边界、循环次数、截断长度、重复事件、call/put 区分)
const weekdaysBetween = (from, to) => {
  const out = [];
  for (let ms = Date.parse(`${from}T12:00:00Z`); ms <= Date.parse(`${to}T12:00:00Z`); ms += 86_400_000) {
    const d = new Date(ms);
    if (![0, 6].includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
  }
  return out;
};
sc('prior_capture_window_end_exact', {
  start: et('16:00'), fakes: PRIOR_FAKES(),
  steps: [tick(et('16:15')), tick(et('16:15', D0, 30)), snap(), files({ namesOnly: true })],
});
sc('frame_retry_exact_boundary', {
  start: et('09:20'),
  fakes: F({ 'marks.read': [ok([pair(10, 10)[0], { strike: 7720, right: 'P', bid: NaN, ask: NaN, iv: null, error: null }]), ok(pair(10, 10))] }),
  steps: [tick(et('09:35')), tick(et('09:35') + 29_500), snap(), tick(et('09:35') + 30_000), snap(), files()],
});
sc('spot_fraction_below_one', {
  start: et('09:20'), fakes: F({ 'router.indexPrice': [ok(0.5)] }),
  steps: [tick(et('09:35')), snap(), tick(et('10:00')), snap()],
});
const NEXT_HOL = (until) => ({ market_holidays: ['2026-09-07', ...weekdaysBetween('2026-10-22', until)] });
sc('next_trading_day_exactly_fourteen_ahead', {
  start: et('16:00'), settings: NEXT_HOL('2026-11-03'), fakes: PRIOR_FAKES(),
  steps: [tick(et('16:10')), files({ namesOnly: true }), files()],
});
sc('next_trading_day_fifteen_ahead_is_too_far', {
  start: et('16:00'), settings: NEXT_HOL('2026-11-04'), fakes: PRIOR_FAKES(),
  steps: [tick(et('16:10')), files({ namesOnly: true }), snap()],
});
const PREV_HOL = (from) => ({ market_holidays: ['2026-09-07', ...weekdaysBetween(from, '2026-10-20')] });
sc('prev_trading_day_exactly_fourteen_back', {
  start: et('09:20'), settings: PREV_HOL('2026-10-08'),
  fakes: F({ 'router.historicalBars|2026-10-07': [ok([{ date: '2026-10-07', close: 7650.5 }])], 'session.historicalData|*': [ok([minuteBar('2026-10-07', '16:10', 12)])] }),
  steps: [tick(et('09:34')), snap(), files()],
});
sc('prev_trading_day_fifteen_back_is_too_far', {
  start: et('09:20'), settings: PREV_HOL('2026-10-07'),
  fakes: F({ 'router.historicalBars|2026-10-06': [ok([{ date: '2026-10-06', close: 7650.5 }])], 'session.historicalData|*': [ok([minuteBar('2026-10-06', '16:10', 12)])] }),
  steps: [tick(et('09:34')), snap()],
});
sc('last_error_truncated_to_two_hundred', {
  start: et('09:20'), fakes: F({ 'router.indexPrice': [err('plain', `${'错'.repeat(100)}${'e'.repeat(150)}`)] }),
  steps: [tick(et('10:00')), snap()],
});
sc('loop_stop_right_after_first_timer', {
  start: et('09:35'), fakes: F(),
  steps: [call('start'), call('stop'), snap()],
});
sc('log_duplicate_events_restore_uses_latest_for_quiet', {
  start: et('10:10'),
  fakes: F({ 'router.indexPrice': [ok(7690), ok(7670)] }),
  steps: [
    logwrite(D0, [
      { kind: 'prior', band: PRIOR_7700 },
      { kind: 'event', event: { at: et('10:00'), kind: 'enter', state: 'B3', level: PRIOR_7700.lower, price: 7670 } },
      { kind: 'event', event: { at: et('10:08'), kind: 'enter', state: 'B3', level: PRIOR_7700.lower, price: 7669 } },
    ]),
    tick(et('10:10')), snap(), tick(et('10:11')), snap(), files(),
  ],
});
sc('backfill_call_put_distinct_values', {
  start: et('09:20'),
  fakes: F({
    'session.historicalData|20261021 7700C': [ok([minuteBar('2026-10-20', '16:10', 11)])],
    'session.historicalData|20261021 7700P': [ok([minuteBar('2026-10-20', '16:10', 13)])],
    'session.historicalData|SPX': [ok([minuteBar(D0, '09:35', 7712, false)])],
    'session.historicalData|20261021 7710C': [ok([minuteBar(D0, '09:35', 15, false)])],
    'session.historicalData|20261021 7710P': [ok([minuteBar(D0, '09:35', 17, false)])],
  }),
  steps: [tick(et('09:34')), snap(), fake('router.indexPrice', [ok(7712.3)]), tick(et('09:36')), snap(), files()],
});
sc('backfill_anchor_errors', {
  start: et('09:20'),
  fakes: F({ 'router.indexPrice': [ok(7712.3)], 'session.historicalData|SPX': [err('plain', `${'锚'.repeat(60)}${'x'.repeat(90)}`)] }),
  steps: [tick(et('09:36')), snap(), { op: 'router', set: { noSession: true } }, tick(et('09:47')), snap()],
});
sc('db_path_with_double_slash', {
  start: et('09:20'), dbPath: '//t.db', fakes: F(),
  steps: [tick(et('09:35')), snap(), files()],
});

// ---------------------------------------------------------------- 循环与并发
sc('loop_start_stop', {
  start: et('09:30'), fakes: F({ 'router.indexPrice': [ok(7718.4), ok(7719), ok(7720)] }),
  steps: [
    to(et('09:35')), call('start'), call('start'), snap(), adv(5000), adv(5000), adv(12_000), snap(), call('stop'), call('stop'), snap(), adv(30_000),
    call('start', [1000]), adv(3500), call('stop'), files(),
  ],
});
sc('loop_stop_during_inflight_tick_then_restart_loop', {
  start: et('09:30'),
  fakes: F({ 'marks.read': [ok(pair(10, 10), 400)], 'router.indexPrice': [ok(7718.4, 100)], 'market.wallFor|SPX': [ok(W7720, 300)] }),
  steps: [
    to(et('09:35')), call('start', [200]), adv(250), call('stop'), adv(300), call('start', [200]), adv(1000), call('stop'), adv(2000), snap(), files(),
  ],
});
sc('loop_with_disabled_and_gates', {
  start: et('09:30'), fakes: F(),
  steps: [
    to(et('09:35')), call('start', [5000]), call('setEnabled', [false]), adv(11_000), snap(), call('setEnabled', [true]), adv(6000), { op: 'router', set: { on: false } }, adv(5000),
    { op: 'router', set: { on: true } }, adv(5000), call('stop'), snap(),
  ],
});
sc('loop_start_zero_ms', {
  start: et('09:35'), fakes: F(),
  steps: [call('start', [0]), adv(5), call('stop'), snap()],
});
sc('concurrent_ticks_chain', {
  start: et('09:20'),
  fakes: F({ 'marks.read': [ok(pair(10, 10), 200), ok(pair(8, 8), 100)], 'router.indexPrice': [ok(7718.4, 50), ok(7731, 70), ok(7733, 10)], 'market.wallFor|SPX': [ok(W7720, 120)] }),
  steps: [
    call('tickOnce', [et('09:35')], { id: 'a', start: true }), call('tickOnce', [et('09:40')], { id: 'b', start: true }), call('tickOnce', [et('09:45')], { id: 'c', start: true }),
    adv(30), snap(), { op: 'await', id: 'c' }, { op: 'await', id: 'a' }, { op: 'await', id: 'b' }, snap(), files(),
  ],
});
sc('concurrent_tick_and_loop', {
  start: et('09:30'),
  fakes: F({ 'marks.read': [ok(pair(10, 10), 300)], 'router.indexPrice': [ok(7718.4, 200)] }),
  steps: [
    to(et('09:35')), call('start', [1000]), adv(1000), call('tickOnce', [et('09:36')], { id: 'a', start: true }), call('tickOnce', [], { id: 'b', start: true }), adv(100),
    call('stop'), { op: 'await', id: 'a' }, { op: 'await', id: 'b' }, adv(5000), snap(), files(),
  ],
});
sc('tick_error_in_chain_does_not_block_next', {
  start: et('09:20'),
  fakes: F({ 'router.indexPrice': [err('plain', '炸了', 50), ok(7718.4, 10)] }),
  steps: [
    call('tickOnce', [et('09:35')], { id: 'a', start: true }), call('tickOnce', [et('09:35', D0, 5)], { id: 'b', start: true }), adv(0), { op: 'await', id: 'a' }, { op: 'await', id: 'b' }, snap(),
  ],
});
sc('tick_default_now_uses_clock', {
  start: et('09:34', D0, 58), fakes: F(),
  steps: [adv(2000), call('tickOnce', []), call('tickOnce', [null]), adv(300_000), call('tickOnce'), snap(), files()],
});

// ---------------------------------------------------------------- 随机交错
const BLOCKS = [
  ['2026-10-20', '2026-10-21'],
  ['2026-10-23', '2026-10-24', '2026-10-26'],
  ['2026-10-30', '2026-11-02'],
  ['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-30'],
  ['2026-10-21', '2026-10-22', '2026-10-23'],
];
const prevWeekday = (d) => { let ms = Date.parse(`${d}T12:00:00Z`); do { ms -= 86_400_000; } while ([0, 6].includes(new Date(ms).getUTCDay())); return new Date(ms).toISOString().slice(0, 10); };
const nextWeekday = (d) => { let ms = Date.parse(`${d}T12:00:00Z`); do { ms += 86_400_000; } while ([0, 6].includes(new Date(ms).getUTCDay())); return new Date(ms).toISOString().slice(0, 10); };

async function randomScenario(seed) {
  const r = rng(seed * 7919 + 13);
  const block = BLOCKS[(seed - 1) % BLOCKS.length];
  const settings = {};
  if (block.includes('2026-10-22') && seed % 2 === 0) settings.market_holidays = ['2026-09-07', '2026-10-22'];
  if (block.includes('2026-10-23') && seed % 2 === 1) settings.early_close_days = ['2026-11-27', '2026-10-23'];
  const early = new Set(settings.early_close_days ?? ['2026-11-27']);
  const base0 = 7700 + r.int(40);
  const dates = [...new Set([prevWeekday(block[0]), ...block, nextWeekday(block[block.length - 1])])];
  const fakes = {};
  // 日线收盘
  for (const d of dates) {
    const close = Math.round((base0 + (r.next() - 0.5) * 60) * 100) / 100;
    const row = { date: d, close };
    const list = [];
    for (let i = 0; i < 3; i += 1) {
      const x = r.next();
      if (x < 0.08) list.push(ok([]));
      else if (x < 0.12) list.push(ok([{ date: prevWeekday(d), close }]));
      else if (x < 0.16) list.push(ok([{ ...row, close: String(close) }]));
      else if (x < 0.19) list.push(ok([{ ...row, close: r.chance(0.5) ? 0 : null }]));
      else if (x < 0.22) list.push(err('plain', '日线限速'));
      else list.push(ok([row]));
    }
    fakes[`router.historicalBars|${d}`] = list;
  }
  // 现价与 spotInfo
  let px = base0;
  const prices = [];
  for (let i = 0; i < 130; i += 1) {
    px += (r.next() - 0.5) * 9;
    if (r.chance(0.04)) px += (r.chance(0.5) ? 1 : -1) * (20 + r.int(50));
    px = Math.min(Math.max(px, base0 - 90), base0 + 90);
    const x = r.next();
    const d = r.chance(0.1) ? 1 + r.int(200) : undefined;
    const rounded = Math.round(px * 100) / 100;
    if (x < 0.03) prices.push(ok(null, d));
    else if (x < 0.05) prices.push(ok(0, d));
    else if (x < 0.06) prices.push(ok(NaN, d));
    else if (x < 0.075) prices.push(err('plain', '行情没来', d));
    else prices.push(ok(rounded, d));
  }
  fakes['router.indexPrice'] = prices;
  fakes['router.spotInfo'] = Array.from({ length: 130 }, () => {
    const x = r.next();
    if (x < 0.88) return info();
    if (x < 0.94) return info('index_stale');
    if (x < 0.96) return info('futures');
    if (x < 0.98) return ok(null);
    return err('plain', 'spotInfo 炸了');
  });
  // 盘口
  fakes['marks.read'] = Array.from({ length: 70 }, () => {
    const x = r.next();
    const d = r.chance(0.15) ? 1 + r.int(300) : undefined;
    const c = Math.round((4 + r.next() * 12) * 10) / 10, p = Math.round((4 + r.next() * 12) * 10) / 10;
    if (x < 0.72) return ok(pair(c, p, 7720), d);
    if (x < 0.78) return ok([pair(c, p)[0], { strike: 7720, right: 'P', bid: NaN, ask: NaN, iv: null, error: null }], d);
    if (x < 0.82) return ok([pair(c, p)[0]], d);
    if (x < 0.86) return ok([], d);
    if (x < 0.90) return ok([{ strike: 7720, right: 'C', bid: null, ask: null, iv: null, error: '10197 No market data' }, pair(c, p)[1]], d);
    if (x < 0.92) return ok([{ strike: 7720, right: 'C', bid: c + 1, ask: c, iv: null, error: null }, pair(c, p)[1]], d);
    if (x < 0.94) return ok([{ strike: 7720, right: 'C', bid: 3, ask: 4, iv: null, error: '354 x' }, pair(c, p)[1]], d);
    if (x < 0.97) return err('marks', '读盘口超时', d);
    return err('plain', '读盘口炸了', d);
  });
  // 期权墙
  const pool = [];
  for (let i = 0; i < 4; i += 1) pool.push(await wall(base0 - 20 + i * 15, seed * 10 + i, { half: 2 + r.int(2) }));
  fakes['market.wallFor|SPX'] = Array.from({ length: 50 }, () => {
    const x = r.next();
    const d = r.chance(0.15) ? 1 + r.int(250) : undefined;
    if (x < 0.78) return ok(pool[r.int(pool.length)], d);
    if (x < 0.86) return err('rpc', '期权链取不到(没有行情权限)', d, -32017);
    if (x < 0.92) return err('plain', '链'.repeat(130), d);
    return ok(null, d);
  });
  // 分钟线
  const stamp = (d, hhmm, tz) => `${d.replace(/-/g, '')} ${hhmm}:00${tz ? ' US/Eastern' : ''}`;
  fakes['session.historicalData|SPX'] = Array.from({ length: 24 }, () => {
    const x = r.next();
    if (x < 0.08) return err('plain', '历史限速');
    const tz = r.chance(0.5);
    const rows = [];
    for (const d of dates) if (r.chance(0.8)) rows.push({ date: stamp(d, '09:35', tz), open: Math.round((base0 + (r.next() - 0.5) * 50) * 100) / 100, high: 1, low: 1, close: 1 });
    if (r.chance(0.2)) rows.push({ date: stamp(dates[0], '09:36', tz), open: 7700, high: 1, low: 1, close: 1 });
    return ok(r.chance(0.12) ? [] : rows, r.chance(0.1) ? 1 + r.int(200) : undefined);
  });
  fakes['session.historicalData|*'] = Array.from({ length: 40 }, () => {
    const x = r.next();
    if (x < 0.06) return err('plain', '历史限速');
    const tz = r.chance(0.5);
    const rows = [];
    for (const d of dates) {
      if (r.chance(0.8)) rows.push({ date: stamp(d, '09:35', tz), open: Math.round((6 + r.next() * 10) * 10) / 10, high: 1, low: 1, close: 1 });
      if (r.chance(0.8)) rows.push({ date: stamp(d, early.has(d) ? '13:10' : '16:10', tz), open: r.chance(0.07) ? 0 : Math.round((6 + r.next() * 10) * 10) / 10, high: 1, low: 1, close: 1 });
    }
    return ok(r.chance(0.12) ? [] : rows, r.chance(0.1) ? 1 + r.int(200) : undefined);
  });
  fakes['session.qualify'] = Array.from({ length: 40 }, () => {
    const x = r.next();
    const d = r.chance(0.1) ? 1 + r.int(150) : undefined;
    if (x < 0.82) return ok(true, d);
    if (x < 0.88) return ok(false, d);
    if (x < 0.92) return ok(123456, d);
    if (x < 0.96) return err('plain', 'timeout', d);
    return err('plain', '确认失败', d);
  });
  fakes['session.managed'] = Array.from({ length: 30 }, () => {
    const x = r.next();
    if (x < 0.85) return ok(['DU7654321']);
    if (x < 0.91) return ok(['U1234567']);
    if (x < 0.94) return ok([]);
    if (x < 0.97) return ok(['DU1', 'U2']);
    return err('plain', 'managed 炸了');
  });

  const steps = [];
  let clock = et('08:30', block[0]);
  const start = clock;
  const hasRestart = r.chance(0.7);
  const logJunk = () => logwrite(pick(block), [r.pick(['not json', '', '{"kind":"nonsense"}', JSON.stringify({ kind: 'frame', band: { at: 1 } })])]);
  const pick = (a) => a[r.int(a.length)];
  const goto = (ms) => { if (ms > clock) { steps.push(to(ms)); clock = ms; } };
  const ops = [
    () => steps.push(snap()),
    () => steps.push(call('enabled')),
    () => { const v = r.chance(0.6); steps.push(call('setEnabled', [v])); if (!v && r.chance(0.7)) steps.push(call('setEnabled', [true])); },
    () => steps.push({ op: 'router', set: pick([{ on: false }, { on: true }, { sessions: false }, { sessions: true }, { noSession: true }, { noSession: false }]) }),
    () => steps.push({ op: 'settings', patch: pick([{}, FUTU, { market_holidays: ['2026-09-07', pick(block)] }]) }),
    () => { if (hasRestart) steps.push({ op: 'restart' }); },
    () => steps.push(logJunk()),
    () => steps.push(files({ namesOnly: true })),
  ];
  const tickAt = (ms, withDefault) => {
    goto(ms);
    steps.push(withDefault ? call('tickOnce', []) : tick(ms));
    if (r.chance(0.12)) pick(ops)();
  };
  const finish = () => { steps.push({ op: 'router', set: { on: true, sessions: true, noSession: false } }); steps.push({ op: 'settings', patch: {} }); };
  for (const d of block) {
    const closeHm = early.has(d) ? [13, 0] : [16, 0];
    const at = (h, m, s = 0) => et(`${String(Math.floor((h * 60 + m) / 60)).padStart(2, '0')}:${String((h * 60 + m) % 60).padStart(2, '0')}`, d, s);
    const times = [];
    // 开盘前
    for (let i = r.int(4); i > 0; i -= 1) times.push(at(8 + r.int(2), r.int(60) % 60, r.int(60)));
    for (let i = r.int(3); i > 0; i -= 1) times.push(at(9, 30 + r.int(5), r.int(60)));
    // 09:35 附近
    for (const s of [0, 5, 10, 15, 20, 40]) if (r.chance(0.5)) times.push(at(9, 35, s));
    times.push(at(9, 36 + r.int(3), r.int(60)));
    // 盘中
    let m = 9 * 60 + 40;
    const endM = closeHm[0] * 60 + closeHm[1];
    while (m < endM) {
      times.push(at(Math.floor(m / 60), m % 60, r.chance(0.3) ? r.int(60) : 0));
      if (r.chance(0.25)) times.push(at(Math.floor(m / 60), m % 60, 30 + r.int(29)));
      m += pick([2, 5, 5, 7, 12, 20, 33, 47]);
    }
    // 收盘后
    for (const mm of [-1, 0, 4, 9, 10, 10, 12, 14, 15, 20, 45]) if (r.chance(0.45)) times.push(at(closeHm[0], closeHm[1] + mm, r.int(60) % 60 === 0 ? 0 : r.int(60)));
    times.sort((x, y) => x - y);
    for (const t of times) {
      const x = r.next();
      if (x < 0.05) { // 并发的两个
        goto(t);
        const ida = `a${steps.length}`, idb = `b${steps.length}`;
        steps.push(call('tickOnce', [t], { id: ida, start: true }), call('tickOnce', [r.chance(0.5) ? t + 5000 : null], { id: idb, start: true }));
        steps.push(adv(r.int(150)), { op: 'await', id: r.chance(0.5) ? ida : idb }, { op: 'await', id: ida }, { op: 'await', id: idb });
      } else if (x < 0.09) { // 循环一段
        goto(t);
        steps.push(call('start', [pick([1000, 5000, 5000, 2500])]), adv(r.int(25_000)), call('stop'), adv(r.int(3000)));
        if (r.chance(0.3)) steps.push(call('stop'));
      } else tickAt(t, r.chance(0.1));
    }
  }
  finish();
  steps.push(call('stop'), adv(60_000), snap(), files(), db());
  return { name: `random_${seed}`, start, settings, fakes, steps };
}

for (let seed = 1; seed <= Number(process.env.RANDOMS ?? 14); seed += 1) scenarios.push(await randomScenario(seed));

// ---------------------------------------------------------------- 跑
const out = [];
for (const s of scenarios) {
  if (only && !s.name.includes(only)) continue;
  const expected = await runScenario(s);
  out.push({ name: s.name, script: enc(s), expected: enc(expected) });
}
const text = JSON.stringify({ base: BASE_CONFIG, scenarios: out });
writeFileSync(join(here, OUT), text);
console.log(`${OUT}:${out.length} 个场景,${(text.length / 1024).toFixed(0)} KB`);
