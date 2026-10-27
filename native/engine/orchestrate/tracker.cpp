#include "orchestrate/tracker.h"

#include "analysis/fly_model.h"
#include "analysis/flyexit.h"
#include "analysis/tracker_rules.h"
#include "domain/models.h"
#include "domain/positions.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/py.h"

#include <algorithm>
#include <cmath>
#include <limits>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;
namespace fx = ibkr::analysis::flyexit;

namespace ibkr::orchestrate::tracker {

namespace {
/// === null(undefined 不算)
bool isNull(const OJson* v) { return v && v->type == OJson::Null; }
std::optional<double> fin(const OJson* v) { return js::finiteOrNull(v); }
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }
const OJson* get(const OJson& o, const char16_t* k) { return js::prop(&o, QString::fromUtf16(k)); }
double R(double v, int nd) { return util::pyRound(v, nd); }
QString F(double v, int nd) { return util::fmtF(v, nd); }
QString G(double v) { return util::pyG(v); }
/// (x ?? []).length 为真
bool hasLength(const OJson* v) {
    if (js::nullish(v)) return false;
    if (v->type == OJson::Array) return !v->items.isEmpty();
    if (v->type == OJson::String) return !v->s.isEmpty();
    return false;
}
QString upperFirst(const OJson* v) { return js::strOr(v, QString()).left(1).toUpper(); }
}  // namespace

// ================================================================ 持仓
Position makePosition(const OJson& raw) {
    Position p;
    const auto str = [&](const char16_t* k, const QString& def) { const OJson* v = get(raw, k); return js::nullish(v) ? def : js::str(v); };
    const auto num = [&](const char16_t* k, double def) { const OJson* v = get(raw, k); return js::nullish(v) ? def : js::num(v); };
    const auto opt = [&](const char16_t* k) -> std::optional<double> { const OJson* v = get(raw, k); return js::nullish(v) ? std::nullopt : std::optional(js::num(v)); };
    p.account = str(u"account", {});
    p.symbol = str(u"symbol", {});
    p.sec_type = str(u"sec_type", u"STK"_s);
    p.quantity = num(u"quantity", 0.0);
    p.avg_cost = num(u"avg_cost", 0.0);
    p.multiplier = num(u"multiplier", 1.0);
    p.currency = str(u"currency", u"USD"_s);
    p.market_price = opt(u"market_price");
    p.market_value = opt(u"market_value");
    p.unrealized_pnl = opt(u"unrealized_pnl");
    p.leg = str(u"leg", {});
    return p;
}

bool isLong(const Position& p) { return p.quantity > 0; }

QString positionKey(const Position& p) { return domain::makeKey(p.account, p.symbol, p.sec_type, p.leg); }

QString trackKey(const OJson& track) {
    const OJson* sec = get(track, u"sec_type");
    const OJson* leg = get(track, u"leg");
    return domain::makeKey(js::str(get(track, u"account")), js::str(get(track, u"symbol")), js::truthy(sec) ? js::str(sec) : u"STK"_s,
                           js::truthy(leg) ? js::str(leg) : QString());
}

OJson makeTargets(const OJson& raw) {
    OJson out = js::object();
    for (const char16_t* k : {u"take_profit", u"stop_loss", u"trail_pct", u"profit_drawdown_pct", u"profit_drawdown_tiers", u"profit_drawdown_late",
                              u"profit_drawdown_arm", u"profit_drawdown_floor", u"spot_target", u"spot_stop_below", u"spot_stop_above", u"spot_stop_confirm_s",
                              u"exit_at", u"exit_at_ms", u"take_profit_tiers"}) {
        const OJson* v = get(raw, k);
        out.set(QString::fromUtf16(k), js::nullish(v) ? OJson::null() : *v);
    }
    return out;
}

bool targetsEmpty(const OJson& t) {
    return isNull(get(t, u"take_profit")) && isNull(get(t, u"stop_loss")) && isNull(get(t, u"trail_pct")) && isNull(get(t, u"profit_drawdown_pct")) &&
           !hasLength(get(t, u"profit_drawdown_tiers")) && isNull(get(t, u"spot_target")) && isNull(get(t, u"spot_stop_below")) &&
           isNull(get(t, u"spot_stop_above")) && isNull(get(t, u"exit_at_ms")) && !hasLength(get(t, u"take_profit_tiers"));
}

// ================================================================ 结构
std::optional<OJson> flyProfileOf(const OJson* contract) {
    static const OJson empty = js::object();
    const OJson& c = js::nullish(contract) ? empty : *contract;
    if (js::strOr(get(c, u"secType"), QString()) != u"BAG") return std::nullopt;
    const OJson* legsRaw = get(c, u"legs");
    static const OJson emptyArr = js::array();
    const OJson* legs = js::nullish(legsRaw) ? &emptyArr : legsRaw;
    if (legs->type == OJson::String) {
        if (legs->s.size() == 3) throw util::JsError(u"legs.map is not a function"_s);
        return std::nullopt;
    }
    if (legs->type != OJson::Array || legs->items.size() != 3) return std::nullopt;
    std::vector<std::optional<double>> strikes, ratios;
    QStringList rights;
    for (const OJson& l : legs->items) strikes.push_back(fin(js::propStrict(&l, u"strike"_s)));
    for (const OJson& l : legs->items) ratios.push_back(fin(js::propStrict(&l, u"ratio"_s)));
    for (const OJson& l : legs->items) rights << upperFirst(js::propStrict(&l, u"right"_s));
    for (const auto& s : strikes)
        if (!s) return std::nullopt;
    for (const auto& r : ratios)
        if (!r) return std::nullopt;
    if (!(rights[0] == rights[1] && rights[1] == rights[2]) || (rights[0] != u"C" && rights[0] != u"P")) return std::nullopt;
    const double k1 = *strikes[0], k2 = *strikes[1], k3 = *strikes[2];
    const double r1 = *ratios[0], r2 = *ratios[1], r3 = *ratios[2];
    if (!(k1 < k2 && k2 < k3) || !domain::same(k2 - k1, k3 - k2)) return std::nullopt;
    if (!domain::same(r1, r3) || !domain::same(r2, -2 * r1) || r1 == 0) return std::nullopt;
    return js::object({{u"lower"_s, js::N(k1)},
                       {u"center"_s, js::N(k2)},
                       {u"upper"_s, js::N(k3)},
                       {u"width"_s, js::N(R(k2 - k1, 4))},
                       {u"right"_s, js::S(rights[0])},
                       {u"action"_s, js::S(r1 > 0 ? u"BUY"_s : u"SELL"_s)}});
}

QString legPriceKey(double strike, const QString& right) { return util::pyG(strike) + right; }

