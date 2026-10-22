// 交易指令页右栏的两面(逐句搬):
//   · 蝴蝶测算:lib/flyPlanForm.ts(表单 ↔ 引擎入参、写成一句指令、几个格式)、lib/FlyPlanner.tsx(表单那一块)、lib/FlySpot.tsx(现价那一行)、
//     lib/EventWarning.tsx(今天还没公布的重要数据)、lib/FlyPlanResult.tsx(结果)、lib/FlyPlanChart.tsx(盈亏曲线的几何);
//   · 日内剧本:lib/PlaybookPanel.tsx(判定在 shell/playbook_format,这里只拼整面)。
// 期望值:tests/fixtures/gen_fly_plan.mjs(原函数直接跑、SSR 渲染原面板抽字)。只算不下单:options.fly_plan 不发单,入参照样过引擎的 strict schema。
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QStringList>
#include <QTimeZone>

namespace ibkr::shell::fly {

// ---- 表单 ---------------------------------------------------------------------------------------------------------
/// 表单的键,次序同 EMPTY_FORM(formKey = JSON.stringify(form),次序就是这个)
const QStringList& formKeys();
/// EMPTY_FORM
QJsonObject emptyForm();
/// 发给引擎之前就能看出来的问题(范围与先后由引擎按它的时钟判)
QStringList formProblems(const QJsonObject& form);
/// formProblems 为空时才调。留空的项不带
QJsonObject toParams(const QJsonObject& form);
/// store/flyPlan 的 formKey:JSON.stringify(form),按 formKeys 的次序
QString formKey(const QJsonObject& form);
/// 中心、目标点位、到达时刻有一样填了(填了才报问题、才能按测算)
bool touched(const QJsonObject& form);

// ---- 美东时间 ------------------------------------------------------------------------------------------------------
struct EtClock {
    QString date;
    int minutes = 0;
};
EtClock etClock(double nowMs);
QString hhmm(double minutes);
/// 「N 分钟后」:不越过收盘(16:00)
QString minutesFromNow(double nowMs, double ahead);
/// 四个时刻快捷钮:[[显示, 填进去的时刻]]
QJsonArray timeChips(double nowMs);

// ---- 写成指令 / 格式 ----------------------------------------------------------------------------------------------
QString instructionFor(const QJsonObject& r, const QString& todayEt);
QString signedUsd(double value);
QString signedPct(double value, int digits = 1);
QString pct(double fraction, int digits = 1);
const QHash<QString, QString>& paceLabel();
const QHash<QString, QString>& ivSourceLabel();
const QHash<QString, QString>& costSourceLabel();

// ---- 盈亏曲线 ------------------------------------------------------------------------------------------------------
/// FlyPlanChart 的几何(600 × 190 的坐标,横向拉伸、纵向固定 190 高):
/// { width, height, d: { now, target, expiry, area }, costY, strikes: [{ x, label, left, leftText }], spot: { x, label, left, leftText, top } | null,
///   target: { x, label, left, leftText } | null, cost: { label, topFrac, topText }, legend }; 点不够两个是空对象
QJsonObject chartModel(const QJsonObject& r);

// ---- 整面 ---------------------------------------------------------------------------------------------------------
struct PlannerInput {
    /// store/flyPlan 的那一份:{ form, busy, result, failure, resultFor, auto, at, recorder }
    QJsonObject plan;
    /// SpotStore:{ quote, failure, alertOn, lastHit }
    QJsonObject spot;
    QJsonValue status;
    /// EventsStore 的清单原样与这一拍的时钟(事件提醒按它算)
    QJsonObject events;
    double eventsNow = 0;
    /// 「更多」展开着没有(参考资料的折叠记忆)
    bool moreOpen = false;
    /// 本机时区(算于 / 本地时间 / 关口提醒的钟点怎么写)
    QTimeZone localZone = QTimeZone::systemTimeZone();
};
/// 整面的模型(QML 照着画);结构见 fly_rules.cpp 的 plannerModel
QJsonObject plannerModel(const PlannerInput& in);
/// 结果那一大块(FlyPlanResultView)
QJsonObject resultModel(const QJsonObject& r, const QTimeZone& localZone);
/// 按 React 版的文档次序吐出来的每一段字
QStringList plannerTexts(const QJsonObject& model);

struct PlaybookInput {
    /// PlaybookStore:{ snap, failure, alertOn }
    QJsonObject playbook;
    QJsonValue status;
};
QJsonObject playbookModel(const PlaybookInput& in);
QStringList playbookTexts(const QJsonObject& model);

/// AntD Statistic 把数字串拆成整数(千分位)与小数两段画:"13.69" → ["13", ".69"];不是数字串的整段一个
QStringList statisticParts(const QString& value);

}  // namespace ibkr::shell::fly
