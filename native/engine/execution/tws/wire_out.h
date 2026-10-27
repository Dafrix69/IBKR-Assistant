// 发给 TWS 的请求:逐条照 @stoqey/ib 1.6.10(MIT)的 Encoder 拼字段,版本分支照抄(接口版本 100..193)。
// 期望值由 tests/fixtures/gen_ib_wire.mjs 拿那个库现算,tests/tst_ib_wire.cpp 逐条对。**不照着 IB 的 GPL 源码写。**
//
// 入参是 JS 的松散值(OJson;std::nullopt = undefined),和 TS 引擎递给库的一样:合约、订单、过滤条件都是普通对象,
// 缺的键就是 undefined。库里读到 null / undefined 的属性会抛 TypeError,这里同样抛 WireError("TypeError", V8 原话)。
// 版本不够时库报的错(emitError)不抛,放进 Encoded::errors,同时不发这一条。
//
// 低于 100 的版本分支没有搬:V100 分帧的连接在握手时就拒掉 < 100 的 TWS(socket.js 的 onServerVersion),那些分支走不到。
//
// 交给下一层(IBApiNext 那一层)的用法:encode 出 tokens → bytesOf(tokens) 写进 socket。
#pragma once

#include "execution/tws/wire_common.h"

#include <QByteArray>
#include <QStringList>

#include <optional>

