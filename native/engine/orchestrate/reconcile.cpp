#include "orchestrate/reconcile.h"

#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/market_js.h"

#include <cmath>
#include <vector>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::orchestrate {

namespace {

QString n(double v) { return util::jsNumberToString(v); }

/// 托管单的记录:signature 就是它在券商那边的 orderRef(`trk:<追踪>:<单型>`),不是记录 id
bool isHosted(const QString& signature) { return signature.startsWith(u"trk:"_s); }

/// Number(v) || 0
double numOr0(const OJson* v) {
    const double x = js::num(v);
    return std::isnan(x) || x == 0 ? 0 : x;
}

}  // namespace

void Reconciler::reconcileSoon() {
    reconcileAt_ = 0;
    execSyncAt_ = -std::numeric_limits<double>::infinity();
}

Reconciler::WorkingRecord Reconciler::workingRecordOf(const Rec& row) {
    WorkingRecord w;
    w.id = js::strOr(js::prop(&row, u"id"_s), QString());
    w.symbol = js::strOr(js::prop(&row, u"symbol"_s), QString());
    w.accountId = js::strOr(js::prop(&row, u"accountId"_s), QString());
    w.quantity = js::num(js::prop(&row, u"quantity"_s));
    w.createdAtMs = js::num(js::prop(&row, u"createdAtMs"_s));
    w.lastStatus = js::strOr(js::prop(&row, u"lastStatus"_s), QString());
    const OJson* at = js::prop(&row, u"lastStatusAtMs"_s);
    if (!js::nullish(at)) w.lastStatusAtMs = js::num(at);
    w.signature = js::strOr(js::prop(&row, u"signature"_s), QString());
    return w;
}

util::Task<Rec> Reconciler::reconcileOrders(double nowMs) {
    double adopted = 0, filled = 0, unknown = 0;
    const auto result = [&] {
        return js::object({{u"adopted"_s, js::N(adopted)}, {u"filled"_s, js::N(filled)}, {u"unknown"_s, js::N(unknown)}});
    };
    ReconcileRouter* router = host_.router();
    if (!router || !router->hasListOpenOrdersDetailed()) co_return result();
    reconcileAt_ = nowMs;
    // 等券商回话**之前**先记下本进程还在盯的条件单。等的那几百毫秒里条件单可能触发、发出、从队列里摘掉,
    // 而券商这次给的列表是发单之前的——拿发单之后的队列判,它就成了"券商侧没有"
    const QStringList pendingList = host_.pendingTriggerIds();
    const QSet<QString> pendingAtStart(pendingList.begin(), pendingList.end());
    QList<Rec> rows;
    try {
        rows = co_await withTimeout<QList<Rec>>(router->listOpenOrdersDetailed(), kBrokerTimeoutMs, u"券商的未成交单列表"_s, setTimeout);
    } catch (...) {
        // 下一轮再试;这里失败不该影响盯盘
        host_.store().audit(u"engine"_s, u"reconcile_failed"_s, js::object({{u"error"_s, js::S(jsx::errorMessage(std::current_exception()).left(300))}}));
        co_return result();
    }
    QHash<QString, QList<qsizetype>> openByRef;
    for (qsizetype i = 0; i < rows.size(); ++i) {
        const QString ref = js::strOr(js::prop(&rows[i], u"order_ref"_s), QString());
        if (ref.isEmpty()) continue;
        openByRef[ref].append(i);
    }
    QList<WorkingRecord> working;
    for (const Rec& r : host_.store().listWorkingRecords(kReconcileMaxAgeDays, nowMs)) working.append(workingRecordOf(r));
    // 此刻读得到的账户号(router 说不清就是空 = 都当读得到)。会话断着 / 没连上的账户,券商侧的未成交单根本没读到——
    // "券商侧没有"是假的,不能拿它下"去向不明"的结论
    const std::optional<QSet<QString>> covered = router->coveredAccountIds();
    QSet<qsizetype> claimed;
    QList<WorkingRecord> missing;
    for (const WorkingRecord& rec : working) {
        const std::optional<qsizetype> open = openRowFor(rec, rows, openByRef, claimed);
        if (open) {
            claimed.insert(*open);
            if (adoptOpenOrder(rec.id, rows[*open])) adopted += 1;
            continue;
        }
        if (covered && !rec.accountId.isEmpty() && !covered->contains(rec.accountId)) continue;
        // 本进程还在盯的条件单没发到券商,不算失联;刚发出去的单也给券商一点滞后余量
        if (pendingAtStart.contains(rec.id) || host_.pendingTriggerIds().contains(rec.id)) continue;
        if (withinGrace(rec, nowMs)) continue;
        if (settleFromFills(rec).filledAll) filled += 1;
        else missing.append(rec);
    }
    // ③ 之前先问一遍券商当天的成交:本地成交表只有交易分析同步过才有,不问就说"没查到它的成交"是假话
    if (!missing.isEmpty() && (co_await syncExecutions(missing, nowMs))) {
        for (const WorkingRecord& rec : missing) {
            const Settled settled = settleFromFills(rec);
            if (settled.filledAll) filled += 1;
            else if (flagUnreconciled(rec, settled)) unknown += 1;
        }
    }
    host_.replayUnmatched();
    if (adopted != 0 || filled != 0 || unknown != 0) {
        const Rec detail = result();
        host_.store().audit(u"engine"_s, u"reconciled"_s, &detail);
    }
    co_return result();
}

