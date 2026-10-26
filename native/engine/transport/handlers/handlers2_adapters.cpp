#include "transport/handlers/handlers2_adapters.h"

#include "execution/broker.h"

namespace ibkr::rpc {

using util::OJson;
using util::Task;

namespace {

class RouterAdapter : public HandlerRouter {
public:
    explicit RouterAdapter(std::shared_ptr<execution::BrokerRouter> r) : r_(std::move(r)) {}
    bool hasSessions() override { return !r_->sessions().empty(); }
    Task<QList<OJson>> historicalBars(QString symbol, QString start, QString end) override { return r_->historicalBars(std::move(symbol), std::move(start), std::move(end)); }
    Task<OJson> earnings(QString symbol) override { return r_->earnings(std::move(symbol)); }
    Task<OJson> stockQuotes(QStringList symbols) override { return r_->stockQuotes(std::move(symbols)); }
    Task<OJson> streamQuotes(QStringList symbols) override { return r_->streamQuotes(std::move(symbols)); }
    Task<OJson> orderBook(QString symbol) override { return r_->orderBook(std::move(symbol)); }
    bool hasComboBars() override { return true; }  // 富途不移植:BrokerRouter 都有 comboBars
    Task<QList<OJson>> comboBars(QString symbol, OJson legs, QString day) override { return r_->comboBars(std::move(symbol), std::move(legs), std::move(day)); }

private:
    std::shared_ptr<execution::BrokerRouter> r_;
};

class PoolAdapter : public PoolOps {
public:
    explicit PoolAdapter(orchestrate::PoolService* s) : s_(s) {}
    void ensureMigrated() override { s_->ensureMigrated(); }
    OJson setWatch(const QString& symbol, const orchestrate::PoolWatchPatch& patch, const QString& note) override { return s_->setWatch(symbol, patch, note); }
    std::optional<QString> ensureInPool(const QString& symbol, const QString& company) override { return s_->ensureInPool(symbol, company); }
    QStringList dropWatches(const QStringList& symbols) override { return s_->dropWatches(symbols); }

private:
    orchestrate::PoolService* s_;
};

class AlertsAdapter : public AlertsOps {
public:
    explicit AlertsAdapter(orchestrate::AlertsService* s) : s_(s) {}
    std::optional<QString> levelsStatusOf(const QString& symbol) override { return s_->levelsStatusOf(symbol); }
    QString crossConfirm() override { return s_->crossConfirm(); }
    Task<QList<OJson>> listWatches() override { return s_->listWatches(); }
    analysis::ma_touch::Config touchConfig() override { return s_->touchConfig(); }
    void touchConfigChanged() override { s_->touchConfigChanged(); }
    Task<OJson> refresh(OJson params) override { return s_->refresh(std::move(params)); }
    Task<OJson> poll() override { return s_->poll(); }

private:
    orchestrate::AlertsService* s_;
};

class AnomalyAdapter : public AnomalyOps {
public:
    explicit AnomalyAdapter(orchestrate::AnomalyService* s) : s_(s) {}
    analysis::anomaly::Config config() override { return s_->config(); }
    OJson monitor() override { return s_->monitor(); }
    std::optional<OJson> metricsOf(const QString& symbol) override {
        const auto hit = s_->metricsOf(symbol);
        if (!hit) return std::nullopt;
        return hit->toJson();
    }
    void forget(const QString& symbol) override { s_->forget(symbol); }

private:
    orchestrate::AnomalyService* s_;
};

class EventsAdapter : public EventsOps {
public:
    explicit EventsAdapter(orchestrate::EventsService* s) : s_(s) {}
    Task<OJson> list(bool force) override { return s_->list(force); }
    OJson setConfig(const OJson& config) override { return s_->setConfig(config); }
    OJson add(const OJson& params) override {
        // EventsAddParams(schema 已经管过类型):title / date_et / time_et 必有,note / impact / linger_min 可省
        orchestrate::EventsService::AddParams p;
        const auto text = [&params](const QString& key) {
            const OJson* v = params.get(key);
            return v && v->type == OJson::String ? v->s : QString();
        };
        p.title = text(QStringLiteral("title"));
        p.date_et = text(QStringLiteral("date_et"));
        p.time_et = text(QStringLiteral("time_et"));
        if (const OJson* v = params.get(QStringLiteral("note")); v && v->type == OJson::String) p.note = v->s;
        if (const OJson* v = params.get(QStringLiteral("impact")); v && v->type == OJson::String) p.impact = v->s;
        if (const OJson* v = params.get(QStringLiteral("linger_min")); v && v->type == OJson::Number) p.linger_min = v->n;
        return s_->add(p);
    }
    bool remove(const QString& id) override { return s_->remove(id); }

private:
    orchestrate::EventsService* s_;
};

class IntelAdapter : public IntelOps {
public:
    explicit IntelAdapter(orchestrate::IntelService* s) : s_(s) {}
    Task<OJson> feed(OJson params) override { return s_->feed(std::move(params)); }
    Task<OJson> dossier(OJson params) override { return s_->dossier(std::move(params)); }

private:
    orchestrate::IntelService* s_;
};

class FollowAdapter : public FollowOps {
public:
    explicit FollowAdapter(orchestrate::FollowService* s) : s_(s) {}
    Task<OJson> status() override { return s_->status(); }
    Task<> setToken(QString token) override { return s_->setToken(std::move(token)); }
    Task<> sync(bool restart) override { return s_->sync(restart); }

private:
    orchestrate::FollowService* s_;
};

class MarketAdapter : public MarketOps {
public:
    MarketAdapter(orchestrate::MarketDataService* s, std::function<analysis::macro::Fetcher()> fetcher) : s_(s), fetcher_(std::move(fetcher)) {}
    Task<OJson> wallFor(QString symbol, std::optional<QString> expiry, double width) override { return s_->wallFor(std::move(symbol), std::move(expiry), width); }
    Task<QList<OJson>> dailyHistory(QString symbol, double spanDays) override { return s_->dailyHistory(std::move(symbol), spanDays); }
    std::optional<double> dailyHistoryAskedAt(const QString& symbol) override { return s_->dailyHistoryAskedAt(symbol); }
    Task<orchestrate::PaBars> paBars(QString symbol, QString timeframe, bool rth, bool force, bool indexProxy) override {
        return s_->paBars(std::move(symbol), std::move(timeframe), rth, force, indexProxy);
    }
    analysis::macro::Fetcher macroFetcher() override { return fetcher_(); }

private:
    orchestrate::MarketDataService* s_;
    std::function<analysis::macro::Fetcher()> fetcher_;
};

class TradeHistoryAdapter : public TradeHistoryOps {
public:
    explicit TradeHistoryAdapter(orchestrate::TradeHistoryService* s) : s_(s) {}
    Task<orchestrate::TradeHistory> load(QStringList symbols) override { return s_->load(std::move(symbols)); }
    Task<analysis::performance::Ledger> ledger() override { return s_->ledger(); }

private:
    orchestrate::TradeHistoryService* s_;
};

class SimilarContextAdapter : public SimilarContextOps {
public:
    explicit SimilarContextAdapter(orchestrate::SimilarContextService* s) : s_(s) {}
    Task<std::optional<double>> spot(QString symbol) override { return s_->spot(std::move(symbol)); }
    Task<contract::OrderedMap<double>> flyEntryUnderlyings(QList<OJson> butterflies, QList<OJson> positions, QString symbol) override {
        return s_->flyEntryUnderlyings(std::move(butterflies), std::move(positions), std::move(symbol));
    }
    Task<orchestrate::SimilarContextService::StockRanges> stockRanges(QString symbol, QList<OJson> facts) override { return s_->stockRanges(std::move(symbol), std::move(facts)); }

private:
    orchestrate::SimilarContextService* s_;
};

class StockTripsAdapter : public StockTripsOps {
public:
    explicit StockTripsAdapter(orchestrate::StockTripsService* s) : s_(s) {}
    Task<QList<OJson>> trips() override { return s_->trips(); }

private:
    orchestrate::StockTripsService* s_;
};

class FillSyncAdapter : public FillSyncOps {
public:
    explicit FillSyncAdapter(orchestrate::FillSyncService* s) : s_(s) {}
    Task<std::optional<double>> sync(std::optional<double> nowMs, bool deep) override { return s_->sync(nowMs, deep); }
    bool available() override { return s_->available(); }

private:
    orchestrate::FillSyncService* s_;
};

class IdeaSemanticAdapter : public IdeaSemanticOps {
public:
    explicit IdeaSemanticAdapter(orchestrate::IdeaSemanticService* s) : s_(s) {}
    Task<std::optional<orchestrate::RankMap>> rank(QString query, QList<OJson> pool, orchestrate::LlmJson llm) override {
        return s_->rank(std::move(query), std::move(pool), std::move(llm));
    }

private:
    orchestrate::IdeaSemanticService* s_;
};

class FlyPlannerAdapter : public FlyPlannerOps {
public:
    explicit FlyPlannerAdapter(orchestrate::FlyPlannerService* s) : s_(s) {}
    Task<OJson> planFor(OJson params) override { return s_->planFor(std::move(params)); }
    Task<OJson> spotFor(QString symbol) override { return s_->spotFor(std::move(symbol)); }

private:
    orchestrate::FlyPlannerService* s_;
};

class IvRecorderAdapter : public IvRecorderOps {
public:
    explicit IvRecorderAdapter(orchestrate::IvRecorderService* s) : s_(s) {}
    OJson status() override { return s_->status(); }
    OJson setEnabled(bool on) override { return s_->setEnabled(on); }

private:
    orchestrate::IvRecorderService* s_;
};

class PlaybookAdapter : public PlaybookOps {
public:
    explicit PlaybookAdapter(orchestrate::PlaybookService* s) : s_(s) {}
    OJson snapshot() override { return s_->snapshot(); }
    OJson setEnabled(bool on) override { return s_->setEnabled(on); }

private:
    orchestrate::PlaybookService* s_;
};

class ConcretePorts : public Handlers2Ports {
public:
    explicit ConcretePorts(ConcreteServices s)
        : s_(std::move(s)), pool_(s_.pool), alerts_(s_.alerts), anomaly_(s_.anomaly), events_(s_.events), intel_(s_.intel), follow_(s_.follow), market_(s_.market, [this] { return s_.macroFetcher ? s_.macroFetcher : s_.events->fetcher; }),
          tradeHistory_(s_.tradeHistory), similar_(s_.similarContext), stockTrips_(s_.stockTrips), fillSync_(s_.fillSync), ideaSemantic_(s_.ideaSemantic),
          flyPlanner_(s_.flyPlanner), ivRecorder_(s_.ivRecorder), playbook_(s_.playbook) {}

