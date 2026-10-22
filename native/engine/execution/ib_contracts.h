// 怎么拼一张 IB 合约(engine-ts/src/ibContracts.ts 逐句搬):正股 / 指数 / 加密 / 期权,以及跟它们绑在一起的到期日与交易类选择。
// 这一层只认「合约长什么样」:不连券商、不读行情、不碰订单。期望值:tests/fixtures/gen_ib_contracts.mjs
#pragma once

#include "contract/config_types.h"
#include "execution/ib_types.h"

#include <QString>

#include <optional>
#include <vector>

namespace ibkr::execution {

IbContract stockContract(const QString& symbol, const QString& exchange = QStringLiteral("SMART"), const QString& currency = QStringLiteral("USD"));
/// 某年某月的第三个星期五('YYYY-MM-DD')
QString thirdFriday(double year, double month);
/// 到期日(第三个星期五)严格晚于 dateStr 的最近季月('YYYYMM');八个月里找不到抛 JsError
QString frontQuarterly(const QString& dateStr);
IbContract indexContract(const QString& symbol, const QString& exchange);
/// 指数配置里那张期货(SPX → ES):只用 cfg 的 futures / futures_exchange
IbContract indexFuturesContract(const contract::IndexConfig& cfg, const QString& date);
IbContract cryptoContract(const QString& symbol);
/// `CRYPTO:BTC` → `BTC`;不是这个形状回空
std::optional<QString> cryptoSymbol(const QString& symbol);
/// 流式报价的标的记号 → 合约(裸代码、CRYPTO:、CONTFUT: / FUT: / IND: …@交易所)
IbContract streamContract(const QString& symbol);
/// 从多条链里挑该到期日真正所在的那条。byClass 是 TS 的 Record<string, {expiries?, strikes?}>(OJson,键序同 JS);
/// cfg 为空 = TS 的 null(只读它的 daily_trading_class / monthly_trading_class)
QString pickTradingClass(const QString& symbol, const contract::IndexConfig* cfg, const OJson& byClass, const QString& expiry, const QString& prefer = {});
/// 一个行权价有多"整"(6725 → 25,6750 → 250)
double strikeRoundness(double strike);
/// 一条期权链订哪些行权价(span 为空 = TS 的 null)
std::vector<double> chainStrikes(const std::vector<double>& grid, double spot, double width, std::optional<double> span = std::nullopt);
IbContract optionContract(const QString& symbol, const QString& expiry, double strike, const QString& right, const QString& exchange,
                          const QString& currency = QStringLiteral("USD"), const QString& multiplier = QStringLiteral("100"),
                          const QString& tradingClass = {});
QString describeContract(const IbContract& contract);

}  // namespace ibkr::execution
