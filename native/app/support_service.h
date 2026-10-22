// 「支持与数据」这一组(desktop/support-ipc.js 与 main.js 里的 app-info / update-check / engine-restart / quit-app):
//   导出 / 复制诊断信息、打开日志 / 配置 / 备份 / 许可声明所在位置、账户的加改删、从备份恢复交易库、检查新版本、应用信息、退出。
// 都是"出了问题的时候"和"第一次用的时候"才走的路。界面递不进任何路径:写到哪、打开哪个目录,由这里定,或者由这里弹的系统对话框定。
// 判断与文件操作在 shell/(diagnostics、accounts_setup、store_guard、update_check);这里只取材料、问人、动手。
// 对话框、选文件、在访达里显示这些平台动作由调用方注入,测试里换成假的。
#pragma once

#include "shell/accounts_setup.h"

#include <QJSEngine>
#include <QJSValue>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QObject>
#include <QPointer>
#include <QUrl>

#include <functional>
#include <optional>



namespace ibkr::shell {
class Alerter;
class EngineClient;
class EngineSupervisor;
class LogFile;
}  // namespace ibkr::shell

namespace ibkr::app {

/// 一个确认框:icon 是 warning / info / error;buttons 里 defaultIndex 是默认、cancelIndex 是取消
struct Confirm {
    QString icon = QStringLiteral("warning");
    QString title;
    QString message;
    QString detail;
    QStringList buttons;
    int defaultIndex = 0;
    int cancelIndex = 0;
};

class SupportService : public QObject {
    Q_OBJECT
public:
    struct Deps {
        shell::EngineClient* engine = nullptr;
        shell::EngineSupervisor* supervisor = nullptr;
        shell::LogFile* log = nullptr;
        shell::Alerter* alerter = nullptr;
        QString configPath;
        QString userDataDir;
        QString repoDir;
        QString noticesPath;
        QString appVersion;
        /// 弹确认框,返回点了第几个按钮(关掉 = cancelIndex)
        std::function<int(const Confirm&)> confirm;
        /// 保存对话框:返回选的路径,取消返回空
        std::function<QString(const QString& title, const QString& defaultPath, const QString& filter)> pickSavePath;
        /// 在访达里选中一个文件 / 打开一个文件或文件夹(失败返回原因)
        std::function<void(const QString& path)> reveal;
        std::function<QString(const QString& path)> openPath;
        std::function<void(const QString& text)> copyText;
        /// 用系统浏览器打开一个链接
        std::function<void(const QUrl& url)> openUrl;
        /// 条款同意的状态(诊断包的「其它」里带上)
        std::function<shell::OJson()> consentState;
        /// 检查新版本问的地址(测试换成本机的假服务器)
        QString latestApi;
        int updateTimeoutMs = 8000;
        /// 平台与架构(Node 的叫法);空 = 这台机器的
        QString platform;
        QString arch;
        /// 预览 / 截图(没接真引擎):不改配置文件、不换交易库。原版的预览台没有主进程,这两条路根本不存在;
        /// 这里不拦,预览时点一下「修改」就会改写仓库里那份真配置、换掉真交易库
        bool readOnly = false;
    };
    using Done = std::function<void(const QJsonObject& result, const QString& error)>;

    explicit SupportService(Deps deps, QObject* parent = nullptr);
    /// QML 的回调要靠它把结果换成 JS 值
    void setJsEngine(QJSEngine* js) { js_ = js; }

    // ---- C++ 那一面(菜单、测试) ----
    void exportDiagnostics(Done done);
    void copyDiagnostics(Done done);
    void reveal(const QString& kind, Done done);
    QJsonObject accountsInfo() const;
    void changeAccount(const shell::OJson& change, Done done);
    void restoreBackup(const QString& name, Done done);
    void checkUpdate(bool force, Done done);
    QJsonObject appInfo() const;
    void restartEngine();
    /// 上一次检查更新的结果(诊断包里带上);没检查过是空
    std::optional<QJsonObject> lastUpdateCheck() const { return updateCache_; }

    // ---- QML 那一面:回调 function (ok, result, error) ----
    Q_INVOKABLE void exportDiagnostics(const QJSValue& callback);
    Q_INVOKABLE void copyDiagnostics(const QJSValue& callback);
    Q_INVOKABLE void reveal(const QString& kind, const QJSValue& callback);
    Q_INVOKABLE QJsonObject accountsInfoForQml() const { return accountsInfo(); }
    Q_INVOKABLE void changeAccount(const QJSValue& change, const QJSValue& callback);
    Q_INVOKABLE void restoreBackup(const QString& name, const QJSValue& callback);
    Q_INVOKABLE void checkUpdate(bool force, const QJSValue& callback);
    Q_INVOKABLE QJsonObject appInfoForQml() const { return appInfo(); }
    Q_INVOKABLE void restartEngineFromQml() { restartEngine(); }
    Q_INVOKABLE void quitApp();
    /// 界面只许打开这几个站点的 https 链接(发布页、图表库署名);别的一律不开、记一行日志(main.js 的 openExternalIfAllowed)
    Q_INVOKABLE bool openExternal(const QString& url);
    static bool externalAllowed(const QString& url);

private:
    struct Collected;
    /// 问引擎要一样东西;引擎不在、不回话都不该让诊断包导不出来——那正是最需要它的时候
    void ask(const QString& method, std::function<void(std::optional<QJsonValue>, QString error)> done);
    void collect(std::function<void(const Collected&)> done);
    Done toJs(const QJSValue& callback);

    Deps deps_;
    QPointer<QJSEngine> js_;
    QNetworkAccessManager net_;
    std::optional<QJsonObject> updateCache_;
};

}  // namespace ibkr::app
