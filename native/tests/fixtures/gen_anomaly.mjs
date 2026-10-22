// 生成 anomaly.json:engine-ts 的 anomaly.ts(原模块现跑)。触发条件校验(数字串、布尔、越界、乱序档位、窗口只能 3 / 5 / 10)、
// 日内成交量曲线与方差曲线(半日市、负数、NaN)、样本序列的追加与裁剪、窗口涨跌、状态恢复(库里的 JSON 串、坏字段)、
// 以及一只股一天的整段走法:5 秒到 5 分钟一轮,价格随机游走,穿插放量(窗口里持续的、一笔大宗)、急涨急跌、跳空开盘、冷却与重新上膛、
// 换日重置、半日市、没有均量 / 历史波动率、流里的近 W 分钟量、大盘参照与「扣掉大盘」、suppress 与 opened=false。每一轮的事件、状态与指标逐字比。
//   ELECTRON_RUN_AS_NODE=1 …/Electron native/tests/fixtures/gen_anomaly.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const A = await import(pathToFileURL(join(engine, 'dist/src/anomaly.js')).href);

let seed = 0xa40a_71e5;
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

const out = { normalize: [], cum: [], variance: [], push: [], winret: [], coerce: [], configs: [], walks: [], edges: [] };

// ---------------------------------------------------------------- 设置
const valuePool = [true, false, 0, 1, 2, 3, 4, 5, 10, 20, 50, 51, '5', ' 7 ', '', 'x', 2.5, -1, 0.3, '0.3', '1e1', 1.2, 1.19999, 1.5, 0.1, 0.2, 240, 241, 1e-9, 0.123456, '0.12345',
  null, [], [2], [2, 3], ['2', 3, 3], [5, 3, 2], [1.2, 50], [1.1], [51], [1, 2, 3, 4, 5, 6], [2, 2, 2, 2, 2, 2], [true], ['a'], {}, NaN, Infinity, 'Infinity', '字'.repeat(45), [0.5, 20], [0.4], [21]];
const keyPool = ['rvol_tiers', 'burst_ratio', 'window_min', 'spike_sigma', 'spike_min_pct', 'spike_fixed_pct', 'day_sigma_tiers', 'day_fixed_tiers', 'cooldown_min', 'market_adjust', 'bogus', 'toString'];
const rawConfig = () => { const o = {}; for (let n = Math.floor(rnd() * 6); n > 0; n -= 1) o[pick(keyPool)] = pick(valuePool); return o; };
const bases = [undefined, { rvol_tiers: [1.5, 2], burst_ratio: 3, window_min: 10, spike_sigma: 3, spike_min_pct: 0.5, spike_fixed_pct: 1, day_sigma_tiers: [1, 2], day_fixed_tiers: [2, 4], cooldown_min: 5, market_adjust: true }];
for (const raw of [undefined, null, [], 'abc', 5, true, {}, { window_min: 3 }, { window_min: '10' }, { window_min: 5.0 }, { window_min: 4 }, { window_min: 0 }, { market_adjust: 'true' },
  { rvol_tiers: [50, 1.2, 50] }, { day_sigma_tiers: [20, 0.5], day_fixed_tiers: [50] }, { spike_min_pct: '0.12345', cooldown_min: 1 }, { burst_ratio: null, rvol_tiers: null }]) {
  for (const base of bases) out.normalize.push({ raw: enc(raw), base: enc(base), ...run(() => A.normalizeAnomalyConfig(raw, base)) });
}
for (let i = 0; i < 700; i += 1) { const raw = rawConfig(), base = pick(bases); out.normalize.push({ raw: enc(raw), base: enc(base), ...run(() => A.normalizeAnomalyConfig(raw, base)) }); }

// ---------------------------------------------------------------- 曲线
const minutes = [-Infinity, -5, -0, 0, 0.5, 1, 4.99, 5, 5.01, 100, 194.99, 195, 300, 384, 385, 389.99, 390, 391, 1000, NaN, Infinity, ...Array.from({ length: 120 }, () => rnd() * 400 - 5)];
const sessions = [undefined, 390, 210, 195, 0, -5, NaN, Infinity, 1, 600, 389.5];
for (const m of minutes) for (const s of sessions) out.cum.push({ m: enc(m), s: enc(s), out: enc(A.cumVolumeFraction(m, s)) });
for (let i = 0; i < 500; i += 1) {
  const a = pick([-30, -1, 0, 1, 15, 29.9, 30, 100, 195, 360, 385, 389, 390, 400, NaN, rnd() * 400]), b = pick([-5, 0, 5, 15, 30, 31, 195, 389, 390, 420, NaN, Infinity, rnd() * 400]);
  out.variance.push({ a: enc(a), b: enc(b), out: enc(A.varianceShare(a, b)) });
}

