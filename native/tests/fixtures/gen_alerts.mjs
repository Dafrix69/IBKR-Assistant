// 生成 alerts.json:engine-ts 的 alerts.ts(原模块现跑)。黄金基线 alerts.json 的几组场景(整数关口、带墙的价位与清单、趋势位与摘要、
// 带历史的价位、两段穿越走法)按原输入重算;另有随机的:自动步长(各个数量级、边界上的 band)、关口、写坏的期权墙(串、0、数组、null)、
// 日线(缺价、坏根、今天那根、短历史、窗口 0 / 负数)、合并与截断、价位此刻在哪、状态键、取价接续、穿越状态机(立即 / 1 分钟收盘确认,
// 冷却、断档、老库里按价做键的状态、缺字段与多字段的状态、null 的 pending)、换关口、给人看的清单。
//   ELECTRON_RUN_AS_NODE=1 …/Electron native/tests/fixtures/gen_alerts.mjs <编过的 engine-ts 目录>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const A = await import(pathToFileURL(join(engine, 'dist/src/alerts.js')).href);

let seed = 0xa1e7_5005;
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
const canon = (l) => ({ ...A.levelDict(l), ...(l.priority !== undefined ? { priority: l.priority } : {}) });
const levelsOut = (ls) => ls.map(canon);

const golden = JSON.parse(readFileSync(join(engine, 'baseline/golden/alerts.json'), 'utf8'));
const store = JSON.parse(readFileSync(join(engine, 'baseline/golden/_bars.json'), 'utf8'));
const resolve = (v) => (v && typeof v === 'object' && !Array.isArray(v) && typeof v.$bars === 'string' ? store[v.$bars] : v);

const out = { autoStep: [], round: [], trend: [], build: [], keys: [], link: [], walks: [], reround: [] };

// ---------------------------------------------------------------- 自动步长与关口
for (const spot of [41, 41.2, 180, 450, 452.6, 6700, 7462.35, 0.5, 0.05, 1e-5, 5e-324, 1e6, 1e300, 1.7e308, 0, -5, NaN, Infinity, 99.99, 100, 2.5, 25, 250]) {
  for (const band of [0.3, 0.1, 1, 0, 100, 99.9, -1, NaN, 50]) out.autoStep.push({ spot: enc(spot), band: enc(band), out: enc(A.autoStep(spot, band)) });
}
for (let i = 0; i < 300; i += 1) {
  const spot = Math.exp(gauss() * 4 + 4), band = pick([0.3, 0.3, 0.05, 0.6, 1.5]);
  out.autoStep.push({ spot, band, out: A.autoStep(spot, band) });
}
for (const c of golden.round_levels) out.round.push({ spot: c.spot, step: c.step, out: enc(A.roundLevels(c.spot, c.step)) });
for (let i = 0; i < 300; i += 1) {
  const step = pick([5, 1, 0.25, 2.5, 50, 0, -1, 0.1, 3, NaN, 1000]);
  const spot = rnd() < 0.3 ? Math.round(rnd() * 100) * pick([5, 1, 0.25, 2.5, 50]) : pick([0, -1, NaN, 41.2, 452.6, 7462.35, 0.3, rnd() * 1000]);
  out.round.push({ spot: enc(spot), step: enc(step), out: enc(A.roundLevels(spot, step)) });
}

