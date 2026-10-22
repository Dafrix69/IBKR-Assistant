// 信息链路的界面规则(desktop/renderer-react/src/lib/intelRules.ts 逐条搬):时间线上一条怎么摆、怎么筛、提到持仓时弹什么。
// 期望值由 node 跑原模块现算(tests/fixtures/gen_feed_rules.mjs)。本机时区相关的两样(relTime、groupByDay)收一个时区,测试固定它。
#pragma once

#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>
#include <QTimeZone>

#include <optional>

namespace ibkr::shell::intel {

const QHash<QString, QString>& kindLabel();
const QHash<QString, QString>& kindIcon();
const QHash<QString, QString>& kindTint();
const QStringList& kindOrder();

/// 时间线上「来源」那一格:信号、事件、想法的来源是代号,换成人话;别的照原样
QString sourceLabel(const QString& kind, const QString& source);
/// 多久之前 / 之后:一分钟内「刚刚」,一小时内「N 分钟前」,一天内「N 小时前」,再往前写月-日 时:分(本机时区)
QString relTime(double at, double now, const QTimeZone& tz = QTimeZone::systemTimeZone());
QString fmtPrice(double v);
/// 「SPX 提到时 7700 → 此刻 7712.5(+0.16%)」;此刻没有价就只写提到时
QString moveText(const QJsonObject& move);
QString moveTone(const QJsonValue& move);
/// 界面上再筛一遍:种类、只看持仓、关键字(标的代码或原文里的字)
QJsonArray filterItems(const QJsonArray& items, const QStringList& kinds, bool heldOnly, const QString& query);
/// 按本机日历日分组,新的在前:[{ label, items }]
QJsonArray groupByDay(const QJsonArray& items, double now, const QTimeZone& tz = QTimeZone::systemTimeZone());
/// 各标的被提到几次,多的在前:[{ symbol, n, held }]
QJsonArray hotSymbols(const QJsonArray& items, int max = 8);
bool isHeldMention(const QJsonValue& data);
/// 引擎推来的 held_mention → 弹窗的一条;now:消息没带时刻时用
QJsonObject heldMentionPopup(const QJsonObject& m, double now);
/// ⌘K 里敲的字 → 标的代码;不像代码的回空
std::optional<QString> lookupSymbol(const QString& raw);

}  // namespace ibkr::shell::intel
