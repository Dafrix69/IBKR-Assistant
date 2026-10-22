#include "shell/engine_command.h"

#include <QDir>
#include <QFileInfo>
#include <QStandardPaths>

namespace ibkr::shell {

QString findNode() {
    const QString fromEnv = qEnvironmentVariable("IBKR_NODE");
    if (!fromEnv.isEmpty() && QFileInfo(fromEnv).isExecutable()) return fromEnv;
    const QString onPath = QStandardPaths::findExecutable(QStringLiteral("node"));
    if (!onPath.isEmpty()) return onPath;
    return QStandardPaths::findExecutable(QStringLiteral("node"), {QStringLiteral("/opt/homebrew/bin"), QStringLiteral("/usr/local/bin")});
}

ResolvedEngine resolveTsEngine(const TsEngineOptions& options) {
    if (options.tsEngineRoot.isEmpty()) return {std::nullopt, QStringLiteral("没有配置引擎目录(tsEngineRoot)")};
    const QString entry = QDir(options.tsEngineRoot).filePath(QStringLiteral("dist/src/cli.js"));
    if (!QFileInfo::exists(entry)) {
        return {std::nullopt, QStringLiteral("找不到引擎入口 %1。开发时在 engine-ts 下执行 npm install && npm run build;打包版请重新安装。")
                                  .arg(QDir::toNativeSeparators(entry))};
    }
    const QString node = options.nodePath.isEmpty() ? findNode() : options.nodePath;
    if (node.isEmpty()) {
        return {std::nullopt, QStringLiteral("找不到 node:Qt 版现在还用系统的 Node 跑 TS 引擎(brew install node),"
                                             "或者用环境变量 IBKR_NODE 指到它")};
    }
    EngineCommand cmd;
    cmd.program = node;
    cmd.args = {entry, QStringLiteral("rpc"), QStringLiteral("--config"), options.configPath};
    // 同 rpc-client.js:开发时 cwd 放引擎根(引擎自身不依赖 cwd;打包版要挪出安装目录,打包时再定)
    cmd.workingDir = options.tsEngineRoot;
    cmd.label = QStringLiteral("node");
    return {cmd, {}};
}

ResolvedEngine resolvePreviewEngine(const QString& repoDir, const QString& nodePath) {
    const QString script = QDir(repoDir).filePath(QStringLiteral("desktop/tools/preview_engine.js"));
    if (!QFileInfo::exists(script)) return {std::nullopt, QStringLiteral("找不到预览引擎 %1").arg(QDir::toNativeSeparators(script))};
    const QString node = nodePath.isEmpty() ? findNode() : nodePath;
    if (node.isEmpty()) return {std::nullopt, QStringLiteral("找不到 node:预览引擎要用它(brew install node,或设环境变量 IBKR_NODE)")};
    EngineCommand cmd;
    cmd.program = node;
    cmd.args = {script};
    cmd.workingDir = QFileInfo(script).absolutePath();
    cmd.label = QStringLiteral("preview");
    return {cmd, {}};
}

ResolvedEngine resolveNativeEngine(const QString& enginePath, const QString& configPath) {
    if (!QFileInfo(enginePath).isExecutable()) return {std::nullopt, QStringLiteral("找不到 C++ 引擎 %1").arg(QDir::toNativeSeparators(enginePath))};
    EngineCommand cmd;
    cmd.program = enginePath;
    if (!configPath.isEmpty()) cmd.args = {QStringLiteral("--config"), configPath};
    cmd.workingDir = QFileInfo(enginePath).absolutePath();
    cmd.label = QStringLiteral("ibkr-engine");
    return {cmd, {}};
}

}  // namespace ibkr::shell
