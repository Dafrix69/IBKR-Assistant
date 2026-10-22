#include "analysis/flyexit.h"

#include "analysis/fly_model.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/py.h"
#include "util/tz.h"

#include <QStringList>

#include <array>
#include <cmath>
#include <limits>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;

namespace ibkr::analysis::flyexit {

namespace {
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

/// params[k] 当数用(TS 的 params["em"] * …:按 Number() 转)
double P(const OJson& params, const char16_t* k) { return js::num(params.get(QString::fromUtf16(k))); }
double num(const OJson& o, const char16_t* k) { return js::num(js::prop(&o, QString::fromUtf16(k))); }
const OJson* raw(const OJson& o, const char16_t* k) { return js::prop(&o, QString::fromUtf16(k)); }
QString n2s(double v) { return util::jsNumberToString(v); }
double at(const std::vector<double>& v, double i) {
    if (!(i >= 0) || i != std::floor(i) || i >= double(v.size())) return kNaN;
    return v[size_t(i)];
}
/// "key" in DEFAULTS 对 Object.prototype 上的名字也成立(__proto__ 不在表里:给它赋一个数不起作用,给一个对象是改原型,JSON 里都看不见)
bool onObjectPrototype(const QString& k) {
    static const QStringList names{u"constructor"_s,      u"__defineGetter__"_s, u"__defineSetter__"_s, u"hasOwnProperty"_s,
                                   u"__lookupGetter__"_s, u"__lookupSetter__"_s, u"isPrototypeOf"_s,    u"propertyIsEnumerable"_s,
                                   u"toString"_s,         u"valueOf"_s,          u"toLocaleString"_s};
    return names.contains(k);
}
}  // namespace

const std::vector<double>& varianceWeights() { return flyIvModel().variance_weights; }

const OJson& defaults() {
    static const OJson d = js::object({
        {u"em"_s, js::N(36.0)},
        {u"tp1"_s, js::Null()},
        {u"tp2"_s, js::Null()},
        {u"stop"_s, js::N(0.5)},
        {u"trail_arm"_s, js::N(1.3)},
        {u"trail"_s, js::N(0.3)},
        {u"trail_loose_below"_s, js::N(1.0)},
        {u"trail_loose"_s, js::N(0.4)},
        {u"trail_tight_at"_s, js::N(3.0)},
        {u"trail_tight"_s, js::N(0.2)},
        {u"trail_floor"_s, js::N(0.2)},
        {u"trail_late"_s, js::S(u"15:00"_s)},
        {u"trail_late_factor"_s, js::N(0.5)},
        {u"zone_hold"_s, js::N(0.45)},
        {u"zone_half"_s, js::N(0.55)},
        {u"zone_stop"_s, js::N(0.8)},
        {u"stop_var"_s, js::N(0.3)},
        {u"cutoff_a"_s, js::S(u"14:00"_s)},
        {u"switch_k"_s, js::N(1.6)},
        {u"otm_band"_s, js::N(10.0)},
        {u"cutoff_a_share"_s, js::Null()},
    });
    return d;
}

OJson paramsFrom(const OJson* rawParams) {
    OJson out = defaults();
    // Object.entries:只有对象有自己的键(数组、串的下标键都不在 DEFAULTS 里)
    if (!js::isObj(rawParams)) return out;
    for (const auto& [key, value] : rawParams->fields) {
        if ((!defaults().get(key) && !onObjectPrototype(key)) || value.type == OJson::Null) continue;
        if (isClockKey(key)) {
            out.set(key, js::S(js::str(&value)));
        } else {
            const double v = js::num(&value);
            if (std::isfinite(v) && v > 0 && !(value.type == OJson::String && util::jsTrim(value.s).isEmpty())) out.set(key, js::N(v));
        }
    }
    return out;
}

// ================================================================ 时间与方差
double minutesOf(const QString& hhmm) {
    const QStringList parts = hhmm.split(u':');
    const double h = util::jsStringToNumber(parts.value(0));
    const double m = parts.size() > 1 ? util::jsStringToNumber(parts[1]) : kNaN;  // 没有冒号:m 是 undefined
    return h * 60 + m;
}

namespace {
double remainingVarianceRaw(double minute) {
    if (minute <= kOpenMin) return 1.0;
    if (minute >= kCloseMin) return 0.0;
    const std::vector<double>& w = varianceWeights();
    const double elapsed = minute - kOpenMin;
    const double bucket = std::floor(elapsed / 30);
    const double frac = (elapsed - bucket * 30) / 30.0;
    double used = 0;
    for (double i = 0; i < bucket; i += 1) used += at(w, i);
    used += at(w, bucket) * frac;
    return util::pyRound(jm::max(0.0, jm::min(1.0, 1.0 - used)), 6);
}
}  // namespace

double remainingVariance(double minute) {
    // 整分钟的值查表(纯函数;回放每一分钟都要从开盘扫一遍,pyRound 是按十进制展开取舍的,不便宜)
    static const std::array<double, 391> table = [] {
        std::array<double, 391> t{};
        for (int i = 0; i <= 390; ++i) t[size_t(i)] = remainingVarianceRaw(kOpenMin + i);
        return t;
    }();
    if (minute >= kOpenMin && minute <= kCloseMin && minute == std::floor(minute)) return table[size_t(minute - kOpenMin)];
    return remainingVarianceRaw(minute);
}

double sigmaRemaining(double em, double minute) { return util::pyRound(em * std::sqrt(remainingVariance(minute)), 4); }

double cutoffMinute(const OJson& params) {
    const OJson* share = params.get(u"cutoff_a_share"_s);
    if (js::nullish(share)) return minutesOf(js::str(params.get(u"cutoff_a"_s)));
    const double limit = js::num(share);
    for (double minute = kOpenMin; minute <= kCloseMin; minute += 1)
        if (remainingVariance(minute) <= limit) return minute;
    return kCloseMin;
}

QString phaseAt(double minute, double width, const OJson& params) {
    if (minute < cutoffMinute(params)) return u"A"_s;
    if (sigmaRemaining(P(params, u"em"), minute) < width / P(params, u"switch_k")) return u"C"_s;
    return u"B"_s;
}

double switchMinute(double width, const OJson& params) {
    const double threshold = width / P(params, u"switch_k");
    for (double minute = kOpenMin; minute <= kCloseMin; minute += 1)
        if (sigmaRemaining(P(params, u"em"), minute) < threshold) return minute;
    return kCloseMin;
}

// ================================================================ 回撤追踪
double trailPct(double profitPeak, double d, double minute, const OJson& params) {
    double pct;
    if (profitPeak < P(params, u"trail_loose_below") * d) pct = P(params, u"trail_loose");
    else if (profitPeak >= P(params, u"trail_tight_at") * d) pct = P(params, u"trail_tight");
    else pct = P(params, u"trail");
    if (minute >= minutesOf(js::str(params.get(u"trail_late"_s)))) pct *= P(params, u"trail_late_factor");
    return util::pyRound(pct, 6);
}

double trailStop(double profitPeak, double d, double minute, const OJson& params) {
    return util::pyRound(d + profitPeak * (1.0 - trailPct(profitPeak, d, minute, params)), 4);
}

namespace {
OJson tier(double above, double pct) { return js::object({{u"above"_s, js::N(above)}, {u"pct"_s, js::N(pct)}}); }
}  // namespace

OJson drawdownTiers(const OJson* rawParams) {
    const OJson p = paramsFrom(rawParams);
    return js::array({tier(0.0, util::pyRound(P(p, u"trail_loose") * 100, 4)), tier(P(p, u"trail_loose_below"), util::pyRound(P(p, u"trail") * 100, 4)),
                      tier(P(p, u"trail_tight_at"), util::pyRound(P(p, u"trail_tight") * 100, 4))});
}

OJson drawdownLate(const OJson* rawParams) {
    const OJson p = paramsFrom(rawParams);
    return js::object({{u"after"_s, js::copyOrNull(p.get(u"trail_late"_s))}, {u"factor"_s, js::N(P(p, u"trail_late_factor"))}});
}

double drawdownArm(const OJson* rawParams) { return util::pyRound(P(paramsFrom(rawParams), u"trail_arm") - 1.0, 6); }

OJson drawdownUsdPreset(std::optional<double> unitCostUsd, const OJson* rawParams) {
    const double cost = unitCostUsd ? std::fabs(*unitCostUsd) : kNaN;
    if (!std::isfinite(cost) || cost <= 0) return OJson::null();
    const OJson p = paramsFrom(rawParams);
    const double tighten = util::pyRound(kFlyTightenUsd / cost, 6);
    OJson tiers = js::array({tier(0.0, util::pyRound(P(p, u"trail_loose") * 100, 4)), tier(tighten, util::pyRound(P(p, u"trail") * 100, 4))});
    if (P(p, u"trail_tight_at") > tighten) tiers.items.append(tier(P(p, u"trail_tight_at"), util::pyRound(P(p, u"trail_tight") * 100, 4)));
    return js::object({{u"tiers"_s, tiers}, {u"arm"_s, js::N(util::pyRound(kFlyArmUsd / cost, 6))}});
}

double drawdownFloor(const OJson* rawParams) { return P(paramsFrom(rawParams), u"trail_floor"); }

QString fmtMinute(double minute) {
    const double h = std::floor(minute / 60), m = std::fmod(minute, 60);
    return util::pad2(h) + u':' + util::pad2(m);
}

// ================================================================ 模型价
namespace {
double cdf(double x) { return 0.5 * (1.0 + jm::stdlibErf(x / std::sqrt(2.0))); }
double pdf(double x) { return jm::exp(-0.5 * x * x) / std::sqrt(2.0 * M_PI); }
bool isPut(const QString& right) { return right.left(1).toUpper() == u"P"; }
}  // namespace

double bachelierCall(double s, double k, double sigma) {
    if (sigma <= 1e-9) return jm::max(s - k, 0.0);
    const double z = (s - k) / sigma;
    return (s - k) * cdf(z) + sigma * pdf(z);
}

double bachelierPut(double s, double k, double sigma) { return bachelierCall(s, k, sigma) - (s - k); }

double modelPrice(const OJson& profile, double s, double sigma) {
    const double k1 = num(profile, u"lower"), k2 = num(profile, u"center"), k3 = num(profile, u"upper");
    double calls = bachelierCall(s, k1, sigma) - 2 * bachelierCall(s, k2, sigma) + bachelierCall(s, k3, sigma);
    const OJson* right = raw(profile, u"right");
    if (js::isStr(right) && right->s == u"P") calls -= (s - k1) - 2 * (s - k2) + (s - k3);
    return util::pyRound(jm::max(calls, 0.0), 4);
}

double legValue(const QString& right, double s, double k, double sigma) { return isPut(right) ? bachelierPut(s, k, sigma) : bachelierCall(s, k, sigma); }

double structureValue(const std::vector<StructureLeg>& legs, double s, double sigma) {
    double out = 0;
    for (const StructureLeg& leg : legs) out += leg.ratio * legValue(leg.right, s, leg.strike, sigma);
    return util::pyRound(out, 4);
}

// ================================================================ 反解 σ
namespace {
template <class F>
std::optional<double> bisect(F&& f, double target, double lo, double hi, bool rising) {
    const double flo = f(lo), fhi = f(hi);
    if (rising ? target <= flo || target >= fhi : target >= flo || target <= fhi) return std::nullopt;
    double a = lo, b = hi;
    for (int i = 0; i < 200; ++i) {
        const double mid = (a + b) / 2;
        const double v = f(mid);
        if (std::fabs(v - target) < 1e-9 || b - a < 1e-9) return mid;
        if (rising ? v < target : v > target) a = mid;
        else b = mid;
    }
    return (a + b) / 2;
}
}  // namespace

std::optional<double> impliedSigmaLeg(double s, double k, double price, const QString& right) {
    if (!std::isfinite(s) || !std::isfinite(k) || !std::isfinite(price) || price <= 0) return std::nullopt;
    const bool put = isPut(right);
    const auto sigma = bisect([&](double x) { return put ? bachelierPut(s, k, x) : bachelierCall(s, k, x); }, price, kSigmaMin, kSigmaMax, true);
    if (!sigma) return std::nullopt;
    return util::pyRound(*sigma, 6);
}

std::optional<double> impliedSigmaFly(const OJson& profile, double s, double price) {
    const double k = num(profile, u"center"), w = num(profile, u"width");
    if (!std::isfinite(s) || !std::isfinite(k) || !std::isfinite(w) || w <= 0) return std::nullopt;
    if (!std::isfinite(price) || price <= 0) return std::nullopt;
    if (std::fabs(s - k) >= w) return std::nullopt;  // 翼外:双根,不解
    const auto sigma = bisect([&](double x) { return modelPrice(profile, s, x); }, price, kSigmaMin, kSigmaMax, false);
    if (!sigma) return std::nullopt;
    return util::pyRound(*sigma, 6);
}

// ================================================================ 点位与区间
std::pair<double, double> trancheSizes(double qty) {
    const double third = qty > 0 ? jm::max(1, std::floor(qty / 3)) : 0;
    return {jm::min(third, qty), jm::min(third, jm::max(qty - third, 0))};
}

OJson levels(const OJson& profile, const OJson& params) {
    const OJson* dRaw = raw(profile, u"debit");
    if (js::nullish(dRaw)) return js::array();
    const double d = js::num(dRaw);
    const double mult = num(profile, u"multiplier");
    const OJson qty = js::copyOrNull(raw(profile, u"qty"));
    const auto [t1, t2] = trancheSizes(js::num(raw(profile, u"qty")));
    struct Row {
        QString kind;
        const OJson* multOfD;
        QString label;
        OJson tranche;
    };
    const Row rows[] = {{u"tp1"_s, params.get(u"tp1"_s), u"第一档止盈"_s, js::N(t1)},
                        {u"tp2"_s, params.get(u"tp2"_s), u"第二档止盈"_s, js::N(t2)},
                        {u"trail_arm"_s, params.get(u"trail_arm"_s), u"回撤追踪激活"_s, js::N(0)},
                        {u"stop"_s, params.get(u"stop"_s), u"止损"_s, raw(profile, u"qty") ? qty : OJson()}};
    OJson out = js::array();
    for (const Row& r : rows) {
        if (js::nullish(r.multOfD)) continue;
        const double price = util::pyRound(d * js::num(r.multOfD), 4);
        const double per = util::pyRound((price - d) * mult, 2);
        OJson row = js::object({{u"kind"_s, js::S(r.kind)},
                                {u"price"_s, js::N(price)},
                                {u"mult_of_debit"_s, *r.multOfD},
                                {u"label"_s, js::S(r.label)}});
        // tranche_qty 是 undefined(profile 没有 qty)时 JSON 里没有这一键
        const bool trancheUndefined = r.kind == u"stop" && !raw(profile, u"qty");
        if (!trancheUndefined) row.set(u"tranche_qty"_s, r.tranche);
        row.set(u"pnl_per_contract"_s, js::N(per));
        row.set(u"expected_pnl"_s, !trancheUndefined && js::truthy(&r.tranche) ? js::N(util::pyRound(per * js::num(&r.tranche), 2)) : js::Null());
        out.items.append(row);
    }
    return out;
}

OJson zones(const OJson& profile, const OJson& params) {
    const double k = num(profile, u"center"), w = num(profile, u"width");
    const auto row = [&](const QString& kind, double ratio, const QString& label) {
        return js::object({{u"kind"_s, js::S(kind)},
                           {u"half_width"_s, js::N(util::pyRound(ratio * w, 4))},
                           {u"low"_s, js::N(util::pyRound(k - ratio * w, 4))},
                           {u"high"_s, js::N(util::pyRound(k + ratio * w, 4))},
                           {u"label"_s, js::S(label)}});
    };
    const double hold = P(params, u"zone_hold"), half = P(params, u"zone_half"), stop = P(params, u"zone_stop");
    return js::array({
        row(u"hold"_s, hold, u"±%1W 临界线:阶段 B 出界全清、阶段 C 界内持到结算"_s.arg(util::fmtF(hold, 2))),
        row(u"half"_s, half, u"±%1W:阶段 C 落在 0.45W–0.55W 清一半,更远立即清残值"_s.arg(util::fmtF(half, 2))),
        row(u"stop"_s, stop, u"±%1W:剩余方差 > %2% 时出界止损"_s.arg(util::fmtF(stop, 2), n2s(util::jsRound(P(params, u"stop_var") * 100)))),
    });
}

// ================================================================ 逐分钟回放
namespace {
/// String(b["time"] ?? "") → 收盘价(只收有限数;同一个时刻后来的覆盖)
QHash<QString, double> barCloseMap(const OJson& bars) {
    QHash<QString, double> out;
    for (const OJson& b : bars.items) {
        const OJson* c = js::propStrict(&b, u"close"_s);
        if (js::nullish(c)) continue;
        const double v = js::num(c);
        if (!std::isfinite(v)) continue;
        out.insert(js::strOr(js::prop(&b, u"time"_s), QString()), v);
    }
    return out;
}

double intrinsic(const OJson& profile, double s) {
    const double k1 = num(profile, u"lower"), k2 = num(profile, u"center"), k3 = num(profile, u"upper");
    const OJson* right = raw(profile, u"right");
    double v;
    if (js::isStr(right) && right->s == u"P") v = jm::max(k1 - s, 0) - 2 * jm::max(k2 - s, 0) + jm::max(k3 - s, 0);
    else v = jm::max(s - k1, 0) - 2 * jm::max(s - k2, 0) + jm::max(s - k3, 0);
    return util::pyRound(v, 4);
}

OJson notApplicable(const QString& reason) { return js::object({{u"applicable"_s, js::B(false)}, {u"reason"_s, js::S(reason)}}); }
}  // namespace

OJson simulate(const OJson& profile, const QString& entryBarTime, const OJson& spxBars, const OJson& flyBars, const OJson& params, const OJson* actual) {
    const OJson* dRaw = raw(profile, u"debit");
    const OJson* action = raw(profile, u"action");
    if (!(js::isStr(action) && action->s == u"BUY"))
        return notApplicable(u"该止盈策略只适用于多头蝶(买翼卖中心);这是一张卖出的蝶。"_s);
    if (js::nullish(dRaw)) return notApplicable(u"没有入场净权利金 D,策略的所有阈值都以 D 为基准,无法回放。"_s);
    const double d = js::num(dRaw);
    const double qty = std::trunc(num(profile, u"qty"));
    const double mult = num(profile, u"multiplier");
    const double k = num(profile, u"center"), w = num(profile, u"width");
    const QHash<QString, double> flyClose = barCloseMap(flyBars);
    const QString day = entryBarTime.left(10);

    QList<const OJson*> timeline;
    for (const OJson& b : spxBars.items) {
        const QString t = js::strOr(js::propStrict(&b, u"time"_s), QString());
        const OJson* c = js::prop(&b, u"close"_s);
        if (t >= entryBarTime && t.left(10) == day && !js::nullish(c)) timeline << &b;
    }
    if (timeline.isEmpty()) return notApplicable(u"开仓当天没有标的 K 线,无法回放。"_s);

    double remaining = qty;
    const auto [t1, t2] = trancheSizes(qty);
    bool tp1Done = false, tp2Done = false, halfDone = false, otmDone = false;
    const double entryS = js::num(js::prop(timeline[0], u"close"_s));
    const double zoneStop = P(params, u"zone_stop");
    const bool entryOutside = std::fabs(entryS - k) > zoneStop * w;
    bool insideSeen = !entryOutside;
    double profitPeak = 0.0;
    bool armed = false;
    OJson events = js::array();
    OJson series = js::array();
    bool enteredB = false;
    bool settled = false;

    const auto sell = [&](const QString& time, double n, double price, const QString& phase, const QString& rule, const QString& source) {
        n = jm::max(0, jm::min(n, remaining));
        if (n <= 0) return;  // 数量是 NaN 时 JS 照样往下走(NaN <= 0 是 false)
        const double pnl = util::pyRound((price - d) * mult * n, 2);
        events.items.append(js::object({{u"time"_s, js::S(time)},
                                        {u"phase"_s, js::S(phase)},
                                        {u"rule"_s, js::S(rule)},
                                        {u"qty"_s, js::N(n)},
                                        {u"price"_s, js::N(util::pyRound(price, 4))},
                                        {u"pnl"_s, js::N(pnl)},
                                        {u"source"_s, js::S(source)},
                                        {u"remaining"_s, js::N(remaining - n)}}));
        remaining -= n;
    };
    const auto F = [](double v, int nd) { return util::fmtF(v, nd); };

    for (const OJson* bar : timeline) {
        const QString t = js::str(js::prop(bar, u"time"_s));
        const double minute = minutesOf(t.mid(11, 5));
        if (minute > kCloseMin) break;
        const double s = js::num(js::prop(bar, u"close"_s));
        const double sigma = sigmaRemaining(P(params, u"em"), minute);
        const auto realIt = flyClose.constFind(t);
        const bool isReal = realIt != flyClose.constEnd();
        const double price = isReal ? *realIt : modelPrice(profile, s, sigma);
        const QString source = isReal ? u"real"_s : u"model"_s;
        const double dist = std::fabs(s - k);
        const QString phase = phaseAt(minute, w, params);
        const double r = remainingVariance(minute);
        if (remaining > 0) {
            if (!armed && price >= P(params, u"trail_arm") * d) armed = true;
            if (armed) profitPeak = jm::max(profitPeak, price - d);
        }
        const OJson stopLine = armed ? js::N(trailStop(profitPeak, d, minute, params)) : js::Null();
        series.items.append(js::object({{u"time"_s, js::S(t)},
                                        {u"price"_s, js::N(util::pyRound(price, 4))},
                                        {u"source"_s, js::S(source)},
                                        {u"phase"_s, js::S(phase)},
                                        {u"sigma_rem"_s, js::N(sigma)},
                                        {u"dist"_s, js::N(util::pyRound(dist, 4))},
                                        {u"remaining"_s, js::N(remaining)},
                                        {u"trail_stop"_s, stopLine}}));
        if (remaining <= 0) continue;

        if (minute >= kCloseMin) {
            const double settle = intrinsic(profile, s);
            sell(t, remaining, settle, phase, u"结算:按 16:00 标的 %1 的内在价值 %2"_s.arg(F(s, 2), F(settle, 2)), u"settle"_s);
            settled = true;
            break;
        }

        if (price <= P(params, u"stop") * d) {
            sell(t, remaining, price, phase, u"止损:蝶价 %1 ≤ %2×D"_s.arg(F(price, 2), F(P(params, u"stop"), 2)), source);
            continue;
        }
        if (dist <= zoneStop * w) insideSeen = true;
        if (insideSeen && dist > zoneStop * w && r > P(params, u"stop_var")) {
            sell(t, remaining, price, phase,
                 u"止损:|S−K| = %1 > %2W 且剩余方差 %3% > %4%"_s.arg(F(dist, 1), F(zoneStop, 2), F(r * 100, 0), F(P(params, u"stop_var") * 100, 0)), source);
            continue;
        }
        if (entryOutside && !otmDone && dist <= P(params, u"otm_band")) {
            otmDone = true;
            // 至少留 1 张:标的刚贴近中心正是蝶价要爆发的时刻
            const double otmQty = jm::min(t1, remaining - 1);
            if (otmQty > 0)
                sell(t, otmQty, price, phase,
                     u"OTM 蝶:标的 %1 进入 K±%2,分批落袋 %3 张"_s.arg(F(s, 2), util::pyG(P(params, u"otm_band")), n2s(otmQty)), source);
            if (remaining <= 0) continue;
        }

        // 回撤追踪:阶段 A/B 全天生效;阶段 C 与 B 出界交给区间规则
        const bool zoneTakesOver = phase == u"C" || (phase == u"B" && dist > P(params, u"zone_hold") * w);
        if (armed && !zoneTakesOver && profitPeak > 0) {
            const double giveBack = profitPeak - (price - d);
            const double pct = trailPct(profitPeak, d, minute, params);
            if (giveBack >= profitPeak * pct && giveBack >= P(params, u"trail_floor")) {
                sell(t, remaining, price, phase,
                     u"回撤追踪:浮盈从高水位 %1 回吐 %2(%3% 档,触发价 %4),清仓"_s.arg(F(profitPeak, 2), F(giveBack, 2), F(pct * 100, 0),
                                                                                   F(trailStop(profitPeak, d, minute, params), 2)),
                     source);
                continue;
            }
        }

        if (phase == u"A") {
            const OJson* tp1 = params.get(u"tp1"_s);
            const OJson* tp2 = params.get(u"tp2"_s);
            // TS 比的是 !== null:undefined 也算"有"
            if (!(tp1 && tp1->type == OJson::Null) && !tp1Done && price >= js::num(tp1) * d) {
                tp1Done = true;
                sell(t, t1, price, phase, u"第一档:蝶价 %1 ≥ %2×D,清 1/3"_s.arg(F(price, 2), F(js::num(tp1), 2)), source);
            }
            if (!(tp2 && tp2->type == OJson::Null) && remaining > 0 && !tp2Done && price >= js::num(tp2) * d) {
                tp2Done = true;
                sell(t, t2, price, phase, u"第二档:蝶价 %1 ≥ %2×D,再清 1/3"_s.arg(F(price, 2), F(js::num(tp2), 2)), source);
            }
            continue;
        }

        if (phase == u"B") {
            if (!enteredB) {
                enteredB = true;
                // 至少留 1 张
                const double cap = jm::max(1, std::floor(qty / 3));
                if (remaining > cap) {
                    sell(t, remaining - cap, price, phase, u"进入 14:00 过渡:留仓压到 1/3(%1 张)"_s.arg(n2s(cap)), source);
                    if (remaining <= 0) continue;
                }
            }
            if (dist > P(params, u"zone_hold") * w)
                sell(t, remaining, price, phase, u"阶段 B:|S−K| = %1 > %2W,全清"_s.arg(F(dist, 1), F(P(params, u"zone_hold"), 2)), source);
            continue;
        }

        // 阶段 C
        if (dist > P(params, u"zone_half") * w) {
            sell(t, remaining, price, phase, u"阶段 C:|S−K| = %1 > %2W,立即清残值"_s.arg(F(dist, 1), F(P(params, u"zone_half"), 2)), source);
        } else if (dist >= P(params, u"zone_hold") * w && !halfDone) {
            halfDone = true;
            sell(t, std::ceil(remaining / 2), price, phase,
                 u"阶段 C:|S−K| = %1 在 %2W–%3W,清一半"_s.arg(F(dist, 1), F(P(params, u"zone_hold"), 2), F(P(params, u"zone_half"), 2)), source);
        }
    }

    const OJson* last = timeline.last();
    if (remaining > 0 && !settled) {
        const double s = js::num(js::prop(last, u"close"_s));
        const QString t = js::str(js::prop(last, u"time"_s));
        if (minutesOf(t.mid(11, 5)) >= kCloseMin - 1) {
            const double settle = intrinsic(profile, s);
            sell(t, remaining, settle, u"C"_s, u"结算:按收盘标的 %1 的内在价值 %2"_s.arg(F(s, 2), F(settle, 2)), u"settle"_s);
        } else {
            const double mark = series.items.isEmpty() ? d : series.items.last().get(u"price"_s)->n;
            events.items.append(js::object({{u"time"_s, js::S(t)},
                                            {u"phase"_s, js::S(phaseAt(minutesOf(t.mid(11, 5)), w, params))},
                                            {u"rule"_s, js::S(u"数据到此为止,剩余 %1 张按最后蝶价 %2 估值(未平仓)"_s.arg(n2s(remaining), F(mark, 2)))},
                                            {u"qty"_s, js::N(remaining)},
                                            {u"price"_s, js::N(util::pyRound(mark, 4))},
                                            {u"pnl"_s, js::N(util::pyRound((mark - d) * mult * remaining, 2))},
                                            {u"source"_s, js::S(u"mark"_s)},
                                            {u"remaining"_s, js::N(remaining)}}));
            remaining = 0;
        }
    }

    double pnlSum = 0;
    for (const OJson& e : events.items) pnlSum = pnlSum + e.get(u"pnl"_s)->n;
    const double strategyPnl = util::pyRound(pnlSum, 2);
    const double holdPnl = util::pyRound((intrinsic(profile, js::num(js::prop(last, u"close"_s))) - d) * mult * qty, 2);
    const OJson actualPnl = !actual ? js::Null() : js::nullish(js::prop(actual, u"pnl"_s)) ? js::Null() : *js::prop(actual, u"pnl"_s);
    std::optional<double> bestMid;
    if (!series.items.isEmpty()) {
        double m = -std::numeric_limits<double>::infinity();
        for (const OJson& p : series.items) m = jm::max(m, p.get(u"price"_s)->n);
        bestMid = m;
    }
    double modelMinutes = 0, realMinutes = 0;
    for (const OJson& p : series.items) {
        if (p.get(u"source"_s)->s == u"model") modelMinutes += 1;
        if (p.get(u"source"_s)->s == u"real") realMinutes += 1;
    }
    return js::object({
        {u"applicable"_s, js::B(true)},
        {u"entry_outside"_s, js::B(entryOutside)},
        {u"entry_dist"_s, js::N(util::pyRound(std::fabs(entryS - k), 4))},
        {u"events"_s, events},
        {u"series"_s, series},
        {u"totals"_s, js::object({{u"strategy"_s, js::N(strategyPnl)},
                                  {u"actual"_s, actualPnl},
                                  {u"hold_to_settle"_s, js::N(holdPnl)},
                                  {u"best_mid"_s, bestMid ? js::N(util::pyRound(*bestMid, 4)) : js::Null()},
                                  {u"best_mid_pnl"_s, bestMid ? js::N(util::pyRound((*bestMid - d) * mult * qty, 2)) : js::Null()},
                                  {u"profit_peak"_s, js::N(util::pyRound(profitPeak, 4))},
                                  {u"model_minutes"_s, js::N(modelMinutes)},
                                  {u"real_minutes"_s, js::N(realMinutes)}})},
    });
}

// ================================================================ 汇总
OJson plan(const OJson& profile, const QString& entryBarTime, const OJson& spxBars, const OJson& flyBars, const OJson* rawParams, const OJson* actual,
           const std::optional<QString>& emNote) {
    const OJson params = paramsFrom(rawParams);
    const double w = num(profile, u"width");
    const double sw = switchMinute(w, params);
    const double cutoff = cutoffMinute(params);
    const OJson* em = params.get(u"em"_s);
    const auto G = [&](const char16_t* k) { return util::pyG(P(params, k)); };
    const auto F = [&](const char16_t* k, int nd, double scale = 1) { return util::fmtF(P(params, k) * scale, nd); };
    OJson notes = js::array({
        js::S(emNote ? *emNote : u"EM 取 %1 点。EM 是常规时段一个标准差的点数 = 平值跨式 × √(π/2)(约 1.25),应取开仓那一天的"_s.arg(G(u"em"))),
        js::S(u"触发判断用组合分钟线的中间价,文档要求按 bid,回放结果略偏乐观"_s),
        // 拼接而不是链式 arg:trail_late 是用户给的串,链式 arg 会把它里面的 %N 也当成占位符
        js::S(u"止盈按浮盈回撤追踪:蝶价 ≥ "_s + F(u"trail_arm", 2) + u"×D 后记高水位,浮盈 < "_s + G(u"trail_loose_below") + u"×D 让 "_s +
              F(u"trail_loose", 0, 100) + u"%、"_s + G(u"trail_loose_below") + u"–"_s + G(u"trail_tight_at") + u"×D 让 "_s + F(u"trail", 0, 100) +
              u"%、≥ "_s + G(u"trail_tight_at") + u"×D 让 "_s + F(u"trail_tight", 0, 100) + u"%,"_s + js::str(params.get(u"trail_late"_s)) +
              u" 之后再乘 "_s + G(u"trail_late_factor") + u";回吐不足 "_s + G(u"trail_floor") + u" 点不触发。阶段 C 交给区间规则。"_s),
    });
    OJson out = js::object({
        {u"params"_s, params},
        {u"levels"_s, levels(profile, params)},
        {u"zones"_s, zones(profile, params)},
        {u"phases"_s, js::object({{u"a_until"_s, js::S(fmtMinute(cutoff))},
                                  {u"c_from"_s, js::S(fmtMinute(sw))},
                                  {u"sigma_at_switch"_s, js::N(sigmaRemaining(P(params, u"em"), sw))},
                                  {u"threshold"_s, js::N(util::pyRound(w / P(params, u"switch_k"), 4))},
                                  {u"em_at_open"_s, js::copyOrNull(em)},
                                  {u"wing_in_sigma"_s, js::truthy(em) ? js::N(util::pyRound(w / js::num(em), 2)) : js::Null()}})},
    });
    const OJson* tp1 = params.get(u"tp1"_s);
    const OJson* tp2 = params.get(u"tp2"_s);
    if (tp1 && tp1->type == OJson::Null && tp2 && tp2->type == OJson::Null)
        notes.items.append(js::S(
            u"固定倍数档位已关闭(蝶价上限就是翼宽 %1,用 D 的倍数封顶会在 D 小的时候锁死出场);要恢复 v2.0 的分批止盈,传 tp1 / tp2 即可"_s.arg(util::pyG(w))));
    const OJson sim = simulate(profile, entryBarTime, spxBars, flyBars, params, actual);
    if (sim.get(u"applicable"_s)->b) {
        const OJson& totals = *sim.get(u"totals"_s);
        if (js::truthy(totals.get(u"model_minutes"_s)))
            notes.items.append(js::S(u"有 %1 分钟没有真实蝶价,用 Bachelier 模型价(σ_剩余)补上,图上以虚线区分"_s.arg(n2s(totals.get(u"model_minutes"_s)->n))));
        if (sim.get(u"entry_outside"_s)->b)
            notes.items.append(js::S(
                u"开仓时 |S−K| = %1 点 > %2W:这是远端 OTM 蝶(文档 §2.3),位置止损从标的首次进入 %3W 之后才生效,并按 OTM 规则在标的进入 K±%4 时分批落袋"_s.arg(
                    util::pyG(sim.get(u"entry_dist"_s)->n), F(u"zone_stop", 2), F(u"zone_stop", 2), G(u"otm_band"))));
    }
    out.set(u"notes"_s, notes);
    out.set(u"simulation"_s, sim);
    const OJson* dRaw = raw(profile, u"debit");
    if (!js::nullish(dRaw) && actual && !js::nullish(js::prop(actual, u"price"_s))) {
        const OJson* kind = js::prop(actual, u"kind"_s);
        if (js::isStr(kind) && kind->s == u"closed")
            out.set(u"actual_exit_mult"_s, js::truthy(dRaw) ? js::N(util::pyRound(js::num(js::prop(actual, u"price"_s)) / js::num(dRaw), 2)) : js::Null());
    }
    return out;
}

}  // namespace ibkr::analysis::flyexit
