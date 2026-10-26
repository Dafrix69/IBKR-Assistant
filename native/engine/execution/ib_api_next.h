// @stoqey/ib 1.6.10(MIT)的 IBApiNext 里 ibSession.ts 用到的那一部分,照它从外面看得见的样子搬过来(ib_session.cpp 的下一层)。
// **不照着 IB 的 GPL 源码写**;线上的字段交给 tws/wire_out(编码)与 tws/wire_in(解码),它们各自和库对拍过。
//
// 搬了什么(每一样都照库的先后次序,因为次序就是 TWS 看到的字节次序、引擎收到回调的次序):
//   · Socket(V100 分帧):握手、报到、按 4 字节长度切消息、消息里不以 \0 结尾的尾巴留给下一条(dataFragment)、
//     版本不在 100..193 时断开并报 506;对端关了 / 出错时的状态与事件(socket.js)。
//   · Controller:命令缓冲(连上之后、nextValidId 之前的请求先压着,来了按先后放出去;断开时再压住)、
//     限速(每 100 毫秒最多 4 条,多出来的排队;function-rate-limit 的样子)、各种 emitError / emitInfo(controller.js)。
//   · IBApiAutoConnection:连接状态(BehaviorSubject)、断线后按 reconnectInterval 重连、重连时先 disconnect 一次
//     (已经断着时就是那句 504「Cannot disconnect if already disconnected.」)(auto-connection.js)。看门狗没搬(TS 没开)。
//   · 订阅表与订阅(subscription-registry.js / subscription.js):第一个订阅者到了才发请求、最后一个走了才撤、
//     同一个 instanceId 共用一份、ReplaySubject(1) 的回放、每个订阅者收到的第一笔改写成 {all, added: all}、
//     出过错之后再订换一个新的请求号;出错时撤两次(订阅者的收尾撤一次、error() 自己又撤一次——库原样)。
//   · IBApiNext 里那些事件处理(onPosition 的 splice 截尾、onOpenOrder / onOrderStatus 按 permId 对、onNextValidId 只完成
//     第一个、onTickOptionComputation 拆成 IBApiNextTickType……)与 ibSession 调的那些 getXxx(api-next.js)。
//
// 时间、计时器、"微任务"都走 Runtime:真跑时是 QTimer 与墙钟,测试换成假钟(tests/tst_ib_session.cpp,同生成器的假钟)。
// JS 的 Promise 回调是微任务:一整块字节(一个 socket 事件)读完、或一个计时器回调跑完之后才轮到。这里同样——库这一层
// 交给上层的结果(lastValueFrom 那一类)一律排进 Runtime 的微任务队列,在最外层的那一拍宏任务结束时放出来。
//
// 没搬的、与库不同的(都写进了交付报告):
//   · 库的日志(ConsoleLogger)不搬。bondContractDetails(18 号消息)wire_in 没搬,收到时整条跳过(库会当合约详情收下)。
//   · 解码抛出来的 SyntaxError / RangeError(坏的拒单原因 JSON、条件数大到 JS 建不了数组)在库里是未捕获的异常(进程挂掉);
//     这里接住、记一行日志、丢掉那一条。命令执行时编码器抛的 TypeError 同样接住(库里会让命令缓冲从此卡死)。
//   · 握手回来的版本读不出数(NaN)在库里照样连上、不报到;这里按 0 处理(同样不报到)。
#pragma once

#include "execution/tws/wire_out.h"
#include "util/ordered_json.h"
#include "util/task.h"

#include <QByteArray>
#include <QHash>
#include <QString>
#include <QStringList>

#include <any>
#include <atomic>
#include <cmath>
#include <deque>
#include <functional>
#include <memory>
#include <optional>
#include <utility>
#include <vector>

namespace ibkr::execution::ibnext {

using util::OJson;
using util::Task;

// ================================================================ 测试用:活着的对象个数
/// 会话放手之后这三样都该回到原数(订阅表里没有强引用的环);tests/tst_ib_session.cpp 比这个
struct LiveCounts {
    static inline std::atomic<int> apiNext{0}, subscriptions{0}, entries{0};
};
template <std::atomic<int>& C>
struct Live {
    Live() { ++C; }
    Live(const Live&) { ++C; }
    Live& operator=(const Live&) = default;
    ~Live() { --C; }
};

// ================================================================ 运行时:钟、计时器、微任务

/// setTimeout 的时长:不在 [1, 2^31 − 1] 里的(含 NaN)按 1 毫秒,小数截掉(同 ib_exec_history 的 nodeTimerDelay)
double nodeDelay(double ms);

class Runtime {
public:
    virtual ~Runtime() = default;
    /// Date.now()
    virtual double now() = 0;
    /// setTimeout:到点时回调包在一拍宏任务里跑(跑完放微任务)
    virtual quint64 setTimeout(double ms, std::function<void()> fn) = 0;
    virtual void clearTimeout(quint64 id) = 0;

