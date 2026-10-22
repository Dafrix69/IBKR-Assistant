// rpc/handlers/trading.ts:下单这条线——instruction.submit、交易记录、条件单队列、熔断。**钱路径**(instruction.submit 会真发单:
// 入参 schema 顶层 strict,契约里登记在敏感方法表)。逐句搬,不顺手改行为。
//
// 校验的先后次序就是行为:指令为空 → 自动执行没打开 → 没连券商 → accounts 不是字符串数组 → 账户别名不在表里;
// 引擎(handleInstruction)在这些都过了之后才碰,所以账户名不合规时不会把引擎建起来。
// breaker.halt:闸**先**合上,再去排追踪锁撤单;撤单等 15 秒就放手(闸已合上,锁不能被一个挂住的券商一直占着)。
#pragma once

#include "transport/context.h"
#include "transport/handlers/handler_ports.h"

namespace ibkr::rpc {

/// trading.ts 的 summarize(record):交易记录 → 列表里的一行(键序同 TS)
util::OJson summarizeRecord(const util::OJson& record);

class TradingHandlers : public HandlerBase {
public:
    TradingHandlers(RpcContext& ctx, Handlers1Ports& ports) : HandlerBase(ctx), ports_(ports) {}

    MethodTable methods() override;

private:
    using OJson = util::OJson;
    template <class T = void>
    using Task = util::Task<T>;

    Task<OJson> instructionSubmit(OJson params);
    OJson recordsList(const OJson& params);
    OJson recordsGet(const OJson& params);
    OJson pendingList();
    Task<OJson> pendingPoll();
    OJson breakerState();
    Task<OJson> breakerHalt(OJson params);
    Task<OJson> haltLocked(QString reason);
    OJson breakerResume();

    Handlers1Ports& ports_;
};

}  // namespace ibkr::rpc
