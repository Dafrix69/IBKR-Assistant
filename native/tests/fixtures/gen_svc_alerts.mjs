// 生成 svc_alerts.json:engine-ts 的 AlertsService(services/alerts.ts,原模块现跑)对着脚本驱动的假宿主的场景(见 svc1_world.mjs 开头的约定)。
// 场景照 engine-ts/tests 里碰它的那些用例(alerts-levels / alerts-poll / ma-touch / quality-rpc 里的 alerts 部分)写,再加随机交错(种子固定)。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_svc_alerts.mjs <编过的 engine-ts 目录>
// 脚本 steps 的方法:refresh(params, nowMs?) tickLevels(nowMs, inWindow) levelsStatusOf(sym) crossConfirm() listWatches() touchConfig() touchConfigChanged()
//   tickTouch(nowMs, inWindow) poll() forget(sym) adoptForTrack(sym) adoptTracked([sym…]) releaseForTrack([sym…])
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dailyBars, makeWall } from './svc1_data.mjs';
import {
  BASE_CONFIG, World, dumpDb, loadMods, makeMarket, makeNotifier, makeRouter, makeSettings, rng, runSteps, enc,
} from './svc1_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engineDir = process.argv[2];
if (!engineDir) throw new Error('要给编过的 engine-ts 目录');
const OUT = process.env.OUT ?? 'svc_alerts.json';
const only = process.env.ONLY;

const mods = await loadMods(engineDir, ['config', 'rpcError', 'broker', 'optionMarks', 'store', 'maTouch', 'services/alerts']);
mods.BrokerError = mods.broker.BrokerError;
mods.OptionMarksError = mods.optionMarks.OptionMarksError;

// ---------------------------------------------------------------- 跑一个场景
async function runScenario(script) {
  const world = new World(script);
  try {
    const box = { settings: makeSettings(mods.config, world) };
    const store = new mods.store.TradeStore(join(world.dir, 't.db'));
    const routerState = { ...(script.router ?? {}) };
    const ctx = { world, script, mods, engineDir, store, routerState };
    ctx.rebuildRouter = () => { ctx.router = makeRouter(world, mods, routerState, () => { throw new Error('alerts 不取会话'); }); };
    ctx.rebuildRouter();
    const engine = { store, notifier: makeNotifier(world) };
    const host = {
      get settings() { return box.settings; },
      get router() { return routerState.on === false ? null : ctx.router; },
      get engine() { return engine; },
      emit(event, payload) { world.rec('emit', [event, payload]); },
    };
    const svc = new mods.alerts.AlertsService(host, makeMarket(world, mods));
    ctx.setSettings = (patch) => { box.settings = makeSettings(mods.config, world, patch); };
    ctx.shape = (m, v) => (v === undefined ? null : v);
    ctx.methods = {
      refresh: ([params, nowMs]) => svc.refresh(params, nowMs ?? undefined),
      tickLevels: ([nowMs, inWindow]) => svc.tickLevels(nowMs, inWindow),
      levelsStatusOf: ([s]) => svc.levelsStatusOf(s),
      crossConfirm: () => svc.crossConfirm(),
      listWatches: () => svc.listWatches(),
      touchConfig: () => svc.touchConfig(),
      touchConfigChanged: () => svc.touchConfigChanged(),
      tickTouch: ([nowMs, inWindow]) => svc.tickTouch(nowMs, inWindow),
      poll: () => svc.poll(),
      forget: ([s]) => svc.forget(s),
      adoptForTrack: ([s]) => svc.adoptForTrack(s),
      adoptTracked: ([list]) => svc.adoptTracked(list),
      releaseForTrack: ([list]) => svc.releaseForTrack(new Set(list)),
    };
    const steps = await runSteps(ctx);
    const db = dumpDb(engineDir, join(world.dir, 't.db'), world);
    store.close();
    return { log: world.log, steps, db };
  } finally {
    world.restore();
  }
}

// ---------------------------------------------------------------- 脚本的小零件
const T0 = Date.UTC(2026, 9, 21, 13, 20, 0); // 周三 09:20 ET(夏令时)
const at = (h, m, s = 0, day = 21) => Date.UTC(2026, 9, day, h + 4, m, s); // 美东 h:m:s
const ok = (v, delay) => (delay ? { ok: v, delay } : { ok: v });
const err = (kind, message, delay, code) => ({ err: { kind, message, ...(code !== undefined ? { code } : {}) }, ...(delay ? { delay } : {}) });
const add = (sym, step = 0, origin = '') => ({ op: 'store', m: 'addWatch', a: [sym, step, origin], as: sym });
const call = (m, a = [], extra = {}) => ({ op: 'call', m, a, ...extra });
const adv = (ms) => ({ op: 'advance', ms });
const to = (t) => ({ op: 'advance', to: t });
const upd = (sym, fields) => ({ op: 'store', m: 'updateWatch', a: [{ $ref: sym }, fields] });
const quotes = (obj, delay) => ({ ok: obj, ...(delay ? { delay } : {}) });
const q = (price, tradedAt = null, source = '') => ({ price, tradedAt, source });

const scenarios = [];
const sc = (name, body) => scenarios.push({ name, ...body });

// 共用数据(种子固定)
const r0 = rng(20261021);
const hist = (n, end, last, seed = 1) => dailyBars(rng(seed), n, end, last);
const wallAt = async (spot, sym = 'AAPL', seed = 7, expiry = '20261030') => makeWall(engineDir, rng(seed), spot, sym, expiry, T0);

