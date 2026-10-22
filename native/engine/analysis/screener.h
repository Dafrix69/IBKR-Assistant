// screener.ts:扫描器——RS 强度、拐点筛选(CD 背离)、极值偏离。纯计算,输入是松的记录(股票池成员、K 线都是 OJson),
// 回执是 OJson,键序同 TS。
#pragma once

#include "util/error.h"
#include "util/ordered_json.h"

#include <QString>
#include <QStringList>

#include <optional>
#include <vector>

namespace ibkr::analysis::screener {

class ScreenerError : public util::JsError {
public:
    using util::JsError::JsError;
};

inline constexpr double kDefaultPivotStrength = 3;
inline constexpr double kDefaultMaxSpan = 60;
inline constexpr double kDefaultMaxAge = 12;
inline constexpr double kMinCdBars = 40;
inline constexpr double kDefaultDevPeriod = 20;
inline constexpr double kDefaultDevLookback = 120;
inline constexpr double kDefaultPressureSmooth = 5;
inline constexpr double kDefaultZExtreme = 2.0;
inline constexpr double kDefaultKeep = 120;
inline constexpr double kMinZSamples = 10;
inline constexpr double kVolumeWeightCap = 3.0;

const std::vector<double>& rsWindows();
const QStringList& rsBenchmarks();
QString untagged();

/// 日线 → 周线(周一为一周之始)
util::OJson resampleWeekly(const util::OJson* bars);
util::OJson rsStrength(const util::OJson& members, const util::OJson* benchBars, const QString& benchmark = QStringLiteral("SPY"),
                       const std::vector<double>& windows = rsWindows());
util::OJson cdDivergence(const util::OJson* bars, std::optional<double> maPeriod = std::nullopt, double strength = kDefaultPivotStrength,
                         double maxSpan = kDefaultMaxSpan, double maxAge = kDefaultMaxAge);
util::OJson screenInflections(const util::OJson& members, const QStringList& timeframes, std::optional<double> maPeriod = std::nullopt,
                              double strength = kDefaultPivotStrength);
util::OJson deviationReview(const util::OJson* bars, double period = kDefaultDevPeriod, double lookback = kDefaultDevLookback,
                            double smooth = kDefaultPressureSmooth, double zExtreme = kDefaultZExtreme, double keep = kDefaultKeep);

}  // namespace ibkr::analysis::screener
