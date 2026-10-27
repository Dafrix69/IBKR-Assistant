#include "transport/handlers/trading_handlers.h"

#include "domain/store.h"
#include "execution/broker_pricing.h"
#include "transport/handlers/handler_util.h"

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::rpc {

namespace js = util::js;
using util::OJson;
using util::RpcError;

namespace {

/// x ?? fallback(取值本身,null / undefined 换成 fallback)
OJson orElse(const OJson* v, const OJson& fallback) { return js::nullish(v) ? fallback : *v; }

}  // namespace

OJson summarizeRecord(const OJson& record) {
    const auto sub = [&record](const QString& key) -> const OJson& {
        static const OJson none = js::object();
        const OJson* v = js::prop(&record, key);
        return js::nullish(v) ? none : *v;
    };
    const OJson& account = sub(u"account"_s);
    const OJson& contract = sub(u"contract"_s);
    const OJson& order = sub(u"order"_s);
    const OJson& ibkr = sub(u"ibkr"_s);
    const OJson& llm = sub(u"llm"_s);
    const OJson& input = sub(u"input"_s);
    const OJson* timeline = js::prop(&ibkr, u"status_timeline"_s);
    OJson lastStatus = js::Null();
    if (js::isArr(timeline) && !timeline->items.isEmpty()) lastStatus = orElse(js::prop(&timeline->items.last(), u"status"_s), js::Null());
    const OJson* accountId = js::prop(&account, u"account_id"_s);
    OJson out = js::object();
    out.set(u"id"_s, orElse(js::prop(&record, u"id"_s), js::Null()));
    out.set(u"created_at"_s, orElse(js::prop(&record, u"created_at"_s), js::Null()));
    out.set(u"intent_summary"_s, orElse(js::prop(&llm, u"intent_summary"_s), js::S(QString())));
    out.set(u"raw_instruction"_s, orElse(js::prop(&input, u"raw_instruction"_s), js::S(QString())));
    out.set(u"reason"_s, orElse(js::prop(&input, u"reason"_s), js::S(QString())));
    out.set(u"symbol"_s, orElse(js::prop(&contract, u"symbol"_s), js::S(QString())));
    out.set(u"secType"_s, orElse(js::prop(&contract, u"secType"_s), js::S(QString())));
    out.set(u"action"_s, orElse(js::prop(&order, u"action"_s), js::S(QString())));
    out.set(u"quantity"_s, orElse(js::prop(&order, u"totalQuantity"_s), js::Null()));
    out.set(u"account"_s, orElse(js::prop(&account, u"alias"_s), js::S(QString())));
    out.set(u"account_masked"_s, js::S(domain::redactAccount(js::nullish(accountId) ? QString() : js::str(accountId))));
    out.set(u"is_paper"_s, orElse(js::prop(&account, u"is_paper"_s), js::Null()));
    out.set(u"execution_type"_s, orElse(js::prop(&record, u"execution_type"_s), js::Null()));
    out.set(u"final_status"_s, orElse(js::prop(&record, u"final_status"_s), js::Null()));
    out.set(u"status"_s, lastStatus);
    out.set(u"avg_fill_price"_s, orElse(js::prop(&ibkr, u"avg_fill_price"_s), js::Null()));
    out.set(u"total_commission"_s, orElse(js::prop(&ibkr, u"total_commission"_s), js::Null()));
    out.set(u"confidence"_s, orElse(js::prop(&llm, u"confidence"_s), js::Null()));
    out.set(u"rejection"_s, orElse(js::prop(&record, u"rejection"_s), js::Null()));
    out.set(u"notional_estimate"_s, orElse(js::prop(&record, u"notional_estimate"_s), js::Null()));
    return out;
}

MethodTable TradingHandlers::methods() {
    ContractTable t;
    t.async(u"instruction.submit"_s, [this](OJson p) { return instructionSubmit(std::move(p)); });
    t.sync(u"records.list"_s, [this](const OJson& p) { return recordsList(p); });
    t.sync(u"records.get"_s, [this](const OJson& p) { return recordsGet(p); });
    t.sync(u"pending.list"_s, [this](const OJson&) { return pendingList(); });
    t.async(u"pending.poll"_s, [this](OJson) { return pendingPoll(); });
    t.sync(u"breaker.state"_s, [this](const OJson&) { return breakerState(); });
    t.async(u"breaker.halt"_s, [this](OJson p) { return breakerHalt(std::move(p)); });
    t.sync(u"breaker.resume"_s, [this](const OJson&) { return breakerResume(); });
    return t.take();
}

// ---- 指令 -----------------------------------------------------------
util::Task<OJson> TradingHandlers::instructionSubmit(OJson params) {
    const QString text = util::jsTrim(hu::strOr(params.get(u"text"_s)));
    if (text.isEmpty()) throw RpcError(-32602, u"指令为空"_s);
    const bool execute = js::truthy(params.get(u"execute"_s));
    if (execute && !ports_.router()) throw RpcError(-32004, u"尚未连接"_s + gateway() + u",拒绝执行。"_s);
    // 界面勾选的目标账户:勾两个就同时向两个账户发单。别名先在这里核对,表外的名字不该走到大模型那一步才报错。
    const OJson* rawAccounts = params.get(u"accounts"_s);
    bool ok = js::nullish(rawAccounts) || js::isArr(rawAccounts);
    if (ok && rawAccounts)
        for (const OJson& a : rawAccounts->items)
            if (a.type != OJson::String) ok = false;
    if (!ok) throw RpcError(-32602, u"accounts 必须是账户别名数组"_s);
    QStringList names;
    if (rawAccounts)
        for (const OJson& a : rawAccounts->items) names.append(a.s);
    QStringList accounts;
    try {
        accounts = ports_.resolveFanoutAccounts(settings(), names);
    } catch (const util::JsError& exc) {
        throw RpcError(-32602, exc.message());
    }

    EnginePort& engine = ports_.engine();
    const QString channel = js::strOr(params.get(u"channel"_s), u"manual"_s);
    // 解析模式(不执行)作为参数传进去,不临时改共享配置——盯盘节拍器同一时刻也在读它
    OJson payload = co_await engine.handleInstruction(text, channel, accounts, !execute);
    payload.set(u"executed"_s, js::B(execute));
    emitEvent(u"result"_s, payload);
    co_return payload;
}

// ---- 记录 -----------------------------------------------------------
OJson TradingHandlers::recordsList(const OJson& params) {
    const OJson* limitIn = params.get(u"limit"_s);
    const double raw = js::nullish(limitIn) ? 30 : js::num(limitIn);
    const double limit = std::isnan(raw) ? raw : std::trunc(raw);
    const QList<OJson> records = ports_.engine().store().listRecords(limit);
    OJson out = js::array();
    for (const OJson& r : records) out.items.append(summarizeRecord(r));
    return js::object({{u"records"_s, out}});
}

OJson TradingHandlers::recordsGet(const OJson& params) {
    const std::optional<OJson> record = ports_.engine().store().getRecord(hu::strOr(params.get(u"id"_s)));
    if (!record) throw RpcError(-32005, u"记录不存在"_s);
    // 改的是转出的这份拷贝,不回写库:库里那条永远留着真账号
    OJson out = *record;
    const OJson* accountIn = out.get(u"account"_s);
    OJson account = js::isObj(accountIn) ? *accountIn : js::object();
    if (js::truthy(account.get(u"account_id"_s))) {
        account.set(u"account_masked"_s, js::S(domain::redactAccount(js::str(account.get(u"account_id"_s)))));
        account.remove(u"account_id"_s);
    }
    out.set(u"account"_s, account);
    return js::object({{u"record"_s, out}});
}

// ---- 条件单队列 ------------------------------------------------------
OJson TradingHandlers::pendingList() {
    OJson list = js::array();
    for (const PendingTriggerView& p : ports_.engine().pendingTriggers()) {
        list.items.append(js::object({{u"record_id"_s, p.record_id},
                                      {u"intent_summary"_s, p.intent_summary},
                                      {u"symbol"_s, p.symbol},
                                      {u"operator"_s, p.op},
                                      {u"value"_s, p.value},
                                      {u"account"_s, p.account},
                                      {u"created_at"_s, p.created_at}}));
    }
    return js::object({{u"pending"_s, list}});
}

/// UI 定时调用:盯盘 + 顺手同步券商回报(富途没有事件流)。
util::Task<OJson> TradingHandlers::pendingPoll() {
    const double synced = co_await ports_.engine().syncBrokerOrders();
    const auto router = ports_.router();
    if (!router || ports_.engine().pendingTriggers().isEmpty()) {
        co_return js::object({{u"fired"_s, js::array()}, {u"prices"_s, js::object()}, {u"synced"_s, js::N(synced)}});
    }
    OJson prices = js::object();
    for (const PendingTriggerView& pending : ports_.engine().pendingTriggers()) {
        const QString symbol = js::str(&pending.symbol);
        if (prices.get(symbol)) continue;
        const std::optional<double> price = co_await router->indexPrice(symbol);
        if (price) prices.set(symbol, js::N(*price));
    }
    const QList<OJson> firedList = co_await ports_.engine().firePending(prices);
    OJson fired = js::array(firedList);
    const double expired = ports_.engine().expirePending();
    if (!fired.items.isEmpty() || (expired != 0 && !std::isnan(expired))) emitEvent(u"pending"_s, js::object({{u"fired"_s, fired}, {u"expired"_s, js::N(expired)}}));
    co_return js::object({{u"fired"_s, fired}, {u"prices"_s, prices}, {u"expired"_s, js::N(expired)}, {u"synced"_s, js::N(synced)}});
}

// ---- 熔断 -----------------------------------------------------------
OJson TradingHandlers::breakerState() {
    const util::BreakerState state = ports_.engine().killswitch().state();
    return js::object({{u"engaged"_s, js::B(state.engaged)},
                       {u"reason"_s, js::S(state.reason)},
                       {u"at"_s, js::S(state.at)}});
}

util::Task<OJson> TradingHandlers::breakerHalt(OJson params) {
    const OJson* r = params.get(u"reason"_s);
    const QString reason = js::truthy(r) ? js::str(r) : u"用户在界面上按下暂停"_s;
    // 闸**先**合上,再去排锁撤单。合闸只是写一个文件,不需要等谁
    ports_.engine().killswitch().engage(reason);
    // 撤全部单和一轮盯盘仍然互斥:否则那一轮可能在熔断前过了闸门、撤完单之后才把托管单挂出去
    OJson outcome = co_await ctx().trackerLock().run<OJson>([this, reason]() { return haltLocked(reason); });
    emitEvent(u"breaker"_s, outcome);
    co_return outcome;
}

util::Task<OJson> TradingHandlers::haltLocked(QString reason) {
    orchestrate::SvcRuntime& rt = ports_.runtime();
    util::Deferred<OJson> race;
    // 撤单请求本身没有超时(券商那头挂住时它永远不回):等 15 秒就放手,闸已经合上,锁不能被它一直占着
    const int timer = rt.setTimeout(15'000, [race]() mutable {
        race.resolve(js::object({{u"engaged"_s, js::B(true)},
                                 {u"cancelled"_s, js::N(0)},
                                 {u"warning"_s, js::S(u"撤单请求 15 秒没有回应:熔断已生效,但挂单可能还在,请到 TWS 里核对"_s)}}));
    });
    const util::Task<OJson> halting = ports_.engine().halt(reason);
    halting.onDone([race, halting]() mutable {
        if (halting.error()) race.reject(halting.error());
        else race.resolve(halting.result());
    });
    OJson outcome;
    try {
        outcome = co_await race.task();
    } catch (const execution::BrokerError& exc) {
        // 撤单炸了:闸照样合上,回执里多一句 warning。这是安全兜底,不是失败
        rt.clearTimeout(timer);
        ports_.engine().killswitch().engage(reason);
        co_return js::object({{u"engaged"_s, js::B(true)}, {u"cancelled"_s, js::N(0)}, {u"warning"_s, js::S(exc.message())}});
    } catch (...) {
        rt.clearTimeout(timer);
        throw;
    }
    rt.clearTimeout(timer);
    co_return outcome;
}

OJson TradingHandlers::breakerResume() {
    EnginePort& engine = ports_.engine();
    engine.killswitch().release(u"ui"_s);
    const OJson empty = js::object();
    engine.store().audit(u"ui"_s, u"resume"_s, &empty);
    emitEvent(u"breaker"_s, js::object({{u"engaged"_s, js::B(false)}}));
    return js::object({{u"engaged"_s, js::B(false)}});
}

}  // namespace ibkr::rpc
