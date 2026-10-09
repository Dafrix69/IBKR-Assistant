/**
 * 信号成绩单(docs/features/signal-scorecard.md):每条信号之后 1 / 5 / 20 个交易日的收盘,按它押的方向算收益,
 * 再和同一只标的在信号**之前**"随便哪天"同样持有期的收益比。比随手一天好,才谈得上这个信号有用。
 *
 * 纯计算:信号与日线由调用方给,日线只含**已经收盘**的那些根。两头都取同一份复权收盘(同 dailyHistory):
 * 从信号之后的第一个收盘进场,到那之后第 k 个收盘。信号发出时的那个价不进计算——它是当时的原始价,
 * 之后一次分红、拆股就和复权收盘对不上了。持有期没走完的信号不进成绩,只在明细里显示成空。
 */
import erf from "@stdlib/math-base-special-erf";

import type { WatchEvent } from "./contract/alerts.js";
import type { PaAnalysis } from "./contract/priceaction.js";
import type { AnomalyEvent } from "./contract/quality.js";
import type { LeaderRow } from "./contract/screener.js";
import type {
  ReviewSignalsResult, SignalEntry, SignalGroup, SignalHorizonStats, SignalSource,
} from "./contract/signals.js";
import { builtinCalendar } from "./marketCalendar.js";
import { TIMEFRAMES } from "./marketdata.js";
import { pyRound } from "./py.js";
import { ET, dateOrdinal, dateStrAt, ordinalToDate, wallParts, wallToEpoch } from "./tz.js";

export const HORIZONS = [1, 5, 20] as const;
/** 结论按哪个持有期下。 */
export const VERDICT_HORIZON = 5;
/** 一类信号在某个持有期上,至少要有多少段**互不重叠**的持有期才下结论。 */
export const MIN_WINDOWS = 20;
/** 少于这么多段互不重叠的持有期,t 不算。 */
export const MIN_T_WINDOWS = 5;
/** 基线看信号之前多少个交易日(约一年)。固定这么长:窗口时长时短,各条信号的基线就不是一个东西。 */
export const BASELINE_BARS = 250;
/**
 * 显著性水平用哪一个:标准正态下 |z| ≥ 2 的概率(约 4.55%)。样本很多时一类信号的门槛就是 2;
 * 段数少的时候按 Student-t 换算,比 2 高(见 tThreshold)。
 */
export const T_SINGLE = 2;
/** 明细最多给几条。 */
export const MAX_RECENT = 50;

export const SOURCE_LABEL: Record<SignalSource, string> = {
  cross: "价位穿越(押顺势)",
  touch: "反复碰均线(押反弹)",
  spike: "急涨急跌(押顺势)",
  day_move: "大涨大跌(押顺势)",
  rvol: "全天放量(只看波动)",
  burst: "窗口放量(只看波动)",
  leaders: "强势股新入选(押涨)",
  pa: "K线 PA(押读出的方向)",
};

// ---------------------------------------------------------------- 事件 → 信号

/**
 * 价位提醒的一条事件 → 信号。穿越押顺势(上穿押涨);碰均线押反弹:从上方回踩(direction = down)押涨,
 * 从下方反抽押跌。价用这一轮的现价(`to`)。
 */
export function signalFromWatchEvent(e: WatchEvent): SignalEntry {
  const touch = e.trigger === "touch";
  return {
    at: new Date(e.at * 1000).toISOString(),
    source: touch ? "touch" : "cross",
    symbol: e.symbol,
    expect: touch ? (e.direction === "down" ? "up" : "down") : e.direction,
    price: Number.isFinite(e.to) ? e.to : null,
    label: e.label,
  };
}

/** 盯异动的一条事件 → 信号。急涨急跌、大涨大跌押顺势;放量不带方向。 */
export function signalFromAnomaly(e: AnomalyEvent): SignalEntry {
  const directional = e.kind === "spike" || e.kind === "day_move";
  return {
    at: new Date(e.at * 1000).toISOString(),
    source: e.kind,
    symbol: e.symbol,
    expect: directional ? e.direction : null,
    price: e.price,
    label: e.title,
  };
}

