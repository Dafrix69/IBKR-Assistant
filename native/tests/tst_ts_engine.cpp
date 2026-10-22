// 和真的 TS 引擎接一次:拉起 → ready → system.status → 关 stdin 退出码 0。
//
// 只在设了 IBKR_TS_ENGINE_ROOT(engine-ts 目录,dist 已编好、node_modules 装好)时跑,CI 里不跑。
// **绝不用仓库里的 config/settings.json**:配置是这里现写的一份——不自动连券商、各连接的端口是没人听的、
// 交易库在临时目录里。连 example 配置里的 db_path 都指着真的交易库,所以每一项都改掉。
#include "shell_harness.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QTcpServer>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

int deadPort() {
    QTcpServer probe;
    if (!probe.listen(QHostAddress::LocalHost, 0)) return 1;
    const int port = probe.serverPort();
    probe.close();
    return port;
}

/// example 配置改成碰不到任何真东西的一份,写进 dir
QString writeSafeConfig(const QTemporaryDir& dir) {
    QFile example(QStringLiteral(IBKR_REPO_DIR "/config/settings.example.json"));
    if (!example.open(QIODevice::ReadOnly)) qFatal("读不到 settings.example.json");
    QJsonObject c = QJsonDocument::fromJson(example.readAll()).object();
    QJsonObject broker = c.value(u"broker").toObject();
    broker.insert(u"auto_connect"_s, false);
    c.insert(u"broker"_s, broker);
    QJsonObject connections = c.value(u"connections").toObject();
    for (auto it = connections.begin(); it != connections.end(); ++it) {
        QJsonObject one = it.value().toObject();
        one.insert(u"port"_s, deadPort());
        it.value() = one;
    }
    c.insert(u"connections"_s, connections);
    c.insert(u"storage"_s, QJsonObject{{u"db_path"_s, dir.filePath(u"trades.db"_s)}});
    QJsonObject follow = c.value(u"follow").toObject();
    follow.insert(u"enabled"_s, false);
    c.insert(u"follow"_s, follow);
    const QString path = dir.filePath(u"settings.json"_s);
    QFile out(path);
    if (!out.open(QIODevice::WriteOnly)) qFatal("写不了临时配置");
    out.write(QJsonDocument(c).toJson());
    return path;
}

}  // namespace

class TestTsEngine : public QObject {
    Q_OBJECT
private slots:
    void readyStatusAndCleanExit() {
        const QString root = qEnvironmentVariable("IBKR_TS_ENGINE_ROOT");
        if (root.isEmpty()) QSKIP("没设 IBKR_TS_ENGINE_ROOT:不接真的 TS 引擎");
        QTemporaryDir dir;
        const QString config = writeSafeConfig(dir);
        QVERIFY2(!config.contains(u"config/settings.json"_s), qPrintable(config));

        shell::EngineClient engine([root, config] { return shell::resolveTsEngine({root, config, {}}); }, 8000);
        QSignalSpy events(&engine, &shell::EngineClient::engineEvent);
        QSignalSpy exited(&engine, &shell::EngineClient::exited);
        QStringList logs;
        QObject::connect(&engine, &shell::EngineClient::logLine, [&logs](const QString& l) { logs.append(l); });
        shell::CallOptions slow;
        slow.timeoutMs = 60'000;  // 第一次起来要编译 / 加载模块
        const shell::EngineReply status = callSync(engine, u"system.status"_s, QJsonObject{}, slow, 70'000);
        QVERIFY2(status.ok, qPrintable(status.error + u"\n"_s + logs.join(u'\n')));
        const QJsonObject s = status.result.toObject();
        QCOMPARE(s.value(u"protocol").toString(), u"1.0"_s);
        QCOMPARE(s.value(u"broker_connected").toBool(), false);
        QVERIFY(s.contains(u"tracker_loop"_s));
        QTRY_VERIFY(!events.isEmpty());
        QCOMPARE(events[0][0].toString(), u"ready"_s);
        QCOMPARE(events[0][1].toJsonValue().toObject().value(u"config").toString(), config);

        // 关 stdin:TS 引擎把在途的答完自己退(rpc/server.ts 的 serve),不挨 terminate
        bool stopped = false;
        engine.stop({}, [&stopped] { stopped = true; });
        QVERIFY(QTest::qWaitFor([&] { return stopped; }, 15'000));
        QCOMPARE(exited.size(), 0);
        QVERIFY2(logs.filter(u"旧引擎进程已退出(退出码 0)"_s).size() == 1, qPrintable(logs.join(u'\n')));
    }
};

QTEST_GUILESS_MAIN(TestTsEngine)
#include "tst_ts_engine.moc"