const W190 = await wallAt(190.4);
const H190 = hist(260, '2026-10-20', 189.3, 11);
const H190partial = [...hist(40, '2026-10-20', 189.3, 12), { date: '2026-10-21', open: 189.3, high: 191, low: 189, close: 190.4, volume: 1 }];
const H_SHORT = hist(15, '2026-10-20', 189.3, 13);
const TCFG = { enabled: true, periods: [20], window_days: 30, min_touches: 2, band_pct: 0.4 };
/** 20 日线上之前碰过(至少一段,最后一段不连着昨天)的日线:种子从 31 往上找 */
function touchyHistory() {
  for (let seed = 31; seed < 2000; seed += 1) {
    const H = hist(260, '2026-10-20', 189.3, seed);
    const book = mods.maTouch.buildTouchBook(H, '2026-10-21', TCFG, {});
    const line = book?.lines.find((l) => l.period === 20);
    if (line && line.episodes.length >= 1 && line.episodes[line.episodes.length - 1].end !== book.as_of) return H;
  }
  throw new Error('找不到合适的日线');
}
const TH = touchyHistory();

// ---------------------------------------------------------------- 手写场景
sc('refresh_basic', {
  start: T0,
  fakes: { 'market.wallFor|AAPL': [ok(W190)], 'market.dailyHistory|AAPL': [ok(H190)] },
  steps: [add('AAPL'), call('refresh', [{ id: { $ref: 'AAPL' } }]), call('listWatches'), call('levelsStatusOf', ['AAPL']), call('levelsStatusOf', ['NVDA']), { op: 'db' }],
});
sc('refresh_partial_today_bar', {
  start: T0,
  fakes: { 'market.wallFor|AAPL': [ok(W190)], 'market.dailyHistory|AAPL': [ok(H190partial)] },
  steps: [add('AAPL', 2.5), call('refresh', [{ id: { $ref: 'AAPL' } }]), call('refresh', [{ id: { $ref: 'AAPL' }, step: '5' }]), call('listWatches'), { op: 'db' }],
});
sc('refresh_short_history_and_empty', {
  start: T0,
  fakes: { 'market.wallFor|AAPL': [ok(W190)], 'market.dailyHistory|AAPL': [ok(H_SHORT), ok([])] },
  steps: [add('AAPL'), call('refresh', [{ id: { $ref: 'AAPL' } }]), call('refresh', [{ id: { $ref: 'AAPL' } }]), { op: 'db' }],
});
sc('refresh_wall_rpc_error_fallback_spot', {
  start: T0,
  fakes: {
    'market.wallFor|AAPL': [err('rpc', '期权链取不到(没有行情权限)', 0, -32017)], 'market.spotOf|AAPL': [ok(190.55)],
    'market.dailyHistory|AAPL': [ok(H190)],
  },
  steps: [add('AAPL'), call('refresh', [{ id: { $ref: 'AAPL' } }]), call('levelsStatusOf', ['AAPL']), { op: 'db' }],
});
sc('refresh_wall_plain_error_long_message', {
  start: T0,
  fakes: {
    'market.wallFor|AAPL': [err('plain', '长'.repeat(450))], 'market.spotOf|AAPL': [ok(190.55)], 'market.dailyHistory|AAPL': [err('plain', '史'.repeat(380))],
  },
  steps: [add('AAPL'), call('refresh', [{ id: { $ref: 'AAPL' } }]), { op: 'db' }],
});
sc('refresh_no_spot', {
  start: T0,
  fakes: {
    'market.wallFor|AAPL': [err('rpc', '没有期权链', 0, -32017)], 'market.spotOf|AAPL': [ok(null), ok(0), ok(NaN), ok(190.5)],
    'market.dailyHistory|AAPL': [err('rpc', '日线也没有', 0, -32017)],
  },
  steps: [add('AAPL'), call('refresh', [{ id: { $ref: 'AAPL' } }]), call('refresh', [{ id: { $ref: 'AAPL' } }]), call('refresh', [{ id: { $ref: 'AAPL' } }]),
    call('refresh', [{ id: { $ref: 'AAPL' } }]), { op: 'db' }],
});
sc('refresh_params', {
  start: T0,
  fakes: { 'market.wallFor|AAPL': [ok(W190)], 'market.dailyHistory|AAPL': [ok(H190)] },
  steps: [
    add('AAPL', 5, ''),
    call('refresh', [{ id: 'nope' }]),
    call('refresh', [{}]),
    call('refresh', [{ id: { $ref: 'AAPL' }, step: ' ' }]),
    call('refresh', [{ id: { $ref: 'AAPL' }, step: 'abc' }]),
    call('refresh', [{ id: { $ref: 'AAPL' }, step: -1 }]),
    call('refresh', [{ id: { $ref: 'AAPL' }, step: 1001 }]),
    call('refresh', [{ id: { $ref: 'AAPL' }, step: null }]),
    call('refresh', [{ id: { $ref: 'AAPL' }, step: true }]),
    call('refresh', [{ id: { $ref: 'AAPL' }, step: '0' }]),
    call('refresh', [{ id: { $ref: 'AAPL' }, step: 1000, expiry: ' 20261106 ' }]),
    call('refresh', [{ id: { $ref: 'AAPL' }, expiry: '' }]),
    call('refresh', [{ id: { $ref: 'AAPL' }, expiry: null }]),
    call('refresh', [{ id: { $ref: 'AAPL' }, step: '2.5', expiry: 20261030 }]),
    call('refresh', [{ id: { $ref: 'AAPL' }, step: '1e1' }]),
    { op: 'db' },
  ],
});
sc('refresh_watch_deleted_midway', {
  start: T0,
  fakes: { 'market.wallFor|AAPL': [ok(W190, 500)], 'market.dailyHistory|AAPL': [ok(H190, 300)] },
  steps: [
    add('AAPL'), call('refresh', [{ id: { $ref: 'AAPL' } }], { id: 'r1', start: true }),
    adv(100), { op: 'store', m: 'deleteWatch', a: [{ $ref: 'AAPL' }] }, { op: 'await', id: 'r1' }, { op: 'db' },
  ],
});
sc('refresh_two_overlapping', {
  start: T0,
  fakes: { 'market.wallFor|AAPL': [ok(W190, 400), ok(W190, 100)], 'market.wallFor|NVDA': [ok(W190, 50)], 'market.dailyHistory|*': [ok(H190, 10)] },
  steps: [
    add('AAPL'), add('NVDA'),
    call('refresh', [{ id: { $ref: 'AAPL' } }], { id: 'a', start: true }),
    call('refresh', [{ id: { $ref: 'NVDA' } }], { id: 'b', start: true }),
    call('refresh', [{ id: { $ref: 'AAPL' }, step: 5 }], { id: 'c', start: true }),
    { op: 'await', id: 'b' }, { op: 'await', id: 'a' }, { op: 'await', id: 'c' }, { op: 'db' },
  ],
});

