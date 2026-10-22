// 生成 fly-model.json:engine-ts 的 flyCalibration.ts、flyIvModel.ts、ivPricing.ts(原模块现跑)在合成数据与随机输入上的结论。
// 校准吃的是合成的小时线 / 5 分钟线 / 自己攒的 IV 样本(种子固定),里面故意放了缺根、盘前盘后、坏价、乱序、
// 不是当日到期的样本、坏 IV;trainShare 取 0.5 / 1 / 负数 / NaN 这些边上的值。到期时刻与各腿行情那两样走全组合与随机输入。
// 这几样进定价(Math.log / exp),要用打包版应用里那个运行时生成:
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_fly_model.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const C = await import(pathToFileURL(join(engine, 'dist/src/flyCalibration.js')).href);
const M = await import(pathToFileURL(join(engine, 'dist/src/flyIvModel.js')).href);
const P = await import(pathToFileURL(join(engine, 'dist/src/ivPricing.js')).href);
const T = await import(pathToFileURL(join(engine, 'dist/src/tz.js')).href);

let seed = 0x5eed_f1a7;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const gauss = () => { const u = rnd() || 1e-12, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
// 数值的编码:NaN / ±Infinity / −0 / undefined 在 JSON 里写不出来,写成占位串(C++ 那边同一套)
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

// ---------------------------------------------------------------- 合成行情
const etSec = (date, minute) => {
  const [y, m, d] = date.split('-').map(Number);
  return T.wallToEpoch({ year: y, month: m, day: d, hour: Math.floor(minute / 60), minute: minute % 60, second: 0 }, T.ET) / 1000;
};
const tradingDays = (from, n) => {
  const out = [];
  let t = Date.parse(`${from}T12:00:00Z`);
  while (out.length < n) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
};
const HOUR_SHARE = [0.27, 0.15, 0.12, 0.11, 0.11, 0.12, 0.12];
/** 一天:小时线(价、IV、长 IV)与 5 分钟线 */
function synthDay(date, opts) {
  const lvl = 12 + 10 * rnd(), lvlLong = lvl * (1.05 + 0.1 * rnd());
  const daySd = (lvl / 100) / Math.sqrt(252);
  let p = 400 + 100 * rnd(), iv = lvl, ivl = lvlLong;
  const hourly = [], ivh = [], ivlh = [], fine = [];
  for (let h = 0; h < 7; h += 1) {
    const start = 570 + 60 * h, len = h === 6 ? 30 : 60;
    const sd = daySd * Math.sqrt(HOUR_SHARE[h]);
    const z = gauss();
    const ret = z * sd;
    // 5 分钟线把这一小时走完
    const steps = len / 5;
    let q = p;
    for (let s = 0; s < steps; s += 1) {
      const o = q;
      q = o * Math.exp(ret / steps + 0.2 * sd * gauss() / Math.sqrt(steps));
      fine.push([etSec(date, start + 5 * s), o, q]);
    }
    const u = z * Math.sqrt(HOUR_SHARE[h]);
    const o = p, oiv = iv, oivl = ivl;
    p = q;
    iv = oiv * Math.exp(-0.01 - 0.1 * u + 0.03 * u * u + 0.02 * gauss() - 0.004 * h);
    ivl = oivl * Math.exp(-0.005 - 0.05 * u + 0.01 * u * u + 0.01 * gauss());
    hourly.push([etSec(date, start), o, p]);
    ivh.push([etSec(date, start), oiv, iv]);
    ivlh.push([etSec(date, start), oivl, ivl]);
  }
  // 缺根、坏价、盘前盘后
  if (opts.flaw === 'drop') hourly.splice(1 + Math.floor(rnd() * 5), 1);
  if (opts.flaw === 'late') hourly.shift();
  if (opts.flaw === 'zero') ivh[2][2] = 0;
  if (opts.flaw === 'extra') { hourly.push([etSec(date, 960), p, p]); hourly.unshift([etSec(date, 480), p, p]); ivh.push([etSec(date, 975), iv, iv]); }
  if (opts.flaw === 'fineDrop') fine.splice(10, 1);
  if (opts.flaw === 'fineDrop2') fine.splice(10, 2);
  if (opts.flaw === 'fineDrop3') fine.splice(10, 3);
  return { hourly, ivh, ivlh, fine };
}
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function synthInput(nDays, from, { fineDays = 25, flaws = true, longDays = nDays } = {}) {
  const dates = tradingDays(from, nDays);
  const priceHourly = [], priceFine = [], ivHourly = [], ivLongHourly = [];
  dates.forEach((date, i) => {
    const flaw = flaws && rnd() < 0.12 ? pick(['drop', 'late', 'zero', 'extra', 'fineDrop', 'fineDrop2', 'fineDrop3']) : null;
    const d = synthDay(date, { flaw });
    priceHourly.push(...d.hourly);
    ivHourly.push(...d.ivh);
    if (i < longDays) ivLongHourly.push(...d.ivlh);
    if (i >= nDays - fineDays) priceFine.push(...d.fine);
  });
  // 乱序:按天整块打乱,一天之内也打乱几根
  return { priceHourly: shuffle(priceHourly), priceFine: shuffle(priceFine), ivHourly: shuffle(ivHourly), ivLongHourly };
}
const bars = (list) => list.map(([sec, open, close]) => ({ sec, open, close }));

const out = { model: enc(M.FLY_IV_MODEL), sessions: [], grid: [], shares: [], halfHour: [], remaining: [], predict: [], fit: [], residSd: [], r2: [],
  calibrate: [], own: [], ownDrift: [], expiry: [], sigmas: [], legInputs: [] };

// ---------------------------------------------------------------- sessions / gridOf
for (let i = 0; i < 12; i += 1) {
  const raw = synthInput(3, pick(['2026-03-05', '2026-10-29', '2026-11-02', '2025-12-30']), { fineDays: 3 });
  const list = [...raw.priceHourly, ...raw.priceFine.slice(0, 40)];
  // 坏价与越界的时刻
  for (let k = 0; k < 6; k += 1) list.push([pick(list)[0] + pick([0, 30, -1800, 23400, 86400]), pick([0, -1, 5, NaN, 400]), pick([0, 5, 401, NaN])]);
  const s = C.sessions(bars(list));
  out.sessions.push({ bars: enc(list), out: enc([...s.entries()]) });
  for (const [, day] of s) for (const step of [60, 5, 30]) out.grid.push({ day: enc(day.map((b) => [b.sec, b.open, b.close, b.minute])), step, out: enc(C.gridOf(day, step)) });
}
out.grid.push({ day: '__undefined__', step: 60, out: enc(C.gridOf(undefined, 60)) });
// 根数正好卡在门槛上:30 分钟要 13 根(少两根以内照用),5 分钟要 78 根
for (const [step, n] of [[30, 13], [30, 12], [30, 11], [30, 10], [5, 78], [5, 77], [5, 76], [5, 75], [5, 79], [60, 7], [60, 6], [60, 8]]) {
  const day = Array.from({ length: n }, (_, i) => ({ sec: 1760880600 + i * step * 60, open: 100 + i, close: 100.5 + i, minute: 570 + i * step }));
  out.grid.push({ day: enc(day.map((b) => [b.sec, b.open, b.close, b.minute])), step, out: enc(C.gridOf(day, step)) });
}
out.grid.push({ day: [], step: 60, out: enc(C.gridOf([], 60)) });

// ---------------------------------------------------------------- 份额、剩余、预测、拟合
const scaled = (n, buckets, width) => Array.from({ length: n }, (_, d) => {
  const len = Math.floor(rnd() * 14) + (rnd() < 0.1 ? 0 : 2);
  const minutes = Array.from({ length: len }, (_, i) => 570 + i * width + pick([0, 0, 0, -600, 1000, NaN]));
  if (rnd() < 0.1) minutes.length = Math.max(0, minutes.length - 3);
  const grid = Array.from({ length: len + 1 }, () => 100 + 10 * rnd());
  return { date: `d${d}`, minutes, grid, level: pick([15, 20, 0, -5, 30]) };
});
for (let i = 0; i < 80; i += 1) {
  const buckets = pick([7, 13, 1, 0]), width = pick([60, 30, 5]);
  const days = scaled(Math.floor(rnd() * 5), buckets, width);
  out.shares.push({ days: enc(days), buckets, width, ...run(() => C.varianceShares(days, buckets, width)) });
}
for (let i = 0; i < 60; i += 1) {
  const hourly = Array.from({ length: pick([7, 7, 7, 6]) }, () => rnd());
  const fine = Array.from({ length: pick([13, 13, 13, 12]) }, () => pick([rnd(), 0, rnd()]));
  out.halfHour.push({ hourly, fine, ...run(() => C.halfHourWeights(hourly, fine)) });
}
const weightSets = [M.FLY_IV_MODEL.variance_weights, [1], [], [0.5, 0.5], Array.from({ length: 7 }, () => rnd() / 3), [0.3, NaN, 0.7]];
const minutes = [-Infinity, 0, 569, 570, 570.5, 571, 600, 615.25, 700, 959, 959.999999, 959.9999999999999, 960, 1000, NaN, Infinity];
for (const w of weightSets) for (const m of [...minutes, ...Array.from({ length: 30 }, () => 570 + 390 * rnd())]) out.remaining.push({ w: enc(w), m: enc(m), out: enc(C.remainingShare(w, m)) });
const betas = [M.FLY_IV_MODEL.response, { a: 0.1, b: -0.2, c: 0.05 }, { a: 0, b: 0, c: 0 }];
for (const beta of betas) for (const u of [-10, -4, -4.5, -1, -0, 0, 0.3, 2, 4, 4.0000001, 9, NaN, Infinity]) out.predict.push({ beta, u: enc(u), out: enc(C.predict(beta, u)) });
for (let i = 0; i < 40; i += 1) {
  const n = pick([10, 29, 30, 31, 100, 500]);
  const kind = pick(['normal', 'normal', 'flat', 'nan', 'big']);
  const rows = Array.from({ length: n }, () => {
    const u = kind === 'flat' ? 1 : kind === 'big' ? 8 * gauss() : gauss() * 1.5;
    return { date: 'x', u: kind === 'nan' && rnd() < 0.05 ? NaN : u, y: -0.01 - 0.1 * u + 0.03 * u * u + 0.02 * gauss(), share: 0.05 + rnd() * 0.5 };
  });
  out.fit.push({ rows: enc(rows.map((r) => [r.u, r.y, r.share])), ...run(() => C.fitResponse(rows)) });
  for (const beta of [...betas, null]) out.r2.push({ rows: out.fit.length - 1, beta, out: enc(C.rSquared(rows, beta)) });
}
// 主元相等的那几种:u 取 {0, ±2} 且 ±2 各占八分之一时 Σu² = n,第一列的 A[2][0] 与 A[0][0] 一样大(列主元只在严格更大时换行)
for (const [n, extra] of [[64, 0], [64, 0.01], [128, 0.02], [96, 0]]) {
  const rows = Array.from({ length: n }, (_, i) => {
    const u = i % 8 === 0 ? 2 : i % 8 === 1 ? -2 : 0;
    return { date: 'x', u, y: 0.03 * u + 0.01 * u * u + extra * Math.sin(i), share: 0.1 };
  });
  out.fit.push({ rows: enc(rows.map((r) => [r.u, r.y, r.share])), ...run(() => C.fitResponse(rows)) });
}
out.r2.push({ rows: -1, beta: null, out: enc(C.rSquared([], null)) });
for (let i = 0; i < 60; i += 1) {
  const model = { resid_k: pick([0.1, 0.25, 0]), resid_move: { base: pick([0.8, -1, 0.05]), slope: pick([0.1, -0.3, 0]) } };
  const share = pick([0.3, 0, -0.2, 1, NaN]), u = pick([0, -2, 3, 7, -9, NaN]);
  out.residSd.push({ model, share: enc(share), u: enc(u), out: enc(C.residualSd(model, share, u)) });
}

// ---------------------------------------------------------------- calibrate
const calCases = [
  { name: 'full', n: 75, opts: {}, extra: {} },
  { name: 'givenFine', n: 72, opts: {}, extra: { trainShare: 0.5, noLong: true, givenFine: true } },
  { name: 'tooFew', n: 59, opts: { flaws: false }, extra: {} },
  { name: 'flawsDrop', n: 66, opts: {}, extra: {} },
  { name: 'allTrain', n: 70, opts: { flaws: false }, extra: { trainShare: 1 } },
  { name: 'nanShare', n: 70, opts: { flaws: false }, extra: { trainShare: NaN } },
  { name: 'negShare', n: 70, opts: { flaws: false }, extra: { trainShare: -0.3 } },
  { name: 'bigShare', n: 70, opts: { flaws: false }, extra: { trainShare: 1.4 } },
  { name: 'fewFine', n: 70, opts: { flaws: false, fineDays: 15 }, extra: {} },
  { name: 'shortLong', n: 70, opts: { flaws: false, longDays: 50 }, extra: { longDays: 7 } },
  { name: 'longDays', n: 68, opts: { flaws: false }, extra: { longDays: 7 } },
  // 长一档 IV 的天数正好卡在门槛上(要 ≥ 60)
  { name: 'long60', n: 66, opts: { flaws: false, longDays: 60 }, extra: {} },
  { name: 'long59', n: 66, opts: { flaws: false, longDays: 59 }, extra: {} },
];
for (const c of calCases) {
  const raw = synthInput(c.n, pick(['2025-01-06', '2025-10-20', '2026-02-23']), c.opts);
  const input = {
    priceHourly: bars(raw.priceHourly), priceFine: bars(raw.priceFine), ivHourly: bars(raw.ivHourly),
    source: '合成', proxy: 'SYN', version: 'test',
  };
  if (!c.extra.noLong) input.ivLongHourly = bars(raw.ivLongHourly);
  if (c.extra.longDays !== undefined) input.ivLongDays = c.extra.longDays;
  if (c.extra.trainShare !== undefined) input.trainShare = c.extra.trainShare;
  if (c.extra.givenFine) input.fineShares = Array.from({ length: 13 }, (_, i) => (i === 12 ? 0.09 : 0.07));
  out.calibrate.push({
    name: c.name,
    input: enc({ priceHourly: raw.priceHourly, priceFine: raw.priceFine, ivHourly: raw.ivHourly, ivLongHourly: input.ivLongHourly ? raw.ivLongHourly : undefined,
      ivLongDays: input.ivLongDays, trainShare: input.trainShare, fineShares: input.fineShares, source: input.source, proxy: input.proxy, version: input.version }),
    ...run(() => C.calibrate(input)),
  });
}

// ---------------------------------------------------------------- 自己攒的样本
function synthSamples(nDays, from, { points = 12, junk = true } = {}) {
  const samples = [];
  for (const date of tradingDays(from, nDays)) {
    const ymd = date.replace(/-/g, '');
    let spot = 5800 + 200 * rnd(), atm = 0.1 + 0.15 * rnd();
    let grid = Array.from({ length: 12 }, (_, g) => g).filter((g) => points >= 12 || g % Math.ceil(12 / points) === 0).slice(0, points);
    // 有的天只剩 5 个或 6 个点(门槛是 6)
    if (junk && rnd() < 0.15) grid = grid.slice(0, pick([5, 6]));
    for (const g of grid) {
      const minute = 600 + 30 * g;
      const jitter = junk ? pick([0, 0.5, -1.25, 2.9, -3.7, 5, 0.017]) : pick([0, 0.5, -1.25, 2.9]);
      const t = Math.round((etSec(date, minute) + jitter * 60) * 1000) + Math.floor(rnd() * 1000);
      const z = gauss();
      spot *= Math.exp(z * 0.002);
      atm *= Math.exp(-0.03 * z + 0.02 * z * z + 0.02 * gauss() - 0.01);
      const base = Math.round(spot / 5) * 5;
      const legs = [];
      for (let k = -3; k <= 3; k += 1) for (const right of ['C', 'P']) {
        const strike = base + 5 * k;
        let iv = atm * (1 + 0.002 * Math.abs(strike - spot)) * Math.exp(0.01 * gauss());
        if (junk && rnd() < 0.04) iv = pick([null, 0.005, 4, 0]);
        legs.push({ strike, right, iv });
      }
      if (junk && rnd() < 0.2) {
        // 离网格点一样远的两笔(前后各 2 分钟、整分):先遇到的那一笔算数
        const t0 = etSec(date, minute) * 1000;
        samples.push({ t: t0 - 120_000, spot, expiry: ymd, legs });
        samples.push({ t: t0 + 120_000, spot: spot * 1.0015, expiry: ymd, legs: legs.map((l) => ({ ...l, iv: typeof l.iv === 'number' ? l.iv * 1.03 : l.iv })) });
        continue;
      }
      samples.push({ t, spot: junk && rnd() < 0.02 ? 0 : spot, expiry: junk && rnd() < 0.02 ? '20990101' : ymd, legs });
      if (junk && rnd() < 0.2) samples.push({ t: t + 13 * 60_000, spot, expiry: ymd, legs: legs.slice(0, 4) });
    }
    if (junk && rnd() < 0.3) samples.push({ t: etSec(date, 545) * 1000, spot, expiry: ymd, legs: [] });
  }
  return shuffle(samples);
}
const ownCases = [
  { name: 'fit', n: 46, opts: {} },
  { name: 'fewDays', n: 30, opts: {} },
  { name: 'fewRows', n: 45, opts: { points: 6, junk: false } },
  { name: 'clean', n: 42, opts: { junk: false } },
];
for (const c of ownCases) {
  const samples = synthSamples(c.n, pick(['2026-01-05', '2026-03-02', '2026-10-26']), c.opts);
  const res = run(() => C.fitFromSamples(samples, M.FLY_IV_MODEL));
  const better = res.out ? C.ownIsBetter(res.out) : null;
  out.own.push({ name: c.name, samples: enc(samples.map((s) => [s.t, s.spot, s.expiry, s.legs.map((l) => [l.strike, l.right, l.iv])])), ...res, better });
}
const drifts = [[0, 0.01, 0.02, -0.01, 0.03, 0, 0.01, 0.02, 0.04, 0.05, 0.02, 0.01], [], [0.5], [0, 1]];
for (const d of drifts) for (const m of [500, 600, 615, 629.5, 630, 900, 929, 930, 931, 1000, NaN, -Infinity, Infinity]) out.ownDrift.push({ d, m: enc(m), out: enc(C.ownDriftAt({ drift: d }, m)) });
for (const fit of out.own.filter((o) => o.out)) for (let i = 0; i < 20; i += 1) {
  const m = 600 + 330 * rnd();
  out.ownDrift.push({ d: fit.out.drift, m, out: enc(C.ownDriftAt(fit.out, m)) });
}
for (const r2 of [[0.2, 0.1], [0.1, 0], [0.3, 0.3], [0.3, 0.31], [0.05, -1]]) out.ownDrift.push({ better: r2, out: C.ownIsBetter({ fit: { r2_out: r2[0], r2_out_index: r2[1] } }) });

// ---------------------------------------------------------------- 到期时刻
const syms = ['SPX', 'spx', 'NDX', 'RUT', 'AAPL', '', 'XSP', 'ES'];
const exps = ['20260918', '20260917', '20260917 08:30 US/Central', ' 20260917 ', '20260919', '20260920', '20261231', '202609', '2026091', '20260917x', '202609171',
  '00500101', '20261399', '20260917 08:30', '20260917　09:30', '20260917\t9:30', '20260917 0930', 'abc', '', '20261127', '20260403'];
const tcs = ['', 'SPX', 'SPXW', 'spx', 'NDXP', 'NDX', 'RUT', 'RUTW', 'AAPL'];
for (const s of syms) for (const e of exps) for (const tc of tcs) for (const early of [false, true]) out.expiry.push({ s, e, tc, early, out: P.expiryEpochMs(s, e, tc, early) });

// ---------------------------------------------------------------- 各腿的 σ
const keyOf = (leg) => `${leg.strike}${leg.right}`;
for (let i = 0; i < 300; i += 1) {
  const legs = Array.from({ length: Math.floor(rnd() * 5) }, () => ({ strike: pick([5800, 5805, 5810, 5800.5, 3]), right: pick(['C', 'P', '']) }));
  const legIvs = {};
  for (const leg of legs) if (rnd() < 0.97) legIvs[keyOf(leg)] = rnd() < 0.85 ? pick([0.15, 0.2, '0.3', 0.25, [0.2], true]) : pick([null, 0, -0.1, 'x']);
  const spot = rnd() < 0.85 ? pick([5805, 5800.25]) : pick([0, -1, NaN]);
  const nowMs = rnd() < 0.85 ? pick([Date.parse('2026-10-19T15:00:00Z'), Date.parse('2026-10-19T21:00:00Z'), 1760886000123]) : pick([NaN, Infinity]);
  const expiryMs = rnd() < 0.85 ? pick([Date.parse('2026-10-19T20:00:00Z'), Date.parse('2026-10-20T20:00:00Z')]) : null;
  out.sigmas.push({ legs, spot: enc(spot), legIvs: enc(legIvs), expiryMs, nowMs: enc(nowMs), out: enc(P.ibkrLegSigmas(legs, spot, legIvs, expiryMs, nowMs, keyOf)) });
}

// ---------------------------------------------------------------- 一份持仓的各腿行情
const contract = () => {
  if (rnd() < 0.06) return pick([null, undefined, 'x', 5]);
  const c = {};
  if (rnd() < 0.95) c.strike = pick([5800, '5805', '', null, 'x', 5810.5, true]);
  if (rnd() < 0.95) c.right = pick(['C', 'P', 'call', 'put', 'c', '', null, 7, 'ß']);
  if (rnd() < 0.9) c.lastTradeDateOrContractMonth = pick(['20261019', '20261127', '20261224 08:30 US/Central', ' 20261218 ', '', null, 20261019]);
  if (rnd() < 0.8) c.tradingClass = pick(['SPXW', 'SPX', '', null]);
  if (rnd() < 0.5) c.symbol = pick(['SPX', 'AAPL', null]);
  return c;
};
const posRow = () => {
  const r = { contract: contract() };
  if (rnd() < 0.8) r.market_price = pick([1.5, null, '2', 0]);
  if (rnd() < 0.8) r.model_iv = pick([0.2, null, 'x', 0]);
  return r;
};
for (let i = 0; i < 400; i += 1) {
  const positions = {};
  for (const k of ['a', 'b', 'c', '0', 'null', '5']) if (rnd() < 0.7) positions[k] = rnd() < 0.04 ? pick([null, 5, 'str']) : posRow();
  const raw = posRow();
  if (rnd() < 0.9) raw.sec_type = pick(['OPT', 'FOP', 'BAG', 'STK', 5, null]);
  if (rnd() < 0.7) raw.legs = rnd() < 0.05 ? pick(['ab', 5, { a: 1 }, true, null]) : Array.from({ length: Math.floor(rnd() * 4) }, () => pick(['a', 'b', 'c', '0', 0, null, 'constructor', 'missing', 5]));
  if (rnd() < 0.5) raw.symbol = pick(['SPX', 'NDX', null, 'AAPL']);
  const early = rnd() < 0.7;
  const isEarlyClose = (d) => ['2026-11-27', '2026-12-24'].includes(d);
  out.legInputs.push({ raw: enc(raw), positions: enc(positions), early, ...run(() => (early ? P.legInputsOf(raw, positions, keyOf, isEarlyClose) : P.legInputsOf(raw, positions, keyOf))) });
}

// 写明的几种:持仓表里那一条是 null / 数 / 串,合约是 null / 串,legs 不是数组
const fixed = [
  [{ sec_type: 'BAG', legs: ['a'] }, { a: null }],
  [{ sec_type: 'BAG', legs: ['b', 'a'] }, { a: null, b: { contract: { strike: 5800, right: 'C', lastTradeDateOrContractMonth: '20261127', tradingClass: 'SPXW' }, market_price: 2 } }],
  [{ sec_type: 'BAG', legs: ['a', 'b'] }, { a: 5, b: 'str' }],
  [{ sec_type: 'OPT', contract: null, market_price: 1 }, {}],
  [{ sec_type: 'OPT', contract: 'abc', market_price: 1 }, {}],
  [{ sec_type: 'FOP', contract: { strike: '5800', right: 'call', lastTradeDateOrContractMonth: '20261224 08:30 US/Central', symbol: 'SPX', tradingClass: 'SPX' }, model_iv: 0.2 }, {}],
  [{ sec_type: 'BAG', legs: 'ab' }, {}],
  [{ sec_type: 'BAG', legs: null }, {}],
  [{ sec_type: 'BAG', legs: [null, 0, 'constructor', 'toString', '__proto__'] }, { null: { contract: { strike: 1, right: 'P' } }, 0: { contract: { strike: 2, right: 'C' } } }],
  [{ sec_type: 'BAG', symbol: 'SPX', legs: ['x', 'y'] }, { x: { contract: { strike: 5800, right: 'C', lastTradeDateOrContractMonth: '20261218', tradingClass: '' } }, y: { contract: { strike: 5810, right: 'C', lastTradeDateOrContractMonth: '20261218', tradingClass: 'SPX' } } }],
];
for (const [raw, positions] of fixed) for (const early of [false, true]) {
  const isEarlyClose = (d) => ['2026-11-27', '2026-12-24'].includes(d);
  out.legInputs.push({ raw: enc(raw), positions: enc(positions), early, ...run(() => (early ? P.legInputsOf(raw, positions, keyOf, isEarlyClose) : P.legInputsOf(raw, positions, keyOf))) });
}

writeFileSync(join(here, 'fly-model.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
console.log('fly-model.json', Object.entries(out).map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : 1}`).join(' '));