// ---------------------------------------------------------------- 日线与趋势位
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
function series(n, price = 100, vol = 0.015) {
  let ms = Date.parse('2025-01-02T00:00:00Z');
  let c = price;
  const out = [];
  while (out.length < n) {
    const d = new Date(ms).getUTCDay();
    if (d !== 0 && d !== 6) {
      c = Math.max(0.5, c * (1 + gauss() * vol));
      const close = Math.round(c * 100) / 100;
      out.push({ date: iso(ms), open: close, high: Math.round(close * (1 + Math.abs(gauss()) * 0.01) * 100) / 100, low: Math.round(close * (1 - Math.abs(gauss()) * 0.01) * 100) / 100, close, volume: 1e6 });
    }
    ms += 86_400_000;
  }
  return out;
}
function dirty(bars) {
  const b = bars.map((x) => ({ ...x }));
  for (let i = 0; i < 5; i += 1) {
    const j = Math.floor(rnd() * b.length);
    const kind = pick(['nullClose', 'strLow', 'zero', 'nan', 'neg', 'inf', 'noHigh']);
    if (kind === 'nullClose') b[j].close = null;
    else if (kind === 'strLow') b[j].low = String(b[j].low);
    else if (kind === 'zero') b[j].high = 0;
    else if (kind === 'nan') b[j].close = NaN;
    else if (kind === 'neg') b[j].low = -1;
    else if (kind === 'inf') b[j].high = Infinity;
    else delete b[j].high;
  }
  return b;
}
const periodSets = [undefined, [20, 60, 120, 200], [5, 10], [1, 2, 3], [20, 20], [0, -5, 300], [2.5, 7.5]];
const historyPool = [];
for (const c of golden.trend_levels) {
  const bars = resolve(c.bars);
  historyPool.push(bars);
  out.trend.push({ bars: historyPool.length - 1, spot: c.spot, periods: '__undefined__', window: '__undefined__', today: '__undefined__',
    ...run(() => ({ levels: levelsOut(A.trendLevels(bars, c.spot)), snapshot: A.trendSnapshot(bars, c.spot) })) });
}
for (let i = 0; i < 120; i += 1) {
  const n = pick([0, 1, 5, 19, 20, 21, 60, 130, 200, 249, 250, 251]);
  let bars = series(n, pick([40, 100, 450, 7000]));
  if (rnd() < 0.3) bars = dirty(bars.length ? bars : series(3));
  historyPool.push(bars);
  const last = bars[bars.length - 1]?.close ?? 100;
  const spot = pick([last, last * 1.02, last * 0.97, 0, -1, NaN, typeof last === 'number' ? last : 100]);
  const periods = pick(periodSets), window = pick([undefined, 250, 20, 0, -10, 100, 1000]);
  const today = pick([undefined, null, bars[bars.length - 1]?.date, '2030-01-01', bars[Math.floor(bars.length / 2)]?.date]);
  const r = run(() => ({ levels: levelsOut(A.trendLevels(bars, spot, periods, window, today)), snapshot: A.trendSnapshot(bars, spot, periods, window, today) }));
  out.trend.push({ bars: historyPool.length - 1, spot: enc(spot), periods: enc(periods), window: enc(window), today: enc(today), ...r });
}
historyPool.push(null);
out.trend.push({ bars: historyPool.length - 1, spot: 100, periods: '__undefined__', window: '__undefined__', today: '__undefined__', ...run(() => ({ levels: levelsOut(A.trendLevels(null, 100)), snapshot: A.trendSnapshot(null, 100) })) });
historyPool.push([null]);
out.trend.push({ bars: historyPool.length - 1, spot: 100, periods: '__undefined__', window: '__undefined__', today: '__undefined__', ...run(() => ({ levels: levelsOut(A.trendLevels([null], 100)), snapshot: A.trendSnapshot([null], 100) })) });

// ---------------------------------------------------------------- 价位整批
const wallPool = [null, undefined, golden.walk.wall, ...golden.build_levels.map((c) => c.wall),
  { days_to_expiry: 3, call_wall: { strike: 460 }, put_wall: { strike: 440 }, max_pain: { strike: 450 } },
  { days_to_expiry: '0.5', call_vol_wall: { strike: '455' }, put_vol_wall: { strike: 0 }, gamma_flip: '447' },
  { days_to_expiry: null, call_wall: 5, put_wall: 'x', max_pain: 7, gamma_flip: null },
  { days_to_expiry: [0.2], call_wall: { strike: 'abc' }, gamma_flip: 'nope' }, { days_to_expiry: {}, max_pain: { strike: null } },
  { put_vol_wall: 'pv', max_pain: 'mp', call_wall: '', days_to_expiry: 0 }, { days_to_expiry: 1, call_wall: { strike: 455 }, call_vol_wall: { strike: 460 } },
  { gamma_flip: 0, max_pain: { strike: 451 } }, { gamma_flip: '', put_wall: { strike: 445 }, days_to_expiry: 1.0000001 }, 'wall', 0, [], {}, { call_wall: { strike: 452.6 }, put_wall: { strike: 452.6 }, max_pain: { strike: 452.65 }, gamma_flip: 452.6 }];
