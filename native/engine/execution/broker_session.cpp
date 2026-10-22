// BrokerRouter:连接与会话(connect / 重连 / disconnectAll)、账户路由(forAccount)、合约确认(qualify*)。broker.ts 的前半。
#include "execution/broker.h"

#include "execution/broker_internal.h"
#include "execution/ib_contracts.h"
#include "execution/ib_link_down.h"
#include "execution/ib_session.h"
#include "execution/qualify_gate.h"
#include "util/jsformat.h"
#include "util/js_runtime.h"
#include "util/jsobj.h"

#include <algorithm>
#include <cmath>

namespace ibkr::execution {

using namespace Qt::StringLiterals;
using util::OJson;
using util::Task;
namespace js = util::js;
using detail::messageOf;
using detail::prop;

BrokerRouter::BrokerRouter(domain::Settings s, IbSessionFactory factory)
    : settings(std::move(s)),
      factory_(factory ? std::move(factory)
                       : IbSessionFactory([](SessionConfig cfg) -> Task<std::shared_ptr<IbSession>> { return createIbApiNextSession(std::move(cfg)); })) {
    sleepHook = [](int ms) { return util::sleepMs(ms); };
}

BrokerRouter::~BrokerRouter() = default;

// ---- 连接 -----------------------------------------------------------
contract::OrderedMap<contract::ConnectionConfig> BrokerRouter::connections() const { return settings.connectionsFor(kBroker); }

Task<BrokerRouter::SessionPtr> BrokerRouter::connect(QString connectionName) {
    SessionPtr existing = connectionsMap_.value(connectionName);
    if (existing && existing->isConnected()) co_return existing;
    if (existing) co_await existing->disconnect();  // 断着的旧会话先停掉它自己的重连,别和新会话抢同一个 client id
    const auto conns = connections();
    const contract::ConnectionConfig* cfg = conns.find(connectionName);
    if (!cfg) throw BrokerError(u"未定义的连接:%1(这里只在 IBKR 连接里查找)"_s.arg(connectionName));
    SessionPtr session;
    std::exception_ptr failure;
    try {
        session = co_await factory_(SessionConfig{cfg->host, static_cast<int>(cfg->port), static_cast<int>(cfg->client_id), cfg->readonly});
    } catch (...) {
        failure = std::current_exception();
    }
    if (failure) {
        throw BrokerError(u"连接 %1 (%2:%3) 失败:%4。"_s.arg(connectionName, cfg->host, util::jsNumberToString(cfg->port), messageOf(failure)) +
                          u"请确认 TWS/IB Gateway 已启动且开启了本机 API。"_s);
    }
    // TWS↔IBKR 那一段的通断按连接记(见 UpstreamWatch);本机 socket 的通断交给服务层提醒、留痕
    const std::weak_ptr<bool> alive = alive_;
    upstream_.watch(connectionName, session, [this, alive, connectionName](bool up) {
        if (alive.expired()) return;
        if (linkHook) linkHook(connectionName, up);
    });
    connectionsMap_.insert(connectionName, session);
    // 只服务纸面账户的会话,行情类型基线定成 3(有实时权限照样是实时,没有才给延迟)。实盘会话不动,仍是 1:实盘绝不拿延迟价定价。
    bool any = false, allPaper = true;
    for (const contract::AccountConfig& a : settings.accounts) {
        if (a.connection != connectionName) continue;
        any = true;
        if (!a.is_paper) allPaper = false;
    }
    if (any && allPaper && session->has(Cap::SetBaselineMarketDataType)) {
        try {
            session->setBaselineMarketDataType(3);
        } catch (...) {
            /* 设不上就照旧,每个取价点仍会自己切 */
        }
    }
    if (sessionHook) {
        try {
            sessionHook(session);
        } catch (...) {
            /* 挂监听失败不应阻断连接本身 */
        }
    }
    co_return session;
}

void BrokerRouter::warmIndexFutures() {
    if (settings.marketStatus(domain::nowEt()) == u"盘中") return;
    QStringList symbols;
    for (const QString& k : settings.index_symbols.keys()) {
        const contract::IndexConfig* c = settings.index_symbols.find(k);
        if (!c->futures.isEmpty()) symbols.append(c->symbol);
    }
    if (symbols.isEmpty()) return;
    util::detach(warmLoop(symbols, alive_));
}

Task<> BrokerRouter::warmLoop(QStringList symbols, std::weak_ptr<bool> alive) {
    // 首笔 tick 常常赶不上第一次(期货农场慢、10197 时不时来一下):隔三秒再试,最多五次
    for (int attempt = 0; attempt < 5; ++attempt) {
        bool allWarm = true;
        for (const QString& symbol : symbols) {
            try {
                co_await indexPrice(symbol);
            } catch (...) {
                /* 暖机失败不打扰任何人 */
            }
            if (alive.expired()) co_return;
            const auto info = spotInfo(symbol);
            const OJson* source = info ? prop(*info, u"source"_s) : nullptr;
            if (!(js::isStr(source) && source->s == u"futures")) allWarm = false;
        }
        if (allWarm || settings.marketStatus(domain::nowEt()) == u"盘中") co_return;
        co_await sleepHook(3000);
        if (alive.expired()) co_return;
    }
}

bool BrokerRouter::upstreamOk() const { return !upstream_.lost().has_value(); }

BrokerRouter::SessionPtr BrokerRouter::nextUnvisited(QSet<QString>& visited, QString* nameOut) {
    for (const QString& k : connectionsMap_.keys()) {
        if (visited.contains(k)) continue;
        visited.insert(k);
        if (nameOut) *nameOut = k;
        return connectionsMap_.value(k);
    }
    return nullptr;
}

Task<> BrokerRouter::disconnectAll() {
    cancelStreams();
    QSet<QString> visited;
    while (SessionPtr session = nextUnvisited(visited)) {
        co_await session->disconnect();  // 断着的也要停:库在后台每 5 秒重连,不停它会连回一个没人管、占着 client id 的会话
    }
    connectionsMap_ = {};
    accountRoute_.clear();
    upstream_.clear();
}

void BrokerRouter::cancelStreams() {
    const auto live = sessions();
    const SessionPtr session = live.empty() ? nullptr : live[0];
    if (session) {
        for (const QString& symbol : streams_.keys()) {
            try {
                session->cancelTicker(stockContract(symbol));
            } catch (...) {
                /* 撤不掉也不该拦住断开 */
            }
        }
        for (const QString& key : optionStreams_.keys()) {
            const HeldStream* entry = optionStreams_.find(key);
            if (!entry->contract) continue;
            try {
                session->cancelTicker(*entry->contract);
            } catch (...) {
                /* 同上 */
            }
        }
    }
    releaseVolumeStreams({});
    volumeRetry_ = {};
    streams_ = {};
    optionStreams_.clear();
    stockStreams_.clear();
    // 期货流挂在旧会话上,断开后句柄就死了;不清掉的话重连后会一直读一个不再更新的价
    futStreams_.clear();
    futuresBackoff_.clear();
}

Task<BrokerRouter::SessionPtr> BrokerRouter::forAccount(contract::AccountConfig account) {
    QStringList order;
    const QString cached = accountRoute_.value(account.account_id);
    const auto conns = connections();
    if (!cached.isEmpty() && conns.contains(cached)) order.append(cached);
    if (conns.contains(account.connection) && !order.contains(account.connection)) order.append(account.connection);
    for (const QString& name : conns.keys()) {
        if (!order.contains(name)) order.append(name);
    }
    if (order.isEmpty()) {
        throw BrokerError(u"账户 %1 绑的连接 %2 不是 IBKR 连接(当前券商接入:IBKR)。"_s.arg(account.alias, account.connection) +
                          u"请在设置里把它改到一条 IBKR 连接,或把券商接入切回对应的那一家。"_s);
    }

    QStringList failures;
    for (const QString& name : order) {
        SessionPtr session;
        try {
            session = co_await connect(name);
        } catch (const BrokerError& exc) {
            failures.append(exc.message());
            continue;
        }
        const QStringList managed = session->managedAccounts();
        if (managed.contains(account.account_id)) {
            if (name != account.connection) {
                logStderr(u"[router] 账户 %1 实际由连接 %2 管理"_s.arg(redactForLog(account.account_id), name) +
                          u"(配置写的是 %1),已自动改道"_s.arg(account.connection));
            }
            accountRoute_.insert(account.account_id, name);
            co_return session;
        }
        if (managed.isEmpty() && name == account.connection) co_return session;  // 会话没报账户列表:只对配置指定的连接放行
        failures.append(u"连接 %1 的会话不管理该账户(当前登录的可能是另一个账户)"_s.arg(name));
    }
    throw BrokerError(u"账户 %1 在所有已配置连接上都找不到对应会话:"_s.arg(account.alias) +
                      u"%1。"_s.arg(failures.isEmpty() ? u"无可用连接"_s : failures.join(u";"_s)) +
                      u"请确认 TWS 当前登录的就是这个账户,或核对配置端口。"_s);
}

std::vector<BrokerRouter::SessionPtr> BrokerRouter::sessions() {
    std::vector<SessionPtr> out;
    for (const QString& k : connectionsMap_.keys()) {
        SessionPtr s = connectionsMap_.value(k);
        if (s->isConnected()) out.push_back(std::move(s));
    }
    return out;
}

/// 此刻读得到持仓的账户别名:不在里面的账户,读不到不等于没有(见 ibLink.coveredAccounts)
QStringList BrokerRouter::coveredAccounts() {
    NamedSessions named;
    for (const QString& k : connectionsMap_.keys()) named.emplace_back(k, connectionsMap_.value(k));
    return execution::coveredAccounts(settings.accounts, named);
}

QStringList BrokerRouter::coveredAccountIds() {
    QStringList out;
    for (const contract::AccountConfig& a : settings.accounts) {
        if (!coveredAccounts().contains(a.alias)) continue;  // TS 的 filter 回调里每个账户各算一遍
        if (!out.contains(a.account_id)) out.append(a.account_id);
    }
    return out;
}

QStringList BrokerRouter::connectedNames() {
    QStringList out;
    for (const QString& k : connectionsMap_.keys()) {
        if (connectionsMap_.value(k)->isConnected()) out.append(k);
    }
    std::sort(out.begin(), out.end());
    return out;
}

BrokerRouter::SessionPtr BrokerRouter::marketSession() {
    const auto live = sessions();
    if (live.empty()) throw BrokerError(u"引擎未连接 TWS。请先在「TWS 连接」面板连接引擎。"_s);
    return live[0];
}

// ---- 合约 -----------------------------------------------------------

namespace {

/// c.x ?? "" 之后的写法;strike 是数,按 String(number)
QString conIdKey(const IbContract& c) {
    return QStringList{c.secType,
                       c.symbol,
                       c.lastTradeDateOrContractMonth.value_or(QString()),
                       c.strike ? util::jsNumberToString(*c.strike) : QString(),
                       c.right.value_or(QString()),
                       c.tradingClass.value_or(QString()),
                       c.exchange,
                       c.currency}
        .join(u'|');
}

/// `opt.conId` 的真假(undefined / 0 都是假)
bool hasConId(const IbContract& c) { return c.conId && *c.conId != 0; }

}  // namespace

Task<IbContract> BrokerRouter::qualify(OJson contract, contract::AccountConfig account) {
    const SessionPtr session = co_await forAccount(account);
    const QString secType = js::str(prop(contract, u"secType"_s));
    // 没给(undefined)才落到参数的缺省值;给了 null 就是 null——ContractSpec 的 schema 总会补齐这几格
    const auto strDef = [&](const char16_t* k, const QString& def) {
        const OJson* v = prop(contract, QString::fromUtf16(k));
        return v ? js::str(v) : def;
    };
    if (secType == u"STK") {
        IbContract target = stockContract(js::str(prop(contract, u"symbol"_s)), strDef(u"exchange", u"SMART"_s), strDef(u"currency", u"USD"_s));
        co_await qualifyOrRaise(session, &target, true);
        co_return target;
    }
    if (secType == u"OPT") {
        IbContract target = optionContract(js::str(prop(contract, u"symbol"_s)), js::str(prop(contract, u"lastTradeDateOrContractMonth"_s)),
                                           js::num(prop(contract, u"strike"_s)), js::str(prop(contract, u"right"_s)), js::str(prop(contract, u"exchange"_s)),
                                           strDef(u"currency", u"USD"_s), strDef(u"multiplier", u"100"_s), detail::strOr(prop(contract, u"tradingClass"_s)));
        co_await qualifyOrRaise(session, &target, true);
        co_return target;
    }
    co_return co_await buildBag(session, contract);
}

Task<IbContract> BrokerRouter::buildBag(SessionPtr session, OJson contract) {
    const QString symbol = js::str(prop(contract, u"symbol"_s));
    const QString exchange = js::str(prop(contract, u"exchange"_s));
    const QString currency = js::str(prop(contract, u"currency"_s));
    std::vector<IbContract> opts;
    const OJson* legsP = prop(contract, u"legs"_s);
    const QList<OJson> legs = js::nullish(legsP) ? QList<OJson>() : legsP->items;
    for (const OJson& leg : legs) {
        opts.push_back(optionContract(symbol, js::str(prop(leg, u"lastTradeDateOrContractMonth"_s)), js::num(prop(leg, u"strike"_s)),
                                      js::str(prop(leg, u"right"_s)), exchange, currency, js::str(prop(leg, u"multiplier"_s)),
                                      detail::strOr(prop(leg, u"tradingClass"_s))));
    }
    co_await qualifyAllOrRaise(session, &opts);
    IbContract bag;
    bag.secType = u"BAG"_s;
    bag.symbol = symbol;
    bag.currency = currency;
    bag.exchange = exchange;
    bag.hasComboLegs = true;
    for (size_t i = 0; i < opts.size(); ++i) {
        ComboLeg cl;
        cl.conId = opts[i].conId.value_or(0);
        cl.ratio = js::num(prop(legs[qsizetype(i)], u"ratio"_s));
        cl.action = js::str(prop(legs[qsizetype(i)], u"action"_s));
        cl.exchange = exchange;
        bag.comboLegs.push_back(cl);
    }
    co_return bag;
}

/// 一批合约一次往返确认,而不是逐个串行;缓存命中的连这一次都省掉。
Task<> BrokerRouter::qualifyAllOrRaise(SessionPtr session, std::vector<IbContract>* opts) {
    std::vector<IbContract*> need;
    for (IbContract& opt : *opts) {
        const int hit = conIdCache_.value(conIdKey(opt), 0);
        if (hit) opt.conId = hit;
        else need.push_back(&opt);
    }
    if (need.empty()) co_return;
    // 键必须在 qualify 之前算:qualify 会原地改写合约字段,事后算键与下次查询的"改写前"键对不上,缓存就永远 miss。
    QStringList needKeys;
    for (const IbContract* opt : need) needKeys.append(conIdKey(*opt));
    // 只有下单路径用它(组合的腿、AUTO_MID 定价):刚超时过也照样去问
    if (co_await qualifyGated(session, need, kQualifyTimeoutMs, true) == QualifyAnswer::Stalled) throw BrokerError(stalledMessage());
    for (size_t i = 0; i < need.size(); ++i) {
        if (!hasConId(*need[i])) {
            throw BrokerError(u"IBKR 无法确认该合约(%1),"_s.arg(describeContract(*need[i])) + u"可能是代码拼错、到期日或行权价不存在。已拦截。"_s);
        }
        conIdCache_.insert(needKeys[qsizetype(i)], *need[i]->conId);
    }
}

/// 确认得了回 Yes;认不出回 No;TWS 没回话(超时)回 Stalled——那不是认不出,过一会儿要再试;别的错照抛。常驻行情流用(heldStreams.ensure)
Task<QualifyKnown> BrokerRouter::qualifies(SessionPtr session, IbContract* contract) {
    std::optional<QualifyKnown> verdict;
    try {
        co_await qualifyOrRaise(session, contract);
    } catch (const BrokerError& exc) {
        verdict = exc.message() == stalledMessage() ? QualifyKnown::Stalled : QualifyKnown::No;
    }
    co_return verdict.value_or(QualifyKnown::Yes);
}

/// 这张期权此刻的时段:合约自己的(缓存里有才用,见 cachedContractHours),没有退回正股表
QString BrokerRouter::streamStatus(const QString& symbol, const QString& expiry) {
    const domain::EtNow now = domain::nowEt();
    const auto hours = cachedContractHours(symbol, expiry);
    if (hours) {
        const QString s = domain::hoursStatus((*hours)[0], (*hours)[2], now.epochMs, (*hours)[1]);
        if (!s.isEmpty()) return s;
    }
    return settings.marketStatus(now);
}

/// 合约确认必须有硬超时:TWS 上游断开时 socket 还活着,请求会永远等不到回应。
/// 只读的取数刚超时过就当场报,不再各等一个超时;wait = true 的(下单路径)照样去问(见 qualifyGate.ts)。
Task<> BrokerRouter::qualifyOrRaise(SessionPtr session, IbContract* contract, bool wait) {
    const QString key = conIdKey(*contract);
    const int hit = conIdCache_.value(key, 0);
    if (hit) {
        contract->conId = hit;
        co_return;
    }
    if (co_await qualifyGated(session, {contract}, kQualifyTimeoutMs, wait) == QualifyAnswer::Stalled) throw BrokerError(stalledMessage());
    if (!hasConId(*contract)) {
        throw BrokerError(u"IBKR 无法确认该合约(%1),"_s.arg(describeContract(*contract)) + u"可能是代码拼错、到期日或行权价不存在。已拦截。"_s);
    }
    conIdCache_.insert(key, *contract->conId);
}

QString BrokerRouter::stalledMessage() const {
    const std::optional<int> lost = upstream_.lost();
    if (lost) {
        return u"TWS 与 IBKR 服务器的连接已中断(错误 %1),请求到不了 IBKR。TWS 会自己一直重试,"_s.arg(*lost) +
               u"本机也会跟着重连 TWS,连回来就恢复;一直不恢复就检查网络,或在「TWS 连接」面板重连引擎。"_s;
    }
    return u"TWS 在 %1 秒内没有响应合约确认请求。"_s.arg(util::jsNumberToString(util::jsRound(kQualifyTimeoutMs / 1000.0))) +
           u"常见原因:TWS 正弹着确认框等你点、或它与 IBKR 的连接刚断开。处理完再试。"_s;
}

}  // namespace ibkr::execution
