// 生成 flyexit.json:engine-ts 的 flyexit.ts(原模块现跑)在黄金基线的 18 个场景、合成的整天分钟线与随机输入上的结论;
// 另有 @stdlib/math-base-special-erf 在 4 万个输入上的位(Bachelier 的正态分布用它,不是 Math.*)。
// 合成的回放:标的随机游走、蝶价有的分钟有有的分钟缺(缺的用模型价)、数据在盘中断掉、开仓在翼外、卖出的蝶、没有 D、
// 固定档位打开、cutoff_a_share、尾盘收紧的钟点写坏;参数原样里有串、布尔、数组、空串、Object.prototype 上的名字。
// 定价走 exp / erf,要用打包版应用里那个运行时生成:
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_flyexit.mjs <编过的 engine-ts 目录>
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const X = await import(pathToFileURL(join(engine, 'dist/src/flyexit.js')).href);
const erf = createRequire(join(engine, 'package.json'))('@stdlib/math-base-special-erf');

let seed = 0xf1e7_0042;
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
const buf = new DataView(new ArrayBuffer(8));
const hex = (x) => { if (Number.isNaN(x)) return '7ff8000000000000'; buf.setFloat64(0, x); return buf.getBigUint64(0).toString(16).padStart(16, '0'); };

const out = { erf: [], params: [], minutes: [], variance: [], phase: [], trail: [], drawdown: [], fmt: [], price: [], implied: [], tranches: [], levels: [], plans: [], sims: [] };

// ---------------------------------------------------------------- erf
for (let i = 0; i < 20000; i += 1) {
  const r = rnd();
  const x = i < 16 ? [0, -0, 1e-310, -1e-310, 3e-9, 0.84375, 0.84374, 1.25, 1.2499999, 6, -6, 5.99999, 2.857142857142857, NaN, Infinity, -Infinity][i]
    : r < 0.4 ? (rnd() - 0.5) * 12 : r < 0.7 ? gauss() * 2 : r < 0.9 ? (rnd() - 0.5) * 2 : Math.exp((rnd() - 0.5) * 80) * (rnd() < 0.5 ? -1 : 1);
  out.erf.push([hex(x), hex(erf(x))]);
}
// 两段分界附近与次正规数
for (let i = 0; i < 2000; i += 1) {
  const x = pick([2.84 + 0.03 * rnd(), -(2.84 + 0.03 * rnd()), 1e-307 * rnd() * 30, -1e-306 * rnd() * 3, 5e-324 * Math.floor(rnd() * 1e6), 0.84 + 0.01 * rnd(), 1.24 + 0.02 * rnd()]);
  out.erf.push([hex(x), hex(erf(x))]);
}

// ---------------------------------------------------------------- 参数
const valuePool = [5, 0, -1, '2', ' 2 ', '', '  ', 'x', true, false, null, [3], [], {}, 1e-12, Infinity, '0x10', '1e2', 0.7, '15:30', 1530, '14:', '9', 'ab:cd'];
const keyPool = ['em', 'tp1', 'tp2', 'stop', 'trail_arm', 'trail', 'trail_loose_below', 'trail_loose', 'trail_tight_at', 'trail_tight', 'trail_floor', 'trail_late',
  'trail_late_factor', 'zone_hold', 'zone_half', 'zone_stop', 'stop_var', 'cutoff_a', 'switch_k', 'otm_band', 'cutoff_a_share', 'toString', 'constructor', 'valueOf',
  'hasOwnProperty', '__proto__', 'bogus', '0', 'em '];
