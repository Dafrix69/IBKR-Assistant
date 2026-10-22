#include "analysis/screener.h"

#include "analysis/backtest.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/py.h"
#include "util/tz.h"

#include <QRegularExpression>

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;
namespace bt = ibkr::analysis::backtest;

namespace ibkr::analysis::screener {

const std::vector<double>& rsWindows() {
    static const std::vector<double> w{5, 20, 60, 120, 250};
    return w;
}
const QStringList& rsBenchmarks() {
    static const QStringList b{u"SPY"_s, u"QQQ"_s};
    return b;
}
QString untagged() { return u"未分类"_s; }

namespace {
QString n2s(double v) { return util::jsNumberToString(v); }
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }

struct CleanBar {
    QString time;
    double open, high, low, close, volume;
    OJson toJson() const {
        return js::object({{u"time"_s, js::S(time)}, {u"open"_s, js::N(open)}, {u"high"_s, js::N(high)},
                           {u"low"_s, js::N(low)}, {u"close"_s, js::N(close)}, {u"volume"_s, js::N(volume)}});
    }
};

QString barTime(const OJson* bar) {
    // String(bar["date"] || bar["time"] || "")
    const OJson* d = js::prop(bar, u"date"_s);
    if (js::truthy(d)) return js::str(d);
    const OJson* t = js::prop(bar, u"time"_s);
    if (js::truthy(t)) return js::str(t);
    return QString();
}

std::optional<double> numKey(const OJson* bar, const QString& key) {
    const OJson* v = js::propStrict(bar, key);
    return js::isNum(v) && std::isfinite(v->n) ? std::optional(v->n) : std::nullopt;
}

/// 只留 OHLC 齐全且为正数的 K 线,整根跳过缺数据的
std::vector<CleanBar> clean(const OJson* bars) {
    std::vector<CleanBar> out;
    if (js::nullish(bars)) return out;
    if (js::isStr(bars)) return out;  // 串按字符迭代,每个字符上都读不出数
    if (!js::isArr(bars)) throw util::JsError(u"(bars ?? []) is not iterable"_s);
    for (const OJson& bar : bars->items) {
        const auto o = numKey(&bar, u"open"_s), h = numKey(&bar, u"high"_s), l = numKey(&bar, u"low"_s), c = numKey(&bar, u"close"_s);
        if (!o || !h || !l || !c) continue;
        if (jm::min(jm::min(*o, *h), jm::min(*l, *c)) <= 0) continue;
        const auto v = numKey(&bar, u"volume"_s);
        out.push_back({barTime(&bar), *o, jm::max(jm::max(*h, *o), *c), jm::min(jm::min(*l, *o), *c), *c, v && *v >= 0 ? *v : 0.0});
    }
    return out;
}

std::optional<double> median(const std::vector<double>& values) {
    if (values.empty()) return std::nullopt;
    std::vector<double> ordered = values;
    std::stable_sort(ordered.begin(), ordered.end());
    const size_t n = ordered.size(), mid = n / 2;
    if (n % 2) return ordered[mid];
    return (ordered[mid - 1] + ordered[mid]) / 2.0;
}

/// byScoreThenKey:有分的在前、分高的在前,同分按键(码元序)
bool byScoreThenKey(const std::optional<double>& sa, const QString& ka, const std::optional<double>& sb, const QString& kb) {
    if (sa.has_value() != sb.has_value()) return sa.has_value();
    if (sa && sb && *sa != *sb) return *sb - *sa < 0;
    return ka < kb;
}

std::optional<double> closeAtOrBefore(const QStringList& times, const std::vector<double>& closes, const QString& when) {
    std::optional<double> hit;
    for (qsizetype i = 0; i < times.size(); ++i) {
        if (times[i] <= when) hit = closes[size_t(i)];
        else break;
    }
    return hit;
}
}  // namespace

OJson resampleWeekly(const OJson* bars) {
    static const QRegularExpression ymd(u"\\A([0-9]{4})-([0-9]{2})-([0-9]{2})\\z"_s);
    std::vector<CleanBar> weeks;
    std::optional<double> currentKey;
    for (const CleanBar& bar : clean(bars)) {
        const QString iso = bar.time.left(10);
        const auto m = ymd.match(iso);
        if (!m.hasMatch() || !util::isValidYmd(m.captured(1).toDouble(), m.captured(2).toDouble(), m.captured(3).toDouble())) continue;
        const double key = util::dateOrdinal(iso) - util::weekdayOfDate(iso);
        if (!currentKey || key != *currentKey) {
            weeks.push_back(bar);
            currentKey = key;
            continue;
        }
        CleanBar& last = weeks.back();
        last.time = bar.time;
        last.high = jm::max(last.high, bar.high);
        last.low = jm::min(last.low, bar.low);
        last.close = bar.close;
        last.volume = last.volume + bar.volume;
    }
    OJson out = js::array();
    for (const CleanBar& w : weeks) out.items.append(w.toJson());
    return out;
}

