// 板块页的接线(shell/sectors_controller + shell/sectors_store,照 pages/Sectors.tsx、store/sectors.ts、store/pool.ts):对着假引擎。
//   · 挂上:读板块(读完再刷行情)、价位、异动;行情只在已连券商时按节拍刷;异动每一轮都重读;卸下就停;
//   · 新建 / 添加:去空白(代码转大写),成了才清输入框;删除先问一句,点了取消什么都不发;
//   · 移除先改本地,失败退回并以引擎为准重读;
//   · 拨开关:pool.set_watch 只带那一路,回执里没做成的照原话说;旧库里停用过的那一行拨开走 quality.update;转圈直到两张表重读完;
//   · 改标签:回车与失焦只收一次,没改就不发;
//   · 触发条件:两下快改只存一次(合成一份);离开页面时没存的立刻存;碰均线的开关立刻存。
#include "shell/alerts_store.h"
#include "shell/bridge.h"
#include "shell/consent.h"
#include "shell/engine_command.h"
#include "shell/feed_stores.h"
#include "shell/sectors_controller.h"
#include "shell/sectors_store.h"
#include "shell/status_store.h"
#include "shell_harness.h"

#include <QElapsedTimer>
#include <QJsonArray>
#include <QSignalSpy>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

QJsonObject obj(const char* t) { return QJsonDocument::fromJson(t).object(); }

const char* kSectors = R"({"sectors":[{"id":"s1","name":"AI 算力","stocks":[{"symbol":"NVDA","company":"英伟达","reason":"龙头","tag":"芯片"},{"symbol":"AAPL","reason":"手动添加"}]}]})";
const char* kQuality = R"({"max":30,"config":{"rvol_tiers":[2,3,5],"burst_ratio":4,"window_min":5,"spike_sigma":3,"spike_min_pct":1,"spike_fixed_pct":1.5,
  "day_sigma_tiers":[2,3,4],"day_fixed_tiers":[3,5,8],"cooldown_min":15,"market_adjust":false},
  "monitor":{"running":true,"interval_ms":5000,"last_at":null,"connected":true,"supported":true,"session":"rth","note":""},
  "stocks":[{"id":"q1","symbol":"NVDA","enabled":1,"events":[],"metrics":null},{"id":"q2","symbol":"AAPL","enabled":0,"events":[],"metrics":null}]})";
const char* kAlerts = R"({"watches":[{"id":"w1","symbol":"NVDA","step":5,"levels":[]}],"cross_confirm":"immediate",
  "touch_config":{"enabled":true,"periods":[20,60],"window_days":10,"min_touches":3,"band_pct":0.3}})";

struct Prompt : shell::Prompter {
    bool answer = true;
    int asked = 0;
    void ask(const shell::ConfirmBox&, std::function<void(bool)> d) override {
        ++asked;
        d(answer);
    }
};

