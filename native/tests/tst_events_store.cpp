// 重要事件的节拍与派生(shell/events_store,照 store/events.ts + shell/EventStrip.tsx + lib/EventList.tsx):对着假引擎。
// 顶上那一条写什么、提前提醒每档只报一次、跨市场那条一出来就报、板块联动报一次并在消失后挂 30 分钟、
// 盘前集体拉涨换说法并在 10:00 报回没回吐、时段提醒按当地钟点每天一次、自定义事件的入参。
// 时刻全由测试给(2026-10-14,美东 08:30 的 CPI),钟点按 Asia/Shanghai 写。
#include "shell/bridge.h"
#include "shell/consent.h"
#include "shell/events_store.h"
#include "shell/status_store.h"
#include "shell_harness.h"

#include <QJsonArray>
#include <QSignalSpy>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

constexpr double kMin = 60'000;
const double kCpiAt = double(QDateTime(QDate(2026, 10, 14), QTime(12, 30), QTimeZone::UTC).toMSecsSinceEpoch());

QJsonObject obj(const char* t) { return QJsonDocument::fromJson(t).object(); }

QJsonObject makeEvent(const char* json, double at) {
    QJsonObject e = obj(json);
    e.insert(u"at"_s, at);
    return e;
}

QJsonObject config(bool enabled = true) {
    QJsonObject c = obj(R"({"feed":true,"min_stars":4,"lead_minutes":[30,10],"sector_min_stocks":3,"sector_share":0.6,"sector_move_pct":2,"cross_market":true})");
    c.insert(u"enabled"_s, enabled);
    return c;
}

QJsonObject list(const QJsonArray& events, const QJsonValue& cross = QJsonValue(), bool enabled = true) {
    return QJsonObject{{u"events"_s, events},
                       {u"cross"_s, cross.isUndefined() ? QJsonValue() : cross},
                       {u"cross_status"_s, obj(R"({"in_window":false})")},
                       {u"config"_s, config(enabled)},
                       {u"feed"_s, obj(R"({"at":null,"error":"429 太多请求","count":0})")},
                       {u"at"_s, 1}};
}

QJsonArray standard() {
    return QJsonArray{
        makeEvent(R"j({"id":"cpi","kind":"cpi","title":"CPI(9月)","date_et":"2026-10-14","time_et":"08:30","impact":"high","stars":5,"source":"builtin","linger_min":120,
                  "items":[{"title":"CPI 月率","forecast":"0.3%","previous":"0.4%"}]})j", kCpiAt),
        makeEvent(R"({"id":"claims","kind":"claims","title":"初请失业金","date_et":"2026-10-14","time_et":"08:30","impact":"medium","stars":3,"source":"feed","linger_min":60})", kCpiAt),
        makeEvent(R"({"id":"custom:1","kind":"custom","title":"CRWV 发债","date_et":"2026-10-15","time_et":"11:30","impact":"high","stars":5,"source":"custom","linger_min":120,"note":"数据中心都要看"})",
              kCpiAt + 27 * 60 * kMin),
    };
}

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
    shell::EventsStore events{&bridge, &status};
    QSignalSpy announced{&events, &shell::EventsStore::announce};
    double clock = kCpiAt - 30 * kMin;
    QJsonObject results;

    explicit Rig(const QJsonObject& eventsList, const QString& status = u"{\"broker_connected\":true}"_s)
        : engine(fakeEngine({{u"FAKE_STATUS"_s, status}, {u"FAKE_LOG_PARAMS"_s, u"1"_s}, {u"FAKE_RESULTS_FILE"_s, resultsPath}}), 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        events.now = [this] { return clock; };
        events.tz = u"Asia/Shanghai"_s;
        set(u"events.list"_s, eventsList);
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
        const int before = calls(u"events.list"_s);
        events.load();
        QTRY_COMPARE(calls(u"events.list"_s), before + 1);
        QTest::qWait(50);
    }
    QJsonArray items() const { return events.strip().value("items"_L1).toArray(); }
    QString announcedTitle(int i) const { return announced.at(i).at(0).toJsonObject().value("title"_L1).toString(); }
};

}  // namespace

