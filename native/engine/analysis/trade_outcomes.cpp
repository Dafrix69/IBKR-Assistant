#include "analysis/trade_outcomes.h"

#include "analysis/tradereview.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/py.h"
#include "util/tz.h"

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace tr = ibkr::analysis::tradereview;

namespace ibkr::analysis::trade_outcomes {

namespace {
std::optional<double> num(const OJson* v) {
    if (js::nullish(v) || (v->type == OJson::String && v->s.isEmpty())) return std::nullopt;
    const double out = js::num(v);
    return std::isfinite(out) ? std::optional<double>(out) : std::nullopt;
}
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : js::Null(); }
const OJson* P(const OJson& o, const char16_t* k) { return js::prop(&o, QString::fromUtf16(k)); }
QString Sx(const OJson& o, const char16_t* k) { return js::str(P(o, k)); }
bool isStrEq(const OJson* v, const QString& s) { return js::isStr(v) && v->s == s; }
QString n2s(double v) { return util::jsNumberToString(v); }

std::optional<QString> isoOf(const OJson* value) {
    const auto when = tr::parseWhen(value);
    return when ? std::optional<QString>(util::utcIso(*when)) : std::nullopt;
}
QString resultOf(const std::optional<double>& pct) {
    if (!pct) return u"unknown"_s;
    if (std::fabs(*pct) < kFlatPct) return u"flat"_s;
    return *pct > 0 ? u"win"_s : u"loss"_s;
}
/// pairs[id] 的 role / peer;id 是 Object.prototype 上的名字时 link 是真值,两样都是 undefined
struct Link {
    bool truthy = false;
    const OJson* role = nullptr;
    const OJson* peer = nullptr;
};
Link linkOf(const OJson& pairs, const QString& id) {
    if (const OJson* own = pairs.get(id)) return {true, own->get(u"role"_s), own->get(u"peer"_s)};
    return {tr::onObjectPrototype(id), nullptr, nullptr};
}
}  // namespace

QList<OJson> butterflyFacts(const QList<OJson>& records, const SettleClose& settleClose, double now) {
    const OJson pairs = tr::pairButterflies(records);
    QList<OJson> out;
    for (const OJson& record : records) {
        const QString id = js::strOr(js::propStrict(&record, u"id"_s), QString());
        const Link link = linkOf(pairs, id);
        if (link.truthy && isStrEq(link.role, u"exit"_s)) continue;  // 平仓单并进开仓那一笔
        const OJson profile = tr::butterflyProfile(&record);
        if (profile.type == OJson::Null) continue;
        const auto debit = num(P(profile, u"debit"));
        const bool buy = isStrEq(P(profile, u"action"), u"BUY"_s);
        const double sign = buy ? 1 : -1;
        const QString verb = buy ? u"买入"_s : u"卖出"_s;
        const QString label = Sx(profile, u"symbol") + u' ' + Sx(profile, u"lower") + u'/' + Sx(profile, u"center") + u'/' + Sx(profile, u"upper") + u' ' +
                              Sx(profile, u"right_label") + u"蝴蝶 "_s + verb;

        QString how;
        std::optional<double> exitPrice;
        std::optional<QString> closedAt;
        QStringList notes;
        if (link.truthy) {
            const OJson* peer = nullptr;
            for (const OJson& r : records)
                if (js::strictEqual(js::propStrict(&r, u"id"_s), link.peer)) {
                    peer = &r;
                    break;
                }
            how = u"closed"_s;
            exitPrice = num(js::path(peer, {u"ibkr"_s, u"avg_fill_price"_s}));
            closedAt = isoOf(js::prop(peer, u"created_at"_s));
            if (!exitPrice) notes << u"平仓单没有成交均价"_s;
        } else if (now >= tr::expiryClose(profile)) {
            how = u"expired"_s;
            closedAt = util::utcIso(tr::expiryClose(profile));
            const auto close = settleClose(Sx(profile, u"symbol"), Sx(profile, u"expiry"));
            if (!close) notes << u"取不到 "_s + Sx(profile, u"symbol") + u' ' + Sx(profile, u"expiry") + u" 的收盘价,结算结果不明"_s;
            else exitPrice = tr::payoffPerUnit(profile, *close);
        } else {
            how = u"open"_s;
        }
        if (!debit) notes << u"没有成交价,成本不明"_s;

        std::optional<double> pct;
        if (how != u"open" && debit && *debit != 0 && exitPrice) pct = util::pyRound((sign * (*exitPrice - *debit) / *debit) * 100, 1);
        out << js::object({
            {u"id"_s, js::S(id)},
            {u"kind"_s, js::S(u"butterfly"_s)},
            {u"symbol"_s, js::S(Sx(profile, u"symbol"))},
            {u"opened_at"_s, js::S(isoOf(js::prop(&record, u"created_at"_s)).value_or(QString()))},
            {u"closed_at"_s, closedAt ? js::S(*closedAt) : js::Null()},
            {u"label"_s, js::S(label)},
            {u"entry_price"_s, optN(debit)},
            {u"exit_price"_s, exitPrice ? js::N(util::pyRound(*exitPrice, 4)) : js::Null()},
            {u"how"_s, js::S(how)},
            {u"result"_s, js::S(how == u"open" ? u"open"_s : resultOf(pct))},
            {u"return_pct"_s, optN(pct)},
            {u"paper"_s, js::B(js::truthy(js::path(&record, {u"account"_s, u"is_paper"_s})))},
            {u"note"_s, js::S(notes.join(u';'))},
        });
    }
    return out;
}

