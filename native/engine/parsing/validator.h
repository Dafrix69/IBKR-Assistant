// validator.ts:软件层硬校验——第二道防线(LLM 的输出是不可信输入:限额自己重算、方向自己复核、账户自己映射、价差结构自己验)。
// 逐句搬,每一句拒绝 / 警告的话一字不改(黄金对拍直接比字符串)。期望值:tests/fixtures/gen_validator.mjs(原模块现跑)。
//
// 形状:
//   · 订单是 ParsedOrderSchema 的输出(domain/models 的 OJson,键序同 schema);校验会**就地**复核指数期权的 tradingClass
//     (合约与每一条腿的 "tradingClass" 键),放行 / 拒绝结果里带的是改过之后的那一份——同 TS(那边改的是同一个对象);
//   · 快照是 {标的: 值}:键转大写、值 Number(v)(串、null、'' 都照 JS 换算);近期订单是 RecentOrder 的 OJson
//     (limitPrice / finalStatus 的"没给"与"null"不是一回事,按原样留着);
//   · marketStatusFn 回空 = null;抛什么都当查不到。extras 的 exposure:没给 = 这一块不查,OJson null = 读不到持仓。
//
// 照搬的 TS 怪行为(不是这里的选择):
//   · 账户别名是 Object.prototype 上的名字(constructor / toString / __proto__ …)时,批内累计 `this.batchRisk[alias] ?? 0`
//     取到的是原型上的函数,`held + notional` 成了字符串拼接,和上限一比是 NaN,于是在手风险上限**永远不拦**这种别名。这里照样不拦;
//   · nonStandardMultiplier 用 Array.find 找第一个不是 "100" 的乘数:找到的那一格是 undefined(没写 multiplier 键)时
//     和"没找到"分不开,不拒(ParsedOrderSchema 总会补 "100",生产碰不到);
//   · 重复防抖用的是全局 limits(duplicate_window_minutes / duplicate_qty_tolerance),不是按账户盖过的那一份。
#pragma once

#include "contract/config_types.h"
#include "domain/config.h"
#include "util/ordered_json.h"

#include <QHash>
#include <QList>
#include <QString>
#include <QStringList>

#include <functional>
#include <optional>
#include <utility>

namespace ibkr::parsing::validator {

inline const QStringList kValidatorCodes{
    QStringLiteral("LOW_CONFIDENCE"), QStringLiteral("UNKNOWN_ACCOUNT"), QStringLiteral("LIVE_TRADING_DISABLED"), QStringLiteral("EXCEEDS_LIMIT"),
    QStringLiteral("BAD_SPREAD"),     QStringLiteral("TRIGGER_MISMATCH"), QStringLiteral("AMBIGUOUS_TRIGGER"),   QStringLiteral("EXPIRED_CONTRACT"),
    QStringLiteral("MARKET_CLOSED"),  QStringLiteral("DUPLICATE_ORDER"), QStringLiteral("UNSUPPORTED"),          QStringLiteral("UNPRICEABLE"),
};
/// 能交易、但交易所只收限价单的时段(与 tracker 的 EXTENDED_SESSIONS 同一套语义)
inline const QStringList kExtendedStatuses{QStringLiteral("盘前"), QStringLiteral("盘后"), QStringLiteral("盘外")};

struct Issue {
    QString code;
    QString message;
};
struct ApprovedOrder {
    util::OJson order;
    contract::AccountConfig account;
    double notional = 0;
    QString signature;
    QStringList warnings;
};
struct RejectedOrder {
    util::OJson order;
    QList<Issue> issues;
};
struct ValidationOutcome {
    QList<ApprovedOrder> approved;
    QList<RejectedOrder> rejected;
};

QString primaryCode(const RejectedOrder& rejected);
QString rejectionMessage(const RejectedOrder& rejected);

/// 这一单此刻面对的时段;空 = null(退回正股表)。可以抛,抛了当查不到
using MarketStatusFn = std::function<std::optional<QString>(const util::OJson& order)>;

struct ValidatorExtras {
    /// 账户在手的敞口(openRisk 的 {riskUsd, contracts, notes})。空 = 调用方没接这一块;OJson null = 这一次读不到持仓
    std::optional<util::OJson> exposure;
    /// 这笔单是不是只在减已有的持仓;空 = 没给
    std::function<bool(const util::OJson& order, const QString& alias)> isReduction;
    /// 一张认成减仓的单放行之后叫一次;空 = 没给
    std::function<void(const util::OJson& order, const QString& alias)> consumeReduction;
    /// 设了累计上限、但这条通道核对不了时写进警告的话;空串 = 没有
    QString capNote;
    /// 券商报的账户净值(美元,按别名);空 = 没给
    std::optional<contract::OrderedMap<double>> equity;
};

class Validator {
public:
    /// snapshot / recentOrders 为空指针 = TS 的 null / undefined;settings 存一份拷贝
    Validator(const domain::Settings& settings, const domain::EtNow& nowEt, const util::OJson* snapshot = nullptr,
              const QList<util::OJson>* recentOrders = nullptr, MarketStatusFn marketStatusFn = {}, ValidatorExtras extras = {});

