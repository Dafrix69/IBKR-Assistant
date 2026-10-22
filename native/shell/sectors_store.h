// 自定义板块(股票池)+ 成分股行情(store/sectors.ts)与池子身上的两个开关(store/pool.ts),逐句搬:
//   · 增删改在引擎侧都是本地库操作,回执里的板块直接覆盖本地那一份(没带就退回拉列表);
//   · 移除先改本地再等回执(等回执的那几百毫秒里再点一次会得到「不在该板块中」),失败退回并以引擎为准重读;
//   · 删板块先问一句(main.js 的 confirm 通道);
//   · 开关:pool.set_watch 只带要改的那一路;回执里没做成的(上限、指数不能盯异动)照引擎原话说,之后重读价位与异动两张表,
//     开关的真值以引擎为准——失败了也重读,不能停在人以为拨过去的那一侧;
//   · 加进板块、AI 选股的默认开关回执、移出池子连带撤掉的,都用横幅说出来。
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QObject>

#include <functional>

namespace ibkr::shell {

class AlertsStore;
class Bridge;
class QualityStore;
class StatusStore;

class SectorsStore : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonArray sectors READ sectors NOTIFY changed)
    Q_PROPERTY(QJsonObject quotes READ quotes NOTIFY changed)

public:
    SectorsStore(Bridge* bridge, StatusStore* status, AlertsStore* alerts, QualityStore* quality, QObject* parent = nullptr);

    QJsonArray sectors() const { return sectors_; }
    QJsonObject quotes() const { return quotes_; }

    using Done = std::function<void()>;
    using Ok = std::function<void(bool)>;
    void load(Done done = {});
    Q_INVOKABLE void reload() { load(); }
    void refreshQuotes(Done done = {});
    Q_INVOKABLE void refresh() { refreshQuotes(); }
    void addSector(const QString& name, Ok done);
    void deleteSector(const QString& id, const QString& name, Done done = {});
    void addStock(const QString& sectorId, const QString& symbol, const QString& tag, Ok done);
    void removeStock(const QString& sectorId, const QString& symbol);
    void setTag(const QString& sectorId, const QString& symbol, const QString& tag, Ok done = {});
    void pick(const QString& id, Done done);
    /// patch 只带要改的那一路:{ price: bool } 或 { anomaly: bool }
    void setPoolWatch(const QString& symbol, const QJsonObject& patch, Done done = {});

signals:
    void changed();

private:
    void replaceSector(const QJsonValue& fresh, Done done);
    void reloadBoth(Done done);
    bool reportSkipped(const QString& prefix, const QJsonValue& skipped);
    void reportDropped(const QJsonValue& dropped);
    void error(const QString& text);
    void info(const QString& text);

    Bridge* bridge_;
    StatusStore* status_;
    AlertsStore* alerts_;
    QualityStore* quality_;
    QJsonArray sectors_;
    QJsonObject quotes_;
};

}  // namespace ibkr::shell
