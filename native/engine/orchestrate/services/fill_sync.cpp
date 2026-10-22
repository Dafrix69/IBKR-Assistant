#include "orchestrate/services/fill_sync.h"

#include "execution/broker_pricing.h"
#include "orchestrate/services/svc_util.h"
#include "util/jsformat.h"
#include "util/jsobj.h"

#include <algorithm>
#include <cmath>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using execution::BrokerError;
using util::OJson;
using util::Task;
namespace js = util::js;

QString holdingsFingerprint(const QList<execution::PositionItemLike>& items) {
    QStringList keys;
    for (const auto& item : items) {
        double quantity = item.position;
        if (std::isnan(quantity)) quantity = 0;  // Number(item.position) || 0
        if (quantity == 0) continue;
        static const OJson emptyObj = js::object();
        const OJson& c = js::nullish(&item.contract) ? emptyObj : item.contract;
        QString what;
        if (js::truthy(js::prop(&c, u"conId"_s))) {
            what = js::str(js::prop(&c, u"conId"_s));
        } else {
            QStringList parts;
            for (const QString& k : {u"symbol"_s, u"secType"_s, u"lastTradeDateOrContractMonth"_s, u"strike"_s, u"right"_s}) {
                const OJson* v = js::prop(&c, k);
                parts << (js::nullish(v) ? QString() : js::str(v));
            }
            what = parts.join(u'/');
        }
        QString account;
        if (item.account) account = *item.account;
        else if (const OJson* a = js::prop(&c, u"account"_s); !js::nullish(a)) account = js::str(a);
        keys << account + u'|' + what + u'|' + util::jsNumberToString(quantity);
    }
    std::sort(keys.begin(), keys.end());  // JS 默认 sort:按 UTF-16 单元(QString 的 < 也是)
    return keys.join(u';');
}

namespace {
BrokerError timeoutError() {
    return BrokerError(u"读取成交明细失败:券商等了 %1 秒没有回应"_s.arg(util::jsNumberToString(util::jsRound(FillSyncService::kBrokerTimeoutMs / 1000.0))));
}
}  // namespace

FillSyncService::FillSyncService(SvcHost& host) : SvcBase(host) {}

FillSyncService::~FillSyncService() {
    *alive_ = false;
    stop();
}

std::shared_ptr<execution::BrokerRouter> FillSyncService::source() {
    auto router = sh_.broker();
    if (!router || router->sessions().empty()) return nullptr;
    return router;
}

bool FillSyncService::available() { return source() != nullptr; }

// ---- 循环 ----------------------------------------------------------------
void FillSyncService::start(int tickMs) {
    if (running_) return;
    const int gen = ++gen_;
    running_ = true;
    timer_ = rt().setTimeout(tickMs, [this, alive = std::weak_ptr<bool>(alive_), tickMs, gen] {
        if (alive.expired()) return;
        util::detach(loop(tickMs, gen));
    });
}

Task<> FillSyncService::loop(int tickMs, int gen) {
    const std::weak_ptr<bool> alive = alive_;
    try {
        co_await tickOnce();
    } catch (...) {
        /* .catch(() => undefined) */
    }
    if (alive.expired() || gen != gen_ || !running_) co_return;
    timer_ = rt().setTimeout(tickMs, [this, alive, tickMs, gen] {
        if (alive.expired()) return;
        util::detach(loop(tickMs, gen));
    });
}

void FillSyncService::stop() {
    gen_ += 1;
    running_ = false;
    if (timer_ != 0) rt().clearTimeout(timer_);
    timer_ = 0;
}

Task<std::optional<double>> FillSyncService::tickOnce(std::optional<double> nowArg) {
    const double nowMs = nowArg ? *nowArg : rt().perfMs();
    const auto src = source();
    if (!src) {
        forget();
        co_return std::nullopt;
    }
    const std::optional<QString> seen = co_await readHoldings(src);
    if (seen && (!holdings_ || *seen != *holdings_)) {
        // 连上之后头一回读到不算"变了":刚连上那一次已经欠着了
        if (holdings_) {
            owed_ = kAfterChange;
            // 成交正好卡在 TWS 的午夜前后时,当天那一问问不到它:持仓变了的这几趟一并往回要
            deepOwed_ = kAfterChange;
        }
        holdings_ = seen;
    }
    if (owed_ == 0 && nowMs - lastAt_ >= kEveryMs) owed_ = 1;
    if (deepOwed_ == 0 && nowMs - lastDeepAt_ >= kHistoryEveryMs) deepOwed_ = 1;
    if (owed_ > 0) co_return co_await sync(nowMs);
    co_return std::nullopt;
}

