// 交易记录与排队等待触发的条件单(store/records.ts、store/pending.ts):记录页与订单看板共用一份。
//   · 读一次:上一次还没回来时什么都不做(直接算读完,同原版 `if (inFlight) return`);读不到留着上一份、记下原因;回包不是数组当空的;
//   · 引擎报 pending 事件、菜单「刷新状态」时重读;
//   · 条件单的盯盘(pending.poll)不在这里:它不看当前在哪一页,在 EngineSupervisor 里。
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QObject>

#include <functional>

namespace ibkr::shell {

class Bridge;

class ListStore : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonArray items READ items NOTIFY changed)
    /// 最近一次没读成的原因;读成了是空
    Q_PROPERTY(QString error READ error NOTIFY changed)

public:
    /// method:records.list / pending.list;params 原样发;field:回包里那一列的键
    ListStore(Bridge* bridge, QString method, QJsonObject params, QString field, QObject* parent = nullptr);
    QJsonArray items() const { return items_; }
    QString error() const { return error_; }
    /// 读完(成不成都算)再调 done;上一次还没回来时立刻调
    void load(std::function<void()> done = {});
    Q_INVOKABLE void reload() { load(); }
    void onEngineEvent(const QString& event);

signals:
    void changed();

private:
    Bridge* bridge_;
    QString method_;
    QJsonObject params_;
    QString field_;
    QJsonArray items_;
    QString error_;
    bool inFlight_ = false;
};

/// store/records.ts:records.list { limit: 60 }
class RecordsStore : public ListStore {
    Q_OBJECT
public:
    explicit RecordsStore(Bridge* bridge, QObject* parent = nullptr);
};

/// store/pending.ts:pending.list {}
class PendingStore : public ListStore {
    Q_OBJECT
public:
    explicit PendingStore(Bridge* bridge, QObject* parent = nullptr);
};

}  // namespace ibkr::shell
