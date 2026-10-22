// 生成 svc_anomaly.json:engine-ts 的 AnomalyService(services/anomaly.ts)连同真的 AlertsService(services/alerts.ts),原模块现跑,
// 对着脚本驱动的假宿主的场景(约定见 svc1_world.mjs 开头)。场景照 engine-ts/tests/quality-rpc.spec.ts 里碰 AnomalyService 的那些用例写
// (大盘同期涨跌 / 开盘那一下 / 一轮 tickOnce / 循环调度),再加种子固定的随机交错。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_svc_anomaly.mjs <编过的 engine-ts 目录>
// 脚本 steps 的方法:tickOnce(nowMs?) start(intervalMs?) stop() monitor() metricsOf(sym) forget(sym) config()
// router 状态除 svc1_world 那几样之外多两个(本文件在重建 router 时处理;C++ 那边 tst_svc_anomaly.cpp 同样处理):
//   noStream  = router 没有 streamQuotes 这条路(C++ 里是立刻回空、不记日志);bare = router 没有 SUPPORTS_VOLUME_QUOTES(C++ 里是不实现 Svc1Router 的 router)
// 约定(两边微任务次序不同的地方,见 anomaly_service.h):`call … start:true` 之后的下一步必须是 advance / await,生成器在出夹具前逐场景检查。
// 虚拟时刻、节拍都取整数毫秒。
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
const OUT = process.env.OUT ?? 'svc_anomaly.json';
const only = process.env.ONLY;

const mods = await loadMods(engineDir, ['config', 'rpcError', 'broker', 'optionMarks', 'store', 'services/alerts', 'services/anomaly']);
mods.BrokerError = mods.broker.BrokerError;
mods.OptionMarksError = mods.optionMarks.OptionMarksError;
const REF = mods.anomaly.AnomalyService.MARKET_REF;

// ---------------------------------------------------------------- 跑一个场景
async function runScenario(script) {
  const world = new World(script);
  try {
    const box = { settings: makeSettings(mods.config, world) };
    const store = new mods.store.TradeStore(join(world.dir, 't.db'));
    const routerState = { ...(script.router ?? {}) };
    const ctx = { world, script, mods, engineDir, store, routerState };
    ctx.rebuildRouter = () => {
      const r = makeRouter(world, mods, routerState, () => { throw new Error('anomaly 不取会话'); });
      if (routerState.noStream) delete r.streamQuotes;
      if (routerState.bare) delete r.SUPPORTS_VOLUME_QUOTES;
      ctx.router = r;
    };
    ctx.rebuildRouter();
    const engine = { store, notifier: makeNotifier(world) };
    const host = {
      get settings() { return box.settings; },
      get router() { return routerState.on === false ? null : ctx.router; },
      get engine() { return engine; },
      emit(event, payload) { world.rec('emit', [event, payload]); },
    };
    const alerts = new mods.alerts.AlertsService(host, makeMarket(world, mods));
    const svc = new mods.anomaly.AnomalyService(host, alerts);
    ctx.setSettings = (patch) => { box.settings = makeSettings(mods.config, world, patch); };
    ctx.shape = (m, v) => (v === undefined ? null : v);
    ctx.methods = {
      tickOnce: ([nowMs]) => svc.tickOnce(nowMs ?? undefined),
      start: ([ms]) => svc.start(ms ?? undefined),
      stop: () => svc.stop(),
      monitor: () => svc.monitor(),
      metricsOf: ([s]) => svc.metricsOf(s),
      forget: ([s]) => svc.forget(s),
      config: () => svc.config(),
    };
    const steps = await runSteps(ctx);
    const db = dumpDb(engineDir, join(world.dir, 't.db'), world);
    // 场景结束时循环还在跑的:停掉(两边的 World 析构后都不再有人推钟)
    svc.stop();
    store.close();
    return { log: world.log, steps, db };
  } finally {
    world.restore();
  }
}

// ---------------------------------------------------------------- 脚本的小零件
const ok = (v, delay) => (delay ? { ok: v, delay } : { ok: v });
const err = (kind, message, delay, code) => ({ err: { kind, message, ...(code !== undefined ? { code } : {}) }, ...(delay ? { delay } : {}) });
const call = (m, a = [], extra = {}) => ({ op: 'call', m, a, ...extra });
const adv = (ms) => ({ op: 'advance', ms });
const to = (t) => ({ op: 'advance', to: t });
const tick = (t, extra) => call('tickOnce', t === undefined ? [] : [t], extra);
const addQ = (sym, note) => ({ op: 'store', m: 'addQualityStock', a: note === undefined ? [sym] : [sym, note], as: sym });
const updQ = (sym, fields) => ({ op: 'store', m: 'updateQualityStock', a: [{ $ref: sym }, fields] });
const delQ = (sym) => ({ op: 'store', m: 'deleteQualityStock', a: [{ $ref: sym }] });
const setCfg = (cfg) => ({ op: 'store', m: 'setPref', a: ['quality.config', cfg] });
const addW = (sym, step = 0) => ({ op: 'store', m: 'addWatch', a: [sym, step, ''], as: `w${sym}` });
const vq = (obj, delay) => ok(obj, delay);
const spx = (last, close, change, extra = {}) => ok({ [REF]: { last, close, change_pct: change, ...extra } });

/** 2026-09-11(周五,交易日)的美东时刻 */
const fri = (h, m, s = 0) => Date.UTC(2026, 8, 11, h + 4, m, s);
const ET_1100 = fri(11, 0), ET_1055 = fri(10, 55), ET_PRE = fri(8, 0), ET_WARM = fri(9, 25), ET_OPEN = fri(9, 30), ET_POST = fri(17, 0);
const SAT_0000 = Date.UTC(2026, 8, 12, 4, 0), SAT_1100 = Date.UTC(2026, 8, 12, 15, 0), SAT_1605 = Date.UTC(2026, 8, 12, 20, 5), SUN_1100 = Date.UTC(2026, 8, 13, 15, 0);
const MON = (h, m, s = 0) => Date.UTC(2026, 8, 14, h + 4, m, s);
const T_START = fri(3, 0);
const STALE = mods.anomaly.AnomalyService.QUOTE_STALE_MS;

/** RKLB:昨收 44、现价 48(+9.09%);90 日均量 1000 万、此刻当日量 1200 万——11:00 常态该走完 37.9%,量比 ≈ 3.2×。 */
const quote = (over = {}) => ({
  last: 48, close: 44, open: 44.5, high: 48.5, low: 44.2, volume: 12_000_000, avg_volume: 10_000_000,
  hist_vol: null, vol_3m: null, vol_5m: null, vol_10m: null, delayed: false, last_trade_at: null, ...over,
});

const scenarios = [];
const sc = (name, body) => scenarios.push({ name, start: T_START, ...body });

// 共用的盯价位数据(价位在异动轮里捎带算)
const r0 = rng(20260911);
const H_AAPL = dailyBars(rng(5), 260, '2026-09-10', 189.3, 0.012);
const W_AAPL = await makeWall(engineDir, rng(7), 190.4, 'AAPL', '20260918', fri(9, 0));
const TOUCH_ON = { enabled: true, periods: [20, 50], window_days: 10, min_touches: 3, band_pct: 0.5 };

