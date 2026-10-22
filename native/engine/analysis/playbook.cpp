#include "analysis/playbook.h"

#include "analysis/fly_model.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/py.h"
#include "util/tz.h"

#include <algorithm>
#include <cmath>
#include <limits>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;

namespace ibkr::analysis::playbook {

namespace {
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }
bool same(const std::optional<double>& a, const std::optional<double>& b) {
    // ===:null 对 null 相等;数照 IEEE 比(NaN 不等于自己)
    if (!a || !b) return !a && !b;
    return *a == *b;
}
}  // namespace

double emFactor() {
    static const double f = std::sqrt(M_PI / 2);
    return f;
}

OJson Band::toJson() const {
    return js::object({{u"at"_s, js::N(at)},
                       {u"anchor"_s, js::N(anchor)},
                       {u"strike"_s, js::N(strike)},
                       {u"expiry"_s, js::S(expiry)},
                       {u"call"_s, js::N(call)},
                       {u"put"_s, js::N(put)},
                       {u"source"_s, js::S(source)},
                       {u"em"_s, js::N(em)},
                       {u"lower"_s, js::N(lower)},
                       {u"upper"_s, js::N(upper)}});
}

Band Band::fromJson(const OJson& o) {
    const auto n = [&](const QString& k) { return js::num(js::prop(&o, k)); };
    Band b;
    b.at = n(u"at"_s);
    b.anchor = n(u"anchor"_s);
    b.strike = n(u"strike"_s);
    b.expiry = js::strOr(js::prop(&o, u"expiry"_s), QString());
    b.call = n(u"call"_s);
    b.put = n(u"put"_s);
    b.source = js::strOr(js::prop(&o, u"source"_s), QString());
    b.em = n(u"em"_s);
    b.lower = n(u"lower"_s);
    b.upper = n(u"upper"_s);
    return b;
}

OJson Event::toJson() const {
    return js::object({{u"at"_s, js::N(at)}, {u"kind"_s, js::S(kind)}, {u"state"_s, js::S(state)}, {u"level"_s, js::N(level)}, {u"price"_s, js::N(price)}});
}

OJson Machine::toJson() const {
    OJson f = js::object();
    for (const auto& [k, v] : fired) f.set(k, js::N(v));
    return js::object({{u"state"_s, js::S(state)},
                       {u"trigger"_s, optN(trigger)},
                       {u"since"_s, optN(since)},
                       {u"lost"_s, optN(lost)},
                       {u"accel"_s, accel ? js::object({{u"strike"_s, js::N(accel->strike)}, {u"side"_s, js::S(accel->side)}, {u"armed"_s, js::B(accel->armed)}})
                                         : OJson::null()},
                       {u"fired"_s, f}});
}

std::optional<double> legMid(std::optional<double> bid, std::optional<double> ask) {
    if (!bid || !ask) return std::nullopt;
    if (!std::isfinite(*bid) || !std::isfinite(*ask) || *bid < 0 || *ask <= 0 || *bid > *ask) return std::nullopt;
    return (*bid + *ask) / 2;
}

double atmStrike(double spot, double step) { return util::jsRound(spot / step) * step; }

double expectedMove(double call, double put) { return emFactor() * (call + put); }

std::optional<Band> makeBand(const BandSpec& spec) {
    if (!(spec.anchor > 0) || !(spec.call > 0) || !(spec.put > 0)) return std::nullopt;
    const double em = expectedMove(spec.call, spec.put);
    return Band{spec.at, spec.anchor, spec.strike, spec.expiry, spec.call, spec.put, spec.source, em, spec.anchor - em, spec.anchor + em};
}

std::optional<Band> todayBand(const std::optional<Anchor>& anchor, const std::optional<Band>& current) {
    if (!anchor || !current || !(anchor->price > 0)) return std::nullopt;
    Band b = *current;
    b.anchor = anchor->price;
    b.lower = anchor->price - current->em;
    b.upper = anchor->price + current->em;
    b.source = anchor->source == u"live" && current->source == u"live" ? u"live"_s : u"backfill"_s;
    return b;
}

