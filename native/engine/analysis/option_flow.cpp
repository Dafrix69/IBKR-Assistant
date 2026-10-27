#include "analysis/option_flow.h"

#include "util/jsobj.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <tuple>

namespace ibkr::analysis::optionflow {

using namespace Qt::StringLiterals;

namespace {
bool finite(const std::optional<double>& v) { return v && std::isfinite(*v); }
// 期权报价最小跳动 0.05 / 0.10;比较只防浮点尾巴
constexpr double kEps = 1e-9;
}  // namespace

QString sideName(Side side) {
    switch (side) {
    case Side::Buy: return u"buy"_s;
    case Side::Sell: return u"sell"_s;
    case Side::Unknown: break;
    }
    return u"unknown"_s;
}

bool usableQuote(const Quote& q) {
    if (!finite(q.bid) || !finite(q.ask)) return false;
    return *q.bid >= 0 && *q.ask > 0 && *q.ask > *q.bid + kEps;
}

Verdict classify(const Print& p) {
    if (!(p.dv > 0)) return {Side::Unknown, u"no_volume"_s, {}};
    if (!finite(p.last) || !(*p.last > 0)) return {Side::Unknown, u"no_last"_s, {}};
    if (p.marketDataType && *p.marketDataType >= 3) return {Side::Unknown, u"delayed"_s, {}};
    // 成交量涨了但成交时刻没往前走:手里的成交价是上一笔的,拿它分这一笔就是瞎猜
    if (finite(p.lastAt) && finite(p.prevLastAt) && *p.lastAt <= *p.prevLastAt) return {Side::Unknown, u"stale_last"_s, {}};
    const bool prevOk = usableQuote(p.prev), nowOk = usableQuote(p.now);
    if (!prevOk && !nowOk) {
        const auto locked = [](const Quote& q) { return finite(q.bid) && finite(q.ask) && *q.ask > 0 && std::fabs(*q.ask - *q.bid) <= kEps; };
        return {Side::Unknown, locked(p.prev) || locked(p.now) ? u"locked"_s : u"no_quote"_s, {}};
    }
    const Quote& q = prevOk ? p.prev : p.now;
    const QString which = prevOk ? u"prev"_s : u"now"_s;
    const double bid = *q.bid, ask = *q.ask, px = *p.last;
    if (px >= ask - kEps) return {Side::Buy, u"at_ask"_s, which};
    if (px <= bid + kEps) return {Side::Sell, u"at_bid"_s, which};
    const double mid = (bid + ask) / 2;
    if (px > mid + kEps) return {Side::Buy, u"above_mid"_s, which};
    if (px < mid - kEps) return {Side::Sell, u"below_mid"_s, which};
    return {Side::Unknown, u"mid"_s, which};
}

std::vector<bool> spreadLike(const std::vector<Print>& prints, double windowMs) {
    std::vector<bool> out(prints.size(), false);
    std::vector<size_t> order(prints.size());
    for (size_t i = 0; i < order.size(); ++i) order[i] = i;
    std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return prints[a].t < prints[b].t; });
    for (size_t x = 0; x < order.size(); ++x) {
        const Print& a = prints[order[x]];
        if (!(a.dv > 0)) continue;
        for (size_t y = x + 1; y < order.size(); ++y) {
            const Print& b = prints[order[y]];
            if (b.t - a.t > windowMs) break;
            const bool sameContract = a.expiry == b.expiry && a.strike == b.strike && a.right == b.right;
            if (sameContract || std::fabs(a.dv - b.dv) > kEps) continue;
            out[order[x]] = true;
            out[order[y]] = true;
        }
    }
    return out;
}

