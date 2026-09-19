/** sectors.*:自定义板块(= 股票池)与成分股行情。类型文件,只引同目录的类型文件。 */
import type { PoolWatch } from "./pool.js";

/** 一只成分股。除了 symbol 都可能缺:stocks 是一列 JSON,老库里的行写入时还没有 tag。 */
export interface SectorStock {
  symbol: string;
  company?: string;
  /** 为什么在这个板块里:AI 选股给的核心竞争点,或「手动添加」「手动加入」「迁移并入」 */
  reason?: string;
  /** 业务标签(「芯片」「数据中心」):RS 强度按它汇总强弱 */
  tag?: string;
}

/** sectors 表的一行(stocks 已解开)。 */
export interface Sector {
  id: string;
  created_at: string;
  updated_at: string;
  name: string;
  stocks: SectorStock[];
}

/** 一只股的现价 / 昨收 / 涨跌幅;取不到的那一样是 null。IBKR 与富途两家同形。 */
export interface StockQuote {
  last: number | null;
  close: number | null;
  change_pct: number | null;
}

export interface SectorsAddParams {
  name: string;
}

export interface SectorsIdParams {
  id: string;
}

export interface SectorsAddStockParams {
  id: string;
  symbol: string;
  company?: string;
  tag?: string;
}

export interface SectorsRemoveStockParams {
  id: string;
  symbol: string;
}

export interface SectorsSetTagParams {
  id: string;
  symbol: string;
  /** 空串(或不给)= 清掉 */
  tag?: string;
}

export interface SectorsDeleteResult {
  deleted: string;
  /** 跟着板块一起出了池子、两个开关被收掉的股 */
  dropped: string[];
}

export interface SectorsPickResult {
  /** 选完之后的板块。等大模型的那几秒里板块被删了的话,整个调用报「板块不存在」,不会回一个空的。 */
  sector: Sector;
  /** 新进池子却没开成开关的原因(上限吃满之类),原话 */
  skipped: string[];
  /** 重选换下去、且不在别的板块里的股 */
  dropped: string[];
}

export interface SectorsQuotesResult {
  connected: boolean;
  quotes: Record<string, StockQuote>;
}

export interface SectorsAddStockResult {
  sector: Sector;
  /** 进池子默认把两个开关都打开;没开成的那一路在 skipped 里 */
  watch: PoolWatch;
}

export interface SectorsRemoveStockResult {
  sector: Sector;
  dropped: string[];
}
