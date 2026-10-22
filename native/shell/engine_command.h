// 引擎怎么拉起:哪个程序、什么参数、在哪个目录。
//
// 阶段 1 的 Qt 界面拉的是现在的 TS 引擎(node engine-ts/dist/src/cli.js rpc --config <配置>),同 desktop/rpc-client.js;
// 阶段 3 换成 C++ 的 ibkr-engine(参数只有 --config)。测试拉的是假引擎。
#pragma once

#include <QHash>
#include <QString>
#include <QStringList>

#include <functional>
#include <optional>

namespace ibkr::shell {

struct EngineCommand {
    QString program;
    QStringList args;
    /// 在当前环境之上多设的几项
    QHash<QString, QString> env;
    QString workingDir;
    /// 日志里说用的是哪一种(node / ibkr-engine / 测试的假引擎)
    QString label;
};

/// 解析成功给命令,失败给一句人话(会作为"引擎没起来"的原因显示出来)
struct ResolvedEngine {
    std::optional<EngineCommand> command;
    QString error;
};

using EngineResolver = std::function<ResolvedEngine()>;

struct TsEngineOptions {
    /// engine-ts 的根(含 dist/src/cli.js)
    QString tsEngineRoot;
    QString configPath;
    /// 不给就按 IBKR_NODE 环境变量 → PATH → /opt/homebrew/bin、/usr/local/bin 找
    QString nodePath;
};

/// 同 rpc-client.js 的 #resolveEngine:入口不在就直接报错,说清楚该做什么。
/// Qt 版没有 Electron 自带的 Node 可借(ELECTRON_RUN_AS_NODE),开发时用系统的 node;打包怎么带 Node 是阶段 1 结束时再定的事
ResolvedEngine resolveTsEngine(const TsEngineOptions& options);

/// C++ 引擎:ibkr-engine --config <配置>
ResolvedEngine resolveNativeEngine(const QString& enginePath, const QString& configPath);

/// 预览引擎:node desktop/tools/preview_engine.js,答的是预览台 mock 里的假数据,没有任何出路到券商。只在明说 --engine preview 时用
ResolvedEngine resolvePreviewEngine(const QString& repoDir, const QString& nodePath = {});

/// 找 node:IBKR_NODE → PATH → Homebrew 的两个位置(从程序坞启动的应用拿不到 shell 的 PATH)
QString findNode();

}  // namespace ibkr::shell
