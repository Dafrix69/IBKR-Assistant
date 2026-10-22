// 生成 chart.json:图表里不靠图表库的那一半(desktop/renderer-react/src/lib/chart/spec.ts、layout.ts,与 engine.ts 里的几段)。
//   · spec.ts / layout.ts 直接 import;
//   · engine.ts 闭包里的 priceRange、defaultReadout、tickMark、crosshairTime、量能封顶、小数位、刷新时视口怎么留,
//     按原文切出来(去掉类型标注),在同样名字的变量下跑——不改 React 那边一个字;
//   · 颜色给一份 token 名的调色板(P.up = 'up' …),输出里看到的就是 token。
//   node native/tests/fixtures/gen_chart.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const chartDir = join(repo, 'desktop/renderer-react/src/lib/chart');
const spec = await import(join(chartDir, 'spec.ts'));
const layout = await import(join(chartDir, 'layout.ts'));
const engineSrc = readFileSync(join(chartDir, 'engine.ts'), 'utf8');

/** 从 start 那一行起,配平花括号取出整个函数 */
function cutFunction(src, start) {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`engine.ts 里没有 ${start}`);
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k += 1) {
    if (src[k] === '{') depth += 1;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(`${start} 的括号没配平`);
}
/** 从 from 那一行到 to 那一行(含) */
function cutLines(src, from, to) {
  const i = src.indexOf(from);
  const j = src.indexOf(to, i);
  if (i < 0 || j < 0) throw new Error(`engine.ts 里没有 ${from} … ${to}`);
  return src.slice(i, src.indexOf('\n', j));
}
/** 去掉类型标注;片段里可能有 return,先包进一个函数再剥 */
const strip = (code) => {
  const s = stripTypeScriptTypes(`function __wrap() {\n${code}\n}`);
  return s.slice(s.indexOf('{') + 1, s.lastIndexOf('}'));
};

const P = { up: 'up', down: 'down', blue: 'blue', orange: 'orange', purple: 'purple', label: 'label', label2: 'label2', label3: 'label3', separator: 'separator', bg: 'bg', font: 'font' };
const resolveColor = (p, color) => {
  if (!color) return p.label2;
  const token = p[color];
  return color !== 'font' && token ? token : color;
};
const TickMarkType = { Year: 0, Month: 1, DayOfMonth: 2, Time: 3, TimeWithSeconds: 4 };
const pad2 = (n) => String(n).padStart(2, '0');

const priceRangeSrc = strip(cutFunction(engineSrc, 'function priceRange('));
const readoutSrc = strip(cutFunction(engineSrc, 'function defaultReadout('));
const tickMarkSrc = strip(cutLines(engineSrc, 'const tickMark = (time', '  };'));
const crosshairSrc = strip(cutLines(engineSrc, 'const crosshairTime = (time', '  };'));
const capSrc = strip(cutLines(engineSrc, 'const vols = barAt', 'volumeCap = vols'));
const decSrc = strip(cutLines(engineSrc, 'const paneGuess =', 'dec = spec.decimals'));
const keepSrc = strip(cutLines(engineSrc, 'const pn = prevNorm.times.length;', 'chart.timeScale().setVisibleLogicalRange({ from: prevRange.from + shift'));

const { fmtPrice, fmtVol, timeLabel, niceStep, decimalsFor, normalize, wallClockSeconds } = spec;

/** 按原文跑这几段:spec、norm 与 engine.ts 里同名 */
function engineFor(s, containerHeight) {
  const norm = normalize(s);
  const headerPx = () => 8 + ((s.header ? 1 : 0) + 1) * 17;
  const hasVolume = () => s.volume !== false && norm.barAt.some((b) => b !== null && (b.volume ?? 0) > 0);
  const make = new Function('spec', 'norm', 'P', 'fmtPrice', 'fmtVol', 'timeLabel', 'resolveColor', 'TickMarkType', 'pad2', 'niceStep', 'decimalsFor', 'headerPx', 'hasVolume', 'container', `
    let dec = 2; let volumeCap = 0; const TIME_AXIS_H = 22, VOL_H = 56;
    const stampIdx = new Map(norm.stamps.map((s, i) => [s, i]));
    ${priceRangeSrc}
    ${readoutSrc}
    ${tickMarkSrc}
    ${crosshairSrc}
    function cap() { const barAt = norm.barAt; ${capSrc}; return volumeCap; }
    function decimals() {
      const n = norm.times.length; const full = n >= 2 ? priceRange(0, n - 1) : null; if (!full) return null;
      ${decSrc}; return dec; }
    return { priceRange, defaultReadout: (i, d) => { dec = d; return defaultReadout(i); }, tickMark, crosshairTime, cap, decimals };`);
  return { norm, ...make(s, norm, P, fmtPrice, fmtVol, timeLabel, resolveColor, TickMarkType, pad2, niceStep, decimalsFor, headerPx, hasVolume, { clientHeight: containerHeight }), headerPx: headerPx(), hasVolume: hasVolume() };
}

