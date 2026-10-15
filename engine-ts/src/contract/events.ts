/** events.*:重要事件——定时公布的宏观数据(CPI、非农、FOMC…)与用户自己记的事件。类型文件,不 import 任何东西。
 *
 * 口径见 docs/features/events.md。事件只提醒、只悬挂在顶部,自己不发单;「应对」只是把一句对冲指令写进指令框。
 */

export type EventImpact = "high" | "medium";

/** 事件是哪里来的:内置日程(官方发布日历抄进代码)/ 公开日历源 / 用户自己记的 */
export type EventSource = "builtin" | "feed" | "custom";

/** 事件家族:界面按它起中文名、决定过去多久算过期;日历源上同一时刻的几条(CPI m/m、Core CPI y/y…)合成一条。 */
export type EventKind =
  | "cpi" | "ppi" | "nfp" | "fomc" | "fomc_minutes" | "pce" | "gdp" | "retail" | "claims" | "fed_speech" | "ism" | "other" | "custom"
  /** 跨市场跟跌套利(P0):美股大动而韩股 / A 股的美股 ETF 没同步,挂在它们开盘上 */
  | "cross";

export interface EconEvent {
  /** 稳定的 id:内置 "builtin:<kind>:<date>";日历 "feed:<kind>:<epoch>";自定义 "custom:<随机串>" */
  id: string;
  kind: EventKind;
  /** 给人看的名字:「CPI(10月)」「FOMC 利率决议」「非农就业(11月)」「美联储讲话(Warsh)」 */
  title: string;
  /** 公布时刻(epoch 毫秒) */
  at: number;
  /** 美东日历日 YYYY-MM-DD */
  date_et: string;
  /** 美东钟点 HH:MM */
  time_et: string;
  impact: EventImpact;
  source: EventSource;
  /** 公布之后多少分钟内还挂在顶上(市场消化这个数的时间) */
  linger_min: number;
  /** 日历源的原文条目(同一时刻合成一条时全部带上),预期与前值原样 */
  items?: Array<{ title: string; forecast: string; previous: string }>;
  /** 自定义事件的备注 */
  note?: string;
  /** 只有 kind = cross 有:差了几个点、哪些 ETF */
  cross?: CrossMarketDetail;
}

/** 一个没跟上的市场 */
export interface CrossMarketLag {
  /** kr / cn */
  key: string;
  name: string;
  /** 量跟没跟的那只不带杠杆的 ETF(EWY / ASHR)与它当日的涨跌 % */
  symbol: string;
  etf_pct: number;
  /** 比指数少跌(少涨)了几个点,正数 */
  gap: number;
  /** 这个市场下一次开盘(epoch 毫秒) */
  open_at: number;
  /** 可以拿来做的 ETF 与它们当日的涨跌 */
  instruments: Array<{ symbol: string; change_pct: number | null; last: number | null }>;
}

export interface CrossMarketDetail {
  direction: "up" | "down";
  /** 标普 500 当日涨跌 % */
  us_pct: number;
  markets: CrossMarketLag[];
}

/** 偏好表里的那份口径(app_prefs,不进 settings.json,和异动阈值一样)。 */
export interface EventsConfig {
  enabled: boolean;
  /** 拉公开日历(Forex Factory 本周 JSON):内置日程只有几个大项,讲话、初请、零售这些靠它 */
  feed: boolean;
  /** 中等影响的也算 */
  medium: boolean;
  /** 公布前多少分钟提醒,最多 4 档;空数组 = 只在公布那一刻提醒 */
  lead_minutes: number[];
  /** 板块联动:一个板块里至少这么多只有行情的成分股 */
  sector_min_stocks: number;
  /** 至少这个比例的成分股同向走出 sector_move_pct(0 ~ 1) */
  sector_share: number;
  /** 较昨收的涨跌幅 %,同向超过它才算 */
  sector_move_pct: number;
  /** 跨市场:美股收大阴 / 大阳而韩股、A 股还没开时提醒(做空 / 做多美股上市的对应 ETF 有时间差) */
  cross_market: boolean;
  /** 标普 500 当日涨跌幅 % 超过它才算 */
  cross_market_pct: number;
  /** ETF 比指数少跌(少涨)这么多个点才算没跟 */
  cross_lag_pct: number;
}

/** 入参:键同 EventsConfig,值由引擎校验(数字与数字串都认),同 AnomalyConfigInput。 */
export type EventsConfigInput = { readonly [K in keyof EventsConfig]?: unknown };

export interface EventsFeedStatus {
  /** 最近一次拉成功的时刻(毫秒);从没成功过是 null */
  at: number | null;
  /** 最近一次失败的原因;没有是 null */
  error: string | null;
  /** 这一份里有几条来自日历源 */
  count: number;
}

/** 跨市场那一路的状态 */
export interface EventsCrossStatus {
  /** 此刻在不在"美股收完、亚洲还没开完"的窗口里(在窗口里界面一分钟问一次) */
  in_window: boolean;
  /** 最近一次判断的时刻;没判过是 null */
  at: number | null;
  /** 取不到报价的原因;没有是 null */
  error: string | null;
}

export interface EventsList {
  /** 从昨天到两周后,按时间排好 */
  events: EconEvent[];
  /** 跨市场跟跌套利的那条(P0);没有是 null。不在 events 里:它不是日历上的事 */
  cross: EconEvent | null;
  cross_status: EventsCrossStatus;
  config: EventsConfig;
  feed: EventsFeedStatus;
  /** 生成时刻(毫秒) */
  at: number;
}

export interface EventsListParams {
  /** 用户点了刷新:这一轮同步等日历源,不吃缓存 */
  force?: boolean;
}

export interface EventsAddParams {
  title: string;
  /** 美东日期 YYYY-MM-DD */
  date_et: string;
  /** 美东钟点 HH:MM */
  time_et: string;
  note?: string;
  impact?: EventImpact;
  linger_min?: number;
}

export interface EventsRemoveParams {
  id: string;
}

export interface EventsSetConfigParams {
  config: EventsConfigInput;
}
