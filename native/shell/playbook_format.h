// SPX 日内剧本的人话(desktop/renderer-react/src/lib/playbookFormat.ts 逐条搬):状态与事件怎么写、离触发线还有多远、
// 期权墙的 gamma 环境怎么写。期望值由 node 跑原模块现算(tests/fixtures/gen_feed_rules.mjs)。
#pragma once

#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QString>

namespace ibkr::shell::playbook {

const QHash<QString, QString>& stateLabel();
const QHash<QString, QString>& stateHint();
/// 正负 gamma 是按这个假设算的:写在数旁边,不藏在说明里
inline const QString kGexAssumption = QStringLiteral("假设做市商多看涨、空看跌");
extern const QString kGexAssumptionHint;

/// 两位小数;不是有限的数是「—」
QString fmtLevel(const QJsonValue& value);
/// 带正负号的点数差(目标 − 现价);缺一个是空
QString fmtGap(const QJsonValue& target, const QJsonValue& price);
/// 美东的 HH:MM;不是数是空
QString etTime(const QJsonValue& epochMs);
QString eventTone(const QJsonObject& event);
QString eventTitle(const QString& symbol, const QJsonObject& event);
QString eventBody(const QJsonObject& event);
/// [{ key, label, when, band, derived }]
QJsonArray bandRows(const QJsonObject& snap);
QString gexText(const QJsonObject& wall);
QString coverageText(const QJsonValue& coverage, const QJsonValue& oiMissing = 0);
QString rearmText(const QJsonValue& lost);

}  // namespace ibkr::shell::playbook
