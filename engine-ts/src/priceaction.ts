/** 价格行为(Price Action)实时分析——纯计算。
 *
 * 数字由代码算,叙事才交给 LLM。突破一律用收盘价确认;影线穿透归「扫单」。
 * 打分权重全部摆在模块顶部,结论怎么来的必须能被逐条质疑。
 *
 * 两条不许破的规矩:
 *  · 判定只用已收盘的 K 线。最后一根还没走完时把它摘出来单独报(forming),它不确认突破、扫单、形态,不进打分。
 *    收没收盘对着调用方给的时刻算,这个模块自己不读钟;行情是延迟档时,钟点到了数据也未必到齐,再往前退(见 PaClock)。
 *  · 历史上的事件按当时看得到的东西算。第 i 根上的突破 / 扫单只用到第 i 根为止已经确认的摆动点与当时的 ATR,
 *    后来的摆动点不回头改它(见 structureHistory)。
 */
import { ema } from "./backtest.js";
import { fmtF, fmtSF, pyFloat, pyRound } from "./py.js";
import { ET, stampAt, wallToEpoch } from "./tz.js";

import type {
  PaAgreement, PaAnalysis, PaEqualLevel, PaEvent, PaForming, PaFvg, PaHtfSummary, PaLevel, PaOrderBlock, PaPattern,
    PaPlan, PaAnalyzeResult, PaContext, PaEvidence, PaSubScore, PaSweep, PaSwing,
} from "./contract/priceaction.js";

export class PriceActionError extends Error {}

// K 线周期表与最少根数搬到了 marketdata.ts(下单层也要用);这里转出,老的 import 路径不变。
export { MIN_BARS, TIMEFRAMES } from "./marketdata.js";
import { DELAYED_FEED_MAX_MS, MIN_BARS, TIMEFRAMES } from "./marketdata.js";
import type { BarsFeed } from "./marketdata.js";
export const SWING_STRENGTH = 2;
export const CHART_BARS = 140;
/** 图上叠的均线周期(富途默认那三条);只作图,不进打分。 */
export const MA_PERIODS = [5, 10, 20];

// 打分权重。正 = 看涨,负 = 看跌。数是手定的,没有拿成绩单校过:成绩单攒够样本之前不动它们。
const W = {
  trend: 30.0,
  choch: 25.0,
  bos: 15.0,
  position: 15.0,
  ema: 12.0,
  sweep: 15.0,
  pattern: 10.0,
  level: 8.0,
  volume: 8.0,
};

// ---------------------------------------------------------------- 数据结构
export interface PABar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const body = (b: PABar) => Math.abs(b.close - b.open);
const span = (b: PABar) => b.high - b.low;
const bullish = (b: PABar) => b.close > b.open;

export interface Swing {
  index: number;
  time: string;
  price: number;
  kind: "high" | "low";
  label: string;
}

function swingDict(s: Swing): PaSwing {
  return { index: s.index, time: s.time, price: pyRound(s.price, 4), kind: s.kind, label: s.label };
}

export function toBars(rows: Array<Record<string, unknown>>): PABar[] {
  return rows.map((row) => ({
    time: String(row["time"] ?? row["date"] ?? ""),
    open: Number(row["open"]),
    high: Number(row["high"]),
    low: Number(row["low"]),
    close: Number(row["close"]),
    volume: Number(row["volume"] ?? 0.0) || 0.0,
  }));
}

// ---------------------------------------------------------------- 波动尺度
export function trueRange(bar: PABar, prev: PABar | null): number {
  if (prev === null) return span(bar);
  return Math.max(span(bar), Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close));
}

/** trs[k] 是第 k + 1 根的真实波幅(第一根没有前收,不算)。 */
function trueRanges(bars: PABar[]): number[] {
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) trs.push(trueRange(bars[i]!, bars[i - 1]!));
  return trs;
}

/** trs 里 end 之前最多 period 个的简单平均。 */
function meanBefore(trs: number[], end: number, period: number): number {
  const tail = trs.slice(Math.max(0, end - period), end);
  return tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0.0;
}

/** 最近 period 个真实波幅的简单平均(不是 Wilder 平滑)。 */
export function atr(bars: PABar[], period = 14): number {
  if (bars.length < 2) return 0.0;
  const trs = trueRanges(bars);
  return meanBefore(trs, trs.length, period);
}

/** 每一根收盘时的 ATR:out[i] 只用到第 i 根为止,最后一项等于 atr(bars)。 */
export function atrSeries(bars: PABar[], period = 14): number[] {
  const trs = trueRanges(bars);
  return bars.map((_, i) => meanBefore(trs, i, period));
}

/** 容差:小于它的价差当噪音。ATR 的 0.35 倍;没有 ATR 时退到价格的万分之五。 */
function tolOf(atrValue: number, close: number): number {
  return atrValue > 0 ? atrValue * 0.35 : Math.abs(close) * 0.0005;
}

// ---------------------------------------------------------------- 最后一根收没收盘
/** 日线几点算走完(美东小时):只看盘中是常规收盘 16:00,含盘前盘后是盘后结束 20:00。
 *  提前收盘日实际更早,按这两个点算只会偏晚,不会把没走完的当成走完的。 */
const DAILY_CLOSE_HOUR_ET = { rth: 16, extended: 20 };

/** 这根 K 线几点走完(epoch 毫秒)。周期不认识或时间戳读不懂,返回 null。
 *  日内的时间戳按「这一根的起点」读(IBKR 的口径):起点 + 周期。时间戳是终点的数据源按同一条算,
 *  只会晚一个周期才认它收盘,不会早。 */
export function barCloseEpochMs(time: string, timeframe: string, extendedHours = false): number | null {
  const seconds = Number(TIMEFRAMES[timeframe]?.["seconds"]);
  const stamp = parseBarTime(time);
  if (!(seconds > 0) || stamp === null) return null;
  if (seconds >= 86_400) {
    const hour = extendedHours ? DAILY_CLOSE_HOUR_ET.extended : DAILY_CLOSE_HOUR_ET.rth;
    return wallToEpoch({ ...stamp, hour, minute: 0, second: 0 }, ET);
  }
  return wallToEpoch(stamp, ET) + seconds * 1000;
}

// ---------------------------------------------------------------- 摆动结构
/** 分形高低点。左侧严格、右侧允许相等:平顶只认第一根。 */
export function findSwings(bars: PABar[], strength = SWING_STRENGTH): Swing[] {
  const out: Swing[] = [];
  for (let i = strength; i < bars.length - strength; i++) {
    const left = bars.slice(i - strength, i);
    const right = bars.slice(i + 1, i + 1 + strength);
    const bar = bars[i]!;
    if (
      bar.high > Math.max(...left.map((b) => b.high)) &&
      bar.high >= Math.max(...right.map((b) => b.high))
    ) {
      out.push({ index: i, time: bar.time, price: bar.high, kind: "high", label: "" });
    }
    if (
      bar.low < Math.min(...left.map((b) => b.low)) &&
      bar.low <= Math.min(...right.map((b) => b.low))
    ) {
      out.push({ index: i, time: bar.time, price: bar.low, kind: "low", label: "" });
    }
  }
  out.sort((a, b) => a.index - b.index || (a.kind === "high" ? 0 : 1) - (b.kind === "high" ? 0 : 1));
  return out;
}

