// handlers1 簇对拍用的"世界"的 C++ 一半:对应 tests/fixtures/handlers1_world.mjs(约定与脚本格式见那里的开头)。
// 虚拟钟与计时器(svc_world.h 的 World)、真的交易库 / 熔断开关 / 配置文件(临时目录)、脚本驱动的假引擎 / router / alerts / brokerLink / 凭证库,
// 以及把五个域的 handler 经真的 RpcServer 登记、按脚本逐步调用、产出与 JS 一样形状的 {log, steps} 的 Runner。改这个文件就要同时改 handlers1_world.mjs。
//
// 与 JS 的差别(一一对应的处理):
//   · JS 的 async 方法返回的 Promise,调用方的后续永远晚一个微任务;Task 完成时同步续跑。带结果的异步替身在返回前 co_await world.tick()(同 svc_world.h)。
//   · 信封映射:JS 一半抄 server.ts 的 handleInner;这里走真的 RpcServer::call,错误按 rpc_server.cpp 的同一张表映射(RpcError → 码与话;KeychainError → -32008;别的 → -32000「Error: 话」)。
#pragma once

#include "svc_world.h"

#include "domain/store_safety.h"
#include "parsing/prompts.h"
#include "transport/context.h"
#include "transport/handlers/connection_handlers.h"
#include "transport/handlers/handler_ports.h"
#include "transport/handlers/settings_handlers.h"
#include "transport/handlers/system_handlers.h"
#include "transport/handlers/tracker_handlers.h"
#include "transport/handlers/trading_handlers.h"
#include "transport/rpc_server.h"
#include "util/keychain.h"
#include "util/jsvalue.h"
#include "util/killswitch.h"
#include "util/secrets.h"

#include <QFile>
#include <QTemporaryDir>

#include <map>
#include <memory>

namespace h1w {

using ibkr::util::OJson;
using ibkr::util::Task;
namespace js = ibkr::util::js;
namespace rpc = ibkr::rpc;
using namespace Qt::StringLiterals;
using svcw::flag;
using svcw::num;
using svcw::str;

inline QString jsonOf(const OJson& v) { return js::stringify(v); }

/// 脚本里的结果表:按调用先后各取一个,用完重复最后一个
class Scripts {
public:
    explicit Scripts(svcw::World* w) : w_(w) {}
    svcw::World* world() const { return w_; }

    [[noreturn]] static void fail(const OJson& r) {
        const QString cls = str(r, u"cls"_s, u"Error"_s), msg = str(r, u"error"_s);
        if (cls == u"BrokerError") throw ibkr::execution::BrokerError(msg);
        if (cls == u"RpcError") throw ibkr::util::RpcError(int(num(r, u"code"_s)), msg);
        if (cls == u"KeychainError") throw ibkr::util::KeychainError(msg);
        throw ibkr::util::JsError(msg);
    }

    OJson next(const QString& owner, const OJson* cfg, const QString& name, const std::optional<QString>& key, const std::optional<OJson>& dflt) {
        QString k = name;
        if (key && cfg && cfg->get(name + u':' + *key)) k = name + u':' + *key;
        const OJson* list = cfg ? cfg->get(k) : nullptr;
        if (!list && !dflt) qFatal("handlers1_world: %s.%s 未脚本", qPrintable(owner), qPrintable(name));
        const bool have = list && list->type == OJson::Array && !list->items.isEmpty();
        const QString id = owner + u'.' + k;
        const int i = counters_.value(id, 0);
        counters_.insert(id, i + 1);
        if (!have) return js::object({{u"value"_s, dflt ? *dflt : js::Null()}});
        return list->items[qMin<qsizetype>(i, list->items.size() - 1)];
    }
    void forget(const QString& id) { counters_.remove(id); }
    void forgetPrefix(const QString& prefix) {
        for (auto it = counters_.begin(); it != counters_.end();) it = it.key().startsWith(prefix) ? counters_.erase(it) : std::next(it);
    }

    Task<OJson> ask(QString owner, const OJson* cfg, QString name, OJson args, std::optional<QString> key = {}, std::optional<OJson> dflt = {}) {
        w_->rec(owner, name, args);
        const OJson r = next(owner, cfg, name, key, dflt);
        if (flag(r, u"hang"_s)) co_await ibkr::util::Deferred<>().task();
        if (num(r, u"delay"_s) > 0) co_await w_->sleep(num(r, u"delay"_s));
        co_await w_->tick();
        if (r.get(u"error"_s)) fail(r);
        const OJson* v = r.get(u"value"_s);
        co_return v ? jsfix::dec(*v) : js::Null();
    }

