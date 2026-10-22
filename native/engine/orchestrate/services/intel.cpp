#include "orchestrate/services/intel.h"

#include "analysis/intel_items.h"
#include "domain/follow_inbox.h"
#include "domain/positions.h"
#include "execution/ib_link.h"
#include "orchestrate/services/svc_util.h"
#include "orchestrate/tracker.h"
#include "parsing/follow.h"
#include "parsing/shorthand.h"
#include "util/js_runtime.h"
#include "util/jsformat.h"
#include "util/jsnum.h"
#include "util/jsvalue.h"
#include "util/jsobj.h"
#include "util/rpc_error.h"
#include "util/tz.h"

#include <QDateTime>
#include <QRegularExpression>
#include <QTimeZone>

#include <algorithm>
#include <cmath>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using util::OJson;
using util::RpcError;
using util::Task;
namespace js = util::js;
namespace im = analysis::intel_items;
namespace sm = analysis::symbol_mentions;

namespace {

constexpr double kDayMs = 24 * 3600'000.0;
/// 持仓的缓存多久一换:档案与时间线都要它,一秒里问两次不该打两次券商
constexpr double kHeldTtlMs = 10'000;
constexpr double kLookbackMs = 30 * kDayMs;
constexpr double kSignalWindowMs = 90 * kDayMs;
constexpr double kFeedLimitDefault = 150;
constexpr double kFeedLimitMax = 500;
constexpr double kDossierTimelineDefault = 80;
constexpr int kPricedMax = 3;

QString isoMs(double ms) { return isoMsZ(ms); }

double clampLimit(const OJson* raw, double fallback) {
    const double n = js::nullish(raw) ? (raw ? 0.0 : std::nan("")) : js::num(raw);  // Number(undefined) = NaN,Number(null) = 0
    if (!std::isfinite(n) || n <= 0) return fallback;
    return std::fmin(kFeedLimitMax, std::floor(n));
}

bool validSymbol(const QString& s) {
    static const QRegularExpression re(u"^[A-Z][A-Z0-9.]{0,9}$"_s);
    return re.match(s).hasMatch();
}

QString jsUpper(const QString& s) { return s.toUpper(); }

QString strOrEmpty(const OJson* v) { return js::nullish(v) ? QString() : js::str(v); }

/// 券商没报盈亏、手上有现价时,按追踪器同一套口径本地算一份
OJson withPnl(const OJson& row) {
    const OJson* priceP = js::prop(&row, u"market_price"_s);
    const bool noPrice = js::nullish(priceP);
    if (!js::nullish(js::prop(&row, u"unrealized_pnl"_s)) || noPrice) return row;
    const auto numOr = [&](const QString& k, double dflt) {
        const double v = js::num(js::prop(&row, k));
        return (std::isnan(v) || v == 0) ? dflt : v;
    };
    OJson raw = js::object({{u"account"_s, js::copyOrNull(js::prop(&row, u"account"_s))},
                            {u"symbol"_s, js::copyOrNull(js::prop(&row, u"symbol"_s))},
                            {u"sec_type"_s, js::copyOrNull(js::prop(&row, u"sec_type"_s))},
                            {u"quantity"_s, js::N(numOr(u"quantity"_s, 0))},
                            {u"avg_cost"_s, js::N(numOr(u"avg_cost"_s, 0))},
                            {u"multiplier"_s, js::N(numOr(u"multiplier"_s, 1))},
                            {u"currency"_s, js::copyOrNull(js::prop(&row, u"currency"_s))},
                            {u"market_price"_s, *priceP}});
    // makePosition 的 `??`:null / undefined 取默认
    for (const QString& k : {u"account"_s, u"sec_type"_s, u"currency"_s}) {
        if (js::nullish(raw.get(k))) raw.fields.removeIf([&](const auto& f) { return f.first == k; });
    }
    const tracker::Position pos = tracker::makePosition(raw);
    const OJson out = tracker::unrealized(pos, js::num(priceP));
    OJson r = row;
    r.set(u"unrealized_pnl"_s, js::copyOrNull(js::prop(&out, u"unrealized_pnl"_s)));
    r.set(u"unrealized_pct"_s, js::copyOrNull(js::prop(&out, u"unrealized_pct"_s)));
    r.set(u"pnl_source"_s, js::S(u"computed"_s));
    return r;
}

}  // namespace

