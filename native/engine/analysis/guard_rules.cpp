#include "analysis/guard_rules.h"

#include "util/jsformat.h"
#include "util/js_runtime.h"
#include "util/jsobj.h"
#include "util/py.h"

#include <QRegularExpression>

#include <algorithm>
#include <cmath>

namespace ibkr::analysis::guard {

using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;

namespace {

QString fmt(double v) { return util::jsNumberToString(util::pyRound(v, 2)); }

std::optional<double> positiveNum(const OJson& line, const QString& key) {
    const OJson* v = line.get(key);
    if (!js::isNum(v) || !std::isfinite(v->n) || v->n <= 0) return std::nullopt;
    return v->n;
}

QString text(const OJson& line, const QString& key) { return js::isStr(line.get(key)) ? line.get(key)->s.trimmed() : QString(); }

IntentVerdict fail(const QString& why) {
    IntentVerdict v;
    v.error = why;
    return v;
}

}  // namespace

IntentVerdict checkStockIntent(const OJson& line, const QString& account, double nav, const contract::GuardConfig& cfg) {
    const QString symbol = text(line, u"symbol"_s).toUpper();
    if (symbol.isEmpty()) return fail(u"缺 symbol"_s);
    const QString side = text(line, u"side"_s).toUpper();
    if (side != u"BUY" && side != u"SELL") return fail(u"side 只能是 BUY 或 SELL"_s);
    const auto qtyIn = positiveNum(line, u"qty"_s);
    if (!qtyIn || *qtyIn != std::floor(*qtyIn)) return fail(u"qty 必须是正整数"_s);
    const auto entry = positiveNum(line, u"entry_price"_s);
    if (!entry) return fail(u"缺 entry_price(计划入场价)"_s);
    const auto stop = positiveNum(line, u"stop_price"_s);
    if (!stop) return fail(u"缺 stop_price(止损价必填)"_s);
    const bool isLong = side == u"BUY";
    if (isLong && *stop >= *entry) return fail(u"买入的止损价要低于入场价(入场 %1,止损 %2)"_s.arg(fmt(*entry), fmt(*stop)));
    if (!isLong && *stop <= *entry) return fail(u"卖空的止损价要高于入场价(入场 %1,止损 %2)"_s.arg(fmt(*entry), fmt(*stop)));
    const QString reason = text(line, u"stop_reason"_s);
    if (reason.isEmpty()) return fail(u"缺 stop_reason(止损理由必填,一句话)"_s);
    if (!(nav > 0)) return fail(u"读不到这个账户的净值,算不了单笔亏损占比"_s);

    IntentVerdict v;
    const double perShare = std::abs(*entry - *stop);
    const double stopPct = perShare / *entry * 100.0;
    double qty = *qtyIn;
    if (stopPct > cfg.wide_stop_pct) {
        qty = std::floor(qty / 2.0);
        if (qty < 1) return fail(u"止损距离 %1% 超过 %2%,数量减半后为 0"_s.arg(fmt(stopPct), fmt(cfg.wide_stop_pct)));
        v.notes << u"止损距离 %1% 超过 %2%,数量从 %3 减半到 %4"_s.arg(fmt(stopPct), fmt(cfg.wide_stop_pct), util::jsNumberToString(*qtyIn),
                                                                       util::jsNumberToString(qty));
    }
    const double maxLoss = perShare * qty;
    const double lossPct = maxLoss / nav * 100.0;
    if (lossPct > cfg.max_loss_pct_nav) {
        const double cap = std::floor(nav * cfg.max_loss_pct_nav / 100.0 / perShare);
        return fail(u"最坏亏损 $%1 占净值 %2%,超过上限 %3%;这个止损下最多 %4 股"_s.arg(fmt(maxLoss), fmt(lossPct), fmt(cfg.max_loss_pct_nav),
                                                                                       util::jsNumberToString(std::max(0.0, cap))));
    }

    OJson intent = js::object({{u"kind"_s, js::S(u"stock"_s)},
                               {u"account"_s, js::S(account)},
                               {u"symbol"_s, js::S(symbol)},
                               {u"side"_s, js::S(side)},
                               {u"qty"_s, js::N(qty)},
                               {u"qty_requested"_s, js::N(*qtyIn)},
                               {u"entry_price"_s, js::N(*entry)},
                               {u"stop_price"_s, js::N(*stop)},
                               {u"stop_reason"_s, js::S(reason)},
                               {u"max_loss_usd"_s, js::N(util::pyRound(maxLoss, 2))},
                               {u"max_loss_pct_nav"_s, js::N(util::pyRound(lossPct, 2))},
                               {u"nav"_s, js::N(util::pyRound(nav, 2))},
                               {u"thesis"_s, js::S(text(line, u"thesis"_s))},
                               {u"invalidation"_s, js::S(text(line, u"invalidation"_s))}});
    if (text(line, u"thesis"_s).isEmpty() || text(line, u"invalidation"_s).isEmpty()) v.notes << u"没写 thesis 或 invalidation"_s;
    v.ok = true;
    v.intent = intent;
    return v;
}

IntentVerdict checkOptionIntent(const OJson& line, const QString& account) {
    const QString symbol = text(line, u"symbol"_s).toUpper();
    if (symbol.isEmpty()) return fail(u"缺 symbol(标的)"_s);
    const QString structure = text(line, u"structure"_s);
    if (structure.isEmpty()) return fail(u"缺 structure(结构,例如 QQQ 660/670/680 call fly)"_s);
    const QString expiry = text(line, u"expiry"_s);
    static const QRegularExpression dateRe(u"^\\d{4}-\\d{2}-\\d{2}$"_s);
    if (!dateRe.match(expiry).hasMatch()) return fail(u"expiry 要写成 YYYY-MM-DD"_s);
    const auto cost = positiveNum(line, u"cost_usd"_s);
    if (!cost) return fail(u"缺 cost_usd(成本,美元)"_s);
    const OJson* rules = line.get(u"exit_rules"_s);
    if (!js::isObj(rules)) return fail(u"缺 exit_rules"_s);
    OJson exits = js::object();
    for (const QString& k : {u"take_profit"_s, u"stop_loss"_s, u"time_stop"_s}) {
        const QString t = text(*rules, k);
        if (t.isEmpty()) return fail(u"exit_rules.%1 必填"_s.arg(k));
        exits.set(k, js::S(t));
    }
    const QString level = text(*rules, u"level_stop"_s);
    if (!level.isEmpty()) exits.set(u"level_stop"_s, js::S(level));
    IntentVerdict v;
    v.ok = true;
    v.intent = js::object({{u"kind"_s, js::S(u"option"_s)},
                           {u"account"_s, js::S(account)},
                           {u"symbol"_s, js::S(symbol)},
                           {u"structure"_s, js::S(structure)},
                           {u"expiry"_s, js::S(expiry)},
                           {u"cost_usd"_s, js::N(*cost)},
                           {u"exit_rules"_s, exits},
                           {u"thesis"_s, js::S(text(line, u"thesis"_s))},
                           {u"invalidation"_s, js::S(text(line, u"invalidation"_s))}});
    return v;
}

double defaultStop(bool isLong, double entry, std::optional<double> extreme, double pct) {
    double stop = isLong ? entry * (1.0 - pct / 100.0) : entry * (1.0 + pct / 100.0);
    if (extreme && *extreme > 0) stop = isLong ? std::max(stop, *extreme) : std::min(stop, *extreme);
    // 按分取整,朝远离现价的方向;先抹掉二进制小数的尾巴,免得 186.3 变成 186.29
    const double cents = std::round(stop * 100.0 * 1e6) / 1e6;
    return (isLong ? std::floor(cents) : std::ceil(cents)) / 100.0;
}

std::optional<double> priorExtreme(const QList<OJson>& bars, const QString& today, int days, bool isLong) {
    QList<OJson> prior;
    for (const OJson& b : bars)
        if (js::str(b.get(u"date"_s)) < today) prior.append(b);
    if (prior.isEmpty() || days <= 0) return std::nullopt;
    std::sort(prior.begin(), prior.end(), [](const OJson& a, const OJson& b) { return js::str(a.get(u"date"_s)) < js::str(b.get(u"date"_s)); });
    const qsizetype from = std::max<qsizetype>(0, prior.size() - days);
    std::optional<double> out;
    for (qsizetype i = from; i < prior.size(); ++i) {
        const OJson* v = prior[i].get(isLong ? u"low"_s : u"high"_s);
        if (!js::isNum(v) || !std::isfinite(v->n) || v->n <= 0) continue;
        if (!out) out = v->n;
        else out = isLong ? std::min(*out, v->n) : std::max(*out, v->n);
    }
    return out;
}

std::optional<QString> gateOpenOrder(const std::optional<OJson>& intent, const QString& symbol, const QString& action, double qty) {
    if (!intent) return u"%1 没有交易意图记录:先写好止损价与止损理由,再开仓"_s.arg(symbol);
    const OJson* body = intent->get(u"intent"_s);
    const QString side = js::str(js::prop(body, u"side"_s));
    if (side != action.toUpper()) return u"%1 的交易意图是 %2,这张单是 %3"_s.arg(symbol, side, action.toUpper());
    const double allowed = js::num(js::prop(body, u"qty"_s));
    if (std::isfinite(allowed) && qty > allowed)
        return u"%1 的交易意图最多 %2 股,这张单 %3 股"_s.arg(symbol, util::jsNumberToString(allowed), util::jsNumberToString(qty));
    return std::nullopt;
}

QString orderSymbol(const OJson& order) { return js::str(js::prop(js::prop(&order, u"contract"_s), u"symbol"_s)).toUpper(); }

std::optional<QString> gateOrder(const std::optional<OJson>& intent, const OJson& order) {
    const OJson* body = js::prop(&order, u"order"_s);
    return gateOpenOrder(intent, orderSymbol(order), js::str(js::prop(body, u"action"_s)), js::num(js::prop(body, u"totalQuantity"_s)));
}

}  // namespace ibkr::analysis::guard
