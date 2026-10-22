#include "analysis/fly_exit_sweep.h"

#include "analysis/flyexit.h"
#include "analysis/playbook.h"
#include "analysis/tracker_rules.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/market_calendar.h"
#include "util/py.h"
#include "util/tz.h"

#include <QHash>
#include <QSet>

#include <algorithm>
#include <cmath>
#include <limits>
#include <memory>

namespace ibkr::analysis::sweep {

using namespace Qt::StringLiterals;
using util::OJson;
namespace js = util::js;

namespace {

QString et() { return QString::fromUtf16(util::kET); }
std::optional<double> clockOf(const QString& hhmm) {
    const OJson v = js::S(hhmm);
    return analysis::clockMinutes(&v);
}

// ---------------------------------------------------------------- 一天、一只蝶的价路径
struct Day {
    QString date;
    std::vector<QuoteSample> samples;
    std::vector<Book> books;
    double lastSpot = std::nan("");
    /// 最后一笔离收盘够近:拿到最后的可以按内在价值结算
    bool reachesClose = false;
    bool early = false;
};

struct FlyPath {
    FlySpec fly;
    std::any structure;
    std::vector<double> t, minute;
    QStringList stamp;
    std::vector<double> spot;
    std::vector<std::optional<double>> mid, open;
    /// tracker.naturalClosePrice:挂上去不用等的平仓价;拿不到或不是正数是空
    std::vector<std::optional<double>> close, closeRaw;
};

double sessionCloseMs(const QString& date, bool early) {
    const QStringList parts = date.split(u'-');
    const auto at = [&](qsizetype i) { return i < parts.size() ? parts[i].toDouble() : 0.0; };
    util::WallParts w;
    w.year = at(0);
    w.month = at(1);
    w.day = at(2);
    w.hour = early ? 13 : 16;
    return util::wallToEpoch(w, et());
}

Day dayOf(const QString& date, const std::vector<QuoteSample>& all, const SweepConfig& cfg) {
    Day day;
    day.date = date;
    for (const QuoteSample& s : all)
        if (cfg.population.by == u"all" || s.by.value_or(u"loop"_s) == cfg.population.by) day.samples.push_back(s);
    std::stable_sort(day.samples.begin(), day.samples.end(), [](const QuoteSample& a, const QuoteSample& b) { return a.t < b.t; });
    day.early = util::builtinCalendar().earlyCloses.contains(date);
    for (const QuoteSample& s : day.samples) day.books.push_back(bookOf(s));
    if (!day.samples.empty()) {
        day.lastSpot = day.samples.back().spot;
        day.reachesClose = sessionCloseMs(date, day.early) - day.samples.back().t <= cfg.fill.settle_within_min * 60'000;
    }
    return day;
}

/// 这一天的网格上摆得出的全部等翼同向蝶
std::vector<FlySpec> fliesOf(const Day& day, const Population& pop) {
    std::vector<double> strikes[2];  // C, P
    const auto side = [](const QString& right) { return right == u"C" ? 0 : right == u"P" ? 1 : -1; };
    for (const QuoteSample& s : day.samples)
        for (const QuoteLeg& leg : s.legs) {
            const int i = side(leg.right.left(1).toUpper());
            if (i >= 0) strikes[i].push_back(leg.strike);
        }
    std::vector<FlySpec> out;
    for (int i = 0; i < 2; ++i) {
        const QString right = i == 0 ? u"C"_s : u"P"_s;
        if (pop.rights && std::find(pop.rights->begin(), pop.rights->end(), right) == pop.rights->end()) continue;
        std::vector<double> sorted = strikes[i];
        std::sort(sorted.begin(), sorted.end());
        sorted.erase(std::unique(sorted.begin(), sorted.end()), sorted.end());  // Set
        for (const double center : sorted)
            for (const double lower : sorted) {
                const double wing = util::pyRound(center - lower, 4);
                if (!(wing > 0) || !std::binary_search(sorted.begin(), sorted.end(), center + wing)) continue;
                if (pop.wings && std::find(pop.wings->begin(), pop.wings->end(), wing) == pop.wings->end()) continue;
                out.push_back({center, wing, right});
            }
    }
    return out;
}

std::shared_ptr<FlyPath> pathOf(const Day& day, const FlySpec& fly, const TrackerRules& rules, const std::any& probe) {
    const std::vector<SignedLeg> legs = flyLegs(fly);
    OJson legsJson = js::array();
    for (const SignedLeg& leg : legs)
        legsJson.items.append(js::object({{u"strike"_s, js::N(leg.strike)}, {u"right"_s, js::S(leg.right)}, {u"ratio"_s, js::N(leg.ratio)}}));
    const auto structure = rules.structureOf(u"BAG"_s, js::object({{u"secType"_s, js::S(u"BAG"_s)}, {u"legs"_s, legsJson}}));
    if (!structure) return nullptr;
    auto path = std::make_shared<FlyPath>();
    path->fly = fly;
    path->structure = *structure;
    for (size_t i = 0; i < day.samples.size(); ++i) {
        const QuoteSample& sample = day.samples[i];
        const Book& book = day.books[i];
        const FlyQuote q = quoteFrom(book, fly);
        if (!q.listed) continue;
        const util::WallParts wall = util::wallParts(sample.t, et());
        OJson forTracker = js::object();
        for (const SignedLeg& leg : legs) {
            const auto it = book.constFind(legKey(leg.strike, leg.right));
            const QuoteLeg* raw = it == book.constEnd() ? nullptr : &*it;
            forTracker.set(rules.legPriceKey(leg.strike, leg.right),
                           js::object({{u"bid"_s, js::NOrNull(raw ? raw->bid : std::nullopt)}, {u"ask"_s, js::NOrNull(raw ? raw->ask : std::nullopt)}}));
        }
        path->t.push_back(sample.t);
        path->minute.push_back(wall.hour * 60 + wall.minute);
        path->stamp << util::stampAt(sample.t, et());
        path->spot.push_back(sample.spot);
        path->mid.push_back(q.mid);
        path->open.push_back(q.open);
        path->closeRaw.push_back(q.close_raw);
        path->close.push_back(rules.naturalClosePrice(probe, path->structure, forTracker));
    }
    return path->t.empty() ? nullptr : path;
}

// ---------------------------------------------------------------- 一个情景怎么收场
struct Scenario {
    std::shared_ptr<FlyPath> path;
    int k0 = 0;
    double debit = 0, qty = 0;
};
struct Cell {
    double n = 0, r = 0, usd = 0;
};
/// 一次出手:平掉几组、什么价、是不是真的成交(结算与归零不收佣金)、怎么出的
struct Leg {
    double qty = 0, price = 0;
    bool traded = false;
    QString kind;
};
using LegPair = std::pair<std::vector<Leg>, std::vector<Leg>>;

/// 触发之后在哪一笔成交:从触发那一笔起、第一笔拿得到立刻成交价的。没有 = 到收盘都没卖掉
int fillAt(const FlyPath& path, int from, double stride) {
    for (double k = from; k < double(path.t.size()); k += stride)
        if (path.close.at(size_t(k)).has_value()) return int(k);
    return -1;
}

/// 一直没出场(或触发了却一直卖不掉)的:两种了结口径各是多少。natural 取当天最后一笔拿得到盘口的,净价不是正数按 0
std::pair<Leg, Leg> terminalOf(const FlyPath& path, int k0, const Day& day) {
    double value = 0;
    for (int k = int(path.t.size()) - 1; k >= k0; k -= 1) {
        if (!path.closeRaw.at(size_t(k)).has_value()) continue;
        value = path.close.at(size_t(k)).value_or(0);
        break;
    }
    const Leg natural{1, value, value > 0, u"day_end"_s};
    const Leg settle = day.reachesClose ? Leg{1, flyIntrinsic(path.fly, day.lastSpot), false, u"settle"_s} : natural;
    return {natural, settle};
}

struct Pnl {
    double r, usd;
};
Pnl pnlOf(const std::vector<Leg>& legs, double debit, double qty, const FillModel& fill) {
    const double fee = fill.commission.value_or(0);
    double usd = -fee * contractsPerFly() * qty;
    for (const Leg& leg : legs) usd += leg.qty * ((leg.price - debit) * fill.multiplier - (leg.traded ? fee * contractsPerFly() : 0));
    usd /= qty;
    return {usd / (debit * fill.multiplier), usd};
}

std::optional<double> numberOrNull(const OJson* v) {
    if (js::isNum(v)) return v->n;
    return std::nullopt;
}

/// 实盘预设:每一笔样本过一遍 tracker.evaluate(峰值跟着走),再并上到点平仓。回 [配置口径, 另一种了结口径] 的出手。
LegPair runLive(const Scenario& sc, const Day& day, const LiveParams& p, const FillModel& fill, const TrackerRules& rules, double stride,
                const std::function<void()>& refused = {}) {
    const FlyPath& path = *sc.path;
    const size_t k0 = size_t(sc.k0);
    const double cost = unitCost(sc.debit, fill.multiplier, fill.commission);  // 追踪的成本:给了佣金就含佣金
    const std::any position = rules.makePosition(js::object({{u"account"_s, js::S(u"sweep"_s)},
                                                             {u"symbol"_s, js::S(u"SPX"_s)},
                                                             {u"sec_type"_s, js::S(u"BAG"_s)},
                                                             {u"quantity"_s, js::N(sc.qty)},
                                                             {u"avg_cost"_s, js::N(cost)},
                                                             {u"multiplier"_s, js::N(fill.multiplier)}}));
    OJson targets = rules.makeTargets(liveTargets(p, cost, sc.debit, path.t[k0]));
    const OJson* stopLoss = targets.get(u"stop_loss"_s);
    if (!(stopLoss && stopLoss->type == OJson::Null)) {
        // 按立刻成交价判止损的,建追踪时还多一道:止损价不低于此刻立刻能成交的价也拒
        const std::optional<double> natural = fill.stop_basis == u"natural" ? path.close[k0] : std::nullopt;
        bool ok = !natural || js::num(stopLoss) < *natural;
        try {
            rules.validate(position, targets, path.mid[k0]);
        } catch (const util::JsError&) {
            ok = false;
        }
        if (!ok) {
            targets.set(u"stop_loss"_s, OJson::null());
            if (refused) refused();
        }
    }
    std::optional<double> peak;
    for (double kd = double(k0); kd < double(path.t.size()); kd += stride) {
        const size_t k = size_t(kd);
        TrackerRules::EvalOpts opts;
        if (fill.stop_basis == u"natural") {
            opts.hasStopPrice = true;
            opts.stopPrice = path.close.at(k);
        }
        const OJson res = analysis::withTimeExit(rules.evaluate(position, targets, path.mid.at(k), peak, path.minute.at(k), opts), targets, path.t.at(k),
                                                 rules.stateHolding());
        peak = numberOrNull(js::prop(&res, u"peak"_s));
        const QString state = js::str(js::prop(&res, u"state"_s));
        if (state == rules.stateHolding()) continue;
        const int at = fillAt(path, int(k), stride);
        if (at >= 0) {
            const Leg leg{sc.qty, path.close[size_t(at)].value_or(0), true, state};
            return {{leg}, {leg}};
        }
        const auto end = terminalOf(path, sc.k0, day);
        Leg a = end.first, b = end.second;
        a.qty = b.qty = sc.qty;
        a.kind = b.kind = u"unfilled"_s;
        return {{a}, {b}};
    }
    const auto end = terminalOf(path, sc.k0, day);
    Leg a = end.first, b = end.second;
    a.qty = b.qty = sc.qty;
    return {{a}, {b}};
}

/// 回放策略:把记下来的现价与蝶的中间价当成 K 线喂给 flyexit.simulate,再把它的每一次出手换成立刻成交价。
std::optional<LegPair> runReplay(const Scenario& sc, const Day& day, const ReplayOverride& override_, double em, const FillModel& fill, double stride,
                                 const std::function<void()>& refused = {}) {
    const FlyPath& path = *sc.path;
    const size_t k0 = size_t(sc.k0);
    OJson spx = js::array(), flyBars = js::array();
    QHash<QString, int> index;
    for (double kd = double(k0); kd < double(path.t.size()); kd += stride) {
        const size_t k = size_t(kd);
        const std::optional<double> mid = path.mid.at(k);
        const QString time = path.stamp.at(qsizetype(k));
        if (!mid || index.contains(time)) continue;  // 缺报价的那一笔不给它:给了它会拿模型价补
        index.insert(time, int(k));
        spx.items.append(js::object({{u"time"_s, js::S(time)}, {u"close"_s, js::N(path.spot.at(k))}}));
        flyBars.items.append(js::object({{u"time"_s, js::S(time)}, {u"close"_s, js::N(mid.value())}}));
    }
    const OJson profile = js::object({{u"lower"_s, js::N(path.fly.center - path.fly.wing)},
                                      {u"center"_s, js::N(path.fly.center)},
                                      {u"upper"_s, js::N(path.fly.center + path.fly.wing)},
                                      {u"width"_s, js::N(path.fly.wing)},
                                      {u"right"_s, js::S(path.fly.right)},
                                      {u"action"_s, js::S(u"BUY"_s)},
                                      {u"debit"_s, js::N(sc.debit)},
                                      {u"qty"_s, js::N(sc.qty)},
                                      {u"multiplier"_s, js::N(fill.multiplier)}});
    OJson raw = override_;
    raw.set(u"em"_s, js::N(em));
    OJson params = flyexit::paramsFrom(&raw);
    if (path.mid[k0].value_or(std::numeric_limits<double>::infinity()) <= js::num(params.get(u"stop"_s)) * sc.debit) {
        params.set(u"stop"_s, js::N(-1));  // 蝶价不会是负数:这条线永远碰不到
        if (refused) refused();
    }
    const OJson sim = flyexit::simulate(profile, path.stamp.value(qsizetype(k0)), spx, flyBars, params);
    if (!js::truthy(js::prop(&sim, u"applicable"_s))) return std::nullopt;
    const OJson* modelMinutes = js::path(&sim, {u"totals"_s, u"model_minutes"_s});
    if (!(js::isNum(modelMinutes) && modelMinutes->n == 0)) throw SweepError(u"回放用到了模型价:喂进去的每一笔都该带着记下来的蝶价"_s);
    const auto end = terminalOf(path, sc.k0, day);
    std::vector<Leg> main, alt;
    const OJson* events = js::prop(&sim, u"events"_s);
    for (const OJson& e : events ? events->items : QList<OJson>{}) {
        const double n = js::num(js::prop(&e, u"qty"_s));
        std::optional<int> k;
        if (js::str(js::prop(&e, u"source"_s)) == u"real") {
            const auto it = index.constFind(js::str(js::prop(&e, u"time"_s)));
            if (it != index.constEnd()) k = *it;
        }
        const int at = k ? fillAt(path, *k, stride) : -1;
        if (at >= 0) {
            // 规则那句话里 ":" 之前的是它的名字
            const Leg leg{n, path.close[size_t(at)].value_or(0), true, js::str(js::prop(&e, u"rule"_s)).split(u':').value(0)};
            main.push_back(leg);
            alt.push_back(leg);
        } else {
            Leg a = end.first, b = end.second;
            a.qty = b.qty = n;
            if (k) a.kind = b.kind = u"unfilled"_s;
            main.push_back(a);
            alt.push_back(b);
        }
    }
    return LegPair{main, alt};
}

// ---------------------------------------------------------------- 情景
struct EmAt {
    double em, t;
};
/// 这一天最早一笔取得到平值跨式的样本 → 常规时段全天的 1σ,以及它是哪一刻取到的
std::optional<EmAt> emOf(const Day& day) {
    if (day.early) return std::nullopt;  // flyexit 的日内分布是照 16:00 收盘估的
    for (size_t i = 0; i < day.samples.size(); ++i) {
        const QuoteSample& s = day.samples.at(i);
        const double strike = playbook::atmStrike(s.spot);
        const Book& book = day.books.at(i);
        const auto call = book.constFind(legKey(strike, u"C"_s)), put = book.constFind(legKey(strike, u"P"_s));
        const std::optional<double> c = call == book.constEnd() ? std::nullopt : playbook::legMid(call->bid, call->ask);
        const std::optional<double> p = put == book.constEnd() ? std::nullopt : playbook::legMid(put->bid, put->ask);
        if (!c || !p) continue;
        playbook::BandSpec spec;
        spec.at = s.t;
        spec.anchor = s.spot;
        spec.strike = strike;
        spec.expiry = QString(day.date).replace(u'-', QString());
        spec.call = c.value();
        spec.put = p.value();
        spec.source = u"live"_s;
        const auto band = playbook::makeBand(spec);
        const std::optional<double> em = band ? playbook::sessionSigmaOf(*band) : std::nullopt;
        if (em) return EmAt{*em, s.t};
    }
    return std::nullopt;
}

struct Tally {
    OJson skipped = js::object(), filtered = js::object(), wings = js::object();
    double missing = 0, total = 0;
    std::vector<double> debits;
};
void bump(OJson& bag, const QString& key) {
    const OJson* cur = bag.get(key);
    bag.set(key, js::N((cur ? cur->n : 0) + 1));
}

std::vector<Scenario> gridScenarios(const Day& day, const SweepConfig& cfg, const TrackerRules& rules, const std::any& probe, Tally& tally) {
    const Population& pop = cfg.population;
    const double tick = rules.closeTick(probe);
    std::optional<double> from, to;
    if (pop.entry_from) from = clockOf(*pop.entry_from);
    if (pop.entry_to) to = clockOf(*pop.entry_to);
    std::vector<Scenario> out;
    for (const FlySpec& fly : fliesOf(day, pop)) {
        const std::shared_ptr<FlyPath> path = pathOf(day, fly, rules, probe);
        if (!path) continue;
        tally.total += double(path->t.size());
        for (const auto& m : path->mid)
            if (!m) tally.missing += 1;
        bool used = false;
        for (size_t k = 0; k < path->t.size(); ++k) {
            const double minute = path->minute[k];
            if ((from && minute < *from) || (to && minute > *to)) {
                bump(tally.filtered, u"入场时刻不在窗口里"_s);
                continue;
            }
            if (k == path->t.size() - 1) {
                bump(tally.skipped, u"入场之后当天没有样本了"_s);
                continue;
            }
            const std::optional<double> mid = path->mid[k], open = path->open[k];
            if (!mid || !open) {
                bump(tally.skipped, u"入场那一笔缺报价"_s);
                continue;
            }
            const double debit = entryDebit(*mid, *open, cfg.fill.entry_spread_share, tick);
            if (!(debit > 0)) {
                bump(tally.skipped, u"入场价不是正数"_s);
                continue;
            }
            if ((pop.debit_min && debit < *pop.debit_min) || (pop.debit_max && debit > *pop.debit_max)) {
                bump(tally.filtered, u"入场价不在范围里"_s);
                continue;
            }
            const double dist = fly.right == u"C" ? fly.center - path->spot[k] : path->spot[k] - fly.center;
            if ((pop.dist_min && dist < *pop.dist_min) || (pop.dist_max && dist > *pop.dist_max)) {
                bump(tally.filtered, u"中心离现价不在范围里"_s);
                continue;
            }
            out.push_back({path, int(k), debit, cfg.fill.qty});
            tally.debits.push_back(debit);
            used = true;
        }
        if (used) bump(tally.wings, util::pyG(fly.wing));
    }
    return out;
}

std::vector<Scenario> entryScenarios(const Day& day, const std::vector<RealEntry>& entries, const SweepConfig& cfg, const TrackerRules& rules,
                                     const std::any& probe, Tally& tally) {
    std::vector<Scenario> out;
    for (const RealEntry& e : entries) {
        const FlySpec fly{e.center, e.wing, e.right};
        const std::shared_ptr<FlyPath> path = pathOf(day, fly, rules, probe);
        if (!path) {
            bump(tally.skipped, u"记下来的行权价里摆不出这只蝶"_s);
            continue;
        }
        int k = -1;
        for (size_t i = 0; i < path->t.size(); ++i)
            if (path->t.at(i) >= e.t) {
                k = int(i);
                break;
            }
        if (k < 0 || size_t(k) == path->t.size() - 1) {
            bump(tally.skipped, u"入场之后当天没有样本了"_s);
            continue;
        }
        const std::optional<double> mid = path->mid[size_t(k)], open = path->open[size_t(k)];
        if (!mid || !open) {
            bump(tally.skipped, u"入场那一笔缺报价"_s);
            continue;
        }
        const double debit = e.debit ? *e.debit : entryDebit(*mid, *open, cfg.fill.entry_spread_share, rules.closeTick(probe));
        if (!(debit > 0)) {
            bump(tally.skipped, u"入场价不是正数"_s);
            continue;
        }
        tally.total += double(path->t.size()) - k;
        for (size_t i = size_t(k); i < path->mid.size(); ++i)
            if (!path->mid.at(i)) tally.missing += 1;
        out.push_back({path, k, debit, e.quantity.value_or(cfg.fill.qty)});
        tally.debits.push_back(debit);
        bump(tally.wings, util::pyG(fly.wing));
    }
    return out;
}

// ---------------------------------------------------------------- 扫描
void checkConfig(const SweepConfig& cfg) {
    const FillModel& f = cfg.fill;
    const Population& pop = cfg.population;
    if (!(f.entry_spread_share >= 0 && f.entry_spread_share <= 1)) throw SweepError(u"入场让出价差的份额要在 0 到 1 之间"_s);
    if (f.commission && !(*f.commission >= 0)) throw SweepError(u"佣金不能为负"_s);
    if (!(f.qty >= 1) || !(std::isfinite(f.qty) && std::floor(f.qty) == f.qty)) throw SweepError(u"每个情景的组数要是正整数"_s);
    if (!(f.multiplier > 0) || !(f.settle_within_min >= 0)) throw SweepError(u"乘数要是正数,离收盘的分钟数不能为负"_s);
    if (!(std::isfinite(cfg.stride) && std::floor(cfg.stride) == cfg.stride) || cfg.stride < 1)
        throw SweepError(u"判断间隔(隔几笔样本判一次)要是正整数"_s);
    for (const auto& clock : {pop.entry_from, pop.entry_to})
        if (clock && !clockOf(*clock)) throw SweepError(u"入场时刻要写成 \"HH:MM\",收到 %1"_s.arg(*clock));
    if (cfg.live.empty()) throw SweepError(u"至少要有参照组"_s);
}

std::optional<Spread> spread(std::vector<double> xs) {
    if (xs.empty()) return std::nullopt;
    std::sort(xs.begin(), xs.end());
    const size_t mid = xs.size() / 2;
    return Spread{xs.front(), xs.size() % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2, xs.back()};
}

class Family {
public:
    explicit Family(size_t sets) : sets_(sets) {
        for (Matrix& m : mats_) {
            m.r.assign(sets, {});
            m.usd.assign(sets, {});
        }
        kinds.assign(sets, js::object());
        stopRefused.assign(sets, 0);
    }
    QStringList days;
    std::vector<double> scenarios;
    std::vector<OJson> kinds;
    std::vector<double> stopRefused;

