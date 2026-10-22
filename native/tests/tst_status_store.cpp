// 状态快照(shell/status_store):照 desktop/renderer-react/src/store/status.ts。
// 钉:上一轮没回来绝不叠加;引擎说熔断 / 起来了 / … 当场再问;熔断、报错、退出都落到横幅上(账号遮过)。
#include "shell/status_store.h"
#include "shell_harness.h"

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

struct Rig {
    explicit Rig(QHash<QString, QString> env) : engine(fakeEngine(std::move(env)), 40), store(&engine, 60'000) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
    }
    ~Rig() {
        shell::StopOptions o;
        o.drainMs = 0;
        o.killGraceMs = 200;
        stopSync(engine, o);
    }
    int statusAsks() const { return static_cast<int>(logs.count(u"[fake] system.status"_s)); }

    shell::EngineClient engine;
    shell::StatusStore store;
    QStringList logs;
};

}  // namespace

class TestStatusStore : public QObject {
    Q_OBJECT
private slots:
    void neverStacksRequests() {
        // 引擎慢(200 毫秒才回):这期间再怎么催,管道里也只有一个 system.status
        Rig r({{u"FAKE_STATUS_DELAY_MS"_s, u"200"_s}});
        QCOMPARE(r.store.engineOk(), -1);
        r.store.refresh();
        for (int i = 0; i < 5; ++i) {
            QTest::qWait(20);
            r.store.refresh();
        }
        QTRY_COMPARE(r.store.engineOk(), 1);
        QCOMPARE(r.statusAsks(), 1);
        r.store.refresh();  // 回来之后再问,照常问
        QTRY_COMPARE(r.statusAsks(), 2);
    }

    void eventsTriggerARefresh() {
        Rig r({});
        r.store.refresh();
        QTRY_COMPARE(r.store.engineOk(), 1);
        QCOMPARE(r.statusAsks(), 1);
        // 引擎说熔断了:当场再问一次(不等下一个 5 秒)
        QVERIFY(callSync(r.engine, u"emit"_s, QJsonObject{{u"event"_s, u"breaker"_s}, {u"data"_s, QJsonObject{}}}).ok);
        QTRY_COMPARE(r.statusAsks(), 2);
        // 别的事件不问
        QVERIFY(callSync(r.engine, u"emit"_s, QJsonObject{{u"event"_s, u"tick"_s}, {u"data"_s, QJsonObject{}}}).ok);
        QTest::qWait(80);
        QCOMPARE(r.statusAsks(), 2);
    }

    void breakerTransitionSpeaksOnce() {
        Rig r({{u"FAKE_STATUS"_s, u"{\"breaker\":{\"engaged\":true,\"reason\":\"连续止损 3 次\"}}"_s}});
        QSignalSpy banner(&r.store, &shell::StatusStore::bannerChanged);
        r.store.refresh();
        QTRY_COMPARE(r.store.banner(), u"已熔断:连续止损 3 次"_s);
        r.store.refresh();
        QTRY_COMPARE(r.statusAsks(), 2);
        QTest::qWait(50);
        QCOMPARE(banner.size(), 1);  // 状态没变,不再说
        QCOMPARE(r.store.status().value(u"breaker").toObject().value(u"engaged").toBool(), true);
    }

    void engineErrorsReachTheBannerMasked() {
        Rig r({});
        r.store.refresh();
        QTRY_COMPARE(r.store.engineOk(), 1);
        QVERIFY(callSync(r.engine, u"emit"_s, QJsonObject{{u"event"_s, u"error"_s}, {u"data"_s, QJsonObject{{u"message"_s, u"券商掉线:U1234567 的会话断了"_s}}}}).ok);
        QTRY_COMPARE(r.store.banner(), u"券商掉线:U***567 的会话断了"_s);
    }

    void unansweredEngineIsShown() {
        // 不答话:圆点变红之外还得说一句
        shell::EngineClient engine([] { return shell::ResolvedEngine{std::nullopt, u"找不到引擎入口 /x"_s}; });
        shell::StatusStore store(&engine, 60'000);
        store.refresh();
        QTRY_COMPARE(store.engineOk(), 0);
        QCOMPARE(store.banner(), u"引擎无响应:找不到引擎入口 /x"_s);
    }

    void exitsAreExplained() {
        Rig r({});
        r.store.engineExited(u"config"_s, u"配置文件不是合法的 JSON"_s);
        QCOMPARE(r.store.engineOk(), 0);
        QCOMPARE(r.store.banner(), u"配置文件有问题,交易引擎没有启动:配置文件不是合法的 JSON"_s);
        r.store.engineExited(u"store"_s, u"交易库文件已损坏"_s);
        QCOMPARE(r.store.banner(), u"交易库打不开,交易引擎没有启动:交易库文件已损坏"_s);
        r.store.engineExited({}, u"Error: boom (DU7654321)"_s);
        QCOMPARE(r.store.banner(), u"交易引擎已退出:Error: boom (DU***321)。正在自动重启,重启后自动连回券商。"_s);
    }
};

QTEST_GUILESS_MAIN(TestStatusStore)
#include "tst_status_store.moc"
