#include "analysis/fly_plan.h"

#include "analysis/flyexit.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/py.h"
#include "util/tz.h"

#include <QRegularExpression>

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;

namespace ibkr::analysis::flyplan {

namespace {
constexpr double kYearMs = 365.0 * 24 * 3600 * 1000;
constexpr double kOpenMinute = 9 * 60 + 30;
constexpr double kDayMs = 24.0 * 3600 * 1000;
QString et() { return QString::fromUtf16(util::kET); }
double pyRound(double v, int nd) { return util::pyRound(v, nd); }
QString pyG(double v) { return util::pyG(v); }
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }

double etEpoch(const QString& date, double minuteOfDay) {
    const QStringList p = date.split(u'-');
    util::WallParts w;
    w.year = util::jsStringToNumber(p.value(0));
    w.month = p.size() > 1 ? util::jsStringToNumber(p[1]) : std::nan("");
    w.day = p.size() > 2 ? util::jsStringToNumber(p[2]) : std::nan("");
    w.hour = std::floor(minuteOfDay / 60);
    w.minute = std::fmod(minuteOfDay, 60);
    w.second = 0;
    return util::wallToEpoch(w, et());
}

double closeMinute(const QString& date, const PlanCalendar& calendar) { return calendar.isEarlyClose(date) ? 13 * 60 : 16 * 60; }

QString nextTradingDay(const QString& date, const PlanCalendar& calendar) {
    QString day = date;
    for (int i = 0; i < 14; ++i) {
        day = util::ordinalToDate(util::dateOrdinal(day) + 1);
        if (calendar.isTradingDay(day)) return day;
    }
    throw FlyPlanError(u"往后两周都找不到交易日,请检查休市日历。"_s);
}

double clampFactor(double f) { return jm::min(kIvFactorMax, jm::max(1 / kIvFactorMax, f)); }

double minuteOfDay(double ms) {
    const util::WallParts w = util::wallParts(ms, et());
    return w.hour * 60 + w.minute + w.second / 60;
}

std::optional<double> positive(const std::optional<double>& v) {
    return v && std::isfinite(*v) && *v > 0 ? v : std::nullopt;
}
/// 买价恰好为 0 是"没人出价",照实给 0
std::optional<double> bidOf(const LegMark* mark) {
    if (!mark) return std::nullopt;
    if (mark->bid && *mark->bid == 0) return 0.0;
    return positive(mark->bid);
}
std::optional<double> midOf(const LegMark* mark) {
    const auto bid = bidOf(mark);
    const auto ask = mark ? positive(mark->ask) : std::nullopt;
    if (!ask || !bid || *ask < *bid) return std::nullopt;
    return (*bid + *ask) / 2;
}

struct SignedLeg {
    double strike = 0;
    QString right;
    double ratio = 0;
};
QString keyOf(const SignedLeg& leg) { return markKey(leg.strike); }
const LegMark* markOf(const FlyPlanInput& input, const SignedLeg& leg) {
    const auto it = input.marks.find(keyOf(leg));
    return it == input.marks.end() ? nullptr : &it->second;
}
}  // namespace

const std::vector<double>& scenarioSteps() {
    static const std::vector<double> s{-25, 0, 25, 50, 100};
    return s;
}

QString markKey(double strike) { return pyG(strike); }

