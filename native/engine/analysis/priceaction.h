// priceaction.ts:价格行为实时分析——摆动结构、收盘突破(BOS / CHoCH)、扫单、关键位、FVG、订单块、形态、打分与读盘文字。纯计算。
// K 线进来是松的记录(OJson 数组,toBars 按 Number() 读),分析结果是 OJson(键序同 TS 拼出来的那个,含 makeWarnings 半路塞进去的 age_seconds)。
// 周期表与最少根数用 domain::timeframes() / kMinBars(marketdata.ts)。
#pragma once

#include "util/error.h"
#include "util/ordered_json.h"
#include "util/tz.h"

#include <QString>

#include <functional>
#include <optional>
#include <vector>

namespace ibkr::analysis::priceaction {

class PriceActionError : public util::JsError {
public:
    using util::JsError::JsError;
};

inline constexpr double kSwingStrength = 2;
inline constexpr double kChartBars = 140;

struct PABar {
    QString time;
    double open = 0, high = 0, low = 0, close = 0, volume = 0;
};
using PABars = std::vector<PABar>;

struct Swing {
    double index = 0;
    QString time;
    double price = 0;
    QString kind;  // high / low
    QString label;
};

/// 调用方给的时刻,以及它对这组 K 线知道的三件事(取数时刻、行情档、有没有盘前盘后)
struct PaClock {
    double epochMs = 0;
    std::optional<double> barsAsOfMs;
    std::optional<QString> feed;  // live / delayed / unknown
    std::optional<bool> extendedSession;
};

PABars toBars(const util::OJson& rows);
double trueRange(const PABar& bar, const PABar* prev);
double atr(const PABars& bars, double period = 14);
std::vector<double> atrSeries(const PABars& bars, double period = 14);
std::optional<double> barCloseEpochMs(const QString& time, const QString& timeframe, bool extendedHours = false);
std::vector<Swing> findSwings(const PABars& bars, double strength = kSwingStrength);
std::vector<Swing> zigzag(const std::vector<Swing>& swings);
std::vector<Swing> labelSwings(const std::vector<Swing>& points);

struct StructureHistory {
    std::vector<Swing> points;
    QList<util::OJson> events, sweeps;
};
StructureHistory structureHistory(const PABars& bars, const std::function<double(qsizetype)>& tolAt, double strength = kSwingStrength,
                                  qsizetype keepEvents = 6, qsizetype sweepWindow = 40, qsizetype keepSweeps = 3);

util::OJson subScores(const util::OJson& evidence);
/// {bias, label}
std::pair<QString, QString> biasOf(double score);
util::OJson movingAverages(const PABars& bars, const std::vector<double>& periods = {5, 10, 20}, double count = kChartBars);

util::OJson analyze(const util::OJson& rows, const QString& symbol = QString(), const QString& timeframe = QString(), double strength = kSwingStrength,
                    const std::optional<PaClock>& now = std::nullopt, bool extendedHours = false);
QString factsText(const util::OJson& result);
util::OJson htfSummary(const util::OJson& result);
util::OJson agreement(const util::OJson& primary, const util::OJson* higher);

std::optional<double> barAgeSeconds(const QString& lastBar, std::optional<double> nowEpochMs);
std::optional<util::WallParts> parseBarTime(const QString& raw);

}  // namespace ibkr::analysis::priceaction
