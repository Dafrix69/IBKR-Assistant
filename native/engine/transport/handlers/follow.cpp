#include "transport/handlers/follow.h"

#include "transport/handlers/handlers2_support.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/keychain.h"

using namespace Qt::StringLiterals;

namespace ibkr::rpc {

using util::OJson;
namespace js = util::js;

namespace {

/// [\w-]{lo,}:\w 只认 ASCII 字母数字下划线
bool tokenPart(const QString& s, qsizetype minLen) {
    if (s.size() < minLen) return false;
    for (const QChar c : s) {
        const bool ok = (c >= u'a' && c <= u'z') || (c >= u'A' && c <= u'Z') || (c >= u'0' && c <= u'9') || c == u'_' || c == u'-';
        if (!ok) return false;
    }
    return true;
}

/// /^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/(JS 的 $ 只认串尾;[\w-] 不含点,所以恰好三段)
bool looksLikeBotToken(const QString& token) {
    const QStringList parts = token.split(u'.');
    return parts.size() == 3 && tokenPart(parts[0], 20) && tokenPart(parts[1], 4) && tokenPart(parts[2], 20);
}

}  // namespace

MethodTable FollowHandlers::methods() {
    return contractTable({
        {u"follow.status"_s, [this](OJson) { return ports_.follow().status(); }},
        {u"follow.set_token"_s, [this](OJson p) { return setToken(std::move(p)); }},
        {u"follow.reconnect"_s, [this](OJson) { return reconnect(); }},
    });
}

/// 存 bot token 并用它重新连接。明文只经过这一跳,不落配置、不回显、不进日志。
util::Task<OJson> FollowHandlers::setToken(OJson params) {
    const QString token = util::jsTrim(js::str(js::prop(&params, u"token"_s)));
    // bot token 是三段用点连起来的 base64url;用户 token 也长这样,分不出来——但形状都不对的可以当场说
    if (!looksLikeBotToken(token)) {
        throw util::RpcError(-32602, u"这不像 Discord 的 bot token(应该是用两个点连起来的三段)。在 Developer Portal 的 Bot 页点 Reset Token 之后整段复制。"_s);
    }
    try {
        co_await ports_.follow().setToken(token);
    } catch (const util::KeychainError& exc) {
        throw util::RpcError(-32008, exc.message());
    }
    co_return co_await ports_.follow().status();
}

/// 丢掉现在的连接重来:在 Developer Portal 改好了设置(打开 intent、把 bot 拉进服务器)之后用。
util::Task<OJson> FollowHandlers::reconnect() {
    co_await ports_.follow().sync(true);
    co_return co_await ports_.follow().status();
}

}  // namespace ibkr::rpc
