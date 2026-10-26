// 字宽(Dafri.Kit 的 Metrics 单例):QML 的 Label 与 C++ 里要量字的地方(图表的轴宽、标签避让)用同一套。
//   · trackFix:系统字体在 CoreText 与 Chromium 里排出来的宽不一样(trak 字距表、苹方、中点 ·),每个字形该加多少,
//     是两边同一段字逐字号量出来的(tools/font_widths.qml),见 docs/briefs/qt-rewrite.md 的已知差异;
//   · labelWidth:一段字按 kit/Label.qml 画出来有多宽(小数像素按往上取整的像素排再缩回去,加上 trackFix)。
#pragma once

#include <QObject>
#include <QString>
#include <QtQml/qqmlregistration.h>

namespace ibkr::kit {

/// 整数像素 px、这段字(纯文字)在 Qt 里该加的字距(macOS 以外是 0)
double trackFix(double px, const QString& text);
/// kit/Label.qml 画这段字的宽;family 空 = 应用界面字体
double labelWidth(const QString& text, double px, int weight = 400, const QString& family = QString(), bool tnum = false);

class Metrics : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_SINGLETON
public:
    using QObject::QObject;
    Q_INVOKABLE double trackFix(double px, const QString& text) const { return kit::trackFix(px, text); }
};

}  // namespace ibkr::kit
