/** backtest.*:策略回测(纯代码计算,不经过模型、不接下单链路)与「一句话 → 条件」。类型文件,不 import 任何东西。
 *
 * 数值口径在 backtest.ts(golden-backtest 钉着);条件与品种的合法范围在 models.ts 的 CustomRulesSchema /
 * BacktestInstrumentSchema——这里的类型是它们校验、补齐默认值**之后**的样子,Input 结尾的是界面发过来的样子。
 */

// ---------------------------------------------------------------- 策略目录
export interface BacktestStrategy {
  /** buy_hold / sma_cross / rsi / breakout / custom */
  key: string;
  label: string;
  desc: string;
  /** 默认参数;界面表单照它摆。custom 与 buy_hold 是空的 */
  params: Record<string, number>;
  /** 每个参数的中文名 */
  param_labels: Record<string, string>;
}

// ---------------------------------------------------------------- 自定义条件
export type RuleIndicator =
  | "close" | "open" | "high" | "low" | "sma" | "ema" | "rsi" | "highest" | "lowest" | "change_pct" | "macd_hist";
export type RuleOp = ">" | "<" | ">=" | "<=" | "cross_up" | "cross_down";

/** 一个操作数:指标(sma / ema / rsi / highest / lowest / change_pct 要带 period)或常数。用不上的那几项是 null。 */
export interface RuleOperand {
  kind: "indicator" | "const";
  name: RuleIndicator | null;
  period: number | null;
  value: number | null;
}

export interface RuleCondition {
  left: RuleOperand;
  op: RuleOp;
  right: RuleOperand;
}

/** entry 全部同时满足才买入(1~6 条);exit 全部同时满足才卖出(0~6 条,空 = 持有到区间结束)。 */
export interface CustomRules {
  entry: RuleCondition[];
  exit: RuleCondition[];
}

/** 界面搭建器拼出来的操作数:用不上的键可以不带,数字可以是数字串。 */
export interface RuleOperandInput {
  kind: "indicator" | "const";
  name?: string | null;
  period?: number | string | null;
  value?: number | string | null;
}

export interface RuleConditionInput {
  left: RuleOperandInput;
  op: string;
  right: RuleOperandInput;
}

export interface CustomRulesInput {
  entry: RuleConditionInput[];
  exit?: RuleConditionInput[];
}

// ---------------------------------------------------------------- 交易品种
export type BacktestInstrumentType = "stock" | "call" | "put" | "call_spread" | "put_spread" | "butterfly";

/** 拿什么去执行信号。期权用 Black-Scholes(r=0、逐日重估的已实现波动率)估价,只是研究口径。正股时后四项用不上,但补齐了默认值。 */
export interface BacktestInstrument {
  type: BacktestInstrumentType;
  /** 开仓时距到期的天数,1~365 */
  dte: number;
  /** 行权价相对现价偏移百分之几,-30~30;算出来的价再贴到标准挂牌间隔上 */
  offset_pct: number;
  /** 价差 / 蝴蝶的翼宽占现价百分之几;贴档之后不足一档按一档 */
  width_pct: number;
  /** 每笔投入占净值百分之几 */
  risk_pct: number;
}

export interface BacktestInstrumentInput {
  type?: string;
  dte?: number | string;
  offset_pct?: number | string;
  width_pct?: number | string;
  risk_pct?: number | string;
}

// ---------------------------------------------------------------- 回测结果
export interface BacktestTrade {
  /** 成交那一天:信号在前一根收盘,成交在这一根开盘 */
  entry_date: string;
  /** 区间结束时还没平的那一笔是 null */
  exit_date: string | null;
  /** 正股是成交那天的开盘价(没平的那笔,exit_price 是最后一根的收盘价);期权是整个结构的理论价 */
  entry_price: number;
  exit_price: number;
  /** 扣了成交成本的净收益;期权是对投入的权利金而言 */
  return_pct: number;
  closed: boolean;
  /** 只有期权品种才有:到期 / 信号消失 / 区间结束时还开着 */
  exit_reason?: "expiry" | "signal" | "open";
  /** 只有期权品种才有:各条腿贴档之后的行权价,按腿的次序(价差是 买的 / 卖的,蝴蝶是 低 / 中 / 高,单腿就一个) */
  strikes?: number[];
}

