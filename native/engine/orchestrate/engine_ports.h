// engine-ts/src/engine/*.ts 这一批子模块(托管单、执行对账、回报落库、盯盘守卫、出场状态、账户风控、时段……)共用的"端口":
// 它们在 TS 里拿到的 `host`(= TradingEngine 自己)与 router,在 C++ 里是下面这些小的抽象类。engine.ts 的搬运者把它们实现一遍,
// 测试(tests/engine_world.h)实现另一遍。每个模块自己的宿主接口在它自己的头文件里(HostedHost、ReconcileHost、CallbackHost……),
// 这里放的是几个模块都要的东西:
//   · EngineStore:模块用到的那十几个交易库方法(TradeStore 是具体类,调用顺序要能被记录,所以隔一层);makeStorePort 把真的 TradeStore 包上。
//   · BreakerPort:熔断开关用到的三个方法,makeBreakerPort 把真的 KillSwitch 包上。
//   · 券商单号的几张账(orderIndex / sentOrders / earlyOrderErrors)的类型。
//   · JS 取值的几个小函数(`x ?? 0`、Number(x) 的组合)。
// 通知器(util::Notifier)是具体类,不隔:测试给它挂 sink 就能按调用先后记下来。
//
// 约定:TS 里 `Rec = Record<string, any>` 在这里是 OJson(键序同 JS);指针为空 = undefined。
#pragma once

#include "util/ordered_json.h"
#include "util/jsobj.h"
#include "util/killswitch.h"
#include "util/task.h"

#include <QHash>
#include <QList>
#include <QSet>
#include <QString>

#include <exception>
#include <memory>
#include <optional>

namespace ibkr::domain {
class TradeStore;
}

namespace ibkr::orchestrate {

using Rec = util::OJson;

/// 交易库里这些模块用到的方法(参数与返回同 domain::TradeStore)。risk 那两个查询(workingOrders / dailyLossTrips)
/// 在 TS 里是 `store.risk.xxx`,这里拍平成同名方法。
class EngineStore {
public:
    virtual ~EngineStore() = default;
    virtual QList<Rec> listTracks() = 0;
    virtual std::optional<Rec> getTrack(const QString& trackId) = 0;
    virtual bool updateTrack(const QString& trackId, const Rec& fields) = 0;
    /// detail 空 = 不给(库里写 {})
    virtual void audit(const QString& actor, const QString& action, const Rec* detail) = 0;
    /// 同 TS:会改调用方的 record(补上 id 与 created_at)
    virtual QString createRecord(Rec& record) = 0;
    virtual void markSubmitIntent(const QString& recordId) = 0;
    virtual void appendEvent(const QString& recordId, const QString& kind, const Rec& payload) = 0;
    virtual void setFinalStatus(const QString& recordId, const QString& status, const std::optional<QString>& errorDetail) = 0;
    virtual std::optional<Rec> getRecord(const QString& recordId) = 0;
    /// {id, symbol, accountId, quantity, createdAtMs, lastStatus, lastStatusAtMs, signature}
    virtual QList<Rec> listWorkingRecords(double maxAgeDays, double nowMs) = 0;
    virtual QList<Rec> fillsByOrderRef(const QString& orderRef) = 0;
    virtual double rememberFills(const QList<Rec>& rows) = 0;
    /// store.risk.workingOrders:{alias, contract, order, notional, …}
    virtual QList<Rec> workingOrders(double sinceMs, double nowMs) = 0;
    /// store.risk.dailyLossTrips:{alias, reason, untilMs}
    virtual QList<Rec> dailyLossTrips(double sinceMs, double nowMs) = 0;

    // ---- 小便利(不是虚函数)
    void audit(const QString& actor, const QString& action, const Rec& detail) { audit(actor, action, &detail); }
};

/// 真库的端口。store 要活得比端口长
std::unique_ptr<EngineStore> makeStorePort(domain::TradeStore& store);

/// 熔断开关:引擎只读它合没合上(合上与解除是手动的,走 halt / resume)
class BreakerPort {
public:
    virtual ~BreakerPort() = default;
    virtual util::BreakerState state() = 0;
};
std::unique_ptr<BreakerPort> makeBreakerPort(util::KillSwitch& killSwitch);

/// 本会话自己对一张单做过的最近一个动作(engine/callbacks.ts 的 SentOrder)
struct SentOrder {
    enum class Kind { Place, Modify, Cancel };
    double at = 0;  // 毫秒
    Kind kind = Kind::Place;
};
/// 券商 orderId / permId → 记录 id(JS 的 Map<number, string>,键是 Number(id))
using OrderIndex = QHash<qint64, QString>;
using SentOrders = QHash<qint64, SentOrder>;
/// 比 placeOrder 返回还早到的订单错误:[错误码, 原文, 时刻]
struct EarlyOrderError {
    int code = 0;
    QString message;
    double at = 0;
};
using EarlyOrderErrors = QHash<qint64, EarlyOrderError>;

namespace jsx {

/// TS 的 `String((exc as Error).message)`:JsError 取 message(),别的 std::exception 取 what(),都不是回空串
QString errorMessage(std::exception_ptr e);

/// `v ?? fallback` 之后 Number():v 是 null / undefined 取 fallback
inline double numOr(const util::OJson* v, double fallback) { return util::js::nullish(v) ? fallback : util::js::num(v); }
/// Math.trunc(x)(NaN 原样)
double trunc(double x);
/// Math.max(a, b) / Math.min(a, b):有一边是 NaN 就是 NaN(std::max / std::fmax 不是)
double max(double a, double b);
double min(double a, double b);
/// `Math.trunc(Number(v)) || null`:0 与 NaN 是空(callbacks / reconcile 的 idOf)
std::optional<qint64> idOf(const util::OJson* v);
/// Math.trunc(Number(v ?? 0))
inline double truncNumOr0(const util::OJson* v) { return trunc(numOr(v, 0)); }
/// 把 `{...a, ...b}` 的 b 并进 a(同 Object.assign;已有的键位置不动)
void assign(util::OJson& target, const util::OJson& source);
/// obj[key] = value
inline void set(util::OJson& obj, const QString& key, const util::OJson& value) { obj.set(key, value); }

}  // namespace jsx

}  // namespace ibkr::orchestrate
