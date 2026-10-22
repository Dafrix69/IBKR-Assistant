#include "analysis/stockreview.h"

#include "analysis/ibtrades.h"
#include "analysis/tradereview.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/py.h"
#include "util/tz.h"

#include <QHash>
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
namespace tr = ibkr::analysis::tradereview;

namespace ibkr::analysis::stockreview {

namespace {
constexpr double kEps = 1e-9;
constexpr double kInf = std::numeric_limits<double>::infinity();

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
const OJson* P(const OJson& o, const char16_t* k) { return js::prop(&o, QString::fromUtf16(k)); }
double N(const OJson& o, const char16_t* k) { return js::num(P(o, k)); }
QString Sx(const OJson& o, const char16_t* k) { return js::str(P(o, k)); }
bool isNull(const OJson& o, const char16_t* k) {
    const OJson* v = P(o, k);
    return v && v->type == OJson::Null;
}
/// o[k] ?? null 当数(null / undefined 是空)
std::optional<double> optNum(const OJson* v) { return js::nullish(v) ? std::nullopt : std::optional<double>(js::num(v)); }
/// 原样放进对象字面量:undefined 的键 JSON 里没有
void setRaw(OJson& o, const QString& k, const OJson* v) {
    if (v) o.set(k, *v);
}
QString n2s(double v) { return util::jsNumberToString(v); }
QString mask(const QString& s) { return s.size() <= 5 ? s : s.left(2) + u"***"_s + s.right(3); }
QString trim(double v, int digits = 4) {
    static const QRegularExpression zeros(u"0+\\z"_s), dot(u"\\.\\z"_s);
    QString s = util::fmtF(v, digits);
    s.remove(zeros);
    s.remove(dot);
    return s;
}
/// fmtF 收到的不是数(trip 里缺的字段):Number.isFinite 不转换,Number.isNaN 也不转换,于是落到 x > 0 ? "inf" : "-inf"
QString fmtFv(const OJson* v, int nd) {
    if (js::isNum(v)) return util::fmtF(v->n, nd);
    return js::num(v) > 0 ? u"inf"_s : u"-inf"_s;
}
QString trimV(const OJson* v, int digits = 4) {
    static const QRegularExpression zeros(u"0+\\z"_s), dot(u"\\.\\z"_s);
    QString s = fmtFv(v, digits);
    s.remove(zeros);
    s.remove(dot);
    return s;
}
QString sessionOf(const OJson& bar) { return tr::barTime(&bar).left(10); }

struct Exec {
    QString time;
    double when, price, qty;
    QString perm;
    QStringList execIds;
    QString action;
};
struct Trip {
    const OJson* firstFill;
    bool remainder;
    int side;
    bool carried;
    double carriedQty;
    QList<Exec> entries, exits;
    std::optional<double> avg;
    double pos, peak;
    std::optional<double> realized;
    double realizedQty = 0, commission = 0;
    bool hasComm = false;
};

void pushExec(QList<Exec>& list, const OJson& fill, double when, double qty, double price, const QString& action) {
    const QString perm = ibtrades::groupKey(fill);
    if (!list.isEmpty() && list.last().perm == perm) {
        // 同一订单分几笔成交:并成一次出手
        Exec& last = list.last();
        last.price = (last.price * last.qty + price * qty) / (last.qty + qty);
        last.qty += qty;
        last.execIds << js::strOr(js::prop(&fill, u"exec_id"_s), QString());
        if (when < last.when) {
            last.when = when;
            last.time = js::strOr(js::prop(&fill, u"time"_s), QString());
        }
        return;
    }
    list << Exec{js::strOr(js::prop(&fill, u"time"_s), QString()), when, price, qty, perm, {js::strOr(js::prop(&fill, u"exec_id"_s), QString())}, action};
}

std::optional<double> vwap(const QList<Exec>& list) {
    double qty = 0, value = 0;
    for (const Exec& e : list) qty = qty + e.qty;
    if (!(qty > kEps)) return std::nullopt;
    for (const Exec& e : list) value = value + e.price * e.qty;
    return util::pyRound(value / qty, 4);
}

OJson execOut(const Exec& e) {
    return js::object({{u"time"_s, js::S(e.time)},
                       {u"price"_s, js::N(util::pyRound(e.price, 4))},
                       {u"qty"_s, js::N(util::pyRound(e.qty, 4))},
                       {u"action"_s, js::S(e.action)},
                       {u"exec_ids"_s, js::strings(e.execIds)}});
}

const OJson* aliasLookup(const QList<std::pair<QString, const OJson*>>& aliasOf, const QString& id) {
    const OJson* out = nullptr;
    for (const auto& [k, a] : aliasOf)
        if (k == id) out = a;
    return out;
}

/// {记录, started_at_ms}
std::pair<OJson, double> tripRecord(const Trip& t, const QList<std::pair<QString, const OJson*>>& aliasOf, bool openingAssumed, QStringList& usedIds) {
    const OJson& fill = *t.firstFill;
    const OJson* contract = orEmpty(js::prop(&fill, u"contract"_s));
    const QString symbol = js::strOr(js::prop(contract, u"symbol"_s), QString()).toUpper();
    const QString accountId = js::strOr(js::prop(&fill, u"account_id"_s), QString());
    const OJson* acct = aliasLookup(aliasOf, accountId);
    const bool known = js::truthy(acct);
    const QString alias = known ? js::str(js::prop(acct, u"alias"_s)) : u"未配置账户 "_s + mask(accountId);
    const bool isPaper = known ? js::truthy(js::prop(acct, u"is_paper"_s)) : accountId.toUpper().startsWith(u"DU"_s);

    const QString base = QString::fromUtf16(kTripPrefix) + ibtrades::groupKey(fill) + (t.remainder ? u":r"_s : QString());
    QString id = base;
    for (int n = 2; usedIds.contains(id); n += 1) id = base + u':' + QString::number(n);
    usedIds << id;

    double entryQty = 0, exitQty = 0;
    for (const Exec& e : t.entries) entryQty = entryQty + e.qty;
    for (const Exec& e : t.exits) exitQty = exitQty + e.qty;
    const double openQty = std::fabs(t.pos);
    const bool closed = openQty <= kEps;
    QList<const Exec*> all;
    for (const Exec& e : t.entries) all << &e;
    for (const Exec& e : t.exits) all << &e;
    std::stable_sort(all.begin(), all.end(), [](const Exec* a, const Exec* b) { return a->when - b->when < 0; });
    const Exec* lastExit = nullptr;
    for (const Exec& e : t.exits)
        if (!lastExit || e.when > lastExit->when) lastExit = &e;
    const std::optional<double> avgEntry = t.avg ? std::optional<double>(util::pyRound(*t.avg, 4)) : std::nullopt;
    const std::optional<double> avgExit = vwap(t.exits);
    const bool isLong = t.side > 0;

    const QString unit = trim(t.peak) + u" 股"_s;
    QString summary;
    if (t.carried && t.entries.isEmpty()) {
        const QString why = openingAssumed ? u"期初持仓未核对,按卖出更早买的货算"_s : u"建仓早于已同步的成交"_s;
        summary = (isLong ? u"卖出"_s : u"买回"_s) + u' ' + symbol + u' ' + trim(exitQty) + u" 股 @ "_s + (avgExit ? trim(*avgExit) : u"—"_s) + u'(' + why + u')';
    } else {
        summary = (isLong ? u"做多"_s : u"做空"_s) + u' ' + symbol + u' ' + unit + u" @ "_s + (avgEntry ? trim(*avgEntry) : u"—"_s) +
                  (!avgExit ? QString() : u" → "_s + (closed ? u"平仓"_s : u"已减仓"_s) + u" @ "_s + trim(*avgExit));
    }
    // all 为空(期初带过来、之后只有零碎到 EPS 以下的成交):TS 在 firstExec.time 上抛
    if (all.isEmpty()) throw util::JsError(u"Cannot read properties of undefined (reading 'time')"_s);
    const Exec& firstExec = *all[0];

    OJson entries = js::array(), exits = js::array();
    for (const Exec& e : t.entries) entries.items << execOut(e);
    for (const Exec& e : t.exits) exits.items << execOut(e);
    const OJson* currency = js::prop(contract, u"currency"_s);
    OJson rec = js::object({
        {u"id"_s, js::S(id)},
        {u"kind"_s, js::S(u"stock"_s)},
        {u"source"_s, js::S(u"ibkr"_s)},
        {u"symbol"_s, js::S(symbol)},
        {u"currency"_s, js::S(js::truthy(currency) ? js::str(currency) : u"USD"_s)},
        {u"account"_s, js::object({{u"alias"_s, js::S(alias)}, {u"account_id"_s, js::S(accountId)}, {u"is_paper"_s, js::B(isPaper)}})},
        {u"side"_s, js::S(isLong ? u"LONG"_s : u"SHORT"_s)},
        {u"status"_s, js::S(QString::fromUtf16(closed ? kKindClosed : kKindOpen))},
        {u"carried"_s, js::B(t.carried)},
        {u"carried_qty"_s, js::N(util::pyRound(t.carriedQty, 4))},
        {u"opening_assumed"_s, js::B(openingAssumed)},
        {u"entries"_s, entries},
        {u"exits"_s, exits},
        {u"qty"_s, js::N(util::pyRound(t.peak, 4))},
        {u"entry_qty"_s, js::N(util::pyRound(entryQty, 4))},
        {u"exit_qty"_s, js::N(util::pyRound(exitQty, 4))},
        {u"open_qty"_s, js::N(util::pyRound(openQty, 4))},
        {u"avg_entry"_s, optN(avgEntry)},
        {u"avg_exit"_s, optN(avgExit)},
        {u"realized_pnl"_s, t.realized ? js::N(util::pyRound(*t.realized, 2)) : js::Null()},
        {u"realized_qty"_s, js::N(util::pyRound(t.realizedQty, 4))},
        {u"commission"_s, t.hasComm ? js::N(util::pyRound(t.commission, 4)) : js::Null()},
        {u"created_at"_s, js::S(firstExec.time)},
        {u"closed_at"_s, closed && lastExit ? js::S(lastExit->time) : js::Null()},
        {u"summary"_s, js::S(summary)},
    });
    return {rec, firstExec.when};
}
}  // namespace

std::pair<qsizetype, qsizetype> stockWindow(const QList<OJson>& bars, qsizetype startIdx, qsizetype endIdx) {
    const qsizetype lastIdx = bars.size() - 1;
    // 原来的根数窗口:作为下限,保证不比从前窄
    qsizetype loI = std::max<qsizetype>(startIdx - tr::kLookbackBars, 0);
    qsizetype hiI = std::min(endIdx + tr::kLookaheadBars, lastIdx);
    QStringList days;
    QHash<QString, qsizetype> first, last;
    for (qsizetype i = 0; i <= lastIdx; ++i) {
        const QString d = sessionOf(bars[i]);
        if (!first.contains(d)) {
            first.insert(d, i);
            days << d;
        }
        last.insert(d, i);
    }
    const qsizetype ds = days.indexOf(sessionOf(bars[startIdx]));
    const qsizetype de = days.indexOf(sessionOf(bars[endIdx]));
    if (ds < 0 || de < 0) return {loI, hiI};
    qsizetype lo = std::max<qsizetype>(ds - kPadSessions, 0);
    qsizetype hi = std::min(de + kPadSessions, days.size() - 1);
    // 不足 MIN_SESSIONS 个交易日:先往前补,前面没了再往后
    while (hi - lo + 1 < kMinSessions && (lo > 0 || hi < days.size() - 1)) {
        if (lo > 0) lo -= 1;
        else hi += 1;
    }
    loI = std::min(loI, first.value(days[lo]));
    hiI = std::max(hiI, last.value(days[hi]));
    return {loI, hiI};
}

QString holdingKey(const OJson* accountId, const OJson* symbol) { return js::strOr(accountId, QString()) + u'|' + js::strOr(symbol, QString()).toUpper(); }

QList<OJson> groupStockTrips(const QList<OJson>& fills, const QList<OJson>& accounts, const OJson* holdings) {
    QList<std::pair<QString, const OJson*>> aliasOf;
    for (const OJson& a : accounts) aliasOf << std::pair{js::strOr(js::propStrict(&a, u"account_id"_s), QString()), &a};
    struct Row {
        const OJson* fill;
        double when;
        double seq;
        double signed_;
        double price;
    };
    QList<std::pair<QString, QList<Row>>> groups;  // Map 的插入次序
    double seq = 0;
    for (const OJson& fill : fills) {
        const OJson* contract = orEmpty(js::propStrict(&fill, u"contract"_s));
        const OJson* sec = js::prop(contract, u"secType"_s);
        if (!(js::isStr(sec) && sec->s == u"STK")) continue;
        const double shares = num(js::prop(&fill, u"shares"_s)).value_or(0);
        const auto price = num(js::prop(&fill, u"price"_s));
        const auto when = tr::parseWhen(js::prop(&fill, u"time"_s));
        const QString symbol = js::strOr(js::prop(contract, u"symbol"_s), QString()).toUpper();
        if (shares <= 0 || !price || !when || symbol.isEmpty()) continue;
        const QString side = js::strOr(js::prop(&fill, u"side"_s), QString()).toUpper();
        const bool buy = side == u"BOT" || side == u"BUY";
        const OJson symJ = js::S(symbol);
        const QString key = holdingKey(js::prop(&fill, u"account_id"_s), &symJ);
        auto it = std::find_if(groups.begin(), groups.end(), [&](const auto& g) { return g.first == key; });
        if (it == groups.end()) {
            groups << std::pair{key, QList<Row>{}};
            it = groups.end() - 1;
        }
        seq += 1;
        it->second << Row{&fill, *when, seq, buy ? shares : -shares, *price};
    }

    QList<std::pair<OJson, double>> out;
    QStringList usedIds;
    for (auto& [key, rows] : groups) {
        std::stable_sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) {
            const double d = a.when - b.when;
            if (d != 0) return d < 0;
            return a.seq - b.seq < 0;
        });
        double net = 0, low = 0;  // 从 0 起步累计到过的最低仓位
        for (const Row& r : rows) {
            net += r.signed_;
            low = jm::min(low, net);
        }
        double opening;
        if (!holdings) {
            opening = low < 0 ? -low : 0;
        } else {
            const OJson* h = js::prop(holdings, key);
            opening = (js::nullish(h) ? 0 : js::num(h)) - net;
        }
        std::optional<Trip> trip;
        const auto start = [](const OJson* fill, int side, bool remainder, double carriedQty = 0) {
            Trip t{fill, remainder, side, carriedQty > 0, carriedQty, {}, {}, std::nullopt, side * carriedQty, carriedQty, std::nullopt};
            if (!(carriedQty > 0)) {
                t.avg = 0;
                t.realized = 0;
            }
            return t;
        };
        const auto finish = [&](const Trip& t) { out << tripRecord(t, aliasOf, !holdings, usedIds); };
        if (std::fabs(opening) > kEps) trip = start(rows[0].fill, opening > 0 ? 1 : -1, false, std::fabs(opening));

