// engine/closing.ts 逐句搬:一笔解析出来的订单是不是**只在减少**已有的持仓(保护规则"只挡新单、永不挡平仓"的认定)。
// 认准才放:每条腿都朝减仓的方向、数量不超过这个账户在这条腿上的持仓,才算平仓;任何一条腿对不上一律 false。
// 期望值:tests/fixtures/gen_engine_pure.mjs(原模块)。order 是 ParsedOrder(OJson),rows 是券商持仓行(每行带 key 与带符号的 quantity)。
//
// TS 原样:legIntents 里读 `order.order.totalQuantity`、`leg.ratio` 等松散字段,缺了就是 undefined → NaN,NaN 比较一律假(不放行);orderLegId 里
// 看涨看跌的大写用 QString::toUpper(JS 是完整 Unicode 大写,"ß" → "SS";右别只会是 C/P)。
#pragma once

#include "util/ordered_json.h"

#include <QList>
#include <QString>

namespace ibkr::orchestrate {

bool reducesPositions(const util::OJson& order, const QString& alias, const QList<util::OJson>& rows);
/// 把一张已经认成减仓的单从持仓行里扣掉(就地改 rows 的 quantity)
void applyReduction(const util::OJson& order, const QString& alias, QList<util::OJson>& rows);
/// 一张单开出来的那份持仓的腿身份(和持仓行 / 追踪行的 leg 同一种写法)。order 只要 contract 一项
QString orderLegId(const util::OJson& order);

}  // namespace ibkr::orchestrate
