/** pool.set_watch:股票池里一只股身上的两个开关(盯价位 / 盯异动)。类型文件,不 import 任何东西。 */

/** 「价位」/「异动」开关只传要改的那个:没传的那一路原样不动。 */
export interface PoolWatchPatch {
  price?: boolean;
  anomaly?: boolean;
}

export interface PoolSetWatchParams extends PoolWatchPatch {
  symbol: string;
}

/**
 * 开关回执。`skipped` 是**没做成的那一路的原因**(如「异动已达 30 只上限」):
 * 超上限、指数不能盯异动这些情况引擎不静默丢,如实回报,界面照原话说出来。
 */
export interface PoolWatch {
  symbol: string;
  price_on: boolean;
  anomaly_on: boolean;
  skipped: string[];
}
