// 引擎的生与死(shell/engine_supervisor):照 desktop/main.js 的 wireEngine / startEngineWatchdog / drivePending。
// 时长全部改短注进去;只钉先后与个数(退避一次比一次长、到顶不再长),不钉绝对毫秒(慢的 CI 机器上会更久)。
#include "shell/engine_supervisor.h"
#include "shell_harness.h"

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

shell::SupervisorTiming fast() {
    shell::SupervisorTiming t;
    t.restartBaseMs = 40;
    t.restartMaxMs = 200;
    t.resetAfterMs = 400;
    t.watchdogEveryMs = 30;
    t.watchdogTimeoutMs = 25;
    t.warnAfterMs = 80;
    t.killAfterMs = 10'000;
    t.pendingPollTimeoutMs = 2000;
    return t;
}

struct Rig {
    explicit Rig(QHash<QString, QString> env, shell::SupervisorTiming timing = fast())
        : engine(fakeEngine(std::move(env)), 40), supervisor(&engine, timing) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        QObject::connect(&supervisor, &shell::EngineSupervisor::engineExited, [this](const shell::EngineExit& e, int in) {
            exits.append(e);
            restartIn.append(in);
        });
        QObject::connect(&supervisor, &shell::EngineSupervisor::fatal, [this](const QString& k, const QString& m) {
            fatalKind = k;
            fatalMessage = m;
        });
    }
    ~Rig() {
        supervisor.prepareQuit();
        shell::StopOptions o;
        o.drainMs = 0;
        o.killGraceMs = 200;
        stopSync(engine, o);
    }
    int count(const QString& line) const { return static_cast<int>(logs.count(line)); }

    shell::EngineClient engine;
    shell::EngineSupervisor supervisor;
    QStringList logs;
    QList<shell::EngineExit> exits;
    QList<int> restartIn;
    QString fatalKind;
    QString fatalMessage;
};

}  // namespace

class TestEngineSupervisor : public QObject {
    Q_OBJECT
private slots:
    void configErrorStopsRestarts() {
        // 配置读不进来(退出码 78):重启一万次也是同一个错。停下自动重启,原因认 stderr 里那一行
        Rig r({{u"FAKE_EXIT_AT_START"_s, u"78"_s},
               {u"FAKE_STDERR"_s, u"[engine] 启动\\n[fatal:config:syntax] 配置文件不是合法的 JSON:Unexpected end of JSON input"_s}});
        r.supervisor.start();
        QTRY_COMPARE(r.exits.size(), 1);
        QCOMPARE(r.restartIn[0], -1);
        QCOMPARE(r.fatalKind, u"config"_s);
        QCOMPARE(r.fatalMessage, u"配置文件不是合法的 JSON:Unexpected end of JSON input"_s);
        QTest::qWait(300);  // 退避的基数是 40 毫秒:要是会重启,这时候早该重启好几次了
        QCOMPARE(r.exits.size(), 1);
        // 界面的轮询也拉不起它,报的是那句话
        QCOMPARE(callSync(r.engine, u"system.status"_s).error, u"交易引擎没有启动:配置文件有问题,请按弹出的提示处理"_s);
    }

    // 用户在对话框里修好了:startAgain 越过"别再拉起"的那道闸,马上再拉一次;之后还是 78 就又停下
    void startAgainPassesTheHold() {
        Rig r({{u"FAKE_EXIT_AT_START"_s, u"78"_s}});
        r.supervisor.start();
        QTRY_COMPARE(r.exits.size(), 1);
        QTest::qWait(200);
        QCOMPARE(r.exits.size(), 1);
        r.supervisor.startAgain();
        QTRY_COMPARE(r.exits.size(), 2);
        QCOMPARE(r.restartIn[1], -1);
        QTest::qWait(200);
        QCOMPARE(r.exits.size(), 2);
        // 在退出:不再拉
        r.supervisor.prepareQuit();
        r.supervisor.startAgain();
        QTest::qWait(300);
        QCOMPARE(r.exits.size(), 2);
    }

    void storeErrorStopsRestarts() {
        Rig r({{u"FAKE_EXIT_AT_START"_s, u"74"_s},
               {u"FAKE_STDERR"_s, u"[fatal:store:path] /tmp/x/trades.db\\n[fatal:store:corrupt] 交易库文件已损坏,读不出来"_s}});
        r.supervisor.start();
        QTRY_COMPARE(r.exits.size(), 1);
        QCOMPARE(r.restartIn[0], -1);
        QCOMPARE(r.fatalKind, u"store"_s);
        QCOMPARE(r.fatalMessage, u"交易库文件已损坏,读不出来"_s);
        QTest::qWait(300);
        QCOMPARE(r.exits.size(), 1);
        QCOMPARE(callSync(r.engine, u"system.status"_s).error, u"交易引擎没有启动:交易库打不开,请按弹出的提示处理"_s);
    }

    void fatalWithoutTheLineStillStops() {
        // stderr 里没有那一行(比如被别的输出顶掉了):照样不重启,说一句泛泛的
        Rig r({{u"FAKE_EXIT_AT_START"_s, u"78"_s}});
        r.supervisor.start();
        QTRY_COMPARE(r.exits.size(), 1);
        QCOMPARE(r.fatalMessage, u"配置文件读不进来"_s);
    }

