#include "shell/terrain_controller.h"
#include <QTest>
using namespace ibkr::shell;
using namespace Qt::StringLiterals;
namespace {
QJsonObject row(double t, bool failed=false, double g=2) {
    return {{u"received_at"_s,t},{u"status"_s,failed?u"refresh_failed"_s:u"observed"_s},
        {u"wall"_s,QJsonObject{{u"spot"_s,6000},{u"strikes"_s,QJsonArray{QJsonObject{{u"strike"_s,6000},{u"net_gex"_s,g}}}}}}};
}
EngineReply response(QJsonArray rows) { EngineReply r;r.ok=true;r.result=QJsonObject{{u"dates"_s,QJsonArray{u"2026-10-22"_s}},{u"records"_s,rows},{u"rejected_records"_s,0}};return r; }
}
class TestTerrainController:public QObject {
    Q_OBJECT
private slots:
    void seekAndGaps() {
        TerrainController c(nullptr);
        const double t=1792677600000.0;
        c.request=[&](const QJsonObject&,Bridge::RpcDone done){done(response({row(t),row(t+600000,true),row(t+900000,false,100)}));};
        c.selectDate(u"2026-10-22"_s);
        QCOMPARE(c.model()[u"index"].toInt(),1);
        QCOMPARE(c.model()[u"scale"].toDouble(),100.0);
        c.seek(t+400000);QVERIFY(c.model()[u"status"].toString().contains(u"超过五分钟"));QCOMPARE(c.model()[u"index"].toInt(),1);
        c.step(1);QCOMPARE(c.model()[u"index"].toInt(),2);QVERIFY(c.model()[u"rows"].toArray().isEmpty());
        c.step(1);QCOMPARE(c.model()[u"index"].toInt(),3);
        c.step(-1);QCOMPARE(c.model()[u"index"].toInt(),2);
        c.seek(t-1000);QCOMPARE(c.model()[u"index"].toInt(),1);
    }
    void staleRepliesAndDestruction() {
        QList<Bridge::RpcDone> pending;
        auto c=std::make_unique<TerrainController>(nullptr);
        c->request=[&](const QJsonObject&,Bridge::RpcDone done){pending.append(done);};
        c->selectDate(u"2026-10-21"_s);c->selectDate(u"2026-10-22"_s);
        pending[1](response({row(2000)}));pending[0](response({row(1000)}));
        QCOMPARE(c->model()[u"begin"].toDouble(),2000.0);
        c->refresh();c.reset();pending.last()(response({row(3000)}));
    }
    void emptyAndError() {
        TerrainController c(nullptr);c.refresh();QVERIFY(c.model()[u"status"].toString().contains(u"未连接"));
        c.request=[](const QJsonObject&,Bridge::RpcDone done){done(response({}));};
        c.selectDate(u"2026-10-22"_s);QCOMPARE(c.model()[u"count"].toInt(),0);QVERIFY(!c.model()[u"busy"].toBool());
    }
};
QTEST_GUILESS_MAIN(TestTerrainController)
#include "tst_terrain_controller.moc"
