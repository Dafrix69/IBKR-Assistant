// 电源与睡眠(desktop/power-watch.js)、盯盘时合盖不睡(desktop/lid-guard.js),逐条搬。只判断、不动手:
// 读 pmset、弹授权框去改、发通知、记日志都由调用方做(app/power_monitor)。期望值由 node 驱动原模块现算(tests/fixtures/gen_power.mjs)。
//
// 用电池时合上笔记本,macOS 直接睡眠,本机盯盘全停;应用自己挡得住闲置睡眠,挡不住合盖。这里能做的:
//   · 睡下、醒来、换电源各记一行日志;用电池又有追踪在本机盯着时提醒一次(一段电池期间一次)。
//   · 有追踪在盯、合盖睡眠还开着:弹一次系统授权框把它关掉(pmset -a disablesleep 1);只恢复自己关掉的那一次;
//     没追踪在盯满 10 分钟、菜单里关掉这一项、退出应用时恢复。授权框被取消:这一段不再问。状态记在 lid-guard.json
//     (与 Electron 版同一份:两版都认得那是"自己关的")。
#pragma once

#include <QJsonObject>
#include <QString>

#include <optional>

namespace ibkr::shell::power {

struct Notice {
    QString title;
    QString body;
};

/// 一步要做的事:写一行日志、发一条通知、(合盖那边)改 disablesleep。都没有就是什么也不做
struct Action {
    std::optional<bool> set;
    QString log;
    std::optional<Notice> notify;
};

QString minutesText(double ms);
Notice batteryNotice(int live, bool lidAwake);

class PowerWatch {
public:
    /// 电源状态或在盯的追踪条数变了(没给的那一项不变)。args:{ onBattery?: bool, live?: number, lidAwake?: bool }
    Action observe(const QJsonObject& args);
    Action suspend(double now);
    Action resume(double now);

    std::optional<bool> onBattery;
    int live = 0;
    bool warned = false;
    bool lidAwake = false;

private:
    std::optional<double> suspendedAt_;
};

inline constexpr double kOffDelayMs = 10 * 60'000;

/// `pmset -g` 的输出里读 SleepDisabled;读不出来是空
std::optional<bool> parseSleepDisabled(const QString& text);
/// 交给 osascript 的那一句:由 macOS 弹管理员授权框,再跑 pmset
QString pmsetScript(bool on);
/// osascript 的失败里认出"用户点了取消"(-128)
bool isCancelled(const QString& stderrText, const QString& message);

class LidGuard {
public:
    explicit LidGuard(bool on = true, bool mine = false) : enabled(on), owned(mine) {}
    /// 要不要去读 `pmset -g`:没追踪在盯、也不是自己关的,就不用每 10 秒跑一次
    bool wantsReading(int tracking) const { return (enabled && tracking > 0) || owned; }
    /// args:{ live?: number, sleepDisabled?: bool, now: number }。set 有值时由调用方去改,改完调 done
    Action observe(const QJsonObject& args);
    /// 退出应用之前:自己关掉的要恢复
    Action quitAction();
    void setEnabled(bool on);
    /// outcome:ok / cancelled / failed
    Action done(bool on, const QString& outcome, const QString& detail = {});

    bool enabled;
    bool owned;
    std::optional<bool> sleepDisabled;
    int live = 0;
    std::optional<double> idleSince;
    bool declined = false;
    bool restoreDeclined = false;
    bool busy = false;
};

/// lid-guard.json:{ enabled, owned };读不出来按默认(开着、不是自己关的)
LidGuard loadLidGuard(const QString& path);
void saveLidGuard(const QString& path, const LidGuard& guard);

}  // namespace ibkr::shell::power
