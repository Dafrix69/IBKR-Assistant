// flyexit.ts:SPX 0DTE 多头蝶式止盈策略(v2.1:浮盈回撤追踪)——点位、预计盈利与逐分钟回放;Bachelier 定价与反解 σ。
// TS 那边的 profile / params / K 线都是松的记录(Rec),这里也收 OJson,按 JS 的读法取值:
//   · params 走 paramsFrom 出来,是 {键: 数 | 串 | null};flyExitSweep 之后还会改 stop,所以不收成结构;
//   · profile 由 tradereview.butterflyProfile 或 flyExitSweep 拼,字段都是数(debit 可以是 null);数值字段按 Number() 读。
//     **约定:center / width / debit 是数。** 它们是串时 TS 的 `k + ratio * w`、`d + profitPeak * …` 会拼成字符串("580011.25"、
//     「触发价 inf」),C++ 照数算——这是有意的差别,两个生产方都只给数,碰不到;
//   · K 线是 {time, close}。
#pragma once

#include "util/ordered_json.h"

#include <QString>

#include <optional>
#include <utility>
#include <vector>

namespace ibkr::analysis::flyexit {

/// flyexit.ts:41 的 CLOCK_KEYS:参数里取值是钟点的两个键
inline bool isClockKey(const QString& k) { return k == u"cutoff_a" || k == u"trail_late"; }

inline constexpr double kOpenMin = 9 * 60 + 30;
inline constexpr double kCloseMin = 16 * 60;
inline constexpr double kSigmaMin = 0.05;
inline constexpr double kSigmaMax = 400.0;
inline constexpr double kFlyArmUsd = 100;
inline constexpr double kFlyTightenUsd = 200;

/// 校准出来的日内方差分布(FLY_IV_MODEL.variance_weights)
const std::vector<double>& varianceWeights();
/// DEFAULTS(键序同 TS)
const util::OJson& defaults();
util::OJson paramsFrom(const util::OJson* raw);

double minutesOf(const QString& hhmm);
double remainingVariance(double minute);
double sigmaRemaining(double em, double minute);
double cutoffMinute(const util::OJson& params);
QString phaseAt(double minute, double width, const util::OJson& params);
double switchMinute(double width, const util::OJson& params);

double trailPct(double profitPeak, double d, double minute, const util::OJson& params);
double trailStop(double profitPeak, double d, double minute, const util::OJson& params);
/// [{above, pct}…]
util::OJson drawdownTiers(const util::OJson* raw);
/// {after, factor}
util::OJson drawdownLate(const util::OJson* raw);
double drawdownArm(const util::OJson* raw);
/// {tiers, arm} 或 null
util::OJson drawdownUsdPreset(std::optional<double> unitCostUsd, const util::OJson* raw);
double drawdownFloor(const util::OJson* raw);
QString fmtMinute(double minute);

double bachelierCall(double s, double k, double sigma);
double bachelierPut(double s, double k, double sigma);
double modelPrice(const util::OJson& profile, double s, double sigma);
double legValue(const QString& right, double s, double k, double sigma);
struct StructureLeg {
    double strike = 0;
    QString right;
    double ratio = 0;
};
double structureValue(const std::vector<StructureLeg>& legs, double s, double sigma);
std::optional<double> impliedSigmaLeg(double s, double k, double price, const QString& right);
std::optional<double> impliedSigmaFly(const util::OJson& profile, double s, double price);

std::pair<double, double> trancheSizes(double qty);
util::OJson levels(const util::OJson& profile, const util::OJson& params);
util::OJson zones(const util::OJson& profile, const util::OJson& params);

util::OJson simulate(const util::OJson& profile, const QString& entryBarTime, const util::OJson& spxBars, const util::OJson& flyBars,
                     const util::OJson& params, const util::OJson* actual = nullptr);
util::OJson plan(const util::OJson& profile, const QString& entryBarTime, const util::OJson& spxBars, const util::OJson& flyBars,
                 const util::OJson* rawParams, const util::OJson* actual = nullptr, const std::optional<QString>& emNote = std::nullopt);

}  // namespace ibkr::analysis::flyexit
