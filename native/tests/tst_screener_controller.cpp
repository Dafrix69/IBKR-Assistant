// 扫描页的接线(shell/screener_controller,照 pages/Screener.tsx 的 useScan、lib/DeviationSection、lib/LeadersSection):对着假引擎。
//   · 扫描先 RS 后背离、不并发;背离没回来时那几列占住;出结果后顺手复盘榜首那只,人已经点过就不抢;不选周期就只算 RS;
//   · 两步同一个原因的报错只说一遍;
//   · 极值偏离:连着点只认最后一次;失败清掉上一只的数;上一只 / 下一只按表的次序绕圈;
//   · 表头排序:没排 → 降 → 升 → 没排;股票池记在本机;卸下清空。
#include "shell/alerts_store.h"
#include "shell/bridge.h"
#include "shell/chart_source.h"
#include "shell/consent.h"
#include "shell/engine_command.h"
#include "shell/feed_stores.h"
#include "shell/keyed_list_model.h"
#include "shell/screener_controller.h"
#include "shell/sectors_store.h"
#include "shell/status_store.h"
#include "shell_harness.h"

#include <QJsonArray>
#include <QSettings>
#include <QSignalSpy>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

QJsonObject obj(const char* t) { return QJsonDocument::fromJson(t).object(); }

const char* kSectors = R"({"sectors":[{"id":"s1","name":"AI","stocks":[{"symbol":"NVDA"},{"symbol":"AMD"}]},{"id":"s2","name":"核电","stocks":[{"symbol":"CEG"}]}]})";
const char* kRs = R"({"sector":"AI","benchmark":"SPY","bench_last":645.2,"counted":2,"total":2,"fetched_at":"2026-09-08T14:00:00Z","windows":[{"n":5,"label":"1周"}],
  "rows":[{"symbol":"NVDA","tag":"芯片","last":219.74,"bars":290,"rank":1,"score":18.4,"error":null,"rs":{"5":{"ret_pct":3.1,"bench_pct":0.8,"rs_pct":2.28}}},
          {"symbol":"AMD","tag":"芯片","last":242.1,"bars":290,"rank":2,"score":-9.5,"error":null,"rs":{"5":{"ret_pct":-8,"bench_pct":0.8,"rs_pct":-8.73}}}],"tags":[]})";
const char* kInfl = R"({"sector":"AI","timeframes":["1w","1d"],"ma_period":20,"hit_count":0,"total":2,"fetched_at":"2026-09-08T14:00:00Z","per_timeframe":{},"rows":[]})";
const char* kDev = R"({"symbol":"NVDA","timeframe":"1d","period":20,"lookback":120,"z_extreme":2,"bars":290,"fetched_at":"2026-09-08T14:00:00Z",
  "series":[{"time":"2026-09-07","z":1,"pressure":0.1,"buy_pct":50},{"time":"2026-09-08","z":2.3,"pressure":-0.4,"buy_pct":22}],
  "last":{"time":"2026-09-08","dev_pct":7.16,"z":2.31,"rank_pct":98,"pressure":-0.412,"buy_pct":22,"volume_ratio":1.5},"extreme":"overbought","extreme_label":"上方极值","readout":["a"],"window":null})";

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
    shell::SectorsStore sectors{&bridge, &status, nullptr, nullptr};
    QJsonObject results;

    explicit Rig(const QString& delays = {})
        : engine(fakeEngine({{u"FAKE_LOG_PARAMS"_s, u"1"_s}, {u"FAKE_RESULTS_FILE"_s, resultsPath}, {u"FAKE_DELAY_METHODS"_s, delays}}), 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        set(u"sectors.list"_s, obj(kSectors));
        set(u"screener.rs"_s, obj(kRs));
        set(u"screener.inflection"_s, obj(kInfl));
        set(u"screener.deviation"_s, obj(kDev));
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
    int indexOf(const QString& method) const {
        for (int i = 0; i < logs.size(); ++i)
            if (logs[i].startsWith(u"[fake] "_s + method + u' ')) return i;
        return -1;
    }
};

}  // namespace

