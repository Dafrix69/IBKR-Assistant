/** book.snapshot:一个标的的盘口(一档 + 深度梯子 + 流动性摘要)。类型文件,不 import 任何东西。
 *
 * 两家券商适配层各自产出同一份形状(`broker.ts` / `futuBroker.ts` 的 `orderBook`),`bookLiquidity` 是两家共用的纯函数。
 * 深度要单独的 Level 2 行情权限,多数账户没有——**所以"只有一档"是常态,不是异常**,界面按 note 与 l1_only 说明。
 */

/** 深度梯子上的一档。 */
export interface BookLevel {
  price: number;
  size: number;
}

/** 一档盘口。拿不到的那一样是 null;买卖都在且没倒挂时才有后面两项。 */
export interface BookL1 {
  bid: number | null;
  ask: number | null;
  bid_size: number | null;
  ask_size: number | null;
  /** 最新价;没有就退到昨收(IBKR 那一路) */
  last: number | null;
  /** 绝对价差 */
  spread?: number;
  /** 价差相对中间价的基点;中间价是 0 时是 null */
  spread_bps?: number | null;
}

/** 流动性摘要:`bookLiquidity` 按一档与深度算的,给人一眼看出"这只现在好不好成交"。有几项全看拿到了什么。 */
export interface BookLiquidity {
  spread_bps?: number | null;
  /** 很好 ≤5bps / 尚可 ≤20 / 偏宽 ≤60 / 很宽 */
  spread_grade?: string;
  /** 买卖各自的总挂单量(有深度时才有) */
  bid_depth?: number;
  ask_depth?: number;
  /** 买卖两边里更深的那边有几档 */
  levels?: number;
  /** 买盘比卖盘厚多少(百分比,正数是买盘厚) */
  imbalance_pct?: number;
  /** 没有深度、只按一档的挂单量算的失衡:界面要标明"仅一档" */
  l1_only?: boolean;
}

export interface BookSnapshot {
  symbol: string;
  l1: BookL1;
  /** 买盘由高到低;没有 Level 2 权限时是空的 */
  bids: BookLevel[];
  /** 卖盘由低到高 */
  asks: BookLevel[];
  /** 深度为什么没有、或者为什么只有一档;正常时是空串 */
  note: string;
  liquidity: BookLiquidity;
}

export interface BookSnapshotParams {
  symbol: string;
}
