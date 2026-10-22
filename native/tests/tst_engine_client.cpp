// 拉起引擎的那一层(shell/engine_client):逐条照 engine-ts/tests/desktop-engine-client.spec.ts 搬,外加几条 C++ 版自己的。
// 重启时绝不能留下第二个活着的引擎——2026-09-27 的事故:旧引擎迟到的退出清掉了新引擎的引用,新引擎成了没人管的孤儿,
// 还连着 TWS、还跑着盯盘节拍会发平仓单。这里用一个真的子进程当假引擎(fake_engine),不连任何券商。
#include "shell_harness.h"

#include <QThread>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

/// drainMs 默认给得很短:假引擎默认不认 EOF,每次 stop 都白等满这段时间。测排空的用例自己给长的
struct Client {
    explicit Client(QHash<QString, QString> env = {}, int drainMs = 40)
        : c(fakeEngine(std::move(env)), drainMs) {
        QObject::connect(&c, &shell::EngineClient::exited, [this](const shell::EngineExit& e) { exits.append(e); });
        QObject::connect(&c, &shell::EngineClient::lateReply, [this](const shell::LateReply& l) { lates.append(l); });
        QObject::connect(&c, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
    }
    ~Client() {
        shell::StopOptions o;
        o.killGraceMs = 200;
        o.drainMs = 0;
        stopSync(c, o);
    }
    shell::EngineClient c;
    QList<shell::EngineExit> exits;
    QList<shell::LateReply> lates;
    QStringList logs;
};

#if defined(Q_OS_UNIX)
constexpr bool kUnix = true;
#else
constexpr bool kUnix = false;
#endif

}  // namespace

class TestEngineClient : public QObject {
    Q_OBJECT
private slots:
    // ---- 重启是先死后生 ----
    void restartLeavesExactlyOneEngine() {
        Client h;
        const qint64 first = pidOf(callSync(h.c, u"system.status"_s));
        QVERIFY(first > 0);
        QCOMPARE(restartSync(h.c), QString());
        const qint64 second = pidOf(callSync(h.c, u"system.status"_s));
        QVERIFY(second != first);
        if (kUnix) {
            QVERIFY(!alive(first));
            QVERIFY(alive(second));
        }
        QCOMPARE(h.c.pid(), second);
        // 自己停的不算"引擎意外退出":不发 exited,主进程也就不会去自动拉起、界面不会弹"引擎已退出"
        QCOMPARE(h.exits.size(), 0);
    }

    void stopThenStartWithoutWaiting() {
        // 老写法 stop(); start() 不等:start 也会等旧进程退干净,旧进程迟到的退出不会清掉新引擎
        Client h;
        const qint64 first = pidOf(callSync(h.c, u"system.status"_s));
        h.c.stop();
        QCOMPARE(startSync(h.c), QString());
        const qint64 second = h.c.pid();
        if (kUnix) QVERIFY(!alive(first));  // 新的拉起时旧的已经死了
        QTest::qWait(150);                  // 给迟到的事件留时间
        QCOMPARE(h.c.pid(), second);
        QCOMPARE(pidOf(callSync(h.c, u"system.status"_s)), second);
        QCOMPARE(h.exits.size(), 0);
    }

    void ignoresTermThenKilledAfterGrace() {
        if (!kUnix) QSKIP("Windows 没有信号:kill 就是直接结束进程,没有宽限期可量");
        Client h({{u"FAKE_IGNORE_TERM"_s, u"1"_s}});
        const qint64 pid = pidOf(callSync(h.c, u"system.status"_s));
        QElapsedTimer t;
        t.start();
        shell::StopOptions o;
        o.killGraceMs = 150;
        QVERIFY(stopSync(h.c, o));
        QVERIFY2(t.elapsed() >= 140, qPrintable(QString::number(t.elapsed())));
        QVERIFY(!alive(pid));
    }

    void crashRejectsInFlightAndReportsExit() {
        // 正在用的引擎崩了:拒掉发给它的在途调用,并发 exited(主进程据此自动拉起)
        Client h;
        callSync(h.c, u"system.status"_s);
        Async hanging;
        callAsync(h.c, hanging, u"hang"_s);
        const shell::EngineReply crashed = callSync(h.c, u"crash"_s);
        QVERIFY2(crashed.error.contains(u"交易引擎已退出"_s), qPrintable(crashed.error));
        QVERIFY(hanging.wait());
        QVERIFY2(hanging.reply->error.contains(u"交易引擎已退出"_s), qPrintable(hanging.reply->error));
        QCOMPARE(h.exits.size(), 1);
        QCOMPARE(h.exits[0].code, 3);
        QVERIFY(!h.c.running());
        // 下一次调用会拉起新的
        QVERIFY(pidOf(callSync(h.c, u"system.status"_s)) > 0);
    }

