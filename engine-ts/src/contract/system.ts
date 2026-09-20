/** system.* 与 breaker.*:状态条读的那一份快照、提示词自检,以及那颗红按钮。
 *
 * 这一份是界面刷得最勤的:状态条每隔几秒问一次 system.status。所以它只读本地已有的东西——
 * 指数现价读缓存、心跳读计数器,一个请求都不发(方法走本地道)。
 */
import type { AccountView } from "./settings.js";

/** 熔断闸的完整状态(breaker.state 给这一份,带合闸时刻)。 */
export interface BreakerState {
  engaged: boolean;
  /** 没合闸时是空串,不是 null */
  reason: string;
  /** 合闸时刻(ISO);没合闸时是空串 */
  at: string;
  consecutive_failures: number;
}

/** 状态条上那一格:不带合闸时刻,界面只显示"停没停、为什么"。 */
export interface BreakerBrief {
  engaged: boolean;
  reason: string;
  consecutive_failures: number;
}

export interface BreakerHaltParams {
  /** 不给就用「用户在界面上按下暂停」 */
  reason?: string;
}

/** 合闸的回执。`warning` 只在券商撤单那一步炸了时出现:**闸照样合上**了,
 *  这是安全兜底,不是失败——界面要把这句话显出来,别当成成功而不提。 */
export interface BreakerHaltResult {
  engaged: boolean;
  cancelled: number;
  warning?: string;
}

export interface BreakerResumeResult {
  engaged: false;
}

/** 保护规则的现状(接连止损 / 回撤过大 / 同标的冷却)。到点自己解除,所以带解除时刻,
 *  界面直接显示"还剩几分钟",不用再问一次。 */
export interface ProtectionsSummary {
  paused: boolean;
  /** 触发的是哪条规则;没触发时是空串 */
  rule: string;
  reason: string;
  /** 解除时刻(epoch 毫秒);没暂停时 null */
  until_ms: number | null;
  cooldowns: ProtectionCooldown[];
}

export interface ProtectionCooldown {
  symbol: string;
  until_ms: number;
  reason: string;
}

/** 盯盘节拍器的心跳。没在跑 / 太久没跳 / 上一轮报错,界面都要能当场看见。 */
export interface TrackerHeartbeat {
  running: boolean;
  interval_ms: number;
  ticks: number;
  /** 超过一个节拍才跑完的轮数 */
  slow_ticks: number;
  /** 上一轮耗时;一轮都还没跑过时 null */
  last_ms: number | null;
  /** 开机以来最慢的一轮。从 0 起只增,**不是可空的** */
  max_ms: number;
  /** 距上一轮多久(毫秒);一轮都还没跑过时 null */
  age_ms: number | null;
  /** 上一轮的报错;没出错是空串,**不是 null** */
  last_error: string;
  /** 事件循环被同步代码占住的时长(毫秒):上一个节拍间隔里的最大值,与开机以来的最坏值。
   *  它高、而 last_ms 不高,说明节拍器没慢,是进程里别的事卡住了它。 */
  event_loop_last_ms: number | null;
  event_loop_worst_ms: number | null;
}

/** 某个指数最近一次现价是怎么来的:官方实时 / 夜盘期货推算 / 推算失败退回的昨收(带原因)。 */
export interface IndexSpot {
  price: number | null;
  /** index 官方实时 / futures 夜盘期货推算 / index_stale 推算失败退回的昨收 */
  source: string;
  /** 退回昨收时写明为什么推算没成功 */
  note?: string;
  [extra: string]: unknown;
}

/** 状态条要显示的那几道闸门。 */
export interface StatusLimits {
  max_order_notional: number;
  max_option_contracts: number;
  max_mkt_shares: number;
  min_confidence: number;
  max_spread_slippage: number;
  duplicate_window_minutes: number;
}

export interface SystemStatus {
  /** 协议版本,是串不是数字(界面拿它比版本) */
  protocol: string;
  /** ET 墙钟串 `YYYY-MM-DD HH:MM:SS`,不是 ISO——界面直接显示 */
  now_et: string;
  market_status: string;
  prompt_version: string;
  prompt_fingerprint: string;
  model: string;
  auto_execute: boolean;
  allow_live_trading: boolean;
  breaker: BreakerBrief;
  protections: ProtectionsSummary;
  broker_provider: string;
  broker_connected: boolean;
  /** 没连券商时是 true:没连不等于上游坏了 */
  broker_upstream_ok: boolean;
  pending_count: number;
  /** 只有缓存里有价的那几只在;键是代码 */
  index_spot: Record<string, IndexSpot>;
  /** 引擎还没建起来的那一刻是 null(实际问不到:同一个方法体在前面已经读过引擎) */
  tracker_loop: TrackerHeartbeat | null;
  accounts: AccountView[];
  limits: StatusLimits;
}

export interface SystemSelftest {
  prompt_version: string;
  prompt_fingerprint: string;
  /** 按码点数,不是 UTF-16 长度(提示词是中文的) */
  system_prompt_chars: number;
  fewshot_pairs: number;
  symbol_aliases: Record<string, string>;
  accounts: AccountView[];
}
