// engine-ts/src/rpc/handlers/follow.ts 逐句搬:follow.*——Discord 跟单的状态、bot token、重新连接。
// 跟单的配置是 settings 的 `follow` 段,读写走 settings.get / settings.patch;这里只有不属于配置文件的那几样。
// follow.set_token 写系统凭证库:入参 schema 是 strict 的,并登记在 SENSITIVE_METHODS 里。
#pragma once

#include "transport/context.h"
#include "transport/handlers/handlers2_ports.h"

namespace ibkr::rpc {

class FollowHandlers : public HandlerBase {
public:
    FollowHandlers(RpcContext& ctx, Handlers2Ports& ports) : HandlerBase(ctx), ports_(ports) {}
    MethodTable methods() override;

private:
    util::Task<util::OJson> setToken(util::OJson params);
    util::Task<util::OJson> reconnect();

    Handlers2Ports& ports_;
};

}  // namespace ibkr::rpc
