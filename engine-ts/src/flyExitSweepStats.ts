/** 蝶式出场参数扫描的统计(纯计算):每组参数比参照组好多少、这个"好"信不信。
 *
 * 输入是 flyExitSweep 出的 [组][天] 矩阵。同一天里的情景高度相关(同一条标的走势、互相重叠的持有期),
 * 所以**抽样单位是天**:先按天平均,再在天上算。天与天当作互不相关、来自同一个分布。
 *
 * 两层,回答的是两个不同的问题:
 *
 * 一、**见过的这些天上谁领先**(近似):在天上重抽(同一次重抽里各组用同一批天,配对着比)。
 *  1. 每组单看的区间(bootstrap-t)。没考虑"这一组是从好多组里挑出来的"。
 *  2. 算上挑选的区间(max-t):每次重抽看各组的 t 里最极端的那一个,拿它的分位数当临界值;试的组越多越宽。
 *     临界值每一头取"两头分开取"与"取 |t|"里宽的那一个,再不窄于这一组自己单看的那一头。
 *  3. 对半检验:单数天上挑最好的,拿双数天打分,再反过来。
 *  这一层默认"以后的天和见过的天是一类"。它在天数少、差值偏或稀的时候偏乐观,所以**不拿它下结论**。
 *
 * 二、**能不能说它就是更好**(不靠分布假设):蝶的盈亏有合约给的上下限,一组参数一天平均下来最多比参照组多亏 cap。
 *  均值的下界 = (1 − π) × 见过的这部分的下界 − π × cap,其中
 *   · π = 1 − α^(1/n):n 天里一次都没出现的那种天(比见过的最差的一天还差),出现的概率可以高到 π 而不被这 n 天排除
 *     (样本最小值以下的概率质量超过 π 的机会正好是 (1 − π)^n = α;任何分布都成立);
 *   · 见过的这部分 = 不低于样本最小值的那部分分布的均值,下界用 Anderson (1969) 的办法:经验分布整体往坏的方向挪 ε
 *     (ε 来自 DKW–Massart 不等式),等于把最好的 ε 成的天换成见过的最差的那一天。
 *  几组一起比按组数平分 α(Bonferroni),每组的 α 再对半分给上面两样。这个下界对**任何**分布都守得住名义水平,
 *  只要天与天独立、亏损不超过 cap——包括"多数天小赢、偶尔大亏、还没碰上大亏的那种天"。
 *  代价是很保守,而且这不是方法的毛病:n 天全是同一个正数 g 时,"均值其实为零、亏 cap 的那种天占 g ÷ (g + cap)"这个可能
 *  有 (1 − g ÷ (g + cap))^n 的机会一次都不露面,只要它大过 α,就没有任何方法能在水平 α 上排除它。
 *
 * 结论只由第二层出(verdictOf)。没有"至少 N 天"之类的线:天数不够时 π 大,下界自然是负的;
 * minDays 给出"数据再好也下不了结论"的天数,是从 π < 1/2 推出来的,不是定的。
 */
import type { FamilyResult, SweepResult } from "./flyExitSweepSpec.js";

export interface BootOptions {
  /** 置信水平(双侧),比如 0.95 */
  level: number;
  /** 重抽多少次。只决定分位数的分辨率 */
  draws: number;
  /** 随机数种子:同样的输入、同样的种子,结果一位不变 */
  seed: number;
  /** 一天平均下来,一组参数最多能比参照组多亏(或多赚)多少:合约条款给的上限。不给 / null = 不知道上限,第二层的界给不出 */
  cap?: number | null;
}

/** [下界, 上界];null = 那一头没有界 */
export type Interval = [number | null, number | null];

