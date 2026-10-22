// inference.ts:小样本的区间与检验(Wilson / t / Welch / 秩和 / Newcombe / 中位数的精确区间,按天成簇)。纯数学。
#pragma once

#include <QString>

#include <optional>
#include <vector>

namespace ibkr::analysis::inference {

inline constexpr double kConfidence = 0.95;
inline constexpr double kZ95 = 1.959963984540054;

struct Interval {
    double lo = 0, hi = 0;
};
struct MeanInterval {
    double mean = 0, lo = 0, hi = 0;
};
struct DiffInterval {
    double diff = 0, lo = 0, hi = 0;
};
struct Clustered {
    double value = 0;
    QString cluster;
};
struct ClusteredHit {
    bool hit = false;
    QString cluster;
};

double logGamma(double x);
double incompleteBeta(double x, double a, double b);
double tCdf(double t, double df);
double tQuantile(double p, double df);

std::optional<Interval> wilsonInterval(double successes, double n);
std::optional<MeanInterval> meanInterval(const std::vector<double>& xs, double level = kConfidence);
/// 中位数的精确区间;xs 是有限数(NaN 混进来时 JS 的排序结果说不准,不对齐)
std::optional<Interval> medianInterval(const std::vector<double>& xs, double level = kConfidence);
std::optional<MeanInterval> clusteredMeanInterval(const std::vector<Clustered>& obs, double level = kConfidence);
std::optional<DiffInterval> clusteredDiffInterval(const std::vector<Clustered>& a, const std::vector<Clustered>& b, double level = kConfidence);
std::optional<Interval> clusteredWilsonInterval(const std::vector<ClusteredHit>& obs);
std::optional<DiffInterval> welchInterval(const std::vector<double>& a, const std::vector<double>& b, double level = kConfidence);
std::optional<double> mannWhitneyZ(const std::vector<double>& a, const std::vector<double>& b);
std::optional<DiffInterval> proportionDiffInterval(double x1, double n1, double x2, double n2);

}  // namespace ibkr::analysis::inference
