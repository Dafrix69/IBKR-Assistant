// 行情页的接线(shell/market_controller,照 pages/Market.tsx + lib/PaPanel.tsx + lib/BookWall.tsx):对着假引擎。
//   · 挂上:取周期表,标的 / 周期 / 只看正常时段 / 关注表从 ini 读回来;没填标的点「分析」只说一句、不发请求;
//   · 分析:pa.analyze 带 force、标的去空白转大写、记进 ini;结果进模型与图;图出来跟着读那只的盘口;
//   · 已连券商时按节拍刷(不 force),上一轮没回来就跳过;换了标的丢掉 AI 解读;出错清掉结果;
//   · 关注表:去空白转大写、重复的不再加、最多 12 只;全部刷新逐只取、正在看的那只排最前;
//   · 卸下:节拍停、状态清空,卸下之前发出去的请求回来也不算数。
#include "shell/bridge.h"
#include "shell/chart_source.h"
#include "shell/consent.h"
#include "shell/engine_command.h"
#include "shell/market_controller.h"
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

const char* kPa = R"({"symbol":"NVDA","timeframe":"5m","timeframe_label":"5 分钟","bar_count":3,"last_bar":"2026-08-14 09:40","closed_bar":"2026-08-14 09:40",
  "forming":null,"last":125.4,"score":12,"bias":"lean_bull","bias_label":"偏多","confidence":0.4,"trend_label":"上升结构","rth":false,
  "bars":[{"time":"2026-08-14 09:30","open":124,"high":125,"low":123.5,"close":124.8,"volume":1000},
          {"time":"2026-08-14 09:35","open":124.8,"high":125.6,"low":124.5,"close":125.1,"volume":900},
          {"time":"2026-08-14 09:40","open":125.1,"high":125.7,"low":125,"close":125.4,"volume":800}],
  "ma":{"5":[null,null,124.9]},"readout":["NVDA 5 分钟:偏多。"],"evidence":[],"sub_scores":[],"warnings":[]})";
const char* kBook = R"({"symbol":"X","l1":{"bid":1,"ask":1.01,"bid_size":3,"ask_size":4,"last":1,"spread":0.01,"spread_bps":100},
  "bids":[],"asks":[],"note":"","liquidity":{"spread_grade":"差","bid_depth":null,"ask_depth":null,"imbalance_pct":null}})";

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
    QJsonObject results;

    explicit Rig(const QString& delays = {}, bool connected = true)
        : engine(fakeEngine({{u"FAKE_STATUS"_s, connected ? u"{\"broker_connected\":true}"_s : u"{\"broker_connected\":false}"_s}, {u"FAKE_LOG_PARAMS"_s, u"1"_s},
                             {u"FAKE_RESULTS_FILE"_s, resultsPath}, {u"FAKE_DELAY_METHODS"_s, delays}}),
                 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        set(u"pa.timeframes"_s, obj(R"({"timeframes":[{"key":"1m","label":"1 分钟"},{"key":"5m","label":"5 分钟"},{"key":"1h","label":"1 小时"}]})"));
        set(u"pa.analyze"_s, obj(kPa));
        set(u"book.snapshot"_s, obj(kBook));
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

QString state(const shell::MarketController& c) { return c.page()[u"result"_s][u"state"_s].toString(); }

}  // namespace

