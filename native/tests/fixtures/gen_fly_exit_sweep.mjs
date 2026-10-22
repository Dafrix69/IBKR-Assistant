// 生成 fly-exit-sweep-{spec,run,stats,report}.json:engine-ts 的 flyExitSweep / Spec / Stats / Report(原模块现跑)。
//   spec   盘口 → 蝶价、入场价、实盘参数换 Targets、网格与点名组(含每一句报错)、回放网格、真实入场与网格文件的读法、入场时刻的写法
//   run    runSweep 在一批现造的"记下来的天"上的整份结果(网格 / 真实入场 / 缺报价 / 成交口径 / 了结 / 到点与止损 / 回放 / 人群限定 / 配置报错),
//          外加 onDay 的进度回调
//   stats  mulberry32 的前 N 个数、degenerateProb、exactLower、analyse(多种矩阵与选项)、verdictOf、summarise
//   report formatReport 在各种结果与结论上写出的每一行
// 判定函数 = 打包应用里那份 tracker.js(和 scripts/sweep-fly-exit.mjs 递的一样);随机数全用固定种子;样本是现造的,不含任何真数据。
//   ELECTRON_RUN_AS_NODE=1 desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/tests/fixtures/gen_fly_exit_sweep.mjs <编过的 engine-ts 目录>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2];
if (!engine) throw new Error('要给编过的 engine-ts 目录');
const lib = (n) => import(pathToFileURL(join(engine, `dist/src/${n}.js`)).href);
const sweep = await lib('flyExitSweep');
const spec = await lib('flyExitSweepSpec');
const stats = await lib('flyExitSweepStats');
const report = await lib('flyExitSweepReport');
const tk = await lib('tracker');
const { builtinCalendar } = await lib('marketCalendar');
const { ET, wallToEpoch } = await lib('tz');

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
const wrap = (f) => { try { return { out: enc(f()) }; } catch (e) { return { error: String(e?.message ?? e) }; } };

// ---------------------------------------------------------------- 现造的"记下来的天"
const rng = stats.seededRandom;
const normal = (next) => Math.sqrt(-2 * Math.log(next() + 1e-300)) * Math.cos(2 * Math.PI * next());
const r2 = (v) => Math.round(v * 100) / 100;
const at = (date, hhmm) => {
  const [y, m, d] = date.split('-').map(Number);
  return wallToEpoch({ year: y, month: m, day: d, hour: Number(hhmm.slice(0, 2)), minute: Number(hhmm.slice(3)), second: 0 }, ET);
};
const hhmm = (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const CLOCK = Array.from({ length: 77 }, (_v, i) => hhmm(9 * 60 + 35 + 5 * i));
const QUARTERS = CLOCK.filter((_c, i) => i % 3 === 0 || i === CLOCK.length - 1);
const leg = (strike, right, bid, ask) => ({ strike, right, bid, ask });
const HALF = 0.2;

/** 三条看涨腿摆成"蝶的中间价正好是 mid"(买得到 mid + 0.20、卖得掉 mid − 0.20),外加现价所在行权价的平值跨式(回放取 EM 用) */
function tick(date, clock, mid, spot = 7010, legs = null, extra = {}) {
  const atm = Math.round(spot / 5) * 5;
  return {
    t: at(date, clock), spot, ...extra,
    legs: legs ?? [
      leg(7000, 'C', r2(mid + 9.0), r2(mid + 9.1)), leg(7025, 'C', 5.0, 5.1), leg(7050, 'C', 1.0, 1.1),
      leg(atm, 'C', 14.0, 14.2), leg(atm, 'P', 13.9, 14.1),
    ],
  };
}
const dayOf = (date, mids, spot = 7010, clock = CLOCK) => mids.map((m, i) => tick(date, clock[i] ?? '15:55', m, spot));
function tradingDays(n, from = [2026, 2, 2]) {
  const closed = new Set(builtinCalendar().holidays);
  const out = [];
  for (let d = Date.UTC(from[0], from[1], from[2]); out.length < n; d += 86_400_000) {
    const date = new Date(d).toISOString().slice(0, 10), dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6 && !closed.has(date)) out.push(date);
  }
  return out;
}
function hill(date, peak, end, clock = CLOCK, spot = 7010) {
  const last = clock.length - 1, top = Math.round(last * 0.27);
  return clock.map((c, i) => tick(date, c, r2(i <= top ? 1.8 + ((peak - 1.8) * i) / top : peak - ((peak - end) * (i - top)) / (last - top)), spot));
}
function hills(days, seed, clock = CLOCK) {
  const next = rng(seed);
  return tradingDays(days).flatMap((date) => hill(date, 2.6 + 0.35 * next(), 0.6 + 0.6 * next(), clock));
}
/** 一路随机走的一天(蝶价与现价都在动) */
function walk(date, seed, clock = CLOCK) {
  const next = rng(seed);
  let mid = r2(Math.round((1 + 2 * next()) * 20) / 20), spot = 7010;
  return clock.map((c, i) => {
    if (i > 0) { mid = r2(Math.min(20, Math.max(0.6, mid + 0.3 * normal(next) + 0.02))); spot = r2(spot + 1.5 * normal(next)); }
    return tick(date, c, mid, spot);
  });
}
/** 多行权价的一天:看涨 6975…7075、看跌 6950…7010(都是 25 一档),价随 mid 抖动;够摆出几只不同的蝶 */
function wideDay(date, seed, clock = QUARTERS) {
  const next = rng(seed);
  let base = 3.0;
  return clock.map((c) => {
    base = r2(Math.min(8, Math.max(1.5, base + 0.25 * normal(next))));
    const legs = [];
    for (const [k, right] of [[6975, 'C'], [7000, 'C'], [7025, 'C'], [7050, 'C'], [7075, 'C'], [6950, 'P'], [6975, 'P'], [7000, 'P'], [7025, 'P']]) {
      const dist = Math.abs(k - 7010) / 25, bid = r2(Math.max(0.05, 14 * Math.exp(-dist * 0.9) + base * 0.3 * next())), ask = r2(bid + 0.1 + 0.2 * next());
      legs.push(leg(k, right, bid, ask));
    }
    legs.push(leg(7010, 'C', 14.0, 14.2), leg(7010, 'P', 13.9, 14.1));
    return { t: at(date, c), spot: 7010, legs };
  });
}

const POP = { by: 'loop', entry_from: null, entry_to: null, wings: null, rights: null, debit_min: null, debit_max: null, dist_min: null, dist_max: null };
const FILL = { entry_spread_share: 1, commission: null, terminal: 'natural', settle_within_min: 6, stop_basis: 'mid', qty: 1, multiplier: 100 };
const REF = spec.liveReference();
const config = (over = {}) => ({ symbol: 'SPX', population: POP, entries: null, fill: FILL, live: spec.liveSets(REF, null), replay: null, stride: 1, ...over });
const onlyAt = (clock, more = {}) => ({ ...POP, entry_from: clock, entry_to: clock, ...more });
const BOOT = { level: 0.95, draws: 200, seed: 7 };
const HILL_SETS = spec.liveSets(REF, { arm_usd: [50, 150] }, [{ stop_mult: 0.5 }, { exit_at: '15:00' }]);

