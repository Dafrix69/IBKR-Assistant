#include "orchestrate/services/market_data.h"

#include "analysis/optionwall.h"
#include "domain/positions.h"
#include "execution/broker_pricing.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/rpc_error.h"

#include <QDate>

#include <algorithm>
#include <cmath>
#include <limits>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using execution::BrokerError;
using util::OJson;
using util::RpcError;
using util::Task;
namespace js = util::js;

namespace {

/// count():value 是正的有限数才算,否则空
std::optional<double> count(const OJson* value) {
    if (js::nullish(value)) return std::nullopt;
    const double n = js::num(value);
    return std::isfinite(n) && n > 0 ? std::optional<double>(n) : std::nullopt;
}

/// 常驻报价流的一格 → SpotQuote;没有价回空
std::optional<SpotQuote> spotQuoteOf(const OJson* quote) {
    const OJson* price = js::prop(quote, u"last"_s);
    if (!js::isNum(price) || !(price->n > 0)) return std::nullopt;
    SpotQuote out;
    out.price = price->n;
    const OJson* at = js::prop(quote, u"last_trade_at"_s);
    if (js::isNum(at) && std::isfinite(at->n) && at->n > 0) out.tradedAt = at->n;
    return out;
}

QString numStr(double v) { return util::jsNumberToString(v); }

}  // namespace

OJson coverageOf(const QList<double>& strikes, const OJson* asked, const OJson* gridCount) {
    const std::optional<double> grid = count(gridCount);
    const std::optional<double> wanted = count(asked);
    double lower = std::numeric_limits<double>::infinity(), upper = -std::numeric_limits<double>::infinity();
    for (double s : strikes) {
        lower = std::fmin(lower, s);
        upper = std::fmax(upper, s);
    }
    return js::object({{u"lower"_s, js::N(lower)},
                       {u"upper"_s, js::N(upper)},
                       {u"strikes"_s, js::N(strikes.size())},
                       {u"grid_strikes"_s, js::NOrNull(grid)},
                       {u"thinned"_s, js::B(grid && wanted && *wanted < *grid)}});
}

QStringList thinnedWarning(const OJson& coverage) {
    if (!js::truthy(js::prop(&coverage, u"thinned"_s))) return {};
    return {u"行权价是抽着取的:%1–%2 这一段链上有 %3 档,行情线路只够取其中一部分——"_s.arg(js::str(js::prop(&coverage, u"lower"_s)), js::str(js::prop(&coverage, u"upper"_s)),
                                                                    js::str(js::prop(&coverage, u"grid_strikes"_s))) +
            u"现价附近每档都取,越远只取越整的档。墙、净 GEX、翻转位、最大痛点只算了取到的这些。"_s};
}

