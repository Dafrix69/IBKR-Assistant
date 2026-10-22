// 引擎因为配置 / 交易库退出(退出码 78 / 74)之后的那两个对话框(main.js 的 handleConfigFatal、support-ipc.js 的 handleStoreFatal):
//   配置:恢复上一份可用的配置(有备份、且和现在这份不一样时才有)/ 打开配置文件所在位置 / 我改好了,重试 / 退出;
//   交易库:用最近的备份恢复(只有库坏了才有)/ 打开数据所在位置 / 重试 / 退出。
// 引擎没起来期间持仓追踪不在盯盘,对话框里写明。判断与文件操作在 shell/config_guard、shell/store_guard。
#pragma once

#include "shell/engine_client.h"

#include <QObject>
#include <QString>

namespace ibkr::shell {
class Alerter;
class EngineSupervisor;
class LogFile;
}  // namespace ibkr::shell

namespace ibkr::app {

class DesktopShell;

class FatalDialogs : public QObject {
    Q_OBJECT
public:
    FatalDialogs(shell::EngineSupervisor* supervisor, shell::LogFile* log, shell::Alerter* alerter, DesktopShell* desktop, QString configPath, QObject* parent = nullptr);
    /// 引擎退出了:是 78 / 74 就弹对应的对话框
    void onEngineExited(const shell::EngineExit& info);

private:
    void handleConfig(const QString& kind, const QString& message);
    void handleStore(const QString& kind, const QString& message, const QString& dbPath);

    shell::EngineSupervisor* supervisor_;
    shell::LogFile* log_;
    shell::Alerter* alerter_;
    DesktopShell* desktop_;
    QString configPath_;
    bool configOpen_ = false;
    bool storeOpen_ = false;
};

}  // namespace ibkr::app
