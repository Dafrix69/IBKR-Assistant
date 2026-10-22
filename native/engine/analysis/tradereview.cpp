#include "analysis/tradereview.h"

#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/py.h"
#include "util/tz.h"

#include <QRegularExpression>
#include <QStringList>

#include <algorithm>
#include <cmath>
#include <limits>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;

namespace ibkr::analysis::tradereview {

namespace {
constexpr double kInf = std::numeric_limits<double>::infinity();

/// TS 的 num():null / undefined / "" 是空,其余 Number() 之后要有限
std::optional<double> num(const OJson* v) {
    if (js::nullish(v) || (v->type == OJson::String && v->s.isEmpty())) return std::nullopt;
    const double out = js::num(v);
    return std::isfinite(out) ? std::optional<double>(out) : std::nullopt;
}
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : js::Null(); }
const OJson* P(const OJson& o, const char16_t* k) { return js::prop(&o, QString::fromUtf16(k)); }
/// o[k] 当数用(TS 的算术把它 ToNumber)
double N(const OJson& o, const char16_t* k) { return js::num(P(o, k)); }
QString Sx(const OJson& o, const char16_t* k) { return js::str(P(o, k)); }
/// o[k] === null(undefined 不算)
bool isNull(const OJson& o, const char16_t* k) {
    const OJson* v = P(o, k);
    return v && v->type == OJson::Null;
}
/// o[k] ?? {} 的那个 {}:不是对象也照样往下读(原始值上读出来是 undefined)
const OJson* orEmpty(const OJson* v) {
    static const OJson empty = js::object();
    return js::nullish(v) ? &empty : v;
}
QString n2s(double v) { return util::jsNumberToString(v); }
/// bars[i]["k"]:bar 是 null 时 TS 抛 TypeError
const OJson* barProp(const QList<OJson>& bars, qsizetype i, const QString& k) { return js::propStrict(&bars[i], k); }

/// fills.map(f => parseWhen(f["time"])).filter(非空);fills 不是数组时 TS 抛 "<表达式>.map is not a function"
QList<double> fillTimes(const OJson* fills, const QString& expr) {
    if (!js::isArr(fills)) throw util::JsError(expr + u".map is not a function"_s);
    QList<double> out;
    for (const OJson& f : fills->items)
        if (const auto t = parseWhen(js::propStrict(&f, u"time"_s))) out << *t;
    return out;
}
double minOf(const QList<double>& v) {
    double m = kInf;
    for (double x : v) m = jm::min(m, x);
    return m;
}
}  // namespace

bool onObjectPrototype(const QString& k) {
    static const QStringList names{u"constructor"_s,      u"__defineGetter__"_s, u"__defineSetter__"_s, u"hasOwnProperty"_s,
                                   u"__lookupGetter__"_s, u"__lookupSetter__"_s, u"isPrototypeOf"_s,    u"propertyIsEnumerable"_s,
                                   u"toString"_s,         u"valueOf"_s,          u"toLocaleString"_s,   u"__proto__"_s};
    return names.contains(k);
}

// ---------------------------------------------------------------- 结构
QString fmtExpiry(const OJson* raw) {
    const QString s = js::strOr(raw, QString());
    static const QRegularExpression re(u"\\A[0-9]{8}\\z"_s);
    if (re.match(s).hasMatch()) return s.left(4) + u'-' + s.mid(4, 2) + u'-' + s.mid(6, 2);
    return s;
}

OJson butterflyProfile(const OJson* record) {
    const OJson* contract = orEmpty(js::propStrict(record, u"contract"_s));
    const OJson* secType = js::prop(contract, u"secType"_s);
    if (!(js::isStr(secType) && secType->s == u"BAG")) return OJson::null();
    // [...(contract["legs"] ?? [])]:字符串按字符展开(每个"腿"上读不出行权价,下面回 null);不可迭代的抛
    const OJson* legsRaw = js::prop(contract, u"legs"_s);
    if (js::isStr(legsRaw)) return OJson::null();
    if (!js::nullish(legsRaw) && !js::isArr(legsRaw)) throw util::JsError(u"(contract.legs ?? []) is not iterable"_s);
    const QList<OJson> legs = js::isArr(legsRaw) ? legsRaw->items : QList<OJson>{};
    if (legs.size() != 3) return OJson::null();
    struct Row {
        double strike;
        double ratio;
        QString action;
        const OJson* leg;
    };
    QList<Row> rows;
    for (const OJson& leg : legs) {
        const auto strike = num(js::propStrict(&leg, u"strike"_s));
        if (!strike) return OJson::null();
        const OJson* ratioRaw = js::prop(&leg, u"ratio"_s);
        const double r = js::nullish(ratioRaw) ? 1 : js::num(ratioRaw);
        rows << Row{*strike, std::trunc((r != 0 && !std::isnan(r)) ? r : 1), js::strOr(js::prop(&leg, u"action"_s), QString()), &leg};
    }
    std::stable_sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) { return a.strike - b.strike < 0; });
    const Row &r1 = rows[0], &r2 = rows[1], &r3 = rows[2];
    if (r1.ratio != 1 || r2.ratio != 2 || r3.ratio != 1 || r1.action != r3.action || r2.action == r1.action) return OJson::null();
    // new Set(…):去重留第一次出现的次序
    QStringList rights, expiries;
    for (const Row* r : {&r1, &r2, &r3}) {
        const QString right = js::strOr(js::prop(r->leg, u"right"_s), QString());
        const QString exp = js::strOr(js::prop(r->leg, u"lastTradeDateOrContractMonth"_s), QString());
        if (!rights.contains(right)) rights << right;
        if (!expiries.contains(exp)) expiries << exp;
    }
    if (rights.size() != 1 || expiries.size() != 1) return OJson::null();

    const OJson* order = orEmpty(js::propStrict(record, u"order"_s));
    const OJson* ibkr = orEmpty(js::propStrict(record, u"ibkr"_s));
    const QString action = js::strOr(js::prop(order, u"action"_s), u"BUY"_s).toUpper();
    const auto fill = num(js::prop(ibkr, u"avg_fill_price"_s));
    const auto limit = num(js::prop(order, u"lmtPrice"_s));
    const std::optional<double> debit = fill ? fill : limit;
    const auto tq = num(js::prop(order, u"totalQuantity"_s));
    const double qty = std::trunc(tq && *tq != 0 ? *tq : 1);
    const auto m1 = num(js::prop(contract, u"multiplier"_s));
    const auto m2 = num(js::prop(r1.leg, u"multiplier"_s));
    const double multiplier = m1 && *m1 != 0 ? *m1 : m2 && *m2 != 0 ? *m2 : 100.0;
    const QString right = rights[0];
    const QString expiryRaw = expiries[0];
    const OJson expiryRawJ = js::S(expiryRaw);
    const double k1 = r1.strike, k2 = r2.strike, k3 = r3.strike;
    return js::object({
        {u"symbol"_s, js::S(js::strOr(js::prop(contract, u"symbol"_s), QString()))},
        {u"right"_s, js::S(right)},
        {u"right_label"_s, js::S(right == u"P" ? u"看跌"_s : u"看涨"_s)},
        {u"expiry"_s, js::S(fmtExpiry(&expiryRawJ))},
        {u"expiry_raw"_s, expiryRawJ},
        {u"lower"_s, js::N(k1)},
        {u"center"_s, js::N(k2)},
        {u"upper"_s, js::N(k3)},
        {u"width"_s, js::N(util::pyRound(k2 - k1, 4))},
        {u"width_upper"_s, js::N(util::pyRound(k3 - k2, 4))},
        {u"symmetric"_s, js::B(std::fabs((k2 - k1) - (k3 - k2)) < 1e-9)},
        {u"action"_s, js::S(action)},
        {u"qty"_s, js::N(qty)},
        {u"multiplier"_s, js::N(multiplier)},
        {u"debit"_s, optN(debit)},
        {u"price_estimated"_s, js::B(!fill)},
        {u"trading_class"_s, js::S(js::strOr(js::prop(r1.leg, u"tradingClass"_s), QString()))},
    });
}

