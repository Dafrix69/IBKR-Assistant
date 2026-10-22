#include "analysis/fly_model.h"

#include "util/collate.h"
#include "util/error.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsnum.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/tz.h"

#include <QDateTime>
#include <QTimeZone>
#include <QRegularExpression>

#include <algorithm>
#include <cmath>
#include <limits>
#include <numeric>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;

namespace ibkr::analysis {

namespace {
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
QString et() { return QString::fromUtf16(util::kET); }
/// arr[i]:下标越界或不是整数时 JS 读到 undefined,算下去就是 NaN
double at(const std::vector<double>& v, double i) {
    if (!(i >= 0) || i != std::floor(i) || i >= double(v.size())) return kNaN;
    return v[size_t(i)];
}
/// list.slice(start, end) 的下标(负数从尾部数,NaN 当 0,越界夹住)
size_t sliceIndex(double rel, size_t len) {
    if (std::isnan(rel)) rel = 0;
    const double n = double(len);
    const double r = rel < 0 ? jm::max(n + rel, 0) : jm::min(rel, n);
    return size_t(r);
}
/// Number(v.toFixed(nd))
double roundTo(double v, int nd) { return util::jsStringToNumber(util::jsToFixed(v, nd)); }
struct EtOf {
    QString date;
    double minute;
};
EtOf etOf(double sec) {
    const util::WallParts w = util::wallParts(sec * 1000, et());
    return {u"%1-%2-%3"_s.arg(util::jsNumberToString(w.year), util::pad2(w.month), util::pad2(w.day)), w.hour * 60 + w.minute};
}
bool dateLess(const QString& a, const QString& b) { return util::localeCompare(a, b) < 0; }
OJson nums(const std::vector<double>& v) {
    QList<OJson> items;
    for (double x : v) items << js::N(x);
    return js::array(items);
}
OJson responseJson(const Response& r) { return js::object({{u"a"_s, js::N(r.a)}, {u"b"_s, js::N(r.b)}, {u"c"_s, js::N(r.c)}}); }
OJson spanJson(const Span& s) { return js::object({{u"from"_s, js::S(s.from)}, {u"to"_s, js::S(s.to)}, {u"days"_s, js::N(s.days)}}); }
double numOf(const OJson& o, const char16_t* k) { return o.get(QString::fromUtf16(k))->n; }
Response responseOf(const OJson& o) { return {numOf(o, u"a"), numOf(o, u"b"), numOf(o, u"c")}; }
}  // namespace

// ================================================================ 模型的形状
OJson OwnFit::toJson() const {
    return js::object({{u"period"_s, js::object({{u"from"_s, js::S(periodFrom)}, {u"to"_s, js::S(periodTo)}})},
                       {u"days"_s, js::N(days)},
                       {u"rows"_s, js::N(rows)},
                       {u"response"_s, responseJson(response)},
                       {u"drift"_s, nums(drift)},
                       {u"resid_k"_s, js::N(resid_k)},
                       {u"resid_move"_s, js::object({{u"base"_s, js::N(resid_move.base)}, {u"slope"_s, js::N(resid_move.slope)}})},
                       {u"fit"_s, js::object({{u"r2_in"_s, js::N(r2_in)}, {u"r2_out"_s, js::N(r2_out)}, {u"r2_out_index"_s, js::N(r2_out_index)},
                                              {u"coverage_half"_s, js::N(coverage_half)}})}});
}

OJson FlyIvModel::toJson() const {
    OJson longJ = OJson::null();
    if (response_long) {
        longJ = responseJson(*response_long);
        longJ.set(u"days"_s, js::N(response_long_days));
    }
    return js::object({{u"version"_s, js::S(version)},
                       {u"source"_s, js::S(source)},
                       {u"proxy"_s, js::S(proxy)},
                       {u"period"_s, js::object({{u"from"_s, js::S(periodFrom)}, {u"to"_s, js::S(periodTo)}})},
                       {u"days"_s, js::N(days)},
                       {u"variance_weights"_s, nums(variance_weights)},
                       {u"realized_to_implied"_s, js::N(realized_to_implied)},
                       {u"response"_s, responseJson(response)},
                       {u"response_long"_s, longJ},
                       {u"resid_k"_s, js::N(resid_k)},
                       {u"resid_move"_s, js::object({{u"base"_s, js::N(resid_move.base)}, {u"slope"_s, js::N(resid_move.slope)}})},
                       {u"own"_s, own ? own->toJson() : OJson::null()},
                       {u"fit"_s, js::object({{u"rows"_s, js::N(fit_rows)},
                                              {u"r2_in"_s, js::N(r2_in)},
                                              {u"r2_out"_s, js::N(r2_out)},
                                              {u"r2_out_flat"_s, js::N(r2_out_flat)},
                                              {u"coverage_half"_s, js::N(coverage_half)},
                                              {u"train"_s, spanJson(train)},
                                              {u"test"_s, spanJson(test)}})}});
}

FlyIvModel FlyIvModel::fromJson(const OJson& j) {
    FlyIvModel m;
    m.version = j.get(u"version"_s)->s;
    m.source = j.get(u"source"_s)->s;
    m.proxy = j.get(u"proxy"_s)->s;
    m.periodFrom = j.get(u"period"_s)->get(u"from"_s)->s;
    m.periodTo = j.get(u"period"_s)->get(u"to"_s)->s;
    m.days = numOf(j, u"days");
    for (const OJson& w : j.get(u"variance_weights"_s)->items) m.variance_weights.push_back(w.n);
    m.realized_to_implied = numOf(j, u"realized_to_implied");
    m.response = responseOf(*j.get(u"response"_s));
    if (const OJson* l = j.get(u"response_long"_s); l && l->type == OJson::Object) {
        m.response_long = responseOf(*l);
        m.response_long_days = numOf(*l, u"days");
    }
    m.resid_k = numOf(j, u"resid_k");
    m.resid_move = {numOf(*j.get(u"resid_move"_s), u"base"), numOf(*j.get(u"resid_move"_s), u"slope")};
    if (const OJson* o = j.get(u"own"_s); o && o->type == OJson::Object) {
        OwnFit f;
        f.periodFrom = o->get(u"period"_s)->get(u"from"_s)->s;
        f.periodTo = o->get(u"period"_s)->get(u"to"_s)->s;
        f.days = numOf(*o, u"days");
        f.rows = numOf(*o, u"rows");
        f.response = responseOf(*o->get(u"response"_s));
        for (const OJson& d : o->get(u"drift"_s)->items) f.drift.push_back(d.n);
        f.resid_k = numOf(*o, u"resid_k");
        f.resid_move = {numOf(*o->get(u"resid_move"_s), u"base"), numOf(*o->get(u"resid_move"_s), u"slope")};
        const OJson& fit = *o->get(u"fit"_s);
        f.r2_in = numOf(fit, u"r2_in");
        f.r2_out = numOf(fit, u"r2_out");
        f.r2_out_index = numOf(fit, u"r2_out_index");
        f.coverage_half = numOf(fit, u"coverage_half");
        m.own = f;
    }
    const OJson& fit = *j.get(u"fit"_s);
    m.fit_rows = numOf(fit, u"rows");
    m.r2_in = numOf(fit, u"r2_in");
    m.r2_out = numOf(fit, u"r2_out");
    m.r2_out_flat = numOf(fit, u"r2_out_flat");
    m.coverage_half = numOf(fit, u"coverage_half");
    const auto span = [](const OJson& s) { return Span{s.get(u"from"_s)->s, s.get(u"to"_s)->s, s.get(u"days"_s)->n}; };
    m.train = span(*fit.get(u"train"_s));
    m.test = span(*fit.get(u"test"_s));
    return m;
}

const OJson& flyIvModelJson() {
    // flyIvModel.ts 由 scripts/calibrate-fly-iv.mjs 生成;这里是同一份(tst_fly_model 对着它比)
    static const OJson j = *util::parseOJson(QString::fromUtf8(R"JSON({"version":"2026-09-28","source":"SPY 小时线与 5 分钟线、^VIX1D 与 ^VIX9D 小时线(公开行情接口)","proxy":"VIX1D","period":{"from":"2023-12-11","to":"2026-09-25"},"days":692,"variance_weights":[0.1507,0.1178,0.0948,0.0805,0.0596,0.0517,0.0597,0.0509,0.0597,0.0616,0.0609,0.0522,0.0999],"realized_to_implied":0.83,"response":{"a":-0.0105,"b":-0.0969,"c":0.0253},"response_long":{"a":-0.0053,"b":-0.0641,"c":0.0129,"days":9},"resid_k":0.158,"resid_move":{"base":0.823,"slope":0.265},"own":null,"fit":{"rows":19376,"r2_in":0.338,"r2_out":0.322,"r2_out_flat":-0.007,"coverage_half":0.525,"train":{"from":"2023-12-11","to":"2025-11-19","days":484},"test":{"from":"2025-11-20","to":"2026-09-25","days":208}}})JSON"));
    return j;
}

const FlyIvModel& flyIvModel() {
    static const FlyIvModel m = FlyIvModel::fromJson(flyIvModelJson());
    return m;
}

// ================================================================ K 线 → 每天一行
std::vector<std::pair<QString, std::vector<MinuteBar>>> sessions(const std::vector<Bar>& bars) {
    std::vector<std::pair<QString, std::vector<MinuteBar>>> out;
    QHash<QString, size_t> index;
    for (const Bar& bar : bars) {
        if (!(bar.open > 0) || !(bar.close > 0)) continue;
        const EtOf e = etOf(bar.sec);
        if (e.minute < kOpenMinute || e.minute >= kCloseMinute) continue;
        MinuteBar mb;
        mb.sec = bar.sec;
        mb.open = bar.open;
        mb.close = bar.close;
        mb.minute = e.minute;
        if (!index.contains(e.date)) {
            index.insert(e.date, out.size());
            out.push_back({e.date, {}});
        }
        out[index.value(e.date)].second.push_back(mb);
    }
    for (auto& [date, day] : out) std::stable_sort(day.begin(), day.end(), [](const MinuteBar& a, const MinuteBar& b) { return a.minute < b.minute; });
    return out;
}

namespace {
const std::vector<MinuteBar>* dayOf(const std::vector<std::pair<QString, std::vector<MinuteBar>>>& s, const QString& date) {
    for (const auto& [d, bars] : s)
        if (d == date) return &bars;
    return nullptr;
}
}  // namespace

std::optional<std::vector<double>> gridOf(const std::vector<MinuteBar>* day, double stepMinutes) {
    if (!day || day->empty() || (*day)[0].minute != kOpenMinute) return std::nullopt;
    const double expected = std::ceil((kCloseMinute - kOpenMinute) / stepMinutes);
    const double n = double(day->size());
    if (stepMinutes >= 60 ? n != expected : n < expected - 2) return std::nullopt;
    std::vector<double> out{(*day)[0].open};
    for (const MinuteBar& b : *day) out.push_back(b.close);
    return out;
}

// ================================================================ 日内方差分布
std::vector<double> varianceShares(const std::vector<ScaledDay>& days, int buckets, double bucketMinutes) {
    std::vector<double> sum(size_t(buckets), 0.0);
    for (const ScaledDay& day : days) {
        const double scale = jm::pow(day.level / 100, 2) / 252;
        for (size_t i = 1; i < day.grid.size(); ++i) {
            const double r = jm::log(day.grid[i] / day.grid[i - 1]);
            const double bucket = jm::min(double(buckets - 1), std::floor((at(day.minutes, double(i - 1)) - kOpenMinute) / bucketMinutes));
            // 落在数组外的桶(NaN、负数):JS 写成了一个不算进数组的属性,求和时不见
            if (!(bucket >= 0)) continue;
            sum[size_t(bucket)] = sum[size_t(bucket)] + (r * r) / scale;
        }
    }
    double total = 0;
    for (double v : sum) total += v;
    if (!(total > 0)) throw util::JsError(u"方差分布估不出来:没有可用的交易日"_s);
    std::vector<double> out;
    for (double v : sum) out.push_back(v / total);
    return out;
}

std::vector<double> halfHourWeights(const std::vector<double>& hourly, const std::vector<double>& fine) {
    if (hourly.size() != size_t(kHours) || fine.size() != size_t(kHalfHours)) throw util::JsError(u"份额的个数不对"_s);
    std::vector<double> out;
    for (int h = 0; h < kHours - 1; ++h) {
        const double first = fine[size_t(2 * h)], second = fine[size_t(2 * h + 1)];
        const double total = first + second;
        out.push_back(total > 0 ? (hourly[size_t(h)] * first) / total : hourly[size_t(h)] / 2);
        out.push_back(total > 0 ? (hourly[size_t(h)] * second) / total : hourly[size_t(h)] / 2);
    }
    out.push_back(hourly[size_t(kHours - 1)]);
    return out;
}

double remainingShare(const std::vector<double>& weights, double minute) {
    if (minute <= kOpenMinute) return 1;
    if (minute >= kCloseMinute) return 0;
    const double width = (kCloseMinute - kOpenMinute) / double(weights.size());
    const double elapsed = minute - kOpenMinute;
    const double bucket = std::floor(elapsed / width);
    double used = 0;
    for (double i = 0; i < bucket; i += 1) used += at(weights, i);
    used += at(weights, bucket) * ((elapsed - bucket * width) / width);
    return jm::max(0, jm::min(1, 1 - used));
}

// ================================================================ IV 对走势的反应
namespace {
double clip(double u) { return jm::max(-kUMax, jm::min(kUMax, u)); }
}  // namespace

double predict(const Response& beta, double u) {
    const double x = clip(u);
    return beta.a + beta.b * x + beta.c * x * x;
}

Response fitResponse(const std::vector<ResponseRow>& rows) {
    if (rows.size() < 30) throw util::JsError(u"样本太少(%1 个窗口),拟合不了 IV 的反应"_s.arg(rows.size()));
    double A[3][3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}}, b[3] = {0, 0, 0};
    for (const ResponseRow& row : rows) {
        const double u = clip(row.u), x[3] = {1, u, u * u};
        for (int i = 0; i < 3; ++i) {
            b[i] = b[i] + x[i] * row.y;
            for (int j = 0; j < 3; ++j) A[i][j] = A[i][j] + x[i] * x[j];
        }
    }
    // 三元一次方程组:列主元消去
    for (int i = 0; i < 3; ++i) {
        int p = i;
        for (int r = i + 1; r < 3; ++r)
            if (std::abs(A[r][i]) > std::abs(A[p][i])) p = r;
        for (int c = 0; c < 3; ++c) std::swap(A[i][c], A[p][c]);
        std::swap(b[i], b[p]);
        if (std::abs(A[i][i]) < 1e-12) throw util::JsError(u"拟合不了 IV 的反应:样本里的走势没有变化"_s);
        for (int r = i + 1; r < 3; ++r) {
            const double f = A[r][i] / A[i][i];
            for (int c = i; c < 3; ++c) A[r][c] = A[r][c] - f * A[i][c];
            b[r] = b[r] - f * b[i];
        }
    }
    double beta[3] = {0, 0, 0};
    for (int i = 2; i >= 0; --i) {
        double s = b[i];
        for (int c = i + 1; c < 3; ++c) s -= A[i][c] * beta[c];
        beta[i] = s / A[i][i];
    }
    return {beta[0], beta[1], beta[2]};
}

