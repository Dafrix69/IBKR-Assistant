/**
 * SPX 0DTE 多头蝶式止盈策略(v2.1:浮盈回撤追踪)——点位、预计盈利与逐分钟回放。
 * 行为规格 = ../engine-python 的 flyexit.py,逐字段对拍(baseline/golden/flyexit.json)。
 */
import erfStdlib from "@stdlib/math-base-special-erf";
import type { ExitPlan, ExitSimPoint, ExitSimulation, ExitZone, ReviewLevel } from "./contract/review.js";
import type { DrawdownLate, DrawdownTier } from "./contract/tracker.js";

import { fmtF, pyG, pyRound } from "./py.js";

type Rec = Record<string, any>;

export const VARIANCE_WEIGHTS = [0.15, 0.09, 0.07, 0.06, 0.05, 0.04, 0.04, 0.04, 0.05, 0.06, 0.07, 0.11, 0.17];
export const OPEN_MIN = 9 * 60 + 30;
export const CLOSE_MIN = 16 * 60;

export const DEFAULTS: Rec = {
  em: 36.0, tp1: null, tp2: null, stop: 0.5, trail_arm: 1.3,
  trail: 0.3, trail_loose_below: 1.0, trail_loose: 0.4,
  trail_tight_at: 3.0, trail_tight: 0.2, trail_floor: 0.2,
  trail_late: "15:00", trail_late_factor: 0.5,
  zone_hold: 0.45, zone_half: 0.55, zone_stop: 0.8, stop_var: 0.3,
  cutoff_a: "14:00", switch_k: 1.6, otm_band: 10.0,
};

/** 取 "HH:MM" 而不是数字的参数。 */
export const CLOCK_KEYS = ["cutoff_a", "trail_late"];