std::optional<TargetStructure> structureOf(const QString& secType, const OJson* contract) {
    static const OJson empty = js::object();
    const OJson& c = js::nullish(contract) ? empty : *contract;
    const QString kind = secType.isEmpty() ? u"STK"_s : secType;
    if (kind == u"STK") return TargetStructure{u"stock"_s, {}, std::nullopt, u"正股"_s};
    const auto legOf = [](const OJson& raw, double ratio) -> std::optional<StructureLeg> {
        const auto strike = fin(js::propStrict(&raw, u"strike"_s));
        const QString right = upperFirst(js::propStrict(&raw, u"right"_s));
        if (!strike || (right != u"C" && right != u"P") || !std::isfinite(ratio)) return std::nullopt;
        return StructureLeg{*strike, right, ratio};
    };
    if (kind == u"OPT" || kind == u"FOP") {
        const auto leg = legOf(c, 1);
        if (!leg) return std::nullopt;
        return TargetStructure{u"option"_s, {*leg}, std::nullopt, G(leg->strike) + leg->right + u" 单腿"_s};
    }
    if (kind != u"BAG") return std::nullopt;
    const OJson* raw = get(c, u"legs");
    // (c.legs ?? []).length 为假就不认;不是数组的(串按字符走、对象没有 length)认不出腿
    if (!js::isArr(raw) || raw->items.isEmpty()) return std::nullopt;
    std::vector<StructureLeg> legs;
    for (const OJson& r : raw->items) {
        const double ratio = fin(js::propStrict(&r, u"ratio"_s)).value_or(std::nan(""));
        const auto leg = legOf(r, ratio);
        if (!leg || leg->ratio == 0) return std::nullopt;
        legs.push_back(*leg);
    }
    const auto fly = flyProfileOf(&c);
    const QString label = fly ? G(fly->get(u"lower"_s)->n) + u'/' + G(fly->get(u"center"_s)->n) + u'/' + G(fly->get(u"upper"_s)->n) + u" 蝴蝶"_s
                              : util::jsNumberToString(double(legs.size())) + u" 腿组合"_s;
    return TargetStructure{u"combo"_s, legs, fly, label};
}

namespace {
std::vector<StructureLeg> legsByMoneyness(std::vector<StructureLeg> legs, double spot) {
    std::stable_sort(legs.begin(), legs.end(), [&](const StructureLeg& a, const StructureLeg& b) { return std::fabs(a.strike - spot) < std::fabs(b.strike - spot); });
    return legs;
}
QString keyOf(const StructureLeg& l) { return legPriceKey(l.strike, l.right); }

bool reachedTarget(const Position& position, double valueNow, double valueAtTarget) {
    return isLong(position) ? valueNow >= valueAtTarget - 1e-6 : valueNow <= valueAtTarget + 1e-6;
}

OJson withPnl(OJson out, const Position& position) {
    const OJson* price = out.get(u"price"_s);
    if (isNull(price)) return out;
    const double basis = costBasis(position);
    const auto value = marketValue(position, price->n);
    if (!value) return out;
    out.set(u"pnl"_s, js::N(R(*value - basis, 2)));
    if (basis != 0 && !std::isnan(basis)) out.set(u"pnl_pct"_s, js::N(R(((*value - basis) / std::fabs(basis)) * 100.0, 3)));
    return out;
}
}  // namespace

std::optional<OJson> smileSigmas(const std::vector<StructureLeg>& legs, double spot, const OJson& legPrices) {
    if (legs.empty()) return std::nullopt;
    OJson out = js::object();
    for (const StructureLeg& leg : legs) {
        const QString key = keyOf(leg);
        const auto price = fin(js::prop(&legPrices, key));
        if (!price) return std::nullopt;
        const auto sigma = fx::impliedSigmaLeg(spot, leg.strike, *price, leg.right);
        if (!sigma) return std::nullopt;
        out.set(key, js::N(*sigma));
    }
    return out;
}

OJson spotTarget(const TargetStructure& structure, const Position& position, const SpotTargetArgs& args) {
    const double target = args.spotTarget;
    const std::optional<double> spot = args.spot && std::isfinite(*args.spot) ? args.spot : std::nullopt;
    OJson out = js::object({{u"spot_target"_s, js::N(target)},
                            {u"spot"_s, optN(spot)},
                            {u"spot_note"_s, js::S(args.spotNote)},
                            {u"price"_s, OJson::null()},
                            {u"pnl"_s, OJson::null()},
                            {u"pnl_pct"_s, OJson::null()},
                            {u"sigma"_s, OJson::null()},
                            {u"sigma_source"_s, js::S(QString())},
                            {u"structure"_s, js::S(structure.label)},
                            {u"reason"_s, js::S(QString())}});
    if (!(target > 0)) {
        out.set(u"reason"_s, js::S(u"标的目标价要是正数。"_s));
        return out;
    }
    if (structure.kind == u"stock") {
        out.set(u"sigma_source"_s, js::S(u"none"_s));
        const double price = R(target, 4);
        out.set(u"price"_s, js::N(price));
        if (spot) out.set(u"reached"_s, js::B(reachedTarget(position, *spot, price)));
        return withPnl(out, position);
    }
    const std::optional<OJson>& fly = structure.fly;
    if (fly && fly->get(u"action"_s)->s != u"BUY") {
        out.set(u"reason"_s, js::S(u"预计止盈位只支持买入的蝶(借方);卖出的蝶盈利在中心之外,标的目标价说不清方向。"_s));
        return out;
    }
    std::optional<double> sigma;
    QString source;
    std::optional<OJson> legSigmas;
    const std::optional<double> mark = args.markPrice && std::isfinite(*args.markPrice) ? args.markPrice : std::nullopt;
    static const OJson emptyObj = js::object();
    const OJson& legPrices = args.legPrices && args.legPrices->type != OJson::Null ? *args.legPrices : emptyObj;
    if (spot && args.legIvs && js::truthy(args.legIvs) && args.nowMs) {
        std::vector<analysis::PricedLeg> priced;
        for (const StructureLeg& l : structure.legs) priced.push_back({l.strike, l.right});
        const OJson sig = analysis::ibkrLegSigmas(priced, *spot, *args.legIvs, args.expiryMs, *args.nowMs,
                                                  [](const analysis::PricedLeg& l) { return legPriceKey(l.strike, l.right); });
        if (sig.type != OJson::Null) {
            legSigmas = sig;
            source = u"ibkr"_s;
        }
    }
    if (source.isEmpty() && spot && structure.kind == u"combo") {
        legSigmas = smileSigmas(structure.legs, *spot, legPrices);
        if (legSigmas) source = u"smile"_s;
    }
    if (source.isEmpty() && spot && mark) {
        if (fly) sigma = fx::impliedSigmaFly(*fly, *spot, *mark);
        else if (structure.legs.size() == 1) sigma = fx::impliedSigmaLeg(*spot, structure.legs[0].strike, *mark, structure.legs[0].right);
        if (sigma) source = u"net"_s;
    }
    if (source.isEmpty() && spot) {
        for (const StructureLeg& leg : legsByMoneyness(structure.legs, *spot)) {
            const auto legPrice = fin(js::prop(&legPrices, keyOf(leg)));
            if (!legPrice) continue;
            sigma = fx::impliedSigmaLeg(*spot, leg.strike, *legPrice, leg.right);
            if (sigma) {
                source = u"leg"_s;
                break;
            }
        }
    }
    if (source.isEmpty()) {
        const double em = args.em && std::isfinite(*args.em) ? *args.em : js::num(fx::defaults().get(u"em"_s));
        if (!args.minute) {
            out.set(u"reason"_s, js::S(u"拿不到市场波动率,也没有当前时刻,算不出预计价位。"_s));
            return out;
        }
        sigma = fx::sigmaRemaining(em, *args.minute);
        source = u"clock"_s;
    }
    out.set(u"sigma_source"_s, js::S(source));
    const auto valueAt = [&](double s) {
        double v;
        if (legSigmas) {
            v = 0;
            for (const StructureLeg& leg : structure.legs) v += leg.ratio * fx::legValue(leg.right, s, leg.strike, legSigmas->get(keyOf(leg))->n);
            if (fly) v = jm::max(v, 0);
        } else {
            std::vector<fx::StructureLeg> legs;
            for (const StructureLeg& l : structure.legs) legs.push_back({l.strike, l.right, l.ratio});
            v = fly ? fx::modelPrice(*fly, s, *sigma) : fx::structureValue(legs, s, *sigma);
        }
        return structure.kind == u"combo" && !fly && !isLong(position) ? -v : v;
    };
    if (legSigmas) {
        const StructureLeg nearest = legsByMoneyness(structure.legs, target)[0];
        out.set(u"sigma"_s, js::N(R(legSigmas->get(keyOf(nearest))->n, 4)));
        OJson rounded = js::object();
        for (const auto& [k, v] : legSigmas->fields) rounded.set(k, js::N(R(v.n, 4)));
        out.set(u"leg_sigmas"_s, rounded);
    } else {
        out.set(u"sigma"_s, js::N(R(*sigma, 4)));
    }
    const double atTarget = R(valueAt(target), 4);
    const std::optional<double> atSpot = spot ? std::optional(valueAt(*spot)) : std::nullopt;
    out.set(u"price"_s, js::N(atTarget));
    if (source == u"ibkr") {
        OJson ivs = js::object();
        if (js::isObj(args.legIvs))
            for (const auto& [k, v] : args.legIvs->fields) ivs.set(k, js::N(R(js::num(&v), 6)));
        out.set(u"leg_ivs"_s, ivs);
        if (mark && atSpot) out.set(u"price"_s, js::N(R(jm::max(0, *mark + atTarget - *atSpot), 4)));
    }
    if (atSpot) out.set(u"reached"_s, js::B(reachedTarget(position, R(*atSpot, 4), atTarget)));
    return withPnl(out, position);
}

