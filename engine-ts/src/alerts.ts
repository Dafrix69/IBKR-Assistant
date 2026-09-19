/** 价位警告(对应 Python alerts.py)—— 纯计算 + 状态机。
 *
 * 最难的不是"设警报",是"不要刷屏":每个价位独立状态机,
 * 穿过 → 报一次 → 落防 → 离开 band 之外且过冷却 → 重新上膛。
 */
import type { LevelKind, LevelState, TrendSnapshot, WatchEvent, WatchLevel } from "./contract/alerts.js";
import { fmtF, fmtSF, pyRound } from "./py.js";

// 价位的报警状态定义在 contract/alerts.ts(盯单上存的就是它);这里转出,老的 import 不用改。
export type { LevelState } from "./contract/alerts.js";

export const DEFAULT_STEP = 5.0;
export const DEFAULT_MERGE_PCT = 0.15;
export const DEFAULT_BAND_PCT = 0.3;
export const DEFAULT_COOLDOWN = 300.0;
export const MAX_LEVELS = 24;

export const DEFAULT_MA_PERIODS: readonly number[] = [20, 60, 120, 200];   // 与 Python DEFAULT_MA_PERIODS 同步
export const EXTREME_WINDOW = 250; // 52 周 ≈ 250 个交易日
export const MIN_EXTREME_BARS = 20; // 历史太短时高低点没意义,干脆不给

export class AlertError extends Error {}

/** 计算过程里的价位:盯单上存的那四样(WatchLevel)+ 合并时用的可信度,priority 不上线、不落库。 */
export interface AlertLevel extends WatchLevel {
  priority: number;
}

export function levelDict(l: AlertLevel): WatchLevel {
  return { price: l.price, label: l.label, source: l.source, kind: l.kind };
}

// ---------------------------------------------------------------- 价位生成
/** 现价上下最近的整数关口。现价正好在关口上时取上下各一档。 */
export function roundLevels(spot: number, step = DEFAULT_STEP): number[] {
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

/** 日线均线 + 52 周高低点 → 价位(对应 Python trend_levels,含标签降级规则)。 */
export function trendLevels(
  bars: Array<Record<string, any>> | null | undefined,
  spot: number,
  maPeriods: readonly number[] = DEFAULT_MA_PERIODS,
  extremeWindow = EXTREME_WINDOW,
): AlertLevel[] {
  if (!bars || !bars.length || !spot || spot <= 0) return [];
  const out: AlertLevel[] = [];

  const closes = barValues(bars, "close");
  for (const period of maPeriods) {
    if (closes.length < period) continue;
    const window = closes.slice(-period);
    const ma = pyRound(window.reduce((a, b) => a + b, 0) / period, 4);
    if (ma <= 0) continue;
    out.push({
      price: ma, label: `${period}日均线`, source: `ma${period}`,
      kind: trendKind(ma, spot), priority: PRIORITY_TREND,
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
): TrendSnapshot | null {
  const levels = trendLevels(bars, spot, maPeriods, extremeWindow);
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

/** 期权墙价位 + 趋势位 + 整数关口,去重合并后按价格升序返回。 */
export function buildLevels(
  spot: number,
  wall: Record<string, any> | null = null,
  step = DEFAULT_STEP,
  mergePct = DEFAULT_MERGE_PCT,
  maxLevels = MAX_LEVELS,
  history: Array<Record<string, any>> | null = null,
): AlertLevel[] {
  if (spot <= 0) throw new AlertError("缺少现价,无法生成价位。");

  const levels = wallLevels(wall);
  levels.push(...trendLevels(history, spot));
  for (const price of roundLevels(spot, step)) {
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

/** 一次穿越,还不知道是哪只股的(symbol 由调用方按盯单补上,补完就是 WatchEvent)。 */
export type CrossingEvent = Omit<WatchEvent, "symbol">;

/** 价格从 prevPrice 走到 price,哪些价位该报警。第一次调用只登记不报警。 */
export function evaluate(
  levels: AlertLevel[],
  states: Record<string, LevelState>,
  prevPrice: number | null,
  price: number,
  nowTs: number,
  bandPct = DEFAULT_BAND_PCT,
  cooldown = DEFAULT_COOLDOWN,
): [CrossingEvent[], Record<string, LevelState>] {
  const events: CrossingEvent[] = [];
  const out: Record<string, LevelState> = { ...states };

  for (const level of levels) {
    const key = levelKey(level);
    let state = out[key] ?? { armed: true, last_fired_at: null };
    const bd = band(level.price, bandPct);

    // 先看能不能重新上膛:离开得够远,而且过了冷却
    if (!state.armed && Math.abs(price - level.price) > bd) {
      const cooled = state.last_fired_at === null || nowTs - state.last_fired_at >= cooldown;
      if (cooled) state = { armed: true, last_fired_at: state.last_fired_at };
    }

    if (prevPrice !== null && state.armed) {
      const low = Math.min(prevPrice, price);
      const high = Math.max(prevPrice, price);
      if (low <= level.price && level.price <= high) {
        const direction: "up" | "down" = price >= prevPrice ? "up" : "down";
        events.push({
          price: level.price,
          label: level.label,
          source: level.source,
          kind: level.kind,
          direction,
          from: pyRound(prevPrice, 4),
          to: pyRound(price, 4),
          at: nowTs,
          text:
            `${level.label} ${direction === "up" ? "上穿" : "下破"} ${fmtStrip(level.price)}` +
            `(现价 ${fmtStrip(price)})`,
        });
        state = { armed: false, last_fired_at: nowTs };
      }
    }
    out[key] = state;
  }

  // 价位重算之后老状态会变成孤儿,清掉
  const valid = new Set(levels.map(levelKey));
  const cleaned: Record<string, LevelState> = {};
  for (const [k, v] of Object.entries(out)) if (valid.has(k)) cleaned[k] = v;
  return [events, cleaned];
}

/** 状态字典的键。只用价格:价格才是这个警报的身份。 */
export function levelKey(level: AlertLevel): string {
  return fmtF(level.price, 4);
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

import { pyG } from "./py.js";
