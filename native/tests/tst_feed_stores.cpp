// 三路引擎推来的提醒(shell/feed_stores,照 store/playbook.ts、store/quality.ts、store/intel.ts):对着假引擎。
// 剧本:推来的事件弹一条、关着只更新面板、看得见才五秒一读;异动:去重进流水、未读、一批一声一次弹窗、读完列表跟上、
// 同一个错只报一次、开关失败拨回去;情报:入参、没连券商时补拉、持仓被提到的提醒与未读、连着来的合成一次、档案的旧回包不覆盖。
#include "shell/alert_tone.h"
#include "shell/alerter.h"
#include "shell/bridge.h"
#include "shell/consent.h"
#include "shell/feed_stores.h"
#include "shell/popup_rules.h"
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

struct FakeOutputs : shell::AlertOutputs {
    QList<QByteArray> sounds;
    QList<QPair<QString, QString>> notices;
    void playWav(const QByteArray& wav) override { sounds.append(wav); }
    bool notify(const QString& t, const QString& b) override {
        notices.append({t, b});
        return true;
    }
};

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
    FakeOutputs outputs;
    shell::Alerter alerter{&popup, &outputs, QString()};
    QSignalSpy fed{&alerter, &shell::Alerter::notified};
    QJsonObject results;

    Rig() : engine(fakeEngine({{u"FAKE_STATUS"_s, u"{\"broker_connected\":true}"_s}, {u"FAKE_LOG_PARAMS"_s, u"1"_s}, {u"FAKE_RESULTS_FILE"_s, resultsPath}}), 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
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

const char* kPush = R"({"snapshot":{"symbol":"SPX","state":"B2"},"events":[{"kind":"enter","state":"B2","level":7745.5,"price":7746.25,"at":1792332300000}]})";

const char* kQuality = R"({"stocks":[
    {"id":"q1","symbol":"NVDA","enabled":1,"events":[{"id":"e1","title":"NVDA 放量","text":"t1","at":100},{"id":"e2","title":"NVDA 急涨","text":"t2","at":300}]},
    {"id":"q2","symbol":"AMD","enabled":1}],
    "config":{"burst":3},"monitor":{"beat_at":5},"max":25})";

}  // namespace

class TestFeedStores : public QObject {
    Q_OBJECT
private slots:
    // ---------------------------------------------------------------- 日内剧本
    void playbookPushAnnounces() {
        Rig rig;
        shell::PlaybookStore pb(&rig.bridge, &rig.alerter, QString());
        pb.onEngineEvent(u"playbook"_s, obj(kPush));
        QCOMPARE(pb.snap()[u"state"].toString(), u"B2"_s);
        QCOMPARE(rig.outputs.sounds.size(), 1);
        QCOMPARE(rig.outputs.sounds.at(0), shell::tone::wav(u"up"_s));
        QCOMPARE(rig.popup.items().size(), 1);
        const QJsonObject item = rig.popup.items().at(0).toObject();
        QCOMPARE(item[u"id"].toString(), u"playbook:enter:B2:7745.5:1792332300000"_s);
        QCOMPARE(item[u"title"].toString(), u"SPX 站上 7745.50,进入 B2 上沿扩展"_s);
        QCOMPARE(item[u"body"].toString(), u"现价 7746.25 · 美东 10:05"_s);
        QCOMPARE(item[u"page"].toString(), u"trade"_s);
        QCOMPARE(rig.fed.size(), 0);  // 剧本不进通知流

        // 提醒关着:面板照样更新,不响不弹
        pb.setAlert(false);
        QJsonObject next = obj(kPush);
        next[u"snapshot"] = obj(R"({"symbol":"SPX","state":"R"})");
        pb.onEngineEvent(u"playbook"_s, next);
        QCOMPARE(pb.snap()[u"state"].toString(), u"R"_s);
        QCOMPARE(rig.outputs.sounds.size(), 1);
    }

