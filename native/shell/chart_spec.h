// 图表描述(lib/chart/spec.ts)与引擎里不靠图表库的那几样(lib/chart/engine.ts、layout.ts),逐句搬:
//   · spec:蜡烛、折线、水平线、区域、竖线、标记、现价、图例、顶部读数(header / readout 是回调);
//   · 归一化:时间去重排序、能按墙钟读的给真时间戳、读不出或撞车的按下标造;蜡烛 / 折线按时间对齐;
//   · 价格区间(可见下标区间里的蜡烛 + 折线 + fit 的水平线 / 标记 / 区域 + 现价,上下各留 padPct、yMin 夹底)、量能的 95 分位封顶、
//     刻度小数位、十字光标的默认读数、时间轴上的字、刷新时视口怎么留;
//   · 轴上标签与图内文字的避让(layoutTags / placeLabel)。
// 颜色写 token 名(up / down / blue / orange / purple / label / label2 / label3)或字面量,由界面按主题解析。
// 期望值:tests/fixtures/gen_chart.mjs(原文件里的函数原样取出来跑)
#pragma once

#include <QHash>
#include <QJsonObject>
#include <QList>
#include <QPair>
#include <QString>
#include <QStringList>

#include <functional>
#include <optional>

namespace ibkr::shell::chart {

struct Bar {
    QString time;
    double open = 0, high = 0, low = 0, close = 0;
    std::optional<double> volume;
};

struct Line {
    /// values 与 times 对齐(缺的是 nullopt);或者 points(按时间)
    std::optional<QList<std::optional<double>>> values;
    std::optional<QList<QPair<QString, std::optional<double>>>> points;
    QString color;
    double width = 0;
    QList<double> dash;
    std::optional<double> alpha;
    bool step = false;
    QString label;
};

struct HLine {
    double price = 0;
    QString color;
    QList<double> dash;
    std::optional<double> alpha;
    std::optional<double> width;
    QString label;
    bool tag = true;
    bool fit = true;
};

struct Band {
    bool v = false;
    std::optional<QString> from, to;
    std::optional<double> top, bottom;
    QString color;
    std::optional<double> fill;
    std::optional<double> stroke;
    QList<double> dash;
    QString label;
    bool fit = false;
};

struct VLine {
    QString time;
    QString color;
    std::optional<QList<double>> dash;
    QString label;
};

struct Marker {
    QString time;
    double price = 0;
    /// dot / tri-up / tri-down
    QString shape = QStringLiteral("dot");
    QString color;
    QString label;
    /// above / below
    QString labelPos = QStringLiteral("above");
    QString labelColor;
    std::optional<double> labelAlpha;
    bool fit = true;
};

/// 一行读数:[(文字, 颜色)]
using Parts = QList<QPair<QString, QString>>;

struct Helpers {
    std::function<QString(double)> fmt;
    std::function<QString(std::optional<double>)> fmtVol;
    std::function<QString(const QString&, bool)> timeLabel;
};

struct Spec {
    QString ariaLabel;
    std::optional<QString> viewKey;
    std::optional<QStringList> times;
    QList<Bar> bars;
    QList<Line> lines;
    QList<HLine> hlines;
    QList<Band> bands;
    QList<VLine> vlines;
    QList<Marker> markers;
    std::optional<double> last;
    /// [(字形, 颜色, 文字)]
    QList<std::tuple<QString, QString, QString>> legend;
    std::function<std::optional<Parts>(int, const Helpers&)> header;
    std::function<std::optional<Parts>(int, const Helpers&)> readout;
    /// 缺省:有成交量就画
    std::optional<bool> volume;
    std::optional<double> yMin;
    std::optional<int> decimals;
    std::optional<double> padPct;
};

/// JSON 形状的 spec(同 spec.ts 的字段;header / readout 这两个回调 JSON 里没有)
Spec specFromJson(const QJsonObject& o);

// ---------------------------------------------------------------- 格式
double niceStep(double span, double target);
int decimalsFor(double step);
QString fmtPrice(double p, int dec);
QString fmtVol(std::optional<double> v);
QString timeLabel(const QString& t, bool withDate = false);
/// 墙钟时间串 → 当 UTC 解释的秒数;读不出是 nullopt
std::optional<qint64> wallClockSeconds(const QString& t);

// ---------------------------------------------------------------- 归一化
struct Normalized {
    QStringList times;
    QHash<QString, int> idx;
    QList<qint64> stamps;
    bool realTime = false;
    bool intraday = false;
    QList<std::optional<Bar>> barAt;
    /// 每条折线与 times 对齐的值
    QList<QList<std::optional<double>>> lineValues;
    int lastIdx = -1;
};
Normalized normalize(const Spec& spec);

// ---------------------------------------------------------------- 引擎里的那几样
/// 顶部读数行占掉的像素:8 + (有 header ? 2 : 1) × 17
double headerPx(const Spec& spec);
bool hasVolume(const Spec& spec, const Normalized& norm);
/// 下标区间 [a, b] 里的价格区间;一样都没有是 nullopt
std::optional<QPair<double, double>> priceRange(const Spec& spec, const Normalized& norm, int a, int b);
/// 量能 95 分位(满格值);没有量是 0
double volumeCap(const Normalized& norm);
/// 价格的小数位:spec 给了用它的;否则按整段价格区间、图高估一个刻度步长
int decimals(const Spec& spec, const Normalized& norm, double containerHeight);
/// 十字光标停在第 i 根时的默认读数(颜色是 token)
Parts defaultReadout(const Spec& spec, const Normalized& norm, int i, int dec);
/// resolveColor:没写颜色的是 label2,别的(token 或字面量)原样
QString colorOr(const QString& color);
/// 时间轴上一格的字。type:0 年 / 1 月 / 2 日 / 3 时分 / 4 时分秒(同 lightweight-charts 的 TickMarkType)
QString tickMarkLabel(const Normalized& norm, qint64 stamp, int type);
/// 十字光标在时间轴上的字
QString crosshairTime(const Normalized& norm, qint64 stamp);

/// 刷新时视口怎么留(engine.ts 的 update):reset = 重新铺满;否则给新的可见下标区间
struct ViewRange {
    double from = 0, to = 0;
};
struct ViewDecision {
    bool reset = true;
    ViewRange range;
};
QString viewKeyOf(const Spec& spec, const Normalized& norm);
ViewDecision keepViewport(const Normalized& prevNorm, const QString& prevKey, std::optional<ViewRange> prevRange, const Normalized& norm,
                          const QString& key);

// ---------------------------------------------------------------- 避让(layout.ts)
struct Tag {
    double y = 0;
    double ly = 0;
    bool pinned = false;
    /// 调用方自己的下标(排序之后找回是哪一个)
    int id = 0;
};
/// 一维碰撞避让:按 y 排序,重叠的向两边推开,再夹回区间;pinned 的不动。返回排序后的
QList<Tag> layoutTags(QList<Tag> tags, double minY, double maxY, double h);

struct Rect {
    double x = 0, y = 0, w = 0, h = 0;
};
/// 二维的文字标签避让:和已放下的重叠就往 dir 方向挪一行,最多 6 次;放下的加进 placed
Rect placeLabel(QList<Rect>& placed, Rect rect, int dir);

}  // namespace ibkr::shell::chart