// ================================================================ RS 强度
namespace {
OJson rsByTag(const QList<OJson>& rows, const std::vector<double>& windows) {
    QStringList order;
    QList<QList<const OJson*>> groups;
    for (const OJson& row : rows) {
        const QString tag = row.get(u"tag"_s)->s;
        qsizetype k = order.indexOf(tag);
        if (k < 0) {
            order << tag;
            groups.append(QList<const OJson*>());
            k = order.size() - 1;
        }
        groups[k].append(&row);
    }
    QList<OJson> out;
    for (qsizetype g = 0; g < order.size(); ++g) {
        const auto& members = groups[g];
        OJson symbols = js::array();
        for (const OJson* m : members) symbols.items.append(*m->get(u"symbol"_s));
        OJson entry = js::object({{u"tag"_s, js::S(order[g])}, {u"count"_s, js::N(double(members.size()))}, {u"rs"_s, js::object()}, {u"score"_s, OJson::null()}, {u"symbols"_s, symbols}});
        for (double n : windows) {
            const QString key = n2s(n);
            std::vector<double> vals;
            for (const OJson* m : members)
                if (const OJson* r = m->get(u"rs"_s)->get(key)) vals.push_back(r->get(u"rs_pct"_s)->n);
            if (vals.empty()) continue;
            double beats = 0;
            for (double v : vals)
                if (v > 0) beats += 1;
            entry.get(u"rs"_s)->set(key, js::object({{u"median_pct"_s, js::N(util::pyRound(*median(vals), 2))}, {u"beats"_s, js::N(beats)}, {u"total"_s, js::N(double(vals.size()))}}));
        }
        std::vector<double> scores;
        for (const OJson* m : members)
            if (m->get(u"score"_s)->type != OJson::Null) scores.push_back(m->get(u"score"_s)->n);
        if (!scores.empty()) entry.set(u"score"_s, js::N(util::pyRound(*median(scores), 2)));
        out.append(entry);
    }
    const auto score = [](const OJson& r) { const OJson* s = r.get(u"score"_s); return s->type == OJson::Null ? std::nullopt : std::optional(s->n); };
    std::stable_sort(out.begin(), out.end(), [&](const OJson& a, const OJson& b) { return byScoreThenKey(score(a), a.get(u"tag"_s)->s, score(b), b.get(u"tag"_s)->s); });
    return js::array(out);
}
}  // namespace

