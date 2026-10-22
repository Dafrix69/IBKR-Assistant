// 本机 JSON-RPC 服务:stdio 上的换行分隔 JSON-RPC 2.0,同 engine-ts/src/rpc/server.ts 里「传输」「生命周期」那两件事
// (装配——合成方法表、起各个 service——由后来搬 service 与 handler 的人接在 Hooks 与 add*() 上,见 transport/context.h)。
// stdout 只跑协议,日志一律走 stderr。
//
// 读一行:和 Node 的 readline 一样按 \r\n、\r、\n、U+2028、U+2029 断行,JS 的 trim() 之后空行不理,JSON.parse(项目自己的 parseOJson:
// 1e999 / 1e-400、-0、重复的键、键序都同 V8)。回执一律用 stringifyOJson 写,键序 jsonrpc / id / result|error{code,message},同 JSON.stringify。
// 回的话与 TS 版一字不差:解析不了 → -32700「无法解析的 JSON」(id 为 null),没有这个方法 → -32601「未知方法:<名字>」,
// handler 抛 RpcError → 它的码与话,抛 KeychainError → -32008 原话,别的 → -32000「<名字>: <话>」。
//
// 三条道(同 TS 的 serve()):
//   · 本地道(LOCAL_METHODS):来了就答,不排队;
//   · 读道(READ_METHODS):最多 kReadConcurrency 个并发;
//   · 交易道(其余):严格顺序,用户请求插到周期轮询(LOW_PRIORITY_METHODS)前面;「无法解析的 JSON」也在交易道上按先后答。
// 本地道与读道在 handleLine 里**当场**开始(TS 的 runDetached / pumpReads 就在 line 监听里);交易道只入队、等一次 pump 去取。
// 回执的先后照 Node 的微任务队列学:所有回执(包括同步答完的 handler)都晚一个「微任务」才写,pump 也是排在这个队列里的一项,
// 解析不了的行由 pump 直接写(不再等一拍)。所以同一批来的行里:本地道 / 读道的回执按各自开始的先后写,而「解析不了」的那一行在它
// 之前来的、之后来的本地请求回执之间都按 pump 排队的位置出现——和 TS 逐条一致(tools/gen_rpc_server.mjs 里有混排的场景)。
// EOF 之后等队列清空、在途请求都答完才收尾(onFinished,退出码 0)。
//
// 同 TS 的怪处,都是照搬:
//   · 请求不是对象(数组、数、串、布尔)时 method 读成 ""、id 读成 null → 「未知方法:」。TS 在 null / 数 / 串 / 布尔上更糟:
//     line 监听里 null["method"] 或 WeakMap.set(原始值) 抛 TypeError,整个引擎进程 uncaughtException 退出。C++ **不**照搬这一条(不会为一行输入把引擎打死),按数组的样子答。
//   · method 不是字符串时 String(method):1 → "1"、[1,2] → "1,2"、{} → "[object Object]"。
// C++ 才有的一条:嵌套深度上限(util/ordered_json 的 kMaxJsonDepth),超过按解析不了答 -32700;JS 的 JSON.parse 不设上限。
#pragma once

#include "transport/perf_log.h"
#include "util/ordered_json.h"
#include "util/rpc_error.h"
#include "util/task.h"

#include <QByteArray>
#include <QByteArrayView>
#include <QHash>
#include <QJsonObject>
#include <QJsonValue>
#include <QObject>
#include <QSet>
#include <QStringList>
#include <QTimer>

#include <deque>
#include <functional>
#include <optional>
#include <stdexcept>

namespace ibkr::rpc {

inline constexpr auto kProtocolVersion = "1.0";

/// handler 抛它 = 回一个带码的错误。和 util::RpcError 是同一个类(早先各有一个,RpcServer 两个都接)
using RpcError = util::RpcError;

/// 要对象参数的方法先过它:不是对象就回 -32602,原话同 TS 版 zod 的
/// 「<方法> 的参数不对:params 应为 object,收到 array」(rpc/contractMethods.ts + schema/kit.ts 的 describeIssue)
QJsonObject objectParams(const QString& method, const QJsonValue& params);
const util::OJson& objectParams(const QString& method, const util::OJson& params);

/// 启动前的检查(读配置、把交易库开一遍:cli::startupChecks)跑过没有。TS 的 main() 先开库、再 serve()、再起各个 service;
/// 引擎一旦有真的 handler,必须先过这一关——库打不开就当场 [fatal:store:…] 退出,而不是「正常启动」后每个请求回一句 SqliteError。
/// 开了 requireStartupChecks() 的 server,登记 system.status 之外的方法时没过这一关就抛 JsError。
bool startupChecked();
void markStartupChecked();
void resetStartupCheckedForTest();

/// 道表(server.ts 的 LOCAL_METHODS / READ_METHODS / LOW_PRIORITY_METHODS)
struct LaneTable {
    QSet<QString> local;
    QSet<QString> read;
    QSet<QString> low;
};
/// TS 里写死的那三张表
const LaneTable& defaultLaneTable();
inline constexpr int kReadConcurrency = 4;  // RpcServer.READ_CONCURRENCY
inline constexpr double kSlowMs = 1000;     // RpcServer.SLOW_MS:超过这个时长的请求记到 stderr

/// 生命周期的接口:TS 的 serve() 在起、停时碰的那些 service(行情循环、预热现价、各路后台同步……)还没搬过来,由搬它们的人把函数接在这里
struct LifecycleHooks {
    /// serve() 发完 ready 之后:anomaly.start / ivRecorder.start / playbook.start / 预热 SPX 现价
    std::function<void()> onServe;
    /// serve() 退出前:最后一次 flushPerf 之后,anomaly.stop … brokerLink.stop
    std::function<void()> onShutdown;
    /// 每十分钟那一行 [perf] 的 extra 计数(同 takeQualifyGateStats():{ qualify: … });没有就空对象
    std::function<util::OJson()> perfExtra;
    /// 写一行到 stderr(慢请求、每十分钟的汇总、没料到的错);缺省 fprintf(stderr)。测试里接过来看
    std::function<void(const QString& line)> stderrLine;
};

class RpcServer : public QObject {
public:
    /// params 原样给(同 TS 版):没带或 null 时是 {};数组、数之类的也照给,收什么由各方法自己定(要对象的用 objectParams / addContractMethod)
    using Handler = std::function<QJsonValue(const QJsonValue& params)>;  // QJsonValue 版:QJsonObject 把键排序,要键序的用 addOJson
    using OJsonHandler = std::function<util::OJson(const util::OJson& params)>;
    /// 协程 handler 要在 co_await 之后还用 params 时,自己按值收一份(`[](OJson p) -> Task<OJson>`):这里给的引用只活到 handle() 答完
    using AsyncHandler = std::function<util::Task<util::OJson>(const util::OJson& params)>;
    using Writer = std::function<void(const QByteArray& line)>;