for (const c of golden.build_levels) {
  const r = run(() => { const ls = A.buildLevels(c.spot, c.wall, c.step); return { levels: levelsOut(ls), describe: A.describe(ls, c.spot) }; });
  out.build.push({ spot: c.spot, wall: enc(c.wall), step: c.step, merge: '__undefined__', max: '__undefined__', history: '__undefined__', today: '__undefined__', ...r });
}
{
  const w = golden.build_with_history;
  const bars = resolve(w.bars);
  const r = run(() => { const ls = A.buildLevels(w.spot, null, w.step, undefined, undefined, bars); return { levels: levelsOut(ls), describe: A.describe(ls, w.spot) }; });
  historyPool.push(bars);
  out.build.push({ spot: w.spot, wall: null, step: w.step, merge: '__undefined__', max: '__undefined__', history: historyPool.length - 1, today: '__undefined__', ...r });
}
for (let i = 0; i < 160; i += 1) {
  const wall = pick(wallPool);
  const hi = rnd() < 0.5 ? Math.floor(rnd() * historyPool.length) : null;
  const history = hi === null ? null : historyPool[hi];
  const last = history?.[history.length - 1]?.close;
  const spot = pick([452.6, 41, 7462.35, 450, 455, typeof last === 'number' ? last : 100, 0, -3, NaN, 0.4, 1e-3]);
  const step = pick([0, 5, 1, 2.5, 50, -1, 1000, NaN]);
  const merge = pick([undefined, 0.15, 0, 1, 5, -1]);
  const max = pick([undefined, 24, 3, 1, 0, -2, 2.5]);
  const today = pick([undefined, null, '2030-01-01', history?.[Math.floor((history?.length ?? 0) / 2)]?.date]);
  const r = run(() => { const ls = A.buildLevels(spot, wall, step, merge, max, history, today); return { levels: levelsOut(ls), describe: A.describe(ls, spot) }; });
  out.build.push({ spot: enc(spot), wall: enc(wall), step: enc(step), merge: enc(merge), max: enc(max), history: hi, today: enc(today), ...r });
}
out.describe = [];
for (const spot of [0, NaN, 452.6, -10]) {
  const ls = A.buildLevels(452.6, golden.walk.wall, 5);
  out.describe.push({ spot: enc(spot), levels: enc(levelsOut(ls)), out: A.describe(ls, spot) });
}

// ---------------------------------------------------------------- 键与此刻的价
const keyLevels = [
  { price: 450, label: 'x', source: 'call_wall', kind: 'resistance' }, { price: 61.23456, label: 'x', source: 'ma20', kind: 'support', ma: { period: 20, prior_sum: 1180 } },
  { price: 61, label: 'x', source: 'ma', kind: 'pivot' }, { price: 61, label: 'x', source: 'ma20x', kind: 'pivot' }, { price: 61, label: 'x', source: 'MA20', kind: 'pivot' },
  { price: 30, label: 'x', source: 'low_52w', kind: 'support' }, { price: 447.3, label: 'x', source: 'gamma_flip', kind: 'pivot' }, { price: 445.00005, label: 'x', source: 'round', kind: 'pivot' },
  { price: 61, label: 'x', source: 'ma60', kind: 'pivot', ma: { period: 1, prior_sum: 100 } }, { price: 61, label: 'x', source: 'ma60', kind: 'pivot', ma: { period: 60, prior_sum: NaN } },
  { price: 61, label: 'x', source: 'ma60', kind: 'pivot', ma: { period: 60, prior_sum: Infinity } }, { price: NaN, label: 'x', source: 'put_wall', kind: 'support' },
];
for (const l of keyLevels) for (const p of [60, 0, -1, NaN, 61.5]) out.keys.push({ level: enc(l), price: enc(p), key: A.levelKey(l), at: enc(A.levelPriceAt(l, p)) });