/** 净值曲线上的一个点(最多抽 300 个,首尾必在);净值与基准都从 1 起。只给图用——统计都是引擎拿逐日全量净值算的。 */
export interface BacktestCurvePoint {
  date: string;
  equity: number;
  /** 买入持有(同一个成交口径:第 0 根收盘决定、第 1 根开盘买进;不扣成本) */
  bench: number;
}

/**
 * runBacktest 的产出。rules / instrument / symbol 是结算之后一层层补上去的,所以在这个类型里是可选的——
 * 它在每个阶段都说的是真话(同 PositionRow)。RPC 的回执见 BacktestRunResult。
 */
export interface BacktestReport {
  strategy: string;
  /** 实际用的参数(默认值 + 调用方给的);custom 是空的 */
  params: Record<string, number>;
  /** 用了多少根日线 */
  bars: number;
  /** 实际的首尾日线日期(不一定等于请求的起止) */
  start: string;
  end: string;
  /** 首尾两根日线之间的日历天数。不满 365 天时,带"年化"的那几项(年化收益、年化波动、Sharpe、Sortino)都是把这一段外推到一年 */
  days: number;
  total_return_pct: number;
  buy_hold_return_pct: number;
  /** 策略收益 − 买入持有(百分点) */
  excess_return_pct: number;
  annualized_pct: number;
  max_drawdown_pct: number;
  /** 日收益的年化波动率(%):样本标准差 × √252,逐日全量净值算。日线不到 3 根是 null */
  volatility_pct: number | null;
  /** 年化 Sharpe:日收益均值 ÷ 标准差 × √252,无风险利率按 0(空仓那些天收益是 0,不计利息)。净值一动没动是 null */
  sharpe: number | null;
  /** 年化 Sortino:日收益均值 ÷ 下行偏差 × √252,目标收益 0、分母按全部天数;没有下跌的日子是 null */
  sortino: number | null;
  /** 在场的天数:相对上一根的涨跌里带着仓位的日线根数(隔夜带着,或当天开盘之后带着) */
  held_days: number;
  /** 在场那些天净值单日变动的均方根(%):在场时一个典型的单日波动。没持过仓是 null。参数扫描拿它 × √held_days 当回撤的下限 */
  held_day_move_pct: number | null;
  /** 总笔数(含还没平的那一笔) */
  trades: number;
  closed_trades: number;
  /** 以下六项**只数已平仓的**(还开着的那笔没有结果);一笔已平仓的都没有时是 null。胜率 = 净收益为正的占比 */
  win_rate_pct: number | null;
  /** 盈利那几笔的平均收益(%);没有盈利的是 null */
  avg_win_pct: number | null;
  /** 亏损那几笔的平均收益(%,负数);没有亏损的是 null */
  avg_loss_pct: number | null;
  /** 盈亏比 = 平均盈利 ÷ |平均亏损|;缺一边是 null */
  payoff_ratio: number | null;
  /** 盈利因子 = 盈利合计 ÷ |亏损合计|,按每笔收益率算(等于每笔下同样大的注);没有亏损的笔是 null */
  profit_factor: number | null;
  /** 期望 = 每笔的平均收益(%) */
  expectancy_pct: number | null;
  /** 收盘时有仓的日线占比 */
  exposure_pct: number;
  /** 最近 100 笔(扣了成交成本的,如果给了) */
  trade_list: BacktestTrade[];
  curve: BacktestCurvePoint[];
  /** 这次结果的口径与已知偏差,一条一句,界面原样摆。只有整段回测(runBacktest)补齐;结算一截时只带品种自己的那几条 */
  notes?: string[];
  /** 每边成交成本(%);只有给了、且大于 0 才有——没有这个键就是没扣成本 */
  cost_pct?: number;
  /** 只有 custom 策略才有 */
  rules?: CustomRules;
  /** 调用方给了几项就是几项,type 没给补成 stock;经 RPC 进来的已经被 BacktestInstrumentSchema 补齐了 */
  instrument?: Partial<BacktestInstrument>;
  symbol?: string;
}

