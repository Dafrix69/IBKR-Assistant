// services/stockTrips.ts 逐句搬:成交 → 股票持仓段(从空仓到空仓),交易分析页与想法总结共用。
// 期初仓位靠当前持仓反推;读不到持仓(没连、券商报错)就传空,stockreview 那头把每一笔标成 opening_assumed。持仓 15 秒缓存。
// 期望值:tests/fixtures/gen_svc_trades.mjs(原 StockTripsService 对着脚本驱动的假 router、真的交易库、虚拟钟现跑),tests/tst_svc_trades.cpp。
//
// 与 TS 的对应与不同:
//   · router 走 RouterPort;TS 的 `typeof router.positions === "function"`(富途也有)恒真。
//   · holdings 是 Record<string, number>(键 = 账户号|代码):OJson 对象,插键先后。
//   · performance.now() / 1000 → runtime().perfMs() / 1000(醒着的时间,见 svc_runtime.h)。
#pragma once

#include "orchestrate/services/svc_host.h"

#include <QList>

#include <limits>

namespace ibkr::orchestrate {

class StockTripsService : public SvcBase {
public:
    static constexpr double kHoldingsTtlS = 15.0;  // 当前持仓多久重新向券商要一次(只为反推期初仓位)

    explicit StockTripsService(SvcHost& host) : SvcBase(host) {}
    util::Task<QList<util::OJson>> trips();

private:
    double holdingsAt_ = -std::numeric_limits<double>::infinity();
    std::optional<util::OJson> holdings_;
};

}  // namespace ibkr::orchestrate