        for (const Row& row : rows) {
            double left = std::fabs(row.signed_);
            const int dir = row.signed_ > 0 ? 1 : -1;
            const QString action = dir > 0 ? u"BUY"_s : u"SELL"_s;
            bool first = true;
            while (left > kEps) {
                if (!trip) trip = start(row.fill, dir, !first);
                Trip& t = *trip;
                if (first) {
                    if (const auto comm = num(js::prop(row.fill, u"commission"_s))) {
                        t.commission += *comm;
                        t.hasComm = true;
                    }
                }
                if (dir == t.side) {
                    // 建仓 / 加仓:摊均价(carried 的那段没有成本)
                    if (t.avg) t.avg = (*t.avg * std::fabs(t.pos) + row.price * left) / (std::fabs(t.pos) + left);
                    t.pos += dir * left;
                    t.peak = jm::max(t.peak, std::fabs(t.pos));
                    pushExec(t.entries, *row.fill, row.when, left, row.price, action);
                    left = 0;
                } else {
                    const double closeQty = jm::min(left, std::fabs(t.pos));
                    if (t.avg && t.realized) {
                        *t.realized += (row.price - *t.avg) * closeQty * t.side;
                        t.realizedQty += closeQty;
                    }
                    t.pos += dir * closeQty;
                    pushExec(t.exits, *row.fill, row.when, closeQty, row.price, action);
                    left -= closeQty;
                    if (std::fabs(t.pos) <= kEps) {
                        t.pos = 0;
                        finish(t);
                        trip.reset();
                    }
                }
                first = false;
            }
        }
        if (trip) finish(*trip);
    }
    std::stable_sort(out.begin(), out.end(), [](const auto& a, const auto& b) {
        const double d = a.second - b.second;
        if (d != 0 && !std::isnan(d)) return d < 0;
        return a.first.get(u"id"_s)->s < b.first.get(u"id"_s)->s;
    });
    QList<OJson> records;
    for (const auto& [r, ms] : out) records << r;
    return records;
}

