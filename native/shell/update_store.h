// 新版本检查什么时候问、问到了怎么摆(React 版 store/update.ts)。请求本身由调用方做(app/support_service 的 checkUpdate)。
//   · 自动检查默认开:启动 30 秒后问一次(不和启动时的连接、行情抢),之后每 12 小时一次。「关于」页可以关掉;
//     关掉之后只有手动点「检查更新」才会去问。开发态(源码运行且带 DAFRI_DEV=1)不自动问。
//   · 顶栏的「新版本」提示可以按版本号忽略:忽略了 0.5.2,等 0.5.3 出来才再亮。
//   · 检查失败不打扰人:只记在这里,「关于」页看得到;不弹横幅。
// 两个偏好记在本机(React 版 localStorage 的 dafri-update-auto / dafri-update-dismissed,这里是 ini 的 update/*)。
#pragma once

#include <QJsonObject>
#include <QObject>
#include <QTimer>

#include <functional>

namespace ibkr::shell {

class UpdateStore : public QObject {
    Q_OBJECT
    /// 最近一次问到的(update_check 的结果);还没问过是 null
    Q_PROPERTY(QJsonValue info READ info NOTIFY changed)
    Q_PROPERTY(bool checking READ checking NOTIFY changed)
    /// 最近一次没问成的原因;问成了是空
    Q_PROPERTY(QString error READ error NOTIFY changed)
    Q_PROPERTY(bool autoCheck READ autoCheck WRITE setAuto NOTIFY changed)
    Q_PROPERTY(QString dismissed READ dismissed NOTIFY changed)
    /// 顶栏要不要亮「新版本」:有更新的正式版,且用户没忽略这一版;不亮是 null
    Q_PROPERTY(QJsonValue badge READ badge NOTIFY changed)

public:
    static constexpr int kFirstDelayMs = 30'000;
    static constexpr int kIntervalMs = 12 * 60 * 60 * 1000;
    using Done = std::function<void(const QJsonObject& info, const QString& error)>;
    using Check = std::function<void(bool force, Done done)>;

    UpdateStore(Check ask, QString settingsPath, QObject* parent = nullptr);

    QJsonValue info() const { return info_; }
    bool checking() const { return checking_; }
    QString error() const { return error_; }
    bool autoCheck() const { return auto_; }
    QString dismissed() const { return dismissed_; }
    QJsonValue badge() const;

    /// 开发态不自动问
    void start(bool dev);
    void check(bool force = false, std::function<void()> then = {});
    Q_INVOKABLE void checkNow(bool force) { check(force); }
    void setAuto(bool on);
    Q_INVOKABLE void dismiss(const QString& version);

    int firstDelayMs = kFirstDelayMs;
    int intervalMs = kIntervalMs;

signals:
    void changed();

private:
    void schedule(int delay);
    void apply(const QJsonObject& info, const QString& error);

    Check check_;
    QString settingsPath_;
    QTimer timer_;
    QJsonValue info_ = QJsonValue::Null;
    bool checking_ = false;
    QString error_;
    bool auto_ = true;
    QString dismissed_;
    bool started_ = false;
};

}  // namespace ibkr::shell
