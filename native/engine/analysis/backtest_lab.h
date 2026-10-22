// backtestLab.ts:参数扫描 + 样本内 / 样本外 + 滚动前推(anchored walk-forward),Spearman 秩相关与它的置换 p 值。纯计算。
// 网格是 OJson 对象 {参数名: [数…]}(键序就是 Object.entries 的次序);品种是校验过、type 补齐了的那份。回执是 OJson,键序同 TS。
#pragma once

#include "analysis/backtest.h"

#include <QList>
#include <QString>

#include <optional>
#include <vector>

namespace ibkr::analysis::backtest_lab {

inline constexpr int kMaxSymbols = 8;
inline constexpr int kMaxCombos = 200;
inline constexpr int kMaxRuns = 800;
inline constexpr int kMaxValuesPerParam = 20;
inline constexpr int kMinSegmentBars = 20;
inline constexpr int kPermutationDraws = 9999;

struct SymbolBars {
    QString symbol;
    backtest::Bars bars;
};

struct SweepInput {
    std::vector<SymbolBars> series;
    QString strategy;
    util::OJson grid;  // Record<string, number[]>
    util::OJson instrument;
    double costPct = 0;
    double splitPct = 70;
    double folds = 0;
    QString objective;  // return / calmar
};

/// 参数网格 → 全部组合(键按网格里的次序,值按给的次序)
QList<util::OJson> gridCombos(const util::OJson& grid);
/// 几只标的只留大家都有的那些交易日
std::vector<SymbolBars> alignSeries(const std::vector<SymbolBars>& series);
/// SegmentStats(OJson)的得分
double scoreOf(const util::OJson& stats, const QString& objective);
std::optional<double> spearman(const std::vector<double>& a, const std::vector<double>& b);
std::optional<double> spearmanP(const std::vector<double>& a, const std::vector<double>& b, int draws = kPermutationDraws);
void checkGrid(const QString& strategy, const util::OJson& grid, double symbols);
util::OJson runSweep(const SweepInput& input);

}  // namespace ibkr::analysis::backtest_lab