/** backtest.run 的回执:instrument、symbol 与 notes 一定有。 */
export type BacktestRunResult = BacktestReport & { instrument: BacktestInstrument; symbol: string; notes: string[] };

// ---------------------------------------------------------------- 入参
/** 界面照这个给(bridge.ts 的 runBacktest 用它标签名)。 */
export interface BacktestRunSpec {
  symbol: string;
  /** YYYY-MM-DD,区间最长 10 年 */
  start: string;
  end: string;
  strategy: string;
  /** 只给要改的;数字串也认 */
  params?: Record<string, number | string>;
  /** strategy 是 custom 时才看 */
  rules?: CustomRulesInput;
  /** 不给 = 正股 */
  instrument?: BacktestInstrumentInput;
  /** 每边成交成本(%,0~10):佣金 + 滑点,占成交额(期权是占权利金)的百分比;不给 = 0 */
  cost_pct?: number | string;
}

/**
 * 进 handler 时的样子:schema 只确认 params 是个对象,**rules / instrument 由 models.ts 的两个 schema 校验**并给
 * 「自定义条件不合法:…」「交易品种配置不合法:…」,params 由 runBacktest 逐项校验——所以这三项在这里是 unknown:它们确实还没验过。
 */
export interface BacktestRunParams extends Omit<BacktestRunSpec, "params" | "rules" | "instrument" | "cost_pct"> {
  params?: Record<string, unknown>;
  rules?: unknown;
  instrument?: unknown;
  cost_pct?: unknown;
}

export interface BacktestParseRulesParams {
  /** 策略描述,去掉首尾空白后 1~1000 字 */
  text: string;
}

// ---------------------------------------------------------------- backtest.sweep:参数扫描 + 样本外

/** 挑参数按什么排:总收益,或收益回撤比(SegmentStats.return_over_dd:Calmar 的不年化版本,总有定义) */
export type SweepObjective = "return" | "calmar";

/** 界面照这个给(bridge.ts 的 sweepBacktest 用它标签名)。 */
export interface BacktestSweepSpec {
  /** 1~8 只;多只时每组参数的得分取各只的平均 */
  symbols: string[];
  start: string;
  end: string;
  /** 不能是 custom / buy_hold:没有参数可扫 */
  strategy: string;
  /** 参数名 → 要试的取值;组合总数不超过 200 */
  grid: Record<string, Array<number | string>>;
  instrument?: BacktestInstrumentInput;
  cost_pct?: number | string;
  /** 样本内占多少(%,50~90),默认 70 */
  split_pct?: number | string;
  /** 滚动前推的折数(2~6);不给 / 0 = 不做 */
  folds?: number | string;
  objective?: SweepObjective;
}

/** 同上,schema 只确认结构;代码、日期、网格、比例的合法范围由 handler / backtestLab 报人话。 */
export interface BacktestSweepParams {
  symbols: unknown;
  start?: unknown;
  end?: unknown;
  strategy?: unknown;
  grid?: unknown;
  instrument?: unknown;
  cost_pct?: unknown;
  split_pct?: unknown;
  folds?: unknown;
  objective?: unknown;
}