/** 强势股筛选里今天新进第二阶段的一行 → 信号,押涨。 */
export function signalFromLeader(row: Pick<LeaderRow, "symbol" | "close" | "verdict">, atMs: number): SignalEntry {
  return { at: new Date(atMs).toISOString(), source: "leaders", symbol: row.symbol, expect: "up", price: row.close, label: row.verdict };
}

/**
 * K线 PA 的一次读盘 → 信号:偏多 / 看涨押涨,偏空 / 看跌押跌,中性不记。方向只认 priceaction 自己给的 `bias`
 * (档位的分界是它定的),这里不另设门槛;分数与档位写进 label,周期进小类。
 */
export function signalFromPa(
  pa: Pick<PaAnalysis, "symbol" | "timeframe" | "timeframe_label" | "last" | "score" | "bias" | "bias_label">, atMs: number,
): SignalEntry | null {
  const expect = pa.bias.includes("bull") ? "up" : pa.bias.includes("bear") ? "down" : null;
  if (expect === null) return null;
  return {
    at: new Date(atMs).toISOString(), source: "pa", symbol: pa.symbol, expect,
    price: Number.isFinite(pa.last) ? pa.last : null,
    label: `${pa.timeframe_label} ${pa.bias_label}(${pa.score})`, variant: pa.timeframe,
  };
}

/** 美东某一天零点的 ISO(和 signal_log 的 at 同一个写法,可以直接比大小)。 */
export function etDayStart(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(wallToEpoch({ year, month, day, hour: 0, minute: 0, second: 0 }, ET)).toISOString();
}

const REGULAR_CLOSE = 16 * 3600;
const EARLY_CLOSE = 13 * 3600;
let builtinEarly: ReadonlySet<string> | null = null;

function earlyCloseSet(given: ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (given !== undefined) return given;
  builtinEarly ??= new Set(builtinCalendar().earlyCloses);
  return builtinEarly;
}

/** 美东某一天常规时段收盘的那一刻(毫秒):16:00,提前收盘日 13:00。 */
export function closeEpoch(date: string, earlyCloses?: ReadonlySet<string>): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const seconds = earlyCloseSet(earlyCloses).has(date) ? EARLY_CLOSE : REGULAR_CLOSE;
  return wallToEpoch({ year, month, day, hour: seconds / 3600, minute: 0, second: 0 }, ET);
}

/**
 * K线 PA 的方向一段进场时段只记一次,这一段从哪一刻起算:此刻之前最近的那个收盘(ISO)。
 * 两个收盘之间发出的信号,进场都是下一个收盘那一根(见 entryIndex)——周四 21:00 与周五 02:00 读出同一个方向,
 * 打分时是同一笔,所以只记前一条;按日历日分就会记成两条。周末、假日连着刷,起点一直是上一个交易日的收盘。
 */
export function entrySessionStart(
  nowMs: number, isTradingDay: (date: string) => boolean, earlyCloses?: ReadonlySet<string>,
): string {
  let ordinal = dateOrdinal(dateStrAt(nowMs, ET));
  for (let back = 0; back < 15; back += 1, ordinal -= 1) {
    const date = ordinalToDate(ordinal);
    if (!isTradingDay(date)) continue;
    const close = closeEpoch(date, earlyCloses);
    if (close <= nowMs) return new Date(close).toISOString();
  }
  return etDayStart(ordinalToDate(ordinal));
}

// ---------------------------------------------------------------- 一条信号的收益与基线

export interface DailyClose {
  date: string;
  close: number;
}

/**
 * 进场那一根:信号之后的第一个收盘在日线里的位置。盘前、盘中发的是当天那根;收盘之后、周末、假日发的是下一个交易日那根
 * ——拿信号**之前**的收盘当进场价,等于把引出这条信号的那段行情算成它的功劳。
 * 日线没有往回覆盖到信号那天、或之后还没有收盘,是 -1。
 */
export function entryIndex(bars: readonly DailyClose[], atMs: number, earlyCloses?: ReadonlySet<string>): number {
  const first = bars[0];
  if (first === undefined || !Number.isFinite(atMs)) return -1;
  const p = wallParts(atMs, ET);
  const date = dateStrAt(atMs, ET);
  if (first.date > date) return -1;
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((bars[mid]?.date ?? "") < date) lo = mid + 1;
    else hi = mid;
  }
  const close = earlyCloseSet(earlyCloses).has(date) ? EARLY_CLOSE : REGULAR_CLOSE;
  if (bars[lo]?.date === date && p.hour * 3600 + p.minute * 60 + p.second >= close) lo += 1;
  return lo < bars.length ? lo : -1;
}

