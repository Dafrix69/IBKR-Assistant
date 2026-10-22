// 平台相关的几样(Electron 里由它自带):放一段声音、系统通知、Dock / 任务栏提醒、把提醒小窗设成浮在所有桌面与全屏之上的面板。
// macOS 在 platform_mac.mm(AppKit / UserNotifications);别的平台在 platform_other.cpp(能做的先做,做不了的如实返回 false)。
#pragma once

#include "shell/alerter.h"

#include <QByteArray>
#include <functional>
#include <optional>
#include <QString>

class QMenu;
class QWindow;

namespace ibkr::app::platform {

/// 放一段 WAV(提示音);放不了就算了
void playWav(const QByteArray& wav);
/// 系统通知;系统不支持或用户没授权返回 false
bool notify(const QString& title, const QString& body);
/// Dock 图标跳 / 任务栏闪(on),或停下(off)。macOS 是 critical 那一种:一直跳到人回来
void requestAttention(QWindow* main, bool on);
/// 提醒小窗:浮在所有桌面、别的应用的全屏之上,不进 Dock / 任务栏,点它不激活应用(macOS 的非激活面板)
void makeFloatingPanel(QWindow* window);
/// 内容铺进了标题栏(同 Electron 的 hiddenInset):系统自己画的标题字藏掉,不然压在应用标上;标题本身留着(「窗口」菜单要用)
void hideTitleText(QWindow* window);
/// 把应用叫到前台(「查看」:应用多半不在前台,单靠 requestActivate 提不上来)
void activateApp();
/// 在访达 / 资源管理器里选中这个文件
void revealFile(const QString& path);
/// 点 Dock 图标(或再打开一次应用)时调:窗口藏着的时候把它叫回来(Electron 的 activate 事件)
void onReopen(std::function<void()> handler);
/// 设成 Dock 图标的右键菜单(macOS)
void setDockMenu(QMenu* menu);

/// 此刻是不是在用电池;读不到返回空
std::optional<bool> onBatteryPower();
/// 换电源、系统要睡、系统醒来时回调(Electron 的 powerMonitor 的 on-battery / on-ac / suspend / resume)
void watchPower(std::function<void(bool onBattery)> powerChanged, std::function<void()> willSleep, std::function<void()> didWake);
/// 应用开着就不让系统闲置睡眠(同 Electron 的 powerSaveBlocker('prevent-app-suspension')),也不让 App Nap 把这个进程的定时器放慢:
/// 窗口藏着时提醒的轮询照样要准点。只挡闲置睡眠,不挡关屏;合盖挡不住。返回是否成功
bool preventAppSuspension();

/// shell::Alerter 要的声音与系统通知,接到上面两个函数
class Outputs : public shell::AlertOutputs {
public:
    void playWav(const QByteArray& wav) override { platform::playWav(wav); }
    bool notify(const QString& title, const QString& body) override { return platform::notify(title, body); }
};

}  // namespace ibkr::app::platform
