#include "analysis/anomaly.h"

#include "analysis/fly_model.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/market_js.h"
#include "util/py.h"

#include <QStringList>

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;

namespace ibkr::analysis::anomaly {

namespace {
constexpr double kMaxTiers = 5;
constexpr double kSessionPaceMinMinute = 30;  // 没有均量时按当日节奏估窗口常态,至少要开盘 30 分钟
constexpr double kWindowStaleMs = 90'000;     // 窗口起点样本最多比理想时刻早 90 秒
constexpr double kSampleKeepMs = 20 * 60'000;
constexpr double kEps = 1e-9;  // 阈值比较的浮点余量:正好 3.0 倍不能因为 2.9999999999999996 漏报

QString n2s(double v) { return util::jsNumberToString(v); }
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }

/// 界面传来的数:数字或数字串都认;布尔、空串、NaN 一律不认
std::optional<double> numberOf(const OJson* v) {
    if (js::isNum(v)) return std::isfinite(v->n) ? std::optional(v->n) : std::nullopt;
    if (js::isStr(v) && !util::jsTrim(v->s).isEmpty()) {
        const double n = util::jsStringToNumber(v->s);
        return std::isfinite(n) ? std::optional(n) : std::nullopt;
    }
    return std::nullopt;
}

double scalarField(const OJson& raw, const QString& key, double fallback, double lo, double hi, const QString& what, const QString& range) {
    const OJson* value = raw.get(key);
    if (js::nullish(value)) return fallback;
    const auto n = numberOf(value);
    if (!n || *n < lo || *n > hi) throw AnomalyError(u"%1要在 %2 之间(收到 %3)"_s.arg(what, range, util::market::shown(*value)));
    return util::pyRound(*n, 4);
}

std::vector<double> tiersField(const OJson& raw, const QString& key, const std::vector<double>& fallback, double lo, double hi, const QString& what,
                               const QString& range) {
    const OJson* value = raw.get(key);
    if (js::nullish(value)) return fallback;
    const QString why = u"%1要 1~%2 个、每个在 %3 之间(收到 %4)"_s.arg(what, n2s(kMaxTiers), range, util::market::shown(*value));
    if (!js::isArr(value) || value->items.isEmpty()) throw AnomalyError(why);
    std::vector<double> out;
    for (const OJson& item : value->items) {
        const auto n = numberOf(&item);
        if (!n || *n < lo || *n > hi) throw AnomalyError(why);
        const double r = util::pyRound(*n, 4);
        if (std::find(out.begin(), out.end(), r) == out.end()) out.push_back(r);
    }
    // 档序号按升序解释,乱序传进来先排好
    util::market::sortNumbers(out);
    if (double(out.size()) > kMaxTiers) throw AnomalyError(why);
    return out;
}

OJson numbers(const std::vector<double>& v) {
    OJson a = js::array();
    for (double x : v) a.items.append(js::N(x));
    return a;
}

std::optional<double> finiteNum(const std::optional<double>& v) { return v && std::isfinite(*v) ? v : std::nullopt; }
std::optional<double> positive(const std::optional<double>& v) { return v && std::isfinite(*v) && *v > 0 ? v : std::nullopt; }
double sessionOf(const std::optional<double>& s) { return s && std::isfinite(*s) && *s > 0 ? *s : kRthMinutes; }

const std::vector<double>& slotCum() {
    // 原表四舍五入到 5 位小数,和是 1.00004;按和归一,收盘那一刻正好是 1
    static const std::vector<double> c = [] {
        double total = 0;
        for (double f : slotFractions()) total = total + f;
        std::vector<double> out{0};
        double acc = 0;
        for (double f : slotFractions()) {
            acc += f;
            out.push_back(acc / total);
        }
        out.back() = 1;
        return out;
    }();
    return c;
}
double slotTotal() {
    static const double t = [] {
        double total = 0;
        for (double f : slotFractions()) total = total + f;
        return total;
    }();
    return t;
}
}  // namespace