    domain::TradeStore& store() override { return s_.store(); }
    std::shared_ptr<HandlerRouter> router() override {
        std::shared_ptr<execution::BrokerRouter> broker = s_.broker();
        return broker ? std::make_shared<RouterAdapter>(std::move(broker)) : nullptr;
    }
    std::shared_ptr<parsing::providers::Parser> parser(const contract::LLMConfig& llm) override { return s_.parser(llm); }
    PoolOps& pool() override { return pool_; }
    AlertsOps& alerts() override { return alerts_; }
    AnomalyOps& anomaly() override { return anomaly_; }
    EventsOps& events() override { return events_; }
    IntelOps& intel() override { return intel_; }
    FollowOps& follow() override { return follow_; }
    MarketOps& market() override { return market_; }
    TradeHistoryOps& tradeHistory() override { return tradeHistory_; }
    SimilarContextOps& similarContext() override { return similar_; }
    StockTripsOps& stockTrips() override { return stockTrips_; }
    FillSyncOps& fillSync() override { return fillSync_; }
    IdeaSemanticOps& ideaSemantic() override { return ideaSemantic_; }
    FlyPlannerOps& flyPlanner() override { return flyPlanner_; }
    IvRecorderOps& ivRecorder() override { return ivRecorder_; }
    PlaybookOps& playbook() override { return playbook_; }

private:
    ConcreteServices s_;
    PoolAdapter pool_;
    AlertsAdapter alerts_;
    AnomalyAdapter anomaly_;
    EventsAdapter events_;
    IntelAdapter intel_;
    FollowAdapter follow_;
    MarketAdapter market_;
    TradeHistoryAdapter tradeHistory_;
    SimilarContextAdapter similar_;
    StockTripsAdapter stockTrips_;
    FillSyncAdapter fillSync_;
    IdeaSemanticAdapter ideaSemantic_;
    FlyPlannerAdapter flyPlanner_;
    IvRecorderAdapter ivRecorder_;
    PlaybookAdapter playbook_;
};

}  // namespace

std::unique_ptr<Handlers2Ports> makeConcretePorts(ConcreteServices services) { return std::make_unique<ConcretePorts>(std::move(services)); }

}  // namespace ibkr::rpc
