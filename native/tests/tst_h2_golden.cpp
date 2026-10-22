// handlers2 簇对 golden-rpc 的进度:engine-ts/baseline/rpc 的 96 步里属于本簇的方法(ideas / sectors / screener / backtest / market / alerts 的那几十步),
// 在**进程内**回放——真的 RpcServer(信封、错误映射都是它的)+ makeHandlers2 + makeConcretePorts + 真的 service(PoolService / AlertsService / AnomalyService /
// MarketDataService …,没连券商)+ 真的交易库;假大模型就是 golden-rpc.spec.ts 里那份(按 schema 的键挑回话),时钟固定在 2026-08-14 10:32 ET。
// 归一化与比较照 tst_golden_rpc.cpp(同 golden-rpc.spec.ts)。别的域的步(settings / tracker / trading …)不在这里,除了 llm.patch 要把模型名带到配置里
// (想法分析的回执带 model)。
// tst_golden_rpc.cpp 的 96 步棘轮要等引擎装配(main.cpp 登记 makeHandlers2 + 造这些 service)之后才会涨;这里先证明"本簇的 handler + 真 service"答得和 TS 一样。
#include "domain/config.h"
#include "orchestrate/services/alerts_service.h"
#include "orchestrate/services/anomaly_service.h"
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
#include "orchestrate/services/similar_context.h"
#include "orchestrate/services/stock_trips.h"
#include "orchestrate/services/trade_history.h"
#include "parsing/providers.h"
#include "transport/handlers/handlers2.h"
#include "transport/handlers/handlers2_adapters.h"
#include "transport/rpc_server.h"
#include "util/jsobj.h"
#include "util/js_runtime.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QSet>
#include <QTemporaryDir>
#include <QTest>

#include <cmath>

using namespace Qt::StringLiterals;
namespace orch = ibkr::orchestrate;
namespace js = ibkr::util::js;
using ibkr::util::OJson;
using ibkr::util::Task;

namespace {

const QString kRpcDir = QStringLiteral(IBKR_CONTRACT_DIR "/../../baseline/rpc");

QJsonValue readJson(const QString& path) {
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) qFatal("读不了 %s", qPrintable(path));
    const QJsonDocument d = QJsonDocument::fromJson(f.readAll());
    return d.isArray() ? QJsonValue(d.array()) : QJsonValue(d.object());
}

// ---- 归一化与比较(tst_golden_rpc.cpp / golden-rpc.spec.ts)
const QSet<QString> kMask{u"latency_ms"_s, u"port_latency_ms"_s, u"now_et"_s, u"at"_s, u"analyzed_at"_s, u"fetched_at"_s, u"created_at"_s, u"updated_at"_s,
                          u"exported_at"_s, u"fired_at"_s, u"last_fired_at"_s, u"raw_response"_s, u"path"_s, u"config"_s, u"unlock_password_saved"_s,
                          u"key_configured"_s};
const QSet<QString> kDrop{u"ports"_s, u"apps"_s, u"connected"_s, u"sdk_installed"_s, u"running"_s, u"installed"_s};

QJsonValue normalize(const QJsonValue& v) {
    static const QRegularExpression uuid(u"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"_s);
    static const QRegularExpression iso(u"^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}"_s);
    static const QRegularExpression path(u"^([A-Za-z]:[\\\\/]|/)"_s);
    if (v.isArray()) {
        QJsonArray out;
        for (const QJsonValue& x : v.toArray()) out.append(normalize(x));
        return out;
    }
    if (v.isObject()) {
        QJsonObject out;
        const QJsonObject o = v.toObject();
        for (auto it = o.begin(); it != o.end(); ++it) {
            if (kMask.contains(it.key())) out.insert(it.key(), u"<VAR>"_s);
            else if (kDrop.contains(it.key())) out.insert(it.key(), u"<MACHINE>"_s);
            else out.insert(it.key(), normalize(it.value()));
        }
        return out;
    }
    if (v.isString()) {
        const QString masked = QString(v.toString()).replace(uuid, u"<ID>"_s);
        if (masked == u"<ID>") return masked;
        if (iso.match(masked).hasMatch()) return u"<TS>"_s;
        if (path.match(masked).hasMatch() && (masked.contains(u'\\') || masked.contains(u'/'))) return u"<PATH>"_s;
        return masked;
    }
    return v;
}

