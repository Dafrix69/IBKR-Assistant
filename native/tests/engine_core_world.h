// engine_core 簇(TradingEngine 整体)对拍用的"世界"的 C++ 一半:读 fixtures/engine_core_world.mjs 开头约定的同一份脚本,解释得一模一样——
// 虚拟的钟与计时器、可复现的 id、真的交易库与熔断开关、挂了 sink 的通知器、脚本驱动的假解析器与假 router(含假会话),
// 把每一次对 router / 解析器 / 库 / 通知 / 熔断的调用(方法、参数、虚拟时刻、先后)与各步结果、内部状态记下来,交给测试和 TS 现跑的答案逐项比。
// 改这个文件就要同时改 engine_core_world.mjs。
// C++ 与 JS 的差别(都不影响可观察结果):C++ 的协程在等的东西已经完成时不让一拍,所以 JS 那边的 drain 在这里不用。
#pragma once

#include "analysis/tracker_rules.h"

#include "domain/config.h"
#include "domain/models.h"
#include "domain/positions.h"
#include "domain/store.h"
#include "execution/ib_link.h"
#include "execution/ib_link_down.h"
#include "js_fixture.h"
#include "orchestrate/engine.h"
#include "orchestrate/engine_router.h"
#include "parsing/providers.h"
#include "parsing/prompts.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/js_runtime.h"
#include "util/killswitch.h"
#include "util/notify.h"
#include "util/py.h"
#include "util/sqlite.h"
#include "util/tz.h"

#include <QDir>
#include <QRegularExpression>
#include <QTemporaryDir>

#include <algorithm>
#include <map>
#include <memory>

namespace ecw {

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace orch = ibkr::orchestrate;
namespace tk = ibkr::orchestrate::tracker;
using ibkr::util::Task;

inline OJson jn(const OJson& x) {
    const auto parsed = ibkr::util::parseOJson(ibkr::util::stringifyOJson(x, 0));
    return parsed ? *parsed : OJson::null();
}
inline OJson deepMerge(const OJson& base, const OJson& patch) {
    if (patch.type != OJson::Object) return patch;
    OJson out = base;
    for (const auto& [k, v] : patch.fields) {
        const OJson* b = base.get(k);
        if (v.type == OJson::Object && b && b->type == OJson::Object) out.set(k, deepMerge(*b, v));
        else out.set(k, v);
    }
    return out;
}
inline QString str(const OJson& o, const QString& k) { return js::strOr(js::prop(&o, k), QString()); }
inline double num(const OJson& o, const QString& k, double fallback = 0) { const OJson* v = js::prop(&o, k); return js::nullish(v) ? fallback : js::num(v); }
inline bool flag(const OJson& o, const QString& k) { return js::truthy(js::prop(&o, k)); }
inline OJson orNull(const OJson& o, const QString& k) { const OJson* v = o.get(k); return v ? *v : OJson::null(); }

class World {
public:
    World(const OJson& script, const OJson& base);
    ~World();
    OJson run();

    // ---- 虚拟钟
    struct Timer {
        double at = 0;
        int seq = 0;
        std::function<void()> fn;
        bool dead = false;
    };
    double T = 0, slept = 0;
    int seq = 0, stepNo = -1, uuidN = 0;
    std::vector<std::shared_ptr<Timer>> timers;
    double mono() const { return 1'000'000 + T - slept; }
    void setT(double t) {
        T = t;
        ibkr::domain::setClock(t);
    }
    void setTimeout(int ms, std::function<void()> fn) {
        auto t = std::make_shared<Timer>();
        t->at = T + std::max(1.0, std::trunc(double(ms)));
        t->seq = ++seq;
        t->fn = std::move(fn);
        timers.push_back(t);
    }
    Task<> sleepTimer(int ms) {
        ibkr::util::Deferred<> d;
        setTimeout(ms, [d]() mutable { d.resolve(); });
        return d.task();
    }
    void advance(double ms);

    OJson log = js::array();
    void rec(const OJson& entry) {
        OJson o = js::object({{u"s"_s, js::N(stepNo)}, {u"t"_s, js::N(T)}});
        for (const auto& [k, v] : entry.fields) o.set(k, v);
        log.items.append(o);
    }

    QTemporaryDir dir;
    OJson rawSettings;
    std::unique_ptr<ibkr::domain::Settings> settings;
    std::unique_ptr<ibkr::domain::TradeStore> real;
    std::unique_ptr<orch::CoreStore> realPort;
    std::unique_ptr<ibkr::util::KillSwitch> ksReal;
    std::unique_ptr<ibkr::util::Notifier> notifier;
    class LoggedStore;
    class LoggedBreaker;
    class FakeParser;
    class FakeRouter;
    class FakeSession;
    std::unique_ptr<LoggedStore> store;
    std::unique_ptr<LoggedBreaker> ks;
    std::shared_ptr<FakeParser> parser;
    std::shared_ptr<FakeRouter> router;
    std::unique_ptr<orch::TradingEngine> engine;
    /// C++ 独有的 reload 步换下来的引擎(一个不放手,同 EngineServer)
    std::vector<std::unique_ptr<orch::TradingEngine>> retiredEngines;
    std::unique_ptr<orch::TradingEngine> makeEngine();
    OJson publicPrices = js::object();

    static OJson bs(const ibkr::util::BreakerState& s) {
        return js::object({{u"engaged"_s, js::B(s.engaged)},
                           {u"reason"_s, js::S(s.reason)}});
    }

    std::map<QString, QString> trackNames, recNames;
    OJson subst(const OJson& x) const;
    void fireEvent(const OJson& e);
    Task<OJson> doOp(OJson step);
    OJson snapshot();
    OJson dump();

    struct Pending {
        bool done = false;
        OJson result;
    };
    std::map<int, std::shared_ptr<Pending>> pendingOps;
    void collectDone();