// ================================================================ spec
const S = { quote: [], intrinsic: [], debit: [], reference: enc(REF), targets: [], unitCost: [], liveSets: [], labels: [], replaySets: [], replayLabel: [], entryTime: [], entries: [], gridFile: [], legKey: [] };
const FLY = { center: 7025, wing: 25, right: 'C' };
{
  const q = (a, b, c) => [leg(7000, 'C', ...a), leg(7025, 'C', ...b), leg(7050, 'C', ...c)];
  const smp = (legs, extra = {}) => ({ t: 1, spot: 7010, legs, ...extra });
  const cases = [
    [q([12.4, 12.6], [5.0, 5.2], [1.05, 1.15]), FLY], [q([0.3, 0.4], [0.05, 0.1], [0, 0.05]), FLY], [q([0.1, 0.2], [0.05, 0.15], [0, 0.05]), FLY],
    [q([12.4, 12.6], [5.0, null], [1.05, 1.15]), FLY], [q([12.4, 12.6], [null, 5.2], [1.05, 1.15]), FLY], [q([12.6, 12.4], [5.0, 5.2], [1.05, 1.15]), FLY],
    [q([12.4, 12.6], [5.0, 5.2], [0, 0]), FLY], [q([12.4, 12.6], [5.0, 5.2], [1.05, 1.15]), { ...FLY, right: 'P' }], [q([12.4, 12.6], [5.0, 5.2], [1.05, 1.15]), { ...FLY, wing: 50 }],
    [q([null, null], [5.0, 5.2], [1.05, 1.15]), FLY], [q([12.4, 12.6], [5.0, 5.2], [-0.1, 0.1]), FLY], [q([12.5, 12.5], [5.1, 5.1], [1.1, 1.1]), FLY],
    [q([12.4, 12.6], [5.0, 5.2], [1.05, 1.15]), { ...FLY, wing: 12.5 }], [[leg(7012.5, 'C', 3, 3.2), leg(7025, 'C', 2, 2.2), leg(7037.5, 'C', 1, 1.2)], { center: 7025, wing: 12.5, right: 'C' }],
    [[leg(7000, 'c', 12.4, 12.6), leg(7025, 'call', 5.0, 5.2), leg(7050, 'C ', 1.05, 1.15)], FLY], [[leg(7000, 'P', 12.4, 12.6), leg(7025, 'p', 5.0, 5.2), leg(7050, 'put', 1.05, 1.15)], { ...FLY, right: 'P' }],
    // 重复的腿:后一个盖前一个(new Map)
    [[leg(7000, 'C', 1, 1.1), leg(7000, 'C', 12.4, 12.6), leg(7025, 'C', 5.0, 5.2), leg(7050, 'C', 1.05, 1.15)], FLY],
    [[leg(7000, 'C', 12.4, 12.6), leg(7025, 'C', 5.0, 5.2), leg(7050, 'C', 1.05, 1.15)], { center: 7025.123456789, wing: 25, right: 'C' }],
    [[], FLY],
  ];
  for (const [legs, fly] of cases) S.quote.push({ sample: enc(smp(legs)), fly, ...wrap(() => spec.flyQuote(smp(legs), fly)) });
  // 随机盘口:每条腿各种缺与倒挂
  const next = rng(11);
  for (let i = 0; i < 300; i += 1) {
    const px = () => { const u = next(); return u < 0.08 ? [null, null] : u < 0.14 ? [r2(next() * 3), null] : u < 0.2 ? [null, r2(next() * 3)] : u < 0.26 ? [0, r2(next() * 0.2)] : u < 0.3 ? [2, 1] : u < 0.33 ? [0, 0] : (() => { const b = r2(next() * 8); return [b, r2(b + next() * 0.4)]; })(); };
    const legs = q(px(), px(), px());
    const fly = { center: 7025, wing: 25, right: next() < 0.8 ? 'C' : 'P' };
    S.quote.push({ sample: enc(smp(legs)), fly, ...wrap(() => spec.flyQuote(smp(legs), fly)) });
  }
  for (const right of ['C', 'P', 'p', 'X']) {
    for (const wing of [25, 12.5]) {
      for (const s of [6990, 7000, 7010, 7025, 7040, 7050, 7060, 7037.5, 7012.5, -1, 1e9]) S.intrinsic.push({ fly: { center: 7025, wing, right }, spot: s, ...wrap(() => spec.flyIntrinsic({ center: 7025, wing, right }, s)) });
    }
  }
  S.intrinsic.push({ fly: FLY, spot: '__NaN__', ...wrap(() => spec.flyIntrinsic(FLY, NaN)) });
  for (const [mid, open, share, tick_] of [[3.4, 3.75, 1, 0.05], [3.4, 3.75, 0, 0.05], [3.4, 3.75, 0.5, 0.05], [3.4, 3.75, 0.5, 0.01], [3.4, 3.75, 0.5, 0], [3.4, 3.75, 0.5, -1], [3.4, 3.4, 1, 0.05], [3.4, 3.4, 1, 0.05],
    [2.05, 2.25, 0.3, 0.05], [2.05, 2.25, 0.3, 0.1], [0.05, 0.1, 1, 0.05], [1e-12, 1e-12, 1, 0.05], [3.5, 3.2, 1, 0.05], [100, 100.2, 0.7, 0.25]]) {
    S.debit.push({ args: [mid, open, share, tick_], ...wrap(() => spec.entryDebit(mid, open, share, tick_)) });
  }
  const nx = rng(5);
  for (let i = 0; i < 200; i += 1) {
    const mid = r2(nx() * 10), open = r2(mid + nx() * 0.6), share = [0, 0.25, 0.5, 0.75, 1][Math.floor(nx() * 5)], tk_ = [0.05, 0.01, 0.1, 0.25][Math.floor(nx() * 4)];
    S.debit.push({ args: [mid, open, share, tk_], ...wrap(() => spec.entryDebit(mid, open, share, tk_)) });
  }
  const ms = at('2026-03-02', '10:00');
  const tparams = [REF, { ...REF, arm_usd: 50, tighten_usd: 300, stop_mult: 0.5, exit_at: '15:30' }, { ...REF, exit_at: '09:30' }, { ...REF, exit_at: '10:00' }, { ...REF, exit_at: '16:00', stop_mult: 0.25 }, { ...REF, tight_at: 6, tighten_usd: 150 }, { ...REF, late_after: '14:30', late_factor: 0.25, floor: 0 }];
  for (const p of tparams) for (const [cost, debit, t] of [[225, 2.25, ms], [30, 0.3, ms], [55, 0.55, 0], [66.5, 0.665, ms], [100, 1, ms], [199.99, 2.0, ms], [400, 4, at('2026-03-02', '15:59')], [-225, 2.25, ms], [1250, 12.5, ms]]) {
    S.targets.push({ p: enc(p), cost, debit, t, ...wrap(() => spec.liveTargets(p, cost, debit, t)) });
  }
  S.targets.push({ p: enc({ ...REF, exit_at: '25:00' }), cost: 225, debit: 2.25, t: ms, ...wrap(() => spec.liveTargets({ ...REF, exit_at: '25:00' }, 225, 2.25, ms)) });
  S.targets.push({ p: enc({ ...REF, exit_at: '12:00' }), cost: 225, debit: 2.25, t: '__NaN__', ...wrap(() => spec.liveTargets({ ...REF, exit_at: '12:00' }, 225, 2.25, NaN)) });
  for (const [debit, mult, comm] of [[2.25, 100, null], [2.25, 100, 5], [2.25, 100, 0.65], [0.3, 50, 1.25], [10, 1, 0]]) S.unitCost.push({ args: [debit, mult, comm], ...wrap(() => spec.unitCost(debit, { multiplier: mult, commission: comm })) });

  const sets = [
    [REF, null, []], [REF, { arm_usd: [50, 100], tighten_usd: [200, 300] }, [{ arm_usd: 50 }, { floor: 0.3 }]], [REF, { arm_usd: [50, 150] }, [{ stop_mult: 0.5 }, { exit_at: '15:00' }]],
    [REF, { tighten_usd: [200, 150, 300], tiers: [[40, 30, 20], [50, 35, 20]], late_factor: [0.5, 1], floor: [0.2, 0.5] }, []],
    [REF, { stop_mult: [null, 0.9], exit_at: ['09:50', '09:30'] }, [{ stop_mult: 0.9 }]], [REF, { stop_mult: [0.95, 0.9] }, []], [REF, { stop_mult: [0.8] }, []],
    [REF, { tight_at: [2, 3, 4], late_after: ['14:30', '15:00', '15:30'], arm_usd: [0, 100] }, [{ tight_pct: 25 }]], [REF, {}, []], [REF, { arm_usd: [] }, []], [REF, undefined, [{}]], [REF, null, [{ arm_usd: 100 }]],
    [{ ...REF, arm_usd: 80 }, { arm_usd: [80, 100] }, [{ arm_usd: 100 }]],
    // 报错:键名、类型、范围(顺序也是行为:参照组、网格、点名组各自第一处)
    [REF, { stop_mult: [1.2] }, []], [REF, { stop_mult: [0] }, []], [REF, { stop_mult: [1] }, []], [REF, { exit_at: ['3pm'] }, []], [REF, { exit_at: ['25:00'] }, []], [REF, { tiers: [[40, 30, 0]] }, []],
    [REF, { tiers: [[40, 30, 101]] }, []], [REF, { tiers: [[40, 30]] }, []], [REF, { tiers: [5] }, []], [REF, { tiers: [null] }, []], [REF, { tiers: [[0, 30, 20]] }, []], [REF, { late_after: ['15'] }, []],
    [REF, { late_after: [15] }, []], [REF, { late_factor: [0] }, []], [REF, { late_factor: [-1] }, []], [REF, { floor: [-0.1] }, []], [REF, { tight_at: [0] }, []], [REF, { arm_usd: [-1] }, []], [REF, { tighten_usd: [0] }, []],
    [REF, { arm: [50] }, []], [REF, { arm: [50], bogus: [1] }, []], [REF, null, [{ stop: 0.5 }]], [REF, null, [{ stop: 0.5, x: 1 }]], [REF, { arm_usd: ['50'] }, []], [REF, { arm_usd: [null] }, []], [REF, { arm_usd: [true] }, []],
    [REF, { stop_mult: ['0.5'] }, []], [REF, { exit_at: [5] }, []], [REF, null, [{ arm_usd: 'x' }]], [REF, null, [{ stop_mult: 2 }]], [REF, null, [{ exit_at: null }, { late_after: null }]],
    [{ ...REF, arm_usd: -5 }, null, []], [{ ...REF, loose_pct: 0 }, null, []], [{ ...REF, late_after: '3pm' }, null, []], [{ ...REF, floor: -1 }, null, []],
  ];
  for (const [ref, grid, extra] of sets) {
    const r = wrap(() => spec.liveSets(ref, grid, extra));
    S.liveSets.push({ ref: enc(ref), grid: grid === undefined ? '__undefined__' : enc(grid), extra: enc(extra), ...r });
  }
  const labelSets = spec.liveSets(REF, { arm_usd: [50, 100], tighten_usd: [200, 300], tiers: [[40, 30, 20], [50, 30, 20], [50, 35, 25]], tight_at: [3, 4], late_after: ['15:00', '14:30'], late_factor: [0.5, 1], floor: [0.2, 0.3], stop_mult: [null, 0.5], exit_at: [null, '15:00'] }, []);
  for (const p of labelSets.slice(0, 400)) S.labels.push({ p: enc(p), ref: enc(REF), out: spec.liveLabel(p, REF) });
  S.labels.push({ p: enc({ ...REF, loose_pct: 50, late_factor: 1, tight_at: 4 }), ref: enc(REF), out: spec.liveLabel({ ...REF, loose_pct: 50, late_factor: 1, tight_at: 4 }, REF) });
  S.labels.push({ p: enc(REF), ref: enc({ ...REF, arm_usd: 80 }), out: spec.liveLabel(REF, { ...REF, arm_usd: 80 }) });
  S.labels.push({ p: enc({ ...REF, stop_mult: 0.5 }), ref: enc({ ...REF, stop_mult: 0.5 }), out: spec.liveLabel({ ...REF, stop_mult: 0.5 }, { ...REF, stop_mult: 0.5 }) });

  const rgrids = [
    null, {}, { stop: [0.4, 0.5], trail_arm: [1.3, 1.5] }, { cutoff_a: ['13:30'] }, { stop: [0.4], zone_hold: [0.6] }, { stop: [] }, { cutoff_a: ['14:00', '13:00'], trail_late: ['15:00', '14:45'], trail: [0.3, 0.25] },
    { tp1: [1.5, 2] }, { cutoff_a_share: [0.2, 0.3] }, { trail_floor: [0.2, 0.1], trail_late_factor: [0.5, 0.25], switch_k: [1.6, 1.8] }, { stop: [0.5, 0.5, 0.4] },
    { stopp: [0.4] }, { em: [30] }, { stop: [-1] }, { stop: [0] }, { stop: ['0.4'] }, { stop: [null] }, { stop: [true] }, { stop: [NaN] }, { cutoff_a: ['25:00'] }, { cutoff_a: [1400] }, { cutoff_a: ['13:30', 5] },
    { stop: [0.4, 'x'] }, { trail_late: ['3pm'] }, { stop: [0.4], bogus: [1] }, { zone_hold: [0.45], zone_half: [0.55] }, { zone_hold: [0.45, 0.5], zone_half: [0.55, 0.6], zone_stop: [0.8] },
  ];
  for (const g of rgrids) {
    const r = wrap(() => spec.replaySets(g));
    S.replaySets.push({ grid: enc(g), ...r });
    if (r.out) for (const o of r.out.slice(0, 30)) S.replayLabel.push({ o, out: spec.replayLabel(o) });
  }
  for (const o of [{}, { stop: 0.5 }, { stop: 0.5, trail_arm: 1.3 }, { cutoff_a: '14:00' }, { cutoff_a: '13:00', stop: 0.45 }, { tp1: null }, { tp1: 2 }, { stop: 1e-7 }, { stop: 123456789 }, { zz: 'a' }, { stop: 0.4999999 }]) {
    S.replayLabel.push({ o: enc(o), ...wrap(() => spec.replayLabel(o)) });
  }
  for (const text of ['2026-03-02 10:32', '2026-03-02T10:32:30', '2026-03-02T15:32:00Z', '2026-03-02T10:32:00-05:00', '10:32', '2026-02-30 10:00', 'March 2, 2026 10:32', '2026-03-02 9:05', '2026-03-02 09:05:07', '  2026-03-02 10:32  ',
    '2026-03-02T10:32:00+0800', '2026-03-02T10:32:00.123Z', '2026-03-02 10:32:00Z', '2026-03-02 10:32 -0500', '2026-03-02', '', 'x', '2026-3-2 10:32', '2026-03-02  10:32', '2026-03-02T25:00', '2026-03-02 24:00', '2026-03-02 10:60', '2026-03-02 10:32:60',
    '2026-03-08 02:30', '2026-03-08 03:30', '2026-11-01 01:30', '2026-11-01 02:30', '2026-03-02T10:32:00+05:30', '2026-03-02T10:32:00z', '2026-03-02t10:32:00Z', '2026-13-02 10:00', '2026-00-10 10:00', '2026-03-32 10:00', '2026-03-02\n10:32', '2026-03-02 10:32\n', '０２'.repeat(2),
    '2026-03-02T10:32:00+24:00', '2026-03-02T10:32:00-00:00', '+002026-03-02T10:32:00Z', '2026-03-02T10:32Z', '2026-03-02T10Z', '2026-03-02 10:32 GMT', '2026-03-02 10:32 EST']) {
    S.entryTime.push({ text, ...wrap(() => spec.parseEntryTime(text)) });
  }
  const ent = (o) => ({ time: '2026-03-02 10:32', center: 7025, wing: 25, right: 'C', ...o });
  const entryCases = [
    [ent({ right: 'c', quantity: 2, debit: 2.1 })], [ent({ qty: 2 })], [ent({ price: 2.1 })], [ent({ time: '上午十点' })], [ent({ right: 'X' })], [ent({ quantity: 1.5 })], [ent({ quantity: 0 })], [ent({ quantity: '2' })],
    [ent({ quantity: null })], [ent({ debit: 0 })], [ent({ debit: '2.5' })], [ent({ debit: -1 })], [ent({ debit: null })], [ent({ center: 0 })], [ent({ wing: -25 })], [ent({ center: '7025' })], [ent({ center: null })],
    [ent({ time: undefined })], [ent({ time: null })], [ent({ time: 12 })], [ent({ right: 'call' })], [ent({ right: '' })], [ent({ right: null })], [ent({ right: 5 })], [ent({ right: undefined })], [ent({ time: '2026-03-02T15:32:00Z' })],
    [], [ent({}), ent({ right: 'P' })], [ent({}), ent({ wing: 0 })], [ent({}), 5], [ent({}), null], [ent({}), [1]], 'x', { time: '2026-03-02 10:32' }, null, 5, [5], [null], [[]],
    [ent({ debit: 2.1, quantity: 3, extra: 1 })], [ent({ quantity: 1e21 })], [ent({ quantity: Infinity })],
  ];
  for (const raw of entryCases) S.entries.push({ raw: enc(raw), ...wrap(() => spec.entriesFrom(raw)) });
  const gridCases = [
    { live: { arm_usd: [50] }, sets: [{ floor: 0.3 }], replay: { stop: [0.4] } }, {}, { lives: { arm_usd: [50] } }, { set: [{}] }, { live: { arm_usd: 50 } }, [1], null, 5, 'x', { live: null, sets: null, replay: null },
    { live: [], replay: {} }, { live: {}, sets: {}, replay: {} }, { live: {}, sets: [1], replay: {} }, { live: {}, sets: [[]], replay: {} }, { live: {}, sets: [null], replay: {} }, { live: {}, sets: [{}, { floor: 1 }], replay: { stop: 0.4 } },
    { live: { tiers: [[1, 2, 3]], stop_mult: [null] }, replay: { cutoff_a: ['14:00'] } }, { replay: { stop: [0.4] }, live: { a: 5 } }, { live: { arm_usd: [50] }, extra: 1, bogus: 2 }, { sets: [] },
  ];
  for (const raw of gridCases) S.gridFile.push({ raw: enc(raw), ...wrap(() => spec.gridFileFrom(raw)) });

  // 变异检验补的:小数位更多的盘口(舍入位数)、入场价的 1e-9 边界、百分比 100、最少回吐 0、量 1
  {
    const nx2 = rng(77);
    const r6 = (v) => Math.round(v * 1e6) / 1e6;
    for (let i = 0; i < 120; i += 1) {
      const px = () => { const b = r6(nx2() * 8); return [b, r6(b + 0.0001 + nx2() * 0.4)]; };
      const legs = q(px(), px(), px());
      const fly = { center: 7025, wing: 25, right: i % 3 ? 'C' : 'P' };
      S.quote.push({ sample: enc(smp(legs)), fly, ...wrap(() => spec.flyQuote(smp(legs), fly)) });
    }
    for (const delta of [0, 0.5e-9, 0.9e-9, 1.2e-9, 1.4e-9, 1.6e-9, 3e-9, -1.2e-9]) {
      for (const [n, tk2] of [[72, 0.05], [30, 0.01], [7, 0.1]]) {
        const mid = (n + delta) * tk2;
        S.debit.push({ args: [mid, mid, 0, tk2], ...wrap(() => spec.entryDebit(mid, mid, 0, tk2)) });
        S.debit.push({ args: [mid - 0.2, mid, 1, tk2], ...wrap(() => spec.entryDebit(mid - 0.2, mid, 1, tk2)) });
      }
    }
    for (const [tk3, m3] of [[0.00003, 30000.4], [0.00005, 1.23456], [0.00003, 1.234567], [0.00007, 0.5]]) { S.debit.push({ args: [m3, m3 + 0.00004, 0.5, tk3], ...wrap(() => spec.entryDebit(m3, m3 + 0.00004, 0.5, tk3)) }); S.debit.push({ args: [m3, m3, 0, tk3], ...wrap(() => spec.entryDebit(m3, m3, 0, tk3)) }); }
    for (const x of [1.00004, 1.00005, 1.000051, 1.234565, 2.000005, 0.000049, 0.00005]) S.debit.push({ args: [x, x, 0, 0], ...wrap(() => spec.entryDebit(x, x, 0, 0)) });
    for (const x of [1.00004, 1.00005, 1.000051, 1.234565, 2.000005, 0.000049, 0.00005]) S.intrinsic.push({ fly: { center: 100, wing: 10, right: 'C' }, spot: 100 + x, ...wrap(() => spec.flyIntrinsic({ center: 100, wing: 10, right: 'C' }, 100 + x)) });
    const more = [
      [REF, { tiers: [[100, 100, 100]] }, []], [REF, { tiers: [[100.0001, 30, 20]] }, []], [REF, { tiers: [[40, 100.0001, 20]] }, []], [REF, { tiers: [[40, 30, 100.0001]] }, []],
      [REF, { floor: [0] }, []], [REF, { floor: [0, 0.1], arm_usd: [0] }, []], [REF, { tiers: [[40, 35, 20], [40, 30, 25], [45, 30, 20]] }, []], [REF, { late_after: ['14:30'] }, []], [REF, { late_factor: [0.3] }, []],
      [REF, { late_after: ['14:30'], late_factor: [0.3] }, []], [REF, null, [{ tight_pct: 25 }, { mid_pct: 35 }, { loose_pct: 45 }, { floor: 0 }, { late_factor: 1 }, { late_after: '14:30' }]],
      [REF, { stop_mult: [0.999999, 0.000001] }, []], [REF, { tighten_usd: [0.000001] }, []],
    ];
    for (const [ref, grid, extra] of more) {
      const r = wrap(() => spec.liveSets(ref, grid, extra));
      S.liveSets.push({ ref: enc(ref), grid: enc(grid), extra: enc(extra), ...r });
      if (r.out) for (const p of r.out) S.labels.push({ p: enc(p), ref: enc(REF), out: spec.liveLabel(p, REF) });
    }
    S.entries.push({ raw: enc([ent({ quantity: 1 })]), ...wrap(() => spec.entriesFrom([ent({ quantity: 1 })])) });
    S.entries.push({ raw: enc([ent({ debit: 1e-9 })]), ...wrap(() => spec.entriesFrom([ent({ debit: 1e-9 })])) });
  }
  for (const [strike, right] of [[7000, 'C'], [7025.5, 'p'], [0.1, 'C'], [1e21, 'P'], [-5, 'P'], [7000, 'call'], [7000, ''], [1e-7, 'x'], [123456.789, 'Put'], [7000.0000001, 'C'], [0, 'c'], [-0, 'C']]) S.legKey.push({ strike: enc(strike), right, out: spec.legKey(strike, right) });
}
writeFileSync(join(here, 'fly-exit-sweep-spec.json'), JSON.stringify(S) + '\n');

