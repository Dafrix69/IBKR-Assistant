// ibTypes.ts 的 C++ 版:IB 会话适配层的接口。只有类型,没有实现——BrokerRouter 按这个接口调,
// ib_session 按它实现,测试替身也照它。头文件独立,两边都能引而不互相引。
//
// 与 TS 的对应:
//   · Promise<T> → util::Task<T>;ms 计时 → util::withDeadline / util::sleepMs。
//   · TS 里「可选方法」(`?`)调用方有两种写法:`typeof s.x !== "function"` 分支(contractHours、openTradesDetailed、
//     executions、executionHistory、onOrderStatus/onFill/onCommission/onError 的存在性判断)和 `s.x?.() ?? 兜底`
//     (setBaselineMarketDataType、quoteDelayed、accountPnl、netLiquidation、onLink、offError)。
//     前一种分支可观察(黄金里的替身会缺这些方法),所以用 Cap 显式表达「有没有」;后一种缺了等于兜底值,
//     基类的默认实现就返回那个兜底值。替身要「缺」某个方法就不报对应的 Cap。
//   · qualifyContracts 会把 conId / exchange / tradingClass 写回调用方手里的那几个对象,所以收指针不收拷贝。
//   · JS 真值:toIbContract 里 strike / conId 为 0 视为没有(省略),端口要按 truthiness 判,不是 has_value()。
//   · 位置合约、trade、fill、commission report 是 TS 的 any / Record<string, any>,这里用 OJson(保键序)。
#pragma once

#include "util/ordered_json.h"
#include "util/task.h"

#include <QString>
#include <QStringList>

#include <array>
#include <functional>
#include <limits>
#include <memory>
#include <optional>
#include <vector>

