// 限额、策略开关、保护规则、单笔风险预算——engine-ts/src/contract/settings.ts 的类型,字段名照原样(TS 用蛇形,这里也是)。
// 只有类型,没有逻辑;读配置、给默认值、校验在 domain/config。
// TS 里"可以是 undefined / null / 数"三态的格子(按账户覆盖的限额)用 QJsonValue 存,不压成 optional,免得丢掉"没写"与"写成 null"的区别。
#pragma once

#include "contract/ordered_map.h"

#include <QJsonValue>
#include <QString>

namespace ibkr::contract {

/// 能按账户覆盖的那几项:每格是 Undefined(没写)/ Null(写成 null = 用全局的)/ 数
struct AccountLimits {
    QJsonValue max_order_notional = QJsonValue::Undefined;
    QJsonValue max_option_contracts = QJsonValue::Undefined;
    QJsonValue max_mkt_shares = QJsonValue::Undefined;
    QJsonValue max_open_risk_usd = QJsonValue::Undefined;
    QJsonValue max_underlying_contracts = QJsonValue::Undefined;
    bool operator==(const AccountLimits&) const = default;
};

struct Limits {
    double max_order_notional = 0;
    double max_option_contracts = 0;
    double max_mkt_shares = 0;
    double min_confidence = 0;
    double max_spread_slippage = 0;
    double max_orders_per_input = 0;
    double duplicate_window_minutes = 0;
    double duplicate_qty_tolerance = 0;
    double max_open_risk_usd = 0;  // 0 = 不设
    double max_underlying_contracts = 0;  // 0 = 不设
    double auto_mid_spread_share = 0;  // 0 = 不用它
    OrderedMap<AccountLimits> by_account;
};

struct Policies {
    bool auto_outside_rth = true;
    bool require_trigger_price_verification = false;
    double trigger_min_gap_bps = 0;
    QString closed_market_policy;
    bool review_feature_enabled = false;
};

struct StoplossGuardConfig {
    bool enabled = false;
    double lookback_minutes = 0;
    double trigger_count = 0;
    double pause_minutes = 0;
};

struct MaxDrawdownConfig {
    bool enabled = false;
    double lookback_minutes = 0;
    double max_drawdown_usd = 0;
    double pause_minutes = 0;
};

struct CooldownConfig {
    bool enabled = false;
    double minutes = 0;
    QString scope;  // "symbol" / "position"
};

struct DailyLossConfig {
    bool enabled = false;
    double max_loss_usd = 0;
    QString basis;  // "realized" / "account"
};

struct ProtectionsConfig {
    StoplossGuardConfig stoploss_guard;
    MaxDrawdownConfig max_drawdown;
    CooldownConfig cooldown;
    DailyLossConfig daily_loss;
};

struct RiskBudgetConfig {
    bool enabled = false;
    OrderedMap<double> equity_usd;  // 账户别名 → 权益(美元)
    double max_risk_pct = 0;
    double max_position_pct = 0;
};

/// 蝶式入场助手(只给建议和标记,不碰下单):阈值的默认值 = 研究里的数,见 docs/features/fly-entry-assist.md
struct FlyEntryAssistConfig {
    bool enabled = true;
    double width_mult = 2.0;
    double width_floor_mult = 1.5;
    double prior_drop_pct = 1.0;
    QString prior_drop_after_et;  // "HH:MM" 美东
    QString thursday_before_et;
    double spx_put_wall_straddle_mult = 5.9;
    double spy_put_wall_pct = 1.31;
    QString late_entry_et;
};

/// 交易纪律守护(guard):开仓前要有交易意图、股票仓位必须有止损。见 docs/features/guard.md。
/// enabled 默认关:它会替没有止损的股票仓位在券商挂止损单,第一次打开之前先在纸面账户上看它跑一遍
struct GuardConfig {
    bool enabled = false;
    double grace_s = 60;            // 发现没有意图的股票仓位后,等多久补录再挂默认止损
    double max_loss_pct_nav = 2.0;  // 单笔最坏亏损占净值的上限
    double wide_stop_pct = 8.0;     // 止损距离超过入场价的这个比例,数量先减半再比
    double default_stop_pct = 8.0;  // 默认止损:入场价往不利方向让这么多
    double default_low_days = 10;   // 默认止损:前几个交易日的最低价(空头取最高价)
    double tick_s = 5;              // 盯仓位的节拍
    QString inbox_path;             // 意图收件文件;空 = 交易库同目录下的 guard/intents.jsonl
};

}  // namespace ibkr::contract
