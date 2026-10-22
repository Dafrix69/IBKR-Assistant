// 生成 leaders.json:engine-ts 的 leaders.ts(原模块现跑)。一池合成的日线(稳步上行的第二阶段、拼出来的 VCP 基底:放量突破 / 量不够 /
// 贴着枢轴 / 收缩中 / 第一次太深 / 最后一次不够紧 / 不是一次比一次浅、下跌、横盘、派发日扎堆、太短、坏根:串的价、缺高低、负数、缺量、只有 time),
// 在上面跑清洗、均线、RS 与百分位、趋势模板、收缩与 VCP、派发日与大盘方向、整池筛选(池子大于 / 小于 10 只、带 error 的成员、空日线)
// 与「今天新进第二阶段」(基准最新一根那天,有的成员没有那一天)。
//   ELECTRON_RUN_AS_NODE=1 …/Electron native/tests/fixtures/gen_leaders.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const L = await import(pathToFileURL(join(engine, 'dist/src/leaders.js')).href);

let seed = 0x1ead_e125;
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
const r2 = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------- 日线
function dates(n, end = '2026-10-16') {
  const out = [];
  let ms = Date.parse(`${end}T00:00:00Z`);
  while (out.length < n) {
    const d = new Date(ms).getUTCDay();
    if (d !== 0 && d !== 6) out.push(new Date(ms).toISOString().slice(0, 10));
    ms -= 86_400_000;
  }
  return out.reverse();
}
/** 收盘路径 → 日线(高低在收盘两边,量围着 base 走,乘 volMul) */
function barsOf(path, opts = {}) {
  const ds = dates(path.length, opts.end);
  return path.map((c, i) => {
    const close = r2(c);
    const spread = opts.spread ?? 0.012;
    const vm = opts.volMul ? opts.volMul(i, path.length) : 1;
    return { date: opts.stamp ? `${ds[i]} 16:00:00` : ds[i], open: close, high: r2(close * (1 + Math.abs(gauss()) * spread)), low: r2(close * (1 - Math.abs(gauss()) * spread)), close,
      volume: Math.round((opts.vol ?? 1e6) * vm * (1 + 0.3 * gauss() ** 2)) };
  });
}
function walk(n, start, drift, vol) {
  const out = [];
  let c = start;
  for (let i = 0; i < n; i += 1) { c = Math.max(0.5, c * (1 + drift + gauss() * vol)); out.push(c); }
  return out;
}
/** 上行之后的 VCP:回撤深度 depths(%),每次回到枢轴下方一点;最后 tail 根停在离枢轴 lastGap 处 */
function vcpPath(pre, depths, lastGap, descending, legBars = 14) {
  const out = walk(pre, 40, 0.004, 0.012);
  const pivot = out[out.length - 1] * 1.05;
  for (let k = 0; k < 8; k += 1) out.push(out[out.length - 1] + (pivot - out[out.length - 1]) / 4);
  let top = pivot;
  for (const [j, d] of depths.entries()) {
    const low = top * (1 - d / 100);
    // 每一次反弹的高点比上一次低一点(经典的 VCP):最后一个高点就是枢轴,站上它时还在基底最高点下面
    const next = descending ? pivot * (1 - 0.02 * (j + 1)) : pivot * 0.985;
    for (let k = 1; k <= legBars / 2; k += 1) out.push(top + (low - top) * (k / (legBars / 2)));
    for (let k = 1; k <= legBars / 2; k += 1) out.push(low + (next - low) * (k / (legBars / 2)));
    top = next;
  }
  for (let k = 0; k < 4; k += 1) out.push(top * (1 - 0.01 - 0.002 * k));
  out.push(top * (1 + lastGap / 100));
  return out;
}
const series = [];
const add = (bars, kind) => { series.push({ kind, bars }); return series.length - 1; };
for (let i = 0; i < 14; i += 1) add(barsOf(walk(pick([260, 280, 300, 320]), pick([20, 50, 120]), pick([0.0015, 0.002, 0.003]), 0.012), { stamp: rnd() < 0.2 }), 'up');
for (const [depths, gap, volEnd] of [[[25, 12, 6], 1.5, 3], [[25, 12, 6], 1.2, 1], [[22, 10, 4], -2, 0.5], [[22, 10, 4], -12, 0.5], [[60, 30, 10], -3, 1],
  [[30, 20, 18], -3, 1], [[10, 20, 5], -3, 1], [[18], -2, 1], [[20, 9, 4, 2], 2, 2], [[25, 12, 6], -4, 1.2]]) {
  for (let r = 0; r < 3; r += 1) {
    const path = vcpPath(pick([200, 230, 260]), depths, gap, r > 0);
    add(barsOf(path, { spread: 0.004, volMul: (i, n) => (i === n - 1 ? volEnd : i > n - 25 ? 0.6 : 1) }), 'vcp');
  }
}
for (let i = 0; i < 8; i += 1) add(barsOf(walk(pick([210, 260, 300]), 100, pick([-0.002, -0.001, 0]), pick([0.01, 0.02]))), 'down');
// 派发日扎堆:最后 25 根里跌 0.3% 放量的日子
for (let i = 0; i < 4; i += 1) {
  const p = walk(260, 100, 0.002, 0.008);
  const b = barsOf(p);
  for (let k = b.length - 24; k < b.length; k += 3) { b[k].close = r2(b[k - 1].close * 0.995); b[k].volume = b[k - 1].volume * 2; b[k].low = Math.min(b[k].low, b[k].close); b[k].high = Math.max(b[k].high, b[k].close); }
  if (i === 1) for (let k = b.length - 5; k < b.length; k += 1) { b[k].close = r2(b[k].close * 1.08); b[k].high = Math.max(b[k].high, b[k].close); }
  add(b, 'dist');
}
for (const n of [0, 1, 2, 30, 59, 60, 61, 150, 199, 200, 221, 222, 252, 253]) add(barsOf(walk(n, 50, 0.002, 0.01)), 'short');
for (let i = 0; i < 6; i += 1) {
  const b = barsOf(walk(270, 60, 0.002, 0.01)).map((x) => ({ ...x }));
  for (let k = 0; k < 12; k += 1) {
    const j = Math.floor(rnd() * b.length);
    const kind = pick(['strClose', 'blankClose', 'noHigh', 'negLow', 'noVol', 'strVol', 'zeroClose', 'timeOnly', 'bool', 'nanHigh', 'negVol', 'lowHigh', 'highLow']);
    if (kind === 'strClose') b[j].close = String(b[j].close);
    else if (kind === 'blankClose') b[j].close = ' ';
    else if (kind === 'noHigh') delete b[j].high;
    else if (kind === 'negLow') b[j].low = -5;
    else if (kind === 'noVol') delete b[j].volume;
    else if (kind === 'strVol') b[j].volume = '12345';
    else if (kind === 'zeroClose') b[j].close = 0;
    else if (kind === 'timeOnly') { b[j].time = b[j].date; delete b[j].date; }
    else if (kind === 'bool') b[j].high = true;
    else if (kind === 'nanHigh') b[j].high = 'NaN';
    else if (kind === 'lowHigh') b[j].high = r2(b[j].close * 0.9);
    else if (kind === 'highLow') b[j].low = r2(b[j].close * 1.1);
    else b[j].volume = -3;
  }
  add(b, 'dirty');
}
// 写明的形状(knots:[下标, 价, P 高点 / T 低点]):相等的两个高点、正好 1.5% 的一段、相等的两次回撤、量正好 1.4 倍、正好离枢轴 −5%
function hand(n, knots, opts = {}) {
  const ds = dates(n);
  const bars = [];
  for (let i = 0; i < n; i += 1) {
    let k = knots.findIndex(([at]) => at >= i);
    if (k < 0) k = knots.length - 1;
    const [at, v, kind] = knots[k];
    let mid;
    if (at === i) mid = null;
    else if (k === 0) mid = v - 1;
    else { const [a0, v0] = knots[k - 1]; mid = v0 + ((v - v0) * (i - a0)) / (at - a0); }
    if (i > knots[knots.length - 1][0]) mid = opts.tail ?? knots[knots.length - 1][1];
    const vol = opts.vol ? opts.vol(i, n) : 1000;
    if (mid === null) bars.push(kind === 'P' ? { date: ds[i], high: v, low: v - 0.02, close: v - 0.01, volume: vol } : { date: ds[i], high: v + 0.02, low: v, close: v + 0.01, volume: vol });
    else bars.push({ date: ds[i], high: mid, low: mid, close: mid, volume: vol });
  }
  if (opts.last) Object.assign(bars[n - 1], opts.last);
  return bars;
}
const handStarts = {};
const addHand = (bars, start) => { const i = add(bars, 'hand'); handStarts[i] = start; return i; };
addHand(hand(80, [[0, 90, 'T'], [10, 110, 'P'], [20, 85, 'T'], [30, 95, 'P'], [36, 88, 'T'], [45, 95, 'P'], [52, 90, 'T'], [60, 93, 'P']], { tail: 92 }), 10);
addHand(hand(80, [[0, 90, 'T'], [10, 110, 'P'], [20, 90, 'T'], [30, 100, 'P'], [37, 98.5, 'T'], [45, 99, 'P'], [52, 95, 'T'], [60, 97, 'P']], { tail: 96 }), 10);
addHand(hand(80, [[0, 70, 'T'], [10, 100, 'P'], [20, 80, 'T'], [30, 95, 'P'], [40, 76, 'T'], [50, 90, 'P'], [56, 85.5, 'T'], [62, 88, 'P']], { tail: 87 }), 10);
const vcpKnots = [[0, 60, 'T'], [10, 100, 'P'], [20, 80, 'T'], [30, 95, 'P'], [40, 85.5, 'T'], [50, 90, 'P'], [56, 85.5, 'T'], [62, 88, 'P']];
addHand(hand(80, vcpKnots, { tail: 87, last: { close: 91, high: 91.1, low: 87, volume: 1400 } }), 10);
addHand(hand(80, vcpKnots, { tail: 87, last: { close: 91, high: 91.1, low: 87, volume: 1399 } }), 10);
const vcpKnots2 = vcpKnots.slice(0, 7);
addHand(hand(80, vcpKnots2, { tail: 86, last: { close: 85.5, high: 85.6, low: 85.5, volume: 900 } }), 10);
addHand(hand(80, vcpKnots2, { tail: 86, last: { close: 85.51, high: 85.6, low: 85.51, volume: 900 } }), 10);
// 派发日:前一天没有量、之后正好涨回 5%
{
  const b = barsOf(walk(80, 100, 0, 0.002));
  b[74].close = 101; b[75].close = 100; b[75].volume = b[74].volume * 2; b[78].close = 105; b[79].close = 104;
  for (const x of b) { x.high = Math.max(x.high, x.close); x.low = Math.min(x.low, x.close); }
  add(b, 'hand');
  const c = barsOf(walk(80, 100, 0, 0.002));
  c[70].volume = 0; c[71].close = r2(c[70].close * 0.99); c[71].volume = 5e6;
  for (const x of c) { x.high = Math.max(x.high, x.close); x.low = Math.min(x.low, x.close); }
  add(c, 'hand');
}
// 最后一根正好收在之前一年的最高收盘、量是均量的 3 倍
{
  const b = barsOf(walk(270, 50, 0.002, 0.01));
  const top = Math.max(...b.slice(-252, -1).map((x) => x.close));
  b[b.length - 1] = { ...b[b.length - 1], close: top, high: top + 0.5, low: top - 0.5, volume: 3e6 };
  add(b, 'hand');
}
// 一年都一个价、量全是 0
add(dates(270).map((date) => ({ date, high: 10, low: 10, close: 10, volume: 0 })), 'flat');