/** 把新确认的摆动点折进交替序列:方向换了就接上,同向只在更极端时顶掉上一个。返回它有没有进序列。 */
function adopt(seq: Swing[], swing: Swing): boolean {
  const last = seq[seq.length - 1];
  if (last === undefined || last.kind !== swing.kind) {
    seq.push(swing);
    return true;
  }
  if (swing.kind === "high" ? swing.price > last.price : swing.price < last.price) {
    seq[seq.length - 1] = swing;
    return true;
  }
  return false;
}

/** 整理成严格高低交替:相邻同向只留更极端的那个。 */
export function zigzag(swings: Swing[]): Swing[] {
  const out: Swing[] = [];
  for (const swing of swings) adopt(out, swing);
  return out;
}

/** 给每个摆动点打 HH/HL/LH/LL。第一个高/低点没有参照,记 H/L。 */
export function labelSwings(points: Swing[]): Swing[] {
  const highs: number[] = [];
  const lows: number[] = [];
  const out: Swing[] = [];
  for (const swing of points) {
    let label: string;
    if (swing.kind === "high") {
      label = highs.length ? (swing.price > highs[highs.length - 1]! ? "HH" : "LH") : "H";
      highs.push(swing.price);
    } else {
      label = lows.length ? (swing.price > lows[lows.length - 1]! ? "HL" : "LL") : "L";
      lows.push(swing.price);
    }
    out.push({ ...swing, label });
  }
  return out;
}

export function readTrend(points: Swing[]): { trend: string; label: string } {
  const highs = points.filter((s) => s.kind === "high");
  const lows = points.filter((s) => s.kind === "low");
  if (highs.length < 2 || lows.length < 2) {
    return { trend: "unknown", label: "摆动点不足两组,结构尚未成形" };
  }
  const up =
    highs[highs.length - 1]!.price > highs[highs.length - 2]!.price &&
    lows[lows.length - 1]!.price > lows[lows.length - 2]!.price;
  const down =
    highs[highs.length - 1]!.price < highs[highs.length - 2]!.price &&
    lows[lows.length - 1]!.price < lows[lows.length - 2]!.price;
  if (up) return { trend: "up", label: "上升结构(高点抬高 + 低点抬高)" };
  if (down) return { trend: "down", label: "下降结构(高点降低 + 低点降低)" };
  return { trend: "range", label: "震荡(高点与低点没有同向移动)" };
}

export type PAEvent = PaEvent;

/** 一段 K 线从头走到尾留下的结构:截至最后一根的交替摆动序列、收盘突破、扫单。 */
export interface StructureHistory {
  /** 截至最后一根的交替序列(还没打 HH / HL 标签) */
  points: Swing[];
  /** 收盘突破,旧 → 新 */
  events: PAEvent[];
  /** 扫单,旧 → 新 */
  sweeps: PaSweep[];
}

/** 顺时间走一遍,每一根只用它收盘时已经看得到的东西,后来的摆动点不回头改之前的判断:
 *  · 分形要等右边 strength 根走完才算确认;同向相邻只留更极端的那个,也是确认一个折一个。
 *  · 收盘越过当时还没被越过的那个前高 / 前低 → 结构事件:同向记 BOS,反向记 CHoCH。
 *  · 影线刺穿当时序列里的某个摆动点(超过那一根自己的容差 tolAt(i))又收了回来 → 扫单;只查最后 sweepWindow 根。
 *  同一段 K 线截短了再算,截断处之前的事件与扫单一条不变(priceaction.spec 钉着)。 */
export function structureHistory(
  bars: PABar[], tolAt: (index: number) => number, strength = SWING_STRENGTH,
  keepEvents = 6, sweepWindow = 40, keepSweeps = 3,
): StructureHistory {
  const fractals = findSwings(bars, strength);
  const seq: Swing[] = [];
  const events: PAEvent[] = [];
  const sweeps: PaSweep[] = [];
  let next = 0;
  let direction: string | null = null;
  let pendingHigh: Swing | null = null;
  let pendingLow: Swing | null = null;
  const sweepFrom = Math.max(0, bars.length - sweepWindow);

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    if (pendingHigh !== null && bar.close > pendingHigh.price) {
      const kind = direction === null || direction === "up" ? "BOS" : "CHoCH";
      direction = "up";
      events.push(makeEvent(kind, "up", i, bar, pendingHigh));
      pendingHigh = null;
    }
    if (pendingLow !== null && bar.close < pendingLow.price) {
      const kind = direction === null || direction === "down" ? "BOS" : "CHoCH";
      direction = "down";
      events.push(makeEvent(kind, "down", i, bar, pendingLow));
      pendingLow = null;
    }
    if (i >= sweepFrom) {
      // 此刻的 seq 只有上一根为止确认的摆动点:这一根才确认的还没折进来
      const sweep = sweepAt(bar, i, seq, tolAt(i));
      if (sweep !== null) sweeps.push(sweep);
    }
    for (; next < fractals.length && fractals[next]!.index + strength <= i; next++) {
      const swing = fractals[next]!;
      if (!adopt(seq, swing)) continue;
      if (swing.kind === "high" && swing.price > bar.close) pendingHigh = swing;
      else if (swing.kind === "low" && swing.price < bar.close) pendingLow = swing;
    }
  }
  return { points: seq, events: events.slice(-keepEvents), sweeps: sweeps.slice(-keepSweeps) };
}

function makeEvent(kind: string, direction: string, index: number, bar: PABar, swing: Swing): PaEvent {
  return {
    kind,
    direction,
    time: bar.time,
    index,
    level: pyRound(swing.price, 4),
    close: pyRound(bar.close, 4),
    swing_time: swing.time,
    text:
      `${bar.time} ${kind}:收盘 ${pyFloat(pyRound(bar.close, 4))} ` +
      `${direction === "up" ? "上破" : "下破"}前${direction === "up" ? "高" : "低"} ` +
      `${pyFloat(pyRound(swing.price, 4))}`,
  };
}

// ---------------------------------------------------------------- 关键位
export function clusterLevels(
  bars: PABar[], points: Swing[], tol: number, last: number, perSide = 3,
): PaLevel[] {
  const prices = points.map((s) => s.price).sort((a, b) => a - b);
  if (!prices.length || tol <= 0 || !last) return [];

  // 对着这一簇最低的那个比,不对着上一个比:一个挨一个接下去,一簇能被接得比容差宽出好几倍,
  // 画出来的那条线(簇的均价)上可能一个摆动点都没有
  const clusters: number[][] = [[prices[0]!]];
  for (const price of prices.slice(1)) {
    const lastCluster = clusters[clusters.length - 1]!;
    if (price - lastCluster[0]! <= tol) lastCluster.push(price);
    else clusters.push([price]);
  }

  const levels: PaLevel[] = [];
  for (const group of clusters) {
    const price = group.reduce((a, b) => a + b, 0) / group.length;
    let touches = 0;
    for (const b of bars) {
      if (Math.abs(b.high - price) <= tol || Math.abs(b.low - price) <= tol) touches += 1;
    }
    levels.push({
      price: pyRound(price, 4),
      swings: group.length,
      touches,
      side: price > last ? "resistance" : "support",
      distance_pct: pyRound((price / last - 1.0) * 100.0, 2),
    });
  }

  const above = levels
    .filter((l) => l["side"] === "resistance")
    .sort((a, b) => (a["price"] as number) - (b["price"] as number));
  const below = levels
    .filter((l) => l["side"] === "support")
    .sort((a, b) => (b["price"] as number) - (a["price"] as number));
  // 从低到高排,支撑在前、阻力在后
  return [...below.slice(0, perSide).reverse(), ...above.slice(0, perSide)];
}

