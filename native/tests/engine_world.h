// engine 簇(托管单 / 回报落库 / 执行对账 / 出场状态)对拍用的"世界"的 C++ 一半:读 fixtures/engine_world.mjs 开头约定的同一份脚本,
// 解释得一模一样——虚拟的钟与计时器、可复现的 id、真的交易库与熔断开关、挂了 sink 的通知器、脚本驱动的假 router、宿主(按 engine.ts 接线),
// 把每一次对 router / 库 / 通知 / 熔断 / 宿主的调用(方法、参数、虚拟时刻、先后)与各步结果、内部状态记下来,交给测试和 TS 现跑的答案逐项比。
// 改这个文件就要同时改 engine_world.mjs。
//
// C++ 与 JS 的差别(都不影响对拍的可观察结果):C++ 的协程在等的东西已经完成时不让一拍,所以 JS 那边的"drain"在这里不用;
// 完成检查在每个计时器之后、每一步之后做,与 JS 的 collectDone 同一些点。
#pragma once

#include "analysis/tracker_rules.h"

#include "domain/config.h"
#include "domain/store.h"
#include "execution/broker_pricing.h"
#include "execution/ib_link_down.h"
#include "js_fixture.h"
#include "orchestrate/callbacks.h"
#include "orchestrate/exits.h"
#include "orchestrate/hosted.h"
#include "orchestrate/reconcile.h"
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

namespace ew {

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace orch = ibkr::orchestrate;
namespace tk = ibkr::orchestrate::tracker;
using ibkr::util::Task;

/// 日志里的参数:按 JSON 的样子(JSON.parse(JSON.stringify(x))):NaN 是 null,undefined 的键没有
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

class World {
public:
    World(const OJson& script, const OJson& base);
    ~World();
    /// {steps, log, dump}
    OJson run();

    // ---- 虚拟钟
    struct Timer {
        double at = 0;
        int seq = 0;
        std::function<void()> fn;
        bool dead = false;
    };
    double T = 0;
    int seq = 0;
    std::vector<std::shared_ptr<Timer>> timers;
    int stepNo = -1;
    int uuidN = 0;

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
    Task<> sleep(int ms) {
        ibkr::util::Deferred<> d;
        setTimeout(ms, [d]() mutable { d.resolve(); });
        return d.task();
    }
    void advance(double ms);

    // ---- 日志
    OJson log = js::array();
    void rec(const OJson& entry) {
        OJson o = js::object({{u"s"_s, js::N(stepNo)}, {u"t"_s, js::N(T)}});
        for (const auto& [k, v] : entry.fields) o.set(k, v);
        log.items.append(o);
    }

    // ---- 交易库 / 熔断 / 通知
    QTemporaryDir dir;
    OJson rawSettings;
    std::unique_ptr<ibkr::domain::Settings> settings;
    std::unique_ptr<ibkr::domain::TradeStore> real;
    std::unique_ptr<orch::EngineStore> realPort;
    std::unique_ptr<ibkr::util::KillSwitch> ksReal;
    std::unique_ptr<ibkr::util::Notifier> notifier;

    class LoggedStore;
    class LoggedBreaker;
    std::unique_ptr<orch::EngineStore> store;
    std::unique_ptr<orch::BreakerPort> ks;

    static OJson bs(const ibkr::util::BreakerState& s) {
        return js::object({{u"engaged"_s, js::B(s.engaged)},
                           {u"reason"_s, js::S(s.reason)}});
    }

    // ---- 名字 → id
    std::map<QString, QString> trackNames, recNames;
    QString nameOfTrack(const QString& id) const {
        for (const auto& [n, v] : trackNames)
            if (v == id) return n;
        return id;
    }
    OJson subst(const OJson& x) const;

    // ---- 宿主账
    orch::OrderIndex orderIndex;
    orch::EarlyOrderErrors earlyOrderErrors;
    orch::SentOrders sentOrders;
    QSet<QString> finalized, seenFills, seenCommissions;
    std::deque<orch::UnmatchedEvent> unmatchedEvents;
    QHash<qint64, QString> closeChaseIndex;
    QStringList pendingTriggerIds;
    OJson hostCfg;

    // ---- 假 router
    class FakeRouter;
    std::unique_ptr<FakeRouter> router;
    bool hasRouter = false;

    // ---- 宿主(按 engine.ts 接线)与被测的四块
    class HostedHostImpl;
    class CbHostImpl;
    class ReconHostImpl;
    class ExitsHostImpl;
    std::unique_ptr<ExitsHostImpl> exitsHost;
    std::unique_ptr<orch::TrackExits> exits;
    std::unique_ptr<HostedHostImpl> hostedHost;
    std::unique_ptr<orch::HostedOrders> hosted;
    std::unique_ptr<CbHostImpl> cbHost;
    std::unique_ptr<orch::IbCallbacks> callbacks;
    std::unique_ptr<ReconHostImpl> reconHost;
    std::unique_ptr<orch::Reconciler> reconciler;

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