bool Reconciler::withinGrace(const WorkingRecord& rec, double nowMs) const {
    // 宽限期从"最后一次可能把单子发出去"算:记录创建、或最后一条状态回报,取晚的那个。
    // 晚于这一轮 now 的状态回报不作数:那是等券商回话时落的,pendingAtStart 已经兜住;时钟不对的更不能拿来算
    const double statusAt = rec.lastStatusAtMs && *rec.lastStatusAtMs <= nowMs ? *rec.lastStatusAtMs : rec.createdAtMs;
    return nowMs - jsx::max(rec.createdAtMs, statusAt) < kReconcileGraceMs;
}

QSet<qint64> Reconciler::knownOrderIds(const QString& recordId) {
    const std::optional<Rec> record = host_.store().getRecord(recordId);
    const OJson* ibkr = record ? js::prop(&*record, u"ibkr"_s) : nullptr;
    QSet<qint64> ids;
    for (const QString& key : {u"order_id"_s, u"perm_id"_s}) {
        const auto id = jsx::idOf(js::nullish(ibkr) ? nullptr : js::prop(ibkr, key));
        if (id) ids.insert(*id);
    }
    return ids;
}

std::optional<qsizetype> Reconciler::openRowFor(const WorkingRecord& rec, const QList<Rec>& rows, const QHash<QString, QList<qsizetype>>& openByRef,
                                                const QSet<qsizetype>& claimed) {
    for (const qsizetype i : openByRef.value(rec.id)) {
        if (!claimed.contains(i)) return i;
    }
    if (!isHosted(rec.signature)) return std::nullopt;
    QList<qsizetype> candidates;
    for (const qsizetype i : openByRef.value(rec.signature)) {
        if (!claimed.contains(i)) candidates.append(i);
    }
    if (candidates.isEmpty()) return std::nullopt;
    const QSet<qint64> ids = knownOrderIds(rec.id);
    if (!ids.isEmpty()) {
        for (const qsizetype i : candidates) {
            if (ids.contains(jsx::idOf(js::prop(&rows[i], u"order_id"_s)).value_or(-1)) || ids.contains(jsx::idOf(js::prop(&rows[i], u"perm_id"_s)).value_or(-1))) return i;
        }
        return std::nullopt;
    }
    std::vector<qsizetype> sorted(candidates.begin(), candidates.end());
    util::market::jsSort(sorted, [&](qsizetype a, qsizetype b) {
        return static_cast<double>(jsx::idOf(js::prop(&rows[b], u"order_id"_s)).value_or(0)) - static_cast<double>(jsx::idOf(js::prop(&rows[a], u"order_id"_s)).value_or(0));
    });
    return sorted.front();
}

bool Reconciler::adoptOpenOrder(const QString& recordId, const Rec& open) {
    const auto orderId = jsx::idOf(js::prop(&open, u"order_id"_s));
    const auto permId = jsx::idOf(js::prop(&open, u"perm_id"_s));
    const bool known = (orderId && host_.orderIndex().contains(*orderId)) || (permId && host_.orderIndex().contains(*permId));
    if (orderId) host_.orderIndex().insert(*orderId, recordId);
    if (permId) host_.orderIndex().insert(*permId, recordId);
    if (known) return false;
    const QString status = js::strOr(js::prop(&open, u"status"_s), QString());
    host_.store().appendEvent(recordId, u"status"_s,
                              js::object({{u"status"_s, js::S(status.isEmpty() ? u"Submitted"_s : status)},
                                          {u"source"_s, js::S(u"reconcile"_s)},
                                          {u"order_id"_s, orderId ? js::N(static_cast<double>(*orderId)) : js::Null()},
                                          {u"perm_id"_s, permId ? js::N(static_cast<double>(*permId)) : js::Null()}}));
    const OJson* openStatus = js::prop(&open, u"status"_s);
    host_.store().audit(u"engine"_s, u"reconcile_adopted"_s,
                        js::object({{u"record"_s, js::S(recordId)},
                                    {u"order_id"_s, orderId ? js::N(static_cast<double>(*orderId)) : js::Null()},
                                    {u"status"_s, js::nullish(openStatus) ? js::S(QString()) : *openStatus}}));
    return true;
}

