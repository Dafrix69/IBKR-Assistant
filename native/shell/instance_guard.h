// 同一份配置上只能有一个引擎:两个引擎会同时连 TWS(同一个 client id)、同时写同一个交易库、同时跑盯盘节拍发平仓单。
//
// - Electron 版开着时 Qt 版不拉引擎,没有开关可以绕过。认法:Electron(Chromium)单实例锁在 userData 目录下留一个
//   SingletonLock 符号链接,指向"主机名-pid";主机名是这台、pid 还活着,就是它在跑。主机不对、进程已经没了的是残留,不算。
//   只在 macOS / Linux 上有这个链接;Windows 上 Chromium 用的是别的机制,那里还认不出来(阶段 1 的 Windows 真机核对时补)。
// - Qt 版自己:userData 目录下一把 QLockFile,两个 Qt 版不能同时开。
//
// 根上的办法是引擎自己在交易库上加锁(不管谁拉起来的都只许一个),那是 TS 引擎的改动,另算一件事。
#pragma once

#include <QLockFile>
#include <QString>
#include <QStringList>

#include <memory>
#include <optional>

namespace ibkr::shell {

/// Electron 版可能用的 userData 目录(现在的与改名前的);第一个是它正在用的那个
QStringList electronUserDataDirs();

/// 那几个目录里有活着的 Electron 版:给出它的 pid
std::optional<qint64> runningElectronPid(const QStringList& userDataDirs, const QString& hostName);

/// 本机的主机名(和 Chromium 写进 SingletonLock 的那个比)
QString localHostName();

bool processAlive(qint64 pid);

/// Qt 版自己的单实例锁。拿到了返回锁(活多久锁多久),拿不到返回空
std::unique_ptr<QLockFile> lockQtShell(const QString& lockPath);

/// 要拉引擎之前问一句:不行就给出原因(显示在横幅上),行就是空
QString engineStartBlocker(const QStringList& electronDirs, const QString& hostName);

}  // namespace ibkr::shell
