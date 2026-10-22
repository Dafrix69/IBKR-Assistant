// 蝴蝶测算面板顶上那一行实时 SPX,以及它走到 25 的整数倍时的提醒(React 版 store/spot.ts)。
// 现价和测算用的是同一路(引擎的 options.spot:常规时段是指数本身,之外按期货推算),不是顶栏行情带那一格——那一格夜盘停在昨收上。
// **提醒的轮询不挂在面板上**:走到关口正是该回来测算的时候,人多半不在这一页。连着券商、提醒开着就两秒问一次;
// 提醒关着时只在面板看得见的时候问。判定在 shell/spot_levels;声音与弹窗跟 Alerter 的两个开关走,和价位提醒是同一扇窗。
// 提醒开关默认开,记在本机(React 版是 localStorage 的 dafri-spot-level-alert,这里是 Alerter 那个 ini 的 spot/alert)。
#pragma once

#include "shell/spot_levels.h"

#include <QJsonObject>
#include <QObject>
#include <QTimer>

#include <functional>

namespace ibkr::shell {

class Alerter;
class Bridge;
class StatusStore;

class SpotStore : public QObject {
    Q_OBJECT
    /// 最近一次问到的 options.spot 回包;没连券商、还没问到是 null
    Q_PROPERTY(QJsonValue quote READ quote NOTIFY changed)
    /// 最近一次没问成的原因;问成了是空
    Q_PROPERTY(QString failure READ failure NOTIFY changed)
    Q_PROPERTY(bool alertOn READ alertOn WRITE setAlert NOTIFY changed)
    /// 本次开机以来最近一次报的关口:{ level, direction, price, source, at, skipped };没有是 null
    Q_PROPERTY(QJsonValue lastHit READ lastHit NOTIFY changed)

public:
    static inline const QString kSymbol = QStringLiteral("SPX");
    static constexpr double kRefreshMs = 2'000;

    /// settingsPath:提醒开关落在哪个 ini(空 = 不落盘,测试用)
    SpotStore(Bridge* bridge, StatusStore* status, Alerter* alerter, QString settingsPath, QObject* parent = nullptr);

    QJsonValue quote() const { return quote_; }
    QString failure() const { return failure_; }
    bool alertOn() const { return alertOn_; }
    QJsonValue lastHit() const;
    void start();

    /// 一拍(1 秒的定时器在跑;测试直接调)
    void tick();
    void load();
    /// 面板挂上 / 卸下时调:提醒关着的时候,只有看得见才问现价
    Q_INVOKABLE void setVisible(bool on);
    void setAlert(bool on);

    std::function<double()> now;

signals:
    void changed();

private:
    void announce(const spot::Hit& hit);

    Bridge* bridge_;
    StatusStore* status_;
    Alerter* alerter_;
    QString settingsPath_;
    QTimer timer_;
    QJsonValue quote_ = QJsonValue::Null;
    QString failure_;
    bool hasFailure_ = false;
    bool alertOn_ = true;
    std::optional<spot::Hit> lastHit_;
    spot::WatchState watch_;
    bool inFlight_ = false;
    double last_ = 0;
    bool visible_ = false;
    bool started_ = false;
};

}  // namespace ibkr::shell
