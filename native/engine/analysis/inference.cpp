#include "analysis/inference.h"

#include "util/jsmath.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

namespace jm = ibkr::util::jsmath;

namespace ibkr::analysis::inference {

namespace {
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kLanczos[] = {0.99999999999980993, 676.5203681218851,  -1259.1392167224028,   771.32342877765313,   -176.61502916214059,
                               12.507343278686905,  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7};

double betaContinuedFraction(double x, double a, double b) {
    constexpr double kTiny = 1e-300;
    const auto guard = [](double v) { return std::fabs(v) < kTiny ? kTiny : v; };
    double c = 1;
    double d = 1 / guard(1 - ((a + b) * x) / (a + 1));
    double h = d;
    for (double m = 1; m <= 2000; m += 1) {
        const double even = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
        d = 1 / guard(1 + even * d);
        c = guard(1 + even / c);
        h *= d * c;
        const double odd = (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
        d = 1 / guard(1 + odd * d);
        c = guard(1 + odd / c);
        const double step = d * c;
        h *= step;
        if (std::fabs(step - 1) < 1e-15) break;
    }
    return h;
}

double meanOf(const std::vector<double>& xs) {
    double s = 0;
    for (double x : xs) s = s + x;
    return s / double(xs.size());
}
double varianceOf(const std::vector<double>& xs, double mean) {
    if (xs.size() <= 1) return 0;
    double acc = 0;
    for (double x : xs) acc = acc + jm::pow(x - mean, 2);
    return acc / double(xs.size() - 1);
}

/// Map<string, number>:簇按第一次出现的先后(求和的次序跟着它走)
using Deviations = std::vector<std::pair<QString, double>>;
Deviations clusterDeviations(const std::vector<Clustered>& obs, double mean) {
    Deviations sums;
    for (const Clustered& o : obs) {
        auto it = std::find_if(sums.begin(), sums.end(), [&](const auto& p) { return p.first == o.cluster; });
        if (it == sums.end()) sums.push_back({o.cluster, 0 + (o.value - mean)});
        else it->second = it->second + (o.value - mean);
    }
    return sums;
}

struct ClusterVar {
    double variance = 0, independent = 0, clusters = 0;
};
std::optional<ClusterVar> clusteredVariance(const std::vector<Clustered>& obs, double mean) {
    const Deviations deviations = clusterDeviations(obs, mean);
    const double g = double(deviations.size());
    if (g < 2) return std::nullopt;
    double acc = 0;
    for (const auto& [k, e] : deviations) acc += e * e;
    const double n = double(obs.size());
    const double byCluster = ((g / (g - 1)) * acc) / (n * n);
    std::vector<double> values;
    for (const Clustered& o : obs) values.push_back(o.value);
    const double independent = varianceOf(values, mean) / n;
    return ClusterVar{jm::max(byCluster, independent), independent, g};
}
}  // namespace

double logGamma(double x) {
    if (x < 0.5) return jm::log(M_PI / jm::sin(M_PI * x)) - logGamma(1 - x);
    const double z = x - 1;
    double acc = kLanczos[0];
    for (int i = 1; i < 9; ++i) acc += kLanczos[i] / (z + i);
    const double t = z + 7.5;
    return 0.5 * jm::log(2 * M_PI) + (z + 0.5) * jm::log(t) - t + jm::log(acc);
}

double incompleteBeta(double x, double a, double b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const double front = jm::exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * jm::log(x) + b * jm::log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(x, a, b)) / a;
    return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

double tCdf(double t, double df) {
    if (!(df > 0) || std::isnan(t)) return kNaN;
    if (t == 0) return 0.5;
    const double tail = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
    return t > 0 ? 1 - tail : tail;
}

double tQuantile(double p, double df) {
    if (!(p > 0 && p < 1) || !(df > 0)) return kNaN;
    if (p == 0.5) return 0;
    if (p < 0.5) return -tQuantile(1 - p, df);
    double lo = 0, hi = 1;
    while (tCdf(hi, df) < p && hi < 1e15) hi *= 2;
    for (int i = 0; i < 200; ++i) {
        const double mid = (lo + hi) / 2;
        if (tCdf(mid, df) < p) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

std::optional<Interval> wilsonInterval(double successes, double n) {
    if (!(n > 0)) return std::nullopt;
    const double p = successes / n;
    const double z2 = kZ95 * kZ95;
    const double centre = (p + z2 / (2 * n)) / (1 + z2 / n);
    const double half = (kZ95 * std::sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
    return Interval{jm::max(0, centre - half), jm::min(1, centre + half)};
}

std::optional<MeanInterval> meanInterval(const std::vector<double>& xs, double level) {
    if (xs.size() < 2) return std::nullopt;
    const double mean = meanOf(xs);
    const double half = tQuantile(1 - (1 - level) / 2, double(xs.size()) - 1) * std::sqrt(varianceOf(xs, mean) / double(xs.size()));
    return MeanInterval{mean, mean - half, mean + half};
}

std::optional<Interval> medianInterval(const std::vector<double>& xs, double level) {
    const double n = double(xs.size());
    const double tail = (1 - level) / 2;
    double cum = 0;
    double k = 0;
    for (double i = 0; i < n; i += 1) {
        cum += jm::exp(logGamma(n + 1) - logGamma(i + 1) - logGamma(n - i + 1) + n * jm::log(0.5));
        if (cum > tail) break;
        k = i + 1;
    }
    if (k == 0) return std::nullopt;
    std::vector<double> s = xs;
    std::stable_sort(s.begin(), s.end());
    return Interval{s[size_t(k - 1)], s[size_t(n - k)]};
}

std::optional<MeanInterval> clusteredMeanInterval(const std::vector<Clustered>& obs, double level) {
    if (obs.size() < 2) return std::nullopt;
    std::vector<double> values;
    for (const Clustered& o : obs) values.push_back(o.value);
    const double mean = meanOf(values);
    const auto v = clusteredVariance(obs, mean);
    if (!v) return std::nullopt;
    const double half = tQuantile(1 - (1 - level) / 2, v->clusters - 1) * std::sqrt(v->variance);
    return MeanInterval{mean, mean - half, mean + half};
}

std::optional<DiffInterval> clusteredDiffInterval(const std::vector<Clustered>& a, const std::vector<Clustered>& b, double level) {
    if (a.size() < 2 || b.size() < 2) return std::nullopt;
    std::vector<double> av, bv;
    for (const Clustered& o : a) av.push_back(o.value);
    for (const Clustered& o : b) bv.push_back(o.value);
    const double ma = meanOf(av), mb = meanOf(bv);
    const auto va = clusteredVariance(a, ma), vb = clusteredVariance(b, mb);
    if (!va || !vb) return std::nullopt;
    const double diff = ma - mb;
    const Deviations db = clusterDeviations(b, mb);
    double cross = 0;
    for (const auto& [cluster, e] : clusterDeviations(a, ma)) {
        double other = 0;
        for (const auto& [k, v] : db)
            if (k == cluster) other = v;
        cross += (e / double(a.size())) * (other / double(b.size()));
    }
    const double variance = va->variance + vb->variance - 2 * jm::min(cross, 0);
    if (!(variance > 0)) return DiffInterval{diff, diff, diff};
    const double spread = jm::pow(va->variance, 2) / (va->clusters - 1) + jm::pow(vb->variance, 2) / (vb->clusters - 1);
    const double df = spread > 0 ? jm::pow(va->variance + vb->variance, 2) / spread : va->clusters + vb->clusters - 2;
    const double half = tQuantile(1 - (1 - level) / 2, df) * std::sqrt(variance);
    return DiffInterval{diff, diff - half, diff + half};
}

std::optional<Interval> clusteredWilsonInterval(const std::vector<ClusteredHit>& obs) {
    const double n = double(obs.size());
    if (obs.empty()) return std::nullopt;
    double hits = 0;
    for (const ClusteredHit& o : obs) hits += o.hit ? 1 : 0;
    if (n == 1) return wilsonInterval(hits, n);
    std::vector<Clustered> values;
    for (const ClusteredHit& o : obs) values.push_back({o.hit ? 1.0 : 0.0, o.cluster});
    const auto v = clusteredVariance(values, hits / n);
    if (!v) return std::nullopt;
    const double effect = v->independent > 0 ? jm::max(1, v->variance / v->independent) : 1;
    return wilsonInterval(hits / effect, n / effect);
}

std::optional<DiffInterval> welchInterval(const std::vector<double>& a, const std::vector<double>& b, double level) {
    if (a.size() < 2 || b.size() < 2) return std::nullopt;
    const double ma = meanOf(a), mb = meanOf(b);
    const double va = varianceOf(a, ma) / double(a.size()), vb = varianceOf(b, mb) / double(b.size());
    const double diff = ma - mb;
    const double se2 = va + vb;
    if (!(se2 > 0)) return DiffInterval{diff, diff, diff};
    const double df = (se2 * se2) / ((va * va) / (double(a.size()) - 1) + (vb * vb) / (double(b.size()) - 1));
    const double half = tQuantile(1 - (1 - level) / 2, df) * std::sqrt(se2);
    return DiffInterval{diff, diff - half, diff + half};
}

std::optional<double> mannWhitneyZ(const std::vector<double>& a, const std::vector<double>& b) {
    if (a.empty() || b.empty()) return std::nullopt;
    for (double v : a)
        if (!std::isfinite(v)) return std::nullopt;
    for (double v : b)
        if (!std::isfinite(v)) return std::nullopt;
    std::vector<std::pair<double, bool>> all;
    for (double v : a) all.push_back({v, true});
    for (double v : b) all.push_back({v, false});
    std::stable_sort(all.begin(), all.end(), [](const auto& x, const auto& y) { return x.first < y.first; });
    const double total = double(all.size());
    double rankSum = 0, ties = 0;
    for (size_t i = 0; i < all.size();) {
        size_t j = i;
        while (j < all.size() && all[j].first == all[i].first) ++j;
        const double rank = (double(i) + 1 + double(j)) / 2;
        const double size = double(j - i);
        ties += jm::pow(size, 3) - size;
        for (size_t k = i; k < j; ++k)
            if (all[k].second) rankSum += rank;
        i = j;
    }
    const double na = double(a.size()), nb = double(b.size());
    const double u = rankSum - (na * (na + 1)) / 2;
    const double variance = ((na * nb) / 12) * (total + 1 - ties / (total * (total - 1)));
    if (!(variance > 0)) return 0.0;
    const double d = u - (na * nb) / 2;
    const double sign = d > 0 ? 1 : d < 0 ? -1 : d;  // Math.sign
    return (std::fabs(d) <= 0.5 ? 0 : d - sign * 0.5) / std::sqrt(variance);
}

std::optional<DiffInterval> proportionDiffInterval(double x1, double n1, double x2, double n2) {
    const auto w1 = wilsonInterval(x1, n1), w2 = wilsonInterval(x2, n2);
    if (!w1 || !w2) return std::nullopt;
    const double p1 = x1 / n1, p2 = x2 / n2;
    const double diff = p1 - p2;
    return DiffInterval{diff, diff - std::sqrt(jm::pow(p1 - w1->lo, 2) + jm::pow(w2->hi - p2, 2)),
                        diff + std::sqrt(jm::pow(w1->hi - p1, 2) + jm::pow(p2 - w2->lo, 2))};
}

}  // namespace ibkr::analysis::inference
