// 交易分析页的接线(shell/review_controller,照 pages/Review.tsx、store/review.ts):对着假引擎。
//   · 进页读候选(最多 200 笔,附带本地的开关一变就重读),选中的那一笔还在就留着、不在退到第一笔;新鲜度只在是「读候选那句」时换;
//   · 筛了类型选中的不在里面:退到列表第一笔;选中、类型记在本机;EM 从本机读(空、0、认不出是自动);
//   · 分析:没选提示、不发;载荷(EM 空着不带);记下选中 / 周期 / EM;失败清掉上一次;三张图跟着结果换;读着点不动;
//   · 交易记录跳过来:默认列表没有就打开附带本地再读,然后分析;页面还没挂上时挂上再办;
//   · 切走清空,晚到的回包不落地。
#include "shell/bridge.h"
#include "shell/chart_source.h"
#include "shell/consent.h"
#include "shell/engine_command.h"
#include "shell/review_controller.h"
#include "shell/status_store.h"
#include "shell_harness.h"

#include <QJsonArray>
#include <QSettings>
#include <QTemporaryDir>

using namespace ibkr;
using namespace ibkr::test;
using namespace Qt::StringLiterals;

namespace {

QJsonObject obj(const char* t) { return QJsonDocument::fromJson(t).object(); }

const char* kCandidates = R"J({"synced":4,"ibkr_available":true,"fills_stored":8,"candidates":[
  {"id":"demo-fly","source":"ibkr","created_at":"2026-08-12T14:35:00+00:00","symbol":"SPX","expiry":"2026-08-12","right":"看跌","strikes":[7600,7615,7630],"action":"BUY","qty":1,"price":1.75},
  {"id":"stk:p9001","kind":"stock","source":"ibkr","created_at":"2026-08-12T14:22:00+00:00","status":"closed","symbol":"RKLB","side":"LONG","qty":150,"avg_entry":64.4,"avg_exit":67.35,"pnl":439.3}]})J";
const char* kLocal = R"J({"synced":null,"ibkr_available":true,"fills_stored":8,"candidates":[
  {"id":"demo-fly","source":"ibkr","created_at":"2026-08-12T14:35:00+00:00","symbol":"SPX","expiry":"2026-08-12","right":"看跌","strikes":[7600,7615,7630],"action":"BUY","qty":1,"price":1.75},
  {"id":"local-1","source":"local","created_at":"2026-08-11T15:02:00+00:00","symbol":"SPX","expiry":"2026-08-11","right":"看涨","strikes":[7550,7575,7600],"action":"BUY","qty":2,"price":2.4}]})J";
const char* kFly = R"J({"timeframe_label":"5 分钟","record_id":"demo-fly","series":{"timeframe":"5m","bars":[{"time":"2026-08-12 10:00","open":1,"high":2,"low":0.5,"close":1.5},{"time":"2026-08-12 10:05","open":1.5,"high":2,"low":1,"close":1.8},{"time":"2026-08-12 10:10","open":1.8,"high":2.1,"low":1.7,"close":2}],
  "levels":[{"kind":"center","price":1.5}],"markers":[]},"outcome":{"kind":"expired","pnl":-175},"profile":{"symbol":"SPX","lower":7600,"center":7615,"upper":7630,"right_label":"看跌","debit":1.75},
  "zone":{"known":false},"entry":{"time_et":"2026-08-12 10:36"},"stats":{"hold_bars":3},"findings":[],"notes":[]})J";
const char* kStock = R"J({"kind":"stock","timeframe_label":"5 分钟","record_id":"stk:p9001","series":{"timeframe":"5m","bars":[{"time":"2026-08-12 10:00","open":1,"high":2,"low":0.5,"close":1.5},{"time":"2026-08-12 10:05","open":1.5,"high":2,"low":1,"close":1.8}],"levels":[],"markers":[]},
  "outcome":{"kind":"closed","pnl":439.3},"profile":{"symbol":"RKLB","side":"LONG","side_label":"做多","qty":150,"entries":[],"exits":[]},"entry":{"time_et":"x"},"stats":{"hold_bars":2},"findings":[],"notes":[]})J";

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

    explicit Rig(const QString& delays = {})
        : engine(fakeEngine({{u"FAKE_LOG_PARAMS"_s, u"1"_s}, {u"FAKE_RESULTS_FILE"_s, resultsPath}, {u"FAKE_DELAY_METHODS"_s, delays}}), 40) {
        QObject::connect(&engine, &shell::EngineClient::logLine, [this](const QString& l) { logs.append(l); });
        set(u"review.candidates"_s, obj(kCandidates));
        set(u"review.analyze"_s, obj(kFly));
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
    QString setting(const QString& key) const { return QSettings(ini, QSettings::IniFormat).value(key).toString(); }
    void preset(const QString& key, const QString& value) {
        QSettings s(ini, QSettings::IniFormat);
        s.setValue(key, value);
    }
};