// ================================================================ run
const sampleOut = (s) => enc({ t: s.t, spot: s.spot, ...(s.by === undefined ? {} : { by: s.by }), ...(s.expiry === undefined ? {} : { expiry: s.expiry }), ...(s.symbol === undefined ? {} : { symbol: s.symbol }), legs: s.legs.map((l) => ({ strike: l.strike, right: l.right, bid: l.bid, ask: l.ask })) });
const SUMS = []; // 给 report / stats 用的 [名字, 结果]
const runs = [];
function run(name, samples, cfg, keep = false) {
  const progress = [];
  let r;
  try { r = { out: enc(sweep.runSweep(samples, cfg, tk, (d, i, n) => progress.push([d, i, n]))) }; } catch (e) { r = { error: String(e?.message ?? e) }; }
  runs.push({ name, samples: samples.map(sampleOut), cfg: enc(cfg), progress, ...r });
  if (keep && r.out) SUMS.push([name, r.out, cfg]);
  return r.out;
}
const D = (i) => tradingDays(8)[i];
const MIDS = [2.05, 2.4, 3.0, 3.6, 3.7, 3.5, 3.2, 3.1, 3.0, 2.9];

run('hills3_only0935_live5', hills(3, 11, QUARTERS), config({ population: onlyAt('09:35'), live: HILL_SETS }), true);
run('hills5_all_entries', hills(5, 3, QUARTERS), config({ live: spec.liveSets(REF, { arm_usd: [50], stop_mult: [0.5] }) }), true);
run('byTracker_path', dayOf(D(0), [2.05, 2.4, 3.0, 3.6, 3.7, 3.5, 3.2, 3.1, 3.0, 2.9]), config({ population: onlyAt('09:35') }));
for (let seed = 1; seed <= 12; seed += 1) run(`walk_seed${seed}`, walk(D(0), seed), config({ population: onlyAt('09:35') }));
run('walk_late_trigger', (() => { const next = rng(2); const mids = [2.05]; for (let i = 1; i < 77; i += 1) mids.push(r2(Math.min(20, Math.max(0.6, mids[i - 1] + (i < 62 ? 0 : 0.45 * normal(next) + 0.03))))); return dayOf(D(0), mids); })(), config({ population: onlyAt('09:35') }));
// 多行权价:人群限定
const WIDE = [...wideDay(D(0), 21), ...wideDay(D(1), 22)];
run('wide_all', WIDE, config({ live: spec.liveSets(REF, { arm_usd: [50] }) }), true);
run('wide_wings25', WIDE, config({ population: { ...POP, wings: [25] } }));
run('wide_wings25_50', WIDE, config({ population: { ...POP, wings: [25, 50] } }));
run('wide_wings_none', WIDE, config({ population: { ...POP, wings: [75] } }));
run('wide_rights_P', WIDE, config({ population: { ...POP, rights: ['P'] } }));
run('wide_rights_C', WIDE, config({ population: { ...POP, rights: ['C'], entry_from: '10:00', entry_to: '15:00' } }));
run('wide_rights_empty', WIDE, config({ population: { ...POP, rights: [] } }));
run('wide_debit_range', WIDE, config({ population: { ...POP, debit_min: 2, debit_max: 5 } }));
run('wide_dist_range', WIDE, config({ population: { ...POP, dist_min: 10, dist_max: 40 } }));
run('wide_dist_neg', WIDE, config({ population: { ...POP, dist_min: -30, dist_max: 0 } }));
run('wide_window', WIDE, config({ population: { ...POP, entry_from: '11:00', entry_to: '13:00' } }));
run('wide_window_from_only', WIDE, config({ population: { ...POP, entry_from: '14:00' } }));
run('wide_window_to_only', WIDE, config({ population: { ...POP, entry_to: '10:00' } }));
run('wide_stride2', WIDE, config({ stride: 2 }));
run('wide_stride3_comm', WIDE, config({ stride: 3, fill: { ...FILL, commission: 0.65 } }));
run('wide_share_half', WIDE, config({ fill: { ...FILL, entry_spread_share: 0.5 } }));
run('wide_share_zero_qty2', WIDE, config({ fill: { ...FILL, entry_spread_share: 0, qty: 2, multiplier: 50 } }));
run('wide_settle', WIDE, config({ fill: { ...FILL, terminal: 'settle' }, live: spec.liveSets(REF, { arm_usd: [50] }) }));
run('wide_natural_stop', WIDE, config({ fill: { ...FILL, stop_basis: 'natural' }, live: spec.liveSets(REF, { stop_mult: [0.4, 0.8] }) }));
run('wide_replay_auto', WIDE, config({ replay: { em: 'auto', sets: spec.replaySets({ stop: [0.4] }) } }), true);
run('wide_replay_em40', WIDE, config({ population: onlyAt('10:05'), replay: { em: 40, sets: spec.replaySets({ cutoff_a: ['13:30'], trail: [0.25] }) } }));
run('wide_by_plan', [...WIDE, ...wideDay(D(2), 23).map((s) => ({ ...s, by: 'plan' }))], config({ population: { ...POP, by: 'plan' } }));
run('wide_by_all', [...WIDE, ...wideDay(D(2), 23).map((s) => ({ ...s, by: 'plan' }))], config({ population: { ...POP, by: 'all' } }));
run('wide_by_loop_with_plan', [...WIDE, ...wideDay(D(2), 23).map((s) => ({ ...s, by: 'plan' }))], config({ population: { ...POP, by: 'loop' } }));