const rawParams = () => {
  const o = {};
  for (let n = Math.floor(rnd() * 6); n > 0; n -= 1) o[pick(keyPool)] = pick(valuePool);
  return o;
};
for (const raw of [null, undefined, [], 'abc', 5, {}, JSON.parse('{"__proto__": 5, "em": 20}'), { toString: 3, em: '30' }]) out.params.push({ raw: enc(raw), ...run(() => X.paramsFrom(raw)) });
for (let i = 0; i < 300; i += 1) { const raw = rawParams(); out.params.push({ raw: enc(raw), ...run(() => X.paramsFrom(raw)) }); }
for (const s of ['14:00', '9:30', '15:', ':30', '1530', '', 'a:b', ' 9 : 30 ', '9:30:15', '16:00', '24:00', '09:3', '-1:30', '1e1:5']) out.minutes.push({ s, out: enc(X.minutesOf(s)) });
for (const m of [-Infinity, 0, 569, 570, 570.5, 571, 600, 615, 629.99, 630, 959, 959.5, 960, 961, NaN, ...Array.from({ length: 60 }, () => 570 + 390 * rnd()), ...Array.from({ length: 391 }, (_, i) => 570 + i)]) {
  out.variance.push({ m: enc(m), R: enc(X.remainingVariance(m)), s: enc(X.sigmaRemaining(36, m)), s2: enc(X.sigmaRemaining(17.3, m)) });
}
const paramSets = [X.paramsFrom(null), X.paramsFrom({ cutoff_a_share: 0.35 }), X.paramsFrom({ cutoff_a_share: 0.0001 }), X.paramsFrom({ cutoff_a: '13:15', switch_k: 2.2, em: 25 }),
  X.paramsFrom({ cutoff_a: 'xx' }), X.paramsFrom({ cutoff_a: '9', trail_late: '14' }), X.paramsFrom({ em: 80, cutoff_a_share: 2 }), X.paramsFrom({ trail_late: '13:30', trail_late_factor: 0.25 }),
  X.paramsFrom({ cutoff_a_share: X.remainingVariance(800) }), X.paramsFrom({ cutoff_a_share: X.remainingVariance(615) })];
for (const params of paramSets) {
  const cut = X.cutoffMinute(params);
  out.phase.push({ params, cut: enc(cut), sw: [10, 20, 25, 40, 0.5].map((w) => enc(X.switchMinute(w, params))),
    phases: Array.from({ length: 80 }, () => { const m = pick([560, 570 + Math.floor(390 * rnd()), 570 + 390 * rnd(), NaN, 960, 1000]); const w = pick([10, 20, 25, 40]); return [enc(m), w, X.phaseAt(m, w, params)]; }) });
  for (let i = 0; i < 40; i += 1) {
    const peak = pick([0, 0.5, 1, 2, 2.25, 6.75, 7, 10, rnd() * 10, -1]), d = pick([2.25, 1, 0.5, 3]), m = pick([660, 899, 900, 930, 600 + 300 * rnd(), NaN]);
    out.trail.push({ p: paramSets.indexOf(params), peak, d, m: enc(m), pct: enc(X.trailPct(peak, d, m, params)), stop: enc(X.trailStop(peak, d, m, params)) });
  }
}
for (let i = 0; i < 80; i += 1) {
  const raw = rnd() < 0.2 ? pick([null, undefined]) : rawParams();
  const cost = pick([null, 0, -250, 250, 50, 1000, 66.66, 200 / 3, -200 / 3, NaN, Infinity, 1e-9]);
  out.drawdown.push({ raw: enc(raw), cost: enc(cost), tiers: enc(X.drawdownTiers(raw)), late: enc(X.drawdownLate(raw)), arm: enc(X.drawdownArm(raw)),
    usd: enc(X.drawdownUsdPreset(cost, raw)), floor: enc(X.drawdownFloor(raw)) });
}
for (const m of [570, 600, 615, 959, 960, 59, 0, 870.5, -1, -61, NaN, 1439, 14400, 600.25]) out.fmt.push({ m: enc(m), out: X.fmtMinute(m) });

