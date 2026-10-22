// 生成 validator.json:engine-ts 的 validator.ts(原模块现跑)。每一例 = 一份原始配置(config.fromDict 读进来,C++ 用 domain::fromDict 读同一份)、
// 一个时刻、行情快照、近期订单、按标的查的时段表、extras(在手敞口、减仓判定与扣减、capNote、券商净值)、一批订单(ParsedOrderSchema.parse 的输出,
// 生产里校验层只拿到这个形状)、单次上限 limit;期望是 validateAll 的结果(订单是校验之后的那一份:tradingClass 会被就地复核)、
// 每张拒单的 primaryCode / rejectionMessage、isReduction / consumeReduction 的调用次序、statusFor、orderSignature、riskWidth,
// 以及同一个实例上逐张 validateOne(不带 seenInBatch)的结果。随机例之外有手写的边界:每条限额正好在线上、差一分、过一分。
// 账号是假的。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_validator.mjs <engine-ts 目录>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const V = await import(pathToFileURL(join(engine, 'dist/src/validator.js')).href);
const C = await import(pathToFileURL(join(engine, 'dist/src/config.js')).href);
const M = await import(pathToFileURL(join(engine, 'dist/src/models.js')).href);
const base = JSON.parse(readFileSync(join(engine, 'baseline/rpc/base_config.json'), 'utf8'));

let seed = 0x5a1d_7e43;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const enc = (o) => JSON.parse(JSON.stringify(o === undefined ? '__undefined__' : o, (k, v) => {
  if (v === undefined) return '__undefined__';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '__NaN__';
    if (v === Infinity) return '__Inf__';
    if (v === -Infinity) return '__-Inf__';
    if (Object.is(v, -0)) return '__neg0__';
  }
  return v;
}));
const clone = (o) => structuredClone(o);

// ---------------------------------------------------------------- 配置
const ACCOUNTS = [
  { alias: '模拟', account_id: 'DUTEST001', is_paper: true, connection: 'paper', default: true },
  { alias: '主账户', account_id: 'UTEST0001', is_paper: false, connection: 'live' },
];
function randomConfig() {
  const c = clone(base);
  c.accounts = clone(ACCOUNTS);
  if (rnd() < 0.15) c.accounts.push({ alias: '未标', account_id: 'UTEST0002', connection: 'live' }); // 没写 is_paper
  if (rnd() < 0.1) c.accounts.push({ alias: 'constructor', account_id: 'DUTEST009', is_paper: true, connection: 'paper' });
  if (rnd() < 0.08) c.accounts = [];
  if (rnd() < 0.1 && c.accounts.length) { c.accounts[0].default = false; }
  const L = c.limits;
  if (rnd() < 0.3) L.max_order_notional = pick([1000, '2500', ' 5000 ', 50000, 100000, '1e4']);
  if (rnd() < 0.3) L.max_option_contracts = pick([1, 2, '5', 10, 20]);
  if (rnd() < 0.3) L.max_mkt_shares = pick([0, 50, '100', 200]);
  if (rnd() < 0.3) L.min_confidence = pick([0, 0.5, '0.8', 0.9, 0.95, 1]);
  if (rnd() < 0.3) L.max_orders_per_input = pick([1, 2, '3', 5]);
  if (rnd() < 0.3) L.duplicate_window_minutes = pick([0, 1, '5', 10, 30]);
  if (rnd() < 0.3) L.duplicate_qty_tolerance = pick([0, 0.1, '0.2', 0.5, 1]);
  if (rnd() < 0.35) L.max_open_risk_usd = pick([0, 500, '1500', 3000, 10000, '']);
  if (rnd() < 0.35) L.max_underlying_contracts = pick([0, 1, 3, '5', 10, '']);
  if (rnd() < 0.3) {
    L.by_account = {};
    for (const a of ['模拟', '主账户', 'nobody']) {
      if (rnd() < 0.6) {
        const one = {};
        if (rnd() < 0.5) one.max_order_notional = pick([500, '800', null, 20000]);
        if (rnd() < 0.5) one.max_option_contracts = pick([1, '3', null]);
        if (rnd() < 0.4) one.max_mkt_shares = pick([10, null, '20']);
        if (rnd() < 0.4) one.max_open_risk_usd = pick([0, 400, '2000', null]);
        if (rnd() < 0.4) one.max_underlying_contracts = pick([0, 2, '4', null]);
        L.by_account[a] = one;
      }
    }
  }
  const P = c.policies;
  if (rnd() < 0.4) P.allow_live_trading = pick([true, false]);
  if (rnd() < 0.4) P.require_trigger_price_verification = pick([true, false]);
  if (rnd() < 0.3) P.trigger_min_gap_bps = pick([0, 1, '5', 5.0, 20]);
  if (rnd() < 0.5) P.closed_market_policy = pick(['allow', 'reject_market_orders', 'reject_all']);
  if (rnd() < 0.4) {
    c.risk_budget = { enabled: pick([true, true, false]), max_risk_pct: pick([0.5, 1, 2, '5']), max_position_pct: pick([10, 25, '50']),
      equity_usd: pick([{}, { 模拟: 20000 }, { 模拟: 0, 主账户: 100000 }, { 主账户: '50000' }]) };
  }
  if (rnd() < 0.3) c.index_symbols = pick([{}, { SPX: { exchange: 'CBOE', daily_trading_class: 'SPXW', monthly_trading_class: 'SPX' }, XSP: { exchange: 'CBOE', daily_trading_class: 'XSP', monthly_trading_class: 'XSP' } },
    { SPX: { exchange: 'CBOE', daily_trading_class: '', monthly_trading_class: 'SPX' } }, { SPX: { exchange: 'CBOE', daily_trading_class: 'SPXW', monthly_trading_class: '' } }]);
  if (rnd() < 0.2) c.market_holidays = pick([['2026-10-15'], ['2026-11-19', '2026-11-26'], ['2026-10-16'], []]);
  return c;
}

// ---------------------------------------------------------------- 时刻
const ET = (s) => Date.parse(s);
const NOWS = [
  '2026-10-14T03:30:00-04:00', '2026-10-14T07:00:00-04:00', '2026-10-14T09:29:59-04:00', '2026-10-14T09:30:00-04:00', '2026-10-14T12:00:00-04:00',
  '2026-10-14T15:59:59-04:00', '2026-10-14T16:00:00-04:00', '2026-10-14T19:59:59-04:00', '2026-10-14T20:00:00-04:00', '2026-10-17T11:00:00-04:00',
  '2026-10-15T11:00:00-04:00', '2026-10-16T11:00:00-04:00', '2026-11-19T11:00:00-05:00', '2026-11-27T12:59:00-05:00', '2026-11-27T13:30:00-05:00',
  '2026-09-07T11:00:00-04:00', '2026-12-17T10:00:00-05:00',
].map(ET);

// ---------------------------------------------------------------- 订单
const EXPIRIES = ['20261014', '20261015', '20261016', '20261017', '20261019', '20261023', '20261119', '20261120', '20261113', '20261217', '20261218', '20260916', '20261013', '20260907'];
const STOCKS = ['AAPL', 'NVDA', 'TSLA', 'QQQ'];
const IDX = ['SPX', 'XSP', 'NDX'];