// ---------------------------------------------------------------- 复盘
namespace {
struct Extreme {
    double value;
    qsizetype index;
};
std::optional<Extreme> extreme(const QList<OJson>& bars, qsizetype lo, qsizetype hi, bool high) {
    std::optional<Extreme> best;
    for (qsizetype i = lo; i <= hi; ++i) {
        const auto v = num(js::propStrict(&bars[i], high ? u"high"_s : u"low"_s));
        if (!v) continue;
        if (!best || (high ? *v > best->value : *v < best->value)) best = Extreme{*v, i};
    }
    return best;
}
double clamp01(double v) { return jm::min(1, jm::max(0, v)); }

/// trip["entries"] ?? []:不是数组就是 TS 的 "is not iterable"
const QList<OJson>& listOf(const OJson& trip, const char16_t* k, const QString& expr) {
    static const QList<OJson> none;
    const OJson* v = P(trip, k);
    if (js::nullish(v)) return none;
    if (!js::isArr(v)) throw util::JsError(expr + u" is not iterable"_s);
    return v->items;
}
QList<double> whens(const QList<OJson>& list) {
    QList<double> out;
    for (const OJson& e : list)
        if (const auto t = tr::parseWhen(js::propStrict(&e, u"time"_s))) out << *t;
    return out;
}
std::optional<double> firstWhen(const QList<OJson>& list) {
    const QList<double> t = whens(list);
    if (t.isEmpty()) return std::nullopt;
    double m = kInf;
    for (double x : t) m = jm::min(m, x);
    return m;
}
std::optional<double> lastWhen(const QList<OJson>& list) {
    const QList<double> t = whens(list);
    if (t.isEmpty()) return std::nullopt;
    double m = -kInf;
    for (double x : t) m = jm::max(m, x);
    return m;
}
QList<OJson> concat(const QList<OJson>& a, const QList<OJson>& b) { return a + b; }

/// 每次出手补一个美东时间({...e, time_et})
OJson withEt(const OJson& e) {
    const auto when = tr::parseWhen(js::propStrict(&e, u"time"_s));
    OJson o = e.type == OJson::Object ? e : js::object();
    o.set(u"time_et"_s, when ? js::S(tr::etKey(*when, false)) : js::Null());
    return o;
}

QString px(double v) { return trim(v, 4); }
QString money(const std::optional<double>& v) {
    if (!v) return u"—"_s;
    return *v < 0 ? util::fmtF(*v, 2) : u"+"_s + util::fmtF(*v, 2);
}
QString pctText(const std::optional<double>& v) {
    if (!v) return u"—"_s;
    return (*v > 0 ? u"+"_s : QString()) + util::fmtF(*v, 2) + u'%';
}
OJson finding(const QString& tone, const QString& title, const QString& text) {
    return js::object({{u"tone"_s, js::S(tone)}, {u"title"_s, js::S(title)}, {u"text"_s, js::S(text)}});
}
}  // namespace

