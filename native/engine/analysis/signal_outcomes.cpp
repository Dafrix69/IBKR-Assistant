#include "analysis/signal_outcomes.h"

#include "domain/positions.h"
#include "util/collate.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/market_calendar.h"
#include "util/market_js.h"
#include "util/py.h"
#include "util/tz.h"

#include <QHash>
#include <QStringList>

#include <algorithm>

#include <cmath>
#include <limits>
#include <map>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;
namespace mk = ibkr::util::market;

namespace ibkr::analysis::signal_outcomes {

namespace {
constexpr double kInf = std::numeric_limits<double>::infinity();
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kRegularClose = 16 * 3600;
constexpr double kEarlyClose = 13 * 3600;
QString et() { return QString::fromUtf16(util::kET); }
QString n2s(double v) { return util::jsNumberToString(v); }
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }

const QSet<QString>& builtinEarly() {
    static const QSet<QString> s = [] {
        QSet<QString> out;
        for (const QString& d : util::builtinCalendar().earlyCloses) out.insert(d);
        return out;
    }();
    return s;
}
const QSet<QString>& earlyCloseSet(EarlyCloses given) { return given ? *given : builtinEarly(); }

/// 对象字面量里 `k: e.k`:undefined 的键 JSON 里没有
void copyKey(OJson& out, const QString& key, const OJson* v) {
    if (v) out.set(key, *v);
}
bool isStrEq(const OJson* v, QStringView s) { return js::isStr(v) && v->s == s; }
bool isNull(const OJson* v) { return v && v->type == OJson::Null; }

/// 'YYYY-MM-DD'.split("-").map(Number)
util::WallParts dayParts(const QString& date, double hour) {
    const QStringList parts = date.split(u'-');
    const auto part = [&](int i) { return i < parts.size() ? util::jsStringToNumber(parts[i]) : kNaN; };
    return {part(0), part(1), part(2), hour, 0, 0};
}
}  // namespace

const QList<std::pair<QString, QString>>& sourceLabels() {
    static const QList<std::pair<QString, QString>> s{
        {u"cross"_s, u"价位穿越(押顺势)"_s},       {u"touch"_s, u"反复碰均线(押反弹)"_s},  {u"spike"_s, u"急涨急跌(押顺势)"_s},
        {u"day_move"_s, u"大涨大跌(押顺势)"_s},    {u"rvol"_s, u"全天放量(只看波动)"_s},    {u"burst"_s, u"窗口放量(只看波动)"_s},
        {u"leaders"_s, u"强势股新入选(押涨)"_s}, {u"pa"_s, u"K线 PA(押读出的方向)"_s},
    };
    return s;
}

namespace {
QString labelOf(const QString& source) {
    for (const auto& [k, v] : sourceLabels())
        if (k == source) return v;
    return u"undefined"_s;
}
}  // namespace

// ---------------------------------------------------------------- 事件 → 信号
OJson signalFromWatchEvent(const OJson& e) {
    const bool touch = isStrEq(e.get(u"trigger"_s), u"touch");
    OJson out = js::object({{u"at"_s, js::S(util::isoString(js::num(e.get(u"at"_s)) * 1000))}, {u"source"_s, js::S(touch ? u"touch"_s : u"cross"_s)}});
    copyKey(out, u"symbol"_s, e.get(u"symbol"_s));
    if (touch) out.set(u"expect"_s, js::S(isStrEq(e.get(u"direction"_s), u"down") ? u"up"_s : u"down"_s));
    else copyKey(out, u"expect"_s, e.get(u"direction"_s));
    const OJson* to = e.get(u"to"_s);
    out.set(u"price"_s, js::isNum(to) && std::isfinite(to->n) ? *to : OJson::null());
    copyKey(out, u"label"_s, e.get(u"label"_s));
    return out;
}

