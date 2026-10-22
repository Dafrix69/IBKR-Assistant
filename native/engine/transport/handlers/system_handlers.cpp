#include "transport/handlers/system_handlers.h"

#include "parsing/prompts.h"
#include "transport/handlers/handler_util.h"
#include "util/tz.h"

#include <QJsonArray>
#include <QJsonObject>

using namespace Qt::StringLiterals;

namespace ibkr::rpc {

namespace js = util::js;
using util::OJson;

namespace {

/// protectionsSummary 的键序(paused / rule / reason / until_ms / cooldowns / accounts)——util 那份回的是 QJsonObject,键被排了序,这里按 TS 的次序重摆
OJson protectionsJson(const util::ProtectionState& state, double nowMs) {
    const QJsonObject sorted = util::protectionsSummary(state, nowMs);
    const auto rows = [&sorted](const QString& key, const QString& nameKey) {
        OJson out = js::array();
        for (const QJsonValue& v : sorted.value(key).toArray()) {
            const QJsonObject o = v.toObject();
            out.items.append(js::object({{nameKey, OJson::fromQJson(o.value(nameKey))}, {u"until_ms"_s, OJson::fromQJson(o.value(u"until_ms"_s))}, {u"reason"_s, OJson::fromQJson(o.value(u"reason"_s))}}));
        }
        return out;
    };
    return js::object({{u"paused"_s, OJson::fromQJson(sorted.value(u"paused"_s))},
                       {u"rule"_s, OJson::fromQJson(sorted.value(u"rule"_s))},
                       {u"reason"_s, OJson::fromQJson(sorted.value(u"reason"_s))},
                       {u"until_ms"_s, OJson::fromQJson(sorted.value(u"until_ms"_s))},
                       {u"cooldowns"_s, rows(u"cooldowns"_s, u"symbol"_s)},
                       {u"accounts"_s, rows(u"accounts"_s, u"account"_s)}});
}

}  // namespace

MethodTable SystemHandlers::methods() {
    ContractTable t;
    t.sync(u"system.status"_s, [this](const OJson&) { return systemStatus(); });
    t.sync(u"system.selftest"_s, [this](const OJson&) { return systemSelftest(); });
    return t.take();
}

OJson SystemHandlers::indexSpots() {
    OJson out = js::object();
    const auto router = ports_.router();
    if (!router || !router->hasSpotInfo()) return out;
    for (const QString& symbol : settings().index_symbols.keys()) {
        const std::optional<OJson> row = router->spotInfo(symbol);
        if (row) out.set(symbol, *row);
    }
    return out;
}

OJson SystemHandlers::systemStatus() {
    const domain::EtNow moment = domain::nowEt();
    EnginePort& engine = ports_.engine();
    const util::BreakerState breaker = engine.killswitch().state();
    const util::WallParts p = util::wallParts(moment.epochMs, QString::fromUtf16(util::kET));
    const QString nowEtText = QString::number(p.year) + u'-' + util::pad2(p.month) + u'-' + util::pad2(p.day) + u' ' + util::pad2(p.hour) + u':' + util::pad2(p.minute)
                              + u':' + util::pad2(p.second);
    OJson out = js::object();
    out.set(u"protocol"_s, js::S(QLatin1StringView(kProtocolVersion)));
    out.set(u"now_et"_s, js::S(nowEtText));
    out.set(u"market_status"_s, js::S(settings().marketStatus(moment)));
    out.set(u"prompt_version"_s, js::S(engine.bundle().version));
    out.set(u"prompt_fingerprint"_s, js::S(parsing::prompts::fingerprint(engine.bundle())));
    out.set(u"model"_s, js::S(settings().llm.model));
    out.set(u"auto_execute"_s, js::B(settings().policies.auto_execute));
    out.set(u"allow_live_trading"_s, js::B(settings().policies.allow_live_trading));
    out.set(u"breaker"_s, js::object({{u"engaged"_s, js::B(breaker.engaged)}, {u"reason"_s, js::S(breaker.reason)}, {u"consecutive_failures"_s, js::N(breaker.consecutive_failures)}}));
    // 保护规则(接连止损 / 回撤过大 / 同标的冷却):到点自己解除,所以带上解除时刻,界面直接显示"还剩几分钟",不用再问一次
    out.set(u"protections"_s, protectionsJson(engine.protectionState(moment.epochMs), moment.epochMs));
    out.set(u"broker_provider"_s, js::S(settings().broker.provider));
    const auto router = ports_.router();
    out.set(u"broker_connected"_s, js::B(router && router->sessionCount() > 0));
    out.set(u"broker_upstream_ok"_s, js::B(!router || router->upstreamOk()));
    out.set(u"pending_count"_s, js::N(engine.pendingTriggers().size()));
    // 各指数最近一次现价是怎么来的:官方实时 / 夜盘期货推算 / 推算失败退回的昨收(带原因)。只读缓存,不发请求——status 在本地道,来了就答。
    out.set(u"index_spot"_s, indexSpots());
    // 盯盘节拍器的心跳:没在跑、太久没跳、上一轮报错,界面都要能当场看见
    EnginePort* built = ports_.engineBuilt();
    out.set(u"tracker_loop"_s, built ? built->trackerHeartbeat() : js::Null());
    out.set(u"accounts"_s, accounts());
    const contract::Limits& L = settings().limits;
    out.set(u"limits"_s, js::object({{u"max_order_notional"_s, js::N(L.max_order_notional)},
                                     {u"max_option_contracts"_s, js::N(L.max_option_contracts)},
                                     {u"max_mkt_shares"_s, js::N(L.max_mkt_shares)},
                                     {u"min_confidence"_s, js::N(L.min_confidence)},
                                     {u"max_spread_slippage"_s, js::N(L.max_spread_slippage)},
                                     {u"duplicate_window_minutes"_s, js::N(L.duplicate_window_minutes)}}));
    return out;
}

OJson SystemHandlers::systemSelftest() {
    const parsing::prompts::PromptBundle bundle = parsing::prompts::loadPromptBundle(settings());
    OJson aliases = js::object();
    for (const QString& k : settings().symbol_aliases.keys()) aliases.set(k, js::S(settings().symbol_aliases.value(k)));
    return js::object({{u"prompt_version"_s, js::S(bundle.version)},
                       {u"prompt_fingerprint"_s, js::S(parsing::prompts::fingerprint(bundle))},
                       {u"system_prompt_chars"_s, js::N(bundle.system_text.toUcs4().size())},  // [...s].length:码点数
                       {u"fewshot_pairs"_s, js::N(bundle.fewshot.size())},
                       {u"symbol_aliases"_s, aliases},
                       {u"accounts"_s, accounts()}});
}

}  // namespace ibkr::rpc
