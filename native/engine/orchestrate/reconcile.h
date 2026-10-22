// engine/reconcile.ts 逐句搬:执行对账——重启 / 重连之后,把券商那边的真相搬回库里。**只认证据,不做推断**:去向不明的单只追加一条状态事件,
// 不落终态(终态不可逆,由用户决定)。"去向不明"这句话必须是**刚问过券商**才说得出口(见 syncExecutions)。
//  ① 券商侧还挂着的 → 重建 orderIndex,重放缓冲里的事件。普通单按 orderRef = 记录 id 认;托管单按 orderRef = signature 认,同一 signature 的多条记录再按单号分
//  ② 券商侧没有、但成交表里找得到成交且数量填满 → 补录成交事件 + 落 filled
//  ③ 其余去向不明的 → 只追加一条状态事件并提醒一次,**不落终态**
// 它自己只管两样状态(上次对账的时刻、上次向券商要成交的时刻);别的从宿主现取。
// 期望值:tests/fixtures/gen_engine_world.mjs(原模块 + 回报落库 + 托管单 + 真交易库,脚本驱动的假 router)。
//
// 与 TS 的对应:router 的可选方法(listOpenOrdersDetailed / coveredAccountIds / executions)用 has* / optional 表示;
// 向券商要东西最多等 10 秒(withTimeout),计时器走 setTimeout 成员(测试换成虚拟钟)。
#pragma once

#include "orchestrate/engine_ports.h"
#include "orchestrate/engine_time.h"
#include "util/notify.h"
#include "util/task.h"

#include <QHash>
#include <QList>
#include <QSet>
#include <QString>
#include <QStringList>

#include <limits>
#include <optional>

namespace ibkr::orchestrate {

class ReconcileRouter {
public:
    virtual ~ReconcileRouter() = default;
    /// typeof router.listOpenOrdersDetailed === "function"
    virtual bool hasListOpenOrdersDetailed() const { return true; }
    virtual util::Task<QList<Rec>> listOpenOrdersDetailed() = 0;
    /// router.coveredAccountIds?.() ?? null:空 = 没这个方法 / 说不清(都当读得到)
    virtual std::optional<QSet<QString>> coveredAccountIds() { return std::nullopt; }
    /// typeof router.executions === "function"(IBKR 的 reqExecutions;测试替身 / 别家券商没有)
    virtual bool hasExecutions() const { return false; }
    virtual util::Task<QList<Rec>> executions() { co_return QList<Rec>{}; }
};

/// 对账这一块要用到的引擎那一面。每次用到都现取,不在构造时存拷贝
class ReconcileHost {
public:
    virtual ~ReconcileHost() = default;
    virtual EngineStore& store() = 0;
    virtual util::Notifier& notifier() = 0;
    virtual ReconcileRouter* router() = 0;  // 空 = 没连券商
    virtual OrderIndex& orderIndex() = 0;
    /// 已经落过终态的记录 id
    virtual QSet<QString>& finalized() = 0;
    /// 已经折进来的成交 exec_id
    virtual QSet<QString>& seenFills() = 0;
    /// 本进程还在盯的条件单(pendingTriggers)的记录 id,每次调用现取
    virtual QStringList pendingTriggerIds() = 0;
    /// 把攒着的、当时认不出记录的回报重放一遍
    virtual void replayUnmatched() = 0;
};

class Reconciler {
public:
    explicit Reconciler(ReconcileHost& host) : host_(host) {}

    static constexpr double kReconcileEveryMs = 60'000;
    /// 刚发出去的单不对账:券商侧的未成交单列表有几百毫秒的滞后,新单会被当成"券商侧没有"
    static constexpr double kReconcileGraceMs = 120'000;
    static constexpr double kReconcileMaxAgeDays = 7;
    /// 向券商要东西(未成交单、当天成交)最多等这么久;不回就这一轮作罢,下一轮再来
    static constexpr int kBrokerTimeoutMs = 10'000;
    /// 向券商要当天成交的最短间隔
    static constexpr double kExecSyncEveryMs = 5 * 60'000;
    /// 对账给"券商侧查不到"的记录打的状态。不是 IBKR 的状态词,也不是终态
    static inline const QString kStatusNotAtBroker = QStringLiteral("NotAtBroker");

    SetTimeout setTimeout = defaultSetTimeout();

    /// 下一轮盯盘就重新对账(接上新会话时调用:券商可能在断线期间成交或撤了单)
    void reconcileSoon();
    bool reconcileDue(double nowMs) const { return nowMs - reconcileAt_ >= kReconcileEveryMs; }
    /// 测试用:内部状态(上次对账的时刻、上次向券商要成交的时刻)
    double reconcileAt() const { return reconcileAt_; }
    double execSyncAt() const { return execSyncAt_; }
    /// 回 {adopted, filled, unknown}
    util::Task<Rec> reconcileOrders(double nowMs);

private:
    /// store.listWorkingRecords 的一行
    struct WorkingRecord {
        QString id, symbol, accountId;
        double quantity = 0, createdAtMs = 0;
        QString lastStatus;
        std::optional<double> lastStatusAtMs;
        QString signature;
    };
    /// ② 的结局:填满了(已落 filled),或者还没有——filled 是成交表里找到的数量,quantity 是这张单的数量
    struct Settled {
        bool filledAll = false;
        double filled = 0, quantity = 0;
    };

    static WorkingRecord workingRecordOf(const Rec& row);
    bool withinGrace(const WorkingRecord& rec, double nowMs) const;
    std::optional<qsizetype> openRowFor(const WorkingRecord& rec, const QList<Rec>& rows, const QHash<QString, QList<qsizetype>>& openByRef, const QSet<qsizetype>& claimed);
    QSet<qint64> knownOrderIds(const QString& recordId);
    bool adoptOpenOrder(const QString& recordId, const Rec& open);
    QList<Rec> fillsOf(const WorkingRecord& rec);
    Settled settleFromFills(const WorkingRecord& rec);
    util::Task<bool> syncExecutions(QList<WorkingRecord> missing, double nowMs);
    bool flagUnreconciled(const WorkingRecord& rec, const Settled& settled);

    ReconcileHost& host_;
    double reconcileAt_ = 0;
    /// 上次向券商要当天成交的时刻。负无穷 = 进程刚起来 / 刚接上新会话,下一轮必须去问
    double execSyncAt_ = -std::numeric_limits<double>::infinity();
};

}  // namespace ibkr::orchestrate
