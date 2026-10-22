// performance.ts:绩效体检(docs/features/performance.md)的计算——已了结的交易 → 一本美元账 → 胜率、盈亏比、期望值、R 与 SQN、回撤 →
// 规则挑出的行为毛病与保护规则建议。纯函数,不碰券商、不碰存储。界面那边的 shell/performance_rules 是另一回事(只管怎么摆),别混。
// 逐句搬;期望值:tests/fixtures/gen_performance_engine.mjs(原模块现跑),测试 tst_performance_engine(fixtures/performance.json 与 gen_performance.mjs 是界面那一层的,不是这个)。
//
// 形状:
//   · 输入的蝴蝶记录 / 股票持仓段 / Flex 仓位 / 导入期权行是 OJson(同 trade_outcomes),按 JS 的读法取值;记录是 null 时同 TS 抛 TypeError;
//   · 账本的一笔是 LedgerTrade(结构体,toJson 的键序同 contract/performance.ts 的 LedgerTrade);
//   · TS 里按**对象身份**认"同一笔"的地方(`c.t !== t`、Set<LedgerTrade>)这里按元素地址认:内部一律传 const LedgerTrade* 的序列,
//     子集合只放指针,不拷贝;
//   · Map 的遍历次序 = 插入次序(perDay 的 counts / pnl 用 OrderedDays)。
//
// 照搬的 TS 怪行为(不是这里的选择):
//   · buildLedger 的比较函数在 (closed_at, id) 都相同的两笔上不自洽(两个方向都回 1):不到 64 笔时与 V8 的插入排序同序(util/market_js 的 jsSort),
//     64 笔起用 std::stable_sort,两笔完全同键时次序可能和 V8 的 TimSort 不同(生产里 id 不重复,碰不到);
//   · lossBursts 的 lookbackMinutes ≤ 0 时 TS 的 while 永远出不来(at[lo] ?? now 在越界后恒成立);这里同样不设防,调用方只传 120;
//   · perDay 挑最好 / 最差的那天时拿当天合计和**已经取过整**的 best.pnl / worst.pnl 比。
#pragma once

#include "analysis/exec_quality.h"
#include "analysis/trade_outcomes.h"
#include "contract/settings.h"
#include "util/ordered_json.h"

#include <QList>
#include <QPair>
#include <QString>
#include <QStringList>

#include <optional>
#include <vector>

