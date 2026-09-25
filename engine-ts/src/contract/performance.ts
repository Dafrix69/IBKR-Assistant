/** review.performance:绩效体检。类型文件,不 import 任何东西。
 *
 * 把已了结的交易(券商成交合成的蝴蝶、股票持仓段、导入的期权)摊成一本美元账,算出冠军交易员天天盯的那几个数:
 * 胜率、盈亏比、期望值、R 倍数与 SQN、连胜连亏、平仓权益曲线的最大回撤——再按品种、时段、星期拆开,
 * 最后用写死的规则挑出行为上的毛病(赚小亏大、亏损单拿得更久、亏完马上再进、亏后加码……)。
 * 数字全由代码算,不调模型;口径见 docs/features/performance.md。
 */

export type PerformanceScope = "all" | "live" | "paper";
export type PerformanceKind = "all" | "butterfly" | "stock" | "option";

export interface ReviewPerformanceParams {
  /** all = 实盘 + 模拟;live 只看实盘账户;paper 只看模拟账户。默认 all */
  scope?: PerformanceScope;
  /** 只看某一类;默认 all */
  kind?: PerformanceKind;
  /** 只看最近多少天里平仓的;不带 = 全部 */
  days?: number;
}

/** 账本里的一笔:已经了结、盈亏算得出来的交易。 */
export interface LedgerTrade {
  /** 交易分析页的同一个 id(`ib:…` / `stk:…`);导入的期权是 `opt:…` / Flex 仓位 id */
  id: string;
  kind: "butterfly" | "stock" | "option";
  symbol: string;
  /** 结构与方向,如「SPX 7625/7650/7675 看跌蝴蝶 买入」 */
  label: string;
  /** 开仓时刻(ISO);导入的期权出场事件没配开仓,是 null */
  opened_at: string | null;
  /** 了结时刻(ISO):平仓、到期结算 */
  closed_at: string;
  /** 已实现盈亏(美元) */
  pnl: number;
  /** 盈亏里扣没扣佣金:Flex 与导入的期权本来就扣了;蝴蝶与股票按成交回报里的佣金扣,回报里没有就是 false */
  net_of_commission: boolean;
  /** 开仓时的最大可亏(美元):买蝴蝶 = 权利金,卖蝴蝶 = 翼宽 − 收的权利金。风险不固定的(股票、贷方结构)是 null */
  risk: number | null;
  /** R 倍数 = 盈亏 / 风险 */
  r: number | null;
  /** 开仓时占用的钱(美元):股票 = 均价 × 股数,蝴蝶 = 权利金 × 乘数 × 张数。算"亏后加码"用 */
  exposure: number | null;
  /** 持有多少分钟;开仓时刻不明是 null */
  hold_minutes: number | null;
  paper: boolean;
}

/** 一组交易的基本面。金额都是美元,比例都是百分数。 */
export interface PerfStats {
  trades: number;
  wins: number;
  losses: number;
  flats: number;
  /** 胜率(%),不算持平;一笔输赢都没有是 null */
  win_rate: number | null;
  net_pnl: number;
  /** 赚的单加起来 */
  gross_profit: number;
  /** 亏的单加起来,正数 */
  gross_loss: number;
  avg_win: number | null;
  /** 平均亏损,负数 */
  avg_loss: number | null;
  /** 盈亏比 = 平均盈利 / |平均亏损| */
  payoff_ratio: number | null;
  /** 利润因子 = 总盈利 / 总亏损 */
  profit_factor: number | null;
  /** 期望值:平均每笔赚多少(美元) */
  expectancy: number | null;
  /** 按这个盈亏比,胜率至少要多少才不亏(%)= 1 / (1 + 盈亏比) */
  breakeven_win_rate: number | null;
  largest_win: number | null;
  /** 最大单笔亏损,负数 */
  largest_loss: number | null;
  max_consecutive_wins: number;
  max_consecutive_losses: number;
}

/** 分组(按品种 / 时段 / 星期 / 标的)的一行。 */
export interface PerfGroup {
  key: string;
  label: string;
  trades: number;
  win_rate: number | null;
  net_pnl: number;
  expectancy: number | null;
  profit_factor: number | null;
}

/** 平仓权益曲线的一个点:按了结时刻累计的已实现盈亏。 */
export interface EquityPoint {
  time: string;
  equity: number;
  /** 离此前峰值差多少(≥ 0) */
  drawdown: number;
}

/** 规则挑出来的一条:好的、该留意的、该改的。 */
export interface PerformanceFinding {
  /** 稳定的键(expectancy / tail_loss / revenge …),界面按它排版、测试按它认 */
  id: string;
  tone: "good" | "info" | "warn" | "bad";
  title: string;
  text: string;
  /** 这条规矩借鉴自谁,如「Van Tharp · 期望值与 R 倍数」 */
  source: string;
}

export interface PerfRStats {
  /** 算得出 R 的笔数(风险固定的那些) */
  trades: number;
  /** 平均每笔赚几个 R */
  expectancy_r: number | null;
  std_r: number | null;
  /** Van Tharp 的系统质量分 SQN = √min(N,100) × 平均 R / R 的标准差;不到 10 笔不算 */
  sqn: number | null;
  /** SQN 的档位:差 / 一般 / 好 / 很好 / 极好 */
  sqn_label: string;
}

