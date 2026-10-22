#include "analysis/macro.h"

#include "util/error.h"
#include "util/js_runtime.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/market_js.h"
#include "util/py.h"

#include <QHash>
#include <QSet>

#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
using ibkr::util::Task;
namespace js = ibkr::util::js;

namespace ibkr::analysis::macro {

namespace {
const QString kEndpoint = u"https://query1.finance.yahoo.com/v8/finance/chart/%s?interval=1d&range=5d"_s;
const QString kCboeEndpoint = u"https://cdn.cboe.com/api/global/delayed_quotes/quotes/_%s.json"_s;
constexpr double kTtlIdle = 60.0;
constexpr double kTtlLive = 10.0;
// 陈旧即返、后台刷新:过期但没老到没用的格子先把旧值交出去,新值在后台取;只有从来没取到过的格子才同步等
constexpr double kMaxStale = 600.0;

using Row = std::shared_ptr<OJson>;
/// 行情带的整格,和 publicIndexPrice 那边只存了个价的快照,共用这张表(后者一律带 "cboe:" 前缀)
struct CacheHit {
    double at = 0;
    Row row;
};
QHash<QString, CacheHit>& cache() {
    static QHash<QString, CacheHit> c;
    return c;
}
QSet<QString>& inflight() {
    static QSet<QString> s;
    return s;
}

/// String.prototype.replace("%s", x):只换第一个
QString fill(const QString& tpl, const QString& x) {
    QString s = tpl;
    const qsizetype i = s.indexOf(u"%s"_s);
    return i < 0 ? s : s.replace(i, 2, x);
}

/// Number(value),null / undefined / NaN 回空
std::optional<double> num(const OJson* value) {
    const double v = js::num(value);
    if (js::nullish(value) || std::isnan(v)) return std::nullopt;
    return v;
}
OJson optN(const std::optional<double>& v) { return v ? js::N(*v) : OJson::null(); }
bool hasLast(const OJson& row) { return !js::nullish(row.get(u"last"_s)); }

/// {...row, 再加几个 true 的键}
Row spread(const Row& row, std::initializer_list<const char16_t*> flags) {
    auto out = std::make_shared<OJson>(*row);
    for (const char16_t* f : flags) out->set(QString::fromUtf16(f), js::B(true));
    return out;
}

void refreshInBackground(const QString& key, const std::function<Task<Row>()>& fetchRow, const std::function<double()>& now) {
    if (inflight().contains(key)) return;  // 单飞:同一键同一时刻只允许一个后台请求
    inflight().insert(key);
    const Task<Row> t = fetchRow();
    t.onDone([t, key, now] {
        // 后台刷新失败只是这一轮没更新,下一轮再试
        if (!t.error()) {
            const Row row = t.result();
            if (row && hasLast(*row)) cache().insert(key, {now(), row});
        }
        inflight().remove(key);
    });
}

// Yahoo 挂了还能救回来的格子:同一条指数,Cboe 官方延迟接口就有。TNX 同一个 10 倍口径
struct CboeEntry {
    QString sym;
    double scale = 1;
};
std::optional<CboeEntry> macroCboe(const QString& key) {
    if (key == u"^GSPC") return CboeEntry{u"SPX"_s};
    if (key == u"^NDX") return CboeEntry{u"NDX"_s};
    if (key == u"^VIX") return CboeEntry{u"VIX"_s};
    if (key == u"^TNX") return CboeEntry{u"TNX"_s, 0.1};
    // MACRO_CBOE[key] 在 Object.prototype 上找得到(constructor…):真,sym 是 undefined
    if (util::market::onObjectPrototype(key)) return CboeEntry{u"undefined"_s};
    return std::nullopt;
}

Task<std::optional<OJson>> fetchCboeRow(QString macroKey, double timeout, Fetcher fetcher) {
    const auto entry = macroCboe(macroKey);
    if (!entry) co_return std::nullopt;
    const OJson payload = co_await fetcher(fill(kCboeEndpoint, entry->sym), timeout * 1000);
    const auto last = cboeLast(&payload);
    if (!last) co_return std::nullopt;
    const OJson* data = js::prop(&payload, u"data"_s);
    const auto prev = num(js::prop(data, u"close"_s));
    const auto change = num(js::prop(data, u"price_change"_s));
    const std::optional<double> changePct =
        prev && *prev != 0 && change ? std::optional(util::pyRound((*change / *prev) * 100.0, 2)) : std::nullopt;
    co_return js::object({{u"last"_s, js::N(entry->scale == 1 ? *last : util::pyRound(*last * entry->scale, 4))}, {u"change_pct"_s, optN(changePct)}});
}

QString errorText(const QString& message) {
    // 记消息不记 name(e?.message || e?.name || "Error"):这里的错都是 Error
    return (message.isEmpty() ? u"Error"_s : message).left(120);
}

Task<Row> fetchOne(OJson item, double timeout, Fetcher fetcher) {
    auto row = std::make_shared<OJson>(js::object({{u"key"_s, js::copyOrNull(item.get(u"key"_s))},
                                                   {u"label"_s, js::copyOrNull(item.get(u"label"_s))},
                                                   {u"fmt"_s, js::copyOrNull(item.get(u"fmt"_s))},
                                                   {u"last"_s, OJson::null()},
                                                   {u"change_pct"_s, OJson::null()}}));
    const QString key = js::str(item.get(u"key"_s));
    OJson payload;
    std::optional<QString> failed;
    try {
        payload = co_await fetcher(fill(kEndpoint, util::market::encodeURIComponent(key)), timeout * 1000);
    } catch (const util::JsError& e) {
        failed = e.message();
    }
    if (failed) {
        row->set(u"error"_s, js::S(errorText(*failed)));
        std::optional<OJson> alt;
        try {
            alt = co_await fetchCboeRow(key, timeout, fetcher);
        } catch (const util::JsError&) {
            alt.reset();  // 备用源也不通:保留上面那条主源的错误原因
        }
        if (alt) {
            row->set(u"last"_s, *alt->get(u"last"_s));
            row->set(u"change_pct"_s, *alt->get(u"change_pct"_s));
            row->set(u"instrument"_s, js::S(u"Cboe"_s));
            row->remove(u"error"_s);  // 备用源救回来了,不必再往界面上报错
        }
        co_return row;
    }
    const OJson* metaRaw = js::prop(js::prop(js::prop(js::prop(&payload, u"chart"_s), u"result"_s), u"0"_s), u"meta"_s);
    const OJson empty = js::object();
    const OJson* meta = js::nullish(metaRaw) ? &empty : metaRaw;
    const auto last = num(js::prop(meta, u"regularMarketPrice"_s));
    auto prev = num(js::prop(meta, u"chartPreviousClose"_s));
    if (!prev) prev = num(js::prop(meta, u"previousClose"_s));
    row->set(u"last"_s, optN(last));
    if (last && prev && *prev != 0) row->set(u"change_pct"_s, js::N(util::pyRound((*last / *prev - 1.0) * 100.0, 2)));
    co_return row;
}

/// 带缓存的单格取数。取失败时保留上一次的值并标记陈旧。background:过期的旧值先返回(标 refreshing),新值后台去取
Task<Row> cachedFetch(OJson item, double timeout, double ttl, Fetcher fetcher, std::function<double()> now, bool background) {
    const double ts = now();
    const QString key = js::str(item.get(u"key"_s));
    const auto found = cache().constFind(key);
    const std::optional<CacheHit> hit = found == cache().cend() ? std::nullopt : std::optional(*found);
    if (hit && ts - hit->at < ttl) co_return spread(hit->row, {u"cached"});
    if (background && hit && ts - hit->at < kMaxStale) {
        refreshInBackground(key, [item, timeout, fetcher] { return fetchOne(item, timeout, fetcher); }, now);
        co_return spread(hit->row, {u"cached", u"refreshing"});
    }
    const Row row = co_await fetchOne(item, timeout, fetcher);
    if (hasLast(*row)) {
        cache().insert(key, {ts, row});
        co_return row;
    }
    if (hit) co_return spread(hit->row, {u"cached", u"stale"});
    co_return row;
}

Task<Row> fetchCboe(QString sym, double timeout, Fetcher fetcher) {
    std::optional<double> price;
    try {
        const OJson payload = co_await fetcher(fill(kCboeEndpoint, sym), timeout * 1000);
        price = cboeLast(&payload);
    } catch (const util::JsError&) {
        co_return Row();
    }
    if (!price) co_return Row();
    co_return std::make_shared<OJson>(js::object({{u"last"_s, js::N(*price)}}));
}

double dateNowSeconds() { return util::dateNow() / 1000; }

bool isJsSpace(QChar c) {
    const char16_t u = c.unicode();
    return (u >= 0x09 && u <= 0x0d) || u == 0x20 || u == 0xa0 || u == 0x1680 || (u >= 0x2000 && u <= 0x200a) || u == 0x2028 || u == 0x2029 ||
           u == 0x202f || u == 0x205f || u == 0x3000 || u == 0xfeff;
}
}  // namespace

const QList<OJson>& macroSymbols() {
    // 铁律:这一格显示的数必须就是标的本身的价,不拿"跟着走"的替身(SPY / VIXY / TLT / GLD / BNO / IBIT)
    static const QList<OJson> s{
        js::object({{u"key"_s, js::S(u"^GSPC"_s)}, {u"label"_s, js::S(u"标普500"_s)}, {u"fmt"_s, js::S(u"price"_s)}, {u"live"_s, js::S(u"IND:SPX@CBOE"_s)},
                    {u"liveLabel"_s, js::S(u"SPX"_s)}}),
        js::object({{u"key"_s, js::S(u"^NDX"_s)}, {u"label"_s, js::S(u"纳指100"_s)}, {u"fmt"_s, js::S(u"price"_s)}, {u"live"_s, js::S(u"IND:NDX@NASDAQ"_s)},
                    {u"liveLabel"_s, js::S(u"NDX"_s)}}),
        js::object({{u"key"_s, js::S(u"^VIX"_s)}, {u"label"_s, js::S(u"VIX"_s)}, {u"fmt"_s, js::S(u"plain"_s)}, {u"live"_s, js::S(u"IND:VIX@CBOE"_s)},
                    {u"liveLabel"_s, js::S(u"VIX"_s)}}),
        // TNX 按 10 倍口径报价(48.06 = 4.806%),除以 10 是钉死的
        js::object({{u"key"_s, js::S(u"^TNX"_s)}, {u"label"_s, js::S(u"美债10Y"_s)}, {u"fmt"_s, js::S(u"pct"_s)}, {u"live"_s, js::S(u"IND:TNX@CBOE"_s)},
                    {u"liveLabel"_s, js::S(u"TNX"_s)}, {u"scale"_s, js::N(0.1)}}),
        js::object({{u"key"_s, js::S(u"GC=F"_s)}, {u"label"_s, js::S(u"纽约金"_s)}, {u"fmt"_s, js::S(u"price"_s)}, {u"live"_s, js::S(u"CONTFUT:GC@COMEX"_s)},
                    {u"liveLabel"_s, js::S(u"COMEX GC"_s)}}),
        js::object({{u"key"_s, js::S(u"BZ=F"_s)}, {u"label"_s, js::S(u"布油"_s)}, {u"fmt"_s, js::S(u"price"_s)}, {u"live"_s, js::S(u"CONTFUT:BZ@NYMEX"_s)},
                    {u"liveLabel"_s, js::S(u"布伦特 BZ"_s)}}),
        js::object({{u"key"_s, js::S(u"BTC-USD"_s)}, {u"label"_s, js::S(u"比特币"_s)}, {u"fmt"_s, js::S(u"price"_s)}, {u"live"_s, js::S(u"CRYPTO:BTC"_s)},
                    {u"liveLabel"_s, js::S(u"PAXOS"_s)}}),
    };
    return s;
}

QStringList liveTickers() {
    QStringList out;
    for (const OJson& i : macroSymbols())
        if (js::truthy(i.get(u"live"_s))) out << i.get(u"live"_s)->s;
    return out;
}

std::optional<double> cboeLast(const OJson* payload) {
    const OJson* d = js::prop(payload, u"data"_s);
    const OJson empty = js::object();
    const OJson* data = js::nullish(d) ? &empty : d;
    if (auto v = num(js::prop(data, u"current_price"_s))) return v;
    return num(js::prop(data, u"close"_s));
}

Task<OJson> macroBoard(BoardOptions options) {
    const double timeout = options.timeout.value_or(6.0);
    const std::function<double()> now = options.now ? options.now : std::function<double()>(dateNowSeconds);
    const Fetcher fetcher = options.fetcher;
    if (!fetcher) throw util::JsError(u"macroBoard 要给取数器"_s);

    OJson quotes = js::object();
    if (options.streamQuotes) {
        try {
            const OJson q = options.streamQuotes(liveTickers());
            quotes = q.type == OJson::Null ? js::object() : q;
        } catch (const util::JsError&) {
            quotes = js::object();  // 行情带永远不该把界面搞崩
        }
    }

    const double ttl = options.force ? 0.0 : !js::keys(&quotes).isEmpty() ? kTtlLive : kTtlIdle;
    OJson rows = js::array();
    QList<Row> rowRefs;
    for (const OJson& item : macroSymbols()) {
        const OJson* live = item.get(u"live"_s);
        const OJson* q = js::prop(&quotes, js::nullish(live) ? QString() : js::str(live));
        const OJson emptyQuote = js::object();
        const OJson* quote = js::nullish(q) ? &emptyQuote : q;
        const OJson* last = js::prop(quote, u"last"_s);
        if (!js::nullish(last)) {
            const OJson* sc = item.get(u"scale"_s);
            double scale = js::nullish(sc) ? 1 : js::num(sc);
            if (scale == 0 || std::isnan(scale)) scale = 1;
            const OJson* cp = js::prop(quote, u"change_pct"_s);
            const OJson* label = item.get(u"liveLabel"_s);
            // 涨跌幅是比值,不跟着 scale 变
            rowRefs << std::make_shared<OJson>(js::object({{u"key"_s, *item.get(u"key"_s)},
                                                           {u"label"_s, *item.get(u"label"_s)},
                                                           {u"fmt"_s, *item.get(u"fmt"_s)},
                                                           {u"last"_s, scale == 1 ? *last : js::N(util::pyRound(js::num(last) * scale, 4))},
                                                           {u"change_pct"_s, js::nullish(cp) ? OJson::null() : *cp},
                                                           {u"source"_s, js::S(u"tws"_s)},
                                                           {u"instrument"_s, js::nullish(label) ? js::copyOrNull(live) : *label}}));
        } else {
            // 用户点了强制刷新才同步等;周期轮询一律"旧值先给、后台去取"
            const Row row = co_await cachedFetch(item, timeout, ttl, fetcher, now, !options.force);
            row->set(u"source"_s, js::S(u"public"_s));
            // 主源挂掉、由 Cboe 兜回来的格子已经自报了 instrument,别在这里抹掉
            const OJson* inst = row->get(u"instrument"_s);
            row->set(u"instrument"_s, js::nullish(inst) ? OJson::null() : OJson(*inst));
            rowRefs << row;
        }
    }
    double liveCount = 0;
    for (const Row& r : rowRefs) {
        rows.items.append(*r);
        const OJson* src = r->get(u"source"_s);
        if (js::isStr(src) && src->s == u"tws") liveCount += 1;
    }
    co_return js::object({{u"rows"_s, rows}, {u"at"_s, js::N(now())}, {u"live_count"_s, js::N(liveCount)}});
}

Task<std::optional<double>> publicIndexPrice(QString symbol, double timeout, Fetcher fetcher) {
    const QString sym = symbol.toUpper();
    static const QStringList cboeIndex{u"SPX"_s, u"NDX"_s, u"VIX"_s, u"RUT"_s};
    if (cboeIndex.contains(sym)) {
        const double now = dateNowSeconds();
        const QString cacheKey = u"cboe:"_s + sym;
        const auto found = cache().constFind(cacheKey);
        const std::optional<CacheHit> hit = found == cache().cend() ? std::nullopt : std::optional(*found);
        if (hit && now - hit->at < 30.0) co_return num(hit->row->get(u"last"_s));
        if (hit && now - hit->at < kMaxStale) {
            // 速记解析等在这条线上:旧值(本来就是 15 分钟延迟的数)先给,后台换新
            refreshInBackground(cacheKey, [sym, timeout, fetcher] { return fetchCboe(sym, timeout, fetcher); }, dateNowSeconds);
            co_return num(hit->row->get(u"last"_s));
        }
        const Row fresh = co_await fetchCboe(sym, timeout, fetcher);
        if (fresh) {
            cache().insert(cacheKey, {now, fresh});
            co_return num(fresh->get(u"last"_s));
        }
        if (hit) co_return num(hit->row->get(u"last"_s));
    }
    static const QHash<QString, QString> publicIndex{
        {u"SPX"_s, u"^GSPC"_s}, {u"NDX"_s, u"^NDX"_s}, {u"VIX"_s, u"^VIX"_s}, {u"RUT"_s, u"^RUT"_s}, {u"DJI"_s, u"^DJI"_s}};
    const auto key = publicIndex.constFind(sym);
    if (key == publicIndex.cend()) co_return std::nullopt;
    const Row row = co_await cachedFetch(js::object({{u"key"_s, js::S(*key)}, {u"label"_s, js::S(symbol)}, {u"fmt"_s, js::S(u"price"_s)}}), timeout, 30.0,
                                         fetcher, dateNowSeconds, true);
    const OJson* last = row->get(u"last"_s);
    if (js::nullish(last)) co_return std::nullopt;
    co_return js::num(last);
}

Task<OJson> publicQuotes(QStringList symbols, double timeout, Fetcher fetcher) {
    QList<Task<Row>> started;
    for (const QString& symbol : symbols)
        started << cachedFetch(js::object({{u"key"_s, js::S(symbol)}, {u"label"_s, js::S(symbol)}, {u"fmt"_s, js::S(u"price"_s)}}), timeout, 60.0, fetcher,
                               dateNowSeconds, false);
    OJson out = js::object();
    for (qsizetype i = 0; i < symbols.size(); ++i) {
        const Row row = co_await started[i];
        OJson q = js::object({{u"last"_s, js::copyOrNull(row->get(u"last"_s))}, {u"change_pct"_s, js::copyOrNull(row->get(u"change_pct"_s))}});
        if (const OJson* e = row->get(u"error"_s); js::truthy(e)) q.set(u"error"_s, *e);
        out.set(symbols[i], q);
    }
    co_return out;
}

OJson fetchedBody(bool ok, int status, const QString& statusText, const QString& text) {
    // 数据源被挡时回的是 HTML 错误页,先按状态码给一句人话
    if (!ok) throw util::JsError(u"数据源返回 HTTP "_s + QString::number(status) + (statusText.isEmpty() ? QString() : u' ' + statusText));
    // fetch 的 text() 按 UTF-8 解、去掉开头的 BOM
    const QString body = text.startsWith(QChar(0xfeff)) ? text.mid(1) : text;
    if (auto parsed = js::parse(body)) return *parsed;
    QString head = body.left(60), squeezed;
    for (qsizetype i = 0; i < head.size(); ++i) {
        if (isJsSpace(head[i])) {
            while (i + 1 < head.size() && isJsSpace(head[i + 1])) ++i;
            squeezed += u' ';
        } else {
            squeezed += head[i];
        }
    }
    throw util::JsError(u"数据源返回的不是 JSON(前 60 字:%1)"_s.arg(squeezed));
}

void clearMacroCache() {
    cache().clear();
    inflight().clear();
}

}  // namespace ibkr::analysis::macro
