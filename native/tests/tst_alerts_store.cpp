// 价位警告的全局轮询(shell/alerts_store,照 store/alerts.ts):对着假引擎。
// 只在连着券商、有开着且算出价位的盯单时才问;一批只响一声、一次交给弹窗;弹窗没收下的合成一条系统通知;
// 在持仓追踪里的标的正文补一句、「查看」落到持仓追踪页;重算的入参、降级横幅与 busy;引擎推来的 alerts 事件进流水。
#include "shell/alert_tone.h"
#include "shell/alerter.h"
#include "shell/alerts_store.h"
#include "shell/bridge.h"
#include "shell/consent.h"
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

const char* kArmed = R"({"watches":[{"id":"w1","symbol":"NVDA","enabled":true,"levels":[{"price":180}]},{"id":"w2","symbol":"SPX","enabled":true,"levels":[]}],
    "touch_config":{"window_min":30},"cross_confirm":"bar_close"})";
const char* kFired = R"({"fired":[
    {"symbol":"NVDA","price":180,"direction":"up","label":"整数关口","text":"NVDA 上穿 180 整数关口","at":1760000000},
    {"symbol":"SPX","price":7700.5,"direction":"up","label":"P 墙","text":"SPX 上穿 P 墙","at":1760000001}]})";

struct Rig {
    QTemporaryDir dir;
    QString resultsPath = dir.filePath(u"results.json"_s);
    shell::EngineClient engine;
    QStringList logs;
    struct Yes : shell::Prompter {
        QList<shell::ConfirmBox> asked;
        void ask(const shell::ConfirmBox& b, std::function<void(bool)> d) override {
            asked.append(b);
            d(true);
        }
    } yes;
    shell::ConsentStore consent{dir.path()};
    shell::Bridge bridge{&engine, &yes, &consent};
    shell::StatusStore status{&engine, 60'000};
    shell::PopupQueue popup;
    FakeOutputs outputs;
    shell::Alerter alerter{&popup, &outputs, QString()};
    shell::AlertsStore alerts{&bridge, &status, &alerter};
    QJsonObject results;

    explicit Rig(bool connected = true)
        : engine(fakeEngine({{u"FAKE_STATUS"_s, connected ? u"{\"broker_connected\":true}"_s : u"{\"broker_connected\":false}"_s},
                             {u"FAKE_LOG_PARAMS"_s, u"1"_s}, {u"FAKE_RESULTS_FILE"_s, resultsPath}}),
                 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        alerts.now = [] { return 1'760'000'500'000.0; };
        alerts.clock = [] { return u"21:05:03"_s; };
        set(u"alerts.list"_s, obj(kArmed));
        set(u"alerts.poll"_s, obj(kFired));
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
    void loadNow() {
        const int before = calls(u"alerts.list"_s);
        alerts.load();
        QTRY_COMPARE(calls(u"alerts.list"_s), before + 1);
        QTRY_COMPARE(alerts.snap()[u"watches"].toArray().size(), 2);
    }
    void pollNow() {
        const int before = calls(u"alerts.list"_s);
        alerts.poll();
        QTRY_COMPARE(alerts.snap()[u"lastCheck"].toString(), u"上次检查 21:05:03"_s);
        QTRY_COMPARE(calls(u"alerts.list"_s), before + 1);  // 报了东西就重读一遍
    }
};

}  // namespace

class TestAlertsStore : public QObject {
    Q_OBJECT
private slots:
    void loadReadsWatchesAndConfig() {
        Rig rig;
        rig.loadNow();
        const QJsonObject s = rig.alerts.snap();
        QCOMPARE(s[u"crossConfirm"].toString(), u"bar_close"_s);
        QCOMPARE(s[u"touchConfig"].toObject()[u"window_min"].toInt(), 30);
        QCOMPARE(s[u"lastCheck"].toString(), u"—"_s);
        QCOMPARE(rig.alerts.armed(), 1);  // SPX 那条还没算出价位
    }

