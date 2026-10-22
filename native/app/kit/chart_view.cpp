#include "kit/chart_view.h"

#include "kit/text_metrics.h"

#include <QPainter>
#include <QPainterPath>
#include <QQuickWindow>

#include <cmath>

namespace ibkr::kit {

using namespace Qt::StringLiterals;
namespace chart = shell::chart;

ChartView::ChartView(QQuickItem* parent) : QQuickPaintedItem(parent) {
    setAcceptHoverEvents(true);
    setAcceptedMouseButtons(Qt::LeftButton);
    setAntialiasing(true);
    setCursor(Qt::CrossCursor);
}

void ChartView::setSource(QObject* source) {
    auto* s = qobject_cast<shell::ChartSource*>(source);
    if (s == source_) return;
    if (source_) disconnect(source_, nullptr, this, nullptr);
    source_ = s;
    if (source_) connect(source_, &shell::ChartSource::changed, this, &ChartView::onSpecChanged);
    view_ = chart::View{};
    norm_ = {};
    lastOk_ = {};
    viewKey_.clear();
    onSpecChanged();
    emit sourceChanged();
}

void ChartView::setWheel(bool on) {
    if (on == wheel_) return;
    wheel_ = on;
    emit wheelChanged();
}

void ChartView::setColors(const QVariantMap& p) {
    palette_ = p;
    emit colorsChanged();
    update();
}

void ChartView::onSpecChanged() {
    if (!source_) {
        base_ = frame_ = lastOk_ = {};
        rebuild();
        return;
    }
    const chart::Normalized next = chart::normalize(source_->spec());
    const QString key = chart::viewKeyOf(source_->spec(), next);
    // 刷新:同一个 viewKey 且缩放 / 平移过的,留住视口;别的(第一次、换了东西、从没缩放过)铺满,价格恢复自动
    // 看上一次有效的那一帧(此刻窄到画不出时,视口还是那时的)
    if (lastOk_.ok && !view_.fit) {
        const chart::ViewDecision d = chart::keepViewport(norm_, viewKey_, chart::ViewRange{lastOk_.from, lastOk_.to}, next, key);
        if (d.reset) {
            view_ = chart::View{};
        } else {
            const auto keepPrice = view_.priceRange;
            chart::Frame probe = lastOk_;
            probe.base = int(next.times.size()) - 1;
            view_ = chart::viewForRange(probe, d.range.from, d.range.to);
            view_.priceRange = keepPrice;
        }
    } else {
        view_ = chart::View{};
    }
    norm_ = next;
    viewKey_ = key;
    rebuild();
}

void ChartView::rebuild() {
    const double pr = window() ? window()->effectiveDevicePixelRatio() : 1;
    base_ = {};
    if (source_) {
        const chart::Measure measure = [](const QString& text, double px, bool bold) { return labelWidth(text, px, bold ? 700 : 400); };
        base_ = chart::layoutFrame(source_->spec(), norm_, width(), height(), view_, measure, std::nullopt, pr);
        // 记下此刻的视口(第一帧铺满之后、图区宽变了缩放过之后):之后的拖动、缩放、改尺寸从这里起
        if (base_.ok) {
            view_ = chart::viewOf(base_, view_);
            lastOk_ = base_;
        } else if (base_.notice != u"窗口太窄"_s) {
            // 数据不足:原版拆掉整张图,回来时重新铺满——不拿更早那一帧的视口去配
            lastOk_ = {};
        }
    }
    texts_.clear();
    for (const chart::TextItem& t : base_.texts) texts_.append(textItem(t));
    // 先把新帧叠好光标落进 frame_,再说帧变了:notice / priceAxisWidth 读的是 frame_
    rehover();
    emit frameChanged();
}

QVariantMap ChartView::textItem(const chart::TextItem& t) const {
    return {{u"text"_s, t.text}, {u"x"_s, t.x}, {u"y"_s, t.y}, {u"align"_s, t.align}, {u"px"_s, t.px}, {u"bold"_s, t.bold},
            {u"color"_s, color(t.color, t.alpha)}, {u"bg"_s, t.bg.isEmpty() ? QVariant() : QVariant(color(t.bg, t.bgAlpha))}};
}

void ChartView::rehover() {
    frame_ = base_;
    if (source_) chart::applyHover(frame_, source_->spec(), norm_, hover_);
    crossTexts_.clear();
    for (const chart::TextItem& t : frame_.crossTexts) crossTexts_.append(textItem(t));
    const auto parts = [this](const chart::Parts& p) {
        QVariantList out;
        for (const auto& [text, c] : p)
            if (!text.isEmpty()) out.append(QVariantMap{{u"text"_s, text}, {u"color"_s, color(c)}});
        return out;
    };
    headerRow_ = frame_.headerRow ? parts(*frame_.headerRow) : QVariantList{};
    readoutRow_ = parts(frame_.readoutRow);
    legendRow_.clear();
    for (const auto& [glyph, c, text] : frame_.legendRow) legendRow_.append(QVariantMap{{u"glyph"_s, glyph}, {u"color"_s, color(c)}, {u"text"_s, text}});
    emit hoverChanged();
    update();
}

void ChartView::geometryChange(const QRectF& next, const QRectF& old) {
    QQuickPaintedItem::geometryChange(next, old);
    if (next.size() != old.size()) rebuild();
}

QColor ChartView::color(const QString& token, double alpha) const {
    QColor c = palette_.contains(token) ? palette_.value(token).value<QColor>() : QColor(token);
    if (!c.isValid()) c = palette_.value(u"label2"_s).value<QColor>();
    // withAlpha:token 的颜色本身带透明(label2 = 62%)时,alpha 换掉它(同 withAlpha 对 rgba() 的处理)
    if (alpha < 1) c.setAlphaF(float(alpha));
    return c;
}

void ChartView::paint(QPainter* p) {
    if (!frame_.ok || !frame_.notice.isEmpty()) return;
    const chart::Frame& f = frame_;
    const double pr = window() ? window()->effectiveDevicePixelRatio() : 1;
    const auto crispX = [pr](double x) { return (std::round(x * pr) + 0.5) / pr; };
    const double pane0 = f.paneH[0];
    const double panesBottom = pane0 + (f.paneH.size() > 1 ? 1 + f.paneH[1] : 0);

    const auto pen = [this](const QString& c, double alpha, double width, const QList<double>& dash) {
        QPen pn(color(c, alpha), width);
        pn.setCapStyle(Qt::FlatCap);
        pn.setJoinStyle(Qt::RoundJoin);
        if (!dash.isEmpty()) {
            QList<qreal> d;
            for (double v : dash) d << v / width;  // QPen 的虚线以线宽为单位,画布是像素
            pn.setDashPattern(d);
        }
        return pn;
    };
    const auto rects = [&](const QList<chart::RectItem>& list, double dy = 0) {
        for (const chart::RectItem& r : list) {
            if (r.stroke) {
                p->setPen(pen(r.color, r.alpha, 1, r.dash));
                p->setBrush(Qt::NoBrush);
                p->drawRect(QRectF(r.x, r.y + dy, r.w, r.h));
            } else {
                p->setPen(Qt::NoPen);
                p->setBrush(color(r.color, r.alpha));
                p->drawRect(QRectF(r.x, r.y + dy, r.w, r.h));
            }
        }
    };
    const auto polys = [&](const QList<chart::PolyItem>& list) {
        for (const chart::PolyItem& l : list) {
            QPainterPath path;
            for (qsizetype i = 0; i < l.pts.size(); ++i) {
                if (i == 0) path.moveTo(l.pts[i].first, l.pts[i].second);
                else path.lineTo(l.pts[i].first, l.pts[i].second);
            }
            if (l.fill) {
                path.closeSubpath();
                p->setPen(Qt::NoPen);
                p->setBrush(color(l.color, l.alpha));
            } else {
                p->setPen(pen(l.color, l.alpha, l.width, l.dash));
                p->setBrush(Qt::NoBrush);
            }
            p->drawPath(path);
        }
    };

    // 网格(库的 grid:竖线跨所有窗格、横线只在主图)
    p->setRenderHint(QPainter::Antialiasing, false);
    p->setPen(QPen(color(u"label"_s, 0.08), 1 / pr));
    for (double x : f.gridX)
        if (x >= 0 && x <= f.paneW) p->drawLine(QPointF(crispX(x), 0), QPointF(crispX(x), panesBottom));
    for (double y : f.gridY) p->drawLine(QPointF(0, crispX(y)), QPointF(f.paneW, crispX(y)));

    p->save();
    p->setClipRect(QRectF(0, 0, f.paneW, pane0));
    p->setRenderHint(QPainter::Antialiasing, true);
    rects(f.under);
    polys(f.underLines);
    p->setRenderHint(QPainter::Antialiasing, false);
    rects(f.candles);
    p->setRenderHint(QPainter::Antialiasing, true);
    polys(f.overLines);
    polys(f.overShapes);
    polys(f.crossLines);
    p->setPen(Qt::NoPen);
    for (const chart::CircleItem& c : f.dots) {
        p->setBrush(color(c.color));
        p->drawEllipse(QPointF(c.x, c.y), c.r, c.r);
    }
    p->restore();

    if (f.paneH.size() > 1) {
        p->save();
        p->setClipRect(QRectF(0, pane0 + 1, f.paneW, f.paneH[1]));
        p->setRenderHint(QPainter::Antialiasing, false);
        rects(f.volumes);
        p->restore();
        // 窗格之间的分隔线
        p->fillRect(QRectF(0, pane0, f.width, 1), color(u"separator"_s));
    }
    // 价格轴、时间轴的边线
    p->setRenderHint(QPainter::Antialiasing, false);
    p->fillRect(QRectF(f.paneW, 0, 1 / pr, panesBottom), color(u"separator"_s));
    p->fillRect(QRectF(0, panesBottom, f.width, 1 / pr), color(u"separator"_s));
    // 轴上带底色的标签(关键位、现价、十字光标):库的轴标签——字号 11 + 上下各 2.5/12 字号的内边距,左右各 5/12 字号
    p->setRenderHint(QPainter::Antialiasing, true);
    QList<chart::TextItem> tagged = f.texts;
    tagged << f.crossTexts;
    for (const chart::TextItem& t : tagged) {
        if (t.bg.isEmpty()) continue;
        const double w = labelWidth(t.text, t.px) + 2 * (t.px / 12 * 5) + 1;
        const double h = t.px + 2 * (2.5 / 12 * t.px) + 2;
        const QRectF box = t.align == u"center" ? QRectF(t.x - w / 2 - 4, panesBottom, w + 8, f.timeAxisH - 4)
                                                : QRectF(f.paneW, t.y - h / 2, f.priceAxisW, h);
        p->setPen(Qt::NoPen);
        p->setBrush(color(t.bg, t.bgAlpha));
        p->drawRoundedRect(box, 2, 2);
    }
}

bool ChartView::overPriceAxis(QPointF pos) const { return frame_.ok && pos.x() >= frame_.paneW && pos.y() < frame_.paneH.value(0); }

bool ChartView::overTimeAxis(QPointF pos) const {
    if (!frame_.ok) return false;
    const double bottom = frame_.paneH[0] + (frame_.paneH.size() > 1 ? 1 + frame_.paneH[1] : 0);
    return pos.y() >= bottom && pos.x() < frame_.paneW;
}

void ChartView::hoverMoveEvent(QHoverEvent* e) {
    const QPointF pos = e->position();
    setCursor(overPriceAxis(pos) ? Qt::SizeVerCursor : overTimeAxis(pos) ? Qt::SizeHorCursor : Qt::CrossCursor);
    hover_ = chart::Hover{pos.x(), pos.y()};
    rehover();
}

void ChartView::hoverLeaveEvent(QHoverEvent*) {
    hover_.reset();
    rehover();
}

void ChartView::mousePressEvent(QMouseEvent* e) {
    if (!frame_.ok) return e->ignore();
    pressAt_ = e->position();
    pressView_ = view_;
    pressFrame_ = frame_;
    pressRange_ = {frame_.minValue, frame_.maxValue};
    drag_ = overPriceAxis(pressAt_) ? Drag::PriceAxis : overTimeAxis(pressAt_) ? Drag::TimeAxis : Drag::Pane;
    e->accept();
}

void ChartView::mouseMoveEvent(QMouseEvent* e) {
    const QPointF pos = e->position();
    switch (drag_) {
        case Drag::Pane: {
            // 按住拖动:横向平移(库的 scrollTo);价格手动时上下拖平移价格
            view_ = chart::scrollView(pressFrame_, pressView_, pressAt_.x() - pos.x());
            if (pressView_.priceRange) view_.priceRange = chart::shiftPriceRange(pressFrame_, pressRange_, pressAt_.y(), pos.y());
            break;
        }
        case Drag::TimeAxis: {
            // 拖时间轴:间距按到右边的距离之比缩放(库的 TimeScale.scaleTo)
            view_ = chart::scaleTimeView(pressFrame_, pressView_, pressAt_.x(), pos.x());
            break;
        }
        case Drag::PriceAxis:
            // 拖价格轴:价格区间围着中间缩放,从此是手动的
            view_.priceRange = chart::scalePriceRange(pressFrame_, pressRange_, pressAt_.y(), pos.y());
            break;
        case Drag::None: return;
    }
    hover_ = chart::Hover{pos.x(), pos.y()};
    rebuild();
}

void ChartView::mouseReleaseEvent(QMouseEvent*) { drag_ = Drag::None; }

void ChartView::mouseDoubleClickEvent(QMouseEvent* e) {
    const QPointF pos = e->position();
    if (overTimeAxis(pos)) {
        // 双击时间轴:铺满 + 价格恢复自动(engine.ts 的 resetView;库自己的复位是回到 6px 一根,不用)
        view_ = chart::View{};
        rebuild();
    } else if (overPriceAxis(pos)) {
        // 双击价格轴:只把价格恢复自动(库的 axisDoubleClickReset.price)
        view_.priceRange.reset();
        rebuild();
    }
}

void ChartView::wheelEvent(QWheelEvent* e) {
    // 滚轮没开:交给外面的页面滚
    if (!wheel_ || !frame_.ok) return e->ignore();
    const QPoint angle = e->angleDelta();
    // 浏览器一格滚轮 deltaY = 100 像素(Qt 是 120):库的 zoom 拿 -deltaY / 100 当缩放的倍数,横向按 deltaX × 80 像素平移
    const double scale = angle.y() / 120.0;
    if (scale != 0) {
        const auto keepPrice = view_.priceRange;
        view_ = chart::zoomView(frame_, e->position().x(), scale);
        view_.priceRange = keepPrice;
    }
    if (angle.x() != 0) view_ = chart::scrollView(frame_, view_, -angle.x() / 120.0 * 100 * 0.8);
    rebuild();
    e->accept();
}

}  // namespace ibkr::kit