class TestEventsStore : public QObject {
    Q_OBJECT
private slots:
    void stripShowsWhatIsPinned() {
        Rig rig(list(standard()));
        QVERIFY(rig.events.strip().value("hidden"_L1).toBool());  // 还没拉到
        rig.loadNow();
        QTRY_COMPARE(rig.items().size(), 2);  // 明天的 CRWV 不在 18 小时里;中等影响的初请一小时内,上顶
        const QJsonObject cpi = rig.items().at(0).toObject();
        QCOMPARE(cpi[u"id"].toString(), u"cpi"_s);
        QCOMPARE(cpi[u"phase"].toString(), u"soon"_s);
        QCOMPARE(cpi[u"stars"].toString(), u"★★★★★"_s);
        QCOMPARE(cpi[u"meta"].toString(), u"今天 20:30(美东 08:30) · 还有 30 分钟"_s);
        QCOMPARE(cpi[u"fact"].toString(), u"预期 0.3% · 前值 0.4%"_s);
        QCOMPARE(cpi[u"titleTip"].toString(), u"CPI 月率"_s);
        QVERIFY(cpi[u"canAct"].toBool());
        QCOMPARE(rig.items().at(1).toObject()[u"impact"].toString(), u"medium"_s);
        QVERIFY(!rig.events.strip().value("hidden"_L1).toBool());
        QVERIFY2(rig.logs.contains(u"[fake] events.list {\"force\":false}"_s), qPrintable(rig.logs.join(u'\n')));

        // 公布过了一阵:不能再应对
        rig.clock = kCpiAt + 20 * kMin;
        rig.events.tick();
        QCOMPARE(rig.items().at(0).toObject()[u"phase"].toString(), u"after"_s);
        QCOMPARE(rig.items().at(0).toObject()[u"meta"].toString(), u"今天 20:30(美东 08:30) · 已公布 20 分钟"_s);
        QVERIFY(!rig.items().at(0).toObject()[u"canAct"].toBool());

        // 「全部」:按天分组;公开日历拉失败的原因写出来
        const QJsonObject all = rig.events.all();
        QCOMPARE(all[u"days"].toArray().size(), 2);
        QCOMPARE(all[u"days"].toArray().at(1).toObject()[u"day"].toString(), u"2026-10-15"_s);
        const QJsonObject custom = all[u"days"].toArray().at(1).toObject()[u"events"].toArray().at(0).toObject();
        QVERIFY(custom[u"custom"].toBool());
        QCOMPARE(custom[u"source"].toString(), u"自己记的"_s);
        QCOMPARE(all[u"status"].toString(), u"公开日历没拉到:429 太多请求;内置日程照样有。"_s);
    }

    void disabledHidesTheStrip() {
        Rig rig(list(standard(), QJsonValue(), false));
        rig.loadNow();
        QTRY_VERIFY(rig.events.all()[u"loaded"].toBool());
        QVERIFY(rig.events.strip().value("hidden"_L1).toBool());
        QCOMPARE(rig.items().size(), 0);
        QVERIFY(!rig.events.all()[u"enabled"].toBool());
        // 关着也不提醒
        rig.events.tick();
        QCOMPARE(rig.announced.size(), 0);
    }

    // 提前提醒:每档只报一次;中等影响的只报公布那一刻;公布那一刻的方向是 down
    void leadsFireOncePerStep() {
        Rig rig(list(standard()));
        rig.loadNow();
        rig.events.tick();
        QCOMPARE(rig.announced.size(), 1);
        QCOMPARE(rig.announcedTitle(0), u"30 分钟后公布 CPI(9月)"_s);
        QCOMPARE(rig.announced.at(0).at(1).toString(), QString());
        rig.events.tick();
        QCOMPARE(rig.announced.size(), 1);
        rig.clock = kCpiAt + 30'000;
        rig.events.tick();
        QCOMPARE(rig.announced.size(), 3);
        QCOMPARE(rig.announcedTitle(1), u"正在公布 CPI(9月)"_s);
        QCOMPARE(rig.announcedTitle(2), u"正在公布 初请失业金"_s);
        QCOMPARE(rig.announced.at(1).at(1).toString(), u"down"_s);
        QCOMPARE(rig.announced.at(1).at(0).toJsonObject()[u"page"].toString(), u"trade"_s);
    }

