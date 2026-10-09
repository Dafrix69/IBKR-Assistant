/** review.signals:信号成绩单。类型文件,不 import 任何东西。
 *
 * 价位提醒(穿越、反复碰均线)、盯异动(急涨急跌、大涨大跌、放量)、强势股筛选的新入选、K线 PA 读出的方向,都只提醒、不下单。
 * 每条发出去的信号落一行 signal_log(只增不改),这里按之后 1 / 5 / 20 个交易日的收盘算它的成绩,
 * 再和同一只标的在信号**之前**"随便哪天"的同期涨跌比。口径见 docs/features/signal-scorecard.md。
 */

/** 信号从哪来:价位穿越、反复碰均线、盯异动的四类、强势股筛选的新入选、K线 PA 的方向。 */
export type SignalSource = "cross" | "touch" | "spike" | "day_move" | "rvol" | "burst" | "leaders" | "pa";

/** signal_log 的一行。 */
export interface SignalEntry {
  /** 发出的时刻(ISO) */
  at: string;
  source: SignalSource;
  symbol: string;
  /**
   * 这条信号**押的方向**:穿越、急涨急跌、大涨大跌押顺势(上穿押涨);碰均线押反弹(从上方回踩押涨);
   * 强势股新入选押涨;K线 PA 押它读出的方向。放量不带方向,是 null——只看之后波动大不大。
   */
  expect: "up" | "down" | null;
  /** 发出时的价,只作记录;成绩从信号之后的第一个收盘算起,不用它 */
  price: number | null;
  /** 给人看的一句话(价位名 / 异动标题 / 筛选结论 / 周期与方向) */
  label: string;
  /** 同一个来源里再分的小类:K线 PA 是周期("5m" / "1d");别的来源没有 */
  variant?: string | null;
}

export interface ReviewSignalsParams {
  /** 只看最近多少天发出的;不带 = 全部(1~3650) */
  days?: number;
}

/**
 * 一类信号在一个持有期上的成绩。收益一律按"押的方向"算:押跌的,跌了是正。
 * **每一段互不重叠的持有期一票**:同一天进场的信号先并成一条(那天的平均),同一段持有期里的各天再并成一条;
 * 下面的平均、中位数、押对、基线、t 都是对这些"段"算的,不是对一条条信号。
 */
export interface SignalHorizonStats {
  /** 1 / 5 / 20 个交易日 */
  horizon: number;
  /** 这个持有期已经走完、并且算得出基线的信号数。只作显示,不进任何统计 */
  n: number;
  /**
   * 这些信号里**互不重叠**的持有期有几段。同一天进场的、前后挨着进场的信号,持有期叠在一起,涨跌是一起的,
   * 不能当成独立样本;统计里一段算一票,下结论数的也是这个数,不是 n。
   */
  independent: number;
  /** 各段押对方向的平均收益(%);放量这种不带方向的是之后的平均绝对涨跌 */
  mean_pct: number | null;
  median_pct: number | null;
  /** 押对了的段占多少(%);不带方向的是 null */
  hit_rate: number | null;
  /** 同一批标的各自在信号**之前** 250 个交易日里"随便哪天"同样持有期、按同样方向的平均收益(%),同样按段平均:信号要比它好才算有用 */
  baseline_pct: number | null;
  /** mean − baseline */
  edge_pct: number | null;
  /** 各段(收益 − 基线)的均值的 t,相邻两段持有期有重叠时按相关算;不到 5 段、或估不出方差时是 null */
  t: number | null;
}

export interface SignalGroup {
  source: SignalSource;
  /** 小类(K线 PA 的周期);没有分小类的是 null */
  variant: string | null;
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
  /**
   * 这一次下结论用的 |t| 门槛。水平固定在正态下 |z| ≥ 2 的概率(约 4.55%):段数少时按 Student-t 换算(刚满 20 段是 2.14,
   * 段数越多越接近 2),同时判 m 类时再按 Bonferroni 抬高。一类都还不够下结论时,给的是刚满 20 段时一类要过的数
   */
  t_threshold: number;
  /** 没能进成绩的信号各有几条:比取到的日线还早(日线没覆盖到)、之前的日线不够算基线 */
  dropped: { uncovered: number; no_baseline: number };
  /** 最近的几条,带各持有期的收益(还没走完的是 null) */
  recent: Array<SignalEntry & { returns: Array<number | null> }>;
  /** 取不到日线的标的(没连券商、没有行情权限),它们的信号不进成绩 */
  missing_symbols: string[];
  notes: string[];
}
