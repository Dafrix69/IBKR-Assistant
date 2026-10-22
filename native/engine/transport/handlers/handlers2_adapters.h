// handlers2 簇的真实适配器:把 handlers2_ports.h 里的窄接口接到真的 service(orchestrate/services/*)与 BrokerRouter 上。
// 每个方法都是一行转发,不加任何行为(行为在 service 与 handler 里)。引擎装配的人造一个 ConcretePorts 交给 makeHandlers2。
// 测试里不用它(测试用 tests/h2_world.h 的脚本替身);它的签名由编译保证对得上 service。
#pragma once

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
#include "transport/handlers/handlers2_ports.h"

#include <functional>
#include <memory>

namespace ibkr::rpc {

/// 装配时递进来的东西:真的 service(引擎一侧各一份)与三个"每次现取"的函数(库、券商 router、解析器工厂——配置会重载、券商会重连、引擎会重建)
struct ConcreteServices {
    std::function<domain::TradeStore&()> store;
    /// 没连券商是空
    std::function<std::shared_ptr<execution::BrokerRouter>()> broker;
    /// buildParser + guardAccountIds
    std::function<std::shared_ptr<parsing::providers::Parser>(const contract::LLMConfig&)> parser;
    /// macro.board 没连券商时走公开源的取数器(TS 的 macro.ts defaultFetcher:真的联网);不给就用 events 的 fetcher(同一个类型,引擎装配时通常是同一个)
    analysis::macro::Fetcher macroFetcher;

    orchestrate::PoolService* pool = nullptr;
    orchestrate::AlertsService* alerts = nullptr;
    orchestrate::AnomalyService* anomaly = nullptr;
    orchestrate::EventsService* events = nullptr;
    orchestrate::IntelService* intel = nullptr;
    orchestrate::FollowService* follow = nullptr;
    orchestrate::MarketDataService* market = nullptr;
    orchestrate::TradeHistoryService* tradeHistory = nullptr;
    orchestrate::SimilarContextService* similarContext = nullptr;
    orchestrate::StockTripsService* stockTrips = nullptr;
    orchestrate::FillSyncService* fillSync = nullptr;
    orchestrate::IdeaSemanticService* ideaSemantic = nullptr;
    orchestrate::FlyPlannerService* flyPlanner = nullptr;
    orchestrate::IvRecorderService* ivRecorder = nullptr;
    orchestrate::PlaybookService* playbook = nullptr;
};

/// 全部指针都要给;ConcretePorts 不拥有它们
std::unique_ptr<Handlers2Ports> makeConcretePorts(ConcreteServices services);

}  // namespace ibkr::rpc