    void queueMicrotask(std::function<void()> fn);
    /// 一拍宏任务:最外层的那个结束时把微任务放完(放的途中新排进来的也放)
    class Scope {
    public:
        explicit Scope(Runtime& rt);
        ~Scope();
        Scope(const Scope&) = delete;
        Scope& operator=(const Scope&) = delete;

    private:
        Runtime& rt_;
    };

protected:
    void runMacrotask(const std::function<void()>& fn);

private:
    void drain();
    std::deque<std::function<void()>> micro_;
    int depth_ = 0;
    bool draining_ = false;
};

/// 真跑用:QTimer + 墙钟(util::dateNow)
std::shared_ptr<Runtime> makeQtRuntime();

/// Promise 的 resolve / reject 排成微任务
template <class T>
void resolveLater(Runtime& rt, util::Deferred<T> d, T v) {
    rt.queueMicrotask([d, v = std::move(v)]() mutable { d.resolve(std::move(v)); });
}
inline void resolveLater(Runtime& rt, util::Deferred<> d) {
    rt.queueMicrotask([d]() mutable { d.resolve(); });
}
template <class T>
void rejectLater(Runtime& rt, util::Deferred<T> d, std::exception_ptr e) {
    rt.queueMicrotask([d, e]() mutable { d.reject(e); });
}

// ================================================================ socket(Node 的 net.Socket 那几样事件)

class NodeSocket {
public:
    struct Handlers {
        std::function<void()> connect;
        std::function<void(const QByteArray&)> data;
        /// 对端关了写的那一半(FIN)
        std::function<void()> end;
        /// 出错(连不上、被重置……);之后还会来一次 close
        std::function<void(const QString& message)> error;
        /// 彻底关了(只来一次)
        std::function<void()> close;
    };
    virtual ~NodeSocket() = default;
    virtual void write(const QByteArray& bytes) = 0;
    virtual void end() = 0;
    /// 之后 close 在下一拍来(同 Node:handle 关完才发)
    virtual void destroy() = 0;
};
/// net.connect({host, port}):事件处理在建的时候就给(库也是 connect(...).on(...) 一气接上)
using SocketFactory = std::function<std::shared_ptr<NodeSocket>(const QString& host, double port, NodeSocket::Handlers handlers)>;
/// 默认:QTcpSocket
SocketFactory tcpSocketFactory();

// ================================================================ 小工具

/// JS 的 Map:按插入先后,键用 SameValueZero 比(NaN 等于 NaN,±0 相等)
template <class K, class V>
class OrderedMap {
public:
    std::vector<std::pair<K, V>> items;

    static bool same(const K& a, const K& b) {
        if constexpr (std::is_floating_point_v<K>) return a == b || (std::isnan(a) && std::isnan(b));
        else return a == b;
    }
    V* get(const K& k) {
        for (auto& [kk, v] : items)
            if (same(kk, k)) return &v;
        return nullptr;
    }
    const V* get(const K& k) const { return const_cast<OrderedMap*>(this)->get(k); }
    bool has(const K& k) const { return get(k) != nullptr; }
    void set(const K& k, V v) {
        if (V* p = get(k)) *p = std::move(v);
        else items.emplace_back(k, std::move(v));
    }
    bool erase(const K& k) {
        for (auto it = items.begin(); it != items.end(); ++it)
            if (same(it->first, k)) {
                items.erase(it);
                return true;
            }
        return false;
    }
    void clear() { items.clear(); }
    std::size_t size() const { return items.size(); }
    bool empty() const { return items.empty(); }
};

/// a == b(宽松相等),只管原始值:null 与 undefined 相等;数对数;串对数按 Number(串);对象一律不等
bool looseEq(const OJson* a, const OJson* b);

// ================================================================ 事件(eventemitter3)

class Emitter {
public:
    using Fn = std::function<void(const OJson& args)>;
    int on(const QString& name, Fn fn);
    void off(const QString& name, int id);
    /// 发的那一刻的监听表(途中摘掉的照样调、途中加的不调,同 eventemitter3)
    void fire(const QString& name, const OJson& args);

private:
    struct L {
        int id;
        std::shared_ptr<Fn> fn;
    };
    QHash<QString, std::vector<L>> map_;
    int next_ = 1;
};

/// BehaviorSubject<number>:订上就先收到当前值
class StateSubject {
public:
    explicit StateSubject(int initial) : value_(initial) {}
    int value() const { return value_; }
    int subscribe(std::function<void(int)> fn);
    void unsubscribe(int id);
    void next(int v);

private:
    struct O {
        int id;
        std::shared_ptr<std::function<void(int)>> fn;
        std::shared_ptr<bool> closed;
    };
    int value_;
    std::vector<O> observers_;
    int next_ = 1;
};

enum ConnectionState { Disconnected = 0, Connecting = 1, Connected = 2 };

// ================================================================ 订阅

/// IBApiNextError:话、code、请求号(没有时 -1)
struct ApiError {
    QString message;
    double code = 0;
    double reqId = -1;
};

/// 推给订阅者的一笔:{all, added?, changed?, removed?}。空的 any = undefined;容器一律是 shared_ptr(库里推的是同一个可变对象)
struct Upd {
    std::any all, added, changed, removed;
};

struct Observer {
    std::function<void(const Upd&)> next;
    std::function<void(const ApiError&)> error;
    std::function<void()> complete;
};

class ApiNext;

/// 订阅者手里的那个(rxjs 的 Subscription)
class SubHandle {
public:
    virtual ~SubHandle() = default;
    virtual void unsubscribe() = 0;
};

/// IBApiNextSubscription + 它的 ReplaySubject(1)
class Subscription : public std::enable_shared_from_this<Subscription> {
public:
    Subscription(std::weak_ptr<ApiNext> api, std::function<void()> request, std::function<void()> cancel, std::function<void()> cleanup, QString instanceId);