namespace ibkr::analysis::performance {

inline constexpr double kFlatUsd = 1.0;
inline constexpr int kMinGroup = 8;
inline constexpr int kMinSample = 30;
inline constexpr int kRecentWindow = 10;
inline constexpr int kRevengeMinutes = 30;
inline constexpr int kMaxLedgerRows = 300;
inline constexpr int kInitialStopMinutes = 15;

/// 建追踪时计划的止损(store.plannedStops)
struct PlannedStop {
    QString at;
    std::optional<QString> account;  // 老的痕里没有:null
    QString symbol;
    std::optional<QString> sec_type;  // 老的痕里没有:null
    double stop = 0;
};

struct LedgerTrade {
    QString id;
    QString kind;  // butterfly / stock / option
    QString symbol;
    QString label;
    std::optional<QString> opened_at;
    QString closed_at;
    double pnl = 0;
    bool net_of_commission = false;
    std::optional<double> risk;
    std::optional<double> r;
    std::optional<QString> risk_basis;  // max_loss / stop
    std::optional<QString> r_missing;   // no_stop / late_stop / undefined_risk / no_open / no_cost
    std::optional<double> exposure;
    std::optional<double> hold_minutes;
    bool paper = false;
};
util::OJson toJson(const LedgerTrade& t);
/// 夹具 / 界面递回来的账本行(键齐全、类型对)
LedgerTrade ledgerTradeFromJson(const util::OJson& o);

struct Excluded {
    double open = 0, unknown = 0, no_cost = 0;
};
struct Ledger {
    QList<LedgerTrade> trades;
    Excluded excluded;
};

struct LedgerInputs {
    QList<util::OJson> butterflies;
    QList<util::OJson> trips;
    std::vector<PlannedStop> stops;
    QList<util::OJson> positions;
    QList<util::OJson> options;
    trade_outcomes::SettleClose settleClose;
    trade_outcomes::IsPaper isPaper;
    double now = 0;
};

using Trades = std::vector<const LedgerTrade*>;
Trades refs(const QList<LedgerTrade>& trades);

// ---------------------------------------------------------------- 账本
QList<LedgerTrade> butterflyLedger(const QList<util::OJson>& records, const trade_outcomes::SettleClose& settleClose, double now, Excluded& excluded);
struct PlannedStopHit {
    std::optional<double> stop;
    bool late = false;
};
PlannedStopHit plannedStopFor(const util::OJson& trip, const std::vector<PlannedStop>& stops);
QList<LedgerTrade> stockLedger(const QList<util::OJson>& trips, Excluded& excluded, const std::vector<PlannedStop>& stops = {});
QList<LedgerTrade> positionLedger(const QList<util::OJson>& rows, const trade_outcomes::IsPaper& isPaper, Excluded& excluded);
QList<LedgerTrade> optionLedger(const QList<util::OJson>& rows, const trade_outcomes::IsPaper& isPaper);
Ledger buildLedger(const LedgerInputs& inp);

// ---------------------------------------------------------------- 统计
struct Interval {
    double lo = 0, hi = 0;
};
struct PerfStats {
    double trades = 0, wins = 0, losses = 0, flats = 0;
    std::optional<double> win_rate;
    std::optional<Interval> win_rate_ci;
    double net_pnl = 0, gross_profit = 0, gross_loss = 0;
    std::optional<double> avg_win, avg_loss, payoff_ratio, profit_factor, expectancy;
    std::optional<Interval> expectancy_ci;
    std::optional<double> breakeven_win_rate, largest_win, largest_loss;
    double max_consecutive_wins = 0, max_consecutive_losses = 0;
};
util::OJson toJson(const PerfStats& s);
PerfStats perfStats(const Trades& trades);

QString sqnLabel(std::optional<double> sqn);

struct PerfRStats {
    double trades = 0;
    std::optional<double> expectancy_r;
    std::optional<Interval> expectancy_ci;
    std::optional<double> std_r, win_rate, payoff_ratio, kelly, sqn;
    QString sqn_label;
};
util::OJson toJson(const PerfRStats& s);
PerfRStats rStats(const Trades& trades);

struct PerfRCoverage {
    double trades = 0, with_r = 0, flats = 0, max_loss = 0, stop = 0;
    struct Missing {
        QString reason, label;
        double trades = 0;
    };
    QList<Missing> missing;
};
util::OJson toJson(const PerfRCoverage& c);
PerfRCoverage rCoverage(const Trades& trades);

struct EquityPoint {
    QString time;
    double equity = 0, drawdown = 0;
};
struct PerfDrawdown {
    double max = 0;
    std::optional<QString> peak_at, trough_at;
    double current = 0;
    std::optional<double> recovery_factor;
};
struct EquityCurve {
    QList<EquityPoint> points;
    PerfDrawdown drawdown;
};
util::OJson toJson(const EquityCurve& e);
EquityCurve equityCurve(const Trades& trades);

struct Session {
    QString key, label;
};
std::optional<Session> sessionOf(const std::optional<QString>& iso);

struct DayValue {
    QString date;
    double pnl = 0;
};
/// 按插入次序的 日期 → 值
using OrderedDays = QList<QPair<QString, double>>;
struct PerDay {
    double days = 0, green_days = 0;
    std::optional<DayValue> best_day, worst_day;
    std::optional<double> avg_losing_day;
    OrderedDays counts, pnl;
};
/// 只有 PerfDays 那五个键(counts / pnl 不进)
util::OJson toJson(const PerDay& d);
PerDay perDay(const Trades& trades);

std::optional<double> kellyOf(const PerfStats& s);

struct PerformanceOptions {
    QString scope;  // all / live / paper
    QString kind;   // all / butterfly / stock / option
    std::optional<double> days;
    double now = 0;
};
Trades filterLedger(const Trades& trades, const PerformanceOptions& opts);

struct PerformanceExtras {
    std::vector<execquality::CloseTrace> traces;
    const contract::ProtectionsConfig* protections = nullptr;
};

/// ReviewPerformanceResult(键序同 TS 的对象字面量)。ledger.trades 要按了结时刻从早到晚(buildLedger 给的就是)
util::OJson performanceReport(const Ledger& ledger, const PerformanceOptions& opts, const PerformanceExtras& extras = {});

// ---------------------------------------------------------------- 规则用的几样
struct Split {
    Trades quick, rest;
};
Split revengeSplit(const Trades& trades);
Split sameSymbolReentry(const Trades& trades);
struct SizeAfterLoss {
    double afterLoss = 0, upAfterLoss = 0, afterWin = 0, upAfterWin = 0;
};
SizeAfterLoss sizeAfterLoss(const Trades& trades);
struct DailyLossReplay {
    double days_hit = 0, skipped = 0, skipped_wins = 0, skipped_losses = 0, skipped_pnl = 0, unknown_open = 0;
};
util::OJson toJson(const DailyLossReplay& r);
DailyLossReplay dailyLossReplay(const Trades& trades, double line);
double lossBursts(const Trades& trades, double lookbackMinutes, double count, double pauseMinutes);

}  // namespace ibkr::analysis::performance