class TestScreenerController : public QObject {
    Q_OBJECT
private slots:
    void scanThenDeviation() {
        Rig rig(u"screener.rs=80"_s);
        shell::ScreenerController page(&rig.bridge, &rig.sectors, &rig.status, rig.ini);
        page.setVisible(true);
        QTRY_COMPARE(page.page()[u"sectorOptions"_s].toArray().size(), 3);
        page.setSector(u"s1"_s);
        QCOMPARE(QSettings(rig.ini, QSettings::IniFormat).value(u"screener/sector"_s).toString(), u"s1"_s);
        page.run();
        QVERIFY(page.page()[u"busy"_s].toBool());
        QCOMPARE(page.page()[u"progress"_s].toString(), u"正在拉日线算 RS…(一个 30 只的板块约 10~30 秒)"_s);
        QTRY_VERIFY(!page.page()[u"busy"_s].toBool());
        // 先 RS 后背离
        QVERIFY(rig.indexOf(u"screener.rs"_s) < rig.indexOf(u"screener.inflection"_s));
        QCOMPARE(rig.params(u"screener.rs"_s).first(), u"{\"benchmark\":\"SPY\",\"sector\":\"s1\"}"_s);
        QCOMPARE(rig.params(u"screener.inflection"_s).first(), u"{\"ma_period\":20,\"sector\":\"s1\",\"timeframes\":[\"1w\",\"1d\"]}"_s);
        // 顺手复盘榜首
        QTRY_COMPARE(page.page()[u"dev"_s][u"symbol"_s].toString(), u"NVDA"_s);
        QCOMPARE(rig.params(u"screener.deviation"_s).first(), u"{\"lookback\":120,\"period\":20,\"symbol\":\"NVDA\",\"timeframe\":\"1d\"}"_s);
        QCOMPARE(qobject_cast<shell::ChartSource*>(page.devChart())->spec().lines.size(), 1);
        // 人点过了:再扫不抢
        page.review(u"amd"_s);
        QTRY_COMPARE(rig.calls(u"screener.deviation"_s), 2);
        page.run();
        QTRY_COMPARE(rig.calls(u"screener.rs"_s), 2);
        QTRY_VERIFY(!page.page()[u"busy"_s].toBool());
        QTest::qWait(60);
        QCOMPARE(rig.calls(u"screener.deviation"_s), 2);
        // 不选周期:只算 RS;MA 0 发 null
        page.toggleTimeframe(u"1w"_s, false);
        page.toggleTimeframe(u"1d"_s, false);
        page.run();
        QTRY_COMPARE(rig.calls(u"screener.rs"_s), 3);
        QTRY_VERIFY(!page.page()[u"busy"_s].toBool());
        QCOMPARE(rig.calls(u"screener.inflection"_s), 2);
        page.toggleTimeframe(u"1h"_s, true);
        page.setMa(0);
        page.run();
        QTRY_COMPARE(rig.calls(u"screener.inflection"_s), 3);
        QCOMPARE(rig.params(u"screener.inflection"_s).last(), u"{\"ma_period\":null,\"sector\":\"s1\",\"timeframes\":[\"1h\"]}"_s);
    }

    void errorsSaidOnce() {
        Rig rig;
        rig.set(u"screener.rs"_s, QJsonObject{{u"__error"_s, u"股票池是空的"_s}});
        rig.set(u"screener.inflection"_s, QJsonObject{{u"__error"_s, u"股票池是空的"_s}});
        shell::ScreenerController page(&rig.bridge, &rig.sectors, &rig.status, rig.ini);
        page.setVisible(true);
        page.run();
        QTRY_VERIFY(!page.page()[u"busy"_s].toBool());
        QCOMPARE(rig.status.banner(), u"扫描失败:股票池是空的"_s);
    }

