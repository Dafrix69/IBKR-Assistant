// engine/callbacks.ts 逐句搬:券商回报 → 落库(§6 status_timeline / fills)。搬的是**回报进来之后怎么落库**;
// 怎么把回调挂上去(wireSession / attachListeners)、以及下单侧要用的 indexPlacement / brokerCode 留在 engine.ts。
// 期望值:tests/fixtures/gen_engine_world.mjs(原模块 + 托管单 + 对账 + 真交易库,脚本驱动的假 router,先后次序一并记下)。
//
// 三条纪律写在代码里:成交与佣金按 exec_id 只落第一条(券商会重推,翻倍就是账不平);认不出记录的回报先攒着(unmatchedEvents),
// 等 orderIndex 建好再重放;错误通道上的一条错误只带 reqId,宣判一张单之前先问清它是不是冲这张单来的(onIbError)。
//
// 与 TS 的对应:
//   · trade / fill / report 是 TS 的 any——会话回调给的就是 OJson(execution/ib_types.h 的 onOrderStatus / onFill / onCommission),这里照收;
//     取值照 JS 的松散读法(缺了是 undefined、Number() 转换)。
//   · onIbError 的三个参数是 `unknown`:OJson(Number(reqId)、String(errorString ?? "") 的转换照 JS)。
//   · TERMINAL_IB_STATUS 等 TS 里的"普通对象查表"遇到 JS 原型键("constructor"、"toString")会取到原型上的函数;C++ 精确查表,
//     状态词来自 IB 的固定枚举,进不来。
//   · sentOrders 是可选的(宿主没接发单账本 = undefined = 旧口径:认得出记录就算),用 sentOrders() 返回空指针表示。
#pragma once

#include "orchestrate/engine_ports.h"
#include "util/notify.h"

#include <QHash>
#include <QSet>
#include <QString>

#include <deque>

namespace ibkr::orchestrate {

/// 托管单那一路,错误与状态回报都要先过它一手(hosted.h 的 HostedOrders 即符合)。这里只写回报用得着的那两只手,两块互不认识
class CallbackHostedOrders {
public:
    virtual ~CallbackHostedOrders() = default;
    virtual bool handleError(qint64 orderId, int code, const QString& message) = 0;
    virtual void onStatus(const Rec& trade) = 0;
};

/// 认不出记录的回报:[kind, trade, fill, report]
struct UnmatchedEvent {
    QString kind;
    Rec trade, fill, report;
};

/// 回报落库这一块要用到的引擎那一面。每次用到都现取,不在构造时存拷贝
class CallbackHost {
public:
    virtual ~CallbackHost() = default;
    virtual EngineStore& store() = 0;
    virtual util::Notifier& notifier() = 0;
    virtual OrderIndex& orderIndex() = 0;
    virtual QSet<QString>& finalized() = 0;
    virtual QSet<QString>& seenFills() = 0;
    virtual QSet<QString>& seenCommissions() = 0;
    virtual std::deque<UnmatchedEvent>& unmatchedEvents() = 0;
    virtual EarlyOrderErrors& earlyOrderErrors() = 0;
    virtual CallbackHostedOrders& hostedOrders() = 0;
    /// 追价中的平仓单:orderId → track_id。只读一下在不在
    virtual const QHash<qint64, QString>& closeChaseIndex() = 0;
    virtual void closeChaseOnStatus(const Rec& trade) = 0;
    /// 追价平仓单的改价被拒:把追价缓存里的限价恢复成上一次被券商接受的那一版(TS 里是可选方法;没实现就只提醒)
    virtual bool hasCloseChaseModifyRejected() const { return false; }
    virtual void closeChaseModifyRejected(qint64 orderId) { (void)orderId; }
    /// 本会话自己发出过的订单账。空 = 宿主还没接这本账(旧口径:认得出记录就算)
    virtual const SentOrders* sentOrders() = 0;
};

class IbCallbacks {
public:
    explicit IbCallbacks(CallbackHost& host) : host_(host) {}

    /// 对账重建 orderIndex 之后要把攒着的回报重放一遍
    void replayUnmatched();
    /// 订单级 errorEvent → 终态落库(110 价格档位、201 保证金、203 无权限只走这条路)
    void onIbError(const Rec& reqId, const Rec& errorCode, const Rec& errorString);
    void onOrderStatus(const Rec& trade);
    void onExecDetails(const Rec& trade, const Rec& fill);
    void onCommission(const Rec& trade, const Rec& fill, const Rec& report);

private:
    void stashUnmatched(const QString& kind, const Rec& trade, const Rec& fill = Rec::null(), const Rec& report = Rec::null());
    bool mayConcernOrder(qint64 req, int code);
    bool sentRecently(qint64 req);
    bool refusesRequestOnly(const QString& recordId, int code);
    void warnChaseRefused(qint64 orderId, int code, const QString& message);
    std::optional<QString> recordFor(const Rec& trade);

    CallbackHost& host_;
    QHash<qint64, double> chaseRefusalNotifiedAt_;
};

}  // namespace ibkr::orchestrate
