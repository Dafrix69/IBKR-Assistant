// TradingEngine 的接线:子模块的宿主适配、回报监听(wireSession / attachListeners)、对账 / 回报的转调,以及给 service 层的两个窄面。
#include "analysis/macro.h"
#include "orchestrate/closing.h"
#include "orchestrate/engine_impl.h"
#include "orchestrate/services/public_fetch.h"
#include "orchestrate/session_hours.h"
#include "util/jsobj.h"

#include <mutex>
#include <set>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
namespace js = util::js;
using util::OJson;
using util::Task;

namespace {

class HostedHostA final : public HostedHost {
public:
    explicit HostedHostA(TradingEngine& e) : e_(e) {}
    EngineStore& store() override { return e_.storePort(); }
    util::Notifier& notifier() override { return e_.notifier(); }
    BreakerPort& killswitch() override { return e_.breakerPort(); }
    const domain::Settings& settings() const override { return e_.settings; }
    HostedRouter* router() override { return e_.router(); }
    OrderIndex& orderIndex() override { return e_.orderIndex; }
    EarlyOrderErrors& earlyOrderErrors() override { return e_.earlyOrderErrors; }
    SentOrders& sentOrders() override { return e_.sentOrders; }
    bool accountIsPaper(const QString& alias) override { return e_.accountIsPaper(alias); }
    util::Task<SpotTargetResult> applySpotTarget(Rec track, Rec raw, tracker::Position position, Rec targets, Rec positions, domain::EtNow at) override {
        return e_.applySpotTarget(std::move(track), std::move(raw), std::move(position), std::move(targets), std::move(positions), at);
    }
    util::Task<std::optional<ChaseQuote>> chaseQuote(Rec raw, tracker::Position position, Rec positions, Rec autoClose, std::optional<double> prev, double rounds,
                                                     std::optional<QString> reason) override {
        return e_.chaseQuote(std::move(raw), std::move(position), std::move(positions), std::move(autoClose), prev, rounds, std::move(reason));
    }
    TrackExits& exits() override { return e_.exits(); }
    void chaseWarnIfStuck(const Rec& track, Rec& entry, double limit, double natural) override { e_.chaseWarnIfStuck(track, entry, limit, natural); }
    Rec baseRecord(const QString& instruction, const QString& channel) override { return e_.baseRecord(instruction, channel, nullptr); }
    void onIbError(const Rec& reqId, const Rec& code, const Rec& message) override { e_.onIbError(reqId, code, message); }

private:
    TradingEngine& e_;
};

class ExitsHostA final : public ExitsHost {
public:
    explicit ExitsHostA(TradingEngine& e) : e_(e) {}
    EngineStore& store() override { return e_.storePort(); }
    util::Notifier& notifier() override { return e_.notifier(); }

private:
    TradingEngine& e_;
};

class GuardHostA final : public AccountGuardHost {
public:
    explicit GuardHostA(TradingEngine& e) : e_(e) {}
    const domain::Settings& settings() const override { return e_.settings; }
    AccountGuardRouter* router() override { return e_.router(); }
    EngineStore& store() override { return e_.storePort(); }

private:
    TradingEngine& e_;
};

class ReconHostA final : public ReconcileHost {
public:
    explicit ReconHostA(TradingEngine& e) : e_(e) {}
    EngineStore& store() override { return e_.storePort(); }
    util::Notifier& notifier() override { return e_.notifier(); }
    ReconcileRouter* router() override { return e_.router(); }
    OrderIndex& orderIndex() override { return e_.orderIndex; }
    QSet<QString>& finalized() override { return e_.finalized; }
    QSet<QString>& seenFills() override { return e_.seenFills; }
    QStringList pendingTriggerIds() override {
        QStringList ids;
        for (const auto& p : e_.pendingTriggers) ids << p->record_id;
        return ids;
    }
    void replayUnmatched() override { e_.replayUnmatched(); }

private:
    TradingEngine& e_;
};

class CbHostA final : public CallbackHost {
public:
    explicit CbHostA(TradingEngine& e) : e_(e) {}
    EngineStore& store() override { return e_.storePort(); }
    util::Notifier& notifier() override { return e_.notifier(); }
    OrderIndex& orderIndex() override { return e_.orderIndex; }
    QSet<QString>& finalized() override { return e_.finalized; }
    QSet<QString>& seenFills() override { return e_.seenFills; }
    QSet<QString>& seenCommissions() override { return e_.seenCommissions; }
    std::deque<UnmatchedEvent>& unmatchedEvents() override { return e_.unmatchedEvents; }
    EarlyOrderErrors& earlyOrderErrors() override { return e_.earlyOrderErrors; }
    CallbackHostedOrders& hostedOrders() override { return e_.hostedOrders(); }
    const QHash<qint64, QString>& closeChaseIndex() override { return e_.closeChaseIndex; }
    void closeChaseOnStatus(const Rec& trade) override { e_.closeChaseOnStatus(trade); }
    bool hasCloseChaseModifyRejected() const override { return true; }
    void closeChaseModifyRejected(qint64 orderId) override { e_.closeChaseModifyRejected(orderId); }
    const SentOrders* sentOrders() override { return &e_.sentOrders; }

private:
    TradingEngine& e_;
};

class ShorthandHostA final : public ShorthandHost {
public:
    explicit ShorthandHostA(TradingEngine& e) : e_(e) {}
    ShorthandRouter* router() override { return e_.router(); }
    util::Task<std::optional<double>> publicPrice(const QString& symbol) override {
        if (e_.publicPriceFn) return e_.publicPriceFn(symbol);
        const analysis::macro::Fetcher fetcher = [](const QString& url, double timeoutMs) {
            return publicFetch(url, timeoutMs, u"dafri-trading/0.2 (macro board)"_s, u"数据源"_s);
        };
        return analysis::macro::publicIndexPrice(symbol, 4.0, fetcher);
    }
    EngineStore& store() override { return e_.storePort(); }

private:
    TradingEngine& e_;
};

class HoursHostA final : public HoursHost {
public:
    explicit HoursHostA(TradingEngine& e) : e_(e) {}
    const domain::Settings& settings() const override { return e_.settings; }
    HoursRouter* router() override { return e_.router(); }

private:
    TradingEngine& e_;
};

class Svc1A final : public Svc1Engine {
public:
    Svc1A(TradingEngine& e, ShorthandHost& sh) : e_(e), sh_(sh) {}
    domain::TradeStore& store() override { return e_.store(); }
    void notify(const QString& title, const QString& body, const QString& subtitle, bool os) override { e_.notifier().notify(title, body, subtitle, os); }
    BreakerView breaker() override {
        const util::BreakerState s = e_.breakerPort().state();
        return {s.engaged, s.reason};
    }
    util::Task<OJson> tryLocalShorthand(QString text, PriceSnap& snap, domain::EtNow at, parsing::shorthand::ShorthandMeta& meta) override {
        return tryLocal(std::move(text), &snap, at, &meta);
    }
    util::Task<OJson> handleInstruction(QString text, QString channel, domain::EtNow at, PriceSnap snap, QStringList accounts, bool dryRun, InstructionScope scope) override {
        return handle(std::move(text), std::move(channel), at, std::move(snap), std::move(accounts), dryRun, scope);
    }
    QStringList resolveFanoutAccounts(const domain::Settings& settings, const QStringList& names) override { return orchestrate::resolveFanoutAccounts(settings, names); }
    QString orderLegId(const OJson& contract) override { return orchestrate::orderLegId(js::object({{u"contract"_s, contract}})); }

private:
    util::Task<OJson> tryLocal(QString text, PriceSnap* snap, domain::EtNow at, parsing::shorthand::ShorthandMeta* meta) {
        const auto r = co_await orchestrate::tryLocalShorthand(sh_, std::move(text), snap, at, meta);
        co_return r ? *r : OJson::null();
    }
    util::Task<OJson> handle(QString text, QString channel, domain::EtNow at, PriceSnap snap, QStringList accounts, bool dryRun, InstructionScope scope) {
        const EngineResult r = co_await e_.handleInstruction(std::move(text), std::move(channel), at, std::move(snap), std::move(accounts), dryRun, scope);
        co_return r.toJson();
    }
    TradingEngine& e_;
    ShorthandHost& sh_;
};

class NotifierA final : public NotifierPort {
public:
    explicit NotifierA(TradingEngine& e) : e_(e) {}
    void notify(const QString& title, const QString& body, const QString& subtitle) override { e_.notifier().notify(title, body, subtitle); }
    void warning(const QString& message) override { e_.notifier().warning(message); }

private:
    TradingEngine& e_;
};

class SvcA final : public SvcEngine {
public:
    SvcA(TradingEngine& e, NotifierPort& n) : e_(e), n_(n) {}
    domain::TradeStore& store() override { return e_.store(); }
    NotifierPort& notifier() override { return n_; }
    void reconcileSoon() override { e_.reconcileSoon(); }
    int attachListeners() override { return e_.attachListeners(); }

private:
    TradingEngine& e_;
    NotifierPort& n_;
};

}  // namespace