OJson Config::toJson() const {
    return js::object({{u"rvol_tiers"_s, numbers(rvol_tiers)},
                       {u"burst_ratio"_s, js::N(burst_ratio)},
                       {u"window_min"_s, js::N(window_min)},
                       {u"spike_sigma"_s, js::N(spike_sigma)},
                       {u"spike_min_pct"_s, js::N(spike_min_pct)},
                       {u"spike_fixed_pct"_s, js::N(spike_fixed_pct)},
                       {u"day_sigma_tiers"_s, numbers(day_sigma_tiers)},
                       {u"day_fixed_tiers"_s, numbers(day_fixed_tiers)},
                       {u"cooldown_min"_s, js::N(cooldown_min)},
                       {u"market_adjust"_s, js::B(market_adjust)}});
}

const Config& defaultConfig() {
    static const Config c{{2, 3, 5}, 4, 5, 4, 1.0, 1.5, {2, 3, 4}, {3, 5, 8}, 10, false};
    return c;
}

Config normalizeAnomalyConfig(const OJson* raw, const Config& base) {
    Config out = base;
    if (js::nullish(raw)) return out;
    if (!js::isObj(raw)) throw AnomalyError(u"触发条件的格式不对,应是一组键值"_s);

    out.rvol_tiers = tiersField(*raw, u"rvol_tiers"_s, out.rvol_tiers, 1.2, 50, u"全天量比档位"_s, u"1.2~50 倍"_s);
    out.burst_ratio = scalarField(*raw, u"burst_ratio"_s, out.burst_ratio, 1.5, 50, u"窗口量比阈值"_s, u"1.5~50 倍"_s);
    const OJson* window = raw->get(u"window_min"_s);
    if (!js::nullish(window)) {
        const auto n = numberOf(window);
        if (!n || !(*n == 3 || *n == 5 || *n == 10)) throw AnomalyError(u"窗口只能是 3 / 5 / 10 分钟(收到 %1)"_s.arg(util::market::shown(*window)));
        out.window_min = *n;
    }
    out.spike_sigma = scalarField(*raw, u"spike_sigma"_s, out.spike_sigma, 1.5, 20, u"急涨急跌的 σ 倍数"_s, u"1.5~20"_s);
    out.spike_min_pct = scalarField(*raw, u"spike_min_pct"_s, out.spike_min_pct, 0.1, 20, u"急涨急跌的最低幅度"_s, u"0.1%~20%"_s);
    out.spike_fixed_pct = scalarField(*raw, u"spike_fixed_pct"_s, out.spike_fixed_pct, 0.2, 30, u"无历史波动率时的急涨急跌阈值"_s, u"0.2%~30%"_s);
    out.day_sigma_tiers = tiersField(*raw, u"day_sigma_tiers"_s, out.day_sigma_tiers, 0.5, 20, u"大涨大跌的 σ 档位"_s, u"0.5~20"_s);
    out.day_fixed_tiers = tiersField(*raw, u"day_fixed_tiers"_s, out.day_fixed_tiers, 0.5, 50, u"无历史波动率时的大涨大跌档位"_s, u"0.5%~50%"_s);
    out.cooldown_min = scalarField(*raw, u"cooldown_min"_s, out.cooldown_min, 1, 240, u"冷却时间"_s, u"1~240 分钟"_s);
    const OJson* adjust = raw->get(u"market_adjust"_s);
    if (!js::nullish(adjust)) {
        if (!js::isBool(adjust)) throw AnomalyError(u"「扣掉大盘」的开关要是 true / false(收到 %1)"_s.arg(util::market::shown(*adjust)));
        out.market_adjust = adjust->b;
    }
    return out;
}

// ---------------------------------------------------------------- 日内成交量曲线
const std::vector<double>& slotFractions() {
    // 美股常规时段每 5 分钟的成交量占比(24 只大盘 / 高波动股 × 20 日,IB 5 分钟线);第 0 格含开盘竞价,最后一格含收盘竞价
    static const std::vector<double> f{
        0.06609, 0.0305,  0.02611, 0.02475, 0.02228, 0.01943, 0.02086, 0.018,   0.01844, 0.01797, 0.01673, 0.01528, 0.01538, 0.01421, 0.01311,
        0.01361, 0.01279, 0.01313, 0.01381, 0.01259, 0.01186, 0.01146, 0.01123, 0.01145, 0.01111, 0.01054, 0.00978, 0.00996, 0.01019, 0.00907,
        0.00969, 0.0089,  0.00848, 0.00862, 0.00845, 0.00827, 0.00847, 0.00769, 0.00764, 0.00777, 0.00738, 0.0075,  0.00787, 0.00751, 0.00702,
        0.00713, 0.00723, 0.00691, 0.00747, 0.00719, 0.00689, 0.0069,  0.00689, 0.00695, 0.00828, 0.00798, 0.00736, 0.00749, 0.00729, 0.00709,
        0.00793, 0.00772, 0.00758, 0.00877, 0.00844, 0.00802, 0.00934, 0.00903, 0.00924, 0.00983, 0.00986, 0.01032, 0.01253, 0.01187, 0.01316,
        0.01577, 0.0259,  0.0727,
    };
    return f;
}

