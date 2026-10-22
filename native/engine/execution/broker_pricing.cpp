#include "execution/broker_pricing.h"

#include "util/jsformat.h"
#include "util/py.h"

#include <cmath>

namespace ibkr::execution {

using namespace Qt::StringLiterals;

QString pyNum(double v) {
    if (std::isnan(v)) return u"nan"_s;
    if (!std::isfinite(v)) return v > 0 ? u"inf"_s : u"-inf"_s;
    // Number.isInteger
    return v == std::trunc(v) ? util::jsNumberToString(v) + u".0"_s : util::jsNumberToString(v);
}

double legMid(const LegQuote& leg) {
    // NaN 在比较运算里全为 false,必须显式 isFinite
    if (!std::isfinite(leg.bid) || !std::isfinite(leg.ask) || leg.bid <= 0 || leg.ask <= 0 || leg.ask < leg.bid) {
        throw BrokerError(u"盘口不可用(bid=%1 ask=%2),拒绝用坏报价定价"_s.arg(pyNum(leg.bid), pyNum(leg.ask)));
    }
    return (leg.bid + leg.ask) / 2.0;
}

double comboMidPrice(const std::vector<LegQuote>& legs) {
    if (legs.empty()) throw BrokerError(u"没有腿报价,无法计算中间价"_s);
    double net = 0.0;
    for (const LegQuote& leg : legs) {
        const double sign = leg.action == u"BUY" ? 1.0 : -1.0;
        net += sign * legMid(leg) * leg.ratio;
    }
    return util::pyRound(net, 4);
}

double alignTickUp(double value, double tick) {
    if (!std::isfinite(value) || tick <= 0 || !std::isfinite(tick)) return value;
    // 减一点容差:已经对齐的值不该因浮点误差被推到下一档(0.20/0.05 = 4.000000001 → 5)
    return util::pyRound(std::ceil(value / tick - 1e-9) * tick, 4);
}

double alignTickDown(double value, double tick) {
    if (!std::isfinite(value) || tick <= 0 || !std::isfinite(tick)) return value;
    return util::pyRound(std::floor(value / tick + 1e-9) * tick, 4);
}

}  // namespace ibkr::execution
