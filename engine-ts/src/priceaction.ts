/** 价格行为(Price Action)实时分析(对应 Python priceaction.py)——纯计算。
 *
 * 数字由代码算,叙事才交给 LLM。突破一律用收盘价确认;影线穿透归「扫单」。
 * 打分权重全部摆在模块顶部,结论怎么来的必须能被逐条质疑。
 * 所有中文 readout / facts 字符串与 Python 版逐字节一致(浮点走 pyFloat)。
 */
import { ema } from "./backtest.js";
import { fmtF, fmtSF, pyFloat, pyRound } from "./py.js";

export class PriceActionError extends Error {}

export const TIMEFRAMES: Record<string, Record<string, unknown>> = {
  "1m": { bar_size: "1 min", duration: "2 D", fallback: "4 D", seconds: 60, label: "1 分钟", htf: "15m" },
  "2m": { bar_size: "2 mins", duration: "3 D", fallback: "6 D", seconds: 120, label: "2 分钟", htf: "30m" },
  "5m": { bar_size: "5 mins", duration: "5 D", fallback: "10 D", seconds: 300, label: "5 分钟", htf: "1h" },
  "15m": { bar_size: "15 mins", duration: "10 D", fallback: "20 D", seconds: 900, label: "15 分钟", htf: "1h" },
  "30m": { bar_size: "30 mins", duration: "15 D", fallback: "30 D", seconds: 1800, label: "30 分钟", htf: "1d" },
  "1h": { bar_size: "1 hour", duration: "30 D", fallback: "60 D", seconds: 3600, label: "1 小时", htf: "1d" },
  "1d": { bar_size: "1 day", duration: "1 Y", fallback: "2 Y", seconds: 86400, label: "日线", htf: null },
};

export const MIN_BARS = 30;
export const SWING_STRENGTH = 2;
export const CHART_BARS = 140;
/** 图上叠的均线周期(富途默认那三条);只作图,不进打分。 */
export const MA_PERIODS = [5, 10, 20];

// 打分权重。正 = 看涨,负 = 看跌。
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

