#include "analysis/ibtrades.h"

#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/py.h"

#include <QRegularExpression>
#include <QStringList>

#include <algorithm>
#include <cmath>
#include <limits>
#include <optional>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;

namespace ibkr::analysis::ibtrades {

namespace {
std::optional<double> num(const OJson* v) {
    if (js::nullish(v) || (v->type == OJson::String && v->s.isEmpty())) return std::nullopt;
    const double out = js::num(v);
    return std::isfinite(out) ? std::optional<double>(out) : std::nullopt;
}
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : js::Null(); }
const OJson* orEmpty(const OJson* v) {
    static const OJson empty = js::object();
    return js::nullish(v) ? &empty : v;
}
QString n2s(double v) { return util::jsNumberToString(v); }

QString mask(const QString& s) { return s.size() <= 5 ? s : s.left(2) + u"***"_s + s.right(3); }

/// fmtF(v, 4) 去尾零
QString fmt(double v) {
    static const QRegularExpression zeros(u"0+\\z"_s), dot(u"\\.\\z"_s);
    QString s = util::fmtF(v, 4);
    s.remove(zeros);
    s.remove(dot);
    return s;
}

struct LegAgg {
    double bot = 0, sld = 0, value = 0, shares = 0;
    QStringList times;
    double commission = 0;
    bool hasComm = false;
    const OJson* contract = nullptr;
};
struct Leg {
    double strike;
    QString right, expiry;
    LegAgg agg;
};

/// Map<string, Rec>:同一个 account_id 后来的覆盖前面的
const OJson* aliasLookup(const QList<std::pair<QString, const OJson*>>& aliasOf, const QString& id) {
    const OJson* out = nullptr;
    for (const auto& [k, a] : aliasOf)
        if (k == id) out = a;
    return out;
}

OJson butterflyFromRows(const QList<const OJson*>& rows, const QList<std::pair<QString, const OJson*>>& aliasOf) {
    QList<Leg> legs;  // Map 的插入次序
    QList<const OJson*> bags;
    for (const OJson* row : rows) {
        const OJson* c = orEmpty(js::prop(row, u"contract"_s));
        const double shares = num(js::prop(row, u"shares"_s)).value_or(0);
        const auto price = num(js::prop(row, u"price"_s));
        if (shares <= 0 || !price) continue;
        const OJson* sec = js::prop(c, u"secType"_s);
        if (js::isStr(sec) && sec->s == u"BAG") {
            bags << row;
            continue;
        }
        const auto strike = num(js::prop(c, u"strike"_s));
        if (!strike) continue;
        const QString right = js::strOr(js::prop(c, u"right"_s), QString()), expiry = js::strOr(js::prop(c, u"expiry"_s), QString());
        const QString id = n2s(*strike) + u'|' + right + u'|' + expiry;
        Leg* leg = nullptr;
        for (Leg& l : legs)
            if (n2s(l.strike) + u'|' + l.right + u'|' + l.expiry == id) leg = &l;
        if (!leg) {
            legs << Leg{*strike, right, expiry, LegAgg{}};
            leg = &legs.last();
            leg->agg.contract = c;
        }
        LegAgg& a = leg->agg;
        const QString side = js::strOr(js::prop(row, u"side"_s), QString()).toUpper();
        if (side == u"BOT" || side == u"BUY") a.bot += shares;
        else a.sld += shares;
        a.value += *price * shares;
        a.shares += shares;
        a.times << js::strOr(js::prop(row, u"time"_s), QString());
        if (const auto comm = num(js::prop(row, u"commission"_s))) {
            a.commission += *comm;
            a.hasComm = true;
        }
    }
    if (legs.size() != 3) return OJson::null();
    std::stable_sort(legs.begin(), legs.end(), [](const Leg& a, const Leg& b) {
        const double d = a.strike - b.strike;
        if (d != 0 && !std::isnan(d)) return d < 0;
        if (a.right != b.right) return a.right < b.right;
        return a.expiry < b.expiry;
    });
    if (legs[0].right != legs[1].right || legs[1].right != legs[2].right || legs[0].expiry != legs[1].expiry || legs[1].expiry != legs[2].expiry) return OJson::null();

    struct Sized {
        const Leg* leg;
        QString action;
        double size;
    };
    QList<Sized> sized;
    for (const Leg& e : legs) {
        const double net = e.agg.bot - e.agg.sld;
        if (std::fabs(net) < 1e-9) return OJson::null();
        sized << Sized{&e, net > 0 ? u"BUY"_s : u"SELL"_s, std::fabs(net)};
    }
    double qtyF = std::numeric_limits<double>::infinity();
    for (const Sized& s : sized) qtyF = jm::min(qtyF, s.size);
    QList<double> ratios;
    for (const Sized& s : sized) ratios << util::jsRound(s.size / qtyF);
    if (ratios[0] != 1 || ratios[1] != 2 || ratios[2] != 1) return OJson::null();
    const Sized &s1 = sized[0], &s2 = sized[1], &s3 = sized[2];
    if (s1.action != s3.action || s2.action == s1.action) return OJson::null();
    const double qty = util::jsRound(qtyF);
    if (qty <= 0) return OJson::null();

    const OJson* contract0 = s1.leg->agg.contract;
    const auto m = num(js::prop(contract0, u"multiplier"_s));
    const double multiplier = m && *m != 0 ? *m : 100.0;
    const QString right = s1.leg->right, expiryRaw = s1.leg->expiry;
    const QString symbol = js::strOr(js::prop(contract0, u"symbol"_s), QString());
    const auto legPrice = [](const LegAgg& l) { return l.value / l.shares; };

    double premium;
    if (!bags.isEmpty()) {
        double bagShares = 0, weighted = 0;
        for (const OJson* b : bags) bagShares = bagShares + num(js::prop(b, u"shares"_s)).value_or(0);
        for (const OJson* b : bags) weighted = weighted + num(js::prop(b, u"price"_s)).value_or(0) * num(js::prop(b, u"shares"_s)).value_or(0);
        premium = util::pyRound(std::fabs(weighted / bagShares), 4);
    } else {
        double signed_ = 0;
        for (qsizetype i = 0; i < sized.size(); ++i) signed_ += (sized[i].action == u"BUY" ? 1 : -1) * legPrice(sized[i].leg->agg) * ratios[i];
        premium = util::pyRound(std::fabs(signed_), 4);
    }

    QStringList times;
    for (const Sized& s : sized)
        for (const QString& t : s.leg->agg.times)
            if (!t.isEmpty()) times << t;
    std::stable_sort(times.begin(), times.end());
    const QString firstTime = times.isEmpty() ? QString() : times[0];
    const QString accountId = js::strOr(js::prop(rows.isEmpty() ? orEmpty(nullptr) : rows[0], u"account_id"_s), QString());
    const OJson* acct = aliasLookup(aliasOf, accountId);
    const bool known = js::truthy(acct);
    const QString alias = known ? js::str(js::prop(acct, u"alias"_s)) : u"未配置账户 "_s + mask(accountId);
    const bool isPaper = known ? js::truthy(js::prop(acct, u"is_paper"_s)) : accountId.toUpper().startsWith(u"DU"_s);

    OJson commission = js::Null();
    if (std::any_of(sized.begin(), sized.end(), [](const Sized& s) { return s.leg->agg.hasComm; })) {
        double sum = 0;
        for (const Sized& s : sized) sum = sum + s.leg->agg.commission;
        commission = js::N(util::pyRound(sum, 4));
    }

    OJson fillsOut = js::array();
    if (!bags.isEmpty()) {
        for (const OJson* b : bags)
            fillsOut.items << js::object({{u"time"_s, js::S(js::strOr(js::prop(b, u"time"_s), firstTime))},
                                          {u"price"_s, optN(num(js::prop(b, u"price"_s)))},
                                          {u"qty"_s, optN(num(js::prop(b, u"shares"_s)))},
                                          {u"exec_id"_s, js::S(js::strOr(js::prop(b, u"exec_id"_s), QString()))}});
    } else {
        fillsOut.items << js::object({{u"time"_s, js::S(firstTime)}, {u"price"_s, js::N(premium)}, {u"qty"_s, js::N(qty)}, {u"exec_id"_s, js::S(u"(合成)"_s)}});
    }

    const QString verb = s1.action == u"BUY" ? u"买入"_s : u"卖出"_s;
    const QString rightLabel = right == u"P" ? u"看跌"_s : u"看涨"_s;
    const double width = util::pyRound(s2.leg->strike - s1.leg->strike, 4);
    const QString summary = verb + u' ' + n2s(qty) + u" 张 "_s + symbol + u' ' + fmt(s1.leg->strike) + u'/' + fmt(s2.leg->strike) + u'/' + fmt(s3.leg->strike) + u' ' +
                            rightLabel + u"蝴蝶(翼宽 "_s + fmt(width) + u")@ "_s + fmt(premium);
    const OJson* permRaw = js::prop(rows[0], u"perm_id"_s);
    const bool hasPerm = js::truthy(permRaw);
    const QString rid = u"ib:"_s + (hasPerm ? n2s(std::trunc(js::num(permRaw))) : groupKey(*rows[0]));
    const QString multStr = multiplier == std::trunc(multiplier) && std::isfinite(multiplier) ? n2s(std::trunc(multiplier)) : n2s(multiplier);

    OJson legsOut = js::array();
    for (qsizetype i = 0; i < sized.size(); ++i) {
        const Sized& s = sized[i];
        const OJson* conId = js::prop(s.leg->agg.contract, u"conId"_s);
        legsOut.items << js::object({{u"action"_s, js::S(s.action)},
                                     {u"ratio"_s, js::N(ratios[i])},
                                     {u"strike"_s, js::N(s.leg->strike)},
                                     {u"right"_s, js::S(right)},
                                     {u"lastTradeDateOrContractMonth"_s, js::S(expiryRaw)},
                                     {u"tradingClass"_s, js::S(js::strOr(js::prop(s.leg->agg.contract, u"tradingClass"_s), QString()))},
                                     {u"multiplier"_s, js::S(multStr)},
                                     {u"conId"_s, js::nullish(conId) ? js::Null() : *conId},
                                     {u"fill_price"_s, js::N(util::pyRound(legPrice(s.leg->agg), 4))}});
    }
    const OJson* currency = js::prop(contract0, u"currency"_s);
    const OJson* orderId = js::prop(rows[0], u"order_id"_s);
    const OJson expiryRawJ = js::S(expiryRaw);
    return js::object({
        {u"id"_s, js::S(rid)},
        {u"source"_s, js::S(QString::fromUtf16(kFillSource))},
        {u"created_at"_s, js::S(firstTime)},
        {u"contract"_s, js::object({{u"secType"_s, js::S(u"BAG"_s)},
                                    {u"symbol"_s, js::S(symbol)},
                                    {u"exchange"_s, js::S(u"SMART"_s)},
                                    {u"currency"_s, js::S(js::truthy(currency) ? js::str(currency) : u"USD"_s)},
                                    {u"combo_strategy"_s, js::S(u"BUTTERFLY"_s)},
                                    {u"multiplier"_s, js::S(multStr)},
                                    {u"legs"_s, legsOut}})},
        {u"order"_s, js::object({{u"action"_s, js::S(s1.action)},
                                 {u"totalQuantity"_s, js::N(qty)},
                                 {u"orderType"_s, js::S(QString())},
                                 {u"lmtPrice"_s, js::Null()},
                                 {u"price_mode"_s, js::S(u"EXPLICIT"_s)},
                                 {u"tif"_s, js::S(QString())},
                                 {u"outsideRth"_s, js::B(false)}})},
        {u"ibkr"_s, js::object({{u"avg_fill_price"_s, js::N(premium)},
                                {u"fills"_s, fillsOut},
                                {u"perm_id"_s, hasPerm ? *permRaw : js::Null()},
                                {u"order_id"_s, js::truthy(orderId) ? *orderId : js::Null()},
                                {u"total_commission"_s, commission},
                                {u"status_timeline"_s, js::array({js::object({{u"status"_s, js::S(u"Filled"_s)}, {u"at"_s, js::S(firstTime)}})})}})},
        {u"final_status"_s, js::S(u"filled"_s)},
        {u"account"_s, js::object({{u"alias"_s, js::S(alias)}, {u"account_id"_s, js::S(accountId)}, {u"is_paper"_s, js::B(isPaper)}})},
        {u"llm"_s, js::object({{u"intent_summary"_s, js::S(summary)}})},
        {u"input"_s, js::object({{u"raw_instruction"_s, js::S(QString())}, {u"reason"_s, js::S(u"券商成交记录"_s)}, {u"input_channel"_s, js::S(QString::fromUtf16(kFillSource))}})},
        {u"execution_type"_s, js::S(u"IMMEDIATE"_s)},
        {u"expiry"_s, js::S(fmtExpiry(&expiryRawJ))},
    });
}
}  // namespace

