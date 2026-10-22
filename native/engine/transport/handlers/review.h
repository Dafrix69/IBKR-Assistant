// engine-ts/src/rpc/handlers/review.ts 的 C++ 版(handlers2 簇):review.candidates / analyze / performance / signals。逐句搬。
//
// 照搬的 TS 行为(不是这里的选择):
//   · reviewCandidates 的 limit:`Math.trunc(Number(limit ?? 200)) || 200`;负数照 slice(0, 负数) 砍掉末尾几条;
//   · 蝴蝶与股票混排:`b.when - a.when || a.i - b.i`,认不出的时间当 -Infinity 沉底(-Infinity - -Infinity 是 NaN,取下标);
//   · reviewBars 里「未知周期」用的是 `timeframe in TIMEFRAMES`——Object.prototype 上的名字("toString" 等)也算认识;
//   · reviewSignals 取日线失败只让这只标的进 missing_symbols;askedAt 每只标的都问一次(哪怕日线是空的);
//   · attachExitPlan 里 router.comboBars 失败只记 notes,没有这个方法也只记 notes;1 分钟线只接 BrokerError / RpcError。
#pragma once

#include "domain/config.h"
#include "transport/context.h"
#include "transport/handlers/handlers2_ports.h"

namespace ibkr::rpc {

class ReviewHandlers : public HandlerBase {
public:
    ReviewHandlers(RpcContext& ctx, Handlers2Ports& ports) : HandlerBase(ctx), ports_(ports) {}
    MethodTable methods() override;

    static constexpr double kPerformanceMaxDays = 3650;
    static constexpr double kReviewScanLimit = 500;

private:
    struct TradesOut {
        QList<util::OJson> trades;
        std::optional<double> synced;
    };
    struct BarsOut {
        QString timeframe;
        QList<util::OJson> bars;
    };

    util::Task<util::OJson> reviewPerformance(util::OJson params);
    util::Task<util::OJson> reviewSignals(util::OJson params);
    util::Task<QList<util::OJson>> signalHistory(QString symbol, double spanDays);
    util::Task<TradesOut> reviewTrades();
    util::Task<util::OJson> reviewCandidates(util::OJson params);
    util::Task<util::OJson> reviewAnalyze(util::OJson params);
    util::Task<BarsOut> reviewBars(QString symbol, QString requested, double entryTime, domain::EtNow moment);
    util::Task<util::OJson> reviewAnalyzeStock(QString rid, util::OJson params);
    util::Task<util::OJson> attachExitPlan(util::OJson result, util::OJson record, util::OJson profile, QString symbol, QList<util::OJson> bars, QString timeframe,
                                           util::OJson params);

    Handlers2Ports& ports_;
};

}  // namespace ibkr::rpc
