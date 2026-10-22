// sweep 组的四个测试共用:夹具里的 JSON ↔ 结构体、递给 runSweep 的"判定函数"(orchestrate::tracker 的那几个纯函数)。
// 只在测试里用;JSON 的键序与 TS 里对象字面量的键序一致(逐字比时按它)。
#pragma once

#include "analysis/fly_exit_sweep.h"
#include "analysis/fly_exit_sweep_report.h"
#include "analysis/fly_exit_sweep_stats.h"
#include "js_fixture.h"
#include "orchestrate/tracker.h"

#include <QString>

#include <cmath>

namespace sweepfix {

using namespace ibkr::analysis::sweep;
using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace tracker = ibkr::orchestrate::tracker;

// ---------------------------------------------------------------- 判定函数
/// TS 里 `import * as tracker` 整个模块递进去;这里是同一批纯函数
class TrackerAdapter : public TrackerRules {
public:
    QString stateHolding() const override { return tracker::kStateHolding; }
    std::any makePosition(const OJson& raw) const override { return tracker::makePosition(raw); }
    OJson makeTargets(const OJson& raw) const override { return tracker::makeTargets(raw); }
    std::optional<std::any> structureOf(const QString& secType, const OJson& contract) const override {
        auto s = tracker::structureOf(secType, &contract);
        if (!s) return std::nullopt;
        return std::any(*s);
    }
    QString legPriceKey(double strike, const QString& right) const override { return tracker::legPriceKey(strike, right); }
    std::optional<double> naturalClosePrice(const std::any& position, const std::any& structure, const OJson& book) const override {
        return tracker::naturalClosePrice(std::any_cast<const tracker::Position&>(position), std::any_cast<const tracker::TargetStructure&>(structure), book);
    }
    double closeTick(const std::any& position) const override { return tracker::closeTick(std::any_cast<const tracker::Position&>(position)); }
    void validate(const std::any& position, const OJson& targets, std::optional<double> price) const override {
        tracker::validate(std::any_cast<const tracker::Position&>(position), targets, price);
    }
    OJson evaluate(const std::any& position, const OJson& targets, std::optional<double> price, std::optional<double> peak, std::optional<double> minute,
                   const EvalOpts& opts) const override {
        tracker::EvaluateOpts o;
        o.hasStopPrice = opts.hasStopPrice;
        o.stopPrice = opts.stopPrice;
        return tracker::evaluate(std::any_cast<const tracker::Position&>(position), targets, price, peak, minute, o);
    }
};

// ---------------------------------------------------------------- JSON → 结构体
inline std::optional<double> optNum(const OJson* v) {
    if (js::nullish(v)) return std::nullopt;
    return v->n;
}
inline std::optional<QString> optStr(const OJson* v) {
    if (js::nullish(v)) return std::nullopt;
    return v->s;
}
inline QString strOf(const OJson* v) { return v ? v->s : QString(); }
inline double numOf(const OJson* v) { return v ? v->n : std::nan(""); }

inline LiveParams liveFromJson(const OJson& o) {
    LiveParams p;
    p.arm_usd = numOf(o.get(u"arm_usd"_s));
    p.tighten_usd = numOf(o.get(u"tighten_usd"_s));
    p.loose_pct = numOf(o.get(u"loose_pct"_s));
    p.mid_pct = numOf(o.get(u"mid_pct"_s));
    p.tight_pct = numOf(o.get(u"tight_pct"_s));
    p.tight_at = numOf(o.get(u"tight_at"_s));
    p.late_after = strOf(o.get(u"late_after"_s));
    p.late_factor = numOf(o.get(u"late_factor"_s));
    p.floor = numOf(o.get(u"floor"_s));
    p.stop_mult = optNum(o.get(u"stop_mult"_s));
    p.exit_at = optStr(o.get(u"exit_at"_s));
    return p;
}

inline QuoteSample sampleFromJson(const OJson& o) {
    QuoteSample s;
    s.t = o.get(u"t"_s)->n;
    s.spot = o.get(u"spot"_s)->n;
    s.by = optStr(o.get(u"by"_s));
    s.expiry = optStr(o.get(u"expiry"_s));
    s.symbol = optStr(o.get(u"symbol"_s));
    for (const OJson& l : o.get(u"legs"_s)->items) {
        QuoteLeg leg;
        leg.strike = l.get(u"strike"_s)->n;
        leg.right = l.get(u"right"_s)->s;
        leg.bid = optNum(l.get(u"bid"_s));
        leg.ask = optNum(l.get(u"ask"_s));
        s.legs.push_back(leg);
    }
    return s;
}

inline FlySpec flyFromJson(const OJson& o) { return {o.get(u"center"_s)->n, o.get(u"wing"_s)->n, o.get(u"right"_s)->s}; }

inline Population populationFromJson(const OJson& o) {
    Population p;
    p.by = o.get(u"by"_s)->s;
    p.entry_from = optStr(o.get(u"entry_from"_s));
    p.entry_to = optStr(o.get(u"entry_to"_s));
    if (const OJson* w = o.get(u"wings"_s); !js::nullish(w)) {
        p.wings.emplace();
        for (const OJson& x : w->items) p.wings->push_back(x.n);
    }
    if (const OJson* r = o.get(u"rights"_s); !js::nullish(r)) {
        p.rights.emplace();
        for (const OJson& x : r->items) p.rights->push_back(x.s);
    }
    p.debit_min = optNum(o.get(u"debit_min"_s));
    p.debit_max = optNum(o.get(u"debit_max"_s));
    p.dist_min = optNum(o.get(u"dist_min"_s));
    p.dist_max = optNum(o.get(u"dist_max"_s));
    return p;
}

inline FillModel fillFromJson(const OJson& o) {
    FillModel f;
    f.entry_spread_share = o.get(u"entry_spread_share"_s)->n;
    f.commission = optNum(o.get(u"commission"_s));
    f.terminal = o.get(u"terminal"_s)->s;
    f.settle_within_min = o.get(u"settle_within_min"_s)->n;
    f.stop_basis = o.get(u"stop_basis"_s)->s;
    f.qty = o.get(u"qty"_s)->n;
    f.multiplier = o.get(u"multiplier"_s)->n;
    return f;
}

inline SweepConfig configFromJson(const OJson& o) {
    SweepConfig c;
    c.symbol = optStr(o.get(u"symbol"_s));
    c.population = populationFromJson(*o.get(u"population"_s));
    if (const OJson* e = o.get(u"entries"_s); !js::nullish(e)) {
        c.entries.emplace();
        for (const OJson& x : e->items) {
            RealEntry r;
            r.t = x.get(u"t"_s)->n;
            r.center = x.get(u"center"_s)->n;
            r.wing = x.get(u"wing"_s)->n;
            r.right = x.get(u"right"_s)->s;
            r.quantity = optNum(x.get(u"quantity"_s));
            r.debit = optNum(x.get(u"debit"_s));
            c.entries->push_back(r);
        }
    }
    c.fill = fillFromJson(*o.get(u"fill"_s));
    for (const OJson& p : o.get(u"live"_s)->items) c.live.push_back(liveFromJson(p));
    if (const OJson* r = o.get(u"replay"_s); !js::nullish(r)) {
        ReplayConfig rc;
        const OJson* em = r->get(u"em"_s);
        rc.emAuto = em->type == OJson::String;
        rc.em = rc.emAuto ? 0 : em->n;
        for (const OJson& s : r->get(u"sets"_s)->items) rc.sets.push_back(s);
        c.replay = rc;
    }
    c.stride = o.get(u"stride"_s)->n;
    return c;
}

// ---------------------------------------------------------------- 结构体 → JSON
inline OJson nOrNull(const std::optional<double>& v) { return js::NOrNull(v); }
inline OJson strOrNull(const std::optional<QString>& v) { return v ? js::S(*v) : OJson::null(); }
inline OJson numArray(const std::vector<double>& xs) {
    OJson a = js::array();
    for (const double x : xs) a.items.append(js::N(x));
    return a;
}
inline OJson matrixJson(const std::vector<std::vector<double>>& m) {
    OJson a = js::array();
    for (const auto& row : m) a.items.append(numArray(row));
    return a;
}
inline OJson spreadJson(const std::optional<Spread>& s) {
    return s ? js::object({{u"min"_s, js::N(s->min)}, {u"median"_s, js::N(s->median)}, {u"max"_s, js::N(s->max)}}) : OJson::null();
}

inline OJson populationJson(const Population& p) {
    OJson wings = OJson::null(), rights = OJson::null();
    if (p.wings) wings = numArray(*p.wings);
    if (p.rights) {
        rights = js::array();
        for (const QString& r : *p.rights) rights.items.append(js::S(r));
    }
    return js::object({{u"by"_s, js::S(p.by)},
                       {u"entry_from"_s, strOrNull(p.entry_from)},
                       {u"entry_to"_s, strOrNull(p.entry_to)},
                       {u"wings"_s, wings},
                       {u"rights"_s, rights},
                       {u"debit_min"_s, nOrNull(p.debit_min)},
                       {u"debit_max"_s, nOrNull(p.debit_max)},
                       {u"dist_min"_s, nOrNull(p.dist_min)},
                       {u"dist_max"_s, nOrNull(p.dist_max)}});
}
inline OJson fillJson(const FillModel& f) {
    return js::object({{u"entry_spread_share"_s, js::N(f.entry_spread_share)},
                       {u"commission"_s, nOrNull(f.commission)},
                       {u"terminal"_s, js::S(f.terminal)},
                       {u"settle_within_min"_s, js::N(f.settle_within_min)},
                       {u"stop_basis"_s, js::S(f.stop_basis)},
                       {u"qty"_s, js::N(f.qty)},
                       {u"multiplier"_s, js::N(f.multiplier)}});
}

inline OJson familyJson(const FamilyResult& f) {
    OJson params = js::array(), kinds = js::array();
    for (const OJson& p : f.params) params.items.append(p);
    for (const OJson& k : f.kinds) kinds.items.append(k);
    const auto mat = [](const Matrix& m) { return js::object({{u"r"_s, matrixJson(m.r)}, {u"usd"_s, matrixJson(m.usd)}}); };
    return js::object({{u"family"_s, js::S(f.family)},
                       {u"labels"_s, js::strings(f.labels)},
                       {u"params"_s, params},
                       {u"days"_s, js::strings(f.days)},
                       {u"scenarios"_s, numArray(f.scenarios)},
                       {u"main"_s, mat(f.main)},
                       {u"alt_terminal"_s, mat(f.alt_terminal)},
                       {u"coarse"_s, mat(f.coarse)},
                       {u"kinds"_s, kinds},
                       {u"stop_refused"_s, numArray(f.stop_refused)}});
}

inline OJson resultJson(const SweepResult& r) {
    OJson lossCap = OJson::null();
    if (r.loss_cap)
        lossCap = js::object({{u"usd"_s, js::N(r.loss_cap->usd)}, {u"r"_s, js::N(r.loss_cap->r)}, {u"wing"_s, js::N(r.loss_cap->wing)},
                              {u"debit_floor"_s, js::N(r.loss_cap->debit_floor)}});
    OJson replay = OJson::null();
    if (r.replay) {
        replay = familyJson(r.replay->family);
        replay.set(u"em"_s, spreadJson(r.replay->em));
        replay.set(u"days_without_em"_s, js::N(r.replay->days_without_em));
    }
    return js::object({{u"data"_s, js::object({{u"days"_s, js::N(r.data.days)},
                                               {u"first"_s, strOrNull(r.data.first)},
                                               {u"last"_s, strOrNull(r.data.last)},
                                               {u"samples"_s, js::N(r.data.samples)},
                                               {u"used"_s, js::N(r.data.used)},
                                               {u"not_same_day"_s, js::N(r.data.not_same_day)},
                                               {u"other_symbol"_s, js::N(r.data.other_symbol)}})},
                       {u"symbol"_s, strOrNull(r.symbol)},
                       {u"population"_s, populationJson(r.population)},
                       {u"fill"_s, fillJson(r.fill)},
                       {u"stride"_s, js::N(r.stride)},
                       {u"from_entries"_s, js::B(r.from_entries)},
                       {u"scenarios"_s, js::N(r.scenarios)},
                       {u"skipped"_s, r.skipped},
                       {u"filtered"_s, r.filtered},
                       {u"no_decision"_s, js::object({{u"missing"_s, js::N(r.no_decision_missing)}, {u"total"_s, js::N(r.no_decision_total)}})},
                       {u"debit"_s, spreadJson(r.debit)},
                       {u"wings"_s, r.wings},
                       {u"short_days"_s, js::N(r.short_days)},
                       {u"loss_cap"_s, lossCap},
                       {u"live"_s, familyJson(r.live)},
                       {u"replay"_s, replay}});
}

inline OJson intervalJson(const std::optional<Interval>& i) {
    if (!i) return OJson::null();
    return js::array({nOrNull(i->lo), nOrNull(i->hi)});
}
inline OJson indexArray(const std::vector<size_t>& v) {
    OJson a = js::array();
    for (const size_t i : v) a.items.append(js::N(double(i)));
    return a;
}
inline OJson analysisJson(const Analysis& a) {
    OJson sets = js::array();
    for (const SetStat& s : a.sets)
        sets.items.append(js::object({{u"mean"_s, js::N(s.mean)},
                                      {u"diff"_s, js::N(s.diff)},
                                      {u"se"_s, nOrNull(s.se)},
                                      {u"wins"_s, js::N(s.wins)},
                                      {u"losses"_s, js::N(s.losses)},
                                      {u"ties"_s, js::N(s.ties)},
                                      {u"halves"_s, js::array({nOrNull(s.halves[0]), nOrNull(s.halves[1])})},
                                      {u"degenerate"_s, js::N(s.degenerate)},
                                      {u"eligible"_s, js::B(s.eligible)},
                                      {u"ci"_s, intervalJson(s.ci)},
                                      {u"band"_s, intervalJson(s.band)},
                                      {u"exact"_s, intervalJson(s.exact)},
                                      {u"unseen"_s, nOrNull(s.unseen)},
                                      {u"seen"_s, nOrNull(s.seen)},
                                      {u"breakeven"_s, nOrNull(s.breakeven)},
                                      {u"days_needed"_s, nOrNull(s.days_needed)}}));
    OJson split = js::array();
    for (const SplitHalf& h : a.split)
        split.items.append(js::object({{u"picked_on"_s, js::S(h.picked_on)},
                                       {u"picked"_s, h.picked ? js::N(double(*h.picked)) : OJson::null()},
                                       {u"in_sample"_s, nOrNull(h.in_sample)},
                                       {u"held_out"_s, nOrNull(h.held_out)},
                                       {u"held_out_days"_s, js::N(h.held_out_days)},
                                       {u"wins"_s, js::N(h.wins)},
                                       {u"losses"_s, js::N(h.losses)},
                                       {u"ci"_s, intervalJson(h.ci)}}));
    return js::object({{u"days"_s, js::N(a.days)},
                       {u"level"_s, js::N(a.level)},
                       {u"draws"_s, js::N(a.draws)},
                       {u"seed"_s, js::N(a.seed)},
                       {u"cap"_s, nOrNull(a.cap)},
                       {u"sets"_s, sets},
                       {u"reference"_s, js::N(double(a.reference))},
                       {u"eligible"_s, js::N(a.eligible)},
                       {u"critical"_s, intervalJson(a.critical)},
                       {u"top"_s, a.top ? js::N(double(*a.top)) : OJson::null()},
                       {u"ahead"_s, indexArray(a.ahead)},
                       {u"behind"_s, indexArray(a.behind)},
                       {u"better"_s, indexArray(a.better)},
                       {u"worse"_s, indexArray(a.worse)},
                       {u"alpha_tail"_s, nOrNull(a.alpha_tail)},
                       {u"min_days"_s, nOrNull(a.min_days)},
                       {u"split"_s, split}});
}
inline OJson verdictJson(const Verdict& v) {
    return js::object({{u"state"_s, js::S(v.state)}, {u"set"_s, v.set ? js::N(double(*v.set)) : OJson::null()}, {u"failed"_s, js::strings(v.failed)}});
}
inline OJson familySummaryJson(const FamilySummary& s) {
    return js::object({{u"family"_s, js::S(s.family)},
                       {u"objective"_s, js::S(s.objective)},
                       {u"primary"_s, analysisJson(s.primary)},
                       {u"secondary"_s, analysisJson(s.secondary)},
                       {u"coarse"_s, numArray(s.coarse)},
                       {u"alt_terminal"_s, numArray(s.alt_terminal)},
                       {u"verdict"_s, verdictJson(s.verdict)}});
}
inline OJson summaryJson(const Summary& s) {
    return js::object({{u"objective"_s, js::S(s.objective)},
                       {u"level"_s, js::N(s.level)},
                       {u"draws"_s, js::N(s.draws)},
                       {u"seed"_s, js::N(s.seed)},
                       {u"live"_s, familySummaryJson(s.live)},
                       {u"replay"_s, s.replay ? familySummaryJson(*s.replay) : OJson::null()}});
}

// ---------------------------------------------------------------- JSON → 结果与统计(report / verdict 的输入)
inline std::vector<double> numsOf(const OJson* a) {
    std::vector<double> out;
    if (a)
        for (const OJson& x : a->items) out.push_back(x.type == OJson::Number ? x.n : std::nan(""));
    return out;
}
inline std::vector<std::vector<double>> matrixOf(const OJson* a) {
    std::vector<std::vector<double>> out;
    if (a)
        for (const OJson& row : a->items) out.push_back(numsOf(&row));
    return out;
}
inline std::optional<Spread> spreadFrom(const OJson* o) {
    if (js::nullish(o)) return std::nullopt;
    return Spread{o->get(u"min"_s)->n, o->get(u"median"_s)->n, o->get(u"max"_s)->n};
}
inline FamilyResult familyFromJson(const OJson& o) {
    FamilyResult f;
    f.family = o.get(u"family"_s)->s;
    for (const OJson& x : o.get(u"labels"_s)->items) f.labels << x.s;
    for (const OJson& x : o.get(u"params"_s)->items) f.params.push_back(x);
    for (const OJson& x : o.get(u"days"_s)->items) f.days << x.s;
    f.scenarios = numsOf(o.get(u"scenarios"_s));
    const auto mat = [&](const QString& k) {
        const OJson* m = o.get(k);
        return Matrix{matrixOf(m->get(u"r"_s)), matrixOf(m->get(u"usd"_s))};
    };
    f.main = mat(u"main"_s);
    f.alt_terminal = mat(u"alt_terminal"_s);
    f.coarse = mat(u"coarse"_s);
    for (const OJson& x : o.get(u"kinds"_s)->items) f.kinds.push_back(x);
    f.stop_refused = numsOf(o.get(u"stop_refused"_s));
    return f;
}
inline SweepResult resultFromJson(const OJson& o) {
    SweepResult r;
    const OJson* d = o.get(u"data"_s);
    r.data.days = d->get(u"days"_s)->n;
    r.data.first = optStr(d->get(u"first"_s));
    r.data.last = optStr(d->get(u"last"_s));
    r.data.samples = d->get(u"samples"_s)->n;
    r.data.used = d->get(u"used"_s)->n;
    r.data.not_same_day = d->get(u"not_same_day"_s)->n;
    r.data.other_symbol = d->get(u"other_symbol"_s)->n;
    r.symbol = optStr(o.get(u"symbol"_s));
    r.population = populationFromJson(*o.get(u"population"_s));
    r.fill = fillFromJson(*o.get(u"fill"_s));
    r.stride = o.get(u"stride"_s)->n;
    r.from_entries = o.get(u"from_entries"_s)->b;
    r.scenarios = o.get(u"scenarios"_s)->n;
    r.skipped = *o.get(u"skipped"_s);
    r.filtered = *o.get(u"filtered"_s);
    r.no_decision_missing = o.get(u"no_decision"_s)->get(u"missing"_s)->n;
    r.no_decision_total = o.get(u"no_decision"_s)->get(u"total"_s)->n;
    r.debit = spreadFrom(o.get(u"debit"_s));
    r.wings = *o.get(u"wings"_s);
    r.short_days = o.get(u"short_days"_s)->n;
    if (const OJson* c = o.get(u"loss_cap"_s); !js::nullish(c))
        r.loss_cap = LossCap{c->get(u"usd"_s)->n, c->get(u"r"_s)->n, c->get(u"wing"_s)->n, c->get(u"debit_floor"_s)->n};
    r.live = familyFromJson(*o.get(u"live"_s));
    if (const OJson* rp = o.get(u"replay"_s); !js::nullish(rp))
        r.replay = ReplayResult{familyFromJson(*rp), spreadFrom(rp->get(u"em"_s)), rp->get(u"days_without_em"_s)->n};
    return r;
}

inline std::optional<Interval> intervalFrom(const OJson* a) {
    if (js::nullish(a)) return std::nullopt;
    return Interval{optNum(&a->items[0]), optNum(&a->items[1])};
}
inline std::vector<size_t> indexesOf(const OJson* a) {
    std::vector<size_t> out;
    for (const OJson& x : a->items) out.push_back(size_t(x.n));
    return out;
}
inline Analysis analysisFromJson(const OJson& o) {
    Analysis a;
    a.days = o.get(u"days"_s)->n;
    a.level = o.get(u"level"_s)->n;
    a.draws = o.get(u"draws"_s)->n;
    a.seed = o.get(u"seed"_s)->n;
    a.cap = optNum(o.get(u"cap"_s));
    for (const OJson& s : o.get(u"sets"_s)->items) {
        SetStat t;
        t.mean = s.get(u"mean"_s)->n;
        t.diff = s.get(u"diff"_s)->n;
        t.se = optNum(s.get(u"se"_s));
        t.wins = s.get(u"wins"_s)->n;
        t.losses = s.get(u"losses"_s)->n;
        t.ties = s.get(u"ties"_s)->n;
        const OJson* h = s.get(u"halves"_s);
        t.halves = {optNum(&h->items[0]), optNum(&h->items[1])};
        t.degenerate = s.get(u"degenerate"_s)->n;
        t.eligible = s.get(u"eligible"_s)->b;
        t.ci = intervalFrom(s.get(u"ci"_s));
        t.band = intervalFrom(s.get(u"band"_s));
        t.exact = intervalFrom(s.get(u"exact"_s));
        t.unseen = optNum(s.get(u"unseen"_s));
        t.seen = optNum(s.get(u"seen"_s));
        t.breakeven = optNum(s.get(u"breakeven"_s));
        t.days_needed = optNum(s.get(u"days_needed"_s));
        a.sets.push_back(t);
    }
    a.reference = size_t(o.get(u"reference"_s)->n);
    a.eligible = o.get(u"eligible"_s)->n;
    a.critical = intervalFrom(o.get(u"critical"_s));
    if (const OJson* t = o.get(u"top"_s); !js::nullish(t)) a.top = size_t(t->n);
    a.ahead = indexesOf(o.get(u"ahead"_s));
    a.behind = indexesOf(o.get(u"behind"_s));
    a.better = indexesOf(o.get(u"better"_s));
    a.worse = indexesOf(o.get(u"worse"_s));
    a.alpha_tail = optNum(o.get(u"alpha_tail"_s));
    a.min_days = optNum(o.get(u"min_days"_s));
    for (const OJson& s : o.get(u"split"_s)->items) {
        SplitHalf h;
        h.picked_on = s.get(u"picked_on"_s)->s;
        if (const OJson* p = s.get(u"picked"_s); !js::nullish(p)) h.picked = size_t(p->n);
        h.in_sample = optNum(s.get(u"in_sample"_s));
        h.held_out = optNum(s.get(u"held_out"_s));
        h.held_out_days = s.get(u"held_out_days"_s)->n;
        h.wins = s.get(u"wins"_s)->n;
        h.losses = s.get(u"losses"_s)->n;
        h.ci = intervalFrom(s.get(u"ci"_s));
        a.split.push_back(h);
    }
    return a;
}
inline Verdict verdictFromJson(const OJson& o) {
    Verdict v;
    v.state = o.get(u"state"_s)->s;
    if (const OJson* s = o.get(u"set"_s); !js::nullish(s)) v.set = size_t(s->n);
    for (const OJson& x : o.get(u"failed"_s)->items) v.failed << x.s;
    return v;
}
inline FamilySummary familySummaryFromJson(const OJson& o) {
    FamilySummary s;
    s.family = o.get(u"family"_s)->s;
    s.objective = o.get(u"objective"_s)->s;
    s.primary = analysisFromJson(*o.get(u"primary"_s));
    s.secondary = analysisFromJson(*o.get(u"secondary"_s));
    s.coarse = numsOf(o.get(u"coarse"_s));
    s.alt_terminal = numsOf(o.get(u"alt_terminal"_s));
    s.verdict = verdictFromJson(*o.get(u"verdict"_s));
    return s;
}
inline Summary summaryFromJson(const OJson& o) {
    Summary s;
    s.objective = o.get(u"objective"_s)->s;
    s.level = o.get(u"level"_s)->n;
    s.draws = o.get(u"draws"_s)->n;
    s.seed = o.get(u"seed"_s)->n;
    s.live = familySummaryFromJson(*o.get(u"live"_s));
    if (const OJson* r = o.get(u"replay"_s); !js::nullish(r)) s.replay = familySummaryFromJson(*r);
    return s;
}
inline BootOptions bootFromJson(const OJson& o) {
    BootOptions b;
    b.level = o.get(u"level"_s)->n;
    b.draws = o.get(u"draws"_s)->n;
    const OJson* seed = o.get(u"seed"_s);
    b.seed = seed->type == OJson::Number ? seed->n : std::nan("");  // JS 的 'x' >>> 0 是 0,和 NaN 一样
    b.cap = optNum(o.get(u"cap"_s));
    return b;
}

}  // namespace sweepfix
