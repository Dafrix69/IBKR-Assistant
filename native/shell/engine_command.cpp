#include "shell/engine_command.h"

#include <QDir>
#include <QFileInfo>
#include <QStandardPaths>

#include <utility>

namespace ibkr::shell {

QString findNode() {
    const QString fromEnv = qEnvironmentVariable("IBKR_NODE");
    if (!fromEnv.isEmpty() && QFileInfo(fromEnv).isExecutable()) return fromEnv;
    const QString onPath = QStandardPaths::findExecutable(QStringLiteral("node"));
    if (!onPath.isEmpty()) return onPath;
    return QStandardPaths::findExecutable(QStringLiteral("node"), {QStringLiteral("/opt/homebrew/bin"), QStringLiteral("/usr/local/bin")});
}

ResolvedEngine resolvePreviewEngine(const QString& repoDir, const QString& nodePath) {
    const QString script = QDir(repoDir).filePath(QStringLiteral("native/tools/preview/preview_engine.js"));
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

ResolvedEngine resolveNativeEngine(const QString& enginePath, const QString& configPath, const QString& promptDir, const QString& schemaDir) {
    if (!QFileInfo(enginePath).isExecutable()) return {std::nullopt, QStringLiteral("找不到 C++ 引擎 %1").arg(QDir::toNativeSeparators(enginePath))};
    EngineCommand cmd;
    cmd.program = enginePath;
    if (!configPath.isEmpty()) cmd.args = {QStringLiteral("--config"), configPath};
    const std::pair<const char*, QString> dirs[] = {{"DAFRI_PROMPT_DIR", promptDir}, {"DAFRI_SCHEMA_DIR", schemaDir}};
    for (const auto& [name, dir] : dirs)
        if (!dir.isEmpty() && !qEnvironmentVariableIsSet(name) && QFileInfo(dir).isDir()) cmd.env.insert(QString::fromLatin1(name), dir);
    // 本地收件读窗口的程序(打包时编进 .app,和引擎放在一起):有就告诉引擎,填了频道名时由引擎拉起
    const QString reader = QFileInfo(enginePath).absoluteDir().filePath(QStringLiteral("discord-window-follow"));
    if (!qEnvironmentVariableIsSet("DAFRI_INBOX_READER") && QFileInfo(reader).isExecutable()) cmd.env.insert(QStringLiteral("DAFRI_INBOX_READER"), reader);
    cmd.workingDir = QFileInfo(enginePath).absolutePath();
    cmd.label = QStringLiteral("ibkr-engine");
    return {cmd, {}};
}

}  // namespace ibkr::shell