const out = { series: series.map((s) => enc(s.bars)), kinds: series.map((s) => s.kind), clean: [], sma: [], rs: [], ratings: [], template: [], vcp: [], regime: [], screens: [] };

// ---------------------------------------------------------------- 逐个函数
// 干净的那些清洗之后只是换个形状:比整份的只挑会出差错的几类,别的比根数与首尾
for (const [i, s] of series.entries()) {
  const full = ['dirty', 'short', 'flat'].includes(s.kind);
  out.clean.push({ s: i, full, ...run(() => { const c = L.cleanDaily(s.bars); return full ? c : [c.length, c[0], c[c.length - 1]]; }) });
}
out.clean.push({ raw: [null], ...run(() => L.cleanDaily([null])) }, { raw: [5, 'x', {}], ...run(() => L.cleanDaily([5, 'x', {}])) });
for (let i = 0; i < 200; i += 1) {
  const values = Array.from({ length: Math.floor(rnd() * 12) }, () => r2(rnd() * 100));
  const n = pick([1, 2, 3, 5, 10, 0]);
  const end = pick([undefined, values.length - 1, values.length - 2, values.length, 0, -1, 4]);
  out.sma.push({ values, n, end: enc(end), out: enc(L.smaAt(values, n, end)) });
}
for (const [i, s] of series.entries()) {
  const closes = L.cleanDaily(s.bars).map((b) => b.close);
  out.rs.push({ s: i, out: enc(L.rsScore(closes)) });
}
for (let i = 0; i < 80; i += 1) {
  const scores = Array.from({ length: Math.floor(rnd() * 15) }, () => (rnd() < 0.2 ? null : pick([r2(gauss() * 30), 10, 10, -5])));
  out.ratings.push({ scores: enc(scores), out: enc(L.ratings(scores)) });
}
for (let i = 0; i < 400; i += 1) {
  const close = pick([100, 50.5, 12.345, 300]);
  const m = () => (rnd() < 0.15 ? null : r2(close * (1 + gauss() * 0.1)));
  const t = { close, ma50: m(), ma150: m(), ma200: m(), ma200Months: pick([null, 0, 1, 3, 4, 5]), high52: r2(close * (1 + Math.abs(gauss()) * 0.3)), low52: r2(close * (1 - Math.abs(gauss()) * 0.5)),
    fullYear: rnd() < 0.7, rsRating: pick([null, 50, 70, 69, 99, 1]), rsVsBench: pick([null, 0, 3.21, -1.5, 10, -0]), universe: pick([1, 5, 9, 10, 25]) };
  out.template.push({ t: enc(t), out: enc(L.trendTemplate(t)) });
}
for (const t of [{ close: 130, ma50: 120, ma150: 110, ma200: 100, ma200Months: 2, high52: 140, low52: 100, fullYear: true, rsRating: 70, rsVsBench: 0.5, universe: 10 },
  { close: 75, ma50: 70, ma150: 60, ma200: 50, ma200Months: 5, high52: 100, low52: 50, fullYear: false, rsRating: null, rsVsBench: 0.5, universe: 12 },
  { close: 129.99, ma50: 120, ma150: 110, ma200: 100, ma200Months: 6, high52: 140, low52: 100, fullYear: true, rsRating: 71, rsVsBench: 0, universe: 3 }]) {
  out.template.push({ t: enc(t), out: enc(L.trendTemplate(t)) });
}
for (const [i, s] of series.entries()) {
  const bars = L.cleanDaily(s.bars);
  const starts = [0, Math.max(0, bars.length - 130), Math.max(0, bars.length - 60), Math.floor(bars.length / 2), ...(handStarts[i] !== undefined ? [handStarts[i]] : [])];
  out.vcp.push({ s: i, vcp: enc(L.detectVcp(bars)), contractions: enc(starts.map((st) => ({ start: st, ...L.contractions(bars, st) }))), dist: enc(L.distributionDays(bars)) });
  const symbol = pick(['SPY', 'QQQ', 'XLK']);
  out.regime.push({ s: i, symbol, ...run(() => L.marketRegime(symbol, s.bars)) });
}