// ================================================================ 哪一天、几点、哪个到期日
PlanSchedule planSchedule(const ScheduleArgs& args, const PlanCalendar& calendar) {
    QStringList warnings;
    static const QRegularExpression hmRe(u"^([0-9]{1,2}):([0-9]{2})\\z"_s);
    const auto hm = hmRe.match(util::jsTrim(args.targetTime));
    if (!hm.hasMatch() || util::jsStringToNumber(hm.captured(1)) > 23 || util::jsStringToNumber(hm.captured(2)) > 59)
        throw FlyPlanError(u"目标时刻要写成美东时间的 HH:MM(如 14:30),收到「%1」。"_s.arg(args.targetTime));
    const double minute = util::jsStringToNumber(hm.captured(1)) * 60 + util::jsStringToNumber(hm.captured(2));

    const QString today = util::dateStrAt(args.nowMs, et());
    QString targetDate = util::jsTrim(args.targetDate.value_or(QString()));
    if (!targetDate.isEmpty()) {
        static const QRegularExpression dRe(u"^([0-9]{4})-([0-9]{2})-([0-9]{2})\\z"_s);
        const auto m = dRe.match(targetDate);
        if (!m.hasMatch() || !util::isValidYmd(m.captured(1).toDouble(), m.captured(2).toDouble(), m.captured(3).toDouble()))
            throw FlyPlanError(u"目标日期要写成 YYYY-MM-DD,收到「%1」。"_s.arg(args.targetDate ? *args.targetDate : u"undefined"_s));
        if (!calendar.isTradingDay(targetDate)) throw FlyPlanError(u"%1 不是交易日。"_s.arg(targetDate));
    } else {
        targetDate = today;
        if (!calendar.isTradingDay(today) || args.nowMs >= etEpoch(today, closeMinute(today, calendar))) {
            targetDate = nextTradingDay(today, calendar);
            warnings << u"今天已经收盘或不是交易日,按下一个交易日 %1 算。"_s.arg(targetDate);
        }
    }
    const double close = closeMinute(targetDate, calendar);
    if (minute < kOpenMinute || minute > close) {
        const QString until = close == 16 * 60 ? u"16:00"_s : u"13:00(这一天提前收盘)"_s;
        warnings << u"目标时刻不在常规交易时段里(美东 09:30–%1):那时指数不报价,期权的盘口也薄。"_s.arg(until);
    }

    QString expiry = util::jsTrim(args.expiry.value_or(QString()));
    if (expiry.isEmpty()) expiry = QString(targetDate).remove(u'-');
    static const QRegularExpression eRe(u"^([0-9]{4})([0-9]{2})([0-9]{2})\\z"_s);
    const auto e = eRe.match(expiry);
    if (!e.hasMatch() || !util::isValidYmd(e.captured(1).toDouble(), e.captured(2).toDouble(), e.captured(3).toDouble()))
        throw FlyPlanError(u"到期日要写成 YYYYMMDD,收到「%1」。"_s.arg(args.expiry ? *args.expiry : u"undefined"_s));
    const QString expiryDate = e.captured(1) + u'-' + e.captured(2) + u'-' + e.captured(3);
    if (!calendar.isTradingDay(expiryDate)) throw FlyPlanError(u"%1 不是交易日,没有这一天到期的合约。"_s.arg(expiryDate));
    const auto expiryMs0 = expiryEpochMs(args.symbol, expiry, args.tradingClass);
    if (!expiryMs0) throw FlyPlanError(u"认不出 %1 %2 是哪一种结算方式,算不了到期时刻。"_s.arg(args.symbol, expiry));
    double expiryMs = *expiryMs0;
    if (calendar.isEarlyClose(expiryDate) && expiryMs > etEpoch(expiryDate, 13 * 60)) {
        expiryMs = etEpoch(expiryDate, 13 * 60);
        warnings << u"%1 提前收盘,这只蝶按美东 13:00 到期算。"_s.arg(expiryDate);
    }

    std::vector<double> timeline;
    for (double at = kOpenMinute; at <= close; at += 30) timeline.push_back(etEpoch(targetDate, at));
    return {targetDate, etEpoch(targetDate, minute), expiry, expiryMs, timeline, warnings};
}

// ================================================================ IV 的走法
bool sameSession(double nowMs, double expiryMs) {
    const util::WallParts end = util::wallParts(expiryMs, et());
    return util::dateStrAt(nowMs, et()) == util::dateStrAt(expiryMs, et()) && end.hour == 16 && end.minute == 0;
}

double seasonalFactor(const FlyIvModel& model, double nowMs, double atMs, double expiryMs) {
    if (!(atMs > nowMs) || !(expiryMs > atMs) || !sameSession(nowMs, expiryMs)) return 1;
    if (model.own) return clampFactor(jm::exp(ownDriftAt(model.own->drift, minuteOfDay(atMs)) - ownDriftAt(model.own->drift, minuteOfDay(nowMs))));
    const double rv0 = remainingShare(model.variance_weights, minuteOfDay(nowMs));
    const double rv = remainingShare(model.variance_weights, minuteOfDay(atMs));
    if (!(rv0 > 0) || !(rv > 0)) return 1;
    return clampFactor(std::sqrt((rv / rv0) / ((expiryMs - atMs) / (expiryMs - nowMs))));
}

namespace {
Response responseFor(const FlyIvModel& model, double daysToExpiry, bool sameDay) {
    if (sameDay && model.own) return model.own->response;
    if (!model.response_long || !(daysToExpiry > 1)) return model.response;
    const Response& l = *model.response_long;
    const double w = jm::min(1, jm::log(daysToExpiry) / jm::log(model.response_long_days));
    const auto mix = [&](double a, double b) { return a + (b - a) * w; };
    return {mix(model.response.a, l.a), mix(model.response.b, l.b), mix(model.response.c, l.c)};
}
}  // namespace

double ivResponse(const FlyIvModel& model, double u, double daysToExpiry, bool sameDay) {
    if (!std::isfinite(u)) return 1;
    const Response beta = responseFor(model, daysToExpiry, sameDay);
    const double x = jm::max(-kUMax, jm::min(kUMax, u));
    return clampFactor(jm::exp(beta.a + beta.b * x + beta.c * x * x));
}

