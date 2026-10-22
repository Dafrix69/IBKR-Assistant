// tradeOutcomes.ts:交易结果 → 知识总结的事实(IdeaTradeFact):成 / 败 / 持平 / 持仓中 / 不明,以及对成本的收益率。纯函数。
// 输入:ibtrades 合成的蝴蝶记录、stockreview 切出的持仓段、导入的期权行(domain/imported_trades 的 OJson 行,字段是接口里的类型),
// 都收 OJson;事实也是 OJson(键序同 TS 的对象字面量:蝴蝶 / 股票没有 pnl_points 这一键)。
// settleClose / isPaper 是调用方递进来的查询。期望值:tests/fixtures/gen_trade_outcomes.mjs
#pragma once

#include "util/ordered_json.h"

#include <QList>
#include <QSet>
#include <QString>
#include <QStringList>

#include <functional>
#include <optional>

namespace ibkr::analysis::trade_outcomes {

inline constexpr int kMaxTradeFacts = 200;
inline constexpr double kFlatPct = 0.5;
inline constexpr double kFlatPoints = 0.05;

/// 标的在某个美东日期的收盘价;查不到回空
using SettleClose = std::function<std::optional<double>(const QString& symbol, const QString& date)>;
using IsPaper = std::function<bool(const QString& accountId)>;

QList<util::OJson> butterflyFacts(const QList<util::OJson>& records, const SettleClose& settleClose, double now);
QList<util::OJson> stockFacts(const QList<util::OJson>& trips);
/// Set<string>:插入次序
QStringList optionDaysCovered(const QList<util::OJson>& fills);
/// "2026-07-20 10:23:05"(美东墙钟)→ UTC ISO;读不出抛 "Invalid time value"
QString etIso(const QString& timeEt);
QList<util::OJson> optionFacts(const QList<util::OJson>& rows, const IsPaper& isPaper, const QSet<QString>& covered = {});
QList<util::OJson> positionFacts(const QList<util::OJson>& rows, const IsPaper& isPaper);
QStringList positionDays(const QList<util::OJson>& rows);
QList<util::OJson> collectFacts(const QList<util::OJson>& butterflies, const QList<util::OJson>& trips, const SettleClose& settleClose, double now,
                                const QStringList& symbols = {}, const QList<util::OJson>& extra = {});
/// [{symbol, date}…]
QList<util::OJson> settlementsNeeded(const QList<util::OJson>& butterflies, double now);
QString factLine(const util::OJson& fact);
QString tallyLine(const QList<util::OJson>& facts);

}  // namespace ibkr::analysis::trade_outcomes
