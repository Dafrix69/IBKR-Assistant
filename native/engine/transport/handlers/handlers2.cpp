#include "transport/handlers/handlers2.h"

#include "transport/handlers/alerts.h"
#include "transport/handlers/backtest.h"
#include "transport/handlers/events.h"
#include "transport/handlers/follow.h"
#include "transport/handlers/ideas.h"
#include "transport/handlers/intel.h"
#include "transport/handlers/market.h"
#include "transport/handlers/quality.h"
#include "transport/handlers/review.h"
#include "transport/handlers/screener.h"
#include "transport/handlers/sectors.h"

namespace ibkr::rpc {

std::vector<std::unique_ptr<HandlerBase>> makeHandlers2(RpcContext& ctx, Handlers2Ports& ports) {
    std::vector<std::unique_ptr<HandlerBase>> out;
    out.push_back(std::make_unique<IdeasHandlers>(ctx, ports));
    out.push_back(std::make_unique<SectorsHandlers>(ctx, ports));
    out.push_back(std::make_unique<ScreenerHandlers>(ctx, ports));
    out.push_back(std::make_unique<BacktestHandlers>(ctx, ports));
    out.push_back(std::make_unique<MarketHandlers>(ctx, ports));
    out.push_back(std::make_unique<AlertsHandlers>(ctx, ports));
    out.push_back(std::make_unique<QualityHandlers>(ctx, ports));
    out.push_back(std::make_unique<ReviewHandlers>(ctx, ports));
    out.push_back(std::make_unique<FollowHandlers>(ctx, ports));
    out.push_back(std::make_unique<EventsHandlers>(ctx, ports));
    out.push_back(std::make_unique<IntelHandlers>(ctx, ports));
    return out;
}

}  // namespace ibkr::rpc