    // 一批:一声(两条都是上穿 → 升调)、一次弹窗、进流水;弹窗都收下了就没有系统通知
    void pollAnnouncesOneBatch() {
        Rig rig;
        rig.loadNow();
        rig.pollNow();
        QCOMPARE(rig.outputs.sounds.size(), 1);
        QCOMPARE(rig.outputs.sounds.at(0), shell::tone::wav(u"up"_s));
        QCOMPARE(rig.outputs.notices.size(), 0);
        const QJsonArray items = rig.popup.items();
        QCOMPARE(items.size(), 2);
        // 弹窗最新的在上
        QJsonObject nvda, spx;
        for (const QJsonValue& v : items) (v[u"symbol"] == u"NVDA"_s ? nvda : spx) = v.toObject();
        QCOMPARE(nvda[u"id"].toString(), u"level:NVDA:180:1760000000"_s);
        QCOMPARE(nvda[u"title"].toString(), u"NVDA 上穿 180"_s);
        QCOMPARE(nvda[u"body"].toString(), u"NVDA 上穿 180 整数关口"_s);
        QCOMPARE(nvda[u"tone"].toString(), u"up"_s);
        QCOMPARE(nvda[u"page"].toString(), u"sectors"_s);
        QCOMPARE(nvda[u"at"].toDouble(), 1'760'000'000'000.0);
        QCOMPARE(spx[u"id"].toString(), u"level:SPX:7700.5:1760000001"_s);
        QCOMPARE(rig.alerts.snap()[u"feed"].toArray().size(), 2);
        QCOMPARE(rig.alerts.snap()[u"feed"].toArray().at(0)[u"symbol"].toString(), u"NVDA"_s);
    }

    // 有涨有跌:方向说不清,响中性的那一声
    void mixedDirectionsPlayNeutral() {
        Rig rig;
        rig.set(u"alerts.poll"_s, obj(R"({"fired":[{"symbol":"A","price":1,"direction":"up","at":5},{"symbol":"B","price":2,"direction":"down","at":5}]})"));
        rig.loadNow();
        rig.pollNow();
        QCOMPARE(rig.outputs.sounds.size(), 1);
        QCOMPARE(rig.outputs.sounds.at(0), shell::tone::wav(QString()));
    }

    // 弹窗关着:这一批一条不落合成一条系统通知
    void popupOffFallsBackToOneNotice() {
        Rig rig;
        rig.alerter.setPopupEnabled(false);
        rig.loadNow();
        rig.pollNow();
        QCOMPARE(rig.popup.items().size(), 0);
        QCOMPARE(rig.outputs.notices.size(), 1);
        QCOMPARE(rig.outputs.notices.at(0).first, u"2 条价位提醒:NVDA、SPX"_s);
        QCOMPARE(rig.outputs.notices.at(0).second, u"NVDA 上穿 180;SPX 上穿 7700.5"_s);
    }

    // 一批超了弹窗单次收的上限(30):收不下的是最后那几条,只把它们合成通知
    void overflowNotifiesTheTail() {
        Rig rig;
        QJsonArray fired;
        for (int i = 0; i < shell::popup::kMaxIncoming + 2; ++i)
            fired.append(QJsonObject{{u"symbol"_s, u"S%1"_s.arg(i)}, {u"price"_s, i + 1}, {u"direction"_s, u"down"_s}, {u"at"_s, 5}});
        rig.set(u"alerts.poll"_s, QJsonObject{{u"fired"_s, fired}});
        rig.loadNow();
        rig.pollNow();
        QCOMPARE(rig.popup.items().size(), shell::popup::kMaxIncoming);
        QCOMPARE(rig.outputs.notices.size(), 1);
        QCOMPARE(rig.outputs.notices.at(0).first, u"2 条价位提醒:S30、S31"_s);
        QCOMPARE(rig.outputs.notices.at(0).second, u"S30 下破 31;S31 下破 32"_s);
    }