// ---- 场景 ----------------------------------------------------------------------------------
const min = (i) => `2026-08-21 ${pad2(9 + Math.floor((30 + i) / 60))}:${pad2((30 + i) % 60)}`;
const bar = (t, o, h, l, c, v) => ({ time: t, open: o, high: h, low: l, close: c, ...(v === undefined ? {} : { volume: v }) });
const minuteBars = Array.from({ length: 40 }, (_, i) => {
  const o = 7660 + Math.sin(i / 3) * 6 + i * 0.4;
  const c = o + Math.cos(i / 2) * 3;
  return bar(min(i), +o.toFixed(2), +(Math.max(o, c) + 1.25).toFixed(2), +(Math.min(o, c) - 1.5).toFixed(2), +c.toFixed(2), i === 7 ? null : 1000 + ((i * 7919) % 5000) + (i === 3 ? 90000 : 0));
});
const days = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 6, 20 + i)).toISOString().slice(0, 10));
const specs = [
  { name: '分钟 K 线 + 均线 + 关键位 + 标记 + 现价', spec: {
    ariaLabel: 'SPX 1 分钟 K 线图', viewKey: 'SPX|1m|rth', bars: minuteBars, last: 7678.5,
    lines: [{ values: minuteBars.map((b, i) => (i < 4 ? null : +(b.close - 1).toFixed(2))), color: 'orange', alpha: 0.7, label: 'MA5' },
      { points: [{ time: min(10), value: 7666 }, { time: min(11), value: null }, { time: min(30), value: 7690 }, { time: 'nope', value: 1 }], color: 'blue' }],
    hlines: [{ price: 7700, color: 'down', fit: false, tag: true }, { price: 7650, color: 'up', label: '支撑' }],
    bands: [{ from: min(5), top: 7672, bottom: 7668, color: 'up', fit: true }, { v: true, from: min(1), to: min(3), color: 'label2' }],
    markers: [{ time: min(12), price: 7699, fit: true }, { time: min(39), price: 7600, fit: false }, { time: min(2), price: 7640 }],
  } },
  { name: '日线(只有日期)', spec: { bars: days.map((d, i) => bar(d, 100 + i, 102 + i, 99 + i, 101 + i, 5e8 + i * 1e7)), yMin: 0, padPct: 0.1 } },
  { name: '读不出的时间按下标', spec: { times: ['T1', 'T2', 'T3', 'T2', 'T4'], lines: [{ values: [1, 2, 3, 99, 4], color: '#ff0000', label: '净值' }], decimals: 3 } },
  { name: '乱序与重复', spec: { bars: [bar('2026-08-21 10:02', 5, 6, 4, 5.5), bar('2026-08-21 10:00', 5, 6, 4, 4.5, 0), bar('2026-08-21 10:01', 5, 7, 3, 6), bar('2026-08-21 10:00', 1, 2, 0.5, 1.5)] } },
  { name: '解析后撞车', spec: { times: ['2026-08-21 09:30', '20260821 09:30', '2026-08-21 09:31'], lines: [{ values: [1, 2, 3] }] } },
  { name: '平的一条(hi = lo)', spec: { times: ['2026-01-02', '2026-01-03'], lines: [{ values: [5, 5] }] } },
  { name: '全是 0', spec: { times: ['2026-01-02', '2026-01-03'], lines: [{ values: [0, 0] }], volume: false } },
  { name: '没有数据', spec: { times: ['2026-01-02', '2026-01-03'] } },
  { name: '一个点', spec: { bars: [bar('2026-01-02', 1, 2, 0.5, 1.5, 10)] } },
  { name: '空', spec: {} },
  { name: '越界的日期与 0099 年', spec: { times: ['0099-01-01', '2026-13-01', '2026-02-30 25:61'], lines: [{ values: [1, 2, 3], step: true }] } },
  { name: '小数很细(净值)', spec: { times: days.slice(0, 10), lines: [{ values: days.slice(0, 10).map((_, i) => 0.998 + i * 0.0007) }] } },
  { name: '蝶价(yMin 0、稀疏蜡烛)', spec: { times: Array.from({ length: 12 }, (_, i) => min(i)), bars: [bar(min(2), 1.2, 1.4, 1.1, 1.3), bar(min(9), 0.3, 0.5, 0.05, 0.1)],
    lines: [{ values: Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? null : 0.2 + i * 0.1)), dash: [3, 2], width: 1.5 }], yMin: 0 } },
];