namespace {
bool isInteger(double v) { return std::isfinite(v) && std::trunc(v) == v; }

void checkInput(const FlyPlanInput& input) {
    if (!(input.width > 0)) throw FlyPlanError(u"翼宽要是正数。"_s);
    if (!(input.center > input.width)) throw FlyPlanError(u"中心行权价要大于翼宽。"_s);
    if (!(input.spot > 0)) throw FlyPlanError(u"现价要是正数。"_s);
    if (!(input.targetSpot > 0)) throw FlyPlanError(u"目标点位要是正数。"_s);
    if (!(isInteger(input.quantity) && input.quantity >= 1)) throw FlyPlanError(u"张数要是不小于 1 的整数。"_s);
    if (!(input.expiryMs > input.nowMs)) throw FlyPlanError(u"%1 这个到期日已经到期了,换一个到期日。"_s.arg(input.expiry));
    if (input.targetMs < input.nowMs) throw FlyPlanError(u"目标时刻已经过去了。"_s);
    if (input.targetMs > input.expiryMs)
        throw FlyPlanError(u"目标时刻在到期(美东 %1)之后:那时这只蝶已经结算了。"_s.arg(util::stampAt(input.expiryMs, et())));
    if (input.cost && !(*input.cost > 0)) throw FlyPlanError(u"成本要是正数(买入的蝶是付权利金)。"_s);
    if (input.ivInput && !(*input.ivInput > 0 && *input.ivInput <= 5)) throw FlyPlanError(u"IV 要在 0 到 500% 之间。"_s);
    if (input.ivMode == u"shift" && !(input.ivShiftPct.value_or(0) > -100)) throw FlyPlanError(u"IV 的变化不能小于 −100%。"_s);
}

/// ivs:Record<string, number>,键是 markKey(重了就是同一格)
using IvMap = std::vector<std::pair<QString, double>>;
void setIv(IvMap& m, const QString& k, double v) {
    for (auto& [key, x] : m)
        if (key == k) {
            x = v;
            return;
        }
    m.push_back({k, v});
}
double getIv(const IvMap& m, const QString& k) {
    for (const auto& [key, x] : m)
        if (key == k) return x;
    return std::nan("");
}

std::pair<QString, IvMap> resolveIvs(const FlyPlanInput& input, const std::vector<SignedLeg>& legs, const std::vector<std::optional<double>>& mids,
                                     double years0) {
    IvMap ivs;
    if (input.ivInput) {
        for (const SignedLeg& leg : legs) setIv(ivs, keyOf(leg), *input.ivInput);
        return {u"input"_s, ivs};
    }
    bool allIbkr = true;
    for (const SignedLeg& leg : legs) {
        const LegMark* m = markOf(input, leg);
        if (!m || !positive(m->iv)) allIbkr = false;
    }
    if (allIbkr) {
        for (const SignedLeg& leg : legs) setIv(ivs, keyOf(leg), *markOf(input, leg)->iv);
        return {u"ibkr"_s, ivs};
    }
    if (std::all_of(mids.begin(), mids.end(), [](const auto& m) { return m.has_value(); })) {
        std::vector<std::optional<double>> solved;
        for (size_t i = 0; i < legs.size(); ++i) solved.push_back(flyexit::impliedSigmaLeg(input.spot, legs[i].strike, *mids[i], legs[i].right));
        if (std::all_of(solved.begin(), solved.end(), [](const auto& s) { return s.has_value(); })) {
            for (size_t i = 0; i < legs.size(); ++i) setIv(ivs, keyOf(legs[i]), *solved[i] / (input.spot * std::sqrt(years0)));
            return {u"quote"_s, ivs};
        }
    }
    throw FlyPlanError(u"拿不到这三条腿的 IV:券商没有推模型 IV,盘口也不全(休市、行权价太远、或行情被别处占用时会这样)。"_s
                       u"可以在「IV」里手动填一个再算。"_s);
}

struct Quotes {
    std::optional<double> bid, mid, ask;
};
Quotes comboQuotes(const FlyPlanInput& input, const std::vector<SignedLeg>& legs, const std::vector<std::optional<double>>& mids) {
    const auto quote = [&](size_t i, bool ask) -> std::optional<double> {
        const LegMark* mark = markOf(input, legs[i]);
        return ask ? (mark ? positive(mark->ask) : std::nullopt) : bidOf(mark);
    };
    const auto net = [&](bool wingAsk, bool bodyAsk) -> std::optional<double> {
        const auto a = quote(0, wingAsk), b = quote(1, bodyAsk), c = quote(2, wingAsk);
        if (!a || !b || !c) return std::nullopt;
        return *a - 2 * *b + *c;
    };
    std::optional<double> mid;
    if (mids[0] && mids[1] && mids[2]) mid = *mids[0] - 2 * *mids[1] + *mids[2];
    return {net(false, true), mid, net(true, false)};
}

double gridStep(double span) {
    for (double step : {0.5, 1.0, 2.0, 2.5, 5.0, 10.0, 20.0, 25.0, 50.0, 100.0})
        if (span / step <= 80) return step;
    return std::ceil(span / 80 / 100) * 100;
}

struct Point {
    double spot = 0, now = 0, target = 0, expiry = 0;
};

std::pair<std::optional<double>, std::optional<double>> breakevenOf(const std::vector<Point>& curve, double cost, const Point& best) {
    if (!(best.target > cost)) return {std::nullopt, std::nullopt};
    std::vector<double> crossings;
    for (size_t i = 1; i < curve.size(); ++i) {
        const Point &a = curve[i - 1], &b = curve[i];
        const double da = a.target - cost, db = b.target - cost;
        if (da == 0) crossings.push_back(a.spot);
        else if (da * db < 0) crossings.push_back(pyRound(a.spot + ((b.spot - a.spot) * da) / (da - db), 1));
    }
    std::optional<double> low, high;
    if (!crossings.empty() && crossings.front() < best.spot) low = crossings.front();
    if (!crossings.empty() && crossings.back() > best.spot) high = crossings.back();
    return {low, high};
}

QString signedText(double value) { return (value > 0 ? u"+"_s : value < 0 ? u"−"_s : QString()) + pyG(std::fabs(value)); }

struct IvInfo {
    QString source, mode;
    double now = 0, atTarget = 0, changePct = 0, seasonalPct = 0, movePct = 0;
    std::optional<std::pair<double, double>> range;
    OJson model;
};

std::optional<QString> ivWarning(const IvInfo& iv, double autoPct) {
    if (iv.mode != u"auto") {
        if (std::fabs(autoPct - iv.changePct) < 10) return std::nullopt;
        const QString mine = iv.mode == u"flat" ? u"你选的是 IV 不变"_s : u"IV 按你填的 "_s + signedText(iv.changePct) + u"% 算"_s;
        return mine + u";按历史数据,这样的走势之后 IV 通常是 "_s + signedText(autoPct) + u"%。"_s;
    }
    if (std::fabs(iv.changePct) < 0.05 || !iv.range) return std::nullopt;
    QStringList parts;
    if (std::fabs(iv.seasonalPct) >= 0.05) parts << u"时段 "_s + signedText(iv.seasonalPct) + u"%"_s;
    if (std::fabs(iv.movePct) >= 0.05) parts << u"走势 "_s + signedText(iv.movePct) + u"%"_s;
    const double lo = pyRound((iv.range->first / iv.now - 1) * 100, 0), hi = pyRound((iv.range->second / iv.now - 1) * 100, 0);
    return u"到时的 IV 按 "_s + signedText(iv.changePct) + u"% 算("_s + parts.join(u","_s) + u");历史上同样的走势之后,半数情况落在 "_s + signedText(lo) +
           u"% ~ "_s + signedText(hi) + u"% 之间。"_s;
}

// ---- 定价
struct Pricer {
    Quotes market;
    double modelNow = 0;
    bool anchored = false;
    std::function<double(double, double, double)> valueAt;
};

Pricer pricerOf(const FlyPlanInput& input, const std::vector<SignedLeg>& legs, const IvMap& ivs, const QString& source,
                const std::vector<std::optional<double>>& mids, QStringList& warnings) {
    const double spot = input.spot, nowMs = input.nowMs, expiryMs = input.expiryMs, width = input.width;
    const double years0 = (expiryMs - nowMs) / kYearMs;
    std::vector<PricedLeg> priced;
    for (const SignedLeg& leg : legs) priced.push_back({leg.strike, leg.right});
    const auto keyOfPriced = [](const PricedLeg& l) { return markKey(l.strike); };
    const auto modelAt = [=](double s, double atMs, double factor) {
        OJson scaled = js::object();
        for (const SignedLeg& leg : legs) scaled.set(keyOf(leg), js::N(getIv(ivs, keyOf(leg)) * factor));
        const OJson sig = ibkrLegSigmas(priced, spot, scaled, expiryMs, atMs, keyOfPriced);
        if (sig.type == OJson::Null) throw FlyPlanError(u"IV 换算不出来:IV 或时刻不是有效数字。"_s);
        double out = 0;
        for (const SignedLeg& leg : legs) out += leg.ratio * flyexit::legValue(leg.right, s, leg.strike, sig.get(keyOf(leg))->n);
        return out;
    };
    Pricer p;
    p.market = comboQuotes(input, legs, mids);
    p.modelNow = modelAt(spot, nowMs, 1);
    p.anchored = source == u"ibkr" && p.market.mid && *p.market.mid > 0;
    const double gap = p.anchored ? *p.market.mid - p.modelNow : 0;
    if (p.anchored && std::fabs(gap) > jm::max(0.3, 0.25 * *p.market.mid))
        warnings << u"IBKR 的 IV 算出来的模型价 "_s + pyG(pyRound(p.modelNow, 2)) + u" 和盘口中间价 "_s + pyG(pyRound(*p.market.mid, 2)) + u" 差得不小。"_s +
                        u"结果已经锚在盘口上,但差这么多时模型对「变多少」的估计也要打折扣。"_s;
    p.valueAt = [=](double s, double atMs, double factor) {
        const double left = jm::max(0, expiryMs - atMs) / kYearMs;
        return jm::min(width, jm::max(0, modelAt(s, atMs, factor) + gap * std::sqrt(left / years0)));
    };
    return p;
}

std::pair<double, QString> resolveCost(const FlyPlanInput& input, const Pricer& pricer, QStringList& warnings) {
    double cost;
    QString costSource;
    if (input.cost) {
        cost = *input.cost;
        costSource = u"input"_s;
    } else if (pricer.market.mid && *pricer.market.mid > 0) {
        cost = pyRound(*pricer.market.mid, 2);
        costSource = u"mid"_s;
        const QString ask = pricer.market.ask ? u",现在立刻买得到的价是 "_s + pyG(pyRound(*pricer.market.ask, 2)) : QString();
        warnings << u"成本按盘口中间价 "_s + pyG(cost) + u" 算"_s + ask + u"。实际成交价以你挂的价为准,填上它再算更准。"_s;
    } else {
        cost = pyRound(pricer.valueAt(input.spot, input.nowMs, 1), 2);
        costSource = u"model"_s;
        warnings << u"没有盘口,成本用的是模型价 "_s + pyG(cost) + u"——它不是市场价,请填上你打算付的权利金。"_s;
    }
    if (!(cost > 0)) throw FlyPlanError(u"这只蝶此刻的价值算出来是 0,没法当成本:请填上你打算付的权利金。"_s);
    if (cost >= input.width)
        throw FlyPlanError(u"成本 "_s + pyG(cost) + u" 不小于翼宽 "_s + pyG(input.width) + u":这只蝶到期最多值 "_s + pyG(input.width) + u",怎么走都不赚。"_s);
    return {cost, costSource};
}

// ---- IV 的走法
struct Move {
    std::optional<double> sigmas;
    QString direction;
    double oneSigma = 0, u = 0, share = 0;
};
struct IvPath {
    double refIv = 0, daySigma = 0;
    std::function<Move(double, double)> moveTo;
    std::function<std::array<double, 3>(double, double)> autoFactors, factorsFor;
};

IvPath ivPathOf(const FlyPlanInput& input, const std::vector<SignedLeg>& legs, const IvMap& ivs, const FlyIvModel& model) {
    const double spot = input.spot, nowMs = input.nowMs, expiryMs = input.expiryMs;
    const double years0 = (expiryMs - nowMs) / kYearMs;
    SignedLeg refLeg = legs[1];
    for (const SignedLeg& b : legs)
        if (std::fabs(b.strike - spot) < std::fabs(refLeg.strike - spot)) refLeg = b;
    IvPath path;
    path.refIv = getIv(ivs, keyOf(refLeg));
    const double refIv = path.refIv;
    const bool session = sameSession(nowMs, expiryMs);
    const double share0 = session ? remainingShare(model.variance_weights, minuteOfDay(nowMs)) : 0;
    path.daySigma = session && share0 > 0 ? (spot * refIv * std::sqrt(years0)) / std::sqrt(share0)
                                          : spot * refIv * std::sqrt(model.realized_to_implied / 252);
    const double daySigma = path.daySigma;
    path.moveTo = [=, &model](double s, double atMs) {
        const double ahead = jm::max(0, atMs - nowMs);
        const double share = session ? jm::max(0, share0 - remainingShare(model.variance_weights, minuteOfDay(jm::min(atMs, expiryMs)))) : ahead / kDayMs;
        const double oneSigma = session ? daySigma * std::sqrt(share) : spot * refIv * std::sqrt(ahead / kYearMs);
        const QString direction = s > spot ? u"up"_s : s < spot ? u"down"_s : u"flat"_s;
        return Move{oneSigma > 0 ? std::optional(std::fabs(s - spot) / oneSigma) : std::nullopt, direction, oneSigma, (s - spot) / daySigma, share};
    };
    const auto moveTo = path.moveTo;
    path.autoFactors = [=, &model](double s, double atMs) -> std::array<double, 3> {
        if (!(atMs > nowMs)) return {1, 1, 1};
        const double seasonal = seasonalFactor(model, nowMs, atMs, expiryMs);
        const double response = ivResponse(model, moveTo(s, atMs).u, years0 * 365, session);
        return {clampFactor(seasonal * response), seasonal, response};
    };
    const auto autoFactors = path.autoFactors;
    const QString mode = input.ivMode;
    const double shift = input.ivShiftPct.value_or(0);
    path.factorsFor = [=](double s, double atMs) -> std::array<double, 3> {
        if (mode == u"flat") return {1, 1, 1};
        if (mode == u"shift") return {1 + shift / 100, 1, 1};
        return autoFactors(s, atMs);
    };
    return path;
}

OJson priced(double raw, double cost, double multiplier, double quantity) {
    const double value = pyRound(raw, 2);
    return js::object({{u"value"_s, js::N(value)},
                       {u"pnl"_s, js::N(pyRound((value - cost) * multiplier * quantity, 2))},
                       {u"pnl_pct"_s, js::N(pyRound(((value - cost) / cost) * 100, 1))}});
}
OJson with(OJson base, std::initializer_list<std::pair<QString, OJson>> extra) {
    for (const auto& [k, v] : extra) base.set(k, v);
    return base;
}
}  // namespace

