/** ideas.*:想法备忘、AI 分析、知识总结。类型文件,不 import 任何东西。
 *
 * 想法不是交易记录:不解析、不下单、不受 append-only 审计约束。发给模型的只有想法的时间 / 状态 / 标的 / 原文
 * 和代码算出来的行情情报,账户与持仓不出本机。
 */

export type IdeaStatus = "active" | "done" | "archived";

/** 想法里提到的过去时点(「上周五尾盘」「昨天开盘」)解析出来的价位。解析不出就没有,绝不瞎猜。 */
export interface IdeaAnchor {
  /** 给人看的:「上周五(2026-09-11)收盘价」 */
  label: string;
  /** 实际取的是哪一根日线(目标日休市就往前找最近的一根) */
  date: string;
  price: number;
  /** 最新收盘较锚点涨跌了百分之几 */
  chg_from_anchor_pct: number | null;
}

/**
 * 标的的行情情报:research.symbolBrief 按日线算的,数字由代码出、叙事才交给模型。**数据不够的项直接没有**
 * (不到 200 根日线就没有 vs_sma200_pct),所以除了形状之外什么都不保证。
 * 行情没取到不算分析失败:这时整个对象只有 error 一项。
 */
export interface IdeaBrief {
  /** 取日线时券商报的错(截到 120 字)。有它就没有别的 */
  error?: string;
  last?: number;
  /** 用了多少根日线 */
  bars?: number;
  chg_1d_pct?: number;
  chg_5d_pct?: number;
  chg_20d_pct?: number;
  chg_60d_pct?: number;
  /** 20 日已实现波动率(年化,%) */
  vol20_annual_pct?: number;
  rsi14?: number;
  vs_sma50_pct?: number;
  vs_sma200_pct?: number;
  /** MACD 柱(12/26/9) */
  macd_hist?: number;
  from_52w_high_pct?: number;
  from_52w_low_pct?: number;
  anchor?: IdeaAnchor;
}

/** IdeaBrief 里那些纯数字的项(界面与提示词都是拿一张「键 → 中文名 → 单位」的表去逐项取)。 */
export type IdeaBriefMetric = Exclude<keyof IdeaBrief, "error" | "anchor">;

/** 一次 AI 分析:模型给的五段(models.ts 的 IdeaAnalysisSchema 复验过)+ 引擎补的出处。仅供参考,不会下单。 */
export interface IdeaAnalysis {
  summary: string;
  thesis: string;
  checks: string[];
  risks: string[];
  suggestion: string;
  analyzed_at: string;
  model: string;
  /** 情报算的是哪只:想法原文里现抽的第一个标的;没提标的是 null(不兜底 SPX) */
  symbol: string | null;
  /** 分析时没连券商、或没提标的,是 null */
  brief: IdeaBrief | null;
}

/** ideas 表的一行(symbols / analysis 两列 JSON 已解开)。 */
export interface Idea {
  id: string;
  created_at: string;
  updated_at: string;
  text: string;
  symbols: string[];
  status: IdeaStatus;
  /**
   * 最近一次 AI 分析;没分析过、或那一列读不出来,是 null。它是一列 JSON,读出来什么就是什么——
   * 老版本写进去的可能缺后来才加的键,所以读的一方一律按"可能缺"来读(同 Track.targets)。
   */
  analysis: Partial<IdeaAnalysis> | null;
}

/** 一次知识总结的内容:模型给的五段(IdeaDigestSchema 复验过)+ 是哪个模型总结的。 */
export interface IdeaDigest {
  summary: string;
  themes: string[];
  lessons: string[];
  patterns: string[];
  actions: string[];
  model: string;
}

/** idea_digests 表的一行:总结保留历史,复盘时能看到认知怎么变的。 */
export interface IdeaDigestRow {
  id: string;
  created_at: string;
  /** archived / done / all */
  scope: string;
  idea_count: number;
  /** 这次总结喂了哪些想法(最近的在前) */
  idea_ids: string[];
  /** 那一列 JSON 读不出来时是空对象 */
  digest: Partial<IdeaDigest>;
}

// ---------------------------------------------------------------- 入参
export interface IdeasAddParams {
  /** 去掉首尾空白后 1~2000 字 */
  text: string;
}

export interface IdeasListParams {
  /** active / done / archived;不给(或空串)= 全部。不认识的值报「未知想法状态」 */
  status?: string;
  /** 默认 200,封顶 500 */
  limit?: number | string;
}

export interface IdeasUpdateParams {
  id: string;
  /** active / done / archived——想法只许改状态。不认识的值由 store 报「未知想法状态」,所以这里是 string */
  status: string;
}

export interface IdeasAnalyzeParams {
  id: string;
}

export interface IdeasDigestParams {
  /** archived(默认)/ done / all(= 已归档 + 已完成);界面发的是 all */
  scope?: string;
}

export interface IdeasDigestsParams {
  /** 默认 20,封顶 100 */
  limit?: number | string;
}