// ---- tickLevels
const tickFakes = {
  'market.wallFor|*': [ok(W190)], 'market.dailyHistory|*': [ok(H190)],
};
sc('tick_levels_gates', {
  start: T0, fakes: tickFakes,
  steps: [
    add('AAPL'),
    call('tickLevels', [T0, false]),
    { op: 'router', set: { sessions: false } }, call('tickLevels', [T0, true]),
    { op: 'router', set: { on: false } }, call('tickLevels', [T0, true]),
    { op: 'router', set: { on: true, sessions: true } },
    call('tickLevels', [T0, true]), call('levelsStatusOf', ['AAPL']), call('tickLevels', [T0, true]), { op: 'db' },
  ],
});
sc('tick_levels_backoff_and_order', {
  start: T0, fakes: tickFakes,
  steps: [
    add('AAPL'), add('NVDA'), add('TSLA'),
    call('tickLevels', [T0, true]), call('tickLevels', [T0 + 1000, true]), call('tickLevels', [T0 + 2000, true]), call('tickLevels', [T0 + 3000, true]),
    upd('AAPL', { levels: [], levels_at: '' }), call('tickLevels', [T0 + 599_000, true]), call('tickLevels', [T0 + 600_000, true]),
    call('levelsStatusOf', ['AAPL']), call('levelsStatusOf', ['TSLA']), { op: 'db' },
  ],
});
sc('tick_levels_open_gating', {
  start: T0,
  fakes: { 'market.wallFor|*': [ok(W190)], 'market.dailyHistory|*': [ok(H190)] },
  steps: [
    add('AAPL'), add('NVDA'),
    call('tickLevels', [at(9, 0), true]), // 开盘前:没价位的先算
    call('tickLevels', [at(9, 0, 1), true]),
    call('tickLevels', [at(9, 1, 0), true]), // 都有价位了:开盘前不重算
    upd('AAPL', { levels_at: '2026-10-20T20:00:00+00:00' }),
    upd('NVDA', { levels_at: 'garbage' }),
    call('tickLevels', [at(9, 29, 59), true]), // 还没开盘
    call('tickLevels', [at(9, 30, 0), true]), // 开盘了,昨天算的价位该重算
    call('tickLevels', [at(9, 30, 1), true]), call('tickLevels', [at(9, 30, 2), true]),
    upd('NVDA', { levels_at: '2026-10-21T14:00:00+00:00' }), // 开盘之后算的:不重算
    call('tickLevels', [at(11, 0, 0), true]),
    upd('NVDA', { enabled: false, levels_at: '2020-01-01T00:00:00+00:00' }),
    call('tickLevels', [at(15, 0, 0), true]), { op: 'db' },
  ],
});
sc('tick_levels_holiday_and_weekend', {
  start: T0, settings: { market_holidays: ['2026-10-21', '2026-09-07'] }, fakes: tickFakes,
  steps: [
    add('AAPL'), add('NVDA'),
    call('tickLevels', [at(10, 0), true]), // 休市日:没价位的照算
    call('tickLevels', [at(10, 0, 1), true]),
    upd('AAPL', { levels_at: '2020-01-01T00:00:00+00:00' }), upd('NVDA', { levels_at: '2020-01-01T00:00:00+00:00' }),
    call('tickLevels', [at(10, 5), true]), // 有价位:休市日整天不重算
    call('tickLevels', [Date.UTC(2026, 9, 24, 15, 0), true]), // 周六
    { op: 'db' },
  ],
});
sc('tick_levels_failure_notes', {
  start: T0,
  fakes: {
    'market.wallFor|AAPL': [err('rpc', '链取不到', 0, -32017), ok(W190), err('plain', '炸了')], 'market.spotOf|AAPL': [ok(190.5)],
    'market.dailyHistory|AAPL': [ok(H190), err('rpc', '日线限速', 0, -32017), ok(H190)],
    'market.wallFor|NVDA': [ok(W190)], 'market.dailyHistory|NVDA': [ok(H190)],
  },
  steps: [
    add('AAPL'), add('NVDA'),
    call('tickLevels', [T0, true]), call('levelsStatusOf', ['AAPL']), // 墙取不到:降级,记原因
    upd('AAPL', { levels: [] }), call('tickLevels', [T0 + 700_000, true]), call('levelsStatusOf', ['AAPL']), // 日线限速
    upd('AAPL', { levels: [] }), call('tickLevels', [T0 + 1_400_000, true]), call('levelsStatusOf', ['AAPL']), // 墙炸了、spot 在、日线 ok
    upd('AAPL', { levels: [] }), call('tickLevels', [T0 + 2_100_000, true]), call('levelsStatusOf', ['AAPL']), // 全好:清掉原因
    { op: 'store', m: 'deleteWatch', a: [{ $ref: 'AAPL' }] }, call('levelsStatusOf', ['AAPL']), { op: 'db' },
  ],
});
sc('tick_levels_refresh_throws', {
  start: T0,
  fakes: { 'market.wallFor|*': [err('rpc', '链取不到', 0, -32017)], 'market.spotOf|*': [ok(null)], 'market.dailyHistory|*': [ok(H190)] },
  steps: [add('AAPL'), call('tickLevels', [T0, true]), call('levelsStatusOf', ['AAPL']), { op: 'db' }],
});

