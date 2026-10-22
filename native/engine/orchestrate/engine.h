// engine.ts 逐句搬:TradingEngine——输入 → 解析 → 硬校验 → 下单 → 落库 → 通知;盯盘节拍器;持仓追踪的到价平仓与追价;条件单队列;熔断与保护规则;
// 回报接线;账户扇出。**钱路径**:下单只在最后一步发生,且要同时满足:校验通过、熔断未触发、auto_execute=true、账户允许。
// 期望值:tests/fixtures/gen_engine_core.mjs(原 TradingEngine 对着脚本驱动的假 router / 假解析器 / 真交易库与熔断开关、虚拟钟现跑,
// 对 router / 库 / 通知 / 熔断 / 解析器的每一次调用的方法、参数、虚拟时刻、先后,与各步结果、内部状态、整个库的最终样子一并记下),tests/engine_core_world.h 放同样的脚本给这里。
//
// 文件分工:engine.cpp = 指令主线(handleInstruction / execute / firePending / 条件单 / 熔断 / 保护 / 落库);engine_tracker.cpp = 盯盘节拍器与持仓追踪
// (pollTrackers / 标的目标价 / 平仓 / 追价);engine_hosts.cpp = 子模块的宿主适配、回报接线、对外的适配(Svc1Engine / SvcEngine)。
//
// 对外的面(RPC 层、service 调的就是这些;名字是 TS 的 camelCase):
//   handleInstruction · firePending · expirePending · halt · protectionState · pollTrackers · trackerTickOnce · startTrackerLoop / stopTrackerLoop · trackerHeartbeat ·
//   withTrackerLock / sharedTrackerLock · closePosition · sweepExisting · pendingCloseRecord · naturalCloseFor · marketStatusFor · accountIsPaper · applySpotTarget ·
//   syncHosted · reconcileSoon / reconcileDue / reconcileOrders · wireSession / attachListeners · syncBrokerOrders · onIbError / onOrderStatus / onExecDetails / onCommission ·
//   baseRecord · brokerCode;状态:pendingTriggers、orderIndex、finalized、sessionEm、hostedOrders()、exits()、wakeGuard、onTrackerTick、publicPriceFn、router。
//   resolveFanoutAccounts / fanOutOrders / orderTicket / dumpExcludeNone 是自由函数(TS 里是 engine.ts 的导出)。
//
// 与 TS 的对应与不同(交付报告里有同样的一份):
//   · 返回/参数里的 JS 对象(Rec、追踪行、持仓行、订单……)一律 OJson(键序同 TS);协程的参数一律按值(协程帧里的引用会悬空);协程的 lambda 一律不用,
//     回调包的是成员协程。
//   · 条件单队列里的每一项、追价平仓的缓存项是 shared_ptr:TS 里同一个对象被好几处拿着(firePending 在 await 的空档里 halt 可以把数组清掉,手里的引用照样活着)。
//   · `_dafriWired`(挂在会话对象上的标记)收成进程里的一张按会话指针记的表(wireSession)。
//   · 盯盘锁 JS 的 `.then` 总让一拍,这里链空着时同步开始(TrackerLock)。
//   · 计时器:startTrackerLoop 用 setTimeout 成员(缺省 QTimer);clearTimeout = 从活着的计时器集合里摘掉,到点的回调先查自己还在不在。引擎先没了,计时器放手(存活标志)。
//   · awakeClockMs → awakeClock 成员(缺省 wake::awakeClockMs());Date.now() → nowMs()(util::dateNow);nowEt() → domain::nowEt()。
//   · pollOrderUpdates(只有富途 router 有)保留,IBKR 的 router 没有 → syncBrokerOrders 空转;brokerCode 随 router.broker()。
//   · **与 TS 的有意差别(只在 C++ 改,TS 不动;对应的场景不与 TS 比,见 tests/tst_engine_core.cpp 的 cppOnly)**:
//     ① 换引擎(reload / dropEngine)时条件单队列 pendingTriggers 交给新引擎(adoptPendingTriggers);TS 里它留在旧实例上——界面的队列清空、库里还是 PendingTrigger、永远不触发;
//     ② firePending 每一张发出前再查一次熔断(同 handleInstruction 的批内熔断),并确认它还在队里(halt 已清队就不发)——TS 只在函数开头查一次;
//     ③ halt() 里 cancelAllOpen 抛了,软件侧的条件单队列与托管缓存照样清,再写审计 / 通知(带「撤单失败」)后把错抛出去——TS 里这两步被跳过。
//     ④ 盯盘的推送提前醒与快速下跌的追价(orchestrate/fast_exit、analysis::momentumLead):期权行情一推过来就判,越线不等下一拍;追价按跌速多让、
//        提前醒的那一轮不推峰值、不数追价轮数、守改价间隔;读常驻行情不再各等 50ms。对着 TS 夹具比的那几组把多让关掉、等待换回 50ms
//        (setChaseLeadDefaultForTests / BrokerRouter::setHeldStreamPumpMsForTests),这一项自己的行为在 tests/tst_fly_fast_exit.cpp。
//   · TS 原样:closePosition / firePending 对任何异常都记熔断(含 LinkDownError),只有 chaseCloseOrder 认 LinkDownError 不记;pollTrackers 里 closeChase 缓存项
//     的 accepted_limit 在改价被拒时恢复;wireSession 的 try/catch 吞掉 sessionHook 赋值失败。
#pragma once