    void shortTimeoutRejectsOnlyThatCall() {
        // 单次调用可以给短超时(心跳用),超时只拒这一次,不影响引擎
        Client h;
        const qint64 pid = pidOf(callSync(h.c, u"system.status"_s));
        shell::CallOptions o;
        o.timeoutMs = 80;
        const shell::EngineReply r = callSync(h.c, u"hang"_s, QJsonObject{}, o);
        QVERIFY2(r.error.contains(u"超时"_s), qPrintable(r.error));
        QCOMPARE(r.error, u"调用 hang 超时(0.08s)"_s);
        QCOMPARE(pidOf(callSync(h.c, u"system.status"_s)), pid);
    }

    void writtenGoesDownWithOldEngineNotYetGoesToNew() {
        // 已经发给旧引擎的调用随旧引擎一起被拒;还没发出去的等新引擎起来再发
        Client h;
        const qint64 first = pidOf(callSync(h.c, u"system.status"_s));
        Async written;
        callAsync(h.c, written, u"hang"_s);
        QTest::qWait(30);  // 确认已经写进旧引擎的 stdin
        Async notYet;
        callAsync(h.c, notYet, u"system.status"_s);  // 与 restart 同一拍发起
        std::optional<QString> restarted;
        h.c.restart({}, [&restarted](const QString& e) { restarted = e; });
        QVERIFY(written.wait());
        QVERIFY2(written.reply->error.contains(u"交易引擎已退出"_s), qPrintable(written.reply->error));
        QVERIFY(QTest::qWaitFor([&] { return restarted.has_value(); }, 8000));
        QVERIFY(notYet.wait());
        const qint64 pid = pidOf(*notYet.reply);
        QVERIFY2(pid != first, qPrintable(notYet.reply->error));
        QCOMPARE(pid, h.c.pid());
    }

    void finalStopNeverStartsAgain() {
        Client h;
        const qint64 pid = pidOf(callSync(h.c, u"system.status"_s));
        shell::StopOptions o;
        o.final = true;
        QVERIFY(stopSync(h.c, o));
        if (kUnix) QVERIFY(!alive(pid));
        const shell::EngineReply r = callSync(h.c, u"system.status"_s);
        QVERIFY2(r.error.contains(u"应用正在退出"_s), qPrintable(r.error));
        QVERIFY(!h.c.running());
    }

    // ---- 停引擎先排空 ----
    void stopClosesStdinFirstAndLetsInFlightFinish() {
        // drainMs 给足:sanitizer 编法里进程退出本身就要一两秒,别让它被当成"不认 EOF"
        Client h({{u"FAKE_EXIT_ON_EOF"_s, u"1"_s}}, 8000);
        const qint64 pid = pidOf(callSync(h.c, u"system.status"_s));
        Async inFlight;
        callAsync(h.c, inFlight, u"slow"_s, QJsonObject{{u"ms"_s, 150}});  // 正在发的那张单
        QTest::qWait(30);
        QElapsedTimer t;
        t.start();
        QVERIFY(stopSync(h.c));
        // 在途的那一次答完了(以前 SIGTERM 先到,它被拒成「交易引擎已退出」)
        QVERIFY(inFlight.wait());
        QCOMPARE(pidOf(*inFlight.reply), pid);
        // 引擎是自己退的(退出码 0),没挨 terminate(那是信号 15);也没等满 drainMs
        QVERIFY2(h.logs.contains(u"[engine] 旧引擎进程已退出(退出码 0)"_s), qPrintable(h.logs.join(u'\n')));
        QVERIFY2(t.elapsed() < 8000, qPrintable(QString::number(t.elapsed())));
        if (kUnix) QVERIFY(!alive(pid));
        QCOMPARE(h.exits.size(), 0);
    }

    void engineIgnoringEofGetsTerminatedAfterDrain() {
        Client h({}, 120);
        const qint64 pid = pidOf(callSync(h.c, u"system.status"_s));
        QElapsedTimer t;
        t.start();
        QVERIFY(stopSync(h.c));
        QVERIFY(t.elapsed() >= 110);
        if (kUnix) QVERIFY(!alive(pid));
    }