bool numbersClose(double a, double b) {
    if (a == b) return true;
    if (!std::isfinite(a) || !std::isfinite(b)) return std::isnan(a) && std::isnan(b);
    const double diff = std::fabs(a - b);
    return diff <= 1e-12 || diff <= 1e-9 * std::max(std::fabs(a), std::fabs(b));
}

QString compact(const QJsonValue& v) {
    if (v.isObject()) return QString::fromUtf8(QJsonDocument(v.toObject()).toJson(QJsonDocument::Compact));
    if (v.isArray()) return QString::fromUtf8(QJsonDocument(v.toArray()).toJson(QJsonDocument::Compact));
    return QString::fromUtf8(QJsonDocument(QJsonArray{v}).toJson(QJsonDocument::Compact)).mid(1).chopped(1);
}

QString deepCompare(const QJsonValue& actual, const QJsonValue& expected, const QString& at) {
    if (expected.isNull() || expected.isUndefined()) return actual.isNull() || actual.isUndefined() ? QString() : u"%1: expected null, got %2"_s.arg(at, compact(actual));
    if (expected.isDouble()) {
        if (!actual.isDouble()) return u"%1: expected number %2, got %3"_s.arg(at, compact(expected), compact(actual));
        return numbersClose(actual.toDouble(), expected.toDouble()) ? QString() : u"%1: %2 !≈ %3"_s.arg(at, compact(actual), compact(expected));
    }
    if (expected.isString() || expected.isBool()) return actual == expected ? QString() : u"%1: expected %2, got %3"_s.arg(at, compact(expected), compact(actual));
    if (expected.isArray()) {
        if (!actual.isArray()) return u"%1: expected array, got %2"_s.arg(at, compact(actual));
        const QJsonArray a = actual.toArray(), e = expected.toArray();
        if (a.size() != e.size()) return u"%1: array length %2 != %3"_s.arg(at).arg(a.size()).arg(e.size());
        for (qsizetype i = 0; i < e.size(); ++i) {
            const QString d = deepCompare(a[i], e[i], u"%1[%2]"_s.arg(at).arg(i));
            if (!d.isEmpty()) return d;
        }
        return {};
    }
    if (!actual.isObject()) return u"%1: expected object, got %2"_s.arg(at, compact(actual));
    const QJsonObject a = actual.toObject(), e = expected.toObject();
    if (a.keys() != e.keys()) return u"%1: key mismatch (%2 vs %3)"_s.arg(at, a.keys().join(u'|'), e.keys().join(u'|'));
    for (const QString& k : e.keys()) {
        const QString d = deepCompare(a[k], e[k], at + u'.' + k);
        if (!d.isEmpty()) return d;
    }
    return {};
}

QJsonValue getPath(const QJsonValue& root, const QString& dotted) {
    QJsonValue cur = root;
    for (const QString& part : dotted.split(u'.')) cur = cur.isArray() ? cur.toArray().at(part.toInt()) : cur.toObject().value(part);
    return cur;
}

QJsonValue substitute(const QJsonValue& v, const QJsonObject& vars) {
    if (v.isArray()) {
        QJsonArray out;
        for (const QJsonValue& x : v.toArray()) out.append(substitute(x, vars));
        return out;
    }
    if (v.isObject()) {
        QJsonObject out;
        const QJsonObject o = v.toObject();
        for (auto it = o.begin(); it != o.end(); ++it) out.insert(it.key(), substitute(it.value(), vars));
        return out;
    }
    if (v.isString() && v.toString().startsWith(u'$')) {
        const QJsonValue got = vars.value(v.toString().mid(1));
        return got.isUndefined() || got.isNull() ? v : got;
    }
    return v;
}

