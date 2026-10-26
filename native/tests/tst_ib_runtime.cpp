// 回调可以释放会话的最后一份引用;运行时要撑到当前宏任务与微任务全部结束。
#include "execution/ib_api_next.h"
#include "execution/ib_session.h"
#include "util/error.h"

#include <QTcpServer>
#include <QTcpSocket>
#include <QTest>
#include <QtEndian>

using namespace ibkr::execution;
using namespace Qt::StringLiterals;

class TestIbRuntime : public QObject {
    Q_OBJECT
private slots:
    void scopeKeepsRuntimeAliveWhileDraining() {
        auto runtime = ibnext::makeQtRuntime();
        const std::weak_ptr<ibnext::Runtime> weak = runtime;
        bool alive = false;
        int steps = 0;
        {
            ibnext::Runtime::Scope scope(*runtime);
            runtime->queueMicrotask([&] { runtime.reset(); alive = !weak.expired(); ++steps; });
            runtime->queueMicrotask([&] { ++steps; });
        }
        QVERIFY(alive);
        QCOMPARE(steps, 2);
        QVERIFY(weak.expired());
    }

    void immediateMicrotaskCanReleaseOwner() {
        auto runtime = ibnext::makeQtRuntime();
        const std::weak_ptr<ibnext::Runtime> weak = runtime;
        bool alive = false;
        runtime->queueMicrotask([&] { runtime.reset(); alive = !weak.expired(); });
        QVERIFY(alive);
        QVERIFY(weak.expired());
    }

    void timerCanReleaseOwnerDuringMicrotasks() {
        auto runtime = ibnext::makeQtRuntime();
        const std::weak_ptr<ibnext::Runtime> weak = runtime;
        bool alive = false;
        int steps = 0;
        runtime->setTimeout(1, [&] {
            runtime->queueMicrotask([&] { runtime.reset(); alive = !weak.expired(); ++steps; });
            runtime->queueMicrotask([&] { ++steps; });
        });
        QTRY_COMPARE(steps, 2);
        QVERIFY(alive);
        QVERIFY(weak.expired());
    }

    void connectionTimeoutReleasesRuntimeSafely() {
        // 只接测试自己开的回环端口;对端不回握手,走真实的连接超时定时器。
        QTcpServer server;
        QVERIFY(server.listen(QHostAddress::LocalHost, 0));
        QObject::connect(&server, &QTcpServer::newConnection, &server, [&] {
            while (server.hasPendingConnections()) {
                QTcpSocket* socket = server.nextPendingConnection();
                QObject::connect(socket, &QTcpSocket::readyRead, socket, [socket] { socket->readAll(); });
            }
        });
        IbSessionDeps deps;
        deps.runtime = ibnext::makeQtRuntime();
        deps.log = [](const QString&) {};
        const std::weak_ptr<ibnext::Runtime> weak = deps.runtime;
        SessionConfig config;
        config.host = u"127.0.0.1"_s;
        config.port = server.serverPort();
        config.clientId = 91;
        auto task = createIbApiNextSession(config, std::move(deps));
        bool continuationRan = false, continuationKeptRuntime = false;
        task.onDone([&] {
            if (auto runtime = weak.lock()) runtime->queueMicrotask([&] {
                continuationRan = true;
                continuationKeptRuntime = !weak.expired();
            });
        });
        QTRY_VERIFY_WITH_TIMEOUT(task.done(), 12000);
        QVERIFY(task.error());
        try {
            task.result();
            QFAIL("应当报连接超时");
        } catch (const ibkr::util::JsError& error) {
            QCOMPARE(error.message(), u"连接超时"_s);
        }
        QVERIFY(continuationRan);
        QVERIFY(continuationKeptRuntime);
        QTRY_VERIFY(weak.expired());
    }

    void successfulHandshakeAndDisconnect() {
        QTcpServer server;
        QVERIFY(server.listen(QHostAddress::LocalHost, 0));
        const auto frame = [](const QStringList& tokens) {
            QByteArray payload;
            for (const QString& token : tokens) { payload += token.toUtf8(); payload += '\0'; }
            char size[4];
            qToBigEndian<quint32>(quint32(payload.size()), size);
            return QByteArray(size, 4) + payload;
        };
        QObject::connect(&server, &QTcpServer::newConnection, &server, [&] {
            while (server.hasPendingConnections()) {
                QTcpSocket* socket = server.nextPendingConnection();
                auto replied = std::make_shared<bool>(false);
                QObject::connect(socket, &QTcpSocket::readyRead, socket, [socket, replied, frame] {
                    socket->readAll();
                    if (*replied) return;
                    *replied = true;
                    socket->write(frame({u"193"_s, u"20261026 10:00:00 Asia/Shanghai"_s})
                                  + frame({u"15"_s, u"1"_s, u"DU_TEST"_s}) + frame({u"9"_s, u"1"_s, u"1"_s}));
                });
            }
        });
        IbSessionDeps deps;
        deps.runtime = ibnext::makeQtRuntime();
        deps.log = [](const QString&) {};
        const std::weak_ptr<ibnext::Runtime> weak = deps.runtime;
        SessionConfig config;
        config.host = u"127.0.0.1"_s;
        config.port = server.serverPort();
        config.clientId = 92;
        config.readonly = true;
        auto task = createIbApiNextSession(config, std::move(deps));
        QTRY_VERIFY_WITH_TIMEOUT(task.done(), 3000);
        QVERIFY(!task.error());
        auto session = task.result();
        QVERIFY(session->isConnected());
        QCOMPARE(session->managedAccounts(), QStringList{u"DU_TEST"_s});
        auto disconnected = session->disconnect();
        QTRY_VERIFY(disconnected.done());
        QVERIFY(!disconnected.error());
        QVERIFY(!session->isConnected());
        session.reset();
        task = {};
        QTRY_VERIFY(weak.expired());
    }
};

QTEST_GUILESS_MAIN(TestIbRuntime)
#include "tst_ib_runtime.moc"