    void deviationLastWinsAndSteps() {
        Rig rig(u"screener.deviation=120"_s);
        shell::ScreenerController page(&rig.bridge, &rig.sectors, &rig.status, rig.ini);
        page.setVisible(true);
        QTRY_COMPARE(page.page()[u"order"_s].toArray().size(), 3);
        page.review(u"NVDA"_s);
        rig.set(u"screener.deviation"_s, QJsonObject{{u"__error"_s, u"没有行情权限"_s}});
        page.review(u"AMD"_s);
        QTRY_VERIFY(!page.page()[u"dev"_s][u"busy"_s].toBool());
        QTest::qWait(200);
        // 只认 AMD 那一次(失败):NVDA 的结果到了也不落地
        QCOMPARE(page.page()[u"dev"_s][u"state"_s].toString(), u"empty"_s);
        QCOMPARE(rig.status.banner(), u"极值偏离失败:没有行情权限"_s);
        // 上一只 / 下一只:按池子的次序绕圈(AMD 是第 2 只)
        rig.set(u"screener.deviation"_s, obj(kDev));
        page.step(1);
        QTRY_COMPARE(page.page()[u"dev"_s][u"current"_s].toString(), u"CEG"_s);
        page.step(1);
        QTRY_COMPARE(page.page()[u"dev"_s][u"current"_s].toString(), u"NVDA"_s);
        page.step(-1);
        QTRY_COMPARE(page.page()[u"dev"_s][u"current"_s].toString(), u"CEG"_s);
        // 手输优先
        page.setFree(u" tsla "_s);
        page.reviewCurrent();
        QTRY_COMPARE(page.page()[u"dev"_s][u"current"_s].toString(), u"TSLA"_s);
    }

    // 点表里的一行:复盘它并让页面滚过去(原版 drill);下拉选、扫描完自动复盘都不滚。表的行按代码原地更新:点一行不换掉别的行
    void drillReveals() {
        Rig rig;
        shell::ScreenerController page(&rig.bridge, &rig.sectors, &rig.status, rig.ini);
        QSignalSpy reveal(&page, &shell::ScreenerController::revealDeviation);
        page.setVisible(true);
        page.run();
        QTRY_VERIFY(!page.page()[u"busy"_s].toBool());
        QTRY_COMPARE(rig.calls(u"screener.deviation"_s), 1);
        QCOMPARE(reveal.size(), 0);
        auto* rows = qobject_cast<shell::KeyedListModel*>(page.rows());
        QVERIFY(rows);
        QCOMPARE(rows->count(), 2);
        QSignalSpy reset(rows, &QAbstractItemModel::modelReset), removed(rows, &QAbstractItemModel::rowsRemoved);
        page.drill(u"AMD"_s);
        QCOMPARE(reveal.size(), 1);
        QTRY_COMPARE(rig.calls(u"screener.deviation"_s), 2);
        QCOMPARE(rig.params(u"screener.deviation"_s).last(), u"{\"lookback\":120,\"period\":20,\"symbol\":\"AMD\",\"timeframe\":\"1d\"}"_s);
        QCOMPARE(reset.size() + removed.size(), 0);
        QVERIFY(rows->items()[1][u"open"_s].toBool());
        page.review(u"NVDA"_s);
        QCOMPARE(reveal.size(), 1);
    }

