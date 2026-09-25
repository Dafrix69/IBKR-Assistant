/**
 * 信号成绩单(docs/features/signal-scorecard.md):每条信号之后 1 / 5 / 20 个交易日的收盘,按它押的方向算收益,
 * 再和同一只标的"随便哪天"同样持有期的收益比。比随手一天好,才谈得上这个信号有用。
 *
 * 纯计算:信号与日线由调用方给。日线用复权收盘(同 dailyHistory);信号发出那天用发出时的价作基准,
 * 取不到用那天的收盘。持有期没走完的信号不进成绩,只在明细里显示成空。
 */
import type { WatchEvent } from "./contract/alerts.js";
import type { AnomalyEvent } from "./contract/quality.js";
import type {
  ReviewSignalsResult, SignalEntry, SignalGroup, SignalHorizonStats, SignalSource,
} from "./contract/signals.js";
import { pyRound } from "./py.js";
import { etKey } from "./tradereview.js";

export const HORIZONS = [1, 5, 20] as const;
/** 一类信号在某个持有期上至少走完多少条才下结论。 */
export const MIN_SIGNALS = 20;
/** 明细最多给几条。 */
export const MAX_RECENT = 50;

export const SOURCE_LABEL: Record<SignalSource, string> = {
  cross: "价位穿越(押顺势)",
  touch: "反复碰均线(押反弹)",
  spike: "急涨急跌(押顺势)",
  day_move: "大涨大跌(押顺势)",
  rvol: "全天放量(只看波动)",
  burst: "窗口放量(只看波动)",
};

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

export interface DailyClose {
  date: string;
  close: number;
}

