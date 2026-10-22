// 持仓追踪的数据(shell/tracker_store,照 store/tracker.ts):对着假引擎。
// 读不到 ≠ 没有(追踪列表读失败留着上一份);没连券商不问持仓;持仓与盯盘各连着 3 轮读不到才报;盯盘行没变不重画;
// 托管对账只在有托管的追踪时问;自动平仓进通知流、重读、让交易记录跟着重读;价位提醒的弹窗拿到"在追踪里"那一句。
#include "shell/alerter.h"
#include "shell/alerts_store.h"
#include "shell/bridge.h"
#include "shell/consent.h"
#include "shell/popup_rules.h"
#include "shell/status_store.h"
#include "shell/tracker_store.h"
#include "shell_harness.h"

#include <QJsonArray>
#include <QSignalSpy>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

QJsonObject obj(const char* t) { return QJsonDocument::fromJson(t).object(); }

struct NoOutputs : shell::AlertOutputs {
    void playWav(const QByteArray&) override {}
    bool notify(const QString&, const QString&) override { return true; }
};

const char* kTracks = R"({"tracks":[{"id":"t1","symbol":"NVDA","sec_type":"STK","enabled":1,"fired_at":null,"targets":{"stop_loss":170},"auto_close":{"host_at_broker":false}}]})";
const char* kHosted = R"({"tracks":[{"id":"t1","symbol":"NVDA","sec_type":"STK","enabled":1,"fired_at":null,"targets":{},"auto_close":{"host_at_broker":true}}]})";
const char* kPoll = R"({"rows":[{"id":"t1","state":"holding","price":180,"stop_effective":172.5}],"loop":{"ticks":5,"last_error":null},"fired":[]})";

struct Rig {
    QTemporaryDir dir;
    QString resultsPath = dir.filePath(u"results.json"_s);
    shell::EngineClient engine;
    QStringList logs;
    struct Yes : shell::Prompter {
        void ask(const shell::ConfirmBox&, std::function<void(bool)> d) override { d(true); }
    } yes;
    shell::ConsentStore consent{dir.path()};
    shell::Bridge bridge{&engine, &yes, &consent};
    shell::StatusStore status{&engine, 60'000};
    shell::PopupQueue popup;
    NoOutputs outputs;
    shell::Alerter alerter{&popup, &outputs, QString()};
    QSignalSpy fed{&alerter, &shell::Alerter::notified};
    shell::TrackerStore tracker{&bridge, &status, &alerter};
    QJsonObject results;

    explicit Rig(bool connected = true)
        : engine(fakeEngine({{u"FAKE_STATUS"_s, connected ? u"{\"broker_connected\":true}"_s : u"{\"broker_connected\":false}"_s},
                             {u"FAKE_LOG_PARAMS"_s, u"1"_s}, {u"FAKE_RESULTS_FILE"_s, resultsPath}}),
                 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        set(u"tracker.list"_s, obj(kTracks));
        set(u"positions.list"_s, obj(R"({"positions":[{"symbol":"NVDA","qty":10}]})"));
        set(u"tracker.poll"_s, obj(kPoll));
        status.refresh();
        QTRY_VERIFY(status.status().contains(u"broker_connected"_s));
    }
    ~Rig() {
        shell::StopOptions o;
        o.drainMs = 0;
        stopSync(engine, o);
    }
    void set(const QString& method, const QJsonObject& result) {
        results.insert(method, result);
        QFile f(resultsPath);
        QVERIFY(f.open(QIODevice::WriteOnly));
        f.write(QJsonDocument(results).toJson());
    }
    int calls(const QString& method) const { return int(logs.filter(u"[fake] "_s + method + u' ').size()); }
    void loadNow(bool positions = true) {
        bool done = false;
        tracker.load(positions, [&done] { done = true; });
        QTRY_VERIFY(done);
    }
};

}  // namespace

