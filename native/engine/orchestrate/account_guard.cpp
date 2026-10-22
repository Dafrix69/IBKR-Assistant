#include "orchestrate/account_guard.h"

#include "analysis/open_risk.h"
#include "orchestrate/closing.h"
#include "orchestrate/engine_time.h"
#include "util/jsobj.h"

#include <cmath>
#include <memory>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::orchestrate {

namespace {

OJson asOrder(const OJson& w) {
    OJson o = js::object();
    if (const OJson* c = js::prop(&w, u"contract"_s)) o.set(u"contract"_s, *c);
    if (const OJson* ord = js::prop(&w, u"order"_s)) o.set(u"order"_s, *ord);
    return o;
}

/// 这张在途单的到期日(单腿取合约的,组合取第一条腿的)
QString expiryOf(const OJson* contract) {
    const OJson* own = js::prop(contract, u"lastTradeDateOrContractMonth"_s);
    const OJson* first = js::path(contract, {u"legs"_s, u"0"_s, u"lastTradeDateOrContractMonth"_s});
    const OJson* pick = !js::nullish(own) ? own : first;
    return js::strOr(pick, QString()).left(8);
}

}  // namespace

OJson withWorkingOrders(const OJson& exposure, const QList<OJson>& working, const QList<OJson>& rows) {
    OJson out = js::object({{u"riskUsd"_s, *js::prop(&exposure, u"riskUsd"_s)}, {u"contracts"_s, *js::prop(&exposure, u"contracts"_s)},
                            {u"notes"_s, *js::prop(&exposure, u"notes"_s)}});
    OJson* riskUsd = js::propMut(&out, u"riskUsd"_s);
    OJson* contracts = js::propMut(&out, u"contracts"_s);
    for (const OJson& w : working) {
        const OJson* contract = js::prop(&w, u"contract"_s);
        const QString secType = js::strOr(js::prop(contract, u"secType"_s), QString());
        if (secType != u"OPT" && secType != u"BAG") continue;
        const QString alias = js::str(js::prop(&w, u"alias"_s));
        if (reducesPositions(asOrder(w), alias, rows)) continue;
        riskUsd->set(alias, js::N(jsx::numOr(js::prop(riskUsd, alias), 0) + js::num(js::prop(&w, u"notional"_s))));
        const QString key = analysis::open_risk::contractsKey(alias, js::strOr(js::prop(contract, u"symbol"_s), QString()), expiryOf(contract));
        const double qty = js::num(js::path(&w, {u"order"_s, u"totalQuantity"_s}));
        contracts->set(key, js::N(jsx::numOr(js::prop(contracts, key), 0) + (std::isnan(qty) || qty == 0 ? 0 : qty)));
    }
    return out;
}

execution::SessionList AccountGuard::sessions() {
    AccountGuardRouter* router = host_.router();
    // 只有 IBKR 的会话有这两路数据;富途的会话形状不同,不问
    return !router || router->broker() == u"futu" ? execution::SessionList{} : router->sessions();
}

std::vector<contract::AccountConfig> AccountGuard::ibkrAccounts() const {
    const domain::Settings& s = host_.settings();
    std::vector<contract::AccountConfig> out;
    for (const auto& a : s.accounts)
        if (s.accountBroker(a) == u"ibkr") out.push_back(a);
    return out;
}

util::Task<std::optional<QList<OJson>>> AccountGuard::readRows() {
    std::optional<QList<OJson>> rows;
    if (AccountGuardRouter* router = host_.router()) {
        try {
            rows = co_await router->positions();
        } catch (...) {
            rows = std::nullopt;
        }
    }
    if (rows) lastRows_ = rows;
    co_return rows;
}

