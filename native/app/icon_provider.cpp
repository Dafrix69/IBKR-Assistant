#include "icon_provider.h"

#include <QColor>
#include <QFile>
#include <QPainter>
#include <QSvgRenderer>

using namespace Qt::StringLiterals;

namespace ibkr::app {

IconProvider::IconProvider() : QQuickImageProvider(QQuickImageProvider::Image) {}

QImage IconProvider::requestImage(const QString& id, QSize* size, const QSize& requestedSize) {
    // id = 名字/颜色;颜色可以不给(应用标自带配色)
    const qsizetype slash = id.indexOf(u'/');
    const QString name = slash < 0 ? id : id.left(slash);
    const QString color = slash < 0 ? QString() : id.mid(slash + 1);
    QFile f(u":/qt/qml/Dafri/Kit/kit/icons/%1.svg"_s.arg(name));
    QByteArray svg;
    if (f.open(QIODevice::ReadOnly)) svg = f.readAll();
    // QML 把半透明的颜色写成 #AARRGGBB(侧栏图标在窗口不在前台时用的 labelSecondary 就是),SVG 不认这种写法、整个图标画不出来:
    // 颜色本身换成不透明的 #RRGGBB 交给 SVG,透明度画的时候再乘上
    const QColor tint(color);
    if (!color.isEmpty()) svg.replace("currentColor", (tint.isValid() ? tint.name(QColor::HexRgb) : color).toUtf8());
    QSvgRenderer renderer(svg);
    const QSize natural = renderer.isValid() ? renderer.defaultSize() : QSize(16, 16);
    const QSize out = requestedSize.isValid() && !requestedSize.isEmpty() ? requestedSize : natural;
    QImage image(out, QImage::Format_ARGB32_Premultiplied);
    image.fill(Qt::transparent);
    if (renderer.isValid()) {
        QPainter p(&image);
        p.setRenderHint(QPainter::Antialiasing);
        if (tint.isValid()) p.setOpacity(tint.alphaF());
        renderer.render(&p);
    } else {
        qWarning("图标 %s 不存在", qPrintable(name));
    }
    if (size) *size = out;
    return image;
}

}  // namespace ibkr::app
