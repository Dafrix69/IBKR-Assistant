#include "domain/positions.h"

#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/py.h"

#include <QHash>
#include <QRegularExpression>
#include <QSet>

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::domain {

namespace {
const OJson* f(const OJson* o, const char16_t* k) { return js::prop(o, QString::fromUtf16(k)); }
/// x ?? {}:原始值也照样往下取(取到 undefined)
const OJson* orEmpty(const OJson* v) {
    static const OJson empty = js::object();
    return js::nullish(v) ? &empty : v;
}
/// py.ts 的 finiteOrNull:null / undefined / 布尔是空;数原样;别的走 Number()
std::optional<double> finiteOrNull(const OJson* v) {
    if (js::nullish(v) || js::isBool(v)) return std::nullopt;
    const double n = js::num(v);
    return std::isfinite(n) ? std::optional<double>(n) : std::nullopt;
}
/// Number(x ?? 0) || 0
double numOr0(const OJson* v) {
    const double n = js::nullish(v) ? 0 : js::num(v);
    return std::isnan(n) || n == 0 ? 0 : n;
}
QString upperFirst(const QString& s) { return s.left(1).toUpper(); }
}  // namespace

QString makeKey(const QString& account, const QString& symbol, const QString& secType, const QString& leg) {
    const QString base = account + u'|' + symbol + u'|' + secType;
    return leg.isEmpty() ? base : base + u'|' + leg;
}

QString fmtStrike(const OJson* strike) {
    const double value = js::num(strike);
    if (js::nullish(strike) || (js::isStr(strike) && strike->s.isEmpty()) || std::isnan(value)) return {};
    QString s = util::fmtF(value, 4);
    static const QRegularExpression zeros(u"0+\\z"_s);
    s.remove(zeros);
    if (s.endsWith(u'.')) s.chop(1);
    return s;
}

QString legOf(const OJson* contract) {
    const OJson* c = orEmpty(contract);
    QString secType = js::strOr(f(c, u"secType"), u"STK"_s);
    if (secType.isEmpty()) secType = u"STK"_s;
    if (secType != u"OPT" && secType != u"FOP") return {};
    const QString expiry = js::strOr(f(c, u"lastTradeDateOrContractMonth"), QString()).left(8);
    const QString right = upperFirst(js::strOr(f(c, u"right"), QString()));
    return expiry + u'|' + fmtStrike(f(c, u"strike")) + u'|' + right;
}

QString positionLabel(const QString& symbol, const QString& secType, const OJson* contract) {
    const OJson* c = orEmpty(contract);
    if (secType != u"OPT" && secType != u"FOP") return symbol;
    QString expiry = js::strOr(f(c, u"lastTradeDateOrContractMonth"), QString()).left(8);
    if (expiry.size() == 8) expiry = expiry.left(4) + u'-' + expiry.mid(4, 2) + u'-' + expiry.mid(6);
    const QString right = upperFirst(js::strOr(f(c, u"right"), QString()));
    QStringList parts;
    for (const QString& p : {symbol, fmtStrike(f(c, u"strike")) + right, expiry})
        if (!util::jsTrim(p).isEmpty()) parts << p;
    return parts.join(u' ');
}

// ================================================================ combos.ts
bool same(double a, double b) { return std::abs(a - b) <= 1e-6 * std::max({1.0, std::abs(a), std::abs(b)}); }

namespace {

double strikeOfLeg(const OJson& r) { return numOr0(f(orEmpty(f(&r, u"contract")), u"strike")); }
QString rightOfLeg(const OJson& r) { return js::strOr(f(orEmpty(f(&r, u"contract")), u"right"), QString()); }

struct LegFields {
    QList<double> strikes;
    QStringList rights;
    QList<double> qtys;
};
LegFields legFields(const QList<OJson>& legs) {
    LegFields lf;
    for (const OJson& r : legs) {
        lf.strikes << strikeOfLeg(r);
        lf.rights << upperFirst(rightOfLeg(r));
        lf.qtys << numOr0(f(&r, u"quantity"));
    }
    return lf;
}

bool sameRightOf(const QStringList& rights) { return QSet<QString>(rights.begin(), rights.end()).size() == 1; }

/// JS 的 a < b ? -1 : a > b ? 1 : 0(按 UTF-16 码元)
int cmpStr(const QString& a, const QString& b) { return a < b ? -1 : a > b ? 1 : 0; }
/// 比较函数的返回值是 a - b 这种数:按 JS 的 sort 认它的正负(NaN 当 0)
bool lessBy(double v) { return v < 0; }

}  // namespace

std::optional<std::pair<QString, double>> shapeOf(const QList<OJson>& legs) {
    const LegFields lf = legFields(legs);
    const auto& s = lf.strikes;
    const auto& q = lf.qtys;
    const bool sameRight = sameRightOf(lf.rights);
    if (legs.size() == 2 && sameRight && q[0] * q[1] < 0 && same(std::abs(q[0]), std::abs(q[1]))) return std::pair{u"vertical"_s, std::abs(q[0])};
    if (legs.size() == 3 && sameRight && same(s[1] - s[0], s[2] - s[1]) && same(q[0], q[2]) && same(q[1], -2.0 * q[0]) && q[0] != 0)
        return std::pair{u"butterfly"_s, std::abs(q[0])};
    if (legs.size() == 4 && lf.rights.join(u',') == u"P,P,C,C" && q[0] * q[1] < 0 && q[2] * q[3] < 0 && same(std::abs(q[0]), std::abs(q[1])) &&
        same(std::abs(q[2]), std::abs(q[3])))
        return std::pair{same(s[1], s[2]) ? u"iron_butterfly"_s : u"iron_condor"_s, std::abs(q[0])};
    return std::nullopt;
}

QList<QList<OJson>> splitStructures(const QList<OJson>& legs) {
    QList<QList<OJson>> out;
    QList<OJson> rest = legs;
    while (rest.size() >= 2) {
        bool matched = false;
        for (int size : {4, 3, 2}) {
            if (rest.size() >= size && shapeOf(rest.mid(0, size))) {
                out << rest.mid(0, size);
                rest = rest.mid(size);
                matched = true;
                break;
            }
        }
        if (!matched) break;
    }
    if (!rest.isEmpty()) out << rest;
    return out.isEmpty() ? QList<QList<OJson>>{legs} : out;
}

QList<OJson> groupLegs(const QList<OJson>& rows) {
    struct Bucket {
        QString account, symbol, expiry;
        QList<OJson> legs;
    };
    QStringList order;
    QHash<QString, Bucket> buckets;
    for (const OJson& row : rows) {
        QString secType = js::strOr(f(&row, u"sec_type"), u"STK"_s);
        if (secType.isEmpty()) secType = u"STK"_s;
        if (secType != u"OPT" && secType != u"FOP") continue;
        const OJson* contract = orEmpty(f(&row, u"contract"));
        const QString expiry = js::strOr(f(contract, u"lastTradeDateOrContractMonth"), QString()).left(8);
        const QString account = js::str(f(&row, u"account"));
        const QString symbol = js::str(f(&row, u"symbol"));
        const QString id = account + u'|' + symbol + u'|' + expiry;
        if (!buckets.contains(id)) {
            order << id;
            buckets.insert(id, {account, symbol, expiry, {}});
        }
        buckets[id].legs << row;
    }
    QList<Bucket> ordered;
    for (const QString& id : order) ordered << buckets.value(id);
    std::stable_sort(ordered.begin(), ordered.end(), [](const Bucket& a, const Bucket& b) {
        const int c = a.account != b.account ? cmpStr(a.account, b.account) : a.symbol != b.symbol ? cmpStr(a.symbol, b.symbol) : cmpStr(a.expiry, b.expiry);
        return c < 0;
    });

    QList<OJson> combos;
    for (const Bucket& b : ordered) {
        if (b.legs.size() < 2) continue;
        // 同一行权价看跌排在看涨前面:铁蝶内侧两条腿行权价相同,按字母序会读成 P,C,P,C
        const auto putFirst = [](const OJson& r) { return upperFirst(rightOfLeg(r)) == u"P" ? 0 : 1; };
        QList<OJson> bucket = b.legs;
        std::stable_sort(bucket.begin(), bucket.end(), [&](const OJson& x, const OJson& y) {
            const double d = strikeOfLeg(x) - strikeOfLeg(y);
            if (d != 0 && !std::isnan(d)) return lessBy(d);
            const int p = putFirst(x) - putFirst(y);
            if (p != 0) return p < 0;
            return cmpStr(rightOfLeg(x), rightOfLeg(y)) < 0;
        });
        for (const QList<OJson>& legs : splitStructures(bucket)) {
            if (legs.size() < 2) continue;
            const LegFields lf = legFields(legs);
            const bool sameRight = sameRightOf(lf.rights);
            const QString rightName = sameRight ? (lf.rights[0] == u"C" ? u"看涨"_s : lf.rights[0] == u"P" ? u"看跌"_s : QString()) : QString();
            QStringList st;
            for (double s : lf.strikes) {
                const OJson sj = OJson::number(s);
                st << fmtStrike(&sj);
            }
            const QString strikeText = st.join(u'/');
            const auto shape = shapeOf(legs);
            QString kind = u"custom"_s;
            QString label = u"组合(%1 腿) %2"_s.arg(legs.size()).arg(strikeText);
            OJson quantity = OJson::null();
            if (shape) {
                kind = shape->first;
                quantity = OJson::number(shape->second);
                if (kind == u"vertical") label = rightName + u"价差 "_s + strikeText;
                else if (kind == u"butterfly") label = (lf.qtys[0] > 0 ? u"买入"_s : u"卖出"_s) + rightName + u"蝴蝶 "_s + strikeText;
                else label = (kind == u"iron_butterfly" ? u"铁蝶 "_s : u"铁鹰 "_s) + strikeText;
            }
            const auto sumOf = [&](const char16_t* key) -> OJson {
                double total = 0;
                for (const OJson& r : legs) {
                    const OJson* v = f(&r, key);
                    if (js::nullish(v)) return OJson::null();
                    total += js::num(v);
                }
                return OJson::number(util::pyRound(total, 2));
            };
            double netCost = 0;
            for (qsizetype i = 0; i < legs.size(); ++i) netCost += lf.qtys[i] * numOr0(f(&legs[i], u"avg_cost"));
            QList<OJson> keys;
            for (const OJson& r : legs) keys << js::copyOrNull(f(&r, u"key"));
            combos << js::object({{u"account"_s, js::S(b.account)},
                                  {u"symbol"_s, js::S(b.symbol)},
                                  {u"expiry"_s, js::S(b.expiry)},
                                  {u"right"_s, js::S(sameRight ? lf.rights[0] : QString())},
                                  {u"kind"_s, js::S(kind)},
                                  {u"label"_s, js::S(label)},
                                  {u"quantity"_s, quantity},
                                  {u"net_cost"_s, js::N(util::pyRound(netCost, 2))},
                                  {u"market_value"_s, sumOf(u"market_value")},
                                  {u"unrealized_pnl"_s, sumOf(u"unrealized_pnl")},
                                  {u"legs"_s, js::array(keys)}});
        }
    }
    return combos;
}

OJson comboRow(const OJson& combo, const QList<OJson>& rows) {
    QHash<QString, OJson> byKey;
    for (const OJson& r : rows) byKey.insert(js::str(f(&r, u"key")), r);
    QList<OJson> legs;
    QStringList legKeys;
    if (const OJson* lk = f(&combo, u"legs"); js::isArr(lk))
        for (const OJson& k : lk->items) {
            legKeys << js::str(&k);
            if (byKey.contains(js::str(&k))) legs << byKey.value(js::str(&k));
        }
    QList<double> qtys, ratios;
    for (const OJson& r : legs) qtys << numOr0(f(&r, u"quantity"));
    double units = js::num(&static_cast<const OJson&>(js::nullish(f(&combo, u"quantity")) ? OJson::number(0) : *f(&combo, u"quantity")));
    if (units == 0 || std::isnan(units)) units = 1.0;  // 认不出形状的组合:按 1 组算
    for (double q : qtys) ratios << q / units;
    double netCost = 0;
    for (qsizetype i = 0; i < legs.size(); ++i) netCost += ratios[i] * numOr0(f(&legs[i], u"avg_cost"));
    std::optional<double> netPrice;
    {
        bool all = !legs.isEmpty();
        double sum = 0;
        for (qsizetype i = 0; i < legs.size(); ++i) {
            const OJson* p = f(&legs[i], u"market_price");
            if (js::nullish(p)) all = false;
            else sum += ratios[i] * js::num(p);
        }
        if (all) netPrice = sum;
    }
    std::optional<double> netClose;
    {
        bool all = !legs.isEmpty();
        double sum = 0;
        for (qsizetype i = 0; i < legs.size(); ++i) {
            const auto c = finiteOrNull(f(&legs[i], u"close_price"));
            if (!c) all = false;
            else sum += ratios[i] * *c;
        }
        if (all) netClose = sum;
    }
    const bool longSide = netCost >= 0;
    const bool signedMark = js::isStr(f(&combo, u"kind")) && f(&combo, u"kind")->s == u"custom";
    const auto mark = [&](double v) { return util::pyRound(signedMark ? (longSide ? v : 0 - v) : std::abs(v), 4); };
    const OJson* contract = legs.isEmpty() ? orEmpty(nullptr) : orEmpty(f(&legs[0], u"contract"));
    double multiplier = 100;
    if (!legs.isEmpty()) {
        const OJson* m = f(&legs[0], u"multiplier");
        const double v = js::nullish(m) ? 100 : js::num(m);
        multiplier = std::isnan(v) || v == 0 ? 100 : v;
    }
    QStringList parts;
    for (qsizetype i = 0; i < legs.size(); ++i) {
        const OJson* c = orEmpty(f(&legs[i], u"contract"));
        parts << (ratios[i] >= 0 ? u"+"_s : QString()) + util::pyG(ratios[i]) + u'x' + fmtStrike(f(c, u"strike")) + upperFirst(js::strOr(f(c, u"right"), QString()));
    }
    // 腿身份仍按"行权价、再按看涨看跌字母序"拼:组合的 key 由它而来,追踪按 key 认持仓
    QList<int> idx;
    for (int i = 0; i < parts.size(); ++i) idx << i;
    std::stable_sort(idx.begin(), idx.end(), [&](int a, int b) {
        const OJson& la = legs.value(a);
        const OJson& lb = legs.value(b);
        const double d = strikeOfLeg(la) - strikeOfLeg(lb);
        if (d != 0 && !std::isnan(d)) return d < 0;
        return cmpStr(rightOfLeg(la), rightOfLeg(lb)) < 0;
    });
    QStringList sigParts;
    for (int i : idx) sigParts << parts[i];
    const QString legId = js::str(f(&combo, u"expiry")) + u'|' + sigParts.join(u',');

    OJson out = js::object();
    out.set(u"key"_s, js::S(makeKey(js::str(f(&combo, u"account")), js::str(f(&combo, u"symbol")), u"BAG"_s, legId)));
    const auto setIf = [&](const QString& k, const OJson* v) {
        if (v) out.set(k, *v);  // undefined 的键 JSON 里不出现
    };
    setIf(u"account"_s, f(&combo, u"account"));
    setIf(u"symbol"_s, f(&combo, u"symbol"));
    out.set(u"sec_type"_s, js::S(u"BAG"_s));
    out.set(u"leg"_s, js::S(legId));
    setIf(u"label"_s, f(&combo, u"label"));
    setIf(u"kind"_s, f(&combo, u"kind"));
    out.set(u"quantity"_s, js::N(longSide ? units : -units));
    out.set(u"multiplier"_s, js::N(multiplier));
    if (legs.isEmpty()) out.set(u"currency"_s, js::S(u"USD"_s));
    else setIf(u"currency"_s, f(&legs[0], u"currency"));
    out.set(u"avg_cost"_s, js::N(util::pyRound(std::abs(netCost), 4)));
    out.set(u"market_price"_s, netPrice ? js::N(mark(*netPrice)) : js::Null());
    if (netClose) out.set(u"close_price"_s, js::N(mark(*netClose)));  // 没有就不带这个键
    out.set(u"net_side"_s, js::S(longSide ? u"debit"_s : u"credit"_s));
    out.set(u"market_value"_s, js::copyOrNull(f(&combo, u"market_value")));
    out.set(u"unrealized_pnl"_s, js::copyOrNull(f(&combo, u"unrealized_pnl")));
    out.set(u"legs"_s, js::isArr(f(&combo, u"legs")) ? *f(&combo, u"legs") : js::array());  // [...combo.legs]
    QList<OJson> rs;
    for (double r : ratios) rs << js::N(r);
    out.set(u"ratios"_s, js::array(rs));
    static const QHash<QString, QString> strategy{{u"butterfly"_s, u"BUTTERFLY"_s}, {u"vertical"_s, u"VERTICAL"_s}, {u"iron_condor"_s, u"IRON_CONDOR"_s},
                                                  {u"iron_butterfly"_s, u"IRON_CONDOR"_s}};
    const QString kind = js::str(f(&combo, u"kind"));
    OJson c = js::object();
    c.set(u"secType"_s, js::S(u"BAG"_s));
    if (const OJson* s = f(&combo, u"symbol")) c.set(u"symbol"_s, *s);
    const OJson* ex = f(contract, u"exchange");
    c.set(u"exchange"_s, js::truthy(ex) ? *ex : js::S(u"SMART"_s));
    const OJson* cur = f(contract, u"currency");
    c.set(u"currency"_s, js::truthy(cur) ? *cur : js::S(u"USD"_s));
    c.set(u"multiplier"_s, js::S(util::jsNumberToString(std::trunc(multiplier))));
    c.set(u"combo_strategy"_s, strategy.contains(kind) ? js::S(strategy.value(kind)) : js::Null());
    if (const OJson* l = f(&combo, u"label")) c.set(u"label"_s, *l);
    QList<OJson> cl;
    for (qsizetype i = 0; i < legs.size(); ++i) {
        const OJson* lc = orEmpty(f(&legs[i], u"contract"));
        cl << js::object({{u"lastTradeDateOrContractMonth"_s, js::copyOrNull(f(lc, u"lastTradeDateOrContractMonth"))},
                          {u"strike"_s, js::copyOrNull(f(lc, u"strike"))},
                          {u"right"_s, js::copyOrNull(f(lc, u"right"))},
                          {u"ratio"_s, js::N(ratios[i])}});
    }
    c.set(u"legs"_s, js::array(cl));
    out.set(u"contract"_s, c);
    return out;
}

QList<OJson> withCombos(const QList<OJson>& rows) {
    QList<OJson> list = rows;
    for (const OJson& c : groupLegs(list)) list << comboRow(c, rows);
    return list;
}

// ================================================================ marketdata.ts
const OJson& timeframes() {
    static const OJson t = [] {
        const auto tf = [](const char16_t* bar, const char16_t* dur, const char16_t* fb, double sec, const char16_t* label, const char16_t* htf) {
            return js::object({{u"bar_size"_s, js::S(QString::fromUtf16(bar))},
                               {u"duration"_s, js::S(QString::fromUtf16(dur))},
                               {u"fallback"_s, js::S(QString::fromUtf16(fb))},
                               {u"seconds"_s, js::N(sec)},
                               {u"label"_s, js::S(QString::fromUtf16(label))},
                               {u"htf"_s, htf ? js::S(QString::fromUtf16(htf)) : js::Null()}});
        };
        return js::object({{u"1m"_s, tf(u"1 min", u"2 D", u"4 D", 60, u"1 分钟", u"15m")},
                           {u"2m"_s, tf(u"2 mins", u"3 D", u"6 D", 120, u"2 分钟", u"30m")},
                           {u"5m"_s, tf(u"5 mins", u"5 D", u"10 D", 300, u"5 分钟", u"1h")},
                           {u"15m"_s, tf(u"15 mins", u"10 D", u"20 D", 900, u"15 分钟", u"1h")},
                           {u"30m"_s, tf(u"30 mins", u"15 D", u"30 D", 1800, u"30 分钟", u"1d")},
                           {u"1h"_s, tf(u"1 hour", u"30 D", u"60 D", 3600, u"1 小时", u"1d")},
                           {u"1d"_s, tf(u"1 day", u"1 Y", u"2 Y", 86400, u"日线", nullptr)}});
    }();
    return t;
}

}  // namespace ibkr::domain
