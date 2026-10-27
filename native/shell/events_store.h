// 重要事件(React 版 store/events.ts):清单从引擎来(内置日程 + 公开日历 + 自定义),提前提醒与板块联动在这里判。
// 三个节拍,都不看当前在哪一页:
//   · 清单 5 分钟拉一次(跨市场的窗口里一分钟);引擎重启、加删自定义事件时当场重拉。
//   · 15 秒一拍:倒计时跟着走,到了提前提醒的点就报(announce)。报过的记在内存里,每档只报一次。
//   · 板块联动 60 秒一轮,只在连着券商、美东 04:00 ~ 20:00 里问:成分股的涨跌幅读异动循环留在引擎里的那一份(quality.list),
//     只认 3 分钟之内的;一个板块的集体涨跌报一次,之后条件消失 30 分钟才撤。09:20 ~ 09:30 看到的是盘前的涨跌:
//     记录实际有报价的成分股与中位,10:00 ~ 10:30 同组行情齐全时复核快照,上涨回吐与下跌恢复对称。
//   · 时段提醒跟着 15 秒那一拍:欧盘开收、美股开盘前、最后一小时,各按当地钟点(events::sessionMarks),总开关关了不报。
// 判定全在 shell/event_rules(照 lib/eventRules.ts);这里只管节拍、调引擎、把顶上那条与「全部」里每一行写什么算好。
// 报出来的提醒走 announce 信号:界面写进通知流;弹窗、提示音、系统通知等主进程那一块搬过来再接(React 版的 announce)。
#pragma once

#include "shell/event_rules.h"

#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QSet>
#include <QTimer>

#include <functional>

namespace ibkr::shell {

class Bridge;
class StatusStore;

class EventsStore : public QObject {
    Q_OBJECT
    /// 顶上那一条:{ hidden, moves: [{ key, direction, title, meta, tip }], items: [{ id, phase, impact, cross, stars, title, titleTip, meta, fact, canAct }], more }
    Q_PROPERTY(QJsonObject strip READ strip NOTIFY changed)
    /// 「全部」:{ status, enabled, days: [{ day, events: [{ id, phase, when, title, stars, source, count, items, note, custom }] }] }
    Q_PROPERTY(QJsonObject all READ all NOTIFY changed)

public:
    static constexpr double kListRefreshMs = 5 * 60'000;
    static constexpr double kSectorSweepMs = 60'000;
    static constexpr double kSectorsRefreshMs = 10 * 60'000;
    static constexpr double kSectorLingerMs = 30 * 60'000;

    EventsStore(Bridge* bridge, StatusStore* status, QObject* parent = nullptr);

    QJsonObject strip() const { return strip_; }
    QJsonObject all() const;
    void start();

    Q_INVOKABLE void load(bool force = false);
    /// 一拍(定时器在跑;测试直接调)
    void tick();
    /// 引擎发来的事件:ready = 引擎重启过,日历源的缓存没了,清单重拉
    void onEngineEvent(const QString& event);
    /// 自己记一条 / 删一条;结果走 customDone(空串 = 成了)
    Q_INVOKABLE void addCustom(const QString& title, const QString& dateEt, const QString& timeEt, const QString& note);
    Q_INVOKABLE void removeCustom(const QString& id);
    /// 设置页「重要事件」的口径改了一部分(store/events.ts 的 saveEventsConfig):events.set_config,成了就换上引擎回的那份并重拉清单;
    /// done(空串 = 成了,否则是引擎的原话)
    void saveConfig(const QJsonObject& part, std::function<void(const QString& problem)> done);
    /// 引擎给的口径;清单还没读到是空对象
    QJsonObject config() const { return list_.value(QLatin1String("config")).toObject(); }

    // 「应对」对话框要的
    /// 一条事件(含跨市场那条)的原样 JSON;没有是空对象
    Q_INVOKABLE QJsonObject eventById(const QString& id) const;
    /// 应对框顶上那一句:何时、倒计时、提前几分钟提醒
    Q_INVOKABLE QString actionsWhen(const QString& id) const;
    Q_INVOKABLE QJsonObject hedge(const QJsonObject& spec) const;
    Q_INVOKABLE QString etToday() const { return events::etDateOf(now()); }
    Q_INVOKABLE QString hedgeExpiry(const QString& id) const;
    /// 美东常规时段(周一到周五 09:30 ~ 16:00)之外:正股指令要加「盘外」
    Q_INVOKABLE bool outsideRth() const;

    /// 引擎给的清单原样(蝴蝶测算面板顶上的事件提醒要按它算)与这一拍的时钟
    QJsonObject list() const { return list_; }
    double nowMs() const { return now_; }

    std::function<double()> now;
    int tickMs = 15'000;
    /// 本机时区(钟点怎么写);测试固定它
    QString tz;

signals:
    void changed();
    /// 一条该报的提醒:item = { id, kind, symbol, title, body, tone, at, page };direction = up / down / 空
    void announce(const QJsonObject& item, const QString& direction);
    void customDone(const QString& problem);

private:
    QJsonArray allEvents() const;
    void checkLeads(double t);
    void sweepSectors(double t);
    void finishSweep(double t, const QJsonArray& quality);
    void checkFades(double t, const QMap<QString, std::optional<double>>& changes, double minStocks);
    void checkSessionMarks(double t);
    void rebuild();
    bool inSession(double t) const;

    Bridge* bridge_;
    StatusStore* status_;
    QTimer timer_;
    QJsonObject list_;  // 空 = 还没拉到
    QString failure_;
    double now_ = 0;
    /// 正在集体走的板块:SectorMove + since + seenAt
    QJsonArray moves_;
    /// 盘前集体涨跌的板块:「美东日期:板块」→ 最近一次触发时的中位与实际有报价的成分股
    struct PremarketRally {
        QString date;
        QString sector;
        double median = 0;
        QStringList symbols;
    };
    QMap<QString, PremarketRally> premarketRallies_;
    bool inFlight_ = false;
    double loadedAt_ = 0;
    QSet<QString> fired_;
    QJsonArray sectors_;
    double sectorsAt_ = -1e18;
    double sweepAt_ = -1e18;
    bool sweeping_ = false;
    QJsonObject strip_;
};

}  // namespace ibkr::shell
