#include "execution/ib_session.h"

#include "util/error.h"
#include "util/jsformat.h"
#include "util/jsnum.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"

#include <QHash>
#include <QSet>

#include <cstdio>

namespace ibkr::execution {

using namespace Qt::StringLiterals;
namespace js = util::js;
using ibnext::OrderedMap;
using ibnext::Runtime;
using ibnext::Upd;

namespace {

/// 协程醒来时会话已经没了(只在会话销毁之后才会走到:等的那个结果在订阅表里,表随会话一起走;没人在等这个结果)
QString sessionClosed() { return u"会话已关闭"_s; }
/// String(n) 的数
QString numStr(double n) { return util::jsNumberToString(n); }
/// `Number(x) || 0`
double numOr0(const OJson* v) {
    const double n = js::num(v);
    return (std::isnan(n) || n == 0) ? 0 : n;
}
/// `Number(x) || null`
OJson numOrNull(const OJson* v) {
    const double n = js::num(v);
    return (std::isnan(n) || n == 0) ? OJson::null() : OJson::number(n);
}
/// a ?? b(值)
OJson orElse(const OJson* v, const OJson& fallback) { return js::nullish(v) ? fallback : *v; }

template <class T>
std::shared_ptr<T> anyPtr(const std::any& a) {
    if (!a.has_value()) return nullptr;
    return std::any_cast<std::shared_ptr<T>>(a);
}

}  // namespace

// ================================================================ 纯函数

QString tickerKey(const IbContract& c, const QString& genericTicks) {
    const bool optionLike = c.secType == u"OPT" || c.secType == u"FOP";
    QString base = c.secType + u'|' + c.symbol + u'|' + c.lastTradeDateOrContractMonth.value_or(QString()) + u'|' +
                   (c.strike ? numStr(*c.strike) : QString()) + u'|' + c.right.value_or(QString());
    if (optionLike && c.tradingClass && !c.tradingClass->isEmpty()) base += u'|' + *c.tradingClass;
    return genericTicks.isEmpty() ? base : base + u'#' + genericTicks;
}

void applyPositionUpdate(std::optional<PositionTable>& table, const PositionsUpdate& update) {
    auto keyOf = [](const QString& account, const OJson* contract) {
        const OJson* conId = js::prop(contract, u"conId"_s);
        const OJson* symbol = js::prop(contract, u"symbol"_s);
        return account + u'|' + (!js::nullish(conId) ? js::str(conId) : !js::nullish(symbol) ? js::str(symbol) : QString());
    };
    auto each = [](const std::shared_ptr<const ibnext::AccountPositions>& group, const std::function<void(const QString&, const OJson&)>& fn) {
        if (!group) return;
        for (const auto& [account, list] : group->items)
            for (const OJson& p : list) fn(account, p);
    };
    auto held = [](const QString& account, const OJson& p) {
        HeldPosition h;
        h.account = account;
        if (const OJson* c = p.get(u"contract"_s)) h.contract = *c;
        h.pos = js::num(p.get(u"pos"_s));
        const OJson* avg = p.get(u"avgCost"_s);
        h.avgCost = js::nullish(avg) ? 0 : js::num(avg);
        return h;
    };
    auto posOf = [](const OJson& p) {
        const OJson* pos = p.get(u"pos"_s);
        return js::nullish(pos) ? 0.0 : js::num(pos);
    };
    const bool isDelta = update.added || update.changed || update.removed;
    if (!table || !isDelta) {
        PositionTable fresh;
        each(update.all, [&](const QString& account, const OJson& p) {
            const double n = posOf(p);
            if (n != 0 && !std::isnan(n)) fresh.set(keyOf(account, p.get(u"contract"_s)), held(account, p));
        });
        table = std::move(fresh);
        return;
    }
    auto upsert = [&](const QString& account, const OJson& p) {
        const QString k = keyOf(account, p.get(u"contract"_s));
        const double n = posOf(p);
        if (n != 0 && !std::isnan(n)) table->set(k, held(account, p));
        else table->erase(k);  // 归零 = 平仓
    };
    each(update.added, upsert);
    each(update.changed, upsert);
    each(update.removed, [&](const QString& account, const OJson& p) { table->erase(keyOf(account, p.get(u"contract"_s))); });
}

OJson tradeFromOrderStatus(const OJson* orderId, const OJson* status, const OJson* filled, const OJson* remaining, const OJson* avgFillPrice,
                           const OJson* permId, const OJson* contract) {
    return js::object({
        {u"order"_s, js::object({{u"orderId"_s, js::N(numOr0(orderId))}, {u"permId"_s, numOrNull(permId)}})},
        {u"orderStatus"_s, js::object({{u"status"_s, js::S(js::strOr(status, QString()))},
                                       {u"filled"_s, js::N(numOr0(filled))},
                                       {u"remaining"_s, js::N(numOr0(remaining))},
                                       {u"avgFillPrice"_s, js::N(numOr0(avgFillPrice))}})},
        {u"contract"_s, orElse(contract, js::object())},
    });
}

std::pair<OJson, OJson> fillFromExecDetails(const OJson* contract, const OJson* execution, const OJson* reqId) {
    const OJson e = orElse(execution, js::object());
    const OJson c = orElse(contract, js::object());
    const double orderId = numOr0(e.get(u"orderId"_s));
    const OJson permId = numOrNull(e.get(u"permId"_s));
    auto f = [&](const QString& k, const OJson& fallback) { return orElse(e.get(k), fallback); };
    const OJson minusOne = OJson::number(-1);
    const OJson* rq = js::undef(reqId) ? &minusOne : reqId;
    OJson trade = js::object({{u"order"_s, js::object({{u"orderId"_s, js::N(orderId)}, {u"permId"_s, permId}})}, {u"contract"_s, c}});
    OJson fill = js::object({
        {u"contract"_s, c},
        {u"execution"_s, js::object({{u"execId"_s, f(u"execId"_s, js::S(QString()))},
                                     {u"time"_s, f(u"time"_s, js::S(QString()))},
                                     {u"price"_s, f(u"price"_s, js::N(0))},
                                     {u"shares"_s, f(u"shares"_s, js::N(0))},
                                     {u"side"_s, f(u"side"_s, js::S(QString()))},
                                     {u"acctNumber"_s, f(u"acctNumber"_s, js::S(QString()))},
                                     {u"orderId"_s, js::N(orderId)},
                                     {u"permId"_s, permId},
                                     {u"cumQty"_s, f(u"cumQty"_s, OJson::null())},
                                     {u"avgPrice"_s, f(u"avgPrice"_s, OJson::null())}})},
        {u"live"_s, js::B(js::num(rq) == -1)},
    });
    return {trade, fill};
}

void ExecForwarder::onExecDetails(const OJson* reqId, const OJson* contract, const OJson* execution) {
    const auto [trade, fill] = fillFromExecDetails(contract, execution, reqId);
    const QString execId = js::strOr(js::path(&fill, {u"execution"_s, u"execId"_s}), QString());
    if (!execId.isEmpty()) {
        if (tradesByExec_.has(execId)) return;
        tradesByExec_.set(execId, trade);
    }
    for (std::size_t i = 0; i < fills_->size(); ++i) {
        const FillCallback cb = (*fills_)[i];
        cb(trade, fill);
    }
}

void ExecForwarder::onCommissionReport(const OJson* report) {
    const QString execId = js::strOr(js::prop(report, u"execId"_s), QString());
    const OJson* trade = tradesByExec_.get(execId);
    if (!trade || commissioned_.contains(execId)) return;
    commissioned_.insert(execId);
    const OJson t = *trade;
    const OJson r = js::copyOrNull(report);
    for (std::size_t i = 0; i < commissions_->size(); ++i) {
        const CommissionCallback cb = (*commissions_)[i];
        cb(t, OJson::null(), r);
    }
}

std::optional<double> realNumber(const OJson* value) {
    if (js::nullish(value) || (js::isStr(value) && value->s.isEmpty())) return std::nullopt;
    const double n = js::num(value);
    if (std::isfinite(n) && std::abs(n) < 1e300) return n;
    return std::nullopt;
}

std::optional<double> tickTypeId(const QString& name) {
    static const QHash<QString, double> ids = {
        {u"BID"_s, 1}, {u"ASK"_s, 2}, {u"LAST"_s, 4}, {u"CLOSE"_s, 9}, {u"BID_SIZE"_s, 0}, {u"ASK_SIZE"_s, 3}, {u"LAST_SIZE"_s, 5}, {u"OPEN"_s, 14},
        {u"HIGH"_s, 6}, {u"LOW"_s, 7}, {u"VOLUME"_s, 8}, {u"AVG_VOLUME"_s, 21}, {u"OPTION_HISTORICAL_VOL"_s, 23}, {u"SHORT_TERM_VOLUME_3_MIN"_s, 63},
        {u"SHORT_TERM_VOLUME_5_MIN"_s, 64}, {u"SHORT_TERM_VOLUME_10_MIN"_s, 65}, {u"LAST_TIMESTAMP"_s, 45}, {u"OPTION_CALL_OPEN_INTEREST"_s, 27},
        {u"OPTION_PUT_OPEN_INTEREST"_s, 28}, {u"OPTION_CALL_VOLUME"_s, 29}, {u"OPTION_PUT_VOLUME"_s, 30}, {u"MODEL_OPTION_GAMMA"_s, 10042},
        {u"MODEL_OPTION_IV"_s, 10039}, {u"MODEL_OPTION_PRICE"_s, 10040}, {u"MODEL_OPTION_DELTA"_s, 10041},
        {u"DELAYED_BID"_s, 66}, {u"DELAYED_ASK"_s, 67}, {u"DELAYED_LAST"_s, 68}, {u"DELAYED_CLOSE"_s, 75}, {u"DELAYED_BID_SIZE"_s, 69},
        {u"DELAYED_ASK_SIZE"_s, 70}, {u"DELAYED_LAST_SIZE"_s, 71}, {u"DELAYED_OPEN"_s, 76}, {u"DELAYED_HIGH"_s, 72}, {u"DELAYED_LOW"_s, 73},
        {u"DELAYED_VOLUME"_s, 74}, {u"DELAYED_LAST_TIMESTAMP"_s, 88}, {u"DELAYED_MODEL_OPTION_GAMMA"_s, 10048}, {u"DELAYED_MODEL_OPTION_IV"_s, 10045},
        {u"DELAYED_MODEL_OPTION_PRICE"_s, 10046}, {u"DELAYED_MODEL_OPTION_DELTA"_s, 10047},
    };
    auto it = ids.constFind(name);
    if (it == ids.constEnd()) return std::nullopt;
    return it.value();
}

void applyTicks(TickerData& data, const MarketDataUpdate& update, double nowMs) {
    const auto& ticks = update.all;
    const auto oldType = data.marketDataType;
    if(ticks) if(const auto t=ticks->get(11000);t&&t->value) data.marketDataType=*t->value;
    if(oldType != data.marketDataType) {
        data.bidAt.reset(); data.askAt.reset(); data.bidSizeAt.reset(); data.askSizeAt.reset(); data.ivAt.reset();
    }
    // 没有这一格:空;有、值是 undefined:Number({…}) = NaN;有值:那个数
    auto get = [&](const QString& name) -> std::optional<double> {
        const auto id = tickTypeId(name);
        if (!id || !ticks) return std::nullopt;
        const ibnext::TickVal* t = ticks->get(*id);
        if (!t) return std::nullopt;
        return t->value ? *t->value : std::nan("");
    };
    auto setIf = [](std::optional<double> v, const std::function<void(double)>& apply) {
        if (v && !std::isnan(*v)) apply(*v);
    };
    auto pick = [&](const QString& name) {
        if(data.marketDataType) return get((*data.marketDataType >= 3 ? u"DELAYED_"_s : QString()) + name);
        auto v = get(name);
        return v ? v : get(u"DELAYED_"_s + name);
    };
    setIf(pick(u"BID"_s), [&](double v) { data.bid = v; });
    setIf(pick(u"ASK"_s), [&](double v) { data.ask = v; });
    setIf(pick(u"LAST"_s), [&](double v) { data.last = v; });
    setIf(pick(u"CLOSE"_s), [&](double v) { data.close = v; });
    const auto liveLast = get(u"LAST"_s);
    if (liveLast && !std::isnan(*liveLast)) data.delayed = false;
    else if (get(u"DELAYED_LAST"_s)) data.delayed = true;
    setIf(pick(u"OPEN"_s), [&](double v) { data.open = v; });
    setIf(pick(u"HIGH"_s), [&](double v) { data.high = v; });
    setIf(pick(u"LOW"_s), [&](double v) { data.low = v; });
    setIf(pick(u"VOLUME"_s), [&](double v) { data.volume = v; });
    setIf(get(u"AVG_VOLUME"_s), [&](double v) { data.avgVolume = v; });
    setIf(get(u"OPTION_HISTORICAL_VOL"_s), [&](double v) { data.histVol = v; });
    setIf(get(u"SHORT_TERM_VOLUME_3_MIN"_s), [&](double v) { data.vol3m = v; });
    setIf(get(u"SHORT_TERM_VOLUME_5_MIN"_s), [&](double v) { data.vol5m = v; });
    setIf(get(u"SHORT_TERM_VOLUME_10_MIN"_s), [&](double v) { data.vol10m = v; });
    setIf(pick(u"LAST_TIMESTAMP"_s), [&](double v) { data.lastTradeAt = v; });
    setIf(data.marketDataType ? pick(u"BID_SIZE"_s) : get(u"BID_SIZE"_s), [&](double v) { data.bidSize = v; });
    setIf(data.marketDataType ? pick(u"ASK_SIZE"_s) : get(u"ASK_SIZE"_s), [&](double v) { data.askSize = v; });
    setIf(get(u"OPTION_CALL_OPEN_INTEREST"_s), [&](double v) { data.callOpenInterest = v; });
    setIf(get(u"OPTION_PUT_OPEN_INTEREST"_s), [&](double v) { data.putOpenInterest = v; });
    setIf(get(u"OPTION_CALL_VOLUME"_s), [&](double v) { data.callVolume = v; });
    setIf(get(u"OPTION_PUT_VOLUME"_s), [&](double v) { data.putVolume = v; });
    // 这一次推送里有盘口 tick 就记下时刻:看新到的那几个(changed / added),不看累计的 all
    const auto& delta = update.changed ? update.changed : update.added ? update.added : ticks;
    static const char* quoteTicks[] = {"BID", "ASK", "LAST", "BID_SIZE", "ASK_SIZE", "LAST_SIZE"};
    bool quoted = false;
    for (const char* n : quoteTicks)
        for (const QString& name : {QString::fromLatin1(n), u"DELAYED_"_s + QString::fromLatin1(n)})
            if (const auto id = tickTypeId(name); id && delta && delta->has(*id)) quoted = true;
    if (quoted) data.quotedAt = nowMs;
    // 逐字段记本机接收时刻，不能拿无关 tick 更新整份盘口年龄。
    for (const auto& [name,dst] : {std::pair{u"BID"_s,&data.bidAt}, {u"ASK"_s,&data.askAt},
            {u"BID_SIZE"_s,&data.bidSizeAt}, {u"ASK_SIZE"_s,&data.askSizeAt}, {u"MODEL_OPTION_IV"_s,&data.ivAt}})
        for(const auto& field:{name,u"DELAYED_"_s+name}) {
            if(data.marketDataType && field.startsWith(u"DELAYED_"_s) != (*data.marketDataType >= 3)) continue;
            const auto id=tickTypeId(field);
            const bool touched=id && ((update.changed&&update.changed->has(*id)) || (update.added&&update.added->has(*id))
                || (!update.changed&&!update.added&&ticks&&ticks->has(*id)));
            if(touched) { const auto value=get(field); if(value&&std::isfinite(*value)&&*value>=0)*dst=nowMs; else dst->reset(); }
        }
    if(data.marketDataType) data.delayed=*data.marketDataType>=3;

    const auto gamma = pick(u"MODEL_OPTION_GAMMA"_s);  // ?? get("modelGamma"):两张表里都没有,永远是 undefined
    const auto iv = pick(u"MODEL_OPTION_IV"_s);
    const auto optPrice = pick(u"MODEL_OPTION_PRICE"_s);
    if (gamma || iv) data.modelGreeks = ModelGreeks{gamma, iv, optPrice};
    if (!data.last && data.bid > 0 && data.ask > 0) data.marketPrice = (data.bid + data.ask) / 2;
    else if (data.last) data.marketPrice = data.last;
}

std::vector<ResolvedContract> candidatesOf(const OJson* details) {
    QList<const OJson*> rows;
    if (js::isArr(details)) {
        for (const OJson& r : details->items) rows.append(&r);
    } else {
        rows.append(details);
    }
    std::vector<ResolvedContract> out;
    for (const OJson* row : rows) {
        const OJson* c = js::prop(row, u"contract"_s);
        const OJson* conIdV = js::prop(c, u"conId"_s);
        const double conId = js::nullish(conIdV) ? 0 : js::num(conIdV);
        if (!std::isfinite(conId) || conId <= 0) continue;
        bool dup = false;
        for (const auto& x : out) dup = dup || x.conId == conId;
        if (dup) continue;
        out.push_back({conId, js::strOr(js::prop(c, u"exchange"_s), QString()), js::strOr(js::prop(c, u"tradingClass"_s), QString())});
    }
    return out;
}

std::optional<ResolvedContract> pickContractDetail(const IbContract& requested, const OJson* details, const std::function<void(const QString&)>& log) {
    const auto all = candidatesOf(details);
    if (all.size() <= 1) {
        if (all.empty()) return std::nullopt;
        return all.front();
    }
    for (const QString& name : {requested.tradingClass.value_or(QString()), requested.symbol}) {
        const QString wanted = util::jsTrim(name).toUpper();
        if (wanted.isEmpty()) continue;
        std::vector<ResolvedContract> hit;
        for (const auto& c : all)
            if (c.tradingClass.toUpper() == wanted) hit.push_back(c);
        if (hit.size() == 1) return hit.front();
    }
    QStringList classes;
    for (const auto& c : all) classes.append(c.tradingClass.isEmpty() ? u"?"_s : c.tradingClass);
    // 只有最后那一段模板串 trim 了(`${symbol} ${secType} ` + `${到期} ${行权价} ${看涨看跌}`.trim())
    const QString tail = u"%1 %2 "_s.arg(requested.symbol, requested.secType) +
                         util::jsTrim(u"%1 %2 %3"_s.arg(requested.lastTradeDateOrContractMonth.value_or(QString()),
                                                        requested.strike ? numStr(*requested.strike) : QString(), requested.right.value_or(QString())));
    if (log)
        log(u"[ibkr] 合约确认有 %1 条匹配(交易类 %2),分不出要哪一条,按确认失败处理:%3"_s.arg(QString::number(all.size()), classes.join(u" / "_s), tail));
    return std::nullopt;
}

OJson toIbOrder(const OrderIntent& order) {
    OJson out = js::object({
        {u"action"_s, js::S(order.action)},
        {u"orderType"_s, js::S(order.orderType)},  // typeMap 里的五种都映射到自己,别的原样
        {u"totalQuantity"_s, js::N(order.totalQuantity)},
        {u"tif"_s, js::S(order.tif)},
        {u"outsideRth"_s, js::B(order.outsideRth)},
        {u"account"_s, js::S(order.account)},
        {u"transmit"_s, js::B(order.transmit)},
        {u"orderRef"_s, js::S(order.orderRef.value_or(QString()))},
    });
    if (order.lmtPrice) out.set(u"lmtPrice"_s, js::N(*order.lmtPrice));
    if (order.auxPrice) out.set(u"auxPrice"_s, js::N(*order.auxPrice));
    if (order.trailingPercent) out.set(u"trailingPercent"_s, js::N(*order.trailingPercent));
    if (!order.ocaGroup.isEmpty()) {
        out.set(u"ocaGroup"_s, js::S(order.ocaGroup));
        out.set(u"ocaType"_s, js::N(order.ocaType.value_or(1)));
    }
    if (order.trailStopPrice) out.set(u"trailStopPrice"_s, js::N(*order.trailStopPrice));
    if (!order.conditions.empty()) {
        OJson conds = js::array();
        for (const OJson& c : order.conditions) {
            // new PriceCondition(price, TriggerMethod.Default, conId, exchange, isMore, ConjunctionConnection.And)
            OJson pc = js::object();
            auto put = [&](const QString& k, const OJson* v) {
                if (!js::undef(v)) pc.set(k, *v);
            };
            put(u"price"_s, c.get(u"price"_s));
            pc.set(u"triggerMethod"_s, js::nullish(c.get(u"triggerMethod"_s)) ? js::N(0) : *c.get(u"triggerMethod"_s));
            put(u"conId"_s, c.get(u"conId"_s));
            put(u"exchange"_s, c.get(u"exchange"_s));
            put(u"isMore"_s, c.get(u"isMore"_s));
            pc.set(u"conjunctionConnection"_s, js::nullish(c.get(u"conjunctionConnection"_s)) ? js::S(u"a"_s) : *c.get(u"conjunctionConnection"_s));
            pc.set(u"type"_s, js::N(1));
            conds.items.append(pc);
        }
        out.set(u"conditions"_s, conds);
        out.set(u"conditionsCancelOrder"_s, js::B(order.conditionsCancelOrder.value_or(false)));
        if (order.conditionsIgnoreRth) out.set(u"conditionsIgnoreRth"_s, js::B(*order.conditionsIgnoreRth));
    }
    return out;
}

OJson toIbContract(const IbContract& c) {
    OJson o = js::object({{u"secType"_s, js::S(c.secType)}, {u"symbol"_s, js::S(c.symbol)}, {u"exchange"_s, js::S(c.exchange)}, {u"currency"_s, js::S(c.currency)}});
    if (c.lastTradeDateOrContractMonth && !c.lastTradeDateOrContractMonth->isEmpty()) o.set(u"lastTradeDateOrContractMonth"_s, js::S(*c.lastTradeDateOrContractMonth));
    if (c.strike && *c.strike != 0 && !std::isnan(*c.strike)) o.set(u"strike"_s, js::N(*c.strike));
    if (c.right && !c.right->isEmpty()) o.set(u"right"_s, js::S(*c.right));
    if (c.multiplier && !c.multiplier->isEmpty()) o.set(u"multiplier"_s, js::N(util::jsStringToNumber(*c.multiplier)));
    if (c.tradingClass && !c.tradingClass->isEmpty()) o.set(u"tradingClass"_s, js::S(*c.tradingClass));
    if (c.conId && *c.conId != 0) o.set(u"conId"_s, js::N(*c.conId));
    if (c.hasComboLegs) {
        OJson legs = js::array();
        for (const ComboLeg& l : c.comboLegs)
            legs.items.append(js::object({{u"conId"_s, js::N(l.conId)}, {u"ratio"_s, js::N(l.ratio)}, {u"action"_s, js::S(l.action)}, {u"exchange"_s, js::S(l.exchange)}}));
        o.set(u"comboLegs"_s, legs);
    }
    if (c.includeExpired) o.set(u"includeExpired"_s, js::B(true));
    return o;
}

namespace {

/// 编码器要的价格条件还得带 strValue("" + price,PriceCondition 原型上的 getter)
OJson orderForWire(const OrderIntent& order) {
    OJson o = toIbOrder(order);
    if (OJson* conds = o.get(u"conditions"_s)) {
        for (OJson& c : conds->items) {
            const OJson* price = c.get(u"price"_s);
            c.set(u"strValue"_s, js::S(price ? js::str(price) : u"undefined"_s));
        }
    }
    return o;
}

TickerData emptyTicker() { return TickerData{}; }

/// 事件参数里的 null 就是库里的 undefined
const OJson* evArg(const OJson& a, int i) {
    if (i >= a.items.size()) return nullptr;
    const OJson* v = &a.items[i];
    return v->type == OJson::Null ? nullptr : v;
}

// ================================================================ 会话

class IbApiNextSession : public IbSession, public std::enable_shared_from_this<IbApiNextSession> {
    friend struct ::ibkr::execution::ClosedSessionProbe;

public:
    IbApiNextSession(SessionConfig cfg, IbSessionDeps deps)
        : cfg_(std::move(cfg)), deps_(std::move(deps)), rt_(deps_.runtime),
          api_(ibnext::ApiNext::make(rt_, deps_.sockets, cfg_.host, cfg_.port, kIbReconnectMs)), execs_(&fillCbs_, &commissionCbs_) {
        api_->api().log = deps_.log;
    }