    OJson askSync(const QString& owner, const OJson* cfg, const QString& name, const OJson& args, const std::optional<QString>& key = {}, const std::optional<OJson>& dflt = {}) {
        w_->rec(owner, name, args);
        const OJson r = next(owner, cfg, name, key, dflt);
        if (r.get(u"error"_s)) fail(r);
        const OJson* v = r.get(u"value"_s);
        return v ? jsfix::dec(*v) : js::Null();
    }

private:
    svcw::World* w_;
    QHash<QString, int> counters_;
};

inline OJson positionJson(const ibkr::orchestrate::tracker::Position& p) {
    return js::object({{u"account"_s, js::S(p.account)},
                       {u"symbol"_s, js::S(p.symbol)},
                       {u"sec_type"_s, js::S(p.sec_type)},
                       {u"quantity"_s, js::N(p.quantity)},
                       {u"avg_cost"_s, js::N(p.avg_cost)},
                       {u"multiplier"_s, js::N(p.multiplier)},
                       {u"currency"_s, js::S(p.currency)},
                       {u"market_price"_s, js::NOrNull(p.market_price)},
                       {u"market_value"_s, js::NOrNull(p.market_value)},
                       {u"unrealized_pnl"_s, js::NOrNull(p.unrealized_pnl)},
                       {u"leg"_s, js::S(p.leg)}});
}
inline OJson etNowJson(const ibkr::domain::EtNow& n) {
    return js::object({{u"epochMs"_s, js::N(n.epochMs)}, {u"date"_s, js::S(n.date)}, {u"minutes"_s, js::N(n.minutes)}, {u"seconds"_s, js::N(n.seconds)}});
}
inline QStringList stringList(const OJson& v) {
    QStringList l;
    for (const OJson& x : v.items) l.append(x.s);
    return l;
}
inline ibkr::util::ProtectionPause pauseOf(const OJson& o) {
    return {str(o, u"rule"_s), str(o, u"reason"_s), num(o, u"untilMs"_s)};
}

/// 脚本驱动的引擎
class FakeEngine : public rpc::EnginePort {
public:
    FakeEngine(Scripts* s, ibkr::domain::TradeStore* store, ibkr::util::KillSwitch* ks, ibkr::parsing::prompts::PromptBundle bundle)
        : s_(s), store_(store), ks_(ks), bundle_(std::move(bundle)) {}

    OJson results = js::object();
    OJson loop = js::object();
    QList<OJson> pending;

    const OJson* cfg() const { return &results; }
    ibkr::domain::TradeStore& store() override { return *store_; }
    ibkr::util::KillSwitch& killswitch() override { return *ks_; }
    void notifyWarning(const QString& m) override { s_->world()->rec(u"notifier"_s, u"warning"_s, js::array({js::S(m)})); }
    const OJson& trackerLoop() override { return loop; }
    OJson trackerHeartbeat() override { return s_->askSync(u"engine"_s, cfg(), u"trackerHeartbeat"_s, js::array(), {}, js::object()); }
    Task<OJson> pollTrackers() override { return s_->ask(u"engine"_s, cfg(), u"pollTrackers"_s, js::array()); }
    Task<OJson> syncHosted() override { return s_->ask(u"engine"_s, cfg(), u"syncHosted"_s, js::array()); }
    Task<std::optional<double>> naturalCloseFor(const OJson& raw, const ibkr::orchestrate::tracker::Position& position, const OJson& rows) override {
        const OJson v = co_await s_->ask(u"engine"_s, cfg(), u"naturalCloseFor"_s, js::array({raw, positionJson(position), rows}));
        co_return js::nullish(&v) ? std::nullopt : std::optional<double>(js::num(&v));
    }
    std::optional<double> sessionEmToday(const ibkr::domain::EtNow& now) override {
        const OJson v = s_->askSync(u"engine"_s, cfg(), u"sessionEm.today"_s, js::array({etNowJson(now)}), {}, js::Null());
        return js::nullish(&v) ? std::nullopt : std::optional<double>(js::num(&v));
    }
    Task<QString> marketStatusFor(const OJson& raw, const ibkr::domain::EtNow& at) override {
        const OJson v = co_await s_->ask(u"engine"_s, cfg(), u"marketStatusFor"_s, js::array({raw, etNowJson(at)}));
        co_return js::str(&v);
    }
    bool accountIsPaper(const QString& alias) override {
        const OJson v = s_->askSync(u"engine"_s, cfg(), u"accountIsPaper"_s, js::array({js::S(alias)}));
        return js::truthy(&v);
    }
    Task<bool> sweepExisting(const OJson& track, const QString& reason) override {
        const OJson v = co_await s_->ask(u"engine"_s, cfg(), u"sweepExisting"_s, js::array({track, js::S(reason)}));
        co_return js::truthy(&v);
    }
    std::optional<QString> pendingCloseRecord(const OJson& track) override {
        const OJson v = s_->askSync(u"engine"_s, cfg(), u"pendingCloseRecord"_s, js::array({track}), {}, js::Null());
        return js::nullish(&v) ? std::nullopt : std::optional<QString>(js::str(&v));
    }
    Task<std::optional<OJson>> closePosition(const OJson& track, const ibkr::orchestrate::tracker::Position& position, const OJson& autoClose, const OJson& result,
                                             const QString& marketStatus) override {
        const OJson v = co_await s_->ask(u"engine"_s, cfg(), u"closePosition"_s, js::array({track, positionJson(position), autoClose, result, js::S(marketStatus)}));
        co_return js::truthy(&v) ? std::optional<OJson>(v) : std::nullopt;
    }
    Task<OJson> handleInstruction(const QString& text, const QString& channel, const QStringList& accounts, bool dryRun) override {
        return s_->ask(u"engine"_s, cfg(), u"handleInstruction"_s,
                       js::array({js::S(text), js::S(channel), js::Null(), js::Null(), js::strings(accounts), js::B(dryRun)}));
    }
    QList<rpc::PendingTriggerView> pendingTriggers() override {
        QList<rpc::PendingTriggerView> out;
        for (const OJson& p : pending) {
            rpc::PendingTriggerView v;
            v.record_id = js::copyOrNull(js::prop(&p, u"record_id"_s));
            v.intent_summary = js::copyOrNull(js::path(&p, {u"approved"_s, u"order"_s, u"intent_summary"_s}));
            v.symbol = js::copyOrNull(js::path(&p, {u"trigger"_s, u"symbol"_s}));
            v.op = js::copyOrNull(js::path(&p, {u"trigger"_s, u"operator"_s}));
            v.value = js::copyOrNull(js::path(&p, {u"trigger"_s, u"value"_s}));
            v.account = js::copyOrNull(js::path(&p, {u"approved"_s, u"account"_s, u"alias"_s}));
            v.created_at = js::copyOrNull(js::prop(&p, u"created_at"_s));
            out.append(v);
        }
        return out;
    }
    Task<double> syncBrokerOrders() override {
        const OJson v = co_await s_->ask(u"engine"_s, cfg(), u"syncBrokerOrders"_s, js::array(), {}, js::N(0));
        co_return js::num(&v);
    }
    Task<QList<OJson>> firePending(const OJson& prices) override {
        const OJson v = co_await s_->ask(u"engine"_s, cfg(), u"firePending"_s, js::array({prices}));
        co_return v.items;
    }
    double expirePending() override {
        const OJson v = s_->askSync(u"engine"_s, cfg(), u"expirePending"_s, js::array(), {}, js::N(0));
        return js::num(&v);
    }
    Task<OJson> halt(const QString& reason) override { return s_->ask(u"engine"_s, cfg(), u"halt"_s, js::array({js::S(reason)})); }
    const ibkr::parsing::prompts::PromptBundle& bundle() override { return bundle_; }
    ibkr::util::ProtectionState protectionState(double nowMs) override {
        const OJson v = s_->askSync(u"engine"_s, cfg(), u"protectionState"_s, js::array({js::N(nowMs)}), {},
                                    js::object({{u"pause"_s, js::Null()}, {u"cooldowns"_s, js::object()}, {u"accountPauses"_s, js::object()}}));
        ibkr::util::ProtectionState st;
        if (const OJson* p = v.get(u"pause"_s); js::isObj(p)) st.pause = pauseOf(*p);
        if (const OJson* c = v.get(u"cooldowns"_s))
            for (const auto& [k, x] : c->fields) st.cooldowns.insert(k, pauseOf(x));
        if (const OJson* c = v.get(u"accountPauses"_s))
            for (const auto& [k, x] : c->fields) st.accountPauses.insert(k, pauseOf(x));
        return st;
    }

private:
    Scripts* s_;
    ibkr::domain::TradeStore* store_;
    ibkr::util::KillSwitch* ks_;
    ibkr::parsing::prompts::PromptBundle bundle_;
};

/// 脚本驱动的 router
class FakeRouter : public rpc::Handlers1Router {
public:
    FakeRouter(Scripts* s, OJson c) : cfg(std::move(c)), s_(s) {}
    OJson cfg;

