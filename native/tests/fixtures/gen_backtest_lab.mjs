// 生成 backtest_lab.json:engine-ts 的 backtestLab.ts(原模块现跑)——参数扫描的完整回执(样本内外、排名、秩相关与置换 p 值、
// 滚动前推、说明)在合成日线上的结果:一只到几只标的(交易日对不齐)、股票与期权、两种挑法、2~6 折、坏的网格与比例;
// 另有 gridCombos / alignSeries / spearman / spearmanP / checkGrid 的逐个输入。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_backtest_lab.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const L = await import(pathToFileURL(join(engine, 'dist/src/backtestLab.js')).href);

let seed = 0x1ab0_5eed;
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

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
function synthBars(n, start, vol, skip) {
  const bars = [];
  let t = Date.UTC(2024, 0, 2);
  let px = start;
  for (let i = 0; i < n; i += 1) {
    t += 86_400_000;
    while ([0, 6].includes(new Date(t).getUTCDay())) t += 86_400_000;
    if (rnd() < skip) continue;
    const open = px * Math.exp(gauss() * vol * 0.3);
    const close = open * Math.exp(gauss() * vol);
    bars.push({ date: isoOf(t), open, high: Math.max(open, close) * (1 + Math.abs(gauss()) * vol * 0.4), low: Math.min(open, close) * (1 - Math.abs(gauss()) * vol * 0.4), close });
    px = close;
  }
  return bars;
}

const out = { barSets: [], sweeps: [], combos: [], align: [], spearman: [], checks: [] };
for (let i = 0; i < 24; i += 1) out.barSets.push(synthBars(pick([35, 45, 60, 90, 130, 180]), pick([15, 60, 150, 400]), pick([0.008, 0.015, 0.03]), pick([0, 0, 0.05, 0.15])));
out.barSets.push(synthBars(20, 100, 0.01, 0));
// 一只标的里同一天出现两次(new Set 去重、filter 保留两根)
{ const b = synthBars(60, 80, 0.02, 0); b.splice(30, 0, { ...b[30] }); out.barSets.push(b); }

