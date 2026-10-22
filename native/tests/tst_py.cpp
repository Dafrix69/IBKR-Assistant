// engine/util/py 对着原模块(engine-ts/src/py.ts)现算的答案(tests/fixtures/gen_py.mjs):1243 个数在 6 种位数上的
// pyRound / fmtF / fmtSF,以及 pyG / pyFloat / fmtD / pyRepr;23 个各种类型的值的 truthy / finiteOrNull / pyRepr。
#include "util/py.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTest>

#include <cmath>
#include <limits>

using namespace ibkr::util;
using namespace Qt::StringLiterals;

namespace {
QJsonObject fixture() {
    static const QJsonObject j = [] {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/py.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("py.json 打不开");
        return QJsonDocument::fromJson(f.readAll()).object();
    }();
    return j;
}
/// fixture 里的数:NaN / ±Infinity / -0 写成字符串
double decode(const QJsonValue& v) {
    if (v.isString()) {
        const QString s = v.toString();
        if (s == u"NaN") return std::numeric_limits<double>::quiet_NaN();
        if (s == u"Infinity") return std::numeric_limits<double>::infinity();
        if (s == u"-Infinity") return -std::numeric_limits<double>::infinity();
        if (s == u"-0") return -0.0;
    }
    return v.toDouble();
}
bool same(double a, double b) { return (std::isnan(a) && std::isnan(b)) || (a == b && std::signbit(a) == std::signbit(b)); }
}  // namespace

class TestPy : public QObject {
    Q_OBJECT
private slots:
    void numbers() {
        for (const QJsonValue& v : fixture()[u"numbers"_s].toArray()) {
            const QJsonObject c = v.toObject();
            const double x = decode(c[u"x"_s]);
            const QString at = pyFloat(x);
            const QJsonObject round = c[u"round"_s].toObject(), f = c[u"f"_s].toObject(), sf = c[u"sf"_s].toObject();
            for (auto it = round.begin(); it != round.end(); ++it) {
                const int nd = it.key().toInt();
                const double got = pyRound(x, nd);
                if (!same(got, decode(it.value()))) QFAIL(qPrintable(u"pyRound(%1, %2):期望 %3,实际 %4"_s.arg(at).arg(nd).arg(decode(it.value()), 0, 'g', 17).arg(got, 0, 'g', 17)));
                QCOMPARE(fmtF(x, nd), f[it.key()].toString());
                QCOMPARE(fmtSF(x, nd), sf[it.key()].toString());
            }
            QCOMPARE(pyG(x), c[u"g"_s].toString());
            QCOMPARE(pyFloat(x), c[u"float"_s].toString());
            QCOMPARE(fmtD(x), c[u"d"_s].toString());
            QCOMPARE(pyRepr(QJsonValue(x)), c[u"repr"_s].toString());
        }
    }

    void values() {
        for (const QJsonValue& v : fixture()[u"values"_s].toArray()) {
            const QJsonObject c = v.toObject();
            const QJsonValue value = c[u"isNumber"_s].toBool() ? QJsonValue(decode(c[u"v"_s])) : c[u"v"_s];
            const QString label = QString::fromUtf8(QJsonDocument(QJsonArray{value}).toJson(QJsonDocument::Compact));
            QVERIFY2(truthy(value) == c[u"truthy"_s].toBool(), qPrintable(label));
            const std::optional<double> fin = finiteOrNull(value);
            if (c[u"finite"_s].isNull()) QVERIFY2(!fin, qPrintable(label));
            else QVERIFY2(fin && *fin == c[u"finite"_s].toDouble(), qPrintable(label));
            if (!std::isnan(decode(c[u"v"_s])) || !c[u"isNumber"_s].toBool()) QCOMPARE(pyRepr(value), c[u"repr"_s].toString());
        }
    }
};

QTEST_GUILESS_MAIN(TestPy)
#include "tst_py.moc"
