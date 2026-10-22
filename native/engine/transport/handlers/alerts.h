// engine-ts/src/rpc/handlers/alerts.ts 逐句搬:alerts.*——价位提醒的增删查与碰均线的设置;重算与轮询转给 services/alerts。
#pragma once

#include "transport/context.h"
#include "transport/handlers/handlers2_ports.h"

namespace ibkr::rpc {

class AlertsHandlers : public HandlerBase {
public:
    AlertsHandlers(RpcContext& ctx, Handlers2Ports& ports) : HandlerBase(ctx), ports_(ports) {}
    MethodTable methods() override;

private:
    util::Task<util::OJson> alertsList();
    util::OJson alertsCreate(const util::OJson& params);
    util::OJson alertsDelete(const util::OJson& params);
    util::OJson alertsSetTouchConfig(const util::OJson& params);

    Handlers2Ports& ports_;
};

}  // namespace ibkr::rpc
