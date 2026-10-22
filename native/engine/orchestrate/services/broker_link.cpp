#include "orchestrate/services/broker_link.h"

#include "execution/ib_link.h"
#include "orchestrate/services/svc_util.h"
#include "util/js_runtime.h"
#include "util/jsobj.h"

#include <algorithm>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using execution::BrokerError;
using execution::BrokerRouter;
using execution::logStderr;
using util::OJson;
using util::Task;
namespace js = util::js;

OJson BrokerConnectResult::toJson() const {
    OJson failedObj = js::object();
    for (const QString& k : failed.keys()) failedObj.set(k, js::S(failed.value(k)));
    return js::object({{u"provider"_s, js::S(provider)},
                       {u"connected"_s, js::strings(connected)},
                       {u"failed"_s, failedObj},
                       {u"listeners"_s, js::N(listeners)}});
}

BrokerLinkService::BrokerLinkService(BrokerLinkHost& host) : host_(host) {}

BrokerLinkService::~BrokerLinkService() {
    *alive_ = false;
    stop();
}

Task<> BrokerLinkService::serialVoid(std::function<Task<>()> fn) {
    util::Deferred<> out;
    util::detach(([](BrokerLinkService* self, std::function<Task<>()> f, util::Deferred<> o) -> Task<> {
        const Task<> previous = self->chain_;
        util::Deferred<> mine;
        self->chain_ = mine.task();
        co_await previous;
        std::exception_ptr failure;
        try {
            co_await f();
        } catch (...) {
            failure = std::current_exception();
        }
        if (failure) o.reject(failure);
        else o.resolve();
        mine.resolve();
    })(this, std::move(fn), out));
    return out.task();
}

QStringList BrokerLinkService::sortedConnectionNames(const QString& provider) const {
    QStringList names = host_.settings().connectionsFor(provider).keys();
    std::sort(names.begin(), names.end());  // Array.prototype.sort():UTF-16 单元序
    return names;
}

void BrokerLinkService::start() {
    if (!host_.settings().broker.auto_connect) return;
    logStderr(u"[link] 启动即连券商(broker.auto_connect)"_s);
    wanted_ = true;
    ensureTimer();
    util::detach(retryOnce());
}

void BrokerLinkService::stop() {
    if (timer_ != 0) host_.runtime().clearInterval(timer_);
    timer_ = 0;
    for (auto it = flaps_.begin(); it != flaps_.end(); ++it) {
        if (it->stableTimer != 0) host_.runtime().clearTimeout(it->stableTimer);
    }
}

std::shared_ptr<BrokerRouter> BrokerLinkService::makeRouter() {
    if (makeRouterHook) return makeRouterHook();
    if (host_.settings().broker.provider == u"futu") throw util::JsError(u"富途 OpenD 未移植(C++ 引擎只接 IBKR / TWS)"_s);
    return std::make_shared<BrokerRouter>(host_.settings());
}

Task<BrokerConnectResult> BrokerLinkService::connect(std::optional<QStringList> names) {
    return serial<BrokerConnectResult>([this, names] { return connectNow(names); });
}

Task<BrokerConnectResult> BrokerLinkService::connectNow(std::optional<QStringList> names) {
    const QString provider = host_.settings().broker.provider;
    if (auto old = host_.broker(); old && BrokerRouter::kBroker != provider) {
        // 配置里换过券商:旧 router 说的是另一家的协议,先断干净再重建
        co_await old->disconnectAll();
        host_.setBroker(nullptr);
    }
    if (!host_.broker()) host_.setBroker(makeRouter());
    const std::shared_ptr<BrokerRouter> router = host_.broker();
    watch(router);
    BrokerConnectResult result;
    result.provider = provider;
    const QStringList list = names ? *names : sortedConnectionNames(provider);
    for (const QString& name : list) {
        try {
            co_await router->connect(name);
            result.connected.append(name);
            seen_.insert(name);
        } catch (const BrokerError& exc) {
            result.failed.insert(name, exc.message());
        }
    }
    // 夜盘:连上就在后台把期货推算暖起来,免得第一笔速记单拿昨收去推断看涨看跌
    if (!result.connected.isEmpty()) router->warmIndexFutures();
    // 立刻把引擎建起来:节拍器随引擎一起起,盯盘不等界面来第一次请求
    if (!result.connected.isEmpty()) host_.svcEngine();
    host_.dropEngine();  // 让引擎带上 router 重建
    const int attached = host_.svcEngine().attachListeners();
    const OJson detail = js::object({{u"provider"_s, js::S(provider)}, {u"connected"_s, js::strings(result.connected)}, {u"failed"_s, js::strings(result.failed.keys())}});
    host_.svcEngine().store().audit(u"ui"_s, u"broker_connect"_s, &detail);
    wanted_ = true;
    ensureTimer();
    result.listeners = attached;
    co_return result;
}