Task<OJson> MarketDataService::wallFor(QString symbol, std::optional<QString> expiry, double width, std::optional<double> span, QString preferClass) {
    const std::optional<double> want = (span && *span > 0) ? span : std::nullopt;
    const QString key = symbol + u'|' + expiry.value_or(QString()) + u'|' + numStr(std::trunc(width) + 0.0) + u'|' + (want ? u"span"_s : QString()) + u'|' + preferClass;
    const double now = rt().perfMs();
    if (const auto it = wallCache_.constFind(key); it != wallCache_.cend()) {
        const WallEntry& hit = it.value();
        if (now - hit.at < kWallTtlMs && (!want || hit.span.value_or(0) >= *want)) co_return hit.wall;
    }
    const auto router = routerPort();
    if (!router || !router->hasSessions()) throw needConnection(-32017, u"计算期权墙"_s);
    OJson result;
    try {
        const OJson chain = co_await router->optionChain(symbol, expiry, width, want, preferClass);
        const OJson* rowsP = js::prop(&chain, u"rows"_s);
        if (!js::isArr(rowsP)) throw util::JsError(u"rows is not iterable"_s);
        const OJson* multiplier = js::prop(&chain, u"multiplier"_s);
        const OJson* tradingClass = js::prop(&chain, u"trading_class"_s);
        const double spot = js::num(js::prop(&chain, u"spot"_s)), mult = js::nullish(multiplier) ? 100.0 : js::num(multiplier), nowMs = domain::nowEt().epochMs;
        const QString chainExpiry = js::str(js::prop(&chain, u"expiry"_s)), cls = js::nullish(tradingClass) ? QString() : js::str(tradingClass);
        OJson core = analysis::optionwall::analyze(rowsP->items, spot, chainExpiry, symbol, mult, nowMs, cls);
        const OJson gexWalls = analysis::optionwall::gexWalls(analysis::optionwall::toRows(rowsP->items), spot,
                                                              analysis::optionwall::yearsToExpiry(chainExpiry, nowMs, symbol, cls), mult);
        QList<double> strikes;
        if (const OJson* ss = js::prop(&core, u"strikes"_s); js::isArr(ss))
            for (const OJson& st : ss->items) strikes.append(js::num(js::prop(&st, u"strike"_s)));
        const OJson coverage = coverageOf(strikes, js::prop(&chain, u"strike_count"_s), js::prop(&chain, u"grid_count"_s));
        OJson warnings = js::array();
        if (const OJson* w = js::prop(&core, u"warnings"_s); js::isArr(w)) warnings.items = w->items;
        for (const QString& t : thinnedWarning(coverage)) warnings.items.append(js::S(t));
        const OJson* expiries = js::prop(&chain, u"expiries"_s);
        const OJson* spotSource = js::prop(&chain, u"spot_source"_s);
        result = core;
        result.set(u"warnings"_s, warnings);
        result.set(u"expiries"_s, js::nullish(expiries) ? js::array() : *expiries);
        result.set(u"spot_source"_s, js::nullish(spotSource) ? js::S(u"quote"_s) : *spotSource);
        result.set(u"coverage"_s, coverage);
        result.set(u"gex_walls"_s, gexWalls);
    } catch (const BrokerError& exc) {
        throw RpcError(-32017, exc.message());
    } catch (const analysis::optionwall::OptionWallError& exc) {
        throw RpcError(-32017, exc.message());
    }
    wallCache_.insert(key, WallEntry{now, result, want});
    co_return result;
}

Task<QList<OJson>> MarketDataService::dailyHistory(QString symbol, double spanDays) {
    double trunc = std::trunc(spanDays);
    if (std::isnan(trunc)) trunc = 0;  // Math.trunc(x) || 0
    const double span = std::max(trunc, double(kHistSpanDays));
    const double now = rt().perfMs();
    const QString end = domain::nowEt().date;
    const QString start = QDate::fromString(end, Qt::ISODate).addDays(-qint64(span)).toString(Qt::ISODate);
    if (const auto it = histCache_.constFind(symbol); it != histCache_.cend()) {
        const HistEntry& hit = it.value();
        if (now - hit.at < kHistTtlMs && hit.span >= span) {
            if (hit.span == span) co_return hit.bars;
            QList<OJson> out;
            for (const OJson& b : hit.bars) {
                const OJson* d = js::prop(&b, u"date"_s);
                const OJson* v = js::nullish(d) ? js::prop(&b, u"time"_s) : d;
                const QString s = js::nullish(v) ? QString() : js::str(v);
                if (s.left(10) >= start) out.append(b);
            }
            co_return out;
        }
    }
    const auto router = routerPort();
    if (!router || !router->hasSessions()) throw needConnection(-32017, u"计算均线与52周位"_s);
    const double askedAt = domain::nowEt().epochMs;
    QList<OJson> bars;
    try {
        bars = co_await router->historicalBars(symbol, start, end);
    } catch (const BrokerError& exc) {
        throw RpcError(-32017, exc.message());
    }
    histCache_.insert(symbol, HistEntry{now, bars, span, askedAt});
    co_return bars;
}

std::optional<double> MarketDataService::dailyHistoryAskedAt(const QString& symbol) const {
    const auto it = histCache_.constFind(symbol);
    if (it == histCache_.cend()) return std::nullopt;
    return it.value().askedAt;
}

Task<std::optional<double>> MarketDataService::spotOf(QString symbol) {
    const auto q = co_await quoteOf(std::move(symbol));
    if (!q) co_return std::nullopt;
    co_return q->price;
}

