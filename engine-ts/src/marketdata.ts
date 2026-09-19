/** 行情数据的领域形状:K 线周期表、量价快照。
 *
 * 分析模块(priceaction / anomaly)按这些算,券商适配层(broker / futuBroker)按这些取。
 * 两边都要 import,所以它不能住在任何一边。只有常量与类型。
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
  /** 年化历史波动率,小数(0.32);> 5 视为百分数 /100 */
  hist_vol: number | null;
  vol_3m?: number | null;
  vol_5m?: number | null;
  vol_10m?: number | null;
  delayed?: boolean;
  /** 秒 */
  last_trade_at?: number | null;
}
