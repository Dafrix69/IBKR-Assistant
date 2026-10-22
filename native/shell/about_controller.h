// 「关于」一页的接线(pages/About.tsx,带 lib/UpdatePanel、lib/SupportPanel):
//   · 进来读版本信息(壳的 appInfo)与引擎自检(system.selftest),读不到写一句「读取失败:…」;
//   · 更新一节读 UpdateStore(检查、忽略这一版、自动检查的开关都交给它);下载与发布页的链接走壳的白名单(只认本仓库的 releases);
//   · 支持一节:导出诊断(存到哪由壳的保存框定)、拷贝概要、打开日志 / 配置 / 第三方许可声明所在位置、看条款;
//   · 引擎日志:从启动起就收(EngineClient 的 logLine),只留最近 200 行——这一页打开时才看得到,但不能打开时才开始记;
//   · 「重启交易引擎」:交给壳,1.2 秒后刷新状态、重读这一页。
// 模型:shell/settings_rules 的 aboutModel
#pragma once

#include <QJsonObject>
#include <QObject>
#include <QStringList>
#include <QTimeZone>

#include <functional>

namespace ibkr::shell {

class Bridge;
class StatusStore;
class UpdateStore;

class AboutController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonObject model READ model NOTIFY changed)

public:
    using Done = std::function<void(const QJsonObject& result, const QString& error)>;
    AboutController(Bridge* bridge, StatusStore* status, UpdateStore* update, QObject* parent = nullptr);

    QJsonObject model() const { return model_; }

    Q_INVOKABLE void setVisible(bool on);
    Q_INVOKABLE void restartEngine();
    Q_INVOKABLE void exportDiagnostics();
    Q_INVOKABLE void copyDiagnostics();
    /// logs / config / notices
    Q_INVOKABLE void reveal(const QString& kind);
    Q_INVOKABLE void showTerms();
    Q_INVOKABLE void openLink(const QString& url);
    Q_INVOKABLE void checkUpdate();
    Q_INVOKABLE void dismissUpdate(const QString& version);
    Q_INVOKABLE void setAutoUpdate(bool on);

    /// 引擎的一行日志(从启动起就接上)
    void appendLog(const QString& line);

    /// 壳给的(SupportService 与条款)
    std::function<QJsonObject()> appInfo;
    std::function<void()> restart;
    std::function<void(Done)> exportDiag;
    std::function<void(Done)> copyDiag;
    std::function<void(const QString& kind, Done)> revealPath;
    std::function<void()> terms;
    std::function<bool(const QString& url)> openUrl;
    bool mac = true;
    QTimeZone zone = QTimeZone::systemTimeZone();
    int restartRefreshMs = 1200;

signals:
    void changed();

private:
    void load();
    void rebuild();

    Bridge* bridge_;
    StatusStore* status_;
    UpdateStore* update_;
    bool visible_ = false;
    int generation_ = 0;
    QJsonValue info_ = QJsonValue::Null;
    QString error_;
    bool supportBusy_ = false;
    QStringList log_;
    QJsonObject model_;
};

}  // namespace ibkr::shell
