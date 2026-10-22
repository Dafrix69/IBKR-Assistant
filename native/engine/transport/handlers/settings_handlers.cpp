#include "transport/handlers/settings_handlers.h"

#include "domain/store.h"
#include "domain/store_safety.h"
#include "transport/handlers/handler_util.h"
#include "util/jsvalue.h"
#include "util/keychain.h"
#include "util/secrets.h"

#include <QFile>
#include <QRegularExpression>
#include <QFileDevice>

#include <algorithm>

using namespace Qt::StringLiterals;

namespace ibkr::rpc {

namespace js = util::js;
namespace prov = parsing::providers;
using util::OJson;
using util::RpcError;

namespace {

/// 界面能改(llm.patch)、能临时盖着试(llm.test)的七项。keychain_* 不在里面:用哪条凭证只跟着供应商走。
const QStringList kLlmFields{u"provider"_s, u"model"_s, u"base_url"_s, u"effort"_s, u"temperature"_s, u"max_tokens"_s, u"timeout_s"_s};
const QStringList kPatchable{u"policies"_s, u"limits"_s, u"protections"_s, u"risk_budget"_s, u"follow"_s};

QStringList sorted(QStringList l) {
    std::sort(l.begin(), l.end());
    return l;
}

OJson llmConfigJson(const contract::LLMConfig& c) {
    return js::object({{u"provider"_s, js::S(c.provider)},
                       {u"model"_s, js::S(c.model)},
                       {u"base_url"_s, js::S(c.base_url)},
                       {u"effort"_s, js::S(c.effort)},
                       {u"temperature"_s, OJson::fromQJson(c.temperature)},
                       {u"max_tokens"_s, js::N(c.max_tokens)},
                       {u"timeout_s"_s, js::N(c.timeout_s)},
                       {u"keychain_service"_s, js::S(c.keychain_service)},
                       {u"keychain_account"_s, js::S(c.keychain_account)}});
}

/// 两套模型配置发往的是不是同一个端点:同一家供应商、同一个 Base URL(去掉首尾空白与末尾的 /,和 validateBaseUrl 一个口径)。
bool sameEndpoint(const contract::LLMConfig& a, const contract::LLMConfig& b) {
    static const QRegularExpression slashes(u"/+$"_s);
    const auto url = [](const QString& v) {
        QString t = util::jsTrim(v);
        t.remove(slashes);
        return t;
    };
    return a.provider == b.provider && url(a.base_url) == url(b.base_url);
}

OJson accountLimitsJson(const contract::AccountLimits& own) {
    OJson out = js::object();
    const auto put = [&out](const QString& k, const QJsonValue& v) {
        if (!v.isUndefined()) out.set(k, OJson::fromQJson(v));
    };
    put(u"max_order_notional"_s, own.max_order_notional);
    put(u"max_option_contracts"_s, own.max_option_contracts);
    put(u"max_mkt_shares"_s, own.max_mkt_shares);
    put(u"max_open_risk_usd"_s, own.max_open_risk_usd);
    put(u"max_underlying_contracts"_s, own.max_underlying_contracts);
    return out;
}

OJson numMap(const contract::OrderedMap<double>& m) {
    OJson out = js::object();
    for (const QString& k : m.keys()) out.set(k, js::N(m.value(k)));
    return out;
}

}  // namespace

MethodTable SettingsHandlers::methods() {
    ContractTable t;
    t.async(u"llm.catalog"_s, [this](OJson) { return llmCatalog(); });
    t.async(u"llm.patch"_s, [this](OJson p) { return llmPatch(std::move(p)); });
    t.async(u"llm.test"_s, [this](OJson p) { return llmTest(std::move(p)); });
    t.sync(u"settings.get"_s, [this](const OJson&) { return settingsGet(); });
    t.sync(u"settings.patch"_s, [this](const OJson& p) { return settingsPatch(p); });
    t.async(u"keychain.set"_s, [this](OJson p) { return keychainSet(std::move(p)); });
    t.sync(u"data.export"_s, [this](const OJson& p) { return dataExport(p); });
    t.sync(u"data.backups"_s, [this](const OJson&) { return dataBackups(); });
    t.sync(u"data.backup"_s, [this](const OJson&) { return dataBackup(); });
    return t.take();
}

// ---- 大模型接入 ------------------------------------------------------
/// 界面一打开就来问:「已配置」只查有没有存过,不解密——解密会让 macOS 弹窗问人(secrets.ts)。
util::Task<OJson> SettingsHandlers::llmCatalog() {
    const contract::LLMConfig cfg = settings().llm;
    QStringList names;
    for (const auto& [k, v] : prov::providersTable().fields) names.append(k);
    // Promise.all(names.map(...)):全部先发出去,再按序等
    QList<util::Task<bool>> found;
    for (const QString& name : names) found.append(util::secretExists(cfg.keychain_service, name));
    OJson keys = js::object();
    for (int i = 0; i < names.size(); ++i) keys.set(names[i], js::B(co_await found[i]));
    co_return js::object({{u"providers"_s, prov::providerCatalog()},
                          {u"current"_s, js::object({{u"provider"_s, js::S(cfg.provider)},
                                                     {u"model"_s, js::S(cfg.model)},
                                                     {u"base_url"_s, js::S(cfg.base_url)},
                                                     {u"effort"_s, js::S(cfg.effort)},
                                                     {u"temperature"_s, OJson::fromQJson(cfg.temperature)},
                                                     {u"max_tokens"_s, js::N(cfg.max_tokens)},
                                                     {u"timeout_s"_s, js::N(cfg.timeout_s)},
                                                     {u"keychain_service"_s, js::S(cfg.keychain_service)},
                                                     {u"keychain_account"_s, js::S(cfg.keychain_account)}})},
                          {u"key_configured"_s, keys}});
}

/// 改模型配置。切供应商时 keychain_account 跟着切,避免用错那把 key。
util::Task<OJson> SettingsHandlers::llmPatch(OJson params) {
    OJson patch = js::isObj(params.get(u"llm"_s)) ? *params.get(u"llm"_s) : js::object();
    QStringList unknown;
    for (const auto& [k, v] : patch.fields)
        if (!kLlmFields.contains(k)) unknown.append(k);
    if (!unknown.isEmpty()) throw RpcError(-32602, u"不允许修改的字段:"_s + sorted(unknown).join(u"、"_s));
    if (patch.get(u"provider"_s)) patch.set(u"keychain_account"_s, *patch.get(u"provider"_s));
    try {
        domain::patchConfigFile(settings().source_path, js::object({{u"llm"_s, patch}}));
    } catch (const util::JsError& exc) {
        throw RpcError(-32007, u"配置校验失败,已回滚:"_s + exc.message());
    }
    const OJson detail = js::object({{u"patch"_s, patch}});
    ports_.engine().store().audit(u"ui"_s, u"llm_patch"_s, &detail);
    ctx().reload();
    const OJson catalog = co_await llmCatalog();
    emitEvent(u"llm"_s, catalog);
    co_return catalog;
}

/**
 * 真打一次最小请求。允许带一把未保存的 key 先试。
 * 已保存的 key 只发往保存时的那个端点(安全审计 #3):
 *  · 覆盖项和 llm.patch 同一张白名单;配置上有、白名单外的键(keychain_*)原话拒——那只可能是在另指凭证条目;
 *  · 供应商或 Base URL 和已保存的不一样,这一次就必须自己带 api_key,凭证库一眼都不看。
 */
util::Task<OJson> SettingsHandlers::llmTest(OJson params) {
    const contract::LLMConfig saved = settings().llm;
    const OJson overrides = js::isObj(params.get(u"llm"_s)) ? *params.get(u"llm"_s) : js::object();
    static const QStringList savedKeys{u"provider"_s, u"model"_s, u"effort"_s, u"temperature"_s, u"base_url"_s, u"max_tokens"_s, u"timeout_s"_s, u"keychain_service"_s, u"keychain_account"_s};
    QStringList forbidden;
    for (const auto& [k, v] : overrides.fields)
        if (savedKeys.contains(k) && !kLlmFields.contains(k)) forbidden.append(k);
    if (!forbidden.isEmpty()) {
        throw RpcError(-32602, u"不允许修改的字段:"_s + sorted(forbidden).join(u"、"_s) + u"(测试用哪把 Key 只跟着供应商走,不能另指凭证条目)"_s);
    }
    OJson merged = llmConfigJson(saved);
    for (const auto& [k, v] : overrides.fields)
        if (kLlmFields.contains(k)) merged.set(k, v);
    // 同一家:用的就是解析时那一条凭证(配置里的 keychain_account,不一定等于供应商名);换了家:只是占位,下面要求现填 key
    const OJson* mergedProvider = merged.get(u"provider"_s);
    const bool sameProvider = js::isStr(mergedProvider) && mergedProvider->s == saved.provider;
    merged.set(u"keychain_account"_s, sameProvider ? js::S(saved.keychain_account) : *mergedProvider);
    contract::LLMConfig cfg;
    cfg.provider = js::str(merged.get(u"provider"_s));
    cfg.model = js::str(merged.get(u"model"_s));
    cfg.effort = js::str(merged.get(u"effort"_s));
    cfg.temperature = merged.get(u"temperature"_s)->toQJson();
    cfg.base_url = js::str(merged.get(u"base_url"_s));
    cfg.max_tokens = js::num(merged.get(u"max_tokens"_s));
    cfg.timeout_s = js::num(merged.get(u"timeout_s"_s));
    cfg.keychain_service = js::str(merged.get(u"keychain_service"_s));
    cfg.keychain_account = js::str(merged.get(u"keychain_account"_s));
    std::optional<QString> explicitKey;
    if (js::truthy(params.get(u"api_key"_s))) explicitKey = js::str(params.get(u"api_key"_s));
    // 例外:换到的是只连自家官方端点的供应商(Anthropic 不读 base_url):那把 Key 只可能发往它自己的服务器,不必让人为了"测一下"再填一遍。
    const OJson* meta = prov::providersTable().get(cfg.provider);
    bool needsBaseUrl = true;
    if (meta && !js::nullish(meta->get(u"needs_base_url"_s))) needsBaseUrl = js::truthy(meta->get(u"needs_base_url"_s));
    const bool fixedEndpoint = !needsBaseUrl;
    if (!explicitKey && !sameEndpoint(cfg, saved) && !fixedEndpoint) {
        throw RpcError(-32602, u"换了供应商或 Base URL 来测试时,要在这次测试里填上 API Key:已保存的 Key 只会发往保存时的那个端点,不会发往新地址。"_s);
    }
    try {
        const auto parser = buildParserHook ? buildParserHook(cfg, explicitKey) : prov::buildParser(cfg, explicitKey);
        const prov::TestProbe probe = co_await parser->test();
        OJson result = js::object({{u"ok"_s, js::B(probe.ok)},
                                   {u"model"_s, probe.model},
                                   {u"latency_ms"_s, js::N(probe.latency_ms)},
                                   {u"structured_mode"_s, js::S(probe.structured_mode)},
                                   {u"usage"_s, probe.usage},
                                   {u"sample"_s, js::S(probe.sample)}});
        result.set(u"provider"_s, js::S(cfg.provider));
        co_return result;
    } catch (const domain::LLMError& exc) {
        co_return js::object({{u"ok"_s, js::B(false)}, {u"error"_s, js::S(exc.message())}, {u"provider"_s, js::S(cfg.provider)}, {u"model"_s, js::S(cfg.model)}});
    } catch (const util::KeychainError& exc) {
        co_return js::object({{u"ok"_s, js::B(false)}, {u"error"_s, js::S(exc.message())}, {u"provider"_s, js::S(cfg.provider)}, {u"model"_s, js::S(cfg.model)}});
    } catch (const util::JsError& exc) {
        // 模型与凭证库的错本身就是人话,别的错带上类名好排查(C++ 认不出 JS 的类名,一律 Error)
        co_return js::object({{u"ok"_s, js::B(false)}, {u"error"_s, js::S(u"Error: "_s + exc.message())}, {u"provider"_s, js::S(cfg.provider)}, {u"model"_s, js::S(cfg.model)}});
    }
}

// ---- 设置 -----------------------------------------------------------
OJson SettingsHandlers::settingsGet() {
    const domain::Settings& s = settings();
    const contract::Limits& L = s.limits;
    OJson byAccount = js::object();
    for (const QString& alias : L.by_account.keys()) byAccount.set(alias, accountLimitsJson(*L.by_account.find(alias)));
    const contract::Policies& P = s.policies;
    const contract::ProtectionsConfig& R = s.protections;
    const contract::FollowConfig& F = s.follow;
    OJson connections = js::object();
    for (const QString& name : s.connections.keys()) {
        const contract::ConnectionConfig* c = s.connections.find(name);
        connections.set(name, js::object({{u"host"_s, js::S(c->host)}, {u"port"_s, js::N(c->port)}}));
    }
    OJson aliases = js::object();
    for (const QString& k : s.symbol_aliases.keys()) aliases.set(k, js::S(s.symbol_aliases.value(k)));
    return js::object(
        {{u"path"_s, js::S(s.source_path ? *s.source_path : u"null"_s)},
         {u"llm"_s, js::object({{u"model"_s, js::S(s.llm.model)}, {u"effort"_s, js::S(s.llm.effort)}, {u"max_tokens"_s, js::N(s.llm.max_tokens)}})},
         {u"limits"_s, js::object({{u"max_order_notional"_s, js::N(L.max_order_notional)},
                                   {u"max_option_contracts"_s, js::N(L.max_option_contracts)},
                                   {u"max_mkt_shares"_s, js::N(L.max_mkt_shares)},
                                   {u"min_confidence"_s, js::N(L.min_confidence)},
                                   {u"max_spread_slippage"_s, js::N(L.max_spread_slippage)},
                                   {u"max_orders_per_input"_s, js::N(L.max_orders_per_input)},
                                   {u"duplicate_window_minutes"_s, js::N(L.duplicate_window_minutes)},
                                   {u"duplicate_qty_tolerance"_s, js::N(L.duplicate_qty_tolerance)},
                                   {u"max_open_risk_usd"_s, js::N(L.max_open_risk_usd)},
                                   {u"max_underlying_contracts"_s, js::N(L.max_underlying_contracts)},
                                   {u"auto_mid_spread_share"_s, js::N(L.auto_mid_spread_share)},
                                   {u"by_account"_s, byAccount}})},
         {u"policies"_s, js::object({{u"auto_execute"_s, js::B(P.auto_execute)},
                                     {u"allow_live_trading"_s, js::B(P.allow_live_trading)},
                                     {u"auto_outside_rth"_s, js::B(P.auto_outside_rth)},
                                     {u"require_trigger_price_verification"_s, js::B(P.require_trigger_price_verification)},
                                     {u"trigger_min_gap_bps"_s, js::N(P.trigger_min_gap_bps)},
                                     {u"closed_market_policy"_s, js::S(P.closed_market_policy)},
                                     {u"consecutive_failure_breaker"_s, js::N(P.consecutive_failure_breaker)},
                                     {u"review_feature_enabled"_s, js::B(P.review_feature_enabled)}})},
         {u"protections"_s, js::object({{u"stoploss_guard"_s, js::object({{u"enabled"_s, js::B(R.stoploss_guard.enabled)},
                                                                         {u"lookback_minutes"_s, js::N(R.stoploss_guard.lookback_minutes)},
                                                                         {u"trigger_count"_s, js::N(R.stoploss_guard.trigger_count)},
                                                                         {u"pause_minutes"_s, js::N(R.stoploss_guard.pause_minutes)}})},
                                        {u"max_drawdown"_s, js::object({{u"enabled"_s, js::B(R.max_drawdown.enabled)},
                                                                       {u"lookback_minutes"_s, js::N(R.max_drawdown.lookback_minutes)},
                                                                       {u"max_drawdown_usd"_s, js::N(R.max_drawdown.max_drawdown_usd)},
                                                                       {u"pause_minutes"_s, js::N(R.max_drawdown.pause_minutes)}})},
                                        {u"cooldown"_s, js::object({{u"enabled"_s, js::B(R.cooldown.enabled)},
                                                                   {u"minutes"_s, js::N(R.cooldown.minutes)},
                                                                   {u"scope"_s, js::S(R.cooldown.scope)}})},
                                        {u"daily_loss"_s, js::object({{u"enabled"_s, js::B(R.daily_loss.enabled)},
                                                                     {u"max_loss_usd"_s, js::N(R.daily_loss.max_loss_usd)},
                                                                     {u"basis"_s, js::S(R.daily_loss.basis)}})}})},
         {u"risk_budget"_s, js::object({{u"enabled"_s, js::B(s.risk_budget.enabled)},
                                        {u"equity_usd"_s, numMap(s.risk_budget.equity_usd)},
                                        {u"max_risk_pct"_s, js::N(s.risk_budget.max_risk_pct)},
                                        {u"max_position_pct"_s, js::N(s.risk_budget.max_position_pct)}})},
         {u"follow"_s, js::object({{u"enabled"_s, js::B(F.enabled)},
                                   {u"channel_id"_s, js::S(F.channel_id)},
                                   {u"author_ids"_s, js::strings(F.author_ids)},
                                   {u"accounts"_s, js::strings(F.accounts)},
                                   {u"max_age_seconds"_s, js::N(F.max_age_seconds)},
                                   {u"max_orders_per_day"_s, js::N(F.max_orders_per_day)},
                                   {u"max_risk_usd"_s, js::N(F.max_risk_usd)},
                                   {u"local_inbox"_s, js::B(F.local_inbox)},
                                   {u"local_channel"_s, js::S(F.local_channel)},
                                   {u"track_fly"_s, js::B(F.track_fly)},
                                   {u"track_exit_at"_s, js::S(F.track_exit_at)}})},
         {u"symbol_aliases"_s, aliases},
         {u"accounts"_s, accounts()},
         {u"connections"_s, connections}});
}

OJson SettingsHandlers::settingsPatch(const OJson& params) {
    const OJson* given = params.get(u"patch"_s);
    const OJson patch = js::nullish(given) ? js::object() : *given;
    if (patch.type != OJson::Object) throw RpcError(-32602, u"patch 必须是对象"_s);
    QStringList forbidden;
    for (const QString& k : {u"accounts"_s, u"connections"_s})
        if (patch.get(k)) forbidden.append(k);
    if (!forbidden.isEmpty()) {
        // 账户与连接牵涉真实账号,只允许人手动改配置文件,不给 UI 通道(§9.6)
        throw RpcError(-32006, u"账户与连接配置不允许从界面修改:"_s + sorted(forbidden).join(u", "_s));
    }
    // 只认契约里写着的五段(SettingsPatch)。段**里面**的键 config.fromDict 会逐个校验,但它不看顶层
    QStringList unknown;
    for (const auto& [k, v] : patch.fields)
        if (!kPatchable.contains(k)) unknown.append(k);
    if (!unknown.isEmpty()) {
        throw RpcError(-32602, u"settings.patch 只能改 policies / limits / protections / risk_budget / follow,收到:"_s + sorted(unknown).join(u"、"_s)
                                   + u"(模型配置走 llm.patch,券商切换走 broker.select,其余只能手改配置文件)"_s);
    }
    try {
        domain::patchConfigFile(settings().source_path, patch);
    } catch (const util::JsError& exc) {
        throw RpcError(-32007, u"配置校验失败,已回滚:"_s + exc.message());
    }
    const OJson detail = js::object({{u"patch"_s, patch}});
    ports_.engine().store().audit(u"ui"_s, u"settings_patch"_s, &detail);
    ctx().reload();
    emitEvent(u"settings"_s, settingsGet());
    return settingsGet();
}

util::Task<OJson> SettingsHandlers::keychainSet(OJson params) {
    const QString secret = hu::strOr(params.get(u"secret"_s));
    try {
        const QString account = js::truthy(params.get(u"provider"_s)) ? js::str(params.get(u"provider"_s)) : settings().llm.keychain_account;
        co_await util::writeSecret(settings().llm.keychain_service, account, secret);
    } catch (const util::KeychainError& exc) {
        throw RpcError(-32008, exc.message());
    }
    const OJson detail = js::object({{u"service"_s, js::S(settings().llm.keychain_service)}});
    ports_.engine().store().audit(u"ui"_s, u"keychain_set"_s, &detail);
    co_return js::object({{u"ok"_s, js::B(true)}});
}

OJson SettingsHandlers::dataExport(const OJson& params) {
    const QString target = hu::strOr(params.get(u"path"_s));
    if (target.isEmpty()) throw RpcError(-32602, u"缺少导出路径"_s);
    const OJson data = ports_.engine().store().exportAll();
    // 里面是整本交易记录(含真实账号):只给本人读写。Windows 上 mode 不起作用,尽力而为
    {
        QFile f(target);
        const bool existed = f.exists();
        if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
            throw util::JsError(u"ENOENT: no such file or directory, open '%1'"_s.arg(target));
        }
        if (!existed) f.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner);
        f.write(util::toNodeUtf8(util::stringifyOJson(data, 2)));
    }
    const OJson detail = js::object({{u"path"_s, js::S(target)}});
    ports_.engine().store().audit(u"ui"_s, u"export"_s, &detail);
    const OJson* records = data.get(u"records"_s);
    return js::object({{u"path"_s, js::S(target)}, {u"records"_s, js::N(records ? records->items.size() : 0)}});
}

// ---- 备份(口径见 storeSafety.ts)--------------------------------------
OJson SettingsHandlers::dataBackups() {
    const QString dbPath = ports_.engine().store().dbPath;
    return js::object({{u"db_path"_s, js::S(dbPath)},
                       {u"dir"_s, js::S(domain::backupDir(dbPath))},
                       {u"schema_version"_s, js::N(domain::kSchemaVersion)},
                       {u"backups"_s, js::array(domain::listBackups(dbPath))}});
}

OJson SettingsHandlers::dataBackup() {
    try {
        const OJson backup = ports_.engine().store().backupNow(u"manual"_s);
        const OJson detail = js::object({{u"name"_s, js::copyOrNull(backup.get(u"name"_s))}, {u"bytes"_s, js::copyOrNull(backup.get(u"bytes"_s))}});
        ports_.engine().store().audit(u"ui"_s, u"backup"_s, &detail);
        return js::object({{u"backup"_s, backup}});
    } catch (const util::JsError& exc) {
        throw RpcError(-32009, u"备份没有成功:"_s + exc.message() + u"。请检查磁盘剩余空间与备份目录的权限。"_s);
    }
}

}  // namespace ibkr::rpc
