#include "orchestrate/session_hours.h"

#include "parsing/validator.h"
#include "util/jsobj.h"

#include <QSet>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::orchestrate {

namespace {
bool derivative(const QString& secType) { return secType == u"OPT" || secType == u"FOP" || secType == u"BAG"; }
}  // namespace

QList<OJson> autoOutsideRth(HoursHost& host, const QList<OJson>& orders, const domain::EtNow& at) {
    if (!host.settings().policies.auto_outside_rth) return orders;
    QList<OJson> out;
    for (const OJson& order : orders) {
        const OJson* spec = js::prop(&order, u"order"_s);
        const std::optional<QString> own = orderMarketStatus(host, order, at);
        const QString status = own ? *own : host.settings().marketStatus(at);
        const OJson* mkt = js::prop(spec, u"orderType"_s);
        if (!parsing::validator::kExtendedStatuses.contains(status) || js::truthy(js::prop(spec, u"outsideRth"_s)) || (js::isStr(mkt) && mkt->s == u"MKT")) {
            out << order;
            continue;
        }
        OJson next = order;
        OJson newSpec = spec && spec->type == OJson::Object ? *spec : js::object();
        newSpec.set(u"outsideRth"_s, js::B(true));
        next.set(u"order"_s, newSpec);
        OJson warnings = js::array();
        if (const OJson* w = js::prop(&order, u"warnings"_s); !js::nullish(w)) warnings = *w;
        warnings.items.append(js::S(u"当前为"_s + status + u",已自动打上盘外标志(outsideRth=true):不打的话这张单会挂着,"
                                    "等常规时段才送交易所。不想在盘外成交就把 policies.auto_outside_rth 关掉。"_s));
        next.set(u"warnings"_s, warnings);
        out << next;
    }
    return out;
}

util::Task<> prewarmContractHours(HoursHost& host, QList<OJson> orders) {
    HoursRouter* router = host.router();
    if (!router || !router->hasContractHours()) co_return;
    QSet<QString> seen;
    for (const OJson& order : orders) {
        const OJson* contract = js::prop(&order, u"contract"_s);
        const QString secType = js::strOr(js::prop(contract, u"secType"_s), QString());
        if (secType != u"OPT" && secType != u"FOP" && secType != u"BAG") continue;
        const OJson* legs = js::prop(contract, u"legs"_s);
        const OJson* leg = secType == u"BAG" ? js::prop(legs, u"0"_s) : contract;
        const OJson* expiry = js::prop(leg, u"lastTradeDateOrContractMonth"_s);
        if (!js::truthy(expiry)) continue;
        const QString key = js::str(js::prop(contract, u"symbol"_s)) + u"|"_s + js::str(expiry);
        if (seen.contains(key)) continue;
        seen.insert(key);
        const contract::AccountConfig* account = host.settings().accountByAlias(js::strOr(js::prop(&order, u"account"_s), QString()));
        if (!account) account = host.settings().defaultAccount();
        if (!account) continue;
        const contract::AccountConfig acct = *account;
        OJson inner = js::object();
        const auto copy = [&](OJson& to, const OJson* from, const QString& k) {
            if (const OJson* v = js::prop(from, k)) to.set(k, *v);
        };
        if (secType == u"BAG") {
            inner.set(u"secType"_s, js::S(u"BAG"_s));
            if (const OJson* v = js::prop(contract, u"symbol"_s)) inner.set(u"symbol"_s, *v);
            OJson l = js::object();
            copy(l, leg, u"lastTradeDateOrContractMonth"_s);
            copy(l, leg, u"strike"_s);
            copy(l, leg, u"right"_s);
            l.set(u"ratio"_s, js::N(1));
            inner.set(u"legs"_s, js::array({l}));
        } else {
            inner.set(u"secType"_s, js::S(secType));
            copy(inner, contract, u"symbol"_s);
            copy(inner, contract, u"lastTradeDateOrContractMonth"_s);
            copy(inner, contract, u"strike"_s);
            copy(inner, contract, u"right"_s);
        }
        OJson row = js::object({{u"account"_s, js::S(acct.alias)}});
        copy(row, contract, u"symbol"_s);
        row.set(u"sec_type"_s, js::S(secType));
        row.set(u"contract"_s, inner);
        try {
            (void)co_await router->contractHours(row, acct);
        } catch (...) {
            /* 查不到就退回正股表 */
        }
    }
}

std::optional<QString> orderMarketStatus(HoursHost& host, const OJson& order, const domain::EtNow& at) {
    const OJson* contract = js::prop(&order, u"contract"_s);
    const QString secType = js::strOr(js::prop(contract, u"secType"_s), QString());
    if (!derivative(secType)) return std::nullopt;
    HoursRouter* router = host.router();
    if (!router || !router->hasCachedContractHours()) return std::nullopt;
    const OJson* expiry = nullptr;
    if (secType == u"BAG") {
        const OJson* legs = js::prop(contract, u"legs"_s);
        // `legs = contract?.legs ?? []; if (!legs.length) return null; expiry = legs[0]?.lastTradeDate…`
        if (js::nullish(legs) || !js::isArr(legs) || legs->items.isEmpty()) return std::nullopt;
        expiry = js::prop(js::prop(legs, u"0"_s), u"lastTradeDateOrContractMonth"_s);
    } else {
        expiry = js::prop(contract, u"lastTradeDateOrContractMonth"_s);
    }
    std::optional<ContractHours> hours;
    try {
        hours = router->cachedContractHours(js::str(js::prop(contract, u"symbol"_s)), js::str(expiry));
    } catch (...) {
        return std::nullopt;
    }
    if (!hours) return std::nullopt;
    const QString status = domain::hoursStatus((*hours)[0], (*hours)[2], at.epochMs, (*hours)[1]);
    return status.isEmpty() || status == host.settings().marketStatus(at) ? std::nullopt : std::optional<QString>(status);
}

util::Task<QString> marketStatusFor(HoursHost& host, OJson raw, domain::EtNow at) {
    const QString secType = js::strOr(js::prop(&raw, u"sec_type"_s), QString());
    if (!derivative(secType)) co_return host.settings().marketStatus(at);
    HoursRouter* router = host.router();
    if (!router || !router->hasContractHours()) co_return host.settings().marketStatus(at);
    const contract::AccountConfig* account = host.settings().accountByAlias(js::strOr(js::prop(&raw, u"account"_s), QString()));
    if (!account) co_return host.settings().marketStatus(at);
    const contract::AccountConfig acct = *account;
    std::optional<ContractHours> hours;
    try {
        hours = co_await router->contractHours(raw, acct);
    } catch (...) {
        hours = std::nullopt;  // 查时段失败不该炸掉轮询
    }
    if (!hours) co_return host.settings().marketStatus(at);
    const QString status = domain::hoursStatus((*hours)[0], (*hours)[2], at.epochMs, (*hours)[1]);
    co_return status.isEmpty() ? host.settings().marketStatus(at) : status;
}

}  // namespace ibkr::orchestrate
