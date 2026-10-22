// 生成 trade_outcomes.json:engine-ts 的 tradeOutcomes.ts(原模块现跑)把交易分析页的同一批记录折成知识总结的事实:
// 合成的蝴蝶(ibtrades.groupButterflies 出来的 + 手搭的:平仓配对、到期结算查得到 / 查不到收盘价、没成交价、id 撞车与
// Object.prototype 上的名字)、股票持仓段(stockreview.groupStockTrips 出来的)、导入的期权行与 Flex 仓位(两个 CSV 解析器出来的),
// 以及 collectFacts 的筛选排序、settlementsNeeded、factLine / tallyLine。settleClose 与 isPaper 用查表,表在夹具里。账号是假的。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_trade_outcomes.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const X = await import(pathToFileURL(join(engine, 'dist/src/tradeOutcomes.js')).href);
const I = await import(pathToFileURL(join(engine, 'dist/src/ibtrades.js')).href);
const S = await import(pathToFileURL(join(engine, 'dist/src/stockreview.js')).href);
const O = await import(pathToFileURL(join(engine, 'dist/src/optionTradesCsv.js')).href);
const P = await import(pathToFileURL(join(engine, 'dist/src/optionPositionsCsv.js')).href);

let seed = 0x0ac7_5f17;
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

// 查表:symbol|date → 收盘价(没有的就是 null)
const closes = {};
for (const sym of ['SPX', 'XSP', 'NDX']) for (let d = 1; d <= 31; d += 1) if (rnd() < 0.7) closes[`${sym}|2026-10-${pad(d)}`] = Math.round((sym === 'XSP' ? 580 : 5800) + (rnd() - 0.5) * 60);
const settle = (symbol, date) => closes[`${symbol}|${date}`] ?? null;
const isPaper = (id) => id.startsWith('DU');
const TR = await import(pathToFileURL(join(engine, 'dist/src/tradereview.js')).href);
const T_expiry = (r) => TR.expiryClose(TR.butterflyProfile(r));
const out = { runtime: '', closes, butterflies: [], stocks: [], days: [], etIso: [], options: [], positions: [], collect: [], settlements: [], lines: [] };

// ---------------------------------------------------------------- 蝴蝶记录
function flyFills(o) {
  const k = o.center ?? 5800, w = o.wing ?? 10, day = o.day ?? '20261016';
  const wing = o.action === 'SELL' ? 'SLD' : 'BOT', body = wing === 'BOT' ? 'SLD' : 'BOT';
  return [k - w, k, k + w].map((strike, i) => ({ account_id: o.account ?? 'DUTEST001', perm_id: o.perm, order_id: 1, exec_id: `x${o.perm}.${i}`,
    time: `${day}-${pad(o.hh ?? 14)}:${pad(o.mm ?? int(0, 59))}:00`, side: i === 1 ? body : wing, shares: (i === 1 ? 2 : 1) * (o.qty ?? 1), price: o.prices?.[i] ?? [3, 2, 1.5][i],
    contract: { secType: 'OPT', symbol: o.symbol ?? 'SPX', strike, right: o.right ?? 'P', expiry: day, tradingClass: 'SPXW', multiplier: '100', conId: 7 } }));
}
const DAYS = ['20261002', '20261009', '20261015', '20261016', '20261023', '20261030'];
function recordSet() {
  const fills = [];
  let perm = int(100, 900);
  for (let i = 0; i < int(1, 6); i += 1) {
    const o = { perm: (perm += 1), day: pick(DAYS), center: pick([5800, 5810, 580]), wing: pick([10, 5]), symbol: pick(['SPX', 'SPX', 'XSP', 'NDX']), right: pick(['P', 'C']),
      account: pick(['DUTEST001', 'UXTEST123']), hh: int(13, 19) };
    fills.push(...flyFills(o));
    if (rnd() < 0.5) fills.push(...flyFills({ ...o, perm: (perm += 1), action: 'SELL', hh: o.hh + 1, prices: [pick([1, 4, 6]), 2, 1] }));
  }
  let recs = I.groupButterflies(fills, [{ account_id: 'DUTEST001', alias: '模拟', is_paper: true }]);
  recs = recs.map((r) => {
    const x = rt(r);
    const t = pick([null, null, 'noFill', 'noCreated', 'idProto', 'idNum', 'idNull', 'noId', 'zeroDebit', 'limitOnly', 'notFly', null, null, null, null, null, null]);
    if (rnd() < 0.015) x.contract.legs.forEach((l) => { l.lastTradeDateOrContractMonth = 'abc'; });
    if (t === 'noFill') { x.ibkr.avg_fill_price = null; }
    if (t === 'noCreated') { delete x.created_at; }
    if (t === 'idProto') x.id = pick(['toString', 'constructor', '__proto__', 'valueOf']);
    if (t === 'idNum') x.id = int(1, 9);
    if (t === 'idNull') x.id = null;
    if (t === 'noId') delete x.id;
    if (t === 'zeroDebit') x.ibkr.avg_fill_price = 0;
    if (t === 'limitOnly') { x.ibkr.avg_fill_price = null; x.order.lmtPrice = 2.2; }
    if (t === 'notFly') x.contract.secType = 'OPT';
    if (t === 'badExpiry') x.contract.legs.forEach((l) => { l.lastTradeDateOrContractMonth = 'abc'; });
    if (rnd() < 0.2) x.account = null;
    return x;
  });
  return recs;
}
for (let i = 0; i < 60; i += 1) {
  const recs = rt(recordSet());
  const now = Date.UTC(2026, 9, int(1, 31), int(0, 23));
  out.butterflies.push({ records: recs, now, ...run(() => X.butterflyFacts(recs, settle, now)) });
  out.settlements.push({ records: recs, now, ...run(() => X.settlementsNeeded(recs, now)) });
}
out.butterflies.push({ records: [null], now: 0, ...run(() => X.butterflyFacts([null], settle, 0)) });

