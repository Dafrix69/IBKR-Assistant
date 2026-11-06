// 交易纪律守护(guard,docs/features/guard.md):纯规则、后台服务(收意图、盯股票仓位、默认止损)、引擎发单那一步的开仓门槛。
// 全部离线:假的 router / 宿主 / 券商,真的交易库放临时目录,时间由测试给。
#include "js_fixture.h"

#include "analysis/guard_rules.h"
#include "domain/config.h"
#include "orchestrate/engine.h"
#include "orchestrate/services/guard_service.h"
#include "util/error.h"
#include "util/js_runtime.h"
#include "util/jsobj.h"
#include "util/sqlite.h"

#include <QElapsedTimer>
#include <QFile>
#include <QTemporaryDir>
#include <QTest>

#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
using ibkr::util::Task;
namespace js = ibkr::util::js;
namespace orch = ibkr::orchestrate;
namespace gr = ibkr::analysis::guard;

namespace {

template <class T>
T wait(Task<T> t) {
    QElapsedTimer clock;
    clock.start();
    while (!t.done() && clock.elapsed() < 5000) QCoreApplication::processEvents(QEventLoop::AllEvents, 5);
    if (!t.done()) qFatal("协程没跑完");
    return t.result();
}

/// engine_core.json 的 base,库放 dir,guard 段按 guard 给
ibkr::domain::Settings settingsWith(const QString& dir, const OJson& guard) {
    const OJson fx = jsfix::load(u"engine_core.json"_s);
    OJson base = jsfix::dec(*fx.get(u"base"_s));
    base.set(u"storage"_s, js::object({{u"db_path"_s, js::S(dir + u"/fx.db"_s)}}));
    base.set(u"guard"_s, guard);
    return ibkr::domain::fromDict(base);
}

OJson stockRow(const QString& alias, const QString& symbol, double qty, double avg, double price) {
    return js::object({{u"key"_s, js::S(alias + u'|' + symbol + u"|STK"_s)},
                       {u"account"_s, js::S(alias)},
                       {u"symbol"_s, js::S(symbol)},
                       {u"sec_type"_s, js::S(u"STK"_s)},
                       {u"quantity"_s, js::N(qty)},
                       {u"avg_cost"_s, js::N(avg)},
                       {u"market_price"_s, js::N(price)},
                       {u"contract"_s, js::object({{u"secType"_s, js::S(u"STK"_s)}, {u"symbol"_s, js::S(symbol)}})}});
}

OJson bar(const QString& date, double low, double high) {
    return js::object({{u"date"_s, js::S(date)}, {u"open"_s, js::N(low)}, {u"high"_s, js::N(high)}, {u"low"_s, js::N(low)}, {u"close"_s, js::N(high)}});
}

// ---------------------------------------------------------------- 后台服务的假宿主
class FakePort final : public orch::RouterPort {
public:
    QList<OJson> rows;
    QList<OJson> bars;
    bool failPositions = false;
    bool sessions = true;
    bool hasSessions() override { return sessions; }
    Task<QList<OJson>> positions() override {
        if (failPositions) throw ibkr::util::JsError(u"读不到持仓"_s);
        co_return rows;
    }
    Task<OJson> streamQuotes(QStringList) override { co_return js::object(); }
    Task<OJson> stockQuotes(QStringList) override { co_return js::object(); }
    Task<std::optional<double>> indexPrice(QString) override { co_return std::nullopt; }
    std::optional<OJson> spotInfo(const QString&) override { return std::nullopt; }
    bool upstreamOk() override { return true; }
    std::shared_ptr<ibkr::execution::IbSession> marketSession() override { throw ibkr::util::JsError(u"没有会话"_s); }
    Task<OJson> optionChain(QString, std::optional<QString>, double, std::optional<double>, QString) override { co_return js::object(); }
    Task<QList<OJson>> historicalBars(QString, QString, QString) override { co_return bars; }
    Task<ibkr::execution::TaggedBars> intradayBars(QString, QString, bool, std::optional<QString>, bool) override { co_return ibkr::execution::TaggedBars{}; }
};

class FakeNotifier final : public orch::NotifierPort {
public:
    QStringList titles, bodies;
    void notify(const QString& title, const QString& body, const QString&) override {
        titles << title;
        bodies << body;
    }
    void warning(const QString& message) override { titles << message; }
};

class FakeEngine final : public orch::SvcEngine {
public:
    explicit FakeEngine(const QString& dbPath) : store_(dbPath) {}
    ibkr::domain::TradeStore& store() override { return store_; }
    orch::NotifierPort& notifier() override { return notifier_; }
    void reconcileSoon() override {}
    int attachListeners() override { return 0; }
    FakeNotifier notifier_;

private:
    ibkr::domain::TradeStore store_;
};

class FakeRuntime final : public orch::SvcRuntime {
public:
    double perfMs() override { return 0; }
    int setTimeout(int, std::function<void()>) override { return 0; }
    void clearTimeout(int) override {}
    int setInterval(int, std::function<void()>) override { return 0; }
    void clearInterval(int) override {}
    double random() override { return 0.5; }
};

class FakeHost final : public orch::SvcHost {
public:
    FakeHost(ibkr::domain::Settings s) : settings_(std::move(s)), engine_(settings_.db_path), port_(std::make_shared<FakePort>()) {}
    const ibkr::domain::Settings& settings() const override { return settings_; }
    std::shared_ptr<orch::Router> router() const override { return nullptr; }
    orch::TradingEngine& engine() override { qFatal("guard 不该碰 TradingEngine"); }
    void emitEvent(const QString& event, const OJson&) override { events << event; }
    std::shared_ptr<ibkr::execution::BrokerRouter> broker() const override { return nullptr; }
    std::shared_ptr<orch::RouterPort> routerPort() const override { return port_; }
    orch::SvcEngine& svcEngine() override { return engine_; }
    orch::SvcRuntime& runtime() override { return runtime_; }