namespace ibkr::tws::wire {

/// 一个松散的 JS 参数;nullopt = undefined
using Arg = std::optional<OJson>;

/// 一次 encode 的结果:发了就有 tokens(库交给 sendMsg 的字段,已展平,布尔还是布尔,undefined 是 null);没发时 errors 里是库报的错
struct Encoded {
    std::optional<OJson> tokens;
    std::vector<Emit> errors;
};

/// 字段表 → 每格的串(同 socket.js 的 send:展平、布尔变 1/0、join 的规矩——null 与 undefined 是空串、数照 JS 的 String)
QStringList fieldsOf(const OJson& tokens);
/// 字段表 → 线上的字节(4 字节长度 + 每格后面一个 \0;首格是串时不加长度,同 socket.js)
QByteArray bytesOf(const OJson& tokens);

// ---- Encoder 的各个请求(参数次序同库) ----

/// REQ_CONTRACT_DATA
Encoded reqContractDetails(int serverVersion, const Arg& reqId, const Arg& contract);
/// REQ_MKT_DATA(genericTickList 在 IBApi 那一层是 ?? "",见 api::reqMktData)
Encoded reqMktData(int serverVersion, const Arg& reqId, const Arg& contract, const Arg& genericTickList, const Arg& snapshot,
                   const Arg& regulatorySnapshot);
/// CANCEL_MKT_DATA
Encoded cancelMktData(int serverVersion, const Arg& reqId);
/// REQ_TICK_BY_TICK_DATA(97):逐笔。tickType 是 "Last" / "AllLast" / "BidAsk" / "MidPoint";版本 ≥ 140 才带 numberOfTicks 与 ignoreSize。
/// 这一条库的 Decoder 对照(gen_ib_wire.mjs)里没有,字段次序照 IBKR 公开的 API 文档写,测试是手写的(tst_ib_wire.cpp 的 tickByTickProtocol)
Encoded reqTickByTickData(int serverVersion, const Arg& reqId, const Arg& contract, const Arg& tickType, const Arg& numberOfTicks, const Arg& ignoreSize);
/// CANCEL_TICK_BY_TICK_DATA(98)
Encoded cancelTickByTickData(int serverVersion, const Arg& reqId);
/// REQ_MARKET_DATA_TYPE(1 实时 / 2 冻结 / 3 延迟 / 4 延迟冻结)
Encoded reqMarketDataType(int serverVersion, const Arg& marketDataType);
/// REQ_HISTORICAL_DATA
Encoded reqHistoricalData(int serverVersion, const Arg& reqId, const Arg& contract, const Arg& endDateTime, const Arg& durationStr,
                          const Arg& barSizeSetting, const Arg& whatToShow, const Arg& useRTH, const Arg& formatDate, const Arg& keepUpToDate,
                          const Arg& chartOptions);
/// CANCEL_HISTORICAL_DATA
Encoded cancelHistoricalData(int serverVersion, const Arg& reqId);
/// REQ_POSITIONS
Encoded reqPositions(int serverVersion);
/// CANCEL_POSITIONS
Encoded cancelPositions(int serverVersion);
/// REQ_ACCOUNT_SUMMARY
Encoded reqAccountSummary(int serverVersion, const Arg& reqId, const Arg& group, const Arg& tags);
/// CANCEL_ACCOUNT_SUMMARY
Encoded cancelAccountSummary(int serverVersion, const Arg& reqId);
/// REQ_PNL(modelCode 在 IBApi 那一层是 ?? "")
Encoded reqPnL(int serverVersion, const Arg& reqId, const Arg& account, const Arg& modelCode);
/// CANCEL_PNL
Encoded cancelPnL(int serverVersion, const Arg& reqId);
/// REQ_MKT_DEPTH
Encoded reqMktDepth(int serverVersion, const Arg& reqId, const Arg& contract, const Arg& numRows, const Arg& isSmartDepth,
                    const Arg& mktDepthOptions);
/// CANCEL_MKT_DEPTH
Encoded cancelMktDepth(int serverVersion, const Arg& reqId, const Arg& isSmartDepth);
/// PLACE_ORDER:整张单(组合腿、单上的腿价、智能路由参数、条件、算法参数……)
Encoded placeOrder(int serverVersion, const Arg& id, const Arg& contract, const Arg& order);
/// CANCEL_ORDER(Encoder 要一个 orderCancel 对象;IBApi 那一层的缺省值见 api::cancelOrder)
Encoded cancelOrder(int serverVersion, const Arg& orderId, const Arg& orderCancel);
/// REQ_ALL_OPEN_ORDERS
Encoded reqAllOpenOrders(int serverVersion);
/// REQ_OPEN_ORDERS
Encoded reqOpenOrders(int serverVersion);
/// REQ_AUTO_OPEN_ORDERS
Encoded reqAutoOpenOrders(int serverVersion, const Arg& autoBind);
/// REQ_EXECUTIONS
Encoded reqExecutions(int serverVersion, const Arg& reqId, const Arg& filter);
/// REQ_SEC_DEF_OPT_PARAMS
Encoded reqSecDefOptParams(int serverVersion, const Arg& reqId, const Arg& underlyingSymbol, const Arg& futFopExchange,
                           const Arg& underlyingSecType, const Arg& underlyingConId);
/// REQ_MANAGED_ACCTS
Encoded reqManagedAccts(int serverVersion);
/// REQ_IDS
Encoded reqIds(int serverVersion, const Arg& numIds);
Encoded wsh(int serverVersion, int command, double reqId, const QString& filter = {}, const QString& start = {}, const QString& end = {});

/// REQ_CURRENT_TIME
Encoded reqCurrentTime(int serverVersion);
/// 握手之后的报到(socket.js 的 startAPI;版本 2、client id、可选能力空串)
Encoded startApi(int serverVersion, const Arg& clientId);

/// IBApi(api.js)那一层:引擎调的是它,它在交给 Encoder 之前补几个缺省值
namespace api {
/// orderCancelParam 是 null / undefined → {extOperator: ""};是串 → 当 manualOrderCancelTime;其余原样
Encoded cancelOrder(int serverVersion, const Arg& orderId, const Arg& orderCancelParam);
/// genericTickList ?? ""
Encoded reqMktData(int serverVersion, const Arg& reqId, const Arg& contract, const Arg& genericTickList, const Arg& snapshot,
                   const Arg& regulatorySnapshot);
/// modelCode ?? ""
Encoded reqPnL(int serverVersion, const Arg& reqId, const Arg& account, const Arg& modelCode);
/// numIds 缺省(undefined)是 0
Encoded reqIds(int serverVersion, const Arg& numIds);
/// 不传 chartOptions(库的 IBApi 不转这个参数)
Encoded reqHistoricalData(int serverVersion, const Arg& reqId, const Arg& contract, const Arg& endDateTime, const Arg& durationStr,
                          const Arg& barSizeSetting, const Arg& whatToShow, const Arg& useRTH, const Arg& formatDate, const Arg& keepUpToDate);
}  // namespace api

}  // namespace ibkr::tws::wire