double cumVolumeFraction(double minute, std::optional<double> sessionMinutes) {
    const double session = sessionOf(sessionMinutes);
    if (!(minute > 0)) return 0;  // 连 NaN 一起挡掉
    if (minute >= session) return 1;
    const double m = (minute * kRthMinutes) / session;
    const double slot = jm::min(double(slotFractions().size()) - 1, std::floor(m / 5));
    const double within = (m - slot * 5) / 5;
    return slotCum()[size_t(slot)] + (slotFractions()[size_t(slot)] / slotTotal()) * within;
}

// ---------------------------------------------------------------- 日内方差曲线
double varianceShare(double fromMinute, double toMinute) {
    const std::vector<double>& weights = flyIvModel().variance_weights;
    const double share = remainingShare(weights, kOpenMinute + fromMinute) - remainingShare(weights, kOpenMinute + toMinute);
    return share > 0 ? share : 0;  // 连 NaN 一起挡掉
}

// ---------------------------------------------------------------- 快照与样本
OJson Sample::toJson() const { return js::object({{u"t"_s, js::N(t)}, {u"volume"_s, optN(volume)}, {u"last"_s, optN(last)}}); }

std::vector<Sample> pushSample(const std::vector<Sample>& samples, const std::optional<Sample>& s, std::optional<double> keepMs) {
    std::vector<Sample> list;
    for (const Sample& x : samples)
        if (std::isfinite(x.t)) list.push_back(x);
    if (!s || !std::isfinite(s->t)) return list;
    const Sample sample{s->t, finiteNum(s->volume), finiteNum(s->last)};
    std::vector<Sample> out;
    for (const Sample& x : list)
        if (x.t != sample.t) out.push_back(x);
    out.push_back(sample);
    util::market::jsSort(out, [](const Sample& a, const Sample& b) { return a.t - b.t; });
    const double keep = keepMs && std::isfinite(*keepMs) && *keepMs >= 0 ? *keepMs : kSampleKeepMs;
    const double newest = out.back().t;
    std::vector<Sample> kept;
    for (const Sample& x : out)
        if (x.t >= newest - keep) kept.push_back(x);
    return kept;
}

// ---------------------------------------------------------------- 状态
OJson State::toJson() const {
    const auto arm = [](const SignalArm& a) { return js::object({{u"armed"_s, js::B(a.armed)}, {u"last_fired_at"_s, optN(a.last_fired_at)}}); };
    return js::object({{u"date"_s, js::S(date)},
                       {u"rvol_fired"_s, js::N(rvol_fired)},
                       {u"day_up_fired"_s, js::N(day_up_fired)},
                       {u"day_down_fired"_s, js::N(day_down_fired)},
                       {u"max_step_share"_s, js::N(max_step_share)},
                       {u"burst"_s, arm(burst)},
                       {u"spike"_s, arm(spike)}});
}

State freshState(const QString& date) {
    State s;
    s.date = date;
    return s;
}

namespace {
SignalArm coerceArm(const OJson* raw) {
    if (!js::isObj(raw)) return {true, std::nullopt};
    const OJson* armed = raw->get(u"armed"_s);
    const OJson* last = raw->get(u"last_fired_at"_s);
    return {js::isBool(armed) ? armed->b : true, js::isNum(last) && std::isfinite(last->n) ? std::optional(last->n) : std::nullopt};
}
double nonNegative(const OJson* v) { return js::isNum(v) && std::isfinite(v->n) && v->n > 0 ? v->n : 0; }
}  // namespace