// ---------------------------------------------------------------- 大盘同期的涨跌
sc('market_read', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })], 'router.streamQuotes': [ok({}), spx(6599.8, 6680, -1.2)] },
  steps: [addQ('RKLB'), tick(ET_1100 - 5000), tick(ET_1100), to(ET_1100), call('monitor'), call('metricsOf', ['RKLB']), { op: 'db' }],
});
sc('market_adjust_on_off', {
  fakes: {
    'router.volumeQuotes': [vq({ RKLB: quote({ volume: null, avg_volume: null }) }), vq({ RKLB: quote({ volume: null, avg_volume: null }) }),
      vq({ RKLB: quote({ last: 48.96, volume: null, avg_volume: null }) })],
    'router.streamQuotes': [spx(7147, 6680, 6.99), spx(7147.6, 6680, 7), spx(7254.8, 6680, 8.6)],
  },
  steps: [
    setCfg({ market_adjust: true }), call('config'), addQ('RKLB'),
    tick(ET_1055 - 5000), tick(ET_1055), tick(ET_1100),
    setCfg({ market_adjust: false }),
    { op: 'fake', key: 'router.streamQuotes', list: [spx(7254.9, 6680, 8.6)] },
    tick(ET_1100 + 5000), { op: 'db' },
  ],
});
sc('market_not_jumped_yet', {
  fakes: {
    'router.volumeQuotes': [vq({ RKLB: quote({ last: 47.9 }) }), vq({ RKLB: quote({ last: 47.9 }) }), vq({ RKLB: quote() }), vq({ RKLB: quote() })],
    'router.streamQuotes': [spx(6680, 6680, 0), spx(6680, 6680, 0), spx(6680, 6680, 0), spx(6612, 6680, -1.02)],
  },
  steps: [addQ('RKLB'), tick(ET_OPEN - 60_000), call('monitor'), tick(ET_OPEN + 5000), tick(ET_OPEN + 10_000), call('monitor'), tick(ET_OPEN + 15_000), call('monitor')],
});
sc('market_traded_at_open', {
  // 成交时刻过了 09:30 就算跳起来;frozen 之后给的 last_trade_at 老
  fakes: {
    'router.volumeQuotes': [vq({ RKLB: quote({ last: 47.9 }) }), vq({ RKLB: quote() })],
    'router.streamQuotes': [spx(6680, 6680, 0, { last_trade_at: (ET_OPEN - 30_000) / 1000 }), spx(6680, 6680, 0, { last_trade_at: (ET_OPEN + 2000) / 1000 }),
      spx(6690, 6680, 0.15, { last_trade_at: (ET_OPEN + 40_000) / 1000 })],
  },
  steps: [addQ('RKLB'), tick(ET_OPEN + 1000), call('monitor'), tick(ET_OPEN + 5000), call('monitor'), tick(ET_OPEN + 45_000), call('monitor'), { op: 'db' }],
});
sc('market_frozen', {
  fakes: {
    'router.volumeQuotes': [vq({ RKLB: quote({ last: 44.2, volume: null, avg_volume: null }) }), vq({ RKLB: quote({ last: 44.2, volume: null, avg_volume: null }) }),
      vq({ RKLB: quote({ volume: null, avg_volume: null }) })],
    'router.streamQuotes': [spx(7147, 6680, 6.99), spx(7147.6, 6680, 7), spx(7147.6, 6680, 7)],
  },
  steps: [
    setCfg({ market_adjust: true }), addQ('RKLB'), tick(ET_1055 - 5000), tick(ET_1055), call('monitor'),
    tick(ET_1055 + STALE + 60_000), to(ET_1055 + STALE + 60_000), call('monitor'), { op: 'db' },
  ],
});
sc('market_frozen_boundary', {
  // 刚好差 QUOTE_STALE_MS(不算冻住)与多 1 毫秒(冻住)
  fakes: {
    'router.volumeQuotes': [vq({ RKLB: quote({ volume: null, avg_volume: null }) })],
    'router.streamQuotes': [spx(7147, 6680, 6.99), spx(7147.6, 6680, 7), spx(7147.6, 6680, 7), spx(7147.6, 6680, 7)],
  },
  steps: [addQ('RKLB'), tick(ET_1055 - 5000), tick(ET_1055), call('monitor'), tick(ET_1055 + STALE), call('monitor'), tick(ET_1055 + STALE + 1), call('monitor')],
});
sc('market_reconnect', {
  fakes: {
    'router.volumeQuotes': [vq({ RKLB: quote({ last: 44.2, volume: null, avg_volume: null }) }), vq({ RKLB: quote({ last: 44.2, volume: null, avg_volume: null }) }),
      vq({ RKLB: quote({ volume: null, avg_volume: null }) })],
    'router.streamQuotes': [spx(6599.8, 6680, -1.2)],
  },
  steps: [
    addQ('RKLB'), tick(ET_1055 - 5000), tick(ET_1055), call('monitor'),
    { op: 'router', set: { sessions: false } }, tick(ET_1055 + 5000), call('monitor'),
    { op: 'router', set: { sessions: true } }, tick(ET_1055 + 10_000), tick(ET_1055 + 15_000), call('monitor'), { op: 'db' },
  ],
});
for (const [tag, setup] of [
  ['spx_null', { 'router.streamQuotes': [ok({ [REF]: null })] }],
  ['spx_missing_key', { 'router.streamQuotes': [ok({})] }],
  ['stream_throws', { 'router.streamQuotes': [err('plain', 'streamQuotes 炸了')] }],
  ['stream_returns_null', { 'router.streamQuotes': [ok(null)] }],
  ['last_null', { 'router.streamQuotes': [ok({ [REF]: { last: null, close: 6680, change_pct: null } })] }],
  ['last_zero_negative_nan', { 'router.streamQuotes': [spx(0, 6680, 0), spx(-5, 6680, 0), spx(NaN, 6680, 0), spx('6600', 6680, 1)] }],
  ['change_bad', { 'router.streamQuotes': [spx(6600, 6680, NaN), spx(6601, 6680, '1.5'), spx(6602, 6680, null)] }],
  ['no_stream_route', {}],
]) {
  sc(`market_unreadable_${tag}`, {
    router: tag === 'no_stream_route' ? { noStream: true } : {},
    fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })], ...setup },
    steps: [addQ('RKLB'), tick(ET_1100 - 5000), tick(ET_1100), call('monitor'), tick(ET_1100 + 5000), tick(ET_1100 + 10_000), call('monitor'), { op: 'db' }],
  });
}
sc('market_delayed_stock', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote({ delayed: true }) })], 'router.streamQuotes': [spx(6599.8, 6680, -1.2)] },
  steps: [addQ('RKLB'), tick(ET_1100 - 5000), tick(ET_1100), call('monitor'), { op: 'db' }],
});
sc('market_ref_before_after_session', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })], 'router.streamQuotes': [spx(6599.8, 6680, -1.2), spx(6600, 6680, -1.2), spx(6601, 6680, -1.1), spx(6602, 6680, -1.1), spx(6603, 6680, -1.1)] },
  steps: [
    addQ('RKLB'), tick(ET_WARM), call('monitor'), tick(ET_OPEN + 1000), tick(ET_OPEN + 6000), call('monitor'),
    tick(fri(16, 0, 1)), call('monitor'), tick(fri(16, 10)), call('monitor'), tick(fri(16, 25)), call('monitor'), { op: 'db' },
  ],
});

