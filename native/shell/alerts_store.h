// 期权墙 · 价位警告(React 版 store/alerts.ts)。价位与状态机都在引擎侧,这里只负责显示和触发重算。
// 唯一特别的地方:警告轮询**不挂在当前页上**——切走了还得报,不然就没用了。10 秒一轮,只在连着券商、
// 而且有一条开着并算出了价位的盯单时才问引擎(alerts.poll)。
// 一轮里报出来的一批走一次 Alerter::announceBatch(一声、一次弹窗);弹窗没收下的合成一条系统通知。
// 这只在持仓追踪里时,正文末尾补一句离止损还有多远、「查看」落到持仓追踪页(trackerSnapshot 由持仓追踪那一份给)。
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QSet>
#include <QTimer>
#include <QVariant>

#include <functional>

namespace ibkr::shell {

class Alerter;
class Bridge;
class StatusStore;

class AlertsStore : public QObject {
    Q_OBJECT
    /// { watches, feed, busy, lastCheck, touchConfig, crossConfirm }
    Q_PROPERTY(QJsonObject snap READ snap NOTIFY changed)
    /// 侧栏徽标:已算出价位、真的在盯的标的数
    Q_PROPERTY(int armed READ armed NOTIFY changed)

public:
    static constexpr int kPollMs = 10'000;
    static constexpr int kFeedMax = 50;

    AlertsStore(Bridge* bridge, StatusStore* status, Alerter* alerter, QObject* parent = nullptr);

    QJsonObject snap() const;
    int armed() const;
    void start();

    Q_INVOKABLE void load() { reload({}); }
    /// 读一遍,读完(成不成都算)再调 then(板块页的 await loadAlerts())
    void load(std::function<void()> then) { reload(std::move(then)); }
    void poll();
    void onEngineEvent(const QString& event, const QJsonValue& data);

    /// 建一个提醒并立刻算一次墙;结果走 created(ok)。origin = tracker:持仓追踪页建的
    Q_INVOKABLE void createWatch(const QString& symbol, double step, const QString& origin = QString());
    /// 重算一条盯单的价位;step 不给 / null / undefined = 不改步长,0 = 自动(QML 的 null 转成 double 会变 0,所以收 QVariant)
    /// 给了什么就原样交给引擎(负数、读不成数的由引擎拒绝并说原因,同原版)
    Q_INVOKABLE void refreshWatch(const QString& id, const QString& expiry = QString(), const QVariant& step = QVariant()) {
        refresh(id, expiry, step.isValid() && !step.isNull() ? QJsonValue::fromVariant(step) : QJsonValue(QJsonValue::Undefined), {});
    }
    Q_INVOKABLE void saveTouchConfig(const QJsonObject& partial);
    Q_INVOKABLE void saveCrossConfirm(const QString& mode);
    Q_INVOKABLE void deleteWatch(const QString& id, const QString& symbol);

    /// 价位穿越的弹窗与系统通知用到的几样(和 React 版一字不差)
    static QString alertTitle(const QJsonObject& event);
    QJsonObject toPopupItem(const QJsonObject& event) const;

    /// 持仓追踪的那一份:tracks + rows(追踪 id → 盯盘那一行);没接上是空
    std::function<std::pair<QJsonArray, QJsonObject>()> trackerSnapshot;
    std::function<double()> now;
    /// 「上次检查 HH:mm:ss」的钟点(本机时间);测试固定它
    std::function<QString()> clock;

signals:
    void changed();
    void created(bool ok);
    void touchConfigSaved(bool ok);

private:
    /// 读一遍盯单;读完(成不成都算)再调 then——React 版那几处 await loadAlerts() 之后才往下走
    void reload(std::function<void()> then);
    void announce(const QJsonArray& events);
    void prependFeed(const QJsonArray& events);
    void setBusy(const QString& id, bool on);
    void refresh(const QString& id, const QString& expiry, const QJsonValue& step, std::function<void()> then);
    void showError(const QString& text);
    void showInfo(const QString& text);

    Bridge* bridge_;
    StatusStore* status_;
    Alerter* alerter_;
    QTimer timer_;
    QJsonArray watches_;
    QJsonArray feed_;
    QSet<QString> busy_;
    QString lastCheck_ = QStringLiteral("—");
    QJsonValue touchConfig_;
    QString crossConfirm_ = QStringLiteral("immediate");
    bool polling_ = false;
    bool started_ = false;
};

}  // namespace ibkr::shell