#include "domain/config.h"
#include "domain/store.h"
#include "execution/broker.h"
#include "orchestrate/account_guard.h"
#include "orchestrate/callbacks.h"
#include "orchestrate/clock.h"
#include "orchestrate/engine_router.h"
#include "orchestrate/exits.h"
#include "orchestrate/fast_exit.h"
#include "orchestrate/heartbeat.h"
#include "orchestrate/hosted.h"
#include "orchestrate/reconcile.h"
#include "orchestrate/services/svc1_ports.h"
#include "orchestrate/services/svc_host.h"
#include "orchestrate/tracker.h"
#include "orchestrate/wake_guard.h"
#include "parsing/prompts.h"
#include "parsing/validator.h"
#include "util/killswitch.h"
#include "util/notify.h"
#include "util/protections.h"
#include "util/task.h"

#include <QHash>
#include <QList>
#include <QSet>
#include <QString>
#include <QStringList>

#include <deque>
#include <functional>
#include <memory>
#include <optional>
#include <vector>

namespace ibkr::orchestrate {

/// engine.ts 的 EngineResult(键序 submitted / queued / validated_only / rejections / warnings / llm)
struct EngineResult {
    QList<Rec> submitted, queued, validated_only, rejections;
    QStringList warnings;
    /// {model, prompt_version, prompt_fingerprint, latency_ms, usage};没解析到就是空(null)
    std::optional<Rec> llm;
    Rec toJson() const;
};

/// 用户勾选的账户别名 → 去重后的有效别名;别名表外的名字抛 JsError(RPC 层把它变成 -32602)。空或没给 = 空
QStringList resolveFanoutAccounts(const domain::Settings& settings, const std::optional<QStringList>& accounts);
/// 按勾选账户复制未指定账户的订单;回 [新订单列表, 给用户看的说明或空]
std::pair<QList<Rec>, std::optional<QString>> fanOutOrders(const QList<Rec>& orders, const QStringList& accounts);
/// 一笔已通过校验的订单压成界面能直接画的样子
Rec orderTicket(const Rec& parsed);
/// model_dump(exclude_none=True) 的对应物:去掉 null 字段(嵌套一并处理)
Rec dumpExcludeNone(const Rec& value);

/// 今天的 EM(日内剧本底账里的那一条),一分钟读一次文件(engine/sessionEm.ts)
class SessionEmCache {
public:
    static constexpr double kTtlMs = 60'000;
    explicit SessionEmCache(std::function<const domain::Settings&()> settings) : settings_(std::move(settings)) {}
    std::optional<double> today(const domain::EtNow& at);

private:
    struct Hit {
        QString date;
        double atMs = 0;
        std::optional<double> em;
    };
    std::function<const domain::Settings&()> settings_;
    std::optional<Hit> cached_;
};

struct EngineArgs {
    domain::Settings settings;
    std::shared_ptr<EngineParser> parser;
    /// 空 = new TradeStore(settings.db_path)
    std::shared_ptr<domain::TradeStore> store;
    /// 空 = new Notifier()
    std::shared_ptr<util::Notifier> notifier;
    /// 空 = <db 所在目录>/breaker.json,阈值取 policies.consecutive_failure_breaker
    std::shared_ptr<util::KillSwitch> killswitch;
    std::shared_ptr<EngineRouter> router;
    /// 空 = loadPromptBundle(settings)
    std::optional<parsing::prompts::PromptBundle> bundle;
    /// 测试:库 / 熔断开关的端口(套了记录器的)。空 = 直接包 store / killswitch
    std::shared_ptr<CoreStore> storePort;
    std::shared_ptr<BreakerPort> breakerPort;
};

class TradingEngine {
public:
    explicit TradingEngine(EngineArgs args);
    ~TradingEngine();
    TradingEngine(const TradingEngine&) = delete;
    TradingEngine& operator=(const TradingEngine&) = delete;