OJson rsStrength(const OJson& members, const OJson* benchBars, const QString& benchmark, const std::vector<double>& windows) {
    const std::vector<CleanBar> bench = clean(benchBars);
    QStringList benchTimes;
    std::vector<double> benchCloses;
    for (const CleanBar& b : bench) {
        benchTimes << b.time.left(10);
        benchCloses.push_back(b.close);
    }

    QList<OJson> rows;
    for (const OJson& member : members.items) {
        const QString symbol = js::strOr(js::propStrict(&member, u"symbol"_s), QString()).toUpper();
        QString tag = util::jsTrim(js::strOr(js::prop(&member, u"tag"_s), QString()));
        if (tag.isEmpty()) tag = untagged();
        const std::vector<CleanBar> bars = clean(js::prop(&member, u"bars"_s));
        std::vector<double> closes;
        QStringList times;
        for (const CleanBar& b : bars) {
            closes.push_back(b.close);
            times << b.time.left(10);
        }
        const OJson* err = js::prop(&member, u"error"_s);
        OJson row = js::object({
            {u"symbol"_s, js::S(symbol)},
            {u"tag"_s, js::S(tag)},
            {u"company"_s, js::S(js::strOr(js::prop(&member, u"company"_s), QString()))},
            {u"last"_s, closes.empty() ? OJson::null() : js::N(util::pyRound(closes.back(), 2))},
            {u"bars"_s, js::N(double(closes.size()))},
            {u"rs"_s, js::object()},
            {u"score"_s, OJson::null()},
            {u"rank"_s, OJson::null()},
            {u"error"_s, js::truthy(err) ? *err : OJson::null()},
        });
        std::vector<double> values;
        const double len = double(closes.size());
        for (double n : windows) {
            if (len <= n || bench.empty()) continue;
            // times[len − 1 − n]:n 不是整数时是 undefined,`串 <= undefined` 恒假,于是 b0 是 null
            const double at = len - 1 - n;
            const bool inRange = at >= 0 && at == std::floor(at);
            const auto b0 = inRange ? closeAtOrBefore(benchTimes, benchCloses, times[qsizetype(at)]) : std::nullopt;
            const auto b1 = closeAtOrBefore(benchTimes, benchCloses, times.last());
            const double c0 = inRange ? closes[size_t(at)] : std::nan("");
            if (!b0 || *b0 == 0 || std::isnan(*b0) || !b1 || *b1 == 0 || std::isnan(*b1) || c0 <= 0) continue;
            const double ret = closes.back() / c0 - 1.0;
            const double benchRet = *b1 / *b0 - 1.0;
            const double rs = (1.0 + ret) / (1.0 + benchRet) - 1.0;
            row.get(u"rs"_s)->set(n2s(n), js::object({
                {u"ret_pct"_s, js::N(util::pyRound(ret * 100.0, 2))},
                {u"bench_pct"_s, js::N(util::pyRound(benchRet * 100.0, 2))},
                {u"rs_pct"_s, js::N(util::pyRound(rs * 100.0, 2))},
                {u"beats"_s, js::B(rs > 0)},
            }));
            values.push_back(rs);
        }
        if (!values.empty()) {
            double sum = 0;
            for (double v : values) sum += v;
            row.set(u"score"_s, js::N(util::pyRound((sum / double(values.size())) * 100.0, 2)));
        }
        rows.append(row);
    }

    const auto score = [](const OJson& r) { const OJson* s = r.get(u"score"_s); return s->type == OJson::Null ? std::nullopt : std::optional(s->n); };
    std::stable_sort(rows.begin(), rows.end(), [&](const OJson& a, const OJson& b) { return byScoreThenKey(score(a), a.get(u"symbol"_s)->s, score(b), b.get(u"symbol"_s)->s); });
    double rank = 0;
    for (OJson& row : rows) {
        if (row.get(u"score"_s)->type != OJson::Null) {
            rank += 1;
            row.set(u"rank"_s, js::N(rank));
        }
    }

    static const QList<QPair<double, QString>> labels{{5, u"1周"_s}, {20, u"1月"_s}, {60, u"1季"_s}, {120, u"半年"_s}, {250, u"1年"_s}};
    OJson ws = js::array();
    for (double n : windows) {
        QString label = n2s(n) + u"日"_s;
        for (const auto& [k, l] : labels)
            if (k == n) label = l;
        ws.items.append(js::object({{u"n"_s, js::N(n)}, {u"label"_s, js::S(label)}}));
    }
    return js::object({
        {u"benchmark"_s, js::S(benchmark)},
        {u"windows"_s, ws},
        {u"rows"_s, js::array(rows)},
        {u"tags"_s, rsByTag(rows, windows)},
        {u"counted"_s, js::N(rank)},
        {u"total"_s, js::N(double(rows.size()))},
        {u"bench_bars"_s, js::N(double(bench.size()))},
        {u"bench_last"_s, benchCloses.empty() ? OJson::null() : js::N(util::pyRound(benchCloses.back(), 2))},
    });
}

