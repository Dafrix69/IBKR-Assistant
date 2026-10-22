// 生成 screener_engine.json:engine-ts 的 screener.ts(原模块现跑)在黄金基线(RS 强度 3 组、周线、CD 背离 18 个、拐点 2 组、偏离 21 个)
// 与合成 K 线上的结果(screener.json 这个名字是扫描页的界面夹具占着的,这里是引擎那一份)。
// 合成的:日线与分钟线、有坏根(缺字段、串、负价、无穷、负量、没有量)、日期写坏;RS 的成员带 tag / company / error、自定义窗口;
// CD 背离换 strength / maxSpan / maxAge / 均线周期(0、负数、小数、比根数还长);偏离换周期 / 回看 / 平滑 / 极值线 / 留几根(含 NaN、0)。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_screener_engine.mjs <编过的 engine-ts 目录>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hunt, mutantOf } from './mutant_hunt.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const S = await import(pathToFileURL(join(engine, 'dist/src/screener.js')).href);

let seed = 0x5c4e_e7e1;
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

const golden = JSON.parse(readFileSync(join(engine, 'baseline/golden/screener.json'), 'utf8'));
const store = JSON.parse(readFileSync(join(engine, 'baseline/golden/_bars.json'), 'utf8'));
const deep = (v) => {
  if (Array.isArray(v)) return v.map(deep);
  if (v && typeof v === 'object') {
    if (typeof v.$bars === 'string' && Object.keys(v).length === 1) return deep(store[v.$bars]);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
  }
  return v;
};
const g = deep(golden);
// 夹具里的 K 线只留模块读的字段
const keepKeys = ['date', 'time', 'open', 'high', 'low', 'close', 'volume'];
const trim = (bars) => (Array.isArray(bars) ? bars.map((b) => (b && typeof b === 'object' ? Object.fromEntries(keepKeys.filter((k) => k in b).map((k) => [k, b[k]])) : b)) : bars);

const out = { golden: { rs: [], weekly: null, cd: [], inflections: [], deviation: [] }, hunted: [], sets: [], rs: [], weekly: [], cd: [], inflections: [], deviation: [] };
for (const c of g.rs) {
  const members = c.members.map((m) => ({ ...m, bars: trim(m.bars) }));
  out.golden.rs.push({ members, bench: trim(c.bench), benchmark: c.benchmark, windows: enc(c.windows), ...run(() => S.rsStrength(members, c.bench, c.benchmark, c.windows ?? S.RS_WINDOWS)) });
}
out.golden.weekly = { bars: trim(g.weekly.bars), ...run(() => S.resampleWeekly(g.weekly.bars)) };
for (const c of g.cd) out.golden.cd.push({ bars: trim(c.bars), kw: c.kw, ...run(() => S.cdDivergence(c.bars, c.kw.ma_period ?? null, S.DEFAULT_PIVOT_STRENGTH, S.DEFAULT_MAX_SPAN, c.kw.max_age ?? S.DEFAULT_MAX_AGE)) });
for (const c of g.inflections) {
  const members = c.members.map((m) => ({ ...m, frames: m.frames ? Object.fromEntries(Object.entries(m.frames).map(([k, v]) => [k, trim(v)])) : m.frames }));
  out.golden.inflections.push({ members, timeframes: c.timeframes, ma_period: enc(c.ma_period ?? null), ...run(() => S.screenInflections(members, c.timeframes, c.ma_period ?? null)) });
}
for (const c of g.deviation) {
  const kw = c.kw;
  out.golden.deviation.push({ bars: trim(c.bars), kw, ...run(() => S.deviationReview(c.bars, kw.period ?? S.DEFAULT_DEV_PERIOD, kw.lookback ?? S.DEFAULT_DEV_LOOKBACK,
    kw.smooth ?? S.DEFAULT_PRESSURE_SMOOTH, kw.z_extreme ?? S.DEFAULT_Z_EXTREME, kw.keep ?? S.DEFAULT_KEEP)) });
}

