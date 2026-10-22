// 生成 inference.json:engine-ts 的 inference.ts(原模块现跑):t 分布、Wilson / t / Welch / 秩和 / Newcombe / 中位数区间、按簇的三种。
// 样本大小从 0 到几百,有并列、全相等、单簇、一簇一个、两组共簇与不共簇;自由度有非整数与 < 1 的(logGamma 走到 sin 那一支)。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_inference.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const I = await import(pathToFileURL(join(engine, 'dist/src/inference.js')).href);

let seed = 0x1f0e_2d3c;
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

const sample = () => {
  const n = pick([0, 1, 2, 3, 5, 6, 7, 10, 25, 60, 200]);
  const kind = pick(['normal', 'skew', 'ties', 'const', 'int']);
  return Array.from({ length: n }, () => kind === 'normal' ? gauss() * 100 : kind === 'skew' ? Math.exp(gauss() * 1.5) * 50 - 40
    : kind === 'ties' ? pick([1, 2, 2, 3, 5]) : kind === 'const' ? 7 : Math.floor(rnd() * 20) - 10);
};
const clustered = (xs) => {
  const k = pick([1, 2, 3, 5, 20]);
  return xs.map((value) => ({ value, cluster: `2026-10-${String(1 + Math.floor(rnd() * k)).padStart(2, '0')}` }));
};

const out = { gamma: [], beta: [], tcdf: [], tq: [], wilson: [], mean: [], median: [], cmean: [], cdiff: [], cwilson: [], welch: [], mw: [], pdiff: [] };
for (const x of [0.1, 0.25, 0.4999, 0.5, 0.75, 1, 1.5, 2, 3.7, 10, 50, 171, 1e-5, ...Array.from({ length: 60 }, () => rnd() * 30)]) out.gamma.push({ x, out: enc(I.logGamma(x)) });
for (let i = 0; i < 300; i += 1) {
  const x = pick([0, 1, -0.1, 1.1, rnd(), rnd(), 0.5, 1e-9, 1 - 1e-9]), a = pick([0.25, 0.5, 1, 2.5, 10, 30 * rnd() + 0.1]), b = pick([0.5, 1, 3, 20 * rnd() + 0.1]);
  out.beta.push({ x, a, b, out: enc(I.incompleteBeta(x, a, b)) });
}
for (let i = 0; i < 400; i += 1) {
  const t = pick([0, -0, 1, -1, 2.5, -40, 1e6, NaN, gauss() * 3]), df = pick([0, -1, 0.3, 0.9, 1, 2, 4.37, 30, 1e4, rnd() * 50, NaN]);
  out.tcdf.push({ t: enc(t), df: enc(df), out: enc(I.tCdf(t, df)) });
}
for (let i = 0; i < 300; i += 1) {
  const p = pick([0.975, 0.5, 0.025, 0.9, 0, 1, rnd(), 0.999999]), df = pick([0.6, 1, 2, 3.3, 9, 59, 1e3, rnd() * 20, 0]);
  out.tq.push({ p, df, out: enc(I.tQuantile(p, df)) });
}
for (let i = 0; i < 300; i += 1) {
  const n = pick([0, 1, 2, 5, 10, 100, -1, 33.3, NaN]), s = pick([0, 1, n, Math.floor(rnd() * 12), 2.5]);
  out.wilson.push({ s: enc(s), n: enc(n), out: enc(I.wilsonInterval(s, n)) });
}
for (let i = 0; i < 300; i += 1) {
  const xs = sample(), level = pick([0.95, 0.9, 0.99]);
  out.mean.push({ xs, level, out: enc(I.meanInterval(xs, level)) });
  out.median.push({ xs, level, out: enc(I.medianInterval(xs, level)) });
  const a = clustered(xs), b = clustered(sample());
  out.cmean.push({ a, level, out: enc(I.clusteredMeanInterval(a, level)) });
  out.cdiff.push({ a, b, level, out: enc(I.clusteredDiffInterval(a, b, level)) });
  const hits = a.map((o) => ({ hit: o.value > 0, cluster: o.cluster }));
  out.cwilson.push({ hits, out: enc(I.clusteredWilsonInterval(hits)) });
  const ys = sample();
  out.welch.push({ a: xs, b: ys, level, out: enc(I.welchInterval(xs, ys, level)) });
  out.mw.push({ a: xs, b: ys, out: enc(I.mannWhitneyZ(xs, ys)) });
  const x1 = Math.floor(rnd() * 10), n1 = pick([0, 5, 10, 30]), x2 = Math.floor(rnd() * 10), n2 = pick([0, 5, 12]);
  out.pdiff.push({ x1, n1, x2, n2, out: enc(I.proportionDiffInterval(x1, n1, x2, n2)) });
}
out.mw.push({ a: enc([1, NaN]), b: [2], out: enc(I.mannWhitneyZ([1, NaN], [2])) });
// 连续性修正的边:u − n_a·n_b/2 正好是 ±0.5 的那几组(小样本里穷举出来)
{
  let found = 0;
  const vals = [1, 2, 3];
  for (let na = 1; na <= 3 && found < 12; na += 1) for (let nb = 1; nb <= 3 && found < 12; nb += 1) {
    const combos = (n) => (n === 0 ? [[]] : combos(n - 1).flatMap((c) => vals.map((v) => [...c, v])));
    for (const a of combos(na)) for (const b of combos(nb)) {
      const all = [...a.map((v) => ({ v, first: true })), ...b.map((v) => ({ v, first: false }))].sort((x, y) => x.v - y.v);
      let rankSum = 0;
      for (let i = 0; i < all.length;) { let j = i; while (j < all.length && all[j].v === all[i].v) j += 1; for (let k = i; k < j; k += 1) if (all[k].first) rankSum += (i + 1 + j) / 2; i = j; }
      const d = rankSum - (na * (na + 1)) / 2 - (na * nb) / 2;
      if (Math.abs(d) === 0.5 && found < 12) { out.mw.push({ a, b, out: enc(I.mannWhitneyZ(a, b)) }); found += 1; }
    }
  }
}
// 两组共簇、此消彼长:交叉项计入
{
  const a = [], b = [];
  for (let d = 1; d <= 8; d += 1) {
    const day = `2026-10-${String(d).padStart(2, '0')}`;
    const swing = gauss() * 50;
    a.push({ value: swing, cluster: day }, { value: swing + 3, cluster: day });
    b.push({ value: -swing, cluster: day });
  }
  out.cdiff.push({ a, b, level: 0.95, out: enc(I.clusteredDiffInterval(a, b)) });
}

writeFileSync(join(here, 'inference.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
console.log('inference.json', Object.entries(out).map(([k, v]) => `${k}=${v.length}`).join(' '));