    const OJson* results() const { return cfg.get(u"results"_s); }
    int sessionCount() override { return cfg.get(u"sessions"_s) && !js::nullish(cfg.get(u"sessions"_s)) ? int(js::num(cfg.get(u"sessions"_s))) : 1; }
    bool upstreamOk() override {
        s_->world()->rec(u"router"_s, u"upstreamOk"_s, js::array());
        const OJson* v = cfg.get(u"upstreamOk"_s);
        return js::nullish(v) ? true : js::truthy(v);
    }
    QStringList connectedNames() override {
        s_->world()->rec(u"router"_s, u"connectedNames"_s, js::array());
        const OJson* v = cfg.get(u"connected"_s);
        return v ? stringList(*v) : QStringList();
    }
    Task<QList<OJson>> positions() override {
        const OJson v = co_await s_->ask(u"router"_s, results(), u"positions"_s, js::array());
        co_return v.items;
    }
    Task<std::optional<double>> indexPrice(const QString& symbol) override {
        const OJson v = co_await s_->ask(u"router"_s, results(), u"indexPrice"_s, js::array({js::S(symbol)}), symbol);
        co_return js::nullish(&v) ? std::nullopt : std::optional<double>(js::num(&v));
    }
    Task<> disconnectAll() override {
        co_await s_->ask(u"router"_s, results(), u"disconnectAll"_s, js::array(), {}, js::Null());
    }
    bool hasSpotInfo() const override { return cfg.get(u"spotInfo"_s) != nullptr; }
    std::optional<OJson> spotInfo(const QString& symbol) override {
        s_->world()->rec(u"router"_s, u"spotInfo"_s, js::array({js::S(symbol)}));
        const OJson* map = cfg.get(u"spotInfo"_s);
        const OJson* v = map ? map->get(symbol) : nullptr;
        if (!v || v->type == OJson::Null) return std::nullopt;
        return jsfix::dec(*v);
    }
    bool hasStreamQuotes() const override { return flag(cfg, u"streamQuotes"_s); }
    Task<OJson> streamQuotes(const QStringList& symbols) override {
        return s_->ask(u"router"_s, results(), u"streamQuotes"_s, js::array({js::strings(symbols)}), symbols.join(u','));
    }
    bool hasOptionQuotes() const override { return flag(cfg, u"optionQuotes"_s); }

private:
    Scripts* s_;
};

class FakeAlerts : public rpc::AlertsPort {
public:
    FakeAlerts(Scripts* s, const OJson* script) : s_(s), script_(script) {}
    const OJson* cfg() const {
        const OJson* a = js::path(script_, {u"services"_s, u"alerts"_s, u"results"_s});
        return a;
    }
    QStringList adoptTracked(const QStringList& symbols) override {
        return stringList(s_->askSync(u"alerts"_s, cfg(), u"adoptTracked"_s, js::array({js::strings(symbols)}), {}, js::array()));
    }
    std::optional<QString> adoptForTrack(const QString& symbol) override {
        const OJson v = s_->askSync(u"alerts"_s, cfg(), u"adoptForTrack"_s, js::array({js::S(symbol)}), {}, js::Null());
        return js::nullish(&v) ? std::nullopt : std::optional<QString>(js::str(&v));
    }
    QStringList releaseForTrack(const QSet<QString>& tracked) override {
        QStringList l(tracked.begin(), tracked.end());
        std::sort(l.begin(), l.end());
        return stringList(s_->askSync(u"alerts"_s, cfg(), u"releaseForTrack"_s, js::array({js::strings(l)}), {}, js::array()));
    }

private:
    Scripts* s_;
    const OJson* script_;
};

class FakeBrokerLink : public rpc::BrokerLinkPort {
public:
    FakeBrokerLink(Scripts* s, const OJson* script) : s_(s), script_(script) {}
    const OJson* cfg() const { return js::path(script_, {u"services"_s, u"brokerLink"_s, u"results"_s}); }
    Task<OJson> connect(std::optional<QStringList> names) override {
        return s_->ask(u"brokerLink"_s, cfg(), u"connect"_s, js::array({names ? js::strings(*names) : js::Null()}));
    }
    Task<> disconnect() override { co_await s_->ask(u"brokerLink"_s, cfg(), u"disconnect"_s, js::array(), {}, js::Null()); }
    void forget() override { s_->world()->rec(u"brokerLink"_s, u"forget"_s, js::array()); }

private:
    Scripts* s_;
    const OJson* script_;
};

class FakeSecrets : public ibkr::util::SecretBackend {
public:
    FakeSecrets(svcw::World* w, OJson* cfg) : w_(w), cfg_(cfg) {}
    Task<bool> exists(const QString& service, const QString& account) override {
        w_->rec(u"keychain"_s, u"exists"_s, js::array({js::S(service), js::S(account)}));
        const OJson* e = cfg_->get(u"exists"_s);
        const OJson* v = e ? e->get(service + u'|' + account) : nullptr;
        co_return js::truthy(v);
    }
    Task<std::optional<QString>> read(const QString& service, const QString& account) override {
        w_->rec(u"keychain"_s, u"read"_s, js::array({js::S(service), js::S(account)}));
        co_return std::nullopt;
    }
    Task<> write(const QString& service, const QString& account, const QString& secret) override {
        w_->rec(u"keychain"_s, u"write"_s, js::array({js::S(service), js::S(account), js::S(secret)}));
        if (const OJson* e = cfg_->get(u"writeError"_s)) throw ibkr::util::KeychainError(e->s);
        co_return;
    }

private:
    svcw::World* w_;
    OJson* cfg_;
};

/// 一个场景的全部状态
struct State {
    svcw::World* world = nullptr;
    QString settingsPath;
    ibkr::domain::Settings settings;
    std::shared_ptr<rpc::Handlers1Router> router;
    std::shared_ptr<FakeRouter> fakeRouter;
    bool touched = false, built = false;
    std::unique_ptr<FakeEngine> engine;
    std::unique_ptr<FakeAlerts> alerts;
    std::unique_ptr<FakeBrokerLink> brokerLink;
    rpc::SerialLock lock;
};

class Ctx : public rpc::RpcContext {
public:
    explicit Ctx(State* s) : s_(s) {}
    const ibkr::domain::Settings& settings() const override { return s_->settings; }
    std::shared_ptr<ibkr::orchestrate::Router> router() const override { return nullptr; }
    ibkr::orchestrate::TradingEngine& engine() override { qFatal("handlers1 的 handler 只经 Handlers1Ports 碰引擎"); }
    void emitEvent(const QString& event, const OJson& payload) override { s_->world->rec(u"ctx"_s, u"emit"_s, js::array({js::S(event), payload})); }
    void setSettings(ibkr::domain::Settings v) override {
        s_->world->rec(u"ctx"_s, u"setSettings"_s, js::array());
        s_->settings = std::move(v);
    }
    void setRouter(std::shared_ptr<ibkr::orchestrate::Router>) override { qFatal("handlers1 的 handler 只经 Handlers1Ports 清 router"); }
    ibkr::orchestrate::TradingEngine* engineBuilt() const override { return nullptr; }
    std::shared_ptr<rpc::Parser> parserFactory(const ibkr::contract::LLMConfig&) override { qFatal("handlers1_world: parserFactory 不该被碰"); }
    void reload() override {
        s_->world->rec(u"ctx"_s, u"reload"_s, js::array());
        s_->settings = ibkr::domain::loadSettings(s_->settingsPath);
        s_->world->rec(u"ctx"_s, u"dropEngine"_s, js::array());
    }
    void dropEngine() override { s_->world->rec(u"ctx"_s, u"dropEngine"_s, js::array()); }
    rpc::SerialLock& trackerLock() override { return s_->lock; }

private:
    State* s_;
};

class Ports : public rpc::Handlers1Ports {
public:
    explicit Ports(State* s) : s_(s) {}
    rpc::EnginePort& engine() override {
        s_->touched = true;
        s_->built = true;
        return *s_->engine;
    }
    rpc::EnginePort* engineBuilt() override { return s_->built ? s_->engine.get() : nullptr; }
    std::shared_ptr<rpc::Handlers1Router> router() override { return s_->router; }
    void clearRouter() override {
        s_->world->rec(u"ctx"_s, u"setRouter"_s, js::array({js::Null()}));
        s_->router.reset();
        s_->fakeRouter.reset();
    }
    rpc::AlertsPort& alerts() override { return *s_->alerts; }
    rpc::BrokerLinkPort& brokerLink() override { return *s_->brokerLink; }
    QStringList resolveFanoutAccounts(const ibkr::domain::Settings& settings, const QStringList& names) override {
        // engine.ts 的 resolveFanoutAccounts 的复刻(引擎那一份由引擎的人搬;这里只为让 handler 的校验次序可测)
        QStringList seen;
        for (const QString& raw : names) {
            const QString alias = ibkr::util::jsTrim(raw);
            if (alias.isEmpty() || seen.contains(alias)) continue;
            if (alias == u"DEFAULT" || !settings.accountByAlias(alias)) {
                throw ibkr::util::JsError(u"账户别名 '%1' 不在别名表中(可用:%2)。"_s.arg(alias, settings.aliasList().isEmpty() ? u"(未配置)"_s : settings.aliasList().join(u"、"_s)));
            }
            seen.append(alias);
        }
        return seen;
    }
    ibkr::orchestrate::SvcRuntime& runtime() override { return *s_->world; }

private:
    State* s_;
};

inline OJson errorEnvelope(const std::exception_ptr& e) {
    try {
        std::rethrow_exception(e);
    } catch (const ibkr::util::RpcError& r) {
        return js::object({{u"error"_s, js::object({{u"code"_s, js::N(r.code())}, {u"message"_s, js::S(r.message())}})}});
    } catch (const ibkr::util::KeychainError& k) {
        return js::object({{u"error"_s, js::object({{u"code"_s, js::N(-32008)}, {u"message"_s, js::S(k.message())}})}});
    } catch (const ibkr::util::JsError& j) {
        return js::object({{u"error"_s, js::object({{u"code"_s, js::N(-32000)}, {u"message"_s, js::S(u"Error: "_s + j.message())}})}});
    } catch (const std::exception& x) {
        return js::object({{u"error"_s, js::object({{u"code"_s, js::N(-32000)}, {u"message"_s, js::S(u"Error: "_s + QString::fromUtf8(x.what()))}})}});
    }
}

class Runner {
public:
    explicit Runner(const OJson& script) : script_(script), world_(script) {}

