// 持仓追踪(React 版 store/tracker.ts):持仓、追踪设置、每秒盯盘结果、券商托管对账。
// 判断与发单全在引擎(节拍器每秒一轮,窗口最小化、切页都不影响执行);这里一秒读一次它最新一轮的结果,只为把界面画出来。
// 两个每秒循环不看当前在哪一页。读不到 ≠ 没有:追踪列表读失败时留着上一份,盯盘连着三轮读不到才说出来。
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QTimer>

#include <functional>

namespace ibkr::shell {

class Alerter;
class Bridge;
class StatusStore;

class TrackerStore : public QObject {
    Q_OBJECT
    /// { positions, positionsError, tracks, tracksError, rows, hosted, delayed, loop, pollError }
    Q_PROPERTY(QJsonObject snap READ snap NOTIFY changed)

public:
    static constexpr int kPositionsFailLimit = 3;
    static constexpr int kPollFailLimit = 3;

    TrackerStore(Bridge* bridge, StatusStore* status, Alerter* alerter, QObject* parent = nullptr);

    QJsonObject snap() const;
    QJsonArray tracks() const { return tracks_; }
    QJsonObject rows() const { return rows_; }
    void start();

    /// 重读追踪列表(refreshPositions:顺带重读持仓);then 在都读完之后调
    void load(bool refreshPositions = true, std::function<void()> then = {});
    Q_INVOKABLE void reload() { load(true); }
    /// 持仓页停留期间的现价 / 盈亏刷新(页面按券商定节拍:IBKR 1 秒、富途 5 秒)
    Q_INVOKABLE void refreshPositions();
    void poll();
    void reconcile();
    void onEngineEvent(const QString& event, const QJsonValue& data);

signals:
    void changed();
    /// 自动平仓了:交易记录要跟着重读(交易记录那一份 store 接它)
    void recordsStale();

private:
    void onFired(const QJsonArray& fired);

    Bridge* bridge_;
    StatusStore* status_;
    Alerter* alerter_;
    QTimer pollTimer_;
    QTimer reconcileTimer_;
    QJsonArray positions_;
    QJsonValue positionsError_ = QJsonValue::Null;
    QJsonArray tracks_;
    QJsonValue tracksError_ = QJsonValue::Null;
    QJsonObject rows_;
    QJsonObject hosted_;
    bool delayed_ = false;
    QJsonValue loop_ = QJsonValue::Null;
    QJsonValue pollError_ = QJsonValue::Null;
    bool pollBusy_ = false;
    bool reconcileBusy_ = false;
    bool positionsBusy_ = false;
    int pollFails_ = 0;
    int positionsFails_ = 0;
    QByteArray rowsSig_;
    QByteArray hostedSig_;
    QByteArray positionsSig_;
    bool started_ = false;
};

}  // namespace ibkr::shell
