// 「接入」一页怎么摆(逐句搬):pages/Access.tsx 的五个子页签——lib/TwsPanel、FutuPanel、AccountsPanel、LlmPanel、FollowPanel,
// 共用的 lib/connectBits(程序卡、端口栅格、握手卡、连接引擎、「连不上时照着做」),跟单表单的纯逻辑 lib/followForm.ts。
// 每一节的输入就是原版那一节组件里的 useState(同名字段,JSON),加上状态快照(券商连没连、账户)与大模型目录;
// 这里只算「摆什么字、什么颜色、哪颗按钮点不点得动」。期望值:tests/fixtures/gen_access.mjs
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QStringList>
#include <QTimeZone>

#include <optional>

namespace ibkr::shell::access {

// ---- lib/followForm.ts ---------------------------------------------------------------------------
namespace follow {
/// 配置 → 表单:{ enabled, channelId, authorIds, accounts, maxAge, perDay, maxRisk, localInbox, localChannel, trackFly, trackExitAt }
QJsonObject toForm(const QJsonValue& config);
/// 保存之前要改的地方;空 = 可以存
QStringList formProblems(const QJsonObject& form);
/// 表单 → 要存的那一份(也是确认框绑的那一份)
QJsonObject toConfig(const QJsonObject& form);
/// 和已保存的那一份比,表单改过没有;saved 是 null 时不算改过
bool isDirty(const QJsonObject& form, const QJsonValue& saved);
/// 往信任名单里加一个 ID;形状不对、已经在里面,原样返回
QJsonObject addAuthor(const QJsonObject& form, const QString& id);
bool isAuthorId(const QString& id);
bool isClock(const QString& text);
/// 读窗口的程序此刻的样子 → { tone, text }
QJsonObject readerText(const QJsonValue& reader, const QString& channel);
QString outcomeLabel(const QString& outcome);
/// success / default / warning / error
QString outcomeTone(const QString& outcome);
/// 处理完那一刻的盘口写成一行;没取到回空
std::optional<QString> quoteLine(const QJsonValue& entry);
}  // namespace follow

/// 子页签
QJsonArray subtabs();

/// 各节:输入是那一节的 useState(同名字段),bits 是 connectBits 里两颗按钮的「读着」({ launching, busy }),status 是状态快照(没起来是 null)
QJsonObject twsModel(const QJsonObject& st, const QJsonObject& bits, const QJsonValue& status);
QJsonObject accountsModel(const QJsonObject& st, const QJsonValue& status);
QJsonObject llmModel(const QJsonObject& st, const QJsonValue& catalog);
QJsonObject followModel(const QJsonObject& st, const QJsonValue& status, const QTimeZone& zone = QTimeZone::systemTimeZone());

/// SSR 抽出来的那一串字(页头 + 子页签 + 那一节)
QStringList pageTexts(const QString& sub, const QJsonObject& model);

}  // namespace ibkr::shell::access