// ---- 碰均线
const TOUCH_ON = { enabled: true, periods: [20, 50], window_days: 10, min_touches: 3, band_pct: 0.5 };
sc('touch_config', {
  start: T0,
  steps: [
    call('touchConfig'),
    { op: 'store', m: 'setPref', a: ['alerts.touch_config', TOUCH_ON] }, call('touchConfig'),
    { op: 'store', m: 'setPref', a: ['alerts.touch_config', { enabled: 'yes' }] }, call('touchConfig'),
    { op: 'store', m: 'setPref', a: ['alerts.touch_config', { enabled: false }] }, call('touchConfig'),
    { op: 'store', m: 'setPref', a: ['alerts.touch_config', 'junk'] }, call('touchConfig'),
    { op: 'store', m: 'setPref', a: ['alerts.touch_config', null] }, call('touchConfig'),
    { op: 'store', m: 'setPref', a: ['alerts.cross_confirm', 'bar_close'] }, call('crossConfirm'),
    { op: 'store', m: 'setPref', a: ['alerts.cross_confirm', 'other'] }, call('crossConfirm'),
    { op: 'store', m: 'setPref', a: ['alerts.cross_confirm', null] }, call('crossConfirm'),
    { op: 'db' },
  ],
});
sc('touch_tick', {
  start: T0,
  fakes: { 'market.dailyHistory|AAPL': [ok(H190), err('plain', '没权限'), ok(H190)], 'market.dailyHistory|NVDA': [ok(hist(80, '2026-10-20', 480, 21))] },
  steps: [
    add('AAPL'), add('NVDA'),
    call('tickTouch', [T0, false]),
    { op: 'router', set: { sessions: false } }, call('tickTouch', [T0, true]), { op: 'router', set: { sessions: true } },
    call('tickTouch', [T0, true]), call('tickTouch', [T0 + 1000, true]), // 先 AAPL,再 NVDA
    call('tickTouch', [T0 + 2000, true]), // 都有底账了
    upd('AAPL', { touch: null }), call('tickTouch', [T0 + 3000, true]), // AAPL 退避中
    call('tickTouch', [Date.UTC(2026, 9, 21, 13, 52), true]), // 半小时后
    call('tickTouch', [Date.UTC(2026, 9, 21, 13, 52, 1), true]),
    { op: 'store', m: 'setPref', a: ['alerts.touch_config', TOUCH_ON] }, call('touchConfigChanged'),
    call('tickTouch', [Date.UTC(2026, 9, 21, 13, 53), true]), call('tickTouch', [Date.UTC(2026, 9, 21, 13, 53, 1), true]),
    call('tickTouch', [Date.UTC(2026, 9, 24, 15, 0), true]), // 周六
    { op: 'store', m: 'setPref', a: ['alerts.touch_config', { enabled: false }] }, call('tickTouch', [T0 + 10_000_000, true]), { op: 'db' },
  ],
});

