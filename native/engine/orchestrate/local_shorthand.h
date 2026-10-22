// engine/localShorthand.ts 逐句搬:「这条指令能不能不经大模型就出 payload」。
// 抓现价(券商 → 公开源)、按固定行话解析、没接住就留一条观测。它会往调用方传进来的 snap 里补现价(按指针改,不是拷贝),
// 之后的大模型提示词与校验用的是同一份快照。期望值:tests/fixtures/gen_engine_pure.mjs(原模块对着脚本驱动的假 router 现跑)。
//
// 与 TS 的对应:host.publicPriceFn ?? macro.publicIndexPrice 收成宿主的一个方法 publicPrice(symbol)——publicIndexPrice 的默认取数器是网络 I/O,
// 不在 analysis 层;engine.ts 的搬运者实现它:有注入的替身就调替身,否则调 analysis::macro::publicIndexPrice(symbol, 默认超时, 默认取数器)。
#pragma once

#include "domain/config.h"
#include "orchestrate/engine_ports.h"
#include "parsing/shorthand.h"
#include "util/ordered_json.h"
#include "util/task.h"

#include <QString>

#include <optional>

namespace ibkr::orchestrate {

/// 这一步要用到的 router 那一面
class ShorthandRouter {
public:
    virtual ~ShorthandRouter() = default;
    virtual util::Task<std::optional<double>> indexPrice(const QString& symbol) = 0;
    virtual bool hasSpotInfo() const { return false; }
    virtual std::optional<util::OJson> spotInfo(const QString&) { return std::nullopt; }
};

/// 这一步要用到的引擎那一面(TradingEngine 即符合)
class ShorthandHost {
public:
    virtual ~ShorthandHost() = default;
    virtual ShorthandRouter* router() = 0;  // 空 = 没连券商
    /// 速记解析的公开源现价(publicPriceFn ?? publicIndexPrice)
    virtual util::Task<std::optional<double>> publicPrice(const QString& symbol) = 0;
    virtual EngineStore& store() = 0;
};

/// 回空 = 交给大模型。snap 指向调用方的局部变量({代码: 现价}),调用方在 co_await 它;本地解析抛任何异常都静默回落到大模型
util::Task<std::optional<util::OJson>> tryLocalShorthand(ShorthandHost& host, QString instruction, util::OJson* snap, domain::EtNow at,
                                                         parsing::shorthand::ShorthandMeta* meta = nullptr);

}  // namespace ibkr::orchestrate
