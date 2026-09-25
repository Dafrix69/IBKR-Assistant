/** alerts.*:价位提醒(盯单、价位、穿越事件)。类型文件,只引同目录的类型文件。 */
import type { OptionWall } from "./options.js";

/** 价位在现价的哪一侧:上方是阻力、下方是支撑;最大痛点 / Gamma 翻转 / 整数关口、以及正好压在现价上的,是 pivot。 */
export type LevelKind = "resistance" | "support" | "pivot";

/** 盯单上的一个价位。 */
export interface WatchLevel {
  price: number;
  /** 给人看的名字("持仓墙 call 450"、"20日线"、"整数关口 445") */
  label: string;
  /** 来源键:call_wall / put_wall / call_vol_wall / put_vol_wall / max_pain / gamma_flip / round / ma20… / low_52w / high_52w */
  source: string;
  kind: LevelKind;
}

/** 一个价位的报警状态:报过就落防,离开得够远且过了冷却才重新上膛。 */
export interface LevelState {
  armed: boolean;
  /** 秒 */
  last_fired_at: number | null;
}

/** 一条提醒是怎么来的:穿越一个价位,还是短期内反复碰同一条日均线(见 docs/features/ma-touch.md)。 */
export type WatchTrigger = "cross" | "touch";

/** 一次穿越,或一次"短期内第 N 次碰均线"。 */
export interface WatchEvent {
  symbol: string;
  /** 缺省 = cross:2026-09-25 之前库里存的事件都没有这个字段,它们全是穿越。 */
  trigger?: WatchTrigger;
  /** 穿越:那个价位;碰均线:此刻的均线值 */
  price: number;
  label: string;
  source: string;
  kind: LevelKind;
  /** 穿越:价格往哪走;碰均线:从哪边碰上来的(down = 从上方回踩,up = 从下方反抽) */
  direction: "up" | "down";
  /** 上一轮的价 → 这一轮的价 */
  from: number;
  to: number;
  /** 秒 */
  at: number;
  /** 给人看的一句话("持仓墙 上穿 450(现价 450.3)") */
  text: string;
}

/** alert_watches 表的一行(JSON 列已解开)。 */
export interface Watch {
  id: string;
  created_at: string;
  updated_at: string;
  symbol: string;
  /** 整数关口的步长 */
  step: number;
  /** 回执与列表一个口径(2026-09-20 之前 alerts.create 的回执里是数字 1:回的是刚插入的那一行,没过读库的转换)。 */
  enabled: boolean;
  /** 期权墙用的到期日;还没算过是空串 */
  expiry: string;
  levels: WatchLevel[];
  /** 价位(按价格做键)→ 报警状态。引擎自己的状态机,界面不用读。 */
  states: Record<string, LevelState>;
  last_price: number | null;
  /** 最近一次算出来的期权墙;取不到链时是 null(价位照给,只是少了墙那几条) */
  wall: OptionWall | null;
  /** 最近 50 条 */
  events: WatchEvent[];
  /** 碰均线的底账:日线上已经发生过的触碰、盘中算均线要的收盘和、报过哪一段。还没算过是 null。 */
  touch: TouchBook | null;
}

// ---------------------------------------------------------------- 短期内反复碰均线
/** 碰均线提醒的口径。存在本地库(app_prefs),不进 settings.json——和异动阈值一样。 */
export interface MaTouchConfig {
  enabled: boolean;
  /** 看哪几条日均线(天数) */
  periods: number[];
  /** "短期内" = 最近几个交易日(含今天) */
  window_days: number;
  /** 窗口里碰到第几次开始报;连着几天都贴着线只算一次 */
  min_touches: number;
  /** 离均线这么近(占均线的 %)就算碰到 */
  band_pct: number;
}

/** 入参:键同 MaTouchConfig,值由引擎校验(数字与数字串都认),同 AnomalyConfigInput。 */
export type MaTouchConfigInput = { readonly [K in keyof MaTouchConfig]?: unknown };

/** 一段触碰:连着几个交易日都碰到均线算同一段。side = 这一段最后一天收在均线的哪一侧。 */
export interface TouchEpisode {
  start: string;
  end: string;
  side: "above" | "below";
}

/** 一条均线的底账。 */
export interface TouchLine {
  period: number;
  /** 最近 period − 1 根完整日线的收盘之和:加上现价再除以 period 就是盘中的均线 */
  prior_sum: number;
  /** 还落在窗口里的那几段(按时间先后);start 是这一段真正开始的那天,可能早于窗口 */
  episodes: TouchEpisode[];
}

/** 一只股的碰均线底账:每天开盘前后从日线算一次,盘中只拿现价往上补今天。 */
export interface TouchBook {
  /** 最后一根完整日线的日期(美东)。不是上一个交易日就说明底账旧了,那天不判。 */
  as_of: string;
  /** 算这份底账时的口径;和当前配置对不上就得重算 */
  window_days: number;
  band_pct: number;
  /** 要的是哪几条均线。lines 可能比它少:历史凑不满那条均线(上市太短)就不给,不拿短的凑 */
  periods: number[];
  lines: TouchLine[];
  /** 均线天数 → 已经报过的那一段从哪天开始(同一段只报一次) */
  fired: Record<string, string>;
}

export interface AlertsSetTouchConfigParams {
  config: MaTouchConfigInput;
}

export interface AlertsList {
  watches: Watch[];
  touch_config: MaTouchConfig;
}

/** 趋势摘要:各条均线的值(ma20 / ma60 / …)、low_52w / high_52w、range_pos_pct(现价在一年区间里的位置,0 = 贴着低点)、bars。 */
export type TrendSnapshot = Record<string, number>;

export interface AlertsCreateParams {
  symbol: string;
  /** 整数关口步长,缺省 5;数字串也认 */
  step?: number | string;
}

export interface AlertsDeleteParams {
  id: string;
}

export interface AlertsRefreshParams {
  id: string;
  /** 不给就沿用盯单上记着的那个 */
  expiry?: string;
}

/** 重算的回执。墙和趋势位都是加分项——降级可以,不能悄悄降级,所以原因带回来。 */
export interface AlertsRefreshResult {
  /** 重算之后的盯单。null = 重算途中这条盯单被删了(自动补价位跑在异动循环里,会和用户的删除交错)。 */
  watch: Watch | null;
  /** 期权墙取不到的原因;取到了是 null */
  wall_error: string | null;
  /** 日线历史取不到的原因(均线、52 周位那几条就没有);取到了是 null */
  history_error: string | null;
  trend: TrendSnapshot | null;
}

export interface AlertsPollResult {
  fired: WatchEvent[];
  /** 这一轮查了谁、查到的价;取不到价是 null(这一轮不判) */
  checked: Array<{ symbol: string; price: number | null }>;
}
