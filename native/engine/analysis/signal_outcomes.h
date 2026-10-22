// signalOutcomes.ts:信号成绩单——各处的事件折成信号、进场那一根、1 / 5 / 20 个交易日的收益与基线、互不重叠的持有期、
// Hansen–Hodrick 式的 t、Student-t 的门槛(Bonferroni)、整份成绩单。纯计算。
// 信号(SignalEntry)来自 signal_log 的行:成绩单的明细是 {...信号, returns},信号上多出来的键原样带着走,所以信号留成 OJson
// (at / source / symbol / expect / price / label / variant 照 TS 的读法取;variant 是串或 null)。
// t 分布用 Math.atan / sin / cos:jsmath 的 sin / cos 与 Electron 的 V8 在约 3% 的输入上差一个末位(见 qt-rewrite.md),
// 门槛是二分 100 次再取两位小数,夹具里没有翻出来过。
#pragma once

#include "util/ordered_json.h"

#include <QList>
#include <QSet>
#include <QString>

#include <functional>
#include <optional>
#include <utility>
#include <vector>

namespace ibkr::analysis::signal_outcomes {

inline constexpr int kHorizons[3] = {1, 5, 20};
inline constexpr int kVerdictHorizon = 5;
inline constexpr double kMinWindows = 20;
inline constexpr double kMinTWindows = 5;
inline constexpr double kBaselineBars = 250;
inline constexpr double kTSingle = 2;
inline constexpr int kMaxRecent = 50;

/// SOURCE_LABEL(键序同 TS)
const QList<std::pair<QString, QString>>& sourceLabels();

/// 提前收盘日:空指针 = 内置日历
using EarlyCloses = const QSet<QString>*;

util::OJson signalFromWatchEvent(const util::OJson& e);
util::OJson signalFromAnomaly(const util::OJson& e);
util::OJson signalFromLeader(const util::OJson& row, double atMs);
/// 中性(bias 里没有 bull / bear)回 null
util::OJson signalFromPa(const util::OJson& pa, double atMs);

QString etDayStart(const QString& date);
double closeEpoch(const QString& date, EarlyCloses earlyCloses = nullptr);
QString entrySessionStart(double nowMs, const std::function<bool(const QString&)>& isTradingDay, EarlyCloses earlyCloses = nullptr);

struct DailyClose {
    QString date;
    double close = 0;
};
double entryIndex(const std::vector<DailyClose>& bars, double atMs, EarlyCloses earlyCloses = nullptr);
std::vector<std::optional<double>> signalReturns(const util::OJson& signal, const std::vector<DailyClose>& bars, EarlyCloses earlyCloses = nullptr);
std::optional<double> baselineReturn(const std::vector<DailyClose>& bars, double entry, double k, bool abs);

std::vector<double> windowBlocks(const std::vector<double>& sortedDays, double k);
double independentWindows(const std::vector<double>& days, double k);
struct Observation {
    double day = 0, excess = 0;
};
struct OverlapT {
    std::optional<double> t, mean;
    double independent = 0;
    bool flat = false;
    /// {t, mean, independent, flat}
    util::OJson toJson() const;
};
OverlapT overlapT(const std::vector<Observation>& obs, double k);
double tThreshold(double m, double windows);

/// bars:各标的的日线(Map 的插入次序不影响结果);days 空 = null
util::OJson scoreSignals(const QList<util::OJson>& entries, const std::vector<std::pair<QString, std::vector<DailyClose>>>& bars,
                         std::optional<double> days, EarlyCloses earlyCloses = nullptr);

}  // namespace ibkr::analysis::signal_outcomes