/** 一段(样本内 / 样本外 / 前推的一折)的成绩;多只标的时是各只的平均。 */
export interface SegmentStats {
  /** 这一段首尾的日历天数。不满 365 天时 annualized_pct / calmar / sharpe 是外推的,只作参考 */
  days: number;
  return_pct: number;
  annualized_pct: number;
  max_drawdown_pct: number;
  /** 年化 ÷ |最大回撤|;回撤为 0 时是 null。只作展示,不拿来排名 */
  calmar: number | null;
  /**
   * objective = calmar 时排名用的数:总收益 ÷ max(|最大回撤|, 回撤下限),总有定义、不年化(同一段里各组的天数相同)。
   * 回撤下限 = 在场那些天净值单日变动的均方根 × √在场天数:这么大的日波动、在场这么多天,净值本来就该有这个量级的起落。
   * 只进过几次场、恰好没怎么回撤的组,不能拿"回撤小"当本事。一直空仓的是 0。多只标的时是各只的平均
   */
  return_over_dd: number;
  /** 回撤被下限顶替了(观察到的回撤比按日波动与在场天数推出来的量级还小)。赢家多半如此,它不是警报;多只标的时任何一只如此就是 true */
  dd_floored: boolean;
  /** 观察到的回撤还不到在场时**一天**的典型波动:基本没经历过回撤,多半只进过一两次场。这才是"这个名次不可靠"的标记;多只标的同上 */
  dd_under_one_day: boolean;
  /** 年化 Sharpe(无风险利率按 0);任何一只没有定义就是 null */
  sharpe: number | null;
  trades: number;
  /** 只数已平仓的 */
  win_rate_pct: number | null;
  /** 同一段买入持有 */
  bench_return_pct: number;
  /** return_pct − bench_return_pct(百分点) */
  excess_return_pct: number;
}

export interface SweepRow {
  params: Record<string, number>;
  /** 样本内的得分(按 objective),排名用 */
  score: number;
  is: SegmentStats;
  oos: SegmentStats;
  /** 样本外的得分在全部合法组合里排第几(1 = 最好):1 + 样本外得分比它高的组数,同分同名次 */
  oos_rank: number;
}

export interface WalkForwardFold {
  /** 训练段的最后一天 */
  train_end: string;
  test_start: string;
  test_end: string;
  /** 训练段里得分最高的那组参数 */
  params: Record<string, number>;
  /** 这一折挑出来的那组,在训练段的得分是不是靠回撤下限算出来的(SegmentStats.dd_floored);按总收益挑时恒为 false */
  dd_floored: boolean;
  /** 那组在训练段的回撤还不到在场时一天的典型波动(SegmentStats.dd_under_one_day):这一折的参数多半是撞出来的;按总收益挑时恒为 false */
  dd_under_one_day: boolean;
  test_return_pct: number;
  bench_return_pct: number;
}

export interface WalkForward {
  folds: WalkForwardFold[];
  /** 每折测试段收益连乘:只拿"当时就能选出来的参数"去跑下一段,是这张表里唯一不偷看未来的总收益 */
  total_return_pct: number;
  bench_return_pct: number;
}

export interface BacktestSweepResult {
  strategy: string;
  symbols: string[];
  objective: SweepObjective;
  cost_pct: number;
  instrument: BacktestInstrument;
  /** 实际用到的首尾日期(各只取交集) */
  start: string;
  end: string;
  /** 样本外从哪天开始 */
  split_date: string;
  /** 试了多少组、有几组不合法被跳过(比如快线 ≥ 慢线) */
  combos: number;
  skipped: Array<{ params: Record<string, number>; reason: string }>;
  /** 进了排名的组数(= combos − skipped);名次的分母是它,不是 rows 的长度 */
  ranked: number;
  /** 样本内得分最高的前 20 组 */
  rows: SweepRow[];
  /** 样本内第一名;全部不合法时是 null */
  best: SweepRow | null;
  /** 全部组合样本内与样本外得分的秩相关(Spearman,-1~1):接近 0 或为负 = 样本内的排名在样本外不作数,多半是过拟合 */
  rank_corr: number | null;
  /**
   * 秩相关的单侧 p 值(置换检验):样本内外的排名要是毫无关系,碰巧得到这么高或更高的相关的概率。
   * 相邻参数的结果彼此相关,它只回答"排名延续了没有",不回答"策略有没有用"。rank_corr 是 null 时也是 null
   */
  rank_corr_p: number | null;
  /** 随手挑一组,样本外得分不比样本内第一名差的概率 = 样本外得分 ≥ 它的组数 ÷ ranked。越接近 1,样本内的"第一"越不值钱 */
  pick_p: number | null;
  /** 全部合法组合样本外收益的中位数(%):不挑、随便拿一组的水平。样本内第一名的样本外收益该和它比 */
  oos_median_return_pct: number | null;
  walk_forward: WalkForward | null;
  notes: string[];
}