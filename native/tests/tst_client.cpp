// 客户端与"读一次持仓":对着字节层的假 TWS(fake_tws.h)。钉两样:
// 发出去的请求一格不差、先后对(没认连接之前不发请求);不管 TWS 回什么怪东西,要么给出完整的一批,要么明说没要到。
#include "execution/tws/client.h"
#include "execution/tws/positions_snapshot.h"
#include "fake_tws.h"

#include <QSignalSpy>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTest>

using namespace ibkr;
using namespace Qt::StringLiterals;

namespace {

const tws::Client::Options kOptions{9700, tws::kMinVersion, tws::kMainMaxVersion};

struct Run {
    std::optional<tws::PositionsResult> result;
    QString failure;
};

/// 在假 TWS 上跑一趟读持仓,等到有结果(或 5 秒)
Run snapshot(test::FakeTws& tws, int timeoutMs = 3000) {
    tws::PositionsSnapshot snap(&tws, kOptions, timeoutMs);
    Run run;
    bool finished = false;
    QObject::connect(&snap, &tws::PositionsSnapshot::done, [&](const tws::PositionsResult& r) { run.result = r; finished = true; });
    QObject::connect(&snap, &tws::PositionsSnapshot::failed, [&](const QString& why) { run.failure = why; finished = true; });
    snap.start();
    if (!QTest::qWaitFor([&] { return finished; }, 5000)) run.failure = u"测试自己等超时了"_s;
    return run;
}

}  // namespace

class TestClient : public QObject {
    Q_OBJECT
private slots:
    void readsAllPositionsThenCancelsAndCloses() {
        test::FakeTws tws;
        tws.positions = {test::optionPosition(u"U1234567"_s, u"7790.0"_s, u"2"_s), test::optionPosition(u"DU7654321"_s, u"7765.0"_s, u"-1"_s)};
        const Run run = snapshot(tws);
        QVERIFY2(run.result, qPrintable(run.failure));
        QCOMPARE(run.result->serverVersion, 193);
        QCOMPARE(run.result->managedAccounts, u"U1234567,DU7654321"_s);
        QCOMPARE(run.result->positions.size(), 2);
        QCOMPARE(run.result->positions[1].contract.strike.value_or(0), 7765.0);
        QCOMPARE(run.result->positions[1].pos.value_or(0), -1.0);
        QCOMPARE(run.result->notices.size(), 1);
        QVERIFY(run.result->notices[0].info);
        // 握手报的是 v100..193;之后的请求依次是:报到、要持仓、撤持仓,然后自己关
        QCOMPARE(tws.handshakeSeen, tws::handshake(100, 193));
        QCOMPARE(tws.requests.size(), 3);
        QCOMPARE(tws.requests[0], (QStringList{u"71"_s, u"2"_s, u"9700"_s, QString()}));
        QCOMPARE(tws.requests[1], (QStringList{u"61"_s, u"1"_s}));
        QCOMPARE(tws.requests[2], (QStringList{u"64"_s, u"1"_s}));
        QVERIFY(tws.closedByClient);
    }

    void survivesAnyChunking() {
        // TWS 的回话在任意字节上被 TCP 切开:一个字节一块也得读对
        test::FakeTws tws;
        tws.chunkBytes = 1;
        tws.positions = {test::optionPosition(u"U1234567"_s, u"7790.0"_s, u"2"_s)};
        const Run run = snapshot(tws);
        QVERIFY2(run.result, qPrintable(run.failure));
        QCOMPARE(run.result->positions.size(), 1);
        QCOMPARE(run.result->positions[0].contract.localSymbol, u"SPXW  261007P07790000"_s);
    }

    void noPositionsIsAnEmptyBatchNotAFailure() {
        test::FakeTws tws;
        const Run run = snapshot(tws);
        QVERIFY2(run.result, qPrintable(run.failure));
        QVERIFY(run.result->positions.isEmpty());
    }

    void refusesVersionOutsideTheRange() {
        test::FakeTws tws;
        tws.versionReply = {u"200"_s, u"20261018 10:05:01"_s};  // 比 193 高:那一版的字段次序我们没核过
        const Run run = snapshot(tws);
        QVERIFY(!run.result);
        QVERIFY2(run.failure.contains(u"100..193"_s), qPrintable(run.failure));
        QVERIFY(tws.requests.isEmpty());  // 报到都没发
    }

    void refusesGarbageHandshake() {
        test::FakeTws tws;
        tws.versionReply = {u"hello"_s};
        const Run run = snapshot(tws);
        QVERIFY(!run.result);
        QVERIFY2(run.failure.contains(u"认不出"_s), qPrintable(run.failure));
    }

