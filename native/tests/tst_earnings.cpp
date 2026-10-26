#include "util/earnings.h"
#include <QTest>
#include <QJsonArray>
using namespace ibkr::util;
class TestEarnings:public QObject {
 Q_OBJECT
private slots:
 void releaseSessionsAndMissing() {
    QJsonArray records;
    auto event=[&](QString date,QString timing,QString status="CONFIRMED") {records.append(QJsonObject{{"earnings_date",date},{"time_of_day",timing},{"wshe_earnings_date_status",status}});};
    event("2026-07-02","AFTER MARKET"); // July 3 observed holiday, then weekend -> July 6
    event("2026-07-06","BEFORE MARKET");
    event("2026-07-01","UNSPECIFIED"); event("2026-07-07","AFTER MARKET","INFERRED");
    event("2026-08-01","BEFORE MARKET");
    QJsonArray bars;
    for (const auto& d:QStringList{"2026-07-02","2026-07-06","2026-07-07","2026-07-08","2026-07-09","2026-07-10"})
      bars.append(QJsonObject{{"date",d},{"open",102},{"close", d=="2026-07-02"?100:110}});
    const QJsonObject raw{{"event_type","wshe_ed"},{"data",records}};
    auto view=earningsView(raw,bars,QDate(2026,7,11)); auto history=view["history"].toArray();
    QCOMPARE(history.size(),4); QCOMPARE(view["upcoming"].toObject()["date"].toString(),QString("2026-08-01"));
    for(const auto& v:history) {
      const auto x=v.toObject();
      if(x["date"]=="2026-07-02"||x["date"]=="2026-07-06") {
        QCOMPARE(x["session"].toString(),QString("2026-07-06"));
        QVERIFY(qAbs(x["gap"].toDouble()-2)<1e-8); QVERIFY(qAbs(x["day1"].toDouble()-10)<1e-8); QVERIFY(qAbs(x["day5"].toDouble()-10)<1e-8);
      } else { QVERIFY(x["gap"].isNull()); QVERIFY(!x["missing"].toString().isEmpty()); }
    }
    bars.removeAt(3);
    history=earningsView(raw,bars,QDate(2026,7,11))["history"].toArray();
    for(const auto& v:history) if(v.toObject()["date"]=="2026-07-02") QVERIFY(v.toObject()["day5"].isNull());
    QCOMPARE(earningsView(QJsonObject{},bars,QDate(2026,7,11))["status"].toString(),QString("missing"));
 }
};
QTEST_GUILESS_MAIN(TestEarnings)
#include "tst_earnings.moc"
