// IbSession 的默认实现:engine-ts/src/ibSession.ts 的 createIbApiNextSession 一行对一行搬过来,跑在 ib_api_next(@stoqey/ib 的
// IBApiNext 那一层的搬法)上。期望值:tests/fixtures/gen_ib_session.mjs(原模块跑在真的 @stoqey/ib 上、对着假 TWS),
// tests/tst_ib_session.cpp 把同样的脚本放给这里,逐步比 TWS 收到的每一条、回调、结果。
//
// 与 TS 的对应与不同(交付报告里有同样的一份):
//   · TS 的 setTimeout / Date.now 走 deps.runtime(缺省 QTimer + 墙钟);Promise 的回调走它的微任务队列(见 ib_api_next.h)。
//   · deps.fetchHistory 同 TS 的 deps.fetchHistory;deps.sockets 是 net.connect(测试换成假的);deps.log 是 logStderr。
//   · qualifyContracts 超时之后,TS 那条循环照样跑完并且**接着往调用方的合约对象里写** conId;这里循环照样跑(请求照发),
//     但不再写——调用方手里的是裸指针,超时之后它可能已经不在了。这是唯一一处有意的不同。
//   · openTradesDetailed 的 comboLegs:TS 原样交出库解出来的腿对象(带 openClose 等键);IbContract::ComboLeg 只有四个字段,
//     多出来的键丢掉(接口的限制)。
//   · 断线时下单 / 改单 / 撤单(2026-10-20 起的 TS):`placeOrder`(新单与改单)与 `cancelOrder` 第一句就查 connected,断着当场抛
//     LinkDownError(placeOrder 是失败的 Task,cancelOrder 同步抛,同 TS),不入队、不碰库;重连之后什么都不补发。其余命令
//     (行情类型、订阅……)断线期间照旧压在命令缓冲里、重连后才发。**例外照旧**:新单已经发出 REQ_IDS、在等 nextValidId 的时候链路断了,
//     不抛、不撤、没有回音;重连后库重发 REQ_IDS,等到了才发 PLACE_ORDER(TS 原样,见 scenarios place_pending_drop_*);
//     会话主动 disconnect() 之后这张单永远没有回音。
//   · 握手回来的版本不在 100..193:库断开并报 506,但同一块字节里后面的帧照样往下读、照样用那个版本编排队的命令(每条命令一个 503)。
//     这里同样(scenarios bad_version_chunk_*:194 / 200 / 99 / 60 / 55 与 TS 逐字节相同)。**已知缺口**:版本 ≤ 54 时 TS 的编码器在
//     下单等命令里先发 503「Server Version N: It does not support exemptCode parameter.」之类的低版本闸,tws/wire_out 只搬了 ≥ 100
//     的分支(它的头文件写明),所以这些 503 的回调这里没有——要补得由 wire_out 那一簇搬 < 100 的闸。
//   · 生命周期:订阅表(ApiNext::entries_)拥有订阅条目,条目拥有订阅,订阅的收尾回调、监听、协程里都只放弱引用,没有强引用的环;
//     等"订阅表里的结果"的协程(合约确认、K 线、下单等 nextValidId……)只拿会话的弱引用:结果永远不来时,协程帧留在原地(task.h 的规矩),
//     但不再把整个会话拖住。等"计时器兜底的结果"的(持仓 8 秒、确认超时、深度的等待)拿强引用,到点必放手。
//     tests/tst_ib_session.cpp 的 destroyedSessionLeavesNothing 每个脚本跑完放手会话,查没人拿着它、库里对象数回到原数、之后不再有回调。
//     **不要在会话自己的回调里销毁它**以外的情况都安全;在回调里销毁也安全(socket 与计时器回调钉住拥有者到它跑完)。
//   · TS 原样照搬的怪行为:disconnect() 不撤账户摘要与当日盈亏的订阅(TWS 收不到撤销);被拒的行情流撤两次(库的 error() 自己又撤一次);
//     重连的每一次尝试都会报 onConnectivity(504)(库在已断开的连接上先 disconnect 一次);连上之后 TWS 主动推的 managedAccounts
//     早于 nextValidId,库照样在 nextValidId 之后再发一次 REQ_MANAGED_ACCTS;持仓不信库里截过尾的 all(applyPositionUpdate)。
#pragma once

#include "execution/ib_api_next.h"
#include "execution/ib_exec_history.h"
#include "execution/ib_link_down.h"
#include "execution/ib_types.h"
#include "util/error.h"

#include <QSet>
#include <QString>

#include <functional>
#include <memory>
#include <optional>
#include <utility>

