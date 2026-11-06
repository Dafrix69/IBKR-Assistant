// 交易纪律守护的手机推送:Telegram bot 或 Pushover。见 docs/features/guard.md「推送」。
// 拼请求是纯函数(测试只测这一层),发送走 parsing/sdk 的 Exchange(引擎里唯一的出站 HTTP 客户端)。
// token 只从凭证库读,不进配置、不进日志、不进收件流水。
#pragma once

#include "contract/settings.h"
#include "util/task.h"

#include <QByteArray>
#include <QString>

namespace ibkr::orchestrate::guard_push {

struct Request {
    QString url;
    QByteArray body;  // JSON
};

/// Telegram:POST https://api.telegram.org/bot<token>/sendMessage {chat_id, text}
Request telegram(const QString& token, const QString& chatId, const QString& title, const QString& body);
/// Pushover:POST https://api.pushover.net/1/messages.json {token, user, title, message}
Request pushover(const QString& token, const QString& user, const QString& title, const QString& body);
/// 按配置拼;provider 不认识或缺 chat_id / user 时回空串 url(调用方当没配)
Request build(const contract::GuardPushConfig& cfg, const QString& token, const QString& title, const QString& body);
/// 配置齐不齐(不看 token)
bool configured(const contract::GuardPushConfig& cfg);

/// 发出去:2xx 算成;连不上、超时、非 2xx 抛 JsError(话里不带 token)
util::Task<> send(Request request, double timeoutMs = 15'000);
/// 从凭证库读 token、拼、发。读不到 token、没配齐都抛
util::Task<> sendWithKeychain(contract::GuardPushConfig cfg, QString title, QString body);

}  // namespace ibkr::orchestrate::guard_push