    // 横幅:每种失败照原版说哪几句(同一个原因只说一遍;只算 RS 时失败说「扫描失败」)
    void bannersByCase() {
        struct Case {
            const char* name;
            QJsonValue rs, infl;
            bool noTimeframes;
            QStringList want;
        };
        const QJsonValue err1 = QJsonObject{{u"__error"_s, u"原因甲"_s}}, err2 = QJsonObject{{u"__error"_s, u"原因乙"_s}};
        const QList<Case> cases{
            {"同一个原因", err1, err1, false, {u"扫描失败:原因甲"_s}},
            {"两个原因", err1, err2, false, {u"RS 强度没算出来:原因甲"_s, u"扫描失败:原因乙"_s}},
            {"只有 RS 失败", err1, obj(kInfl), false, {u"RS 强度没算出来:原因甲"_s}},
            {"只有背离失败", obj(kRs), err2, false, {u"背离没找成:原因乙"_s}},
            {"只算 RS 时失败", err1, obj(kInfl), true, {u"扫描失败:原因甲"_s}},
        };
        for (const Case& c : cases) {
            Rig rig;
            rig.set(u"screener.rs"_s, c.rs);
            rig.set(u"screener.inflection"_s, c.infl);
            QStringList banners;
            QObject::connect(&rig.status, &shell::StatusStore::bannerChanged, [&] { if (!rig.status.banner().isEmpty()) banners << rig.status.banner(); });
            shell::ScreenerController page(&rig.bridge, &rig.sectors, &rig.status, rig.ini);
            page.setVisible(true);
            if (c.noTimeframes) {
                page.toggleTimeframe(u"1w"_s, false);
                page.toggleTimeframe(u"1d"_s, false);
            }
            page.run();
            QTRY_VERIFY(!page.page()[u"busy"_s].toBool());
            QTest::qWait(60);
            QVERIFY2(banners == c.want, qPrintable(QString::fromUtf8(c.name) + u": "_s + banners.join(u" | "_s)));
            if (c.noTimeframes) QCOMPARE(rig.calls(u"screener.inflection"_s), 0);
        }
    }

    // 背离还没回来:表里那几列先占住,格子是「…」;RS 没有一行时,复盘背离那边的榜首
    void pendingColumnsAndInflectionFallback() {
        Rig rig(u"screener.inflection=300"_s);
        rig.set(u"screener.rs"_s, obj(R"({"sector":"AI","benchmark":"SPY","bench_last":645.2,"counted":0,"total":0,"fetched_at":"2026-09-08T14:00:00Z","windows":[{"n":5,"label":"1周"}],"rows":[],"tags":[]})"));
        rig.set(u"screener.inflection"_s, obj(R"({"sector":"AI","timeframes":["1w","1d"],"ma_period":20,"hit_count":1,"total":1,"fetched_at":"2026-09-08T14:00:00Z",
          "per_timeframe":{"1w":{"bull":1,"bear":0,"confirmed":0},"1d":{"bull":0,"bear":0,"confirmed":0}},
          "rows":[{"symbol":"CEG","tag":"电力","hits":1,"confirmed":0,"signals":{"1w":{"signal":"bull","label":"底背离","age":2,"bars":120,"pivots":[]},"1d":{"signal":null,"bars":120}}}]})"));
        shell::ScreenerController page(&rig.bridge, &rig.sectors, &rig.status, rig.ini);
        page.setVisible(true);
        page.run();
        QTRY_COMPARE(rig.calls(u"screener.inflection"_s), 1);
        QTRY_COMPARE(page.page()[u"progress"_s].toString(), u"正在找背离…"_s);
        // 只有背离那边的行(还在路上):表还没有行;列已经按周期占住
        QVERIFY(page.page()[u"busy"_s].toBool());
        QTRY_VERIFY(!page.page()[u"busy"_s].toBool());
        QTRY_COMPARE(rig.calls(u"screener.deviation"_s), 1);
        QCOMPARE(rig.params(u"screener.deviation"_s).first(), u"{\"lookback\":120,\"period\":20,\"symbol\":\"CEG\",\"timeframe\":\"1d\"}"_s);
    }

    void pendingCellsWhileInflectionRuns() {
        Rig rig(u"screener.inflection=300"_s);
        shell::ScreenerController page(&rig.bridge, &rig.sectors, &rig.status, rig.ini);
        page.setVisible(true);
        page.run();
        QTRY_COMPARE(rig.calls(u"screener.inflection"_s), 1);
        QTRY_VERIFY(page.page()[u"table"_s].isObject());
        const QJsonObject table = page.page()[u"table"_s].toObject();
        QStringList keys;
        for (const QJsonValue& c : table[u"columns"_s].toArray()) keys << c[u"key"_s].toString();
        QVERIFY2(keys.contains(u"tf:1w"_s) && keys.contains(u"tf:1d"_s) && keys.contains(u"hits"_s), qPrintable(keys.join(u',')));
        QCOMPARE(table[u"rows"_s][0][u"cells"_s][u"tf:1w"_s][u"text"_s].toString(), u"…"_s);
        QTRY_VERIFY(!page.page()[u"busy"_s].toBool());
    }

