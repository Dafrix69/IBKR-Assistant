// 交易纪律守护(guard)的交易意图:开仓前写下的"买多少、止损在哪、为什么、什么情况下这个判断作废"。见 docs/features/guard.md。
// 与 TradeStore 共用一个连接(store.guard());表在第一次用到时才建。一行一份意图;只有两种状态:open(在用)与 closed(写了理由关掉,或持仓平掉了)。
// 关掉是唯一的出口:没有删除,意图与关掉的理由都留在库里给每日报告读。
#pragma once

#include "util/ordered_json.h"
#include "util/sqlite.h"

#include <QList>
#include <QString>

#include <optional>

namespace ibkr::domain {

class GuardStore {
public:
    explicit GuardStore(util::sqlite::Database& db);
    /// intent 至少有 account、symbol、kind(stock / option);股票还有 side、qty。回写进库的那一行(见 rowOf)
    util::OJson add(const util::OJson& intent);
    /// 全部在用的意图,先建的在前
    QList<util::OJson> listOpen();
    /// 这个账户这只股票在用的意图(最新的一份)
    std::optional<util::OJson> openStock(const QString& account, const QString& symbol);
    /// 关掉这个账户这个标的所有在用的意图,回关掉了几份。kind 空 = 不分股票期权
    double close(const QString& account, const QString& symbol, const QString& reason, const QString& kind = {});
    /// 这份意图对应的持仓已经出现过(之后持仓没了就自动关掉)
    void markSeen(double id);

private:
    void ensure();
    util::sqlite::Database& db_;
    bool ready_ = false;
};

}  // namespace ibkr::domain
