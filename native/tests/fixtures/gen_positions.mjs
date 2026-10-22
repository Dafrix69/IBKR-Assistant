// 生成 positions.json:engine-ts/src/positions.ts + combos.ts(原模块现跑)。持仓身份(makeKey / legOf / positionLabel / fmtStrike)在一组边角输入上;
// 组合识别(withCombos → groupLegs / splitStructures / shapeOf / comboRow)在手搭的标准结构(价差、蝶、铁鹰、铁蝶、同到期的两只蝶、断翼蝶、
// 同一行权价的看跌看涨)与 600 组随机腿上。
//   node native/tests/fixtures/gen_positions.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const P = await import(pathToFileURL(join(engine, 'dist/src/positions.js')).href);
const C = await import(pathToFileURL(join(engine, 'dist/src/combos.js')).href);
const MD = await import(pathToFileURL(join(engine, 'dist/src/marketdata.js')).href);

const strikes = [null, undefined, '', ' ', 'abc', 0, -0, 7800, 7815.5, '7800', 0.00004, 0.00005, 1e21, -12.25, 3.14159265, '1e3', true, [5], {}];
const fmt = strikes.map((s) => ({ s: s === undefined ? '__undefined__' : Object.is(s, -0) ? '__neg0__' : s, out: P.fmtStrike(s) }));  // JSON 装不下 -0
const contracts = [null, undefined, {}, { secType: 'STK' }, { secType: '' }, { secType: 'OPT', lastTradeDateOrContractMonth: '20261016', strike: 7800, right: 'c' },
  { secType: 'FOP', lastTradeDateOrContractMonth: 202610161, strike: '7815.50', right: 'Put' }, { secType: 'OPT' }, { secType: 'BAG' }, { secType: 'OPT', lastTradeDateOrContractMonth: '2026', right: '' },
  { secType: 5 }, { secType: null, strike: 1 }];
const legs = contracts.map((c) => ({ c: c === undefined ? '__undefined__' : c, legOf: P.legOf(c),
  labels: [['SPX', 'OPT'], ['SPX', 'STK'], ['', 'OPT'], ['  ', 'FOP']].map(([sym, st]) => P.positionLabel(sym, st, c)) }));
const keys = [['a', 'b', 'c', ''], ['a', 'b', 'OPT', '20261016|7800|C'], ['', '', '', '']].map((a) => P.makeKey(...a));

