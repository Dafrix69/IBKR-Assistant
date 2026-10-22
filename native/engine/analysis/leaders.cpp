#include "analysis/leaders.h"

#include "util/collate.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/market_js.h"
#include "util/py.h"

#include <QSet>

#include <cmath>
#include <limits>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;

namespace ibkr::analysis::leaders {

namespace {
constexpr double kInf = std::numeric_limits<double>::infinity();
QString n2s(double v) { return util::jsNumberToString(v); }
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }
OJson optB(const std::optional<bool>& v) { return v ? js::B(*v) : OJson::null(); }

std::optional<double> numOf(const OJson* v) {
    const double n = js::isNum(v) ? v->n : js::isStr(v) && !util::jsTrim(v->s).isEmpty() ? util::jsStringToNumber(v->s) : std::nan("");
    return std::isfinite(n) ? std::optional(n) : std::nullopt;
}
/// values[i] ?? fallback(下标出界、不是整数都是 undefined)
double at(const std::vector<double>& v, double i, double fallback) {
    if (!(i >= 0) || i != std::floor(i) || i >= double(v.size())) return fallback;
    return v[size_t(i)];
}
const Bar* barAt(const std::vector<Bar>& bars, double i) {
    if (!(i >= 0) || i != std::floor(i) || i >= double(bars.size())) return nullptr;
    return &bars[size_t(i)];
}
double highAt(const std::vector<Bar>& bars, double i) {
    const Bar* b = barAt(bars, i);
    return b ? b->high : 0;
}
double pct(double a, double b) { return util::pyRound((a / b - 1) * 100, 2); }
std::optional<double> r2(const std::optional<double>& v) { return v ? std::optional(util::pyRound(*v, 2)) : std::nullopt; }
QString joinNumbers(const std::vector<double>& v, const QString& sep) {
    QStringList parts;
    for (double x : v) parts << n2s(x);
    return parts.join(sep);
}
std::vector<double> closesOf(const std::vector<Bar>& bars) {
    std::vector<double> out;
    for (const Bar& b : bars) out.push_back(b.close);
    return out;
}
OJson numbers(const std::vector<double>& v) {
    OJson a = js::array();
    for (double x : v) a.items.append(js::N(x));
    return a;
}

// ---------------------------------------------------------------- VCP 的结果
struct Vcp {
    bool found = false;
    std::vector<double> depths;
    std::optional<double> pivot;
    QString status = u"none"_s;
    std::optional<double> distance_pct;
    std::optional<bool> volume_dryup;
    std::optional<double> base_bars;
    QString reason;
    OJson toJson() const {
        return js::object({{u"found"_s, js::B(found)},
                           {u"depths"_s, numbers(depths)},
                           {u"pivot"_s, optN(pivot)},
                           {u"status"_s, js::S(status)},
                           {u"distance_pct"_s, optN(distance_pct)},
                           {u"volume_dryup"_s, optB(volume_dryup)},
                           {u"base_bars"_s, optN(base_bars)},
                           {u"reason"_s, js::S(reason)}});
    }
};
Vcp noVcp(const QString& reason) {
    Vcp v;
    v.reason = reason;
    return v;
}

Vcp detect(const std::vector<Bar>& bars);
}  // namespace

std::vector<Bar> cleanDaily(const OJson& bars) {
    std::vector<Bar> out;
    for (const OJson& b : bars.items) {
        const auto c = numOf(js::propStrict(&b, u"close"_s));
        if (!c || *c <= 0) continue;
        const double h = numOf(js::prop(&b, u"high"_s)).value_or(*c);
        const double l = numOf(js::prop(&b, u"low"_s)).value_or(*c);
        const auto v = numOf(js::prop(&b, u"volume"_s));
        const OJson* date = js::prop(&b, u"date"_s);
        const OJson* time = js::nullish(date) ? js::prop(&b, u"time"_s) : date;
        out.push_back({js::strOr(time, QString()), jm::max(h, *c), jm::min(l, *c), *c, v && *v > 0 ? *v : 0});
    }
    return out;
}

