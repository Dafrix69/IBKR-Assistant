#include "orchestrate/callbacks.h"

#include "domain/store.h"
#include "orchestrate/engine_time.h"
#include "util/jsformat.h"
#include "util/jsobj.h"

#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::orchestrate {

namespace {

// IBKR 信息类代码:行情农场连接状态等,与订单成败无关
constexpr int kInfoMin = 2100;
constexpr int kInfoMax = 2200;
/// 订单级"警告"码:IBKR 只是附一句话,订单仍然有效——399 委托单消息、404 股票待借入(订单挂起)
const QSet<int> kWarningCodes{399, 404};
/// 行情订阅的错误码,永远不属于某一张订单(订单 id 与请求 id 共用一个计数器,errorEvent 只给 reqId)
const QSet<int> kMarketDataCodes{101, 300, 309, 316, 317, 322, 354, 10089, 10090, 10091, 10167, 10168, 10185, 10197};
/// 只会来自数据请求的错误码:历史 K 线 / 逐笔、实时 bar、实时更新断开、延迟行情也没有、基本面
const QSet<int> kDataRequestCodes{162, 165, 166, 366, 420, 430, 10182, 10186, 10187, 10225, 10314};
/// 两边都会报的码:200 查不到合约、321 请求校验不过。只有本会话**刚**对这个号发过单才当成订单的错误
const QSet<int> kAmbiguousCodes{200, 321};
/// IBKR 对一张单的校验错误一秒内就回;窗口开得越宽,撞号的数据请求错误越容易被当成订单被拒
constexpr double kAmbiguousWindowMs = 10'000;
/// 券商回绝的只是我们这一下改单 / 撤单,理由是这张单已经走完了:104 已成交不能改、161 不在可撤状态、10148 撤不掉
const QSet<int> kRefusedOnlyCodes{104, 161, 10148};
/// 追价平仓单改价被拒的提醒:同一张单一分钟最多一次
constexpr double kChaseRefusalNotifyMs = 60'000;

QString terminalOf(const QString& status) {
    if (status == u"Filled") return u"filled"_s;
    if (status == u"Cancelled" || status == u"ApiCancelled") return u"cancelled"_s;
    if (status == u"Inactive") return u"ibkr_error"_s;
    return QString();
}

QString n(double v) { return util::jsNumberToString(v); }

}  // namespace

void IbCallbacks::replayUnmatched() {
    auto& queue = host_.unmatchedEvents();
    if (queue.empty()) return;
    std::deque<UnmatchedEvent> stashed = queue;
    queue.clear();
    for (const UnmatchedEvent& e : stashed) {
        if (!recordFor(e.trade)) {
            host_.unmatchedEvents().push_back(e);
            continue;
        }
        if (e.kind == u"status") onOrderStatus(e.trade);
        else if (e.kind == u"exec") onExecDetails(e.trade, e.fill);
        else if (e.kind == u"commission") onCommission(e.trade, e.fill, e.report);
    }
    // 缓冲上限(与 Python deque(maxlen=200) 同语义)
    while (host_.unmatchedEvents().size() > 200) host_.unmatchedEvents().pop_front();
}

void IbCallbacks::stashUnmatched(const QString& kind, const Rec& trade, const Rec& fill, const Rec& report) {
    // 只攒带 orderId/permId 的回报——完全无主的没必要留
    const OJson* order = js::prop(&trade, u"order"_s);
    if (!js::truthy(order)) return;
    if (js::truthy(js::prop(order, u"permId"_s)) || js::truthy(js::prop(order, u"orderId"_s))) {
        host_.unmatchedEvents().push_back(UnmatchedEvent{kind, trade, fill, report});
        while (host_.unmatchedEvents().size() > 200) host_.unmatchedEvents().pop_front();
    }
}

bool IbCallbacks::sentRecently(qint64 req) {
    const SentOrders* sent = host_.sentOrders();
    if (!sent) return false;
    const auto it = sent->constFind(req);
    return it != sent->cend() && nowMs() - it->at <= kAmbiguousWindowMs;
}

bool IbCallbacks::mayConcernOrder(qint64 req, int code) {
    if (kDataRequestCodes.contains(code)) return false;
    if (kAmbiguousCodes.contains(code)) return sentRecently(req);
    return true;
}