QList<OJson> stockFacts(const QList<OJson>& trips) {
    QList<OJson> out;
    for (const OJson& trip : trips) {
        const bool closed = isStrEq(js::propStrict(&trip, u"status"_s), u"closed"_s);
        const auto entry = num(P(trip, u"avg_entry"));
        const auto realized = num(P(trip, u"realized_pnl"));
        const double realizedQty = num(P(trip, u"realized_qty")).value_or(0);
        QStringList notes;
        std::optional<double> pct;
        if (js::truthy(P(trip, u"carried"))) notes << u"建仓在成交记录之前,成本不明"_s;
        else if (closed && entry && *entry != 0 && realized && realizedQty > 0) pct = util::pyRound((*realized / (*entry * realizedQty)) * 100, 1);
        if (js::truthy(P(trip, u"opening_assumed"))) notes << u"期初持仓未核对"_s;
        const auto closedAt = closed ? isoOf(P(trip, u"closed_at")) : std::nullopt;
        out << js::object({
            {u"id"_s, js::S(js::strOr(P(trip, u"id"), QString()))},
            {u"kind"_s, js::S(u"stock"_s)},
            {u"symbol"_s, js::S(js::strOr(P(trip, u"symbol"), QString()))},
            {u"opened_at"_s, js::S(isoOf(P(trip, u"created_at")).value_or(QString()))},
            {u"closed_at"_s, closedAt ? js::S(*closedAt) : js::Null()},
            {u"label"_s, js::S(Sx(trip, u"symbol") + u' ' + (isStrEq(P(trip, u"side"), u"SHORT"_s) ? u"做空"_s : u"做多"_s))},
            {u"entry_price"_s, optN(entry)},
            {u"exit_price"_s, optN(num(P(trip, u"avg_exit")))},
            {u"how"_s, js::S(closed ? u"closed"_s : u"open"_s)},
            {u"result"_s, js::S(closed ? resultOf(pct) : u"open"_s)},
            {u"return_pct"_s, optN(pct)},
            {u"paper"_s, js::B(js::truthy(js::path(&trip, {u"account"_s, u"is_paper"_s})))},
            {u"note"_s, js::S(notes.join(u';'))},
        });
    }
    return out;
}

QStringList optionDaysCovered(const QList<OJson>& fills) {
    QStringList out;
    for (const OJson& f : fills) {
        const QString sec = js::strOr(js::prop(js::propStrict(&f, u"contract"_s), u"secType"_s), QString());
        if (sec != u"OPT" && sec != u"BAG" && sec != u"FOP") continue;
        if (const auto when = tr::parseWhen(js::prop(&f, u"time"_s))) {
            const QString k = js::strOr(js::prop(&f, u"account_id"_s), QString()) + u'|' + tr::etKey(*when, true);
            if (!out.contains(k)) out << k;
        }
    }
    return out;
}