std::optional<double> wallSpan(double spot, const std::vector<std::optional<double>>& levels) {
    double span = 0;
    for (const auto& level : levels)
        if (level && std::isfinite(*level)) span = jm::max(span, std::fabs(*level - spot));
    return span > 0 ? std::optional(span) : std::nullopt;
}

// ================================================================ 状态机
QString quietKey(const QString& kind, const QString& state, double level) {
    return kind == u"accel" ? u"accel|"_s + state + u'|' + util::jsNumberToString(level) : kind + u'|' + state;
}

Restored restoreMachine(const std::optional<MachineMark>& mark, const std::vector<Event>& events) {
    const Event* last = nullptr;
    for (const Event& e : events)
        if (e.kind != u"accel") last = &e;
    if (mark && (!last || last->at <= mark->at)) return {mark->state, mark->trigger, mark->since, mark->lost};
    if (!last) return {u"none"_s, std::nullopt, std::nullopt, std::nullopt};
    if (last->kind == u"enter") return {last->state, last->level, last->at, std::nullopt};
    return {u"R"_s, std::nullopt, last->at, last->state == u"B2" ? std::optional(last->level) : std::nullopt};
}

std::pair<Machine, std::vector<Event>> stepMachine(const Machine& prev, const MachineInput& input) {
    Machine next = prev;
    std::vector<Event> events;
    const double at = input.at, price = input.price;
    const auto firedAt = [&](const QString& key) -> double {
        for (const auto& [k, v] : next.fired)
            if (k == key) return v;
        return -std::numeric_limits<double>::infinity();
    };
    const auto report = [&](const Event& event) {
        const QString key = quietKey(event.kind, event.state, event.level);
        if (at - firedAt(key) < kQuietMs) return;
        bool found = false;
        for (auto& [k, v] : next.fired)
            if (k == key) {
                v = at;
                found = true;
            }
        if (!found) next.fired.push_back({key, at});
        events.push_back(event);
    };
    const auto become = [&](const QString& state, std::optional<double> trigger) {
        if (state == next.state && same(trigger, next.trigger)) return;
        next.state = state;
        next.trigger = trigger;
        next.since = at;
    };
    const bool below = input.b3 && price < *input.b3;

    // 一、现在这个状态还站不站得住
    if (next.state == u"B3" && next.trigger && price > *next.trigger) {
        report({at, u"invalid"_s, u"B3"_s, *next.trigger, price});
        become(u"R"_s, std::nullopt);
    } else if (next.state == u"B2" && next.trigger && (below || (input.frame && price < *next.trigger))) {
        if (price < *next.trigger) {
            report({at, u"invalid"_s, u"B2"_s, *next.trigger, price});
            next.lost = next.trigger;
        }
        become(u"R"_s, std::nullopt);
    }

    // 二、手上没有状态:看进不进
    if (next.state != u"B2" && next.state != u"B3") {
        if (below && input.b3) {
            become(u"B3"_s, input.b3);
            report({at, u"enter"_s, u"B3"_s, *input.b3, price});
        } else {
            if (input.frame && input.b2 && next.lost && price <= *input.b2) next.lost.reset();  // 回到区间里:重新上膛
            if (input.frame && input.b2 && price > *input.b2 && (!next.lost || price > *next.lost)) {
                next.lost.reset();
                become(u"B2"_s, input.b2);
                report({at, u"enter"_s, u"B2"_s, *input.b2, price});
            } else {
                become(!input.b3 && !input.b2 ? u"none"_s : u"R"_s, std::nullopt);
            }
        }
    }

    // 加速档:换了行权价只登记,不报;穿过去报一次,走开半档再上膛
    if (!input.accelStrike) {
        next.accel.reset();
    } else if (input.price != *input.accelStrike) {
        const double strike = *input.accelStrike;
        const QString side = input.price > strike ? u"above"_s : u"below"_s;
        if (!next.accel || next.accel->strike != strike) {
            next.accel = MachineAccel{strike, side, true};
        } else {
            if (!next.accel->armed && std::fabs(input.price - strike) >= kAccelRearm) next.accel->armed = true;
            if (side != next.accel->side) {
                if (next.accel->armed) {
                    report({input.at, u"accel"_s, next.state, strike, input.price});
                    next.accel->armed = false;
                }
                next.accel->side = side;
            }
        }
    }
    return {next, events};
}

