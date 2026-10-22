#include "execution/held_streams.h"

#include "execution/ib_link.h"
#include "execution/ib_session.h"
#include "execution/qualify_gate.h"
#include "execution/session_weak_map.h"
#include "util/js_runtime.h"
#include "util/jsformat.h"
#include "util/jsmath.h"

#include <QSet>

#include <cmath>

namespace ibkr::execution {

using namespace Qt::StringLiterals;

namespace {

/// 会话 → 上一次确认超时之后,到什么时候之前不再去确认。按会话记、不按键记:不回话的是 TWS,不是某一张合约
SessionWeakMap<IbSession>& stalledUntil() {
    static SessionWeakMap<IbSession> map;
    return map;
}

/// JS 的真假:空串是假
bool hasError(const TickerData& t) { return t.error && !t.error->isEmpty(); }

bool alive(const TickerData& t, double silentLimitMs, double now) {
    return !hasError(t) && !(silentLimitMs > 0 && quoteSilenceMs(t, now).value_or(0) >= silentLimitMs);
}

/// Math.round(x):.5 往正无穷
double jsRound(double x) {
    const double r = std::floor(x);
    return x - r >= 0.5 ? r + 1 : r;
}

}  // namespace

double silenceLimitMs(const QString& status) {
    if (status == u"盘中") return 30'000;
    return status == u"盘外" || status == u"盘前" || status == u"盘后" ? 120'000 : 0;
}

std::optional<double> quoteSilenceMs(const TickerData& t, double now) {
    const double since = util::jsmath::max(t.quotedAt.value_or(0), t.requestedAt.value_or(0));
    if (since > 0) return now - since;
    return std::nullopt;
}

bool HeldStreams::usable(const std::shared_ptr<IbSession>& session, const QString& key, double silentLimitMs, std::optional<double> nowArg) {
    const double now = nowArg ? *nowArg : util::dateNow();
    const HeldStream* existing = map_.find(key);
    if (!existing) return false;
    const std::shared_ptr<TickerHandle> handle = existing->handle;
    const std::optional<IbContract> contract = existing->contract;
    if (!handle) return true;
    const TickerData t = handle->read();
    const double limit = session->isConnected() ? silentLimitMs : 0;
    if (alive(t, limit, now)) {
        recovered(key, t);
        return true;
    }
    map_.remove(key);
    const QString stream = contract ? tickerKey(*contract) : QString();
    bool shared = false;
    for (const QString& k : map_.keys()) {
        const HeldStream& s = *map_.find(k);
        if (s.session.get() == session.get() && s.handle && s.contract && tickerKey(*s.contract) == stream && alive(s.handle->read(), limit, now)) {
            shared = true;
            break;
        }
    }
    if (contract && !shared) {
        try {
            if (!hasError(t)) session->cancelTicker(*contract, QString());
            else if (!variant_) session->cancelTicker(*contract);
            else session->cancelTicker(*contract, *variant_);
        } catch (...) {
            // 撤不掉也要重订
        }
    }
    if (!hasError(t)) noteSilent(key, quoteSilenceMs(t, now).value_or(0));
    return false;
}

void HeldStreams::subscribe(const std::shared_ptr<IbSession>& session, const QString& key, const IbContract& contract) {
    map_.insert(key, {session->subscribeTicker(contract), contract, session});
}

util::Task<bool> HeldStreams::ensure(std::shared_ptr<IbSession> session, QString key, std::function<IbContract()> target,
                                     std::function<util::Task<QualifyKnown>(IbContract&)> qualifies, double silentLimitMs) {
    if (usable(session, key, silentLimitMs)) co_return false;
    const std::optional<double> wait = stalledUntil().get(session);
    if (wait) {
        if (util::dateNow() < *wait) co_return false;
        // 这一次试探出结果之前先把时刻往后推:另一路读取(盯盘 / 界面)这时候进来不跟着排队等
        stalledUntil().set(session, util::dateNow() + kQualifyRetryMs);
    }
    IbContract contract = target();
    const QualifyKnown known = co_await qualifies(contract);
    if (known == QualifyKnown::Stalled) {
        if (!wait && !stalledUntil().has(session)) {
            logStderr(u"[ibkr] 行情流 %1:TWS 没有响应合约确认,持仓的现价暂时订不上;每 %2 秒再试一次"_s.arg(key, util::jsNumberToString(kQualifyRetryMs / 1000)));
        }
        stalledUntil().set(session, util::dateNow() + kQualifyRetryMs);
        co_return false;
    }
    if (stalledUntil().erase(session)) logStderr(u"[ibkr] 行情流:TWS 恢复响应合约确认,持仓的行情重新订阅"_s);
    if (known == QualifyKnown::No) {
        map_.insert(key, {nullptr, std::nullopt, nullptr});
        co_return false;
    }
    subscribe(session, key, contract);
    co_return true;
}

void HeldStreams::clear() {
    silent_ = {};
    map_ = {};
}

int HeldStreams::release(const QStringList& keep, const std::function<std::vector<std::shared_ptr<TickerHandle>>(const QString&)>& sharedWith) {
    const QSet<QString> keepSet(keep.begin(), keep.end());
    int released = 0;
    const QStringList snapshot = map_.keys();
    for (const QString& key : snapshot) {
        if (keepSet.contains(key)) continue;
        const HeldStream gone = *map_.find(key);
        map_.remove(key);
        silent_.remove(key);
        const auto& [handle, contract, session] = gone;
        if (!handle || !contract || !session || hasError(handle->read())) continue;
        const QString stream = tickerKey(*contract);
        bool held = false;
        for (const QString& k : map_.keys()) {
            const HeldStream& s = *map_.find(k);
            if (s.session.get() == session.get() && s.contract && tickerKey(*s.contract) == stream) {
                held = true;
                break;
            }
        }
        if (held) continue;
        bool others = false;
        if (sharedWith) {
            for (const auto& h : sharedWith(key)) {
                if (h && !hasError(h->read())) {
                    others = true;
                    break;
                }
            }
        }
        if (others) continue;
        try {
            session->cancelTicker(*contract, QString());
            released += 1;
        } catch (...) {
            // 会话已经断了:流跟着连接一起没了,没什么可撤的
        }
    }
    return released;
}

void HeldStreams::noteSilent(const QString& key, double silence) {
    const int times = (silent_.contains(key) ? *silent_.find(key) : 0) + 1;
    silent_.insert(key, times);
    if (times == 1) logStderr(u"[ibkr] 行情流 %1:连接还在,却 %2 秒没来一笔盘口,撤掉重订"_s.arg(key, util::jsNumberToString(jsRound(silence / 1000))));
}

void HeldStreams::recovered(const QString& key, const TickerData& t) {
    const int* times = silent_.find(key);
    if (!times || !t.quotedAt || *t.quotedAt == 0 || std::isnan(*t.quotedAt)) return;
    const int n = *times;
    silent_.remove(key);
    logStderr(u"[ibkr] 行情流 %1:重订 %2 次后盘口回来了"_s.arg(key, QString::number(n)));
}

}  // namespace ibkr::execution