    const OJson script;
    const OJson base;
    QString prevSnap;
};

// ======================================================================
// 交易库:真库外面包一层,记下调用
// ======================================================================
class World::LoggedStore final : public orch::EngineStore {
public:
    LoggedStore(World& w, orch::EngineStore& inner) : w_(w), inner_(inner) {}
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
    QList<OJson> workingOrders(double, double) override { return {}; }
    QList<OJson> dailyLossTrips(double, double) override { return {}; }

private:
    static OJson entry(const QString& m, const OJson& a) { return js::object({{u"c"_s, js::S(u"store"_s)}, {u"m"_s, js::S(m)}, {u"a"_s, a}}); }
    World& w_;
    orch::EngineStore& inner_;
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
// 假 router
// ======================================================================
class World::FakeRouter final : public orch::HostedRouter, public orch::ReconcileRouter {
public:
    FakeRouter(World& w, const OJson& cfg) : w_(w) {
        const OJson* caps = cfg.get(u"caps"_s);
        const auto cap = [&](const QString& k, bool fallback) {
            const OJson* v = caps ? caps->get(k) : nullptr;
            return v ? js::truthy(v) : fallback;
        };
        capHosted = cap(u"hosted"_s, true);
        capListHostedOpen = cap(u"listHostedOpen"_s, true);
        capListOpenOrders = cap(u"listOpenOrders"_s, false);
        capExecutions = cap(u"executions"_s, false);
        const auto arr = [&](const QString& k) { const OJson* v = cfg.get(k); return v ? *v : js::array(); };
        const auto orNull = [&](const QString& k) { const OJson* v = cfg.get(k); return v ? *v : js::Null(); };
        rows = arr(u"rows"_s);
        covered = orNull(u"covered"_s);
        coveredIds = orNull(u"coveredIds"_s);
        hostedOpen = arr(u"hostedOpen"_s);
        openOrders = arr(u"openOrders"_s);
        execRows = arr(u"execRows"_s);
        nextId = num(cfg, u"nextId"_s, 500);
        perm = flag(cfg, u"perm"_s);
        placeStatus = cfg.get(u"placeStatus"_s) ? str(cfg, u"placeStatus"_s) : u"PreSubmitted"_s;
        if (const OJson* b = cfg.get(u"behaviors"_s)) behaviors = *b;
        capCoveredAccounts = cap(u"coveredAccounts"_s, false);
        capCoveredIds = cap(u"coveredIds"_s, false);
    }

    World& w_;
    bool capHosted = true, capListHostedOpen = true, capListOpenOrders = false, capExecutions = false, capCoveredAccounts = false, capCoveredIds = false;
    OJson rows, covered, coveredIds, hostedOpen, openOrders, execRows;
    double nextId = 500;
    bool perm = false;
    QString placeStatus;
    OJson behaviors = js::object();
    QHash<QString, int> cursor;

    OJson next(const QString& method) {
        const OJson* q = js::prop(&behaviors, method);
        if (!q || !js::isArr(q) || q->items.isEmpty()) return js::object();
        const int i = cursor.value(method, 0);
        if (i < q->items.size()) {
            cursor.insert(method, i + 1);
            return q->items[i];
        }
        return flag(q->items.last(), u"repeat"_s) ? q->items.last() : js::object();
    }
    Task<> behave(OJson b) {
        if (const OJson* e = b.get(u"emit"_s)) {
            for (const OJson& x : e->items) w_.fireEvent(x);
        }
        if (flag(b, u"delay"_s)) co_await w_.sleep(static_cast<int>(num(b, u"delay"_s)));
        if (flag(b, u"hang"_s)) {
            ibkr::util::Deferred<> never;
            co_await never.task();
        }
        if (const OJson* err = b.get(u"error"_s)) {
            const QString cls = str(*err, u"cls"_s), msg = str(*err, u"msg"_s);
            if (cls == u"LinkDown") throw ibkr::execution::LinkDownError();
            if (cls == u"Broker") throw ibkr::execution::BrokerError(msg);
            if (cls == u"Plan") throw orch::HostedPlanError(msg);
            throw ibkr::util::JsError(msg);
        }
    }
    OJson copies(const OJson& list) const { return list; }
    static QList<OJson> toList(const OJson& a) { return a.items; }

