/** review.performance:绩效体检。类型文件,不 import 任何东西。
 *
 * 把已了结的交易(券商成交合成的蝴蝶、股票持仓段、导入的期权)摊成一本美元账,算出冠军交易员天天盯的那几个数:
 * 胜率、盈亏比、期望值、R 倍数与 SQN、连胜连亏、平仓权益曲线的最大回撤——再按品种、时段、星期拆开,
 * 最后用写死的规则挑出行为上的毛病(赚小亏大、亏损单拿得更久、亏完马上再进、亏后加码……)。
 * 数字全由代码算,不调模型;口径见 docs/features/performance.md。
 *
 * 两条贯穿全表的口径:
 * - 持平(|盈亏| < 1 美元)的交易算一笔、进净盈亏与权益曲线,但**不进**胜率、盈亏比、期望值、凯利与 R 的统计。
 * - 区间一律是 95% 置信区间,按美东了结日成簇(同一天了结的几笔不当成几次独立的试验);样本不够、或全在同一天时算不出,是 null。
 */

export type PerformanceScope = "all" | "live" | "paper";
export type PerformanceKind = "all" | "butterfly" | "stock" | "option";

/** 95% 置信区间的两头。 */
export interface PerfInterval {
  lo: number;
  hi: number;
}

/** R 的分母是什么:max_loss = 开仓时的最大可亏(付出的权利金;卖出的对称蝶是翼宽 − 权利金);stop = 开仓后不久设的追踪止损。 */
export type RiskBasis = "max_loss" | "stop";

/**
 * 一笔为什么没有 R:
 * no_stop = 股票,开仓后的时限内没设过带止损的追踪;late_stop = 股票,止损是时限之后才设的(那已经不是初始风险);
 * undefined_risk = 风险不止权利金(贷方结构、比例蝶、日历、不对称的卖出蝶);no_open = 导入的出场事件没配上开仓;
 * no_cost = 开仓价或数量不明。
 */
export type RMissingReason = "no_stop" | "late_stop" | "undefined_risk" | "no_open" | "no_cost";

export interface ReviewPerformanceParams {
  /** all = 实盘与模拟混在一起算(结果的 `mix` 写明各几笔);live 只看实盘账户;paper 只看模拟账户。默认 all */
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
  /** 开仓时的初始风险(美元):买蝴蝶 = 权利金,卖蝴蝶 = 翼宽 − 收的权利金,股票 = |进场均价 − 初始止损| × 峰值股数。算不出是 null */
  risk: number | null;
  /** R 倍数 = 盈亏 / 风险 */
  r: number | null;
  /** `risk` 是哪一种;没有 R 是 null */
  risk_basis: RiskBasis | null;
  /** 没有 R 的原因;有 R 是 null */
  r_missing: RMissingReason | null;
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
  /** 胜率的 Wilson 区间(%),样本数按同一天几笔的相关打过折 */
  win_rate_ci: PerfInterval | null;
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
  /** 期望值:分了输赢的那些笔平均每笔赚多少(美元)= 胜率 × 平均盈利 − 败率 × |平均亏损|。持平的不算,和胜率同一个分母 */
  expectancy: number | null;
  /** 期望值的 t 区间(美元);输赢不到 2 笔、或全在同一天了结时是 null。跨着 0 就是正负还没分清 */
  expectancy_ci: PerfInterval | null;
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
  /** 期望值的 95% 区间(美元);跨着 0 时界面不给它上色 */
  expectancy_ci: PerfInterval | null;
  profit_factor: number | null;
  /** 盈亏比(按美元) */
  payoff_ratio: number | null;
  /** 凯利比例(按美元),门槛同整体的 `kelly` */
  kelly: number | null;
  /** 这一组里有 R、分了输赢的笔数 */
  r_trades: number;
  /** 这一组平均每笔几个 R */
  expectancy_r: number | null;
  /** 这一组按 R 的盈亏比与凯利比例(口径同 `PerfRStats`) */
  payoff_r: number | null;
  kelly_r: number | null;
  /** 这一组的 SQN;不到 10 笔不算 */
  sqn: number | null;
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
  /** 有 R、分了输赢的笔数(持平的不算,同胜率) */
  trades: number;
  /** 平均每笔赚几个 R */
  expectancy_r: number | null;
  /** R 期望的 t 区间;不到 2 笔、或全在同一天了结时是 null */
  expectancy_ci: PerfInterval | null;
  std_r: number | null;
  /** 这些笔的胜率(%) */
  win_rate: number | null;
  /** 按 R 的盈亏比 = 赚的单平均几个 R / 亏的单平均亏几个 R。仓位大小已经除掉了 */
  payoff_ratio: number | null;
  /** 按 R 的凯利比例(0–1,可以是负的);不到 8 笔是 null。它才对得上"单笔拿账户的百分之几去冒险" */
  kelly: number | null;
  /** Van Tharp 的系统质量分 SQN = √min(N,100) × 平均 R / R 的标准差;不到 10 笔不算 */
  sqn: number | null;
  /** SQN 的档位(Tharp 的表):差 / 低于平均 / 平均 / 好 / 优秀 / 极好 / 圣杯 */
  sqn_label: string;
}

