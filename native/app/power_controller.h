// 电源与合盖的动手那一半(main.js 的 watchPower / observePower / driveLidGuard / applyLidAction / setLidGuardEnabled / restoreLidSleep):
// 判断在 shell/power_guard;这里接系统的电源事件、每次心跳读 `pmset -g`、弹授权框改 disablesleep、记日志、发通知、落盘 lid-guard.json。
// 合盖那一半只在 macOS。
#pragma once

#include "shell/power_guard.h"

#include <QJsonObject>
#include <QObject>
#include <QProcess>
#include <QString>

#include <functional>

namespace ibkr::shell {
class Alerter;
class LogFile;
}  // namespace ibkr::shell

namespace ibkr::app {

class PowerController : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool lidGuardEnabled READ lidGuardEnabled NOTIFY lidChanged)
    Q_PROPERTY(bool lidGuardAvailable READ lidGuardAvailable CONSTANT)

public:
    PowerController(shell::LogFile* log, shell::Alerter* alerter, QString userDataDir, QObject* parent = nullptr);
    /// 应用起来时:阻止闲置睡眠、听电源事件、读 lid-guard.json
    void start();
    /// 心跳每一问之后(引擎的 system.status):在盯的追踪条数(没连券商按 0)
    void observeStatus(const QJsonObject& status);
    bool lidGuardAvailable() const { return lidAvailable_; }
    bool lidGuardEnabled() const { return lid_.enabled; }
    /// 菜单里勾上 / 去掉「盯盘时合盖不睡」
    void setLidGuardEnabled(bool enabled);
    /// 退出之前:自己关掉的合盖睡眠要恢复(会弹授权框)。只做一次;做完调 done
    bool lidRestorePending() const;
    void restoreLidSleep(std::function<void()> done);

signals:
    void lidChanged();

private:
    void apply(const shell::power::Action& action);
    void driveLid(int live, std::function<void()> then = {});
    void applyLidAction(const shell::power::Action& action, std::function<void()> then);
    void save();

    shell::LogFile* log_;
    shell::Alerter* alerter_;
    QString lidFile_;
    shell::power::PowerWatch watch_;
    shell::power::LidGuard lid_;
    bool lidAvailable_ = false;
    bool lidDriving_ = false;
    bool lidRestored_ = false;
    bool quitting_ = false;
};

}  // namespace ibkr::app