    // HostedRouter
    bool supportsHostedClose() const override { return capHosted; }
    std::optional<QSet<QString>> coveredAccounts() override {
        if (!capCoveredAccounts || covered.type == OJson::Null) return std::nullopt;
        QSet<QString> s;
        for (const OJson& x : covered.items) s.insert(js::str(&x));
        return s;
    }
    Task<QList<OJson>> positions() override {
        w_.rec(js::object({{u"c"_s, js::S(u"router"_s)}, {u"m"_s, js::S(u"positions"_s)}}));
        co_await behave(next(u"positions"_s));
        co_return toList(w_.subst(rows));
    }
    bool hasListHostedOpen() const override { return capListHostedOpen; }
    Task<QList<OJson>> listHostedOpen() override {
        w_.rec(js::object({{u"c"_s, js::S(u"router"_s)}, {u"m"_s, js::S(u"listHostedOpen"_s)}}));
        co_await behave(next(u"listHostedOpen"_s));
        co_return toList(w_.subst(hostedOpen));
    }
    Task<ibkr::execution::HostedPlacement> placeHosted(ibkr::contract::AccountConfig account, OJson contractSpec, OJson item, QString oca, QString ref) override {
        w_.rec(js::object({{u"c"_s, js::S(u"router"_s)},
                           {u"m"_s, js::S(u"placeHosted"_s)},
                           {u"a"_s, jn(js::array({js::S(account.alias), js::S(account.account_id), js::B(account.is_paper), contractSpec, item, js::S(oca), js::S(ref)}))}}));
        const OJson b = next(u"placeHosted"_s);
        co_await behave(b);
        nextId += 1;
        const double id = nextId;
        ibkr::execution::HostedPlacement out;
        out.order_id = static_cast<int>(id);
        if (perm) out.perm_id = static_cast<int>(9000 + id);
        out.status = placeStatus;
        if (const OJson* res = b.get(u"res"_s)) {
            if (const OJson* o = res->get(u"order_id"_s)) out.order_id = o->type == OJson::Null ? std::nullopt : std::optional<int>(static_cast<int>(o->n));
            if (const OJson* p = res->get(u"perm_id"_s)) out.perm_id = p->type == OJson::Null ? std::nullopt : std::optional<int>(static_cast<int>(p->n));
            if (const OJson* s = res->get(u"status"_s)) out.status = js::str(s);
        }
        co_return out;
    }
    Task<bool> modifyHosted(qint64 orderId, OJson item) override {
        w_.rec(js::object({{u"c"_s, js::S(u"router"_s)}, {u"m"_s, js::S(u"modifyHosted"_s)}, {u"a"_s, jn(js::array({js::N(double(orderId)), item}))}}));
        const OJson b = next(u"modifyHosted"_s);
        co_await behave(b);
        const OJson* ret = b.get(u"ret"_s);
        co_return ret ? js::truthy(ret) : true;
    }
    Task<bool> cancelHosted(qint64 orderId) override {
        w_.rec(js::object({{u"c"_s, js::S(u"router"_s)}, {u"m"_s, js::S(u"cancelHosted"_s)}, {u"a"_s, js::array({js::N(double(orderId))})}}));
        const OJson b = next(u"cancelHosted"_s);
        co_await behave(b);
        const OJson* ret = b.get(u"ret"_s);
        co_return ret ? js::truthy(ret) : true;
    }