// ---------------------------------------------------------------- 开盘那一下
const watchedQ = (over = {}) => quote({ last: 47, open: 40, volume: null, avg_volume: null, ...over });
sc('open_not_yet', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: watchedQ() }), vq({ RKLB: watchedQ() }), vq({ RKLB: watchedQ() }), vq({ RKLB: watchedQ({ last: 48 }) }),
    vq({ RKLB: watchedQ({ last: 48.1, open: 47.5 }) })] },
  steps: [addQ('RKLB'), tick(ET_WARM), tick(ET_OPEN + 5000), tick(ET_OPEN + 10_000), tick(ET_OPEN + 15_000), tick(ET_OPEN + 20_000), { op: 'db' }],
});
sc('open_official_price', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: watchedQ() }), vq({ RKLB: watchedQ({ open: 47.6 }) })] },
  steps: [addQ('RKLB'), tick(ET_WARM), tick(ET_OPEN + 5000), { op: 'db' }],
});
sc('open_by_trade_time', {
  fakes: {
    'router.volumeQuotes': [vq({ RKLB: watchedQ({ last_trade_at: (ET_OPEN - 20_000) / 1000 }) }), vq({ RKLB: watchedQ({ last_trade_at: (ET_OPEN - 20_000) / 1000 }) }),
      vq({ RKLB: watchedQ({ last_trade_at: (ET_OPEN + 3000) / 1000 }) })],
  },
  steps: [addQ('RKLB'), tick(ET_WARM), tick(ET_OPEN + 5000), tick(ET_OPEN + 10_000), { op: 'db' }],
});
sc('open_started_midday', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote({ open: 47.9, volume: null, avg_volume: null }) })] },
  steps: [addQ('RKLB'), tick(ET_1100 - 5000), tick(ET_1100), { op: 'db' }],
});
sc('open_early_trade_time_waits', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote({ volume: null, avg_volume: null, last_trade_at: (ET_OPEN - 20_000) / 1000 }) })] },
  steps: [addQ('RKLB'), tick(ET_OPEN + 2000), tick(ET_OPEN + 7000), tick(ET_OPEN + 12_000), { op: 'db' }],
});
sc('open_day_rollover_and_forget', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: watchedQ() }), vq({ RKLB: watchedQ({ open: 47.6 }) }), vq({ RKLB: watchedQ({ open: 47.6 }) }), vq({ RKLB: watchedQ() }), vq({ RKLB: watchedQ({ open: 47.7 }) })] },
  steps: [addQ('RKLB'), tick(ET_WARM), tick(ET_OPEN + 5000), tick(MON(9, 25)), tick(MON(9, 30, 5)), call('forget', ['RKLB']), call('metricsOf', ['RKLB']), tick(MON(9, 31)), { op: 'db' }],
});

