// 生成 csv_imports.json:engine-ts 的 fillsCsv.ts / optionTradesCsv.ts / optionPositionsCsv.ts(原模块现跑)读合成的导出文本:
// BOM、CRLF / 单独的 CR、引号里的逗号与换行、表头次序打乱 / 多列 / 缺列、JS 的空白集( 、　、﻿ 在中间)、
// 大小写、坏的数(0x10、1e3、Infinity、空串)、文件内重复。账号是假的。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_csv_imports.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const F = await import(pathToFileURL(join(engine, 'dist/src/fillsCsv.js')).href);
const O = await import(pathToFileURL(join(engine, 'dist/src/optionTradesCsv.js')).href);
const P = await import(pathToFileURL(join(engine, 'dist/src/optionPositionsCsv.js')).href);

let seed = 0xc5e1_9a03;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const bias = (a) => (rnd() < 0.65 ? a[0] : pick(a));
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const run = (f) => { try { return { out: f() }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };
const pad = (n) => String(n).padStart(2, '0');
const WS = ['', '', ' ', '\t', ' ', '　', '﻿', ' '];
const ws = (s) => (rnd() < 0.06 ? pick(WS) + s + pick(WS) : s);
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const NL = () => pick(['\n', '\n', '\r\n', '\r']);

const out = { runtime: '', parseCsv: [], fills: [], trades: [], positions: [] };

// ---------------------------------------------------------------- parseCsv
for (const t of ['', 'a', 'a,b\nc,d', 'a,"b,c",d\r\ne', '"a""b",c', '"multi\nline",x\r\ny', 'a,\n,\n  ,  \n', 'a\r\rb', '"unterminated,x\ny', 'x,"",y', '\n\n', 'a,b,', '"a"b,c', 'a"b",c', '﻿h1,h2\n1,2'])
  out.parseCsv.push({ t, out: O.parseCsv(t) });

// ---------------------------------------------------------------- fills.csv
const FCOLS = [...F.REQUIRED_COLUMNS];
function fillRow(i) {
  const d = new Date(Date.UTC(2025, int(0, 11), int(1, 28), int(0, 23), int(0, 59), int(0, 59)));
  const iso = d.toISOString();
  return {
    trade_time_utc: bias([iso.replace('.000Z', 'Z'), iso, iso.replace('Z', '+00:00').replace('.000', ''), iso.replace('T', ' ').replace('.000Z', 'Z'), '2025-10-31T09:13:36', '2025-10-31T09:13:36+08:00', 'bad', '']),
    symbol: bias(['AAPL', 'nvda', 'brk b', '']), sec_type: bias(['STK', 'STK', 'stk', 'OPT', 'CASH', '', 'FUT', 'ß']), currency: bias(['USD', 'usd', '', 'HKD']),
    side: bias(['BUY', 'SELL', 'buy', 'sell', 'BOT', '']), size: bias(['100', '0.5', '0', '-5', '1e2', '0x10', 'Infinity', '', 'abc', ' 7 ']),
    price: bias(['150.25', '0', '-1', '', '1e-3', '٣']), exchange: bias(['NASDAQ', 'ISLAND', '']), commission: bias(['-1.0', '0', '', 'x', '0.35']),
    order_id: bias(['12345', '0', '', '-3', '12.7', 'abc', '1e21']), trade_id: bias([`0000e${i}.01`, `0000e${i}.01`, '0000dup', '']),
  };
}
for (let k = 0; k < 60; k += 1) {
  let cols = rnd() < 0.3 ? shuffle(FCOLS) : [...FCOLS];
  if (rnd() < 0.15) cols.push('extra');
  if (rnd() < 0.06) cols = cols.filter((c) => c !== pick(FCOLS));
  const lines = [cols.map(ws).join(',')];
  for (let i = 0; i < int(0, 25); i += 1) {
    const r = fillRow(i);
    let cells = cols.map((c) => (c === 'extra' ? 'z' : ws(r[c] ?? '')));
    if (rnd() < 0.05) cells = cells.slice(1);
    if (rnd() < 0.03) cells.push('');
    lines.push(cells.join(','));
    if (rnd() < 0.05) lines.push(pick(['', '   ', '\t']));
  }
  let text = lines.map((l) => l + NL()).join('');
  if (rnd() < 0.3) text = '﻿' + text;
  if (rnd() < 0.05) text = '﻿' + text;
  const acct = pick(['DUTEST001', 'UXTEST123']);
  out.fills.push({ text, acct, ...run(() => F.parseFillsCsv(text, acct)) });
}
for (const text of ['', '\n', 'trade_time_utc,symbol\n', FCOLS.join(',')]) out.fills.push({ text, acct: 'DUTEST001', ...run(() => F.parseFillsCsv(text, 'DUTEST001')) });

// ---------------------------------------------------------------- trades.csv
const OCOLS = [...O.OPTION_COLUMNS];
const q = (s) => (/[",\n\r]/.test(s) || rnd() < 0.1 ? `"${s.replace(/"/g, '""')}"` : s);
function tradeRow(i) {
  const day = `2026-${pad(int(7, 9))}-${pad(int(1, 28))}`;
  return {
    time_et: bias([`${day} ${pad(int(9, 15))}:${pad(int(0, 59))}:${pad(int(0, 59))}`, `${day} 10:00`, `${day}T10:00:00`, '']), date_et: bias([day, day, '2026/07/01', '']),
    symbol: bias(['SPX', 'spx', 'AAPL', '']), asset: bias(['期权', '期权', '期权', '股票', '']), structure: bias(['蝴蝶', '垂直价差', '单腿', '多个仓位同时结算', 'a,b']),
    action: bias(['开仓', '平仓', '到期结算', '拆腿平仓', '']), direction: bias(['买方', '贷方', '', '借方"看涨"']), qty: bias(['1', '2', '', '0', '-1', 'x', '0.5']),
    net_price: bias(['2.35', '', '-1.1', 'x']), realized_pnl: bias(['-120.5', '300', '0', '', 'x']), commission: bias(['1.3', '', 'x']),
    legs: bias(['B1 C7410,S2 C7425,B1 C7440', '', 'P7400']), order_ids: bias([`${i}`, `${i}|${i + 1}`, '7']), note: bias(['', '说明\n第二行', 'x']),
  };
}
for (let k = 0; k < 60; k += 1) {
  let cols = rnd() < 0.3 ? shuffle(OCOLS) : [...OCOLS];
  if (rnd() < 0.1) cols.push('extra');
  if (rnd() < 0.06) cols = cols.filter((c) => c !== pick(OCOLS));
  const lines = [cols.map(ws).join(',')];
  for (let i = 0; i < int(0, 25); i += 1) {
    const r = tradeRow(i);
    let cells = cols.map((c) => (c === 'extra' ? 'z' : q(ws(r[c] ?? ''))));
    if (rnd() < 0.05) cells = cells.slice(1);
    lines.push(cells.join(','));
    if (rnd() < 0.05) lines.push(pick(['', ' , ,']));
  }
  let text = lines.join(NL()) + (rnd() < 0.5 ? NL() : '');
  if (rnd() < 0.3) text = '﻿' + text;
  out.trades.push({ text, acct: 'DUTEST001', src: 'trades.csv', ...run(() => O.parseOptionTradesCsv(text, 'DUTEST001', 'trades.csv')) });
}
for (const text of ['', OCOLS.slice(1).join(','), OCOLS.join(',')]) out.trades.push({ text, acct: 'DUTEST001', src: 's', ...run(() => O.parseOptionTradesCsv(text, 'DUTEST001', 's')) });

// ---------------------------------------------------------------- option_positions.csv
const PCOLS = Object.entries(P.POSITION_COLUMNS);
function positionRow(i) {
  const day = `2026-${pad(int(7, 9))}-${pad(int(1, 28))}`;
  const t = `${day} ${pad(int(9, 15))}:${pad(int(0, 59))}:${pad(int(0, 59))}`;
  return {
    open: bias([t, t, `${day} 10:00`, '']), symbol: bias(['SPX', 'xsp', '']), structure: bias(['蝴蝶', '垂直价差', '破翼/比例蝴蝶']), direction: bias(['买方', '', '借方看涨']),
    qty: bias(['1', '3', '', 'x']), expiry: bias(['20260918', '']), dte: bias(['0', '3', '', 'x']), right: bias(['C', 'p', 'CP', '']), strikes: bias(['7410/7425/7440', '']),
    center: bias(['7425', '', 'x']), width: bias(['15', '0', '']), ratio: bias(['1:2:1', '']), netPrice: bias(['2.5', '-1.2', '']), legs: bias([`B1 C${7400 + i},S2 C7425`, 'L']),
    exit: bias(['整体平仓', '持有到期', '拆腿后到期', '逐腿/拆腿平仓', '持仓中', '']), status: bias(['已了结', '持仓中']), closed: bias([t, '', 'bad']),
    holdMin: bias(['12', '', '1e3']), pnl: bias(['250', '-75.5', '', 'x']), commission: bias(['2.6', '', 'x']),
  };
}
for (let k = 0; k < 60; k += 1) {
  let cols = rnd() < 0.3 ? shuffle(PCOLS) : [...PCOLS];
  if (rnd() < 0.06) { const drop = pick(PCOLS)[0]; cols = cols.filter(([key]) => key !== drop); }
  const lines = [cols.map(([, col]) => q(ws(col))).join(',')];
  for (let i = 0; i < int(0, 25); i += 1) {
    const r = positionRow(i);
    let cells = cols.map(([key]) => q(ws(r[key] ?? '')));
    if (rnd() < 0.05) cells = cells.slice(1);
    lines.push(cells.join(','));
  }
  let text = lines.join(NL()) + NL();
  if (rnd() < 0.3) text = '﻿' + text;
  out.positions.push({ text, acct: 'UXTEST123', src: 'option_positions.csv', ...run(() => P.parseOptionPositionsCsv(text, 'UXTEST123', 'option_positions.csv')) });
}
for (const text of ['', PCOLS.map(([, c]) => c).join(',')]) out.positions.push({ text, acct: 'UXTEST123', src: 's', ...run(() => P.parseOptionPositionsCsv(text, 'UXTEST123', 's')) });

// 手写的几份:字段都合法、只差一处(数量 0、文件内重复、表头一列出现两次)
{
  const good = { trade_time_utc: '2025-10-31T09:13:36Z', symbol: 'AAPL', sec_type: 'STK', currency: 'USD', side: 'BUY', size: '10', price: '150', exchange: 'X', commission: '1', order_id: '5', trade_id: 'g1' };
  const line = (o) => FCOLS.map((c) => o[c]).join(',');
  const text = [FCOLS.join(','), line(good), line({ ...good, trade_id: 'g2', size: '0' }), line(good), line({ ...good, trade_id: 'g3', price: '0' })].join('\n');
  out.fills.push({ text, acct: 'DUTEST001', ...run(() => F.parseFillsCsv(text, 'DUTEST001')) });
  const tgood = { time_et: '2026-07-20 10:23:05', date_et: '2026-07-20', symbol: 'SPX', asset: '期权', structure: '蝴蝶', action: '平仓', direction: '', qty: '1', net_price: '2', realized_pnl: '50', commission: '1', legs: 'L', order_ids: '1', note: '' };
  const tl = (o, cols = OCOLS) => cols.map((c) => o[c]).join(',');
  const ttext = [OCOLS.join(',') + ',symbol', tl(tgood) + ',ZZZ', tl(tgood) + ',ZZZ', tl({ ...tgood, qty: '0' }) + ',x'].join('\r\n');
  out.trades.push({ text: ttext, acct: 'DUTEST001', src: 's', ...run(() => O.parseOptionTradesCsv(ttext, 'DUTEST001', 's')) });
  const pgood = { open: '2026-07-20 10:23:05', symbol: 'SPX', structure: '蝴蝶', direction: '', qty: '1', expiry: '20260720', dte: '0', right: 'p', strikes: '1/2/3', center: '2', width: '1', ratio: '1:2:1', netPrice: '1', legs: 'L', exit: '持有到期', status: '已了结', closed: '', holdMin: '5', pnl: '10', commission: '1' };
  const pl = (o) => PCOLS.map(([k]) => q(o[k])).join(',');
  const ptext = [PCOLS.map(([, c]) => q(c)).join(',') + ',标的', pl(pgood) + ',QQQ', pl(pgood) + ',QQQ'].join('\n');
  out.positions.push({ text: ptext, acct: 'UXTEST123', src: 's', ...run(() => P.parseOptionPositionsCsv(ptext, 'UXTEST123', 's')) });
}
out.runtime = process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`;
writeFileSync(join(here, 'csv_imports.json'), JSON.stringify(out) + '\n');
console.log('csv_imports.json', Object.entries(out).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k}=${v.length}`).join(' '));