    void absurdFrameLengthDropsTheConnection() {
        test::FakeTws tws;
        tws.answerPositions = false;
        auto* t = &tws;
        QObject::connect(&tws, &tws::Transport::opened, &tws, [t] {
            QTimer::singleShot(20, t, [t] { t->sayRaw(QByteArray("\x7f\x00\x00\x00zz", 6)); });
        });
        const Run run = snapshot(tws);
        QVERIFY(!run.result);
        QVERIFY2(run.failure.contains(u"长度不对"_s), qPrintable(run.failure));
        QVERIFY(tws.closedByClient);
    }

    void truncatedPositionMeansNoBatch() {
        // 不许给半批:一条持仓的字段不够,整趟不采用
        test::FakeTws tws;
        tws.positions = {test::optionPosition(u"U1234567"_s, u"7790.0"_s, u"2"_s), {u"61"_s, u"3"_s, u"U1234567"_s, u"1"_s}};
        const Run run = snapshot(tws);
        QVERIFY(!run.result);
        QVERIFY2(run.failure.contains(u"字段不够"_s), qPrintable(run.failure));
    }

    void unknownMessagesAreSkipped() {
        test::FakeTws tws;
        tws.greetingExtras.append({u"999"_s, u"1"_s, u"something new"_s});
        tws.positions = {test::optionPosition(u"U1234567"_s, u"7790.0"_s, u"2"_s)};
        tws::Client client(&tws, kOptions);
        QSignalSpy skipped(&client, &tws::Client::skipped);
        QSignalSpy ready(&client, &tws::Client::ready);
        client.start();
        QVERIFY(ready.wait(2000));
        QTRY_COMPARE(skipped.size(), 1);
        QCOMPARE(skipped[0][0].toDouble(), 999.0);
    }

    void hangUpCarriesTheLastTwsError() {
        // 同一个 client id 第二次连:TWS 先报 326 再断
        test::FakeTws tws;
        tws.answerPositions = false;
        auto* t = &tws;
        QObject::connect(&tws, &tws::Transport::opened, &tws, [t] {
            t->say({{u"193"_s, u"20261018"_s}});
            t->say({{u"4"_s, u"2"_s, u"-1"_s, u"326"_s, u"Unable to connect as the client id is already in use."_s, QString()}});
            t->hangUp(u"TWS 关了连接"_s);
        });
        tws.answerHandshake = false;  // 握手回话由上面那段送
        const Run run = snapshot(tws);
        QVERIFY(!run.result);
        // 326 的请求号是 -1(通告的样子),但它不是 2104 那种"好消息":断的时候带上它
        QVERIFY2(run.failure.contains(u"TWS 关了连接"_s), qPrintable(run.failure));
        QVERIFY2(run.failure.contains(u"326"_s), qPrintable(run.failure));
    }

    void timesOutWhenTwsNeverFinishes() {
        test::FakeTws tws;
        tws.answerPositions = false;
        const Run run = snapshot(tws, 200);
        QVERIFY(!run.result);
        QVERIFY2(run.failure.contains(u"没有读完"_s), qPrintable(run.failure));
        QVERIFY(tws.closedByClient);
    }

    void requestsBeforeReadyAreNotSent() {
        test::FakeTws tws;
        tws::Client client(&tws, kOptions);
        client.requestPositions();  // 还没连
        client.start();
        QSignalSpy ready(&client, &tws::Client::ready);
        QVERIFY(ready.wait(2000));
        QCOMPARE(tws.requests.size(), 1);  // 只有报到
    }

    void realSocketOnLoopback() {
        // TcpTransport 本身:本机回环上的一个假服务端(不是 TWS,不连券商)
        QTcpServer server;
        if (!server.listen(QHostAddress::LocalHost, 0)) QSKIP("这台机器不让在 127.0.0.1 上监听(沙箱)");
        QByteArray seen;
        QObject::connect(&server, &QTcpServer::newConnection, &server, [&] {
            QTcpSocket* peer = server.nextPendingConnection();
            QObject::connect(peer, &QTcpSocket::readyRead, peer, [&seen, peer] {
                seen += peer->readAll();
                if (seen.size() >= 17 && !peer->property("greeted").toBool()) {
                    peer->setProperty("greeted", true);
                    peer->write(tws::frame({u"193"_s, u"20261018"_s}));
                }
            });
        });
        tws::TcpTransport tcp(u"127.0.0.1"_s, server.serverPort());
        tws::Client client(&tcp, kOptions);
        QSignalSpy shaken(&client, &tws::Client::handshaken);
        client.start();
        QVERIFY(shaken.wait(3000));
        QCOMPARE(shaken[0][0].toInt(), 193);
        QTRY_VERIFY(seen.size() >= 17 + tws::startApi(9700).size());
        QCOMPARE(seen.left(17), tws::handshake(100, 193));
        QCOMPARE(seen.mid(17), tws::startApi(9700));
        client.stop();
    }