    // ---- 状态(TS 的公开字段)
    domain::Settings settings;
    std::shared_ptr<EngineParser> parser;
    parsing::prompts::PromptBundle bundle;
    domain::TradeStore& store() { return *store_; }
    util::Notifier& notifier() { return *notifier_; }
    util::KillSwitch& killswitch() { return *killswitch_; }
    CoreStore& storePort() { return *storePort_; }
    BreakerPort& breakerPort() { return *breakerPort_; }
    /// 引擎重建 / 重连时 RPC 层换 router(TS 的 `engine.router = …`)
    void setRouter(std::shared_ptr<EngineRouter> r) { router_ = std::move(r); }
    EngineRouter* router() { return router_.get(); }
    std::shared_ptr<EngineRouter> routerShared() const { return router_; }

    std::vector<std::shared_ptr<execution::PendingTrigger>> pendingTriggers;
    OrderIndex orderIndex;
    QSet<QString> finalized;
    std::deque<UnmatchedEvent> unmatchedEvents;
    QSet<QString> seenFills, seenCommissions;
    EarlyOrderErrors earlyOrderErrors;
    SentOrders sentOrders;
    QHash<qint64, QString> closeChaseIndex;
    /// 速记解析的公开源现价注入点(测试替身用;空 = analysis::macro::publicIndexPrice)
    std::function<util::Task<std::optional<double>>(const QString&)> publicPriceFn;
    /// 最近一次解析预热的句柄(仅测试等待用;业务代码永不 await 它)
    util::Task<> prewarmPromise;
    SessionEmCache sessionEm;
    HostedOrders& hostedOrders() { return *hostedOrders_; }
    TrackExits& exits() { return *exits_; }
    AccountGuard& accountGuard() { return *accounts_; }

    // ---- 计时器 / 时钟的钩子(缺省 = 生产)
    /// 一次性换掉引擎、托管单、对账三处的 setTimeout
    void setTimerHook(SetTimeout hook);
    std::function<double()> awakeClock;

    // ---- 指令
    /// 解析一条指令并走完校验 / 执行。accounts 是用户勾选的目标账户别名。dryRun:只解析、只校验,不发单(**不许**靠临时改 policies.auto_execute 实现)
    util::Task<EngineResult> handleInstruction(QString instruction, QString channel = QStringLiteral("manual"), std::optional<domain::EtNow> moment = std::nullopt,
                                               std::optional<Rec> snapshot = std::nullopt, std::optional<QStringList> accounts = std::nullopt, bool dryRun = false,
                                               InstructionScope scope = {});
    /// 由盯盘循环驱动:条件满足就按中间价下单。prices:{代码: 价}。回 [{record_id, limit, price}]
    util::Task<QList<Rec>> firePending(Rec prices);
    /// 收盘后清理当日未触发的条件单
    int expirePending(std::optional<domain::EtNow> moment = std::nullopt);
    /// §9.7 全局熔断:停新单 + 撤未成交单。回 {engaged, cancelled}
    util::Task<Rec> halt(QString reason);
    util::ProtectionState protectionState(std::optional<double> nowMs = std::nullopt);

    // ---- 盯盘节拍器
    static constexpr int kTrackerTickMs = 1000;
    static constexpr int kTrackerSlowMs = 1500;
    /// 节拍器的心跳:最近一轮的结果与计时(键序同 TS)
    Rec trackerLoop;
    /// 每轮结束的回调(RPC 层据此把触发 / 被拦推给界面)
    std::function<void(const Rec& poll, const Rec& hosted)> onTrackerTick;
    wake::WakeGuard wakeGuard;
    /// RPC 层注入的共享锁(跨引擎实例同一把;rpc::SerialLock::runVoid 即符合)。空 = 用引擎自己的队
    std::function<util::Task<>(std::function<util::Task<>()>)> sharedTrackerLock;
    util::Task<> withTrackerLock(std::function<util::Task<>()> fn) {
        if (sharedTrackerLock) return sharedTrackerLock(std::move(fn));
        return ownLock_.run<void>(std::move(fn));
    }
    void startTrackerLoop(int intervalMs = kTrackerTickMs);
    void stopTrackerLoop();
    /// 推送判定该醒了(orchestrate/fast_exit):不等节拍,马上排一轮;正在跑的话跑完紧接着再跑。节拍器没开着就不管
    void wakeTracker();
    /// 一轮盯盘:读一次持仓 → 判触发 → 托管对账。任何异常都不许让节拍器停下。
    /// early:推送提前叫醒的这一轮——判断照常,只是不推峰值、不数追价轮数、追价守改价间隔
    util::Task<> trackerTickOnce(std::optional<domain::EtNow> moment = std::nullopt, bool early = false);
    /// 这一轮是推送提前叫醒的(托管单那一块也读)
    bool earlyTick = false;
    /// 测试用:推送那一路
    FastExit& fastExit() { return *fastExit_; }
    Rec trackerHeartbeat() const;