function leg(action, strike, right, expiry, extra = {}) {
  return { action, ratio: 1, lastTradeDateOrContractMonth: expiry, strike, right, ...extra };
}
function rawOrder() {
  const kind = pick(['STK', 'STK', 'OPT', 'OPT', 'BAG', 'BAG', 'BAG', 'BAG']);
  const account = pick(['DEFAULT', '模拟', '主账户', 'nobody', '模拟', '未标', 'constructor']);
  const action = pick(['BUY', 'BUY', 'SELL']);
  const o = { intent_summary: '测试单', execution_type: 'IMMEDIATE', account, reason: pick(['', '  ', '突破', '止盈']), confidence: pick([0.95, 0.99, 0.9, 0.89, 0.5, 1, 0]),
    warnings: pick([[], ['模型提醒'], []]) };
  if (kind === 'STK') {
    const orderType = pick(['LMT', 'MKT', 'STP', 'STP LMT', 'TRAIL']);
    o.contract = { secType: 'STK', symbol: pick(STOCKS) };
    o.order = { action, orderType, totalQuantity: pick([1, 10, 50, 100, 199, 200, 201, 500, 1000]) };
    if (orderType === 'LMT') o.order.lmtPrice = pick([10, 100, 250, 99.99, 500]);
    if (orderType === 'STP') o.order.auxPrice = pick([90, 300, 120]);
    if (orderType === 'STP LMT') { o.order.auxPrice = pick([90, 300]); o.order.lmtPrice = pick([95, 305, 250]); }
    if (orderType === 'TRAIL') { if (rnd() < 0.5) o.order.auxPrice = pick([2, 5]); else o.order.trailingPercent = pick([1, 5]); }
  } else if (kind === 'OPT') {
    const orderType = pick(['LMT', 'LMT', 'MKT', 'STP', 'STP LMT', 'TRAIL']);
    const sym = pick([...STOCKS, ...IDX]);
    o.contract = { secType: 'OPT', symbol: sym, lastTradeDateOrContractMonth: pick(EXPIRIES), strike: pick([100, 250, 5800, 7000, 580]), right: pick(['C', 'P']) };
    if (rnd() < 0.15) o.contract.multiplier = pick(['1', '10', '100.0', '', ' 100 ', '50']);
    if (IDX.includes(sym) && rnd() < 0.6) o.contract.tradingClass = pick(['SPXW', 'SPX', 'spxw', 'XSP', 'FOO', '']);
    o.order = { action, orderType, totalQuantity: pick([1, 2, 5, 9, 10, 11, 20]) };
    if (orderType === 'LMT') o.order.lmtPrice = pick([0.5, 2.5, 5, 25, 100]);
    if (orderType === 'STP') o.order.auxPrice = 3;
    if (orderType === 'STP LMT') { o.order.auxPrice = 3; o.order.lmtPrice = pick([3.5, 50]); }
    if (orderType === 'TRAIL') o.order.auxPrice = 1;
  } else {
    const strat = pick(['VERTICAL', 'BUTTERFLY', 'IRON_CONDOR']);
    const sym = pick(['SPX', 'SPX', 'XSP', 'QQQ', 'NDX']);
    const exp = pick(EXPIRIES);
    const k = sym === 'XSP' ? 580 : sym === 'QQQ' ? 500 : 5800;
    const w = pick([5, 10, 25]);
    const r = pick(['C', 'P']);
    let legs;
    if (strat === 'VERTICAL') {
      const lo = k, hi = k + w;
      const shape = pick(['ok', 'ok', 'ok', 'rev', 'sameStrike', 'twoBuys', 'mixRight', 'mixExp', 'ratio2']);
      const debit = action === 'BUY';
      // 借方 call:买低卖高;借方 put:买高卖低
      let buyK = (r === 'C') === debit ? lo : hi, sellK = buyK === lo ? hi : lo;
      if (shape === 'rev') [buyK, sellK] = [sellK, buyK];
      if (shape === 'sameStrike') sellK = buyK;
      legs = [leg('BUY', buyK, r, exp), leg(shape === 'twoBuys' ? 'BUY' : 'SELL', sellK, shape === 'mixRight' ? (r === 'C' ? 'P' : 'C') : r, shape === 'mixExp' ? pick(EXPIRIES) : exp)];
      if (shape === 'ratio2') legs[1].ratio = 2;
    } else if (strat === 'BUTTERFLY') {
      const shape = pick(['ok', 'ok', 'ok', 'ok', 'broken', 'brokenTiny', 'badDir', 'badRatio', 'mixRight', 'mixExp', 'dupStrike']);
      const wHi = shape === 'broken' ? w * 2 : shape === 'brokenTiny' ? w + pick([0.01, 0.02, 0.005]) : w;
      legs = [leg('BUY', k - w, r, exp), { ...leg('SELL', k, r, exp), ratio: 2 }, leg('BUY', k + wHi, r, exp)];
      if (shape === 'badDir') legs[0].action = 'SELL';
      if (shape === 'badRatio') legs[1].ratio = 1;
      if (shape === 'mixRight') legs[2].right = r === 'C' ? 'P' : 'C';
      if (shape === 'mixExp') legs[2].lastTradeDateOrContractMonth = pick(EXPIRIES);
      if (shape === 'dupStrike') legs[2].strike = k;
      if (rnd() < 0.5) legs.reverse();
    } else {
      const shape = pick(['ok', 'ok', 'ok', 'crossed', 'badPut', 'badCall', 'threePuts', 'ratio2', 'dupStrike', 'mixExp']);
      legs = [leg('BUY', k - 2 * w, 'P', exp), leg('SELL', k - w, 'P', exp), leg('SELL', k + w, 'C', exp), leg('BUY', k + 2 * w, 'C', exp)];
      if (shape === 'crossed') { legs[1].strike = k + w + 1; legs[2].strike = k + w - 1 + 2 * w; legs[3].strike = k + 4 * w; legs[2].strike = k; }
      if (shape === 'badPut') { legs[0].action = 'SELL'; legs[1].action = 'BUY'; }
      if (shape === 'badCall') { legs[2].action = 'BUY'; }
      if (shape === 'threePuts') legs[2].right = 'P';
      if (shape === 'ratio2') legs[3].ratio = 2;
      if (shape === 'dupStrike') legs[2].strike = legs[1].strike;
      if (shape === 'mixExp') legs[0].lastTradeDateOrContractMonth = pick(EXPIRIES);
      if (rnd() < 0.5) legs = [legs[2], legs[0], legs[3], legs[1]];
    }
    for (const l of legs) {
      if (rnd() < 0.15) l.tradingClass = pick(['SPXW', 'SPX', 'spxw', '', 'XSP']);
      if (rnd() < 0.05) l.multiplier = pick(['10', '100.0', '']);
    }
    o.contract = { secType: 'BAG', symbol: sym, combo_strategy: strat, legs };
    if (rnd() < 0.05) o.contract.multiplier = '50';
    const auto = rnd() < 0.25;
    o.order = { action: pick([action, action, strat === 'IRON_CONDOR' ? 'SELL' : 'BUY']), orderType: 'LMT', totalQuantity: pick([1, 2, 3, 5, 10, 11]),
      price_mode: auto ? 'AUTO_MID' : 'EXPLICIT' };
    if (!auto) o.order.lmtPrice = pick([0.5, 1.2, 2.5, 4.99, 5, 5.01, 9.99, 10, 10.01, 24.99, 25, 25.01, 30]);
  }
  if (rnd() < 0.15) o.order.outsideRth = true;
  if (rnd() < 0.08 && o.order.orderType !== 'MKT') o.order.tif = 'GTC';
  if (rnd() < 0.25) {
    o.execution_type = 'CONDITIONAL';
    o.trigger = { symbol: pick(['spx', 'AAPL', 'NVDA', 'QQQ', 'VIX']), secType: pick(['IND', 'STK']), operator: pick(['>=', '<=']), value: pick([5790, 5810, 5800.4, 100, 99.96, 100.05, 250, 1]) };
  }
  return o;
}
function parseOrder(raw) {
  const r = M.ParsedOrderSchema.safeParse(raw);
  return r.success ? r.data : null;
}
function randomOrders(n) {
  const out = [];
  while (out.length < n) {
    const p = parseOrder(rawOrder());
    if (p) out.push(p);
  }
  // 同一条输入里的重复:原样再来一张(数量不变、改一点、改很多)
  if (out.length && rnd() < 0.3) {
    const d = clone(pick(out));
    d.order.totalQuantity = pick([d.order.totalQuantity, d.order.totalQuantity + 1, d.order.totalQuantity * 3]);
    out.push(d);
  }
  return out;
}

