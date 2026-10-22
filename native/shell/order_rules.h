// 订单的状态口径与「订单看板」那一页(逐句搬):
//   · lib/OrderStatus.tsx:statusBucket(成了 / 在途 / 被拒 / 撤了 / 熔断 / 仅校验 / 去向不明)、每档的着色与叫法、阶段路径停在哪一步;
//   · lib/labels.ts:FINAL_STATUS_LABEL / LIVE_STATUS_LABEL 的 statusLabel、TRIGGER_OP_LABEL、ACTION_LABEL;
//   · pages/Board.tsx:四个小组件、排队等待触发的条件单、已提交 / 近期、通知流。
// 看板与交易记录页共用同一套口径:同一笔单在两页上必须是同一种颜色、同一段路径。期望值:tests/fixtures/gen_board.mjs
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QStringList>
#include <QTimeZone>

namespace ibkr::shell::orders {

/// filled / working / failed / closed / halted / draft / stale
QString statusBucket(const QJsonObject& record);
/// 每档的着色(Pill 的 tint)
QString bucketTint(const QString& bucket);
QString bucketLabel(const QString& bucket);
/// 终态翻了用终态,没有终态用在途状态,都没有用 fallback;词表里没有的照原样
QString statusLabel(const QJsonObject& record, const QString& fallback);
/// 阶段路径(校验 → 提交 → 成交)走到了第几步(0..3)
int stageCurrent(const QJsonObject& record);
/// 比较符摆给人看的数学符号(>= → ≥);没有的照原样
QString triggerOpLabel(const QJsonValue& op);
QString actionLabel(const QJsonValue& action);
/// LIVE_STATUS_LABEL[status];词表里没有返回空
QString liveStatusLabel(const QString& status);

struct BoardInput {
    QJsonArray pending;
    QJsonValue pendingError;
    QJsonArray records;
    QJsonValue recordsError;
    /// 通知流:[{ at, text }]
    QJsonArray feed;
    double nowMs = 0;
    QTimeZone localZone = QTimeZone::systemTimeZone();
};
/// { widgets: [{ icon, tint, value, label }], pending: { count, empty, cards }, live: { count, empty, cards }, feed: { items, empty } }
QJsonObject boardModel(const BoardInput& in);
QStringList boardTexts(const QJsonObject& model);
/// lib/format.ts 的 fmtTimeShort:今天只写时分,别的写月-日 时分;空是「—」,读不出来照原样。
/// 按 dayjs 解析(只有日期的按本机零点);同一个文件里的 fmtTime 按 new Date(只有日期的按 UTC 零点)——原版就是两套,不能合成一个
QString fmtTimeShort(const QJsonValue& iso, double nowMs, const QTimeZone& zone);

}  // namespace ibkr::shell::orders
