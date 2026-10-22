// engine-ts/src/services/host.ts:services/ 的宿主接口。带状态的编排(行情缓存、价位提醒、异动循环、股票池)向外只要这四样。
//
// 配置会重载、券商会重连、引擎会重建——所以 service 手里拿的是宿主,每次用到都现取,不在构造时把 settings / router / engine
// 存成自己的字段(存了就是一份会过期的拷贝)。宿主由 transport/context 的 RpcContext 实现;这里不认识 RPC,离线测试可以塞一个假的进来。
//
// Router 就是 execution::BrokerRouter(富途不移植);TradingEngine 的定义在 orchestrate/engine.h(这里只前置声明,省得每个 service 都带上整个引擎)。
#pragma once

#include "domain/config.h"
#include "execution/broker.h"
#include "util/ordered_json.h"
#include "util/rpc_error.h"

#include <QString>

#include <memory>

namespace ibkr::orchestrate {

/// BrokerRouter | FutuRouter:富途不移植,只剩 BrokerRouter
using Router = execution::BrokerRouter;
class TradingEngine;  // engine.ts(orchestrate/engine.h)

/// 从 rpc.ts 搬家时带过来的松散记录类型(TS 的 Rec = Record<string, any>):OJson
using Rec = util::OJson;

class ServiceHost {
public:
    virtual ~ServiceHost() = default;
    virtual const domain::Settings& settings() const = 0;
    /// 没连券商是空;连过又全断了是"有 router、sessions() 为空"
    virtual std::shared_ptr<Router> router() const = 0;
    /// 懒建;库、通知器、熔断器都从它身上拿
    virtual TradingEngine& engine() = 0;
    /// 推一条事件给界面(JSON-RPC 通知)
    virtual void emitEvent(const QString& event, const util::OJson& payload) = 0;
};

/// GATEWAY_NAMES:生效券商 → (本机网关叫什么, 界面上哪个面板去连它);不认识的券商按 ibkr
QString gatewayName(const domain::Settings& settings);
QString panelName(const domain::Settings& settings);
/// 「<what>需要<网关>:请先在<面板>面板连接引擎。」
util::RpcError needConnection(const domain::Settings& settings, int code, const QString& what);

/// service 的基类:把宿主的四样摊成 settings() / router() / engine() / emitEvent()  (emit 是 Qt 的宏,TS 的 emit 在 C++ 里叫 emitEvent),从 rpc.ts 搬过来的方法体一个字不用改
class ServiceBase {
public:
    virtual ~ServiceBase() = default;

protected:
    explicit ServiceBase(ServiceHost& host) : host_(host) {}
    const domain::Settings& settings() const { return host_.settings(); }
    std::shared_ptr<Router> router() const { return host_.router(); }
    TradingEngine& engine() { return host_.engine(); }
    void emitEvent(const QString& event, const util::OJson& payload) { host_.emitEvent(event, payload); }
    util::RpcError needConnection(int code, const QString& what) const { return orchestrate::needConnection(settings(), code, what); }

    ServiceHost& host_;
};

}  // namespace ibkr::orchestrate