// ---------------------------------------------------------------- 样本
const tPool = [0, 1, 1000, 2000, 3000, 3000, 60_000, 120_000, 1_200_000, 1_500_000, 5_000_000, NaN, Infinity, -5];
const numPool = [null, 0, 100, 1000, 12345.5, -3, NaN, Infinity, 7];
const randSample = () => ({ t: pick(tPool), volume: pick(numPool), last: pick(numPool) });
for (let i = 0; i < 300; i += 1) {
  const samples = Array.from({ length: Math.floor(rnd() * 8) }, randSample);
  const s = rnd() < 0.15 ? pick([null, undefined, { t: NaN, volume: 1, last: 1 }]) : randSample();
  const keep = pick([undefined, 0, 1000, 1_200_000, -1, NaN, Infinity, 60_000]);
  out.push.push({ samples: enc(samples), s: enc(s), keep: enc(keep), ...run(() => A.pushSample(samples, s, keep)) });
  const nowMs = pick([1000, 3000, 60_000, 120_000, 1_200_000, 5_000_000, NaN]), w = pick([3, 5, 10, 0, 1]);
  out.winret.push({ samples: enc(samples), nowMs: enc(nowMs), w, ...run(() => A.windowReturnPct(samples, nowMs, w)) });
}
{
  // 写明的:窗口起点正好 90 秒前、差 1 毫秒
  const nowMs = 1_000_000;
  for (const dt of [300_000, 390_000, 390_001, 300_001, 299_999]) {
    const samples = [{ t: nowMs - dt, volume: 1, last: 100 }, { t: nowMs, volume: 2, last: 101 }];
    out.winret.push({ samples: enc(samples), nowMs, w: 5, ...run(() => A.windowReturnPct(samples, nowMs, 5)) });
  }
}

// ---------------------------------------------------------------- 状态恢复
const stateJson = (o) => JSON.stringify(o);
const goodState = { date: '2026-10-16', rvol_fired: 3, day_up_fired: 2, day_down_fired: 1, max_step_share: 0.05, burst: { armed: false, last_fired_at: 1000 }, spike: { armed: true, last_fired_at: null } };
for (const raw of [null, undefined, 'abc', '', 5, [], {}, goodState, stateJson(goodState), stateJson([1]), 'null', '"x"', { ...goodState, date: '' }, { ...goodState, date: 5 },
  { ...goodState, rvol_fired: -1, day_up_fired: 2.9, day_down_fired: 'x', max_step_share: NaN }, { ...goodState, burst: 'x', spike: { armed: 'yes', last_fired_at: '5' } },
  { ...goodState, burst: [], spike: { armed: false, last_fired_at: Infinity } }, { date: '2026-10-15' }, { burst: { armed: false } }]) {
  for (const date of ['2026-10-16', '2026-10-17']) out.coerce.push({ raw: enc(raw), date, ...run(() => A.coerceState(raw, date)) });
}
for (const raw of [{ ...goodState, rvol_fired: Infinity, max_step_share: Infinity, day_up_fired: Infinity }, { ...goodState, rvol_fired: -Infinity, day_down_fired: NaN }]) out.coerce.push({ raw: enc(raw), date: '2026-10-16', ...run(() => A.coerceState(raw, '2026-10-16')) });
out.coerce.push({ raw: '__undefined__', date: 'd', fresh: true, ...run(() => A.freshState('d')) });

// ---------------------------------------------------------------- 整天的走法
const DAY = Date.parse('2026-10-16T13:30:00Z');
const configs = [A.DEFAULT_ANOMALY_CONFIG, A.normalizeAnomalyConfig({ market_adjust: true }), A.normalizeAnomalyConfig({ window_min: 3, cooldown_min: 1, burst_ratio: 2 }),
  A.normalizeAnomalyConfig({ window_min: 10, rvol_tiers: [1.5, 2, 4], day_sigma_tiers: [1, 2], day_fixed_tiers: [1, 2, 3], spike_sigma: 2, spike_min_pct: 0.3 }),
  { ...A.DEFAULT_ANOMALY_CONFIG, window_min: 7, rvol_tiers: [], day_fixed_tiers: [], day_sigma_tiers: [] }, A.normalizeAnomalyConfig({ market_adjust: true, cooldown_min: 240, spike_fixed_pct: 0.2, day_fixed_tiers: [0.5, 1] }),
  { ...A.DEFAULT_ANOMALY_CONFIG, spike_fixed_pct: 0 }, { ...A.DEFAULT_ANOMALY_CONFIG, day_fixed_tiers: [0] }];