export function paramsFrom(raw: Rec | null | undefined): Rec {
  const out: Rec = { ...DEFAULTS };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!(key in DEFAULTS) || value === null || value === undefined) continue;
    if (CLOCK_KEYS.includes(key)) {
      out[key] = String(value);
    } else {
      const v = Number(value);
      if (Number.isFinite(v) && v > 0 && !(typeof value === "string" && value.trim() === "")) out[key] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 时间与方差
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

export function remainingVariance(minute: number): number {
  if (minute <= OPEN_MIN) return 1.0;
  if (minute >= CLOSE_MIN) return 0.0;
  const elapsed = minute - OPEN_MIN;
  const bucket = Math.floor(elapsed / 30);
  const frac = (elapsed - bucket * 30) / 30.0;
  let used = 0;
  for (let i = 0; i < bucket; i += 1) used += VARIANCE_WEIGHTS[i]!;
  used += VARIANCE_WEIGHTS[bucket]! * frac;
  return pyRound(Math.max(0.0, Math.min(1.0, 1.0 - used)), 6);
}

export function sigmaRemaining(em: number, minute: number): number {
  return pyRound(em * Math.sqrt(remainingVariance(minute)), 4);
}

export function phaseAt(minute: number, width: number, params: Rec): string {
  if (minute < minutesOf(params["cutoff_a"])) return "A";
  if (sigmaRemaining(params["em"], minute) < width / params["switch_k"]) return "C";
  return "B";
}

export function switchMinute(width: number, params: Rec): number {
  const threshold = width / params["switch_k"];
  for (let minute = OPEN_MIN; minute <= CLOSE_MIN; minute += 1) {
    if (sigmaRemaining(params["em"], minute) < threshold) return minute;
  }
  return CLOSE_MIN;
}

// ---------------------------------------------------------------- 回撤追踪
/** 当前该用的回撤比例。浮盈越接近蝶式的天花板收得越紧,尾盘再收一道。 */
export function trailPct(profitPeak: number, d: number, minute: number, params: Rec): number {
  let pct: number;
  if (profitPeak < params["trail_loose_below"] * d) pct = params["trail_loose"];
  else if (profitPeak >= params["trail_tight_at"] * d) pct = params["trail_tight"];
  else pct = params["trail"];
  if (minute >= minutesOf(params["trail_late"])) pct *= params["trail_late_factor"];
  return pyRound(pct, 6);
}

/** 回撤触发价:浮盈高水位让掉当前档位比例之后剩下的蝶价。 */
export function trailStop(profitPeak: number, d: number, minute: number, params: Rec): number {
  return pyRound(d + profitPeak * (1.0 - trailPct(profitPeak, d, minute, params)), 4);
}

/**
 * 把这套分档导出成 tracker.Targets.profit_drawdown_tiers 的形状(百分点)。
 *
 * 实盘那套按"浮盈 / 成本"选档,回放这套按"浮盈 / D"——对同一张组合是同一个数:
 * 浮盈 = (现价 − D) × 数量 × 乘数、成本 = D × 数量 × 乘数,两边同乘的部分约掉了。
 * 所以档位可以逐字搬过去,不必再传 D。这里是**唯一事实源**,实盘别另写一份。
 */
export function drawdownTiers(raw?: Rec | null): DrawdownTier[] {
  const p = paramsFrom(raw ?? null);
  return [
    { above: 0.0, pct: pyRound(p["trail_loose"] * 100, 4) },
    { above: Number(p["trail_loose_below"]), pct: pyRound(p["trail"] * 100, 4) },
    { above: Number(p["trail_tight_at"]), pct: pyRound(p["trail_tight"] * 100, 4) },
  ];
}

/** 尾盘收紧,导出成 tracker.Targets.profit_drawdown_late 的形状。 */
export function drawdownLate(raw?: Rec | null): DrawdownLate {
  const p = paramsFrom(raw ?? null);
  return { after: p["trail_late"], factor: Number(p["trail_late_factor"]) };
}

/** 激活线,导出成 tracker.Targets.profit_drawdown_arm 的形状(浮盈 / 成本 的倍数)。
 * 回放是"蝶价 ≥ trail_arm × D 才开始记高水位",换成浮盈就是 (trail_arm − 1) × D——同一条线。 */
export function drawdownArm(raw?: Rec | null): number {
  return pyRound(paramsFrom(raw ?? null)["trail_arm"] - 1.0, 6);
}

/** 实盘蝶式预设按**金额**起算(2026-09-26 用户定):每组浮盈到过 $100 才开始追回撤,到过 $200 收紧一档。
 * 回放仍按 D 的倍数(trail_arm / trail_loose_below)——两边在"从哪儿起算、哪儿收紧"这两条线上不再是同一套,
 * 档位百分比、尾盘收紧、最少回吐仍然同源。见 docs/features/tracker.md「蝶式按金额起算」。 */
export const FLY_ARM_USD = 100;
export const FLY_TIGHTEN_USD = 200;

/**
 * 把上面两条金额线按这只蝶**每组的开仓成本**(美元,含乘数,即组合行的 avg_cost)换算成 Targets 的倍数口径
 * (浮盈 / |成本|),引擎的判断一行不用动。成本算不出来回 null,调用方退回按比例的预设。
 *
 * 档位:浮盈 < $200 让 trail_loose(40%),≥ $200 让 trail(30%);原来 ≥ trail_tight_at×成本 让 trail_tight(20%)
 * 那一档保留,但只在它比 $200 那条线更高时才有——便宜的蝶 3 倍成本不到 $200,那一档会排到"收紧"之前,
 * 等于先紧后松,不要。
 */
export function drawdownUsdPreset(
  unitCostUsd: number | null, raw?: Rec | null,
): { tiers: DrawdownTier[]; arm: number } | null {
  const cost = unitCostUsd === null ? NaN : Math.abs(Number(unitCostUsd));
  if (!Number.isFinite(cost) || cost <= 0) return null;
  const p = paramsFrom(raw ?? null);
  const tighten = pyRound(FLY_TIGHTEN_USD / cost, 6);
  const tiers: DrawdownTier[] = [
    { above: 0.0, pct: pyRound(p["trail_loose"] * 100, 4) },
    { above: tighten, pct: pyRound(p["trail"] * 100, 4) },
  ];
  if (Number(p["trail_tight_at"]) > tighten) {
    tiers.push({ above: Number(p["trail_tight_at"]), pct: pyRound(p["trail_tight"] * 100, 4) });
  }
  return { tiers, arm: pyRound(FLY_ARM_USD / cost, 6) };
}

/** 最少回吐,导出成 tracker.Targets.profit_drawdown_floor 的形状(每份的价格点,和蝶价同一个单位)。 */
export function drawdownFloor(raw?: Rec | null): number {
  return Number(paramsFrom(raw ?? null)["trail_floor"]);
}

export function fmtMinute(minute: number): string {
  const h = Math.floor(minute / 60), m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- 模型价
function cdf(x: number): number {
  return 0.5 * (1.0 + erfStdlib(x / Math.sqrt(2.0)));
}

function pdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2.0 * Math.PI);
}