/**
 * 一条信号在各持有期的收益(%):进场那根的收盘 → 之后第 k 根的收盘,按押的方向;不带方向的给绝对涨跌。
 * 没走完 / 找不到进场那根的是 null。
 */
export function signalReturns(
  signal: SignalEntry, bars: readonly DailyClose[], earlyCloses?: ReadonlySet<string>,
): Array<number | null> {
  const entry = entryIndex(bars, Date.parse(signal.at), earlyCloses);
  const ref = bars[entry]?.close;
  if (ref === undefined || !(ref > 0)) return HORIZONS.map(() => null);
  return HORIZONS.map((k) => {
    const bar = bars[entry + k];
    if (bar === undefined) return null;
    const raw = (bar.close / ref - 1) * 100;
    return pyRound(signal.expect === "down" ? -raw : signal.expect === "up" ? raw : Math.abs(raw), 4);
  });
}

/**
 * 基线:这只标的在进场那根**之前**的 BASELINE_BARS 个持有期里(每个都在进场那根之前收完),持有 k 天的平均收益(%);
 * `abs` 给平均绝对涨跌(不带方向的信号用)。只用信号发出时已经知道的日线;之前的日线不够是 null,不拿短一截的凑。
 */
export function baselineReturn(bars: readonly DailyClose[], entry: number, k: number, abs: boolean): number | null {
  const first = entry - k - BASELINE_BARS;
  if (first < 0 || entry > bars.length) return null;
  let acc = 0;
  for (let i = first; i < entry - k; i += 1) {
    const r = ((bars[i + k]?.close ?? NaN) / (bars[i]?.close ?? NaN) - 1) * 100;
    acc += abs ? Math.abs(r) : r;
  }
  return Number.isFinite(acc) ? acc / BASELINE_BARS : null;
}

// ---------------------------------------------------------------- 统计

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] ?? null : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function round(v: number | null, d = 2): number | null {
  if (v === null) return null;
  const r = pyRound(v, d);
  return r === 0 ? 0 : r; // 负零不往外给
}

/** 一条走完的信号:进场日(交易日序号,各标的同一本日历)与它的超额收益。 */
export interface Observation {
  day: number;
  excess: number;
}

/** 同一个进场日的并成一条(那天的平均),从早到晚。 */
function byEntryDay(days: readonly number[], values: readonly number[]): { days: number[]; means: number[] } {
  const acc = new Map<number, { sum: number; n: number }>();
  for (const [i, day] of days.entries()) {
    const cell = acc.get(day) ?? { sum: 0, n: 0 };
    cell.sum += values[i] ?? 0;
    cell.n += 1;
    acc.set(day, cell);
  }
  const order = [...acc.keys()].sort((a, b) => a - b);
  return { days: order, means: order.map((day) => { const cell = acc.get(day); return cell ? cell.sum / cell.n : 0; }) };
}

/**
 * 把进场日(不重复、从早到晚)排成互不重叠的持有期:离这一段第一个进场日满 k 个交易日才开下一段。
 * 返回每个进场日属于第几段。同一段里的进场日,持有期两两重叠。
 */
export function windowBlocks(sortedDays: readonly number[], k: number): number[] {
  const out: number[] = [];
  let anchor = -Infinity;
  let block = -1;
  for (const day of sortedDays) {
    if (day - anchor >= k) {
      anchor = day;
      block += 1;
    }
    out.push(block);
  }
  return out;
}

/**
 * 这批信号里互不重叠的持有期最多排得出几段。同一天进场的一百条是一段;连着五天每天一条、各持有 5 天,也只有一段。
 */
export function independentWindows(days: readonly number[], k: number): number {
  const blocks = windowBlocks([...new Set(days)].sort((a, b) => a - b), k);
  return blocks.length ? (blocks[blocks.length - 1] ?? 0) + 1 : 0;
}

