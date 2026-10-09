/** 价位警告(对应 Python alerts.py)—— 纯计算 + 状态机。
 *
 * 最难的不是"设警报",是"不要刷屏":每个价位独立状态机,
 * 穿过 → 报一次 → 落防 → 离开 band 之外且过冷却 → 重新上膛。
 */
import type {
  CrossConfirm, LevelKind, LevelState, TrendSnapshot, WatchEvent, WatchLevel,
} from "./contract/alerts.js";
import { completedBars } from "./maTouch.js";
import { fmtF, fmtSF, pyG, pyRound } from "./py.js";

// 价位的报警状态定义在 contract/alerts.ts(盯单上存的就是它);这里转出,老的 import 不用改。
export type { LevelState } from "./contract/alerts.js";

/** 盯单上的步长存这个数 = 自动:按现价分档(autoStep)。存正数 = 就用这个步长。 */
export const AUTO_STEP = 0;
export const DEFAULT_MERGE_PCT = 0.15;
export const DEFAULT_BAND_PCT = 0.3;
export const DEFAULT_COOLDOWN = 300.0;
export const MAX_LEVELS = 24;

export const DEFAULT_MA_PERIODS: readonly number[] = [20, 60, 120, 200];   // 与 Python DEFAULT_MA_PERIODS 同步
export const EXTREME_WINDOW = 250; // 52 周 ≈ 250 个交易日
export const MIN_EXTREME_BARS = 20; // 历史太短时高低点没意义,干脆不给

export class AlertError extends Error {}

/** 计算过程里的价位:盯单上存的那几样(WatchLevel)+ 合并时用的可信度,priority 不上线、不落库。 */
export interface AlertLevel extends WatchLevel {
  priority: number;
}

export function levelDict(l: AlertLevel): WatchLevel {
  return { price: l.price, label: l.label, source: l.source, kind: l.kind, ...(l.ma ? { ma: l.ma } : {}) };
}

// ---------------------------------------------------------------- 价位生成
/** 整数关口的阶梯:1 / 2.5 / 5 × 10^k(0.25、0.5、1、2.5、5、10、25、50…)。 */
const STEP_LADDER: readonly number[] = [1, 2.5, 5];

/**
 * 自动步长:阶梯里刚好够「上下两个关口各自的重新上膛范围不叠」的最小一档,落在现价的 0.6%~1.5% 之间
 * (41 块 → 0.25,180 → 2.5,450 → 5,SPX 6,700 → 50)。
 *
 * 这个门槛是推出来的,不是挑的:两个关口 L 与 L + s 把现价夹在中间,各自的范围是 b·L 与 b·(L + s)(b = bandPct%)。
 * 要它们不叠,s ≥ b·(2L + s);L 不超过现价,所以 s ≥ 2b·现价 / (1 − b)。范围叠在一起的话,价格在两个关口之间
 * 怎么走都离不开其中一个的范围,报过的那个上不了膛。固定的美元步长两头都不对:5 美元在 41 块的股上是 12%,
 * 在 SPX 上是 0.07%(两个关口挨得比合并容差还近,并成了一个)。
 */
export function autoStep(spot: number, bandPct = DEFAULT_BAND_PCT): number {
  if (!(spot > 0) || !(bandPct > 0 && bandPct < 100) || !Number.isFinite(spot)) return 0;
  const need = (spot * 2 * bandPct) / (100 - bandPct);
  // 10^k ≤ need < 10^(k+1):这一个数量级里三档都不够,下一个数量级的第一档一定够
  for (let k = Math.floor(Math.log10(need)); ; k += 1) {
    for (const rung of STEP_LADDER) {
      const step = pyRound(rung * 10 ** k, 10);
      if (step >= need - 1e-12) return step;
    }
  }
}

/** 现价上下最近的整数关口。现价正好在关口上时取上下各一档。step 给正数;自动步长由 buildLevels 先换算好。 */
export function roundLevels(spot: number, step: number): number[] {
  if (spot <= 0 || step <= 0) return [];
  const below = Math.floor(spot / step) * step;
  const above = Math.ceil(spot / step) * step;
  if (Math.abs(above - below) < 1e-9) {
    return [pyRound(below - step, 6), pyRound(above + step, 6)];
  }
  return [pyRound(below, 6), pyRound(above, 6)];
}

