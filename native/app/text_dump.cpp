#include "text_dump.h"

#include <QColor>
#include <QFile>
#include <QFont>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QQuickItem>
#include <QQuickWindow>
#include <QScreen>
#include <QRegularExpression>
#include <QTextDocument>

#include <algorithm>

using namespace Qt::StringLiterals;

namespace ibkr::app {

namespace {

/// 这个子项在窗口里真的看得见:自己与祖先都 visible、不透明度不是 0,而且没被裁掉的祖先整个挡住
bool shown(QQuickItem* item, const QRectF& scene) {
    for (QQuickItem* p = item; p; p = p->parentItem()) {
        if (!p->isVisible() || p->opacity() <= 0.001) return false;
        if (p != item && p->clip() && !p->mapRectToScene(QRectF(0, 0, p->width(), p->height())).intersects(scene)) return false;
    }
    return true;
}

// QQuickText::StyledText(QML 的 Text.StyledText):Qt::TextFormat 里没有这一项
constexpr int kStyledText = 4;

void walk(QQuickItem* item, const QRectF& windowRect, QJsonArray& out) {
    const QString cls = QString::fromLatin1(item->metaObject()->className());
    if (cls.startsWith(u"QQuickText"_s) && !cls.startsWith(u"QQuickTextInput"_s) && !cls.startsWith(u"QQuickTextEdit"_s)) {
        QString text = item->property("text").toString();
        // 富文本去掉标签:RichText / StyledText 一定是;AutoText(默认)要 Qt 自己也认成富文本才算,纯文字里的 < > 照留
        const int format = item->property("textFormat").toInt();
        const bool rich = format == Qt::RichText || format == kStyledText || (format == Qt::AutoText && Qt::mightBeRichText(text));
        if (rich) text.remove(QRegularExpression(u"<[^>]+>"_s));
        // 字在框里的位置:右 / 居中对齐时字不从 0 起(一行的情况;多行按最宽那行算)
        const qreal cw = item->property("contentWidth").toReal();
        const int align = item->property("effectiveHorizontalAlignment").toInt();
        const qreal ox = align & Qt::AlignRight ? item->width() - cw : align & Qt::AlignHCenter ? (item->width() - cw) / 2 : 0;
        const QRectF scene = item->mapRectToScene(QRectF(ox, 0, cw, item->property("contentHeight").toReal()));
        if (!text.trimmed().isEmpty() && shown(item, scene) && scene.intersects(windowRect)) {
            const QFont font = item->property("font").value<QFont>();
            // 小数像素的字按整数像素排、整段缩放(kit/Label.qml 缩的是 Text 自己):只乘它自己的缩放,
            // 不取祖先的(按着的按钮缩到 0.97、动画中途,都不是字号)
            const qreal k = item->scale();
            const qreal dpi = item->window() && item->window()->screen() ? item->window()->screen()->logicalDotsPerInchY() : 72.0;
            const qreal px = font.pixelSize() > 0 ? double(font.pixelSize()) : font.pointSizeF() * dpi / 72.0;
            const QColor color = item->property("color").value<QColor>();
            out.append(QJsonObject{
                {u"text"_s, text.simplified()},
                {u"x"_s, std::round(scene.x() * 10) / 10},
                {u"y"_s, std::round(scene.y() * 10) / 10},
                {u"w"_s, std::round(scene.width() * 10) / 10},
                {u"h"_s, std::round(scene.height() * 10) / 10},
                {u"size"_s, std::round(px * k * 10) / 10},
                {u"weight"_s, font.weight()},
                {u"color"_s, color.name(QColor::HexArgb)},
            });
        }
    }
    QList<QQuickItem*> kids = item->childItems();
    std::stable_sort(kids.begin(), kids.end(), [](QQuickItem* a, QQuickItem* b) { return a->z() < b->z(); });
    for (QQuickItem* k : kids) walk(k, windowRect, out);
}

}  // namespace

void dumpTexts(QQuickWindow* window, const QString& path) {
    QJsonArray out;
    walk(window->contentItem(), QRectF(0, 0, window->width(), window->height()), out);
    QFile f(path);
    if (f.open(QIODevice::WriteOnly)) f.write(QJsonDocument(out).toJson(QJsonDocument::Indented));
}

}  // namespace ibkr::app