namespace {

class CoreStorePort final : public CoreStore {
public:
    explicit CoreStorePort(domain::TradeStore& s) : s_(s) {}
    QList<Rec> listTracks() override { return s_.listTracks(); }
    std::optional<Rec> getTrack(const QString& id) override { return s_.getTrack(id); }
    bool updateTrack(const QString& id, const Rec& fields) override { return s_.updateTrack(id, fields); }
    void audit(const QString& actor, const QString& action, const Rec* detail) override { s_.audit(actor, action, detail); }
    QString createRecord(Rec& record) override { return s_.createRecord(record); }
    void markSubmitIntent(const QString& id) override { s_.markSubmitIntent(id); }
    void appendEvent(const QString& id, const QString& kind, const Rec& payload) override { s_.appendEvent(id, kind, payload); }
    void setFinalStatus(const QString& id, const QString& status, const std::optional<QString>& detail) override { s_.setFinalStatus(id, status, detail); }
    std::optional<Rec> getRecord(const QString& id) override { return s_.getRecord(id); }
    QList<Rec> listWorkingRecords(double maxAgeDays, double nowMs) override { return s_.listWorkingRecords(maxAgeDays, nowMs); }
    QList<Rec> fillsByOrderRef(const QString& ref) override { return s_.fillsByOrderRef(ref); }
    double rememberFills(const QList<Rec>& rows) override { return s_.rememberFills(rows); }
    QList<Rec> workingOrders(double sinceMs, double nowMs) override { return s_.risk().workingOrders(sinceMs, nowMs); }
    QList<Rec> dailyLossTrips(double sinceMs, double nowMs) override { return s_.risk().dailyLossTrips(sinceMs, nowMs); }
    QList<Rec> recentOrderDetails(double windowMinutes, double nowMs) override { return s_.risk().recentOrderDetails(windowMinutes, nowMs); }
    QList<Rec> recentCloses(double sinceMs, double nowMs) override { return s_.recentCloses(sinceMs, nowMs); }
    QList<Rec> realizedPnlEvents(double sinceMs, double nowMs) override { return s_.realizedPnlEvents(sinceMs, nowMs); }

private:
    domain::TradeStore& s_;
};

class ParserAdapter final : public EngineParser {
public:
    explicit ParserAdapter(std::shared_ptr<parsing::providers::Parser> p) : p_(std::move(p)) {}
    util::Task<parsing::providers::LLMResponse> parse(parsing::prompts::PromptBundle bundle, QString userMessage) override {
        return p_->parse(std::move(bundle), std::move(userMessage));
    }

private:
    std::shared_ptr<parsing::providers::Parser> p_;
};

}  // namespace

