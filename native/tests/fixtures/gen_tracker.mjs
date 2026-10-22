// 生成 tracker.json:engine-ts 的 tracker.ts(原模块现跑)。持仓有正股、单腿、买卖蝴蝶(看涨看跌)、垂直价差、铁鹰、断翼与比例价差、坏腿;
// 标的目标价走五档波动率来源(ibkr / smile / net / leg / clock)与各种缺报价;追价、平仓单、托管单、校验与触发判断的各种设置。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_tracker.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const T = await import(pathToFileURL(join(engine, 'dist/src/tracker.js')).href);

let seed = 0x7a0c_4e11;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const gauss = () => { const u = rnd() || 1e-12, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
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
const run = (f) => { try { return { out: enc(f()) }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };

// ---------------------------------------------------------------- 持仓与合约
const leg = (strike, right, ratio, extra = {}) => ({ lastTradeDateOrContractMonth: '20261019', strike, right, ratio, ...extra });
const contracts = {
  stk: { secType: 'STK', symbol: 'AAPL', exchange: 'NASDAQ', currency: 'USD', primaryExchange: 'NASDAQ', multiplier: '1', tradingClass: 'NMS' },
  optC: { secType: 'OPT', symbol: 'SPX', lastTradeDateOrContractMonth: '20261019', strike: 5800, right: 'C', multiplier: '100', exchange: 'SMART', tradingClass: 'SPXW', conId: null },
  optP: { secType: 'OPT', symbol: 'SPX', lastTradeDateOrContractMonth: '20261019', strike: 5790, right: 'Put', multiplier: '100' },
  flyC: { secType: 'BAG', symbol: 'SPX', currency: 'USD', multiplier: '100', combo_strategy: 'BUTTERFLY', legs: [leg(5790, 'C', 1), leg(5800, 'C', -2), leg(5810, 'C', 1)] },
  flyP: { secType: 'BAG', symbol: 'SPX', multiplier: 100, combo_strategy: 'BUTTERFLY', legs: [leg(5780, 'P', 1), leg(5800, 'P', -2), leg(5820, 'P', 1)] },
  flyShort: { secType: 'BAG', symbol: 'SPX', combo_strategy: 'BUTTERFLY', legs: [leg(5790, 'C', -1), leg(5800, 'C', 2), leg(5810, 'C', -1)] },
  vert: { secType: 'BAG', symbol: 'SPX', combo_strategy: 'VERTICAL', legs: [leg(5770, 'P', -1), leg(5765, 'P', 1)] },
  condor: { secType: 'BAG', symbol: 'SPX', combo_strategy: 'IRON_CONDOR', legs: [leg(5750, 'P', 1), leg(5760, 'P', -1), leg(5840, 'C', -1), leg(5850, 'C', 1)] },
  broken: { secType: 'BAG', symbol: 'SPX', legs: [leg(5790, 'C', 1), leg(5800, 'C', -2), leg(5815, 'C', 1)] },
  ratio3: { secType: 'BAG', symbol: 'SPX', legs: [leg(5790, 'C', 1), leg(5800, 'C', -3)] },
  badLeg: { secType: 'BAG', symbol: 'SPX', combo_strategy: 'VERTICAL', legs: [leg(5790, 'C', 1), { strike: 5800, right: 'C', ratio: -1 }] },
  zeroRatio: { secType: 'BAG', symbol: 'SPX', legs: [leg(5790, 'C', 0), leg(5800, 'C', -1)] },
  noLegs: { secType: 'BAG', symbol: 'SPX', legs: [] },
  fop: { secType: 'FOP', symbol: 'ES', lastTradeDateOrContractMonth: '20261218', strike: 5800, right: 'C', multiplier: '50' },
  mixedRight: { secType: 'BAG', symbol: 'SPX', legs: [leg(5790, 'C', 1), leg(5800, 'P', -2), leg(5810, 'C', 1)] },
  notFly: { secType: 'BAG', symbol: 'SPX', legs: [leg(5790, 'C', 1), leg(5800, 'C', -1), leg(5810, 'C', 1)] },
  strRatio: { secType: 'BAG', symbol: 'SPX', combo_strategy: 'BUTTERFLY', legs: [leg('5790', 'c', '1'), leg('5800', 'c', '-2'), leg('5810', 'c', '1')] },
};
const positions = [];
const pos = (name, sec, qty, avg, mult, extra = {}) => positions.push({ name, p: { account: '模拟', symbol: sec === 'STK' ? 'AAPL' : 'SPX', sec_type: sec, quantity: qty, avg_cost: avg, multiplier: mult, currency: 'USD', market_price: null, market_value: null, unrealized_pnl: null, leg: '', ...extra } });
pos('long_stock', 'STK', 100, 220, 1); pos('short_stock', 'STK', -50, 250, 1); pos('long_opt', 'OPT', 2, 550, 100); pos('short_opt', 'OPT', -3, 420, 100);
pos('long_fly', 'BAG', 1, 250, 100); pos('long_fly3', 'BAG', 3, 180, 100); pos('short_fly', 'BAG', -2, 300, 100); pos('credit_vert', 'BAG', -1, -150, 100);
pos('broker', 'STK', 10, 100, 1, { unrealized_pnl: 55, market_value: 1055 }); pos('broker_nan', 'STK', 10, 100, 1, { unrealized_pnl: NaN, market_value: 990 });
pos('zero', 'STK', 0, 100, 1); pos('broker_nomv', 'STK', 10, 100, 1, { unrealized_pnl: 30, market_value: null }); pos('mult0', 'OPT', 1, 300, 0); pos('frac', 'STK', 7.6, 10, 1);
const P = (name) => positions.find((x) => x.name === name).p;
const contractFor = (p) => (p.sec_type === 'STK' ? contracts.stk : p.sec_type === 'OPT' ? pick([contracts.optC, contracts.optP]) : pick([contracts.flyC, contracts.flyP, contracts.flyShort, contracts.vert, contracts.condor, contracts.broken]));

const out = { positions: enc(positions), contracts, keys: [], targets: [], profiles: [], structures: [], spot: [], natural: [], chase: [], pnl: [], validate: [], evaluate: [], triggers: [], unreachable: [],
  autos: [], blockers: [], qty: [], limit: [], close: [], closeIssue: [], orders: [], ptrail: [], hosted: [], needs: [], sweep: [] };

for (const t of [{ account: 'a', symbol: 'S', sec_type: 'STK' }, { account: 'a', symbol: 'S', sec_type: '', leg: '' }, { account: 1, symbol: null }, { account: 'a', symbol: 'S', sec_type: 'OPT', leg: 'x|1|C' }])
  out.keys.push({ t, out: T.trackKey(t) });
const rawTargets = () => {
  const t = {};
  for (const [k, pool] of [['take_profit', [250, 6, 0, -1, 'x', null]], ['stop_loss', [210, 2, 0, 300]], ['trail_pct', [5, 0, 100, 50]], ['profit_drawdown_pct', [25, 0, 99, 101]],
    ['profit_drawdown_tiers', [[], [{ above: 0, pct: 40 }, { above: 1, pct: 30 }], null]], ['profit_drawdown_arm', [0.3, null]], ['profit_drawdown_floor', [0.2, null]],
    ['profit_drawdown_late', [{ after: '15:00', factor: 0.5 }, null]], ['spot_target', [5810, null]], ['exit_at_ms', [1, null]], ['take_profit_tiers', [[], [{ price: 3 }]]]]) {
    if (rnd() < 0.35) t[k] = pick(pool);
  }
  return t;
};
for (let i = 0; i < 60; i += 1) { const raw = rawTargets(); const tg = T.makeTargets(raw); out.targets.push({ raw: enc(raw), out: enc(tg), empty: T.targetsEmpty(tg), emptyRaw: T.targetsEmpty(raw) }); }
for (const [n, c] of Object.entries(contracts)) for (const sec of ['STK', 'OPT', 'FOP', 'BAG', '', 'CASH']) {
  out.profiles.push({ c: n, sec, profile: run(() => T.flyProfileOf(c)), structure: run(() => T.structureOf(sec, c)) });
}
out.profiles.push({ c: '__null', sec: 'BAG', profile: run(() => T.flyProfileOf(null)), structure: run(() => T.structureOf('BAG', null)) });
out.profiles.push({ c: '__legs3str', sec: 'BAG', profile: run(() => T.flyProfileOf({ secType: 'BAG', legs: 'abc' })), structure: run(() => T.structureOf('BAG', { legs: 'abc' })) });
out.profiles.push({ c: '__nullLeg', sec: 'BAG', profile: run(() => T.flyProfileOf({ secType: 'BAG', legs: [null, 1, 2] })), structure: run(() => T.structureOf('BAG', { legs: [null] })) });

// ---------------------------------------------------------------- 标的目标价
const now = Date.parse('2026-10-19T17:00:00Z'), expiry = Date.parse('2026-10-19T20:00:00Z');
for (let i = 0; i < 900; i += 1) {
  const p = pick(positions).p;
  const c = p.sec_type === 'STK' ? contracts.stk : p.sec_type === 'OPT' ? pick([contracts.optC, contracts.optP]) : pick([contracts.flyC, contracts.flyP, contracts.flyShort, contracts.vert, contracts.condor, contracts.strRatio]);
  const st = T.structureOf(p.sec_type, c);
  if (st === null) continue;
  const spot = rnd() < 0.1 ? pick([null, NaN]) : 5800 + gauss() * 12;
  const legPrices = {}, legIvs = {};
  for (const l of st.legs) {
    if (rnd() < 0.9) legPrices[T.legPriceKey(l)] = rnd() < 0.08 ? pick([null, 0, -1, 'x']) : Math.max(0.05, Math.round(Math.max(0, l.right === 'C' ? 5800 - l.strike : l.strike - 5800) * 20 + 3 + 20 * rnd()) / 20);
    if (rnd() < 0.95) legIvs[T.legPriceKey(l)] = rnd() < 0.04 ? pick([null, 0, 'x']) : 0.1 + 0.1 * rnd();
  }
  const args = {
    structure: st, position: p, spotTarget: rnd() < 0.05 ? pick([0, -5]) : p.sec_type === 'STK' ? pick([240, 225, 210.5]) : pick([5810, 5800, 5790, 5830, 5805.5, 5815]), spot,
    markPrice: rnd() < 0.15 ? null : pick([2.5, 4, 0.3, 12, 1, NaN]), legPrices: rnd() < 0.1 ? null : legPrices, minute: pick([null, 600, 900, 959, 960, 1000]),
    em: pick([undefined, null, 30, NaN]), spotNote: pick([undefined, '期货推算']), legIvs: rnd() < 0.5 ? legIvs : pick([null, undefined, {}]),
    expiryMs: pick([expiry, null, undefined]), nowMs: pick([now, null, undefined, now + 4e6]),
  };
  const r = run(() => T.spotTarget(args));
  const v = run(() => T.validateSpotTarget({ ...args, contract: c }));
  out.spot.push({ p: positions.indexOf(positions.find((x) => x.p === p)), c: Object.keys(contracts).find((k) => contracts[k] === c), args: enc({ ...args, structure: undefined, position: undefined }), ...r, validate: v });
}
// ibkr 档专门走一遍:各腿 IV 全、时刻全
for (let i = 0; i < 200; i += 1) {
  const p = pick(positions.filter((x) => x.p.sec_type !== 'STK')).p;
  const c = p.sec_type === 'OPT' ? pick([contracts.optC, contracts.optP]) : pick([contracts.flyC, contracts.flyP, contracts.vert, contracts.condor]);
  const st = T.structureOf(p.sec_type, c);
  if (st === null) continue;
  const legIvs = {}, legPrices = {};
  for (const l of st.legs) { legIvs[T.legPriceKey(l)] = 0.1 + 0.15 * rnd(); legPrices[T.legPriceKey(l)] = 1 + 5 * rnd(); }
  const args = { structure: st, position: p, spotTarget: pick([5810, 5800, 5790, 5830]), spot: 5800 + gauss() * 10, markPrice: rnd() < 0.2 ? null : 1 + 6 * rnd(), legPrices, minute: 700,
    legIvs, expiryMs: expiry, nowMs: pick([now, expiry + 1, expiry - 60000]) };
  out.spot.push({ p: positions.findIndex((x) => x.p === p), c: Object.keys(contracts).find((k) => contracts[k] === c), args: enc({ ...args, structure: undefined, position: undefined }),
    ...run(() => T.spotTarget(args)), validate: run(() => T.validateSpotTarget({ ...args, contract: c })) });
}
// ---------------------------------------------------------------- 立刻能成交的价与追价
for (let i = 0; i < 400; i += 1) {
  const p = pick(positions).p;
  const c = contractFor(p);
  const st = T.structureOf(p.sec_type, c);
  if (st === null) continue;
  const book = {};
  for (const l of st.legs) if (rnd() < 0.93) book[T.legPriceKey(l)] = { bid: pick([1.2, 0, -1, null, 3.05, 0.05, 2.95]), ask: pick([1.4, 0, 1.1, null, 3.25, 3.1]) };
  const natural = T.naturalClosePrice(p, st, book);
  const auto = T.makeAutoClose({ chase_max_pct: pick([10, 0, 50, undefined]), stop_chase_grace: pick([null, 0, 5]), stop_chase_step: pick([null, 2]), stop_chase_max_pct: pick([null, 30]) });
  const reason = pick([null, undefined, 'stop_loss', 'take_profit', 'profit_trail', 'manual', 'time_exit']);
  const nat = natural ?? pick([3.15, 2.95, 0.07, 12.35]);
  const rows = [];
  for (const rounds of [0, 1, 2, 3, 5, 20, 1000]) for (const prev of [null, nat, nat - 0.1, nat + 0.1]) rows.push([rounds, prev, T.chaseLimit(p, nat, prev, rounds, auto, reason)]);
  out.natural.push({ p: positions.indexOf(positions.find((x) => x.p === p)), c: Object.keys(contracts).find((k) => contracts[k] === c), book: enc(book), out: enc(natural) });
  out.chase.push({ p: positions.indexOf(positions.find((x) => x.p === p)), nat, auto, reason: enc(reason), max: T.chaseMaxSteps(p, nat, auto, reason), floor: T.chaseFloor(p, nat, auto, reason), rows });
}
// 自然价正好 3 元:单腿期权的跳动在这里换档(3 元及以上 0.10)
for (const pn of ['long_opt', 'short_opt']) {
  const p = P(pn), auto = T.makeAutoClose({ chase_max_pct: 10 });
  const rows = [];
  for (const rounds of [0, 3, 6, 50]) rows.push([rounds, null, T.chaseLimit(p, 3, null, rounds, auto, null)]);
  out.chase.push({ p: positions.findIndex((x) => x.name === pn), nat: 3, auto, reason: null, max: T.chaseMaxSteps(p, 3, auto, null), floor: T.chaseFloor(p, 3, auto, null), rows });
}
for (const t of [{ fired_state: 'sweep:stop_loss' }, { fired_state: 'stop_loss' }, {}, { fired_state: 5 }, { fired_state: 'sweep:' }, { fired_state: 'x sweep:y' }]) out.sweep.push({ t, out: enc(T.sweepReason(t)) });

// ---------------------------------------------------------------- 盈亏、校验、触发
for (const { p } of positions) for (const price of [230, 210, null, NaN, 0, 5.5, -1]) out.pnl.push({ p: positions.findIndex((x) => x.p === p), price: enc(price), out: enc(T.unrealized(p, price)), mv: enc(T.marketValue(p, price)) });
for (let i = 0; i < 400; i += 1) {
  const p = pick(positions).p;
  const tg = rnd() < 0.8 ? T.makeTargets(rawTargets()) : rawTargets();
  const price = pick([230, 200, 255, null, 5, 3, 0.5, NaN]);
  out.validate.push({ p: positions.findIndex((x) => x.p === p), t: enc(tg), price: enc(price), ...run(() => { T.validate(p, tg, price); return 'ok'; }) });
}
for (let i = 0; i < 1200; i += 1) {
  const p = pick(positions).p;
  const tg = rnd() < 0.85 ? T.makeTargets(rawTargets()) : rawTargets();
  const base = p.sec_type === 'STK' ? 230 : 5;
  const price = rnd() < 0.08 ? pick([null, NaN]) : base * (1 + gauss() * 0.15);
  const peak = rnd() < 0.3 ? null : base * (1 + gauss() * 0.2);
  const minute = pick([null, 600, 900, 901]);
  const opts = rnd() < 0.5 ? {} : { stopPrice: pick([undefined, null, base * 0.9, base * 1.1, NaN]), ...(rnd() < 0.5 ? { peakPrice: pick([null, base * 1.2, undefined]) } : {}) };
  out.evaluate.push({ p: positions.findIndex((x) => x.p === p), t: enc(tg), price: enc(price), peak: enc(peak), minute, opts: enc(opts), hasStop: 'stopPrice' in opts, hasPeak: 'peakPrice' in opts, ...run(() => T.evaluate(p, tg, price, peak, minute, opts)) });
  if (rnd() < 0.3) {
    const r = T.evaluate(p, tg, price, peak, minute, opts);
    const target = pick([null, { reached: true, spot: 5810.25 }, { reached: false, spot: null }]);
    const stop = pick([null, { hit: true, reason: '标的跌破 5790' }, { hit: false, reason: '' }]);
    out.triggers.push({ r: enc(r), t: enc(tg), target, stop, out: enc(T.withSpotTriggers(r, 'SPX', tg, target, stop)) });
  }
}
// 写明的边:止损 = 止盈、止盈 / 止损正好在现价上、负的峰值
for (const [pn, t, price] of [['long_stock', { take_profit: 230, stop_loss: 230 }, 220], ['long_stock', { take_profit: 230 }, 230], ['short_stock', { stop_loss: 240 }, 240],
  ['long_stock', { stop_loss: 230 }, 230], ['short_stock', { take_profit: 240, stop_loss: 240 }, 245], ['short_stock', { take_profit: 240 }, 240]]) {
  const tg = T.makeTargets(t);
  out.validate.push({ p: positions.findIndex((x) => x.name === pn), t: enc(tg), price, ...run(() => { T.validate(P(pn), tg, price); return 'ok'; }) });
}
for (const [pn, peak, price] of [['credit_vert', -1.5, -1.2], ['credit_vert', -0.5, 0.2], ['long_fly', -0.1, 0.5], ['short_opt', -2, 1]]) {
  const tg = T.makeTargets({ trail_pct: 10, stop_loss: null });
  out.evaluate.push({ p: positions.findIndex((x) => x.name === pn), t: enc(tg), price, peak, minute: null, opts: {}, hasStop: false, hasPeak: false, ...run(() => T.evaluate(P(pn), tg, price, peak, null, {})) });
}
for (const [pn, peak] of [['long_stock', 220], ['long_opt', 5.5], ['long_fly', 2.5], ['short_stock', 250], ['short_opt', 4.2]]) for (const dd of [30, 50]) for (const fl of [null, 0.2])
  out.ptrail.push({ p: positions.findIndex((x) => x.name === pn), peak, dd, fl, out: enc(T.profitTrailStopPrice(P(pn), peak, dd, fl)) });
for (const pn of ['long_opt', 'short_opt']) for (const price of [3, 3.0000001, 2.9999999]) for (const slip of [0, 0.3])
  out.limit.push({ p: positions.findIndex((x) => x.name === pn), price, slip, out: enc(T.closeLimitPrice(P(pn), price, slip)) });
for (const pn of ['long_opt', 'short_opt']) for (const tp of [3, 6.37]) for (const sl of [3, 2.04]) {
  const tg = T.makeTargets({ take_profit: tp, stop_loss: sl });
  const auto = T.makeAutoClose({ enabled: true, host_at_broker: true });
  out.hosted.push({ p: positions.findIndex((x) => x.name === pn), t: tg, auto, peak: null, ...run(() => T.hostedPlan(P(pn), tg, auto, null)) });
}
for (const [cov, acct] of [[null, 'a'], [['a', 'b'], 'a'], [['b'], 'a'], [[], 5]]) out.unreachable.push({ cov, acct, out: T.unreachableReason(cov === null ? null : new Set(cov), acct) });

// ---------------------------------------------------------------- 平仓单与托管
const autoRaws = [{}, { enabled: true }, { enabled: true, order_type: 'LMT', slippage_pct: 0.5 }, { enabled: true, order_type: 'MKT', close_fraction_pct: 50 }, { enabled: true, close_fraction_pct: 0 },
  { enabled: true, close_fraction_pct: 101 }, { enabled: true, close_fraction_pct: 33.3 }, { enabled: 1, order_type: 'STP', stop_basis: 'natural', peak_confirm: 'yes' }, { enabled: true, host_at_broker: true, order_type: 'LMT', slippage_pct: -2 },
  { enabled: true, host_at_broker: true, stop_basis: 'natural', peak_confirm: true }, { enabled: true, slippage_pct: 'x', order_type: 'LMT' }, { enabled: true, order_type: undefined }];
for (const a of autoRaws) out.autos.push({ raw: enc(a), out: T.makeAutoClose(a) });
for (let i = 0; i < 200; i += 1) {
  const p = pick(positions).p;
  const args = { auto: T.makeAutoClose(pick(autoRaws)), position: p, accountIsPaper: rnd() < 0.5, autoExecute: rnd() < 0.8, allowLiveTrading: rnd() < 0.5, breakerEngaged: rnd() < 0.2,
    marketStatus: pick(['盘中', '盘前', '盘后', '盘外', '休市']), outsideRth: rnd() < 0.4, alreadyFired: rnd() < 0.2 };
  out.blockers.push({ p: positions.findIndex((x) => x.p === p), args: { ...args, position: undefined }, out: T.closeBlockers(args) });
}
for (const { p } of positions) for (const a of autoRaws) {
  const auto = T.makeAutoClose(a);
  out.qty.push({ p: positions.findIndex((x) => x.p === p), auto, ...run(() => T.closeQty(p, auto)) });
  for (const price of [230, 2.97, 3, 3.03, 12.36, null, 0.01]) for (const slip of [0.3, 5, -1, 'x']) if (rnd() < 0.15) out.limit.push({ p: positions.findIndex((x) => x.p === p), price, slip, out: enc(T.closeLimitPrice(p, price, slip)) });
}
for (const [n, c] of Object.entries(contracts)) out.close.push({ c: n, ...run(() => T.closeContract(c)) });
for (const extra of [{ secType: 'BAG', legs: 'ab' }, { secType: 'BAG', legs: [null] }, { secType: 'BAG', legs: [5] }, { secType: 'BAG', legs: [leg(1, 'C', NaN)] }, { secType: 'BAG', legs: [leg(1, 'C', 'x')] },
  { secType: 'BAG', legs: [leg(1, 'C', 1.5)] }, { secType: 'BAG', legs: [leg(1, '', 1)] }, { secType: 'BAG', legs: [leg(1, 'c', -2.0000001)] }, { secType: 'BAG', symbol: 'SPX', legs: [leg(1, 'C', 1)], combo_strategy: '' }])
  out.close.push({ c: '__extra', raw: enc(extra), ...run(() => T.closeContract(extra)) });
for (const row of [null, {}, { contract: null }, { contract: 'x' }, ...Object.values(contracts).map((c) => ({ contract: c }))]) out.closeIssue.push({ row: enc(row), out: T.closeContractIssue(row) });
for (let i = 0; i < 300; i += 1) {
  const p = pick(positions).p;
  const auto = T.makeAutoClose(pick(autoRaws));
  const c = contractFor(p);
  const price = pick([230, 5.75, 3.02, null, 0.3, 249.995]);
  const state = pick(['take_profit', 'stop_loss', 'profit_trail', 'manual', 'time_exit', 'holding']);
  const ms = pick(['盘中', '盘前', '盘外', '休市']);
  out.orders.push({ p: positions.findIndex((x) => x.p === p), c: Object.keys(contracts).find((k) => contracts[k] === c), auto, price, state, ms, ...run(() => T.buildCloseOrder(p, auto, price, state, c, ms)) });
}
for (const { p } of positions) for (const peak of [260, 210, null, 5, 2, 0.5]) for (const dd of [30, 0, 100, null, 50]) for (const fl of [null, 0.2, 50]) {
  if (rnd() < 0.5) continue;
  out.ptrail.push({ p: positions.findIndex((x) => x.p === p), peak, dd, fl, out: enc(T.profitTrailStopPrice(p, peak, dd, fl)) });
}
for (let i = 0; i < 400; i += 1) {
  const p = pick(positions).p;
  const tg = T.makeTargets({ take_profit: pick([250, 6.37, 2.98, 12.33, null, 0.004]), stop_loss: pick([200, 2.03, 3.17, null, 9.88]), trail_pct: pick([5, null, 0, 100, 2.5]),
    profit_drawdown_pct: pick([30, null, 0]), profit_drawdown_arm: pick([null, 0.3, 5]) });
  const auto = T.makeAutoClose(pick(autoRaws.filter((a) => a.host_at_broker)));
  const peak = pick([null, 240, 5.5, 2.4, 300]);
  const used = rnd() < 0.8 ? auto : T.makeAutoClose({ enabled: true });
  out.hosted.push({ p: positions.findIndex((x) => x.p === p), t: tg, auto: used, peak, ...run(() => T.hostedPlan(p, tg, used, peak)) });
}
for (let i = 0; i < 200; i += 1) {
  const mk = () => ({ quantity: pick([100, 100.9, '100', null, undefined, 'x', 99]), lmt_price: pick([250, 250.004, 250.006, null, 'x', undefined]), aux_price: pick([236, 236.005, null]), trailing_percent: pick([5, null, 5.004]) });
  const a = mk(), b = mk();
  out.needs.push({ a: enc(a), b: enc(b), out: T.hostedNeedsUpdate(a, b) });
}
writeFileSync(join(here, 'tracker.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
console.log('tracker.json', Object.entries(out).map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : Object.keys(v).length}`).join(' '));