/** 未回补的 FVG。窄于 tol 的当噪音丢掉,已被走完的不再列。 */
export function findFvgs(bars: PABar[], tol: number, keep = 4): PaFvg[] {
  const out: PaFvg[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const prev = bars[i - 1]!;
    const nxt = bars[i + 1]!;
    let bottom: number;
    let top: number;
    let side: string;
    if (nxt.low > prev.high) {
      bottom = prev.high;
      top = nxt.low;
      side = "bull";
    } else if (nxt.high < prev.low) {
      bottom = nxt.high;
      top = prev.low;
      side = "bear";
    } else {
      continue;
    }
    const size = top - bottom;
    if (size < tol) continue;

    const rest = bars.slice(i + 2);
    let filled: number;
    if (side === "bull") {
      const reached = rest.length ? Math.min(...rest.map((b) => b.low)) : top;
      filled = (top - reached) / size;
    } else {
      const reached = rest.length ? Math.max(...rest.map((b) => b.high)) : bottom;
      filled = (reached - bottom) / size;
    }
    filled = Math.min(Math.max(filled, 0.0), 1.0);
    if (filled >= 0.9) continue;
    out.push({
      side,
      time: bars[i]!.time,
      bottom: pyRound(bottom, 4),
      top: pyRound(top, 4),
      filled_pct: pyRound(filled * 100.0, 1),
    });
  }
  return out.slice(-keep);
}

/** 推动最近一次突破之前的最后一根反向 K 线,以及突破之后它有没有被回踩。 */
export function orderBlock(
  bars: PABar[], event: PAEvent | null, lookback = 25,
): PaOrderBlock | null {
  if (!event) return null;
  const end = event["index"] as number;
  const wantBullish = event["direction"] === "down"; // 下破之前找最后一根阳线
  for (let i = end; i > Math.max(-1, end - lookback); i--) {
    const bar = bars[i]!;
    if (body(bar) > 0 && bullish(bar) === wantBullish) {
      // 回踩从突破之后那一根数起:突破之前的那几根是把价格推出去的那一段,还没离开谈不上回来。
      // 紧挨着它的下一根不算(开盘价接着它的收盘价,必然落在它的范围里)。
      const after = bars.slice(Math.max(i + 2, end + 1));
      const mitigated = after.some((b) => b.low <= bar.high && b.high >= bar.low);
      return {
        side: wantBullish ? "bear" : "bull",
        time: bar.time,
        bottom: pyRound(bar.low, 4),
        top: pyRound(bar.high, 4),
        mitigated,
      };
    }
  }
  return null;
}

/** 影线刺穿前高/前低但收了回来 —— 止损被扫。seq 是这一根之前确认的交替序列,从旧到新找,认第一个;60 根以前的不看。 */
function sweepAt(bar: PABar, index: number, seq: readonly Swing[], tol: number): PaSweep | null {
  for (const swing of seq) {
    if (index - swing.index > 60) continue;
    if (swing.kind === "high" && bar.high > swing.price + tol && bar.close < swing.price) {
      return makeSweep("bear", bar, index, swing);
    }
    if (swing.kind === "low" && bar.low < swing.price - tol && bar.close > swing.price) {
      return makeSweep("bull", bar, index, swing);
    }
  }
  return null;
}

function makeSweep(direction: string, bar: PABar, index: number, swing: Swing): PaSweep {
  return {
    direction,
    time: bar.time,
    index,
    level: pyRound(swing.price, 4),
    extreme: pyRound(direction === "bear" ? bar.high : bar.low, 4),
    text:
      `${bar.time}:影线${direction === "bear" ? "上破" : "下破"}` +
      `前${direction === "bear" ? "高" : "低"} ${pyFloat(pyRound(swing.price, 4))} ` +
      `后收回${direction === "bear" ? "下" : "上"}方`,
  };
}

/** 等高 / 等低:两个几乎同价的摆动点。 */
export function equalLevels(points: Swing[], tol: number): PaEqualLevel[] {
  const out: PaEqualLevel[] = [];
  for (const kind of ["high", "low"] as const) {
    const same = points.filter((s) => s.kind === kind);
    for (let i = 0; i + 1 < same.length; i++) {
      const a = same[i]!;
      const b = same[i + 1]!;
      if (Math.abs(a.price - b.price) <= tol * 0.6) {
        const price = pyRound((a.price + b.price) / 2.0, 4);
        out.push({
          kind,
          price,
          times: [a.time, b.time],
          text:
            `${pyFloat(price)} 附近有等${kind === "high" ? "高" : "低"}` +
            `(${a.time} / ${b.time}),该价位${kind === "high" ? "上" : "下"}方大概率堆着流动性`,
        });
      }
    }
  }
  return out.slice(-3);
}