const gridFor = (strategy) => {
  const r = rnd();
  if (r < 0.04) return {};
  if (r < 0.07) return { bogus: [1, 2] };
  if (r < 0.09) return { fast: [] };
  if (r < 0.11) return { fast: Array.from({ length: 21 }, (_, i) => i + 1) };
  if (r < 0.13) return { toString: [3, 4], fast: [2, 3] };
  const g = {};
  if (strategy === 'sma_cross') {
    if (rnd() < 0.85) g.fast = pick([[2, 3, 5], [3, 5], [5, 10, 20], [2, 4, 6, 8], [3, NaN], [5]]);
    if (rnd() < 0.85) g.slow = pick([[8, 12], [10, 20, 30], [4, 6], [15], [6, 300]]);
  } else if (strategy === 'rsi') {
    if (rnd() < 0.8) g.period = pick([[2, 5, 9], [3, 14], [4]]);
    if (rnd() < 0.6) g.buy_below = pick([[25, 35], [30, 45, 55], [80]]);
    if (rnd() < 0.5) g.sell_above = pick([[60, 70], [55, 75, 85]]);
  } else {
    if (rnd() < 0.85) g.entry = pick([[3, 5, 10], [5, 8], [2, 3, 4, 6]]);
    if (rnd() < 0.7) g.exit = pick([[2, 3], [3, 5, 8], [4]]);
  }
  if (!Object.keys(g).length) g[pick(['fast', 'period', 'entry'])] = [3, 4];
  if (rnd() < 0.05) { const many = {}; for (const k of Object.keys(g)) many[k] = Array.from({ length: 15 }, (_, i) => i + 2); return many; }
  return g;
};
const longSets = out.barSets.map((b, i) => i).filter((i) => out.barSets[i].length >= 80);
for (let i = 0; i < 150; i += 1) {
  const clean = i < 110;
  const count = clean ? pick([1, 1, 1, 2, 2, 3]) : pick([1, 1, 1, 2, 2, 3, 9]);
  const sets = Array.from({ length: count }, () => (clean ? pick(longSets) : Math.floor(rnd() * out.barSets.length)));
  const series = sets.map((s, k) => ({ symbol: `S${k}${s}`, bars: out.barSets[s] }));
  const strategy = clean ? pick(['sma_cross', 'sma_cross', 'rsi', 'breakout', 'breakout']) : pick(['sma_cross', 'sma_cross', 'rsi', 'breakout', 'breakout', 'buy_hold', 'custom', 'nope', 'toString']);
  let grid = gridFor(strategy);
  if (clean) while (!Object.keys(grid).length || Object.values(grid).some((v) => !v.length || v.length > 15) || Object.hasOwn(grid, 'bogus') || Object.hasOwn(grid, 'toString')) grid = gridFor(strategy);
  const instrument = rnd() < 0.7 ? { type: 'stock' } : { type: pick(['call', 'put', 'call_spread', 'butterfly', 'put_spread']), dte: pick([5, 21, 30]), offset_pct: pick([0, 2]), width_pct: 2, risk_pct: pick([10, 25]) };
  const input = {
    series, strategy, grid, instrument, costPct: pick([0, 0, 0.1, 0.5]), splitPct: clean ? pick([50, 60, 70, 70, 75]) : pick([50, 60, 70, 70, 80, 90, 49, 91, NaN]),
    folds: clean ? pick([0, 2, 2, 3, 4]) : pick([0, 0, 2, 3, 4, 6, 1, 7, 2.5]), objective: pick(['return', 'calmar', 'calmar']),
  };
  out.sweeps.push({ sets, symbols: series.map((s) => s.symbol), strategy, grid: enc(grid), instrument, costPct: input.costPct, splitPct: enc(input.splitPct), folds: input.folds, objective: input.objective,
    ...run(() => L.runSweep(input)) });
}
// 长的一段(样本内满一年、样本外不满)与大网格:秩相关很高(p 到下限)、正好是 0 的那些分支
{
  const long1 = out.barSets.push(synthBars(460, 100, 0.012, 0)) - 1;
  const grids = [
    { fast: [2, 3, 4, 5, 6, 8, 10, 12, 15, 20], slow: [25, 30, 40, 50, 60, 80, 100, 120, 150, 200] },
    { entry: [2, 3, 5, 8, 10, 15, 20, 30, 40, 60], exit: [2, 3, 5, 8, 10, 15, 20, 30] },
    { period: [2, 3, 5, 7, 9, 14, 21, 30], buy_below: [20, 30, 40, 50], sell_above: [55, 65, 75, 85] },
    { fast: [3, 5], slow: [10, 20] },
  ];
  for (const [g, strategy] of [[0, 'sma_cross'], [1, 'breakout'], [2, 'rsi'], [3, 'sma_cross']]) {
    for (const [splitPct, objective] of [[70, 'return'], [70, 'calmar'], [85, 'return']]) {
      const input = { series: [{ symbol: 'LONG', bars: out.barSets[long1] }], strategy, grid: grids[g], instrument: { type: 'stock' }, costPct: 0.05, splitPct, folds: 3, objective };
      out.sweeps.push({ sets: [long1], symbols: ['LONG'], strategy, grid: grids[g], instrument: { type: 'stock' }, costPct: 0.05, splitPct, folds: 3, objective, ...run(() => L.runSweep(input)) });
    }
  }
}
// 秩相关正好是 0(四组、Σd² = 10):在长日线上找,找到两个就停(种子固定,找到的是同一组)
{
  let found = 0;
  for (let t = 0; t < 400 && found < 2; t += 1) {
    const set = pick(longSets);
    const f1 = 2 + Math.floor(rnd() * 6), s1 = 10 + Math.floor(rnd() * 30);
    const grid = { fast: [f1, f1 + 1 + Math.floor(rnd() * 4)], slow: [s1, s1 + 5 + Math.floor(rnd() * 20)] };
    const input = { series: [{ symbol: 'Z', bars: out.barSets[set] }], strategy: 'sma_cross', grid, instrument: { type: 'stock' }, costPct: 0, splitPct: pick([60, 70]), folds: 0, objective: pick(['return', 'calmar']) };
    let r;
    try { r = L.runSweep(input); } catch { continue; }
    if (r.rank_corr !== 0) continue;
    found += 1;
    out.sweeps.push({ sets: [set], symbols: ['Z'], strategy: 'sma_cross', grid, instrument: { type: 'stock' }, costPct: 0, splitPct: input.splitPct, folds: 0, objective: input.objective, out: enc(r) });
  }
  console.log('rank_corr 0 found', found);
}
out.sweeps.push({ sets: [], symbols: [], strategy: 'sma_cross', grid: { fast: [2] }, instrument: { type: 'stock' }, costPct: 0, splitPct: 70, folds: 0, objective: 'return',
  ...run(() => L.runSweep({ series: [], strategy: 'sma_cross', grid: { fast: [2] }, instrument: { type: 'stock' }, costPct: 0, splitPct: 70, folds: 0, objective: 'return' })) });

