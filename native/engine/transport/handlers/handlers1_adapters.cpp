#include "transport/handlers/handlers1_adapters.h"

#include "execution/broker.h"
#include "orchestrate/engine.h"
#include "orchestrate/services/alerts_service.h"
#include "orchestrate/services/broker_link.h"
#include "util/jsobj.h"

namespace ibkr::rpc {

using namespace Qt::StringLiterals;
namespace js = util::js;
using util::OJson;
template <class T = void>
using Task = util::Task<T>;

namespace {

class EnginePortImpl final : public EnginePort {
public:
    explicit EnginePortImpl(orchestrate::TradingEngine& e) : e_(e) {}

    domain::TradeStore& store() override { return e_.store(); }
    util::KillSwitch& killswitch() override { return e_.killswitch(); }
    void notifyWarning(const QString& message) override { e_.notifier().warning(message); }

    const OJson& trackerLoop() override { return e_.trackerLoop; }
    OJson trackerHeartbeat() override { return e_.trackerHeartbeat(); }
    Task<OJson> pollTrackers() override { return e_.pollTrackers(); }
    Task<OJson> syncHosted() override { return e_.syncHosted(); }
    Task<std::optional<double>> naturalCloseFor(const OJson& raw, const orchestrate::tracker::Position& position, const OJson& rows) override {
        return e_.naturalCloseFor(raw, position, rows);
    }
    std::optional<double> sessionEmToday(const domain::EtNow& now) override { return e_.sessionEm.today(now); }
    Task<QString> marketStatusFor(const OJson& raw, const domain::EtNow& at) override { return e_.marketStatusFor(raw, at); }
    bool accountIsPaper(const QString& alias) override { return e_.accountIsPaper(alias); }
    Task<bool> sweepExisting(const OJson& track, const QString& reason) override { return e_.sweepExisting(track, reason); }
    std::optional<QString> pendingCloseRecord(const OJson& track) override { return e_.pendingCloseRecord(track); }
    Task<std::optional<OJson>> closePosition(const OJson& track, const orchestrate::tracker::Position& position, const OJson& autoClose, const OJson& result,
                                             const QString& marketStatus) override {
        return e_.closePosition(track, position, autoClose, result, marketStatus);
    }

    Task<OJson> handleInstruction(const QString& text, const QString& channel, const QStringList& accounts, bool dryRun) override {
        return instruct(text, channel, accounts, dryRun);
    }
    QList<PendingTriggerView> pendingTriggers() override {
        QList<PendingTriggerView> out;
        for (const auto& p : e_.pendingTriggers) {
            const OJson* order = &p->approved.order;
            PendingTriggerView v;
            v.record_id = js::S(p->record_id);
            v.intent_summary = js::copyOrNull(js::prop(order, u"intent_summary"_s));
            v.symbol = js::copyOrNull(js::prop(&p->trigger, u"symbol"_s));
            v.op = js::copyOrNull(js::prop(&p->trigger, u"operator"_s));
            v.value = js::copyOrNull(js::prop(&p->trigger, u"value"_s));
            v.account = js::S(p->approved.account.alias);
            v.created_at = js::S(p->created_at);
            out.append(v);
        }
        return out;
    }
    Task<double> syncBrokerOrders() override { return sync(); }
    Task<QList<OJson>> firePending(const OJson& prices) override { return e_.firePending(prices); }
    double expirePending() override { return e_.expirePending(); }
    Task<OJson> halt(const QString& reason) override { return e_.halt(reason); }

    const parsing::prompts::PromptBundle& bundle() override { return e_.bundle; }
    util::ProtectionState protectionState(double nowMs) override { return e_.protectionState(nowMs); }

private:
    Task<OJson> instruct(QString text, QString channel, QStringList accounts, bool dryRun) {
        const orchestrate::EngineResult r = co_await e_.handleInstruction(std::move(text), std::move(channel), std::nullopt, std::nullopt, std::move(accounts), dryRun);
        co_return r.toJson();
    }
    Task<double> sync() {
        co_return static_cast<double>(co_await e_.syncBrokerOrders());
    }
    orchestrate::TradingEngine& e_;
};

class Handlers1RouterImpl final : public Handlers1Router {
public:
    explicit Handlers1RouterImpl(std::shared_ptr<execution::BrokerRouter> r) : r_(std::move(r)) {}
    // SpotRouter
    Task<std::optional<double>> indexPrice(const QString& symbol) override { return r_->indexPrice(symbol); }
    bool hasSpotInfo() const override { return true; }
    std::optional<OJson> spotInfo(const QString& symbol) override { return r_->spotInfo(symbol); }
    bool hasStreamQuotes() const override { return true; }
    Task<OJson> streamQuotes(const QStringList& symbols) override { return r_->streamQuotes(symbols); }
    // Handlers1Router
    int sessionCount() override { return static_cast<int>(r_->sessions().size()); }
    Task<QList<OJson>> positions() override { return r_->positions(); }
    QStringList connectedNames() override { return r_->connectedNames(); }
    bool upstreamOk() override { return r_->upstreamOk(); }
    bool hasOptionQuotes() const override { return true; }
    Task<> disconnectAll() override { return r_->disconnectAll(); }

private:
    std::shared_ptr<execution::BrokerRouter> r_;
};

class AlertsPortImpl final : public AlertsPort {
public:
    explicit AlertsPortImpl(orchestrate::AlertsService& a) : a_(a) {}
    QStringList adoptTracked(const QStringList& symbols) override { return a_.adoptTracked(symbols); }
    std::optional<QString> adoptForTrack(const QString& symbol) override { return a_.adoptForTrack(symbol); }
    QStringList releaseForTrack(const QSet<QString>& tracked) override { return a_.releaseForTrack(tracked); }

private:
    orchestrate::AlertsService& a_;
};

class BrokerLinkPortImpl final : public BrokerLinkPort {
public:
    explicit BrokerLinkPortImpl(orchestrate::BrokerLinkService& l) : l_(l) {}
    Task<OJson> connect(std::optional<QStringList> names) override { return connectJson(std::move(names)); }
    Task<> disconnect() override { return l_.disconnect(); }
    void forget() override { l_.forget(); }

private:
    Task<OJson> connectJson(std::optional<QStringList> names) {
        const orchestrate::BrokerConnectResult r = co_await l_.connect(std::move(names));
        co_return r.toJson();
    }
    orchestrate::BrokerLinkService& l_;
};

}  // namespace

std::unique_ptr<EnginePort> makeEnginePort(orchestrate::TradingEngine& engine) { return std::make_unique<EnginePortImpl>(engine); }
std::shared_ptr<Handlers1Router> makeHandlers1Router(std::shared_ptr<execution::BrokerRouter> router) { return std::make_shared<Handlers1RouterImpl>(std::move(router)); }
std::unique_ptr<AlertsPort> makeAlertsPort(orchestrate::AlertsService& alerts) { return std::make_unique<AlertsPortImpl>(alerts); }
std::unique_ptr<BrokerLinkPort> makeBrokerLinkPort(orchestrate::BrokerLinkService& link) { return std::make_unique<BrokerLinkPortImpl>(link); }

}  // namespace ibkr::rpc