std::vector<ContractFlow> aggregate(const std::vector<Print>& prints, double windowMs) {
    const std::vector<bool> spread = spreadLike(prints, windowMs);
    // 键升序:到期日、行权价,同一档 "C" < "P"
    std::map<std::tuple<QString, double, QString>, ContractFlow> by;
    for (size_t i = 0; i < prints.size(); ++i) {
        const Print& p = prints[i];
        if (!(p.dv > 0)) continue;
        ContractFlow& f = by[{p.expiry, p.strike, p.right}];
        f.expiry = p.expiry;
        f.strike = p.strike;
        f.right = p.right;
        if (spread[i]) {
            f.spread += p.dv;
            continue;
        }
        switch (classify(p).side) {
        case Side::Buy: f.buy += p.dv; break;
        case Side::Sell: f.sell += p.dv; break;
        case Side::Unknown: f.unknown += p.dv; break;
        }
    }
    std::vector<ContractFlow> out;
    out.reserve(by.size());
    for (auto& [key, f] : by) out.push_back(f);
    return out;
}

std::optional<double> OiCheckRow::coverage() const {
    if (!dayVolume || !(*dayVolume > 0)) return std::nullopt;
    return flow.seen() / *dayVolume;
}

std::optional<double> OiCheckRow::dOi() const {
    if (!oiBefore || !oiAfter) return std::nullopt;
    return *oiAfter - *oiBefore;
}

std::optional<double> OiCheckRow::openShare() const {
    const auto d = dOi();
    if (!d || !dayVolume || !(*dayVolume > 0)) return std::nullopt;
    return std::fabs(*d) / *dayVolume;
}

namespace {
namespace js = util::js;
using util::OJson;
using Key = std::tuple<QString, double, QString>;

std::optional<double> numAt(const OJson& o, const QString& k) {
    const OJson* v = o.get(k);
    if (v && v->type == OJson::Number && std::isfinite(v->n)) return v->n;
    return std::nullopt;
}
QString strAt(const OJson& o, const QString& k) {
    const OJson* v = o.get(k);
    return v && v->type == OJson::String ? v->s : QString();
}
bool kindIs(const OJson& o, const QString& kind) { return strAt(o, u"kind"_s) == kind; }
Key keyOf(const OJson& o) { return {strAt(o, u"expiry"_s), numAt(o, u"k"_s).value_or(0), strAt(o, u"r"_s)}; }
bool hasContract(const OJson& o) { return !strAt(o, u"expiry"_s).isEmpty() && numAt(o, u"k"_s) && !strAt(o, u"r"_s).isEmpty(); }
OJson nOrNull(const std::optional<double>& v) { return v ? js::N(*v) : js::Null(); }
}  // namespace

std::optional<Print> printFrom(const OJson& r) {
    if (r.type != OJson::Object || !kindIs(r, u"print"_s) || !hasContract(r)) return std::nullopt;
    const auto t = numAt(r, u"t"_s), dv = numAt(r, u"dv"_s);
    if (!t || !dv) return std::nullopt;
    Print p;
    p.t = *t;
    p.expiry = strAt(r, u"expiry"_s);
    p.strike = *numAt(r, u"k"_s);
    p.right = strAt(r, u"r"_s);
    p.dv = *dv;
    p.last = numAt(r, u"last"_s);
    p.lastAt = numAt(r, u"lt"_s);
    p.prevLastAt = numAt(r, u"plt"_s);
    p.prev = {numAt(r, u"pb"_s), numAt(r, u"pa"_s)};
    p.now = {numAt(r, u"b"_s), numAt(r, u"a"_s)};
    p.marketDataType = numAt(r, u"mdt"_s);
    return p;
}

