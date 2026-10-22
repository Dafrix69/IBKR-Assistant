// 单笔风险预算(docs/features/risk-budget.md):一单占账户权益太多时给一句告警,不拦单。engine-ts/src/riskBudget.ts 逐句搬。
// exposure 就是校验层算好的敞口:期权与组合是最坏亏损,股票是名义金额。期望值:tests/fixtures/gen_risk_budget.mjs
#pragma once

#include "contract/settings.h"

#include <QString>

#include <optional>

namespace ibkr::util {

/// 超了回一句中文告警;没超 / 没开 / 这个账户没填权益 / 敞口不是正数回空
std::optional<QString> riskBudgetWarning(const contract::RiskBudgetConfig& cfg, const QString& accountAlias, const QString& secType, double exposure);

}  // namespace ibkr::util
