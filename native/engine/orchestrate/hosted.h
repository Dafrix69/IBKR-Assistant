// engine/hosted.ts 逐句搬:券商托管的止盈 / 止损单——对账循环、认领、挂 / 改 / 撤,以及回报进来时的处置。
// 软件盯盘怕的三件事(轮询漏插针、软件必须开着、我们这头行情延迟)托管单都不怕:触发发生在券商服务器的实时行情上。所以这一块的纪律是**宁可不挂,不可挂错**。
// 它自己管四样状态(hosted / hostedIndex / hostedRetryAt / hostedAdopted,另有 lastCovered 与 synced);别的一律从宿主现取——配置会重载、券商会重连,存一份拷贝就会过期。
// 期望值:tests/fixtures/gen_engine_world.mjs(原模块 + 回报落库 + 对账 + 真交易库与熔断开关,脚本驱动的假 router,调用的先后次序一并记下)。
//
// 与 TS 的对应与不同(交付报告里有同样的一份):
//   · 缓存里的每张单是 JS 对象(Rec = OJson),**按引用共享**:syncHosted 手里的 `current`(一个 Map)与 `cur`(一条单)在 await 券商的空档里,回报可以
//     把它们从 this.hosted 里摘掉(dropHostedEntry 在空了时 hosted.delete(tid)),手里的引用照样活着、之后照样被读被改——所以内层的 Map 与每条单都是 shared_ptr,
//     摘掉只是放手,不是销毁。placeHostedOne 在 hosted 里没有这条追踪时新建一个 Map,syncHosted 手里的旧 Map 与它是两个对象(TS 原样)。
//   · router / 宿主的可选方法:TS 的 `typeof x === "function"` 在这里是 has* / 返回 optional。
//   · 参数一律按值进协程(协程帧里的引用会悬空)。
//   · HOSTED_FIRED_STATE / COVERING / HOSTED_LABELS 是 TS 的普通对象查表,键遇到 JS 原型名("constructor")会取到原型上的东西;C++ 精确查表,键来自固定枚举,进不来。
//   · ContractSpecSchema.parse 在 closeContractIssue 通过之后不可能失败(同一个函数、同一份 schema),所以那一步失败的话只抛一句 JsError(TS 抛 ZodError)。
#pragma once

#include "contract/config_types.h"
#include "contract/ordered_map.h"
#include "domain/config.h"
#include "execution/broker.h"
#include "orchestrate/callbacks.h"
#include "orchestrate/engine_ports.h"
#include "orchestrate/engine_time.h"
#include "orchestrate/exits.h"
#include "orchestrate/tracker.h"
#include "util/error.h"
#include "util/notify.h"
#include "util/task.h"

#include <QHash>
#include <QList>
#include <QSet>
#include <QString>

#include <memory>
#include <optional>

namespace ibkr::orchestrate {

/// 托管单拼不出来(我们这头的错,比如结构没法反转成一张合法的平仓单)。不算券商失败、不计入熔断
class HostedPlanError : public util::JsError {
public:
    using util::JsError::JsError;
};

/// 托管单要用到的 router 面(BrokerRouter 即符合,见 broker_ports.h 的适配)。富途没有可同形托管的 GTC+OCA,不移植
class HostedRouter {
public:
    virtual ~HostedRouter() = default;
    /// SUPPORTS_HOSTED_CLOSE
    virtual bool supportsHostedClose() const = 0;
    /// router.coveredAccounts?.() ?? null:空 = 没这个方法 / 说不清(都当读得到)
    virtual std::optional<QSet<QString>> coveredAccounts() { return std::nullopt; }
    virtual util::Task<QList<Rec>> positions() = 0;
    /// typeof router.listHostedOpen === "function"
    virtual bool hasListHostedOpen() const { return true; }
    virtual util::Task<QList<Rec>> listHostedOpen() = 0;
    virtual util::Task<execution::HostedPlacement> placeHosted(contract::AccountConfig account, Rec contractSpec, Rec item, QString ocaGroup, QString orderRef) = 0;
    virtual util::Task<bool> modifyHosted(qint64 orderId, Rec item) = 0;
    virtual util::Task<bool> cancelHosted(qint64 orderId) = 0;
};

/// applySpotTarget 的结果:[targets, spotTarget | null, hold]
struct SpotTargetResult {
    Rec targets;
    std::optional<Rec> spotTarget;
    bool hold = false;
};
/// chaseQuote 的结果 {natural, limit, floor}(键序就是这个)
struct ChaseQuote {
    double natural = 0, limit = 0, floor = 0;
};

/// 托管单这一块要用到的引擎那一面。每次用到都现取,不在构造时存拷贝
class HostedHost {
public:
    virtual ~HostedHost() = default;
    virtual EngineStore& store() = 0;
    virtual util::Notifier& notifier() = 0;
    virtual BreakerPort& killswitch() = 0;
    virtual const domain::Settings& settings() const = 0;
    virtual HostedRouter* router() = 0;  // 空 = 没连券商
    /// 券商 orderId / permId → 记录 id
    virtual OrderIndex& orderIndex() = 0;
    /// 比 placeOrder 返回还早到的订单错误
    virtual EarlyOrderErrors& earlyOrderErrors() = 0;
    /// 本会话对哪个单号做过什么、什么时候
    virtual SentOrders& sentOrders() = 0;
    virtual bool accountIsPaper(const QString& alias) = 0;
    virtual util::Task<SpotTargetResult> applySpotTarget(Rec track, Rec raw, tracker::Position position, Rec targets, Rec positions, domain::EtNow at) = 0;
    /// reason 空 = null。拿不到腿的买卖价回空
    virtual util::Task<std::optional<ChaseQuote>> chaseQuote(Rec raw, tracker::Position position, Rec positions, Rec autoClose, std::optional<double> prev, double rounds,
                                                             std::optional<QString> reason) = 0;
    /// 推峰值用的价
    virtual TrackExits& exits() = 0;
    /// entry 是缓存里那条托管单(就地写 warned)
    virtual void chaseWarnIfStuck(const Rec& track, Rec& entry, double limit, double natural) = 0;
    /// 这一轮是推送提前叫醒的(orchestrate/fast_exit):峰值不推、追价照改但轮数不数、离上次改价不够一个间隔不改
    virtual bool earlyTick() const = 0;
    virtual Rec baseRecord(const QString& instruction, const QString& channel) = 0;
    virtual void onIbError(const Rec& reqId, const Rec& errorCode, const Rec& errorString) = 0;
};

class HostedOrders final : public CallbackHostedOrders {
public:
    explicit HostedOrders(HostedHost& host) : host_(host) {}