OJson signalFromAnomaly(const OJson& e) {
    const OJson* kind = e.get(u"kind"_s);
    const bool directional = isStrEq(kind, u"spike") || isStrEq(kind, u"day_move");
    OJson out = js::object({{u"at"_s, js::S(util::isoString(js::num(e.get(u"at"_s)) * 1000))}});
    copyKey(out, u"source"_s, kind);
    copyKey(out, u"symbol"_s, e.get(u"symbol"_s));
    if (directional) copyKey(out, u"expect"_s, e.get(u"direction"_s));
    else out.set(u"expect"_s, OJson::null());
    copyKey(out, u"price"_s, e.get(u"price"_s));
    copyKey(out, u"label"_s, e.get(u"title"_s));
    return out;
}

OJson signalFromLeader(const OJson& row, double atMs) {
    OJson out = js::object({{u"at"_s, js::S(util::isoString(atMs))}, {u"source"_s, js::S(u"leaders"_s)}});
    copyKey(out, u"symbol"_s, row.get(u"symbol"_s));
    out.set(u"expect"_s, js::S(u"up"_s));
    copyKey(out, u"price"_s, row.get(u"close"_s));
    copyKey(out, u"label"_s, row.get(u"verdict"_s));
    return out;
}

OJson signalFromPa(const OJson& pa, double atMs) {
    const QString bias = js::str(pa.get(u"bias"_s));
    const QString expect = bias.contains(u"bull"_s) ? u"up"_s : bias.contains(u"bear"_s) ? u"down"_s : QString();
    if (expect.isEmpty()) return OJson::null();
    OJson out = js::object({{u"at"_s, js::S(util::isoString(atMs))}, {u"source"_s, js::S(u"pa"_s)}});
    copyKey(out, u"symbol"_s, pa.get(u"symbol"_s));
    out.set(u"expect"_s, js::S(expect));
    const OJson* last = pa.get(u"last"_s);
    out.set(u"price"_s, js::isNum(last) && std::isfinite(last->n) ? *last : OJson::null());
    out.set(u"label"_s, js::S(u"%1 %2(%3)"_s.arg(js::str(pa.get(u"timeframe_label"_s)), js::str(pa.get(u"bias_label"_s)), js::str(pa.get(u"score"_s)))));
    copyKey(out, u"variant"_s, pa.get(u"timeframe"_s));
    return out;
}

QString etDayStart(const QString& date) { return util::isoString(util::wallToEpoch(dayParts(date, 0), et())); }

double closeEpoch(const QString& date, EarlyCloses earlyCloses) {
    const double seconds = earlyCloseSet(earlyCloses).contains(date) ? kEarlyClose : kRegularClose;
    return util::wallToEpoch(dayParts(date, seconds / 3600), et());
}

QString entrySessionStart(double nowMs, const std::function<bool(const QString&)>& isTradingDay, EarlyCloses earlyCloses) {
    double ordinal = util::dateOrdinal(util::dateStrAt(nowMs, et()));
    for (int back = 0; back < 15; back += 1, ordinal -= 1) {
        const QString date = util::ordinalToDate(ordinal);
        if (!isTradingDay(date)) continue;
        const double close = closeEpoch(date, earlyCloses);
        if (close <= nowMs) return util::isoString(close);
    }
    return etDayStart(util::ordinalToDate(ordinal));
}

// ---------------------------------------------------------------- 一条信号的收益与基线
double entryIndex(const std::vector<DailyClose>& bars, double atMs, EarlyCloses earlyCloses) {
    if (bars.empty() || !std::isfinite(atMs)) return -1;
    const util::WallParts p = util::wallParts(atMs, et());
    const QString date = util::dateStrAt(atMs, et());
    if (bars.front().date > date) return -1;
    long long lo = 0, hi = (long long)bars.size();
    while (lo < hi) {
        const long long mid = (lo + hi) >> 1;
        if (bars[size_t(mid)].date < date) lo = mid + 1;
        else hi = mid;
    }
    const double close = earlyCloseSet(earlyCloses).contains(date) ? kEarlyClose : kRegularClose;
    if (lo < (long long)bars.size() && bars[size_t(lo)].date == date && p.hour * 3600 + p.minute * 60 + p.second >= close) lo += 1;
    return lo < (long long)bars.size() ? double(lo) : -1;
}

