// 持仓追踪的几条出场规则(纯函数,engine-ts 的 trackerExits.ts、trackerDrawdown.ts、trackerSpotStop.ts 逐句搬):
// 到点平仓、分批止盈、止损类的追价节奏、标的 / 正股止损的确认秒数、利润回撤的三道闸、标的止损价。
// 这些都在钱路径上:平不平、平多少、什么时候平。Targets / AutoClose / 结论都是 JS 对象(OJson,键序同 TS 的展开写法)。
#pragma once

#include "util/ordered_json.h"

#include <QString>

#include <optional>
#include <utility>

namespace ibkr::analysis {

inline const QString kStateTimeExit = QStringLiteral("time_exit");

// ---- 到点平仓
std::optional<double> clockMinutes(const util::OJson* hhmm);
std::optional<double> nextOccurrenceMs(const util::OJson* hhmm, double nowMs);
bool timeExitDue(const util::OJson& targets, double nowMs);
bool timeExitLapsed(const util::OJson& targets, double nowMs);
/// {...result, state: time_exit, reason}(只在这一轮没有别的触发时)
util::OJson withTimeExit(const util::OJson& result, const util::OJson& targets, double nowMs, const QString& holding = QStringLiteral("holding"));

// ---- 分批止盈
inline constexpr int kMaxTpTiers = 4;
extern const QString kTiersHostedIssue;
std::optional<QString> tiersIssue(const util::OJson* tiers, bool isLong, const util::OJson* price);
int dueTier(const util::OJson* tiers, bool isLong, const util::OJson* price);
/// 档位一档没变时把 done 带过去;next 是 null 回空
std::optional<util::OJson> carryTierMarks(const util::OJson* next, const util::OJson* prev);
int pendingTier(const util::OJson* tiers);
util::OJson markTier(const util::OJson& tiers, int index, const util::OJson& patch);
util::OJson withTier(const util::OJson& result, const util::OJson& targets, bool isLong, const QString& holding = QStringLiteral("holding"),
                     const QString& takeProfit = QStringLiteral("take_profit"));

// ---- 追价节奏
inline constexpr int kChaseGraceRounds = 2;
inline constexpr int kChaseStepTicks = 1;
struct ChaseProfile {
    double grace, step, maxPct;
};
bool isStopReason(const util::OJson* reason);
ChaseProfile chaseProfile(const util::OJson& autoClose, const util::OJson* reason = nullptr);

// ---- 止损的确认秒数
struct BreachClock {
    QString side;  // below / above
    double sinceMs = 0;
};
std::pair<util::OJson, std::optional<BreachClock>> confirmStockStop(const util::OJson& result, bool isLong, const util::OJson* confirmS,
                                                                    const std::optional<BreachClock>& clock, double nowMs);
std::pair<util::OJson, std::optional<BreachClock>> confirmSpotStop(const util::OJson& row, const util::OJson* confirmS, const std::optional<BreachClock>& clock,
                                                                   double nowMs);

// ---- 利润回撤(trackerDrawdown.ts)
std::optional<double> drawdownThreshold(const util::OJson& targets, const util::OJson* profitPeak, const util::OJson* basis, const util::OJson* minute = nullptr);
bool drawdownArmed(const util::OJson& targets, const util::OJson* profitPeak, const util::OJson* basis);
bool drawdownFloorMet(const util::OJson& targets, const util::OJson* peakPrice, const util::OJson* price);

// ---- 标的止损价(trackerSpotStop.ts)
bool hasSpotStop(const util::OJson& targets);
/// 没设是空;{below, above, spot, spot_note, hit, reason}
std::optional<util::OJson> spotStop(const util::OJson& targets, const QString& symbol, const util::OJson* spot, const QString& spotNote = {});
std::optional<QString> spotStopIssue(const util::OJson& targets, const QString& secType, const QString& symbol, const util::OJson* spot);

}  // namespace ibkr::analysis
