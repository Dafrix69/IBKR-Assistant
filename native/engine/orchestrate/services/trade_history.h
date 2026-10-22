// services/tradeHistory.ts 逐句搬:历史交易的结局——知识总结(附带交易结果)与下单页「历史相似交易」共用。
// 库里累积的券商成交 → 每笔交易的结局;再加导入的期权(Flex 仓位优先,覆盖的 (账户, 日期) 上按结构整理的期权事件与券商成交合成的蝴蝶都不再用)。
// 只读本地库,不向券商同步新成交;没平仓的过期蝴蝶按到期日标的日线收盘结算(MarketDataService.dailyHistory,取不到就是「结果不明」)。
// 期望值:tests/fixtures/gen_svc_trades.mjs,tests/tst_svc_trades.cpp。
//
// 与 TS 的对应与不同:
//   · TradeHistory / Ledger 是 JS 对象:这里的 TradeHistory 用 OJson 列表,Ledger 用 analysis::performance::Ledger。
//   · `Date.now()` → util::dateNow()。
//   · TS 的 `await Promise.all([import(...)])` / 动态 import 不搬。
#pragma once

#include "analysis/performance.h"
#include "orchestrate/services/market_data.h"
#include "orchestrate/services/stock_trips.h"
#include "orchestrate/services/svc_host.h"

#include <QList>
#include <QStringList>

namespace ibkr::orchestrate {

struct TradeHistory {
    /// 每笔的结局,新的在前,按标的筛过、封顶 kMaxTradeFacts
    QList<util::OJson> facts;
    /// 券商成交合成的蝴蝶记录
    QList<util::OJson> butterflies;
    /// 导入的期权原行
    QList<util::OJson> options;
    /// Flex 期权仓位
    QList<util::OJson> positions;
};

class TradeHistoryService : public SvcBase {
public:
    TradeHistoryService(SvcHost& host, MarketDataService& market, StockTripsService& stockTrips) : SvcBase(host), market_(market), stockTrips_(stockTrips) {}

    /// symbols 空 = 全部标的
    util::Task<TradeHistory> load(QStringList symbols = {});
    /// 绩效体检的美元账本:同一批交易、同一套去重,只是出金额。只在本机算,不发给模型
    util::Task<analysis::performance::Ledger> ledger();

private:
    struct Gathered;
    util::Task<Gathered> gather(QStringList symbols);

    MarketDataService& market_;
    StockTripsService& stockTrips_;
};

}  // namespace ibkr::orchestrate