function swingDict(s: Swing): Record<string, unknown> {
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

export function atr(bars: PABar[], period = 14): number {
  if (bars.length < 2) return 0.0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) trs.push(trueRange(bars[i]!, bars[i - 1]!));
  const tail = trs.slice(-period);
  return tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0.0;
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

/** 整理成严格高低交替:相邻同向只留更极端的那个。 */
export function zigzag(swings: Swing[]): Swing[] {
  const out: Swing[] = [];
  for (const swing of swings) {
    if (!out.length) {
      out.push(swing);
      continue;
    }
    const last = out[out.length - 1]!;
    if (last.kind !== swing.kind) {
      out.push(swing);
    } else if (swing.kind === "high" ? swing.price > last.price : swing.price < last.price) {
      out[out.length - 1] = swing;
    }
  }
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

export type PAEvent = Record<string, unknown>;

/** 顺时间推进找收盘突破:同向记 BOS,反向记 CHoCH。 */
export function breakEvents(
  bars: PABar[], points: Swing[], strength = SWING_STRENGTH, keep = 6,
): PAEvent[] {
  const confirmed = new Map<number, Swing[]>();
  for (const swing of points) {
    const at = swing.index + strength;
    if (!confirmed.has(at)) confirmed.set(at, []);
    confirmed.get(at)!.push(swing);
  }

  const events: PAEvent[] = [];
  let direction: string | null = null;
  let pendingHigh: Swing | null = null;
  let pendingLow: Swing | null = null;

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
    for (const swing of confirmed.get(i) ?? []) {
      if (swing.kind === "high" && swing.price > bar.close) pendingHigh = swing;
      else if (swing.kind === "low" && swing.price < bar.close) pendingLow = swing;
    }
  }
  return events.slice(-keep);
}

function makeEvent(kind: string, direction: string, index: number, bar: PABar, swing: Swing): PAEvent {
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
): Array<Record<string, unknown>> {
  const prices = points.map((s) => s.price).sort((a, b) => a - b);
  if (!prices.length || tol <= 0 || !last) return [];

  const clusters: number[][] = [[prices[0]!]];
  for (const price of prices.slice(1)) {
    const lastCluster = clusters[clusters.length - 1]!;
    if (price - lastCluster[lastCluster.length - 1]! <= tol) lastCluster.push(price);
    else clusters.push([price]);
  }

  const levels: Array<Record<string, unknown>> = [];
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
export function findFvgs(bars: PABar[], tol: number, keep = 4): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
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

/** 推动最近一次突破之前的最后一根反向 K 线,以及它是否已被回踩。 */
export function orderBlock(
  bars: PABar[], event: PAEvent | null, lookback = 25,
): Record<string, unknown> | null {
  if (!event) return null;
  const end = event["index"] as number;
  const wantBullish = event["direction"] === "down"; // 下破之前找最后一根阳线
  for (let i = end; i > Math.max(-1, end - lookback); i--) {
    const bar = bars[i]!;
    if (body(bar) > 0 && bullish(bar) === wantBullish) {
      const after = bars.slice(i + 2);
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

/** 影线刺穿前高/前低但收了回来 —— 止损被扫。 */
export function findSweeps(
  bars: PABar[], points: Swing[], tol: number,
  strength = SWING_STRENGTH, window = 40, keep = 3,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let j = Math.max(0, bars.length - window); j < bars.length; j++) {
    const bar = bars[j]!;
    for (const swing of points) {
      if (swing.index + strength >= j || j - swing.index > 60) continue;
      if (swing.kind === "high" && bar.high > swing.price + tol && bar.close < swing.price) {
        out.push(makeSweep("bear", bar, j, swing));
        break;
      }
      if (swing.kind === "low" && bar.low < swing.price - tol && bar.close > swing.price) {
        out.push(makeSweep("bull", bar, j, swing));
        break;
      }
    }
  }
  return out.slice(-keep);
}

function makeSweep(direction: string, bar: PABar, index: number, swing: Swing): Record<string, unknown> {
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
export function equalLevels(points: Swing[], tol: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
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
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
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
export function marketContext(bars: PABar[], atrValue: number): Record<string, unknown> {
  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1]!;
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
  return out;
}

// ---------------------------------------------------------------- 打分
function score(
  trend: { trend: string; label: string },
  events: PAEvent[],
  ctx: Record<string, unknown>,
  sweeps: Array<Record<string, unknown>>,
  patterns: Array<Record<string, unknown>>,
  levels: Array<Record<string, unknown>>,
  atrValue: number,
  last: number,
): [number, Array<Record<string, unknown>>] {
  const evidence: Array<Record<string, unknown>> = [];
  const add = (label: string, detail: string, weight: number) =>
    evidence.push({ label, detail, weight: pyRound(weight, 1) });

  if (trend.trend === "up") add("摆动结构", trend.label, W.trend);
  else if (trend.trend === "down") add("摆动结构", trend.label, -W.trend);
  else add("摆动结构", trend.label, 0.0);

  if (events.length) {
    const latest = events[events.length - 1]!;
    const sign = latest["direction"] === "up" ? 1.0 : -1.0;
    const weight = latest["kind"] === "CHoCH" ? W.choch : W.bos;
    add("最近一次结构事件", latest["text"] as string, sign * weight);
  }

  const pos = ctx["range_pos_pct"] as number | null | undefined;
  if (pos !== null && pos !== undefined) {
    add(
      "区间位置",
      `收盘位于近 ${ctx["range_bars"]} 根区间的 ${fmtF(pos, 0)}%` +
      `(${pyFloat(ctx["range_low"] as number)} ~ ${pyFloat(ctx["range_high"] as number)})`,
      (pos / 50.0 - 1.0) * W.position,
    );
  }

  if (ctx["ema_stack"]) {
    const bullishStack = ctx["ema_stack"] === "多头排列";
    add(
      "均线动能",
      `EMA20 ${bullishStack ? "在上" : "在下"} EMA50(${ctx["ema_stack"]}),` +
      `收盘相对 EMA20 ${fmtSF((ctx["vs_ema20_pct"] as number) || 0.0, 2)}%`,
      W.ema * (bullishStack ? 1.0 : -1.0),
    );
  }

  if (sweeps.length) {
    const latestSweep = sweeps[sweeps.length - 1]!;
    add(
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
        "贴近关键位",
        `现价紧贴${atResistance ? "阻力" : "支撑"} ${pyFloat(near["price"] as number)}` +
        `(${near["touches"]} 次触碰)`,
        atResistance ? -W.level : W.level,
      );
    }
  }

  const rel = ctx["rel_volume"] as number | null | undefined;
  if (rel !== null && rel !== undefined && rel >= 1.5) {
    const up = ((ctx["vs_ema20_pct"] as number) || 0.0) >= 0;
    add(
      "量能",
      `最后一根量能是近 20 根均量的 ${fmtF(rel, 2)} 倍,价格${up ? "在" : "跌破"}均线`,
      W.volume * (up ? 1.0 : -1.0),
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
/** 一段 K 线 → 完整 PA 读盘结果。纯函数。now 传 epochMs(视作美东墙钟直接比较)。 */
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

export function analyze(
  rows: Array<Record<string, unknown>>,
  symbol = "",
  timeframe = "",
  strength = SWING_STRENGTH,
  now: { epochMs: number; etWallMinutes?: number } | number | null = null,
  extendedHours = false,
): Record<string, any> {
  const bars = toBars(rows);
  if (bars.length < MIN_BARS) {
    throw new PriceActionError(
      `只有 ${bars.length} 根 K 线,不足以读出结构(至少需要 ${MIN_BARS} 根)。` +
      "换个更长的周期试试;如果这是刚开盘、K 线还在一根根长出来,过一会儿再看。",
    );
  }

  const atrValue = atr(bars);
  const last = bars[bars.length - 1]!.close;
  const tol = atrValue > 0 ? atrValue * 0.35 : Math.abs(last) * 0.0005;

  const points = labelSwings(zigzag(findSwings(bars, strength)));
  const trend = readTrend(points);
  const events = breakEvents(bars, points, strength);
  const levels = clusterLevels(bars, points, tol, last);
  const gaps = findFvgs(bars, tol);
  const sweeps = findSweeps(bars, points, tol, strength);
  const patterns = detectPatterns(bars, atrValue);
  const ctx = marketContext(bars, atrValue);
  const block = orderBlock(bars, events.length ? events[events.length - 1]! : null);
  const equals = equalLevels(points, tol);

  const [scoreValue, evidence] = score(trend, events, ctx, sweeps, patterns, levels, atrValue, last);
  const bias = biasOf(scoreValue);

  const result: Record<string, any> = {
    symbol,
    timeframe,
    timeframe_label: (TIMEFRAMES[timeframe]?.["label"] as string) ?? timeframe,
    bar_count: bars.length,
    first_bar: bars[0]!.time,
    last_bar: bars[bars.length - 1]!.time,
    last: pyRound(last, 4),
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
    plan: makePlan(bias.bias, points, levels, gaps, block, atrValue, ctx),
    bars: bars.slice(-CHART_BARS).map((b) => ({
      time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    })),
    ma: movingAverages(bars),
  };
  result["extended_hours"] = extendedHours;
  result["warnings"] = makeWarnings(result, typeof now === "number" ? now : now?.epochMs ?? null, extendedHours);
  result["readout"] = makeReadout(result);
  return result;
}

function makePlan(
  bias: string,
  points: Swing[],
  levels: Array<Record<string, unknown>>,
  gaps: Array<Record<string, unknown>>,
  block: Record<string, unknown> | null,
  atrValue: number,
  ctx: Record<string, unknown>,
): Record<string, any> {
  const resistance = levels.find((l) => l["side"] === "resistance") ?? null;
  const support = [...levels].reverse().find((l) => l["side"] === "support") ?? null;
  const lastLow = [...points].reverse().find((s) => s.kind === "low") ?? null;
  const lastHigh = [...points].reverse().find((s) => s.kind === "high") ?? null;

  const isBull = bias === "bullish" || bias === "lean_bull";
  const isBear = bias === "bearish" || bias === "lean_bear";

  const plan: Record<string, any> = { resistance, support, watch: [] };

  if (isBull && resistance) {
    plan["confirm"] =
      `收盘站上 ${pyFloat(resistance["price"] as number)}(最近阻力,${resistance["touches"]} 次触碰)` +
      "才算突破成立;只有影线穿过按扫单处理";
  } else if (isBull) {
    plan["confirm"] =
      `上方在这段样本里没有留下前高:现价已是近 ${ctx["range_bars"] ?? 0} 根的高位` +
      `(区间上沿 ${pyFloat(ctx["range_high"] as number)}),` +
      "没有可参照的突破确认位,追高缺少结构依据";
  } else if (isBear && support) {
    plan["confirm"] =
      `收盘跌破 ${pyFloat(support["price"] as number)}(最近支撑,${support["touches"]} 次触碰)` +
      "才算破位成立;只有影线穿过按扫单处理";
  } else if (isBear) {
    plan["confirm"] =
      `下方在这段样本里没有留下前低:现价已是近 ${ctx["range_bars"] ?? 0} 根的低位` +
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
        `距现价 ${fmtSF(near["distance_pct"] as number, 2)}%)`,
      );
    }
  }
  if (atrValue > 0) {
    plan["atr_note"] =
      `当前 ATR ${pyFloat(pyRound(atrValue, 4))}:小于这个幅度的价差属于日常噪音,别当成突破`;
  }
  return plan;
}

function makeWarnings(
  result: Record<string, any>, nowEpochMs: number | null, extendedHours = false,
): string[] {
  const out: string[] = [];
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
  if (age !== null) {
    result["age_seconds"] = Math.trunc(age);
    if (age > 1800) {
      out.push(
        `最后一根 K 线停在 ${result["last_bar"]},距现在 ${Math.trunc(age / 60)} 分钟` +
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

import { ET, wallToEpoch } from "./tz.js";

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
export function factsText(result: Record<string, any>): string {
  const ctx = result["context"] ?? {};
  const plan = result["plan"] ?? {};
  const lines: string[] = [
    `标的:${result["symbol"] || "-"};周期:${result["timeframe_label"] || "-"};` +
    `K 线 ${result["bar_count"] ?? 0} 根,最后一根 ${result["last_bar"] || "-"};` +
    `现价 ${pyFloat(result["last"])};ATR ${pyFloat(result["atr"])}。`,
    `软件判定:${result["bias_label"]}(打分 ${fmtSF(result["score"] ?? 0.0, 0)}/100);` +
    `结构:${result["trend_label"]}。`,
  ];
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
            `(${l["touches"]} 次触碰,距现价 ${fmtSF(l["distance_pct"], 2)}%)`,
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
    lines.push(`量能:最后一根是近 20 根均量的 ${fmtF(ctx["rel_volume"], 2)} 倍。`);
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
      `高周期(${higher["timeframe_label"]}):${higher["bias_label"]},${higher["trend_label"]};` +
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
export function htfSummary(result: Record<string, any>): Record<string, unknown> {
  const plan = result["plan"] ?? {};
  return {
    timeframe: result["timeframe"],
    timeframe_label: result["timeframe_label"],
    bias: result["bias"],
    bias_label: result["bias_label"],
    score: result["score"],
    trend_label: result["trend_label"],
    last_event: (result["events"]?.length
      ? result["events"][result["events"].length - 1]["text"]
      : null) ?? null,
    resistance: plan["resistance"]?.["price"] ?? null,
    support: plan["support"]?.["price"] ?? null,
  };
}

/** 低周期与高周期是否同向。 */
export function agreement(
  primary: Record<string, any>, higher: Record<string, any> | null,
): Record<string, string> {
  if (!higher) return { state: "unknown", text: "没有高周期数据可对照。" };

  const sign = (bias: string): number => {
    if (bias === "bullish" || bias === "lean_bull") return 1;
    if (bias === "bearish" || bias === "lean_bear") return -1;
    return 0;
  };

  const a = sign(primary["bias"]);
  const b = sign(higher["bias"] as string);
  if (a === 0 || b === 0) {
    return {
      state: "unclear",
      text: `${higher["timeframe_label"]} 方向不明,低周期信号缺少高周期背书。`,
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