// ---------------------------------------------------------------- 股票
for (let i = 0; i < 25; i += 1) {
  const fills = [];
  let t = Date.UTC(2026, 8, 14, 14, 0);
  for (let j = 0; j < int(1, 8); j += 1) {
    t += pick([60e3, 3600e3, 86400e3]);
    const d = new Date(t);
    fills.push({ exec_id: `s${i}.${j}`, time: `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`,
      account_id: pick(['DUTEST001', 'UXTEST123']), side: pick(['BOT', 'SLD']), shares: pick([10, 20]), price: 100 + int(-5, 5), perm_id: 1000 + i * 10 + j, contract: { secType: 'STK', symbol: pick(['AAPL', 'MSFT']) } });
  }
  const trips = rt(S.groupStockTrips(fills, [{ account_id: 'DUTEST001', alias: '模拟', is_paper: true }], pick([null, {}])));
  if (rnd() < 0.3 && trips.length) { trips[0].avg_entry = pick([0, null, '5', 'x']); trips[0].realized_qty = pick([0, null, 3]); trips[0].closed_at = pick([null, 'bad']); }
  out.stocks.push({ trips, ...run(() => X.stockFacts(trips)) });
}
out.stocks.push({ trips: [null], ...run(() => X.stockFacts([null])) });
out.stocks.push({ trips: [{}, { status: 'closed', avg_entry: 10, realized_pnl: 5, realized_qty: 2, symbol: 5, side: 'SHORT', created_at: '2026-10-01 10:00', closed_at: '2026-10-02 10:00', account: { is_paper: 1 } }],
  ...run(() => X.stockFacts([{}, { status: 'closed', avg_entry: 10, realized_pnl: 5, realized_qty: 2, symbol: 5, side: 'SHORT', created_at: '2026-10-01 10:00', closed_at: '2026-10-02 10:00', account: { is_paper: 1 } }])) });

// ---------------------------------------------------------------- 覆盖的日子、etIso
const dayFills = [{ account_id: 'DUTEST001', time: '20261016-14:00:00', contract: { secType: 'OPT' } }, { account_id: 'DUTEST001', time: '20261016-15:00:00', contract: { secType: 'BAG' } },
  { account_id: 'UXTEST123', time: '20261017-03:00:00', contract: { secType: 'FOP' } }, { time: '2026-10-15 10:00', contract: { secType: 'OPT' } }, { account_id: 'X', time: 'bad', contract: { secType: 'OPT' } },
  { account_id: 'X', time: '20261016-14:00:00', contract: { secType: 'STK' } }, { account_id: 'X', time: '20261016-14:00:00', contract: null }, { account_id: 'X', time: '20261016-14:00:00' }];
out.days.push({ fills: dayFills, ...run(() => [...X.optionDaysCovered(dayFills)]) });
out.days.push({ fills: [null], ...run(() => [...X.optionDaysCovered([null])]) });
for (const s of ['2026-07-20 10:23:05', '2026-07-20', '2026-07-20 10', '2026-07-20 10:23', '', 'x', '2026-13-01 00:00:00', '2026-03-08 02:30:00', '2026-11-01 01:30:00', '2026-07-20  10:23:05', '0099-01-01 00:00:00', '2026-07-20 10:23:05 extra', '2026-07-20 :: '])
  out.etIso.push({ s, ...run(() => X.etIso(s)) });