std::optional<double> smaAt(const std::vector<double>& values, double n, std::optional<double> endArg) {
    const double end = endArg.value_or(double(values.size()) - 1);
    if (end < n - 1 || end >= double(values.size())) return std::nullopt;
    double acc = 0;
    for (double i = end - n + 1; i <= end; i += 1) acc += at(values, i, 0);
    return acc / n;
}

// ---------------------------------------------------------------- RS 评级
std::optional<double> rsScore(const std::vector<double>& closes) {
    const double n = double(closes.size());
    if (closes.empty() || n <= kYearBars) return std::nullopt;
    const double last = closes.back();
    const auto ret = [&](double k) { return last / at(closes, n - 1 - k, last) - 1; };
    return util::pyRound((0.4 * ret(63) + 0.2 * ret(126) + 0.2 * ret(189) + 0.2 * ret(252)) * 100, 2);
}

std::vector<std::optional<double>> ratings(const std::vector<std::optional<double>>& scores) {
    std::vector<double> valid;
    for (const auto& s : scores)
        if (s) valid.push_back(*s);
    std::vector<std::optional<double>> out;
    if (valid.size() < 2) return std::vector<std::optional<double>>(scores.size());
    for (const auto& s : scores) {
        if (!s) {
            out.push_back(std::nullopt);
            continue;
        }
        double below = 0;
        for (double x : valid)
            if (x < *s) below += 1;
        out.push_back(util::jsRound((below / (double(valid.size()) - 1)) * 98) + 1);
    }
    return out;
}

// ---------------------------------------------------------------- 趋势模板
namespace {
/// 200 日线已经连续上行了几个月(每 22 根比一次,最多数 5 个月)
double monthsRising(const std::vector<double>& closes) {
    double months = 0;
    const double len = double(closes.size());
    for (int m = 0; m < 5; m += 1) {
        const auto now = smaAt(closes, 200, len - 1 - m * kMonthBars);
        const auto before = smaAt(closes, 200, len - 1 - (m + 1) * kMonthBars);
        if (!now || !before || *now <= *before) break;
        months += 1;
    }
    return months;
}

OJson check(const QString& key, const QString& label, const std::optional<bool>& ok, const QString& detail) {
    return js::object({{u"key"_s, js::S(key)}, {u"label"_s, js::S(label)}, {u"ok"_s, optB(ok)}, {u"detail"_s, js::S(detail)}});
}
}  // namespace