QList<Rec> Reconciler::fillsOf(const WorkingRecord& rec) {
    if (!isHosted(rec.signature)) return host_.store().fillsByOrderRef(rec.id);
    const QSet<qint64> ids = knownOrderIds(rec.id);
    if (ids.isEmpty()) return {};
    QList<Rec> out;
    for (const Rec& f : host_.store().fillsByOrderRef(rec.signature)) {
        if (ids.contains(jsx::idOf(js::prop(&f, u"order_id"_s)).value_or(-1)) || ids.contains(jsx::idOf(js::prop(&f, u"perm_id"_s)).value_or(-1))) out.append(f);
    }
    return out;
}

Reconciler::Settled Reconciler::settleFromFills(const WorkingRecord& rec) {
    const QList<Rec> fills = fillsOf(rec);
    if (fills.isEmpty()) return Settled{false, 0, rec.quantity};
    const auto secTypeOf = [](const Rec& f) {
        const OJson* c = js::prop(&f, u"contract"_s);
        return js::strOr(js::nullish(c) ? nullptr : js::prop(c, u"secType"_s), QString());
    };
    bool isBag = false;
    for (const Rec& f : fills) isBag = isBag || secTypeOf(f) == u"BAG";
    double filledQty = 0;
    for (const Rec& f : fills) {
        if (isBag && secTypeOf(f) != u"BAG") continue;
        filledQty += numOr0(js::prop(&f, u"shares"_s));
    }
    const std::optional<Rec> record = host_.store().getRecord(rec.id);
    // 回报认不出记录时被丢掉的成交,这里按 exec_id 补录(读侧还会再去一次重,见 foldEvents)
    QSet<QString> known;
    if (const OJson* recFills = record ? js::path(&*record, {u"ibkr"_s, u"fills"_s}) : nullptr; js::isArr(recFills)) {
        for (const Rec& f : recFills->items) known.insert(js::strOr(js::prop(&f, u"exec_id"_s), QString()));
    }
    for (const Rec& fill : fills) {
        const QString execId = js::strOr(js::prop(&fill, u"exec_id"_s), QString());
        if (execId.isEmpty() || known.contains(execId)) continue;
        const OJson* c = js::prop(&fill, u"contract"_s);
        const OJson* contract = js::nullish(c) ? nullptr : c;
        const QString secType = js::strOr(js::prop(contract, u"secType"_s), QString());
        const auto conId = jsx::idOf(js::prop(contract, u"conId"_s));
        host_.store().appendEvent(rec.id, u"fill"_s,
                                  js::object({{u"exec_id"_s, js::S(execId)},
                                              {u"time"_s, js::S(js::strOr(js::prop(&fill, u"time"_s), QString()))},
                                              {u"price"_s, js::N(numOr0(js::prop(&fill, u"price"_s)))},
                                              {u"qty"_s, js::N(numOr0(js::prop(&fill, u"shares"_s)))},
                                              {u"commission"_s, js::N(numOr0(js::prop(&fill, u"commission"_s)))},
                                              {u"sec_type"_s, secType.isEmpty() ? js::Null() : js::S(secType)},
                                              {u"con_id"_s, conId ? js::N(static_cast<double>(*conId)) : js::Null()}}));
        host_.seenFills().insert(execId);
        for (const char16_t* k : {u"perm_id", u"order_id"}) {
            const auto id = jsx::idOf(js::prop(&fill, QString::fromUtf16(k)));
            if (id) host_.orderIndex().insert(*id, rec.id);
        }
    }
    // 托管单的记录按 order.quantity 落(不是 totalQuantity),库里那一列是 0,从记录本身取
    const double quantity = rec.quantity > 0 ? rec.quantity : numOr0(record ? js::path(&*record, {u"order"_s, u"quantity"_s}) : nullptr);
    // 差一点点算填满:数量是浮点,组合单的份数与腿数在券商侧也可能有舍入
    if (quantity > 0 && filledQty + 1e-9 < quantity) return Settled{false, filledQty, quantity};
    if (host_.finalized().contains(rec.id)) return Settled{false, filledQty, quantity};
    host_.finalized().insert(rec.id);
    host_.store().setFinalStatus(rec.id, u"filled"_s, std::nullopt);
    host_.store().audit(u"engine"_s, u"reconcile_filled"_s,
                        js::object({{u"record"_s, js::S(rec.id)}, {u"quantity"_s, js::N(quantity)}, {u"filled"_s, js::N(filledQty)}}));
    host_.notifier().warning(u"对账:"_s + rec.symbol + u" 的单子在断线期间已经成交("_s + n(filledQty) + u"),记录已补上成交与终态。"_s);
    return Settled{true, filledQty, quantity};
}