// ================================================================ 目标位与加速档
std::pair<std::optional<double>, std::optional<double>> targets(const QString& state, std::optional<double> trigger, const std::optional<Band>& open,
                                                                const std::vector<WallStrike>& strikes) {
    if (!trigger || (state != u"B2" && state != u"B3")) return {std::nullopt, std::nullopt};
    if (state == u"B2") {
        const std::optional<double> t1 = open && open->upper > *trigger ? std::optional(open->upper) : std::nullopt;
        const double from = t1 ? *t1 : *trigger;
        std::optional<double> t2;
        double best = std::numeric_limits<double>::infinity();
        bool any = false;
        for (const WallStrike& s : strikes)
            if (s.strike > from && s.netGex > 0) {
                best = any ? jm::min(best, s.strike) : s.strike;
                any = true;
            }
        if (any) t2 = best;
        return {t1, t2};
    }
    const std::optional<double> t1 = open && open->lower < *trigger ? std::optional(open->lower) : std::nullopt;
    const double from = t1 ? *t1 : *trigger;
    const double t2 = std::ceil(from / kStrikeStep) * kStrikeStep - kStrikeStep;
    return {t1, t2 > 0 ? std::optional(t2) : std::nullopt};
}

std::optional<Accel> accelerator(const std::vector<WallStrike>& strikes, const std::optional<Band>& band) {
    if (!band) return std::nullopt;
    std::optional<Accel> best;
    for (const WallStrike& s : strikes) {
        if (s.strike < band->lower || s.strike > band->upper || !(s.netGex < 0)) continue;
        if (!best || s.netGex < best->netGex) best = Accel{s.strike, s.netGex};
    }
    return best;
}

// ================================================================ sessionEm.ts
std::optional<double> sessionSigmaOf(const Band& band, const std::vector<double>* weights) {
    const QString et = QString::fromUtf16(util::kET);
    if (!(band.em > 0) || util::dateStrAt(band.at, et).remove(u'-') != band.expiry) return std::nullopt;
    const util::WallParts wall = util::wallParts(band.at, et);
    const double share = remainingShare(weights ? *weights : flyIvModel().variance_weights, wall.hour * 60 + wall.minute + wall.second / 60);
    if (!(share > 0)) return std::nullopt;
    return util::pyRound(band.em / std::sqrt(share), 2);
}

std::optional<SessionEm> sessionEmOf(const QList<OJson>& records, bool earlyClose) {
    if (earlyClose) return std::nullopt;
    const QString et = QString::fromUtf16(util::kET);
    for (const QString& kind : {u"open"_s, u"frame"_s}) {
        // 底账里这两种记录的 band 已经由 playbookLog 核过是数(validBand),这里不再管 null / 原始值
        std::vector<Band> bands;
        for (const OJson& r : records) {
            const OJson* k = r.get(u"kind"_s);
            const OJson* b = r.get(u"band"_s);
            if (js::isStr(k) && k->s == kind && b) bands.push_back(Band::fromJson(*b));
        }
        std::stable_sort(bands.begin(), bands.end(), [](const Band& a, const Band& b) { return a.at < b.at; });
        for (const Band& band : bands) {
            const auto em = sessionSigmaOf(band);
            if (!em) continue;
            const util::WallParts wall = util::wallParts(band.at, et);
            return SessionEm{*em, kind, util::pad2(wall.hour) + u':' + util::pad2(wall.minute)};
        }
    }
    return std::nullopt;
}

}  // namespace ibkr::analysis::playbook
