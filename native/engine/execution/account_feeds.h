// accountFeeds.ts 逐句搬:账户级的两样券商数据——当日盈亏(reqPnL)与净值(账户摘要)。只读。
// 两样都以美元计才给:基础货币不是 USD 时宁可不给,由调用方退回原来的口径。期望值:tests/fixtures/gen_account_feeds.mjs
//
// 与 TS 的对应:`accountPnl?.()` / `netLiquidation?.()` 是可选方法,会话没有就不调(按 Cap 判,替身缺方法时不留调用记录)。
#pragma once

#include "execution/ib_types.h"

#include <memory>
#include <optional>
#include <vector>

namespace ibkr::execution {

/// 盈亏多久没更新就不再当现在的数用(毫秒)
inline constexpr double kPnlStaleMs = 60'000;

using SessionList = std::vector<std::shared_ptr<IbSession>>;

/// 账户当日盈亏(美元,含已实现 + 未实现)。拿不到、太旧、不是美元:空
std::optional<double> accountDailyPnl(const SessionList& sessions, const QString& accountId, double nowMs);
/// 账户净值(美元)。拿不到、不是美元、不为正:空
std::optional<double> accountNetLiquidation(const SessionList& sessions, const QString& accountId);

}  // namespace ibkr::execution