// ---------------------------------------------------------------- 合成 K 线
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
function synth(n, opts) {
  const bars = [];
  let t = Date.UTC(2025, pick([0, 3, 7]), 1 + Math.floor(rnd() * 25)), px = opts.start, phase = rnd() * 6;
  for (let i = 0; i < n; i += 1) {
    if (opts.intraday) t += 5 * 60_000; else { t += 86_400_000; while ([0, 6].includes(new Date(t).getUTCDay()) || rnd() < opts.holiday) t += 86_400_000; }
    // 带一点周期的随机游走:摆动点与背离才会出现
    const drift = Math.sin(i / opts.cycle + phase) * opts.vol * opts.wave;
    const open = px * Math.exp(gauss() * opts.vol * 0.3);
    const close = open * Math.exp(gauss() * opts.vol + drift);
    const round = (x) => (opts.round ? Math.round(x * 100) / 100 : x);
    const bar = { open: round(open), high: round(Math.max(open, close) * (1 + Math.abs(gauss()) * opts.vol * 0.4)), low: round(Math.min(open, close) * (1 - Math.abs(gauss()) * opts.vol * 0.4)), close: round(close) };
    if (opts.intraday) bar.time = `${isoOf(t)} ${pad(new Date(t).getUTCHours())}:${pad(new Date(t).getUTCMinutes())}`; else bar[opts.timeKey] = isoOf(t);
    if (rnd() < opts.volShare) bar.volume = Math.round(Math.exp(gauss() * 0.5 + (rnd() < 0.05 ? 2 : 0)) * 1e5);
    bars.push(bar);
    px = close;
  }
  for (let k = 0; k < opts.junk; k += 1) {
    const b = bars[Math.floor(rnd() * n)];
    if (!b) break;
    const r = rnd();
    if (r < 0.2) b.close = pick([null, '12', -1, 0, Infinity]);
    else if (r < 0.35) delete b.high;
    else if (r < 0.5) b.volume = pick([-5, 'x', null, NaN, 0]);
    else if (r < 0.6) b.low = b.high * 1.01;
    else if (r < 0.7) b.date = pick(['2025-13-01', '', 'bad', '2025-02-30', '2025-1-5']);
    else if (r < 0.8) { delete b.date; delete b.time; }
    else b.open = pick([0, -3, '5']);
  }
  return bars;
}
const opts = () => ({
  start: pick([3, 20, 80, 300, 2500]), vol: pick([0.005, 0.012, 0.025, 0.05]), wave: pick([0, 0.3, 0.8, 1.5]), cycle: pick([3, 5, 8, 15]),
  intraday: rnd() < 0.2, holiday: pick([0, 0.05]), volShare: pick([1, 1, 0.9, 0]), junk: pick([0, 0, 0, 1, 3]), round: rnd() < 0.4, timeKey: pick(['date', 'date', 'time']),
});
for (let i = 0; i < 60; i += 1) out.sets.push(synth(pick([0, 1, 5, 21, 22, 39, 40, 41, 60, 80, 120, 160, 260]), opts()));
// 挑出带背离的:随机生成、按默认参数能出信号的留下(种子固定,留下的是同一批)
for (let t = 0, kept = 0; t < 6000 && kept < 50; t += 1) {
  const o = { ...opts(), junk: 0, wave: pick([0.8, 1.5, 2.5]), cycle: pick([3, 4, 6]), intraday: rnd() < 0.3 };
  const bars = synth(pick([60, 90, 140]), o);
  if (S.cdDivergence(bars).signal === null) continue;
  out.sets.push(bars);
  kept += 1;
}
// 整数价位的震荡:摆动点左右打平、收盘正好落在均线上;再挑出其中能出信号的
for (let t = 0, kept = 0; t < 4000 && kept < 14; t += 1) {
  let px = 100;
  const n = pick([60, 90]);
  const bars = Array.from({ length: n }, (_, i) => {
    const open = px;
    px = Math.max(80, Math.min(120, Math.round(px + Math.sin(i / pick([3, 4, 5])) * 3 + pick([-2, -1, 0, 1, 2]))));
    return { date: isoOf(Date.UTC(2025, 1, 1) + i * 86_400_000), open, high: Math.max(open, px) + pick([0, 1]), low: Math.min(open, px) - pick([0, 1]), close: px, volume: 1000 };
  });
  if (kept < 4 || S.cdDivergence(bars, 5).signal !== null) { out.sets.push(bars); kept += 1; }
}
// 读不出的数:无穷、NaN;最高价低于开盘价、最低价高于收盘价(clean 会改过来)
{
  const b = synth(60, { ...opts(), junk: 0 });
  b[5].close = Infinity; b[9].high = -Infinity; b[12].open = NaN; b[20].low = Infinity; b[25].volume = Infinity;
  for (const k of [30, 31, 40, 50, 59]) { b[k].high = Math.min(b[k].open, b[k].close) * 0.99; b[k].low = Math.max(b[k].open, b[k].close) * 1.01; }
  out.sets.push(b);
}
// 开盘价比最高价和收盘价都高(clean 把 high 抬到开盘价)
{
  const b = synth(70, { ...opts(), junk: 0, wave: 1.5, cycle: 5 });
  for (const k of [10, 25, 33, 47, 60]) { b[k].open = Math.max(b[k].high, b[k].close) * 1.02; }
  out.sets.push(b);
}
// 平的:均线等于价、DIF 正好是 0、真实区间是 0
out.sets.push(Array.from({ length: 50 }, (_, i) => ({ date: isoOf(Date.UTC(2025, 0, 1) + i * 86_400_000), open: 10, high: 10, low: 10, close: 10, volume: 100 })));
out.sets.push([null]);
const setOf = () => Math.floor(rnd() * (out.sets.length - 1));