    OJson dumpTables(ibkr::domain::TradeStore& store, const QStringList& tables) {
        OJson out = js::object();
        for (const QString& t : tables) {
            auto st = store.db().prepare(u"SELECT * FROM \"%1\" ORDER BY rowid"_s.arg(t));
            OJson rows = js::array();
            for (const auto& row : st.allRows()) {
                OJson r = js::array();
                for (const auto& c : row.cells) {
                    if (const auto* blob = std::get_if<QByteArray>(&c)) r.items.append(js::object({{u"blob"_s, js::S(QString::fromLatin1(blob->toHex()))}}));
                    else r.items.append(ibkr::util::sqlite::cellJson(c));
                }
                rows.items.append(std::move(r));
            }
            out.set(t, std::move(rows));
        }
        return out;
    }

    QMap<QString, QString> dumpFiles(const QStringList& names) {
        QMap<QString, QString> out;
        for (const QString& n : names) {
            QFile f(dir_.path() + u'/' + n);
            if (f.exists() && f.open(QIODevice::ReadOnly)) out.insert(n, ibkr::util::nodeUtf8(f.readAll()));
        }
        return out;
    }

    void writeSettings(const OJson& raw) {
        QFile f(st_.settingsPath);
        if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) qFatal("写不了配置");
        f.write(ibkr::util::toNodeUtf8(ibkr::util::stringifyOJson(raw, 2)));
    }