IntelService::IntelService(SvcHost& host, MarketDataService& market, EventsService& events, std::function<std::optional<double>(const QString&)> changePctOf)
    : SvcBase(host), market_(market), events_(events), changePctOf_(std::move(changePctOf)) {
    nowFn = [] { return util::dateNow(); };
}

bool IntelService::connected() {
    const auto r = routerPort();
    return r && r->hasSessions();
}

Task<QList<OJson>> IntelService::heldRows() {
    const auto router = routerPort();
    if (!router || !router->hasSessions()) {
        heldCache_.reset();
        co_return QList<OJson>{};
    }
    const double t = nowFn();
    if (heldCache_ && t - heldCache_->at < kHeldTtlMs) co_return heldCache_->rows;
    try {
        QList<OJson> rows;
        for (const OJson& r : domain::withCombos(co_await router->positions())) rows.append(withPnl(r));
        heldCache_ = HeldCache{t, rows};
        co_return rows;
    } catch (...) {
        co_return heldCache_ ? heldCache_->rows : QList<OJson>{};
    }
}

sm::Universe IntelService::universe(const QStringList& held) {
    QList<OJson> known;
    for (const QString& k : settings().index_symbols.keys()) known.append(js::S(k));
    for (const QString& h : held) known.append(js::S(h));
    for (const OJson& t : store().listTracks()) known.append(js::copyOrNull(js::prop(&t, u"symbol"_s)));
    for (const OJson& q : store().listQualityStocks()) known.append(js::copyOrNull(js::prop(&q, u"symbol"_s)));
    for (const OJson& s : store().listSectors()) {
        if (const OJson* stocks = js::prop(&s, u"stocks"_s))
            for (const OJson& x : stocks->items) known.append(js::copyOrNull(js::prop(&x, u"symbol"_s)));
    }
    for (const OJson& w : store().listWatches()) known.append(js::copyOrNull(js::prop(&w, u"symbol"_s)));
    OJson aliases = js::object();
    for (const QString& k : settings().symbol_aliases.keys()) aliases.set(k, js::S(settings().symbol_aliases.value(k)));
    const QStringList idx = settings().index_symbols.keys();
    return sm::makeUniverse(known, aliases, idx.isEmpty() ? u"SPX"_s : idx.first());
}

QSet<QString> IntelService::streaming(const QStringList& held) {
    QSet<QString> set;
    for (const QString& k : settings().index_symbols.keys()) set.insert(k);
    for (const QString& h : held) set.insert(h);
    for (const OJson& q : store().listQualityStocks())
        if (js::truthy(js::prop(&q, u"enabled"_s))) set.insert(js::str(js::prop(&q, u"symbol"_s)));
    for (const OJson& w : store().listWatches())
        if (js::truthy(js::prop(&w, u"enabled"_s))) set.insert(js::str(js::prop(&w, u"symbol"_s)));
    return set;
}

Task<contract::OrderedMap<std::optional<double>>> IntelService::pricesOf(QStringList symbols, QStringList held) {
    contract::OrderedMap<std::optional<double>> out;
    if (!connected() || symbols.isEmpty()) {
        for (const QString& s : symbols) out.insert(s, std::nullopt);
        co_return out;
    }
    const QSet<QString> ok = streaming(held);
    QStringList ask;
    for (const QString& s : symbols)
        if (ok.contains(s)) ask.append(s);
    for (const QString& s : symbols)
        if (!ok.contains(s)) out.insert(s, std::nullopt);
    if (ask.isEmpty()) co_return out;
    const auto quotes = co_await market_.quotesOf(ask);
    for (const QString& s : ask) {
        const auto it = quotes.find(s);
        out.insert(s, (it != quotes.end() && it->second) ? std::optional<double>(it->second->price) : std::nullopt);
    }
    co_return out;
}