// ---------------------------------------------------------------- 一例
const SNAP_VALUES = [5800, 5810.25, 100, 250, '101', '', null, 'x', 0, 99.9, 500, 6000];
function randomSnapshot() {
  const s = {};
  for (const sym of ['SPX', 'spx', 'AAPL', 'NVDA', 'TSLA', 'QQQ', 'VIX', 'xsp']) if (rnd() < 0.45) s[sym] = pick(SNAP_VALUES);
  return pick([s, s, s, null, undefined]);
}
function randomRecent(orders, settings, now) {
  if (rnd() < 0.3) return pick([null, undefined, []]);
  const out = [];
  const winMs = settings.limits.duplicate_window_minutes * 60000;
  for (let i = 0; i < int(1, 5); i += 1) {
    const o = orders.length ? pick(orders) : null;
    const sig = o ? V.orderSignature(o, o.account) : 'x|BUY|STK|AAPL';
    const r = { signature: pick([sig, sig, sig, 'other|BUY|STK|AAPL']), quantity: o ? pick([o.order.totalQuantity, o.order.totalQuantity + 1, String(o.order.totalQuantity), o.order.totalQuantity * 2]) : 1,
      createdAtMs: pick([now - 1000, now - winMs, now - winMs - 1, now - winMs + 1, now - 86400000, now]) };
    const lp = pick(['__omit__', null, o?.order.lmtPrice ?? 1, (o?.order.lmtPrice ?? 1) + 0.005, (o?.order.lmtPrice ?? 1) + 0.004, (o?.order.lmtPrice ?? 1) + 1, '2']);
    if (lp !== '__omit__') r.limitPrice = lp;
    const fs = pick(['__omit__', null, 'cancelled', 'filled', 'ibkr_error', 'cancelled']);
    if (fs !== '__omit__') r.finalStatus = fs;
    out.push(r);
  }
  return out;
}
function randomStatus() {
  if (rnd() < 0.5) return null;
  const t = {};
  for (const sym of ['SPX', 'XSP', 'AAPL', 'QQQ', 'NDX', 'NVDA', 'TSLA']) if (rnd() < 0.5) t[sym] = pick(['盘中', '盘外', '休市', '盘前', '盘后', null, '', 'THROW']);
  return t;
}
function randomExtras(orders) {
  if (rnd() < 0.3) return pick([null, undefined, {}]);
  const e = {};
  const ex = pick(['omit', 'null', 'obj', 'obj', 'obj']);
  if (ex === 'null') e.exposure = null;
  if (ex === 'obj') {
    const riskUsd = {}, contracts = {};
    for (const a of ['模拟', '主账户', 'constructor']) if (rnd() < 0.6) riskUsd[a] = pick([0, 100, 999.99, 1000, 1400, 2500, 10000]);
    for (const o of orders) {
      if (rnd() < 0.6) {
        const exp = String(o.contract.lastTradeDateOrContractMonth ?? o.contract.legs?.[0]?.lastTradeDateOrContractMonth ?? '').slice(0, 8);
        for (const a of ['模拟', '主账户']) contracts[`${a}|${o.contract.symbol}|${exp}`] = pick([0, 1, 2, 4, 5, 9]);
      }
    }
    e.exposure = { riskUsd, contracts, notes: [] };
  }
  if (rnd() < 0.4) e.reduce = Object.fromEntries(orders.filter(() => rnd() < 0.5).map((o) => [`${o.account}|${o.contract.symbol}`, int(0, 2)]));
  if (rnd() < 0.2) e.capNote = pick(['富途读不出期权持仓,累计上限没核对', '']);
  if (rnd() < 0.3) e.equity = pick([{ 模拟: 30000 }, { 主账户: 200000, 模拟: 5000 }, {}]);
  return e;
}
const LIMIT_ARGS = ['__omit__', '__omit__', '__omit__', null, 0, 1, 2, 2.5, 10, NaN, Infinity];

function runCase(c) {
  const settings = C.fromDict(c.config, null);
  const nowEt = C.etNowFromEpoch(c.now);
  const log = [];
  let statusFn;
  if (c.status === null) statusFn = c.statusMode === 'undefined' ? undefined : null;
  else statusFn = (order) => { const v = c.status[order.contract.symbol]; if (v === 'THROW') throw new Error('boom'); return v === undefined ? null : v; };
  const makeExtras = () => {
    if (c.extras === null || c.extras === undefined) return c.extras;
    const extras = {};
    if ('exposure' in c.extras) extras.exposure = clone(c.extras.exposure);
    if ('capNote' in c.extras) extras.capNote = c.extras.capNote;
    if ('equity' in c.extras) extras.equity = c.extras.equity;
    if ('reduce' in c.extras) {
      const left = { ...c.extras.reduce };
      const key = (order, alias) => `${alias}|${order.contract.symbol}`;
      extras.isReduction = (order, alias) => { const k = key(order, alias); const r = (left[k] ?? 0) > 0; log.push(['is', k, r]); return r; };
      extras.consumeReduction = (order, alias) => { const k = key(order, alias); left[k] = (left[k] ?? 0) - 1; log.push(['consume', k]); };
    }
    return extras;
  };
  const make = () => new V.Validator(settings, nowEt, clone(c.snapshot), clone(c.recent), statusFn, makeExtras());
  const v = make();
  const orders = clone(c.orders);
  const outcome = c.limit === '__omit__' ? v.validateAll(orders) : v.validateAll(orders, c.limit);
  const res = {
    out: enc(outcome),
    primary: outcome.rejected.map((r) => V.primaryCode(r)),
    message: outcome.rejected.map((r) => V.rejectionMessage(r)),
    log: [...log],
    statusFor: c.orders.map((o) => v.statusFor(clone(o))),
    signatures: c.orders.map((o) => V.orderSignature(o, o.account)),
    widths: enc(c.orders.map((o) => V.riskWidth(o.contract))),
  };
  // 同一个实例逐张 validateOne(不带 seenInBatch):批内累计在实例上
  log.length = 0;
  const v2 = make();
  res.one = enc(clone(c.orders).map((o) => v2.validateOne(o)));
  res.oneLog = [...log];
  return res;
}

const out = { runtime: '', cases: [] };
function addCase(c) {
  try { C.fromDict(c.config, null); } catch { return false; }
  const stored = { ...c, config: c.config, orders: clone(c.orders) };
  const res = runCase(c);
  out.cases.push({ ...enc(stored), ...res });
  return true;
}

// ---------------------------------------------------------------- 随机例
let made = 0;
while (made < 75) {
  const config = randomConfig();
  let settings;
  try { settings = C.fromDict(config, null); } catch { continue; }
  const now = pick(NOWS);
  const orders = randomOrders(int(1, 7));
  const status = randomStatus();
  if (addCase({ name: `random${made}`, config, now, snapshot: randomSnapshot(), recent: randomRecent(orders, settings, now), status, statusMode: status === null ? pick(['null', 'undefined']) : 'table',
    extras: randomExtras(orders), orders, limit: pick(LIMIT_ARGS) })) made += 1;
}

// ---------------------------------------------------------------- 手写的边界
const NOW = ET('2026-10-14T11:00:00-04:00'); // 周三盘中
const PRE = ET('2026-10-14T07:00:00-04:00');
const CLOSED = ET('2026-10-17T11:00:00-04:00'); // 周六
const cfgWith = (mut) => { const c = clone(base); c.accounts = clone(ACCOUNTS); mut?.(c); return c; };
const P = (raw) => { const p = parseOrder(raw); if (!p) throw new Error(`手写订单不合法: ${JSON.stringify(raw)}`); return p; };
const stk = (o = {}) => P({ intent_summary: 's', execution_type: 'IMMEDIATE', account: '模拟', reason: 'r', confidence: 0.95,
  contract: { secType: 'STK', symbol: 'AAPL' }, order: { action: 'BUY', orderType: 'LMT', totalQuantity: 10, lmtPrice: 100, ...o.order }, ...o.top });
const opt = (o = {}) => P({ intent_summary: 's', execution_type: 'IMMEDIATE', account: '模拟', reason: 'r', confidence: 0.95,
  contract: { secType: 'OPT', symbol: 'AAPL', lastTradeDateOrContractMonth: '20261016', strike: 250, right: 'C', ...o.contract },
  order: { action: 'BUY', orderType: 'LMT', totalQuantity: 1, lmtPrice: 5, ...o.order }, ...o.top });