/** 各段的平均:段内每个进场日一票。 */
function blockMeans(values: readonly number[], blocks: readonly number[], count: number): number[] {
  const sum = Array.from({ length: count }, () => 0);
  const size = Array.from({ length: count }, () => 0);
  for (const [i, b] of blocks.entries()) {
    sum[b] = (sum[b] ?? 0) + (values[i] ?? 0);
    size[b] = (size[b] ?? 0) + 1;
  }
  return sum.map((v, b) => v / Math.max(size[b] ?? 1, 1));
}

/**
 * 超额收益的均值与它的 t,**每一段互不重叠的持有期一票**:
 *  1. 同一个进场日的信号先并成一条(那天的平均)。一天里发了一百条,涨跌是同一天的行情,不是一百次检验;
 *     按条数平均的话,那一天一家就定了均值,而它在方差里几乎不占分量。
 *  2. 进场日排成互不重叠的持有期(windowBlocks),每段一票,段内各天平分。连着发了一个月的那一阵同理:
 *     它只是几段行情,不能因为天数多就压过别的。
 *  3. 均值的方差按 Hansen–Hodrick 的做法估:进场日相距不到 k 个交易日的每一对,带着各自的票数把乘积算进去
 *     ——两段持有期只要有一天重叠,就有一部分是同一段行情。互不重叠时它就是对各段平均求的普通 t。
 *  4. 小样本修正用段数 G(G / (G − 1));门槛按自由度 G − 1 的 Student-t 取(tThreshold)。
 * `flat`:每个进场日的超额完全一样,没有方差可言。不到 MIN_T_WINDOWS 段、或估出来的方差不是正数时 t 是 null。
 */
export function overlapT(
  obs: readonly Observation[], k: number,
): { t: number | null; mean: number | null; independent: number; flat: boolean } {
  const { days, means } = byEntryDay(obs.map((o) => o.day), obs.map((o) => o.excess));
  const blocks = windowBlocks(days, k);
  const independent = blocks.length ? (blocks[blocks.length - 1] ?? 0) + 1 : 0;
  if (!independent) return { t: null, mean: null, independent, flat: false };
  const size = Array.from({ length: independent }, () => 0);
  for (const b of blocks) size[b] = (size[b] ?? 0) + 1;
  const weight = blocks.map((b) => 1 / (independent * Math.max(size[b] ?? 1, 1)));
  const m = means.reduce((a, x, i) => a + (weight[i] ?? 0) * x, 0);
  const flat = means.every((x) => Math.abs(x - m) <= 1e-12);
  if (flat || independent < MIN_T_WINDOWS) return { t: null, mean: m, independent, flat };
  const z = means.map((x, i) => (weight[i] ?? 0) * (x - m));
  let s = 0;
  for (let a = 0, lo = 0; a < days.length; a += 1) {
    const day = days[a] ?? 0;
    while (day - (days[lo] ?? day) >= k) lo += 1;
    for (let b = lo; b < days.length && (days[b] ?? Infinity) - day < k; b += 1) s += (z[a] ?? 0) * (z[b] ?? 0);
  }
  if (!(s > 0)) return { t: null, mean: m, independent, flat };
  return { t: pyRound(m / Math.sqrt(s * (independent / (independent - 1))), 2), mean: m, independent, flat };
}

/** 标准正态的上尾概率 P(Z > x)。 */
function upperTail(x: number): number {
  return 0.5 * (1 - erf(x / Math.SQRT2));
}

/**
 * Student-t 的 P(|T| ≤ x),自由度是正整数。Abramowitz–Stegun 26.7.3(奇数)/ 26.7.4(偶数)的有限和,是精确式不是近似:
 * θ = atan(x / √ν);偶数 ν:sinθ · Σ c_j cos^{2j}θ;奇数 ν:(2/π)(θ + sinθ · Σ d_j cos^{2j+1}θ)。
 */
function tInside(x: number, df: number): number {
  const theta = Math.atan(x / Math.sqrt(df));
  const sin = Math.sin(theta), cos = Math.cos(theta), cos2 = cos * cos;
  if (df % 2 === 0) {
    let term = 1, sum = 1;
    for (let j = 1; j <= (df - 2) / 2; j += 1) {
      term *= ((2 * j - 1) / (2 * j)) * cos2;
      sum += term;
    }
    return sin * sum;
  }
  let sum = 0;
  if (df > 1) {
    let term = cos;
    sum = cos;
    for (let j = 1; j <= (df - 3) / 2; j += 1) {
      term *= ((2 * j) / (2 * j + 1)) * cos2;
      sum += term;
    }
  }
  return (2 / Math.PI) * (theta + sin * sum);
}

