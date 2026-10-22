// 图表(lib/Chart.tsx 的 CanvasChart + lib/chart/engine.ts):算帧在 shell/chart_scale,这里画与接鼠标。
//   · 框、线、蜡烛、量柱用 QPainter 画(同画布:任意虚线、1.5px 的线、抗锯齿);字不在这里画——texts / headerRow / readoutRow / legendRow
//     交给 QML 的 Label(kit/Chart.qml),字宽与页面上别处的字同一套,--dump-texts 也量得到;
//   · 交互同 engine.ts 给库的选项:按住拖动平移、滚轮缩放(wheel 开着才收,不然交给外面的页面滚)、拖时间轴缩放、拖价格轴缩放价格区间
//     (之后在图里上下拖平移价格)、双击时间轴复位(铺满 + 价格自动)、双击价格轴只把价格恢复自动;十字光标竖线吸到 K 线、横线跟着指针;
//   · spec 刷新:同一个 viewKey 且缩放过的,留住视口(贴着最右边的继续贴着),别的重新铺满(shell/chart_spec 的 keepViewport)。
#pragma once

#include "shell/chart_scale.h"
#include "shell/chart_source.h"

#include <QPointer>
#include <QQuickPaintedItem>
#include <QVariantList>
#include <QVariantMap>
#include <QtQml/qqmlregistration.h>

namespace ibkr::kit {

class ChartView : public QQuickPaintedItem {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(QObject* source READ source WRITE setSource NOTIFY sourceChanged)
    /// 滚轮缩放 / 平移(嵌在长页面里的小图关着,不然鼠标经过时页面滚不动)
    Q_PROPERTY(bool wheel READ wheel WRITE setWheel NOTIFY wheelChanged)
    /// token → 颜色:up / down(蜡烛的那一对)、blue / orange / purple / label / label2 / label3 / separator
    Q_PROPERTY(QVariantMap colors READ colors WRITE setColors NOTIFY colorsChanged)
    Q_PROPERTY(QVariantList texts READ texts NOTIFY frameChanged)
    /// 十字光标在两条轴上的标签(指针一动只换它与读数行,轴上别的字不重建)
    Q_PROPERTY(QVariantList crossTexts READ crossTexts NOTIFY hoverChanged)
    Q_PROPERTY(QVariantList headerRow READ headerRow NOTIFY hoverChanged)
    Q_PROPERTY(bool hasHeader READ hasHeader NOTIFY hoverChanged)
    Q_PROPERTY(QVariantList readoutRow READ readoutRow NOTIFY hoverChanged)
    Q_PROPERTY(QVariantList legendRow READ legendRow NOTIFY hoverChanged)
    /// 「数据不足,无法成图」/「窗口太窄」
    Q_PROPERTY(QString notice READ notice NOTIFY frameChanged)
    Q_PROPERTY(double priceAxisWidth READ priceAxisWidth NOTIFY frameChanged)

public:
    explicit ChartView(QQuickItem* parent = nullptr);

    QObject* source() const { return source_; }
    void setSource(QObject* source);
    bool wheel() const { return wheel_; }
    void setWheel(bool on);
    QVariantMap colors() const { return palette_; }
    void setColors(const QVariantMap& p);
    QVariantList texts() const { return texts_; }
    QVariantList crossTexts() const { return crossTexts_; }
    QVariantList headerRow() const { return headerRow_; }
    bool hasHeader() const { return frame_.headerRow.has_value(); }
    QVariantList readoutRow() const { return readoutRow_; }
    QVariantList legendRow() const { return legendRow_; }
    QString notice() const { return frame_.notice; }
    double priceAxisWidth() const { return frame_.priceAxisW; }

    /// 测试与截图用:此刻的帧与视口
    const shell::chart::Frame& frame() const { return frame_; }
    const shell::chart::View& view() const { return view_; }

    void paint(QPainter* painter) override;

signals:
    void sourceChanged();
    void wheelChanged();
    void colorsChanged();
    void frameChanged();
    void hoverChanged();

protected:
    void geometryChange(const QRectF& next, const QRectF& old) override;
    void hoverMoveEvent(QHoverEvent* e) override;
    void hoverLeaveEvent(QHoverEvent* e) override;
    void mousePressEvent(QMouseEvent* e) override;
    void mouseMoveEvent(QMouseEvent* e) override;
    void mouseReleaseEvent(QMouseEvent* e) override;
    void mouseDoubleClickEvent(QMouseEvent* e) override;
    void wheelEvent(QWheelEvent* e) override;

private:
    void onSpecChanged();
    /// 整帧重算(数据、尺寸、视口变了);之后接着 rehover
    void rebuild();
    /// 只换十字光标与读数行:拿不带光标的那一帧(base_)再跑一遍 applyHover
    void rehover();
    QVariantMap textItem(const shell::chart::TextItem& t) const;
    QColor color(const QString& token, double alpha = 1) const;
    bool overPriceAxis(QPointF p) const;
    bool overTimeAxis(QPointF p) const;

    QPointer<shell::ChartSource> source_;
    bool wheel_ = false;
    QVariantMap palette_;
    shell::chart::Normalized norm_;
    QString viewKey_;
    shell::chart::View view_;
    std::optional<shell::chart::Hover> hover_;
    /// base_:不带十字光标的那一帧;frame_ = base_ + applyHover
    shell::chart::Frame base_, frame_;
    /// 上一次画得出来的那一帧(不带十字光标):刷新时视口留不留看它
    shell::chart::Frame lastOk_;
    QVariantList texts_, crossTexts_, headerRow_, readoutRow_, legendRow_;

    /// 按下时的状态:拖图(平移)、拖时间轴(缩放间距)、拖价格轴(缩放价格)
    enum class Drag { None, Pane, TimeAxis, PriceAxis };
    Drag drag_ = Drag::None;
    QPointF pressAt_;
    shell::chart::View pressView_;
    shell::chart::Frame pressFrame_;
    QPair<double, double> pressRange_;
};

}  // namespace ibkr::kit