const PRIORITY_ROUND = 0;
const PRIORITY_PIVOT = 1;
const PRIORITY_WEAK_WALL = 2;
// 趋势位(均线/52周高低点)与弱墙同级:全市场看得见、但不带当天持仓依据
const PRIORITY_TREND = 2;
const PRIORITY_STRONG_WALL = 3;

function wallLevels(wall: Record<string, any> | null | undefined): AlertLevel[] {
  if (!wall) return [];
  const out: AlertLevel[] = [];
  const zeroDay = (wall["days_to_expiry"] ?? 99) <= 1.0;
  const volRank = zeroDay ? PRIORITY_STRONG_WALL : PRIORITY_WEAK_WALL;
  const oiRank = zeroDay ? PRIORITY_WEAK_WALL : PRIORITY_STRONG_WALL;

  const add = (key: string, label: string, rank: number): void => {
    const entry = wall[key];
    if (entry && entry["strike"]) {
      const kind: LevelKind = key.includes("call") ? "resistance" : "support";
      out.push({ price: Number(entry["strike"]), label, source: key, kind, priority: rank });
    }
  };

  add("call_vol_wall", "上方成交墙", volRank);
  add("put_vol_wall", "下方成交墙", volRank);
  add("call_wall", "上方持仓墙", oiRank);
  add("put_wall", "下方持仓墙", oiRank);

  if (wall["max_pain"]) {
    out.push({
      price: Number(wall["max_pain"]["strike"]), label: "最大痛点",
      source: "max_pain", kind: "pivot", priority: PRIORITY_PIVOT,
    });
  }
  if (wall["gamma_flip"] !== null && wall["gamma_flip"] !== undefined) {
    out.push({
      price: Number(wall["gamma_flip"]), label: "Gamma 翻转位",
      source: "gamma_flip", kind: "pivot", priority: PRIORITY_PIVOT,
    });
  }
  return out;
}

function trendKind(price: number, spot: number): LevelKind {
  if (price < spot) return "support";
  if (price > spot) return "resistance";
  return "pivot";
}

/** 按顺序取一列有效价格。缺了或非正数的整根跳过,不拿别的字段凑。 */
function barValues(bars: Array<Record<string, any>> | null | undefined, key: string): number[] {
  const out: number[] = [];
  for (const bar of bars ?? []) {
    const value = bar[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) out.push(value);
  }
  return out;
}

/**
 * 今天之前的完整日线的收盘。today(美东日期)给了,就和碰均线用同一个函数挑(maTouch.completedBars):
 * 两边认的是同一批日线,收盘和才会是同一个数。不给 = 整个序列都是完整日线。
 */
function priorCloses(bars: Array<Record<string, any>>, today: string | null): number[] {
  return today === null ? barValues(bars, "close") : completedBars(bars, today).map((b) => b.close);
}

/**
 * 日线均线 + 52 周高低点 → 价位(标签降级规则对应 Python trend_levels)。
 * 均线是**含今天**的 X 日简单均线,今天那根还没走完,它的收盘就是现价:(前 X−1 根完整日线的收盘和 + 现价) / X——
 * 和看图软件盘中画的、和「反复碰均线」判的是同一条线。价位上带着那个收盘和(ma),盘中每一轮拿现价重算(levelPriceAt)。
 */
