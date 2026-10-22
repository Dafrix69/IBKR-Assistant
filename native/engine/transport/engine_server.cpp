#include "transport/engine_server.h"

#include "analysis/macro.h"
#include "domain/day_logs.h"
#include "domain/store.h"
#include "execution/broker.h"
#include "execution/qualify_gate.h"
#include "orchestrate/engine.h"
#include "orchestrate/services/alerts_service.h"
#include "orchestrate/services/anomaly_service.h"
#include "orchestrate/services/assignment_watch.h"
#include "orchestrate/services/broker_link.h"
#include "orchestrate/services/events.h"
#include "orchestrate/services/fill_sync.h"
#include "orchestrate/services/fly_planner.h"
#include "orchestrate/services/follow_service.h"
#include "orchestrate/services/idea_semantic.h"
#include "orchestrate/services/intel.h"
#include "orchestrate/services/iv_recorder.h"
#include "orchestrate/services/market_data.h"
#include "orchestrate/services/playbook_service.h"
#include "orchestrate/services/pool.h"
#include "orchestrate/services/public_fetch.h"
#include "orchestrate/services/similar_context.h"
#include "orchestrate/services/stock_trips.h"
#include "orchestrate/services/trade_history.h"
#include "parsing/providers.h"
#include "transport/context.h"
#include "transport/handlers/connection_handlers.h"
#include "transport/handlers/handler_ports.h"
#include "transport/handlers/handlers1_adapters.h"
#include "transport/handlers/handlers2.h"
#include "transport/handlers/handlers2_adapters.h"
#include "transport/handlers/settings_handlers.h"
#include "transport/handlers/system_handlers.h"
#include "transport/handlers/tracker_handlers.h"
#include "transport/handlers/trading_handlers.h"
#include "util/jsobj.h"
#include "util/killswitch.h"
#include "util/notify.h"

#include <QDateTime>
#include <QFileInfo>
#include <QTimer>

#include <vector>