// ---------------------------------------------------------------- 取价接续
const quotes = [];
for (let i = 0; i < 400; i += 1) {
  const prev = rnd() < 0.1 ? pick([null, undefined]) : { at: 1000 + Math.floor(rnd() * 10) * 60, price: pick([100, 100.5, 0, -1, NaN]), session: pick(['2026-10-16 rth', '2026-10-16 pre', '2026-10-17 rth']),
    tradedAt: pick([null, 900, 950, 1000]), settled: rnd() < 0.5 };
  const near = prev && rnd() < 0.7;
  const quote = { at: near ? prev.at + pick([0, 5, 60, 300, 301, -5]) : pick([1000, 1200, 1300, 1310, 1600, 900, 2000]), price: near && rnd() < 0.4 ? prev.price : pick([100, 100.5, 101]),
    session: near ? prev.session : pick(['2026-10-16 rth', '2026-10-16 pre']), tradedAt: pick([null, 900, 950, 1100]) };
  const gap = pick([undefined, 300, 0, 60, Infinity]);
  out.link.push({ prev: enc(prev), quote: enc(quote), gap: enc(gap), out: enc(A.linkSample(prev, quote, gap)) });
  quotes.push(quote);
}

// ---------------------------------------------------------------- 穿越状态机
function walk(name, levels, seq, opts = {}) {
  let states = opts.states ?? {};
  let prev = null;
  const steps = [];
  for (const [price, at, reset] of seq) {
    if (reset) prev = null;
    const r = run(() => A.evaluate(levels, states, prev, price, at, opts.band, opts.cooldown, opts.confirm));
    steps.push({ price: enc(price), at, prev: enc(prev), ...r });
    if (r.out) states = A.evaluate(levels, states, prev, price, at, opts.band, opts.cooldown, opts.confirm)[1];
    prev = price;
  }
  out.walks.push({ name, levels: enc(levelsOut(levels)), states: enc(opts.states ?? {}), band: enc(opts.band), cooldown: enc(opts.cooldown), confirm: enc(opts.confirm), steps });
}
{
  const w = golden.walk;
  const levels = A.buildLevels(w.spot, w.wall, w.step);
  const seq = [];
  let reset = false;
  for (const [i, p] of w.prices.entries()) {
    if (p === null) { reset = true; continue; }
    seq.push([p, w.t0 + i * 60.0, reset]);
    reset = false;
  }
  walk('golden.walk', levels, seq);
  const c = golden.cooldown_walk;
  walk('golden.cooldown', A.buildLevels(452.6, golden.walk.wall, 5.0), c.seq.map(([p, dt]) => [p, golden.walk.t0 + dt]), { band: c.band_pct, cooldown: c.cooldown });
}
for (let i = 0; i < 70; i += 1) {
  const history = rnd() < 0.5 ? pick(historyPool.filter((h) => h && h.length > 30)) : null;
  const last = history?.[history.length - 1]?.close;
  const spot = typeof last === 'number' ? last : pick([452.6, 41, 7462.35]);
  const levels = A.buildLevels(spot, rnd() < 0.5 ? pick(wallPool) : null, pick([0, 0, 5, 1]), undefined, undefined, history);
  const confirm = pick(['immediate', 'bar_close', 'bar_close', undefined]);
  const vol = spot * pick([0.0005, 0.002, 0.005]);
  let p = spot, t = 1_760_000_000 + Math.floor(rnd() * 60);
  const seq = [];
  for (let k = 0; k < 48; k += 1) {
    p += gauss() * vol;
    t += pick([5, 5, 10, 30, 55, 61, 120, 400]);
    const price = rnd() < 0.03 ? pick(levels.map((l) => l.price)) ?? p : Math.round(p * 100) / 100;
    seq.push([price, t, rnd() < 0.03]);
  }
  walk(`syn${i}`, levels, seq, { confirm, band: pick([undefined, 0.3, 0.05, 1]), cooldown: pick([undefined, 300, 60, 0]) });
}
// 老库里的状态:按价做键、缺 last_fired_at、多出的字段、null / 坏的 pending、armed 是串
{
  const levels = A.buildLevels(452.6, golden.walk.wall, 5.0);
  const legacy = {
    '450.0000': { armed: false, last_fired_at: 100, extra: 1 },
    gamma_flip: { armed: true, last_fired_at: 5, pending: { direction: 'down', from: 448, at: 1_760_000_000, minute: 29_333_333 } },
    'call_wall@455.0000': { armed: 0 }, 'put_vol_wall@440.0000': 7, 'round@455.0000': null, 'put_wall@445.0000': { armed: 'yes', last_fired_at: null },
  };
  for (const confirm of ['immediate', 'bar_close']) {
    walk(`legacy.${confirm}`, levels, [[449, 1_760_000_000], [450.5, 1_760_000_010], [446, 1_760_000_100], [448, 1_760_000_130], [449.9, 1_760_000_500], [451, 1_760_000_560]], { states: legacy, confirm });
  }
  const pend = { gamma_flip: { armed: true, last_fired_at: null, pending: 5 }, 'call_vol_wall@450.0000': { armed: true, last_fired_at: null, pending: { from: 449, at: 1_760_000_000, minute: 29_333_333, close: 451, close_at: 1_760_000_000 } } };
  walk('pending.odd', levels, [[451, 1_760_000_070], [452, 1_760_000_080]], { states: pend, confirm: 'bar_close' });
  walk('pending.null', levels, [[451, 1_760_000_070]], { states: { gamma_flip: { armed: true, pending: null } }, confirm: 'bar_close' });
}

