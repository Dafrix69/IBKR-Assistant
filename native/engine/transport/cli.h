// engine-ts/src/cli.ts:命令行入口(对应 Python cli.py)。默认全部"只解析不下单",真正发单必须显式打开开关。
//
//   cli selftest                       # 不联网:渲染提示词 + 自检
//   cli validate fixture.json          # 不联网:现成 JSON 过硬校验
//   cli records / idea / ideas / halt / resume / export / set-key / rpc
//   cli import-fills fills.csv --account 别名 [--dry-run]   # 补历史成交(只收股票)
//   cli import-option-trades trades.csv --account 别名 [--dry-run]
//   cli import-option-positions option_positions.csv --account 别名 [--dry-run]
//
// 搬了什么、没搬什么:
//   · 搬了:--config 的拆法、selftest、validate、records、idea、ideas、halt、resume、export、三个 import-*、set-key、用法提示、
//     rpc 那一支的错误映射(配置读不进来 → [fatal:config:<kind>],库打不开 → [fatal:store:path] 与 [fatal:store:<kind>],退出码 78 / 74),
//     以及 server.ts 的 main() 在 serve() 之前做的两件事(读配置、把交易库开一遍:startupChecks);
//   · 没搬:`parse` 与 `run`(要 TradingEngine 与 BrokerRouter;现在回一句说明、退出码 1)、`buildRouter`(要两个 router);
//     `rpc` 的函数体由调用方递进来(RpcEntry):serve() 之后的 service 起停还没搬,ibkr-engine 的 main.cpp 现在递的是阶段 0 的那个服务。
//
// 和 TS 的出入:
//   · console.log / console.error 经 Io(一行一调用,不含换行);process.exit(1)(行情快照写错了)是抛 ExitRequest,由 main() 接成返回码;
//   · TS 里 main() 抛的错(配置读不进来的非 rpc 命令……)由入口那一层打 `String(exc.stack ?? exc)` 退出码 1;C++ 这边 runMain() 打 `Error: <话>`(没有调用栈)退出码 1;
//   · 少给了必需的参数时(`cli validate` 不带文件、`cli idea` 不带文字),TS 在 `args[0]!` 上抛 Node 的 TypeError;这里抛一句说明这个情形的 JsError(话不同,同样是失败)。
#pragma once

#include "domain/config.h"
#include "orchestrate/engine_router.h"

#include <QString>
#include <QStringList>

#include <exception>
#include <functional>
#include <optional>

namespace ibkr::cli {

/// console.log / console.error:一行一次调用(不含换行)
struct Io {
    std::function<void(const QString& line)> log;
    std::function<void(const QString& line)> error;
};
/// 真的 stdout / stderr
Io stdIo();

struct Hooks {
    /// keychain.ts 的 setSecret;缺省是真的凭证库(会弹系统对话框)——测试里换成假的
    std::function<void(const QString& service, const QString& account, const QString& secret)> setSecret;
    /// `parse` 用的大模型解析器;缺省 buildParser(settings.llm)(真的联网)——测试里换成假的
    std::function<std::shared_ptr<orchestrate::EngineParser>(const domain::Settings&)> parser;
};

/// process.exit(code)
class ExitRequest : public std::exception {
public:
    explicit ExitRequest(int code) : code_(code) {}
    int code() const { return code_; }

private:
    int code_;
};

/// rpc 子命令的函数体(server.ts 的 main(settingsPath)):读配置、开库、起服务、跑到 stdin 关;返回退出码。配置读不进来 / 库打不开时抛
using RpcEntry = std::function<int(const std::optional<QString>& configPath)>;

/// (跑完会 rpc::markStartupChecked();开了 RpcServer::requireStartupChecks() 的 server 要它跑过才肯登记真的方法)
/// server.ts 的 main() 在 serve() 之前做的两件事:读配置(ConfigLoadError)、先把交易库按 safety 开一遍再关(StoreOpenError)——
/// 打不开就在这里当场说清楚并退出;库是懒建的,不先开这一遍引擎会"正常启动",然后每个请求都回一句 SqliteError
domain::Settings startupChecks(const std::optional<QString>& configPath);

/// cli.ts 的 main(argv)(argv 不含程序名)。TS 抛的错这里也抛(JsError…);ExitRequest 接成返回码
int main(const QStringList& argv, const Io& io, const RpcEntry& rpc, const Hooks& hooks = {});
/// 入口那一层:main() 抛了就打 `Error: <话>` 退出码 1
int runMain(const QStringList& argv, const Io& io, const RpcEntry& rpc, const Hooks& hooks = {});

}  // namespace ibkr::cli
