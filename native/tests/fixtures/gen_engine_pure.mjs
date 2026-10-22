// 生成 engine_pure.json:engine-ts 的 engine/closing、spotStop、sessionHours、localShorthand、clock、heartbeat(原模块现跑)在手写与种子固定的随机输入上的答案。
// 假 router 是脚本驱动的:{caps, 各方法的结果队列 [{v}|{throw}],用完重复最后一条},调用的先后与参数一并记下。C++ 一半:tst_engine_pure.cpp。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_engine_pure.mjs <编过的 engine-ts 目录>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASE_CONFIG, deepMerge, enc, rng } from './engine_world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const imp = (f) => import(pathToFileURL(join(engine, `dist/src/${f}.js`)).href);
const hostedMod = await imp('engine/hosted');
const [closing, spotStop, hours, localShorthand, clock, heartbeat, config, tk, positions] =
  await Promise.all(['engine/closing', 'engine/spotStop', 'engine/sessionHours', 'engine/localShorthand', 'engine/clock', 'engine/heartbeat', 'config', 'tracker', 'positions'].map(imp));

// ---- 可拨的钟
let T = Date.UTC(2026, 8, 11, 16, 0, 0);
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(T); else super(...a); }
  static now() { return T; }
}
globalThis.Date = FakeDate;
const jn = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));

const settingsOf = (patch = {}) => config.fromDict(deepMerge({ ...BASE_CONFIG, storage: { db_path: '/tmp/x.db' } }, patch));
const pop = (q) => { if (!q || !q.length) return {}; return q.length > 1 ? q.shift() : q[0]; };

// ======================================================================= closing
const out = { base: enc(deepMerge({ ...BASE_CONFIG, storage: { db_path: '/tmp/x.db' } }, {})), closing: [], spot: [], hours: [], shorthand: [], clock: [], heartbeat: [] };
{
  const r = rng(77);
  const alias = '模拟';
  const keyOf = (symbol, secType, contract) => positions.makeKey(alias, symbol, secType, positions.legOf(contract));
  const optC = (e, k, rt) => ({ secType: 'OPT', symbol: 'SPX', lastTradeDateOrContractMonth: e, strike: k, right: rt });
  for (let n = 0; n < 700; n += 1) {
    const rows = [];
    const bag = r.chance(0.55);
    let contract;
    if (bag) {
      const e = r.pick(['20261016', '20261017', '2026101', '2026101612']);
      const ks = r.pick([[7500, 7520, 7540], [7500, 7525], [7700, 7720, 7740, 7760], [7540, 7520, 7500], [7520, 7500, 7520], [7500, 7500, 7520]]);
      const legs = ks.map((k, i) => ({ action: r.pick(['BUY', 'SELL', 'BUY', 'hold']), ratio: r.pick([0, 1, 1, 2]), strike: k, right: r.pick(['C', 'P', 'call']), lastTradeDateOrContractMonth: i === 0 && r.chance(0.05) ? undefined : e }));
      contract = { secType: 'BAG', symbol: 'SPX', legs: r.chance(0.05) ? [] : legs, ...(r.chance(0.1) ? { legs: undefined } : {}) };
      for (const l of legs) if (r.chance(0.8)) rows.push({ key: keyOf('SPX', 'OPT', optC(l.lastTradeDateOrContractMonth, l.strike, l.right)), quantity: (l.action === 'BUY' ? 1 : -1) * r.pick([1, 2, 3, 4, -1]) * (r.chance(0.7) ? 1 : -1) });
    } else {
      const secType = r.pick(['STK', 'OPT', 'STK']);
      contract = secType === 'OPT' ? optC('20261016', r.pick([7500, 7520]), r.pick(['C', 'P'])) : { secType, symbol: r.pick(['AAPL', 'NVDA']) };
      contract.symbol = contract.symbol ?? 'AAPL';
      rows.push({ key: keyOf(contract.symbol, secType, contract), quantity: r.pick([100, -100, 5, -5, 0, 0.5, -0.5, 'x', null]) });
    }
    if (r.chance(0.3)) rows.push({ key: 'junk', quantity: r.pick([1, '2', NaN, null]) });
    if (r.chance(0.1)) rows.push({ quantity: 3 });
    const order = { contract, order: { action: r.pick(['BUY', 'SELL', 'SELL', 'SELL']), totalQuantity: r.pick([1, 2, 5, 100, 0.5, 0, undefined, '3']) } };
    const a = structuredClone(rows);
    const reduces = closing.reducesPositions(order, alias, a);
    const b = structuredClone(rows);
    closing.applyReduction(order, alias, b);
    let legId;
    try { legId = closing.orderLegId(order); } catch (e) { legId = { error: 'threw' }; }
    if (legId && legId.error) continue;
    out.closing.push({ order: enc(order), alias, rows: enc(rows), expected: enc({ reduces, after: b, legId }) });
  }
}