std::unique_ptr<CoreStore> makeCoreStorePort(domain::TradeStore& store) { return std::make_unique<CoreStorePort>(store); }
std::shared_ptr<EngineParser> adaptParser(std::shared_ptr<parsing::providers::Parser> parser) { return std::make_shared<ParserAdapter>(std::move(parser)); }

TradingEngine::Impl::Impl(TradingEngine& e) {
    hostedHost = std::make_unique<HostedHostA>(e);
    exitsHost = std::make_unique<ExitsHostA>(e);
    guardHost = std::make_unique<GuardHostA>(e);
    reconHost = std::make_unique<ReconHostA>(e);
    cbHost = std::make_unique<CbHostA>(e);
    shorthandHost = std::make_unique<ShorthandHostA>(e);
    hoursHost = std::make_unique<HoursHostA>(e);
    svc1 = std::make_unique<Svc1A>(e, *shorthandHost);
    notifierPort = std::make_unique<NotifierA>(e);
    svc = std::make_unique<SvcA>(e, *notifierPort);
}
TradingEngine::Impl::~Impl() = default;

Svc1Engine& TradingEngine::svc1() { return *impl_->svc1; }
SvcEngine& TradingEngine::svcView() { return *impl_->svc; }

// ======================================================================
// 对账 / 回报的转调
// ======================================================================
void TradingEngine::reconcileSoon() { reconciler_->reconcileSoon(); }
bool TradingEngine::reconcileDue(std::optional<double> nowMsArg) { return reconciler_->reconcileDue(nowMsArg ? *nowMsArg : util::dateNow()); }
Task<Rec> TradingEngine::reconcileOrders(std::optional<double> nowMsArg) { return reconciler_->reconcileOrders(nowMsArg ? *nowMsArg : util::dateNow()); }
void TradingEngine::replayUnmatched() { callbacks_->replayUnmatched(); }
void TradingEngine::onIbError(const Rec& reqId, const Rec& errorCode, const Rec& errorString) {
    if (forwards_.onIbError) return forwards_.onIbError(reqId, errorCode, errorString);
    callbacks_->onIbError(reqId, errorCode, errorString);
}
void TradingEngine::onOrderStatus(const Rec& trade) {
    if (forwards_.onOrderStatus) return forwards_.onOrderStatus(trade);
    callbacks_->onOrderStatus(trade);
}
void TradingEngine::onExecDetails(const Rec& trade, const Rec& fill) {
    if (forwards_.onExecDetails) return forwards_.onExecDetails(trade, fill);
    callbacks_->onExecDetails(trade, fill);
}
void TradingEngine::onCommission(const Rec& trade, const Rec& fill, const Rec& report) {
    if (forwards_.onCommission) return forwards_.onCommission(trade, fill, report);
    callbacks_->onCommission(trade, fill, report);
}

