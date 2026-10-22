// anomaly.ts:优质股异动检测——触发条件的校验、日内成交量曲线与方差曲线、样本序列、档位 / 滞回状态、一只股一轮的判定。纯计算,不读时钟。
// 量价快照(VolumeSnapshot,TS 在 marketdata.ts)还没有别处搬,这里先定义:字段与 TS 一样全是可缺 / 可为 null(空 = 两者)。
// 状态从库里读回(任意 JSON,coerceState 纠正类型),所以 evaluateAnomalies 收 OJson;回包(事件、状态、指标)按 TS 的键序拼成 OJson。
#pragma once

#include "util/error.h"
#include "util/ordered_json.h"

#include <QString>

#include <optional>
#include <vector>

namespace ibkr::analysis::anomaly {

class AnomalyError : public util::JsError {
public:
    using util::JsError::JsError;
};

/// AnomalyConfig(键序同 DEFAULT_ANOMALY_CONFIG)
struct Config {
    std::vector<double> rvol_tiers;
    double burst_ratio = 0, window_min = 0, spike_sigma = 0, spike_min_pct = 0, spike_fixed_pct = 0;
    std::vector<double> day_sigma_tiers, day_fixed_tiers;
    double cooldown_min = 0;
    bool market_adjust = false;
    util::OJson toJson() const;
};
const Config& defaultConfig();
/// raw 是界面 / 库里来的任意 JSON(空指针 = undefined);不合规抛 AnomalyError
Config normalizeAnomalyConfig(const util::OJson* raw, const Config& base = defaultConfig());

inline constexpr double kRthMinutes = 390;
inline constexpr double kVolumeEndMinute = 385;
inline constexpr double kRvolMinMinute = 15;
inline constexpr double kBurstMinMinute = 6;
inline constexpr double kSpikeMinMinute = 15;
inline constexpr double kMinBurstSteps = 4;
const std::vector<double>& slotFractions();

double cumVolumeFraction(double minute, std::optional<double> sessionMinutes = std::nullopt);
double varianceShare(double fromMinute, double toMinute);

/// t = epoch ms
struct Sample {
    double t = 0;
    std::optional<double> volume, last;
    util::OJson toJson() const;
};
/// s 空 = null / undefined;keepMs 空 = 默认 20 分钟(不是有限非负数也用默认)
std::vector<Sample> pushSample(const std::vector<Sample>& samples, const std::optional<Sample>& s, std::optional<double> keepMs = std::nullopt);
std::optional<double> windowReturnPct(const std::vector<Sample>& samples, double nowMs, double windowMin);

/// 量价快照(marketdata.ts 的 VolumeSnapshot)
struct VolumeSnapshot {
    std::optional<double> last, close, open, high, low, volume, avg_volume, hist_vol, vol_3m, vol_5m, vol_10m;
    std::optional<bool> delayed;
    std::optional<double> last_trade_at;
};

struct SignalArm {
    bool armed = true;
    std::optional<double> last_fired_at;
};
struct State {
    QString date;
    double rvol_fired = 0, day_up_fired = 0, day_down_fired = 0, max_step_share = 0;
    SignalArm burst, spike;
    util::OJson toJson() const;
};
State freshState(const QString& date);
/// 从库里读回的任意 JSON(或 JSON 串)恢复状态,不抛
State coerceState(const util::OJson* raw, const QString& date);

struct MarketMove {
    std::optional<double> change_pct, ret_window_pct;
};
struct EvalArgs {
    QString symbol;
    std::optional<VolumeSnapshot> snap;  // 空 = null
    std::vector<Sample> samples;
    const util::OJson* state = nullptr;  // 空 / null = 没有
    double nowMs = 0;
    QString etDate;
    double minute = 0;
    std::optional<double> sessionMinutes;
    Config config;
    bool suppress = false;
    std::optional<MarketMove> market;
    std::optional<bool> opened;
};
/// {events, state, metrics}
util::OJson evaluateAnomalies(const EvalArgs& args);

}  // namespace ibkr::analysis::anomaly
