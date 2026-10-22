#include "analysis/assignment_risk.h"

#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

#include <QHash>

#include <cmath>
#include <vector>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;

namespace ibkr::analysis::assignment_risk {

namespace {
const OJson* P(const OJson& o, const char* k) { return js::prop(&o, QString::fromLatin1(k)); }
bool isStr(const OJson* v, const char16_t* s) { return v && v->type == OJson::String && v->s == QStringView(s); }
bool isNull(const OJson* v) { return v && v->type == OJson::Null; }
void setIfDefined(OJson& o, const char* k, const OJson* v) {
    if (v) o.set(QString::fromLatin1(k), *v);
}
/// String(Math.round(v * 100) / 100)
QString n2(double v) { return util::jsNumberToString(util::jsRound(v * 100) / 100); }
}  // namespace

QList<OJson> expiringOptionLegs(const QList<OJson>& rows, const QString& today, const std::function<bool(const OJson*)>& isCashSettled) {
    QList<OJson> out;
    for (const OJson& row : rows) {
        if (!isStr(P(row, "sec_type"), u"OPT") || !js::truthy(P(row, "quantity")) || isCashSettled(P(row, "symbol"))) continue;
        const OJson* c = P(row, "contract");
        // String(raw ?? "").trim().slice(0, 8)
        if (util::jsTrim(js::strOr(js::propStrict(c, u"lastTradeDateOrContractMonth"_s), QString())).left(8) != today) continue;
        const double strike = js::num(js::propStrict(c, u"strike"_s));
        const QString right = js::strOr(js::propStrict(c, u"right"_s), QString()).left(1).toUpper();
        if (!(strike > 0) || (right != u"C" && right != u"P")) continue;
        OJson leg = js::object();
        setIfDefined(leg, "key", P(row, "key"));
        setIfDefined(leg, "account", P(row, "account"));
        setIfDefined(leg, "symbol", P(row, "symbol"));
        setIfDefined(leg, "label", P(row, "label"));
        setIfDefined(leg, "quantity", P(row, "quantity"));
        const double mult = js::num(P(row, "multiplier"));
        leg.set(u"multiplier"_s, js::N(mult > 0 ? mult : 100));
        leg.set(u"strike"_s, js::N(strike));
        leg.set(u"right"_s, js::S(right));
        out << leg;
    }
    return out;
}

double itmBy(const OJson& leg, double spot) {
    const double strike = js::num(P(leg, "strike"));
    return jm::max(0, isStr(P(leg, "right"), u"C") ? spot - strike : strike - spot);
}

QList<OJson> assignmentNotices(const QList<OJson>& legs, const OJson& spots) {
    std::vector<QList<OJson>> groups;  // Map 的先后
    QHash<QString, size_t> index;
    for (const OJson& leg : legs) {
        const QString id = js::str(P(leg, "account")) + u'|' + js::str(P(leg, "symbol"));
        auto it = index.constFind(id);
        if (it == index.constEnd()) {
            it = index.insert(id, groups.size());
            groups.emplace_back();
        }
        groups[*it] << leg;
    }
    QList<OJson> out;
    for (const QList<OJson>& group : groups) {
        if (group.isEmpty()) continue;
        const OJson& first = group[0];
        QList<OJson> shorts;
        for (const OJson& l : group)
            if (js::num(P(l, "quantity")) < 0) shorts << l;
        if (shorts.isEmpty()) continue;
        const OJson* raw = js::prop(&spots, js::str(P(first, "symbol")));
        const bool hasSpot = js::isNum(raw) && std::isfinite(raw->n) && raw->n > 0;
        const auto notice = [&](const OJson& spot, const QList<OJson>& ls, const OJson& net) {
            OJson n = js::object();
            setIfDefined(n, "account", P(first, "account"));
            setIfDefined(n, "symbol", P(first, "symbol"));
            n.set(u"spot"_s, spot);
            n.set(u"legs"_s, js::array(ls));
            n.set(u"net_shares"_s, net);
            return n;
        };
        if (!hasSpot) {
            QList<OJson> ls;
            for (OJson l : shorts) {
                l.set(u"itm_by"_s, js::N(0));
                ls << l;
            }
            out << notice(OJson::null(), ls, OJson::null());
            continue;
        }
        const double spot = raw->n;
        QList<OJson> risky;
        for (OJson l : shorts) {
            const double by = itmBy(l, spot);
            l.set(u"itm_by"_s, js::N(by));
            if (by > 0) risky << l;
        }
        if (risky.isEmpty()) continue;
        double net = 0;
        for (const OJson& l : group)
            if (itmBy(l, spot) > 0) net = net + (isStr(P(l, "right"), u"C") ? 1 : -1) * js::num(P(l, "quantity")) * js::num(P(l, "multiplier"));
        out << notice(js::N(spot), risky, js::N(net));
    }
    return out;
}

QString noticeText(const OJson& notice) {
    const bool noSpot = isNull(P(notice, "spot"));
    QStringList legs;
    const OJson* ls = P(notice, "legs");
    if (js::isArr(ls))
        for (const OJson& l : ls->items)
            legs << u"卖出 %1 张 %2%3%4"_s.arg(n2(std::fabs(js::num(P(l, "quantity")))), n2(js::num(P(l, "strike"))), js::str(P(l, "right")),
                                           noSpot ? QString() : u"(实值 %1)"_s.arg(n2(js::num(P(l, "itm_by")))));
    const QString symbol = js::str(P(notice, "symbol")), account = js::str(P(notice, "account"));
    if (noSpot || isNull(P(notice, "net_shares"))) {
        return u"%1(账户 %2)今天到期的空头腿:%3。拿不到正股现价,判断不了在不在实值里;这是实物交割的期权,收盘时在实值里就会被指派,请自己看一眼。"_s.arg(
            symbol, account, legs.join(u"、"_s));
    }
    const double net = js::num(P(notice, "net_shares"));
    const QString change = net == 0 ? u"正股净变动为 0(同一天到期、也在实值里的多头腿会自动行权,两边相抵)"_s
                                    : u"这个账户的 %1 正股净%2 %3 股(同一天到期、也在实值里的多头腿会自动行权,已算在内)"_s.arg(
                                          symbol, net > 0 ? u"买进"_s : u"卖出"_s, n2(std::fabs(net)));
    return u"%1(账户 %2)到期日空头腿在实值里,现价 %3:%4。这是实物交割的期权,持到收盘会被指派;按现在的价,到期后%5。不想要这个结果就在收盘前处理。"_s.arg(
        symbol, account, n2(js::num(P(notice, "spot"))), legs.join(u"、"_s), change);
}

}  // namespace ibkr::analysis::assignment_risk