class TestMarketController : public QObject {
    Q_OBJECT
private slots:
    void analyzeAndPersist() {
        Rig rig;
        shell::MarketController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        QTRY_COMPARE(page.page()[u"timeframes"_s].toArray().size(), 3);
        QCOMPARE(page.page()[u"tfLabel"_s].toString(), u"5 分钟"_s);
        // 没填标的:只说一句
        page.analyze();
        QCOMPARE(rig.status.banner(), u"先填一个标的代码"_s);
        QTest::qWait(50);
        QCOMPARE(rig.calls(u"pa.analyze"_s), 0);

        page.setSymbolText(u"  nvda "_s);
        page.analyze();
        QTRY_COMPARE(state(page), u"ok"_s);
        QCOMPARE(rig.params(u"pa.analyze"_s).first(), u"{\"force\":true,\"rth\":false,\"symbol\":\"NVDA\",\"timeframe\":\"5m\"}"_s);
        QCOMPARE(page.page()[u"symbol"_s].toString(), u"NVDA"_s);
        QCOMPARE(page.page()[u"pa"_s][u"verdict"_s][u"title"_s].toString(), u"NVDA 5 分钟 · 偏多"_s);
        auto* chart = qobject_cast<shell::ChartSource*>(page.chart());
        QCOMPARE(chart->spec().bars.size(), 3);
        QVERIFY(bool(chart->spec().header));
        // 图出来了跟着读它的盘口
        QTRY_COMPARE(rig.params(u"book.snapshot"_s), QStringList{u"{\"symbol\":\"NVDA\"}"_s});
        QTRY_COMPARE(page.page()[u"pa"_s][u"book"_s][u"body"_s][u"kind"_s].toString(), u"ok"_s);

        // 换周期:立刻再分析,记进 ini
        page.setTimeframe(u"1h"_s);
        QTRY_COMPARE(rig.calls(u"pa.analyze"_s), 2);
        QCOMPARE(rig.params(u"pa.analyze"_s).last(), u"{\"force\":true,\"rth\":false,\"symbol\":\"NVDA\",\"timeframe\":\"1h\"}"_s);
        page.setRth(true);
        QTRY_COMPARE(rig.calls(u"pa.analyze"_s), 3);
        QCOMPARE(rig.params(u"pa.analyze"_s).last(), u"{\"force\":true,\"rth\":true,\"symbol\":\"NVDA\",\"timeframe\":\"1h\"}"_s);
        {
            const QSettings s(rig.ini, QSettings::IniFormat);
            QCOMPARE(s.value(u"market/symbol"_s).toString(), u"NVDA"_s);
            QCOMPARE(s.value(u"market/timeframe"_s).toString(), u"1h"_s);
            QCOMPARE(s.value(u"market/rth"_s).toString(), u"1"_s);
        }
        // 卸下再挂上:读回来的是记着的,结果是空的(原版组件重新挂上)
        page.setVisible(false);
        QCOMPARE(state(page), u"empty"_s);
        page.setVisible(true);
        QCOMPARE(page.page()[u"symbol"_s].toString(), u"NVDA"_s);
        QCOMPARE(page.page()[u"timeframe"_s].toString(), u"1h"_s);
        QCOMPARE(page.page()[u"rth"_s].toBool(), true);
        QCOMPARE(state(page), u"empty"_s);
    }

    void pollsWhenConnectedAndSkipsInFlight() {
        Rig rig(u"pa.analyze=300"_s);
        shell::MarketController page(&rig.bridge, &rig.status, rig.ini);
        page.refreshMs = 60;
        page.setVisible(true);
        page.setSymbolText(u"NVDA"_s);
        page.analyze();
        QTRY_COMPARE(state(page), u"ok"_s);
        // 300 毫秒一次的回包、60 毫秒一轮的节拍:在途时跳过,不叠请求
        QTest::qWait(700);
        const QStringList p = rig.params(u"pa.analyze"_s);
        QVERIFY2(p.size() >= 2 && p.size() <= 4, qPrintable(QString::number(p.size())));
        QVERIFY(p.last().contains(u"\"force\":false"_s));
        page.setVisible(false);
        const int n = rig.calls(u"pa.analyze"_s);
        QTest::qWait(400);
        QCOMPARE(rig.calls(u"pa.analyze"_s), n);
        // 卸下之前发出去的那一次回来了也不算数
        QCOMPARE(state(page), u"empty"_s);
    }

    void noPollWhenDisconnected() {
        Rig rig({}, false);
        shell::MarketController page(&rig.bridge, &rig.status, rig.ini);
        page.refreshMs = 50;
        page.setVisible(true);
        page.setSymbolText(u"NVDA"_s);
        page.analyze();
        QTRY_COMPARE(state(page), u"ok"_s);
        QTest::qWait(300);
        QCOMPARE(rig.calls(u"pa.analyze"_s), 1);
    }