export function bachelierCall(s: number, k: number, sigma: number): number {
  if (sigma <= 1e-9) return Math.max(s - k, 0.0);
  const z = (s - k) / sigma;
  return (s - k) * cdf(z) + sigma * pdf(z);
}

/** Bachelier 看跌:平价关系 P = C − (S − K)。 */
export function bachelierPut(s: number, k: number, sigma: number): number {
  return bachelierCall(s, k, sigma) - (s - k);
}

export function modelPrice(profile: Rec, s: number, sigma: number): number {
  const k1 = profile["lower"], k2 = profile["center"], k3 = profile["upper"];
  let calls = bachelierCall(s, k1, sigma) - 2 * bachelierCall(s, k2, sigma) + bachelierCall(s, k3, sigma);
  if (profile["right"] === "P") calls -= (s - k1) - 2 * (s - k2) + (s - k3);
  return pyRound(Math.max(calls, 0.0), 4);
}

/** 一条腿的模型价。 */
export function legValue(right: string, s: number, k: number, sigma: number): number {
  return String(right).slice(0, 1).toUpperCase() === "P"
    ? bachelierPut(s, k, sigma)
    : bachelierCall(s, k, sigma);
}

/**
 * 任意期权结构的模型净价:每条腿按**带符号比例**加权求和。
 *
 * 蝴蝶(+1/−2/+1)、垂直价差(+1/−1)、铁鹰、单腿(+1)全是这一个式子的特例——
 * modelPrice 那个蝶式专用写法留着是为了黄金基线逐字段对得上,值是同一个。
 * 不夹 0:贷方结构的净价本来就是负的,夹了就把"收权利金"抹成 0。
 */
export function structureValue(
  legs: Array<{ strike: number; right: string; ratio: number }>, s: number, sigma: number,
): number {
  let out = 0;
  for (const leg of legs) out += leg.ratio * legValue(leg.right, s, leg.strike, sigma);
  return pyRound(out, 4);
}

// ---------------------------------------------------------------- 反解 σ
// 「当前波动率下这只蝶到 S 值多少」要先有个 σ。σ 有三个来源,精度递减,全部按同一个
// Bachelier 口径,谁也不冒充谁——调用方拿到 source 要如实说出来。

/** 反解的搜索区间(点)。上界取 400:SPX 一天的 EM 从没接近过这个数,
 * 真解到边界上说明输入本身不对,那时宁可回 null。 */
export const SIGMA_MIN = 0.05;
export const SIGMA_MAX = 400.0;

