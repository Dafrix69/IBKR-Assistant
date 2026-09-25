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

/** 拿什么去执行信号。期权用 Black-Scholes(r=0、已实现波动率)估价,只是研究口径。正股时后四项用不上,但补齐了默认值。 */
export interface BacktestInstrument {
  type: BacktestInstrumentType;
  /** 开仓时距到期的天数,1~365 */
  dte: number;
  /** 行权价相对现价偏移百分之几,-30~30 */
  offset_pct: number;
  /** 价差 / 蝴蝶的翼宽占现价百分之几 */
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
  entry_date: string;
  /** 区间结束时还没平的那一笔是 null */
  exit_date: string | null;
  /** 正股是收盘价;期权是整个结构的理论价 */
  entry_price: number;
  exit_price: number;
  return_pct: number;
  closed: boolean;
  /** 只有期权品种才有:到期 / 信号消失 / 区间结束时还开着 */
  exit_reason?: "expiry" | "signal" | "open";
}

/** 净值曲线上的一个点(最多抽 300 个,首尾必在);净值与基准都从 1 起。 */
export interface BacktestCurvePoint {
  date: string;
  equity: number;
  /** 买入持有 */
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
  total_return_pct: number;
  buy_hold_return_pct: number;
  annualized_pct: number;
  max_drawdown_pct: number;
  /** 总笔数(含还没平的那一笔) */
  trades: number;
  closed_trades: number;
  /** 一笔都没有时是 null */
  win_rate_pct: number | null;
  /** 持仓天数占比 */
  exposure_pct: number;
  /** 最近 100 笔(扣了成交成本的,如果给了) */
  trade_list: BacktestTrade[];
  curve: BacktestCurvePoint[];
  /** 每边成交成本(%);只有给了、且大于 0 才有——没有这个键就是不扣成本的老口径 */
  cost_pct?: number;
  /** 只有 custom 策略才有 */
  rules?: CustomRules;
  /** 调用方给了几项就是几项,type 没给补成 stock;经 RPC 进来的已经被 BacktestInstrumentSchema 补齐了 */
  instrument?: Partial<BacktestInstrument>;
  symbol?: string;
}

/** backtest.run 的回执:instrument 与 symbol 一定有。 */
export type BacktestRunResult = BacktestReport & { instrument: BacktestInstrument; symbol: string };

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
  /** 每边成交成本(%,0~10):佣金 + 滑点;不给 = 0。绩效体检的执行损耗中位数可以直接填 */
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

/** 挑参数按什么排:总收益,或 Calmar(年化 ÷ 最大回撤,回撤为 0 时按年化算) */
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
  return_pct: number;
  annualized_pct: number;
  max_drawdown_pct: number;
  /** 年化 ÷ |最大回撤|;回撤为 0 时是 null */
  calmar: number | null;
  trades: number;
  win_rate_pct: number | null;
  /** 同一段买入持有 */
  bench_return_pct: number;
}

export interface SweepRow {
  params: Record<string, number>;
  /** 样本内的得分(按 objective),排名用 */
  score: number;
  is: SegmentStats;
  oos: SegmentStats;
  /** 样本外的得分在全部组合里排第几(1 = 最好) */
  oos_rank: number;
}

export interface WalkForwardFold {
  /** 训练段的最后一天 */
  train_end: string;
  test_start: string;
  test_end: string;
  /** 训练段里得分最高的那组参数 */
  params: Record<string, number>;
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
  /** 样本内得分最高的前 20 组 */
  rows: SweepRow[];
  /** 样本内第一名;全部不合法时是 null */
  best: SweepRow | null;
  /** 全部组合样本内与样本外得分的秩相关(Spearman,-1~1):接近 0 或为负 = 样本内的排名在样本外不作数,多半是过拟合 */
  rank_corr: number | null;
  walk_forward: WalkForward | null;
  notes: string[];
}