// ======================================================================= spotStop
{
  const mk = (cfg, calls) => {
    const caps = cfg.caps ?? {};
    const route = { async indexPrice(sym) { calls.push(['indexPrice', sym]); const b = pop(cfg.index); if (b.throw) throw new Error(b.throw); return b.v; } };
    if (caps.spotInfo) route.spotInfo = (sym) => { calls.push(['spotInfo', sym]); const b = pop(cfg.info); if (b.throw) throw new Error(b.throw); return b.v; };
    if (caps.stream) route.streamQuotes = async (syms) => { calls.push(['streamQuotes', syms]); const b = pop(cfg.stream); if (b.throw) throw new Error(b.throw); return b.v; };
    return route;
  };
  const cases = [];
  const base = { caps: { spotInfo: true, stream: true } };
  const px = (v) => ({ v });
  for (const caps of [{}, { spotInfo: true }, { stream: true }, { spotInfo: true, stream: true }]) {
    for (const index of [[px(7500.5)], [px(null)], [px(NaN)], [{ throw: '行情失败' }], [px(Infinity)]]) {
      for (const info of [[px(null)], [px({ source: 'futures', price: 7501.234, note: '期货推算' })], [px({ source: 'index_stale', note: '昨收' })], [px({ source: 'index', note: 5 })], [{ throw: '坏' }], [px(undefined)]]) {
        for (const stream of [[px({ SPX: { last: 7499.5 } })], [px({ SPX: { last: 0 } })], [px({ SPX: { last: '7500' } })], [px({})], [px(null)], [{ throw: '流断了' }], [px({ SPX: { last: -1 } })], [px({ SPX: { last: 0.5 } })]]) {
          if (cases.length > 800) break;
          if ((caps.spotInfo ? 1 : 0) + (caps.stream ? 1 : 0) === 0 && info[0].v !== null) continue;
          cases.push({ caps, index, info, stream });
        }
      }
    }
  }
  const targetsList = [{ spot_stop_below: 7400 }, { spot_stop_above: 7600, spot_stop_confirm_s: 3 }, {}, { spot_stop_below: 7400, spot_stop_above: 7600 }];
  const r = rng(5);
  // 队列要深拷贝,NaN / Infinity 靠 enc 带过去
  const runCase = async (c, fn, args) => {
    const calls = [];
    const cfg = { caps: c.caps, index: structuredClone(c.index), info: structuredClone(c.info), stream: structuredClone(c.stream) };
    const route = mk(cfg, calls);
    let res;
    try { res = await fn(route, ...args); } catch (e) { res = { thrown: String(e.message) }; }
    return { res, calls };
  };
  for (const c of cases) {
    const which = r.pick(['stock', 'under', 'under0', 'stop']);
    let args, fn;
    if (which === 'stock') { fn = spotStop.stockSpot; args = ['SPX']; }
    else if (which === 'under') { fn = spotStop.underlyingSpot; args = ['SPX', true]; }
    else if (which === 'under0') { fn = spotStop.underlyingSpot; args = ['SPX', false]; }
    else {
      fn = spotStop.spotStopFor;
      const tg = tk.makeTargets(r.pick(targetsList));
      const target = r.chance(0.4) ? { spot: r.pick([7500, null, 7399]), spot_note: r.pick(['', '推算']) } : null;
      args = ['SPX', tg, target, r.chance(0.7)];
    }
    const o = await runCase(c, fn, args);
    out.spot.push({ which, args: enc(args), cfg: enc({ caps: c.caps, index: c.index, info: c.info, stream: c.stream }), expected: enc(o) });
  }
}