// ---------------------------------------------------------------- 一轮 tickOnce
sc('tick_alert_and_persist', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })] },
  steps: [addQ('RKLB'), tick(ET_1100 - 5000), tick(ET_1100), to(ET_1100), call('monitor'), call('metricsOf', ['RKLB']), call('metricsOf', ['NOPE']), tick(ET_1100 + 5000), tick(ET_1100 + 10_000), { op: 'db' }],
});
sc('tick_next_day_refires', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })] },
  steps: [addQ('RKLB'), tick(ET_1100 - 5000), tick(ET_1100), tick(ET_1100 + 55_000), tick(ET_1100 + 60_000), tick(MON(10, 55)), tick(MON(11, 0)), { op: 'db' }],
});
{
  const win = [];
  for (let i = 0; i < 10; i += 1) win.push(vq({ RKLB: quote({ last: 44 + 0.03 * i, close: 44, volume: 3_000_000 + 100_000 * i }) }));
  win.push(vq({ RKLB: quote({ last: 44.3, close: 44, volume: 4_000_000 }) }));
  sc('tick_window_burst', {
    fakes: { 'router.volumeQuotes': win },
    steps: [addQ('RKLB'), ...Array.from({ length: 10 }, (_, i) => tick(ET_1055 + i * 30_000)), tick(ET_1100), { op: 'db' }],
  });
}
sc('tick_weekend_and_warmup', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })] },
  steps: [
    addQ('RKLB'), tick(SAT_0000), tick(SAT_1100), tick(SAT_1605), tick(SUN_1100),
    to(SAT_1100), call('monitor'), tick(ET_WARM), call('metricsOf', ['RKLB']), tick(ET_PRE), call('monitor'), to(ET_PRE), call('monitor'), to(ET_WARM), call('monitor'), to(ET_POST), call('monitor'),
    { op: 'db' },
  ],
});
sc('tick_delayed_feed', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote({ delayed: true }) })] },
  steps: [addQ('RKLB'), tick(ET_1100), to(ET_1100), call('monitor'), tick(ET_1100 + 5000), tick(ET_1100 + 10_000), call('monitor'), call('metricsOf', ['RKLB']), { op: 'db' }],
});
sc('tick_delayed_clock_shift', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote({ delayed: true }) })] },
  steps: [addQ('RKLB'), tick(fri(9, 52) - 5000), tick(fri(9, 52)), { op: 'db' }],
});
sc('tick_live_at_0952', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })] },
  steps: [addQ('RKLB'), tick(fri(9, 52) - 5000), tick(fri(9, 52)), { op: 'db' }],
});
sc('tick_quote_error_entries', {
  fakes: { 'router.volumeQuotes': [vq({
    ZZZZ: { ...quote({ last: null, close: null, volume: null, avg_volume: null }), error: '未知标的' },
    RKLB: { ...quote(), error: 1 }, UBER: { ...quote(), error: '' }, NVDA: { ...quote(), error: 0 },
  })] },
  steps: [addQ('ZZZZ'), addQ('RKLB'), addQ('UBER'), addQ('NVDA'), tick(ET_1100 - 5000), tick(ET_1100), call('metricsOf', ['ZZZZ']), call('metricsOf', ['RKLB']), call('metricsOf', ['UBER']), call('metricsOf', ['NVDA']), { op: 'db' }],
});
sc('tick_odd_snapshots', {
  // null 快照在 snap.error 上抛;数、串、数组、true 当 {};缺这个代码跳过;各种非数字字段当没有
  fakes: { 'router.volumeQuotes': [vq({
    RKLB: null, UBER: 5, NVDA: 'x', AMD: [1, 2], TSLA: true,
  }), vq({
    RKLB: quote({ last: '48', close: '44', volume: '12000000', avg_volume: 1e7, delayed: 'yes', last_trade_at: '1' }),
    UBER: quote({ last: NaN, close: Infinity, volume: -5, avg_volume: 0, hist_vol: -1 }),
    NVDA: quote({ delayed: 1 }), AMD: quote({ delayed: false, last_trade_at: NaN }), TSLA: quote({ last_trade_at: Infinity }),
  })] },
  steps: [addQ('RKLB'), addQ('UBER'), addQ('NVDA'), addQ('AMD'), addQ('TSLA'), addQ('MISS'), tick(ET_1100 - 5000), call('monitor'), tick(ET_1100), call('monitor'), tick(ET_1100 + 5000),
    call('metricsOf', ['RKLB']), call('metricsOf', ['UBER']), call('metricsOf', ['MISS']), { op: 'db' }],
});
sc('tick_volume_quotes_null_and_junk', {
  fakes: { 'router.volumeQuotes': [ok(null), ok(5), ok('x'), ok([]), vq({ RKLB: quote() })] },
  steps: [addQ('RKLB'), tick(ET_1100 - 20_000), tick(ET_1100 - 15_000), tick(ET_1100 - 10_000), tick(ET_1100 - 5000), tick(ET_1100), call('monitor'), { op: 'db' }],
});
sc('tick_stale_quote', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote({ last_trade_at: (ET_1100 - 16 * 60_000) / 1000 }) }), vq({ RKLB: quote({ last_trade_at: (ET_1100 - 16 * 60_000) / 1000 }) }),
    vq({ RKLB: quote({ last_trade_at: (ET_1100 - 15 * 60_000) / 1000 }) }), vq({ RKLB: quote({ last_trade_at: (ET_1100 - 15 * 60_000 - 1) / 1000 }) }),
    vq({ RKLB: quote({ last_trade_at: (ET_1100 + 5000) / 1000 }) })] },
  steps: [addQ('RKLB'), tick(ET_1100 - 5000), tick(ET_1100), call('metricsOf', ['RKLB']), tick(ET_1100 + 1000), call('metricsOf', ['RKLB']), tick(ET_1100 + 2000), call('metricsOf', ['RKLB']),
    tick(ET_1100 + 10_000), call('metricsOf', ['RKLB']), { op: 'db' }],
});
sc('tick_session_gates', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })] },
  steps: [addQ('RKLB'), tick(fri(16, 25)), tick(fri(16, 19, 59)), tick(fri(16, 20)), tick(fri(9, 19, 59)), tick(fri(9, 20)), tick(fri(9, 25)), call('monitor'), { op: 'db' }],
});
sc('tick_disabled_and_all_off', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote(), UBER: quote({ last: 30, close: 29 }) })] },
  steps: [addQ('RKLB'), addQ('UBER'), updQ('RKLB', { enabled: false }), tick(ET_1100), tick(ET_1100 + 5000), updQ('UBER', { enabled: false }), tick(ET_1100 + 10_000), call('monitor'), call('metricsOf', ['UBER']),
    updQ('RKLB', { enabled: true }), tick(ET_1100 + 15_000), call('monitor'), { op: 'db' }],
});
sc('tick_all_off_release_throws', {
  // TS 原样:没有启用的股那一支里 releaseVolumeStreams 没有 try
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })], 'router.releaseVolumeStreams': [err('plain', '撤流炸了'), ok(0)] },
  steps: [addQ('RKLB'), tick(ET_1100 - 5000), updQ('RKLB', { enabled: false }), tick(ET_1100), call('monitor'), tick(ET_1100 + 5000), call('monitor'), { op: 'db' }],
});
sc('tick_release_throws_elsewhere', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })], 'router.releaseVolumeStreams': [err('plain', '撤流炸了')] },
  steps: [addQ('RKLB'), tick(ET_1100 - 5000), tick(ET_1100), tick(fri(17, 0)), call('monitor'), { op: 'db' }],
});
sc('tick_delete_while_waiting', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() }, 80)] },
  steps: [addQ('RKLB'), call('tickOnce', [ET_1100], { id: 'a', start: true }), adv(20), delQ('RKLB'), { op: 'await', id: 'a' }, call('monitor'), { op: 'db' }],
});
sc('tick_disable_while_waiting_other_enabled', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote(), UBER: quote() }, 80), vq({ RKLB: quote(), UBER: quote() })] },
  steps: [addQ('RKLB'), addQ('UBER'), tick(ET_1100 - 5000), call('tickOnce', [ET_1100], { id: 'a', start: true }), adv(20), updQ('UBER', { enabled: false }), { op: 'await', id: 'a' }, call('metricsOf', ['UBER']), { op: 'db' }],
});
sc('tick_no_router_and_not_supported', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })] },
  steps: [
    addQ('RKLB'), { op: 'router', set: { on: false } }, tick(ET_1100), call('monitor'),
    { op: 'router', set: { on: true, volume: false } }, tick(ET_1100 + 5000), call('monitor'),
    { op: 'router', set: { volume: true, bare: true } }, tick(ET_1100 + 10_000), call('monitor'),
    { op: 'router', set: { bare: false, sessions: false } }, tick(ET_1100 + 15_000), call('monitor'),
    { op: 'router', set: { sessions: true } }, tick(ET_1100 + 20_000), tick(ET_1100 + 25_000), call('monitor'),
    { op: 'settings', patch: { broker: { provider: 'futu' }, connections: { futu: { host: '127.0.0.1', port: 11111, client_id: 13, broker: 'futu' } } } }, { op: 'router', set: { on: false } }, call('monitor'), { op: 'db' },
  ],
});
sc('tick_fetch_error_logging', {
  // 同一句错误只记一行;换一句再记;好了不记
  fakes: { 'router.volumeQuotes': [err('plain', 'TWS 在 12 秒内没有响应'), err('plain', 'TWS 在 12 秒内没有响应'), err('plain', '另一句'), err('rpc', '长'.repeat(260), 0, -32017),
    vq({ RKLB: quote() }), vq({ RKLB: quote() }), vq({ RKLB: quote() })] },
  steps: [addQ('RKLB'), tick(ET_1100 - 25_000), tick(ET_1100 - 20_000), tick(ET_1100 - 15_000), tick(ET_1100 - 10_000), call('monitor'), tick(ET_1100 - 5000), tick(ET_1100), call('monitor'), { op: 'db' }],
});
sc('tick_per_stock_error', {
  // 一只股库里的状态烂得 coerceState 都没法处理的不存在;这里用 null 快照让它抛,别的股照常
  fakes: { 'router.volumeQuotes': [vq({ RKLB: null, UBER: quote(), NVDA: null })] },
  steps: [addQ('RKLB'), addQ('UBER'), addQ('NVDA'), tick(ET_1100 - 5000), call('monitor'), tick(ET_1100), call('monitor'), tick(ET_1100 + 5000), { op: 'db' }],
});
sc('tick_stored_state_variants', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote(), UBER: quote(), NVDA: quote(), AMD: quote(), TSLA: quote(), META: quote() })] },
  steps: [
    addQ('RKLB'), addQ('UBER'), addQ('NVDA'), addQ('AMD'), addQ('TSLA'), addQ('META'),
    updQ('RKLB', { states: { date: '2026-09-10', rvol_fired: 5, day_up_fired: 3, day_down_fired: 0, max_step_share: 0.1, burst: { armed: false, last_fired_at: 1 }, spike: { armed: false, last_fired_at: 2 } } }),
    updQ('UBER', { states: { date: '2026-09-11', rvol_fired: 3, day_up_fired: 3, day_down_fired: 0, max_step_share: 0, burst: { armed: true, last_fired_at: null }, spike: { armed: true, last_fired_at: null } } }),
    updQ('NVDA', { states: [] }), updQ('AMD', { states: { date: 5, rvol_fired: '3' } }), updQ('TSLA', { states: { weird: 1 } }), updQ('META', { states: 'text' }),
    tick(ET_1100 - 5000), tick(ET_1100), { op: 'db' },
  ],
});
sc('tick_events_trimmed_to_50', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote(), UBER: quote() })] },
  steps: [
    addQ('RKLB'), addQ('UBER'),
    updQ('RKLB', { events: Array.from({ length: 50 }, (_, i) => ({ id: `old${i}`, kind: 'rvol' })) }),
    updQ('UBER', { events: [] }),
    tick(ET_1100 - 5000), tick(ET_1100), { op: 'db' },
  ],
});
sc('tick_default_time_from_clock', {
  start: ET_1100 - 5000,
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })] },
  steps: [addQ('RKLB'), tick(), adv(5000), tick(), call('monitor'), adv(5000), tick(), { op: 'db' }],
});
sc('tick_early_close_day', {
  settings: { early_close_days: ['2026-09-11'] },
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })] },
  steps: [addQ('RKLB'), tick(fri(12, 50)), tick(fri(12, 55)), tick(fri(13, 0)), tick(fri(13, 19, 59)), tick(fri(13, 20)), tick(fri(14, 0)), { op: 'db' }],
});
sc('tick_holiday', {
  settings: { market_holidays: ['2026-09-11'] },
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })] },
  steps: [addQ('RKLB'), tick(ET_1100 - 5000), tick(ET_1100), to(ET_1100), call('monitor'), { op: 'settings', patch: { market_holidays: [] } }, tick(ET_1100 + 5000), tick(ET_1100 + 10_000), { op: 'db' }],
});
sc('tick_config_variants', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })] },
  steps: [
    call('config'), setCfg({ burst_ratio: 6, window_min: 10 }), call('config'), setCfg({ rvol_tiers: [9, 2, 3] }), call('config'), setCfg({ window_min: 4 }), call('config'),
    setCfg('garbage'), call('config'), setCfg([1, 2]), call('config'), setCfg(null), call('config'), setCfg({ cooldown_min: 0.5 }), call('config'),
    setCfg({ rvol_tiers: [1.5, 2.5, 4] }), addQ('RKLB'), tick(ET_1100 - 5000), tick(ET_1100), { op: 'db' },
  ],
});
sc('tick_hist_vol_sigma_tiers', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote({ hist_vol: 0.6, vol_5m: 900_000, vol_3m: 500_000, vol_10m: 1_500_000 }) }), vq({ RKLB: quote({ hist_vol: 0.6, last: 49, vol_5m: 900_000 }) }),
    vq({ RKLB: quote({ hist_vol: 0.6, last: 50.5, volume: 14_000_000 }) })] },
  steps: [addQ('RKLB'), tick(ET_1100 - 300_000), tick(ET_1100 - 5000), tick(ET_1100), tick(ET_1100 + 5000), tick(ET_1100 + 60_000), { op: 'db' }],
});

