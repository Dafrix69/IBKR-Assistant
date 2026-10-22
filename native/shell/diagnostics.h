// 诊断包(desktop/diagnostics.js 逐条搬):用户遇到问题时,一键导出一份能直接发给支持的文本——版本与系统、引擎此刻的状态、
// 脱敏后的配置、备份清单、最近的日志,全部过脱敏。不放:交易记录、成交、持仓、想法原文、API Key、真实账号。
// 这里只把材料拼成文本(纯函数);材料由壳去取(app/support_service)。期望值由 node 跑原模块现算(tests/fixtures/gen_diagnostics.mjs)。
//
// 与原模块不同的一处:「复制诊断信息」的第二行,原来写 Electron 与 Node 的版本;Qt 版的材料里没有这两样,写 Qt 的版本。
#pragma once

#include "shell/ordered_json.h"

#include <QString>
#include <QTimeZone>
#include <QStringList>

#include <optional>

namespace ibkr::shell::diagnostics {

inline constexpr int kLogTailLines = 1500;
inline constexpr int kOldLogTailLines = 300;
inline constexpr int kMaxLineChars = 2000;

struct Tail {
    bool ok = false;
    int total = 0;
    QStringList lines;
    QString error;
};
/// 读一个文本文件的最后 n 行;文件不在、读不了返回说明那一句
Tail tailFile(const QString& file, int maxLines);

struct Engine {
    bool running = false;
    int restarts = 0;
    std::optional<OJson> status;
    std::optional<OJson> selftest;
    std::optional<OJson> backups;
    QStringList errors;
};

struct Input {
    OJson app;
    QString configPath;
    QString logPath;
    QString oldLogPath;  // 空 = 不带
    std::optional<Engine> engine;
    std::optional<OJson> extra;
    double now = 0;
    QString homedir;
};

QString buildReport(const Input& input);
/// 「复制诊断信息」用的那几行:不带日志,贴进聊天窗口不刷屏
QString buildSummary(const Input& input);
/// Datrix-诊断-YYYYMMDD-HHMMSS.txt(本机时区)
QString defaultFileName(double nowMs, const QTimeZone& zone = QTimeZone::systemTimeZone());

}  // namespace ibkr::shell::diagnostics