OJson oiCheck(const QList<OJson>& day, const QList<OJson>& next, double windowMs) {
    std::vector<Print> prints;
    std::map<Key, OiCheckRow> rows;
    const auto rowOf = [&](const OJson& o) -> OiCheckRow& {
        const Key k = keyOf(o);
        OiCheckRow& row = rows[k];
        row.flow.expiry = std::get<0>(k);
        row.flow.strike = std::get<1>(k);
        row.flow.right = std::get<2>(k);
        return row;
    };
    for (const OJson& o : day) {
        if (!hasContract(o)) continue;
        if (const auto p = printFrom(o)) {
            prints.push_back(*p);
            rowOf(o);
        } else if (kindIs(o, u"vol"_s)) {
            rowOf(o).dayVolume = numAt(o, u"volume"_s);  // 文件里按时刻追加,最后一笔就是最晚的
        } else if (kindIs(o, u"oi"_s)) {
            OiCheckRow& row = rowOf(o);
            if (!row.oiBefore) row.oiBefore = numAt(o, u"oi"_s);
        }
    }
    for (const OJson& o : next) {
        if (!hasContract(o) || !kindIs(o, u"oi"_s)) continue;
        const auto hit = rows.find(keyOf(o));
        if (hit != rows.end() && !hit->second.oiAfter) hit->second.oiAfter = numAt(o, u"oi"_s);
    }
    for (const ContractFlow& f : aggregate(prints, windowMs)) rows[{f.expiry, f.strike, f.right}].flow = f;

    double buy = 0, sell = 0, unknown = 0, spread = 0, volume = 0, seenWithVolume = 0, absDoi = 0, volWithOi = 0;
    OJson out = js::array();
    for (const auto& [key, row] : rows) {
        const ContractFlow& f = row.flow;
        buy += f.buy;
        sell += f.sell;
        unknown += f.unknown;
        spread += f.spread;
        if (row.dayVolume && *row.dayVolume > 0) {
            volume += *row.dayVolume;
            seenWithVolume += f.seen();
            if (const auto d = row.dOi()) {
                absDoi += std::fabs(*d);
                volWithOi += *row.dayVolume;
            }
        }
        out.items.append(js::object({{u"expiry"_s, js::S(f.expiry)},
                                     {u"strike"_s, js::N(f.strike)},
                                     {u"right"_s, js::S(f.right)},
                                     {u"buy"_s, js::N(f.buy)},
                                     {u"sell"_s, js::N(f.sell)},
                                     {u"unknown"_s, js::N(f.unknown)},
                                     {u"spread"_s, js::N(f.spread)},
                                     {u"net"_s, js::N(f.net())},
                                     {u"day_volume"_s, nOrNull(row.dayVolume)},
                                     {u"coverage"_s, nOrNull(row.coverage())},
                                     {u"oi_before"_s, nOrNull(row.oiBefore)},
                                     {u"oi_after"_s, nOrNull(row.oiAfter)},
                                     {u"d_oi"_s, nOrNull(row.dOi())},
                                     {u"open_share"_s, nOrNull(row.openShare())}}));
    }
    const double seen = buy + sell + unknown + spread;
    const auto ratio = [](double a, double b) { return b > 0 ? js::N(a / b) : js::Null(); };
    return js::object({{u"rule"_s, js::S(kRuleVersion)},
                       {u"rows"_s, out},
                       {u"totals"_s, js::object({{u"seen"_s, js::N(seen)},
                                                  {u"buy"_s, js::N(buy)},
                                                  {u"sell"_s, js::N(sell)},
                                                  {u"unknown"_s, js::N(unknown)},
                                                  {u"spread"_s, js::N(spread)},
                                                  {u"day_volume"_s, js::N(volume)},
                                                  {u"coverage"_s, ratio(seenWithVolume, volume)},
                                                  {u"unknown_share"_s, ratio(unknown, seen)},
                                                  {u"spread_share"_s, ratio(spread, seen)},
                                                  {u"buy_share_of_classified"_s, ratio(buy, buy + sell)},
                                                  {u"open_share"_s, ratio(absDoi, volWithOi)}})},
                       {u"note"_s, js::S(u"持仓量变化只说明开仓多还是平仓多,买方主动开仓与卖方主动开仓都让它变大:这张表量的是覆盖率与开仓占比,不检验买卖方向。"_s)}});
}

