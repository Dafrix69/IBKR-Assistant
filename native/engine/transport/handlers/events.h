// engine-ts/src/rpc/handlers/events.ts 逐句搬:events.*——重要事件的清单、口径与自定义事件。只读行情日历、只写本地偏好,不发单。
#pragma once

#include "transport/context.h"
#include "transport/handlers/handlers2_ports.h"

namespace ibkr::rpc {

class EventsHandlers : public HandlerBase {
public:
    EventsHandlers(RpcContext& ctx, Handlers2Ports& ports) : HandlerBase(ctx), ports_(ports) {}
    MethodTable methods() override;

private:
    util::OJson setConfig(const util::OJson& params);
    util::OJson add(const util::OJson& params);
    util::OJson remove(const util::OJson& params);

    Handlers2Ports& ports_;
};

}  // namespace ibkr::rpc
