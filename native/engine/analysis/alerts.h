// alerts.ts:价位提醒——自动步长与整数关口、期权墙 / 均线 / 52 周高低点的价位、去重合并、穿越状态机(含 1 分钟收盘确认)、
// 取价的接续、现价走出关口时换关口、给人看的清单。纯计算。
// 期权墙与日线是松的记录(OJson);价位收成结构(AlertLevel);报警状态是从库里读回来的任意 JSON(老库里的、缺字段的、
// 多出字段的都照 TS 的读法原样带着走),留成 OJson——报出来的事件也是 OJson(键序同 TS)。
#pragma once

#include "util/error.h"
#include "util/ordered_json.h"

#include <QString>
#include <QStringList>

#include <optional>
#include <utility>
#include <vector>

namespace ibkr::analysis::alerts {

inline constexpr double kAutoStep = 0;
inline constexpr double kDefaultMergePct = 0.15;
inline constexpr double kDefaultBandPct = 0.3;
inline constexpr double kDefaultCooldown = 300.0;
inline constexpr double kMaxLevels = 24;
inline constexpr double kExtremeWindow = 250;  // 52 周 ≈ 250 个交易日
inline constexpr double kMinExtremeBars = 20;  // 历史太短时高低点没意义,干脆不给
const std::vector<double>& defaultMaPeriods();

class AlertError : public util::JsError {
public:
    using util::JsError::JsError;
};

struct MaRef {
    double period = 0, prior_sum = 0;
};
/// AlertLevel / WatchLevel:priority 只有计算过程里的价位才有(合并时用的可信度);ma 只有均线有
struct AlertLevel {
    double price = 0;
    QString label, source, kind;
    std::optional<double> priority;
    std::optional<MaRef> ma;
    /// levelDict(l):price, label, source, kind, (ma)
    util::OJson dict() const;
    /// {...levelDict(l), priority}(没有 priority 的不写)
    util::OJson toJson() const;
    static AlertLevel fromJson(const util::OJson& o);
};

double autoStep(double spot, double bandPct = kDefaultBandPct);
std::vector<double> roundLevels(double spot, double step);

/// bars 是数组或 null(空指针 = undefined);today 空 = 整个序列都是完整日线
std::vector<AlertLevel> trendLevels(const util::OJson* bars, double spot, const std::vector<double>& maPeriods = defaultMaPeriods(),
                                    double extremeWindow = kExtremeWindow, const std::optional<QString>& today = std::nullopt);
/// TrendSnapshot 或 null
util::OJson trendSnapshot(const util::OJson* bars, double spot, const std::vector<double>& maPeriods = defaultMaPeriods(),
                          double extremeWindow = kExtremeWindow, const std::optional<QString>& today = std::nullopt);
std::vector<AlertLevel> buildLevels(double spot, const util::OJson* wall = nullptr, double step = kAutoStep, double mergePct = kDefaultMergePct,
                                    double maxLevels = kMaxLevels, const util::OJson* history = nullptr, const std::optional<QString>& today = std::nullopt);

double levelPriceAt(const AlertLevel& level, double price);
QString levelKey(const AlertLevel& level);

struct PriceSample {
    double at = 0, price = 0;
    QString session;
    std::optional<double> tradedAt;
    bool settled = false;
    /// {at, price, session, tradedAt, settled}
    util::OJson toJson() const;
};
struct Linked {
    PriceSample sample;
    std::optional<double> prevPrice;
};
/// quote 的 settled 不看
Linked linkSample(const std::optional<PriceSample>& prev, const PriceSample& quote, double maxGap = kDefaultCooldown);

/// [事件, 新的状态表];states 是 {键: LevelState}(任意 JSON),confirm 是 "immediate" / "bar_close"
std::pair<QList<util::OJson>, util::OJson> evaluate(const std::vector<AlertLevel>& levels, const util::OJson& states, std::optional<double> prevPrice,
                                                    double price, double nowTs, double bandPct = kDefaultBandPct, double cooldown = kDefaultCooldown,
                                                    const QString& confirm = QStringLiteral("immediate"));

std::optional<std::vector<AlertLevel>> reroundLevels(const std::vector<AlertLevel>& levels, double price, double step, double mergePct = kDefaultMergePct);
QStringList describe(const std::vector<AlertLevel>& levels, double spot);

}  // namespace ibkr::analysis::alerts