    void commentAndErrors() {
        Rig rig;
        rig.set(u"pa.comment"_s, QJsonObject{{u"analysis"_s, obj(kPa)}, {u"model"_s, u"m1"_s},
                                            {u"comment"_s, obj(R"({"summary":"区间","reading":"","watch":["a"],"risks":[]})")}});
        shell::MarketController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        page.setSymbolText(u"nvda"_s);
        page.analyze();
        QTRY_COMPARE(state(page), u"ok"_s);
        page.comment();
        QCOMPARE(page.page()[u"pa"_s][u"ai"_s][u"button"_s].toString(), u"解读中…"_s);
        QTRY_COMPARE(page.page()[u"pa"_s][u"ai"_s][u"comment"_s][u"meta"_s].toString(), u"模型 m1 · 仅供研究参考,不构成投资建议"_s);
        QCOMPARE(rig.params(u"pa.comment"_s).first(), u"{\"force\":false,\"rth\":false,\"symbol\":\"NVDA\",\"timeframe\":\"5m\"}"_s);
        // 再点「分析」:解读先清掉(原版 run 里的 setComment(null)),哪怕标的与周期没变
        page.analyze();
        QTRY_COMPARE(rig.calls(u"pa.analyze"_s), 2);
        QTRY_VERIFY(page.page()[u"pa"_s][u"ai"_s][u"comment"_s].isNull());
        // 解读失败:横幅,前缀只一次
        rig.set(u"pa.comment"_s, QJsonObject{{u"__error"_s, u"AI 解读失败:没有配模型"_s}});
        page.comment();
        QTRY_COMPARE(rig.status.banner(), u"AI 解读失败:没有配模型"_s);
        // 分析出错:结果清掉,写那一句
        rig.set(u"pa.analyze"_s, QJsonObject{{u"__error"_s, u"K 线读取失败:没有行情权限"_s}});
        page.analyze();
        QTRY_COMPARE(state(page), u"error"_s);
        QCOMPARE(page.page()[u"result"_s][u"text"_s].toString(), u"K 线读取失败:没有行情权限"_s);
        QVERIFY(qobject_cast<shell::ChartSource*>(page.chart())->spec().bars.isEmpty());
    }

    // 换周期:上一次的 AI 解读丢掉(回来的是另一个周期的结果,免得张冠李戴)
    void timeframeSwitchDropsComment() {
        Rig rig(u"pa.analyze=80"_s);
        rig.set(u"pa.comment"_s, QJsonObject{{u"analysis"_s, obj(kPa)}, {u"model"_s, u"m1"_s}, {u"comment"_s, obj(R"({"summary":"区间","watch":[],"risks":[]})")}});
        shell::MarketController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        page.setSymbolText(u"NVDA"_s);
        page.analyze();
        QTRY_COMPARE(state(page), u"ok"_s);
        page.comment();
        QTRY_VERIFY(page.page()[u"pa"_s][u"ai"_s][u"comment"_s].isObject());
        // 引擎回的是 1h 的那一份
        QJsonObject h1 = obj(kPa);
        h1[u"timeframe"_s] = u"1h"_s;
        rig.set(u"pa.analyze"_s, h1);
        page.setTimeframe(u"1h"_s);
        QTRY_COMPARE(rig.calls(u"pa.analyze"_s), 2);
        QTRY_VERIFY(!page.page()[u"loading"_s].toBool());
        QVERIFY(page.page()[u"pa"_s][u"ai"_s][u"comment"_s].isNull());
        // 同一个周期的自动刷新(不经「分析」)不丢:先拿到一份解读,再让节拍刷一次
        page.comment();
        QTRY_VERIFY(page.page()[u"pa"_s][u"ai"_s][u"comment"_s].isObject());
    }

    // 解读还在路上就换了周期:解读先回来(带着旧周期的结果)、新周期的取数后回来——回来时周期变了,那份解读丢掉
    void staleCommentDroppedWhenTimeframeChanged() {
        Rig rig(u"pa.analyze=200,pa.comment=40"_s);
        rig.set(u"pa.comment"_s, QJsonObject{{u"analysis"_s, obj(kPa)}, {u"model"_s, u"m1"_s}, {u"comment"_s, obj(R"({"summary":"旧周期","watch":[],"risks":[]})")}});
        shell::MarketController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        page.setSymbolText(u"NVDA"_s);
        page.analyze();
        QTRY_COMPARE(state(page), u"ok"_s);
        QJsonObject h1 = obj(kPa);
        h1[u"timeframe"_s] = u"1h"_s;
        rig.set(u"pa.analyze"_s, h1);
        page.comment();
        page.setTimeframe(u"1h"_s);
        QTRY_VERIFY(page.page()[u"pa"_s][u"ai"_s][u"comment"_s].isObject());
        QTRY_VERIFY(!page.page()[u"loading"_s].toBool());
        QVERIFY(page.page()[u"pa"_s][u"ai"_s][u"comment"_s].isNull());
    }

