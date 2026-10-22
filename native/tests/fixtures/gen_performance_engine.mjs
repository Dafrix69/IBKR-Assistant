// 生成 performance_engine.json:engine-ts 的 performance.ts(绩效体检的计算,原模块现跑)。
//   · 账本:butterflyLedger / stockLedger(含 plannedStopFor 的初始止损)/ positionLedger / optionLedger / buildLedger,输入由 ibtrades.groupButterflies、
//     stockreview.groupStockTrips 与两个 CSV 解析器现造(同 gen_trade_outcomes.mjs 的做法),再往里掺佣金、坏时间、id 撞 Object.prototype、null 记录;
//   · 统计与规则:造出来的账本(按场景调过的:亏完马上再进、亏后加码、时段差异、亏损单拿得久、过度交易、尾部大亏、最近走弱……)上的
//     perfStats / rStats / rCoverage / equityCurve / perDay / kellyOf / sessionOf / sqnLabel / filterLedger / revengeSplit / sameSymbolReentry /
//     sizeAfterLoss / dailyLossReplay / lossBursts,以及整份 performanceReport(范围、品种、天数、保护规则的现值、平仓痕)。
//     performanceReport 的 trades 一栏(账本行的原样,已在账本那几节逐字比过)这里只记 id 的次序,夹具才放得下;前两份留全文。
// settleClose 与 isPaper 用查表,表在夹具里。账号是假的。随机数固定种子,跑两次逐字节相同。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_performance_engine.mjs <engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const imp = (m) => import(pathToFileURL(join(engine, `dist/src/${m}.js`)).href);
const X = await imp('performance');
const I = await imp('ibtrades');
const S = await imp('stockreview');
const O = await imp('optionTradesCsv');
const PC = await imp('optionPositionsCsv');
const INF = await imp('inference');
const TRV = await imp('tradereview');