    void open() { cells_.assign(3, std::vector<Cell>(sets_)); }

    /// which:0 = 配置口径,1 = 另一种了结口径,2 = 放粗一倍
    void add(int which, size_t set, const std::vector<Leg>& legs, double debit, double qty, const FillModel& fill) {
        if (size_t(which) >= cells_.size() || set >= cells_[size_t(which)].size()) return;
        Cell& cell = cells_[size_t(which)][set];
        const Pnl pnl = pnlOf(legs, debit, qty, fill);
        cell.n += 1;
        cell.r += pnl.r;
        cell.usd += pnl.usd;
        if (which == 0 && !legs.empty() && set < kinds.size()) bump(kinds[set], legs.back().kind);
    }

    void close(const QString& date) {
        const double n = cells_.empty() ? 0 : cells_[0].empty() ? 0 : cells_[0][0].n;
        if (!n) return;
        days << date;
        scenarios.push_back(n);
        for (size_t which = 0; which < std::size(mats_); ++which)
            for (size_t set = 0; set < sets_; ++set) {
                const Cell cell = cells_.empty() ? Cell{} : cells_[which][set];
                mats_[which].r[set].push_back(cell.n ? cell.r / cell.n : std::nan(""));
                mats_[which].usd[set].push_back(cell.n ? cell.usd / cell.n : std::nan(""));
            }
    }

