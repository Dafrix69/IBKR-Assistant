#include "transport/handlers/connection_handlers.h"

#include "domain/store.h"
#include "execution/tws_detect.h"
#include "transport/handlers/handler_util.h"
#include "util/jsvalue.h"
#include "util/keychain.h"
#include "util/secrets.h"

#include <QCryptographicHash>
#include <QRegularExpression>

#include <algorithm>

using namespace Qt::StringLiterals;

namespace ibkr::rpc {

namespace js = util::js;
namespace tws = execution::twsdetect;
using util::OJson;
using util::RpcError;

namespace {

const QStringList kBrokerKeys{u"ibkr"_s, u"futu"_s};
QString brokerLabel(const QString& key) {
    return key == u"ibkr" ? u"盈透证券(IBKR / TWS)"_s : u"富途证券(OpenD)"_s;
}

/// Object.entries(settings.connectionsFor(key)).map(([name, c]) => [name, {host, port, client_id}])
OJson connectionsJson(const contract::OrderedMap<contract::ConnectionConfig>& conns, bool withClientId) {
    OJson out = js::object();
    for (const QString& name : conns.keys()) {
        const contract::ConnectionConfig* c = conns.find(name);
        OJson one = js::object({{u"host"_s, js::S(c->host)}, {u"port"_s, js::N(c->port)}});
        if (withClientId) one.set(u"client_id"_s, js::N(c->client_id));
        out.set(name, one);
    }
    return out;
}

OJson stringsJson(const QStringList& l) { return js::strings(l); }

[[noreturn]] void futuUnsupported(const QString& method) {
    throw RpcError(-32601, u"富途接入不在这个版本里:"_s + method);
}

}  // namespace

QString configSnippet(const QString& provider) {
    const double port = domain::defaultBrokerPort(provider);
    const bool futu = provider == u"futu";
    const QString account = futu ? u"8801234(富途账号,一串数字)"_s : u"DU0000000"_s;
    OJson connections = js::object();
    connections.set(provider, js::object({{u"broker"_s, js::S(provider)}, {u"host"_s, js::S(u"127.0.0.1"_s)}, {u"port"_s, js::N(port)}}));
    const OJson doc = js::object({{u"connections"_s, connections},
                                  {u"accounts"_s, js::array({js::object({{u"alias"_s, js::S(futu ? u"富途模拟"_s : u"模拟"_s)},
                                                                         {u"account_id"_s, js::S(account)},
                                                                         {u"is_paper"_s, js::B(true)},
                                                                         {u"connection"_s, js::S(provider)}})})}});
    return util::stringifyOJson(doc, 2);
}

MethodTable ConnectionHandlers::methods() {
    ContractTable t;
    t.async(u"broker.catalog"_s, [this](OJson) { return brokerCatalog(); });
    t.async(u"broker.select"_s, [this](OJson p) { return brokerSelect(std::move(p)); });
    t.async(u"broker.connect"_s, [this](OJson p) { return brokerConnect(std::move(p)); });
    t.async(u"broker.disconnect"_s, [this](OJson) { return brokerDisconnect(); });
    t.async(u"tws.scan"_s, [this](OJson) { return twsScan(); });
    t.async(u"tws.diagnose"_s, [this](OJson p) { return twsDiagnose(std::move(p)); });
    t.sync(u"tws.launch"_s, [this](const OJson& p) { return twsLaunch(p); });
    t.sync(u"futu.scan"_s, [](const OJson&) -> OJson { futuUnsupported(u"futu.scan"_s); });
    t.sync(u"futu.diagnose"_s, [](const OJson&) -> OJson { futuUnsupported(u"futu.diagnose"_s); });
    t.sync(u"futu.launch"_s, [](const OJson&) -> OJson { futuUnsupported(u"futu.launch"_s); });
    t.sync(u"futu.unlock"_s, [this](const OJson& p) { return futuUnlock(p); });
    t.async(u"futu.set_password"_s, [this](OJson p) { return futuSetPassword(std::move(p)); });
    return t.take();
}

// ---- 券商连接 --------------------------------------------------------
util::Task<OJson> ConnectionHandlers::brokerCatalog() {
    const QString provider = settings().broker.provider;
    const contract::FutuConfig futuCfg = settings().broker.futu;
    // 只查有没有存过,不解密:解密会让 macOS 弹窗问人(secrets.ts)
    const bool unlockSaved = co_await util::secretExists(futuCfg.keychain_service, futuCfg.keychain_account);
    const auto router = ports_.router();
    OJson providers = js::array();
    for (const QString& key : kBrokerKeys) {
        OJson accountsOut = js::array();
        for (const contract::AccountConfig& a : settings().accounts) {
            if (settings().accountBroker(a) != key) continue;
            accountsOut.items.append(js::object({{u"alias"_s, js::S(a.alias)},
                                                 {u"account_masked"_s, js::S(domain::redactAccount(a.account_id))},
                                                 {u"is_paper"_s, js::B(a.is_paper)},
                                                 {u"connection"_s, js::S(a.connection)},
                                                 {u"default"_s, js::B(a.isDefault)}}));
        }
        const auto conns = settings().connectionsFor(key);
        providers.items.append(js::object({{u"key"_s, js::S(key)},
                                           {u"label"_s, js::S(brokerLabel(key))},
                                           {u"current"_s, js::B(key == provider)},
                                           {u"connections"_s, connectionsJson(conns, true)},
                                           {u"accounts"_s, accountsOut},
                                           // 没配连接就把该抄的那段配置直接给出来
                                           {u"config_snippet"_s, conns.isEmpty() ? js::S(configSnippet(key)) : js::Null()}}));
    }
    OJson symbolMap = js::object();
    for (const QString& k : futuCfg.symbol_map.keys()) symbolMap.set(k, js::S(futuCfg.symbol_map.value(k)));
    co_return js::object({{u"current"_s, js::S(provider)},
                          {u"connected"_s, router ? stringsJson(router->connectedNames()) : js::array()},
                          {u"providers"_s, providers},
                          {u"futu"_s, js::object({{u"trd_market"_s, js::S(futuCfg.trd_market)},
                                                  {u"security_firm"_s, js::S(futuCfg.security_firm)},
                                                  {u"symbol_map"_s, symbolMap},
                                                  {u"unlock_password_saved"_s, js::B(unlockSaved)}})}});
}

/// 切换生效的券商接入。切之前先把旧连接断干净。
util::Task<OJson> ConnectionHandlers::brokerSelect(OJson params) {
    const QString provider = hu::strOr(params.get(u"provider"_s));
    if (!kBrokerKeys.contains(provider)) throw RpcError(-32602, u"只支持 "_s + kBrokerKeys.join(u"、"_s));
    if (settings().connectionsFor(provider).isEmpty()) {
        // 切到一家却没有它的连接 = 切进空档。刻意不替用户补(§9.6)。
        throw RpcError(-32006, u"配置里还没有 "_s + brokerLabel(provider) + u" 的连接和账户。"_s + u"请在 config/settings.json 里加上,再回来切换:\n"_s + configSnippet(provider));
    }
    try {
        ctx().setSettings(domain::patchConfigFile(settings().source_path, js::object({{u"broker"_s, js::object({{u"provider"_s, js::S(provider)}})}})));
    } catch (const util::JsError& exc) {
        throw RpcError(-32007, u"切换券商失败,配置未改动:"_s + exc.message());
    }
    if (const auto router = ports_.router()) {
        co_await router->disconnectAll();
        ports_.clearRouter();
    }
    ports_.brokerLink().forget();
    ctx().dropEngine();
    const OJson detail = js::object({{u"provider"_s, js::S(provider)}});
    ports_.engine().store().audit(u"ui"_s, u"broker_select"_s, &detail);
    QStringList names = settings().connectionsFor(provider).keys();
    std::sort(names.begin(), names.end());
    co_return js::object({{u"current"_s, js::S(provider)}, {u"connections"_s, stringsJson(names)}});
}

/// 连接 / 断开的整条路在 services/brokerLink.ts:启动自动连、断线重连提醒与这里的按钮共用。
util::Task<OJson> ConnectionHandlers::brokerConnect(OJson params) {
    std::optional<QStringList> names;
    if (const OJson* c = params.get(u"connections"_s); !js::nullish(c)) {
        QStringList l;
        for (const OJson& x : c->items) l.append(x.s);
        names = l;
    }
    co_return co_await ports_.brokerLink().connect(names);
}

util::Task<OJson> ConnectionHandlers::brokerDisconnect() {
    co_await ports_.brokerLink().disconnect();
    co_return js::object({{u"connected"_s, js::array()}});
}

// ---- TWS 检测(§9.1:本模块不接触任何 IBKR 凭证)------------------------
util::Task<OJson> ConnectionHandlers::twsScan() {
    OJson portsJson = js::array();
    const domain::Settings snapshot = settings();  // 协程跨 await,别拿会被换掉的那份的引用
    for (const auto& p : co_await tws::scanPorts(snapshot)) portsJson.items.append(p.toJson());
    OJson apps = js::array();
    for (const auto& a : tws::detectApps()) apps.items.append(a.toJson());
    OJson guide = js::array();
    for (const auto& g : tws::connectionGuide(settings())) guide.items.append(g.toJson());
    const OJson connections = connectionsJson(settings().connections, true);
    const auto router = ports_.router();
    co_return js::object({{u"ports"_s, portsJson},
                          {u"apps"_s, apps},
                          {u"guide"_s, guide},
                          {u"connections"_s, connections},
                          {u"connected"_s, router ? stringsJson(router->connectedNames()) : js::array()}});
}

util::Task<OJson> ConnectionHandlers::twsDiagnose(OJson params) {
    QStringList names;
    if (const OJson* c = params.get(u"connections"_s); !js::nullish(c)) {
        for (const OJson& x : c->items) names.append(x.s);
    } else {
        names = settings().connections.keys();
        std::sort(names.begin(), names.end());
    }
    QStringList unknown;
    for (const QString& n : names)
        if (!settings().connections.contains(n)) unknown.append(n);
    if (!unknown.isEmpty()) throw RpcError(-32602, u"未定义的连接:"_s + unknown.join(u"、"_s));
    OJson results = js::array();
    for (const QString& name : names) {
        try {
            results.items.append(co_await tws::diagnose(settings(), name));
        } catch (const util::JsError& exc) {
            // 诊断失败本身就是要展示的结果
            results.items.append(js::object({{u"connection"_s, js::S(name)}, {u"connected"_s, js::B(false)}, {u"error"_s, js::S(exc.message())}, {u"hint"_s, js::Null()}}));
        }
    }
    emitEvent(u"tws"_s, js::object({{u"results"_s, results}}));
    co_return js::object({{u"results"_s, results}});
}

OJson ConnectionHandlers::twsLaunch(const OJson& params) {
    const QString key = hu::strOr(params.get(u"app"_s));
    OJson result;
    try {
        result = tws::launchApp(key).toJson();
    } catch (const util::JsError& exc) {
        throw RpcError(-32009, exc.message());
    }
    const OJson detail = js::object({{u"app"_s, js::S(key)}, {u"path"_s, js::copyOrNull(result.get(u"path"_s))}});
    ports_.engine().store().audit(u"ui"_s, u"tws_launch"_s, &detail);
    return result;
}

// ---- 富途 OpenD(只剩写凭证与解锁的前置检查)-----------------------------
/// 存交易解锁密码。只存 md5,绝不存明文,也绝不回显任何一段。
util::Task<OJson> ConnectionHandlers::futuSetPassword(OJson params) {
    QString secret = hu::strOr(params.get(u"password"_s));
    if (secret.isEmpty()) throw RpcError(-32602, u"交易解锁密码为空"_s);
    if (!js::truthy(params.get(u"already_md5"_s))) {
        secret = QString::fromLatin1(QCryptographicHash::hash(util::toNodeUtf8(secret), QCryptographicHash::Md5).toHex());
    }
    secret = util::jsTrim(secret).toLower();
    static const QRegularExpression hex(u"^[0-9a-f]{32}\\z"_s);
    if (secret.size() != 32 || !hex.match(secret).hasMatch()) {
        throw RpcError(-32602, u"勾了「已经是 md5」,但填的不是 32 位十六进制字符串"_s);
    }
    const contract::FutuConfig futuCfg = settings().broker.futu;
    try {
        co_await util::writeSecret(futuCfg.keychain_service, futuCfg.keychain_account, secret);
    } catch (const util::KeychainError& exc) {
        throw RpcError(-32008, exc.message());
    }
    const OJson detail = js::object({{u"service"_s, js::S(futuCfg.keychain_service)}});
    ports_.engine().store().audit(u"ui"_s, u"futu_password_set"_s, &detail);
    co_return js::object({{u"ok"_s, js::B(true)}});
}

/// 实盘交易解锁。密码从 Keychain / DPAPI 读,不经过界面。
OJson ConnectionHandlers::futuUnlock(const OJson&) {
    if (settings().broker.provider != u"futu") throw RpcError(-32010, u"当前券商接入不是富途,无需解锁。"_s);
    // 没有富途 router(不移植):TS 里 `!("unlock" in this.router)` 的那一支
    throw RpcError(-32004, u"尚未连接富途 OpenD,请先在下面点「连接 / 断开交易引擎」。"_s);
}

}  // namespace ibkr::rpc
