// engine/spotStop.ts 逐句搬:标的止损价这一轮的标的现价从哪来。判定是纯函数(analysis/tracker_rules 的 spotStop),这里只管取价——
// 盯盘(engine.pollTrackers)与设置时的校验(rpc/handlers/tracker.ts)用同一个取法。
// 期望值:tests/fixtures/gen_engine_pure.mjs(原模块对着脚本驱动的假 router 现跑)。
#pragma once

#include "util/ordered_json.h"
#include "util/task.h"

#include <QString>
#include <QStringList>

#include <optional>

namespace ibkr::orchestrate {

/// 取标的现价要用到的 router 那一面(BrokerRouter 即符合)。TS 里 spotInfo / streamQuotes 是可选方法:has* 说有没有
class SpotRouter {
public:
    virtual ~SpotRouter() = default;
    virtual util::Task<std::optional<double>> indexPrice(const QString& symbol) = 0;
    /// 最近一次 indexPrice 的来源({source, note, price});没有就是空
    virtual bool hasSpotInfo() const { return false; }
    virtual std::optional<util::OJson> spotInfo(const QString&) { return std::nullopt; }
    /// 常驻报价流:{代码: {last, …}}。没有这一路的券商(测试里的假券商)退到 indexPrice
    virtual bool hasStreamQuotes() const { return false; }
    virtual util::Task<util::OJson> streamQuotes(const QStringList&) { co_return util::OJson::null(); }
};

/// 一只正股(或个股期权的标的)此刻的价:走常驻报价流;没有或失败 = 空。**不拿昨收冒充现价**
util::Task<std::optional<double>> stockSpot(SpotRouter& router, QString symbol);

struct UnderlyingSpot {
    std::optional<double> spot;
    QString note;
};
/// 标的现价与它的来历。夜盘推算失败退回的昨收(index_stale)当成拿不到;index = false(个股期权)走 stockSpot
util::Task<UnderlyingSpot> underlyingSpot(SpotRouter& router, QString symbol, bool index = true);

/// 这一轮的标的止损判定;没设回空。target 是这一轮算过的标的目标价(空指针 = null),沿用它取到的现价
util::Task<std::optional<util::OJson>> spotStopFor(SpotRouter& router, QString symbol, util::OJson targets, std::optional<util::OJson> target,
                                                   bool index = true);

}  // namespace ibkr::orchestrate