struct Rig {
    QTemporaryDir dir;
    QString resultsPath = dir.filePath(u"results.json"_s);
    shell::EngineClient engine;
    QStringList logs;
    Prompt prompt;
    shell::ConsentStore consent{dir.path()};
    shell::Bridge bridge{&engine, &prompt, &consent};
    shell::StatusStore status{&engine, 60'000};
    shell::AlertsStore alerts{&bridge, &status, nullptr};
    shell::QualityStore quality{&bridge, &status, nullptr};
    shell::SectorsStore sectors{&bridge, &status, &alerts, &quality};
    QJsonObject results;

    explicit Rig(const QString& delays = {}, bool connected = true)
        : engine(fakeEngine({{u"FAKE_STATUS"_s, connected ? u"{\"broker_connected\":true}"_s : u"{\"broker_connected\":false}"_s}, {u"FAKE_LOG_PARAMS"_s, u"1"_s},
                             {u"FAKE_RESULTS_FILE"_s, resultsPath}, {u"FAKE_DELAY_METHODS"_s, delays}}),
                 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        set(u"sectors.list"_s, obj(kSectors));
        set(u"sectors.quotes"_s, obj(R"({"connected":true,"quotes":{"NVDA":{"last":219.74,"change_pct":0.4}}})"));
        set(u"quality.list"_s, obj(kQuality));
        set(u"alerts.list"_s, obj(kAlerts));
        bool done = false;
        status.refresh([&] { done = true; });
        QTRY_VERIFY(done);
    }
    ~Rig() {
        shell::StopOptions o;
        o.drainMs = 0;
        stopSync(engine, o);
    }
    void set(const QString& method, const QJsonValue& result) {
        results.insert(method, result);
        QFile f(resultsPath);
        QVERIFY(f.open(QIODevice::WriteOnly));
        f.write(QJsonDocument(results).toJson());
    }
    int calls(const QString& method) const { return int(logs.filter(u"[fake] "_s + method + u' ').size()); }
    QStringList params(const QString& method) const {
        QStringList out;
        for (const QString& l : logs)
            if (l.startsWith(u"[fake] "_s + method + u' ')) out << l.mid(8 + method.size());
        return out;
    }
};

QJsonObject row(const shell::SectorsController& c, const QString& symbol) {
    for (const QJsonValue& s : c.page()[u"sectors"_s].toArray())
        for (const QJsonValue& r : s[u"rows"_s].toArray())
            if (r[u"symbol"_s].toString() == symbol) return r.toObject();
    return {};
}

}  // namespace

class TestSectorsController : public QObject {
    Q_OBJECT
private slots:
    void loadsAndPolls() {
        Rig rig;
        shell::SectorsController page(&rig.sectors, &rig.alerts, &rig.quality, &rig.status, nullptr);
        page.quotesMs = 150;
        page.poolMs = 100;
        page.setVisible(true);
        QTRY_COMPARE(row(page, u"NVDA"_s)[u"price"_s][u"text"_s].toString(), u"219.74"_s);
        QVERIFY(rig.calls(u"alerts.list"_s) >= 1);
        QTRY_VERIFY(rig.calls(u"sectors.quotes"_s) >= 3);
        QTRY_VERIFY(rig.calls(u"quality.list"_s) >= 3);
        page.setVisible(false);
        const int q = rig.calls(u"sectors.quotes"_s), l = rig.calls(u"quality.list"_s);
        QTest::qWait(350);
        QCOMPARE(rig.calls(u"sectors.quotes"_s), q);
        QCOMPARE(rig.calls(u"quality.list"_s), l);
    }

    void quotesOnlyWhenConnected() {
        Rig rig({}, false);
        shell::SectorsController page(&rig.sectors, &rig.alerts, &rig.quality, &rig.status, nullptr);
        page.quotesMs = 80;
        page.setVisible(true);
        QTRY_COMPARE(rig.calls(u"sectors.quotes"_s), 1);  // 进页那一次照刷
        QTest::qWait(300);
        QCOMPARE(rig.calls(u"sectors.quotes"_s), 1);
    }