const out = { generator: 'native/tests/fixtures/gen_chart.mjs', specs: [], format: {}, viewport: [], layout: {} };
for (const { name, spec: s } of specs) {
  const e = engineFor(s, 0);
  const n = e.norm.times.length;
  const ranges = [];
  for (const [a, b] of [[0, n - 1], [0, 0], [Math.floor(n / 3), Math.floor((2 * n) / 3)], [n - 2, n - 1], [-3, 2]]) ranges.push({ a, b, range: e.priceRange(a, b) });
  const decimals = {};
  for (const h of [0, 220, 320, 440, 1000]) decimals[h] = engineFor(s, h).decimals();
  const readouts = [];
  for (let i = 0; i < n; i += 1) readouts.push(e.defaultReadout(i, 2));
  const ticks = e.norm.stamps.map((st) => ({ stamp: st, labels: [0, 1, 2, 3, 4].map((t) => e.tickMark(st, t)), crosshair: e.crosshairTime(st) }));
  out.specs.push({ name, spec: s, norm: { ...e.norm, idx: undefined }, ranges, cap: e.hasVolume ? e.cap() : 0, hasVolume: e.hasVolume, headerPx: e.headerPx, decimals, readouts, ticks,
    viewKey: s.viewKey ?? `${s.ariaLabel ?? ''}|${e.norm.times[0] ?? ''}` });
}

// ---- 格式 ----------------------------------------------------------------------------------
const nums = [0, 1e-9, 0.0004, 0.004, 0.03, 0.2, 0.9, 1, 1.7, 2.4, 3, 7.5, 9.99, 10, 33, 250, 999, 12345, -5, NaN, Infinity];
out.format.niceStep = [];
for (const span of [0, 0.0007, 0.06, 1, 4.2, 37, 512, 9999, 123456]) for (const target of [0, 1, 3, 5, 8, 12]) out.format.niceStep.push([span, target, niceStep(span, target)]);
out.format.decimalsFor = nums.map((v) => [v, decimalsFor(v)]);
out.format.fmtVol = [null, 0, 0.4, 0.5, 1.5, 2.5, 9999.4, 9999.5, 10000, 123456, 99999999, 1e8, 2.345e9, -3].map((v) => [v, fmtVol(v)]);
out.format.fmtPrice = [[1.005, 2], [7667.845, 2], [0.12345, 4], [-0.5, 0], [2.5, 0], [1e21, 2]].map(([p, d]) => [p, d, fmtPrice(p, d)]);
out.format.timeLabel = ['', '2026', '2026-08-21', '2026-08-21 09:30', '2026-08-21T09:30:15', '26-08', 'T1'].flatMap((t) => [[t, false, timeLabel(t)], [t, true, timeLabel(t, true)]]);
out.format.wallClock = ['2026-08-21', '20260821', '2026-08-21 09:30', '2026-08-21T09:30:59', '  2026-08-21 09:30  ', '2026-08-21 9:30', '2026-13-01', '0099-01-01', '0000-01-01', '9999-12-31 23:59:59', '2026-02-30 25:61', 'T1', '']
  .map((t) => [t, wallClockSeconds(t)]);

