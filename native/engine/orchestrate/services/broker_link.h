// services/brokerLink.ts 逐句搬:券商连接的生命周期——连、断、启动时自动连、从没连上的连接定时再试,以及掉线 / 重连的提醒与反复断开时的收声。
// 期望值:tests/fixtures/gen_svc_brokerlink.mjs(原 BrokerLinkService 对着真的 BrokerRouter 与脚本驱动的假会话现跑,虚拟钟),
// tests/tst_svc_brokerlink.cpp 把同样的脚本放给这里,逐项精确比较(宿主上的每一次调用、会话上的每一次调用、stderr 的每一行、各步结果)。
//
// 与 TS 的对应与不同:
//   · router 是具体的 execution::BrokerRouter(BrokerLinkHost::broker() / setBroker());富途不移植:makeRouter 在 broker.provider 不是 ibkr 时抛 JsError,
//     `router.BROKER !== provider` 的分支(换券商)照搬。可注入 makeRouterHook(测试换成带假会话工厂的 router)。
//   · `this.host.engine` 的读(懒建引擎)→ svcEngine() 调用,次序同 TS:connectNow 里先 `void host.engine`、dropEngine()、再 `host.engine.attachListeners()`、
//     再 `host.engine.store.audit(...)`;announceLink / announceFlapping 里各取一次。
//   · serial():TS 是 `chain.then(fn, fn)`;同 transport/context.h 的 SerialLock(它在 transport 层,orchestrate 不能 include 它,这里写一份同语义的)。
//     TS 里 then 的回调永远晚一个微任务,这里空闲时当场就跑——同一虚拟时刻内的次序不变,别的任务插不进来的那一拍没有行为差别。
//   · setInterval / setTimeout / Date.now 走 runtime()(svc_runtime.h)。timer.unref():没有对应。
//   · 服务对象必须活得比它所有未完成的调用长;router 上挂的 linkHook 拿一个存活标志,服务先没了就放手。
//   · failed 是 Record<string,string>:OrderedMap(插键先后);JS 里长得像数组下标的连接名("1")会排到最前,不模拟(同 ordered_map.h 的说明)。
#pragma once

#include "contract/ordered_map.h"
#include "orchestrate/services/svc_host.h"

#include <QHash>
#include <QSet>
#include <QString>
#include <QStringList>

#include <functional>
#include <memory>
#include <optional>

namespace ibkr::orchestrate {

/// contract/connection.ts 的 BrokerConnectResult
struct BrokerConnectResult {
    QString provider;
    QStringList connected;
    /// 没连上的那几条各自的原因
    contract::OrderedMap<QString> failed;
    /// 给引擎挂上了几个事件监听
    int listeners = 0;
    util::OJson toJson() const;
};

class BrokerLinkService {
public:
    /// 从没连上的连接隔多久再试一次
    static constexpr int kRetryMs = 30'000;
    /// 连上后能撑过这么久才算"稳定连上";撑不过就是抖动
    static constexpr int kStableMs = 10'000;
    /// 一分钟内抖动到这个次数,判定为反复断开
    static constexpr int kFlapCount = 2;

    explicit BrokerLinkService(BrokerLinkHost& host);
    ~BrokerLinkService();
    BrokerLinkService(const BrokerLinkService&) = delete;
    BrokerLinkService& operator=(const BrokerLinkService&) = delete;

    /// 测试换成带假会话工厂的 router;缺省 new BrokerRouter(settings)
    std::function<std::shared_ptr<execution::BrokerRouter>()> makeRouterHook;

    /// 引擎启动时调一次(只在真正的 stdio 入口里调,测试里的 serve() 不碰它——测试不许连真券商)
    void start();
    void stop();
    /// 按配置里生效的那家券商建 router(全系统唯一需要分支的地方)
    std::shared_ptr<execution::BrokerRouter> makeRouter();
    /// 「连接」:连上指定的(缺省全部)连接,并让引擎带上 router 重建
    util::Task<BrokerConnectResult> connect(std::optional<QStringList> names = std::nullopt);
    /// 「断开」:用户明确不要连着了,之后不再自动连
    util::Task<> disconnect();
    /// 换券商:旧连接已经断干净,等用户在新那家上点「连接」
    void forget();
    /// 一次重试:把配置里有、这个 router 上从没连上过的连接再连一遍
    util::Task<> retryOnce();

private:
    struct LinkFlap {
        std::optional<double> lastUpAt;
        QList<double> flaps;
        bool flapping = false;
        bool downAnnounced = false;
        int stableTimer = 0;  // 0 = null
        double summaryAt = 0;
        int quietDowns = 0;
    };

    /// 连接动作排成一队。先把结果交给调用方、再放下一个:TS 里调用方的续跑排在下一个 fn 之前(then 链上多一跳)
    template <class T>
    util::Task<T> serial(std::function<util::Task<T>()> fn) {
        util::Deferred<T> out;
        util::detach(runSerial<T>(std::move(fn), out));
        return out.task();
    }
    template <class T>
    util::Task<> runSerial(std::function<util::Task<T>()> fn, util::Deferred<T> out) {
        const util::Task<> previous = chain_;
        util::Deferred<> mine;
        chain_ = mine.task();
        co_await previous;  // chain_ 里放的永远是"那一个跑完了"(成败都 resolve),不会抛
        std::exception_ptr failure;
        std::optional<T> value;
        try {
            value.emplace(co_await fn());
        } catch (...) {
            failure = std::current_exception();
        }
        if (failure) out.reject(failure);
        else out.resolve(std::move(*value));
        mine.resolve();
    }
    util::Task<> serialVoid(std::function<util::Task<>()> fn);

    util::Task<BrokerConnectResult> connectNow(std::optional<QStringList> names);
    util::Task<> retryBody();
    void ensureTimer();
    void watch(const std::shared_ptr<execution::BrokerRouter>& router);
    void onLink(const QString& name, bool up);
    void announceFlapping(const QString& name);
    void announceLink(const QString& name, bool up);
    QStringList sortedConnectionNames(const QString& provider) const;

    BrokerLinkHost& host_;
    QHash<QString, LinkFlap> flaps_;
    bool wanted_ = false;
    int timer_ = 0;  // 0 = null
    bool retrying_ = false;
    QSet<QString> seen_;
    std::shared_ptr<execution::BrokerRouter> seenRouter_;
    util::Task<> chain_ = util::Task<>::resolved();
    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
};

}  // namespace ibkr::orchestrate
