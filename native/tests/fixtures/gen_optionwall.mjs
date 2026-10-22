// 生成 optionwall.json:engine-ts 的 optionwall.ts(原模块现跑)。黄金基线的 3 条链与 2 句报错、bsGamma / yearsToExpiry 的基线输入,
// 外加合成的链:SPX 当日到期与月度(按开盘价结算的 SPX 带不带交易类别)、个股周度;有的行只有券商 gamma、只有 IV、两样都没有;
// 未平仓量没等到 / 是串 / 负数 / NaN;right 小写、写成 call、空;行权价重复、为 0、是串、缺;链上只有 4 个行权价;现价是 0 / NaN;
// 做市商净 gamma 接近 0(翻转位与净 GEX 对不上、不给);乘数不是 100。另有 toRows、bsGamma、yearsToExpiry、GEX 几个函数的随机输入与 levelsForPa 的松记录。
// 定价走 Math.log / exp,要用打包版应用里那个运行时生成:
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_optionwall.mjs <编过的 engine-ts 目录>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const W = await import(pathToFileURL(join(engine, 'dist/src/optionwall.js')).href);

let seed = 0x0a11_7a11;
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

const out = { analyze: [], rows: [], gamma: [], years: [], gex: [], levels: [] };
// ---------------------------------------------------------------- 黄金基线
const golden = JSON.parse(readFileSync(join(engine, 'baseline/golden/optionwall.json'), 'utf8'));
const call = (c) => run(() => {
  const r = W.analyze(c.rows, c.spot, c.expiry, c.symbol, c.multiplier, c.now, c.tradingClass);
  return { result: r, levels: W.levelsForPa(r) };
});
const addCase = (name, rows, spot, expiry, symbol, multiplier, now, tradingClass) => {
  const c = { name, rows: enc(rows), spot: enc(spot), expiry, symbol, multiplier: enc(multiplier), now: enc(now), tradingClass };
  out.analyze.push({ ...c, ...call({ rows, spot, expiry, symbol, multiplier, now, tradingClass }) });
};
for (const c of golden.cases) addCase(c.name, c.rows, c.spot, c.expiry, c.symbol, W.MULTIPLIER, Date.parse(c.now), '');
addCase('no_spot', [], 0.0, '20260918', '', W.MULTIPLIER, null, '');
addCase('few_strikes', golden.cases[0].rows.slice(0, 6), golden.cases[0].spot, '20260918', '', W.MULTIPLIER, null, '');
for (const c of golden.bs_gamma) out.gamma.push({ ...c, out: enc(W.bsGamma(c.spot, c.strike, c.t, c.sigma)) });
for (const c of golden.years_to_expiry) out.years.push({ expiry: c.expiry, now: Date.parse(c.now), symbol: '', tc: '', out: enc(W.yearsToExpiry(c.expiry, Date.parse(c.now))) });

