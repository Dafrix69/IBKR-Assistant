// engine-ts/src/rpc/handlers/quality.ts 逐句搬:quality.*——优质股追踪的增删改与触发条件;监控循环本身在 services/anomaly。
#pragma once

#include "transport/context.h"
#include "transport/handlers/handlers2_ports.h"

namespace ibkr::rpc {

class QualityHandlers : public HandlerBase {
public:
    QualityHandlers(RpcContext& ctx, Handlers2Ports& ports) : HandlerBase(ctx), ports_(ports) {}
    MethodTable methods() override;

private:
    util::OJson qualityRowOut(const util::OJson& row);
    util::OJson qualityList();
    util::OJson qualityAdd(const util::OJson& params);
    util::OJson qualityUpdate(const util::OJson& params);
    util::OJson qualityRemove(const util::OJson& params);
    util::OJson qualitySetConfig(const util::OJson& params);

    Handlers2Ports& ports_;
};

}  // namespace ibkr::rpc