QString fillsNowMessage(const Position& position, const TargetStructure& structure, const OJson& st, std::optional<double> markPrice) {
    const std::optional<double> now = markPrice && std::isfinite(*markPrice) ? markPrice : std::nullopt;
    const OJson* price = st.get(u"price"_s);
    if (isNull(price) || !now) return {};
    const bool lng = isLong(position);
    if (lng ? price->n > *now : price->n < *now) return {};
    return u"标的到 "_s + js::pyG(st.get(u"spot_target"_s)) + u" 时这份持仓约值 "_s + F(price->n, 2) + u","_s + (lng ? u"不高于"_s : u"不低于"_s) + u"现价 "_s +
           F(*now, 2) + u"——挂上去会立刻成交。"_s +
           (structure.fly ? u"想止盈就把目标价再往中心 "_s + G(structure.fly->get(u"center"_s)->n) + u" 靠。"_s : u"换个方向对的目标价。"_s);
}

OJson validateSpotTarget(const Position& position, const OJson* contract, const SpotTargetArgs& args) {
    const auto structure = structureOf(position.sec_type, contract);
    if (!structure) throw TrackerError(u"这份持仓认不出结构,用不了标的目标价:正股、单腿期权,以及每条腿都带行权价与看涨/看跌的组合才行。"_s);
    const OJson st = spotTarget(*structure, position, args);
    if (!st.get(u"reason"_s)->s.isEmpty()) throw TrackerError(st.get(u"reason"_s)->s);
    if (isNull(st.get(u"price"_s))) throw TrackerError(u"拿不到标的现价或持仓报价,这一刻算不出预计价位——等行情来了再设。"_s);
    const QString fillsNow = fillsNowMessage(position, *structure, st, args.markPrice);
    if (!fillsNow.isEmpty()) throw TrackerError(fillsNow);
    return st;
}

std::optional<double> naturalClosePrice(const Position& position, const TargetStructure& structure, const OJson& book) {
    if (structure.kind == u"stock" || structure.legs.empty()) return std::nullopt;
    struct Quote {
        double bid, ask;
    };
    const auto quote = [&](const StructureLeg& leg) -> std::optional<Quote> {
        const OJson* q = js::prop(&book, keyOf(leg));
        const auto bid = fin(js::prop(q, u"bid"_s));
        const auto ask = fin(js::prop(q, u"ask"_s));
        if (!bid || !ask || !(*bid >= 0) || !(*ask > 0) || *ask < *bid) return std::nullopt;
        return Quote{*bid, *ask};
    };
    if (structure.kind == u"option") {
        const auto q = quote(structure.legs[0]);
        if (!q) return std::nullopt;
        const double price = isLong(position) ? q->bid : q->ask;
        return price > 0 ? std::optional(price) : std::nullopt;
    }
    double net = 0;
    for (const StructureLeg& leg : structure.legs) {
        const auto q = quote(leg);
        if (!q) return std::nullopt;
        net += leg.ratio * (leg.ratio > 0 ? q->bid : q->ask);
    }
    const double out = R(isLong(position) ? net : -net, 4);
    return out > 0 ? std::optional(out) : std::nullopt;
}

double chaseMaxSteps(const Position& position, double natural, const OJson& autoClose, const OJson* reason) {
    const double tick = closeTick(position, natural);
    const double pct = analysis::chaseProfile(autoClose, reason).maxPct / 100;
    const double cap = jm::max(2 * tick, natural * pct);
    return std::floor(cap / tick + 1e-9);
}

double chaseLimit(const Position& position, double natural, std::optional<double> prev, double rounds, const OJson& autoClose, const OJson* reason, double lead) {
    const double tick = closeTick(position, natural);
    const analysis::ChaseProfile pace = analysis::chaseProfile(autoClose, reason);
    // lead:价正朝不利方向走时按跌速多让的那一截(analysis::momentumLead),折成整数跳、往多让的一侧取;和越等越让的加在一起仍不超过上限
    const double leadSteps = lead > 0 ? std::ceil(lead / tick - 1e-9) : 0;
    const double steps = jm::min(jm::max(0, rounds - pace.grace) * pace.step + leadSteps, chaseMaxSteps(position, natural, autoClose, reason));
    const bool lng = isLong(position);
    const double raw = lng ? natural - steps * tick : natural + steps * tick;
    const double step = closeTick(position, raw);
    const double aligned = lng ? std::floor(raw / step + 1e-9) : std::ceil(raw / step - 1e-9);
    double out = jm::max(aligned * step, step);
    if (prev && std::isfinite(*prev)) out = lng ? jm::min(out, *prev) : jm::max(out, *prev);
    return R(out, 4);
}

