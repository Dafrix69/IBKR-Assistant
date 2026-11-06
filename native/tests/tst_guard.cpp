// 交易纪律守护(guard,docs/features/guard.md):纯规则、后台服务(收意图、盯股票仓位、默认止损)、引擎发单那一步的开仓门槛。
// 全部离线:假的 router / 宿主 / 券商,真的交易库放临时目录,时间由测试给。
#include "js_fixture.h"

#include "analysis/guard_report.h"
#include "analysis/guard_rules.h"
#include "domain/config.h"
#include "domain/positions.h"
#include "orchestrate/engine.h"
#include "orchestrate/services/guard_push.h"
#include "orchestrate/services/guard_service.h"
#include "util/run_marker.h"
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

QString util_strike(double k) { return QString::number(k); }

OJson optRow(const QString& alias, const QString& symbol, const QString& expiry, double strike, const QString& right, double qty, double avg) {
    const QString k = util_strike(strike);
    return js::object({{u"key"_s, js::S(alias + u'|' + symbol + u"|OPT|"_s + expiry + u'|' + k + u'|' + right)},
                       {u"account"_s, js::S(alias)},
                       {u"symbol"_s, js::S(symbol)},
                       {u"sec_type"_s, js::S(u"OPT"_s)},
                       {u"leg"_s, js::S(expiry + u'|' + k + u'|' + right)},
                       {u"quantity"_s, js::N(qty)},
                       {u"multiplier"_s, js::N(100)},
                       {u"avg_cost"_s, js::N(avg)},
                       {u"market_price"_s, js::N(avg / 100)},
                       {u"contract"_s, js::object({{u"secType"_s, js::S(u"OPT"_s)}, {u"symbol"_s, js::S(symbol)}, {u"lastTradeDateOrContractMonth"_s, js::S(expiry)},
                                                   {u"strike"_s, js::N(strike)}, {u"right"_s, js::S(right)}, {u"multiplier"_s, js::S(u"100"_s)}})}});
}

OJson stockIntent(const QString& symbol, const QString& side, double stop, double entry = 195) {
    return js::object({{u"kind"_s, js::S(u"stock"_s)}, {u"account"_s, js::S(u"模拟"_s)}, {u"symbol"_s, js::S(symbol)}, {u"side"_s, js::S(side)},
                       {u"qty"_s, js::N(20)}, {u"entry_price"_s, js::N(entry)}, {u"stop_price"_s, js::N(stop)}, {u"stop_reason"_s, js::S(u"13周低点"_s)}});
}

OJson flyIntent(const QString& structure, double cost = 157) {
    const auto v = gr::checkOptionIntent(js::object({{u"symbol"_s, js::S(u"QQQ"_s)}, {u"structure"_s, js::S(structure)}, {u"expiry"_s, js::S(u"2026-11-09"_s)},
                                                     {u"cost_usd"_s, js::N(cost)},
                                                     {u"exit_rules"_s, js::object({{u"take_profit"_s, js::S(u"中间价 >= 成本 × 2.5"_s)},
                                                                                   {u"stop_loss"_s, js::S(u"中间价 <= 成本 × 0.4"_s)},
                                                                                   {u"time_stop"_s, js::S(u"到期日 15:00 ET"_s)}})}}),
                                         u"模拟"_s);
    if (!v.ok) qFatal("flyIntent: %s", qPrintable(v.error));
    return v.intent;
}

/// fillRow 的样子
OJson fillOf(const QString& accountId, const QString& secType, const QString& symbol, const QString& side, double shares, double price, const QString& timeUtc,
             double perm, double strike = 0, const QString& right = {}, const QString& expiry = {}) {
    return js::object({{u"exec_id"_s, js::S(timeUtc + symbol + QString::number(strike) + side)},
                       {u"time"_s, js::S(timeUtc)},
                       {u"account_id"_s, js::S(accountId)},
                       {u"contract"_s, js::object({{u"secType"_s, js::S(secType)}, {u"symbol"_s, js::S(symbol)}, {u"expiry"_s, js::S(expiry)},
                                                   {u"strike"_s, strike ? js::N(strike) : js::Null()}, {u"right"_s, js::S(right)}})},
                       {u"side"_s, js::S(side)},
                       {u"shares"_s, js::N(shares)},
                       {u"price"_s, js::N(price)},
                       {u"perm_id"_s, js::N(perm)}});
}