    static Task<std::shared_ptr<IbSession>> create(std::shared_ptr<IbApiNextSession> self);

    bool has(Cap) const override { return true; }
    bool isConnected() override { return connected_; }
    Task<> disconnect() override;
    QStringList managedAccounts() override { return managed_; }
    Task<> qualifyContracts(std::vector<IbContract*> contracts, int timeoutMs) override {
        Runtime::Scope s(*rt_);
        return qualifyCo(shared_from_this(), std::move(contracts), timeoutMs);
    }
    Task<std::optional<std::array<QString, 3>>> contractHours(IbContract contract, int timeoutMs) override {
        Runtime::Scope s(*rt_);
        return contractHoursCo(shared_from_this(), std::move(contract), timeoutMs);
    }
    void reqMarketDataType(int type) override {
        Runtime::Scope s(*rt_);
        // "切回实时"(1)一律回到基线
        api_->setMarketDataType(type == 1 ? mdBaseline_ : type);
    }
    void setBaselineMarketDataType(int type) override {
        Runtime::Scope s(*rt_);
        mdBaseline_ = type;
        api_->setMarketDataType(type);
    }
    std::shared_ptr<TickerHandle> subscribeTicker(const IbContract& contract, const QString& genericTicks) override;
    void cancelTicker(const IbContract& contract, const std::optional<QString>& genericTicks) override;
    std::optional<bool> quoteDelayed(const IbContract& contract) override {
        if (const bool* v = lastFeed_.get(tickerKey(contract))) return *v;
        return std::nullopt;
    }
    std::function<void()> onOptionTick(std::function<void()> listener) override {
        const int id = ++nextTickListener_;
        optionTickListeners_.insert(id, std::move(listener));
        std::weak_ptr<IbApiNextSession> weak = weak_from_this();
        return [weak, id]() {
            if (auto s = weak.lock()) s->optionTickListeners_.remove(id);
        };
    }
    Task<> settle(int ms) override {
        Runtime::Scope s(*rt_);
        return sleep(ms);
    }
    Task<std::vector<RawBar>> historicalData(IbContract contract, HistoricalRequest opts) override {
        Runtime::Scope s(*rt_);
        return historicalCo(shared_from_this(), std::move(contract), std::move(opts));
    }
    Task<std::vector<OptChainParam>> secDefOptParams(QString symbol, QString secType, int conId) override {
        Runtime::Scope s(*rt_);
        return secDefCo(shared_from_this(), std::move(symbol), std::move(secType), conId);
    }
    Task<QString> wshEvents(const QString& filter, const QString& start, const QString& end) override {
        Runtime::Scope scope(*rt_);
        return wshCo(shared_from_this(), filter, start, end);
    }
    static Task<QString> wshCo(std::shared_ptr<IbApiNextSession> self, QString filter, QString start, QString end) {
        if (!self->isConnected()) throw util::JsError(u"IBKR 未连接"_s);
        if (self->wshBusy_) throw util::JsError(u"IBKR WSH 正在读取，请稍后重试"_s);
        self->wshBusy_ = true;
        try {
            co_await self->api_->getWsh(true);
            const auto result = co_await self->api_->getWsh(false, filter, start, end);
            self->wshBusy_ = false;
            co_return result;
        } catch (...) { self->wshBusy_ = false; throw; }
    }
    bool wshBusy_ = false;
    Task<Depth> mktDepth(IbContract contract, int rows, int waitMs) override {
        Runtime::Scope s(*rt_);
        return depthCo(shared_from_this(), std::move(contract), rows, waitMs);
    }
    Task<TradeLike> placeOrder(IbContract contract, OrderIntent order) override {
        Runtime::Scope s(*rt_);
        return placeCo(shared_from_this(), std::move(contract), std::move(order));
    }
    Task<std::vector<OpenTrade>> openTrades() override {
        Runtime::Scope s(*rt_);
        return openTradesCo(shared_from_this());
    }
    Task<> cancelOrder(int orderId) override {
        Runtime::Scope s(*rt_);
        // 断着就当场报错(同步抛,同 TS):库会把命令排进缓冲、重连后才发出
        if (!connected_) throw LinkDownError();
        api_->cancelOrder(orderId);
        return Task<>::resolved();
    }
    Task<std::vector<OpenTradeDetail>> openTradesDetailed() override {
        Runtime::Scope s(*rt_);
        return openDetailedCo(shared_from_this());
    }
    Task<std::vector<PortfolioItemLike>> portfolio() override { return Task<std::vector<PortfolioItemLike>>::resolved({}); }
    Task<std::vector<PositionItemLike>> positions() override {
        Runtime::Scope s(*rt_);
        return positionsCo(shared_from_this());
    }
    std::optional<AccountPnl> accountPnl(const QString& accountId) override;
    std::optional<NetLiquidation> netLiquidation(const QString& accountId) override;
    Task<std::vector<ExecutionRow>> executions() override {
        Runtime::Scope s(*rt_);
        return executionsCo(shared_from_this());
    }
    Task<std::optional<std::vector<ExecutionRow>>> executionHistory(int days) override {
        Runtime::Scope s(*rt_);
        return historyCo(shared_from_this(), days);
    }

