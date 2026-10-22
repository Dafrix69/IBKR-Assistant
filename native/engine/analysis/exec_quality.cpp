#include "analysis/exec_quality.h"

#include "analysis/inference.h"
#include "util/collate.h"
#include "util/error.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/py.h"

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::analysis::execquality {

namespace {
std::optional<double> num(const OJson* v) {
    if (!v || v->type == OJson::Null || (v->type == OJson::String && v->s.isEmpty())) return std::nullopt;
    const double out = js::num(v);
    return std::isfinite(out) ? std::optional(out) : std::nullopt;
}
std::optional<double> median(std::vector<double> values) {
    if (values.empty()) return std::nullopt;
    std::stable_sort(values.begin(), values.end());
    const size_t mid = values.size() / 2;
    return values.size() % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}
std::optional<double> mean(const std::vector<double>& values) {
    if (values.empty()) return std::nullopt;
    double s = 0;
    for (double v : values) s = s + v;
    return s / double(values.size());
}
OJson round2(const std::optional<double>& v) { return v ? js::N(util::pyRound(*v, 2)) : OJson::null(); }
QString kindOf(const QString& secType) {
    if (secType == u"STK") return u"stock"_s;
    if (secType == u"BAG") return u"butterfly"_s;
    return u"option"_s;
}
const OJson* path2(const OJson& o, const QString& a, const QString& b) { return js::prop(js::prop(&o, a), b); }

std::optional<double> filledQty(const OJson& record, bool combo) {
    // record.ibkr?.fills ?? []:不是数组时 .filter / .reduce 抛(store 写的总是数组)
    const OJson* f = path2(record, u"ibkr"_s, u"fills"_s);
    static const OJson empty = js::array();
    const OJson& fills = js::nullish(f) ? empty : *f;
    if (fills.type != OJson::Array) throw util::JsError(combo ? u"fills.filter is not a function"_s : u"rows.reduce is not a function"_s);
    double qty = 0;
    for (const OJson& row : fills.items) {
        if (combo) {
            const OJson* sec = js::propStrict(&row, u"sec_type"_s);
            if (!(js::isStr(sec) && sec->s == u"BAG")) continue;
        }
        qty = qty + num(js::propStrict(&row, u"qty"_s)).value_or(0);
    }
    if (qty > 0) return qty;
    if (const auto q = num(path2(record, u"order"_s, u"quantity"_s))) return q;
    return num(path2(record, u"order"_s, u"totalQuantity"_s));
}
}  // namespace

OJson executionRow(const CloseTrace& trace) {
    if (!trace.record || !trace.mark || !(*trace.mark > 0)) return OJson::null();
    const OJson& record = *trace.record;
    const double mark = *trace.mark;
    const auto fill = num(path2(record, u"ibkr"_s, u"avg_fill_price"_s));
    if (!fill || !(*fill > 0)) return OJson::null();
    const QString secType = js::strOr(path2(record, u"contract"_s, u"secType"_s), QString());
    const QString side = js::strOr(path2(record, u"order"_s, u"action"_s), QString()).toUpper();
    if (side != u"BUY" && side != u"SELL") return OJson::null();
    const auto qty = filledQty(record, secType == u"BAG");
    if (!qty || !(*qty > 0)) return OJson::null();
    const double mult = num(path2(record, u"contract"_s, u"multiplier"_s)).value_or(secType == u"STK" ? 1 : 100);
    const double perUnit = side == u"SELL" ? mark - *fill : *fill - mark;
    return js::object({{u"at"_s, js::S(trace.at)},
                       {u"symbol"_s, js::S(trace.symbol)},
                       {u"path"_s, js::S(trace.path)},
                       {u"state"_s, js::S(trace.state)},
                       {u"sec_type"_s, js::S(secType)},
                       {u"side"_s, js::S(side)},
                       {u"mark"_s, js::N(util::pyRound(mark, 4))},
                       {u"fill"_s, js::N(util::pyRound(*fill, 4))},
                       {u"qty"_s, js::N(*qty)},
                       {u"cost_usd"_s, js::N(util::pyRound(perUnit * *qty * mult, 2))},
                       {u"cost_pct"_s, js::N(util::pyRound((perUnit / mark) * 100, 2))},
                       {u"commission_usd"_s, round2(num(path2(record, u"ibkr"_s, u"total_commission"_s)))},
                       {u"paper"_s, js::B(js::truthy(path2(record, u"account"_s, u"is_paper"_s)))}});
}

namespace {
double n(const OJson& row, const char16_t* k) { return row.get(QString::fromUtf16(k))->n; }

OJson groupOf(const QString& secType, const std::vector<OJson>& rows) {
    std::vector<double> pcts, usd;
    double paper = 0;
    for (const OJson& r : rows) {
        pcts.push_back(n(r, u"cost_pct"));
        usd.push_back(n(r, u"cost_usd"));
        if (r.get(u"paper"_s)->b) paper += 1;
    }
    const auto ci = inference::medianInterval(pcts);
    return js::object({{u"sec_type"_s, js::S(secType)},
                       {u"samples"_s, js::N(double(rows.size()))},
                       {u"paper"_s, js::N(paper)},
                       {u"median_pct"_s, round2(median(pcts))},
                       {u"median_ci"_s, ci ? js::object({{u"lo"_s, js::N(util::pyRound(ci->lo, 2))}, {u"hi"_s, js::N(util::pyRound(ci->hi, 2))}}) : OJson::null()},
                       {u"avg_usd"_s, round2(mean(usd))}});
}
}  // namespace

OJson executionCost(const std::vector<CloseTrace>& traces, const ExecutionOptions& opts) {
    const std::optional<double> since = opts.days ? std::optional(opts.now - *opts.days * 86'400'000) : std::nullopt;
    std::vector<OJson> rows;
    double missing = 0;
    for (const CloseTrace& trace : traces) {
        if (since && !(util::jsDateParse(trace.at) >= *since)) continue;
        const OJson* record = trace.record ? &*trace.record : nullptr;
        const bool paper = js::truthy(record ? path2(*record, u"account"_s, u"is_paper"_s) : nullptr);
        const QString secType = js::strOr(record ? path2(*record, u"contract"_s, u"secType"_s) : nullptr, QString());
        if (record) {
            if (opts.scope != u"all" && (opts.scope == u"paper") != paper) continue;
            if (opts.kind != u"all" && kindOf(secType) != opts.kind) continue;
        }
        const OJson row = executionRow(trace);
        if (row.type == OJson::Null) missing += 1;
        else rows.push_back(row);
    }
    std::stable_sort(rows.begin(), rows.end(), [](const OJson& a, const OJson& b) { return a.get(u"at"_s)->s > b.get(u"at"_s)->s; });
    std::vector<double> costs;
    for (const OJson& r : rows) costs.push_back(n(r, u"cost_usd"));
    std::vector<std::pair<QString, std::vector<OJson>>> groups;
    for (const OJson& r : rows) {
        const QString sec = r.get(u"sec_type"_s)->s;
        auto it = std::find_if(groups.begin(), groups.end(), [&](const auto& g) { return g.first == sec; });
        if (it == groups.end()) groups.push_back({sec, {r}});
        else it->second.push_back(r);
    }
    std::vector<OJson> bySec;
    for (const auto& [sec, g] : groups) bySec.push_back(groupOf(sec, g));
    std::stable_sort(bySec.begin(), bySec.end(), [](const OJson& a, const OJson& b) {
        const double d = n(b, u"samples") - n(a, u"samples");
        if (d != 0) return d < 0;
        return util::localeCompare(a.get(u"sec_type"_s)->s, b.get(u"sec_type"_s)->s) < 0;
    });
    std::vector<double> commissions;
    for (const OJson& r : rows)
        if (r.get(u"commission_usd"_s)->type != OJson::Null) commissions.push_back(n(r, u"commission_usd"));
    std::vector<double> pcts;
    if (bySec.size() == 1)
        for (const OJson& r : rows) pcts.push_back(n(r, u"cost_pct"));
    const auto sum = [](const std::vector<double>& v) {
        double s = 0;
        for (double x : v) s = s + x;
        return s;
    };
    double paper = 0;
    for (const OJson& r : rows)
        if (r.get(u"paper"_s)->b) paper += 1;
    OJson bySecJson = js::array(), rowsJson = js::array();
    for (const OJson& g : bySec) bySecJson.items.append(g);
    for (size_t i = 0; i < rows.size() && i < size_t(kMaxExecutionRows); ++i) rowsJson.items.append(rows[i]);
    return js::object({{u"samples"_s, js::N(double(rows.size()))},
                       {u"paper"_s, js::N(paper)},
                       {u"missing"_s, js::N(missing)},
                       {u"total_usd"_s, costs.empty() ? OJson::null() : js::N(util::pyRound(sum(costs), 2))},
                       {u"avg_usd"_s, round2(mean(costs))},
                       {u"commission_usd"_s, commissions.empty() ? OJson::null() : js::N(util::pyRound(sum(commissions), 2))},
                       {u"median_pct"_s, round2(median(pcts))},
                       {u"avg_pct"_s, round2(mean(pcts))},
                       {u"by_sec_type"_s, bySecJson},
                       {u"rows"_s, rowsJson}});
}

}  // namespace ibkr::analysis::execquality