namespace {
const DailyClose* barAt(const std::vector<DailyClose>& bars, double i) {
    if (!(i >= 0) || i != std::floor(i) || i >= double(bars.size())) return nullptr;
    return &bars[size_t(i)];
}
}  // namespace

std::vector<std::optional<double>> signalReturns(const OJson& signal, const std::vector<DailyClose>& bars, EarlyCloses earlyCloses) {
    const double entry = entryIndex(bars, util::jsDateParse(js::str(signal.get(u"at"_s))), earlyCloses);
    const DailyClose* refBar = barAt(bars, entry);
    std::vector<std::optional<double>> out;
    if (!refBar || !(refBar->close > 0)) return std::vector<std::optional<double>>(3);
    const double ref = refBar->close;
    const OJson* expect = signal.get(u"expect"_s);
    for (int k : kHorizons) {
        const DailyClose* bar = barAt(bars, entry + k);
        if (!bar) {
            out.push_back(std::nullopt);
            continue;
        }
        const double raw = (bar->close / ref - 1) * 100;
        out.push_back(util::pyRound(isStrEq(expect, u"down") ? -raw : isStrEq(expect, u"up") ? raw : std::fabs(raw), 4));
    }
    return out;
}

std::optional<double> baselineReturn(const std::vector<DailyClose>& bars, double entry, double k, bool abs) {
    const double first = entry - k - kBaselineBars;
    if (first < 0 || entry > double(bars.size())) return std::nullopt;
    double acc = 0;
    for (double i = first; i < entry - k; i += 1) {
        const DailyClose* a = barAt(bars, i + k);
        const DailyClose* b = barAt(bars, i);
        const double r = ((a ? a->close : kNaN) / (b ? b->close : kNaN) - 1) * 100;
        acc += abs ? std::fabs(r) : r;
    }
    return std::isfinite(acc) ? std::optional(acc / kBaselineBars) : std::nullopt;
}

// ---------------------------------------------------------------- 统计
namespace {
std::optional<double> median(std::vector<double> xs) {
    if (xs.empty()) return std::nullopt;
    mk::sortNumbers(xs);
    const size_t m = xs.size() / 2;
    return xs.size() % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}
std::optional<double> mean(const std::vector<double>& xs) {
    if (xs.empty()) return std::nullopt;
    double s = 0;
    for (double x : xs) s = s + x;
    return s / double(xs.size());
}
std::optional<double> round(const std::optional<double>& v, int d = 2) {
    if (!v) return std::nullopt;
    const double r = util::pyRound(*v, d);
    return r == 0 ? 0 : r;  // 负零不往外给
}

struct ByDay {
    std::vector<double> days, means;
};
/// 同一个进场日的并成一条(那天的平均),从早到晚
ByDay byEntryDay(const std::vector<double>& days, const std::vector<double>& values) {
    std::map<double, std::pair<double, double>> acc;  // 次序不外露:输出按日子排
    for (size_t i = 0; i < days.size(); ++i) {
        auto& cell = acc[days[i]];
        cell.first += i < values.size() ? values[i] : 0;
        cell.second += 1;
    }
    ByDay out;
    for (const auto& [day, cell] : acc) {
        out.days.push_back(day);
        out.means.push_back(cell.first / cell.second);
    }
    return out;
}

std::vector<double> blockMeans(const std::vector<double>& values, const std::vector<double>& blocks, double count) {
    std::vector<double> sum(size_t(count), 0), size(size_t(count), 0);
    for (size_t i = 0; i < blocks.size(); ++i) {
        const size_t b = size_t(blocks[i]);
        sum[b] = sum[b] + (i < values.size() ? values[i] : 0);
        size[b] = size[b] + 1;
    }
    std::vector<double> out;
    for (size_t b = 0; b < sum.size(); ++b) out.push_back(sum[b] / jm::max(size[b], 1));
    return out;
}

/// 标准正态的上尾概率 P(Z > x)
double upperTail(double x) { return 0.5 * (1 - jm::stdlibErf(x / M_SQRT2)); }

/// Student-t 的 P(|T| ≤ x),自由度是正整数(Abramowitz–Stegun 26.7.3 / 26.7.4 的有限和)
double tInside(double x, double df) {
    const double theta = jm::atan(x / std::sqrt(df));
    const double sin = jm::sin(theta), cos = jm::cos(theta), cos2 = cos * cos;
    if (std::fmod(df, 2) == 0) {
        double term = 1, sum = 1;
        for (double j = 1; j <= (df - 2) / 2; j += 1) {
            term *= ((2 * j - 1) / (2 * j)) * cos2;
            sum += term;
        }
        return sin * sum;
    }
    double sum = 0;
    if (df > 1) {
        double term = cos;
        sum = cos;
        for (double j = 1; j <= (df - 3) / 2; j += 1) {
            term *= ((2 * j) / (2 * j + 1)) * cos2;
            sum += term;
        }
    }
    return (2 / M_PI) * (theta + sin * sum);
}
}  // namespace