void TradingEngine::continueFrom(TradingEngine& old, bool sameRouter) {
    if (sameRouter) inheritLedgersFrom(old);
    adoptPendingTriggers(old);
}

void TradingEngine::adoptPendingTriggers(TradingEngine& from) {
    // 还没触发的条件单(软件盯盘队列)交给新引擎接着盯;触发过的(fired)已经发出去了,不带
    for (const auto& p : from.pendingTriggers)
        if (!p->fired) pendingTriggers.push_back(p);
    from.pendingTriggers.clear();
}

void TradingEngine::inheritLedgersFrom(TradingEngine& from) {
    for (auto it = from.orderIndex.constBegin(); it != from.orderIndex.constEnd(); ++it)
        if (!orderIndex.contains(it.key())) orderIndex.insert(it.key(), it.value());
    for (const QString& id : from.finalized) finalized.insert(id);
    for (const QString& id : from.seenFills) seenFills.insert(id);
    for (const QString& id : from.seenCommissions) seenCommissions.insert(id);
    for (auto it = from.earlyOrderErrors.constBegin(); it != from.earlyOrderErrors.constEnd(); ++it)
        if (!earlyOrderErrors.contains(it.key())) earlyOrderErrors.insert(it.key(), it.value());
    for (auto it = from.sentOrders.constBegin(); it != from.sentOrders.constEnd(); ++it)
        if (!sentOrders.contains(it.key())) sentOrders.insert(it.key(), it.value());
    for (const UnmatchedEvent& e : from.unmatchedEvents) unmatchedEvents.push_back(e);
    wakeGuard = from.wakeGuard;  // 醒后正在等连接稳住、一段停摆还没报完的,重建之后接着算
}
Task<Rec> TradingEngine::syncHosted(std::optional<QList<Rec>> rows) { return hostedOrders_->syncHosted(std::move(rows)); }

