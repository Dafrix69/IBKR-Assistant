#include "shell/entry_market.h"
#include "execution/ib_session.h"
#include <QTest>
#include <QDateTime>
#include <QTimeZone>
using namespace ibkr;
using namespace Qt::StringLiterals;
class TestEntryMarket:public QObject {
 Q_OBJECT
private slots:
 void priceSequence() {
    const QTimeZone zone("America/New_York");
    const auto start=QDateTime(QDate(2026,10,22),QTime(10,0),zone); const double now=start.addSecs(7*60).toMSecsSinceEpoch();
    QJsonArray bars;
    for(int i=0;i<7;++i) bars.append(QJsonObject{{"time",start.addSecs(i*60).toString("yyyy-MM-dd HH:mm")},
      {"open",i==0?99:100},{"high",102},{"low",i==2?100:99},{"close",i==0?99:101},{"volume",100}});
    auto model=[&](QString feed) {return shell::fly::entryMarketChecks({{"entry_context",QJsonObject{{"SPX",QJsonObject{{"bars",bars},{"feed",feed},{"asked_at",now}}}}}},{{"mode","up"},{"trigger","100"}},now);};
    auto state=[](QJsonArray a,QString title) {for(const auto& v:a) if(v.toObject()["title"]==title)return v.toObject()["state"].toString();return QString();};
    QCOMPARE(state(model("live"),u"位外站稳五分钟（自动）"_s),QString("pass"));
    QCOMPARE(state(model("live"),u"回踩收回位外（自动）"_s),QString("pass"));
    QCOMPARE(state(model("delayed"),u"位外站稳五分钟（自动）"_s),QString("wait"));
    bars.removeAt(3); QCOMPARE(state(model("live"),u"位外站稳五分钟（自动）"_s),QString("wait"));
 }
 void perFieldAgeAndType() {
    using namespace execution;
    auto all=std::make_shared<ibnext::MarketData>();
    all->set(11000,ibnext::TickVal{1}); all->set(1,ibnext::TickVal{2}); all->set(2,ibnext::TickVal{3});
    TickerData t; applyTicks(t,{all,all,{}},1000); QCOMPARE(t.bidAt.value(),1000.0); QCOMPARE(t.marketDataType.value(),1.0);
    auto added=std::make_shared<ibnext::MarketData>();added->set(0,ibnext::TickVal{10});all->set(0,ibnext::TickVal{10});
    auto changed=std::make_shared<ibnext::MarketData>();changed->set(2,ibnext::TickVal{4});all->set(2,ibnext::TickVal{4});
    applyTicks(t,{all,added,changed},2000); QCOMPARE(t.bidAt.value(),1000.0); QCOMPARE(t.askAt.value(),2000.0); QCOMPARE(t.bidSizeAt.value(),2000.0);
    changed=std::make_shared<ibnext::MarketData>();changed->set(11000,ibnext::TickVal{3});all->set(11000,ibnext::TickVal{3});
    applyTicks(t,{all,{},changed},3000); QVERIFY(!t.bidAt); QVERIFY(!t.askAt); QVERIFY(t.delayed);
 }
};
QTEST_GUILESS_MAIN(TestEntryMarket)
#include "tst_entry_market.moc"