util::Task<parsing::validator::ValidatorExtras> AccountGuard::validatorExtras(std::optional<double> nowMsArg) {
    const double nowMs = nowMsArg ? *nowMsArg : orchestrate::nowMs();
    const domain::Settings& s = host_.settings();
    parsing::validator::ValidatorExtras out;
    bool capped = s.limits.max_open_risk_usd > 0 || s.limits.max_underlying_contracts > 0;
    for (const auto& a : s.accounts) {
        if (capped) break;
        const contract::Limits l = s.limitsFor(a.alias);
        capped = l.max_open_risk_usd > 0 || l.max_underlying_contracts > 0;
    }
    AccountGuardRouter* router = host_.router();
    if (capped && router && router->broker() == u"futu") {
        // 富途的持仓行不分期权与正股、读失败也不报:敞口算不出来,平仓也认不出。不拿一张空表去放行或拒绝
        out.capNote = u"富途通道读不出期权持仓,这个账户的累计上限(在手风险 / 同标的张数)没有核对。"_s;
    } else if (capped) {
        const std::optional<QList<OJson>> rows = co_await readRows();
        // 平仓识别用一份自己的拷贝:同一批里认过的减仓逐张扣掉,后一张对着扣过的持仓判
        const std::optional<QList<OJson>>& pick = rows ? rows : lastRows_;
        if (pick) {
            auto basis = std::make_shared<QList<OJson>>(*pick);
            out.isReduction = [basis](const OJson& order, const QString& alias) { return reducesPositions(order, alias, *basis); };
            out.consumeReduction = [basis](const OJson& order, const QString& alias) { applyReduction(order, alias, *basis); };
        }
        if (!rows) out.exposure = js::Null();
        else
            out.exposure = withWorkingOrders(analysis::open_risk::openRisk(*rows), host_.store().workingOrders(util::etDayStart(nowMs), nowMs), *rows);
    }
    if (s.risk_budget.enabled) {
        const execution::SessionList list = sessions();
        contract::OrderedMap<double> equity;
        for (const auto& account : ibkrAccounts()) {
            const std::optional<double> value = execution::accountNetLiquidation(list, account.account_id);
            if (value) equity.insert(account.alias, *value);
        }
        if (!equity.isEmpty()) out.equity = equity;
    }
    co_return out;
}

util::Task<bool> AccountGuard::isReduceOnly(parsing::validator::ApprovedOrder approved) {
    const std::optional<QList<OJson>> rows = co_await readRows();
    co_return rows && reducesPositions(approved.order, approved.account.alias, *rows);
}

std::optional<contract::OrderedMap<double>> AccountGuard::dailyPnl(double nowMs) {
    const contract::DailyLossConfig& daily = host_.settings().protections.daily_loss;
    if (!daily.enabled || daily.basis != u"account") return std::nullopt;
    const execution::SessionList list = sessions();
    contract::OrderedMap<double> out;
    for (const auto& account : ibkrAccounts()) {
        const std::optional<double> value = execution::accountDailyPnl(list, account.account_id, nowMs);
        if (value) out.insert(account.alias, *value);
    }
    return out.isEmpty() ? std::nullopt : std::optional<contract::OrderedMap<double>>(out);
}

util::ProtectionState AccountGuard::protections(const contract::ProtectionsConfig& cfg, const std::vector<util::CloseEvent>& closes,
                                                const std::vector<util::PnlEvent>& pnl, double nowMs) {
    QStringList expected;
    for (const auto& a : host_.settings().accounts) expected << a.alias;
    return withLatch(util::evaluateProtections(cfg, closes, pnl, nowMs, dailyPnl(nowMs), expected), nowMs);
}

util::ProtectionState AccountGuard::withLatch(const util::ProtectionState& state, double nowMs) {
    const double today = util::etDayStart(nowMs);
    if (std::isnan(trippedLoaded_) || trippedLoaded_ != today) {
        // 换了一天、或这个引擎头一次问:从审计日志里把今天记过的读回来
        trippedLoaded_ = today;
        tripped_ = contract::OrderedMap<Tripped>();
        try {
            for (const OJson& trip : host_.store().dailyLossTrips(today, nowMs)) {
                tripped_.insert(js::str(js::prop(&trip, u"alias"_s)),
                                Tripped{today, util::ProtectionPause{u"daily_loss"_s, js::str(js::prop(&trip, u"reason"_s)), js::num(js::prop(&trip, u"untilMs"_s))}});
            }
        } catch (...) {
            /* 读不回来就只认这个引擎自己见过的 */
        }
    }
    for (const QString& alias : state.accountPauses.keys()) {
        const util::ProtectionPause& pause = *state.accountPauses.find(alias);
        if (!tripped_.contains(alias)) {
            const OJson detail = js::object({{u"alias"_s, js::S(alias)}, {u"reason"_s, js::S(pause.reason)}, {u"until_ms"_s, js::N(pause.untilMs)}});
            host_.store().audit(u"engine"_s, u"daily_loss_trip"_s, &detail);
        }
        tripped_.insert(alias, Tripped{today, pause});
    }
    contract::OrderedMap<util::ProtectionPause> accountPauses = state.accountPauses;
    for (const QString& alias : QStringList(tripped_.keys())) {
        if (!accountPauses.contains(alias)) accountPauses.insert(alias, tripped_.find(alias)->pause);
    }
    if (accountPauses.size() == state.accountPauses.size()) return state;
    util::ProtectionState next = state;
    next.accountPauses = accountPauses;
    return next;
}

}  // namespace ibkr::orchestrate
