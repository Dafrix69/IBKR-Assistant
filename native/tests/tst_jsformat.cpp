// engine/util/jsformat 对着 node 现算的答案(tests/fixtures/gen_jsformat.mjs):954 个数(边角、正好一半的二进制小数、随机的各个量级)
// 的 String(x)、Math.round、toFixed(0–100 里 14 种位数)、toExponential(11 种位数与不给位数),以及 37 个字符串的 Number(s)。
#include "util/jsformat.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTest>

#include <cmath>

using namespace ibkr::util;
using namespace Qt::StringLiterals;

namespace {
QJsonObject fixture() {
    static const QJsonObject j = [] {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/jsformat.json"));
        if (!f.open(QIODevice::ReadOnly)) qFatal("jsformat.json 打不开");
        return QJsonDocument::fromJson(f.readAll()).object();
    }();
    return j;
}
}  // namespace

class TestJsFormat : public QObject {
    Q_OBJECT
private slots:
    void numbers() {
        int checked = 0;
        for (const QJsonValue& v : fixture()[u"cases"_s].toArray()) {
            const QJsonObject c = v.toObject();
            const double x = c[u"neg0"_s].toBool() ? -0.0 : c[u"x"_s].toDouble();
            const QString at = c[u"str"_s].toString();
            QCOMPARE(jsNumberToString(x), at);
            const double r = jsRound(x);
            QVERIFY2(r == c[u"round"_s].toDouble() && std::signbit(r) == (c[u"round_neg0"_s].toBool() || c[u"round"_s].toDouble() < 0), qPrintable(at));
            const QJsonObject fixed = c[u"fixed"_s].toObject();
            for (auto it = fixed.begin(); it != fixed.end(); ++it) {
                const QString got = jsToFixed(x, it.key().toInt());
                if (got != it.value().toString()) QFAIL(qPrintable(u"(%1).toFixed(%2):期望 %3,实际 %4"_s.arg(at, it.key(), it.value().toString(), got)));
                ++checked;
            }
            const QJsonObject exp = c[u"exp"_s].toObject();
            for (auto it = exp.begin(); it != exp.end(); ++it) {
                const QString got = jsToExponential(x, it.key().toInt());
                if (got != it.value().toString()) QFAIL(qPrintable(u"(%1).toExponential(%2):期望 %3,实际 %4"_s.arg(at, it.key(), it.value().toString(), got)));
                ++checked;
            }
            QCOMPARE(jsToExponentialShortest(x), c[u"exp_shortest"_s].toString());
        }
        QVERIFY(checked > 20000);
    }

    void stringToNumber() {
        for (const QJsonValue& v : fixture()[u"numbers"_s].toArray()) {
            const QJsonObject c = v.toObject();
            const double got = jsStringToNumber(c[u"s"_s].toString());
            const QJsonValue want = c[u"n"_s];
            const QString label = u"Number(%1)"_s.arg(c[u"s"_s].toString());
            if (want.isString()) {
                const QString w = want.toString();
                if (w == u"NaN") QVERIFY2(std::isnan(got), qPrintable(label));
                else QVERIFY2(std::isinf(got) && (got > 0) == (w == u"Infinity"), qPrintable(label));
            } else {
                QVERIFY2(got == want.toDouble() && std::signbit(got) == (c[u"neg0"_s].toBool() || want.toDouble() < 0), qPrintable(label + u" = "_s + QString::number(got)));
            }
        }
    }

    // 精确展开:二进制小数的十进制展开是有限的,一位不差
    void exact() {
        const ExactDecimal d = exactDecimal(0.1);
        QCOMPARE(d.integer, u"0"_s);
        QCOMPARE(d.fraction, u"1000000000000000055511151231257827021181583404541015625"_s);
        QCOMPARE(exactDecimal(46.25).fraction, u"25"_s);
        QCOMPARE(exactDecimal(1e21).integer, u"1000000000000000000000"_s);
        QVERIFY(exactDecimal(-0.0).negative);
    }
};

QTEST_GUILESS_MAIN(TestJsFormat)
#include "tst_jsformat.moc"
