// 生成 trade_similar.json:engine-ts 的 tradeSimilar.ts(原模块现跑):历史交易的可比要素(蝴蝶记录、Flex 仓位、导入的期权、股票持仓段,
// 事实由 tradeOutcomes 现算)、票据的口径(蝴蝶 / 垂直 / 单腿 / 股票 / 其它,缺腿、比例不对、小写、自动中间价)、打分、按出场方式数胜负、
// 排序取前 8;以及 rangePosition / priceAt / slotOf / dteBucket 这些小件。票据是契约形状(RPC 入参,schema 校验过)。账号是假的。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_trade_similar.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const imp = (m) => import(pathToFileURL(join(engine, `dist/src/${m}.js`)).href);
const Y = await imp('tradeSimilar');
const X = await imp('tradeOutcomes');
const I = await imp('ibtrades');
const S = await imp('stockreview');
const O = await imp('optionTradesCsv');
const P = await imp('optionPositionsCsv');
const T = await imp('tradereview');

let seed = 0x51a1_7a2d;
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
const isPaper = (id) => id.startsWith('DU');
const settle = (symbol, date) => (date < '2026-10-20' ? 5800 + (date.charCodeAt(9) % 7) * 5 : null);

const out = { runtime: '', small: [], ranges: [], prices: [], entries: [], similar: [] };

// ---------------------------------------------------------------- 小件
for (const p of [0, 0.3333, 1 / 3, 0.5, 2 / 3, 0.6667, 1, -1, 2, NaN]) out.small.push({ f: 'rangeBucket', a: enc(p), out: Y.rangeBucket(p) });
for (const d of [-1, 0, 0.5, 1, 7, 7.5, 8, NaN, Infinity]) out.small.push({ f: 'bucketOfDays', a: enc(d), out: Y.bucketOfDays(d) });
for (const [e, t] of [['20261016', '2026-10-16'], ['20261016', '2026-10-15'], ['2026-10-23', '2026-10-16'], ['20261030', '2026-10-01'], ['abc', '2026-10-16'], ['20261016', 'x'],
  ['20260230', '2026-02-01'], ['202610', '2026-10-01'], ['', '2026-10-01'], ['20261016', '2026-10-16T'], ['2026-10-16T00:00:00Z', '2026-10-16'], ['20261101', '2026-10-31'], ['20260310', '2026-03-07']])
  out.small.push({ f: 'dteBucket', a: [e, t], out: enc(Y.dteBucket(e, t)) });
for (let i = 0; i < 80; i += 1) {
  const ms = Date.UTC(2026, int(0, 11), int(1, 28), int(0, 23), int(0, 59), int(0, 59));
  out.small.push({ f: 'slotOf', a: ms, out: Y.slotOf(ms) });
}
for (const ms of [Date.UTC(2026, 9, 16, 13, 30), Date.UTC(2026, 9, 16, 13, 29, 59), Date.UTC(2026, 9, 16, 14, 0), Date.UTC(2026, 9, 16, 16, 0), Date.UTC(2026, 9, 16, 19, 0), Date.UTC(2026, 9, 16, 20, 0), NaN])
  out.small.push({ f: 'slotOf', a: enc(ms), ...run(() => Y.slotOf(ms)) });
for (const p of [{ status: '持仓中', exit: '' }, { status: '', exit: '持仓中' }, { status: '已了结', exit: '持有到期' }, { status: '已了结', exit: '拆腿后到期' }, { status: '已了结', exit: '逐腿/拆腿平仓' },
  { status: '已了结', exit: '整体平仓' }, { status: '已了结', exit: '' }]) out.small.push({ f: 'positionExit', a: p, out: Y.positionExit(p) });