double chaseFloor(const Position& position, double natural, const OJson& autoClose, const OJson* reason) {
    return chaseLimit(position, natural, std::nullopt, 9007199254740991.0, autoClose, reason);
}

std::optional<QString> sweepReason(const OJson& track) {
    const QString state = js::strOr(get(track, u"fired_state"), QString());
    return state.startsWith(kSweepPrefix) ? std::optional(state.mid(kSweepPrefix.size())) : std::nullopt;
}

// ================================================================ 盈亏
double costBasis(const Position& p) { return p.avg_cost * p.quantity; }

std::optional<double> marketValue(const Position& p, std::optional<double> price) {
    if (!price || !std::isfinite(*price)) return std::nullopt;
    const double mult = p.multiplier != 0 && !std::isnan(p.multiplier) ? p.multiplier : 1.0;
    return *price * mult * p.quantity;
}

OJson unrealized(const Position& p, std::optional<double> price) {
    const double basis = costBasis(p);
    std::optional<double> pnl, value;
    QString source;
    if (p.unrealized_pnl && std::isfinite(*p.unrealized_pnl)) {
        pnl = p.unrealized_pnl;
        source = u"broker"_s;
        value = p.market_value && std::isfinite(*p.market_value) ? p.market_value : std::nullopt;
        if (!value) value = marketValue(p, price);
    } else {
        value = marketValue(p, price);
        if (value) pnl = *value - basis;
        source = u"computed"_s;
    }
    std::optional<double> pct;
    if (pnl && basis != 0 && !std::isnan(basis)) pct = (*pnl / std::fabs(basis)) * 100.0;
    return js::object({{u"cost_basis"_s, js::N(R(basis, 4))},
                       {u"market_value"_s, value ? js::N(R(*value, 4)) : OJson::null()},
                       {u"unrealized_pnl"_s, pnl ? js::N(R(*pnl, 4)) : OJson::null()},
                       {u"unrealized_pct"_s, pct ? js::N(R(*pct, 3)) : OJson::null()},
                       {u"pnl_source"_s, js::S(source)}});
}

// ================================================================ 设置校验
void validate(const Position& position, const OJson& targets, std::optional<double> price, bool hasAdditionalExit) {
    if (targetsEmpty(targets) && !hasAdditionalExit) throw TrackerError(u"至少要设一个:止盈价、止损价、跟踪止损百分比,或标的目标价。"_s);
    if (position.quantity == 0 || std::isnan(position.quantity)) throw TrackerError(u"这个持仓的数量是 0,没有可追踪的头寸。"_s);
    for (const auto& [name, key] : {std::pair{u"止盈价"_s, u"take_profit"}, std::pair{u"止损价"_s, u"stop_loss"}}) {
        const OJson* v = get(targets, key);
        if (!isNull(v) && (!fin(v) || js::num(v) <= 0)) throw TrackerError(name + u"必须是正数。"_s);
    }
    if (const OJson* t = get(targets, u"trail_pct"); !isNull(t))
        if (!fin(t) || !(js::num(t) > 0 && js::num(t) < 100)) throw TrackerError(u"跟踪止损的回撤百分比要在 0 到 100 之间。"_s);
    if (const OJson* t = get(targets, u"profit_drawdown_pct"); !isNull(t))
        if (!fin(t) || !(js::num(t) > 0 && js::num(t) < 100)) throw TrackerError(u"利润回撤的百分比要在 0 到 100 之间。"_s);
    const bool lng = isLong(position);
    const OJson* tpRaw = get(targets, u"take_profit");
    const OJson* slRaw = get(targets, u"stop_loss");
    const double tp = js::num(tpRaw), sl = js::num(slRaw);
    if (!isNull(tpRaw) && !isNull(slRaw)) {
        if (lng && sl >= tp) throw TrackerError(u"多头的止损价必须低于止盈价。"_s);
        if (!lng && sl <= tp) throw TrackerError(u"空头的止损价必须高于止盈价。"_s);
    }
    if (!price || !std::isfinite(*price)) return;
    const double p = *price;
    if (!isNull(tpRaw)) {
        if (lng && tp <= p) throw TrackerError(u"多头的止盈价要高于现价(现价 %1,你填了 %2)——填在下方会立刻触发。"_s.arg(F(p, 4), F(tp, 4)));
        if (!lng && tp >= p) throw TrackerError(u"空头的止盈价要低于现价(现价 %1,你填了 %2)——空头是跌了才赚。"_s.arg(F(p, 4), F(tp, 4)));
    }
    if (!isNull(slRaw)) {
        if (lng && sl >= p) throw TrackerError(u"多头的止损价要低于现价(现价 %1,你填了 %2)——填在上方会立刻触发。"_s.arg(F(p, 4), F(sl, 4)));
        if (!lng && sl <= p) throw TrackerError(u"空头的止损价要高于现价(现价 %1,你填了 %2)。"_s.arg(F(p, 4), F(sl, 4)));
    }
}

// ================================================================ 跟踪止损
std::optional<double> advancePeak(const Position& position, std::optional<double> price, std::optional<double> peak) {
    if (!price || !std::isfinite(*price)) return peak;
    if (!peak) return price;
    return isLong(position) ? jm::max(*peak, *price) : jm::min(*peak, *price);
}

std::optional<double> trailStopPrice(const Position& position, std::optional<double> peak, const OJson* trailPct) {
    const auto pct = fin(trailPct);
    if (!peak || !std::isfinite(*peak) || !pct || *peak < 0) return std::nullopt;
    const double ratio = *pct / 100.0;
    return isLong(position) ? *peak * (1 - ratio) : *peak * (1 + ratio);
}

namespace {
OJson gapPct(std::optional<double> price, std::optional<double> target) {
    if (!price || !std::isfinite(*price) || !target || !std::isfinite(*target) || *price == 0) return OJson::null();
    return js::N(R((*target / *price - 1) * 100.0, 3));
}
}  // namespace