double residualSd(double residK, const ResidMove& move, double share, double u) {
    const double x = jm::min(kUMax, std::abs(u));
    return residK * std::sqrt(jm::max(0, share)) * jm::max(0.1, move.base + move.slope * x);
}

namespace {
ResidMove residualByMove(const std::vector<ResponseRow>& rows, const Response& beta, double k) {
    double n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const ResponseRow& row : rows) {
        const double x = jm::min(kUMax, std::abs(row.u));
        const double y = std::abs(row.y - predict(beta, row.u)) / (k * std::sqrt(row.share));
        n += 1;
        sx += x;
        sy += y;
        sxx += x * x;
        sxy += x * y;
    }
    const double slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const double scale = std::sqrt(2 / M_PI);
    return {(sy - slope * sx) / n / scale, slope / scale};
}
}  // namespace

double rSquared(const std::vector<ResponseRow>& rows, const std::optional<Response>& beta) {
    double total = 0;
    for (const ResponseRow& r : rows) total += r.y;
    const double mean = total / double(rows.size());
    double sse = 0, sst = 0;
    for (const ResponseRow& row : rows) {
        sse += jm::pow(row.y - (beta ? predict(*beta, row.u) : 0), 2);
        sst += jm::pow(row.y - mean, 2);
    }
    return 1 - sse / sst;
}