QString fmtExpiry(const OJson* raw) {
    const QString s = js::strOr(raw, QString());
    static const QRegularExpression re(u"\\A[0-9]{8}\\z"_s);
    if (re.match(s).hasMatch()) return s.left(4) + u'-' + s.mid(4, 2) + u'-' + s.mid(6, 2);
    return s;
}

QString groupKey(const OJson& fill) {
    const OJson* perm = js::propStrict(&fill, u"perm_id"_s);
    if (js::truthy(perm)) return u'p' + n2s(std::trunc(js::num(perm)));
    const OJson* order = js::prop(&fill, u"order_id"_s);
    if (js::truthy(order)) return u'o' + n2s(std::trunc(js::num(order)));
    return u'e' + js::strOr(js::prop(&fill, u"exec_id"_s), QString());
}

QList<OJson> groupButterflies(const QList<OJson>& fills, const QList<OJson>& accounts) {
    QList<std::pair<QString, const OJson*>> aliasOf;
    for (const OJson& a : accounts) aliasOf << std::pair{js::strOr(js::propStrict(&a, u"account_id"_s), QString()), &a};
    QList<std::pair<QString, QList<const OJson*>>> groups;  // Map 的插入次序
    for (const OJson& fill : fills) {
        const OJson* contract = orEmpty(js::propStrict(&fill, u"contract"_s));
        const OJson* sec = js::prop(contract, u"secType"_s);
        if (!(js::isStr(sec) && (sec->s == u"BAG" || sec->s == u"OPT" || sec->s == u"FOP"))) continue;
        const QString key = js::strOr(js::prop(&fill, u"account_id"_s), QString()) + u'|' + groupKey(fill);
        auto it = std::find_if(groups.begin(), groups.end(), [&](const auto& g) { return g.first == key; });
        if (it == groups.end()) groups << std::pair{key, QList<const OJson*>{&fill}};
        else it->second << &fill;
    }
    QList<OJson> out;
    for (const auto& [key, rows] : groups) {
        OJson record = butterflyFromRows(rows, aliasOf);
        if (record.type != OJson::Null) out << record;
    }
    std::stable_sort(out.begin(), out.end(), [](const OJson& a, const OJson& b) {
        const QString ka = a.get(u"created_at"_s)->s, kb = b.get(u"created_at"_s)->s;
        if (ka != kb) return ka < kb;
        return a.get(u"id"_s)->s < b.get(u"id"_s)->s;
    });
    return out;
}

}  // namespace ibkr::analysis::ibtrades