// 缺报价、宽价差、死盘口
const MIDS7 = [2.05, 3.6, 3.7, 3.1, 3.0, 2.9, 2.8];
const broken = (date, clock) => tick(date, clock, 0, 7010, [leg(7000, 'C', 12.0, 12.1), leg(7025, 'C', 5.0, null), leg(7050, 'C', 1.0, 1.1)]);
const whole7 = dayOf(D(0), MIDS7);
run('missing_none', whole7, config({ population: onlyAt('09:35') }));
run('missing_later', whole7.map((s, i) => (i === 3 ? broken(D(0), CLOCK[3]) : s)), config({ population: onlyAt('09:35') }));
run('missing_entry', whole7.map((s, i) => (i === 1 ? broken(D(0), CLOCK[1]) : s)), config());
run('missing_all_grid', whole7.map((s, i) => (i % 2 ? broken(D(0), CLOCK[i]) : s)), config());
run('wide_exit_quote', (() => { const wide = tick(D(0), CLOCK[2], 0, 7010, [leg(7000, 'C', 9.0, 11.1), leg(7025, 'C', 5.0, 5.1), leg(7050, 'C', 1.0, 1.1)]); return dayOf(D(0), [2.05, 1.8, 1.0, 0.9, 0.8]).map((s, i) => (i === 2 ? wide : s)); })(), config({ population: onlyAt('09:35'), live: spec.liveSets(REF, { stop_mult: [0.5] }) }));
const dead = (date, clock) => tick(date, clock, 0, 7010, [leg(7000, 'C', 0.1, 0.2), leg(7025, 'C', 0.05, 0.15), leg(7050, 'C', 0, 0.05)]);
run('dead_unfilled', [tick(D(0), CLOCK[0], 2.05), dead(D(0), CLOCK[1]), dead(D(0), CLOCK[2])], config({ population: onlyAt('09:35'), live: spec.liveSets(REF, { stop_mult: [0.5] }) }));
run('dead_unfilled_settle', [tick(D(0), CLOCK[0], 2.05), dead(D(0), CLOCK[1]), dead(D(0), CLOCK[2])], config({ population: onlyAt('09:35'), fill: { ...FILL, terminal: 'settle' }, live: spec.liveSets(REF, { stop_mult: [0.5] }) }));
run('dead_worthless_comm', [tick(D(0), CLOCK[0], 2.05), dead(D(0), CLOCK[1])], config({ population: onlyAt('09:35'), fill: { ...FILL, commission: 0.65 } }));
// 没有任何一笔拿得到平仓价
run('never_closable', [tick(D(0), CLOCK[0], 2.05), tick(D(0), CLOCK[1], 2.1, 7010, [leg(7000, 'C', 11.1, 11.2), leg(7025, 'C', 5, null), leg(7050, 'C', 1, 1.1)]), tick(D(0), CLOCK[2], 2.1, 7010, [leg(7000, 'C', 11.1, 11.2), leg(7025, 'C', 5, null), leg(7050, 'C', 1, 1.1)])], config({ population: onlyAt('09:35') }));
// 数据筛选
const stray = { ...tick(D(0), '10:02', 9), expiry: '20260303' };
const planS = { ...tick(D(0), '10:03', 9), by: 'plan' };
const other = { ...tick(D(0), '10:02', 9), symbol: 'NDX' };
run('filter_expiry_and_by', [...whole7, stray, planS], config({ population: onlyAt('09:35') }));
run('filter_by_all', [...whole7, stray, planS], config({ population: { ...onlyAt('09:35'), by: 'all' } }));
run('filter_symbol', [...whole7, other], config({ population: onlyAt('09:35') }));
run('filter_symbol_null_two', [...whole7, other, { ...tick(D(0), '10:04', 9), symbol: 'SPX' }], config({ symbol: null }));
run('filter_symbol_null_one', whole7.map((s) => ({ ...s, symbol: 'SPX' })), config({ symbol: null, population: onlyAt('09:35') }));
run('filter_symbol_null_three', [...whole7, other, { ...tick(D(0), '10:04', 9), symbol: 'SPX' }, { ...tick(D(0), '10:05', 9), symbol: 'ES' }], config({ symbol: null }));
run('filter_expiry_good', whole7.map((s) => ({ ...s, expiry: D(0).replace(/-/g, '') })), config({ population: onlyAt('09:35') }));
run('filter_empty', [], config());
run('filter_unsorted', [...whole7].reverse(), config({ population: onlyAt('09:35') }));
// 入场(给了真实入场)
{
  const samples = dayOf(D(0), MIDS);
  const entries = [
    { t: at(D(0), '09:37'), center: 7025, wing: 25, right: 'C', debit: 2.5 }, { t: at(D(0), '09:35'), center: 7025, wing: 25, right: 'C' },
    { t: at(D(0), '09:35'), center: 7100, wing: 25, right: 'C' }, { t: at(D(1), '09:35'), center: 7025, wing: 25, right: 'C' }, { t: at(D(0), '15:00'), center: 7025, wing: 25, right: 'C' },
    { t: at(D(0), '09:45'), center: 7025, wing: 25, right: 'C', quantity: 3 }, { t: at(D(0), '09:40'), center: 7025, wing: 25, right: 'P' }, { t: at(D(0), '09:40'), center: 7025, wing: 25, right: 'C', debit: 0.0001 },
  ];
  run('entries_mixed', samples, config({ entries }), true);
  run('entries_none_that_day', samples, config({ entries: [{ t: at(D(3), '09:35'), center: 7025, wing: 25, right: 'C' }] }));
  run('entries_empty_list', samples, config({ entries: [] }));
  run('entries_replay', samples, config({ entries, replay: { em: 'auto', sets: spec.replaySets({ stop: [0.4] }) } }));
  run('entries_comm', samples, config({ entries: entries.slice(0, 2), fill: { ...FILL, commission: 0.65, qty: 2 } }));
  run('entries_day_filtered_by', samples.map((s) => ({ ...s, by: 'plan' })), config({ entries }));
}
// 成交口径
{
  const one = (over, live = spec.liveSets(REF, null), samples = dayOf(D(0), MIDS)) => config({ population: onlyAt('09:35'), fill: { ...FILL, ...over }, live });
  run('fill_share0', dayOf(D(0), MIDS), one({ entry_spread_share: 0 }));
  run('fill_share_half', dayOf(D(0), MIDS), one({ entry_spread_share: 0.5 }));
  run('fill_comm', dayOf(D(0), MIDS), one({ commission: 0.65 }));
  const flat = CLOCK.map(() => 2.4); flat[0] = 2.05;
  run('fill_terminal_natural', dayOf(D(0), flat, 7015), one({}));
  run('fill_terminal_settle', dayOf(D(0), flat, 7015), one({ terminal: 'settle' }));
  run('fill_terminal_settle_comm', dayOf(D(0), flat, 7015), one({ terminal: 'settle', commission: 1 }));
  run('fill_short_day', dayOf(D(0), flat, 7015).slice(0, 54), one({ terminal: 'settle' }));
  run('fill_short_day_within_big', dayOf(D(0), flat, 7015).slice(0, 54), one({ terminal: 'settle', settle_within_min: 120 }));
  run('fill_early_close', dayOf('2026-11-27', Array.from({ length: 41 }, (_v, i) => (i ? 2.4 : 2.05)), 7015), one({ terminal: 'settle' }));
  run('fill_early_close_replay', dayOf('2026-11-27', Array.from({ length: 41 }, (_v, i) => (i ? 2.4 : 2.05)), 7015), config({ population: onlyAt('09:35'), replay: { em: 36, sets: [{}] } }));
  run('fill_early_close_replay_auto', dayOf('2026-11-27', Array.from({ length: 41 }, (_v, i) => (i ? 2.4 : 2.05)), 7010), config({ population: onlyAt('09:35'), replay: { em: 'auto', sets: [{}] } }));
  const timed = spec.liveSets(REF, { stop_mult: [null, 0.9], exit_at: ['09:50', '09:30'] }, [{ stop_mult: 0.9 }]);
  run('fill_time_and_stop', dayOf(D(0), [2.05, 2.1, 2.2, 2.3, 2.2, 2.1, 2.0]), one({}, timed));
  run('fill_cost_commission', dayOf(D(0), [2.05, 3.3, 2.6, 2.5]), one({ commission: 5 }));
  run('fill_cost_nocommission', dayOf(D(0), [2.05, 3.3, 2.6, 2.5]), one({}));
  run('fill_stop_refused', dayOf(D(0), [2.05, 2.1, 2.0, 1.9]), one({}, spec.liveSets(REF, { stop_mult: [0.95, 0.9] })));
  run('fill_stop_natural_off', dayOf(D(0), [2.05, 1.95, 1.9, 1.85]), one({}, spec.liveSets(REF, { stop_mult: [0.8] })));
  run('fill_stop_natural_on', dayOf(D(0), [2.05, 1.95, 1.9, 1.85]), one({ stop_basis: 'natural' }, spec.liveSets(REF, { stop_mult: [0.8] })));
  run('fill_stop_natural_refused', dayOf(D(0), [2.05, 2.1, 2.0, 1.9]), one({ stop_basis: 'natural' }, spec.liveSets(REF, { stop_mult: [0.95, 0.92, 0.9] })));
  run('fill_coarse_spike', dayOf(D(0), [2.05, 4.0, 3.0, 2.9, 2.9, 2.9, 2.9]), one({}));
  run('fill_stride2_spike', dayOf(D(0), [2.05, 4.0, 3.0, 2.9, 2.9, 2.9, 2.9]), config({ population: onlyAt('09:35'), stride: 2 }));
  run('fill_multiplier100_qty3', dayOf(D(0), MIDS), one({ qty: 3 }));
  run('fill_exit_after_entry', dayOf(D(0), [2.05, 2.1, 2.2, 2.3, 2.2, 2.1, 2.0]), one({}, spec.liveSets(REF, { exit_at: ['09:36', '09:35', '09:34', '16:30'] })));
}
// 回放
{
  const DATE = D(0);
  const mids = [2.05, 2.6, 3.2, 3.6, 3.0, 2.9];
  const samples = mids.map((m, i) => tick(DATE, CLOCK[i], m, 7010));
  run('replay_hand', samples, config({ population: onlyAt('09:35'), replay: { em: 'auto', sets: spec.replaySets(null) } }), true);
  run('replay_grid', samples, config({ population: onlyAt('09:35'), replay: { em: 'auto', sets: spec.replaySets({ stop: [0.4, 0.5], trail_arm: [1.3, 1.5] }) } }));
  for (let seed = 1; seed <= 10; seed += 1) {
    const day = walk(DATE, 100 + seed);
    run(`replay_walk${seed}`, day, config({ population: onlyAt('09:35'), fill: { ...FILL, qty: 3 }, replay: { em: 'auto', sets: spec.replaySets(seed % 2 ? null : { stop: [0.4], zone_hold: [0.6] }) } }));
  }
  const wide = tick(DATE, CLOCK[0], 0, 7010, [leg(7000, 'C', 9.5, 11.0), leg(7025, 'C', 5.0, 5.1), leg(7050, 'C', 0.7, 1.3), leg(7010, 'C', 14.0, 14.2), leg(7010, 'P', 13.9, 14.1)]);
  run('replay_wide_spread', [wide, ...[1.4, 1.8, 2.4, 3.0, 3.0, 3.0].map((m, i) => tick(DATE, CLOCK[i + 1], m, 7010))], config({ population: onlyAt('09:35'), replay: { em: 36, sets: spec.replaySets({ stop: [0.4] }) }, live: spec.liveSets(REF, { stop_mult: [0.5, 0.4] }) }));
  const bare = (i) => tick(DATE, CLOCK[i], mids[i], 7010, [leg(7000, 'C', r2(mids[i] + 9.0), r2(mids[i] + 9.1)), leg(7025, 'C', 5.0, 5.1), leg(7050, 'C', 1.0, 1.1)]);
  run('replay_em_late', mids.map((m, i) => (i < 2 ? bare(i) : tick(DATE, CLOCK[i], m, 7010))), config({ replay: { em: 'auto', sets: spec.replaySets(null) } }));
  const holed = samples.map((s, i) => (i === 4 ? tick(DATE, CLOCK[4], 0, 7010, [leg(7000, 'C', 12, 12.1), leg(7025, 'C', 5, null), leg(7050, 'C', 1, 1.1)]) : s));
  run('replay_holed', holed, config({ population: onlyAt('09:35'), replay: { em: 36, sets: spec.replaySets(null) } }));
  run('replay_em_fixed', samples, config({ population: onlyAt('09:35'), replay: { em: 36, sets: spec.replaySets(null) } }));
  run('replay_early_close', mids.map((m, i) => tick('2026-11-27', CLOCK[i], m, 7010)), config({ population: onlyAt('09:35'), replay: { em: 36, sets: spec.replaySets(null) } }));
  run('replay_not_applicable', dayOf(DATE, [2.05, 2.1, 2.2], 7010).slice(0, 2), config({ replay: { em: 36, sets: spec.replaySets({ stop: [0.4] }) } }));
  run('replay_many_days', hills(4, 9, QUARTERS), config({ population: onlyAt('09:35'), replay: { em: 'auto', sets: spec.replaySets({ stop: [0.4], trail_arm: [1.5] }) } }), true);
  run('replay_settle_alt', hills(3, 5, QUARTERS), config({ population: onlyAt('09:35'), fill: { ...FILL, terminal: 'settle', commission: 0.5 }, replay: { em: 'auto', sets: spec.replaySets({ stop: [0.3] }) } }));
  run('replay_stride2', walk(DATE, 77), config({ population: onlyAt('09:35'), stride: 2, replay: { em: 'auto', sets: spec.replaySets({ stop: [0.4] }) } }));
}
// 同一时刻的两笔(稳定排序:同时刻的按输入先后)与近似重复的行权价(wing 取 4 位,摆出来的蝶会重复)
{
  const a = tick(D(0), CLOCK[0], 2.05), b = { ...tick(D(0), CLOCK[0], 2.9, 7011) }, c = tick(D(0), CLOCK[1], 3.1), d = tick(D(0), CLOCK[1], 1.4, 7003);
  run('tie_same_time_ab', [a, b, c, d], config({ population: onlyAt('09:35') }));
  run('tie_same_time_ba', [b, a, d, c], config({ population: onlyAt('09:35') }));
  run('tie_same_time_all_entries', [a, b, c, d, ...dayOf(D(0), [2.4, 2.5, 2.6], 7010).slice(2)], config({ live: spec.liveSets(REF, { arm_usd: [50] }) }));
  const near = (s) => ({ ...s, legs: [...s.legs, leg(7000.00004, 'C', 12.0, 12.2), leg(7049.9999, 'C', 1.0, 1.1)] });
  run('near_duplicate_strikes', dayOf(D(0), [2.05, 2.4, 3.0, 3.6]).map(near), config());
  run('near_duplicate_strikes_wing_filter', dayOf(D(0), [2.05, 2.4, 3.0, 3.6]).map(near), config({ population: { ...POP, wings: [25] } }));
}