bool sameButterfly(const OJson& a, const OJson& b) {
    for (const char16_t* k : {u"symbol", u"right", u"expiry_raw", u"lower", u"center", u"upper"})
        if (!js::strictEqual(P(a, k), P(b, k))) return false;
    return true;
}

double payoffPerUnit(const OJson& profile, double s) {
    const double k1 = N(profile, u"lower"), k2 = N(profile, u"center"), k3 = N(profile, u"upper");
    double v;
    const OJson* right = P(profile, u"right");
    if (js::isStr(right) && right->s == u"P") v = jm::max(k1 - s, 0) - 2 * jm::max(k2 - s, 0) + jm::max(k3 - s, 0);
    else v = jm::max(s - k1, 0) - 2 * jm::max(s - k2, 0) + jm::max(s - k3, 0);
    return util::pyRound(v, 4);
}

std::optional<double> pnlAt(const OJson& profile, double s) {
    const OJson* debit = P(profile, u"debit");
    if (js::nullish(debit)) return std::nullopt;
    const OJson* action = P(profile, u"action");
    const double sign = js::isStr(action) && action->s == u"BUY" ? 1.0 : -1.0;
    return util::pyRound(sign * (payoffPerUnit(profile, s) - js::num(debit)) * N(profile, u"multiplier") * N(profile, u"qty"), 2);
}

OJson zone(const OJson& profile) {
    const OJson* debitRaw = P(profile, u"debit");
    const double mult = N(profile, u"multiplier"), qty = N(profile, u"qty");
    if (js::nullish(debitRaw))
        return js::object({{u"lower_be"_s, js::Null()}, {u"upper_be"_s, js::Null()}, {u"max_profit"_s, js::Null()}, {u"max_loss"_s, js::Null()}, {u"known"_s, js::B(false)}});
    const double debit = js::num(debitRaw);
    const double width = jm::min(N(profile, u"width"), N(profile, u"width_upper"));
    const double tent = (width - debit) * mult * qty;
    const double premium = debit * mult * qty;
    const OJson* action = P(profile, u"action");
    const bool isLong = js::isStr(action) && action->s == u"BUY";
    return js::object({
        {u"lower_be"_s, js::N(util::pyRound(N(profile, u"lower") + debit, 4))},
        {u"upper_be"_s, js::N(util::pyRound(N(profile, u"upper") - debit, 4))},
        {u"max_profit"_s, js::N(util::pyRound(isLong ? tent : premium, 2))},
        {u"max_loss"_s, js::N(util::pyRound(isLong ? premium : tent, 2))},
        {u"known"_s, js::B(true)},
    });
}

// ---------------------------------------------------------------- 时间
std::optional<double> parseWhen(const QString& raw) {
    const QString s = util::jsTrim(raw);
    if (s.isEmpty()) return std::nullopt;
    if (const auto ib = util::ibWallTime(s)) return util::zonedEpoch(ib->wall, ib->tz);
    static const QRegularExpression re(u"\\A([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[ T]([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?)?\\z"_s);
    if (const auto m = re.match(s); m.hasMatch()) {
        const auto part = [&](int i) { return m.captured(i).isEmpty() ? 0.0 : util::jsStringToNumber(m.captured(i)); };
        return util::zonedEpoch({part(1), part(2), part(3), part(4), part(5), part(6)}, QString::fromUtf16(util::kET));
    }
    // ISO 带时区:空格换成 T(只换第一个),结尾的 Z 换成 +00:00
    QString iso = s;
    if (const qsizetype sp = iso.indexOf(u' '); sp >= 0) iso[sp] = u'T';
    if (iso.endsWith(u'Z')) iso = iso.chopped(1) + u"+00:00"_s;
    const double parsed = util::jsDateParse(iso);
    return std::isfinite(parsed) ? std::optional<double>(parsed) : std::nullopt;
}