/** 单调函数上找根的二分。f 必须在 [lo, hi] 上单调,方向由 rising 指定。 */
function bisect(
  f: (x: number) => number, target: number, lo: number, hi: number, rising: boolean,
): number | null {
  const flo = f(lo), fhi = f(hi);
  // 目标落在区间之外:没有根。夹到边界上再返回,等于拿一个假的 σ 去算钱。
  if (rising ? target <= flo || target >= fhi : target >= flo || target <= fhi) return null;
  let a = lo, b = hi;
  for (let i = 0; i < 200; i += 1) {
    const mid = (a + b) / 2;
    const v = f(mid);
    if (Math.abs(v - target) < 1e-9 || b - a < 1e-9) return mid;
    if (rising ? v < target : v > target) a = mid;
    else b = mid;
  }
  return (a + b) / 2;
}

/**
 * 从**单腿**期权价反解 σ(点)。
 *
 * 单腿的 Bachelier 价对 σ 严格单调递增(vega 恒正),根唯一,任何标的位置都能解。
 * 蝶价解不动的时候用它——它是市场报出来的真价,比时钟 σ 靠谱得多。
 */
export function impliedSigmaLeg(
  s: number, k: number, price: number, right: string,
): number | null {
  if (!Number.isFinite(s) || !Number.isFinite(k) || !Number.isFinite(price) || price <= 0) return null;
  const put = String(right).slice(0, 1).toUpperCase() === "P";
  const f = (sigma: number): number => (put ? bachelierPut(s, k, sigma) : bachelierCall(s, k, sigma));
  const sigma = bisect(f, price, SIGMA_MIN, SIGMA_MAX, true);
  return sigma === null ? null : pyRound(sigma, 6);
}

/**
 * 从**蝶价**反解 σ(点)。解得出来时它最好用:反解回去正好还原当前蝶价,
 * 所以「标的到 X 时值多少」在 X → 当前标的时会平滑地收敛到现价,不会跳。
 *
 * 只在标的落在两翼之间(|S − K| < W,内在价值为正)才有效。那时蝶价对 σ 严格单调
 * 递减,根唯一;标的一旦跑到翼外,内在价值是 0,蝶价对 σ **先升后降**——同一个价格
 * 对应两个 σ,差出来的钱能到一倍(实测 7725/7750/7775 蝶、标的 7720、蝶价 4.50:
 * σ≈19.5 与 σ≈42.6 都对得上,拿它们算 7740 分别是 10.20 和 5.54)。这种时候返回 null,
 * 让调用方退到单腿反解,而不是从两个根里猜一个。
 */
export function impliedSigmaFly(profile: Rec, s: number, price: number): number | null {
  const k = Number(profile["center"]), w = Number(profile["width"]);
  if (!Number.isFinite(s) || !Number.isFinite(k) || !Number.isFinite(w) || w <= 0) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  if (Math.abs(s - k) >= w) return null; // 翼外:双根,不解
  const sigma = bisect((x) => modelPrice(profile, s, x), price, SIGMA_MIN, SIGMA_MAX, false);
  return sigma === null ? null : pyRound(sigma, 6);
}

// ---------------------------------------------------------------- 点位与区间
export function trancheSizes(qty: number): [number, number] {
  const third = qty > 0 ? Math.max(1, Math.floor(qty / 3)) : 0;
  return [Math.min(third, qty), Math.min(third, Math.max(qty - third, 0))];
}

export function levels(profile: Rec, params: Rec): ReviewLevel[] {
  const d = profile["debit"];
  if (d === null || d === undefined) return [];
  const mult = profile["multiplier"], qty = profile["qty"];
  const [t1, t2] = trancheSizes(qty);
  // 固定档位默认关闭(tp1/tp2 = null),不画线也不占表格行
  const rows: Array<[string, number | null, string, number]> = [
    ["tp1", params["tp1"], "第一档止盈", t1],
    ["tp2", params["tp2"], "第二档止盈", t2],
    ["trail_arm", params["trail_arm"], "回撤追踪激活", 0],
    ["stop", params["stop"], "止损", qty],
  ];
  const live = rows.filter((r): r is [string, number, string, number] => r[1] !== null && r[1] !== undefined);
  return live.map(([kind, multOfD, label, tranche]) => {
    const price = pyRound(d * multOfD, 4);
    const per = pyRound((price - d) * mult, 2);
    return {
      kind, price, mult_of_debit: multOfD, label, tranche_qty: tranche, pnl_per_contract: per,
      expected_pnl: tranche ? pyRound(per * tranche, 2) : null,
    };
  });
}

