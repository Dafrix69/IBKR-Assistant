// engine-ts/src/rpc/context.ts:各域 handler 看到的上下文,与它们共同的基类。
//
// handler 只认这个接口,不认识 RpcServer 的实现——server 引 handler,handler 再引 server 就是环。
// handler 之间也不互相 include:两个域都要的东西下沉到 orchestrate/(带状态)或 transport/params.h(纯函数)。
//
// 还没搬的 service(行情、价位提醒、异动、股票池……)与引擎、券商 router、解析器是不透明类型:搬它们的人在 RpcContext 里加各自的访问函数
// (TS 里是 `readonly market: MarketDataService` 这一串),并在 installMethods 之前把各域的 handler 建好。
#pragma once

#include "contract/settings.h"
#include "orchestrate/host.h"
#include "transport/rpc_server.h"
#include "util/ordered_json.h"
#include "util/task.h"

#include <QHash>
#include <QString>

#include <functional>
#include <memory>
#include <utility>
#include <vector>

namespace ibkr::rpc {

/// 追踪相关操作的共享锁(跨引擎实例同一把):每一轮盯盘、建 / 改 / 删追踪、立即平仓排成一队。
/// TS 的 trackerLock:`run = chain.then(fn, fn); chain = run.then(() => undefined, () => undefined)`——前一个不管成败,后一个都接着跑。
class SerialLock {
public:
    template <class T>
    util::Task<T> run(std::function<util::Task<T>()> fn) {
        const util::Task<void> previous = tail_;
        util::Deferred<void> mine;
        tail_ = mine.task();
        co_await previous;  // tail_ 里放的永远是"那一个跑完了"(成败都 resolve),不会抛
        std::exception_ptr failure;
        std::optional<T> value;
        try {
            value.emplace(co_await fn());
        } catch (...) {
            failure = std::current_exception();
        }
        mine.resolve();
        if (failure) std::rethrow_exception(failure);
        co_return std::move(*value);
    }

    /// 没有返回值的版本(Task<void> 不能放进 optional)
    util::Task<void> runVoid(std::function<util::Task<void>()> fn) {
        const util::Task<void> previous = tail_;
        util::Deferred<void> mine;
        tail_ = mine.task();
        co_await previous;
        std::exception_ptr failure;
        try {
            co_await fn();
        } catch (...) {
            failure = std::current_exception();
        }
        mine.resolve();
        if (failure) std::rethrow_exception(failure);
    }

private:
    util::Task<void> tail_ = util::Task<void>::resolved();
};

/// 解析器(TS 的 parserFactory 造出来的东西,providers.ts 的 buildParser,未搬)
class Parser;

/// 一个域交出来的方法表:"tracker.add" → 处理函数,按登记的先后。server 把各域的表合成一张(重复登记抛 JsError「RPC 方法重复登记:<名字>」)
using MethodTable = std::vector<std::pair<QString, RpcServer::AsyncHandler>>;
/// 同步的处理函数(多数 handler 是同步的):包成已完成 / 已失败的 Task
RpcServer::AsyncHandler syncHandler(RpcServer::OJsonHandler fn);

class RpcContext : public orchestrate::ServiceHost {
public:
    /// 配置重载 / 切券商时整份换掉
    virtual void setSettings(domain::Settings settings) = 0;
    /// 连接 / 断开时换掉;换完要 dropEngine,让引擎带上新的 router 重建
    virtual void setRouter(std::shared_ptr<orchestrate::Router> router) = 0;
    /// 已经建好的引擎;还没人用过就是空。只想看一眼心跳、不想因此把引擎建起来时用它
    virtual orchestrate::TradingEngine* engineBuilt() const = 0;
    /// 测试可注入的解析器工厂
    virtual std::shared_ptr<Parser> parserFactory(const contract::LLMConfig& cfg) = 0;
    /// 配置变了就整体重建:限额、别名表都会进提示词,必须一起换掉。连着券商时当场建好新引擎(节拍器不停摆)
    virtual void reload() = 0;
    /// 丢掉当前引擎(先停它的节拍器),下次用到时重建。旧引擎挂在会话上的回报监听转给以后的引擎,不会变聋
    virtual void dropEngine() = 0;
    /// 追踪相关操作的共享锁:每一轮盯盘、建 / 改 / 删追踪、立即平仓、熔断排成一队
    virtual SerialLock& trackerLock() = 0;
};

/// handler 的基类:把上下文里最常用的几样摊成 settings() / router() / engine(),
/// 从 rpc.ts 搬过来的方法体一个字不用改。要**换掉** settings / router 的地方显式写 ctx().setSettings(…)
class HandlerBase {
public:
    virtual ~HandlerBase() = default;
    virtual MethodTable methods() = 0;

protected:
    explicit HandlerBase(RpcContext& ctx) : ctx_(ctx) {}
    RpcContext& ctx() { return ctx_; }
    const domain::Settings& settings() const { return ctx_.settings(); }
    std::shared_ptr<orchestrate::Router> router() const { return ctx_.router(); }
    orchestrate::TradingEngine& engine() { return ctx_.engine(); }
    void emitEvent(const QString& event, const util::OJson& payload) { ctx_.emitEvent(event, payload); }
    std::shared_ptr<Parser> parserFactory(const contract::LLMConfig& cfg) { return ctx_.parserFactory(cfg); }
    QString gateway() const { return orchestrate::gatewayName(settings()); }
    util::RpcError needConnection(int code, const QString& what) const { return orchestrate::needConnection(settings(), code, what); }
    /// AccountView[](contract/settings.ts):别名、打码的账户号、是不是模拟、连接、这个账户的券商、是不是默认
    util::OJson accounts() const;

private:
    RpcContext& ctx_;
};

/// 把各域的方法表合成 server 的方法表(TS 构造函数里的那个循环)
void installMethods(RpcServer& server, const std::vector<HandlerBase*>& domains);

}  // namespace ibkr::rpc
