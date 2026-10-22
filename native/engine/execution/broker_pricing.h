// broker.ts 的纯定价那一小段(LegQuote / legMid / comboMidPrice / 最小跳动对齐 / BrokerError),逐句搬。
// 先放在 execsupport 簇里,因为 autoMid.ts 要它们;BrokerRouter 的其余部分(autoMidLimit、qualify、下单……)在 broker.h / broker*.cpp(broker 簇),
// 这个文件由 broker 簇接手(留在原处,免得改 execsupport 的 cmake 片段)。期望值:tests/fixtures/gen_auto_mid.mjs(原模块现跑)。
#pragma once

#include "util/error.h"

#include <QString>

#include <vector>

namespace ibkr::execution {

/// TS 的 `class BrokerError extends Error {}`
class BrokerError : public util::JsError {
public:
    using util::JsError::JsError;
};

struct LegQuote {
    QString action;  // BUY / SELL
    double ratio = 0, bid = 0, ask = 0;
};

/// 组合净价的最小跳动(broker.DEFAULT_COMBO_TICK)
inline constexpr double kDefaultComboTick = 0.05;

/// broker.ts 的 pyNum:NaN → "nan",整数 → "N.0",无穷 → "inf" / "-inf",别的同 String(v)
QString pyNum(double v);
/// 一条腿的中间价;坏盘口(缺一边、倒挂、非有限)抛 BrokerError
double legMid(const LegQuote& leg);
/// 价差净价 = Σ(买腿中间价) − Σ(卖腿中间价),四位小数;没有腿抛 BrokerError
double comboMidPrice(const std::vector<LegQuote>& legs);
/// 向上 / 向下对齐到最小跳动的整数倍(value / tick 非有限时原样返回)
double alignTickUp(double value, double tick = kDefaultComboTick);
double alignTickDown(double value, double tick = kDefaultComboTick);

}  // namespace ibkr::execution
