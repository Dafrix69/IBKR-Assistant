// 提醒的判断口径(desktop/renderer-react/src/lib/alertRules.ts 逐条搬):表里哪个数算"真放量"、一批提醒该响什么音、
// 弹窗到底收下了几条。期望值由 node 跑原模块现算(tests/fixtures/gen_alert_rules.mjs)。
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>

namespace ibkr::shell::alerts {

inline constexpr double kBlockShareHeavy = 0.5;

/// 一批提醒响一声,方向怎么定:只看价格类;放量、碰均线不算;有涨有跌或一条价格类都没有是空(中性)
QString toneDirection(const QJsonValue& events);

struct PopupCounts {
    int accepted = 0;
    int dropped = 0;
};
/// 把弹窗的回执读成"收了几条、丢了几条"(res:{ shown?, dropped? })
PopupCounts popupCounts(const QJsonValue& sent, const QJsonValue& res);

/// 窗口量比这一格怎么显示:{ level: none / hot / muted / reference / plain, note }
QJsonObject burstVerdict(const QJsonValue& metrics, const QJsonValue& threshold);

}  // namespace ibkr::shell::alerts
