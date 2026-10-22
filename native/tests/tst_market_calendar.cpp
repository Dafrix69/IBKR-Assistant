// engine/util/market_calendar 对着原模块(engine-ts/src/marketCalendar.ts)现算的答案(tests/fixtures/gen_market_calendar.mjs):
// 1990–2070 每年的复活节、休市日、提前收盘日,2000–2060 的整段内置日历,配置与内置的并集。
#include "util/market_calendar.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTest>

using namespace ibkr::util;
using namespace Qt::StringLiterals;

namespace {
QStringList strs(const QJsonValue& v) {
    QStringList out;
    for (const QJsonValue& x : v.toArray()) out << x.toString();
    return out;
}
}  // namespace

class TestMarketCalendar : public QObject {
    Q_OBJECT
private slots:
    void years() {
        QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/market-calendar.json"));
        QVERIFY(f.open(QIODevice::ReadOnly));
        const QJsonObject j = QJsonDocument::fromJson(f.readAll()).object();
        for (const QJsonValue& v : j[u"years"_s].toArray()) {
            const int y = v[u"y"_s].toInt();
            QCOMPARE(easterSunday(y), v[u"easter"_s].toString());
            QCOMPARE(nyseHolidays(y), strs(v[u"holidays"_s]));
            QCOMPARE(nyseEarlyCloses(y), strs(v[u"early"_s]));
        }
        QCOMPARE(builtinCalendar().holidays, strs(j[u"builtin"_s][u"holidays"_s]));
        QCOMPARE(builtinCalendar().earlyCloses, strs(j[u"builtin"_s][u"earlyCloses"_s]));
        for (const QJsonValue& v : j[u"merges"_s].toArray()) QCOMPARE(mergeCalendar(strs(v[u"c"_s]), strs(v[u"b"_s])), strs(v[u"out"_s]));
    }
};

QTEST_GUILESS_MAIN(TestMarketCalendar)
#include "tst_market_calendar.moc"
