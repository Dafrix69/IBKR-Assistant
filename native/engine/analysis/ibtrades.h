// ibtrades.ts:券商成交明细 → 交易记录(逐腿成交按订单合成一张 1:2:1 蝴蝶)。纯函数。
// 成交行与账户都是松的记录(Rec),收 OJson;行本身是 null 时 TS 的 fill["contract"] 抛 TypeError,这里也抛。期望值:tests/fixtures/gen_ibtrades.mjs
#pragma once

#include "util/ordered_json.h"

#include <QList>
#include <QString>

namespace ibkr::analysis::ibtrades {

inline constexpr char16_t kFillSource[] = u"ibkr";

QString fmtExpiry(const util::OJson* raw);
/// 同一订单的成交行共用 permId;拿不到退到 orderId,再退到 execId("p…" / "o…" / "e…")
QString groupKey(const util::OJson& fill);
/// 成交行(router.executions() / store.listFills() 的形状)→ 蝴蝶交易记录,按 created_at、id 升序
QList<util::OJson> groupButterflies(const QList<util::OJson>& fills, const QList<util::OJson>& accounts = {});

}  // namespace ibkr::analysis::ibtrades
