#include "analysis/research.h"

#include "analysis/backtest.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"
#include "util/py.h"
#include "util/tz.h"

#include <QRegularExpression>
#include <QStringList>

#include <array>
#include <cmath>
#include <limits>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;
namespace bt = ibkr::analysis::backtest;

namespace ibkr::analysis::research {

namespace {
double weekdayIndex(const QString& ch) {
    static const QString order = u"一二三四五六日"_s;
    if (ch == u"天") return 6;
    return double(order.indexOf(ch));
}
}  // namespace

OJson resolveAnchor(const QString& text, const OJson& bars, const QString& todayIso) {
    if (bars.items.isEmpty()) return OJson::null();

    std::optional<double> targetOrdinal;
    QString label;
    const double todayOrd = util::dateOrdinal(todayIso);
    const double todayWd = util::weekdayOfDate(todayIso);

    static const QRegularExpression lastWeek(u"上周([一二三四五])"_s);
    static const QRegularExpression thisWeekRe(u"(?<!上)(?:本?周)([一二三四五])"_s);
    const auto m = lastWeek.match(text);
    const auto thisWeek = thisWeekRe.match(text);
    if (m.hasMatch()) {
        const double wd = weekdayIndex(m.captured(1));
        const double thisMonday = todayOrd - todayWd;
        targetOrdinal = thisMonday - 7 + wd;
        label = u"上周"_s + m.captured(1);
    } else if (thisWeek.hasMatch()) {
        const double wd = weekdayIndex(thisWeek.captured(1));
        const double back = std::fmod(std::fmod(todayWd - wd, 7) + 7, 7);
        targetOrdinal = todayOrd - back;
        label = u"周"_s + thisWeek.captured(1);
    } else if (text.contains(u"前天"_s)) {
        targetOrdinal = todayOrd - 2;
        label = u"前天"_s;
    } else if (text.contains(u"昨天"_s) || text.contains(u"昨日"_s)) {
        targetOrdinal = todayOrd - 1;
        label = u"昨天"_s;
    }
    if (!targetOrdinal) return OJson::null();

    const QString targetIso = util::ordinalToDate(*targetOrdinal);
    const OJson* bar = nullptr;
    for (const OJson& b : bars.items) {
        // bars 升序:取 ≤ 目标日的最后一根(ISO 字符串可直接比较)
        if (js::str(js::propStrict(&b, u"date"_s)) <= targetIso) bar = &b;
        else break;
    }
    if (!bar) return OJson::null();

    const bool useOpen = text.contains(u"开盘"_s);
    const double price = js::num(js::prop(bar, useOpen ? u"open"_s : u"close"_s));
    const double last = js::num(js::propStrict(&bars.items.last(), u"close"_s));
    const OJson* date = js::prop(bar, u"date"_s);
    OJson out = js::object({{u"label"_s, js::S(u"%1(%2)%3"_s.arg(label, js::str(date), useOpen ? u"开盘价"_s : u"收盘价"_s))}});
    if (date) out.set(u"date"_s, *date);  // undefined 的键 JSON 里没有
    out.set(u"price"_s, js::N(util::pyRound(price, 2)));
    out.set(u"chg_from_anchor_pct"_s, price != 0 && !std::isnan(price) ? js::N(util::pyRound((last / price - 1.0) * 100.0, 2)) : OJson::null());
    return out;
}

OJson symbolBrief(const OJson& bars) {
    std::vector<double> closes, highs, lows;
    for (const OJson& b : bars.items) {
        closes.push_back(js::num(js::propStrict(&b, u"close"_s)));
        highs.push_back(js::num(js::propStrict(&b, u"high"_s)));
        lows.push_back(js::num(js::propStrict(&b, u"low"_s)));
    }
    if (closes.size() < 2) return js::object();

    const size_t len = closes.size();
    const double last = closes.back();
    OJson out = js::object({{u"last"_s, js::N(util::pyRound(last, 2))}, {u"bars"_s, js::N(double(bars.items.size()))}});

    const std::pair<size_t, const char16_t*> changes[] = {{1, u"chg_1d_pct"}, {5, u"chg_5d_pct"}, {20, u"chg_20d_pct"}, {60, u"chg_60d_pct"}};
    for (const auto& [n, key] : changes)
        if (len > n) out.set(QString::fromUtf16(key), js::N(util::pyRound((last / closes[len - 1 - n] - 1.0) * 100.0, 2)));

    out.set(u"vol20_annual_pct"_s, js::N(util::pyRound(bt::realizedVol(closes) * 100.0, 1)));

    if (len > 15) {
        const auto rsiLast = bt::rsi(closes, 14)[len - 1];
        if (rsiLast) out.set(u"rsi14"_s, js::N(util::pyRound(*rsiLast, 1)));
    }

    const std::pair<size_t, const char16_t*> smas[] = {{50, u"vs_sma50_pct"}, {200, u"vs_sma200_pct"}};
    for (const auto& [window, key] : smas) {
        if (len < window) continue;
        const auto smaLast = bt::sma(closes, double(window))[len - 1];
        if (smaLast && *smaLast != 0 && !std::isnan(*smaLast)) out.set(QString::fromUtf16(key), js::N(util::pyRound((last / *smaLast - 1.0) * 100.0, 2)));
    }

    if (len > 40) {
        const auto macd = bt::macdHist(closes)[len - 1];
        if (macd) out.set(u"macd_hist"_s, js::N(util::pyRound(*macd, 3)));
    }

    const size_t lookback = std::min<size_t>(bars.items.size(), 252);
    double hi = -std::numeric_limits<double>::infinity(), lo = std::numeric_limits<double>::infinity();
    for (size_t i = len - lookback; i < len; ++i) {
        hi = jm::max(hi, highs[i]);
        lo = jm::min(lo, lows[i]);
    }
    if (hi != 0 && !std::isnan(hi)) out.set(u"from_52w_high_pct"_s, js::N(util::pyRound((last / hi - 1.0) * 100.0, 2)));
    if (lo != 0 && !std::isnan(lo)) out.set(u"from_52w_low_pct"_s, js::N(util::pyRound((last / lo - 1.0) * 100.0, 2)));
    return out;
}

QString briefText(const std::optional<QString>& symbol, const OJson* brief) {
    if (!symbol || symbol->isEmpty()) return u"标的行情情报:(想法中未识别出标的,无行情数据)"_s;
    if (js::nullish(brief) || js::keys(brief).isEmpty()) return u"标的行情情报:(未连接券商网关或无法获取 %1 的行情数据)"_s.arg(*symbol);
    if (js::truthy(js::prop(brief, u"error"_s))) return u"标的行情情报:(获取 %1 行情失败:%2)"_s.arg(*symbol, js::str(js::prop(brief, u"error"_s)));

    QStringList lines{u"标的行情情报(%1,软件按日线计算,最新价可能有 15 分钟延迟):"_s.arg(*symbol)};
    static const std::array<std::array<const char16_t*, 3>, 12> labelMap{{
        {u"last", u"现价", u""},
        {u"chg_1d_pct", u"1日涨跌", u"%"},
        {u"chg_5d_pct", u"5日涨跌", u"%"},
        {u"chg_20d_pct", u"20日涨跌", u"%"},
        {u"chg_60d_pct", u"60日涨跌", u"%"},
        {u"vol20_annual_pct", u"20日已实现波动率(年化)", u"%"},
        {u"rsi14", u"RSI(14)", u""},
        {u"vs_sma50_pct", u"相对50日均线", u"%"},
        {u"vs_sma200_pct", u"相对200日均线", u"%"},
        {u"macd_hist", u"MACD柱(12/26/9)", u""},
        {u"from_52w_high_pct", u"距52周最高", u"%"},
        {u"from_52w_low_pct", u"距52周最低", u"%"},
    }};
    QStringList parts;
    for (const auto& [key, label, unit] : labelMap) {
        const OJson* v = js::prop(brief, QString::fromUtf16(key));
        if (!v) continue;  // key in brief
        parts << QString::fromUtf16(label) + u' ' + (js::isNum(v) ? util::pyFloat(v->n) : js::str(v)) + QString::fromUtf16(unit);
    }
    lines << parts.join(u";"_s);

    const OJson* anchor = js::prop(brief, u"anchor"_s);
    if (js::truthy(anchor)) {
        const OJson* chg = js::prop(anchor, u"chg_from_anchor_pct"_s);
        lines << u"价格锚点(按想法里的时间引用解析):%1 = %2;"_s.arg(js::str(js::prop(anchor, u"label"_s)), util::pyFloat(js::num(js::prop(anchor, u"price"_s)))) +
                     u"现价较锚点 %1%。"_s.arg(util::fmtSF(js::truthy(chg) ? js::num(chg) : 0.0, 2)) +
                     u"想法中的买入价指的是这个锚点价位,不是现价——请围绕锚点评估:"_s + u"按锚点算浮盈浮亏多少、现在追与等回调到锚点各意味着什么。"_s;
    }
    return lines.join(u'\n');
}

}  // namespace ibkr::analysis::research