// 变异检验补的
{
  const samples0 = dayOf(D(0), MIDS);
  const lastT = samples0[samples0.length - 1].t, prevT = samples0[samples0.length - 2].t;
  const e = (t, over = {}) => ({ t, center: 7025, wing: 25, right: 'C', ...over });
  run('entries_at_last_sample', samples0, config({ entries: [e(lastT), e(prevT)] }));
  run('entries_zero_debit', samples0, config({ entries: [e(at(D(0), '09:35'), { debit: 0 }), e(at(D(0), '09:40'), { debit: 0.0001 })] }));
  const holed = samples0.map((s, i) => (i === 4 ? broken(D(0), CLOCK[4]) : (i === 6 ? broken(D(0), CLOCK[6]) : s)));
  run('entries_holes_after_and_at_entry', holed, config({ entries: [e(at(D(0), '09:35')), e(at(D(0), '09:55')), e(at(D(0), '09:45'))] }));
  run('entries_holes_after_entry_only', holed, config({ entries: [e(at(D(0), '09:35'))] }));
  // 买价卖价摆成入场价正好 0:grid 与 entries 都不要
  const zl = (date, clock) => tick(date, clock, 0, 7010, [leg(7000, 'C', 0.9, 1.0), leg(7025, 'C', 1.0, 1.1), leg(7050, 'C', 0.9, 1.0), leg(7010, 'C', 14.0, 14.2), leg(7010, 'P', 13.9, 14.1)]);
  run('zero_debit_grid', [zl(D(0), CLOCK[0]), zl(D(0), CLOCK[1]), zl(D(0), CLOCK[2])], config());
  run('zero_debit_entries', [zl(D(0), CLOCK[0]), zl(D(0), CLOCK[1]), zl(D(0), CLOCK[2])], config({ entries: [e(at(D(0), '09:35'))] }));
  // 人群限定的边界:正好等于
  const wd = [...wideDay(D(0), 31)];
  const debits = [];
  { const probe = sweep.runSweep(wd, config({ population: { ...POP, wings: [25] } }), tk); debits.push(probe.debit.min, probe.debit.max); }
  run('pop_debit_min_equal', wd, config({ population: { ...POP, wings: [25], debit_min: debits[0] } }));
  run('pop_debit_max_equal', wd, config({ population: { ...POP, wings: [25], debit_max: debits[1] } }));
  run('pop_debit_both_equal', wd, config({ population: { ...POP, wings: [25], debit_min: debits[0], debit_max: debits[0] } }));
  run('pop_dist_equal_15', wd, config({ population: { ...POP, wings: [25], dist_min: 15, dist_max: 15 } }));
  run('pop_dist_equal_neg', wd, config({ population: { ...POP, wings: [25], dist_min: -10, dist_max: -10 } }));
  run('pop_dist_equal_pos10', wd, config({ population: { ...POP, wings: [25], dist_min: 40, dist_max: 40 } }));
  run('pop_dist_equal_P', wd, config({ population: { ...POP, rights: ['P'], dist_min: 10, dist_max: 10 } }));
  run('pop_window_equal', wd, config({ population: { ...POP, entry_from: '09:50', entry_to: '09:50' } }));
  // 配置边界
  run('cfg_commission_zero', samples0, config({ population: onlyAt('09:35'), fill: { ...FILL, commission: 0 } }));
  run('cfg_settle_within_zero', samples0, config({ population: onlyAt('09:35'), fill: { ...FILL, settle_within_min: 0, terminal: 'settle' } }));
  run('cfg_qty_one_mult_small', samples0, config({ population: onlyAt('09:35'), fill: { ...FILL, multiplier: 0.5, qty: 1 } }));
  run('cfg_share_edges', samples0, config({ population: onlyAt('09:35'), fill: { ...FILL, entry_spread_share: 1 } }));
  run('cfg_stride_one_clock_edge', samples0, config({ population: { ...POP, entry_from: '09:35', entry_to: '09:35' }, stride: 1 }));
  // 止损价正好等于此刻立刻卖得掉的价(按立刻成交价判):不低于 → 设不上
  {
    const eq = (clock) => tick(D(0), clock, 0, 7010, [leg(7000, 'C', 4.0, 4.5), leg(7025, 'C', 3.0, 3.0), leg(7050, 'C', 3.0, 3.5), leg(7010, 'C', 14.0, 14.2), leg(7010, 'P', 13.9, 14.1)]);
    const sm = [eq(CLOCK[0]), eq(CLOCK[1]), eq(CLOCK[2])];
    console.error('eq quote', JSON.stringify(spec.flyQuote(sm[0], FLY)));
    run('stop_equals_natural', sm, config({ population: onlyAt('09:35'), fill: { ...FILL, stop_basis: 'natural' }, live: spec.liveSets(REF, { stop_mult: [0.5, 0.4999, 0.5001] }) }));
    run('stop_equals_natural_mid', sm, config({ population: onlyAt('09:35'), live: spec.liveSets(REF, { stop_mult: [0.5, 0.75, 0.7501] }) }));
  }
  // EM:平值只有一边 / 同一分钟里两笔样本 / 第一根 K 线就在区外
  const half = (date, clock, mid, which) => tick(date, clock, mid, 7010, [leg(7000, 'C', r2(mid + 9.0), r2(mid + 9.1)), leg(7025, 'C', 5.0, 5.1), leg(7050, 'C', 1.0, 1.1), which === 'C' ? leg(7010, 'C', 14.0, 14.2) : leg(7010, 'P', 13.9, 14.1)]);
  const mids6 = [2.05, 2.6, 3.2, 3.6, 3.0, 2.9];
  run('replay_atm_call_only', mids6.map((m, i) => half(D(0), CLOCK[i], m, 'C')), config({ population: onlyAt('09:35'), replay: { em: 'auto', sets: [{}] } }));
  run('replay_atm_put_only', mids6.map((m, i) => half(D(0), CLOCK[i], m, 'P')), config({ population: onlyAt('09:35'), replay: { em: 'auto', sets: [{}] } }));
  run('replay_atm_call_then_both', mids6.map((m, i) => (i < 2 ? half(D(0), CLOCK[i], m, 'C') : tick(D(0), CLOCK[i], m, 7010))), config({ population: { ...POP, entry_to: '09:45' }, replay: { em: 'auto', sets: [{}] } }));
  {
    const s1 = tick(D(0), '09:35', 2.05, 7010), s2 = { ...tick(D(0), '09:35', 2.9, 7011), t: s1.t + 30_000 }, s3 = tick(D(0), '09:40', 3.2, 7010), s4 = { ...tick(D(0), '09:40', 1.0, 7012), t: s3.t + 20_000 };
    run('replay_same_minute_duplicates', [s1, s2, s3, s4, tick(D(0), '09:45', 3.0, 7010), tick(D(0), '09:50', 2.9, 7010)], config({ population: { ...POP, entry_to: '09:35' }, replay: { em: 'auto', sets: [{}, { stop: 0.4 }] } }));
  }
  run('replay_first_bar_outside', mids6.map((m, i) => tick(D(0), CLOCK[i], [1.0, 1.0, 1.1, 1.0, 1.0, 1.0][i], 7100)), config({ population: onlyAt('09:35'), replay: { em: 36, sets: [{}, { stop: 0.4 }] } }));
  run('replay_first_bar_outside_p', mids6.map((m, i) => tick(D(0), CLOCK[i], [1.0, 1.0, 1.1, 1.0, 1.0, 1.0][i], 6900)), config({ population: onlyAt('09:35'), replay: { em: 36, sets: [{}] } }));
  run('replay_settle_at_close', (() => { const cl = CLOCK.concat(['16:00']); return cl.map((c, i) => tick(D(0), c, i < 2 ? 2.05 : 2.3, 7025)); })(), config({ population: onlyAt('09:35'), replay: { em: 36, sets: [{}] }, fill: { ...FILL, terminal: 'settle' } }));
  // 稳定排序里同一时刻、wing 用 4 位
  run('wide_replay_qty3', WIDE, config({ population: { ...POP, wings: [25] }, fill: { ...FILL, qty: 3 }, replay: { em: 'auto', sets: spec.replaySets({ stop: [0.4], trail: [0.2], cutoff_a: ['13:00'] }) } }));
}
// 配置报错
{
  const bad = (name, over) => run(name, [], config(over));
  bad('cfg_stride0', { stride: 0 }); bad('cfg_stride_frac', { stride: 1.5 }); bad('cfg_stride_neg', { stride: -1 });
  bad('cfg_share_hi', { fill: { ...FILL, entry_spread_share: 1.5 } }); bad('cfg_share_neg', { fill: { ...FILL, entry_spread_share: -0.1 } }); bad('cfg_share_nan', { fill: { ...FILL, entry_spread_share: NaN } });
  bad('cfg_comm_neg', { fill: { ...FILL, commission: -1 } }); bad('cfg_qty0', { fill: { ...FILL, qty: 0 } }); bad('cfg_qty_frac', { fill: { ...FILL, qty: 1.5 } });
  bad('cfg_mult0', { fill: { ...FILL, multiplier: 0 } }); bad('cfg_settle_neg', { fill: { ...FILL, settle_within_min: -1 } });
  bad('cfg_clock_bad', { population: { ...POP, entry_from: '9am' } }); bad('cfg_clock_to_bad', { population: { ...POP, entry_to: '25:00' } });
  bad('cfg_live_empty', { live: [] });
  bad('cfg_ok_empty_samples', {});
}
writeFileSync(join(here, 'fly-exit-sweep-run.json'), JSON.stringify({ runs }) + '\n');

