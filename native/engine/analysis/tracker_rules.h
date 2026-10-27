// 持仓追踪的几条出场规则(纯函数,engine-ts 的 trackerExits.ts、trackerDrawdown.ts、trackerSpotStop.ts 逐句搬):
// 到点平仓、分批止盈、止损类的追价节奏、标的 / 正股止损的确认秒数、利润回撤的三道闸、标的止损价。
// 这些都在钱路径上:平不平、平多少、什么时候平。Targets / AutoClose / 结论都是 JS 对象(OJson,键序同 TS 的展开写法)。
#pragma once

#include "util/ordered_json.h"

#include <QList>
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

// ---- 按跌速多让(C++ 先有,TS 版没有;docs/features/tracker.md「快速下跌的追价」)
/// 追价那一路自己看到的一笔立刻成交价与看到它的本地时刻(orchestrate/fast_exit 记,只在内存里)
struct NaturalObs {
    double atMs = 0;
    double natural = 0;
};
/// 没填时用的值(auto_close.chase_lead / chase_interval_s)。倍数 1 不是拟合出来的数:就是"下一次能改价之前,价照刚才那样再走一段"。
/// 0 = 不多让。间隔 1 秒 = 节拍器本来的节奏。两样都是用户可改的设置
inline constexpr double kChaseLeadDefault = 1;
inline constexpr double kChaseIntervalSDefault = 1;
/// 没填倍数时用的值:生产就是 kChaseLeadDefault。对着 TS 夹具逐字比的测试(TS 版没有这一项)换成 0;生产代码不调 set*ForTests
double chaseLeadDefault();
void setChaseLeadDefaultForTests(std::optional<double> value);
/// 追价改单的最短间隔(毫秒):auto_close.chase_interval_s,没填按 1 秒。也是按跌速多让的窗口
double chaseIntervalMs(const util::OJson& autoClose);
/// 立刻成交价正朝不利方向走时多让多少(点,≥ 0):倍数 ×(一个间隔之前或更早的最后一笔 − 此刻的)。多头不利 = 往下,空头 = 往上;
/// 历史不够一个间隔拿最早那一笔;没在往不利方向走、观察不到两笔、倍数或窗口非正,回 0
double momentumLead(const QList<NaturalObs>& obs, bool isLong, double horizonMs, double mult, double nowMs);

// 急跌保护:窗口内从最有利的有效平仓报价向不利方向移动多少。空头对称看急涨。
inline const QString kStateRapidExit = QStringLiteral("rapid_exit");
std::optional<util::OJson> rapidExitMove(const QList<NaturalObs>& obs, bool isLong, double windowMs, double thresholdPct, double nowMs);

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