    // ReconcileRouter
    bool hasListOpenOrdersDetailed() const override { return capListOpenOrders; }
    Task<QList<OJson>> listOpenOrdersDetailed() override {
        w_.rec(js::object({{u"c"_s, js::S(u"router"_s)}, {u"m"_s, js::S(u"listOpenOrdersDetailed"_s)}}));
        co_await behave(next(u"listOpenOrdersDetailed"_s));
        co_return toList(w_.subst(openOrders));
    }
    std::optional<QSet<QString>> coveredAccountIds() override {
        if (!capCoveredIds || coveredIds.type == OJson::Null) return std::nullopt;
        QSet<QString> s;
        for (const OJson& x : coveredIds.items) s.insert(js::str(&x));
        return s;
    }
    bool hasExecutions() const override { return capExecutions; }
    Task<QList<OJson>> executions() override {
        w_.rec(js::object({{u"c"_s, js::S(u"router"_s)}, {u"m"_s, js::S(u"executions"_s)}}));
        co_await behave(next(u"executions"_s));
        co_return toList(w_.subst(execRows));
    }
};

// ======================================================================
// 宿主(按 engine.ts 接线)
// ======================================================================
class World::ExitsHostImpl final : public orch::ExitsHost {
public:
    explicit ExitsHostImpl(World& w) : w_(w) {}
    orch::EngineStore& store() override { return *w_.store; }
    ibkr::util::Notifier& notifier() override { return *w_.notifier; }

private:
    World& w_;
};

class World::HostedHostImpl final : public orch::HostedHost {
public:
    explicit HostedHostImpl(World& w) : w_(w) {}
    orch::EngineStore& store() override { return *w_.store; }
    ibkr::util::Notifier& notifier() override { return *w_.notifier; }
    orch::BreakerPort& killswitch() override { return *w_.ks; }
    const ibkr::domain::Settings& settings() const override { return *w_.settings; }
    orch::HostedRouter* router() override { return w_.hasRouter ? static_cast<orch::HostedRouter*>(w_.router.get()) : nullptr; }
    orch::OrderIndex& orderIndex() override { return w_.orderIndex; }
    orch::EarlyOrderErrors& earlyOrderErrors() override { return w_.earlyOrderErrors; }
    orch::SentOrders& sentOrders() override { return w_.sentOrders; }
    bool accountIsPaper(const QString& alias) override {
        const auto* account = w_.settings->accountByAlias(alias);
        return account ? account->is_paper : true;
    }
    Task<orch::SpotTargetResult> applySpotTarget(OJson track, OJson raw, tk::Position position, OJson targets, OJson positions, ibkr::domain::EtNow at) override {
        const QString name = w_.nameOfTrack(js::str(js::prop(&track, u"id"_s)));
        w_.rec(js::object({{u"c"_s, js::S(u"host"_s)},
                           {u"m"_s, js::S(u"applySpotTarget"_s)},
                           {u"a"_s, jn(js::array({js::S(name), js::copyOrNull(js::prop(&raw, u"key"_s)), js::S(position.symbol), js::S(position.sec_type), js::N(position.quantity),
                                                   js::NOrNull(position.market_price), targets, js::strings(js::keys(&positions)), js::N(at.epochMs), js::S(at.date),
                                                   js::N(at.minutes)}))}}));
        OJson t = targets;
        if (const OJson* tp = js::path(&w_.hostCfg, {u"spotTakeProfit"_s, name})) t.set(u"take_profit"_s, *tp);
        orch::SpotTargetResult r;
        r.targets = t;
        r.hold = js::truthy(js::path(&w_.hostCfg, {u"spotHold"_s, name}));
        co_return r;
    }
    Task<std::optional<orch::ChaseQuote>> chaseQuote(OJson raw, tk::Position position, OJson positions, OJson autoClose, std::optional<double> prev, double rounds,
                                                     std::optional<QString> reason) override {
        (void)positions;
        w_.rec(js::object({{u"c"_s, js::S(u"host"_s)},
                           {u"m"_s, js::S(u"chaseQuote"_s)},
                           {u"a"_s, jn(js::array({js::copyOrNull(js::prop(&raw, u"symbol"_s)), js::copyOrNull(js::prop(&raw, u"sec_type"_s)), js::NOrNull(prev), js::N(rounds),
                                                   reason ? js::S(*reason) : js::Null()}))}}));
        std::optional<double> natural;
        if (js::strOr(js::prop(&raw, u"sec_type"_s), QString()) == u"STK") {
            natural = tk::closeLimitPrice(position, position.market_price, js::prop(&autoClose, u"slippage_pct"_s));
        } else if (const OJson* n = js::path(&w_.hostCfg, {u"naturals"_s, js::str(js::prop(&raw, u"symbol"_s))}); !js::nullish(n)) {
            natural = js::num(n);
        }
        if (!natural) co_return std::nullopt;
        const OJson reasonJson = reason ? js::S(*reason) : js::Null();
        const OJson* reasonPtr = reason ? &reasonJson : nullptr;
        orch::ChaseQuote q;
        q.natural = *natural;
        q.limit = tk::chaseLimit(position, *natural, prev, rounds, autoClose, reasonPtr);
        q.floor = tk::chaseFloor(position, *natural, autoClose, reasonPtr);
        co_return q;
    }
    orch::TrackExits& exits() override { return *w_.exits; }
    /// 提前醒(orchestrate/fast_exit)是 C++ 先有的:对着 TS 的托管单场景永远是按节拍的那一轮
    bool earlyTick() const override { return false; }
    void chaseWarnIfStuck(const OJson& track, OJson& entry, double limit, double natural) override {
        w_.rec(js::object({{u"c"_s, js::S(u"host"_s)},
                           {u"m"_s, js::S(u"chaseWarnIfStuck"_s)},
                           {u"a"_s, jn(js::array({js::copyOrNull(js::prop(&track, u"symbol"_s)), js::N(limit), js::N(natural), js::copyOrNull(js::prop(&entry, u"rounds"_s))}))}}));
        if (js::truthy(js::prop(&entry, u"warned"_s)) || orch::jsx::numOr(js::prop(&entry, u"rounds"_s), 0) < tk::kChaseWarnRounds) return;
        entry.set(u"warned"_s, js::B(true));
        w_.notifier->warning(js::str(js::prop(&track, u"symbol"_s)) + u" 追价平仓 "_s + js::str(js::prop(&entry, u"rounds"_s)) + u" 秒仍未成交:挂 "_s + ibkr::util::pyG(limit) +
                             u",此刻自然价 "_s + ibkr::util::pyG(natural) + u"。请留意持仓,必要时手动处理。"_s);
    }
    OJson baseRecord(const QString& instruction, const QString& channel) override {
        return js::object({{u"input"_s, js::object({{u"raw_instruction"_s, js::S(instruction)}, {u"reason"_s, js::S(QString())}, {u"input_channel"_s, js::S(channel)}})},
                           {u"llm"_s, js::object({{u"model"_s, js::S(QString())}, {u"prompt_version"_s, js::S(QString())}, {u"prompt_fingerprint"_s, js::S(QString())},
                                                  {u"intent_summary"_s, js::S(QString())}, {u"confidence"_s, js::Null()}, {u"warnings"_s, js::array()},
                                                  {u"raw_response"_s, js::S(QString())}, {u"usage"_s, js::object()}})},
                           {u"execution_type"_s, js::Null()},
                           {u"trigger"_s, js::Null()},
                           {u"triggered_at"_s, js::Null()},
                           {u"account"_s, js::object()},
                           {u"contract"_s, js::object()},
                           {u"order"_s, js::object()},
                           {u"ibkr"_s, js::object({{u"order_id"_s, js::Null()}, {u"perm_id"_s, js::Null()}, {u"status_timeline"_s, js::array()}, {u"fills"_s, js::array()},
                                                   {u"avg_fill_price"_s, js::Null()}, {u"total_commission"_s, js::Null()}, {u"realized_pnl"_s, js::Null()}})},
                           {u"final_status"_s, js::Null()},
                           {u"error_detail"_s, js::Null()},
                           {u"signature"_s, js::S(QString())}});
    }
    void onIbError(const OJson& reqId, const OJson& code, const OJson& message) override {
        w_.rec(js::object({{u"c"_s, js::S(u"host"_s)}, {u"m"_s, js::S(u"onIbError"_s)}, {u"a"_s, jn(js::array({reqId, code, message}))}}));
        w_.callbacks->onIbError(reqId, code, message);
    }

private:
    World& w_;
};

class World::CbHostImpl final : public orch::CallbackHost {
public:
    explicit CbHostImpl(World& w) : w_(w) {}
    orch::EngineStore& store() override { return *w_.store; }
    ibkr::util::Notifier& notifier() override { return *w_.notifier; }
    orch::OrderIndex& orderIndex() override { return w_.orderIndex; }
    QSet<QString>& finalized() override { return w_.finalized; }
    QSet<QString>& seenFills() override { return w_.seenFills; }
    QSet<QString>& seenCommissions() override { return w_.seenCommissions; }
    std::deque<orch::UnmatchedEvent>& unmatchedEvents() override { return w_.unmatchedEvents; }
    orch::EarlyOrderErrors& earlyOrderErrors() override { return w_.earlyOrderErrors; }
    orch::CallbackHostedOrders& hostedOrders() override { return *w_.hosted; }
    const QHash<qint64, QString>& closeChaseIndex() override { return w_.closeChaseIndex; }
    void closeChaseOnStatus(const OJson& trade) override {
        w_.rec(js::object({{u"c"_s, js::S(u"host"_s)}, {u"m"_s, js::S(u"closeChaseOnStatus"_s)}, {u"a"_s, jn(js::array({trade}))}}));
    }
    bool hasCloseChaseModifyRejected() const override { return flag(w_.hostCfg, u"chaseRejected"_s); }
    void closeChaseModifyRejected(qint64 orderId) override {
        w_.rec(js::object({{u"c"_s, js::S(u"host"_s)}, {u"m"_s, js::S(u"closeChaseModifyRejected"_s)}, {u"a"_s, js::array({js::N(double(orderId))})}}));
    }
    const orch::SentOrders* sentOrders() override { return flag(w_.hostCfg, u"noSentLedger"_s) ? nullptr : &w_.sentOrders; }

private:
    World& w_;
};

class World::ReconHostImpl final : public orch::ReconcileHost {
public:
    explicit ReconHostImpl(World& w) : w_(w) {}
    orch::EngineStore& store() override { return *w_.store; }
    ibkr::util::Notifier& notifier() override { return *w_.notifier; }
    orch::ReconcileRouter* router() override { return w_.hasRouter ? static_cast<orch::ReconcileRouter*>(w_.router.get()) : nullptr; }
    orch::OrderIndex& orderIndex() override { return w_.orderIndex; }
    QSet<QString>& finalized() override { return w_.finalized; }
    QSet<QString>& seenFills() override { return w_.seenFills; }
    QStringList pendingTriggerIds() override { return w_.pendingTriggerIds; }
    void replayUnmatched() override { w_.callbacks->replayUnmatched(); }

private:
    World& w_;
};

// ======================================================================
// World 本体
// ======================================================================
inline World::World(const OJson& s, const OJson& b) : script(s), base(b) {
    const double start = num(script, u"start"_s);
    ibkr::util::setDateNowForTests([this] { return T; });
    // 按跌速多让是 C++ 先有的(TS 版没有):对着 TS 夹具比的这一组关掉它,它自己的行为在 tst_fly_fast_exit
    ibkr::analysis::setChaseLeadDefaultForTests(0);
    ibkr::util::setRandomUUIDForTests([this] { return u"00000000-0000-4000-8000-%1"_s.arg(++uuidN, 12, 10, QChar(u'0')); });
    setT(start);
    rawSettings = base;
    if (const OJson* patch = script.get(u"settings"_s)) rawSettings = deepMerge(base, *patch);
    rawSettings.set(u"storage"_s, js::object({{u"db_path"_s, js::S(dir.path() + u"/trades.db"_s)}}));
    settings = std::make_unique<ibkr::domain::Settings>(ibkr::domain::fromDict(rawSettings));
    real = std::make_unique<ibkr::domain::TradeStore>(settings->db_path);
    realPort = orch::makeStorePort(*real);
    store = std::make_unique<LoggedStore>(*this, *realPort);
    ksReal = std::make_unique<ibkr::util::KillSwitch>(dir.path() + u"/breaker.json"_s);
    ks = std::make_unique<LoggedBreaker>(*this);
    ibkr::util::Notifier::Sink sink = [this](const QString& title, const QString& subtitle, const QString& body) {
        rec(js::object({{u"c"_s, js::S(u"notify"_s)}, {u"a"_s, js::array({js::S(title), js::S(subtitle), js::S(body)})}}));
    };
    notifier = std::make_unique<ibkr::util::Notifier>(false, std::vector<ibkr::util::Notifier::Sink>{sink});
    const OJson* rc = script.get(u"router"_s);
    hasRouter = rc && rc->type == OJson::Object;
    if (hasRouter) router = std::make_unique<FakeRouter>(*this, *rc);
    hostCfg = js::object({{u"spotHold"_s, js::object()}, {u"spotTakeProfit"_s, js::object()}, {u"naturals"_s, js::object()}, {u"noSentLedger"_s, js::B(false)}, {u"chaseRejected"_s, js::B(false)}});
    if (const OJson* h = script.get(u"host"_s)) {
        for (const auto& [k, v] : h->fields) hostCfg.set(k, v);
    }
    exitsHost = std::make_unique<ExitsHostImpl>(*this);
    exits = std::make_unique<orch::TrackExits>(*exitsHost);
    hostedHost = std::make_unique<HostedHostImpl>(*this);
    hosted = std::make_unique<orch::HostedOrders>(*hostedHost);
    hosted->setTimeout = [this](int ms, std::function<void()> fn) { setTimeout(ms, std::move(fn)); };
    cbHost = std::make_unique<CbHostImpl>(*this);
    callbacks = std::make_unique<orch::IbCallbacks>(*cbHost);
    reconHost = std::make_unique<ReconHostImpl>(*this);
    reconciler = std::make_unique<orch::Reconciler>(*reconHost);
    reconciler->setTimeout = [this](int ms, std::function<void()> fn) { setTimeout(ms, std::move(fn)); };
}

inline World::~World() {
    ibkr::util::setDateNowForTests({});
    ibkr::analysis::setChaseLeadDefaultForTests(std::nullopt);
    ibkr::util::setRandomUUIDForTests({});
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
    if (op == u"status") callbacks->onOrderStatus(sub(u"trade"_s));
    else if (op == u"error") callbacks->onIbError(sub(u"reqId"_s), sub(u"code"_s), sub(u"message"_s));
    else if (op == u"exec") callbacks->onExecDetails(sub(u"trade"_s), sub(u"fill"_s));
    else if (op == u"commission") callbacks->onCommission(sub(u"trade"_s), sub(u"fill"_s), sub(u"report"_s));
    else if (op == u"deleteTrack") real->deleteTrack(trackNames[str(e, u"track"_s)]);
    else if (op == u"updateTrack") store->updateTrack(trackNames[str(e, u"track"_s)], sub(u"fields"_s));
    else qFatal("脚本写错:emit 里不认识的步 %s", qPrintable(op));
}

inline OJson World::snapshot() {
    OJson snap = js::object();
    snap.set(u"hosted"_s, hosted->snapshot());
    const auto sortedKeys = [](const QList<qint64>& keys) {
        QList<qint64> k = keys;
        std::sort(k.begin(), k.end());
        return k;
    };
    OJson oi = js::object();
    for (const qint64 k : sortedKeys(orderIndex.keys())) oi.set(QString::number(k), js::S(orderIndex.value(k)));
    snap.set(u"orderIndex"_s, oi);
    const auto sortedSet = [](const QSet<QString>& s) {
        QStringList l(s.begin(), s.end());
        l.sort();
        return js::strings(l);
    };
    snap.set(u"finalized"_s, sortedSet(finalized));
    snap.set(u"seenFills"_s, sortedSet(seenFills));
    snap.set(u"seenCommissions"_s, sortedSet(seenCommissions));
    OJson um = js::array();
    for (const orch::UnmatchedEvent& u : unmatchedEvents) {
        const OJson* oid = js::path(&u.trade, {u"order"_s, u"orderId"_s});
        um.items.append(js::array({js::S(u.kind), js::nullish(oid) ? js::Null() : *oid}));
    }
    snap.set(u"unmatched"_s, um);
    OJson early = js::object();
    for (const qint64 k : sortedKeys(earlyOrderErrors.keys())) {
        const auto& e = earlyOrderErrors.value(k);
        early.set(QString::number(k), js::array({js::N(e.code), js::S(e.message), js::N(e.at)}));
    }
    snap.set(u"early"_s, early);
    OJson sent = js::object();
    for (const qint64 k : sortedKeys(sentOrders.keys())) {
        const auto& e = sentOrders.value(k);
        sent.set(QString::number(k),
                 js::object({{u"at"_s, js::N(e.at)},
                             {u"kind"_s, js::S(e.kind == orch::SentOrder::Kind::Place ? u"place"_s : e.kind == orch::SentOrder::Kind::Modify ? u"modify"_s : u"cancel"_s)}}));
    }
    snap.set(u"sent"_s, sent);
    snap.set(u"reconcile"_s, js::object({{u"at"_s, js::N(reconciler->reconcileAt())},
                                         {u"exec"_s, std::isinf(reconciler->execSyncAt()) ? js::S(u"-Inf"_s) : js::N(reconciler->execSyncAt())}}));
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
    if (op == u"sync") {
        std::optional<QList<OJson>> rows;
        if (const OJson* r = step.get(u"rows"_s); r && r->type == OJson::Array) rows = subst(*r).items;
        co_return co_await hosted->syncHosted(rows);
    }
    if (op == u"track") {
        const OJson t = real->addTrack(sub(u"spec"_s));
        trackNames[str(step, u"name"_s)] = js::str(js::prop(&t, u"id"_s));
        co_return js::object({{u"id"_s, *js::prop(&t, u"id"_s)}});
    }
    if (op == u"updateTrack") co_return js::B(store->updateTrack(trackId(str(step, u"track"_s)), sub(u"fields"_s)));
    if (op == u"deleteTrack") co_return js::B(real->deleteTrack(trackId(str(step, u"track"_s))));
    if (op == u"row") {
        OJson& row = router->rows.items[static_cast<int>(num(step, u"index"_s))];
        for (const auto& [k, v] : step.get(u"patch"_s)->fields) row.set(k, v);
        co_return js::Null();
    }
    if (op == u"rows") {
        router->rows = sub(u"set"_s);
        co_return js::Null();
    }
    if (op == u"router") {
        if (const OJson* set = step.get(u"set"_s)) {
            for (const auto& [k, v] : set->fields) {
                const OJson val = subst(v);
                if (k == u"rows") router->rows = val;
                else if (k == u"covered") router->covered = val;
                else if (k == u"coveredIds") router->coveredIds = val;
                else if (k == u"hostedOpen") router->hostedOpen = val;
                else if (k == u"openOrders") router->openOrders = val;
                else if (k == u"execRows") router->execRows = val;
                else if (k == u"nextId") router->nextId = val.n;
                else qFatal("脚本写错:router.set.%s", qPrintable(k));
            }
        }
        if (const OJson* push = step.get(u"push"_s)) {
            for (const auto& [m, list] : push->fields) {
                OJson cur = router->behaviors.get(m) ? *router->behaviors.get(m) : js::array();
                for (const OJson& b : list.items) cur.items.append(b);
                router->behaviors.set(m, cur);
            }
        }
        co_return js::Null();
    }
    if (op == u"settings") {
        rawSettings = deepMerge(rawSettings, *step.get(u"patch"_s));
        settings = std::make_unique<ibkr::domain::Settings>(ibkr::domain::fromDict(rawSettings));
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
    if (op == u"reconcile") co_return co_await reconciler->reconcileOrders(step.get(u"now"_s) ? num(step, u"now"_s) : T);
    if (op == u"reconcileDue") co_return js::B(reconciler->reconcileDue(step.get(u"now"_s) ? num(step, u"now"_s) : T));
    if (op == u"reconcileSoon") {
        reconciler->reconcileSoon();
        co_return js::Null();
    }
    if (op == u"pending") {
        pendingTriggerIds.clear();
        for (const OJson& id : step.get(u"ids"_s)->items) pendingTriggerIds << subst(id).s;
        co_return js::Null();
    }
    if (op == u"closeChase") {
        if (flag(step, u"clear"_s)) closeChaseIndex.clear();
        if (const OJson* set = step.get(u"set"_s)) {
            for (const auto& [id, tname] : set->fields) closeChaseIndex.insert(id.toLongLong(), trackId(js::str(&tname)));
        }
        co_return js::Null();
    }
    if (op == u"host") {
        for (const auto& [k, v] : step.get(u"set"_s)->fields) hostCfg.set(k, v);
        co_return js::Null();
    }
    if (op == u"triggered") {
        const auto track = real->getTrack(trackId(str(step, u"track"_s)));
        const OJson raw = router->rows.items[static_cast<int>(num(step, u"rowIndex"_s, 0))];
        OJson posRaw = js::object();
        for (const char16_t* k : {u"account", u"symbol", u"sec_type", u"quantity", u"avg_cost", u"multiplier", u"currency", u"market_price", u"market_value", u"unrealized_pnl"}) {
            if (const OJson* v = js::prop(&raw, QString::fromUtf16(k))) posRaw.set(QString::fromUtf16(k), *v);
        }
        orch::HostedOrders::TriggeredArgs args;
        args.track = *track;
        args.raw = raw;
        args.position = tk::makePosition(posRaw);
        args.state = str(step, u"state"_s);
        args.reason = str(step, u"reason"_s);
        args.spotReached = flag(step, u"spotReached"_s);
        args.spotStop = flag(step, u"spotStop"_s);
        OJson row = step.get(u"row"_s) ? subst(*step.get(u"row"_s)) : js::object();
        OJson out = js::object({{u"rows"_s, js::array()}, {u"fired"_s, js::array()}, {u"blocked"_s, js::array()}});
        hosted->onTriggered(args, row, out);
        co_return js::object({{u"row"_s, row}, {u"out"_s, out}});
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
    if (op == u"advance") {
        advance(num(step, u"ms"_s));
        co_return js::Null();
    }
    if (op == u"clearBackoff") {
        hosted->clearBackoff(trackId(str(step, u"track"_s)));
        co_return js::Null();
    }
    if (op == u"liveKinds") {
        QStringList l;
        for (const QString& k : hosted->liveKinds(trackId(str(step, u"track"_s)))) l << k;
        l.sort();
        co_return js::strings(l);
    }
    if (op == u"tpEntry") {
        const auto e = hosted->tpEntry(trackId(str(step, u"track"_s)));
        co_return e ? *e : js::Null();
    }
    if (op == u"index") {
        for (const auto& [k, v] : step.get(u"map"_s)->fields) {
            const auto it = recNames.find(js::str(&v));
            orderIndex.insert(k.toLongLong(), it != recNames.end() ? it->second : subst(v).s);
        }
        co_return js::Null();
    }
    if (op == u"sent") {
        const QString kind = str(step, u"kind"_s);
        sentOrders.insert(static_cast<qint64>(num(step, u"orderId"_s)),
                          orch::SentOrder{step.get(u"at"_s) ? num(step, u"at"_s) : T,
                                          kind == u"place" ? orch::SentOrder::Kind::Place : kind == u"modify" ? orch::SentOrder::Kind::Modify : orch::SentOrder::Kind::Cancel});
        co_return js::Null();
    }
    if (op == u"clear") {
        hosted->clear();
        co_return js::Null();
    }
    if (op == u"finalize") {
        finalized.insert(recNames[str(step, u"rec"_s)]);
        co_return js::Null();
    }
    if (op == u"unsent") {
        sentOrders.clear();
        co_return js::Null();
    }
    if (op == u"handleError") co_return js::B(hosted->handleError(static_cast<qint64>(num(step, u"orderId"_s)), static_cast<int>(num(step, u"code"_s)), str(step, u"message"_s)));
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
        // 这一步的结果:完成时(同步或以后)用 enc 存下
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

}  // namespace ew