    double reqId = 0;
    QString instanceId;
    bool endEventReceived = false;
    std::any lastAllValue;

    void next(const Upd& v);
    void complete();
    void error(const ApiError& e);
    /// createObservable().subscribe(observer)
    std::shared_ptr<SubHandle> subscribe(Observer observer);

private:
    struct Sub;
    class Handle;
    void deliverNext(const std::shared_ptr<Sub>& s, const Upd& v);
    void deliverError(const std::shared_ptr<Sub>& s, const ApiError& e);
    void deliverComplete(const std::shared_ptr<Sub>& s);
    void teardown(const std::shared_ptr<Sub>& s);
    void requestTws();
    void cancelTws();

    /// 弱引用:订阅表归 ApiNext,订阅反过来不拥有它(会话销毁之后手里还有订阅时,不指向已经没了的对象)
    std::weak_ptr<ApiNext> api_;
    Live<LiveCounts::subscriptions> live_;
    std::function<void()> request_, cancel_, cleanup_;
    // 主题(ReplaySubject)
    std::optional<Upd> buffer_;
    bool stopped_ = false;
    std::optional<ApiError> thrown_;
    std::vector<std::shared_ptr<Sub>> observers_;
    // 订阅本身
    int observersCount_ = 0;
    bool hasError_ = false;
    std::optional<int> connSub_;
};

// ================================================================ 库的值

struct TickVal {
    /// undefined = 空
    std::optional<double> value;
};
using MarketData = OrderedMap<double, TickVal>;
/// 账户 → [{account, contract, pos, avgCost}]
using AccountPositions = OrderedMap<QString, QList<OJson>>;
/// 账户 → 标签 → 币种 → {value, ingressTm}
using AccountSummaries = OrderedMap<QString, OrderedMap<QString, OrderedMap<QString, OJson>>>;
struct DepthBook {
    OrderedMap<double, OJson> bids, asks;
};
using JsList = QList<OJson>;

// ================================================================ IBApi + Controller + Socket + IBApiAutoConnection

class IbApi {
public:
    /// options:{host, port};reconnectInterval 毫秒(0 = 不重连)
    IbApi(std::shared_ptr<Runtime> rt, SocketFactory sockets, QString host, double port, double reconnectInterval);
    ~IbApi();

    Emitter events;
    StateSubject connectionState{Disconnected};

    bool isConnected() const { return status_ == kConnectedStatus; }
    double serverVersion() const { return serverVersion_; }

    // ---- IBApiAutoConnection
    void connect(std::optional<double> clientId);
    void disconnect();
    void onDisconnected();