    void onConnectivity(std::function<void(int)> cb) override { connectivityCbs_.push_back(std::move(cb)); }
    void onLink(std::function<void(bool)> cb) override { linkCbs_.push_back(std::move(cb)); }
    void onOrderStatus(std::function<void(const OJson&)> cb) override { orderStatusCbs_.push_back(std::move(cb)); }
    void onFill(std::function<void(const OJson&, const OJson&)> cb) override { fillCbs_.push_back(std::move(cb)); }
    void onCommission(std::function<void(const OJson&, const OJson&, const OJson&)> cb) override { commissionCbs_.push_back(std::move(cb)); }
    ListenerToken onError(std::function<void(int, int, const QString&)> cb) override {
        const ListenerToken t = ++nextToken_;
        errorCbs_.push_back({t, std::move(cb)});
        return t;
    }
    void offError(ListenerToken token) override {
        for (auto it = errorCbs_.begin(); it != errorCbs_.end(); ++it)
            if (it->first == token) {
                errorCbs_.erase(it);
                return;
            }
    }

private:
    struct LiveTicker {
        TickerData data;
        std::shared_ptr<ibnext::SubHandle> sub;
    };
    class Handle : public TickerHandle {
    public:
        Handle(std::shared_ptr<IbApiNextSession> s, QString key, std::shared_ptr<LiveTicker> entry) : s_(std::move(s)), key_(std::move(key)), entry_(std::move(entry)) {}
        TickerData read() override {
            const auto* now = s_->tickers_.get(key_);
            const bool attached = now && *now == entry_;
            if (attached || (entry_->data.error && !entry_->data.error->isEmpty())) return entry_->data;
            TickerData t = emptyTicker();
            t.error = kTickerDetached;
            return t;
        }

