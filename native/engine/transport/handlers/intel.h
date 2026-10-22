// engine-ts/src/rpc/handlers/intel.ts 逐句搬:intel.*——信息链路的一条时间线与一份标的档案。只读:取价只走已经订着的行情,不发单、不建追踪。
#pragma once

#include "transport/context.h"
#include "transport/handlers/handlers2_ports.h"

namespace ibkr::rpc {

class IntelHandlers : public HandlerBase {
public:
    IntelHandlers(RpcContext& ctx, Handlers2Ports& ports) : HandlerBase(ctx), ports_(ports) {}
    MethodTable methods() override;

private:
    Handlers2Ports& ports_;
};

}  // namespace ibkr::rpc