namespace ibkr::execution {

using util::OJson;
using util::Task;

/// 订单意图(与券商无关的纯数据)
struct OrderIntent {
    QString orderType, action;
    double totalQuantity = 0;
    std::optional<double> lmtPrice, auxPrice, trailingPercent;
    QString tif;
    bool outsideRth = false;
    QString account;
    bool transmit = true;
    std::optional<QString> orderRef;
    /// 价格条件(PriceCondition 的字段:price / conId / exchange / isMore)
    std::vector<OJson> conditions;
    std::optional<bool> conditionsCancelOrder;
    std::optional<bool> conditionsIgnoreRth;
    // 托管单用:OCA 组、TRAIL 初始停损、改单时的原 id
    QString ocaGroup;
    std::optional<int> ocaType;
    std::optional<double> trailStopPrice;
    std::optional<int> orderId;
};

struct ComboLeg {
    int conId = 0;
    double ratio = 0;
    QString action, exchange;
};

struct IbContract {
    QString secType, symbol, exchange, currency;
    std::optional<QString> lastTradeDateOrContractMonth;
    std::optional<double> strike;
    std::optional<QString> right;
    std::optional<QString> multiplier;  // 字符串;出门时 Number(),回来时 String()
    std::optional<QString> tradingClass;
    std::optional<int> conId;
    std::vector<ComboLeg> comboLegs;
    bool hasComboLegs = false;  // comboLegs 在 TS 里是 undefined 或数组;空数组与没有是两回事
    bool includeExpired = false;
};

/// 一条行情流此刻的读数。TS 里 emptyTicker() 把每个字段显式置 null,所以都是 optional;bid / ask 是 NaN 起步
struct ModelGreeks {
    std::optional<double> gamma, impliedVol, optPrice;
};
struct TickerData {
    double bid = std::numeric_limits<double>::quiet_NaN();
    double ask = std::numeric_limits<double>::quiet_NaN();
    std::optional<double> last, close, bidSize, askSize, marketPrice;
    std::optional<double> callOpenInterest, putOpenInterest, callVolume, putVolume;
    std::optional<ModelGreeks> modelGreeks;
    std::optional<QString> error;
    std::optional<double> open, high, low, volume, avgVolume, histVol, vol3m, vol5m, vol10m, lastTradeAt;
    bool delayed = false;
    std::optional<double> requestedAt, quotedAt;
    std::optional<double> marketDataType, bidAt, askAt, bidSizeAt, askSizeAt, ivAt;
};

class TickerHandle {
public:
    virtual ~TickerHandle() = default;
    virtual TickerData read() = 0;
};

/// 逐笔的一笔(tick-by-tick):kind 是 "last"(成交,AllLast)或 "bidask"(盘口);time 是 TWS 给的 Unix 秒
struct TickByTick {
    QString kind;
    double time = 0;
    std::optional<double> price, size;            // last
    std::optional<double> bid, ask, bidSize, askSize;  // bidask
    QString exchange, special;
    bool pastLimit = false, unreported = false;
};

struct RawBar {
    QString date;  // IBKR formatDate=1 文本
    double open = 0, high = 0, low = 0, close = 0;
    std::optional<double> volume;
};

struct OptChainParam {
    QString exchange, tradingClass;
    QStringList expirations;
    std::vector<double> strikes;
};

struct PortfolioItemLike {
    OJson contract;
    double position = 0, averageCost = 0, marketPrice = 0, marketValue = 0, unrealizedPnL = 0;
    std::optional<QString> account;
};

struct PositionItemLike {
    OJson contract;
    double position = 0, avgCost = 0;
    std::optional<QString> account;
};

struct TradeLike {
    std::optional<int> orderId, permId;
    QString status;
};

struct HistoricalRequest {
    QString endDateTime, durationStr, barSizeSetting, whatToShow;
    bool useRTH = false;
};

struct DepthRow {
    double price = 0, size = 0;
};
struct Depth {
    std::vector<DepthRow> bids, asks;
};

struct OpenTrade {
    std::optional<int> orderId;
    std::function<void()> cancel;
};

struct OpenTradeDetail {
    std::optional<int> orderId, permId;
    QString orderRef, account, action, orderType;
    double totalQuantity = 0;
    std::optional<double> lmtPrice, auxPrice, trailingPercent;
    QString status;
    IbContract contract;
    QString ocaGroup;
    std::optional<int> ocaType;
    QString tif = QStringLiteral("GTC");
    bool outsideRth = false;
    std::vector<OJson> conditions;
    std::optional<bool> conditionsCancelOrder, conditionsIgnoreRth;
};

struct ExecutionRow {
    OJson contract, execution;
};

struct AccountPnl {
    std::optional<double> daily, unrealized, realized;
    QString currency;
    double atMs = 0;
};

struct NetLiquidation {
    double amount = 0;
    QString currency;
};

/// 回调挂上去拿一个令牌;offError 凭令牌摘(TS 用函数身份 indexOf,std::function 没有 ==)
using ListenerToken = int;

/// 可选能力。调用方的「有没有」分支看这个,不看返回值
enum class Cap {
    ContractHours, SetBaselineMarketDataType, QuoteDelayed, OpenTradesDetailed, AccountPnl, NetLiquidation, Executions, ExecutionHistory,
    OnLink, OnOrderStatus, OnFill, OnCommission, OnError,
};

class IbSession {
public:
    virtual ~IbSession() = default;

    /// 这个会话带不带某个可选方法。默认全没有;真会话与替身各自报
    virtual bool has(Cap) const { return false; }