const fly = (o = {}) => {
  const k = o.k ?? 5800, w = o.w ?? 10, r = o.right ?? 'P', e = o.exp ?? '20261016';
  return P({ intent_summary: 's', execution_type: 'IMMEDIATE', account: '模拟', reason: 'r', confidence: 0.95,
    contract: { secType: 'BAG', symbol: o.sym ?? 'SPX', combo_strategy: 'BUTTERFLY', legs: [leg('BUY', k - w, r, e, o.legExtra), { ...leg('SELL', k, r, e, o.legExtra), ratio: 2 }, leg('BUY', k + (o.wHi ?? w), r, e, o.legExtra)] },
    order: { action: 'BUY', orderType: 'LMT', totalQuantity: o.qty ?? 1, price_mode: o.auto ? 'AUTO_MID' : 'EXPLICIT', ...(o.auto ? {} : { lmtPrice: o.lmt ?? 2.5 }) }, ...o.top });
};
const vert = (o = {}) => {
  const e = o.exp ?? '20261016';
  return P({ intent_summary: 's', execution_type: 'IMMEDIATE', account: '模拟', reason: 'r', confidence: 0.95,
    contract: { secType: 'BAG', symbol: o.sym ?? 'SPX', combo_strategy: 'VERTICAL', legs: o.legs ?? [leg('BUY', 5800, 'C', e), leg('SELL', 5810, 'C', e)] },
    order: { action: o.action ?? 'BUY', orderType: 'LMT', totalQuantity: o.qty ?? 1, price_mode: o.auto ? 'AUTO_MID' : 'EXPLICIT', ...(o.auto ? {} : { lmtPrice: o.lmt ?? 2.5 }) }, ...o.top });
};
const condor = (o = {}) => {
  const e = '20261016';
  return P({ intent_summary: 's', execution_type: 'IMMEDIATE', account: '模拟', reason: 'r', confidence: 0.95,
    contract: { secType: 'BAG', symbol: 'SPX', combo_strategy: 'IRON_CONDOR', legs: o.legs ?? [leg('BUY', 5760, 'P', e), leg('SELL', 5780, 'P', e), leg('SELL', 5820, 'C', e), leg('BUY', o.callHi ?? 5840, 'C', e)] },
    order: { action: o.action ?? 'SELL', orderType: 'LMT', totalQuantity: o.qty ?? 1, price_mode: 'EXPLICIT', lmtPrice: o.lmt ?? 5 } });
};
const H = (name, c) => {
  const ok = addCase({ name, config: c.config ?? cfgWith(), now: c.now ?? NOW, snapshot: c.snapshot ?? {}, recent: c.recent ?? [], status: c.status ?? null, statusMode: 'null',
    extras: c.extras, orders: c.orders, limit: c.limit ?? '__omit__' });
  if (!ok) throw new Error(`手写例的配置读不进来: ${name}`);
};

// 置信度:正好在线上、差一点、过一点
for (const conf of [0.9, 0.8999999, 0.9000001, 0.89, 0.91]) H(`confidence ${conf}`, { orders: [stk({ top: { confidence: conf } })] });
H('confidence min 0', { config: cfgWith((c) => { c.limits.min_confidence = '0'; }), orders: [stk({ top: { confidence: 0 } })] });
// 账户
H('unknown account', { orders: [stk({ top: { account: 'nobody' } })] });
H('no accounts', { config: cfgWith((c) => { c.accounts = []; }), orders: [stk({ top: { account: 'DEFAULT' } })] });
H('live disabled', { orders: [stk({ top: { account: '主账户' } })] });
H('live allowed', { config: cfgWith((c) => { c.policies.allow_live_trading = true; }), orders: [stk({ top: { account: '主账户' } })] });
H('paper flag missing', { config: cfgWith((c) => { c.accounts.push({ alias: '未标', account_id: 'UTEST0002', connection: 'live' }); }), orders: [stk({ top: { account: '未标' } })] });
// 单笔名义上限 50000:股票限价买
for (const [q, p] of [[500, 100], [500, 100.00002], [500, 99.99998], [499, 100.2], [1, 50000], [1, 50000.01]]) H(`notional stk ${q}x${p}`, { orders: [stk({ order: { totalQuantity: q, lmtPrice: p } })] });
// 名义上限是串
H('notional string limit', { config: cfgWith((c) => { c.limits.max_order_notional = ' 1000 '; }), orders: [stk({ order: { totalQuantity: 10, lmtPrice: 100 } }), stk({ order: { totalQuantity: 10, lmtPrice: 100.01 } })] });
// 卖出限价、STP、TRAIL、MKT 的参考价
H('stk sell lmt below snapshot', { snapshot: { AAPL: 300 }, orders: [stk({ order: { action: 'SELL', totalQuantity: 200, lmtPrice: 100 } })] });
H('stk buy stp above', { snapshot: { aapl: '120' }, orders: [stk({ order: { orderType: 'STP', totalQuantity: 400, auxPrice: 130, lmtPrice: undefined } })] });
H('stk buy stp lmt', { snapshot: {}, orders: [stk({ order: { orderType: 'STP LMT', totalQuantity: 400, auxPrice: 130, lmtPrice: 125.01 } })] });
H('stk sell stp lmt', { snapshot: { AAPL: 140 }, orders: [stk({ order: { action: 'SELL', orderType: 'STP LMT', totalQuantity: 400, auxPrice: 130, lmtPrice: 125 } })] });
H('stk trail aux not price', { snapshot: { AAPL: 230 }, orders: [stk({ order: { orderType: 'TRAIL', totalQuantity: 2000, auxPrice: 2, lmtPrice: undefined } })] });
H('stk trail no snapshot', { orders: [stk({ order: { orderType: 'TRAIL', totalQuantity: 2000, auxPrice: 2, lmtPrice: undefined } })] });
for (const q of [199, 200, 201]) H(`stk mkt no ref ${q}`, { orders: [stk({ order: { orderType: 'MKT', totalQuantity: q, lmtPrice: undefined } })] });
for (const q of [199, 200, 201]) H(`stk trail no ref ${q}`, { orders: [stk({ order: { orderType: 'TRAIL', totalQuantity: q, trailingPercent: 1, lmtPrice: undefined } })] });
H('stk mkt nan snapshot', { snapshot: { AAPL: 'x' }, orders: [stk({ order: { orderType: 'MKT', totalQuantity: 300, lmtPrice: undefined } })] });
H('stk mkt zero snapshot', { snapshot: { AAPL: 0 }, orders: [stk({ order: { orderType: 'MKT', totalQuantity: 150, lmtPrice: undefined } })] });
H('stk mkt infinite snapshot', { snapshot: { AAPL: 'Infinity' }, orders: [stk({ order: { orderType: 'MKT', totalQuantity: 150, lmtPrice: undefined } }), stk({ order: { orderType: 'MKT', totalQuantity: 250, lmtPrice: undefined } })] });
H('stk mkt null snapshot', { snapshot: { AAPL: null }, orders: [stk({ order: { orderType: 'MKT', totalQuantity: 150, lmtPrice: undefined } })] });
H('stk mkt snapshot', { snapshot: { AAPL: '250.5' }, orders: [stk({ order: { orderType: 'MKT', totalQuantity: 199.0, lmtPrice: undefined } }), stk({ order: { orderType: 'MKT', totalQuantity: 300, action: 'SELL', lmtPrice: undefined } })] });
H('max_mkt_shares by account', { config: cfgWith((c) => { c.limits.by_account = { 模拟: { max_mkt_shares: '20', max_order_notional: null } }; }), orders: [stk({ order: { orderType: 'MKT', totalQuantity: 20, lmtPrice: undefined } }), stk({ order: { orderType: 'MKT', totalQuantity: 21, lmtPrice: undefined } })] });
// 期权:张数上限 10
for (const q of [9, 10, 11]) H(`opt contracts ${q}`, { orders: [opt({ order: { totalQuantity: q, lmtPrice: 1 } })] });
for (const q of [9, 10, 11]) H(`bag contracts ${q}`, { orders: [fly({ qty: q, lmt: 0.5 })] });
// 期权买入的权利金:名义 = 张 × 100 × 限价
for (const p of [500, 500.01, 499.99]) H(`opt buy notional ${p}`, { orders: [opt({ order: { lmtPrice: p } })] });
H('opt buy stp', { orders: [opt({ order: { orderType: 'STP', auxPrice: 3, lmtPrice: undefined } })] });
H('opt buy trail', { orders: [opt({ order: { orderType: 'TRAIL', auxPrice: 1, lmtPrice: undefined } })] });
H('opt buy mkt', { orders: [opt({ order: { orderType: 'MKT', lmtPrice: undefined } })] });
H('opt buy stp lmt', { orders: [opt({ order: { orderType: 'STP LMT', auxPrice: 3, lmtPrice: 3.5 } })] });
H('opt sell call', { orders: [opt({ order: { action: 'SELL' } })] });
for (const k of [500, 500.01]) H(`opt sell put ${k}`, { orders: [opt({ contract: { right: 'P', strike: k }, order: { action: 'SELL' } })] });
H('opt multiplier 1', { orders: [opt({ contract: { multiplier: '1' } })] });
H('opt multiplier 100.0', { orders: [opt({ contract: { multiplier: '100.0' } })] });
H('bag leg multiplier', { orders: [fly({ legExtra: { multiplier: '10' } })] });
// 组合:借方 / 贷方 / AUTO_MID 的最坏亏损
for (const lmt of [9.99, 10, 10.01]) H(`fly lmt vs wing ${lmt}`, { orders: [fly({ lmt })] });
for (const lmt of [9.99, 10, 10.01]) H(`vertical debit lmt vs width ${lmt}`, { orders: [vert({ lmt })] });
H('vertical credit', { orders: [vert({ action: 'SELL', legs: [leg('BUY', 5810, 'C', '20261016'), leg('SELL', 5800, 'C', '20261016')], lmt: 3 })] });
H('vertical credit lmt over width', { orders: [vert({ action: 'SELL', legs: [leg('BUY', 5810, 'C', '20261016'), leg('SELL', 5800, 'C', '20261016')], lmt: 12 })] });
H('vertical put debit', { orders: [vert({ legs: [leg('BUY', 5810, 'P', '20261016'), leg('SELL', 5800, 'P', '20261016')] })] });
H('vertical put debit reversed', { orders: [vert({ legs: [leg('BUY', 5800, 'P', '20261016'), leg('SELL', 5810, 'P', '20261016')] })] });
H('vertical put credit', { orders: [vert({ action: 'SELL', legs: [leg('BUY', 5800, 'P', '20261016'), leg('SELL', 5810, 'P', '20261016')] })] });
H('vertical auto', { orders: [vert({ auto: true, qty: 5 })] });
H('vertical auto notional', { config: cfgWith((c) => { c.limits.max_order_notional = 5000; }), orders: [vert({ auto: true, qty: 5 }), vert({ auto: true, qty: 6 })] });
H('fly auto', { orders: [fly({ auto: true, qty: 3 })] });
for (const wHi of [10.01, 10.02, 10.005, 9.99]) H(`fly wing ${wHi}`, { orders: [fly({ wHi })] });
H('fly sell', { orders: [P({ ...fly(), order: { action: 'SELL', orderType: 'LMT', totalQuantity: 1, price_mode: 'EXPLICIT', lmtPrice: 3 } })] });
H('condor ok', { orders: [condor()] });
H('condor both puts bought', { orders: [condor({ legs: [leg('BUY', 5760, 'P', '20261016'), leg('BUY', 5780, 'P', '20261016'), leg('SELL', 5820, 'C', '20261016'), leg('BUY', 5840, 'C', '20261016')] })] });
H('vertical same strike', { orders: [vert({ legs: [leg('BUY', 5800, 'C', '20261016'), leg('SELL', 5800, 'C', '20261016')] })] });
H('fly top leg sold', { orders: [P({ ...fly(), contract: { ...fly().contract, legs: [leg('BUY', 5790, 'P', '20261016'), { ...leg('SELL', 5800, 'P', '20261016'), ratio: 2 }, leg('SELL', 5810, 'P', '20261016')] } })] });
// 两翼正好差 0.01(0.01 / 0.02 / 0.04 的差在浮点里恰好是 0.01):不算不等翼
H('fly wings differ by exactly 0.01', { orders: [P({ ...fly(), contract: { ...fly().contract, symbol: 'AAPL', legs: [leg('BUY', 0.01, 'C', '20261016'), { ...leg('SELL', 0.02, 'C', '20261016'), ratio: 2 }, leg('BUY', 0.04, 'C', '20261016')] },
  order: { action: 'BUY', orderType: 'LMT', totalQuantity: 1, price_mode: 'EXPLICIT', lmtPrice: 0.01 } })] });
