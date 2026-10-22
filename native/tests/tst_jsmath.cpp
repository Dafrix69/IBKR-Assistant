// engine/util/jsmath(V8 的 fdlibm 那几个函数)对着打包版应用里那个 V8(Electron 以 node 方式跑)的 Math.*(tests/fixtures/gen_jsmath.mjs):
// log / exp / log10 / log2 / atan 在 40000 个输入上逐位相同。sin / cos 不是:Chromium 配置下的 V8 三角函数走的是另一套 libm 实现,
// 这里仍是 fdlibm,只钉住差不出一个末位(引擎里只有统计用到它们:inference 的 logGamma、signalOutcomes 的 t 分布)。
#include "util/jsmath.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTest>

#include <cmath>
#include <cstring>
#include <limits>

using namespace ibkr::util;
using namespace Qt::StringLiterals;

namespace {
double fromHex(const QString& h) {
    const quint64 u = h.toULongLong(nullptr, 16);
    double d;
    std::memcpy(&d, &u, 8);
    return d;
}
quint64 bits(double d) {
    quint64 u;
    std::memcpy(&u, &d, 8);
    return u;
}
/// 同号有限数之间隔着几个可表示的数
qint64 ulps(double a, double b) {
    if (std::signbit(a) != std::signbit(b)) return a == b ? 0 : std::numeric_limits<qint64>::max();
    const qint64 d = qint64(bits(a)) - qint64(bits(b));
    return d < 0 ? -d : d;
}
}  // namespace

class TestJsMath : public QObject {
    Q_OBJECT
private slots:
    void bitwise() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR) + u"/jsmath.json"_s);
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonArray rows = QJsonDocument::fromJson(f.readAll()).object()[u"rows"_s].toArray();
        QCOMPARE(rows.size(), 40000);
        const char* names[] = {"log", "exp", "log10", "log2", "sin", "cos", "atan"};
        double (*fns[])(double) = {jsmath::log, jsmath::exp, jsmath::log10, jsmath::log2, jsmath::sin, jsmath::cos, jsmath::atan};
        int trigOff = 0, trigTotal = 0;
        for (const QJsonValue& v : rows) {
            const QJsonArray r = v.toArray();
            const double x = fromHex(r[0].toString());
            for (int i = 0; i < 7; ++i) {
                if (r[i + 1].isNull()) continue;
                const double want = fromHex(r[i + 1].toString()), got = fns[i](x);
                if (std::isnan(want) && std::isnan(got)) continue;
                if (i == 4 || i == 5) {
                    ++trigTotal;
                    if (bits(want) != bits(got)) ++trigOff;
                    QVERIFY2(ulps(want, got) <= 1, qPrintable(u"%1(%2):Electron %3,C++ %4"_s.arg(QString::fromLatin1(names[i])).arg(x, 0, 'g', 17).arg(want, 0, 'g', 17).arg(got, 0, 'g', 17)));
                    continue;
                }
                QVERIFY2(bits(want) == bits(got), qPrintable(u"%1(%2):Electron %3,C++ %4"_s.arg(QString::fromLatin1(names[i])).arg(x, 0, 'g', 17).arg(want, 0, 'g', 17).arg(got, 0, 'g', 17)));
            }
        }
        qInfo("sin / cos:%d 个里差一个末位的 %d 个", trigTotal, trigOff);
    }

    void pow() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR) + u"/jsmath.json"_s);
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonArray rows = QJsonDocument::fromJson(f.readAll()).object()[u"pows"_s].toArray();
        QVERIFY(rows.size() > 20000);
        int stdOff = 0;
        for (const QJsonValue& v : rows) {
            const QJsonArray r = v.toArray();
            const double x = fromHex(r[0].toString()), y = fromHex(r[1].toString());
            const double want = fromHex(r[2].toString()), starStar = fromHex(r[3].toString()), got = jsmath::pow(x, y);
            QVERIFY2(bits(want) == bits(starStar) || (std::isnan(want) && std::isnan(starStar)), "Math.pow 与 ** 不一样");
            if (std::isnan(want) && std::isnan(got)) continue;
            QVERIFY2(bits(want) == bits(got), qPrintable(u"pow(%1, %2):Electron %3,C++ %4"_s.arg(x, 0, 'g', 17).arg(y, 0, 'g', 17).arg(want, 0, 'g', 17).arg(got, 0, 'g', 17)));
            if (bits(std::pow(x, y)) != bits(want) && !(std::isnan(want) && std::isnan(std::pow(x, y)))) ++stdOff;
        }
        // 直接用 std::pow 会差的那些(指数 2、0.5、±1 的 ±Infinity 次方):这一份测的就是挡下它们的那几行
        qInfo("直接用 std::pow 会差 %d 个", stdOff);
        QVERIFY(stdOff > 0);
    }
};

QTEST_GUILESS_MAIN(TestJsMath)
#include "tst_jsmath.moc"
