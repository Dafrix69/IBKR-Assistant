// engine/exits.ts 逐句搬:盯盘一轮里和"怎么出场"有关的那几样状态——推峰值用的价、标的止损的确认计时、分批止盈的档位。
// 判定本身是纯函数(orchestrate/tracker、analysis/tracker_rules);这里只管它们要的状态与落库。计时、上一轮的价只在内存里:
// 引擎重建后计时从头数、峰值下一轮再推——偏保守的那一侧。分批止盈的档位在库里(追踪的 targets),重建、重启都接得上。
// 期望值:tests/fixtures/gen_engine_exits.mjs(原模块现跑)。
//
// 价是 optional<double>(TS 的 number | null)。TS 里 price 若是 undefined(持仓行缺了 market_price 键)与 null 不同:这里一律当 null,
// 券商持仓行总带这个键(值可以是 null),夹具也这样给。
#pragma once

#include "analysis/tracker_rules.h"
#include "domain/config.h"
#include "orchestrate/engine_ports.h"
#include "orchestrate/tracker.h"
#include "util/notify.h"

#include <QHash>
#include <QSet>
#include <QString>

#include <optional>

namespace ibkr::orchestrate {

class ExitsHost {
public:
    virtual ~ExitsHost() = default;
    virtual EngineStore& store() = 0;
    virtual util::Notifier& notifier() = 0;
};

class TrackExits {
public:
    explicit TrackExits(ExitsHost& host) : host_(host) {}

    /// 新的一轮。盯盘每轮开头叫一次;托管对账和盯盘同一轮时不叫
    void nextRound() { round_ += 1; }
    /// 推峰值用的价。默认就是这一轮的价;confirm(auto_close.peak_confirm)的期权与组合要连续两轮都见到才算
    std::optional<double> peakMark(const QString& tid, const tracker::Position& position, std::optional<double> price, bool confirm = false);

    /// 设了确认秒数的:越线之后待够了才算。没设的原样返回。row 空 = 没设标的止损
    std::optional<util::OJson> confirmSpot(const QString& tid, const util::OJson& targets, const std::optional<util::OJson>& row, double nowMs);

    struct JudgeArgs {
        util::OJson track;
        tracker::Position position;
        util::OJson targets, autoClose;
        std::optional<double> price;
        /// natural:stop_basis = natural 的期权 / 组合给这一轮的立刻成交价;别的不给(外层空)。外层有、内层空 = 拿不到(null)
        std::optional<std::optional<double>> natural;
        domain::EtNow at;
        std::optional<util::OJson> spotTarget, spotStop;
    };
    /// 一条追踪这一轮的结论:价格触发 → 标的触发 → 分批止盈 → 到点平仓,后面的只在前面都没触发时生效
    util::OJson judge(const JudgeArgs& args);

    /// 「到价了但没有平仓」该不该提醒。同一条追踪、同一种触发只说一次
    bool warnBlocked(const util::OJson& track, const QString& state);

    /// 这一轮触发的是分批止盈的某一档:先把这一档记成"在等成交"(落库在发单之前),回这一次平仓用的设置——平的比例换成这一档的
    util::OJson tierAuto(const util::OJson& track, const util::OJson& targets, const util::OJson& result, const util::OJson& autoClose,
                         const tracker::Position& position);
    /// 这一档的平仓单没发出去、追踪也没落闩:把"在等成交"摘掉
    void tierNotSent(const util::OJson& track);
    /// 分批止盈的一档成交了:这一档划掉、把闩解开。回 true = 这一轮刚解开
    bool rearmTier(const util::OJson& track, const tracker::Position& position);

    /// 已经删掉的追踪:把它们的计时与上一轮的价丢掉
    void forget(const QSet<QString>& alive);

private:
    struct Mark {
        double round = 0;
        std::optional<double> cur, out;
    };
    util::OJson lapseTimeExit(const util::OJson& track, const util::OJson& targets, double nowMs);
    util::OJson confirmStock(const QString& tid, const util::OJson& result, bool isLong, const util::OJson& targets, double nowMs);

    ExitsHost& host_;
    QHash<QString, Mark> marks_;
    double round_ = 0;
    QHash<QString, analysis::BreachClock> breaches_;
    QHash<QString, analysis::BreachClock> stockBreaches_;
    QHash<QString, QSet<QString>> blockedSeen_;
};

}  // namespace ibkr::orchestrate
