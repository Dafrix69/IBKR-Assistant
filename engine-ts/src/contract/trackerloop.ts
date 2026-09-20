/** 盯盘那一轮的产物:tracker.poll(判触发)、tracker.reconcile(和券商托管单对齐)、tracker.close_now(手动平仓)。
 *
 * 这三样都在**钱路径**上:poll 会发平仓单、reconcile 会挂/改/撤券商侧的真单、close_now 直接发一张平仓单。
 * 所以入参 schema 是 strict 的,close_now 还登记在 SENSITIVE_METHODS 里。
 *
 * 界面按秒调这三样;节拍器在引擎里跑的时候,它们回的是**上一轮的结果**(见 loop 字段与各自的注释),
 * 而不是再跑一轮——两处同时判触发就是两张平仓单。
 */
import type { PositionRow } from "./positions.js";
import type { SpotTarget, Track } from "./tracker.js";
import type { TrackerHeartbeat } from "./system.js";

/** 盯盘一轮对某一条追踪算出来的结论(tracker.ts 的 evaluate)。 */
export interface TrackEvaluation {
  /** holding / take_profit / stop_loss / trail_stop / profit_drawdown / closed;
   *  `sweep:` 开头 = 正在追价平仓 */
  state: string;
  /** 判断用的那个价;这一轮拿不到就是 null */
  price: number | null;
  /** 跟踪止损跟着的最有利价 */
  peak: number | null;
  trail_stop: number | null;
  /** 给人看的那句话:为什么是这个状态 */
  reason: string;
  cost_basis?: number;
  market_value?: number | null;
  unrealized_pnl?: number | null;
  unrealized_pct?: number | null;
  /** broker = 券商自己报的;local = 本地按同一套口径算的 */
  pnl_source?: string;
  profit_peak?: number | null;
  profit_drawdown_pct?: number | null;
  profit_drawdown_threshold?: number | null;
  profit_trail_stop?: number | null;
  stop_effective?: number | null;
  to_take_profit_pct?: number | null;
  to_stop_pct?: number | null;
  [extra: string]: unknown;
}

/** 追价平仓这一轮改到了哪个价。 */
export interface ChaseInfo {
  /** 追了几轮 */
  rounds: number;
  /** 这一轮改到的限价;刚认领回来、或这一轮算不出价时是 null */
  limit: number | null;
  /** 立刻成交的那个价(各腿买卖价合成);拿不到是 null */
  natural?: number | null;
  /** 再差也不越过的那条线 */
  floor?: number | null;
  [extra: string]: unknown;
}

/**
 * 盯盘表格的一行 = 追踪设置 + 这一轮的结论 + 那一份持仓。
 * **整条追踪一定在**(两条路径都是 `{ ...track, … }`);持仓已经不在了的那一行只有
 * `state: "closed"` 与 reason,没有 position,评估出来的那几样也没有。
 */
export type TrackPollRow = Track & Partial<TrackEvaluation> & {
  /** 这一轮的状态:持仓没了的那一行是 "closed" */
  state: string;
  reason: string;
  /** 这一轮读到的持仓原样(持仓没了的那一行没有这个字段) */
  position?: PositionRow;
  /** 设了标的目标价时,这一轮换算出来的那一份 */
  spot_target?: SpotTarget;
  /** 执行归券商托管单(不另发软件单——两张各平一次就是反向开仓) */
  hosted?: boolean;
  /** 正在追价平仓 */
  sweeping?: boolean;
  chase?: ChaseInfo;
  [extra: string]: unknown;
};

/** 到价了、但被闸门拦下的那一条(界面要照实说是哪几道闸)。 */
export interface TrackBlocked {
  id: string;
  symbol: string;
  blockers: string[];
  /** 到价的那一条会带上"为什么该平"(盯盘那条路);追价拿不到价的那种没有 */
  reason?: string;
}

/** 这一轮真发出去(或真改了价)的那一条。 */
export interface TrackFired {
  id: string;
  symbol: string;
  state: string;
  reason: string;
  /** 真发了单的那条带上记录 id 与券商订单号;"改了托管单的价"那种没有 */
  record_id?: string;
  order_id?: number | null;
  [extra: string]: unknown;
}

/** 盯盘一轮自己的产物(engine.pollTrackers)。RPC 再给它加一份心跳。 */
export interface TrackerPollTick {
  rows: TrackPollRow[];
  fired: TrackFired[];
  blocked: TrackBlocked[];
}

export interface TrackerPollResult extends TrackerPollTick {
  /** 节拍器心跳。节拍器在跑时这一份回的是上一轮的结果,心跳让界面看得出来 */
  loop: TrackerHeartbeat;
}

/** 挂在券商侧的一张托管单。 */
export interface HostedOrderRow {
  /** tp / sl / …:这张单管的是止盈还是止损 */
  kind: string;
  label: string;
  quantity: number;
  lmt_price: number | null;
  aux_price: number | null;
  trailing_percent: number | null;
  order_id: number | null;
}

export interface HostedTrack {
  id: string;
  symbol: string;
  orders: HostedOrderRow[];
  /** 正在追价平仓(改的始终是同一张单,不会多出第二张) */
  sweeping?: boolean;
  chase?: ChaseInfo;
}

/** 托管对账一轮自己的产物(engine.syncHosted)。RPC 再给它加一份心跳。 */
export interface TrackerSyncHostedTick {
  hosted: HostedTrack[];
  blocked: TrackBlocked[];
  /** 这一轮的报价可能是延迟的(没有实时行情权限):挂出去的价照实标出来 */
  quote_maybe_delayed: boolean;
}

export interface TrackerReconcileResult extends TrackerSyncHostedTick {
  loop: TrackerHeartbeat;
}

export interface TrackerCloseNowParams {
  id: string;
}

/** 手动平仓的回执。走的是和到价自动平仓**完全相同**的那条路,包括同样的闸门。 */
export interface TrackerCloseNowResult {
  fired: TrackFired;
}