OJson trendTemplate(const TrendInputs& t) {
    const double close = t.close;
    const auto& ma50 = t.ma50;
    const auto& ma150 = t.ma150;
    const auto& ma200 = t.ma200;
    const auto f = [](const std::optional<double>& v) { return v ? n2s(util::pyRound(*v, 2)) : u"—"_s; };
    const auto fv = [&](double v) { return f(std::optional(v)); };
    const auto both = [](const std::optional<double>& a, const std::optional<double>& b) -> std::optional<bool> {
        if (!a || !b) return std::nullopt;
        return *a > *b;
    };
    const double aboveLow = pct(close, t.low52);
    const double fromHigh = pct(close, t.high52);
    const bool useRating = t.universe >= kMinRatingUniverse;
    std::optional<bool> rsOk;
    if (t.rsVsBench) {
        if (!useRating) rsOk = *t.rsVsBench > 0;
        else if (t.rsRating) rsOk = *t.rsRating >= kMinRsRating && *t.rsVsBench > 0;
    }
    QString maDetail;
    if (!t.ma200Months) maDetail = u"日线不够 222 根"_s;
    else if (*t.ma200Months >= 5) maDetail = u"已上行 5 个月以上"_s;
    else maDetail = u"已上行约 %1 个月(最好 4–5 个月)"_s.arg(n2s(*t.ma200Months));
    QString rsDetail;
    if (!t.rsVsBench) {
        rsDetail = u"日线不够一年,算不出 RS"_s;
    } else {
        const QString pool = useRating ? u"池内 RS %1 · "_s.arg(t.rsRating ? n2s(*t.rsRating) : u"—"_s)
                                       : u"池子只有 %1 只,不排百分位 · "_s.arg(n2s(t.universe));
        rsDetail = pool + u"比基准 "_s + (*t.rsVsBench > 0 ? u"+"_s : QString()) + n2s(*t.rsVsBench) + u" 个百分点"_s;
    }
    return js::array({
        check(u"above_150_200"_s, u"价在 150 / 200 日线上"_s, !ma150 || !ma200 ? std::nullopt : std::optional(close > *ma150 && close > *ma200),
              u"收 %1 · 150 日 %2 · 200 日 %3"_s.arg(fv(close), f(ma150), f(ma200))),
        check(u"ma150_over_200"_s, u"150 日线在 200 日线上"_s, both(ma150, ma200), u"%1 vs %2"_s.arg(f(ma150), f(ma200))),
        check(u"ma200_rising"_s, u"200 日线上行至少 1 个月"_s, t.ma200Months ? std::optional(*t.ma200Months >= 1) : std::nullopt, maDetail),
        check(u"ma50_over"_s, u"50 日线在 150 / 200 日线上"_s,
              !ma50 || !ma150 || !ma200 ? std::nullopt : std::optional(*ma50 > *ma150 && *ma50 > *ma200), u"50 日 "_s + f(ma50)),
        check(u"above_50"_s, u"价在 50 日线上"_s, both(std::optional(close), ma50), u"收 %1 vs %2"_s.arg(fv(close), f(ma50))),
        check(u"above_low"_s, u"比 52 周低点高 %1% 以上"_s.arg(n2s(kAboveLowPct)), aboveLow >= kAboveLowPct,
              u"高出 "_s + n2s(aboveLow) + u"%"_s + (t.fullYear ? QString() : u"(不足一年,按已有的算)"_s)),
        check(u"near_high"_s, u"离 52 周高点 %1% 以内"_s.arg(n2s(kNearHighPct)), fromHigh >= -kNearHighPct, u"离高点 "_s + n2s(fromHigh) + u"%"_s),
        check(u"rs_rating"_s, useRating ? u"RS 评级 ≥ %1 且跑赢基准"_s.arg(n2s(kMinRsRating)) : u"加权涨幅跑赢基准"_s, rsOk, rsDetail),
    });
}

// ---------------------------------------------------------------- VCP
namespace {
std::vector<double> swingHighs(const std::vector<Bar>& bars, double from, int k) {
    std::vector<double> out;
    for (double i = from + 1; i < double(bars.size()) - k; i += 1) {
        const double h = highAt(bars, i);
        bool top = true;
        for (double j = i - k; j <= i + k && top; j += 1)
            if (j != i && highAt(bars, j) > h) top = false;
        if (top) out.push_back(i);
    }
    return out;
}

double lowBetween(const std::vector<Bar>& bars, double from, double to) {
    double low = kInf;
    for (double i = from; i <= to; i += 1) {
        const Bar* b = barAt(bars, i);
        low = jm::min(low, b ? b->low : kInf);
    }
    return low;
}

std::vector<double> without(const std::vector<double>& v, size_t i) {
    std::vector<double> out;
    for (size_t j = 0; j < v.size(); ++j)
        if (j != i) out.push_back(v[j]);
    return out;
}
}  // namespace

Contractions contractions(const std::vector<Bar>& bars, double start) {
    std::vector<double> peaks{start};
    for (double p : swingHighs(bars, start, kSwingStrength)) peaks.push_back(p);
    const double len = double(bars.size());
    for (bool changed = true; changed;) {
        changed = false;
        // 后一个高点不低于前一个:前一次"收缩"只是基底里的一段,并掉
        for (size_t i = 1; i + 1 < peaks.size(); i += 1) {
            if (highAt(bars, peaks[i + 1]) >= highAt(bars, peaks[i])) {
                peaks = without(peaks, i);
                changed = true;
                break;
            }
        }
        if (changed) continue;
        for (size_t i = 1; i < peaks.size(); i += 1) {
            const double p = peaks[i];
            const double next = i + 1 < peaks.size() ? peaks[i + 1] : len;
            const double high = highAt(bars, p);
            if (high > 0 && ((high - lowBetween(bars, p + 1, next - 1)) / high) * 100 < kMinLegPct) {
                peaks = without(peaks, i);
                changed = true;
                break;
            }
        }
    }
    std::vector<double> depths;
    for (size_t i = 0; i < peaks.size(); i += 1) {
        const double p = peaks[i];
        const double next = i + 1 < peaks.size() ? peaks[i + 1] : len;
        const double high = highAt(bars, p);
        if (next - 1 < p + 1 || high <= 0) continue;
        depths.push_back(util::pyRound(((high - lowBetween(bars, p + 1, next - 1)) / high) * 100, 1));
    }
    return {peaks, depths};
}