OJson planFly(const FlyPlanInput& input) {
    checkInput(input);
    const QString right = input.right;
    const double center = input.center, width = input.width, quantity = input.quantity, multiplier = input.multiplier, spot = input.spot;
    const double nowMs = input.nowMs, expiryMs = input.expiryMs, targetMs = input.targetMs, targetSpot = input.targetSpot;
    QStringList warnings = input.warnings.value_or(QStringList());

    const double lower = center - width, upper = center + width;
    const std::vector<SignedLeg> legs{{lower, right, 1}, {center, right, -2}, {upper, right, 1}};
    std::vector<std::optional<double>> mids;
    for (const SignedLeg& leg : legs) mids.push_back(midOf(markOf(input, leg)));
    const auto [source, ivs] = resolveIvs(input, legs, mids, (expiryMs - nowMs) / kYearMs);
    if (source == u"input") warnings << u"IV 是手动给的,三条腿共用一个数:没有偏斜,也没有锚到盘口上。"_s;

    const Pricer pricer = pricerOf(input, legs, ivs, source, mids, warnings);
    const auto [cost, costSource] = resolveCost(input, pricer, warnings);
    const auto P = [&](double raw) { return priced(raw, cost, multiplier, quantity); };

    // ---- 这一段走了多远,IV 跟着变多少 ----
    const FlyIvModel& model = input.model ? *input.model : flyIvModel();
    const IvPath path = ivPathOf(input, legs, ivs, model);
    const Move tm = path.moveTo(targetSpot, targetMs);
    const OJson move = js::object({
        {u"points"_s, js::N(pyRound(targetSpot - spot, 2))},
        {u"pct"_s, js::N(pyRound(((targetSpot - spot) / spot) * 100, 2))},
        {u"minutes"_s, js::N(util::jsRound((targetMs - nowMs) / 60'000))},
        {u"direction"_s, js::S(tm.direction)},
        {u"one_sigma"_s, js::N(pyRound(tm.oneSigma, 2))},
        {u"sigmas"_s, tm.sigmas ? js::N(pyRound(*tm.sigmas, 2)) : OJson::null()},
        {u"pace"_s, js::S(!tm.sigmas || *tm.sigmas <= 1 ? u"calm"_s : *tm.sigmas < 2 ? u"brisk"_s : u"sharp"_s)},
        {u"day_sigma"_s, js::N(pyRound(path.daySigma, 2))},
        {u"day_sigmas"_s, js::N(pyRound(tm.u, 2))},
    });
    const auto [factor, seasonal, response] = path.factorsFor(targetSpot, targetMs);
    const bool autoMode = input.ivMode == u"auto" && targetMs > nowMs;
    const std::optional<OwnFit> own = sameSession(nowMs, expiryMs) ? model.own : std::nullopt;
    const double spread = autoMode ? jm::exp(kQuartile * (own ? residualSd(own->resid_k, own->resid_move, tm.share, tm.u)
                                                              : residualSd(model.resid_k, model.resid_move, tm.share, tm.u)))
                                   : 1;
    const std::array<double, 2> band{clampFactor(factor / spread), clampFactor(factor * spread)};
    IvInfo iv;
    iv.source = source;
    iv.mode = input.ivMode;
    iv.now = pyRound(path.refIv, 4);
    iv.atTarget = pyRound(path.refIv * factor, 4);
    iv.changePct = pyRound((factor - 1) * 100, 1);
    iv.seasonalPct = pyRound((seasonal - 1) * 100, 1);
    iv.movePct = pyRound((response - 1) * 100, 1);
    if (autoMode) iv.range = std::pair{pyRound(path.refIv * band[0], 4), pyRound(path.refIv * band[1], 4)};
    iv.model = OJson::null();
    if (input.ivMode == u"auto") {
        if (own)
            iv.model = js::object({{u"version"_s, js::S(model.version)},
                                   {u"period"_s, js::S(own->periodFrom + u" → "_s + own->periodTo)},
                                   {u"days"_s, js::N(own->days)},
                                   {u"proxy"_s, js::S(u"自己攒的当日到期期权 IV"_s)},
                                   {u"r2_out"_s, js::N(own->r2_out)},
                                   {u"own"_s, js::B(true)}});
        else
            iv.model = js::object({{u"version"_s, js::S(model.version)},
                                   {u"period"_s, js::S(model.periodFrom + u" → "_s + model.periodTo)},
                                   {u"days"_s, js::N(model.days)},
                                   {u"proxy"_s, js::S(model.proxy)},
                                   {u"r2_out"_s, js::N(model.r2_out)},
                                   {u"own"_s, js::B(false)}});
    }
    if (const auto about = ivWarning(iv, pyRound((path.autoFactors(targetSpot, targetMs)[0] - 1) * 100, 1))) warnings << *about;
    const bool overnight = util::dateStrAt(nowMs, et()) != util::dateStrAt(expiryMs, et());
    if (autoMode && !sameSession(nowMs, expiryMs))
        warnings << u"这只蝶不是当日到期(或那一天提前收盘):日内的时段分布不适用,IV 只按走势调;走势的反应按期限打了折。"_s;
    if (std::fabs(targetSpot - center) >= width) warnings << u"目标点位在两翼之外:到期时停在那儿这只蝶归零,此刻算出来的只是时间价值,越接近到期越少。"_s;
    std::vector<double> spreadValues;
    for (double f : {band[0], factor, band[1]}) spreadValues.push_back(pricer.valueAt(targetSpot, targetMs, f));

    // ---- 各档 IV、盈亏曲线、早到晚到 ----
    struct Row {
        double pct, factor;
        bool current;
    };
    std::vector<Row> rows;
    for (double s : scenarioSteps())
        if (std::fabs(s - iv.changePct) >= 0.5) rows.push_back({s, 1 + s / 100, false});
    rows.push_back({iv.changePct, factor, true});
    std::stable_sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) { return a.pct < b.pct; });
    OJson scenarios = js::array();
    for (const Row& row : rows)
        scenarios.items.append(with(P(pricer.valueAt(targetSpot, targetMs, row.factor)),
                                    {{u"iv_change_pct"_s, js::N(row.pct)}, {u"iv"_s, js::N(pyRound(path.refIv * row.factor, 4))}, {u"current"_s, js::B(row.current)}}));

    // 盈亏曲线
    std::vector<Point> curve;
    {
        const double lo = jm::min(jm::min(center - width, spot), targetSpot) - width / 2;
        const double hi = jm::max(jm::max(center + width, spot), targetSpot) + width / 2;
        const double step = gridStep(hi - lo);
        for (double i = std::floor(lo / step); i <= std::ceil(hi / step); i += 1) {
            const double at = pyRound(i * step, 2);
            curve.push_back({at, pyRound(pricer.valueAt(at, nowMs, 1), 2), pyRound(pricer.valueAt(at, targetMs, path.factorsFor(at, targetMs)[0]), 2),
                             pyRound(pricer.valueAt(at, expiryMs, 1), 2)});
        }
    }
    // 现价、中心或目标是 Infinity 时(checkInput 只查 > 0)曲线一个点都没有:TS 的 reduce 拿到 undefined,
    // 到 peak 那一格读 best.target 抛 TypeError;中间算的那些都没有别的副作用,这里直接抛同一句
    if (curve.empty()) throw util::JsError(u"Cannot read properties of undefined (reading 'target')"_s);
    Point best = curve.front();
    for (const Point& b : curve)
        if (b.target > best.target) best = b;
    std::vector<double> times;
    for (double t : input.timelineMs)
        if (t > nowMs && t <= expiryMs && std::find(times.begin(), times.end(), t) == times.end()) times.push_back(t);
    if (std::find(times.begin(), times.end(), targetMs) == times.end()) times.push_back(targetMs);
    std::stable_sort(times.begin(), times.end());
    OJson timeline = js::array();
    for (double t : times) {
        const double f = path.factorsFor(targetSpot, t)[0];
        const QString stamp = util::stampAt(t, et());
        timeline.items.append(with(P(pricer.valueAt(targetSpot, t, f)), {{u"at"_s, js::S(overnight ? stamp.mid(5) : stamp.mid(11))},
                                                                          {u"epoch_ms"_s, js::N(t)},
                                                                          {u"iv"_s, js::N(pyRound(path.refIv * f, 4))},
                                                                          {u"is_target"_s, js::B(t == targetMs)}}));
    }

    OJson outLegs = js::array();
    for (size_t i = 0; i < legs.size(); ++i) {
        const LegMark* mark = markOf(input, legs[i]);
        outLegs.items.append(js::object({{u"strike"_s, js::N(legs[i].strike)},
                                         {u"right"_s, js::S(right)},
                                         {u"action"_s, js::S(legs[i].ratio > 0 ? u"BUY"_s : u"SELL"_s)},
                                         {u"ratio"_s, js::N(std::fabs(legs[i].ratio))},
                                         {u"bid"_s, optN(bidOf(mark))},
                                         {u"ask"_s, optN(mark ? positive(mark->ask) : std::nullopt)},
                                         {u"mid"_s, mids[i] ? js::N(pyRound(*mids[i], 4)) : OJson::null()},
                                         {u"iv"_s, js::N(pyRound(getIv(ivs, keyOf(legs[i])), 4))}}));
    }
    const auto round2 = [](const std::optional<double>& v) { return v ? js::N(pyRound(*v, 2)) : OJson::null(); };
    const Quotes& market = pricer.market;
    OJson curveJson = js::array();
    for (const Point& p : curve)
        curveJson.items.append(js::object({{u"spot"_s, js::N(p.spot)}, {u"now"_s, js::N(p.now)}, {u"target"_s, js::N(p.target)}, {u"expiry"_s, js::N(p.expiry)}}));
    const auto [beLow, beHigh] = breakevenOf(curve, cost, best);
    double rangeLow = spreadValues[0], rangeHigh = spreadValues[0];
    for (double v : spreadValues) {
        rangeLow = jm::min(rangeLow, v);
        rangeHigh = jm::max(rangeHigh, v);
    }

    return js::object({
        {u"symbol"_s, js::S(input.symbol)},
        {u"expiry"_s, js::S(input.expiry)},
        {u"trading_class"_s, js::S(input.tradingClass)},
        {u"right"_s, js::S(right)},
        {u"lower"_s, js::N(lower)},
        {u"center"_s, js::N(center)},
        {u"upper"_s, js::N(upper)},
        {u"width"_s, js::N(width)},
        {u"quantity"_s, js::N(quantity)},
        {u"multiplier"_s, js::N(multiplier)},
        {u"legs"_s, outLegs},
        {u"spot"_s, js::N(spot)},
        {u"spot_source"_s, js::S(input.spotSource)},
        {u"spot_note"_s, js::S(input.spotNote)},
        {u"now_at"_s, js::S(util::stampAt(nowMs, et()))},
        {u"now_ms"_s, js::N(nowMs)},
        {u"expiry_at"_s, js::S(util::stampAt(expiryMs, et()))},
        {u"expiry_ms"_s, js::N(expiryMs)},
        {u"market"_s, js::object({{u"bid"_s, market.bid ? js::N(pyRound(jm::max(0, *market.bid), 2)) : OJson::null()},
                                  {u"mid"_s, round2(market.mid)},
                                  {u"ask"_s, round2(market.ask)}})},
        {u"model_now"_s, js::N(pyRound(pricer.modelNow, 2))},
        {u"anchored"_s, js::B(pricer.anchored)},
        {u"cost"_s, js::N(cost)},
        {u"cost_source"_s, js::S(costSource)},
        {u"move"_s, move},
        {u"iv"_s, js::object({{u"source"_s, js::S(iv.source)},
                              {u"mode"_s, js::S(iv.mode)},
                              {u"now"_s, js::N(iv.now)},
                              {u"at_target"_s, js::N(iv.atTarget)},
                              {u"change_pct"_s, js::N(iv.changePct)},
                              {u"seasonal_pct"_s, js::N(iv.seasonalPct)},
                              {u"move_pct"_s, js::N(iv.movePct)},
                              {u"range"_s, iv.range ? js::object({{u"low"_s, js::N(iv.range->first)}, {u"high"_s, js::N(iv.range->second)}}) : OJson::null()},
                              {u"model"_s, iv.model}})},
        {u"target"_s, with(P(pricer.valueAt(targetSpot, targetMs, factor)), {{u"spot"_s, js::N(targetSpot)},
                                                                            {u"at"_s, js::S(util::stampAt(targetMs, et()))},
                                                                            {u"epoch_ms"_s, js::N(targetMs)},
                                                                            {u"hours_left"_s, js::N(pyRound((expiryMs - targetMs) / 3'600'000, 2))}})},
        {u"target_range"_s, autoMode ? js::object({{u"low"_s, P(rangeLow)}, {u"high"_s, P(rangeHigh)}}) : OJson::null()},
        {u"target_flat"_s, P(pricer.valueAt(targetSpot, targetMs, 1))},
        {u"instant"_s, P(pricer.valueAt(targetSpot, nowMs, 1))},
        {u"at_expiry"_s, P(pricer.valueAt(targetSpot, expiryMs, 1))},
        {u"peak"_s, with(P(best.target), {{u"spot"_s, js::N(best.spot)}})},
        {u"breakeven"_s, js::object({{u"low"_s, optN(beLow)}, {u"high"_s, optN(beHigh)}})},
        {u"expiry_breakeven"_s, js::object({{u"low"_s, js::N(pyRound(lower + cost, 2))}, {u"high"_s, js::N(pyRound(upper - cost, 2))}})},
        {u"max_profit"_s, js::N(pyRound((width - cost) * multiplier * quantity, 2))},
        {u"max_loss"_s, js::N(pyRound(cost * multiplier * quantity, 2))},
        {u"scenarios"_s, scenarios},
        {u"curve"_s, curveJson},
        {u"timeline"_s, timeline},
        {u"warnings"_s, js::strings(warnings)},
    });
}

}  // namespace ibkr::analysis::flyplan