// ================================================================ 拐点筛选:CD 背离
namespace {
bt::Series dif(const std::vector<double>& closes) {
    const bt::Series e12 = bt::ema(closes, 12), e26 = bt::ema(closes, 26);
    bt::Series out(closes.size());
    for (size_t i = 0; i < closes.size(); ++i)
        if (e12[i] && e26[i]) out[i] = *e12[i] - *e26[i];
    return out;
}

/// 摆动点下标:左右各 strength 根里没有更极端的价格(左侧允许打平,右侧要求严格)
std::vector<qsizetype> pivots(const std::vector<double>& values, double strength, bool low) {
    std::vector<qsizetype> out;
    const double n = double(values.size());
    for (double i = strength; i < n - strength; ++i) {
        const double v = values[size_t(i)];
        bool ok = true;
        for (double j = i - strength; j <= i + strength; ++j) {
            if (j == i) continue;
            const double other = values[size_t(j)];
            if (low) {
                if (other < v || (j > i && other == v)) {
                    ok = false;
                    break;
                }
            } else if (other > v || (j > i && other == v)) {
                ok = false;
                break;
            }
        }
        if (ok) out.push_back(qsizetype(i));
    }
    return out;
}

struct Pair {
    qsizetype p1, p2;
};
std::optional<Pair> divergence(const std::vector<double>& prices, const bt::Series& difs, const std::vector<qsizetype>& piv, bool bull, double maxSpan, double maxAge) {
    if (piv.size() < 2) return std::nullopt;
    const qsizetype last = qsizetype(prices.size()) - 1;
    const qsizetype p2 = piv.back();
    if (double(last - p2) > maxAge || !difs[size_t(p2)]) return std::nullopt;
    for (qsizetype k = qsizetype(piv.size()) - 2; k >= 0; --k) {
        const qsizetype p1 = piv[size_t(k)];
        if (double(p2 - p1) > maxSpan) break;
        const auto d1o = difs[size_t(p1)];
        const double d2 = *difs[size_t(p2)];
        if (!d1o) continue;
        const double d1 = *d1o;
        const bool hit = bull ? prices[size_t(p2)] < prices[size_t(p1)] && d2 > d1 && d1 < 0 && d2 < 0
                              : prices[size_t(p2)] > prices[size_t(p1)] && d2 < d1 && d1 > 0 && d2 > 0;
        if (hit) return Pair{p1, p2};
    }
    return std::nullopt;
}

struct Confirm {
    double ma;
    QString status;
    std::optional<qsizetype> at;
    std::optional<double> age;
};
Confirm confirmation(const std::vector<double>& closes, const bt::Series& ma, qsizetype p2, bool bull, double period) {
    const auto lastMa = ma.empty() ? std::nullopt : ma.back();
    if (!lastMa) return {period, u"n/a"_s, std::nullopt, std::nullopt};
    std::optional<qsizetype> crossed;
    for (qsizetype i = p2 + 1; i < qsizetype(closes.size()); ++i) {
        const auto prevMa = ma[size_t(i - 1)], curMa = ma[size_t(i)];
        if (!prevMa || !curMa) continue;
        if (bull && closes[size_t(i - 1)] <= *prevMa && closes[size_t(i)] > *curMa) crossed = i;
        else if (!bull && closes[size_t(i - 1)] >= *prevMa && closes[size_t(i)] < *curMa) crossed = i;
    }
    const double lastClose = closes.back();
    const bool holding = bull ? lastClose > *lastMa : lastClose < *lastMa;
    QString status;
    if (crossed && holding) status = u"confirmed"_s;
    else if (crossed) status = u"failed"_s;
    else status = u"waiting"_s;
    return {period, status, crossed, crossed ? std::optional(double(qsizetype(closes.size()) - 1 - *crossed)) : std::nullopt};
}
}  // namespace