namespace {
Vcp detect(const std::vector<Bar>& bars) {
    const double n = double(bars.size());
    if (n < 60) return noVcp(u"日线不够 60 根"_s);
    const double from = jm::max(0.0, n - kVcpLookback);
    double start = from;
    for (double i = from; i < n; i += 1)
        if (highAt(bars, i) > highAt(bars, start)) start = i;
    if (start > n - 1 - 2 * kSwingStrength) return noVcp(u"还贴着新高,没有形成基底"_s);
    const Contractions c = contractions(bars, start);
    const double pivotIdx = c.peaks.empty() ? start : c.peaks.back();
    const Bar* pivotBar = barAt(bars, pivotIdx);
    const Bar& last = bars.back();
    if (!pivotBar) return noVcp(u"算不出枢轴"_s);
    const double pivot = pivotBar->high;
    std::vector<double> vols;
    for (const Bar& b : bars) vols.push_back(b.volume);
    const auto vol50 = smaAt(vols, 50, n - 2);
    std::vector<double> legVols;
    const auto r = util::market::sliceRange((long long)bars.size(), pivotIdx + 1, n - 1);
    for (long long i = r.from; i < r.to; ++i) legVols.push_back(bars[size_t(i)].volume);
    std::optional<bool> dryup;
    if (vol50 && *vol50 > 0 && !legVols.empty()) {
        double sum = 0;
        for (double v : legVols) sum = sum + v;
        dryup = sum / double(legVols.size()) < *vol50 * 0.8;
    }
    const std::optional<double> volRatio = vol50 && *vol50 > 0 ? std::optional(last.volume / *vol50) : std::nullopt;
    const double distance = pct(last.close, pivot);
    bool shrinking = c.depths.size() >= 2;
    for (size_t i = 1; i < c.depths.size() && shrinking; ++i) shrinking = c.depths[i] < c.depths[i - 1];
    const double first = c.depths.empty() ? 0 : c.depths.front();
    const double final = c.depths.empty() ? 0 : c.depths.back();
    const bool found = shrinking && first <= 50 && final <= 15;
    Vcp v;
    if (!found) v.status = u"none"_s;
    else if (last.close > pivot) v.status = volRatio && *volRatio >= kBreakoutVolume ? u"breakout"_s : u"weak_breakout"_s;
    else if (distance >= -5) v.status = u"near_pivot"_s;
    else v.status = u"forming"_s;
    if (c.depths.size() < 2) v.reason = u"基底里只有一次回撤,还谈不上收缩"_s;
    else if (!shrinking) v.reason = u"回撤没有一次比一次浅(%1%)"_s.arg(joinNumbers(c.depths, u" → "_s));
    else if (first > 50) v.reason = u"第一次回撤 %1% 太深"_s.arg(n2s(first));
    else if (final > 15) v.reason = u"最后一次回撤 %1% 还不够紧"_s.arg(n2s(final));
    else if (v.status == u"weak_breakout") v.reason = u"站上枢轴但量只有 50 日均量的 %1 倍"_s.arg(n2s(util::pyRound(volRatio.value_or(0), 2)));
    v.found = found;
    v.depths = c.depths;
    v.pivot = util::pyRound(pivot, 2);
    v.distance_pct = distance;
    v.volume_dryup = dryup;
    v.base_bars = n - start;
    return v;
}
}  // namespace

OJson detectVcp(const std::vector<Bar>& bars) { return detect(bars).toJson(); }