Task<> BrokerLinkService::disconnect() {
    wanted_ = false;
    return serialVoid([this]() -> Task<> {
        if (auto router = host_.broker()) co_await router->disconnectAll();
        host_.setBroker(nullptr);
        host_.dropEngine();
    });
}

void BrokerLinkService::forget() { wanted_ = false; }

Task<> BrokerLinkService::retryOnce() {
    if (!wanted_ || retrying_) co_return;
    retrying_ = true;
    try {
        co_await retryBody();
    } catch (...) {
        logStderr(u"[link] 自动连接出错:%1"_s.arg(sliceUnits(errMessage(std::current_exception()), 200)));
    }
    retrying_ = false;
}

Task<> BrokerLinkService::retryBody() {
    const std::shared_ptr<BrokerRouter> router = host_.broker();
    const QString provider = host_.settings().broker.provider;
    const QStringList names = sortedConnectionNames(provider);
    if (!router || BrokerRouter::kBroker != provider) {
        const BrokerConnectResult result = co_await serial<BrokerConnectResult>([this, names] { return connectNow(names); });
        if (!result.connected.isEmpty()) logStderr(u"[link] 已连上:%1"_s.arg(result.connected.join(u'、')));
        co_return;
    }
    if (router != seenRouter_) watch(router);
    for (const QString& name : names) {
        if (seen_.contains(name)) continue;
        try {
            // router 上已经挂着 sessionHook(引擎的 attachListeners),新会话的回报监听会自动接上,不用重建引擎
            if (!wanted_ || host_.broker() != router) co_return;  // 排队期间用户点了断开 / 换了 router
            co_await serialVoid([router, name]() -> Task<> { co_await router->connect(name); });
            seen_.insert(name);
            logStderr(u"[link] 已连上:%1"_s.arg(name));
            host_.svcEngine().notifier().notify(u"券商已连上"_s, u"连接 %1 已连上,这条连接上账户的追踪开始盯盘。"_s.arg(name));
            const OJson detail = js::object({{u"connection"_s, js::S(name)}, {u"ok"_s, js::B(true)}});
            host_.svcEngine().store().audit(u"engine"_s, u"broker_link_retry"_s, &detail);
        } catch (const BrokerError&) {
            /* 这条还是连不上:下一轮再试 */
        }
    }
}

void BrokerLinkService::ensureTimer() {
    if (timer_ != 0) return;
    timer_ = host_.runtime().setInterval(kRetryMs, [this, alive = std::weak_ptr<bool>(alive_)] {
        if (alive.expired()) return;
        util::detach(retryOnce());
    });
}

void BrokerLinkService::watch(const std::shared_ptr<BrokerRouter>& router) {
    if (router == seenRouter_) return;
    seenRouter_ = router;
    seen_.clear();
    for (const QString& name : router->connectedNames()) seen_.insert(name);
    router->linkHook = [this, alive = std::weak_ptr<bool>(alive_)](const QString& name, bool up) {
        if (alive.expired()) return;
        onLink(name, up);
    };
}

