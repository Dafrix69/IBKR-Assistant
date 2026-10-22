// 「设置」与「关于」两页怎么摆(逐句搬):pages/Settings.tsx(带 lib/AccountLimitsRows、lib/EventsConfig、lib/DataPanel)、
// 表单的纯逻辑 lib/settingsForm.ts;pages/About.tsx(带 lib/UpdatePanel、lib/SupportPanel)。
// 输入就是原版组件里的 useState(同名字段,JSON)与 store 里的那几样;这里只算「摆什么字、哪一格填什么、哪颗按钮点不点得动」,
// 以及保存时送出去的补丁。期望值:tests/fixtures/gen_settings.mjs
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QStringList>
#include <QTimeZone>

namespace ibkr::shell::settings {

// ---- lib/settingsForm.ts ---------------------------------------------------------------------------
/// 设置 → 表单(缺什么就空着那一格,其余照常)
QJsonObject toForm(const QJsonValue& settings);
/// 保存前的检查:给人看的话,一条一句;空 = 可以存。按账户的那几条按 accountOrder 的次序
/// (原版 Object.entries(byAccount) = toForm 时账户表的次序;QJsonObject 的键是排过序的,次序要另给,没给的排在后面)
QStringList formProblems(const QJsonObject& form, const QStringList& accountOrder = {});
/// 已保存的设置里账户表的别名次序(Object.entries(form.byAccount) / Object.keys(form.rbEquity) 的次序就是它)
QStringList accountOrder(const QJsonValue& saved);
/// 表单 → 补丁:空着的格子照已保存的值送回去(没有就不送这个键),从不把 null 变成 0。saved 可以是 null
QJsonObject toPatch(const QJsonObject& form, const QJsonValue& saved);
/// 表单和已保存的那一份不一样;saved 是 null 时不算
bool isDirty(const QJsonObject& form, const QJsonValue& saved);

// ---- 设置页 ----------------------------------------------------------------------------------------
/// 一页的输入:Settings.tsx 的 saved / form / saving / checked,DataPanel 的 info / error / busy,EventsConfig 的 draft,外观三项
struct PageInput {
    QJsonValue saved;      // null = 还没读到
    QJsonValue form;       // null = 还没读到(画骨架)
    bool saving = false;
    bool checked = false;  // 点过一次保存
    QJsonValue dataInfo;   // data.backups 的回包;null = 读着
    QString dataError;     // 非空 = 读不到
    QJsonValue dataBusy;   // null / "backup" / 某份备份的名字
    QJsonValue eventsDraft;  // events 的口径;null = 还没读到
    QString themeMode = QStringLiteral("system");
    QString upDown = QStringLiteral("green-up");
    double glass = 0.72;
};
/// 页面模型。行的样子:{ kind: switch | number | segment, key, icon, tint, label, sub, checked | value | (options, selected), min, max, step, placeholder, disabled }
///   { loading, dirty, saving, appearance: { themeMode, upDown, glass(0–100) }, gates, limits, accounts: [{ alias, tint, sub, fields: [{ key, label, min, step, value }] }],
///     protections, budget, problems, events: null | rows, data: { state: loading | error | ready, error, dbPath, backupLoading, empty, rows: [{ name, label, sub, loading, disabled }] } }
QJsonObject pageModel(const PageInput& in, const QTimeZone& zone = QTimeZone::systemTimeZone());
/// SSR 抽出来的那一串字
QStringList pageTexts(const QJsonObject& model);
/// 数据与备份:字节数写成「1.8 MB」「12 KB」
QString fmtBytes(double bytes);

// ---- 关于页 ----------------------------------------------------------------------------------------
struct AboutInput {
    QJsonValue info;   // { app, self };null = 读着
    QString error;     // 非空 = 读取失败
    QJsonValue update; // store/update 的 { info, checking, error, auto, dismissed }
    QString log;       // 引擎日志(最近 200 行)
    bool supportBusy = false;
    bool mac = true;   // 快捷键写 ⌘ 还是 Ctrl
    QTimeZone zone = QTimeZone::systemTimeZone();  // 新版本的发布日期按本机时区写
};
/// { loading, error, rows: [{ label, value, link }], update: { label, sub, buttons: [{ kind: download | page | dismiss | check, text, url, primary, loading }], auto, notes },
///   supportBusy, shortcuts: [{ keys, what }], log }
QJsonObject aboutModel(const AboutInput& in);
QStringList aboutTexts(const QJsonObject& model);

}  // namespace ibkr::shell::settings