QString etIso(const QString& timeEt) {
    const QStringList dt = timeEt.split(u' ');
    const QString d = dt.value(0), t = dt.value(1);
    const QStringList ymd = d.split(u'-'), hms = t.split(u':');
    // 缺的那一格是 undefined → NaN;空串是 0
    const auto at = [](const QStringList& l, int i) { return i < l.size() ? util::jsStringToNumber(l[i]) : std::nan(""); };
    return util::utcIso(util::wallToEpoch({at(ymd, 0), at(ymd, 1), at(ymd, 2), at(hms, 0), at(hms, 1), at(hms, 2)}, QString::fromUtf16(util::kET)));
}

QList<OJson> optionFacts(const QList<OJson>& rows, const IsPaper& isPaper, const QSet<QString>& covered) {
    QList<OJson> out;
    for (const OJson& r : rows) {
        const QString action = Sx(r, u"action");
        if (action == u"开仓" || covered.contains(Sx(r, u"account_id") + u'|' + Sx(r, u"date_et"))) continue;
        const OJson* qtyP = P(r, u"qty");
        const double pnl = js::num(P(r, u"realized_pnl"));
        const bool hasQty = !(qtyP && qtyP->type == OJson::Null) && js::num(qtyP) > 0;
        const std::optional<double> points = hasQty ? std::optional<double>(util::pyRound(pnl / 100 / js::num(qtyP), 2)) : std::nullopt;
        // 份数不明时没有点数,成败只看盈亏的正负
        const QString result = !points ? (pnl == 0 ? u"flat"_s : pnl > 0 ? u"win"_s : u"loss"_s)
                                       : std::fabs(*points) < kFlatPoints ? u"flat"_s : *points > 0 ? u"win"_s : u"loss"_s;
        QStringList notes{u"结构按同一秒成交推断、无行权价"_s, u"已扣佣金"_s};
        if (!points) notes << u"份数不明,不给点数"_s;
        if (Sx(r, u"structure") == u"多个仓位同时结算") notes << u"多只同时到期,合在一起算"_s;
        const QString when = etIso(Sx(r, u"time_et"));
        const QString direction = Sx(r, u"direction");
        out << js::object({
            {u"id"_s, js::S(Sx(r, u"id"))},
            {u"kind"_s, js::S(u"option"_s)},
            {u"symbol"_s, js::S(Sx(r, u"symbol"))},
            {u"opened_at"_s, js::S(when)},
            {u"closed_at"_s, js::S(when)},
            {u"label"_s, js::S(Sx(r, u"symbol") + u' ' + Sx(r, u"structure") + (js::truthy(P(r, u"direction")) ? u'(' + direction + u')' : QString()) + u" · "_s + action)},
            {u"entry_price"_s, js::Null()},
            {u"exit_price"_s, js::Null()},
            {u"how"_s, js::S(action.contains(u"到期"_s) ? u"expired"_s : u"closed"_s)},
            {u"result"_s, js::S(result)},
            {u"return_pct"_s, js::Null()},
            {u"pnl_points"_s, optN(points)},
            {u"paper"_s, js::B(isPaper(Sx(r, u"account_id")))},
            {u"note"_s, js::S(notes.join(u';'))},
        });
    }
    return out;
}

