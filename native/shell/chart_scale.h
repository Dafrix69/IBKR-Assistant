// 图表的框架(React 版交给 TradingView 的 lightweight-charts 5.2.1 画)与业务叠加层(lib/chart/overlays.ts)画出来的样子,
// 算成一帧:各窗格多高、价格轴多宽、每根的 x、价格 ↔ y、刻度挑哪几个、时间轴上写什么(哪个加粗、贴边的往里挪)、蜡烛与量柱的像素框、
// 叠加层的每一块 / 每一条 / 每个字、轴上的价格标签(避让、现价钉住)、十字光标。
// 库的算法读的是它的源码(Apache-2.0)后自己写的,出处标在各段旁边;对拍是刻度与坐标那一层:浏览器里用库的公开接口
// 量出来的可见范围、x、价格 ↔ y、窗格高与轴宽,挂在 fillText 上记下的每一段字(tools/chart_harness.mjs + chart_capture.js)。
// 量字由调用方给(界面:Label 同一套字宽;测试:浏览器量出来的宽),这里不认识字体。
#pragma once

#include "shell/chart_spec.h"

#include <QList>
#include <QString>

#include <functional>
#include <optional>

namespace ibkr::shell::chart {

/// 量一段字的宽:px 字号,bold 加粗
using Measure = std::function<double(const QString& text, double px, bool bold)>;

constexpr double kFontPx = 11;
/// 引擎自己估的时间轴高(engine.ts 的 TIME_AXIS_H)与量能子图高(VOL_H):只用来折窗格的比例与估小数位
constexpr double kEngineTimeAxisH = 22;
constexpr double kVolumeH = 56;
constexpr double kAxisMinW = 64;

/// 视口:每根的间距与最右边那根之后还空几根(库的 barSpacing / rightOffset)。fit = 刚挂上或复位:铺满
struct View {
    bool fit = true;
    double barSpacing = 6;
    double rightOffset = 0;
    /// 拖过价格轴:价格区间是手动的(库的 autoScale 关掉);没有 = 按可见范围自动
    std::optional<QPair<double, double>> priceRange;
    /// 这个视口是在多宽的图区上定的(0 = 不知道):图区宽变了,layoutFrame 照库的 lockVisibleTimeRangeOnResize 缩放间距
    double paneW = 0;
};

struct TextItem {
    QString text;
    double x = 0, y = 0;
    /// left / center / right(x 是对齐点);字的竖直中心在 y
    QString align = QStringLiteral("left");
    double px = kFontPx;
    bool bold = false;
    /// token 或字面量;alpha 另给
    QString color;
    double alpha = 1;
    /// 轴上价格标签的底色(空 = 没有底)
    QString bg;
    double bgAlpha = 1;
};

struct RectItem {
    double x = 0, y = 0, w = 0, h = 0;
    QString color;
    double alpha = 1;
    /// 描边(不是填充)
    bool stroke = false;
    QList<double> dash;
};

struct PolyItem {
    QList<QPair<double, double>> pts;
    QString color;
    double alpha = 1;
    double width = 1;
    QList<double> dash;
    /// fill = 填充的多边形(三角标记);否则是折线
    bool fill = false;
};

struct CircleItem {
    double x = 0, y = 0, r = 2.5;
    QString color;
};

struct Frame {
    bool ok = false;
    /// 「数据不足,无法成图」/「窗口太窄」;ok 时也可能有(太窄时图藏起来)
    QString notice;
    double width = 0, height = 0;
    double paneW = 0;
    double priceAxisW = 0, timeAxisH = 0;
    /// 主图、量能子图(有的话)的高;两者之间 1px 分隔
    QList<double> paneH;
    double barSpacing = 0, rightOffset = 0;
    int base = 0;
    /// 可见的下标范围(库的 getVisibleLogicalRange)
    double from = 0, to = 0;
    int dec = 2;
    /// 主图的价格区间与上下边距(像素)
    double minValue = 0, maxValue = 0, topMargin = 0, bottomMargin = 0;
    double volumeCap = 0;

