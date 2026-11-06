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

Structure parseStructure(const QString& text) {
    Structure s;
    static const QRegularExpression strikesRe(u"(\\d+(?:\\.\\d+)?(?:\\s*/\\s*\\d+(?:\\.\\d+)?)+)"_s);
    const auto m = strikesRe.match(text);
    if (m.hasMatch())
        for (const QString& part : m.captured(1).split(u'/')) s.strikes.append(part.trimmed().toDouble());
    const QString lower = text.toLower();
    static const QRegularExpression callRe(u"\\bcalls?\\b|看涨|\\d[cC]\\b|\\bc\\b"_s);
    static const QRegularExpression putRe(u"\\bputs?\\b|看跌|\\d[pP]\\b|\\bp\\b"_s);
    const bool call = callRe.match(lower).hasMatch() || callRe.match(text).hasMatch();
    const bool put = putRe.match(lower).hasMatch() || putRe.match(text).hasMatch();
    if (call != put) s.right = call ? u"C"_s : u"P"_s;
    return s;
}

ExitRules parseExitRules(const OJson& rules) {
    ExitRules r;
    // 倍数:直接给数,或者从「中间价 >= 成本 × 2.5」里取 × / x / * 后面那个数
    const auto mult = [&](const QString& numKey, const QString& textKey) -> std::optional<double> {
        if (const auto n = positiveNum(rules, numKey)) return n;
        static const QRegularExpression re(u"[×xX*]\\s*(\\d+(?:\\.\\d+)?)"_s);
        const auto m = re.match(text(rules, textKey));
        if (m.hasMatch()) return m.captured(1).toDouble();
        return std::nullopt;
    };
    r.take_profit_x = mult(u"take_profit_x"_s, u"take_profit"_s);
    r.stop_loss_x = mult(u"stop_loss_x"_s, u"stop_loss"_s);
    static const QRegularExpression clockRe(u"(\\d{1,2}):(\\d{2})"_s);
    const QString timeText = text(rules, u"time_stop_et"_s).isEmpty() ? text(rules, u"time_stop"_s) : text(rules, u"time_stop_et"_s);
    if (const auto m = clockRe.match(timeText); m.hasMatch()) {
        const int h = m.captured(1).toInt(), mi = m.captured(2).toInt();
        if (h < 24 && mi < 60) r.time_stop_et = u"%1:%2"_s.arg(h, 2, 10, QChar(u'0')).arg(mi, 2, 10, QChar(u'0'));
    }
    if (const auto b = positiveNum(rules, u"level_stop_below"_s)) r.level_below = b;
    if (const auto a = positiveNum(rules, u"level_stop_above"_s)) r.level_above = a;
    const QString level = text(rules, u"level_stop"_s);
    if (!level.isEmpty() && !r.level_below && !r.level_above) {
        static const QRegularExpression levelRe(u"([<>])\\s*=?\\s*(\\d+(?:\\.\\d+)?)"_s);
        const auto m = levelRe.match(level);
        if (!m.hasMatch()) {
            r.error = u"exit_rules.level_stop 认不出,写成「标的 < 647」或 level_stop_below: 647"_s;
            return r;
        }
        (m.captured(1) == u"<" ? r.level_below : r.level_above) = m.captured(2).toDouble();
    }
    if (!r.take_profit_x) r.error = u"exit_rules.take_profit 认不出倍数,写成「中间价 >= 成本 × 2.5」或 take_profit_x: 2.5"_s;
    else if (!r.stop_loss_x) r.error = u"exit_rules.stop_loss 认不出倍数,写成「中间价 <= 成本 × 0.4」或 stop_loss_x: 0.4"_s;
    else if (r.time_stop_et.isEmpty()) r.error = u"exit_rules.time_stop 认不出钟点,写成「到期日 15:00 ET」或 time_stop_et: \"15:00\""_s;
    else if (*r.stop_loss_x >= 1) r.error = u"止损倍数要小于 1(成本的几成)"_s;
    else if (*r.take_profit_x <= 1) r.error = u"止盈倍数要大于 1"_s;
    return r;
}