// ---------------------------------------------------------------- 价位在异动轮里捎带算
sc('levels_in_tick', {
  fakes: {
    'router.volumeQuotes': [vq({ RKLB: quote() })], 'market.wallFor|*': [ok(W_AAPL)], 'market.dailyHistory|*': [ok(H_AAPL)],
  },
  steps: [addW('AAPL'), addQ('RKLB'), tick(ET_1100 - 5000), tick(ET_1100), tick(ET_1100 + 5000), tick(ET_1100 + 10_000), call('monitor'), { op: 'db' }],
});
sc('levels_in_tick_then_touch', {
  fakes: {
    'router.volumeQuotes': [vq({ RKLB: quote() })], 'market.wallFor|*': [ok(W_AAPL)], 'market.dailyHistory|*': [ok(H_AAPL)],
  },
  steps: [
    { op: 'store', m: 'setPref', a: ['alerts.touch_config', TOUCH_ON] }, addW('AAPL'), addQ('RKLB'),
    tick(ET_1100 - 5000), tick(ET_1100), tick(ET_1100 + 5000), tick(ET_1100 + 700_000), tick(ET_1100 + 710_000), tick(ET_1100 + 1_900_000), { op: 'db' },
  ],
});
sc('levels_in_tick_failure_and_gates', {
  fakes: {
    'router.volumeQuotes': [vq({ RKLB: quote() })], 'market.wallFor|*': [err('rpc', '链取不到', 0, -32017)], 'market.spotOf|*': [ok(null)], 'market.dailyHistory|*': [err('plain', '日线限速')],
  },
  steps: [
    addW('AAPL'), addQ('RKLB'), tick(ET_1100 - 5000), tick(ET_1100), tick(SAT_1100), { op: 'router', set: { sessions: false } }, tick(ET_1100 + 5000),
    { op: 'router', set: { sessions: true, volume: false } }, tick(ET_1100 + 6000), tick(ET_1100 + 700_000), { op: 'db' },
  ],
});
sc('levels_alerts_throws_into_last_error', {
  // 价位那边的库行烂了(levels 不是数组也不是 null):tickLevels 里 .length 抛,落到异动这一轮的 catch
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })], 'market.wallFor|*': [ok(W_AAPL)], 'market.dailyHistory|*': [ok(H_AAPL)] },
  steps: [addW('AAPL'), addQ('RKLB'), { op: 'store', m: 'updateWatch', a: [{ $ref: 'wAAPL' }, { levels: 5 }] }, tick(ET_1100 - 5000), call('monitor'), tick(ET_1100), call('monitor'), { op: 'db' }],
});

// ---------------------------------------------------------------- 循环调度
sc('loop_slow_tick_never_overlaps', {
  start: ET_1100 - 1000,
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() }, 120)] },
  steps: [addQ('RKLB'), call('start', [40]), call('start', [40]), adv(600), call('monitor'), call('stop'), call('monitor'), adv(500), call('monitor'), { op: 'db' }],
});
sc('loop_default_interval', {
  start: ET_1100 - 20_000,
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })] },
  steps: [addQ('RKLB'), call('start'), adv(1), call('monitor'), adv(30_000), call('monitor'), call('stop'), adv(20_000), { op: 'db' }],
});
sc('loop_fetch_always_throws', {
  start: ET_1100,
  fakes: { 'router.volumeQuotes': [err('plain', 'boom')] },
  steps: [addQ('RKLB'), call('start', [20]), adv(300), call('stop'), call('monitor'), { op: 'db' }],
});
sc('loop_restart_and_stop_mid_tick', {
  start: ET_1100 - 30_000,
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() }, 3000)] },
  steps: [
    addQ('RKLB'), call('start', [5000]), adv(1000), call('stop'), call('monitor'), adv(5000), call('monitor'),
    call('start', [2000]), adv(100), call('start', [9999]), adv(4000), call('stop'), call('start', [1000]), adv(10_000), call('stop'), adv(20_000), call('monitor'), { op: 'db' },
  ],
});
sc('loop_with_manual_ticks', {
  start: ET_1100 - 30_000,
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() }, 700)] },
  steps: [
    addQ('RKLB'), call('start', [1000]), adv(300), call('tickOnce', [ET_1100], { id: 'm1', start: true }), call('tickOnce', [ET_1100 + 1], { id: 'm2', start: true }), adv(50),
    { op: 'await', id: 'm1' }, { op: 'await', id: 'm2' }, adv(5000), call('stop'), adv(5000), { op: 'db' },
  ],
});
sc('loop_with_levels_and_changing_state', {
  start: ET_1100 - 30_000,
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })], 'market.wallFor|*': [ok(W_AAPL, 40)], 'market.dailyHistory|*': [ok(H_AAPL, 30)] },
  steps: [
    addW('AAPL'), addQ('RKLB'), call('start', [5000]), adv(12_000), updQ('RKLB', { enabled: false }), adv(10_000), updQ('RKLB', { enabled: true }), adv(10_000),
    { op: 'router', set: { sessions: false } }, adv(10_000), { op: 'router', set: { sessions: true } }, adv(10_000), call('stop'), call('monitor'), { op: 'db' },
  ],
});
sc('loop_tick_after_stop_not_rescheduled', {
  start: ET_1100 - 30_000,
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() }, 400)] },
  steps: [addQ('RKLB'), call('start', [100]), adv(150), call('stop'), adv(2000), call('monitor'), call('start', [100]), adv(150), call('stop'), call('start', [100]), adv(2000), call('stop'), { op: 'db' }],
});

