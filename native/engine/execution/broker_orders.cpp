// BrokerRouter:下单(place、条件单的价格条件)、撤全部、券商托管的止盈 / 止损(挂、改、撤、认领)。broker.ts 的末段。钱路径。
#include "execution/broker.h"

#include "execution/broker_internal.h"
#include "execution/ib_contracts.h"
#include "util/jsobj.h"

#include <cmath>

namespace ibkr::execution {

using namespace Qt::StringLiterals;
using util::OJson;
using util::Task;
namespace js = util::js;
using detail::optNum;
using detail::prop;

namespace {
/// `x !== null`(没有这个键 = undefined,也算 !== null)
bool notJsonNull(const OJson* v) { return !(v && v->type == OJson::Null); }
}  // namespace

Task<PlacementResult> BrokerRouter::place(QString recordId, parsing::validator::ApprovedOrder approved, std::optional<double> limitOverride) {
    const OJson* parsedOrder = prop(approved.order, u"order"_s);
    const OJson* parsedContract = prop(approved.order, u"contract"_s);
    const OJson* trigger = prop(approved.order, u"trigger"_s);
    const SessionPtr session = co_await forAccount(approved.account);
    const IbContract contract = co_await qualify(*parsedContract, approved.account);

    OrderIntent order;
    const OJson* secType = prop(parsedContract, u"secType"_s);
    if (js::isStr(secType) && secType->s == u"BAG") {
        // BAG 一律以 BUY 提交:IBKR 对 BAG 的 SELL 会反转每条腿的方向
        std::optional<double> signedLimit;
        if (limitOverride) {
            signedLimit = limitOverride;  // AUTO_MID 已是带符号净价
        } else {
            signedLimit = bagSignedLimit(js::str(prop(parsedOrder, u"action"_s)), optNum(prop(parsedOrder, u"lmtPrice"_s)));
        }
        order = buildOrderIntent(*parsedOrder, approved.account.account_id, signedLimit, QString(u"BUY"));
    } else {
        order = buildOrderIntent(*parsedOrder, approved.account.account_id, limitOverride);
    }
    // 幂等标识:回报、对账、去重都能凭 orderRef 找回这条记录
    order.orderRef = recordId;

    // 方式 A:用户给了明确价格的条件单,条件挂在 IBKR 服务器上,软件掉线也有效
    const OJson* priceMode = prop(parsedOrder, u"price_mode"_s);
    if (notJsonNull(trigger) && js::isStr(priceMode) && priceMode->s == u"EXPLICIT") {
        const OJson cond = co_await priceCondition(session, trigger ? std::optional<OJson>(*trigger) : std::nullopt);  // trigger 缺键时 TS 在 priceConditionSpec 里抛 TypeError
        order.conditions = {cond};
        order.conditionsCancelOrder = false;
    }

    // 不再 settle(500):orderId 在 placeOrder 返回时已经确定,状态与成交由事件回报异步落库
    const TradeLike trade = co_await session->placeOrder(contract, order);
    // 记住这张单的会话 / 合约 / 原样订单:追踪的平仓单发出后要按秒改价(modifyHosted),改单是同 orderId 整张重发,得有原样的那一份
    if (trade.orderId && *trade.orderId != 0) hostedTrades_.insert(*trade.orderId, HostedEntry{session, contract, order});
    PlacementResult r;
    r.record_id = recordId;
    r.order_id = trade.orderId;
    r.perm_id = trade.permId;
    r.status = trade.status.isEmpty() ? u"Submitted"_s : trade.status;
    r.limit_price = order.lmtPrice;
    r.detailAccount = approved.account.account_id;
    co_return r;
}

Task<OJson> BrokerRouter::priceCondition(SessionPtr session, std::optional<OJson> triggerOpt) {
    const OJson* trigger = triggerOpt ? &*triggerOpt : nullptr;
    const OJson spec = priceConditionSpec(trigger);
    const QString symbol = js::str(prop(trigger, u"symbol"_s));
    const contract::IndexConfig* cfg = settings.indexConfig(symbol);
    const OJson* st = prop(trigger, u"secType"_s);
    IbContract target = js::isStr(st) && st->s == u"IND" ? indexContract(symbol, cfg ? cfg->exchange : u"CBOE"_s) : stockContract(symbol);
    co_await qualifyOrRaise(session, &target, true);
    OJson out = js::object({{u"type"_s, js::S(u"price"_s)}});
    if (target.conId) out.set(u"conId"_s, js::N(*target.conId));
    out.set(u"exchange"_s, js::S(target.exchange));
    if (const OJson* v = prop(spec, u"isMore"_s)) out.set(u"isMore"_s, *v);
    if (const OJson* v = prop(spec, u"price"_s)) out.set(u"price"_s, *v);
    co_return out;
}

Task<std::vector<OJson>> BrokerRouter::hostedSpotConditions(SessionPtr session, QString symbol, OJson conditions) {
    if (!js::isArr(&conditions) || conditions.items.isEmpty() || conditions.items.size() > 2)
        throw BrokerError(u"标的条件止损缺少有效的价格条件,拒绝发送无条件平仓单。"_s);
    std::vector<OJson> out;
    for (const OJson& c : conditions.items) {
        const auto price = js::finiteOrNull(c.get(u"price"_s));
        if (!price || *price <= 0 || !c.get(u"isMore"_s) || c.get(u"isMore"_s)->type != OJson::Bool)
            throw BrokerError(u"标的条件止损的价格或方向无效。"_s);
        const OJson trigger = js::object({{u"symbol"_s, js::S(symbol)},
            {u"secType"_s, js::S(settings.indexConfig(symbol) ? u"IND"_s : u"STK"_s)},
            {u"operator"_s, js::S(c.get(u"isMore"_s)->b ? u">="_s : u"<="_s)}, {u"value"_s, js::N(*price)}});
        OJson condition = co_await priceCondition(session, trigger);
        condition.set(u"triggerMethod"_s, js::N(2));  // Last:指数点位 / 股票最新成交价
        condition.set(u"conjunctionConnection"_s, js::S(u"o"_s));  // 跌到下沿 OR 涨到上沿
        out.push_back(condition);
    }
    co_return out;
}

/** 熔断用:撤掉全部未成交单(§9.7)。 */
Task<int> BrokerRouter::cancelAllOpen() {
    int count = 0;
    QSet<QString> visited;
    while (SessionPtr session = nextUnvisited(visited)) {
        if (!session->isConnected()) continue;
        for (const OpenTrade& trade : co_await session->openTrades()) {
            trade.cancel();
            count += 1;
        }
    }
    co_return count;
}

// ---- 券商托管的止盈/止损(GTC + OCA,挂在 IBKR 服务器上)---------------

/** 挂一张托管单。GTC:软件关掉它也站岗——这正是托管的意义。OCA 组内一张成交,券商自动撤其余,与"触发一次就落闩"同义。 */
Task<HostedPlacement> BrokerRouter::placeHosted(contract::AccountConfig account, OJson contractSpec, OJson item, QString ocaGroup, QString orderRef) {
    const SessionPtr session = co_await forAccount(account);
    const IbContract contract = co_await qualify(contractSpec, account);
    // BAG 一律以 BUY 提交:IBKR 对 BAG 的 SELL 会把每条腿再反转一次。带符号净价由 bagSignedLimit 换算——
    // 托管一张平掉借方蝶的限价单是收权利金,发给 IBKR 的净价必须是负数。与 place() 同一套换算。
    const OJson* st = prop(contractSpec, u"secType"_s);
    const bool isBag = js::isStr(st) && st->s == u"BAG";
    const QString itemAction = js::str(prop(item, u"action"_s));
    OrderIntent order;
    order.action = isBag ? u"BUY"_s : itemAction;
    order.orderType = js::str(prop(item, u"order_type"_s));
    order.totalQuantity = js::num(prop(item, u"quantity"_s));
    order.lmtPrice = isBag ? bagSignedLimit(itemAction, optNum(prop(item, u"lmt_price"_s))) : optNum(prop(item, u"lmt_price"_s));
    order.auxPrice = optNum(prop(item, u"aux_price"_s));
    order.trailingPercent = optNum(prop(item, u"trailing_percent"_s));
    order.tif = u"GTC"_s;
    // 托管止盈/止损同样要全时段站岗:股票开盘外标志,盘前盘后也能触发成交。期权没有盘外交易,标志对它无意义,不打。
    order.outsideRth = js::isStr(st) && st->s == u"STK";
    order.account = account.account_id;
    order.transmit = true;
    order.orderRef = orderRef;
    order.ocaGroup = ocaGroup;
    order.ocaType = 1;  // 一张成交,整组撤销
    if (js::str(item.get(u"kind"_s)) == u"spot") {
        order.conditions = co_await hostedSpotConditions(session, contract.symbol, js::copyOrNull(item.get(u"spot_conditions"_s)));
        order.conditionsCancelOrder = false;
        order.conditionsIgnoreRth = false;
    }
    // 用持久化峰值播种 TRAIL 初始停损:重启不把已锁住的利润放开
    if (notJsonNull(prop(item, u"trailing_percent"_s)) && notJsonNull(prop(item, u"trail_stop_seed"_s))) {
        order.trailStopPrice = optNum(prop(item, u"trail_stop_seed"_s));
    }
    const TradeLike trade = co_await session->placeOrder(contract, order);
    if (trade.orderId && *trade.orderId != 0) hostedTrades_.insert(*trade.orderId, HostedEntry{session, contract, order});
    HostedPlacement r;
    r.order_id = trade.orderId;
    r.perm_id = trade.permId;
    r.status = trade.status.isEmpty() ? u"Submitted"_s : trade.status;
    co_return r;
}

/** 改一张托管单的价格/数量(同 orderId 重发 = IBKR 的改单语义)。撤了重挂会留出一段没有保护的窗口,改单没有——所以必须是改,不是换。 */
Task<bool> BrokerRouter::modifyHosted(int orderId, OJson item) {
    const auto found = hostedTrades_.find(orderId);
    if (found == hostedTrades_.end()) co_return false;
    // 合约核对会挂起:不跨 await 保存 QHash 中元素的地址,并在返回后重新确认订单还在。
    std::optional<std::vector<OJson>> conditions;
    if (js::str(item.get(u"kind"_s)) == u"spot") {
        const SessionPtr session = found->session;
        const QString symbol = found->contract.symbol;
        conditions = co_await hostedSpotConditions(session, symbol, js::copyOrNull(item.get(u"spot_conditions"_s)));
    }
    const auto current = hostedTrades_.find(orderId);
    if (current == hostedTrades_.end()) co_return false;
    HostedEntry* entry = &current.value();
    if (conditions) {
        entry->order.conditions = *conditions;
        entry->order.conditionsCancelOrder = false;
        entry->order.conditionsIgnoreRth = false;
        entry->order.orderType = js::str(item.get(u"order_type"_s));
        entry->order.lmtPrice.reset();
    }
    entry->order.orderId = orderId;
    entry->order.totalQuantity = js::num(prop(item, u"quantity"_s));
    // 组合改价同样要走带符号净价——挂单时签了、改单时忘了签,第一次调价就会把一张"收 12.35"的单改成"付 12.35"。
    const bool isBag = entry->contract.secType == u"BAG";
    const QString itemAction = js::str(prop(item, u"action"_s));
    if (notJsonNull(prop(item, u"lmt_price"_s))) {
        const std::optional<double> lmt = optNum(prop(item, u"lmt_price"_s));
        entry->order.lmtPrice = isBag ? bagSignedLimit(itemAction, lmt) : lmt;
    }
    if (notJsonNull(prop(item, u"aux_price"_s))) entry->order.auxPrice = optNum(prop(item, u"aux_price"_s));
    if (notJsonNull(prop(item, u"trailing_percent"_s))) entry->order.trailingPercent = optNum(prop(item, u"trailing_percent"_s));
    const SessionPtr session = entry->session;
    const IbContract contract = entry->contract;
    const OrderIntent order = entry->order;
    co_await session->placeOrder(contract, order);
    co_return true;
}

Task<bool> BrokerRouter::cancelHosted(int orderId) {
    const auto it = hostedTrades_.constFind(orderId);
    if (it == hostedTrades_.cend()) co_return false;
    const SessionPtr session = it.value().session;
    co_await session->cancelOrder(orderId);  // 撤单发出去了才忘掉这张单:先删再撤的话,失败后重试回 false 被当成已撤
    hostedTrades_.remove(orderId);
    co_return true;
}

/** 从券商未成交单里认领托管单(orderRef 前缀匹配)。重启后的第一件事:先认领再对账,否则同一追踪会被再挂一遍。 */
Task<QList<OJson>> BrokerRouter::listHostedOpen(QString refPrefix) {
    QList<OJson> rows;
    QSet<QString> visited;
    while (SessionPtr session = nextUnvisited(visited)) {
        if (!session->isConnected() || !session->has(Cap::OpenTradesDetailed)) continue;
        for (const OpenTradeDetail& trade : co_await session->openTradesDetailed()) {
            if (!trade.orderRef.startsWith(refPrefix)) continue;
            if (trade.orderId && *trade.orderId != 0) {
                OrderIntent o;
                o.action = trade.action;
                o.orderType = trade.orderType;
                o.totalQuantity = trade.totalQuantity;
                o.lmtPrice = trade.lmtPrice;
                o.auxPrice = trade.auxPrice;
                o.trailingPercent = trade.trailingPercent;
                o.tif = trade.tif.isEmpty() ? u"GTC"_s : trade.tif;
                o.outsideRth = trade.outsideRth;
                o.account = trade.account;
                o.transmit = true;
                o.orderRef = trade.orderRef;
                o.conditions = trade.conditions;
                o.conditionsCancelOrder = trade.conditionsCancelOrder;
                o.conditionsIgnoreRth = trade.conditionsIgnoreRth;
                // 改单要整张重发:不带上原来的 OCA 组,改一次价就可能把它踢出组
                if (!trade.ocaGroup.isEmpty()) {
                    o.ocaGroup = trade.ocaGroup;
                    o.ocaType = trade.ocaType ? *trade.ocaType : 1;
                }
                hostedTrades_.insert(*trade.orderId, HostedEntry{session, trade.contract, o});
            }
            // BAG 在券商侧存的是带符号净价(平借方蝶是负数),引擎这边一律用用户口径的正数比较。
            std::optional<double> lmt = trade.lmtPrice;
            if (trade.contract.secType == u"BAG" && lmt) lmt = std::fabs(*lmt);
            rows.append(js::object({{u"order_ref"_s, js::S(trade.orderRef)},
                                    {u"order_id"_s, trade.orderId ? js::N(*trade.orderId) : js::Null()},
                                    {u"perm_id"_s, trade.permId ? js::N(*trade.permId) : js::Null()},
                                    {u"account"_s, js::S(trade.account)},
                                    {u"action"_s, js::S(trade.action)},
                                    {u"order_type"_s, js::S(trade.orderType)},
                                    {u"quantity"_s, js::N(trade.totalQuantity)},
                                    {u"lmt_price"_s, detail::numOrNull(lmt)},
                                    {u"aux_price"_s, detail::numOrNull(trade.auxPrice)},
                                    {u"trailing_percent"_s, detail::numOrNull(trade.trailingPercent)},
                                    {u"status"_s, js::S(trade.status)},
                                    {u"sec_type"_s, js::S(trade.contract.secType)}}));
            if (trade.orderRef.endsWith(u":spot")) {
                OJson conditions = js::array();
                for (const OJson& c : trade.conditions)
                    conditions.items.append(js::object({{u"price"_s, js::copyOrNull(c.get(u"price"_s))}, {u"isMore"_s, js::copyOrNull(c.get(u"isMore"_s))}}));
                rows.last().set(u"spot_conditions"_s, conditions);
            }
        }
    }
    co_return rows;
}

/** 券商侧全部未成交单(不按 orderRef 过滤)。执行对账用。顺带把每张单登记进 hostedTrades,改单 / 撤单才有原样订单可发。 */
Task<QList<OJson>> BrokerRouter::listOpenOrdersDetailed() { co_return co_await listHostedOpen(QString()); }

}  // namespace ibkr::execution
