// openRisk.ts:账户在手的期权敞口——每个账户的最坏亏损合计(同一账户 + 标的 + 到期的腿放一起,算到期那一刻 0、各行权价、往上无穷远处的盈亏)、
// 每个「账户 + 标的 + 到期」的张数(认得出的标准组合按组数)。纯函数。持仓行是券商回包的原样(OJson),字段按 TS 的读法取。
#pragma once

#include "util/ordered_json.h"

#include <QString>

#include <vector>

namespace ibkr::analysis::open_risk {

QString contractsKey(const QString& account, const QString& symbol, const QString& expiry);

struct Leg {
    double qty = 0, mult = 0, strike = 0;
    bool call = false;
    double cost = 0;
};
struct Worst {
    double usd = 0, unbounded = 0;
};
Worst worstCaseAtExpiry(const std::vector<Leg>& legs);

/// {riskUsd, contracts, notes}
util::OJson openRisk(const QList<util::OJson>& rows);

}  // namespace ibkr::analysis::open_risk