    ibkr::domain::Settings settings_;
    FakeEngine engine_;
    std::shared_ptr<FakePort> port_;
    FakeRuntime runtime_;
    QStringList events;
};

/// 一套服务:宿主 + 记下来的 tracker.add 入参
struct SvcRig {
    QTemporaryDir dir;
    std::unique_ptr<FakeHost> host;
    std::unique_ptr<orch::GuardService> svc;
    QList<OJson> added;
    std::optional<QString> addFails;
    std::optional<QStringList> covered;

    explicit SvcRig(bool enabled = true) {
        host = std::make_unique<FakeHost>(settingsWith(dir.path(), js::object({{u"enabled"_s, js::B(enabled)}})));
        svc = std::make_unique<orch::GuardService>(*host);
        orch::GuardWiring w;
        w.addTrack = [this](OJson params) -> Task<OJson> {
            if (addFails) throw ibkr::util::JsError(*addFails);
            added << params;
            co_return js::object({{u"track"_s, js::object()}});
        };
        w.navOf = [](const QString&) -> std::optional<double> { return 15000.0; };
        w.coveredAccounts = [this] { return covered; };
        svc->attach(std::move(w));
    }
    FakePort& port() { return *host->port_; }
    ibkr::domain::TradeStore& store() { return host->engine_.store(); }
    OJson tick(double ms, const QString& today = u"2026-11-06"_s) { return wait(svc->tickOnce(ms, today)); }
    void writeInbox(const QStringList& lines) {
        QFile f(svc->inboxPath());
        QDir().mkpath(QFileInfo(f).path());
        QVERIFY(f.open(QIODevice::WriteOnly | QIODevice::Text));
        f.write((lines.join(u'\n') + u'\n').toUtf8());
    }
    QStringList auditActions() {
        QStringList out;
        ibkr::util::sqlite::Database db(host->settings_.db_path);
        for (const OJson& r : db.prepare(u"SELECT action FROM audit_log WHERE actor='guard' ORDER BY seq"_s).all()) out << js::str(r.get(u"action"_s));
        return out;
    }
};

// ---------------------------------------------------------------- 引擎的假券商
class GateRouter final : public orch::EngineRouter {
public:
    QList<OJson> rowsNow;
    int placed = 0;
    Task<QList<OJson>> positions() override { co_return rowsNow; }
    Task<std::optional<double>> indexPrice(const QString&) override { co_return std::nullopt; }
    Task<std::vector<ibkr::execution::LegQuote>> legQuotes(OJson, ibkr::contract::AccountConfig) override { co_return std::vector<ibkr::execution::LegQuote>{}; }
    Task<ibkr::execution::PlacementResult> place(QString recordId, ibkr::parsing::validator::ApprovedOrder, std::optional<double>) override {
        ++placed;
        ibkr::execution::PlacementResult r;
        r.record_id = recordId;
        r.order_id = 700 + placed;
        r.status = u"Submitted"_s;
        co_return r;
    }
    Task<int> cancelAllOpen() override { co_return 0; }
    Task<QList<OJson>> listHostedOpenWith(std::optional<QString>) override { co_return QList<OJson>{}; }
    bool supportsHostedClose() const override { return false; }
    Task<ibkr::execution::HostedPlacement> placeHosted(ibkr::contract::AccountConfig, OJson, OJson, QString, QString) override { co_return ibkr::execution::HostedPlacement{}; }
    Task<bool> modifyHosted(qint64, OJson) override { co_return false; }
    Task<bool> cancelHosted(qint64) override { co_return true; }
    bool hasListOpenOrdersDetailed() const override { return false; }
    Task<QList<OJson>> listOpenOrdersDetailed() override { co_return QList<OJson>{}; }
    bool hasConnectedNames() const override { return false; }
    QStringList connectedNames() override { return {}; }
    int sessionCount() override { return 0; }
    ibkr::execution::SessionList sessions() override { return {}; }
};

/// 解析器:每次都回同一张单(没有 LLM)
class StockParser final : public orch::EngineParser {
public:
    QString action = u"BUY"_s;
    double qty = 100;
    Task<ibkr::parsing::providers::LLMResponse> parse(ibkr::parsing::prompts::PromptBundle bundle, QString) override {
        const OJson order = js::object({{u"intent_summary"_s, js::S(u"限价 230 %1 %2 股 AAPL"_s.arg(action, util_n(qty)))},
                                        {u"contract"_s, js::object({{u"secType"_s, js::S(u"STK"_s)}, {u"symbol"_s, js::S(u"AAPL"_s)}, {u"exchange"_s, js::S(u"SMART"_s)}, {u"currency"_s, js::S(u"USD"_s)}})},
                                        {u"execution_type"_s, js::S(u"IMMEDIATE"_s)},
                                        {u"trigger"_s, js::Null()},
                                        {u"account"_s, js::S(u"DEFAULT"_s)},
                                        {u"order"_s, js::object({{u"action"_s, js::S(action)},
                                                                 {u"orderType"_s, js::S(u"LMT"_s)},
                                                                 {u"totalQuantity"_s, js::N(qty)},
                                                                 {u"price_mode"_s, js::S(u"EXPLICIT"_s)},
                                                                 {u"lmtPrice"_s, js::N(230)},
                                                                 {u"tif"_s, js::S(u"DAY"_s)},
                                                                 {u"outsideRth"_s, js::B(false)}})},
                                        {u"reason"_s, js::S(u"测试"_s)},
                                        {u"confidence"_s, js::N(0.99)},
                                        {u"warnings"_s, js::array()}});
        ibkr::parsing::providers::LLMResponse r;
        r.text = ibkr::util::stringifyOJson(js::object({{u"orders"_s, js::array({order})}, {u"rejections"_s, js::array()}}), 0);
        r.model = js::S(u"test"_s);
        r.prompt_version = bundle.version;
        r.prompt_fingerprint = ibkr::parsing::prompts::fingerprint(bundle);
        r.latency_ms = 1;
        r.usage = js::object();
        r.structured_mode = u"json_schema"_s;
        co_return r;
    }
    static QString util_n(double v) { return QString::number(v); }
};

/// 美东 2026-11-04 周三 10:30(冬令时,UTC 15:30)
constexpr double kRth = 1793806200000.0;

struct EngineRig {
    QTemporaryDir dir;
    std::shared_ptr<GateRouter> router = std::make_shared<GateRouter>();
    std::shared_ptr<StockParser> parser = std::make_shared<StockParser>();
    std::shared_ptr<ibkr::domain::TradeStore> store;
    std::unique_ptr<orch::TradingEngine> engine;

