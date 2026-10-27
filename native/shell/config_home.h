// 配置放在哪:userData 目录里的 settings.json(macOS 上是 ~/Library/Application Support/Datrix/settings.json),
// 开发版与打包版同一份;--config 与 DAFRI_CONFIG 照旧优先。
// 第一次用到时那里还没有:按次序拷第一个找得到的来源——仓库里的 config/settings.json(开发时一直用的那份)、
// 改名前的 userData 目录里的(IBKR-Assistant、Dafri Trading,另一台机器上没有仓库时靠它)、示例配置。
// 拷过来的就是原文,一个字不改;交易库的路径在配置里写的是绝对路径,挪了配置文件不影响。旧的那几份原样留着,不删。
#pragma once

#include <QString>
#include <QStringList>

namespace ibkr::shell::config_home {

/// <dir>/settings.json
QString configPath(const QString& userDataDir);

/// 迁移的来源,按次序:仓库那份(repoDir 空 = 没有仓库)、改名前的几个目录里的、示例
QStringList migrationSources(const QString& repoDir, const QStringList& legacyDirs, const QString& example);

struct Migration {
    QString from;   // 拷了哪一份;空 = 目标已经有了,或一个来源都没有
    QString error;  // 拷不过去时给人看的那句
    bool fromExample() const;
};
/// 目标不存在时拷第一个存在的来源(目录建好、权限 0600);目标已经有了什么也不做
Migration migrate(const QString& target, const QStringList& sources);

/// 界面的偏好(qt-settings.ini:各页记住的选项):新目录没有、旧目录有就带过来。返回带没带
bool carryPrefs(const QStringList& legacyDirs, const QString& toDir);

}  // namespace ibkr::shell::config_home
