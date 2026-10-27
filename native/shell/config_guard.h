// 配置文件的体检与恢复(desktop/config-guard.js 逐条搬)。引擎读不进配置时用退出码 78(EXIT_CONFIG)说"是配置的问题",
// 壳停下重启、把话说清楚,并给一条回到上一份可用配置的路。备份是引擎每次从界面改配置之前留的 settings.json.bak。
// 恢复只在用户点了之后做;坏的那份改名留在旁边(.broken-时间戳),不删。写回去保持原来的键次序(shell/ordered_json)。
// 期望值由 node 跑原模块现算(tests/fixtures/gen_config_guard.mjs)。
#pragma once

#include "shell/ordered_json.h"

#include <QString>
#include <QStringList>
#include <QTimeZone>

#include <optional>

namespace ibkr::shell::config {

inline constexpr int kExitConfig = 78;

struct Inspection {
    bool exists = false;
    bool syntaxOk = false;
    QString syntaxError;           // 空 = 没问题
    bool backupUsable = false;
    std::optional<double> backupAt;  // 备份的修改时刻(毫秒)
    bool sameAsCurrent = false;
};
Inspection inspect(const QString& configPath);

struct Restored {
    QString brokenCopy;  // 空 = 原来没有文件
};
/// 用备份换回配置;没有可用的备份时返回空,error 里是给人看的那句
std::optional<Restored> restoreBackup(const QString& configPath, double nowMs, QString* error, const QTimeZone& zone = QTimeZone::systemTimeZone());

/// 改名用的时间戳:YYYYMMDD-HHMMSS(本机时区)
QString stamp(double epochMs, const QTimeZone& zone = QTimeZone::systemTimeZone());
/// 原子写(先写旁边再换名,权限 0600)
bool writeAtomic(const QString& target, const QByteArray& bytes);

}  // namespace ibkr::shell::config