    private:
        std::shared_ptr<IbApiNextSession> s_;
        QString key_;
        std::shared_ptr<LiveTicker> entry_;
    };
    struct PnlLatest {
        std::optional<double> daily, unrealized, realized;
        double atMs = 0;
    };

    template <class T>
    Task<T> withTimeout(Task<T> work, double ms, const QString& message);
    Task<> sleep(double ms) {
        util::Deferred<> d;
        Runtime* rt = rt_.get();
        rt_->setTimeout(ms, [d, rt] { ibnext::resolveLater(*rt, d); });
        return d.task();
    }
    void emitConnectivity(int code) {
        for (std::size_t i = 0; i < connectivityCbs_.size(); ++i) {
            const auto cb = connectivityCbs_[i];
            cb(code);
        }
    }
    void emitLink(bool up) {
        for (std::size_t i = 0; i < linkCbs_.size(); ++i) {
            const auto cb = linkCbs_[i];
            cb(up);
        }
    }
    void onApiError(const ibnext::ApiError& err);
    void onConnectionState(int state);
    void ensurePositions();
    void ensureSummary();
    void ensurePnl(const QString& accountId);

    static Task<> qualifyLoop(std::weak_ptr<IbApiNextSession> weak, std::vector<IbContract*> contracts, std::shared_ptr<bool> timedOut);
    static Task<> qualifyCo(std::shared_ptr<IbApiNextSession> self, std::vector<IbContract*> contracts, int timeoutMs);
    static Task<std::optional<std::array<QString, 3>>> hoursWork(std::weak_ptr<IbApiNextSession> weak, IbContract contract);
    static Task<std::optional<std::array<QString, 3>>> contractHoursCo(std::shared_ptr<IbApiNextSession> self, IbContract contract, int timeoutMs);
    static Task<std::vector<RawBar>> historicalCo(std::weak_ptr<IbApiNextSession> weak, IbContract contract, HistoricalRequest opts);
    static Task<std::vector<OptChainParam>> secDefCo(std::weak_ptr<IbApiNextSession> weak, QString symbol, QString secType, int conId);
    static Task<Depth> depthCo(std::shared_ptr<IbApiNextSession> self, IbContract contract, int rows, int waitMs);
    static Task<TradeLike> placeCo(std::weak_ptr<IbApiNextSession> weak, IbContract contract, OrderIntent order);
    static Task<std::vector<OpenTrade>> openTradesCo(std::weak_ptr<IbApiNextSession> weak);
    static Task<std::vector<OpenTradeDetail>> openDetailedCo(std::weak_ptr<IbApiNextSession> weak);
    static Task<std::vector<PositionItemLike>> positionsCo(std::shared_ptr<IbApiNextSession> self);
    static Task<std::vector<ExecutionRow>> executionsCo(std::weak_ptr<IbApiNextSession> weak);
    static Task<std::optional<std::vector<ExecutionRow>>> historyCo(std::shared_ptr<IbApiNextSession> self, int days);

