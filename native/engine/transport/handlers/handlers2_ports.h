// handlers2 簇(engine-ts/src/rpc/handlers/ 的 ideas / review / sectors / quality / events / intel / alerts / backtest / follow / market / screener)
// 对引擎、券商 router、解析器、各个 service 的窄接口。
//
// TS 的 handler 通过 `this.ctx` 摸到的东西,在 C++ 里:RpcContext 的 engine() / router() 是不透明类型(引擎还没搬完),parserFactory 的 rpc::Parser 也只是前置声明;
// 各 service 的方法大多不是虚函数。所以每个 handler 只认下面这些抽象类——引擎装配的人(ConcretePorts,见 handlers2_adapters.h)用真的 service 实现它们,
// 测试(tests/h2_world.h)实现另一遍:按脚本回话、把每一次调用记下来。
//
// 对应表(TS → C++):
//   this.engine.store         → Handlers2Ports::store()          domain::TradeStore(具体类:库在 domain 层已搬完,不再套接口)
//   this.router               → Handlers2Ports::router()         空 = router === null;有 = HandlerRouter(sessions().length 收成 hasSessions())
//   this.parserFactory(llm)   → Handlers2Ports::parser(llm)      parsing::providers::Parser(buildParser + guardAccountIds 造出来的那个类型)
//   this.ctx.<service>.<m>    → Handlers2Ports::<service>().<m>  每个 service 一个 *Ops 抽象类,只列 handler 真调的那几个方法,签名同 service 的 C++ 版
//
// 参数的"缺省":TS 里 `f(a)` 与 `f(a, undefined)` 在被调方看来一样,但测试按调用记参数——所以这里的方法都把缺省值写成显式参数,
// 由 handler 按 TS 调用处的样子填满(例:market.paBars 三个参数的调用处,C++ 传 force=false、indexProxy=false;JS 测试替身也补成五个)。
#pragma once

#include "analysis/anomaly.h"
#include "analysis/macro.h"
#include "analysis/ma_touch.h"
#include "analysis/performance.h"
#include "contract/config_types.h"
#include "domain/store.h"
#include "orchestrate/services/idea_semantic.h"
#include "orchestrate/services/market_data.h"
#include "orchestrate/services/pool.h"
#include "orchestrate/services/similar_context.h"
#include "orchestrate/services/trade_history.h"
#include "parsing/providers.h"
#include "util/ordered_json.h"
#include "util/task.h"

#include <QList>
#include <QString>
#include <QStringList>

#include <memory>
#include <optional>

