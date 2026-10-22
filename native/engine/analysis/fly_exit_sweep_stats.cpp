#include "analysis/fly_exit_sweep_stats.h"

#include "util/jsmath.h"

#include <QHash>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>

namespace ibkr::analysis::sweep {

using namespace Qt::StringLiterals;
namespace jm = util::jsmath;

const QString kCheckCoarse = u"隔一笔才判断一次"_s;
const QString kCheckTerminal = u"换一种了结口径"_s;
const QString kCheckHalves = u"单数天与双数天分开看"_s;

namespace {

constexpr double kInf = std::numeric_limits<double>::infinity();
const double kNaN = std::nan("");

uint32_t toUint32(double x) {
    if (!std::isfinite(x)) return 0;
    double m = std::fmod(std::trunc(x), 4294967296.0);
    if (m < 0) m += 4294967296.0;
    return uint32_t(m);
}

/// reduce((a, b) => a + b, 0)/ length;空的是 NaN
double mean(const std::vector<double>& xs) {
    if (xs.empty()) return kNaN;
    double acc = 0;
    for (const double x : xs) acc = acc + x;
    return acc / double(xs.size());
}

/// 均值的标准误;不到两天、或每天都一样,是空
std::optional<double> stdError(const std::vector<double>& xs) {
    if (xs.size() < 2) return std::nullopt;
    const double m = mean(xs);
    double ss = 0;
    for (const double x : xs) ss = ss + (x - m) * (x - m);
    if (ss > 0) return std::sqrt(ss / double(xs.size() - 1) / double(xs.size()));
    return std::nullopt;
}

/// `x?.[0] ?? -Infinity` / `x?.[1] ?? Infinity`
double loOf(const std::optional<Interval>& i) { return i && i->lo ? *i->lo : -kInf; }
double hiOf(const std::optional<Interval>& i) { return i && i->hi ? *i->hi : kInf; }

std::optional<double> finite(double v) { return std::isfinite(v) ? std::optional<double>(v) : std::nullopt; }

struct Boot {
    std::vector<std::vector<double>> t;
    std::vector<double> max, min, abs;
};

/// 在天上重抽。rows 是各组的逐日差(已经减掉参照组),回每组排好序的 t*,以及每次重抽里各组 t* 的最大值、最小值、绝对值的最大值。
Boot bootstrap(const std::vector<std::vector<double>>& rows, const BootOptions& opts) {
    const size_t n = rows.empty() ? 0 : rows[0].size();
    std::vector<double> centre;
    for (const auto& r : rows) centre.push_back(mean(r));
    const size_t draws = size_t(opts.draws);
    Boot out;
    out.t.assign(rows.size(), std::vector<double>(draws, 0.0));
    out.max.assign(draws, 0.0);
    out.min.assign(draws, 0.0);
    out.abs.assign(draws, 0.0);
    const auto random = seededRandom(opts.seed);
    std::vector<int> pick(n, 0);
    std::vector<double> drawn(n, 0.0);
    for (size_t b = 0; b < draws; ++b) {
        for (size_t j = 0; j < n; ++j) pick[j] = int(std::floor(random() * double(n)));
        double top = -kInf, bottom = kInf;
        for (size_t p = 0; p < rows.size(); ++p) {
            const std::vector<double>& row = rows[p];
            double sum = 0, lo = kInf, hi = -kInf;
            for (size_t j = 0; j < n; ++j) {
                const double v = size_t(pick[j]) < row.size() ? row.at(size_t(pick[j])) : 0.0;
                drawn[j] = v;
                sum += v;
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
            const double m = sum / double(n), shift = m - centre[p];
            double value;
            if (lo == hi) {
                value = shift == 0 ? 0 : shift > 0 ? kInf : -kInf;
            } else {
                double ss = 0;
                for (size_t j = 0; j < n; ++j) {
                    const double dev = drawn[j] - m;
                    ss += dev * dev;
                }
                value = shift / std::sqrt(ss / double(n - 1) / double(n));
            }
            out.t[p][b] = value;
            // 抽到的全是同一个值的那一组,这一次只算在它自己头上:别让一组太稀的把大家的临界值都拉成无穷大
            if (std::isfinite(value) && value > top) top = value;
            if (std::isfinite(value) && value < bottom) bottom = value;
        }
        out.max[b] = std::isfinite(top) ? top : 0;
        out.min[b] = std::isfinite(bottom) ? bottom : 0;
        out.abs[b] = jm::max(out.max[b], -out.min[b]);
    }
    for (auto& list : out.t) sortLikeFloat64Array(list);
    sortLikeFloat64Array(out.max);
    sortLikeFloat64Array(out.min);
    sortLikeFloat64Array(out.abs);
    return out;
}

/// 排好序的 t* 两头对称地各切掉一样多:[下尾分位, 上尾分位]
std::pair<double, double> tails(const std::vector<double>& sorted, double level) {
    const double len = double(sorted.size());
    const double last = len - 1;
    const double hi = jm::min(last, jm::max(0, std::ceil((1 - (1 - level) / 2) * len) - 1));
    const auto at = [&](double i) { return i >= 0 && i < len && i == std::floor(i) ? sorted[size_t(i)] : kNaN; };
    return {at(last - hi), at(hi)};
}

Interval ownInterval(double diff, double se, const std::vector<double>& sortedT, double level) {
    const auto [lower, upper] = tails(sortedT, level);
    return {finite(diff - upper * se), finite(diff - lower * se)};
}

std::vector<SplitHalf> splitCheck(const std::vector<std::vector<double>>& diffs, size_t reference, const BootOptions& opts) {
    const size_t n = diffs.empty() ? 0 : diffs[0].size();
    std::vector<size_t> odd, even;
    for (size_t j = 0; j < n; ++j) (j % 2 == 0 ? odd : even).push_back(j);  // 第 1、3、5… 天是单数天
    struct Half {
        QString name;
        const std::vector<size_t>*train, *test;
    };
    const Half halves[2] = {{u"odd"_s, &odd, &even}, {u"even"_s, &even, &odd}};
    std::vector<SplitHalf> out;
    for (size_t h = 0; h < 2; ++h) {
        const auto& [name, train, test] = halves[h];
        std::optional<size_t> picked;
        double best = 0;
        for (size_t p = 0; p < diffs.size(); ++p) {
            if (p == reference || train->empty()) continue;
            std::vector<double> part;
            for (const size_t j : *train) part.push_back(j < diffs[p].size() ? diffs[p].at(j) : 0.0);
            const double score = mean(part);
            if (score > best) {
                best = score;
                picked = p;
            }
        }
        SplitHalf r;
        r.picked_on = name;
        r.held_out_days = double(test->size());
        if (!picked) {
            out.push_back(r);
            continue;
        }
        std::vector<double> held;
        for (const size_t j : *test) held.push_back(j < diffs[*picked].size() ? diffs[*picked].at(j) : 0.0);
        const std::optional<double> se = stdError(held);
        const std::optional<double> heldMean = held.empty() ? std::nullopt : std::optional<double>(mean(held));
        std::optional<Interval> ci;
        if (se && heldMean && degenerateProb(held) <= (1 - opts.level) / 2) {
            BootOptions o = opts;
            o.seed = opts.seed + 1 + double(h);
            const Boot boot = bootstrap({held}, o);
            ci = ownInterval(*heldMean, *se, boot.t.empty() ? std::vector<double>{} : boot.t[0], opts.level);
        }
        r.picked = picked;
        r.in_sample = best;
        r.held_out = heldMean;
        for (const double v : held) {
            if (v > 0) r.wins += 1;
            if (v < 0) r.losses += 1;
        }
        r.ci = ci;
        out.push_back(r);
    }
    return out;
}

// ---------------------------------------------------------------- 不靠分布假设的界
/// 不低于 floor 的那部分分布的均值的下界(Anderson 1969):rest 是从它里面独立抽的、从小到大排好的样本。
double seenLower(const std::vector<double>& rest, double floor, double alpha) {
    const double k = double(rest.size());
    if (!k) return floor;
    const double eps = std::sqrt(jm::log(1 / alpha) / (2 * k));
    if (eps >= 1) return floor;
    double mass = 1 - eps, acc = eps * floor;
    for (const double y : rest) {
        const double w = jm::min(1 / k, mass);
        if (w <= 0) break;
        acc += w * y;
        mass -= w;
    }
    return acc;
}

}  // namespace

/// Float64Array.prototype.sort():数值序,NaN 在最后,-0 在 +0 前面
void sortLikeFloat64Array(std::vector<double>& v) {
    std::sort(v.begin(), v.end(), [](double a, double b) {
        if (std::isnan(b)) return !std::isnan(a);
        if (std::isnan(a)) return false;
        if (a < b) return true;
        if (a > b) return false;
        return a == 0 && b == 0 && std::signbit(a) && !std::signbit(b);
    });
}

std::function<double()> seededRandom(double seed) {
    uint32_t state = toUint32(seed);
    return [state]() mutable {
        state = state + 0x6d2b79f5u;
        uint32_t t = state;
        t = (t ^ (t >> 15)) * (t | 1u);
        t ^= t + (t ^ (t >> 7)) * (t | 61u);
        return double(t ^ (t >> 14)) / 4294967296.0;
    };
}

double degenerateProb(const std::vector<double>& xs) {
    const double n = double(xs.size());
    if (xs.size() < 2) return 1;
    // Map:按 SameValueZero 数(-0 与 +0 同一个键,NaN 同一个键),按第一次出现的先后加
    QHash<quint64, size_t> index;
    std::vector<double> counts;
    for (const double x : xs) {
        quint64 bits = 0;  // -0 与 +0 同一个键
        static_assert(sizeof(bits) == sizeof(x));
        if (std::isnan(x)) bits = 0x7ff8000000000000ull;
        else if (x != 0) std::memcpy(&bits, &x, sizeof bits);
        const auto it = index.constFind(bits);
        if (it == index.constEnd()) {
            index.insert(bits, counts.size());
            counts.push_back(1);
        } else {
            counts[*it] += 1;
        }
    }
    double p = 0;
    for (const double c : counts) p += jm::pow(c / n, n);
    return p;
}

std::optional<ExactLower> exactLower(const std::vector<double>& d, double cap, double alphaTail, double alphaSeen) {
    const double n = double(d.size());
    if (n < 2 || !(cap >= 0) || !std::isfinite(cap)) return std::nullopt;
    std::vector<double> sorted = d;
    std::stable_sort(sorted.begin(), sorted.end(), [](double a, double b) { return a < b; });
    const double unseen = 1 - jm::pow(alphaTail, 1 / n);
    const double seen = seenLower(std::vector<double>(sorted.begin() + 1, sorted.end()), sorted[0], alphaSeen);
    return ExactLower{(1 - unseen) * seen - unseen * cap, unseen, seen};
}

Analysis analyse(const std::vector<std::vector<double>>& matrix, size_t reference, const BootOptions& opts) {
    if (!(opts.level > 0 && opts.level < 1)) throw util::JsError(u"置信水平要在 0 到 1 之间"_s);
    if (!(std::isfinite(opts.draws) && std::floor(opts.draws) == opts.draws) || opts.draws < 1) throw util::JsError(u"重抽次数要是正整数"_s);
    const std::vector<double> empty;
    const std::vector<double>& base = reference < matrix.size() ? matrix[reference] : empty;
    const double n = double(base.size());
    const std::optional<double> cap = opts.cap;
    const double tail = (1 - opts.level) / 2;
    std::vector<std::vector<double>> diffs;
    for (const auto& row : matrix) {
        std::vector<double> d;
        for (size_t j = 0; j < row.size(); ++j) d.push_back(row[j] - (j < base.size() ? base.at(j) : 0.0));
        diffs.push_back(d);
    }
    std::vector<size_t> others;
    for (size_t p = 0; p < diffs.size(); ++p)
        if (p != reference) others.push_back(p);
    // 每组每一头的 α = 一头的 α ÷ 组数,再对半分给"没见过的那种天"与"见过的这部分"
    const std::optional<double> alphaTail = others.empty() ? std::nullopt : std::optional<double>(tail / double(others.size()) / 2);
    const auto halfMean = [](const std::vector<double>& d, bool odd) -> std::optional<double> {
        std::vector<double> part;
        for (size_t j = 0; j < d.size(); ++j)
            if ((j % 2 == 0) == odd) part.push_back(d[j]);
        return part.empty() ? std::nullopt : std::optional<double>(mean(part));
    };
    std::vector<SetStat> sets;
    for (size_t p = 0; p < diffs.size(); ++p) {
        const std::vector<double>& d = diffs[p];
        SetStat stat;
        const std::optional<double> se = p == reference ? std::nullopt : stdError(d);
        const double degenerate = degenerateProb(d);
        stat.mean = mean(p < matrix.size() ? matrix[p] : empty);
        stat.diff = p == reference ? 0 : mean(d);
        stat.se = se;
        for (const double v : d) {
            if (v > 0) stat.wins += 1;
            if (v < 0) stat.losses += 1;
            if (v == 0) stat.ties += 1;
        }
        stat.halves = {halfMean(d, true), halfMean(d, false)};
        stat.degenerate = degenerate;
        stat.eligible = p != reference && se.has_value() && degenerate <= tail;
        sets.push_back(stat);
        if (p == reference || !cap || !alphaTail) continue;
        SetStat& s = sets.back();
        std::vector<double> neg;
        for (const double v : d) neg.push_back(-v);
        const auto low = exactLower(d, *cap, *alphaTail, *alphaTail), high = exactLower(neg, *cap, *alphaTail, *alphaTail);
        if (!low || !high) continue;
        s.exact = Interval{low->lower, -high->lower};
        s.unseen = low->unseen;
        s.seen = low->seen;
        if (low->seen > 0) {
            s.breakeven = (low->seen * (1 - low->unseen)) / low->unseen;
            // (1 − π(n′)) × seen > π(n′) × cap  ⇔  alphaTail^(1/n′) > cap ÷ (seen + cap)
            s.days_needed = *cap > 0 ? std::floor(jm::log(*alphaTail) / jm::log(*cap / (low->seen + *cap))) + 1 : 2;
        }
    }
    std::vector<size_t> eligible;
    for (size_t p = 0; p < sets.size(); ++p)
        if (sets[p].eligible) eligible.push_back(p);
    std::optional<Interval> critical;
    if (!eligible.empty()) {
        std::vector<std::vector<double>> rows;
        for (const size_t p : eligible) rows.push_back(diffs[p]);
        const Boot boot = bootstrap(rows, opts);
        // 两头分开取:下界看各组 t* 最大值的上尾,上界看最小值的下尾,各占 (1 − level) ÷ 2;取绝对值:|t*| 最大值的 level 分位。每一头用宽的
        const double alen = double(boot.abs.size());
        const double bi = jm::min(alen - 1, jm::max(0, std::ceil(opts.level * alen) - 1));
        const double both = bi >= 0 && bi < alen ? boot.abs[size_t(bi)] : kNaN;
        const double upper = jm::max(tails(boot.max, opts.level).second, both);
        const double lower = jm::min(tails(boot.min, opts.level).first, -both);
        critical = Interval{finite(lower), finite(upper)};
        for (size_t i = 0; i < eligible.size(); ++i) {
            SetStat& s = sets[eligible[i]];
            if (!s.se) continue;
            const auto own = tails(i < boot.t.size() ? boot.t.at(i) : std::vector<double>{}, opts.level);
            s.ci = Interval{finite(s.diff - own.second * *s.se), finite(s.diff - own.first * *s.se)};
            // 算上挑选的区间不比这一组自己单看的窄(它自己抽到全是同一个值的那几次只算在它头上)
            s.band = Interval{finite(s.diff - jm::max(upper, own.second) * *s.se), finite(s.diff - jm::min(lower, own.first) * *s.se)};
        }
    }
    const auto byDiff = [&](size_t a, size_t b) { return sets[b].diff - sets[a].diff; };
    const auto sortBy = [&](std::vector<size_t> v, bool reverse) {
        std::stable_sort(v.begin(), v.end(), [&](size_t a, size_t b) { return (reverse ? byDiff(b, a) : byDiff(a, b)) < 0; });
        return v;
    };
    Analysis out;
    if (!others.empty()) out.top = sortBy(others, false)[0];
    std::vector<size_t> aheadRaw, behindRaw;
    for (const size_t p : eligible) {
        const auto& band = sets[p].band;
        if (loOf(band) > 0) aheadRaw.push_back(p);
        if (hiOf(band) < 0) behindRaw.push_back(p);
    }
    out.ahead = sortBy(aheadRaw, false);
    out.behind = sortBy(behindRaw, true);
    for (const size_t p : out.ahead) {
        if (loOf(sets[p].exact) > 0) out.better.push_back(p);
    }
    for (const size_t p : out.behind) {
        if (hiOf(sets[p].exact) < 0) out.worse.push_back(p);
    }
    out.days = n;
    out.level = opts.level;
    out.draws = opts.draws;
    out.seed = opts.seed;
    out.cap = cap;
    out.sets = sets;
    out.reference = reference;
    out.eligible = double(eligible.size());
    out.critical = critical;
    out.alpha_tail = alphaTail;
    if (alphaTail) out.min_days = std::floor(jm::log2(1 / *alphaTail)) + 1;
    if (n >= 2) out.split = splitCheck(diffs, reference, opts);
    return out;
}

Verdict verdictOf(const Analysis& primary, const std::vector<VerdictCheck>& checks) {
    if (!primary.top || primary.days == 0) return {u"nothing_to_compare"_s, std::nullopt, {}};
    if (primary.better.empty()) {
        if (primary.ahead.empty()) return {u"not_separated"_s, primary.top, {}};
        return {u"unproven"_s, primary.ahead[0], {}};
    }
    const size_t winner = primary.better[0];
    QStringList failed;
    for (const VerdictCheck& c : checks) {
        const double v = winner < c.diffs.size() ? c.diffs.at(winner) : kNaN;
        if (!(v > 0)) failed << c.name;
    }
    const auto& halves = winner < primary.sets.size() ? primary.sets.at(winner).halves : std::array<std::optional<double>, 2>{};
    bool halvesOk = true;
    for (const auto& h : halves)
        if (!(h && *h > 0)) halvesOk = false;
    if (!halvesOk) failed << kCheckHalves;
    return {failed.isEmpty() ? u"better"_s : u"fragile"_s, winner, failed};
}

namespace {

std::vector<double> diffsOf(const std::vector<std::vector<double>>& matrix) {
    const std::vector<double> empty;
    const std::vector<double>& base = matrix.empty() ? empty : matrix[0];
    std::vector<double> out;
    for (const auto& row : matrix) {
        std::vector<double> d;
        for (size_t j = 0; j < row.size(); ++j) d.push_back(row[j] - (j < base.size() ? base.at(j) : 0.0));
        out.push_back(mean(d));
    }
    return out;
}

FamilySummary summariseFamily(const FamilyResult& f, const QString& objective, const BootOptions& opts, const std::optional<LossCap>& caps) {
    const QString other = objective == u"r" ? u"usd"_s : u"r"_s;
    const auto matrixOf = [&](const Matrix& m, const QString& which) -> const std::vector<std::vector<double>>& { return which == u"r" ? m.r : m.usd; };
    const auto capOf = [&](const QString& which) -> std::optional<double> {
        if (!caps) return std::nullopt;
        return which == u"r" ? caps->r : caps->usd;
    };
    BootOptions po = opts, so = opts;
    po.cap = capOf(objective);
    so.cap = capOf(other);
    FamilySummary s;
    s.family = f.family;
    s.objective = objective;
    s.primary = analyse(matrixOf(f.main, objective), 0, po);
    s.coarse = diffsOf(matrixOf(f.coarse, objective));
    s.alt_terminal = diffsOf(matrixOf(f.alt_terminal, objective));
    s.secondary = analyse(matrixOf(f.main, other), 0, so);
    s.verdict = verdictOf(s.primary, {{kCheckCoarse, s.coarse}, {kCheckTerminal, s.alt_terminal}});
    return s;
}

}  // namespace

Summary summarise(const SweepResult& result, const QString& objective, const BootOptions& opts) {
    Summary s;
    s.objective = objective;
    s.level = opts.level;
    s.draws = opts.draws;
    s.seed = opts.seed;
    s.live = summariseFamily(result.live, objective, opts, result.loss_cap);
    if (result.replay) s.replay = summariseFamily(result.replay->family, objective, opts, result.loss_cap);
    return s;
}

}  // namespace ibkr::analysis::sweep
