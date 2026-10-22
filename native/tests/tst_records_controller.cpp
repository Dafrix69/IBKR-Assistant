// 交易记录页的接线(shell/records_controller,照 pages/Records.tsx + lib/RecordDetail.tsx):对着假引擎与预览引擎。
//   · 停在这一页时才按节拍读,离开就停;筛选、关键词、表头排序换的是这一页的行;疏密记在给的 ini 里,下次打开还是它;
//   · 点开一行:records.get { id };回来之前收起了(或换了一行)那一份作废;读不到 / 记录不在了各有一句;
//     原始记录照引擎回包的键序写(预览引擎回的是 mock 里写的次序,不按字母);
//   · 导出:保存对话框取消就什么都不发;选了路径才 data.export,桥只放行这一个路径;成败各一句横幅。
#include "shell/bridge.h"
#include "shell/consent.h"
#include "shell/engine_command.h"
#include "shell/keyed_list_model.h"
#include "shell/order_stores.h"
#include "shell/records_controller.h"
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

const char* kRecords = R"({"records":[
  {"id":"r1","symbol":"NVDA","action":"BUY","final_status":"filled","status":"Submitted","created_at":"2026-08-21T13:41:02Z","intent_summary":"买 NVDA","reason":"财报前"},
  {"id":"r2","symbol":"AAPL","action":"BUY","final_status":null,"status":"Submitted","created_at":"2026-08-21T13:38:55Z","intent_summary":"买 AAPL"},
  {"id":"r3","symbol":"SPY","action":"SELL","final_status":"ibkr_error","created_at":"2026-08-21T13:20:10Z","intent_summary":"卖 SPY","reason":"止损"}]})";

