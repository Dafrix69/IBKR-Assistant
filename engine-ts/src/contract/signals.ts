/** review.signals:信号成绩单。类型文件,不 import 任何东西。
 *
 * 价位提醒(穿越、反复碰均线)与盯异动(急涨急跌、大涨大跌、放量)只提醒、不下单,以前也从没人记它们对不对。
 * 现在每条发出去的信号落一行 signal_log(只增不改),这里按之后 1 / 5 / 20 个交易日的收盘算它的成绩,
 * 再和同一只标的"随便哪天"的同期涨跌比。口径见 docs/features/signal-scorecard.md。
 */

/** 信号从哪来:价位穿越、反复碰均线、盯异动的四类。 */
export type SignalSource = "cross" | "touch" | "spike" | "day_move" | "rvol" | "burst";

/** signal_log 的一行。 */
export interface SignalEntry {
  /** 发出的时刻(ISO) */
  at: string;
  source: SignalSource;
  symbol: string;
  /**
   * 这条信号**押的方向**:穿越、急涨急跌、大涨大跌押顺势(上穿押涨);碰均线押反弹(从上方回踩押涨);
   * 放量不带方向,是 null——只看之后波动大不大。
   */
  expect: "up" | "down" | null;
  /** 发出时的价;取不到是 null,按那天收盘算 */
  price: number | null;
  /** 给人看的一句话(价位名 / 异动标题) */
  label: string;
}

export interface ReviewSignalsParams {
  /** 只看最近多少天发出的;不带 = 全部(1~3650) */
  days?: number;
}

/** 一类信号在一个持有期上的成绩。收益一律按"押的方向"算:押跌的,跌了是正。 */
export interface SignalHorizonStats {
  /** 1 / 5 / 20 个交易日 */
  horizon: number;
  /** 这个持有期已经走完的信号数 */
  n: number;
  /** 押对方向的平均收益(%);放量这种不带方向的是之后的平均绝对涨跌 */
  mean_pct: number | null;
  median_pct: number | null;
  /** 押对了的比例(%);不带方向的是 null */
  hit_rate: number | null;
  /** 同一批标的"随便哪天"同样持有期、按同样方向的平均收益(%):信号要比它好才算有用 */
  baseline_pct: number | null;
  /** mean − baseline */
  edge_pct: number | null;
  /** (信号收益 − 各自标的的基线)的 t 值;|t| < 2 说明分不出信号和随手一天 */
  t: number | null;
}

export interface SignalGroup {
  source: SignalSource;
  label: string;
  /** 这一类一共发了几条(含持有期没走完的) */
  signals: number;
  horizons: SignalHorizonStats[];
  /** 一句结论:样本不够 / 比随手一天好 / 分不出 / 更差。只陈述历史,不给买卖建议 */
  verdict: string;
  tone: "good" | "info" | "warn" | "bad";
}

export interface ReviewSignalsResult {
  days: number | null;
  /** 范围里一共多少条信号 */
  total: number;
  groups: SignalGroup[];
  /** 最近的几条,带各持有期的收益(还没走完的是 null) */
  recent: Array<SignalEntry & { returns: Array<number | null> }>;
  /** 取不到日线的标的(没连券商、没有行情权限),它们的信号不进成绩 */
  missing_symbols: string[];
  notes: string[];
}