/**
 * 下结论时 |t| 要过多少。显著性水平固定在"正态下 |z| ≥ 2"那个概率(约 4.55%),两处换算:
 *  · 段数少的时候 t 不是正态的:按自由度 `windows − 1` 的 Student-t 取分位数。20 段是 2.14,段数越多越接近 2;
 *  · 同时给 m 类信号下结论:每一类的水平除以 m(Bonferroni),让"m 类里至少有一类是碰巧过线"的机会不超过只判一类时的那个机会。
 * `windows` 给这次下结论的各类里最少的那个段数(对段数多的类偏严,不偏松)。
 */
export function tThreshold(m: number, windows: number): number {
  const df = Math.max(1, Math.trunc(windows) - 1);
  const target = (2 * upperTail(T_SINGLE)) / Math.max(m, 1);
  let lo = 0, hi = 1e6;
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    if (1 - tInside(mid, df) > target) lo = mid;
    else hi = mid;
  }
  return pyRound((lo + hi) / 2, 2);
}

// ---------------------------------------------------------------- 成绩单

interface Scored {
  s: SignalEntry;
  returns: Array<number | null>;
  /** 各持有期的基线(已按押的方向取号);没有基线是 null */
  bases: Array<number | null>;
  /** 进场日的交易日序号 */
  day: number;
}

interface Tally {
  stats: SignalHorizonStats;
  flat: boolean;
}

function tally(mine: readonly Scored[], k: number, hi: number): Tally {
  const done = mine.filter((x) => x.returns[hi] !== null && x.bases[hi] !== null);
  const entryDays = done.map((x) => x.day);
  // 每段互不重叠的持有期一票(见 overlapT):先按进场日并,再按段并;平均、中位数、押对、基线都按段算,条数只作显示
  const rets = byEntryDay(entryDays, done.map((x) => x.returns[hi] ?? 0));
  const bases = byEntryDay(entryDays, done.map((x) => x.bases[hi] ?? 0));
  const blocks = windowBlocks(rets.days, k);
  const { t, independent, flat } = overlapT(done.map((x) => ({ day: x.day, excess: (x.returns[hi] ?? 0) - (x.bases[hi] ?? 0) })), k);
  const blockRets = blockMeans(rets.means, blocks, independent);
  const m = mean(blockRets);
  const b = mean(blockMeans(bases.means, blocks, independent));
  const directional = done.some((x) => x.s.expect !== null);
  return {
    flat,
    stats: {
      horizon: k,
      n: done.length,
      independent,
      mean_pct: round(m),
      median_pct: round(median(blockRets)),
      hit_rate: directional && blockRets.length ? round((blockRets.filter((r) => r > 0).length / blockRets.length) * 100, 1) : null,
      baseline_pct: round(b),
      edge_pct: m !== null && b !== null ? round(m - b) : null,
      t,
    },
  };
}

/** 这一类在这个持有期上够不够下结论:互不重叠的持有期满 MIN_WINDOWS 段。 */
function ready(h: Tally | undefined): boolean {
  return h !== undefined && h.stats.independent >= MIN_WINDOWS && h.stats.edge_pct !== null;
}

function verdictOf(directional: boolean, h: Tally | undefined, threshold: number, judged: number): Pick<SignalGroup, "verdict" | "tone"> {
  const days = VERDICT_HORIZON;
  if (h === undefined || !ready(h)) {
    return { verdict: `互不重叠的 ${days} 天持有期只有 ${h?.stats.independent ?? 0} 段,不到 ${MIN_WINDOWS} 段,先攒着,不下结论`, tone: "info" };
  }
  const edge = h.stats.edge_pct ?? 0;
  const t = h.stats.t;
  const what = directional ? "押的方向" : "之后的波动";
  // 每条的超额收益一模一样时没有 t,按差值的正负说
  if (h.flat) {
    return edge > 0 ? { verdict: `${days} 天后${what}每条都比随手一天好 ${edge} 个百分点`, tone: "good" }
      : edge < 0 ? { verdict: `${days} 天后${what}每条都比随手一天差 ${-edge} 个百分点`, tone: "bad" }
        : { verdict: `${days} 天后和随手一天一样`, tone: "warn" };
  }
  if (t === null) return { verdict: `${days} 天后差 ${edge} 个百分点,但持有期叠得太多,估不出可靠的 t,不下结论`, tone: "info" };
  const bar = judged > 1 ? `;同时判 ${judged} 类,|t| 过 ${threshold} 才算` : `,|t| 过 ${threshold} 才算`;
  if (t >= threshold) return { verdict: `${days} 天后${what}比随手一天好 ${edge} 个百分点(t = ${t}${bar})`, tone: "good" };
  if (t <= -threshold) return { verdict: `${days} 天后${what}反而比随手一天差 ${-edge} 个百分点(t = ${t}${bar})`, tone: "bad" };
  return { verdict: `${days} 天后和随手一天分不出来(差 ${edge} 个百分点,t = ${t}${bar})`, tone: "warn" };
}