    void createAddRemoveDelete() {
        Rig rig;
        rig.set(u"sectors.add"_s, obj(R"({"sector":{"id":"s2","name":"核电","stocks":[]}})"));
        rig.set(u"sectors.add_stock"_s, obj(R"({"sector":{"id":"s2","name":"核电","stocks":[{"symbol":"CEG"}]},"watch":{"symbol":"CEG","skipped":["异动已达 30 只上限,CEG 没打开"]}})"));
        rig.set(u"sectors.delete"_s, obj(R"({"dropped":["CEG"]})"));
        shell::SectorsController page(&rig.sectors, &rig.alerts, &rig.quality, &rig.status, nullptr);
        page.setVisible(true);
        QTRY_COMPARE(page.page()[u"sectors"_s].toArray().size(), 1);
        QSignalSpy created(&page, &shell::SectorsController::sectorCreated), added(&page, &shell::SectorsController::stockAdded);
        page.createSector(u"   "_s);
        page.createSector(u" 核电 "_s);
        QTRY_COMPARE(created.size(), 1);
        QCOMPARE(rig.params(u"sectors.add"_s), QStringList{u"{\"name\":\"核电\"}"_s});
        QCOMPARE(page.page()[u"sectors"_s].toArray().size(), 2);
        page.addStock(u"s2"_s, u" ceg "_s, u" 电力 "_s);
        QTRY_COMPARE(added.size(), 1);
        QCOMPARE(rig.params(u"sectors.add_stock"_s).first(), u"{\"id\":\"s2\",\"symbol\":\"CEG\",\"tag\":\"电力\"}"_s);
        QTRY_COMPARE(rig.status.banner(), u"CEG:异动已达 30 只上限,CEG 没打开"_s);
        // 删除:不再先问(框上就算答了取消也照删)
        rig.prompt.answer = false;
        page.deleteSector(u"s2"_s, u"核电"_s);
        QCOMPARE(rig.prompt.asked, 0);
        QTRY_COMPARE(page.page()[u"sectors"_s].toArray().size(), 1);
        QTRY_COMPARE(rig.status.banner(), u"CEG 已不在任何板块里,顺带把它的价位与异动监控一起撤了。"_s);
        // 移除:先改本地;失败退回并重读
        rig.set(u"sectors.remove_stock"_s, QJsonObject{{u"__error"_s, u"不在该板块中"_s}});
        rig.set(u"sectors.list"_s, obj(kSectors));
        page.removeStock(u"s1"_s, u"AAPL"_s);
        QVERIFY(row(page, u"AAPL"_s).isEmpty());
        QTRY_COMPARE(rig.status.banner(), u"移除股票失败:不在该板块中"_s);
        QTRY_VERIFY(!row(page, u"AAPL"_s).isEmpty());
    }

    void togglesAndTags() {
        Rig rig(u"pool.set_watch=80,quality.update=80"_s);
        rig.set(u"pool.set_watch"_s, obj(R"({"symbol":"NVDA","skipped":[]})"));
        rig.set(u"quality.update"_s, obj(R"({"stock":{"id":"q2","symbol":"AAPL","enabled":1}})"));
        rig.set(u"sectors.set_tag"_s, obj(R"({"sector":{"id":"s1","name":"AI 算力","stocks":[{"symbol":"NVDA","tag":"GPU"},{"symbol":"AAPL"}]}})"));
        shell::SectorsController page(&rig.sectors, &rig.alerts, &rig.quality, &rig.status, nullptr);
        page.setVisible(true);
        QTRY_VERIFY(!row(page, u"NVDA"_s).isEmpty());
        QTRY_VERIFY(row(page, u"NVDA"_s)[u"priceOn"_s].toBool());
        page.toggle(u"NVDA"_s, u"price"_s, false);
        QVERIFY(row(page, u"NVDA"_s)[u"priceBusy"_s].toBool());
        QTRY_VERIFY(!row(page, u"NVDA"_s)[u"priceBusy"_s].toBool());
        QCOMPARE(rig.params(u"pool.set_watch"_s).first(), u"{\"price\":false,\"symbol\":\"NVDA\"}"_s);
        // 旧库里停用过的 AAPL:拨开「异动」走 quality.update,不再建一行
        QTRY_VERIFY(row(page, u"AAPL"_s)[u"disabledRow"_s].toBool());
        page.toggle(u"AAPL"_s, u"anomaly"_s, true);
        QVERIFY(row(page, u"AAPL"_s)[u"anomalyBusy"_s].toBool());
        QTRY_VERIFY(!row(page, u"AAPL"_s)[u"anomalyBusy"_s].toBool());
        QCOMPARE(rig.params(u"quality.update"_s), QStringList{u"{\"enabled\":true,\"id\":\"q2\"}"_s});
        QCOMPARE(rig.calls(u"pool.set_watch"_s), 1);
        // 改标签:没改不发;改了只发一次(回车之后的失焦不再发)
        page.editTag(u"s1"_s, u"NVDA"_s);
        QVERIFY(row(page, u"NVDA"_s)[u"tag"_s][u"editing"_s].toBool());
        page.finishTag(u"s1"_s, u"NVDA"_s, u" 芯片 "_s, true);
        QVERIFY(!row(page, u"NVDA"_s)[u"tag"_s][u"editing"_s].toBool());
        QCOMPARE(rig.calls(u"sectors.set_tag"_s), 0);
        page.editTag(u"s1"_s, u"NVDA"_s);
        page.finishTag(u"s1"_s, u"NVDA"_s, u"GPU"_s, true);
        page.finishTag(u"s1"_s, u"NVDA"_s, u"GPU"_s, true);
        QTRY_COMPARE(row(page, u"NVDA"_s)[u"tag"_s][u"text"_s].toString(), u"GPU"_s);
        QCOMPARE(rig.params(u"sectors.set_tag"_s), QStringList{u"{\"id\":\"s1\",\"symbol\":\"NVDA\",\"tag\":\"GPU\"}"_s});
    }

