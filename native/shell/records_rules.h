// 「交易记录」一页(逐句搬):
//   · pages/Records.tsx:状态筛选的分档、关键词(过滤之后再数每档的条数)、去向分段条、表头排序(antd 的 sorter 与升 / 降 / 不排)、每一行;
//   · lib/RecordDetail.tsx:点开一行的单据(票据 + 阶段路径、失败原因、五个小节、状态时间线、成交明细、提醒、原始记录);
//   · lib/OrderTicket.tsx 的 ticketFromRecord:单据上半张的票据从完整记录里拼。
// 状态的口径(分档、着色、叫法)和订单看板共用 shell/order_rules。期望值:tests/fixtures/gen_records.mjs
#pragma once

#include "shell/ordered_json.h"

#include <QCollator>
#include <QJsonArray>
#include <QJsonObject>
#include <QStringList>
#include <QTimeZone>

namespace ibkr::shell::records {

/// lib/format.ts 的 fmtTime:toLocaleString('zh-CN', { hour12: false }) → 「2026/8/21 21:41:02」;空是「—」,读不出来照原样。
/// 按 new Date 解析(只有日期的按 UTC 零点);orders::fmtTimeShort 按 dayjs(只有日期的按本机零点)——原版就是两套,不能合成一个
QString fmtTime(const QJsonValue& iso, const QTimeZone& zone);

/// 筛选的分档:全部 / 已成交 / 进行中 / 去向不明 / 未发送 / 被拒 / 出错
QStringList filterKeys();
bool matchFilter(const QString& key, const QJsonObject& record);

/// 表头排序:key 是列的 dataIndex(created_at / symbol / final_status),order 是 ascend / descend / 空(不排,照引擎给的次序)
struct Sort {
    QString key = QStringLiteral("created_at");
    QString order = QStringLiteral("descend");
};
/// 点一下表头之后的排序(antd:升 → 降 → 不排;点别的列从升开始)
Sort nextSort(const Sort& current, const QString& key);

struct PageInput {
    QJsonArray records;
    QString error;
    QString filter = QStringLiteral("all");
    QString keyword;
    bool compact = false;
    Sort sort;
    QString openId;
    double nowMs = 0;
    QTimeZone zone = QTimeZone::systemTimeZone();
    /// localeCompare 用的(跟着系统语言;测试钉 zh_CN)
    const QCollator* collator = nullptr;
};

/// { title, mix: null | { parts: [{ key, grow, tint, title }], legend: [{ key, tint, label, count }] },
///   filters: [{ key, label, count, disabled, selected }], error, compact,
///   columns: [{ key, title, sortable, order }], rows: [{ id, time, timeTitle, symbol, symbolLong, symbolTint, symbolLink, side, buy,
///   intent, reason, account, paper, amount, status, statusTint, open }], empty }
QJsonObject pageModel(const PageInput& in);

/// ticketFromRecord(contract, order, trigger):拼不出票据是 null
QJsonValue ticketFromRecord(const QJsonValue& contract, const QJsonValue& order, const QJsonValue& trigger);

struct DetailInput {
    /// loading / ok / gone / error
    QString state = QStringLiteral("loading");
    /// records.get 回来的 record(保序:原始记录照引擎的键序写)
    OJson record;
    QString error;
    QTimeZone zone = QTimeZone::systemTimeZone();
    double nowMs = 0;
};
/// { state, empty?: 「这条记录已经不在了」/「读取失败:…」, title, status, statusTint, review: bool, ticket: ticketModel | null,
///   stageCurrent, errorDetail, sections: [{ title, rows: [[k, v]] }], timeline: [{ label, at }],
///   fills: { title, rows: [{ key, time, qty, price, commission }] } | null, warnings: [text], raw }
QJsonObject detailModel(const DetailInput& in);

/// SSR 抽出来的那一串字(页 + 打开的详情)
QStringList pageTexts(const QJsonObject& page, const QJsonObject& detail);

}  // namespace ibkr::shell::records
