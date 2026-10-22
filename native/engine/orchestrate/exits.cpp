#include "orchestrate/exits.h"

#include "util/jsobj.h"

#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace tk = ibkr::orchestrate::tracker;

namespace ibkr::orchestrate {

std::optional<double> TrackExits::peakMark(const QString& tid, const tk::Position& position, std::optional<double> price, bool confirm) {
    if (!confirm || position.sec_type == u"STK") return price;
    const auto it = marks_.constFind(tid);
    if (it != marks_.cend() && it->round == round_) return it->out;
    const std::optional<double> prev = it != marks_.cend() ? it->cur : std::nullopt;
    std::optional<double> out;
    if (price && prev) out = tk::isLong(position) ? jsx::min(*prev, *price) : jsx::max(*prev, *price);
    marks_.insert(tid, Mark{round_, price, out});
    return out;
}

std::optional<OJson> TrackExits::confirmSpot(const QString& tid, const OJson& targets, const std::optional<OJson>& row, double nowMs) {
    if (!row) return std::nullopt;
    std::optional<analysis::BreachClock> clock;
    if (const auto it = breaches_.constFind(tid); it != breaches_.cend()) clock = *it;
    auto [out, next] = analysis::confirmSpotStop(*row, js::prop(&targets, u"spot_stop_confirm_s"_s), clock, nowMs);
    if (!next) breaches_.remove(tid);
    else breaches_.insert(tid, *next);
    return out;
}

OJson TrackExits::confirmStock(const QString& tid, const OJson& result, bool isLong, const OJson& targets, double nowMs) {
    std::optional<analysis::BreachClock> clock;
    if (const auto it = stockBreaches_.constFind(tid); it != stockBreaches_.cend()) clock = *it;
    auto [out, next] = analysis::confirmStockStop(result, isLong, js::prop(&targets, u"spot_stop_confirm_s"_s), clock, nowMs);
    if (!next) stockBreaches_.remove(tid);
    else stockBreaches_.insert(tid, *next);
    return out;
}

OJson TrackExits::judge(const JudgeArgs& args) {
    const OJson& track = args.track;
    const tk::Position& position = args.position;
    const OJson targets = lapseTimeExit(track, args.targets, args.at.epochMs);
    const QString tid = js::str(js::prop(&track, u"id"_s));
    const bool fallback = args.natural && !*args.natural;  // args.natural === null
    const std::optional<double> stopPrice = !args.natural || fallback ? args.price : *args.natural;
    tk::EvaluateOpts opts;
    opts.hasPeakPrice = true;
    opts.peakPrice = fallback ? std::nullopt : peakMark(tid, position, stopPrice, js::truthy(js::prop(&args.autoClose, u"peak_confirm"_s)));
    if (args.natural) {
        opts.hasStopPrice = true;
        opts.stopPrice = stopPrice;
    }
    const OJson* peak = js::prop(&track, u"peak"_s);
    const OJson evaluated = tk::evaluate(position, targets, args.price, js::nullish(peak) ? std::nullopt : std::optional<double>(js::num(peak)),
                                         args.at.minutes, opts);
    const OJson byPrice = tk::withSpotTriggers(evaluated, js::str(js::prop(&track, u"symbol"_s)), targets, args.spotTarget ? &*args.spotTarget : nullptr,
                                               args.spotStop ? &*args.spotStop : nullptr);
    const OJson confirmed = position.sec_type == u"STK" ? confirmStock(tid, byPrice, tk::isLong(position), targets, args.at.epochMs) : byPrice;
    OJson out = analysis::withTimeExit(analysis::withTier(confirmed, targets, tk::isLong(position)), targets, args.at.epochMs);
    if (fallback) out.set(u"stop_fallback"_s, js::B(true));
    return out;
}

OJson TrackExits::lapseTimeExit(const OJson& track, const OJson& targets, double nowMs) {
    if (!analysis::timeExitLapsed(targets, nowMs)) return targets;
    OJson stored = tk::makeTargets(js::nullish(js::prop(&track, u"targets"_s)) ? js::object() : *js::prop(&track, u"targets"_s));
    stored.set(u"exit_at_ms"_s, js::Null());
    host_.store().updateTrack(js::str(js::prop(&track, u"id"_s)), js::object({{u"targets"_s, stored}}));
    OJson detail = js::object({{u"track"_s, js::copyOrNull(js::prop(&track, u"id"_s))}});
    if (const OJson* s = js::prop(&track, u"symbol"_s)) detail.set(u"symbol"_s, *s);
    if (const OJson* e = js::prop(&targets, u"exit_at"_s)) detail.set(u"exit_at"_s, *e);
    host_.store().audit(u"engine"_s, u"time_exit_lapsed"_s, &detail);
    host_.notifier().warning(js::str(js::prop(&track, u"symbol"_s)) + u" 的到点平仓(美东 "_s + js::strOr(js::prop(&targets, u"exit_at"_s), QString()) +
                             u")已经过期、没有执行:到点那天软件没在盯、休市或被闸门挡着。持仓还在的话请自己处理;要再用,重新设置。"_s);
    OJson out = targets;
    out.set(u"exit_at_ms"_s, js::Null());
    return out;
}

bool TrackExits::warnBlocked(const OJson& track, const QString& state) {
    const QString tid = js::str(js::prop(&track, u"id"_s));
    QSet<QString>& seen = blockedSeen_[tid];
    const bool first = !js::truthy(js::prop(&track, u"fired_state"_s));
    const bool fresh = first || (!seen.isEmpty() && !seen.contains(state));
    seen.insert(state);
    return fresh;
}

OJson TrackExits::tierAuto(const OJson& track, const OJson& targets, const OJson& result, const OJson& autoClose, const tk::Position& position) {
    const OJson* tiersRaw = js::prop(&targets, u"take_profit_tiers"_s);
    const OJson tiers = js::nullish(tiersRaw) ? js::array() : *tiersRaw;
    const OJson* tierIndex = js::prop(&result, u"tier"_s);
    const OJson* tier = tierIndex ? js::prop(&tiers, js::str(tierIndex)) : nullptr;
    if (!tierIndex || !tier) return autoClose;
    OJson stored = tk::makeTargets(js::nullish(js::prop(&track, u"targets"_s)) ? js::object() : *js::prop(&track, u"targets"_s));
    stored.set(u"take_profit_tiers"_s,
               analysis::markTier(tiers, static_cast<int>(tierIndex->n),
                                  js::object({{u"pending"_s, js::B(true)}, {u"pending_qty"_s, js::N(std::fabs(position.quantity))}})));
    host_.store().updateTrack(js::str(js::prop(&track, u"id"_s)), js::object({{u"targets"_s, stored}}));
    OJson out = autoClose;
    if (const OJson* f = js::prop(tier, u"fraction_pct"_s)) out.set(u"close_fraction_pct"_s, *f);
    else out.remove(u"close_fraction_pct"_s);  // 值是 undefined:读起来与没有这个键一样
    return out;
}

void TrackExits::tierNotSent(const OJson& track) {
    const QString tid = js::str(js::prop(&track, u"id"_s));
    const std::optional<OJson> fresh = host_.store().getTrack(tid);
    if (!fresh || js::truthy(js::prop(&*fresh, u"fired_at"_s))) return;
    OJson targets = tk::makeTargets(js::nullish(js::prop(&*fresh, u"targets"_s)) ? js::object() : *js::prop(&*fresh, u"targets"_s));
    const int index = analysis::pendingTier(js::prop(&targets, u"take_profit_tiers"_s));
    if (index < 0) return;
    const OJson* tiers = js::prop(&targets, u"take_profit_tiers"_s);
    targets.set(u"take_profit_tiers"_s, analysis::markTier(js::nullish(tiers) ? js::array() : *tiers, index, js::object()));
    host_.store().updateTrack(tid, js::object({{u"targets"_s, targets}}));
}

bool TrackExits::rearmTier(const OJson& track, const tk::Position& position) {
    OJson targets = tk::makeTargets(js::nullish(js::prop(&track, u"targets"_s)) ? js::object() : *js::prop(&track, u"targets"_s));
    const OJson* tiersRaw = js::prop(&targets, u"take_profit_tiers"_s);
    const int index = analysis::pendingTier(tiersRaw);
    const std::optional<QString> sweep = tk::sweepReason(track);
    const OJson firedValue = sweep ? js::S(*sweep) : js::copyOrNull(js::prop(&track, u"fired_state"_s));
    if (index < 0 || js::truthy(js::prop(&track, u"enabled"_s)) || !(firedValue.type == OJson::String && firedValue.s == tk::kStateTakeProfit)) return false;
    const QString recordId = js::strOr(js::prop(&track, u"fired_record"_s), QString());
    if (recordId.isEmpty()) return false;
    const std::optional<OJson> record = host_.store().getRecord(recordId);
    const OJson* finalStatus = record ? js::prop(&*record, u"final_status"_s) : nullptr;
    if (!(js::isStr(finalStatus) && finalStatus->s == u"filled")) return false;
    const OJson tiersNow = js::nullish(tiersRaw) ? js::array() : *tiersRaw;
    const OJson* before = js::path(&tiersNow, {QString::number(index), u"pending_qty"_s});
    if (before && !(std::fabs(position.quantity) < js::num(before))) return false;
    const OJson tiers = analysis::markTier(tiersNow, index, js::object({{u"done"_s, js::B(true)}}));
    OJson fields = js::object({{u"targets"_s, [&] {
                                    OJson t = targets;
                                    t.set(u"take_profit_tiers"_s, tiers);
                                    return t;
                                }()},
                               {u"enabled"_s, js::B(true)},
                               {u"fired_at"_s, js::Null()},
                               {u"fired_state"_s, js::S(QString())},
                               {u"fired_record"_s, js::S(QString())}});
    const QString tid = js::str(js::prop(&track, u"id"_s));
    host_.store().updateTrack(tid, fields);
    OJson detail = js::object({{u"track"_s, js::copyOrNull(js::prop(&track, u"id"_s))}});
    if (const OJson* s = js::prop(&track, u"symbol"_s)) detail.set(u"symbol"_s, *s);
    detail.set(u"tier"_s, js::N(index + 1));
    detail.set(u"record"_s, js::S(recordId));
    host_.store().audit(u"engine"_s, u"tier_rearm"_s, &detail);
    int left = 0;
    for (const OJson& t : tiers.items)
        if (!js::truthy(js::prop(&t, u"done"_s))) ++left;
    host_.notifier().notify(u"分批止盈"_s, js::str(js::prop(&track, u"symbol"_s)) + u":第 "_s + QString::number(index + 1) + u" 档已成交,"_s +
                                              (left ? u"还有 "_s + QString::number(left) + u" 档" : u"各档都做完了"_s) + u",剩下的仓接着盯"_s);
    return true;
}

void TrackExits::forget(const QSet<QString>& alive) {
    for (const QString& tid : QList<QString>(marks_.keys()))
        if (!alive.contains(tid)) marks_.remove(tid);
    for (const QString& tid : QList<QString>(breaches_.keys()))
        if (!alive.contains(tid)) breaches_.remove(tid);
    for (const QString& tid : QList<QString>(stockBreaches_.keys()))
        if (!alive.contains(tid)) stockBreaches_.remove(tid);
    for (const QString& tid : QList<QString>(blockedSeen_.keys()))
        if (!alive.contains(tid)) blockedSeen_.remove(tid);
}

}  // namespace ibkr::orchestrate