namespace ibkr::execution {

/// 断线后隔多久重连(IBApiNext 的 reconnectInterval)
inline constexpr double kIbReconnectMs = 5000;
/// 句柄对应的流已经不在缓存里时读到的 error
inline const QString kTickerDetached = QStringLiteral("订阅已被撤销");

// ---------------------------------------------------------------- 导出的纯函数(TS 的 export,各自对拍)

/// 常驻行情流的缓存键:合约 + generic ticks(期权写了交易类的带上交易类)
QString tickerKey(const IbContract& contract, const QString& genericTicks = {});

/// 持仓表的一行(账户 + 合约 + 数量 + 成本),按 `账户|conId` 索引。contract 可能是 undefined(空)
struct HeldPosition {
    QString account;
    std::optional<OJson> contract;
    double pos = 0, avgCost = 0;
};
using PositionTable = ibnext::OrderedMap<QString, HeldPosition>;
/// IBApiNext.getPositions() 的一次推送;空指针 = 没有这一项
struct PositionsUpdate {
    std::shared_ptr<const ibnext::AccountPositions> all, added, changed, removed;
};
/// 把一次推送并进持仓表:表还没有、或者这次不是增量,就用 all 重建;否则只按增量改(不信库里会被截尾的 all)
void applyPositionUpdate(std::optional<PositionTable>& table, const PositionsUpdate& update);

/// orderStatus 事件 → trade({order, orderStatus, contract})。参数是 JS 的松散值,空指针 = undefined
OJson tradeFromOrderStatus(const OJson* orderId, const OJson* status, const OJson* filled, const OJson* remaining, const OJson* avgFillPrice,
                           const OJson* permId, const OJson* contract);
/// execDetails 事件 → [trade, fill];reqId 是 undefined 时按 −1(TS 的缺省参数)
std::pair<OJson, OJson> fillFromExecDetails(const OJson* contract, const OJson* execution, const OJson* reqId = nullptr);

using FillCallback = std::function<void(const OJson& trade, const OJson& fill)>;
using CommissionCallback = std::function<void(const OJson& trade, const OJson& fill, const OJson& report)>;
/// execDetails / commissionReport → 引擎回调,同一个 execId 本会话只转一次。回调表按引用拿(TS 也是拿数组本身,后挂上的照样收到)
class ExecForwarder {
public:
    ExecForwarder(const std::vector<FillCallback>* fills, const std::vector<CommissionCallback>* commissions)
        : fills_(fills), commissions_(commissions) {}
    void onExecDetails(const OJson* reqId, const OJson* contract, const OJson* execution);
    void onCommissionReport(const OJson* report);

private:
    const std::vector<FillCallback>* fills_;
    const std::vector<CommissionCallback>* commissions_;
    ibnext::OrderedMap<QString, OJson> tradesByExec_;
    QSet<QString> commissioned_;
};

/// 券商报来的一个数:不是数、或者是"没有值"的哨兵大数时回空
std::optional<double> realNumber(const OJson* value);

/// 一次行情推送(库的 MarketData:tick 号 → 值)
struct MarketDataUpdate {
    std::shared_ptr<const ibnext::MarketData> all, added, changed;
};
/// 一次行情推送 → TickerData(原地改);nowMs 是 Date.now()
void applyTicks(TickerData& data, const MarketDataUpdate& update, double nowMs);
/// applyTicks 认的那几个 tick 名 → 号(IBApiTickType ?? IBApiNextTickType;没有的是空)
std::optional<double> tickTypeId(const QString& name);

/// getContractDetails 回的一条候选里,确认合约要用到的那几个字段
struct ResolvedContract {
    double conId = 0;
    QString exchange, tradingClass;
};
/// details 是数组就逐条看,不是就当一条;conId 不是正数的、重复的丢掉
std::vector<ResolvedContract> candidatesOf(const OJson* details);
/// 从合约详情里挑出唯一那一张;挑不出回空,并写一行日志(log)
std::optional<ResolvedContract> pickContractDetail(const IbContract& requested, const OJson* details, const std::function<void(const QString&)>& log);

/// OrderIntent → 库的 Order 对象(价格条件是 PriceCondition 的自有字段;它的 strValue 是原型上的 getter,不在这里)
OJson toIbOrder(const OrderIntent& order);
/// IbContract → 库的 Contract 对象
OJson toIbContract(const IbContract& c);

// ---------------------------------------------------------------- 会话

/// 测试用:等订阅表里的结果的那些协程,醒来时会话已经没了(弱引用是空的)走到的路。调用方调方法时会话一定还在
/// (方法就是它的成员),所以这些路只有会话销毁之后才走得到,只能直接叫。结果:失败的 Task(话是「会话已关闭」),
/// 或空结果(合约确认的循环直接结束、不碰调用方的合约;交易时段给空)
struct ClosedSessionProbe {
    static Task<TradeLike> placeOrder(IbContract contract, OrderIntent order);
    static Task<std::vector<RawBar>> historicalData(IbContract contract, HistoricalRequest opts);
    static Task<std::vector<OptChainParam>> secDefOptParams(QString symbol, QString secType, int conId);
    static Task<std::vector<OpenTrade>> openTrades();
    static Task<std::vector<OpenTradeDetail>> openTradesDetailed();
    static Task<std::vector<ExecutionRow>> executions();
    static Task<> qualifyLoop(std::vector<IbContract*> contracts);
    static Task<std::optional<std::array<QString, 3>>> hoursWork(IbContract contract);
};

struct IbSessionDeps {
    /// 缺省 ibnext::makeQtRuntime()
    std::shared_ptr<ibnext::Runtime> runtime;
    /// 缺省 ibnext::tcpSocketFactory()
    ibnext::SocketFactory sockets;
    /// 缺省 fetchExecutionHistory
    std::function<Task<HistoryResult>(HistoryRequest)> fetchHistory;
    /// 缺省写 stderr(logStderr)
    std::function<void(const QString&)> log;
};

/// 连上 TWS(10 秒内拿不到账户表就抛「连接超时」并把这个客户端关干净),交出会话
Task<std::shared_ptr<IbSession>> createIbApiNextSession(SessionConfig cfg, IbSessionDeps deps = {});

}  // namespace ibkr::execution
