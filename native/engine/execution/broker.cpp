// broker.ts 的纯函数(定价数学、订单意图、盘口流动性、成交行……),逐句搬。BrokerRouter 在 broker_*.cpp。
#include "execution/broker.h"

#include "execution/broker_internal.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/market_js.h"
#include "util/py.h"
#include "util/tz.h"

#include <QRegularExpression>

#include <algorithm>
#include <cmath>

namespace ibkr::execution {

using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;
using detail::optNum;
using detail::prop;

// ======================================================================
// 纯计算部分
// ======================================================================

std::optional<double> bagSignedLimit(const QString& action, std::optional<double> userLimit) {
    if (!userLimit) return std::nullopt;
    return action == u"SELL" ? -*userLimit : *userLimit;
}

double autoMidLimit(double netMid, const QString& action, double slippage, std::optional<double> strikeWidthValue, double tick) {
    if (slippage < 0) throw BrokerError(u"滑点上限不能为负"_s);
    if (!std::isfinite(netMid)) throw BrokerError(u"中间价不是有限数值(%1),拒绝定价"_s.arg(pyNum(netMid)));
    if (action == u"SELL" && netMid >= 0) {
        throw BrokerError(u"贷方组合的净中间价应为负(收权利金),实际为 %1——腿方向与订单方向"_s.arg(util::fmtF(netMid, 4)) +
                          u"不一致,拒绝定价以免反向建仓。"_s);
    }
    if (action == u"BUY" && netMid <= 0) {
        throw BrokerError(u"借方组合的净中间价应为正(付权利金),实际为 %1——腿方向与订单方向"_s.arg(util::fmtF(netMid, 4)) +
                          u"不一致,拒绝定价以免反向建仓。"_s);
    }
    double limit = alignTickUp(netMid + slippage, tick);
    if (action == u"BUY") {
        // 净权利金不可能超过翼宽(§5.3a)。夹回来之后再对齐一次,方向朝下。
        if (strikeWidthValue) limit = util::jsmath::min(limit, alignTickDown(*strikeWidthValue, tick));
        if (limit <= 0) throw BrokerError(u"计算出的买入限价 %1 非正,拒绝下单"_s.arg(util::fmtF(limit, 4)));
    } else if (limit >= 0) {
        throw BrokerError(u"贷方限价 %1 已不再为负(滑点吃光了权利金),拒绝下单"_s.arg(util::fmtF(limit, 4)));
    }
    return util::pyRound(limit, 4);
}

OJson bookLiquidity(const OJson& book) {
    static const OJson emptyObj = js::object();
    static const OJson emptyArr = js::array();
    const OJson* l1p = prop(book, u"l1"_s);
    const OJson& l1 = js::nullish(l1p) ? emptyObj : *l1p;
    const OJson* bidsP = prop(book, u"bids"_s);
    const OJson* asksP = prop(book, u"asks"_s);
    const OJson& bids = js::nullish(bidsP) ? emptyArr : *bidsP;
    const OJson& asks = js::nullish(asksP) ? emptyArr : *asksP;
    OJson out = js::object();

    const OJson* spreadBps = prop(l1, u"spread_bps"_s);
    if (!js::nullish(spreadBps)) {
        out.set(u"spread_bps"_s, *spreadBps);
        const double v = js::num(spreadBps);
        out.set(u"spread_grade"_s, js::S(v <= 5 ? u"很好"_s : v <= 20 ? u"尚可"_s : v <= 60 ? u"偏宽"_s : u"很宽"_s));
    }

    const auto depth = [](const OJson& side) {
        double acc = 0;
        for (const OJson& x : side.items) {
            const double n = js::num(prop(x, u"size"_s));
            acc = acc + (std::isnan(n) || n == 0 ? 0 : n);
        }
        return acc;
    };
    const double bidDepth = depth(bids), askDepth = depth(asks);
    if (!bids.items.isEmpty() || !asks.items.isEmpty()) {
        out.set(u"bid_depth"_s, js::N(util::pyRound(bidDepth, 2)));
        out.set(u"ask_depth"_s, js::N(util::pyRound(askDepth, 2)));
        out.set(u"levels"_s, js::N(util::jsmath::max(double(bids.items.size()), double(asks.items.size()))));
        const double total = bidDepth + askDepth;
        if (total > 0) out.set(u"imbalance_pct"_s, js::N(util::pyRound(((bidDepth - askDepth) / total) * 100.0, 1)));
    } else if (js::truthy(prop(l1, u"bid_size"_s)) || js::truthy(prop(l1, u"ask_size"_s))) {
        const double b = detail::numOr0(prop(l1, u"bid_size"_s));
        const double a = detail::numOr0(prop(l1, u"ask_size"_s));
        if (b + a > 0) {
            out.set(u"imbalance_pct"_s, js::N(util::pyRound(((b - a) / (b + a)) * 100.0, 1)));
            out.set(u"l1_only"_s, js::B(true));
        }
    }
    return out;
}

std::optional<double> cleanPrice(std::optional<double> value) {
    if (!value || std::isnan(*value)) return std::nullopt;
    if (!std::isfinite(*value) || *value <= 0) return std::nullopt;
    return *value;
}

std::optional<double> cleanPriceJs(const OJson* value) {
    const double v = js::num(value);
    if (js::nullish(value) || std::isnan(v)) return std::nullopt;
    if (!std::isfinite(v) || v <= 0) return std::nullopt;
    return v;
}

double finiteQuote(std::optional<double> value) {
    if (!value || std::isnan(*value)) return 0.0;
    return std::isfinite(*value) ? *value : 0.0;
}

double finiteQuoteJs(const OJson* value) {
    const double v = js::num(value);
    if (js::nullish(value) || std::isnan(v)) return 0.0;
    return std::isfinite(v) ? v : 0.0;
}

const QSet<int> kMdErrorCodes{101, 354, 10089, 10090, 10091, 10167, 10168, 10197};

QString quoteErrorMessage(const QString& symbol, const std::vector<std::pair<double, QString>>& errors) {
    QSet<double> codes;
    for (const auto& e : errors) codes.insert(e.first);
    QStringList parts;
    for (size_t i = 0; i < errors.size() && i < 3; ++i) parts.append(util::jsNumberToString(errors[i].first) + u": "_s + errors[i].second.left(120));
    const QString raw = parts.join(u"; "_s);
    if (codes.contains(101)) {
        return u"TWS 的行情线路已用完(IBKR 默认约 100 条并发),%1 的盘口请求被拒。"_s.arg(symbol) +
               u"顶栏「断开 TWS」再重连可立即释放全部线路;若反复出现,说明有订阅没撤。"_s + u"原始报错:%1"_s.arg(raw);
    }
    if (codes.contains(10197)) {
        return u"%1 的行情被另一个会话占用(IBKR 10197):同一账号同时登着别的 TWS/客户端时,"_s.arg(symbol) +
               u"行情只发给其中一个。关掉另一个再试。原始报错:%1"_s.arg(raw);
    }
    return u"该账户没有 %1 的行情订阅(实时和延迟都没有)。SPX / SPXW / VIX 属 Cboe 指数期权,"_s.arg(symbol) +
           u"要在 IBKR 账户管理 → Market Data Subscriptions 单独订阅;纸面账户还需在实盘账户里"_s +
           u"开启「与模拟账户共享行情」。原始报错:%1"_s.arg(raw);
}

std::optional<double> strikeWidth(const OJson& contract) {
    std::vector<OJson> legs;
    if (const OJson* l = prop(contract, u"legs"_s); !js::nullish(l)) legs = std::vector<OJson>(l->items.begin(), l->items.end());
    util::market::jsSort(legs, [](const OJson& a, const OJson& b) { return js::num(prop(a, u"strike"_s)) - js::num(prop(b, u"strike"_s)); });
    const OJson* strategy = prop(contract, u"combo_strategy"_s);
    if (js::isStr(strategy) && strategy->s == u"BUTTERFLY" && legs.size() == 3) {
        return js::num(prop(legs[1], u"strike"_s)) - js::num(prop(legs[0], u"strike"_s));
    }
    if (legs.size() == 2) return std::fabs(js::num(prop(legs[0], u"strike"_s)) - js::num(prop(legs[1], u"strike"_s)));
    return std::nullopt;
}

OJson priceConditionSpec(const OJson* trigger) {
    OJson out = js::object();
    if (const OJson* v = js::propStrict(trigger, u"symbol"_s)) out.set(u"symbol"_s, *v);
    if (const OJson* v = prop(trigger, u"secType"_s)) out.set(u"secType"_s, *v);
    const OJson* op = prop(trigger, u"operator"_s);
    out.set(u"isMore"_s, js::B(js::isStr(op) && op->s == u">="));
    if (const OJson* v = prop(trigger, u"value"_s)) out.set(u"price"_s, *v);
    return out;
}

OrderIntent buildOrderIntent(const OJson& spec, const QString& accountId, std::optional<double> limitOverride, const std::optional<QString>& actionOverride) {
    const QString specAction = js::str(prop(spec, u"action"_s));
    const QString action = actionOverride ? *actionOverride : specAction;
    // limitPrice:override 给了就是它;没给取 spec.lmtPrice(JSON null = TS 的 null;没有这个键 = undefined,不等于 null)
    bool limitIsNull = false;
    std::optional<double> limitPrice;
    if (limitOverride) {
        limitPrice = limitOverride;
    } else if (const OJson* p = prop(spec, u"lmtPrice"_s)) {
        if (p->type == OJson::Null) limitIsNull = true;
        else limitPrice = js::num(p);
    }
    OrderIntent base;
    base.orderType = js::str(prop(spec, u"orderType"_s));
    base.action = action;
    base.totalQuantity = js::num(prop(spec, u"totalQuantity"_s));
    base.tif = js::str(prop(spec, u"tif"_s));
    base.outsideRth = js::truthy(prop(spec, u"outsideRth"_s));
    base.account = accountId;
    base.transmit = true;
    const QString& orderType = base.orderType;
    if (orderType == u"MKT") {
        // 市价单不带价格
    } else if (orderType == u"LMT") {
        if (limitIsNull) throw BrokerError(u"限价单缺少限价(AUTO_MID 未定价?),拒绝下单"_s);
        base.lmtPrice = limitPrice;
    } else if (orderType == u"STP") {
        base.auxPrice = optNum(prop(spec, u"auxPrice"_s));
    } else if (orderType == u"STP LMT") {
        base.lmtPrice = limitPrice;
        base.auxPrice = optNum(prop(spec, u"auxPrice"_s));
    } else if (orderType == u"TRAIL") {
        const OJson* tp = prop(spec, u"trailingPercent"_s);
        if (!(tp && tp->type == OJson::Null)) base.trailingPercent = tp ? std::optional<double>(js::num(tp)) : std::nullopt;
        else base.auxPrice = optNum(prop(spec, u"auxPrice"_s));
    } else {
        throw BrokerError(u"不支持的订单类型:%1"_s.arg(js::str(prop(spec, u"orderType"_s))));
    }
    return base;
}

bool shouldFire(const PendingTrigger& pending, double price) {
    const OJson* op = prop(pending.trigger, u"operator"_s);
    const double value = js::num(prop(pending.trigger, u"value"_s));
    if (js::isStr(op) && op->s == u">=") return price >= value;
    return price <= value;
}

std::pair<QString, int> lastRthSession(const domain::EtNow& now, const domain::Settings& settings) {
    const auto closeOf = [&](const QString& d) { return settings.early_close_days.contains(d) ? 13 * 60 : 16 * 60; };
    if (settings.isTradingDay(now.date) && now.seconds >= closeOf(now.date) * 60) return {now.date, closeOf(now.date)};
    double ordinal = util::dateOrdinal(now.date);
    for (int i = 0; i < 14; ++i) {
        ordinal -= 1;
        const QString d = util::ordinalToDate(ordinal);
        if (settings.isTradingDay(d)) return {d, closeOf(d)};
    }
    throw util::JsError(u"%1 往前两周都找不到交易日"_s.arg(now.date));
}

std::optional<BasisMatch> contemporaneousBasis(const std::vector<TimedClose>& indexBars, const std::vector<TimedClose>& futuresBars) {
    QHash<QString, double> fut;
    for (const TimedClose& b : futuresBars) {
        if (std::isfinite(b.close) && b.close > 0) fut.insert(b.time, b.close);
    }
    std::vector<TimedClose> idx;
    for (const TimedClose& b : indexBars) {
        if (std::isfinite(b.close) && b.close > 0) idx.push_back(b);
    }
    for (long long i = static_cast<long long>(idx.size()) - 1; i >= 0; --i) {
        const auto it = fut.constFind(idx[size_t(i)].time);
        if (it != fut.cend()) {
            return BasisMatch{util::pyRound(it.value() - idx[size_t(i)].close, 4), idx[size_t(i)].time, idx[size_t(i)].close, it.value()};
        }
    }
    return std::nullopt;
}

std::optional<double> parseIbTime(const OJson* value) {
    if (js::nullish(value)) return std::nullopt;
    if (value->type == OJson::Number) return std::isfinite(value->n) ? std::optional<double>(value->n) : std::nullopt;
    const QString s = util::jsTrim(js::str(value));
    if (s.isEmpty()) return std::nullopt;
    static const QRegularExpression digits(u"^[0-9]+\\z"_s);
    if (digits.match(s).hasMatch() && s.size() != 8) return util::jsStringToNumber(s) * 1000;
    if (const auto ib = util::ibWallTime(s)) return util::zonedEpoch(ib->wall, ib->tz);
    static const QRegularExpression iso(u"^([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\\.[0-9]+)?\\z"_s);
    if (const auto m = iso.match(s); m.hasMatch()) {
        return util::wallToEpoch(util::WallParts{m.captured(1).toDouble(), m.captured(2).toDouble(), m.captured(3).toDouble(), m.captured(4).toDouble(),
                                                 m.captured(5).toDouble(), m.captured(6).toDouble()},
                                 QString::fromUtf16(util::kET));
    }
    QString t = s;
    const qsizetype sp = t.indexOf(u' ');
    if (sp >= 0) t.replace(sp, 1, u'T');
    const double parsed = util::jsDateParse(t);
    return std::isfinite(parsed) ? std::optional<double>(parsed) : std::nullopt;
}

std::optional<OJson> fillRow(const OJson& contract, const OJson& execution) {
    const QString execId = detail::strOr(prop(execution, u"execId"_s));
    if (execId.isEmpty()) return std::nullopt;
    const std::optional<double> epoch = parseIbTime(prop(execution, u"time"_s));
    const QString timeIso = !epoch ? detail::strOr(prop(execution, u"time"_s)) : util::utcIso(*epoch);
    const double strike = finiteQuoteJs(prop(contract, u"strike"_s));
    const auto conId = detail::truncOrNull(prop(contract, u"conId"_s), 0);
    const auto orderId = detail::truncOrNull(prop(execution, u"orderId"_s), 0);
    const auto permId = detail::truncOrNull(prop(execution, u"permId"_s), 0);
    OJson c = js::object();
    c.set(u"secType"_s, js::S(detail::strOr(prop(contract, u"secType"_s))));
    c.set(u"symbol"_s, js::S(detail::strOr(prop(contract, u"symbol"_s))));
    c.set(u"expiry"_s, js::S(detail::strOr(prop(contract, u"lastTradeDateOrContractMonth"_s))));
    c.set(u"strike"_s, strike == 0 ? js::Null() : js::N(strike));
    c.set(u"right"_s, js::S(detail::strOr(prop(contract, u"right"_s))));
    c.set(u"tradingClass"_s, js::S(detail::strOr(prop(contract, u"tradingClass"_s))));
    c.set(u"multiplier"_s, js::S(detail::strOr(prop(contract, u"multiplier"_s))));
    c.set(u"conId"_s, detail::numOrNull(conId));
    c.set(u"currency"_s, js::S(detail::strOr(prop(contract, u"currency"_s))));
    c.set(u"exchange"_s, js::S(detail::strOr(prop(contract, u"exchange"_s))));
    OJson out = js::object();
    out.set(u"exec_id"_s, js::S(execId));
    out.set(u"time"_s, js::S(timeIso));
    out.set(u"account_id"_s, js::S(detail::strOr(prop(execution, u"acctNumber"_s))));
    out.set(u"side"_s, js::S(detail::strOr(prop(execution, u"side"_s))));
    out.set(u"shares"_s, js::N(detail::numOr0(prop(execution, u"shares"_s))));
    out.set(u"price"_s, js::N(detail::numOr0(prop(execution, u"price"_s))));
    out.set(u"order_id"_s, detail::numOrNull(orderId));
    out.set(u"perm_id"_s, detail::numOrNull(permId));
    out.set(u"order_ref"_s, js::S(detail::strOr(prop(execution, u"orderRef"_s))));
    out.set(u"commission"_s, js::N(finiteQuoteJs(prop(execution, u"commission"_s))));
    out.set(u"contract"_s, std::move(c));
    return out;
}

}  // namespace ibkr::execution
