#include "analysis/cross_market.h"

#include "analysis/econ_calendar.h"
#include "util/intel_dateparse.h"
#include "util/intel_text.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/tz.h"

#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;
namespace tx = ibkr::util::intel_text;

namespace ibkr::analysis::cross_market {

namespace {
constexpr double kDayMs = 86'400'000;
const QString kEt = QString::fromUtf16(util::kET);

/// new Date(t).getUTCDay()(t 不是有限数时是 NaN)
double utcDay(double t) {
    if (!std::isfinite(t)) return std::nan("");
    return std::fmod(std::fmod(std::floor(t / kDayMs), 7.0) + 4 + 7, 7.0);
}
double parse(const QString& s) { return util::v8DateParse(s); }

/// /^([+-])(\d{2}):(\d{2})$/
double offsetMs(const QString& offset) {
    if (offset.size() != 6 || (offset[0] != u'+' && offset[0] != u'-') || !tx::isDigit(offset[1]) || !tx::isDigit(offset[2]) || offset[3] != u':' ||
        !tx::isDigit(offset[4]) || !tx::isDigit(offset[5]))
        return 0;
    const double h = util::jsStringToNumber(QStringView(offset).mid(1, 2)), m = util::jsStringToNumber(QStringView(offset).mid(4, 2));
    return (offset[0] == u'-' ? -1 : 1) * (h * 60 + m) * 60'000;
}

QString signedPct(double p, int digits = 1) {
    return QString(p > 0 ? u"+"_s : p < 0 ? u"−"_s : QString()) + util::jsToFixed(std::fabs(p), digits) + u'%';
}
}  // namespace

const std::vector<Market>& crossMarkets() {
    static const std::vector<Market> m{
        {u"kr"_s, u"韩股"_s, u"+09:00"_s, u"09:00"_s, u"EWY"_s, {u"EWY"_s, u"KORU"_s}},
        {u"cn"_s, u"A 股"_s, u"+08:00"_s, u"09:30"_s, u"ASHR"_s, {u"ASHR"_s, u"FXI"_s, u"KWEB"_s, u"YINN"_s}},
    };
    return m;
}

OJson crossMarketsJson() {
    OJson a = js::array();
    for (const Market& m : crossMarkets())
        a.items << js::object({{u"key"_s, js::S(m.key)}, {u"name"_s, js::S(m.name)}, {u"offset"_s, js::S(m.offset)}, {u"open"_s, js::S(m.open)},
                               {u"measure"_s, js::S(m.measure)}, {u"instruments"_s, js::strings(m.instruments)}});
    return a;
}

const QStringList& crossSymbols() {
    static const QStringList s = [] {
        QStringList out;
        for (const Market& m : crossMarkets())
            for (const QString& i : m.instruments)
                if (!out.contains(i)) out << i;
        return out;
    }();
    return s;
}

double nextOpen(double now, const QString& offset, const QString& open, double graceMs) {
    const auto dayStr = [&](double t) { return util::isoString(t + offsetMs(offset)).left(10); };
    QString day = dayStr(now - graceMs);
    for (int i = 0; i < 8; ++i) {
        const double at = parse(day + u'T' + open + u":00"_s + offset);
        const double dow = utcDay(parse(day + u"T12:00:00Z"_s));
        if (at >= now - graceMs && dow != 0 && dow != 6) return at;
        day = dayStr(parse(day + u"T12:00:00Z"_s) + kDayMs);
    }
    return parse(day + u'T' + open + u":00"_s + offset);
}

double usSessionStart(double lastOpen) {
    util::WallParts p = util::wallParts(lastOpen - 6 * 3600'000, kEt);
    for (int i = 0; i < 3; ++i) {
        const double dow = utcDay(util::dateUtc(p.year, p.month - 1, p.day));
        if (dow != 0 && dow != 6) break;
        p = util::wallParts(util::wallToEpoch({p.year, p.month, p.day, 12, 0, 0}, kEt) - 24 * 3600'000, kEt);
    }
    return util::wallToEpoch({p.year, p.month, p.day, 9, 30, 0}, kEt);
}

OJson Window::toJson() const {
    OJson o = js::array();
    for (const Open& x : opens) o.items << js::object({{u"key"_s, js::S(x.key)}, {u"name"_s, js::S(x.name)}, {u"at"_s, js::N(x.at)}});
    return js::object({{u"opens"_s, o}, {u"first"_s, js::N(first)}, {u"last"_s, js::N(last)}, {u"start"_s, js::N(start)}});
}

std::optional<Window> crossWindow(double now) {
    const double grace = kCrossLingerMin * 60'000;
    const Market& cn = crossMarkets()[1];
    Window w;
    w.last = nextOpen(now, cn.offset, cn.open, grace);
    const QString day = util::isoString(w.last + offsetMs(cn.offset)).left(10);
    for (const Market& m : crossMarkets()) w.opens << Window::Open{m.key, m.name, parse(day + u'T' + m.open + u":00"_s + m.offset)};
    w.first = w.opens[0].at;
    for (qsizetype i = 1; i < w.opens.size(); ++i) w.first = jm::min(w.first, w.opens[i].at);
    w.start = usSessionStart(w.last);
    if (now < w.start || now > w.last + grace) return std::nullopt;
    return w;
}

OJson evaluateCrossMarket(std::optional<double> usPct, const OJson& quotes, double now, const Cfg& cfg) {
    const auto window = crossWindow(now);
    if (!window || !usPct || !std::isfinite(*usPct) || std::fabs(*usPct) < cfg.pct) return OJson::null();
    const double us = *usPct;
    const bool down = us < 0;
    struct Lag {
        const Market* m;
        double etfPct, gap, openAt;
        OJson instruments;
    };
    QList<Lag> lags;
    for (const Market& m : crossMarkets()) {
        const OJson* etf = js::prop(js::prop(&quotes, m.measure), u"change_pct"_s);
        if (!js::isNum(etf) || !std::isfinite(etf->n)) continue;
        // 差 = ETF − 指数;跌的时候差为正是没跟跌,涨的时候差为负是没跟涨
        const double gap = util::jsRound((etf->n - us) * 100) / 100;
        const bool lagging = down ? gap >= cfg.lag_pct : -gap >= cfg.lag_pct;
        if (!lagging) continue;
        double openAt = window->first;
        for (const Window::Open& o : window->opens)
            if (o.key == m.key) {
                openAt = o.at;
                break;
            }
        OJson inst = js::array();
        for (const QString& s : m.instruments) {
            const OJson* q = js::prop(&quotes, s);
            const OJson* cp = js::prop(q, u"change_pct"_s);
            const OJson* last = js::prop(q, u"last"_s);
            inst.items << js::object({{u"symbol"_s, js::S(s)}, {u"change_pct"_s, js::copyOrNull(js::nullish(cp) ? nullptr : cp)},
                                      {u"last"_s, js::copyOrNull(js::nullish(last) ? nullptr : last)}});
        }
        lags << Lag{&m, etf->n, std::fabs(gap), openAt, inst};
    }
    if (lags.isEmpty()) return OJson::null();
    double at = lags[0].openAt;
    for (qsizetype i = 1; i < lags.size(); ++i) at = jm::min(at, lags[i].openAt);
    const QString date = econ_calendar::etDateOf(at), time = econ_calendar::etTimeOf(at);
    const QString verb = down ? u"跌"_s : u"涨"_s;
    QStringList names, detail, legs;
    OJson markets = js::array();
    for (const Lag& l : lags) {
        names << l.m->name;
        detail << u"%1 %2 %3(差 %4 点)"_s.arg(l.m->name, l.m->measure, signedPct(l.etfPct), util::jsToFixed(l.gap, 1));
        legs << l.m->instruments.join(u" / "_s);
        markets.items << js::object({{u"key"_s, js::S(l.m->key)}, {u"name"_s, js::S(l.m->name)}, {u"symbol"_s, js::S(l.m->measure)}, {u"etf_pct"_s, js::N(l.etfPct)},
                                     {u"gap"_s, js::N(l.gap)}, {u"open_at"_s, js::N(l.openAt)}, {u"instruments"_s, l.instruments}});
    }
    const QString direction = down ? u"down"_s : u"up"_s;
    return js::object({
        {u"id"_s, js::S(u"cross:"_s + date + u':' + direction)},
        {u"kind"_s, js::S(u"cross"_s)},
        {u"title"_s, js::S(u"美股 %1,%2 ETF 没跟%3:开盘可能补%3"_s.arg(signedPct(us), names.join(u" / "_s), verb))},
        {u"at"_s, js::N(at)},
        {u"date_et"_s, js::S(date)},
        {u"time_et"_s, js::S(time)},
        {u"stars"_s, js::N(5)},
        {u"impact"_s, js::S(u"high"_s)},
        {u"source"_s, js::S(u"builtin"_s)},
        {u"linger_min"_s, js::N(util::jsRound((window->last - at) / 60'000) + kCrossLingerMin)},
        {u"note"_s, js::S(u"%1。开盘前%2这些 ETF(%3)是套利区间;3 倍杠杆的一天能走 10% 以上,先看 TWS 里的盘后价。"_s.arg(detail.join(u';'), down ? u"做空"_s : u"做多"_s,
                                                                                                         legs.join(u';')))},
        {u"cross"_s, js::object({{u"direction"_s, js::S(direction)}, {u"us_pct"_s, js::N(us)}, {u"markets"_s, markets}})},
    });
}

}  // namespace ibkr::analysis::cross_market
