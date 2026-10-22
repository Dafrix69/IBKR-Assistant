// 生成 priceaction.json:engine-ts 的 priceaction.ts(原模块现跑)——黄金基线的 4 个场景(含事实块、高周期摘要)与 agreement,
// 加上合成的 K 线:分钟线 / 日线、趋势 / 震荡 / 平盘、有没有量、最后一根走没走完(实时 / 延迟 / 说不准的行情档、缓存里取的、
// 盘前盘后、读不懂的时间戳)、各种周期名(含不认识的与 Object.prototype 上的名字)、根数不够;以及事实块拼上高周期与同向判断。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_priceaction.mjs <编过的 engine-ts 目录>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hunt, mutantOf } from './mutant_hunt.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const P = await import(pathToFileURL(join(engine, 'dist/src/priceaction.js')).href);

let seed = 0x9a1c_7e55;
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

const golden = JSON.parse(readFileSync(join(engine, 'baseline/golden/priceaction.json'), 'utf8'));
const store = JSON.parse(readFileSync(join(engine, 'baseline/golden/_bars.json'), 'utf8'));
const resolve = (v) => (v && typeof v === 'object' && !Array.isArray(v) && typeof v.$bars === 'string' ? store[v.$bars] : v);
const keepKeys = ['time', 'date', 'open', 'high', 'low', 'close', 'volume'];
const trim = (rows) => rows.map((b) => Object.fromEntries(keepKeys.filter((k) => k in b).map((k) => [k, b[k]])));

// clock:数(epoch 毫秒)或 PaClock;夹具里写成 {kind: 'num' | 'clock' | 'none', ...}
const clockOf = (c) => (c.kind === 'none' ? null : c.kind === 'num' ? c.epochMs : { epochMs: c.epochMs, ...(c.barsAsOfMs !== undefined ? { barsAsOfMs: c.barsAsOfMs } : {}),
  ...(c.feed !== undefined ? { feed: c.feed } : {}), ...(c.extendedSession !== undefined ? { extendedSession: c.extendedSession } : {}) });

const out = { golden: [], agreement: [], sets: [], cases: [], parse: [], closeAt: [], age: [], bias: [], hunted: [] };
const byName = {};
for (const c of golden.cases) {
  const rows = trim(resolve(c.rows));
  const set = out.sets.push(rows) - 1;
  const clock = { kind: 'num', epochMs: Date.parse(c.now) };
  const res = run(() => P.analyze(rows, c.symbol, c.timeframe, P.SWING_STRENGTH, clockOf(clock), c.extended_hours));
  const entry = { name: c.name, set, symbol: c.symbol, timeframe: c.timeframe, clock, extended: c.extended_hours, ...res };
  if (res.out) {
    const r = P.analyze(rows, c.symbol, c.timeframe, P.SWING_STRENGTH, clockOf(clock), c.extended_hours);
    entry.facts = P.factsText(r);
    entry.htf = enc(P.htfSummary(r));
    byName[c.name] = set;
  }
  out.golden.push(entry);
}
{
  const now = Date.parse(golden.cases[0].now);
  const up = P.analyze(out.sets[byName.uptrend], 'UP', '5m', P.SWING_STRENGTH, now);
  const down = P.analyze(out.sets[byName.downtrend], 'DN', '5m', P.SWING_STRENGTH, now);
  const summaries = { uptrend: P.htfSummary(up), downtrend: P.htfSummary(down) };
  for (const a of golden.agreement) out.agreement.push({ b: a.b, out: enc(P.agreement(up, a.b === null ? null : summaries[a.b])), now, upSet: byName.uptrend, downSet: byName.downtrend });
}

