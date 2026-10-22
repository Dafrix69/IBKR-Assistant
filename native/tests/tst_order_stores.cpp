// 交易记录与条件单的两份列表(shell/order_stores,照 store/records.ts、store/pending.ts)与订单看板的接线(shell/board_controller,
// 照 pages/Board.tsx):对着假引擎。
//   · 入参:records.list { limit: 60 }、pending.list {};
//   · 读不到留着上一份、记下原因;回包不是数组当空的、原因清掉;
//   · 上一次还没回来时不再发,立刻算读完;
//   · 引擎报 pending 事件时重读,别的事件不读;
//   · 看板:进页即读两样、停在这一页时按节拍读、离开就停;「刷新」= 状态 + 记录 + 条件单;列表一变模型跟着变。
#include "shell/board_controller.h"
#include "shell/bridge.h"
#include "shell/consent.h"
#include "shell/order_stores.h"
#include "shell/status_store.h"
#include "shell_harness.h"

#include <QJsonArray>
#include <QSignalSpy>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

QJsonObject obj(const char* t) { return QJsonDocument::fromJson(t).object(); }

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
    QJsonObject results;

    explicit Rig(const QString& delays = {})
        : engine(fakeEngine({{u"FAKE_STATUS"_s, u"{\"broker_connected\":true}"_s}, {u"FAKE_LOG_PARAMS"_s, u"1"_s}, {u"FAKE_RESULTS_FILE"_s, resultsPath},
                             {u"FAKE_DELAY_METHODS"_s, delays}}),
                 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        set(u"records.list"_s, obj(R"({"records":[]})"));
        set(u"pending.list"_s, obj(R"({"pending":[]})"));
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
};

}  // namespace

class TestOrderStores : public QObject {
    Q_OBJECT
private slots:
    void readsAndKeepsThePreviousListOnFailure() {
        Rig rig;
        shell::RecordsStore records(&rig.bridge);
        rig.set(u"records.list"_s, obj(R"({"records":[{"id":"a"},{"id":"b"}]})"));
        bool done = false;
        records.load([&done] { done = true; });
        QTRY_VERIFY(done);
        QCOMPARE(records.items().size(), 2);
        QCOMPARE(records.error(), QString());
        QVERIFY(rig.logs.contains(u"[fake] records.list {\"limit\":60}"_s));

        // 读不到:留着上一份,记下原因
        rig.set(u"records.list"_s, obj(R"({"__error":"引擎忙"})"));
        done = false;
        records.load([&done] { done = true; });
        QTRY_VERIFY(done);
        QCOMPARE(records.items().size(), 2);
        QCOMPARE(records.error(), u"引擎忙"_s);

        // 回包不是数组:当空的,原因清掉
        rig.set(u"records.list"_s, obj(R"({"records":null})"));
        done = false;
        records.load([&done] { done = true; });
        QTRY_VERIFY(done);
        QCOMPARE(records.items().size(), 0);
        QCOMPARE(records.error(), QString());
    }

    void pendingListParams() {
        Rig rig;
        shell::PendingStore pending(&rig.bridge);
        rig.set(u"pending.list"_s, obj(R"({"pending":[{"record_id":"p1"}]})"));
        QSignalSpy changed(&pending, &shell::ListStore::changed);
        pending.load();
        QTRY_COMPARE(changed.size(), 1);
        QCOMPARE(pending.items().size(), 1);
        QVERIFY(rig.logs.contains(u"[fake] pending.list {}"_s));
    }

    void oneReadInFlightAtATime() {
        Rig rig(u"records.list=300"_s);
        shell::RecordsStore records(&rig.bridge);
        int first = 0, second = 0;
        records.load([&first] { ++first; });
        records.load([&second] { ++second; });
        // 第二次:立刻算读完,不再发
        QCOMPARE(second, 1);
        QCOMPARE(first, 0);
        QTRY_COMPARE(first, 1);
        QTest::qWait(50);
        QCOMPARE(rig.calls(u"records.list"_s), 1);
    }

