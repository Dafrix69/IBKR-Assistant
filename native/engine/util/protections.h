// 保护规则:比"连续失败熔断"细一档的自动执行暂停(engine-ts/src/protections.ts 逐句搬)。
// 只挡新单、永不挡平仓;不落终态(从库里现算,到点自己过去);算不出来就放行。纯函数,时间由调用方给。
// 期望值:tests/fixtures/gen_protections.mjs(原模块在随机的平仓 / 盈亏序列上现跑)
#pragma once

#include "contract/settings.h"

#include <QJsonObject>
#include <QString>
#include <QStringList>

#include <optional>
#include <vector>

namespace ibkr::util {

struct CloseEvent {
    double atMs = 0;
    QString symbol;
    QString state;  // tracker 的 STATE_*(可能带 sweep: 前缀)
    QString leg;    // 没给就是空串(TS 的 close.leg ?? "")
};

struct PnlEvent {
    double atMs = 0;
    double pnl = 0;
};

struct ProtectionPause {
    QString rule;
    QString reason;
    double untilMs = 0;
};

struct ProtectionState {
    std::optional<ProtectionPause> pause;
    contract::OrderedMap<ProtectionPause> cooldowns;
    contract::OrderedMap<ProtectionPause> accountPauses;
};

QString cooldownKey(const QString& symbol, const QString& leg);
bool isStopLike(const QString& state);
/// 美东某一天的零点;offsetDays = 1 是第二天零点
double etDayStart(double nowMs, int offsetDays = 0);
bool protectionsEnabled(const contract::ProtectionsConfig& cfg);
bool needsPnlEvents(const contract::ProtectionsConfig& cfg);
double protectionsSince(const contract::ProtectionsConfig& cfg, double nowMs);
/// accountDaily 空 = TS 的 null
ProtectionState evaluateProtections(const contract::ProtectionsConfig& cfg, const std::vector<CloseEvent>& closes, const std::vector<PnlEvent>& pnl, double nowMs,
                                    const std::optional<contract::OrderedMap<double>>& accountDaily = std::nullopt, const QStringList& accountsExpected = {});
/// 这张单现在能不能发:拦截原因,放行回空
std::optional<QString> protectionBlock(const ProtectionState& state, const QString& symbol, double nowMs, const QString& account = {}, const QString& leg = {});
/// system.status 里的 protections 段
QJsonObject protectionsSummary(const ProtectionState& state, double nowMs);

}  // namespace ibkr::util