for (const g of [{}, { a: [1, 2], b: [3] }, { a: [], b: [1] }, { x: [1, 2, 3], y: [4, 5], z: [6, 7] }, JSON.parse('{"b": [1], "2": [3, 4], "a": [5]}'), { toString: [1, 2] }]) {
  out.combos.push({ grid: g, out: L.gridCombos(g) });
}
for (let i = 0; i < 30; i += 1) {
  const sets = Array.from({ length: pick([1, 2, 3]) }, () => Math.floor(rnd() * out.barSets.length));
  out.align.push({ sets, out: L.alignSeries(sets.map((s, k) => ({ symbol: `A${k}`, bars: out.barSets[s] }))).map((s) => ({ symbol: s.symbol, dates: s.bars.map((b) => b.date) })) });
}
for (let i = 0; i < 400; i += 1) {
  const n = pick([0, 1, 2, 3, 4, 5, 8, 13, 30, 60, 200]);
  const a = Array.from({ length: n }, () => (rnd() < 0.3 ? pick([1, 2, 3]) : Math.round(gauss() * 100) / 10));
  const b = rnd() < 0.15 ? Array.from({ length: n }, () => 7) : rnd() < 0.2 ? a.map((x) => x * 2 + gauss() * 0.1) : rnd() < 0.1 ? a.slice(1) : Array.from({ length: n }, () => Math.round(gauss() * 50) / 10);
  const draws = pick([0, 1, 10, 99, 999]);
  out.spearman.push({ a, b, draws, r: enc(L.spearman(a, b)), p: enc(L.spearmanP(a, b, draws)), pDefault: i < 60 ? enc(L.spearmanP(a, b)) : '__undefined__' });
}
for (const [strategy, grid, symbols] of [
  ['nope', { fast: [1] }, 1], ['custom', { fast: [1] }, 1], ['buy_hold', {}, 1], ['sma_cross', {}, 1], ['sma_cross', { bogus: [1] }, 1], ['sma_cross', { fast: [] }, 1],
  ['sma_cross', { fast: Array.from({ length: 21 }, (_, i) => i) }, 1], ['sma_cross', { fast: Array.from({ length: 20 }, (_, i) => i), slow: Array.from({ length: 11 }, (_, i) => i) }, 1],
  ['sma_cross', { fast: Array.from({ length: 20 }, (_, i) => i), slow: Array.from({ length: 10 }, (_, i) => i) }, 4], ['sma_cross', { fast: Array.from({ length: 20 }, (_, i) => i), slow: Array.from({ length: 10 }, (_, i) => i) }, 5],
  ['toString', { fast: [1] }, 1], ['__proto__', { x: [1] }, 1], ['constructor', {}, 1], ['rsi', { valueOf: [1, 2] }, 1], ['breakout', { entry: [1], exit: [2] }, 400], ['breakout', { entry: [1], exit: [2] }, 800], ['breakout', { entry: [1], exit: [2] }, 801],
]) out.checks.push({ strategy, grid, symbols, ...run(() => { L.checkGrid(strategy, grid, symbols); return null; }) });

writeFileSync(join(here, 'backtest_lab.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
console.log('backtest_lab.json', Object.entries(out).map(([k, v]) => `${k}=${v.length}`).join(' '));