for (const lmt of [19.99, 20, 25]) H(`condor credit ${lmt}`, { orders: [condor({ lmt })] });
H('condor asymmetric width', { orders: [condor({ callHi: 5850 })] });
H('condor buy', { orders: [condor({ action: 'BUY' })] });
H('condor auto', { orders: [P({ ...condor(), order: { action: 'SELL', orderType: 'LMT', totalQuantity: 2, price_mode: 'AUTO_MID' } })] });
// 腿的 tradingClass:不一致、复核
H('mixed trading class', { orders: [fly({ legExtra: undefined }), P({ ...fly(), contract: { ...fly().contract, legs: fly().contract.legs.map((l, i) => ({ ...l, tradingClass: i === 0 ? 'SPX' : 'spxw ' })) } })] });
const IDXCFG = (c) => { c.index_symbols = { SPX: { exchange: 'CBOE', daily_trading_class: 'SPXW', monthly_trading_class: 'SPX' } }; };
for (const [e, tc] of [['20261015', null], ['20261015', 'SPXW'], ['20261015', 'spx'], ['20261016', 'SPX'], ['20261016', null], ['20261016', 'spxw'], ['20261016', 'FOO'], ['20261119', ' SPX '], ['20261120', '']])
  H(`trading class ${e} ${tc}`, { config: cfgWith(IDXCFG), orders: [opt({ contract: { symbol: 'SPX', strike: 5800, lastTradeDateOrContractMonth: e, tradingClass: tc ?? undefined }, order: { lmtPrice: 2 } }), fly({ exp: e, legExtra: tc === null ? undefined : { tradingClass: tc } })] });
H('trading class holiday thursday', { config: cfgWith((c) => { IDXCFG(c); c.market_holidays = ['2026-10-15']; }), orders: [opt({ contract: { symbol: 'SPX', strike: 5800, lastTradeDateOrContractMonth: '20261014' } }), opt({ contract: { symbol: 'SPX', strike: 5800, lastTradeDateOrContractMonth: '20261015' } })] });
// 到期日
H('expired', { orders: [opt({ contract: { lastTradeDateOrContractMonth: '20261013' } }), opt({ contract: { lastTradeDateOrContractMonth: '20261014' } })] });
H('expiry weekend', { orders: [opt({ contract: { lastTradeDateOrContractMonth: '20261017' } }), fly({ exp: '20261018' })] });
H('expiry holiday', { config: cfgWith((c) => { c.market_holidays = ['2026-10-16']; }), orders: [opt({ contract: { lastTradeDateOrContractMonth: '20261016' } })] });
// 触发:缺快照、正好 5 个基点、差一点、方向
const cond = (sym, op, value, o = stk()) => P({ ...o, execution_type: 'CONDITIONAL', trigger: { symbol: sym, secType: 'STK', operator: op, value } });
H('trigger no snapshot strict', { orders: [cond('NVDA', '>=', 100)] });
H('trigger no snapshot loose', { config: cfgWith((c) => { c.policies.require_trigger_price_verification = false; }), orders: [cond('NVDA', '>=', 100)] });
for (const v of [10005, 10004.99, 10005.01, 9995, 9995.01, 9994.99]) H(`trigger gap ${v}`, { snapshot: { NVDA: 10000 }, orders: [cond('NVDA', v > 10000 ? '>=' : '<=', v)] });
H('trigger wrong direction up', { snapshot: { NVDA: 100 }, orders: [cond('NVDA', '<=', 110)] });
H('trigger wrong direction down', { snapshot: { NVDA: 100 }, orders: [cond('NVDA', '>=', 90)] });
H('trigger zero price', { snapshot: { NVDA: 0 }, orders: [cond('NVDA', '>=', 90)] });
H('trigger nan price', { snapshot: { NVDA: 'abc' }, orders: [cond('NVDA', '>=', 90)] });
H('trigger empty string price', { snapshot: { NVDA: '' }, orders: [cond('NVDA', '>=', 90)] });
H('trigger gap 0 policy', { config: cfgWith((c) => { c.policies.trigger_min_gap_bps = 0; }), snapshot: { NVDA: 100 }, orders: [cond('NVDA', '>=', 100), cond('NVDA', '<=', 100)] });
// 时段
for (const pol of ['allow', 'reject_market_orders', 'reject_all']) {
  const config = cfgWith((c) => { c.policies.closed_market_policy = pol; });
  H(`closed ${pol}`, { config, now: CLOSED, snapshot: { AAPL: 100, NVDA: 50 }, orders: [stk(), stk({ order: { orderType: 'MKT', totalQuantity: 5, lmtPrice: undefined } }), cond('NVDA', '>=', 60)] });
}
H('premarket', { now: PRE, snapshot: { AAPL: 100 }, orders: [stk(), stk({ order: { outsideRth: true } }), stk({ order: { orderType: 'MKT', outsideRth: true, totalQuantity: 5, lmtPrice: undefined } }), stk({ order: { orderType: 'MKT', totalQuantity: 5, lmtPrice: undefined } })] });
H('afterhours', { now: ET('2026-10-14T17:00:00-04:00'), snapshot: { AAPL: 100 }, orders: [stk(), stk({ order: { orderType: 'MKT', outsideRth: true, totalQuantity: 5, lmtPrice: undefined } })] });
for (const st of ['盘外', '盘中', '休市', null, '', 'THROW', '盘前'])
  H(`status fn ${st}`, { now: CLOSED, status: { SPX: st, AAPL: st }, orders: [fly(), opt({ order: { orderType: 'MKT', lmtPrice: undefined, outsideRth: true } }), stk({ order: { orderType: 'MKT', totalQuantity: 5, lmtPrice: undefined } })] });
