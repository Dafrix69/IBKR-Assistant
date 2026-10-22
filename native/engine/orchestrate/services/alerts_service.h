// services/alerts.ts 逐句搬:价位提醒的编排——取行情、算价位(期权墙 + 趋势位 + 整数关口)、盯穿越、盯上了就自动补价位、
// 「短期内反复碰同一条日均线」的底账与判定、持仓追踪联动。状态机与价位算法在 analysis/alerts、analysis/ma_touch(纯计算);这里管:取什么、写库、推事件、按标的退避。
// 期望值:tests/fixtures/gen_svc_alerts.mjs(原 TS 服务现跑,假宿主按脚本答、每一次调用都记下来)。
//
// 与 TS 的对应与不同:
//   · 库是具体类 domain::TradeStore(与 TS 一样的行:Watch 是 OJson,键序 / 类型就是库里读出来的);行情是 MarketDataPort(svc1_ports.h)。
//   · TS 的 refresh / listWatches / poll 开头有 `await import("../alerts.js")`(第一次之后是一个微任务的让步),C++ 没有这一拍;
//     只在两个调用同一拍启动时才看得出先后,而它们都是先 await 行情再碰库,日志次序不变(对拍里有同拍启动两次 refresh 的场景)。
//   · TS 里 rerounded 沿用库里读回来的价位对象(带着它所有的键),C++ 经 AlertLevel 往返(price / label / source / kind / ma):库里的价位
//     永远是 levelDict 写进去的这几个键,往返不丢;手改过的库另说。
//   · 协程是成员函数,参数一律传值:AlertsService 必须活得比所有未完成的调用长(同 TS 闭包抓着 this)。
#pragma once

#include "analysis/alerts.h"
#include "analysis/ma_touch.h"
#include "orchestrate/services/svc1_ports.h"

#include <QHash>
#include <QSet>

#include <optional>

namespace ibkr::orchestrate {

class AlertsService : public Svc1Base {
public:
    AlertsService(Svc1Host& host, MarketDataPort& market) : Svc1Base(host), market_(market) {}

    /// 步长退避 / 失败原因 / 碰均线 / 持仓追踪联动的常数(同 TS 的 static readonly)
    static constexpr double kLevelsBackoffMs = 600'000;
    static constexpr double kTouchBackoffMs = 1'800'000;
    static constexpr int kMaxWatch = 30;
    static inline const QString kCrossConfirmPref = QStringLiteral("alerts.cross_confirm");
    static inline const QString kTouchConfigPref = QStringLiteral("alerts.touch_config");
    static inline const QString kOriginTracker = QStringLiteral("tracker");

    /// 重算某个标的的期权墙、趋势位与价位(AlertsRefreshResult)。params:{id, expiry?, step?};nowMs 空 = 此刻(nowEt().epochMs)
    util::Task<util::OJson> refresh(util::OJson params, std::optional<double> nowMs = std::nullopt);
    /// 一轮最多挑 1 只去算(连着券商、在时段内才做)。回算了哪只,没算回空
    util::Task<std::optional<QString>> tickLevels(double nowMs, bool inWindow);
    /// 没开「盯价位」的股没有这一说,回空;否则 "ok" / "pending" / "error:<原因>"
    std::optional<QString> levelsStatusOf(const QString& symbol);

    /// 没设过、存坏了都是 immediate
    QString crossConfirm();
    /// 给界面的盯单:均线价位换成按最近一次取价算的那个值。不写库
    util::Task<QList<util::OJson>> listWatches();

    analysis::ma_touch::Config touchConfig();
    void touchConfigChanged();
    util::Task<std::optional<QString>> tickTouch(double nowMs, bool inWindow);

    /// 把每个在盯的标的走一遍状态机,触发的价位推成通知。回 {fired, checked}
    util::Task<util::OJson> poll();

    void forget(const QString& symbol);
    std::optional<QString> adoptForTrack(const QString& symbol);
    QStringList adoptTracked(const QStringList& symbols);
    QStringList releaseForTrack(const QSet<QString>& tracked);

private:
    struct TouchSession {
        analysis::ma_touch::Config config;
        QString today, prevDay;
    };
    bool needsLevels(const util::OJson& watch, double nowMs, double openMs);
    QString prevDay(const QString& date);
    void saveTouchBook(const QString& watchId, const util::OJson& history, const QString& today);
    std::optional<TouchSession> touchSession();
    /// 一只股这一轮碰没碰均线。events / book 是返回值:book 空 = 底账没变
    struct TouchResult {
        QList<util::OJson> events;
        std::optional<util::OJson> book;
    };
    TouchResult touchEvents(const util::OJson& watch, double price, const QList<util::OJson>& crossings, const TouchSession& session, double at,
                            const util::OJson* book);

    MarketDataPort& market_;
    QHash<QString, double> levelTried_;
    QHash<QString, QString> levelNotes_;
    QHash<QString, analysis::alerts::PriceSample> lastSamples_;
    QHash<QString, double> touchTried_;
    struct SessionPrice {
        QString date;
        double price = 0;
    };
    QHash<QString, SessionPrice> sessionPrices_;
    bool trackedAdopted_ = false;
};

}  // namespace ibkr::orchestrate