// ---------------------------------------------------------------- 大盘方向
QStringList distributionDays(const std::vector<Bar>& bars) {
    QStringList out;
    const double n = double(bars.size());
    for (double i = jm::max(1.0, n - kDistWindow); i < n; i += 1) {
        const Bar& cur = bars[size_t(i)];
        const Bar& prev = bars[size_t(i - 1)];
        if (cur.volume <= 0 || prev.volume <= 0) continue;
        if (cur.close > prev.close * (1 - kDistDrop) || cur.volume <= prev.volume) continue;
        bool recovered = false;
        for (size_t j = size_t(i) + 1; j < bars.size() && !recovered; ++j) recovered = bars[j].close >= cur.close * (1 + kDistRecovery);
        if (!recovered) out << cur.time.left(10);
    }
    return out;
}

OJson marketRegime(const QString& symbol, const OJson& raw) {
    const std::vector<Bar> bars = cleanDaily(raw);
    const std::vector<double> closes = closesOf(bars);
    const double n = double(closes.size());
    const std::optional<double> close = closes.empty() ? std::nullopt : std::optional(closes.back());
    const auto ma50 = smaAt(closes, 50);
    const auto ma200 = smaAt(closes, 200);
    const auto ma200Prev = smaAt(closes, 200, n - 1 - kMonthBars);
    const std::optional<bool> rising = !ma200 || !ma200Prev ? std::nullopt : std::optional(*ma200 > *ma200Prev);
    const QStringList dist = distributionDays(bars);
    double high = 0;
    const auto yr = util::market::sliceRange((long long)closes.size(), -kYearBars);
    for (long long i = yr.from; i < yr.to; ++i) high = jm::max(high, closes[size_t(i)]);
    const std::optional<double> off = !close || high <= 0 ? std::nullopt : std::optional(pct(*close, high));
    OJson out = js::object({{u"symbol"_s, js::S(symbol)},
                            {u"close"_s, optN(r2(close))},
                            {u"ma50"_s, optN(r2(ma50))},
                            {u"ma200"_s, optN(r2(ma200))},
                            {u"ma200_rising"_s, optB(rising)},
                            {u"off_high_pct"_s, optN(off)},
                            {u"distribution_days"_s, js::N(double(dist.size()))},
                            {u"distribution_dates"_s, js::strings(dist)}});
    const auto finish = [&](const QString& state, const QString& label, const QString& text) {
        out.set(u"state"_s, js::S(state));
        out.set(u"label"_s, js::S(label));
        out.set(u"text"_s, js::S(text));
        return out;
    };
    if (!close || !ma50 || !ma200) return finish(u"unknown"_s, u"数据不够"_s, symbol + u" 日线不够 200 根,判断不了大盘方向。"_s);
    const auto side = [&](double ma, int days) { return *close > ma ? u"在 %1 日线上"_s.arg(days) : u"跌破 %1 日线"_s.arg(days); };
    const QString where = u"%1 %2、%3,200 日线%4;"_s.arg(symbol, side(*ma50, 50), side(*ma200, 200), rising && *rising ? u"上行"_s : u"走平或下行"_s) +
                          u"近 %1 个交易日派发日 %2 个,离一年高点 %3%。"_s.arg(QString::number(kDistWindow), QString::number(dist.size()), off ? n2s(*off) : u"—"_s);
    if (*close < *ma200 || (dist.size() >= 6 && off.value_or(0) <= -6))
        return finish(u"correction"_s, u"调整中"_s,
                      where + u"O'Neil:四只股票里有三只跟着大盘走,大盘调整时新突破多半失败;Minervini 这时把仓位降到很低甚至空仓。"_s);
    if (dist.size() >= 4 || *close < *ma50)
        return finish(u"pressure"_s, u"承压"_s, where + u"派发日在累积或跌破了 50 日线:新仓位宜小、止损宜紧,先看领涨股能不能扛住。"_s);
    return finish(u"uptrend"_s, u"上升趋势"_s, where + u"大盘站在冠军们愿意进攻的那一边。"_s);
}