export interface SetStat {
  /** 这一组在全部天上的均值(每天一个数,天与天等权) */
  mean: number;
  /** 比参照组:逐日差的均值 */
  diff: number;
  se: number | null;
  /** 赢 / 输 / 平参照组的天数 */
  wins: number;
  losses: number;
  ties: number;
  /** 单数天、双数天上各自比参照组的差(第 1、3、5… 天是单数天);那一半没有天是 null */
  halves: [number | null, number | null];
  /** 重抽一次、抽到的差值全是同一个数(估不出标准误)的概率 = Σ (这个值占的天数 ÷ 总天数)^总天数 */
  degenerate: number;
  /** 上面那个概率不超过 (1 − level) ÷ 2 才给重抽的区间;逐日与参照组相同的组永远不给 */
  eligible: boolean;
  /** 见过的这些天上,单看这一组(没考虑挑选) */
  ci: Interval | null;
  /** 见过的这些天上,算上从全部组里挑 */
  band: Interval | null;
  /** 不靠分布假设的界 [下界, 上界](组数已经平分进去);不知道上限或不到两天是 null */
  exact: Interval | null;
  /** 下界里的两样:n 天排除不了的那种天最多占几成(π)、见过的这部分的下界 */
  unseen: number | null;
  seen: number | null;
  /** 没见过的那种天里,它一天平均下来比参照组多亏到这个数,领先就没了(见过的这部分下界为正才有) */
  breakeven: number | null;
  /** 见过的这部分照现在的样子不变,要多少天下界才转正(见过的这部分下界为正才有) */
  days_needed: number | null;
}

export interface SplitHalf {
  /** 在哪一半上挑的 */
  picked_on: "odd" | "even";
  /** 挑中的组;那一半上没有哪一组的均值高过参照组就是 null */
  picked: number | null;
  /** 挑的那一半上它比参照组好多少 */
  in_sample: number | null;
  /** 另一半上它比参照组好多少 */
  held_out: number | null;
  held_out_days: number;
  wins: number;
  losses: number;
  /** 另一半上的区间(单看:挑的时候没看过这一半) */
  ci: Interval | null;
}

export interface Analysis {
  days: number;
  level: number;
  draws: number;
  seed: number;
  cap: number | null;
  /** 下标与矩阵的组一一对应;参照组那一项的 diff 是 0 */
  sets: SetStat[];
  reference: number;
  /** 给得出重抽区间的组数 */
  eligible: number;
  /** max-t 的临界值 [下尾, 上尾](t 的单位);没有组给得出区间是 null,哪一头无穷大那一头是 null */
  critical: Interval | null;
  /** 均值最高的那一组(不含参照组);一组都没有是 null */
  top: number | null;
  /** 见过的这些天上,算上挑选的区间整个在 0 之上 / 之下的组(近似,不是结论),按差值从大到小 / 从小到大 */
  ahead: number[];
  behind: number[];
  /** ahead / behind 里,不靠分布假设的界也在 0 的同一侧的:这才是结论 */
  better: number[];
  worse: number[];
  /** 每组每一头分到的 α 里给"没见过的那种天"的那一半 */
  alpha_tail: number | null;
  /** 少于这么多天,数据再好第二层也下不了结论(π < 1/2 才可能:天数 > log₂(1 ÷ alpha_tail)) */
  min_days: number | null;
  split: SplitHalf[];
}

/** mulberry32:确定性的伪随机数(和 backtestLab 的置换检验同一个生成器) */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs: ReadonlyArray<number>): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** 均值的标准误;不到两天、或每天都一样,是 null */
function stdError(xs: ReadonlyArray<number>): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const ss = xs.reduce((acc, x) => acc + (x - m) * (x - m), 0);
  return ss > 0 ? Math.sqrt(ss / (xs.length - 1) / xs.length) : null;
}

/** 重抽一次、抽到的全是同一个值的概率 */
export function degenerateProb(xs: ReadonlyArray<number>): number {
  const n = xs.length;
  if (n < 2) return 1;
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let p = 0;
  for (const c of counts.values()) p += Math.pow(c / n, n);
  return p;
}

const finite = (v: number): number | null => (Number.isFinite(v) ? v : null);

/**
 * 在天上重抽。rows 是各组的逐日差(已经减掉参照组),回每组排好序的 t*,以及每次重抽里各组 t* 的最大值、最小值、
 * 绝对值的最大值(各自排好序;只在有限的 t* 里取)。
 * t* = (重抽均值 − 原均值) ÷ 重抽样本自己的标准误;重抽出来全是同一个值时标准误是 0:均值没动记 0,动了记 ±∞。
 */
