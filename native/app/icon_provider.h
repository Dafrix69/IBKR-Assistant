// QML 里的图标:image://icon/<名字>/<颜色>,例如 image://icon/sf-pencil/#007aff。
// 线稿是 tools/gen_icons.mjs 从 React 版原样渲染出来的 SVG(kit/icons/),描边写的是 currentColor,这里按要的颜色现替换再画。
// 按 requestedSize 画:QML 那边要设 sourceSize(已含设备像素比),不然在 Retina 上是糊的。
#pragma once

#include <QQuickImageProvider>

namespace ibkr::app {

class IconProvider : public QQuickImageProvider {
public:
    IconProvider();
    QImage requestImage(const QString& id, QSize* size, const QSize& requestedSize) override;
};

}  // namespace ibkr::app