State coerceState(const OJson* raw, const QString& date) {
    std::optional<OJson> parsed;
    const OJson* obj = raw;
    if (js::isStr(raw)) {
        parsed = js::parse(raw->s);
        obj = parsed ? &*parsed : nullptr;
    }
    if (!js::isObj(obj)) return freshState(date);
    const OJson* d = obj->get(u"date"_s);
    State s;
    s.date = js::isStr(d) && !d->s.isEmpty() ? d->s : date;
    s.rvol_fired = nonNegative(obj->get(u"rvol_fired"_s));
    s.day_up_fired = std::floor(nonNegative(obj->get(u"day_up_fired"_s)));
    s.day_down_fired = std::floor(nonNegative(obj->get(u"day_down_fired"_s)));
    s.max_step_share = nonNegative(obj->get(u"max_step_share"_s));
    s.burst = coerceArm(obj->get(u"burst"_s));
    s.spike = coerceArm(obj->get(u"spike"_s));
    return s;
}

// ---------------------------------------------------------------- 判定
namespace {
std::optional<double> streamWindowVolume(const VolumeSnapshot& snap, double windowMin) {
    const std::optional<double> v = windowMin == 3 ? snap.vol_3m : windowMin == 5 ? snap.vol_5m : windowMin == 10 ? snap.vol_10m : std::nullopt;
    const auto n = finiteNum(v);
    return n && *n >= 0 ? n : std::nullopt;
}

/// 窗口起点:t ≤ now − W 的最新一条,且不能比理想时刻早 90 秒以上
const Sample* windowAnchor(const std::vector<Sample>& samples, double nowMs, double windowMin) {
    const double target = nowMs - windowMin * 60'000;
    const Sample* best = nullptr;
    for (const Sample& s : samples) {
        if (!std::isfinite(s.t) || s.t > target) continue;
        if (!best || s.t > best->t) best = &s;
    }
    return best && best->t >= target - kWindowStaleMs ? best : nullptr;
}

double moveSize(double own, std::optional<double> market, bool adjust) {
    if (!adjust || !market) return std::fabs(own);
    const double rel = own - *market;
    return rel * own <= 0 ? 0 : jm::min(std::fabs(own), std::fabs(rel));
}

const QString kMinus = QString(QChar(0x2212));  // U+2212,和标题示例同一个减号
QString signedPct(double x, int nd) {
    const QString s = util::fmtSF(x, nd);
    return s.startsWith(u'-') ? kMinus + s.mid(1) : s;
}
QString times(double x) { return util::fmtF(x, 1); }
QString strip(double x, int nd) {
    QString s = util::fmtF(x, nd);
    qsizetype end = s.size();
    while (end > 0 && s[end - 1] == u'0') --end;
    s.truncate(end);
    if (s.endsWith(u'.')) s.chop(1);
    return s;
}
QString priceText(const std::optional<double>& x) { return x ? strip(*x, 4) : u"—"_s; }

QString marketNote(double own, std::optional<double> market, double size, bool adjust) {
    if (!market) return adjust ? u",无大盘参照、未扣"_s : QString();
    const QString net = size < std::fabs(own) - kEps ? u"、扣掉后 %1%"_s.arg(signedPct(own - *market, 2)) : QString();
    return u",标普同期 %1%%2"_s.arg(signedPct(*market, 2), net);
}

QString gapNote(const std::optional<double>& open, const std::optional<double>& close, double changePct, double threshold) {
    const std::optional<double> gapPct = open && close ? std::optional((*open / *close - 1) * 100) : std::nullopt;
    return gapPct && *gapPct * changePct > 0 && std::fabs(*gapPct) >= threshold - kEps ? u"(开盘跳空 %1%)"_s.arg(signedPct(*gapPct, 2)) : QString();
}

struct Steps {
    double steps = 0, largest = 0;
};
/// 窗口(起点之后到此刻)里相邻样本之间的增量:一共几步、最大的一步多大
Steps windowSteps(const std::vector<Sample>& samples, double fromT, double nowMs) {
    std::vector<Sample> inWindow;
    for (const Sample& s : samples)
        if (std::isfinite(s.t) && s.t >= fromT && s.t <= nowMs && finiteNum(s.volume)) inWindow.push_back(s);
    util::market::jsSort(inWindow, [](const Sample& a, const Sample& b) { return a.t - b.t; });
    Steps r;
    for (size_t i = 1; i < inWindow.size(); i += 1) {
        const double d = *inWindow[i].volume - *inWindow[i - 1].volume;
        if (d < 0) continue;  // 流重订 / 口径跳变,这一步不算
        r.steps += 1;
        if (d > r.largest) r.largest = d;
    }
    return r;
}

/// 最近这一步的量增(当前当日量 − 上一条样本的当日量)。负数(流重订)与缺数一律不算
std::optional<double> latestStep(const std::vector<Sample>& samples, const std::optional<double>& volume) {
    if (!volume) return std::nullopt;
    std::vector<Sample> list;
    for (const Sample& s : samples)
        if (std::isfinite(s.t) && finiteNum(s.volume)) list.push_back(s);
    if (list.size() < 2) return std::nullopt;
    util::market::jsSort(list, [](const Sample& a, const Sample& b) { return a.t - b.t; });
    const double d = *volume - *list[list.size() - 2].volume;
    return d >= 0 ? std::optional(d) : std::nullopt;
}

bool cooled(const SignalArm& arm, double nowS, double cooldownMin) { return !arm.last_fired_at || nowS - *arm.last_fired_at >= cooldownMin * 60; }

/// 满足 x ≥ 阈值的最高档序号(1 起,0 = 一档都不到)
double highestTier(const std::vector<double>& thresholds, double x) {
    double best = 0;
    for (size_t i = 0; i < thresholds.size(); ++i)
        if (x >= thresholds[i] - kEps) best = jm::max(best, double(i) + 1);
    return best;
}

std::optional<double> r4(const std::optional<double>& x) { return x ? std::optional(util::pyRound(*x, 4)) : std::nullopt; }
OJson directionOf(const std::optional<double>& x) {
    if (!x) return OJson::null();
    return *x > 0 ? js::S(u"up"_s) : *x < 0 ? js::S(u"down"_s) : OJson::null();
}
}  // namespace