void BrokerLinkService::onLink(const QString& name, bool up) {
    const double now = util::dateNow();
    LinkFlap& f = flaps_[name];  // 不在就以全空建一条(同 TS 的新对象)
    if (up) {
        f.lastUpAt = now;
        if (!f.flapping) {
            f.downAnnounced = false;
            announceLink(name, true);
            return;
        }
        // 反复断开期间连上了:先不说,撑过 kStableMs 才算真的好了
        if (f.stableTimer != 0) host_.runtime().clearTimeout(f.stableTimer);
        f.stableTimer = host_.runtime().setTimeout(kStableMs, [this, name, alive = std::weak_ptr<bool>(alive_)] {
            if (alive.expired()) return;
            LinkFlap& state = flaps_[name];
            state.stableTimer = 0;
            state.flapping = false;
            state.flaps.clear();
            state.downAnnounced = false;
            logStderr(u"[link] 连接 %1 已稳定连上(反复断开期间又断了 %2 次)"_s.arg(name, QString::number(state.quietDowns)));
            state.quietDowns = 0;
            announceLink(name, true);
        });
        return;
    }
    if (f.stableTimer != 0) {
        host_.runtime().clearTimeout(f.stableTimer);
        f.stableTimer = 0;
    }
    if (f.lastUpAt && now - *f.lastUpAt < kStableMs) f.flaps.append(now);
    {
        QList<double> kept;
        for (double t : f.flaps) {
            if (now - t < 60'000) kept.append(t);
        }
        f.flaps = kept;
    }
    if (f.flapping) {
        f.quietDowns += 1;
        if (now - f.summaryAt >= 60'000) {
            f.summaryAt = now;
            logStderr(u"[link] 连接 %1 仍在反复断开(提醒过之后又断了 %2 次)"_s.arg(name, QString::number(f.quietDowns)));
        }
        return;
    }
    if (f.flaps.size() >= kFlapCount) {
        f.flapping = true;
        f.summaryAt = now;
        f.quietDowns = 0;
        announceFlapping(name);
        return;
    }
    if (f.downAnnounced) return;
    f.downAnnounced = true;
    announceLink(name, false);
}

void BrokerLinkService::announceFlapping(const QString& name) {
    logStderr(u"[link] 连接 %1 反复断开:TWS 接受了连接又马上断开,之后不再逐次记录"_s.arg(name));
    try {
        SvcEngine& engine = host_.svcEngine();
        const OJson detail = js::object({{u"connection"_s, js::S(name)}});
        engine.store().audit(u"engine"_s, u"broker_link_flapping"_s, &detail);
        engine.notifier().warning(
            u"与 TWS 的连接 %1 反复断开:连上几毫秒就被断开,正在每 5 秒重试(之后不再逐次提醒)。"_s.arg(name) +
            u"常见原因:TWS 自动重启后在等重新登录、TWS 弹出了 API 连接确认框、同一个 client id 被别的程序占用。"_s +
            u"请先看一眼 TWS 窗口。断开期间追踪读不到持仓与报价,不会判断、也不会发单;托管到券商的止盈止损单不受影响。"_s);
        host_.emitEvent(u"broker_link"_s, js::object({{u"connection"_s, js::S(name)}, {u"up"_s, js::B(false)}}));
    } catch (...) {
        /* 提醒失败不影响重连本身 */
    }
}

void BrokerLinkService::announceLink(const QString& name, bool up) {
    logStderr(u"[link] 连接 %1 %2"_s.arg(name, up ? u"已自动重连"_s : u"断开,正在自动重连"_s));
    try {
        SvcEngine& engine = host_.svcEngine();
        const OJson detail = js::object({{u"connection"_s, js::S(name)}});
        engine.store().audit(u"engine"_s, up ? u"broker_link_up"_s : u"broker_link_down"_s, &detail);
        if (up) {
            engine.reconcileSoon();  // 断线期间单子可能成交或被撤了:下一轮就对账,不等满一分钟
            engine.notifier().notify(u"券商已重新连上"_s, u"连接 %1 已自动重连,追踪恢复盯盘。"_s.arg(name));
        } else {
            engine.notifier().warning(
                u"与 TWS 的连接 %1 断开了,正在自动重连。断开期间这条连接上的追踪读不到持仓与报价,"_s.arg(name) +
                u"不会判断、也不会发单;托管到券商的止盈止损单不受影响。"_s);
        }
        host_.emitEvent(u"broker_link"_s, js::object({{u"connection"_s, js::S(name)}, {u"up"_s, js::B(up)}}));
    } catch (...) {
        /* 提醒失败不影响重连本身 */
    }
}

}  // namespace ibkr::orchestrate