    // ---- IBApi 的请求(都进命令缓冲)
    void wsh(int command, double reqId, const QString& filter = {}, const QString& start = {}, const QString& end = {});
    void reqManagedAccts();
    void reqContractDetails(double reqId, const OJson& contract);
    void reqMarketDataType(double type);
    void reqMktData(double reqId, const OJson& contract, const QString& genericTickList, bool snapshot, bool regulatorySnapshot);
    void cancelMktData(double reqId);
    void reqHistoricalData(double reqId, const OJson& contract, std::optional<QString> endDateTime, const QString& durationStr, const QString& barSizeSetting,
                           const QString& whatToShow, double useRTH, double formatDate, bool keepUpToDate);
    void reqSecDefOptParams(double reqId, const QString& symbol, const QString& futFopExchange, const QString& secType, double conId);
    void reqMktDepth(double reqId, const OJson& contract, double numRows, bool isSmartDepth);
    void cancelMktDepth(double reqId, bool isSmartDepth);
    void placeOrder(double id, const OJson& contract, const OJson& order);
    void cancelOrder(double orderId);
    void reqAllOpenOrders();
    void reqExecutions(double reqId, const OJson& filter);
    void reqPositions();
    void cancelPositions();
    void reqAccountSummary(double reqId, const QString& group, const QString& tags);
    void cancelAccountSummary(double reqId);
    void reqPnL(double reqId, const QString& account);
    void cancelPnL(double reqId);
    void reqIds();

    /// 解码 / 命令里接住的异常记到这里(默认 stderr)
    std::function<void(const QString&)> log;
    void setOwner(std::weak_ptr<void> owner) { owner_ = std::move(owner); }

private:
    static constexpr int kDisconnectedStatus = 0, kDisconnectingStatus = 1, kConnectingStatus = 2, kConnectedStatus = 3;

    // controller
    void schedule(std::function<void()> command);
    void pause() { paused_ = true; }
    void resume();
    void processCommands();
    void emitEvent(const QString& name, const OJson& args);
    void emitInfo(const QString& message, double code);
    void emitError(const QString& message, double code, std::optional<double> reqId = std::nullopt);
    void deliver(const tws::wire::Encoded& e);
    void sendMsg(const OJson& tokens);
    void rateCallNext(std::optional<OJson> args);
    void controllerConnect(double clientId);
    void controllerDisconnect();
    // socket
    void socketConnect(std::optional<double> clientId);
    void socketDisconnect();
    void socketSend(const OJson& tokens);
    void onSocketConnect();
    void onSocketData(const QByteArray& data);
    void onMessage(const QString& data);
    void onServerVersion(const QStringList& tokens);
    void onSocketEnd();
    void onSocketError(const QString& message);
    // auto connection
    void onConnected();
    void reConnect();
    void runReConnectTimer();
    void stopReConnectTimer();

    std::shared_ptr<Runtime> rt_;
    SocketFactory sockets_;
    QString host_;
    double port_;
    double reconnectInterval_;

    // controller
    std::deque<std::function<void()>> commands_;
    bool paused_ = true;
    bool processing_ = false;
    int rateCount_ = 4;
    std::deque<OJson> rateFifo_;

    // socket
    int status_ = kDisconnectedStatus;
    double serverVersion_ = 0;
    double clientId_ = 0;
    QString dataFragment_;
    bool neverReceived_ = true;
    QByteArray buffer_;
    std::shared_ptr<NodeSocket> client_;
    /// 还没 close 的 socket(旧的也留着:它们的 close 照样回到这里,同库)
    std::vector<std::shared_ptr<NodeSocket>> open_;
    std::unique_ptr<class DecoderBox> decoder_;

    // auto connection
    double currentClientId_ = 1;
    std::optional<double> fixedClientId_;
    bool autoReconnectEnabled_ = true;
    std::optional<quint64> reconnectTimer_;

    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
    /// 拥有这条 IbApi 的 ApiNext(弱):socket 与计时器的回调跑的时候钉住它,回调里把会话丢了也不会把正在跑的这一层拆掉
    std::weak_ptr<void> owner_;
};

// ================================================================ IBApiNext

class ApiNext : public std::enable_shared_from_this<ApiNext> {
public:
    /// 只能这样造(订阅与回调要拿到指向它的弱引用)
    static std::shared_ptr<ApiNext> make(std::shared_ptr<Runtime> rt, SocketFactory sockets, QString host, double port, double reconnectInterval);
    ApiNext(std::shared_ptr<Runtime> rt, SocketFactory sockets, QString host, double port, double reconnectInterval);

    IbApi& api() { return api_; }
    Runtime& runtime() { return *rt_; }
    StateSubject& connectionState() { return api_.connectionState; }
    bool isConnected() const { return api_.isConnected(); }
    double nextReqId() { return nextReqId_++; }

    /// errorSubject.subscribe
    void subscribeErrors(std::function<void(const ApiError&)> fn) { errorObservers_.push_back(std::move(fn)); }

    void connect(double clientId) { api_.connect(clientId); }
    void disconnect() { api_.disconnect(); }