int specLines(QObject* chart) { return int(qobject_cast<shell::ChartSource*>(chart)->spec().bars.size()); }

}  // namespace

class TestReviewController : public QObject {
    Q_OBJECT
private slots:
    void loadsCandidatesAndKeepsSelection() {
        Rig rig;
        rig.preset(u"review/record"_s, u"stk:p9001"_s);
        shell::ReviewController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        QTRY_COMPARE(page.page()[u"options"_s].toArray().size(), 2);
        QCOMPARE(rig.params(u"review.candidates"_s).first(), u"{\"include_local\":false,\"limit\":200}"_s);
        QCOMPARE(page.page()[u"selected"_s].toString(), u"stk:p9001"_s);
        QCOMPARE(page.page()[u"freshness"_s].toString(), u"本次新增 4 笔成交 · 库内成交 8 笔"_s);
        QVERIFY(page.page()[u"emDisabled"_s].toBool());  // 选中的是股票:EM 用不到
        // 附带本地:重读;选中的那笔不在新列表里了,退到第一笔
        rig.set(u"review.candidates"_s, obj(kLocal));
        page.setIncludeLocal(true);
        QTRY_COMPARE(rig.calls(u"review.candidates"_s), 2);
        QCOMPARE(rig.params(u"review.candidates"_s).last(), u"{\"include_local\":true,\"limit\":200}"_s);
        QTRY_COMPARE(page.page()[u"selected"_s].toString(), u"demo-fly"_s);
        QCOMPARE(page.page()[u"freshness"_s].toString(), u"已连 TWS · 库内成交 8 笔"_s);
        // 同步成交:再读一次
        page.sync();
        QTRY_COMPARE(rig.calls(u"review.candidates"_s), 3);
        // 读不到:说一声,列表不动
        rig.set(u"review.candidates"_s, QJsonObject{{u"__error"_s, u"引擎没起来"_s}});
        page.sync();
        QTRY_COMPARE(rig.status.banner(), u"读取成交明细失败:引擎没起来"_s);
        QCOMPARE(page.page()[u"options"_s].toArray().size(), 2);
    }

    void kindFilterFallsBackAndPersists() {
        Rig rig;
        shell::ReviewController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        QTRY_COMPARE(page.page()[u"selected"_s].toString(), u"demo-fly"_s);
        page.setKind(u"stock"_s);
        QCOMPARE(page.page()[u"selected"_s].toString(), u"stk:p9001"_s);
        QCOMPARE(rig.setting(u"review/kind"_s), u"stock"_s);
        page.select(u"stk:p9001"_s);
        QCOMPARE(rig.setting(u"review/record"_s), u"stk:p9001"_s);
        // 筛出来一个都没有:选中的不动
        page.setKind(u"butterfly"_s);
        QCOMPARE(page.page()[u"selected"_s].toString(), u"demo-fly"_s);
        // 回来照读
        page.setVisible(false);
        page.setVisible(true);
        QCOMPARE(page.page()[u"kind"_s].toString(), u"butterfly"_s);
    }