    void popupOffSingleUsesTheText() {
        Rig rig;
        rig.alerter.setPopupEnabled(false);
        rig.set(u"alerts.poll"_s, obj(R"({"fired":[{"symbol":"SPX","price":7712,"trigger":"touch","label":"20日线","text":"30 分钟里第 3 次碰 20日线","at":9}]})"));
        rig.loadNow();
        rig.pollNow();
        QCOMPARE(rig.outputs.notices.size(), 1);
        QCOMPARE(rig.outputs.notices.at(0).first, u"SPX 反复碰 20日线"_s);
        QCOMPARE(rig.outputs.notices.at(0).second, u"30 分钟里第 3 次碰 20日线"_s);
    }

    // 碰均线:id 前缀 touch、不着涨跌色、不算方向
    void touchIsNeutral() {
        Rig rig;
        const QJsonObject item = rig.alerts.toPopupItem(obj(R"({"symbol":"SPX","price":7712,"trigger":"touch","direction":"up","label":"20日线","text":"t"})"));
        QCOMPARE(item[u"id"].toString(), u"touch:SPX:7712:1760000500"_s);  // 没有 at:按现在的秒
        QCOMPARE(item[u"tone"].toString(), u"info"_s);
        QCOMPARE(item[u"title"].toString(), u"SPX 反复碰 20日线"_s);
    }

    // 在持仓追踪里:正文补一句离止损多远,「查看」落到持仓追踪页
    void trackedSymbolGoesToTracker() {
        Rig rig;
        rig.alerts.trackerSnapshot = [] {
            return std::pair{QJsonArray{obj(R"({"id":"t1","symbol":"NVDA","sec_type":"STK","enabled":true,"fired_at":null,"targets":{"stop_loss":170}})")},
                             obj(R"({"t1":{"price":180}})")};
        };
        const QJsonObject item = rig.alerts.toPopupItem(obj(R"({"symbol":"NVDA","price":180,"direction":"up","text":"NVDA 上穿 180","at":5})"));
        QCOMPARE(item[u"body"].toString(), u"NVDA 上穿 180 · 持仓追踪:止损 170(距现价 −5.56%)"_s);
        QCOMPARE(item[u"page"].toString(), u"tracker"_s);
    }

    // 不连券商、或者没有一条算出价位的开着的盯单:不问引擎
    void noPollWhenDisconnectedOrUnarmed() {
        {
            Rig rig(false);
            rig.loadNow();
            rig.alerts.poll();
            QTest::qWait(150);
            QCOMPARE(rig.calls(u"alerts.poll"_s), 0);
        }
        Rig rig;
        rig.set(u"alerts.list"_s, obj(R"({"watches":[{"id":"w1","enabled":false,"levels":[{"price":1}]},{"id":"w2","enabled":true,"levels":[]}]})"));
        rig.loadNow();
        rig.alerts.poll();
        QTest::qWait(150);
        QCOMPARE(rig.calls(u"alerts.poll"_s), 0);
    }

    // 重算:不给步长就不带 step;降级说出来(是提示不是报错);重读完才放掉 busy
    void refreshParamsAndDegradedBanner() {
        Rig rig;
        rig.set(u"alerts.refresh"_s, obj(R"({"wall_error":"没有期权链"})"));
        rig.loadNow();
        rig.alerts.refreshWatch(u"w1"_s);
        QCOMPARE(rig.alerts.snap()[u"busy"].toArray(), QJsonArray{u"w1"_s});
        QTRY_VERIFY(rig.alerts.snap()[u"busy"].toArray().isEmpty());
        QVERIFY2(rig.logs.contains(u"[fake] alerts.refresh {\"expiry\":\"\",\"id\":\"w1\"}"_s), qPrintable(rig.logs.join(u'\n')));
        QCOMPARE(rig.status.banner(), u"期权墙没算出来,已降级:没有期权链"_s);
        QVERIFY(rig.status.bannerInfo());
        rig.alerts.refreshWatch(u"w1"_s, u"20261120"_s, 5);
        QTRY_VERIFY(rig.logs.contains(u"[fake] alerts.refresh {\"expiry\":\"20261120\",\"id\":\"w1\",\"step\":5}"_s));

        rig.set(u"alerts.refresh"_s, obj(R"({"__error":"引擎忙"})"));
        rig.alerts.refreshWatch(u"w1"_s);
        QTRY_COMPARE(rig.status.banner(), u"计算期权墙失败:引擎忙"_s);
        QVERIFY(!rig.status.bannerInfo());
        QTRY_VERIFY(rig.alerts.snap()[u"busy"].toArray().isEmpty());
    }