/** R 盖住了多少交易、没盖住的为什么:R 的统计与 SQN 只代表有 R 的那一部分。 */
export interface PerfRCoverage {
  /** 范围内的全部笔数 */
  trades: number;
  /** 其中算得出 R 的 */
  with_r: number;
  /** 有 R 但持平的笔数:它们不进 R 的统计,所以 `r_stats.trades` = `with_r` − `flats` */
  flats: number;
  /** 分母是最大可亏的笔数(期权) */
  max_loss: number;
  /** 分母是初始止损的笔数(股票) */
  stop: number;
  /** 开仓后多少分钟之内设的止损才认作初始风险 */
  stop_window_minutes: number;
  /** 没有 R 的,按原因数;`label` 是给人看的一句 */
  missing: Array<{ reason: RMissingReason; label: string; trades: number }>;
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
  r_coverage: PerfRCoverage;
  /** 这个范围里实盘、模拟各几笔。两边都有时,上面所有的数都是混着算的 */
  mix: { live: number; paper: number };
  drawdown: PerfDrawdown;
  /** 眼下的连胜 / 连亏(从最近一笔往回数) */
  streak: { kind: "win" | "loss" | "none"; count: number };
  /** 赚钱单与亏钱单各自持有时长的中位数(分钟) */
  hold: { win_median_minutes: number | null; loss_median_minutes: number | null };
  /** 按**美元盈亏**算的凯利比例(0–1,可以是负的);输赢不到 8 笔是 null。品种混着时由单笔金额大的那一类主导;
   * 按 R 的在 `r_stats.kelly`,分品种的在 `groups.kind`。只作参照,冠军的做法是远低于它 */
  kelly: number | null;
  /** 最近几笔单独算一遍,和全部比:在变好还是在变差 */
  recent: { window: number; stats: PerfStats } | null;
  per_day: PerfDays;
  equity: EquityPoint[];
  groups: {
    kind: PerfGroup[];
    /** 按开仓时段(美东),与下单页「历史相似交易」同一张表:开盘半小时 / 上午 / 午后 / 尾盘一小时 / 盘外 */
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

/** 一次自动平仓:触发时的现价(中间价口径)vs 实际成交均价。只量滑点,佣金另记。 */
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
  /** 让出去的钱(美元):正 = 成交比触发价差。**不含佣金** */
  cost_usd: number;
  /** 每份让出去的 / 触发价 × 100。股票是占股价的百分比,组合与期权是占权利金的百分比:两种不是一个量 */
  cost_pct: number;
  /** 这张平仓单的佣金(美元);回报里没有是 null */
  commission_usd: number | null;
  paper: boolean;
}

/** 一种合约类型的汇总。百分比只在同一种合约里才可比,所以中位数按这个分。 */
export interface ExecutionGroup {
  sec_type: string;
  samples: number;
  /** 其中模拟账户的笔数:模拟盘的成交是撮合出来的,不代表真实滑点 */
  paper: number;
  median_pct: number | null;
  /** 中位数的 95% 区间(次序统计量,不假设分布);不到 6 笔定不出来,是 null */
  median_ci: PerfInterval | null;
  avg_usd: number | null;
}

export interface ExecutionCost {
  /** 触发价与成交均价都有的笔数 */
  samples: number;
  /** 其中模拟账户的笔数 */
  paper: number;
  /** 有平仓痕但算不出的:2026-09-26 之前的痕没记触发价、单没成交、找不到那张单 */
  missing: number;
  /** 让出去的合计与每笔平均(美元,不含佣金) */
  total_usd: number | null;
  avg_usd: number | null;
  /** 这些平仓单的佣金合计(美元);一张都没有佣金回报是 null */
  commission_usd: number | null;
  /** 每笔损耗占触发价的百分比:中位数与平均。**只在全部样本是同一种合约时才有**;
   * 股票(占股价)与组合(占权利金)混着时是 null,看 `by_sec_type` */
  median_pct: number | null;
  avg_pct: number | null;
  by_sec_type: ExecutionGroup[];
  /** 新的在前,最多 50 笔 */
  rows: ExecutionRow[];
}

// ---------------------------------------------------------------- 保护规则建议

/**
 * 日亏上限在这本账上回放的结果:每笔开仓的那一刻,当天(美东)已实现的净亏到没到线;到了,这一笔就算被拦下。
 * 和真规则同一个判法(protections.ts),不预知之后的事;到线之前已经开着的仓照常走完。
 * 粒度比真规则粗:账本把一笔交易的盈亏记在它平完的那一刻,真规则按每一批成交的回报累计,分批止损的交易真规则到线更早。
 */
export interface DailyLossReplay {
  /** 当天净亏碰到过线的日子 */
  days_hit: number;
  /** 被拦下的开仓笔数,以及其中赚的、亏的 */
  skipped: number;
  skipped_wins: number;
  skipped_losses: number;
  /** 被拦下的那些笔实际的盈亏合计(美元):负 = 拦下它们少亏这么多,正 = 少赚这么多 */
  skipped_pnl: number;
  /** 到线之后当天了结、但开仓时刻不明的笔数:判断不了会不会被拦 */
  unknown_open: number;
}

/** 一条建议:键与 settings.protections 的同名段一致,界面「按建议填入」原样发 settings.patch。 */
export type ProtectionAdvice =
  | { rule: "daily_loss"; suggested: { enabled: true; max_loss_usd: number }; replay: DailyLossReplay; reason: string; source: string }
  | { rule: "stoploss_guard"; suggested: { enabled: true; lookback_minutes: number; trigger_count: number; pause_minutes: number }; reason: string; source: string }
  | { rule: "cooldown"; suggested: { enabled: true; minutes: number }; reason: string; source: string };