// ---------------------------------------------------------------- 合成 K 线
const pad = (n) => String(n).padStart(2, '0');
const etStamp = (ms) => {
  // 美东墙钟(夏令时 -4 / 冬令时 -5;合成的日子都在 2026 年 3 月 8 日之后、11 月 1 日之前,就是 -4)
  const d = new Date(ms - 4 * 3600_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
function synth(n, o) {
  const rows = [];
  let px = o.start, t = o.t0;
  for (let i = 0; i < n; i += 1) {
    const drift = o.trend * o.vol + Math.sin(i / o.cycle) * o.vol * o.wave;
    const open = px * (1 + gauss() * o.vol * o.gap);
    const close = o.flat ? open : open * (1 + gauss() * o.vol + drift);
    const hi = Math.max(open, close) * (1 + Math.abs(gauss()) * o.vol * 0.6), lo = Math.min(open, close) * (1 - Math.abs(gauss()) * o.vol * 0.6);
    const r = (x) => (o.round ? Math.round(x * 100) / 100 : x);
    const row = { open: r(open), high: r(hi), low: r(lo), close: r(close) };
    const stamp = o.daily ? etStamp(t).slice(0, 10) : etStamp(t);
    row[o.timeKey] = o.seconds && !o.daily ? `${stamp}:00` : stamp;
    if (o.volume) row.volume = rnd() < 0.03 ? pick([0, null, 'x', -5]) : Math.round(Math.exp(gauss() * 0.4 + (i === n - 1 && rnd() < 0.4 ? 1.5 : 0)) * 1e4);
    rows.push(row);
    t += o.daily ? 86_400_000 * (rnd() < 0.2 ? 3 : 1) : o.step * 1000;
    px = close;
  }
  return rows;
}
const tfSeconds = { '1m': 60, '2m': 120, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
for (let i = 0; i < 70; i += 1) {
  const tf = pick(['1m', '5m', '5m', '15m', '1h', '1d', '1w', '1d']);
  const daily = tf === '1d' || tf === '1w';
  const o = {
    start: pick([5, 40, 120, 600, 5800]), vol: pick([0.0008, 0.002, 0.006, 0.02]), trend: pick([0, 0, 0.3, -0.3, 0.8, -0.8]), cycle: pick([3, 6, 12]), wave: pick([0, 0.5, 1.5]),
    gap: pick([0.05, 0.3, 2]), flat: rnd() < 0.04, round: rnd() < 0.5, daily, timeKey: rnd() < 0.85 ? 'time' : 'date', seconds: rnd() < 0.1, volume: rnd() < 0.85,
    t0: Date.UTC(2026, 7, 10 + Math.floor(rnd() * 3), 13, 30), step: tfSeconds[tf] ?? 300,
  };
  const n = pick([25, 30, 31, 45, 60, 61, 90, 150]);
  const rows = synth(n, o);
  if (rnd() < 0.04) rows[Math.floor(rnd() * n)].time = pick(['bad', '', '2026-08-12T10:00']);
  out.sets.push(rows);
}
const lastClose = (rows, tf, ext) => P.barCloseEpochMs(String(rows[rows.length - 1].time ?? rows[rows.length - 1].date ?? ''), tf, ext);
for (let i = 0; i < 75; i += 1) {
  const set = out.golden.length + Math.floor(rnd() * (out.sets.length - out.golden.length)) - (rnd() < 0.08 ? out.golden.length : 0);
  const rows = out.sets[Math.max(0, set)];
  const tf = rnd() < 0.08 ? pick(['', 'bogus', 'toString', '3m', '__proto__', 'constructor']) : pick(['1m', '5m', '15m', '1h', '1d', '1w', '30m', '4h', '2m']);
  const ext = rnd() < 0.3;
  const close = lastClose(rows, tf, ext);
  const base = close ?? Date.parse('2026-08-14T20:00:00Z');
  const kind = pick(['none', 'num', 'num', 'clock', 'clock', 'clock']);
  const clock = { kind, epochMs: base + pick([-60_000, 0, 1, 60_000, 600_000, 1_200_000, 1_200_001, 3_600_000, 86_400_000, 1e9]) };
  if (kind === 'clock') {
    if (rnd() < 0.4) clock.barsAsOfMs = base + pick([-1, 0, 1, 1_200_000, 1_300_000]);
    if (rnd() < 0.7) clock.feed = pick(['live', 'delayed', 'unknown', 'other']);
    if (rnd() < 0.3) clock.extendedSession = rnd() < 0.5;
  }
  const symbol = pick(['SPY', 'AAPL', '', 'NVDA']);
  const strength = pick([2, 2, 2, 1, 3]);
  const res = run(() => P.analyze(rows, symbol, tf, strength, clockOf(clock), ext));
  const entry = { set: Math.max(0, set), symbol, timeframe: tf, strength, clock, extended: ext, ...res };
  if (res.out) {
    const r = P.analyze(rows, symbol, tf, strength, clockOf(clock), ext);
    entry.htf = enc(P.htfSummary(r));
    // 事实块:单独拼,或者拼上一个高周期与同向判断(handler 的样子)
    if (rnd() < 0.5) {
      const hset = out.golden.length + Math.floor(rnd() * (out.sets.length - out.golden.length));
      let higher = null;
      try { higher = P.htfSummary(P.analyze(out.sets[hset], 'H', pick(['1h', '1d']), 2, null, false)); } catch { higher = null; }
      if (higher && rnd() < 0.2) { higher.support = null; higher.closed_bar = ''; }
      const agree = P.agreement(r, higher);
      entry.higher = enc(higher);
      entry.agreement = enc(agree);
      entry.facts = P.factsText({ ...r, htf: higher, agreement: agree });
    } else {
      entry.facts = P.factsText(r);
    }
  }
  out.cases.push(entry);
}
// ---------------------------------------------------------------- 手搭的边界
// 平盘 100 上插几个单根的尖(别的根 high = low = open = close = 100,不出摆动点;最后十几根真实波幅全是 0,ATR = 0,容差退到价格的万分之五)
const flatBase = (n) => Array.from({ length: n }, (_, i) => ({ time: etStamp(Date.UTC(2026, 7, 10, 13, 30) + i * 300_000), open: 100, high: 100, low: 100, close: 100, volume: 1000 }));
const tolFlat = Math.abs(100) * 0.0005;
const nextUp = (x) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x); b.setBigUint64(0, b.getBigUint64(0) + 1n); return b.getFloat64(0); };
const handSets = [];
for (const [gap, wick] of [[60, 0], [60, 1], [61, 0], [59, 0], [60, 2], [58, 1]]) {
  const rows = flatBase(95);
  rows[10].high = 110;
  const at = 10 + gap;
  // wick:0 = 刺穿量正好等于容差(不算),1 = 比容差多一点点(算),2 = 少一点点
  const reach = 110 + tolFlat;
  rows[at].high = wick === 0 ? reach : wick === 1 ? nextUp(reach) : reach - 1e-9;
  handSets.push(rows);
}
for (const delta of [0, 1, 2]) {
  // 同簇:两个高点相差正好是容差(以第一个为准),中间隔一个低点
  const rows = flatBase(80);
  rows[10].high = 110;
  rows[14].low = 95;
  let p1 = 110 + tolFlat;
  for (let k = 0; k < 8 && p1 - 110 !== tolFlat; k += 1) p1 = nextUp(p1);
  rows[20].high = delta === 0 ? p1 : delta === 1 ? nextUp(p1) : p1 - 1e-9;
  handSets.push(rows);
}
for (const rows of handSets) {
  const set = out.sets.push(rows) - 1;
  for (const tf of ['5m']) {
    const res = run(() => P.analyze(rows, 'HAND', tf, P.SWING_STRENGTH, null, false));
    const entry = { set, symbol: 'HAND', timeframe: tf, strength: 2, clock: { kind: 'none', epochMs: 0 }, extended: false, ...res };
    if (res.out) {
      const r = P.analyze(rows, 'HAND', tf, P.SWING_STRENGTH, null, false);
      entry.htf = enc(P.htfSummary(r));
      entry.facts = P.factsText(r);
    }
    out.cases.push(entry);
  }
}
// 找探针:对变异测试里活下来的每一条边界改动,在整数格点上的随机 K 线里找一份"改了就和原版不一样"的输入
const HUNTS = [
  ['tolOf 退路', 'Math.abs(close) * 0.0005', 'Math.abs(close) * 0.001'],
  ['扫单 60 根', 'if (index - swing.index > 60)', 'if (index - swing.index >= 60)'],
  ['扫单 容差', 'swing.kind === "high" && bar.high > swing.price + tol', 'swing.kind === "high" && bar.high >= swing.price + tol'],
  ['簇 容差', 'if (price - lastCluster[0] <= tol)', 'if (price - lastCluster[0] < tol)'],
  ['FVG 容差', 'if (size < tol)', 'if (size <= tol)'],
  ['FVG 回补 0.9', 'if (filled >= 0.9)', 'if (filled > 0.9)'],
  ['订单块 回踩起点', 'Math.max(i + 2, end + 1)', 'Math.max(i + 1, end + 1)'],
  ['订单块 回踩 low', 'b.low <= bar.high && b.high >= bar.low', 'b.low < bar.high && b.high >= bar.low'],
  ['等高 0.6', 'Math.abs(a.price - b.price) <= tol * 0.6', 'Math.abs(a.price - b.price) < tol * 0.6'],
  ['十字星', 'if (bd <= sp * 0.1)', 'if (bd < sp * 0.1)'],
  ['锤子', 'lower >= sp * 0.5', 'lower > sp * 0.5'],
  ['射击之星', 'lower <= sp * 0.2 && bd <= sp * 0.4) {\n            hits.push(["长上影', 'lower < sp * 0.2 && bd <= sp * 0.4) {\n            hits.push(["长上影'],
  ['看涨吞没', 'bullish(bar) && !bullish(prev) && bar.close >= prev.open', 'bullish(bar) && !bullish(prev) && bar.close > prev.open'],
  ['外包', 'bar.high > prev.high && bar.low < prev.low', 'bar.high > prev.high && bar.low <= prev.low'],
  ['大实体', 'sp >= atrValue * 1.2', 'sp > atrValue * 1.2'],
  ['EMA20 根数', 'closes.length >= 20 ?', 'closes.length > 20 ?'],
  ['EMA50 根数', 'closes.length >= 50 ?', 'closes.length > 50 ?'],
  ['均线排列', 'ema20 > ema50 ?', 'ema20 >= ema50 ?'],
  ['区间 hi>lo', 'hi > lo ?', 'hi >= lo ?'],
  ['量 10 根', 'vols.length >= 10 &&', 'vols.length > 10 &&'],
  ['当日 2 根', 'todays.length >= 2', 'todays.length >= 3'],
  ['关键位 最近', 'Math.abs(l["price"] - last) < Math.abs(near["price"] - last)', 'Math.abs(l["price"] - last) <= Math.abs(near["price"] - last)'],
  ['关键位 贴近', 'Math.abs(near["price"] - last) <= atrValue * 0.35', 'Math.abs(near["price"] - last) < atrValue * 0.35'],
  ['放量 1.5', 'rel >= 1.5', 'rel > 1.5'],
  ['看不清 18', 'Math.abs(result["score"]) < 18', 'Math.abs(result["score"]) <= 18'],
  ['波动极低', 'ctx["atr_pct"] < 0.05', 'ctx["atr_pct"] <= 0.05'],
  ['行情停了 1800', 'idle > 1800', 'idle >= 1800'],
];
function* paCandidates() {
  for (;;) {
    const mode = pick(['rand', 'int', 'int', 'int', 'flat', 'sparseVol', 'dayEdge', 'tight']);
    const scale = mode === 'rand' ? pick([1, 1, 2, 10, 100, 1000]) : 10;   // 10:单位是 1,整数价位,乘除都精确
    const daily = mode === 'rand' ? rnd() < 0.3 : rnd() < 0.1;
    const tf = daily ? '1d' : '5m';
    let n = pick([20, 21, 30, 31, 33, 35, 40, 45, 50, 51, 55, 60, 61, 70]);
    if (mode === 'flat') n = pick([55, 60, 70]);
    const wide = pick([1, 2, 3]);
    const amp = mode === 'int' ? pick([1, 2, 5, 5, 10]) : 1;
    let px = mode === 'tight' ? pick([1000, 5000]) * scale / 10 * 10 : pick([100, 100, 150]);
    const rows = [];
    let t = Date.UTC(2026, 7, 10, 13, 30);
    if (mode === 'dayEdge') t = Date.UTC(2026, 7, 11, 4, 0) - (n - pick([1, 2, 2, 3])) * 300_000;
    const volMode = mode === 'sparseVol' ? 'sparse' : pick(['none', 'small', 'small', 'big']);
    const sparse = new Set();
    if (volMode === 'sparse') { sparse.add(n - 1); while (sparse.size < pick([9, 10, 10, 11])) sparse.add(Math.floor(rnd() * n)); }
    for (let i = 0; i < n; i += 1) {
      const u = mode === 'tight' ? 0.01 : scale / 10;
      const open = px + (mode === 'flat' ? 0 : (Math.floor(rnd() * 3) - 1) * amp);
      const close = mode === 'flat' ? open : open + (Math.floor(rnd() * (2 * wide + 1)) - wide) * amp;
      const hi = mode === 'flat' ? open : Math.max(open, close) + Math.floor(rnd() * 3) * amp, lo = mode === 'flat' ? open : Math.min(open, close) - Math.floor(rnd() * 3) * amp;
      const row = mode === 'tight' ? { open: open + Math.floor(rnd() * 3) * u, high: open + 0.05 * (1 + Math.floor(rnd() * 3)), low: open - 0.05 * Math.floor(rnd() * 3), close: open + Math.floor(rnd() * 3) * u }
        : { open: open * scale / 10, high: hi * scale / 10, low: lo * scale / 10, close: close * scale / 10 };
      row.time = daily ? etStamp(t).slice(0, 10) : etStamp(t);
      if (volMode === 'small') row.volume = 10 * Math.floor(rnd() * 5);
      else if (volMode === 'big') row.volume = 1000 * (1 + Math.floor(rnd() * 3));
      else if (volMode === 'sparse') row.volume = sparse.has(i) ? 10 * (1 + Math.floor(rnd() * 3)) : 0;
      rows.push(row);
      t += daily ? 86_400_000 : 300_000;
      px = mode === 'flat' || mode === 'tight' ? px : Math.max(60, Math.min(160, close + Math.floor(rnd() * 3) - 1));
    }
    const close = P.barCloseEpochMs(rows[rows.length - 1].time, tf, false);
    const kind = pick(['none', 'num', 'num']);
    yield { rows, tf, clock: kind === 'none' ? { kind } : { kind, epochMs: close + pick([0, 0, 1000, 1_799_000, 1_800_000, 1_801_000, 3_600_000]) } };
  }
}
out.hunted = [];
for (const [label, from, to] of HUNTS) {
  let M;
  try { M = await mutantOf(engine, 'priceaction', [[from, to]]); } catch (e) { console.log('HUNT-SKIP', label, e.message); continue; }
  const call = (X) => (c) => X.analyze(c.rows, 'H', c.tf, 2, clockOf(c.clock), false);
  const { found, tried } = hunt(paCandidates(), call(P), call(M), 2, 30000);
  console.log('HUNT', label, found.length, tried);
  for (const c of found) {
    const set = out.sets.push(c.rows) - 1;
    const r = P.analyze(c.rows, 'H', c.tf, 2, clockOf(c.clock), false);
    const slim = { ...r }; delete slim.bars; delete slim.ma;
    out.hunted.push({ label, set, symbol: 'H', timeframe: c.tf, clock: c.clock, extended: false, out: enc(slim), facts: P.factsText(r), htf: enc(P.htfSummary(r)) });
  }
}

// 等高:两个高点相差正好是容差的 0.6 倍(ATR 恰为 100:最后 14 根的真实波幅全是 100)
for (const d of [21, 20, 22]) {
  const rows = flatBase(70).map((r) => ({ ...r, open: 2000, high: 2000, low: 2000, close: 2000 }));
  rows[10].high = 2200; rows[14].low = 1800; rows[20].high = 2200 + d;
  for (let k = 56; k < 70; k += 1) { rows[k].high = 2050; rows[k].low = 1950; }
  const set = out.sets.push(rows) - 1;
  const r = P.analyze(rows, 'HAND', '5m', 2, null, false);
  out.cases.push({ set, symbol: 'HAND', timeframe: '5m', strength: 2, clock: { kind: 'none', epochMs: 0 }, extended: false, out: enc(r), htf: enc(P.htfSummary(r)), facts: P.factsText(r) });
}
// K 线形态与波动的整数边界:前面全是 high 105 / low 95 / 开收 100 的平盘柱(真实波幅 10,不出摆动点),最后一根按要求搭
{
  const base = (n, price = 100, half = 5) => Array.from({ length: n }, (_, i) => ({ time: etStamp(Date.UTC(2026, 7, 10, 13, 30) + i * 300_000), open: price, high: price + half, low: price - half, close: price, volume: 1000 }));
  const tails = [
    ['cross', { open: 100, close: 101, high: 105, low: 95 }],
    ['hammer', { open: 100, close: 103, high: 105, low: 95 }],
    ['shoot', { open: 97, close: 100, high: 105, low: 95 }],
    ['engulfUp', null],
  ];
  // 大实体:找一个 T,使 (13 × 10 + T) / 14 × 1.2 正好等于 T(浮点上)
  let T = null;
  for (let k = 193; k < 400 && T === null; k += 1) { const t = k / 16; const a = (130 + t) / 14; if (a * 1.2 === t) T = t; }
  console.log('大实体 T', T);
  if (T !== null) tails.push(['big', { open: 100, close: 100 + T * 0.75, high: 100 + T, low: 100 }]);
  for (const [name, bar] of tails) {
    if (!bar) continue;
    const rows = base(45);
    Object.assign(rows[44], bar, { time: rows[44].time });
    const set = out.sets.push(rows) - 1;
    const r = P.analyze(rows, 'HAND', '5m', 2, null, false);
    out.cases.push({ set, symbol: 'HAND', timeframe: '5m', strength: 2, clock: { kind: 'none', epochMs: 0 }, extended: false, out: enc(r), htf: enc(P.htfSummary(r)), facts: P.factsText(r) });
  }
  // atr_pct 舍到 0.05:价 10000、真实波幅 5
  const rows = base(45, 10000, 2.5);
  const set = out.sets.push(rows) - 1;
  const r = P.analyze(rows, 'HAND', '5m', 2, null, false);
  out.cases.push({ set, symbol: 'HAND', timeframe: '5m', strength: 2, clock: { kind: 'none', epochMs: 0 }, extended: false, out: enc(r), htf: enc(P.htfSummary(r)), facts: P.factsText(r) });
}
// 直接调的小函数
out.helpers = [];
for (let i = 0; i < out.sets.length; i += 1) {
  if (i > 6 && i % 7) continue;
  const rows = out.sets[i];
  const bars = P.toBars(rows);
  const atrs = P.atrSeries(bars);
  const st = pick([1, 2, 3]);
  const swings = P.findSwings(bars, st);
  const zz = P.zigzag(swings);
  out.helpers.push({ set: i, st, atr: enc(P.atr(bars)), atr5: enc(P.atr(bars, 5)), atrs: enc(atrs), atrs3: enc(P.atrSeries(bars, 3)),
    tr: enc(bars.map((b, k) => P.trueRange(b, k ? bars[k - 1] : null))), swings: enc(swings), zigzag: enc(zz), labeled: enc(P.labelSwings(zz)),
    ma: enc(P.movingAverages(bars)), ma2: enc(P.movingAverages(bars, [1, 3, 50], 20)),
    hist: enc(P.structureHistory(bars, (k) => atrs[k] * 0.35, 2, 3, 20, 2)), hist2: enc(P.structureHistory(bars, () => 0.01, 3)) });
}
out.subs = [];
for (const ev of [[], [{ group: 'structure', weight: 30 }, { group: 'structure', weight: -12 }, { group: 'confirm', weight: 15 }], [{ group: 'location', weight: 0 }], [{ group: 'confirm', weight: -8 }, { group: 'confirm', weight: -10 }],
  [{ group: 'structure', weight: 0.25 }, { group: 'structure', weight: 0.35 }]]) out.subs.push({ ev, out: enc(P.subScores(ev)) });

for (const s of ['2026-08-14 09:30', '2026-08-14 09:30:15', '2026-08-14', '2026-8-14', '2026-08-14T09:30', '', '2026-08-14 9:30', '2026-02-30 25:61', '20260814', '2026-08-14 09:30:15.5'])
  out.parse.push({ s, out: enc(P.parseBarTime(s)) });
for (const tf of ['1m', '5m', '1h', '1d', '1w', 'x', '', 'toString', '__proto__', '4h'])
  for (const t of ['2026-08-14 09:30', '2026-08-14', '2026-11-01 01:30', '2026-03-08 02:30', 'bad', '2026-08-14 15:55:00'])
    for (const ext of [false, true]) out.closeAt.push({ tf, t, ext, out: enc(P.barCloseEpochMs(t, tf, ext)) });
for (const [t, now] of [['2026-08-14 09:30', 1786714200000], ['2026-08-14', 1786714200000], ['x', 1786714200000], ['2026-08-14 09:30', null], ['2026-12-01 09:30:30', 1800000000000]])
  out.age.push({ t, now, out: enc(P.barAgeSeconds(t, now)) });
for (const s of [-100, -45, -44.9, -18, -17.9, 0, 17.9, 18, 44.9, 45, 100, NaN]) out.bias.push({ s: enc(s), out: P.biasOf(s) });

writeFileSync(join(here, 'priceaction.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out, sets: out.sets.map(enc) }) + '\n');
console.log('priceaction.json', Object.entries(out).map(([k, v]) => `${k}=${v.length}`).join(' '));