util::Task<bool> Reconciler::syncExecutions(QList<WorkingRecord> missing, double nowMs) {
    ReconcileRouter* router = host_.router();
    if (!router || !router->hasExecutions()) co_return true;
    const bool fresh = std::isinf(execSyncAt_) && execSyncAt_ < 0;
    bool allMarked = true;
    for (const WorkingRecord& rec : missing) allMarked = allMarked && rec.lastStatus == kStatusNotAtBroker;
    if (!fresh && allMarked) co_return true;
    if (!fresh && nowMs - execSyncAt_ < kExecSyncEveryMs) co_return false;
    execSyncAt_ = nowMs;
    try {
        const QList<Rec> rows = co_await withTimeout<QList<Rec>>(router->executions(), kBrokerTimeoutMs, u"券商的当天成交"_s, setTimeout);
        host_.store().rememberFills(rows);
        co_return true;
    } catch (...) {
        host_.store().audit(u"engine"_s, u"reconcile_fills_failed"_s, js::object({{u"error"_s, js::S(jsx::errorMessage(std::current_exception()).left(300))}}));
        co_return false;
    }
}

bool Reconciler::flagUnreconciled(const WorkingRecord& rec, const Settled& settled) {
    if (rec.lastStatus == kStatusNotAtBroker) return false;
    OJson event = js::object({{u"status"_s, js::S(kStatusNotAtBroker)}, {u"source"_s, js::S(u"reconcile"_s)}, {u"was"_s, js::S(rec.lastStatus)}});
    OJson audit = js::object({{u"record"_s, js::S(rec.id)}, {u"was"_s, js::S(rec.lastStatus)}});
    if (settled.filled > 0) {
        event.set(u"filled"_s, js::N(settled.filled));
        event.set(u"quantity"_s, js::N(settled.quantity));
        audit.set(u"filled"_s, js::N(settled.filled));
        audit.set(u"quantity"_s, js::N(settled.quantity));
    }
    host_.store().appendEvent(rec.id, u"status"_s, event);
    host_.store().audit(u"engine"_s, u"reconcile_missing"_s, &audit);
    QString why;
    if (settled.filled > 0) {
        why = u"券商侧已经没有这张单,当天的成交里只找到 "_s + n(settled.filled) + u"(共 "_s + n(settled.quantity) + u"),已补录进记录;"_s + u"剩下的 "_s +
              n(jsx::max(0, settled.quantity - settled.filled)) + u" 可能被撤了,也可能更早成交、券商不再回报"_s + u"(请在 TWS 里核对后再决定是否补下剩下的部分)"_s;
    } else if (rec.lastStatus == u"PendingTrigger") {
        why = u"软件重启后条件单不再被盯,要继续请重新提交"_s;
    } else if (rec.lastStatus.isEmpty()) {
        // 只留下了发单的痕、一条状态回报都没有:发到一半软件中断了(见 store.markSubmitIntent)
        why = u"发单途中软件中断了,券商侧没有这张单,当天的成交里也没有它:它多半没有发出去(请在 TWS 里核对后再决定是否重下)"_s;
    } else {
        why = u"券商侧已经没有这张单,当天的成交里也没有它(更早成交的券商不再回报,请在 TWS 里核对后再决定是否重下)"_s;
    }
    host_.notifier().warning(u"对账:"_s + rec.symbol + u" 的单子去向不明——"_s + why + u"。"_s);
    return true;
}

}  // namespace ibkr::orchestrate