std::vector<double> windowBlocks(const std::vector<double>& sortedDays, double k) {
    std::vector<double> out;
    double anchor = -kInf, block = -1;
    for (double day : sortedDays) {
        if (day - anchor >= k) {
            anchor = day;
            block += 1;
        }
        out.push_back(block);
    }
    return out;
}

double independentWindows(const std::vector<double>& days, double k) {
    std::vector<double> uniq;
    for (double d : days) {
        bool seen = false;
        for (double u : uniq) seen = seen || u == d || (std::isnan(u) && std::isnan(d));
        if (!seen) uniq.push_back(d);
    }
    mk::sortNumbers(uniq);
    const auto blocks = windowBlocks(uniq, k);
    return blocks.empty() ? 0 : blocks.back() + 1;
}

OJson OverlapT::toJson() const {
    return js::object({{u"t"_s, optN(t)}, {u"mean"_s, optN(mean)}, {u"independent"_s, js::N(independent)}, {u"flat"_s, js::B(flat)}});
}

OverlapT overlapT(const std::vector<Observation>& obs, double k) {
    std::vector<double> d, v;
    for (const Observation& o : obs) {
        d.push_back(o.day);
        v.push_back(o.excess);
    }
    const ByDay by = byEntryDay(d, v);
    const auto& days = by.days;
    const auto& means = by.means;
    const std::vector<double> blocks = windowBlocks(days, k);
    const double independent = blocks.empty() ? 0 : blocks.back() + 1;
    if (independent == 0) return {std::nullopt, std::nullopt, independent, false};
    std::vector<double> size(size_t(independent), 0);
    for (double b : blocks) size[size_t(b)] += 1;
    std::vector<double> weight;
    for (double b : blocks) weight.push_back(1 / (independent * jm::max(size[size_t(b)], 1)));
    double m = 0;
    for (size_t i = 0; i < means.size(); ++i) m = m + weight[i] * means[i];
    bool flat = true;
    for (double x : means) flat = flat && std::fabs(x - m) <= 1e-12;
    if (flat || independent < kMinTWindows) return {std::nullopt, m, independent, flat};
    std::vector<double> z;
    for (size_t i = 0; i < means.size(); ++i) z.push_back(weight[i] * (means[i] - m));
    double s = 0;
    for (size_t a = 0, lo = 0; a < days.size(); a += 1) {
        const double day = days[a];
        // days[lo] ?? day:k ≤ 0 时这一行永远不停(TS 原样;调用方只给 1 / 5 / 20)
        while (day - (lo < days.size() ? days[lo] : day) >= k) lo += 1;
        for (size_t b = lo; b < days.size() && days[b] - day < k; b += 1) s += z[a] * z[b];
    }
    if (!(s > 0)) return {std::nullopt, m, independent, flat};
    return {util::pyRound(m / std::sqrt(s * (independent / (independent - 1))), 2), m, independent, flat};
}