namespace ibkr::rpc {

using namespace Qt::StringLiterals;
namespace js = util::js;
namespace orch = ibkr::orchestrate;
using util::OJson;
template <class T = void>
using Task = util::Task<T>;

namespace {

bool inTestMode() { return !qEnvironmentVariable("IBKR_ENGINE_FAKE_LLM").isEmpty(); }

/// golden-rpc.spec.ts 的 FakeParser(只在测试模式用)
class GoldenParser final : public parsing::providers::Parser {
public:
    QString provider() const override { return u"fake"_s; }
    const contract::LLMConfig& config() const override { return cfg_; }
    Task<parsing::providers::LLMResponse> parse(parsing::prompts::PromptBundle bundle, QString) override {
        static const QString payload = QStringLiteral(
            R"({"orders":[{"intent_summary":"限价 230 买入 100 股 AAPL","contract":{"secType":"STK","symbol":"AAPL","exchange":"SMART","currency":"USD"},)"
            R"("execution_type":"IMMEDIATE","trigger":null,"account":"DEFAULT","order":{"action":"BUY","orderType":"LMT","totalQuantity":100,)"
            R"("price_mode":"EXPLICIT","lmtPrice":230.0,"tif":"DAY","outsideRth":false},"reason":"回调到位","confidence":0.99,"warnings":[]}],)"
            R"("rejections":[{"original_text":"顺便梭哈","code":"UNCLEAR","message":"「梭哈」没有明确数量与标的,拒绝。"}]})");
        parsing::providers::LLMResponse r;
        r.text = payload;
        r.model = js::S(u"fake-model"_s);
        r.prompt_version = bundle.version;
        r.prompt_fingerprint = parsing::prompts::fingerprint(bundle);
        r.latency_ms = 5;
        r.usage = js::object({{u"input_tokens"_s, js::N(100)}, {u"output_tokens"_s, js::N(50)}});
        co_return r;
    }
    Task<OJson> completeJson(QString, QString, OJson schema) override {
        struct Canned {
            const char* marker;
            const char16_t* json;
        };
        static const Canned table[] = {
            {"stocks", uR"J({"stocks":[{"symbol":"NVDA","company":"英伟达","reason":"AI 芯片份额第一","tag":"芯片"},{"symbol":"AMD","company":"AMD","reason":"数据中心第二供应商","tag":"芯片"}]})J"},
            {"entry", uR"J({"entry":[{"left":{"kind":"indicator","name":"macd_hist"},"op":"cross_up","right":{"kind":"const","value":0.0}}],"exit":[]})J"},
            {"themes", uR"J({"summary":"偏好半导体尾盘动量,想法多带明确价位","themes":["半导体(2 条)"],"lessons":["想法带价位条件的更可执行"],"patterns":["具体价位 + 条件的想法质量高"],"actions":["把尾盘动量写成可回测的规则"]})J"},
            {"summary", uR"J({"summary":"回调加仓想法与当前动能匹配度一般","thesis":"需要价格站回均线之上","checks":["财报日期"],"risks":["波动率偏高"],"suggestion":"等回调到锚点再考虑"})J"},
            {"reading", uR"J({"summary":"结构偏多","reading":"高点抬高。","watch":["盯 450"],"risks":["假突破"]})J"},
        };
        const OJson* props = js::prop(&schema, u"properties"_s);
        for (const Canned& c : table) {
            if (props && props->get(QString::fromLatin1(c.marker))) co_return *js::parse(QString::fromUtf16(c.json));
        }
        QStringList keys = js::keys(props);
        keys.sort();
        throw util::JsError(u"没有匹配的假响应:"_s + keys.join(u","_s));
    }
    Task<parsing::providers::TestProbe> test(std::optional<QString>) override { co_return parsing::providers::TestProbe{}; }

private:
    contract::LLMConfig cfg_;
};

}  // namespace

// ======================================================================
// 状态与适配类
// ======================================================================
struct EngineServer::Impl {
    Impl(RpcServer& s, domain::Settings st, std::optional<QString> path) : server(s), settings(std::move(st)), settingsPath(std::move(path)), test(inTestMode()) {}
    ~Impl();

    class RpcCtx;
    class Svc1HostA;
    class LinkHostA;
    class PortsA;

    RpcServer& server;
    domain::Settings settings;
    std::optional<QString> settingsPath;
    bool test;
    std::shared_ptr<execution::BrokerRouter> router;
    /// 当前引擎用的是哪个 BrokerRouter(retire 时比,同一个才接回报账)
    std::shared_ptr<execution::BrokerRouter> engineBroker;
    std::unique_ptr<orch::TradingEngine> engineInstance;
    /// 被换下来的引擎一个都不放手:会话上的监听闭包只拿它的存活标志,它没了闭包就聋了
    std::vector<std::unique_ptr<orch::TradingEngine>> retiredAll;
    orch::TradingEngine* retired = nullptr;
    std::shared_ptr<execution::BrokerRouter> retiredBroker;
    SerialLock trackerLock;

    std::unique_ptr<RpcCtx> ctx;
    std::unique_ptr<Svc1HostA> host;
    std::unique_ptr<LinkHostA> linkHost;
    std::unique_ptr<PortsA> ports;
    std::unique_ptr<EnginePort> enginePort;
    orch::TradingEngine* enginePortFor = nullptr;
    std::shared_ptr<Handlers1Router> routerPort;
    std::shared_ptr<execution::BrokerRouter> routerPortFor;
    std::unique_ptr<AlertsPort> alertsPort;
    std::unique_ptr<BrokerLinkPort> linkPort;
    std::unique_ptr<Handlers2Ports> ports2;

