// engine-ts/src/rpc/server.ts 的"生命周期"与"装配"两件事(传输在 rpc_server.h):读配置、券商 router、引擎的懒建 / 丢 / 重建(回报账的交接)、
// 把 services/ 与各域 handler 接起来合成方法表、serve() 起停各个 service、main() 里那四个 .start()。业务不写在这里。
//
// 与 TS 的对应与不同:
//   · TS 的 RpcServer 一个类同时是 RpcContext、Svc1Host、SvcHost、BrokerLinkHost;C++ 这几个接口都从 ServiceHost 继承,一个类接不全,所以
//     EngineServer 里有三个小的宿主适配类(RpcContext / Svc1Host / BrokerLinkHost),状态都在 EngineServer::Impl 里。
//   · 被换下来的引擎一个都不放手(TS 里会话监听闭包按名字调旧实例,旧实例靠闭包活着;C++ 的闭包只拿存活标志)。
//   · 测试模式(环境变量 IBKR_ENGINE_FAKE_LLM 有值,只有 tst_golden_rpc 设):假解析器(golden-rpc.spec.ts 的 FakeParser)、
//     引擎的系统通知关掉、不起任何后台 service(TS 的契约回放不经 serve() / main(),同样一个都没起)。IBKR_ENGINE_CLOCK(ISO 时刻)换掉时钟。
//   · 没有搬:cli.ts 的 parse / run / buildRouter 三个命令(见交付报告)。
#pragma once

#include "domain/config.h"
#include "transport/rpc_server.h"

#include <QString>

#include <memory>
#include <optional>

namespace ibkr::rpc {

class EngineServer {
public:
    /// 配置已经读好(cli::startupChecks 的结果)。server 要活得比它长
    EngineServer(RpcServer& server, domain::Settings settings, std::optional<QString> settingsPath);
    ~EngineServer();
    EngineServer(const EngineServer&) = delete;
    EngineServer& operator=(const EngineServer&) = delete;

    /// 建 service、建各域 handler、合成方法表、接上 server.hooks(onServe / onShutdown / perfExtra)。要在 server.begin() 之前
    void install();
    /// main() 里 serve() 之后那四个 .start():brokerLink / follow / fillSync / assignmentWatch(测试模式不起)
    void startBackground();

    bool testMode() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace ibkr::rpc