// ---------------------------------------------------------------- 并发
sc('concurrent_ticks', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() }, 300), vq({ RKLB: quote() }, 100), vq({ RKLB: quote() }, 10)] },
  steps: [
    addQ('RKLB'),
    call('tickOnce', [ET_1100 - 5000], { id: 'a', start: true }), call('tickOnce', [ET_1100], { id: 'b', start: true }), call('tickOnce', [], { id: 'c', start: true }), adv(10),
    { op: 'await', id: 'c' }, { op: 'await', id: 'a' }, { op: 'await', id: 'b' }, call('monitor'), { op: 'db' },
  ],
});
sc('concurrent_ticks_with_failure', {
  fakes: { 'router.volumeQuotes': [err('plain', '第一轮炸', 200), vq({ RKLB: quote() }, 100), vq({ RKLB: quote() })] },
  steps: [
    addQ('RKLB'),
    call('tickOnce', [ET_1100 - 5000], { id: 'a', start: true }), call('tickOnce', [ET_1100], { id: 'b', start: true }), call('tickOnce', [ET_1100 + 5000], { id: 'c', start: true }), adv(1),
    { op: 'await', id: 'b' }, { op: 'await', id: 'a' }, { op: 'await', id: 'c' }, call('monitor'), { op: 'db' },
  ],
});

// ---------------------------------------------------------------- 变异检验补的场景(幸存变异逐个对着写)
const q6 = (over = {}) => quote({ volume: null, avg_volume: null, ...over });
sc('err_cleared_on_disconnect', {
  fakes: { 'router.volumeQuotes': [err('plain', '取行情炸了'), vq({ RKLB: quote() })] },
  steps: [addQ('RKLB'), tick(ET_1100 - 5000), call('monitor'), { op: 'router', set: { sessions: false } }, tick(ET_1100), call('monitor'), { op: 'router', set: { sessions: true } }, tick(ET_1100 + 5000), call('monitor')],
});
sc('err_cleared_on_no_enabled', {
  fakes: { 'router.volumeQuotes': [err('plain', '取行情炸了'), vq({ RKLB: quote() })] },
  steps: [addQ('RKLB'), tick(ET_1100 - 5000), call('monitor'), updQ('RKLB', { enabled: false }), tick(ET_1100), call('monitor')],
});
sc('err_cleared_on_unsupported_and_outside', {
  fakes: { 'router.volumeQuotes': [err('plain', '取行情炸了'), err('plain', '又炸了')] },
  steps: [addQ('RKLB'), tick(ET_1100 - 5000), { op: 'router', set: { volume: false } }, tick(ET_1100), call('monitor'), { op: 'router', set: { volume: true } },
    tick(ET_1100 + 5000), tick(ET_POST), call('monitor')],
});
sc('long_release_error_sliced_200', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })], 'router.releaseVolumeStreams': [err('plain', '长'.repeat(260))] },
  steps: [addQ('RKLB'), updQ('RKLB', { enabled: false }), tick(ET_1100), call('monitor')],
});
sc('long_fetch_error_sliced_200_exact', {
  fakes: { 'router.volumeQuotes': [err('plain', 'a'.repeat(200)), err('plain', 'b'.repeat(201))] },
  steps: [addQ('RKLB'), tick(ET_1100), call('monitor'), tick(ET_1100 + 5000), call('monitor')],
});
sc('long_release_error_exact_200_201', {
  fakes: { 'router.releaseVolumeStreams': [err('plain', 'c'.repeat(200)), err('plain', 'd'.repeat(201)), err('plain', 'e'.repeat(199))] },
  steps: [addQ('RKLB'), updQ('RKLB', { enabled: false }), tick(ET_1100), call('monitor'), tick(ET_1100 + 5000), call('monitor'), tick(ET_1100 + 10_000), call('monitor')],
});
sc('per_stock_long_error_sliced_120', {
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })] },
  steps: [
    addQ('RKLB'),
    { op: 'store', m: 'rawExec', a: [`CREATE TRIGGER boom BEFORE UPDATE ON quality_stocks BEGIN SELECT RAISE(ABORT, '${'x'.repeat(130)}'); END`] },
    tick(ET_1100 - 5000), tick(ET_1100), call('monitor'),
  ],
});
for (const n of [119, 120, 121, 122]) {
  sc(`per_stock_error_len_${n}`, {
    fakes: { 'router.volumeQuotes': [vq({ RKLB: quote() })] },
    steps: [
      addQ('RKLB'),
      { op: 'store', m: 'rawExec', a: [`CREATE TRIGGER boom BEFORE UPDATE ON quality_stocks BEGIN SELECT RAISE(ABORT, '${'y'.repeat(n)}'); END`] },
      tick(ET_1100 - 5000), tick(ET_1100), call('monitor'),
    ],
  });
}
sc('sub_dollar_open_and_prices', {
  fakes: { 'router.volumeQuotes': [vq({ PENY: q6({ last: 0.45, close: 0.4, open: 0.3 }) }), vq({ PENY: q6({ last: 0.45, close: 0.4, open: 0.46 }) }), vq({ PENY: q6({ last: 0.52, close: 0.4, open: 0.46 }) })] },
  steps: [addQ('PENY'), tick(ET_WARM), tick(ET_OPEN + 5000), tick(ET_OPEN + 10_000), call('metricsOf', ['PENY']), { op: 'db' }],
});
sc('exact_open_minute_and_market_ref', {
  fakes: {
    'router.volumeQuotes': [vq({ RKLB: watchedQ() }), vq({ RKLB: watchedQ({ last: 48, last_trade_at: ET_OPEN / 1000 }) })],
    'router.streamQuotes': [spx(6600, 6680, -1.2), spx(6600, 6680, -1.2, { last_trade_at: ET_OPEN / 1000 })],
  },
  start: ET_OPEN - 1000,
  steps: [addQ('RKLB'), tick(ET_WARM), tick(ET_OPEN), call('monitor'), { op: 'db' }],
});
sc('exact_session_end_market_ref', {
  start: fri(15, 59, 50),
  fakes: {
    'router.volumeQuotes': [vq({ RKLB: q6() })],
    'router.streamQuotes': [spx(6600, 6680, -1.2), spx(6601, 6680, -1.2), spx(6602, 6680, -1.2, { last_trade_at: fri(15, 59, 55) / 1000 }), spx(6603, 6680, -1.1, { last_trade_at: fri(16, 0, 0) / 1000 })],
  },
  steps: [addQ('RKLB'), tick(fri(9, 35)), tick(fri(9, 36)), tick(fri(15, 59, 55)), call('monitor'), tick(fri(16, 0, 0)), call('monitor'), tick(fri(16, 0, 5)), call('monitor')],
});
sc('exact_session_end_early_close', {
  settings: { early_close_days: ['2026-09-11'] }, start: fri(12, 59, 50),
  fakes: {
    'router.volumeQuotes': [vq({ RKLB: q6() })],
    'router.streamQuotes': [spx(6600, 6680, -1.2), spx(6601, 6680, -1.2), spx(6602, 6680, -1.2, { last_trade_at: fri(12, 59, 55) / 1000 }), spx(6603, 6680, -1.1, { last_trade_at: fri(13, 0, 0) / 1000 })],
  },
  steps: [addQ('RKLB'), tick(fri(9, 35)), tick(fri(9, 36)), tick(fri(12, 59, 55)), call('monitor'), tick(fri(13, 0, 0)), call('monitor'), tick(fri(13, 0, 5)), call('monitor')],
});
sc('early_close_rvol_session_210', {
  settings: { early_close_days: ['2026-09-11'] },
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote({ last: 44.1 }) }), vq({ RKLB: quote({ last: 44.1 }) })] },
  steps: [addQ('RKLB'), tick(fri(11, 15) - 5000), tick(fri(11, 15)), call('metricsOf', ['RKLB']), tick(fri(11, 15) + 5000), call('metricsOf', ['RKLB']), { op: 'db' }],
});
sc('delayed_truthy_non_true', {
  start: ET_1100 - 1000,
  fakes: { 'router.volumeQuotes': [vq({ RKLB: quote({ delayed: 1 }) })] },
  steps: [addQ('RKLB'), tick(ET_1100 - 5000), tick(ET_1100), call('monitor')],
});
sc('empty_branch_clears_samples_and_delayed', {
  start: ET_1100 - 1000,
  fakes: { 'router.volumeQuotes': [vq({ RKLB: q6({ last: 44.1, delayed: true }) }), vq({ RKLB: q6({ last: 44.1, delayed: true }) }), vq({ RKLB: q6({ last: 48 }) }), vq({ RKLB: q6({ last: 48 }) })] },
  steps: [
    addQ('RKLB'), tick(ET_1100 - 10_000), tick(ET_1100 - 5000), call('monitor'), updQ('RKLB', { enabled: false }), tick(ET_1100), call('monitor'),
    updQ('RKLB', { enabled: true }), tick(ET_1100 + 5000), call('metricsOf', ['RKLB']), tick(ET_1100 + 10_000), { op: 'db' },
  ],
});
sc('unsupported_and_disconnected_clear_samples', {
  start: ET_1100 - 1000,
  fakes: { 'router.volumeQuotes': [vq({ RKLB: q6({ last: 44.1 }) }), vq({ RKLB: q6({ last: 44.1 }) }), vq({ RKLB: q6({ last: 48 }) }), vq({ RKLB: q6({ last: 48 }) })] },
  steps: [
    addQ('RKLB'), tick(ET_1100 - 10_000), tick(ET_1100 - 5000), { op: 'router', set: { volume: false } }, tick(ET_1100), { op: 'router', set: { volume: true } },
    tick(ET_1100 + 5000), call('metricsOf', ['RKLB']), tick(ET_1100 + 10_000),
    tick(ET_1100 + 15_000), { op: 'router', set: { sessions: false } }, tick(ET_1100 + 20_000), { op: 'router', set: { sessions: true } }, tick(ET_1100 + 25_000), tick(ET_1100 + 30_000), { op: 'db' },
  ],
});
for (const [w, key] of [[3, 'vol_3m'], [5, 'vol_5m'], [10, 'vol_10m']]) {
  sc(`stream_window_${w}`, {
    fakes: { 'router.volumeQuotes': Array.from({ length: 8 }, (_, i) => vq({ RKLB: quote({ last: 44 + 0.02 * i, close: 44, volume: 2_000_000 + 50_000 * i, avg_volume: 10_000_000, high: 50 + i, low: 40, [key]: 3_000_000 + i * 100_000 }) })) },
    steps: [setCfg({ window_min: w }), addQ('RKLB'), ...Array.from({ length: 8 }, (_, i) => tick(ET_1100 + i * 5000)), call('metricsOf', ['RKLB']), { op: 'db' }],
  });
}

