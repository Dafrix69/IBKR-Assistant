// tradereview.ts:交易复盘——一张蝴蝶 + 标的 K 线 → 结构、盈亏区间、走势统计与规则化结论;开仓 ↔ 平仓配对;
// 用组合分钟中间价重说"曾有的机会"(marketOpportunity)。纯函数。
// TS 那边的记录、K 线、profile 都是松的记录(Rec),这里收 OJson,按 JS 的读法取值:
//   · 记录 / K 线本身是 null 时 TS 的 record["x"] 抛 TypeError,这里同样抛(propStrict),话一字不改;
//   · **约定:profile / zone / stats / outcome 是本模块自己拼出来的**(butterflyProfile、review),字段是数就按数算。
//     它们是串时 TS 的 `lower + debit` 会拼串、fmtF 会写成 "inf",C++ 照数算——生产方只给数,碰不到;
//   · 数组参数收 QList<OJson>(JS 数组的元素),调用方传 .items。
// 期望值:tests/fixtures/gen_tradereview.mjs
#pragma once

#include "util/error.h"
#include "util/ordered_json.h"

#include <QList>
#include <QString>

#include <optional>

namespace ibkr::analysis::tradereview {

inline constexpr qsizetype kLookbackBars = 40;
inline constexpr qsizetype kLookaheadBars = 20;
inline constexpr qsizetype kMaxWindow = 240;
inline constexpr qsizetype kPreTrendBars = 20;
inline constexpr qsizetype kPostEntryBars = 6;

inline constexpr char16_t kKindClosed[] = u"closed";
inline constexpr char16_t kKindExpired[] = u"expired";
inline constexpr char16_t kKindOpen[] = u"open";

/// TS 的 `class ReviewError extends Error`:调用方按类型接(entryOf 定位不了开仓时刻、不是蝴蝶、K 线不够)
class ReviewError : public util::JsError {
public:
    using JsError::JsError;
};

/// "20261016" → "2026-10-16";别的原样(String(raw ?? ""))
QString fmtExpiry(const util::OJson* raw);
/// 不是 1:2:1 同到期同方向三腿的 BAG 回 null;键序同 TS 的对象字面量
util::OJson butterflyProfile(const util::OJson* record);
bool sameButterfly(const util::OJson& a, const util::OJson& b);
double payoffPerUnit(const util::OJson& profile, double s);
std::optional<double> pnlAt(const util::OJson& profile, double s);
util::OJson zone(const util::OJson& profile);

/// 记录里的时间 → epoch 毫秒(IB 成交时间三种写法、美东墙钟、带时区的 ISO);认不出回空
std::optional<double> parseWhen(const util::OJson* value);
std::optional<double> parseWhen(const QString& value);
QString etKey(double epochMs, bool daily);

struct Entry {
    double time = 0;
    bool estimated = false;
};
/// 抛 ReviewError(没有成交时间也没有提交时间)
Entry entryOf(const util::OJson* record);
/// {time, price, record_id, estimated} 或 null
util::OJson findExit(const util::OJson& profile, double entryTime, const QList<util::OJson>& others, const util::OJson* excludeId);
/// {id: {role, peer}}(普通对象:像下标的 id 排在最前)
util::OJson pairButterflies(const QList<util::OJson>& trades);
/// pairs[id] 在 JS 里是真值吗(id 是 Object.prototype 上的名字时也是)
bool pairsHas(const util::OJson& pairs, const QString& key);
double expiryClose(const util::OJson& profile);

bool isDaily(const QList<util::OJson>& bars);
QString barTime(const util::OJson* bar);
std::optional<qsizetype> indexAt(const QList<util::OJson>& bars, double when, bool daily);
double barSeconds(const QString& timeframe, bool daily);
QString pickTimeframe(double entryTime, double now);

util::OJson review(const util::OJson* record, const QList<util::OJson>& others, const QList<util::OJson>& bars, const QString& timeframe, double now);
util::OJson buildFindings(const util::OJson& profile, const util::OJson& z, const util::OJson& entry, const util::OJson& outcome, const util::OJson& stats);
/// 就地改 result(stats.best_market、findings 里"曾有的机会"那一条);拿不到数据什么都不动
void marketOpportunity(util::OJson& result, const QList<util::OJson>& flyBars, const QString& entryBar);

/// "x".toFixed(2) 去尾零(pts)
QString pts(double v);
/// 无 = "—";负数原样,其余带 +
QString money(const std::optional<double>& v);
/// Object.prototype 上的名字(含 __proto__):`k in {}` 为真、`({})[k]` 是真值
bool onObjectPrototype(const QString& k);

}  // namespace ibkr::analysis::tradereview