// ---------------------------------------------------------------- 一只 / 一池
namespace {
struct Row {
    QString symbol, tag, company;
    double bars = 0;
    std::optional<double> close, ma50, ma150, ma200, high52, low52, pct_from_high, pct_above_low, rs_score, rs_rating, rs_vs_bench;
    OJson checks = js::array();
    double passed = 0;
    bool stage2 = false;
    Vcp vcp;
    bool new_high_volume = false;
    std::optional<double> volume_ratio;
    QString verdict;
    OJson error;
    OJson toJson() const {
        return js::object({{u"symbol"_s, js::S(symbol)},       {u"tag"_s, js::S(tag)},
                           {u"company"_s, js::S(company)},     {u"bars"_s, js::N(bars)},
                           {u"close"_s, optN(close)},          {u"ma50"_s, optN(ma50)},
                           {u"ma150"_s, optN(ma150)},          {u"ma200"_s, optN(ma200)},
                           {u"high52"_s, optN(high52)},        {u"low52"_s, optN(low52)},
                           {u"pct_from_high"_s, optN(pct_from_high)}, {u"pct_above_low"_s, optN(pct_above_low)},
                           {u"rs_score"_s, optN(rs_score)},    {u"rs_rating"_s, optN(rs_rating)},
                           {u"rs_vs_bench"_s, optN(rs_vs_bench)}, {u"checks"_s, checks},
                           {u"passed"_s, js::N(passed)},       {u"stage2"_s, js::B(stage2)},
                           {u"vcp"_s, vcp.toJson()},           {u"new_high_volume"_s, js::B(new_high_volume)},
                           {u"volume_ratio"_s, optN(volume_ratio)}, {u"verdict"_s, js::S(verdict)},
                           {u"error"_s, error}});
    }
};
struct Computed {
    Row row;
    std::vector<double> closes;
};

QString verdictOf(const Row& row) {
    if (js::truthy(&row.error)) return u"拉不到日线"_s;
    if (!row.close) return u"没有日线"_s;
    const QString tt = u"趋势模板 %1/8"_s.arg(n2s(row.passed));
    const Vcp& v = row.vcp;
    const QString pivot = v.pivot ? n2s(*v.pivot) : u"null"_s;
    QString vcpText;
    if (v.status == u"breakout") vcpText = u"VCP 放量突破枢轴 "_s + pivot;
    else if (v.status == u"weak_breakout") vcpText = u"站上 VCP 枢轴 %1,但量不够"_s.arg(pivot);
    else if (v.status == u"near_pivot") vcpText = u"VCP 离枢轴 %1 还有 %2%"_s.arg(pivot, n2s(std::fabs(v.distance_pct.value_or(0))));
    else if (v.status == u"forming") vcpText = u"VCP 收缩中(%1%)"_s.arg(joinNumbers(v.depths, u" → "_s));
    // Minervini 的 VCP 要最后一次收缩缩量;没缩量的照样列出来,但结论里当场说
    const QString dry = v.found && v.volume_dryup && !*v.volume_dryup ? u"(最后一次收缩没缩量)"_s : QString();
    if (row.stage2) {
        QStringList parts{tt + u" · 第二阶段"_s, vcpText + dry, row.new_high_volume ? u"放量新高"_s : QString()};
        parts.removeAll(QString());
        return parts.join(u" · "_s);
    }
    QStringList failed;
    for (const OJson& c : row.checks.items)
        if (const OJson* ok = c.get(u"ok"_s); ok && ok->type == OJson::Bool && !ok->b) failed << c.get(u"label"_s)->s;
    if (failed.isEmpty()) return tt;
    return tt + u" · 没过:"_s + failed.mid(0, 2).join(u"、"_s) + (failed.size() > 2 ? u" 等"_s : QString());
}

Computed computeRow(const LeaderMember& m) {
    const std::vector<Bar> bars = cleanDaily(m.bars);
    const std::vector<double> closes = closesOf(bars);
    const double n = double(bars.size());
    const Bar* last = bars.empty() ? nullptr : &bars.back();
    std::vector<double> vols;
    for (const Bar& b : bars) vols.push_back(b.volume);
    const auto vol50 = smaAt(vols, 50, n - 2);
    const auto yr = util::market::sliceRange((long long)bars.size(), -kYearBars);
    double high52 = 0, low52 = kInf;
    for (long long i = yr.from; i < yr.to; ++i) {
        high52 = jm::max(high52, bars[size_t(i)].high);
        low52 = jm::min(low52, bars[size_t(i)].low);
    }
    const auto pr = util::market::sliceRange((long long)bars.size(), -kYearBars, -1);
    double priorHigh = 0;
    for (long long i = pr.from; i < pr.to; ++i) priorHigh = jm::max(priorHigh, bars[size_t(i)].close);
    const std::optional<double> volRatio = last && vol50 && *vol50 > 0 ? std::optional(util::pyRound(last->volume / *vol50, 2)) : std::nullopt;
    Row row;
    row.symbol = m.symbol;
    row.tag = m.tag.value_or(QString());
    row.company = m.company.value_or(QString());
    row.bars = n;
    row.close = last ? r2(last->close) : std::nullopt;
    row.ma50 = r2(smaAt(closes, 50));
    row.ma150 = r2(smaAt(closes, 150));
    row.ma200 = r2(smaAt(closes, 200));
    row.high52 = last ? r2(high52) : std::nullopt;
    row.low52 = last ? r2(low52) : std::nullopt;
    row.pct_from_high = last ? std::optional(pct(last->close, high52)) : std::nullopt;
    row.pct_above_low = last ? std::optional(pct(last->close, low52)) : std::nullopt;
    row.rs_score = rsScore(closes);
    row.vcp = last ? detect(bars) : noVcp(u"没有日线"_s);
    row.new_high_volume = last && priorHigh > 0 && last->close >= priorHigh && volRatio && *volRatio >= kNewHighVolume;
    row.volume_ratio = volRatio;
    row.error = m.error && m.error->type != OJson::Null ? *m.error : OJson::null();
    return {row, closes};
}

double statusRank(const QString& s) {
    if (s == u"breakout") return 4;
    if (s == u"near_pivot") return 3;
    if (s == u"weak_breakout") return 2;
    if (s == u"forming") return 1;
    return 0;
}

QString dayOf(const OJson* bar) {
    const OJson* date = js::prop(bar, u"date"_s);
    const OJson* v = js::nullish(date) ? js::prop(bar, u"time"_s) : date;
    return js::strOr(v, QString()).left(10);
}
}  // namespace