Task<> IntelService::record(util::DiscordMessage message, bool trusted) {
    if (!trusted) co_return;
    try {
        if (store().messages().has(message.id)) co_return;
        const QList<OJson> heldRowsV = co_await heldRows();
        QStringList held;
        for (const OJson& r : heldRowsV) {
            const QString s = js::str(js::prop(&r, u"symbol"_s));
            if (!held.contains(s)) held.append(s);
        }
        const auto mentions = sm::extractMentions(message.content, universe(held));
        const QStringList symbols = sm::confidentSymbols(mentions);
        OJson prices = js::object();
        const auto priced = co_await pricesOf(symbols.mid(0, kPricedMax), held);
        for (const QString& s : priced.keys())
            if (priced.value(s)) prices.set(s, js::N(*priced.value(s)));
        OJson entry = js::object({{u"at"_s, js::S(util::utcIso(std::floor(message.sentAtMs / 1000) * 1000))},
                                  {u"source"_s, js::S(message.channel_id == domain::kLocalChannel ? u"local"_s : u"discord"_s)},
                                  {u"message_id"_s, js::S(message.id)},
                                  {u"author_id"_s, js::S(message.author_id)},
                                  {u"author_name"_s, js::S(message.author_name)},
                                  {u"text"_s, js::S(message.content)},
                                  {u"symbols"_s, js::strings(symbols)},
                                  {u"guesses"_s, js::strings(sm::guessedSymbols(mentions))},
                                  {u"trusted"_s, js::B(trusted)},
                                  {u"prices"_s, prices}});
        if (!store().messages().add(entry)) co_return;
        QStringList mine;
        for (const QString& s : symbols)
            if (held.contains(s)) mine.append(s);
        if (trusted && !mine.isEmpty()) {
            emitEvent(u"intel"_s, js::object({{u"kind"_s, js::S(u"held_mention"_s)},
                                              {u"message_id"_s, js::S(message.id)},
                                              {u"at"_s, js::N(message.sentAtMs)},
                                              {u"author_name"_s, js::S(message.author_name)},
                                              {u"text"_s, js::S(message.content.left(200))},
                                              {u"symbols"_s, js::strings(mine)},
                                              {u"prices"_s, prices}}));
        } else {
            emitEvent(u"intel"_s, js::object({{u"kind"_s, js::S(u"message"_s)}, {u"message_id"_s, js::S(message.id)}, {u"symbols"_s, js::strings(symbols)}}));
        }
    } catch (...) {
        execution::logStderr(u"[intel] 记消息 %1 出错:%2"_s.arg(message.id, errMessage(std::current_exception())));
    }
}

QList<OJson> IntelService::recordFacts(double limit) {
    QList<OJson> out;
    static const OJson emptyObj = js::object();
    const auto objOr = [&](const OJson* v) -> const OJson& { return js::nullish(v) ? emptyObj : *v; };
    for (const OJson& r : store().listRecords(limit)) {
        const OJson& ibkr = objOr(js::prop(&r, u"ibkr"_s));
        const OJson* tl = js::prop(&ibkr, u"status_timeline"_s);
        const OJson* last = (js::isArr(tl) && !tl->items.isEmpty()) ? &tl->items.last() : nullptr;
        const OJson* fills = js::prop(&ibkr, u"fills"_s);
        const OJson* avg = js::prop(&ibkr, u"avg_fill_price"_s);
        const OJson& order = objOr(js::prop(&r, u"order"_s));
        const OJson& input = objOr(js::prop(&r, u"input"_s));
        double q = js::num(js::prop(&order, u"quantity"_s));
        OJson lastStatus = js::Null();
        if (last) {
            const QString s = strOrEmpty(js::prop(last, u"status"_s));
            if (!s.isEmpty()) lastStatus = js::S(s);
        }
        const OJson* fs = js::prop(&r, u"final_status"_s);
        out.append(js::object({{u"id"_s, js::S(strOrEmpty(js::prop(&r, u"id"_s)))},
                               {u"created_at"_s, js::S(strOrEmpty(js::prop(&r, u"created_at"_s)))},
                               {u"symbol"_s, js::S(jsUpper(strOrEmpty(js::prop(&objOr(js::prop(&r, u"contract"_s)), u"symbol"_s))))},
                               {u"action"_s, js::S(strOrEmpty(js::prop(&order, u"action"_s)))},
                               {u"quantity"_s, (std::isnan(q) || q == 0) ? js::Null() : js::N(q)},
                               {u"account"_s, js::S(strOrEmpty(js::prop(&objOr(js::prop(&r, u"account"_s)), u"alias"_s)))},
                               {u"intent_summary"_s, js::S(strOrEmpty(js::prop(&objOr(js::prop(&r, u"llm"_s)), u"intent_summary"_s)))},
                               {u"raw_instruction"_s, js::S(strOrEmpty(js::prop(&input, u"raw_instruction"_s)))},
                               {u"final_status"_s, js::copyOrNull(fs)},
                               {u"last_status"_s, lastStatus},
                               {u"fills"_s, js::N(js::isArr(fills) ? fills->items.size() : 0)},
                               {u"avg_fill_price"_s, js::isNum(avg) ? *avg : js::Null()},
                               {u"channel"_s, js::S(strOrEmpty(js::prop(&input, u"input_channel"_s)))}}));
    }
    return out;
}