    EngineRig() {
        ibkr::util::setDateNowForTests([] { return kRth; });
        orch::EngineArgs a;
        a.settings = settingsWith(dir.path(), js::object({{u"enabled"_s, js::B(true)}}));
        store = std::make_shared<ibkr::domain::TradeStore>(a.settings.db_path);
        a.store = store;
        a.router = router;
        a.parser = parser;
        ibkr::parsing::prompts::PromptBundle bundle;
        bundle.version = u"test"_s;
        bundle.system_text = u"system"_s;
        bundle.user_template = u"{instruction}"_s;
        a.bundle = bundle;
        a.notifier = std::make_shared<ibkr::util::Notifier>(false, std::vector<ibkr::util::Notifier::Sink>{});
        engine = std::make_unique<orch::TradingEngine>(std::move(a));
        engine->setTimerHook([](int ms, std::function<void()> fn) { QTimer::singleShot(ms, std::move(fn)); });
        // 同 EngineServer 注入的那一份
        engine->openGate = [this](const ibkr::parsing::validator::ApprovedOrder& approved) -> std::optional<QString> {
            return gr::gateOrder(store->guard().openStock(approved.account.alias, gr::orderSymbol(approved.order)), approved.order);
        };
    }
    ~EngineRig() {
        engine.reset();
        ibkr::util::setDateNowForTests({});
    }
    orch::EngineResult submit(bool dryRun = false) {
        try {
            return wait(engine->handleInstruction(u"买入 AAPL"_s, u"manual"_s, ibkr::domain::etNowFromEpoch(kRth), std::nullopt, std::nullopt, dryRun));
        } catch (const ibkr::util::JsError& e) {
            qFatal("handleInstruction 抛了:%s", qPrintable(e.message()));
        } catch (const std::exception& e) {
            qFatal("handleInstruction 抛了:%s", e.what());
        }
    }
    void addIntent(const QString& side, double qty) {
        store->guard().add(js::object({{u"kind"_s, js::S(u"stock"_s)}, {u"account"_s, js::S(u"模拟"_s)}, {u"symbol"_s, js::S(u"AAPL"_s)},
                                        {u"side"_s, js::S(side)}, {u"qty"_s, js::N(qty)}, {u"stop_price"_s, js::N(220)}}));
    }
};

QString codes(const orch::EngineResult& r) {
    QStringList out;
    for (const OJson& x : r.rejections) out << js::str(x.get(u"code"_s)) + u":"_s + js::str(x.get(u"message"_s));
    return out.join(u',');
}

}  // namespace