// ================================================================ stats
const ST = { random: [], degenerate: [], exact: [], analyse: [], verdict: [], summarise: [] };
for (const seed of [0, 1, 7, 42, 123456789, 4294967295, 4294967296, 4294967301, -1, -4294967295, 1.5, 2.9, -2.5, 1e20, 0.5, 'NaN', 'Inf', 'x']) {
  const sd = seed === 'NaN' ? NaN : seed === 'Inf' ? Infinity : seed === 'x' ? 'x' : seed;
  const next = stats.seededRandom(sd);
  ST.random.push({ seed: enc(sd), out: enc(Array.from({ length: 24 }, () => next())) });
}
{ const next = stats.seededRandom(7); ST.randomLong = enc(Array.from({ length: 3000 }, () => next())); }
for (const xs of [[], [5], [0, 0, 0, 1], [1, 2, 3, 4], [1, 1, 1, 1], [0, -0], [-0, 0, 0], [NaN, NaN, 1], [NaN, 1], [1, 1, 2, 2, 2], [0.1, 0.2, 0.1, 0.30000000000000004, 0.3], [1e-300, 1e-300, 2], [Infinity, Infinity, 1], Array.from({ length: 40 }, (_v, i) => i % 3), Array.from({ length: 150 }, () => 3.25), [-0, -0, 5]]) {
  ST.degenerate.push({ xs: enc(xs), ...wrap(() => stats.degenerateProb(xs)) });
}
for (const [d, cap, aT, aS] of [[[3, 1, 4, 2], 10, 0.1, 0.1], [[5], 10, 0.1, 0.1], [[], 10, 0.1, 0.1], [[1, 2], 1, 0.05, 0.05], [[1, 2], -1, 0.05, 0.05], [[1, 2], Infinity, 0.05, 0.05], [[1, 2], NaN, 0.05, 0.05], [[1, 2], 0, 0.05, 0.05],
  [[0, 0, 0, 0], 5, 0.01, 0.01], [[-1, -2, -3], 5, 0.01, 0.02], [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, 0.003125, 0.003125], [[0.5, 0.5], 1, 0.9, 0.9], [[0.5, 0.5], 1, 1, 1], [[0.5, 0.5, 3], 1, 0.5, 1e-9], [[2, 2, 2], 100, 0.5, 0.0001]]) {
  ST.exact.push({ args: enc([d, cap, aT, aS]), ...wrap(() => stats.exactLower(d, cap, aT, aS)) });
}
for (const [mu, sd, days, cap, aT] of [[1, 0.2, 16, 1.1, 0.00625], [1, 0.2, 16, 30, 0.00625], [1, 0.2, 400, 30, 0.00625], [155, 15, 80, 2500, 0.003125], [155, 15, 120, 2500, 0.003125], [50, 60, 250, 2500, 0.003125], [50, 60, 1000, 2500, 0.003125], [20, 60, 1000, 2500, 0.003125]]) {
  const next = rng(days * 7 + mu);
  const d = Array.from({ length: days }, () => mu + sd * normal(next));
  ST.exact.push({ args: enc([d, cap, aT, aT]), ...wrap(() => stats.exactLower(d, cap, aT, aT)) });
}
{
  const next = rng(3);
  const base = Array.from({ length: 15 }, () => normal(next));
  const rows15 = [base, base.map((b) => b + 1 + 0.2 * normal(next)), base.map((b) => b - 1 + 0.2 * normal(next))];
  const nx = rng(5);
  const base30 = Array.from({ length: 30 }, () => normal(nx));
  const good = base30.map((b) => b + 1 + 0.2 * normal(nx));
  const sparse = (from) => base30.map((b, j) => (j >= from && j < from + 4 ? b - 1 - 0.1 * (j - from) : b));
  const noise = (seed, days, sets, shift = 0) => {
    const n = rng(seed), b = Array.from({ length: days }, () => normal(n)), common = Array.from({ length: days }, () => normal(n)), rows = [b];
    for (let p = 1; p < sets; p += 1) { const scale = Math.pow(30, (p - 1) / Math.max(1, sets - 2)); rows.push(b.map((v, j) => v + scale * (0.7 * common[j] + 0.7 * normal(n)) + (p === 1 ? shift : 0))); }
    return rows;
  };
  const lottery = (q, seed, days, sets) => { const n = rng(seed); const base_ = Array.from({ length: days }, () => normal(n)); const rows = [base_]; for (let p = 1; p < sets; p += 1) rows.push(base_.map((b) => b + (n() < 1 - q ? 1 : -(1 - q) / q) * (0.8 + 0.4 * n()))); return rows; };
  const steady = Array.from({ length: 12 }, () => 0);
  const alt40 = Array.from({ length: 40 }, () => 0);
  const cases = [
    [rows15, 0, { ...BOOT, cap: 1.5 }], [rows15, 0, { ...BOOT, cap: 30 }], [rows15, 0, BOOT], [rows15, 0, { ...BOOT, cap: 0 }], [rows15, 0, { ...BOOT, cap: null }], [rows15, 2, { ...BOOT, cap: 1.5 }], [rows15, 1, { ...BOOT, cap: 1.5, level: 0.8 }],
    [[[1], [2]], 0, { ...BOOT, cap: 5 }], [[[1, 2, 3]], 0, BOOT], [[], 0, BOOT], [[[], []], 0, BOOT], [[[1, 2], [3, 4]], 0, { level: 0.95, draws: 1, seed: 3, cap: 2 }],
    [[[0, 0, 0, 0], [0.21, 0.25, 0.28, 0.22]], 0, { level: 0.95, draws: 2000, seed: 1, cap: 25 }],
    [[alt40, alt40.map((_b, j) => (j % 2 === 0 ? 2 : -0.1))], 0, { ...BOOT, cap: 0.2 }],
    [[[0, 0, 0, 0, 0], [0, 0, 0, 1, 2]], 0, BOOT], [[[0, 0, 0, 0, 0], [0, 0, 0, 1, 2]], 0, { ...BOOT, level: 0.8 }], [[[0, 0, 0, 0, 0], [0, 0, 0, 1, 2]], 0, { ...BOOT, level: 0.8, cap: 3 }],
    [[base30, good, sparse(0), sparse(4), sparse(8)], 0, { ...BOOT, draws: 400 }], [[base30, good, sparse(0), sparse(4), sparse(8)], 0, { ...BOOT, draws: 400, cap: 12 }],
    [noise(1, 12, 8), 0, { level: 0.95, draws: 100, seed: 1 }], [noise(2, 40, 5), 0, { level: 0.95, draws: 100, seed: 2, cap: 40 }], [noise(3, 6, 21), 0, { level: 0.95, draws: 100, seed: 3 }], [noise(4, 20, 5, 0.9), 0, { level: 0.95, draws: 150, seed: 4, cap: 60 }],
    [lottery(0.1, 5, 9, 2), 0, { level: 0.95, draws: 100, seed: 5, cap: 10.8 }], [lottery(0.1, 6, 30, 2), 0, { level: 0.95, draws: 100, seed: 6, cap: 10.8 }], [lottery(0.01, 7, 30, 3), 0, { level: 0.95, draws: 100, seed: 7, cap: 120 }],
    [[steady, steady, steady], 0, { ...BOOT, cap: 1 }], [[steady, steady.map((_v, j) => (j % 3 === 0 ? 1 : 0)), steady.map((_v, j) => (j % 4 === 0 ? -1 : 0))], 0, { ...BOOT, cap: 2 }],
    [[[1, 2, 3, 4, NaN, 6], [2, 3, 4, 5, 6, 7]], 0, { ...BOOT, cap: 5 }], [[[1, 2, 3, 4, 5, 6], [2, 3, 4, 5, 6, 7], [2, 3, 4, 5, 6, 7], [1, 1, 1, 1, 1, 1]], 0, { ...BOOT, cap: 5 }],
    [[[0, 0, 0, 0, 0, 0, 0, 0], [-0, 0, -0, 0, -0, 0, -0, 0], [1, 1, 1, 1, 1, 1, 1, 1]], 0, { ...BOOT, cap: 5 }], [[[5, 5, 5, 5], [1, 2, 3, 4], [9, 8, 7, 6]], 0, { level: 0.9, draws: 37, seed: 99, cap: 20 }],
    [[[1, 2, 3, 4, 5, 6, 7, 8], [3, 1, 4, 1, 5, 9, 2, 6]], 0, { level: 0.5, draws: 50, seed: 8, cap: 10 }], [[[1, 2, 3, 4, 5, 6, 7, 8], [3, 1, 4, 1, 5, 9, 2, 6]], 1, { level: 0.99, draws: 50, seed: 8, cap: 10 }],
    [[[1, 2, 3], [4, 5, 6]], 0, { level: 0, draws: 10, seed: 1 }], [[[1, 2, 3], [4, 5, 6]], 0, { level: 1, draws: 10, seed: 1 }], [[[1, 2, 3], [4, 5, 6]], 0, { level: NaN, draws: 10, seed: 1 }], [[[1, 2, 3], [4, 5, 6]], 0, { level: 0.95, draws: 0, seed: 1 }],
    [[[1, 2, 3], [4, 5, 6]], 0, { level: 0.95, draws: 1.5, seed: 1 }], [[[1, 2, 3], [4, 5, 6]], 0, { level: 0.95, draws: -3, seed: 1 }], [[[1, 2, 3], [4, 5, 6]], 0, { level: 0.95, draws: 20, seed: 2.7, cap: 4 }], [[[1, 2, 3], [4, 5, 6]], 0, { level: 0.95, draws: 20, seed: -1, cap: 4 }],
    [[[1, 2, 3, 4, 5, 6], [3, 3, 3, 3, 3, 3]], 0, { level: 0.95, draws: 20, seed: 1, cap: 4 }], [[[1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 7]], 0, { level: 0.95, draws: 40, seed: 1, cap: 4 }],
  ];
  for (const [m, ref, opts] of cases) ST.analyse.push({ matrix: enc(m), ref, opts: enc(opts), ...wrap(() => stats.analyse(m, ref, opts)) });
  // verdict
  const ana = (m, opts) => stats.analyse(m, 0, opts);
  const A1 = ana(rows15, { ...BOOT, cap: 1.5 }), A2 = ana(rows15, { ...BOOT, cap: 30 }), A3 = ana([[0, 0, 0, 0, 0], [0, 0, 0, 1, 2]], BOOT), A4 = ana([[1, 2, 3]], BOOT), A5 = ana([[alt40, alt40.map((_b, j) => (j % 2 === 0 ? 2 : -0.1))][0], alt40.map((_b, j) => (j % 2 === 0 ? 2 : -0.1))], { ...BOOT, cap: 0.2 });
  const A6 = ana(lottery(0.1, 6, 40, 3), { ...BOOT, cap: 12 });
  const goodRows = [steady.map((_v, j) => j * 0), steady.map((_v, j) => 1 + 0.01 * (j % 3))];
  const A7 = ana(goodRows, { ...BOOT, cap: 1.1 }), A8 = ana([goodRows[0], goodRows[1].map((v, j) => (j % 2 ? v : 2)).concat([])], { ...BOOT, cap: 1.1 });
  for (const [name, a] of [['rows15 cap1.5', A1], ['rows15 cap30', A2], ['sparse', A3], ['single', A4], ['halves', A5], ['lottery', A6], ['steady', A7], ['steady2', A8]]) {
    const n = a.sets.length;
    const none = [], allPos = a.sets.map(() => 1), flip = a.sets.map((_s, i) => (i === 1 ? -0.01 : 1)), nanV = a.sets.map((_s, i) => (i === 1 ? NaN : 1)), short = [1];
    for (const checks of [[], [{ name: stats.CHECK_COARSE, diffs: allPos }], [{ name: stats.CHECK_COARSE, diffs: flip }, { name: stats.CHECK_TERMINAL, diffs: flip }], [{ name: 'x', diffs: nanV }], [{ name: 'y', diffs: short }], [{ name: stats.CHECK_TERMINAL, diffs: allPos }, { name: 'z', diffs: none }]]) {
      ST.verdict.push({ name, analysis: enc(a), checks: enc(checks), ...wrap(() => stats.verdictOf(a, checks)) });
    }
  }
  ST.analysesForVerdict = undefined;
}

