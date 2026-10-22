// 持仓追踪里的关键价位(desktop/renderer-react/src/lib/trackLevels.ts 逐条搬):追踪的标的在盯价位(期权墙 / 均线 / 整数关口),
// 和用户自己设的那几条线(止损、止盈、标的止损、目标价)摆到一起说清楚——"止损在下方持仓墙之下 0.4%"这种话。
// 价位就是引擎 alert_watches 的那一份:{ price, label, source, kind }。期望值由 node 跑原模块现算(tests/fixtures/gen_alert_rules.mjs)。
#pragma once

#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QString>

#include <optional>

namespace ibkr::shell::levels {

inline const QString kOwnPrefix = QStringLiteral("own:");
inline constexpr double kNearPct = 0.15;

bool isOwnLine(const QJsonObject& level);
/// 用户自己设的那几条线,按标的的价摆(正股:止损 / 回撤线 / 止盈;期权与组合:标的止损 / 目标价)
QJsonArray ownLines(const QString& secType, const QJsonObject& targets, const QJsonObject& live);
/// 现价上下各最近的几个价位(不含用户自己的线):{ below: [{ level, pct }], above: [...] }
QJsonObject nearestLevels(const QJsonArray& levels, double spot, int n = 2);
QString fmtLevel(double v);
QString fmtGap(double pct);
using ShortNames = QHash<QString, QString>;
QString levelName(const QJsonObject& level, const ShortNames& names);
QString levelSummary(const QJsonArray& levels, double spot, const ShortNames& names);
/// 用户的一条线和它旁边的价位是什么关系;旁边没有价位返回空
std::optional<QString> lineContext(const QJsonObject& line, const QJsonArray& levels, double spot, const ShortNames& names);
/// 表单里点价位填进止损 / 目标时,哪一侧能点:{ below, above }
QJsonObject pickSides(const QJsonArray& levels, double spot, const QString& mode, bool isLong, bool derivative);
/// 价位穿越的弹窗落到持仓追踪页时正文末尾那一句;没在追踪这只返回空。rows:追踪 id → 盯盘那一行
std::optional<QString> trackContext(const QString& symbol, const QJsonArray& tracks, const QJsonObject& rows);

/// 价位的短名(store/alerts.ts 的 ALERT_SOURCE_SHORT)与全名(ALERT_SOURCE_LABEL)
const ShortNames& sourceShort();
const ShortNames& sourceLabel();

}  // namespace ibkr::shell::levels
