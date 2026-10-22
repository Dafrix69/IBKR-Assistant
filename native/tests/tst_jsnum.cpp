// JS 的 parseInt / parseFloat:期望值是 node 现算的(fixtures/stoqey-v193.json 的 jsnum 一节),不是凭记忆写的。
#include "util/jsnum.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTest>

#include <cmath>

using namespace ibkr;

namespace {

QJsonObject fixture() {
    QFile file(QStringLiteral(IBKR_FIXTURES_DIR "/stoqey-v193.json"));
    if (!file.open(QIODevice::ReadOnly)) qFatal("读不到 fixture:%s", qPrintable(file.fileName()));
    return QJsonDocument::fromJson(file.readAll()).object().value(u"jsnum").toObject();
}

/// fixture 里的期望:数,或 "NaN" / "Infinity" / "-Infinity" / "-0" 这几个 JSON 写不出来的值
double expectedValue(const QJsonValue& v) {
    if (v.isDouble()) return v.toDouble();
    const QString s = v.toString();
    if (s == u"NaN") return std::nan("");
    if (s == u"Infinity") return INFINITY;
    if (s == u"-Infinity") return -INFINITY;
    if (s == u"-0") return -0.0;
    qFatal("认不出的期望值 %s", qPrintable(s));
}

bool sameNumber(double a, double b) {
    if (std::isnan(a) || std::isnan(b)) return std::isnan(a) && std::isnan(b);
    return a == b && std::signbit(a) == std::signbit(b);
}

void addRows(const char* section) {
    QTest::addColumn<QString>("input");
    QTest::addColumn<double>("expected");
    int i = 0;
    for (const QJsonValue& row : fixture().value(QLatin1StringView(section)).toArray()) {
        const QJsonArray pair = row.toArray();
        const QString input = pair[0].toString();
        // 编号在前:" 12" 与 "\u00a012" 打出来长得一样,标签不能撞
        QTest::newRow(qPrintable(QStringLiteral("%1 [%2]").arg(++i).arg(input))) << input << expectedValue(pair[1]);
    }
}

}  // namespace

class TestJsNum : public QObject {
    Q_OBJECT
private slots:
    void parseInt10_data() { addRows("parseInt10"); }
    void parseInt10() {
        QFETCH(QString, input);
        QFETCH(double, expected);
        const double actual = util::jsParseInt(input, 10);
        QVERIFY2(sameNumber(actual, expected), qPrintable(QStringLiteral("parseInt(%1) = %2,JS 是 %3").arg(input).arg(actual, 0, 'g', 17).arg(expected, 0, 'g', 17)));
    }

    void parseInt16_data() { addRows("parseInt16"); }
    void parseInt16() {
        QFETCH(QString, input);
        QFETCH(double, expected);
        QVERIFY(sameNumber(util::jsParseInt(input, 16), expected));
    }

    void parseFloat_data() { addRows("parseFloat"); }
    void parseFloat() {
        QFETCH(QString, input);
        QFETCH(double, expected);
        const double actual = util::jsParseFloat(input);
        QVERIFY2(sameNumber(actual, expected), qPrintable(QStringLiteral("parseFloat(%1) = %2,JS 是 %3").arg(input).arg(actual, 0, 'g', 17).arg(expected, 0, 'g', 17)));
    }

    void fixtureIsNotEmpty() {
        // 防"fixture 读错了一节、零行全绿"
        QVERIFY(fixture().value(u"parseFloat").toArray().size() > 40);
    }
};

QTEST_GUILESS_MAIN(TestJsNum)
#include "tst_jsnum.moc"
