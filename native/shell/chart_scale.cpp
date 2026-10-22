#include "shell/chart_scale.h"

// 这一帧里的字、框、线都是只写前几个字段的聚合初始化(后面的字段有默认值:不透明、没有底色、实线):是有意的,不报
#if defined(__clang__)
#pragma clang diagnostic ignored "-Wmissing-field-initializers"
#elif defined(__GNUC__)
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"
#endif

#include "shell/jsvalue.h"

#include "util/jsmath.h"

#include <QDateTime>
#include <QRegularExpression>
#include <QTimeZone>

#include <algorithm>
#include <cmath>
#include <limits>
#include <map>

namespace ibkr::shell::chart {

using namespace Qt::StringLiterals;

namespace {

constexpr double kEps = 1e-14;
bool greaterOrEqual(double a, double b, double eps) { return (b - a) <= eps; }
bool equalEps(double a, double b, double eps) { return std::abs(a - b) < eps; }
int evenUp(int v) { return v + (v % 2); }

// ---- 价格轴(库的 PriceTickSpanCalculator / PriceTickMarkBuilder)---------------------------------------------------
/// base = 10^dec(价格的最小变动 10^-dec 取倒数):十进制,小数段的除数是 2 / 2.5 / 2
double tickSpanWith(double high, double low, double maxTickSpan, double base, const QList<double>& integral) {
    const double minMovement = base == 0 ? 0 : 1 / base;
    const QList<double> fractional{2, 2.5, 2};
    double span = std::pow(10.0, std::max(0.0, std::ceil(ibkr::util::jsmath::log10(high - low))));
    int index = 0;
    double c = integral[0];
    while (true) {
        const bool largerMinMovement = greaterOrEqual(span, minMovement, kEps) && span > minMovement + kEps;
        const bool largerMax = greaterOrEqual(span, maxTickSpan * c, kEps);
        const bool larger1 = greaterOrEqual(span, 1, kEps);
        if (!(largerMinMovement && largerMax && larger1)) break;
        span /= c;
        c = integral[++index % integral.size()];
    }
    if (span <= minMovement + kEps) span = minMovement;
    span = std::max(1.0, span);
    if (equalEps(span, 1, kEps)) {
        index = 0;
        c = fractional[0];
        while (greaterOrEqual(span, maxTickSpan * c, kEps) && span > minMovement + kEps) {
            span /= c;
            c = fractional[++index % fractional.size()];
        }
    }
    return span;
}

/// 库的 TickMarkWeight:年 70 / 月 60 / 日 50 / 12 时 33 … / 分 20 / 秒 10 / 不到一秒 0
int weightByTime(qint64 cur, qint64 prev) {
    const QDateTime a = QDateTime::fromSecsSinceEpoch(cur, QTimeZone::UTC), b = QDateTime::fromSecsSinceEpoch(prev, QTimeZone::UTC);
    if (a.date().year() != b.date().year()) return 70;
    if (a.date().month() != b.date().month()) return 60;
    if (a.date().day() != b.date().day()) return 50;
    static const QList<QPair<qint64, int>> divisors{{1, 10}, {60, 20}, {300, 21}, {1800, 22}, {3600, 30}, {10800, 31}, {21600, 32}, {43200, 33}};
    for (qsizetype i = divisors.size() - 1; i >= 0; --i) {
        const qint64 d = divisors[i].first;
        // 库按毫秒整除;按秒的时间戳整秒相减一样
        if (qint64(std::floor(double(prev) / double(d))) != qint64(std::floor(double(cur) / double(d)))) return divisors[i].second;
    }
    return 0;
}

int weightToType(int weight, bool timeVisible) {
    switch (weight) {
        case 0:
        case 10: return timeVisible ? 3 : 2;
        case 20: case 21: case 22: case 30: case 31: case 32: case 33: return timeVisible ? 3 : 2;
        case 50: return 2;
        case 60: return 1;
        case 70: return 0;
    }
    return 2;
}

struct Mark {
    int index;
    int weight;
};

/// 库的 TickMarks.build:从最重的一档往轻的放,和已放下的离得够远才放
QList<Mark> buildMarks(const QList<int>& weights, int maxIndexesPerMark) {
    std::map<int, QList<Mark>, std::greater<int>> byWeight;
    for (qsizetype i = 0; i < weights.size(); ++i) byWeight[weights[i]].append({int(i), weights[i]});
    QList<Mark> marks;
    for (const auto& [weight, current] : byWeight) {
        const QList<Mark> prev = marks;
        marks.clear();
        qsizetype ptr = 0;
        double rightIndex = std::numeric_limits<double>::infinity(), leftIndex = -std::numeric_limits<double>::infinity();
        for (const Mark& mark : current) {
            while (ptr < prev.size()) {
                const Mark& last = prev[ptr];
                if (last.index < mark.index) {
                    ++ptr;
                    marks << last;
                    leftIndex = last.index;
                    rightIndex = std::numeric_limits<double>::infinity();
                } else {
                    rightIndex = last.index;
                    break;
                }
            }
            if (rightIndex - mark.index >= maxIndexesPerMark && mark.index - leftIndex >= maxIndexesPerMark) {
                marks << mark;
                leftIndex = mark.index;
            }
        }
        for (; ptr < prev.size(); ++ptr) marks << prev[ptr];
    }
    return marks;
}

/// optimalCandlestickWidth(设备像素)
int candleWidth(double barSpacing, double pr) {
    if (barSpacing >= 2.5 && barSpacing <= 4) return int(std::floor(3 * pr));
    const double coeff = 1 - 0.2 * ibkr::util::jsmath::atan(std::max(4.0, barSpacing) - 4) / (M_PI * 0.5);
    const int res = int(std::floor(barSpacing * coeff * pr));
    const int scaled = int(std::floor(barSpacing * pr));
    return std::max(int(std::floor(pr)), std::min(res, scaled));
}

double jsMathRound(double v) { return jsRound(v); }

}  // namespace

double Frame::y(double price) const {
    const double h = paneH.isEmpty() ? 0 : paneH[0];
    const double ih = h - topMargin - bottomMargin;
    return h - 1 - (bottomMargin + (ih - 1) * (price - minValue) / (maxValue - minValue));
}

double Frame::priceAt(double yy) const {
    const double h = paneH.isEmpty() ? 0 : paneH[0];
    const double ih = h - topMargin - bottomMargin;
    return minValue + (maxValue - minValue) * ((h - 1 - yy - bottomMargin) / (ih - 1));
}

View fitView(const Normalized& norm, double paneW) {
    View v;
    v.fit = false;
    const int n = int(norm.times.size());
    v.barSpacing = n > 0 ? paneW / n : 6;
    v.rightOffset = 0;
    v.paneW = paneW;
    return v;
}

namespace {

/// 库的 _correctBarSpacing / _correctOffset(左右都钉住:fixLeftEdge / fixRightEdge)
View corrected(View v, int n, double paneW) {
    const double minBs = n > 0 ? paneW / n : 0;
    const double maxBs = paneW * 0.5;
    v.barSpacing = std::clamp(v.barSpacing, minBs, std::max(minBs, maxBs));
    const double minRo = 0 - (n - 1) - 1 + paneW / v.barSpacing;
    v.rightOffset = std::max(v.rightOffset, minRo);
    v.rightOffset = std::min(v.rightOffset, 0.0);
    v.paneW = paneW;
    return v;
}

}  // namespace

View resizeView(const View& view, int n, double newW) {
    if (!(newW > 0) || view.paneW == newW) return view;
    View v = view;
    const double oldW = view.paneW;
    if (oldW > 0) {
        // 缩放之前的可见左沿(库先取 previousVisibleRange 再改宽)
        const double prevFrom = view.rightOffset + (n - 1) - oldW / view.barSpacing + 1;
        v.barSpacing = view.barSpacing * newW / oldW;
        // 照库写的;左右都钉住(fixLeftEdge + fixRightEdge)时随后的 corrected() 总会把它夹回左沿,这一步不改结果
        if (prevFrom <= 0) v.rightOffset -= jsMathRound((oldW - newW) / v.barSpacing) + 1;
    }
    return corrected(v, n, newW);
}

View viewOf(const Frame& f, const View& previous) { return View{false, f.barSpacing, f.rightOffset, previous.priceRange, f.paneW}; }

View scrollView(const Frame& f, const View& start, double dx) {
    View v = start;
    v.fit = false;
    v.rightOffset = start.rightOffset + dx / f.barSpacing;
    return corrected(v, f.base + 1, f.paneW);
}

View scaleTimeView(const Frame& f, const View& start, double startX, double x) {
    const double w = f.paneW;
    const double now = std::clamp(w - x, 0.0, w), from = std::clamp(w - startX, 0.0, w);
    if (now == 0 || from == 0) return start;
    View v = start;
    v.fit = false;
    v.barSpacing = start.barSpacing * now / from;
    return corrected(v, f.base + 1, f.paneW);
}

View zoomView(const Frame& f, double zoomX, double scale) {
    // 库的 ChartModel.zoomTime:指针的横坐标夹在 [1, 图区宽]
    zoomX = std::max(1.0, std::min(zoomX, f.paneW));
    const auto floatIndex = [](double x, double paneW, double bs, double base, double ro) {
        const double delta = (paneW - 1 - x) / bs;
        return jsMathRound((base + ro - delta) * 1000000) / 1000000;
    };
    View v{false, f.barSpacing, f.rightOffset, std::nullopt, f.paneW};
    const double at = floatIndex(zoomX, f.paneW, f.barSpacing, f.base, f.rightOffset);
    v.barSpacing = f.barSpacing + scale * (f.barSpacing / 10);
    v = corrected(v, f.base + 1, f.paneW);
    // 缩放后把指针下的那一根挪回原处
    v.rightOffset = v.rightOffset + (at - floatIndex(zoomX, f.paneW, v.barSpacing, f.base, v.rightOffset));
    return corrected(v, f.base + 1, f.paneW);
}

QPair<double, double> scalePriceRange(const Frame& f, QPair<double, double> startRange, double startY, double y) {
    const double h = f.paneH.isEmpty() ? 0 : f.paneH[0];
    const double start = h - startY;
    double x = h - y;
    if (x < 0) x = 0;
    const double coeff = std::max((start + (h - 1) * 0.2) / (x + (h - 1) * 0.2), 0.1);
    const double center = (startRange.first + startRange.second) * 0.5;
    if (startRange.second == startRange.first) return startRange;
    return {center + (startRange.first - center) * coeff, center + (startRange.second - center) * coeff};
}

QPair<double, double> shiftPriceRange(const Frame& f, QPair<double, double> startRange, double startY, double y) {
    const double h = f.paneH.isEmpty() ? 0 : f.paneH[0];
    const double ih = h - f.topMargin - f.bottomMargin;
    const double perPixel = (startRange.second - startRange.first) / (ih - 1);
    const double delta = (y - startY) * perPixel;
    return {startRange.first + delta, startRange.second + delta};
}

View viewForRange(const Frame& f, double from, double to) {
    View v{false, f.paneW / (to - from + 1), to - f.base, std::nullopt, f.paneW};
    return corrected(v, f.base + 1, f.paneW);
}

Frame layoutFrame(const Spec& spec, const Normalized& norm, double width, double height, const View& view, const Measure& measure,
                  std::optional<Hover> hover, double pr) {
    Frame f;
    // 库的 suggestChartSize:宽高取偶
    const int W = int(std::floor(width)) - int(std::floor(width)) % 2;
    const int H = int(std::floor(height)) - int(std::floor(height)) % 2;
    f.width = W;
    f.height = H;
    const int n = int(norm.times.size());
    const auto full = n >= 2 ? priceRange(spec, norm, 0, n - 1) : std::nullopt;
    bool hasData = false;
    for (const auto& b : norm.barAt) hasData = hasData || b.has_value();
    for (const auto& vs : norm.lineValues)
        for (const auto& v : vs) hasData = hasData || v.has_value();
    if (n < 2 || !hasData || !full) {
        f.notice = u"数据不足,无法成图"_s;
        return f;
    }
    // 图区没有宽(Loader 先建出 0 尺寸的项、窗口窄过价格轴):不进计算(库的 setWidth 对 ≤ 0 的宽也是不理)
    if (W - kAxisMinW <= 0 || H <= 0) {
        f.notice = u"窗口太窄"_s;
        return f;
    }
    f.dec = decimals(spec, norm, height);
    const bool vol = hasVolume(spec, norm);
    const double hdr = headerPx(spec);
    const double minMove = std::pow(10.0, -f.dec);
    const double base10 = std::round(1 / minMove);

    // ---- 窗格(库的 _adjustSizeImpl;比例是引擎按像素给的 stretch factor)
    f.timeAxisH = evenUp(int(std::ceil(1 + 5 + kFontPx + 3 * kFontPx / 12 * 2 + 4 * kFontPx / 12)));
    const int separators = vol ? 1 : 0;
    const double totalPane = std::max(0.0, H - separators - f.timeAxisH);
    const double priceHE = std::max(1.0, height - kEngineTimeAxisH - (vol ? kVolumeH : 0));
    if (vol) {
        const double p0 = std::max(2.0, jsMathRound(priceHE * totalPane / (priceHE + kVolumeH) * pr) / pr);
        f.paneH = {p0, std::max(2.0, std::ceil((totalPane - p0) * pr) / pr)};
    } else {
        f.paneH = {std::max(2.0, std::ceil(totalPane * pr) / pr)};
    }
    const double pane0 = f.paneH[0];
    f.topMargin = std::min(0.5, hdr / priceHE) * pane0;
    f.bottomMargin = 0;
    // 太窄:图藏起来(engine.ts 的 layout)
    if (width - kAxisMinW < 60 || priceHE - hdr < 50) f.notice = u"窗口太窄"_s;

    f.base = n - 1;
    // 价格轴宽要看刻度的字,刻度又看可见范围(跟着图区宽):库是上一帧量的宽、下一帧用;这里迭代到不动
    QList<QPair<double, QString>> ticks;
    double axisW = kAxisMinW;
    for (int iter = 0; iter < 4; ++iter) {
        f.paneW = std::max(0.0, W - axisW);
        const View v = view.fit ? fitView(norm, f.paneW) : corrected(resizeView(view, n, f.paneW), n, f.paneW);
        f.barSpacing = v.barSpacing;
        f.rightOffset = v.rightOffset;
        f.to = f.rightOffset + f.base;
        f.from = f.to - f.paneW / f.barSpacing + 1;
        // 价格区间:载体的 autoscale(engine.ts 的 autoscale)
        const int a = std::max(0, int(std::floor(f.from)));
        const int b = std::min(n - 1, int(std::ceil(f.to)));
        auto range = priceRange(spec, norm, std::min(a, b), std::max(a, b));
        if (!range) range = full;
        if (view.priceRange) range = view.priceRange;
        f.minValue = range->first;
        f.maxValue = range->second;
        if (f.minValue == f.maxValue) {
            f.minValue -= 5 * minMove;
            f.maxValue += 5 * minMove;
        }
        // 刻度
        ticks.clear();
        const double high0 = f.priceAt(0), low0 = f.priceAt(pane0 - 1);
        const double high = std::max(high0, low0), low = std::min(high0, low0);
        const double markH = std::ceil(kFontPx * 2.5);
        if (high > low) {
            const double maxTickSpan = (high - low) * markH / pane0;
            const double span = std::min({tickSpanWith(high, low, maxTickSpan, base10, {2, 2.5, 2}), tickSpanWith(high, low, maxTickSpan, base10, {2, 2, 2.5}),
                                          tickSpanWith(high, low, maxTickSpan, base10, {2.5, 2, 2})});
            double mod = std::fmod(high, span);
            mod += mod < 0 ? span : 0;
            const double minCoord = kFontPx / 2, maxCoord = pane0 - 1 - kFontPx / 2;
            for (double logical = high - mod; logical > low; logical -= span) {
                const double coord = f.y(logical);
                if (coord < minCoord || coord > maxCoord) continue;
                ticks.append({coord, fmtPrice(logical, f.dec)});
            }
        }
        // 轴宽:首尾两个刻度、轴上的标签、十字光标可能写的最宽的价(库的 optimalWidth)
        double maxW = 0;
        if (!ticks.isEmpty()) maxW = std::max(measure(ticks.first().second, kFontPx, false), measure(ticks.last().second, kFontPx, false));
        for (const HLine& h : spec.hlines)
            if (h.tag) maxW = std::max(maxW, measure(fmtPrice(h.price, f.dec), kFontPx, false));
        if (spec.last) maxW = std::max(maxW, measure(fmtPrice(*spec.last, f.dec), kFontPx, false));
        const double topV = f.priceAt(1), bottomV = f.priceAt(pane0 - 2);
        maxW = std::max({maxW, measure(fmtPrice(std::floor(std::min(topV, bottomV)) + 0.11111111111111, f.dec), kFontPx, false),
                         measure(fmtPrice(std::ceil(std::max(topV, bottomV)) - 0.11111111111111, f.dec), kFontPx, false)});
        const double padding = kFontPx / 12 * 5;
        const int optimal = evenUp(int(std::ceil(1 + 5 + padding + padding + 5 + (maxW > 0 ? maxW : 34))));
        const double next = evenUp(std::max(optimal, int(kAxisMinW)));
        if (next == axisW) break;
        axisW = next;
    }
    f.priceAxisW = axisW;
    f.ok = true;

    // ---- 价格刻度的字与横网格
    for (const auto& [coord, label] : ticks) {
        f.gridY << coord;
        f.texts.append({label, f.paneW + std::round(5 + kFontPx / 12 * 5), coord, u"left"_s, kFontPx, false, u"label2"_s});
    }

    // ---- 时间刻度(库的 TimeScale.marks)
    QList<int> weights(n, 0);
    {
        qint64 total = 0;
        for (int i = 1; i < n; ++i) {
            weights[i] = weightByTime(norm.stamps[i], norm.stamps[i - 1]);
            total += norm.stamps[i] - norm.stamps[i - 1];
        }
        if (n > 1) {
            const qint64 avg = qint64(std::ceil(double(total) / (n - 1)));
            weights[0] = weightByTime(norm.stamps[0], norm.stamps[0] - avg);
        }
    }
    const double maxLabelW = (kFontPx + 4) * 5 / 8 * 8;
    const int indexPerLabel = int(jsMathRound(maxLabelW / f.barSpacing));
    const QList<Mark> marks = buildMarks(weights, int(std::ceil(maxLabelW / f.barSpacing)));
    const int firstBar = int(std::floor(f.from)), lastBar = int(std::ceil(f.to));
    int maxWeight = 0;
    QList<Mark> shown;
    for (const Mark& m : marks)
        if (m.index >= firstBar && m.index <= lastBar) {
            shown << m;
            maxWeight = std::max(maxWeight, m.weight);
        }
    const double timeTop = f.paneH[0] + (vol ? 1 + f.paneH[1] : 0);
    static const QRegularExpression digits(u"[1-9]"_s);
    for (const Mark& m : shown) {
        const bool bold = m.weight >= maxWeight;
        const QString label = tickMarkLabel(norm, norm.stamps[m.index], weightToType(m.weight, norm.intraday));
        double coord = f.x(m.index);
        f.gridX << coord;
        const bool align = f.barSpacing > maxLabelW / 2 ? false : (m.index <= 0 + indexPerLabel) || (m.index >= n - 1 - indexPerLabel);
        if (align) {
            // 库量字走 TextWidthCache:键是把 1–9 换成 0 的那串(09:30 与 09:35 共用一条),谁先量谁说了算。
            // 先画的是不加粗的那一批:同一个键里有不加粗的,宽就是不加粗的
            const QString key = QString(label).replace(digits, u"0"_s);
            bool plainFirst = !bold;
            for (const Mark& o : shown)
                if (o.weight < maxWeight && QString(tickMarkLabel(norm, norm.stamps[o.index], weightToType(o.weight, norm.intraday))).replace(digits, u"0"_s) == key) plainFirst = true;
            const double w = measure(key, kFontPx, !plainFirst);
            const double left = std::floor(coord - w / 2) + 0.5;
            if (left < 0) coord += std::abs(left);
            else if (left + w > f.paneW) coord -= std::abs(f.paneW - (left + w));
        }
        f.texts.append({label, coord, timeTop + 1 + 5 + 3 * kFontPx / 12 + kFontPx / 2, u"center"_s, kFontPx, bold, u"label2"_s});
    }

    // ---- 蜡烛(库的 PaneRendererCandlesticks:先影线后实体;在设备像素上取整,再折回逻辑像素)
    const auto visible = [&](int i) { return i >= firstBar && i <= lastBar; };
    {
        int bw = candleWidth(f.barSpacing, pr);
        const int fpr = int(std::floor(pr));
        if (bw >= 2 && (fpr % 2) != (bw % 2)) --bw;
        int wick = std::min(fpr, int(std::floor(f.barSpacing * pr)));
        wick = std::max(fpr, std::min(wick, bw));
        const int wickOffset = int(std::floor(wick * 0.5));
        std::optional<int> prevEdge;
        QList<RectItem> bodies;
        for (int i = 0; i < n; ++i) {
            if (!visible(i) || !norm.barAt[i]) continue;
            const Bar& b = *norm.barAt[i];
            const QString color = b.open <= b.close ? u"up"_s : u"down"_s;
            const double xi = f.x(i);
            const double oy = f.y(b.open), cy = f.y(b.close);
            const int top = int(jsMathRound(std::min(oy, cy) * pr)), bottom = int(jsMathRound(std::max(oy, cy) * pr));
            const int hi = int(jsMathRound(f.y(b.high) * pr)), lo = int(jsMathRound(f.y(b.low) * pr));
            const int sx = int(jsMathRound(pr * xi));
            int left = sx - wickOffset;
            const int right = left + wick - 1;
            if (prevEdge) {
                left = std::max(*prevEdge + 1, left);
                left = std::min(left, right);
            }
            const int w = right - left + 1;
            f.candles.append({left / pr, hi / pr, w / pr, (top - hi) / pr, color});
            f.candles.append({left / pr, (bottom + 1) / pr, w / pr, (lo - bottom) / pr, color});
            prevEdge = right;
            const int bl = int(jsMathRound(xi * pr)) - bw / 2;
            if (top <= bottom) bodies.append({bl / pr, top / pr, bw / pr, (bottom - top + 1) / pr, color});
        }
        f.candles << bodies;
    }

    // ---- 量柱(库的 PaneRendererHistogram,设备像素)
    if (vol) {
        f.volumeCap = volumeCap(norm);
        const double h1 = f.paneH[1];
        const double top1 = f.paneH[0] + 1;
        const auto vy = [&](double v) { return h1 - 1 - (h1 - 1) * v / f.volumeCap; };
        const int fpr = int(std::floor(pr));
        const int spacing = std::ceil(f.barSpacing * pr) <= 1 ? 0 : std::max(1, fpr);
        const int colW = int(jsMathRound(f.barSpacing * pr)) - spacing;
        struct Col {
            int index, left, right, rounded;
            double center;
            QString color;
            double y;
        };
        QList<Col> cols;
        for (int i = 0; i < n; ++i) {
            if (!visible(i) || !norm.barAt[i]) continue;
            const double v = norm.barAt[i]->volume.value_or(0);
            if (!(v > 0)) continue;
            const double xi = f.x(i) * pr;
            const int xr = int(jsMathRound(xi));
            Col c{i, 0, 0, xr, xi, norm.barAt[i]->close >= norm.barAt[i]->open ? u"up"_s : u"down"_s, vy(v)};
            if (colW % 2) {
                c.left = xr - (colW - 1) / 2;
                c.right = xr + (colW - 1) / 2;
            } else {
                c.left = xr - colW / 2;
                c.right = xr + colW / 2 - 1;
            }
            cols << c;
        }
        for (qsizetype k = 1; k < cols.size(); ++k) {
            Col& cur = cols[k];
            Col& prev = cols[k - 1];
            if (cur.index != prev.index + 1) continue;
            if (cur.left - prev.right != spacing + 1) {
                if (prev.rounded > prev.center) prev.right = cur.left - spacing - 1;
                else cur.left = prev.right + spacing + 1;
            }
        }
        int minW = int(std::ceil(f.barSpacing * pr));
        for (Col& c : cols) {
            if (c.right < c.left) c.right = c.left;
            minW = std::min(minW, c.right - c.left + 1);
        }
        if (spacing > 0 && minW < 4)
            for (Col& c : cols)
                if (c.right - c.left + 1 > minW) {
                    if (c.rounded > c.center) c.right -= 1;
                    else c.left += 1;
                }
        const int tick = std::max(1, fpr);
        const int baseY = int(jsMathRound((h1 - 1) * pr));
        const int topBase = baseY - tick / 2, bottomBase = topBase + tick;
        for (const Col& c : cols) {
            const int yy = int(jsMathRound(c.y * pr));
            int t, btm;
            if (yy <= topBase) {
                t = yy;
                btm = bottomBase;
            } else {
                t = topBase;
                btm = yy - tick / 2 + tick;
            }
            f.volumes.append({c.left / pr, top1 + t / pr, (c.right - c.left + 1) / pr, (btm - t) / pr, c.color, 0.5});
        }
        f.texts.append({u"满格 = %1(95 分位)"_s.arg(fmtVol(f.volumeCap)), f.paneW - 4, top1 + 7, u"right"_s, 9, false, u"label3"_s});
    }

    // ---- 叠加层(overlays.ts):坐标走上面的 x / y,图区是主图那一格(宽 paneW、高 pane0),上沿让出 hdr
    const double pw = f.paneW, ph = pane0;
    const double slot = f.barSpacing;
    const double rightEdge = f.x(norm.lastIdx) + slot / 2;
    const auto crisp = [](double v) { return jsMathRound(v) + 0.5; };
    const auto idxOf = [&](const std::optional<QString>& t) -> std::optional<int> {
        if (!t) return std::nullopt;
        const auto it = norm.idx.constFind(*t);
        return it == norm.idx.cend() ? std::nullopt : std::optional<int>(*it);
    };
    QList<TextItem> overlayTexts;
    for (const Band& bd : spec.bands) {
        const QString color = colorOr(bd.color);
        const auto fi = idxOf(bd.from), ti = idxOf(bd.to);
        if (bd.v) {
            const double from = fi ? f.x(*fi) - slot / 2 : 0;
            const double to = ti ? f.x(*ti) + slot / 2 : pw;
            if (to < 0 || from > pw) continue;
            f.under.append({from, hdr, std::max(to - from, 1.0), ph - hdr, color, bd.fill.value_or(0.06)});
            if (!bd.label.isEmpty()) overlayTexts.append({bd.label, from + 3, hdr + 7, u"left"_s, 9, false, color, 0.8});
            continue;
        }
        if (!bd.top || !bd.bottom) continue;
        const double y1 = f.y(*bd.top), y2 = f.y(*bd.bottom);
        const double top = std::max(hdr, std::min(y1, y2));
        const double bottom = std::min(ph, std::max(y1, y2));
        if (bottom <= hdr || top >= ph) continue;
        const double start = fi ? f.x(*fi) - slot / 2 : 0;
        const double end = ti ? f.x(*ti) + slot / 2 : rightEdge;
        if (end < 0 || start > pw) continue;
        f.under.append({start, top, std::max(end - start, 2.0), std::max(bottom - top, 1.0), color, bd.fill.value_or(0.07)});
        if (bd.stroke && *bd.stroke != 0)
            f.under.append({crisp(start), crisp(top), std::max(end - start, 2.0), std::max(bottom - top, 1.0), color, *bd.stroke, true, bd.dash});
    }
    for (const HLine& h : spec.hlines) {
        const double yy = f.y(h.price);
        if (yy < hdr || yy > ph) continue;
        f.underLines.append({{{0, crisp(yy)}, {pw, crisp(yy)}}, colorOr(h.color), h.alpha.value_or(0.5), h.width.value_or(1), h.dash});
    }
    // 折线:只画看得见的那一段(左右各多一根),空值断开;step 在半格处跳
    {
        const int a = std::max(0, int(std::floor(-f.x(0) / slot)) - 1);
        const int b = std::min(n - 1, int(std::ceil((pw - f.x(0)) / slot)) + 1);
        for (qsizetype l = 0; l < norm.lineValues.size(); ++l) {
            const Line& ln = spec.lines[l];
            PolyItem cur{{}, colorOr(ln.color), ln.alpha.value_or(0.9), ln.width > 0 ? ln.width : 1, ln.dash};
            double prevY = 0;
            for (int i = a; i <= b; ++i) {
                const auto v = norm.lineValues[l][i];
                if (!v) {
                    if (!cur.pts.isEmpty()) f.overLines << cur;
                    cur.pts.clear();
                    continue;
                }
                const double py = f.y(*v), px = f.x(i);
                if (!cur.pts.isEmpty() && ln.step) {
                    cur.pts.append({px - slot / 2, prevY});
                    cur.pts.append({px - slot / 2, py});
                }
                cur.pts.append({px, py});
                prevY = py;
            }
            if (!cur.pts.isEmpty()) f.overLines << cur;
        }
    }
    // 标记:圆点 / 三角 + 文字(按矩形避让)
    {
        QList<Rect> placed;
        for (const Marker& m : spec.markers) {
            const auto i = idxOf(m.time);
            const double py = f.y(m.price);
            if (!i || py < hdr || py > ph) continue;
            const double px = f.x(*i);
            if (px < -slot || px > pw + slot) continue;
            const QString color = colorOr(m.color);
            if (m.shape == u"tri-up") f.overShapes.append({{{px, py - 1}, {px - 4.5, py + 7}, {px + 4.5, py + 7}}, color, 1, 1, {}, true});
            else if (m.shape == u"tri-down") f.overShapes.append({{{px, py + 1}, {px - 4.5, py - 7}, {px + 4.5, py - 7}}, color, 1, 1, {}, true});
            else f.dots.append({px, py, 2.5, color});
            if (!m.label.isEmpty()) {
                const bool above = m.labelPos != u"below";
                const double w = measure(m.label, 9, false) + 4;
                const Rect r = placeLabel(placed, {px - w / 2, above ? py - 9 - 12 : py + 5, w, 12}, above ? -1 : 1);
                overlayTexts.append({m.label, px, r.y + 6, u"center"_s, 9, false, m.labelColor.isEmpty() ? color : m.labelColor, m.labelAlpha.value_or(0.95)});
            }
        }
    }
    // 竖线:顶部写字,靠右的写在线左边
    {
        struct VL {
            double px;
            QString color, text;
            bool left;
        };
        QList<VL> vlabels;
        for (const VLine& vl : spec.vlines) {
            const auto i = idxOf(vl.time);
            if (!i) continue;
            const double px = crisp(f.x(*i));
            if (px < 0 || px > pw) continue;
            const QString color = colorOr(vl.color);
            f.overLines.append({{{px, hdr}, {px, ph}}, color, 0.8, 1, vl.dash.value_or(QList<double>{3, 3})});
            if (!vl.label.isEmpty()) vlabels.append({px, color, vl.label, px > pw * 0.6});
        }
        QList<Rect> vplaced;
        for (const VL& v : vlabels) {
            const double w = measure(v.text, 10, false) + 6;
            const Rect r = placeLabel(vplaced, {v.left ? v.px - 4 - w : v.px + 4, hdr + 2, w, 13}, 1);
            overlayTexts.append({v.text, v.left ? v.px - 4 : v.px + 4, r.y + 6.5, v.left ? u"right"_s : u"left"_s, 10, false, v.color});
        }
    }
    // 现价点线
    if (spec.last) {
        const double ly = f.y(*spec.last);
        if (ly >= hdr && ly <= ph) f.overLines.append({{{0, crisp(ly)}, {pw, crisp(ly)}}, u"blue"_s, 1, 1, {1, 3}});
    }
    // 左侧小标签:区域的名字与关键位的名字,纵向避让
    {
        struct L {
            double x;
            QString text, color;
            double alpha;
        };
        QList<L> items;
        QList<Tag> tags;
        for (const Band& bd : spec.bands) {
            if (bd.v || bd.label.isEmpty() || !bd.top || !bd.bottom) continue;
            const double yHi = f.y(std::max(*bd.top, *bd.bottom)), yLo = f.y(std::min(*bd.top, *bd.bottom));
            if (yLo <= hdr || yHi >= ph) continue;
            const auto fi = idxOf(bd.from);
            const double lx = (fi ? f.x(*fi) - slot / 2 : 0) + 3;
            if (lx > pw) continue;
            tags.append({std::max(hdr, yHi) + 7, 0, false, int(items.size())});
            items.append({lx, bd.label, colorOr(bd.color), 0.8});
        }
        for (const HLine& h : spec.hlines) {
            if (h.label.isEmpty()) continue;
            const double yy = f.y(h.price);
            if (yy < hdr || yy > ph) continue;
            tags.append({yy - 6, 0, false, int(items.size())});
            items.append({3, h.label, colorOr(h.color), 0.85});
        }
        for (const Tag& t : layoutTags(tags, hdr, ph, 12))
            overlayTexts.append({items[t.id].text, std::max(3.0, items[t.id].x), t.ly, u"left"_s, 9, false, items[t.id].color, items[t.id].alpha});
    }
    // 轴上的价格标签:关键位与现价按 y 避让,现价钉住;被推开的在图区最右边画引线
    {
        struct T {
            double y;
            QString text, bg;
            double bgAlpha;
            bool pinned;
        };
        QList<T> raw;
        const auto visibleY = [&](double yy) { return yy >= std::min(hdr, ph / 2) && yy <= ph; };
        for (const HLine& h : spec.hlines) {
            if (!h.tag) continue;
            const double yy = f.y(h.price);
            if (!visibleY(yy)) continue;
            raw.append({yy, fmtPrice(h.price, f.dec), colorOr(h.color), 0.9, false});
        }
        if (spec.last) {
            const double yy = f.y(*spec.last);
            if (visibleY(yy)) raw.append({yy, fmtPrice(*spec.last, f.dec), u"blue"_s, 1, true});
        }
        QList<Tag> tags;
        for (qsizetype i = 0; i < raw.size(); ++i) tags.append({raw[i].y, 0, raw[i].pinned, int(i)});
        for (const Tag& t : layoutTags(tags, 0, ph, 20)) {
            const T& r = raw[t.id];
            TextItem ti{r.text, f.paneW + 5 + kFontPx / 12 * 5, t.ly, u"left"_s, kFontPx, false, u"#ffffff"_s};
            ti.bg = r.bg;
            ti.bgAlpha = r.bgAlpha;
            f.texts << ti;
            if (std::abs(t.ly - r.y) > 1) f.overLines.append({{{pw - 6, crisp(r.y)}, {pw, crisp(t.ly)}}, u"label"_s, 0.35, 1, {}});
        }
    }
    f.texts << overlayTexts;
    applyHover(f, spec, norm, hover);
    return f;
}

void applyHover(Frame& f, const Spec& spec, const Normalized& norm, std::optional<Hover> hover) {
    f.crossLines.clear();
    f.crossTexts.clear();
    f.hoverIdx.reset();
    f.headerRow.reset();
    f.readoutRow.clear();
    f.legendRow.clear();
    if (!f.ok) return;
    const int n = int(norm.times.size());
    const double pane0 = f.paneH[0], pw = f.paneW;
    const double timeTop = pane0 + (f.paneH.size() > 1 ? 1 + f.paneH[1] : 0);
    // ---- 顶部读数
    Helpers helpers;
    helpers.fmt = [dec = f.dec](double v) { return fmtPrice(v, dec); };
    helpers.fmtVol = fmtVol;
    helpers.timeLabel = timeLabel;
    // 指针下的那一根:十字光标的竖线吸到它,读数行也是它
    std::optional<int> pointerIdx;
    if (hover && hover->px >= 0 && hover->px < f.paneW && hover->py >= 0 && hover->py < timeTop) {
        const double logical = (hover->px - f.paneW + 1) / f.barSpacing + f.base + f.rightOffset - 0.5;
        pointerIdx = std::clamp(int(jsMathRound(logical)), 0, n - 1);
    }
    const std::optional<int> hoverIdx = pointerIdx;
    f.hoverIdx = hoverIdx;
    const int refIdx = hoverIdx.value_or(norm.lastIdx);
    if (spec.header) f.headerRow = spec.header(refIdx, helpers).value_or(Parts{});
    if (hoverIdx) {
        f.readoutRow = spec.readout ? spec.readout(*hoverIdx, helpers).value_or(Parts{}) : defaultReadout(spec, norm, *hoverIdx, f.dec);
    } else {
        f.legendRow = spec.legend;
    }
    // ---- 十字光标:竖线吸到那一根、横线跟着指针;两条轴上各一个标签
    if (pointerIdx) {
        const double cx = f.x(*pointerIdx);
        // 库的 LineStyle.Dashed:[2w, 2w](设备像素里线宽 = 像素比,折回逻辑像素是 [2, 2])
        QList<double> dash{2, 2};
        f.crossLines.append({{{cx, 0}, {cx, timeTop}}, u"label"_s, 0.45, 1, dash});
        if (hover->py < pane0) {
            f.crossLines.append({{{0, hover->py}, {pw, hover->py}}, u"label"_s, 0.45, 1, dash});
            TextItem price{fmtPrice(f.priceAt(hover->py), f.dec), f.paneW + 5 + kFontPx / 12 * 5, hover->py, u"left"_s, kFontPx, false, u"#ffffff"_s};
            price.bg = u"label"_s;
            f.crossTexts << price;
        }
        TextItem time{crosshairTime(norm, norm.stamps[*pointerIdx]), cx, timeTop + 1 + 5 + 3 * kFontPx / 12 + kFontPx / 2, u"center"_s, kFontPx, false, u"#ffffff"_s};
        time.bg = u"label"_s;
        f.crossTexts << time;
    }
}

}  // namespace ibkr::shell::chart