QString TradingEngine::brokerCode() { return router_ && router_->broker() == u"futu" ? u"FUTU_ERROR"_s : u"IBKR_ERROR"_s; }

Task<int> TradingEngine::syncBrokerOrders() {
    if (!router_ || !router_->hasPollOrderUpdates()) co_return 0;
    QList<PollUpdate> updates;
    std::optional<QString> failure;
    try {
        updates = co_await router_->pollOrderUpdates();
    } catch (...) {
        failure = jsx::errorMessage(std::current_exception());
    }
    if (failure) {
        storePort_->audit(u"engine"_s, u"poll_orders_failed"_s, js::object({{u"error"_s, js::S(*failure)}}));
        co_return 0;
    }
    int count = 0;
    for (const PollUpdate& u : updates) {
        if (u.kind == u"status") onOrderStatus(u.trade);
        else if (u.kind == u"fill") onExecDetails(u.trade, u.fill);
        else continue;
        count += 1;
    }
    co_return count;
}

namespace {
// TS 把 `_dafriWired` 标在会话对象上;这里按会话指针记在进程里的一张表(引擎重建、router 不变时,标记照样留着,同 TS)
std::mutex g_wiredMutex;
std::vector<std::weak_ptr<execution::IbSession>> g_wired;

bool isWired(const SessionPtr& s) {
    std::lock_guard<std::mutex> lock(g_wiredMutex);
    for (auto it = g_wired.begin(); it != g_wired.end();) {
        const auto p = it->lock();
        if (!p) {
            it = g_wired.erase(it);
            continue;
        }
        if (p == s) return true;
        ++it;
    }
    return false;
}
void markWired(const SessionPtr& s) {
    std::lock_guard<std::mutex> lock(g_wiredMutex);
    g_wired.push_back(s);
}
}  // namespace

bool TradingEngine::wireSession(const SessionPtr& session) {
    if (forwards_.wireSession) return forwards_.wireSession(session);
    if (!session || isWired(session)) return false;
    if (!session->has(execution::Cap::OnOrderStatus)) return false;
    session->onOrderStatus([this, alive = std::weak_ptr<bool>(alive_)](const OJson& trade) {
        if (const auto a = alive.lock(); a && *a) onOrderStatus(trade);
    });
    if (session->has(execution::Cap::OnFill)) {
        session->onFill([this, alive = std::weak_ptr<bool>(alive_)](const OJson& trade, const OJson& fill) {
            if (const auto a = alive.lock(); a && *a) onExecDetails(trade, fill);
        });
    }
    if (session->has(execution::Cap::OnCommission)) {
        session->onCommission([this, alive = std::weak_ptr<bool>(alive_)](const OJson& trade, const OJson& fill, const OJson& report) {
            if (const auto a = alive.lock(); a && *a) onCommission(trade, fill, report);
        });
    }
    if (session->has(execution::Cap::OnError)) {
        session->onError([this, alive = std::weak_ptr<bool>(alive_)](int reqId, int code, const QString& message) {
            if (const auto a = alive.lock(); a && *a) onIbError(js::N(reqId), js::N(code), js::S(message));
        });
    }
    markWired(session);
    // 新会话 = 刚连上或券商重启后重连:断线那段时间里的成交与撤单只能靠对账搬回来
    reconcileSoon();
    return true;
}

int TradingEngine::attachListeners() {
    if (!router_) return 0;
    router_->setSessionHook([this, alive = std::weak_ptr<bool>(alive_)](const SessionPtr& s) {
        if (const auto a = alive.lock(); a && *a) wireSession(s);
    });
    int attached = 0;
    for (const SessionPtr& s : router_->sessions()) {
        if (wireSession(s)) attached += 1;
    }
    return attached;
}

}  // namespace ibkr::orchestrate