    // 同一只股在两个板块里:点一处的标签只开那一处(按板块 + 代码记)
    void tagEditIsPerSector() {
        Rig rig;
        rig.set(u"sectors.list"_s, obj(R"({"sectors":[{"id":"s1","name":"A","stocks":[{"symbol":"NVDA"}]},{"id":"s2","name":"B","stocks":[{"symbol":"NVDA"}]}]})"));
        shell::SectorsController page(&rig.sectors, &rig.alerts, &rig.quality, &rig.status, nullptr);
        page.setVisible(true);
        QTRY_COMPARE(page.page()[u"sectors"_s].toArray().size(), 2);
        page.editTag(u"s2"_s, u"NVDA"_s);
        const QJsonArray cards = page.page()[u"sectors"_s].toArray();
        QVERIFY(!cards[0][u"rows"_s][0][u"tag"_s][u"editing"_s].toBool());
        QVERIFY(cards[1][u"rows"_s][0][u"tag"_s][u"editing"_s].toBool());
        // 另一处的失焦不会把这一处收起
        page.finishTag(u"s1"_s, u"NVDA"_s, QString(), true);
        QVERIFY(page.page()[u"sectors"_s][1][u"rows"_s][0][u"tag"_s][u"editing"_s].toBool());
        // 每张卡片的行是按代码原地更新的模型
        auto* rows = qobject_cast<shell::KeyedListModel*>(page.rowsModel(u"s2"_s));
        QVERIFY(rows);
        QCOMPARE(rows->count(), 1);
        QCOMPARE(qobject_cast<shell::KeyedListModel*>(page.cards())->count(), 2);
    }

    // 停在这一页时连上券商:整页重刷一遍(原版进页那一段依赖 connected)
    void reconnectReloads() {
        Rig rig({}, false);
        shell::SectorsController page(&rig.sectors, &rig.alerts, &rig.quality, &rig.status, nullptr);
        page.setVisible(true);
        QTRY_COMPARE(rig.calls(u"sectors.quotes"_s), 1);
        const int lists = rig.calls(u"sectors.list"_s);
        // 假引擎的状态换成已连,状态重读一次
        rig.set(u"system.status"_s, obj(R"({"broker_connected":true})"));
        bool done = false;
        rig.status.refresh([&] { done = true; });
        QTRY_VERIFY(done);
        QTRY_COMPARE(rig.calls(u"sectors.list"_s), lists + 1);
        QTRY_COMPARE(rig.calls(u"sectors.quotes"_s), 2);
        // 状态再读一次但没变:不重刷
        bool again = false;
        rig.status.refresh([&] { again = true; });
        QTRY_VERIFY(again);
        QTest::qWait(100);
        QCOMPARE(rig.calls(u"sectors.list"_s), lists + 1);
    }