    SessionConfig cfg_;
    IbSessionDeps deps_;
    std::shared_ptr<Runtime> rt_;
    std::shared_ptr<ibnext::ApiNext> api_;

    bool connected_ = false;
    bool established_ = false;
    bool closing_ = false;
    QStringList managed_;
    std::vector<std::function<void(bool)>> linkCbs_;
    std::vector<std::function<void(int)>> connectivityCbs_;
    std::vector<std::pair<ListenerToken, std::function<void(int, int, const QString&)>>> errorCbs_;
    ListenerToken nextToken_ = 0;
    std::vector<std::function<void(const OJson&)>> orderStatusCbs_;
    std::vector<FillCallback> fillCbs_;
    std::vector<CommissionCallback> commissionCbs_;
    OrderedMap<QString, std::shared_ptr<LiveTicker>> tickers_;
    OrderedMap<QString, bool> lastFeed_;
    /// 期权行情推送的回调(onOptionTick):盯盘靠它在两拍之间提前醒
    QHash<int, std::function<void()>> optionTickListeners_;
    int nextTickListener_ = 0;
    OrderedMap<double, OJson> contractsByOrder_;
    ExecForwarder execs_;

    int mdBaseline_ = 1;
    std::optional<PositionTable> positionsLatest_;
    std::shared_ptr<ibnext::SubHandle> positionsSub_;
    std::vector<std::function<void()>> positionsWaiters_;
    OrderedMap<QString, NetLiquidation> netLiq_;
    std::shared_ptr<ibnext::SubHandle> summarySub_;
    OrderedMap<QString, PnlLatest> pnlLatest_;
    OrderedMap<QString, std::shared_ptr<ibnext::SubHandle>> pnlSubs_;
};

template <class T>
Task<T> IbApiNextSession::withTimeout(Task<T> work, double ms, const QString& message) {
    util::Deferred<T> d;
    Runtime* rt = rt_.get();
    const quint64 timer = rt->setTimeout(ms, [d, rt, message] { ibnext::rejectLater(*rt, d, std::make_exception_ptr(util::JsError(message))); });
    work.onDone([d, rt, timer, work] {
        rt->clearTimeout(timer);
        if (work.error()) ibnext::rejectLater(*rt, d, work.error());
        else if constexpr (std::is_void_v<T>) ibnext::resolveLater(*rt, d);
        else ibnext::resolveLater(*rt, d, work.result());
    });
    return d.task();
}

Task<std::shared_ptr<IbSession>> IbApiNextSession::create(std::shared_ptr<IbApiNextSession> self) {
    std::weak_ptr<IbApiNextSession> weak = self;
    // 订单级错误从 error$ 流上来
    self->api_->subscribeErrors([weak](const ibnext::ApiError& e) {
        if (auto s = weak.lock()) s->onApiError(e);
    });
    self->api_->connect(self->cfg_.clientId);
    // 用 getManagedAccounts 做"连接完成"的信号
    std::exception_ptr failed;
    try {
        self->managed_ = co_await self->withTimeout(self->api_->getManagedAccounts(), 10'000, u"连接超时"_s);
    } catch (...) {
        failed = std::current_exception();
    }
    if (failed) {
        // 连不上就把这个客户端关干净(不关它会在后台每 5 秒重试一次,占住 client id)
        self->api_->disconnect();
        std::rethrow_exception(failed);
    }
    self->connected_ = true;
    self->established_ = true;

    // 订单状态 / 成交 / 佣金 / 连接级消息:直接挂在底层 IBApi 的事件上
    auto& raw = self->api_->api().events;
    raw.on(u"openOrder"_s, [weak](const OJson& a) {
        auto s = weak.lock();
        if (!s) return;
        s->contractsByOrder_.set(js::num(evArg(a, 0)), orElse(evArg(a, 1), js::object()));
    });
    raw.on(u"orderStatus"_s, [weak](const OJson& a) {
        auto s = weak.lock();
        if (!s) return;
        const OJson* contract = s->contractsByOrder_.get(js::num(evArg(a, 0)));
        const OJson trade = tradeFromOrderStatus(evArg(a, 0), evArg(a, 1), evArg(a, 2), evArg(a, 3), evArg(a, 4), evArg(a, 5), contract);
        for (std::size_t i = 0; i < s->orderStatusCbs_.size(); ++i) {
            const auto cb = s->orderStatusCbs_[i];
            cb(trade);
        }
    });
    raw.on(u"execDetails"_s, [weak](const OJson& a) {
        if (auto s = weak.lock()) s->execs_.onExecDetails(evArg(a, 0), evArg(a, 1), evArg(a, 2));
    });
    raw.on(u"commissionReport"_s, [weak](const OJson& a) {
        if (auto s = weak.lock()) s->execs_.onCommissionReport(evArg(a, 0));
    });
    raw.on(u"info"_s, [weak](const OJson& a) {
        auto s = weak.lock();
        if (!s) return;
        const double code = js::num(evArg(a, 1));
        if (s->closing_ || code == 0 || std::isnan(code)) return;
        s->emitConnectivity(static_cast<int>(code));
    });
    self->api_->connectionState().subscribe([weak](int state) {
        if (auto s = weak.lock()) s->onConnectionState(state);
    });
    co_return self;
}

void IbApiNextSession::onApiError(const ibnext::ApiError& err) {
    const double code = err.code;
    if (code == 0 || std::isnan(code)) return;
    emitConnectivity(static_cast<int>(code));
    const double reqId = err.reqId;
    if (reqId > 0) {
        for (std::size_t i = 0; i < errorCbs_.size(); ++i) {
            const auto cb = errorCbs_[i].second;
            cb(static_cast<int>(reqId), static_cast<int>(code), err.message);
        }
    }
}

void IbApiNextSession::onConnectionState(int state) {
    if (!established_ || closing_) return;
    if (state == ibnext::Connected && !connected_) {
        connected_ = true;
        api_->setMarketDataType(mdBaseline_);
        for (auto& [k, live] : tickers_.items) live->data.requestedAt = rt_->now();
        // 库紧接着把每条行情流按原来的 reqId 重订一遍;从这一刻起算它们多久没来盘口
        std::weak_ptr<IbApiNextSession> weak = weak_from_this();
        // getManagedAccounts().then(m => { if (m?.length) managed = m }, () => undefined)
        auto t = api_->getManagedAccounts();
        t.onDone([weak, t] {
            auto s = weak.lock();
            if (!s || t.error()) return;
            const QStringList m = t.result();
            if (!m.isEmpty()) s->managed_ = m;
        });
        emitLink(true);
    } else if (state == ibnext::Disconnected && connected_) {
        connected_ = false;
        positionsLatest_.reset();
        pnlLatest_.clear();
        netLiq_.clear();
        for (auto& [k, live] : tickers_.items) live->data = emptyTicker();
        emitLink(false);
    }
}

Task<> IbApiNextSession::disconnect() {
    Runtime::Scope s(*rt_);
    closing_ = true;
    connected_ = false;
    const auto live = tickers_.items;
    for (const auto& [k, l] : live)
        if (l->sub) l->sub->unsubscribe();
    tickers_.clear();
    if (positionsSub_) positionsSub_->unsubscribe();
    positionsSub_.reset();
    positionsLatest_.reset();
    api_->disconnect();
    return Task<>::resolved();
}


std::shared_ptr<TickerHandle> IbApiNextSession::subscribeTicker(const IbContract& contract, const QString& genericTicks) {
    Runtime::Scope scope(*rt_);
    const QString key = tickerKey(contract, genericTicks);
    std::shared_ptr<LiveTicker> live;
    if (auto* p = tickers_.get(key)) live = *p;
    if (!live) {
        live = std::make_shared<LiveTicker>();
        live->data.requestedAt = rt_->now();
        tickers_.set(key, live);
        auto sub = api_->getMarketData(toIbContract(contract), genericTicks, false, false);
        std::weak_ptr<IbApiNextSession> weak = weak_from_this();
        std::weak_ptr<LiveTicker> weakEntry = live;
        ibnext::Observer o;
        o.next = [weak, weakEntry, contract](const Upd& u) {
            auto s = weak.lock();
            auto entry = weakEntry.lock();
            if (!s || !entry) return;
            MarketDataUpdate m;
            m.all = anyPtr<ibnext::MarketData>(u.all);
            m.added = anyPtr<ibnext::MarketData>(u.added);
            m.changed = anyPtr<ibnext::MarketData>(u.changed);
            applyTicks(entry->data, m, s->rt_->now());
            // 期货也记:指数盘外的 K 线按期货推算
            const bool plain = contract.secType == u"STK" || contract.secType == u"IND" || contract.secType == u"FUT";
            if (plain && entry->data.last) s->lastFeed_.set(tickerKey(contract), entry->data.delayed);
            // 来源元数据更新不作为价格 tick 唤醒现有快速出场逻辑。
            bool metadataOnly = bool(m.added || m.changed);
            for (const auto& delta : {m.added, m.changed})
                if (delta) for (const auto& field : delta->items) metadataOnly &= field.first == 11000;
            if (metadataOnly) return;
            if (contract.secType == u"OPT" || contract.secType == u"FOP") {
                const QList<std::function<void()>> listeners = s->optionTickListeners_.values();  // 回调里撤掉自己也安全
                for (const auto& listener : listeners) {
                    try {
                        listener();
                    } catch (...) {
                        /* 回调出错不影响行情落缓存 */
                    }
                }
            }
        };
        // 订阅被拒之后这条流就死了:摘掉,下次重新订
        o.error = [weak, weakEntry, key](const ibnext::ApiError& err) {
            auto s = weak.lock();
            auto entry = weakEntry.lock();
            if (!s || !entry) return;
            const QString text = err.message.left(120);
            const QString msg = util::jsTrim(numStr(err.code) + u' ' + text);
            entry->data.error = msg.isEmpty() ? u"订阅被拒"_s : msg;
            if (const auto* now = s->tickers_.get(key); now && *now == entry) s->tickers_.erase(key);
        };
        live->sub = sub->subscribe(std::move(o));
    }
    return std::make_shared<Handle>(shared_from_this(), key, live);
}

void IbApiNextSession::cancelTicker(const IbContract& contract, const std::optional<QString>& genericTicks) {
    Runtime::Scope scope(*rt_);
    const QString base = tickerKey(contract);
    QStringList keys;
    if (genericTicks) {
        keys.append(tickerKey(contract, *genericTicks));
    } else {
        for (const auto& [k, l] : tickers_.items)
            if (k == base || k.startsWith(base + u'#')) keys.append(k);
    }
    for (const QString& key : keys) {
        auto* p = tickers_.get(key);
        if (!p) continue;
        auto live = *p;
        if (live->sub) live->sub->unsubscribe();
        tickers_.erase(key);
    }
}

void IbApiNextSession::ensurePositions() {
    if (positionsSub_) return;
    std::weak_ptr<IbApiNextSession> weak = weak_from_this();
    ibnext::Observer o;
    o.next = [weak](const Upd& u) {
        auto s = weak.lock();
        if (!s) return;
        PositionsUpdate p;
        p.all = anyPtr<ibnext::AccountPositions>(u.all);
        p.added = anyPtr<ibnext::AccountPositions>(u.added);
        p.changed = anyPtr<ibnext::AccountPositions>(u.changed);
        p.removed = anyPtr<ibnext::AccountPositions>(u.removed);
        // 自己按增量维护,不用库里那份会被截尾的 all
        applyPositionUpdate(s->positionsLatest_, p);
        auto waiters = std::move(s->positionsWaiters_);
        s->positionsWaiters_.clear();
        for (auto& f : waiters) f();
    };
    // 订阅断了:清掉句柄,下一次读持仓重订;旧快照也作废
    o.error = [weak](const ibnext::ApiError&) {
        auto s = weak.lock();
        if (!s) return;
        s->positionsSub_.reset();
        s->positionsLatest_.reset();
    };
    positionsSub_ = api_->getPositions()->subscribe(std::move(o));
}

void IbApiNextSession::ensureSummary() {
    if (summarySub_) return;
    std::weak_ptr<IbApiNextSession> weak = weak_from_this();
    ibnext::Observer o;
    o.next = [weak](const Upd& u) {
        auto s = weak.lock();
        if (!s) return;
        auto all = anyPtr<ibnext::AccountSummaries>(u.all);
        if (!all) return;
        for (const auto& [account, tags] : all->items) {
            const auto* nl = tags.get(u"NetLiquidation"_s);
            if (!nl) continue;
            for (const auto& [currency, item] : nl->items) {
                const auto amount = realNumber(item.get(u"value"_s));
                if (amount) s->netLiq_.set(account, NetLiquidation{*amount, currency});
            }
        }
    };
    o.error = [weak](const ibnext::ApiError&) {
        auto s = weak.lock();
        if (!s) return;
        s->summarySub_.reset();
        s->netLiq_.clear();
    };
    summarySub_ = api_->getAccountSummary(u"All"_s, u"NetLiquidation"_s)->subscribe(std::move(o));
}

void IbApiNextSession::ensurePnl(const QString& accountId) {
    if (pnlSubs_.has(accountId)) return;
    std::weak_ptr<IbApiNextSession> weak = weak_from_this();
    ibnext::Observer o;
    o.next = [weak, accountId](const Upd& u) {
        auto s = weak.lock();
        if (!s) return;
        const OJson p = u.all.has_value() ? std::any_cast<OJson>(u.all) : OJson();
        s->pnlLatest_.set(accountId, PnlLatest{realNumber(p.get(u"dailyPnL"_s)), realNumber(p.get(u"unrealizedPnL"_s)), realNumber(p.get(u"realizedPnL"_s)),
                                              s->rt_->now()});
    };
    o.error = [weak, accountId](const ibnext::ApiError&) {
        auto s = weak.lock();
        if (!s) return;
        s->pnlSubs_.erase(accountId);
        s->pnlLatest_.erase(accountId);
    };
    // pnlSubs.set(accountId, …subscribe(…)):订阅的那一刻出错的话,先删再设(同 TS 的求值次序)
    auto handle = api_->getPnL(accountId)->subscribe(std::move(o));
    pnlSubs_.set(accountId, handle);
}

std::optional<AccountPnl> IbApiNextSession::accountPnl(const QString& accountId) {
    Runtime::Scope scope(*rt_);
    if (!connected_) return std::nullopt;
    ensureSummary();
    ensurePnl(accountId);
    const PnlLatest* latest = pnlLatest_.get(accountId);
    if (!latest) return std::nullopt;
    AccountPnl out;
    out.daily = latest->daily;
    out.unrealized = latest->unrealized;
    out.realized = latest->realized;
    out.atMs = latest->atMs;
    const NetLiquidation* nl = netLiq_.get(accountId);
    out.currency = nl ? nl->currency : QString();
    return out;
}

std::optional<NetLiquidation> IbApiNextSession::netLiquidation(const QString& accountId) {
    Runtime::Scope scope(*rt_);
    if (!connected_) return std::nullopt;
    ensureSummary();
    if (const NetLiquidation* nl = netLiq_.get(accountId)) return *nl;
    return std::nullopt;
}

Task<> IbApiNextSession::qualifyLoop(std::weak_ptr<IbApiNextSession> weak, std::vector<IbContract*> contracts, std::shared_ptr<bool> timedOut) {
    // 每张合约的请求都用开头那一刻的样子(TS 读的也是它:前面写回去的只改那一张自己);超时之后照样把请求发完(同 TS),
    // 但不再写调用方的对象——调用方给的是裸指针,超时之后它可能已经不在了(见头文件)
    std::vector<IbContract> snapshots;
    snapshots.reserve(contracts.size());
    for (IbContract* c : contracts) snapshots.push_back(*c);
    for (std::size_t i = 0; i < contracts.size(); ++i) {
        std::optional<ResolvedContract> resolved;
        bool failed = false;
        // 等结果的时候不拿着会话(只拿弱引用):结果在订阅表里,等不到时协程帧留着也不能把会话拖住
        ibnext::Task<ibnext::JsList> pending;
        if (auto self = weak.lock()) pending = self->api_->getContractDetails(toIbContract(snapshots[i]));
        else co_return;
        try {
            const ibnext::JsList details = co_await pending;
            auto self = weak.lock();
            if (!self) co_return;
            OJson arr = js::array(details);
            resolved = pickContractDetail(snapshots[i], &arr, self->deps_.log);
        } catch (const util::JsError&) {
            failed = true;
        }
        if (*timedOut) continue;
        IbContract* contract = contracts[i];
        if (!failed && resolved) {
            contract->conId = static_cast<int>(resolved->conId);
            if (!resolved->exchange.isEmpty()) contract->exchange = resolved->exchange;
            if (!resolved->tradingClass.isEmpty()) contract->tradingClass = resolved->tradingClass;
        } else {
            contract->conId = 0;  // 没有或分不出:router 侧统一转成"无法确认该合约"
        }
    }
}

Task<> IbApiNextSession::qualifyCo(std::shared_ptr<IbApiNextSession> self, std::vector<IbContract*> contracts, int timeoutMs) {
    auto timedOut = std::make_shared<bool>(false);
    std::exception_ptr err;
    try {
        co_await self->withTimeout(qualifyLoop(self, contracts, timedOut), timeoutMs, u"timeout"_s);
    } catch (...) {
        err = std::current_exception();
        *timedOut = true;
    }
    if (err) std::rethrow_exception(err);
}

Task<std::optional<std::array<QString, 3>>> IbApiNextSession::hoursWork(std::weak_ptr<IbApiNextSession> weak, IbContract contract) {
    std::optional<std::array<QString, 3>> out;
    ibnext::Task<ibnext::JsList> pending;
    if (auto self = weak.lock()) pending = self->api_->getContractDetails(toIbContract(contract));
    else co_return std::nullopt;
    try {
        const ibnext::JsList details = co_await pending;
        if (!details.isEmpty()) {
            const OJson& first = details.first();
            if (js::truthy(&first))
                out = std::array<QString, 3>{js::strOr(first.get(u"tradingHours"_s), QString()), js::strOr(first.get(u"liquidHours"_s), QString()),
                                             js::strOr(first.get(u"timeZoneId"_s), QString())};
        }
    } catch (const util::JsError&) {
        out.reset();  // 查不到时段不该炸掉轮询
    }
    co_return out;
}

Task<std::optional<std::array<QString, 3>>> IbApiNextSession::contractHoursCo(std::shared_ptr<IbApiNextSession> self, IbContract contract, int timeoutMs) {
    std::optional<std::array<QString, 3>> out;
    try {
        out = co_await self->withTimeout(hoursWork(self, std::move(contract)), timeoutMs, u"timeout"_s);
    } catch (const util::JsError&) {
        out.reset();
    }
    co_return out;
}

Task<std::vector<RawBar>> IbApiNextSession::historicalCo(std::weak_ptr<IbApiNextSession> weak, IbContract contract, HistoricalRequest opts) {
    ibnext::Task<ibnext::JsList> pending;
    if (auto self = weak.lock())
        pending = self->api_->getHistoricalData(toIbContract(contract), opts.endDateTime.isEmpty() ? std::nullopt : std::optional<QString>(opts.endDateTime),
                                                opts.durationStr, opts.barSizeSetting, opts.whatToShow, opts.useRTH ? 1 : 0, 1);
    else throw util::JsError(sessionClosed());
    const ibnext::JsList bars = co_await pending;
    std::vector<RawBar> out;
    for (const OJson& b : bars) {
        RawBar r;
        const OJson* time = b.get(u"time"_s);
        const OJson* date = b.get(u"date"_s);
        r.date = !js::nullish(time) ? js::str(time) : !js::nullish(date) ? js::str(date) : QString();
        r.open = js::num(b.get(u"open"_s));
        r.high = js::num(b.get(u"high"_s));
        r.low = js::num(b.get(u"low"_s));
        r.close = js::num(b.get(u"close"_s));
        const OJson* vol = b.get(u"volume"_s);
        r.volume = js::nullish(vol) ? 0 : js::num(vol);
        out.push_back(r);
    }
    co_return out;
}

Task<std::vector<OptChainParam>> IbApiNextSession::secDefCo(std::weak_ptr<IbApiNextSession> weak, QString symbol, QString secType, int conId) {
    ibnext::Task<ibnext::JsList> pending;
    if (auto self = weak.lock()) pending = self->api_->getSecDefOptParams(symbol, QString(), secType, conId);
    else throw util::JsError(sessionClosed());
    const ibnext::JsList params = co_await pending;
    std::vector<OptChainParam> out;
    for (const OJson& p : params) {
        OptChainParam o;
        o.exchange = js::strOr(p.get(u"exchange"_s), QString());
        o.tradingClass = js::strOr(p.get(u"tradingClass"_s), QString());
        if (const OJson* e = p.get(u"expirations"_s); js::isArr(e))
            for (const OJson& x : e->items) o.expirations.append(js::str(&x));
        if (const OJson* k = p.get(u"strikes"_s); js::isArr(k))
            for (const OJson& x : k->items) o.strikes.push_back(js::num(&x));
        out.push_back(o);
    }
    co_return out;
}

Task<Depth> IbApiNextSession::depthCo(std::shared_ptr<IbApiNextSession> self, IbContract contract, int rows, int waitMs) {
    auto out = std::make_shared<Depth>();
    auto sub = self->api_->getMarketDepth(toIbContract(contract), rows, true);
    ibnext::Observer o;
    o.next = [out](const Upd& u) {
        auto book = anyPtr<ibnext::DepthBook>(u.all);
        auto rowsOf = [](const OrderedMap<double, OJson>* side) {
            std::vector<DepthRow> list;
            if (!side) return list;
            for (const auto& [k, v] : side->items) {
                const OJson* price = v.get(u"price"_s);
                if (js::isNum(price) && price->n > 0) {
                    const OJson* size = v.get(u"size"_s);
                    list.push_back({price->n, js::nullish(size) ? 0 : js::num(size)});
                }
            }
            return list;
        };
        out->bids = rowsOf(book ? &book->bids : nullptr);
        out->asks = rowsOf(book ? &book->asks : nullptr);
    };
    o.error = [](const ibnext::ApiError&) {};
    auto handle = sub->subscribe(std::move(o));
    co_await self->sleep(waitMs);
    handle->unsubscribe();
    co_return *out;
}

Task<TradeLike> IbApiNextSession::placeCo(std::weak_ptr<IbApiNextSession> weak, IbContract contract, OrderIntent order) {
    ibnext::Task<double> pending;
    {
        auto self = weak.lock();
        if (!self) throw util::JsError(sessionClosed());
        // 断着就当场报错:库会把命令排进缓冲、重连后才发出(见 LinkDownError)。第一句,什么都还没碰
        if (!self->connected_) throw LinkDownError();
        const OJson ibOrder = orderForWire(order);
        // 带着原 orderId 就是改单:IBKR 的改单语义是同一个 id 重发
        if (order.orderId && *order.orderId != 0) {
            self->api_->modifyOrder(*order.orderId, toIbContract(contract), ibOrder);
            co_return TradeLike{order.orderId, std::nullopt, u"Submitted"_s};
        }
        pending = self->api_->placeNewOrder(toIbContract(contract), ibOrder);
    }
    // 等 nextValidId 的时候不拿着会话:等的结果在订阅表里,链路断了它就永远不来(TS 原样:这张单一直没有回音)
    const double orderId = co_await pending;
    co_return TradeLike{static_cast<int>(orderId), std::nullopt, u"Submitted"_s};
}

namespace {
/// o?.orderId ?? o?.order?.orderId ?? 0
const OJson* orderIdOf(const OJson& o) {
    static const OJson zero = OJson::number(0);
    const OJson* a = o.get(u"orderId"_s);
    if (!js::nullish(a)) return a;
    const OJson* b = js::path(&o, {u"order"_s, u"orderId"_s});
    if (!js::nullish(b)) return b;
    return &zero;
}
}  // namespace

Task<std::vector<OpenTrade>> IbApiNextSession::openTradesCo(std::weak_ptr<IbApiNextSession> weak) {
    ibnext::Task<ibnext::JsList> pending;
    if (auto self = weak.lock()) pending = self->api_->getAllOpenOrders();
    else throw util::JsError(sessionClosed());
    const ibnext::JsList open = co_await pending;
    std::vector<OpenTrade> out;
    for (const OJson& o : open) {
        OpenTrade t;
        const double id = js::num(orderIdOf(o));
        if (id != 0 && !std::isnan(id)) t.orderId = static_cast<int>(id);
        t.cancel = [weak, id] {
            auto s = weak.lock();
            if (!s) return;
            Runtime::Scope scope(*s->rt_);
            s->api_->cancelOrder(id);
        };
        out.push_back(std::move(t));
    }
    co_return out;
}

Task<std::vector<OpenTradeDetail>> IbApiNextSession::openDetailedCo(std::weak_ptr<IbApiNextSession> weak) {
    ibnext::Task<ibnext::JsList> pending;
    if (auto self = weak.lock()) pending = self->api_->getAllOpenOrders();
    else throw util::JsError(sessionClosed());
    const ibnext::JsList open = co_await pending;
    auto num = [](const OJson* v) -> std::optional<double> {
        if (js::nullish(v)) return std::nullopt;
        const double n = js::num(v);
        if (!std::isfinite(n) || n >= 1.7e308) return std::nullopt;
        return n;
    };
    auto intOrNull = [](double n) -> std::optional<int> {
        if (n == 0 || std::isnan(n)) return std::nullopt;
        return static_cast<int>(n);
    };
    std::vector<OpenTradeDetail> out;
    for (const OJson& o : open) {
        const OJson* orderP = o.get(u"order"_s);
        const OJson order = js::nullish(orderP) ? js::object() : *orderP;
        const OJson* cP = o.get(u"contract"_s);
        const OJson c = js::nullish(cP) ? js::object() : *cP;
        auto f = [&](const QString& k) { return order.get(k); };
        OpenTradeDetail d;
        d.orderId = intOrNull(js::num(orderIdOf(o)));
        d.permId = intOrNull(js::nullish(f(u"permId"_s)) ? 0 : js::num(f(u"permId"_s)));
        d.orderRef = js::strOr(f(u"orderRef"_s), QString());
        d.account = js::strOr(f(u"account"_s), QString());
        d.action = js::strOr(f(u"action"_s), QString());
        d.orderType = js::strOr(f(u"orderType"_s), QString());
        d.totalQuantity = js::nullish(f(u"totalQuantity"_s)) ? 0 : js::num(f(u"totalQuantity"_s));
        d.lmtPrice = num(f(u"lmtPrice"_s));
        d.auxPrice = num(f(u"auxPrice"_s));
        d.trailingPercent = num(f(u"trailingPercent"_s));
        d.status = js::strOr(js::path(&o, {u"orderState"_s, u"status"_s}), QString());
        d.ocaGroup = js::strOr(f(u"ocaGroup"_s), QString());
        d.ocaType = intOrNull(js::nullish(f(u"ocaType"_s)) ? 0 : js::num(f(u"ocaType"_s)));
        d.tif = js::strOr(f(u"tif"_s), u"GTC"_s);
        d.outsideRth = js::truthy(f(u"outsideRth"_s));
        if (const OJson* cs = f(u"conditions"_s); js::isArr(cs))
            for (const OJson& condition : cs->items) d.conditions.push_back(condition);
        if (!d.conditions.empty()) {
            d.conditionsCancelOrder = js::truthy(f(u"conditionsCancelOrder"_s));
            d.conditionsIgnoreRth = js::truthy(f(u"conditionsIgnoreRth"_s));
        }
        auto cs = [&](const QString& k, const QString& fb) { return js::strOr(c.get(k), fb); };
        d.contract.secType = cs(u"secType"_s, QString());
        d.contract.symbol = cs(u"symbol"_s, QString());
        d.contract.exchange = cs(u"exchange"_s, u"SMART"_s);
        d.contract.currency = cs(u"currency"_s, u"USD"_s);
        d.contract.conId = static_cast<int>(js::nullish(c.get(u"conId"_s)) ? 0 : js::num(c.get(u"conId"_s)));
        if (js::truthy(c.get(u"lastTradeDateOrContractMonth"_s))) d.contract.lastTradeDateOrContractMonth = js::str(c.get(u"lastTradeDateOrContractMonth"_s));
        if (js::truthy(c.get(u"strike"_s))) d.contract.strike = js::num(c.get(u"strike"_s));
        if (js::truthy(c.get(u"right"_s))) d.contract.right = js::str(c.get(u"right"_s));
        if (js::truthy(c.get(u"multiplier"_s))) d.contract.multiplier = js::str(c.get(u"multiplier"_s));
        if (js::truthy(c.get(u"tradingClass"_s))) d.contract.tradingClass = js::str(c.get(u"tradingClass"_s));
        if (const OJson* legs = c.get(u"comboLegs"_s); js::isArr(legs) && !legs->items.isEmpty()) {
            d.contract.hasComboLegs = true;
            for (const OJson& l : legs->items)
                d.contract.comboLegs.push_back({static_cast<int>(js::num(l.get(u"conId"_s))), js::num(l.get(u"ratio"_s)), js::strOr(l.get(u"action"_s), QString()),
                                                js::strOr(l.get(u"exchange"_s), QString())});
        }
        out.push_back(std::move(d));
    }
    co_return out;
}

Task<std::vector<PositionItemLike>> IbApiNextSession::positionsCo(std::shared_ptr<IbApiNextSession> self) {
    // 断着就当场报错,不去干等 8 秒
    if (!self->connected_) throw util::JsError(u"与 TWS 的连接已断开,正在自动重连"_s);
    self->ensurePositions();
    if (!self->positionsLatest_) {
        util::Deferred<> d;
        Runtime* rt = self->rt_.get();
        const quint64 timer = rt->setTimeout(8000, [d, rt] { ibnext::resolveLater(*rt, d); });
        self->positionsWaiters_.push_back([d, rt, timer] {
            rt->clearTimeout(timer);
            ibnext::resolveLater(*rt, d);
        });
        co_await d.task();
    }
    if (!self->positionsLatest_) {
        // 拿不到 ≠ 没有持仓
        if (self->positionsSub_) self->positionsSub_->unsubscribe();
        self->positionsSub_.reset();
        throw util::JsError(u"TWS 在 8 秒内没有推送持仓,本轮读不到持仓"_s);
    }
    std::vector<PositionItemLike> out;
    for (const auto& [k, p] : self->positionsLatest_->items) {
        PositionItemLike item;
        OJson contract = p.contract && p.contract->isObject() ? *p.contract : js::object();
        contract.set(u"account"_s, js::S(p.account));
        item.contract = contract;
        item.position = p.pos;
        item.avgCost = p.avgCost;
        out.push_back(item);
    }
    co_return out;
}

Task<std::vector<ExecutionRow>> IbApiNextSession::executionsCo(std::weak_ptr<IbApiNextSession> weak) {
    ibnext::Task<ibnext::JsList> pending;
    if (auto self = weak.lock()) pending = self->api_->getExecutionDetails(js::object());
    else throw util::JsError(sessionClosed());
    const ibnext::JsList details = co_await pending;
    std::vector<ExecutionRow> out;
    for (const OJson& d : details) out.push_back({orElse(d.get(u"contract"_s), js::object()), orElse(d.get(u"execution"_s), js::object())});
    co_return out;
}

Task<std::optional<std::vector<ExecutionRow>>> IbApiNextSession::historyCo(std::shared_ptr<IbApiNextSession> self, int days) {
    HistoryRequest r;
    r.host = self->cfg_.host;
    r.port = self->cfg_.port;
    r.clientId = historyClientId(self->cfg_.clientId);
    r.days = days;
    const HistoryResult got = co_await self->deps_.fetchHistory(r);
    if (!got.supported) co_return std::nullopt;
    co_return got.details;
}

}  // namespace

Task<TradeLike> ClosedSessionProbe::placeOrder(IbContract contract, OrderIntent order) {
    return IbApiNextSession::placeCo({}, std::move(contract), std::move(order));
}
Task<std::vector<RawBar>> ClosedSessionProbe::historicalData(IbContract contract, HistoricalRequest opts) {
    return IbApiNextSession::historicalCo({}, std::move(contract), std::move(opts));
}
Task<std::vector<OptChainParam>> ClosedSessionProbe::secDefOptParams(QString symbol, QString secType, int conId) {
    return IbApiNextSession::secDefCo({}, std::move(symbol), std::move(secType), conId);
}
Task<std::vector<OpenTrade>> ClosedSessionProbe::openTrades() { return IbApiNextSession::openTradesCo({}); }
Task<std::vector<OpenTradeDetail>> ClosedSessionProbe::openTradesDetailed() { return IbApiNextSession::openDetailedCo({}); }
Task<std::vector<ExecutionRow>> ClosedSessionProbe::executions() { return IbApiNextSession::executionsCo({}); }
Task<> ClosedSessionProbe::qualifyLoop(std::vector<IbContract*> contracts) {
    return IbApiNextSession::qualifyLoop({}, std::move(contracts), std::make_shared<bool>(false));
}
Task<std::optional<std::array<QString, 3>>> ClosedSessionProbe::hoursWork(IbContract contract) {
    return IbApiNextSession::hoursWork({}, std::move(contract));
}

Task<std::shared_ptr<IbSession>> createIbApiNextSession(SessionConfig cfg, IbSessionDeps deps) {
    if (!deps.runtime) deps.runtime = ibnext::makeQtRuntime();
    if (!deps.sockets) deps.sockets = ibnext::tcpSocketFactory();
    if (!deps.fetchHistory) deps.fetchHistory = [](HistoryRequest r) { return fetchExecutionHistory(std::move(r)); };
    if (!deps.log) deps.log = [](const QString& line) { std::fprintf(stderr, "%s\n", line.toUtf8().constData()); };
    auto rt = deps.runtime;
    Runtime::Scope s(*rt);
    auto self = std::make_shared<IbApiNextSession>(std::move(cfg), std::move(deps));
    return IbApiNextSession::create(self);
}

}  // namespace ibkr::execution
