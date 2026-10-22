// 按颜色现画的图标(app/icon_provider):不透明的颜色、QML 写成 #AARRGGBB 的半透明颜色(侧栏在窗口不在前台时用的那种)
// 都要画得出来,半透明的透明度照乘;不给颜色的应用标照原色画。
#include "icon_provider.h"

#include <QTest>

using namespace Qt::StringLiterals;

namespace {
/// 画出来的不透明度最高的那个像素(0 = 什么都没画)
int maxAlpha(const QImage& image) {
    int best = 0;
    for (int y = 0; y < image.height(); ++y)
        for (int x = 0; x < image.width(); ++x) best = std::max(best, qAlpha(image.pixel(x, y)));
    return best;
}
}  // namespace

class TestIconProvider : public QObject {
    Q_OBJECT
private slots:
    void opaqueColorDraws() {
        ibkr::app::IconProvider p;
        QSize size;
        const QImage img = p.requestImage(u"sf-pencil/#007aff"_s, &size, QSize(36, 36));
        QCOMPARE(size, QSize(36, 36));
        QCOMPARE(maxAlpha(img), 255);
    }

    // labelSecondary(浅色)是 rgba(60, 60, 67, 0.62):QML 的 toString 写成 #9e3c3c43
    void translucentColorDraws() {
        ibkr::app::IconProvider p;
        QSize size;
        const QImage img = p.requestImage(u"sf-pencil/#9e3c3c43"_s, &size, QSize(36, 36));
        const int a = maxAlpha(img);
        QVERIFY2(a > 140 && a < 170, qPrintable(u"最高不透明度 %1,应在 0.62 × 255 ≈ 158 附近"_s.arg(a)));
    }

    void appMarkKeepsItsColors() {
        ibkr::app::IconProvider p;
        QSize size;
        QCOMPARE(maxAlpha(p.requestImage(u"app-mark"_s, &size, QSize(32, 32))), 255);
    }
};

QTEST_MAIN(TestIconProvider)
#include "tst_icon_provider.moc"
