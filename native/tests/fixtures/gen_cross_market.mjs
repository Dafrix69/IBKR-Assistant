// 生成 cross-market.json:engine-ts 的 crossMarket.ts(原模块现跑)。下一次开盘(各种偏移、钟点、宽限、写坏的偏移)、美股交易日的开盘、
// 跨两周每 20 分钟一次的时间窗、随机报价(缺的、null、串、NaN、Infinity、涨跌两侧、正好卡在门槛上)下要不要报、报成什么。
//   TZ=Asia/Shanghai ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_cross_market.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const X = await import(pathToFileURL(join(engine, 'dist/src/crossMarket.js')).href);

let seed = 0xc2055_77;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
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

const base = Date.parse('2026-10-12T00:00:00Z'); // 周一
const out = { markets: X.CROSS_MARKETS, symbols: X.CROSS_SYMBOLS, linger: X.CROSS_LINGER_MIN, next: [], session: [], windows: [], evals: [] };
for (let i = 0; i < 400; i += 1) {
  const now = pick([base + rnd() * 21 * 86_400_000, Date.parse('2026-12-31T23:30:00Z') + rnd() * 3 * 86_400_000, Date.parse('2027-03-13T00:00:00Z') + rnd() * 86_400_000 * 2]);
  const offset = pick(['+09:00', '+08:00', '-05:00', '+00:00', '+05:30', '+9:00', 'x', '', '+14:00', '-12:00', '+09:0x', '+0a:00', '+09-00']);
  const open = pick(['09:00', '09:30', '00:00', '23:59', '9:30', '24:00']);
  const grace = pick([0, 3600_000, 86_400_000, -3600_000]);
  out.next.push({ now, offset, open, grace, ...run(() => X.nextOpen(now, offset, open, grace)) });
}
out.next.push({ now: '__NaN__', offset: '+08:00', open: '09:30', grace: 0, ...run(() => X.nextOpen(NaN, '+08:00', '09:30', 0)) });
for (let i = 0; i < 300; i += 1) {
  const t = base + rnd() * 120 * 86_400_000;
  out.session.push({ t, out: X.usSessionStart(t) });
}
for (let t = base; t < base + 15 * 86_400_000; t += 20 * 60_000) out.windows.push({ now: t, out: enc(X.crossWindow(t)) });
// 夏令时切换附近(2026-11-01、2027-03-14)
for (let t = Date.parse('2026-10-29T00:00:00Z'); t < Date.parse('2026-11-04T00:00:00Z'); t += 37 * 60_000) out.windows.push({ now: t, out: enc(X.crossWindow(t)) });
for (let t = Date.parse('2027-03-11T00:00:00Z'); t < Date.parse('2027-03-17T00:00:00Z'); t += 37 * 60_000) out.windows.push({ now: t, out: enc(X.crossWindow(t)) });

const pctPool = [-2.5, -1.5, -1.49, -0.5, 0, 0.3, 1.5, 2.2, -3.333, NaN, Infinity, null, undefined, '−1', '-1', -1.234567, 4.5];
const quote = () => {
  const r = rnd();
  if (r < 0.08) return undefined;
  if (r < 0.12) return null;
  const q = { symbol: 'X', last: pick([12.5, null, undefined, 0, '7', 33.3]), change_pct: pick(pctPool) };
  if (rnd() < 0.1) delete q.change_pct;
  return q;
};
const symbols = ['EWY', 'KORU', 'ASHR', 'FXI', 'KWEB', 'YINN', 'SPY'];
const nows = [];
for (let i = 0; i < 40; i += 1) { const w = X.crossWindow(base + rnd() * 21 * 86_400_000); if (w) nows.push(w.start + rnd() * (w.last + 3600_000 - w.start)); }
for (let i = 0; i < 1500; i += 1) {
  const quotes = {};
  for (const s of symbols) { const q = quote(); if (q !== undefined) quotes[s] = q; }
  const usPct = pick([-2.5, -1.5, -1.49, -3, 2.1, 1.5, 0, null, NaN, Infinity, -1.7777, 5]);
  const now = rnd() < 0.85 && nows.length ? pick(nows) : base + rnd() * 21 * 86_400_000;
  const cfg = { pct: pick([1.5, 1, 0.3, 3, 0]), lag_pct: pick([1, 0.2, 2, 0.5]) };
  out.evals.push({ usPct: enc(usPct), quotes: enc(quotes), now, cfg, ...run(() => X.evaluateCrossMarket(usPct, quotes, now, cfg)) });
}
writeFileSync(join(here, 'cross-market.json'), JSON.stringify(out) + '\n');
console.log(`cross-market.json: ${out.windows.length} 个时刻, ${out.evals.length} 次判定, 报了 ${out.evals.filter((e) => e.out && e.out !== null).length}`);