OJson cdDivergence(const OJson* bars, std::optional<double> maPeriod, double strength, double maxSpan, double maxAge) {
    const std::vector<CleanBar> rows = clean(bars);
    std::vector<double> closes;
    for (const CleanBar& b : rows) closes.push_back(b.close);
    OJson out = js::object({
        {u"signal"_s, OJson::null()},
        {u"label"_s, js::S(u"无"_s)},
        {u"bars"_s, js::N(double(rows.size()))},
        {u"last"_s, closes.empty() ? OJson::null() : js::N(util::pyRound(closes.back(), 4))},
        {u"dif_last"_s, OJson::null()},
        {u"dif_side"_s, OJson::null()},
        {u"pivots"_s, js::array()},
        {u"age"_s, OJson::null()},
        {u"price_gap_pct"_s, OJson::null()},
        {u"dif_gap"_s, OJson::null()},
        {u"confirm"_s, OJson::null()},
        {u"reason"_s, OJson::null()},
    });
    if (double(rows.size()) < kMinCdBars) {
        out.set(u"reason"_s, js::S(u"K 线不足 %1 根,算不出 DIF 摆动点"_s.arg(n2s(kMinCdBars))));
        return out;
    }
    const bt::Series difs = dif(closes);
    const auto difLast = difs.back();
    out.set(u"dif_last"_s, difLast ? js::N(util::pyRound(*difLast, 4)) : OJson::null());
    if (difLast) out.set(u"dif_side"_s, js::S(*difLast > 0 ? u"above"_s : *difLast < 0 ? u"below"_s : u"zero"_s));

    std::vector<double> lows, highs;
    for (const CleanBar& b : rows) {
        lows.push_back(b.low);
        highs.push_back(b.high);
    }
    const auto bull = divergence(lows, difs, pivots(lows, strength, true), true, maxSpan, maxAge);
    const auto bear = divergence(highs, difs, pivots(highs, strength, false), false, maxSpan, maxAge);
    const qsizetype last = qsizetype(rows.size()) - 1;
    std::optional<Pair> pick;
    bool isBull = false;
    if (bull && bear) {
        isBull = last - bull->p2 <= last - bear->p2;
        pick = isBull ? bull : bear;
    } else if (bull) {
        pick = bull;
        isBull = true;
    } else if (bear) {
        pick = bear;
        isBull = false;
    }
    if (!pick) {
        out.set(u"reason"_s, js::S(u"最近 %1 根内没有新的背离摆动点"_s.arg(n2s(maxAge))));
        return out;
    }

    const std::vector<double>& prices = isBull ? lows : highs;
    const auto [p1, p2] = *pick;
    out.set(u"signal"_s, js::S(isBull ? u"bull"_s : u"bear"_s));
    out.set(u"label"_s, js::S(isBull ? u"底背离"_s : u"顶背离"_s));
    OJson pv = js::array();
    for (qsizetype p : {p1, p2}) {
        pv.items.append(js::object({{u"index"_s, js::N(double(p))}, {u"time"_s, js::S(rows[size_t(p)].time)},
                                    {u"price"_s, js::N(util::pyRound(prices[size_t(p)], 4))}, {u"dif"_s, js::N(util::pyRound(*difs[size_t(p)], 4))}}));
    }
    out.set(u"pivots"_s, pv);
    out.set(u"age"_s, js::N(double(last - p2)));
    out.set(u"price_gap_pct"_s, js::N(util::pyRound((prices[size_t(p2)] / prices[size_t(p1)] - 1.0) * 100.0, 2)));
    out.set(u"dif_gap"_s, js::N(util::pyRound(*difs[size_t(p2)] - *difs[size_t(p1)], 4)));
    if (maPeriod && *maPeriod != 0 && !std::isnan(*maPeriod)) {
        const double period = std::trunc(*maPeriod);
        const bt::Series ma = bt::sma(closes, period);
        const Confirm c = confirmation(closes, ma, p2, isBull, period);
        out.set(u"confirm"_s, js::object({{u"ma"_s, js::N(c.ma)}, {u"status"_s, js::S(c.status)},
                                          {u"at"_s, c.at ? js::S(rows[size_t(*c.at)].time) : OJson::null()}, {u"age"_s, optN(c.age)}}));
    }
    return out;
}

