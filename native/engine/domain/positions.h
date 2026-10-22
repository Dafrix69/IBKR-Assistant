// 持仓的身份与名字(engine-ts/src/positions.ts)、期权腿 → 组合(combos.ts)、行情数据的领域形状(marketdata.ts),逐句搬。
// 持仓行是 JS 对象(券商回包的形状,OJson);函数照 TS 的 `Record<string, any>` 写法读字段(缺了是 undefined)。
#pragma once

#include "util/ordered_json.h"

#include <QList>
#include <QString>

#include <optional>
#include <utility>

namespace ibkr::domain {

/// 持仓 / 追踪的身份:账户|代码|类型[|腿]
QString makeKey(const QString& account, const QString& symbol, const QString& secType, const QString& leg = {});
/// 行权价的写法:"%.4f" 去掉尾零与尾点;null / undefined / "" / NaN 是空串
QString fmtStrike(const util::OJson* strike);
/// 腿身份:期权为 '到期|行权价|C/P',其余空串
QString legOf(const util::OJson* contract);
/// 给人看的一行名字:正股是代码,期权 'SPX 7615P 2026-09-01'
QString positionLabel(const QString& symbol, const QString& secType, const util::OJson* contract);

// ---- combos.ts
/// 相对 1e-6 内算相等
bool same(double a, double b);
/// 这几条腿(已按行权价排好)是什么标准结构;认不出是空
std::optional<std::pair<QString, double>> shapeOf(const QList<util::OJson>& legs);
QList<QList<util::OJson>> splitStructures(const QList<util::OJson>& legs);
QList<util::OJson> groupLegs(const QList<util::OJson>& rows);
util::OJson comboRow(const util::OJson& combo, const QList<util::OJson>& rows);
QList<util::OJson> withCombos(const QList<util::OJson>& rows);

// ---- marketdata.ts
/// K 线周期表:{"1m": {bar_size, duration, fallback, seconds, label, htf}, …}
const util::OJson& timeframes();
inline constexpr int kMinBars = 30;
inline constexpr double kDelayedFeedMaxMs = 20 * 60'000;

}  // namespace ibkr::domain
