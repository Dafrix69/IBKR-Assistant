// stockreview.ts:股票交易复盘——券商逐笔成交 → "从空仓到空仓"的一段持仓(一笔交易)→ 进出场位置、持有期浮盈浮亏、
// 平仓后走势与规则化结论。时间与 K 线定位用 tradereview 的那一套。纯函数。
// 成交行 / 账户 / 持仓表是松的记录,收 OJson。**约定:reviewStock 收的 trip 是 groupStockTrips 切出来的**(entries / exits 是数组、
// 数值字段是数);entries / exits 不是数组时 TS 在 tripStart 抛 "(trip.entries ?? []) is not iterable",这里一样抛
// (字符串在 TS 里能展开成字符,这里也当不可迭代——生产方给不出字符串)。期望值:tests/fixtures/gen_stockreview.mjs
#pragma once

#include "util/ordered_json.h"

#include <QList>
#include <QString>

#include <utility>

namespace ibkr::analysis::stockreview {

inline constexpr qsizetype kMinSessions = 5;
inline constexpr qsizetype kPadSessions = 1;
inline constexpr char16_t kTripPrefix[] = u"stk:";
inline constexpr char16_t kKindClosed[] = u"closed";
inline constexpr char16_t kKindOpen[] = u"open";

/// 股票复盘图的窗口(按交易日算,前后各多一个交易日,不足 5 个交易日往前补;不比 40 / 20 根窄)
std::pair<qsizetype, qsizetype> stockWindow(const QList<util::OJson>& bars, qsizetype startIdx, qsizetype endIdx);
QString holdingKey(const util::OJson* accountId, const util::OJson* symbol);
/// holdings:{`${account_id}|${SYMBOL}`: 当前持仓股数};空指针 = 不知道(TS 的 null)
QList<util::OJson> groupStockTrips(const QList<util::OJson>& fills, const QList<util::OJson>& accounts = {}, const util::OJson* holdings = nullptr);
/// 抛 tradereview::ReviewError(没有可用的成交时间)
double tripStart(const util::OJson& trip);
util::OJson reviewStock(const util::OJson& trip, const QList<util::OJson>& bars, const QString& timeframe, double now);
util::OJson buildStockFindings(const util::OJson& profile, const util::OJson& entry, const util::OJson& outcome, const util::OJson& stats);

}  // namespace ibkr::analysis::stockreview
