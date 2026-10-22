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

ResolvedEngine resolveNativeEngine(const QString& enginePath, const QString& configPath, const QString& repoDir) {
    if (!QFileInfo(enginePath).isExecutable()) return {std::nullopt, QStringLiteral("找不到 C++ 引擎 %1").arg(QDir::toNativeSeparators(enginePath))};
    EngineCommand cmd;
    cmd.program = enginePath;
    if (!configPath.isEmpty()) cmd.args = {QStringLiteral("--config"), configPath};
    if (!repoDir.isEmpty()) {
        const QDir repo(repoDir);
        const std::pair<const char*, QString> dirs[] = {{"DAFRI_PROMPT_DIR", repo.filePath(QStringLiteral("prompts"))},
                                                        {"DAFRI_SCHEMA_DIR", repo.filePath(QStringLiteral("native/spec/baseline/llm"))}};
        for (const auto& [name, dir] : dirs)
            if (!qEnvironmentVariableIsSet(name) && QFileInfo(dir).isDir()) cmd.env.insert(QString::fromLatin1(name), dir);
    }
    cmd.workingDir = QFileInfo(enginePath).absolutePath();
    cmd.label = QStringLiteral("ibkr-engine");
    return {cmd, {}};
}

}  // namespace ibkr::shell
