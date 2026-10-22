// rpc/handlers/connection.ts:broker.* / tws.* / futu.*——券商接入的选择、连接,与本机网关的探测。**普通模块**(连接 / 切换券商不碰下单授权)。
//
// 富途 2026-10-20 决定不移植:futu.scan / diagnose / launch 要的 futu.ts 没有 C++ 版,回 -32601「富途接入不在这个版本里」;
// futu.set_password(只写凭证库)与 futu.unlock 的前两道检查照搬(没有富途 router,所以过了「当前接入是富途」之后恒是 -32004)。
// TS 里 `provider in BROKER_LABELS` / `n in settings.connections` 是对普通对象的 in,"constructor"、"toString" 这类原型键也算"在";C++ 里没有原型,不照搬。
#pragma once

#include "transport/context.h"
#include "transport/handlers/handler_ports.h"

namespace ibkr::rpc {

/// 给用户照抄的那段配置。账号那一行留成占位符
QString configSnippet(const QString& provider);

class ConnectionHandlers : public HandlerBase {
public:
    ConnectionHandlers(RpcContext& ctx, Handlers1Ports& ports) : HandlerBase(ctx), ports_(ports) {}

    MethodTable methods() override;

private:
    using OJson = util::OJson;
    template <class T = void>
    using Task = util::Task<T>;

    Task<OJson> brokerCatalog();
    Task<OJson> brokerSelect(OJson params);
    Task<OJson> brokerConnect(OJson params);
    Task<OJson> brokerDisconnect();
    Task<OJson> twsScan();
    Task<OJson> twsDiagnose(OJson params);
    OJson twsLaunch(const OJson& params);
    Task<OJson> futuSetPassword(OJson params);
    OJson futuUnlock(const OJson& params);

    Handlers1Ports& ports_;
};

}  // namespace ibkr::rpc