    // 移除失败:不等重读,本地那份当场退回;再以引擎为准重读一次
    void removeRollsBackBeforeReread() {
        Rig rig(u"sectors.remove_stock=40,sectors.list=400"_s);
        rig.set(u"sectors.remove_stock"_s, QJsonObject{{u"__error"_s, u"不在该板块中"_s}});
        shell::SectorsController page(&rig.sectors, &rig.alerts, &rig.quality, &rig.status, nullptr);
        page.setVisible(true);
        QTRY_VERIFY_WITH_TIMEOUT(!row(page, u"AAPL"_s).isEmpty(), 3000);
        const int lists = rig.calls(u"sectors.list"_s);
        page.removeStock(u"s1"_s, u"AAPL"_s);
        QVERIFY(row(page, u"AAPL"_s).isEmpty());
        QTRY_COMPARE(rig.status.banner(), u"移除股票失败:不在该板块中"_s);
        QVERIFY(!row(page, u"AAPL"_s).isEmpty());  // 重读还在路上(400ms),这是退回的那份
        QTRY_COMPARE(rig.calls(u"sectors.list"_s), lists + 1);
    }

    // 拨开关失败:照原话说是哪一路,且两张表重读(开关退回引擎里真正的状态)
    void toggleFailureRereads() {
        Rig rig;
        rig.set(u"pool.set_watch"_s, QJsonObject{{u"__error"_s, u"已达 30 只上限"_s}});
        shell::SectorsController page(&rig.sectors, &rig.alerts, &rig.quality, &rig.status, nullptr);
        page.setVisible(true);
        QTRY_VERIFY(row(page, u"NVDA"_s)[u"priceOn"_s].toBool());
        int alerts = rig.calls(u"alerts.list"_s), quality = rig.calls(u"quality.list"_s);
        page.toggle(u"NVDA"_s, u"price"_s, false);
        QTRY_COMPARE(rig.status.banner(), u"NVDA 的「价位」没拨动:已达 30 只上限"_s);
        QTRY_COMPARE(rig.calls(u"alerts.list"_s), alerts + 1);
        QTRY_COMPARE(rig.calls(u"quality.list"_s), quality + 1);
        QTRY_VERIFY(!row(page, u"NVDA"_s)[u"priceBusy"_s].toBool());
        QVERIFY(row(page, u"NVDA"_s)[u"priceOn"_s].toBool());
        alerts = rig.calls(u"alerts.list"_s);
        quality = rig.calls(u"quality.list"_s);
        page.toggle(u"NVDA"_s, u"anomaly"_s, false);
        QTRY_COMPARE(rig.status.banner(), u"NVDA 的「异动」没拨动:已达 30 只上限"_s);
        QTRY_COMPARE(rig.calls(u"alerts.list"_s), alerts + 1);
        QTRY_COMPARE(rig.calls(u"quality.list"_s), quality + 1);
    }

    // 没连上的提示:按当前券商说面板名;池子是空的就不说
    void notConnectedBanner() {
        {
            Rig rig;
            rig.set(u"system.status"_s, obj(R"({"broker_connected":true,"broker_provider":"futu"})"));
            bool done = false;
            rig.status.refresh([&] { done = true; });
            QTRY_VERIFY(done);
            rig.set(u"sectors.quotes"_s, obj(R"({"connected":false,"quotes":{}})"));
            shell::SectorsController page(&rig.sectors, &rig.alerts, &rig.quality, &rig.status, nullptr);
            page.setVisible(true);
            QTRY_COMPARE(rig.status.banner(), u"行情需要先在「富途 OpenD」面板连接引擎"_s);
        }
        {
            Rig rig;
            rig.set(u"sectors.quotes"_s, obj(R"({"connected":false,"quotes":{}})"));
            shell::SectorsController page(&rig.sectors, &rig.alerts, &rig.quality, &rig.status, nullptr);
            page.setVisible(true);
            QTRY_COMPARE(rig.status.banner(), u"行情需要先在「TWS 连接」面板连接引擎"_s);
        }
        {
            Rig rig;
            rig.set(u"sectors.list"_s, obj(R"({"sectors":[{"id":"s1","name":"空","stocks":[]}]})"));
            rig.set(u"sectors.quotes"_s, obj(R"({"connected":false,"quotes":{}})"));
            shell::SectorsController page(&rig.sectors, &rig.alerts, &rig.quality, &rig.status, nullptr);
            page.setVisible(true);
            QTRY_COMPARE(rig.calls(u"sectors.quotes"_s), 1);
            QTest::qWait(100);
            QCOMPARE(rig.status.banner(), QString());
        }
    }

