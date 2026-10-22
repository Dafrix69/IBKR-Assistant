// engine-ts/src/rpc/handlers/screener.ts 的 C++ 版(handlers2 簇):screener.rs / inflection / deviation / leaders——RS 强度、拐点筛选、极值偏离、强势股。
// 都是"拉 K 线 → 交给 analysis/screener、analysis/leaders 算 → 原样返回"。
//
// 与 TS 的差别 / TS 原样照搬的地方:
//   · 成员的 tag / company 取 `stock["tag"] || ""`:truthy 就原样带(库里是串),否则空串;leaders 那一支把它们当串(js::str)。
//   · 日内周期(1h / 30m / 15m)的 K 线 TS 里是 paBars 回的 Rec[];C++ 里是 SessionBar,按 {time, open, high, low, close, volume} 的键序还原成 OJson。
//   · 取日线失败时的 errText:RpcError 原话,其余截 200 个码元(util::errText)。
//   · leaders 的 logOnce 条件 `fresh.rows.length && /^\d{4}-\d{2}-\d{2}$/.test(fresh.day)`:day 不是串当作不匹配("undefined" 不匹配)。
#pragma once

#include "transport/context.h"
#include "transport/handlers/handlers2_ports.h"

namespace ibkr::rpc {

class ScreenerHandlers : public HandlerBase {
public:
    ScreenerHandlers(RpcContext& ctx, Handlers2Ports& ports) : HandlerBase(ctx), ports_(ports) {}
    MethodTable methods() override;

    static const QStringList kScreenTimeframes;
    static constexpr int kScreenIntradayCap = 40;  // 日内周期一次最多拉这么多个 (标的×周期)

private:
    struct Members {
        QString label;
        QList<util::OJson> members;
    };
    Members screenMembers(const util::OJson& params);
    util::Task<util::OJson> screenBars(QString symbol, QString timeframe);
    util::Task<util::OJson> screenerRs(util::OJson params);
    util::Task<util::OJson> screenerLeaders(util::OJson params);
    util::Task<util::OJson> screenerInflection(util::OJson params);
    util::Task<util::OJson> screenerDeviation(util::OJson params);

    Handlers2Ports& ports_;
};

}  // namespace ibkr::rpc