double tThreshold(double m, double windows) {
    const double df = jm::max(1, std::trunc(windows) - 1);
    const double target = (2 * upperTail(kTSingle)) / jm::max(m, 1);
    double lo = 0, hi = 1e6;
    for (int i = 0; i < 100; i += 1) {
        const double mid = (lo + hi) / 2;
        if (1 - tInside(mid, df) > target) lo = mid;
        else hi = mid;
    }
    return util::pyRound((lo + hi) / 2, 2);
}

// ---------------------------------------------------------------- 成绩单
namespace {
struct Scored {
    const OJson* s = nullptr;
    std::vector<std::optional<double>> returns, bases;
    double day = -1;
};
struct Stats {
    double horizon = 0, n = 0, independent = 0;
    std::optional<double> mean_pct, median_pct, hit_rate, baseline_pct, edge_pct, t;
    OJson toJson() const {
        return js::object({{u"horizon"_s, js::N(horizon)},       {u"n"_s, js::N(n)},
                           {u"independent"_s, js::N(independent)}, {u"mean_pct"_s, optN(mean_pct)},
                           {u"median_pct"_s, optN(median_pct)},   {u"hit_rate"_s, optN(hit_rate)},
                           {u"baseline_pct"_s, optN(baseline_pct)}, {u"edge_pct"_s, optN(edge_pct)},
                           {u"t"_s, optN(t)}});
    }
};
struct Tally {
    Stats stats;
    bool flat = false;
};

Tally tally(const std::vector<const Scored*>& mine, double k, size_t hi) {
    std::vector<const Scored*> done;
    for (const Scored* x : mine)
        if (x->returns[hi] && x->bases[hi]) done.push_back(x);
    std::vector<double> entryDays, rets, bases;
    std::vector<Observation> obs;
    for (const Scored* x : done) {
        entryDays.push_back(x->day);
        rets.push_back(*x->returns[hi]);
        bases.push_back(*x->bases[hi]);
        obs.push_back({x->day, *x->returns[hi] - *x->bases[hi]});
    }
    const ByDay r = byEntryDay(entryDays, rets);
    const ByDay b = byEntryDay(entryDays, bases);
    const std::vector<double> blocks = windowBlocks(r.days, k);
    const OverlapT ot = overlapT(obs, k);
    const std::vector<double> blockRets = blockMeans(r.means, blocks, ot.independent);
    const auto m = mean(blockRets);
    const auto bm = mean(blockMeans(b.means, blocks, ot.independent));
    bool directional = false;
    for (const Scored* x : done) directional = directional || !isNull(x->s->get(u"expect"_s));
    Tally t;
    t.flat = ot.flat;
    t.stats.horizon = k;
    t.stats.n = double(done.size());
    t.stats.independent = ot.independent;
    t.stats.mean_pct = round(m);
    t.stats.median_pct = round(median(blockRets));
    if (directional && !blockRets.empty()) {
        double up = 0;
        for (double x : blockRets)
            if (x > 0) up += 1;
        t.stats.hit_rate = round((up / double(blockRets.size())) * 100, 1);
    }
    t.stats.baseline_pct = round(bm);
    t.stats.edge_pct = m && bm ? round(*m - *bm) : std::nullopt;
    t.stats.t = ot.t;
    return t;
}

/// 这一类在这个持有期上够不够下结论:互不重叠的持有期满 MIN_WINDOWS 段
bool ready(const Tally* h) { return h && h->stats.independent >= kMinWindows && h->stats.edge_pct; }

std::pair<QString, QString> verdictOf(bool directional, const Tally* h, double threshold, double judged) {
    const QString days = n2s(kVerdictHorizon);
    if (!h || !ready(h))
        return {u"互不重叠的 %1 天持有期只有 %2 段,不到 %3 段,先攒着,不下结论"_s.arg(days, n2s(h ? h->stats.independent : 0), n2s(kMinWindows)), u"info"_s};
    const double edge = h->stats.edge_pct.value_or(0);
    const auto& t = h->stats.t;
    const QString what = directional ? u"押的方向"_s : u"之后的波动"_s;
    // 每条的超额收益一模一样时没有 t,按差值的正负说
    if (h->flat) {
        if (edge > 0) return {u"%1 天后%2每条都比随手一天好 %3 个百分点"_s.arg(days, what, n2s(edge)), u"good"_s};
        if (edge < 0) return {u"%1 天后%2每条都比随手一天差 %3 个百分点"_s.arg(days, what, n2s(-edge)), u"bad"_s};
        return {u"%1 天后和随手一天一样"_s.arg(days), u"warn"_s};
    }
    if (!t) return {u"%1 天后差 %2 个百分点,但持有期叠得太多,估不出可靠的 t,不下结论"_s.arg(days, n2s(edge)), u"info"_s};
    const QString bar = judged > 1 ? u";同时判 %1 类,|t| 过 %2 才算"_s.arg(n2s(judged), n2s(threshold)) : u",|t| 过 %1 才算"_s.arg(n2s(threshold));
    if (*t >= threshold) return {u"%1 天后%2比随手一天好 %3 个百分点(t = %4%5)"_s.arg(days, what, n2s(edge), n2s(*t), bar), u"good"_s};
    if (*t <= -threshold) return {u"%1 天后%2反而比随手一天差 %3 个百分点(t = %4%5)"_s.arg(days, what, n2s(-edge), n2s(*t), bar), u"bad"_s};
    return {u"%1 天后和随手一天分不出来(差 %2 个百分点,t = %3%4)"_s.arg(days, n2s(edge), n2s(*t), bar), u"warn"_s};
}

QString groupLabel(const QString& source, const std::optional<QString>& variant) {
    if (!variant) return labelOf(source);
    QString name = *variant;
    if (source == u"pa") {
        const OJson* tf = domain::timeframes().get(*variant);
        const OJson* label = js::prop(tf, u"label"_s);
        name = js::nullish(label) ? *variant : js::str(label);
    }
    return labelOf(source) + u" · "_s + name;
}

/// 小类的先后:没有小类的在前,K线 PA 按周期从短到长,不认识的按字面排在最后
double variantOrder(const std::optional<QString>& a, const std::optional<QString>& b) {
    const QStringList frames = js::keys(&domain::timeframes());
    const auto rank = [&](const std::optional<QString>& v) -> double {
        if (!v) return -1;
        const qsizetype i = frames.indexOf(*v);
        return i >= 0 ? double(i) : double(frames.size());
    };
    if (const double d = rank(a) - rank(b); d != 0) return d;
    return double(util::localeCompare(a.value_or(QString()), b.value_or(QString())));
}

/// x.s.variant ?? null(约定是串;别的类型按 String() 读)
std::optional<QString> variantOf(const OJson& s) {
    const OJson* v = s.get(u"variant"_s);
    if (js::nullish(v)) return std::nullopt;
    return js::str(v);
}
}  // namespace

