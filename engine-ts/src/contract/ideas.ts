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

/** 检索的焦点:按什么去召回想法。两项都可以不给;都没给 = 不检索。 */
export interface IdeaFocus {
  /** 关键词,空白分隔,任一命中即算(3 个字以上走 FTS5 trigram,更短的走子串匹配) */
  q?: string;
  /** 标的,大写;任一在想法的 symbols 里即算 */
  symbols?: string[];
}

/** 想法因为什么被召回。recent = 最近一批无条件进,不因为匹配;semantic = 本机嵌入算出来意思相近(字面不一定对得上) */
export type IdeaMatch = "symbol" | "text" | "semantic" | "recent";

/** ideas.search 的一条结果:想法本身 + 它为什么被召回。 */
export interface IdeaHit {
  idea: Idea;
  matched_by: IdeaMatch[];
}

/** 一笔交易为什么算成 / 败:平仓 = 反向成交;到期 = 按到期日标的收盘结算;持仓中 = 还没有结局。 */
export type IdeaTradeHow = "closed" | "expired" | "open";

/** 结局。unknown = 算不出来(成本在记录之前、取不到结算价……),原因在 note,**不猜**。 */
export type IdeaTradeResult = "win" | "loss" | "flat" | "open" | "unknown";

/**
 * 一笔真实成交过的交易的结果,由代码从库里累积的券商成交算出(`tradeOutcomes.ts`),和想法一起喂给知识总结。
 * **只有单价与比例**:不带数量、金额、账户——模型拿到的是"这笔成没成、幅度多大",不是账户有多大。
 */
export interface IdeaTradeFact {
  /** 交易分析页的同一个 id(`ib:<permId>` / `stk:…`);导入的期权是 `opt:…` */
  id: string;
  /** option = 从按结构整理的成交导出导入的期权出场事件:没有行权价,结构是推断的,开仓没配对 */
  kind: "butterfly" | "stock" | "option";
  symbol: string;
  /** 开仓时刻(ISO) */
  opened_at: string;
  /** 平仓 / 到期时刻(ISO);持仓中、或时刻不明时为 null */
  closed_at: string | null;
  /** 结构与方向,如「SPX 7625/7650/7675 看跌蝴蝶 买入」「AAPL 做多」 */
  label: string;
  /** 蝴蝶:每张权利金;股票:进场均价。成本未知时为 null */
  entry_price: number | null;
  /** 蝴蝶:平仓价或到期结算价值;股票:出场均价 */
  exit_price: number | null;
  how: IdeaTradeHow;
  result: IdeaTradeResult;
  /** 收益率(%),对成本算;算不出来为 null */
  return_pct: number | null;
  /** 每份结构的已实现盈亏(点,已扣佣金)。只有导入的期权有——它们没配开仓,算不出收益率 */
  pnl_points?: number | null;
  /** 模拟账户的成交 */
  paper: boolean;
  /** 结局算不出来的原因,或需要带着看的说明;没有就是空串 */
  note: string;
}

/** 下单页「历史相似交易」的一条:历史里的一笔 + 为什么算相似。 */
export interface SimilarTrade {
  fact: IdeaTradeFact;
  /** 相似度分:同标的同结构是底分,每多一项相近 +1。只用来排序,不是概率 */
  score: number;
  /** 哪几项相近,如「翼宽相近(25 / 20)」「同为当日到期」;导入的期权会写「只能粗配」 */
  reasons: string[];
  /** 出场方式:提前平仓 / 持有到期 / 拆腿 / 已平仓 / 持仓中 */
  exit: string;
  /** false = 只是同板块的别的股票:列出来看,不算进胜负 */
  primary: boolean;
}

/** 按出场方式分的胜负(只数 primary 的)。 */
export interface SimilarExitStat {
  exit: string;
  win: number;
  loss: number;
  flat: number;
  open: number;
  unknown: number;
}

/** 下单页「历史相似交易」:这一单被认成什么、历史里相似的有几笔、胜负、按出场方式分、最像的几笔、相关的复盘经验。 */
export interface IdeasSimilarTradesResult {
  /** butterfly / vertical / single / stock / other:按什么口径比的 */
  kind: string;
  symbol: string;
  /** 这一单的要素,给人看的(「SPX 看跌蝴蝶 · 翼宽 25 · 当日到期 · 上午」) */
  basis: string[];
  /** primary 的笔数与胜负 */
  count: number;
  win: number;
  loss: number;
  flat: number;
  open: number;
  unknown: number;
  exits: SimilarExitStat[];
  /** 最像的几笔(分高的在前,同分新的在前),最多 8 笔 */
  matches: SimilarTrade[];
  /** 提到这个标的的已归档 / 已完成想法,新的在前,最多 3 条 */
  lessons: Idea[];
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
  /**
   * 这次总结是按什么检索出来的。**只有带焦点的总结才有这个键**——老的「全塞」总结没有它,
   * 所以同一个问题下两种取数的结果能并排比(idea-retrieval.md 的「切换前先留基准」)。
   */
  focus?: IdeaFocus;
  /**
   * 这次总结附带的交易结果(喂给模型的就是这些)。**只有勾了「附带交易结果」的总结才有这个键**,
   * 老的行、不带交易的行一字不变。
   */
  trades?: IdeaTradeFact[];
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
  /**
   * 给了(且 q / symbols 至少一项非空)就改成「检索出来的一批 + 最近的一批」,按时间分层抽;
   * 不给就是原来的全塞(最近 100 条)——默认口径不变。
   */
  focus?: IdeaFocus;
  /**
   * true:把库里累积的真实成交按笔算出结局(成 / 败 / 收益率,代码算),当事实和想法一起喂给模型,换一段允许谈结果的
   * 系统提示词。焦点带标的时只附这些标的的交易。不给 / false = 原来的口径,提示词一字不变。
   */
  trades?: boolean;
}

/**
 * 下单页拿订单票据来问「历史里有没有相似的」。字段就是 OrderTicket(instruction.ts)里比相似要用的那几项——
 * 契约文件之间不互相 import,所以这里照抄一份子集。只读,不回流到任何下单决策。
 */
export interface IdeasSimilarTradesParams {
  sec_type: string;
  symbol: string;
  action: string;
  /** 组合是净价;自动中间价的单是 null */
  limit_price?: number | null;
  /** YYYYMMDD(IB 的写法);正股是 null */
  expiry?: string | null;
  right?: string | null;
  /** BUTTERFLY / VERTICAL / IRON_CONDOR;不是组合是 null */
  combo_strategy?: string | null;
  legs?: Array<{ action: string; ratio: number; strike: number | null; right: string | null }>;
}

export interface IdeasSearchParams {
  /** 关键词,空白分隔 */
  q?: string;
  /** 标的:数组,或逗号 / 空白分隔的串("SPX, AAPL") */
  symbols?: string[] | string;
  /** YYYY-MM-DD,含当天(按 UTC 日期比,同 created_at) */
  since?: string;
  /** YYYY-MM-DD,含当天 */
  until?: string;
  /** active / done / archived;不给(或空串)= 全部 */
  status?: string;
  /** 默认 50,封顶 200 */
  limit?: number | string;
}

export interface IdeasDigestsParams {
  /** 默认 20,封顶 100 */
  limit?: number | string;
}