    void zeroDrainTerminatesAtOnce() {
        // drainMs = 0 不等(心跳判死的引擎):立刻 terminate
        Client h({}, 5000);
        const qint64 pid = pidOf(callSync(h.c, u"system.status"_s));
        QElapsedTimer t;
        t.start();
        shell::StopOptions o;
        o.drainMs = 0;
        QCOMPARE(restartSync(h.c, o), QString());
        QVERIFY2(t.elapsed() < 2000, qPrintable(QString::number(t.elapsed())));
        if (kUnix) QVERIFY(!alive(pid));
        QVERIFY(pidOf(callSync(h.c, u"system.status"_s)) != pid);
    }

    // ---- 超时不等于没发生 ----
    void lateReplyAfterTimeout() {
        Client h;
        const qint64 pid = pidOf(callSync(h.c, u"system.status"_s));
        shell::CallOptions o;
        o.timeoutMs = 60;
        o.lateReply = true;
        const shell::EngineReply r = callSync(h.c, u"slow"_s, QJsonObject{{u"ms"_s, 200}}, o);
        QCOMPARE(r.code, u"ENGINE_TIMEOUT"_s);
        QCOMPARE(h.lates.size(), 0);
        QTRY_COMPARE(h.lates.size(), 1);
        QCOMPARE(h.lates[0].method, u"slow"_s);
        QVERIFY(h.lates[0].ok);
        QCOMPARE(h.lates[0].result.toObject().value(u"pid").toInteger(), pid);
        QVERIFY(h.lates[0].waitedMs >= 150);
    }

    void noLateReplyUnlessAsked() {
        // 没要 lateReply 的(轮询、心跳):迟到的回执照旧丢掉,不发信号
        Client h;
        callSync(h.c, u"system.status"_s);
        shell::CallOptions o;
        o.timeoutMs = 40;
        QVERIFY(callSync(h.c, u"slow"_s, QJsonObject{{u"ms"_s, 120}}, o).error.contains(u"超时"_s));
        QTest::qWait(200);
        QCOMPARE(h.lates.size(), 0);
    }

    void lateRepliesDieWithTheEngine() {
        Client h;
        callSync(h.c, u"system.status"_s);
        shell::CallOptions o;
        o.timeoutMs = 40;
        o.lateReply = true;
        QVERIFY(callSync(h.c, u"slow"_s, QJsonObject{{u"ms"_s, 300}}, o).error.contains(u"超时"_s));
        QVERIFY(callSync(h.c, u"crash"_s).error.contains(u"交易引擎已退出"_s));
        QTest::qWait(350);
        QCOMPARE(h.lates.size(), 0);
    }

    // ---- 重启退避拦得住轮询 ----
    void holdUntilBlocksLazyStart() {
        Client h;
        callSync(h.c, u"system.status"_s);
        QVERIFY(callSync(h.c, u"crash"_s).error.contains(u"交易引擎已退出"_s));
        QCOMPARE(h.exits.size(), 1);
        h.c.holdUntil(QDateTime::currentMSecsSinceEpoch() + 250);
        const shell::EngineReply held = callSync(h.c, u"system.status"_s);
        QVERIFY2(held.error.contains(u"秒后自动重启"_s), qPrintable(held.error));
        QVERIFY(!h.c.running());
        QCOMPARE(h.exits.size(), 1);  // 被退避挡下的调用不算一次"引擎退出"
        QTest::qWait(280);
        QVERIFY(pidOf(callSync(h.c, u"system.status"_s)) > 0);
    }

    void holdReasonIsReportedAsIs() {
        Client h;
        callSync(h.c, u"system.status"_s);
        QVERIFY(callSync(h.c, u"crash"_s).error.contains(u"交易引擎已退出"_s));
        h.c.holdUntil(std::numeric_limits<qint64>::max(), u"交易引擎没有启动:配置文件有问题,请按弹出的提示处理"_s);
        QCOMPARE(callSync(h.c, u"system.status"_s).error, u"交易引擎没有启动:配置文件有问题,请按弹出的提示处理"_s);
    }