/// 美东某一刻:冬令时 UTC − 5
ibkr::domain::EtNow etAtUtc(const QString& iso) { return ibkr::domain::etNowFromEpoch(double(QDateTime::fromString(iso, Qt::ISODate).toMSecsSinceEpoch())); }

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
    bool upstream = true;
    bool hasSessions() override { return sessions; }
    Task<QList<OJson>> positions() override {
        if (failPositions) throw ibkr::util::JsError(u"读不到持仓"_s);
        co_return rows;
    }
    Task<OJson> streamQuotes(QStringList) override { co_return js::object(); }
    Task<OJson> stockQuotes(QStringList) override { co_return js::object(); }
    Task<std::optional<double>> indexPrice(QString) override { co_return std::nullopt; }
    std::optional<OJson> spotInfo(const QString&) override { return std::nullopt; }
    bool upstreamOk() override { return upstream; }
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
    QList<OJson> updated;
    std::optional<QString> addFails;
    std::optional<QStringList> covered;
    QStringList pushed;
    QList<OJson> fills;
    std::optional<ibkr::domain::EtNow> et;
    bool pushFails = false;
    bool pushHangs = false;
    std::optional<ibkr::util::Deferred<>> hang;

    explicit SvcRig(bool enabled = true, bool trail = false, bool push = false) {
        OJson g = js::object({{u"enabled"_s, js::B(enabled)}, {u"trail_r"_s, js::B(trail)}});
        if (push) g.set(u"push"_s, js::object({{u"provider"_s, js::S(u"telegram"_s)}, {u"telegram_chat_id"_s, js::S(u"12345"_s)}}));
        host = std::make_unique<FakeHost>(settingsWith(dir.path(), g));
        svc = std::make_unique<orch::GuardService>(*host);
        orch::GuardWiring w;
        w.addTrack = [this](OJson params) -> Task<OJson> {
            if (addFails) throw ibkr::util::JsError(*addFails);
            added << params;
            // 同 tracker.add:按 key 在持仓(含组合行)里找那一行,落一条追踪
            const QString key = js::str(params.get(u"key"_s));
            for (const OJson& r : ibkr::domain::withCombos(port().rows)) {
                if (js::str(r.get(u"key"_s)) != key) continue;
                OJson targets = js::object();
                for (const QString& k : {u"take_profit"_s, u"stop_loss"_s, u"spot_stop_below"_s, u"spot_stop_above"_s, u"exit_at"_s})
                    if (const OJson* v = params.get(k)) targets.set(k, *v);
                const bool host = js::truthy(params.get(u"host_at_broker"_s));
                store().addTrack(js::object({{u"account"_s, *r.get(u"account"_s)}, {u"symbol"_s, *r.get(u"symbol"_s)}, {u"sec_type"_s, *r.get(u"sec_type"_s)},
                                             {u"leg"_s, r.get(u"leg"_s) ? *r.get(u"leg"_s) : js::S(QString())}, {u"targets"_s, targets},
                                             {u"auto_close"_s, js::object({{u"enabled"_s, js::B(host || js::truthy(params.get(u"auto_close"_s)))}, {u"host_at_broker"_s, js::B(host)}})}}));
            }
            co_return js::object({{u"track"_s, js::object()}});
        };
        // 同 tracker.update:给了目标就整套换成给的;auto_close 合并
        w.updateTrack = [this](OJson params) -> Task<OJson> {
            updated << params;
            const QString id = js::str(params.get(u"id"_s));
            const auto t = store().getTrack(id);
            if (!t) throw ibkr::util::JsError(u"没有这个追踪"_s);
            OJson fields = js::object();
            OJson targets = js::object();
            bool given = false;
            for (const QString& k : {u"take_profit"_s, u"stop_loss"_s, u"trail_pct"_s, u"spot_stop_below"_s, u"spot_stop_above"_s, u"exit_at"_s, u"take_profit_tiers"_s})
                if (const OJson* v = params.get(k)) {
                    targets.set(k, *v);
                    given = true;
                }
            if (given) fields.set(u"targets"_s, targets);
            if (const OJson* a = params.get(u"auto_close"_s)) {
                OJson merged = *t->get(u"auto_close"_s);
                for (const auto& [k, v] : a->fields) merged.set(k, v);
                fields.set(u"auto_close"_s, merged);
            }
            if (const OJson* e = params.get(u"enabled"_s)) {
                fields.set(u"enabled"_s, *e);
                // 同 tracker.update:重新启用 = 解开上一次触发的闩
                if (js::truthy(e)) {
                    fields.set(u"fired_at"_s, js::Null());
                    fields.set(u"fired_state"_s, js::S(QString()));
                }
            }
            store().updateTrack(id, fields);
            co_return js::object({{u"track"_s, js::object()}});
        };
        w.navOf = [](const QString&) -> std::optional<double> { return 15000.0; };
        w.coveredAccounts = [this] { return covered; };
        w.push = [this](QString title, QString body) -> Task<> {
            if (pushHangs) {
                hang.emplace();
                co_await hang->task();  // 一直不回(钥匙串弹窗没人点)
                co_return;
            }
            if (pushFails) throw ibkr::util::JsError(u"推送连不上"_s);
            pushed << title + u'|' + body;
            co_return;
        };
        w.runDir = dir.path() + u"/guard-run"_s;
        w.fillHistory = [this]() -> Task<QList<OJson>> { co_return fills; };
        w.clock = [this] { return et ? *et : ibkr::domain::nowEt(); };
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
        rig.store().guard().add(stockIntent(u"BE"_s, u"BUY"_s, 186));
        rig.port().rows = {stockRow(u"模拟"_s, u"GLD"_s, 5, 390, 395), stockRow(u"模拟"_s, u"BE"_s, 20, 195, 196)};
        const OJson t0 = rig.tick(0);
        QCOMPARE(js::num(js::path(&t0, {u"positions"_s, u"warned"_s})), 0.0);
        rig.tick(120000);
        // GLD 已有追踪管着:不动;BE 有意图:按意图挂了一次,没有违规
        QCOMPARE(rig.added.size(), 1);
        QCOMPARE(js::str(rig.added[0].get(u"key"_s)), u"模拟|BE|STK"_s);
        QVERIFY(!rig.auditActions().contains(u"guard_violation"_s));
        // 意图对应的持仓平掉了:意图自动关掉
        rig.port().rows = {stockRow(u"模拟"_s, u"GLD"_s, 5, 390, 395)};
        const OJson t2 = rig.tick(130000);
        QCOMPARE(js::num(js::path(&t2, {u"positions"_s, u"auto_closed"_s})), 1.0);
        QVERIFY(!rig.store().guard().openStock(u"模拟"_s, u"BE"_s));
    }
    // ================================================================ Step 2:按意图挂止损、守住止损
    void intentPositionGetsStopOnFirstTick() {
        SvcRig rig;
        rig.store().guard().add(stockIntent(u"BE"_s, u"BUY"_s, 186));
        rig.port().rows = {stockRow(u"模拟"_s, u"BE"_s, 20, 195.2, 196)};
        const OJson t0 = rig.tick(0);
        QCOMPARE(js::num(js::path(&t0, {u"positions"_s, u"placed"_s})), 1.0);
        QCOMPARE(rig.added.size(), 1);
        QCOMPARE(js::num(rig.added[0].get(u"stop_loss"_s)), 186.0);
        QVERIFY(js::truthy(rig.added[0].get(u"host_at_broker"_s)));
        QVERIFY(rig.auditActions().contains(u"guard_stop_placed"_s));
        // 追踪在了、止损对得上:之后每一轮什么都不做
        rig.tick(2000);
        rig.tick(4000);
        QCOMPARE(rig.added.size(), 1);
        QVERIFY(rig.updated.isEmpty());
    }
    void loosenedOrDisabledStopIsRestored() {
        SvcRig rig;
        rig.store().guard().add(stockIntent(u"BE"_s, u"BUY"_s, 186));
        const OJson t = rig.store().addTrack(js::object({{u"account"_s, js::S(u"模拟"_s)}, {u"symbol"_s, js::S(u"BE"_s)}, {u"sec_type"_s, js::S(u"STK"_s)},
                                                         {u"targets"_s, js::object({{u"stop_loss"_s, js::N(180)}, {u"take_profit"_s, js::N(230)}})},
                                                         {u"auto_close"_s, js::object({{u"enabled"_s, js::B(true)}, {u"host_at_broker"_s, js::B(true)}})}}));
        rig.port().rows = {stockRow(u"模拟"_s, u"BE"_s, 20, 195, 196)};
        const OJson t0 = rig.tick(0);
        QCOMPARE(js::num(js::path(&t0, {u"positions"_s, u"restored"_s})), 1.0);
        QCOMPARE(rig.updated.size(), 1);
        const OJson& u = rig.updated[0];
        QCOMPARE(js::num(u.get(u"stop_loss"_s)), 186.0);
        QCOMPARE(js::num(u.get(u"take_profit"_s)), 230.0);  // 其余目标原样带回去
        QVERIFY(rig.auditActions().contains(u"guard_violation"_s));
        // 有人在追踪页把它停掉:再恢复一次
        rig.store().updateTrack(js::str(t.get(u"id"_s)), js::object({{u"enabled"_s, js::B(false)}}));
        rig.tick(2000);
        QCOMPARE(rig.updated.size(), 2);
        QVERIFY(js::truthy(rig.updated[1].get(u"enabled"_s)));
        QVERIFY(js::truthy(rig.store().getTrack(js::str(t.get(u"id"_s)))->get(u"enabled"_s)));
    }
    void latchedTrackIsReArmed() {
        SvcRig rig;
        rig.store().guard().add(stockIntent(u"BE"_s, u"BUY"_s, 186));
        const OJson t = rig.store().addTrack(js::object({{u"account"_s, js::S(u"模拟"_s)}, {u"symbol"_s, js::S(u"BE"_s)}, {u"sec_type"_s, js::S(u"STK"_s)},
                                                         {u"targets"_s, js::object({{u"stop_loss"_s, js::N(186)}})},
                                                         {u"auto_close"_s, js::object({{u"enabled"_s, js::B(true)}, {u"host_at_broker"_s, js::B(true)}})}}));
        const QString id = js::str(t.get(u"id"_s));
        rig.port().rows = {stockRow(u"模拟"_s, u"BE"_s, 20, 195, 196)};
        // 刚触发:持仓可能还没来得及消失,不动
        rig.store().updateTrack(id, js::object({{u"fired_at"_s, js::S(QDateTime::currentDateTimeUtc().toString(Qt::ISODate))}, {u"fired_state"_s, js::S(u"stop_loss"_s)}}));
        rig.tick(0);
        QVERIFY(rig.updated.isEmpty());
        QVERIFY(rig.added.isEmpty());
        // 触发过一会儿了、仓位还在(平完又开了新仓):重新上膛,不算违规
        rig.store().updateTrack(id, js::object({{u"fired_at"_s, js::S(u"2026-11-01T15:00:00+00:00"_s)}}));
        rig.tick(2000);
        QCOMPARE(rig.updated.size(), 1);
        QCOMPARE(js::num(rig.updated[0].get(u"stop_loss"_s)), 186.0);
        QVERIFY(rig.auditActions().contains(u"guard_re_armed"_s));
        QVERIFY(!rig.auditActions().contains(u"guard_violation"_s));
        QVERIFY(js::nullish(rig.store().getTrack(id)->get(u"fired_at"_s)));
    }
    void latchedTrackWithoutIntentGetsDefaultStop() {
        SvcRig rig;
        const OJson t = rig.store().addTrack(js::object({{u"account"_s, js::S(u"模拟"_s)}, {u"symbol"_s, js::S(u"TTWO"_s)}, {u"sec_type"_s, js::S(u"STK"_s)},
                                                         {u"targets"_s, js::object({{u"stop_loss"_s, js::N(150)}, {u"take_profit"_s, js::N(260)}})},
                                                         {u"auto_close"_s, js::object({{u"enabled"_s, js::B(true)}, {u"host_at_broker"_s, js::B(true)}})}}));
        rig.store().updateTrack(js::str(t.get(u"id"_s)), js::object({{u"fired_at"_s, js::S(u"2026-11-01T15:00:00+00:00"_s)}}));
        rig.port().rows = {stockRow(u"模拟"_s, u"TTWO"_s, 20, 202.5, 212.66)};
        const OJson t0 = rig.tick(0);
        QCOMPARE(js::num(js::path(&t0, {u"positions"_s, u"warned"_s})), 1.0);  // 落了闩的追踪不算保护
        rig.tick(61000);
        QVERIFY(rig.added.isEmpty());
        QCOMPARE(rig.updated.size(), 1);
        QCOMPARE(js::num(rig.updated[0].get(u"stop_loss"_s)), 186.3);  // 默认规则重算(没取到日线:入场 × 0.92)
        QCOMPARE(js::num(rig.updated[0].get(u"take_profit"_s)), 260.0);
        QVERIFY(rig.auditActions().contains(u"guard_default_stop"_s));
    }
    void tighterStopIsLeftAlone() {
        SvcRig rig;
        rig.store().guard().add(stockIntent(u"BE"_s, u"BUY"_s, 186));
        rig.store().addTrack(js::object({{u"account"_s, js::S(u"模拟"_s)}, {u"symbol"_s, js::S(u"BE"_s)}, {u"sec_type"_s, js::S(u"STK"_s)},
                                         {u"targets"_s, js::object({{u"stop_loss"_s, js::N(190)}})},
                                         {u"auto_close"_s, js::object({{u"enabled"_s, js::B(true)}, {u"host_at_broker"_s, js::B(true)}})}}));
        rig.port().rows = {stockRow(u"模拟"_s, u"BE"_s, 20, 195, 196)};
        rig.tick(0);
        QVERIFY(rig.added.isEmpty());
        QVERIFY(rig.updated.isEmpty());
    }
    void shortIntentStopAbove() {
        SvcRig rig;
        rig.store().guard().add(stockIntent(u"XYZ"_s, u"SELL"_s, 54, 50));
        rig.port().rows = {stockRow(u"模拟"_s, u"XYZ"_s, -20, 50, 49)};
        rig.tick(0);
        QCOMPARE(rig.added.size(), 1);
        QCOMPARE(js::num(rig.added[0].get(u"stop_loss"_s)), 54.0);
    }
    void trailingRaisesOnlyUp() {
        SvcRig rig(true, true);
        rig.store().guard().add(stockIntent(u"BE"_s, u"BUY"_s, 186));
        rig.port().rows = {stockRow(u"模拟"_s, u"BE"_s, 20, 195, 196)};
        rig.tick(0);
        QCOMPARE(js::num(rig.added[0].get(u"stop_loss"_s)), 186.0);
        // R = 9。过 1R(204):抬到成本 195
        rig.port().rows = {stockRow(u"模拟"_s, u"BE"_s, 20, 195, 205)};
        const OJson t1 = rig.tick(2000);
        QCOMPARE(js::num(js::path(&t1, {u"positions"_s, u"raised"_s})), 1.0);
        QCOMPARE(rig.updated.size(), 1);
        QCOMPARE(js::num(rig.updated[0].get(u"stop_loss"_s)), 195.0);
        QVERIFY(rig.auditActions().contains(u"guard_stop_raised"_s));
        QVERIFY(!rig.auditActions().contains(u"guard_violation"_s));  // 跟踪上抬不是违规
        // 回落:不降
        rig.port().rows = {stockRow(u"模拟"_s, u"BE"_s, 20, 195, 199)};
        rig.tick(4000);
        QCOMPARE(rig.updated.size(), 1);
        // 过 2R(213):抬到 204
        rig.port().rows = {stockRow(u"模拟"_s, u"BE"_s, 20, 195, 214)};
        rig.tick(6000);
        QCOMPARE(rig.updated.size(), 2);
        QCOMPARE(js::num(rig.updated[1].get(u"stop_loss"_s)), 204.0);
    }
    void stockFloorRule() {
        QCOMPARE(gr::stockFloor(true, 195, 186, 196, true, std::nullopt), 186.0);
        QCOMPARE(gr::stockFloor(true, 195, 186, 204, true, std::nullopt), 195.0);
        QCOMPARE(gr::stockFloor(true, 195, 186, 213, true, std::nullopt), 204.0);
        QCOMPARE(gr::stockFloor(true, 195, 186, 190, true, 204.0), 204.0);  // 只升不降
        QCOMPARE(gr::stockFloor(true, 195, 186, 213, false, std::nullopt), 186.0);  // 没开跟踪
        QCOMPARE(gr::stockFloor(false, 50, 54, 46, true, std::nullopt), 50.0);  // 空头过 1R
        QCOMPARE(gr::stockFloor(false, 50, 54, 42, true, std::nullopt), 46.0);  // 空头过 2R
    }
    void externalCancelIsAViolation() {
        SvcRig rig;
        const OJson stk = js::object({{u"account"_s, js::S(u"模拟"_s)}, {u"symbol"_s, js::S(u"BE"_s)}, {u"sec_type"_s, js::S(u"STK"_s)}});
        rig.svc->onExternalCancel(stk, u"sl"_s, u"券商侧撤掉了这张托管单"_s);
        QVERIFY(rig.auditActions().contains(u"guard_violation"_s));
        QCOMPARE(rig.host->engine_.notifier_.titles.value(0), u"止损单被撤"_s);
        // 止盈单被撤、组合的单被撤:不算
        SvcRig other;
        other.svc->onExternalCancel(stk, u"tp"_s, u"x"_s);
        OJson bag = stk;
        bag.set(u"sec_type"_s, js::S(u"BAG"_s));
        other.svc->onExternalCancel(bag, u"sl"_s, u"x"_s);
        QVERIFY(other.auditActions().isEmpty());
    }
    void exitRulesParse() {
        const auto a = gr::parseExitRules(js::object({{u"take_profit"_s, js::S(u"中间价 >= 成本 × 2.5"_s)}, {u"stop_loss"_s, js::S(u"中间价 <= 成本 x 0.4"_s)},
                                                      {u"time_stop"_s, js::S(u"到期日 9:45 ET"_s)}, {u"level_stop"_s, js::S(u"标的收盘 < 647"_s)}}));
        QVERIFY2(a.error.isEmpty(), qPrintable(a.error));
        QCOMPARE(*a.take_profit_x, 2.5);
        QCOMPARE(*a.stop_loss_x, 0.4);
        QCOMPARE(a.time_stop_et, u"09:45"_s);
        QCOMPARE(*a.level_below, 647.0);
        const auto b = gr::parseExitRules(js::object({{u"take_profit_x"_s, js::N(3)}, {u"stop_loss_x"_s, js::N(0.5)}, {u"time_stop_et"_s, js::S(u"15:00"_s)},
                                                      {u"level_stop_above"_s, js::N(700)}}));
        QVERIFY(b.error.isEmpty());
        QCOMPARE(*b.level_above, 700.0);
        QVERIFY(!gr::parseExitRules(js::object({{u"take_profit"_s, js::S(u"翻倍"_s)}, {u"stop_loss"_s, js::S(u"× 0.4"_s)}, {u"time_stop"_s, js::S(u"15:00"_s)}})).error.isEmpty());
        QVERIFY(!gr::parseExitRules(js::object({{u"take_profit_x"_s, js::N(2)}, {u"stop_loss_x"_s, js::N(1.2)}, {u"time_stop_et"_s, js::S(u"15:00"_s)}})).error.isEmpty());
        const auto s = gr::parseStructure(u"QQQ 660/670/680 call fly"_s);
        QCOMPARE(s.strikes, (QList<double>{660, 670, 680}));
        QCOMPARE(s.right, u"C"_s);
        QCOMPARE(gr::parseStructure(u"SPX 7700/7725 put spread"_s).right, u"P"_s);
        // 贷方:拒
        QVERIFY(!gr::checkOptionIntent(js::object({{u"symbol"_s, js::S(u"SPX"_s)}, {u"structure"_s, js::S(u"7700/7725 put spread"_s)}, {u"expiry"_s, js::S(u"2026-11-09"_s)},
                                                   {u"cost_usd"_s, js::N(-120)}, {u"exit_rules"_s, js::object()}}),
                                       u"模拟"_s)
                     .ok);
    }
    void comboIntentTracksExits() {
        SvcRig rig;
        rig.store().guard().add(flyIntent(u"QQQ 660/670/680 call fly"_s));
        rig.port().rows = {optRow(u"模拟"_s, u"QQQ"_s, u"20261109"_s, 660, u"C"_s, 1, 1010), optRow(u"模拟"_s, u"QQQ"_s, u"20261109"_s, 670, u"C"_s, -2, 568),
                           optRow(u"模拟"_s, u"QQQ"_s, u"20261109"_s, 680, u"C"_s, 1, 281)};
        const OJson t0 = rig.tick(0, u"2026-11-06"_s);
        QCOMPARE(js::num(js::path(&t0, {u"positions"_s, u"combo_tracked"_s})), 1.0);
        QCOMPARE(rig.added.size(), 1);
        const OJson& p = rig.added[0];
        QVERIFY(js::str(p.get(u"key"_s)).contains(u"BAG"_s));
        QCOMPARE(js::num(p.get(u"take_profit"_s)), 3.93);  // 1.57 × 2.5
        QCOMPARE(js::num(p.get(u"stop_loss"_s)), 0.63);    // 1.57 × 0.4
        QVERIFY(!p.get(u"exit_at"_s));                     // 不是到期日:不写几点平
        QVERIFY(!js::truthy(p.get(u"host_at_broker"_s)));
        // 到期日当天:补上 15:00 平
        rig.tick(2000, u"2026-11-09"_s);
        QCOMPARE(rig.updated.size(), 1);
        QCOMPARE(js::str(rig.updated[0].get(u"exit_at"_s)), u"15:00"_s);
        QCOMPARE(js::num(rig.updated[0].get(u"take_profit"_s)), 3.93);
        rig.tick(4000, u"2026-11-09"_s);
        QCOMPARE(rig.updated.size(), 1);
        // 平掉了:意图自动关
        rig.port().rows = {};
        rig.tick(6000, u"2026-11-09"_s);
        QVERIFY(rig.store().guard().listOpen().isEmpty());
    }
    void interleavedFliesAreMatchedSeparately() {
        SvcRig rig;
        rig.store().guard().add(flyIntent(u"QQQ 660/670/680 call fly"_s));
        rig.store().guard().add(flyIntent(u"QQQ 650/660/670 call fly"_s));  // 持仓里没有这一只
        const QString e = u"20261109"_s;
        rig.port().rows = {optRow(u"模拟"_s, u"QQQ"_s, e, 660, u"C"_s, 1, 1010), optRow(u"模拟"_s, u"QQQ"_s, e, 664, u"C"_s, 1, 868),
                           optRow(u"模拟"_s, u"QQQ"_s, e, 670, u"C"_s, -2, 568),  optRow(u"模拟"_s, u"QQQ"_s, e, 674, u"C"_s, -2, 461),
                           optRow(u"模拟"_s, u"QQQ"_s, e, 680, u"C"_s, 1, 281),   optRow(u"模拟"_s, u"QQQ"_s, e, 684, u"C"_s, 1, 213)};
        // 两只交错的蝶在持仓里各成一条组合:660/670/680 那只认得出,建出场追踪
        const OJson t0 = rig.tick(0);
        QCOMPARE(js::num(js::path(&t0, {u"positions"_s, u"combo_tracked"_s})), 1.0);
        QCOMPARE(rig.added.size(), 1);
        QVERIFY2(js::str(rig.added[0].get(u"key"_s)).contains(u"660C"_s) && !js::str(rig.added[0].get(u"key"_s)).contains(u"664C"_s),
                 qPrintable(js::str(rig.added[0].get(u"key"_s))));
        // 同一到期日有组合、却没有这一只的:只说一次
        QCOMPARE(js::num(js::path(&t0, {u"positions"_s, u"combo_unmatched"_s})), 1.0);
        rig.tick(2000);
        QCOMPARE(rig.host->engine_.notifier_.titles.count(u"认不出这只组合"_s), 1);
        QCOMPARE(rig.store().guard().listOpen().size(), 2);  // 没出现过的那份不当成平了
    }
    void pushRequests() {
        const auto t = ibkr::orchestrate::guard_push::telegram(u"TOK"_s, u"42"_s, u"标题"_s, u"正文"_s);
        QCOMPARE(t.url, u"https://api.telegram.org/botTOK/sendMessage"_s);
        const auto tj = js::parse(QString::fromUtf8(t.body));
        QCOMPARE(js::str(tj->get(u"chat_id"_s)), u"42"_s);
        QCOMPARE(js::str(tj->get(u"text"_s)), u"标题\n正文"_s);
        const auto p = ibkr::orchestrate::guard_push::pushover(u"APP"_s, u"USR"_s, u"标题"_s, u"正文"_s);
        QCOMPARE(p.url, u"https://api.pushover.net/1/messages.json"_s);
        const auto pj = js::parse(QString::fromUtf8(p.body));
        QCOMPARE(js::str(pj->get(u"user"_s)), u"USR"_s);
        QCOMPARE(js::str(pj->get(u"message"_s)), u"正文"_s);
        ibkr::contract::GuardPushConfig none;
        QVERIFY(!ibkr::orchestrate::guard_push::configured(none));
        QVERIFY(ibkr::orchestrate::guard_push::build(none, u"TOK"_s, u"a"_s, u"b"_s).url.isEmpty());
        QTemporaryDir dir;
        bool threw = false;
        try {
            settingsWith(dir.path(), js::object({{u"push"_s, js::object({{u"provider"_s, js::S(u"telegram"_s)}})}}));
        } catch (const ibkr::util::JsError& e) {
            threw = e.message().contains(u"telegram_chat_id"_s);
        }
        QVERIFY(threw);
        // 数字的 chat_id 也收
        const auto s = settingsWith(dir.path(), js::object({{u"push"_s, js::object({{u"provider"_s, js::S(u"telegram"_s)}, {u"telegram_chat_id"_s, js::N(-1001)}})}}));
        QCOMPARE(s.guard.push.telegram_chat_id, u"-1001"_s);
        QCOMPARE(s.guard.heartbeat_s, 300.0);
        QCOMPARE(s.guard.disconnect_alert_s, 120.0);
    }
    void violationsArePushedAndDeduped() {
        SvcRig rig(true, false, true);
        rig.port().rows = {stockRow(u"模拟"_s, u"TTWO"_s, 20, 202.5, 212.66)};
        rig.tick(0);
        QCOMPARE(rig.pushed.size(), 1);
        QVERIFY(rig.pushed[0].startsWith(u"Datrix:股票仓位没有交易意图|"_s));
        // 意图收下的本机通知不推
        rig.writeInbox({u"{\"symbol\":\"BE\",\"side\":\"BUY\",\"qty\":10,\"entry_price\":195,\"stop_price\":186,\"stop_reason\":\"r\"}"_s});
        rig.tick(1000);
        QCOMPARE(rig.pushed.size(), 1);
        // 同一句话 10 分钟内只推一次
        const OJson stk = js::object({{u"account"_s, js::S(u"模拟"_s)}, {u"symbol"_s, js::S(u"BE"_s)}, {u"sec_type"_s, js::S(u"STK"_s)}});
        rig.svc->onExternalCancel(stk, u"sl"_s, u"x"_s);
        rig.svc->onExternalCancel(stk, u"sl"_s, u"x"_s);
        rig.tick(2000);
        QCOMPARE(rig.pushed.size(), 2);
    }
    void pushRetriesAndSaysHowLate() {
        double clock = 1'800'000'000'000.0;
        ibkr::util::setDateNowForTests([&clock] { return clock; });
        SvcRig rig(true, false, true);
        rig.pushFails = true;
        rig.svc->onFired(u"模拟"_s, u"BE"_s, u"stop_loss"_s, u"券商侧托管单成交"_s);
        rig.tick(0);
        QVERIFY(rig.pushed.isEmpty());
        QCOMPARE(rig.svc->pendingPushes(), 1);
        rig.pushFails = false;
        rig.tick(10'000);  // 30 秒退避里:不再试
        QVERIFY(rig.pushed.isEmpty());
        clock += 5 * 60'000;
        rig.tick(31'000);
        QCOMPARE(rig.pushed.size(), 1);
        QVERIFY2(rig.pushed[0].startsWith(u"Datrix:止损触发|BE 止损"_s), qPrintable(rig.pushed[0]));
        QVERIFY2(rig.pushed[0].contains(u"推送延迟 5 分钟"_s), qPrintable(rig.pushed[0]));
        QCOMPARE(rig.svc->pendingPushes(), 0);
        ibkr::util::setDateNowForTests({});
    }
    void stuckPushDoesNotHoldTheTick() {
        SvcRig rig(true, false, true);
        rig.pushHangs = true;
        rig.port().rows = {stockRow(u"模拟"_s, u"TTWO"_s, 20, 202.5, 212.66)};
        rig.tick(0);  // wait() 里 5 秒没跑完会 qFatal
        rig.tick(61000);
        QCOMPARE(rig.added.size(), 1);  // 推送卡着,默认止损照挂
        QCOMPARE(rig.svc->pendingPushes(), 2);
        rig.hang->resolve();
    }
    void disconnectPushedOnceThenRecovery() {
        SvcRig rig(true, false, true);
        rig.port().upstream = false;  // TWS 与 IBKR 服务器断开(1100 / 2110)也算
        rig.tick(0);
        rig.tick(100'000);
        QVERIFY(rig.pushed.isEmpty());
        rig.tick(121'000);
        QCOMPARE(rig.pushed.size(), 1);
        QVERIFY(rig.pushed[0].startsWith(u"Datrix:IBKR 断开|"_s));
        rig.tick(200'000);
        QCOMPARE(rig.pushed.size(), 1);
        rig.port().upstream = true;
        rig.tick(400'000);
        QCOMPARE(rig.pushed.size(), 2);
        QVERIFY2(rig.pushed[1].contains(u"断了约 7 分钟"_s), qPrintable(rig.pushed[1]));
        // 心跳:断着时持仓数写 null
        rig.port().sessions = false;
        rig.tick(450'000);
        rig.tick(800'000);
        QFile f(QFileInfo(rig.svc->inboxPath()).path() + u"/heartbeat.json"_s);
        QVERIFY(f.open(QIODevice::ReadOnly));
        QVERIFY(js::nullish(js::parse(QString::fromUtf8(f.readAll()))->get(u"n_positions"_s)));
        rig.port().sessions = true;
        rig.tick(810'000);
        const qsizetype before = rig.pushed.size();
        QVERIFY(rig.auditActions().contains(u"guard_disconnect"_s));
        QVERIFY(rig.auditActions().contains(u"guard_reconnect"_s));
        // 两分钟内恢复的不推
        rig.port().sessions = false;
        rig.tick(900'000);
        rig.port().sessions = true;
        rig.tick(960'000);
        QCOMPARE(rig.pushed.size(), before);
    }
    void heartbeatFile() {
        SvcRig rig;
        rig.port().rows = {stockRow(u"模拟"_s, u"TTWO"_s, 20, 202.5, 212.66)};
        rig.store().addTrack(js::object({{u"account"_s, js::S(u"模拟"_s)}, {u"symbol"_s, js::S(u"TTWO"_s)}, {u"sec_type"_s, js::S(u"STK"_s)},
                                         {u"targets"_s, js::object({{u"stop_loss"_s, js::N(190)}})},
                                         {u"auto_close"_s, js::object({{u"enabled"_s, js::B(true)}, {u"host_at_broker"_s, js::B(true)}})}}));
        rig.tick(0);
        const QString path = QFileInfo(rig.svc->inboxPath()).path() + u"/heartbeat.json"_s;
        QFile f(path);
        QVERIFY(f.open(QIODevice::ReadOnly));
        const auto hb = js::parse(QString::fromUtf8(f.readAll()));
        f.close();
        QVERIFY(hb);
        QVERIFY(js::truthy(hb->get(u"ib_connected"_s)));
        QCOMPARE(js::num(hb->get(u"n_positions"_s)), 1.0);
        QCOMPARE(js::num(hb->get(u"n_stops"_s)), 1.0);
        QVERIFY(js::nullish(hb->get(u"last_price_change"_s)));
        // 五分钟之后再写;价变过就记下时刻
        rig.port().rows = {stockRow(u"模拟"_s, u"TTWO"_s, 20, 202.5, 213.10)};
        rig.tick(2000);
        rig.tick(300'000);
        QVERIFY(f.open(QIODevice::ReadOnly));
        const auto hb2 = js::parse(QString::fromUtf8(f.readAll()));
        QVERIFY(js::isStr(hb2->get(u"last_price_change"_s)));
    }
    void restartMarkersArePushedOnce() {
        SvcRig rig(true, false, true);
        const QString runDir = rig.dir.path() + u"/guard-run"_s;
        ibkr::util::run_marker::markRunning(runDir, u"app"_s);
        ibkr::util::run_marker::markRunning(runDir, u"app"_s);  // 上一次的还在:改名成 crashed
        QVERIFY(QFile::exists(runDir + u"/app.crashed"_s));
        ibkr::util::run_marker::markRunning(runDir, u"engine"_s);
        ibkr::util::run_marker::markStopped(runDir, u"engine"_s);
        ibkr::util::run_marker::markRunning(runDir, u"engine"_s);  // 正常退出过:不算崩
        QVERIFY(!QFile::exists(runDir + u"/engine.crashed"_s));
        rig.tick(0);
        QCOMPARE(rig.pushed.size(), 1);
        QVERIFY(rig.pushed[0].startsWith(u"Datrix:Datrix重启了|"_s));
        QVERIFY(!QFile::exists(runDir + u"/app.crashed"_s));
        QVERIFY(rig.auditActions().contains(u"guard_restart"_s));
        rig.tick(1000);
        QCOMPARE(rig.pushed.size(), 1);
    }
    void pushTestCommand() {
        SvcRig rig(true, false, true);
        rig.writeInbox({u"{\"push_test\": true}"_s});
        rig.tick(0);
        QCOMPARE(rig.pushed.size(), 1);
        QVERIFY(rig.pushed[0].startsWith(u"Datrix:测试推送|"_s));
        // 没配推送:拒并说明
        SvcRig bare;
        bare.writeInbox({u"{\"push_test\": true}"_s});
        const OJson out = bare.svc->ingestInbox();
        QCOMPARE(js::num(out.get(u"rejected"_s)), 1.0);
    }
    // ================================================================ Step 4:每日报告
    void reportMatchesSpecSample() {
        namespace rp = ibkr::analysis::guard_report;
        rp::Input in;
        in.date = u"2026-11-06"_s;
        in.accounts = {rp::Account{u"主账户"_s, 15165.0, -0.6}};
        in.opened = {u"QQQ 660/670/680 fly ×1（有意图）"_s};
        in.violations = {u"BE 手动买入无意图记录，默认止损已挂 @179.4"_s};
        in.expiring = {u"QQQ fly ×2（11/09）"_s};
        const QString want = u"datrix guard 2026-11-06\n"
                             u"净值 $15,165（-0.6%）\n"
                             u"开仓：QQQ 660/670/680 fly ×1（有意图）\n"
                             u"止损触发：无\n"
                             u"违规：BE 手动买入无意图记录，默认止损已挂 @179.4\n"
                             u"明日到期：QQQ fly ×2（11/09）\n"
                             u"心跳：正常，断线 0 次"_s;
        QCOMPARE(rp::build(in), want);
        // 周五多两行;多个账户各一行
        in.friday = true;
        in.weekViolations = 3;
        in.weekStops = 1;
        in.weekTrades = {rp::WeekTrade{u"BE"_s, 1.0, {}}, rp::WeekTrade{u"AXTX"_s, std::nullopt, u"无止损"_s}};
        in.accounts.append(rp::Account{u"账户3311"_s, 1234567.4, std::nullopt});
        const QString got = rp::build(in);
        QVERIFY2(got.contains(u"净值 主账户 $15,165（-0.6%）\n净值 账户3311 $1,234,567\n"_s), qPrintable(got));
        QVERIFY2(got.endsWith(u"本周：违规 3 次，止损触发 1 次\n本周 R 倍数：BE +1.0R；AXTX —（无止损）"_s), qPrintable(got));
        QCOMPARE(rp::pct(0.04), u"0.0%"_s);
        QCOMPARE(rp::pct(0.44), u"+0.4%"_s);
    }
    void ordersOpensAndRMultiples() {
        namespace rp = ibkr::analysis::guard_report;
        const auto f = [](const QString& st, const QString& sym, const QString& side, double qty, double px, const QString& perm, const QString& date, double k = 0,
                          const QString& right = {}) {
            rp::Fill x;
            x.alias = u"模拟"_s;
            x.secType = st;
            x.symbol = sym;
            x.side = side;
            x.shares = qty;
            x.price = px;
            x.permId = perm;
            x.etDate = date;
            x.time = date + u"T15:00:00Z"_s;
            x.strike = k;
            x.right = right;
            x.expiry = st == u"STK" ? QString() : u"20261109"_s;
            return x;
        };
        const QList<rp::Fill> fills{
            f(u"STK"_s, u"BE"_s, u"BOT"_s, 20, 195, u"1"_s, u"2026-11-02"_s),
            f(u"STK"_s, u"BE"_s, u"SLD"_s, 10, 204, u"2"_s, u"2026-11-04"_s),
            f(u"STK"_s, u"BE"_s, u"SLD"_s, 10, 204, u"3"_s, u"2026-11-05"_s),
            f(u"BAG"_s, u"QQQ"_s, u"BOT"_s, 1, 1.57, u"9"_s, u"2026-11-06"_s),
            f(u"OPT"_s, u"QQQ"_s, u"BOT"_s, 1, 10.1, u"9"_s, u"2026-11-06"_s, 660, u"C"_s),
            f(u"OPT"_s, u"QQQ"_s, u"SLD"_s, 2, 5.68, u"9"_s, u"2026-11-06"_s, 670, u"C"_s),
            f(u"OPT"_s, u"QQQ"_s, u"BOT"_s, 1, 2.8, u"9"_s, u"2026-11-06"_s, 680, u"C"_s),
        };
        const QList<rp::Order> orders = rp::groupOrders(fills);
        QCOMPARE(orders.size(), 4);
        const rp::Order& fly = orders.last();
        QCOMPARE(fly.kind, u"combo"_s);
        QCOMPARE(fly.label(), u"QQQ 660/670/680 call fly"_s);
        QCOMPARE(fly.qty, 1.0);
        const QHash<QString, double> held{{u"模拟|QQQ|20261109|660|C"_s, 1}, {u"模拟|QQQ|20261109|670|C"_s, -2}, {u"模拟|QQQ|20261109|680|C"_s, 1}};
        QVERIFY(rp::isOpen(fly, held));
        QVERIFY(!rp::isOpen(orders[0], held));  // BE 已经平光
        const QList<rp::Trade> trades = rp::closedTrades(orders, u"2026-11-02"_s, held);
        QCOMPARE(trades.size(), 1);  // 蝶还拿着,不算做完
        QCOMPARE(trades[0].label, u"BE"_s);
        QCOMPARE(trades[0].entry, 195.0);
        QCOMPARE(trades[0].exit, 204.0);
        QCOMPARE(*rp::rMultiple(trades[0], 186.0), 1.0);  // (204 − 195) ÷ (195 − 186)
        QVERIFY(!rp::rMultiple(trades[0], std::nullopt));
        QVERIFY(!rp::rMultiple(trades[0], 200.0));  // 止损在入场价上方:不对
    }
    void dailyReportSentOncePerDay() {
        SvcRig rig(true, false, true);
        const QString id = rig.host->settings_.accountByAlias(u"模拟"_s)->account_id;
        // 周五 16:10 美东:还没到 16:15
        rig.et = etAtUtc(u"2026-11-06T21:10:00Z"_s);
        rig.port().rows = {stockRow(u"模拟"_s, u"TTWO"_s, 20, 202.5, 212.66),
                           optRow(u"模拟"_s, u"QQQ"_s, u"20261109"_s, 660, u"C"_s, 1, 1010), optRow(u"模拟"_s, u"QQQ"_s, u"20261109"_s, 670, u"C"_s, -2, 568),
                           optRow(u"模拟"_s, u"QQQ"_s, u"20261109"_s, 680, u"C"_s, 1, 281)};
        // 美东 10:30 买的蝶(北京时间已经是周六凌晨,TWS 的"今天"早翻篇了);周一买 BE、周三卖光
        rig.fills = {fillOf(id, u"BAG"_s, u"QQQ"_s, u"BOT"_s, 1, 1.57, u"2026-11-06T15:30:00Z"_s, 9),
                     fillOf(id, u"OPT"_s, u"QQQ"_s, u"BOT"_s, 1, 10.1, u"2026-11-06T15:30:00Z"_s, 9, 660, u"C"_s, u"20261109"_s),
                     fillOf(id, u"OPT"_s, u"QQQ"_s, u"SLD"_s, 2, 5.68, u"2026-11-06T15:30:00Z"_s, 9, 670, u"C"_s, u"20261109"_s),
                     fillOf(id, u"OPT"_s, u"QQQ"_s, u"BOT"_s, 1, 2.8, u"2026-11-06T15:30:00Z"_s, 9, 680, u"C"_s, u"20261109"_s),
                     fillOf(id, u"STK"_s, u"BE"_s, u"BOT"_s, 20, 195, u"2026-11-02T15:00:00Z"_s, 1),
                     fillOf(id, u"STK"_s, u"BE"_s, u"SLD"_s, 20, 204, u"2026-11-04T15:00:00Z"_s, 2)};
        // 周一建过 BE 的意图(止损 186);上一份报告的净值 15,100
        rig.store().guard().add(stockIntent(u"BE"_s, u"BUY"_s, 186));
        ibkr::util::sqlite::Database db(rig.host->settings_.db_path);
        db.prepare(u"UPDATE guard_intents SET created_at='2026-11-01T00:00:00Z'"_s).run();
        const OJson prevReport = js::object({{u"date"_s, js::S(u"2026-11-05"_s)}, {u"navs"_s, js::object({{u"模拟"_s, js::N(15100)}})}});
        rig.store().audit(u"guard"_s, u"guard_report"_s, &prevReport);
        rig.tick(0);
        QVERIFY(!rig.pushed.join(u'\n').contains(u"每日报告"_s));
        // 16:20:发
        rig.et = etAtUtc(u"2026-11-06T21:20:00Z"_s);
        rig.tick(1000);
        QString report;
        for (const QString& p : rig.pushed)
            if (p.startsWith(u"Datrix:每日报告 2026-11-06|"_s)) report = p.section(u'|', 1);
        QVERIFY2(!report.isEmpty(), qPrintable(rig.pushed.join(u"\n---\n"_s)));
        QVERIFY2(report.startsWith(u"datrix guard 2026-11-06\n"_s), qPrintable(report));
        // 假的净值三个账户都给 15,000:三行,带别名;只有「模拟」有上一份可比
        QVERIFY2(report.contains(u"净值 模拟 $15,000（-0.7%）\n净值 主账户 $15,000\n"_s), qPrintable(report));
        QVERIFY2(report.contains(u"开仓：QQQ 660/670/680 call fly ×1（无意图）"_s), qPrintable(report));
        QVERIFY2(report.contains(u"明日到期：QQQ 660/670/680 call fly ×1（11/09）"_s), qPrintable(report));
        QVERIFY2(report.contains(u"本周 R 倍数：BE +1.0R"_s), qPrintable(report));
        QVERIFY2(report.contains(u"违规：TTWO 手动买入无意图记录"_s), qPrintable(report));
        QVERIFY(!report.contains(id));  // 账号不进报告
        QVERIFY(QFile::exists(QFileInfo(rig.svc->inboxPath()).path() + u"/reports/2026-11-06.txt"_s));
        QVERIFY(rig.auditActions().contains(u"guard_report"_s));
        // 同一天不再发;换一个服务实例(重启)也不再发
        const qsizetype n = rig.pushed.size();
        rig.tick(2000);
        rig.svc = std::make_unique<orch::GuardService>(*rig.host);
        orch::GuardWiring w;
        w.push = [&rig](QString t, QString b) -> Task<> {
            rig.pushed << t + u'|' + b;
            co_return;
        };
        w.fillHistory = [&rig]() -> Task<QList<OJson>> { co_return rig.fills; };
        w.clock = [&rig] { return *rig.et; };
        rig.svc->attach(std::move(w));
        rig.tick(3000);
        QCOMPARE(rig.pushed.filter(u"每日报告"_s).size(), 1);
        (void)n;
    }
    void reportWaitsForTwsThenFallsBackAtEight() {
        SvcRig rig(true, false, true);
        rig.port().sessions = false;  // 10:45 自动登出了,还没登回来
        rig.et = etAtUtc(u"2026-11-06T21:20:00Z"_s);  // 16:20
        rig.tick(0);
        QVERIFY(rig.pushed.filter(u"每日报告"_s).isEmpty());
        // 17:00 登回来了:发完整的
        rig.port().sessions = true;
        rig.port().rows = {stockRow(u"模拟"_s, u"TTWO"_s, 20, 202.5, 212.66)};
        rig.et = etAtUtc(u"2026-11-06T22:00:00Z"_s);
        rig.tick(1000);
        const QStringList sent = rig.pushed.filter(u"每日报告"_s);
        QCOMPARE(sent.size(), 1);
        QVERIFY(!sent[0].contains(u"TWS 断开"_s));
        QVERIFY(sent[0].contains(u"心跳：正常"_s));

        // 另一天一直断着:20:00 之前不发,20:00 发一份注明断开的
        SvcRig off(true, false, true);
        off.port().sessions = false;
        off.et = etAtUtc(u"2026-11-05T21:20:00Z"_s);
        off.tick(0);
        off.et = etAtUtc(u"2026-11-06T00:59:00Z"_s);  // 美东 11-05 19:59
        off.tick(1000);
        QVERIFY(off.pushed.filter(u"每日报告"_s).isEmpty());
        off.et = etAtUtc(u"2026-11-06T01:00:00Z"_s);  // 美东 11-05 20:00
        off.tick(2000);
        const QStringList late = off.pushed.filter(u"每日报告"_s);
        QCOMPARE(late.size(), 1);
        QVERIFY2(late[0].contains(u"datrix guard 2026-11-05\nTWS 断开"_s), qPrintable(late[0]));
        QVERIFY(late[0].contains(u"心跳：断开中"_s));
    }
    void noReportOnWeekend() {
        SvcRig rig(true, false, true);
        rig.et = etAtUtc(u"2026-11-07T21:20:00Z"_s);  // 周六
        rig.tick(0);
        QVERIFY(rig.pushed.filter(u"每日报告"_s).isEmpty());
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
            "\"exit_rules\":{\"take_profit\":\"中间价 >= 成本 × 2.5\",\"stop_loss\":\"中间价 <= 成本 × 0.4\",\"time_stop\":\"到期日 15:00 ET\"}}"_s,
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