// ======================================================================= sessionHours
{
  const g = JSON.parse(readFileSync(join(engine, 'baseline/golden/config.json'), 'utf-8'));
  const specs = g.hours_status.map((c) => ({ spec: c.spec, liquid: c.liquid, tz: c.tz, now: Date.parse(c.now) }));
  const r = rng(9);
  const optOrder = (over = {}, ord = {}) => ({ contract: { secType: 'OPT', symbol: 'SPX', lastTradeDateOrContractMonth: '20260904', strike: 7500, right: 'C', ...over }, order: { orderType: 'LMT', action: 'BUY', totalQuantity: 1, ...ord }, account: '模拟' });
  const bagOrder = (ord = {}) => ({ contract: { secType: 'BAG', symbol: 'SPX', legs: [{ lastTradeDateOrContractMonth: '20260904', strike: 7500, right: 'C', action: 'BUY', ratio: 1 }, { lastTradeDateOrContractMonth: '20260904', strike: 7520, right: 'C', action: 'SELL', ratio: 1 }] }, order: { orderType: 'LMT', action: 'BUY', totalQuantity: 1, ...ord }, account: '主账户' });
  const stkOrder = (ord = {}) => ({ contract: { secType: 'STK', symbol: 'AAPL' }, order: { orderType: 'LMT', action: 'BUY', totalQuantity: 1, ...ord }, account: '' });
  for (let n = 0; n < 160; n += 1) {
    const sp = r.pick(specs);
    const caps = { contractHours: r.chance(0.85), cached: r.chance(0.85) };
    const cached = {};
    if (r.chance(0.9)) cached['SPX|20260904'] = r.chance(0.1) ? null : [sp.spec, sp.liquid, sp.tz];
    const orders = [optOrder(), bagOrder(), stkOrder(), optOrder({}, { orderType: 'MKT' }), optOrder({}, { outsideRth: true }), optOrder({ lastTradeDateOrContractMonth: '20260905' }), bagOrder({ outsideRth: false }),
      { ...optOrder(), warnings: ['x'] }, { contract: { secType: 'BAG', symbol: 'SPX', legs: [] }, order: { orderType: 'LMT' } }, { contract: { secType: 'FOP', symbol: 'ES', lastTradeDateOrContractMonth: '20260904' }, order: { orderType: 'LMT' } }].filter(() => r.chance(0.7));
    const settingsPatch = { policies: { auto_outside_rth: r.chance(0.8) } };
    const throwCached = r.chance(0.1);
    const hoursQ = [r.pick([{ v: [sp.spec, sp.liquid, sp.tz] }, { v: null }, { throw: '查不到' }])];
    const settings = settingsOf(settingsPatch);
    const calls = [];
    const hostRouter = (!caps.contractHours && !caps.cached) ? null : {};
    const route = {};
    if (caps.contractHours) route.contractHours = async (row, account) => { calls.push(['contractHours', jn(row), account.alias]); const b = pop(hoursQ); if (b.throw) throw new Error(b.throw); return b.v; };
    if (caps.cached) route.cachedContractHours = (symbol, expiry) => { calls.push(['cachedContractHours', symbol, expiry]); if (throwCached) throw new Error('缓存坏了'); const v = cached[`${symbol}|${expiry}`]; return v === undefined ? null : v; };
    void hostRouter;
    const host = { settings, router: (caps.contractHours || caps.cached || r.chance(0.5)) ? route : null };
    const at = config.etNowFromEpoch(sp.now);
    const raw = (secType) => ({ account: r.pick(['模拟', '主账户', '不存在']), symbol: 'SPX', sec_type: secType, contract: { secType, symbol: 'SPX' } });
    const raws = [raw('OPT'), raw('BAG'), raw('STK'), raw('FOP')];
    const status = orders.map((o) => hours.orderMarketStatus(host, o, at));
    const auto = hours.autoOutsideRth(host, orders, at);
    const statusFor = [];
    for (const rw of raws) statusFor.push(await hours.marketStatusFor(host, rw, at));
    await hours.prewarmContractHours(host, orders);
    out.hours.push({ settingsPatch, caps, cached, hoursQ: enc(hoursQ), throwCached, hasRouter: host.router !== null, now: sp.now, orders: enc(orders), raws: enc(raws),
      expected: enc({ status, auto, statusFor, calls, stock: settings.marketStatus(at) }) });
  }
}