// ---- poll
const levelsFor = (spot, step) => [{ price: spot - step, label: `整数关口 ${spot - step}`, source: 'round', kind: 'pivot' }, { price: spot + step, label: `整数关口 ${spot + step}`, source: 'round', kind: 'pivot' }];
const pollLevels = [
  { price: 190, label: '整数关口 190', source: 'round', kind: 'pivot' },
  { price: 191, label: '上方持仓墙', source: 'call_wall', kind: 'resistance' },
  { price: 189, label: '下方持仓墙', source: 'put_wall', kind: 'support' },
];
sc('poll_crossings', {
  start: at(10, 0),
  fakes: {
    'market.quotesOf': [
      quotes({ AAPL: q(190.4, at(10, 0) / 1000) }), quotes({ AAPL: q(190.6, at(10, 0, 5) / 1000) }), quotes({ AAPL: q(191.2, at(10, 0, 10) / 1000) }),
      quotes({ AAPL: q(191.3, at(10, 0, 15) / 1000) }), quotes({ AAPL: q(188.9, at(10, 0, 20) / 1000) }), quotes({ AAPL: q(188.8, at(10, 0, 25) / 1000) }),
      quotes({ AAPL: null }), quotes({}),
    ],
  },
  steps: [
    add('AAPL', 1), upd('AAPL', { levels: pollLevels, last_price: 190.2 }),
    call('poll'), adv(5000), call('poll'), adv(5000), call('poll'), adv(5000), call('poll'), adv(5000), call('poll'), adv(5000), call('poll'),
    adv(5000), call('poll'), adv(5000), call('poll'), { op: 'db' },
  ],
});
sc('poll_bar_close_confirm', {
  start: at(10, 0),
  fakes: {
    'market.quotesOf': [
      quotes({ AAPL: q(190.4) }), quotes({ AAPL: q(190.7) }), quotes({ AAPL: q(191.4) }), quotes({ AAPL: q(191.5) }), quotes({ AAPL: q(191.6) }),
      quotes({ AAPL: q(190.2) }), quotes({ AAPL: q(190.1) }), quotes({ AAPL: q(191.6) }), quotes({ AAPL: q(190.5) }), quotes({ AAPL: q(190.4) }),
    ],
  },
  steps: [
    { op: 'store', m: 'setPref', a: ['alerts.cross_confirm', 'bar_close'] },
    add('AAPL', 1), upd('AAPL', { levels: pollLevels, last_price: 190.2 }),
    call('poll'), adv(20000), call('poll'), adv(20000), call('poll'), adv(20000), call('poll'), adv(30000), call('poll'), adv(40000), call('poll'),
    adv(30000), call('poll'), adv(30000), call('poll'), adv(30000), call('poll'), adv(400000), call('poll'), { op: 'db' },
  ],
});
sc('poll_session_change_and_gap', {
  start: at(9, 29, 50),
  fakes: {
    'market.quotesOf': [
      quotes({ AAPL: q(189.9, at(9, 29, 40) / 1000) }), quotes({ AAPL: q(190.2, at(9, 29, 55) / 1000) }), quotes({ AAPL: q(190.4, at(9, 30, 5) / 1000) }),
      quotes({ AAPL: q(190.6, at(9, 30, 20) / 1000) }), quotes({ AAPL: q(191.5, at(9, 30, 40) / 1000) }), quotes({ AAPL: q(192, at(9, 40, 0) / 1000) }),
      quotes({ AAPL: q(190.5, at(9, 40, 5) / 1000, 'futures') }), quotes({ AAPL: q(190.8, at(9, 40, 10) / 1000, 'index') }),
    ],
  },
  steps: [
    add('AAPL', 1), upd('AAPL', { levels: pollLevels, last_price: 190.2 }),
    call('poll'), adv(5000), call('poll'), adv(10000), call('poll'), adv(15000), call('poll'), adv(20000), call('poll'), adv(560000), call('poll'),
    adv(5000), call('poll'), adv(5000), call('poll'), { op: 'db' },
  ],
});
sc('poll_skips_and_deleted', {
  start: at(10, 0),
  fakes: {
    'market.quotesOf': [quotes({ AAPL: q(190.5), NVDA: q(480.5), TSLA: q(400), AMD: q(120) }, 300), quotes({ AAPL: q(190.5), NVDA: q(480.5) })],
  },
  steps: [
    add('AAPL', 1), add('NVDA', 5), add('TSLA', 5), add('AMD', 5),
    upd('AAPL', { levels: pollLevels }), upd('NVDA', { levels: levelsFor(480, 5) }), upd('TSLA', { levels: [] }), upd('AMD', { levels: levelsFor(120, 5), enabled: false }),
    call('poll', [], { id: 'p', start: true }), adv(100), { op: 'store', m: 'deleteWatch', a: [{ $ref: 'NVDA' }] }, { op: 'await', id: 'p' },
    call('poll'), { op: 'db' },
  ],
});
sc('poll_reround_and_states', {
  start: at(10, 0),
  fakes: {
    'market.quotesOf': [quotes({ AAPL: q(190.6, at(10, 0) / 1000) }), quotes({ AAPL: q(191.4, at(10, 0, 5) / 1000) }), quotes({ AAPL: q(192.7, at(10, 0, 10) / 1000) }),
      quotes({ AAPL: q(192.8, at(10, 0, 15) / 1000) })],
  },
  steps: [
    add('AAPL', 1),
    upd('AAPL', {
      levels: [{ price: 190, label: '整数关口 190', source: 'round', kind: 'pivot' }, { price: 191, label: '整数关口 191', source: 'round', kind: 'pivot' }],
      states: { 'round@190.0000': { armed: false, last_fired_at: 1 }, 'round@191.0000': { armed: true, last_fired_at: null, pending: { direction: 'up', from: 190, at: 5, minute: 0 } }, junk: { armed: 0 } },
      events: Array.from({ length: 49 }, (_, i) => ({ symbol: 'AAPL', price: i, label: 'x', source: 'round', kind: 'pivot', direction: 'up', from: 0, to: 1, at: i, text: 't' })),
    }),
    call('poll'), adv(5000), call('poll'), adv(5000), call('poll'), adv(5000), call('poll'), { op: 'db' },
  ],
});
sc('poll_touch_ma', {
  start: at(10, 0),
  settings: {},
  fakes: {
    'market.wallFor|AAPL': [ok(W190)], 'market.dailyHistory|AAPL': [ok(H190)],
    'market.quotesOf': [], // 下面按均线位置现填
  },
  steps: [], // 由 touchScenario 填
});

// ---- 联动
sc('adopt_release', {
  start: T0,
  steps: [
    call('adoptForTrack', ['aapl']), call('adoptForTrack', [' AAPL ']), call('adoptForTrack', ['']), call('adoptForTrack', ['  ']),
    call('adoptForTrack', ['NVDA']), call('adoptForTrack', ['BAD SYMBOL!']), call('adoptForTrack', ['x'.repeat(40)]),
    call('adoptTracked', [['tsla', 'TSLA', 'amd', '', ' msft ']]), call('adoptTracked', [['QQQ']]),
    { op: 'store', m: 'addWatch', a: ['SPY', 0, ''] },
    call('releaseForTrack', [['AAPL']]), call('releaseForTrack', [[]]),
    { op: 'store', m: 'addSector', a: ['板块'], as: 'sec' }, { op: 'store', m: 'setSectorStocks', a: [{ $ref: 'sec' }, [{ symbol: 'AMD', name: 'AMD' }]] },
    add('AMD', 0, 'tracker'), call('releaseForTrack', [[]]),
    call('levelsStatusOf', ['SPY']), { op: 'db' },
  ],
});
sc('adopt_limit', {
  start: T0,
  steps: [
    ...Array.from({ length: 30 }, (_, i) => ({ op: 'store', m: 'addWatch', a: [`S${String(i).padStart(2, '0')}`, 0, ''] })),
    call('adoptForTrack', ['NEW']), call('adoptForTrack', ['S05']), call('adoptTracked', [['A', 'B']]),
    { op: 'db' },
  ],
});
sc('forget_resets_backoff', {
  start: T0, fakes: tickFakes,
  steps: [
    add('AAPL'), call('tickLevels', [T0, true]), upd('AAPL', { levels: [] }), call('tickLevels', [T0 + 1000, true]),
    call('forget', ['AAPL']), call('tickLevels', [T0 + 2000, true]), call('levelsStatusOf', ['AAPL']), { op: 'db' },
  ],
});
sc('list_watches_ma', {
  start: at(10, 0),
  fakes: { 'market.wallFor|AAPL': [ok(W190)], 'market.dailyHistory|AAPL': [ok(H190)] },
  steps: [
    add('AAPL'), call('refresh', [{ id: { $ref: 'AAPL' } }]), call('listWatches'),
    upd('AAPL', { last_price: 0 }), call('listWatches'), upd('AAPL', { last_price: 195.5 }), call('listWatches'),
    { op: 'db' },
  ],
});