Task<QList<OJson>> IntelService::eventRows() {
    try {
        const OJson r = co_await events_.list(false);
        co_return js::prop(&r, u"events"_s)->items;
    } catch (...) {
        co_return QList<OJson>{};
    }
}

QStringList IntelService::eventSymbols(const OJson& event, const sm::Universe& universe) {
    if (js::str(js::prop(&event, u"source"_s)) != u"custom") {
        const QStringList idx = settings().index_symbols.keys();
        return idx.isEmpty() ? QStringList{u"SPX"_s} : idx;
    }
    sm::Universe u = universe;
    u.implied.reset();
    return sm::confidentSymbols(sm::extractMentions(js::str(js::prop(&event, u"title"_s)) + u' ' + strOrEmpty(js::prop(&event, u"note"_s)), u));
}

Task<OJson> IntelService::feed(OJson params) {
    const double limit = clampLimit(js::prop(&params, u"limit"_s), kFeedLimitDefault);
    const OJson* symP = js::prop(&params, u"symbol"_s);
    std::optional<QString> symbol;
    if (js::truthy(symP)) {
        QString t = js::str(symP);
        qsizetype a = 0, b = t.size();
        while (a < b && util::isJsWhitespace(t[a])) ++a;
        while (b > a && util::isJsWhitespace(t[b - 1])) --b;
        symbol = t.mid(a, b - a).toUpper();
    }
    if (symP && symbol && !validSymbol(*symbol)) throw RpcError(-32602, u"股票代码不合法"_s);
    const double nowMs = nowFn();
    const QList<OJson> heldRowsV = co_await heldRows();
    QStringList held;
    for (const OJson& r : heldRowsV) {
        const QString s = js::str(js::prop(&r, u"symbol"_s));
        if (!held.contains(s)) held.append(s);
    }
    const QSet<QString> heldSet(held.begin(), held.end());
    const sm::Universe uni = universe(held);
    const QString sinceIso = isoMs(nowMs - kLookbackMs);

    OJson opts = js::object({{u"limit"_s, js::N(std::fmin(limit * 2, 1000))}, {u"symbol"_s, symbol ? js::S(*symbol) : js::Null()}});
    const QList<OJson> rows = store().messages().recent(opts);
    QStringList ids;
    for (const OJson& r : rows) ids.append(js::str(js::prop(&r, u"message_id"_s)));
    QHash<QString, OJson> verdicts;
    for (const auto& [k, v] : store().follow().verdictsFor(ids)) verdicts.insert(k, v);
    QStringList priceSymbols;
    for (const OJson& r : rows) {
        const OJson* syms = js::prop(&r, u"symbols"_s);
        const OJson* first = (js::isArr(syms) && !syms->items.isEmpty()) ? &syms->items[0] : nullptr;
        if (first && js::truthy(first) && js::isNum(js::prop(js::prop(&r, u"prices"_s), js::str(first)))) {
            if (!priceSymbols.contains(js::str(first))) priceSymbols.append(js::str(first));
        }
    }
    const auto nowPricesMap = co_await pricesOf(priceSymbols, held);
    OJson nowPrices = js::object();
    for (const QString& k : nowPricesMap.keys()) nowPrices.set(k, nowPricesMap.value(k) ? js::N(*nowPricesMap.value(k)) : js::Null());
    QList<OJson> messages;
    for (const OJson& r : rows) {
        const QString text = parsing::follow::orderText(js::str(js::prop(&r, u"text"_s)));
        const auto it = verdicts.constFind(js::str(js::prop(&r, u"message_id"_s)));
        messages.append(im::messageItem(r, it == verdicts.cend() ? nullptr : &it.value(), heldSet, nowPrices,
                                        parsing::shorthand::looksLikeOrder(text) ? std::optional<QString>(text) : std::nullopt));
    }
    QList<OJson> sigItems;
    for (const OJson& s : store().signalLog().listWithSeq(sinceIso, 2000)) sigItems.append(im::signalItem(s, heldSet));
    QList<OJson> events;
    for (const OJson& e : co_await eventRows()) events.append(im::eventItem(e, eventSymbols(e, uni), heldSet, nowMs));
    QList<OJson> orders;
    for (const OJson& r : recordFacts(300)) {
        const double created = util::jsDateParse(js::str(js::prop(&r, u"created_at"_s)));
        if (created >= nowMs - kLookbackMs) orders.append(im::recordItem(r, heldSet));
    }
    QList<OJson> ideas;
    sm::Universe noImplied = uni;
    noImplied.implied.reset();
    for (const OJson& i : store().listIdeas(std::nullopt, 200))
        ideas.append(im::ideaItem(i, sm::confidentSymbols(sm::extractMentions(js::str(js::prop(&i, u"text"_s)), noImplied)), heldSet));

    im::FeedFilter filter;
    filter.symbol = symbol;
    if (const OJson* k = js::prop(&params, u"kinds"_s); js::isArr(k)) {
        QStringList kinds;
        for (const OJson& x : k->items) kinds.append(js::str(&x));
        filter.kinds = kinds;
    }
    filter.heldOnly = js::truthy(js::prop(&params, u"held_only"_s));
    if (const OJson* s = js::prop(&params, u"since"_s); !js::nullish(s)) filter.since = js::num(s);
    filter.limit = limit;
    const QList<OJson> items = im::mergeItems({messages, sigItems, events, orders, ideas}, filter);
    co_return js::object({{u"items"_s, js::array(items)},
                          {u"held"_s, js::strings(held)},
                          {u"total_messages"_s, js::N(store().messages().count())},
                          {u"at"_s, js::N(nowMs)},
                          {u"connected"_s, js::B(connected())}});
}