OJson screenInflections(const OJson& members, const QStringList& timeframes, std::optional<double> maPeriod, double strength) {
    QList<OJson> rows;
    OJson perTf = js::object();
    for (const QString& tf : timeframes) perTf.set(tf, js::object({{u"bull"_s, js::N(0)}, {u"bear"_s, js::N(0)}, {u"confirmed"_s, js::N(0)}}));
    const auto bump = [&](const QString& tf, const QString& key) {
        OJson* o = perTf.get(tf);
        o->set(key, js::N(o->get(key)->n + 1));
    };
    for (const OJson& member : members.items) {
        const OJson* framesV = js::propStrict(&member, u"frames"_s);
        const OJson* errorsV = js::prop(&member, u"errors"_s);
        QString tag = util::jsTrim(js::strOr(js::prop(&member, u"tag"_s), QString()));
        if (tag.isEmpty()) tag = untagged();
        OJson row = js::object({
            {u"symbol"_s, js::S(js::strOr(js::prop(&member, u"symbol"_s), QString()).toUpper())},
            {u"tag"_s, js::S(tag)},
            {u"company"_s, js::S(js::strOr(js::prop(&member, u"company"_s), QString()))},
            {u"signals"_s, js::object()},
            {u"hits"_s, js::N(0)},
            {u"confirmed"_s, js::N(0)},
        });
        for (const QString& tf : timeframes) {
            // tf in errors && errors[tf](errors ?? {} 是对象)
            const OJson* e = js::isObj(errorsV) ? errorsV->get(tf) : nullptr;
            if (e && js::truthy(e)) {
                row.get(u"signals"_s)->set(tf, js::object({{u"error"_s, js::S(js::str(e))}}));
                continue;
            }
            const OJson* frame = js::nullish(framesV) ? nullptr : js::prop(framesV, tf);
            const OJson result = cdDivergence(frame, maPeriod, strength);
            row.get(u"signals"_s)->set(tf, result);
            const OJson* sig = result.get(u"signal"_s);
            if (js::truthy(sig)) {
                row.set(u"hits"_s, js::N(row.get(u"hits"_s)->n + 1));
                bump(tf, sig->s);
                const OJson* confirm = result.get(u"confirm"_s);
                if (js::truthy(confirm) && confirm->get(u"status"_s)->s == u"confirmed") {
                    row.set(u"confirmed"_s, js::N(row.get(u"confirmed"_s)->n + 1));
                    bump(tf, u"confirmed"_s);
                }
            }
        }
        rows.append(row);
    }
    std::stable_sort(rows.begin(), rows.end(), [](const OJson& a, const OJson& b) {
        const double ha = a.get(u"hits"_s)->n, hb = b.get(u"hits"_s)->n;
        if (ha != hb) return hb - ha < 0;
        const double ca = a.get(u"confirmed"_s)->n, cb = b.get(u"confirmed"_s)->n;
        if (ca != cb) return cb - ca < 0;
        return a.get(u"symbol"_s)->s < b.get(u"symbol"_s)->s;
    });
    double hitCount = 0;
    for (const OJson& r : rows)
        if (r.get(u"hits"_s)->n != 0) hitCount += 1;
    return js::object({
        {u"timeframes"_s, js::strings(timeframes)},
        {u"ma_period"_s, maPeriod && *maPeriod != 0 && !std::isnan(*maPeriod) ? js::N(std::trunc(*maPeriod)) : OJson::null()},
        {u"rows"_s, js::array(rows)},
        {u"per_timeframe"_s, perTf},
        {u"hit_count"_s, js::N(hitCount)},
        {u"total"_s, js::N(double(rows.size()))},
    });
}

// ================================================================ 极值偏离
namespace {
std::optional<double> stdev(const std::vector<double>& values) {
    const double n = double(values.size());
    if (n < 2) return std::nullopt;
    double sum = 0;
    for (double v : values) sum += v;
    const double mean = sum / n;
    double acc = 0;
    for (double v : values) acc += jm::pow(v - mean, 2);
    return std::sqrt(acc / (n - 1));
}

QStringList devReadout(const OJson& result, const OJson& series, double zExtreme) {
    const OJson& last = *result.get(u"last"_s);
    const auto opt = [&](const char16_t* k) { const OJson* v = last.get(QString::fromUtf16(k)); return v->type == OJson::Null ? std::nullopt : std::optional(v->n); };
    QStringList lines;
    const auto dev = opt(u"dev_pct"), z = opt(u"z"), pressure = opt(u"pressure");
    if (dev) {
        const QString side = *dev >= 0 ? u"上方"_s : u"下方"_s;
        QString line = u"收盘在 %1 周期均线%2 %3%"_s.arg(n2s(result.get(u"period"_s)->n), side, util::fmtF(std::abs(*dev), 2));
        if (z) line += u",折近 %1 根历史 z = %2(分位 %3%)"_s.arg(n2s(result.get(u"lookback"_s)->n), util::fmtSF(*z, 2), util::fmtF(last.get(u"rank_pct"_s)->n, 0));
        lines << line + u"。"_s;
    }
    if (pressure) {
        const QString tone = *pressure > 0.3 ? u"买压占优"_s : *pressure < -0.3 ? u"卖压占优"_s : u"买卖压力接近均衡"_s;
        lines << u"修正版买卖压力 %1(%2),最近一根收盘位于真实区间 %3% 处。"_s.arg(util::fmtSF(*pressure, 3), tone, util::fmtF(last.get(u"buy_pct"_s)->n, 0));
    }
    const OJson* extreme = result.get(u"extreme"_s);
    if (extreme->type == OJson::String && extreme->s == u"overbought") {
        lines << u"偏离已到上方极值:z ≥ %1,历史上这种拉伸幅度很少见。"_s.arg(util::fmtF(zExtreme, 1));
        if (pressure && *pressure < 0) lines << u"拉得很高但买压转负——推升的力量在减弱,注意衰竭。"_s;
    } else if (extreme->type == OJson::String && extreme->s == u"oversold") {
        lines << u"偏离已到下方极值:z ≤ -%1,历史上这种下杀幅度很少见。"_s.arg(util::fmtF(zExtreme, 1));
        if (pressure && *pressure > 0) lines << u"跌得很深但买压转正——抛压在衰竭,拐点常在这种位置出现。"_s;
    }
    const OJson* window = result.get(u"window"_s);
    if (js::truthy(window)) {
        const OJson& mx = *window->get(u"dev_max"_s);
        const OJson& mn = *window->get(u"dev_min"_s);
        lines << u"本段(%1 根)偏离最大 %2%(%3),"_s.arg(QString::number(series.items.size()), util::fmtSF(mx.get(u"dev_pct"_s)->n, 2), js::str(mx.get(u"time"_s))) +
                     u"最小 %1%(%2)。"_s.arg(util::fmtSF(mn.get(u"dev_pct"_s)->n, 2), js::str(mn.get(u"time"_s)));
    }
    return lines;
}
}  // namespace

