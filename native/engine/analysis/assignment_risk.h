// assignmentRisk.ts:到期日的空头期权腿在不在实值里(实物交割的个股、ETF 期权持到收盘会被指派)。纯函数。
// 持仓行是 PositionRow(OJson);腿与通知也是 JS 对象(键序同 TS 的对象字面量,通知里的腿是 {...leg, itm_by})。
// **约定:腿的 quantity / multiplier / strike 是数,right 是 "C" / "P"**(expiringOptionLegs 出来的就是这样)。
#pragma once

#include "util/ordered_json.h"

#include <QList>
#include <QString>

#include <functional>

namespace ibkr::analysis::assignment_risk {

/// rows 里 row.contract 缺了时同 TS 抛 TypeError;isCashSettled 收 row.symbol 的原值
QList<util::OJson> expiringOptionLegs(const QList<util::OJson>& rows, const QString& today, const std::function<bool(const util::OJson*)>& isCashSettled);
double itmBy(const util::OJson& leg, double spot);
/// spots:代码 → 现价(JS 对象)
QList<util::OJson> assignmentNotices(const QList<util::OJson>& legs, const util::OJson& spots);
QString noticeText(const util::OJson& notice);

}  // namespace ibkr::analysis::assignment_risk