// ---------------------------------------------------------------- 合成的链
const now0 = Date.parse('2026-10-16T14:05:00Z');
const chain = (opts) => {
  const rows = [];
  const step = opts.step, center = Math.round(opts.spot / step) * step;
  for (let i = -opts.half; i <= opts.half; i += 1) {
    const strike = center + i * step;
    for (const right of ['C', 'P']) {
      const m = Math.log(strike / opts.spot);
      const iv = Math.max(0.05, opts.iv + 0.6 * m * m - 0.2 * m + 0.01 * gauss());
      const row = { strike, right, oi: Math.round(Math.max(0, 2000 * Math.exp(-((i / (opts.half / 2)) ** 2)) * (0.5 + rnd()) * (right === 'P' ? opts.putTilt : 1))),
        volume: Math.round(Math.max(0, 800 * Math.exp(-((i / 4) ** 2)) * rnd())) };
      const g = rnd();
      if (g < opts.ivShare) row.iv = Math.round(iv * 1e4) / 1e4;
      if (rnd() < opts.gammaShare) row.gamma = Math.round(W.bsGamma(opts.spot, strike, opts.t, iv) * (1 + 0.2 * gauss()) * 1e6) / 1e6;
      if (rnd() < opts.junk) {
        const j = pick(['oiNull', 'oiStr', 'oiNeg', 'oiNaN', 'oiMissing', 'rightLower', 'rightWord', 'rightEmpty', 'strikeStr', 'strikeNull', 'strikeZero', 'volStr', 'volNull', 'ivZero', 'gammaNeg', 'gammaStr']);
        if (j === 'oiNull') row.oi = null; else if (j === 'oiStr') row.oi = String(row.oi); else if (j === 'oiNeg') row.oi = -5; else if (j === 'oiNaN') row.oi = 'x';
        else if (j === 'oiMissing') delete row.oi; else if (j === 'rightLower') row.right = right.toLowerCase(); else if (j === 'rightWord') row.right = right === 'C' ? 'call' : 'Put';
        else if (j === 'rightEmpty') row.right = pick(['', null, 'X']); else if (j === 'strikeStr') row.strike = String(strike); else if (j === 'strikeNull') row.strike = null;
        else if (j === 'strikeZero') row.strike = pick([0, -5]); else if (j === 'volStr') row.volume = '12'; else if (j === 'volNull') row.volume = null;
        else if (j === 'ivZero') row.iv = pick([0, -0.2, '0.3', null]); else if (j === 'gammaNeg') row.gamma = -0.001; else row.gamma = '0.002';
      }
      rows.push(row);
    }
  }
  if (opts.dupes) rows.push(...rows.slice(0, 4).map((r) => ({ ...r })));
  return rows;
};
const specs = [
  { symbol: 'SPX', spot: 6712.35, step: 5, half: 30, iv: 0.12, t: 2 / (365 * 24), expiry: '20261016', tc: 'SPXW' },
  { symbol: 'SPX', spot: 6712.35, step: 25, half: 20, iv: 0.16, t: 0.08, expiry: '20261120', tc: 'SPX' },
  { symbol: 'SPX', spot: 6712.35, step: 25, half: 20, iv: 0.16, t: 0.08, expiry: '20261120', tc: '' },
  { symbol: 'NVDA', spot: 141.7, step: 2.5, half: 12, iv: 0.45, t: 7 / 365, expiry: '20261023', tc: 'NVDA' },
  { symbol: 'SPY', spot: 670.12, step: 1, half: 15, iv: 0.14, t: 1 / 365, expiry: '20261017', tc: '' },
  { symbol: '', spot: 100, step: 0.5, half: 8, iv: 0.3, t: 0.02, expiry: '', tc: '' },
];
for (let i = 0; i < 110; i += 1) {
  const s = pick(specs);
  const opts = { ...s, ivShare: pick([1, 1, 0.7, 0.2, 0]), gammaShare: pick([0, 0.5, 1, 1]), putTilt: pick([1, 1.5, 0.6, 3]), junk: pick([0, 0, 0.05, 0.2]), dupes: rnd() < 0.1,
    spot: s.spot * (1 + 0.01 * gauss()), half: rnd() < 0.05 ? 1 : s.half };
  const rows = chain(opts);
  const spot = rnd() < 0.04 ? pick([0, -1, NaN]) : Math.round(opts.spot * 100) / 100;
  const expiry = rnd() < 0.08 ? pick(['bogus', '20260231', '2026101', '00500101', '20261016 ']) : opts.expiry;
  addCase(`synth${i}`, rows, spot, expiry, s.symbol, pick([100, 100, 100, 50, 10]), pick([now0, now0, now0 + 3 * 3600_000, Date.parse('2026-10-16T21:00:00Z')]), s.tc);
}
// 做市商净 gamma 接近 0:看涨看跌对称(翻转位常在现价附近、与券商 gamma 的正负对不上)
for (let i = 0; i < 30; i += 1) {
  const spot = 500 + gauss();
  const rows = [];
  for (let k = 480; k <= 520; k += 5) for (const right of ['C', 'P']) {
    const iv = 0.2 + 0.0005 * (k - 500) ** 2 / 10;
    rows.push({ strike: k, right, oi: 1000 + Math.round(200 * gauss()), volume: 10, iv, gamma: Math.round(W.bsGamma(spot, k, 0.05, iv) * (right === 'C' ? 0.8 + 0.4 * rnd() : 1) * 1e7) / 1e7 });
  }
  addCase(`balanced${i}`, rows, Math.round(spot * 100) / 100, '20261120', 'XYZ', 100, now0, '');
}
// 正好 1 天到期(距到期 1.000 天)、未平仓量全是 0、看涨看跌正好抵消(净 GEX 0)、小数张数(墙的张数要按一位小数舍)
const flat = (oiC, oiP, g) => [100, 105, 110, 115, 120].flatMap((k) => [{ strike: k, right: 'C', oi: oiC, volume: 1, gamma: g, iv: 0.3 }, { strike: k, right: 'P', oi: oiP, volume: 1, gamma: g, iv: 0.3 }]);
addCase('one_day', flat(10, 20, 0.01), 111, '20261016', 'NVDA', 100, Date.parse('2026-10-15T20:00:00Z'), '');
addCase('zero_oi', flat(0, 0, 0.01), 111, '20261016', 'NVDA', 100, now0, '');
addCase('neutral', flat(30, 30, 0.02), 111, '20261016', 'NVDA', 100, now0, '');
addCase('frac_oi', [...flat(0.1, 0.2, 0.01), ...flat(0.2, 0.1, 0.01)], 111, '20261016', 'NVDA', 100, now0, '');
addCase('nonobject_row', [null, { strike: 1, right: 'C' }], 100, '', '', 100, now0, '');
addCase('primitive_rows', [5, 'x', { strike: 100, right: 'C', oi: 1 }, { strike: 101, right: 'P', oi: 1 }, { strike: 102, right: 'C' }, { strike: 103, right: 'C' }, { strike: 104, right: 'P', oi: 0 }], 102, '', '', 100, now0, '');

