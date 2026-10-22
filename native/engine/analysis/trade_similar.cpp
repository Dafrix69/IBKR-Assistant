#include "analysis/trade_similar.h"

#include "analysis/tradereview.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
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
namespace tr = ibkr::analysis::tradereview;

namespace ibkr::analysis::trade_similar {

namespace {
constexpr double kInf = std::numeric_limits<double>::infinity();
const OJson* P(const OJson& o, const char16_t* k) { return js::prop(&o, QString::fromUtf16(k)); }
QString Sx(const OJson& o, const char16_t* k) { return js::str(P(o, k)); }
bool isNull(const OJson* v) { return v && v->type == OJson::Null; }
QString n2s(double v) { return util::jsNumberToString(v); }
QString fixed(double v, int n) { return util::jsToFixed(v, n); }
/// facts.filter(kind).map(f => [f.id, f]) 的 Map:同一个 id 后来的覆盖
QHash<QString, const OJson*> factsById(const QList<OJson>& facts, const QString& kind) {
    QHash<QString, const OJson*> out;
    for (const OJson& f : facts)
        if (Sx(f, u"kind") == kind) out.insert(Sx(f, u"id"), &f);
    return out;
}
}  // namespace

OJson HistoryEntry::toJson() const {
    OJson o = js::object({{u"fact"_s, fact}, {u"exit"_s, js::S(exit)}, {u"structure"_s, js::S(structure)}, {u"coarse"_s, js::B(coarse)}});
    if (right) o.set(u"right"_s, js::S(*right));
    if (width) o.set(u"width"_s, js::N(*width));
    if (dte) o.set(u"dte"_s, js::S(*dte));
    if (slot) o.set(u"slot"_s, js::S(*slot));
    if (debitRatio) o.set(u"debitRatio"_s, js::N(*debitRatio));
    if (centerDist) o.set(u"centerDist"_s, js::N(*centerDist));
    if (side) o.set(u"side"_s, js::S(*side));
    if (rangePos) o.set(u"rangePos"_s, js::N(*rangePos));
    return o;
}

HistoryEntry HistoryEntry::fromJson(const OJson& o) {
    HistoryEntry e;
    e.fact = js::copyOrNull(o.get(u"fact"_s));
    e.exit = Sx(o, u"exit");
    e.structure = Sx(o, u"structure");
    e.coarse = js::truthy(o.get(u"coarse"_s));
    const auto s = [&](const char16_t* k) { const OJson* v = P(o, k); return js::nullish(v) ? std::nullopt : std::optional<QString>(js::str(v)); };
    const auto n = [&](const char16_t* k) { const OJson* v = P(o, k); return js::nullish(v) ? std::nullopt : std::optional<double>(js::num(v)); };
    e.right = s(u"right");
    e.width = n(u"width");
    e.dte = s(u"dte");
    e.slot = s(u"slot");
    e.debitRatio = n(u"debitRatio");
    e.centerDist = n(u"centerDist");
    e.side = s(u"side");
    e.rangePos = n(u"rangePos");
    return e;
}

QString rangeBucket(double pos) {
    if (pos < 1.0 / 3) return u"低位"_s;
    if (pos > 2.0 / 3) return u"高位"_s;
    return u"中间"_s;
}

std::optional<double> rangePosition(const QList<OJson>& bars, const QString& beforeDate, double price, double lookback) {
    QList<const OJson*> filtered;
    for (const OJson& b : bars)
        if (js::strOr(js::propStrict(&b, u"date"_s), QString()) < beforeDate) filtered << &b;
    // .slice(-lookback):ToIntegerOrInfinity,负的从尾巴数;-0 就是从头
    const double rel = std::isnan(lookback) ? 0 : std::trunc(-lookback);
    const qsizetype len = filtered.size();
    const qsizetype start = rel < 0 ? qsizetype(std::max<double>(double(len) + rel, 0)) : qsizetype(std::min<double>(rel, double(len)));
    const QList<const OJson*> prior = filtered.mid(start);
    if (double(prior.size()) < lookback) return std::nullopt;
    double hi = -kInf, lo = kInf;
    for (const OJson* b : prior) hi = jm::max(hi, js::num(js::prop(b, u"high"_s)));
    for (const OJson* b : prior) lo = jm::min(lo, js::num(js::prop(b, u"low"_s)));
    if (!std::isfinite(hi) || !std::isfinite(lo) || hi <= lo) return std::nullopt;
    return (price - lo) / (hi - lo);
}

std::optional<double> priceAt(const QList<OJson>& bars, double whenMs) {
    const auto idx = tr::indexAt(bars, whenMs, false);
    if (!idx) return std::nullopt;
    const double close = js::num(js::prop(&bars[*idx], u"close"_s));
    return std::isfinite(close) ? std::optional<double>(close) : std::nullopt;
}

QString slotOf(double epochMs) {
    const util::WallParts p = util::wallParts(epochMs, QString::fromUtf16(util::kET));
    const double m = p.hour * 60 + p.minute;
    if (m < 9 * 60 + 30 || m >= 16 * 60) return u"盘外"_s;
    if (m < 10 * 60) return u"开盘半小时"_s;
    if (m < 12 * 60) return u"上午"_s;
    if (m < 15 * 60) return u"午后"_s;
    return u"尾盘一小时"_s;
}

QString bucketOfDays(double days) {
    if (days <= 0) return u"当日到期"_s;
    if (days <= 7) return u"一周内到期"_s;
    return u"一周以上到期"_s;
}

std::optional<QString> dteBucket(const QString& expiry, const QString& tradeDate) {
    static const QRegularExpression re(u"\\A([0-9]{4})([0-9]{2})([0-9]{2})\\z"_s);
    QString e = expiry;
    if (const auto m = re.match(expiry); m.hasMatch()) e = m.captured(1) + u'-' + m.captured(2) + u'-' + m.captured(3);
    const double a = util::jsDateParse(e + u"T00:00:00Z"_s), b = util::jsDateParse(tradeDate + u"T00:00:00Z"_s);
    if (!std::isfinite(a) || !std::isfinite(b)) return std::nullopt;
    return bucketOfDays(util::jsRound((a - b) / 86'400'000));
}

QString positionExit(const OJson& p) {
    const QString exit = Sx(p, u"exit");
    if (Sx(p, u"status") == u"持仓中" || exit == u"持仓中") return u"持仓中"_s;
    if (exit == u"持有到期") return u"持有到期"_s;
    if (exit == u"拆腿后到期") return u"拆腿"_s;
    if (exit.contains(u"逐腿"_s)) return u"逐腿平仓"_s;
    return u"提前平仓"_s;
}

// ---------------------------------------------------------------- 历史 → 可比要素
QList<HistoryEntry> butterflyEntries(const QList<OJson>& records, const QList<OJson>& facts, const QHash<QString, double>& entryUnderlying) {
    const QHash<QString, const OJson*> byId = factsById(facts, u"butterfly"_s);
    QList<HistoryEntry> out;
    for (const OJson& record : records) {
        const OJson* fact = byId.value(js::strOr(js::propStrict(&record, u"id"_s), QString()));
        const OJson profile = tr::butterflyProfile(&record);
        if (!fact || profile.type == OJson::Null) continue;
        double when;
        try {
            when = tr::entryOf(&record).time;
        } catch (const tr::ReviewError&) {
            continue;
        }
        const double w = js::num(P(profile, u"width"));
        const std::optional<double> width = w != 0 && !std::isnan(w) ? std::optional<double>(w) : std::nullopt;
        const double debit = js::num(P(profile, u"debit"));
        const QString factId = Sx(*fact, u"id");
        const auto under = entryUnderlying.constFind(factId);
        HistoryEntry e;
        e.fact = *fact;
        const QString how = Sx(*fact, u"how");
        e.exit = how == u"closed" ? u"提前平仓"_s : how == u"expired" ? u"持有到期"_s : u"持仓中"_s;
        e.structure = u"蝴蝶"_s;
        e.right = Sx(profile, u"right");
        e.width = width;
        e.dte = dteBucket(Sx(profile, u"expiry"), tr::etKey(when, true));
        e.slot = slotOf(when);
        if (width && std::isfinite(debit)) e.debitRatio = debit / *width;
        if (width && under != entryUnderlying.constEnd()) e.centerDist = (js::num(P(profile, u"center")) - *under) / *width;
        out << e;
    }
    return out;
}

QList<HistoryEntry> positionEntries(const QList<OJson>& rows, const QList<OJson>& facts, const QHash<QString, double>& entryUnderlying) {
    const QHash<QString, const OJson*> byId = factsById(facts, u"option"_s);
    QList<HistoryEntry> out;
    for (const OJson& p : rows) {
        const OJson* fact = byId.value(Sx(p, u"id"));
        const auto when = tr::parseWhen(P(p, u"open_et"));
        if (!fact || !when) continue;
        const OJson* wP = P(p, u"width");
        const std::optional<double> width = !isNull(wP) && js::num(wP) > 0 ? std::optional<double>(js::num(wP)) : std::nullopt;
        const auto under = entryUnderlying.constFind(Sx(p, u"id"));
        HistoryEntry e;
        e.fact = *fact;
        e.exit = positionExit(p);
        e.structure = Sx(p, u"structure");
        const QString right = Sx(p, u"right");
        if (right == u"C" || right == u"P") e.right = right;
        e.width = width;
        const OJson* dte = P(p, u"dte");
        e.dte = isNull(dte) ? dteBucket(Sx(p, u"expiry"), Sx(p, u"open_et").left(10)) : std::optional<QString>(bucketOfDays(js::num(dte)));
        e.slot = slotOf(*when);
        const OJson* np = P(p, u"net_price");
        if (width && !isNull(np) && js::num(np) > 0) e.debitRatio = js::num(np) / *width;
        const OJson* center = P(p, u"center");
        if (width && !isNull(center) && under != entryUnderlying.constEnd()) e.centerDist = (js::num(center) - *under) / *width;
        out << e;
    }
    return out;
}

QList<HistoryEntry> optionEntries(const QList<OJson>& rows, const QList<OJson>& facts) {
    const QHash<QString, const OJson*> byId = factsById(facts, u"option"_s);
    QList<HistoryEntry> out;
    for (const OJson& r : rows) {
        const OJson* fact = byId.value(Sx(r, u"id"));
        if (!fact) continue;
        const QString action = Sx(r, u"action");
        HistoryEntry e;
        e.fact = *fact;
        e.exit = action == u"拆腿平仓" ? u"拆腿"_s : action.contains(u"到期"_s) ? u"持有到期"_s : u"提前平仓"_s;
        e.structure = Sx(r, u"structure");
        e.coarse = true;
        out << e;
    }
    return out;
}

QList<HistoryEntry> stockEntries(const QList<OJson>& facts, const QHash<QString, double>& rangePos) {
    QList<HistoryEntry> out;
    for (const OJson& fact : facts) {
        if (Sx(fact, u"kind") != u"stock") continue;
        HistoryEntry e;
        e.fact = fact;
        e.exit = Sx(fact, u"how") == u"open" ? u"持仓中"_s : u"已平仓"_s;
        e.structure = u"股票"_s;
        e.side = Sx(fact, u"label").endsWith(u"做空"_s) ? u"SHORT"_s : u"LONG"_s;
        if (const auto it = rangePos.constFind(Sx(fact, u"id")); it != rangePos.constEnd()) e.rangePos = *it;
        out << e;
    }
    return out;
}

// ---------------------------------------------------------------- 票据 → 口径
namespace {
struct Query {
    QString kind, symbol, structure;
    std::optional<QString> right;
    std::optional<double> width;
    std::optional<QString> dte;
    QString slot;
    std::optional<double> debitRatio, centerDist;
    std::optional<QString> side;
    std::optional<double> rangePos;
    QStringList basis;
};

Query describe(const OJson& t, double nowMs, const SimilarContext& ctx) {
    Query q;
    q.symbol = util::jsTrim(Sx(t, u"symbol")).toUpper();
    // [...(t.legs ?? [])].filter(l => l.strike !== null).sort((a, b) => (a.strike ?? 0) - (b.strike ?? 0))
    QList<const OJson*> legs;
    if (const OJson* l = P(t, u"legs"); js::isArr(l))
        for (const OJson& leg : l->items)
            if (!isNull(js::propStrict(&leg, u"strike"_s))) legs << &leg;
    const auto strikeOr0 = [](const OJson* leg) {
        const OJson* s = js::prop(leg, u"strike"_s);
        return js::nullish(s) ? 0.0 : js::num(s);
    };
    std::stable_sort(legs.begin(), legs.end(), [&](const OJson* a, const OJson* b) { return strikeOr0(a) - strikeOr0(b) < 0; });
    q.slot = slotOf(nowMs);
    const QString today = tr::etKey(nowMs, true);
    if (js::truthy(P(t, u"expiry"))) q.dte = dteBucket(Sx(t, u"expiry"), today);
    const QString combo = js::strOr(P(t, u"combo_strategy"), QString()).toUpper();
    const QString secType = Sx(t, u"sec_type").toUpper();
    const auto ratioIs = [&](int i, double v) {
        const OJson* r = js::prop(legs[i], u"ratio"_s);
        return js::isNum(r) && r->n == v;
    };
    const bool flyShape = legs.size() == 3 && ratioIs(0, 1) && ratioIs(1, 2) && ratioIs(2, 1);
    const auto dteList = [&](QStringList b) {
        if (q.dte) b << *q.dte;
        b << q.slot;
        return b;
    };
    if (combo == u"BUTTERFLY" || (secType == u"BAG" && flyShape)) {
        if (legs.size() == 3) q.width = strikeOr0(legs[1]) - strikeOr0(legs[0]);
        const OJson* r0 = legs.isEmpty() ? nullptr : js::prop(legs[0], u"right"_s);
        const OJson* rr = js::nullish(r0) ? P(t, u"right") : r0;
        const QString right = js::strOr(rr, QString()).toUpper();
        if (!right.isEmpty()) q.right = right;
        const bool widthTruthy = q.width && *q.width != 0 && !std::isnan(*q.width);
        const OJson* lp = P(t, u"limit_price");
        if (widthTruthy && js::truthy(lp)) q.debitRatio = std::fabs(js::num(lp)) / *q.width;
        // center = legs[1].strike(可能是 undefined:那时算出来是 NaN)
        const bool hasCenter = legs.size() == 3;
        if (widthTruthy && hasCenter && ctx.spot && *ctx.spot != 0 && !std::isnan(*ctx.spot))
            q.centerDist = (js::num(js::prop(legs[1], u"strike"_s)) - *ctx.spot) / *q.width;
        q.kind = u"butterfly"_s;
        q.structure = u"蝴蝶"_s;
        q.basis << q.symbol + u' ' + (q.right == u"P"_s ? u"看跌"_s : q.right == u"C"_s ? u"看涨"_s : QString()) + u"蝴蝶"_s;
        if (widthTruthy) q.basis << u"翼宽 "_s + n2s(*q.width);
        if (q.dte) q.basis << *q.dte;
        q.basis << q.slot;
        if (q.debitRatio) q.basis << u"权利金 / 翼宽 "_s + fixed(*q.debitRatio, 2);
        if (q.centerDist) q.basis << u"中心离现价 "_s + fixed(*q.centerDist, 1) + u" 个翼宽"_s;
        return q;
    }
    if (combo == u"VERTICAL" || (secType == u"BAG" && legs.size() == 2)) {
        q.kind = u"vertical"_s;
        q.structure = u"垂直价差"_s;
        q.basis = dteList({q.symbol + u" 垂直价差"_s});
        return q;
    }
    if (secType == u"OPT") {
        q.kind = u"single"_s;
        q.structure = u"单腿"_s;
        q.basis = dteList({q.symbol + u" 单腿期权"_s});
        return q;
    }
    if (secType == u"STK") {
        const bool sell = Sx(t, u"action").toUpper() == u"SELL";
        q.kind = u"stock"_s;
        q.structure = u"股票"_s;
        q.dte.reset();
        q.side = sell ? u"SHORT"_s : u"LONG"_s;
        q.rangePos = ctx.rangePos;
        q.basis = QStringList{q.symbol + u" 股票"_s, sell ? u"卖出"_s : u"买入"_s};
        if (q.rangePos)
            q.basis << u"现价在近 "_s + n2s(kRangeLookback) + u" 日区间的"_s + rangeBucket(*q.rangePos) + u'(' + fixed(*q.rangePos, 2) + u')';
        return q;
    }
    q.kind = u"other"_s;
    q.dte.reset();
    q.basis = QStringList{q.symbol};
    return q;
}

struct Score {
    double score;
    QStringList reasons;
    bool primary;
};

std::optional<Score> scoreOf(const Query& q, const HistoryEntry& e, const QSet<QString>& peers) {
    const QString esym = Sx(e.fact, u"symbol").toUpper();
    const bool same = esym == q.symbol;
    if (q.kind == u"stock") {
        if (e.structure != u"股票") return std::nullopt;
        if (!same && !peers.contains(esym)) return std::nullopt;
        Score s{same ? 2.0 : 1.0, {same ? u"同标的"_s : u"同板块("_s + Sx(e.fact, u"symbol") + u')'}, same};
        if (e.side == q.side) {
            s.score += 1;
            s.reasons << (q.side == u"SHORT"_s ? u"同为做空"_s : u"同为做多"_s);
        }
        if (q.rangePos && e.rangePos && rangeBucket(*q.rangePos) == rangeBucket(*e.rangePos)) {
            s.score += 1;
            s.reasons << u"同在近 "_s + n2s(kRangeLookback) + u" 日区间的"_s + rangeBucket(*e.rangePos) + u"进场("_s + fixed(*e.rangePos, 2) + u" / "_s + fixed(*q.rangePos, 2) + u')';
        }
        return s;
    }
    if (!same) return std::nullopt;
    if (q.kind == u"other") return Score{1, {u"同标的"_s}, true};
    if (e.coarse) {
        // 导入的期权:结构名对得上才算;「多个仓位同时结算」大概率是蝴蝶,蝴蝶单才带上
        const bool settledTogether = e.structure == u"多个仓位同时结算" && q.kind == u"butterfly";
        if (e.structure != q.structure && !settledTogether) return std::nullopt;
        return Score{1, {settledTogether ? u"同标的、多只同时到期(大概率是蝴蝶)"_s : u"同标的同结构"_s, u"导入数据没有行权价,只能粗配"_s}, true};
    }
    if (e.structure != q.structure) return std::nullopt;
    Score s{2, {u"同标的同结构"_s}, true};
    const auto truthyN = [](const std::optional<double>& v) { return v && *v != 0 && !std::isnan(*v); };
    if (q.right && !q.right->isEmpty() && e.right == q.right) {
        s.score += 1;
        s.reasons << (*q.right == u"P" ? u"同为看跌"_s : u"同为看涨"_s);
    }
    if (truthyN(q.width) && truthyN(e.width) && std::fabs(*e.width - *q.width) <= *q.width * kWidthTolerance) {
        s.score += 1;
        s.reasons << u"翼宽相近("_s + n2s(*e.width) + u" / "_s + n2s(*q.width) + u')';
    }
    if (q.dte && !q.dte->isEmpty() && e.dte == q.dte) {
        s.score += 1;
        s.reasons << u"同为"_s + *q.dte;
    }
    if (e.slot == q.slot) {
        s.score += 1;
        s.reasons << u"同在"_s + q.slot + u"开仓"_s;
    }
    if (q.debitRatio && e.debitRatio && std::fabs(*e.debitRatio - *q.debitRatio) <= kDebitRatioTolerance) {
        s.score += 1;
        s.reasons << u"权利金 / 翼宽相近("_s + fixed(*e.debitRatio, 2) + u')';
    }
    if (q.centerDist && e.centerDist && std::fabs(*e.centerDist - *q.centerDist) <= kCenterDistTolerance) {
        s.score += 1;
        s.reasons << u"中心离现价相近("_s + fixed(*e.centerDist, 1) + u" / "_s + fixed(*q.centerDist, 1) + u" 个翼宽)"_s;
    }
    return s;
}
}  // namespace

QString ticketKind(const OJson& ticket) { return describe(ticket, 0, {}).kind; }

OJson findSimilar(const OJson& ticket, const QList<HistoryEntry>& history, double nowMs, const QSet<QString>& peers, const SimilarContext& ctx) {
    const Query q = describe(ticket, nowMs, ctx);
    struct Match {
        const HistoryEntry* e;
        Score s;
    };
    QList<Match> matched;
    for (const HistoryEntry& e : history)
        if (auto s = scoreOf(q, e, peers)) matched << Match{&e, *s};
    QList<const Match*> primary;
    for (const Match& m : matched)
        if (m.s.primary) primary << &m;
    const auto count = [](const QString& r, const QList<const Match*>& of) {
        double n = 0;
        for (const Match* m : of)
            if (Sx(m->e->fact, u"result") == r) n += 1;
        return js::N(n);
    };
    OJson exits = js::array();
    for (const QString& exit : {u"提前平仓"_s, u"逐腿平仓"_s, u"持有到期"_s, u"拆腿"_s, u"已平仓"_s, u"持仓中"_s}) {
        QList<const Match*> of;
        for (const Match* m : primary)
            if (m->e->exit == exit) of << m;
        if (of.isEmpty()) continue;
        exits.items << js::object({{u"exit"_s, js::S(exit)},
                                   {u"win"_s, count(u"win"_s, of)},
                                   {u"loss"_s, count(u"loss"_s, of)},
                                   {u"flat"_s, count(u"flat"_s, of)},
                                   {u"open"_s, count(u"open"_s, of)},
                                   {u"unknown"_s, count(u"unknown"_s, of)}});
    }
    const auto when = [](const Match* m) { return tr::parseWhen(P(m->e->fact, u"opened_at")).value_or(0); };
    QList<const Match*> top;
    for (const Match& m : matched) top << &m;
    std::stable_sort(top.begin(), top.end(), [&](const Match* a, const Match* b) {
        const double d1 = double(b->s.primary) - double(a->s.primary);
        if (d1 != 0) return d1 < 0;
        const double d2 = b->s.score - a->s.score;
        if (d2 != 0) return d2 < 0;
        return when(b) - when(a) < 0;
    });
    OJson matches = js::array();
    for (qsizetype i = 0; i < top.size() && i < kTopMatches; ++i) {
        const Match* m = top[i];
        matches.items << js::object({{u"fact"_s, m->e->fact},
                                     {u"score"_s, js::N(m->s.score)},
                                     {u"reasons"_s, js::strings(m->s.reasons)},
                                     {u"exit"_s, js::S(m->e->exit)},
                                     {u"primary"_s, js::B(m->s.primary)}});
    }
    return js::object({
        {u"kind"_s, js::S(q.kind)},
        {u"symbol"_s, js::S(q.symbol)},
        {u"basis"_s, js::strings(q.basis)},
        {u"count"_s, js::N(double(primary.size()))},
        {u"win"_s, count(u"win"_s, primary)},
        {u"loss"_s, count(u"loss"_s, primary)},
        {u"flat"_s, count(u"flat"_s, primary)},
        {u"open"_s, count(u"open"_s, primary)},
        {u"unknown"_s, count(u"unknown"_s, primary)},
        {u"exits"_s, exits},
        {u"matches"_s, matches},
    });
}

}  // namespace ibkr::analysis::trade_similar