export function trendLevels(
  bars: Array<Record<string, any>> | null | undefined,
  spot: number,
  maPeriods: readonly number[] = DEFAULT_MA_PERIODS,
  extremeWindow = EXTREME_WINDOW,
  today: string | null = null,
): AlertLevel[] {
  if (!bars || !bars.length || !spot || spot <= 0) return [];
  const out: AlertLevel[] = [];

  const closes = priorCloses(bars, today);
  for (const period of maPeriods) {
    if (period < 2 || closes.length < period - 1) continue; // 凑不满就不给,不拿短的凑
    const prior = pyRound(closes.slice(closes.length - (period - 1)).reduce((a, b) => a + b, 0), 6);
    const ma = pyRound((prior + spot) / period, 4);
    if (ma <= 0) continue;
    out.push({
      price: ma, label: `${period}日均线`, source: `ma${period}`,
      kind: trendKind(ma, spot), priority: PRIORITY_TREND, ma: { period, prior_sum: prior },
    });
  }

  const lows = barValues(bars, "low");
  const highs = barValues(bars, "high");
  if (lows.length >= MIN_EXTREME_BARS && highs.length >= MIN_EXTREME_BARS) {
    const full = lows.length >= extremeWindow && highs.length >= extremeWindow;
    const low = pyRound(Math.min(...lows.slice(-extremeWindow)), 4);
    const high = pyRound(Math.max(...highs.slice(-extremeWindow)), 4);
    out.push({
      price: low, label: full ? "52周低点" : "历史低点", source: "low_52w",
      kind: trendKind(low, spot), priority: PRIORITY_TREND,
    });
    out.push({
      price: high, label: full ? "52周高点" : "历史高点", source: "high_52w",
      kind: trendKind(high, spot), priority: PRIORITY_TREND,
    });
  }
  return out;
}

/** 趋势摘要:均线值、52 周高低点、现价在一年区间里的位置(0 = 贴着低点)。 */
export function trendSnapshot(
  bars: Array<Record<string, any>> | null | undefined,
  spot: number,
  maPeriods: readonly number[] = DEFAULT_MA_PERIODS,
  extremeWindow = EXTREME_WINDOW,
  today: string | null = null,
): TrendSnapshot | null {
  const levels = trendLevels(bars, spot, maPeriods, extremeWindow, today);
  if (!levels.length) return null;
  const out: TrendSnapshot = {};
  for (const level of levels) out[level.source] = level.price;
  const low = out["low_52w"];
  const high = out["high_52w"];
  if (low !== undefined && high !== undefined && high > low) {
    out["range_pos_pct"] = pyRound(((spot - low) / (high - low)) * 100.0, 1);
  }
  out["bars"] = barValues(bars, "close").length;
  return out;
}

/**
 * 期权墙价位 + 趋势位 + 整数关口,去重合并后按价格升序返回。
 * step ≤ 0(AUTO_STEP)= 按现价分档;today 是美东日期,日线里今天那根不算完整日线(见 trendLevels)。
 */
export function buildLevels(
  spot: number,
  wall: Record<string, any> | null = null,
  step: number = AUTO_STEP,
  mergePct = DEFAULT_MERGE_PCT,
  maxLevels = MAX_LEVELS,
  history: Array<Record<string, any>> | null = null,
  today: string | null = null,
): AlertLevel[] {
  if (spot <= 0) throw new AlertError("缺少现价,无法生成价位。");

  const levels = wallLevels(wall);
  levels.push(...trendLevels(history, spot, DEFAULT_MA_PERIODS, EXTREME_WINDOW, today));
  for (const price of roundLevels(spot, step > 0 ? step : autoStep(spot))) {
    if (!(price > 0)) continue; // 步长比现价还大时下面那一档是 0:不是一个价位
    levels.push({
      price, label: `整数关口 ${pyG(price)}`, source: "round", kind: "pivot",
      priority: PRIORITY_ROUND,
    });
  }

  const tol = (Math.abs(spot) * mergePct) / 100.0;
  const merged: AlertLevel[] = [];
  for (const level of [...levels].sort((a, b) => a.price - b.price)) {
    if (merged.length && Math.abs(level.price - merged[merged.length - 1]!.price) <= tol) {
      const previous = merged[merged.length - 1]!;
      // 以更可信的那个为准,标签两个都留着
      const [winner, loser] =
        previous.priority >= level.priority ? [previous, level] : [level, previous];
      merged[merged.length - 1] = {
        price: winner.price,
        label: `${winner.label} + ${loser.label}`,
        source: winner.source,
        kind: winner.kind !== "pivot" ? winner.kind : loser.kind,
        priority: winner.priority,
        // 赢的是均线,合并出来的这一条照样跟着现价走;赢的是墙,它就钉在那个行权价上
        ...(winner.ma ? { ma: winner.ma } : {}),
      };
      continue;
    }
    merged.push(level);
  }

  let out = merged;
  if (out.length > maxLevels) {
    out = [...out]
      .sort((a, b) => Math.abs(a.price - spot) - Math.abs(b.price - spot))
      .slice(0, maxLevels);
  }
  return [...out].sort((a, b) => a.price - b.price);
}