export function zones(profile: Rec, params: Rec): ExitZone[] {
  const k = profile["center"], w = profile["width"];
  const row = (kind: string, ratio: number, label: string): ExitZone => ({
    kind, half_width: pyRound(ratio * w, 4), low: pyRound(k - ratio * w, 4), high: pyRound(k + ratio * w, 4), label,
  });
  return [
    row("hold", params["zone_hold"], `±${fmtF(params["zone_hold"], 2)}W 临界线:阶段 B 出界全清、阶段 C 界内持到结算`),
    row("half", params["zone_half"], `±${fmtF(params["zone_half"], 2)}W:阶段 C 落在 0.45W–0.55W 清一半,更远立即清残值`),
    row("stop", params["zone_stop"], `±${fmtF(params["zone_stop"], 2)}W:剩余方差 > ${Math.round(params["stop_var"] * 100)}% 时出界止损`),
  ];
}

// ---------------------------------------------------------------- 逐分钟回放
function barCloseMap(bars: Rec[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of bars) {
    const c = b["close"];
    if (c === null || c === undefined) continue;
    const v = Number(c);
    if (!Number.isFinite(v)) continue;
    out.set(String(b["time"] ?? ""), v);
  }
  return out;
}

function intrinsic(profile: Rec, s: number): number {
  const k1 = profile["lower"], k2 = profile["center"], k3 = profile["upper"];
  let v: number;
  if (profile["right"] === "P") v = Math.max(k1 - s, 0) - 2 * Math.max(k2 - s, 0) + Math.max(k3 - s, 0);
  else v = Math.max(s - k1, 0) - 2 * Math.max(s - k2, 0) + Math.max(s - k3, 0);
  return pyRound(v, 4);
}