struct Rig {
    QTemporaryDir dir;
    QString resultsPath = dir.filePath(u"results.json"_s);
    QString ini = dir.filePath(u"qt-settings.ini"_s);
    shell::EngineClient engine;
    QStringList logs;
    struct Yes : shell::Prompter {
        void ask(const shell::ConfirmBox&, std::function<void(bool)> d) override { d(true); }
    } yes;
    shell::ConsentStore consent{dir.path()};
    shell::Bridge bridge{&engine, &yes, &consent};
    shell::StatusStore status{&engine, 60'000};
    shell::RecordsStore records{&bridge};
    QJsonObject results;

    explicit Rig(const QString& delays = {})
        : engine(fakeEngine({{u"FAKE_STATUS"_s, u"{\"broker_connected\":true}"_s}, {u"FAKE_LOG_PARAMS"_s, u"1"_s}, {u"FAKE_RESULTS_FILE"_s, resultsPath},
                             {u"FAKE_DELAY_METHODS"_s, delays}}),
                 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        set(u"records.list"_s, obj(kRecords));
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

QStringList rowIds(const shell::RecordsController& c) {
    QStringList ids;
    for (const QJsonValue& r : c.page()[u"rows"].toArray()) ids << r[u"id"].toString();
    return ids;
}

}  // namespace

class TestRecordsController : public QObject {
    Q_OBJECT
private slots:
    void pollsOnlyWhileVisible() {
        Rig rig;
        shell::RecordsController page(&rig.bridge, &rig.records, &rig.status, rig.ini);
        page.refreshMs = 150;
        QTest::qWait(80);
        QCOMPARE(rig.calls(u"records.list"_s), 0);
        page.setVisible(true);
        QTRY_COMPARE(rowIds(page), (QStringList{u"r1"_s, u"r2"_s, u"r3"_s}));
        QTRY_VERIFY(rig.calls(u"records.list"_s) >= 3);
        QVERIFY(rig.logs.contains(u"[fake] records.list {\"limit\":60}"_s));
        page.setVisible(false);
        QTest::qWait(60);
        const int stopped = rig.calls(u"records.list"_s);
        QTest::qWait(400);
        QCOMPARE(rig.calls(u"records.list"_s), stopped);
        // 行的模型和 page.rows 同一份
        QCOMPARE(qobject_cast<shell::KeyedListModel*>(page.rows())->count(), 3);
    }

    void filterKeywordSortAndDensity() {
        Rig rig;
        {
            shell::RecordsController page(&rig.bridge, &rig.records, &rig.status, rig.ini);
            page.setVisible(true);
            QTRY_COMPARE(rowIds(page).size(), 3);
            page.setFilter(u"failed"_s);
            QCOMPARE(rowIds(page), QStringList{u"r3"_s});
            page.setFilter(u"no-such"_s);  // 不认识的档位不换
            QCOMPARE(rowIds(page), QStringList{u"r3"_s});
            page.setFilter(u"all"_s);
            page.setKeyword(u" 止损 "_s);
            QCOMPARE(rowIds(page), QStringList{u"r3"_s});
            page.setKeyword(QString());
            // 时间:默认降序;点一下不排(引擎给的次序),再点升序
            page.sortBy(u"created_at"_s);
            QCOMPARE(rowIds(page), (QStringList{u"r1"_s, u"r2"_s, u"r3"_s}));
            page.sortBy(u"created_at"_s);
            QCOMPARE(rowIds(page), (QStringList{u"r3"_s, u"r2"_s, u"r1"_s}));
            page.sortBy(u"symbol"_s);
            QCOMPARE(rowIds(page), (QStringList{u"r2"_s, u"r1"_s, u"r3"_s}));
            QVERIFY(!page.page()[u"compact"].toBool());
            page.setCompact(true);
            QVERIFY(page.page()[u"compact"].toBool());
        }
        // 疏密记在给的 ini 里:再开一页还是紧凑
        shell::RecordsController again(&rig.bridge, &rig.records, &rig.status, rig.ini);
        QVERIFY(again.page()[u"compact"].toBool());
    }

    void openFetchesOneRecordAndDropsStaleReplies() {
        Rig rig(u"records.get=300"_s);
        rig.set(u"records.get"_s, obj(R"({"record":{"id":"r1","contract":{"symbol":"NVDA"},"order":{"action":"BUY","totalQuantity":2}}})"));
        shell::RecordsController page(&rig.bridge, &rig.records, &rig.status, rig.ini);
        page.setVisible(true);
        QTRY_COMPARE(rowIds(page).size(), 3);
        page.open(u"r1"_s);
        QCOMPARE(page.openId(), u"r1"_s);
        QCOMPARE(page.detail()[u"state"].toString(), u"loading"_s);
        QVERIFY(page.page()[u"rows"].toArray()[0][u"open"].toBool());
        QTRY_COMPARE(page.detail()[u"state"].toString(), u"ok"_s);
        QCOMPARE(page.detail()[u"title"].toString(), u"NVDA · 买入 2"_s);
        QVERIFY(rig.logs.contains(u"[fake] records.get {\"id\":\"r1\"}"_s));

        // 回来之前换了一行:前一行的那一份作废,单据上一次也不会闪出前一行的内容
        QStringList titles;
        const auto watch = connect(&page, &shell::RecordsController::detailChanged, this, [&] { titles << page.detail()[u"title"].toString(); });
        rig.set(u"records.get"_s, obj(R"({"record":{"id":"r1","contract":{"symbol":"NVDA"},"order":{"action":"BUY","totalQuantity":2}}})"));
        page.open(u"r1"_s);
        // 等引擎收到这一条(回包内容在收到时定),再把下一条的内容换掉
        QTRY_COMPARE(rig.logs.filter(u"[fake] records.get {\"id\":\"r1\"}"_s).size(), 2);
        rig.set(u"records.get"_s, obj(R"({"record":{"id":"r2","contract":{"symbol":"AAPL"},"order":{"action":"BUY","totalQuantity":100}}})"));
        page.open(u"r2"_s);
        QTRY_COMPARE(page.detail()[u"title"].toString(), u"AAPL · 买入 100"_s);
        QTest::qWait(400);
        disconnect(watch);
        QVERIFY2(!titles.contains(u"NVDA · 买入 2"_s), qPrintable(titles.join(u" | "_s)));
        QCOMPARE(page.detail()[u"title"].toString(), u"AAPL · 买入 100"_s);

        // 离开这一页:详情收起(原版的 openId 是页面自己的状态)
        page.open(u"r1"_s);
        QTRY_COMPARE(page.detail()[u"state"].toString(), u"ok"_s);
        page.setVisible(false);
        QCOMPARE(page.openId(), QString());
        QVERIFY(page.detail().isEmpty());
        page.setVisible(true);

        // 回来之前收起:那一份作废,单据不再出现
        page.open(u"r2"_s);
        page.close();
        QCOMPARE(page.openId(), QString());
        QTest::qWait(500);
        QVERIFY(page.detail().isEmpty());
        QVERIFY(!page.page()[u"rows"].toArray()[1][u"open"].toBool());

        // 记录不在了 / 读不到
        rig.set(u"records.get"_s, obj(R"({"record":null})"));
        page.open(u"r3"_s);
        QTRY_COMPARE(page.detail()[u"state"].toString(), u"gone"_s);
        QCOMPARE(page.detail()[u"empty"].toString(), u"这条记录已经不在了"_s);
        rig.set(u"records.get"_s, obj(R"({"__error":"引擎忙"})"));
        page.open(u"r3"_s);
        QTRY_COMPARE(page.detail()[u"state"].toString(), u"error"_s);
        QCOMPARE(page.detail()[u"empty"].toString(), u"读取失败:引擎忙"_s);
    }

    void rawRecordKeepsTheEngineKeyOrder() {
        if (shell::findNode().isEmpty()) QSKIP("没有 node");
        QTemporaryDir dir;
        shell::EngineClient engine([] { return shell::resolvePreviewEngine(QStringLiteral(IBKR_REPO_DIR)); }, 2000);
        struct Yes : shell::Prompter {
            void ask(const shell::ConfirmBox&, std::function<void(bool)> d) override { d(true); }
        } yes;
        shell::ConsentStore consent{dir.path()};
        shell::Bridge bridge{&engine, &yes, &consent};
        shell::StatusStore status{&engine, 60'000};
        shell::RecordsStore records{&bridge};
        shell::RecordsController page(&bridge, &records, &status, dir.filePath(u"qt-settings.ini"_s));
        page.open(u"r1"_s);
        QTRY_COMPARE_WITH_TIMEOUT(page.detail()[u"state"].toString(), u"ok"_s, 15000);
        // mock 里写的次序:id、created_at、input、llm、execution_type……(按字母会是 account 打头)
        const QString raw = page.detail()[u"raw"].toString();
        QVERIFY2(raw.startsWith(u"{\n  \"id\": \"r1\",\n  \"created_at\": \"2026-08-21T13:41:02Z\",\n  \"input\": {"_s), qPrintable(raw.left(200)));
        QVERIFY(raw.indexOf(u"\"llm\""_s) < raw.indexOf(u"\"execution_type\""_s));
        shell::StopOptions o;
        o.drainMs = 3000;
        QVERIFY(stopSync(engine, o));
    }

    void exportAsksForAPathFirst() {
        Rig rig;
        rig.set(u"data.export"_s, obj(R"({"records":3,"path":"/tmp/x/dafri-trades.json"})"));
        shell::RecordsController page(&rig.bridge, &rig.records, &rig.status, rig.ini);
        page.downloadsDir = rig.dir.path();
        QStringList asked;
        QString answer;
        page.pickSavePath = [&](const QString& title, const QString& def, const QString& filter) {
            asked << title << def << filter;
            return answer;
        };
        // 取消:什么都不发
        page.exportAll();
        QCOMPARE(asked, (QStringList{u"导出全部交易数据"_s, rig.dir.filePath(u"dafri-trades.json"_s), u"JSON (*.json)"_s}));
        QTest::qWait(100);
        QCOMPARE(rig.calls(u"data.export"_s), 0);
        // 选了路径:发 data.export,横幅说账号是完整的
        answer = rig.dir.filePath(u"out.json"_s);
        page.exportAll();
        QTRY_COMPARE(rig.calls(u"data.export"_s), 1);
        QVERIFY(rig.logs.contains(u"[fake] data.export {\"path\":\"%1\"}"_s.arg(answer)));
        QTRY_COMPARE(rig.status.banner(), u"已导出 3 条记录到 /tmp/x/dafri-trades.json。文件里的账号是完整的,请自己保管"_s);
        QVERIFY(rig.status.bannerInfo());
        // 失败:错误横幅
        rig.set(u"data.export"_s, obj(R"({"__error":"磁盘满了"})"));
        page.exportAll();
        QTRY_COMPARE(rig.status.banner(), u"导出失败:磁盘满了"_s);
        QVERIFY(!rig.status.bannerInfo());
    }
};

QTEST_GUILESS_MAIN(TestRecordsController)
#include "tst_records_controller.moc"
