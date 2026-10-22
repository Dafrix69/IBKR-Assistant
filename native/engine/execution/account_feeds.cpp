#include "execution/account_feeds.h"

namespace ibkr::execution {

namespace {

/// 第一条连着、并且管着这个账号的会话
IbSession* sessionOf(const SessionList& sessions, const QString& accountId) {
    for (const auto& s : sessions) {
        if (s->isConnected() && s->managedAccounts().contains(accountId)) return s.get();
    }
    return nullptr;
}

}  // namespace

std::optional<double> accountDailyPnl(const SessionList& sessions, const QString& accountId, double nowMs) {
    IbSession* session = sessionOf(sessions, accountId);
    if (!session || !session->has(Cap::AccountPnl)) return std::nullopt;
    const std::optional<AccountPnl> pnl = session->accountPnl(accountId);
    if (!pnl || !pnl->daily || pnl->currency != u"USD") return std::nullopt;
    return nowMs - pnl->atMs > kPnlStaleMs ? std::nullopt : pnl->daily;
}

std::optional<double> accountNetLiquidation(const SessionList& sessions, const QString& accountId) {
    IbSession* session = sessionOf(sessions, accountId);
    if (!session || !session->has(Cap::NetLiquidation)) return std::nullopt;
    const std::optional<NetLiquidation> value = session->netLiquidation(accountId);
    if (value && value->currency == u"USD" && value->amount > 0) return value->amount;
    return std::nullopt;
}

}  // namespace ibkr::execution
