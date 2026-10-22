#include "execution/auto_mid.h"

#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/py.h"

namespace ibkr::execution {

using namespace Qt::StringLiterals;

double comboNaturalPrice(const std::vector<LegQuote>& legs) {
    if (legs.empty()) throw BrokerError(u"没有腿报价,无法计算立刻成交的价"_s);
    double net = 0.0;
    for (const LegQuote& leg : legs) {
        legMid(leg);  // 坏盘口(缺一边、倒挂)在这里抛,和中间价同一道守卫
        net += leg.action == u"BUY" ? leg.ask * leg.ratio : -leg.bid * leg.ratio;
    }
    return util::pyRound(net, 4);
}

double autoMidShareLimit(const std::vector<LegQuote>& legs, const QString& action, double share, std::optional<double> strikeWidth, double tick) {
    if (!(share >= 0 && share <= 1)) throw BrokerError(u"让价的份额要在 0 到 1 之间(收到 %1)"_s.arg(util::jsNumberToString(share)));
    const double mid = comboMidPrice(legs);
    if (action == u"SELL" && mid >= 0) {
        throw BrokerError(u"贷方组合的净中间价应为负(收权利金),实际为 %1——腿方向与订单方向不一致,拒绝定价以免反向建仓。"_s.arg(util::fmtF(mid, 4)));
    }
    if (action == u"BUY" && mid <= 0) {
        throw BrokerError(u"借方组合的净中间价应为正(付权利金),实际为 %1——腿方向与订单方向不一致,拒绝定价以免反向建仓。"_s.arg(util::fmtF(mid, 4)));
    }
    const double natural = comboNaturalPrice(legs);
    double limit = alignTickUp(mid + share * (natural - mid), tick);
    if (action == u"BUY") {
        if (strikeWidth) limit = util::jsmath::min(limit, alignTickDown(*strikeWidth, tick));
        if (limit <= 0) throw BrokerError(u"计算出的买入限价 %1 非正,拒绝下单"_s.arg(util::fmtF(limit, 4)));
    } else if (limit >= 0) {
        throw BrokerError(u"贷方限价 %1 已不再为负(让价吃光了权利金),拒绝下单"_s.arg(util::fmtF(limit, 4)));
    }
    return util::pyRound(limit, 4);
}

}  // namespace ibkr::execution