    /// Promise.race 的 10 秒计时器(认领未成交单列表);测试换成虚拟钟
    SetTimeout setTimeout = defaultSetTimeout();

    /// 这条追踪的止盈单(界面要显示上一轮追到的价);没有就是空指针
    std::shared_ptr<Rec> tpEntry(const QString& trackId) const;
    /// 这个 orderId 是不是托管单的;是就交给 onError 处理
    bool handleError(qint64 orderId, int code, const QString& message) override;
    /// 这条追踪此刻在券商侧挂着哪几种托管单(tp / sl / trail / ptrail),按挂上的先后
    QSet<QString> liveKinds(const QString& trackId) const;
    /// 手动「立即平仓」:这条追踪的退避一律作废
    void clearBackoff(const QString& trackId);
    /// 熔断撤了全部单:缓存跟着清
    void clear();

    /// 把"追踪设置"和"券商侧挂着的托管单"对齐(挂缺的、改变了的、撤多余的)。rows 空 = 自己向 router 读持仓(并自己算一轮)。
    /// 回 {hosted, blocked, quote_maybe_delayed}
    util::Task<Rec> syncHosted(std::optional<QList<Rec>> rows = std::nullopt);

    struct TriggeredArgs {
        Rec track, raw;
        tracker::Position position;
        QString state, reason;
        bool spotReached = false;
        /// 这次触发是标的止损价:券商侧没有任何单看标的,一定要追价
        bool spotStop = false;
    };
    /// 托管的追踪在盯盘里判到了触发:交给券商侧那张单,还是改成追价平仓。row 与 out(TrackerPollTick)原地改:out 要有 fired / blocked 两个数组
    void onTriggered(const TriggeredArgs& args, Rec& row, Rec& out);

    /// 托管单收到订单级错误:**在这一刻就定**,依据是我们刚对这张单做了什么
    void onError(qint64 orderId, int code, const QString& message);
    /// 托管单的终态处理:成交 → 追踪落闩;撤销 → 丢缓存。trade 是会话回调给的 OJson
    void onStatus(const Rec& trade) override;

    /// 触发状态 → 给人看的名字(追价平仓那一路也读它);不认识回空(TS 的 undefined)
    static std::optional<QString> stateLabel(const QString& state);

    /// 测试用:内部状态的样子(hosted 的每条单、hostedIndex、hostedRetryAt、synced、hostedAdopted、lastCovered),键排序
    Rec snapshot() const;

private:
    using EntryPtr = std::shared_ptr<Rec>;
    struct KindMap {
        contract::OrderedMap<EntryPtr> entries;
    };
    using KindMapPtr = std::shared_ptr<KindMap>;
    struct Retry {
        double at = 0;
        QString reason;
        bool warn = false;
    };

    bool stillHosting(const QString& tid);
    Rec hostedRows(const QString& tid) const;
    util::Task<> adoptHosted();
    util::Task<> placeHostedOne(Rec track, Rec item, QString oca);
    util::Task<> modifyHostedOne(Rec track, EntryPtr current, Rec item);
    util::Task<> cancelHostedTrack(QString trackId, QString reason);
    util::Task<> cancelHostedOne(QString trackId, QString kind, QString reason);
    void dropHostedEntry(const QString& trackId, const QString& kind);
    EntryPtr entryOf(const QString& tid, const QString& kind) const;

    HostedHost& host_;
    /// track_id → kind → 挂在券商侧的那张单
    contract::OrderedMap<KindMapPtr> hosted_;
    /// 券商 orderId → [track_id, kind]
    QHash<qint64, std::pair<QString, QString>> hostedIndex_;
    bool hostedAdopted_ = false;
    /// 上一轮读得到的账户(router 说不清就是空)。多出一个账户就重新认领
    std::optional<QSet<QString>> lastCovered_;
    /// 对账已经替它排过单的追踪(过了闸门、算过计划)
    QSet<QString> synced_;
    /// 被券商拒掉的:track_id|kind → {到期时刻, 原因}。退避期内不重挂也不再改价
    QHash<QString, Retry> hostedRetryAt_;
    /// 追价改成的止盈单上一次改价的时刻(track_id → 毫秒):提前醒的那一轮守改价间隔用。不放进缓存项(缓存项的样子对着 TS 比)
    QHash<QString, double> chaseAt_;
};

}  // namespace ibkr::orchestrate