for (let i = 0; i < 45; i += 1) {
  const members = Array.from({ length: pick([0, 1, 3, 6, 10]) }, () => {
    const m = { symbol: pick(['nvda', 'AMD', 'tsm', 'avgo', 'mu', 'Vrt', '', 'aapl']), bars: rnd() < 0.05 ? pick([null, undefined, 'x']) : out.sets[setOf()] };
    if (rnd() < 0.8) m.tag = pick(['芯片', '电力', ' 网络 ', '', null, 5]);
    if (rnd() < 0.6) m.company = pick(['Nvidia', '', 7]);
    if (rnd() < 0.1) m.error = pick(['timeout', '', 0, { x: 1 }]);
    if (rnd() < 0.05) m.symbol = pick([null, 5]);
    return m;
  });
  const bench = rnd() < 0.1 ? pick([null, [], undefined]) : out.sets[setOf()];
  const windows = rnd() < 0.7 ? undefined : pick([[1, 2, 5], [5.5, 3], [20, 20], [0, -0, 400], [10, 1]]);
  out.rs.push({ members: members.map((m) => ({ ...m, bars: m.bars === undefined ? '__undefined__' : m.bars === null ? null : typeof m.bars === 'string' ? m.bars : out.sets.indexOf(m.bars) })),
    bench: bench === undefined ? '__undefined__' : out.sets.includes(bench) ? out.sets.indexOf(bench) : enc(bench), windows: enc(windows),
    ...run(() => S.rsStrength(members, bench, 'SPY', windows ?? S.RS_WINDOWS)) });
}
for (let i = 0; i < out.sets.length; i += 1) if (i < 60 || i % 4 === 0) out.weekly.push({ set: i, ...run(() => S.resampleWeekly(out.sets[i])) });
for (const b of [{}, 5, 'ab', null, undefined]) out.weekly.push({ raw: enc(b), ...run(() => S.resampleWeekly(b)) });
for (let i = 0; i < 320; i += 1) {
  const set = i % 2 ? out.sets.length - 2 - (i % 52) : setOf();
  const ma = pick([null, null, 5, 10, 20, 0, -3, 2.7, 1000, 60]);
  const strength = pick([3, 3, 2, 1, 4]), maxSpan = pick([60, 60, 20, 5]), maxAge = pick([12, 12, 3, 30, 0]);
  out.cd.push({ set, ma: enc(ma), strength, maxSpan, maxAge, ...run(() => S.cdDivergence(out.sets[set], ma, strength, maxSpan, maxAge)) });
}
for (let i = 0; i < 30; i += 1) {
  const tfs = pick([['1d', '1w'], ['1d'], ['15m', '1h', '1d'], [], ['1d', '1d']]);
  const members = Array.from({ length: pick([1, 3, 6]) }, () => {
    const frames = {};
    for (const tf of tfs) if (rnd() < 0.85) frames[tf] = out.sets[setOf()];
    const m = { symbol: pick(['nvda', 'AMD', 'tsm', 'mu']), tag: pick(['芯片', '', undefined]), company: pick(['X', undefined]), frames: rnd() < 0.05 ? undefined : frames };
    if (rnd() < 0.3) m.errors = { [pick(tfs.length ? tfs : ['1d'])]: pick(['超时', '', 0, 'x']) };
    return m;
  });
  const ma = pick([null, 5, 20, 0]);
  const enc2 = members.map((m) => ({ ...m, frames: m.frames === undefined ? '__undefined__' : Object.fromEntries(Object.entries(m.frames).map(([k, v]) => [k, out.sets.indexOf(v)])) }));
  out.inflections.push({ members: enc(enc2), timeframes: tfs, ma: enc(ma), ...run(() => S.screenInflections(members, tfs, ma)) });
}
for (let i = 0; i < 110; i += 1) {
  const set = setOf();
  const kw = [pick([20, 20, 5, 2, 1, 50, 1.9, NaN]), pick([120, 120, 20, 5, 60, NaN, Infinity]), pick([5, 5, 1, 2, 0, 3.5, NaN]), pick([2, 2, 1.5, 0.5, NaN]), pick([120, 120, 120, 120, 30, 30, 5, 1, 0, -1, NaN, 1000])];
  out.deviation.push({ set, kw: enc(kw), ...run(() => S.deviationReview(out.sets[set], ...kw)) });
}