IntentVerdict checkOptionIntent(const OJson& line, const QString& account) {
    const QString symbol = text(line, u"symbol"_s).toUpper();
    if (symbol.isEmpty()) return fail(u"缺 symbol(标的)"_s);
    const QString structure = text(line, u"structure"_s);
    if (structure.isEmpty()) return fail(u"缺 structure(结构,例如 QQQ 660/670/680 call fly)"_s);
    const QString expiry = text(line, u"expiry"_s);
    static const QRegularExpression dateRe(u"^\\d{4}-\\d{2}-\\d{2}$"_s);
    if (!dateRe.match(expiry).hasMatch()) return fail(u"expiry 要写成 YYYY-MM-DD"_s);
    const OJson* costIn = line.get(u"cost_usd"_s);
    if (js::isNum(costIn) && costIn->n < 0) return fail(u"贷方组合(收权利金的)暂不支持,cost_usd 只收借方成本"_s);
    const auto cost = positiveNum(line, u"cost_usd"_s);
    if (!cost) return fail(u"缺 cost_usd(成本,美元)"_s);
    const OJson* rules = line.get(u"exit_rules"_s);
    if (!js::isObj(rules)) return fail(u"缺 exit_rules"_s);
    const ExitRules ex = parseExitRules(*rules);
    if (!ex.error.isEmpty()) return fail(ex.error);
    Structure st = parseStructure(structure);
    if (const OJson* given = line.get(u"strikes"_s); js::isArr(given)) {
        st.strikes.clear();
        for (const OJson& k : given->items)
            if (js::isNum(&k)) st.strikes.append(k.n);
    }
    if (const QString r = text(line, u"right"_s).toUpper(); r == u"C" || r == u"P") st.right = r;
    if (st.strikes.size() < 2) return fail(u"structure 里认不出行权价,写成「660/670/680」,或另给 strikes: [660, 670, 680]"_s);
    OJson strikes = js::array();
    for (double k : st.strikes) strikes.items.append(js::N(k));
    OJson exits = js::object({{u"take_profit_x"_s, js::N(*ex.take_profit_x)}, {u"stop_loss_x"_s, js::N(*ex.stop_loss_x)}, {u"time_stop_et"_s, js::S(ex.time_stop_et)}});
    if (ex.level_below) exits.set(u"level_stop_below"_s, js::N(*ex.level_below));
    if (ex.level_above) exits.set(u"level_stop_above"_s, js::N(*ex.level_above));
    // 原文也留着
    OJson raw = js::object();
    for (const auto& [k, val] : rules->fields) raw.set(k, val);
    IntentVerdict v;
    v.ok = true;
    v.intent = js::object({{u"kind"_s, js::S(u"option"_s)},
                           {u"account"_s, js::S(account)},
                           {u"symbol"_s, js::S(symbol)},
                           {u"structure"_s, js::S(structure)},
                           {u"strikes"_s, strikes},
                           {u"right"_s, js::S(st.right)},
                           {u"expiry"_s, js::S(expiry)},
                           {u"cost_usd"_s, js::N(*cost)},
                           {u"exits"_s, exits},
                           {u"exit_rules"_s, raw},
                           {u"thesis"_s, js::S(text(line, u"thesis"_s))},
                           {u"invalidation"_s, js::S(text(line, u"invalidation"_s))}});
    return v;
}

bool comboMatches(const OJson& row, const OJson& intent) {
    if (js::str(row.get(u"sec_type"_s)) != u"BAG") return false;
    if (js::str(row.get(u"account"_s)) != js::str(intent.get(u"account"_s))) return false;
    if (js::str(row.get(u"symbol"_s)).toUpper() != js::str(intent.get(u"symbol"_s)).toUpper()) return false;
    // 组合行的 leg = "到期日|+1x660C,-2x670C,+1x680C"(domain/positions 的 comboRow)
    const QString leg = js::str(row.get(u"leg"_s));
    const qsizetype bar = leg.indexOf(u'|');
    if (bar < 0) return false;
    if (leg.left(bar).left(8) != js::str(intent.get(u"expiry"_s)).remove(u'-')) return false;
    static const QRegularExpression partRe(u"^[+-]?[\\d.]+x(\\d+(?:\\.\\d+)?)([CP]?)$"_s);
    QList<double> have;
    QSet<QString> rights;
    for (const QString& part : leg.mid(bar + 1).split(u',')) {
        const auto m = partRe.match(part.trimmed());
        if (!m.hasMatch()) return false;
        const double k = m.captured(1).toDouble();
        if (!have.contains(k)) have.append(k);
        if (!m.captured(2).isEmpty()) rights.insert(m.captured(2));
    }
    QList<double> want;
    if (const OJson* ks = intent.get(u"strikes"_s); js::isArr(ks))
        for (const OJson& k : ks->items)
            if (js::isNum(&k) && !want.contains(k.n)) want.append(k.n);
    std::sort(have.begin(), have.end());
    std::sort(want.begin(), want.end());
    if (have.isEmpty() || have != want) return false;
    const QString right = js::str(intent.get(u"right"_s));
    if (!right.isEmpty() && (rights.size() != 1 || !rights.contains(right))) return false;
    return true;
}

double stockFloor(bool isLong, double cost, double intentStop, double price, bool trail, std::optional<double> prevFloor) {
    double floor = prevFloor ? *prevFloor : intentStop;
    if (!atLeastAsTight(isLong, floor, intentStop)) floor = intentStop;
    if (!trail || !(cost > 0) || !std::isfinite(price)) return floor;
    const double r = std::abs(cost - intentStop);
    if (!(r > 0)) return floor;
    const double gain = isLong ? price - cost : cost - price;
    std::optional<double> want;
    if (gain >= 2 * r) want = isLong ? cost + r : cost - r;
    else if (gain >= r) want = cost;
    if (want && !atLeastAsTight(isLong, floor, *want)) floor = *want;
    return std::round(floor * 100.0) / 100.0;
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