// ---------------------------------------------------------------- 状态机
function band(price: number, bandPct: number): number {
  return (Math.abs(price) * bandPct) / 100.0;
}

/**
 * 这个价位此刻在哪。均线跟着现价走:(前 X−1 根完整日线的收盘和 + 现价) / X,和 maTouch.evaluateTouches 同一个式子;
 * 别的价位(墙、整数关口、52 周高低)就是算出来的那个价。
 */
export function levelPriceAt(level: Pick<WatchLevel, "price" | "ma">, price: number): number {
  const ma = level.ma;
  if (!ma || !(ma.period > 1) || !Number.isFinite(ma.prior_sum) || !(price > 0)) return level.price;
  return (ma.prior_sum + price) / ma.period;
}

/** 会漂的线:均线、52 周高低、Gamma 翻转位——价每天(均线是每一轮)在变,变了还是它。 */
function drifts(source: string): boolean {
  return /^ma\d+$/.test(source) || source === "low_52w" || source === "high_52w" || source === "gamma_flip";
}

/**
 * 状态字典的键 = 这个价位是谁。会漂的线,名字就是身份(ma20 的状态不因为它今天换了个价就丢);
 * 行权价与整数关口是离散的格,换了一格就是另一个位:来源 + 价。
 */
export function levelKey(level: Pick<WatchLevel, "price" | "source">): string {
  return drifts(level.source) ? level.source : `${level.source}@${fmtF(level.price, 4)}`;
}

/** 一次穿越,还不知道是哪只股的(symbol 由调用方按盯单补上,补完就是 WatchEvent)。 */
export type CrossingEvent = Omit<WatchEvent, "symbol">;

/** 这一轮取到的一笔价,还没和上一笔接起来。 */
export interface PriceQuote {
  /** 取价的时刻(秒) */
  at: number;
  price: number;
  /**
   * 这个价属于哪一段:日期 + 盘前 / 盘中 / 盘后 / 休市;指数再加价的出处(官方指数 / 期货推算),出处换了也算换段。
   * 券商给了最后成交的时刻就按**那一刻**认——取价的钟过了 09:30,手上那个价可能还是盘前的;没给才按取价的时刻认。
   */
  session: string;
  /** 最后成交的时刻(秒);券商没给是 null */
  tradedAt: number | null;
}

/** 接好的一笔价。settled = 它确实是 session 那一段里的价,能给下一笔当比较的基准。 */
export interface PriceSample extends PriceQuote {
  settled: boolean;
}

/**
 * 把这一轮取到的价接到上一笔后面:回这一笔的样本,和能拿来比穿越的上一笔价(prevPrice;接不上是 null,这一笔只登记)。
 *
 * 能比的条件有两条,缺一条都只登记:
 *  1. **连着**:和上一笔在同一段里(session 相同),取价相隔不超过 maxGap 秒。换段(隔夜、盘前 → 盘中、指数换了出处)的那一下
 *     是跳空不是穿越;隔得比冷却还久(应用关过、断过线、电脑睡过),中间怎么走的不知道——冷却本来就是这个模块里
 *     "还算同一件事"的时长,不另设一个数。
 *  2. **上一笔是这一段里的真价**(settled):换段或断档之后取到的第一笔,可能还是之前留下的旧价(开盘那一笔没进来、
 *     指数还没开始算、行情流刚接上),拿它当基准,下一轮真价一到就把跳空报成了穿越。所以断过之后要先看到报价**动过一次**:
 *     有成交时刻看成交时刻往前走了没有,没有就看价变了没有。动过的那一笔才是基准,从它往后才比。
 */