function groupLabel(source: SignalSource, variant: string | null): string {
  if (variant === null) return SOURCE_LABEL[source];
  const name = source === "pa" ? String(TIMEFRAMES[variant]?.["label"] ?? variant) : variant;
  return `${SOURCE_LABEL[source]} · ${name}`;
}

/** 小类的先后:没有小类的在前,K线 PA 按周期从短到长,不认识的按字面排在最后。 */
function variantOrder(a: string | null, b: string | null): number {
  const frames = Object.keys(TIMEFRAMES);
  const rank = (v: string | null): number => (v === null ? -1 : frames.includes(v) ? frames.indexOf(v) : frames.length);
  return rank(a) - rank(b) || String(a ?? "").localeCompare(String(b ?? ""));
}

export interface ScoreOptions {
  /** 提前到美东 13:00 收盘的日子(判断信号发在收盘前还是收盘后);不给用内置日历 */
  earlyCloses?: ReadonlySet<string>;
}

/**
 * 全部信号 → 成绩单。`bars` 是各标的的日线(从早到晚,只含已经收盘的);不在里面的标的记进 missing_symbols,它的信号不进成绩。
 */
export function scoreSignals(
  signals: readonly SignalEntry[], bars: ReadonlyMap<string, readonly DailyClose[]>, days: number | null,
  options: ScoreOptions = {},
): ReviewSignalsResult {
  // 各标的共用一本交易日历(所有日线日期的并集):两条信号的持有期重不重叠,按它数
  const calendar = new Map<string, number>();
  for (const date of [...new Set([...bars.values()].flatMap((series) => series.map((b) => b.date)))].sort()) {
    calendar.set(date, calendar.size);
  }
  const missing = new Set<string>();
  const baseCache = new Map<string, number | null>();
  let uncovered = 0;
  const scored: Scored[] = signals.map((s) => {
    const series = bars.get(s.symbol);
    const empty = HORIZONS.map(() => null as number | null);
    if (series === undefined || !series.length) {
      missing.add(s.symbol);
      return { s, returns: empty, bases: empty, day: -1 };
    }
    const at = Date.parse(s.at);
    // 比取到的第一根日线还早:不是"还没走完",是这段日线根本没覆盖到它。数出来,不让它无声无息地消失
    if (!Number.isFinite(at) || (series[0]?.date ?? "") > dateStrAt(at, ET)) uncovered += 1;
    const entry = entryIndex(series, at, options.earlyCloses);
    if (entry < 0) return { s, returns: empty, bases: empty, day: -1 };
    const abs = s.expect === null;
    const bases = HORIZONS.map((k) => {
      const key = `${s.symbol}|${entry}|${k}|${abs ? 1 : 0}`;
      let b = baseCache.get(key);
      if (b === undefined) {
        b = baselineReturn(series, entry, k, abs);
        baseCache.set(key, b);
      }
      return b === null ? null : s.expect === "down" ? -b : b;
    });
    return { s, returns: signalReturns(s, series, options.earlyCloses), bases, day: calendar.get(series[entry]?.date ?? "") ?? -1 };
  });

  const verdictAt = HORIZONS.indexOf(VERDICT_HORIZON);
  const drafts: Array<{ source: SignalSource; variant: string | null; mine: Scored[]; tallies: Tally[] }> = [];
  for (const source of Object.keys(SOURCE_LABEL) as SignalSource[]) {
    const ofSource = scored.filter((x) => x.s.source === source);
    const variants = [...new Set(ofSource.map((x) => x.s.variant ?? null))].sort(variantOrder);
    for (const variant of variants) {
      const mine = ofSource.filter((x) => (x.s.variant ?? null) === variant);
      drafts.push({ source, variant, mine, tallies: HORIZONS.map((k, hi) => tally(mine, k, hi)) });
    }
  }
  // 这一次有几类够得上下结论:类数越多,碰巧有一类过线的机会越大,门槛跟着抬;段数按其中最少的那一类算。
  // 一类都还不够时,给的是刚满 MIN_WINDOWS 段时一类信号要过的那个数
  const judgedOnes = drafts.filter((d) => ready(d.tallies[verdictAt]));
  const judged = judgedOnes.length;
  const fewest = judgedOnes.reduce((a, d) => Math.min(a, d.tallies[verdictAt]?.stats.independent ?? a), Infinity);
  const threshold = tThreshold(judged, Number.isFinite(fewest) ? fewest : MIN_WINDOWS);
  const groups: SignalGroup[] = drafts.map((d) => ({
    source: d.source,
    variant: d.variant,
    label: groupLabel(d.source, d.variant),
    signals: d.mine.length,
    horizons: d.tallies.map((x) => x.stats),
    ...verdictOf(d.source !== "rvol" && d.source !== "burst", d.tallies[verdictAt], threshold, judged),
  }));

  const noBaseline = scored.filter((x) => x.returns[verdictAt] !== null && x.bases[verdictAt] === null).length;
  const single = tThreshold(1, MIN_WINDOWS);
  const notes = [
    "收益从信号之后的第一个收盘算到那之后第 1 / 5 / 20 个交易日的收盘,按信号押的方向(押跌的,跌了是正);放量不带方向,看的是平均绝对涨跌。" +
      "信号发出到当天收盘那一段不算:同一天里先押涨又押跌的两条,在这个口径下正好相抵",
    `基线 = 同一只标的在信号之前 ${BASELINE_BARS} 个交易日里,任意一天持有同样天数的平均;只用信号发出时已经有的日线。信号要比它好才算有用`,
    "每一段互不重叠的持有期一票:同一天进场的信号先并成一条(那天的平均),同一段持有期里的各天再并成一条。" +
      `平均、押对、随手一天、t 都是按段算的,「走完的」只是条数;「不重叠」就是段数,满 ${MIN_WINDOWS} 段才下结论。相邻两段的持有期有重叠时,t 按相关算`,
    judged > 1
      ? `这次同时给 ${judged} 类信号下结论,其中段数最少的一类有 ${fewest} 段:|t| 要过 ${threshold}(只判一类、刚满 ${MIN_WINDOWS} 段时是 ${single};类数越多、段数越少,碰巧过线的机会越大,门槛越高)。` +
        "表里 1 天、20 天两行的 t 没有做这个修正,只作参考"
      : `结论只看 ${VERDICT_HORIZON} 天那一行,|t| 要过 ${threshold}(刚满 ${MIN_WINDOWS} 段时是 ${single},段数越多越接近 ${T_SINGLE};同时判几类还要再抬)。` +
        "表里每一类、每个持有期各是一次检验,格子多了碰巧有一两个过线很正常,别挑着最大的那个看",
    "只陈述历史上发生了什么,不是买卖建议;信号仍然只提醒、不下单",
  ];
  if (uncovered) notes.push(`${uncovered} 条信号比取到的日线还早(日线没取到那么久以前),算不了收益,不进成绩`);
  if (noBaseline) notes.push(`${noBaseline} 条信号之前的日线不够 ${BASELINE_BARS + VERDICT_HORIZON} 根(新上市,或取不到那么早),没有基线,不进成绩`);
  if (missing.size) notes.push(`${missing.size} 只标的取不到日线(没连券商或没有行情权限),它们的信号不进成绩`);
  return {
    days,
    total: signals.length,
    groups,
    t_threshold: threshold,
    dropped: { uncovered, no_baseline: noBaseline },
    recent: scored.slice(-MAX_RECENT).reverse().map((x) => ({ ...x.s, returns: x.returns })),
    missing_symbols: [...missing].sort(),
    notes,
  };
}
