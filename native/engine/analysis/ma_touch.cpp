#include "analysis/ma_touch.h"

#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/market_js.h"
#include "util/py.h"
#include "util/tz.h"

#include <QStringList>

#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;

namespace ibkr::analysis::ma_touch {

namespace {
// 日线拉 420 个日历日 ≈ 288 根:250 日线 + 30 天窗口还放得下
constexpr double kPeriodRange[2] = {5, 250};
constexpr double kWindowRange[2] = {3, 30};
constexpr double kTouchesRange[2] = {2, 10};
constexpr double kBandRange[2] = {0, 2};

QString n2s(double v) { return util::jsNumberToString(v); }

/// 数字或数字串都认;布尔、空串、NaN 不认(同 anomaly.ts)
std::optional<double> numberOf(const OJson* v) {
    if (js::isNum(v)) return std::isfinite(v->n) ? std::optional(v->n) : std::nullopt;
    if (js::isStr(v) && !util::jsTrim(v->s).isEmpty()) {
        const double n = util::jsStringToNumber(v->s);
        return std::isfinite(n) ? std::optional(n) : std::nullopt;
    }
    return std::nullopt;
}
bool isInteger(double n) { return std::isfinite(n) && std::trunc(n) == n; }

double intField(const OJson& raw, const QString& key, double fallback, const double (&range)[2], const QString& what) {
    const OJson* value = raw.get(key);
    if (js::nullish(value)) return fallback;
    const auto n = numberOf(value);
    if (!n || !isInteger(*n) || *n < range[0] || *n > range[1])
        throw MaTouchError(u"%1要是 %2~%3 的整数(收到 %4)"_s.arg(what, n2s(range[0]), n2s(range[1]), util::market::shown(*value)));
    return *n;
}

OJson numbers(const std::vector<double>& v) {
    OJson a = js::array();
    for (double x : v) a.items.append(js::N(x));
    return a;
}
OJson episodesJson(const std::vector<Episode>& v) {
    OJson a = js::array();
    for (const Episode& e : v) a.items.append(e.toJson());
    return a;
}
/// arr.includes(x):SameValueZero(NaN 认 NaN)
bool includes(const std::vector<double>& v, double x) {
    for (double y : v)
        if (y == x || (std::isnan(y) && std::isnan(x))) return true;
    return false;
}
}  // namespace

OJson Config::toJson() const {
    return js::object({{u"enabled"_s, js::B(enabled)},
                       {u"periods"_s, numbers(periods)},
                       {u"window_days"_s, js::N(window_days)},
                       {u"min_touches"_s, js::N(min_touches)},
                       {u"band_pct"_s, js::N(band_pct)}});
}

const Config& defaultConfig() {
    static const Config c{true, {20, 60, 120, 200}, 10, 3, 0.3};  // 均线和价位条上那几条一致;容差和穿越提醒的 band 同一个数
    return c;
}

Config normalizeTouchConfig(const OJson* raw, const Config& base) {
    Config out = base;
    if (js::nullish(raw)) return out;
    if (!js::isObj(raw)) throw MaTouchError(u"碰均线提醒的设置格式不对,应是一组键值"_s);

    const OJson* enabled = raw->get(u"enabled"_s);
    if (!js::nullish(enabled)) {
        if (!js::isBool(enabled)) throw MaTouchError(u"开关要是 true / false(收到 %1)"_s.arg(util::market::shown(*enabled)));
        out.enabled = enabled->b;
    }
    const OJson* periods = raw->get(u"periods"_s);
    if (!js::nullish(periods)) {
        const QString why = u"均线要 1~%1 条、每条 %2~%3 日的整数(收到 %4)"_s.arg(QString::number(kMaxTouchPeriods), n2s(kPeriodRange[0]), n2s(kPeriodRange[1]),
                                                                       util::market::shown(*periods));
        if (!js::isArr(periods) || periods->items.isEmpty()) throw MaTouchError(why);
        std::vector<double> list;
        for (const OJson& item : periods->items) {
            const auto n = numberOf(&item);
            if (!n || !isInteger(*n) || *n < kPeriodRange[0] || *n > kPeriodRange[1]) throw MaTouchError(why);
            if (!includes(list, *n)) list.push_back(*n);
        }
        if (list.size() > size_t(kMaxTouchPeriods)) throw MaTouchError(why);
        util::market::sortNumbers(list);
        out.periods = list;
    }
    out.window_days = intField(*raw, u"window_days"_s, out.window_days, kWindowRange, u"「短期内」的交易日数"_s);
    out.min_touches = intField(*raw, u"min_touches"_s, out.min_touches, kTouchesRange, u"起报次数"_s);
    const OJson* band = raw->get(u"band_pct"_s);
    if (!js::nullish(band)) {
        const auto n = numberOf(band);
        if (!n || *n < kBandRange[0] || *n > kBandRange[1])
            throw MaTouchError(u"贴近均线的容差要在 %1%~%2% 之间(收到 %3)"_s.arg(n2s(kBandRange[0]), n2s(kBandRange[1]), util::market::shown(*band)));
        out.band_pct = util::pyRound(*n, 4);
    }
    // 两段之间至少隔一天没碰,N 天里最多分出 ⌈N/2⌉ 段——要的次数比这还多,这条提醒永远不会响
    const double most = std::ceil(out.window_days / 2);
    if (out.min_touches > most)
        throw MaTouchError(u"%1 个交易日里最多只能分出 %2 段触碰(连着几天贴着线只算一次),起报次数 %3 永远凑不够"_s.arg(
            n2s(out.window_days), n2s(most), n2s(out.min_touches)));
    return out;
}

QString prevTradingDay(const QString& date, const std::function<bool(const QString&)>& isTradingDay) {
    double ms = util::jsDateParse(date + u"T00:00:00Z"_s);
    for (int i = 0; i < 15; i += 1) {
        ms -= 86'400'000;
        const QString d = util::isoString(ms).left(10);
        if (isTradingDay(d)) return d;
    }
    return util::isoString(ms).left(10);
}

// ---------------------------------------------------------------- 日线上的触碰
std::vector<DayBar> completedBars(const OJson* bars, const QString& today) {
    std::vector<DayBar> out;
    if (!js::isArr(bars)) return out;  // bars ?? [](约定:数组或 null)
    for (const OJson& bar : bars->items) {
        const OJson* rawDate = js::propStrict(&bar, u"date"_s);
        const QString date = js::isStr(rawDate) ? rawDate->s.left(10) : QString();
        const OJson* high = js::prop(&bar, u"high"_s);
        const OJson* low = js::prop(&bar, u"low"_s);
        const OJson* close = js::prop(&bar, u"close"_s);
        if (date.isEmpty() || date >= today) continue;
        if (!js::isNum(high) || !js::isNum(low) || !js::isNum(close)) continue;
        if (!(high->n > 0 && low->n > 0 && close->n > 0) || !std::isfinite(high->n + low->n + close->n)) continue;
        if (!out.empty() && out.back().date >= date) continue;  // 乱序 / 重复的不认
        out.push_back({date, high->n, low->n, close->n});
    }
    return out;
}

std::vector<TouchDay> touchDays(const std::vector<DayBar>& bars, double period, double bandPct) {
    std::vector<TouchDay> out;
    double sum = 0;
    for (size_t i = 0; i < bars.size(); i += 1) {
        const DayBar& bar = bars[i];
        sum += bar.close;
        if (double(i) >= period) {
            const double j = double(i) - period;
            if (j != std::floor(j)) throw util::JsError(u"Cannot read properties of undefined (reading 'close')"_s);
            sum -= bars[size_t(j)].close;
        }
        if (double(i) < period - 1) continue;
        const double ma = sum / period;
        const double tol = (ma * bandPct) / 100;
        out.push_back({bar.date, ma, bar.low <= ma + tol && bar.high >= ma - tol, bar.close >= ma ? u"above"_s : u"below"_s});
    }
    return out;
}

OJson Episode::toJson() const { return js::object({{u"start"_s, js::S(start)}, {u"end"_s, js::S(end)}, {u"side"_s, js::S(side)}}); }

std::vector<Episode> episodesOf(const std::vector<TouchDay>& days) {
    std::vector<Episode> out;
    bool open = false;  // 末尾那一段是不是还开着
    for (const TouchDay& day : days) {
        if (!day.touched) {
            open = false;
            continue;
        }
        if (!open) {
            out.push_back({day.date, day.date, day.side});
            open = true;
        } else {
            out.back().end = day.date;
            out.back().side = day.side;
        }
    }
    return out;
}

OJson TouchLine::toJson() const {
    return js::object({{u"period"_s, js::N(period)}, {u"prior_sum"_s, js::N(prior_sum)}, {u"episodes"_s, episodesJson(episodes)}});
}

OJson TouchBook::toJson() const {
    OJson ls = js::array();
    for (const TouchLine& l : lines) ls.items.append(l.toJson());
    return js::object({{u"as_of"_s, js::S(as_of)},
                       {u"window_days"_s, js::N(window_days)},
                       {u"band_pct"_s, js::N(band_pct)},
                       {u"periods"_s, numbers(periods)},
                       {u"lines"_s, ls},
                       {u"fired"_s, fired}});
}

TouchBook TouchBook::fromJson(const OJson& o) {
    const auto n = [](const OJson* v) { return js::num(v); };
    const auto s = [](const OJson* v) { return js::isStr(v) ? v->s : QString(); };
    TouchBook b;
    b.as_of = s(o.get(u"as_of"_s));
    b.window_days = n(o.get(u"window_days"_s));
    b.band_pct = n(o.get(u"band_pct"_s));
    if (const OJson* p = o.get(u"periods"_s); js::isArr(p))
        for (const OJson& x : p->items) b.periods.push_back(js::num(&x));
    if (const OJson* ls = o.get(u"lines"_s); js::isArr(ls))
        for (const OJson& l : ls->items) {
            TouchLine line{n(l.get(u"period"_s)), n(l.get(u"prior_sum"_s)), {}};
            if (const OJson* es = l.get(u"episodes"_s); js::isArr(es))
                for (const OJson& e : es->items) line.episodes.push_back({s(e.get(u"start"_s)), s(e.get(u"end"_s)), s(e.get(u"side"_s))});
            b.lines.push_back(line);
        }
    const OJson* f = o.get(u"fired"_s);
    b.fired = js::isObj(f) ? *f : js::object();
    return b;
}

std::optional<TouchBook> buildTouchBook(const OJson* bars, const QString& today, const Config& config, const OJson* fired) {
    const std::vector<DayBar> done = completedBars(bars, today);
    if (done.empty()) return std::nullopt;
    const double len = double(done.size());
    const double inWindow = config.window_days - 1;
    const double startIdx = jm::max(0.0, len - inWindow);
    if (!(startIdx < len) || startIdx != std::floor(startIdx)) throw util::JsError(u"Cannot read properties of undefined (reading 'date')"_s);
    const QString windowStart = done[size_t(startIdx)].date;

    std::vector<TouchLine> lines;
    for (double period : config.periods) {
        if (len < period + inWindow - 1) continue;  // 窗口第一天的均线都凑不满
        std::vector<Episode> episodes;
        for (const Episode& e : episodesOf(touchDays(done, period, config.band_pct)))
            if (e.end >= windowStart) episodes.push_back(e);
        const auto range = util::market::sliceRange((long long)done.size(), len - (period - 1));
        double prior = 0;
        for (long long i = range.from; i < range.to; ++i) prior = prior + done[size_t(i)].close;
        lines.push_back({period, util::pyRound(prior, 6), episodes});
    }
    OJson keep = js::object();
    OJson none = js::object();
    const OJson* from = fired ? fired : &none;
    for (const TouchLine& line : lines) {
        const QString key = n2s(line.period);
        if (const OJson* at = js::propStrict(from, key)) keep.set(key, *at);  // fired 给了 null:TS 在这里抛
    }
    TouchBook book;
    book.as_of = done.back().date;
    book.window_days = config.window_days;
    book.band_pct = config.band_pct;
    book.periods = config.periods;
    book.lines = lines;
    book.fired = keep;
    return book;
}

bool bookUsable(const TouchBook* book, const Config& config, const QString& prevDay) {
    if (!book) return false;
    if (book->as_of != prevDay) return false;
    if (book->window_days != config.window_days || book->band_pct != config.band_pct) return false;
    const auto joined = [](std::vector<double> v) {
        util::market::sortNumbers(v);
        QStringList parts;
        for (double x : v) parts << n2s(x);
        return parts.join(u',');
    };
    return joined(book->periods) == joined(config.periods);
}

// ---------------------------------------------------------------- 盘中
namespace {
QString mmdd(const QString& date) { return date.mid(5); }
QString money(double v) { return util::fmtF(v, 2); }
QString episodeText(const Episode& e) { return e.start == e.end ? mmdd(e.start) : mmdd(e.start) + u'~' + mmdd(e.end); }
QString sideNote(const std::vector<Episode>& prior) {
    const auto all = [&](const QString& side) {
        for (const Episode& e : prior)
            if (e.side != side) return false;
        return true;
    };
    if (all(u"above"_s)) return u",都收在线上"_s;
    if (all(u"below"_s)) return u",都收在线下"_s;
    return u",收盘有上有下"_s;
}
}  // namespace

OJson TouchHit::toJson() const {
    return js::object({{u"period"_s, js::N(period)},
                       {u"label"_s, js::S(label)},
                       {u"ma"_s, js::N(ma)},
                       {u"count"_s, js::N(count)},
                       {u"start"_s, js::S(start)},
                       {u"prior"_s, episodesJson(prior)},
                       {u"side"_s, js::S(side)},
                       {u"direction"_s, js::S(direction)},
                       {u"text"_s, js::S(text)}});
}

Evaluation evaluateTouches(const TouchBook& book, const Config& config, double price, std::optional<double> prevPrice, const QString& today) {
    Evaluation r;
    r.fired = js::isObj(&book.fired) ? book.fired : js::object();  // {...book.fired}
    if (!(price > 0)) return r;

    for (const TouchLine& line : book.lines) {
        if (!includes(config.periods, line.period)) continue;
        const double p = line.period;
        const double ma = (line.prior_sum + price) / p;
        const bool near = std::fabs(price - ma) <= (ma * config.band_pct) / 100;
        bool crossed = false;
        if (prevPrice && *prevPrice > 0) {
            const double maPrev = (line.prior_sum + *prevPrice) / p;
            crossed = (*prevPrice - maPrev) * (price - ma) <= 0;
        }
        if (!near && !crossed) continue;

        const Episode* lastEp = line.episodes.empty() ? nullptr : &line.episodes.back();
        const bool continuing = lastEp && lastEp->end == book.as_of;
        const QString start = continuing ? lastEp->start : today;
        const QString key = n2s(p);
        // 这一段报过了(库里的值不是串时,和日期比是 NaN 比较,永远不成立)
        if (const OJson* done = r.fired.get(key); done && done->type == OJson::String && done->s >= start) continue;

        std::vector<Episode> prior = line.episodes;
        if (continuing) prior.pop_back();
        const double count = double(prior.size()) + 1;
        if (count < config.min_touches) continue;

        const QString side = price >= ma ? u"above"_s : u"below"_s;
        const QString direction = crossed && prevPrice && *prevPrice != price ? (price > *prevPrice ? u"up"_s : u"down"_s)
                                  : side == u"above" ? u"down"_s                                       // 在线上 = 从上方回踩下来
                                                      : u"up"_s;
        const QString label = n2s(p) + u"日均线"_s;
        const QString now = continuing ? mmdd(start) + u" 起连着碰到今天"_s : u"今天"_s;
        QStringList eps;
        for (const Episode& e : prior) eps << episodeText(e);
        TouchHit hit;
        hit.period = p;
        hit.label = label;
        hit.ma = util::pyRound(ma, 4);
        hit.count = count;
        hit.start = start;
        hit.prior = prior;
        hit.side = side;
        hit.direction = direction;
        hit.text = u"近 %1 个交易日第 %2 次碰 %3 %4"_s.arg(n2s(config.window_days), n2s(count), label, money(ma)) +
                   u"(之前 %1%2;%3,现价 %4)"_s.arg(eps.join(u"、"_s), sideNote(prior), now, money(price));
        r.hits.push_back(hit);
        r.fired.set(key, js::S(start));
    }
    return r;
}

}  // namespace ibkr::analysis::ma_touch