// ======================================================================= localShorthand
{
  const instr = ['1.8 挂15蝴蝶 15CM', '7515蝴蝶 15cm 1.8', '50蝴蝶', 'QQQ 580的10cm蝴蝶 看跌 2', '7770 7775 bear call -2', '7840 7845 bear call', '7770 7775 bear call 挂个-2-2.5',
    '1500张 7520的20cm蝴蝶', '买入 AAPL 10 股', '卖出 SPX 7500 call', '15蝴蝶', '蝴蝶 看涨 15cm 看跌 '.repeat(12), '蝴蝶 看涨 3', 'SPX 7500/7520 call spread 1.2', '看涨 15cm 蝴蝶 1.9', '', '你好'];
  const r = rng(31);
  const at = config.etNowFromEpoch(Date.UTC(2026, 8, 11, 15, 0, 0));
  for (let n = 0; n < 220; n += 1) {
    const text = r.pick(instr);
    const snap = r.pick([{}, { SPX: 7462.35 }, { QQQ: 585 }, { SPX: null }, { SPX: 6907.35, QQQ: 585 }]);
    const cfg = { hasRouter: r.chance(0.8), index: [r.pick([{ v: 7458.5 }, { v: null }, { throw: '券商失败' }])],
      info: [r.pick([{ v: null }, { v: { source: 'futures', price: 7458.5, note: '按 ES 推算' } }, { v: { source: 'futures', price: 7458.5123, note: '多位小数' } }, { v: { source: 'index_stale', note: '昨收' } }])], infoCap: r.chance(0.8),
      pub: [r.pick([{ v: 7440.25 }, { v: null }, { throw: '公开源挂了' }])] };
    const calls = [];
    const route = { async indexPrice(s) { calls.push(['indexPrice', s]); const b = pop(cfg.index); if (b.throw) throw new Error(b.throw); return b.v; } };
    if (cfg.infoCap) route.spotInfo = (s) => { calls.push(['spotInfo', s]); return pop(cfg.info).v ?? null; };
    const host = { router: cfg.hasRouter ? route : null, publicPriceFn: async (s) => { calls.push(['public', s]); const b = pop(cfg.pub); if (b.throw) throw new Error(b.throw); return b.v; },
      store: { audit(a, b, c) { calls.push(['audit', a, b, jn(c)]); } } };
    const s2 = structuredClone(snap);
    const meta = {};
    const res = await localShorthand.tryLocalShorthand(host, text, s2, at, meta);
    out.shorthand.push({ text, snap: enc(snap), cfg: enc({ ...cfg, index: cfg.index, info: cfg.info, pub: cfg.pub }), at: at.epochMs, expected: enc({ res, snap: s2, calls, meta }) });
  }
}

