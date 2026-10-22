// handlers1 簇(rpc/handlers/{tracker,trading,connection,settings,system}.ts)的"端口":这五个域的 handler 在 TS 里碰到的
// `this.engine` / `this.router` / `this.ctx.alerts` / `this.ctx.brokerLink`,在 C++ 里是下面这几个窄的抽象类。
//
// 为什么不加进 transport/context.h 的 RpcContext:那里的 Router / TradingEngine 是不透明类型(引擎还没搬完),RpcContext 再加纯虚函数会让
// 别人的实现类(tst_rpc_context 的 Fake)全红。所以 handler 的构造函数是 `XxxHandlers(RpcContext& ctx, Handlers1Ports& ports)`:
// settings / emitEvent / setSettings / reload / dropEngine / trackerLock / engineBuilt 走 ctx(TS 里同名),其余走 ports。
// 搬引擎、组装 RpcServer 的人实现 Handlers1Ports(以及它交出来的 EnginePort / Handlers1Router),测试(tests/handlers1_world.h)实现另一遍。
//
// 约定:TS 的 Rec 是 OJson(键序同 JS);指针为空 = undefined;引擎的方法抛什么,handler 就让它冒出去(BrokerError 由 handler 自己认)。
// 库与熔断开关是具体类(domain::TradeStore / util::KillSwitch):两边都用真的(临时目录),不隔接口。
#pragma once

#include "domain/config.h"
#include "domain/store.h"
#include "orchestrate/services/svc_runtime.h"
#include "orchestrate/spot_stop.h"
#include "orchestrate/tracker.h"
#include "parsing/prompts.h"
#include "util/killswitch.h"
#include "util/ordered_json.h"
#include "util/protections.h"
#include "util/task.h"

#include <QList>
#include <QSet>
#include <QString>
#include <QStringList>

#include <memory>
#include <optional>

namespace ibkr::rpc {

/// engine.pendingTriggers[i] 里 handler 读的那几格(pending.list / pending.poll)。值原样传出(类型不替 TS 改)
struct PendingTriggerView {
    util::OJson record_id;
    util::OJson intent_summary;  // p.approved.order.intent_summary
    util::OJson symbol;          // p.trigger.symbol
    util::OJson op;              // p.trigger.operator
    util::OJson value;           // p.trigger.value
    util::OJson account;         // p.approved.account.alias
    util::OJson created_at;
};

/// TradingEngine 被这五个域用到的全部面(engine.ts)。方法名与 TS 一一对应
class EnginePort {
public:
    virtual ~EnginePort() = default;

    // ---- 库 / 熔断 / 通知
    virtual domain::TradeStore& store() = 0;
    /// engine.killswitch(state / engage / release)
    virtual util::KillSwitch& killswitch() = 0;
    /// engine.notifier.warning(message)
    virtual void notifyWarning(const QString& message) = 0;

    // ---- 追踪(tracker.ts 域)
    /// engine.trackerLoop(引擎自己塞的上一轮结果:running / poll / hosted …),只读一眼
    virtual const util::OJson& trackerLoop() = 0;
    /// engine.trackerHeartbeat()
    virtual util::OJson trackerHeartbeat() = 0;
    /// engine.pollTrackers():就地盯一轮,{fired, blocked, …}
    virtual util::Task<util::OJson> pollTrackers() = 0;
    /// engine.syncHosted():{blocked: [{id, blockers}], …}
    virtual util::Task<util::OJson> syncHosted() = 0;
    /// engine.naturalCloseFor(raw, position, rows):此刻立刻能成交的价;拿不到是空。rows 是 {持仓 key: 行}
    virtual util::Task<std::optional<double>> naturalCloseFor(const util::OJson& raw, const orchestrate::tracker::Position& position,
                                                              const util::OJson& rows) = 0;
    /// engine.sessionEm.today(now)
    virtual std::optional<double> sessionEmToday(const domain::EtNow& now) = 0;
    /// engine.marketStatusFor(raw, at):盘中 / 盘外 / 休市
    virtual util::Task<QString> marketStatusFor(const util::OJson& raw, const domain::EtNow& at) = 0;
    virtual bool accountIsPaper(const QString& alias) = 0;
    /// engine.sweepExisting(track, reason):券商那边已经有这条追踪的单,改成追价
    virtual util::Task<bool> sweepExisting(const util::OJson& track, const QString& reason) = 0;
    virtual std::optional<QString> pendingCloseRecord(const util::OJson& track) = 0;
    /// engine.closePosition(track, position, auto, result, marketStatus):发出去了回 {id, symbol, state, reason}(fired),没发出去回空
    virtual util::Task<std::optional<util::OJson>> closePosition(const util::OJson& track, const orchestrate::tracker::Position& position,
                                                                 const util::OJson& autoClose, const util::OJson& result,
                                                                 const QString& marketStatus) = 0;