out.configs = configs;

function makeWalk(w) {
  const cfg = pick([0, 1, 2, 3, 1, 2, 4, 5]);
  const session = pick([390, 390, 390, 210, undefined]);
  const sess = session ?? 390;
  const hasAvg = rnd() < 0.8, hasVol = rnd() < 0.8, hasOpenGap = rnd() < 0.5;
  const avg = pick([1e6, 5e6, 2e7, 3e5]);
  const histVol = hasVol ? pick([0.2, 0.32, 0.6, 1.5, 6]) : null;
  const price0 = pick([41.2, 180, 450, 7000]);
  const gapPct = hasOpenGap ? pick([-0.06, -0.025, 0.012, 0.03, 0.09]) : 0;
  const prevClose = price0;
  let price = prevClose * (1 + gapPct);
  const open = price;
  let minute = pick([0, 0, 0.1, 5, 14.9, 30]);
  let vol = 0;
  const dt = pick([5, 5, 10, 30, 60, 120]);
  const burstAt = Math.floor(rnd() * 40), blockAt = Math.floor(rnd() * 40), spikeAt = Math.floor(rnd() * 40);
  let samples = [];
  const steps = [];
  let state = null;
  const market = rnd() < 0.5;
  let mk = 0;
  const stepsN = 45;
  let etDate = '2026-10-16';
  for (let i = 0; i < stepsN; i += 1) {
    minute += dt / 60;
    const frac = A.cumVolumeFraction(minute, sess);
    const pace = (avg ?? 1e6) * (hasAvg ? 1 : 1) * (frac - A.cumVolumeFraction(minute - dt / 60, sess)) * (0.8 + 0.4 * rnd());
    let step = Math.max(0, pace);
    const burstOn = i >= burstAt && i < burstAt + 14;
    if (burstOn) step *= pick([6, 8, 15]);
    if (i === blockAt) step += (avg ?? 1e6) * pick([0.05, 0.2, 1]);
    vol += step;
    let move = gauss() * 0.0004 * Math.sqrt(dt / 5);
    if (i === spikeAt) move += pick([0.03, -0.03, 0.012, -0.008]);
    if (burstOn) move += 0.0008 * Math.sign(gauss());
    price *= 1 + move;
    mk += gauss() * 0.0003;
    const nowMs = DAY + minute * 60_000;
    const snap = {
      last: rnd() < 0.03 ? pick([null, 0, NaN]) : Math.round(price * 10000) / 10000,
      close: rnd() < 0.02 ? null : prevClose,
      ...(rnd() < 0.8 ? { open: rnd() < 0.1 ? null : Math.round(open * 100) / 100 } : {}),
      volume: rnd() < 0.03 ? pick([null, 0]) : Math.round(vol),
      avg_volume: hasAvg ? avg : pick([null, 0]),
      hist_vol: histVol,
      ...(rnd() < 0.5 ? { vol_3m: Math.round(vol * 0.01), vol_5m: Math.round(vol * 0.02), vol_10m: pick([Math.round(vol * 0.04), -1, null]) } : {}),
      ...(rnd() < 0.2 ? { delayed: pick([true, false]) } : {}),
    };
    const pushIt = rnd() > 0.04;
    const sample = { t: nowMs, volume: snap.volume, last: snap.last };
    if (pushIt) samples = A.pushSample(samples, sample);
    const suppress = rnd() < 0.05 ? true : undefined;
    const opened = rnd() < 0.1 ? pick([false, true]) : undefined;
    const marketMove = market && rnd() < 0.9 ? { change_pct: rnd() < 0.1 ? null : Math.round(mk * 10000) / 100, ret_window_pct: rnd() < 0.2 ? null : Math.round(gauss() * 0.2 * 100) / 100 } : pick([undefined, null]);
    // 偶尔换日 / 塞一份旧状态 / 坏状态
    let stateOverride;
    if (i === 20 && rnd() < 0.3) stateOverride = { ...(state ?? goodState), date: '2026-10-15', rvol_fired: 5, day_up_fired: 3, day_down_fired: 3 };
    else if (i === 25 && rnd() < 0.2) stateOverride = pick(['garbage', stateJson(goodState), 5, [], null]);
    const useState = stateOverride !== undefined ? stateOverride : state;
    const minuteArg = rnd() < 0.02 ? pick([NaN, null, -3, sess, sess + 5]) : minute;
    const args = { symbol: pick(['NVDA', 'SPY', 'A:B']), snap: rnd() < 0.01 ? null : snap, samples, state: useState, nowMs, etDate, minute: minuteArg, sessionMinutes: session, config: configs[cfg],
      suppress, market: marketMove, opened };
    const r = run(() => A.evaluateAnomalies(args));
    const rec = { push: pushIt ? enc(sample) : null, snap: enc(args.snap), minute: enc(minuteArg), nowMs, symbol: args.symbol, ...r };
    if (stateOverride !== undefined) rec.state = enc(stateOverride);
    if (suppress) rec.suppress = true;
    if (opened !== undefined) rec.opened = opened;
    if (marketMove !== undefined) rec.market = enc(marketMove);
    steps.push(rec);
    if (r.out) state = A.evaluateAnomalies(args).state;
    if (etDate !== '2026-10-16') rec.etDate = etDate;
    if (i === 30 && rnd() < 0.1) etDate = '2026-10-19';
  }
  out.walks.push({ w, cfg, session: enc(session), steps });
}
for (let w = 0; w < 60; w += 1) makeWalk(w);