    OJson substitute(OJson v) const {
        QString text = js::stringify(v);
        text.replace(u"$DIR"_s, js::stringify(js::S(dir_.path())).mid(1).chopped(1));
        return *js::parse(text);
    }

    OJson run() {
        svcw::World& world = world_;
        st_.world = &world;
        Scripts scripts(&world);
        OJson raw = ibkr::domain::deepMerge(h1BaseConfig(), script_.get(u"settings"_s) ? *script_.get(u"settings"_s) : js::object());
        raw.set(u"storage"_s, js::object({{u"db_path"_s, js::S(dir_.path() + u"/trades.db"_s)}}));
        st_.settingsPath = dir_.path() + u"/settings.json";
        writeSettings(raw);
        st_.settings = ibkr::domain::loadSettings(st_.settingsPath);
        ibkr::domain::TradeStore store(st_.settings.db_path);
        ibkr::util::KillSwitch killswitch(dir_.path() + u"/breaker.json", st_.settings.policies.consecutive_failure_breaker);
        st_.engine = std::make_unique<FakeEngine>(&scripts, &store, &killswitch, ibkr::parsing::prompts::loadPromptBundle(st_.settings));
        st_.alerts = std::make_unique<FakeAlerts>(&scripts, &script_);
        st_.brokerLink = std::make_unique<FakeBrokerLink>(&scripts, &script_);
        st_.built = flag(script_, u"engineBuilt"_s);
        OJson secretsCfg = script_.get(u"secrets"_s) ? *script_.get(u"secrets"_s) : js::object();
        ibkr::util::useSecretBackend(std::make_shared<FakeSecrets>(&world, &secretsCfg));
        struct SecretsReset {
            ~SecretsReset() { ibkr::util::useSecretBackend(nullptr); }
        } secretsReset;

        engineSet(script_.get(u"engine"_s) ? *script_.get(u"engine"_s) : js::object(), scripts);
        if (const OJson* r = script_.get(u"router"_s); r && !js::nullish(r)) makeRouter(scripts, jsfix::dec(*r));

        Ctx ctx(&st_);
        Ports ports(&st_);
        rpc::TrackerHandlers tracker(ctx, ports);
        rpc::TradingHandlers trading(ctx, ports);
        rpc::ConnectionHandlers connection(ctx, ports);
        rpc::SettingsHandlers settingsH(ctx, ports);
        rpc::SystemHandlers system(ctx, ports);
        rpc::RpcServer server([](const QByteArray&) {});
        rpc::installMethods(server, {&tracker, &trading, &connection, &settingsH, &system});

        QStringList dump{u"audit_log"_s, u"position_tracks"_s};
        if (const OJson* d = script_.get(u"dump"_s)) dump = stringList(*d);
        QStringList fileNames;
        if (const OJson* f = script_.get(u"files"_s)) fileNames = stringList(*f);

        struct Started {
            OJson params;
            Task<OJson> task;
            bool reported = false;
        };
        std::map<QString, std::unique_ptr<Started>> started;
        OJson steps = js::array();
        OJson prev = dumpTables(store, dump);
        QMap<QString, QString> prevFiles = dumpFiles(fileNames);
        OJson servicesCfg = js::object();
        for (const OJson& step : script_.get(u"steps"_s)->items) {
            const QString op = str(step, u"op"_s);
            OJson rec = js::object();
            rec.set(u"op"_s, js::S(op));
            st_.touched = false;
            if (op == u"advance") {
                world.advance(num(step, u"ms"_s));
            } else if (op == u"call") {
                auto s = std::make_unique<Started>();
                s->params = substitute(step.get(u"a"_s) ? *step.get(u"a"_s) : js::object());
                s->task = server.call(str(step, u"m"_s), s->params);
                started.emplace(str(step, u"id"_s), std::move(s));
            } else if (op == u"config") {
                QFile f(st_.settingsPath);
                if (!f.open(QIODevice::ReadOnly)) qFatal("读不了配置");
                const OJson cur = *ibkr::util::parseOJson(ibkr::util::nodeUtf8(f.readAll()));
                f.close();
                writeSettings(ibkr::domain::deepMerge(cur, *step.get(u"patch"_s)));
                st_.settings = ibkr::domain::loadSettings(st_.settingsPath);
            } else if (op == u"router") {
                if (str(step, u"v"_s) == u"make") makeRouter(scripts, jsfix::dec(script_.get(u"router"_s) ? *script_.get(u"router"_s) : js::object()));
                else {
                    st_.router.reset();
                    st_.fakeRouter.reset();
                }
            } else if (op == u"routerSet") {
                if (st_.fakeRouter) {
                    for (const auto& [k, v] : jsfix::dec(*step.get(u"set"_s)).fields) {
                        if (k == u"results") {
                            if (!st_.fakeRouter->cfg.get(u"results"_s)) st_.fakeRouter->cfg.set(u"results"_s, js::object());
                            OJson* res = st_.fakeRouter->cfg.get(u"results"_s);
                            for (const auto& [rk, rv] : v.fields) {
                                res->set(rk, rv);
                                scripts.forget(u"router."_s + rk);
                            }
                        } else {
                            st_.fakeRouter->cfg.set(k, v);
                        }
                    }
                }
            } else if (op == u"engineSet") {
                engineSet(*step.get(u"set"_s), scripts);
            } else if (op == u"servicesSet") {
                // 服务脚本在 script_ 里(FakeAlerts / FakeBrokerLink 直接读它)
                OJson* services = script_.get(u"services"_s);
                if (!services) {
                    script_.set(u"services"_s, js::object());
                    services = script_.get(u"services"_s);
                }
                for (const auto& [svc, set] : step.get(u"set"_s)->fields) {
                    if (!services->get(svc)) services->set(svc, js::object({{u"results"_s, js::object()}}));
                    OJson* cfg = services->get(svc);
                    if (!cfg->get(u"results"_s)) cfg->set(u"results"_s, js::object());
                    OJson* res = cfg->get(u"results"_s);
                    if (const OJson* nr = set.get(u"results"_s))
                        for (const auto& [k, v] : nr->fields) {
                            res->set(k, v);
                            scripts.forget(svc + u'.' + k);
                        }
                }
            } else if (op == u"secrets") {
                for (const auto& [k, v] : step.get(u"set"_s)->fields) secretsCfg.set(k, v);
            } else if (op == u"store") {
                OJson v;
                try {
                    v = storeOp(store, str(step, u"m"_s), step.get(u"a"_s) ? jsfix::dec(*step.get(u"a"_s)) : js::array());
                } catch (const ibkr::util::JsError& e) {
                    v = js::object({{u"error"_s, js::S(e.message())}});
                } catch (const std::exception& e) {
                    v = js::object({{u"error"_s, js::S(QString::fromUtf8(e.what()))}});
                }
                rec.set(u"value"_s, jsfix::enc(v));
            } else if (op == u"killswitch") {
                const QString m = str(step, u"m"_s);
                const OJson a = step.get(u"a"_s) ? jsfix::dec(*step.get(u"a"_s)) : js::array();
                OJson v = js::Null();
                const auto stateJson = [](const ibkr::util::BreakerState& b) {
                    return js::object({{u"engaged"_s, js::B(b.engaged)},
                                       {u"reason"_s, js::S(b.reason)},
                                       {u"at"_s, js::S(b.at)},
                                       {u"consecutive_failures"_s, js::N(b.consecutive_failures)},
                                       {u"consecutive_parse_failures"_s, js::N(b.consecutive_parse_failures)},
                                       {u"auto"_s, js::B(b.autoEngaged)}});
                };
                if (m == u"engage") v = stateJson(killswitch.engage(a.items[0].s, a.items.size() > 1 && js::truthy(&a.items[1])));
                else if (m == u"release") v = stateJson(killswitch.release(a.items.isEmpty() ? u"user"_s : a.items[0].s));
                else if (m == u"recordFailure") {
                    const auto r = killswitch.recordFailure(a.items[0].s, a.items.size() > 1 ? a.items[1].s : u"broker"_s);
                    v = r ? stateJson(*r) : js::Null();
                } else qFatal("不认识的熔断方法 %s", qPrintable(m));
                rec.set(u"value"_s, jsfix::enc(v));
            } else if (op == u"file") {
                QFile f(dir_.path() + u'/' + str(step, u"path"_s));
                if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) f.write(str(step, u"content"_s).toUtf8());
            } else if (op == u"get") {
                if (str(step, u"what"_s) == u"breaker") {
                    const ibkr::util::BreakerState b = killswitch.state();
                    rec.set(u"value"_s, js::object({{u"engaged"_s, js::B(b.engaged)},
                                                    {u"reason"_s, js::S(b.reason)},
                                                    {u"at"_s, js::S(b.at)},
                                                    {u"consecutive_failures"_s, js::N(b.consecutive_failures)},
                                                    {u"consecutive_parse_failures"_s, js::N(b.consecutive_parse_failures)},
                                                    {u"auto"_s, js::B(b.autoEngaged)}}));
                } else {
                    qFatal("不认识的读取 %s", qPrintable(str(step, u"what"_s)));
                }
            } else {
                qFatal("不认识的步 %s", qPrintable(op));
            }
            world.drain();
            OJson done = js::array();
            for (auto& [id, st] : started) {  // std::map 按 key 排序 = JS 的 sort 比较 a[0] < b[0]
                if (st->task.done() && !st->reported) {
                    st->reported = true;
                    OJson r = js::object();
                    r.set(u"id"_s, js::S(id));
                    if (st->task.error()) r.set(u"result"_s, errorEnvelope(st->task.error()));
                    else r.set(u"result"_s, js::object({{u"result"_s, jsfix::enc(st->task.result())}}));
                    done.items.append(std::move(r));
                }
            }
            if (!done.items.isEmpty()) rec.set(u"done"_s, done);
            const OJson now = dumpTables(store, dump);
            OJson changed = js::object();
            for (const QString& t : dump)
                if (js::stringify(*now.get(t)) != js::stringify(*prev.get(t))) changed.set(t, *now.get(t));
            if (!changed.fields.isEmpty()) rec.set(u"store"_s, changed);
            prev = now;
            const QMap<QString, QString> nowFiles = dumpFiles(fileNames);
            OJson changedFiles = js::object();
            for (auto it = nowFiles.cbegin(); it != nowFiles.cend(); ++it)
                if (!prevFiles.contains(it.key()) || prevFiles.value(it.key()) != it.value()) changedFiles.set(it.key(), js::S(it.value()));
            if (!changedFiles.fields.isEmpty()) rec.set(u"files"_s, changedFiles);
            prevFiles = nowFiles;
            if (st_.touched) rec.set(u"engine"_s, js::B(true));
            rec.set(u"T"_s, js::N(world.T));
            steps.items.append(std::move(rec));
        }
        OJson logOut = world.log;
        if (flag(script_, u"sortLog"_s)) {
            std::stable_sort(logOut.items.begin(), logOut.items.end(), [](const OJson& a, const OJson& b) {
                const double ta = num(a, u"t"_s), tb = num(b, u"t"_s);
                if (ta != tb) return ta < tb;
                return js::stringify(a) < js::stringify(b);
            });
        }
        QString text = js::stringify(js::object({{u"log"_s, logOut}, {u"steps"_s, steps}}));
        text.replace(js::stringify(js::S(dir_.path())).mid(1).chopped(1), u"<DIR>"_s);
        return *js::parse(text);
    }

    /// 基础配置(svc_world.mjs 的 BASE_CONFIG,即 broker_world.mjs 里那份)
    static OJson h1BaseConfig() { return *js::parse(QString::fromUtf8(kBaseConfig)); }