QList<OJson> positionFacts(const QList<OJson>& rows, const IsPaper& isPaper) {
    QList<OJson> out;
    for (const OJson& p : rows) {
        const QString exit = Sx(p, u"exit");
        const QString how = Sx(p, u"status") == u"持仓中" || exit == u"持仓中" ? u"open"_s : exit.contains(u"到期"_s) ? u"expired"_s : u"closed"_s;
        const OJson* qtyP = P(p, u"qty");
        const bool hasQty = !(qtyP && qtyP->type == OJson::Null) && js::num(qtyP) > 0;
        const std::optional<double> qty = hasQty ? std::optional<double>(js::num(qtyP)) : std::nullopt;
        const double pnl = js::num(P(p, u"realized_pnl"));
        const std::optional<double> points = qty ? std::optional<double>(util::pyRound(pnl / 100 / *qty, 2)) : std::nullopt;
        const OJson* np = P(p, u"net_price");
        const bool debitOpen = !(np && np->type == OJson::Null) && js::num(np) > 0;
        const std::optional<double> pct = qty && debitOpen ? std::optional<double>(util::pyRound((pnl / (js::num(np) * 100 * *qty)) * 100, 1)) : std::nullopt;
        QString result;
        if (how == u"open") result = u"open"_s;
        else if (pct) result = resultOf(pct);
        else if (points) result = std::fabs(*points) < kFlatPoints ? u"flat"_s : *points > 0 ? u"win"_s : u"loss"_s;
        else result = pnl == 0 ? u"flat"_s : pnl > 0 ? u"win"_s : u"loss"_s;
        const QString right = Sx(p, u"right");
        const QString rightLabel = right == u"C" ? u"看涨"_s : right == u"P" ? u"看跌"_s : QString();
        QStringList labelParts;
        for (const QString& s : {Sx(p, u"symbol"), Sx(p, u"strikes"), rightLabel + Sx(p, u"structure"), Sx(p, u"direction")})
            if (!s.isEmpty()) labelParts << s;
        const QString closedEt = Sx(p, u"closed_et");
        QStringList note;
        if (!exit.isEmpty()) note << exit;
        note << u"已扣佣金"_s;
        out << js::object({
            {u"id"_s, js::S(Sx(p, u"id"))},
            {u"kind"_s, js::S(u"option"_s)},
            {u"symbol"_s, js::S(Sx(p, u"symbol"))},
            {u"opened_at"_s, js::S(etIso(Sx(p, u"open_et")))},
            {u"closed_at"_s, !closedEt.isEmpty() ? js::S(etIso(closedEt)) : js::Null()},
            {u"label"_s, js::S(labelParts.join(u' '))},
            {u"entry_price"_s, js::copyOrNull(np)},
            {u"exit_price"_s, js::Null()},
            {u"how"_s, js::S(how)},
            {u"result"_s, js::S(result)},
            {u"return_pct"_s, how == u"open" ? js::Null() : optN(pct)},
            {u"pnl_points"_s, how == u"open" ? js::Null() : optN(points)},
            {u"paper"_s, js::B(isPaper(Sx(p, u"account_id")))},
            {u"note"_s, js::S(note.join(u';'))},
        });
    }
    return out;
}

QStringList positionDays(const QList<OJson>& rows) {
    QStringList out;
    const auto add = [&](const QString& k) {
        if (!out.contains(k)) out << k;
    };
    for (const OJson& p : rows) {
        add(Sx(p, u"account_id") + u'|' + Sx(p, u"open_et").left(10));
        const QString closed = Sx(p, u"closed_et");
        if (!closed.isEmpty()) add(Sx(p, u"account_id") + u'|' + closed.left(10));
    }
    return out;
}

QList<OJson> collectFacts(const QList<OJson>& butterflies, const QList<OJson>& trips, const SettleClose& settleClose, double now, const QStringList& symbols,
                          const QList<OJson>& extra) {
    QSet<QString> want;
    for (const QString& s : symbols) want.insert(s.toUpper());
    QList<OJson> all;
    for (const QList<OJson>& part : {butterflyFacts(butterflies, settleClose, now), stockFacts(trips), extra})
        for (const OJson& f : part)
            if (want.isEmpty() || want.contains(Sx(f, u"symbol").toUpper())) all << f;
    // 比较函数在 opened_at 与 id 都相同时两头都回 1:V8 的排序只看"< 0",等同于"不小于",于是两者照原次序
    std::stable_sort(all.begin(), all.end(), [](const OJson& a, const OJson& b) {
        const QString ao = Sx(a, u"opened_at"), bo = Sx(b, u"opened_at");
        if (ao < bo) return false;
        if (ao > bo) return true;
        return Sx(a, u"id") < Sx(b, u"id");
    });
    if (all.size() > kMaxTradeFacts) all = all.mid(0, kMaxTradeFacts);
    return all;
}