// ---------------------------------------------------------------- 几个函数各自
const rawPool = [];
for (let i = 0; i < 300; i += 1) {
  const raw = Array.from({ length: Math.floor(rnd() * 8) }, () => ({ strike: pick([100, 105, '110', null, 0, NaN, 115.5, -1, undefined, ' 120 ', true]), right: pick(['C', 'P', 'c', 'call', 'ß', 'p', '', null, 5]),
    oi: pick([10, 0, -0, null, undefined, 'x', '20', -3, NaN, true, [5]]), volume: pick([1, 0, null, undefined, '7', -2, 'y']), gamma: pick([0.01, 0, -1, null, undefined, '0.02', NaN, 1e-300]),
    iv: pick([0.2, 0, null, undefined, 'abc', '0.25', Infinity]) }));
  for (const r of raw) for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
  rawPool.push(raw);
  out.rows.push({ raw: enc(raw), ...run(() => W.toRows(raw)) });
}
for (let i = 0; i < 2000; i += 1) {
  const spot = pick([450, 452.6, 0, -1, 6700 * (1 + 0.05 * gauss()), 1e-300, NaN]), strike = pick([450, 500, 0, 6700, 1e6, 452.6]);
  const t = pick([0, 1e-6, 1 / 8760, 0.002, 0.1, 1, -1, NaN, 0.5 * rnd()]), sigma = pick([0.2, 0.35, 0, -0.1, 3, 0.01 * rnd(), NaN]);
  out.gamma.push({ spot: enc(spot), strike, t: enc(t), sigma: enc(sigma), out: enc(W.bsGamma(spot, strike, t, sigma)) });
}
for (let i = 0; i < 400; i += 1) {
  const expiry = pick(['20261016', '20261120', '20261121', '20260918', '20261231', '20270115', '20260231', '2026101', 'bogus', '', '00500101', '20261016x', '20271218']);
  const symbol = pick(['SPX', 'NDX', 'RUT', 'SPY', '', 'spx']), tc = pick(['', 'SPX', 'SPXW', 'NDX', 'spx']);
  const now = pick([now0, now0 + 86_400_000 * 40 * rnd(), Date.parse('2026-11-20T14:31:00Z'), Date.parse('2027-01-01T00:00:00Z')]);
  out.years.push({ expiry, now, symbol, tc, out: enc(W.yearsToExpiry(expiry, now, symbol, tc)) });
}
for (let i = 0; i < 200; i += 1) {
  const s = pick(specs);
  const rows = W.toRows(chain({ ...s, ivShare: pick([1, 0.5, 0]), gammaShare: pick([0, 0.5, 1]), putTilt: pick([1, 2, 0.5]), junk: 0, dupes: false, half: pick([3, 6, 10]) }));
  const spot = s.spot * (1 + 0.02 * gauss()), t = pick([s.t, 1e-6, 0.3]), mult = pick([100, 50]);
  const strikes = rnd() < 0.8 ? [...new Set(rows.map((r) => r.strike))].sort((a, b) => a - b) : pick([[], [s.spot], [1, 1, 2, -3, 0, 5, 6], rows.map((r) => r.strike).reverse()]);
  out.gex.push({ rows: enc(rows), spot, t, mult, strikes: enc(strikes), at: enc(W.gexAt(rows, spot, t, mult)), bs: enc(W.bsGexAt(rows, spot * 1.01, t, mult)),
    conflict: W.gexSignConflict(rows, spot, t, mult), flip: enc(W.gammaFlip(rows, strikes, spot, t, mult)) });
}
// 翻转位的刁钻情形:两个挨得很近的变号处(扫描的点落不进去时找不到)、只有看涨(曲线处处为正,负的行权价那一段净 GEX 是 0)
const mk = (strike, right, oi, iv) => ({ strike, right, oi, oiMissing: false, volume: 0, gamma: null, iv });
for (const iv of [0.05, 0.03, 0.02, 0.012]) {
  const rows = [mk(500, 'C', 3000, iv), mk(495, 'P', 2000, iv), mk(505, 'P', 2000, iv), mk(400, 'C', 1, iv), mk(600, 'C', 1, iv)];
  for (const [strikes, spot] of [[[400, 480, 520, 600], 500.3], [[400, 480, 520, 600], 700], [[403, 403.01, 613], 700], [[400, 400.5, 600], 700], [[-3000, 400, 400.5, 600], 700],
    [[-30000, 403, 403.001, 613], 700], [[400, 600], 450]]) {
    const t = 0.01, mult = 100;
    out.gex.push({ rows, spot, t, mult, strikes, at: enc(W.gexAt(rows, spot, t, mult)), bs: enc(W.bsGexAt(rows, spot * 1.01, t, mult)), conflict: W.gexSignConflict(rows, spot, t, mult),
      flip: enc(W.gammaFlip(rows, strikes, spot, t, mult)) });
  }
}
{
  const rows = [100, 110, 120, 130, 140].map((k) => mk(k, 'C', 100, 0.3));
  for (const strikes of [[-50, 100, 110, 120, 130, 140], [100, 140], [0, 100, 140]]) out.gex.push({ rows, spot: 120, t: 0.05, mult: 100, strikes, at: enc(W.gexAt(rows, 120, 0.05, 100)),
    bs: enc(W.bsGexAt(rows, 121.2, 0.05, 100)), conflict: W.gexSignConflict(rows, 120, 0.05, 100), flip: enc(W.gammaFlip(rows, strikes, 120, 0.05, 100)) });
}
// 多一些有翻转位的曲线(二分的精度落在两位小数的舍入上)
for (let i = 0; i < 300; i += 1) {
  const rows = [];
  for (let k = 90; k <= 110; k += 2.5) for (const right of ['C', 'P']) if (rnd() < 0.8) rows.push(mk(k, right, Math.round(100 + 900 * rnd()), 0.15 + 0.3 * rnd()));
  const spot = 100 + 3 * gauss(), t = pick([0.01, 0.05, 0.2]);
  const strikes = [...new Set(rows.map((r) => r.strike))].sort((a, b) => a - b);
  out.gex.push({ rows, spot, t, mult: 100, strikes, at: enc(W.gexAt(rows, spot, t, 100)), bs: enc(W.bsGexAt(rows, spot * 1.01, t, 100)), conflict: W.gexSignConflict(rows, spot, t, 100),
    flip: enc(W.gammaFlip(rows, strikes, spot, t, 100)) });
}
// levelsForPa 的松记录
for (const r of [{}, { days_to_expiry: '0.5', call_vol_wall: { strike: 5, distance_pct: 1 }, put_vol_wall: 0, call_wall: 'x', put_wall: { strike: '4' }, max_pain: { strike: 3 }, gamma_flip: 0 },
  { days_to_expiry: null, call_vol_wall: { strike: 5 }, gamma_flip: null, max_pain: 0 }, { days_to_expiry: 1, call_vol_wall: { strike: 5, distance_pct: null }, max_pain: [] },
  { days_to_expiry: 'x', call_wall: { strike: 1, distance_pct: 2, extra: 3 }, gamma_flip: 'up' }]) out.levels.push({ r, out: enc(W.levelsForPa(r)) });
out.constants = { MULTIPLIER: W.MULTIPLIER, MIN_STRIKES: W.MIN_STRIKES };
writeFileSync(join(here, 'optionwall.json'), JSON.stringify(out) + '\n');
console.log(`optionwall.json: ${out.analyze.length} 条链 (报错 ${out.analyze.filter((c) => c.error).length}), ${out.gamma.length} 个 gamma, ${out.gex.length} 组 GEX`);
