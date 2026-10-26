// engine-ts/src/rpc/handlers/market.ts 逐句搬:book.snapshot / options.* / macro.board / pa.*(行情页读的那几样,全部只读)。
//
// TS 原样(照搬、没改):
//   · `String(params.x ?? "")` / `Number(params.width ?? 10)` / `Math.trunc(NaN)`(NaN 原样递给 wallFor)按 JS 取值语义(util::js)。
//   · pa.analyze 的 `timeframe in TIMEFRAMES` 在 JS 里连 Object.prototype 上的名字("constructor"、"toString"、"__proto__" …)也认;C++ 只认周期表里的键
//     (这几个名字在 TS 里会一路走到 paBars,没有实际用处)——没移植。
//   · 信号日志只在 signalFromPa 非空时记,since = entrySessionStart(…);高周期那一路任何失败都吞掉(catch {})。
//   · macro.board:streamQuotes 抛错吞成 {};没连券商时 macroBoard 自己走公开源(取数器由 MarketOps::macroFetcher() 给)。
//   · zod .parse() 失败的话见 handlers2_support.h 的 zodErrorMessage(只还原到 Issue 带的字段)。
#pragma once

#include "transport/context.h"
#include "transport/handlers/handlers2_ports.h"

namespace ibkr::rpc {

class MarketHandlers : public HandlerBase {
public:
    MarketHandlers(RpcContext& ctx, Handlers2Ports& ports) : HandlerBase(ctx), ports_(ports) {}
    MethodTable methods() override;

    static const QString kPaCommentSystem;

private:
    util::Task<util::OJson> bookSnapshot(util::OJson params);
    util::Task<util::OJson> optionsWall(util::OJson params);
    util::Task<util::OJson> entryContext();
    util::Task<util::OJson> optionsFlyPlan(util::OJson params);
    util::Task<util::OJson> optionsSpot(util::OJson params);
    util::OJson paTimeframes();
    util::Task<util::OJson> paResult(util::OJson params);
    util::Task<util::OJson> paComment(util::OJson params);
    util::Task<util::OJson> macroBoardMethod(util::OJson params);

    Handlers2Ports& ports_;
};

}  // namespace ibkr::rpc