OJson screenLeaders(const QList<LeaderMember>& members, const OJson& benchBars, const QString& benchmark) {
    std::vector<Computed> computed;
    for (const LeaderMember& m : members) computed.push_back(computeRow(m));
    const auto benchScore = rsScore(closesOf(cleanDaily(benchBars)));
    std::vector<std::optional<double>> scores;
    for (const Computed& c : computed) scores.push_back(c.row.rs_score);
    const auto rated = ratings(scores);
    double universe = 0;
    for (const auto& s : scores)
        if (s) universe += 1;
    for (size_t i = 0; i < computed.size(); ++i) {
        Row& row = computed[i].row;
        row.rs_rating = i < rated.size() ? rated[i] : std::nullopt;
        row.rs_vs_bench = row.rs_score && benchScore ? std::optional(util::pyRound(*row.rs_score - *benchScore, 2)) : std::nullopt;
        if (row.close && row.high52 && row.low52) {
            const auto& closes = computed[i].closes;
            TrendInputs t;
            t.close = *row.close;
            t.ma50 = row.ma50;
            t.ma150 = row.ma150;
            t.ma200 = row.ma200;
            t.ma200Months = closes.size() >= size_t(200 + kMonthBars) ? std::optional(monthsRising(closes)) : std::nullopt;
            t.high52 = *row.high52;
            t.low52 = *row.low52;
            t.fullYear = closes.size() >= size_t(kYearBars);
            t.rsRating = row.rs_rating;
            t.rsVsBench = row.rs_vs_bench;
            t.universe = universe;
            row.checks = trendTemplate(t);
            row.passed = 0;
            for (const OJson& k : row.checks.items)
                if (const OJson* ok = k.get(u"ok"_s); ok && ok->type == OJson::Bool && ok->b) row.passed += 1;
            row.stage2 = row.passed == double(row.checks.items.size());
        }
        row.verdict = verdictOf(row);
    }
    std::vector<Row> rows;
    for (const Computed& c : computed) rows.push_back(c.row);
    util::market::jsSort(rows, [](const Row& a, const Row& b) {
        if (const double d = b.passed - a.passed; d != 0) return d;
        if (const double d = statusRank(b.vcp.status) - statusRank(a.vcp.status); d != 0) return d;
        if (const double d = b.rs_rating.value_or(-1) - a.rs_rating.value_or(-1); d != 0) return d;
        return double(util::localeCompare(a.symbol, b.symbol));
    });
    QStringList notes{
        u"RS 评级是在这次扫的 %1 只里排的百分位(IBD 式加权涨幅:0.4 × 近 63 个交易日 + 0.2 × 近 126 / 189 / 252 个交易日,都是到今天的累计涨幅),不是全市场排名"_s.arg(n2s(universe)),
        u"CAN SLIM 里的当季 / 年度盈利增长(C、A)与机构持仓(I)要财报数据,券商日线给不了,这里没算"_s,
        u"大盘方向用 %1 的日线与成交量近似;IBD 看的是指数本身"_s.arg(benchmark),
    };
    if (universe < kMinRatingUniverse) notes << u"池子不到 %1 只,第 8 条只看加权涨幅有没有跑赢基准"_s.arg(n2s(kMinRatingUniverse));
    OJson rowsJson = js::array();
    double stage2 = 0, vcp = 0;
    for (const Row& r : rows) {
        rowsJson.items.append(r.toJson());
        if (r.stage2) stage2 += 1;
        if (r.vcp.found) vcp += 1;
    }
    return js::object({{u"benchmark"_s, js::S(benchmark)},
                       {u"market"_s, marketRegime(benchmark, benchBars)},
                       {u"rows"_s, rowsJson},
                       {u"total"_s, js::N(double(rows.size()))},
                       {u"stage2_count"_s, js::N(stage2)},
                       {u"vcp_count"_s, js::N(vcp)},
                       {u"rating_universe"_s, js::N(universe)},
                       {u"notes"_s, js::strings(notes)}});
}

