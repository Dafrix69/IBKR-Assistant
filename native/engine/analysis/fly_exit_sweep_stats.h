// flyExitSweepStats.ts:蝶式出场参数扫描的统计(纯计算)——每组参数比参照组好多少、这个"好"信不信。
// 两层:见过的这些天上谁领先(在天上重抽的 bootstrap-t / max-t / 对半检验,近似,不拿它下结论);
// 能不能说它就是更好(Anderson 1969 + DKW–Massart + Bonferroni 的不靠分布假设的下界,结论只由它出)。
// 方法的来龙去脉、为什么保守,见 TS 文件开头的那段(这里不重抄)。
//
// 数的细节照 JS:mean 是 reduce(初值 0:[-0] 的均值是 +0);Float64Array.sort() 是数值序、NaN 在最后、-0 排在 +0 前;
// 取整与对数走 util/jsmath;mulberry32 的 Math.imul 与 >>> 用 uint32 回绕。
#pragma once

#include "analysis/fly_exit_sweep_spec.h"

#include <QString>

#include <array>
#include <functional>
#include <optional>
#include <vector>

namespace ibkr::analysis::sweep {

struct BootOptions {
    /// 置信水平(双侧)
    double level = 0.95;
    /// 重抽多少次
    double draws = 1000;
    /// 随机数种子
    double seed = 0;
    /// 一天平均下来,一组参数最多能比参照组多亏(或多赚)多少;不给 = 不知道上限
    std::optional<double> cap;
};

/// [下界, 上界];空 = 那一头没有界
struct Interval {
    std::optional<double> lo, hi;
};

struct SetStat {
    double mean = 0, diff = 0;
    std::optional<double> se;
    double wins = 0, losses = 0, ties = 0;
    std::array<std::optional<double>, 2> halves;
    double degenerate = 0;
    bool eligible = false;
    std::optional<Interval> ci, band, exact;
    std::optional<double> unseen, seen, breakeven, days_needed;
};

struct SplitHalf {
    QString picked_on;  // odd / even
    std::optional<size_t> picked;
    std::optional<double> in_sample, held_out;
    double held_out_days = 0, wins = 0, losses = 0;
    std::optional<Interval> ci;
};

struct Analysis {
    double days = 0, level = 0, draws = 0, seed = 0;
    std::optional<double> cap;
    std::vector<SetStat> sets;
    size_t reference = 0;
    double eligible = 0;
    std::optional<Interval> critical;
    std::optional<size_t> top;
    std::vector<size_t> ahead, behind, better, worse;
    std::optional<double> alpha_tail, min_days;
    std::vector<SplitHalf> split;
};

/// Float64Array.prototype.sort():数值序,NaN 在最后,-0 在 +0 前面
void sortLikeFloat64Array(std::vector<double>& v);
/// mulberry32;seed 先按 `>>> 0` 取成 uint32
std::function<double()> seededRandom(double seed);
double degenerateProb(const std::vector<double>& xs);
struct ExactLower {
    double lower, unseen, seen;
};
std::optional<ExactLower> exactLower(const std::vector<double>& d, double cap, double alphaTail, double alphaSeen);
Analysis analyse(const std::vector<std::vector<double>>& matrix, size_t reference, const BootOptions& opts);

struct Verdict {
    QString state;  // better / fragile / unproven / not_separated / nothing_to_compare
    std::optional<size_t> set;
    QStringList failed;
};
extern const QString kCheckCoarse, kCheckTerminal, kCheckHalves;
struct VerdictCheck {
    QString name;
    std::vector<double> diffs;
};
Verdict verdictOf(const Analysis& primary, const std::vector<VerdictCheck>& checks);

struct FamilySummary {
    QString family, objective;  // objective: r / usd
    Analysis primary, secondary;
    std::vector<double> coarse, alt_terminal;
    Verdict verdict;
};
struct Summary {
    QString objective;
    double level = 0, draws = 0, seed = 0;
    FamilySummary live;
    std::optional<FamilySummary> replay;
};
Summary summarise(const SweepResult& result, const QString& objective, const BootOptions& opts);

}  // namespace ibkr::analysis::sweep