// 写明的边界:正好离开 band 那么远(不上膛)、1 分钟收盘正好落在线上(作废)、两笔一样的价正好压在线上(算上穿)、时间倒着走(断档)
{
  const levels = A.buildLevels(401, null, 10);
  const t = 1_760_000_040;
  walk('edge.band', levels, [[399, t], [401, t + 1], [402, t + 2], [399.5, t + 3], [397, t + 4], [401, t + 5]], { band: 0.5, cooldown: 0 });
  walk('edge.closeOnLine', levels, [[399, t], [401, t + 1], [400, t + 2], [400.5, t + 70], [399, t + 80], [401, t + 81], [400, t + 82], [399.5, t + 140]], { confirm: 'bar_close', band: 0.5 });
  walk('edge.flatOnLine', levels, [[400, t], [400, t + 1], [380, t + 2], [410, t + 400], [410, t + 401]], { band: 0.5, cooldown: 1 });
  // 待确认的这一笔,下一次取价正好隔 cooldown 秒(算还连着:按那根 K 线收盘确认);隔 cooldown + 1 秒就作废
  walk('edge.pendingAtCooldown', levels, [[399, t], [401, t + 1], [402, t + 10], [403, t + 310]], { confirm: 'bar_close', band: 0.5 });
  walk('edge.pendingPastCooldown', levels, [[399, t], [401, t + 1], [402, t + 10], [403, t + 311]], { confirm: 'bar_close', band: 0.5 });
  walk('edge.backwards', levels, [[399, t + 500], [401, t + 501], [402, t + 100], [403, t + 600]], { confirm: 'bar_close', band: 0.5 });
}
// 盯单上记着的价没检查过(含 NaN):换关口后按价排序,NaN 当相等,不到 8 个是直接的二分插入
{
  const lv = (price, source) => ({ price, label: `L${price}`, source, kind: 'pivot' });
  for (const prices of [[-45838.4, 6589.1, NaN, 0, 0.2], [NaN, 450, 440, NaN, 460]]) {
    const levels = prices.map((p) => lv(p, 'call_wall'));
    const r = run(() => { const x = A.reroundLevels(levels, 452.6, 5); return x === null ? null : levelsOut(x); });
    out.reround.push({ levels: enc(levelsOut(levels)), price: 452.6, step: 5, merge: '__undefined__', ...r });
  }
}
// 均线的价跟着现价走:新关口挨着均线此刻的价就不加(记着的价离得远)
{
  const ma = { price: 100, label: '20日均线', source: 'ma20', kind: 'support', priority: 2, ma: { period: 20, prior_sum: 19 * 104.9 } };
  for (const price of [104.9, 104.2]) {
    const levels = [ma, { price: 100, label: '整数关口 100', source: 'round', kind: 'pivot', priority: 0 }];
    const r = run(() => { const x = A.reroundLevels(levels, price, 1); return x === null ? null : levelsOut(x); });
    out.reround.push({ levels: enc(levelsOut(levels)), price, step: 1, merge: '__undefined__', ...r });
  }
}
// 均线四舍五入成 0、一年都是同一个价(高低相等)、现价正好是一年高点而墙在旁边(赢的是 pivot)
{
  const tiny = series(30, 0.00001, 0.0).map((b) => ({ ...b, close: 0.00001, high: 0.00001, low: 0.00001 }));
  historyPool.push(tiny);
  out.trend.push({ bars: historyPool.length - 1, spot: 0.00001, periods: '__undefined__', window: '__undefined__', today: '__undefined__',
    ...run(() => ({ levels: levelsOut(A.trendLevels(tiny, 0.00001)), snapshot: A.trendSnapshot(tiny, 0.00001) })) });
  const flat = series(40, 50, 0).map((b) => ({ ...b, close: 50, high: 50, low: 50 }));
  historyPool.push(flat);
  out.trend.push({ bars: historyPool.length - 1, spot: 50, periods: '__undefined__', window: '__undefined__', today: '__undefined__',
    ...run(() => ({ levels: levelsOut(A.trendLevels(flat, 50)), snapshot: A.trendSnapshot(flat, 50) })) });
  const hist = series(60, 100);
  const top = Math.max(...hist.map((b) => b.high));
  historyPool.push(hist);
  const wall = { days_to_expiry: 0.5, call_wall: { strike: top * 1.0005 } };
  const r = run(() => { const ls = A.buildLevels(top, wall, 1000, undefined, undefined, hist); return { levels: levelsOut(ls), describe: A.describe(ls, top) }; });
  out.build.push({ spot: top, wall, step: 1000, merge: '__undefined__', max: '__undefined__', history: historyPool.length - 1, today: '__undefined__', ...r });
}

