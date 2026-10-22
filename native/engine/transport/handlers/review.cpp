#include "transport/handlers/review.h"

#include "analysis/flyexit.h"
#include "analysis/ibtrades.h"
#include "analysis/performance.h"
#include "analysis/playbook.h"
#include "analysis/signal_outcomes.h"
#include "analysis/stockreview.h"
#include "analysis/tradereview.h"
#include "domain/day_logs.h"
#include "domain/positions.h"
#include "execution/broker_pricing.h"
#include "orchestrate/services/svc_util.h"
#include "transport/handlers/handlers2_support.h"
#include "util/js_runtime.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/jsvalue.h"
#include "util/py.h"
#include "util/tz.h"

#include <QDir>
#include <QFileInfo>
#include <QSet>

#include <algorithm>
#include <cmath>
#include <limits>

using namespace Qt::StringLiterals;

namespace ibkr::rpc {

using util::OJson;
namespace js = util::js;
namespace tr = analysis::tradereview;
namespace perf = analysis::performance;
namespace so = analysis::signal_outcomes;

namespace {

constexpr double kDay = 86'400'000;

/// JS 里 `const x = {a: expr}` 的 expr 是 undefined 时 JSON.stringify 会丢掉这个键
void setDefined(OJson& o, const QString& key, const OJson* v) {
    if (v) o.set(key, *v);
}
/// `v ?? fallback`
OJson orElse(const OJson* v, const OJson& fallback) { return js::nullish(v) ? fallback : *v; }
/// `v ?? null`(undefined 也变 null)
OJson orNull(const OJson* v) { return js::nullish(v) ? js::Null() : *v; }
/// `x.length` 当真假用:数组非空、字符串非空
bool hasLength(const OJson* v) {
    if (js::isArr(v)) return !v->items.isEmpty();
    if (js::isStr(v)) return !v->s.isEmpty();
    return false;
}
bool isString(const OJson* v, const QString& s) { return js::isStr(v) && v->s == s; }

OJson sessionBarJson(const execution::SessionBar& b) {
    return js::object({{u"time"_s, js::S(b.time)}, {u"open"_s, js::N(b.open)}, {u"high"_s, js::N(b.high)}, {u"low"_s, js::N(b.low)}, {u"close"_s, js::N(b.close)}, {u"volume"_s, js::N(b.volume)}});
}

/// store.closeTraces() 的行 → exec_quality 的 CloseTrace
std::vector<analysis::execquality::CloseTrace> tracesOf(const QList<OJson>& rows) {
    std::vector<analysis::execquality::CloseTrace> out;
    for (const OJson& t : rows) {
        analysis::execquality::CloseTrace c;
        c.at = js::str(js::prop(&t, u"at"_s));
        c.path = js::str(js::prop(&t, u"path"_s));
        c.symbol = js::str(js::prop(&t, u"symbol"_s));
        c.state = js::str(js::prop(&t, u"state"_s));
        if (const OJson* m = js::prop(&t, u"mark"_s); js::isNum(m)) c.mark = m->n;
        if (const OJson* r = js::prop(&t, u"record"_s); !js::nullish(r)) c.record = *r;
        out.push_back(c);
    }
    return out;
}

/// days 的校验(performance 与 signals 同一句):整数、1 到 3650;没传 / null 是空
std::optional<double> validDays(const OJson& params) {
    const OJson* d = js::prop(&params, u"days"_s);
    if (js::nullish(d)) return std::nullopt;
    const double days = js::num(d);
    if (!(std::isfinite(days) && std::floor(days) == days) || days < 1 || days > ReviewHandlers::kPerformanceMaxDays) {
        throw util::RpcError(-32602, u"天数要是 1 到 %1 之间的整数,收到:%2"_s.arg(util::jsNumberToString(ReviewHandlers::kPerformanceMaxDays), util::jsNumberToString(days)));
    }
    return days;
}

}  // namespace

MethodTable ReviewHandlers::methods() {
    return contractTable({
        {u"review.candidates"_s, [this](OJson p) { return reviewCandidates(std::move(p)); }},
        {u"review.analyze"_s, [this](OJson p) { return reviewAnalyze(std::move(p)); }},
        {u"review.performance"_s, [this](OJson p) { return reviewPerformance(std::move(p)); }},
        {u"review.signals"_s, [this](OJson p) { return reviewSignals(std::move(p)); }},
    });
}

// ---- 绩效体检 ----------------------------------------------------------
util::Task<OJson> ReviewHandlers::reviewPerformance(OJson params) {
    const std::optional<double> days = validDays(params);
    co_await reviewTrades();  // 连着券商时先把新成交同步进库(15 秒一次),体检看的是库
    const perf::Ledger ledger = co_await ports_.tradeHistory().ledger();
    perf::PerformanceOptions opts;
    opts.scope = js::strOr(js::prop(&params, u"scope"_s), u"all"_s);
    opts.kind = js::strOr(js::prop(&params, u"kind"_s), u"all"_s);
    opts.days = days;
    opts.now = util::dateNow();
    perf::PerformanceExtras extras;
    extras.traces = tracesOf(ports_.store().closeTraces());
    extras.protections = &settings().protections;
    co_return perf::performanceReport(ledger, opts, extras);
}

/// 信号成绩单。最后一根日线只有在**它那天收盘之后取的**才交给打分(盘中取的是半根)。
util::Task<OJson> ReviewHandlers::reviewSignals(OJson params) {
    const std::optional<double> days = validDays(params);
    const domain::EtNow moment = domain::nowEt();
    std::optional<QString> since;
    if (days) since = util::isoString(moment.epochMs - *days * kDay);
    const QList<OJson> sigs = ports_.store().signalLog().list(since);
    const QSet<QString> earlyCloses(settings().early_close_days.begin(), settings().early_close_days.end());
    QStringList symbols;  // Map / Set 的插入次序
    QHash<QString, double> oldest;
    for (const OJson& s : sigs) {
        const QString symbol = js::str(js::prop(&s, u"symbol"_s));
        if (!symbols.contains(symbol)) symbols << symbol;
    }
    for (const OJson& s : sigs) {
        const double at = util::jsDateParse(js::str(js::prop(&s, u"at"_s)));
        if (std::isfinite(at)) {
            const QString symbol = js::str(js::prop(&s, u"symbol"_s));
            oldest.insert(symbol, std::min(oldest.contains(symbol) ? oldest.value(symbol) : std::numeric_limits<double>::infinity(), at));
        }
    }
    std::vector<std::pair<QString, std::vector<so::DailyClose>>> bars;
    for (const QString& symbol : symbols) {
        const double age = std::max(0.0, std::ceil((moment.epochMs - (oldest.contains(symbol) ? oldest.value(symbol) : moment.epochMs)) / kDay)) + 1;
        try {
            const QList<OJson> history = co_await signalHistory(symbol, orchestrate::MarketDataService::kHistSpanDays + age);
            std::vector<so::DailyClose> rows;
            for (const OJson& r : history) {
                const OJson* date = js::propStrict(&r, u"date"_s);
                const QString d = js::strOr(js::nullish(date) ? js::prop(&r, u"time"_s) : date, QString()).left(10);
                const double close = js::num(js::prop(&r, u"close"_s));
                bool shape = d.size() == 10;
                for (int i = 0; shape && i < 10; ++i) shape = (i == 4 || i == 7) ? d[i] == u'-' : (d[i] >= u'0' && d[i] <= u'9');
                if (shape && std::isfinite(close) && close > 0) rows.push_back({d, close});
            }
            // 前面的每一根后面都还有一根,取的时候必然已经收了;只有最后一根要问:是它那天收盘之后取的吗
            const std::optional<double> askedAt = ports_.market().dailyHistoryAskedAt(symbol);
            if (!rows.empty() && !(askedAt && *askedAt >= so::closeEpoch(rows.back().date, &earlyCloses))) rows.pop_back();
            bars.push_back({symbol, rows});
        } catch (...) {
            // 没连券商 / 没有这只的行情权限:这只的信号不进成绩,结果里列出来
        }
    }
    co_return so::scoreSignals(sigs, bars, days, &earlyCloses);
}

/// 成绩单要的那段日线。更长的那段取不到就退回平常那一段
util::Task<QList<OJson>> ReviewHandlers::signalHistory(QString symbol, double spanDays) {
    bool failed = false;
    QList<OJson> rows;
    try {
        rows = co_await ports_.market().dailyHistory(symbol, spanDays);
    } catch (...) {
        failed = true;
    }
    if (failed) co_return co_await ports_.market().dailyHistory(symbol, double(orchestrate::MarketDataService::kHistSpanDays));
    co_return rows;
}

// ---- 交易分析:蝴蝶复盘 ------------------------------------------------
/// 券商成交 → 本地库(只增)→ 合成蝴蝶记录
util::Task<ReviewHandlers::TradesOut> ReviewHandlers::reviewTrades() {
    // 页面催的这一次连前 7 天的一起要
    const std::optional<double> synced = co_await ports_.fillSync().sync(std::nullopt, true);
    QList<OJson> accounts;
    for (const contract::AccountConfig& a : settings().accounts)
        accounts.append(js::object({{u"alias"_s, js::S(a.alias)}, {u"account_id"_s, js::S(a.account_id)}, {u"is_paper"_s, js::B(a.is_paper)}}));
    co_return TradesOut{analysis::ibtrades::groupButterflies(ports_.store().listFills(), accounts), synced};
}

namespace {

OJson stockCandidate(const OJson& trip) {
    OJson o = js::object();
    setDefined(o, u"id"_s, js::prop(&trip, u"id"_s));
    o.set(u"kind"_s, js::S(u"stock"_s));
    o.set(u"source"_s, js::S(u"ibkr"_s));
    o.set(u"created_at"_s, orNull(js::prop(&trip, u"created_at"_s)));
    o.set(u"closed_at"_s, orNull(js::prop(&trip, u"closed_at"_s)));
    o.set(u"intent_summary"_s, orElse(js::prop(&trip, u"summary"_s), js::S(QString())));
    o.set(u"account"_s, orElse(js::path(&trip, {u"account"_s, u"alias"_s}), js::S(QString())));
    o.set(u"final_status"_s, js::S(u"filled"_s));
    setDefined(o, u"status"_s, js::prop(&trip, u"status"_s));
    o.set(u"filled"_s, js::B(true));
    for (const QString& k : {u"symbol"_s, u"side"_s, u"qty"_s, u"open_qty"_s, u"entry_qty"_s, u"exit_qty"_s, u"avg_entry"_s, u"avg_exit"_s}) setDefined(o, k, js::prop(&trip, k));
    if (isString(js::prop(&trip, u"status"_s), u"closed"_s)) setDefined(o, u"pnl"_s, js::prop(&trip, u"realized_pnl"_s));
    else o.set(u"pnl"_s, js::Null());
    o.set(u"carried"_s, js::B(js::truthy(js::prop(&trip, u"carried"_s))));
    o.set(u"opening_assumed"_s, js::B(js::truthy(js::prop(&trip, u"opening_assumed"_s))));
    return o;
}

OJson reviewCandidate(const OJson& record, const OJson& profile, const QString& source) {
    const OJson* ibkr = js::prop(&record, u"ibkr"_s);
    const OJson* timeline = js::prop(ibkr, u"status_timeline"_s);
    OJson o = js::object();
    o.set(u"id"_s, orNull(js::prop(&record, u"id"_s)));
    o.set(u"kind"_s, js::S(u"butterfly"_s));
    o.set(u"source"_s, js::S(source));
    o.set(u"created_at"_s, orNull(js::prop(&record, u"created_at"_s)));
    o.set(u"intent_summary"_s, orElse(js::path(&record, {u"llm"_s, u"intent_summary"_s}), js::S(QString())));
    o.set(u"account"_s, orElse(js::path(&record, {u"account"_s, u"alias"_s}), js::S(QString())));
    o.set(u"final_status"_s, orNull(js::prop(&record, u"final_status"_s)));
    o.set(u"status"_s, hasLength(timeline) ? orNull(js::prop(&timeline->items.last(), u"status"_s)) : js::Null());
    o.set(u"filled"_s, js::B(hasLength(js::prop(ibkr, u"fills"_s)) || isString(js::prop(&record, u"final_status"_s), u"filled"_s)));
    for (const QString& k : {u"symbol"_s, u"expiry"_s}) setDefined(o, k, js::prop(&profile, k));
    setDefined(o, u"right"_s, js::prop(&profile, u"right_label"_s));
    OJson strikes = js::array();
    // 数组字面量里的 undefined 会变成 null
    for (const QString& k : {u"lower"_s, u"center"_s, u"upper"_s}) strikes.items.append(js::copyOrNull(js::prop(&profile, k)));
    o.set(u"strikes"_s, strikes);
    for (const QString& k : {u"width"_s, u"action"_s, u"qty"_s}) setDefined(o, k, js::prop(&profile, k));
    setDefined(o, u"price"_s, js::prop(&profile, u"debit"_s));
    setDefined(o, u"price_estimated"_s, js::prop(&profile, u"price_estimated"_s));
    return o;
}

}  // namespace

/// 可复盘的蝴蝶:默认只列券商真实成交的(最新在前);include_local 时再附上本地没成交的。
util::Task<OJson> ReviewHandlers::reviewCandidates(OJson params) {
    double limit = std::trunc(js::nullish(js::prop(&params, u"limit"_s)) ? 200.0 : js::num(js::prop(&params, u"limit"_s)));
    if (std::isnan(limit) || limit == 0) limit = 200;
    const TradesOut fetched = co_await reviewTrades();
    const QList<OJson>& trades = fetched.trades;
    const OJson pairs = tr::pairButterflies(trades);
    QList<OJson> out;
    for (qsizetype ti = trades.size() - 1; ti >= 0; --ti) {
        const OJson& record = trades[ti];
        const OJson profile = tr::butterflyProfile(&record);
        if (profile.type == OJson::Null) continue;
        const OJson* link = js::prop(&pairs, js::str(js::prop(&record, u"id"_s)));
        if (link && isString(js::prop(link, u"role"_s), u"exit"_s)) continue;  // 平仓单并进开仓那一行,不单独列
        OJson row = reviewCandidate(record, profile, u"ibkr"_s);
        if (link) {
            const OJson* peer = nullptr;
            for (const OJson& t : trades)
                if (js::strictEqual(js::prop(&t, u"id"_s), js::prop(link, u"peer"_s))) {
                    peer = &t;
                    break;
                }
            const OJson exitPriceV = orNull(js::path(peer, {u"ibkr"_s, u"avg_fill_price"_s}));
            OJson pnl = js::Null();
            const OJson* debit = js::prop(&profile, u"debit"_s);
            if (exitPriceV.type != OJson::Null && !js::nullish(debit)) {
                const double sign = isString(js::prop(&profile, u"action"_s), u"BUY"_s) ? 1.0 : -1.0;
                pnl = js::N(util::pyRound(sign * (js::num(&exitPriceV) - js::num(debit)) * js::num(js::prop(&profile, u"multiplier"_s)) * js::num(js::prop(&profile, u"qty"_s)), 2));
            }
            OJson exitO = js::object();
            setDefined(exitO, u"id"_s, js::prop(link, u"peer"_s));
            exitO.set(u"time"_s, orNull(js::prop(peer, u"created_at"_s)));
            exitO.set(u"price"_s, exitPriceV);
            exitO.set(u"pnl"_s, pnl);
            row.set(u"exit"_s, exitO);
        }
        out.append(row);
    }
    // 股票:一段持仓一行,和蝴蝶按时间混排(新的在前;时间认不出的沉底,同一时刻蝴蝶在前)
    QList<OJson> stocks;
    for (const OJson& trip : co_await ports_.stockTrips().trips()) stocks.append(stockCandidate(trip));
    if (!stocks.isEmpty()) {
        struct Keyed {
            OJson row;
            qsizetype i;
            double when;
        };
        std::vector<Keyed> keyed;
        QList<OJson> all = out;
        all.append(stocks);
        for (qsizetype i = 0; i < all.size(); ++i) {
            const std::optional<double> w = tr::parseWhen(js::prop(&all[i], u"created_at"_s));
            keyed.push_back({all[i], i, w ? *w : -std::numeric_limits<double>::infinity()});
        }
        std::stable_sort(keyed.begin(), keyed.end(), [](const Keyed& a, const Keyed& b) {
            double c = b.when - a.when;
            if (std::isnan(c) || c == 0) c = double(a.i - b.i);
            return c < 0;
        });
        out.clear();
        for (const Keyed& k : keyed) out.append(k.row);
    }
    if (js::truthy(js::prop(&params, u"include_local"_s))) {
        for (const OJson& record : ports_.store().listRecords(kReviewScanLimit)) {
            const OJson profile = tr::butterflyProfile(&record);
            if (profile.type == OJson::Null || hasLength(js::path(&record, {u"ibkr"_s, u"fills"_s}))) continue;  // 本地已成交的,券商成交里已有
            out.append(reviewCandidate(record, profile, u"local"_s));
        }
    }
    // out.slice(0, limit)
    const double n = double(out.size());
    const double end = limit >= 0 ? std::min(limit, n) : std::max(n + limit, 0.0);
    OJson cands = js::array();
    for (qsizetype i = 0; i < qsizetype(end); ++i) cands.items.append(out[i]);
    OJson result = js::object();
    result.set(u"candidates"_s, cands);
    result.set(u"synced"_s, js::NOrNull(fetched.synced));
    result.set(u"ibkr_available"_s, js::B(ports_.fillSync().available()));
    result.set(u"fills_stored"_s, js::N(ports_.store().countFills()));
    co_return result;
}

/// 一张蝴蝶 + 标的 K 线 → 复盘
util::Task<OJson> ReviewHandlers::reviewAnalyze(OJson params) {
    QString rid = js::strOr(js::prop(&params, u"id"_s), QString());
    if (rid.startsWith(u"stk:"_s)) co_return co_await reviewAnalyzeStock(rid, params);
    const TradesOut fetched = co_await reviewTrades();
    const QList<OJson>& trades = fetched.trades;
    const OJson pairs = tr::pairButterflies(trades);
    const OJson* link = js::prop(&pairs, rid);
    if (link && isString(js::prop(link, u"role"_s), u"exit"_s)) rid = js::str(js::prop(link, u"peer"_s));  // 选中平仓单 → 复盘它对应的开仓单
    std::optional<OJson> record;
    for (const OJson& t : trades)
        if (isString(js::prop(&t, u"id"_s), rid)) {
            record = t;
            break;
        }
    if (!record) record = ports_.store().getRecord(rid);
    if (!record) throw util::RpcError(-32005, u"记录不存在"_s);
    const OJson profile = tr::butterflyProfile(&*record);
    if (profile.type == OJson::Null) throw util::RpcError(-32602, u"这条记录不是蝴蝶组合,交易分析目前只支持蝴蝶。"_s);
    tr::Entry entry;
    try {
        entry = tr::entryOf(&*record);
    } catch (const tr::ReviewError& exc) {
        throw util::RpcError(-32602, exc.message());
    }
    const domain::EtNow moment = domain::nowEt();
    const QString symbol = js::str(js::prop(&profile, u"symbol"_s));
    const BarsOut fetchedBars = co_await reviewBars(symbol, js::strOr(js::prop(&params, u"timeframe"_s), u"auto"_s), entry.time, moment);
    const QString timeframe = fetchedBars.timeframe;
    const QList<OJson> bars = fetchedBars.bars;

    // 平仓单可能在券商成交里,也可能在本地记录里:两边都找
    QList<OJson> others = trades;
    others.append(ports_.store().listRecords(kReviewScanLimit));
    OJson result;
    try {
        result = tr::review(&*record, others, bars, timeframe, moment.epochMs);
    } catch (const tr::ReviewError& exc) {
        throw util::RpcError(-32602, exc.message());
    }
    result.set(u"record_id"_s, orNull(js::prop(&*record, u"id"_s)));
    result.set(u"source"_s, orElse(js::prop(&*record, u"source"_s), js::S(u"local"_s)));
    result.set(u"intent_summary"_s, orElse(js::path(&*record, {u"llm"_s, u"intent_summary"_s}), js::S(QString())));
    if (const OJson* spec = domain::timeframes().get(timeframe)) setDefined(result, u"timeframe_label"_s, js::prop(spec, u"label"_s));
    else result.remove(u"timeframe_label"_s);
    co_return co_await attachExitPlan(result, *record, profile, symbol, bars, timeframe, params);
}

/// 复盘用的标的 K 线:周期 auto 时按开仓离现在多远挑;日内走 K线 PA 那条缓存,日线走历史数据接口。
util::Task<ReviewHandlers::BarsOut> ReviewHandlers::reviewBars(QString symbol, QString requested, double entryTime, domain::EtNow moment) {
    const QString timeframe = requested == u"auto" ? tr::pickTimeframe(entryTime, moment.epochMs) : requested;
    if (!domain::timeframes().get(timeframe) && !tr::onObjectPrototype(timeframe)) {  // `timeframe in TIMEFRAMES`
        throw util::RpcError(-32602, u"未知 K 线周期:%1(可选:auto、%2)"_s.arg(timeframe, js::keys(&domain::timeframes()).join(u"、"_s)));
    }
    const std::shared_ptr<HandlerRouter> live = liveRouter(ports_);
    if (!live) throw needConnection(-32015, u"交易分析的 K 线"_s);
    std::optional<QString> brokerFailure;
    BarsOut out;
    out.timeframe = timeframe;
    try {
        if (timeframe == u"1d") {
            const QString start = tr::etKey(entryTime - 45 * kDay, true);
            for (const OJson& b : co_await live->historicalBars(symbol, start, moment.date)) {
                OJson o = js::object();
                const OJson* date = js::prop(&b, u"date"_s);
                setDefined(o, u"time"_s, js::nullish(date) ? js::prop(&b, u"time"_s) : date);
                for (const QString& k : {u"open"_s, u"high"_s, u"low"_s, u"close"_s}) setDefined(o, k, js::prop(&b, k));
                o.set(u"volume"_s, orElse(js::prop(&b, u"volume"_s), js::N(0.0)));
                out.bars.append(o);
            }
        } else {
            const orchestrate::PaBars pa = co_await ports_.market().paBars(symbol, timeframe, false, false, false);
            for (const execution::SessionBar& b : pa.bars.bars) out.bars.append(sessionBarJson(b));
        }
    } catch (const execution::BrokerError& exc) {
        brokerFailure = exc.message();
    }
    if (brokerFailure) throw util::RpcError(-32015, *brokerFailure);
    co_return out;
}

/// 一笔股票交易(一段持仓)+ 标的 K 线 → 复盘。id 是 review.candidates 给的 `stk:` 开头那个。
util::Task<OJson> ReviewHandlers::reviewAnalyzeStock(QString rid, OJson params) {
    const QList<OJson> trips = co_await ports_.stockTrips().trips();
    const OJson* trip = nullptr;
    for (const OJson& t : trips)
        if (isString(js::prop(&t, u"id"_s), rid)) {
            trip = &t;
            break;
        }
    if (!trip) throw util::RpcError(-32005, u"这笔股票交易不在已同步的成交里(成交有更新,请重新选一笔)"_s);
    const domain::EtNow moment = domain::nowEt();
    OJson result;
    QString timeframe;
    try {
        const QString symbol = js::str(js::prop(trip, u"symbol"_s));
        const QString requested = js::strOr(js::prop(&params, u"timeframe"_s), u"auto"_s);
        const double start = analysis::stockreview::tripStart(*trip);
        const BarsOut fetchedBars = co_await reviewBars(symbol, requested, start, moment);
        timeframe = fetchedBars.timeframe;
        result = analysis::stockreview::reviewStock(*trip, fetchedBars.bars, timeframe, moment.epochMs);
    } catch (const tr::ReviewError& exc) {
        throw util::RpcError(-32602, exc.message());
    }
    if (const OJson* id = js::prop(trip, u"id"_s)) result.set(u"record_id"_s, *id);
    else result.remove(u"record_id"_s);
    result.set(u"source"_s, js::S(u"ibkr"_s));
    result.set(u"account"_s, orElse(js::path(trip, {u"account"_s, u"alias"_s}), js::S(QString())));
    result.set(u"intent_summary"_s, orElse(js::prop(trip, u"summary"_s), js::S(QString())));
    if (const OJson* spec = domain::timeframes().get(timeframe)) setDefined(result, u"timeframe_label"_s, js::prop(spec, u"label"_s));
    else result.remove(u"timeframe_label"_s);
    co_return result;
}

/// 止盈策略回放:蝶价分钟线 + 标的 1 分钟线 → 点位、预计盈利、逐分钟事件。任何一步拿不到数据都不该毁掉复盘本身。
util::Task<OJson> ReviewHandlers::attachExitPlan(OJson result, OJson record, OJson profile, QString symbol, QList<OJson> bars, QString timeframe, OJson params) {
    OJson exitParams = js::object();
    if (const OJson* ex = js::prop(&params, u"exit"_s); js::truthy(ex) && js::isObjectLike(ex)) {
        if (ex->type == OJson::Object) exitParams = *ex;
        else
            for (qsizetype i = 0; i < ex->items.size(); ++i) exitParams.set(QString::number(i), ex->items[i]);
    }
    const QString entryDay = js::str(js::path(&result, {u"entry"_s, u"time_et"_s})).left(10);
    QStringList notes;
    // EM:没手动填就取开仓那天日内剧本记下的期权定价;那天没记到才用默认值,并照实说
    const bool earlyClose = settings().early_close_days.contains(entryDay);
    QString emNote;
    const OJson* em = js::prop(&exitParams, u"em"_s);
    if (em && em->type != OJson::Null && !isString(em, QString())) {
        emNote = u"EM 取 %1 点(手动填的)"_s.arg(js::str(em));
    } else {
        const domain::PlaybookLog log(QFileInfo(settings().db_path).dir().path() + u"/playbook"_s);
        const auto found = analysis::playbook::sessionEmOf(log.read(entryDay), earlyClose);
        if (found) {
            exitParams.set(u"em"_s, js::N(found->em));
            emNote = u"EM 取 %1 点:开仓那天%2的平值跨式 × √(π/2),折回常规时段全天(日内剧本的底账)"_s.arg(
                util::jsNumberToString(found->em), found->kind == u"open" ? u"盘初"_s : u" "_s + found->at + u" "_s);
        } else {
            emNote = u"开仓那天的底账里没有记到期权的定价,EM 用默认的 %1 点——那是某一天的数,不是这一天的。知道那天开盘时的平值跨式就手动填(跨式 × 1.25)"_s.arg(
                js::str(js::prop(&analysis::flyexit::defaults(), u"em"_s)));
        }
    }
    if (earlyClose) notes << u"开仓那天提前收盘(13:00):日内方差分布与阶段切换是照 16:00 收盘估的,这一天的阶段与模型价不可靠"_s;
    QList<OJson> spx1m = bars;
    if (timeframe != u"1m") {
        std::optional<QString> failure;
        try {
            const orchestrate::PaBars pa = co_await ports_.market().paBars(symbol, u"1m"_s, false, false, false);
            spx1m.clear();
            for (const execution::SessionBar& b : pa.bars.bars) spx1m.append(sessionBarJson(b));
            bool any = false;
            for (const OJson& b : spx1m)
                if (js::strOr(js::prop(&b, u"time"_s), QString()).startsWith(entryDay)) {
                    any = true;
                    break;
                }
            if (!any) {
                spx1m = bars;
                notes << u"开仓那天的 1 分钟线已超出 TWS 可取范围,回放按 %1 K 线走"_s.arg(timeframe);
            }
        } catch (const execution::BrokerError& exc) {
            failure = exc.message();
        } catch (const util::RpcError& exc) {
            failure = exc.message();
        }
        if (failure) {
            spx1m = bars;
            notes << u"拿不到 1 分钟线(%1),回放按 %2 K 线走"_s.arg(*failure, timeframe);
        }
    }
    QList<OJson> flyBars;
    const std::shared_ptr<HandlerRouter> router = ports_.router();
    if (router && router->hasComboBars()) {
        std::optional<QString> failure;
        try {
            OJson legs = orElse(js::path(&record, {u"contract"_s, u"legs"_s}), js::array());
            flyBars = co_await router->comboBars(symbol, legs, entryDay);
        } catch (...) {
            // 组合历史数据的坑很多,别让它拖垮复盘
            failure = orchestrate::errMessage(std::current_exception()).left(160);
        }
        if (failure) notes << u"拿不到蝶价分钟线(%1),回放全部用模型价"_s.arg(*failure);
    } else {
        notes << u"当前券商通道不支持组合历史数据,回放全部用模型价"_s;
    }

    const std::optional<double> entryWhen = tr::parseWhen(js::path(&result, {u"entry"_s, u"time"_s}));
    std::optional<qsizetype> idx;
    if (entryWhen) idx = tr::indexAt(spx1m, *entryWhen, false);
    const QString entryBar = idx ? js::str(js::prop(&spx1m[*idx], u"time"_s)) : js::str(js::path(&result, {u"entry"_s, u"bar_time"_s}));
    const OJson* outcome = js::prop(&result, u"outcome"_s);
    OJson actual = js::object();
    for (const QString& k : {u"kind"_s, u"price"_s, u"pnl"_s, u"time_et"_s}) setDefined(actual, k, js::prop(outcome, k));
    OJson plan = analysis::flyexit::plan(profile, entryBar, js::array(spx1m), js::array(flyBars), &exitParams, &actual, emNote);
    OJson* planNotes = js::propMut(&plan, u"notes"_s);
    if (!planNotes) throw util::JsError(u"Cannot read properties of undefined (reading 'push')"_s);
    for (const QString& n : notes) planNotes->items.append(js::S(n));
    result.set(u"exit_plan"_s, plan);
    // 有真实蝶价就用它说"曾有的机会"
    tr::marketOpportunity(result, flyBars, entryBar);
    outcome = js::prop(&result, u"outcome"_s);

    QList<OJson> dayFly;
    for (const OJson& b : flyBars)
        if (js::strOr(js::prop(&b, u"time"_s), QString()).left(10) == entryDay) dayFly.append(b);
    qsizetype startI = 0;
    for (qsizetype i = 0; i < dayFly.size(); ++i) {
        if (js::strOr(js::prop(&dayFly[i], u"time"_s), QString()) >= entryBar) {
            startI = std::max<qsizetype>(i - tr::kLookbackBars, 0);
            break;
        }
    }
    OJson markers = js::array();
    markers.items.append(js::object({{u"kind"_s, js::S(u"entry"_s)}, {u"time"_s, js::S(entryBar)}, {u"price"_s, orNull(js::prop(&profile, u"debit"_s))}}));
    if (isString(js::prop(outcome, u"kind"_s), u"closed"_s) && js::truthy(js::prop(outcome, u"time"_s))) {
        const std::optional<double> exitWhen = tr::parseWhen(js::prop(outcome, u"time"_s));
        std::optional<qsizetype> j;
        if (exitWhen) j = tr::indexAt(spx1m, *exitWhen, false);
        if (j) {
            OJson m = js::object({{u"kind"_s, js::S(u"exit"_s)}, {u"time"_s, js::S(js::str(js::prop(&spx1m[*j], u"time"_s)))}});
            setDefined(m, u"price"_s, js::prop(outcome, u"price"_s));
            markers.items.append(m);
        }
    }
    result.set(u"fly_series"_s, js::object({{u"bars"_s, js::array(dayFly.mid(startI))}, {u"source"_s, js::S(flyBars.isEmpty() ? u"model"_s : u"ibkr"_s)}, {u"markers"_s, markers}}));
    co_return result;
}

}  // namespace ibkr::rpc