std::optional<double> parseWhen(const OJson* value) {
    if (js::nullish(value)) return std::nullopt;
    if (value->type == OJson::Number) return std::isfinite(value->n) ? std::optional<double>(value->n) : std::nullopt;
    return parseWhen(js::str(value));
}

QString etKey(double epochMs, bool daily) {
    const util::WallParts p = util::wallParts(epochMs, QString::fromUtf16(util::kET));
    const QString date = n2s(p.year) + u'-' + util::pad2(p.month) + u'-' + util::pad2(p.day);
    return daily ? date : date + u' ' + util::pad2(p.hour) + u':' + util::pad2(p.minute);
}

Entry entryOf(const OJson* record) {
    const OJson* fills = js::prop(orEmpty(js::propStrict(record, u"ibkr"_s)), u"fills"_s);
    static const OJson emptyArr = js::array();
    const QList<double> times = fillTimes(js::nullish(fills) ? &emptyArr : fills, u"fills"_s);
    if (!times.isEmpty()) return {minOf(times), false};
    const auto created = parseWhen(js::propStrict(record, u"created_at"_s));
    if (!created) throw ReviewError(u"这条记录既没有成交时间也没有提交时间,无法定位开仓时刻。"_s);
    return {*created, true};
}

OJson findExit(const OJson& profile, double entryTime, const QList<OJson>& others, const OJson* excludeId) {
    OJson best = OJson::null();
    for (const OJson& other : others) {
        if (js::strictEqual(js::propStrict(&other, u"id"_s), excludeId)) continue;
        const OJson p = butterflyProfile(&other);
        if (p.type == OJson::Null || !sameButterfly(p, profile) || js::strictEqual(P(p, u"action"), P(profile, u"action"))) continue;
        const OJson* ibkr = orEmpty(js::propStrict(&other, u"ibkr"_s));
        const auto fill = num(js::prop(ibkr, u"avg_fill_price"_s));
        const OJson* status = js::prop(&other, u"final_status"_s);
        if (!fill && !(js::isStr(status) && status->s == u"filled")) continue;
        const OJson* fills = js::prop(ibkr, u"fills"_s);
        static const OJson emptyArr = js::array();
        const QList<double> times = fillTimes(js::nullish(fills) ? &emptyArr : fills, u"(ibkr.fills ?? [])"_s);
        const std::optional<double> when = !times.isEmpty() ? std::optional<double>(minOf(times)) : parseWhen(js::prop(&other, u"created_at"_s));
        if (!when || *when < entryTime) continue;
        if (best.type == OJson::Null || *when < best.get(u"time"_s)->n) {
            const OJson* id = js::prop(&other, u"id"_s);
            best = js::object({{u"time"_s, js::N(*when)},
                               {u"price"_s, optN(fill)},
                               {u"record_id"_s, js::nullish(id) ? js::Null() : *id},
                               {u"estimated"_s, js::B(!fill)}});
        }
    }
    return best;
}

bool pairsHas(const OJson& pairs, const QString& key) { return pairs.get(key) || onObjectPrototype(key); }

OJson pairButterflies(const QList<OJson>& trades) {
    OJson pairs = js::object();
    for (const OJson& record : trades) {
        const OJson* id = js::propStrict(&record, u"id"_s);
        if (pairsHas(pairs, js::str(id))) continue;
        const OJson profile = butterflyProfile(&record);
        if (profile.type == OJson::Null) continue;
        Entry entry;
        try {
            entry = entryOf(&record);
        } catch (const ReviewError&) {
            continue;
        }
        const OJson exitRec = findExit(profile, entry.time, trades, id);
        if (exitRec.type == OJson::Null) continue;
        const OJson* peer = exitRec.get(u"record_id"_s);
        if (pairsHas(pairs, js::str(peer))) continue;
        pairs.set(js::str(id), js::object({{u"role"_s, js::S(u"entry"_s)}, {u"peer"_s, *peer}}));
        pairs.set(js::str(peer), js::object({{u"role"_s, js::S(u"exit"_s)}, {u"peer"_s, id ? *id : OJson()}}));
        // id 是 undefined 时 peer: undefined(JSON 里没有这一键)
        if (!id) pairs.get(js::str(peer))->remove(u"peer"_s);
    }
    return pairs;
}

double expiryClose(const OJson& profile) {
    const QStringList parts = js::str(P(profile, u"expiry")).split(u'-');
    const auto at = [&](int i) { return i < parts.size() ? util::jsStringToNumber(parts[i]) : std::nan(""); };
    return util::wallToEpoch({at(0), at(1), at(2), 16, 0, 0}, QString::fromUtf16(util::kET));
}

// ---------------------------------------------------------------- K 线定位与统计
QString barTime(const OJson* bar) {
    const OJson* t = js::propStrict(bar, u"time"_s);
    if (js::nullish(t)) t = js::prop(bar, u"date"_s);
    return js::strOr(t, QString());
}

bool isDaily(const QList<OJson>& bars) { return !bars.isEmpty() && barTime(&bars[0]).size() <= 10; }

std::optional<qsizetype> indexAt(const QList<OJson>& bars, double when, bool daily) {
    const QString key = etKey(when, daily);
    std::optional<qsizetype> out;
    for (qsizetype i = 0; i < bars.size(); ++i) {
        if (barTime(&bars[i]) <= key) out = i;
        else break;
    }
    return out;
}

namespace {
struct Near {
    double d;
    qsizetype i;
    double c;
};
std::optional<Near> closest(const OJson& profile, const QList<OJson>& bars, qsizetype lo, qsizetype hi) {
    std::optional<Near> best;
    for (qsizetype i = lo; i <= hi; ++i) {
        const auto c = num(barProp(bars, i, u"close"_s));
        if (!c) continue;
        const double d = std::fabs(*c - N(profile, u"center"));
        if (!best || d < best->d) best = Near{d, i, *c};
    }
    return best;
}
}  // namespace

