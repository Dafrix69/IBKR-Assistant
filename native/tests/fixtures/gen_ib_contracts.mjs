// 生成 ib_contracts.json:engine-ts 的 ibContracts.ts(原模块现跑)。第三个星期五(1990–2100 每个月,外加 NaN、13 月、小数年),
// 季月(2019–2031 每一天与写坏的日期串),流式记号(CRYPTO: / CONTFUT: / FUT: / IND: 与各种写坏的样子、全角、空白、ß 这类大写会变长的字),
// 交易类(随机的链、同名 / 月度 / 日到期 / 调整期权、点名的那一类在不在这个到期日上),行权价的"整"与期权链订哪几档
// (随机网格、现价在网格外、width 是小数 / 负数 / NaN / Infinity,span 是 null / 负数 / 盖得住与盖不住),合约描述。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_ib_contracts.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const X = await import(pathToFileURL(join(engine, 'dist/src/ibContracts.js')).href);

let seed = 0x1bc0_7a11;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const subset = (a, p) => a.filter(() => rnd() < p);
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

const out = { stock: [], third: [], front: [], index: [], futures: [], crypto: [], stream: [], pick: [], round: [], chain: [], option: [], describe: [] };

for (const args of [['AAPL'], ['AAPL', 'ISLAND'], ['7203', 'TSEJ', 'JPY'], [''], ['spy', '', '']]) out.stock.push({ args, out: enc(X.stockContract(...args)) });
for (const args of [['SPX', 'CBOE'], ['VIX', ''], ['', 'X']]) out.index.push({ args, out: enc(X.indexContract(...args)) });

// ---------------------------------------------------------------- 第三个星期五
for (let y = 1990; y <= 2100; y += 1) for (let m = 1; m <= 12; m += 1) out.third.push([y, m, X.thirdFriday(y, m)]);
for (const [y, m] of [[NaN, 3], [2026, NaN], [2026, 13], [2026, 0], [2026.5, 3], [2026, 3.5], [-1, 3], [0, 1], [99, 2], [10000, 6], [2026, -1], [Infinity, 3]]) {
  out.third.push([enc(y), enc(m), X.thirdFriday(y, m)]);
}

// ---------------------------------------------------------------- 季月
const pad = (n) => String(n).padStart(2, '0');
for (let t = Date.UTC(2019, 0, 1); t <= Date.UTC(2031, 11, 31); t += 86400000) {
  const d = new Date(t);
  const s = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  out.front.push({ d: s, ...run(() => X.frontQuarterly(s)) });
}
for (const s of ['', '2026', '2026-', '2026-03', '2026-03-20', '2026-03-20T10:00', '2026-12-31x', ' 2026-03-20', 'abcd-ef-gh', '2026-13-01', '2026-00-10', '2026-1-05', '20260320',
  '0000-03-20', '9999-12-31', '2026-03-19', '2026-03-21', '2026-06-18', '2026-09-17', '2026-09-18', '2026-12-18', '2026-12-19', '-001-03-01', '2026-09-31', '1e3--03-01', '0x10-03-01']) {
  out.front.push({ d: s, ...run(() => X.frontQuarterly(s)) });
}
for (const cfg of [{ futures: 'ES', futures_exchange: 'CME' }, { futures: 'NQ', futures_exchange: '' }, { futures: '', futures_exchange: 'CBOT' }]) {
  for (const d of ['2026-03-20', '2026-03-19', '2026-12-31', 'bad']) out.futures.push({ cfg, d, ...run(() => X.indexFuturesContract(cfg, d)) });
}

// ---------------------------------------------------------------- 流式记号
const syms = ['BTC', 'crypto:btc', 'CRYPTO:BTC', ' CRYPTO:ETH ', 'CRYPTO:B', 'CRYPTO:ABCDEFGHIJ', 'CRYPTO:ABCDEFGHIJK', 'CRYPTO:BT1', 'CRYPTO:', 'CRYPTO:BTC\n', 'CRYPTO:BTC\nX',
  'CONTFUT:GC@COMEX', 'contfut:gc@comex', 'FUT:ES@CME', 'IND:TNX@CBOE', 'IND:TNX@C', 'IND:TNX@ABCDEFGHIJKL', 'IND:TNX@ABCDEFGHIJKLM', 'IND:ABCDEFGHIJKL@CBOE', 'IND:ABCDEFGHIJKLM@CBOE',
  'IND:@CBOE', 'IND:TNX@', 'OPT:SPX@CBOE', 'IND:T-X@CBOE', 'IND:TNX@CB1', 'aapl', ' aapl\t', '　spy　', '﻿qqq', '', '   ', 'straße', 'CRYPTO:STRAßE', 'CRYPTO:ﬁx', 'ＣＲＹＰＴＯ:BTC',
  'IND:TNX@CBOE ', 'CONTFUT:GC@COMEX@X', 'CRYPTO:BTC:X', 'brk.b', 'CRYPTO:ıi', 'crypto:İX'];