OJson scoreSignals(const QList<OJson>& entries, const std::vector<std::pair<QString, std::vector<DailyClose>>>& bars, std::optional<double> days,
                   EarlyCloses earlyCloses) {
    // 各标的共用一本交易日历(所有日线日期的并集):两条信号的持有期重不重叠,按它数
    QStringList dates;
    {
        QSet<QString> seen;
        for (const auto& [sym, series] : bars)
            for (const DailyClose& b : series)
                if (!seen.contains(b.date)) {
                    seen.insert(b.date);
                    dates << b.date;
                }
        dates.sort();
    }
    QHash<QString, double> calendar;
    for (const QString& d : dates) calendar.insert(d, double(calendar.size()));
    const auto seriesOf = [&](const QString& sym) -> const std::vector<DailyClose>* {
        for (const auto& [k, v] : bars)
            if (k == sym) return &v;
        return nullptr;
    };

    QStringList missing;
    double uncovered = 0;
    std::vector<Scored> scored;
    for (const OJson& s : entries) {
        Scored x;
        x.s = &s;
        x.returns = x.bases = std::vector<std::optional<double>>(3);
        const QString symbol = js::str(s.get(u"symbol"_s));
        const std::vector<DailyClose>* series = seriesOf(symbol);
        if (!series || series->empty()) {
            if (!missing.contains(symbol)) missing << symbol;
            scored.push_back(x);
            continue;
        }
        const double at = util::jsDateParse(js::str(s.get(u"at"_s)));
        // 比取到的第一根日线还早:不是"还没走完",是这段日线根本没覆盖到它。数出来
        if (!std::isfinite(at) || series->front().date > util::dateStrAt(at, et())) uncovered += 1;
        const double entry = entryIndex(*series, at, earlyCloses);
        if (entry < 0) {
            scored.push_back(x);
            continue;
        }
        const OJson* expect = s.get(u"expect"_s);
        const bool abs = isNull(expect);
        for (size_t i = 0; i < 3; ++i) {
            const auto b = baselineReturn(*series, entry, kHorizons[i], abs);
            x.bases[i] = !b ? std::nullopt : isStrEq(expect, u"down") ? std::optional(-*b) : b;
        }
        x.returns = signalReturns(s, *series, earlyCloses);
        x.day = calendar.value((*series)[size_t(entry)].date, -1);
        scored.push_back(x);
    }

    const size_t verdictAt = 1;  // HORIZONS.indexOf(VERDICT_HORIZON)
    struct Draft {
        QString source;
        std::optional<QString> variant;
        std::vector<const Scored*> mine;
        std::vector<Tally> tallies;
    };
    std::vector<Draft> drafts;
    for (const auto& [source, label] : sourceLabels()) {
        std::vector<const Scored*> ofSource;
        for (const Scored& x : scored)
            if (isStrEq(x.s->get(u"source"_s), source)) ofSource.push_back(&x);
        std::vector<std::optional<QString>> variants;
        for (const Scored* x : ofSource) {
            const auto v = variantOf(*x->s);
            if (std::find(variants.begin(), variants.end(), v) == variants.end()) variants.push_back(v);
        }
        mk::jsSort(variants, variantOrder);
        for (const auto& variant : variants) {
            Draft d{source, variant, {}, {}};
            for (const Scored* x : ofSource)
                if (variantOf(*x->s) == variant) d.mine.push_back(x);
            for (size_t hi = 0; hi < 3; ++hi) d.tallies.push_back(tally(d.mine, kHorizons[hi], hi));
            drafts.push_back(d);
        }
    }
    // 这一次有几类够得上下结论:类数越多,碰巧有一类过线的机会越大,门槛跟着抬;段数按其中最少的那一类算
    double judged = 0, fewest = kInf;
    for (const Draft& d : drafts)
        if (ready(&d.tallies[verdictAt])) {
            judged += 1;
            fewest = jm::min(fewest, d.tallies[verdictAt].stats.independent);
        }
    const double threshold = tThreshold(judged, std::isfinite(fewest) ? fewest : kMinWindows);
    OJson groups = js::array();
    for (const Draft& d : drafts) {
        OJson hs = js::array();
        for (const Tally& t : d.tallies) hs.items.append(t.stats.toJson());
        const auto [verdict, tone] = verdictOf(d.source != u"rvol" && d.source != u"burst", &d.tallies[verdictAt], threshold, judged);
        groups.items.append(js::object({{u"source"_s, js::S(d.source)},
                                        {u"variant"_s, d.variant ? js::S(*d.variant) : OJson::null()},
                                        {u"label"_s, js::S(groupLabel(d.source, d.variant))},
                                        {u"signals"_s, js::N(double(d.mine.size()))},
                                        {u"horizons"_s, hs},
                                        {u"verdict"_s, js::S(verdict)},
                                        {u"tone"_s, js::S(tone)}}));
    }

    double noBaseline = 0;
    for (const Scored& x : scored)
        if (x.returns[verdictAt] && !x.bases[verdictAt]) noBaseline += 1;
    const double single = tThreshold(1, kMinWindows);
    QStringList notes{
        u"收益从信号之后的第一个收盘算到那之后第 1 / 5 / 20 个交易日的收盘,按信号押的方向(押跌的,跌了是正);放量不带方向,看的是平均绝对涨跌。"_s
        u"信号发出到当天收盘那一段不算:同一天里先押涨又押跌的两条,在这个口径下正好相抵"_s,
        u"基线 = 同一只标的在信号之前 %1 个交易日里,任意一天持有同样天数的平均;只用信号发出时已经有的日线。信号要比它好才算有用"_s.arg(n2s(kBaselineBars)),
        u"每一段互不重叠的持有期一票:同一天进场的信号先并成一条(那天的平均),同一段持有期里的各天再并成一条。"_s +
            u"平均、押对、随手一天、t 都是按段算的,「走完的」只是条数;「不重叠」就是段数,满 %1 段才下结论。相邻两段的持有期有重叠时,t 按相关算"_s.arg(n2s(kMinWindows)),
        judged > 1 ? u"这次同时给 %1 类信号下结论,其中段数最少的一类有 %2 段:|t| 要过 %3(只判一类、刚满 %4 段时是 %5;类数越多、段数越少,碰巧过线的机会越大,门槛越高)。"_s.arg(
                         n2s(judged), n2s(fewest), n2s(threshold), n2s(kMinWindows), n2s(single)) +
                         u"表里 1 天、20 天两行的 t 没有做这个修正,只作参考"_s
                   : u"结论只看 %1 天那一行,|t| 要过 %2(刚满 %3 段时是 %4,段数越多越接近 %5;同时判几类还要再抬)。"_s.arg(
                         n2s(kVerdictHorizon), n2s(threshold), n2s(kMinWindows), n2s(single), n2s(kTSingle)) +
                         u"表里每一类、每个持有期各是一次检验,格子多了碰巧有一两个过线很正常,别挑着最大的那个看"_s,
        u"只陈述历史上发生了什么,不是买卖建议;信号仍然只提醒、不下单"_s,
    };
    if (uncovered) notes << u"%1 条信号比取到的日线还早(日线没取到那么久以前),算不了收益,不进成绩"_s.arg(n2s(uncovered));
    if (noBaseline) notes << u"%1 条信号之前的日线不够 %2 根(新上市,或取不到那么早),没有基线,不进成绩"_s.arg(n2s(noBaseline), n2s(kBaselineBars + kVerdictHorizon));
    if (!missing.isEmpty()) notes << u"%1 只标的取不到日线(没连券商或没有行情权限),它们的信号不进成绩"_s.arg(missing.size());

    OJson recent = js::array();
    const size_t from = scored.size() > size_t(kMaxRecent) ? scored.size() - kMaxRecent : 0;
    for (size_t i = scored.size(); i > from; --i) {
        const Scored& x = scored[i - 1];
        OJson r = js::isObj(x.s) ? *x.s : js::object();
        OJson rets = js::array();
        for (const auto& v : x.returns) rets.items.append(optN(v));
        r.set(u"returns"_s, rets);
        recent.items.append(r);
    }
    missing.sort();
    return js::object({{u"days"_s, optN(days)},
                       {u"total"_s, js::N(double(entries.size()))},
                       {u"groups"_s, groups},
                       {u"t_threshold"_s, js::N(threshold)},
                       {u"dropped"_s, js::object({{u"uncovered"_s, js::N(uncovered)}, {u"no_baseline"_s, js::N(noBaseline)}})},
                       {u"recent"_s, recent},
                       {u"missing_symbols"_s, js::strings(missing)},
                       {u"notes"_s, js::strings(notes)}});
}

}  // namespace ibkr::analysis::signal_outcomes