// ---------------------------------------------------------------- 定价
const flyProfile = (center, wing, right) => ({ lower: center - wing, center, upper: center + wing, width: wing, right });
for (let i = 0; i < 1500; i += 1) {
  const k = pick([5780, 5800, 5810, 5825.5]), s = rnd() < 0.15 ? k : 5800 + gauss() * 40, sigma = pick([0, 1e-10, 1e-9, 2e-9, 0.05, 1, 5, 18, 36, 400, rnd() * 60, -3]);
  const prof = flyProfile(pick([5800, 5810]), pick([10, 20, 25]), pick(['C', 'P', 'c', 'p']));
  const legs = Array.from({ length: Math.floor(rnd() * 5) }, () => ({ strike: pick([5790, 5800, 5810, 5820]), right: pick(['C', 'P', 'put', 'call', '']), ratio: pick([1, -1, -2, 2, 0.5]) }));
  out.price.push({ s, k, sigma, call: X.bachelierCall(s, k, sigma), put: X.bachelierPut(s, k, sigma), leg: X.legValue(pick(['C', 'P', 'p', 'Put', '', 'x']), s, k, sigma),
    prof, model: X.modelPrice(prof, s, sigma), legs, structure: X.structureValue(legs, s, sigma) });
}
for (let i = 0; i < 600; i += 1) {
  const s = pick([5800 + gauss() * 30, 5800 + gauss() * 30, NaN, Infinity, 5810, 5790, 5820, 5780, 5825, 5775]), k = pick([5800, 5810, 5790, NaN]), right = pick(['C', 'P', 'p', '']);
  const truth = pick([3, 10, 25, 60, 300, 0.1]);
  const price = rnd() < 0.7 && Number.isFinite(s) && Number.isFinite(k) ? X.legValue(right, s, k, truth) : pick([0, -1, 1e-12, 50, 500, NaN, 7.25]);
  const prof = flyProfile(pick([5800, 5810]), pick([10, 20, 25, 0, -5]), pick(['C', 'P']));
  const fp = rnd() < 0.7 && Number.isFinite(s) ? X.modelPrice(prof, s, truth) : pick([0, 2, 9.9, 30, NaN]);
  out.implied.push({ s: enc(s), k: enc(k), right, price: enc(price), leg: enc(X.impliedSigmaLeg(s, k, price, right)), prof, fp: enc(fp), fly: enc(X.impliedSigmaFly(prof, s, fp)) });
}
for (const q of [0, 1, 2, 3, 4, 5, 6, 7, 10, 11, -1, 2.5, NaN, 100]) out.tranches.push({ q: enc(q), out: enc(X.trancheSizes(q)) });
for (let i = 0; i < 120; i += 1) {
  const prof = { ...flyProfile(5800, pick([10, 20, 25]), pick(['C', 'P'])), multiplier: pick([100, 10, '100']), qty: pick([1, 2, 3, 5, 9, 0, '3', undefined, 2.5]), debit: pick([2.25, 1, null, undefined, '2', 0, 3.1]) };
  if (prof.qty === undefined) delete prof.qty;
  const params = X.paramsFrom(rnd() < 0.5 ? { tp1: pick([1.5, null, '2']), tp2: pick([2.5, null]), stop: pick([0.4, 0.5]) } : rawParams());
  out.levels.push({ prof: enc(prof), params: enc(params), levels: enc(X.levels(prof, params)), zones: enc(X.zones(prof, params)) });
}