    // 扫着时再点「扫描」不另起一轮;周期按表的次序发(不按点的先后)
    void busyGuardAndTimeframeOrder() {
        Rig rig(u"screener.rs=150,screener.inflection=200"_s);
        shell::ScreenerController page(&rig.bridge, &rig.sectors, &rig.status, rig.ini);
        page.setVisible(true);
        page.toggleTimeframe(u"1w"_s, false);
        page.toggleTimeframe(u"1d"_s, false);
        page.toggleTimeframe(u"15m"_s, true);
        page.toggleTimeframe(u"1d"_s, true);
        page.toggleTimeframe(u"1w"_s, true);
        page.run();
        page.run();
        // 有日内周期:进度换成慢的那一句
        QTRY_COMPARE(page.page()[u"progress"_s].toString(), u"正在逐只拉 K 线找背离…日内周期受券商节流,可能要一两分钟"_s);
        QTRY_VERIFY(!page.page()[u"busy"_s].toBool());
        QCOMPARE(rig.calls(u"screener.rs"_s), 1);
        QCOMPARE(rig.calls(u"screener.inflection"_s), 1);
        QCOMPARE(rig.params(u"screener.inflection"_s).first(), u"{\"ma_period\":20,\"sector\":\"all\",\"timeframes\":[\"1w\",\"1d\",\"15m\"]}"_s);
    }

    // 极值偏离的回包乱序:先发的 NVDA 后到,落不了地;一只成了之后另一只失败,前一只的数清掉
    void deviationOutOfOrderAndFailureClears() {
        Rig rig;
        shell::ScreenerController page(&rig.bridge, &rig.sectors, &rig.status, rig.ini);
        page.setVisible(true);
        QJsonObject slow = obj(kDev);
        slow.insert(u"__delay_ms"_s, 300);
        rig.set(u"screener.deviation"_s, slow);
        page.review(u"NVDA"_s);
        QTRY_COMPARE(rig.calls(u"screener.deviation"_s), 1);  // 假引擎收到 NVDA 那一条(结果文件已读)再换
        QJsonObject fast = obj(kDev);
        fast.insert(u"symbol"_s, u"AMD"_s);
        fast.insert(u"__delay_ms"_s, 20);
        rig.set(u"screener.deviation"_s, fast);
        page.review(u"AMD"_s);
        QTRY_COMPARE(page.page()[u"dev"_s][u"symbol"_s].toString(), u"AMD"_s);
        QVERIFY(!page.page()[u"dev"_s][u"busy"_s].toBool());
        QTest::qWait(450);  // NVDA 的回包到了
        QCOMPARE(page.page()[u"dev"_s][u"symbol"_s].toString(), u"AMD"_s);
        QCOMPARE(page.page()[u"dev"_s][u"current"_s].toString(), u"AMD"_s);
        // AMD 成了;再复盘 CEG 失败:AMD 的数不能留在 CEG 名下
        QCOMPARE(page.page()[u"dev"_s][u"state"_s].toString(), u"ok"_s);
        rig.set(u"screener.deviation"_s, QJsonObject{{u"__error"_s, u"没有行情权限"_s}});
        page.review(u"CEG"_s);
        QTRY_COMPARE(rig.status.banner(), u"极值偏离失败:没有行情权限"_s);
        QCOMPARE(page.page()[u"dev"_s][u"state"_s].toString(), u"empty"_s);
        QVERIFY(!page.page()[u"dev"_s].toObject().contains(u"tiles"_s));
        QCOMPARE(page.page()[u"dev"_s][u"status"_s].toString(), u"第 3 / 3 只"_s);
    }