    virtual bool isConnected() = 0;
    virtual Task<> disconnect() = 0;
    virtual QStringList managedAccounts() = 0;
    /// 失败 resolve 时 conId 仍为 0;超时抛(消息 "timeout")
    virtual Task<> qualifyContracts(std::vector<IbContract*> contracts, int timeoutMs) = 0;
    /// Cap::ContractHours。tradingHours / liquidHours / timeZoneId;拿不到 nullopt
    virtual Task<std::optional<std::array<QString, 3>>> contractHours(IbContract, int) { co_return std::nullopt; }
    virtual void reqMarketDataType(int type) = 0;
    /// Cap::SetBaselineMarketDataType(缺了等于不做)
    virtual void setBaselineMarketDataType(int) {}
    /// 同一合约带不同 generic ticks 是不同的流
    virtual std::shared_ptr<TickerHandle> subscribeTicker(const IbContract& contract, const QString& genericTicks = {}) = 0;
    /// 这个会话此刻占着几条行情线路(订着的行情流条数);不知道给 -1
    virtual int activeTickers() const { return -1; }
    /// genericTicks 不传(nullopt)撤这个合约的所有变体
    virtual void cancelTicker(const IbContract& contract, const std::optional<QString>& genericTicks = std::nullopt) = 0;
    /// Cap::QuoteDelayed。没见过成交价 nullopt(缺了同)
    virtual std::optional<bool> quoteDelayed(const IbContract&) { return std::nullopt; }
    /// 期权 / 期货期权的行情流来了一笔推送就同步叫一下(不带内容,内容照旧从句柄读)。回撤掉这个回调的函数;不支持的会话回空函数。
    /// 盯盘拿它在两拍之间提前醒(orchestrate/fast_exit);没有它就只按节拍读缓存
    virtual std::function<void()> onOptionTick(std::function<void()> listener) {
        (void)listener;
        return {};
    }
    /// 逐笔订阅(type 同 reqTickByTickData:"AllLast" / "BidAsk"……)。回撤掉它的函数;不支持的会话回空函数、两个回调都不叫。
    /// onError 拿到的是 TWS 的报错(含错误码,例如逐笔并发数满了)
    virtual std::function<void()> tickByTick(const IbContract& contract, const QString& type, std::function<void(const TickByTick&)> onTick,
                                             std::function<void(const QString&)> onError) {
        (void)contract;
        (void)type;
        (void)onTick;
        (void)onError;
        return {};
    }
    /// 事件泵(ib.sleep):等行情落地
    virtual Task<> settle(int ms) = 0;
    virtual Task<std::vector<RawBar>> historicalData(IbContract contract, HistoricalRequest opts) = 0;
    virtual Task<std::vector<OptChainParam>> secDefOptParams(QString symbol, QString secType, int conId) = 0;
    virtual Task<QString> wshEvents(const QString&, const QString&, const QString&) { throw std::runtime_error("WSH unavailable on this session"); co_return QString(); }
    virtual Task<Depth> mktDepth(IbContract contract, int rows, int waitMs) = 0;
    virtual Task<TradeLike> placeOrder(IbContract contract, OrderIntent order) = 0;
    virtual Task<std::vector<OpenTrade>> openTrades() = 0;
    virtual Task<> cancelOrder(int orderId) = 0;
    /// Cap::OpenTradesDetailed
    virtual Task<std::vector<OpenTradeDetail>> openTradesDetailed() { co_return std::vector<OpenTradeDetail>{}; }
    virtual Task<std::vector<PortfolioItemLike>> portfolio() = 0;
    virtual Task<std::vector<PositionItemLike>> positions() = 0;
    /// Cap::AccountPnl / NetLiquidation(缺了等于 nullopt)
    virtual std::optional<AccountPnl> accountPnl(const QString&) { return std::nullopt; }
    virtual std::optional<NetLiquidation> netLiquidation(const QString&) { return std::nullopt; }
    /// Cap::Executions
    virtual Task<std::vector<ExecutionRow>> executions() { co_return std::vector<ExecutionRow>{}; }
    /// Cap::ExecutionHistory。版本太老给不了 nullopt;连不上 / 被拒 / 超时抛
    virtual Task<std::optional<std::vector<ExecutionRow>>> executionHistory(int) { co_return std::nullopt; }

    // ---- 事件。onConnectivity 是必须的;其余按 Cap
    virtual void onConnectivity(std::function<void(int)> cb) = 0;
    /// Cap::OnLink:socket 通断。首次连上不报,显式 disconnect 也不报
    virtual void onLink(std::function<void(bool)>) {}
    virtual void onOrderStatus(std::function<void(const OJson& trade)>) {}
    /// fill.live == false:reqExecutions 补回来的成交
    virtual void onFill(std::function<void(const OJson& trade, const OJson& fill)>) {}
    virtual void onCommission(std::function<void(const OJson& trade, const OJson& fill, const OJson& report)>) {}
    /// 订单级错误(reqId = orderId)
    virtual ListenerToken onError(std::function<void(int reqId, int code, const QString& message)>) { return 0; }
    virtual void offError(ListenerToken) {}
};

struct SessionConfig {
    QString host;
    int port = 0;
    int clientId = 0;
    bool readonly = false;
};
using IbSessionFactory = std::function<Task<std::shared_ptr<IbSession>>(SessionConfig)>;

}  // namespace ibkr::execution