    /// out 收到的是一整行(不含换行),由调用方加 \n 写到 stdout
    explicit RpcServer(Writer out, QObject* parent = nullptr);

    // 登记方法(重复登记是编程错误:抛 JsError「RPC 方法重复登记:<名字>」,同 TS)
    void add(const QString& method, Handler handler);
    void addOJson(const QString& method, OJsonHandler handler);
    void addAsync(const QString& method, AsyncHandler handler);
    bool has(const QString& method) const { return table_.contains(method); }
    /// 全部方法名,排好序(JS 的 .sort() 按 UTF-16 码元,QString 的 < 也是)
    QStringList methodNames() const;

    /// 开了之后,启动前的检查没跑过就不许登记 system.status 之外的方法(见 startupChecked)。阶段 0 的 main.cpp 只登记 system.status,不受影响
    void requireStartupChecks() { requireStartup_ = true; }
    LaneTable& lanes() { return lanes_; }
    const LaneTable& lanes() const { return lanes_; }
    Lane laneOf(const QString& method) const;
    LifecycleHooks hooks;

    // ---- 生命周期
    /// serve() 的开头:发 ready 事件(同步、第一行),调 onServe,起每十分钟一行的汇总
    void begin(const QString& configPath);
    /// 收到的一行(可以带 \r 与别的行终结符:内部再断)。stdin 读线程把读到的每一行投递到主线程再调它
    void handleLine(QByteArrayView rawLine);
    /// stdin 关了(readline 的 close):等队列清空、在途请求答完,然后 onFinished(0)
    void handleEof();
    /// 收尾完成时调(serve() 的返回值)
    void setOnFinished(std::function<void(int exitCode)> f) { onFinished_ = std::move(f); }
    bool finished() const { return finished_; }
    /// 立刻写一行汇总到 stderr(没有请求就什么都不写)
    void flushPerf();
    RpcTimings& timings() { return timings_; }
    /// 测试用:缩短每十分钟一行汇总的间隔、慢请求的门槛(缺省 kFlushMs / kSlowMs)
    void setFlushIntervalMs(int ms) { flushTimer_.setInterval(ms); }
    void setSlowMs(double ms) { slowMs_ = ms; }

    /// 直接调一个方法:不包 JSON-RPC 信封、不写 stdout,失败原样抛(RpcError 带码)。method 没登记抛 -32601「未知方法:<名字>」
    util::Task<util::OJson> call(const QString& method, const util::OJson& params);

    /// 引擎发给界面的事件:{"jsonrpc":"2.0","method":"event","params":{"event":名字,"data":载荷}}
    void emitEvent(const QString& event, const QJsonObject& data);
    void emitEvent(const QString& event, const util::OJson& data);

private:
    struct Pending {
        util::OJson request;
        bool bad = false;  // 解析不了的那一行(TS 的 BAD 哨兵)
        qint64 receivedUs = 0;
    };

    void processLine(const QString& rawLine);
    void dispatch(Pending request);
    util::Task<void> handle(Pending request);
    void write(const util::OJson& message);
    void stderrLine(const QString& line);
    void pumpTrade();
    void pumpReads();
    void schedulePump();
    void enqueueMicro(std::function<void()> f);
    void maybeFinish();

    Writer out_;
    QHash<QString, AsyncHandler> table_;
    LaneTable lanes_;
    RpcTimings timings_;

    std::deque<Pending> normal_, low_, reads_;
    int readsInFlight_ = 0;
    int detached_ = 0;  // 本地道 + 读道里还没答完的请求数:EOF 后要等它们答完再退出
    bool tradeBusy_ = false;
    bool pumpingTrade_ = false, pumpTradeAgain_ = false, pumpingReads_ = false;
    bool pumpScheduled_ = false, microPosted_ = false;
    std::deque<std::function<void()>> micro_;
    bool closed_ = false, finished_ = false, requireStartup_ = false;
    QTimer flushTimer_;
    double slowMs_ = kSlowMs;
    std::function<void(int)> onFinished_;
};

}  // namespace ibkr::rpc
