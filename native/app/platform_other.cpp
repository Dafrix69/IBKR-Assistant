#include "platform.h"

#include <QApplication>
#include <QDesktopServices>
#include <QFileInfo>
#include <QUrl>
#include <QWindow>

namespace ibkr::app::platform {

// 没有 Qt Multimedia,也还没接平台的放音接口:先不响(Windows 版接 PlaySound 时在这里补)
void playWav(const QByteArray&) {}

// Windows 的系统通知要有托盘图标或 WinRT 的 toast:还没接,如实说发不出去,调用方会记日志
bool notify(const QString&, const QString&) { return false; }

void requestAttention(QWindow* main, bool on) {
    if (on && main) QApplication::alert(nullptr);
}

void makeFloatingPanel(QWindow*) {}
void hideTitleText(QWindow*) {}

void activateApp() {}

// 资源管理器里选中:先只打开所在的文件夹(Windows 的 explorer /select 随 Windows 版一起接)
void revealFile(const QString& path) { QDesktopServices::openUrl(QUrl::fromLocalFile(QFileInfo(path).absolutePath())); }

void onReopen(std::function<void()>) {}

void setDockMenu(QMenu*) {}

// Windows 的电源状态(GetSystemPowerStatus)与睡眠通知随 Windows 版一起接
std::optional<bool> onBatteryPower() { return std::nullopt; }
void watchPower(std::function<void(bool)>, std::function<void()>, std::function<void()>) {}
bool preventAppSuspension() { return false; }

}  // namespace ibkr::app::platform