let seed = 0x6e2f_b041;
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
const rt = (o) => JSON.parse(JSON.stringify(o));
const run = (f) => { try { return { out: enc(f()) }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };
const pad = (n) => String(n).padStart(2, '0');
const iso = (ms) => new Date(ms).toISOString().replace(/\.000Z$/, '+00:00');

const closes = {};
for (const sym of ['SPX', 'XSP', 'NDX']) for (let d = 1; d <= 31; d += 1) if (rnd() < 0.7) closes[`${sym}|2026-10-${pad(d)}`] = Math.round((sym === 'XSP' ? 580 : 5800) + (rnd() - 0.5) * 60);
const settle = (symbol, date) => closes[`${symbol}|${date}`] ?? null;
const isPaper = (id) => id.startsWith('DU');
const out = { runtime: '', closes, fly: [], stops: [], stock: [], position: [], option: [], build: [], stats: [], reports: [], misc: {} };

// ---------------------------------------------------------------- 蝴蝶
function flyFills(o) {
  const k = o.center ?? 5800, w = o.wing ?? 10, day = o.day ?? '20261016';
  const wing = o.action === 'SELL' ? 'SLD' : 'BOT', body = wing === 'BOT' ? 'SLD' : 'BOT';
  return [k - w, k, k + w].map((strike, i) => ({ account_id: o.account ?? 'DUTEST001', perm_id: o.perm, order_id: 1, exec_id: `x${o.perm}.${i}`,
    time: `${day}-${pad(o.hh ?? 14)}:${pad(o.mm ?? int(0, 59))}:00`, side: i === 1 ? body : wing, shares: (i === 1 ? 2 : 1) * (o.qty ?? 1), price: o.prices?.[i] ?? [3, 2, 1.5][i],
    commission: o.comm ?? pick([0.65, 1.1, undefined, 0]),
    contract: { secType: 'OPT', symbol: o.symbol ?? 'SPX', strike, right: o.right ?? 'P', expiry: day, tradingClass: 'SPXW', multiplier: '100', conId: 7 } }));
}
const DAYS = ['20261002', '20261009', '20261015', '20261016', '20261023', '20261030'];
function recordSet() {
  const fills = [];
  let perm = int(100, 900);
  for (let i = 0; i < int(1, 6); i += 1) {
    const o = { perm: (perm += 1), day: pick(DAYS), center: pick([5800, 5810, 580]), wing: pick([10, 5]), symbol: pick(['SPX', 'SPX', 'XSP', 'NDX']), right: pick(['P', 'C']),
      account: pick(['DUTEST001', 'UXTEST123']), hh: int(13, 19), qty: pick([1, 1, 2]), action: pick(['BUY', 'BUY', 'BUY', 'SELL']) };
    fills.push(...flyFills(o));
    if (rnd() < 0.5) fills.push(...flyFills({ ...o, perm: (perm += 1), action: o.action === 'SELL' ? 'BUY' : 'SELL', hh: o.hh + 1, prices: [pick([1, 4, 6]), 2, 1] }));
  }
  let recs = I.groupButterflies(fills, [{ account_id: 'DUTEST001', alias: '模拟', is_paper: true }]);
  recs = recs.map((r) => {
    const x = rt(r);
    const t = pick([null, null, 'noFill', 'noCreated', 'idProto', 'idNum', 'idNull', 'noId', 'zeroDebit', 'noComm', 'strComm', 'notFly', null, null, null, null, null]);
    if (t === 'noFill') x.ibkr.avg_fill_price = null;
    if (t === 'noCreated') delete x.created_at;
    if (t === 'idProto') x.id = pick(['toString', 'constructor', '__proto__', 'valueOf']);
    if (t === 'idNum') x.id = int(1, 9);
    if (t === 'idNull') x.id = null;
    if (t === 'noId') delete x.id;
    if (t === 'zeroDebit') x.ibkr.avg_fill_price = 0;
    if (t === 'noComm') delete x.ibkr.total_commission;
    if (t === 'strComm') x.ibkr.total_commission = pick(['1.3', '', 'x']);
    if (t === 'notFly') x.contract.secType = 'OPT';
    if (rnd() < 0.12) x.contract.multiplier = pick(['10', '50', 'x']);
    if (rnd() < 0.15 && Array.isArray(x.contract.legs)) {
      const hi = x.contract.legs.reduce((a, l) => (Number(l.strike) > Number(a.strike) ? l : a));
      hi.strike = Number(hi.strike) + 5; // 不对称(破翼)
    }
    if (rnd() < 0.2) x.account = null;
    return x;
  });
  return recs;
}
for (let i = 0; i < 30; i += 1) {
  const recs = recordSet();
  const now = rnd() < 0.7 ? Date.UTC(2026, 10, 5) : Date.UTC(2026, 9, int(1, 31), int(0, 23));
  out.fly.push({ records: recs, now, ...run(() => { const ex = { open: 0, unknown: 0, no_cost: 0 }; const t = X.butterflyLedger(recs, settle, now, ex); return { trades: t, excluded: ex }; }) });
}
{
  let recs = recordSet().filter((r) => TRV.butterflyProfile(r) !== null);
  for (let k = 0; recs.length === 0; k += 1) recs = recordSet().filter((r) => TRV.butterflyProfile(r) !== null);
  const one = [recs[0]];
  const at = TRV.expiryClose(TRV.butterflyProfile(recs[0]));
  for (const now of [at - 1, at, at + 1]) out.fly.push({ records: one, now, ...run(() => { const ex = { open: 0, unknown: 0, no_cost: 0 }; return { trades: X.butterflyLedger(one, settle, now, ex), excluded: ex }; }) });
}
{
  const key = Object.keys(closes).filter((k) => k.startsWith('SPX|')).sort().find((k) => k.split('|')[1] >= '2026-10-02');
  const dayIso = key.split('|')[1];
  const dayStr = dayIso.replaceAll('-', '');
  for (const [n, price] of [[0, 9.99], [1, 10], [2, 10.01], [3, 0.5]]) {
    const recs = rt(I.groupButterflies(flyFills({ perm: 9100 + n, day: dayStr, action: 'SELL', hh: 14, mm: 0, center: 5800, wing: 10, comm: 1 }), []));
    recs[0].ibkr.avg_fill_price = price;
    const now = Date.UTC(2026, 10, 5);
    out.fly.push({ records: recs, now, ...run(() => { const ex = { open: 0, unknown: 0, no_cost: 0 }; return { trades: X.butterflyLedger(recs, settle, now, ex), excluded: ex }; }) });
  }
}
out.fly.push({ records: [null], now: 0, ...run(() => { const ex = { open: 0, unknown: 0, no_cost: 0 }; return { trades: X.butterflyLedger([null], settle, 0, ex), excluded: ex }; }) });

// ---------------------------------------------------------------- 股票 + 初始止损
function tripSet(i) {
  const fills = [];
  let t = Date.UTC(2026, 8, 14, 14, 0);
  // 多半是一开一平(做多先买后卖、做空先卖后买),间或加仓、只平一半、乱序
  for (let j = 0; j < int(1, 5); j += 1) {
    const sym = pick(['AAPL', 'MSFT']), acct = pick(['DUTEST001', 'UXTEST123']), long = rnd() < 0.8, sh = pick([10, 20]);
    const legs = [[long ? 'BOT' : 'SLD', sh]];
    if (rnd() < 0.3) legs.push([long ? 'BOT' : 'SLD', sh]);
    legs.push([long ? 'SLD' : 'BOT', legs.length === 2 ? 2 * sh : sh]);
    if (rnd() < 0.15) legs[legs.length - 1][1] = sh / 2;
    for (const [k, [side, shares]] of legs.entries()) {
      t += pick([60e3, 300e3, 600e3, 3600e3, 86400e3]);
      const d = new Date(t);
      fills.push({ exec_id: `s${i}.${j}.${k}`, time: `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`,
        account_id: acct, side, shares, price: 100 + int(-5, 5), perm_id: 1000 + i * 100 + j * 10 + k,
        commission: pick([1, 0.5, undefined]), contract: { secType: 'STK', symbol: sym } });
    }
  }
  const trips = rt(S.groupStockTrips(fills, [{ account_id: 'DUTEST001', alias: '模拟', is_paper: true }, { account_id: 'UXTEST123', alias: '主账户', is_paper: false }], pick([null, {}])));
  for (const tr of trips) {
    if (rnd() < 0.1) tr.avg_entry = pick([0, null, '5', 'x', '']);
    if (rnd() < 0.1) tr.qty = pick([0, null, '3', -1]);
    if (rnd() < 0.08) tr.closed_at = pick([null, 'bad']);
    if (rnd() < 0.08) tr.created_at = pick([null, 'bad']);
    if (rnd() < 0.08) tr.realized_pnl = pick([null, '', '12.5']);
    if (rnd() < 0.08) tr.carried = true;
    if (rnd() < 0.08) tr.commission = pick([null, '0.7']);
    if (rnd() < 0.05) tr.side = 'SHORT';
    if (rnd() < 0.05) tr.account = null;
  }
  return trips;
}
function stopsFor(trips) {
  const stops = [];
  for (const tr of trips) {
    const from = Date.parse(String(tr.created_at ?? '').replace(/^(\d{4})(\d{2})(\d{2})-/, '$1-$2-$3T') + 'Z');
    const entry = Number(tr.avg_entry);
    if (!Number.isFinite(from) || !Number.isFinite(entry)) continue;
    for (let k = 0; k < int(0, 3); k += 1) {
      const offMin = pick([-5, 0, 5, 14.99, 15, 15.01, 30, 600, 1e6]);
      stops.push({ at: pick([iso(from + offMin * 60000), iso(from + offMin * 60000), 'bad']), account: pick([null, null, '模拟', '主账户', '']),
        symbol: pick([String(tr.symbol ?? '').toUpperCase(), String(tr.symbol ?? '').toLowerCase(), 'ZZZ']), sec_type: pick([null, 'STK', 'STK', 'OPT']),
        stop: pick([entry - 2, entry - 0.01, entry, entry + 2, entry - 10]) });
    }
  }
  return stops;
}
for (let i = 0; i < 25; i += 1) {
  const trips = tripSet(i);
  const stops = stopsFor(trips);
  out.stock.push({ trips, stops, ...run(() => { const ex = { open: 0, unknown: 0, no_cost: 0 }; return { trades: X.stockLedger(trips, ex, stops), excluded: ex }; }) });
  if (i < 10) for (const tr of trips) out.stops.push({ trip: tr, stops, ...run(() => X.plannedStopFor(tr, stops)) });
}
out.stock.push({ trips: [null], stops: [], ...run(() => { const ex = { open: 0, unknown: 0, no_cost: 0 }; return { trades: X.stockLedger([null], ex, []), excluded: ex }; }) });
{
  // 初始止损的边界:正好 15 分钟、做空在上方、没写账户的老痕、同一时刻两条
  const trip = { id: 'stk:b', status: 'closed', symbol: 'AAPL', side: 'LONG', avg_entry: 100, qty: 10, realized_pnl: 50, commission: 1,
    created_at: '20260915-14:00:00', closed_at: '20260915-18:00:00', account: { alias: '模拟', is_paper: true } };
  const t0 = Date.UTC(2026, 8, 15, 14, 0);
  for (const offMin of [0, 14.999, 15, 15.001, -1, 240, 240.001]) for (const side of ['LONG', 'SHORT']) {
    const tr = { ...trip, side };
    const stops = [{ at: iso(t0 + offMin * 60000), account: null, symbol: 'AAPL', sec_type: null, stop: side === 'SHORT' ? 105 : 95 }];
    out.stops.push({ trip: tr, stops, ...run(() => X.plannedStopFor(tr, stops)) });
    out.stock.push({ trips: [tr], stops, ...run(() => { const ex = { open: 0, unknown: 0, no_cost: 0 }; return { trades: X.stockLedger([tr], ex, stops), excluded: ex }; }) });
  }
  const twin = [{ at: iso(t0 + 60000), account: '模拟', symbol: 'AAPL', sec_type: 'STK', stop: 96 }, { at: iso(t0 + 60000), account: '模拟', symbol: 'AAPL', sec_type: 'STK', stop: 90 },
    { at: iso(t0 + 30000), account: '别人', symbol: 'AAPL', sec_type: 'STK', stop: 80 }];
  out.stops.push({ trip, stops: twin, ...run(() => X.plannedStopFor(trip, twin)) });
  const optFirst = [{ at: iso(t0 + 60000), account: null, symbol: 'AAPL', sec_type: 'OPT', stop: 90 }, { at: iso(t0 + 120000), account: null, symbol: 'AAPL', sec_type: 'STK', stop: 96 }];
  out.stops.push({ trip, stops: optFirst, ...run(() => X.plannedStopFor(trip, optFirst)) });
  const noAlias = { ...trip, account: null };
  const acctStop = [{ at: iso(t0 + 60000), account: '模拟', symbol: 'AAPL', sec_type: 'STK', stop: 97 }];
  out.stops.push({ trip: noAlias, stops: acctStop, ...run(() => X.plannedStopFor(noAlias, acctStop)) });
  const shortTrip = { ...trip, side: 'SHORT' };
  const atEntry = [{ at: iso(t0 + 60000), account: null, symbol: 'AAPL', sec_type: null, stop: 100 }, { at: iso(t0 + 120000), account: null, symbol: 'AAPL', sec_type: null, stop: 104 }];
  out.stops.push({ trip: shortTrip, stops: atEntry, ...run(() => X.plannedStopFor(shortTrip, atEntry)) });
  const sameInstant = { ...trip, id: 'stk:same', closed_at: trip.created_at };
  out.stock.push({ trips: [sameInstant], stops: [], ...run(() => { const ex = { open: 0, unknown: 0, no_cost: 0 }; return { trades: X.stockLedger([sameInstant], ex, []), excluded: ex }; }) });
  const secs = { ...trip, closed_at: '20260915-18:00:30' };
  out.stock.push({ trips: [secs], stops: [], ...run(() => { const ex = { open: 0, unknown: 0, no_cost: 0 }; return { trades: X.stockLedger([secs], ex, []), excluded: ex }; }) });
}

// ---------------------------------------------------------------- 导入的期权行 / Flex 仓位
const ocols = [...O.OPTION_COLUMNS];
const optRows = [];
for (let i = 0; i < 80; i += 1) {
  const day = `2026-10-${pad(int(1, 20))}`;
  const r = { time_et: `${day} ${pad(int(9, 15))}:${pad(int(0, 59))}:${pad(int(0, 59))}`, date_et: day, symbol: pick(['SPX', 'AAPL']), asset: '期权', structure: pick(['蝴蝶', '垂直价差', '多个仓位同时结算', '单腿']),
    action: pick(['开仓', '平仓', '到期结算', '拆腿平仓', '逐腿平仓']), direction: pick(['', '买方', '贷方']), qty: pick(['1', '2', '', '3']), net_price: pick(['1.5', '']),
    realized_pnl: pick(['120', '-80', '0', '4', '-4', '6', '15.5', '0.5', '-0.999']), commission: '1', legs: 'L', order_ids: String(i), note: '' };
  optRows.push(ocols.map((c) => r[c]).join(','));
}
const optImport = O.parseOptionTradesCsv([ocols.join(','), ...optRows].join('\n'), 'DUTEST001', 'trades.csv').rows;
const optImport2 = O.parseOptionTradesCsv([ocols.join(','), ...optRows.slice(0, 40)].join('\n'), 'UXTEST123', 'trades.csv').rows;
const optAll = [...optImport, ...optImport2];
out.option.push({ rows: optAll, ...run(() => X.optionLedger(optAll, isPaper)) });
out.option.push({ rows: [null], ...run(() => X.optionLedger([null], isPaper)) });
out.option.push({ rows: [{ ...optAll[0], time_et: 'bad', action: '平仓' }], ...run(() => X.optionLedger([{ ...optAll[0], time_et: 'bad', action: '平仓' }], isPaper)) });

const pcols = Object.entries(PC.POSITION_COLUMNS);
const posLines = [];
for (let i = 0; i < 80; i += 1) {
  const day = `2026-10-${pad(int(1, 20))}`;
  const exit = pick(['整体平仓', '持有到期', '拆腿后到期', '逐腿/拆腿平仓', '持仓中', '平仓', '']);
  const r = { open: `${day} ${pad(int(9, 15))}:${pad(int(0, 59))}:00`, symbol: pick(['SPX', 'XSP']), structure: pick(['蝴蝶', '垂直价差', '单腿', '破翼/比例蝴蝶', '日历/对角']),
    direction: pick(['', '买方', '贷方看空', '借方看涨']), qty: pick(['1', '2', '', '0']), expiry: pick(['20261016', '']), dte: pick(['0', '3', '', '10']), right: pick(['C', 'P', 'CP', '']),
    strikes: pick(['7410/7425/7440', '']), center: pick(['7425', '']), width: pick(['15', '', '0']), ratio: '1:2:1', netPrice: pick(['2.5', '-1.2', '', '0']), legs: `L${i}`, exit,
    status: exit === '持仓中' ? '持仓中' : pick(['已了结', '已了结', '持仓中']), closed: exit === '持仓中' ? '' : pick([`${day} 15:59:00`, `${day} 15:59:00`, '']),
    holdMin: pick(['5', '', '120.5']), pnl: pick(['250', '-75.5', '0', '1', '-1', '3', '0.995']), commission: '1' };
  posLines.push(pcols.map(([k]) => (/[,"]/.test(r[k]) ? `"${r[k]}"` : r[k])).join(','));
}
const posRows = PC.parseOptionPositionsCsv([pcols.map(([, c]) => `"${c}"`).join(','), ...posLines].join('\n'), 'DUTEST001', 'option_positions.csv').rows;
out.position.push({ rows: posRows, ...run(() => { const ex = { open: 0, unknown: 0, no_cost: 0 }; return { trades: X.positionLedger(posRows, isPaper, ex), excluded: ex }; }) });
{
  const base = posRows.find((r) => r.status !== '持仓中' && r.closed_et) ?? posRows[0];
  const odd = [{ ...base, id: 'p-exit-open', exit: '持仓中', status: '已了结', closed_et: '2026-10-03 10:00:00' },
    { ...base, id: 'p-credit', structure: '蝴蝶', direction: '贷方看空', qty: 2, net_price: 1.5, closed_et: '2026-10-03 10:00:00', status: '已了结', exit: '平仓' },
    { ...base, id: 'p-hold0', open_et: '2026-10-03 10:00:00', closed_et: '2026-10-03 10:30:00', hold_min: 0, status: '已了结', exit: '平仓' },
    { ...base, id: 'p-same-instant', open_et: '2026-10-03 10:00:00', closed_et: '2026-10-03 10:00:00', hold_min: null, status: '已了结', exit: '平仓' },
    { ...base, id: 'p-debit', structure: '蝴蝶', direction: '借方看涨', qty: 2, net_price: 1.5, closed_et: '2026-10-03 10:00:00', status: '已了结', exit: '平仓', hold_min: null }];
  out.position.push({ rows: odd, ...run(() => { const ex = { open: 0, unknown: 0, no_cost: 0 }; return { trades: X.positionLedger(odd, isPaper, ex), excluded: ex }; }) });
}
out.position.push({ rows: [null], ...run(() => { const ex = { open: 0, unknown: 0, no_cost: 0 }; return { trades: X.positionLedger([null], isPaper, ex), excluded: ex }; }) });

// ---------------------------------------------------------------- buildLedger
for (let i = 0; i < 4; i += 1) {
  const recs = recordSet();
  const trips = tripSet(100 + i);
  const stops = stopsFor(trips);
  const positions = posRows.slice(int(0, 30), int(30, 60));
  const options = optAll.slice(int(0, 30), int(30, 70));
  const now = Date.UTC(2026, 9, int(1, 31));
  out.build.push({ records: recs, trips, stops, positions, options, now,
    ...run(() => X.buildLedger({ butterflies: recs, trips, stops, positions, options, settleClose: settle, isPaper, now })) });
}

// ---------------------------------------------------------------- 造出来的账本
const D0 = Date.UTC(2026, 7, 3); // 2026-08-03(周一)
function tradingDays(n) {
  const out2 = [];
  for (let d = 0; out2.length < n; d += 1) {
    const ms = D0 + d * 86400000;
    const wd = new Date(ms).getUTCDay();
    if (wd !== 0 && wd !== 6) out2.push(ms);
  }
  return out2;
}
/** 场景:每一样都按概率开、强度随机,同一个账本里会叠几样 */
function synthLedger(n, k = {}) {
  const days = tradingDays(k.days ?? int(1, 40));
  const trades = [];
  let lastLossClose = null;
  let id = 0;
  // 先排出开仓时刻,再按时刻顺序决定盈亏(亏完马上再进、亏后加码要看前面的了结)
  const opens = [];
  for (let i = 0; i < n; i += 1) {
    const day = pick(days);
    const busy = k.busy && rnd() < 0.3 ? days[0] : day;
    const minute = k.offHours && rnd() < 0.1 ? pick([8 * 60, 17 * 60, 20 * 60 + 30]) : int(9 * 60 + 30, 15 * 60 + 59);
    opens.push(busy + (minute + 4 * 60) * 60000 + int(0, 59) * 1000);
  }
  opens.sort((a, b) => a - b);
  for (const open of opens) {
    const kind = pick(k.kinds ?? ['butterfly', 'stock', 'option']);
    const symbol = pick(k.symbols ?? ['SPX', 'AAPL', 'QQQ', 'NVDA']);
    const etMin = ((open - 4 * 3600000) % 86400000) / 60000;
    let drift = k.drift ?? 0;
    if (k.session && etMin < 10 * 60) drift += k.session;
    if (k.session && etMin >= 12 * 60 && etMin < 15 * 60) drift -= k.session;
    const revenge = lastLossClose !== null && open >= lastLossClose && open - lastLossClose <= 30 * 60000;
    if (k.revenge && revenge) drift -= k.revenge;
    const scale = kind === 'stock' ? 400 : 120;
    let pnl = Math.round((drift + (rnd() - 0.5) * 2) * scale * 100) / 100;
    if (k.flats && rnd() < 0.08) pnl = pick([0, 0.5, -0.99, 0.99, 1, -1]);
    if (k.tail && rnd() < 0.04) pnl = -Math.round(scale * (5 + rnd() * 10) * 100) / 100;
    const win = pnl > 0;
    let hold = int(1, 240);
    if (k.disposition) hold = win ? int(1, 40) : int(60, 400);
    if (k.cutLosers) hold = win ? int(60, 400) : int(1, 40);
    const close = open + hold * 60000 + (rnd() < 0.05 ? 0 : 0);
    let exposure = kind === 'stock' ? pick([2000, 5000, 10000, 4000]) : pick([200, 300, 450, 500]);
    if (k.sizeUp && lastLossClose !== null && open - lastLossClose < 3 * 3600000) exposure *= 3;
    if (rnd() < 0.05) exposure = null;
    const t = { id: `t${(id += 1)}`, kind, symbol, label: `${symbol} ${kind}`, opened_at: kind === 'option' && rnd() < (k.noOpen ?? 0.3) ? null : iso(open), closed_at: iso(close),
      pnl, net_of_commission: rnd() < 0.85, risk: null, r: null, risk_basis: null, r_missing: null, exposure, hold_minutes: null, paper: rnd() < (k.paper ?? 0.3) };
    if (t.opened_at === null) { t.r_missing = 'no_open'; t.exposure = null; } else t.hold_minutes = hold;
    if (t.opened_at !== null) {
      const withR = rnd() < (k.rShare ?? 0.7);
      if (withR && exposure !== null) {
        const risk = kind === 'stock' ? Math.round(exposure * pick([0.02, 0.05]) * 100) / 100 : exposure;
        t.risk = risk; t.r = Math.round((pnl / risk) * 100) / 100; t.risk_basis = kind === 'stock' ? 'stop' : 'max_loss';
      } else t.r_missing = pick(kind === 'stock' ? ['no_stop', 'late_stop', 'no_cost'] : ['undefined_risk', 'no_cost']);
    }
    trades.push(t);
    if (pnl <= -1) lastLossClose = close;
  }
  trades.sort((a, b) => (a.closed_at < b.closed_at ? -1 : a.closed_at > b.closed_at ? 1 : a.id < b.id ? -1 : 1));
  return trades;
}
const KNOBS = () => ({
  days: pick([1, 3, 8, 20, 40]),
  drift: pick([0, 0.2, -0.2, 0.6, -0.5, 0.05]),
  session: rnd() < 0.3 ? pick([0.8, 1.5]) : 0,
  revenge: rnd() < 0.3 ? pick([1, 2]) : 0,
  disposition: rnd() < 0.25, cutLosers: rnd() < 0.1, sizeUp: rnd() < 0.3, busy: rnd() < 0.3, tail: rnd() < 0.3, flats: rnd() < 0.5, offHours: rnd() < 0.3,
  rShare: pick([0, 0.5, 0.9, 1]), paper: pick([0, 0.3, 1]), noOpen: pick([0, 0.3]),
  kinds: pick([undefined, ['butterfly'], ['stock'], ['butterfly', 'stock']]),
  symbols: pick([undefined, ['SPX'], ['SPX', 'AAPL']]),
});
const ledgers = [];
for (let i = 0; i < 48; i += 1) {
  const n = pick([0, 1, 2, 5, 9, 12, 20, 25, 40, 60, 90]);
  ledgers.push({ knobs: KNOBS(), trades: null, n });
}
for (const L of ledgers) L.trades = synthLedger(L.n, L.knobs);
// 最近走弱 / 变好:前面一种,最后 10 笔另一种
{
  const a = synthLedger(50, { days: 30, drift: 0.6, kinds: ['butterfly'], rShare: 1 });
  const b = synthLedger(10, { days: 3, drift: -1.2, kinds: ['butterfly'], rShare: 1 }).map((t) => ({ ...t, id: `w${t.id}`, closed_at: t.closed_at.replace('2026-08', '2026-11'), opened_at: t.opened_at?.replace('2026-08', '2026-11') ?? null }));
  ledgers.push({ knobs: { recent: 'weak' }, trades: [...a, ...b] });
  const c = synthLedger(50, { days: 30, drift: 0.05, kinds: ['butterfly'] });
  const d = synthLedger(10, { days: 3, drift: 1.5, kinds: ['butterfly'] }).map((t) => ({ ...t, id: `g${t.id}`, closed_at: t.closed_at.replace('2026-08', '2026-11'), opened_at: t.opened_at?.replace('2026-08', '2026-11') ?? null }));
  ledgers.push({ knobs: { recent: 'good' }, trades: [...c, ...d] });
  ledgers.push({ knobs: { big: true }, trades: synthLedger(320, { days: 60, drift: 0.1 }) });
  // 不按了结排序的、同一刻了结好几笔的、开仓时刻读不出的
  const odd = synthLedger(30, { days: 5 });
  odd.reverse();
  for (const t of odd.slice(0, 6)) t.closed_at = odd[0].closed_at;
  ledgers.push({ knobs: { odd: true }, trades: odd });
}

// 规则一条一条对着造的账本(随机的很难同时凑够门槛):亏完马上再进(同一只标的)+ 亏后加码 + 亏损单拿得久;过度交易
function mk(id, kind, symbol, openMs, closeMs, pnl, exposure, r = null) {
  return { id, kind, symbol, label: `${symbol} ${kind}`, opened_at: iso(openMs), closed_at: iso(closeMs), pnl, net_of_commission: true,
    risk: r === null ? null : exposure, r, risk_basis: r === null ? null : 'max_loss', r_missing: r === null ? 'undefined_risk' : null, exposure,
    hold_minutes: Math.round((closeMs - openMs) / 6000) / 10, paper: false };
}
const ET0 = (dayMs, h, m) => dayMs + ((h + 4) * 60 + m) * 60000;
{
  const T = [];
  tradingDays(15).forEach((d, i) => {
    const j = (x) => Math.round(x * (1 + ((i * 7) % 5) / 20) * 100) / 100;
    T.push(mk(`a${i}`, 'butterfly', 'SPX', ET0(d, 10, 0), ET0(d, 12, 0), j(-100), 300, -0.33));
    T.push(mk(`b${i}`, 'butterfly', 'SPX', ET0(d, 12, 10), ET0(d, 14, 0), j(-160), 1000, -0.16));
    T.push(mk(`c${i}`, 'butterfly', 'SPX', ET0(d, 14, 45), ET0(d, 14, 55), j(220), 1000, 0.22));
    T.push(mk(`d${i}`, 'butterfly', 'QQQ', ET0(d, 15, 0), ET0(d, 15, 5), j(180), 300, 0.6));
    T.push(mk(`e${i}`, 'butterfly', 'QQQ', ET0(d, 15, 10), ET0(d, 15, 15), j(150), 300, 0.5));
    T.push(mk(`f${i}`, 'butterfly', 'SPX', ET0(d, 15, 20), ET0(d, 15, 25), j(120), 300, 0.4));
  });
  T.sort((a, b) => (a.closed_at < b.closed_at ? -1 : 1));
  ledgers.push({ knobs: { scenario: 'revenge' }, trades: T });
  const U = [];
  tradingDays(24).forEach((d, i) => {
    const busy = i % 6 === 5;
    const n = busy ? 8 : 2;
    for (let k = 0; k < n; k += 1) {
      const pnl = busy ? Math.round((-90 - 13 * ((i + k) % 7)) * 100) / 100 : Math.round((80 + 11 * ((i + k) % 5) - (k === 1 && i % 4 === 0 ? 150 : 0)) * 100) / 100;
      U.push(mk(`o${i}.${k}`, pick(['stock', 'butterfly']), pick(['AAPL', 'SPX']), ET0(d, 10 + k % 5, 5 * k), ET0(d, 10 + k % 5, 5 * k + 3), pnl, pick([300, 400, 2000])));
    }
  });
  U.sort((a, b) => (a.closed_at < b.closed_at ? -1 : a.closed_at > b.closed_at ? 1 : a.id < b.id ? -1 : 1));
  ledgers.push({ knobs: { scenario: 'overtrading' }, trades: U });
}


// 每条规则的门槛正好在线上 / 差一点:一个账本只为一处边界造(变异检验用它们咬住 ≥ 与 > 的差别)
const day = (i) => D0 + Math.floor(i / 5) * 7 * 86400000 + (i % 5) * 86400000; // 第 i 个交易日(周一到周五)
const at = (i, h, m) => ET0(day(i), h, m);
const B = (name, trades) => ledgers.push({ knobs: { boundary: name }, trades: trades.sort((a, b) => (a.closed_at < b.closed_at ? -1 : a.closed_at > b.closed_at ? 1 : a.id < b.id ? -1 : 1)) });
const T = (id, i, h, m, holdMin, pnl, ex = {}) => {
  const t = mk(id, ex.kind ?? 'butterfly', ex.symbol ?? 'SPX', at(i, h, m), at(i, h, m) + holdMin * 60000, pnl, ex.exposure ?? 300, ex.r ?? null);
  if (ex.noOpen) { t.opened_at = null; t.hold_minutes = null; t.r_missing = 'no_open'; t.exposure = null; }
  return t;
};
{
  B('expectancy 0 / kelly 0', [0, 1, 2, 3, 4, 5, 6, 7].map((i) => T(`k${i}`, i, 10, 0, 30, i % 2 ? -100 : 100)));
  B('revenge rest < 5', [...[0, 1, 2, 3, 4, 5].flatMap((i) => [T(`a${i}`, i, 10, 0, 30, -100, { kind: 'option', noOpen: true }), T(`b${i}`, i, 10, 40, 20, -300 + i * 7)]),
    T('r0', 0, 14, 0, 30, 200), T('r1', 1, 14, 0, 30, 250), T('r2', 2, 14, 0, 30, 180)]);
  B('revenge quick positive', [0, 1, 2, 3, 4, 5].flatMap((i) => [T(`a${i}`, i, 10, 0, 30, -100, { kind: 'option', noOpen: true }), T(`b${i}`, i, 10, 40, 20, 10 + i), T(`c${i}`, i, 14, 0, 30, 500 + i * 13)]));
  B('four decided', [T('d0', 0, 10, 0, 30, 100), T('d1', 1, 10, 0, 30, -50), T('d2', 2, 10, 0, 30, 80), T('d3', 3, 10, 0, 30, -30)]);
  B('payoff warn 4.7 above breakeven', [50, 50, 50, 50, 50, -100, -100].map((v, i) => T(`p${i}`, i, 10, 0, 30, v)));
  B('payoff gap 0', [50, 50, 50, 50, -100, -100].map((v, i) => T(`g${i}`, i, 10, 0, 30, v)));
  {
    const base = [1, -1, 2, -0.5, 1.5, -1, 0.5, 2, -1, 1];
    let pickC = null;
    for (let c = -1; c <= 1 && pickC === null; c = Math.round((c + 0.01) * 100) / 100) {
      const rs = base.map((x) => Math.round((x + c) * 100) / 100);
      if (rs.some((x) => Math.abs(x * 100) < 1)) continue;
      const r = X.rStats(rs.map((x, i) => T(`s${i}`, i, 10, 0, 30, Math.round(x * 100 * 100) / 100, { r: x })));
      if (r.sqn !== null && r.sqn >= 1.6 && r.sqn < 1.7) pickC = c;
    }
    if (pickC === null) throw new Error('凑不出 SQN 1.6–1.7');
    B('sqn 1.6 band', base.map((x, i) => { const r = Math.round((x + pickC) * 100) / 100; return T(`s${i}`, i, 10, 0, 30, Math.round(r * 100 * 100) / 100, { r }); }));
  }
  B('recent: last 10 vs last 9', [...Array.from({ length: 30 }, (_, i) => T(`e${i}`, i, 10, 0, 30, 100 + (i % 7) * 10)), T('w0', 30, 10, 0, 30, 900),
    ...Array.from({ length: 9 }, (_, i) => T(`w${i + 1}`, 31 + i, 10, 0, 30, -150 - (i % 5) * 10))]);
  B('recent: everything negative', [...Array.from({ length: 20 }, (_, i) => T(`e${i}`, i, 10, 0, 30, -10 - (i % 3) * 5)), ...Array.from({ length: 10 }, (_, i) => T(`w${i}`, 20 + i, 10, 0, 30, -300 - (i % 4) * 20))]);
  B('tail: five losses', [-100, -100, -100, -100, -1000, 200, 200, 200, 200, 200].map((v, i) => T(`t${i}`, i, 10, 0, 30, v)));
  B('tail: top3 share exactly half', [-100, -100, -100, -50, -50, -50, -50, -50, -25, -25, 300, 300, 300].map((v, i) => T(`t${i}`, i, 10, 0, 30, v)));
  B('tail: worst = 3 × avg', [-300, -50, -50, -50, -50, 400, 400, 400].map((v, i) => T(`t${i}`, i, 10, 0, 30, v)));
  B('drawdown: 10 trades, recovery 2', [100, -100, 25, 25, 25, 25, 25, 25, 25, 25].map((v, i) => T(`r${i}`, i, 10, 0, 30, v)));
  B('worst day = 3 × avg losing day', [-300, -50, -50, -50, -50, 500, 500].map((v, i) => T(`w${i}`, i, 10, 0, 30, v)));
  B('busy cut 3 vs 4', [...Array.from({ length: 10 }, (_, i) => T(`o${i}`, i, 10, 0, 30, 100 + i)), ...[10, 11, 12].flatMap((d) => [0, 1, 2].map((k) => T(`b${d}.${k}`, d, 10 + k, 0, 30, -120 - k * 9 - d)))]);
  B('busy exactly at cut, 3 days', [...Array.from({ length: 10 }, (_, i) => [0, 1].map((k) => T(`o${i}.${k}`, i, 10 + k, 0, 30, 100 + i + k))).flat(),
    ...[10, 11, 12].flatMap((d) => [0, 1, 2, 3].map((k) => T(`b${d}.${k}`, d, 10 + k, 0, 30, -120 - k * 9 - d)))]);
  B('busy days positive', [...Array.from({ length: 10 }, (_, i) => [0, 1].map((k) => T(`o${i}.${k}`, i, 10 + k, 0, 30, 500 + i * 3 + k))).flat(),
    ...[10, 11, 12].flatMap((d) => [0, 1, 2, 3].map((k) => T(`b${d}.${k}`, d, 10 + k, 0, 30, 10 + k + d)))]);
  const sess = (prefix, h, m, vals, d0) => vals.map((v, i) => T(`${prefix}${i}`, d0 + i, h, m, 10, v));
  B('session: off-hours is the worst', [...sess('o', 9, 35, [200, 210, 190, 220, 205, 195, 215, 185], 0), ...sess('a', 13, 0, [20, 25, 15, 30, 22, 18, 27, 13], 0), ...sess('x', 17, 30, [-300, -310, -290, -320, -305, -295, -315, -285], 0)]);
  B('session: tie for best', [...sess('o', 9, 35, [100, 100, 100, 100, 100, 100, 100, 100], 0), ...sess('m', 10, 30, [50, 150, 50, 150, 50, 150, 50, 150], 0), ...sess('a', 13, 0, [-200, -210, -190, -220, -205, -195, -215, -185], 0)]);
  {
    // Bonferroni:三个时段,最好 vs 最差的差别在 95% 下出了噪声、在 1 − 0.05/3 下没出
    const lvlB = 1 - (1 - INF.CONFIDENCE) / 3;
    const noise = [37, -52, 18, 64, -29, 45, -61, 8];
    let found = null;
    for (let d = 5; d <= 300 && found === null; d += 1) {
      const a = noise.map((n) => -d + n), b = noise.map((n, i) => d + noise[(i + 3) % 8]);
      const A = a.map((v, i) => ({ value: v, cluster: `d${i}` })), Bc = b.map((v, i) => ({ value: v, cluster: `d${i}` }));
      const c95 = INF.clusteredDiffInterval(A, Bc, INF.CONFIDENCE), cB = INF.clusteredDiffInterval(A, Bc, lvlB);
      if (c95 && cB && c95.hi < 0 && cB.hi >= 0) found = { a, b };
    }
    if (found === null) throw new Error('凑不出 Bonferroni 的边界');
    B('session: Bonferroni band', [...sess('o', 9, 35, found.b, 0), ...sess('m', 10, 30, found.b.map((v) => v - 1), 0), ...sess('a', 13, 0, found.a, 0)]);
  }
  B('session: best is negative too', [...sess('o', 9, 35, [-10, -12, -8, -11, -9, -13, -7, -10], 0), ...sess('a', 13, 0, [-400, -410, -390, -420, -405, -395, -415, -385], 0)]);
  B('disposition: exactly 5 losses', [...[0, 1, 2, 3, 4].map((i) => T(`l${i}`, i, 10, 0, 200, -100 - i)), ...[5, 6, 7, 8, 9, 10].map((i) => T(`w${i}`, i, 10, 0, 10, 100 + i))]);
  B('disposition: two days only', [0, 1].flatMap((d) => [0, 1, 2].flatMap((k) => [T(`l${d}.${k}`, d, 10 + k, 0, 200, -100 - k), T(`w${d}.${k}`, d, 14 + k, 0, 10, 100 + k)])));
  {
    const seq = [];
    let tm = 0;
    for (let k = 0; k < 10; k += 1) {
      const loss = k % 2 === 0;
      seq.push(T(`z${k}`, k, 10, 0, 30, loss ? -100 - k : 100 + k, { exposure: loss ? 300 : 1000 }));
      tm += 1;
    }
    B('size after loss: 4 after wins', seq);
  }
  B('twenty trades', Array.from({ length: 20 }, (_, i) => T(`q${i}`, i, 10, 0, 30, (i % 3 ? 110 : -80) + i)));
  {
    const rs = [-0.5, -0.6, -0.4, -0.55, -0.45, -0.5, 0.2, 0.1, -0.6, -0.4];
    const L = rs.map((r, i) => T(`kr${i}`, i, 10, 0, 30, Math.round(r * 300 * 100) / 100, { r }));
    const rr = X.rStats(L);
    if (!(rr.kelly !== null && rr.expectancy_ci && rr.expectancy_ci.hi < 0 && rr.expectancy_ci.hi > -1)) throw new Error('凯利的边界没凑出来');
    B('kelly warn, CI upper bound in (-1, 0)', L);
  }
  // 开平同一刻的持有时长是 0(不是 null):赚的 6 笔 0 分钟、亏的 6 笔 100 分钟 → 「亏损单拿得比赚钱单久」
  B('hold minutes 0 counts', [...[0, 1, 2, 3, 4, 5].map((i) => T(`w${i}`, i, 10, 0, 0, 100 + i)), ...[6, 7, 8, 9, 10, 11].map((i) => T(`l${i}`, i, 10, 0, 100, -100 - i))]);
  // 赚 / 亏各正好 5 笔
  B('disposition: exactly 5 and 5', [...[0, 1, 2, 3, 4].map((i) => T(`w${i}`, i, 10, 0, 10, 100 + i)), ...[5, 6, 7, 8, 9].map((i) => T(`l${i}`, i, 10, 0, 200, -100 - i))]);
  // 正好 5 个有平仓的交易日,最差一天亏得是亏钱日平均的 3 倍以上
  B('worst day with exactly five days', [-400, -30, -30, -30, 500].map((v, i) => T(`d${i}`, i, 10, 0, 30, v)));
  // 开仓占用的中位数正好是 0:亏后的下一笔(占用 500)不算放大
  B('size after loss: median exposure 0', [[0, -100], [500, 50], [0, -100], [500, 50], [0, -100], [0, 50], [0, -100], [500, 50]]
    .map(([e, v], i) => T(`m${i}`, i, 10, 0, 30, v, { kind: 'stock', exposure: e })));
  // 全部样本的每笔期望值正好是 0、最近 10 笔为负:不算「最近在走弱」(那一条要全部为正)
  {
    const off = [-4, -2, 0, 2, 4];
    const earlier = Array.from({ length: 20 }, (_, i) => T(`e${i}`, i, 10, 0, 30, 50 + off[i % 5]));
    const latest = Array.from({ length: 10 }, (_, i) => T(`z${i}`, 20 + i, 10, 0, 30, -100 + off[i % 5]));
    const rr = X.perfStats([...earlier, ...latest]);
    if (rr.expectancy !== 0) throw new Error(`期望值应正好是 0,得到 ${rr.expectancy}`);
    B('recent negative, overall expectancy exactly 0', [...earlier, ...latest]);
  }
  // 1970 年以前的日子:自纪元起的天数是负的,星期要往回绕(Date.getUTCDay 的结果,不是 C 的负余数)
  B('pre-1970 weekdays', [20, 21, 22, 23, 24, 25, 26, 27].map((d, i) => {
    const open = Date.UTC(1969, 11, d, 15, 0), close = open + 45 * 60000;
    return mk(`old${i}`, 'butterfly', 'SPX', open, close, i % 2 ? -60 - i : 80 + i, 300);
  }));
  B('thirty trades', Array.from({ length: 30 }, (_, i) => T(`n${i}`, Math.floor(i / 2), 10 + (i % 2) * 3, 0, 30, (i % 3 ? 120 : -90) + i)));
  {
    const d = (i, extra) => extra;
    const L = [T('a0', 0, 10, 0, 30, -500), mk('a1', 'butterfly', 'SPX', at(0, 10, 30), at(0, 11, 0), 50, 300), T('b0', 1, 10, 0, 30, -500), mk('b1', 'butterfly', 'SPX', at(1, 10, 30), at(1, 11, 0), -50, 300),
      ...[2, 3, 4, 5].map((i) => T(`c${i}`, i, 10, 0, 30, -10)), T('w6', 6, 10, 0, 30, 400)];
    B('daily loss: skipped sum 0, open at the losing close', L);
  }
  B('daily loss: four losing days', [T('a', 0, 10, 0, 30, -450), T('b', 1, 10, 0, 30, -550), T('c', 2, 10, 0, 30, -10), T('d', 3, 10, 0, 30, -10), T('e', 4, 10, 0, 30, 300)]);
  B('daily loss: day exactly at the line', [T('a', 0, 10, 0, 30, -40), ...[1, 2, 3, 4].map((i) => T(`b${i}`, i, 10, 0, 30, -15)), T('c', 5, 10, 0, 30, 300)]);
  B('streak exactly 4', [100, -100, -110, -120, -130, 100, 100, 100].map((v, i) => T(`s${i}`, i, 10, 0, 30, v)));
  B('thirteen symbols', 'ABCDEFGHIJKLM'.split('').map((c, i) => T(`y${i}`, i, 10, 0, 30, (i % 3 ? 50 : -40) + i, { symbol: `SYM${c}` })));
  B('revenge: exactly 30 minutes', [T('a', 0, 10, 0, 30, -100), T('b', 0, 11, 0, 30, -100), T('c', 0, 11, 30, 30, -100), T('d', 1, 10, 0, 30, 100)]);
  {
    const self = mk('self', 'stock', 'AAPL', at(0, 10, 0), at(0, 10, 0), -100, 2000);
    B('closed at the open', [self, T('x', 0, 9, 50, 5, -100, { symbol: 'MSFT', kind: 'stock', exposure: 2000 }), T('y', 0, 11, 0, 30, 100, { symbol: 'AAPL', kind: 'stock', exposure: 9000 })]);
  }
  B('loss bursts exactly 30 minutes apart', [T('a', 0, 10, 0, 30, -100), T('b', 0, 10, 30, 30, -100), T('c', 0, 11, 30, 30, -100), T('d', 1, 10, 0, 30, -100)]);
}

const sum = (L) => L.map((t) => t.id);
for (const L of ledgers) {
  const t = L.trades;
  const pd = X.perDay(t);
  const s = X.perfStats(t);
  out.stats.push({ knobs: L.knobs, trades: t,
    perfStats: enc(s), rStats: enc(X.rStats(t)), rCoverage: enc(X.rCoverage(t)), equityCurve: enc(X.equityCurve(t)),
    perDay: enc({ days: pd.days, green_days: pd.green_days, best_day: pd.best_day, worst_day: pd.worst_day, avg_losing_day: pd.avg_losing_day,
      counts: [...pd.counts.entries()], pnl: [...pd.pnl.entries()] }),
    kellyOf: enc(X.kellyOf(s)),
    sessions: t.map((x) => enc(X.sessionOf(x.opened_at))),
    revenge: (() => { const r = X.revengeSplit(t); return { quick: sum(r.quick), rest: sum(r.rest) }; })(),
    same: (() => { const r = X.sameSymbolReentry(t); return { quick: sum(r.quick), rest: sum(r.rest) }; })(),
    sizeAfterLoss: X.sizeAfterLoss(t),
    replay: [50, 100, 250, 1000].map((line) => enc(X.dailyLossReplay(t, line))),
    bursts: [[120, 3, 60], [30, 2, 10], [600, 5, 120], [1, 1, 0]].map(([a, b, c]) => X.lossBursts(t, a, b, c)),
  });
}

// ---------------------------------------------------------------- 整份体检
const PROT = [null,
  { stoploss_guard: { enabled: false, lookback_minutes: 120, trigger_count: 3, pause_minutes: 60 }, max_drawdown: { enabled: false, lookback_minutes: 1440, max_drawdown_usd: 1000, pause_minutes: 1440 },
    cooldown: { enabled: false, minutes: 30, scope: 'symbol' }, daily_loss: { enabled: false, max_loss_usd: 500, basis: 'realized' } },
  { stoploss_guard: { enabled: true, lookback_minutes: 120, trigger_count: 3, pause_minutes: 60 }, max_drawdown: { enabled: false, lookback_minutes: 1440, max_drawdown_usd: 1000, pause_minutes: 1440 },
    cooldown: { enabled: true, minutes: 15, scope: 'symbol' }, daily_loss: { enabled: true, max_loss_usd: 100000, basis: 'realized' } },
  { stoploss_guard: { enabled: false, lookback_minutes: 120, trigger_count: 3, pause_minutes: 60 }, max_drawdown: { enabled: false, lookback_minutes: 1440, max_drawdown_usd: 1000, pause_minutes: 1440 },
    cooldown: { enabled: true, minutes: 30, scope: 'symbol' }, daily_loss: { enabled: true, max_loss_usd: 10, basis: 'realized' } },
];
const traces = [
  { at: '2026-08-10T15:00:00Z', path: 'auto_close', symbol: 'SPX', state: 'take_profit', mark: 2.5, record: { contract: { secType: 'BAG', multiplier: '100' }, order: { action: 'SELL', totalQuantity: 1 }, account: { is_paper: false }, ibkr: { avg_fill_price: 2.35, total_commission: 1.3, fills: [{ qty: 1, sec_type: 'BAG' }] } } },
  { at: '2026-08-12T15:00:00Z', path: 'hosted_sweep', symbol: 'AAPL', state: 'stop_loss', mark: 100, record: { contract: { secType: 'STK' }, order: { action: 'SELL', totalQuantity: 10 }, account: { is_paper: true }, ibkr: { avg_fill_price: 99.8, fills: [{ qty: 10, sec_type: 'STK' }] } } },
  { at: '2026-08-13T15:00:00Z', path: 'auto_close', symbol: 'SPX', state: 'time_exit', mark: null, record: null },
];
const NOW = Date.UTC(2026, 8, 30);
let full = 0;
for (const [i, L] of ledgers.entries()) {
  const reps = L.knobs.boundary ? 1 : L.knobs.scenario ? PROT.length : i < 6 ? 3 : 1;
  for (let j = 0; j < reps; j += 1) {
    const opts = { scope: pick(['all', 'all', 'live', 'paper']), kind: pick(['all', 'all', 'all', 'butterfly', 'stock', 'option']), days: pick([null, null, null, 7, 30, 0]), now: NOW };
    if (L.knobs.big || L.knobs.recent || L.knobs.scenario || L.knobs.boundary || i < 3) { opts.scope = 'all'; opts.kind = 'all'; opts.days = null; }
    const protections = L.knobs.boundary ? null : L.knobs.scenario ? PROT[j] : pick(PROT);
    const tr = rnd() < 0.3 ? traces : undefined;
    const excluded = { open: int(0, 5), unknown: int(0, 3), no_cost: int(0, 2) };
    const extras = L.knobs.boundary ? undefined : tr === undefined && protections === null && rnd() < 0.5 ? undefined : { traces: tr, protections };
    const r = run(() => X.performanceReport({ trades: L.trades, excluded }, opts, extras));
    if (r.out && full >= 2) r.out.trades = r.out.trades.map((t) => t.id);
    out.reports.push({ ledger: i, excluded, opts, extras: enc(extras), full: full < 2, ...r });
    if (r.out) full += 1;
  }
}

// ---------------------------------------------------------------- 杂项
out.misc.sqnLabel = [null, -1, 0, 1.59, 1.6, 1.99, 2.0, 2.49, 2.5, 2.99, 3.0, 5.09, 5.1, 6.99, 7.0, 100].map((v) => [v, X.sqnLabel(v)]);
out.misc.sessionOf = [null, 'bad', '2026-08-03T13:29:00+00:00', '2026-08-03T13:30:00+00:00', '2026-08-03T13:59:59+00:00', '2026-08-03T14:00:00+00:00', '2026-08-03T15:59:00+00:00',
  '2026-08-03T16:00:00+00:00', '2026-08-03T18:59:00+00:00', '2026-08-03T19:00:00+00:00', '2026-08-03T19:59:59+00:00', '2026-08-03T20:00:00+00:00', '2026-12-03T14:30:00+00:00']
  .map((s) => [s, X.sessionOf(s)]);
out.misc.filter = [];
{
  const li = ledgers.findIndex((L) => L.knobs.boundary === 'streak exactly 4');
  const t = ledgers[li].trades[3];
  for (const now of [Date.parse(t.closed_at) + 86400000, Date.parse(t.closed_at) + 86400000 + 1]) {
    const opts = { scope: 'all', kind: 'all', days: 1, now };
    out.misc.filter.push({ ledger: li, opts, ids: X.filterLedger(ledgers[li].trades, opts).map((x) => x.id) });
  }
}
for (const L of ledgers.slice(0, 12)) {
  for (const scope of ['all', 'live', 'paper', 'x']) for (const kind of ['all', 'stock', 'butterfly', 'option']) for (const days of [null, 0, 3, 30]) {
    if (rnd() < 0.7) continue;
    const opts = { scope, kind, days, now: Date.UTC(2026, 8, 5) };
    out.misc.filter.push({ ledger: ledgers.indexOf(L), opts, ids: X.filterLedger(L.trades, opts).map((t) => t.id) });
  }
}
out.misc.constants = { FLAT_USD: X.FLAT_USD, MIN_GROUP: X.MIN_GROUP, MIN_SAMPLE: X.MIN_SAMPLE, RECENT_WINDOW: X.RECENT_WINDOW, REVENGE_MINUTES: X.REVENGE_MINUTES,
  MAX_LEDGER_ROWS: X.MAX_LEDGER_ROWS, INITIAL_STOP_MINUTES: X.INITIAL_STOP_MINUTES };
out.ledgers = ledgers.map((L) => L.trades);
// 统计那一节的账本就是 ledgers 里的那一份:不重复存
for (const s of out.stats) delete s.trades;

// 覆盖面:每条规则 / 每条建议至少出现过一次
const ids = new Map();
for (const r of out.reports) for (const f of r.out?.findings ?? []) ids.set(`${f.id}:${f.tone}`, (ids.get(`${f.id}:${f.tone}`) ?? 0) + 1);
for (const r of out.reports) for (const a of r.out?.protection_advice ?? []) ids.set(`advice:${a.rule}`, (ids.get(`advice:${a.rule}`) ?? 0) + 1);
out.runtime = process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`;
const text = JSON.stringify(out) + '\n';
writeFileSync(join(here, 'performance_engine.json'), text);
console.log('performance_engine.json', text.length, 'bytes', Object.entries(out).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k}=${v.length}`).join(' '));
console.log([...ids.entries()].sort().map(([k, v]) => `${k}=${v}`).join(' '));
