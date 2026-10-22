// services/ 第二批(svc2 簇)的宿主缝。TS 的 service 只认 ServiceHost 的四样(settings / router / engine / emit)——orchestrate/host.h 把它们搬过来了,
// 但 Router(BrokerRouter | FutuRouter)与 TradingEngine 在那里是不透明类型(引擎还没搬)。这里在不动 host.h 的前提下把 service 真正要用的那几面
// 定成窄接口,搬引擎的人照着实现:
//
//   SvcHost      = ServiceHost + 下面三样(宿主的实现类同时实现它;TS 的 rpc/server.ts)
//     broker()       具体的 execution::BrokerRouter(brokerLink 要 new / 挂 linkHook,fillSync 要 executions / 各会话的 executionHistory)
//     routerPort()   其余 service 对 router 的窄面(RouterPort);缺省把 broker() 套一层 BrokerRouterPort
//     svcEngine()    TradingEngine 的窄面(SvcEngine):库、通知、对账、挂监听
//     runtime()      时间与计时器(svc_runtime.h);缺省 QTimer
//   不是 SvcHost 的方法就不要 service 去碰:service 每次用到都现取,不存 settings / router / engine(配置会重载、券商会重连、引擎会重建)。
//
// TS → C++ 的对应:
//   · Router 的并集(BrokerRouter | FutuRouter)收成 BrokerRouter:富途 2026-10-20 决定不移植。TS 里 `typeof router.x === "function"` 判富途有没有某方法的分支不搬
//     (BrokerRouter 都有),`router instanceof BrokerRouter`(similarContext)恒真。
//   · `this.engine.store` → svcEngine().store()(domain::TradeStore,具体类:库在 domain 层已经搬完,不再套接口);
//     `this.engine.notifier` → svcEngine().notifier()(NotifierPort:notify / warning 两样,引擎端用 util::Notifier 实现)。
//   · TS 里访问 `this.engine` 有副作用(懒建引擎)。brokerLink 里「先碰一下 engine 把它建起来」是可观察的一步,C++ 在同样的位置调 svcEngine()。
#pragma once

#include "domain/store.h"
#include "execution/broker.h"
#include "execution/ib_bars.h"
#include "orchestrate/host.h"
#include "orchestrate/services/svc_runtime.h"
#include "util/ordered_json.h"
#include "util/task.h"

#include <QList>
#include <QString>
#include <QStringList>

#include <memory>
#include <optional>

namespace ibkr::orchestrate {

/// engine.notifier 的两样(util::Notifier 的 notify / warning)
class NotifierPort {
public:
    virtual ~NotifierPort() = default;
    /// subtitle 空 = 没给(TS 少传一个参数)
    virtual void notify(const QString& title, const QString& body, const QString& subtitle = {}) = 0;
    virtual void warning(const QString& message) = 0;
};

/// TradingEngine 被 svc2 的 service 用到的那几面
class SvcEngine {
public:
    virtual ~SvcEngine() = default;
    virtual domain::TradeStore& store() = 0;
    virtual NotifierPort& notifier() = 0;
    /// engine.reconcileSoon():断线期间单子可能成交或被撤了,下一轮就对账
    virtual void reconcileSoon() = 0;
    /// engine.attachListeners():给引擎挂上券商事件监听,回挂了几个
    virtual int attachListeners() = 0;
};

/// router 被 svc2 的 service 用到的那几面(除了 brokerLink / fillSync,它们直接用 BrokerRouter)。
/// 每个方法同 BrokerRouter 的同名方法;BrokerRouterPort 是转发,不加任何行为
class RouterPort {
public:
    virtual ~RouterPort() = default;
    /// router.sessions().length > 0
    virtual bool hasSessions() = 0;
    virtual util::Task<QList<util::OJson>> positions() = 0;
    virtual util::Task<util::OJson> streamQuotes(QStringList symbols) = 0;
    virtual util::Task<util::OJson> stockQuotes(QStringList symbols) = 0;
    virtual util::Task<std::optional<double>> indexPrice(QString symbol) = 0;
    virtual std::optional<util::OJson> spotInfo(const QString& symbol) = 0;
    virtual bool upstreamOk() = 0;
    /// 抛 BrokerError(没有连着的会话)
    virtual std::shared_ptr<execution::IbSession> marketSession() = 0;
    virtual util::Task<util::OJson> optionChain(QString symbol, std::optional<QString> expiry, double width, std::optional<double> span, QString preferClass) = 0;
    virtual util::Task<QList<util::OJson>> historicalBars(QString symbol, QString start, QString end) = 0;
    virtual util::Task<execution::TaggedBars> intradayBars(QString symbol, QString timeframe, bool rth, std::optional<QString> endDay, bool indexProxy) = 0;
};

/// BrokerRouter → RouterPort
std::shared_ptr<RouterPort> adaptBrokerRouter(std::shared_ptr<execution::BrokerRouter> router);

class SvcHost : public ServiceHost {
public:
    /// 没连券商是空
    virtual std::shared_ptr<execution::BrokerRouter> broker() const = 0;
    virtual std::shared_ptr<RouterPort> routerPort() const { return adaptBrokerRouter(broker()); }
    virtual SvcEngine& svcEngine() = 0;
    virtual SvcRuntime& runtime() { return qtRuntime(); }
};

/// brokerLink 要的宿主那一面:比 SvcHost 多两样——能换 router、能丢引擎
class BrokerLinkHost : public SvcHost {
public:
    virtual void setBroker(std::shared_ptr<execution::BrokerRouter> router) = 0;
    virtual void dropEngine() = 0;
};

/// svc2 各 service 的基类:ServiceBase 的 settings() / emitEvent() 照旧,再摊出 svcEngine() / store() / routerPort() / runtime()
class SvcBase : public ServiceBase {
protected:
    explicit SvcBase(SvcHost& host) : ServiceBase(host), sh_(host) {}
    SvcHost& sh_;
    SvcEngine& eng() { return sh_.svcEngine(); }
    domain::TradeStore& store() { return sh_.svcEngine().store(); }
    std::shared_ptr<RouterPort> routerPort() const { return sh_.routerPort(); }
    SvcRuntime& rt() { return sh_.runtime(); }
};

}  // namespace ibkr::orchestrate