    const OJson script, base;
    QString prevSnap;
};

// ======================================================================
// 行为队列(假解析器与假 router 共用)
// ======================================================================
struct Behaviors {
    OJson queues = js::object();
    QHash<QString, int> cursor;
    OJson next(const QString& method) {
        const OJson* q = js::prop(&queues, method);
        if (!q || !js::isArr(q) || q->items.isEmpty()) return js::object();
        const int i = cursor.value(method, 0);
        if (i < q->items.size()) {
            cursor.insert(method, i + 1);
            return q->items[i];
        }
        return flag(q->items.last(), u"repeat"_s) ? q->items.last() : js::object();
    }
};

inline Task<> behave(World& w, OJson b) {
    if (const OJson* e = b.get(u"emit"_s)) {
        for (const OJson& x : e->items) w.fireEvent(x);
    }
    if (flag(b, u"delay"_s)) co_await w.sleepTimer(static_cast<int>(num(b, u"delay"_s)));
    if (flag(b, u"hang"_s)) {
        ibkr::util::Deferred<> never;
        co_await never.task();
    }
    if (const OJson* err = b.get(u"error"_s)) {
        const QString cls = str(*err, u"cls"_s), msg = str(*err, u"msg"_s);
        if (cls == u"LinkDown") throw ibkr::execution::LinkDownError();
        if (cls == u"Broker") throw ibkr::execution::BrokerError(msg);
        if (cls == u"Plan") throw orch::HostedPlanError(msg);
        if (cls == u"LLM") throw ibkr::domain::LLMError(msg);
        throw ibkr::util::JsError(msg);
    }
}

// ======================================================================
// 交易库:真库外面包一层,记下调用
// ======================================================================
class World::LoggedStore final : public orch::CoreStore {
public:
    LoggedStore(World& w, orch::CoreStore& inner) : w_(w), inner_(inner) {}
    QList<OJson> listTracks() override {
        w_.rec(entry(u"listTracks"_s, js::array()));
        return inner_.listTracks();
    }
    std::optional<OJson> getTrack(const QString& id) override {
        w_.rec(entry(u"getTrack"_s, js::array({js::S(id)})));
        return inner_.getTrack(id);
    }
    bool updateTrack(const QString& id, const OJson& fields) override {
        const OJson a = jn(js::array({js::S(id), fields}));
        const bool r = inner_.updateTrack(id, fields);
        OJson e = entry(u"updateTrack"_s, a);
        e.set(u"r"_s, js::B(r));
        w_.rec(e);
        return r;
    }
    void audit(const QString& actor, const QString& action, const OJson* detail) override {
        OJson args = js::array({js::S(actor), js::S(action)});
        if (detail) args.items.append(*detail);
        const OJson a = jn(args);
        inner_.audit(actor, action, detail);
        w_.rec(entry(u"audit"_s, a));
    }
    QString createRecord(OJson& record) override {
        const OJson a = jn(js::array({record}));
        const QString id = inner_.createRecord(record);
        OJson e = entry(u"createRecord"_s, a);
        e.set(u"r"_s, js::S(id));
        w_.rec(e);
        return id;
    }
    void markSubmitIntent(const QString& id) override {
        inner_.markSubmitIntent(id);
        w_.rec(entry(u"markSubmitIntent"_s, js::array({js::S(id)})));
    }
    void appendEvent(const QString& id, const QString& kind, const OJson& payload) override {
        const OJson a = jn(js::array({js::S(id), js::S(kind), payload}));
        inner_.appendEvent(id, kind, payload);
        w_.rec(entry(u"appendEvent"_s, a));
    }
    void setFinalStatus(const QString& id, const QString& status, const std::optional<QString>& detail) override {
        OJson args = js::array({js::S(id), js::S(status)});
        if (detail) args.items.append(js::S(*detail));
        const OJson a = jn(args);
        inner_.setFinalStatus(id, status, detail);
        w_.rec(entry(u"setFinalStatus"_s, a));
    }
    std::optional<OJson> getRecord(const QString& id) override {
        w_.rec(entry(u"getRecord"_s, js::array({js::S(id)})));
        return inner_.getRecord(id);
    }
    QList<OJson> listWorkingRecords(double maxAgeDays, double nowMs) override {
        w_.rec(entry(u"listWorkingRecords"_s, js::array({js::N(maxAgeDays), js::N(nowMs)})));
        return inner_.listWorkingRecords(maxAgeDays, nowMs);
    }
    QList<OJson> fillsByOrderRef(const QString& ref) override {
        w_.rec(entry(u"fillsByOrderRef"_s, js::array({js::S(ref)})));
        return inner_.fillsByOrderRef(ref);
    }
    double rememberFills(const QList<OJson>& rows) override {
        const OJson a = jn(js::array({js::array(rows)}));
        const double r = inner_.rememberFills(rows);
        OJson e = entry(u"rememberFills"_s, a);
        e.set(u"r"_s, js::N(r));
        w_.rec(e);
        return r;
    }
    QList<OJson> workingOrders(double since, double now) override {
        w_.rec(entry(u"workingOrders"_s, jn(js::array({js::N(since), js::N(now)}))));
        return inner_.workingOrders(since, now);
    }
    QList<OJson> dailyLossTrips(double since, double now) override {
        w_.rec(entry(u"dailyLossTrips"_s, jn(js::array({js::N(since), js::N(now)}))));
        return inner_.dailyLossTrips(since, now);
    }
    QList<OJson> recentOrderDetails(double minutes, double now) override {
        w_.rec(entry(u"recentOrderDetails"_s, jn(js::array({js::N(minutes), js::N(now)}))));
        return inner_.recentOrderDetails(minutes, now);
    }
    QList<OJson> recentCloses(double since, double now) override {
        w_.rec(entry(u"recentCloses"_s, jn(js::array({js::N(since), js::N(now)}))));
        return inner_.recentCloses(since, now);
    }
    QList<OJson> realizedPnlEvents(double since, double now) override {
        w_.rec(entry(u"realizedPnlEvents"_s, jn(js::array({js::N(since), js::N(now)}))));
        return inner_.realizedPnlEvents(since, now);
    }

private:
    static OJson entry(const QString& m, const OJson& a) { return js::object({{u"c"_s, js::S(u"store"_s)}, {u"m"_s, js::S(m)}, {u"a"_s, a}}); }
    World& w_;
    orch::CoreStore& inner_;
};

class World::LoggedBreaker final : public orch::BreakerPort {
public:
    explicit LoggedBreaker(World& w) : w_(w) {}
    ibkr::util::BreakerState state() override {
        const auto s = w_.ksReal->state();
        w_.rec(js::object({{u"c"_s, js::S(u"breaker"_s)}, {u"m"_s, js::S(u"state"_s)}, {u"r"_s, World::bs(s)}}));
        return s;
    }
private:
    World& w_;
};

// ======================================================================
// 假解析器
// ======================================================================
class World::FakeParser final : public orch::EngineParser {
public:
    FakeParser(World& w, const OJson& cfg) : w_(w) {
        if (const OJson* b = js::prop(&cfg, u"behaviors"_s)) beh.queues = *b;
    }
    Task<ibkr::parsing::providers::LLMResponse> parse(ibkr::parsing::prompts::PromptBundle bundle, QString userMessage) override {
        w_.rec(js::object({{u"c"_s, js::S(u"parser"_s)}, {u"m"_s, js::S(u"parse"_s)}, {u"a"_s, js::array({js::S(bundle.version), js::S(userMessage)})}}));
        const OJson b = beh.next(u"parse"_s);
        co_await behave(w_, b);
        ibkr::parsing::providers::LLMResponse r;
        if (const OJson* t = b.get(u"text"_s)) r.text = t->s;
        else r.text = ibkr::util::stringifyOJson(b.get(u"payload"_s) ? *b.get(u"payload"_s) : js::object({{u"orders"_s, js::array()}, {u"rejections"_s, js::array()}}), 0);
        r.model = b.get(u"model"_s) ? *b.get(u"model"_s) : js::S(u"claude-opus-5"_s);
        r.prompt_version = bundle.version;
        r.prompt_fingerprint = ibkr::parsing::prompts::fingerprint(bundle);
        r.latency_ms = b.get(u"latency"_s) ? num(b, u"latency"_s) : 42;
        r.usage = b.get(u"usage"_s) ? *b.get(u"usage"_s) : js::object();
        r.structured_mode = u"json_schema"_s;
        co_return r;
    }
    Behaviors beh;

private:
    World& w_;
};

// ======================================================================
// 假会话:只有事件回调是真的
// ======================================================================
class World::FakeSession final : public ibkr::execution::IbSession {
public:
    FakeSession(const OJson& def) {
        name = str(def, u"name"_s);
        const OJson* caps = def.get(u"caps"_s);
        const auto cap = [&](const QString& k) {
            const OJson* v = caps ? caps->get(k) : nullptr;
            return v ? js::truthy(v) : true;
        };
        capStatus = cap(u"status"_s);
        capFill = cap(u"fill"_s);
        capCommission = cap(u"commission"_s);
        capError = cap(u"error"_s);
    }
    QString name;
    bool capStatus = true, capFill = true, capCommission = true, capError = true;
    std::function<void(const OJson&)> hStatus;
    std::function<void(const OJson&, const OJson&)> hFill;
    std::function<void(const OJson&, const OJson&, const OJson&)> hCommission;
    std::function<void(int, int, const QString&)> hError;