std::vector<TruthTrade> truthFrom(const QList<OJson>& records) {
    std::map<Key, Quote> quotes;
    std::vector<TruthTrade> out;
    for (const OJson& r : records) {
        if (!kindIs(r, u"tbt"_s) || !hasContract(r)) continue;
        const Key k = keyOf(r);
        const QString type = strAt(r, u"type"_s);
        if (type == u"bidask") {
            quotes[k] = {numAt(r, u"bid"_s), numAt(r, u"ask"_s)};
        } else if (type == u"last") {
            const auto size = numAt(r, u"size"_s), price = numAt(r, u"price"_s), t = numAt(r, u"t"_s);
            if (!size || !price || !t) continue;
            TruthTrade tr;
            tr.t = *t;
            tr.expiry = std::get<0>(k);
            tr.strike = std::get<1>(k);
            tr.right = std::get<2>(k);
            tr.size = *size;
            tr.price = *price;
            const auto q = quotes.find(k);
            if (q != quotes.end()) tr.nbbo = q->second;
            const OJson* u = r.get(u"unrep"_s);
            tr.unreported = u && u->type == OJson::Bool && u->b;
            tr.special = strAt(r, u"cond"_s);
            out.push_back(tr);
        }
    }
    return out;
}

Verdict classifyTruth(const TruthTrade& trade) {
    Print p;
    p.dv = trade.size;
    p.last = trade.price;
    p.prev = trade.nbbo;
    Verdict v = classify(p);
    if (v.quote == u"prev") v.quote = u"tbt"_s;
    return v;
}