QList<OJson> settlementsNeeded(const QList<OJson>& butterflies, double now) {
    const OJson pairs = tr::pairButterflies(butterflies);
    QList<OJson> out;
    QStringList seen;
    for (const OJson& record : butterflies) {
        if (linkOf(pairs, js::strOr(js::propStrict(&record, u"id"_s), QString())).truthy) continue;
        const OJson profile = tr::butterflyProfile(&record);
        if (profile.type == OJson::Null || now < tr::expiryClose(profile)) continue;
        const QString key = Sx(profile, u"symbol") + u'|' + Sx(profile, u"expiry");
        if (!seen.contains(key)) {
            seen << key;
            out << js::object({{u"symbol"_s, js::S(Sx(profile, u"symbol"))}, {u"date"_s, js::S(Sx(profile, u"expiry"))}});
        }
    }
    return out;
}

namespace {
QString resultLabel(const QString& r) {
    if (r == u"win") return u"赚"_s;
    if (r == u"loss") return u"亏"_s;
    if (r == u"flat") return u"持平"_s;
    if (r == u"open") return u"未了结"_s;
    if (r == u"unknown") return u"结果不明"_s;
    return u"undefined"_s;
}
/// v === null 是 "?";undefined 时 pyRound 原样回 undefined
QString priceText(const OJson* v) {
    if (!v) return u"undefined"_s;
    return v->type == OJson::Null ? u"?"_s : n2s(util::pyRound(js::num(v), 4));
}
QString signedNum(double v) { return (v > 0 ? u"+"_s : QString()) + n2s(v); }
}  // namespace

QString factLine(const OJson& f) {
    const QString kind = Sx(f, u"kind");
    const QString kindLabel = kind == u"butterfly" ? u"蝴蝶"_s : kind == u"stock" ? u"股票"_s : u"期权"_s;
    QStringList tags{tr::etKey(tr::parseWhen(P(f, u"opened_at")).value_or(0), true), kindLabel};
    if (js::truthy(P(f, u"paper"))) tags << u"模拟"_s;
    const OJson* rp = P(f, u"return_pct");
    const bool rpNull = rp && rp->type == OJson::Null;
    if (kind == u"option") {
        const QString pct = rpNull ? QString() : u' ' + signedNum(js::num(rp)) + u'%';
        const OJson* pp = P(f, u"pnl_points");
        const QString pts = js::nullish(pp) ? QString() : u' ' + signedNum(js::num(pp)) + u" 点/份"_s;
        const OJson* ep = P(f, u"entry_price");
        const QString price = ep && ep->type == OJson::Null ? QString() : u" @"_s + priceText(ep);
        return u'[' + tags.join(u" | "_s) + u"] "_s + Sx(f, u"label") + price + u':' + resultLabel(Sx(f, u"result")) + pct + pts + u'(' + Sx(f, u"note") + u')';
    }
    QString text = u'[' + tags.join(u" | "_s) + u"] "_s + Sx(f, u"label") + u" @"_s + priceText(P(f, u"entry_price"));
    if (Sx(f, u"how") != u"open") {
        const QString exitWord = Sx(f, u"how") == u"expired" ? u"到期结算价值"_s : u"平仓"_s;
        text += u" → "_s + exitWord + u" @"_s + priceText(P(f, u"exit_price"));
        if (js::truthy(P(f, u"closed_at"))) text += u'(' + Sx(f, u"closed_at").left(10) + u')';
    } else {
        text += u" → 持仓中"_s;
    }
    text += u':' + resultLabel(Sx(f, u"result"));
    if (!rpNull) text += u' ' + signedNum(js::num(rp)) + u'%';
    if (js::truthy(P(f, u"note"))) text += u'(' + Sx(f, u"note") + u')';
    return text;
}

QString tallyLine(const QList<OJson>& facts) {
    const auto count = [&](const QString& r) {
        double n = 0;
        for (const OJson& f : facts)
            if (Sx(f, u"result") == r) n += 1;
        return n2s(n);
    };
    return u"共 "_s + n2s(double(facts.size())) + u" 笔:赚 "_s + count(u"win"_s) + u"、亏 "_s + count(u"loss"_s) + u"、持平 "_s + count(u"flat"_s) + u"、"_s +
           u"未了结 "_s + count(u"open"_s) + u"、结果不明 "_s + count(u"unknown"_s);
}

}  // namespace ibkr::analysis::trade_outcomes