    FamilyResult result(const QString& family, const QStringList& labels, const std::vector<OJson>& params) const {
        FamilyResult r;
        r.family = family;
        r.labels = labels;
        r.params = params;
        r.days = days;
        r.scenarios = scenarios;
        r.main = mats_[0];
        r.alt_terminal = mats_[1];
        r.coarse = mats_[2];
        r.kinds = kinds;
        r.stop_refused = stopRefused;
        return r;
    }

private:
    size_t sets_;
    Matrix mats_[3];
    std::vector<std::vector<Cell>> cells_;
};

struct ByDate {
    QHash<QString, std::vector<QuoteSample>> days;
    double notSameDay = 0, otherSymbol = 0;
};

/// 把样本按美东日期分开。带着到期日、却不是当日到期的那几笔不用;别的标的的也不用(都数出来)。
ByDate byDate(const std::vector<QuoteSample>& samples, const std::optional<QString>& symbol) {
    ByDate out;
    QSet<QString> seen;
    for (const QuoteSample& s : samples)
        if (s.symbol) seen.insert(*s.symbol);
    if (!symbol && seen.size() > 1) {
        QStringList names(seen.begin(), seen.end());
        std::sort(names.begin(), names.end());
        throw SweepError(u"样本里有 %1 几个标的:一次只扫一个,用 symbol 选一个"_s.arg(names.join(u"、"_s)));
    }
    for (const QuoteSample& s : samples) {
        if (symbol && s.symbol && *s.symbol != *symbol) {
            out.otherSymbol += 1;
            continue;
        }
        const QString date = util::dateStrAt(s.t, et());
        if (s.expiry && *s.expiry != QString(date).replace(u'-', QString())) {
            out.notSameDay += 1;
            continue;
        }
        out.days[date].push_back(s);
    }
    return out;
}

}  // namespace

SweepResult runSweep(const std::vector<QuoteSample>& samples, const SweepConfig& cfg, const TrackerRules& rules,
                     const std::function<void(const QString&, double, double)>& onDay) {
    checkConfig(cfg);
    const ByDate grouped = byDate(samples, cfg.symbol);
    QStringList dates = grouped.days.keys();
    std::sort(dates.begin(), dates.end());
    const std::any probe = rules.makePosition(js::object({{u"account"_s, js::S(u"sweep"_s)},
                                                          {u"symbol"_s, js::S(u"SPX"_s)},
                                                          {u"sec_type"_s, js::S(u"BAG"_s)},
                                                          {u"quantity"_s, js::N(1)},
                                                          {u"avg_cost"_s, js::N(0)},
                                                          {u"multiplier"_s, js::N(cfg.fill.multiplier)}}));
    Tally tally;
    Family live(cfg.live.size());
    std::optional<Family> replay;
    if (cfg.replay) replay.emplace(cfg.replay->sets.size());
    std::vector<double> ems;
    double used = 0, total = 0, shortDays = 0, withoutEm = 0;
    const auto altOf = [&](const LegPair& pair) { return cfg.fill.terminal == u"natural" ? pair : LegPair{pair.second, pair.first}; };

    if (cfg.entries)
        for (const RealEntry& e : *cfg.entries)
            if (!grouped.days.contains(util::dateStrAt(e.t, et()))) bump(tally.skipped, u"那一天没有记下样本"_s);
    for (const QString& date : dates) {
        const Day day = dayOf(date, grouped.days.value(date), cfg);
        std::optional<std::vector<RealEntry>> mine;
        if (cfg.entries) {
            mine.emplace();
            for (const RealEntry& e : *cfg.entries)
                if (util::dateStrAt(e.t, et()) == date) mine->push_back(e);
        }
        if (day.samples.empty()) {
            for (size_t i = 0; i < (mine ? mine->size() : 0); ++i) bump(tally.skipped, u"那一天没有记下样本"_s);
            continue;
        }
        used += double(day.samples.size());
        if (mine && mine->empty()) continue;
        const std::vector<Scenario> scenarios =
            mine ? entryScenarios(day, *mine, cfg, rules, probe, tally) : gridScenarios(day, cfg, rules, probe, tally);
        if (scenarios.empty()) continue;
        total += double(scenarios.size());
        if (!day.reachesClose) shortDays += 1;
        std::optional<EmAt> em;
        if (cfg.replay) {
            if (cfg.replay->emAuto) em = emOf(day);
            else if (!day.early) em = EmAt{cfg.replay->em, -std::numeric_limits<double>::infinity()};
        }
        if (cfg.replay && !em) withoutEm += 1;
        if (em) ems.push_back(em->em);

        live.open();
        if (replay) replay->open();
        for (const Scenario& sc : scenarios) {
            for (size_t i = 0; i < cfg.live.size(); ++i) {
                const LiveParams& p = cfg.live[i];
                const LegPair pair = altOf(runLive(sc, day, p, cfg.fill, rules, cfg.stride, [&] { live.stopRefused[i] += 1; }));
                live.add(0, i, pair.first, sc.debit, sc.qty, cfg.fill);
                live.add(1, i, pair.second, sc.debit, sc.qty, cfg.fill);
                live.add(2, i, altOf(runLive(sc, day, p, cfg.fill, rules, cfg.stride * 2)).first, sc.debit, sc.qty, cfg.fill);
            }
            if (!cfg.replay || !replay || !em) continue;
            // EM 是当天晚些时候才取到的:拿它去回放更早的入场,等于用了入场时还不知道的东西
            if (sc.path->t[size_t(sc.k0)] < em.value().t) {
                bump(tally.skipped, u"回放:入场早于当天取到 EM 的那一笔"_s);
                continue;
            }
            // 回放不适用的情景对每一组都不适用:要么全算、要么全不算
            std::vector<std::pair<std::optional<LegPair>, std::optional<LegPair>>> runs;
            for (size_t i = 0; i < cfg.replay->sets.size(); ++i) {
                const ReplayOverride& o = cfg.replay->sets[i];
                auto fine = runReplay(sc, day, o, em.value().em, cfg.fill, cfg.stride, [&] { replay->stopRefused[i] += 1; });
                auto coarse = runReplay(sc, day, o, em.value().em, cfg.fill, cfg.stride * 2);
                runs.emplace_back(std::move(fine), std::move(coarse));
            }
            bool applicable = true;
            for (const auto& [fine, coarse] : runs)
                if (!fine || !coarse) applicable = false;
            if (!applicable) {
                bump(tally.skipped, u"回放策略不适用"_s);
                continue;
            }
            for (size_t i = 0; i < runs.size(); ++i) {
                const LegPair pair = altOf(*runs[i].first);
                replay->add(0, i, pair.first, sc.debit, sc.qty, cfg.fill);
                replay->add(1, i, pair.second, sc.debit, sc.qty, cfg.fill);
                replay->add(2, i, altOf(*runs[i].second).first, sc.debit, sc.qty, cfg.fill);
            }
        }
        live.close(date);
        if (replay) replay->close(date);
        if (onDay) onDay(date, double(dates.indexOf(date) + 1), double(dates.size()));
    }

    const LiveParams reference = cfg.live.empty() ? liveReference() : cfg.live[0];
    // 合约条款给的上限:一边卖在翼宽、另一边归零。入场价的下限是人群限定里给的,没给(或是真实入场)就是组合的一跳
    double wing = 0;
    for (const auto& f : tally.wings.fields) wing = util::jsmath::max(wing, util::jsStringToNumber(f.first));
    const double tick = rules.closeTick(probe);
    const double debitFloor = !cfg.entries ? util::jsmath::max(cfg.population.debit_min.value_or(0), tick) : tick;
    const double capUsd = wing * cfg.fill.multiplier + contractsPerFly() * cfg.fill.commission.value_or(0);

    SweepResult res;
    res.data.days = double(dates.size());
    if (!dates.isEmpty()) {
        res.data.first = dates.front();
        res.data.last = dates.back();
    }
    res.data.samples = double(samples.size());
    res.data.used = used;
    res.data.not_same_day = grouped.notSameDay;
    res.data.other_symbol = grouped.otherSymbol;
    res.symbol = cfg.symbol;
    res.population = cfg.population;
    res.fill = cfg.fill;
    res.stride = cfg.stride;
    res.from_entries = cfg.entries.has_value();
    res.scenarios = total;
    res.skipped = tally.skipped;
    res.filtered = tally.filtered;
    res.no_decision_missing = tally.missing;
    res.no_decision_total = tally.total;
    res.debit = spread(tally.debits);
    res.wings = tally.wings;
    res.short_days = shortDays;
    if (wing > 0) res.loss_cap = LossCap{capUsd, capUsd / (debitFloor * cfg.fill.multiplier), wing, debitFloor};
    QStringList labels;
    std::vector<OJson> params;
    for (const LiveParams& p : cfg.live) {
        labels << liveLabel(p, reference);
        params.push_back(liveRow(p));
    }
    res.live = live.result(u"live"_s, labels, params);
    if (cfg.replay && replay) {
        QStringList rlabels;
        std::vector<OJson> rparams;
        for (const ReplayOverride& o : cfg.replay->sets) {
            rlabels << replayLabel(o);
            rparams.push_back(o);
        }
        res.replay = ReplayResult{replay->result(u"replay"_s, rlabels, rparams), spread(ems), withoutEm};
    }
    return res;
}

}  // namespace ibkr::analysis::sweep