OJson newStage2(const QList<LeaderMember>& members, const OJson& benchBars, const QString& benchmark, const QList<OJson>& rows) {
    const QString day = benchBars.items.isEmpty() ? QString() : dayOf(&benchBars.items.back());
    QList<OJson> now;
    for (const OJson& r : rows)
        if (js::truthy(r.get(u"stage2"_s))) now << r;
    if (day.isEmpty() || now.isEmpty()) return js::object({{u"day"_s, js::S(day)}, {u"rows"_s, js::array()}});
    const auto before = [&](const OJson& bars) {
        OJson out = js::array();
        for (const OJson& b : bars.items)
            if (dayOf(&b) < day) out.items.append(b);
        return out;
    };
    QList<LeaderMember> prevMembers;
    for (const LeaderMember& m : members) {
        LeaderMember p = m;
        p.bars = before(m.bars);
        prevMembers << p;
    }
    const OJson previous = screenLeaders(prevMembers, before(benchBars), benchmark);
    QSet<QString> already, current;
    for (const OJson& r : previous.get(u"rows"_s)->items)
        if (js::truthy(r.get(u"stage2"_s))) already.insert(r.get(u"symbol"_s)->s);
    for (const LeaderMember& m : members)
        if ((m.bars.items.isEmpty() ? QString() : dayOf(&m.bars.items.back())) == day) current.insert(m.symbol);
    OJson out = js::array();
    for (const OJson& r : now) {
        const QString sym = js::str(r.get(u"symbol"_s));
        if (current.contains(sym) && !already.contains(sym)) out.items.append(r);
    }
    return js::object({{u"day"_s, js::S(day)}, {u"rows"_s, out}});
}

}  // namespace ibkr::analysis::leaders