namespace {
struct PairedDay {
    QString date;
    std::vector<double> price, iv, level;
};

std::vector<ResponseRow> responseRows(const std::vector<PairedDay>& days, const std::vector<double>& drift, const std::vector<double>& levelDrift,
                                      const std::vector<double>& hourly, double k2) {
    std::vector<ResponseRow> rows;
    for (const PairedDay& day : days) {
        for (int i = 0; i < kHours; ++i) {
            const double daySigma = std::sqrt(k2 / 252) * (day.level[size_t(i)] * jm::exp(-levelDrift[size_t(i)])) / 100;
            for (int j = i + 1; j <= kHours; ++j) {
                double share = 0;
                for (int h = i; h < j; ++h) share += hourly[size_t(h)];
                rows.push_back({day.date, jm::log(day.price[size_t(j)] / day.price[size_t(i)]) / daySigma,
                                jm::log(day.iv[size_t(j)] / day.iv[size_t(i)]) - (drift[size_t(j)] - drift[size_t(i)]), share});
            }
        }
    }
    return rows;
}

std::vector<double> driftOf(const std::vector<PairedDay>& days, const std::function<const std::vector<double>&(const PairedDay&)>& pick) {
    std::vector<double> out;
    for (int i = 0; i <= kHours; ++i) {
        double acc = 0;
        for (const PairedDay& d : days) acc = acc + jm::log(pick(d)[size_t(i)] / pick(d)[0]);
        out.push_back(acc / double(days.size()));
    }
    return out;
}

std::vector<double> fineSharesOf(const std::vector<Bar>& priceFine, const std::vector<std::pair<QString, std::vector<MinuteBar>>>& iv) {
    std::vector<ScaledDay> days;
    for (const auto& [date, bars] : sessions(priceFine)) {
        const auto grid = gridOf(&bars, 5);
        const auto* ivDay = dayOf(iv, date);
        const double level = ivDay && !ivDay->empty() ? (*ivDay)[0].open : 0;
        if (!grid || !(level != 0 && !std::isnan(level))) continue;
        ScaledDay d;
        d.date = date;
        for (const MinuteBar& b : bars) d.minutes.push_back(b.minute);
        d.grid = *grid;
        d.level = level;
        days.push_back(d);
    }
    if (days.size() < 20) throw util::JsError(u"5 分钟线只有 %1 天可用,不够分半小时(至少 20 天)"_s.arg(days.size()));
    return varianceShares(days, kHalfHours, 30);
}
}  // namespace