    // 扫着的时候切走:回来的 RS、强势股、偏离都不落地(页面已经清空),也不再接着找背离
    void lateRepliesAfterHide() {
        Rig rig(u"screener.rs=200,screener.leaders=200,screener.deviation=200"_s);
        rig.set(u"screener.leaders"_s, obj(R"({"benchmark":"SPY","sector":"全部板块","fetched_at":"2026-09-08T14:00:00Z","total":0,"stage2_count":0,"vcp_count":0,
          "market":{"state":"uptrend","label":"上升","text":"t","distribution_dates":[]},"rows":[],"notes":[]})"));
        shell::ScreenerController page(&rig.bridge, &rig.sectors, &rig.status, rig.ini);
        page.setVisible(true);
        page.run();
        page.runLeaders();
        page.review(u"NVDA"_s);
        QTRY_COMPARE(rig.calls(u"screener.rs"_s), 1);
        page.setVisible(false);
        page.setVisible(true);
        QTest::qWait(400);
        QCOMPARE(rig.calls(u"screener.inflection"_s), 0);
        QVERIFY(!page.page()[u"busy"_s].toBool());
        QVERIFY(!page.page()[u"hasRows"_s].toBool());
        QVERIFY(page.page()[u"leaders"_s][u"data"_s].isNull());
        QVERIFY(!page.page()[u"leaders"_s][u"busy"_s].toBool());
        QCOMPARE(page.page()[u"dev"_s][u"state"_s].toString(), u"empty"_s);
        QVERIFY(!page.page()[u"dev"_s][u"busy"_s].toBool());
        // 回来之后马上又复盘一只(序号又从 1 数):切走前那一只晚到的回包也不能顶上
        page.setVisible(false);
        page.setVisible(true);
        page.review(u"NVDA"_s);
        QTRY_COMPARE(rig.calls(u"screener.deviation"_s), 2);
        page.setVisible(false);
        page.setVisible(true);
        QJsonObject amd = obj(kDev);
        amd.insert(u"symbol"_s, u"AMD"_s);
        amd.insert(u"__delay_ms"_s, 600);
        rig.set(u"screener.deviation"_s, amd);
        page.review(u"AMD"_s);
        QTest::qWait(350);  // NVDA 的回包(200ms)已经到了
        QVERIFY(page.page()[u"dev"_s][u"busy"_s].toBool());
        QVERIFY(page.page()[u"dev"_s][u"symbol"_s].isUndefined());
        QTRY_COMPARE(page.page()[u"dev"_s][u"symbol"_s].toString(), u"AMD"_s);
    }

    void sortCycleAndReset() {
        Rig rig;
        shell::ScreenerController page(&rig.bridge, &rig.sectors, &rig.status, rig.ini);
        page.setVisible(true);
        page.run();
        QTRY_VERIFY(!page.page()[u"busy"_s].toBool());
        page.sortBy(u"w5"_s);
        QCOMPARE(page.page()[u"table"_s][u"rows"_s][0][u"symbol"_s].toString(), u"NVDA"_s);
        page.sortBy(u"w5"_s);
        QCOMPARE(page.page()[u"table"_s][u"rows"_s][0][u"symbol"_s].toString(), u"AMD"_s);
        page.sortBy(u"w5"_s);
        QCOMPARE(page.page()[u"table"_s][u"rows"_s][0][u"symbol"_s].toString(), u"NVDA"_s);
        rig.set(u"screener.leaders"_s, obj(R"({"benchmark":"SPY","sector":"全部板块","fetched_at":"2026-09-08T14:00:00Z","total":0,"stage2_count":0,"vcp_count":0,
          "market":{"state":"uptrend","label":"上升","text":"t","distribution_dates":[]},"rows":[],"notes":[]})"));
        page.runLeaders();
        QTRY_VERIFY(page.page()[u"leaders"_s][u"data"_s].isObject());
        QCOMPARE(rig.params(u"screener.leaders"_s).first(), u"{\"benchmark\":\"SPY\",\"sector\":\"all\"}"_s);
        page.setVisible(false);
        QVERIFY(!page.page()[u"hasRows"_s].toBool());
        QVERIFY(page.page()[u"leaders"_s][u"data"_s].isNull());
    }
};

QTEST_GUILESS_MAIN(TestScreenerController)
#include "tst_screener_controller.moc"
