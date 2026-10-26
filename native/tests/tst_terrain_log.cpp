#include "domain/terrain_log.h"
#include "util/error.h"
#include "util/jsobj.h"
#include <QTest>
#include <QTemporaryDir>
#include <QFile>
#include <QDateTime>
#include <QProcess>
using namespace Qt::StringLiterals;
using namespace ibkr;
namespace js = util::js;
class TestTerrainLog : public QObject {
    Q_OBJECT
    const QString date = u"2026-10-22"_s;
    const double t = double(QDateTime::fromString(u"2026-10-22T14:00:00Z"_s,Qt::ISODate).toMSecsSinceEpoch());
    util::OJson wall() { return *js::parse(uR"({"expiry":"20261022","spot":6000,"net_gex":-10,"regime":"negative","strikes":[{"strike":6000,"net_gex":-10}],"coverage":{"lower":5990,"upper":6010,"thinned":false},"account":"DU1234567","warnings":["secret"]})"_s); }
private slots:
    void asOfAndFailure() {
        QTemporaryDir dir; domain::TerrainLog log(dir.path()); auto w=wall();
        log.record(t,t+1000,&w); log.record(t+2000,t+3000,nullptr); log.record(t+4000,t+5000,&w);
        QCOMPARE(log.replay(date,t,300000).get(u"status"_s)->s,u"no_data"_s);
        QCOMPARE(log.replay(date,t+999,300000).get(u"visible_records"_s)->n,0.0);
        QCOMPARE(log.replay(date,t+1000,300000).get(u"status"_s)->s,u"observed_market_age_unknown"_s);
        QCOMPARE(log.replay(date,t+3000,300000).get(u"status"_s)->s,u"refresh_failed"_s);
        QCOMPARE(log.replay(date,t+5001,0).get(u"status"_s)->s,u"stale"_s);
        domain::TerrainLog restarted(dir.path());
        QCOMPARE(js::stringify(log.replay(date,t+5000,0)),js::stringify(restarted.replay(date,t+5000,0)));
        QFile f(log.fileOf(date)); QVERIFY(f.open(QIODevice::ReadOnly)); const auto bytes=f.readAll();
        QVERIFY(!bytes.contains("DU1234567") && !bytes.contains("secret"));
    }
    void tornTailAndValidation() {
        QTemporaryDir dir; domain::TerrainLog log(dir.path()); auto w=wall();
        log.record(t,t,&w);
        { QFile f(log.fileOf(date)); QVERIFY(f.open(QIODevice::Append)); f.write("{broken"); }
        log.record(t+1,t+1,&w);
        int bad=0; QCOMPARE(log.read(date,&bad).size(),2); QCOMPARE(bad,1);
        QCOMPARE(log.replay(date,t+1,10).get(u"status"_s)->s,u"incomplete_log"_s);
        QVERIFY_EXCEPTION_THROWN(log.read(u"../bad"_s),util::JsError);
        QVERIFY_EXCEPTION_THROWN(log.record(t,t-1,&w),util::JsError);
        QVERIFY_EXCEPTION_THROWN(log.replay(date,t,-1),util::JsError);
    }
    void orderedAndWriteFailure() {
        QTemporaryDir dir; domain::TerrainLog log(dir.path()); auto w=wall();
        log.record(t+3000,t+3000,&w); log.record(t,t,&w); log.record(t,t,nullptr);
        QCOMPARE(log.read(date).size(),3);
        QCOMPARE(log.replay(date,t,100).get(u"status"_s)->s,u"refresh_failed"_s);
        QFile blocked(dir.path()+u"/blocked"_s); QVERIFY(blocked.open(QIODevice::WriteOnly)); blocked.close();
        domain::TerrainLog impossible(blocked.fileName());
        QVERIFY_EXCEPTION_THROWN(impossible.record(t,t,&w),util::JsError);
        QVERIFY_EXCEPTION_THROWN(log.replay(u"2026-10-23"_s,t,100),util::JsError);
    }
    void missingFieldsAndVersion() {
        QTemporaryDir dir; domain::TerrainLog log(dir.path()); auto w=js::object();
        log.record(t,t,&w);
        int bad=0; const auto rows=log.read(date,&bad); QCOMPARE(rows.size(),1); QCOMPARE(bad,0);
        auto unsupported=rows.front(); unsupported.set(u"schema_version"_s,js::N(2));
        QFile f(log.fileOf(date)); QVERIFY(f.open(QIODevice::Append)); f.write(js::stringify(unsupported).toUtf8()+"\n"); f.close();
        QCOMPARE(log.read(date,&bad).size(),1); QCOMPARE(bad,1);
    }
    void cli() {
        QTemporaryDir dir; domain::TerrainLog log(dir.path()); auto w=wall(); log.record(t,t,&w);
        QProcess p; p.start(QStringLiteral(TERRAIN_REPLAY_PATH),{u"--dir"_s,dir.path(),u"--date"_s,date,u"--at"_s,u"2026-10-22T14:00:00Z"_s});
        QVERIFY(p.waitForFinished()); QCOMPARE(p.exitCode(),0);
        auto result=js::parse(QString::fromUtf8(p.readAllStandardOutput())); QVERIFY(result);
        QCOMPARE(result->get(u"visible_records"_s)->n,1.0);
        p.start(QStringLiteral(TERRAIN_REPLAY_PATH),{u"--dir"_s,dir.path(),u"--date"_s,date,u"--at"_s,u"2026-10-22T14:00:00"_s});
        QVERIFY(p.waitForFinished()); QCOMPARE(p.exitCode(),2);
    }
};
QTEST_GUILESS_MAIN(TestTerrainLog)
#include "tst_terrain_log.moc"