// ---------------------------------------------------------------- 回放
const golden = JSON.parse(readFileSync(join(engine, 'baseline/golden/flyexit.json'), 'utf8'));
const store = JSON.parse(readFileSync(join(engine, 'baseline/golden/_bars.json'), 'utf8'));
const resolve = (v) => (v && typeof v === 'object' && !Array.isArray(v) && typeof v.$bars === 'string' ? store[v.$bars] : v);
for (const c of golden.cases) {
  const spx = resolve(c.spx), fly = resolve(c.fly);
  out.plans.push({ name: c.name, profile: c.profile, entry: c.entry, spx, fly, params: enc(c.params), actual: enc(c.actual), emNote: '__undefined__',
    ...run(() => X.plan(c.profile, c.entry, spx, fly, c.params, c.actual)) });
}
const pad = (n) => String(n).padStart(2, '0');
const stamp = (day, m) => `${day} ${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
function synthDay(day, center, opts) {
  const spx = [], fly = [];
  let s = center + (opts.offset ?? 0);
  const prof = { ...flyProfile(center, opts.wing, opts.right), action: opts.action ?? 'BUY', qty: opts.qty, multiplier: 100, debit: opts.debit };
  const endMinute = opts.end ?? 960;
  for (let m = 570; m <= endMinute; m += 1) {
    s += gauss() * opts.vol + (opts.drift ?? 0);
    const bar = { time: stamp(day, m) + (opts.seconds ? ':00' : ''), close: Math.round(s * 100) / 100 };
    if (opts.nullClose && rnd() < 0.02) bar.close = null;
    spx.push(bar);
    if (rnd() < opts.flyShare) {
      const sig = X.sigmaRemaining(opts.em ?? 36, m);
      const val = X.modelPrice(prof, bar.close ?? s, sig) * (1 + 0.05 * gauss());
      fly.push({ time: bar.time, close: Math.max(0.05, Math.round(val * 20) / 20) });
    }
  }
  if (opts.junkFly) fly.push({ time: stamp(day, 700), close: 'x' }, { close: 3 }, { time: stamp(day, 701), close: null }, { time: stamp(day, 640), close: 0.4 }, { time: stamp(day, 640), close: 7.5 });
  return { spx, fly, prof };
}
const scen = [];
for (let i = 0; i < 70; i += 1) {
  const opts = {
    wing: pick([10, 20, 25]), right: pick(['C', 'P']), qty: pick([1, 2, 3, 4, 6, 9]), debit: pick([1.2, 2.25, 3.5, 5]), vol: pick([0.15, 0.3, 0.6, 1.2, 2.5]),
    offset: pick([0, 0, 5, -12, 30, -40]), drift: pick([0, 0, 0.03, -0.05]), flyShare: pick([0, 0.3, 0.8, 1]), em: pick([36, 25, 50]),
    end: pick([960, 960, 960, 900, 780, 959]), seconds: rnd() < 0.1, nullClose: rnd() < 0.2, junkFly: rnd() < 0.15,
    action: rnd() < 0.05 ? 'SELL' : 'BUY',
  };
  if (rnd() < 0.05) opts.debit = null;
  if (rnd() < 0.05) opts.debit = 0;
  const day = pick(['2026-10-15', '2026-10-16']);
  const { spx, fly, prof } = synthDay(day, 5800, opts);
  const entryMinute = pick([570, 573, 600, 690, 840, 925]);
  let entry = stamp(day, entryMinute);
  if (rnd() < 0.05) entry = stamp('2026-10-14', 600);
  const raw = rnd() < 0.5 ? { em: opts.em } : { em: opts.em, ...pick([
    { tp1: 1.5, tp2: 2.5 }, { tp1: 1.1, tp2: 1.25 }, { tp1: 1.05, tp2: 1.15, trail_arm: 9 }, { cutoff_a_share: 0.4 }, { trail_arm: 50, stop: 0.01 }, { trail_late: '14:30', trail_late_factor: 0.3 }, { stop: 0.3, trail_arm: 1.1 }, { zone_hold: 0.3, zone_half: 0.4 },
    { trail_late: 'bad' }, { trail_late: '%1:%2' }, { otm_band: 25 }, { em: '' }, { tp2: 1.3 }, { tp1: 1.2 }, { trail_floor: 0.01, trail: 0.1 }]) };
  const actual = pick([null, { kind: 'closed', price: 3.45, pnl: 120 }, { kind: 'open', price: null, pnl: null }, { kind: 'closed', price: '4', pnl: '7' }, { kind: 'closed' }]);
  const emNote = pick([undefined, undefined, '', 'EM 取 30 点(手动填的)', '含 %1 的话']);
  scen.push({ name: `syn${i}`, profile: prof, entry, spx, fly, params: raw, actual, emNote });
}
// 写明的两天:阶段 A 里蝶价一路涨过两档固定止盈;阶段 C 里标的停在 0.5W(清一半那一档)
{
  const day = '2026-10-16', spx = [], fly = [];
  for (let m = 570; m <= 960; m += 1) {
    spx.push({ time: stamp(day, m), close: 5800 + Math.sin(m / 7) });
    if (m < 700) fly.push({ time: stamp(day, m), close: Math.round((1 + (m - 570) * 0.02) * 100) / 100 });
  }
  scen.push({ name: 'tiersAB', profile: { ...flyProfile(5800, 20, 'C'), action: 'BUY', qty: 6, multiplier: 100, debit: 1 }, entry: stamp(day, 570), spx, fly,
    params: { tp1: 1.5, tp2: 2, trail_arm: 99 }, actual: null, emNote: undefined });
  const spx2 = [];
  for (let m = 570; m <= 960; m += 1) spx2.push({ time: stamp(day, m), close: m < 920 ? 5800 : 5810 });
  const spx3 = spx2.map((b, i) => ({ ...b, close: i + 570 < 920 ? 5800 : 5809 }));
  scen.push({ name: 'stageCHold', profile: { ...flyProfile(5800, 20, 'C'), action: 'BUY', qty: 4, multiplier: 100, debit: 2 }, entry: stamp(day, 570), spx: spx3, fly: [],
    params: { trail_arm: 99, stop: 0.01 }, actual: { kind: 'closed', price: 4.4, pnl: 1 }, emNote: undefined });
  scen.push({ name: 'debitZero', profile: { ...flyProfile(5800, 20, 'C'), action: 'BUY', qty: 2, multiplier: 100, debit: 0 }, entry: stamp(day, 570), spx: spx3, fly: [],
    params: {}, actual: { kind: 'closed', price: 4.4, pnl: 1 }, emNote: undefined });
  // 数据在 15:59 断掉、手上还有:按内在价值结算(不是按最后蝶价估)
  const spx4 = spx2.filter((b, i) => i + 570 <= 959).map((b) => ({ ...b, close: 5800 }));
  scen.push({ name: 'endsAt1559', profile: { ...flyProfile(5800, 20, 'C'), action: 'BUY', qty: 3, multiplier: 100, debit: 2 }, entry: stamp(day, 570), spx: spx4, fly: [],
    params: { trail_arm: 99, stop: 0.01 }, actual: null, emNote: undefined });
  // 标的正好停在 0.8W 那条线上(算界内),之后才出界:位置止损从那一刻起才生效
  const spx5 = [];
  for (let m = 570; m <= 960; m += 1) spx5.push({ time: stamp(day, m), close: m < 600 ? 5830 : m < 610 ? 5816 : 5830 });
  scen.push({ name: 'onStopLine', profile: { ...flyProfile(5800, 20, 'C'), action: 'BUY', qty: 3, multiplier: 100, debit: 2 }, entry: stamp(day, 570), spx: spx5, fly: [],
    params: { trail_arm: 99, stop: 0.01 }, actual: null, emNote: undefined });
  scen.push({ name: 'stageCHalf', profile: { ...flyProfile(5800, 20, 'P'), action: 'BUY', qty: 5, multiplier: 100, debit: 2 }, entry: stamp(day, 570), spx: spx2, fly: [],
    params: { trail_arm: 99, stop: 0.01 }, actual: null, emNote: undefined });
}
for (const c of scen) {
  out.plans.push({ name: c.name, profile: c.profile, entry: c.entry, spx: c.spx, fly: c.fly, params: enc(c.params), actual: enc(c.actual), emNote: enc(c.emNote),
    ...run(() => X.plan(c.profile, c.entry, c.spx, c.fly, c.params, c.actual, c.emNote)) });
}
// simulate 直接吃的参数可以不是 paramsFrom 出来的(flyExitSweep 把 stop 改成 −1)
for (const c of scen.slice(0, 10)) {
  const params = X.paramsFrom(c.params);
  params.stop = -1;
  if (rnd() < 0.5) delete params.tp1;
  out.sims.push({ name: c.name, params: enc(params), ...run(() => X.simulate(c.profile, c.entry, c.spx, c.fly, params, c.actual)) });
}
const base = scen[0];
for (const [name, spx, profile] of [
  ['nullBar', [...base.spx.slice(0, 3), null], base.profile], ['noTime', [{ close: 5800 }, { close: 5801 }], base.profile],
  ['qtyNaN', base.spx, { ...base.profile, qty: undefined }], ['late', base.spx.map((b) => ({ ...b, time: b.time.replace(' 09:', ' 17:') })), base.profile],
  ['empty', [], base.profile], ['nullFly', base.spx, base.profile],
]) {
  const params = X.paramsFrom(null);
  out.sims.push({ name, spx: enc(spx), profile: enc(profile), params: enc(params), entry: name === 'noTime' ? '' : base.entry, fly: name === 'nullFly' ? [null] : '__undefined__', ...run(() => X.simulate(profile, name === 'noTime' ? '' : base.entry, spx, name === 'nullFly' ? [null] : base.fly, params, null)) });
}

writeFileSync(join(here, 'flyexit.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
console.log('flyexit.json', Object.entries(out).map(([k, v]) => `${k}=${v.length}`).join(' '));