Task<std::optional<double>> FillSyncService::sync(std::optional<double> nowArg, bool deep) {
    // 注意:TS 的 sync 不是 async 函数——同一时刻的两次调用拿同一个 Promise。这里 sync 是协程,第二次调用返回 inflight_ 的结果
    const double nowMs = nowArg ? *nowArg : rt().perfMs();
    if (deep) {
        deepOwed_ = std::max(deepOwed_, 1);
        owed_ = std::max(owed_, 1);
    }
    if (inflight_ && !inflight_->done()) {
        Task<std::optional<double>> pending = *inflight_;  // 副本:等的时候 inflight_ 可能被换掉
        co_return co_await pending;
    }
    const auto src = source();
    if (!src) {
        forget();
        co_return std::nullopt;
    }
    if (nowMs - lastAt_ < kMinGapMs) co_return std::nullopt;
    lastAt_ = nowMs;
    Task<std::optional<double>> run = pull(src, nowMs);
    inflight_ = run;
    co_return co_await run;
}

Task<std::optional<double>> FillSyncService::pull(std::shared_ptr<execution::BrokerRouter> src, double nowMs) {
    try {
        auto work = src->executions();
        QList<OJson> rows = co_await raceTimeout(rt(), std::move(work), kBrokerTimeoutMs, [] { return timeoutError(); });
        if (deepOwed_ > 0 && !historyOff_) rows.append(co_await history(src, nowMs));
        const double added = store().rememberFills(rows);
        owed_ = std::max(0, owed_ - 1);
        lastError_.clear();
        co_return added;
    } catch (const BrokerError& exc) {
        // 还欠着,过了节流再来。同一句报错只留一条痕:券商卡住时这里十几秒就来一轮
        const QString error = sliceUnits(exc.message(), 300);
        if (error != lastError_) {
            const OJson detail = js::object({{u"error"_s, js::S(error)}});
            store().audit(u"engine"_s, u"fills_failed"_s, &detail);
        }
        lastError_ = error;
        co_return std::nullopt;
    }
}

Task<QList<OJson>> FillSyncService::history(std::shared_ptr<execution::BrokerRouter> src, double nowMs) {
    QList<OJson> rows;
    bool able = false;
    std::exception_ptr failure;
    try {
        for (const auto& session : src->sessions()) {
            if (!session->has(execution::Cap::ExecutionHistory)) continue;
            const auto details = co_await raceTimeout(rt(), session->executionHistory(kHistoryDays), kBrokerTimeoutMs, [] { return timeoutError(); });
            if (!details) continue;
            able = true;
            for (const auto& d : *details) {
                static const OJson emptyObj = js::object();
                const auto row = execution::fillRow(js::nullish(&d.contract) ? emptyObj : d.contract, js::nullish(&d.execution) ? emptyObj : d.execution);
                if (row) rows.append(*row);
            }
        }
    } catch (...) {
        failure = std::current_exception();
    }
    if (failure) {
        const QString error = sliceUnits(errMessage(failure), 300);
        if (error != lastHistoryError_) {
            const OJson detail = js::object({{u"error"_s, js::S(error)}});
            store().audit(u"engine"_s, u"fills_history_failed"_s, &detail);
        }
        lastHistoryError_ = error;
        co_return rows;
    }
    // 没有一个会话给得了(TWS 太老,或者这种券商压根没有):这次连接里不再试,免得每一趟都白连一次
    if (!able) historyOff_ = true;
    deepOwed_ = std::max(0, deepOwed_ - 1);
    lastDeepAt_ = nowMs;
    lastHistoryError_.clear();
    co_return rows;
}

void FillSyncService::forget() {
    holdings_.reset();
    owed_ = std::max(owed_, 1);
    deepOwed_ = std::max(deepOwed_, 1);
    historyOff_ = false;
}

Task<std::optional<QString>> FillSyncService::readHoldings(std::shared_ptr<execution::BrokerRouter> src) {
    QList<execution::PositionItemLike> items;
    try {
        for (const auto& session : src->sessions()) {
            const auto got = co_await session->positions();
            for (const auto& p : got) items.append(p);
        }
    } catch (...) {
        co_return std::nullopt;
    }
    co_return holdingsFingerprint(items);
}

}  // namespace ibkr::orchestrate
