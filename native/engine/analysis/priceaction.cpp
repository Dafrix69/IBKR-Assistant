#include "analysis/priceaction.h"

#include "analysis/backtest.h"
#include "domain/positions.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/py.h"

#include <QRegularExpression>
#include <QStringList>

#include <algorithm>
#include <cmath>
#include <limits>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;

namespace ibkr::analysis::priceaction {

namespace {
constexpr double kInf = std::numeric_limits<double>::infinity();
// 打分权重。正 = 看涨,负 = 看跌
constexpr double kWTrend = 30.0, kWChoch = 25.0, kWBos = 15.0, kWPosition = 15.0, kWEma = 12.0, kWSweep = 15.0, kWPattern = 10.0, kWLevel = 8.0,
                 kWVolume = 8.0;

QString n2s(double v) { return util::jsNumberToString(v); }
QString pf(double v) { return util::pyFloat(v); }
double r4(double v) { return util::pyRound(v, 4); }

double body(const PABar& b) { return std::abs(b.close - b.open); }
double span(const PABar& b) { return b.high - b.low; }
bool bullish(const PABar& b) { return b.close > b.open; }

OJson swingDict(const Swing& s) {
    return js::object({{u"index"_s, js::N(s.index)}, {u"time"_s, js::S(s.time)}, {u"price"_s, js::N(r4(s.price))}, {u"kind"_s, js::S(s.kind)}, {u"label"_s, js::S(s.label)}});
}

/// 对象上的数(缺了 / null 是空)
std::optional<double> optNum(const OJson* o, const QString& k) {
    const OJson* v = js::prop(o, k);
    return v && v->type == OJson::Number ? std::optional(v->n) : std::nullopt;
}
double numAt(const OJson& o, const QString& k) { return js::num(o.get(k)); }
QString strAt(const OJson& o, const QString& k) { return js::str(o.get(k)); }
/// pyFloat(x):TS 里拿到的是数
QString pfOf(const OJson* v) { return pf(js::num(v)); }

const OJson* tfEntry(const QString& timeframe) { return domain::timeframes().get(timeframe); }
double tfSeconds(const QString& timeframe) { return js::num(js::prop(tfEntry(timeframe), u"seconds"_s)); }
}  // namespace

PABars toBars(const OJson& rows) {
    PABars out;
    for (const OJson& row : rows.items) {
        const OJson* t = js::propStrict(&row, u"time"_s);
        const OJson* d = js::prop(&row, u"date"_s);
        const QString time = !js::nullish(t) ? js::str(t) : !js::nullish(d) ? js::str(d) : QString();
        const OJson* vol = js::prop(&row, u"volume"_s);
        const double v = js::nullish(vol) ? 0.0 : js::num(vol);
        out.push_back({time, js::num(js::prop(&row, u"open"_s)), js::num(js::prop(&row, u"high"_s)), js::num(js::prop(&row, u"low"_s)),
                       js::num(js::prop(&row, u"close"_s)), (v != 0 && !std::isnan(v)) ? v : 0.0});
    }
    return out;
}

// ---------------------------------------------------------------- 波动尺度
double trueRange(const PABar& bar, const PABar* prev) {
    if (!prev) return span(bar);
    return jm::max(jm::max(span(bar), std::abs(bar.high - prev->close)), std::abs(bar.low - prev->close));
}

namespace {
/// trs[k] 是第 k + 1 根的真实波幅
std::vector<double> trueRanges(const PABars& bars) {
    std::vector<double> trs;
    for (size_t i = 1; i < bars.size(); ++i) trs.push_back(trueRange(bars[i], &bars[i - 1]));
    return trs;
}
/// trs 里 end 之前最多 period 个的简单平均
double meanBefore(const std::vector<double>& trs, double end, double period) {
    const double from = jm::max(0, end - period);
    const double to = std::min(end, double(trs.size()));
    double sum = 0, n = 0;
    for (double k = from; k < to; ++k) {
        sum += trs[size_t(k)];
        n += 1;
    }
    return n ? sum / n : 0.0;
}
/// 容差:ATR 的 0.35 倍;没有 ATR 时退到价格的万分之五
double tolOf(double atrValue, double close) { return atrValue > 0 ? atrValue * 0.35 : std::abs(close) * 0.0005; }
}  // namespace

double atr(const PABars& bars, double period) {
    if (bars.size() < 2) return 0.0;
    const std::vector<double> trs = trueRanges(bars);
    return meanBefore(trs, double(trs.size()), period);
}

std::vector<double> atrSeries(const PABars& bars, double period) {
    const std::vector<double> trs = trueRanges(bars);
    std::vector<double> out;
    for (size_t i = 0; i < bars.size(); ++i) out.push_back(meanBefore(trs, double(i), period));
    return out;
}

std::optional<util::WallParts> parseBarTime(const QString& raw) {
    static const QRegularExpression full(u"\\A([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})\\z"_s);
    static const QRegularExpression minute(u"\\A([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2})\\z"_s);
    static const QRegularExpression day(u"\\A([0-9]{4})-([0-9]{2})-([0-9]{2})\\z"_s);
    const auto n = [](const QRegularExpressionMatch& m, int k) { return m.captured(k).toDouble(); };
    if (const auto m = full.match(raw); m.hasMatch()) return util::WallParts{n(m, 1), n(m, 2), n(m, 3), n(m, 4), n(m, 5), n(m, 6)};
    if (const auto m = minute.match(raw); m.hasMatch()) return util::WallParts{n(m, 1), n(m, 2), n(m, 3), n(m, 4), n(m, 5), 0};
    if (const auto m = day.match(raw); m.hasMatch()) return util::WallParts{n(m, 1), n(m, 2), n(m, 3), 0, 0, 0};
    return std::nullopt;
}

std::optional<double> barCloseEpochMs(const QString& time, const QString& timeframe, bool extendedHours) {
    const double seconds = tfSeconds(timeframe);
    const auto stamp = parseBarTime(time);
    if (!(seconds > 0) || !stamp) return std::nullopt;
    if (seconds >= 86'400) {
        util::WallParts p = *stamp;
        p.hour = extendedHours ? 20 : 16;
        p.minute = 0;
        p.second = 0;
        return util::wallToEpoch(p, QString::fromUtf16(util::kET));
    }
    return util::wallToEpoch(*stamp, QString::fromUtf16(util::kET)) + seconds * 1000;
}

// ---------------------------------------------------------------- 摆动结构
std::vector<Swing> findSwings(const PABars& bars, double strength) {
    std::vector<Swing> out;
    const double n = double(bars.size());
    for (double i = strength; i < n - strength; ++i) {
        double lh = -kInf, ll = kInf, rh = -kInf, rl = kInf;
        for (double j = i - strength; j < i; ++j) {
            lh = jm::max(lh, bars[size_t(j)].high);
            ll = jm::min(ll, bars[size_t(j)].low);
        }
        for (double j = i + 1; j < i + 1 + strength && j < n; ++j) {
            rh = jm::max(rh, bars[size_t(j)].high);
            rl = jm::min(rl, bars[size_t(j)].low);
        }
        const PABar& bar = bars[size_t(i)];
        if (bar.high > lh && bar.high >= rh) out.push_back({i, bar.time, bar.high, u"high"_s, QString()});
        if (bar.low < ll && bar.low <= rl) out.push_back({i, bar.time, bar.low, u"low"_s, QString()});
    }
    std::stable_sort(out.begin(), out.end(), [](const Swing& a, const Swing& b) {
        if (a.index != b.index) return a.index < b.index;
        return (a.kind == u"high" ? 0 : 1) < (b.kind == u"high" ? 0 : 1);
    });
    return out;
}

namespace {
/// 把新确认的摆动点折进交替序列:方向换了就接上,同向只在更极端时顶掉上一个
bool adopt(std::vector<Swing>& seq, const Swing& swing) {
    if (seq.empty() || seq.back().kind != swing.kind) {
        seq.push_back(swing);
        return true;
    }
    if (swing.kind == u"high" ? swing.price > seq.back().price : swing.price < seq.back().price) {
        seq.back() = swing;
        return true;
    }
    return false;
}
}  // namespace

std::vector<Swing> zigzag(const std::vector<Swing>& swings) {
    std::vector<Swing> out;
    for (const Swing& s : swings) adopt(out, s);
    return out;
}

std::vector<Swing> labelSwings(const std::vector<Swing>& points) {
    std::vector<double> highs, lows;
    std::vector<Swing> out;
    for (const Swing& swing : points) {
        QString label;
        if (swing.kind == u"high") {
            label = highs.empty() ? u"H"_s : (swing.price > highs.back() ? u"HH"_s : u"LH"_s);
            highs.push_back(swing.price);
        } else {
            label = lows.empty() ? u"L"_s : (swing.price > lows.back() ? u"HL"_s : u"LL"_s);
            lows.push_back(swing.price);
        }
        Swing s = swing;
        s.label = label;
        out.push_back(s);
    }
    return out;
}

namespace {
struct Trend {
    QString trend, label;
};
Trend readTrend(const std::vector<Swing>& points) {
    std::vector<double> highs, lows;
    for (const Swing& s : points) (s.kind == u"high" ? highs : lows).push_back(s.price);
    if (highs.size() < 2 || lows.size() < 2) return {u"unknown"_s, u"摆动点不足两组,结构尚未成形"_s};
    const size_t h = highs.size(), l = lows.size();
    const bool up = highs[h - 1] > highs[h - 2] && lows[l - 1] > lows[l - 2];
    const bool down = highs[h - 1] < highs[h - 2] && lows[l - 1] < lows[l - 2];
    if (up) return {u"up"_s, u"上升结构(高点抬高 + 低点抬高)"_s};
    if (down) return {u"down"_s, u"下降结构(高点降低 + 低点降低)"_s};
    return {u"range"_s, u"震荡(高点与低点没有同向移动)"_s};
}

OJson makeEvent(const QString& kind, const QString& direction, double index, const PABar& bar, const Swing& swing) {
    const bool up = direction == u"up";
    return js::object({
        {u"kind"_s, js::S(kind)},
        {u"direction"_s, js::S(direction)},
        {u"time"_s, js::S(bar.time)},
        {u"index"_s, js::N(index)},
        {u"level"_s, js::N(r4(swing.price))},
        {u"close"_s, js::N(r4(bar.close))},
        {u"swing_time"_s, js::S(swing.time)},
        {u"text"_s, js::S(u"%1 %2:收盘 %3 %4前%5 %6"_s.arg(bar.time, kind, pf(r4(bar.close)), up ? u"上破"_s : u"下破"_s, up ? u"高"_s : u"低"_s, pf(r4(swing.price))))},
    });
}

OJson makeSweep(const QString& direction, const PABar& bar, double index, const Swing& swing) {
    const bool bear = direction == u"bear";
    return js::object({
        {u"direction"_s, js::S(direction)},
        {u"time"_s, js::S(bar.time)},
        {u"index"_s, js::N(index)},
        {u"level"_s, js::N(r4(swing.price))},
        {u"extreme"_s, js::N(r4(bear ? bar.high : bar.low))},
        {u"text"_s, js::S(u"%1:影线%2前%3 %4 后收回%5方"_s.arg(bar.time, bear ? u"上破"_s : u"下破"_s, bear ? u"高"_s : u"低"_s, pf(r4(swing.price)), bear ? u"下"_s : u"上"_s))},
    });
}

/// 影线刺穿前高/前低但收了回来 —— 止损被扫。seq 从旧到新找,认第一个;60 根以前的不看
std::optional<OJson> sweepAt(const PABar& bar, double index, const std::vector<Swing>& seq, double tol) {
    for (const Swing& swing : seq) {
        if (index - swing.index > 60) continue;
        if (swing.kind == u"high" && bar.high > swing.price + tol && bar.close < swing.price) return makeSweep(u"bear"_s, bar, index, swing);
        if (swing.kind == u"low" && bar.low < swing.price - tol && bar.close > swing.price) return makeSweep(u"bull"_s, bar, index, swing);
    }
    return std::nullopt;
}

QList<OJson> tail(const QList<OJson>& xs, qsizetype k) { return xs.mid(std::max<qsizetype>(0, xs.size() - k)); }
}  // namespace

StructureHistory structureHistory(const PABars& bars, const std::function<double(qsizetype)>& tolAt, double strength, qsizetype keepEvents,
                                  qsizetype sweepWindow, qsizetype keepSweeps) {
    const std::vector<Swing> fractals = findSwings(bars, strength);
    std::vector<Swing> seq;
    QList<OJson> events, sweeps;
    size_t next = 0;
    std::optional<QString> direction;
    std::optional<Swing> pendingHigh, pendingLow;
    const qsizetype sweepFrom = std::max<qsizetype>(0, qsizetype(bars.size()) - sweepWindow);

    for (qsizetype i = 0; i < qsizetype(bars.size()); ++i) {
        const PABar& bar = bars[size_t(i)];
        if (pendingHigh && bar.close > pendingHigh->price) {
            const QString kind = !direction || *direction == u"up" ? u"BOS"_s : u"CHoCH"_s;
            direction = u"up"_s;
            events.append(makeEvent(kind, u"up"_s, double(i), bar, *pendingHigh));
            pendingHigh.reset();
        }
        if (pendingLow && bar.close < pendingLow->price) {
            const QString kind = !direction || *direction == u"down" ? u"BOS"_s : u"CHoCH"_s;
            direction = u"down"_s;
            events.append(makeEvent(kind, u"down"_s, double(i), bar, *pendingLow));
            pendingLow.reset();
        }
        if (i >= sweepFrom) {
            // 此刻的 seq 只有上一根为止确认的摆动点:这一根才确认的还没折进来
            if (auto sweep = sweepAt(bar, double(i), seq, tolAt(i))) sweeps.append(*sweep);
        }
        for (; next < fractals.size() && fractals[next].index + strength <= double(i); ++next) {
            const Swing& swing = fractals[next];
            if (!adopt(seq, swing)) continue;
            if (swing.kind == u"high" && swing.price > bar.close) pendingHigh = swing;
            else if (swing.kind == u"low" && swing.price < bar.close) pendingLow = swing;
        }
    }
    return {seq, tail(events, keepEvents), tail(sweeps, keepSweeps)};
}

// ---------------------------------------------------------------- 关键位
namespace {
QList<OJson> clusterLevels(const PABars& bars, const std::vector<Swing>& points, double tol, double last, qsizetype perSide = 3) {
    std::vector<double> prices;
    for (const Swing& s : points) prices.push_back(s.price);
    std::stable_sort(prices.begin(), prices.end());
    if (prices.empty() || tol <= 0 || last == 0 || std::isnan(last)) return {};

    // 对着这一簇最低的那个比,不对着上一个比
    std::vector<std::vector<double>> clusters{{prices[0]}};
    for (size_t k = 1; k < prices.size(); ++k) {
        if (prices[k] - clusters.back()[0] <= tol) clusters.back().push_back(prices[k]);
        else clusters.push_back({prices[k]});
    }

    QList<OJson> levels;
    for (const auto& group : clusters) {
        double sum = 0;
        for (double p : group) sum += p;
        const double price = sum / double(group.size());
        double touches = 0;
        for (const PABar& b : bars)
            if (std::abs(b.high - price) <= tol || std::abs(b.low - price) <= tol) touches += 1;
        levels.append(js::object({
            {u"price"_s, js::N(r4(price))},
            {u"swings"_s, js::N(double(group.size()))},
            {u"touches"_s, js::N(touches)},
            {u"side"_s, js::S(price > last ? u"resistance"_s : u"support"_s)},
            {u"distance_pct"_s, js::N(util::pyRound((price / last - 1.0) * 100.0, 2))},
        }));
    }
    QList<OJson> above, below;
    for (const OJson& l : levels) (l.get(u"side"_s)->s == u"resistance" ? above : below).append(l);
    std::stable_sort(above.begin(), above.end(), [](const OJson& a, const OJson& b) { return a.get(u"price"_s)->n < b.get(u"price"_s)->n; });
    std::stable_sort(below.begin(), below.end(), [](const OJson& a, const OJson& b) { return b.get(u"price"_s)->n < a.get(u"price"_s)->n; });
    // 从低到高排,支撑在前、阻力在后
    QList<OJson> out = below.mid(0, perSide);
    std::reverse(out.begin(), out.end());
    out.append(above.mid(0, perSide));
    return out;
}

/// 未回补的 FVG。窄于 tol 的当噪音丢掉,已被走完的不再列
QList<OJson> findFvgs(const PABars& bars, double tol, qsizetype keep = 4) {
    QList<OJson> out;
    for (size_t i = 1; i + 1 < bars.size(); ++i) {
        const PABar& prev = bars[i - 1];
        const PABar& nxt = bars[i + 1];
        double bottom, top;
        QString side;
        if (nxt.low > prev.high) {
            bottom = prev.high;
            top = nxt.low;
            side = u"bull"_s;
        } else if (nxt.high < prev.low) {
            bottom = nxt.high;
            top = prev.low;
            side = u"bear"_s;
        } else {
            continue;
        }
        const double size = top - bottom;
        if (size < tol) continue;
        const bool hasRest = i + 2 < bars.size();
        double filled;
        if (side == u"bull") {
            double reached = hasRest ? kInf : top;
            for (size_t k = i + 2; k < bars.size(); ++k) reached = jm::min(reached, bars[k].low);
            filled = (top - reached) / size;
        } else {
            double reached = hasRest ? -kInf : bottom;
            for (size_t k = i + 2; k < bars.size(); ++k) reached = jm::max(reached, bars[k].high);
            filled = (reached - bottom) / size;
        }
        filled = jm::min(jm::max(filled, 0.0), 1.0);
        if (filled >= 0.9) continue;
        out.append(js::object({
            {u"side"_s, js::S(side)},
            {u"time"_s, js::S(bars[i].time)},
            {u"bottom"_s, js::N(r4(bottom))},
            {u"top"_s, js::N(r4(top))},
            {u"filled_pct"_s, js::N(util::pyRound(filled * 100.0, 1))},
        }));
    }
    return tail(out, keep);
}

/// 推动最近一次突破之前的最后一根反向 K 线,以及突破之后它有没有被回踩
OJson orderBlock(const PABars& bars, const OJson* event, double lookback = 25) {
    if (!event) return OJson::null();
    const double end = event->get(u"index"_s)->n;
    const bool wantBullish = event->get(u"direction"_s)->s == u"down";  // 下破之前找最后一根阳线
    for (double i = end; i > jm::max(-1, end - lookback); --i) {
        const PABar& bar = bars[size_t(i)];
        if (body(bar) > 0 && bullish(bar) == wantBullish) {
            // 回踩从突破之后那一根数起;紧挨着它的下一根不算
            bool mitigated = false;
            for (double k = jm::max(i + 2, end + 1); k < double(bars.size()); ++k) {
                const PABar& b = bars[size_t(k)];
                if (b.low <= bar.high && b.high >= bar.low) {
                    mitigated = true;
                    break;
                }
            }
            return js::object({
                {u"side"_s, js::S(wantBullish ? u"bear"_s : u"bull"_s)},
                {u"time"_s, js::S(bar.time)},
                {u"bottom"_s, js::N(r4(bar.low))},
                {u"top"_s, js::N(r4(bar.high))},
                {u"mitigated"_s, js::B(mitigated)},
            });
        }
    }
    return OJson::null();
}

/// 等高 / 等低:两个几乎同价的摆动点
QList<OJson> equalLevels(const std::vector<Swing>& points, double tol) {
    QList<OJson> out;
    for (const QString& kind : {u"high"_s, u"low"_s}) {
        std::vector<const Swing*> same;
        for (const Swing& s : points)
            if (s.kind == kind) same.push_back(&s);
        for (size_t i = 0; i + 1 < same.size(); ++i) {
            const Swing& a = *same[i];
            const Swing& b = *same[i + 1];
            if (std::abs(a.price - b.price) <= tol * 0.6) {
                const double price = r4((a.price + b.price) / 2.0);
                const bool high = kind == u"high";
                out.append(js::object({
                    {u"kind"_s, js::S(kind)},
                    {u"price"_s, js::N(price)},
                    {u"times"_s, js::strings({a.time, b.time})},
                    {u"text"_s, js::S(u"%1 附近有等%2(%3 / %4),该价位%5方大概率堆着流动性"_s.arg(pf(price), high ? u"高"_s : u"低"_s, a.time, b.time, high ? u"上"_s : u"下"_s))},
                }));
            }
        }
    }
    return tail(out, 3);
}

// ---------------------------------------------------------------- K 线形态
/// 只看最后几根:形态是即时信息
QList<OJson> detectPatterns(const PABars& bars, double atrValue, qsizetype count = 4) {
    QList<OJson> out;
    const qsizetype n = qsizetype(bars.size());
    for (qsizetype i = std::max<qsizetype>(1, n - count); i < n; ++i) {
        const PABar& bar = bars[size_t(i)];
        const PABar& prev = bars[size_t(i - 1)];
        const double sp = span(bar);
        if (sp <= 0) continue;
        const double bd = body(bar);
        const double upper = bar.high - jm::max(bar.close, bar.open);
        const double lower = jm::min(bar.close, bar.open) - bar.low;
        QList<std::array<QString, 3>> hits;

        if (bd <= sp * 0.1) hits.append({u"十字星"_s, u"neutral"_s, u"开收几乎同价,多空拉锯"_s});
        // 影线按振幅折算,不按实体
        if (lower >= sp * 0.5 && upper <= sp * 0.2 && bd <= sp * 0.4) hits.append({u"长下影(锤子)"_s, u"bull"_s, u"下方被买回,卖压在低位被吸收"_s});
        if (upper >= sp * 0.5 && lower <= sp * 0.2 && bd <= sp * 0.4) hits.append({u"长上影(射击之星)"_s, u"bear"_s, u"上冲被打回,高位有抛压"_s});
        if (bullish(bar) && !bullish(prev) && bar.close >= prev.open && bar.open <= prev.close) hits.append({u"看涨吞没"_s, u"bull"_s, u"阳线整根吞掉前一根阴线实体"_s});
        if (!bullish(bar) && bullish(prev) && bar.close <= prev.open && bar.open >= prev.close) hits.append({u"看跌吞没"_s, u"bear"_s, u"阴线整根吞掉前一根阳线实体"_s});
        if (bar.high < prev.high && bar.low > prev.low) hits.append({u"内包(inside bar)"_s, u"neutral"_s, u"波动收敛,等一次突破定方向"_s});
        if (bar.high > prev.high && bar.low < prev.low) hits.append({u"外包(outside bar)"_s, u"neutral"_s, u"上下两边流动性都被扫,以收盘为准"_s});
        if (atrValue > 0 && bd >= sp * 0.7 && sp >= atrValue * 1.2)
            hits.append({u"大实体推动"_s, bullish(bar) ? u"bull"_s : u"bear"_s, u"单根振幅超过 1.2 倍 ATR 的方向性推动"_s});

        for (const auto& [name, direction, note] : hits)
            out.append(js::object({{u"name"_s, js::S(name)}, {u"direction"_s, js::S(direction)}, {u"note"_s, js::S(note)}, {u"time"_s, js::S(bar.time)},
                                   {u"bars_ago"_s, js::N(double(n - 1 - i))}}));
    }
    return out;
}

// ---------------------------------------------------------------- 环境
OJson marketContext(const PABars& bars, double atrValue) {
    std::vector<double> closes;
    for (const PABar& b : bars) closes.push_back(b.close);
    const double last = closes.back();
    const auto truthyN = [](double v) { return v != 0 && !std::isnan(v); };
    OJson out = js::object({
        {u"last"_s, js::N(r4(last))},
        {u"atr"_s, js::N(r4(atrValue))},
        {u"atr_pct"_s, truthyN(last) ? js::N(util::pyRound((atrValue / last) * 100.0, 2)) : OJson::null()},
        {u"change_pct"_s, truthyN(closes[0]) ? js::N(util::pyRound((last / closes[0] - 1.0) * 100.0, 2)) : OJson::null()},
    });

    const std::optional<double> ema20 = closes.size() >= 20 ? backtest::ema(closes, 20).back() : std::nullopt;
    const std::optional<double> ema50 = closes.size() >= 50 ? backtest::ema(closes, 50).back() : std::nullopt;
    const bool e20 = ema20 && truthyN(*ema20), e50 = ema50 && truthyN(*ema50);
    if (e20) {
        out.set(u"ema20"_s, js::N(r4(*ema20)));
        out.set(u"vs_ema20_pct"_s, js::N(util::pyRound((last / *ema20 - 1.0) * 100.0, 2)));
    }
    if (e20 && e50) {
        out.set(u"ema50"_s, js::N(r4(*ema50)));
        out.set(u"ema_stack"_s, js::S(*ema20 > *ema50 ? u"多头排列"_s : u"空头排列"_s));
    }

    const size_t window = std::min<size_t>(bars.size(), 60);
    double hi = -kInf, lo = kInf;
    for (size_t i = bars.size() - window; i < bars.size(); ++i) {
        hi = jm::max(hi, bars[i].high);
        lo = jm::min(lo, bars[i].low);
    }
    out.set(u"range_high"_s, js::N(r4(hi)));
    out.set(u"range_low"_s, js::N(r4(lo)));
    out.set(u"range_bars"_s, js::N(double(window)));
    out.set(u"range_pos_pct"_s, hi > lo ? js::N(util::pyRound(((last - lo) / (hi - lo)) * 100.0, 1)) : OJson::null());

    std::vector<double> vols;
    for (const PABar& b : bars)
        if (b.volume > 0) vols.push_back(b.volume);
    if (vols.size() >= 10 && bars.back().volume > 0) {
        double sum = 0, cnt = 0;
        for (size_t k = vols.size() - std::min<size_t>(20, vols.size()); k < vols.size(); ++k) {
            sum += vols[k];
            cnt += 1;
        }
        const double avg = sum / cnt;
        out.set(u"rel_volume"_s, truthyN(avg) ? js::N(util::pyRound(bars.back().volume / avg, 2)) : OJson::null());
    }

    const QString day = bars.back().time.left(10);
    std::vector<const PABar*> todays;
    for (const PABar& b : bars)
        if (b.time.left(10) == day) todays.push_back(&b);
    if (todays.size() >= 2) {
        double th = -kInf, tl = kInf;
        for (const PABar* b : todays) {
            th = jm::max(th, b->high);
            tl = jm::min(tl, b->low);
        }
        out.set(u"session"_s, js::object({{u"date"_s, js::S(day)}, {u"bars"_s, js::N(double(todays.size()))}, {u"open"_s, js::N(r4(todays[0]->open))},
                                          {u"high"_s, js::N(r4(th))}, {u"low"_s, js::N(r4(tl))}}));
    }
    return out;
}
}  // namespace

// ---------------------------------------------------------------- 打分
OJson subScores(const OJson& evidence) {
    struct Sub {
        QString key, label;
        double max;
    };
    const Sub subs[] = {{u"structure"_s, u"结构"_s, kWTrend + jm::max(kWChoch, kWBos) + kWEma},
                        {u"location"_s, u"位置"_s, kWPosition + kWLevel},
                        {u"confirm"_s, u"确认"_s, kWSweep + kWPattern + kWVolume}};
    OJson out = js::array();
    for (const Sub& s : subs) {
        double sum = 0;
        bool pos = false, neg = false;
        for (const OJson& e : evidence.items) {
            if (e.get(u"group"_s)->s != s.key) continue;
            const double w = e.get(u"weight"_s)->n;
            sum = sum + w;
            if (w > 0) pos = true;
            if (w < 0) neg = true;
        }
        out.items.append(js::object({{u"key"_s, js::S(s.key)}, {u"label"_s, js::S(s.label)}, {u"score"_s, js::N(util::pyRound(sum, 1))},
                                     {u"max"_s, js::N(s.max)}, {u"mixed"_s, js::B(pos && neg)}}));
    }
    return out;
}

namespace {
/// 打分只看已收盘的 K 线:bars 的最后一根就是最后一根收盘的
std::pair<double, OJson> score(const Trend& trend, const QList<OJson>& events, const OJson& ctx, const QList<OJson>& sweeps, const QList<OJson>& patterns,
                               const QList<OJson>& levels, double atrValue, const PABar& lastBar) {
    const double last = lastBar.close;
    OJson evidence = js::array();
    const auto add = [&](const QString& group, const QString& label, const QString& detail, double weight) {
        evidence.items.append(js::object({{u"group"_s, js::S(group)}, {u"label"_s, js::S(label)}, {u"detail"_s, js::S(detail)}, {u"weight"_s, js::N(util::pyRound(weight, 1))}}));
    };

    if (trend.trend == u"up") add(u"structure"_s, u"摆动结构"_s, trend.label, kWTrend);
    else if (trend.trend == u"down") add(u"structure"_s, u"摆动结构"_s, trend.label, -kWTrend);
    else add(u"structure"_s, u"摆动结构"_s, trend.label, 0.0);

    if (!events.isEmpty()) {
        const OJson& latest = events.last();
        const double sign = strAt(latest, u"direction"_s) == u"up" ? 1.0 : -1.0;
        const double weight = strAt(latest, u"kind"_s) == u"CHoCH" ? kWChoch : kWBos;
        add(u"structure"_s, u"最近一次结构事件"_s, strAt(latest, u"text"_s), sign * weight);
    }

    if (const auto pos = optNum(&ctx, u"range_pos_pct"_s)) {
        add(u"location"_s, u"区间位置"_s,
            u"收盘位于近 %1 根区间的 %2%"_s.arg(js::str(ctx.get(u"range_bars"_s)), util::fmtF(*pos, 0)) +
                u"(%1 ~ %2)"_s.arg(pfOf(ctx.get(u"range_low"_s)), pfOf(ctx.get(u"range_high"_s))),
            (*pos / 50.0 - 1.0) * kWPosition);
    }

    if (const OJson* stack = ctx.get(u"ema_stack"_s); js::truthy(stack)) {
        const bool bullishStack = stack->s == u"多头排列";
        const OJson* vs = ctx.get(u"vs_ema20_pct"_s);
        add(u"structure"_s, u"均线动能"_s,
            u"EMA20 %1 EMA50(%2),"_s.arg(bullishStack ? u"在上"_s : u"在下"_s, stack->s) +
                u"收盘相对 EMA20 %1%"_s.arg(util::fmtSF(js::truthy(vs) ? js::num(vs) : 0.0, 2)),
            kWEma * (bullishStack ? 1.0 : -1.0));
    }

    if (!sweeps.isEmpty()) {
        const OJson& latestSweep = sweeps.last();
        add(u"confirm"_s, u"流动性扫单"_s, strAt(latestSweep, u"text"_s), kWSweep * (strAt(latestSweep, u"direction"_s) == u"bull" ? 1.0 : -1.0));
    }

    QList<const OJson*> directional;
    for (const OJson& p : patterns)
        if (strAt(p, u"direction"_s) == u"bull" || strAt(p, u"direction"_s) == u"bear") directional << &p;
    if (!directional.isEmpty()) {
        double newest = kInf;
        for (const OJson* p : directional) newest = jm::min(newest, numAt(*p, u"bars_ago"_s));
        QStringList names;
        double net = 0;
        for (const OJson* p : directional) {
            if (numAt(*p, u"bars_ago"_s) != newest) continue;
            names << strAt(*p, u"name"_s);
            net += strAt(*p, u"direction"_s) == u"bull" ? 1 : -1;
        }
        if (net != 0) add(u"confirm"_s, u"近端形态"_s, u"%1(%2 根之前)"_s.arg(names.join(u"、"_s), n2s(newest)), kWPattern * (net > 0 ? 1.0 : -1.0));
    }

    if (atrValue > 0 && !levels.isEmpty()) {
        const OJson* near = &levels[0];
        for (const OJson& l : levels)
            if (std::abs(numAt(l, u"price"_s) - last) < std::abs(numAt(*near, u"price"_s) - last)) near = &l;
        if (std::abs(numAt(*near, u"price"_s) - last) <= atrValue * 0.35) {
            const bool atResistance = strAt(*near, u"side"_s) == u"resistance";
            add(u"location"_s, u"贴近关键位"_s,
                u"收盘紧贴%1 %2"_s.arg(atResistance ? u"阻力"_s : u"支撑"_s, pfOf(near->get(u"price"_s))) + u"(%1 次触碰)"_s.arg(js::str(near->get(u"touches"_s))),
                atResistance ? -kWLevel : kWLevel);
        }
    }

    // 放量算谁的,看放量的那一根自己收阳还是收阴
    if (const auto rel = optNum(&ctx, u"rel_volume"_s); rel && *rel >= 1.5) {
        const double sign = lastBar.close > lastBar.open ? 1.0 : lastBar.close < lastBar.open ? -1.0 : 0.0;
        add(u"confirm"_s, u"量能"_s,
            u"最后一根收盘的 K 线量能是近 20 根均量的 %1 倍,这一根"_s.arg(util::fmtF(*rel, 2)) +
                (sign > 0 ? u"收阳"_s : sign < 0 ? u"收阴"_s : u"开收同价,不记方向"_s),
            kWVolume * sign);
    }

    double total = 0;
    for (const OJson& e : evidence.items) total = total + e.get(u"weight"_s)->n;
    return {jm::max(-100.0, jm::min(100.0, total)), evidence};
}
}  // namespace

std::pair<QString, QString> biasOf(double s) {
    if (s >= 45) return {u"bullish"_s, u"看涨"_s};
    if (s >= 18) return {u"lean_bull"_s, u"偏多"_s};
    if (s <= -45) return {u"bearish"_s, u"看跌"_s};
    if (s <= -18) return {u"lean_bear"_s, u"偏空"_s};
    return {u"neutral"_s, u"中性 / 观望"_s};
}

// ---------------------------------------------------------------- 总装
OJson movingAverages(const PABars& bars, const std::vector<double>& periods, double count) {
    const double n = double(bars.size());
    const double start = jm::max(0, n - count);
    OJson out = js::object();
    for (double period : periods) {
        OJson series = js::array();
        for (double i = start; i < n; i += 1) {
            if (i + 1 < period) {
                series.items.append(OJson::null());
            } else {
                double total = 0;
                for (double j = i + 1 - period; j <= i; j += 1) total += bars[size_t(j)].close;
                series.items.append(js::N(r4(total / period)));
            }
        }
        out.set(n2s(period), series);
    }
    return out;
}

namespace {
struct Split {
    PABars bars;
    std::optional<PABar> open;
    std::optional<double> closesAt;
    std::optional<QString> waiting;
};

/// 把最后一根没走完的摘出来。不给 now = 历史切片,全部按已收盘;算不出最后一根几点走完的,拿不准就不让它进判定
Split splitForming(const PABars& all, const QString& timeframe, const std::optional<PaClock>& clock, bool extendedHours) {
    if (!clock || all.empty()) return {all, std::nullopt, std::nullopt, std::nullopt};
    const PABar& newest = all.back();
    const auto closesAt = barCloseEpochMs(newest.time, timeframe, clock->extendedSession.value_or(extendedHours));
    const double asOf = clock->barsAsOfMs.value_or(clock->epochMs);
    const std::optional<QString> lagging = clock->feed && (*clock->feed == u"delayed" || *clock->feed == u"unknown") ? clock->feed : std::nullopt;
    const double dataAsOf = asOf - (lagging ? domain::kDelayedFeedMaxMs : 0);
    if (closesAt && *closesAt <= dataAsOf) return {all, std::nullopt, closesAt, std::nullopt};
    const std::optional<QString> waiting = closesAt && *closesAt <= asOf ? lagging : std::nullopt;
    return {PABars(all.begin(), all.end() - 1), newest, closesAt, waiting};
}

/// 正在形成的那一根:把它当成已经收盘再走一遍同一套规则。只作提示
OJson formingBar(const PABars& all, const Split& split, double strength) {
    const PABar& open = *split.open;
    const std::vector<double> atrs = atrSeries(all);
    const StructureHistory live = structureHistory(all, [&](qsizetype i) { return tolOf(atrs[size_t(i)], all[size_t(i)].close); }, strength);
    const double index = double(all.size()) - 1;
    QStringList hints;
    for (const OJson& event : live.events) {
        if (numAt(event, u"index"_s) != index) continue;
        const bool up = strAt(event, u"direction"_s) == u"up";
        hints << u"若此刻收盘会记一次 %1:现价 %2 在前%3 "_s.arg(strAt(event, u"kind"_s), pfOf(event.get(u"close"_s)), up ? u"高"_s : u"低"_s) +
                     u"%1 之%2"_s.arg(pfOf(event.get(u"level"_s)), up ? u"上"_s : u"下"_s);
    }
    for (const OJson& sweep : live.sweeps) {
        if (numAt(sweep, u"index"_s) != index) continue;
        const bool bear = strAt(sweep, u"direction"_s) == u"bear";
        hints << u"若此刻收盘会记一次扫单:影线%1 %2,"_s.arg(bear ? u"上破前高"_s : u"下破前低"_s, pfOf(sweep.get(u"level"_s))) +
                     u"现价回到了它%1方"_s.arg(bear ? u"下"_s : u"上"_s);
    }
    return js::object({
        {u"time"_s, js::S(open.time)},
        {u"closes_at"_s, split.closesAt ? js::S(util::stampAt(*split.closesAt, QString::fromUtf16(util::kET))) : OJson::null()},
        {u"waiting"_s, split.waiting ? js::S(*split.waiting) : OJson::null()},
        {u"open"_s, js::N(open.open)},
        {u"high"_s, js::N(open.high)},
        {u"low"_s, js::N(open.low)},
        {u"close"_s, js::N(open.close)},
        {u"volume"_s, js::N(open.volume)},
        {u"hints"_s, js::strings(hints)},
    });
}

OJson makePlan(const QString& bias, const std::vector<Swing>& points, const QList<OJson>& levels, const QList<OJson>& gaps, const OJson& block, double atrValue,
               const OJson& ctx) {
    const OJson* resistance = nullptr;
    for (const OJson& l : levels)
        if (strAt(l, u"side"_s) == u"resistance") {
            resistance = &l;
            break;
        }
    const OJson* support = nullptr;
    for (qsizetype i = levels.size() - 1; i >= 0; --i)
        if (strAt(levels[i], u"side"_s) == u"support") {
            support = &levels[i];
            break;
        }
    const Swing* lastLow = nullptr;
    const Swing* lastHigh = nullptr;
    for (auto it = points.rbegin(); it != points.rend(); ++it) {
        if (!lastLow && it->kind == u"low") lastLow = &*it;
        if (!lastHigh && it->kind == u"high") lastHigh = &*it;
    }

    const bool isBull = bias == u"bullish" || bias == u"lean_bull";
    const bool isBear = bias == u"bearish" || bias == u"lean_bear";

    OJson plan = js::object({{u"resistance"_s, js::copyOrNull(resistance)}, {u"support"_s, js::copyOrNull(support)}, {u"watch"_s, js::array()}});
    const QString rangeBars = js::nullish(ctx.get(u"range_bars"_s)) ? u"0"_s : js::str(ctx.get(u"range_bars"_s));

    if (isBull && resistance) {
        plan.set(u"confirm"_s, js::S(u"收盘站上 %1(最近阻力,%2 次触碰)"_s.arg(pfOf(resistance->get(u"price"_s)), js::str(resistance->get(u"touches"_s))) +
                                     u"才算突破成立;只有影线穿过按扫单处理"_s));
    } else if (isBull) {
        plan.set(u"confirm"_s, js::S(u"上方在这段样本里没有留下前高:收盘已是近 %1 根的高位"_s.arg(rangeBars) + u"(区间上沿 %1),"_s.arg(pfOf(ctx.get(u"range_high"_s))) +
                                     u"没有可参照的突破确认位,追高缺少结构依据"_s));
    } else if (isBear && support) {
        plan.set(u"confirm"_s, js::S(u"收盘跌破 %1(最近支撑,%2 次触碰)"_s.arg(pfOf(support->get(u"price"_s)), js::str(support->get(u"touches"_s))) +
                                     u"才算破位成立;只有影线穿过按扫单处理"_s));
    } else if (isBear) {
        plan.set(u"confirm"_s, js::S(u"下方在这段样本里没有留下前低:收盘已是近 %1 根的低位"_s.arg(rangeBars) + u"(区间下沿 %1),"_s.arg(pfOf(ctx.get(u"range_low"_s))) +
                                     u"没有可参照的破位确认位"_s));
    } else {
        QStringList edges;
        for (const OJson* l : {support, resistance})
            if (l) edges << pfOf(l->get(u"price"_s));
        plan.set(u"confirm"_s, js::S(edges.size() == 2 ? u"区间 %1 之间来回,等某一端收盘突破再谈方向"_s.arg(edges.join(u" ~ "_s)) : u"结构未成形,等一次明确的收盘突破"_s));
    }

    if (isBull && lastLow) {
        plan.set(u"invalidation"_s, js::object({{u"price"_s, js::N(r4(lastLow->price))},
                                                {u"why"_s, js::S(u"跌破最近摆动低点 %1(%2)"_s.arg(pf(r4(lastLow->price)), lastLow->time) + u"则上升结构被破坏,看涨前提失效"_s)}}));
    } else if (isBear && lastHigh) {
        plan.set(u"invalidation"_s, js::object({{u"price"_s, js::N(r4(lastHigh->price))},
                                                {u"why"_s, js::S(u"站上最近摆动高点 %1(%2)"_s.arg(pf(r4(lastHigh->price)), lastHigh->time) + u"则下降结构被破坏,看跌前提失效"_s)}}));
    } else if (lastLow && lastHigh) {
        plan.set(u"invalidation"_s, js::object({{u"price"_s, OJson::null()},
                                                {u"why"_s, js::S(u"震荡中没有单一失效位;%1 与 "_s.arg(pf(r4(lastLow->price))) + u"%1 是这段区间的上下沿"_s.arg(pf(r4(lastHigh->price))))}}));
    }

    const QString want = isBull ? u"bull"_s : isBear ? u"bear"_s : QString();
    if (!want.isEmpty()) {
        OJson& watch = *plan.get(u"watch"_s);
        for (qsizetype i = gaps.size() - 1; i >= 0; --i) {
            const OJson& gap = gaps[i];
            if (strAt(gap, u"side"_s) == want) {
                watch.items.append(js::S(u"未回补 FVG %1 ~ %2"_s.arg(pfOf(gap.get(u"bottom"_s)), pfOf(gap.get(u"top"_s))) +
                                         u"(%1 留下,已回补 %2%)"_s.arg(strAt(gap, u"time"_s), util::fmtF(numAt(gap, u"filled_pct"_s), 0)) + u"——回踩到这里是顺势的观察点"_s));
                break;
            }
        }
        if (block.isObject() && strAt(block, u"side"_s) == want && !block.get(u"mitigated"_s)->b) {
            watch.items.append(js::S(u"订单块 %1 ~ %2"_s.arg(pfOf(block.get(u"bottom"_s)), pfOf(block.get(u"top"_s))) + u"(%1 那根),尚未被回踩"_s.arg(strAt(block, u"time"_s))));
        }
        if (const OJson* near = isBull ? support : resistance) {
            watch.items.append(js::S(u"关键位 %1(%2 次触碰,"_s.arg(pfOf(near->get(u"price"_s)), js::str(near->get(u"touches"_s))) +
                                     u"距收盘 %1%)"_s.arg(util::fmtSF(numAt(*near, u"distance_pct"_s), 2))));
        }
    }
    if (atrValue > 0) plan.set(u"atr_note"_s, js::S(u"当前 ATR %1:小于这个幅度的价差属于日常噪音,别当成突破"_s.arg(pf(r4(atrValue)))));
    return plan;
}

QStringList makeWarnings(OJson& result, const std::optional<PaClock>& clock, std::optional<double> closesAt, bool extendedHours) {
    const std::optional<double> nowEpochMs = clock ? std::optional(clock->epochMs) : std::nullopt;
    QStringList out;
    if (clock && clock->feed && *clock->feed == u"delayed") {
        out << u"行情是延迟的:券商给的是 15–20 分钟前的数据,现价与最新一根都不是此刻的;"_s + u"判定只算到数据确定到齐的那一根。"_s;
    }
    if (extendedHours) {
        out << u"含盘前盘后:那几段成交稀薄,ATR 会偏小、摆动点会偏碎,"_s + u"跨隔夜的「缺口」多半只是没人交易,不是真跳空。"_s;
    }
    const double barCount = numAt(result, u"bar_count"_s);
    if (barCount < 60) out << u"样本只有 %1 根 K 线,摆动结构的可靠性有限。"_s.arg(n2s(barCount));
    const QString trend = strAt(result, u"trend"_s);
    if (trend == u"range" || trend == u"unknown") out << u"结构未成形:震荡里做方向判断,胜率天然低于顺势。"_s;
    if (std::abs(numAt(result, u"score"_s)) < 18) out << u"多空证据接近抵消,这是「看不清」,不是「该进场」。"_s;
    if (const auto atrPct = optNum(result.get(u"context"_s), u"atr_pct"_s); atrPct && *atrPct < 0.05) {
        out << u"波动率极低(ATR 仅占价格 %1%),形态信号大概率是噪音。"_s.arg(util::fmtF(*atrPct, 2));
    }

    const auto age = barAgeSeconds(strAt(result, u"last_bar"_s), nowEpochMs);
    if (age && nowEpochMs) {
        result.set(u"age_seconds"_s, js::N(std::trunc(*age)));
        // 「行情停了」从最新一根走完那一刻起算;日线不报这一条
        const bool daily = tfSeconds(strAt(result, u"timeframe"_s)) >= 86'400;
        const double idle = !closesAt ? *age : (*nowEpochMs - *closesAt) / 1000.0;
        if (!daily && idle > 1800) {
            out << (!closesAt ? u"最后一根 K 线停在 %1,距现在 %2 分钟"_s.arg(strAt(result, u"last_bar"_s), n2s(std::trunc(*age / 60)))
                              : u"最后一根 K 线(%1)走完之后已经 %2 分钟没有新的 K 线"_s.arg(strAt(result, u"last_bar"_s), n2s(std::trunc(idle / 60)))) +
                       u"——可能是休市,也可能是行情延迟或订阅缺失。"_s;
        }
    }
    return out;
}

QStringList makeReadout(const OJson& result) {
    const OJson& ctx = *result.get(u"context"_s);
    const QString symbol = strAt(result, u"symbol"_s);
    QStringList lines{
        u"%1 %2:现价 %3,"_s.arg(symbol.isEmpty() ? u"标的"_s : symbol, strAt(result, u"timeframe_label"_s), pfOf(result.get(u"last"_s))) +
            u"%1(打分 %2/100)。"_s.arg(strAt(result, u"bias_label"_s), util::fmtSF(numAt(result, u"score"_s), 0)),
        u"结构:%1。"_s.arg(strAt(result, u"trend_label"_s)),
    };
    const OJson& events = *result.get(u"events"_s);
    if (!events.items.isEmpty()) lines << u"最近结构事件:%1。"_s.arg(strAt(events.items.last(), u"text"_s));
    const OJson& swings = *result.get(u"swings"_s);
    if (!swings.items.isEmpty()) {
        QStringList labels;
        for (qsizetype i = std::max<qsizetype>(0, swings.items.size() - 5); i < swings.items.size(); ++i) labels << strAt(swings.items[i], u"label"_s);
        lines << u"近端摆动序列:%1。"_s.arg(labels.join(u"→"_s));
    }
    if (const auto pos = optNum(&ctx, u"range_pos_pct"_s)) {
        lines << u"位置:近 %1 根区间 %2 ~ "_s.arg(js::str(ctx.get(u"range_bars"_s)), pfOf(ctx.get(u"range_low"_s))) +
                     u"%1,收盘落在 %2% 处。"_s.arg(pfOf(ctx.get(u"range_high"_s)), util::fmtF(*pos, 0));
    }
    const OJson& sweeps = *result.get(u"sweeps"_s);
    if (!sweeps.items.isEmpty()) lines << u"流动性:%1。"_s.arg(strAt(sweeps.items.last(), u"text"_s));
    QStringList fresh;
    for (const OJson& p : result.get(u"patterns"_s)->items)
        if (numAt(p, u"bars_ago"_s) <= 1 && fresh.size() < 3) fresh << u"%1(%2)"_s.arg(strAt(p, u"name"_s), strAt(p, u"note"_s));
    if (!fresh.isEmpty()) lines << u"近端形态:%1。"_s.arg(fresh.join(u"、"_s));
    const OJson& plan = *result.get(u"plan"_s);
    if (js::truthy(plan.get(u"confirm"_s))) lines << u"确认条件:%1。"_s.arg(strAt(plan, u"confirm"_s));
    if (const OJson* why = js::prop(plan.get(u"invalidation"_s), u"why"_s); js::truthy(why)) lines << u"失效条件:%1。"_s.arg(js::str(why));
    return lines;
}
}  // namespace

OJson analyze(const OJson& rows, const QString& symbol, const QString& timeframe, double strength, const std::optional<PaClock>& now, bool extendedHours) {
    const PABars all = toBars(rows);
    const Split split = splitForming(all, timeframe, now, extendedHours);
    const PABars& bars = split.bars;
    if (double(bars.size()) < domain::kMinBars) {
        throw PriceActionError(u"只有 %1 根%2 K 线,不足以读出结构(至少需要 %3 根)。"_s.arg(QString::number(bars.size()), split.open ? u"已收盘的"_s : QString(),
                                                                                              QString::number(domain::kMinBars)) +
                               u"换个更长的周期试试;如果这是刚开盘、K 线还在一根根长出来,过一会儿再看。"_s);
    }

    // 从这里往下,bars 全是已收盘的:最后一根就是判定算到的那一根
    const PABar& lastBar = bars.back();
    const std::vector<double> atrs = atrSeries(bars);
    const double atrValue = atrs.back();
    const double last = lastBar.close;
    const double tol = tolOf(atrValue, last);

    const StructureHistory history = structureHistory(bars, [&](qsizetype i) { return tolOf(atrs[size_t(i)], bars[size_t(i)].close); }, strength);
    const std::vector<Swing> points = labelSwings(history.points);
    const Trend trend = readTrend(points);
    const QList<OJson> levels = clusterLevels(bars, points, tol, last);
    const QList<OJson> gaps = findFvgs(bars, tol);
    const QList<OJson> patterns = detectPatterns(bars, atrValue);
    const OJson ctx = marketContext(bars, atrValue);
    const OJson block = orderBlock(bars, history.events.isEmpty() ? nullptr : &history.events.last());
    const QList<OJson> equals = equalLevels(points, tol);

    const auto [scoreValue, evidence] = score(trend, history.events, ctx, history.sweeps, patterns, levels, atrValue, lastBar);
    const auto [bias, biasLabel] = biasOf(scoreValue);
    const PABar& newest = all.back();

    OJson swings = js::array();
    for (size_t i = points.size() > 10 ? points.size() - 10 : 0; i < points.size(); ++i) swings.items.append(swingDict(points[i]));
    OJson chart = js::array();
    for (size_t i = all.size() > size_t(kChartBars) ? all.size() - size_t(kChartBars) : 0; i < all.size(); ++i) {
        const PABar& b = all[i];
        chart.items.append(js::object({{u"time"_s, js::S(b.time)}, {u"open"_s, js::N(b.open)}, {u"high"_s, js::N(b.high)}, {u"low"_s, js::N(b.low)},
                                       {u"close"_s, js::N(b.close)}, {u"volume"_s, js::N(b.volume)}}));
    }
    const OJson* label = js::prop(tfEntry(timeframe), u"label"_s);

    OJson result = js::object({
        {u"symbol"_s, js::S(symbol)},
        {u"timeframe"_s, js::S(timeframe)},
        {u"timeframe_label"_s, !js::nullish(label) ? *label : js::S(timeframe)},
        {u"bar_count"_s, js::N(double(bars.size()))},
        {u"first_bar"_s, js::S(bars[0].time)},
        {u"last_bar"_s, js::S(newest.time)},
        {u"closed_bar"_s, js::S(lastBar.time)},
        {u"forming"_s, split.open ? formingBar(all, split, strength) : OJson::null()},
        {u"last"_s, js::N(r4(newest.close))},
        {u"atr"_s, js::N(r4(atrValue))},
        {u"swing_strength"_s, js::N(strength)},
        {u"score"_s, js::N(util::pyRound(scoreValue, 1))},
        {u"bias"_s, js::S(bias)},
        {u"bias_label"_s, js::S(biasLabel)},
        {u"confidence"_s, js::N(util::pyRound(jm::min(std::abs(scoreValue) / 70.0, 1.0), 2))},
        {u"trend"_s, js::S(trend.trend)},
        {u"trend_label"_s, js::S(trend.label)},
        {u"swings"_s, swings},
        {u"events"_s, js::array(history.events)},
        {u"levels"_s, js::array(levels)},
        {u"fvgs"_s, js::array(gaps)},
        {u"order_block"_s, block},
        {u"sweeps"_s, js::array(history.sweeps)},
        {u"equal_levels"_s, js::array(equals)},
        {u"patterns"_s, js::array(patterns)},
        {u"context"_s, ctx},
        {u"evidence"_s, evidence},
        {u"sub_scores"_s, subScores(evidence)},
        {u"plan"_s, makePlan(bias, points, levels, gaps, block, atrValue, ctx)},
        // 图照旧画到最新一根:正在形成的那一根也在里面(只作图)
        {u"bars"_s, chart},
        {u"ma"_s, movingAverages(all)},
    });
    result.set(u"extended_hours"_s, js::B(extendedHours));
    // makeWarnings 半路把 age_seconds 加进去,键排在 warnings 前面(同 TS)
    const QStringList warnings = makeWarnings(result, now, split.closesAt, extendedHours);
    result.set(u"warnings"_s, js::strings(warnings));
    result.set(u"readout"_s, js::strings(makeReadout(result)));
    return result;
}

std::optional<double> barAgeSeconds(const QString& lastBar, std::optional<double> nowEpochMs) {
    if (!nowEpochMs) return std::nullopt;
    const auto stamp = parseBarTime(lastBar);
    if (!stamp) return std::nullopt;
    return (*nowEpochMs - util::wallToEpoch(*stamp, QString::fromUtf16(util::kET))) / 1000.0;
}

// ---------------------------------------------------------------- 给模型看的事实块
QString factsText(const OJson& result) {
    static const OJson empty = js::object();
    const auto orEmpty = [](const OJson* v) { return js::nullish(v) ? &empty : v; };
    const OJson* ctx = orEmpty(result.get(u"context"_s));
    const OJson* plan = orEmpty(result.get(u"plan"_s));
    const OJson* formingV = result.get(u"forming"_s);
    const OJson* forming = js::nullish(formingV) ? nullptr : formingV;
    const auto strOrDash = [&](std::initializer_list<const char16_t*> keys) {
        for (const char16_t* k : keys) {
            const OJson* v = result.get(QString::fromUtf16(k));
            if (js::truthy(v)) return js::str(v);
        }
        return u"-"_s;
    };
    QStringList lines{
        u"标的:%1;周期:%2;"_s.arg(strOrDash({u"symbol"}), strOrDash({u"timeframe_label"})) +
        u"%1K 线 %2 根,"_s.arg(forming ? u"已收盘 "_s : QString(), js::strOr(result.get(u"bar_count"_s), u"0"_s)) +
        u"最后一根 %1;"_s.arg(strOrDash({u"closed_bar", u"last_bar"})) + u"现价 %1;ATR %2。"_s.arg(pfOf(result.get(u"last"_s)), pfOf(result.get(u"atr"_s))),
    };
    if (forming) {
        const OJson* waiting = forming->get(u"waiting"_s);
        const OJson* closesAt = forming->get(u"closes_at"_s);
        QString head;
        if (js::truthy(waiting)) {
            head = u"数据未到齐:%1 那根按钟点 %2 已经走完,但"_s.arg(js::str(forming->get(u"time"_s)), js::str(closesAt)) +
                   (waiting->s == u"delayed" ? u"行情是延迟的"_s : u"还说不准行情是不是延迟的"_s) + u"(延迟档晚 15–20 分钟),它的数据可能还没到齐,先当作没走完;现价取自它。"_s;
        } else {
            head = u"正在形成:%1 那根还没收盘"_s.arg(js::str(forming->get(u"time"_s))) +
                   (js::truthy(closesAt) ? u"(%1 收盘)"_s.arg(js::str(closesAt)) : QString()) + u",现价取自它。"_s;
        }
        lines << head + u"下面的判定全部只算到已收盘的那一根,这一根只作提示。"_s;
        if (const OJson* hints = forming->get(u"hints"_s); js::isArr(hints))
            for (const OJson& h : hints->items) lines << u"未确认:%1(收盘之前不算数)。"_s.arg(js::str(&h));
    }
    const OJson* scoreV = result.get(u"score"_s);
    lines << u"软件判定:%1(打分 %2/100);"_s.arg(js::str(result.get(u"bias_label"_s)), util::fmtSF(js::nullish(scoreV) ? 0.0 : js::num(scoreV), 0)) +
                 u"结构:%1。"_s.arg(js::str(result.get(u"trend_label"_s)));
    const auto list = [&](const QString& k) -> const QList<OJson>& {
        static const QList<OJson> none;
        const OJson* v = result.get(k);
        return js::isArr(v) ? v->items : none;
    };
    const QList<OJson>& subs = list(u"sub_scores"_s);
    if (!subs.isEmpty()) {
        QStringList parts;
        for (const OJson& sub : subs) {
            const double sc = numAt(sub, u"score"_s);
            parts << u"%1 %2%3/%4%5"_s.arg(strAt(sub, u"label"_s), sc > 0 ? u"+"_s : QString(), n2s(sc), js::str(sub.get(u"max"_s)),
                                         js::truthy(sub.get(u"mixed"_s)) ? u"(组内多空都有)"_s : QString());
        }
        lines << u"子分(各自相加,互不抵消):%1。"_s.arg(parts.join(u";"_s));
    }
    const QList<OJson>& swings = list(u"swings"_s);
    if (!swings.isEmpty()) {
        QStringList parts;
        for (qsizetype i = std::max<qsizetype>(0, swings.size() - 6); i < swings.size(); ++i)
            parts << u"%1@%2"_s.arg(strAt(swings[i], u"label"_s), pfOf(swings[i].get(u"price"_s)));
        lines << u"摆动序列(旧→新):%1。"_s.arg(parts.join(u"、"_s));
    }
    const auto lastN = [](const QList<OJson>& xs, qsizetype k) { return xs.mid(std::max<qsizetype>(0, xs.size() - k)); };
    for (const OJson& event : lastN(list(u"events"_s), 3)) lines << u"结构事件:%1。"_s.arg(strAt(event, u"text"_s));
    const QList<OJson>& levels = list(u"levels"_s);
    if (!levels.isEmpty()) {
        QStringList parts;
        for (const OJson& l : levels)
            parts << u"%1 %2"_s.arg(strAt(l, u"side"_s) == u"resistance" ? u"阻力"_s : u"支撑"_s, pfOf(l.get(u"price"_s))) +
                         u"(%1 次触碰,距收盘 %2%)"_s.arg(js::str(l.get(u"touches"_s)), util::fmtSF(numAt(l, u"distance_pct"_s), 2));
        lines << u"关键位:%1。"_s.arg(parts.join(u";"_s));
    }
    for (const OJson& gap : lastN(list(u"fvgs"_s), 2)) {
        lines << u"未回补 FVG(%1):"_s.arg(strAt(gap, u"side"_s) == u"bull" ? u"看涨"_s : u"看跌"_s) +
                     u"%1 ~ %2,%3 留下,"_s.arg(pfOf(gap.get(u"bottom"_s)), pfOf(gap.get(u"top"_s)), strAt(gap, u"time"_s)) +
                     u"已回补 %1%。"_s.arg(util::fmtF(numAt(gap, u"filled_pct"_s), 0));
    }
    if (const OJson* block = result.get(u"order_block"_s); js::truthy(block)) {
        lines << u"订单块(%1):"_s.arg(strAt(*block, u"side"_s) == u"bull" ? u"看涨"_s : u"看跌"_s) +
                     u"%1 ~ %2,%3;"_s.arg(pfOf(block->get(u"bottom"_s)), pfOf(block->get(u"top"_s)), strAt(*block, u"time"_s)) +
                     (js::truthy(block->get(u"mitigated"_s)) ? u"已被回踩"_s : u"尚未回踩"_s) + u"。"_s;
    }
    for (const OJson& sweep : lastN(list(u"sweeps"_s), 2)) lines << u"流动性扫单:%1。"_s.arg(strAt(sweep, u"text"_s));
    for (const OJson& eq : lastN(list(u"equal_levels"_s), 2)) lines << u"等高/等低:%1。"_s.arg(strAt(eq, u"text"_s));
    QStringList fresh;
    for (const OJson& p : list(u"patterns"_s))
        if (numAt(p, u"bars_ago"_s) <= 2) fresh << u"%1(%2 根前,%3)"_s.arg(strAt(p, u"name"_s), js::str(p.get(u"bars_ago"_s)), strAt(p, u"note"_s));
    if (!fresh.isEmpty()) lines << u"近端 K 线形态:%1。"_s.arg(fresh.join(u";"_s));
    if (const auto pos = optNum(ctx, u"range_pos_pct"_s)) {
        const OJson* vs = ctx->get(u"vs_ema20_pct"_s);
        const OJson* stack = ctx->get(u"ema_stack"_s);
        lines << u"区间:近 %1 根 %2 ~ %3,"_s.arg(js::str(ctx->get(u"range_bars"_s)), pfOf(ctx->get(u"range_low"_s)), pfOf(ctx->get(u"range_high"_s))) +
                     u"收盘在 %1% 处;相对 EMA20 "_s.arg(util::fmtF(*pos, 0)) + u"%1%;"_s.arg(vs ? pfOf(vs) : u"None"_s) +
                     (js::truthy(stack) ? js::str(stack) : u"均线数据不足"_s) + u"。"_s;
    }
    if (const auto rel = optNum(ctx, u"rel_volume"_s)) lines << u"量能:最后一根收盘的 K 线是近 20 根均量的 %1 倍。"_s.arg(util::fmtF(*rel, 2));
    if (const OJson* session = ctx->get(u"session"_s); js::truthy(session)) {
        lines << u"当日(%1):开 %2,高 %3,"_s.arg(strAt(*session, u"date"_s), pfOf(session->get(u"open"_s)), pfOf(session->get(u"high"_s))) +
                     u"低 %1,已走 %2 根。"_s.arg(pfOf(session->get(u"low"_s)), js::str(session->get(u"bars"_s)));
    }
    if (const OJson* higher = result.get(u"htf"_s); js::truthy(higher)) {
        const OJson* sup = higher->get(u"support"_s);
        const OJson* res = higher->get(u"resistance"_s);
        const OJson* closed = higher->get(u"closed_bar"_s);
        const OJson* agreeText = js::prop(result.get(u"agreement"_s), u"text"_s);
        lines << u"高周期(%1,算到 %2 那根收盘):"_s.arg(js::str(higher->get(u"timeframe_label"_s)), js::truthy(closed) ? js::str(closed) : u"-"_s) +
                     u"%1,%2;"_s.arg(js::str(higher->get(u"bias_label"_s)), js::str(higher->get(u"trend_label"_s))) +
                     u"支撑 %1 / "_s.arg(!js::nullish(sup) ? pfOf(sup) : u"该样本内无"_s) + u"阻力 %1。"_s.arg(!js::nullish(res) ? pfOf(res) : u"该样本内无"_s) +
                     (js::truthy(agreeText) ? js::str(agreeText) : QString());
    }
    if (const OJson* c = plan->get(u"confirm"_s); js::truthy(c)) lines << u"软件给的确认条件:%1。"_s.arg(js::str(c));
    if (const OJson* why = js::prop(plan->get(u"invalidation"_s), u"why"_s); js::truthy(why)) lines << u"软件给的失效条件:%1。"_s.arg(js::str(why));
    for (const OJson& note : list(u"warnings"_s)) lines << u"软件警告:"_s + js::str(&note);
    lines << u"以上全部由软件按 K 线算出。请只解读,不要新造价格。"_s;
    return lines.join(u'\n');
}

OJson htfSummary(const OJson& result) {
    static const OJson empty = js::object();
    const OJson* planV = result.get(u"plan"_s);
    const OJson* plan = js::nullish(planV) ? &empty : planV;
    const OJson* events = result.get(u"events"_s);
    const OJson* lastEvent = js::isArr(events) && !events->items.isEmpty() ? events->items.last().get(u"text"_s) : nullptr;
    const auto priceOf = [&](const QString& k) {
        const OJson* v = js::prop(plan->get(k), u"price"_s);
        return js::nullish(v) ? OJson::null() : *v;
    };
    return js::object({
        {u"timeframe"_s, js::copyOrNull(result.get(u"timeframe"_s))},
        {u"timeframe_label"_s, js::copyOrNull(result.get(u"timeframe_label"_s))},
        {u"bias"_s, js::copyOrNull(result.get(u"bias"_s))},
        {u"bias_label"_s, js::copyOrNull(result.get(u"bias_label"_s))},
        {u"score"_s, js::copyOrNull(result.get(u"score"_s))},
        {u"trend_label"_s, js::copyOrNull(result.get(u"trend_label"_s))},
        {u"last_event"_s, js::nullish(lastEvent) ? OJson::null() : *lastEvent},
        {u"resistance"_s, priceOf(u"resistance"_s)},
        {u"support"_s, priceOf(u"support"_s)},
        {u"closed_bar"_s, js::copyOrNull(result.get(u"closed_bar"_s))},
    });
}

OJson agreement(const OJson& primary, const OJson* higher) {
    if (!js::truthy(higher)) return js::object({{u"state"_s, js::S(u"unknown"_s)}, {u"text"_s, js::S(u"没有高周期数据可对照。"_s)}});
    const auto sign = [](const QString& bias) {
        if (bias == u"bullish" || bias == u"lean_bull") return 1;
        if (bias == u"bearish" || bias == u"lean_bear") return -1;
        return 0;
    };
    const int a = sign(strAt(primary, u"bias"_s));
    const int b = sign(strAt(*higher, u"bias"_s));
    const QString tfl = strAt(*higher, u"timeframe_label"_s), bl = strAt(*higher, u"bias_label"_s);
    if (b == 0) return js::object({{u"state"_s, js::S(u"unclear"_s)}, {u"text"_s, js::S(u"%1 方向不明,低周期信号缺少高周期背书。"_s.arg(tfl))}});
    // 不明的是本周期自己:别把这句话安到高周期头上
    if (a == 0) return js::object({{u"state"_s, js::S(u"unclear"_s)}, {u"text"_s, js::S(u"本周期自己方向不明,谈不上顺势逆势;%1 是%2。"_s.arg(tfl, bl))}});
    if (a == b) return js::object({{u"state"_s, js::S(u"aligned"_s)}, {u"text"_s, js::S(u"与 %1(%2)同向,属于顺势。"_s.arg(tfl, bl))}});
    return js::object({{u"state"_s, js::S(u"conflict"_s)}, {u"text"_s, js::S(u"与 %1(%2)相反,属于逆势"_s.arg(tfl, bl) + u"——这类信号更容易被打回。"_s)}});
}

}  // namespace ibkr::analysis::priceaction