// ---------------------------------------------------------------- 导入的期权行 / Flex 仓位
const ocols = [...O.OPTION_COLUMNS];
const optRows = [];
for (let i = 0; i < 120; i += 1) {
  const day = `2026-10-${pad(int(1, 20))}`;
  const r = { time_et: `${day} ${pad(int(9, 15))}:${pad(int(0, 59))}:${pad(int(0, 59))}`, date_et: day, symbol: pick(['SPX', 'AAPL']), asset: '期权', structure: pick(['蝴蝶', '垂直价差', '多个仓位同时结算', '单腿']),
    action: pick(['开仓', '平仓', '到期结算', '拆腿平仓', '逐腿平仓']), direction: pick(['', '买方', '贷方']), qty: pick(['1', '2', '', '3']), net_price: pick(['1.5', '']),
    realized_pnl: pick(['120', '-80', '0', '4', '-4', '6', '15.5']), commission: '1', legs: 'L', order_ids: String(i), note: '' };
  optRows.push(ocols.map((c) => r[c]).join(','));
}
const optImport = O.parseOptionTradesCsv([ocols.join(','), ...optRows].join('\n'), 'DUTEST001', 'trades.csv');
const optImport2 = O.parseOptionTradesCsv([ocols.join(','), ...optRows.slice(0, 30)].join('\n'), 'UXTEST123', 'trades.csv');
const rowsAll = [...optImport.rows, ...optImport2.rows];
const covered = [...X.optionDaysCovered(dayFills), 'DUTEST001|2026-10-05', 'UXTEST123|2026-10-07'];
out.options.push({ rows: rowsAll, covered: [], ...run(() => X.optionFacts(rowsAll, isPaper)) });
out.options.push({ rows: rowsAll, covered, ...run(() => X.optionFacts(rowsAll, isPaper, new Set(covered))) });
out.options.push({ rows: [{ ...rowsAll[0], time_et: 'bad', action: '平仓' }], covered: [], ...run(() => X.optionFacts([{ ...rowsAll[0], time_et: 'bad', action: '平仓' }], isPaper)) });