for (const s of syms) {
  out.crypto.push({ s, out: enc(X.cryptoSymbol(s)) });
  out.stream.push({ s, out: enc(X.streamContract(s)) });
}

// ---------------------------------------------------------------- 交易类
const classPool = ['SPX', 'SPXW', 'AAPL', '2AAPL', 'XSP', 'NDX', 'NDXP', 'spx', 'Spx', 'SPXQ', 'B', 'a', 'Ä', '10', '2', 'ﬁ', ''];
const expPool = ['20260917', '20260918', '20261015', '20261016', '20261017', '20261218', '20270115'];
const cfgs = [null, { daily_trading_class: 'SPXW', monthly_trading_class: 'SPX' }, { daily_trading_class: 'NDXP', monthly_trading_class: 'NDX' },
  { daily_trading_class: '', monthly_trading_class: '' }, { daily_trading_class: 'AAPL', monthly_trading_class: '2AAPL' }];
for (let i = 0; i < 1500; i += 1) {
  const byClass = {};
  for (let n = Math.floor(rnd() * 5); n > 0; n -= 1) {
    const name = pick(classPool);
    const r = rnd();
    const expiries = expPool.filter(() => rnd() < 0.4);
    byClass[name] = r < 0.15 ? { strikes: [1, 2] } : r < 0.25 ? {} : { expiries, strikes: [] };
  }
  const symbol = pick(['SPX', 'spx', 'AAPL', 'NDX', 'XSP', 'ß', '', 'Spx']);
  const cfgIdx = Math.floor(rnd() * cfgs.length);
  const expiry = pick(expPool);
  const prefer = pick(['', '', '', 'SPXW', 'SPX', 'NDXP', 'nope', '2AAPL']);
  out.pick.push({ symbol, cfg: cfgIdx, byClass, expiry, prefer, ...run(() => X.pickTradingClass(symbol, cfgs[cfgIdx], byClass, expiry, prefer)) });
}
// 月度与日到期两类都在这个到期日上、标的名跟谁都不同:谁排前面全看「月度 1、日到期 2」,到期日多少、字母序都不能替它定
for (let i = 0; i < 400; i += 1) {
  const cfgIdx = Math.floor(rnd() * cfgs.length);
  const cfg = cfgs[cfgIdx];
  if (!cfg || !cfg.daily_trading_class) continue;
  const byClass = {};
  for (const name of [cfg.daily_trading_class, cfg.monthly_trading_class, ...subset(classPool, 0.15)].sort(() => rnd() - 0.5)) {
    const n = Math.floor(rnd() * 5);
    byClass[name] = { expiries: [...expPool.slice(0, 1 + n), ...(rnd() < 0.8 ? [expPool[5]] : [])], strikes: [] };
  }
  const symbol = pick(['XSP', 'QQQ', 'ZZZ', 'A']);
  const expiry = expPool[5];
  const prefer = pick(['', '', 'nope']);
  out.pick.push({ symbol, cfg: cfgIdx, byClass, expiry, prefer, ...run(() => X.pickTradingClass(symbol, cfg, byClass, expiry, prefer)) });
}
out.cfgs = cfgs;

// ---------------------------------------------------------------- 行权价
const strikes = [6725, 6750, 6800, 6705, 6700, 7000, 10000, 100000, 1e6, 5e5, 2.5, 0.5, 0.25, 0.1, 0.05, 0.03, 0.01, 0.015, 0, -5, NaN, Infinity, 1e-7, 7790.000001, 7790.0000001,
  101.5, 102.25, 12.125, 3e-3, 250.0000004, 1e21, 0.3, 0.7, 0.2, 1.1];
for (let i = 0; i < 2000; i += 1) strikes.push(pick([Math.round(rnd() * 8000), Math.round(rnd() * 400) * 2.5, Math.round(rnd() * 1000) / 4, rnd() * 100, Math.round(rnd() * 200) / 20]));
for (const k of strikes) out.round.push([enc(k), X.strikeRoundness(k)]);