// ======================================================================= clock / heartbeat
{
  const zones = ['Asia/Shanghai', 'America/New_York', 'Asia/Kolkata', 'America/St_Johns', 'UTC', 'Pacific/Auckland'];
  const times = [Date.UTC(2026, 0, 15, 3, 4, 5, 678), Date.UTC(2026, 6, 4, 23, 59, 59, 999), Date.UTC(2026, 10, 1, 5, 30, 0), Date.UTC(2026, 2, 8, 7, 0, 0), Date.UTC(2026, 9, 21, 0, 0, 0)];
  const saved = process.env.TZ;
  for (const z of zones) {
    process.env.TZ = z;
    for (const t of times) { T = t; out.clock.push({ zone: z, t, expected: clock.localIsoSeconds() }); }
  }
  if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  for (const t of times) { T = t; out.clock.push({ zone: '', t, expected: clock.nowIsoSecondsEt() }); }
  T = Date.UTC(2026, 8, 11, 16, 0, 0) + 123;
  const states = [
    { running: true, interval_ms: 1000, ticks: 5, slow_ticks: 1, last_at: new RealDate(T - 2500).toISOString(), last_ms: 12, max_ms: 90, last_error: '', lag_last_ms: 3, lag_worst_ms: 40, hold: '电脑刚醒', live_tracks: 2 },
    { running: false, interval_ms: 1000, ticks: 0, slow_ticks: 0, last_at: null, last_ms: null, max_ms: 0, last_error: '', hold: '', live_tracks: 0 },
    { running: true, last_at: 'garbage', hold: undefined, live_tracks: '7', lag_last_ms: null },
    {},
  ];
  for (const s of states) out.heartbeat.push({ kind: 'beat', t: T, state: enc(s), expected: enc(heartbeat.heartbeatOf(s)) });
  const lags = [0, 4_600_000, 12_345_678, NaN, Infinity, 400_000_000];
  for (const lag of lags) {
    for (const t0 of [T - 5, T - 500, T - 40, T - 50, T - 51]) {
      const state = { ticks: 3, slow_ticks: 0, max_ms: 20, lag_worst_ms: 10 };
      const m = new heartbeat.LoopMeter();
      m.delay = { max: lag, reset() {}, disable() {} };
      m.record(state, t0, 50);
      const state2 = { ticks: 3, slow_ticks: 0, max_ms: 20 };
      new heartbeat.LoopMeter().record(state2, t0, 50);
      const state3 = { ticks: 1 };
      const m3 = new heartbeat.LoopMeter();
      m3.delay = { max: lag, reset() {}, disable() {} };
      m3.record(state3, t0, 50);
      const state4 = { ticks: 2 };
      new heartbeat.LoopMeter().record(state4, t0, 50);  // 有来源没 start = 没有 delay
      out.heartbeat.push({ kind: 'meter', t: T, lag: enc(lag), t0, expected: enc({ withLag: state, noLag: state2, missing: state3, unstarted: state4 }) });
    }
  }
}
out.labels = ['take_profit', 'stop_loss', 'profit_trail', 'manual', 'time_exit', 'holding', 'sweep:stop_loss', '', 'constructor'].map((st) => ({ state: st, expected: enc(hostedMod.HostedOrders.STATE_LABEL[st] === undefined || typeof hostedMod.HostedOrders.STATE_LABEL[st] !== 'string' ? null : hostedMod.HostedOrders.STATE_LABEL[st]) }));
{
  const vals = [0, -0, 1, -1, 2.5, NaN, Infinity, -Infinity, 1e-9];
  out.math = [];
  for (const a of vals) for (const b of vals) out.math.push({ a: enc(a), b: enc(b), min: enc(Math.min(a, b)), max: enc(Math.max(a, b)) });
}
const text = JSON.stringify(out);
writeFileSync(join(here, process.env.OUT ?? 'engine_pure.json'), text);
console.log(`engine_pure.json:closing ${out.closing.length} spot ${out.spot.length} hours ${out.hours.length} shorthand ${out.shorthand.length} clock ${out.clock.length} heartbeat ${out.heartbeat.length},${(text.length / 1024).toFixed(0)} KB`);
