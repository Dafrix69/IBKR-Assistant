// leaders.ts:强势股筛选——Minervini 趋势模板 8 条、VCP 波动收缩、IBD 式 RS 评级、大盘方向(派发日)、今天新进第二阶段的。纯计算。
// 券商日线是松的记录(OJson 数组,字段都可能缺、可能是串);结果(LeaderRow、VcpResult、MarketRegime、LeadersResult)按 TS 的键序拼成 OJson。
#pragma once

#include "util/ordered_json.h"

#include <QList>
#include <QString>
#include <QStringList>

#include <optional>
#include <vector>

namespace ibkr::analysis::leaders {

inline constexpr int kMonthBars = 22;
inline constexpr int kYearBars = 252;
inline constexpr double kAboveLowPct = 30;
inline constexpr double kNearHighPct = 25;
inline constexpr double kMinRsRating = 70;
inline constexpr double kMinRatingUniverse = 10;
inline constexpr int kVcpLookback = 130;
inline constexpr int kSwingStrength = 3;
inline constexpr double kMinLegPct = 1.5;
inline constexpr double kBreakoutVolume = 1.4;
inline constexpr double kNewHighVolume = 1.5;
inline constexpr double kDistDrop = 0.002;
inline constexpr int kDistWindow = 25;
inline constexpr double kDistRecovery = 0.05;

struct Bar {
    QString time;
    double high = 0, low = 0, close = 0, volume = 0;
};

struct LeaderMember {
    QString symbol;
    std::optional<QString> tag, company;
    util::OJson bars;                   // 数组
    std::optional<util::OJson> error;   // 空 = undefined
};

/// bars 是数组(元素是 null 时同 TS 抛 TypeError)
std::vector<Bar> cleanDaily(const util::OJson& bars);
std::optional<double> smaAt(const std::vector<double>& values, double n, std::optional<double> end = std::nullopt);
std::optional<double> rsScore(const std::vector<double>& closes);
std::vector<std::optional<double>> ratings(const std::vector<std::optional<double>>& scores);

struct TrendInputs {
    double close = 0;
    std::optional<double> ma50, ma150, ma200, ma200Months;
    double high52 = 0, low52 = 0;
    bool fullYear = false;
    std::optional<double> rsRating, rsVsBench;
    double universe = 0;
};
util::OJson trendTemplate(const TrendInputs& t);

struct Contractions {
    std::vector<double> peaks, depths;
};
Contractions contractions(const std::vector<Bar>& bars, double start);
util::OJson detectVcp(const std::vector<Bar>& bars);
QStringList distributionDays(const std::vector<Bar>& bars);
util::OJson marketRegime(const QString& symbol, const util::OJson& raw);

util::OJson screenLeaders(const QList<LeaderMember>& members, const util::OJson& benchBars, const QString& benchmark);
/// {day, rows};rows 是今天这一遍 screenLeaders 的 rows
util::OJson newStage2(const QList<LeaderMember>& members, const util::OJson& benchBars, const QString& benchmark, const QList<util::OJson>& rows);

}  // namespace ibkr::analysis::leaders