const daily = Array.from({ length: 40 }, (_, i) => { const d = new Date(Date.UTC(2026, 8, 1 + i)); return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, high: 100 + i + int(0, 5), low: 90 + i - int(0, 5) }; });
for (const [before, price, lookback] of [['2026-10-01', 110, undefined], ['2026-09-10', 100, undefined], ['2026-10-01', 95, 5], ['2026-10-01', 95, 0], ['2026-10-01', 95, -3], ['2026-10-01', 95, 2.5],
  ['2026-10-01', 95, 100], ['2026-10-01', 95, NaN], ['2026-12-01', 200, 40]]) {
  out.ranges.push({ bars: daily, before, price, lookback: enc(lookback), ...run(() => Y.rangePosition(daily, before, price, lookback)) });
}
const flatBars = daily.map((b) => ({ ...b, high: 5, low: 5 }));
out.ranges.push({ bars: flatBars, before: '2026-12-01', price: 5, lookback: 20, ...run(() => Y.rangePosition(flatBars, '2026-12-01', 5, 20)) });
const strBars = daily.map((b, i) => ({ ...b, high: i === 3 ? 'x' : String(b.high) }));
out.ranges.push({ bars: strBars, before: '2026-12-01', price: 5, lookback: 40, ...run(() => Y.rangePosition(strBars, '2026-12-01', 5, 40)) });
out.ranges.push({ bars: [...daily.slice(0, 3), null], before: 'z', price: 5, lookback: 2, ...run(() => Y.rangePosition([...daily.slice(0, 3), null], 'z', 5, 2)) });
const minute = Array.from({ length: 30 }, (_, i) => ({ time: `2026-10-16 ${pad(9 + Math.floor((30 + i) / 60))}:${pad((30 + i) % 60)}`, close: i === 5 ? null : i === 6 ? 'x' : 5800 + i }));
for (const ms of [T.parseWhen('2026-10-16 09:29'), T.parseWhen('2026-10-16 09:30'), T.parseWhen('2026-10-16 09:35'), T.parseWhen('2026-10-16 09:36'), T.parseWhen('2026-10-16 09:40:30'), T.parseWhen('2026-10-17 10:00')])
  out.prices.push({ bars: minute, ms, ...run(() => Y.priceAt(minute, ms)) });