OJson deviationReview(const OJson* bars, double period, double lookback, double smooth, double zExtreme, double keep) {
    const std::vector<CleanBar> rows = clean(bars);
    const double n = double(rows.size());
    period = jm::max(2, std::trunc(period));
    lookback = jm::max(kMinZSamples, std::trunc(lookback));
    smooth = jm::max(1, std::trunc(smooth));
    OJson out = js::object({
        {u"period"_s, js::N(period)},
        {u"lookback"_s, js::N(lookback)},
        {u"smooth"_s, js::N(smooth)},
        {u"z_extreme"_s, js::N(zExtreme)},
        {u"bars"_s, js::N(n)},
        {u"series"_s, js::array()},
        {u"last"_s, OJson::null()},
        {u"extreme"_s, OJson::null()},
        {u"extreme_label"_s, js::S(u"—"_s)},
        {u"window"_s, OJson::null()},
        {u"readout"_s, js::array()},
    });
    if (n < period + 2) {
        out.set(u"readout"_s, js::strings({u"K 线不足 %1 根,算不出 %2 周期均线"_s.arg(n2s(period + 2), n2s(period))}));
        return out;
    }

    std::vector<double> closes, volumes;
    for (const CleanBar& b : rows) {
        closes.push_back(b.close);
        volumes.push_back(b.volume);
    }
    std::vector<double> raw;
    bt::Series ratios;
    const bt::Series volMa = bt::sma(volumes, 20);
    for (size_t i = 0; i < rows.size(); ++i) {
        const CleanBar& bar = rows[i];
        const double prevClose = i > 0 ? closes[i - 1] : bar.open;
        const double hi = jm::max(bar.high, prevClose), lo = jm::min(bar.low, prevClose);
        const double rng = hi - lo;
        const double position = rng > 0 ? ((bar.close - lo) / rng) * 2.0 - 1.0 : 0.0;
        const auto base = i > 0 ? volMa[i - 1] : std::nullopt;
        const std::optional<double> ratio = base && *base > 0 ? std::optional(bar.volume / *base) : std::nullopt;
        const double weight = ratio ? jm::min(*ratio, kVolumeWeightCap) : 1.0;
        raw.push_back(position * weight);
        ratios.push_back(ratio);
    }
    bt::Series pressure;
    if (smooth > 1) pressure = bt::ema(raw, smooth);
    else
        for (double r : raw) pressure.emplace_back(r);

    const bt::Series ma = bt::sma(closes, period);
    bt::Series dev(rows.size());
    for (size_t i = 0; i < rows.size(); ++i)
        if (ma[i] && *ma[i] > 0) dev[i] = (closes[i] / *ma[i] - 1.0) * 100.0;

    const double start = jm::max(0, n - std::trunc(keep));
    OJson series = js::array();
    for (double di = start; di < n; ++di) {
        const size_t i = size_t(di);
        std::optional<double> z, rank;
        if (const auto d = dev[i]) {
            // dev.slice(max(0, i − lookback + 1), i + 1):NaN 的起点按 0
            double from = jm::max(0, di - lookback + 1);
            if (std::isnan(from)) from = 0;
            std::vector<double> hist;
            for (size_t k = size_t(from); k <= i; ++k)
                if (dev[k]) hist.push_back(*dev[k]);
            if (double(hist.size()) >= kMinZSamples) {
                const auto sd = stdev(hist);
                double sum = 0;
                for (double v : hist) sum += v;
                const double mean = sum / double(hist.size());
                if (sd && *sd != 0 && !std::isnan(*sd) && *sd > 0) z = (*d - mean) / *sd;
                double le = 0;
                for (double v : hist)
                    if (v <= *d) le += 1;
                rank = (le / double(hist.size())) * 100.0;
            }
        }
        const CleanBar& bar = rows[i];
        const double prevClose = i > 0 ? closes[i - 1] : bar.open;
        const double hi = jm::max(bar.high, prevClose), lo = jm::min(bar.low, prevClose);
        const double buyPct = hi > lo ? ((bar.close - lo) / (hi - lo)) * 100.0 : 50.0;
        series.items.append(js::object({
            {u"time"_s, js::S(bar.time)},
            {u"close"_s, js::N(util::pyRound(bar.close, 4))},
            {u"ma"_s, ma[i] ? js::N(util::pyRound(*ma[i], 4)) : OJson::null()},
            {u"dev_pct"_s, dev[i] ? js::N(util::pyRound(*dev[i], 2)) : OJson::null()},
            {u"z"_s, z ? js::N(util::pyRound(*z, 2)) : OJson::null()},
            {u"rank_pct"_s, rank ? js::N(util::pyRound(*rank, 1)) : OJson::null()},
            {u"pressure"_s, i < pressure.size() && pressure[i] ? js::N(util::pyRound(*pressure[i], 3)) : OJson::null()},
            {u"buy_pct"_s, js::N(util::pyRound(buyPct, 1))},
            {u"volume_ratio"_s, ratios[i] ? js::N(util::pyRound(*ratios[i], 2)) : OJson::null()},
        }));
    }
    out.set(u"series"_s, series);
    if (series.items.isEmpty()) throw util::JsError(u"Cannot read properties of undefined (reading 'z')"_s);  // out.last = undefined,last["z"]
    const OJson last = series.items.last();
    out.set(u"last"_s, last);

    const OJson* lz = last.get(u"z"_s);
    if (lz->type != OJson::Null) {
        if (lz->n >= zExtreme) {
            out.set(u"extreme"_s, js::S(u"overbought"_s));
            out.set(u"extreme_label"_s, js::S(u"上方极值(超买)"_s));
        } else if (lz->n <= -zExtreme) {
            out.set(u"extreme"_s, js::S(u"oversold"_s));
            out.set(u"extreme_label"_s, js::S(u"下方极值(超卖)"_s));
        } else {
            out.set(u"extreme_label"_s, js::S(u"偏离在常态区间"_s));
        }
    } else {
        out.set(u"extreme_label"_s, js::S(u"历史不足,未折 z 分数"_s));
    }

    QList<const OJson*> withDev, withPressure;
    for (const OJson& s : series.items) {
        if (s.get(u"dev_pct"_s)->type != OJson::Null) withDev << &s;
        if (s.get(u"pressure"_s)->type != OJson::Null) withPressure << &s;
    }
    if (!withDev.isEmpty() && !withPressure.isEmpty()) {
        const auto pickBy = [](const QList<const OJson*>& list, const QString& key, bool wantMax) {
            const OJson* best = list[0];
            for (const OJson* s : list) {
                const double v = s->get(key)->n, b = best->get(key)->n;
                if (wantMax ? v > b : v < b) best = s;
            }
            return best;
        };
        const OJson* devMax = pickBy(withDev, u"dev_pct"_s, true);
        const OJson* devMin = pickBy(withDev, u"dev_pct"_s, false);
        const OJson* prMax = pickBy(withPressure, u"pressure"_s, true);
        const OJson* prMin = pickBy(withPressure, u"pressure"_s, false);
        const auto pt = [](const OJson* s, const QString& key) { return js::object({{u"time"_s, *s->get(u"time"_s)}, {key, *s->get(key)}}); };
        out.set(u"window"_s, js::object({{u"dev_max"_s, pt(devMax, u"dev_pct"_s)}, {u"dev_min"_s, pt(devMin, u"dev_pct"_s)},
                                         {u"pressure_max"_s, pt(prMax, u"pressure"_s)}, {u"pressure_min"_s, pt(prMin, u"pressure"_s)}}));
    }
    out.set(u"readout"_s, js::strings(devReadout(out, series, zExtreme)));
    return out;
}

}  // namespace ibkr::analysis::screener
