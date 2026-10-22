// handlers2 簇:十一个域的 handler(ideas / review / sectors / quality / events / intel / alerts / backtest / follow / market / screener)。
// 引擎装配的人用 makeHandlers2 造出它们,再和别的域的 handler 一起交给 installMethods(transport/context.h)。
#pragma once

#include "transport/context.h"
#include "transport/handlers/handlers2_ports.h"

#include <memory>
#include <vector>

namespace ibkr::rpc {

/// 次序同 server.ts 的 domains(去掉别人的 system / trading / tracker / connection / settings):ideas sectors screener backtest market alerts quality review follow events intel
std::vector<std::unique_ptr<HandlerBase>> makeHandlers2(RpcContext& ctx, Handlers2Ports& ports);

}  // namespace ibkr::rpc
