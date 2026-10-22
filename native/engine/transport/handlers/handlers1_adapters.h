// handlers1 簇(handler_ports.h)的端口 ← 真的实现:TradingEngine → EnginePort、BrokerRouter → Handlers1Router、AlertsService → AlertsPort、
// BrokerLinkService → BrokerLinkPort。纯转发(外加 EngineResult / BrokerConnectResult 变 JSON),没有逻辑。装配(RpcServer 的接线)的人拿它们去实现 Handlers1Ports。
// 生命周期:适配类按引用持有被适配的对象,被适配的对象要活得比适配类和所有未完成的调用长(引擎重建时重建 EnginePort,不要存旧的)。
#pragma once

#include "transport/handlers/handler_ports.h"

#include <memory>

namespace ibkr::execution {
class BrokerRouter;
}
namespace ibkr::orchestrate {
class TradingEngine;
class AlertsService;
class BrokerLinkService;
}  // namespace ibkr::orchestrate

namespace ibkr::rpc {

std::unique_ptr<EnginePort> makeEnginePort(orchestrate::TradingEngine& engine);
/// router 活得比返回的适配类长(shared_ptr 持着)
std::shared_ptr<Handlers1Router> makeHandlers1Router(std::shared_ptr<execution::BrokerRouter> router);
std::unique_ptr<AlertsPort> makeAlertsPort(orchestrate::AlertsService& alerts);
std::unique_ptr<BrokerLinkPort> makeBrokerLinkPort(orchestrate::BrokerLinkService& link);

}  // namespace ibkr::rpc