    // ---- 持仓追踪
    util::Task<SpotTargetResult> applySpotTarget(Rec track, Rec raw, tracker::Position position, Rec targets, Rec positions, domain::EtNow at);
    /// rows 空 = 自己读持仓。回 TrackerPollTick {rows, fired, blocked}
    util::Task<Rec> pollTrackers(std::optional<domain::EtNow> moment = std::nullopt, std::optional<QList<Rec>> rows = std::nullopt);
    util::Task<QString> marketStatusFor(Rec raw, domain::EtNow at);
    util::Task<std::optional<double>> naturalCloseFor(Rec raw, tracker::Position position, Rec positions);
    bool accountIsPaper(const QString& alias);
    /// 真的把平仓单发出去,并且先落闩再发。回 TrackFired {id, symbol, state, record_id, reason, order_id} 或空
    util::Task<std::optional<Rec>> closePosition(Rec track, tracker::Position position, Rec autoClose, Rec result, std::optional<QString> marketStatus = std::nullopt);
    util::Task<std::optional<ChaseQuote>> chaseQuote(Rec raw, tracker::Position position, Rec positions, Rec autoClose, std::optional<double> prev, double rounds,
                                                     std::optional<QString> reason);
    void chaseWarnIfStuck(const Rec& track, Rec& entry, double limit, double natural);
    void closeChaseModifyRejected(qint64 orderId);
    void closeChaseOnStatus(const Rec& trade);
    /// 手动「立即平仓」落在一条已经有单在券商侧的追踪上:不另发一张,把现成的那条路改成追价平仓。true = 已这么办了
    util::Task<bool> sweepExisting(Rec track, QString reason);
    /// 这条追踪上一次自动平仓发出的那张单还挂在券商侧:回它的记录 id
    std::optional<QString> pendingCloseRecord(const Rec& track);
    util::Task<Rec> syncHosted(std::optional<QList<Rec>> rows = std::nullopt);

    // ---- 对账 / 回报
    void reconcileSoon();
    bool reconcileDue(std::optional<double> nowMs = std::nullopt);
    util::Task<Rec> reconcileOrders(std::optional<double> nowMs = std::nullopt);
    void replayUnmatched();
    /// 给一条会话挂上全部回报监听(幂等)
    bool wireSession(const SessionPtr& session);
    int attachListeners();
    QString brokerCode();
    util::Task<int> syncBrokerOrders();
    void onIbError(const Rec& reqId, const Rec& errorCode, const Rec& errorString);
    void onOrderStatus(const Rec& trade);
    void onExecDetails(const Rec& trade, const Rec& fill);
    void onCommission(const Rec& trade, const Rec& fill, const Rec& report);

    // ---- 落库
    Rec baseRecord(const QString& instruction, const QString& channel, const parsing::providers::LLMResponse* response);

    // ---- 引擎重建(rpc/server.ts 的 retireEngine / inheritLedgers):装配的人用
    /// 换下来的引擎把回报转给**现在的**引擎(TS 把旧实例上接回报的几只手换成"现取 this.engine 再转过去")。会话上的监听闭包调的是旧实例的成员,
    /// 所以这里转的是成员的入口:onOrderStatus / onExecDetails / onCommission / onIbError / wireSession(sessionHook 也走 wireSession)
    struct Forwards {
        std::function<void(const Rec&)> onOrderStatus;
        std::function<void(const Rec&, const Rec&)> onExecDetails;
        std::function<void(const Rec&, const Rec&, const Rec&)> onCommission;
        std::function<void(const Rec&, const Rec&, const Rec&)> onIbError;
        std::function<bool(const SessionPtr&)> wireSession;
    };
    void retire(Forwards forwards) { forwards_ = std::move(forwards); }
    /// 新引擎接着记旧引擎的回报账(只在同一个 router 上接):orderIndex、终态、exec_id 去重、早到的错误、发单账本、没对上的回报、wakeGuard
    void inheritLedgersFrom(TradingEngine& from);
    /// 换引擎时新引擎接旧引擎:同一个 router 才接回报账(换了连接,旧的订单号不作数);条件单队列不论 router 都接
    void continueFrom(TradingEngine& old, bool sameRouter);
    /// C++ 独有:换引擎时把还没触发的条件单队列(pendingTriggers)接过来,旧引擎的清空。不论 router 换没换——这些单是软件盯着的,和券商会话无关
    void adoptPendingTriggers(TradingEngine& from);

