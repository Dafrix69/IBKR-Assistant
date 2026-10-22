// 蝴蝶测算的 IV 模型(engine-ts 的 flyCalibration.ts 逐句搬)、校准出来的那一份参数(flyIvModel.ts)、IB 模型 IV 的定价输入(ivPricing.ts)。
// 纯计算:K 线 → 日内方差分布、IV 对走势的反应(最小二乘)、残差宽度;自己攒的当日到期期权 IV 的那一路(fitFromSamples)。
// Math.log / exp 一律走 util::jsmath(V8 的那一份),和 TS 逐位一致。
#pragma once

#include "util/ordered_json.h"

#include <QHash>
#include <QList>
#include <QString>
#include <QStringList>

#include <functional>
#include <map>
#include <optional>
#include <vector>

namespace ibkr::analysis {

struct Bar {
    double sec = 0, open = 0, close = 0;
};
struct MinuteBar : Bar {
    double minute = 0;
};

inline constexpr double kOpenMinute = 9 * 60 + 30;
inline constexpr double kCloseMinute = 16 * 60;
inline constexpr int kHours = 7;
inline constexpr int kHalfHours = 13;
inline constexpr double kUMax = 4;
inline constexpr double kQuartile = 0.6745;

struct Response {
    double a = 0, b = 0, c = 0;
};
struct ResidMove {
    double base = 0, slope = 0;
};
struct Span {
    QString from, to;
    double days = 0;
};

struct OwnFit {
    QString periodFrom, periodTo;
    double days = 0, rows = 0;
    Response response;
    std::vector<double> drift;
    double resid_k = 0;
    ResidMove resid_move;
    double r2_in = 0, r2_out = 0, r2_out_index = 0, coverage_half = 0;
    util::OJson toJson() const;
};

struct FlyIvModel {
    QString version, source, proxy, periodFrom, periodTo;
    double days = 0;
    std::vector<double> variance_weights;
    double realized_to_implied = 0;
    Response response;
    std::optional<Response> response_long;
    double response_long_days = 0;
    double resid_k = 0;
    ResidMove resid_move;
    std::optional<OwnFit> own;
    double fit_rows = 0, r2_in = 0, r2_out = 0, r2_out_flat = 0, coverage_half = 0;
    Span train, test;
    util::OJson toJson() const;
    static FlyIvModel fromJson(const util::OJson& j);
};

/// flyIvModel.ts 的 FLY_IV_MODEL(脚本生成的那一份,原样)
const FlyIvModel& flyIvModel();
const util::OJson& flyIvModelJson();

/// 常规时段里的 K 线按美东日期分开(日期按第一次出现的先后),每天按时间排好
std::vector<std::pair<QString, std::vector<MinuteBar>>> sessions(const std::vector<Bar>& bars);
std::optional<std::vector<double>> gridOf(const std::vector<MinuteBar>* day, double stepMinutes);

struct ScaledDay {
    QString date;
    std::vector<double> minutes, grid;
    double level = 0;
};
std::vector<double> varianceShares(const std::vector<ScaledDay>& days, int buckets, double bucketMinutes);
std::vector<double> halfHourWeights(const std::vector<double>& hourly, const std::vector<double>& fine);
double remainingShare(const std::vector<double>& weights, double minute);

struct ResponseRow {
    QString date;
    double u = 0, y = 0, share = 0;
};
double predict(const Response& beta, double u);
Response fitResponse(const std::vector<ResponseRow>& rows);
double residualSd(double residK, const ResidMove& move, double share, double u);
double rSquared(const std::vector<ResponseRow>& rows, const std::optional<Response>& beta);

struct CalibrationInput {
    std::vector<Bar> priceHourly, priceFine;
    std::optional<std::vector<double>> fineShares;
    std::vector<Bar> ivHourly;
    std::optional<std::vector<Bar>> ivLongHourly;
    std::optional<double> ivLongDays;
    QString source, proxy, version;
    std::optional<double> trainShare;
};
FlyIvModel calibrate(const CalibrationInput& input);

struct OwnLeg {
    double strike = 0;
    QString right;
    std::optional<double> iv;
};
struct OwnSample {
    double t = 0, spot = 0;
    QString expiry;
    std::vector<OwnLeg> legs;
};
inline constexpr double kOwnGridStart = 10 * 60;
inline constexpr int kOwnGridPoints = 12;
inline constexpr int kOwnMinDays = 40;
OwnFit fitFromSamples(const std::vector<OwnSample>& samples, const std::vector<double>& varianceWeights, const Response& indexResponse);
bool ownIsBetter(const OwnFit& own);
double ownDriftAt(const std::vector<double>& drift, double minute);

// ---- ivPricing.ts
std::optional<double> expiryEpochMs(const QString& symbol, const QString& expiry, const QString& tradingClass, bool earlyClose = false);
struct PricedLeg {
    double strike = 0;
    QString right;
};
/// 每条腿的点数 σ:JS 对象 {keyOf(腿): σ}(键序照 JS);缺一条腿的 IV 回 null
util::OJson ibkrLegSigmas(const std::vector<PricedLeg>& legs, double spot, const util::OJson& legIvs,
                          std::optional<double> expiryMs, double nowMs, const std::function<QString(const PricedLeg&)>& keyOf);
/// {legPrices, legIvs, expiryMs}
util::OJson legInputsOf(const util::OJson& rawRow, const util::OJson& positionRows, const std::function<QString(const PricedLeg&)>& keyOf,
                        const std::function<bool(const QString&)>& isEarlyClose = {});

}  // namespace ibkr::analysis
