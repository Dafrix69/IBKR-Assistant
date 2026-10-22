#include "execution/ib_contracts.h"

#include "util/collate.h"
#include "util/error.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/tz.h"

#include <QRegularExpression>

#include <algorithm>
#include <cmath>
#include <limits>

namespace ibkr::execution {

using namespace Qt::StringLiterals;
namespace js = util::js;

namespace {

constexpr double kInf = std::numeric_limits<double>::infinity();

/// Array.prototype.slice(start, end) 的下标换算(ToIntegerOrInfinity,负数从尾数起)
qsizetype sliceIndex(double v, qsizetype len) {
    const double rel = std::isnan(v) ? 0 : std::trunc(v);
    if (rel < 0) return static_cast<qsizetype>(std::max(static_cast<double>(len) + rel, 0.0));
    return static_cast<qsizetype>(std::min(rel, static_cast<double>(len)));
}
std::vector<double> jsSlice(const std::vector<double>& a, double start, double end) {
    const auto len = static_cast<qsizetype>(a.size());
    const qsizetype from = sliceIndex(start, len), to = sliceIndex(end, len);
    if (to <= from) return {};
    return std::vector<double>(a.begin() + from, a.begin() + to);
}

/// 整数档的阶梯:每个十进位里的 5、2.5、1,从大到小(同 TS 的 m * 10 ** e)
const std::vector<double>& roundSteps() {
    static const std::vector<double> steps = [] {
        std::vector<double> out;
        for (const double e : {5.0, 4.0, 3.0, 2.0, 1.0, 0.0, -1.0, -2.0})
            for (const double m : {5.0, 2.5, 1.0}) out.push_back(m * util::jsmath::pow(10, e));
        return out;
    }();
    return steps;
}

}  // namespace

IbContract stockContract(const QString& symbol, const QString& exchange, const QString& currency) {
    IbContract c;
    c.secType = u"STK"_s;
    c.symbol = symbol;
    c.exchange = exchange;
    c.currency = currency;
    c.conId = 0;
    return c;
}

QString thirdFriday(double year, double month) {
    const QString first = util::jsNumberToString(year) + u'-' + util::pad2(month) + u"-01"_s;
    const double wd = util::weekdayOfDate(first);  // 0 = 周一 … 4 = 周五
    const double firstFriday = 1 + std::fmod(4 - wd + 7, 7);
    return util::jsNumberToString(year) + u'-' + util::pad2(month) + u'-' + util::pad2(firstFriday + 14);
}

QString frontQuarterly(const QString& dateStr) {
    double year = util::jsStringToNumber(dateStr.mid(0, 4));
    double month = util::jsStringToNumber(dateStr.mid(5, 2));
    for (int i = 0; i < 8; i += 1) {
        if (std::fmod(month, 3) == 0 && thirdFriday(year, month) > dateStr) return util::jsNumberToString(year) + util::pad2(month);
        month += 1;
        if (month > 12) {
            month = 1;
            year += 1;
        }
    }
    throw util::JsError(u"算不出 %1 之后的季月合约"_s.arg(dateStr));
}

IbContract indexContract(const QString& symbol, const QString& exchange) {
    IbContract c;
    c.secType = u"IND"_s;
    c.symbol = symbol;
    c.exchange = exchange;
    c.currency = u"USD"_s;
    c.conId = 0;
    return c;
}

IbContract indexFuturesContract(const contract::IndexConfig& cfg, const QString& date) {
    IbContract c;
    c.secType = u"FUT"_s;
    c.symbol = cfg.futures;
    c.exchange = cfg.futures_exchange.isEmpty() ? u"CME"_s : cfg.futures_exchange;
    c.currency = u"USD"_s;
    c.lastTradeDateOrContractMonth = frontQuarterly(date);
    c.conId = 0;
    return c;
}

IbContract cryptoContract(const QString& symbol) {
    IbContract c;
    c.secType = u"CRYPTO"_s;
    c.symbol = symbol;
    c.exchange = u"PAXOS"_s;
    c.currency = u"USD"_s;
    c.conId = 0;
    return c;
}

std::optional<QString> cryptoSymbol(const QString& symbol) {
    // JS 的 $(不带 m)只认整串末尾,写成 \z
    static const QRegularExpression re(u"\\ACRYPTO:([A-Z]{2,10})\\z"_s);
    const auto m = re.match(util::jsTrim(symbol).toUpper());
    if (m.hasMatch()) return m.captured(1);
    return std::nullopt;
}

IbContract streamContract(const QString& symbol) {
    const QString raw = util::jsTrim(symbol).toUpper();
    if (const auto crypto = cryptoSymbol(raw); crypto) return cryptoContract(*crypto);
    static const QRegularExpression re(u"\\A(CONTFUT|FUT|IND):([A-Z0-9]{1,12})@([A-Z]{2,12})\\z"_s);
    if (const auto m = re.match(raw); m.hasMatch()) {
        IbContract c;
        c.secType = m.captured(1);
        c.symbol = m.captured(2);
        c.exchange = m.captured(3);
        c.currency = u"USD"_s;
        c.conId = 0;
        return c;
    }
    return stockContract(raw);
}

namespace {
/// (byClass[n].expiries ?? [])
QList<util::OJson> expiriesOf(const OJson& byClass, const QString& name) {
    const OJson* e = js::prop(byClass.get(name), u"expiries"_s);
    if (js::nullish(e)) return {};
    return e->items;
}
bool includesStr(const QList<util::OJson>& items, const QString& s) {
    return std::any_of(items.begin(), items.end(), [&](const OJson& v) { return v.type == OJson::String && v.s == s; });
}
}  // namespace

QString pickTradingClass(const QString& symbol, const contract::IndexConfig* cfg, const OJson& byClass, const QString& expiry, const QString& prefer) {
    const QStringList names = js::keys(&byClass);
    if (names.isEmpty()) return {};
    QStringList onExpiry;
    for (const QString& n : names)
        if (includesStr(expiriesOf(byClass, n), expiry)) onExpiry.append(n);
    if (!prefer.isEmpty() && onExpiry.contains(prefer)) return prefer;
    QStringList pool = onExpiry.isEmpty() ? names : onExpiry;
    const QString upper = symbol.toUpper();
    const auto rank = [&](const QString& name) -> double {
        if (name == upper) return 0;
        if (cfg && name == cfg->monthly_trading_class) return 1;
        if (cfg && name == cfg->daily_trading_class) return 2;
        return 3;
    };
    const auto cmp = [&](const QString& a, const QString& b) -> double {
        const double d = rank(a) - rank(b);
        if (d != 0) return d;
        // 同档看谁的到期日多:标准链总比调整期权那种只有一个到期日的长
        const double n = static_cast<double>(expiriesOf(byClass, b).size()) - static_cast<double>(expiriesOf(byClass, a).size());
        return n != 0 ? n : util::localeCompare(a, b);
    };
    std::stable_sort(pool.begin(), pool.end(), [&](const QString& a, const QString& b) { return cmp(a, b) < 0; });
    return pool.first();
}

double strikeRoundness(double strike) {
    const auto& steps = roundSteps();
    for (const double step : steps) {
        const double q = strike / step;
        if (std::abs(q - util::jsRound(q)) < 1e-6) return step;
    }
    return steps.back();
}

std::vector<double> chainStrikes(const std::vector<double>& grid, double spot, double width, std::optional<double> span) {
    // [...new Set(grid)]:留下来的只有有限的正数,去重用 == 就够(NaN 与 ±0 都被下面那道筛子筛掉)
    std::vector<double> sorted;
    for (const double k : grid)
        if (std::isfinite(k) && k > 0 && std::find(sorted.begin(), sorted.end(), k) == sorted.end()) sorted.push_back(k);
    std::stable_sort(sorted.begin(), sorted.end(), [](double a, double b) { return a - b < 0; });
    if (sorted.empty()) return {};
    const auto dist = [&](double k) { return std::abs(k - spot); };
    std::size_t nearest = 0;
    for (std::size_t i = 1; i < sorted.size(); i++)
        if (dist(sorted[i]) < dist(sorted[nearest])) nearest = i;
    const double near = static_cast<double>(nearest);
    const std::vector<double> plain = jsSlice(sorted, util::jsmath::max(0, near - width), near + width + 1);
    if (!span || !(*span > 0)) return plain;
    std::vector<double> wanted;
    for (const double k : sorted)
        if (dist(k) <= *span) wanted.push_back(k);
    const double lo = plain.empty() ? kInf : plain.front(), hi = plain.empty() ? -kInf : plain.back();
    const auto covered = [&](const std::optional<double>& k) { return !k || (*k >= lo && *k <= hi); };
    const std::optional<double> wFirst = wanted.empty() ? std::nullopt : std::optional<double>(wanted.front());
    const std::optional<double> wLast = wanted.empty() ? std::nullopt : std::optional<double>(wanted.back());
    if (covered(wFirst) && covered(wLast)) return plain;
    const double budget = 2 * width + 1;
    if (static_cast<double>(wanted.size()) <= budget) return wanted;
    const double atm = sorted[nearest];
    const auto reach = [&](double k) { return k == atm ? -1 : dist(k) / strikeRoundness(k); };
    // reach(a) - reach(b) || dist(a) - dist(b) || a - b:NaN 与 0 都算"一样",往下一格比
    const auto cmp = [&](double a, double b) {
        const double r = reach(a) - reach(b);
        if (r != 0 && !std::isnan(r)) return r;
        const double d = dist(a) - dist(b);
        if (d != 0 && !std::isnan(d)) return d;
        return a - b;
    };
    std::vector<double> ranked = wanted;
    std::stable_sort(ranked.begin(), ranked.end(), [&](double a, double b) { return cmp(a, b) < 0; });
    std::vector<double> out = jsSlice(ranked, 0, budget);
    std::stable_sort(out.begin(), out.end(), [](double a, double b) { return a - b < 0; });
    return out;
}

IbContract optionContract(const QString& symbol, const QString& expiry, double strike, const QString& right, const QString& exchange,
                          const QString& currency, const QString& multiplier, const QString& tradingClass) {
    IbContract c;
    c.secType = u"OPT"_s;
    c.symbol = symbol;
    c.exchange = exchange;
    c.currency = currency;
    c.lastTradeDateOrContractMonth = expiry;
    c.strike = strike;
    c.right = right;
    c.multiplier = multiplier;
    c.tradingClass = tradingClass;
    c.conId = 0;
    return c;
}

QString describeContract(const IbContract& contract) {
    QStringList parts{contract.symbol.isEmpty() ? u"?"_s : contract.symbol, contract.secType.isEmpty() ? u"?"_s : contract.secType};
    // 只写真值(空串、0、NaN 都跳过)
    if (contract.lastTradeDateOrContractMonth && !contract.lastTradeDateOrContractMonth->isEmpty()) parts.append(*contract.lastTradeDateOrContractMonth);
    if (contract.strike && *contract.strike != 0 && !std::isnan(*contract.strike)) parts.append(util::jsNumberToString(*contract.strike));
    if (contract.right && !contract.right->isEmpty()) parts.append(*contract.right);
    if (contract.tradingClass && !contract.tradingClass->isEmpty()) parts.append(*contract.tradingClass);
    return parts.join(u' ');
}

}  // namespace ibkr::execution