// ---------------------------------------------------------------- 历史
function flyFills(o) {
  const k = o.center, w = o.wing, day = o.day;
  const wing = o.action === 'SELL' ? 'SLD' : 'BOT', body = wing === 'BOT' ? 'SLD' : 'BOT';
  return [k - w, k, k + w].map((strike, i) => ({ account_id: o.account, perm_id: o.perm, order_id: 1, exec_id: `x${o.perm}.${i}`, time: `${day}-${pad(o.hh)}:${pad(o.mm)}:00`,
    side: i === 1 ? body : wing, shares: (i === 1 ? 2 : 1) * o.qty, price: [3, 2, 1.5][i] + o.bump * (i === 0 ? 1 : 0),
    contract: { secType: 'OPT', symbol: o.symbol, strike, right: o.right, expiry: day, tradingClass: 'SPXW', multiplier: '100', conId: 7 } }));
}
function history() {
  const fills = [];
  let perm = int(100, 900);
  for (let i = 0; i < int(2, 10); i += 1) {
    const o = { perm: (perm += 1), day: pick(['20261009', '20261014', '20261015', '20261016', '20261023']), center: pick([5800, 5810, 5825]), wing: pick([10, 5, 20, 25, 12]),
      symbol: pick(['SPX', 'SPX', 'SPX', 'XSP']), right: pick(['P', 'C']), account: pick(['DUTEST001', 'UXTEST123']), hh: int(13, 20), mm: int(0, 59), qty: int(1, 3), bump: pick([0, 0.5, 1, 2, -1]) };
    fills.push(...flyFills(o));
    if (rnd() < 0.5) fills.push(...flyFills({ ...o, perm: (perm += 1), action: 'SELL', hh: Math.min(o.hh + 1, 20) }));
  }
  const records = rt(I.groupButterflies(fills, []));
  if (rnd() < 0.2 && records.length) delete records[0].created_at;
  if (rnd() < 0.2 && records.length) { records[0].ibkr.fills = []; delete records[0].created_at; }
  const sfills = [];
  let t = Date.UTC(2026, 9, 1, 14, 0);
  for (let j = 0; j < int(0, 8); j += 1) {
    t += pick([60e3, 3600e3, 86400e3]);
    const d = new Date(t);
    sfills.push({ exec_id: `s${j}`, time: `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`, account_id: 'DUTEST001',
      side: pick(['BOT', 'SLD']), shares: pick([10, 20]), price: 100 + int(-5, 5), perm_id: 5000 + j, contract: { secType: 'STK', symbol: pick(['AAPL', 'MSFT', 'NVDA']) } });
  }
  const trips = rt(S.groupStockTrips(sfills, [], pick([null, {}])));
  const ocols = [...O.OPTION_COLUMNS];
  const olines = Array.from({ length: int(0, 12) }, (_, i) => {
    const day = `2026-10-${pad(int(1, 20))}`;
    const r = { time_et: `${day} ${pad(int(9, 15))}:${pad(int(0, 59))}:00`, date_et: day, symbol: pick(['SPX', 'AAPL', 'XSP']), asset: '期权', structure: pick(['蝴蝶', '垂直价差', '多个仓位同时结算', '单腿']),
      action: pick(['平仓', '到期结算', '拆腿平仓', '逐腿平仓']), direction: '', qty: pick(['1', '']), net_price: '', realized_pnl: pick(['120', '-80', '0']), commission: '1', legs: 'L', order_ids: String(i), note: '' };
    return ocols.map((c) => r[c]).join(',');
  });
  const optRows = O.parseOptionTradesCsv([ocols.join(','), ...olines].join('\n'), 'DUTEST001', 't').rows;
  const pcols = Object.entries(P.POSITION_COLUMNS);
  const plines = Array.from({ length: int(0, 12) }, (_, i) => {
    const day = `2026-10-${pad(int(1, 20))}`;
    const exit = pick(['整体平仓', '持有到期', '拆腿后到期', '逐腿/拆腿平仓', '持仓中']);
    const r = { open: pick([`${day} ${pad(int(9, 15))}:${pad(int(0, 59))}:00`, `${day} 09:${pad(int(30, 59))}:00`]), symbol: pick(['SPX', 'XSP']), structure: pick(['蝴蝶', '垂直价差', '单腿']), direction: '',
      qty: pick(['1', '2', '']), expiry: pick(['20261016', '', '20261031']), dte: pick(['0', '3', '', '10']), right: pick(['C', 'P', 'CP']), strikes: '1/2/3', center: pick(['5800', '']), width: pick(['10', '20', '', '0', '9']),
      ratio: '1:2:1', netPrice: pick(['2.5', '-1.2', '', '0.6']), legs: `L${i}`, exit, status: exit === '持仓中' ? '持仓中' : '已了结', closed: exit === '持仓中' ? '' : `${day} 15:59:00`, holdMin: '5',
      pnl: pick(['250', '-75.5', '0', '3']), commission: '1' };
    return pcols.map(([k]) => r[k]).join(',');
  });
  const posRows = P.parseOptionPositionsCsv([pcols.map(([, c]) => `"${c}"`).join(','), ...plines].join('\n'), 'UXTEST123', 'p').rows;
  const now = Date.UTC(2026, 9, int(10, 25), int(13, 21));
  const facts = [...X.butterflyFacts(records, settle, now), ...X.stockFacts(trips), ...X.optionFacts(optRows, isPaper), ...X.positionFacts(posRows, isPaper)];
  const under = {};
  for (const f of facts) if (rnd() < 0.6) under[f.id] = 5800 + int(-30, 30);
  const rpos = {};
  for (const f of facts) if (f.kind === 'stock' && rnd() < 0.7) rpos[f.id] = pick([0.1, 0.5, 0.9, 0.34, 1.2]);
  return { records, trips, optRows, posRows, facts: rt(facts), under, rpos, now };
}
const tickets = () => {
  const legs3 = (k, w, right, ratios = [1, 2, 1]) => [{ action: 'BUY', ratio: ratios[0], strike: k - w, right }, { action: 'SELL', ratio: ratios[1], strike: k, right }, { action: 'BUY', ratio: ratios[2], strike: k + w, right }];
  return pick([
    { sec_type: 'BAG', symbol: pick(['SPX', ' spx ', 'XSP']), action: 'BUY', limit_price: pick([2.5, null, -1.2, 0, 0.6]), expiry: pick(['20261016', '20261023', null, '20261031']), right: null,
      combo_strategy: pick(['BUTTERFLY', null, 'butterfly']), legs: rnd() < 0.2 ? [...legs3(5800, pick([10, 20, 12]), pick(['P', 'C', null]))].reverse() : legs3(pick([5800, 5810]), pick([10, 20, 25, 8]), pick(['P', 'C', null])) },
    { sec_type: 'BAG', symbol: 'SPX', action: 'BUY', limit_price: 1, expiry: '20261016', right: 'p', combo_strategy: null, legs: legs3(5800, 10, null, [1, 3, 2]) },
    { sec_type: 'bag', symbol: 'SPX', action: 'BUY', limit_price: 2, expiry: '20261016', right: 'P', combo_strategy: 'BUTTERFLY', legs: [{ action: 'BUY', ratio: 1, strike: 5800, right: 'P' }, { action: 'BUY', ratio: 1, strike: null, right: 'P' }] },
    { sec_type: 'BAG', symbol: 'SPX', action: 'BUY', limit_price: 2, expiry: '20261016', right: null, combo_strategy: 'BUTTERFLY' },
    { sec_type: 'BAG', symbol: 'SPX', action: 'SELL', limit_price: 1, expiry: '20261016', right: null, combo_strategy: pick(['VERTICAL', null]), legs: [{ action: 'BUY', ratio: 1, strike: 5800, right: 'P' }, { action: 'SELL', ratio: 1, strike: 5790, right: 'P' }] },
    { sec_type: pick(['OPT', 'opt']), symbol: pick(['SPX', 'AAPL']), action: 'BUY', limit_price: 3, expiry: pick(['20261016', null]), right: 'C', combo_strategy: null, legs: [] },
    { sec_type: 'STK', symbol: pick(['AAPL', 'msft', 'NVDA', 'TSLA']), action: pick(['BUY', 'sell', 'SELL']), limit_price: null, expiry: null, right: null, combo_strategy: null },
    { sec_type: 'FUT', symbol: pick(['SPX', 'ES']), action: 'BUY', limit_price: null, expiry: null, right: null, combo_strategy: null },
  ]);
};
for (let i = 0; i < 70; i += 1) {
  const h = history();
  const be = run(() => Y.butterflyEntries(h.records, h.facts, new Map(Object.entries(h.under))));
  const pe = run(() => Y.positionEntries(h.posRows, h.facts, new Map(Object.entries(h.under))));
  const oe = run(() => Y.optionEntries(h.optRows, h.facts));
  const se = run(() => Y.stockEntries(h.facts, new Map(Object.entries(h.rpos))));
  out.entries.push({ records: h.records, posRows: h.posRows, optRows: h.optRows, facts: h.facts, under: h.under, rpos: h.rpos, be, pe, oe, se });
  const hist = [...(be.out ?? []), ...(pe.out ?? []), ...(oe.out ?? []), ...(se.out ?? [])];
  for (let j = 0; j < 4; j += 1) {
    const t = rt(tickets());
    const peers = pick([[], ['MSFT', 'NVDA'], ['AAPL']]);
    const ctx = pick([{}, { spot: 5805 }, { spot: 0 }, { spot: null, rangePos: 0.2 }, { rangePos: 0.5 }, { rangePos: 0.9, spot: 5790 }, { spot: 5812.5, rangePos: null }]);
    const now = h.now + j * 3600e3;
    const histDec = JSON.parse(JSON.stringify(hist), (k, v) => (v === '__undefined__' ? undefined : v === '__NaN__' ? NaN : v));
    out.similar.push({ hist: out.entries.length - 1, ticket: t, now, peers, ctx: enc(ctx), kind: Y.ticketKind(t), ...run(() => Y.findSimilar(t, histDec, now, new Set(peers), ctx)) });
  }
}
{
  // 翼宽为 0 的蝶(下翼与中心同一个行权价):width 是 undefined,不比权利金 / 中心
  const legs = [5800, 5800, 5810].map((strike, i) => ({ strike, action: i === 1 ? 'SELL' : 'BUY', ratio: i === 1 ? 2 : 1, right: 'P', lastTradeDateOrContractMonth: '20261016' }));
  const rec = { id: 'w0', created_at: '2026-10-16 10:00', contract: { secType: 'BAG', symbol: 'SPX', legs }, order: { action: 'BUY', totalQuantity: 1 }, ibkr: { avg_fill_price: 2, fills: [] } };
  const facts = rt(X.butterflyFacts([rec], settle, 0));
  const under = { w0: 5805 };
  const be = run(() => Y.butterflyEntries([rec], facts, new Map(Object.entries(under))));
  out.entries.push({ records: [rec], posRows: [], optRows: [], facts, under, rpos: {}, be, pe: { out: [] }, oe: { out: [] }, se: { out: [] } });
}
out.runtime = process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`;
writeFileSync(join(here, 'trade_similar.json'), JSON.stringify(out) + '\n');
console.log('trade_similar.json', Object.entries(out).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k}=${v.length}`).join(' '));