private:
    static constexpr const char* kBaseConfig = R"JSON({"prompt_version":"v1.8.0","llm":{"model":"claude-opus-5","effort":"high","temperature":null},
"limits":{"max_order_notional":50000,"max_option_contracts":10,"max_mkt_shares":200,"min_confidence":0.9,"max_spread_slippage":0.1,"max_orders_per_input":5,"duplicate_window_minutes":10,"duplicate_qty_tolerance":0.2},
"policies":{"auto_execute":false,"allow_live_trading":false,"require_trigger_price_verification":true,"trigger_min_gap_bps":5,"closed_market_policy":"reject_market_orders"},
"connections":{"paper":{"host":"127.0.0.1","port":7497,"client_id":11},"live":{"host":"127.0.0.1","port":7496,"client_id":12}},
"accounts":[{"alias":"模拟","account_id":"DU7654321","is_paper":true,"connection":"paper","default":true},{"alias":"主账户","account_id":"U1234567","is_paper":false,"connection":"live"},{"alias":"副账户","account_id":"U7777777","is_paper":false,"connection":"live"}],
"symbol_aliases":{"苹果":"AAPL"},
"index_symbols":{"SPX":{"exchange":"CBOE","daily_trading_class":"SPXW","monthly_trading_class":"SPX","futures":"ES","futures_exchange":"CME"},"VIX":{"exchange":"CBOE","daily_trading_class":"VIXW","monthly_trading_class":"VIX"}},
"market_holidays":["2026-09-07"],"early_close_days":["2026-11-27"]})JSON";

    void makeRouter(Scripts& scripts, OJson cfg) {
        st_.fakeRouter = std::make_shared<FakeRouter>(&scripts, std::move(cfg));
        st_.router = st_.fakeRouter;
    }

    void engineSet(const OJson& set, Scripts& scripts) {
        FakeEngine& e = *st_.engine;
        if (const OJson* r = set.get(u"results"_s))
            for (const auto& [k, v] : r->fields) {
                e.results.set(k, v);
                scripts.forget(u"engine."_s + k);
            }
        if (const OJson* l = set.get(u"loop"_s)) e.loop = jsfix::dec(*l);
        if (const OJson* p = set.get(u"pending"_s)) {
            e.pending.clear();
            for (const OJson& x : jsfix::dec(*p).items) e.pending.append(x);
        }
    }

    /// 脚本里 {op:"store", m, a} 在库上调的方法
    static OJson storeOp(ibkr::domain::TradeStore& store, const QString& m, const OJson& a) {
        const auto at = [&a](int i) -> const OJson& { return a.items[i]; };
        if (m == u"addTrack") return store.addTrack(at(0));
        if (m == u"updateTrack") return js::B(store.updateTrack(at(0).s, at(1)));
        if (m == u"getTrack") {
            const auto t = store.getTrack(at(0).s);
            return t ? *t : js::Null();
        }
        if (m == u"createRecord") {
            OJson rec = at(0);
            return js::S(store.createRecord(rec));
        }
        if (m == u"setFinalStatus") {
            store.setFinalStatus(at(0).s, at(1).s, a.items.size() > 2 && !js::nullish(&a.items[2]) ? std::optional<QString>(a.items[2].s) : std::nullopt);
            return js::Null();
        }
        if (m == u"appendEvent") {
            store.appendEvent(at(0).s, at(1).s, at(2));
            return js::Null();
        }
        if (m == u"audit") {
            const OJson* detail = a.items.size() > 2 ? &a.items[2] : nullptr;
            store.audit(at(0).s, at(1).s, detail);
            return js::Null();
        }
        qFatal("handlers1_world: 脚本里不认识的库方法 %s", qPrintable(m));
    }

    OJson script_;
    svcw::World world_;
    QTemporaryDir dir_;
    State st_;
};

