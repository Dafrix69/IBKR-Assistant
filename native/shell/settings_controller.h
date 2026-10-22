// 「设置」一页的接线(pages/Settings.tsx,带 lib/EventsConfig、lib/DataPanel):
//   · 表单:进来读 settings.get(引擎报 settings 事件时重读),表单按 shell/settings_rules 的 toForm 填;
//   · 两个执行闸门:**关**是当场生效的(settings.patch 只送 policies 那一个 false,失败把开关拨回去),开只改表单、跟着「保存」走;
//   · 保存:先看表单的问题;要从关到开的闸门各弹一个确认框(gate.auto_execute / gate.allow_live_trading,点了取消就把那个开关拨回去、不存);
//     再弹「放宽风控限额」(limits.loosen,绑着补丁里的 limits——没放宽时 Bridge 不弹、直接放行);都过了才 settings.patch。
//     确认凭据与 Electron 的 confirm-grants.js 同一张表,由 Bridge 核销;
//   · 重要事件的口径:草稿跟着 EventsStore 的 config;改一格 600ms 防抖再存(开关当场存),离开页面时把没存的补存;
//   · 数据与备份:data.backups 读清单,data.backup 立即备份,恢复交给壳(停引擎、换库、重启;确认框是壳弹的),成了 2.5 秒后重读;
//   · 外观三项在 QML 的 Theme 里(记在本机),不经这里。
// 模型:shell/settings_rules 的 pageModel
#pragma once

#include <QJsonObject>
#include <QObject>
#include <QTimeZone>
#include <QTimer>
#include <QVariant>

#include <functional>

namespace ibkr::shell {

class Bridge;
class EventsStore;
class StatusStore;

class SettingsController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QJsonObject model READ model NOTIFY changed)

public:
    SettingsController(Bridge* bridge, StatusStore* status, EventsStore* events, QObject* parent = nullptr);

    QJsonObject model() const { return model_; }

    Q_INVOKABLE void setVisible(bool on);
    /// 表单的一格:key 是表单字段名(notional、slGuard、coolScope…);「rbEquity:别名」是那个账户的权益
    Q_INVOKABLE void setField(const QString& key, const QVariant& value);
    /// 按账户覆盖的一格
    Q_INVOKABLE void setAccountLimit(const QString& alias, const QString& key, const QVariant& value);
    /// 两个执行闸门:key = autoExecute / allowLive
    Q_INVOKABLE void setGate(const QString& key, bool on);
    Q_INVOKABLE void save();
    /// 重要事件的一格:enabled / feed / cross_market(当场存),min_stars / lead1 / lead2 / cross_market_pct / cross_lag_pct /
    /// sector_move_pct / sector_share(百分数)/ sector_min_stocks(防抖存)
    Q_INVOKABLE void setEvent(const QString& key, const QVariant& value);
    Q_INVOKABLE void loadBackups();
    Q_INVOKABLE void backupNow();
    Q_INVOKABLE void restoreBackup(const QString& name);
    /// 打开配置文件 / 备份目录所在位置(config / backups)
    Q_INVOKABLE void reveal(const QString& kind);

    void onEngineEvent(const QString& event);

    /// 壳给的(SupportService):在访达里打开、从备份恢复;done(结果, 错误)
    std::function<void(const QString& kind, std::function<void(const QJsonObject&, const QString&)> done)> revealPath;
    std::function<void(const QString& name, std::function<void(const QJsonObject&, const QString&)> done)> restore;
    QTimeZone zone = QTimeZone::systemTimeZone();
    /// 防抖与「过一会儿再看」:测试调短
    int eventsDebounceMs = 600;
    int restoreRefreshMs = 2500;

signals:
    void changed();

private:
    void load();
    void rebuild();
    void flushEvents();
    void saveEvents(const QJsonObject& part);
    void patchEvents(const QJsonObject& part, bool now);

    Bridge* bridge_;
    StatusStore* status_;
    EventsStore* events_;
    bool visible_ = false;
    int generation_ = 0;
    QJsonValue saved_ = QJsonValue::Null;
    QJsonValue form_ = QJsonValue::Null;
    bool saving_ = false;
    bool checked_ = false;
    QJsonValue dataInfo_ = QJsonValue::Null;
    QString dataError_;
    QJsonValue dataBusy_ = QJsonValue::Null;
    QJsonValue eventsDraft_ = QJsonValue::Null;
    QJsonObject eventsDirty_;
    QTimer eventsTimer_;
    QJsonObject model_;
};

}  // namespace ibkr::shell