// ---- 刷新时视口怎么留 ------------------------------------------------------------------------
const keep = new Function('prevNorm', 'norm', 'prevRange', 'prevKey', 'key', `
  let result = null;
  const resetView = () => { result = { reset: true }; };
  const chart = { timeScale: () => ({ setVisibleLogicalRange: (r) => { result = { reset: false, range: r }; } }) };
  const viewKeyOf = () => key;
  const spec = null;
  const run = () => { ${keepSrc.replace(/resetView\(chart\)/g, 'resetView()')} };
  run();
  return result;`);
const series = (start, n) => spec.normalize({ times: Array.from({ length: n }, (_, i) => min(start + i)), lines: [{ values: Array.from({ length: n }, () => 1) }] });
for (const [label, pn, n, prevRange, sameKey] of [
  ['没缩放过', series(0, 30), series(0, 31), { from: 0, to: 29 }, true],
  ['从没看过', series(0, 30), series(0, 31), null, true],
  ['换了标的', series(0, 30), series(0, 31), { from: 10, to: 20 }, false],
  ['贴着最右边', series(0, 30), series(0, 32), { from: 15, to: 29 }, true],
  ['贴着最右边还留了空', series(0, 30), series(0, 32), { from: 15, to: 30.4 }, true],
  ['停在中间', series(0, 30), series(2, 30), { from: 8, to: 18 }, true],
  ['停在中间、左沿那根滚掉了', series(0, 30), series(12, 30), { from: 8.4, to: 18.4 }, true],
  ['左沿 x.5', series(0, 30), series(1, 30), { from: 6.5, to: 17.5 }, true],
  ['一根', series(0, 1), series(0, 2), { from: 0.6, to: 1 }, true],
  // 「缩放过」的门槛是左沿 > 0.5(差半根):两边各一个
  ['左沿 1.0(算缩放过)', series(0, 30), series(0, 31), { from: 1.0, to: 29 }, true],
  ['左沿 0.4(不算)', series(0, 30), series(0, 31), { from: 0.4, to: 29 }, true],
]) out.viewport.push({ label, prevTimes: pn.times, times: n.times, prevRange, sameKey, result: keep(pn, n, prevRange, 'k', sameKey ? 'k' : 'other') });

// ---- 避让 ----------------------------------------------------------------------------------
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
out.layout.tags = [];
for (let c = 0; c < 25; c += 1) {
  const n = 1 + Math.floor(rnd() * 7);
  const tags = Array.from({ length: n }, (_, i) => ({ id: i, y: +(rnd() * 300 - 20).toFixed(2), pinned: rnd() < 0.2 }));
  const h = [12, 20][c % 2];
  out.layout.tags.push({ tags, minY: c % 3 === 0 ? 0 : 25, maxY: 280, h, result: layout.layoutTags(tags.map((t) => ({ ...t })), c % 3 === 0 ? 0 : 25, 280, h).map((t) => ({ id: t.id, ly: t.ly })) });
}
out.layout.labels = [];
for (let c = 0; c < 15; c += 1) {
  const placed = [];
  const steps = [];
  for (let k = 0; k < 6; k += 1) {
    const rect = { x: +(rnd() * 80).toFixed(1), y: +(rnd() * 40).toFixed(1), w: 20 + Math.round(rnd() * 30), h: 12 };
    const dir = rnd() < 0.5 ? -1 : 1;
    steps.push({ rect: { ...rect }, dir, placed: { ...layout.placeLabel(placed, rect, dir) } });
  }
  out.layout.labels.push(steps);
}