namespace ibkr::rpc {

/// router 被这些 handler 用到的几面。每个方法同 BrokerRouter 的同名方法
class HandlerRouter {
public:
    virtual ~HandlerRouter() = default;
    /// router.sessions().length > 0
    virtual bool hasSessions() = 0;
    virtual util::Task<QList<util::OJson>> historicalBars(QString symbol, QString start, QString end) = 0;
    virtual util::Task<util::OJson> stockQuotes(QStringList symbols) = 0;
    virtual util::Task<util::OJson> streamQuotes(QStringList symbols) = 0;
    /// 盘口快照 BookSnapshot
    virtual util::Task<util::OJson> orderBook(QString symbol) = 0;
    /// `typeof router.comboBars === "function"`(IBKR 恒真;富途不移植,留着这一问是为了测试能演"没有这个方法"那一支)
    virtual bool hasComboBars() = 0;
    virtual util::Task<QList<util::OJson>> comboBars(QString symbol, util::OJson legs, QString day) = 0;
};

class PoolOps {
public:
    virtual ~PoolOps() = default;
    virtual void ensureMigrated() = 0;
    /// note 在 TS 里有缺省 "":调用处没传就是空串
    virtual util::OJson setWatch(const QString& symbol, const orchestrate::PoolWatchPatch& patch, const QString& note) = 0;
    virtual std::optional<QString> ensureInPool(const QString& symbol, const QString& company) = 0;
    virtual QStringList dropWatches(const QStringList& symbols) = 0;
};

class AlertsOps {
public:
    virtual ~AlertsOps() = default;
    virtual std::optional<QString> levelsStatusOf(const QString& symbol) = 0;
    virtual QString crossConfirm() = 0;
    virtual util::Task<QList<util::OJson>> listWatches() = 0;
    virtual analysis::ma_touch::Config touchConfig() = 0;
    virtual void touchConfigChanged() = 0;
    virtual util::Task<util::OJson> refresh(util::OJson params) = 0;
    virtual util::Task<util::OJson> poll() = 0;
};

class AnomalyOps {
public:
    virtual ~AnomalyOps() = default;
    virtual analysis::anomaly::Config config() = 0;
    virtual util::OJson monitor() = 0;
    /// {metrics, at, error};没有这只回空
    virtual std::optional<util::OJson> metricsOf(const QString& symbol) = 0;
    virtual void forget(const QString& symbol) = 0;
};

class EventsOps {
public:
    virtual ~EventsOps() = default;
    virtual util::Task<util::OJson> list(bool force) = 0;
    /// 口径不合规抛 analysis::econ_calendar::EventsConfigError
    virtual util::OJson setConfig(const util::OJson& config) = 0;
    /// 入参就是 EventsAddParams 那个对象(TS 原样递进去)
    virtual util::OJson add(const util::OJson& params) = 0;
    virtual bool remove(const QString& id) = 0;
};

class IntelOps {
public:
    virtual ~IntelOps() = default;
    virtual util::Task<util::OJson> feed(util::OJson params) = 0;
    virtual util::Task<util::OJson> dossier(util::OJson params) = 0;
};

class FollowOps {
public:
    virtual ~FollowOps() = default;
    virtual util::Task<util::OJson> status() = 0;
    /// 凭证库写不进去抛 util::KeychainError
    virtual util::Task<> setToken(QString token) = 0;
    virtual util::Task<> sync(bool restart) = 0;
};

class MarketOps {
public:
    virtual ~MarketOps() = default;
    virtual util::Task<util::OJson> wallFor(QString symbol, std::optional<QString> expiry, double width) = 0;
    /// spanDays 缺省 = MarketDataService::kHistSpanDays
    virtual util::Task<QList<util::OJson>> dailyHistory(QString symbol, double spanDays) = 0;
    virtual std::optional<double> dailyHistoryAskedAt(const QString& symbol) = 0;
    virtual util::Task<orchestrate::PaBars> paBars(QString symbol, QString timeframe, bool rth, bool force, bool indexProxy) = 0;
    /// macro.board 没连券商时 macroBoard 走公开源要的取数器。TS 里是 macro.ts 的 defaultFetcher(模块内默认值,handler 不碰);C++ 的 analysis 层不做网络 I/O,所以由引擎一侧给
    virtual analysis::macro::Fetcher macroFetcher() = 0;
};

class TradeHistoryOps {
public:
    virtual ~TradeHistoryOps() = default;
    virtual util::Task<orchestrate::TradeHistory> load(QStringList symbols) = 0;
    virtual util::Task<analysis::performance::Ledger> ledger() = 0;
};

class SimilarContextOps {
public:
    virtual ~SimilarContextOps() = default;
    virtual util::Task<std::optional<double>> spot(QString symbol) = 0;
    virtual util::Task<contract::OrderedMap<double>> flyEntryUnderlyings(QList<util::OJson> butterflies, QList<util::OJson> positions, QString symbol) = 0;
    virtual util::Task<orchestrate::SimilarContextService::StockRanges> stockRanges(QString symbol, QList<util::OJson> facts) = 0;
};

class StockTripsOps {
public:
    virtual ~StockTripsOps() = default;
    virtual util::Task<QList<util::OJson>> trips() = 0;
};

class FillSyncOps {
public:
    virtual ~FillSyncOps() = default;
    /// sync(nowMs, deep):handler 只调 sync(undefined, true)
    virtual util::Task<std::optional<double>> sync(std::optional<double> nowMs, bool deep) = 0;
    virtual bool available() = 0;
};

class IdeaSemanticOps {
public:
    virtual ~IdeaSemanticOps() = default;
    virtual util::Task<std::optional<orchestrate::RankMap>> rank(QString query, QList<util::OJson> pool, orchestrate::LlmJson llm) = 0;
};

class FlyPlannerOps {
public:
    virtual ~FlyPlannerOps() = default;
    virtual util::Task<util::OJson> planFor(util::OJson params) = 0;
    virtual util::Task<util::OJson> spotFor(QString symbol) = 0;
};

class IvRecorderOps {
public:
    virtual ~IvRecorderOps() = default;
    virtual util::OJson status() = 0;
    virtual util::OJson setEnabled(bool on) = 0;
};

class PlaybookOps {
public:
    virtual ~PlaybookOps() = default;
    virtual util::OJson snapshot() = 0;
    virtual util::OJson setEnabled(bool on) = 0;
};

/// handlers2 的十一个 handler 看到的"引擎一侧"。引擎装配的人实现它(ConcretePorts 是现成的实现),测试也实现一遍
class Handlers2Ports {
public:
    virtual ~Handlers2Ports() = default;
    /// this.engine.store(TS 里访问 engine 是懒建引擎的,所以是函数)
    virtual domain::TradeStore& store() = 0;
    /// 没连券商(router === null)是空;连过又全断了是有 router、hasSessions() 为假
    virtual std::shared_ptr<HandlerRouter> router() = 0;
    /// this.parserFactory(this.settings.llm)
    virtual std::shared_ptr<parsing::providers::Parser> parser(const contract::LLMConfig& llm) = 0;

    virtual PoolOps& pool() = 0;
    virtual AlertsOps& alerts() = 0;
    virtual AnomalyOps& anomaly() = 0;
    virtual EventsOps& events() = 0;
    virtual IntelOps& intel() = 0;
    virtual FollowOps& follow() = 0;
    virtual MarketOps& market() = 0;
    virtual TradeHistoryOps& tradeHistory() = 0;
    virtual SimilarContextOps& similarContext() = 0;
    virtual StockTripsOps& stockTrips() = 0;
    virtual FillSyncOps& fillSync() = 0;
    virtual IdeaSemanticOps& ideaSemantic() = 0;
    virtual FlyPlannerOps& flyPlanner() = 0;
    virtual IvRecorderOps& ivRecorder() = 0;
    virtual PlaybookOps& playbook() = 0;
};

}  // namespace ibkr::rpc
