// BrokerRouter:持仓(positions 与它的行情补价)、持仓期权腿 / 正股的常驻订阅、成交、合约交易时段。broker.ts 的后段。
#include "execution/broker.h"

#include "domain/positions.h"
#include "execution/broker_internal.h"
#include "execution/ib_contracts.h"
#include "execution/qualify_gate.h"
#include "util/collate.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/market_js.h"
#include "util/py.h"

#include <algorithm>
#include <cmath>

namespace ibkr::execution {

using namespace Qt::StringLiterals;
using util::OJson;
using util::Task;
namespace js = util::js;
using detail::messageOf;
using detail::prop;

namespace {

bool isOptionLike(const OJson& row) {
    const OJson* t = prop(row, u"sec_type"_s);
    return js::isStr(t) && (t->s == u"OPT" || t->s == u"FOP");
}
bool isStock(const OJson& row) {
    const OJson* t = prop(row, u"sec_type"_s);
    return js::isStr(t) && t->s == u"STK";
}
/// row["market_price"] === null(严格的 null,没有这个键不算)
bool priceIsNull(const OJson& row) {
    const OJson* p = prop(row, u"market_price"_s);
    return p && p->type == OJson::Null;
}

}  // namespace

/// 同步读已缓存的合约时段(校验链路不是 async,不能在那里等一次网络往返)。没缓存回空,调用方退回正股表;缓存由追踪轮询那条路每天填上一次。
std::optional<std::array<QString, 3>> BrokerRouter::cachedContractHours(const QString& symbol, const QString& expiry) {
    const auto it = hoursCache_.constFind(symbol + u'|' + expiry);
    if (it == hoursCache_.cend() || it.value()[0] != domain::nowEt().date) return std::nullopt;
    return std::array<QString, 3>{it.value()[1], it.value()[2], it.value()[3]};
}

/**
 * 这条持仓所在合约的真实交易时段 [tradingHours, liquidHours, timeZoneId]。不能用 Settings.marketStatus:那张表是照美股正股写的,SPX 期权不是这个时段。
 * 组合(BAG)本身没有时段,取它第一条腿的。查不到回空,让调用方退回正股那套,而不是把仓位卡死在"休市"。
 */
Task<std::optional<std::array<QString, 3>>> BrokerRouter::contractHours(OJson row, contract::AccountConfig account) {
    const QString secType = detail::strOr(prop(row, u"sec_type"_s));
    static const OJson emptyObj = js::object();
    const OJson* contractP = prop(row, u"contract"_s);
    const OJson& contract = js::nullish(contractP) ? emptyObj : *contractP;
    const OJson *expiry = nullptr, *strike = nullptr, *right = nullptr;
    if (secType == u"BAG") {
        const OJson* legs = prop(contract, u"legs"_s);
        if (js::nullish(legs) || legs->items.isEmpty()) co_return std::nullopt;
        const OJson& first = legs->items[0];
        expiry = prop(first, u"lastTradeDateOrContractMonth"_s);
        strike = prop(first, u"strike"_s);
        right = prop(first, u"right"_s);
    } else if (secType == u"OPT" || secType == u"FOP") {
        expiry = prop(contract, u"lastTradeDateOrContractMonth"_s);
        strike = prop(contract, u"strike"_s);
        right = prop(contract, u"right"_s);
    } else {
        co_return std::nullopt;
    }
    if (!js::truthy(expiry) || js::nullish(strike) || (js::isStr(strike) && strike->s.isEmpty()) || !js::truthy(right)) co_return std::nullopt;

    const QString key = js::str(prop(row, u"symbol"_s)) + u'|' + js::str(expiry);
    const QString today = domain::nowEt().date;
    if (const auto hit = hoursCache_.constFind(key); hit != hoursCache_.cend() && hit.value()[0] == today) {
        co_return std::array<QString, 3>{hit.value()[1], hit.value()[2], hit.value()[3]};
    }

    SessionPtr session;
    bool failed = false;
    try {
        session = co_await forAccount(account);
    } catch (...) {
        failed = true;
    }
    if (failed) co_return std::nullopt;
    if (!session->has(Cap::ContractHours)) co_return std::nullopt;
    IbContract probe;
    probe.secType = u"OPT"_s;
    probe.symbol = js::str(prop(row, u"symbol"_s));
    probe.exchange = u"SMART"_s;
    probe.currency = u"USD"_s;
    probe.lastTradeDateOrContractMonth = js::str(expiry);
    probe.strike = js::num(strike);
    probe.right = js::str(right).left(1).toUpper();
    probe.multiplier = u"100"_s;
    std::optional<std::array<QString, 3>> out;
    failed = false;
    try {
        out = co_await session->contractHours(probe, kQualifyTimeoutMs);
    } catch (...) {
        failed = true;
    }
    if (failed || !out) co_return std::nullopt;
    hoursCache_.insert(key, std::array<QString, 4>{today, (*out)[0], (*out)[1], (*out)[2]});
    co_return out;
}

/** 账户里现在拿着什么。优先 portfolio()(TWS 自己算的口径),退 positions()。 */
Task<QList<OJson>> BrokerRouter::positions() {
    contract::OrderedMap<OJson> out;
    QHash<QString, QString> aliasOf;
    for (const contract::AccountConfig& a : settings.accounts) aliasOf.insert(a.account_id, a.alias);

    NamedSessions named;
    for (const QString& k : connectionsMap_.keys()) named.emplace_back(k, connectionsMap_.value(k));
    const auto live = liveSessions(named, [](const QString& m) { return std::make_exception_ptr(BrokerError(m)); });
    for (const SessionPtr& session : live) {
        std::vector<PortfolioItemLike> items;
        try {
            items = co_await session->portfolio();
        } catch (...) {
            items.clear();  // 没订阅账户更新时会空手而归
        }
        for (const PortfolioItemLike& item : items) {
            // 账号在持仓项上(item.account),不在合约上——否则所有账户的仓都记到默认账户名下
            auto row = positionRow(item.contract, item.position, aliasOf, item.account.value_or(QString()));
            if (!row) continue;
            row->set(u"avg_cost"_s, js::N(cleanPrice(item.averageCost).value_or(0.0)));
            row->set(u"market_price"_s, detail::numOrNull(cleanPrice(item.marketPrice)));
            const double mv = finiteQuote(item.marketValue);
            row->set(u"market_value"_s, mv == 0 ? js::Null() : js::N(mv));
            row->set(u"unrealized_pnl"_s, js::N(finiteQuote(item.unrealizedPnL)));
            out.insert(js::str(prop(*row, u"key"_s)), *row);
        }
        // 读不到持仓要报错,不能当成空仓:空列表会让盯盘判"持仓已不存在",停掉追踪、撤掉托管单。
        // 多个会话里只要有一个读不到,整次都算读不到——只回一部分,读不到的那个账户照样会被误判。
        std::vector<PositionItemLike> rawPositions;
        std::exception_ptr failure;
        try {
            rawPositions = co_await session->positions();
        } catch (...) {
            failure = std::current_exception();
        }
        if (failure) throw BrokerError(u"读不到持仓:%1"_s.arg(messageOf(failure)));
        for (const PositionItemLike& pos : rawPositions) {
            auto row = positionRow(pos.contract, pos.position, aliasOf, pos.account.value_or(QString()));
            if (!row || out.contains(js::str(prop(*row, u"key"_s)))) continue;  // portfolio 更准
            row->set(u"avg_cost"_s, js::N(cleanPrice(pos.avgCost).value_or(0.0)));
            out.insert(js::str(prop(*row, u"key"_s)), *row);
        }
    }

    QList<OJson> rows;
    for (const QString& k : out.keys()) {
        const OJson& r = *out.find(k);
        if (js::truthy(prop(r, u"quantity"_s))) rows.append(r);
    }
    releaseClosed(rows);
    co_await fillPositionPrices(&rows);
    std::vector<OJson> sorted(rows.begin(), rows.end());
    util::market::jsSort(sorted, [](const OJson& a, const OJson& b) {
        const int first = util::localeCompare(js::str(prop(a, u"account"_s)), js::str(prop(b, u"account"_s)));
        if (first != 0) return double(first);
        return double(util::localeCompare(js::str(prop(a, u"symbol"_s)), js::str(prop(b, u"symbol"_s))));
    });
    co_return QList<OJson>(sorted.begin(), sorted.end());
}

/** 平掉的腿 / 正股撤掉常驻订阅(heldStreams.ts),不然一直占着行情线路。读不到 ≠ 平仓了:读持仓报错的那一轮走不到这里;
 *  有连接断着时它那个账户的仓只是这一轮看不见,也不撤。先撤后订:额度紧的时候先把线路腾出来。 */
void BrokerRouter::releaseClosed(const QList<OJson>& rows) {
    if (static_cast<qsizetype>(sessions().size()) < connectionsMap_.size()) return;
    QStringList optKeys;
    for (const OJson& r : rows) optKeys.append(u"opt:"_s + js::str(prop(r, u"key"_s)));
    optionStreams_.release(optKeys);
    // 顶栏行情带、标的现价订的是同一只股的同一条流,它们还在用就不撤
    const auto shared = [this](const QString& symbol) {
        std::vector<std::shared_ptr<TickerHandle>> out;
        const auto* a = streams_.find(symbol);
        out.push_back(a ? *a : nullptr);
        const auto* b = streams_.find(u"idx:"_s + symbol);
        out.push_back(b ? *b : nullptr);
        return out;
    };
    QStringList stocks;
    for (const OJson& r : rows) {
        if (isStock(r)) stocks.append(js::str(prop(r, u"symbol"_s)));
    }
    stockStreams_.release(stocks, shared);
}

std::optional<OJson> BrokerRouter::positionRow(const OJson& contract, double quantity, const QHash<QString, QString>& aliasOf, const QString& accountHint) {
    QString account = accountHint;
    if (account.isEmpty()) {
        const OJson* a = prop(contract, u"account"_s);
        account = js::truthy(a) ? js::str(a) : QString();
    }
    QString alias;
    if (const auto it = aliasOf.constFind(account); it != aliasOf.cend()) {
        alias = it.value();
    } else {
        if (!account.isEmpty()) {
            // 券商报了账号但别名表里没有:不是本软件管的账户,不显示、不追踪(每个账号只提醒一次)
            if (!unmappedAccounts_.contains(account)) {
                unmappedAccounts_.insert(account);
                logStderr(u"[ibkr] 账户 %1 不在配置的别名表里,它的持仓不显示、不追踪。"_s.arg(redactForLog(account)) +
                          u"要管这个账户,把它加进 config/settings.json 的 accounts。"_s);
            }
            return std::nullopt;
        }
        // 券商没报账号(极少见)才退到默认账户
        const contract::AccountConfig* dflt = settings.defaultAccount();
        if (!dflt) return std::nullopt;
        alias = dflt->alias;
    }
    const QString symbol = detail::strOr(prop(contract, u"symbol"_s));
    if (symbol.isEmpty()) return std::nullopt;
    const QString secType = detail::strOrDefault(prop(contract, u"secType"_s) ? prop(contract, u"secType"_s) : nullptr, u"STK"_s);
    const OJson* mulP = prop(contract, u"multiplier"_s);
    double multiplier = js::nullish(mulP) ? 0 : js::num(mulP);
    if (std::isnan(multiplier) || multiplier == 0) multiplier = 1;
    if (!std::isfinite(multiplier)) multiplier = 1.0;
    const auto truthyOrNull = [&](const char16_t* k) {
        const OJson* v = prop(contract, QString::fromUtf16(k));
        return js::truthy(v) ? *v : js::Null();
    };
    const QString currencyStr = detail::strOrDefault(prop(contract, u"currency"_s) ? prop(contract, u"currency"_s) : nullptr, u"USD"_s);
    const double strikeN = detail::numOr0(prop(contract, u"strike"_s));
    OJson spec = js::object({{u"secType"_s, js::S(secType)},
                             {u"symbol"_s, js::S(symbol)},
                             {u"exchange"_s, js::S(detail::strOrDefault(prop(contract, u"exchange"_s), u"SMART"_s))},
                             {u"currency"_s, js::S(currencyStr)},
                             {u"lastTradeDateOrContractMonth"_s, truthyOrNull(u"lastTradeDateOrContractMonth")},
                             {u"strike"_s, strikeN == 0 ? js::Null() : js::N(strikeN)},
                             {u"right"_s, truthyOrNull(u"right")},
                             {u"multiplier"_s, js::S(multiplier != 0 ? util::jsNumberToString(std::trunc(multiplier)) : u"100"_s)},
                             {u"tradingClass"_s, truthyOrNull(u"tradingClass")}});
    // 期权按腿区分:一只蝴蝶三条腿都是同一个 symbol/secType,key 不带腿身份就会互相覆盖
    const QString leg = domain::legOf(&spec);
    const double q = std::isnan(quantity) || quantity == 0 ? 0 : quantity;
    return js::object({{u"key"_s, js::S(domain::makeKey(alias, symbol, secType, leg))},
                       {u"account"_s, js::S(alias)},
                       {u"symbol"_s, js::S(symbol)},
                       {u"sec_type"_s, js::S(secType)},
                       {u"leg"_s, js::S(leg)},
                       {u"label"_s, js::S(domain::positionLabel(symbol, secType, &spec))},
                       {u"quantity"_s, js::N(q)},
                       {u"multiplier"_s, js::N(multiplier)},
                       {u"currency"_s, js::S(currencyStr)},
                       {u"avg_cost"_s, js::N(0.0)},
                       {u"market_price"_s, js::Null()},
                       {u"market_value"_s, js::Null()},
                       {u"unrealized_pnl"_s, js::Null()},
                       {u"contract"_s, spec}});
}

/** 期权腿的现价:常驻订阅(每腿一条线路,订阅一次留着),读盘口中间价,没盘口退最新价。不订阅的话组合价格永远是"—",追踪也永远不触发。 */
Task<> BrokerRouter::fillOptionPrices(QList<OJson>* rows) {
    QList<qsizetype> idx;
    QList<OJson> legs;
    for (qsizetype i = 0; i < rows->size(); ++i) {
        if (priceIsNull((*rows)[i]) && isOptionLike((*rows)[i])) {
            idx.append(i);
            legs.append((*rows)[i]);
        }
    }
    if (legs.isEmpty()) co_return;
    const auto live = sessions();
    const SessionPtr session = live.empty() ? nullptr : live[0];
    if (!session) co_return;
    co_await ensureOptionStreams(session, legs);
    for (const qsizetype i : idx) {
        OJson& row = (*rows)[i];
        const HeldStream* entry = optionStreams_.find(u"opt:"_s + js::str(prop(row, u"key"_s)));
        if (!entry || !entry->handle) continue;
        const TickerData t = entry->handle->read();
        // 买价恰好为 0 = 没人出价(0DTE 远翼常见),卖价在就是真盘口,按 (0+卖价)/2 记;退到最新成交可能拿到几小时前的价。−1 / NaN 才是真没有
        const std::optional<double> bid = t.bid == 0 ? std::optional<double>(0) : cleanPrice(t.bid);
        const std::optional<double> ask = cleanPrice(t.ask);
        if (bid && ask && *ask >= *bid) {
            row.set(u"market_price"_s, js::N(util::pyRound((*bid + *ask) / 2.0, 4)));
        } else {
            std::optional<double> p = cleanPrice(t.last);
            if (!p) p = cleanPrice(t.marketPrice);
            row.set(u"market_price"_s, detail::numOrNull(p));
        }
        // 休市时 TWS 只报昨收。昨收只给界面看,绝不填进 market_price。model_iv:IBKR 模型 IV;没有就不带这个键
        const std::optional<double> close = cleanPrice(t.close);
        const std::optional<double> iv = t.modelGreeks ? cleanPrice(t.modelGreeks->impliedVol) : std::nullopt;
        if (close) row.set(u"close_price"_s, js::N(*close));
        if (iv) row.set(u"model_iv"_s, js::N(*iv));
    }
}

/**
 * 持仓期权腿此刻的买卖价(按持仓 key)。和 fillOptionPrices 共用同一批常驻订阅:第一次要等首笔 tick,之后每轮只读缓存。
 * 拿不到的腿给 null,不编;买价恰好为 0 照实给 0。
 */
Task<OJson> BrokerRouter::optionQuotes(QList<OJson> rows) {
    QList<OJson> legs;
    for (const OJson& r : rows) {
        if (isOptionLike(r)) legs.append(r);
    }
    OJson out = js::object();
    if (legs.isEmpty()) co_return out;
    const auto live = sessions();
    const SessionPtr session = live.empty() ? nullptr : live[0];
    if (!session) co_return out;
    co_await ensureOptionStreams(session, legs);
    for (const OJson& row : legs) {
        const HeldStream* entry = optionStreams_.find(u"opt:"_s + js::str(prop(row, u"key"_s)));
        const bool have = entry && entry->handle;
        TickerData t;
        if (have) t = entry->handle->read();
        out.set(js::str(prop(row, u"key"_s)),
                js::object({{u"bid"_s, have ? (t.bid == 0 ? js::N(0) : detail::numOrNull(cleanPrice(t.bid))) : js::Null()},
                            {u"ask"_s, have ? detail::numOrNull(cleanPrice(t.ask)) : js::Null()}}));
    }
    co_return out;
}

/** 给这些期权腿备好常驻行情订阅(已有的跳过,被拒过的摘掉重订)。 */
Task<> BrokerRouter::ensureOptionStreams(SessionPtr session, QList<OJson> legs) {
    bool fresh = false;
    // 纸面账户按类型 3 订(有实时就是实时,没有给延迟),和 legQuotes 同一条规矩;实盘绝不拿延迟价盯盘。
    bool paper = true;
    for (const OJson& r : legs) {
        const contract::AccountConfig* a = settings.accountByAlias(js::str(prop(r, u"account"_s)));
        if (!(a && a->is_paper)) {
            paper = false;
            break;
        }
    }
    if (paper) session->reqMarketDataType(3);
    std::exception_ptr failure;
    try {
        static const OJson emptyObj = js::object();
        for (const OJson& row : legs) {
            // 被拒过、或者连着却太久没盘口的流不会自己活过来:摘掉重订(heldStreams.ts;认不出的合约照旧不重试)
            const OJson* specP = prop(row, u"contract"_s);
            const OJson& spec = js::nullish(specP) ? emptyObj : *specP;
            const QString symbol = js::str(prop(row, u"symbol"_s));
            const QString expiry = detail::strOr(prop(spec, u"lastTradeDateOrContractMonth"_s));
            const auto target = [&]() {
                IbContract c = optionContract(symbol, expiry, detail::numOr0(prop(spec, u"strike"_s)), detail::strOr(prop(spec, u"right"_s)),
                                              detail::strOrDefault(prop(spec, u"exchange"_s), u"SMART"_s), u"USD"_s,
                                              detail::strOrDefault(prop(spec, u"multiplier"_s), u"100"_s));
                const OJson* tc = prop(spec, u"tradingClass"_s);
                if (js::nullish(tc)) c.tradingClass = std::nullopt;  // `?? null`:没有就是 null,不是 ""
                else c.tradingClass = js::str(tc);
                return c;
            };
            const double limit = silenceLimitMs(streamStatus(symbol, expiry));
            const bool isFresh = co_await optionStreams_.ensure(
                session, u"opt:"_s + js::str(prop(row, u"key"_s)), target,
                [this, session](IbContract& c) { return qualifies(session, &c); }, limit);
            if (isFresh) fresh = true;
        }
        // 首次订阅要等第一笔 tick 落地;之后每轮只是从常驻订阅的缓存里读,泵一下事件循环就够。
        // 类型 3 要保持到这一步结束:连接刚建好时请求实际发出去会晚一拍,切早了就按实时类型发。
        co_await session->settle(fresh ? 1500 : 50);
    } catch (...) {
        failure = std::current_exception();
    }
    if (paper) session->reqMarketDataType(1);
    if (failure) std::rethrow_exception(failure);
}

/**
 * 持仓正股的现价兜底(账户推送里没有现价时):常驻订阅,第一次等首笔 tick,之后每轮读缓存。和期权腿价(fillOptionPrices)同一套写法。
 */
Task<> BrokerRouter::fillPositionPrices(QList<OJson>* rows) {
    QStringList need;
    for (const OJson& r : *rows) {
        if (priceIsNull(r) && isStock(r)) {
            const QString s = js::str(prop(r, u"symbol"_s));
            if (!need.contains(s)) need.append(s);
        }
    }
    std::sort(need.begin(), need.end());
    if (!need.isEmpty()) {
        const auto live = sessions();
        const SessionPtr session = live.empty() ? nullptr : live[0];
        if (session) {
            bool fresh = false;
            bool paper = true;
            for (const OJson& r : *rows) {
                if (!isStock(r)) continue;
                const contract::AccountConfig* a = settings.accountByAlias(js::str(prop(r, u"account"_s)));
                if (!(a && a->is_paper)) {
                    paper = false;
                    break;
                }
            }
            if (paper) session->reqMarketDataType(3);
            std::exception_ptr failure;
            try {
                // 被拒过、或者连着却太久没盘口的流:摘掉重订(只撤不带 generic 的这条,别误伤异动监控的量能流)
                const double limit = silenceLimitMs(settings.marketStatus(domain::nowEt()));
                for (const QString& symbol : need) {
                    const bool isFresh = co_await stockStreams_.ensure(
                        session, symbol, [symbol]() { return stockContract(symbol); },
                        [this, session](IbContract& c) { return qualifies(session, &c); }, limit);
                    if (isFresh) fresh = true;
                }
                co_await session->settle(fresh ? 1500 : 50);
            } catch (...) {
                failure = std::current_exception();
            }
            if (paper) session->reqMarketDataType(1);
            if (failure) std::rethrow_exception(failure);
            for (OJson& row : *rows) {
                if (!priceIsNull(row) || !isStock(row)) continue;
                const HeldStream* entry = stockStreams_.find(js::str(prop(row, u"symbol"_s)));
                if (!entry || !entry->handle) continue;
                const TickerData t = entry->handle->read();
                const std::optional<double> bid = cleanPrice(t.bid), ask = cleanPrice(t.ask), close = cleanPrice(t.close);
                std::optional<double> price = cleanPrice(t.last);
                if (!price && bid && ask && *ask >= *bid) price = util::pyRound((*bid + *ask) / 2.0, 4);
                row.set(u"market_price"_s, detail::numOrNull(price));
                // 昨收和期权腿同一条规矩:只给界面看,不进 market_price——追踪拿 market_price 判止损
                if (close) row.set(u"close_price"_s, js::N(*close));
                if (price) row.set(u"price_source"_s, js::S(u"quote"_s));
            }
        }
    }
    co_await fillOptionPrices(rows);
}

/**
 * 本次 TWS 会话(当天)的逐笔成交,归一成本系统的形状,按时间升序。IBKR 的 API 只回当天的;更早的靠 store.rememberFills 一天天累积。
 */
Task<QList<OJson>> BrokerRouter::executions() {
    contract::OrderedMap<OJson> out;
    for (const SessionPtr& session : sessions()) {
        if (!session->has(Cap::Executions)) continue;
        std::vector<ExecutionRow> details;
        std::exception_ptr failure;
        try {
            details = co_await session->executions();
        } catch (...) {
            failure = std::current_exception();
        }
        if (failure) throw BrokerError(u"读取成交明细失败:%1"_s.arg(messageOf(failure)));
        static const OJson emptyObj = js::object();
        for (const ExecutionRow& d : details) {
            const OJson& c = js::nullish(&d.contract) ? emptyObj : d.contract;
            const OJson& e = js::nullish(&d.execution) ? emptyObj : d.execution;
            const auto row = fillRow(c, e);
            if (row && !out.contains(js::str(prop(*row, u"exec_id"_s)))) out.insert(js::str(prop(*row, u"exec_id"_s)), *row);
        }
    }
    std::vector<OJson> rows;
    for (const QString& k : out.keys()) rows.push_back(*out.find(k));
    util::market::jsSort(rows, [](const OJson& a, const OJson& b) {
        const QString at = js::str(prop(a, u"time"_s)), bt = js::str(prop(b, u"time"_s));
        const double t = at < bt ? -1 : at > bt ? 1 : 0;
        if (t != 0) return t;
        const QString ai = js::str(prop(a, u"exec_id"_s)), bi = js::str(prop(b, u"exec_id"_s));
        return double(ai < bi ? -1 : ai > bi ? 1 : 0);
    });
    co_return QList<OJson>(rows.begin(), rows.end());
}

}  // namespace ibkr::execution