// ---- golden-rpc.spec.ts 的假解析器:按 schema 里出现的键挑回话
class GoldenParser : public ibkr::parsing::providers::Parser {
public:
    explicit GoldenParser(ibkr::contract::LLMConfig cfg) : cfg_(std::move(cfg)) {}
    QString provider() const override { return u"golden"_s; }
    const ibkr::contract::LLMConfig& config() const override { return cfg_; }
    Task<ibkr::parsing::providers::LLMResponse> parse(ibkr::parsing::prompts::PromptBundle, QString) override { throw ibkr::util::JsError(u"golden: parse 不在本簇"_s); }
    Task<OJson> completeJson(QString, QString, OJson schema) override {
        const OJson* props = schema.get(u"properties"_s);
        const auto has = [&](const QString& k) { return props && props->get(k); };
        const auto parseOrDie = [](const QString& text) { return js::parseOrThrow(text); };
        if (has(u"stocks"_s))
            return Task<OJson>::resolved(parseOrDie(u"{\"stocks\":[{\"symbol\":\"NVDA\",\"company\":\"英伟达\",\"reason\":\"AI 芯片份额第一\",\"tag\":\"芯片\"},"
                                                    u"{\"symbol\":\"AMD\",\"company\":\"AMD\",\"reason\":\"数据中心第二供应商\",\"tag\":\"芯片\"}]}"_s));
        if (has(u"entry"_s))
            return Task<OJson>::resolved(parseOrDie(u"{\"entry\":[{\"left\":{\"kind\":\"indicator\",\"name\":\"macd_hist\"},\"op\":\"cross_up\",\"right\":{\"kind\":\"const\",\"value\":0.0}}],\"exit\":[]}"_s));
        if (has(u"themes"_s))
            return Task<OJson>::resolved(parseOrDie(u"{\"summary\":\"偏好半导体尾盘动量,想法多带明确价位\",\"themes\":[\"半导体(2 条)\"],\"lessons\":[\"想法带价位条件的更可执行\"],"
                                                    u"\"patterns\":[\"具体价位 + 条件的想法质量高\"],\"actions\":[\"把尾盘动量写成可回测的规则\"]}"_s));
        if (has(u"summary"_s))
            return Task<OJson>::resolved(parseOrDie(u"{\"summary\":\"回调加仓想法与当前动能匹配度一般\",\"thesis\":\"需要价格站回均线之上\",\"checks\":[\"财报日期\"],"
                                                    u"\"risks\":[\"波动率偏高\"],\"suggestion\":\"等回调到锚点再考虑\"}"_s));
        if (has(u"reading"_s))
            return Task<OJson>::resolved(parseOrDie(u"{\"summary\":\"结构偏多\",\"reading\":\"高点抬高。\",\"watch\":[\"盯 450\"],\"risks\":[\"假突破\"]}"_s));
        throw ibkr::util::JsError(u"没有匹配的假响应"_s);
    }
    Task<ibkr::parsing::providers::TestProbe> test(std::optional<QString>) override { throw ibkr::util::JsError(u"golden: test 不在本簇"_s); }

private:
    ibkr::contract::LLMConfig cfg_;
};

// ---- 没连券商的宿主(rpc/server.ts 里那些 service 看到的 ServiceHost)
class GoldenEngine : public orch::SvcEngine, public orch::Svc1Engine {
public:
    explicit GoldenEngine(ibkr::domain::TradeStore* store) : store_(store) {}
    ibkr::domain::TradeStore& store() override { return *store_; }
    // SvcEngine
    orch::NotifierPort& notifier() override { return notifier_; }
    void reconcileSoon() override {}
    int attachListeners() override { return 0; }
    // Svc1Engine
    void notify(const QString&, const QString&, const QString&, bool) override {}
    orch::BreakerView breaker() override { return {}; }
    Task<OJson> tryLocalShorthand(QString, orch::PriceSnap&, ibkr::domain::EtNow, ibkr::parsing::shorthand::ShorthandMeta&) override { qFatal("golden: 不该走到本地速记"); }
    Task<OJson> handleInstruction(QString, QString, ibkr::domain::EtNow, orch::PriceSnap, QStringList, bool, orch::InstructionScope) override { qFatal("golden: 不该走到指令"); }
    QStringList resolveFanoutAccounts(const ibkr::domain::Settings&, const QStringList&) override { qFatal("golden: 不该走到扇出"); }
    QString orderLegId(const OJson&) override { qFatal("golden: 不该走到 orderLegId"); }

private:
    struct Quiet : orch::NotifierPort {
        void notify(const QString&, const QString&, const QString& = {}) override {}
        void warning(const QString&) override {}
    };
    ibkr::domain::TradeStore* store_;
    Quiet notifier_;
};