// 重复:批内与近期
H('dup in batch', { orders: [stk(), stk(), stk({ order: { totalQuantity: 12 } }), stk({ order: { totalQuantity: 13 } })] });
H('dup in batch tol 0', { config: cfgWith((c) => { c.limits.duplicate_qty_tolerance = 0; }), orders: [stk(), stk(), stk({ order: { totalQuantity: 11 } })] });
for (const q of [8, 7, 12, 13]) H(`dup tol boundary ${q}`, { orders: [stk(), stk({ order: { totalQuantity: q } })] });
const sigS = V.orderSignature(stk(), '模拟');
for (const dt of [0, 600000, 600001, 599999]) H(`recent window ${dt}`, { recent: [{ signature: sigS, quantity: 10, createdAtMs: NOW - dt }], orders: [stk()] });
H('recent window 0 minutes', { config: cfgWith((c) => { c.limits.duplicate_window_minutes = 0; }), recent: [{ signature: sigS, quantity: 10, createdAtMs: NOW }, { signature: sigS, quantity: 10, createdAtMs: NOW + 5 }], orders: [stk()] });
for (const fs of [undefined, null, 'cancelled', 'filled', 'ibkr_error'])
  for (const lp of [undefined, null, 100, 100.005, 100.004, 100.0049, 99.995, '100.5'])
    H(`recent status ${fs} price ${lp}`, { recent: [{ signature: sigS, quantity: 10, createdAtMs: NOW - 1000, ...(fs === undefined ? {} : { finalStatus: fs }), ...(lp === undefined ? {} : { limitPrice: lp }) }], orders: [stk()] });
// 两个限价正好差 0.005(0.01 − 0.005 在浮点里恰好是 0.005):算"差到一分钱以上"
H('recent cancelled price diff exactly 0.005', { recent: [{ signature: V.orderSignature(stk({ order: { lmtPrice: 0.01 } }), '模拟'), quantity: 10, createdAtMs: NOW - 1000, finalStatus: 'cancelled', limitPrice: 0.005 }],
  orders: [stk({ order: { lmtPrice: 0.01 } })] });
H('recent string qty', { recent: [{ signature: sigS, quantity: '10', createdAtMs: String(NOW - 1000) }], orders: [stk()] });
H('recent qty differ', { recent: [{ signature: sigS, quantity: 30, createdAtMs: NOW - 1000 }, { signature: 'zzz', quantity: 10, createdAtMs: NOW }], orders: [stk()] });
H('recent auto mid', { recent: [{ signature: V.orderSignature(fly({ auto: true }), '模拟'), quantity: 1, createdAtMs: NOW - 1000, finalStatus: 'cancelled', limitPrice: null }], orders: [fly({ auto: true })] });
// 单次上限
for (const limit of ['__omit__', null, 0, 1, 2, 2.5, NaN, Infinity, -1]) H(`limit ${limit}`, { limit, orders: [stk(), opt(), fly(), stk({ order: { totalQuantity: 3 } }), opt({ order: { totalQuantity: 2 } }), fly({ qty: 2 }), vert()] });
H('limit by config 1', { config: cfgWith((c) => { c.limits.max_orders_per_input = '1'; }), orders: [stk(), opt()] });
// 在手的累计上限(默认不设)
const OPEN = (risk, under) => cfgWith((c) => { c.limits.max_open_risk_usd = risk; c.limits.max_underlying_contracts = under; });
const keyFly = 'SPX|20261016';
H('open caps unset', { extras: { exposure: { riskUsd: { 模拟: 1e9 }, contracts: {}, notes: [] } }, orders: [fly()] });
H('open caps no exposure key', { config: OPEN(1000, 0), extras: {}, orders: [fly()] });
H('open caps exposure null', { config: OPEN(1000, 0), extras: { exposure: null }, orders: [fly(), stk()] });
H('open caps exposure null reduction', { config: OPEN(1000, 0), extras: { exposure: null, reduce: { '模拟|SPX': 1 } }, orders: [fly(), fly({ k: 5900 })] });
for (const held of [0, 749.99, 750, 750.01]) H(`open risk ${held}`, { config: OPEN(1000, 0), extras: { exposure: { riskUsd: { 模拟: held }, contracts: {}, notes: [] } }, orders: [fly()] });
H('open risk accumulates in batch', { config: OPEN(1000, 0), extras: { exposure: { riskUsd: {}, contracts: {}, notes: [] } }, orders: [fly(), fly({ k: 5900 }), fly({ k: 6000 }), fly({ k: 6100 }), fly({ k: 6200 })] });
H('open risk batch with reduction', { config: OPEN(1000, 0), extras: { exposure: { riskUsd: {}, contracts: {}, notes: [] }, reduce: { '模拟|SPX': 2 } }, orders: [fly(), fly({ k: 5900 }), fly({ k: 6000 }), fly({ k: 6100 }), fly({ k: 6200 })] });
for (const held of [3, 4, 5]) H(`open contracts ${held}`, { config: OPEN(0, 5), extras: { exposure: { riskUsd: {}, contracts: { [`模拟|${keyFly}`]: held }, notes: [] } }, orders: [fly({ qty: 1 })] });
H('open contracts batch', { config: OPEN(0, 5), extras: { exposure: { riskUsd: {}, contracts: {}, notes: [] } }, orders: [fly({ qty: 2 }), fly({ qty: 2, k: 5900 }), fly({ qty: 2, k: 6000 })] });
H('open both', { config: OPEN('500', '2'), extras: { exposure: { riskUsd: { 模拟: 400 }, contracts: { [`模拟|${keyFly}`]: 2 }, notes: [] }, capNote: '富途核对不了' }, orders: [fly()] });
H('open caps stock exempt', { config: OPEN(1, 1), extras: { exposure: null }, orders: [stk()] });
H('open caps by account', { config: cfgWith((c) => { c.limits.max_open_risk_usd = 1000; c.limits.by_account = { 模拟: { max_open_risk_usd: '0', max_underlying_contracts: 1 } }; }), extras: { exposure: { riskUsd: { 模拟: 900 }, contracts: {}, notes: [] } }, orders: [fly({ qty: 2 })] });
H('open caps limit issue skips', { config: OPEN(1000, 0), extras: { exposure: null }, orders: [fly({ qty: 11, lmt: 0.1 })] });
H('open caps prototype alias', { config: cfgWith((c) => { c.limits.max_open_risk_usd = 100; c.accounts.push({ alias: 'constructor', account_id: 'DUTEST009', is_paper: true, connection: 'paper' }); }),
  extras: { exposure: { riskUsd: { constructor: 500 }, contracts: {}, notes: [] } }, orders: [fly({ top: { account: 'constructor' } }), fly({ k: 5900, top: { account: 'constructor' } })] });