    void forceStartIgnoresHold() {
        // 手动重启与主进程到点的那一次拉起(force)不受退避管
        Client h;
        callSync(h.c, u"system.status"_s);
        QVERIFY(callSync(h.c, u"crash"_s).error.contains(u"交易引擎已退出"_s));
        h.c.holdUntil(QDateTime::currentMSecsSinceEpoch() + 60'000);
        QCOMPARE(startSync(h.c, true), QString());
        QVERIFY(pidOf(callSync(h.c, u"system.status"_s)) > 0);
        h.c.holdUntil(QDateTime::currentMSecsSinceEpoch() + 60'000);  // 引擎活着时设了也不影响调用
        QVERIFY(pidOf(callSync(h.c, u"system.status"_s)) > 0);
        QCOMPARE(restartSync(h.c), QString());
        QVERIFY(pidOf(callSync(h.c, u"system.status"_s)) > 0);
    }

    // ---- C++ 版自己的 ----
    void resolverErrorIsAnExit() {
        // 拉不起来(入口不在、找不到 node):调用报那句人话,也算一次退出(主进程据此退避、界面显示原因)
        shell::EngineClient c([] { return shell::ResolvedEngine{std::nullopt, u"找不到引擎入口 /x/dist/src/cli.js"_s}; });
        QSignalSpy exited(&c, &shell::EngineClient::exited);
        const shell::EngineReply r = callSync(c, u"system.status"_s);
        QCOMPARE(r.error, u"找不到引擎入口 /x/dist/src/cli.js"_s);
        QCOMPARE(exited.size(), 1);
        QCOMPARE(exited[0][0].value<shell::EngineExit>().code, -1);
    }

    void programThatCannotStart() {
        shell::EngineClient c([] {
            shell::EngineCommand cmd;
            cmd.program = u"/nonexistent/ibkr-engine"_s;
            cmd.label = u"missing"_s;
            return shell::ResolvedEngine{cmd, {}};
        });
        QSignalSpy exited(&c, &shell::EngineClient::exited);
        const shell::EngineReply r = callSync(c, u"system.status"_s);
        QVERIFY2(r.error.contains(u"无法启动引擎"_s), qPrintable(r.error));
        QTRY_COMPARE(exited.size(), 1);
        QVERIFY(!c.running());
    }

    void eventsAndNonJsonLines() {
        Client h;
        QSignalSpy events(&h.c, &shell::EngineClient::engineEvent);
        QVERIFY(callSync(h.c, u"emit"_s, QJsonObject{{u"event"_s, u"breaker"_s}, {u"data"_s, QJsonObject{{u"engaged"_s, true}}}}).ok);
        QCOMPARE(events.size(), 1);
        QCOMPARE(events[0][0].toString(), u"breaker"_s);
        QVERIFY(callSync(h.c, u"garbage"_s).ok);
        QVERIFY(h.logs.contains(u"[非 JSON 输出] this is not json"_s));
    }

    void stderrIsTheLogAndExitDetail() {
        Client h({{u"FAKE_EXIT_AT_START"_s, u"78"_s}, {u"FAKE_STDERR"_s, u"[fatal:config:syntax] 配置文件不是合法的 JSON"_s}});
        QSignalSpy exited(&h.c, &shell::EngineClient::exited);
        callSync(h.c, u"system.status"_s);
        QTRY_COMPARE(exited.size(), 1);
        const auto info = exited[0][0].value<shell::EngineExit>();
        QCOMPARE(info.code, 78);
        QVERIFY2(info.detail.contains(u"[fatal:config:syntax] 配置文件不是合法的 JSON"_s), qPrintable(info.detail));
    }

    void signalIsReported() {
        if (!kUnix) QSKIP("Windows 没有信号");
        Client h;
        callSync(h.c, u"system.status"_s);
        callSync(h.c, u"selfterm"_s, QJsonObject{}, {}, 3000);
        QTRY_COMPARE(h.exits.size(), 1);
        QCOMPARE(h.exits[0].signal, 15);
    }

    void destructorDrainsInFlight() {
        // 退出应用时(EngineClient 析构)也先关 stdin、让在途的答完,不拦腰打断
        auto c = std::make_unique<shell::EngineClient>(fakeEngine({{u"FAKE_EXIT_ON_EOF"_s, u"1"_s}}), 8000);
        const qint64 pid = pidOf(callSync(*c, u"system.status"_s));
        Async inFlight;
        callAsync(*c, inFlight, u"slow"_s, QJsonObject{{u"ms"_s, 100}});
        QTest::qWait(30);
        QElapsedTimer t;
        t.start();
        c.reset();
        // 没等满 drainMs(8 秒)就退了:是关 stdin 之后自己退的,不是到点被 terminate
        QVERIFY2(t.elapsed() < 8000, qPrintable(QString::number(t.elapsed())));
        if (kUnix) QVERIFY(!alive(pid));
    }
};

QTEST_GUILESS_MAIN(TestEngineClient)
#include "tst_engine_client.moc"
