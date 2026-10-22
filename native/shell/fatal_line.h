// 引擎因为配置 / 交易库退出时,stderr 末尾会有一行给人看的话(engine-ts/src/cli.ts 的 rpc 入口打的):
//   [fatal:config:<missing|syntax|invalid>] 说明
//   [fatal:store:path] 库文件路径
//   [fatal:store:<newer|corrupt|locked|unwritable>] 说明
// 从退出时的 stderr 尾巴里把它认出来。同 desktop/config-guard.js 与 store-guard.js 的 fatalLine。
#pragma once

#include <QString>

#include <optional>

namespace ibkr::shell {

struct ConfigFatal {
    QString kind;
    QString message;
};

struct StoreFatal {
    QString kind;
    QString message;
    /// 没打 [fatal:store:path] 那一行时是空的
    std::optional<QString> dbPath;
};

/// 从后往前找第一行 [fatal:config:…]
std::optional<ConfigFatal> configFatalLine(const QString& detail);
/// 最后一行 [fatal:store:…] 为准,路径取 [fatal:store:path]
std::optional<StoreFatal> storeFatalLine(const QString& detail);

}  // namespace ibkr::shell