// ---------------------------------------------------------------- 换关口
for (let i = 0; i < 150; i += 1) {
  const spot = pick([452.6, 41.2, 7462.35, 180, 0.3]);
  const step = pick([0, 0, 5, 1, 2.5, -1, NaN]);
  const base = A.buildLevels(spot, rnd() < 0.5 ? golden.walk.wall : null, step, undefined, undefined, rnd() < 0.3 ? pick(historyPool.filter((h) => h && h.length > 30)) : null);
  const levels = rnd() < 0.3 ? base.map((l) => { const { priority, ...rest } = l; return rest; }) : base;
  const price = pick([spot, spot * 1.01, spot * 0.985, spot * 1.03, 455, 450, 0, NaN, spot * 1.006, Math.round(spot)]);
  const merge = pick([undefined, 0.15, 0, 2]);
  const r = run(() => { const x = A.reroundLevels(levels, price, step, merge); return x === null ? null : levelsOut(x); });
  out.reround.push({ levels: enc(levelsOut(levels)), price: enc(price), step: enc(step), merge: enc(merge), ...r });
}

out.histories = historyPool.map(enc);
writeFileSync(join(here, 'alerts.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
console.log('alerts.json', Object.entries(out).map(([k, v]) => `${k}=${v.length}`).join(' '));