const gridOf = () => {
  const kind = rnd();
  const lo = pick([10, 95, 400, 6500, 7000]);
  const step = pick([1, 2.5, 5, 0.5, 10, 25]);
  const n = Math.floor(rnd() * 160);
  const g = [];
  for (let i = 0; i < n; i += 1) g.push(+(lo + i * step).toFixed(4));
  if (kind < 0.2) for (let i = 0; i < 10; i += 1) g.push(pick(g.length ? g : [1]));  // 重复
  if (kind < 0.3) g.push(...[NaN, 0, -5, Infinity, -0].filter(() => rnd() < 0.5));
  if (kind < 0.4) g.sort(() => rnd() - 0.5);
  return g;
};
for (let i = 0; i < 2500; i += 1) {
  const grid = gridOf();
  const mid = grid.length ? grid[Math.floor(rnd() * grid.length)] : 100;
  const spot = pick([mid, mid + rnd() * 3, mid - 50, Number.isFinite(mid) ? mid * 2 : 7000, 0, NaN, -10, Infinity, 1e9]);
  const width = pick([0, 1, 2, 5, 10, 25, 3.5, -1, -3, NaN, Infinity, 50, 2.7]);
  const span = pick([null, null, 0, -5, NaN, 5, 20, 50, 100, 300, 1000, 2.5, Infinity]);
  out.chain.push({ grid: enc(grid), spot: enc(spot), width: enc(width), span: enc(span), ...run(() => X.chainStrikes(grid, spot, width, span)) });
}
// 现价或跨度是无穷:离现价的距离全是 Infinity / NaN,排序键里的 NaN 要落到下一项去比
for (let i = 0; i < 80; i += 1) {
  let grid = gridOf();
  while (grid.length < 30) grid = gridOf();
  const spot = pick([Infinity, -Infinity, 1e308, grid[0]]);
  const width = pick([0, 1, 2, 3, 5, 8]);
  const span = pick([Infinity, Infinity, 1e308, 50]);
  out.chain.push({ grid: enc(grid), spot: enc(spot), width, span: enc(span), ...run(() => X.chainStrikes(grid, spot, width, span)) });
}
// 不给 span(用默认的 null)
for (let i = 0; i < 50; i += 1) {
  const grid = gridOf();
  const spot = grid.length ? grid[0] + 7 : 50;
  out.chain.push({ grid: enc(grid), spot: enc(spot), width: 3, span: '__undefined__', ...run(() => X.chainStrikes(grid, spot, 3)) });
}

// ---------------------------------------------------------------- 期权与描述
for (const args of [['SPX', '20261016', 7790, 'P', 'SMART'], ['SPX', '20261016', 7790, 'C', 'SMART', 'USD', '100', 'SPXW'], ['AAPL', '', 0, '', '', '', '', ''],
  ['X', '2026', NaN, 'C', 'CBOE', 'EUR', '10', 'X2'], ['X', '2026', -0, 'C', 'CBOE']]) out.option.push({ args: enc(args), out: enc(X.optionContract(...args)) });
const descs = [
  X.stockContract('AAPL'), X.indexContract('SPX', 'CBOE'), X.cryptoContract('BTC'), X.streamContract('CONTFUT:GC@COMEX'), X.indexFuturesContract({ futures: 'ES', futures_exchange: '' }, '2026-10-19'),
  X.optionContract('SPX', '20261016', 7790, 'P', 'SMART', 'USD', '100', 'SPXW'), X.optionContract('SPX', '20261016', 7790.5, 'C', 'SMART'),
  X.optionContract('', '', 0, '', ''), X.optionContract('SPX', '', NaN, 'P', 'SMART', 'USD', '100', ''), X.optionContract('SPX', '1', 1e21, 'C', 'SMART', 'USD', '100', 'T'),
  X.optionContract('SPX', '1', 0.1, 'C', 'SMART', 'USD', '100', 'T'), X.optionContract('SPX', '1', -0, 'C', 'SMART', 'USD', '100', 'T'),
  { secType: '', symbol: '', exchange: '', currency: '' }, { secType: 'BAG', symbol: 'SPX', exchange: 'SMART', currency: 'USD', comboLegs: [], conId: 0 },
];
for (const c of descs) out.describe.push({ c: enc(c), out: X.describeContract(c) });

writeFileSync(join(here, 'ib_contracts.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
