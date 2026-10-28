#include "shell/fly_entry.h"
#include "shell/fly_controller.h"
#include "shell/fly_rules.h"
#include "shell/fly_store.h"
#include "shell/trade_composer.h"
#include <QFile>
#include <QJsonDocument>
#include <QTest>
using namespace ibkr::shell;
using namespace Qt::StringLiterals;
namespace {
QJsonObject result() { QFile f(QStringLiteral(IBKR_FIXTURES_DIR "/fly-plan.json"));if(!f.open(QIODevice::ReadOnly))qFatal("fixture");return QJsonDocument::fromJson(f.readAll()).object()[u"store"].toArray()[2][u"result"].toObject(); }
QJsonObject plan() { const auto form=fly::emptyForm();return {{u"form"_s,form},{u"resultFor"_s,fly::formKey(form)},{u"result"_s,result()}}; }
QJsonObject evidence() {
    QJsonObject e{{u"mode"_s,u"up"_s},{u"regime"_s,u"bull"_s},{u"source"_s,u"合成 EHG，多帧 10:12 ET"_s},{u"trigger"_s,u"7710"_s},
      {u"invalidation"_s,u"7700"_s},{u"barrier"_s,u"7755"_s},{u"flow"_s,u"none"_s},{u"budget"_s,u"1500"_s},{u"fees"_s,u"10"_s},{u"exitTime"_s,u"14:45"_s}};
    const double now=result()[u"now_ms"].toDouble();
    for(const auto& m:fly::entryReview(plan(),e,now)[u"manual"].toArray()){const QString k=m[u"key"].toString();e[k]=true;e[k+u"At"]=now;}
    return e;
}
bool ready(QJsonObject p,QJsonObject e,double delta=0) { return fly::entryReview(p,e,result()[u"now_ms"].toDouble()+delta)[u"ready"].toBool(); }
}
class TestFlyEntry:public QObject {
    Q_OBJECT
private slots:
    void riskAndDirection() {
        const auto p=plan(),e=evidence();QVERIFY(!ready(p,e)); // 缺少自动数据，勾选不能覆盖
        auto model=fly::entryReview(p,e,result()[u"now_ms"].toDouble());
        QCOMPARE(model[u"maxQuantity"].toDouble(),2.0);
        QCOMPARE(model[u"metrics"].toArray()[0][u"value"].toString(),u"$1120.00"_s);
        auto put=p;auto r=result();r[u"right"]=u"P"_s;put[u"result"]=r;QVERIFY(!ready(put,e)); // put 蝶也可以是上行目标
        auto budget=e;budget[u"budget"]=u"1119"_s;QVERIFY(!ready(p,budget));
        auto barrier=e;barrier[u"barrier"]=u"7730"_s;QVERIFY(!ready(p,barrier));
        auto stop=e;stop[u"invalidation"]=u"7720"_s;QVERIFY(!ready(p,stop));
    }
    void completeRangeAndQuoteExpiry() {
        auto p=plan(); auto r=result(); auto e=evidence(); const double now=r[u"now_ms"].toDouble();
        e[u"mode"]=u"range"_s;e[u"regime"]=u"range"_s;e[u"rangeLow"]=u"7700"_s;e[u"rangeHigh"]=u"7760"_s;
        for(const QString& k:{u"buffer"_s,u"absorption"_s}){e[k]=true;e[k+u"At"]=now;}
        QJsonArray quotes;
        for(const QString& key:{u"lower"_s,u"center"_s,u"upper"_s}) quotes.append(QJsonObject{{"strike",r[key]},
            {"market_data_type",1},{"bid_at",now},{"ask_at",now},{"bid_size",100},{"ask_size",100},{"bid_size_at",now},{"ask_size_at",now},{"iv_at",now},{"iv_value",0.2}});
        r[u"entry_quotes"]=quotes;p[u"result"]=r;QVERIFY(ready(p,e));
        // 人工核对一项都不勾也不挡写入，只在标题与摘要里提示
        auto bare=e;for(const auto& m:fly::entryReview(p,e,now)[u"manual"].toArray()){const QString k=m[u"key"].toString();bare.remove(k);bare.remove(k+u"At");}
        QVERIFY(ready(p,bare));QVERIFY(fly::entryReview(p,bare,now)[u"title"].toString().contains(u"未全勾"_s));
        auto quote=quotes[0].toObject();quote["bid_at"]=now-60001;quotes[0]=quote;r[u"entry_quotes"]=quotes;p[u"result"]=r;QVERIFY(!ready(p,e));
    }
    void evidenceCannotBeInvented() {
        QVERIFY(!ready(plan(),{}));
        auto e=evidence();e[u"regime"]=u"bear"_s;QVERIFY(!ready(plan(),e));
        e=evidence();e[u"regime"]=u""_s;QVERIFY(!ready(plan(),e));
        e=evidence();e[u"flow"]=u"single"_s;QVERIFY(!ready(plan(),e)); // 另需置信度、覆盖核对
        e=evidence();e.remove(u"holdAt"_s);QVERIFY(!ready(plan(),e));
        e=evidence();e[u"exitTime"]=u"14:00"_s;QVERIFY(!ready(plan(),e));
        e=evidence();e[u"fees"]=u""_s;QVERIFY(!ready(plan(),e));
        auto p=plan();auto r=result();r[u"legs"]=QJsonArray{};p[u"result"]=r;QVERIFY(!ready(p,evidence()));
    }
    void agesFailuresAndRange() {
        QVERIFY(!ready(plan(),evidence(),60001));
        auto p=plan();p[u"failure"]=u"离线"_s;QVERIFY(!ready(p,evidence()));
        p=plan();p[u"busy"]=true;QVERIFY(!ready(p,evidence()));
        p=plan();p[u"resultFor"]=u"old"_s;QVERIFY(!ready(p,evidence()));
        p=plan();auto r=result();r[u"now_ms"]=r[u"now_ms"].toDouble()+300001;p[u"result"]=r;QVERIFY(!ready(p,evidence(),300001));
        auto e=evidence();e[u"mode"]=u"range"_s;e[u"regime"]=u"range"_s;e[u"rangeLow"]=u"7700"_s;e[u"rangeHigh"]=u"7760"_s;
        for(const QString& k:{u"buffer"_s,u"absorption"_s}){e[k]=true;e[k+u"At"]=result()[u"now_ms"];}QVERIFY(!ready(plan(),e));
        e[u"rangeHigh"]=u"7740"_s;QVERIFY(!ready(plan(),e));
    }
    void controllerClearsOldEvidenceAndGuardsDraft() {
        fly::StoreDeps d;d.nowMs=[] {return result()[u"now_ms"].toDouble();};
        FlyStore store(d);store.set(plan());trade::ComposerDeps cd;TradeComposer composer(cd,QString());
        FlyController c(&store,nullptr,nullptr,nullptr,nullptr,&composer);c.now=d.nowMs;c.patchEntry(evidence());
        c.writeReviewedInstruction();QVERIFY(composer.text().isEmpty());
        for(const auto& m:c.entry()[u"manual"].toArray())c.checkEntry(m[u"key"].toString(),true);
        QVERIFY(!c.entry()[u"ready"].toBool());c.writeReviewedInstruction();QVERIFY(composer.text().isEmpty());
        composer.setText(QString());c.patch({{u"center"_s,u"7760"_s}});c.writeReviewedInstruction();c.writeInstruction();QVERIFY(composer.text().isEmpty());
        for(const auto& m:c.entry()[u"manual"].toArray())QVERIFY(!m[u"checked"].toBool());
    }
};
QTEST_GUILESS_MAIN(TestFlyEntry)
#include "tst_fly_entry.moc"