class GoldenHost : public orch::Svc1Host {
public:
    GoldenHost(ibkr::domain::Settings settings, ibkr::domain::TradeStore* store) : settings_(std::move(settings)), engine_(store) {}
    const ibkr::domain::Settings& settings() const override { return settings_; }
    void setSettings(ibkr::domain::Settings s) { settings_ = std::move(s); }
    std::shared_ptr<orch::Router> router() const override { return nullptr; }
    orch::TradingEngine& engine() override { qFatal("golden: service 只用 svcEngine()"); }
    void emitEvent(const QString&, const OJson&) override {}
    std::shared_ptr<ibkr::execution::BrokerRouter> broker() const override { return nullptr; }
    std::shared_ptr<orch::RouterPort> routerPort() const override { return nullptr; }
    orch::SvcEngine& svcEngine() override { return engine_; }
    orch::Svc1Engine& svc1Engine() override { return engine_; }
    void stderrLine(const QString&) override {}

private:
    ibkr::domain::Settings settings_;
    GoldenEngine engine_;
};

// 本簇的方法(makeHandlers2 登记的那些);别的方法不发
}  // namespace

class TstH2Golden : public QObject {
    Q_OBJECT
private slots:
    void replay() {
        const QJsonArray requests = readJson(kRpcDir + u"/requests.json"_s).toArray();
        const QJsonArray expected = readJson(kRpcDir + u"/expected.json"_s).toArray();
        QCOMPARE(requests.size(), expected.size());

        QTemporaryDir dir;
        QJsonObject config = readJson(kRpcDir + u"/base_config.json"_s).toObject();
        config.insert(u"storage"_s, QJsonObject{{u"db_path"_s, dir.filePath(u"trades.db"_s)}});
        const QString settingsPath = dir.filePath(u"settings.json"_s);
        {
            QFile f(settingsPath);
            QVERIFY(f.open(QIODevice::WriteOnly));
            f.write(QJsonDocument(config).toJson(QJsonDocument::Indented));
        }
        ibkr::parsing::providers::setSchemaAssetDir(QStringLiteral(IBKR_CONTRACT_DIR "/../../baseline/llm"));
        const double clock = QDateTime::fromString(u"2026-08-14T10:32:00-04:00"_s, Qt::ISODate).toMSecsSinceEpoch();
        ibkr::domain::setClock(clock);
        ibkr::util::setDateNowForTests([clock] { return clock; });

        ibkr::domain::TradeStore store(dir.filePath(u"trades.db"_s));
        GoldenHost host(ibkr::domain::loadSettings(settingsPath), &store);
        orch::MarketDataService market(host);
        orch::AlertsService alerts(host, market);
        orch::AnomalyService anomaly(host, alerts);
        orch::PoolPorts poolPorts;
        poolPorts.forgetAlert = [&alerts](const QString& s) { alerts.forget(s); };
        poolPorts.forgetAnomaly = [&anomaly](const QString& s) { anomaly.forget(s); };
        orch::PoolService pool(host, poolPorts);
        orch::EventsService events(host);
        orch::StockTripsService stockTrips(host);
        orch::FillSyncService fillSync(host);
        orch::TradeHistoryService tradeHistory(host, market, stockTrips);
        orch::SimilarContextService similarContext(host, market);
        orch::IdeaSemanticService ideaSemantic(host);
        orch::FlyPlannerService flyPlanner(host);
        orch::IvRecorderService ivRecorder(host, flyPlanner.marks);
        orch::PlaybookService playbook(host, *flyPlanner.marks, market);
        orch::FollowService follow(host);
        orch::IntelService intel(host, market, events, {});

        ibkr::rpc::ConcreteServices services;
        services.store = [&store]() -> ibkr::domain::TradeStore& { return store; };
        services.broker = [] { return std::shared_ptr<ibkr::execution::BrokerRouter>(); };
        services.parser = [&host](const ibkr::contract::LLMConfig& llm) -> std::shared_ptr<ibkr::parsing::providers::Parser> { return std::make_shared<GoldenParser>(llm); };
        services.macroFetcher = [](const QString&, double) -> Task<OJson> { throw ibkr::util::JsError(u"golden: 不联网"_s); };
        services.pool = &pool;
        services.alerts = &alerts;
        services.anomaly = &anomaly;
        services.events = &events;
        services.intel = &intel;
        services.follow = &follow;
        services.market = &market;
        services.tradeHistory = &tradeHistory;
        services.similarContext = &similarContext;
        services.stockTrips = &stockTrips;
        services.fillSync = &fillSync;
        services.ideaSemantic = &ideaSemantic;
        services.flyPlanner = &flyPlanner;
        services.ivRecorder = &ivRecorder;
        services.playbook = &playbook;
        const auto ports = ibkr::rpc::makeConcretePorts(std::move(services));

        struct Ctx : ibkr::rpc::RpcContext {
            explicit Ctx(GoldenHost* h) : host(h) {}
            GoldenHost* host;
            ibkr::rpc::SerialLock lock;
            const ibkr::domain::Settings& settings() const override { return host->settings(); }
            std::shared_ptr<orch::Router> router() const override { return nullptr; }
            orch::TradingEngine& engine() override { qFatal("golden: handler 不该碰 ctx.engine()"); }
            void emitEvent(const QString&, const OJson&) override {}
            void setSettings(ibkr::domain::Settings s) override { host->setSettings(std::move(s)); }
            void setRouter(std::shared_ptr<orch::Router>) override {}
            orch::TradingEngine* engineBuilt() const override { return nullptr; }
            std::shared_ptr<ibkr::rpc::Parser> parserFactory(const ibkr::contract::LLMConfig&) override { return nullptr; }
            void reload() override {}
            void dropEngine() override {}
            ibkr::rpc::SerialLock& trackerLock() override { return lock; }
        } ctx(&host);

        QList<QByteArray> lines;
        ibkr::rpc::RpcServer server([&lines](const QByteArray& line) { lines.append(line); });
        auto handlers = ibkr::rpc::makeHandlers2(ctx, *ports);
        std::vector<ibkr::rpc::HandlerBase*> raw;
        for (auto& h : handlers) raw.push_back(h.get());
        ibkr::rpc::installMethods(server, raw);

        const auto request = [&](int id, const QString& method, const QJsonValue& params) -> QJsonObject {
            lines.clear();
            const QJsonObject req{{u"jsonrpc"_s, u"2.0"_s}, {u"id"_s, id}, {u"method"_s, method}, {u"params"_s, params}};
            server.handleLine(QJsonDocument(req).toJson(QJsonDocument::Compact));
            for (int spins = 0; spins < 2000; ++spins) {
                for (const QByteArray& l : lines) {
                    const QJsonObject o = QJsonDocument::fromJson(l).object();
                    if (o.value(u"id").toInt(-1) == id) return o;
                }
                QCoreApplication::processEvents(QEventLoop::AllEvents, 5);
            }
            return QJsonObject{{u"error"_s, QJsonObject{{u"message"_s, u"没回话"_s}}}};
        };

        QJsonObject vars{{u"EXPORT_PATH"_s, dir.filePath(u"export.json"_s)}};
        int mine = 0, matched = 0;
        QStringList diffs;
        for (int i = 0; i < requests.size(); ++i) {
            const QJsonObject step = requests[i].toObject();
            const QString method = step[u"method"_s].toString();
            if (method == u"llm.patch") {  // settings 域的步:只把模型名带过来(想法分析的回执里有 model)
                const QJsonObject llm = step[u"params"_s].toObject().value(u"llm").toObject();
                if (llm.contains(u"model")) {
                    ibkr::domain::Settings s = host.settings();
                    s.llm.model = llm.value(u"model").toString();
                    host.setSettings(std::move(s));
                }
                continue;
            }
            if (!server.has(method)) continue;
            ++mine;
            const QJsonObject response = request(i, method, substitute(step[u"params"_s], vars));
            const QJsonObject capture = step[u"capture"_s].toObject();
            for (auto it = capture.begin(); it != capture.end(); ++it)
                vars.insert(it.key(), getPath(QJsonObject{{u"result"_s, response.value(u"result")}}, it.value().toString()));
            QJsonObject picked;
            if (response.contains(u"result")) picked.insert(u"result"_s, response.value(u"result"));
            if (response.contains(u"error")) picked.insert(u"error"_s, response.value(u"error"));
            const QString diff = deepCompare(normalize(picked), expected[i], u"%1[%2]"_s.arg(method).arg(i));
            if (diff.isEmpty()) ++matched;
            else diffs << diff.left(400);
        }
        qInfo().noquote() << u"golden-rpc(进程内,本簇):对上 %1 / %2 步"_s.arg(matched).arg(mine);
        for (const QString& d : diffs) qInfo().noquote() << u"  差:"_s + d;
        QVERIFY2(diffs.isEmpty(), qPrintable(diffs.join(u"\n"_s)));
        QVERIFY(mine > 0);
        ibkr::util::setDateNowForTests({});
        ibkr::domain::setClock(std::nullopt);
    }
};

QTEST_GUILESS_MAIN(TstH2Golden)
#include "tst_h2_golden.moc"
