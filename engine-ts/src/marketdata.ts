/** 行情数据的领域形状:K 线周期表、量价快照、一组 K 线出自哪一档行情。
 *
 * 分析模块(priceaction / anomaly)按这些算,券商适配层(broker / futuBroker)按这些取。
 * 两边都要 import,所以它不能住在任何一边。只有常量、类型,和「K 线出自哪一档」那张小登记表。
 */

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

/** 一组 K 线出自哪一档行情:live 实时 / delayed 延迟 / unknown 券商说不准(这张合约还没见过成交价出自哪一档)。 */
export type BarsFeed = "live" | "delayed" | "unknown";

/** 延迟行情最多晚多久。这是券商的口径,不是估的:IBKR 的延迟档(market data type 3)文档写的是晚 15–20 分钟。
 *  判断「这根 K 线的数据到齐没有」按上限算——宁可晚认一根,不把半根当整根。 */
export const DELAYED_FEED_MAX_MS = 20 * 60_000;

const feeds = new WeakMap<object, BarsFeed>();

/** 券商适配层在取回的那组 K 线上记一笔它出自哪一档。记在旁边、不改数组本身:别的调用方照旧把它当普通数组用。
 *  delayed:true 延迟、false 实时、null 说不准;券商没有延迟这一档(给 undefined)就不记。 */
export function tagFeed<T extends object>(bars: T, delayed: boolean | null | undefined): T {
  if (delayed !== undefined) feeds.set(bars, delayed === null ? "unknown" : delayed ? "delayed" : "live");
  return bars;
}

/** 这组 K 线出自哪一档;券商没记就是 undefined(按实时对待)。认的是 tagFeed 记过的那个数组对象,拷一份就没有了。 */
export function feedOf(bars: object): BarsFeed | undefined {
  return feeds.get(bars);
}

/** 异动监控订的那条流的一帧(券商适配层填,anomaly 读)。 */
export interface VolumeSnapshot {
  last: number | null;
  /** 昨收 */
  close: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  /** 当日累计量(流里的口径) */
  volume: number | null;
  /** 同一条流的 90 日日均量 */
  avg_volume: number | null;
  /** 年化历史波动率,**一律小数**(0.32 = 32%,6.0 = 600%)。IB 的 tick 23 本来就是小数;别的来源由填它的一方换算 */
  hist_vol: number | null;
  vol_3m?: number | null;
  vol_5m?: number | null;
  vol_10m?: number | null;
  delayed?: boolean;
  /** 秒 */
  last_trade_at?: number | null;
}