    QList<RectItem> under;      ///< 网格之上、蜡烛之下:区域、竖带
    QList<PolyItem> underLines; ///< 关键位虚线
    QList<RectItem> candles;    ///< 影线与实体(按画的先后:先影线后实体)
    QList<RectItem> volumes;
    QList<PolyItem> overLines;  ///< 折线、竖线、现价点线、引线
    QList<PolyItem> overShapes; ///< 三角标记
    QList<CircleItem> dots;     ///< 圆点标记
    QList<double> gridX, gridY; ///< 网格:时间刻度的 x、价格刻度的 y
    QList<TextItem> texts;      ///< 轴上的刻度、轴上的价格标签、叠加层的字、量能满格
    /// 十字光标(applyHover 加上的):两条虚线、两条轴上的标签。和上面分开放,指针一动只换这几样
    QList<PolyItem> crossLines;
    QList<TextItem> crossTexts;
    /// 读数行显示的是哪一根(没有 = 图例)
    std::optional<int> hoverIdx;
    /// 顶部读数:header 一行(可没有)+ 第二行(图例或十字光标读数)。图例是 (字形, 颜色, 文字)
    std::optional<Parts> headerRow;
    Parts readoutRow;
    QList<std::tuple<QString, QString, QString>> legendRow;

    double x(double logical) const { return paneW - (base + rightOffset - logical + 0.5) * barSpacing - 1; }
    double y(double price) const;
    double priceAt(double y) const;
};

struct Hover {
    /// 指针在图里的坐标(相对整张图的左上角)
    /// 数据刷新、视口复原之后也按此刻的像素重算:库在 setData 与设可见范围时都调 updateCrosshair,
    /// crosshairMove 带出的是指针下那一根,engine.ts 的 hoverIdx 跟着换
    double px = 0, py = 0;
};

/// 一帧。view:视口(fit = 铺满);hover:十字光标(没有就不画);pixelRatio:设备像素比(Retina 是 2)。
/// 库在设备像素上取整:窗格高、蜡烛与量柱的像素框都按 pixelRatio 取整再折回逻辑像素
Frame layoutFrame(const Spec& spec, const Normalized& norm, double width, double height, const View& view, const Measure& measure,
                  std::optional<Hover> hover = std::nullopt, double pixelRatio = 1);

/// 只算十字光标与顶部读数那一层(layoutFrame 最后一步):指针一动,拿不带光标的那一帧再跑这一步就够了
void applyHover(Frame& f, const Spec& spec, const Normalized& norm, std::optional<Hover> hover);

/// 库的 fitContent 之后的视口(铺满)
View fitView(const Normalized& norm, double paneW);
/// 图区宽从 view.paneW 变成 newW(库的 TimeScale.setWidth,engine.ts 开着 lockVisibleTimeRangeOnResize 与 fixLeftEdge):
/// 间距按 新宽 / 旧宽 缩放;左沿那根已经露出来的,右偏移往回挪 round(宽差 / 间距) + 1;再夹一次。n 是根数
View resizeView(const View& view, int n, double newW);
/// 一帧此刻的视口(之后的拖动、缩放从这里起)
View viewOf(const Frame& f, const View& previous);
/// 拖动平移:按像素挪(右拖 = 看更早的)
View scrollView(const Frame& f, const View& start, double dx);
/// 滚轮 / 双指缩放:围着 x 那一点,scale 是 1/10 个间距的倍数(正的放大)
View zoomView(const Frame& f, double zoomX, double scale);
/// 拖时间轴(库的 TimeScale.scaleTo):间距按「到图区右边的距离」之比缩放,start / x 是按下与此刻的横坐标
View scaleTimeView(const Frame& f, const View& start, double startX, double x);
/// 把可见范围设成 [from, to](刷新时留住视口)
View viewForRange(const Frame& f, double from, double to);
/// 拖价格轴缩放(库的 PriceScale.scaleTo):startY / y 是按下与此刻在主图里的 y;startRange 是按下那一刻的价格区间
QPair<double, double> scalePriceRange(const Frame& f, QPair<double, double> startRange, double startY, double y);
/// 价格区间手动时在主图里拖:上下平移价格(库的 PriceScale.scrollTo)
QPair<double, double> shiftPriceRange(const Frame& f, QPair<double, double> startRange, double startY, double y);

}  // namespace ibkr::shell::chart
