#include "orchestrate/services/guard_push.h"

#include "parsing/sdk_http.h"
#include "util/error.h"
#include "util/jsobj.h"
#include "util/secrets.h"
#include "util/whatwg_url.h"

namespace ibkr::orchestrate::guard_push {

using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;
namespace sdk = parsing::sdk;

Request telegram(const QString& token, const QString& chatId, const QString& title, const QString& body) {
    const OJson payload = js::object({{u"chat_id"_s, js::S(chatId)}, {u"text"_s, js::S(title + u'\n' + body)}, {u"disable_web_page_preview"_s, js::B(true)}});
    return {u"https://api.telegram.org/bot"_s + token + u"/sendMessage"_s, js::stringify(payload).toUtf8()};
}

Request pushover(const QString& token, const QString& user, const QString& title, const QString& body) {
    const OJson payload = js::object({{u"token"_s, js::S(token)}, {u"user"_s, js::S(user)}, {u"title"_s, js::S(title)}, {u"message"_s, js::S(body)}});
    return {u"https://api.pushover.net/1/messages.json"_s, js::stringify(payload).toUtf8()};
}

bool configured(const contract::GuardPushConfig& cfg) {
    if (cfg.provider == u"telegram") return !cfg.telegram_chat_id.isEmpty();
    if (cfg.provider == u"pushover") return !cfg.pushover_user.isEmpty();
    return false;
}

Request build(const contract::GuardPushConfig& cfg, const QString& token, const QString& title, const QString& body) {
    if (!configured(cfg) || token.isEmpty()) return {};
    if (cfg.provider == u"telegram") return telegram(token, cfg.telegram_chat_id, title, body);
    return pushover(token, cfg.pushover_user, title, body);
}

util::Task<> send(Request request, double timeoutMs) {
    using Fail = sdk::Exchange::Fail;
    const auto parsed = util::whatwg::parse(request.url);
    if (!parsed) throw util::JsError(u"推送地址拼不出来"_s);
    sdk::Headers headers;
    headers.set(u"content-type"_s, u"application/json"_s);
    headers.set(u"user-agent"_s, u"datrix-guard"_s);
    const std::shared_ptr<sdk::Exchange> ex = sdk::Exchange::start("POST", *parsed, headers, request.body);
    ex->startDeadline(timeoutMs);
    const Fail head = co_await ex->headers();
    if (head != Fail::None) {
        ex->cancel();
        throw util::JsError(head == Fail::Deadline ? u"推送超时"_s : u"推送连不上"_s);
    }
    const auto [fail, bytes] = co_await ex->body();
    ex->stopDeadline();
    if (fail != Fail::None) throw util::JsError(u"推送没读完回包"_s);
    if (!ex->ok()) throw util::JsError(u"推送服务返回 HTTP %1"_s.arg(ex->status()));
    (void)bytes;
}

util::Task<> sendWithKeychain(contract::GuardPushConfig cfg, QString title, QString body) {
    const std::optional<QString> token = co_await util::readSecret(cfg.keychain_service, cfg.keychain_account);
    if (!token || token->isEmpty()) throw util::JsError(u"凭证库里没有推送 token(%1 / %2)"_s.arg(cfg.keychain_service, cfg.keychain_account));
    const Request req = build(cfg, *token, title, body);
    if (req.url.isEmpty()) throw util::JsError(u"guard.push 没配齐"_s);
    co_await send(req);
}

}  // namespace ibkr::orchestrate::guard_push