std::optional<double> windowReturnPct(const std::vector<Sample>& samples, double nowMs, double windowMin) {
    const Sample* s0 = windowAnchor(samples, nowMs, windowMin);
    const auto from = s0 ? positive(s0->last) : std::nullopt;
    std::optional<double> last;
    for (const Sample& s : samples)
        if (s.t == nowMs) last = positive(s.last);
    return from && last ? std::optional((*last / *from - 1) * 100) : std::nullopt;
}

OJson evaluateAnomalies(const EvalArgs& args) {
    const Config& cfg = args.config;
    const QString& symbol = args.symbol;
    const VolumeSnapshot snap = args.snap.value_or(VolumeSnapshot{});
    const double nowMs = args.nowMs;
    const double nowS = util::jsRound(nowMs / 1000);
    const double session = sessionOf(args.sessionMinutes);
    const double scale = session / kRthMinutes;  // 半日市:以 390 为基准的时刻常数按比例压缩
    const std::optional<double> minute = std::isfinite(args.minute) ? std::optional(args.minute) : std::nullopt;
    const double W = cfg.window_min;

    // 换日即重置:档位按天报,滞回也不该隔夜带着
    std::optional<State> prev;
    if (!js::nullish(args.state)) prev = coerceState(args.state, args.etDate);
    State state = prev && prev->date == args.etDate ? *prev : freshState(args.etDate);

    const auto last = positive(snap.last);
    const auto close = positive(snap.close);
    const auto volume = positive(snap.volume);
    const auto avgVolume = positive(snap.avg_volume);
    // 年化、小数(0.32 = 32%):单位写死在 VolumeSnapshot 上,这里不猜
    const auto histVol = positive(snap.hist_vol);
    const std::optional<double> changePct = last && close ? std::optional((*last / *close - 1) * 100) : std::nullopt;

    const bool suppress = args.suppress;
    const bool inSession = !suppress && minute && *minute >= 0 && *minute < session;
    const double volumeEnd = kVolumeEndMinute * scale;
    // 开盘那几道闸不跟着半日市压缩
    const double rvolMin = kRvolMinMinute;

    // ---- 全天量比:分母是"90 日日均量 × 到此刻为止常态该走完的比例"
    std::optional<double> rvol;
    if (avgVolume && volume && minute && *minute >= rvolMin) {
        const double share = cumVolumeFraction(*minute, session);
        if (share > 0) rvol = *volume / (*avgVolume * share);
    }

    // 当天最大一步:样本里最近这一步与状态里记着的比一比
    const auto lastStep = latestStep(args.samples, volume);
    if (!suppress && lastStep && avgVolume) {
        const double share = *lastStep / *avgVolume;
        if (share > state.max_step_share) state.max_step_share = util::pyRound(share, 6);
    }
    // 去掉那一笔大宗之后的全天量比
    const double cumNow = minute ? cumVolumeFraction(*minute, session) : 0;
    const std::optional<double> rvolExBlock = rvol && state.max_step_share > 0 && cumNow > 0 ? std::optional(*rvol - state.max_step_share / cumNow) : rvol;

    // ---- 窗口:量优先用自己的样本差,没有才退回流里的近 W 分钟量
    const Sample* s0 = windowAnchor(args.samples, nowMs, W);
    const bool windowReady = s0 != nullptr;
    std::optional<double> windowVolume, spanMin;
    bool fromSamples = false;  // 只有样本算出来的窗口才判得了"是不是一笔大单"
    if (s0 && volume) {
        const auto base = finiteNum(s0->volume);
        if (base && *volume - *base >= 0) {  // 负数只可能是流重订 / 口径跳变,当它无效
            windowVolume = *volume - *base;
            spanMin = (nowMs - s0->t) / 60'000;
            fromSamples = true;
        }
    }
    if (!windowVolume) {
        if (const auto streamed = streamWindowVolume(snap, W)) {
            windowVolume = streamed;
            spanMin = W;
        }
    }

    std::optional<double> burst, windowNormal;
    QString basisVolume;  // 空 = null
    if (windowVolume && spanMin && minute) {
        const double share = cumVolumeFraction(*minute, session) - cumVolumeFraction(*minute - *spanMin, session);
        std::optional<double> normal;
        QString basis;
        if (avgVolume) {
            normal = *avgVolume * share;
            basis = u"avg_volume"_s;
        } else if (*minute >= kSessionPaceMinMinute * scale && volume) {
            // 没有均量:按今天到此刻的节奏推一个全天量。放量本身会抬高节奏,只会少报不会多报
            const double soFar = cumVolumeFraction(*minute, session);
            if (soFar > 0) {
                normal = (*volume / soFar) * share;
                basis = u"session_pace"_s;
            }
        }
        if (normal && *normal > 0) {
            burst = *windowVolume / *normal;
            basisVolume = basis;
            windowNormal = normal;
        }
    }
    // 大单占比 = 窗口里最大一步 / 窗口量;"去掉最大一步还剩几倍"才是报不报的依据
    std::optional<Steps> stepInfo;
    if (fromSamples && s0) stepInfo = windowSteps(args.samples, s0->t, nowMs);
    const std::optional<double> blockShare = stepInfo && windowVolume && *windowVolume > 0 ? std::optional(stepInfo->largest / *windowVolume) : std::nullopt;
    const std::optional<double> sustained =
        stepInfo && stepInfo->steps >= kMinBurstSteps && windowNormal && windowVolume ? std::optional((*windowVolume - stepInfo->largest) / *windowNormal) : std::nullopt;

    // 涨跌幅只能用自己的样本:流里没有"W 分钟前的价"
    const auto s0Last = s0 ? positive(s0->last) : std::nullopt;
    const std::optional<double> retPct = s0Last && last ? std::optional((*last / *s0Last - 1) * 100) : std::nullopt;
    const double retSpan = s0 ? (nowMs - s0->t) / 60'000 : W;
    // 日 σ:30 日收盘对收盘的历史波动率折到一天;窗口 σ:日 σ × √(这一段占常规时段方差的几成)
    const std::optional<double> sigmaDayPct = histVol ? std::optional((*histVol / std::sqrt(252.0)) * 100) : std::nullopt;
    const double windowShare = minute ? varianceShare(*minute - retSpan, *minute) : 0;
    const std::optional<double> sigmaWindowPct = sigmaDayPct && windowShare > 0 ? std::optional(*sigmaDayPct * std::sqrt(windowShare)) : std::nullopt;
    const QString basisSigma = histVol ? u"hist_vol"_s : u"fixed"_s;

    const auto marketWindow = args.market ? finiteNum(args.market->ret_window_pct) : std::nullopt;
    const auto marketDay = args.market ? finiteNum(args.market->change_pct) : std::nullopt;

    QList<OJson> events;
    const auto addEvent = [&](const QString& kind, const OJson& direction, double value, double threshold, const std::optional<double>& tier,
                          const std::optional<double>& sigma, const QString& basis, const QString& title, const QString& text) {
        const QString dir = direction.type == OJson::String ? direction.s : u"-"_s;
        events.append(js::object({{u"id"_s, js::S(u"%1:%2:%3:%4:%5"_s.arg(symbol, kind, dir, tier ? n2s(*tier) : u"-"_s, n2s(nowS)))},
                                  {u"at"_s, js::N(nowS)},
                                  {u"symbol"_s, js::S(symbol)},
                                  {u"kind"_s, js::S(kind)},
                                  {u"direction"_s, direction},
                                  {u"value"_s, js::N(value)},
                                  {u"threshold"_s, js::N(threshold)},
                                  {u"tier"_s, optN(tier)},
                                  {u"sigma"_s, optN(sigma)},
                                  {u"price"_s, optN(last)},
                                  {u"change_pct"_s, optN(r4(changePct))},
                                  {u"basis"_s, js::S(basis)},
                                  {u"title"_s, js::S(title)},
                                  {u"text"_s, js::S(text)}}));
    };
    const QString w = n2s(W);

    // ---- rvol:一次跨多档只报最高那档,档位按倍数值记
    if (rvol && inSession && *minute >= rvolMin && *minute < volumeEnd) {
        std::optional<double> tier;
        for (double t : cfg.rvol_tiers) {
            // 两个口径都得够:含大单的量比 rvol、去掉当天最大一步的 rvolExBlock
            if (*rvol >= t - kEps && rvolExBlock.value_or(*rvol) >= t - kEps && t > state.rvol_fired && (!tier || t > *tier)) tier = t;
        }
        if (tier) {
            state.rvol_fired = *tier;
            const QString chg = changePct ? u"(%1%)"_s.arg(signedPct(*changePct, 2)) : QString();
            addEvent(u"rvol"_s, directionOf(changePct), *r4(rvol), *tier, tier, std::nullopt, u"avg_volume"_s, u"%1 放量 %2×"_s.arg(symbol, times(*rvol)),
                 u"当日成交量已达同时段常态的 %1×(第 %2× 档),现价 %3%4"_s.arg(times(*rvol), strip(*tier, 4), priceText(last), chg));
        }
    }

    // ---- burst:窗口起点得在开盘竞价那一笔之后;滞回 + 冷却;去掉最大一步还够倍数才报
    if (burst && inSession && *minute - W >= 1 && *minute < volumeEnd) {
        const SignalArm arm = state.burst;
        if (!arm.armed && *burst < cfg.burst_ratio / 2 && cooled(arm, nowS, cfg.cooldown_min)) state.burst = {true, arm.last_fired_at};
        if (state.burst.armed && *burst >= cfg.burst_ratio - kEps && sustained && *sustained >= cfg.burst_ratio - kEps) {
            state.burst = {false, nowS};
            const QString ret = retPct ? u",%1 分钟 %2%"_s.arg(w, signedPct(*retPct, 2)) : QString();
            const QString pace = basisVolume == u"session_pace" ? u"(无均量数据,按当日节奏估)"_s : QString();
            addEvent(u"burst"_s, directionOf(retPct), *r4(burst), cfg.burst_ratio, std::nullopt, std::nullopt, basisVolume,
                 u"%1 %2分钟放量 %3×"_s.arg(symbol, w, times(*burst)),
                 u"近 %1 分钟成交量是同时段常态的 %2×%3,现价 %4%5"_s.arg(w, times(*burst), ret, priceText(last), pace));
        }
    }

    // ---- spike:阈值 = max(k × 窗口 σ, 最低幅度);没有历史波动率就用固定 %。价格信号不受 15:55 限制
    const double spikeThreshold = sigmaWindowPct ? jm::max(cfg.spike_sigma * *sigmaWindowPct, cfg.spike_min_pct) : cfg.spike_fixed_pct;
    if (retPct && inSession && *minute >= kSpikeMinMinute) {
        const double size = moveSize(*retPct, marketWindow, cfg.market_adjust);
        const SignalArm arm = state.spike;
        if (!arm.armed && size < spikeThreshold / 2 && cooled(arm, nowS, cfg.cooldown_min)) state.spike = {true, arm.last_fired_at};
        if (state.spike.armed && size >= spikeThreshold - kEps) {
            state.spike = {false, nowS};
            const bool up = *retPct > 0;
            const QString thr = strip(spikeThreshold, 2);
            const QString how = sigmaWindowPct ? u",约 %1σ(阈值 %2%)"_s.arg(times(size / *sigmaWindowPct), thr) : u"(无历史波动率,按固定 %1%)"_s.arg(thr);
            addEvent(u"spike"_s, js::S(up ? u"up"_s : u"down"_s), *r4(retPct), *r4(spikeThreshold), std::nullopt,
                 sigmaWindowPct ? r4(size / *sigmaWindowPct) : std::nullopt, basisSigma,
                 u"%1 %2分钟%3 %4%"_s.arg(symbol, w, up ? u"急涨"_s : u"急跌"_s, signedPct(*retPct, 1)),
                 u"%1 分钟 %2%%3%4,现价 %5"_s.arg(w, signedPct(*retPct, 2), marketNote(*retPct, marketWindow, size, cfg.market_adjust), how, priceText(last)));
        }
    }

    // ---- day_move:开出来之后任意时刻都判;上下各记各的档序号,跳空值得报一次,也只报一次
    if (changePct && inSession && args.opened != false) {
        std::vector<double> thresholds;
        if (sigmaDayPct) {
            for (double k : cfg.day_sigma_tiers) thresholds.push_back(k * *sigmaDayPct);
        } else {
            thresholds = cfg.day_fixed_tiers;
        }
        const double size = moveSize(*changePct, marketDay, cfg.market_adjust);
        const double tier = highestTier(thresholds, size);
        const bool up = *changePct > 0;
        const double fired = up ? state.day_up_fired : state.day_down_fired;
        if (*changePct != 0 && tier > fired) {
            (up ? state.day_up_fired : state.day_down_fired) = tier;
            const double threshold = thresholds[size_t(tier) - 1];
            const QString thr = strip(threshold, 2);
            const QString how = sigmaDayPct ? u",约 %1σ(第 %2 档,阈值 %3%)"_s.arg(times(size / *sigmaDayPct), n2s(tier), thr)
                                            : u"(第 %1 档,阈值 %2%)"_s.arg(n2s(tier), thr);
            const QString gap = gapNote(positive(snap.open), close, *changePct, threshold);
            addEvent(u"day_move"_s, js::S(up ? u"up"_s : u"down"_s), *r4(changePct), *r4(threshold), tier, sigmaDayPct ? r4(size / *sigmaDayPct) : std::nullopt,
                 basisSigma, u"%1 %2 %3%"_s.arg(symbol, up ? u"大涨"_s : u"大跌"_s, signedPct(*changePct, 1)),
                 u"较昨收 %1%%2%3%4,现价 %5"_s.arg(signedPct(*changePct, 2), gap, marketNote(*changePct, marketDay, size, cfg.market_adjust), how, priceText(last)));
        }
    }

    const OJson metrics = js::object({{u"last"_s, optN(last)},
                                      {u"change_pct"_s, optN(r4(changePct))},
                                      {u"rvol"_s, optN(r4(rvol))},
                                      {u"burst"_s, optN(r4(burst))},
                                      {u"block_share"_s, optN(r4(blockShare))},
                                      {u"ret_window_pct"_s, optN(r4(retPct))},
                                      {u"sigma_window_pct"_s, optN(r4(sigmaWindowPct))},
                                      {u"sigma_day_pct"_s, optN(r4(sigmaDayPct))},
                                      {u"basis_volume"_s, basisVolume.isEmpty() ? OJson::null() : js::S(basisVolume)},
                                      {u"basis_sigma"_s, js::S(basisSigma)},
                                      {u"window_ready"_s, js::B(windowReady)},
                                      {u"delayed"_s, js::B(snap.delayed == true)}});
    return js::object({{u"events"_s, js::array(events)}, {u"state"_s, state.toJson()}, {u"metrics"_s, metrics}});
}

}  // namespace ibkr::analysis::anomaly