    // 建一个就当场算一次墙;origin 只在给了的时候带
    void createThenRefresh() {
        Rig rig;
        rig.set(u"alerts.create"_s, obj(R"({"watch":{"id":"w9"}})"));
        rig.set(u"alerts.refresh"_s, obj(R"({})"));
        QSignalSpy created(&rig.alerts, &shell::AlertsStore::created);
        rig.alerts.createWatch(u"AMD"_s, 0, u"tracker"_s);
        QTRY_COMPARE(created.size(), 1);
        QVERIFY(created.at(0).at(0).toBool());
        QVERIFY(rig.logs.contains(u"[fake] alerts.create {\"origin\":\"tracker\",\"step\":0,\"symbol\":\"AMD\"}"_s));
        QVERIFY(rig.logs.contains(u"[fake] alerts.refresh {\"expiry\":\"\",\"id\":\"w9\"}"_s));
        rig.set(u"alerts.create"_s, obj(R"({"__error":"代码不合法"})"));
        rig.alerts.createWatch(u"??"_s, 0);
        QTRY_COMPARE(created.size(), 2);
        QVERIFY(!created.at(1).at(0).toBool());
        QCOMPARE(rig.status.banner(), u"盯 ?? 失败:代码不合法"_s);
        QVERIFY(rig.logs.contains(u"[fake] alerts.create {\"step\":0,\"symbol\":\"??\"}"_s));
    }

    // 穿越确认方式存不上:报错并重读,开关退回引擎那一档
    void crossConfirmRevertsOnFailure() {
        Rig rig;
        rig.loadNow();
        rig.set(u"alerts.set_touch_config"_s, obj(R"({"__error":"坏了"})"));
        rig.alerts.saveCrossConfirm(u"immediate"_s);
        QCOMPARE(rig.alerts.snap()[u"crossConfirm"].toString(), u"immediate"_s);
        QTRY_COMPARE(rig.status.banner(), u"穿越确认方式没存上:坏了"_s);
        QTRY_COMPARE(rig.alerts.snap()[u"crossConfirm"].toString(), u"bar_close"_s);
        QVERIFY(rig.logs.contains(u"[fake] alerts.set_touch_config {\"config\":{},\"cross_confirm\":\"immediate\"}"_s));
    }

    void deleteAsksFirst() {
        Rig rig;
        rig.set(u"alerts.delete"_s, obj(R"({})"));
        rig.alerts.deleteWatch(u"w1"_s, u"NVDA"_s);
        QTRY_VERIFY(rig.logs.contains(u"[fake] alerts.delete {\"id\":\"w1\"}"_s));
        QCOMPARE(rig.yes.asked.size(), 1);
        QCOMPARE(rig.yes.asked.at(0).message, u"不再盯 NVDA?"_s);
        QCOMPARE(rig.yes.asked.at(0).confirmLabel, u"删除"_s);
    }

    // 引擎推来的 alerts 事件:进流水,最多留 50 条
    void engineEventFillsTheFeed() {
        Rig rig;
        QJsonArray events;
        for (int i = 0; i < 60; ++i) events.append(QJsonObject{{u"symbol"_s, u"S%1"_s.arg(i)}});
        rig.alerts.onEngineEvent(u"alerts"_s, QJsonObject{{u"events"_s, events}});
        QCOMPARE(rig.alerts.snap()[u"feed"].toArray().size(), 50);
        QCOMPARE(rig.alerts.snap()[u"feed"].toArray().at(0)[u"symbol"].toString(), u"S0"_s);
        rig.alerts.onEngineEvent(u"quality"_s, QJsonObject{{u"events"_s, events}});
        QCOMPARE(rig.alerts.snap()[u"feed"].toArray().size(), 50);
    }
};

QTEST_GUILESS_MAIN(TestAlertsStore)
#include "tst_alerts_store.moc"