// 变异检验补的:参差不齐的矩阵、正好踩在名义水平上的 degenerate、Float64Array.sort 的 NaN / -0、手改的结论输入
{
  const next = rng(41);
  const base8 = Array.from({ length: 8 }, () => normal(next));
  const ragged = [
    [base8, base8.slice(0, 5).map((b) => b + 1 + 0.1 * normal(next)), base8.concat([1, 2, 3]).map((b) => b + 0.5 + 0.1 * normal(next))],
    [base8.slice(0, 6), base8.map((b) => b + 1 + 0.2 * normal(next)), base8.slice(0, 3).map((b) => b - 1)],
    [[1, 2, 3, 4], [2, 3], [3, 4, 5, 6, 7, 8]],
    [base8, base8.map((b) => b + 1 + 0.3 * normal(next)), base8.slice(0, 5).map((b) => b - 1 + 0.3 * normal(next))],
    [base8, base8.slice(0, 5).map((b) => b + 1 + 0.3 * normal(next)), base8.map((b) => b - 1 + 0.3 * normal(next))],
    [base8.slice(0, 5), base8.map((b) => b + 1 + 0.3 * normal(next)), base8.map((b) => b - 1 + 0.3 * normal(next))],
  ];
  for (const m of ragged) for (const cap of [null, 4]) {
    const opts = { level: 0.95, draws: 60, seed: 9, ...(cap === null ? {} : { cap }) };
    ST.analyse.push({ matrix: enc(m), ref: 0, opts: enc(opts), ...wrap(() => stats.analyse(m, 0, opts)) });
  }
  // 四天各不相同:重抽到全是同一个值的概率正好 4 × (1/4)^4 = 1/64 = (1 − 0.96875) ÷ 2
  const exactTail = [[0, 0, 0, 0], [0.1, 0.2, 0.3, 0.5], [-0.1, -0.2, -0.4, -0.3]];
  for (const level of [0.96875, 0.96, 0.97]) for (const cap of [null, 3]) {
    const opts = { level, draws: 80, seed: 5, ...(cap === null ? {} : { cap }) };
    ST.analyse.push({ matrix: enc(exactTail), ref: 0, opts: enc(opts), ...wrap(() => stats.analyse(exactTail, 0, opts)) });
  }
  // 八天:挑中的那组在另一半(四天各不相同)上也正好踩线
  const eight = [Array.from({ length: 8 }, () => 0), [0.1, 0.5, 0.2, 0.9, 0.3, 0.7, 0.4, 1.1], [-0.3, 0.2, -0.1, 0.4, -0.2, 0.1, -0.5, 0.3]];
  for (const level of [0.96875, 0.9, 0.99]) {
    const opts = { level, draws: 80, seed: 6, cap: 2 };
    ST.analyse.push({ matrix: enc(eight), ref: 0, opts: enc(opts), ...wrap(() => stats.analyse(eight, 0, opts)) });
  }
  // 一半的天里只有一天
  for (const m of [[[0, 0], [1, 2]], [[0, 0, 0], [1, 2, 3]], [[0, 0, 0, 0, 0], [1, 2, 3, 4, 5], [-1, -2, 0, 3, 3]]]) {
    const opts = { level: 0.9, draws: 40, seed: 3, cap: 5 };
    ST.analyse.push({ matrix: enc(m), ref: 0, opts: enc(opts), ...wrap(() => stats.analyse(m, 0, opts)) });
  }
  // 只有 cap 为 0
  const capZero = [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [1, 2, 3, 4, 5, 6]];
  ST.analyse.push({ matrix: enc(capZero), ref: 0, opts: enc({ level: 0.95, draws: 40, seed: 3, cap: 0 }), ...wrap(() => stats.analyse(capZero, 0, { level: 0.95, draws: 40, seed: 3, cap: 0 })) });
  // 正好踩在 cap 上的 days_needed / seen 为 0
  const flat = [Array.from({ length: 20 }, () => 0), Array.from({ length: 20 }, (_v, i) => (i % 2 ? 1 : 3))];
  for (const cap of [1, 3, 100]) ST.analyse.push({ matrix: enc(flat), ref: 0, opts: enc({ level: 0.95, draws: 50, seed: 2, cap }), ...wrap(() => stats.analyse(flat, 0, { level: 0.95, draws: 50, seed: 2, cap })) });
  ST.typedSort = [];
  for (const xs of [[], [1], [3, 1, 2], [NaN, 1, -1], [1, NaN, NaN, 0], [0, -0, 0, -0], [-0, 0], [0, -0], [Infinity, -Infinity, NaN, 0, -0, 5, -5], [2, 2, 2], [1e-300, -1e-300, 0, -0], [NaN], [NaN, NaN], [-0, -0, 0, 0, NaN, -1, 1], Array.from({ length: 50 }, (_v, i) => ((i * 37) % 11) - 5 + (i % 7 === 0 ? NaN : 0)), Array.from({ length: 30 }, (_v, i) => (i % 3 === 0 ? -0 : i % 3 === 1 ? 0 : (i % 5) - 2))]) {
    ST.typedSort.push({ xs: enc(xs), out: enc(Array.from(Float64Array.from(xs).sort())) });
  }
  // 手改的结论输入:halves 正好 0、检查的差正好 0、集合下标越界
  const A = stats.analyse(exactTail.map((r) => r), 0, { level: 0.95, draws: 40, seed: 5, cap: 3 });
  const A2 = stats.analyse([Array.from({ length: 40 }, () => 0), Array.from({ length: 40 }, (_v, j) => (j % 2 === 0 ? 2 : 0.5))], 0, { level: 0.95, draws: 40, seed: 5, cap: 0.2 });
  const patch = (a, f) => { const c = JSON.parse(JSON.stringify(a)); f(c); return c; };
  const variants = [
    ['halves0', patch(A2, (c) => { c.sets[1].halves = [0, 1]; })], ['halves0b', patch(A2, (c) => { c.sets[1].halves = [1, 0]; })], ['halvesNull', patch(A2, (c) => { c.sets[1].halves = [null, 1]; })], ['halvesOk', A2],
    ['setsShort', patch(A2, (c) => { c.better = [5]; })], ['empty', patch(A2, (c) => { c.better = []; c.ahead = [1]; })], ['ahead2', patch(A2, (c) => { c.better = []; c.ahead = [2, 1]; })], ['top0days', patch(A2, (c) => { c.days = 0; })], ['topNull', patch(A2, (c) => { c.top = null; })],
  ];
  for (const [name, a] of variants) for (const checks of [[], [{ name: 'z', diffs: [0, 0, 0] }], [{ name: 'z', diffs: [0, 1e-300, 0] }], [{ name: 'z', diffs: [0, 0.1] }], [{ name: 'z', diffs: [0] }]]) {
    ST.verdict.push({ name: 'edited ' + name, analysis: enc(a), checks: enc(checks), ...wrap(() => stats.verdictOf(a, checks)) });
  }
}

// 验收补的:区间存在、却有一头没有界(重抽出来的 t* 是 ±∞,finite() 记成 null)——TS 当 -∞ / +∞ 看,不算"领先"也不算"更好"
{
  const nx = rng(5);
  let kept = 0, loNull = 0;
  for (let t = 0; t < 4000 && kept < 14; t += 1) {
    const n = 4 + Math.floor(nx() * 9), sets = 2 + Math.floor(nx() * 3);
    const zero = Array.from({ length: n }, () => 0);
    const m = [zero, ...Array.from({ length: sets - 1 }, () => zero.map(() => (nx() < 0.55 ? 0 : Math.round(nx() * 4 - 1))))];
    const opts = { level: [0.6, 0.7, 0.8, 0.9][Math.floor(nx() * 4)], draws: 1 + Math.floor(nx() * 8), seed: Math.floor(nx() * 100), ...(nx() < 0.5 ? {} : { cap: 3 }) };
    const a = stats.analyse(m, 0, opts);
    const open = a.sets.some((x) => [x.band, x.ci, x.exact].some((iv) => iv && (iv[0] === null || iv[1] === null)));
    if (!open) continue;
    kept += 1;
    if (a.sets.some((x) => x.band && x.band[0] === null)) loNull += 1;
    ST.analyse.push({ matrix: enc(m), ref: 0, opts: enc(opts), ...wrap(() => stats.analyse(m, 0, opts)) });
  }
  console.log('open-ended intervals:', kept, 'with band lo null:', loNull);
}
// summarise:拿几份 run 的结果
for (const [name, result] of SUMS.slice(0, 5)) {
  for (const objective of ['r', 'usd']) for (const opts of [BOOT, { level: 0.9, draws: 120, seed: 3 }]) ST.summarise.push({ name, result, objective, opts: enc(opts), ...wrap(() => stats.summarise(result_(result), objective, opts)) });
}
function result_(r) { return JSON.parse(JSON.stringify(r), (k, v) => (v === '__NaN__' ? NaN : v === '__Inf__' ? Infinity : v === '__-Inf__' ? -Infinity : v === '__neg0__' ? -0 : v)); }
writeFileSync(join(here, 'fly-exit-sweep-stats.json'), JSON.stringify(ST) + '\n');