export function linkSample(
  prev: PriceSample | null | undefined, quote: PriceQuote, maxGap = DEFAULT_COOLDOWN,
): { sample: PriceSample; prevPrice: number | null } {
  if (!prev || !(prev.price > 0)) return { sample: { ...quote, settled: false }, prevPrice: null };
  const gap = quote.at - prev.at;
  const joined = prev.session === quote.session && gap >= 0 && gap <= maxGap;
  const before = prev.tradedAt;
  const after = quote.tradedAt;
  // 成交时刻往前走了 = 这两轮之间有新的成交
  const advanced = before !== null && after !== null && after > before;
  // 连着:上一笔是真价,这一笔就是;上一笔还没坐实,这一笔动了(有新成交,或者价变了)也算坐实。
  // 没连着:价和上一段的不一样说明不了什么,只有成交时刻往前走了才敢认它是新的
  const settled = joined ? prev.settled || advanced || quote.price !== prev.price : advanced;
  return { sample: { ...quote, settled }, prevPrice: joined && prev.settled ? prev.price : null };
}

/**
 * 价格从 prevPrice 走到 price,哪些价位该报警。prevPrice 给 null(第一次取价、接不上上一笔)只登记不报警。
 *
 * confirm = "immediate":两次取价之间跨过就报。
 * confirm = "bar_close":跨过的那一刻只记一笔待确认,等一根 1 分钟 K 线的收盘:穿过之后**第一根还有后续取价的**那一分钟
 * (通常就是穿过的那一分钟;穿在那一分钟最后一轮的,是下一分钟),它最后取到的价还在价位的另一侧才报,回到原来那一侧
 * 或正好收在线上就作废。收盘只认穿过之后取到的价,穿过的那一笔自己不算。待确认的这一笔自己记着那根 K 线的收盘,
 * 不看 prevPrice:换了时段照样确认;后续取价断了档(隔得比 cooldown 还久)才作废。
 */
export function evaluate(
  levels: AlertLevel[],
  states: Record<string, LevelState>,
  prevPrice: number | null,
  price: number,
  nowTs: number,
  bandPct = DEFAULT_BAND_PCT,
  cooldown = DEFAULT_COOLDOWN,
  confirm: CrossConfirm = "immediate",
): [CrossingEvent[], Record<string, LevelState>] {
  const events: CrossingEvent[] = [];
  // 只留这一轮在场的价位:价位重算之后老状态成了孤儿,不带着
  const out: Record<string, LevelState> = {};
  const minute = Math.floor(nowTs / 60);

  for (const level of levels) {
    const key = levelKey(level);
    // 按价格做键的是老库里的状态:认一次,写回去就是新键了
    let state: LevelState = states[key] ?? states[fmtF(level.price, 4)] ?? { armed: true, last_fired_at: null };
    const at = levelPriceAt(level, price);

    // 先看能不能重新上膛:离开得够远,而且过了冷却
    if (!state.armed && Math.abs(price - at) > band(at, bandPct)) {
      const cooled = state.last_fired_at === null || nowTs - state.last_fired_at >= cooldown;
      if (cooled) state = { armed: true, last_fired_at: state.last_fired_at };
    }

    const fire = (direction: "up" | "down", from: number, to: number, line: number, closed: boolean): void => {
      const verb = direction === "up" ? "上穿" : "下破";
      const how = closed ? `1 分钟收盘 ${fmtStrip(to)} 确认,现价 ${fmtStrip(price)}` : `现价 ${fmtStrip(price)}`;
      events.push({
        price: pyRound(line, 4),
        label: level.label,
        source: level.source,
        kind: level.kind,
        direction,
        from: pyRound(from, 4),
        to: pyRound(to, 4),
        at: nowTs,
        text: `${level.label} ${verb} ${fmtStrip(line)}(${how})`,
      });
      state = { armed: false, last_fired_at: nowTs };
    };
    const clear = (): void => {
      state = { armed: true, last_fired_at: state.last_fired_at };
    };

    const pending = state.armed ? state.pending : undefined;
    if (pending !== undefined) {
      const since = nowTs - (pending.close_at ?? pending.at);
      if (!(since >= 0 && since <= cooldown)) {
        clear(); // 断了档:那根 K 线怎么收的不知道
      } else if (minute === pending.minute || pending.close === undefined) {
        // 还在那一分钟里:这一笔是它目前为止的收盘。那一分钟穿过之后没再取到价:换成这一分钟来等
        state = { ...state, pending: { ...pending, minute, close: price, close_at: nowTs } };
      } else {
        const line = levelPriceAt(level, pending.close);
        const held = pending.direction === "up" ? pending.close > line : pending.close < line;
        if (held) fire(pending.direction, pending.from, pending.close, line, true);
        else clear();
      }
    }

    if (state.armed && state.pending === undefined && prevPrice !== null) {
      // 跨过(含正好落在线上):上一笔与这一笔分在线的两侧。均线两笔各算各的线
      const before = prevPrice - levelPriceAt(level, prevPrice);
      if (before * (price - at) <= 0) {
        const direction: "up" | "down" = price >= prevPrice ? "up" : "down";
        if (confirm === "bar_close") state = { ...state, pending: { direction, from: prevPrice, at: nowTs, minute } };
        else fire(direction, prevPrice, price, at, false);
      }
    }
    out[key] = state;
  }
  return [events, out];
}