const pcols = Object.entries(P.POSITION_COLUMNS);
const posLines = [];
for (let i = 0; i < 120; i += 1) {
  const day = `2026-10-${pad(int(1, 20))}`;
  const exit = pick(['整体平仓', '持有到期', '拆腿后到期', '逐腿/拆腿平仓', '持仓中', '平仓', '']);
  const r = { open: `${day} ${pad(int(9, 15))}:${pad(int(0, 59))}:00`, symbol: pick(['SPX', 'XSP']), structure: pick(['蝴蝶', '垂直价差', '单腿', '破翼/比例蝴蝶']), direction: pick(['', '买方', '贷方看空']),
    qty: pick(['1', '2', '', '0']), expiry: pick(['20261016', '']), dte: pick(['0', '3', '', '10']), right: pick(['C', 'P', 'CP', '']), strikes: pick(['7410/7425/7440', '']),
    center: pick(['7425', '']), width: pick(['15', '', '0']), ratio: '1:2:1', netPrice: pick(['2.5', '-1.2', '', '0']), legs: `L${i}`, exit, status: exit === '持仓中' ? '持仓中' : pick(['已了结', '持仓中']),
    closed: exit === '持仓中' ? '' : pick([`${day} 15:59:00`, '']), holdMin: '5', pnl: pick(['250', '-75.5', '0', '1', '-1', '3']), commission: '1' };
  posLines.push(pcols.map(([k]) => (/[,"]/.test(r[k]) ? `"${r[k]}"` : r[k])).join(','));
}
const posRows = P.parseOptionPositionsCsv([pcols.map(([, c]) => `"${c}"`).join(','), ...posLines].join('\n'), 'DUTEST001', 'option_positions.csv').rows;
out.positions.push({ rows: posRows, ...run(() => X.positionFacts(posRows, isPaper)), days: [...X.positionDays(posRows)] });

// ---------------------------------------------------------------- collectFacts / factLine / tallyLine
for (let i = 0; i < 20; i += 1) {
  const recs = rt(recordSet());
  const trips = out.stocks[i].trips;
  const now = Date.UTC(2026, 9, int(1, 31));
  const extra = [...X.optionFacts(rowsAll.slice(0, int(0, 60)), isPaper), ...X.positionFacts(posRows.slice(0, int(0, 60)), isPaper)];
  if (i === 0) extra.push(...rt(extra.slice(0, 5)), { ...extra[0], id: 'dup' }, { ...extra[0], id: 'dup' });
  const symbols = pick([[], ['spx'], ['SPX', 'aapl'], ['NDX'], ['msft', 'xsp']]);
  const facts = run(() => X.collectFacts(recs, trips, settle, now, symbols, extra));
  out.collect.push({ records: recs, trips, now, symbols, extra: enc(extra), ...facts });
  if (facts.out) {
    const all = X.collectFacts(recs, trips, settle, now, symbols, extra);
    out.lines.push({ facts: enc(all), lines: all.map((f) => X.factLine(f)), tally: X.tallyLine(all) });
  }
}
{
  // 超过 200 笔:截断
  const many = [...X.optionFacts(rowsAll, isPaper), ...X.positionFacts(posRows, isPaper)];
  out.collect.push({ records: [], trips: [], now: 0, symbols: [], extra: enc(many), ...run(() => X.collectFacts([], [], settle, 0, [], many)) });
  const odd = [{ id: 'a', kind: 'stock', opened_at: 'bad', label: 'L', entry_price: null, exit_price: 1.23456, how: 'open', result: 'weird', return_pct: -0, paper: true, note: '' },
    { id: 'b', kind: 'option', opened_at: '2026-10-01T00:00:00+00:00', label: 'L', entry_price: null, how: 'closed', result: 'win', return_pct: 0, paper: false, note: 'n' },
    { id: 'c', kind: 'butterfly', opened_at: '2026-10-01T00:00:00+00:00', closed_at: '', label: 'L', exit_price: null, how: 'expired', result: 'loss', return_pct: -1.5, paper: 0, note: '' }];
  out.lines.push({ facts: enc(odd), lines: odd.map((f) => X.factLine(f)), tally: X.tallyLine(odd) });
}

// 手写的边界
{
  const base = rt(I.groupButterflies(flyFills({ perm: 9001, day: '20261016', hh: 14, mm: 0 }), [])[0]);
  const exit = rt(I.groupButterflies(flyFills({ perm: 9002, day: '20261016', hh: 15, mm: 0, action: 'SELL' }), [])[0]);
  const A = { ...rt(base), id: 'A' }; A.ibkr.avg_fill_price = 2;
  const B = { ...rt(exit), id: 7 }; B.ibkr.avg_fill_price = 2.01;
  const C = { ...rt(base), id: '7', contract: { secType: 'STK' } }; C.ibkr.avg_fill_price = 9;
  const B2 = { ...rt(exit), id: 'B2' }; B2.ibkr.avg_fill_price = 2.123456;
  for (const recs of [[C, A, B], [A, B2]]) out.butterflies.push({ records: recs, now: 0, ...run(() => X.butterflyFacts(recs, settle, 0)) });
  const at = T_expiry(A);
  out.butterflies.push({ records: [A], now: at, ...run(() => X.butterflyFacts([A], settle, at)) });
  out.settlements.push({ records: [A], now: at, ...run(() => X.settlementsNeeded([A], at)) });
  out.settlements.push({ records: [A], now: at - 1, ...run(() => X.settlementsNeeded([A], at - 1)) });
  const t0 = [{ id: 's0', status: 'closed', avg_entry: 0, realized_pnl: 5, realized_qty: 2, symbol: 'X', side: 'LONG', created_at: '2026-10-01 10:00', closed_at: '2026-10-02 10:00' }];
  out.stocks.push({ trips: t0, ...run(() => X.stockFacts(t0)) });
  const pr = [{ ...posRows[0], open_et: '2026-10-01 10:00:00', closed_et: '2026-10-03 10:00:00' }, { ...posRows[1], closed_et: '' }];
  out.positions.push({ rows: pr, ...run(() => X.positionFacts(pr, isPaper)), days: [...X.positionDays(pr)] });
  const f0 = X.optionFacts(rowsAll.slice(0, 3), isPaper);
  const extra = [{ ...f0[0], id: 'zz', symbol: 'spx' }, { ...f0[0], id: 'aa', symbol: 'spx' }, { ...f0[0], id: 'mm' }, ...f0];
  out.collect.push({ records: [], trips: [], now: 0, symbols: ['SPX'], extra: enc(extra), ...run(() => X.collectFacts([], [], settle, 0, ['SPX'], extra)) });
}
out.runtime = process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`;
writeFileSync(join(here, 'trade_outcomes.json'), JSON.stringify(out) + '\n');
console.log('trade_outcomes.json', Object.entries(out).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k}=${v.length}`).join(' '));