H('cap note approved', { config: OPEN(100000, 0), extras: { exposure: { riskUsd: {}, contracts: {}, notes: [] }, capNote: '富途读不出期权持仓' }, orders: [fly()] });
H('cap note no caps', { extras: { capNote: 'note' }, orders: [fly()] });
// 单笔风险预算(只告警)
const RB = (c) => { c.risk_budget = { enabled: true, max_risk_pct: 2, max_position_pct: 25, equity_usd: { 模拟: 0, 主账户: 50000 } }; };
H('risk budget broker equity', { config: cfgWith(RB), extras: { equity: { 模拟: 10000 } }, orders: [fly({ lmt: 2 }), fly({ lmt: 2.01, k: 5900 }), stk({ order: { totalQuantity: 25, lmtPrice: 100 } }), stk({ order: { totalQuantity: 26, lmtPrice: 100 } })] });
H('risk budget filled wins', { config: cfgWith((c) => { RB(c); c.risk_budget.equity_usd.模拟 = 20000; }), extras: { equity: { 模拟: 10000 } }, orders: [fly({ lmt: 4 })] });
H('risk budget no extras', { config: cfgWith(RB), orders: [fly({ lmt: 4 })] });
// 原因与模型自己的警告
H('reason blank and warnings', { orders: [P({ ...stk(), reason: '   ', warnings: ['a', 'b'] })] });


// ---------------------------------------------------------------- 验收补的:真实载荷能产生、之前夹具里没有的输入
// (1) 蝴蝶的腿比例:schema 允许每条腿 1–2,不止 (1,2,1) 与 (1,1,1)
{
  const flyRatios = (r, rev) => {
    const k = 5800, w = 10, e = '20261016';
    let legs = [{ ...leg('BUY', k - w, 'P', e), ratio: r[0] }, { ...leg('SELL', k, 'P', e), ratio: r[1] }, { ...leg('BUY', k + w, 'P', e), ratio: r[2] }];
    if (rev) legs = legs.reverse();
    return P({ intent_summary: 's', execution_type: 'IMMEDIATE', account: '模拟', reason: 'r', confidence: 0.95,
      contract: { secType: 'BAG', symbol: 'SPX', combo_strategy: 'BUTTERFLY', legs },
      order: { action: 'BUY', orderType: 'LMT', totalQuantity: 1, price_mode: 'EXPLICIT', lmtPrice: 2.5 } });
  };
  for (const r of [[1, 2, 1], [2, 2, 1], [1, 2, 2], [2, 1, 1], [2, 2, 2], [1, 1, 1], [1, 1, 2], [2, 1, 2], [1, 2, 1.0]])
    H(`fly ratios ${r.join(':')}`, { orders: [flyRatios(r, false), flyRatios(r, true)], limit: 5 });
}
// (2) BAG 的非限价单:price_mode 默认 EXPLICIT、lmtPrice 为空(市价 / 止损);风险只能按结构宽度取上界,单笔上限照样要拦
{
  const bagNL = (shape, orderType, qty, action) => P({ intent_summary: 's', execution_type: 'IMMEDIATE', account: '模拟', reason: 'r', confidence: 0.95,
    contract: shape.contract, order: { action: action ?? shape.order.action, orderType, totalQuantity: qty, price_mode: 'EXPLICIT', ...(orderType === 'STP' ? { auxPrice: 3 } : {}) } });
  const credit = vert({ action: 'SELL', legs: [leg('BUY', 5810, 'C', '20261016'), leg('SELL', 5800, 'C', '20261016')] });
  const tight = cfgWith((c) => { c.limits.max_order_notional = 1500; });
  for (const [name, shape] of [['fly', fly()], ['vertical debit', vert()], ['vertical credit', credit], ['condor', condor()]])
    for (const orderType of ['MKT', 'STP']) {
      H(`bag ${orderType} no lmt ${name} tight`, { config: tight, orders: [bagNL(shape, orderType, 1), bagNL(shape, orderType, 2)] });
      H(`bag ${orderType} no lmt ${name} default`, { orders: [bagNL(shape, orderType, 5), bagNL(shape, orderType, 10)] });
    }
  // 正好在线上:fly 宽 10 × 乘数 100 × 张数 5 = 5000
  H('bag MKT notional exactly at limit', { config: cfgWith((c) => { c.limits.max_order_notional = 5000; }), orders: [bagNL(fly(), 'MKT', 5)] });
  H('bag MKT notional just over limit', { config: cfgWith((c) => { c.limits.max_order_notional = 4999.99; }), orders: [bagNL(fly(), 'MKT', 5)] });
  H('bag STP sell condor under open cap', { config: OPEN(500, 0), extras: { exposure: { riskUsd: { 模拟: 100 }, contracts: {}, notes: [] } }, orders: [bagNL(condor(), 'STP', 1, 'SELL')] });
}
// (3) 指数月度到期日 = 第三个周五的前一个交易日:第三个周五是 21 号 / 15 号的月份
{
  if (new Date(Date.UTC(2026, 7, 1)).getUTCDay() !== 6) throw new Error('2026-08-01 应是周六');
  if (new Date(Date.UTC(2027, 0, 1)).getUTCDay() !== 5) throw new Error('2027-01-01 应是周五');
  if (new Date(Date.UTC(2027, 9, 1)).getUTCDay() !== 5) throw new Error('2027-10-01 应是周五');
  const AUG = ET('2026-08-10T11:00:00-04:00');
  const idx = { config: cfgWith(IDXCFG) };
  for (const [e, now] of [['20260820', AUG], ['20260821', AUG], ['20260819', AUG], ['20260827', AUG], ['20270114', NOW], ['20270115', NOW], ['20270113', NOW], ['20271014', NOW], ['20271015', NOW], ['20271021', NOW], ['20271022', NOW]])
    H(`third friday ${e}`, { ...idx, now, orders: [opt({ contract: { symbol: 'SPX', strike: 5800, lastTradeDateOrContractMonth: e }, order: { lmtPrice: 2 } }), fly({ exp: e }),
      opt({ contract: { symbol: 'SPX', strike: 5800, lastTradeDateOrContractMonth: e, tradingClass: 'SPXW' }, order: { lmtPrice: 2 } })] });
  // 第三个周五是 21 号,而且前一天休市:往前找上一个交易日
  H('third friday 21st, thursday holiday', { config: cfgWith((c) => { IDXCFG(c); c.market_holidays = ['2026-08-20']; }), now: AUG,
    orders: [opt({ contract: { symbol: 'SPX', strike: 5800, lastTradeDateOrContractMonth: '20260819' }, order: { lmtPrice: 2 } })] });
}
// (4) Object.prototype 上的名字当账户别名:TS 里批内累计 `this.batchRisk[alias]` 取到的是原型上的东西,在手风险上限永远不拦
{
  const NAMES = ['constructor', '__defineGetter__', '__defineSetter__', 'hasOwnProperty', '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf', 'propertyIsEnumerable', 'toString', 'valueOf', 'toLocaleString', '__proto__'];
  for (const [i, name] of NAMES.entries()) {
    const config = cfgWith((c) => { c.limits.max_open_risk_usd = 100; c.limits.max_underlying_contracts = 2; c.accounts.push({ alias: name, account_id: `DUTEST0${10 + i}`, is_paper: true, connection: 'paper' }); });
    const riskUsd = JSON.parse(`{"${name}": 500}`); // 自己的键(__proto__ 也是),与原型上的同名东西分开
    const contracts = { [`${name}|SPX|20261016`]: 5 };
    const orders = [fly({ top: { account: name } }), fly({ k: 5900, top: { account: name } }), fly({ k: 6000, qty: 3, top: { account: name } })];
    H(`prototype alias ${name} with exposure`, { config, extras: { exposure: { riskUsd, contracts, notes: [] } }, orders });
    H(`prototype alias ${name} empty exposure`, { config, extras: { exposure: { riskUsd: {}, contracts: {}, notes: [] } }, orders });
    H(`prototype alias ${name} no exposure`, { config, extras: { exposure: null }, orders });
    if (['__proto__', 'toString', 'constructor', 'valueOf'].includes(name)) H(`prototype alias ${name} reductions`, { config, extras: { exposure: { riskUsd: {}, contracts: {}, notes: [] }, reduce: { [`${name}|SPX`]: 1 } }, orders });
    if (['__proto__', 'toString'].includes(name)) H(`prototype alias ${name} risk budget and limits`, { config: cfgWith((c) => { c.accounts.push({ alias: name, account_id: `DUTEST0${10 + i}`, is_paper: true, connection: 'paper' });
      c.risk_budget = { enabled: true, max_risk_pct: 0.5, max_position_pct: 5, equity_usd: {} }; }), extras: { equity: { [name]: 1000 } }, orders: [fly({ top: { account: name } }), stk({ top: { account: name } })] });
  }
}


