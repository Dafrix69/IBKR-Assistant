/** settings.* / keychain.set / data.export:限额、策略开关、保护规则——界面「设置」页读写的那一份。类型文件,不 import 任何东西。
 *
 * Limits / Policies / 保护规则的配置原来定义在 config.ts 与 protections.ts,界面那头另手抄了一份(只抄了一半的字段);
 * 现在定义搬到这里,那两个文件转出。
 */

import type { FollowConfig } from "./follow.js";

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
  /** 在手期权 / 组合的最坏亏损合计上限(美元,每个账户各算各的):在手的 + 这一单超过就拒。0 = 不设。
   *  正股不计(它最坏亏多少取决于止损);在减已有持仓的单不受它限制 */
  max_open_risk_usd: number;
  /** 同一账户、同一标的、同一到期日在手的期权张数上限(组合按组数、不在组合里的单腿按张数):在手的 + 这一单超过就拒。0 = 不设 */
  max_underlying_contracts: number;
  /** AUTO_MID 的限价朝成交方向让多少:中间价到「立刻成交的价」那一段的这么大一份(0–1;1 = 直接挂到立刻成交的价)。
   *  0 = 不用它,照 max_spread_slippage 让一个固定的金额 */
  auto_mid_spread_share: number;
  /** 按账户覆盖:账户别名 → 只写要和全局不一样的那几项。没写的、写成 null 的用全局的 */
  by_account: Record<string, AccountLimits>;
}

/** 能按账户覆盖的那几项限额(纸面账户与实盘账户不该被迫用同一套)。null = 这个账户不覆盖这一项 */
export type AccountLimits = {
  [K in "max_order_notional" | "max_option_contracts" | "max_mkt_shares" | "max_open_risk_usd" | "max_underlying_contracts"]?: number | null;
};

export interface Policies {
  auto_execute: boolean;
  allow_live_trading: boolean;
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
  /** 冷却挡的是什么:"symbol" = 这只标的的一切新单(默认);"position" = 只挡和刚平掉的那份持仓同一个结构的单
   *  (同到期、同行权价、同方向)——只做一个标的的人,按标的冷却等于整体暂停 */
  scope: string;
}

/** 日内亏损上限:当天(美东)已实现盈亏亏到线,当天剩下的时间不再下新单。 */
export interface DailyLossConfig {
  enabled: boolean;
  /** 当天已实现亏损达到多少美元算触发(填正数)。 */
  max_loss_usd: number;
  /** 拿什么算"今天亏了多少":"realized" = 引擎发的单的已实现盈亏(默认);"account" = 券商报的账户当日盈亏
   *  (含未平仓的浮亏、含在 TWS 里手动做的单,每个账户各算各的;券商没报时退回 realized) */
  basis: string;
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
  /** Discord 跟单的配置(见 follow.ts) */
  follow: FollowConfig;
  symbol_aliases: Record<string, string>;
  accounts: AccountView[];
  /** 只给 host / port:账户与连接不许从界面改(见 settings.patch) */
  connections: Record<string, { host: string; port: number }>;
}

// ---------------------------------------------------------------- settings.patch
/** 界面能改的五段(前四段在「设置」页,follow 在「接入 → Discord 跟单」),每段只给要改的键。**只有这五段**:别的顶层段 handler 当场拒(不认识的不再被写进配置文件;
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
  follow?: Partial<FollowConfig>;
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

// ---------------------------------------------------------------- data.backups / data.backup
/** 一份备份是为什么出的:每天第一次打开时 / 升级迁移之前 / 用户点的(以及恢复之前自动留的那一份)。 */
export type BackupReason = "daily" | "upgrade" | "manual";

export interface BackupInfo {
  /** 文件名(不带目录):trades-年月日-时分秒-原因.db,时间是 UTC */
  name: string;
  reason: BackupReason;
  /** 出这份备份的时刻,ISO 8601(UTC) */
  at: string;
  bytes: number;
}

export interface DataBackupsResult {
  /** 交易库文件 */
  db_path: string;
  /** 备份放在哪个目录 */
  dir: string;
  /** 这个版本的软件认的库结构版本 */
  schema_version: number;
  /** 新的在前 */
  backups: BackupInfo[];
}