    bool has(ibkr::execution::Cap c) const override {
        using ibkr::execution::Cap;
        return (c == Cap::OnOrderStatus && capStatus) || (c == Cap::OnFill && capFill) || (c == Cap::OnCommission && capCommission) || (c == Cap::OnError && capError);
    }
    void onOrderStatus(std::function<void(const OJson&)> cb) override { hStatus = std::move(cb); }
    void onFill(std::function<void(const OJson&, const OJson&)> cb) override { hFill = std::move(cb); }
    void onCommission(std::function<void(const OJson&, const OJson&, const OJson&)> cb) override { hCommission = std::move(cb); }
    ibkr::execution::ListenerToken onError(std::function<void(int, int, const QString&)> cb) override {
        hError = std::move(cb);
        return 1;
    }
    // 下面的在引擎这一层用不到
    bool isConnected() override { return true; }
    Task<> disconnect() override { co_return; }
    QStringList managedAccounts() override { return {}; }
    Task<> qualifyContracts(std::vector<ibkr::execution::IbContract*>, int) override { co_return; }
    void reqMarketDataType(int) override {}
    std::shared_ptr<ibkr::execution::TickerHandle> subscribeTicker(const ibkr::execution::IbContract&, const QString&) override { return nullptr; }
    void cancelTicker(const ibkr::execution::IbContract&, const std::optional<QString>&) override {}
    Task<> settle(int) override { co_return; }
    Task<std::vector<ibkr::execution::RawBar>> historicalData(ibkr::execution::IbContract, ibkr::execution::HistoricalRequest) override { co_return std::vector<ibkr::execution::RawBar>{}; }
    Task<std::vector<ibkr::execution::OptChainParam>> secDefOptParams(QString, QString, int) override { co_return std::vector<ibkr::execution::OptChainParam>{}; }
    Task<ibkr::execution::Depth> mktDepth(ibkr::execution::IbContract, int, int) override { co_return ibkr::execution::Depth{}; }
    Task<ibkr::execution::TradeLike> placeOrder(ibkr::execution::IbContract, ibkr::execution::OrderIntent) override { co_return ibkr::execution::TradeLike{}; }
    Task<std::vector<ibkr::execution::OpenTrade>> openTrades() override { co_return std::vector<ibkr::execution::OpenTrade>{}; }
    Task<> cancelOrder(int) override { co_return; }
    Task<std::vector<ibkr::execution::PortfolioItemLike>> portfolio() override { co_return std::vector<ibkr::execution::PortfolioItemLike>{}; }
    Task<std::vector<ibkr::execution::PositionItemLike>> positions() override { co_return std::vector<ibkr::execution::PositionItemLike>{}; }
    void onConnectivity(std::function<void(int)>) override {}
};

// ======================================================================
// 假 router
// ======================================================================
class World::FakeRouter final : public orch::EngineRouter {
public:
    FakeRouter(World& w, const OJson& cfg) : w_(w) {
        const OJson* caps = cfg.get(u"caps"_s);
        const auto cap = [&](const QString& k, bool fallback) {
            const OJson* v = caps ? caps->get(k) : nullptr;
            return v ? js::truthy(v) : fallback;
        };
        capHosted = cap(u"hosted"_s, true);
        capListHostedOpen = cap(u"listHostedOpen"_s, true);
        capModifyHosted = cap(u"modifyHosted"_s, true);
        capListOpenOrders = cap(u"listOpenOrders"_s, false);
        capExecutions = cap(u"executions"_s, false);
        capCoveredAccounts = cap(u"coveredAccounts"_s, false);
        capCoveredIds = cap(u"coveredIds"_s, false);
        capQuoteCapability = cap(u"quoteCapability"_s, false);
        capOptionQuotes = cap(u"optionQuotes"_s, false);
        capQualify = cap(u"qualify"_s, false);
        capSpotInfo = cap(u"spotInfo"_s, false);
        capStream = cap(u"streamQuotes"_s, false);
        capHours = cap(u"contractHours"_s, false);
        capCachedHours = cap(u"cachedHours"_s, false);
        capConnected = cap(u"connected"_s, false);
        capPoll = cap(u"poll"_s, false);
        const OJson* nat = caps ? caps->get(u"native"_s) : nullptr;
        if (nat && nat->type == OJson::Bool) native = nat->b;
        st = js::object();
        const auto put = [&](const QString& k, const OJson& dflt) { st.set(k, cfg.get(k) ? *cfg.get(k) : dflt); };
        put(u"rows"_s, js::array());
        put(u"covered"_s, js::Null());
        put(u"coveredIds"_s, js::Null());
        put(u"hostedOpen"_s, js::array());
        put(u"openOrders"_s, js::array());
        put(u"execRows"_s, js::array());
        put(u"nextId"_s, js::N(500));
        put(u"perm"_s, js::B(false));
        put(u"placeStatus"_s, js::S(u"PreSubmitted"_s));
        put(u"prices"_s, js::object());
        put(u"legQuotes"_s, js::array());
        put(u"cancelCount"_s, js::N(0));
        put(u"quoteCap"_s, js::object());
        put(u"optionQuotes"_s, js::object());
        put(u"stream"_s, js::object());
        put(u"spotInfo"_s, js::object());
        put(u"hours"_s, js::Null());
        put(u"cachedHours"_s, js::object());
        put(u"connected"_s, js::array());
        put(u"pollUpdates"_s, js::array());
        if (const OJson* b = cfg.get(u"behaviors"_s)) beh.queues = *b;
        if (const OJson* defs = cfg.get(u"sessions"_s)) {
            for (const OJson& d : defs->items) sessionList.push_back(std::make_shared<FakeSession>(d));
        }
    }

    World& w_;
    bool capHosted = true, capListHostedOpen = true, capModifyHosted = true, capListOpenOrders = false, capExecutions = false, capCoveredAccounts = false, capCoveredIds = false,
         capQuoteCapability = false, capOptionQuotes = false, capQualify = false, capSpotInfo = false, capStream = false, capHours = false, capCachedHours = false,
         capConnected = false, capPoll = false, native = true;
    OJson st;
    Behaviors beh;
    std::vector<std::shared_ptr<FakeSession>> sessionList;
    std::function<void(const orch::SessionPtr&)> hook;

    void recr(const QString& m, const OJson& a = OJson::null()) {
        OJson e = js::object({{u"c"_s, js::S(u"router"_s)}, {u"m"_s, js::S(m)}});
        if (a.type != OJson::Null) e.set(u"a"_s, a);
        w_.rec(e);
    }
    QList<OJson> copies(const QString& key) const { return w_.subst(*st.get(key)).items; }

    bool supportsNativeConditions() const override { return native; }
    void setSessionHook(std::function<void(const orch::SessionPtr&)> h) override { hook = std::move(h); }