// ---------------------------------------------------------------- 没经过 ParsedOrderSchema 的形状(校验函数收的是任意对象):
// 变异检验里「生产路径上到不了」的幸存者,用解析之后再改过的订单直接触发,免得只靠一句等价的论证
{
  const R = (parsed, mut) => { const o = clone(parsed); mut(o); return o; };
  // 没有 lmtPrice 这一键(undefined ≠ null):`lmtPrice !== null` 为真
  H('raw: vertical AUTO_MID, lmtPrice key missing', { orders: [R(vert({ auto: true }), (o) => { delete o.order.lmtPrice; })] });
  H('raw: fly EXPLICIT, lmtPrice key missing', { orders: [R(fly(), (o) => { delete o.order.lmtPrice; })] });
  H('raw: vertical EXPLICIT debit, lmtPrice key missing', { orders: [R(vert(), (o) => { delete o.order.lmtPrice; })] });
  H('raw: condor sell EXPLICIT, lmtPrice key missing', { orders: [R(P({ ...condor(), order: { action: 'SELL', orderType: 'LMT', totalQuantity: 1, price_mode: 'EXPLICIT', lmtPrice: 5 } }), (o) => { delete o.order.lmtPrice; })] });
  H('raw: vertical AUTO_MID with a lmtPrice', { orders: [R(vert({ auto: true }), (o) => { o.order.lmtPrice = 2.5; })] });
  // 行权价是 NaN:Set 把 NaN 当同一个值
  H('raw: fly strikes NaN', { orders: [R(fly(), (o) => { o.contract.legs[0].strike = NaN; o.contract.legs[2].strike = NaN; })] });
  H('raw: condor strikes NaN', { orders: [R(condor(), (o) => { o.contract.legs[0].strike = NaN; o.contract.legs[1].strike = NaN; })] });
  // 腿数不对
  H('raw: vertical with three legs', { orders: [R(vert(), (o) => { o.contract.legs.push(leg('BUY', 5820, 'C', '20261016')); })] });
  H('raw: vertical with one leg', { orders: [R(vert(), (o) => { o.contract.legs.pop(); })] });
  H('raw: fly with four legs', { orders: [R(fly(), (o) => { o.contract.legs.push(leg('BUY', 5850, 'P', '20261016')); })] });
  H('raw: fly with two legs', { orders: [R(fly(), (o) => { o.contract.legs.pop(); })] });
  H('raw: condor with five legs', { orders: [R(condor(), (o) => { o.contract.legs.push(leg('BUY', 5900, 'C', '20261016')); })] });
  H('raw: condor with three legs', { orders: [R(condor(), (o) => { o.contract.legs.pop(); })] });
  H('raw: condor three puts one call', { orders: [R(condor(), (o) => { o.contract.legs[2].right = 'P'; })] });
  H('raw: condor leg right outside C/P', { orders: [R(condor(), (o) => { o.contract.legs[3].right = 'X'; })] });
  H('raw: condor one put three calls', { orders: [R(condor(), (o) => { o.contract.legs[0].right = 'C'; })] });
  // 理由是纯空白(schema 会 trim 掉)
  H('raw: reason whitespace only', { orders: [R(stk(), (o) => { o.reason = '   '; }), R(stk({ order: { totalQuantity: 3 } }), (o) => { o.reason = '\t\n'; })] });
  // 限价 / 触发价是 0(schema 要求 > 0)
  H('raw: stk lmtPrice 0', { snapshot: { AAPL: 120 }, orders: [R(stk({ order: { totalQuantity: 50 } }), (o) => { o.order.lmtPrice = 0; })] });
  H('raw: stk stp auxPrice 0', { snapshot: { AAPL: 120 }, orders: [R(stk({ order: { orderType: 'STP', auxPrice: 90, lmtPrice: undefined, totalQuantity: 50 } }), (o) => { o.order.auxPrice = 0; })] });
  H('raw: opt buy lmtPrice 0', { orders: [R(opt(), (o) => { o.order.lmtPrice = 0; })] });
  // 单腿期权的行权价 / 方向不合法
  H('raw: opt sell right null', { orders: [R(opt({ order: { action: 'SELL' } }), (o) => { o.contract.right = null; })] });
  H('raw: opt sell put strike null', { orders: [R(opt({ contract: { right: 'P', strike: 250 }, order: { action: 'SELL' } }), (o) => { o.contract.strike = null; })] });
  H('raw: opt sell put strike 0', { orders: [R(opt({ contract: { right: 'P', strike: 250 }, order: { action: 'SELL' } }), (o) => { o.contract.strike = 0; })] });
  H('raw: opt sell put strike negative', { orders: [R(opt({ contract: { right: 'P', strike: 250 }, order: { action: 'SELL' } }), (o) => { o.contract.strike = -5; })] });
  H('raw: opt buy strike null (signature)', { orders: [R(opt(), (o) => { o.contract.strike = null; })] });
  // 无参考价的正股单:只有市价与回撤单能走到这里;给一张没有限价的 LMT 看另一句话
  H('raw: stk LMT without a price, no snapshot', { orders: [R(stk({ order: { action: 'SELL', totalQuantity: 300 } }), (o) => { o.order.lmtPrice = null; })] });
  H('raw: stk STP LMT without prices, no snapshot', { orders: [R(stk({ order: { action: 'SELL', orderType: 'STP LMT', auxPrice: 90, lmtPrice: 91, totalQuantity: 300 } }), (o) => { o.order.lmtPrice = null; o.order.auxPrice = null; })] });
  // 到期日比 8 位长:在手张数上限的话里原样写出来的是前 8 位
  H('raw: opt expiry longer than 8, open contract cap', { config: OPEN(0, 2), extras: { exposure: { riskUsd: {}, contracts: { '模拟|AAPL|20261016': 5 }, notes: [] } },
    orders: [R(opt({ contract: { symbol: 'AAPL', strike: 250 } }), (o) => { o.contract.lastTradeDateOrContractMonth = '202610160'; })] });
  // 近期订单的数量写成无穷 / 两边都是 0
  H('raw: recent quantity infinity as string', { recent: [{ signature: sigS, quantity: 'Infinity', createdAtMs: NOW - 1000 }], orders: [R(stk(), (o) => { o.order.totalQuantity = Infinity; })] });
  H('raw: recent quantity zero', { recent: [{ signature: sigS, quantity: 0, createdAtMs: NOW - 1000 }, { signature: sigS, quantity: '0', createdAtMs: NOW - 1000 }], orders: [R(stk(), (o) => { o.order.totalQuantity = 0; })] });
  // 没有账户的订单:不管别的问题有没有,一定是 UNKNOWN_ACCOUNT
  H('raw: unknown account only', { orders: [stk({ top: { account: 'nobody' } })] });
}

out.runtime = process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`;
const text = JSON.stringify(out) + '\n';
writeFileSync(join(here, 'validator.json'), text);
console.log('validator.json', out.cases.length, 'cases', text.length, 'bytes');