double tripStart(const OJson& trip) {
    const auto when = firstWhen(concat(listOf(trip, u"entries", u"(trip.entries ?? [])"_s), listOf(trip, u"exits", u"(trip.exits ?? [])"_s)));
    if (!when) throw tr::ReviewError(u"这笔交易没有可用的成交时间,无法定位。"_s);
    return *when;
}

OJson reviewStock(const OJson& trip, const QList<OJson>& bars, const QString& timeframe, double now) {
    const OJson* kindP = P(trip, u"kind");
    if (!(js::isStr(kindP) && kindP->s == u"stock")) throw tr::ReviewError(u"这条记录不是股票交易。"_s);
    if (bars.isEmpty()) throw tr::ReviewError(u"没有 K 线,无法复盘。"_s);
    const bool daily = tr::isDaily(bars);
    const OJson* sideP = P(trip, u"side");
    const bool isLong = js::isStr(sideP) && sideP->s == u"LONG";
    const double sign = isLong ? 1 : -1;
    // entries.length:不是数组时 TS 读出来是 undefined(> 0 不成立),到 tripStart 才抛
    const OJson* entriesP = P(trip, u"entries");
    const OJson* exitsP = P(trip, u"exits");
    const qsizetype entriesLen = js::isArr(entriesP) ? entriesP->items.size() : 0;
    const bool hasEntry = entriesLen > 0;
    const OJson* statusP = P(trip, u"status");
    const bool closed = js::isStr(statusP) && statusP->s == kKindClosed;
    const std::optional<double> avgEntry = optNum(P(trip, u"avg_entry"));
    const std::optional<double> avgExit = optNum(P(trip, u"avg_exit"));
    QStringList notes;

    if (js::truthy(P(trip, u"carried"))) {
        notes << (hasEntry ? u"这段持仓里有"_s + (js::truthy(P(trip, u"opening_assumed")) ? u"至少"_s : QString()) + u' ' + trimV(P(trip, u"carried_qty")) +
                                 u" 股建仓早于已同步的成交,没有成本价:均价与盈亏算不出,只看走势与进出位置"_s
                           : u"建仓早于已同步的成交(TWS 只给当天的成交),没有买入价:成本与盈亏未知,只复盘出场"_s);
    }
    if (js::truthy(P(trip, u"opening_assumed")))
        notes << u"没连券商,核对不了期初持仓:先卖出的部分按“卖的是更早买的货”算(卖出不等于卖空),其余当作从空仓开始;"_s
                     u"之前要是有这只股票的空头仓位,方向可能认反。连上券商后按真实持仓重算"_s;
    if (entriesLen > 1) notes << u"中途加过仓:浮盈浮亏按最终均价与最大持仓估算,加仓之前的那段实际仓位更小"_s;

    const double startTime = tripStart(trip);
    const QList<OJson>& entries = js::isArr(entriesP) ? entriesP->items : listOf(trip, u"entries", u"(trip.entries ?? [])"_s);
    const QList<OJson>& exits = js::isArr(exitsP) ? exitsP->items : listOf(trip, u"exits", u"(trip.exits ?? [])"_s);
    const auto startIdxOpt = tr::indexAt(bars, startTime, daily);
    const auto lastBarTime = tr::parseWhen(tr::barTime(&bars.last()));
    const bool covered = startIdxOpt && (!lastBarTime || startTime <= *lastBarTime + tr::barSeconds(timeframe, daily) * 1000);
    if (!covered || !startIdxOpt)
        throw tr::ReviewError(u"K 线窗口没有覆盖到这笔交易的开始时刻("_s + tr::etKey(startTime, daily) + u"),换更长的周期再试。"_s);
    const qsizetype startIdx = *startIdxOpt;
    const qsizetype lastIdx = bars.size() - 1;
    const auto at = [&](const std::optional<double>& when) -> std::optional<qsizetype> {
        if (!when) return std::nullopt;
        const auto idx = tr::indexAt(bars, *when, daily);
        return !idx || *idx < startIdx ? startIdx : *idx;
    };
    const std::optional<qsizetype> entryIdx = hasEntry ? at(firstWhen(entries)) : std::nullopt;
    const auto firstExitIdx = at(firstWhen(exits));
    const auto lastExitIdx = at(lastWhen(exits));
    const qsizetype endIdx = closed && lastExitIdx ? *lastExitIdx : lastIdx;

    const auto startClose = num(js::propStrict(&bars[startIdx], u"close"_s));
    const auto endClose = num(js::propStrict(&bars[endIdx], u"close"_s));
    if (!startClose || !endClose) throw tr::ReviewError(u"K 线里有空收盘价,无法复盘。"_s);

    // ---- 持有期
    OJson stats = js::object({
        {u"start_underlying"_s, js::N(*startClose)}, {u"end_underlying"_s, js::N(*endClose)},
        {u"hold_bars"_s, js::Null()}, {u"hold_high"_s, js::Null()}, {u"hold_low"_s, js::Null()},
        {u"mfe"_s, js::Null()}, {u"mae"_s, js::Null()},
        {u"entry_position"_s, js::Null()}, {u"exit_position"_s, js::Null()}, {u"capture_ratio"_s, js::Null()}, {u"capture_pct"_s, js::Null()},
        {u"pre_entry_move"_s, js::Null()}, {u"pre_entry_pct"_s, js::Null()}, {u"pre_entry_bars"_s, js::Null()},
        {u"post_entry_move"_s, js::Null()}, {u"post_entry_pct"_s, js::Null()}, {u"post_entry_bars"_s, js::Null()},
        {u"pre_exit_move"_s, js::Null()}, {u"pre_exit_pct"_s, js::Null()}, {u"pre_exit_bars"_s, js::Null()},
        {u"post_exit"_s, js::Null()},
    });
    const auto pct = [](double move, const std::optional<double>& base) {
        return base && *base != 0 && !std::isnan(*base) ? js::N(util::pyRound((move / *base) * 100, 2)) : js::Null();
    };
    const double tripQty = N(trip, u"qty");

    if (entryIdx) {
        const auto hi = extreme(bars, *entryIdx, endIdx, true);
        const auto lo = extreme(bars, *entryIdx, endIdx, false);
        stats.set(u"hold_bars"_s, js::N(double(endIdx - *entryIdx + 1)));
        if (hi && lo) {
            // 成交价可能落在 K 线之外:区间把成交价也算进去
            double top = hi->value, bottom = lo->value;
            for (const OJson& e : concat(entries, exits))
                if (const auto p = num(js::prop(&e, u"price"_s))) top = jm::max(top, *p);
            for (const OJson& e : concat(entries, exits))
                if (const auto p = num(js::prop(&e, u"price"_s))) bottom = jm::min(bottom, *p);
            stats.set(u"hold_high"_s, js::N(top));
            stats.set(u"hold_low"_s, js::N(bottom));
            if (avgEntry) {
                const Extreme& fav = isLong ? *hi : *lo;
                const Extreme& adv = isLong ? *lo : *hi;
                const double favMove = jm::max((fav.value - *avgEntry) * sign, 0);
                const double advMove = jm::max((*avgEntry - adv.value) * sign, 0);
                stats.set(u"mfe"_s, js::object({{u"per_share"_s, js::N(util::pyRound(favMove, 4))}, {u"pct"_s, pct(favMove, avgEntry)},
                                                {u"amount"_s, js::N(util::pyRound(favMove * tripQty, 2))}, {u"price"_s, js::N(fav.value)},
                                                {u"time"_s, js::S(tr::barTime(&bars[fav.index]))}}));
                stats.set(u"mae"_s, js::object({{u"per_share"_s, js::N(util::pyRound(advMove, 4))}, {u"pct"_s, pct(advMove, avgEntry)},
                                                {u"amount"_s, js::N(util::pyRound(advMove * tripQty, 2))}, {u"price"_s, js::N(adv.value)},
                                                {u"time"_s, js::S(tr::barTime(&bars[adv.index]))}}));
                const double range = top - bottom;
                if (range > kEps) {
                    // 1 = 买在区间最低(做空:卖在最高),0 = 买在最高
                    stats.set(u"entry_position"_s, js::N(util::pyRound(clamp01(isLong ? (top - *avgEntry) / range : (*avgEntry - bottom) / range), 3)));
                    if (avgExit) stats.set(u"exit_position"_s, js::N(util::pyRound(clamp01(isLong ? (*avgExit - bottom) / range : (top - *avgExit) / range), 3)));
                }
                if (avgExit && favMove > kEps) {
                    stats.set(u"capture_ratio"_s, js::N(util::pyRound(((*avgExit - *avgEntry) * sign) / favMove, 3)));
                    stats.set(u"capture_pct"_s, js::N(util::jsRound((((*avgExit - *avgEntry) * sign) / favMove) * 100)));
                }
            }
        }
        const qsizetype preIdx = std::max<qsizetype>(*entryIdx - tr::kPreTrendBars, 0);
        const auto preClose = num(js::propStrict(&bars[preIdx], u"close"_s));
        const auto entryClose = num(js::propStrict(&bars[*entryIdx], u"close"_s));
        if (preClose && entryClose && preIdx != *entryIdx) {
            stats.set(u"pre_entry_move"_s, js::N(util::pyRound(*entryClose - *preClose, 4)));
            stats.set(u"pre_entry_pct"_s, pct(*entryClose - *preClose, preClose));
            stats.set(u"pre_entry_bars"_s, js::N(double(*entryIdx - preIdx)));
        }
        const qsizetype postIdx = std::min(*entryIdx + tr::kPostEntryBars, endIdx);
        const auto postClose = num(js::propStrict(&bars[postIdx], u"close"_s));
        // 对第一次出手的成交价比,不对最终均价比
        auto base = num(js::propStrict(&entries[0], u"price"_s));
        if (!base) base = entryClose;
        if (postClose && base && postIdx != *entryIdx) {
            stats.set(u"post_entry_move"_s, js::N(util::pyRound(*postClose - *base, 4)));
            stats.set(u"post_entry_pct"_s, pct(*postClose - *base, base));
            stats.set(u"post_entry_bars"_s, js::N(double(postIdx - *entryIdx)));
        }
    }

    if (firstExitIdx && lastExitIdx && avgExit) {
        const qsizetype preIdx = std::max<qsizetype>(*firstExitIdx - tr::kPreTrendBars, 0);
        const auto preClose = num(js::propStrict(&bars[preIdx], u"close"_s));
        if (preClose && preIdx != *firstExitIdx) {
            stats.set(u"pre_exit_move"_s, js::N(util::pyRound(*avgExit - *preClose, 4)));
            stats.set(u"pre_exit_pct"_s, pct(*avgExit - *preClose, preClose));
            stats.set(u"pre_exit_bars"_s, js::N(double(*firstExitIdx - preIdx)));
        }
        const qsizetype afterHi = std::min(*lastExitIdx + tr::kLookaheadBars, lastIdx);
        if (afterHi > *lastExitIdx) {
            const auto hi = extreme(bars, *lastExitIdx + 1, afterHi, true);
            const auto lo = extreme(bars, *lastExitIdx + 1, afterHi, false);
            const auto lastClose = num(js::propStrict(&bars[afterHi], u"close"_s));
            if (hi && lo && lastClose) {
                // 对"要是没走"的人有利的方向:多头看之后的最高,空头看之后的最低
                const Extreme& fav = isLong ? *hi : *lo;
                const Extreme& adv = isLong ? *lo : *hi;
                const double missed = jm::max((fav.value - *avgExit) * sign, 0);
                const double avoided = jm::max((*avgExit - adv.value) * sign, 0);
                stats.set(u"post_exit"_s,
                          js::object({{u"bars"_s, js::N(double(afterHi - *lastExitIdx))},
                                      {u"close"_s, js::N(*lastClose)},
                                      {u"move"_s, js::N(util::pyRound(*lastClose - *avgExit, 4))},
                                      {u"move_pct"_s, pct(*lastClose - *avgExit, avgExit)},
                                      {u"missed"_s, js::object({{u"per_share"_s, js::N(util::pyRound(missed, 4))}, {u"pct"_s, pct(missed, avgExit)},
                                                                {u"price"_s, js::N(fav.value)}, {u"time"_s, js::S(tr::barTime(&bars[fav.index]))}})},
                                      {u"avoided"_s, js::object({{u"per_share"_s, js::N(util::pyRound(avoided, 4))}, {u"pct"_s, pct(avoided, avgExit)},
                                                                 {u"price"_s, js::N(adv.value)}, {u"time"_s, js::S(tr::barTime(&bars[adv.index]))}})}}));
            }
        }
    }

    // ---- 结局
    const std::optional<double> realized = optNum(P(trip, u"realized_pnl"));
    std::optional<double> unrealized;
    if (!closed && avgEntry) unrealized = util::pyRound((*endClose - *avgEntry) * sign * N(trip, u"open_qty"), 2);
    const std::optional<double> total = realized ? std::optional<double>(util::pyRound(*realized + unrealized.value_or(0), 2)) : std::nullopt;
    const double basis = avgEntry ? *avgEntry * (closed ? N(trip, u"realized_qty") : tripQty) : 0;
    const std::optional<double> endTime = closed ? lastWhen(exits) : std::nullopt;
    OJson outcome = js::object({
        {u"kind"_s, js::S(QString::fromUtf16(closed ? kKindClosed : kKindOpen))},
        {u"time"_s, endTime ? js::S(util::utcIso(*endTime)) : js::Null()},
        {u"time_et"_s, endTime ? js::S(tr::etKey(*endTime, false)) : js::Null()},
        {u"price"_s, optN(avgExit)},
        {u"underlying"_s, js::N(*endClose)},
        {u"realized_pnl"_s, optN(realized)},
        {u"unrealized_pnl"_s, optN(unrealized)},
        {u"pnl"_s, optN(total)},
        {u"pnl_pct"_s, total && basis != 0 && !std::isnan(basis) ? js::N(util::pyRound((*total / basis) * 100, 2)) : js::Null()},
        {u"commission"_s, js::nullish(P(trip, u"commission")) ? js::Null() : *P(trip, u"commission")},
    });
    setRaw(outcome, u"open_qty"_s, P(trip, u"open_qty"));
    const OJson entryOut = js::object({
        {u"time"_s, js::S(util::utcIso(startTime))},
        {u"time_et"_s, js::S(tr::etKey(startTime, false))},
        {u"price"_s, optN(avgEntry)},
        {u"known"_s, js::B(hasEntry && avgEntry)},
        {u"underlying"_s, js::N(*startClose)},
        {u"bar_time"_s, js::S(tr::barTime(&bars[startIdx]))},
    });

    // ---- 图:窗口 + 每次出手一个标记 + 均价线
    const auto [loI, hiI] = stockWindow(bars, startIdx, endIdx);
    OJson markers = js::array();
    QList<qsizetype> mustKeep{startIdx - loI, endIdx - loI};
    const auto mark = [&](const QList<OJson>& list, const QString& role) {
        for (const OJson& e : list) {
            const auto idx = at(tr::parseWhen(js::propStrict(&e, u"time"_s)));
            if (!idx) continue;
            mustKeep << *idx - loI;
            OJson m = js::object({{u"kind"_s, js::S(role)}});
            setRaw(m, u"action"_s, js::prop(&e, u"action"_s));
            m.set(u"time"_s, js::S(tr::barTime(&bars[*idx])));
            setRaw(m, u"price"_s, js::prop(&e, u"price"_s));
            setRaw(m, u"qty"_s, js::prop(&e, u"qty"_s));
            markers.items << m;
        }
    };
    mark(entries, u"entry"_s);
    mark(exits, u"exit"_s);
    const qsizetype winLen = hiI - loI + 1;
    QList<qsizetype> keep;
    if (winLen > tr::kMaxWindow) {
        const qsizetype step = qsizetype(std::ceil(double(winLen) / double(tr::kMaxWindow)));
        for (qsizetype i = 0; i < winLen; ++i)
            if (i % step == 0) keep << i;
        // keep.includes(window[must]):同一个对象才算(JSON 读进来的 K 线各是各的,按下标比)
        for (const qsizetype must : mustKeep)
            if (!keep.contains(must)) keep << must;
        QList<std::pair<QString, qsizetype>> keyed;
        for (const qsizetype k : keep) keyed << std::pair{tr::barTime(&bars[loI + k]), k};
        std::stable_sort(keyed.begin(), keyed.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
        keep.clear();
        for (const auto& [t, k] : keyed) keep << k;
    } else {
        for (qsizetype i = 0; i < winLen; ++i) keep << i;
    }
    OJson window = js::array();
    for (const qsizetype k : keep) window.items << bars[loI + k];
    OJson levels = js::array();
    if (avgEntry) levels.items << js::object({{u"kind"_s, js::S(u"avg_entry"_s)}, {u"price"_s, js::N(*avgEntry)}});
    if (avgExit) levels.items << js::object({{u"kind"_s, js::S(u"avg_exit"_s)}, {u"price"_s, js::N(*avgExit)}});

    OJson profile = js::object();
    setRaw(profile, u"symbol"_s, P(trip, u"symbol"));
    setRaw(profile, u"side"_s, sideP);
    profile.set(u"side_label"_s, js::S(isLong ? u"做多"_s : u"做空"_s));
    for (const char16_t* k : {u"qty", u"entry_qty", u"exit_qty", u"open_qty"}) setRaw(profile, QString::fromUtf16(k), P(trip, k));
    profile.set(u"avg_entry"_s, optN(avgEntry));
    profile.set(u"avg_exit"_s, optN(avgExit));
    profile.set(u"carried"_s, js::B(js::truthy(P(trip, u"carried"))));
    profile.set(u"carried_qty"_s, js::nullish(P(trip, u"carried_qty")) ? js::N(0) : *P(trip, u"carried_qty"));
    profile.set(u"currency"_s, js::nullish(P(trip, u"currency")) ? js::S(u"USD"_s) : *P(trip, u"currency"));
    profile.set(u"cost"_s, avgEntry ? js::N(util::pyRound(*avgEntry * tripQty, 2)) : js::Null());
    OJson pe = js::array(), px_ = js::array();
    for (const OJson& e : entries) pe.items << withEt(e);
    for (const OJson& e : exits) px_.items << withEt(e);
    profile.set(u"entries"_s, pe);
    profile.set(u"exits"_s, px_);
    const OJson findings = buildStockFindings(profile, entryOut, outcome, stats);
    return js::object({
        {u"kind"_s, js::S(u"stock"_s)},
        {u"profile"_s, profile},
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
OJson buildStockFindings(const OJson& profile, const OJson& entry, const OJson& outcome, const OJson& stats) {
    OJson out = js::array();
    const OJson* sideP = P(profile, u"side");
    const bool isLong = js::isStr(sideP) && sideP->s == u"LONG";
    const QString open = isLong ? u"买入"_s : u"卖空"_s;
    const QString close = isLong ? u"卖出"_s : u"买回"_s;
    const QString symbol = Sx(profile, u"symbol");
    const OJson* ep = P(profile, u"entries");
    const OJson* xp = P(profile, u"exits");
    const qsizetype nEntries = js::isArr(ep) ? ep->items.size() : 0, nExits = js::isArr(xp) ? xp->items.size() : 0;
    const double sign = isLong ? 1 : -1;
    const auto statOpt = [&](const char16_t* k) { return optNum(P(stats, k)); };
    // 涨跌不到万分之五就别硬分方向
    const auto flat = [](const std::optional<double>& p) { return p && std::fabs(*p) < 0.05; };
    const bool known = js::truthy(P(entry, u"known"));
    const auto avgExitText = [&] { return isNull(profile, u"avg_exit") ? u"—"_s : trimV(P(profile, u"avg_exit")); };

    if (!known && !nExits) {
        out.items << finding(u"warn"_s, u"成本未知"_s,
                             symbol + u" 在已同步的成交之前就有 "_s + trimV(P(profile, u"carried_qty")) + u" 股,之后又"_s + open + u' ' + trimV(P(profile, u"entry_qty")) + u" 股("_s +
                                 n2s(double(nEntries)) + u" 次出手)。"_s + u"老仓位没有建仓价,整段持仓的均价与盈亏算不出,下面只看这几次出手前后的走势。"_s);
    } else if (!known) {
        out.items << finding(u"warn"_s, u"只有出场"_s,
                             close + u' ' + symbol + u' ' + trimV(P(profile, u"exit_qty")) + u" 股,均价 "_s + avgExitText() + u'(' + n2s(double(nExits)) + u" 次出手)。"_s +
                                 u"这段持仓建立在已同步的成交之前,没有建仓价,成本与盈亏算不出,下面只看出场的位置。"_s);
    } else {
        QStringList parts{Sx(profile, u"side_label") + u' ' + symbol + u' ' + trimV(P(profile, u"qty")) + u" 股,"_s + open + u"均价 "_s + trimV(P(profile, u"avg_entry")) + u'(' +
                          n2s(double(nEntries)) + u" 次出手),成本 "_s + fmtFv(P(profile, u"cost"), 2)};
        if (!isNull(profile, u"avg_exit"))
            parts << close + u"均价 "_s + trimV(P(profile, u"avg_exit")) + u'(' + n2s(double(nExits)) + u" 次出手,共 "_s + trimV(P(profile, u"exit_qty")) + u" 股)"_s;
        out.items << finding(u"info"_s, u"结构"_s, parts.join(u';') + u"。"_s);
    }

    if (!isNull(stats, u"pre_entry_move")) {
        const double mv = N(stats, u"pre_entry_move");
        const bool withTrend = (mv > 0) == isLong;
        if (flat(statOpt(u"pre_entry_pct")))
            out.items << finding(u"info"_s, u"开仓前走势"_s, u"开仓前 "_s + Sx(stats, u"pre_entry_bars") + u" 根 K 线基本没动("_s + pctText(statOpt(u"pre_entry_pct")) + u"),是在横盘里进的。"_s);
        else
            out.items << finding(u"info"_s, u"开仓前走势"_s,
                                 u"开仓前 "_s + Sx(stats, u"pre_entry_bars") + u" 根 K 线"_s + (mv > 0 ? u"上涨"_s : u"下跌"_s) + u' ' + px(std::fabs(mv)) + u'(' +
                                     pctText(statOpt(u"pre_entry_pct")) + u"),"_s +
                                     (withTrend ? u"是顺着走势"_s + (isLong ? u"追进去"_s : u"追空"_s) + u"的。"_s : u"是逆着走势"_s + (isLong ? u"接回调"_s : u"摸顶做空"_s) + u"的。"_s));
    }

    if (!isNull(stats, u"entry_position")) {
        const double p = N(stats, u"entry_position");
        const QString where = open + u"均价 "_s + trimV(P(profile, u"avg_entry")) + u" 落在持有期区间 "_s + trimV(P(stats, u"hold_low")) + u" ~ "_s + trimV(P(stats, u"hold_high")) + u" 的"_s;
        const QString rank = util::fmtF((1 - p) * 100, 0);
        const QString dir = u"从"_s + (isLong ? u"低"_s : u"高"_s) + u"往"_s + (isLong ? u"高"_s : u"低"_s) + u"数第 "_s + rank + u"%)"_s;
        if (p >= 0.7) out.items << finding(u"good"_s, u"进场位置"_s, where + (isLong ? u"低位"_s : u"高位"_s) + u'(' + dir + u",进得不错。"_s);
        else if (p <= 0.3) out.items << finding(u"warn"_s, u"进场位置"_s, where + (isLong ? u"高位"_s : u"低位"_s) + u'(' + dir + u",之后有过更好的价格。"_s);
        else out.items << finding(u"info"_s, u"进场位置"_s, where + u"中段("_s + dir + u"。"_s);
    }

    if (!isNull(stats, u"post_entry_move")) {
        const double mv = N(stats, u"post_entry_move");
        const bool favorable = (mv > 0) == isLong && mv != 0;
        if (flat(statOpt(u"post_entry_pct")))
            out.items << finding(u"info"_s, u"开仓后走势"_s,
                                 u"开仓后 "_s + Sx(stats, u"post_entry_bars") + u" 根 K 线相对首次成交价基本没动("_s + pctText(statOpt(u"post_entry_pct")) + u")。"_s);
        else
            out.items << finding(favorable ? u"good"_s : u"warn"_s, u"开仓后走势"_s,
                                 u"开仓后 "_s + Sx(stats, u"post_entry_bars") + u" 根 K 线相对首次成交价"_s + (mv > 0 ? u"上涨"_s : u"下跌"_s) + u' ' + px(std::fabs(mv)) + u'(' +
                                     pctText(statOpt(u"post_entry_pct")) + u"),"_s + (favorable ? u"一进场就朝有利方向走"_s : u"一进场就先被套"_s) + u"。"_s);
    }

    const OJson* mfe = P(stats, u"mfe");
    const OJson* mae = P(stats, u"mae");
    const bool mfeNull = mfe && mfe->type == OJson::Null, maeNull = mae && mae->type == OJson::Null;
    if (!mfeNull && !maeNull && N(stats, u"hold_bars") > 1) {
        const bool heavy = N(*mae, u"per_share") > N(*mfe, u"per_share") * 2 && N(*mae, u"per_share") > 0;
        const auto maePct = optNum(P(*mae, u"pct"));
        out.items << finding(heavy ? u"warn"_s : u"info"_s, u"持有期"_s,
                             u"持有 "_s + Sx(stats, u"hold_bars") + u" 根 K 线。最大浮盈 "_s + money(optNum(P(*mfe, u"amount"))) + u'(' + pctText(optNum(P(*mfe, u"pct"))) + u',' +
                                 Sx(*mfe, u"time") + u" 到 "_s + trimV(P(*mfe, u"price")) + u");"_s + u"最大浮亏 "_s + money(-N(*mae, u"amount")) + u'(' +
                                 pctText(maePct ? std::optional<double>(-*maePct) : std::nullopt) + u',' + Sx(*mae, u"time") + u" 到 "_s + trimV(P(*mae, u"price")) + u")。"_s +
                                 (heavy ? u"扛过的浮亏是拿到过的浮盈的两倍以上。"_s : QString()));
    }

    if (known && !isNull(profile, u"avg_exit") && !isNull(stats, u"exit_position")) {
        const auto cap = statOpt(u"capture_ratio");
        const QString capPct = Sx(stats, u"capture_pct");
        QString text = close + u"均价 "_s + trimV(P(profile, u"avg_exit")) + u" 落在持有期区间的 "_s + util::fmtF(N(stats, u"exit_position") * 100, 0) + u"% 位置(100% = "_s +
                       (isLong ? u"最高"_s : u"最低"_s) + u')';
        QString tone = u"info"_s;
        if (cap) {
            if (*cap >= 0.6) {
                tone = u"good"_s;
                text += u",兑现了最大浮盈的 "_s + capPct + u'%';
            } else if (*cap > 0) {
                text += u",只兑现了最大浮盈的 "_s + capPct + u'%';
                if (*cap < 0.3) tone = u"warn"_s;
            } else {
                tone = u"warn"_s;
                text += u",曾经浮盈 "_s + money(mfeNull ? std::nullopt : optNum(P(*mfe, u"amount"))) + u",最后却"_s + (*cap < 0 ? u"亏着"_s : u"平着"_s) + u"出来"_s;
            }
        }
        out.items << finding(tone, u"出场位置"_s, text + u"。"_s);
    } else if (!known && !isNull(stats, u"pre_exit_move")) {
        const double mv = N(stats, u"pre_exit_move");
        const bool intoStrength = (mv > 0) == isLong;
        if (flat(statOpt(u"pre_exit_pct")))
            out.items << finding(u"info"_s, u"出场前走势"_s, close + u"前 "_s + Sx(stats, u"pre_exit_bars") + u" 根 K 线到成交价基本没动("_s + pctText(statOpt(u"pre_exit_pct")) + u")。"_s);
        else
            out.items << finding(intoStrength ? u"good"_s : u"info"_s, u"出场前走势"_s,
                                 close + u"前 "_s + Sx(stats, u"pre_exit_bars") + u" 根 K 线到成交价"_s + (mv > 0 ? u"上涨"_s : u"下跌"_s) + u' ' + px(std::fabs(mv)) + u'(' +
                                     pctText(statOpt(u"pre_exit_pct")) + u"),"_s +
                                     (intoStrength ? u"是"_s + (isLong ? u"趁涨"_s : u"趁跌"_s) + u"出的。"_s : u"是"_s + (isLong ? u"跌下来之后"_s : u"涨上去之后"_s) + u"才出的。"_s));
    }

    const OJson* pe = P(stats, u"post_exit");
    if (!(pe && pe->type == OJson::Null)) {
        const OJson& missed = *P(*pe, u"missed");
        const OJson& avoided = *P(*pe, u"avoided");
        const bool early = N(missed, u"per_share") > N(avoided, u"per_share");
        const auto mp = optNum(P(missed, u"pct")), ap = optNum(P(avoided, u"pct"));
        out.items << finding(early ? u"warn"_s : u"good"_s, close + u"之后"_s,
                             close + u"后 "_s + Sx(*pe, u"bars") + u" 根 K 线,"_s + (isLong ? u"最高"_s : u"最低"_s) + u"到 "_s + trimV(P(missed, u"price")) + u"(比"_s + close + u"价"_s +
                                 (isLong ? u"高"_s : u"低"_s) + u' ' + trimV(P(missed, u"per_share")) + u',' + pctText(mp ? std::optional<double>(*mp * sign) : std::nullopt) + u"),"_s +
                                 (isLong ? u"最低"_s : u"最高"_s) + u"到 "_s + trimV(P(avoided, u"price")) + u'(' + (isLong ? u"低"_s : u"高"_s) + u' ' + trimV(P(avoided, u"per_share")) +
                                 u',' + pctText(ap ? std::optional<double>(-*ap * sign) : std::nullopt) + u");"_s +
                                 (early ? u"走了之后还有一段"_s + (isLong ? u"涨"_s : u"跌"_s) + u"幅没吃到。"_s
                                        : u"走了之后"_s + (isLong ? u"回落"_s : u"反弹"_s) + u"更多,这一下躲开了。"_s));
    }

    const OJson* kindP = P(outcome, u"kind");
    if (js::isStr(kindP) && kindP->s == kKindClosed) {
        if (isNull(outcome, u"pnl")) {
            out.items << finding(u"info"_s, u"平仓"_s,
                                 Sx(outcome, u"time_et") + u" 全部"_s + close + u",均价 "_s + (isNull(outcome, u"price") ? u"—"_s : trimV(P(outcome, u"price"))) + u";没有建仓价,盈亏未知。"_s);
        } else {
            out.items << finding(N(outcome, u"pnl") > 0 ? u"good"_s : u"bad"_s, u"平仓"_s,
                                 Sx(outcome, u"time_et") + u" 全部平仓,已实现盈亏 "_s + money(optNum(P(outcome, u"pnl"))) + u'(' + pctText(optNum(P(outcome, u"pnl_pct"))) + u')' +
                                     (js::truthy(P(outcome, u"commission")) ? u",佣金 "_s + fmtFv(P(outcome, u"commission"), 2) + u" 未扣"_s : QString()) + u"。"_s);
        }
    } else {
        QStringList bits{u"还持有 "_s + trimV(P(outcome, u"open_qty")) + u" 股,最新 "_s + trimV(P(outcome, u"underlying"))};
        if (!isNull(outcome, u"unrealized_pnl")) bits << u"浮动盈亏 "_s + money(optNum(P(outcome, u"unrealized_pnl")));
        if (!isNull(outcome, u"realized_pnl") && nExits) bits << u"已实现 "_s + money(optNum(P(outcome, u"realized_pnl")));
        out.items << finding(u"info"_s, u"持仓中"_s, bits.join(u',') + u"。"_s);
    }
    return out;
}

}  // namespace ibkr::analysis::stockreview