/**
 * 现价走出了上下两个整数关口之间:把这一对换成现价两侧的那一对。纯计算,不碰期权链、不碰日线——
 * 价位一天只重算一次,自动步长下两个关口只隔现价的 0.6%~1.5%,不跟着换的话第一个关口报完这一天就没有整数关口可报了。
 *
 * - 只动来源是 round 的价位:还在新的一对里的留着(刚穿过的那个就在里面,它的状态按键原样跟着,不会立刻又报);不在的拿掉。
 * - 新的关口挨着别的价位(现价的 mergePct% 以内)就不加:和整批重算时并进那个价位是一回事。
 * - 现价正好压在关口上时不动(这时"两侧的一对"不含它自己,换了就把它丢了)。
 * 没有要换的回 null。
 */
export function reroundLevels<L extends WatchLevel>(
  levels: readonly L[], price: number, step: number, mergePct = DEFAULT_MERGE_PCT,
): Array<L | WatchLevel> | null {
  const size = step > 0 ? step : autoStep(price);
  if (!(price > 0) || !(size > 0)) return null;
  const ratio = price / size;
  if (Math.abs(ratio - Math.round(ratio)) < 1e-9) return null;
  const pair = roundLevels(price, size).filter((r) => r > 0); // 步长比现价还大时下面那一档是 0:不是一个价位
  const same = (x: number, y: number): boolean => Math.abs(x - y) < 1e-9;
  const kept = levels.filter((l) => l.source !== "round" || pair.some((r) => same(r, l.price)));
  const tol = (Math.abs(price) * mergePct) / 100.0;
  const added: WatchLevel[] = pair
    .filter((r) => !kept.some((l) => Math.abs(levelPriceAt(l, price) - r) <= tol))
    .map((r) => ({ price: r, label: `整数关口 ${pyG(r)}`, source: "round", kind: "pivot" as const }));
  if (!added.length && kept.length === levels.length) return null;
  return [...kept, ...added].sort((x, y) => x.price - y.price);
}

function fmtStrip(value: number): string {
  return fmtF(value, 4).replace(/0+$/, "").replace(/\.$/, "");
}

/** 给人看的一句话清单。 */
export function describe(levels: AlertLevel[], spot: number): string[] {
  return levels.map((level) => {
    const gap = spot ? (level.price / spot - 1.0) * 100.0 : 0.0;
    return `${fmtStrip(level.price)} ${level.label}(${fmtSF(gap, 2)}%)`;
  });
}