// ---------------------------------------------------------------- 碰均线的 poll(均线位置现算)
async function touchScenarios() {
  // 价位里的均线(period 20 / prior_sum):盘中线 = (prior_sum + 现价) / 20。先让 refresh 算出来,poll 的价围着它走
  const H = TH;
  const closes = H.map((b) => b.close);
  const priorSum20 = closes.slice(closes.length - 19).reduce((a, b) => a + b, 0);
  const ma20At = (p) => (priorSum20 + p) / 20;
  const near = ma20At(189);
  const walk = [near * 1.004, near * 1.0008, near * 0.9996, near * 1.002, near * 1.0003, near * 0.999, near * 1.0006, near * 1.003, near * 0.9992, near * 1.0004];
  const quotesList = walk.map((p, i) => quotes({ AAPL: q(Math.round(p * 100) / 100, at(10, 0, i * 15) / 1000) }));
  const steps = [
    { op: 'store', m: 'setPref', a: ['alerts.touch_config', TCFG] },
    add('AAPL', 1), call('refresh', [{ id: { $ref: 'AAPL' } }]),
  ];
  for (let i = 0; i < walk.length; i += 1) steps.push(call('poll'), adv(15000));
  steps.push(call('listWatches'), { op: 'db' });
  const s = scenarios.find((x) => x.name === 'poll_touch_ma');
  s.fakes = { 'market.wallFor|AAPL': [ok(W190)], 'market.dailyHistory|AAPL': [ok(H)], 'market.quotesOf': quotesList };
  s.steps = steps;
}
await touchScenarios();


// ---- 变异检验补的用例(幸存者逐个对应)