export function simulate(
  profile: Rec, entryBarTime: string, spxBars: Rec[], flyBars: Rec[], params: Rec, actual: Rec | null = null,
): ExitSimulation {
  const d = profile["debit"];
  if (profile["action"] !== "BUY") {
    return { applicable: false, reason: "该止盈策略只适用于多头蝶(买翼卖中心);这是一张卖出的蝶。" };
  }
  if (d === null || d === undefined) {
    return { applicable: false, reason: "没有入场净权利金 D,策略的所有阈值都以 D 为基准,无法回放。" };
  }
  const qty = Math.trunc(profile["qty"]);
  const mult = Number(profile["multiplier"]);
  const k = profile["center"], w = profile["width"];
  const flyClose = barCloseMap(flyBars);
  const day = entryBarTime.slice(0, 10);

  const timeline = spxBars.filter((b) => {
    const t = String(b["time"] ?? "");
    return t >= entryBarTime && t.slice(0, 10) === day && b["close"] !== null && b["close"] !== undefined;
  });
  if (!timeline.length) return { applicable: false, reason: "开仓当天没有标的 K 线,无法回放。" };

  let remaining = qty;
  const [t1, t2] = trancheSizes(qty);
  let tp1Done = false, tp2Done = false, halfDone = false, otmDone = false;
  const entryS = Number(timeline[0]!["close"]);
  const entryOutside = Math.abs(entryS - k) > params["zone_stop"] * w;
  let insideSeen = !entryOutside;
  let profitPeak = 0.0;
  let armed = false;
  const events: Rec[] = [];
  const series: ExitSimPoint[] = [];
  let enteredB = false;
  let settled = false;

  const sell = (time: string, n: number, price: number, phase: string, rule: string, source: string): void => {
    n = Math.max(0, Math.min(n, remaining));
    if (n <= 0) return;
    const pnl = pyRound((price - d) * mult * n, 2);
    events.push({ time, phase, rule, qty: n, price: pyRound(price, 4), pnl, source, remaining: remaining - n });
    remaining -= n;
  };

  for (const bar of timeline) {
    const t = String(bar["time"]);
    const minute = minutesOf(t.slice(11, 16));
    if (minute > CLOSE_MIN) break;
    const s = Number(bar["close"]);
    const sigma = sigmaRemaining(params["em"], minute);
    const real = flyClose.get(t);
    const price = real !== undefined ? real : modelPrice(profile, s, sigma);
    const source = real !== undefined ? "real" : "model";
    const dist = Math.abs(s - k);
    const phase = phaseAt(minute, w, params);
    const r = remainingVariance(minute);
    if (remaining > 0) {
      if (!armed && price >= params["trail_arm"] * d) armed = true;
      if (armed) profitPeak = Math.max(profitPeak, price - d);
    }
    const stopLine = armed ? trailStop(profitPeak, d, minute, params) : null;
    series.push({
      time: t, price: pyRound(price, 4), source, phase, sigma_rem: sigma, dist: pyRound(dist, 4),
      remaining, trail_stop: stopLine,
    });
    if (remaining <= 0) continue;

    if (minute >= CLOSE_MIN) {
      const settle = intrinsic(profile, s);
      sell(t, remaining, settle, phase, `结算:按 16:00 标的 ${fmtF(s, 2)} 的内在价值 ${fmtF(settle, 2)}`, "settle");
      settled = true;
      break;
    }

    if (price <= params["stop"] * d) {
      sell(t, remaining, price, phase, `止损:蝶价 ${fmtF(price, 2)} ≤ ${fmtF(params["stop"], 2)}×D`, source);
      continue;
    }
    if (dist <= params["zone_stop"] * w) insideSeen = true;
    if (insideSeen && dist > params["zone_stop"] * w && r > params["stop_var"]) {
      sell(t, remaining, price, phase, `止损:|S−K| = ${fmtF(dist, 1)} > ${fmtF(params["zone_stop"], 2)}W 且剩余方差 ${fmtF(r * 100, 0)}% > ${fmtF(params["stop_var"] * 100, 0)}%`, source);
      continue;
    }
    if (entryOutside && !otmDone && dist <= params["otm_band"]) {
      otmDone = true;
      // 至少留 1 张:标的刚贴近中心正是蝶价要爆发的时刻,这里把仓位清空等于拿"分批落袋"
      // 顶掉了整套止盈。1 张的单在这一步不动,直接交给回撤追踪。
      const otmQty = Math.min(t1, remaining - 1);
      if (otmQty > 0) {
        sell(t, otmQty, price, phase, `OTM 蝶:标的 ${fmtF(s, 2)} 进入 K±${pyG(params["otm_band"])},分批落袋 ${otmQty} 张`, source);
      }
      if (remaining <= 0) continue;
    }

    // 回撤追踪:阶段 A/B 全天生效。位置信号一律优先于价格信号——蝶价回撤本来就是 |S−K| 扩大的
    // 影子,标的已经出界时按区间规则归因更干净;阶段 C 更是整段让给区间规则,σ_剩余 太小的时候
    // 蝶价由内在价值主导,再叠一层价格追踪只会被尾盘的 gamma 噪声反复扫。
    const zoneTakesOver = phase === "C" || (phase === "B" && dist > params["zone_hold"] * w);
    if (armed && !zoneTakesOver && profitPeak > 0) {
      const giveBack = profitPeak - (price - d);
      const pct = trailPct(profitPeak, d, minute, params);
      if (giveBack >= profitPeak * pct && giveBack >= params["trail_floor"]) {
        sell(t, remaining, price, phase, `回撤追踪:浮盈从高水位 ${fmtF(profitPeak, 2)} 回吐 ${fmtF(giveBack, 2)}(${fmtF(pct * 100, 0)}% 档,触发价 ${fmtF(trailStop(profitPeak, d, minute, params), 2)}),清仓`, source);
        continue;
      }
    }

    if (phase === "A") {
      if (params["tp1"] !== null && !tp1Done && price >= params["tp1"] * d) {
        tp1Done = true;
        sell(t, t1, price, phase, `第一档:蝶价 ${fmtF(price, 2)} ≥ ${fmtF(params["tp1"], 2)}×D,清 1/3`, source);
      }
      if (params["tp2"] !== null && remaining > 0 && !tp2Done && price >= params["tp2"] * d) {
        tp2Done = true;
        sell(t, t2, price, phase, `第二档:蝶价 ${fmtF(price, 2)} ≥ ${fmtF(params["tp2"], 2)}×D,再清 1/3`, source);
      }
      continue;
    }

    if (phase === "B") {
      if (!enteredB) {
        enteredB = true;
        // 至少留 1 张:qty//3 对 1–2 张的单会算出 0,等于 14:00 硬性平仓,把阶段 B/C 全废掉。
        const cap = Math.max(1, Math.floor(qty / 3));
        if (remaining > cap) {
          sell(t, remaining - cap, price, phase, `进入 14:00 过渡:留仓压到 1/3(${cap} 张)`, source);
          if (remaining <= 0) continue;
        }
      }
      if (dist > params["zone_hold"] * w) {
        sell(t, remaining, price, phase, `阶段 B:|S−K| = ${fmtF(dist, 1)} > ${fmtF(params["zone_hold"], 2)}W,全清`, source);
      }
      continue;
    }

    // 阶段 C
    if (dist > params["zone_half"] * w) {
      sell(t, remaining, price, phase, `阶段 C:|S−K| = ${fmtF(dist, 1)} > ${fmtF(params["zone_half"], 2)}W,立即清残值`, source);
    } else if (dist >= params["zone_hold"] * w && !halfDone) {
      halfDone = true;
      sell(t, Math.ceil(remaining / 2), price, phase, `阶段 C:|S−K| = ${fmtF(dist, 1)} 在 ${fmtF(params["zone_hold"], 2)}W–${fmtF(params["zone_half"], 2)}W,清一半`, source);
    }
  }

  const last = timeline.length ? timeline[timeline.length - 1]! : null;
  if (remaining > 0 && last !== null && !settled) {
    const s = Number(last["close"]);
    const t = String(last["time"]);
    if (minutesOf(t.slice(11, 16)) >= CLOSE_MIN - 1) {
      const settle = intrinsic(profile, s);
      sell(t, remaining, settle, "C", `结算:按收盘标的 ${fmtF(s, 2)} 的内在价值 ${fmtF(settle, 2)}`, "settle");
    } else {
      const mark = series.length ? series[series.length - 1]!["price"] : d;
      events.push({
        time: t, phase: phaseAt(minutesOf(t.slice(11, 16)), w, params),
        rule: `数据到此为止,剩余 ${remaining} 张按最后蝶价 ${fmtF(mark, 2)} 估值(未平仓)`,
        qty: remaining, price: pyRound(mark, 4), pnl: pyRound((mark - d) * mult * remaining, 2), source: "mark", remaining,
      });
      remaining = 0;
    }
  }

  const strategyPnl = pyRound(events.reduce((acc, e) => acc + e["pnl"], 0), 2);
  const holdPnl = last === null ? null : pyRound((intrinsic(profile, Number(last["close"])) - d) * mult * qty, 2);
  const actualPnl = actual === null ? null : (actual["pnl"] ?? null);
  const bestMid = series.length ? Math.max(...series.map((p) => p["price"])) : null;
  return {
    applicable: true,
    entry_outside: entryOutside,
    entry_dist: pyRound(Math.abs(entryS - k), 4),
    events,
    series,
    totals: {
      strategy: strategyPnl,
      actual: actualPnl,
      hold_to_settle: holdPnl,
      best_mid: bestMid === null ? null : pyRound(bestMid, 4),
      best_mid_pnl: bestMid === null ? null : pyRound((bestMid - d) * mult * qty, 2),
      profit_peak: pyRound(profitPeak, 4),
      model_minutes: series.filter((p) => p["source"] === "model").length,
      real_minutes: series.filter((p) => p["source"] === "real").length,
    },
  };
}

