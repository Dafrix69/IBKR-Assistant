#include "orchestrate/closing.h"

#include "domain/positions.h"
#include "orchestrate/engine_ports.h"
#include "util/jsobj.h"
#include "util/market_js.h"
#include "util/py.h"

#include <QHash>

#include <cmath>
#include <vector>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::orchestrate {

namespace {

struct LegIntent {
    QString key;
    QString action;  // 腿 / 订单的 action;不是字符串时 JS 的 === 比较一律假,这里给个不会等于 BUY / SELL 的值
    double quantity = 0;
    OJson rawQuantity;  // 单腿时是 order.totalQuantity 的原值(字符串就是字符串,applyReduction 里 BUY 一边是 JS 的 + )
};

// action === "SELL" / "BUY" 只认字符串;其余(undefined、数)都不等
QString actionOf(const OJson* v) { return js::isStr(v) ? v->s : u"\u0001"_s; }

std::vector<LegIntent> legIntents(const OJson& order, const QString& alias) {
    const OJson* c = js::prop(&order, u"contract"_s);
    const OJson* spec = js::prop(&order, u"order"_s);
    // 与 TS 一样,order.order 缺了会在 `order.order.totalQuantity` 上抛 TypeError:调用方给的订单都过了校验,这里不另造错
    const OJson* qtyRaw = js::prop(spec, u"totalQuantity"_s);
    const double qty = js::num(qtyRaw);
    std::vector<LegIntent> out;
    if (js::str(js::prop(c, u"secType"_s)) != u"BAG") {
        out.push_back({domain::makeKey(alias, js::str(js::prop(c, u"symbol"_s)), js::str(js::prop(c, u"secType"_s)), domain::legOf(c)),
                       actionOf(js::prop(spec, u"action"_s)), qty, qtyRaw ? *qtyRaw : js::N(std::nan(""))});
        return out;
    }
    const OJson* legs = js::prop(c, u"legs"_s);
    if (js::nullish(legs)) return out;
    for (const OJson& leg : legs->items) {
        OJson probe = js::object({{u"secType"_s, js::S(u"OPT"_s)}});
        if (const OJson* e = js::prop(&leg, u"lastTradeDateOrContractMonth"_s)) probe.set(u"lastTradeDateOrContractMonth"_s, *e);
        if (const OJson* s = js::prop(&leg, u"strike"_s)) probe.set(u"strike"_s, *s);
        if (const OJson* r = js::prop(&leg, u"right"_s)) probe.set(u"right"_s, *r);
        out.push_back({domain::makeKey(alias, js::str(js::prop(c, u"symbol"_s)), u"OPT"_s, domain::legOf(&probe)), actionOf(js::prop(&leg, u"action"_s)),
                       qty * js::num(js::prop(&leg, u"ratio"_s)), js::N(qty * js::num(js::prop(&leg, u"ratio"_s)))});
    }
    return out;
}

}  // namespace

bool reducesPositions(const OJson& order, const QString& alias, const QList<OJson>& rows) {
    QHash<QString, double> held;
    for (const OJson& row : rows) {
        const double q = jsx::numOr(js::prop(&row, u"quantity"_s), 0);
        if (std::isfinite(q)) held.insert(js::strOr(js::prop(&row, u"key"_s), QString()), q);
    }
    const std::vector<LegIntent> legs = legIntents(order, alias);
    if (legs.empty()) return false;
    for (const LegIntent& l : legs) {
        const double pos = held.value(l.key, 0);
        bool ok = false;
        if (l.action == u"SELL") ok = pos > 0 && l.quantity <= pos;
        else if (l.action == u"BUY") ok = pos < 0 && l.quantity <= -pos;
        if (!ok) return false;
    }
    return true;
}

void applyReduction(const OJson& order, const QString& alias, QList<OJson>& rows) {
    QHash<QString, qsizetype> byKey;
    for (qsizetype i = 0; i < rows.size(); ++i) byKey.insert(js::strOr(js::prop(&rows[i], u"key"_s), QString()), i);
    for (const LegIntent& l : legIntents(order, alias)) {
        const auto it = byKey.constFind(l.key);
        if (it == byKey.cend()) continue;
        OJson& row = rows[it.value()];
        const double cur = jsx::numOr(js::prop(&row, u"quantity"_s), 0);
        row.set(u"quantity"_s, js::add(js::N(cur), l.action == u"SELL" ? js::N(-l.quantity) : l.rawQuantity));
    }
}

QString orderLegId(const OJson& order) {
    const OJson* c = js::prop(&order, u"contract"_s);
    if (js::str(js::prop(c, u"secType"_s)) != u"BAG") return domain::legOf(c);
    struct L {
        double strike;
        QString right;
        double ratio;
    };
    std::vector<L> legs;
    const OJson* raw = js::prop(c, u"legs"_s);
    if (!js::nullish(raw)) {
        for (const OJson& leg : raw->items) {
            const OJson* r = js::prop(&leg, u"right"_s);
            const OJson* act = js::prop(&leg, u"action"_s);
            const double mult = js::isStr(act) && act->s == u"BUY" ? 1 : -1;
            legs.push_back({js::num(js::prop(&leg, u"strike"_s)), js::strOr(r, QString()).left(1).toUpper(), mult * js::num(js::prop(&leg, u"ratio"_s))});
        }
    }
    util::market::jsSort(legs, [](const L& a, const L& b) {
        const double d = a.strike - b.strike;
        if (d != 0 && !std::isnan(d)) return d;
        return a.right < b.right ? -1.0 : a.right > b.right ? 1.0 : 0.0;
    });
    const OJson* firstLeg = js::prop(js::prop(c, u"legs"_s), u"0"_s);
    const QString expiry = js::strOr(js::prop(firstLeg, u"lastTradeDateOrContractMonth"_s), QString()).left(8);
    QStringList parts;
    for (const L& l : legs) {
        const OJson strike = js::N(l.strike);
        parts << QString(l.ratio >= 0 ? u"+"_s : QString()) + util::pyG(l.ratio) + u"x"_s + domain::fmtStrike(&strike) + l.right;
    }
    return expiry + u"|"_s + parts.join(u',');
}

}  // namespace ibkr::orchestrate