{
  const H = TH;
  const book = mods.maTouch.buildTouchBook(H, '2026-10-21', TCFG, {});
  const closes = H.map((b) => b.close);
  const sum20 = closes.slice(closes.length - 19).reduce((a, b) => a + b, 0);
  const near = (sum20 + 189) / 20;
  const setup = [
    { op: 'store', m: 'setPref', a: ['alerts.touch_config', TCFG] }, add('AAPL', 1), call('refresh', [{ id: { $ref: 'AAPL' } }]),
  ];
  const withBook = (b) => upd('AAPL', { touch: b });
  const shifted = { ...book, lines: book.lines.map((l) => ({ ...l, prior_sum: l.prior_sum + 20 })) };
  const walkQuotes = (list) => list.map((p, i) => quotes({ AAPL: q(Math.round(p * 100) / 100, at(10, 0, i * 15) / 1000) }));
  sc('stale_and_shifted_touch_book', {
    start: at(10, 0),
    fakes: { 'market.wallFor|AAPL': [ok(W190)], 'market.dailyHistory|AAPL': [ok(H)], 'market.quotesOf': walkQuotes([near * 1.004, near * 1.0008, near * 0.9996, near * 1.002, near * 0.9993]) },
    steps: [
      ...setup, call('listWatches'),
      withBook({ ...book, as_of: '2026-10-16' }), call('listWatches'), call('poll'), adv(15000),
      withBook(shifted), call('listWatches'), call('poll'), adv(15000),
      withBook({ ...shifted, as_of: null }), call('listWatches'), call('poll'), adv(15000),
      withBook(shifted), call('poll'), adv(15000), call('poll'), { op: 'db' },
    ],
  });
  // 碰均线与另一条线的穿越同一轮:穿越照报;提早收盘日的时段边界
  const extra = { price: Math.round(near * 1.0015 * 100) / 100, label: '手放的位', source: 'round', kind: 'pivot' };
  const walk = [near * 1.004, near * 1.0008, near * 0.9996, near * 1.002, near * 1.0003, near * 0.999, near * 1.0006, near * 1.003, near * 0.9992, near * 1.0004];
  const walk2 = [near * 1.004, near * 1.0038, near * 1.0008, near * 0.9996, near * 1.002, near * 1.0003, near * 0.999, near * 1.0006, near * 1.003, near * 0.9992];
  sc('touch_and_cross_in_same_poll', {
    start: at(10, 0),
    fakes: { 'market.wallFor|AAPL': [ok(W190)], 'market.dailyHistory|AAPL': [ok(H)], 'market.quotesOf': walkQuotes(walk2) },
    steps: [...setup,
      upd('AAPL', { levels: [{ price: Math.round(near * 10000) / 10000, label: '20日均线', source: 'ma20', kind: 'support', ma: { period: 20, prior_sum: Math.round(sum20 * 1e6) / 1e6 } }, extra, { price: near * 1.0025, label: '怪位', source: 'weird_src', kind: 'weird' }] }),
      call('listWatches'),
      ...walk2.flatMap((_, i) => [call('poll'), adv(15000), ...(i === 4 ? [call('forget', ['AAPL'])] : [])]), { op: 'db' }],
  });
  sc('forget_clears_session_prices', {
    start: at(10, 0),
    fakes: { 'market.wallFor|AAPL': [ok(W190)], 'market.dailyHistory|AAPL': [ok(H)], 'market.quotesOf': walkQuotes([near * 1.05, near * 1.049, near * 1.048, near * 1.0004, near * 1.0003]) },
    steps: [...setup, call('poll'), adv(15000), call('poll'), adv(15000), call('forget', ['AAPL']), call('poll'), adv(15000), call('poll'), adv(15000), call('poll'), { op: 'db' }],
  });
  const early = (t0) => Date.UTC(2026, 9, 21, 17, 0, 0) - 0 + t0; // 13:00 ET = 17:00Z
  const t1 = Date.UTC(2026, 9, 21, 16, 59, 30);
  for (const [name, settings, start] of [['early_close_touch_session_boundary', { early_close_days: ['2026-10-21'] }, t1], ['regular_day_touch_same_clock', {}, t1]]) {
    sc(name, {
      start, settings,
      fakes: {
        'market.wallFor|AAPL': [ok(W190)], 'market.dailyHistory|AAPL': [ok(H)],
        'market.quotesOf': [[near * 1.05, 0], [near * 1.049, 15000], [near * 1.0003, 35000], [near * 1.0002, 50000]].map(([p, dt]) => quotes({ AAPL: q(Math.round(p * 100) / 100, (t1 + dt) / 1000) })),
      },
      steps: [
        { op: 'store', m: 'setPref', a: ['alerts.touch_config', TCFG] }, add('AAPL', 1),
        call('refresh', [{ id: { $ref: 'AAPL' } }]),
        call('poll'), adv(15000), call('poll'), adv(20000), call('poll'), adv(15000), call('poll'), { op: 'db' },
      ],
    });
  }
  void early;
  // 碰均线的退避边界、forget 清掉的几样
  sc('touch_backoff_boundaries_and_forget', {
    start: T0,
    fakes: { 'market.dailyHistory|AAPL': [err('plain', '没权限')] },
    steps: [
      { op: 'store', m: 'setPref', a: ['alerts.touch_config', TCFG] }, add('AAPL', 1),
      call('tickTouch', [{ $now: 0 }, true]), call('tickTouch', [{ $now: 1_700_000 }, true]), call('tickTouch', [{ $now: 1_750_000 }, true]),
      call('tickTouch', [{ $now: 1_799_999 }, true]), call('tickTouch', [{ $now: 1_800_000 }, true]), call('tickTouch', [{ $now: 1_800_001 }, true]),
      call('forget', ['AAPL']), call('tickTouch', [{ $now: 1_800_002 }, true]), { op: 'db' },
    ],
  });
}
{
  const long = (c) => c.repeat(250);
  sc('level_note_is_cut_to_200', {
    start: T0,
    fakes: { 'market.wallFor|AAPL': [err('plain', long('墙'))], 'market.spotOf|AAPL': [ok(190.5)], 'market.dailyHistory|AAPL': [err('plain', long('史'))] },
    steps: [add('AAPL'), call('tickLevels', [T0, true]), call('levelsStatusOf', ['AAPL']), { op: 'db' }],
  });
  sc('events_capped_at_50', {
    start: at(10, 0),
    fakes: { 'market.quotesOf': [quotes({ AAPL: q(190.4, at(10, 0) / 1000) }), quotes({ AAPL: q(190.6, at(10, 0, 5) / 1000) }), quotes({ AAPL: q(191.3, at(10, 0, 10) / 1000) })] },
    steps: [
      add('AAPL', 1),
      upd('AAPL', { levels: pollLevels, last_price: 190.2, events: Array.from({ length: 50 }, (_, i) => ({ symbol: 'AAPL', price: i, label: 'x', source: 'round', kind: 'pivot', direction: 'up', from: 0, to: 1, at: i, text: 't' })) }),
      call('poll'), adv(5000), call('poll'), adv(5000), call('poll'), { op: 'db' },
    ],
  });
  sc('stored_states_odd_pending_shapes', {
    start: at(10, 0),
    fakes: { 'market.quotesOf': [quotes({ AAPL: q(190.4, at(10, 0) / 1000) }), quotes({ AAPL: q(190.5, at(10, 0, 5) / 1000) })] },
    steps: [
      add('AAPL', 1),
      upd('AAPL', {
        levels: pollLevels, last_price: 190.2,
        states: {
          'round@190.0000': { armed: true, last_fired_at: null, pending: { direction: 'sideways', from: 190, at: 5, minute: 0 } },
          'call_wall@191.0000': { armed: true, last_fired_at: null, pending: { direction: 'up', from: 'x', at: 5, minute: 0, close: 190.5, close_at: 5 } },
          'put_wall@189.0000': { armed: true, last_fired_at: null, pending: { direction: 'down', from: 190, at: 5, minute: 0, close: 188 } },
        },
      }),
      call('poll'), adv(5000), call('poll'),
      upd('AAPL', { states: { 'round@190.0000': { armed: true, last_fired_at: null, pending: { direction: 'up', from: 190, at: 1, minute: 0, close: 190.5 } } } }), call('poll'),
      upd('AAPL', { states: { 'round@190.0000': { armed: true, last_fired_at: null, pending: { direction: 'up', from: 190, at: 1, minute: 0, close_at: 7 } }, 'call_wall@191.0000': { armed: true, last_fired_at: null, pending: { direction: 'down', from: 190, at: 1 } } } }), call('poll'), { op: 'db' },
    ],
  });
  sc('adopt_tracked_duplicates_with_limit', {
    start: T0,
    steps: [...Array.from({ length: 30 }, (_, i) => ({ op: 'store', m: 'addWatch', a: [`T${String(i).padStart(2, '0')}`, 0, ''] })), call('adoptTracked', [['A', 'A', 'a', 'B']]), { op: 'db' }],
  });
  sc('forget_clears_last_sample', {
    start: at(10, 0),
    fakes: { 'market.quotesOf': [quotes({ AAPL: q(190.4, at(10, 0) / 1000) }), quotes({ AAPL: q(190.6, at(10, 0, 5) / 1000) }), quotes({ AAPL: q(191.4, at(10, 0, 10) / 1000) }), quotes({ AAPL: q(192.4, at(10, 0, 15) / 1000) })] },
    steps: [
      add('AAPL', 1), upd('AAPL', { levels: pollLevels, last_price: 190.2 }),
      call('poll'), adv(5000), call('poll'), call('forget', ['AAPL']), adv(5000), call('poll'), adv(5000), call('poll'), { op: 'db' },
    ],
  });
}