/// 夹具文件(每个文件 {scenarios: [{name, script, expected}]})读一次
inline const OJson& fixture(const QString& file) {
    static QHash<QString, OJson> cache;
    if (!cache.contains(file)) cache.insert(file, jsfix::load(file));
    return cache[file];
}
/// QTest 数据行:每个场景一行
inline void addRows(const QString& file) {
    QTest::addColumn<int>("index");
    int i = 0;
    for (const OJson& sc : fixture(file).get(u"scenarios"_s)->items) QTest::newRow(qPrintable(sc.get(u"name"_s)->s)) << i++;
}
}  // namespace h1w

/// 在测试类里定义 name_data() 与 name():file 是夹具文件名
#define H1_SCENARIOS(name, file)                                                                                         \
    void name##_data() { h1w::addRows(file); }                                                                           \
    void name() {                                                                                                        \
        const QString tag = QString::fromUtf8(QTest::currentDataTag());                                                  \
        const jsfix::OJson* sc = nullptr;                                                                                \
        for (const jsfix::OJson& s : h1w::fixture(file).get(u"scenarios"_s)->items)                                      \
            if (s.get(u"name"_s)->s == tag) sc = &s;                                                                     \
        QVERIFY(sc);                                                                                                     \
        h1w::Runner runner(*sc->get(u"script"_s));                                                                       \
        const jsfix::OJson got = runner.run();                                                                           \
        JSFIX_SAME(*sc->get(u"expected"_s), got, tag);                                                                   \
    }