class TestTrackerStore : public QObject {
    Q_OBJECT
private slots:
    void loadReadsTracksAndPositions() {
        Rig rig;
        rig.loadNow();
        QCOMPARE(rig.tracker.snap()[u"tracks"].toArray().size(), 1);
        QCOMPARE(rig.tracker.snap()[u"positions"].toArray().size(), 1);
        QVERIFY(rig.tracker.snap()[u"tracksError"].isNull());
        // 只读追踪:持仓不动
        rig.set(u"positions.list"_s, obj(R"({"positions":[]})"));
        rig.loadNow(false);
        QCOMPARE(rig.tracker.snap()[u"positions"].toArray().size(), 1);
    }

    // 读不到 ≠ 没有:追踪列表留着上一份
    void listFailureKeepsTracks() {
        Rig rig;
        rig.loadNow();
        rig.set(u"tracker.list"_s, obj(R"({"__error":"引擎忙"})"));
        rig.loadNow();
        QCOMPARE(rig.tracker.snap()[u"tracks"].toArray().size(), 1);
        QCOMPARE(rig.tracker.snap()[u"tracksError"].toString(), u"引擎忙"_s);
    }

    void disconnectedDoesNotAskForPositions() {
        Rig rig(false);
        rig.loadNow();
        QCOMPARE(rig.calls(u"positions.list"_s), 0);
        QVERIFY(rig.tracker.snap()[u"positionsError"].isNull());
        rig.tracker.poll();
        rig.tracker.refreshPositions();
        QTest::qWait(100);
        QCOMPARE(rig.calls(u"tracker.poll"_s), 0);
        QCOMPARE(rig.calls(u"positions.list"_s), 0);
    }

    void positionsFailThreeTimesBeforeReporting() {
        Rig rig;
        rig.loadNow();
        rig.set(u"positions.list"_s, obj(R"({"__error":"读道满了"})"));
        for (int i = 1; i <= 2; ++i) {
            rig.tracker.refreshPositions();
            QTRY_COMPARE(rig.calls(u"positions.list"_s), 1 + i);
            QTest::qWait(30);
            QCOMPARE(rig.tracker.snap()[u"positions"].toArray().size(), 1);  // 留着上一份
        }
        rig.tracker.refreshPositions();
        QTRY_COMPARE(rig.tracker.snap()[u"positionsError"].toString(), u"读道满了"_s);
        QCOMPARE(rig.tracker.snap()[u"positions"].toArray().size(), 0);
    }

    void pollFillsRowsAndOnlyRedrawsOnChange() {
        Rig rig;
        rig.loadNow();
        QSignalSpy changed(&rig.tracker, &shell::TrackerStore::changed);
        rig.tracker.poll();
        QTRY_COMPARE(rig.tracker.rows()[u"t1"][u"price"].toDouble(), 180.0);
        QCOMPARE(rig.tracker.snap()[u"loop"][u"ticks"].toInt(), 5);
        const int after = int(changed.size());
        rig.tracker.poll();  // 同样的行、同样的心跳:不重画
        QTRY_COMPARE(rig.calls(u"tracker.poll"_s), 2);
        QTest::qWait(50);
        QCOMPARE(changed.size(), after);
        rig.set(u"tracker.poll"_s, obj(R"({"rows":[{"id":"t1","state":"holding","price":180,"stop_effective":172.5}],"loop":{"ticks":6,"last_error":null}})"));
        rig.tracker.poll();  // 只有心跳变了:刷心跳
        QTRY_COMPARE(rig.tracker.snap()[u"loop"][u"ticks"].toInt(), 6);
    }

    // 节拍器没在跑时(兜底路径)读回来的结果里带着触发:照样进通知流、重读
    void pollWithFiredReloads() {
        Rig rig;
        rig.loadNow();
        QSignalSpy stale(&rig.tracker, &shell::TrackerStore::recordsStale);
        rig.set(u"tracker.poll"_s, obj(R"({"rows":[{"id":"t1","state":"stop_loss","price":169}],"loop":null,"fired":[{"symbol":"NVDA","reason":"止损 170"}]})"));
        const int lists = rig.calls(u"tracker.list"_s);
        rig.tracker.poll();
        QTRY_COMPARE(stale.size(), 1);
        QCOMPARE(rig.tracker.rows()[u"t1"][u"state"].toString(), u"stop_loss"_s);
        QCOMPARE(rig.fed.at(0).at(0).toString(), u"自动平仓:NVDA"_s);
        QTRY_COMPARE(rig.calls(u"tracker.list"_s), lists + 1);
    }