    const domain::Settings& settings() const { return settings_; }
    const QString& marketStatus() const { return marketStatus_; }

    QString statusFor(const util::OJson& order) const;
    /// limit 空 = 用 settings.limits.max_orders_per_input。orders 里的订单会被就地复核(tradingClass)
    ValidationOutcome validateAll(QList<util::OJson>& orders, std::optional<double> limit = std::nullopt);
    /// seenInBatch 空指针 = 不给
    std::pair<QList<Issue>, std::optional<ApprovedOrder>> validateOne(util::OJson& order, const QHash<QString, double>* seenInBatch = nullptr);

private:
    QList<Issue> checkContract(util::OJson& contract, QStringList& warnings) const;
    QList<Issue> checkSpread(const util::OJson& contract, const util::OJson& order) const;
    QList<Issue> checkVertical(const util::OJson& contract, const util::OJson& order) const;
    QList<Issue> checkButterfly(const util::OJson& contract, const util::OJson& order) const;
    QList<Issue> checkIronCondor(const util::OJson& contract, const util::OJson& order) const;
    QList<Issue> checkTrigger(const util::OJson& order, QStringList& warnings) const;
    contract::RiskBudgetConfig budgetConfig() const;
    void countInBatch(const util::OJson& order, const QString& alias, double notional);
    QList<Issue> checkOpenLimits(const util::OJson& order, const QString& alias, const contract::Limits& limits, double notional, QStringList& warnings) const;
    std::pair<double, QList<Issue>> checkLimits(const util::OJson& order, const contract::Limits& limits) const;
    QList<Issue> checkSession(const util::OJson& order, QStringList& warnings) const;
    QList<Issue> checkDuplicate(const util::OJson& order, const QString& signature, const QHash<QString, double>& seenInBatch) const;

    domain::Settings settings_;
    domain::EtNow nowEt_;
    QHash<QString, double> snapshot_;
    QList<util::OJson> recentOrders_;
    QString marketStatus_;
    MarketStatusFn marketStatusFn_;
    ValidatorExtras extras_;
    QHash<QString, double> batchRisk_;
    QHash<QString, double> batchContracts_;
};

/// 防抖与审计的订单指纹:账户 + 方向 + 合约要素,不含数量与价格
QString orderSignature(const util::OJson& order, const QString& accountAlias);
/// 组合的最大亏损宽度(每张、每乘数单位);结构不合法时给 0
double riskWidth(const util::OJson& contract);

/// 结果的 JSON(键序同 TS 的对象):account 是 config 读出来的那一份 {alias, account_id, is_paper, connection, default}
util::OJson toJson(const Issue& issue);
util::OJson toJson(const ApprovedOrder& approved);
util::OJson toJson(const RejectedOrder& rejected);
util::OJson toJson(const ValidationOutcome& outcome);

}  // namespace ibkr::parsing::validator