OJson evaluate(const Position& position, const OJson& targets, std::optional<double> price, std::optional<double> peak, std::optional<double> minute,
               const EvaluateOpts& opts) {
    const std::optional<double> p = price && std::isfinite(*price) ? price : std::nullopt;
    const auto finite = [](const std::optional<double>& v) { return v && std::isfinite(*v) ? v : std::nullopt; };
    const std::optional<double> sp = opts.hasStopPrice ? finite(opts.stopPrice) : p;
    const std::optional<double> newPeak = advancePeak(position, opts.hasPeakPrice ? finite(opts.peakPrice) : sp, peak);
    const std::optional<double> trail = trailStopPrice(position, newPeak, get(targets, u"trail_pct"));
    OJson out = js::object({{u"state"_s, js::S(kStateHolding)},
                            {u"price"_s, optN(p)},
                            {u"peak"_s, optN(newPeak)},
                            {u"trail_stop"_s, trail ? js::N(R(*trail, 4)) : OJson::null()},
                            {u"reason"_s, js::S(QString())}});
    for (const auto& [k, v] : unrealized(position, p).fields) out.set(k, v);
    if (!p) {
        out.set(u"state"_s, js::S(kStateHolding));
        out.set(u"reason"_s, js::S(u"拿不到现价,本轮不判断"_s));
        return out;
    }
    const bool lng = isLong(position);
    // 有效止损 = 固定止损和跟踪止损里更靠近现价的那一个(undefined 也会混进来,Math.max 得 NaN,同 TS)
    std::vector<double> stops;
    if (const OJson* s = get(targets, u"stop_loss"); !isNull(s)) stops.push_back(js::num(s));
    if (trail) stops.push_back(*trail);
    std::optional<double> stop;
    if (!stops.empty()) {
        double m = stops[0];
        for (size_t i = 1; i < stops.size(); ++i) m = lng ? jm::max(m, stops[i]) : jm::min(m, stops[i]);
        stop = m;
    }
    const bool hitStop = stop && sp && (lng ? *sp <= *stop : *sp >= *stop);
    const OJson* tpRaw = get(targets, u"take_profit");
    const bool hitTake = !isNull(tpRaw) && (lng ? *p >= js::num(tpRaw) : *p <= js::num(tpRaw));

    std::optional<double> profitNow, profitPeak, profitDd, threshold;
    bool hitProfitTrail = false;
    if ((!isNull(get(targets, u"profit_drawdown_pct")) || hasLength(get(targets, u"profit_drawdown_tiers"))) && newPeak) {
        const double basis = costBasis(position);
        const auto valueNow = marketValue(position, sp);
        const auto valuePeak = marketValue(position, newPeak);
        if (valueNow && valuePeak) {
            profitNow = *valueNow - basis;
            profitPeak = *valuePeak - basis;
            if (*profitPeak > 0) {
                profitDd = (1.0 - *profitNow / *profitPeak) * 100.0;
                const OJson pk = js::N(*profitPeak), bs = js::N(basis), mn = optN(minute);
                threshold = analysis::drawdownThreshold(targets, &pk, &bs, &mn);
                if (!analysis::drawdownArmed(targets, &pk, &bs)) threshold.reset();
                if (threshold) {
                    const OJson npk = js::N(*newPeak), spj = optN(sp);
                    hitProfitTrail = *profitNow <= *profitPeak * (1.0 - *threshold / 100.0) && analysis::drawdownFloorMet(targets, &npk, &spj);
                }
            }
        }
    }
    out.set(u"profit_peak"_s, profitPeak ? js::N(R(*profitPeak, 4)) : OJson::null());
    out.set(u"profit_drawdown_pct"_s, profitDd ? js::N(R(*profitDd, 2)) : OJson::null());
    out.set(u"profit_drawdown_threshold"_s, threshold ? js::N(R(*threshold, 4)) : OJson::null());
    out.set(u"profit_trail_stop"_s, threshold ? optN(profitTrailStopPrice(position, newPeak, threshold, fin(get(targets, u"profit_drawdown_floor"))))
                                              : OJson::null());
    if (hitStop) {
        out.set(u"state"_s, js::S(kStateStopLoss));
        const QString which = trail && *stop == *trail ? u"跟踪止损"_s : u"止损"_s;
        out.set(u"reason"_s, js::S(which + u"触发:"_s + (*sp == *p ? u"现价"_s : u"可成交价"_s) + u" "_s + F(*sp, 4) + u" "_s + (lng ? u"跌破"_s : u"涨破"_s) + u" "_s +
                                   F(*stop, 4)));
    } else if (hitProfitTrail) {
        out.set(u"state"_s, js::S(kStateProfitTrail));
        out.set(u"reason"_s, js::S(u"利润回撤触发:峰值利润 %1,当前 %2,回撤 %3%(阈值 %4%)"_s.arg(F(*profitPeak, 2), F(*profitNow, 2), F(*profitDd, 1), F(*threshold, 0))));
    } else if (hitTake) {
        out.set(u"state"_s, js::S(kStateTakeProfit));
        out.set(u"reason"_s, js::S(u"止盈触发:现价 "_s + F(*p, 4) + u" "_s + (lng ? u"涨到"_s : u"跌到"_s) + u" "_s + F(js::num(tpRaw), 4)));
    }
    out.set(u"stop_effective"_s, stop ? js::N(R(*stop, 4)) : OJson::null());
    out.set(u"to_take_profit_pct"_s, gapPct(p, fin(tpRaw)));
    out.set(u"to_stop_pct"_s, gapPct(sp, stop));
    if (opts.hasStopPrice) out.set(u"stop_price"_s, optN(sp));
    return out;
}

OJson withSpotTriggers(const OJson& result, const QString& symbol, const OJson& targets, const OJson* target, const OJson* stop) {
    const QString state = result.get(u"state"_s)->s;
    if (stop && js::truthy(js::prop(stop, u"hit"_s)) && (state == kStateHolding || state == kStateTakeProfit)) {
        OJson out = result;
        out.set(u"state"_s, js::S(kStateStopLoss));
        out.set(u"reason"_s, js::copyOrNull(js::prop(stop, u"reason"_s)));
        return out;
    }
    if (state == kStateHolding && target && js::truthy(js::prop(target, u"reached"_s))) {
        OJson out = result;
        out.set(u"state"_s, js::S(kStateTakeProfit));
        out.set(u"reason"_s, js::S(symbol + u" 到了目标价 "_s + G(js::num(get(targets, u"spot_target"))) + u"(现价 "_s + js::str(js::prop(target, u"spot"_s)) + u")"_s));
        return out;
    }
    return result;
}

std::optional<QString> unreachableReason(const std::optional<QSet<QString>>& covered, const OJson* account) {
    if (!covered || covered->contains(js::str(account))) return std::nullopt;
    return u"账户 "_s + js::str(account) + u" 的券商会话没连上(或正在重连),这一轮读不到它的持仓,先不判断"_s;
}

QString closeSide(const Position& p) { return isLong(p) ? u"SELL"_s : u"BUY"_s; }

// ================================================================ 自动平仓
const QString kBlockDisabled = u"该持仓没有开启自动平仓"_s;
const QString kBlockBreaker = u"已熔断,不再发出任何新单"_s;
const QString kBlockMarket = u"当前时段不能交易"_s;
const QString kBlockAlready = u"这个追踪已经触发过一次,不重复发单"_s;
const QString kBlockQty = u"持仓数量为 0,没有可平的头寸"_s;
const QStringList kExtendedSessions{u"盘前"_s, u"盘后"_s, u"盘外"_s};