    Task<QStringList> getManagedAccounts();
    Task<JsList> getContractDetails(const OJson& contract);
    void setMarketDataType(double type) { api_.reqMarketDataType(type); }
    std::shared_ptr<Subscription> getMarketData(const OJson& contract, const QString& genericTickList, bool snapshot, bool regulatorySnapshot);
    Task<JsList> getHistoricalData(const OJson& contract, std::optional<QString> endDateTime, const QString& durationStr, const QString& barSizeSetting,
                                   const QString& whatToShow, double useRTH, double formatDate);
    Task<QString> getWsh(bool metadata, const QString& filter = {}, const QString& start = {}, const QString& end = {});
    Task<JsList> getSecDefOptParams(const QString& symbol, const QString& futFopExchange, const QString& secType, double conId);
    std::shared_ptr<Subscription> getMarketDepth(const OJson& contract, double numRows, bool isSmartDepth);
    Task<double> getNextValidOrderId();
    Task<double> placeNewOrder(OJson contract, OJson order);
    void modifyOrder(double id, const OJson& contract, const OJson& order) { api_.placeOrder(id, contract, order); }
    void cancelOrder(double orderId) { api_.cancelOrder(orderId); }
    Task<JsList> getAllOpenOrders();
    Task<JsList> getExecutionDetails(const OJson& filter);
    std::shared_ptr<Subscription> getPositions();
    std::shared_ptr<Subscription> getAccountSummary(const QString& group, const QString& tags);
    std::shared_ptr<Subscription> getPnL(const QString& account);

private:
    friend class Subscription;
    using Subs = OrderedMap<double, std::shared_ptr<Subscription>>;
    using Handler = std::function<void(Subs&, const OJson& args)>;
    struct Entry {
        Live<LiveCounts::entries> live;
        QString event;
        int listener = 0;
        Subs subs;
    };
    std::shared_ptr<Subscription> registerSub(std::function<void(double)> request, std::function<void(double)> cancel,
                                              const std::vector<std::pair<QString, Handler>>& events, const QString& instanceId);
    void dispatchError(const ApiError& e);
    /// subscriptions.forEach:途中被删的不再访问
    static void forEachSub(Subs& subs, const std::function<void(const std::shared_ptr<Subscription>&)>& fn);
    template <class R>
    Task<R> lastValueFrom(const std::shared_ptr<Subscription>& sub, std::function<R(const std::any&)> map, R defaultValue);

    // 事件处理(api-next.js 里同名的那些)
    void onManagedAccts(Subs& subs, const OJson& a);
    void onAccountSummary(Subs& subs, const OJson& a);
    void onAccountSummaryEnd(Subs& subs, const OJson& a);
    void onPosition(Subs& subs, const OJson& a);
    void onPositionEnd(Subs& subs, const OJson& a);
    void onContractDetails(Subs& subs, const OJson& a);
    void onContractDetailsEnd(Subs& subs, const OJson& a);
    void onSecDefOptParam(Subs& subs, const OJson& a);
    void onSecDefOptParamEnd(Subs& subs, const OJson& a);
    void onPnL(Subs& subs, const OJson& a);
    void onTick(Subs& subs, const OJson& a);
    void onTickString(Subs& subs, const OJson& a);
    void onTickOptionComputation(Subs& subs, const OJson& a);
    void onTickSnapshotEnd(Subs& subs, const OJson& a);
    void onHistoricalData(Subs& subs, const OJson& a);
    void onUpdateMktDepth(Subs& subs, const OJson& a);
    void onUpdateMktDepthL2(Subs& subs, const OJson& a);
    void onOpenOrder(Subs& subs, const OJson& a);
    void onOpenOrderComplete(Subs& subs, const OJson& a);
    void onOrderStatus(Subs& subs, const OJson& a);
    void onNextValidId(Subs& subs, const OJson& a);
    void onExecDetails(Subs& subs, const OJson& a);
    void onExecDetailsEnd(Subs& subs, const OJson& a);
    void depthL2(Subs& subs, double reqId, const OJson* position, const OJson* marketMaker, const OJson* operation, const OJson* side, const OJson* price,
                 const OJson* size, const OJson* isSmartDepth);

    Live<LiveCounts::apiNext> live_;
    std::shared_ptr<Runtime> rt_;
    IbApi api_;
    double nextReqId_ = 1;
    std::vector<std::function<void(const ApiError&)>> errorObservers_;
    /// IBApiNextMap<eventName, entries>:按事件名第一次登记的先后
    std::vector<std::shared_ptr<Entry>> entries_;
};

}  // namespace ibkr::execution::ibnext