FlyIvModel calibrate(const CalibrationInput& input) {
    const auto price = sessions(input.priceHourly), iv = sessions(input.ivHourly);
    std::vector<PairedDay> days;
    for (const auto& [date, bars] : price) {
        const auto p = gridOf(&bars, 60), v = gridOf(dayOf(iv, date), 60);
        if (!p || !v) continue;
        days.push_back({date, *p, *v, *v});
    }
    std::stable_sort(days.begin(), days.end(), [](const PairedDay& a, const PairedDay& b) { return dateLess(a.date, b.date); });
    if (days.size() < 60) throw util::JsError(u"标的与 IV 指数都齐的交易日只有 %1 天,不够校准(至少 60 天)"_s.arg(days.size()));

    // ---- 日内方差分布 ----
    std::vector<double> hourMinutes;
    for (int i = 0; i < kHours; ++i) hourMinutes.push_back(kOpenMinute + i * 60);
    std::vector<ScaledDay> scaled;
    for (const PairedDay& d : days) scaled.push_back({d.date, hourMinutes, d.price, d.iv[0]});
    const std::vector<double> hourly = varianceShares(scaled, kHours, 60);
    const std::vector<double> weights = halfHourWeights(hourly, input.fineShares ? *input.fineShares : fineSharesOf(input.priceFine, iv));

    double k2 = 0;
    for (const PairedDay& d : days) {
        double rv = 0;
        for (size_t i = 1; i < d.price.size(); ++i) rv += jm::pow(jm::log(d.price[i] / d.price[i - 1]), 2);
        k2 += rv / (jm::pow(d.iv[0] / 100, 2) / 252);
    }
    k2 /= double(days.size());

    // ---- IV 的反应:前一段拟合,后一段检验;定稿的系数用全部样本 ----
    const auto ivOf = [](const PairedDay& d) -> const std::vector<double>& { return d.iv; };
    const auto levelOf = [](const PairedDay& d) -> const std::vector<double>& { return d.level; };
    const double cut = std::floor(double(days.size()) * input.trainShare.value_or(0.7));
    const size_t cutAt = sliceIndex(cut, days.size());
    const std::vector<PairedDay> train(days.begin(), days.begin() + qsizetype(cutAt)), test(days.begin() + qsizetype(cutAt), days.end());
    const std::vector<double> trainDrift = driftOf(train, ivOf);
    const std::vector<ResponseRow> trainRows = responseRows(train, trainDrift, trainDrift, hourly, k2);
    const std::vector<ResponseRow> testRows = responseRows(test, trainDrift, trainDrift, hourly, k2);
    const Response trainBeta = fitResponse(trainRows);

    const std::vector<double> drift = driftOf(days, ivOf);
    const std::vector<ResponseRow> rows = responseRows(days, drift, drift, hourly, k2);
    const Response response = fitResponse(rows);
    double scaledSum = 0;
    for (const ResponseRow& row : rows) scaledSum += jm::pow(row.y - predict(response, row.u), 2) / row.share;
    const double residK = std::sqrt(scaledSum / double(rows.size()));
    const ResidMove residMove = residualByMove(rows, response, residK);
    double covered = 0;
    for (const ResponseRow& row : rows) {
        const double sd = residualSd(residK, residMove, row.share, row.u);
        if (std::abs(row.y - predict(response, row.u)) <= kQuartile * sd) covered += 1;
    }

    std::optional<Response> longBeta;
    double longDays = 0;
    if (input.ivLongHourly) {
        const auto longIv = sessions(*input.ivLongHourly);
        std::vector<PairedDay> paired;
        for (const PairedDay& d : days) {
            const auto v = gridOf(dayOf(longIv, d.date), 60);
            if (v) paired.push_back({d.date, d.price, *v, d.level});
        }
        if (paired.size() >= 60) {
            longBeta = fitResponse(responseRows(paired, driftOf(paired, ivOf), driftOf(paired, levelOf), hourly, k2));
            longDays = input.ivLongDays.value_or(9);
        }
    }

    const auto span = [](const std::vector<PairedDay>& list) {
        if (list.empty()) throw util::JsError(u"Cannot read properties of undefined (reading 'date')"_s);
        return Span{list.front().date, list.back().date, double(list.size())};
    };
    const auto beta4 = [](const Response& r) { return Response{roundTo(r.a, 4), roundTo(r.b, 4), roundTo(r.c, 4)}; };
    // 份额取四位小数之后和不一定正好是 1:差的那一点补在最大的那一桶上
    std::vector<double> rounded;
    for (double w : weights) rounded.push_back(roundTo(w, 4));
    double top = -std::numeric_limits<double>::infinity();
    for (double r : rounded) top = jm::max(top, r);
    const size_t topIdx = size_t(std::find(rounded.begin(), rounded.end(), top) - rounded.begin());
    double sum = 0;
    for (double r : rounded) sum += r;
    if (topIdx < rounded.size()) rounded[topIdx] = roundTo(rounded[topIdx] + 1 - sum, 4);

    FlyIvModel m;
    m.version = input.version;
    m.source = input.source;
    m.proxy = input.proxy;
    m.periodFrom = days.front().date;
    m.periodTo = days.back().date;
    m.days = double(days.size());
    m.variance_weights = rounded;
    m.realized_to_implied = roundTo(k2, 3);
    m.response = beta4(response);
    if (longBeta) {
        m.response_long = beta4(*longBeta);
        m.response_long_days = longDays;
    }
    m.resid_k = roundTo(residK, 3);
    m.resid_move = {roundTo(residMove.base, 3), roundTo(residMove.slope, 3)};
    m.fit_rows = double(rows.size());
    m.r2_in = roundTo(rSquared(rows, response), 3);
    m.r2_out = roundTo(rSquared(testRows, trainBeta), 3);
    m.r2_out_flat = roundTo(rSquared(testRows, std::nullopt), 3);
    m.coverage_half = roundTo(covered / double(rows.size()), 3);
    m.train = span(train);
    m.test = span(test);
    return m;
}