    Task<QList<OJson>> positions() override {
        recr(u"positions"_s);
        co_await behave(w_, beh.next(u"positions"_s));
        co_return copies(u"rows"_s);
    }
    Task<std::optional<double>> indexPrice(const QString& symbol) override {
        recr(u"indexPrice"_s, js::array({js::S(symbol)}));
        const OJson b = beh.next(u"indexPrice"_s);
        co_await behave(w_, b);
        const OJson* v = b.get(u"ret"_s);
        if (!v) v = js::prop(st.get(u"prices"_s), symbol);
        if (js::nullish(v)) co_return std::nullopt;
        co_return js::num(v);
    }
    Task<std::vector<ibkr::execution::LegQuote>> legQuotes(OJson contract, ibkr::contract::AccountConfig account) override {
        recr(u"legQuotes"_s, jn(js::array({contract, js::S(account.alias)})));
        const OJson b = beh.next(u"legQuotes"_s);
        co_await behave(w_, b);
        const OJson* src = b.get(u"ret"_s) ? b.get(u"ret"_s) : st.get(u"legQuotes"_s);
        std::vector<ibkr::execution::LegQuote> out;
        for (const OJson& q : src->items) out.push_back({str(q, u"action"_s), num(q, u"ratio"_s), num(q, u"bid"_s), num(q, u"ask"_s)});
        co_return out;
    }
    Task<ibkr::execution::PlacementResult> place(QString recordId, ibkr::parsing::validator::ApprovedOrder approved, std::optional<double> limitOverride) override {
        recr(u"place"_s, jn(js::array({js::S(recordId), js::S(approved.account.alias), js::S(approved.account.account_id), js::B(approved.account.is_paper), approved.order,
                                       js::N(approved.notional), js::S(approved.signature), js::strings(approved.warnings), js::NOrNull(limitOverride)})));
        const OJson b = beh.next(u"place"_s);
        co_await behave(w_, b);
        const double id = num(st, u"nextId"_s) + 1;
        st.set(u"nextId"_s, js::N(id));
        ibkr::execution::PlacementResult r;
        r.record_id = recordId;
        r.order_id = static_cast<int>(id);
        if (flag(st, u"perm"_s)) r.perm_id = static_cast<int>(9000 + id);
        r.status = str(st, u"placeStatus"_s);
        r.limit_price = limitOverride;
        if (const OJson* res = b.get(u"res"_s)) {
            if (const OJson* o = res->get(u"order_id"_s)) r.order_id = o->type == OJson::Null ? std::nullopt : std::optional<int>(static_cast<int>(o->n));
            if (const OJson* p = res->get(u"perm_id"_s)) r.perm_id = p->type == OJson::Null ? std::nullopt : std::optional<int>(static_cast<int>(p->n));
            if (const OJson* s = res->get(u"status"_s)) r.status = js::str(s);
        }
        co_return r;
    }
    Task<int> cancelAllOpen() override {
        recr(u"cancelAllOpen"_s);
        const OJson b = beh.next(u"cancelAllOpen"_s);
        co_await behave(w_, b);
        co_return static_cast<int>(b.get(u"ret"_s) ? js::num(b.get(u"ret"_s)) : num(st, u"cancelCount"_s));
    }
    bool hasQuoteCapability() const override { return capQuoteCapability; }
    std::optional<QString> quoteCapability(const QString& symbol) override {
        recr(u"quoteCapability"_s, js::array({js::S(symbol)}));
        const OJson* v = js::prop(st.get(u"quoteCap"_s), symbol);
        if (js::nullish(v)) return std::nullopt;
        return js::str(v);
    }
    bool hasOptionQuotes() const override { return capOptionQuotes; }
    Task<OJson> optionQuotes(QList<OJson> rows) override {
        OJson keys = js::array();
        for (const OJson& r : rows) keys.items.append(js::copyOrNull(js::prop(&r, u"key"_s)));
        recr(u"optionQuotes"_s, jn(js::array({keys})));
        const OJson b = beh.next(u"optionQuotes"_s);
        co_await behave(w_, b);
        if (const OJson* ret = b.get(u"ret"_s)) co_return *ret;
        OJson out = js::object();
        for (const OJson& r : rows) {
            const QString k = js::str(js::prop(&r, u"key"_s));
            if (const OJson* q = js::prop(st.get(u"optionQuotes"_s), k)) out.set(k, *q);
        }
        co_return out;
    }
    bool hasQualify() const override { return capQualify; }
    Task<> qualify(OJson contract, ibkr::contract::AccountConfig account) override {
        recr(u"qualify"_s, jn(js::array({contract, js::S(account.alias)})));
        co_await behave(w_, beh.next(u"qualify"_s));
    }
    bool hasSpotInfo() const override { return capSpotInfo; }
    std::optional<OJson> spotInfo(const QString& symbol) override {
        const OJson* v = js::prop(st.get(u"spotInfo"_s), symbol);
        if (js::nullish(v)) return std::nullopt;
        return *v;
    }
    bool hasStreamQuotes() const override { return capStream; }
    Task<OJson> streamQuotes(const QStringList& symbols) override {
        recr(u"streamQuotes"_s, js::array({js::strings(symbols)}));
        OJson out = js::object();
        for (const QString& s : symbols)
            if (const OJson* q = js::prop(st.get(u"stream"_s), s)) out.set(s, *q);
        co_return out;
    }
    bool hasContractHours() const override { return capHours; }
    Task<std::optional<orch::ContractHours>> contractHours(const OJson& row, const ibkr::contract::AccountConfig& account) override {
        recr(u"contractHours"_s, jn(js::array({js::copyOrNull(js::prop(&row, u"key"_s)), js::S(account.alias)})));
        co_await behave(w_, beh.next(u"contractHours"_s));
        co_return hoursOf(st.get(u"hours"_s));
    }
    bool hasCachedContractHours() const override { return capCachedHours; }
    std::optional<orch::ContractHours> cachedContractHours(const QString& symbol, const QString& expiry) override {
        return hoursOf(js::prop(st.get(u"cachedHours"_s), symbol + u"|"_s + expiry));
    }
    static std::optional<orch::ContractHours> hoursOf(const OJson* v) {
        if (js::nullish(v)) return std::nullopt;
        return orch::ContractHours{js::str(&v->items[0]), js::str(&v->items[1]), js::str(&v->items[2])};
    }
    bool hasConnectedNames() const override { return capConnected; }
    QStringList connectedNames() override {
        QStringList l;
        for (const OJson& x : st.get(u"connected"_s)->items) l << js::str(&x);
        return l;
    }
    int sessionCount() override { return static_cast<int>(sessionList.size()); }
    ibkr::execution::SessionList sessions() override { return {sessionList.begin(), sessionList.end()}; }
    bool hasPollOrderUpdates() const override { return capPoll; }
    Task<QList<orch::PollUpdate>> pollOrderUpdates() override {
        recr(u"pollOrderUpdates"_s);
        co_await behave(w_, beh.next(u"pollOrderUpdates"_s));
        QList<orch::PollUpdate> out;
        for (const OJson& u : st.get(u"pollUpdates"_s)->items) out.append({js::str(&u.items[0]), u.items[1], u.items[2]});
        co_return out;
    }

