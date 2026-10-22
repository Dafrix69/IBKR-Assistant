#include "execution/qualify_gate.h"

#include "execution/session_weak_map.h"
#include "util/js_runtime.h"

namespace ibkr::execution {

namespace {

/// 会话 → 上一次确认超时之后,到什么时候之前只读的确认不再发请求。有这一项 = 这个会话正卡着
SessionWeakMap<IbSession>& stalledUntil() {
    static SessionWeakMap<IbSession> map;
    return map;
}

QualifyGateStats& stats() {
    static QualifyGateStats s;
    return s;
}

/// String(exc?.message ?? exc)
QString messageOf(const std::exception_ptr& exc) {
    try {
        std::rethrow_exception(exc);
    } catch (const util::JsError& e) {
        return e.message();
    } catch (const std::exception& e) {
        return QString::fromStdString(e.what());
    } catch (...) {
        return {};
    }
}

}  // namespace

QualifyGateStats takeQualifyGateStats() {
    const QualifyGateStats out = stats();
    stats() = {};
    return out;
}

bool isTimeout(const std::exception_ptr& exc) {
    if (messageOf(exc).toLower().contains(u"timeout")) return true;
    try {
        std::rethrow_exception(exc);
    } catch (const TimeoutError&) {
        return true;
    } catch (...) {
        return false;
    }
}

Task<QualifyAnswer> qualifyGated(std::shared_ptr<IbSession> session, std::vector<IbContract*> contracts, int timeoutMs, bool wait,
                                 std::function<double()> now) {
    if (!now) now = [] { return util::dateNow(); };
    if (!wait) {
        if (const auto until = stalledUntil().get(session)) {
            if (now() < *until) {
                stats().skipped += 1;
                co_return QualifyAnswer::Stalled;
            }
            stats().probes += 1;
            stalledUntil().set(session, now() + kQualifyRetryMs);
        }
    }
    std::exception_ptr failure;
    try {
        co_await session->qualifyContracts(contracts, timeoutMs);
    } catch (...) {
        failure = std::current_exception();
    }
    if (failure) {
        if (isTimeout(failure)) {
            stats().timeouts += 1;
            stalledUntil().set(session, now() + kQualifyRetryMs);
            co_return QualifyAnswer::Stalled;
        }
        stalledUntil().erase(session);
        std::rethrow_exception(failure);
    }
    stalledUntil().erase(session);
    co_return QualifyAnswer::Ok;
}

}  // namespace ibkr::execution
