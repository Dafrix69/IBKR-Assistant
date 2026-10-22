// autoMid.ts 逐句搬:AUTO_MID 按盘口价差的一份让价(limits.auto_mid_spread_share),纯函数。
// 符号约定与 broker.autoMidLimit 相同:正数 = 借方(付权利金),负数 = 贷方(收权利金)。期望值:tests/fixtures/gen_auto_mid.mjs
#pragma once

#include "execution/broker_pricing.h"

#include <optional>
#include <vector>

namespace ibkr::execution {

/// 立刻成交的净价:要买的腿按卖价、要卖的腿按买价,带符号;没有腿或坏盘口抛 BrokerError
double comboNaturalPrice(const std::vector<LegQuote>& legs);

/// 限价 = 中间价 + share ×(立刻成交的价 − 中间价),按跳动朝成交方向取整;借方不超过结构宽度,贷方必须仍为负数,
/// 腿方向与订单方向对不上时拒绝。strikeWidth 空 = TS 的 null
double autoMidShareLimit(const std::vector<LegQuote>& legs, const QString& action, double share,
                         std::optional<double> strikeWidth = std::nullopt, double tick = kDefaultComboTick);

}  // namespace ibkr::execution