    // 跨市场那条(P0):一出来就报,同一条不再报;挂顶不受"今天的"限制
    void crossIsAnnouncedOnce() {
        const QJsonObject cross = makeEvent(R"({"id":"x1","kind":"cross","title":"美股 −2.5%,韩股 ETF 没跟跌","date_et":"2026-10-16","time_et":"20:00","impact":"high",
            "stars":5,"source":"builtin","linger_min":600,"cross":{"direction":"down","us_pct":-2.5,"markets":[{"key":"kr","name":"韩股","symbol":"EWY","etf_pct":-0.4,"gap":2.1,"open_at":0,"instruments":[]}]}})",
                                        kCpiAt + 60 * 60 * kMin);
        Rig rig(list(QJsonArray{}, cross));
        rig.loadNow();
        QTRY_COMPARE(rig.announced.size(), 1);
        QCOMPARE(rig.announcedTitle(0), u"P0 美股 −2.5%,韩股 ETF 没跟跌"_s);
        QCOMPARE(rig.announced.at(0).at(0).toJsonObject()[u"symbol"].toString(), u"EWY"_s);
        QCOMPARE(rig.announced.at(0).at(1).toString(), u"down"_s);
        rig.loadNow();
        QCOMPARE(rig.announced.size(), 1);
        QCOMPARE(rig.items().size(), 1);
        QVERIFY(rig.items().at(0).toObject()[u"cross"].toBool());
        QVERIFY(rig.items().at(0).toObject()[u"canAct"].toBool());
        QCOMPARE(rig.items().at(0).toObject()[u"stars"].toString(), QString());
    }

    // 板块联动:连着券商、美东 04:00 ~ 20:00 才问;报一次;条件消失后挂 30 分钟
    void sectorMovesAreReportedAndLinger() {
        Rig rig(list(QJsonArray{}));
        rig.clock = kCpiAt + 60 * kMin;  // 美东 09:30
        const QString fresh = QDateTime::fromMSecsSinceEpoch(qint64(rig.clock) - 30'000, QTimeZone::UTC).toString(Qt::ISODateWithMs);
        rig.set(u"sectors.list"_s, obj(R"({"sectors":[{"name":"半导体","stocks":[{"symbol":"NVDA"},{"symbol":"AMD"},{"symbol":"AVGO"}]}]})"));
        const auto quality = [&](double nvda, double amd, double avgo) {
            QJsonArray stocks;
            const QList<QPair<QString, double>> rows{{u"NVDA"_s, nvda}, {u"AMD"_s, amd}, {u"AVGO"_s, avgo}};
            for (const auto& [sym, pct] : rows)
                stocks.append(QJsonObject{{u"symbol"_s, sym}, {u"metrics"_s, QJsonObject{{u"change_pct"_s, pct}}}, {u"metrics_at"_s, fresh}});
            rig.set(u"quality.list"_s, QJsonObject{{u"stocks"_s, stocks}});
        };
        quality(-3.2, -2.5, -2.1);
        rig.status.refresh();
        QTRY_COMPARE(rig.status.engineOk(), 1);
        rig.loadNow();
        rig.events.tick();
        QTRY_COMPARE(rig.events.strip().value("moves"_L1).toArray().size(), 1);
        const QJsonObject move = rig.events.strip().value("moves"_L1).toArray().at(0).toObject();
        QCOMPARE(move[u"title"].toString(), u"板块联动:半导体 集体下跌"_s);
        QCOMPARE(move[u"meta"].toString(), u"3/3 只 · 中位 -2.5%"_s);
        QCOMPARE(move[u"tip"].toString(), u"3 只里 3 只同向超线,中位 -2.5%:NVDA -3.2%、AMD -2.5%、AVGO -2.1%"_s);
        QVERIFY(!rig.events.strip().value("hidden"_L1).toBool());
        QTRY_COMPARE(rig.announced.size(), 1);
        QCOMPARE(rig.announcedTitle(0), u"板块联动:半导体 集体下跌"_s);
        QCOMPARE(rig.announced.at(0).at(0).toJsonObject()[u"page"].toString(), u"sectors"_s);

        // 一分钟后还在:不再报
        rig.clock += 60'000;
        rig.events.tick();
        QTest::qWait(200);
        QCOMPARE(rig.announced.size(), 1);
        // 条件消失:还挂着;30 分钟后撤
        quality(-0.2, 0.1, -0.5);
        rig.clock += 60'000;
        const int sweeps = rig.calls(u"quality.list"_s);
        rig.events.tick();
        QTRY_COMPARE(rig.calls(u"quality.list"_s), sweeps + 1);
        QTest::qWait(100);
        QCOMPARE(rig.events.strip().value("moves"_L1).toArray().size(), 1);
        rig.clock += 31 * kMin;
        rig.events.tick();
        QTRY_COMPARE(rig.events.strip().value("moves"_L1).toArray().size(), 0);
    }

    void premarketRallyIsCheckedAtTen() {
        Rig rig(list(QJsonArray{}));
        rig.clock = kCpiAt + 55 * kMin;  // 美东 09:25:盘前
        rig.set(u"sectors.list"_s, obj(R"({"sectors":[{"name":"数据中心","stocks":[{"symbol":"CRWV"},{"symbol":"IREN"},{"symbol":"NBIS"}]}]})"));
        const auto quality = [&](double a, double b, double c) {
            const QString fresh = QDateTime::fromMSecsSinceEpoch(qint64(rig.clock) - 30'000, QTimeZone::UTC).toString(Qt::ISODateWithMs);
            QJsonArray stocks;
            const QList<QPair<QString, double>> rows{{u"CRWV"_s, a}, {u"IREN"_s, b}, {u"NBIS"_s, c}};
            for (const auto& [sym, pct] : rows)
                stocks.append(QJsonObject{{u"symbol"_s, sym}, {u"metrics"_s, QJsonObject{{u"change_pct"_s, pct}}}, {u"metrics_at"_s, fresh}});
            rig.set(u"quality.list"_s, QJsonObject{{u"stocks"_s, stocks}});
        };
        quality(6.0, 4.0, 3.0);
        rig.status.refresh();
        QTRY_COMPARE(rig.status.engineOk(), 1);
        rig.loadNow();
        rig.events.tick();
        QTRY_COMPARE(rig.announced.size(), 1);
        QCOMPARE(rig.announcedTitle(0), u"盘前联动:数据中心 集体上涨"_s);
        QVERIFY(rig.announced.at(0).at(0).toJsonObject()[u"body"].toString().contains(u"开盘后涨幅大概率回吐"_s));

        // 10:05:中位从 +4.0% 掉到 +1.0%,算回吐,报一次
        rig.clock = kCpiAt + 95 * kMin;
        quality(1.5, 1.0, 0.5);
        rig.events.tick();
        QTRY_COMPARE(rig.announced.size(), 2);
        QCOMPARE(rig.announcedTitle(1), u"数据中心:盘前涨幅已回吐"_s);
        QCOMPARE(rig.announced.at(1).at(0).toJsonObject()[u"body"].toString().startsWith(u"开盘前中位 +4.0%,现在 +1.0%。"_s), true);
        rig.clock += 60'000;
        const int sweeps = rig.calls(u"quality.list"_s);
        rig.events.tick();
        QTRY_COMPARE(rig.calls(u"quality.list"_s), sweeps + 1);
        QTest::qWait(100);
        QCOMPARE(rig.announced.size(), 2);
    }

    void sessionMarksFireOncePerDay() {
        Rig rig(list(QJsonArray{}), u"{\"broker_connected\":false,\"market_status\":\"盘前\"}"_s);
        rig.status.refresh();
        QTRY_COMPARE(rig.status.engineOk(), 1);
        rig.clock = kCpiAt - 330 * kMin + 10'000;  // 美东 03:00:10 = 伦敦 08:00:10
        rig.loadNow();
        rig.events.tick();
        QCOMPARE(rig.announced.size(), 1);
        QCOMPARE(rig.announcedTitle(0), u"欧盘开盘"_s);
        QVERIFY(rig.announced.at(0).at(0).toJsonObject()[u"body"].toString().startsWith(u"美东 03:00 · 北京 15:00 · "_s));
        rig.clock += 15'000;
        rig.events.tick();
        QCOMPARE(rig.announced.size(), 1);
        rig.clock = kCpiAt + 55 * kMin + 5'000;  // 美东 09:25:05
        rig.events.tick();
        QCOMPARE(rig.announced.size(), 2);
        QCOMPARE(rig.announcedTitle(1), u"美股 5 分钟后开盘"_s);
        QCOMPARE(rig.announced.at(1).at(0).toJsonObject()[u"id"].toString(), u"event:session:us_pre_open:2026-10-14"_s);
    }

    void sessionMarksNeedOpenMarketAndSwitch() {
        Rig closed(list(QJsonArray{}), u"{\"broker_connected\":false,\"market_status\":\"休市\"}"_s);
        closed.status.refresh();
        QTRY_COMPARE(closed.status.engineOk(), 1);
        closed.clock = kCpiAt + 55 * kMin + 5'000;
        closed.loadNow();
        closed.events.tick();
        QCOMPARE(closed.announced.size(), 0);  // 美股的钟点,美股不开不报

        Rig off(list(QJsonArray{}, QJsonValue(), false), u"{\"broker_connected\":false,\"market_status\":\"盘前\"}"_s);
        off.status.refresh();
        QTRY_COMPARE(off.status.engineOk(), 1);
        off.clock = kCpiAt - 330 * kMin + 10'000;
        off.loadNow();
        off.events.tick();
        QCOMPARE(off.announced.size(), 0);  // 总开关关了
    }

    void addCustomTrimsAndReloads() {
        Rig rig(list(standard()));
        QSignalSpy done(&rig.events, &shell::EventsStore::customDone);
        rig.events.addCustom(u"CRWV 发债"_s, u" 2026-10-16 "_s, u"11:30 "_s, u"  看数据中心 "_s);
        QTRY_COMPARE(done.size(), 1);
        QCOMPARE(done.at(0).at(0).toString(), QString());
        QVERIFY2(rig.logs.contains(u"[fake] events.add {\"date_et\":\"2026-10-16\",\"note\":\"看数据中心\",\"time_et\":\"11:30\",\"title\":\"CRWV 发债\"}"_s),
                 qPrintable(rig.logs.join(u'\n')));
        QTRY_VERIFY(rig.calls(u"events.list"_s) >= 1);
        rig.set(u"events.remove"_s, obj(R"({"__error":"没有这条"})"));
        rig.events.removeCustom(u"custom:1"_s);
        QTRY_COMPARE(done.size(), 2);
        QCOMPARE(done.at(1).at(0).toString(), u"没有这条"_s);
    }

    void listFailureIsReported() {
        Rig rig(obj(R"({"__error":"引擎忙"})"));
        rig.loadNow();
        QTRY_VERIFY(rig.events.all()[u"status"].toString().contains(u"清单没拉到:引擎忙"_s));
        QVERIFY(rig.events.strip().value("hidden"_L1).toBool());
    }
};

QTEST_GUILESS_MAIN(TestEventsStore)
#include "tst_events_store.moc"