function bootstrap(
  rows: ReadonlyArray<ReadonlyArray<number>>, opts: BootOptions,
): { t: number[][]; max: number[]; min: number[]; abs: number[] } {
  const n = rows[0]?.length ?? 0;
  const data = rows.map((row) => Float64Array.from(row));
  const centre = rows.map(mean);
  const t = data.map(() => new Float64Array(opts.draws));
  const max = new Float64Array(opts.draws), min = new Float64Array(opts.draws), abs = new Float64Array(opts.draws);
  const random = seededRandom(opts.seed);
  const pick = new Int32Array(n), drawn = new Float64Array(n);
  for (let b = 0; b < opts.draws; b += 1) {
    for (let j = 0; j < n; j += 1) pick[j] = Math.floor(random() * n);
    let top = -Infinity, bottom = Infinity;
    for (let p = 0; p < data.length; p += 1) {
      const row = data[p] ?? drawn;
      let sum = 0, lo = Infinity, hi = -Infinity;
      for (let j = 0; j < n; j += 1) {
        const v = row[pick[j] ?? 0] ?? 0;
        drawn[j] = v;
        sum += v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const m = sum / n, shift = m - (centre[p] ?? 0);
      let value: number;
      if (lo === hi) {
        value = shift === 0 ? 0 : shift > 0 ? Infinity : -Infinity;
      } else {
        let ss = 0;
        for (let j = 0; j < n; j += 1) {
          const dev = (drawn[j] ?? 0) - m;
          ss += dev * dev;
        }
        value = shift / Math.sqrt(ss / (n - 1) / n);
      }
      const list = t[p];
      if (list !== undefined) list[b] = value;
      // 抽到的全是同一个值的那一组,这一次只算在它自己头上:别让一组太稀的把大家的临界值都拉成无穷大
      if (Number.isFinite(value) && value > top) top = value;
      if (Number.isFinite(value) && value < bottom) bottom = value;
    }
    max[b] = Number.isFinite(top) ? top : 0;
    min[b] = Number.isFinite(bottom) ? bottom : 0;
    abs[b] = Math.max(max[b] ?? 0, -(min[b] ?? 0));
  }
  const sorted = (list: Float64Array): number[] => Array.from(list.sort());
  return { t: t.map(sorted), max: sorted(max), min: sorted(min), abs: sorted(abs) };
}

/** 排好序的 t* 两头对称地各切掉一样多:[下尾分位, 上尾分位] */
function tails(sorted: ReadonlyArray<number>, level: number): [number, number] {
  const last = sorted.length - 1;
  const hi = Math.min(last, Math.max(0, Math.ceil((1 - (1 - level) / 2) * sorted.length) - 1));
  return [sorted[last - hi] ?? NaN, sorted[hi] ?? NaN];
}

/** 单看一组的区间:[均值 − t*上分位 × se, 均值 − t*下分位 × se] */
function ownInterval(diff: number, se: number, sortedT: ReadonlyArray<number>, level: number): Interval {
  const [lower, upper] = tails(sortedT, level);
  return [finite(diff - upper * se), finite(diff - lower * se)];
}

function splitCheck(diffs: ReadonlyArray<ReadonlyArray<number>>, reference: number, opts: BootOptions): SplitHalf[] {
  const n = diffs[0]?.length ?? 0;
  const halves: Array<["odd" | "even", number[], number[]]> = [];
  const odd: number[] = [], even: number[] = [];
  for (let j = 0; j < n; j += 1) (j % 2 === 0 ? odd : even).push(j); // 第 1、3、5… 天是单数天
  halves.push(["odd", odd, even], ["even", even, odd]);
  return halves.map(([name, train, test], h) => {
    let picked: number | null = null, best = 0;
    for (const [p, row] of diffs.entries()) {
      if (p === reference || !train.length) continue;
      const score = mean(train.map((j) => row[j] ?? 0));
      if (score > best) {
        best = score;
        picked = p;
      }
    }
    if (picked === null) return { picked_on: name, picked: null, in_sample: null, held_out: null, held_out_days: test.length, wins: 0, losses: 0, ci: null };
    const held = test.map((j) => diffs[picked]?.[j] ?? 0);
    const se = stdError(held);
    const heldMean = held.length ? mean(held) : null;
    let ci: Interval | null = null;
    if (se !== null && heldMean !== null && degenerateProb(held) <= (1 - opts.level) / 2) {
      const { t } = bootstrap([held], { ...opts, seed: opts.seed + 1 + h });
      ci = ownInterval(heldMean, se, t[0] ?? [], opts.level);
    }
    return {
      picked_on: name, picked, in_sample: best, held_out: heldMean, held_out_days: held.length,
      wins: held.filter((v) => v > 0).length, losses: held.filter((v) => v < 0).length, ci,
    };
  });
}

// ---------------------------------------------------------------- 不靠分布假设的界
/**
 * 不低于 floor 的那部分分布的均值的下界(Anderson 1969):rest 是从它里面独立抽的、从小到大排好的样本。
 * DKW–Massart:真实的分布函数处处不高于经验分布函数 + ε 的把握是 1 − alpha,ε = √(ln(1 ÷ alpha) ÷ (2k))。
 * 把经验分布往坏的方向挪 ε:ε 的质量放在 floor,其余 1 − ε 从最小的样本起依次分。
 */
function seenLower(rest: ReadonlyArray<number>, floor: number, alpha: number): number {
  const k = rest.length;
  if (!k) return floor;
  const eps = Math.sqrt(Math.log(1 / alpha) / (2 * k));
  if (eps >= 1) return floor;
  let mass = 1 - eps, acc = eps * floor;
  for (const y of rest) {
    const w = Math.min(1 / k, mass);
    if (w <= 0) break;
    acc += w * y;
    mass -= w;
  }
  return acc;
}

/**
 * 逐日差 d 的均值的下界,对任何分布都成立(天与天独立、d ≥ −cap):(1 − π) × 见过的这部分的下界 − π × cap。
 * 样本最小值 m 以下的概率质量超过 π = 1 − alphaTail^(1/n) 的机会是 alphaTail;给定 m,其余 n − 1 天是从"不低于 m"的那部分里独立抽的。
 */
export function exactLower(
  d: ReadonlyArray<number>, cap: number, alphaTail: number, alphaSeen: number,
): { lower: number; unseen: number; seen: number } | null {
  const n = d.length;
  if (n < 2 || !(cap >= 0) || !Number.isFinite(cap)) return null;
  const sorted = [...d].sort((a, b) => a - b);
  const unseen = 1 - Math.pow(alphaTail, 1 / n);
  const seen = seenLower(sorted.slice(1), sorted[0] ?? 0, alphaSeen);
  return { lower: (1 - unseen) * seen - unseen * cap, unseen, seen };
}

/**
 * 一张 [组][天] 的矩阵 → 每组比参照组的差、见过的这些天上的区间、对半检验、不靠分布假设的界。
 * 矩阵里的每个数是那一天全部情景的平均;天与天等权。
 */
export function analyse(matrix: ReadonlyArray<ReadonlyArray<number>>, reference: number, opts: BootOptions): Analysis {
  if (!(opts.level > 0 && opts.level < 1)) throw new Error("置信水平要在 0 到 1 之间");
  if (!Number.isInteger(opts.draws) || opts.draws < 1) throw new Error("重抽次数要是正整数");
  const base = matrix[reference] ?? [];
  const n = base.length;
  const cap = opts.cap ?? null;
  const tail = (1 - opts.level) / 2;
  const diffs = matrix.map((row) => row.map((v, j) => v - (base[j] ?? 0)));
  const others = diffs.map((_d, p) => p).filter((p) => p !== reference);
  // 每组每一头的 α = 一头的 α ÷ 组数,再对半分给"没见过的那种天"与"见过的这部分"
  const alphaTail = others.length ? tail / others.length / 2 : null;
  const halfMean = (d: ReadonlyArray<number>, odd: boolean): number | null => {
    const part = d.filter((_v, j) => (j % 2 === 0) === odd);
    return part.length ? mean(part) : null;
  };
  const sets: SetStat[] = diffs.map((d, p) => {
    const se = p === reference ? null : stdError(d);
    const degenerate = degenerateProb(d);
    const stat: SetStat = {
      mean: mean(matrix[p] ?? []), diff: p === reference ? 0 : mean(d), se,
      wins: d.filter((v) => v > 0).length, losses: d.filter((v) => v < 0).length, ties: d.filter((v) => v === 0).length,
      halves: [halfMean(d, true), halfMean(d, false)],
      degenerate, eligible: p !== reference && se !== null && degenerate <= tail, ci: null, band: null,
      exact: null, unseen: null, seen: null, breakeven: null, days_needed: null,
    };
    if (p === reference || cap === null || alphaTail === null) return stat;
    const low = exactLower(d, cap, alphaTail, alphaTail), high = exactLower(d.map((v) => -v), cap, alphaTail, alphaTail);
    if (low === null || high === null) return stat;
    stat.exact = [low.lower, -high.lower];
    stat.unseen = low.unseen;
    stat.seen = low.seen;
    if (low.seen > 0) {
      stat.breakeven = (low.seen * (1 - low.unseen)) / low.unseen;
      // (1 − π(n′)) × seen > π(n′) × cap  ⇔  alphaTail^(1/n′) > cap ÷ (seen + cap)
      stat.days_needed = cap > 0 ? Math.floor(Math.log(alphaTail) / Math.log(cap / (low.seen + cap))) + 1 : 2;
    }
    return stat;
  });
  const eligible = sets.flatMap((s, p) => (s.eligible ? [p] : []));
  let critical: Interval | null = null;
  if (eligible.length) {
    const { t, max, min, abs } = bootstrap(eligible.map((p) => diffs[p] ?? []), opts);
    // 两头分开取:下界看各组 t* 最大值的上尾,上界看最小值的下尾,各占 (1 − level) ÷ 2;取绝对值:|t*| 最大值的 level 分位。每一头用宽的
    const both = abs[Math.min(abs.length - 1, Math.max(0, Math.ceil(opts.level * abs.length) - 1))] ?? NaN;
    const upper = Math.max(tails(max, opts.level)[1], both), lower = Math.min(tails(min, opts.level)[0], -both);
    critical = [finite(lower), finite(upper)];
    for (const [i, p] of eligible.entries()) {
      const s = sets[p];
      if (s === undefined || s.se === null) continue;
      const own = tails(t[i] ?? [], opts.level);
      s.ci = [finite(s.diff - own[1] * s.se), finite(s.diff - own[0] * s.se)];
      // 算上挑选的区间不比这一组自己单看的窄(它自己抽到全是同一个值的那几次只算在它头上)
      s.band = [finite(s.diff - Math.max(upper, own[1]) * s.se), finite(s.diff - Math.min(lower, own[0]) * s.se)];
    }
  }
  const byDiff = (a: number, b: number): number => (sets[b]?.diff ?? 0) - (sets[a]?.diff ?? 0);
  const top = others.length ? [...others].sort(byDiff)[0] ?? null : null;
  const ahead = eligible.filter((p) => (sets[p]?.band?.[0] ?? -Infinity) > 0).sort(byDiff);
  const behind = eligible.filter((p) => (sets[p]?.band?.[1] ?? Infinity) < 0).sort((a, b) => byDiff(b, a));
  return {
    days: n, level: opts.level, draws: opts.draws, seed: opts.seed, cap, sets, reference, eligible: eligible.length, critical, top,
    ahead, behind,
    better: ahead.filter((p) => (sets[p]?.exact?.[0] ?? -Infinity) > 0),
    worse: behind.filter((p) => (sets[p]?.exact?.[1] ?? Infinity) < 0),
    alpha_tail: alphaTail, min_days: alphaTail === null ? null : Math.floor(Math.log2(1 / alphaTail)) + 1,
    split: n >= 2 ? splitCheck(diffs, reference, opts) : [],
  };
}

// ---------------------------------------------------------------- 结论
/**
 * better:有一组不靠分布假设的下界在 0 之上(见过的这些天上的区间当然也在),而且下面三样检查都站得住;
 * fragile:下界在 0 之上,但有一样检查没站住——结论取决于数据里没有的东西,不能当结论;
 * unproven:见过的这些天上有一组领先(算上挑选的区间在 0 之上),但不靠假设的下界不在 0 之上——下不了结论;
 * not_separated:见过的这些天上也分不开;nothing_to_compare:只有参照组,或没有一天有情景。
 */
export type VerdictState = "better" | "fragile" | "unproven" | "not_separated" | "nothing_to_compare";

export interface Verdict {
  state: VerdictState;
  /** 说的是哪一组:better / fragile / unproven 是那一类里差值最大的;not_separated 是均值最高的那一组 */
  set: number | null;
  /** 没站住的那几样检查(fragile 才有) */
  failed: string[];
}

export const CHECK_COARSE = "隔一笔才判断一次";
export const CHECK_TERMINAL = "换一种了结口径";
export const CHECK_HALVES = "单数天与双数天分开看";

/**
 * checks:换一种口径时各组比参照组的差(下标同矩阵),名字会原样进报告。
 * 另有一样不用传:单数天、双数天分开看,这一组在两半上都得领先(对半检验进结论的就是这一条;"在一半上挑、另一半打分"那几行只是给人看的)。
 */
export function verdictOf(primary: Analysis, checks: ReadonlyArray<{ name: string; diffs: ReadonlyArray<number> }>): Verdict {
  if (primary.top === null || primary.days === 0) return { state: "nothing_to_compare", set: null, failed: [] };
  const winner = primary.better[0];
  if (winner === undefined) {
    const lead = primary.ahead[0];
    return lead === undefined ? { state: "not_separated", set: primary.top, failed: [] } : { state: "unproven", set: lead, failed: [] };
  }
  const failed = checks.filter((c) => !((c.diffs[winner] ?? NaN) > 0)).map((c) => c.name);
  const halves = primary.sets[winner]?.halves ?? [null, null];
  if (!halves.every((h) => h !== null && h > 0)) failed.push(CHECK_HALVES);
  return { state: failed.length ? "fragile" : "better", set: winner, failed };
}

export type Objective = "r" | "usd";

export interface FamilySummary {
  family: "live" | "replay";
  objective: Objective;
  /** 主目标上的完整分析(结论由它出) */
  primary: Analysis;
  /** 另一个目标:只看各组自己的均值与单看的区间 */
  secondary: Analysis;
  /** 主目标、各组比参照组的差:隔一笔才判断一次 / 换一种了结口径 */
  coarse: number[];
  alt_terminal: number[];
  verdict: Verdict;
}

export interface Summary {
  objective: Objective;
  level: number;
  draws: number;
  seed: number;
  live: FamilySummary;
  replay: FamilySummary | null;
}

const diffsOf = (matrix: ReadonlyArray<ReadonlyArray<number>>): number[] => {
  const base = matrix[0] ?? [];
  return matrix.map((row) => mean(row.map((v, j) => v - (base[j] ?? 0))));
};

function summariseFamily(f: FamilyResult, objective: Objective, opts: BootOptions, caps: SweepResult["loss_cap"]): FamilySummary {
  const other: Objective = objective === "r" ? "usd" : "r";
  const primary = analyse(f.main[objective], 0, { ...opts, cap: caps?.[objective] ?? null });
  const coarse = diffsOf(f.coarse[objective]), alt = diffsOf(f.alt_terminal[objective]);
  return {
    family: f.family, objective, primary, secondary: analyse(f.main[other], 0, { ...opts, cap: caps?.[other] ?? null }), coarse, alt_terminal: alt,
    verdict: verdictOf(primary, [{ name: CHECK_COARSE, diffs: coarse }, { name: CHECK_TERMINAL, diffs: alt }]),
  };
}

export function summarise(result: SweepResult, objective: Objective, opts: BootOptions): Summary {
  return {
    objective, level: opts.level, draws: opts.draws, seed: opts.seed,
    live: summariseFamily(result.live, objective, opts, result.loss_cap),
    replay: result.replay === null ? null : summariseFamily(result.replay, objective, opts, result.loss_cap),
  };
}
