#include "transport/perf_log.h"

#include "util/collate.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/tz.h"

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::rpc {

using util::OJson;
namespace js = util::js;

QString laneName(Lane lane) {
    switch (lane) {
    case Lane::Local: return u"local"_s;
    case Lane::Read: return u"read"_s;
    case Lane::Trade: return u"trade"_s;
    }
    return {};
}

double quantile(const std::vector<double>& sorted, double q) {
    if (sorted.empty()) return 0;
    const double len = double(sorted.size());
    const double i = util::jsmath::min(len - 1, util::jsmath::max(0, std::ceil(q * len) - 1));
    // sorted[i] ?? 0:q 是 NaN 时下标是 NaN,取到 undefined
    if (std::isnan(i)) return 0;
    return sorted[size_t(i)];
}

std::optional<QString> slowLine(const QString& method, double waitMs, double runMs, double slowMs) {
    if (runMs < slowMs && waitMs < slowMs) return std::nullopt;
    const QString queued = waitMs >= kQueueNoteMs ? u",排队 %1 ms"_s.arg(util::jsNumberToString(util::jsRound(waitMs))) : QString();
    return u"[rpc] 慢请求 %1 %2 ms%3"_s.arg(method, util::jsNumberToString(util::jsRound(runMs)), queued);
}

namespace {

OJson spread(std::vector<double> xs, double max) {
    std::stable_sort(xs.begin(), xs.end(), [](double a, double b) {
        if (std::isnan(a) || std::isnan(b)) return !std::isnan(a) && std::isnan(b);
        return a < b;
    });
    return js::object({
        {u"p50"_s, js::N(util::jsRound(quantile(xs, 0.5)))},
        {u"p90"_s, js::N(util::jsRound(quantile(xs, 0.9)))},
        {u"p99"_s, js::N(util::jsRound(quantile(xs, 0.99)))},
        {u"max"_s, js::N(util::jsRound(max))},
    });
}

}  // namespace

RpcTimings::RpcTimings(double nowMs, std::function<double()> random) : since_(nowMs), random_(std::move(random)) {}

void RpcTimings::record(const QString& method, Lane lane, double waitMs, double runMs) {
    auto at = index_.constFind(method);
    if (at == index_.constEnd()) {
        Bucket fresh;
        fresh.lane = lane;
        buckets_.emplace_back(method, std::move(fresh));
        at = index_.insert(method, qsizetype(buckets_.size()) - 1);
    }
    Bucket& b = buckets_[size_t(at.value())].second;
    b.n += 1;
    b.waitMax = util::jsmath::max(b.waitMax, waitMs);
    b.runMax = util::jsmath::max(b.runMax, runMs);
    if (b.run.size() < size_t(kMaxSamples)) {
        b.wait.push_back(waitMs);
        b.run.push_back(runMs);
        return;
    }
    const double slot = std::floor(random_() * b.n);
    if (slot < kMaxSamples) {
        b.wait.at(size_t(slot)) = waitMs;  // at():槽号永远在 [0, kMaxSamples),越界就是错,不要悄悄写出去
        b.run.at(size_t(slot)) = runMs;
    }
}

OJson RpcTimings::summary() const {
    std::vector<const std::pair<QString, Bucket>*> sorted;
    for (const auto& e : buckets_) sorted.push_back(&e);
    std::stable_sort(sorted.begin(), sorted.end(), [](const auto* a, const auto* z) { return util::localeCompare(a->first, z->first) < 0; });
    OJson out = js::object();
    for (const auto* e : sorted) {
        const Bucket& b = e->second;
        out.set(e->first, js::object({
                              {u"lane"_s, js::S(laneName(b.lane))},
                              {u"n"_s, js::N(b.n)},
                              {u"run"_s, spread(b.run, b.runMax)},
                              {u"wait"_s, spread(b.wait, b.waitMax)},
                          }));
    }
    return out;
}

std::optional<QString> RpcTimings::flush(double nowMs) { return flush(nowMs, js::object()); }

std::optional<QString> RpcTimings::flush(double nowMs, const OJson& extra) {
    const OJson methods = summary();
    const double from = since_;
    buckets_.clear();
    index_.clear();
    since_ = nowMs;
    if (methods.fields.isEmpty()) return std::nullopt;
    const OJson window = js::object({{u"from"_s, js::S(util::isoString(from))}, {u"to"_s, js::S(util::isoString(nowMs))}});
    OJson line = js::object({{u"window"_s, window}, {u"methods"_s, methods}});
    for (const auto& [k, v] : extra.fields) line.set(k, v);
    return u"[perf] "_s + js::stringify(line);
}

}  // namespace ibkr::rpc