    // 带状态的编排
    std::unique_ptr<orch::MarketDataService> market;
    std::unique_ptr<orch::AlertsService> alerts;
    std::unique_ptr<orch::AnomalyService> anomaly;
    std::unique_ptr<orch::PoolService> pool;
    std::unique_ptr<orch::StockTripsService> stockTrips;
    std::unique_ptr<orch::FillSyncService> fillSync;
    std::unique_ptr<orch::AssignmentWatchService> assignmentWatch;
    std::unique_ptr<orch::TradeHistoryService> tradeHistory;
    std::unique_ptr<orch::SimilarContextService> similarContext;
    std::unique_ptr<orch::IdeaSemanticService> ideaSemantic;
    std::unique_ptr<orch::BrokerLinkService> brokerLink;
    std::unique_ptr<orch::FlyPlannerService> flyPlanner;
    std::unique_ptr<orch::IvRecorderService> ivRecorder;
    std::unique_ptr<orch::PlaybookService> playbook;
    std::unique_ptr<orch::FollowService> follow;
    std::unique_ptr<orch::EventsService> events;
    std::unique_ptr<orch::IntelService> intel;
    std::vector<std::unique_ptr<HandlerBase>> domains;
    QTimer* warmTimer = nullptr;

    std::shared_ptr<parsing::providers::Parser> parserFor(const contract::LLMConfig& cfg);
    orch::TradingEngine& engine();
    void dropEngine();
    void reload();
    void retire(orch::TradingEngine& old);
    void deliverOrderStatus(const OJson& trade);
    EnginePort& enginePortNow();
    std::shared_ptr<Handlers1Router> routerPortNow();
    void warmSpot();
};

/// RpcContext(各域 handler 看到的)
class EngineServer::Impl::RpcCtx final : public RpcContext {
public:
    explicit RpcCtx(Impl& i) : i_(i) {}
    const domain::Settings& settings() const override { return i_.settings; }
    std::shared_ptr<orch::Router> router() const override { return i_.router; }
    orch::TradingEngine& engine() override { return i_.engine(); }
    void emitEvent(const QString& event, const OJson& payload) override { i_.server.emitEvent(event, payload); }
    void setSettings(domain::Settings s) override { i_.settings = std::move(s); }
    void setRouter(std::shared_ptr<orch::Router> r) override { i_.router = std::move(r); }
    orch::TradingEngine* engineBuilt() const override { return i_.engineInstance.get(); }
    std::shared_ptr<Parser> parserFactory(const contract::LLMConfig&) override { return nullptr; }  // handler 经 Handlers2Ports 取解析器,不经这里
    void reload() override { i_.reload(); }
    void dropEngine() override { i_.dropEngine(); }
    SerialLock& trackerLock() override { return i_.trackerLock; }

private:
    Impl& i_;
};

/// service 看到的宿主(Svc1Host 是 SvcHost 的超集,svc2 的 service 也用它)
class EngineServer::Impl::Svc1HostA final : public orch::Svc1Host {
public:
    explicit Svc1HostA(Impl& i) : i_(i) {}
    const domain::Settings& settings() const override { return i_.settings; }
    std::shared_ptr<orch::Router> router() const override { return i_.router; }
    orch::TradingEngine& engine() override { return i_.engine(); }
    void emitEvent(const QString& event, const OJson& payload) override { i_.server.emitEvent(event, payload); }
    std::shared_ptr<execution::BrokerRouter> broker() const override { return i_.router; }
    orch::SvcEngine& svcEngine() override { return i_.engine().svcView(); }
    orch::Svc1Engine& svc1Engine() override { return i_.engine().svc1(); }
    void stderrLine(const QString& line) override { fprintf(stderr, "%s\n", line.toUtf8().constData()); }

private:
    Impl& i_;
};

class EngineServer::Impl::LinkHostA final : public orch::BrokerLinkHost {
public:
    explicit LinkHostA(Impl& i) : i_(i) {}
    const domain::Settings& settings() const override { return i_.settings; }
    std::shared_ptr<orch::Router> router() const override { return i_.router; }
    orch::TradingEngine& engine() override { return i_.engine(); }
    void emitEvent(const QString& event, const OJson& payload) override { i_.server.emitEvent(event, payload); }
    std::shared_ptr<execution::BrokerRouter> broker() const override { return i_.router; }
    orch::SvcEngine& svcEngine() override { return i_.engine().svcView(); }
    void setBroker(std::shared_ptr<execution::BrokerRouter> r) override { i_.router = std::move(r); }
    void dropEngine() override { i_.dropEngine(); }

private:
    Impl& i_;
};

/// handlers1 的宿主面
class EngineServer::Impl::PortsA final : public Handlers1Ports {
public:
    explicit PortsA(Impl& i) : i_(i) {}
    EnginePort& engine() override { return i_.enginePortNow(); }
    EnginePort* engineBuilt() override { return i_.engineInstance ? &i_.enginePortNow() : nullptr; }
    std::shared_ptr<Handlers1Router> router() override { return i_.routerPortNow(); }
    void clearRouter() override {
        i_.router.reset();
        i_.routerPort.reset();
    }
    AlertsPort& alerts() override { return *i_.alertsPort; }
    BrokerLinkPort& brokerLink() override { return *i_.linkPort; }
    QStringList resolveFanoutAccounts(const domain::Settings& s, const QStringList& names) override {
        return orch::resolveFanoutAccounts(s, names);
    }

private:
    Impl& i_;
};

EngineServer::Impl::~Impl() = default;

// ---------------------------------------------------------------- 生命周期
std::shared_ptr<parsing::providers::Parser> EngineServer::Impl::parserFor(const contract::LLMConfig& cfg) {
    if (test) return std::make_shared<GoldenParser>();
    return parsing::providers::guardAccountIds(parsing::providers::buildParser(cfg), [this] {
        std::vector<parsing::providers::AccountRef> refs;
        for (const contract::AccountConfig& a : settings.accounts) refs.push_back({a.alias, a.account_id});
        return refs;
    });
}

orch::TradingEngine& EngineServer::Impl::engine() {
    if (!engineInstance) {
        const bool quiet = test;
        auto notifier = std::make_shared<util::Notifier>(
            !quiet, std::vector<util::Notifier::Sink>{[this](const QString& title, const QString& subtitle, const QString& body) {
                server.emitEvent(u"notification"_s, js::object({{u"title"_s, js::S(title)}, {u"subtitle"_s, js::S(subtitle)}, {u"body"_s, js::S(body)}}));
            }});
        orch::EngineArgs a;
        a.settings = settings;
        a.parser = orch::adaptParser(parserFor(settings.llm));  // 跟单那一趟不碰大模型:由 handleInstruction 的 localOnly 范围认
        a.store = std::make_shared<domain::TradeStore>(settings.db_path, true);
        a.notifier = notifier;
        a.killswitch = std::make_shared<util::KillSwitch>(QFileInfo(settings.db_path).path() + u"/breaker.json"_s, settings.policies.consecutive_failure_breaker);
        if (router) a.router = std::make_shared<orch::BrokerEngineRouter>(router);
        engineInstance = std::make_unique<orch::TradingEngine>(std::move(a));
        engineBroker = router;
        if (retired) engineInstance->continueFrom(*retired, retiredBroker == router);  // 回报账只在同一个 router 上接;条件单队列换了连接也接着盯
        engineInstance->sharedTrackerLock = [this](std::function<Task<>()> fn) { return trackerLock.runVoid(std::move(fn)); };
        // 触发了、或者到价却发不出去,当场推给界面——不能等界面下一次来读
        engineInstance->onTrackerTick = [this](const OJson& poll, const OJson&) {
            const OJson* fired = js::prop(&poll, u"fired"_s);
            const OJson* blocked = js::prop(&poll, u"blocked"_s);
            if ((fired && !fired->items.isEmpty()) || (blocked && !blocked->items.isEmpty())) server.emitEvent(u"tracker"_s, poll);
        };
        // 连着券商就起节拍器:建追踪、调价都靠它,不靠界面驱动
        if (router) engineInstance->startTrackerLoop();
    }
    return *engineInstance;
}

void EngineServer::Impl::dropEngine() {
    std::unique_ptr<orch::TradingEngine> old = std::move(engineInstance);
    engineInstance.reset();
    enginePort.reset();
    enginePortFor = nullptr;
    if (!old) return;
    old->stopTrackerLoop();
    retire(*old);
    retiredBroker = engineBroker;
    retiredAll.push_back(std::move(old));
}

void EngineServer::Impl::retire(orch::TradingEngine& old) {
    retired = &old;
    orch::TradingEngine::Forwards f;
    f.onOrderStatus = [this](const OJson& trade) { deliverOrderStatus(trade); };
    f.onExecDetails = [this](const OJson& trade, const OJson& fill) { engine().onExecDetails(trade, fill); };
    f.onCommission = [this](const OJson& trade, const OJson& fill, const OJson& report) { engine().onCommission(trade, fill, report); };
    f.onIbError = [this](const OJson& reqId, const OJson& code, const OJson& message) { engine().onIbError(reqId, code, message); };
    f.wireSession = [this](const orch::SessionPtr& session) { return engine().wireSession(session); };
    old.retire(std::move(f));
}

void EngineServer::Impl::deliverOrderStatus(const OJson& trade) {
    orch::TradingEngine& live = engine();
    live.onOrderStatus(trade);
    if (retired && retired != &live && js::nullish(live.trackerLoop.get(u"hosted"_s))) retired->hostedOrders().onStatus(trade);
}

void EngineServer::Impl::reload() {
    settings = domain::loadSettings(settingsPath.value_or(QString()));
    dropEngine();
    if (router) engine();
    // 跟单的频道可能刚填上 / 刚清掉:让 Discord 连接跟上(没起过就什么都不做)
    util::detach(follow->sync());
}

EnginePort& EngineServer::Impl::enginePortNow() {
    orch::TradingEngine& e = engine();
    if (!enginePort || enginePortFor != &e) {
        enginePort = makeEnginePort(e);
        enginePortFor = &e;
    }
    return *enginePort;
}

std::shared_ptr<Handlers1Router> EngineServer::Impl::routerPortNow() {
    if (!router) return nullptr;
    if (!routerPort || routerPortFor != router) {
        routerPort = makeHandlers1Router(router);
        routerPortFor = router;
    }
    return routerPort;
}

void EngineServer::Impl::warmSpot() {
    const analysis::macro::Fetcher fetcher = [](const QString& url, double timeoutMs) {
        return orch::publicFetch(url, timeoutMs, u"dafri-trading/0.2 (macro board)"_s, u"数据源"_s);
    };
    util::detach(analysis::macro::publicIndexPrice(u"SPX"_s, 4.0, fetcher));
}

// ======================================================================
// 装配
// ======================================================================
EngineServer::EngineServer(RpcServer& server, domain::Settings settings, std::optional<QString> settingsPath)
    : impl_(std::make_unique<Impl>(server, std::move(settings), std::move(settingsPath))) {
    if (const QString schemas = qEnvironmentVariable("DAFRI_SCHEMA_DIR"); !schemas.isEmpty()) parsing::providers::setSchemaAssetDir(schemas);
    if (const QString clock = qEnvironmentVariable("IBKR_ENGINE_CLOCK"); !clock.isEmpty()) {
        const QDateTime t = QDateTime::fromString(clock, Qt::ISODate);
        if (t.isValid()) domain::setClock(double(t.toMSecsSinceEpoch()));
    }
}

EngineServer::~EngineServer() = default;

bool EngineServer::testMode() const { return impl_->test; }

void EngineServer::install() {
    Impl& i = *impl_;
    i.ctx = std::make_unique<Impl::RpcCtx>(i);
    i.host = std::make_unique<Impl::Svc1HostA>(i);
    i.linkHost = std::make_unique<Impl::LinkHostA>(i);
    i.ports = std::make_unique<Impl::PortsA>(i);
    orch::Svc1Host& h = *i.host;

    i.market = std::make_unique<orch::MarketDataService>(h);
    i.alerts = std::make_unique<orch::AlertsService>(h, *i.market);
    i.anomaly = std::make_unique<orch::AnomalyService>(h, *i.alerts);
    orch::PoolPorts poolPorts;
    poolPorts.forgetAlert = [a = i.alerts.get()](const QString& s) { a->forget(s); };
    poolPorts.forgetAnomaly = [a = i.anomaly.get()](const QString& s) { a->forget(s); };
    i.pool = std::make_unique<orch::PoolService>(h, std::move(poolPorts));
    i.stockTrips = std::make_unique<orch::StockTripsService>(h);
    i.fillSync = std::make_unique<orch::FillSyncService>(h);
    i.assignmentWatch = std::make_unique<orch::AssignmentWatchService>(h);
    i.tradeHistory = std::make_unique<orch::TradeHistoryService>(h, *i.market, *i.stockTrips);
    i.similarContext = std::make_unique<orch::SimilarContextService>(h, *i.market);
    i.ideaSemantic = std::make_unique<orch::IdeaSemanticService>(h);
    i.brokerLink = std::make_unique<orch::BrokerLinkService>(*i.linkHost);
    i.flyPlanner = std::make_unique<orch::FlyPlannerService>(h);
    // 记 IV 用的是测算那批自己的行情流;测算读到行情时也顺带记一笔
    i.ivRecorder = std::make_unique<orch::IvRecorderService>(h, i.flyPlanner->marks);
    i.flyPlanner->onMarks = [r = i.ivRecorder.get()](const OJson& sample) { r->recordPlan(sample); };
    // 日内剧本的跨式也走测算那批自己的行情流;期权墙走共用的那份缓存
    i.playbook = std::make_unique<orch::PlaybookService>(h, *i.flyPlanner->marks, *i.market);
    i.follow = std::make_unique<orch::FollowService>(h);
    // 重要事件:内置日程 + 公开日历 + 自定义,只给界面一份清单;提醒的节拍在界面里
    i.events = std::make_unique<orch::EventsService>(h);
    // 信息链路:频道里看到的每一条消息落底账、认标的;时间线与档案现算。取价只走已订着的行情
    orch::AnomalyService* anomaly = i.anomaly.get();
    i.intel = std::make_unique<orch::IntelService>(h, *i.market, *i.events, [anomaly](const QString& symbol) -> std::optional<double> {
        const auto hit = anomaly->metricsOf(symbol);
        if (!hit || !hit->metrics) return std::nullopt;
        const OJson* v = js::prop(&*hit->metrics, u"change_pct"_s);
        return js::isNum(v) ? std::optional<double>(v->n) : std::nullopt;
    });
    i.follow->onSeen = [intel = i.intel.get()](const util::DiscordMessage& m, bool trusted) { util::detach(intel->record(m, trusted)); };

    i.alertsPort = makeAlertsPort(*i.alerts);
    i.linkPort = makeBrokerLinkPort(*i.brokerLink);

    ConcreteServices cs;
    cs.store = [p = &i]() -> domain::TradeStore& { return p->engine().store(); };
    cs.broker = [p = &i] { return p->router; };
    cs.parser = [p = &i](const contract::LLMConfig& cfg) { return p->parserFor(cfg); };
    cs.macroFetcher = [](const QString& url, double timeoutMs) { return orch::publicFetch(url, timeoutMs, u"dafri-trading/0.2 (macro board)"_s, u"数据源"_s); };
    cs.pool = i.pool.get();
    cs.alerts = i.alerts.get();
    cs.anomaly = i.anomaly.get();
    cs.events = i.events.get();
    cs.intel = i.intel.get();
    cs.follow = i.follow.get();
    cs.market = i.market.get();
    cs.tradeHistory = i.tradeHistory.get();
    cs.similarContext = i.similarContext.get();
    cs.stockTrips = i.stockTrips.get();
    cs.fillSync = i.fillSync.get();
    cs.ideaSemantic = i.ideaSemantic.get();
    cs.flyPlanner = i.flyPlanner.get();
    cs.ivRecorder = i.ivRecorder.get();
    cs.playbook = i.playbook.get();
    i.ports2 = makeConcretePorts(std::move(cs));

    // 各域 handler(次序同 server.ts 的 domains:system trading ideas sectors screener backtest market alerts quality review tracker connection settings follow events intel)
    i.domains.push_back(std::make_unique<SystemHandlers>(*i.ctx, *i.ports));
    i.domains.push_back(std::make_unique<TradingHandlers>(*i.ctx, *i.ports));
    auto tracker = std::make_unique<TrackerHandlers>(*i.ctx, *i.ports);
    TrackerHandlers* trackerPtr = tracker.get();
    auto domains2 = makeHandlers2(*i.ctx, *i.ports2);
    for (auto& d : domains2) i.domains.push_back(std::move(d));
    i.domains.push_back(std::move(tracker));
    i.domains.push_back(std::make_unique<ConnectionHandlers>(*i.ctx, *i.ports));
    i.domains.push_back(std::make_unique<SettingsHandlers>(*i.ctx, *i.ports));
    // 跟单建追踪走 tracker.add 的同一个 handler,记盘口用蝴蝶测算那批自己的行情流:services 不认识 handler,在这里接上
    orch::FollowWiring wiring;
    wiring.addTrack = [trackerPtr](OJson params) { return trackerPtr->trackerAdd(std::move(params)); };
    wiring.marks = i.flyPlanner->marks.get();
    i.follow->attach(std::move(wiring));

    std::vector<HandlerBase*> raw;
    for (auto& d : i.domains) raw.push_back(d.get());
    installMethods(i.server, raw);

    // serve() 起停各个 service
    i.server.hooks.onServe = [p = &i] {
        if (p->test) return;  // 契约回放不经 serve():一个后台循环都不起
        // 优质股异动监控在引擎里按节拍跑,不靠界面驱动
        p->anomaly->start();
        // 当日到期期权 IV 的记录同理
        p->ivRecorder->start();
        // SPX 日内剧本同理
        p->playbook->start();
        // 预热 SPX 公开现价:启动就取、之后每 4 分钟后台刷一次
        p->warmSpot();
        p->warmTimer = new QTimer(&p->server);
        QObject::connect(p->warmTimer, &QTimer::timeout, &p->server, [p] { p->warmSpot(); });
        p->warmTimer->start(4 * 60 * 1000);
    };
    // 每十分钟那一行 [perf] 里合约确认那道闸这十分钟里超时、跳过、试探了几次
    i.server.hooks.perfExtra = [] {
        const execution::QualifyGateStats q = execution::takeQualifyGateStats();
        return js::object({{u"qualify"_s, js::object({{u"timeouts"_s, js::N(q.timeouts)}, {u"skipped"_s, js::N(q.skipped)}, {u"probes"_s, js::N(q.probes)}})}});
    };
    i.server.hooks.onShutdown = [p = &i] {
        if (p->test) return;
        p->anomaly->stop();
        p->ivRecorder->stop();
        p->playbook->stop();
        p->follow->stop();
        p->fillSync->stop();
        p->assignmentWatch->stop();
        p->flyPlanner->marks->close();
        p->brokerLink->stop();
    };
}

void EngineServer::startBackground() {
    Impl& i = *impl_;
    if (i.test) return;
    // 启动即连券商(broker.auto_connect)。只在这个真正的入口里起:测试里直接 serve() 的那几条不许连真券商
    i.brokerLink->start();
    // Discord 跟单同理,只在这里起:配了频道、凭证库里有 bot token 才会去连,没配就一个包都不发
    i.follow->start();
    // 券商成交的后台同步同理,只在这里起
    i.fillSync->start();
    // 到期日空头腿的指派提醒同理,只在这里起:它要读真的持仓与现价
    i.assignmentWatch->start();
}

}  // namespace ibkr::rpc