class TstGuard : public QObject {
    Q_OBJECT
private slots:
    // ================================================================ 纯规则
    void stockIntentComputesLoss() {
        ibkr::contract::GuardConfig cfg;
        const auto v = gr::checkStockIntent(js::object({{u"symbol"_s, js::S(u"be"_s)}, {u"side"_s, js::S(u"buy"_s)}, {u"qty"_s, js::N(20)},
                                                        {u"entry_price"_s, js::N(195)}, {u"stop_price"_s, js::N(186)}, {u"stop_reason"_s, js::S(u"13周低点"_s)},
                                                        {u"thesis"_s, js::S(u"t"_s)}, {u"invalidation"_s, js::S(u"i"_s)}}),
                                            u"主账户"_s, 15000, cfg);
        QVERIFY2(v.ok, qPrintable(v.error));
        QCOMPARE(js::str(v.intent.get(u"symbol"_s)), u"BE"_s);
        QCOMPARE(js::str(v.intent.get(u"side"_s)), u"BUY"_s);
        QCOMPARE(js::num(v.intent.get(u"max_loss_usd"_s)), 180.0);
        QCOMPARE(js::num(v.intent.get(u"max_loss_pct_nav"_s)), 1.2);
        QVERIFY(v.notes.isEmpty());
    }
    void stockIntentRejectsOverTwoPercent() {
        ibkr::contract::GuardConfig cfg;
        // (195 − 186) × 40 = 360 > 2% × 15000 = 300;最多 300 / 9 = 33 股
        const auto v = gr::checkStockIntent(js::object({{u"symbol"_s, js::S(u"BE"_s)}, {u"side"_s, js::S(u"BUY"_s)}, {u"qty"_s, js::N(40)},
                                                        {u"entry_price"_s, js::N(195)}, {u"stop_price"_s, js::N(186)}, {u"stop_reason"_s, js::S(u"x"_s)}}),
                                            u"主账户"_s, 15000, cfg);
        QVERIFY(!v.ok);
        QVERIFY2(v.error.contains(u"最多 33 股"_s), qPrintable(v.error));
    }
    void stockIntentHalvesWideStop() {
        ibkr::contract::GuardConfig cfg;
        // 止损距离 10% > 8%:20 股减半成 10 股,10 × 10 = 100 < 300 通过
        const auto v = gr::checkStockIntent(js::object({{u"symbol"_s, js::S(u"X"_s)}, {u"side"_s, js::S(u"BUY"_s)}, {u"qty"_s, js::N(20)},
                                                        {u"entry_price"_s, js::N(100)}, {u"stop_price"_s, js::N(90)}, {u"stop_reason"_s, js::S(u"x"_s)}}),
                                            u"主账户"_s, 15000, cfg);
        QVERIFY2(v.ok, qPrintable(v.error));
        QCOMPARE(js::num(v.intent.get(u"qty"_s)), 10.0);
        QCOMPARE(js::num(v.intent.get(u"qty_requested"_s)), 20.0);
        QCOMPARE(js::num(v.intent.get(u"max_loss_usd"_s)), 100.0);
        QVERIFY(!v.notes.isEmpty());
        // 减半之后还超:照样拒
        const auto w = gr::checkStockIntent(js::object({{u"symbol"_s, js::S(u"X"_s)}, {u"side"_s, js::S(u"BUY"_s)}, {u"qty"_s, js::N(80)},
                                                        {u"entry_price"_s, js::N(100)}, {u"stop_price"_s, js::N(90)}, {u"stop_reason"_s, js::S(u"x"_s)}}),
                                            u"主账户"_s, 15000, cfg);
        QVERIFY(!w.ok);
    }
    void stockIntentRequiredFields() {
        ibkr::contract::GuardConfig cfg;
        const OJson ok = js::object({{u"symbol"_s, js::S(u"X"_s)}, {u"side"_s, js::S(u"SELL"_s)}, {u"qty"_s, js::N(10)},
                                     {u"entry_price"_s, js::N(50)}, {u"stop_price"_s, js::N(52)}, {u"stop_reason"_s, js::S(u"前高"_s)}});
        QVERIFY(gr::checkStockIntent(ok, u"a"_s, 15000, cfg).ok);
        auto without = [&](const QString& k) {
            OJson o = js::object();
            for (const auto& [kk, v] : ok.fields)
                if (kk != k) o.set(kk, v);
            return gr::checkStockIntent(o, u"a"_s, 15000, cfg);
        };
        QVERIFY(!without(u"stop_price"_s).ok);
        QVERIFY(!without(u"stop_reason"_s).ok);
        QVERIFY(!without(u"entry_price"_s).ok);
        // 卖空的止损写在入场价下面:拒
        OJson wrong = ok;
        wrong.set(u"stop_price"_s, js::N(48));
        QVERIFY(!gr::checkStockIntent(wrong, u"a"_s, 15000, cfg).ok);
        // 零碎股数:拒
        OJson frac = ok;
        frac.set(u"qty"_s, js::N(2.5));
        QVERIFY(!gr::checkStockIntent(frac, u"a"_s, 15000, cfg).ok);
        // 净值读不到:拒
        QVERIFY(!gr::checkStockIntent(ok, u"a"_s, 0, cfg).ok);
    }
    void optionIntent() {
        const OJson line = js::object({{u"symbol"_s, js::S(u"qqq"_s)},
                                       {u"structure"_s, js::S(u"QQQ 660/670/680 call fly"_s)},
                                       {u"expiry"_s, js::S(u"2026-11-09"_s)},
                                       {u"cost_usd"_s, js::N(157)},
                                       {u"exit_rules"_s, js::object({{u"take_profit"_s, js::S(u"中间价 >= 成本 × 2.5"_s)},
                                                                     {u"stop_loss"_s, js::S(u"中间价 <= 成本 × 0.4"_s)},
                                                                     {u"time_stop"_s, js::S(u"到期日 15:00 ET"_s)}})}});
        const auto v = gr::checkOptionIntent(line, u"主账户"_s);
        QVERIFY2(v.ok, qPrintable(v.error));
        QCOMPARE(js::str(v.intent.get(u"symbol"_s)), u"QQQ"_s);
        OJson noTime = line;
        noTime.set(u"exit_rules"_s, js::object({{u"take_profit"_s, js::S(u"a"_s)}, {u"stop_loss"_s, js::S(u"b"_s)}}));
        QVERIFY(!gr::checkOptionIntent(noTime, u"主账户"_s).ok);
        OJson badDate = line;
        badDate.set(u"expiry"_s, js::S(u"11/09"_s));
        QVERIFY(!gr::checkOptionIntent(badDate, u"主账户"_s).ok);
    }
    void defaultStopTakesTheNearerLine() {
        // 多头:入场 202.5 × 0.92 = 186.30;前 10 日最低 195 更近 → 195
        QCOMPARE(gr::defaultStop(true, 202.5, 195.0, 8), 195.0);
        // 最低价更远:用比例
        QCOMPARE(gr::defaultStop(true, 202.5, 150.0, 8), 186.3);
        // 拿不到极值:只用比例
        QCOMPARE(gr::defaultStop(true, 100, std::nullopt, 8), 92.0);
        // 空头:入场 50 × 1.08 = 54;前 10 日最高 53 更近 → 53
        QCOMPARE(gr::defaultStop(false, 50, 53.0, 8), 53.0);
        QCOMPARE(gr::defaultStop(false, 50, 60.0, 8), 54.0);
        // 取整朝远离现价:多头向下、空头向上
        QCOMPARE(gr::defaultStop(true, 100.009, std::nullopt, 8), 92.0);
        QCOMPARE(gr::defaultStop(false, 100.009, std::nullopt, 8), 108.01);
    }
    void priorExtremeSkipsToday() {
        QList<OJson> bars;
        for (int d = 1; d <= 12; ++d) bars << bar(u"2026-10-%1"_s.arg(d, 2, 10, QChar(u'0')), 100 + d, 200 - d);
        bars << bar(u"2026-11-06"_s, 50, 400);  // 今天这根不算
        // 前 10 根 = 10-03..10-12:最低 103、最高 197
        QCOMPARE(*gr::priorExtreme(bars, u"2026-11-06"_s, 10, true), 103.0);
        QCOMPARE(*gr::priorExtreme(bars, u"2026-11-06"_s, 10, false), 197.0);
        QVERIFY(!gr::priorExtreme({}, u"2026-11-06"_s, 10, true));
    }
    void gateDecisions() {
        QVERIFY(gr::gateOpenOrder(std::nullopt, u"AAPL"_s, u"BUY"_s, 10));
        const OJson row = js::object({{u"intent"_s, js::object({{u"side"_s, js::S(u"BUY"_s)}, {u"qty"_s, js::N(20)}})}});
        QVERIFY(!gr::gateOpenOrder(row, u"AAPL"_s, u"BUY"_s, 20));
        QVERIFY(gr::gateOpenOrder(row, u"AAPL"_s, u"BUY"_s, 21));
        QVERIFY(gr::gateOpenOrder(row, u"AAPL"_s, u"SELL"_s, 5));
    }
    void configSection() {
        QTemporaryDir dir;
        const auto s = settingsWith(dir.path(), js::object());
        QCOMPARE(s.guard.enabled, false);
        QCOMPARE(s.guard.grace_s, 60.0);
        QCOMPARE(s.guard.max_loss_pct_nav, 2.0);
        QCOMPARE(s.guard.wide_stop_pct, 8.0);
        QCOMPARE(s.guard.default_low_days, 10.0);
        bool threw = false;
        try {
            settingsWith(dir.path(), js::object({{u"oops"_s, js::N(1)}}));
        } catch (const ibkr::util::JsError& e) {
            threw = e.message().contains(u"guard"_s);
        }
        QVERIFY(threw);
        threw = false;
        try {
            settingsWith(dir.path(), js::object({{u"tick_s"_s, js::N(30)}, {u"grace_s"_s, js::N(10)}}));
        } catch (const ibkr::util::JsError&) {
            threw = true;
        }
        QVERIFY(threw);
    }