Task<std::optional<SpotQuote>> MarketDataService::quoteOf(QString symbol) {
    const auto router = routerPort();
    if (!router || !router->hasSessions()) co_return std::nullopt;
    try {
        if (settings().indexConfig(symbol)) {
            const std::optional<double> price = co_await router->indexPrice(symbol);
            if (!price || *price == 0 || std::isnan(*price)) co_return std::nullopt;
            // router 每次现取:await 期间宿主可能已经把它拿掉了(TS 的 this.router 为空时 .spotInfo 抛 TypeError,下面的 catch 吞成「取不到」)
            const auto now = routerPort();
            if (!now) throw util::JsError(u"Cannot read properties of null (reading 'spotInfo')"_s);
            const auto info = now->spotInfo(symbol);
            const OJson* src = info ? js::prop(&*info, u"source"_s) : nullptr;
            SpotQuote q;
            q.price = *price;
            q.source = js::nullish(src) ? u"index"_s : js::str(src);
            co_return q;
        }
        const OJson quotes = co_await router->streamQuotes({symbol});
        co_return spotQuoteOf(js::prop(&quotes, symbol));
    } catch (...) {
        co_return std::nullopt;  // 取价失败只是这一轮不检查
    }
}

Task<std::map<QString, std::optional<SpotQuote>>> MarketDataService::quotesOf(QStringList symbols) {
    const QuoteMap ordered = co_await quotesOfOrdered(std::move(symbols));
    std::map<QString, std::optional<SpotQuote>> out;
    for (const QString& k : ordered.keys()) out[k] = ordered.value(k);
    co_return out;
}

Task<QuoteMap> MarketDataService::quotesOfOrdered(QStringList symbols) {
    QStringList unique;
    for (const QString& s : symbols)
        if (!unique.contains(s)) unique.append(s);
    QuoteMap out;
    const auto router = routerPort();
    if (!router || !router->hasSessions()) {
        for (const QString& s : unique) out.insert(s, std::nullopt);
        co_return out;
    }
    QStringList plain;
    for (const QString& s : unique) {
        if (settings().indexConfig(s)) out.insert(s, co_await quoteOf(s));
        else plain.append(s);
    }
    if (plain.isEmpty()) co_return out;
    OJson quotes;
    bool failed = false;
    try {
        // router 每次现取(上面逐只问指数期间它可能没了):空 → TS 的 TypeError,退回逐只问
        const auto now = routerPort();
        if (!now) throw util::JsError(u"Cannot read properties of null (reading 'streamQuotes')"_s);
        quotes = co_await now->streamQuotes(plain);
    } catch (...) {
        failed = true;
    }
    if (failed) {
        for (const QString& s : plain) out.insert(s, co_await quoteOf(s));
        co_return out;
    }
    if (js::nullish(&quotes)) quotes = js::object();
    for (const QString& s : plain) out.insert(s, spotQuoteOf(js::prop(&quotes, s)));
    co_return out;
}

Task<PaBars> MarketDataService::paBars(QString symbol, QString timeframe, bool rth, bool force, bool indexProxy) {
    const OJson* spec = domain::timeframes().get(timeframe);
    double ttlS = kPaMinInterval;
    if (!force) {
        if (!spec) throw util::JsError(u"Cannot read properties of undefined (reading 'seconds')"_s);
        ttlS = std::fmax(kPaMinInterval, std::fmin(js::num(js::prop(spec, u"seconds"_s)) / 10.0, 60.0));
    }
    const QString key = symbol + u'|' + timeframe + u'|' + (rth ? u"true"_s : u"false"_s) + u'|' + (indexProxy ? u"true"_s : u"false"_s);
    const double now = rt().perfMs();
    if (const auto it = paCache_.constFind(key); it != paCache_.cend()) {
        const PaEntry& hit = it.value();
        if (now - hit.at < ttlS * 1000) co_return PaBars{hit.bars, true, hit.askedAt, hit.bars.feed};
    }
    const double askedAt = domain::nowEt().epochMs;
    const auto router = routerPort();
    if (!router) throw util::JsError(u"Cannot read properties of null (reading 'intradayBars')"_s);
    execution::TaggedBars bars = co_await router->intradayBars(symbol, timeframe, rth, std::nullopt, indexProxy);
    paCache_.insert(key, PaEntry{now, bars, askedAt});
    co_return PaBars{bars, false, askedAt, bars.feed};
}

}  // namespace ibkr::orchestrate