// ---------------------------------------------------------------- K 线形态
/** 只看最后几根:形态是即时信息。 */
export function detectPatterns(
  bars: PABar[], atrValue: number, count = 4,
): PaPattern[] {
  const out: PaPattern[] = [];
  for (let i = Math.max(1, bars.length - count); i < bars.length; i++) {
    const bar = bars[i]!;
    const prev = bars[i - 1]!;
    const sp = span(bar);
    if (sp <= 0) continue;
    const bd = body(bar);
    const upper = bar.high - Math.max(bar.close, bar.open);
    const lower = Math.min(bar.close, bar.open) - bar.low;
    const hits: Array<[string, string, string]> = [];

    if (bd <= sp * 0.1) hits.push(["十字星", "neutral", "开收几乎同价,多空拉锯"]);
    // 影线按振幅折算,不按实体
    if (lower >= sp * 0.5 && upper <= sp * 0.2 && bd <= sp * 0.4) {
      hits.push(["长下影(锤子)", "bull", "下方被买回,卖压在低位被吸收"]);
    }
    if (upper >= sp * 0.5 && lower <= sp * 0.2 && bd <= sp * 0.4) {
      hits.push(["长上影(射击之星)", "bear", "上冲被打回,高位有抛压"]);
    }
    if (bullish(bar) && !bullish(prev) && bar.close >= prev.open && bar.open <= prev.close) {
      hits.push(["看涨吞没", "bull", "阳线整根吞掉前一根阴线实体"]);
    }
    if (!bullish(bar) && bullish(prev) && bar.close <= prev.open && bar.open >= prev.close) {
      hits.push(["看跌吞没", "bear", "阴线整根吞掉前一根阳线实体"]);
    }
    if (bar.high < prev.high && bar.low > prev.low) {
      hits.push(["内包(inside bar)", "neutral", "波动收敛,等一次突破定方向"]);
    }
    if (bar.high > prev.high && bar.low < prev.low) {
      hits.push(["外包(outside bar)", "neutral", "上下两边流动性都被扫,以收盘为准"]);
    }
    if (atrValue > 0 && bd >= sp * 0.7 && sp >= atrValue * 1.2) {
      hits.push(["大实体推动", bullish(bar) ? "bull" : "bear", "单根振幅超过 1.2 倍 ATR 的方向性推动"]);
    }

    for (const [name, direction, note] of hits) {
      out.push({ name, direction, note, time: bar.time, bars_ago: bars.length - 1 - i });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 环境
export function marketContext(bars: PABar[], atrValue: number): PaContext {
  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1]!;
  // 一路往上加:ema / 区间 / 量能 / 当日各自够数据才给,所以内部保持松,返回处认成契约类型
  const out: Record<string, unknown> = {
    last: pyRound(last, 4),
    atr: pyRound(atrValue, 4),
    atr_pct: last ? pyRound((atrValue / last) * 100.0, 2) : null,
    change_pct: closes[0] ? pyRound((last / closes[0]! - 1.0) * 100.0, 2) : null,
  };

  const ema20 = closes.length >= 20 ? ema(closes, 20)[closes.length - 1] : null;
  const ema50 = closes.length >= 50 ? ema(closes, 50)[closes.length - 1] : null;
  if (ema20) {
    out["ema20"] = pyRound(ema20, 4);
    out["vs_ema20_pct"] = pyRound((last / ema20 - 1.0) * 100.0, 2);
  }
  if (ema20 && ema50) {
    out["ema50"] = pyRound(ema50, 4);
    out["ema_stack"] = ema20 > ema50 ? "多头排列" : "空头排列";
  }

  const window = Math.min(bars.length, 60);
  const tail = bars.slice(-window);
  const hi = Math.max(...tail.map((b) => b.high));
  const lo = Math.min(...tail.map((b) => b.low));
  out["range_high"] = pyRound(hi, 4);
  out["range_low"] = pyRound(lo, 4);
  out["range_bars"] = window;
  out["range_pos_pct"] = hi > lo ? pyRound(((last - lo) / (hi - lo)) * 100.0, 1) : null;

  const vols = bars.filter((b) => b.volume > 0).map((b) => b.volume);
  if (vols.length >= 10 && bars[bars.length - 1]!.volume > 0) {
    const tailVols = vols.slice(-20);
    const avg = tailVols.reduce((a, b) => a + b, 0) / tailVols.length;
    out["rel_volume"] = avg ? pyRound(bars[bars.length - 1]!.volume / avg, 2) : null;
  }

  const day = bars[bars.length - 1]!.time.slice(0, 10);
  const todays = bars.filter((b) => b.time.slice(0, 10) === day);
  if (todays.length >= 2) {
    out["session"] = {
      date: day,
      bars: todays.length,
      open: pyRound(todays[0]!.open, 4),
      high: pyRound(Math.max(...todays.map((b) => b.high)), 4),
      low: pyRound(Math.min(...todays.map((b) => b.low)), 4),
    };
  }
  return out as unknown as PaContext;
}

// ---------------------------------------------------------------- 打分
type EvidenceGroup = PaEvidence["group"];

/** 三个子分各管哪几条依据、全部同向时能到多少。结构:摆动结构 + 最近一次结构事件 + 均线排列;
 *  位置:区间位置 + 贴近关键位;确认:扫单 + 近端形态 + 量能。只是把同一张权重表分开摆,没有新的权重。 */
const SUB_SCORES: Array<{ key: EvidenceGroup; label: string; max: number }> = [
  { key: "structure", label: "结构", max: W.trend + Math.max(W.choch, W.bos) + W.ema },
  { key: "location", label: "位置", max: W.position + W.level },
  { key: "confirm", label: "确认", max: W.sweep + W.pattern + W.volume },
];

/** 把打分表按子分分开加。三个数并排看:位置好不能抵掉结构坏。子分不夹:三个加起来可以超过 ±100,总分才夹在 ±100 之内。 */
export function subScores(evidence: PaEvidence[]): PaSubScore[] {
  return SUB_SCORES.map(({ key, label, max }) => {
    const items = evidence.filter((e) => e.group === key);
    return {
      key,
      label,
      score: pyRound(items.reduce((acc, e) => acc + e.weight, 0), 1),
      max,
      mixed: items.some((e) => e.weight > 0) && items.some((e) => e.weight < 0),
    };
  });
}

/** 打分只看已收盘的 K 线:bars 的最后一根就是最后一根收盘的。 */
function score(
  trend: { trend: string; label: string },
  events: PAEvent[],
  ctx: PaContext,
  sweeps: PaSweep[],
  patterns: PaPattern[],
  levels: PaLevel[],
  atrValue: number,
  lastBar: PABar,
): [number, PaEvidence[]] {
  const last = lastBar.close;
  const evidence: PaEvidence[] = [];
  const add = (group: EvidenceGroup, label: string, detail: string, weight: number) =>
    evidence.push({ group, label, detail, weight: pyRound(weight, 1) });

  if (trend.trend === "up") add("structure", "摆动结构", trend.label, W.trend);
  else if (trend.trend === "down") add("structure", "摆动结构", trend.label, -W.trend);
  else add("structure", "摆动结构", trend.label, 0.0);

  if (events.length) {
    const latest = events[events.length - 1]!;
    const sign = latest["direction"] === "up" ? 1.0 : -1.0;
    const weight = latest["kind"] === "CHoCH" ? W.choch : W.bos;
    add("structure", "最近一次结构事件", latest["text"] as string, sign * weight);
  }

  const pos = ctx["range_pos_pct"] as number | null | undefined;
  if (pos !== null && pos !== undefined) {
    add(
      "location",
      "区间位置",
      `收盘位于近 ${ctx["range_bars"]} 根区间的 ${fmtF(pos, 0)}%` +
      `(${pyFloat(ctx["range_low"] as number)} ~ ${pyFloat(ctx["range_high"] as number)})`,
      (pos / 50.0 - 1.0) * W.position,
    );
  }

  if (ctx["ema_stack"]) {
    const bullishStack = ctx["ema_stack"] === "多头排列";
    add(
      "structure",
      "均线动能",
      `EMA20 ${bullishStack ? "在上" : "在下"} EMA50(${ctx["ema_stack"]}),` +
      `收盘相对 EMA20 ${fmtSF((ctx["vs_ema20_pct"] as number) || 0.0, 2)}%`,
      W.ema * (bullishStack ? 1.0 : -1.0),
    );
  }

  if (sweeps.length) {
    const latestSweep = sweeps[sweeps.length - 1]!;
    add(
      "confirm",
      "流动性扫单",
      latestSweep["text"] as string,
      W.sweep * (latestSweep["direction"] === "bull" ? 1.0 : -1.0),
    );
  }

  const directional = patterns.filter((p) => p["direction"] === "bull" || p["direction"] === "bear");
  if (directional.length) {
    const newest = Math.min(...directional.map((p) => p["bars_ago"] as number));
    const fresh = directional.filter((p) => p["bars_ago"] === newest);
    const net = fresh.reduce((acc, p) => acc + (p["direction"] === "bull" ? 1 : -1), 0);
    if (net) {
      add(
        "confirm",
        "近端形态",
        `${fresh.map((p) => p["name"]).join("、")}(${newest} 根之前)`,
        W.pattern * (net > 0 ? 1.0 : -1.0),
      );
    }
  }

  if (atrValue > 0 && levels.length) {
    let near = levels[0]!;
    for (const l of levels) {
      if (Math.abs((l["price"] as number) - last) < Math.abs((near["price"] as number) - last)) {
        near = l;
      }
    }
    if (Math.abs((near["price"] as number) - last) <= atrValue * 0.35) {
      const atResistance = near["side"] === "resistance";
      add(
        "location",
        "贴近关键位",
        `收盘紧贴${atResistance ? "阻力" : "支撑"} ${pyFloat(near["price"] as number)}` +
        `(${near["touches"]} 次触碰)`,
        atResistance ? -W.level : W.level,
      );
    }
  }

  // 放量算谁的,看放量的那一根自己收阳还是收阴;不看它在均线哪一边(那是「均线动能」已经算过的事)
  const rel = ctx["rel_volume"] as number | null | undefined;
  if (rel !== null && rel !== undefined && rel >= 1.5) {
    const sign = lastBar.close > lastBar.open ? 1.0 : lastBar.close < lastBar.open ? -1.0 : 0.0;
    add(
      "confirm",
      "量能",
      `最后一根收盘的 K 线量能是近 20 根均量的 ${fmtF(rel, 2)} 倍,这一根` +
      `${sign > 0 ? "收阳" : sign < 0 ? "收阴" : "开收同价,不记方向"}`,
      W.volume * sign,
    );
  }

  const total = evidence.reduce((acc, e) => acc + (e["weight"] as number), 0);
  return [Math.max(-100.0, Math.min(100.0, total)), evidence];
}

export function biasOf(scoreValue: number): { bias: string; label: string } {
  if (scoreValue >= 45) return { bias: "bullish", label: "看涨" };
  if (scoreValue >= 18) return { bias: "lean_bull", label: "偏多" };
  if (scoreValue <= -45) return { bias: "bearish", label: "看跌" };
  if (scoreValue <= -18) return { bias: "lean_bear", label: "偏空" };
  return { bias: "neutral", label: "中性 / 观望" };
}

// ---------------------------------------------------------------- 总装
/** 收盘价简单均线,与 result.bars(最后 count 根)逐根对齐;历史不够一个周期处为 null。
 *  显式切片求和(与 Python 版同一加法顺序),再 pyRound 4 位,保证两侧逐字节一致。 */
export function movingAverages(
  bars: readonly PABar[], periods: readonly number[] = MA_PERIODS, count: number = CHART_BARS,
): Record<string, Array<number | null>> {
  const closes = bars.map((b) => b.close);
  const start = Math.max(0, closes.length - count);
  const out: Record<string, Array<number | null>> = {};
  for (const period of periods) {
    const series: Array<number | null> = [];
    for (let i = start; i < closes.length; i += 1) {
      if (i + 1 < period) {
        series.push(null);
      } else {
        let total = 0;
        for (let j = i + 1 - period; j <= i; j += 1) total += closes[j]!;
        series.push(pyRound(total / period, 4));
      }
    }
    out[String(period)] = series;
  }
  return out;
}

/** 调用方给的时刻,以及它对这组 K 线知道的三件事(都只影响「最后一根收没收盘」):
 *  · barsAsOfMs:这组 K 线是什么时候从券商取的。缓存里拿出来的一份早于 epochMs:取的时候最后一根没走完,
 *    现在钟点过了它也还是半根,所以收没收盘对着它判;不给就当成刚取的。
 *  · feed:出自哪一档行情(券商给的)。delayed = 延迟档,数据本身的时刻比取数时刻最多晚 DELAYED_FEED_MAX_MS,
 *    钟点到了数据未必到齐,所以再往前退这么多;unknown = 券商说不准,按延迟对待;live 或不给 = 只看钟点。
 *  · extendedSession:这个标的有没有盘前盘后(日线几点走完用)。不给就跟 extendedHours 走;指数没有,给 false。 */
export interface PaClock {
  epochMs: number;
  barsAsOfMs?: number;
  feed?: BarsFeed;
  extendedSession?: boolean;
}

interface Split {
  bars: PABar[];
  /** 没进判定的那一根;最后一根已收盘是 null */
  open: PABar | null;
  /** 最新一根按钟点几点走完 */
  closesAt: number | null;
  /** 钟点到了却仍没让它进判定的原因(延迟档 / 说不准);钟点没到是 null */
  waiting: PaForming["waiting"];
}

/** 把最后一根没走完的摘出来。不给 now = 这是一段历史切片,全部按已收盘;
 *  给了 now 但算不出最后一根几点走完(周期不认识、时间戳读不懂),拿不准就不让它进判定。 */
function splitForming(all: PABar[], timeframe: string, clock: PaClock | null, extendedHours: boolean): Split {
  const newest = all[all.length - 1];
  if (clock === null || newest === undefined) return { bars: all, open: null, closesAt: null, waiting: null };
  const closesAt = barCloseEpochMs(newest.time, timeframe, clock.extendedSession ?? extendedHours);
  const asOf = clock.barsAsOfMs ?? clock.epochMs;
  const lagging = clock.feed === "delayed" || clock.feed === "unknown" ? clock.feed : null;
  const dataAsOf = asOf - (lagging ? DELAYED_FEED_MAX_MS : 0);
  if (closesAt !== null && closesAt <= dataAsOf) return { bars: all, open: null, closesAt, waiting: null };
  const waiting = closesAt !== null && closesAt <= asOf ? lagging : null;
  return { bars: all.slice(0, -1), open: newest, closesAt, waiting };
}

/** 正在形成的那一根:把它当成已经收盘再走一遍同一套规则,落在它身上的突破 / 扫单就是「若此刻收盘会成立的」。只作提示。 */
function formingBar(all: PABar[], split: Split & { open: PABar }, strength: number): PaForming {
  const { open, closesAt, waiting } = split;
  const atrs = atrSeries(all);
  const live = structureHistory(all, (i) => tolOf(atrs[i] ?? 0.0, all[i]!.close), strength);
  const index = all.length - 1;
  const hints: string[] = [];
  for (const event of live.events) {
    if (event.index !== index) continue;
    const up = event.direction === "up";
    hints.push(
      `若此刻收盘会记一次 ${event.kind}:现价 ${pyFloat(event.close)} 在前${up ? "高" : "低"} ` +
      `${pyFloat(event.level)} 之${up ? "上" : "下"}`,
    );
  }
  for (const sweep of live.sweeps) {
    if (sweep.index !== index) continue;
    const bear = sweep.direction === "bear";
    hints.push(
      `若此刻收盘会记一次扫单:影线${bear ? "上破前高" : "下破前低"} ${pyFloat(sweep.level)},` +
      `现价回到了它${bear ? "下" : "上"}方`,
    );
  }
  return {
    time: open.time,
    closes_at: closesAt === null ? null : stampAt(closesAt, ET),
    waiting,
    open: open.open, high: open.high, low: open.low, close: open.close, volume: open.volume,
    hints,
  };
}

/** 一段 K 线 → 完整 PA 读盘结果。纯函数:现在几点由 now 给(epoch 毫秒,或带上这组 K 线取数时刻的 PaClock)。 */
export function analyze(
  rows: Array<Record<string, unknown>>,
  symbol = "",
  timeframe = "",
  strength = SWING_STRENGTH,
  now: PaClock | number | null = null,
  extendedHours = false,
): PaAnalysis {
  const all = toBars(rows);
  const clock = typeof now === "number" ? { epochMs: now } : now;
  const split = splitForming(all, timeframe, clock, extendedHours);
  const { bars, open } = split;
  if (bars.length < MIN_BARS) {
    throw new PriceActionError(
      `只有 ${bars.length} 根${open ? "已收盘的" : ""} K 线,不足以读出结构(至少需要 ${MIN_BARS} 根)。` +
      "换个更长的周期试试;如果这是刚开盘、K 线还在一根根长出来,过一会儿再看。",
    );
  }

  // 从这里往下,bars 全是已收盘的:最后一根就是判定算到的那一根
  const lastBar = bars[bars.length - 1]!;
  const atrs = atrSeries(bars);
  const atrValue = atrs[atrs.length - 1] ?? 0.0;
  const last = lastBar.close;
  const tol = tolOf(atrValue, last);

  const history = structureHistory(bars, (i) => tolOf(atrs[i] ?? 0.0, bars[i]!.close), strength);
  const points = labelSwings(history.points);
  const trend = readTrend(points);
  const { events, sweeps } = history;
  const levels = clusterLevels(bars, points, tol, last);
  const gaps = findFvgs(bars, tol);
  const patterns = detectPatterns(bars, atrValue);
  const ctx = marketContext(bars, atrValue);
  const block = orderBlock(bars, events.length ? events[events.length - 1]! : null);
  const equals = equalLevels(points, tol);

  const [scoreValue, evidence] = score(trend, events, ctx, sweeps, patterns, levels, atrValue, lastBar);
  const bias = biasOf(scoreValue);
  const newest = all[all.length - 1]!;

  // 最后四项(age_seconds / extended_hours / warnings / readout)要等前面都算完才能填,所以这里先松着,返回处认成契约类型
  const result: Record<string, any> = {
    symbol,
    timeframe,
    timeframe_label: (TIMEFRAMES[timeframe]?.["label"] as string) ?? timeframe,
    bar_count: bars.length,
    first_bar: bars[0]!.time,
    last_bar: newest.time,
    closed_bar: lastBar.time,
    forming: open ? formingBar(all, { ...split, open }, strength) : null,
    last: pyRound(newest.close, 4),
    atr: pyRound(atrValue, 4),
    swing_strength: strength,
    score: pyRound(scoreValue, 1),
    bias: bias.bias,
    bias_label: bias.label,
    confidence: pyRound(Math.min(Math.abs(scoreValue) / 70.0, 1.0), 2),
    trend: trend.trend,
    trend_label: trend.label,
    swings: points.slice(-10).map(swingDict),
    events,
    levels,
    fvgs: gaps,
    order_block: block,
    sweeps,
    equal_levels: equals,
    patterns,
    context: ctx,
    evidence,
    sub_scores: subScores(evidence),
    plan: makePlan(bias.bias, points, levels, gaps, block, atrValue, ctx),
    // 图照旧画到最新一根:正在形成的那一根也在里面,均线跟着它走(只作图)
    bars: all.slice(-CHART_BARS).map((b) => ({
      time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    })),
    ma: movingAverages(all),
  };
  result["extended_hours"] = extendedHours;
  result["warnings"] = makeWarnings(result, clock, split.closesAt, extendedHours);
  result["readout"] = makeReadout(result);
  return result as PaAnalysis;
}

function makePlan(
  bias: string,
  points: Swing[],
  levels: PaLevel[],
  gaps: PaFvg[],
  block: PaOrderBlock | null,
  atrValue: number,
  ctx: PaContext,
): PaPlan {
  const resistance = levels.find((l) => l["side"] === "resistance") ?? null;
  const support = [...levels].reverse().find((l) => l["side"] === "support") ?? null;
  const lastLow = [...points].reverse().find((s) => s.kind === "low") ?? null;
  const lastHigh = [...points].reverse().find((s) => s.kind === "high") ?? null;

  const isBull = bias === "bullish" || bias === "lean_bull";
  const isBear = bias === "bearish" || bias === "lean_bear";

  // 一路往上加(确认 / 失效 / ATR 备注各自看情况给),内部保持松,返回处认成契约类型
  const plan: Record<string, any> = { resistance, support, watch: [] };

  if (isBull && resistance) {
    plan["confirm"] =
      `收盘站上 ${pyFloat(resistance["price"] as number)}(最近阻力,${resistance["touches"]} 次触碰)` +
      "才算突破成立;只有影线穿过按扫单处理";
  } else if (isBull) {
    plan["confirm"] =
      `上方在这段样本里没有留下前高:收盘已是近 ${ctx["range_bars"] ?? 0} 根的高位` +
      `(区间上沿 ${pyFloat(ctx["range_high"] as number)}),` +
      "没有可参照的突破确认位,追高缺少结构依据";
  } else if (isBear && support) {
    plan["confirm"] =
      `收盘跌破 ${pyFloat(support["price"] as number)}(最近支撑,${support["touches"]} 次触碰)` +
      "才算破位成立;只有影线穿过按扫单处理";
  } else if (isBear) {
    plan["confirm"] =
      `下方在这段样本里没有留下前低:收盘已是近 ${ctx["range_bars"] ?? 0} 根的低位` +
      `(区间下沿 ${pyFloat(ctx["range_low"] as number)}),` +
      "没有可参照的破位确认位";
  } else {
    const edges = [support, resistance].filter(Boolean).map((l) => pyFloat(l!["price"] as number));
    plan["confirm"] =
      edges.length === 2
        ? `区间 ${edges.join(" ~ ")} 之间来回,等某一端收盘突破再谈方向`
        : "结构未成形,等一次明确的收盘突破";
  }

  if (isBull && lastLow) {
    plan["invalidation"] = {
      price: pyRound(lastLow.price, 4),
      why:
        `跌破最近摆动低点 ${pyFloat(pyRound(lastLow.price, 4))}(${lastLow.time})` +
        "则上升结构被破坏,看涨前提失效",
    };
  } else if (isBear && lastHigh) {
    plan["invalidation"] = {
      price: pyRound(lastHigh.price, 4),
      why:
        `站上最近摆动高点 ${pyFloat(pyRound(lastHigh.price, 4))}(${lastHigh.time})` +
        "则下降结构被破坏,看跌前提失效",
    };
  } else if (lastLow && lastHigh) {
    plan["invalidation"] = {
      price: null,
      why:
        `震荡中没有单一失效位;${pyFloat(pyRound(lastLow.price, 4))} 与 ` +
        `${pyFloat(pyRound(lastHigh.price, 4))} 是这段区间的上下沿`,
    };
  }

  const want = isBull ? "bull" : isBear ? "bear" : null;
  if (want) {
    for (const gap of [...gaps].reverse()) {
      if (gap["side"] === want) {
        plan["watch"].push(
          `未回补 FVG ${pyFloat(gap["bottom"] as number)} ~ ${pyFloat(gap["top"] as number)}` +
          `(${gap["time"]} 留下,已回补 ${fmtF(gap["filled_pct"] as number, 0)}%)` +
          "——回踩到这里是顺势的观察点",
        );
        break;
      }
    }
    if (block && block["side"] === want && !block["mitigated"]) {
      plan["watch"].push(
        `订单块 ${pyFloat(block["bottom"] as number)} ~ ${pyFloat(block["top"] as number)}` +
        `(${block["time"]} 那根),尚未被回踩`,
      );
    }
    const near = isBull ? support : resistance;
    if (near) {
      plan["watch"].push(
        `关键位 ${pyFloat(near["price"] as number)}(${near["touches"]} 次触碰,` +
        `距收盘 ${fmtSF(near["distance_pct"] as number, 2)}%)`,
      );
    }
  }
  if (atrValue > 0) {
    plan["atr_note"] =
      `当前 ATR ${pyFloat(pyRound(atrValue, 4))}:小于这个幅度的价差属于日常噪音,别当成突破`;
  }
  return plan as PaPlan;
}

function makeWarnings(
  result: Record<string, any>, clock: PaClock | null, closesAt: number | null, extendedHours = false,
): string[] {
  const nowEpochMs = clock?.epochMs ?? null;
  const out: string[] = [];
  if (clock?.feed === "delayed") {
    out.push(
      "行情是延迟的:券商给的是 15–20 分钟前的数据,现价与最新一根都不是此刻的;" +
      "判定只算到数据确定到齐的那一根。",
    );
  }
  if (extendedHours) {
    out.push(
      "含盘前盘后:那几段成交稀薄,ATR 会偏小、摆动点会偏碎," +
      "跨隔夜的「缺口」多半只是没人交易,不是真跳空。",
    );
  }
  if (result["bar_count"] < 60) {
    out.push(`样本只有 ${result["bar_count"]} 根 K 线,摆动结构的可靠性有限。`);
  }
  if (result["trend"] === "range" || result["trend"] === "unknown") {
    out.push("结构未成形:震荡里做方向判断,胜率天然低于顺势。");
  }
  if (Math.abs(result["score"]) < 18) {
    out.push("多空证据接近抵消,这是「看不清」,不是「该进场」。");
  }
  const ctx = result["context"];
  if (ctx["atr_pct"] !== null && ctx["atr_pct"] !== undefined && ctx["atr_pct"] < 0.05) {
    out.push(`波动率极低(ATR 仅占价格 ${fmtF(ctx["atr_pct"], 2)}%),形态信号大概率是噪音。`);
  }

  const age = barAgeSeconds(result["last_bar"], nowEpochMs);
  if (age !== null && nowEpochMs !== null) {
    result["age_seconds"] = Math.trunc(age);
    // 「行情停了」从最新一根走完那一刻起算:它还在走的时候,起点离现在多远都不说明什么。
    // 日线不报这一条:走完之后隔一夜才有下一根,半小时没有新 K 线是常态。
    const daily = Number(TIMEFRAMES[result["timeframe"]]?.["seconds"]) >= 86_400;
    const idle = closesAt === null ? age : (nowEpochMs - closesAt) / 1000.0;
    if (!daily && idle > 1800) {
      out.push(
        (closesAt === null
          ? `最后一根 K 线停在 ${result["last_bar"]},距现在 ${Math.trunc(age / 60)} 分钟`
          : `最后一根 K 线(${result["last_bar"]})走完之后已经 ${Math.trunc(idle / 60)} 分钟没有新的 K 线`) +
        "——可能是休市,也可能是行情延迟或订阅缺失。",
      );
    }
  }
  return out;
}

/** K 线时间戳按美东墙钟解释;nowEpochMs 也换算成美东墙钟秒数后相减,
 * 与 Python 的 naive-stamp-replace-tzinfo 语义一致。 */
export function barAgeSeconds(lastBar: string, nowEpochMs: number | null): number | null {
  if (nowEpochMs === null) return null;
  const stamp = parseBarTime(lastBar);
  if (stamp === null) return null;
  // Python: stamp.replace(tzinfo=now.tzinfo) → 把 K 线时间当成 now 所在时区(ET)的墙钟
  // 这里从 nowEpochMs 反推 ET 墙钟,再做墙钟差。
  return (nowEpochMs - etWallToEpochMs(stamp)) / 1000.0;
}

function etWallToEpochMs(p: {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
}): number {
  return wallToEpoch(p, ET);
}

export function parseBarTime(
  raw: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } | null {
  let m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (m) {
    return {
      year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]!, second: +m[6]!,
    };
  }
  m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(raw);
  if (m) {
    return { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]!, second: 0 };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (m) return { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: 0, minute: 0, second: 0 };
  return null;
}

function makeReadout(result: Record<string, any>): string[] {
  const ctx = result["context"];
  const lines = [
    `${result["symbol"] || "标的"} ${result["timeframe_label"]}:现价 ${pyFloat(result["last"])},` +
    `${result["bias_label"]}(打分 ${fmtSF(result["score"], 0)}/100)。`,
    `结构:${result["trend_label"]}。`,
  ];
  if (result["events"].length) {
    lines.push(`最近结构事件:${result["events"][result["events"].length - 1]["text"]}。`);
  }
  if (result["swings"].length) {
    lines.push(
      `近端摆动序列:${result["swings"].slice(-5).map((s: any) => s["label"]).join("→")}。`,
    );
  }
  if (ctx["range_pos_pct"] !== null && ctx["range_pos_pct"] !== undefined) {
    lines.push(
      `位置:近 ${ctx["range_bars"]} 根区间 ${pyFloat(ctx["range_low"])} ~ ` +
      `${pyFloat(ctx["range_high"])},收盘落在 ${fmtF(ctx["range_pos_pct"], 0)}% 处。`,
    );
  }
  if (result["sweeps"].length) {
    lines.push(`流动性:${result["sweeps"][result["sweeps"].length - 1]["text"]}。`);
  }
  const fresh = result["patterns"].filter((p: any) => p["bars_ago"] <= 1);
  if (fresh.length) {
    lines.push(
      `近端形态:${fresh.slice(0, 3).map((p: any) => `${p["name"]}(${p["note"]})`).join("、")}。`,
    );
  }
  const plan = result["plan"];
  if (plan["confirm"]) lines.push(`确认条件:${plan["confirm"]}。`);
  if (plan["invalidation"]?.["why"]) lines.push(`失效条件:${plan["invalidation"]["why"]}。`);
  return lines;
}

/** 把分析结果拼成给模型看的事实块。只放算好的数字与结论,不放原始 K 线。 */
/** 事实块给模型看。会读 htf / agreement,但那两项是 handler 补的:单独拿一份分析来拼也行(黄金对拍就是这么用的)。 */
export function factsText(result: PaAnalysis & Partial<Pick<PaAnalyzeResult, "htf" | "agreement">>): string {
  const ctx = result["context"] ?? {};
  const plan = result["plan"] ?? {};
  const forming = result["forming"] ?? null;
  const lines: string[] = [
    `标的:${result["symbol"] || "-"};周期:${result["timeframe_label"] || "-"};` +
    `${forming ? "已收盘 " : ""}K 线 ${result["bar_count"] ?? 0} 根,` +
    `最后一根 ${result["closed_bar"] || result["last_bar"] || "-"};` +
    `现价 ${pyFloat(result["last"])};ATR ${pyFloat(result["atr"])}。`,
  ];
  if (forming) {
    lines.push(
      (forming["waiting"]
        ? `数据未到齐:${forming["time"]} 那根按钟点 ${forming["closes_at"]} 已经走完,但` +
          `${forming["waiting"] === "delayed" ? "行情是延迟的" : "还说不准行情是不是延迟的"}` +
          "(延迟档晚 15–20 分钟),它的数据可能还没到齐,先当作没走完;现价取自它。"
        : `正在形成:${forming["time"]} 那根还没收盘` +
          `${forming["closes_at"] ? `(${forming["closes_at"]} 收盘)` : ""},现价取自它。`) +
      "下面的判定全部只算到已收盘的那一根,这一根只作提示。",
    );
    for (const hint of forming["hints"] ?? []) lines.push(`未确认:${hint}(收盘之前不算数)。`);
  }
  lines.push(
    `软件判定:${result["bias_label"]}(打分 ${fmtSF(result["score"] ?? 0.0, 0)}/100);` +
    `结构:${result["trend_label"]}。`,
  );
  const subs = result["sub_scores"] ?? [];
  if (subs.length) {
    lines.push(
      `子分(各自相加,互不抵消):${subs
        .map((sub) => `${sub["label"]} ${sub["score"] > 0 ? "+" : ""}${sub["score"]}/${sub["max"]}${sub["mixed"] ? "(组内多空都有)" : ""}`)
        .join(";")}。`,
    );
  }
  if (result["swings"]?.length) {
    lines.push(
      `摆动序列(旧→新):${result["swings"]
        .slice(-6)
        .map((s: any) => `${s["label"]}@${pyFloat(s["price"])}`)
        .join("、")}。`,
    );
  }
  for (const event of (result["events"] ?? []).slice(-3)) {
    lines.push(`结构事件:${event["text"]}。`);
  }
  if (result["levels"]?.length) {
    lines.push(
      `关键位:${result["levels"]
        .map(
          (l: any) =>
            `${l["side"] === "resistance" ? "阻力" : "支撑"} ${pyFloat(l["price"])}` +
            `(${l["touches"]} 次触碰,距收盘 ${fmtSF(l["distance_pct"], 2)}%)`,
        )
        .join(";")}。`,
    );
  }
  for (const gap of (result["fvgs"] ?? []).slice(-2)) {
    lines.push(
      `未回补 FVG(${gap["side"] === "bull" ? "看涨" : "看跌"}):` +
      `${pyFloat(gap["bottom"])} ~ ${pyFloat(gap["top"])},${gap["time"]} 留下,` +
      `已回补 ${fmtF(gap["filled_pct"], 0)}%。`,
    );
  }
  const block = result["order_block"];
  if (block) {
    lines.push(
      `订单块(${block["side"] === "bull" ? "看涨" : "看跌"}):` +
      `${pyFloat(block["bottom"])} ~ ${pyFloat(block["top"])},${block["time"]};` +
      `${block["mitigated"] ? "已被回踩" : "尚未回踩"}。`,
    );
  }
  for (const sweep of (result["sweeps"] ?? []).slice(-2)) {
    lines.push(`流动性扫单:${sweep["text"]}。`);
  }
  for (const eq of (result["equal_levels"] ?? []).slice(-2)) {
    lines.push(`等高/等低:${eq["text"]}。`);
  }
  const fresh = (result["patterns"] ?? []).filter((p: any) => p["bars_ago"] <= 2);
  if (fresh.length) {
    lines.push(
      `近端 K 线形态:${fresh
        .map((p: any) => `${p["name"]}(${p["bars_ago"]} 根前,${p["note"]})`)
        .join(";")}。`,
    );
  }
  if (ctx["range_pos_pct"] !== null && ctx["range_pos_pct"] !== undefined) {
    lines.push(
      `区间:近 ${ctx["range_bars"]} 根 ${pyFloat(ctx["range_low"])} ~ ${pyFloat(ctx["range_high"])},` +
      `收盘在 ${fmtF(ctx["range_pos_pct"], 0)}% 处;相对 EMA20 ` +
      `${ctx["vs_ema20_pct"] !== undefined ? pyFloat(ctx["vs_ema20_pct"]) : "None"}%;` +
      `${ctx["ema_stack"] || "均线数据不足"}。`,
    );
  }
  if (ctx["rel_volume"] !== null && ctx["rel_volume"] !== undefined) {
    lines.push(`量能:最后一根收盘的 K 线是近 20 根均量的 ${fmtF(ctx["rel_volume"], 2)} 倍。`);
  }
  if (ctx["session"]) {
    const session = ctx["session"];
    lines.push(
      `当日(${session["date"]}):开 ${pyFloat(session["open"])},高 ${pyFloat(session["high"])},` +
      `低 ${pyFloat(session["low"])},已走 ${session["bars"]} 根。`,
    );
  }
  const higher = result["htf"];
  if (higher) {
    const sup = higher["support"];
    const res = higher["resistance"];
    lines.push(
      `高周期(${higher["timeframe_label"]},算到 ${higher["closed_bar"] || "-"} 那根收盘):` +
      `${higher["bias_label"]},${higher["trend_label"]};` +
      `支撑 ${sup !== null && sup !== undefined ? pyFloat(sup) : "该样本内无"} / ` +
      `阻力 ${res !== null && res !== undefined ? pyFloat(res) : "该样本内无"}。` +
      `${result["agreement"]?.["text"] || ""}`,
    );
  }
  if (plan["confirm"]) lines.push(`软件给的确认条件:${plan["confirm"]}。`);
  if (plan["invalidation"]?.["why"]) lines.push(`软件给的失效条件:${plan["invalidation"]["why"]}。`);
  for (const note of result["warnings"] ?? []) {
    lines.push(`软件警告:${note}`);
  }
  lines.push("以上全部由软件按 K 线算出。请只解读,不要新造价格。");
  return lines.join("\n");
}

/** 高周期只取方向与关键位。 */
export function htfSummary(result: PaAnalysis): PaHtfSummary {
  const plan = result["plan"] ?? {};
  return {
    timeframe: result["timeframe"],
    timeframe_label: result["timeframe_label"],
    bias: result["bias"],
    bias_label: result["bias_label"],
    score: result["score"],
    trend_label: result["trend_label"],
    last_event: (result["events"]?.length
      ? result["events"][result["events"].length - 1]!["text"]
      : null) ?? null,
    resistance: plan["resistance"]?.["price"] ?? null,
    support: plan["support"]?.["price"] ?? null,
    closed_bar: result["closed_bar"],
  };
}

/** 低周期与高周期是否同向。 */
export function agreement(
  primary: PaAnalysis, higher: PaHtfSummary | null,
): PaAgreement {
  if (!higher) return { state: "unknown", text: "没有高周期数据可对照。" };

  const sign = (bias: string): number => {
    if (bias === "bullish" || bias === "lean_bull") return 1;
    if (bias === "bearish" || bias === "lean_bear") return -1;
    return 0;
  };

  const a = sign(primary["bias"]);
  const b = sign(higher["bias"] as string);
  if (b === 0) {
    return {
      state: "unclear",
      text: `${higher["timeframe_label"]} 方向不明,低周期信号缺少高周期背书。`,
    };
  }
  if (a === 0) {
    // 不明的是本周期自己:别把这句话安到高周期头上
    return {
      state: "unclear",
      text: `本周期自己方向不明,谈不上顺势逆势;${higher["timeframe_label"]} 是${higher["bias_label"]}。`,
    };
  }
  if (a === b) {
    return {
      state: "aligned",
      text: `与 ${higher["timeframe_label"]}(${higher["bias_label"]})同向,属于顺势。`,
    };
  }
  return {
    state: "conflict",
    text:
      `与 ${higher["timeframe_label"]}(${higher["bias_label"]})相反,属于逆势` +
      "——这类信号更容易被打回。",
  };
}
