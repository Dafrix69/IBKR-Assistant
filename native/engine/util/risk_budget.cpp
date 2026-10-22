#include "util/risk_budget.h"

#include "util/jsformat.h"

namespace ibkr::util {

using namespace Qt::StringLiterals;

namespace {
QString money(double v) { return u'$' + jsToFixed(v, 2); }
/// `${Number((Math.round(v * 10 + 1e-9) / 10).toFixed(1))}%`
QString pct(double v) { return jsNumberToString(jsStringToNumber(jsToFixed(jsRound(v * 10 + 1e-9) / 10, 1))) + u'%'; }
}  // namespace

std::optional<QString> riskBudgetWarning(const contract::RiskBudgetConfig& cfg, const QString& accountAlias, const QString& secType, double exposure) {
    if (!cfg.enabled || !(exposure > 0)) return std::nullopt;
    const double* found = cfg.equity_usd.find(accountAlias);
    const double equity = found ? *found : 0;
    if (!(equity > 0)) return std::nullopt;
    const double share = (exposure / equity) * 100;
    if (secType == u"STK") {
        if (share <= cfg.max_position_pct) return std::nullopt;
        return u"单笔仓位:名义金额约 %1,占 %2 权益 %3 的 %4,超过你定的 %5。最坏亏多少取决于止损——下单后记得在持仓追踪里设上(只提醒,不拦单)"_s
            .arg(money(exposure), accountAlias, money(equity), pct(share), pct(cfg.max_position_pct));
    }
    if (share <= cfg.max_risk_pct) return std::nullopt;
    return u"单笔风险:最坏亏损约 %1,占 %2 权益 %3 的 %4,超过你定的 %5(只提醒,不拦单)"_s
        .arg(money(exposure), accountAlias, money(equity), pct(share), pct(cfg.max_risk_pct));
}

}  // namespace ibkr::util
