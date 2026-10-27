// 引擎怎么拉起:哪个程序、什么参数、在哪个目录。
//
// 应用拉的是 C++ 的 ibkr-engine(参数只有 --config);预览拉 node 跑的预览引擎;测试拉的是假引擎。
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

/// C++ 引擎:ibkr-engine --config <配置>。提示词目录与大模型输出的 schema 目录用 DAFRI_PROMPT_DIR / DAFRI_SCHEMA_DIR 指给它:
/// 开发时是仓库里的 prompts/ 与 native/spec/baseline/llm(编译目录在仓库外时引擎从自己往上找不到),打包后是 .app 的 Resources。
/// 目录不存在的、环境里已经设了的不覆盖
ResolvedEngine resolveNativeEngine(const QString& enginePath, const QString& configPath, const QString& promptDir = {}, const QString& schemaDir = {});

/// 预览引擎:node native/tools/preview/preview_engine.js,答的是预览台 mock 里的假数据,没有任何出路到券商。只在明说 --engine preview 时用
ResolvedEngine resolvePreviewEngine(const QString& repoDir, const QString& nodePath = {});

/// 找 node:IBKR_NODE → PATH → Homebrew 的两个位置(从程序坞启动的应用拿不到 shell 的 PATH)
QString findNode();

}  // namespace ibkr::shell
