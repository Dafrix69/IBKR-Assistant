// 生成 stockreview.json:engine-ts 的 stockreview.ts(原模块现跑)把合成的股票逐笔成交切成一段段持仓(加仓、分批减仓、打穿反向、
// 同一订单几笔并成一次出手、期初仓位按当前持仓反推 / 不知道持仓时按"刚好够卖"),再对每一段复盘(分钟线 / 日线、
// 成交价落在 K 线外、持有期的浮盈浮亏、平仓后的走势、超过 240 根时抽稀)。账号全是假的。输入先过一遍 JSON。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_stockreview.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const S = await import(pathToFileURL(join(engine, 'dist/src/stockreview.js')).href);
const T = await import(pathToFileURL(join(engine, 'dist/src/tradereview.js')).href);

let seed = 0x5e0c_4b11;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
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
const rt = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const run = (f) => { try { return { out: enc(f()) }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };
const pad = (n) => String(n).padStart(2, '0');

const out = { runtime: '', windows: [], groups: [], reviews: [] };

// ---------------------------------------------------------------- stockWindow
const dayList = (n, perDay, daily) => {
  const bars = [];
  for (let d = 0; d < n; d += 1) {
    const dt = new Date(Date.UTC(2026, 8, 1 + d));
    const date = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
    if (daily) bars.push({ date });
    else for (let k = 0; k < perDay; k += 1) bars.push({ time: `${date} ${pad(9 + Math.floor(k / 4))}:${pad((k % 4) * 15)}` });
  }
  return bars;
};
for (const [n, per, daily] of [[1, 26, false], [3, 26, false], [10, 26, false], [12, 1, true], [60, 1, true], [2, 4, false], [7, 3, false], [8, 90, false], [3, 120, false], [6, 45, false]]) {
  const bars = dayList(n, per, daily);
  const cases = [];
  for (let i = 0; i < 16; i += 1) {
    const a = int(0, bars.length - 1), b = rnd() < 0.3 ? a : int(a, bars.length - 1);
    cases.push({ a, b, out: S.stockWindow(bars, a, b) });
  }
  out.windows.push({ bars, cases });
}

// ---------------------------------------------------------------- 成交 → 持仓段
const SYMS = ['AAPL', 'nvda', 'TSLA', ''];
const ACCTS = ['DUTEST001', 'UXTEST123', 'DU12', ''];
let execN = 0;
function fillsFor(nOrders, opts = {}) {
  const fills = [];
  let t = Date.UTC(2026, 8, 14, 14, 0) + int(0, 3) * 86400e3;
  let perm = int(100, 900);
  for (let i = 0; i < nOrders; i += 1) {
    t += pick([60e3, 300e3, 3600e3, 86400e3, 0]);
    perm += pick([1, 1, 1, 0]);
    const side = pick(opts.sides ?? ['BOT', 'SLD', 'BUY', 'SELL', 'bot', 'X']);
    const parts = rnd() < 0.3 ? 2 : 1;
    for (let p = 0; p < parts; p += 1) {
      const when = t + p * pick([1000, -1000, 0]);
      const d = new Date(when);
      const style = pick(['utc', 'utc', 'et', 'iso', 'num']);
      const time = style === 'utc' ? `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
        : style === 'et' ? T.etKey(when, false) : style === 'iso' ? d.toISOString() : when;
      fills.push({ exec_id: `e${(execN += 1)}`, time, account_id: opts.account ?? 'DUTEST001', side, shares: pick(opts.shares ?? [100, 50, 25, 10, 1, 0.5, 33.3]),
        price: Math.round((150 + gauss() * 5) * 100) / 100, perm_id: perm, order_id: int(1, 20), commission: pick([1, 0.35, null, '0.5', undefined]),
        contract: { secType: 'STK', symbol: opts.symbol ?? 'AAPL', currency: pick(['USD', 'USD', '', undefined]) } });
    }
  }
  return fills;
}
const holdingSets = (fills) => {
  const keys = [...new Set(fills.map((f) => `${f.account_id}|${String(f.contract?.symbol ?? '').toUpperCase()}`))];
  return [null, undefined, {}, Object.fromEntries(keys.map((k) => [k, pick([0, 100, -50, 25, '100', null, 'x', 1e-12])]))];
};
const groupCases = [];
for (let i = 0; i < 140; i += 1) {
  let fills = [];
  const nSeg = int(1, 3);
  for (let j = 0; j < nSeg; j += 1) fills.push(...fillsFor(int(1, 7), { account: pick(ACCTS), symbol: pick(SYMS), sides: rnd() < 0.5 ? ['BOT', 'SLD'] : undefined, shares: rnd() < 0.5 ? [100, 50] : undefined }));
  if (rnd() < 0.2) fills.push({ exec_id: 'opt', time: '20260914-15:00:00', side: 'BOT', shares: 1, price: 2, contract: { secType: 'OPT', symbol: 'AAPL' } });
  if (rnd() < 0.15) fills.push({ exec_id: 'bad', time: 'nope', side: 'BOT', shares: 1, price: 2, contract: { secType: 'STK', symbol: 'AAPL' } },
    { exec_id: 'bad2', time: '20260914-15:00:00', side: 'BOT', shares: 0, price: 2, contract: { secType: 'STK', symbol: 'AAPL' } },
    { exec_id: 'bad3', time: '20260914-15:00:00', side: 'BOT', shares: 1, price: '', contract: { secType: 'STK', symbol: 'AAPL' } });
  if (rnd() < 0.2) fills.sort(() => (rnd() < 0.5 ? -1 : 1));
  const accounts = pick([[], [{ account_id: 'DUTEST001', alias: '模拟', is_paper: true }], [{ account_id: 'UXTEST123', alias: '实盘一', is_paper: false }, { account_id: 'UXTEST123', alias: '实盘二' }], [0]]);
  const f = rt(fills);
  const holdings = pick(holdingSets(f));
  groupCases.push({ fills: f, accounts, holdings });
}
// 写明的几种:多 100 卖 150 打穿、零碎到 EPS 以下、同一 permId 隔着别的订单
{
  const mk = (side, shares, min, perm, price = 100) => ({ exec_id: `w${(execN += 1)}`, time: `20260915-${pad(14 + Math.floor(min / 60))}:${pad(min % 60)}:00`, account_id: 'DUTEST001', side, shares, price, perm_id: perm, contract: { secType: 'STK', symbol: 'MSFT' } });
  groupCases.push({ fills: [mk('BOT', 100, 0, 1), mk('SLD', 150, 5, 2, 101), mk('BOT', 50, 9, 3, 99)], accounts: [], holdings: null });
  groupCases.push({ fills: [mk('BOT', 100, 0, 1), mk('SLD', 150, 5, 2, 101)], accounts: [], holdings: { 'DUTEST001|MSFT': -50 } });
  groupCases.push({ fills: [mk('SLD', 40, 0, 1), mk('SLD', 60, 3, 1), mk('BOT', 10, 5, 2)], accounts: [], holdings: null });
  groupCases.push({ fills: [mk('BOT', 1e-12, 0, 1)], accounts: [], holdings: { 'DUTEST001|MSFT': 10 } });
  groupCases.push({ fills: [mk('BOT', 10, 0, 7), mk('BOT', 10, 1, 8), mk('BOT', 10, 2, 7), mk('SLD', 30, 3, 9)], accounts: [], holdings: { 'DUTEST001|MSFT': 0 } });
  groupCases.push({ fills: [mk('BOT', 10, 0, 7), mk('SLD', 10, 1, 7), mk('BOT', 10, 2, 7), mk('SLD', 10, 3, 7)], accounts: [], holdings: null });
  groupCases.push({ fills: [null], accounts: [], holdings: null });
  groupCases.push({ fills: [], accounts: [null], holdings: null });
}
const trips = [];
for (const c of groupCases) {
  const res = run(() => S.groupStockTrips(c.fills, c.accounts, c.holdings));
  out.groups.push({ fills: c.fills, accounts: c.accounts, holdings: enc(c.holdings), ...res });
  if (res.out) trips.push(...S.groupStockTrips(c.fills, c.accounts, c.holdings));
}

// ---------------------------------------------------------------- 复盘
function barsAround(startMs, endMs, step, daily, center) {
  const bars = [];
  let s = center;
  const from = startMs - int(5, 60) * step, to = endMs + int(0, 40) * step;
  for (let t = from; t <= to; t += step) {
    s += gauss() * 0.8;
    const c = Math.round(s * 100) / 100;
    const time = daily ? T.etKey(t, true) : T.etKey(t, false);
    if (bars.length && (daily ? bars[bars.length - 1].date : bars[bars.length - 1].time) === time) continue;
    const bar = daily ? { date: time } : { time };
    Object.assign(bar, { high: Math.round((c + rnd()) * 100) / 100, low: Math.round((c - rnd()) * 100) / 100, close: c });
    if (rnd() < 0.03) bar.high = null;
    bars.push(bar);
  }
  return bars;
}
let r = 0;
for (const trip of trips) {
  if (r >= 150) break;
  const times = [...trip.entries, ...trip.exits].map((e) => T.parseWhen(e.time)).filter((x) => x !== null);
  if (!times.length) continue;
  r += 1;
  const lo = Math.min(...times), hi = Math.max(...times);
  const daily = hi - lo > 3 * 86400e3 ? rnd() < 0.7 : rnd() < 0.15;
  const step = daily ? 86400e3 : pick([60e3, 300e3, 900e3]);
  const tf = daily ? '1d' : step === 60e3 ? '1m' : step === 300e3 ? '5m' : '15m';
  if (!daily && (hi - lo) / step > 1200) continue;
  const center = trip.avg_entry ?? trip.avg_exit ?? 150;
  let bars = barsAround(lo, hi, step, daily, center);
  const t2 = rt(trip);
  const tweak = pick([null, null, null, null, 'kind', 'noEntries', 'late', 'nullClose']);
  if (tweak === 'kind') t2.kind = 'fly';
  if (tweak === 'noEntries') { t2.entries = []; t2.exits = []; }
  if (tweak === 'late') bars = bars.filter((b) => (b.time ?? b.date) > T.etKey(lo + step * 3, daily));
  if (tweak === 'nullClose') bars[Math.floor(bars.length / 2)].close = null;
  const now = Date.UTC(2026, 9, 1);
  out.reviews.push({ trip: t2, bars, tf, now, ...run(() => S.reviewStock(t2, bars, tf, now)) });
}
{
  const base = rt(trips.find((t) => t.entries.length && t.exits.length && t.status === 'closed'));
  const bars = barsAround(T.parseWhen(base.entries[0].time) - 3600e3, T.parseWhen(base.exits[base.exits.length - 1].time) + 3600e3, 60e3, false, 150);
  for (const [name, mut] of [['entries5', (t) => { t.entries = 5; }], ['exitsObj', (t) => { t.exits = {}; }], ['nullEntry', (t) => { t.entries = [null]; }], ['noBars', null],
    ['short', (t) => { t.side = 'SHORT'; }], ['strings', (t) => { t.avg_entry = null; t.carried = true; t.opening_assumed = true; }], ['openQty', (t) => { t.status = 'open'; delete t.open_qty; }]]) {
    const t = rt(base);
    if (mut) mut(t);
    const b = name === 'noBars' ? [] : bars;
    out.reviews.push({ name, trip: t, bars: b, tf: '1m', now: 0, ...run(() => S.reviewStock(t, b, '1m', 0)) });
  }
  const noPrice = rt(base); noPrice.entries[0].price = null;
  out.reviews.push({ name: 'noFirstPrice', trip: noPrice, bars, tf: '1m', now: 0, ...run(() => S.reviewStock(noPrice, bars, '1m', 0)) });
  // 手搭的边界:进场位置恰好 0.7、兑现恰好 0.6、区间不到 1、出场之后一动不动
  const mk = (side, shares, min, perm, price) => ({ exec_id: `h${perm}`, time: `20260915-${pad(14 + Math.floor(min / 60))}:${pad(min % 60)}:00`, account_id: 'DUTEST001', side, shares, price, perm_id: perm, contract: { secType: 'STK', symbol: 'IBM' } });
  const hb = (hiF, loF, closeF) => Array.from({ length: 41 }, (_, j) => { const m = 590 + j; return { time: `2026-09-15 ${pad(Math.floor(m / 60))}:${pad(m % 60)}`, high: hiF(m), low: loF(m), close: closeF(m) }; });
  for (const [name, entryPx, exitPx, hiF, loF] of [
    ['pos07', 103, 106, (m) => (m === 602 ? 110 : m > 605 ? 106 : 104), (m) => (m === 603 ? 100 : m > 605 ? 106 : 102)],
    ['cap06', 100, 106, (m) => (m === 602 ? 110 : m > 605 ? 107 : 104), (m) => (m === 603 ? 100 : m > 605 ? 101 : 102)],
    ['tinyRange', 100.1, 100.15, (m) => 100.2, (m) => 100],
    ['flatAfter', 103, 106, (m) => (m > 605 ? 106 : 104), (m) => (m > 605 ? 106 : 102)],
  ]) {
    const trips2 = S.groupStockTrips([mk('BOT', 10, 0, 1, entryPx), mk('SLD', 10, 5, 2, exitPx)], [], null);
    const b = hb(hiF, loF, (m) => (hiF(m) + loF(m)) / 2);
    out.reviews.push({ name, trip: trips2[0], bars: b, tf: '1m', now: 0, ...run(() => S.reviewStock(trips2[0], b, '1m', 0)) });
  }
  {
    const pyr = S.groupStockTrips([mk('BOT', 10, 0, 11, 100), mk('SLD', 5, 2, 12, 101), mk('BOT', 10, 4, 13, 102), mk('SLD', 15, 8, 14, 103)], [], null);
    const b = hb(() => 104, () => 99, () => 101);
    out.reviews.push({ name: 'pyramid', trip: pyr[0], bars: b, tf: '1m', now: 0, ...run(() => S.reviewStock(pyr[0], b, '1m', 0)) });
    const fl = S.groupStockTrips([mk('BOT', 10, 0, 21, 100), mk('SLD', 10, 20, 22, 100.5)], [], null);
    const b2 = hb((m) => 100.6, (m) => 99.9, (m) => (m > 600 ? 100.05 : 100));
    out.reviews.push({ name: 'flat005', trip: fl[0], bars: b2, tf: '1m', now: 0, ...run(() => S.reviewStock(fl[0], b2, '1m', 0)) });
  }
  // 超过 240 根:抽稀
  const longBars = barsAround(T.parseWhen(base.entries[0].time) - 400 * 60e3, T.parseWhen(base.exits[base.exits.length - 1].time) + 400 * 60e3, 60e3, false, 150);
  out.reviews.push({ name: 'thin', trip: base, bars: longBars, tf: '1m', now: 0, ...run(() => S.reviewStock(base, longBars, '1m', 0)) });
}

out.runtime = process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`;
writeFileSync(join(here, 'stockreview.json'), JSON.stringify(out) + '\n');
console.log('stockreview.json', Object.entries(out).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k}=${v.length}`).join(' '));