// ---------------------------------------------------------------- 汇总
export function plan(
  profile: Rec, entryBarTime: string, spxBars: Rec[], flyBars: Rec[], rawParams: Rec | null | undefined,
  actual: Rec | null = null,
): Rec {
  const params = paramsFrom(rawParams);
  const w = profile["width"];
  const sw = switchMinute(w, params);
  const cutoff = minutesOf(params["cutoff_a"]);
  // simulation 要先算 sim 才有,所以局部用「还差 simulation 的那一份」;别为了类型去挪代码顺序
  const out: Omit<ExitPlan, "simulation"> & { simulation?: ExitSimulation } = {
    params,
    levels: levels(profile, params),
    zones: zones(profile, params),
    phases: {
      a_until: fmtMinute(cutoff),
      c_from: fmtMinute(sw),
      sigma_at_switch: sigmaRemaining(params["em"], sw),
      threshold: pyRound(w / params["switch_k"], 4),
      em_at_open: params["em"],
      wing_in_sigma: params["em"] ? pyRound(w / params["em"], 2) : null,
    },
    notes: [
      `EM 取 ${pyG(params["em"])} 点(文档默认;应每日从 ATM straddle 取,EM = straddle × 0.85)`,
      "触发判断用组合分钟线的中间价,文档要求按 bid,回放结果略偏乐观",
      `止盈按浮盈回撤追踪:蝶价 ≥ ${fmtF(params["trail_arm"], 2)}×D 后记高水位,浮盈 < ${pyG(params["trail_loose_below"])}×D 让 ${fmtF(params["trail_loose"] * 100, 0)}%、${pyG(params["trail_loose_below"])}–${pyG(params["trail_tight_at"])}×D 让 ${fmtF(params["trail"] * 100, 0)}%、≥ ${pyG(params["trail_tight_at"])}×D 让 ${fmtF(params["trail_tight"] * 100, 0)}%,${params["trail_late"]} 之后再乘 ${pyG(params["trail_late_factor"])};回吐不足 ${pyG(params["trail_floor"])} 点不触发。阶段 C 交给区间规则。`,
    ],
  };
  if (params["tp1"] === null && params["tp2"] === null) {
    out["notes"].push(`固定倍数档位已关闭(蝶价上限就是翼宽 ${pyG(w)},用 D 的倍数封顶会在 D 小的时候锁死出场);要恢复 v2.0 的分批止盈,传 tp1 / tp2 即可`);
  }
  const sim = simulate(profile, entryBarTime, spxBars, flyBars, params, actual);
  out["simulation"] = sim;
  if (sim["applicable"] && sim["totals"]["model_minutes"]) {
    out["notes"].push(`有 ${sim["totals"]["model_minutes"]} 分钟没有真实蝶价,用 Bachelier 模型价(σ_剩余)补上,图上以虚线区分`);
  }
  if (sim["applicable"] && sim["entry_outside"]) {
    out["notes"].push(`开仓时 |S−K| = ${pyG(sim["entry_dist"])} 点 > ${fmtF(params["zone_stop"], 2)}W:这是远端 OTM 蝶(文档 §2.3),位置止损从标的首次进入 ${fmtF(params["zone_stop"], 2)}W 之后才生效,并按 OTM 规则在标的进入 K±${pyG(params["otm_band"])} 时分批落袋`);
  }
  const d = profile["debit"];
  if (d !== null && d !== undefined && actual && actual["price"] !== null && actual["price"] !== undefined && actual["kind"] === "closed") {
    out["actual_exit_mult"] = d ? pyRound(actual["price"] / d, 2) : null;
  }
  return out;
}
