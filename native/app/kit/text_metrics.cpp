#include "kit/text_metrics.h"

#include <QFont>
#include <QFontMetricsF>
#include <QGuiApplication>
#include <QHash>
#include <QMap>

#include <cmath>

namespace ibkr::kit {

using namespace Qt::StringLiterals;

namespace {

// 每个字形差多少像素(Chromium − Qt),按整数像素;三种字重差得不到 0.01,取平均
const QMap<int, double>& latin() {
    static const QMap<int, double> t{{9, -0.1638}, {10, -0.1171}, {11, -0.0546}, {12, 0.0073}, {13, 0.0861}, {14, 0.1646}, {15, 0.2421}, {16, 0.3174},
                                     {17, 0.4445}, {18, 0.4453}, {20, 0.4625}, {22, 0.2623}, {24, -0.0627}, {26, -0.202}, {28, -0.371}, {32, -0.3881}};
    return t;
}
const QMap<int, double>& cjk() {
    static const QMap<int, double> t{{9, 0.0731}, {10, 0.0639}, {11, 0.0859}, {12, 0.0961}, {13, 0.1195}, {14, 0.1241}, {15, 0.1282}, {16, 0.1328},
                                     {17, 0.1668}, {18, 0.1861}, {20, 0.1925}, {22, 0.3332}, {24, 0.3745}, {26, 0.4007}, {28, 0.4269}, {32, 0.6006}};
    return t;
}

/// 表里没有的字号按两头线性插
double at(const QMap<int, double>& t, double px) {
    const auto exact = t.constFind(int(px));
    if (exact != t.cend() && double(exact.key()) == px) return *exact;
    if (px <= t.firstKey()) return t.first();
    if (px >= t.lastKey()) return t.last();
    auto hi = t.upperBound(int(std::floor(px)));
    auto lo = std::prev(hi);
    if (double(hi.key()) == px) return *hi;
    return *lo + (*hi - *lo) * (px - lo.key()) / (hi.key() - lo.key());
}

}  // namespace

double trackFix(double px, const QString& text) {
#ifdef Q_OS_MACOS
    // 这张校正表只量过 Apple 系统字体,不能套到 Anthropic Sans 上。
    if (QGuiApplication::font().family() != u".AppleSystemUIFont") return 0;
    if (text.isEmpty()) return 0;
    int n = 0, han = 0, dots = 0;
    for (QChar ch : text) {
        const char16_t c = ch.unicode();
        if (c >= 0xDC00 && c <= 0xDFFF) continue;  // 代理对的后半
        n += 1;
        if ((c >= 0x2E80 && c <= 0x9FFF) || (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFF00 && c <= 0xFFEF) || (c >= 0x3000 && c <= 0x303F)) han += 1;
        if (c == 0xB7) dots += 1;  // 中点 ·:CoreText 0.479em、Chromium 0.297em
    }
    if (!n) return 0;
    return ((n - han) * at(latin(), px) + han * at(cjk(), px) - dots * 0.1825 * px) / n;
#else
    Q_UNUSED(px);
    Q_UNUSED(text);
    return 0;
#endif
}

double labelWidth(const QString& text, double px, int weight, const QString& family, bool tnum) {
    // 图表一帧要量几十段字(刻度、轴上标签、避让),鼠标一动就是一帧:按 (字, 字号, 字重, 字体, 等宽数字) 记下来。
    // 只在界面线程用;满了整张清掉(字号与字体就那几种,清一次很快又攒回来)
    thread_local QHash<QString, double> cache;
    const QString key = text + QChar(0x1F) + QString::number(px) + QChar(0x1F) + QString::number(weight) + QChar(0x1F) + family + (tnum ? u"\x1Ft"_s : QString());
    if (const auto it = cache.constFind(key); it != cache.cend()) return *it;
    if (cache.size() > 4096) cache.clear();
    const double base = std::ceil(px - 0.001);
    const double k = px / base;
    // 与 Theme.fontFamily 使用同一份应用字体,图表与页面的字宽才能一致。
    QFont font = QGuiApplication::font();
    if (!family.isEmpty()) font.setFamily(family);
    font.setPixelSize(int(base));
    font.setWeight(QFont::Weight(weight));
    if (family.isEmpty()) font.setVariableAxis(QFont::Tag("wght"), float(weight));
    if (tnum) font.setFeature(QFont::Tag("tnum"), 1);
    const double fix = family.isEmpty() ? trackFix(base, text) : 0;
    font.setLetterSpacing(QFont::AbsoluteSpacing, fix);
    const double w = QFontMetricsF(font).horizontalAdvance(text) * k;
    cache.insert(key, w);
    return w;
}

}  // namespace ibkr::kit
