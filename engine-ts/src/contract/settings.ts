/** settings.* / keychain.set / data.export:限额、策略开关、保护规则——界面「设置」页读写的那一份。类型文件,不 import 任何东西。
 *
 * Limits / Policies / 保护规则的配置原来定义在 config.ts 与 protections.ts,界面那头另手抄了一份(只抄了一半的字段);
 * 现在定义搬到这里,那两个文件转出。
 */

// ---------------------------------------------------------------- 限额与策略
export interface Limits {
  max_order_notional: number;
  max_option_contracts: number;
  max_mkt_shares: number;
  min_confidence: number;
  max_spread_slippage: number;
  max_orders_per_input: number;
  duplicate_window_minutes: number;
  duplicate_qty_tolerance: number;
}

export interface Policies {
  auto_execute: boolean;
  allow_live_trading: boolean;
  /** 组合(BAG)自动平仓:纸面账户不受此开关约束,实盘账户必须显式打开。
   * 平组合要反转每条腿再发 BAG 单,这条路还没在真机上核对过——在核对通过之前,
   * "允许碰实盘"和"信任这条新路径"是两件事,分开授权。 */
  allow_combo_live: boolean;
  /** 合约此刻在盘外时段能交易时,自动给订单打上 outsideRth。
   * 不打这个标志的后果是单子挂着不动——IBKR 会等到常规时段才送交易所。
   * 默认开;盘外流动性薄、点差宽,不想在那个时段成交就关掉它。 */
  auto_outside_rth: boolean;
  require_trigger_price_verification: boolean;
  trigger_min_gap_bps: number;
  closed_market_policy: string;
  consecutive_failure_breaker: number;
  review_feature_enabled: boolean;
}

// ---------------------------------------------------------------- 保护规则
/** 单条规则的开关与参数。全部默认关闭:老用户升级后行为一字不变。 */
export interface StoplossGuardConfig {
  enabled: boolean;
  /** 往回看多少分钟。 */
  lookback_minutes: number;
  /** 窗口内几次止损算数。 */
  trigger_count: number;
  /** 触发后暂停多久(从最后一次止损算起)。 */
  pause_minutes: number;
}

export interface MaxDrawdownConfig {
  enabled: boolean;
  lookback_minutes: number;
  /** 已实现盈亏从窗口内峰值回撤多少美元算触发。 */
  max_drawdown_usd: number;
  pause_minutes: number;
}

export interface CooldownConfig {
  enabled: boolean;
  /** 一只标的平仓后,多少分钟内不再对它下新单。 */
  minutes: number;
}

/** 日内亏损上限:当天(美东)已实现盈亏亏到线,当天剩下的时间不再下新单。 */
export interface DailyLossConfig {
  enabled: boolean;
  /** 当天已实现亏损达到多少美元算触发(填正数)。 */
  max_loss_usd: number;
}

export interface ProtectionsConfig {
  stoploss_guard: StoplossGuardConfig;
  max_drawdown: MaxDrawdownConfig;
  cooldown: CooldownConfig;
  daily_loss: DailyLossConfig;
}

// ---------------------------------------------------------------- 单笔风险预算
/** 单笔风险预算(docs/features/risk-budget.md):一单的最坏亏损 / 名义金额占账户权益太多时**只告警、不拦单**。
 *  权益是人填的:引擎不向券商要 NetLiquidation(那条路没在真机上核对过),仓位计算器也是这么做的。默认关。 */
export interface RiskBudgetConfig {
  enabled: boolean;
  /** 账户别名 → 权益(美元)。没填、填 0 的账户不告警 */
  equity_usd: Record<string, number>;
  /** 期权 / 组合:最坏亏损占权益超过这个百分比就告警 */
  max_risk_pct: number;
  /** 股票:名义金额占权益超过这个百分比就告警(股票的最坏亏损取决于止损,下单时不知道) */
  max_position_pct: number;
}

// ---------------------------------------------------------------- settings.get
/** 给界面看的账户:账号打了码,真账号不出引擎。 */
export interface AccountView {
  alias: string;
  account_masked: string;
  is_paper: boolean;
  connection: string;
  /** 这个账户走哪家券商:ibkr / futu */
  broker: string;
  default: boolean;
}

export interface SettingsView {
  /** 配置文件的路径 */
  path: string;
  llm: { model: string; effort: string; max_tokens: number };
  limits: Limits;
  policies: Policies;
  protections: ProtectionsConfig;
  risk_budget: RiskBudgetConfig;
  symbol_aliases: Record<string, string>;
  accounts: AccountView[];
  /** 只给 host / port:账户与连接不许从界面改(见 settings.patch) */
  connections: Record<string, { host: string; port: number }>;
}

// ---------------------------------------------------------------- settings.patch
/** 界面「设置」页能改的四段,每段只给要改的键。**只有这四段**:别的顶层段 handler 当场拒(不认识的不再被写进配置文件;
 *  模型配置走 llm.patch——它有自己的字段白名单,券商切换走 broker.select,账户 / 连接 / 库路径只能手改配置文件)。 */
export interface SettingsPatch {
  policies?: Partial<Policies>;
  limits?: Partial<Limits>;
  protections?: {
    stoploss_guard?: Partial<StoplossGuardConfig>;
    max_drawdown?: Partial<MaxDrawdownConfig>;
    cooldown?: Partial<CooldownConfig>;
    daily_loss?: Partial<DailyLossConfig>;
  };
  risk_budget?: Partial<RiskBudgetConfig>;
}

/**
 * 进 handler 时的样子:schema 只确认 patch 是个对象,**里面的值由 config.fromDict 校验**——它对每一段都拒绝不认识的键
 * (「policies 里有未知配置项:auto_excute」)、查类型与范围、给中文原因,校验不过就不写盘。所以这里的值是 unknown:
 * 它们确实还没验过。界面照 SettingsPatch 给;accounts / connections 两段不许改(牵涉真实账号,只能手改配置文件)。
 */
export type SettingsPatchInput = { readonly [K in keyof SettingsPatch]?: unknown } & { readonly [section: string]: unknown };

export interface SettingsPatchParams {
  /** 不给 = 空补丁(等于只重新加载一遍配置) */
  patch?: SettingsPatchInput;
}

// ---------------------------------------------------------------- keychain.set / data.export
export interface KeychainSetParams {
  /** API Key 明文:只经过这一跳写进系统凭证库,不落盘、不回显、不进日志 */
  secret: string;
  /** 给哪家供应商存;不给 = 当前生效的那家 */
  provider?: string;
}

export interface DataExportParams {
  /** 导出到哪个文件 */
  path: string;
}

export interface DataExportResult {
  path: string;
  /** 导出了多少条交易记录 */
  records: number;
}