export interface PerfDrawdown {
  /** 平仓权益曲线从峰值到谷底的最大落差(美元,≥ 0) */
  max: number;
  peak_at: string | null;
  trough_at: string | null;
  /** 现在离峰值还差多少 */
  current: number;
  /** 恢复因子 = 净盈亏 / 最大回撤;没回撤过是 null */
  recovery_factor: number | null;
}

export interface PerfDays {
  /** 有平仓的交易日数 */
  days: number;
  /** 当天净盈亏为正的日数 */
  green_days: number;
  best_day: { date: string; pnl: number } | null;
  worst_day: { date: string; pnl: number } | null;
  /** 亏钱的日子平均亏多少(负数) */
  avg_losing_day: number | null;
}

export interface ReviewPerformanceResult {
  scope: PerformanceScope;
  kind: PerformanceKind;
  days: number | null;
  stats: PerfStats;
  r_stats: PerfRStats;
  drawdown: PerfDrawdown;
  /** 眼下的连胜 / 连亏(从最近一笔往回数) */
  streak: { kind: "win" | "loss" | "none"; count: number };
  /** 赚钱单与亏钱单各自持有时长的中位数(分钟) */
  hold: { win_median_minutes: number | null; loss_median_minutes: number | null };
  /** 按全部样本算的凯利比例(0–1,可以是负的);样本不够是 null。只作参照,冠军的做法是远低于它 */
  kelly: number | null;
  /** 最近几笔单独算一遍,和全部比:在变好还是在变差 */
  recent: { window: number; stats: PerfStats } | null;
  per_day: PerfDays;
  equity: EquityPoint[];
  groups: {
    kind: PerfGroup[];
    /** 按开仓时段(美东):开盘 30 分钟 / 上午 / 午盘 / 下午 / 尾盘 30 分钟 / 盘外 */
    session: PerfGroup[];
    /** 按开仓那天是星期几(美东) */
    weekday: PerfGroup[];
    /** 按标的,笔数多的在前,最多 12 个 */
    symbol: PerfGroup[];
  };
  findings: PerformanceFinding[];
  /** 自动平仓的执行损耗:触发那一刻的持仓现价对实际成交均价(execQuality.ts)。范围与天数同上;品种按合约类型映射 */
  execution: ExecutionCost;
  /** 按这本账给保护规则的建议参数;只建议、不改设置,界面点了才写进去 */
  protection_advice: ProtectionAdvice[];
  /** 进账本的交易,新的在前,最多 300 笔 */
  trades: LedgerTrade[];
  /** 没进账本的:持仓中、结果不明(比如到期结算价取不到)、成本不明(建仓早于已同步的成交) */
  excluded: { open: number; unknown: number; no_cost: number };
  notes: string[];
}

// ---------------------------------------------------------------- 执行损耗

/** 一次自动平仓:触发时的现价(中间价口径)vs 实际成交均价。 */
export interface ExecutionRow {
  /** 触发时刻(ISO) */
  at: string;
  symbol: string;
  /** auto_close = 引擎到价发的平仓单;hosted_sweep = 托管单被改成追价平仓 */
  path: "auto_close" | "hosted_sweep";
  /** 触发原因(take_profit / stop_loss / …) */
  state: string;
  sec_type: string;
  /** 平仓单的方向:SELL = 平多头 */
  side: "BUY" | "SELL";
  /** 触发那一刻的持仓现价(每份) */
  mark: number;
  /** 成交均价(每份,组合取 BAG 行、绝对值) */
  fill: number;
  qty: number;
  /** 让出去的钱(美元):正 = 成交比触发价差 */
  cost_usd: number;
  /** 每份让出去的 / 触发价 × 100 */
  cost_pct: number;
  paper: boolean;
}

export interface ExecutionGroup {
  sec_type: string;
  samples: number;
  median_pct: number | null;
  avg_usd: number | null;
}

export interface ExecutionCost {
  /** 触发价与成交均价都有的笔数 */
  samples: number;
  /** 有平仓痕但算不出的:2026-09-26 之前的痕没记触发价、单没成交、找不到那张单 */
  missing: number;
  total_usd: number | null;
  avg_usd: number | null;
  /** 每笔损耗占触发价的百分比:中位数(回测的成本假设用它)与平均 */
  median_pct: number | null;
  avg_pct: number | null;
  by_sec_type: ExecutionGroup[];
  /** 新的在前,最多 50 笔 */
  rows: ExecutionRow[];
}

// ---------------------------------------------------------------- 保护规则建议

/** 一条建议:键与 settings.protections 的同名段一致,界面「按建议填入」原样发 settings.patch。 */
export type ProtectionAdvice =
  | { rule: "daily_loss"; suggested: { enabled: true; max_loss_usd: number }; reason: string; source: string }
  | { rule: "stoploss_guard"; suggested: { enabled: true; lookback_minutes: number; trigger_count: number; pause_minutes: number }; reason: string; source: string }
  | { rule: "cooldown"; suggested: { enabled: true; minutes: number }; reason: string; source: string };