    // ---- 测试用:内部状态的样子(键排序)
    Rec closeChaseSnapshot() const;
    Rec flyMarkSnapshot() const;
    bool closeChaseAdopted() const { return closeChaseAdopted_; }
    const Reconciler& reconciler() const { return *reconciler_; }

    // ---- 给 service 层的窄面
    Svc1Engine& svc1();
    SvcEngine& svcView();

    struct Impl;
    friend struct Impl;

private:
    // 指令主线
    util::Task<Rec> execute(QString recordId, parsing::validator::ApprovedOrder approved);
    util::Task<double> priceAutoMid(parsing::validator::ApprovedOrder approved);
    void prewarm(const parsing::validator::ApprovedOrder& approved);
    util::Task<> prewarmRun(Rec contract, contract::AccountConfig account);
    void indexPlacement(const QString& recordId, const execution::PlacementResult& placement);
    QString recordApproved(const QString& instruction, const QString& channel, const parsing::providers::LLMResponse& response, const parsing::validator::ApprovedOrder& approved);
    QString recordRejection(const QString& instruction, const QString& channel, const parsing::providers::LLMResponse& response, const Rec& rejection,
                            const QString& finalStatus);
    QString recordValidatorRejection(const QString& instruction, const QString& channel, const parsing::providers::LLMResponse& response,
                                     const parsing::validator::RejectedOrder& rejected);
    util::Task<Rec> buildSnapshot(QStringList symbols, Rec cached);

    // 盯盘
    util::Task<> tickBody(double t0, double mono, std::optional<domain::EtNow> moment);
    QString wakeTick(double wall, double mono, const QList<Rec>& tracks);
    util::Task<std::optional<Rec>> chaseCloseOrder(Rec track, Rec raw, tracker::Position position, Rec positions, Rec autoClose);
    void dropCloseChase(const QString& tid);
    util::Task<> adoptCloseChase(QList<Rec> tracks);
    std::optional<Rec> closeUnbuildable(const Rec& track, const QString& message);
    void scheduleTick(int delayMs, int intervalMs, bool early);
    util::Task<> tickLoop(int intervalMs, bool early, int generation);

    std::shared_ptr<domain::TradeStore> store_;
    std::shared_ptr<util::Notifier> notifier_;
    std::shared_ptr<util::KillSwitch> killswitch_;
    std::shared_ptr<EngineRouter> router_;
    std::shared_ptr<CoreStore> storePort_;
    std::shared_ptr<BreakerPort> breakerPort_;
    std::unique_ptr<Impl> impl_;
    std::unique_ptr<HostedOrders> hostedOrders_;
    std::unique_ptr<TrackExits> exits_;
    std::unique_ptr<AccountGuard> accounts_;
    std::unique_ptr<Reconciler> reconciler_;
    std::unique_ptr<IbCallbacks> callbacks_;
    LoopMeter loopMeter_;
    TrackerLock ownLock_;
    SetTimeout setTimeout_;
    /// 「标的目标价」上一轮算出来的预计价位
    QHash<QString, double> flyMark_;
    /// 追价平仓缓存:track_id → 项(shared_ptr:await 的空档里被摘掉,手里的引用照样活着)
    QHash<QString, std::shared_ptr<Rec>> closeChase_;
    bool closeChaseAdopted_ = false;
    /// 追价平仓单上一次改价(或发出)的时刻:提前醒的那一轮守改价间隔用。不放进缓存项(缓存项的样子对着 TS 比)
    QHash<QString, double> closeChaseModifiedAt_;
    QSet<qint64> liveTimers_;
    qint64 nextTimerId_ = 0;
    std::optional<qint64> tickTimer_;
    /// 节拍器:正在跑一轮、跑的时候被推送叫过、上一次按拍跑的时刻、停一次加一(停了又开,旧的那一轮跑完不再接着排)
    bool tickRunning_ = false, wakeRequested_ = false;
    double lastRegular_ = 0;
    int tickInterval_ = kTrackerTickMs, tickGeneration_ = 0;
    /// 推送第一次叫醒的时刻(这一段提前醒跑完清掉):发单的审计里记从叫醒到发单多久
    std::optional<double> wokeAt_;
    std::unique_ptr<FastExit> fastExit_;
    Forwards forwards_;
    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
};

}  // namespace ibkr::orchestrate