    void analyzeSendsAndRemembers() {
        Rig rig(u"review.analyze=120"_s);
        rig.preset(u"review/em-manual"_s, u"abc"_s);
        shell::ReviewController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        QVERIFY(page.page()[u"em"_s].isNull());
        QTRY_COMPARE(page.page()[u"selected"_s].toString(), u"demo-fly"_s);
        page.setTimeframe(u"1h"_s);
        page.analyze();
        page.analyze();  // 读着点不动
        QVERIFY(page.page()[u"loading"_s].toBool());
        QTRY_VERIFY(!page.page()[u"loading"_s].toBool());
        QCOMPARE(rig.calls(u"review.analyze"_s), 1);
        QCOMPARE(rig.params(u"review.analyze"_s).first(), u"{\"exit\":{},\"id\":\"demo-fly\",\"timeframe\":\"1h\"}"_s);
        QCOMPARE(rig.setting(u"review/timeframe"_s), u"1h"_s);
        QCOMPARE(rig.setting(u"review/em-manual"_s), QString());
        QCOMPARE(page.page()[u"freshness"_s].toString(), u"5 分钟 · 3 根 · 已到期"_s);
        QCOMPARE(page.page()[u"result"_s][u"kind"_s].toString(), u"butterfly"_s);
        QCOMPARE(specLines(page.underlyingChart()), 3);
        QCOMPARE(specLines(page.stockChart()), 0);
        // 分析之后的新鲜度不被读候选冲掉
        page.sync();
        QTRY_COMPARE(rig.calls(u"review.candidates"_s), 2);
        QTest::qWait(60);
        QCOMPARE(page.page()[u"freshness"_s].toString(), u"5 分钟 · 3 根 · 已到期"_s);
        // EM 40:带上、记下
        page.setEm(40);
        rig.set(u"review.analyze"_s, obj(kStock));
        page.analyze();
        QTRY_COMPARE(rig.calls(u"review.analyze"_s), 2);
        QCOMPARE(rig.params(u"review.analyze"_s).last(), u"{\"exit\":{\"em\":40},\"id\":\"demo-fly\",\"timeframe\":\"1h\"}"_s);
        QCOMPARE(rig.setting(u"review/em-manual"_s), u"40"_s);
        QTRY_COMPARE(page.page()[u"result"_s][u"kind"_s].toString(), u"stock"_s);
        QCOMPARE(specLines(page.stockChart()), 2);
        QCOMPARE(specLines(page.underlyingChart()), 0);
        // 失败:上一次的结果与图清掉
        rig.set(u"review.analyze"_s, QJsonObject{{u"__error"_s, u"拉不到 K 线"_s}});
        page.analyze();
        QTRY_COMPARE(page.page()[u"error"_s].toString(), u"拉不到 K 线"_s);
        QVERIFY(page.page()[u"result"_s].isNull());
        QCOMPARE(specLines(page.stockChart()), 0);
        // 成了:报错那一句也清掉
        // 带止盈策略的蝶:蝶价图有了;再失败,三张图里的蝶价图也清掉
        QJsonObject planned = obj(kFly);
        planned[u"exit_plan"_s] = QJsonObject{{u"levels"_s, QJsonArray{}}, {u"simulation"_s, QJsonObject{{u"applicable"_s, false}}}};
        planned[u"fly_series"_s] = QJsonObject{{u"source"_s, u"ibkr"_s}, {u"bars"_s, QJsonArray{QJsonObject{{u"time"_s, u"2026-08-12 10:00"_s}, {u"mid"_s, 1.7}},
                                                                                               QJsonObject{{u"time"_s, u"2026-08-12 10:01"_s}, {u"mid"_s, 1.8}}}}};
        rig.set(u"review.analyze"_s, planned);
        page.analyze();
        QTRY_VERIFY(page.page()[u"result"_s].isObject());
        QVERIFY(page.page()[u"error"_s].toString().isEmpty());
        QVERIFY(page.page()[u"result"_s][u"hasFly"_s].toBool());
        QVERIFY(specLines(page.flyChart()) > 0);
        rig.set(u"review.analyze"_s, QJsonObject{{u"__error"_s, u"拉不到 K 线"_s}});
        page.analyze();
        QTRY_COMPARE(page.page()[u"error"_s].toString(), u"拉不到 K 线"_s);
        QCOMPARE(specLines(page.flyChart()), 0);
        QCOMPARE(specLines(page.underlyingChart()), 0);
        // 回来照读 EM
        page.setVisible(false);
        page.setVisible(true);
        QCOMPARE(page.page()[u"em"_s].toDouble(), 40.0);
    }

    void nothingSelected() {
        Rig rig;
        rig.set(u"review.candidates"_s, obj(R"({"synced":null,"ibkr_available":false,"fills_stored":0,"candidates":[]})"));
        shell::ReviewController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        QTRY_COMPARE(page.page()[u"placeholder"_s].toString(), u"还没有同步到任何 IBKR 成交:先连接 TWS 再点「同步成交」"_s);
        QCOMPARE(page.page()[u"freshness"_s].toString(), u"未连 TWS,只看本地累积的成交 · 库内成交 0 笔"_s);
        page.analyze();
        QCOMPARE(rig.status.banner(), u"先选一笔交易"_s);
        QTest::qWait(60);
        QCOMPARE(rig.calls(u"review.analyze"_s), 0);
    }