OJson makeAutoClose(const OJson& raw) {
    const auto or_ = [&](const char16_t* k, const OJson& def) { const OJson* v = get(raw, k); return js::nullish(v) ? def : *v; };
    const OJson* basis = get(raw, u"stop_basis");
    const OJson* peak = get(raw, u"peak_confirm");
    OJson out = js::object({{u"enabled"_s, or_(u"enabled", js::B(false))},
                       {u"order_type"_s, or_(u"order_type", js::S(u"MKT"_s))},
                       {u"slippage_pct"_s, or_(u"slippage_pct", js::N(0.3))},
                       {u"close_fraction_pct"_s, or_(u"close_fraction_pct", js::N(100.0))},
                       {u"host_at_broker"_s, or_(u"host_at_broker", js::B(false))},
                       {u"chase_max_pct"_s, or_(u"chase_max_pct", js::N(10.0))},
                       {u"stop_basis"_s, js::S(js::isStr(basis) && basis->s == u"natural" ? u"natural"_s : u"mid"_s)},
                       {u"stop_chase_grace"_s, or_(u"stop_chase_grace", OJson::null())},
                       {u"stop_chase_step"_s, or_(u"stop_chase_step", OJson::null())},
                       {u"stop_chase_max_pct"_s, or_(u"stop_chase_max_pct", OJson::null())},
                       {u"peak_confirm"_s, js::B(peak && peak->type == OJson::Bool && peak->b)}});
    // 快速下跌的追价(C++ 先有):填了才带这个键,没填的读成默认(1 倍、1 秒)——没用到它的追踪和 TS 版的样子逐字一样
    if (const OJson* v = get(raw, u"chase_lead")) out.set(u"chase_lead"_s, *v);
    if (const OJson* v = get(raw, u"chase_interval_s")) out.set(u"chase_interval_s"_s, *v);
    for (const char16_t* k : {u"rapid_exit_window_s", u"rapid_exit_pct"})
        if (const OJson* v = get(raw, k)) out.set(QString::fromUtf16(k), *v);
    for (const char16_t* k : {u"spot_stop_at_broker", u"spot_stop_limit"})
        if (const OJson* v = get(raw, k)) out.set(QString::fromUtf16(k), *v);
    return out;
}

QStringList closeBlockers(const CloseGateArgs& args) {
    QStringList blocked;
    if (!js::truthy(js::prop(args.autoClose, u"enabled"_s))) blocked << kBlockDisabled;
    if (args.alreadyFired) blocked << kBlockAlready;
    if (args.position->quantity == 0 || std::isnan(args.position->quantity)) blocked << kBlockQty;
    if (args.breakerEngaged) blocked << kBlockBreaker;
    QStringList tradable{u"盘中"_s};
    if (args.outsideRth) tradable += kExtendedSessions;
    if (!tradable.contains(args.marketStatus)) blocked << kBlockMarket + u"(当前:"_s + args.marketStatus + u")"_s;
    return blocked;
}

double closeQty(const Position& position, const OJson& autoClose) {
    const double qtyFull = std::trunc(std::fabs(position.quantity));
    if (!(qtyFull > 0)) throw TrackerError(u"持仓数量为 0,没有可平的头寸。"_s);
    const auto fraction = fin(get(autoClose, u"close_fraction_pct"));
    if (!fraction || !(*fraction > 0 && *fraction <= 100)) throw TrackerError(u"平仓比例要在 0(不含)到 100 之间。"_s);
    if (*fraction >= 100) return qtyFull;
    return jm::max(1, jm::min(qtyFull, std::trunc((qtyFull * *fraction) / 100.0)));
}

double closeTick(const Position& position, std::optional<double> price) {
    if (position.sec_type == u"STK") return 0.01;
    if (position.sec_type == u"BAG") return 0.05;
    return price && std::isfinite(*price) && *price >= 3 ? 0.1 : 0.05;
}

std::optional<double> closeLimitPrice(const Position& position, std::optional<double> price, const OJson* slippagePct) {
    const auto pct = fin(slippagePct);
    if (!price || !std::isfinite(*price) || !pct) return std::nullopt;
    const double ratio = std::fabs(*pct) / 100.0;
    double out = isLong(position) ? *price * (1 - ratio) : *price * (1 + ratio);
    const double tick = closeTick(position, out);
    const double steps = isLong(position) ? std::floor(out / tick + 1e-9) : std::ceil(out / tick - 1e-9);
    out = steps * tick;
    return R(jm::max(out, tick), 4);
}

OJson closeContract(const OJson& contract) {
    const QString secType = js::strOr(get(contract, u"secType"), QString());
    if (secType == u"STK") {
        OJson out = js::object({{u"secType"_s, js::S(u"STK"_s)}});
        if (const OJson* s = get(contract, u"symbol")) out.set(u"symbol"_s, *s);  // undefined:JSON 里没有这一键
        out.set(u"exchange"_s, js::S(u"SMART"_s));
        const OJson* cur = get(contract, u"currency");
        out.set(u"currency"_s, js::nullish(cur) ? js::S(u"USD"_s) : *cur);
        return out;
    }
    if (secType == u"BAG") return closeBagContract(contract);
    OJson out = js::object();
    for (const auto& [k, v] : contract.fields)
        if (v.type != OJson::Null) out.set(k, v);
    return out;
}

OJson closeBagContract(const OJson& contract) {
    const OJson* legsRaw = get(contract, u"legs");
    if (js::isStr(legsRaw) && !legsRaw->s.isEmpty()) throw util::JsError(u"legsIn.map is not a function"_s);
    if (!js::isArr(legsRaw) || legsRaw->items.isEmpty()) throw TrackerError(u"组合持仓没有腿信息,拼不出平仓的 BAG 合约。"_s);
    OJson legs = js::array();
    for (const OJson& leg : legsRaw->items) {
        const OJson* ratioRaw = js::propStrict(&leg, u"ratio"_s);
        const auto ratio = fin(ratioRaw);
        if (!ratio || *ratio == 0)
            throw TrackerError(u"组合的某条腿比例是 "_s + (ratioRaw ? js::stringify(*ratioRaw) : u"undefined"_s) + u",认不出方向,拒绝拼平仓单。"_s);
        const double steps = util::jsRound(std::fabs(*ratio));
        if (std::fabs(std::fabs(*ratio) - steps) > 1e-6 || (steps != 1 && steps != 2))
            throw TrackerError(u"组合的腿比例 "_s + G(*ratio) + u" 不是 1 或 2(只支持垂直价差/蝴蝶/铁鹰的标准比例),拒绝拼平仓单。"_s);
        for (const char16_t* field : {u"lastTradeDateOrContractMonth", u"strike", u"right"}) {
            const OJson* v = get(leg, field);
            if (js::nullish(v) || (js::isStr(v) && v->s.isEmpty()))
                throw TrackerError(u"组合的某条腿缺少 "_s + QString::fromUtf16(field) + u",拼不出平仓的 BAG 合约。"_s);
        }
        const OJson* mult = get(contract, u"multiplier");
        legs.items.append(js::object({{u"action"_s, js::S(*ratio > 0 ? u"SELL"_s : u"BUY"_s)},
                                      {u"ratio"_s, js::N(steps)},
                                      {u"lastTradeDateOrContractMonth"_s, *get(leg, u"lastTradeDateOrContractMonth")},
                                      {u"strike"_s, js::N(js::num(get(leg, u"strike")))},
                                      {u"right"_s, js::S(js::str(get(leg, u"right")).left(1).toUpper())},
                                      {u"multiplier"_s, js::S(js::nullish(mult) ? u"100"_s : js::str(mult))}}));
    }
    OJson out = js::object({{u"secType"_s, js::S(u"BAG"_s)}});
    if (const OJson* s = get(contract, u"symbol")) out.set(u"symbol"_s, *s);
    out.set(u"exchange"_s, js::S(u"SMART"_s));
    const OJson* cur = get(contract, u"currency");
    out.set(u"currency"_s, js::nullish(cur) ? js::S(u"USD"_s) : *cur);
    out.set(u"legs"_s, legs);
    if (const OJson* cs = get(contract, u"combo_strategy"); js::truthy(cs)) out.set(u"combo_strategy"_s, *cs);
    return out;
}