// ---------------------------------------------------------------- 边界上的单次判定
/** (p / base − 1) × 100 落在 [target − 1e-10, target) 里的价(离目标最近的一个) */
function justBelow(base, target) {
  let best = null;
  const center = base * (1 + target / 100);
  for (let k = -400; k <= 400; k += 1) {
    const p = center + k * center * 2.3e-16;
    const v = (p / base - 1) * 100;
    if (v < target && v >= target - 1e-10 && (best === null || v > (best / base - 1) * 100)) best = p;
  }
  if (best === null) throw new Error(`no value near ${target} for ${base}`);
  return best;
}
const NOW = DAY + 60 * 60_000;
const baseSnap = { last: 100, close: 100, volume: 5e5, avg_volume: 1e6, hist_vol: null };
const edge = (name, a) => {
  const args = { symbol: 'EDGE', snap: baseSnap, samples: [], state: null, nowMs: NOW, etDate: '2026-10-16', minute: 60, sessionMinutes: undefined, config: configs[0], ...a };
  const cfgIdx = configs.indexOf(args.config);
  const r = run(() => A.evaluateAnomalies(args));
  out.edges.push({ name, snap: enc(args.snap), samples: enc(args.samples), state: enc(args.state), nowMs: args.nowMs, minute: enc(args.minute), session: enc(args.sessionMinutes), cfg: cfgIdx,
    suppress: args.suppress, market: enc(args.market), opened: args.opened, ...r });
};
const ev = (...[n, a]) => edge(n, a);
const loudSamples = (volumes, now, last = 100) => volumes.map((volume, i) => ({ t: now - (volumes.length - 1 - i) * 60_000, volume, last }));
// 光是开盘跳空就够这一档,离档只差一点点(1e-10 以内)
{
  const lastB = justBelow(100, 3), openB = justBelow(100, 3);
  ev('gap-and-tier-eps', { snap: { last: lastB, close: 100, open: openB, volume: 5e5, avg_volume: 1e6, hist_vol: null }, minute: 1 });
  ev('tier-eps-only', { snap: { last: lastB, close: 100, open: 100, volume: null, avg_volume: null, hist_vol: null }, minute: 0 });
  ev('tier-5-eps', { snap: { last: justBelow(100, 5), close: 100, open: 101, volume: null, avg_volume: null, hist_vol: null }, minute: 0 });
}
ev('zero-change-rvol-direction', { snap: { ...baseSnap, volume: 1e6 }, nowMs: NOW });
ev('half-second-round', { nowMs: NOW + 500, snap: { ...baseSnap, volume: 1e6 } });
ev('half-second-below', { nowMs: NOW + 499, snap: { ...baseSnap, volume: 1e6 } });
ev('half-day-late-rvol', { sessionMinutes: 210, minute: 208, snap: { ...baseSnap, volume: 3e6 }, nowMs: DAY + 208 * 60_000 });
ev('half-day-in-rvol', { sessionMinutes: 210, minute: 200, snap: { ...baseSnap, volume: 3e6 }, nowMs: DAY + 200 * 60_000 });
ev('rvol-at-385', { minute: 385, snap: { ...baseSnap, volume: 3e6 }, nowMs: DAY + 385 * 60_000 });
ev('rvol-at-384', { minute: 384.99, snap: { ...baseSnap, volume: 3e6 }, nowMs: DAY + 384.99 * 60_000 });
ev('day-move-at-open', { minute: 0, snap: { last: 105, close: 100, open: 105, volume: null, avg_volume: null, hist_vol: null }, nowMs: DAY });
ev('day-move-before-open', { minute: -0.001, snap: { last: 105, close: 100, open: 105, volume: null, avg_volume: null, hist_vol: null }, nowMs: DAY });
{
  const now = NOW;
  // 窗口里量一样(量增 0):窗口量 0;流里有近 5 分钟量
  ev('window-volume-zero', { samples: loudSamples([1e6, 1e6], now).map((x, i) => (i === 0 ? { ...x, t: now - 300_000 } : x)), nowMs: now,
    snap: { last: 100, close: 100, volume: 1e6, avg_volume: 1e7, hist_vol: null, vol_5m: 50000, vol_3m: 20000, vol_10m: 90000 } });
  // 当日量比窗口起点那一条还少(流重订 / 口径跳变):样本差是负的,不用,退回流里的近 5 分钟量
  ev('window-volume-negative', { samples: [{ t: now - 300_000, volume: 5e6, last: 100 }, { t: now, volume: 1e6, last: 100 }], nowMs: now,
    snap: { last: 100, close: 100, volume: 1e6, avg_volume: 1e7, hist_vol: null, vol_5m: 50000, vol_3m: 20000, vol_10m: 90000 } });
  ev('window-volume-negative-nostream', { samples: [{ t: now - 300_000, volume: 5e6, last: 100 }, { t: now, volume: 1e6, last: 100 }], nowMs: now,
    snap: { last: 100, close: 100, volume: 1e6, avg_volume: 1e7, hist_vol: null } });
  // 5 步里有 3 步量增是 0:仍然是 5 步,去掉最大一步还够倍数
  const vols = [1e6, 1e6, 1e6, 1e6, 5e6, 9e6];
  const samples = loudSamples(vols, now);
  ev('zero-steps-count', { samples, nowMs: now, snap: { last: 101, close: 100, volume: 9e6, avg_volume: 1e7, hist_vol: null } });
  ev('zero-steps-count-w3', { samples, nowMs: now, config: configs[2], snap: { last: 101, close: 100, volume: 9e6, avg_volume: 1e7, hist_vol: null } });
  // 刚好 4 步 / 3 步
  ev('steps-exactly-4', { samples: loudSamples([1e6, 1e6, 3e6, 5e6, 9e6], now).map((x, i, all) => ({ ...x, t: now - (all.length - 1 - i) * 75_000 })), nowMs: now,
    snap: { last: 101, close: 100, volume: 9e6, avg_volume: 1e7, hist_vol: null } });
  ev('steps-exactly-3', { samples: loudSamples([1e6, 3e6, 5e6, 9e6], now).map((x, i, all) => ({ ...x, t: now - (all.length - 1 - i) * 100_000 })), nowMs: now,
    snap: { last: 101, close: 100, volume: 9e6, avg_volume: 1e7, hist_vol: null } });
  // 量比正好落在门槛边上
  for (const mul of [4, 4 - 1e-12, 4 - 1e-8]) {
    const normal = 1e7 * (A.cumVolumeFraction(60) - A.cumVolumeFraction(55));
    const x = normal * mul;
    ev(`burst-ratio-${mul}`, { samples: [{ t: now - 300_000, volume: 1e6, last: 100 }, { t: now - 200_000, volume: 1e6 + x / 2, last: 100 }, { t: now - 100_000, volume: 1e6 + x / 2 + 1, last: 100 },
      { t: now - 50_000, volume: 1e6 + x / 2 + 2, last: 100 }, { t: now, volume: 1e6 + x, last: 100 }], nowMs: now, snap: { last: 100, close: 100, volume: 1e6 + x, avg_volume: 1e7, hist_vol: null } });
  }
}
// 第 6 分钟(W=5 时窗口起点刚过开盘竞价)
{
  const now = DAY + 6 * 60_000;
  const vols = [1e6, 1e6, 1e6, 4e6, 7e6, 7e6 + 6e6];
  ev('burst-at-minute-6', { samples: loudSamples(vols, now), nowMs: now, minute: 6, snap: { last: 100, close: 100, volume: 13e6, avg_volume: 1e7, hist_vol: null } });
  ev('burst-at-minute-5.99', { samples: loudSamples(vols, now), nowMs: now, minute: 5.99, snap: { last: 100, close: 100, volume: 13e6, avg_volume: 1e7, hist_vol: null } });
}
// 急涨急跌:第 15 分钟、正好在阈值上、离阈值只差一点
{
  const now = DAY + 15 * 60_000;
  const lastB = justBelow(200, 1.5);
  const sp = (last) => [{ t: now - 300_000, volume: 1, last: 200 }, { t: now, volume: 2, last }];
  ev('spike-at-15', { samples: sp(203), nowMs: now, minute: 15, snap: { last: 203, close: 200, volume: null, avg_volume: null, hist_vol: null } });
  ev('spike-at-14.99', { samples: sp(203), nowMs: now - 600, minute: 14.99, snap: { last: 203, close: 200, volume: null, avg_volume: null, hist_vol: null } });
  ev('spike-eps-below', { samples: sp(lastB), nowMs: now, minute: 15, snap: { last: lastB, close: 200, volume: null, avg_volume: null, hist_vol: null } });
  ev('spike-flat-zero-threshold', { samples: sp(200), nowMs: now, minute: 15, config: configs[6], snap: { last: 200, close: 200, volume: null, avg_volume: null, hist_vol: null } });
  ev('spike-with-market-nan', { samples: sp(203), nowMs: now, minute: 15, config: configs[1], market: { change_pct: NaN, ret_window_pct: NaN }, snap: { last: 203, close: 200, volume: null, avg_volume: null, hist_vol: null } });
  ev('spike-with-market-inf', { samples: sp(203), nowMs: now, minute: 15, config: configs[1], market: { change_pct: Infinity, ret_window_pct: -Infinity }, snap: { last: 203, close: 200, volume: null, avg_volume: null, hist_vol: null } });
  ev('spike-market-same', { samples: sp(203), nowMs: now, minute: 15, config: configs[1], market: { change_pct: 3, ret_window_pct: 1.5 }, snap: { last: 203, close: 200, volume: null, avg_volume: null, hist_vol: null } });
  ev('spike-market-half', { samples: sp(203), nowMs: now, minute: 15, config: configs[1], market: { change_pct: 3, ret_window_pct: 0.4 }, snap: { last: 203, close: 200, volume: null, avg_volume: null, hist_vol: null } });
  ev('spike-market-opposite', { samples: sp(203), nowMs: now, minute: 15, config: configs[1], market: { change_pct: 3, ret_window_pct: -2 }, snap: { last: 203, close: 200, volume: null, avg_volume: null, hist_vol: null } });
  ev('spike-market-note-off', { samples: sp(203), nowMs: now, minute: 15, market: { change_pct: 3, ret_window_pct: 0.4 }, snap: { last: 203, close: 200, volume: null, avg_volume: null, hist_vol: null } });
}
ev('day-zero-tier', { config: configs[7], snap: { last: 100, close: 100, volume: null, avg_volume: null, hist_vol: null } });
ev('day-market-nan', { config: configs[1], market: { change_pct: NaN, ret_window_pct: null }, snap: { last: 105, close: 100, volume: null, avg_volume: null, hist_vol: null } });
ev('day-market-net', { config: configs[1], market: { change_pct: 3, ret_window_pct: null }, snap: { last: 105, close: 100, open: 103, volume: null, avg_volume: null, hist_vol: null } });
ev('day-market-none-adjust', { config: configs[1], snap: { last: 105, close: 100, volume: null, avg_volume: null, hist_vol: null } });
ev('day-sigma', { snap: { last: 105, close: 100, open: 99, volume: null, avg_volume: null, hist_vol: 0.3 } });
ev('state-null-obj', { state: null });
ev('state-string-garbage', { state: 'not json' });
ev('state-yesterday-fired', { state: { ...goodState, date: '2026-10-15', rvol_fired: 5, day_up_fired: 3 }, snap: { ...baseSnap, volume: 3e6, last: 105 } });
ev('state-today-fired-rvol', { state: { ...goodState, rvol_fired: 3, day_up_fired: 3 }, snap: { ...baseSnap, volume: 4e6 } });
ev('ex-block-share', { state: { ...goodState, max_step_share: 0.5 }, snap: { ...baseSnap, volume: 6e5 } });

writeFileSync(join(here, 'anomaly.json'), JSON.stringify({ runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, ...out }) + '\n');
console.log('anomaly.json', Object.entries(out).map(([k, v]) => `${k}=${v.length}`).join(' '));
