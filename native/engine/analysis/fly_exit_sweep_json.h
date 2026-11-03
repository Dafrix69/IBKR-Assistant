// 蝶式出场参数扫描的结果与统计 → JSON(键序同 TS 里对象字面量的键序)。测试拿它和夹具逐字比,
// 命令行工具 fly-exit-sweep 拿它写 --out。纯函数,只认 analysis 层的结构体。
#pragma once

#include "analysis/fly_exit_sweep_stats.h"
#include "util/jsobj.h"
#include "util/ordered_json.h"

#include <optional>
#include <vector>

namespace ibkr::analysis::sweep {

namespace sweep_json_detail {
using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;
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
}  // namespace sweep_json_detail

using sweep_json_detail::nOrNull;
using sweep_json_detail::strOrNull;
using sweep_json_detail::numArray;
using sweep_json_detail::matrixJson;
using sweep_json_detail::spreadJson;
using sweep_json_detail::populationJson;
using sweep_json_detail::fillJson;
using sweep_json_detail::familyJson;
using sweep_json_detail::resultJson;
using sweep_json_detail::intervalJson;
using sweep_json_detail::indexArray;
using sweep_json_detail::analysisJson;
using sweep_json_detail::verdictJson;
using sweep_json_detail::familySummaryJson;
using sweep_json_detail::summaryJson;

}  // namespace ibkr::analysis::sweep