Task<std::optional<OJson>> IntelService::quoteFor(QString symbol, QStringList held) {
    if (!connected()) co_return std::nullopt;
    const bool isIndex = settings().indexConfig(symbol) != nullptr;
    if (isIndex) {
        const auto q = co_await market_.quoteOf(symbol);
        if (!q) co_return std::nullopt;
        co_return js::object({{u"price"_s, js::N(q->price)}, {u"change_pct"_s, js::Null()}, {u"source"_s, js::S(q->source.isEmpty() ? u"index"_s : q->source)}});
    }
    if (!streaming(held).contains(symbol)) {
        // 没在订的票不另开线路:给最近两根日线的收盘(缓存 10 分钟)
        try {
            QList<OJson> bars;
            for (const OJson& b : co_await market_.dailyHistory(symbol))
                if (js::num(js::prop(&b, u"close"_s)) > 0) bars.append(b);
            if (bars.isEmpty()) co_return std::nullopt;
            const double close = js::num(js::prop(&bars.last(), u"close"_s));
            const OJson* prevBar = bars.size() >= 2 ? &bars[bars.size() - 2] : nullptr;
            const double pc = prevBar ? js::num(js::prop(prevBar, u"close"_s)) : 0;
            const bool hasPc = prevBar && pc != 0 && !std::isnan(pc);
            co_return js::object({{u"price"_s, js::N(close)},
                                  {u"change_pct"_s, hasPc ? js::N(util::jsRound((close - pc) / pc * 10000) / 100) : js::Null()},
                                  {u"source"_s, js::S(u"daily_close"_s)}});
        } catch (...) {
            co_return std::nullopt;
        }
    }
    const auto q = co_await market_.quoteOf(symbol);
    if (!q) co_return std::nullopt;
    const std::optional<double> change = changePctOf_ ? changePctOf_(symbol) : std::nullopt;
    co_return js::object({{u"price"_s, js::N(q->price)}, {u"change_pct"_s, js::NOrNull(change)}, {u"source"_s, js::S(u"quote"_s)}});
}