    void restartStartsFromTheHandshake() {
        // 断了再连:上一条谈下来的版本、"已认"、半条消息都不带过来,新连接从握手、报到重来
        test::FakeTws tws;
        tws::Client client(&tws, kOptions);
        QSignalSpy ready(&client, &tws::Client::ready);
        QSignalSpy shaken(&client, &tws::Client::handshaken);
        client.start();
        QVERIFY(ready.wait(2000));
        tws.sayRaw(QByteArray("\0\0\0\x20" "61\0", 7));  // 一条只到了开头的消息,留在缓冲里
        QTest::qWait(20);
        client.stop();
        client.start();
        QTRY_COMPARE(ready.size(), 2);
        QCOMPARE(shaken.size(), 2);
        QCOMPARE(tws.opens, 2);
        QCOMPARE(tws.handshakeSeen, tws::handshake(100, 193));
        int startApis = 0;
        for (const QStringList& r : std::as_const(tws.requests)) startApis += r.value(0) == u"71"_s;
        QCOMPARE(startApis, 2);
        QVERIFY(client.isReady());
    }

    void tcpReconnectsOnLoopback() {
        // 真的 socket:第一条还连着(对方没关)时再 start,先断干净再连,第二条照样握手,也不把第一条的断开报成这一条的失败
        QTcpServer server;
        if (!server.listen(QHostAddress::LocalHost, 0)) QSKIP("这台机器不让在 127.0.0.1 上监听(沙箱)");
        QList<QByteArray> seen;
        QObject::connect(&server, &QTcpServer::newConnection, &server, [&] {
            QTcpSocket* peer = server.nextPendingConnection();
            const qsizetype index = seen.size();
            seen.append(QByteArray());
            QObject::connect(peer, &QTcpSocket::readyRead, peer, [&seen, index, peer] {
                seen[index] += peer->readAll();
                if (seen[index].size() >= 17 && !peer->property("greeted").toBool()) {
                    peer->setProperty("greeted", true);
                    peer->write(tws::frame({u"193"_s, u"20261018"_s}));
                }
            });
        });
        tws::TcpTransport tcp(u"127.0.0.1"_s, server.serverPort());
        tws::Client client(&tcp, kOptions);
        QSignalSpy shaken(&client, &tws::Client::handshaken);
        QSignalSpy failed(&client, &tws::Client::failed);
        client.start();
        QVERIFY(shaken.wait(3000));
        client.start();  // 不先 stop:transport 自己把上一条断掉
        QTRY_COMPARE(shaken.size(), 2);
        QTRY_COMPARE(seen.size(), 2);
        QTRY_VERIFY(seen[1].size() >= 17);
        QCOMPARE(seen[1].left(17), tws::handshake(100, 193));
        QCOMPARE(failed.size(), 0);
        client.stop();
    }

    void bigMessageInManyChunks() {
        // 一条 1 MB 的消息分成 64 KB 一块送到:照样读对(缓冲不每块都拷一遍)
        test::FakeTws tws;
        tws.chunkBytes = 64 * 1024;
        QStringList big = test::optionPosition(u"U1234567"_s, u"7790.0"_s, u"2"_s);
        big[12] = QString(1024 * 1024, u'x');
        tws.positions = {big, test::optionPosition(u"DU7654321"_s, u"7765.0"_s, u"-1"_s)};
        const Run run = snapshot(tws);
        QVERIFY2(run.result, qPrintable(run.failure));
        QCOMPARE(run.result->positions.size(), 2);
        QCOMPARE(run.result->positions[0].contract.localSymbol.size(), 1024 * 1024);
        QCOMPARE(run.result->positions[1].pos.value_or(0), -1.0);
    }

    void connectionRefusedIsAFailure() {
        // 找一个没人听的端口:先占住再放掉
        QTcpServer probe;
        if (!probe.listen(QHostAddress::LocalHost, 0)) QSKIP("这台机器不让在 127.0.0.1 上监听(沙箱)");
        const quint16 port = probe.serverPort();
        probe.close();
        tws::TcpTransport tcp(u"127.0.0.1"_s, port);
        tws::PositionsSnapshot snap(&tcp, kOptions, 3000);
        QSignalSpy failed(&snap, &tws::PositionsSnapshot::failed);
        snap.start();
        QVERIFY(failed.wait(4000));
        QVERIFY2(failed[0][0].toString().contains(u"连接出错"_s), qPrintable(failed[0][0].toString()));
    }
};

QTEST_GUILESS_MAIN(TestClient)
#include "tst_client.moc"
