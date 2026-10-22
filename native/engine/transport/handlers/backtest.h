// engine-ts/src/rpc/handlers/backtest.ts 的 C++ 版(handlers2 簇):backtest.strategies / run / sweep / parse_rules。
//
// TS 原样照搬 / 与 TS 的差别:
//   · 检查次序:run = symbol → dateRange → strategy/rules → instrument → 没连券商 → historicalBars → cost_pct → runBacktest;
//     sweep = symbols → 上限 → 代码形状 → dateRange → grid → objective → instrument → cost_pct → split_pct → folds → 没连券商 → 逐只取日线。
//   · numberIn 只认 number / 字符串,布尔与数组 = NaN(不同于 js::num);不给 / null / "" = 默认值(sweep 的网格里默认是 NaN,不报错)。
//   · 券商给的日线(松的记录)按 date(String)/ open / high / low / close(Number)读成 backtest::Bar;真适配器给的就是数,不一样的话与 TS 的松读法会有出入。
//   · zod 的 message 只还原到 Issue 带的字段(见 handlers2_support.h),只在 custom rules / 品种配置不合法或模型回了不合 schema 的 JSON 时看得见。
#pragma once

#include "transport/context.h"
#include "transport/handlers/handlers2_ports.h"

#include <utility>

namespace ibkr::rpc {

class BacktestHandlers : public HandlerBase {
public:
    BacktestHandlers(RpcContext& ctx, Handlers2Ports& ports) : HandlerBase(ctx), ports_(ports) {}
    MethodTable methods() override;

    static const QString kRulesSystem;
    /// 数字或数字串;不给 / 空串 = 默认值;超出范围报人话
    static double numberIn(const util::OJson* raw, double dflt, double min, double max, const QString& label);

private:
    static std::pair<QString, QString> dateRange(const util::OJson& params);
    util::OJson backtestStrategies();
    util::Task<util::OJson> backtestRun(util::OJson params);
    util::Task<util::OJson> backtestSweep(util::OJson params);
    util::Task<util::OJson> backtestParseRules(util::OJson params);

    Handlers2Ports& ports_;
};

}  // namespace ibkr::rpc