    // ================================================================ 后台服务
    void disabledDoesNothing() {
        SvcRig rig(false);
        rig.port().rows = {stockRow(u"模拟"_s, u"TTWO"_s, 20, 202.5, 212.66)};
        rig.writeInbox({u"{\"close\":\"TTWO\",\"reason\":\"x\"}"_s});
        QVERIFY(rig.tick(0).fields.isEmpty());
        QVERIFY(rig.tick(120000).fields.isEmpty());
        QVERIFY(rig.added.isEmpty());
        QVERIFY(QFile::exists(rig.svc->inboxPath()));  // 文件没被接走
        QVERIFY(rig.host->engine_.notifier_.titles.isEmpty());
    }
    void noIntentLongGetsDefaultStopAfterGrace() {
        SvcRig rig;
        rig.port().rows = {stockRow(u"模拟"_s, u"TTWO"_s, 20, 202.5, 212.66)};
        for (int d = 20; d <= 31; ++d) rig.port().bars << bar(u"2026-10-%1"_s.arg(d), 196 + (d - 20) * 0.1, 215);
        rig.port().bars << bar(u"2026-11-06"_s, 150, 215);  // 今天的低点不算
        const OJson t0 = rig.tick(0);
        QCOMPARE(js::num(js::path(&t0, {u"positions"_s, u"warned"_s})), 1.0);
        QCOMPARE(rig.host->engine_.notifier_.titles.value(0), u"股票仓位没有交易意图"_s);
        QVERIFY(rig.auditActions().contains(u"guard_violation"_s));
        // 补录期内:不挂
        rig.tick(59000);
        QVERIFY(rig.added.isEmpty());
        // 过了 60 秒:前 10 日(10-22..10-31)最低 196.2 比 202.5 × 0.92 = 186.3 更近
        const OJson t1 = rig.tick(60000);
        QCOMPARE(js::num(js::path(&t1, {u"positions"_s, u"stopped"_s})), 1.0);
        QCOMPARE(rig.added.size(), 1);
        const OJson& p = rig.added[0];
        QCOMPARE(js::str(p.get(u"key"_s)), u"模拟|TTWO|STK"_s);
        QCOMPARE(js::num(p.get(u"stop_loss"_s)), 196.2);
        QVERIFY(js::truthy(p.get(u"host_at_broker"_s)));
        QVERIFY(js::truthy(p.get(u"auto_close"_s)));
        QVERIFY(rig.auditActions().contains(u"guard_default_stop"_s));
        // 挂过一次不再挂
        rig.tick(120000);
        QCOMPARE(rig.added.size(), 1);
        QVERIFY(rig.host->events.contains(u"guard"_s));
    }
    void shortPositionMirrors() {
        SvcRig rig;
        rig.port().rows = {stockRow(u"模拟"_s, u"XYZ"_s, -10, 50, 49)};
        for (int d = 20; d <= 31; ++d) rig.port().bars << bar(u"2026-10-%1"_s.arg(d), 45, 53);
        rig.tick(0);
        rig.tick(61000);
        QCOMPARE(rig.added.size(), 1);
        QCOMPARE(js::num(rig.added[0].get(u"stop_loss"_s)), 53.0);
    }
    void stopThatCannotBePlacedNagsWithoutClosing() {
        SvcRig rig;
        rig.port().rows = {stockRow(u"模拟"_s, u"BE"_s, 20, 206.51, 161.17)};
        rig.addFails = u"多头的止损价要低于现价(现价 161.17,你填了 189.98)——填在上方会立刻触发。"_s;
        rig.tick(0);
        const OJson t1 = rig.tick(61000);
        QCOMPARE(js::num(js::path(&t1, {u"positions"_s, u"failed"_s})), 1.0);
        QVERIFY(rig.auditActions().contains(u"guard_default_stop_failed"_s));
        const qsizetype told = rig.host->engine_.notifier_.titles.count(u"默认止损挂不上"_s);
        QCOMPARE(told, 1);
        // 五分钟内不重复提醒,之后再提醒
        rig.tick(120000);
        QCOMPARE(rig.host->engine_.notifier_.titles.count(u"默认止损挂不上"_s), 1);
        rig.tick(61000 + orch::GuardService::kNagMs);
        QCOMPARE(rig.host->engine_.notifier_.titles.count(u"默认止损挂不上"_s), 2);
        QVERIFY(rig.added.isEmpty());
    }
    void protectedByTrackOrIntentIsLeftAlone() {
        SvcRig rig;
        rig.store().addTrack(js::object({{u"account"_s, js::S(u"模拟"_s)}, {u"symbol"_s, js::S(u"GLD"_s)}, {u"sec_type"_s, js::S(u"STK"_s)},
                                         {u"targets"_s, js::object({{u"stop_loss"_s, js::N(380)}})},
                                         {u"auto_close"_s, js::object({{u"enabled"_s, js::B(true)}})}}));
        rig.store().guard().add(js::object({{u"kind"_s, js::S(u"stock"_s)}, {u"account"_s, js::S(u"模拟"_s)}, {u"symbol"_s, js::S(u"BE"_s)},
                                            {u"side"_s, js::S(u"BUY"_s)}, {u"qty"_s, js::N(20)}}));
        rig.port().rows = {stockRow(u"模拟"_s, u"GLD"_s, 5, 390, 395), stockRow(u"模拟"_s, u"BE"_s, 20, 195, 196)};
        const OJson t0 = rig.tick(0);
        QCOMPARE(js::num(js::path(&t0, {u"positions"_s, u"warned"_s})), 0.0);
        rig.tick(120000);
        QVERIFY(rig.added.isEmpty());
        QVERIFY(rig.host->engine_.notifier_.titles.isEmpty());
        // 意图对应的持仓平掉了:意图自动关掉
        rig.port().rows = {stockRow(u"模拟"_s, u"GLD"_s, 5, 390, 395)};
        const OJson t2 = rig.tick(130000);
        QCOMPARE(js::num(js::path(&t2, {u"positions"_s, u"auto_closed"_s})), 1.0);
        QVERIFY(!rig.store().guard().openStock(u"模拟"_s, u"BE"_s));
    }
    void intentDirectionMustMatch() {
        SvcRig rig;
        // 意图是买,仓位却是空头:当没有意图
        rig.store().guard().add(js::object({{u"kind"_s, js::S(u"stock"_s)}, {u"account"_s, js::S(u"模拟"_s)}, {u"symbol"_s, js::S(u"BE"_s)},
                                            {u"side"_s, js::S(u"BUY"_s)}, {u"qty"_s, js::N(20)}}));
        rig.port().rows = {stockRow(u"模拟"_s, u"BE"_s, -20, 195, 196)};
        const OJson t0 = rig.tick(0);
        QCOMPARE(js::num(js::path(&t0, {u"positions"_s, u"warned"_s})), 1.0);
    }
    void unreadablePositionsAreNotFlat() {
        SvcRig rig;
        rig.store().guard().add(js::object({{u"kind"_s, js::S(u"stock"_s)}, {u"account"_s, js::S(u"模拟"_s)}, {u"symbol"_s, js::S(u"BE"_s)},
                                            {u"side"_s, js::S(u"BUY"_s)}, {u"qty"_s, js::N(20)}}));
        rig.port().rows = {stockRow(u"模拟"_s, u"BE"_s, 20, 195, 196)};
        rig.tick(0);
        rig.port().failPositions = true;
        rig.tick(1000);
        QVERIFY(rig.store().guard().openStock(u"模拟"_s, u"BE"_s));  // 读不到持仓不当成平了
    }
    void uncoveredAccountIsNotTreatedAsFlat() {
        SvcRig rig;
        rig.store().guard().add(js::object({{u"kind"_s, js::S(u"stock"_s)}, {u"account"_s, js::S(u"模拟"_s)}, {u"symbol"_s, js::S(u"BE"_s)},
                                            {u"side"_s, js::S(u"BUY"_s)}, {u"qty"_s, js::N(20)}}));
        rig.port().rows = {stockRow(u"模拟"_s, u"BE"_s, 20, 195, 196)};
        rig.tick(0);
        // 纸面那条连接断了、实盘还连着:持仓里没有它,但不是平了
        rig.covered = QStringList{u"主账户"_s};
        rig.port().rows = {};
        rig.tick(1000);
        QVERIFY(rig.store().guard().openStock(u"模拟"_s, u"BE"_s));
        // 连回来、确实没了:才关
        rig.covered = QStringList{u"模拟"_s, u"主账户"_s};
        rig.tick(2000);
        QVERIFY(!rig.store().guard().openStock(u"模拟"_s, u"BE"_s));
    }
    void inboxIngest() {
        SvcRig rig;
        rig.writeInbox({
            u"# 注释行跳过"_s,
            u"{\"symbol\":\"BE\",\"side\":\"BUY\",\"qty\":20,\"entry_price\":195,\"stop_price\":186,\"stop_reason\":\"13周低点\",\"thesis\":\"t\",\"invalidation\":\"i\"}"_s,
            u"{\"symbol\":\"BE\",\"side\":\"BUY\",\"qty\":40,\"entry_price\":195,\"stop_price\":186,\"stop_reason\":\"13周低点\"}"_s,
            u"{\"account\":\"主账户\",\"symbol\":\"QQQ\",\"structure\":\"QQQ 660/670/680 call fly\",\"expiry\":\"2026-11-09\",\"cost_usd\":157,"
            "\"exit_rules\":{\"take_profit\":\"a\",\"stop_loss\":\"b\",\"time_stop\":\"c\"}}"_s,
            u"不是 JSON"_s,
            u"{\"symbol\":\"X\",\"side\":\"BUY\",\"qty\":1,\"entry_price\":10,\"stop_price\":9,\"stop_reason\":\"r\",\"account\":\"不存在\"}"_s,
            u"{\"close\":\"QQQ\",\"account\":\"主账户\"}"_s,
        });
        const OJson out = rig.svc->ingestInbox();
        QCOMPARE(js::num(out.get(u"accepted"_s)), 2.0);
        QCOMPARE(js::num(out.get(u"rejected"_s)), 4.0);
        QCOMPARE(js::num(out.get(u"closed"_s)), 0.0);
        QVERIFY(!QFile::exists(rig.svc->inboxPath()));
        QFile log(QFileInfo(rig.svc->inboxPath()).path() + u"/intents.log.jsonl"_s);
        QVERIFY(log.open(QIODevice::ReadOnly));
        QCOMPARE(QString::fromUtf8(log.readAll()).trimmed().split(u'\n').size(), 6);
        const auto be = rig.store().guard().openStock(u"模拟"_s, u"BE"_s);
        QVERIFY(be);
        QCOMPARE(js::num(js::path(&*be, {u"intent"_s, u"max_loss_usd"_s})), 180.0);
        QCOMPARE(rig.store().guard().listOpen().size(), 2);
        // 写了理由才能关
        rig.writeInbox({u"{\"close\":\"QQQ\",\"account\":\"主账户\",\"reason\":\"到期前平了\"}"_s});
        const OJson again = rig.svc->ingestInbox();
        QCOMPARE(js::num(again.get(u"closed"_s)), 1.0);
        QCOMPARE(rig.store().guard().listOpen().size(), 1);
        QVERIFY(rig.auditActions().contains(u"guard_intent_add"_s));
        QVERIFY(rig.auditActions().contains(u"guard_reject"_s));
        QVERIFY(rig.auditActions().contains(u"guard_intent_close"_s));
    }
    void leftoverProcessingFileIsPickedUp() {
        SvcRig rig;
        const QString dir = QFileInfo(rig.svc->inboxPath()).path();
        QDir().mkpath(dir);
        QFile f(dir + u"/intents.jsonl.processing-1"_s);
        QVERIFY(f.open(QIODevice::WriteOnly));
        f.write("{\"symbol\":\"BE\",\"side\":\"BUY\",\"qty\":10,\"entry_price\":195,\"stop_price\":186,\"stop_reason\":\"r\"}\n");
        f.close();
        QCOMPARE(js::num(rig.svc->ingestInbox().get(u"accepted"_s)), 1.0);
        QVERIFY(!QFile::exists(dir + u"/intents.jsonl.processing-1"_s));
    }