OJson accuracy(const QList<OJson>& flowRecords, const QList<OJson>& tbtRecords, double maxLagMs, double windowMs) {
    const std::vector<TruthTrade> truth = truthFrom(tbtRecords);
    std::set<Key> contracts;
    for (const TruthTrade& t : truth) contracts.insert({t.expiry, t.strike, t.right});
    // 组合单配对要看全天所有合约的记盘,不只是这几张
    std::vector<Print> all;
    for (const OJson& r : flowRecords)
        if (const auto p = printFrom(r)) all.push_back(*p);
    const std::vector<bool> spread = spreadLike(all, windowMs);
    std::map<Key, std::vector<size_t>> printsOf;  // 按收到时刻排好
    for (size_t i = 0; i < all.size(); ++i) {
        const Key k{all[i].expiry, all[i].strike, all[i].right};
        if (contracts.count(k)) printsOf[k].push_back(i);
    }
    for (auto& [k, idx] : printsOf) std::stable_sort(idx.begin(), idx.end(), [&](size_t a, size_t b) { return all[a].t < all[b].t; });

    const QStringList truthSides{u"buy"_s, u"sell"_s, u"unknown"_s};
    const QStringList recSides{u"buy"_s, u"sell"_s, u"unknown"_s, u"spread"_s, u"unmatched"_s};
    std::map<QString, std::map<QString, double>> matrix;
    std::map<QString, double> bySpecial;
    std::map<size_t, std::set<QString>> sidesPerPrint;
    struct Net {
        double truth = 0, rec = 0;
    };
    std::map<Key, Net> nets;
    double unreported = 0, total = 0, matchedSize = 0;
    for (const TruthTrade& tr : truth) {
        if (tr.unreported) {
            unreported += tr.size;
            continue;
        }
        total += tr.size;
        if (!tr.special.isEmpty()) bySpecial[tr.special] += tr.size;
        const QString ts = sideName(classifyTruth(tr).side);
        const Key k{tr.expiry, tr.strike, tr.right};
        QString rs = u"unmatched"_s;
        const auto it = printsOf.find(k);
        if (it != printsOf.end()) {
            for (size_t i : it->second) {
                if (all[i].t < tr.t) continue;
                if (all[i].t - tr.t > maxLagMs) break;
                rs = spread[i] ? u"spread"_s : sideName(classify(all[i]).side);
                sidesPerPrint[i].insert(ts);
                matchedSize += tr.size;
                break;
            }
        }
        matrix[ts][rs] += tr.size;
        Net& n = nets[k];
        if (ts == u"buy") n.truth += tr.size;
        if (ts == u"sell") n.truth -= tr.size;
        if (rs == u"buy") n.rec += tr.size;
        if (rs == u"sell") n.rec -= tr.size;
    }
    const auto cell = [&](const QString& a, const QString& b) {
        const auto r = matrix.find(a);
        if (r == matrix.end()) return 0.0;
        const auto c = r->second.find(b);
        return c == r->second.end() ? 0.0 : c->second;
    };
    double agree = 0, both = 0, truthClassified = 0, recClassified = 0, matched = 0;
    for (const QString& a : truthSides)
        for (const QString& b : recSides) {
            const double v = cell(a, b);
            if (b != u"unmatched") matched += v;
            if (a != u"unknown") {
                if (b == u"buy" || b == u"sell") {
                    both += v;
                    if (a == b) agree += v;
                }
                truthClassified += v;
                if (b == u"buy" || b == u"sell") recClassified += v;
            }
        }
    OJson m = js::object();
    for (const QString& a : truthSides) {
        OJson row = js::object();
        for (const QString& b : recSides) row.set(b, js::N(cell(a, b)));
        m.set(a, row);
    }
    OJson specials = js::object();
    for (const auto& [k, v] : bySpecial) specials.set(k, js::N(v));
    double mixed = 0, matchedDv = 0, printDv = 0;
    for (const auto& [i, sides] : sidesPerPrint) {
        matchedDv += all[i].dv;
        if (sides.count(u"buy"_s) && sides.count(u"sell"_s)) mixed += 1;
    }
    for (const auto& [k, idx] : printsOf)
        for (size_t i : idx) printDv += all[i].dv;
    OJson netRows = js::array();
    for (const auto& [k, n] : nets)
        netRows.items.append(js::object({{u"expiry"_s, js::S(std::get<0>(k))},
                                         {u"strike"_s, js::N(std::get<1>(k))},
                                         {u"right"_s, js::S(std::get<2>(k))},
                                         {u"truth_net"_s, js::N(n.truth)},
                                         {u"rec_net"_s, js::N(n.rec)}}));
    const auto ratio = [](double a, double b) { return b > 0 ? js::N(a / b) : js::Null(); };
    return js::object({{u"rule"_s, js::S(kRuleVersion)},
                       {u"contracts"_s, js::N(double(contracts.size()))},
                       {u"trades_volume"_s, js::N(total)},
                       {u"matrix"_s, m},
                       // 两边都分出了买卖的那部分里,方向一致的占比
                       {u"accuracy"_s, ratio(agree, both)},
                       // 真值分得出的张数里,记盘也分得出(没被当成分不出、组合单或没配上)的占比
                       {u"classified_share"_s, ratio(recClassified, truthClassified)},
                       {u"match_share"_s, ratio(matched, total)},
                       {u"unreported"_s, js::N(unreported)},
                       {u"by_special"_s, specials},
                       // 一行记盘里同时并进了买方主动与卖方主动的成交:合并推送整笔分错的来源
                       {u"mixed_prints"_s, js::N(mixed)},
                       {u"matched_prints"_s, js::N(double(sidesPerPrint.size()))},
                       // 量对账:配上的成交张数对配上的记盘行的 dv。差得多 = 配错行(时差)或者累计成交量和逐笔不是一个口径(例如未报告的算不算)
                       {u"volume_check"_s, js::object({{u"matched_trade_size"_s, js::N(matchedSize)},
                                                        {u"matched_print_dv"_s, js::N(matchedDv)},
                                                        {u"truth_size_incl_unreported"_s, js::N(total + unreported)},
                                                        {u"print_dv_same_contracts"_s, js::N(printDv)}})},
                       {u"nets"_s, netRows}});
}

}  // namespace ibkr::analysis::optionflow
