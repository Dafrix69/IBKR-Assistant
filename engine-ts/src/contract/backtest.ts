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
  /** 最近 100 笔 */
  trade_list: BacktestTrade[];
  curve: BacktestCurvePoint[];
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
}

/**
 * 进 handler 时的样子:schema 只确认 params 是个对象,**rules / instrument 由 models.ts 的两个 schema 校验**并给
 * 「自定义条件不合法:…」「交易品种配置不合法:…」,params 由 runBacktest 逐项校验——所以这三项在这里是 unknown:它们确实还没验过。
 */
export interface BacktestRunParams extends Omit<BacktestRunSpec, "params" | "rules" | "instrument"> {
  params?: Record<string, unknown>;
  rules?: unknown;
  instrument?: unknown;
}

export interface BacktestParseRulesParams {
  /** 策略描述,去掉首尾空白后 1~1000 字 */
  text: string;
}
