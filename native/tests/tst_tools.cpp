// 诊断工具的参数:打错了要当场拒(退出码 2),不能悄悄变成 0 再去连。
// 端口一律给一个没人听的(先占住再放掉):万一检查漏了,连出去也只会被拒,碰不到真的 TWS。
#include <QProcess>
#include <QTcpServer>
#include <QTest>

using namespace Qt::StringLiterals;

namespace {

struct Result {
    int exitCode = -1;
    QString err;
};

Result run(const QString& program, const QStringList& args) {
    QProcess p;
    p.start(program, args);
    if (!p.waitForStarted(5000) || !p.waitForFinished(15000)) return {};
    return {p.exitCode(), QString::fromUtf8(p.readAllStandardError())};
}

QString deadPort() {
    QTcpServer probe;
    if (!probe.listen(QHostAddress::LocalHost, 0)) return u"1"_s;
    const quint16 port = probe.serverPort();
    probe.close();
    return QString::number(port);
}

}  // namespace

class TestTools : public QObject {
    Q_OBJECT
private slots:
    void positionsRejectsBadArguments_data() {
        QTest::addColumn<QStringList>("extra");
        QTest::addColumn<QString>("mentions");
        QTest::newRow("client id 打错") << QStringList{u"--client-id"_s, u"97OO"_s} << u"--client-id"_s;
        QTest::newRow("client id 0") << QStringList{u"--client-id"_s, u"0"_s} << u"主 client"_s;
        QTest::newRow("client id 负数") << QStringList{u"--client-id"_s, u"-3"_s} << u"--client-id"_s;
        QTest::newRow("超时带单位") << QStringList{u"--timeout"_s, u"8s"_s} << u"--timeout"_s;
        QTest::newRow("超时 0") << QStringList{u"--timeout"_s, u"0"_s} << u"--timeout"_s;
        QTest::newRow("超时 nan") << QStringList{u"--timeout"_s, u"nan"_s} << u"--timeout"_s;
        QTest::newRow("没给端口") << QStringList{u"--port"_s, u""_s} << u"--port"_s;
    }
    void positionsRejectsBadArguments() {
        QFETCH(QStringList, extra);
        QFETCH(QString, mentions);
        QStringList args{u"--port"_s, deadPort()};
        args += extra;
        const Result r = run(QStringLiteral(IBKR_TWS_POSITIONS_PATH), args);
        QCOMPARE(r.exitCode, 2);
        QVERIFY2(r.err.contains(mentions), qPrintable(r.err));
    }

    void positionsAcceptsGoodArgumentsAndFailsOnTheDeadPort() {
        // 参数都对时才去连;连的是没人听的端口,所以是"没读到持仓"(退出码 1),不是参数错
        const Result r = run(QStringLiteral(IBKR_TWS_POSITIONS_PATH),
                             {u"--port"_s, deadPort(), u"--client-id"_s, u"9701"_s, u"--timeout"_s, u"2"_s});
        QCOMPARE(r.exitCode, 1);
        QVERIFY2(r.err.contains(u"没读到持仓"_s), qPrintable(r.err));
    }

    void replayRejectsBadSpeed() {
        const Result r = run(QStringLiteral(IBKR_TWS_REPLAY_PATH), {u"/nonexistent.twsrec"_s, u"--speed"_s, u"fast"_s});
        QCOMPARE(r.exitCode, 2);
        QVERIFY2(r.err.contains(u"--speed"_s), qPrintable(r.err));
    }
};

QTEST_GUILESS_MAIN(TestTools)
#include "tst_tools.moc"
