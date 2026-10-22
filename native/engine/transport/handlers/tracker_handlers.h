// rpc/handlers/tracker.ts:positions.list 与 tracker.*(持仓、追踪目标的建 / 改 / 删、试算、立即平仓)。**钱路径**:tracker.add / update / close_now
// 在授权软件自动发单,入参 schema 全是 strict(contract/registry 里已登记)。逐句搬,不顺手改行为。
//
// 校验的先后次序就是行为(TS 里对象字面量从左到右求值,谁先抛谁说话):
//   · tracker.add:先 spot_target 的 optFloat,再 position,再 targets 字面量(take_profit → stop_loss → trail_pct → profit_drawdown_pct →
//     drawdownTiersOf → spot_stop_below → spot_stop_above → exitSettingsOf),再 auto_close 字面量(slippage → close_fraction → chase_max_pct → stopSettingsOf),
//     再「托管需先开自动平仓」→「富途不托管」→「平仓合约拼不出」→ checkTargets(方向 → 二选一 → BAG 托管 → validate → 出场细则 → 标的止损 → 标的目标价)。
//   · tracker.update:enabled → auto_close(合并)→ 目标(同 add 的字面量次序,spot_target 夹在 drawdownTiersOf 与 spot_stop_below 之间)→ checkTargets。
//
// 与 TS 不同、有意的几处(都在交付报告里):
//   · tracker.update 的「`k` in params」问原始入参(zod 对 `k: null` 解出来的是「键在、值 undefined」,OJson 里 undefined 的键不出现)。
//   · rows 是 Object.fromEntries 出来的普通对象,TS 里 rows["constructor"] 会取到 Object 的函数;C++ 里没有原型,取不到(界面递不出这样的 key)。
//   · syncHosted 的回包里没有 blocked 数组时 TS 抛 TypeError(`.find` of undefined),C++ 当空数组。
#pragma once

#include "transport/context.h"
#include "transport/handlers/handler_ports.h"

namespace ibkr::rpc {

class TrackerHandlers : public HandlerBase {
public:
    TrackerHandlers(RpcContext& ctx, Handlers1Ports& ports) : HandlerBase(ctx), ports_(ports) {}

    MethodTable methods() override;

    /// services/follow 的 attach({addTrack}) 直接调它(跟单建追踪走同一个 handler,不过 schema)
    util::Task<util::OJson> trackerAdd(util::OJson params);

private:
    using OJson = util::OJson;
    template <class T = void>
    using Task = util::Task<T>;
    using Position = orchestrate::tracker::Position;

    // ---- 方法
    Task<OJson> positionsList();
    OJson trackerList();
    Task<OJson> trackerTargetPreview(OJson params);
    Task<OJson> trackerAddLocked(OJson params);
    Task<OJson> trackerUpdate(OJson params, OJson raw);
    Task<OJson> trackerUpdateLocked(OJson params, OJson raw);
    Task<OJson> trackerDelete(OJson params);
    OJson trackerDeleteLocked(const OJson& params);
    Task<OJson> trackerPoll();
    Task<OJson> trackerReconcile();
    Task<OJson> trackerCloseNow(OJson params);
    Task<OJson> trackerCloseNowLocked(OJson params);

    // ---- 校验
    Task<> checkTargets(OJson raw, OJson rows, Position position, OJson targets, OJson autoClose);
    Task<> checkExits(OJson raw, OJson rows, Position position, OJson targets, OJson autoClose);
    void checkExitTime(const OJson& raw, const OJson& rows, const OJson& targets);
    void requireHostingSupported(const QString& alias);

    // ---- 取数
    struct SpotInputs {
        std::optional<double> spot, markPrice, em;
        double minute = 0, nowMs = 0;
        QString spotNote;
        OJson legInputs;  // {legPrices, legIvs, expiryMs}
        orchestrate::tracker::SpotTargetArgs args(double spotTarget) const;
    };
    Task<SpotInputs> spotInputs(OJson raw, OJson rows, orchestrate::tracker::TargetStructure structure);
    Task<OJson> peakSeed(OJson raw, OJson rows, Position position, OJson autoClose);
    Task<QList<OJson>> livePositions();

    OJson targetsInputOf(const OJson& params, const OJson& raw, const std::function<std::optional<double>()>& spotTarget);

    Handlers1Ports& ports_;
};

}  // namespace ibkr::rpc