// ---------------------------------------------------------------- 整池
const tags = [undefined, '', '半导体', 'AI'];
for (let k = 0; k < 30; k += 1) {
  const size = pick([0, 1, 3, 8, 9, 10, 12, 18]);
  const members = [];
  const used = new Set();
  for (let j = 0; j < size; j += 1) {
    const s = Math.floor(rnd() * series.length);
    const sym = pick(['NVDA', 'AMD', 'AVGO', 'MU', 'TSM', 'ASML', 'SMCI', 'ARM', 'QCOM', 'INTC', 'MRVL', 'LRCX', 'KLAC', 'AMAT', 'ON', 'TXN', 'nvda', 'Äpfel', '中芯']) + (used.size % 3 ? '' : String(j));
    if (used.has(sym)) continue;
    used.add(sym);
    const m = { symbol: sym, s, bars: '__ref__' };
    const tag = pick(tags);
    if (tag !== undefined) m.tag = tag;
    if (rnd() < 0.3) m.company = pick(['', 'NVIDIA', '英伟达']);
    if (rnd() < 0.1) m.error = pick([null, '超时', '']);
    if (rnd() < 0.05) m.empty = true;
    members.push(m);
  }
  const bench = pick([...series.keys()].filter((i) => series[i].kind !== 'dirty'));
  // 让一部分成员的最新一根和基准不是同一天
  const lag = rnd() < 0.3;
  const realMembers = members.map((m) => {
    let bars = m.empty ? [] : series[m.s].bars;
    if (lag && rnd() < 0.4) bars = bars.slice(0, -1);
    const r = { symbol: m.symbol, bars };
    if ('tag' in m) r.tag = m.tag;
    if ('company' in m) r.company = m.company;
    if ('error' in m) r.error = m.error;
    return r;
  });
  const benchmark = pick(['SPY', 'QQQ']);
  const res = run(() => L.screenLeaders(realMembers, series[bench].bars, benchmark));
  const fresh = res.out ? run(() => L.newStage2(realMembers, series[bench].bars, benchmark, L.screenLeaders(realMembers, series[bench].bars, benchmark).rows)) : { out: null };
  out.screens.push({ members: realMembers.map((m, j) => ({ ...enc({ ...m, bars: undefined }), bars: members[j].empty ? -1 : members[j].s, trim: m.bars.length !== (members[j].empty ? 0 : series[members[j].s].bars.length) })),
    bench, benchmark, ...res, fresh });
}