    void playbookPollsOnlyWhenVisible() {
        Rig rig;
        rig.set(u"options.playbook"_s, obj(R"({"state":"none"})"));
        shell::PlaybookStore pb(&rig.bridge, &rig.alerter, QString());
        double clock = 1'000'000;
        pb.now = [&clock] { return clock; };
        pb.tick();
        QTest::qWait(80);
        QCOMPARE(rig.calls(u"options.playbook"_s), 0);
        pb.setVisible(true);
        QTRY_COMPARE(rig.calls(u"options.playbook"_s), 1);
        QTRY_COMPARE(pb.snap()[u"state"].toString(), u"none"_s);
        clock += 4'000;
        pb.tick();
        QTest::qWait(80);
        QCOMPARE(rig.calls(u"options.playbook"_s), 1);
        clock += 1'000;
        pb.tick();
        QTRY_COMPARE(rig.calls(u"options.playbook"_s), 2);

        rig.set(u"options.playbook_set"_s, obj(R"({"__error":"不在交易日"})"));
        QSignalSpy done(&pb, &shell::PlaybookStore::enabledDone);
        pb.setEnabled(true);
        QTRY_COMPARE(done.size(), 1);
        QCOMPARE(done.at(0).at(0).toString(), u"不在交易日"_s);
        QVERIFY(rig.logs.contains(u"[fake] options.playbook_set {\"enabled\":true}"_s));
    }

    // ---------------------------------------------------------------- 异动
    void qualitySeedsTheFeedOnce() {
        Rig rig;
        rig.set(u"quality.list"_s, obj(kQuality));
        shell::QualityStore q(&rig.bridge, &rig.status, &rig.alerter);
        q.start();
        QTRY_VERIFY(q.snap()[u"loaded"].toBool());
        const QJsonObject s = q.snap();
        QCOMPARE(s[u"stocks"].toArray().size(), 2);
        QVERIFY(s[u"stocks"].toArray().at(1)[u"metrics"].isNull());  // 补齐了形状
        QCOMPARE(s[u"stocks"].toArray().at(1)[u"events"].toArray().size(), 0);
        QCOMPARE(s[u"max"].toInt(), 25);
        QCOMPARE(s[u"feed"].toArray().at(0)[u"id"].toString(), u"e2"_s);  // 新的在前
        QCOMPARE(s[u"feed"].toArray().size(), 2);
        QCOMPARE(q.unread(), 0);
    }