    // 交易记录跳过来:默认列表里没有那一张就打开附带本地再读,然后直接分析它
    void requestFromRecords() {
        Rig rig(u"review.candidates=150"_s);
        shell::ReviewController page(&rig.bridge, &rig.status, rig.ini);
        page.request(u"local-1"_s);  // 页面还没挂上:挂上再办
        QCOMPARE(rig.setting(u"review/record"_s), u"local-1"_s);
        // 默认(不附带本地)那份里没有 local-1:进页那一读与跳过来那一读都收到之后,换成附带本地的那一份(回包 150ms 后才到)
        page.setVisible(true);
        QTRY_COMPARE(rig.calls(u"review.candidates"_s), 2);
        rig.set(u"review.candidates"_s, obj(kLocal));
        QTRY_COMPARE(rig.calls(u"review.analyze"_s), 1);
        QVERIFY(page.page()[u"includeLocal"_s].toBool());
        QVERIFY(rig.params(u"review.candidates"_s).last().contains(u"\"include_local\":true"_s));
        QCOMPARE(rig.params(u"review.analyze"_s).first(), u"{\"exit\":{},\"id\":\"local-1\",\"timeframe\":\"auto\"}"_s);
        QTRY_COMPARE(page.page()[u"selected"_s].toString(), u"local-1"_s);
        // 已经挂着时再来一张在默认列表里的:不动开关,直接分析
        rig.set(u"review.candidates"_s, obj(kCandidates));
        page.setIncludeLocal(false);
        page.request(u"stk:p9001"_s);
        QTRY_COMPARE(rig.calls(u"review.analyze"_s), 2);
        QCOMPARE(rig.params(u"review.analyze"_s).last(), u"{\"exit\":{},\"id\":\"stk:p9001\",\"timeframe\":\"auto\"}"_s);
        QVERIFY(!page.page()[u"includeLocal"_s].toBool());
    }

    // 切走前读的候选晚到(比回来之后那一读还晚):不落地
    void staleCandidatesAfterHide() {
        Rig rig;
        QJsonObject slow = obj(kCandidates);
        slow.insert(u"__delay_ms"_s, 300);
        rig.set(u"review.candidates"_s, slow);
        shell::ReviewController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        QTRY_COMPARE(rig.calls(u"review.candidates"_s), 1);
        QJsonObject fast = obj(kLocal);
        fast.insert(u"__delay_ms"_s, 20);
        rig.set(u"review.candidates"_s, fast);
        page.setVisible(false);
        page.setVisible(true);
        QTRY_COMPARE(rig.calls(u"review.candidates"_s), 2);
        QTest::qWait(450);
        QCOMPARE(page.page()[u"options"_s][1][u"value"_s].toString(), u"local-1"_s);
    }

    // EM 记的是 0 或空:自动
    void emZeroIsAuto() {
        Rig rig;
        rig.preset(u"review/em-manual"_s, u"0"_s);
        shell::ReviewController page(&rig.bridge, &rig.status, rig.ini);
        QVERIFY(page.page()[u"em"_s].isNull());
        rig.preset(u"review/em-manual"_s, u"36.5"_s);
        page.setVisible(true);
        QCOMPARE(page.page()[u"em"_s].toDouble(), 36.5);
    }

    void hideDropsLateReplies() {
        Rig rig(u"review.analyze=200,review.candidates=150"_s);
        shell::ReviewController page(&rig.bridge, &rig.status, rig.ini);
        page.setVisible(true);
        QTRY_COMPARE(page.page()[u"selected"_s].toString(), u"demo-fly"_s);
        page.analyze();
        page.sync();
        QTRY_COMPARE(rig.calls(u"review.analyze"_s), 1);
        page.setVisible(false);
        page.setVisible(true);
        QTest::qWait(350);
        QVERIFY(page.page()[u"result"_s].isNull());
        QVERIFY(!page.page()[u"loading"_s].toBool());
        QCOMPARE(specLines(page.underlyingChart()), 0);
    }
};

QTEST_GUILESS_MAIN(TestReviewController)
#include "tst_review_controller.moc"