// 写明的池子:正好 10 只(满 10 只才排百分位)、其中一只最后一个月放量(第二阶段、VCP 没成形、没缩量)
{
  const ups = [...series.keys()].filter((i) => series[i].kind === 'up');
  const scored = ups.map((i) => [i, L.rsScore(L.cleanDaily(series[i].bars).map((b) => b.close)) ?? -1e9]).sort((a, b) => b[1] - a[1]);
  // 最强的那只最后 10 根往下走一点、放量:还在第二阶段,有了一小段基底(VCP 没成形、没缩量)
  const best = scored[0][0];
  const src = series[best].bars;
  const loud = src.map((b, j, all) => {
    const back = j - (all.length - 11);
    if (back <= 0) return { ...b };
    const close = r2(src[all.length - 11].close * (1 - 0.003 * back));
    return { ...b, close, high: r2(close * 1.002), low: r2(close * 0.998), volume: b.volume * 4 };
  });
  const li = add(loud, 'hand');
  out.series.push(enc(loud));
  out.kinds.push('hand');
  const pool = [...scored.slice(1, 10).map(([i]) => i), li];
  const realMembers = pool.map((i, j) => ({ symbol: `M${j}`, bars: series[i].bars }));
  const bench = [...series.keys()].find((i) => series[i].kind === 'down');
  const res = run(() => L.screenLeaders(realMembers, series[bench].bars, 'SPY'));
  const fresh = run(() => L.newStage2(realMembers, series[bench].bars, 'SPY', L.screenLeaders(realMembers, series[bench].bars, 'SPY').rows));
  out.screens.push({ members: realMembers.map((m, j) => ({ symbol: m.symbol, bars: pool[j], trim: false })), bench, benchmark: 'SPY', ...res, fresh });
}

writeFileSync(join(here, 'leaders.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
console.log('leaders.json', Object.entries(out).map(([k, v]) => `${k}=${v.length}`).join(' '));
