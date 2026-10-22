// 校验与保护规则要从库里现算的几样(engine-ts/src/riskQueries.ts 逐句搬):最近提交过的订单(重复单防抖)、在途的指令单、
// 日内亏损上限的记号、最近的平仓、已实现盈亏。只读。返回的行是 JS 对象(字段与先后同 TS 的对象字面量)。
#pragma once

#include "util/ordered_json.h"
#include "util/sqlite.h"

namespace ibkr::domain {

class RiskQueries {
public:
    explicit RiskQueries(util::sqlite::Database& db) : db_(db) {}
    /// {signature, quantity, createdAtMs, limitPrice, finalStatus}
    QList<util::OJson> recentOrderDetails(double windowMinutes, double nowMs);
    /// {alias, contract, order, notional}
    QList<util::OJson> workingOrders(double sinceMs, double nowMs);
    /// {alias, reason, untilMs}
    QList<util::OJson> dailyLossTrips(double sinceMs, double nowMs);
    /// {signature, quantity, createdAtMs}
    QList<util::OJson> recentOrders(double windowMinutes, double nowMs);
    /// {atMs, symbol, state, leg}
    QList<util::OJson> recentCloses(double sinceMs, double nowMs);
    /// {atMs, pnl}
    QList<util::OJson> realizedPnlEvents(double sinceMs, double nowMs);

private:
    util::sqlite::Database& db_;
};

}  // namespace ibkr::domain