bool IbCallbacks::refusesRequestOnly(const QString& recordId, int code) {
    if (code == 202 || code == 135) return false;
    if (kRefusedOnlyCodes.contains(code)) return true;
    const std::optional<Rec> record = host_.store().getRecord(recordId);
    const OJson* timeline = record ? js::path(&*record, {u"ibkr"_s, u"status_timeline"_s}) : nullptr;
    if (!js::isArr(timeline) || timeline->items.isEmpty()) return false;
    const OJson& last = timeline->items.last();
    if (!js::isObjectLike(&last)) return false;
    const OJson* status = js::prop(&last, u"status"_s);
    return js::isStr(status) && status->s == u"Adjusted";
}

void IbCallbacks::warnChaseRefused(qint64 orderId, int code, const QString& message) {
    const double now = nowMs();
    const auto it = chaseRefusalNotifiedAt_.constFind(orderId);
    if (it != chaseRefusalNotifiedAt_.cend() && now - *it < kChaseRefusalNotifyMs) return;
    chaseRefusalNotifiedAt_.insert(orderId, now);
    host_.notifier().warning(u"追价平仓单改价被券商拒绝(IBKR "_s + n(code) + u": "_s + message +
                             u"),原单仍按上一次被接受的价挂着,下一轮按最新买卖价接着改。"_s);
}