    void reloadsOnThePendingEvent() {
        Rig rig;
        shell::RecordsStore records(&rig.bridge);
        shell::PendingStore pending(&rig.bridge);
        records.onEngineEvent(u"status"_s);
        pending.onEngineEvent(u"tracker"_s);
        QTest::qWait(80);
        QCOMPARE(rig.calls(u"records.list"_s), 0);
        QCOMPARE(rig.calls(u"pending.list"_s), 0);
        records.onEngineEvent(u"pending"_s);
        pending.onEngineEvent(u"pending"_s);
        QTRY_COMPARE(rig.calls(u"records.list"_s), 1);
        QTRY_COMPARE(rig.calls(u"pending.list"_s), 1);
    }

    void boardPollsOnlyWhileVisible() {
        Rig rig;
        shell::RecordsStore records(&rig.bridge);
        shell::PendingStore pending(&rig.bridge);
        shell::BoardController board(&rig.status, &records, &pending);
        board.refreshMs = 150;
        QTest::qWait(80);
        QCOMPARE(rig.calls(u"records.list"_s), 0);
        board.setVisible(true);
        QTRY_COMPARE(rig.calls(u"records.list"_s), 1);
        QTRY_COMPARE(rig.calls(u"pending.list"_s), 1);
        QTRY_VERIFY(rig.calls(u"records.list"_s) >= 3);
        QVERIFY(rig.calls(u"pending.list"_s) >= 2);
        board.setVisible(false);
        QTest::qWait(60);
        const int stopped = rig.calls(u"records.list"_s);
        QTest::qWait(400);
        QCOMPARE(rig.calls(u"records.list"_s), stopped);
    }

    void refreshReadsStatusRecordsAndPending() {
        Rig rig;
        shell::RecordsStore records(&rig.bridge);
        shell::PendingStore pending(&rig.bridge);
        shell::BoardController board(&rig.status, &records, &pending);
        QTest::qWait(80);
        const int status = rig.calls(u"system.status"_s);
        board.refresh();
        QTRY_VERIFY(rig.calls(u"system.status"_s) > status);
        QTRY_COMPARE(rig.calls(u"records.list"_s), 1);
        QTRY_COMPARE(rig.calls(u"pending.list"_s), 1);
    }

    void modelFollowsTheLists() {
        Rig rig;
        shell::RecordsStore records(&rig.bridge);
        shell::PendingStore pending(&rig.bridge);
        shell::BoardController board(&rig.status, &records, &pending);
        QCOMPARE(board.model()[u"pending"][u"count"].toInt(), 0);
        rig.set(u"pending.list"_s, obj(R"({"pending":[{"record_id":"p1","symbol":"SPY","operator":">=","value":775}]})"));
        QSignalSpy changed(&board, &shell::BoardController::modelChanged);
        pending.load();
        QTRY_VERIFY(changed.size() >= 1);
        QCOMPARE(board.model()[u"pending"][u"count"].toInt(), 1);
        board.setVisible(true);
        board.pushNotification(u"连上了"_s);
        board.pushNotification(u"已熔断"_s, u"自动执行已停止"_s);
        QCOMPARE(board.model()[u"feed"][u"items"].toArray().size(), 2);
        QCOMPARE(board.model()[u"feed"][u"items"][0][u"text"].toString(), u"已熔断 · 自动执行已停止"_s);
        QCOMPARE(board.model()[u"feed"][u"items"][1][u"text"].toString(), u"连上了"_s);
        for (int i = 0; i < 70; ++i) board.pushNotification(u"第 %1 条"_s.arg(i));
        QCOMPARE(board.feed().size(), 60);
        QCOMPARE(board.feed()[0][u"text"].toString(), u"第 69 条"_s);
    }
};

QTEST_GUILESS_MAIN(TestOrderStores)
#include "tst_order_stores.moc"
