// 预览引擎(desktop/tools/preview_engine.js):Qt 版拿预览台同一份 mock 数据。没有出路到券商。
#include "shell_harness.h"

#include <QJsonArray>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

class TestPreviewEngine : public QObject {
    Q_OBJECT
private slots:
    void answersFromTheMockData() {
        const QString node = shell::findNode();
        if (node.isEmpty()) QSKIP("没有 node");
        shell::EngineClient engine([] { return shell::resolvePreviewEngine(QStringLiteral(IBKR_REPO_DIR)); }, 2000);
        QSignalSpy events(&engine, &shell::EngineClient::engineEvent);
        const auto status = callSync(engine, u"system.status"_s);
        QVERIFY2(status.ok, qPrintable(status.error));
        QCOMPARE(status.result.toObject().value(u"protocol").toString(), u"1.0"_s);
        QVERIFY(status.result.toObject().value(u"accounts").toArray().size() > 0);
        QVERIFY(!events.isEmpty());
        QCOMPARE(events[0][0].toString(), u"ready"_s);
        // 预览台的持仓追踪里有 NVDA(demo 场景以 TWS 为当前券商,富途只是次要)
        const auto tracks = callSync(engine, u"tracker.list"_s);
        QVERIFY(tracks.ok);
        QVERIFY(tracks.result.toObject().value(u"tracks").toArray().size() > 0);
        QVERIFY(callSync(engine, u"records.list"_s, QJsonObject{{u"limit"_s, 5}}).ok);
        // 没有假数据的方法:明说,不编
        const auto none = callSync(engine, u"no.such"_s);
        QVERIFY2(none.error.contains(u"预览引擎没有这个方法的假数据"_s), qPrintable(none.error));
        shell::StopOptions o;
        o.drainMs = 3000;
        QVERIFY(stopSync(engine, o));
    }
};

QTEST_GUILESS_MAIN(TestPreviewEngine)
#include "tst_preview_engine.moc"