    // 异动的未读:窗口在后台时节拍不清零;窗口回到前台当场清(不等下一拍);不在这一页时回前台不清
    void unreadClearsOnlyWhenLooking() {
        Rig rig;
        shell::SectorsController page(&rig.sectors, &rig.alerts, &rig.quality, &rig.status, nullptr);
        page.poolMs = 60;
        bool active = false;
        page.windowActive = [&] { return active; };
        page.setVisible(true);
        QTRY_VERIFY(rig.calls(u"quality.list"_s) >= 1);
        rig.quality.onEngineEvent(u"anomaly"_s, obj(R"({"events":[{"id":"e9","symbol":"NVDA","title":"NVDA 急涨","at":400}]})"));
        QCOMPARE(rig.quality.unread(), 1);
        const int lists = rig.calls(u"quality.list"_s);
        QTRY_VERIFY(rig.calls(u"quality.list"_s) >= lists + 2);
        QCOMPARE(rig.quality.unread(), 1);
        page.windowFocused();
        QCOMPARE(rig.quality.unread(), 0);
        page.setVisible(false);
        rig.quality.onEngineEvent(u"anomaly"_s, obj(R"({"events":[{"id":"e10","symbol":"NVDA","title":"NVDA 急跌","at":500}]})"));
        page.windowFocused();
        QCOMPARE(rig.quality.unread(), 1);
    }

    // 选股跑着的时候断线又连上:只重刷,不算重新挂上——回包照样落地,「选股中…」会收掉
    void reconnectKeepsInFlight() {
        Rig rig(u"sectors.pick=400"_s);
        rig.set(u"sectors.pick"_s, obj(R"({"skipped":[]})"));
        shell::SectorsController page(&rig.sectors, &rig.alerts, &rig.quality, &rig.status, nullptr);
        page.setVisible(true);
        QTRY_COMPARE(page.page()[u"sectors"_s].toArray().size(), 1);
        page.pick(u"s1"_s);
        QVERIFY(page.page()[u"sectors"_s][0][u"picking"_s].toBool());
        const int lists = rig.calls(u"sectors.list"_s);
        for (const char* st : {R"({"broker_connected":false})", R"({"broker_connected":true})"}) {
            rig.set(u"system.status"_s, obj(st));
            bool done = false;
            rig.status.refresh([&] { done = true; });
            QTRY_VERIFY(done);
        }
        QTRY_VERIFY(rig.calls(u"sectors.list"_s) >= lists + 2);  // 两次翻转各重刷一遍
        QTRY_VERIFY_WITH_TIMEOUT(!page.page()[u"sectors"_s][0][u"picking"_s].toBool(), 3000);
        QCOMPARE(page.page()[u"sectors"_s][0][u"pickLabel"_s].toString(), u"AI 重新选股"_s);
    }

    // 存不上:引擎重读回来和原来一样,框里也得退回引擎那份(不能让人以为改成了)
    void rejectedSaveRevertsDraft() {
        Rig rig;
        rig.set(u"quality.set_config"_s, QJsonObject{{u"__error"_s, u"起报倍数超出范围"_s}});
        rig.set(u"alerts.set_touch_config"_s, QJsonObject{{u"__error"_s, u"天数超出范围"_s}});
        shell::SectorsController page(&rig.sectors, &rig.alerts, &rig.quality, &rig.status, nullptr);
        page.saveDelayMs = 40;
        page.setVisible(true);
        QTRY_VERIFY(page.page()[u"conditions"_s].isObject());
        QTRY_VERIFY(page.page()[u"touch"_s].isObject());
        page.patchConditions(QJsonObject{{u"burst_ratio"_s, 99}});
        QCOMPARE(page.page()[u"conditions"_s][u"burst"_s].toDouble(), 99.0);
        QTRY_COMPARE(rig.status.banner(), u"触发条件没存上:起报倍数超出范围"_s);
        QTRY_COMPARE(page.page()[u"conditions"_s][u"burst"_s].toDouble(), 4.0);
        const QJsonValue before = page.page()[u"touch"_s][u"window"_s];
        page.patchTouch(QJsonObject{{u"window_days"_s, 999}}, true);
        QTRY_COMPARE(rig.status.banner(), u"碰均线提醒的设置没存上:天数超出范围"_s);
        QTRY_COMPARE(page.page()[u"touch"_s][u"window"_s], before);
    }