std::optional<QString> closeContractIssue(const OJson* row) {
    const OJson* raw = js::prop(row, u"contract"_s);
    if (js::nullish(raw) || (raw->type != OJson::Object && raw->type != OJson::Array)) return u"这份持仓没有合约信息,拼不出平仓单。"_s;
    OJson spec;
    try {
        spec = closeContract(*raw);
    } catch (const TrackerError& e) {
        return e.message();
    }
    const auto parsed = util::zod::safeParse(domain::models::contractSpecSchema(), &spec);
    if (parsed.success) return std::nullopt;
    if (js::strOr(get(*raw, u"secType"), QString()) == u"BAG" && !js::truthy(get(*raw, u"combo_strategy")))
        return u"认不出这个组合的结构(只认垂直价差、等距蝴蝶、铁鹰 / 铁蝶),拼不出平仓单:只能提醒,不能自动平仓或托管。"_s;
    QStringList msgs;
    for (const auto& i : parsed.issues) msgs << i.message;
    return u"平仓合约过不了下单校验:"_s + msgs.join(u';');
}

OJson buildCloseOrder(const Position& position, const OJson& autoClose, std::optional<double> price, const QString& state, const OJson& contract,
                      const QString& marketStatus) {
    const double qty = closeQty(position, autoClose);
    const double qtyFull = std::trunc(std::fabs(position.quantity));
    const QString side = closeSide(position);
    const QString why = state == kStateTakeProfit    ? u"止盈"_s
                        : state == kStateProfitTrail ? u"利润回撤"_s
                        : state == kStateManual      ? u"手动"_s
                        : state == analysis::kStateTimeExit ? u"到点"_s
                        : state == analysis::kStateRapidExit ? u"急跌保护"_s
                                                            : u"止损"_s;
    const bool extended = kExtendedSessions.contains(marketStatus);
    const bool isBag = position.sec_type == u"BAG";
    const OJson* ot = get(autoClose, u"order_type");
    const bool mkt = js::isStr(ot) && ot->s == u"MKT";
    const OJson orderType = (extended || isBag) && mkt ? js::S(u"LMT"_s) : js::copyOrNull(ot);
    OJson order = js::object({{u"action"_s, js::S(side)},
                              {u"orderType"_s, orderType},
                              {u"totalQuantity"_s, js::N(qty)},
                              {u"price_mode"_s, js::S(u"EXPLICIT"_s)},
                              {u"tif"_s, js::S(u"DAY"_s)},
                              {u"outsideRth"_s, js::B(extended)}});
    if (!ot) order.remove(u"orderType"_s);  // undefined
    QString priceLabel = u"市价"_s;
    if (js::isStr(&orderType) && orderType.s == u"LMT") {
        const auto limit = closeLimitPrice(position, price, get(autoClose, u"slippage_pct"));
        if (!limit)
            throw TrackerError(isBag      ? u"组合只能限价平仓,但拿不到组合现价算不出限价——拒绝下单。"_s
                               : extended ? u"盘外只能限价平仓,但拿不到现价算不出限价——拒绝下单。"_s
                                          : u"拿不到现价,限价平仓算不出限价——拒绝下单。"_s);
        order.set(u"lmtPrice"_s, js::N(*limit));
        priceLabel = (extended ? u"盘外限价"_s : u"限价"_s) + u" "_s + util::pyFloat(*limit);
    }
    const QString partial = qty >= qtyFull ? QString() : u",平 %1/%2"_s.arg(util::jsNumberToString(qty), util::jsNumberToString(qtyFull));
    return js::object({{u"intent_summary"_s, js::S(why + u"平仓:"_s + (side == u"SELL" ? u"卖出"_s : u"买入"_s) + u" "_s + util::jsNumberToString(qty) + u" "_s +
                                                position.symbol + u"("_s + priceLabel + partial + u")"_s)},
                       {u"contract"_s, closeContract(contract)},
                       {u"execution_type"_s, js::S(u"IMMEDIATE"_s)},
                       {u"trigger"_s, OJson::null()},
                       {u"account"_s, js::S(position.account)},
                       {u"order"_s, order},
                       {u"reason"_s, js::S(state == kStateManual ? u"持仓追踪里点了「立即平仓」"_s : u"持仓追踪"_s + why + u"触发,自动平仓"_s)},
                       {u"confidence"_s, js::N(1.0)},
                       {u"warnings"_s, js::array()}});
}

// ================================================================ 券商托管
QString hostedLabel(const QString& kind) {
    if (kind == kHostedKindTp) return u"托管止盈"_s;
    if (kind == kHostedKindSl) return u"托管止损"_s;
    if (kind == kHostedKindTrail) return u"托管跟踪止损"_s;
    if (kind == kHostedKindPtrail) return u"利润回撤动态停损"_s;
    if (kind == kHostedKindSpot) return u"IBKR 标的条件止损"_s;
    return {};
}

namespace {
std::optional<double> hostedPrice(std::optional<double> v) {
    if (!v || !std::isfinite(*v)) return std::nullopt;
    return R(jm::max(*v, 0.01), 2);
}
std::optional<double> hostedComboPrice(const Position& position, std::optional<double> v) {
    if (!v || !std::isfinite(*v)) return std::nullopt;
    const double tick = closeTick(position, *v);
    const double steps = isLong(position) ? std::floor(*v / tick + 1e-9) : std::ceil(*v / tick - 1e-9);
    return R(jm::max(steps * tick, tick), 4);
}
std::optional<double> hostedStopPrice(const Position& position, std::optional<double> v) {
    if (position.sec_type == u"STK") return hostedPrice(v);
    return hostedComboPrice(position, v);
}
OJson planItem(const QString& kind, const QString& action, const QString& type, double qty, const OJson& lmt, const OJson& aux, const OJson& trailing,
               const OJson& seed, const QString& label) {
    return js::object({{u"kind"_s, js::S(kind)},
                       {u"action"_s, js::S(action)},
                       {u"order_type"_s, js::S(type)},
                       {u"quantity"_s, js::N(qty)},
                       {u"lmt_price"_s, lmt},
                       {u"aux_price"_s, aux},
                       {u"trailing_percent"_s, trailing},
                       {u"trail_stop_seed"_s, seed},
                       {u"label"_s, js::S(label)}});
}
}  // namespace

