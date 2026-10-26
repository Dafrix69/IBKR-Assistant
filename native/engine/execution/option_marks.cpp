#include "execution/option_marks.h"

#include "execution/ib_contracts.h"
#include "execution/held_streams.h"
#include "execution/qualify_gate.h"
#include "util/js_runtime.h"
#include "util/jsformat.h"

#include <QTimer>

#include <algorithm>
#include <cmath>

namespace ibkr::execution {

using namespace Qt::StringLiterals;
using util::Task;

namespace {

/// price(value):有限且为正的数,别的回空
std::optional<double> price(const std::optional<double>& value) {
    if (value && std::isfinite(*value) && *value > 0) return value;
    return std::nullopt;
}
std::optional<double> price(double value) { return price(std::optional<double>(value)); }

/// JS 的真假:空串是假
bool hasError(const TickerData& t) { return t.error && !t.error->isEmpty(); }

}  // namespace

IntervalTimers qtIntervalTimers() {
    static quint64 next = 1;
    static QHash<quint64, QTimer*> timers;
    IntervalTimers t;
    t.start = [](int ms, std::function<void()> fn) {
        auto* timer = new QTimer;
        timer->setInterval(ms);
        QObject::connect(timer, &QTimer::timeout, timer, [fn = std::move(fn)] { fn(); });
        timer->start();
        const quint64 id = next++;
        timers.insert(id, timer);
        return id;
    };
    t.stop = [](quint64 id) {
        if (QTimer* timer = timers.take(id)) {
            timer->stop();
            delete timer;
        }
    };
    return t;
}

OptionMarkStreams::OptionMarkStreams(IntervalTimers timers) : timers_(std::move(timers)) {}

OptionMarkStreams::~OptionMarkStreams() { stopSweeper(); }

Task<std::vector<OptionMark>> OptionMarkStreams::read(std::shared_ptr<IbSession> session, std::vector<OptionLegSpec> legs, bool delayedOk, double silentLimitMs) {
    const Task<> prev = tail_;
    util::Deferred<> done;
    tail_ = done.task();
    co_await prev;
    std::exception_ptr failure;
    std::vector<OptionMark> result;
    try {
        result = co_await readNow(session, std::move(legs), delayedOk, silentLimitMs);
    } catch (...) {
        failure = std::current_exception();
    }
    done.resolve();
    if (failure) std::rethrow_exception(failure);
    co_return result;
}

void OptionMarkStreams::close() {
    for (const QString& k : QStringList(streams_.keys())) drop(k);
    stopSweeper();
}

QString OptionMarkStreams::key(const OptionLegSpec& leg) {
    return leg.symbol + u'|' + leg.expiry + u'|' + util::jsNumberToString(leg.strike) + u'|' + leg.right + u'|' + leg.tradingClass;
}

void OptionMarkStreams::drop(const QString& key) {
    const Stream* found = streams_.find(key);
    if (!found) return;
    const Stream s = *found;
    streams_.remove(key);
    try {
        s.session->cancelTicker(s.contract, kTicks);
    } catch (...) {
        // 会话已经断了:流跟着连接一起没了,没什么可撤的
    }
}

void OptionMarkStreams::sweep(double now, const QSet<QString>& keep) {
    for (const QString& key : QStringList(streams_.keys())) {
        if (keep.contains(key)) continue;
        const Stream& s = *streams_.find(key);
        if (now - s.usedAt >= kIdleMs || !s.session->isConnected()) drop(key);
    }
    // 还是太多:从最久没读的撤起
    std::vector<std::pair<QString, double>> spare;
    for (const QString& key : streams_.keys()) {
        if (!keep.contains(key)) spare.emplace_back(key, streams_.find(key)->usedAt);
    }
    std::stable_sort(spare.begin(), spare.end(), [](const auto& a, const auto& b) { return a.second - b.second < 0; });
    size_t next = 0;
    while (streams_.size() > kMaxStreams && next < spare.size()) drop(spare[next++].first);
    if (streams_.isEmpty()) stopSweeper();
}

void OptionMarkStreams::startSweeper() {
    if (sweeper_) return;
    sweeper_ = timers_.start(static_cast<int>(kIdleMs / 2), [this] { sweep(util::dateNow(), {}); });
}

void OptionMarkStreams::stopSweeper() {
    if (!sweeper_) return;
    timers_.stop(*sweeper_);
    sweeper_.reset();
}

Task<> OptionMarkStreams::qualify(std::shared_ptr<IbSession> session, const std::vector<OptionLegSpec>& legs, std::vector<IbContract>& contracts) {
    std::vector<size_t> need;
    for (size_t i = 0; i < contracts.size(); ++i) {
        const auto hit = conIds_.constFind(key(legs[i]));
        if (hit != conIds_.cend() && hit.value() != 0) contracts[i].conId = hit.value();
        else need.push_back(i);
    }
    if (need.empty()) co_return;
    // 只读:TWS 刚超时过就当场报,不再每十秒等满一个超时(qualifyGate)。任何错都按"没回应"报,同以前
    std::vector<IbContract*> ptrs;
    for (size_t i : need) ptrs.push_back(&contracts[i]);
    QualifyAnswer answered = QualifyAnswer::Stalled;
    try {
        answered = co_await qualifyGated(session, ptrs, kQualifyTimeoutMs, false);
    } catch (...) {
        answered = QualifyAnswer::Stalled;
    }
    if (answered == QualifyAnswer::Stalled) {
        throw OptionMarksError(u"TWS 在 %1 秒内没有回应合约确认请求。多半是 TWS 和 IBKR 服务器之间断了,"_s.arg(util::jsNumberToString(kQualifyTimeoutMs / 1000.0)) +
                               u"请看 TWS 窗口右下角的连接状态。"_s);
    }
    for (size_t i : need) {
        const IbContract& c = contracts[i];
        if (!c.conId || *c.conId == 0) {
            throw OptionMarksError(u"IBKR 确认不了这张合约(%1):行权价或到期日可能不存在。"_s.arg(describeContract(c)));
        }
        conIds_.insert(key(legs[i]), *c.conId);
    }
}

Task<std::vector<OptionMark>> OptionMarkStreams::readNow(std::shared_ptr<IbSession> session, std::vector<OptionLegSpec> legs, bool delayedOk, double silentLimitMs) {
    std::vector<QString> keys;
    for (const OptionLegSpec& leg : legs) keys.push_back(key(leg));
    sweep(util::dateNow(), QSet<QString>(keys.begin(), keys.end()));
    std::vector<IbContract> contracts;
    for (const OptionLegSpec& leg : legs) {
        contracts.push_back(optionContract(leg.symbol, leg.expiry, leg.strike, leg.right, leg.exchange, u"USD"_s, u"100"_s, leg.tradingClass));
    }

    // 换了会话、被拒过、或者连着却太久没盘口(同一个会话断线重连后库重订了、TWS 却不给)的:摘掉重订
    const double now = util::dateNow();
    const double limit = session->isConnected() ? silentLimitMs : 0;
    for (const QString& k : keys) {
        const Stream* s = streams_.find(k);
        if (!s) continue;
        const TickerData t = s->handle->read();
        const std::optional<double> silence = limit > 0 ? quoteSilenceMs(t, now) : std::nullopt;
        if (s->session.get() != session.get() || hasError(t) || (silence && *silence >= limit)) drop(k);
    }
    std::vector<QString> fresh;
    for (const QString& k : keys) {
        if (!streams_.contains(k)) fresh.push_back(k);
    }
    if (!fresh.empty()) {
        co_await qualify(session, legs, contracts);
        // 纸面会话按类型 3 订(有实时给实时,没有给延迟),和 legQuotes 同一条规矩;实盘绝不拿延迟价
        if (delayedOk) session->reqMarketDataType(3);
    }
    std::exception_ptr failure;
    try {
        for (size_t i = 0; i < keys.size(); ++i) {
            if (streams_.contains(keys[i])) continue;
            const IbContract& contract = contracts[i];
            std::shared_ptr<TickerHandle> handle = session->subscribeTicker(contract, kTicks);
            streams_.insert(keys[i], {session, contract, handle, util::dateNow()});
        }
        startSweeper();
        co_await waitFor(session, keys);
    } catch (...) {
        failure = std::current_exception();
    }
    if (!fresh.empty() && delayedOk) session->reqMarketDataType(1);
    if (failure) std::rethrow_exception(failure);

    std::vector<OptionMark> out;
    for (size_t i = 0; i < legs.size(); ++i) {
        Stream* s = streams_.find(keys[i]);
        std::optional<TickerData> t;
        if (s) t = s->handle->read();
        if (s) s->usedAt = util::dateNow();
        OptionMark m;
        m.strike = legs[i].strike;
        m.right = legs[i].right;
        if (t) {
            m.bid = t->bid == 0 ? std::optional<double>(0) : price(t->bid);
            m.ask = price(t->ask);
            m.iv = price(t->modelGreeks ? t->modelGreeks->impliedVol : std::nullopt);
            m.error = t->error;
            m.bidSize=t->bidSize; m.askSize=t->askSize; m.marketDataType=t->marketDataType;
            m.bidAt=t->bidAt;m.askAt=t->askAt;m.bidSizeAt=t->bidSizeAt;m.askSizeAt=t->askSizeAt;m.ivAt=t->ivAt;
        }
        out.push_back(std::move(m));
    }
    co_return out;
}

Task<> OptionMarkStreams::waitFor(std::shared_ptr<IbSession> session, std::vector<QString> keys) {
    auto ticks = [this, &keys] {
        std::vector<TickerData> out;
        for (const QString& k : keys) {
            const Stream* s = streams_.find(k);
            if (!s) throw util::JsError(u"Cannot read properties of undefined (reading 'handle')"_s);
            out.push_back(s->handle->read());
        }
        return out;
    };
    auto quoted = [&ticks] {
        for (const TickerData& t : ticks()) {
            if (hasError(t)) continue;
            if (!(price(t.ask) && (t.bid == 0 || price(t.bid)))) return false;
        }
        return true;
    };
    auto withIv = [&ticks] {
        for (const TickerData& t : ticks()) {
            if (hasError(t)) continue;
            if (!price(t.modelGreeks ? t.modelGreeks->impliedVol : std::nullopt)) return false;
        }
        return true;
    };
    double waited = 0, ivWaited = 0;
    co_await session->settle(50);
    while (waited < kQuoteWaitMs) {
        if (quoted()) {
            if (withIv() || ivWaited >= kIvWaitMs) co_return;
            ivWaited += 250;
        }
        co_await session->settle(250);
        waited += 250;
    }
}

}  // namespace ibkr::execution