    // HostedRouter
    bool supportsHostedClose() const override { return capHosted; }
    std::optional<QSet<QString>> coveredAccounts() override {
        const OJson* c = st.get(u"covered"_s);
        if (!capCoveredAccounts || js::nullish(c)) return std::nullopt;
        QSet<QString> s;
        for (const OJson& x : c->items) s.insert(js::str(&x));
        return s;
    }
    bool hasListHostedOpen() const override { return capListHostedOpen; }
    Task<QList<OJson>> listHostedOpenWith(std::optional<QString> refPrefix) override {
        recr(u"listHostedOpen"_s, js::array({refPrefix ? js::S(*refPrefix) : js::Null()}));
        co_await behave(w_, beh.next(u"listHostedOpen"_s));
        co_return copies(u"hostedOpen"_s);
    }
    Task<ibkr::execution::HostedPlacement> placeHosted(ibkr::contract::AccountConfig account, OJson contractSpec, OJson item, QString oca, QString ref) override {
        recr(u"placeHosted"_s, jn(js::array({js::S(account.alias), js::S(account.account_id), js::B(account.is_paper), contractSpec, item, js::S(oca), js::S(ref)})));
        const OJson b = beh.next(u"placeHosted"_s);
        co_await behave(w_, b);
        const double id = num(st, u"nextId"_s) + 1;
        st.set(u"nextId"_s, js::N(id));
        ibkr::execution::HostedPlacement out;
        out.order_id = static_cast<int>(id);
        if (flag(st, u"perm"_s)) out.perm_id = static_cast<int>(9000 + id);
        out.status = str(st, u"placeStatus"_s);
        if (const OJson* res = b.get(u"res"_s)) {
            if (const OJson* o = res->get(u"order_id"_s)) out.order_id = o->type == OJson::Null ? std::nullopt : std::optional<int>(static_cast<int>(o->n));
            if (const OJson* p = res->get(u"perm_id"_s)) out.perm_id = p->type == OJson::Null ? std::nullopt : std::optional<int>(static_cast<int>(p->n));
            if (const OJson* s = res->get(u"status"_s)) out.status = js::str(s);
        }
        co_return out;
    }
    bool hasModifyHosted() const override { return capModifyHosted; }
    Task<bool> modifyHosted(qint64 orderId, OJson item) override {
        recr(u"modifyHosted"_s, jn(js::array({js::N(double(orderId)), item})));
        const OJson b = beh.next(u"modifyHosted"_s);
        co_await behave(w_, b);
        const OJson* ret = b.get(u"ret"_s);
        co_return ret ? js::truthy(ret) : true;
    }
    Task<bool> cancelHosted(qint64 orderId) override {
        recr(u"cancelHosted"_s, js::array({js::N(double(orderId))}));
        const OJson b = beh.next(u"cancelHosted"_s);
        co_await behave(w_, b);
        const OJson* ret = b.get(u"ret"_s);
        co_return ret ? js::truthy(ret) : true;
    }
    // ReconcileRouter
    bool hasListOpenOrdersDetailed() const override { return capListOpenOrders; }
    Task<QList<OJson>> listOpenOrdersDetailed() override {
        recr(u"listOpenOrdersDetailed"_s);
        co_await behave(w_, beh.next(u"listOpenOrdersDetailed"_s));
        co_return copies(u"openOrders"_s);
    }
    std::optional<QSet<QString>> coveredAccountIds() override {
        const OJson* c = st.get(u"coveredIds"_s);
        if (!capCoveredIds || js::nullish(c)) return std::nullopt;
        QSet<QString> s;
        for (const OJson& x : c->items) s.insert(js::str(&x));
        return s;
    }
    bool hasExecutions() const override { return capExecutions; }
    Task<QList<OJson>> executions() override {
        recr(u"executions"_s);
        co_await behave(w_, beh.next(u"executions"_s));
        co_return copies(u"execRows"_s);
    }
};

// ======================================================================
// World 本体
// ======================================================================
inline World::World(const OJson& s, const OJson& b) : script(s), base(b) {
    ibkr::util::setDateNowForTests([this] { return T; });
    // 按跌速多让是 C++ 先有的(TS 版没有):对着 TS 夹具比的这一组关掉它,它自己的行为在 tst_fly_fast_exit
    ibkr::analysis::setChaseLeadDefaultForTests(0);
    ibkr::util::setRandomUUIDForTests([this] { return u"00000000-0000-4000-8000-%1"_s.arg(++uuidN, 12, 10, QChar(u'0')); });
    ibkr::execution::setLogSinkForTests([this](const QString& line) { rec(js::object({{u"c"_s, js::S(u"log"_s)}, {u"a"_s, js::array({js::S(line)})}})); });
    setT(num(script, u"start"_s));
    if (const OJson* pp = script.get(u"publicPrices"_s)) publicPrices = *pp;
    rawSettings = base;
    if (const OJson* patch = script.get(u"settings"_s)) rawSettings = deepMerge(base, *patch);
    rawSettings.set(u"storage"_s, js::object({{u"db_path"_s, js::S(dir.path() + u"/trades.db"_s)}}));
    settings = std::make_unique<ibkr::domain::Settings>(ibkr::domain::fromDict(rawSettings));
    real = std::make_unique<ibkr::domain::TradeStore>(settings->db_path);
    realPort = orch::makeCoreStorePort(*real);
    store = std::make_unique<LoggedStore>(*this, *realPort);
    ksReal = std::make_unique<ibkr::util::KillSwitch>(dir.path() + u"/breaker.json"_s);
    ks = std::make_unique<LoggedBreaker>(*this);
    ibkr::util::Notifier::Sink sink = [this](const QString& title, const QString& subtitle, const QString& body) {
        rec(js::object({{u"c"_s, js::S(u"notify"_s)}, {u"a"_s, js::array({js::S(title), js::S(subtitle), js::S(body)})}}));
    };
    notifier = std::make_unique<ibkr::util::Notifier>(false, std::vector<ibkr::util::Notifier::Sink>{sink});
    const OJson* pc = script.get(u"parser"_s);
    parser = std::make_shared<FakeParser>(*this, pc ? *pc : js::object());
    const OJson* rc = script.get(u"router"_s);
    if (rc && rc->type == OJson::Object) router = std::make_shared<FakeRouter>(*this, *rc);

    engine = makeEngine();
}

inline std::unique_ptr<orch::TradingEngine> World::makeEngine() {
    const auto noop = [](auto*) {};
    orch::EngineArgs a;
    a.settings = *settings;
    a.parser = parser;
    a.store = std::shared_ptr<ibkr::domain::TradeStore>(real.get(), noop);
    a.notifier = std::shared_ptr<ibkr::util::Notifier>(notifier.get(), noop);
    a.killswitch = std::shared_ptr<ibkr::util::KillSwitch>(ksReal.get(), noop);
    a.router = router;
    a.bundle = ibkr::parsing::prompts::loadPromptBundle(*settings);
    a.storePort = std::shared_ptr<orch::CoreStore>(store.get(), noop);
    a.breakerPort = std::shared_ptr<orch::BreakerPort>(ks.get(), noop);
    auto engine = std::make_unique<orch::TradingEngine>(std::move(a));
    engine->setTimerHook([this](int ms, std::function<void()> fn) { setTimeout(ms, std::move(fn)); });
    engine->awakeClock = [this] { return mono(); };
    engine->publicPriceFn = [this](const QString& symbol) -> Task<std::optional<double>> {
        rec(js::object({{u"c"_s, js::S(u"host"_s)}, {u"m"_s, js::S(u"publicPrice"_s)}, {u"a"_s, js::array({js::S(symbol)})}}));
        const OJson* v = publicPrices.get(symbol);
        if (js::nullish(v)) co_return std::nullopt;
        co_return js::num(v);
    };
    engine->onTrackerTick = [this](const OJson& poll, const OJson& hosted) { rec(js::object({{u"c"_s, js::S(u"tick"_s)}, {u"a"_s, jn(js::array({poll, hosted}))}})); };
    return engine;
}

inline World::~World() {
    engine.reset();
    ibkr::util::setDateNowForTests({});
    ibkr::analysis::setChaseLeadDefaultForTests(std::nullopt);
    ibkr::util::setRandomUUIDForTests({});
    ibkr::execution::setLogSinkForTests({});
    ibkr::domain::setClock(std::nullopt);
}

inline OJson World::subst(const OJson& x) const {
    if (x.type == OJson::String) {
        static const QRegularExpression re(QStringLiteral("\\$\\{(track|rec):([^}]+)\\}"));
        QString out;
        qsizetype last = 0;
        auto it = re.globalMatch(x.s);
        while (it.hasNext()) {
            const auto m = it.next();
            out += x.s.mid(last, m.capturedStart() - last);
            const auto& map = m.captured(1) == u"track" ? trackNames : recNames;
            const auto f = map.find(m.captured(2));
            if (f == map.end()) qFatal("脚本写错:没有 %s %s", qPrintable(m.captured(1)), qPrintable(m.captured(2)));
            out += f->second;
            last = m.capturedEnd();
        }
        out += x.s.mid(last);
        return js::S(out);
    }
    if (x.type == OJson::Array) {
        OJson o = js::array();
        for (const OJson& v : x.items) o.items.append(subst(v));
        return o;
    }
    if (x.type == OJson::Object) {
        OJson o = js::object();
        for (const auto& [k, v] : x.fields) o.set(k, subst(v));
        return o;
    }
    return x;
}

inline void World::advance(double ms) {
    const double end = T + ms;
    for (;;) {
        std::shared_ptr<Timer> pick;
        for (const auto& t : timers) {
            if (t->dead || t->at > end) continue;
            if (!pick || t->at < pick->at || (t->at == pick->at && t->seq < pick->seq)) pick = t;
        }
        if (!pick) break;
        pick->dead = true;
        setT(std::max(T, pick->at));
        pick->fn();
        collectDone();
    }
    setT(end);
    collectDone();
    timers.erase(std::remove_if(timers.begin(), timers.end(), [](const auto& t) { return t->dead; }), timers.end());
}

inline void World::collectDone() {
    for (auto it = pendingOps.begin(); it != pendingOps.end();) {
        if (!it->second->done) {
            ++it;
            continue;
        }
        const int saved = stepNo;
        stepNo = it->first;
        rec(js::object({{u"c"_s, js::S(u"done"_s)}, {u"r"_s, it->second->result}}));
        stepNo = saved;
        it = pendingOps.erase(it);
    }
}

inline void World::fireEvent(const OJson& e) {
    const QString op = str(e, u"op"_s);
    const auto sub = [&](const QString& k) {
        const OJson* v = e.get(k);
        return v ? subst(*v) : OJson::null();
    };
    if (op == u"status") engine->onOrderStatus(sub(u"trade"_s));
    else if (op == u"error") engine->onIbError(sub(u"reqId"_s), sub(u"code"_s), sub(u"message"_s));
    else if (op == u"exec") engine->onExecDetails(sub(u"trade"_s), sub(u"fill"_s));
    else if (op == u"commission") engine->onCommission(sub(u"trade"_s), sub(u"fill"_s), sub(u"report"_s));
    else if (op == u"deleteTrack") real->deleteTrack(trackNames[str(e, u"track"_s)]);
    else if (op == u"updateTrack") store->updateTrack(trackNames[str(e, u"track"_s)], sub(u"fields"_s));
    else if (op == u"rows") router->st.set(u"rows"_s, sub(u"set"_s));
    else if (op == u"engage") ksReal->engage(e.get(u"reason"_s) ? str(e, u"reason"_s) : u"x"_s);  // C++ 独有:并发熔断
    else qFatal("脚本写错:emit 里不认识的步 %s", qPrintable(op));
}

inline OJson World::snapshot() {
    OJson snap = js::object();
    snap.set(u"hosted"_s, engine->hostedOrders().snapshot());
    const auto sortedKeys = [](const QList<qint64>& keys) {
        QList<qint64> k = keys;
        std::sort(k.begin(), k.end());
        return k;
    };
    const auto sortedSet = [](const QSet<QString>& s) {
        QStringList l(s.begin(), s.end());
        l.sort();
        return js::strings(l);
    };
    OJson oi = js::object();
    for (const qint64 k : sortedKeys(engine->orderIndex.keys())) oi.set(QString::number(k), js::S(engine->orderIndex.value(k)));
    snap.set(u"orderIndex"_s, oi);
    snap.set(u"finalized"_s, sortedSet(engine->finalized));
    snap.set(u"seenFills"_s, sortedSet(engine->seenFills));
    snap.set(u"seenCommissions"_s, sortedSet(engine->seenCommissions));
    OJson um = js::array();
    for (const orch::UnmatchedEvent& u : engine->unmatchedEvents) {
        const OJson* oid = js::path(&u.trade, {u"order"_s, u"orderId"_s});
        um.items.append(js::array({js::S(u.kind), js::nullish(oid) ? js::Null() : *oid}));
    }
    snap.set(u"unmatched"_s, um);
    OJson early = js::object();
    for (const qint64 k : sortedKeys(engine->earlyOrderErrors.keys())) {
        const auto& e = engine->earlyOrderErrors.value(k);
        early.set(QString::number(k), js::array({js::N(e.code), js::S(e.message), js::N(e.at)}));
    }
    snap.set(u"early"_s, early);
    OJson sent = js::object();
    for (const qint64 k : sortedKeys(engine->sentOrders.keys())) {
        const auto& e = engine->sentOrders.value(k);
        sent.set(QString::number(k), js::object({{u"at"_s, js::N(e.at)},
                                                 {u"kind"_s, js::S(e.kind == orch::SentOrder::Kind::Place ? u"place"_s : e.kind == orch::SentOrder::Kind::Modify ? u"modify"_s : u"cancel"_s)}}));
    }
    snap.set(u"sent"_s, sent);
    OJson pend = js::array();
    for (const auto& p : engine->pendingTriggers) pend.items.append(js::object({{u"record_id"_s, js::S(p->record_id)}, {u"fired"_s, js::B(p->fired)}, {u"created_at"_s, js::S(p->created_at)}}));
    snap.set(u"pending"_s, pend);
    snap.set(u"closeChase"_s, engine->closeChaseSnapshot());
    OJson cci = js::object();
    for (const qint64 k : sortedKeys(engine->closeChaseIndex.keys())) cci.set(QString::number(k), js::S(engine->closeChaseIndex.value(k)));
    snap.set(u"closeChaseIndex"_s, cci);
    snap.set(u"closeChaseAdopted"_s, js::B(engine->closeChaseAdopted()));
    snap.set(u"flyMark"_s, engine->flyMarkSnapshot());
    snap.set(u"loop"_s, engine->trackerLoop);
    snap.set(u"reconcile"_s, js::object({{u"at"_s, js::N(engine->reconciler().reconcileAt())},
                                         {u"exec"_s, std::isinf(engine->reconciler().execSyncAt()) ? js::S(u"-Inf"_s) : js::N(engine->reconciler().execSyncAt())}}));
    snap.set(u"breaker"_s, bs(ksReal->state()));
    snap.set(u"tracks"_s, js::array(real->listTracks()));
    return jsfix::enc(snap);
}

inline OJson World::dump() {
    ibkr::util::sqlite::Database db(settings->db_path, {true, true, 5000});
    OJson out = js::object();
    for (const QString& name : {u"trade_records"_s, u"record_events"_s, u"audit_log"_s, u"position_tracks"_s, u"broker_fills"_s}) {
        const auto rows = db.prepare(u"SELECT * FROM \"%1\" ORDER BY rowid"_s.arg(name)).allRows();
        QList<OJson> list;
        for (const auto& r : rows) {
            QList<OJson> cells;
            for (const auto& c : r.cells) {
                if (std::holds_alternative<QByteArray>(c)) cells << js::object({{u"blob"_s, js::S(QString::fromLatin1(std::get<QByteArray>(c).toHex()))}});
                else cells << ibkr::util::sqlite::cellJson(c);
            }
            list << js::array(cells);
        }
        out.set(name, js::array(list));
    }
    return jsfix::enc(out);
}

inline Task<OJson> World::doOp(OJson step) {
    const QString op = str(step, u"op"_s);
    const auto sub = [&](const QString& k) {
        const OJson* v = step.get(k);
        return v ? subst(*v) : OJson::null();
    };
    const auto trackId = [&](const QString& name) {
        const auto it = trackNames.find(name);
        return it == trackNames.end() ? name : it->second;
    };
    const auto moment = [&]() -> std::optional<ibkr::domain::EtNow> {
        if (!step.get(u"atMs"_s)) return std::nullopt;
        return ibkr::domain::etNowFromEpoch(num(step, u"atMs"_s));
    };
    const auto rowAt = [&]() -> OJson { return router->st.get(u"rows"_s)->items[static_cast<int>(num(step, u"rowIndex"_s, 0))]; };
    const auto positionOf = [&](const OJson& raw) {
        OJson posRaw = js::object();
        for (const char16_t* k : {u"account", u"symbol", u"sec_type", u"quantity", u"avg_cost", u"multiplier", u"currency", u"market_price", u"market_value", u"unrealized_pnl"}) {
            if (const OJson* v = js::prop(&raw, QString::fromUtf16(k))) posRaw.set(QString::fromUtf16(k), *v);
        }
        return tk::makePosition(posRaw);
    };

    if (op == u"instruction") {
        std::optional<OJson> snap;
        if (const OJson* s = step.get(u"snap"_s); s && s->type != OJson::Null) snap = *s;
        std::optional<QStringList> accounts;
        if (const OJson* a = step.get(u"accounts"_s); a && a->type != OJson::Null) {
            QStringList l;
            for (const OJson& x : a->items) l << js::str(&x);
            accounts = l;
        }
        orch::InstructionScope scope;
        scope.localOnly = flag(step, u"localOnly"_s);
        const orch::EngineResult r = co_await engine->handleInstruction(str(step, u"text"_s), step.get(u"channel"_s) ? str(step, u"channel"_s) : u"manual"_s, moment(), snap, accounts,
                                                                       flag(step, u"dryRun"_s), scope);
        co_return r.toJson();
    }
    if (op == u"reload") {  // C++ 独有:EngineServer 的 dropEngine + 新引擎(只做引擎这一半:账本与条件单队列交接、回报转给新引擎)
        auto next = makeEngine();
        next->continueFrom(*engine, step.get(u"sameRouter"_s) ? flag(step, u"sameRouter"_s) : true);
        engine->stopTrackerLoop();
        orch::TradingEngine::Forwards f;
        f.onOrderStatus = [this](const OJson& t) { engine->onOrderStatus(t); };
        f.onExecDetails = [this](const OJson& t, const OJson& fl) { engine->onExecDetails(t, fl); };
        f.onCommission = [this](const OJson& t, const OJson& fl, const OJson& r) { engine->onCommission(t, fl, r); };
        f.onIbError = [this](const OJson& a, const OJson& c, const OJson& m) { engine->onIbError(a, c, m); };
        f.wireSession = [this](const orch::SessionPtr& sess) { return engine->wireSession(sess); };
        engine->retire(std::move(f));
        retiredEngines.push_back(std::move(engine));
        engine = std::move(next);
        co_return js::Null();
    }
    if (op == u"fire") co_return js::array(co_await engine->firePending(sub(u"prices"_s)));
    if (op == u"expire") co_return js::N(engine->expirePending(moment()));
    if (op == u"halt") co_return co_await engine->halt(step.get(u"reason"_s) ? str(step, u"reason"_s) : u"x"_s);
    if (op == u"protection") {
        const auto s = engine->protectionState(step.get(u"nowMs"_s) ? std::optional<double>(num(step, u"nowMs"_s)) : std::nullopt);
        const auto pauseJson = [](const ibkr::util::ProtectionPause& p) {
            return js::object({{u"rule"_s, js::S(p.rule)}, {u"reason"_s, js::S(p.reason)}, {u"untilMs"_s, js::N(p.untilMs)}});
        };
        OJson cd = js::object(), ap = js::object();
        for (const QString& k : s.cooldowns.keys()) cd.set(k, pauseJson(*s.cooldowns.find(k)));
        for (const QString& k : s.accountPauses.keys()) ap.set(k, pauseJson(*s.accountPauses.find(k)));
        co_return js::object({{u"pause"_s, s.pause ? pauseJson(*s.pause) : js::Null()}, {u"cooldowns"_s, cd}, {u"accountPauses"_s, ap}});
    }
    if (op == u"tick") {
        co_await engine->trackerTickOnce(moment());
        co_return js::Null();
    }
    if (op == u"poll") {
        std::optional<QList<OJson>> rows;
        if (const OJson* r = step.get(u"rows"_s); r && r->type == OJson::Array) rows = subst(*r).items;
        co_return co_await engine->pollTrackers(moment(), rows);
    }
    if (op == u"sync") {
        std::optional<QList<OJson>> rows;
        if (const OJson* r = step.get(u"rows"_s); r && r->type == OJson::Array) rows = subst(*r).items;
        co_return co_await engine->syncHosted(rows);
    }
    if (op == u"startLoop") {
        if (step.get(u"interval"_s)) engine->startTrackerLoop(static_cast<int>(num(step, u"interval"_s)));
        else engine->startTrackerLoop();
        co_return js::Null();
    }
    if (op == u"stopLoop") {
        engine->stopTrackerLoop();
        co_return js::Null();
    }
    if (op == u"heartbeat") {
        OJson h = engine->trackerHeartbeat();
        h.remove(u"event_loop_last_ms"_s);
        h.remove(u"event_loop_worst_ms"_s);
        co_return h;
    }
    if (op == u"sweep") {
        const auto t = real->getTrack(trackId(str(step, u"track"_s)));
        co_return js::B(co_await engine->sweepExisting(*t, step.get(u"reason"_s) ? str(step, u"reason"_s) : u"手动平仓"_s));
    }
    if (op == u"pendingClose") {
        const auto t = real->getTrack(trackId(str(step, u"track"_s)));
        const auto r = engine->pendingCloseRecord(*t);
        co_return r ? js::S(*r) : js::Null();
    }
    if (op == u"naturalClose") {
        const OJson raw = rowAt();
        OJson positions = js::object();
        for (const OJson& p : ibkr::domain::withCombos(router->st.get(u"rows"_s)->items)) positions.set(js::str(js::prop(&p, u"key"_s)), p);
        const auto r = co_await engine->naturalCloseFor(raw, positionOf(raw), positions);
        co_return r ? js::N(*r) : js::Null();
    }
    if (op == u"closePosition") {
        const auto track = real->getTrack(trackId(str(step, u"track"_s)));
        const OJson raw = rowAt();
        const OJson* autoRaw = js::prop(&*track, u"auto_close"_s);
        const OJson result = js::object({{u"state"_s, js::S(step.get(u"state"_s) ? str(step, u"state"_s) : u"take_profit"_s)},
                                         {u"reason"_s, js::S(step.get(u"reason"_s) ? str(step, u"reason"_s) : u"手动平仓"_s)},
                                         {u"price"_s, step.get(u"price"_s) ? *step.get(u"price"_s) : js::Null()}});
        std::optional<QString> ms;
        if (step.get(u"marketStatus"_s)) ms = str(step, u"marketStatus"_s);
        const auto fired = co_await engine->closePosition(*track, positionOf(raw), tk::makeAutoClose(js::nullish(autoRaw) ? js::object() : *autoRaw), result, ms);
        if (fired && step.get(u"recName"_s)) recNames[str(step, u"recName"_s)] = js::str(js::prop(&*fired, u"record_id"_s));
        co_return fired ? *fired : js::Null();
    }
    if (op == u"marketStatus") co_return js::S(co_await engine->marketStatusFor(rowAt(), moment() ? *moment() : ibkr::domain::nowEt()));
    if (op == u"attach") co_return js::N(engine->attachListeners());
    if (op == u"wire") co_return js::B(engine->wireSession(router->sessionList[static_cast<int>(num(step, u"session"_s, 0))]));
    if (op == u"connect") {
        auto s = std::make_shared<FakeSession>(*step.get(u"def"_s));
        router->sessionList.push_back(s);
        if (router->hook) router->hook(s);
        co_return js::Null();
    }
    if (op == u"session") {
        auto s = router->sessionList[static_cast<int>(num(step, u"session"_s, 0))];
        const QString kind = str(step, u"kind"_s);
        if (kind == u"status") {
            if (!s->hStatus) co_return js::object({{u"noHandler"_s, js::B(true)}});
            s->hStatus(sub(u"trade"_s));
        } else if (kind == u"fill") {
            if (!s->hFill) co_return js::object({{u"noHandler"_s, js::B(true)}});
            s->hFill(sub(u"trade"_s), sub(u"fill"_s));
        } else if (kind == u"commission") {
            if (!s->hCommission) co_return js::object({{u"noHandler"_s, js::B(true)}});
            s->hCommission(sub(u"trade"_s), sub(u"fill"_s), sub(u"report"_s));
        } else {
            if (!s->hError) co_return js::object({{u"noHandler"_s, js::B(true)}});
            s->hError(static_cast<int>(num(step, u"reqId"_s)), static_cast<int>(num(step, u"code"_s)), str(step, u"message"_s));
        }
        co_return js::object({{u"handled"_s, js::B(true)}});
    }
    if (op == u"syncOrders") co_return js::N(co_await engine->syncBrokerOrders());
    if (op == u"brokerCode") co_return js::S(engine->brokerCode());
    if (op == u"track") {
        const OJson t = real->addTrack(sub(u"spec"_s));
        trackNames[str(step, u"name"_s)] = js::str(js::prop(&t, u"id"_s));
        co_return js::object({{u"id"_s, *js::prop(&t, u"id"_s)}});
    }
    if (op == u"updateTrack") co_return js::B(store->updateTrack(trackId(str(step, u"track"_s)), sub(u"fields"_s)));
    if (op == u"deleteTrack") co_return js::B(real->deleteTrack(trackId(str(step, u"track"_s))));
    if (op == u"row") {
        OJson& row = router->st.get(u"rows"_s)->items[static_cast<int>(num(step, u"index"_s))];
        for (const auto& [k, v] : step.get(u"patch"_s)->fields) row.set(k, v);
        co_return js::Null();
    }
    if (op == u"rows") {
        router->st.set(u"rows"_s, sub(u"set"_s));
        co_return js::Null();
    }
    if (op == u"router") {
        if (const OJson* set = step.get(u"set"_s)) {
            for (const auto& [k, v] : set->fields) router->st.set(k, subst(v));
        }
        if (const OJson* push = step.get(u"push"_s)) {
            for (const auto& [m, list] : push->fields) {
                OJson cur = router->beh.queues.get(m) ? *router->beh.queues.get(m) : js::array();
                for (const OJson& b : list.items) cur.items.append(b);
                router->beh.queues.set(m, cur);
            }
        }
        co_return js::Null();
    }
    if (op == u"publicPrices") {
        publicPrices = *step.get(u"set"_s);
        co_return js::Null();
    }
    if (op == u"settings") {
        rawSettings = deepMerge(rawSettings, *step.get(u"patch"_s));
        settings = std::make_unique<ibkr::domain::Settings>(ibkr::domain::fromDict(rawSettings));
        engine->settings = *settings;
        co_return js::Null();
    }
    if (op == u"breaker") {
        const QString action = str(step, u"action"_s);
        const QString reason = step.get(u"reason"_s) ? str(step, u"reason"_s) : u"x"_s;
        if (action == u"engage") co_return bs(ksReal->engage(reason));
        if (action == u"release") co_return bs(ksReal->release());
        // 自动熔断已撤掉:连续失败不再计数、不再自己合上。老脚本里的这几步照走,什么也不做
        if (action == u"engageAuto" || action == u"fail" || action == u"ok") co_return js::Null();
        qFatal("脚本写错:breaker %s", qPrintable(action));
    }
    if (op == u"status" || op == u"error" || op == u"exec" || op == u"commission") {
        fireEvent(step);
        co_return js::Null();
    }
    if (op == u"reconcile") co_return co_await engine->reconcileOrders(step.get(u"now"_s) ? num(step, u"now"_s) : T);
    if (op == u"reconcileSoon") {
        engine->reconcileSoon();
        co_return js::Null();
    }
    if (op == u"record") {
        OJson record = sub(u"record"_s);
        const QString id = store->createRecord(record);
        recNames[str(step, u"name"_s)] = id;
        if (const OJson* events = step.get(u"events"_s)) {
            for (const OJson& e : events->items) store->appendEvent(id, str(e, u"kind"_s), e.get(u"payload"_s) ? subst(*e.get(u"payload"_s)) : OJson::null());
        }
        co_return js::object({{u"id"_s, js::S(id)}});
    }
    if (op == u"rawEvent") {
        const double at = num(step, u"at"_s);
        real->rawExec(u"INSERT INTO record_events (record_id, at, kind, payload) VALUES (?,?,?,?)"_s,
                      {ibkr::util::sqlite::Bind(recNames[str(step, u"record"_s)]), ibkr::util::sqlite::Bind(ibkr::util::isoString(at)), ibkr::util::sqlite::Bind(str(step, u"kind"_s)),
                       ibkr::util::sqlite::Bind(js::stringify(sub(u"payload"_s)))});
        co_return js::Null();
    }
    if (op == u"fills") co_return js::N(store->rememberFills(sub(u"rows"_s).items));
    if (op == u"audit") {
        const OJson detail = sub(u"detail"_s);
        store->audit(str(step, u"actor"_s), str(step, u"action"_s), &detail);
        co_return js::Null();
    }
    if (op == u"finalize") {
        engine->finalized.insert(recNames[str(step, u"rec"_s)]);
        co_return js::Null();
    }
    if (op == u"advance") {
        advance(num(step, u"ms"_s));
        co_return js::Null();
    }
    if (op == u"sleep" || op == u"awake") {
        setT(T + num(step, u"ms"_s));
        co_return js::Null();
    }
    qFatal("脚本写错:不认识的步 %s", qPrintable(op));
    co_return js::Null();
}

inline OJson World::run() {
    OJson steps = js::array();
    int n = 0;
    const auto start = [&](const OJson& s, int i) -> std::shared_ptr<Pending> {
        stepNo = i;
        auto p = std::make_shared<Pending>();
        Task<OJson> t;
        try {
            t = doOp(s);
        } catch (const ibkr::util::JsError& e) {
            p->done = true;
            p->result = js::object({{u"error"_s, js::S(e.message())}});
            return p;
        }
        const auto finish = [p, t]() {
            if (t.error()) {
                QString msg;
                try {
                    std::rethrow_exception(t.error());
                } catch (const ibkr::util::JsError& e) {
                    msg = e.message();
                } catch (const std::exception& e) {
                    msg = QString::fromStdString(e.what());
                }
                p->result = js::object({{u"error"_s, js::S(msg)}});
            } else {
                p->result = jsfix::enc(t.result());
            }
            p->done = true;
        };
        t.onDone(finish);
        return p;
    };
    if (const OJson* setup = script.get(u"setup"_s)) {
        for (const OJson& s : setup->items) {
            const auto p = start(s, -1);
            if (!p->done || p->result.get(u"error"_s)) qFatal("setup 失败");
            stepNo = -1;
        }
    }
    if (const OJson* ss = script.get(u"steps"_s)) {
        for (const OJson& s : ss->items) {
            OJson record = js::object({{u"i"_s, js::N(n)}, {u"op"_s, js::S(str(s, u"op"_s))}});
            if (str(s, u"op"_s) == u"sleep") slept += num(s, u"ms"_s);  // 睡着的这一段"醒着的钟"不走
            const auto p = start(s, n);
            if (p->done) {
                record.set(u"r"_s, p->result);
            } else {
                pendingOps[n] = p;
                record.set(u"r"_s, js::object({{u"pending"_s, js::B(true)}}));
            }
            const OJson snap = snapshot();
            const QString text = js::stringify(snap);
            if (text != prevSnap) {
                record.set(u"snap"_s, snap);
                prevSnap = text;
            }
            steps.items.append(record);
            ++n;
        }
    }
    stepNo = n;
    collectDone();
    return js::object({{u"steps"_s, steps}, {u"log"_s, log}, {u"dump"_s, dump()}});
}

}  // namespace ecw