let seed = 0x5eed1234;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
let k = 0;
const row = (account, symbol, expiry, strike, right, qty, extra = {}) => ({
  key: `k${++k}`, account, symbol, sec_type: 'OPT', quantity: qty, avg_cost: 100 + strike / 100, market_price: 1 + (strike % 7) / 10, close_price: 1.5, multiplier: 100, currency: 'USD',
  market_value: qty * 50, unrealized_pnl: qty * 3.5, contract: { secType: 'OPT', symbol, lastTradeDateOrContractMonth: expiry, strike, right, exchange: 'SMART', currency: 'USD' }, ...extra,
});
const hand = [
  [row('A', 'SPX', '20261016', 7800, 'C', 2), row('A', 'SPX', '20261016', 7815, 'C', -2)],
  [row('A', 'SPX', '20261016', 7800, 'C', 1), row('A', 'SPX', '20261016', 7815, 'C', -2), row('A', 'SPX', '20261016', 7830, 'C', 1)],
  [row('A', 'SPX', '20261016', 7800, 'P', -1), row('A', 'SPX', '20261016', 7815, 'P', 2), row('A', 'SPX', '20261016', 7830, 'P', -1)],
  [row('A', 'SPX', '20261016', 7700, 'P', 1), row('A', 'SPX', '20261016', 7710, 'P', -1), row('A', 'SPX', '20261016', 7800, 'C', -1), row('A', 'SPX', '20261016', 7810, 'C', 1)],
  [row('A', 'SPX', '20261016', 7700, 'P', 1), row('A', 'SPX', '20261016', 7750, 'P', -1), row('A', 'SPX', '20261016', 7750, 'C', -1), row('A', 'SPX', '20261016', 7800, 'C', 1)],
  [row('A', 'SPX', '20261016', 7595, 'P', 1), row('A', 'SPX', '20261016', 7620, 'P', -2), row('A', 'SPX', '20261016', 7645, 'P', 1),
    row('A', 'SPX', '20261016', 7800, 'C', 1), row('A', 'SPX', '20261016', 7820, 'C', -2), row('A', 'SPX', '20261016', 7840, 'C', 1)],
  [row('A', 'SPX', '20261016', 7800, 'C', 1), row('A', 'SPX', '20261016', 7815, 'C', -2), row('A', 'SPX', '20261016', 7835, 'C', 1)],
  [row('A', 'SPX', '20261016', 7800, 'C', 1, { market_price: null }), row('A', 'SPX', '20261016', 7815, 'C', -1)],
  [row('A', 'SPX', '20261016', 7800, 'C', 1, { close_price: 'x' }), row('A', 'SPX', '20261016', 7815, 'C', -1, { market_value: null })],
  [row('B', 'NDX', '20261016', 100, 'C', 1), row('A', 'NDX', '20261017', 100, 'C', 1), row('A', 'NDX', '20261017', 110, 'C', -1), { key: 's1', account: 'A', symbol: 'NVDA', sec_type: 'STK', quantity: 10 }],
  [row('A', 'SPX', '20261016', 7800, 'C', 1, { sec_type: 'FOP', multiplier: '50' }), row('A', 'SPX', '20261016', 7815, 'C', -1, { sec_type: undefined })],
  [row('A', 'SPX', '20261016', 7800, 'C', 0), row('A', 'SPX', '20261016', 7815, 'C', 0)],
  [row('A', 'SPX', '20261016', 7800, 'C', 3), row('A', 'SPX', '20261016', 7800, 'P', -3), row('A', 'SPX', '20261016', 7815, 'C', 1)],
  [row('A', 'SPX', '20261016', 7800, 'C', 0), row('A', 'SPX', '20261016', 7815, 'C', 0), row('A', 'SPX', '20261016', 7830, 'C', 0)],
  [row('A', 'SPX', '20261016', 7800, 'C', 1), row('A', 'SPX', '20261016', 7815, 'C', -2), row('A', 'SPX', '20261016', 7830.005, 'C', 1)],
  [row('A', 'SPX', '20261016', 7800, 'C', 1), row('A', 'SPX', '20261016', 7815, 'C', -2), row('A', 'SPX', '20261016', 7830.02, 'C', 1)],
  [row('A', 'SPX', '20261016', 7800, 'C', 1000), row('A', 'SPX', '20261016', 7815, 'C', -2000.0015), row('A', 'SPX', '20261016', 7830, 'C', 1000)],
  [row('A', 'SPX', '20261016', 7800, 'C', 1), row('A', 'SPX', '20261016', 7815, 'C', -1.0005)],
  [row('A', 'SPX', '20261016', 7800, 'C', 1, { contract: { secType: 'OPT', symbol: 'SPX', lastTradeDateOrContractMonth: '20261016', strike: 7800, right: 'C', exchange: '', currency: '' } }),
    row('A', 'SPX', '20261016', 7815, 'C', -1)],
];
for (let i = 0; i < 600; i++) {
  const n = 1 + Math.floor(rnd() * 7);
  const set = [];
  for (let j = 0; j < n; j++) {
    const extra = {};
    if (rnd() < 0.1) extra.market_price = null;
    if (rnd() < 0.1) extra.close_price = null;
    if (rnd() < 0.1) extra.market_value = undefined;
    if (rnd() < 0.05) extra.avg_cost = pick(['x', null, -5]);
    if (rnd() < 0.05) extra.multiplier = pick([10, '100', 0, null]);
    set.push(row(pick(['A', 'B']), pick(['SPX', 'NDX']), pick(['20261016', '20261016', '20261017']), pick([7800, 7805, 7810, 7815, 7820, 7830]), pick(['C', 'P', 'c']),
      pick([1, -1, 2, -2, 1, -1, 0.5, 3]), extra));
  }
  hand.push(set);
}
const combos = hand.map((rows) => ({ rows, out: C.withCombos(rows), groups: C.groupLegs(rows) }));
writeFileSync(join(here, 'positions.json'), JSON.stringify({ fmt, legs, keys, combos, timeframes: MD.TIMEFRAMES, minBars: MD.MIN_BARS, delayedMax: MD.DELAYED_FEED_MAX_MS }) + '\n');
console.log(`positions.json:${combos.length} 组持仓`);