void IbCallbacks::onIbError(const Rec& reqId, const Rec& errorCode, const Rec& errorString) {
    const double codeD = std::trunc(js::num(&errorCode));
    const double reqD = std::trunc(js::num(&reqId));
    if (!std::isfinite(codeD) || !std::isfinite(reqD)) return;
    const int code = static_cast<int>(codeD);
    const qint64 req = static_cast<qint64>(reqD);
    if (req <= 0) return;  // 系统级消息,与具体订单无关
    if (kMarketDataCodes.contains(code)) return;  // 行情订阅的错误,不是订单的
    const QString message = js::strOr(&errorString, QString());
    const bool informational = code >= kInfoMin && code < kInfoMax;
    const QString codeText = n(codeD);
    const auto indexIt = host_.orderIndex().constFind(req);
    const bool hasRecord = indexIt != host_.orderIndex().cend();
    const QString recordId = hasRecord ? *indexIt : QString();
    if (!mayConcernOrder(req, code)) {
        // 撞了号的数据请求:同号的那张单(若有)什么事都没有。留一句话备查;不宣判
        if (hasRecord) {
            host_.store().appendEvent(recordId, u"warning"_s,
                                      js::object({{u"message"_s, js::S(u"IBKR "_s + codeText + u": "_s + message + u"(同号的数据请求报的错,与这张单无关,不作终态)"_s)}}));
        }
        return;
    }
    if (!hasRecord) {
        if (informational || kWarningCodes.contains(code)) return;
        if (sentRecently(req)) {
            // 没有记录、可我们刚改过 / 撤过它:重启后认领回来的托管单。改价被拒要交给托管那一路
            host_.hostedOrders().handleError(req, code, message);
            return;
        }
        // 错误比 placeOrder 返回还早:先记下,挂单登记完再对上(见 placeHostedOne)
        host_.earlyOrderErrors().insert(req, EarlyOrderError{code, message, nowMs()});
        for (const qint64 id : QList<qint64>(host_.earlyOrderErrors().keys())) {
            if (nowMs() - host_.earlyOrderErrors().value(id).at > 60'000) host_.earlyOrderErrors().remove(id);
        }
        return;
    }
    if (informational || kWarningCodes.contains(code)) {
        host_.store().appendEvent(recordId, u"warning"_s, js::object({{u"message"_s, js::S(u"IBKR "_s + codeText + u": "_s + message)}}));
        if (!informational) host_.notifier().warning(u"IBKR "_s + codeText + u": "_s + message);
        return;
    }
    const SentOrders* sent = host_.sentOrders();
    if (sent && !sent->contains(req)) {
        // 不是本会话发出去的单(上个会话留下、对账认领回来的):这条错误未必冲它来,更不是在回我们哪一下
        host_.store().appendEvent(recordId, u"warning"_s,
                                  js::object({{u"message"_s, js::S(u"IBKR "_s + codeText + u": "_s + message + u"(这张单不是本会话发出的,不作终态)"_s)}}));
        host_.notifier().warning(u"IBKR "_s + codeText + u": "_s + message);
        return;
    }
    if (refusesRequestOnly(recordId, code)) {
        // 回绝的只是刚才那一下改单 / 撤单:原单还按上一次被接受的价挂着(或已经成交,等状态回报)
        host_.hostedOrders().handleError(req, code, message);
        host_.store().appendEvent(recordId, u"warning"_s,
                                  js::object({{u"message"_s, js::S(u"IBKR "_s + codeText + u": "_s + message + u"(改单 / 撤单被拒,原单仍在,不作终态)"_s)}}));
        if (host_.closeChaseIndex().contains(req)) {
            if (host_.hasCloseChaseModifyRejected()) host_.closeChaseModifyRejected(req);
            warnChaseRefused(req, code, message);
        }
        return;
    }
    const QString final = code == 202 ? u"cancelled"_s : u"ibkr_error"_s;
    host_.hostedOrders().handleError(req, code, message);
    if (host_.closeChaseIndex().contains(req)) {
        // 追价中的平仓单被拒 / 被撤:不再追,持仓可能还在,和撤单回报走同一条路提醒
        host_.closeChaseOnStatus(js::object({{u"order"_s, js::object({{u"orderId"_s, js::N(static_cast<double>(req))}})},
                                             {u"orderStatus"_s, js::object({{u"status"_s, js::S(code == 202 ? u"Cancelled"_s : u"Inactive"_s)}})}}));
    }
    host_.store().appendEvent(recordId, u"status"_s,
                              js::object({{u"status"_s, js::S(u"Error"_s)}, {u"code"_s, js::N(codeD)}, {u"message"_s, js::S(message)}}));
    if (!host_.finalized().contains(recordId)) {
        host_.finalized().insert(recordId);
        host_.store().setFinalStatus(recordId, final, u"IBKR "_s + codeText + u": "_s + message);
    }
    if (final == u"ibkr_error") host_.notifier().rejection(u"IBKR_ERROR"_s, u"IBKR "_s + codeText + u": "_s + message);
}

std::optional<QString> IbCallbacks::recordFor(const Rec& trade) {
    for (const QString& field : {u"permId"_s, u"orderId"_s}) {
        const OJson* key = js::path(&trade, {u"order"_s, field});
        if (!js::truthy(key)) continue;
        const double k = js::num(key);
        if (std::isnan(k)) continue;
        const auto it = host_.orderIndex().constFind(static_cast<qint64>(k));
        if (it != host_.orderIndex().cend()) return *it;
    }
    return std::nullopt;
}

void IbCallbacks::onOrderStatus(const Rec& trade) {
    host_.hostedOrders().onStatus(trade);
    host_.closeChaseOnStatus(trade);
    const std::optional<QString> recordId = recordFor(trade);
    if (!recordId || recordId->isEmpty()) {
        stashUnmatched(u"status"_s, trade);
        return;
    }
    const OJson* os = js::prop(&trade, u"orderStatus"_s);
    const QString status = js::strOr(js::prop(os, u"status"_s), QString());
    host_.store().appendEvent(*recordId, u"status"_s,
                              js::object({{u"status"_s, js::S(status)},
                                          {u"filled"_s, js::copyOrNull(js::nullish(js::prop(os, u"filled"_s)) ? nullptr : js::prop(os, u"filled"_s))},
                                          {u"remaining"_s, js::copyOrNull(js::nullish(js::prop(os, u"remaining"_s)) ? nullptr : js::prop(os, u"remaining"_s))}}));
    QString final = terminalOf(status);
    if (final == u"filled" && js::truthy(js::prop(os, u"remaining"_s))) final = u"partially_filled"_s;
    if (!final.isEmpty() && !host_.finalized().contains(*recordId)) {
        host_.finalized().insert(*recordId);
        host_.store().setFinalStatus(*recordId, final, std::nullopt);
    }
}

void IbCallbacks::onExecDetails(const Rec& trade, const Rec& fill) {
    const std::optional<QString> recordId = recordFor(trade);
    if (!recordId || recordId->isEmpty()) {
        stashUnmatched(u"exec"_s, trade, fill);
        return;
    }
    const OJson* execution = js::prop(&fill, u"execution"_s);
    if (!js::truthy(execution)) return;
    // 同一 exec_id 只落一次、只通知一次。交易分析同步成交时 TWS 会把当天的成交整批重推,这里兜底。没有 exec_id 的认不出是不是同一笔,照旧
    const QString execId = js::strOr(js::prop(execution, u"execId"_s), QString());
    if (!execId.isEmpty() && host_.seenFills().contains(execId)) return;
    // 这笔成交自己的合约:组合单 IBKR 会回 1 条 BAG 行 + 每条腿各一行,只能靠 secType 分开。只取 fill.contract
    const OJson* fc = js::prop(&fill, u"contract"_s);
    const OJson* contract = js::nullish(fc) ? nullptr : fc;
    const auto numOr0 = [](const OJson* v) {
        const double x = jsx::numOr(v, 0);
        return std::isnan(x) || x == 0 ? 0.0 : x;
    };
    const QString secType = js::strOr(js::prop(contract, u"secType"_s), QString());
    const double conId = jsx::trunc(jsx::numOr(js::prop(contract, u"conId"_s), 0));
    OJson payload = js::object({{u"exec_id"_s, js::nullish(js::prop(execution, u"execId"_s)) ? js::S(QString()) : *js::prop(execution, u"execId"_s)},
                                {u"time"_s, js::S(js::strOr(js::prop(execution, u"time"_s), QString()))},
                                {u"price"_s, js::N(numOr0(js::prop(execution, u"price"_s)))},
                                {u"qty"_s, js::N(numOr0(js::prop(execution, u"shares"_s)))},
                                {u"commission"_s, js::N(0)},
                                {u"sec_type"_s, secType.isEmpty() ? js::Null() : js::S(secType)},
                                {u"con_id"_s, std::isnan(conId) || conId == 0 ? js::Null() : js::N(conId)}});
    host_.store().appendEvent(*recordId, u"fill"_s, payload);
    if (!execId.isEmpty()) host_.seenFills().insert(execId);
    // live=false:reqExecutions 补回来的(断线期间成交、实时回报没收到)。只补录不通知
    const OJson* live = js::prop(&fill, u"live"_s);
    if (js::isBool(live) && !live->b) return;
    host_.notifier().fill(js::strOr(js::path(&trade, {u"contract"_s, u"symbol"_s}), u"?"_s), js::strOr(js::prop(execution, u"side"_s), u"?"_s),
                          numOr0(js::prop(execution, u"shares"_s)), numOr0(js::prop(execution, u"price"_s)),
                          domain::redactAccount(js::strOr(js::prop(execution, u"acctNumber"_s), QString())));
}

void IbCallbacks::onCommission(const Rec& trade, const Rec& fill, const Rec& report) {
    const std::optional<QString> recordId = recordFor(trade);
    if (!recordId || recordId->isEmpty()) {
        stashUnmatched(u"commission"_s, trade, fill, report);
        return;
    }
    // 佣金回报跟着成交一起被重推,同样按 exec_id 只落第一条(手续费、已实现盈亏才不会翻倍)
    const QString execId = js::strOr(js::prop(&report, u"execId"_s), QString());
    if (!execId.isEmpty() && host_.seenCommissions().contains(execId)) return;
    const double commission = jsx::numOr(js::prop(&report, u"commission"_s), 0);
    const OJson* pnl = js::prop(&report, u"realizedPNL"_s);
    host_.store().appendEvent(*recordId, u"commission"_s,
                              js::object({{u"exec_id"_s, js::nullish(js::prop(&report, u"execId"_s)) ? js::S(QString()) : *js::prop(&report, u"execId"_s)},
                                          {u"commission"_s, js::N(std::isnan(commission) || commission == 0 ? 0.0 : commission)},
                                          {u"realized_pnl"_s, js::nullish(pnl) ? js::Null() : *pnl}}));
    if (!execId.isEmpty()) host_.seenCommissions().insert(execId);
}

}  // namespace ibkr::orchestrate