    void pollFailsThreeTimesBeforeReporting() {
        Rig rig;
        rig.loadNow();
        rig.tracker.poll();
        QTRY_VERIFY(rig.tracker.snap()[u"loop"].isObject());
        rig.set(u"tracker.poll"_s, obj(R"({"__error":"不回话"})"));
        for (int i = 0; i < 2; ++i) {
            rig.tracker.poll();
            QTRY_COMPARE(rig.calls(u"tracker.poll"_s), 2 + i);
            QTest::qWait(30);
            QVERIFY(rig.tracker.snap()[u"loop"].isObject());
        }
        rig.tracker.poll();
        QTRY_COMPARE(rig.tracker.snap()[u"pollError"].toString(), u"不回话"_s);
        QVERIFY(rig.tracker.snap()[u"loop"].isNull());
    }

    void reconcileOnlyWithHostedTracks() {
        Rig rig;
        rig.loadNow();
        rig.tracker.reconcile();
        QTest::qWait(80);
        QCOMPARE(rig.calls(u"tracker.reconcile"_s), 0);
        rig.set(u"tracker.list"_s, obj(kHosted));
        rig.set(u"tracker.reconcile"_s, obj(R"({"hosted":[{"id":"t1","orders":[{"kind":"stop","price":170}]}],"quote_maybe_delayed":true})"));
        rig.loadNow();
        rig.tracker.reconcile();
        QTRY_VERIFY(rig.tracker.snap()[u"delayed"].toBool());
        QCOMPARE(rig.tracker.snap()[u"hosted"][u"t1"][u"orders"].toArray().size(), 1);
    }

    // 自动平仓:进通知流、重读持仓与追踪、交易记录跟着重读
    void firedEventReloads() {
        Rig rig;
        rig.loadNow();
        QSignalSpy stale(&rig.tracker, &shell::TrackerStore::recordsStale);
        const int lists = rig.calls(u"tracker.list"_s);
        rig.tracker.onEngineEvent(u"tracker"_s, obj(R"({"fired":[{"symbol":"NVDA","reason":"止损 170 触发"}]})"));
        QCOMPARE(rig.fed.size(), 1);
        QCOMPARE(rig.fed.at(0).at(0).toString(), u"自动平仓:NVDA"_s);
        QCOMPARE(rig.fed.at(0).at(1).toString(), u"止损 170 触发"_s);
        QCOMPARE(stale.size(), 1);
        QTRY_COMPARE(rig.calls(u"tracker.list"_s), lists + 1);
        rig.tracker.onEngineEvent(u"tracker"_s, obj(R"({"fired":[]})"));
        QCOMPARE(stale.size(), 1);
    }

    // 价位提醒接上持仓追踪:这只在追踪里时正文补一句、「查看」落到持仓追踪页(store/alerts.ts 的 trackNote)
    void alertsSeeTheTracker() {
        Rig rig;
        rig.loadNow();
        rig.tracker.poll();
        QTRY_COMPARE(rig.tracker.rows()[u"t1"][u"price"].toDouble(), 180.0);
        shell::AlertsStore alerts(&rig.bridge, &rig.status, &rig.alerter);
        alerts.trackerSnapshot = [&rig] { return std::pair{rig.tracker.tracks(), rig.tracker.rows()}; };
        const QJsonObject item = alerts.toPopupItem(obj(R"({"symbol":"NVDA","price":180,"direction":"up","text":"NVDA 上穿 180","at":5})"));
        QCOMPARE(item[u"body"].toString(), u"NVDA 上穿 180 · 持仓追踪:止损 172.5(距现价 −4.17%)"_s);
        QCOMPARE(item[u"page"].toString(), u"tracker"_s);
    }
};

QTEST_GUILESS_MAIN(TestTrackerStore)
#include "tst_tracker_store.moc"
