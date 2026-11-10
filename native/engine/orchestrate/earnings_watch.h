// 财报止盈在盯盘里的那一段:把「相对财报前收盘涨 N%」落成这一轮判不判、拿什么价判(docs/features/earnings-tp.md)。
// 纯计算在 analysis/earnings_tp;这里管取数与状态:
//   · 财报日历(IBKR WSH)与基准日收盘价(日线)在后台取——WSH 一次要等十几秒,盯盘一秒一轮,不能等它;取到了下一轮用
//   · 窗口(基准日收盘 → 反应日收盘)与基准收盘价落进追踪的 targets.earnings_tp,重启接着用
//   · 窗口里每一轮读正股买卖价(夜盘读夜盘那个交易所的),按立刻能成交的价判
// 这里不发单:只回这一轮的结论,触发之后过闸门、发单、追价全在 pollTrackers / closePosition 原来那条路上。
#pragma once

#include "analysis/earnings_tp.h"
#include "domain/config.h"
#include "orchestrate/tracker.h"
#include "util/ordered_json.h"
#include "util/task.h"

#include <QHash>
#include <QSet>
#include <QString>

#include <functional>
#include <memory>
#include <optional>

namespace ibkr::orchestrate {

class EngineRouter;

class EarningsWatch {
public:
    using Rec = util::OJson;
    struct Host {
        std::function<std::shared_ptr<EngineRouter>()> router;
        /// 把追踪的 targets 整份换掉(窗口排好了、基准收盘价取到了、过期作废了)
        std::function<void(const QString& tid, const Rec& targets)> saveTargets;
        std::function<void(const QString& message)> warn;
        analysis::etp::Calendar calendar;
        /// 正股日历给的时段(盘前 / 盘中 / 盘后 / 休市)
        std::function<QString(const domain::EtNow&)> baseStatus;
    };
    explicit EarningsWatch(Host host);

    struct Step {
        Rec row;                    // 给界面的那一块(追踪行的 earnings_tp)
        bool hit = false;           // 这一轮到价了
        std::optional<double> exec; // 这一轮立刻能成交的价(判定与定价、追价都用它)
        bool overnight = false;     // 此刻是夜盘:平仓单要送夜盘那个交易所
    };
    /// 这条追踪这一轮的财报止盈。没设、不是正股回空。active = 还在盯(启用着没触发)或平仓单正在追价;不 active 的只回库里那份,不取数。
    /// hosted = 托管到券商的追踪:托管单夜里不在夜盘交易所,夜盘那一段不判
    util::Task<std::optional<Step>> step(Rec track, Rec raw, tracker::Position position, domain::EtNow at, bool active, bool hosted);

    /// 后台取数隔多久再试(毫秒)。测试里调小
    double retryMs = 60'000;
    /// 财报日历取到之后隔多久再核对一次日期(毫秒)
    double refreshMs = 6 * 3600'000.0;
    /// 基准日收盘之后等多久才去取收盘价(毫秒):收盘竞价的那一笔要进了日线才算数
    double closeDelayMs = 60'000;

private:
    struct CalEntry {
        bool inFlight = false;
        double triedAt = 0, fetchedAt = 0;
        std::optional<Rec> view;  // util::earningsView 的结果
        QString error;
    };
    struct CloseEntry {
        bool inFlight = false;
        double triedAt = 0;
        std::optional<double> close;
        QString error;
    };
    struct State {
        QHash<QString, CalEntry> cal;      // 按标的
        QHash<QString, CloseEntry> close;  // 「标的|基准日」
        QSet<QString> warned;
    };
    static util::Task<> fetchCalendar(std::shared_ptr<State> st, std::shared_ptr<EngineRouter> router, QString symbol, QString today, double nowMs);
    static util::Task<> fetchClose(std::shared_ptr<State> st, std::shared_ptr<EngineRouter> router, QString symbol, QString refDate);
    /// 日历里此刻该用哪一场:窗口还没结束的、已确认的、盘前或盘后的第一场。没有就给原因
    analysis::etp::Planned pick(const Rec& view, double nowMs) const;
    void warnOnce(const QString& key, const QString& message);
    void save(const Rec& track, const Rec& etp);

    Host host_;
    std::shared_ptr<State> st_ = std::make_shared<State>();
};

}  // namespace ibkr::orchestrate