    // ================================================================ 引擎发单那一步
    void gateRejectsOpeningStockWithoutIntent() {
        EngineRig rig;
        const orch::EngineResult r = rig.submit();
        QVERIFY2(codes(r).startsWith(u"GUARD_NO_INTENT:"_s), qPrintable(codes(r)));
        QCOMPARE(rig.router->placed, 0);
        const QString recordId = js::str(r.rejections[0].get(u"record_id"_s));
        const auto rec = rig.store->getRecord(recordId);
        QVERIFY(rec);
        QCOMPARE(js::str(rec->get(u"final_status"_s)), u"rejected_by_guard"_s);
    }
    void gatePassesWithIntent() {
        EngineRig rig;
        rig.addIntent(u"BUY"_s, 100);
        const orch::EngineResult r = rig.submit();
        QVERIFY2(r.rejections.isEmpty(), qPrintable(codes(r)));
        QCOMPARE(rig.router->placed, 1);
        // 超过意图的数量:拒
        rig.parser->qty = 150;
        QVERIFY(codes(rig.submit()).startsWith(u"GUARD_NO_INTENT:"_s));
        QCOMPARE(rig.router->placed, 1);
    }
    void dryRunIsNotGated() {
        EngineRig rig;
        const orch::EngineResult r = rig.submit(true);
        QVERIFY(r.rejections.isEmpty());
        QCOMPARE(r.validated_only.size(), 1);
    }
    void reducingOrderIsNotGated() {
        EngineRig rig;
        rig.router->rowsNow = {stockRow(u"模拟"_s, u"AAPL"_s, 100, 220, 229.5)};
        rig.parser->action = u"SELL"_s;
        rig.parser->qty = 50;
        const orch::EngineResult r = rig.submit();
        QVERIFY2(r.rejections.isEmpty(), qPrintable(codes(r)));
        QCOMPARE(rig.router->placed, 1);
    }
};

QTEST_GUILESS_MAIN(TstGuard)
#include "tst_guard.moc"