Task<OJson> IntelService::dossier(OJson params) {
    const OJson* symP = js::prop(&params, u"symbol"_s);
    QString raw = js::nullish(symP) ? QString() : js::str(symP);
    qsizetype a = 0, b = raw.size();
    while (a < b && util::isJsWhitespace(raw[a])) ++a;
    while (b > a && util::isJsWhitespace(raw[b - 1])) --b;
    const QString symbol = raw.mid(a, b - a).toUpper();
    if (!validSymbol(symbol)) throw RpcError(-32602, u"股票代码不合法"_s);
    const double nowMs = nowFn();
    const QList<OJson> heldRowsV = co_await heldRows();
    QStringList held;
    for (const OJson& r : heldRowsV) {
        const QString s = js::str(js::prop(&r, u"symbol"_s));
        if (!held.contains(s)) held.append(s);
    }
    QList<OJson> positions;
    for (const OJson& r : heldRowsV)
        if (js::str(js::prop(&r, u"symbol"_s)) == symbol) positions.append(r);
    QList<OJson> tracks;
    for (const OJson& t : store().listTracks())
        if (js::str(js::prop(&t, u"symbol"_s)).toUpper() == symbol) tracks.append(t);
    OJson working = js::array();
    {
        int n = 0;
        for (const OJson& w : store().listWorkingRecords(7, nowMs)) {
            if (js::str(js::prop(&w, u"symbol"_s)).toUpper() != symbol) continue;
            if (n++ >= 20) break;
            const auto rec = store().getRecord(js::str(js::prop(&w, u"id"_s)));
            static const OJson emptyObj = js::object();
            const OJson& r = rec ? *rec : emptyObj;
            const OJson* llm = js::prop(&r, u"llm"_s);
            const OJson* sum = js::prop(llm, u"intent_summary"_s);
            if (js::nullish(sum)) sum = js::prop(js::prop(&r, u"input"_s), u"raw_instruction"_s);
            const double created = js::num(js::prop(&w, u"createdAtMs"_s));
            working.items.append(js::object({{u"id"_s, js::copyOrNull(js::prop(&w, u"id"_s))},
                                             {u"at"_s, js::S((created != 0 && !std::isnan(created)) ? util::utcIso(created) : QString())},
                                             {u"status"_s, js::copyOrNull(js::prop(&w, u"lastStatus"_s))},
                                             {u"summary"_s, js::S(strOrEmpty(sum))},
                                             {u"account"_s, js::S(strOrEmpty(js::prop(js::prop(&r, u"account"_s), u"alias"_s)))}}));
        }
    }
    OJson sectors = js::array();
    for (const OJson& s : store().listSectors()) {
        const OJson* stocks = js::prop(&s, u"stocks"_s);
        bool any = false;
        if (stocks)
            for (const OJson& x : stocks->items)
                if (js::str(js::prop(&x, u"symbol"_s)).toUpper() == symbol) any = true;
        if (any) sectors.items.append(js::copyOrNull(js::prop(&s, u"name"_s)));
    }
    const auto lastN = [](const OJson* arr, int n) {
        OJson out = js::array();
        if (js::isArr(arr)) {
            const qsizetype from = std::max<qsizetype>(0, arr->items.size() - n);
            for (qsizetype i = from; i < arr->items.size(); ++i) out.items.append(arr->items[i]);
        }
        return out;
    };
    OJson watch = js::Null();
    for (const OJson& w : store().listWatches()) {
        if (js::str(js::prop(&w, u"symbol"_s)).toUpper() != symbol) continue;
        watch = js::object({{u"enabled"_s, js::copyOrNull(js::prop(&w, u"enabled"_s))},
                            {u"levels"_s, js::copyOrNull(js::prop(&w, u"levels"_s))},
                            {u"last_price"_s, js::copyOrNull(js::prop(&w, u"last_price"_s))},
                            {u"events"_s, lastN(js::prop(&w, u"events"_s), 10)}});
        break;
    }
    OJson quality = js::Null();
    for (const OJson& q : store().listQualityStocks()) {
        if (js::str(js::prop(&q, u"symbol"_s)).toUpper() != symbol) continue;
        const std::optional<double> change = changePctOf_ ? changePctOf_(symbol) : std::nullopt;
        const OJson* en = js::prop(&q, u"enabled"_s);
        quality = js::object({{u"enabled"_s, js::B(js::isNum(en) && en->n == 1)}, {u"events"_s, lastN(js::prop(&q, u"events"_s), 10)}, {u"change_pct"_s, js::NOrNull(change)}});
        break;
    }
    const sm::Universe uni = universe(held);
    sm::Universe noImplied = uni;
    noImplied.implied.reset();
    OJson ideas = js::array();
    for (const OJson& i : store().listIdeas(std::nullopt, 500)) {
        bool hit = false;
        if (const OJson* ss = js::prop(&i, u"symbols"_s))
            for (const OJson& s : ss->items)
                if (js::str(&s).toUpper() == symbol) hit = true;
        if (!hit) hit = sm::confidentSymbols(sm::extractMentions(js::str(js::prop(&i, u"text"_s)), noImplied)).contains(symbol);
        if (hit) {
            if (ideas.items.size() >= 20) break;
            ideas.items.append(i);
        }
    }
    const bool isIndex = settings().indexConfig(symbol) != nullptr;
    OJson events = js::array();
    for (const OJson& e : co_await eventRows()) {
        if (!(js::num(js::prop(&e, u"at"_s)) >= nowMs - 2 * 3600'000.0)) continue;
        const bool keep = isIndex ? js::str(js::prop(&e, u"source"_s)) != u"custom" : eventSymbols(e, uni).contains(symbol);
        if (keep) events.items.append(e);
    }
    struct Count {
        QString source;
        double n = 0;
        QString lastAt;
    };
    QList<Count> counts;
    for (const OJson& s : store().signalLog().list(isoMs(nowMs - kSignalWindowMs), 20'000)) {
        if (js::str(js::prop(&s, u"symbol"_s)).toUpper() != symbol) continue;
        const QString src = js::str(js::prop(&s, u"source"_s));
        const QString at = js::str(js::prop(&s, u"at"_s));
        auto it = std::find_if(counts.begin(), counts.end(), [&](const Count& c) { return c.source == src; });
        if (it != counts.end()) {
            it->n += 1;
            if (at > it->lastAt) it->lastAt = at;
        } else {
            counts.append({src, 1, at});
        }
    }
    std::stable_sort(counts.begin(), counts.end(), [](const Count& x, const Count& y) { return x.n > y.n; });
    OJson timelineParams = js::object({{u"symbol"_s, js::S(symbol)}, {u"limit"_s, js::N(clampLimit(js::prop(&params, u"limit"_s), kDossierTimelineDefault))}});
    const OJson tl = co_await feed(timelineParams);
    const OJson timeline = *js::prop(&tl, u"items"_s);
    const std::optional<OJson> quote = co_await quoteFor(symbol, held);
    OJson signalsJson = js::array();
    for (const Count& c : counts) signalsJson.items.append(js::object({{u"source"_s, js::S(c.source)}, {u"n"_s, js::N(c.n)}, {u"last_at"_s, js::S(c.lastAt)}}));
    co_return js::object({{u"symbol"_s, js::S(symbol)},
                          {u"quote"_s, quote ? *quote : js::Null()},
                          {u"held"_s, js::B(held.contains(symbol))},
                          {u"positions"_s, js::array(positions)},
                          {u"tracks"_s, js::array(tracks)},
                          {u"working"_s, working},
                          {u"sectors"_s, sectors},
                          {u"watch"_s, watch},
                          {u"quality"_s, quality},
                          {u"ideas"_s, ideas},
                          {u"events"_s, events},
                          {u"signals"_s, signalsJson},
                          {u"mentions_7d"_s, js::N(store().messages().countSince(isoMs(nowMs - 7 * kDayMs), symbol))},
                          {u"timeline"_s, timeline},
                          {u"at"_s, js::N(nowMs)},
                          {u"connected"_s, js::B(connected())}});
}

}  // namespace ibkr::orchestrate