// ---------------------------------------------------------------- 随机交错
const POOL = ['RKLB', 'UBER', 'NVDA', 'AMD', 'TSLA', 'META'];
function randomScenario(seed) {
  const r = rng(seed);
  const dayKind = r.pick(['normal', 'normal', 'normal', 'normal', 'early', 'holiday', 'weekend', 'monday']);
  const day = { normal: 11, early: 11, holiday: 11, weekend: 12, monday: 14 }[dayKind];
  const openMs = Date.UTC(2026, 8, day, 13, 30);
  const settings = {};
  if (dayKind === 'early') settings.early_close_days = ['2026-09-11'];
  if (dayKind === 'holiday') settings.market_holidays = ['2026-09-07', '2026-09-11'];
  const start = openMs - 3 * 3600_000;
  const steps = [];
  const fakes = {};
  const stocks = new Map(); // sym -> {price, close, vol, delayed}
  const live = () => [...stocks.keys()];
  let enabledSet = new Set();
  let cursor = r.chance(0.7) ? r.int(300) * 60_000 : -40 * 60_000; // 相对开盘的毫秒
  let modelT = start;
  const abs = () => openMs + cursor;
  const advanceCursor = () => {
    const roll = r.next();
    if (roll < 0.05) cursor += (20 + r.int(40)) * 60_000;
    else if (roll < 0.25) cursor += (1 + r.int(5)) * 60_000;
    else cursor += (1 + r.int(12)) * 5000;
    if (cursor > 440 * 60_000) cursor = -40 * 60_000 + r.int(60) * 60_000; // 回到开盘前(时钟倒退也是现实:测试传固定时刻)
  };
  // 假数据:每支股一条路径
  const mk = (sym) => ({ price: 40 + r.int(1200) / 100, close: 44, vol: 1_000_000 + r.int(2_000_000), delayed: r.chance(0.12), hv: r.chance(0.4) ? 0.3 + r.next() * 0.5 : null });
  const snapOf = (sym, t) => {
    const st = stocks.get(sym) ?? mk(sym);
    stocks.set(sym, st);
    st.price *= 1 + (r.next() - 0.5) * 0.006;
    if (r.chance(0.07)) st.price *= 1 + (r.next() - 0.5) * 0.04;
    st.vol += Math.round(r.next() * 400_000) * (r.chance(0.08) ? 6 : 1);
    const roll = r.next();
    if (roll < 0.03) return null;
    if (roll < 0.06) return 5;
    if (roll < 0.10) return { ...quote({ last: null, close: null, volume: null, avg_volume: null }), error: r.pick(['未知标的', '流被拒', 1]) };
    const q = quote({
      last: Math.round(st.price * 100) / 100, close: st.close, open: r.chance(0.5) ? 40 + r.int(800) / 100 : null, volume: st.vol,
      avg_volume: r.chance(0.9) ? 10_000_000 : r.pick([null, 0, NaN, '1e7']), hist_vol: st.hv,
      vol_5m: r.chance(0.2) ? r.int(1_000_000) : null, delayed: st.delayed || r.chance(0.02),
      last_trade_at: r.chance(0.4) ? Math.floor(t / 1000) - r.pick([0, 3, 30, 400, 1500]) : (r.chance(0.05) ? NaN : null),
    });
    if (r.chance(0.04)) q.last = r.pick([0, -1, NaN, '48']);
    return q;
  };
  const volEntry = (t) => {
    const obj = {};
    for (const sym of POOL) {
      if (r.chance(0.04)) continue;
      const s = snapOf(sym, t);
      obj[sym] = s;
    }
    return ok(obj, r.chance(0.15) ? r.int(2500) : 0);
  };
  let spxLast = 6600;
  const spxEntry = (t) => {
    const roll = r.next();
    if (roll < 0.08) return ok({});
    if (roll < 0.12) return err('plain', 'spx 取不到');
    if (roll < 0.16) return ok(null);
    if (roll < 0.20) return ok({ [REF]: { last: null, close: 6600, change_pct: null } });
    if (roll < 0.35) return spx(spxLast, 6600, (spxLast / 6600 - 1) * 100, { last_trade_at: Math.floor(t / 1000) });
    spxLast *= 1 + (r.next() - 0.5) * 0.004;
    return spx(Math.round(spxLast * 10) / 10, 6600, r.chance(0.9) ? Math.round((spxLast / 6600 - 1) * 10000) / 100 : NaN, r.chance(0.5) ? { last_trade_at: Math.floor(t / 1000) - r.int(60) } : {});
  };
  const refill = () => {
    fakes['router.volumeQuotes'] = Array.from({ length: 14 }, (_, i) => (r.chance(0.04) ? err('plain', r.pick(['TWS 在 12 秒内没有响应', '限速'])) : volEntry(openMs + (i * 400_000) - 40 * 60_000)));
    fakes['router.streamQuotes'] = Array.from({ length: 14 }, (_, i) => spxEntry(openMs + (i * 400_000) - 40 * 60_000));
    if (r.chance(0.3)) fakes['router.releaseVolumeStreams'] = [ok(0), ok(0), err('plain', '撤流炸了'), ok(1), ok(0)];
  };
  refill();
  fakes['market.wallFor|*'] = [ok(W_AAPL)];
  fakes['market.dailyHistory|*'] = [ok(H_AAPL)];
  const cfgs = [{ burst_ratio: 3 }, { window_min: 10, cooldown_min: 1 }, { market_adjust: true }, { rvol_tiers: [1.5, 2.5, 4] }, { market_adjust: true, window_min: 3, spike_sigma: 2 }, { window_min: 4 }, 'junk', null, { day_fixed_tiers: [1, 2, 3], day_sigma_tiers: [0.5, 1] }];
  let hasWatch = false;
  const nOps = 40 + r.int(30);
  const addStock = (sym) => { steps.push(addQ(sym)); stocks.set(sym, stocks.get(sym) ?? mk(sym)); enabledSet.add(sym); };
  const present = new Set();
  for (const sym of POOL.slice(0, 2 + r.int(4))) { addStock(sym); present.add(sym); }
  if (r.chance(0.5)) steps.push(setCfg(r.pick(cfgs)));
  if (r.chance(0.3)) { steps.push({ op: 'store', m: 'setPref', a: ['alerts.touch_config', TOUCH_ON] }); }
  const syncT = () => { if (abs() > modelT) { steps.push(to(abs())); modelT = abs(); } };
  const pickPresent = () => r.pick([...present]);
  for (let i = 0; i < nOps; i += 1) {
    const roll = r.next();
    if (roll < 0.36) {
      advanceCursor();
      if (r.chance(0.2)) {
        // 启动之后下一步必须是 advance:两个并发的一轮
        steps.push(call('tickOnce', [abs()], { id: `t${i}a`, start: true }));
        if (r.chance(0.5)) steps.push(call('tickOnce', [abs() + 1000], { id: `t${i}b`, start: true }));
        const d = r.int(30);
        steps.push(adv(d)); modelT += d;
        steps.push({ op: 'await', id: `t${i}a` });
        if (steps.some((s) => s.id === `t${i}b`)) steps.push({ op: 'await', id: `t${i}b` });
      } else steps.push(tick(abs()));
    } else if (roll < 0.40) { syncT(); steps.push(tick()); }
    else if (roll < 0.47) { syncT(); steps.push(call('monitor')); }
    else if (roll < 0.51 && present.size) steps.push(call('metricsOf', [pickPresent()]));
    else if (roll < 0.53) steps.push(call('config'));
    else if (roll < 0.56 && present.size) steps.push(call('forget', [pickPresent()]));
    else if (roll < 0.60) {
      const free = POOL.filter((s) => !present.has(s));
      if (free.length) { const s = r.pick(free); addStock(s); present.add(s); }
    } else if (roll < 0.64 && present.size) { const s = pickPresent(); steps.push(updQ(s, { enabled: r.chance(0.5) })); }
    else if (roll < 0.67 && present.size) { const s = pickPresent(); steps.push(delQ(s)); present.delete(s); if (r.chance(0.5)) steps.push(call('forget', [s])); }
    else if (roll < 0.70) steps.push(setCfg(r.pick(cfgs)));
    else if (roll < 0.72) steps.push({ op: 'settings', patch: r.pick([{ market_holidays: ['2026-09-07', '2026-09-11'] }, { market_holidays: ['2026-09-07'] }, { early_close_days: ['2026-09-11'] }, { early_close_days: ['2026-11-27'] }]) });
    else if (roll < 0.76) {
      const [brk, fix] = r.pick([[{ sessions: false }, { sessions: true }], [{ on: false }, { on: true }], [{ volume: false }, { volume: true }], [{ bare: true }, { bare: false }], [{ noStream: true }, { noStream: false }]]);
      steps.push({ op: 'router', set: brk });
      advanceCursor(); steps.push(tick(abs()));
      if (r.chance(0.85)) steps.push({ op: 'router', set: fix });
    }
    else if (roll < 0.79 && !hasWatch) { steps.push(addW('AAPL')); hasWatch = true; }
    else if (roll < 0.81 && hasWatch) steps.push({ op: 'store', m: 'updateWatch', a: [{ $watch: 'AAPL' }, { levels: [], levels_at: '' }] });
    else if (roll < 0.83) steps.push({ op: 'fake', key: 'router.streamQuotes', list: [spxEntry(abs()), spxEntry(abs() + 5000)] });
    else if (roll < 0.85) steps.push({ op: 'fake', key: 'router.releaseVolumeStreams', list: [r.chance(0.5) ? err('plain', '撤流炸了') : ok(0)] });
    else if (roll < 0.87) refill(), steps.push({ op: 'fake', key: 'router.volumeQuotes', list: fakes['router.volumeQuotes'].slice(0, 12) });
    else if (roll < 0.95) {
      // 循环:从当前钟点起几个节拍,中间插一步别的再停
      syncT();
      const interval = r.pick([1000, 2000, 5000]);
      steps.push(call('start', [interval]));
      const n = 1 + r.int(4);
      for (let k = 0; k < n; k += 1) {
        const d = r.pick([1, 500, 1000, 2500, 5000, 5000]); steps.push(adv(d)); modelT += d;
        if (r.chance(0.2) && present.size) steps.push(updQ(pickPresent(), { enabled: r.chance(0.6) }));
        if (r.chance(0.15)) steps.push(call('start', [interval * 2]));
        if (r.chance(0.2)) steps.push(call('monitor'));
        if (r.chance(0.15)) { steps.push(tick(modelT)); }
      }
      if (r.chance(0.8)) steps.push(call('stop'));
      cursor = Math.max(cursor, modelT - openMs);
    } else { const d = 1000 + r.int(30000); steps.push(adv(d)); modelT += d; }
  }
  steps.push(call('stop'), { op: 'db' });
  return { name: `random_${seed}`, start, settings, fakes, steps };
}

for (let seed = 1; seed <= Number(process.env.RANDOMS ?? 18); seed += 1) scenarios.push(randomScenario(seed));

// ---------------------------------------------------------------- 约定检查:start:true 之后下一步必须是 advance / await
for (const s of scenarios) {
  s.steps.forEach((step, i) => {
    if (step.op === 'call' && step.start) {
      const next = s.steps[i + 1];
      const okNext = next && (next.op === 'advance' || next.op === 'await' || (next.op === 'call' && next.start));
      if (!okNext) throw new Error(`${s.name}: start:true 之后的第 ${i + 1} 步必须是 advance / await`);
    }
  });
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