double barSeconds(const QString& timeframe, bool daily) {
    if (daily) return 86400;
    static const QRegularExpression re(u"\\A([0-9]+)([mhd])\\z"_s);
    const auto m = re.match(timeframe);
    if (!m.hasMatch()) return 300;
    const double n = util::jsStringToNumber(m.captured(1));
    const QString unit = m.captured(2);
    return n * (unit == u"m" ? 60 : unit == u"h" ? 3600 : 86400);
}

QString pickTimeframe(double entryTime, double now) {
    const double age = (now - entryTime) / 86'400'000;
    if (age <= 1.5) return u"1m"_s;
    if (age <= 4.5) return u"5m"_s;
    if (age <= 9.5) return u"15m"_s;
    if (age <= 28) return u"1h"_s;
    return u"1d"_s;
}

OJson review(const OJson* record, const QList<OJson>& others, const QList<OJson>& bars, const QString& timeframe, double now) {
    const OJson profile = butterflyProfile(record);
    if (profile.type == OJson::Null) throw ReviewError(u"这条记录不是蝴蝶组合(需要 1:2:1 三腿、同到期、同方向)。"_s);
    if (bars.isEmpty()) throw ReviewError(u"没有 K 线,无法复盘。"_s);
    const bool daily = isDaily(bars);
    const OJson z = zone(profile);
    const bool zKnown = z.get(u"known"_s)->b;
    QStringList notes;
    if (profile.get(u"price_estimated"_s)->b)
        notes << (!isNull(profile, u"debit") ? u"这笔单没有成交均价,盈亏区间与最大盈亏按限价估算"_s : u"这笔单没有成交价也没有限价,算不出盈亏区间与盈亏"_s);

    const Entry entry = entryOf(record);
    if (entry.estimated) notes << u"没有成交时间,开仓时刻按提交时间算"_s;
    const auto entryIdxOpt = indexAt(bars, entry.time, daily);
    const auto lastTime = parseWhen(barTime(&bars.last()));
    const bool covered = entryIdxOpt && (!lastTime || entry.time <= *lastTime + barSeconds(timeframe, daily) * 1000);
    if (!covered || !entryIdxOpt) throw ReviewError(u"K 线窗口没有覆盖到开仓时刻("_s + etKey(entry.time, daily) + u"),换更长的周期再试。"_s);
    const qsizetype entryIdx = *entryIdxOpt;

    // ---- 结局:平仓 / 到期 / 持仓中
    const OJson exitRec = findExit(profile, entry.time, others, js::prop(record, u"id"_s));
    const qsizetype lastIdx = bars.size() - 1;
    QString kind;
    std::optional<double> exitTime;
    qsizetype exitIdx;
    if (exitRec.type != OJson::Null) {
        kind = QString::fromUtf16(kKindClosed);
        exitTime = exitRec.get(u"time"_s)->n;
        const auto idx = indexAt(bars, *exitTime, daily);
        exitIdx = !idx || *idx < entryIdx ? entryIdx : *idx;
        if (exitRec.get(u"estimated"_s)->b) notes << u"平仓单没有成交均价,平仓价按记录估算不出,盈亏留空"_s;
    } else if (now >= expiryClose(profile)) {
        kind = QString::fromUtf16(kKindExpired);
        exitTime = expiryClose(profile);
        const auto idx = indexAt(bars, *exitTime, daily);
        exitIdx = !idx || *idx < entryIdx ? entryIdx : *idx;
    } else {
        kind = QString::fromUtf16(kKindOpen);
        exitIdx = lastIdx;
    }

    const auto entryCloseOpt = num(barProp(bars, entryIdx, u"close"_s));
    const auto exitCloseOpt = num(barProp(bars, exitIdx, u"close"_s));
    if (!entryCloseOpt || !exitCloseOpt) throw ReviewError(u"K 线里有空收盘价,无法复盘。"_s);
    const double entryClose = *entryCloseOpt, exitClose = *exitCloseOpt;
    const double center = N(profile, u"center");

    // ---- 持有期统计
    const qsizetype holdLen = exitIdx - entryIdx + 1;
    double hiVal = -kInf, loVal = kInf;
    for (qsizetype i = entryIdx; i <= exitIdx; ++i)
        if (const auto h = num(barProp(bars, i, u"high"_s))) hiVal = jm::max(hiVal, *h);
    for (qsizetype i = entryIdx; i <= exitIdx; ++i)
        if (const auto l = num(barProp(bars, i, u"low"_s))) loVal = jm::min(loVal, *l);
    const auto near = closest(profile, bars, entryIdx, exitIdx);
    std::optional<std::pair<double, qsizetype>> farthest;
    for (qsizetype i = entryIdx; i <= exitIdx; ++i) {
        const auto c = num(barProp(bars, i, u"close"_s));
        if (!c) continue;
        const double d = std::fabs(*c - center);
        if (!farthest || d > farthest->first) farthest = std::pair{d, i};
    }
    double inZone = 0, touched = 0;
    if (zKnown) {
        const double lowerBe = z.get(u"lower_be"_s)->n, upperBe = z.get(u"upper_be"_s)->n;
        for (qsizetype i = entryIdx; i <= exitIdx; ++i) {
            const auto c = num(barProp(bars, i, u"close"_s)), h = num(barProp(bars, i, u"high"_s)), l = num(barProp(bars, i, u"low"_s));
            if (c && lowerBe <= *c && *c <= upperBe) inZone += 1;
            if (h && l && *l <= upperBe && *h >= lowerBe) touched += 1;
        }
    }
    std::optional<double> bestPnl;
    std::optional<qsizetype> bestIdx;
    if (zKnown) {
        for (qsizetype i = entryIdx; i <= exitIdx; ++i) {
            const auto c = num(barProp(bars, i, u"close"_s));
            if (!c) continue;
            const auto p = pnlAt(profile, *c);
            if (!bestPnl || (p && *p > *bestPnl)) {
                bestPnl = p;
                bestIdx = i;
            }
        }
    }

    const qsizetype preIdx = std::max<qsizetype>(entryIdx - kPreTrendBars, 0);
    const auto preClose = num(barProp(bars, preIdx, u"close"_s));
    const OJson preMove = !preClose || preIdx == entryIdx ? js::Null() : js::N(util::pyRound(entryClose - *preClose, 4));
    const qsizetype postIdx = std::min(entryIdx + kPostEntryBars, exitIdx);
    const auto postClose = num(barProp(bars, postIdx, u"close"_s));
    const OJson postMove = !postClose || postIdx == entryIdx ? js::Null() : js::N(util::pyRound(*postClose - entryClose, 4));

    const double distEntry = util::pyRound(entryClose - center, 4);
    const double distExit = util::pyRound(exitClose - center, 4);
    const OJson* widthRaw = P(profile, u"width");
    const double width = js::truthy(widthRaw) ? js::num(widthRaw) : 1.0;

    // ---- 结局数字
    const double settleValue = payoffPerUnit(profile, exitClose);
    std::optional<double> exitPrice;
    if (exitRec.type != OJson::Null) {
        const OJson* p = exitRec.get(u"price"_s);
        if (p->type != OJson::Null) exitPrice = p->n;
    } else if (kind == kKindExpired) {
        exitPrice = settleValue;
    }
    OJson pnl = js::Null(), pnlPct = js::Null();
    const OJson* debitRaw = P(profile, u"debit");
    if (!isNull(profile, u"debit") && exitPrice) {
        const OJson* action = P(profile, u"action");
        const double sign = js::isStr(action) && action->s == u"BUY" ? 1.0 : -1.0;
        const double debit = js::num(debitRaw), mult = N(profile, u"multiplier"), qty = N(profile, u"qty");
        const double v = util::pyRound(sign * (*exitPrice - debit) * mult * qty, 2);
        pnl = js::N(v);
        const double basis = debit * mult * qty;
        pnlPct = basis != 0 && !std::isnan(basis) ? js::N(util::pyRound((v / basis) * 100.0, 1)) : js::Null();
    }
    const OJson pnlIfNow = kind == kKindOpen ? optN(pnlAt(profile, exitClose)) : js::Null();

    OJson stats = js::object({
        {u"entry_underlying"_s, js::N(entryClose)},
        {u"exit_underlying"_s, js::N(exitClose)},
        {u"move_points"_s, js::N(util::pyRound(exitClose - entryClose, 4))},
        {u"dist_entry"_s, js::N(distEntry)},
        {u"dist_entry_widths"_s, js::N(util::pyRound(distEntry / width, 2))},
        {u"dist_exit"_s, js::N(distExit)},
        {u"dist_exit_widths"_s, js::N(util::pyRound(distExit / width, 2))},
        {u"moved_toward_center"_s, js::B(std::fabs(distExit) < std::fabs(distEntry))},
        {u"hold_bars"_s, js::N(double(holdLen))},
        {u"hold_high"_s, js::N(hiVal)},
        {u"hold_low"_s, js::N(loVal)},
        {u"closest"_s, !near ? js::Null()
                             : js::object({{u"price"_s, js::N(near->c)}, {u"distance"_s, js::N(util::pyRound(near->d, 4))}, {u"time"_s, js::S(barTime(&bars[near->i]))}})},
        {u"farthest"_s, js::object({{u"distance"_s, js::N(util::pyRound(farthest->first, 4))}, {u"time"_s, js::S(barTime(&bars[farthest->second]))}})},
        {u"in_zone_bars"_s, zKnown ? js::N(inZone) : js::Null()},
        {u"in_zone_ratio"_s, zKnown && holdLen ? js::N(util::pyRound(inZone / double(holdLen), 3)) : js::Null()},
        {u"touched_zone_bars"_s, zKnown ? js::N(touched) : js::Null()},
        {u"best_theoretical"_s, !bestIdx ? js::Null()
                                         : js::object({{u"pnl"_s, optN(bestPnl)},
                                                       {u"time"_s, js::S(barTime(&bars[*bestIdx]))},
                                                       {u"underlying"_s, optN(num(barProp(bars, *bestIdx, u"close"_s)))}})},
        {u"pre_entry_move"_s, preMove},
        {u"pre_entry_bars"_s, js::N(double(entryIdx - preIdx))},
        {u"post_entry_move"_s, postMove},
        {u"post_entry_bars"_s, js::N(double(postIdx - entryIdx))},
        {u"settle_value"_s, js::N(settleValue)},
    });

    const OJson outcome = js::object({
        {u"kind"_s, js::S(kind)},
        {u"time"_s, !exitTime ? js::Null() : js::S(util::utcIso(*exitTime))},
        {u"time_et"_s, !exitTime ? js::Null() : js::S(etKey(*exitTime, false))},
        {u"price"_s, optN(exitPrice)},
        {u"underlying"_s, js::N(exitClose)},
        {u"pnl"_s, pnl},
        {u"pnl_pct"_s, pnlPct},
        {u"pnl_if_expired_now"_s, pnlIfNow},
        {u"record_id"_s, exitRec.type == OJson::Null ? js::Null() : *exitRec.get(u"record_id"_s)},
    });
    const OJson entryOut = js::object({
        {u"time"_s, js::S(util::utcIso(entry.time))},
        {u"time_et"_s, js::S(etKey(entry.time, false))},
        {u"estimated"_s, js::B(entry.estimated)},
        {u"price"_s, *debitRaw},
        {u"price_estimated"_s, *profile.get(u"price_estimated"_s)},
        {u"underlying"_s, js::N(entryClose)},
        {u"bar_time"_s, js::S(barTime(&bars[entryIdx]))},
    });

    // ---- 图:窗口 + 标记 + 关键位
    const qsizetype loI = std::max<qsizetype>(entryIdx - kLookbackBars, 0);
    const qsizetype hiI = std::min(exitIdx + kLookaheadBars, lastIdx);
    QList<qsizetype> keep;  // 窗口里留下的(相对 loI 的下标)
    const qsizetype winLen = hiI - loI + 1;
    if (winLen > kMaxWindow) {
        const qsizetype step = qsizetype(std::ceil(double(winLen) / double(kMaxWindow)));
        for (qsizetype i = 0; i < winLen; ++i)
            if (i % step == 0) keep << i;
        // keep.includes(window[must]):同一个对象才算(JSON 读进来的 K 线各是各的,按下标比)
        for (const qsizetype must : {entryIdx - loI, exitIdx - loI})
            if (!keep.contains(must)) keep << must;
        QList<std::pair<QString, qsizetype>> keyed;
        for (const qsizetype k : keep) keyed << std::pair{barTime(&bars[loI + k]), k};
        std::stable_sort(keyed.begin(), keyed.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
        keep.clear();
        for (const auto& [t, k] : keyed) keep << k;
    } else {
        for (qsizetype i = 0; i < winLen; ++i) keep << i;
    }
    OJson window = js::array();
    for (const qsizetype k : keep) window.items << bars[loI + k];
    OJson markers = js::array({js::object({{u"kind"_s, js::S(u"entry"_s)}, {u"time"_s, js::S(barTime(&bars[entryIdx]))}, {u"price"_s, js::N(entryClose)}})});
    if (kind != kKindOpen)
        markers.items << js::object({{u"kind"_s, js::S(kind == kKindClosed ? u"exit"_s : u"expiry"_s)}, {u"time"_s, js::S(barTime(&bars[exitIdx]))}, {u"price"_s, js::N(exitClose)}});
    OJson levels = js::array({js::object({{u"kind"_s, js::S(u"lower"_s)}, {u"price"_s, js::copyOrNull(P(profile, u"lower"))}}),
                              js::object({{u"kind"_s, js::S(u"center"_s)}, {u"price"_s, js::copyOrNull(P(profile, u"center"))}}),
                              js::object({{u"kind"_s, js::S(u"upper"_s)}, {u"price"_s, js::copyOrNull(P(profile, u"upper"))}})});
    if (zKnown) {
        levels.items << js::object({{u"kind"_s, js::S(u"lower_be"_s)}, {u"price"_s, *z.get(u"lower_be"_s)}});
        levels.items << js::object({{u"kind"_s, js::S(u"upper_be"_s)}, {u"price"_s, *z.get(u"upper_be"_s)}});
    }

    const OJson findings = buildFindings(profile, z, entryOut, outcome, stats);
    return js::object({
        {u"profile"_s, profile},
        {u"zone"_s, z},
        {u"entry"_s, entryOut},
        {u"outcome"_s, outcome},
        {u"stats"_s, stats},
        {u"findings"_s, findings},
        {u"series"_s, js::object({{u"timeframe"_s, js::S(timeframe)}, {u"daily"_s, js::B(daily)}, {u"bars"_s, window}, {u"markers"_s, markers}, {u"levels"_s, levels}})},
        {u"notes"_s, js::strings(notes)},
        {u"reviewed_at"_s, js::S(util::utcIso(now))},
    });
}

// ---------------------------------------------------------------- 结论(规则化文字)
QString pts(double v) {
    static const QRegularExpression zeros(u"0+\\z"_s), dot(u"\\.\\z"_s);
    QString s = util::fmtF(v, 2);
    s.remove(zeros);
    s.remove(dot);
    return s;
}

QString money(const std::optional<double>& v) {
    if (!v) return u"—"_s;
    return *v < 0 ? util::fmtF(*v, 2) : u"+"_s + util::fmtF(*v, 2);
}

namespace {
std::optional<double> optNum(const OJson* v) { return js::nullish(v) ? std::nullopt : std::optional<double>(js::num(v)); }
OJson finding(const QString& tone, const QString& title, const QString& text) {
    return js::object({{u"tone"_s, js::S(tone)}, {u"title"_s, js::S(title)}, {u"text"_s, js::S(text)}});
}
}  // namespace

OJson buildFindings(const OJson& profile, const OJson& z, const OJson& entry, const OJson& outcome, const OJson& stats) {
    OJson out = js::array();
    const OJson* action = P(profile, u"action");
    const bool isLong = js::isStr(action) && action->s == u"BUY";
    const QString verb = isLong ? u"买入"_s : u"卖出"_s;
    const QString what = verb + u' ' + Sx(profile, u"symbol") + u' ' + pts(N(profile, u"lower")) + u'/' + pts(N(profile, u"center")) + u'/' +
                         pts(N(profile, u"upper")) + u' ' + Sx(profile, u"right_label") + u"蝴蝶(翼宽 "_s + pts(N(profile, u"width")) + u')';
    const bool zKnown = js::truthy(P(z, u"known"));
    if (zKnown) {
        out.items << finding(u"info"_s, u"结构"_s,
                             what + u",权利金 "_s + pts(N(profile, u"debit")) + (js::truthy(P(profile, u"price_estimated")) ? u"(估算)"_s : QString()) +
                                 u";到期盈利区 "_s + pts(N(z, u"lower_be")) + u" ~ "_s + pts(N(z, u"upper_be")) + u",最大盈利 "_s + util::fmtF(N(z, u"max_profit"), 2) +
                                 u",最大亏损 "_s + util::fmtF(N(z, u"max_loss"), 2) + u"。"_s);
    } else {
        out.items << finding(u"info"_s, u"结构"_s, what + u",没有成交价,盈亏区间未知。"_s);
    }

    const double d = N(stats, u"dist_entry");
    const QString side = d > 0 ? u"上方"_s : u"下方"_s;
    const QString need = isLong ? (d > 0 ? u"下跌"_s : u"上涨"_s) : u"远离中心"_s;
    const auto favor = [&](bool toward) { return isLong ? toward : !toward; };
    const double dw = std::fabs(N(stats, u"dist_entry_widths"));
    QString pos, tone;
    const QString under = pts(N(entry, u"underlying"));
    if (dw <= 0.5) {
        pos = u"开仓时标的 "_s + under + u" 就在中心附近(偏 "_s + side + u' ' + pts(std::fabs(d)) + u" 点),结构一开始就在帐篷里。"_s;
        tone = u"good"_s;
    } else if (dw <= 2) {
        pos = u"开仓时标的 "_s + under + u" 在中心"_s + side + u' ' + pts(std::fabs(d)) + u" 点("_s + util::fmtF(dw, 1) + u" 个翼宽),需要标的"_s + need + u"到区间内。"_s;
        tone = u"info"_s;
    } else {
        pos = u"开仓时标的 "_s + under + u" 离中心 "_s + pts(std::fabs(d)) + u" 点("_s + util::fmtF(dw, 1) + u" 个翼宽),这是一张押方向的远端蝴蝶,靠标的"_s + need + u"才有价值。"_s;
        tone = u"warn"_s;
    }
    out.items << finding(tone, u"开仓位置"_s, pos);

    if (!isNull(stats, u"pre_entry_move")) {
        const double mv = N(stats, u"pre_entry_move");
        const bool toward = (mv < 0) == (d > 0);
        out.items << finding(favor(toward) ? u"good"_s : u"warn"_s, u"开仓前走势"_s,
                             u"开仓前 "_s + Sx(stats, u"pre_entry_bars") + u" 根 K 线标的"_s + (mv > 0 ? u"上涨"_s : u"下跌"_s) + u' ' + pts(std::fabs(mv)) + u" 点,"_s +
                                 (favor(toward) ? u"顺着蝴蝶要的方向"_s : u"与蝴蝶要的方向相反(逆势进场)"_s) + u"。"_s);
    }
    if (!isNull(stats, u"post_entry_move")) {
        const double mv = N(stats, u"post_entry_move");
        const bool toward = (mv < 0) == (d > 0);
        out.items << finding(favor(toward) ? u"good"_s : u"warn"_s, u"开仓后走势"_s,
                             u"开仓后 "_s + Sx(stats, u"post_entry_bars") + u" 根 K 线标的"_s + (mv > 0 ? u"上涨"_s : u"下跌"_s) + u' ' + pts(std::fabs(mv)) + u" 点,"_s +
                                 (toward ? u"朝中心走"_s : u"背离中心"_s) + u"。"_s);
    }

    const OJson* c = P(stats, u"closest");
    if (!(c && c->type == OJson::Null) && N(stats, u"hold_bars") > 1) {
        QString text = u"持有期间标的区间 "_s + pts(N(stats, u"hold_low")) + u" ~ "_s + pts(N(stats, u"hold_high")) + u";最接近中心 "_s + pts(N(*c, u"price")) + u'(' +
                       Sx(*c, u"time") + u",距中心 "_s + pts(N(*c, u"distance")) + u" 点)。"_s;
        if (!isNull(stats, u"in_zone_ratio"))
            text += u" 收盘落在盈利区内的 K 线 "_s + Sx(stats, u"in_zone_bars") + u'/' + Sx(stats, u"hold_bars") + u'(' + util::fmtF(N(stats, u"in_zone_ratio") * 100, 0) + u"%)。"_s;
        out.items << finding(u"info"_s, u"持有期"_s, text);
    }

    const OJson* bt = P(stats, u"best_theoretical");
    const QString k = Sx(outcome, u"kind");
    if (!(bt && bt->type == OJson::Null) && !isNull(*bt, u"pnl") && N(*bt, u"pnl") > 0 && k != kKindOpen) {
        const auto realized = optNum(P(outcome, u"pnl"));
        if (!realized || N(*bt, u"pnl") > *realized) {
            out.items << finding(u"warn"_s, u"曾有的机会"_s,
                                 Sx(*bt, u"time") + u" 标的到 "_s + pts(N(*bt, u"underlying")) + u",若当时到期盈利 "_s + money(optNum(P(*bt, u"pnl"))) +
                                     u"(到期内在价值口径,不是当时能卖到的价:离到期还有时间时,标的越靠近中心,蝶的市价比它低得越多);最终结果 "_s + money(realized) + u"。"_s);
        }
    }

    const auto pnlPctText = [&] { return isNull(outcome, u"pnl_pct") ? u"—"_s : util::fmtF(N(outcome, u"pnl_pct"), 1); };
    const auto pnlPositive = [&] {
        const OJson* p = P(outcome, u"pnl");
        return (js::nullish(p) ? 0.0 : js::num(p)) > 0;
    };
    if (k == kKindClosed) {
        out.items << finding(pnlPositive() ? u"good"_s : u"bad"_s, u"平仓"_s,
                             Sx(outcome, u"time_et") + u" 以 "_s + (isNull(outcome, u"price") ? u"—"_s : pts(N(outcome, u"price"))) + u" 平仓,盈亏 "_s +
                                 money(optNum(P(outcome, u"pnl"))) + u'(' + pnlPctText() + u"%),平仓时标的 "_s + pts(N(outcome, u"underlying")) + u"(距中心 "_s +
                                 pts(std::fabs(N(stats, u"dist_exit"))) + u" 点)。"_s);
    } else if (k == kKindExpired) {
        const double u = N(outcome, u"underlying");
        const bool inside = zKnown && N(z, u"lower_be") <= u && u <= N(z, u"upper_be");
        out.items << finding(pnlPositive() ? u"good"_s : u"bad"_s, u"到期"_s,
                             u"到期结算标的 "_s + pts(u) + u","_s + (zKnown ? (inside ? u"落在盈利区内"_s : u"落在盈利区外"_s) : u"盈利区未知"_s) + u",结构价值 "_s +
                                 pts(N(stats, u"settle_value")) + u",盈亏 "_s + money(optNum(P(outcome, u"pnl"))) + u'(' + pnlPctText() + u"%)。"_s);
    } else {
        out.items << finding(u"info"_s, u"持仓中"_s,
                             u"尚未到期,最新标的 "_s + pts(N(outcome, u"underlying")) + u"(距中心 "_s + pts(std::fabs(N(stats, u"dist_exit"))) + u" 点),若此刻到期盈亏 "_s +
                                 money(optNum(P(outcome, u"pnl_if_expired_now"))) + u"。"_s);
    }

    if (k != kKindOpen) {
        if (favor(js::truthy(P(stats, u"moved_toward_center"))))
            out.items << finding(u"good"_s, u"方向"_s,
                                 u"方向判断正确:标的从开仓到结局朝中心靠近了 "_s + pts(std::fabs(N(stats, u"dist_entry")) - std::fabs(N(stats, u"dist_exit"))) + u" 点。"_s);
        else
            out.items << finding(u"bad"_s, u"方向"_s,
                                 u"方向判断有误:标的从开仓到结局离中心更远了 "_s + pts(std::fabs(N(stats, u"dist_exit")) - std::fabs(N(stats, u"dist_entry"))) + u" 点。"_s);
    }
    return out;
}

void marketOpportunity(OJson& result, const QList<OJson>& flyBars, const QString& entryBar) {
    static const OJson empty = js::object();
    const OJson* profileP = js::prop(&result, u"profile"_s);
    const OJson& profile = js::nullish(profileP) ? empty : *profileP;
    const OJson* outcomeP = js::prop(&result, u"outcome"_s);
    const OJson& outcome = js::nullish(outcomeP) ? empty : *outcomeP;
    const OJson* statsP = js::prop(&result, u"stats"_s);
    const auto d = num(P(profile, u"debit"));
    const OJson* action = P(profile, u"action");
    const QString kind = js::isStr(P(outcome, u"kind")) ? P(outcome, u"kind")->s : QString();
    const bool kindIsStr = js::isStr(P(outcome, u"kind"));
    if (!d || !(js::isStr(action) && action->s == u"BUY") || (kindIsStr && kind == kKindOpen)) return;
    const QString day = entryBar.left(10);
    const QString end = kindIsStr && kind == kKindClosed ? js::strOr(P(outcome, u"time_et"), QString()) : day + u" 16:00"_s;
    std::optional<std::pair<QString, double>> best;
    for (const OJson& bar : flyBars) {
        const QString t = js::strOr(js::propStrict(&bar, u"time"_s), QString());
        const auto mid = num(js::prop(&bar, u"close"_s));
        if (!mid || t.left(10) != day || t < entryBar || t >= end) continue;
        if (!best || *mid > best->second) best = std::pair{t, *mid};
    }
    if (!best) return;
    const double pnl = util::pyRound((best->second - *d) * N(profile, u"multiplier") * N(profile, u"qty"), 2);
    // stats 是 {} 兜底时改的是一个扔掉的对象
    if (!js::nullish(statsP)) {
        if (OJson* stats = js::propMut(&result, u"stats"_s); stats && stats->type == OJson::Object)
            stats->set(u"best_market"_s, js::object({{u"time"_s, js::S(best->first)}, {u"mid"_s, js::N(best->second)}, {u"pnl"_s, js::N(pnl)}}));
    }

    const auto realized = num(P(outcome, u"pnl"));
    const OJson* btRaw = js::nullish(statsP) ? nullptr : P(*statsP, u"best_theoretical");
    const OJson* bt = js::nullish(btRaw) ? nullptr : btRaw;
    const bool missed = !realized || pnl > *realized;
    const QString head = u"持有期间组合中间价最高 "_s + pts(best->second) + u'(' + best->first + u"),按它平仓 "_s + money(pnl);
    const QString tail = bt && !isNull(*bt, u"pnl") && N(*bt, u"pnl") > 0
                             ? u"按到期内在价值算的 "_s + money(optNum(P(*bt, u"pnl"))) + u'(' + Sx(*bt, u"time") + u" 标的到 "_s + pts(N(*bt, u"underlying")) +
                                   u")是若当时到期的数,离到期还有时间时卖不到。"_s
                             : QString();
    const OJson row = finding(missed ? u"warn"_s : u"good"_s, u"曾有的机会"_s,
                              missed ? head + u";最终结果 "_s + money(realized) + u"。"_s + tail : head + u",最终结果 "_s + money(realized) + u" 不比它差。"_s + tail);
    const OJson* findingsP = js::prop(&result, u"findings"_s);
    if (js::nullish(findingsP)) return;  // [] 兜底:改的是扔掉的数组
    if (!js::isArr(findingsP)) throw util::JsError(u"findings.findIndex is not a function"_s);
    OJson& findings = *js::propMut(&result, u"findings"_s);
    const auto indexOfTitle = [&](auto pred) -> qsizetype {
        for (qsizetype i = 0; i < findings.items.size(); ++i) {
            const OJson* title = js::propStrict(&findings.items[i], u"title"_s);
            if (pred(title)) return i;
        }
        return -1;
    };
    const auto titleIs = [](const OJson* t, const QString& s) { return js::isStr(t) && t->s == s; };
    const qsizetype i = indexOfTitle([&](const OJson* t) { return titleIs(t, u"曾有的机会"_s); });
    if (i >= 0) {
        findings.items[i] = row;
    } else if (missed && pnl > 0) {
        // 内在价值一直不比结果好,盘面上却真有过浮盈:补一条,排在结局之前
        const qsizetype at = indexOfTitle([&](const OJson* t) { return titleIs(t, u"平仓"_s) || titleIs(t, u"到期"_s); });
        findings.items.insert(at >= 0 ? at : findings.items.size(), row);
    }
}

}  // namespace ibkr::analysis::tradereview