// ================================================================ 自己攒的当日到期期权 IV
namespace {
constexpr int kOwnMinRows = 1000;
constexpr double kOwnSnapMinutes = 4;
bool validIv(const std::optional<double>& iv) { return iv && *iv > 0.01 && *iv < 3; }

struct OwnPoint {
    double spot = 0, minute = 0;
    std::vector<std::pair<QString, double>> ivs;  // Map:同一个键后写的覆盖值、位置不变
    double atm = 0;
    const double* iv(const QString& key) const {
        for (const auto& [k, v] : ivs)
            if (k == key) return &v;
        return nullptr;
    }
    void setIv(const QString& key, double v) {
        for (auto& [k, x] : ivs)
            if (k == key) {
                x = v;
                return;
            }
        ivs.push_back({key, v});
    }
};

std::vector<std::optional<OwnPoint>> ownGrid(const std::vector<OwnSample>& samples) {
    std::vector<std::optional<OwnPoint>> out;
    for (int g = 0; g < kOwnGridPoints; ++g) {
        const double minute = kOwnGridStart + g * 30;
        const OwnSample* best = nullptr;
        double gap = kOwnSnapMinutes + 1;
        for (const OwnSample& sample : samples) {
            const double at = etOf(sample.t / 1000).minute + std::fmod(sample.t, 60'000) / 60'000;
            if (std::abs(at - minute) < gap) {
                best = &sample;
                gap = std::abs(at - minute);
            }
        }
        if (!best || !(best->spot > 0)) {
            out.push_back(std::nullopt);
            continue;
        }
        OwnPoint p;
        double near = std::numeric_limits<double>::infinity();
        for (const OwnLeg& leg : best->legs) {
            if (!validIv(leg.iv)) continue;
            p.setIv(util::jsNumberToString(leg.strike) + leg.right, *leg.iv);
            near = jm::min(near, std::abs(leg.strike - best->spot));
        }
        std::vector<double> atms;
        for (const OwnLeg& leg : best->legs)
            if (validIv(leg.iv) && std::abs(leg.strike - best->spot) == near) atms.push_back(*leg.iv);
        if (atms.empty()) {
            out.push_back(std::nullopt);
            continue;
        }
        double s = 0;
        for (double a : atms) s += a;
        p.spot = best->spot;
        p.minute = minute;
        p.atm = s / double(atms.size());
        out.push_back(p);
    }
    return out;
}

std::optional<double> legChange(const OwnPoint& a, const OwnPoint& b, double within) {
    double sum = 0, n = 0;
    for (const auto& [key, iv] : a.ivs) {
        const double* later = b.iv(key);
        if (!later || std::abs(util::jsParseFloat(key) - a.spot) > within) continue;
        sum += jm::log(*later / iv);
        n += 1;
    }
    return n != 0 ? std::optional<double>(sum / n) : std::nullopt;
}
}  // namespace

OwnFit fitFromSamples(const std::vector<OwnSample>& samples, const std::vector<double>& varianceWeights, const Response& indexResponse) {
    std::vector<std::pair<QString, std::vector<OwnSample>>> byDay;
    QHash<QString, size_t> index;
    for (const OwnSample& sample : samples) {
        const EtOf e = etOf(sample.t / 1000);
        if (e.minute < kOpenMinute || e.minute >= kCloseMinute) continue;
        if (sample.expiry != QString(e.date).remove(u'-')) continue;  // 只要当日到期的
        if (!index.contains(e.date)) {
            index.insert(e.date, byDay.size());
            byDay.push_back({e.date, {}});
        }
        byDay[index.value(e.date)].second.push_back(sample);
    }
    struct Day {
        QString date;
        std::vector<std::optional<OwnPoint>> grid;
    };
    std::vector<Day> days;
    for (const auto& [date, list] : byDay) {
        Day d{date, ownGrid(list)};
        int present = 0;
        for (const auto& p : d.grid) present += p ? 1 : 0;
        if (present >= 6) days.push_back(d);
    }
    std::stable_sort(days.begin(), days.end(), [](const Day& a, const Day& b) { return dateLess(a.date, b.date); });
    if (days.size() < size_t(kOwnMinDays))
        throw util::JsError(u"自己攒的样本里,一天有六个半小时点以上的只有 %1 天,不够(至少 %2 天)"_s.arg(days.size()).arg(kOwnMinDays));

    constexpr double kYearMinutes = 365.0 * 24 * 60;
    const auto daySigmaOf = [&](const OwnPoint& p) {
        return (p.atm * std::sqrt((kCloseMinute - p.minute) / kYearMinutes)) / std::sqrt(remainingShare(varianceWeights, p.minute));
    };
    const auto driftOver = [&](const std::vector<Day>& list) {
        std::vector<double> drift{0};
        for (int g = 1; g < kOwnGridPoints; ++g) {
            double sum = 0, n = 0;
            for (const Day& day : list) {
                const auto& a = day.grid[size_t(g - 1)];
                const auto& b = day.grid[size_t(g)];
                if (!a || !b) continue;
                const auto change = legChange(*a, *b, daySigmaOf(*a) * a->spot);
                if (change) {
                    sum += *change;
                    n += 1;
                }
            }
            drift.push_back(drift[size_t(g - 1)] + (n != 0 ? sum / n : 0));
        }
        return drift;
    };
    const auto rowsOver = [&](const std::vector<Day>& list, const std::vector<double>& drift) {
        std::vector<ResponseRow> rows;
        for (const Day& day : list) {
            for (int i = 0; i < kOwnGridPoints; ++i) {
                const auto& a = day.grid[size_t(i)];
                if (!a) continue;
                const double sigma = daySigmaOf(*a);
                for (int j = i + 1; j < kOwnGridPoints; ++j) {
                    const auto& b = day.grid[size_t(j)];
                    if (!b) continue;
                    const auto change = legChange(*a, *b, sigma * a->spot);
                    const double share = remainingShare(varianceWeights, a->minute) - remainingShare(varianceWeights, b->minute);
                    if (!change || !(share > 0) || !(sigma > 0)) continue;
                    rows.push_back({day.date, jm::log(b->spot / a->spot) / sigma, *change - (drift[size_t(j)] - drift[size_t(i)]), share});
                }
            }
        }
        return rows;
    };

    const size_t cut = size_t(std::floor(double(days.size()) * 0.7));
    const std::vector<Day> train(days.begin(), days.begin() + qsizetype(cut)), test(days.begin() + qsizetype(cut), days.end());
    const std::vector<double> trainDrift = driftOver(train);
    const Response trainBeta = fitResponse(rowsOver(train, trainDrift));
    const std::vector<ResponseRow> testRows = rowsOver(test, trainDrift);
    const std::vector<double> drift = driftOver(days);
    const std::vector<ResponseRow> rows = rowsOver(days, drift);
    if (rows.size() < size_t(kOwnMinRows) || testRows.size() < 30)
        throw util::JsError(u"自己攒的样本只凑得出 %1 个窗口,不够(至少 %2 个)"_s.arg(rows.size()).arg(kOwnMinRows));
    const Response response = fitResponse(rows);
    double scaledSum = 0;
    for (const ResponseRow& row : rows) scaledSum += jm::pow(row.y - predict(response, row.u), 2) / row.share;
    const double residK = std::sqrt(scaledSum / double(rows.size()));
    const ResidMove residMove = residualByMove(rows, response, residK);
    double covered = 0;
    for (const ResponseRow& row : rows)
        if (std::abs(row.y - predict(response, row.u)) <= kQuartile * residualSd(residK, residMove, row.share, row.u)) covered += 1;
    OwnFit f;
    f.periodFrom = days.front().date;
    f.periodTo = days.back().date;
    f.days = double(days.size());
    f.rows = double(rows.size());
    f.response = {roundTo(response.a, 4), roundTo(response.b, 4), roundTo(response.c, 4)};
    for (double v : drift) f.drift.push_back(roundTo(v, 4));
    f.resid_k = roundTo(residK, 3);
    f.resid_move = {roundTo(residMove.base, 3), roundTo(residMove.slope, 3)};
    f.r2_in = roundTo(rSquared(rows, response), 3);
    f.r2_out = roundTo(rSquared(testRows, trainBeta), 3);
    f.r2_out_index = roundTo(rSquared(testRows, indexResponse), 3);
    f.coverage_half = roundTo(covered / double(rows.size()), 3);
    return f;
}

bool ownIsBetter(const OwnFit& own) { return own.r2_out > 0.1 && own.r2_out >= own.r2_out_index; }

double ownDriftAt(const std::vector<double>& drift, double minute) {
    const double x = (minute - kOwnGridStart) / 30;
    if (x <= 0) return drift.empty() ? 0 : drift[0];
    const double last = double(drift.size()) - 1;
    if (x >= last) return drift.empty() ? 0 : drift.back();
    if (std::isnan(x)) return kNaN;
    const size_t i = size_t(std::floor(x));
    return drift[i] + (drift[i + 1] - drift[i]) * (x - double(i));
}

// ================================================================ ivPricing.ts
std::optional<double> expiryEpochMs(const QString& symbol, const QString& expiry, const QString& tradingClass, bool earlyClose) {
    static const QRegularExpression re(u"^([0-9]{4})([0-9]{2})([0-9]{2})(?![0-9])"_s);
    // JS 的 \s:除了 ASCII 空白,还有 U+00A0、U+FEFF、Unicode 的 Zs 类与行分隔符
    static const QRegularExpression withTime(
        u"^[0-9]{8}[\\t\\n\\x{0B}\\f\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}]+[0-9]{1,2}:[0-9]{2}"_s);
    const QString e = util::jsTrim(expiry);
    const auto m = re.match(e);
    if (!m.hasMatch()) return std::nullopt;
    const QString sym = symbol.toUpper(), tc = tradingClass.toUpper();
    double dayMs = util::dateUtc(m.captured(1).toDouble(), m.captured(2).toDouble() - 1, m.captured(3).toDouble());
    const auto weekday = [](double ms) { return QDateTime::fromMSecsSinceEpoch(qint64(ms), QTimeZone::UTC).date().dayOfWeek() % 7; };  // 0 = 周日
    double hour = earlyClose ? 13 : 16, minute = 0;
    if (sym == u"SPX" || sym == u"NDX" || sym == u"RUT") {
        if (tc.isEmpty()) return std::nullopt;
        if (tc == sym) {
            hour = 9;
            minute = 30;
            const bool settlesThatDay = withTime.match(e).hasMatch() || weekday(dayMs) == 5;
            if (!settlesThatDay) {
                do dayMs += 86'400'000;
                while (weekday(dayMs) == 0 || weekday(dayMs) == 6);
            }
        }
    }
    const QDate d = QDateTime::fromMSecsSinceEpoch(qint64(dayMs), QTimeZone::UTC).date();
    util::WallParts w;
    w.year = d.year();
    w.month = d.month();
    w.day = d.day();
    w.hour = hour;
    w.minute = minute;
    w.second = 0;
    return util::wallToEpoch(w, et());
}

OJson ibkrLegSigmas(const std::vector<PricedLeg>& legs, double spot, const OJson& legIvs, std::optional<double> expiryMs, double nowMs,
                    const std::function<QString(const PricedLeg&)>& keyOf) {
    if (legs.empty() || !(spot > 0) || !expiryMs || !std::isfinite(nowMs)) return OJson::null();
    constexpr double kYearMs = 365.0 * 24 * 3600 * 1000;
    const double years = jm::max(0, *expiryMs - nowMs) / kYearMs;
    OJson out = js::object();
    for (const PricedLeg& leg : legs) {
        const QString key = keyOf(leg);
        const double iv = js::num(js::prop(&legIvs, key));
        if (!std::isfinite(iv) || iv <= 0) return OJson::null();
        out.set(key, js::N(spot * iv * std::sqrt(years)));
    }
    return out;
}

OJson legInputsOf(const OJson& raw, const OJson& positions, const std::function<QString(const PricedLeg&)>& keyOf,
                  const std::function<bool(const QString&)>& isEarlyClose) {
    OJson legPrices = js::object(), legIvs = js::object();
    std::optional<double> expiryMs;
    const QString secType = js::strOr(js::prop(&raw, u"sec_type"_s), QString());
    QList<const OJson*> legRows;
    if (secType == u"OPT" || secType == u"FOP") legRows << &raw;
    else if (const OJson* keys = js::prop(&raw, u"legs"_s); js::nullish(keys) || js::isArr(keys)) {
        if (keys && keys->type == OJson::Array)
            for (const OJson& k : keys->items)
                // positions[k]:键是 String(k);原型上的那几个(constructor…)也是"有",但它们没有 contract,下面照样跳过
                if (const OJson* r = js::prop(&positions, js::str(&k))) legRows << r;
    } else {
        throw util::JsError(u"(raw.legs ?? []).map is not a function"_s);
    }
    bool haveExpiry = false;
    for (const OJson* leg : legRows) {
        static const OJson empty = js::object();
        const OJson* contract = js::propStrict(leg, u"contract"_s);
        const OJson* c = js::nullish(contract) ? &empty : contract;
        const double strike = js::num(js::prop(c, u"strike"_s));
        const QString right = js::strOr(js::prop(c, u"right"_s), QString()).left(1).toUpper();  // 「ß」→「SS」:Qt 与 JS 同是完整的大写映射
        if (!std::isfinite(strike) || right.isEmpty()) continue;
        const QString key = keyOf({strike, right});
        const OJson* price = js::prop(leg, u"market_price"_s);
        const OJson* iv = js::prop(leg, u"model_iv"_s);
        legPrices.set(key, js::nullish(price) ? js::Null() : *price);
        legIvs.set(key, js::nullish(iv) ? js::Null() : *iv);
        if (!haveExpiry) {
            const QString ymd = util::jsTrim(js::strOr(js::prop(c, u"lastTradeDateOrContractMonth"_s), QString())).left(8);
            const OJson* symRaw = js::prop(&raw, u"symbol"_s);
            const QString symbol = js::nullish(symRaw) ? js::strOr(js::prop(c, u"symbol"_s), QString()) : js::str(symRaw);
            const bool early = isEarlyClose ? isEarlyClose(ymd.left(4) + u'-' + ymd.mid(4, 2) + u'-' + ymd.mid(6, 2)) : false;
            expiryMs = expiryEpochMs(symbol, js::strOr(js::prop(c, u"lastTradeDateOrContractMonth"_s), QString()), js::strOr(js::prop(c, u"tradingClass"_s), QString()), early);
            haveExpiry = expiryMs.has_value();
        }
    }
    return js::object({{u"legPrices"_s, legPrices}, {u"legIvs"_s, legIvs}, {u"expiryMs"_s, js::NOrNull(expiryMs)}});
}

}  // namespace ibkr::analysis
