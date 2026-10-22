// flyPlan.ts:蝴蝶测算——按此刻的现价与各腿 IV,估「标的在某个时刻走到某个点位」时这只蝶值多少、赚多少。只算不下单。
#pragma once

#include "analysis/fly_model.h"
#include "util/error.h"
#include "util/ordered_json.h"

#include <QString>
#include <QStringList>

#include <functional>
#include <map>
#include <optional>
#include <vector>

namespace ibkr::analysis::flyplan {

/// TS 的 FlyPlanError:handler 把它的话原样交给界面
class FlyPlanError : public util::JsError {
public:
    using util::JsError::JsError;
};

inline constexpr double kIvFactorMax = 3;
const std::vector<double>& scenarioSteps();

struct PlanCalendar {
    std::function<bool(const QString&)> isTradingDay;
    std::function<bool(const QString&)> isEarlyClose;
};
struct ScheduleArgs {
    QString symbol, tradingClass, targetTime;
    std::optional<QString> targetDate, expiry;
    double nowMs = 0;
};
struct PlanSchedule {
    QString targetDate;
    double targetMs = 0;
    QString expiry;
    double expiryMs = 0;
    std::vector<double> timelineMs;
    QStringList warnings;
};
PlanSchedule planSchedule(const ScheduleArgs& args, const PlanCalendar& calendar);

struct LegMark {
    std::optional<double> bid, ask, iv;
};
struct FlyPlanInput {
    QString symbol, expiry, tradingClass, right;  // right: C / P
    double center = 0, width = 0, quantity = 0, multiplier = 0, spot = 0;
    QString spotSource, spotNote;
    double nowMs = 0, expiryMs = 0, targetMs = 0, targetSpot = 0;
    std::map<QString, LegMark> marks;  // 按 markKey(行权价)
    std::optional<double> cost, ivInput;
    QString ivMode;  // auto / flat / shift
    std::optional<double> ivShiftPct;
    std::vector<double> timelineMs;
    std::optional<QStringList> warnings;
    std::optional<FlyIvModel> model;
};

QString markKey(double strike);
bool sameSession(double nowMs, double expiryMs);
double seasonalFactor(const FlyIvModel& model, double nowMs, double atMs, double expiryMs);
double ivResponse(const FlyIvModel& model, double u, double daysToExpiry, bool sameDay = false);
/// FlyPlanResult(键序同 TS)
util::OJson planFly(const FlyPlanInput& input);

}  // namespace ibkr::analysis::flyplan
