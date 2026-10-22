// rpc/handlers/system.ts:system.status(状态条读的那份快照)与 system.selftest(提示词自检)。**普通模块**,只读。
// 阶段 0 的占位版(system.h 的 addSystemHandlers)留着给 main.cpp 的最小壳用;真引擎装配时用这个类。
#pragma once

#include "transport/context.h"
#include "transport/handlers/handler_ports.h"

namespace ibkr::rpc {

class SystemHandlers : public HandlerBase {
public:
    SystemHandlers(RpcContext& ctx, Handlers1Ports& ports) : HandlerBase(ctx), ports_(ports) {}

    MethodTable methods() override;

private:
    using OJson = util::OJson;

    OJson indexSpots();
    OJson systemStatus();
    OJson systemSelftest();

    Handlers1Ports& ports_;
};

}  // namespace ibkr::rpc