    // 离开页面之前发出去的取数,回来时才到:不算数(原版组件卸载后 setState 不生效)
    void staleReplyAfterLeaveIsDropped() {
        Rig rig(u"pa.analyze=250,book.snapshot=250"_s);
        shell::MarketController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        page.setSymbolText(u"NVDA"_s);
        page.analyze();
        QTest::qWait(30);
        page.setVisible(false);
        page.setVisible(true);
        QTest::qWait(400);
        QCOMPARE(rig.calls(u"pa.analyze"_s), 1);
        QCOMPARE(state(page), u"empty"_s);
        QVERIFY(qobject_cast<shell::ChartSource*>(page.chart())->spec().bars.isEmpty());
        QCOMPARE(page.page()[u"loading"_s].toBool(), false);
    }

    void bookWall() {
        Rig rig(u"book.snapshot=60"_s);
        shell::MarketController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        QVERIFY(page.page()[u"books"_s][u"refreshAllDisabled"_s].toBool());
        QVERIFY(page.page()[u"books"_s][u"primerOpen"_s].toBool());
        QVERIFY(!page.addBook(u"  "_s));
        QVERIFY(page.addBook(u" spy "_s));
        QTRY_COMPARE(page.page()[u"books"_s][u"cards"_s][0][u"body"_s][u"kind"_s].toString(), u"ok"_s);
        QVERIFY(page.addBook(u"SPY"_s));
        QTest::qWait(150);
        QCOMPARE(rig.calls(u"book.snapshot"_s), 1);
        for (int i = 0; i < 11; ++i) QVERIFY(page.addBook(u"S%1"_s.arg(i)));
        QVERIFY(!page.addBook(u"ONE_MORE"_s));
        QCOMPARE(rig.status.banner(), u"盘口最多同时关注 12 个标的"_s);
        QCOMPARE(page.page()[u"books"_s][u"count"_s].toInt(), 12);
        QCOMPARE(QSettings(rig.ini, QSettings::IniFormat).value(u"market/books"_s).toString().left(14), u"[\"SPY\",\"S0\",\"S"_s);
        QTRY_COMPARE(rig.calls(u"book.snapshot"_s), 12);
        for (int i = 0; i < 11; ++i) page.removeBook(u"S%1"_s.arg(i));
        QCOMPARE(page.page()[u"books"_s][u"count"_s].toInt(), 1);
        page.addBook(u"QQQ"_s);
        QTRY_COMPARE(rig.calls(u"book.snapshot"_s), 13);

        // 全部刷新:正在看的那只排最前,逐只取(一只回来才取下一只)
        page.pick(u"nvda"_s);
        QTRY_COMPARE(rig.params(u"book.snapshot"_s).last(), u"{\"symbol\":\"NVDA\"}"_s);
        QTRY_VERIFY(!page.page()[u"pa"_s][u"book"_s][u"loading"_s].toBool());
        rig.logs.clear();
        page.refreshAllBooks();
        QTRY_COMPARE(rig.params(u"book.snapshot"_s), (QStringList{u"{\"symbol\":\"NVDA\"}"_s, u"{\"symbol\":\"SPY\"}"_s, u"{\"symbol\":\"QQQ\"}"_s}));
        // 正在看的那只从关注里移掉:上面那张盘口还在用这份快照
        page.addBook(u"NVDA"_s);
        page.removeBook(u"NVDA"_s);
        QCOMPARE(page.page()[u"pa"_s][u"book"_s][u"body"_s][u"kind"_s].toString(), u"ok"_s);
        QVERIFY(!page.page()[u"pa"_s][u"book"_s][u"followed"_s].toBool());
    }

    void pickScrollsAndAnalyzes() {
        Rig rig;
        shell::MarketController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        QSignalSpy top(&page, &shell::MarketController::scrollTop);
        page.pick(u" tsla"_s);
        QCOMPARE(top.count(), 1);
        QCOMPARE(page.page()[u"symbol"_s].toString(), u"TSLA"_s);
        QTRY_COMPARE(rig.calls(u"pa.analyze"_s), 1);
        QVERIFY(rig.params(u"pa.analyze"_s).first().contains(u"\"symbol\":\"TSLA\""_s));
    }
};

QTEST_GUILESS_MAIN(TestMarketController)
#include "tst_market_controller.moc"
