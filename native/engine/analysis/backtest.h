// backtest.ts:策略回测(日线、收盘出信号、下一根开盘成交、全仓进出),期权品种按 Black-Scholes(r=0)理论价模拟。纯计算。
// 日线是结构(券商适配层给的就是 date / open / high / low / close 都齐的形状);参数、自定义条件、品种是松的记录(OJson),
// 按 JS 的读法取值:`key in STRATEGIES` / `key in merged` 对 Object.prototype 上的名字也成立,照原样。
// 回执是 OJson,键序同 TS 拼出来的那个。数组里的 null 用 std::optional。
#pragma once

#include "util/error.h"
#include "util/ordered_json.h"

#include <QString>

#include <optional>
#include <vector>

namespace ibkr::analysis::backtest {

class BacktestError : public util::JsError {
public:
    using util::JsError::JsError;
};

struct Bar {
    QString date;  // YYYY-MM-DD
    double open = 0, high = 0, low = 0, close = 0;
};
using Bars = std::vector<Bar>;
/// Array<number | null>
using Series = std::vector<std::optional<double>>;

inline constexpr double kMaxParam = 250;
inline constexpr double kMaxCostPct = 10;
inline constexpr double kTradingDays = 252;
inline constexpr int kVolWindow = 20;
inline constexpr double kMinOptionTick = 0.01;

/// STRATEGIES(键序同 TS)
const util::OJson& strategies();
/// OPTION_TYPES
const util::OJson& optionTypes();
/// Object.prototype 上的名字(`k in 对象字面量` 对它们也成立)
bool onObjectPrototype(const QString& k);

util::OJson runBacktest(const Bars& bars, const QString& strategy, const util::OJson* params = nullptr, const util::OJson* rules = nullptr,
                        const util::OJson* instrument = nullptr, double costPct = 0);
std::vector<double> heldAfterOpen(const std::vector<double>& signal);

struct SegmentInput {
    const Bars* bars = nullptr;
    const std::vector<double>* held = nullptr;
    QString strategy;
    util::OJson params;
    /// type 要已经补齐
    util::OJson inst;
    std::optional<double> costPct;
    std::optional<double> lo, hi;
    const Series* vol = nullptr;
    const Series* sessionShare = nullptr;
};
util::OJson evaluateSegment(const SegmentInput& seg);

struct Signal {
    std::vector<double> positions;
    util::OJson usedParams;  // Record<string, number>
};
Signal signalPositions(const Bars& bars, const QString& strategy, const util::OJson* params, const util::OJson* rules);

Series macdHist(const std::vector<double>& closes);
Series ema(const std::vector<double>& values, double window);
Series sma(const std::vector<double>& values, double window);
Series rsi(const std::vector<double>& closes, double period);

double strikeStep(double price);
double bsPrice(double s, double k, double t, double sigma, const QString& right);
Series trailingVol(const std::vector<double>& closes, int window = kVolWindow);
Series trailingSessionShare(const Bars& bars, int window = kVolWindow);
double realizedVol(const std::vector<double>& closes, int window = 20);
/// @stdlib/math-base-special-erf
double erf(double x);

}  // namespace ibkr::analysis::backtest