std::optional<double> profitTrailStopPrice(const Position& position, std::optional<double> peak, std::optional<double> drawdownPct, std::optional<double> floor) {
    if (!peak || !std::isfinite(*peak) || !drawdownPct || !std::isfinite(*drawdownPct) || !(*drawdownPct > 0 && *drawdownPct < 100)) return std::nullopt;
    const double mult = position.multiplier != 0 && !std::isnan(position.multiplier) ? position.multiplier : 1.0;
    const double cost = position.avg_cost / mult;
    const double keep = 1.0 - *drawdownPct / 100.0;
    const std::optional<double> fl = floor && std::isfinite(*floor) ? floor : std::nullopt;
    const double p = *peak;
    if (isLong(position)) {
        if (p <= cost) return std::nullopt;
        const double stop = cost + (p - cost) * keep;
        return fl ? jm::min(stop, p - *fl) : stop;
    }
    if (p >= cost) return std::nullopt;
    const double stop = cost - (cost - p) * keep;
    return fl ? jm::max(stop, p + *fl) : stop;
}

OJson hostedPlan(const Position& position, const OJson& targets, const OJson& autoClose, std::optional<double> peak) {
    OJson plan = js::array();
    if (!js::truthy(get(autoClose, u"host_at_broker"))) return plan;
    const double qty = closeQty(position, autoClose);
    const QString side = closeSide(position);
    const auto tpRaw = fin(get(targets, u"take_profit"));
    if (js::truthy(get(autoClose, u"spot_stop_at_broker")) && (position.sec_type == u"OPT" || position.sec_type == u"BAG")) {
        OJson conditions = js::array();
        QStringList lines;
        for (const bool above : {false, true}) {
            const auto price = fin(get(targets, above ? u"spot_stop_above" : u"spot_stop_below"));
            if (!price || *price <= 0) continue;
            conditions.items.append(js::object({{u"price"_s, js::N(*price)}, {u"isMore"_s, js::B(above)}}));
            lines.append((above ? u"≥ "_s : u"≤ "_s) + G(*price));
        }
        if (!conditions.items.isEmpty()) {
            const bool limit = position.sec_type == u"BAG" || js::str(get(autoClose, u"order_type")) == u"LMT";
            const auto price = fin(get(autoClose, u"spot_stop_limit"));
            if (limit && (!price || *price <= 0)) throw TrackerError(u"IBKR 标的条件止损的限价平仓必须填写正数平仓限价。"_s);
            // 限价是用户明确给出的最低收入 / 最高支出,取整不能越过这个边界。
            const double tick = price ? closeTick(position, *price) : 0.01;
            const auto lmt = limit ? js::N(R((isLong(position) ? std::ceil(*price / tick - 1e-9) : std::floor(*price / tick + 1e-9)) * tick, 4)) : js::Null();
            if (limit && lmt.n <= 0) throw TrackerError(u"条件平仓限价低于最小报价单位。"_s);
            OJson item = planItem(kHostedKindSpot, side, limit ? u"LMT"_s : u"MKT"_s, qty, lmt, js::Null(), js::Null(), js::Null(),
                                 hostedLabel(kHostedKindSpot) + u" "_s + position.symbol + u" "_s + lines.join(u" 或 "_s));
            item.set(u"spot_conditions"_s, conditions);
            plan.items.append(item);
        }
    }
    if (position.sec_type == u"BAG") {
        if (const auto flyTp = hostedComboPrice(position, tpRaw))
            plan.items.append(planItem(kHostedKindTp, side, u"LMT"_s, qty, js::N(*flyTp), OJson::null(), OJson::null(), OJson::null(),
                                       hostedLabel(kHostedKindTp) + u" "_s + util::pyFloat(*flyTp)));
        return plan;
    }
    const auto tp = position.sec_type == u"STK" ? hostedPrice(tpRaw) : hostedComboPrice(position, tpRaw);
    if (tp)
        plan.items.append(planItem(kHostedKindTp, side, u"LMT"_s, qty, js::N(*tp), OJson::null(), OJson::null(), OJson::null(),
                                   hostedLabel(kHostedKindTp) + u" "_s + util::pyFloat(*tp)));
    if (const auto sl = hostedStopPrice(position, fin(get(targets, u"stop_loss"))))
        plan.items.append(planItem(kHostedKindSl, side, u"STP"_s, qty, OJson::null(), js::N(*sl), OJson::null(), OJson::null(),
                                   hostedLabel(kHostedKindSl) + u" "_s + util::pyFloat(*sl)));
    const auto trail = fin(get(targets, u"trail_pct"));
    if (trail && *trail > 0 && *trail < 100) {
        const OJson t = js::N(*trail);
        const auto seed = hostedStopPrice(position, trailStopPrice(position, peak, &t));
        plan.items.append(planItem(kHostedKindTrail, side, u"TRAIL"_s, qty, OJson::null(), OJson::null(), js::N(*trail), optN(seed),
                                   hostedLabel(kHostedKindTrail) + u" "_s + G(*trail) + u"%"_s));
    }
    bool armed = false;
    if (peak) {
        const OJson pp = js::N(marketValue(position, *peak).value_or(0) - costBasis(position)), bs = js::N(costBasis(position));
        armed = analysis::drawdownArmed(targets, &pp, &bs);
    }
    const auto pstop = armed ? hostedStopPrice(position, profitTrailStopPrice(position, peak, fin(get(targets, u"profit_drawdown_pct")))) : std::nullopt;
    if (pstop)
        plan.items.append(planItem(kHostedKindPtrail, side, u"STP"_s, qty, OJson::null(), js::N(*pstop), OJson::null(), OJson::null(),
                                   hostedLabel(kHostedKindPtrail) + u" "_s + util::pyFloat(*pstop)));
    return plan;
}

bool hostedNeedsUpdate(const OJson& current, const OJson& desired) {
    if (js::prop(&current, u"spot_conditions"_s) || js::prop(&desired, u"spot_conditions"_s)) {
        if (js::str(js::prop(&current, u"order_type"_s)) != js::str(js::prop(&desired, u"order_type"_s)) ||
            js::stringify(js::copyOrNull(js::prop(&current, u"spot_conditions"_s))) != js::stringify(js::copyOrNull(js::prop(&desired, u"spot_conditions"_s)))) return true;
    }
    const auto qty = [](const OJson& o) {
        const OJson* q = js::prop(&o, u"quantity"_s);
        return std::trunc(js::nullish(q) ? 0 : js::num(q));
    };
    const double qa = qty(current), qb = qty(desired);
    if (!(qa == qb)) return true;  // NaN !== NaN:要改
    for (const char16_t* key : {u"lmt_price", u"aux_price", u"trailing_percent"}) {
        const auto a = fin(get(current, key)), b = fin(get(desired, key));
        if (a.has_value() != b.has_value()) return true;
        if (a && b && util::jsRound(*a * 100) != util::jsRound(*b * 100)) return true;
    }
    return false;
}

}  // namespace ibkr::orchestrate::tracker