// 极值线正好等于最后一根的 z(z 舍到两位,≥ / ≤ 的边界);平滑周期比根数还长(压力全是 null)
for (let i = 0, done = 0; i < out.deviation.length && done < 12; i += 1) {
  const c = out.deviation[i];
  const z = c.out?.last?.z;
  if (typeof z !== 'number' || z === 0) continue;
  for (const ze of [Math.abs(z)]) {
    const kw = [...c.kw.map((v) => (v === '__NaN__' ? NaN : v === '__Inf__' ? Infinity : v))];
    kw[3] = ze;
    out.deviation.push({ set: c.set, kw: enc(kw), ...run(() => S.deviationReview(out.sets[c.set], ...kw)) });
  }
  done += 1;
}
for (const set of [1, 2, 3, out.sets.length - 3]) {
  const kw = [20, 120, 1000, 2, 120];
  out.deviation.push({ set, kw, ...run(() => S.deviationReview(out.sets[set], ...kw)) });
}
// 找探针(变异测试里活下来的边界改动,见 mutant_hunt.mjs):整数格点上的带周期的 K 线,偶尔夹无穷、开盘价顶出最高价
function* cdCandidates() {
  for (;;) {
    const n = pick([60, 80, 100, 130]);
    const cycle = pick([3, 4, 5, 7]);
    let px = 100;
    const bars = [];
    for (let i = 0; i < n; i += 1) {
      const open = px;
      px = Math.max(70, Math.min(140, Math.round(px + Math.sin(i / cycle) * pick([1, 3, 5]) + pick([-2, -1, 0, 1, 2]))));
      const bar = { date: isoOf(Date.UTC(2025, 1, 1) + i * 86_400_000), open, high: Math.max(open, px) + pick([0, 1, 2]), low: Math.min(open, px) - pick([0, 1, 2]), close: px, volume: 1000 };
      if (rnd() < 0.03) bar.open = bar.high + pick([1, 3]);
      if (rnd() < 0.02) bar[pick(['high', 'close', 'low'])] = pick([Infinity, -Infinity, NaN]);
      bars.push(bar);
    }
    yield { bars, ma: pick([null, 3, 5, 10, 20]) };
  }
}
const SC_HUNTS = [
  ['有限数', 'typeof value === "number" && Number.isFinite(value)', 'typeof value === "number"'],
  ['高点抬到开盘价', 'high: Math.max(h, o, c)', 'high: Math.max(h, c)'],
  ['顶背离 DIF 为正', 'd2 < d1 && d1 > 0 && d2 > 0', 'd2 < d1 && d1 > 0'],
  ['上穿 均线 打平', 'closes[i - 1] <= prevMa && closes[i] > curMa', 'closes[i - 1] < prevMa && closes[i] > curMa'],
  ['两种背离同一根', 'isBull = last - bull.p2 <= last - bear.p2', 'isBull = last - bull.p2 < last - bear.p2'],
];
out.hunted = [];
for (const [label, from, to] of SC_HUNTS) {
  let M;
  try { M = await mutantOf(engine, 'screener', [[from, to]]); } catch (e) { console.log('HUNT-SKIP', label, e.message); continue; }
  const call = (X) => (c) => X.cdDivergence(c.bars, c.ma);
  const { found, tried } = hunt(cdCandidates(), call(S), call(M), 2, 30000);
  console.log('HUNT', label, found.length, tried);
  for (const c of found) {
    const set = out.sets.push(c.bars) - 1;
    out.cd.push({ set, ma: enc(c.ma), strength: 3, maxSpan: 60, maxAge: 12, ...run(() => S.cdDivergence(c.bars, c.ma, 3, 60, 12)) });
  }
}
writeFileSync(join(here, 'screener_engine.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out, golden: enc(out.golden), sets: out.sets.map(enc) }) + '\n');
console.log('screener_engine.json', Object.entries(out).map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : '-'}`).join(' '));