    // ---- 下单线(trading.ts 域)
    /// engine.handleInstruction(text, channel, null, null, accounts, dryRun)
    virtual util::Task<util::OJson> handleInstruction(const QString& text, const QString& channel, const QStringList& accounts, bool dryRun) = 0;
    virtual QList<PendingTriggerView> pendingTriggers() = 0;
    /// engine.syncBrokerOrders():同步了几笔(IBKR 恒 0)
    virtual util::Task<double> syncBrokerOrders() = 0;
    /// engine.firePending(prices):{标的: 价}
    virtual util::Task<QList<util::OJson>> firePending(const util::OJson& prices) = 0;
    /// engine.expirePending():清掉了几张
    virtual double expirePending() = 0;
    /// engine.halt(reason):{engaged, cancelled}
    virtual util::Task<util::OJson> halt(const QString& reason) = 0;

    // ---- system.*
    virtual const parsing::prompts::PromptBundle& bundle() = 0;
    /// engine.protectionState(nowMs)
    virtual util::ProtectionState protectionState(double nowMs) = 0;
};

/// router(BrokerRouter | FutuRouter)被这五个域用到的面。富途不移植:只有 IBKR 的实现。取标的现价沿用 orchestrate::SpotRouter
class Handlers1Router : public orchestrate::SpotRouter {
public:
    /// router.sessions().length
    virtual int sessionCount() = 0;
    /// router.positions():券商出错抛 execution::BrokerError
    virtual util::Task<QList<util::OJson>> positions() = 0;
    virtual QStringList connectedNames() = 0;
    /// router.upstreamOk
    virtual bool upstreamOk() = 0;
    /// typeof router.optionQuotes === "function"
    virtual bool hasOptionQuotes() const = 0;
    virtual util::Task<> disconnectAll() = 0;
};

/// ctx.alerts(services/alerts.ts)被追踪域用到的三个
class AlertsPort {
public:
    virtual ~AlertsPort() = default;
    virtual QStringList adoptTracked(const QStringList& symbols) = 0;
    virtual std::optional<QString> adoptForTrack(const QString& symbol) = 0;
    virtual QStringList releaseForTrack(const QSet<QString>& tracked) = 0;
};

/// ctx.brokerLink(services/brokerLink.ts)被连接域用到的三个
class BrokerLinkPort {
public:
    virtual ~BrokerLinkPort() = default;
    /// BrokerConnectResult 的 JSON({provider, connected, failed, listeners})
    virtual util::Task<util::OJson> connect(std::optional<QStringList> names) = 0;
    virtual util::Task<> disconnect() = 0;
    virtual void forget() = 0;
};

/// 这五个域的 handler 共同的宿主面。引擎懒建,所以 engine() 每次用到都现取(TS 的 `this.engine` getter)
class Handlers1Ports {
public:
    virtual ~Handlers1Ports() = default;
    /// this.engine:懒建
    virtual EnginePort& engine() = 0;
    /// ctx.engineBuilt:还没建过是空(system.status 只想看一眼心跳,不想因此把引擎建起来)
    virtual EnginePort* engineBuilt() = 0;
    /// this.router / ctx.router;没连券商是空
    virtual std::shared_ptr<Handlers1Router> router() = 0;
    /// ctx.router = null
    virtual void clearRouter() = 0;
    virtual AlertsPort& alerts() = 0;
    virtual BrokerLinkPort& brokerLink() = 0;
    /// engine.ts 的 resolveFanoutAccounts(settings, names)(模块级函数,不碰引擎,所以放在这里:账户名不合规时不该把引擎建起来):不合规抛 JsError(话原样)
    virtual QStringList resolveFanoutAccounts(const domain::Settings& settings, const QStringList& names) = 0;
    /// setTimeout / clearTimeout(breaker.halt 的 15 秒);测试换成虚拟钟
    virtual orchestrate::SvcRuntime& runtime() { return orchestrate::qtRuntime(); }
};

}  // namespace ibkr::rpc