// ================================================================ report
const RP = { cases: [] };
const dec = result_;
function reportCase(name, result, objective, opts = BOOT, mutate = null) {
  let r = dec(result);
  let summary = stats.summarise(r, objective, opts);
  if (mutate) { const m = mutate(r, summary); r = m.result ?? r; summary = m.summary ?? summary; }
  RP.cases.push({ name, result: enc(r), summary: enc(summary), ...wrap(() => report.formatReport(r, summary)) });
}
for (const [name, result] of SUMS) for (const objective of ['r', 'usd']) reportCase(name, result, objective);
{
  const base = SUMS.find(([n]) => n === 'hills3_only0935_live5')[1];
  const withEntries = SUMS.find(([n]) => n === 'entries_mixed')[1];
  const wide = SUMS.find(([n]) => n === 'wide_replay_auto')[1];
  const rep = SUMS.find(([n]) => n === 'replay_many_days')[1];
  const hillsBig = (() => { const cfg = config({ population: onlyAt('09:35'), live: HILL_SETS }); return enc(sweep.runSweep(hills(16, 11, QUARTERS), cfg, tk)); })();
  reportCase('hills16', hillsBig, 'usd'); reportCase('hills16', hillsBig, 'r');
  reportCase('hills16_floor', (() => { const cfg = config({ population: { ...onlyAt('09:35'), debit_min: 1.5 }, live: HILL_SETS }); return enc(sweep.runSweep(hills(16, 11, QUARTERS), cfg, tk)); })(), 'r');
  const big = (() => { const cfg = config({ population: onlyAt('09:35'), live: HILL_SETS }); return enc(sweep.runSweep(hills(150, 11, QUARTERS), cfg, tk)); })();
  reportCase('hills150', big, 'usd', { level: 0.95, draws: 300, seed: 7 });
  for (const [label, f] of [
    ['few days 3', () => enc(sweep.runSweep(hills(3, 11, QUARTERS), config({ population: onlyAt('09:35'), live: HILL_SETS }), tk))],
    ['few days 4', () => enc(sweep.runSweep(hills(4, 11, QUARTERS), config({ population: onlyAt('09:35'), live: HILL_SETS }), tk))],
    ['no effect', () => enc(sweep.runSweep(hills(16, 11, QUARTERS), config({ population: onlyAt('09:35'), live: spec.liveSets(REF, { tighten_usd: [200, 150, 300], tiers: [[40, 30, 20], [50, 35, 20]], late_factor: [0.5, 1], floor: [0.2, 0.5] }) }), tk))],
    ['only ref', () => enc(sweep.runSweep(hills(3, 11, QUARTERS), config({ population: onlyAt('09:35') }), tk))],
    ['no scenario', () => enc(sweep.runSweep(hills(3, 11, QUARTERS), config({ population: { ...onlyAt('09:35'), wings: [75] } }), tk))],
    ['missing', () => enc(sweep.runSweep(whole7.map((s, i) => (i === 3 ? broken(D(0), CLOCK[3]) : s)), config({ population: onlyAt('09:35') }), tk))],
    ['commission settle', () => enc(sweep.runSweep(dayOf(D(0), CLOCK.map((_c, i) => (i ? 2.4 : 2.05)), 7015), config({ population: onlyAt('09:35'), fill: { ...FILL, terminal: 'settle', commission: 0.65, stop_basis: 'natural' } }), tk))],
    ['short day', () => enc(sweep.runSweep(dayOf(D(0), CLOCK.map((_c, i) => (i ? 2.4 : 2.05)), 7015).slice(0, 54), config({ population: onlyAt('09:35'), fill: { ...FILL, terminal: 'settle' } }), tk))],
    ['stop refused', () => enc(sweep.runSweep(dayOf(D(0), [2.05, 2.1, 2.0, 1.9]), config({ population: onlyAt('09:35'), live: spec.liveSets(REF, { stop_mult: [0.95, 0.9] }) }), tk))],
    ['filtered', () => enc(sweep.runSweep([...WIDE, { ...tick(D(0), '10:02', 9), expiry: '20260303' }, { ...tick(D(0), '10:02', 9), symbol: 'NDX' }], config({ population: { ...POP, debit_max: 3, dist_min: 5, entry_from: '10:00', rights: ['C', 'P'], wings: [25, 50], debit_min: 0.5, dist_max: 100, entry_to: '15:00' } }), tk))],
    ['wide replay refused', () => enc(sweep.runSweep([tick(D(0), CLOCK[0], 0, 7010, [leg(7000, 'C', 9.5, 11.0), leg(7025, 'C', 5.0, 5.1), leg(7050, 'C', 0.7, 1.3), leg(7010, 'C', 14.0, 14.2), leg(7010, 'P', 13.9, 14.1)]), ...[1.4, 1.8, 2.4, 3.0, 3.0, 3.0].map((m, i) => tick(D(0), CLOCK[i + 1], m, 7010))], config({ population: onlyAt('09:35'), replay: { em: 36, sets: spec.replaySets({ stop: [0.4] }) }, live: spec.liveSets(REF, { stop_mult: [0.5, 0.4] }) }), tk))],
    ['replay early', () => enc(sweep.runSweep([...mids6('2026-11-27')], config({ population: onlyAt('09:35'), replay: { em: 36, sets: spec.replaySets(null) } }), tk))],
    ['replay without em', () => enc(sweep.runSweep(hills(2, 3, QUARTERS).map((s) => ({ ...s, legs: s.legs.slice(0, 3) })), config({ population: onlyAt('09:35'), replay: { em: 'auto', sets: spec.replaySets(null) } }), tk))],
  ]) for (const objective of ['r', 'usd']) reportCase(label, f(), objective);
  function mids6(date) { return [2.05, 2.6, 3.2, 3.6, 3.0, 2.9].map((m, i) => tick(date, CLOCK[i], m, 7010)); }

  // 变异检验补的
  {
    const base = SUMS.find(([n]) => n === 'hills3_only0935_live5')[1];
    const lbl = (r, labels) => ({ result: { ...r, live: { ...r.live, labels } } });
    reportCase('wide chars', base, 'usd', BOOT, (r) => lbl(r, ['参照组(现行)', 'a\u2e7fb', 'a\u2e7eb', 'a\u2e80b', '\u{1f600}x', '\ud800y', 'abc']));
    for (const key of ['entry_from', 'entry_to', 'wings', 'rights', 'debit_min', 'debit_max', 'dist_min', 'dist_max']) {
      const val = { entry_from: '10:00', entry_to: '15:00', wings: [25], rights: ['C'], debit_min: 1, debit_max: 5, dist_min: 0, dist_max: 100 }[key];
      reportCase('free except ' + key, base, 'usd', BOOT, (r) => ({ result: { ...r, population: { by: 'loop', entry_from: null, entry_to: null, wings: null, rights: null, debit_min: null, debit_max: null, dist_min: null, dist_max: null, [key]: val } } }));
    }
    reportCase('free all', base, 'usd', BOOT, (r) => ({ result: { ...r, population: { by: 'loop', entry_from: null, entry_to: null, wings: null, rights: null, debit_min: null, debit_max: null, dist_min: null, dist_max: null } } }));
    {
    }
    reportCase('labels longer than sets', base, 'usd', BOOT, (r, s) => ({ result: { ...r, live: { ...r.live, labels: [...r.live.labels, 'extra', 'extra2'] } }, summary: { ...s, live: { ...s.live, secondary: { ...s.live.secondary, sets: s.live.secondary.sets.slice(0, 2) }, primary: { ...s.live.primary, sets: s.live.primary.sets.slice(0, r.live.labels.length) } } } }));
    reportCase('secondary shorter', base, 'usd', BOOT, (r, s) => ({ summary: { ...s, live: { ...s.live, secondary: { ...s.live.secondary, sets: s.live.secondary.sets.slice(0, 2) } } } }));
    reportCase('partial ties', base, 'usd', BOOT, (r, s) => ({ summary: { ...s, live: { ...s.live, primary: { ...s.live.primary, sets: s.live.primary.sets.map((x, i) => (i === 1 ? { ...x, ties: 1, eligible: false, ci: null, band: null } : i === 2 ? { ...x, ties: 0, eligible: false } : x)) } } } }));
    reportCase('from_entries floor', base, 'r', BOOT, (r) => ({ result: { ...r, from_entries: true, population: { ...r.population, debit_min: 5 }, loss_cap: { usd: 2500, r: 500, wing: 25, debit_floor: 0.05 } } }));
    reportCase('from_entries floor no entries', base, 'r', BOOT, (r) => ({ result: { ...r, from_entries: false, population: { ...r.population, debit_min: 0.05 }, loss_cap: { usd: 2500, r: 500, wing: 25, debit_floor: 0.05 } } }));
    reportCase('debit_min below floor', base, 'r', BOOT, (r) => ({ result: { ...r, population: { ...r.population, debit_min: 0.01 }, loss_cap: { usd: 2500, r: 500, wing: 25, debit_floor: 0.05 } } }));
    reportCase('debit_min above floor', base, 'r', BOOT, (r) => ({ result: { ...r, population: { ...r.population, debit_min: 1.5 }, loss_cap: { usd: 2500, r: 500, wing: 25, debit_floor: 0.05 } } }));
    reportCase('seen zero', base, 'usd', BOOT, (r, s) => ({ summary: { ...s, live: { ...s.live, verdict: { state: 'unproven', set: 1, failed: [] }, primary: { ...s.live.primary, sets: s.live.primary.sets.map((x) => ({ ...x, seen: 0, unseen: 0.3 })) } } } }));
    reportCase('seen tiny', base, 'usd', BOOT, (r, s) => ({ summary: { ...s, live: { ...s.live, verdict: { state: 'unproven', set: 1, failed: [] }, primary: { ...s.live.primary, sets: s.live.primary.sets.map((x) => ({ ...x, seen: 1e-9, unseen: 0.3, breakeven: 2, days_needed: 30 })) } } } }));
    reportCase('min_days equal', base, 'usd', BOOT, (r, s) => ({ summary: { ...s, live: { ...s.live, primary: { ...s.live.primary, min_days: s.live.primary.days } } } }));
    reportCase('min_days below', base, 'usd', BOOT, (r, s) => ({ summary: { ...s, live: { ...s.live, primary: { ...s.live.primary, min_days: s.live.primary.days - 1 } } } }));
    reportCase('set out of range', base, 'usd', BOOT, (r, s) => ({ summary: { ...s, live: { ...s.live, verdict: { state: 'unproven', set: 9, failed: [] } } } }));
    reportCase('set equals length', base, 'usd', BOOT, (r, s) => ({ summary: { ...s, live: { ...s.live, verdict: { state: 'better', set: s.live.primary.sets.length, failed: [] } } } }));
    reportCase('coarse short', base, 'usd', BOOT, (r, s) => ({ summary: { ...s, live: { ...s.live, coarse: [0], alt_terminal: [0, 1] } } }));
    reportCase('coarse len equals', base, 'usd', BOOT, (r, s) => ({ summary: { ...s, live: { ...s.live, verdict: { state: 'better', set: 2, failed: [] }, coarse: [0, 1], alt_terminal: [0, 1] } } }));
    reportCase('replay only result', rep, 'usd', BOOT, (r, s) => ({ summary: { ...s, replay: null } }));
    reportCase('replay only summary', base, 'usd', BOOT, (r, s) => ({ summary: { ...s, replay: SUMS.length ? stats.summarise(dec(rep), 'usd', BOOT).replay : null } }));
    reportCase('labels exact', base, 'usd', BOOT, (r) => ({ result: { ...r, live: { ...r.live, labels: r.live.labels.slice(0, 3) } } }));
  }
  // 手改的结论:每一种状态各走一遍(报告只认 summary 里的形状)
  const mk = (state, extra = {}) => (r, s) => ({ summary: { ...s, live: { ...s.live, verdict: { state, set: 1, failed: [], ...extra } } } });
  for (const [label, src] of [['hills16 verdict', hillsBig], ['hills150 verdict', big]]) {
    for (const state of ['better', 'fragile', 'unproven', 'not_separated', 'nothing_to_compare']) {
      for (const objective of ['usd', 'r']) {
        reportCase(`${label} ${state}`, src, objective, { level: 0.95, draws: 100, seed: 7 }, mk(state, state === 'fragile' ? { failed: [stats.CHECK_COARSE, stats.CHECK_HALVES] } : {}));
        reportCase(`${label} ${state} noset`, src, objective, { level: 0.95, draws: 100, seed: 7 }, (r, s) => ({ summary: { ...s, live: { ...s.live, verdict: { state, set: null, failed: [] } } } }));
      }
    }
  }
  // 手改 summary:没有 cap、没有 unseen、seen 非正、worse / behind 非空、also 非空、split 没挑中
  reportCase('edited nocap', hillsBig, 'usd', BOOT, (r, s) => ({ summary: { ...s, live: { ...s.live, primary: { ...s.live.primary, cap: null, sets: s.live.primary.sets.map((x) => ({ ...x, unseen: null, seen: null, breakeven: null, days_needed: null, exact: null })) } } } }));
  reportCase('edited seen nonpos', hillsBig, 'usd', BOOT, (r, s) => ({ summary: { ...s, live: { ...s.live, verdict: { state: 'unproven', set: 1, failed: [] }, primary: { ...s.live.primary, sets: s.live.primary.sets.map((x) => ({ ...x, seen: -3.5, unseen: 0.4 })) } } } }));
  reportCase('edited worse behind', hillsBig, 'usd', BOOT, (r, s) => ({ summary: { ...s, live: { ...s.live, verdict: { state: 'better', set: 1, failed: [] }, primary: { ...s.live.primary, better: [1, 2, 3], worse: [4], behind: [4, 2], ahead: [1, 3] } } } }));
  reportCase('edited split none', hillsBig, 'usd', BOOT, (r, s) => ({ summary: { ...s, live: { ...s.live, primary: { ...s.live.primary, split: [{ picked_on: 'odd', picked: null, in_sample: null, held_out: null, held_out_days: 8, wins: 0, losses: 0, ci: null }, { picked_on: 'even', picked: 2, in_sample: 0.5, held_out: -1.5, held_out_days: 8, wins: 3, losses: 5, ci: [null, 2] }] } } } }));
  reportCase('edited ci nulls', hillsBig, 'r', BOOT, (r, s) => ({ summary: { ...s, live: { ...s.live, primary: { ...s.live.primary, sets: s.live.primary.sets.map((x, i) => ({ ...x, ci: i === 1 ? [null, 1.2] : x.ci, band: i === 1 ? [-0.001, null] : x.band, mean: i === 2 ? -0.0004 : x.mean, diff: i === 3 ? NaN : x.diff })) } } } }));
  reportCase('edited fill', base, 'usd', BOOT, (r, s) => ({ result: { ...r, fill: { ...r.fill, entry_spread_share: 0.25, commission: 1.25, terminal: 'settle', settle_within_min: 30, stop_basis: 'natural', qty: 3, multiplier: 50 }, stride: 3, population: { ...r.population, wings: [25, 50], rights: ['C'], entry_from: '10:00', debit_max: 4.5 } } }));
  reportCase('edited from_entries', withEntries, 'usd', BOOT, (r) => ({ result: { ...r, from_entries: true, population: { ...r.population, by: 'plan' } } }));
  reportCase('edited nosymbol', base, 'usd', BOOT, (r) => ({ result: { ...r, symbol: null, data: { ...r.data, first: null, last: null, not_same_day: 3, other_symbol: 4 } } }));
  reportCase('edited no ref params', base, 'usd', BOOT, (r) => ({ result: { ...r, live: { ...r.live, params: [] } } }));
  reportCase('edited ref stop exit', base, 'usd', BOOT, (r) => ({ result: { ...r, live: { ...r.live, params: [{ ...r.live.params[0], stop_mult: 0.5, exit_at: '15:30' }, ...r.live.params.slice(1)] } } }));
  reportCase('edited kinds', wide, 'usd', BOOT, (r) => ({ result: { ...r, live: { ...r.live, kinds: r.live.kinds.map((_b, i) => (i ? { zz: 1, day_end: 5, profit_trail: 5, stop_loss: 2, 阶段: 7 } : { day_end: 1, unfilled: 3 })), stop_refused: r.live.stop_refused.map((_v, i) => (i % 2 ? 2 : 0)) } } }));
  reportCase('edited loss cap fee', hillsBig, 'usd', BOOT, (r) => ({ result: { ...r, fill: { ...r.fill, commission: 0.65 }, loss_cap: { usd: 2502.6, r: 13.3, wing: 25, debit_floor: 1.5 } } }));
  reportCase('edited loss cap null', hillsBig, 'r', BOOT, (r) => ({ result: { ...r, loss_cap: null } }));
  reportCase('edited debit null', hillsBig, 'r', BOOT, (r) => ({ result: { ...r, debit: null, wings: {}, scenarios: 0 } }));
  reportCase('edited replay em', rep, 'usd', BOOT, (r) => ({ result: { ...r, replay: { ...r.replay, em: null, days_without_em: 3 } } }));
  reportCase('edited replay refused', rep, 'usd', BOOT, (r) => ({ result: { ...r, replay: { ...r.replay, stop_refused: r.replay.stop_refused.map((_v, i) => i + 1) } } }));
  reportCase('edited scenarios day counts', hillsBig, 'usd', BOOT, (r) => ({ result: { ...r, live: { ...r.live, scenarios: [] } } }));
  reportCase('edited lone labels', hillsBig, 'usd', BOOT, (r) => ({ result: { ...r, live: { ...r.live, labels: r.live.labels.slice(0, 2) } } }));
}
writeFileSync(join(here, 'fly-exit-sweep-report.json'), JSON.stringify(RP) + '\n');
console.log('spec', Object.entries(S).map(([k, v]) => `${k}:${v.length}`).join(' '));
console.log('run', runs.length, 'stats', Object.entries(ST).map(([k, v]) => `${k}:${v?.length}`).join(' '), 'report', RP.cases.length);