// ---------------------------------------------------------------- 随机交错
const updW = (sym, fields) => ({ op: 'store', m: 'updateWatch', a: [{ $watch: sym }, fields] });
function randomScenario(seed) {
  const r = rng(seed);
  const syms = ['AAPL', 'NVDA', 'TSLA', 'AMD'];
  const base = { AAPL: 190, NVDA: 480, TSLA: 400, AMD: 120, MSFT: 420, META: 590 };
  const price = { ...base };
  const start = T0 + r.int(8) * 1_800_000; // 09:20 ~ 13:20
  const fakes = {};
  const steps = [];
  const histories = {}, walls = {};
  for (const s of syms) {
    histories[s] = dailyBars(rng(seed * 7 + s.charCodeAt(0)), 45 + r.int(90), '2026-10-20', base[s], 0.01);
  }
  const added = new Set();
  let qn = 0;
  const nextQuotes = () => {
    const obj = {};
    for (const s of syms) {
      if (r.chance(0.12)) { obj[s] = null; continue; }
      price[s] *= 1 + (r.next() - 0.5) * 0.006;
      if (r.chance(0.08)) price[s] *= 1 + (r.next() - 0.5) * 0.03;
      const rounded = Math.round(price[s] * 100) / 100;
      const traded = r.chance(0.7) ? Math.floor(start / 1000) + r.int(3000) : null;
      obj[s] = q(rounded, traded, r.chance(0.1) ? 'futures' : '');
    }
    return obj;
  };
  const addQuote = () => {
    const list = (fakes['market.quotesOf'] ??= []);
    list.push(quotes(nextQuotes(), r.chance(0.2) ? r.int(300) : 0));
  };
  for (let i = 0; i < 40; i += 1) addQuote();
  for (const s of syms) {
    fakes[`market.dailyHistory|${s}`] = [r.chance(0.15) ? err('plain', '日线限速') : ok(histories[s]), ok(histories[s])];
    fakes[`market.spotOf|${s}`] = [ok(r.chance(0.2) ? null : base[s])];
    fakes[`market.wallFor|${s}`] = [r.chance(0.25) ? err('rpc', '链取不到', 0, -32017) : { __wall: s }, { __wall: s }];
  }
  const live = () => syms.filter((s) => added.has(s));
  const pick = (arr) => arr[r.int(arr.length)];
  const nOps = 45 + r.int(30);
  steps.push({ op: 'store', m: 'setPref', a: ['alerts.touch_config', r.chance(0.5) ? TOUCH_ON : { enabled: true, periods: [20], window_days: 30, min_touches: 2, band_pct: 0.3 }] });
  if (r.chance(0.4)) steps.push({ op: 'store', m: 'setPref', a: ['alerts.cross_confirm', 'bar_close'] });
  for (const s of syms.slice(0, 2 + r.int(3))) { steps.push(add(s, r.chance(0.3) ? [0, 1, 2.5, 5][r.int(4)] : 0)); added.add(s); }
  for (let i = 0; i < nOps; i += 1) {
    const roll = r.next();
    const inWindow = r.chance(0.9);
    if (roll < 0.30) steps.push(call('poll'), adv([1000, 5000, 5000, 15000, 70000][r.int(5)]));
    else if (roll < 0.40) steps.push(call('tickLevels', [{ $now: 0 }, inWindow]));
    else if (roll < 0.48) steps.push(call('tickTouch', [{ $now: 0 }, inWindow]));
    else if (roll < 0.52 && live().length) steps.push(call('refresh', [{ id: { $watch: pick(live()) }, ...(r.chance(0.3) ? { step: pick([0, 1, '2.5', 5, -1, 'x']) } : {}) }]));
    else if (roll < 0.60) steps.push(adv([60000, 600000, 1_800_000][r.int(3)]));
    else if (roll < 0.64 && live().length) steps.push(updW(pick(live()), { enabled: r.chance(0.7) }));
    else if (roll < 0.68 && live().length) steps.push(updW(pick(live()), { levels: [], levels_at: '' }));
    else if (roll < 0.71) { const s = pick(syms); if (!added.has(s)) { steps.push(add(s)); added.add(s); } }
    else if (roll < 0.74 && live().length) { const s = pick(live()); steps.push({ op: 'store', m: 'deleteWatch', a: [{ $watch: s }] }, call('forget', [s])); added.delete(s); }
    else if (roll < 0.78) steps.push(call('adoptForTrack', [pick(syms)]));
    else if (roll < 0.80) steps.push(call('releaseForTrack', [[pick(syms)]]));
    else if (roll < 0.83) steps.push({ op: 'router', set: { sessions: r.chance(0.8) } });
    else if (roll < 0.85) steps.push({ op: 'router', set: { on: r.chance(0.9) } });
    else if (roll < 0.885) steps.push(call('listWatches'));
    else if (roll < 0.90) steps.push(call('levelsStatusOf', [pick(syms)]));
    else if (roll < 0.92) steps.push(call('touchConfigChanged'));
    else if (roll < 0.94) steps.push(call('crossConfirm'));
    else if (roll < 0.96) steps.push({ op: 'settings', patch: { market_holidays: r.chance(0.5) ? ['2026-10-22', '2026-09-07'] : ['2026-09-07'] } });
    else if (roll < 0.98 && live().length) {
      const s = pick(live());
      steps.push(call('refresh', [{ id: { $watch: s } }], { id: `x${i}`, start: true }), adv(r.int(200)), call('poll'), { op: 'await', id: `x${i}` });
    } else steps.push(adv(1000 + r.int(30000)));
  }
  steps.push({ op: 'db' });
  return { name: `random_${seed}`, start, fakes, steps, _walls: walls, _syms: syms, _seed: seed };
}

for (let seed = 1; seed <= (Number(process.env.RANDOMS ?? 10)); seed += 1) {
  const s = randomScenario(seed);
  // 墙占位换成真墙(按标的现价现算)
  for (const sym of s._syms) {
    const wall = await makeWall(engineDir, rng(seed * 13 + sym.charCodeAt(0)), { AAPL: 190, NVDA: 480, TSLA: 400, AMD: 120 }[sym], sym, '20261030', s.start);
    const list = s.fakes[`market.wallFor|${sym}`];
    s.fakes[`market.wallFor|${sym}`] = list.map((e) => (e.__wall ? ok(wall) : e));
  }
  delete s._walls; delete s._syms; delete s._seed;
  scenarios.push(s);
}

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