/** 信号那天在日线里的位置:那天有 K 线就是那根,没有(周末、盘后到次日之前)就是之前最后一根。 */
function anchorIndex(bars: readonly DailyClose[], date: string): number {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.date <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** 一条信号在各持有期的收益(%),按押的方向;不带方向的给绝对涨跌。没走完 / 找不到基准的是 null。 */
export function signalReturns(signal: SignalEntry, bars: readonly DailyClose[]): Array<number | null> {
  const date = etKey(Date.parse(signal.at), true);
  const i0 = anchorIndex(bars, date);
  if (i0 < 0) return HORIZONS.map(() => null);
  const sameDay = bars[i0]!.date === date;
  const ref = signal.price ?? (sameDay ? bars[i0]!.close : null);
  if (ref === null || !(ref > 0)) return HORIZONS.map(() => null);
  // 信号发在没有 K 线的那天(周末 / 假日):第 1 个交易日是 i0 + 1,和发在交易日当天盘中同一个数法
  return HORIZONS.map((k) => {
    const bar = bars[i0 + k];
    if (bar === undefined) return null;
    const raw = (bar.close / ref - 1) * 100;
    return pyRound(signal.expect === "down" ? -raw : signal.expect === "up" ? raw : Math.abs(raw), 4);
  });
}

/** 一只标的"随便哪天"持有 k 天的平均收益(%);`abs` 给平均绝对涨跌(不带方向的信号用)。 */
export function baselineReturn(bars: readonly DailyClose[], k: number, abs: boolean): number | null {
  const xs: number[] = [];
  for (let i = 0; i + k < bars.length; i += 1) {
    const r = (bars[i + k]!.close / bars[i]!.close - 1) * 100;
    xs.push(abs ? Math.abs(r) : r);
  }
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function tStat(xs: number[]): number | null {
  if (xs.length < 5) return null;
  const m = mean(xs)!;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  return sd > 0 ? pyRound((m / sd) * Math.sqrt(xs.length), 2) : null;
}

function round(v: number | null, d = 2): number | null {
  return v === null ? null : pyRound(v, d);
}

function verdictOf(source: SignalSource, h: SignalHorizonStats | undefined): Pick<SignalGroup, "verdict" | "tone"> {
  if (h === undefined || h.n < MIN_SIGNALS || h.edge_pct === null) {
    return { verdict: `走完 5 天的不到 ${MIN_SIGNALS} 条,先攒着,不下结论`, tone: "info" };
  }
  const directional = source !== "rvol" && source !== "burst";
  const what = directional ? "押的方向" : "之后的波动";
  // 每条的超额收益一模一样(标准差 0)时没有 t,按差值的正负说
  if (h.t === null) {
    return h.edge_pct > 0 ? { verdict: `5 天后${what}每条都比随手一天好 ${h.edge_pct} 个百分点`, tone: "good" }
      : h.edge_pct < 0 ? { verdict: `5 天后${what}每条都比随手一天差 ${-h.edge_pct} 个百分点`, tone: "bad" }
        : { verdict: `5 天后和随手一天一样`, tone: "warn" };
  }
  if (h.t >= 2) return { verdict: `5 天后${what}比随手一天好 ${h.edge_pct} 个百分点(t = ${h.t})`, tone: "good" };
  if (h.t <= -2) return { verdict: `5 天后${what}反而比随手一天差 ${-h.edge_pct} 个百分点(t = ${h.t})`, tone: "bad" };
  return { verdict: `5 天后和随手一天分不出来(差 ${h.edge_pct} 个百分点,t = ${h.t})`, tone: "warn" };
}

/**
 * 全部信号 → 成绩单。`bars` 是各标的的日线(从早到晚);不在里面的标的记进 missing_symbols,它的信号不进成绩。
 */
export function scoreSignals(
  signals: readonly SignalEntry[], bars: ReadonlyMap<string, readonly DailyClose[]>, days: number | null,
): ReviewSignalsResult {
  const missing = new Set<string>();
  const scored = signals.map((s) => {
    const series = bars.get(s.symbol);
    if (series === undefined || !series.length) {
      missing.add(s.symbol);
      return { s, returns: HORIZONS.map(() => null as number | null), series: null };
    }
    return { s, returns: signalReturns(s, series), series };
  });

  const groups: SignalGroup[] = [];
  for (const source of Object.keys(SOURCE_LABEL) as SignalSource[]) {
    const mine = scored.filter((x) => x.s.source === source);
    if (!mine.length) continue;
    const horizons: SignalHorizonStats[] = HORIZONS.map((k, hi) => {
      const done = mine.filter((x) => x.returns[hi] !== null && x.series !== null);
      const rets = done.map((x) => x.returns[hi]!);
      // 每条信号对"自己那只标的、同样方向"的基线,差值再求 t
      const bases = done.map((x) => {
        const b = baselineReturn(x.series!, k, x.s.expect === null);
        return b === null ? 0 : x.s.expect === "down" ? -b : b;
      });
      const excess = rets.map((r, i) => r - bases[i]!);
      const m = mean(rets);
      const b = mean(bases);
      const directional = done.some((x) => x.s.expect !== null);
      return {
        horizon: k,
        n: done.length,
        mean_pct: round(m),
        median_pct: round(median(rets)),
        hit_rate: directional && rets.length ? round((rets.filter((r) => r > 0).length / rets.length) * 100, 1) : null,
        baseline_pct: round(b),
        edge_pct: m !== null && b !== null ? round(m - b) : null,
        t: tStat(excess),
      };
    });
    groups.push({ source, label: SOURCE_LABEL[source], signals: mine.length, horizons, ...verdictOf(source, horizons[1]) });
  }

  const notes = [
    "收益按信号押的方向算(押跌的,跌了是正);放量不带方向,看的是之后的平均绝对涨跌",
    "基线 = 同一只标的在取到的日线里任意一天持有同样天数的平均;信号要比它好才算有用",
    "只陈述历史上发生了什么,不是买卖建议;信号仍然只提醒、不下单",
  ];
  if (missing.size) notes.push(`${missing.size} 只标的取不到日线(没连券商或没有行情权限),它们的信号不进成绩`);
  return {
    days,
    total: signals.length,
    groups,
    recent: scored.slice(-MAX_RECENT).reverse().map((x) => ({ ...x.s, returns: x.returns })),
    missing_symbols: [...missing].sort(),
    notes,
  };
}