    void crashLoopBacksOff() {
        // 一起来就崩:退避 40 → 80 → 160 → 200(到顶)。"跑满多久清零"放得很长:这条只看退避怎么长,
        // sanitizer 编法里一个进程从拉起到退出就要一两秒,短了会被当成"跑满了"而清零(那是下一条测的)
        shell::SupervisorTiming t = fast();
        t.resetAfterMs = 600'000;
        Rig r({{u"FAKE_EXIT_AT_START"_s, u"3"_s}}, t);
        r.supervisor.start();
        // 只钉退避的先后;每次拉起要多久不钉(sanitizer 编法里拉起一个进程就要一两秒)
        QTRY_VERIFY_WITH_TIMEOUT(r.restartIn.size() >= 5, 60'000);
        QCOMPARE(r.restartIn.mid(0, 5), (QList<int>{40, 80, 160, 200, 200}));
        QCOMPARE(r.exits[0].code, 3);
    }

    void counterResetsAfterALongRun() {
        // 引擎上一次跑满 resetAfterMs(这里 400 毫秒),退避从头算
        Rig r({});
        r.supervisor.start();
        QVERIFY(pidOf(callSync(r.engine, u"system.status"_s)) > 0);
        QVERIFY(callSync(r.engine, u"crash"_s).error.contains(u"交易引擎已退出"_s));
        QTRY_VERIFY(r.engine.running());
        QVERIFY(callSync(r.engine, u"crash"_s).error.contains(u"交易引擎已退出"_s));
        QTRY_VERIFY(r.engine.running());
        QTest::qWait(450);
        QVERIFY(callSync(r.engine, u"crash"_s).error.contains(u"交易引擎已退出"_s));
        QTRY_COMPARE(r.restartIn.size(), 3);
        QCOMPARE(r.restartIn, (QList<int>{40, 80, 40}));
    }

    void sigtermIsNotRestarted() {
#if !defined(Q_OS_UNIX)
        QSKIP("Windows 没有信号");
#endif
        // 被 SIGTERM 的(关机、有人手动结束)不拉
        Rig r({});
        r.supervisor.start();
        QVERIFY(pidOf(callSync(r.engine, u"system.status"_s)) > 0);
        callSync(r.engine, u"selfterm"_s, QJsonObject{}, {}, 2000);
        QTRY_COMPARE(r.exits.size(), 1);
        QCOMPARE(r.restartIn[0], -1);
        QTest::qWait(200);
        QVERIFY(!r.engine.running());
    }

    void noRestartWhileQuitting() {
        Rig r({});
        r.supervisor.start();
        QVERIFY(pidOf(callSync(r.engine, u"system.status"_s)) > 0);
        r.supervisor.prepareQuit();
        QVERIFY(callSync(r.engine, u"crash"_s).error.contains(u"交易引擎已退出"_s));
        QTest::qWait(200);
        QVERIFY(!r.engine.running());
        QCOMPARE(r.exits.size(), 0);
    }

    void watchdogWarnsThenSeesRecovery() {
        // 起来后 400 毫秒谁都不理:心跳说一次"没回应",它回话了再说一次"恢复了"
        Rig r({{u"FAKE_SILENT_MS"_s, u"400"_s}});
        QSignalSpy unresponsive(&r.supervisor, &shell::EngineSupervisor::unresponsive);
        QSignalSpy recovered(&r.supervisor, &shell::EngineSupervisor::recovered);
        QSignalSpy forced(&r.supervisor, &shell::EngineSupervisor::forcedRestart);
        r.supervisor.start();
        QTRY_COMPARE_WITH_TIMEOUT(unresponsive.size(), 1, 5000);
        QTRY_COMPARE_WITH_TIMEOUT(recovered.size(), 1, 5000);
        QCOMPARE(unresponsive.size(), 1);  // 只说一次
        QCOMPARE(forced.size(), 0);
    }

    void watchdogKillsASilentEngine() {
        shell::SupervisorTiming t = fast();
        t.killAfterMs = 250;
        Rig r({{u"FAKE_SILENT_MS"_s, u"100000"_s}}, t);
        QSignalSpy forced(&r.supervisor, &shell::EngineSupervisor::forcedRestart);
        r.supervisor.start();
        QTRY_VERIFY(r.engine.running());
        const qint64 first = r.engine.pid();
        QTRY_VERIFY_WITH_TIMEOUT(forced.size() >= 1, 5000);
        QTRY_VERIFY(r.engine.running() && r.engine.pid() != first);
        QCOMPARE(r.exits.size(), 0);  // 强制重启是我们自己停的,不算意外退出
    }

    void pendingPollDrivenByHeartbeat_data() {
        QTest::addColumn<QString>("status");
        QTest::addColumn<bool>("polled");
        QTest::newRow("连着、有排队的单") << u"{\"broker_connected\":true,\"pending_count\":1,\"broker_provider\":\"ibkr\"}"_s << true;
        QTest::newRow("连着、没有排队的单") << u"{\"broker_connected\":true,\"pending_count\":0,\"broker_provider\":\"ibkr\"}"_s << false;
        QTest::newRow("富途照问") << u"{\"broker_connected\":true,\"pending_count\":0,\"broker_provider\":\"futu\"}"_s << true;
        QTest::newRow("没连券商") << u"{\"broker_connected\":false,\"pending_count\":3,\"broker_provider\":\"ibkr\"}"_s << false;
    }
    void pendingPollDrivenByHeartbeat() {
        // 排队中的条件单要有人按时去问一声才会触发:Qt 版里只有心跳这一处在问
        QFETCH(QString, status);
        QFETCH(bool, polled);
        Rig r({{u"FAKE_STATUS"_s, status}});
        r.supervisor.start();
        QTRY_VERIFY_WITH_TIMEOUT(r.count(u"[fake] system.status"_s) >= 4, 5000);
        QTest::qWait(60);
        QCOMPARE(r.count(u"[fake] pending.poll"_s) > 0, polled);
    }
};

QTEST_GUILESS_MAIN(TestEngineSupervisor)
#include "tst_engine_supervisor.moc"
