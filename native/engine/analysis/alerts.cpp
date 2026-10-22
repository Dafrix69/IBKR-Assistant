#include "analysis/alerts.h"

#include "analysis/ma_touch.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/market_js.h"
#include "util/py.h"

#include <QRegularExpression>

#include <cmath>
#include <limits>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;
namespace mk = ibkr::util::market;

namespace ibkr::analysis::alerts {

namespace {
constexpr double kInf = std::numeric_limits<double>::infinity();
QString n2s(double v) { return util::jsNumberToString(v); }

constexpr double kPriorityRound = 0;
constexpr double kPriorityPivot = 1;
constexpr double kPriorityWeakWall = 2;
// 趋势位(均线/52周高低点)与弱墙同级:全市场看得见、但不带当天持仓依据
constexpr double kPriorityTrend = 2;
constexpr double kPriorityStrongWall = 3;

AlertLevel level(double price, const QString& label, const QString& source, const QString& kind, std::optional<double> priority,
                 std::optional<MaRef> ma = std::nullopt) {
    return {price, label, source, kind, priority, ma};
}

void sortByPrice(std::vector<AlertLevel>& v) {
    mk::jsSort(v, [](const AlertLevel& a, const AlertLevel& b) { return a.price - b.price; });
}

QString fmtStrip(double value) {
    QString s = util::fmtF(value, 4);
    qsizetype end = s.size();
    while (end > 0 && s[end - 1] == u'0') --end;  // /0+$/
    s.truncate(end);
    if (s.endsWith(u'.')) s.chop(1);  // /\.$/
    return s;
}
}  // namespace

const std::vector<double>& defaultMaPeriods() {
    static const std::vector<double> p{20, 60, 120, 200};  // 与 Python DEFAULT_MA_PERIODS 同步
    return p;
}

OJson AlertLevel::dict() const {
    OJson o = js::object({{u"price"_s, js::N(price)}, {u"label"_s, js::S(label)}, {u"source"_s, js::S(source)}, {u"kind"_s, js::S(kind)}});
    if (ma) o.set(u"ma"_s, js::object({{u"period"_s, js::N(ma->period)}, {u"prior_sum"_s, js::N(ma->prior_sum)}}));
    return o;
}

OJson AlertLevel::toJson() const {
    OJson o = dict();
    if (priority) o.set(u"priority"_s, js::N(*priority));
    return o;
}

AlertLevel AlertLevel::fromJson(const OJson& o) {
    AlertLevel l;
    l.price = js::num(o.get(u"price"_s));
    l.label = js::strOr(o.get(u"label"_s), QString());
    l.source = js::strOr(o.get(u"source"_s), QString());
    l.kind = js::strOr(o.get(u"kind"_s), QString());
    if (const OJson* p = o.get(u"priority"_s)) l.priority = js::num(p);
    if (const OJson* m = o.get(u"ma"_s); js::isObj(m)) l.ma = MaRef{js::num(m->get(u"period"_s)), js::num(m->get(u"prior_sum"_s))};
    return l;
}

// ---------------------------------------------------------------- 价位生成
double autoStep(double spot, double bandPct) {
    if (!(spot > 0) || !(bandPct > 0 && bandPct < 100) || !std::isfinite(spot)) return 0;
    const double need = (spot * 2 * bandPct) / (100 - bandPct);
    // 10^k ≤ need < 10^(k+1):这一个数量级里三档都不够,下一个数量级的第一档一定够
    static const double ladder[3] = {1, 2.5, 5};  // 1 / 2.5 / 5 × 10^k
    for (double k = std::floor(jm::log10(need));; k += 1) {
        for (double rung : ladder) {
            const double step = util::pyRound(rung * jm::pow(10, k), 10);
            if (step >= need - 1e-12) return step;
        }
    }
}

std::vector<double> roundLevels(double spot, double step) {
    if (spot <= 0 || step <= 0) return {};
    const double below = std::floor(spot / step) * step;
    const double above = std::ceil(spot / step) * step;
    if (std::fabs(above - below) < 1e-9) return {util::pyRound(below - step, 6), util::pyRound(above + step, 6)};
    return {util::pyRound(below, 6), util::pyRound(above, 6)};
}

namespace {
std::vector<AlertLevel> wallLevels(const OJson* wall) {
    if (!js::truthy(wall)) return {};
    std::vector<AlertLevel> out;
    const OJson* dte = js::prop(wall, u"days_to_expiry"_s);
    const bool zeroDay = (js::nullish(dte) ? 99.0 : js::num(dte)) <= 1.0;
    const double volRank = zeroDay ? kPriorityStrongWall : kPriorityWeakWall;
    const double oiRank = zeroDay ? kPriorityWeakWall : kPriorityStrongWall;

    const auto add = [&](const QString& key, const QString& label, double rank) {
        const OJson* entry = js::prop(wall, key);
        // 墙写成了串:"x"["strike"] 是 String.prototype.strike(老的 HTML 方法),真,Number() 是 NaN——TS 照样给出一条 NaN 价的墙
        if (js::isStr(entry) && js::truthy(entry)) {
            out.push_back(level(std::nan(""), label, key, key.contains(u"call"_s) ? u"resistance"_s : u"support"_s, rank));
            return;
        }
        if (js::truthy(entry) && js::truthy(js::prop(entry, u"strike"_s))) {
            const QString kind = key.contains(u"call"_s) ? u"resistance"_s : u"support"_s;
            out.push_back(level(js::num(js::prop(entry, u"strike"_s)), label, key, kind, rank));
        }
    };
    add(u"call_vol_wall"_s, u"上方成交墙"_s, volRank);
    add(u"put_vol_wall"_s, u"下方成交墙"_s, volRank);
    add(u"call_wall"_s, u"上方持仓墙"_s, oiRank);
    add(u"put_wall"_s, u"下方持仓墙"_s, oiRank);

    if (const OJson* mp = js::prop(wall, u"max_pain"_s); js::truthy(mp))
        out.push_back(level(js::isStr(mp) ? std::nan("") : js::num(js::prop(mp, u"strike"_s)), u"最大痛点"_s, u"max_pain"_s, u"pivot"_s, kPriorityPivot));
    if (const OJson* gf = js::prop(wall, u"gamma_flip"_s); !js::nullish(gf))
        out.push_back(level(js::num(gf), u"Gamma 翻转位"_s, u"gamma_flip"_s, u"pivot"_s, kPriorityPivot));
    return out;
}

QString trendKind(double price, double spot) {
    if (price < spot) return u"support"_s;
    if (price > spot) return u"resistance"_s;
    return u"pivot"_s;
}

/// 按顺序取一列有效价格。缺了或非正数的整根跳过
std::vector<double> barValues(const OJson* bars, const QString& key) {
    std::vector<double> out;
    if (!js::isArr(bars)) return out;
    for (const OJson& bar : bars->items) {
        const OJson* value = js::propStrict(&bar, key);
        if (js::isNum(value) && std::isfinite(value->n) && value->n > 0) out.push_back(value->n);
    }
    return out;
}

/// 今天之前的完整日线的收盘;today 给了就和碰均线用同一个函数挑
std::vector<double> priorCloses(const OJson* bars, const std::optional<QString>& today) {
    if (!today) return barValues(bars, u"close"_s);
    std::vector<double> out;
    for (const auto& b : ma_touch::completedBars(bars, *today)) out.push_back(b.close);
    return out;
}

double minOf(const std::vector<double>& v, mk::SliceRange r) {
    double acc = kInf;  // Math.min() = Infinity
    for (long long i = r.from; i < r.to; ++i) acc = jm::min(acc, v[size_t(i)]);
    return acc;
}
double maxOf(const std::vector<double>& v, mk::SliceRange r) {
    double acc = -kInf;
    for (long long i = r.from; i < r.to; ++i) acc = jm::max(acc, v[size_t(i)]);
    return acc;
}
}  // namespace

std::vector<AlertLevel> trendLevels(const OJson* bars, double spot, const std::vector<double>& maPeriods, double extremeWindow,
                                    const std::optional<QString>& today) {
    if (!js::isArr(bars) || bars->items.isEmpty() || !(spot != 0 && !std::isnan(spot)) || spot <= 0) return {};
    std::vector<AlertLevel> out;

    const std::vector<double> closes = priorCloses(bars, today);
    const double len = double(closes.size());
    for (double period : maPeriods) {
        if (period < 2 || len < period - 1) continue;  // 凑不满就不给,不拿短的凑
        const auto r = mk::sliceRange((long long)closes.size(), len - (period - 1));
        double sum = 0;
        for (long long i = r.from; i < r.to; ++i) sum = sum + closes[size_t(i)];
        const double prior = util::pyRound(sum, 6);
        const double ma = util::pyRound((prior + spot) / period, 4);
        if (ma <= 0) continue;
        out.push_back(level(ma, n2s(period) + u"日均线"_s, u"ma"_s + n2s(period), trendKind(ma, spot), kPriorityTrend, MaRef{period, prior}));
    }

    const std::vector<double> lows = barValues(bars, u"low"_s);
    const std::vector<double> highs = barValues(bars, u"high"_s);
    if (double(lows.size()) >= kMinExtremeBars && double(highs.size()) >= kMinExtremeBars) {
        const bool full = double(lows.size()) >= extremeWindow && double(highs.size()) >= extremeWindow;
        const double low = util::pyRound(minOf(lows, mk::sliceRange((long long)lows.size(), -extremeWindow)), 4);
        const double high = util::pyRound(maxOf(highs, mk::sliceRange((long long)highs.size(), -extremeWindow)), 4);
        out.push_back(level(low, full ? u"52周低点"_s : u"历史低点"_s, u"low_52w"_s, trendKind(low, spot), kPriorityTrend));
        out.push_back(level(high, full ? u"52周高点"_s : u"历史高点"_s, u"high_52w"_s, trendKind(high, spot), kPriorityTrend));
    }
    return out;
}

OJson trendSnapshot(const OJson* bars, double spot, const std::vector<double>& maPeriods, double extremeWindow, const std::optional<QString>& today) {
    const std::vector<AlertLevel> levels = trendLevels(bars, spot, maPeriods, extremeWindow, today);
    if (levels.empty()) return OJson::null();
    OJson out = js::object();
    for (const AlertLevel& l : levels) out.set(l.source, js::N(l.price));
    const OJson* low = out.get(u"low_52w"_s);
    const OJson* high = out.get(u"high_52w"_s);
    if (low && high && high->n > low->n) out.set(u"range_pos_pct"_s, js::N(util::pyRound(((spot - low->n) / (high->n - low->n)) * 100.0, 1)));
    out.set(u"bars"_s, js::N(double(barValues(bars, u"close"_s).size())));
    return out;
}

std::vector<AlertLevel> buildLevels(double spot, const OJson* wall, double step, double mergePct, double maxLevels, const OJson* history,
                                    const std::optional<QString>& today) {
    if (spot <= 0) throw AlertError(u"缺少现价,无法生成价位。"_s);

    std::vector<AlertLevel> levels = wallLevels(wall);
    for (const AlertLevel& l : trendLevels(history, spot, defaultMaPeriods(), kExtremeWindow, today)) levels.push_back(l);
    for (double price : roundLevels(spot, step > 0 ? step : autoStep(spot))) {
        if (!(price > 0)) continue;  // 步长比现价还大时下面那一档是 0:不是一个价位
        levels.push_back(level(price, u"整数关口 "_s + util::pyG(price), u"round"_s, u"pivot"_s, kPriorityRound));
    }

    const double tol = (std::fabs(spot) * mergePct) / 100.0;
    std::vector<AlertLevel> sorted = levels;
    sortByPrice(sorted);
    std::vector<AlertLevel> merged;
    for (const AlertLevel& l : sorted) {
        if (!merged.empty() && std::fabs(l.price - merged.back().price) <= tol) {
            const AlertLevel previous = merged.back();
            // 以更可信的那个为准,标签两个都留着
            const bool keepPrev = *previous.priority >= *l.priority;
            const AlertLevel& winner = keepPrev ? previous : l;
            const AlertLevel& loser = keepPrev ? l : previous;
            // 赢的是均线,合并出来的这一条照样跟着现价走;赢的是墙,它就钉在那个行权价上
            merged.back() = level(winner.price, winner.label + u" + "_s + loser.label, winner.source, winner.kind != u"pivot" ? winner.kind : loser.kind,
                                  winner.priority, winner.ma);
            continue;
        }
        merged.push_back(l);
    }

    std::vector<AlertLevel> out = merged;
    if (double(out.size()) > maxLevels) {
        mk::jsSort(out, [&](const AlertLevel& a, const AlertLevel& b) { return std::fabs(a.price - spot) - std::fabs(b.price - spot); });
        const auto r = mk::sliceRange((long long)out.size(), 0, maxLevels);
        out = std::vector<AlertLevel>(out.begin() + r.from, out.begin() + r.to);
    }
    sortByPrice(out);
    return out;
}

// ---------------------------------------------------------------- 状态机
namespace {
double band(double price, double bandPct) { return (std::fabs(price) * bandPct) / 100.0; }

/// 会漂的线:均线、52 周高低、Gamma 翻转位
bool drifts(const QString& source) {
    static const QRegularExpression ma(u"\\Ama[0-9]+\\z"_s);
    return ma.match(source).hasMatch() || source == u"low_52w" || source == u"high_52w" || source == u"gamma_flip";
}

/// {armed, last_fired_at}(last_fired_at 是 undefined 时不写这个键,同 JSON.stringify)
OJson arm(bool armed, const OJson* lastFiredAt) {
    OJson o = js::object({{u"armed"_s, js::B(armed)}});
    if (lastFiredAt) o.set(u"last_fired_at"_s, *lastFiredAt);
    return o;
}
}  // namespace

double levelPriceAt(const AlertLevel& level, double price) {
    if (!level.ma || !(level.ma->period > 1) || !std::isfinite(level.ma->prior_sum) || !(price > 0)) return level.price;
    return (level.ma->prior_sum + price) / level.ma->period;
}

QString levelKey(const AlertLevel& level) { return drifts(level.source) ? level.source : level.source + u'@' + util::fmtF(level.price, 4); }

OJson PriceSample::toJson() const {
    return js::object({{u"at"_s, js::N(at)}, {u"price"_s, js::N(price)}, {u"session"_s, js::S(session)}, {u"tradedAt"_s, js::NOrNull(tradedAt)},
                       {u"settled"_s, js::B(settled)}});
}

Linked linkSample(const std::optional<PriceSample>& prev, const PriceSample& quote, double maxGap) {
    PriceSample sample = quote;
    if (!prev || !(prev->price > 0)) {
        sample.settled = false;
        return {sample, std::nullopt};
    }
    const double gap = quote.at - prev->at;
    const bool joined = prev->session == quote.session && gap >= 0 && gap <= maxGap;
    // 成交时刻往前走了 = 这两轮之间有新的成交
    const bool advanced = prev->tradedAt && quote.tradedAt && *quote.tradedAt > *prev->tradedAt;
    // 连着:上一笔是真价,这一笔就是;上一笔还没坐实,这一笔动了也算坐实。没连着:只有成交时刻往前走了才敢认它是新的
    sample.settled = joined ? prev->settled || advanced || quote.price != prev->price : advanced;
    return {sample, joined && prev->settled ? std::optional(prev->price) : std::nullopt};
}

std::pair<QList<OJson>, OJson> evaluate(const std::vector<AlertLevel>& levels, const OJson& states, std::optional<double> prevPrice, double price,
                                        double nowTs, double bandPct, double cooldown, const QString& confirm) {
    QList<OJson> events;
    // 只留这一轮在场的价位:价位重算之后老状态成了孤儿,不带着
    OJson out = js::object();
    const double minute = std::floor(nowTs / 60);

    for (const AlertLevel& lv : levels) {
        const QString key = levelKey(lv);
        // 按价格做键的是老库里的状态:认一次,写回去就是新键了
        OJson state;
        if (const OJson* s = js::prop(&states, key); !js::nullish(s)) state = *s;
        else if (const OJson* s2 = js::prop(&states, util::fmtF(lv.price, 4)); !js::nullish(s2)) state = *s2;
        else state = js::object({{u"armed"_s, js::B(true)}, {u"last_fired_at"_s, OJson::null()}});
        const double at = levelPriceAt(lv, price);

        // 先看能不能重新上膛:离开得够远,而且过了冷却
        if (!js::truthy(js::prop(&state, u"armed"_s)) && std::fabs(price - at) > band(at, bandPct)) {
            const OJson* last = js::prop(&state, u"last_fired_at"_s);
            const bool cooled = (last && last->type == OJson::Null) || nowTs - js::num(last) >= cooldown;
            if (cooled) state = arm(true, last);
        }

        const auto fire = [&](const OJson* direction, double from, double to, double line, bool closed) {
            const QString verb = js::isStr(direction) && direction->s == u"up" ? u"上穿"_s : u"下破"_s;
            const QString how = closed ? u"1 分钟收盘 %1 确认,现价 %2"_s.arg(fmtStrip(to), fmtStrip(price)) : u"现价 "_s + fmtStrip(price);
            OJson e = js::object({{u"price"_s, js::N(util::pyRound(line, 4))}, {u"label"_s, js::S(lv.label)}, {u"source"_s, js::S(lv.source)},
                                  {u"kind"_s, js::S(lv.kind)}});
            if (direction) e.set(u"direction"_s, *direction);  // 库里的 pending 没有 direction:undefined,JSON 里没有这个键
            for (const auto& [k, v] : js::object({{u"from"_s, js::N(util::pyRound(from, 4))},
                                      {u"to"_s, js::N(util::pyRound(to, 4))},
                                      {u"at"_s, js::N(nowTs)},
                                      {u"text"_s, js::S(u"%1 %2 %3(%4)"_s.arg(lv.label, verb, fmtStrip(line), how))}}).fields)
                e.set(k, v);
            events.append(e);
            state = js::object({{u"armed"_s, js::B(false)}, {u"last_fired_at"_s, js::N(nowTs)}});
        };
        const auto clear = [&] {
            state = arm(true, js::prop(&state, u"last_fired_at"_s));
        };

        const OJson* pendingPtr = js::truthy(js::prop(&state, u"armed"_s)) ? js::prop(&state, u"pending"_s) : nullptr;
        if (pendingPtr) {
            const OJson pending = *pendingPtr;
            const OJson* closeAt = js::propStrict(&pending, u"close_at"_s);
            const double since = nowTs - js::num(js::nullish(closeAt) ? js::prop(&pending, u"at"_s) : closeAt);
            const OJson* pClose = js::prop(&pending, u"close"_s);
            if (!(since >= 0 && since <= cooldown)) {
                clear();  // 断了档:那根 K 线怎么收的不知道
            } else if (const OJson m = js::N(minute); js::strictEqual(js::prop(&pending, u"minute"_s), &m) || !pClose) {
                // 还在那一分钟里:这一笔是它目前为止的收盘。那一分钟穿过之后没再取到价:换成这一分钟来等
                OJson p = js::isObj(&pending) ? pending : js::object();
                p.set(u"minute"_s, js::N(minute));
                p.set(u"close"_s, js::N(price));
                p.set(u"close_at"_s, js::N(nowTs));
                state.set(u"pending"_s, p);
            } else {
                const double close = js::num(pClose);
                const double line = levelPriceAt(lv, close);
                const OJson* direction = js::prop(&pending, u"direction"_s);
                const bool up = js::isStr(direction) && direction->s == u"up";
                const bool held = up ? close > line : close < line;
                if (held) fire(direction, js::num(js::prop(&pending, u"from"_s)), close, line, true);
                else clear();
            }
        }

        if (js::truthy(js::prop(&state, u"armed"_s)) && !js::prop(&state, u"pending"_s) && prevPrice) {
            // 跨过(含正好落在线上):上一笔与这一笔分在线的两侧。均线两笔各算各的线
            const double before = *prevPrice - levelPriceAt(lv, *prevPrice);
            if (before * (price - at) <= 0) {
                const QString direction = price >= *prevPrice ? u"up"_s : u"down"_s;
                if (confirm == u"bar_close") {
                    state.set(u"pending"_s, js::object({{u"direction"_s, js::S(direction)}, {u"from"_s, js::N(*prevPrice)}, {u"at"_s, js::N(nowTs)},
                                                        {u"minute"_s, js::N(minute)}}));
                } else {
                    const OJson d = js::S(direction);
                    fire(&d, *prevPrice, price, at, false);
                }
            }
        }
        out.set(key, state);
    }
    return {events, out};
}

std::optional<std::vector<AlertLevel>> reroundLevels(const std::vector<AlertLevel>& levels, double price, double step, double mergePct) {
    const double size = step > 0 ? step : autoStep(price);
    if (!(price > 0) || !(size > 0)) return std::nullopt;
    const double ratio = price / size;
    if (std::fabs(ratio - util::jsRound(ratio)) < 1e-9) return std::nullopt;
    std::vector<double> pair;
    for (double r : roundLevels(price, size))
        if (r > 0) pair.push_back(r);  // 步长比现价还大时下面那一档是 0:不是一个价位
    const auto same = [](double x, double y) { return std::fabs(x - y) < 1e-9; };
    std::vector<AlertLevel> kept;
    for (const AlertLevel& l : levels) {
        bool inPair = false;
        for (double r : pair) inPair = inPair || same(r, l.price);
        if (l.source != u"round" || inPair) kept.push_back(l);
    }
    const double tol = (std::fabs(price) * mergePct) / 100.0;
    std::vector<AlertLevel> added;
    for (double r : pair) {
        bool near = false;
        for (const AlertLevel& l : kept) near = near || std::fabs(levelPriceAt(l, price) - r) <= tol;
        if (!near) added.push_back(level(r, u"整数关口 "_s + util::pyG(r), u"round"_s, u"pivot"_s, std::nullopt));
    }
    if (added.empty() && kept.size() == levels.size()) return std::nullopt;
    std::vector<AlertLevel> all = kept;
    for (const AlertLevel& l : added) all.push_back(l);
    sortByPrice(all);
    return all;
}

QStringList describe(const std::vector<AlertLevel>& levels, double spot) {
    QStringList out;
    for (const AlertLevel& l : levels) {
        const double gap = spot != 0 && !std::isnan(spot) ? (l.price / spot - 1.0) * 100.0 : 0.0;
        out << u"%1 %2(%3%)"_s.arg(fmtStrip(l.price), l.label, util::fmtSF(gap, 2));
    }
    return out;
}

}  // namespace ibkr::analysis::alerts