    // 触发条件的防抖用的是原版的 600 毫秒
    void conditionsDebounceIs600ms() {
        Rig rig;
        rig.set(u"quality.set_config"_s, QJsonObject{{u"config"_s, obj(kQuality)[u"config"_s]}});
        shell::SectorsController page(&rig.sectors, &rig.alerts, &rig.quality, &rig.status, nullptr);
        QCOMPARE(page.saveDelayMs, 600);
        page.setVisible(true);
        QTRY_VERIFY(page.page()[u"conditions"_s].isObject());
        QElapsedTimer t;
        t.start();
        page.patchConditions(QJsonObject{{u"burst_ratio"_s, 5}});
        QTRY_COMPARE_WITH_TIMEOUT(rig.calls(u"quality.set_config"_s), 1, 3000);
        QVERIFY2(t.elapsed() >= 550, qPrintable(QString::number(t.elapsed())));
    }

    void conditionsDebounceAndFlush() {
        Rig rig;
        // 引擎回存好的整份(这里回原来那份就够:只看发了什么)
        rig.set(u"quality.set_config"_s, QJsonObject{{u"config"_s, obj(kQuality)[u"config"_s]}});
        rig.set(u"alerts.set_touch_config"_s, QJsonObject{{u"config"_s, obj(R"({"enabled":false,"periods":[20,60],"window_days":10,"min_touches":3,"band_pct":0.3})")}});
        shell::SectorsController page(&rig.sectors, &rig.alerts, &rig.quality, &rig.status, nullptr);
        page.saveDelayMs = 120;
        page.setVisible(true);
        QTRY_VERIFY(page.page()[u"conditions"_s].isObject());
        page.patchConditions(QJsonObject{{u"burst_ratio"_s, 5}});
        page.patchConditions(QJsonObject{{u"cooldown_min"_s, 20}});
        // 跟手:页面上那份马上是新的
        QCOMPARE(page.page()[u"conditions"_s][u"burst"_s].toDouble(), 5.0);
        QCOMPARE(page.page()[u"conditions"_s][u"cooldown"_s].toDouble(), 20.0);
        QTRY_COMPARE(rig.calls(u"quality.set_config"_s), 1);
        QVERIFY(rig.params(u"quality.set_config"_s).first().contains(u"\"burst_ratio\":5"_s));
        QVERIFY(rig.params(u"quality.set_config"_s).first().contains(u"\"cooldown_min\":20"_s));
        // 离开页面时还有没存的:立刻存
        page.patchConditions(QJsonObject{{u"spike_sigma"_s, 4}});
        page.setVisible(false);
        QTRY_COMPARE(rig.calls(u"quality.set_config"_s), 2);
        QVERIFY(rig.params(u"quality.set_config"_s).last().contains(u"\"spike_sigma\":4"_s));
        // 碰均线的开关:立刻存
        page.setVisible(true);
        QTRY_VERIFY(page.page()[u"touch"_s].isObject());
        const int before = rig.logs.filter(u"touch"_s).size();
        page.patchTouch(QJsonObject{{u"enabled"_s, false}}, true);
        QTRY_VERIFY(rig.logs.filter(u"touch"_s).size() > before);
    }
};

QTEST_GUILESS_MAIN(TestSectorsController)
#include "tst_sectors_controller.moc"