// ---- 图表库那一半的场景(浏览器里量:native/tools/chart_harness.mjs + chart_capture.js → chart_scale.json) ----------
const sizes = { 'K线 PA(1066 × 440)': [1066, 440], '中号(600 × 320)': [600, 320], '矮的(400 × 220)': [400, 220], '宽的(1200 × 300)': [1200, 300] };
const scaleCases = [];
for (const k of [0, 1, 2, 11, 12]) for (const [sz, [w, h]] of Object.entries(sizes)) scaleCases.push({ name: `${specs[k].name} · ${sz}`, spec: specs[k].spec, w, h });
scaleCases.push({ name: '太窄', spec: specs[0].spec, w: 100, h: 300 });
scaleCases.push({ name: '数据不足', spec: specs[8].spec, w: 600, h: 320 });
scaleCases.push({ name: '大价位(比特币)', spec: { bars: days.map((d, i) => bar(d, 113000 + i * 37, 113400 + i * 37, 112700 + i * 37, 113200 + i * 37, 120 + i)) }, w: 600, h: 320 });
scaleCases.push({ name: '负数(盈亏)', spec: { times: days, lines: [{ values: days.map((_, i) => -800 + i * 60 - (i % 4) * 90), color: 'blue', label: '盈亏' }], hlines: [{ price: 0, color: 'label2' }] }, w: 600, h: 220 });
// 时间刻度的权重(哪一个写日期、哪一个加粗)在跨日、跨年时才走到天 / 12 时 / 6 时 / 3 时 / 时那几档;刻度间距的三个除数序列各有赢的时候
const wd = (from, count) => { const out = []; for (let t = Date.UTC(...from); out.length < count; t += 86400000) { const d = new Date(t); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); } return out; };
const wave = (i, base, amp) => base + Math.sin(i / 5) * amp + Math.cos(i / 13) * amp * 0.6;
const ohlc = (t, i, base, amp, v) => { const o = wave(i, base, amp), c = wave(i + 0.7, base, amp); return bar(t, +o.toFixed(2), +(Math.max(o, c) + amp * 0.15).toFixed(2), +(Math.min(o, c) - amp * 0.15).toFixed(2), +c.toFixed(2), v); };
const fiveMin = wd([2026, 7, 19], 4).flatMap((d) => Array.from({ length: 78 }, (_, k) => `${d} ${pad2(9 + Math.floor((30 + k * 5) / 60))}:${pad2((30 + k * 5) % 60)}`));
const hourly = wd([2026, 7, 17], 6).flatMap((d) => Array.from({ length: 16 }, (_, k) => `${d} ${pad2(4 + k)}:00`));
const yearEnd = wd([2025, 10, 3], 80);
scaleCases.push({ name: '5 分钟跨 4 个交易日(隔夜有缺口)', spec: { bars: fiveMin.map((t, i) => ohlc(t, i, 640, 4, 2000 + (i % 9) * 300)) }, w: 1066, h: 440 });
scaleCases.push({ name: '5 分钟跨 4 个交易日 · 中号', spec: { bars: fiveMin.map((t, i) => ohlc(t, i, 640, 4, 2000 + (i % 9) * 300)) }, w: 600, h: 320 });
scaleCases.push({ name: '小时线跨 6 天(含盘前盘后)', spec: { bars: hourly.map((t, i) => ohlc(t, i, 180, 3, 5e5 + (i % 7) * 4e4)) }, w: 1066, h: 440 });
scaleCases.push({ name: '小时线跨 6 天 · 宽的', spec: { bars: hourly.map((t, i) => ohlc(t, i, 180, 3, 5e5 + (i % 7) * 4e4)) }, w: 1200, h: 300 });
scaleCases.push({ name: '日线跨年', spec: { bars: yearEnd.map((t, i) => ohlc(t, i, 5900, 60, 3e9 + (i % 5) * 1e8)) }, w: 1066, h: 440 });
scaleCases.push({ name: '日线跨年 · 矮的', spec: { bars: yearEnd.map((t, i) => ohlc(t, i, 5900, 60, 3e9 + (i % 5) * 1e8)) }, w: 400, h: 220 });
// 价格区间一档一档放宽:刻度间距在 2 / 2.5 / 4 / 5 的倍数之间换(三个除数序列各自赢一次)
for (const span of [17, 19, 21, 23, 25, 27, 30, 34, 38, 44]) scaleCases.push({ name: `区间 ${span}`, spec: { times: days.slice(0, 20), lines: [{ values: days.slice(0, 20).map((_, i) => 100 + (span * ((i * 7) % 20)) / 19) }], volume: false }, w: 600, h: 320 });
writeFileSync(join(here, 'chart_scale_cases.json'), JSON.stringify(scaleCases, null, 1) + '\n');

writeFileSync(join(here, 'chart.json'), JSON.stringify(out, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v), 2) + '\n');
console.log(`chart.json: ${out.specs.length} 份 spec、${out.viewport.length} 个视口场景、${out.layout.tags.length} + ${out.layout.labels.length} 组避让`);