    void qualityAnomalyLands() {
        Rig rig;
        rig.set(u"quality.list"_s, obj(kQuality));
        shell::QualityStore q(&rig.bridge, &rig.status, &rig.alerter);
        q.now = [] { return 9e12; };
        q.start();
        QTRY_VERIFY(q.snap()[u"loaded"].toBool());
        const int lists = rig.calls(u"quality.list"_s);
        // e2 已经在流水里:不再报;e3 新的;坏的(没有 title)丢掉
        q.onEngineEvent(u"anomaly"_s, obj(R"({"events":[{"id":"e2","title":"NVDA 急涨","at":300},{"id":"e3","symbol":"AMD","title":"AMD 窗口放量 4.1×","text":"近 5 分钟","kind":"burst","direction":"up","at":400},{"id":"bad"}]})"));
        QCOMPARE(q.unread(), 1);
        QCOMPARE(q.snap()[u"feed"].toArray().at(0)[u"id"].toString(), u"e3"_s);
        QCOMPARE(rig.fed.size(), 1);
        QCOMPARE(rig.fed.at(0).at(0).toString(), u"AMD 窗口放量 4.1×"_s);
        QCOMPARE(rig.outputs.sounds.size(), 1);
        QCOMPARE(rig.outputs.sounds.at(0), shell::tone::wav(QString()));  // 放量是中性的那一声
        QCOMPARE(rig.popup.items().size(), 1);
        const QJsonObject item = rig.popup.items().at(0).toObject();
        QCOMPARE(item[u"kind"].toString(), u"anomaly"_s);
        QCOMPARE(item[u"page"].toString(), u"quality"_s);
        QCOMPARE(item[u"at"].toDouble(), 400'000.0);
        QCOMPARE(item[u"tone"].toString(), u"up"_s);
        QTRY_COMPARE(rig.calls(u"quality.list"_s), lists + 1);  // 读完列表跟上

        // 人在这一页:照 React 版问的是 quality,实际总是算没看见
        q.seeing = [](const QString& page) { return page == u"sectors"; };
        q.onEngineEvent(u"anomaly"_s, obj(R"({"events":[{"id":"e4","symbol":"AMD","title":"x","at":500}]})"));
        QCOMPARE(q.unread(), 2);
        q.seeing = [](const QString& page) { return page == u"quality"; };
        q.onEngineEvent(u"anomaly"_s, obj(R"({"events":[{"id":"e5","symbol":"AMD","title":"y","at":600}]})"));
        QCOMPARE(q.unread(), 2);
        q.markSeen();
        QCOMPARE(q.unread(), 0);
    }

    void qualityPopupOffFoldsIntoOneNotice() {
        Rig rig;
        rig.set(u"quality.list"_s, obj(R"({"stocks":[]})"));
        rig.alerter.setPopupEnabled(false);
        shell::QualityStore q(&rig.bridge, &rig.status, &rig.alerter);
        q.onEngineEvent(u"anomaly"_s, obj(R"({"events":[{"id":"a","symbol":"NVDA","title":"NVDA 急跌","text":"t","direction":"down","at":1},{"id":"b","symbol":"NVDA","title":"NVDA 放量","at":2},{"id":"c","symbol":"AMD","title":"AMD 急跌","at":3}]})"));
        QCOMPARE(rig.outputs.notices.size(), 1);
        QCOMPARE(rig.outputs.notices.at(0).first, u"3 条异动:NVDA、AMD"_s);
        QCOMPARE(rig.outputs.notices.at(0).second, u"NVDA 急跌;NVDA 放量;AMD 急跌"_s);
    }

    void qualityErrorBannerOnce() {
        Rig rig;
        rig.set(u"quality.list"_s, obj(R"({"__error":"引擎忙"})"));
        shell::QualityStore q(&rig.bridge, &rig.status, &rig.alerter);
        QSignalSpy banners(&rig.status, &shell::StatusStore::bannerChanged);
        q.load();
        QTRY_COMPARE(q.snap()[u"error"].toString(), u"引擎忙"_s);
        QCOMPARE(rig.status.banner(), u"读取优质股列表失败:引擎忙"_s);
        rig.status.hideBanner();
        q.load();
        QTRY_COMPARE(rig.calls(u"quality.list"_s), 2);
        QTest::qWait(50);
        QCOMPARE(rig.status.banner(), QString());  // 同一个错只说一遍
        QVERIFY(q.snap()[u"loaded"].toBool());
    }

    void qualityToggleRevertsOnFailure() {
        Rig rig;
        rig.set(u"quality.list"_s, obj(kQuality));
        shell::QualityStore q(&rig.bridge, &rig.status, &rig.alerter);
        q.load();
        QTRY_VERIFY(q.snap()[u"loaded"].toBool());
        rig.set(u"quality.update"_s, obj(R"({"__error":"坏了"})"));
        q.toggle(u"q1"_s, false);
        QCOMPARE(q.snap()[u"stocks"].toArray().at(0)[u"enabled"].toInt(), 0);  // 先跟手
        QTRY_COMPARE(rig.status.banner(), u"停用失败:坏了"_s);
        QCOMPARE(q.snap()[u"stocks"].toArray().at(0)[u"enabled"].toInt(), 1);
        QVERIFY(rig.logs.contains(u"[fake] quality.update {\"enabled\":false,\"id\":\"q1\"}"_s));

        // 成了:以回执为准,回执没带指标就留着原来的
        rig.set(u"quality.update"_s, obj(R"({"stock":{"id":"q1","symbol":"NVDA","enabled":0}})"));
        QJsonArray withMetrics = q.snap()[u"stocks"].toArray();
        q.toggle(u"q1"_s, false);
        QTRY_VERIFY(rig.calls(u"quality.update"_s) == 2);
        QTest::qWait(50);
        QCOMPARE(q.snap()[u"stocks"].toArray().at(0)[u"enabled"].toInt(), 0);
        QVERIFY(q.snap()[u"stocks"].toArray().at(0)[u"metrics"].isNull());
    }

    // 一次读列表在飞的途中有人改过:带回来的旧列表不覆盖本地,再读一次
    void qualityStaleListIsRefetched() {
        Rig rig;
        rig.set(u"quality.list"_s, obj(kQuality));
        rig.set(u"quality.update"_s, obj(R"({})"));
        shell::QualityStore q(&rig.bridge, &rig.status, &rig.alerter);
        q.load();
        q.toggle(u"q1"_s, false);  // 代数变了(开关的回执回来时还会再变一次,所以可能再读两次)
        QTRY_VERIFY(rig.calls(u"quality.list"_s) >= 2);
    }

    void qualityAddValidates() {
        Rig rig;
        shell::QualityStore q(&rig.bridge, &rig.status, &rig.alerter);
        QSignalSpy added(&q, &shell::QualityStore::added);
        q.add(u"  "_s);
        QCOMPARE(added.size(), 1);
        QCOMPARE(rig.status.banner(), u"先填一个标的代码"_s);
        QVERIFY(rig.status.bannerInfo());
        rig.set(u"quality.add"_s, obj(R"({"stock":{"id":"q9","symbol":"PLTR"}})"));
        q.add(u" pltr "_s, u"  数据中心  "_s);
        QTRY_COMPARE(added.size(), 2);
        QVERIFY(added.at(1).at(0).toBool());
        QVERIFY(rig.logs.contains(u"[fake] quality.add {\"note\":\"数据中心\",\"symbol\":\"PLTR\"}"_s));
        QCOMPARE(rig.status.banner(), u"已加入优质股追踪:PLTR。盘中每 5 秒检测一轮,放量、急涨急跌会弹窗提醒。"_s);
        QCOMPARE(q.snap()[u"stocks"].toArray().last()[u"symbol"].toString(), u"PLTR"_s);
    }

    // ---------------------------------------------------------------- 情报
    void intelFeedParamsAndRetry() {
        Rig rig;
        rig.set(u"intel.feed"_s, obj(R"({"items":[],"connected":false})"));
        shell::IntelStore in(&rig.bridge, &rig.alerter, QString());
        in.retryMs = 30;
        in.loadFeed();
        QTRY_VERIFY(rig.logs.contains(u"[fake] intel.feed {\"limit\":300}"_s));
        QTRY_VERIFY(rig.calls(u"intel.feed"_s) >= 3);  // 没连券商:隔一会儿再拉
        rig.set(u"intel.feed"_s, obj(R"({"items":[],"connected":true})"));
        QTRY_VERIFY(in.state()[u"feed"][u"connected"].toBool());
        QTest::qWait(150);
        const int n = rig.calls(u"intel.feed"_s);
        QTest::qWait(150);
        QCOMPARE(rig.calls(u"intel.feed"_s), n);  // 连上就不再补拉
        in.setKinds({u"message"_s, u"order"_s});
        QTRY_VERIFY(rig.logs.contains(u"[fake] intel.feed {\"kinds\":[\"message\",\"order\"],\"limit\":300}"_s));
        QTRY_VERIFY(!in.state()[u"loading"].toBool());
        in.setHeldOnly(true);
        QTRY_VERIFY(rig.logs.contains(u"[fake] intel.feed {\"held_only\":true,\"kinds\":[\"message\",\"order\"],\"limit\":300}"_s));
    }

    // 没连券商时补拉最多 24 次(两分钟),之后等 60 秒那一轮
    void intelRetryStopsAtTheLimit() {
        Rig rig;
        rig.set(u"intel.feed"_s, obj(R"({"items":[],"connected":false})"));
        shell::IntelStore in(&rig.bridge, &rig.alerter, QString());
        in.retryMs = 5;
        in.loadFeed();
        QTRY_COMPARE_WITH_TIMEOUT(rig.calls(u"intel.feed"_s), 1 + shell::IntelStore::kUnconnectedRetries, 10'000);
        QTest::qWait(200);
        QCOMPARE(rig.calls(u"intel.feed"_s), 1 + shell::IntelStore::kUnconnectedRetries);
        QCOMPARE(shell::IntelStore::kUnconnectedRetries, 24);
    }

    void intelHeldMention() {
        Rig rig;
        rig.set(u"intel.feed"_s, obj(R"({"items":[],"connected":true})"));
        shell::IntelStore in(&rig.bridge, &rig.alerter, QString());
        in.now = [] { return 5.0; };
        in.refetchMs = 40;
        const char* mention = R"({"kind":"held_mention","message_id":"m1","at":1792303200000,"author_name":"Charlie","text":"NVDA 180c 走了","symbols":["NVDA"],"prices":{"NVDA":180.5}})";
        in.onEngineEvent(u"intel"_s, obj(mention));
        QCOMPARE(in.unread(), 1);
        QCOMPARE(rig.fed.size(), 1);
        QCOMPARE(rig.fed.at(0).at(0).toString(), u"NVDA 被提到(持仓)"_s);
        QCOMPARE(rig.outputs.sounds.size(), 1);
        QCOMPARE(rig.outputs.sounds.at(0), shell::tone::wav(QString()));
        QCOMPARE(rig.popup.items().at(0)[u"body"].toString(), u"Charlie:NVDA 180c 走了(当时 NVDA 180.50)"_s);
        // 连着来的几条合成一次重拉
        in.onEngineEvent(u"alerts"_s, QJsonObject{});
        in.onEngineEvent(u"tracker"_s, QJsonObject{});
        QTRY_COMPARE(rig.calls(u"intel.feed"_s), 1);
        QTest::qWait(120);
        QCOMPARE(rig.calls(u"intel.feed"_s), 1);
        // 人在情报页、窗口在前台:不记未读
        in.seeing = [](const QString& page) { return page == u"intel"; };
        in.onEngineEvent(u"intel"_s, obj(mention));
        QCOMPARE(in.unread(), 1);
        // 不像 held_mention 的不报
        in.onEngineEvent(u"intel"_s, obj(R"({"kind":"held_mention","message_id":"m2","text":"x","symbols":[]})"));
        QCOMPARE(rig.fed.size(), 2);
    }

    // 重拉是"第一条来了之后 2 秒",不是"最后一条之后 2 秒":事件一直来,也不能一直往后推
    void intelRefetchIsNotPostponed() {
        Rig rig;
        rig.set(u"intel.feed"_s, obj(R"({"items":[],"connected":true})"));
        shell::IntelStore in(&rig.bridge, &rig.alerter, QString());
        in.refetchMs = 200;
        in.onEngineEvent(u"anomaly"_s, QJsonObject{});
        QTest::qWait(150);
        in.onEngineEvent(u"anomaly"_s, QJsonObject{});
        QTest::qWait(150);
        QTRY_COMPARE_WITH_TIMEOUT(rig.calls(u"intel.feed"_s), 1, 40);
    }

    void intelDossierAndRecent() {
        QTemporaryDir dir;
        const QString ini = dir.filePath(u"prefs.ini"_s);
        Rig rig;
        rig.set(u"intel.dossier"_s, obj(R"({"symbol":"NVDA","items":[]})"));
        {
            shell::IntelStore in(&rig.bridge, &rig.alerter, ini);
            in.setLookupOpen(true);
            in.openDossier(u" $nvda "_s);
            QCOMPARE(in.state()[u"dossier"][u"symbol"].toString(), u"NVDA"_s);
            QVERIFY(!in.state()[u"lookupOpen"].toBool());
            QTRY_VERIFY(!in.state()[u"dossier"][u"loading"].toBool());
            QCOMPARE(in.state()[u"dossier"][u"data"][u"symbol"].toString(), u"NVDA"_s);
            QVERIFY(rig.logs.contains(u"[fake] intel.dossier {\"symbol\":\"NVDA\"}"_s));
            in.openDossier(u"amd"_s);
            in.closeDossier();  // 在飞的那一次回来也不再打开
            QTest::qWait(150);
            QVERIFY(in.state()[u"dossier"].isNull());
            in.openDossier(u"nvda"_s);
            QCOMPARE(in.state()[u"recent"].toArray(), (QJsonArray{u"NVDA"_s, u"AMD"_s}));
        }
        shell::IntelStore again(&rig.bridge, &rig.alerter, ini);
        QCOMPARE(again.state()[u"recent"].toArray(), (QJsonArray{u"NVDA"_s, u"AMD"_s}));
    }
};

QTEST_GUILESS_MAIN(TestFeedStores)
#include "tst_feed_stores.moc"
