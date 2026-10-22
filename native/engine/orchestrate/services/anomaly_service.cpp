#include "orchestrate/services/anomaly_service.h"

#include "analysis/signal_outcomes.h"
#include "orchestrate/services/svc1_util.h"
#include "util/error.h"
#include "util/jsformat.h"
#include "util/jsobj.h"
#include "util/js_runtime.h"
#include "util/tz.h"

#include <QSet>

#include <algorithm>
#include <cmath>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using util::OJson;
using util::Task;
namespace js = util::js;
namespace an = analysis::anomaly;
using svc1::excMessage;

namespace {

/// positive(v):typeof number && 有限 && > 0。v 空 = undefined
std::optional<double> positiveOf(const OJson* v) {
    if (js::isNum(v) && std::isfinite(v->n) && v->n > 0) return v->n;
    return std::nullopt;
}

std::optional<double> positiveOf(const std::optional<double>& v) {
    if (v && std::isfinite(*v) && *v > 0) return v;
    return std::nullopt;
}

/// settings.marketStatus 的中文时段 → 异动监控的时段标记
QString anomalySessionOf(const QString& status) {
    if (status == u"盘中") return u"rth"_s;
    if (status == u"盘前") return u"pre"_s;
    if (status == u"盘后") return u"post"_s;
    return u"closed"_s;
}

/// 键排序后的 JSON 串:比较"状态变没变"用。v 空 = undefined → JSON.stringify(undefined) ?? "null"
QString stableJson(const OJson* v) {
    if (!v) return u"null"_s;
    return js::stringify(svc1::stableSort(*v));
}

/// 量价快照(volumeQuotes 回的 JSON)按 TS 的 typeof 逐项读:只有 number 算数,别的当没有;delayed 只认布尔
an::VolumeSnapshot snapshotOf(const OJson* snap) {
    an::VolumeSnapshot v;
    const auto n = [&](const QString& key) -> std::optional<double> {
        const OJson* x = js::prop(snap, key);
        return js::isNum(x) ? std::optional<double>(x->n) : std::nullopt;
    };
    v.last = n(u"last"_s);
    v.close = n(u"close"_s);
    v.open = n(u"open"_s);
    v.high = n(u"high"_s);
    v.low = n(u"low"_s);
    v.volume = n(u"volume"_s);
    v.avg_volume = n(u"avg_volume"_s);
    v.hist_vol = n(u"hist_vol"_s);
    v.vol_3m = n(u"vol_3m"_s);
    v.vol_5m = n(u"vol_5m"_s);
    v.vol_10m = n(u"vol_10m"_s);
    v.last_trade_at = n(u"last_trade_at"_s);
    const OJson* d = js::prop(snap, u"delayed"_s);
    if (js::isBool(d)) v.delayed = d->b;
    return v;
}

}  // namespace

OJson AnomalyService::MetricsHit::toJson() const {
    return js::object({{u"metrics"_s, metrics ? *metrics : js::Null()}, {u"at"_s, js::S(at)}, {u"error"_s, error ? js::S(*error) : js::Null()}});
}

// ---------------------------------------------------------------- 大盘同期的涨跌
Task<std::optional<an::MarketMove>> AnomalyService::marketMove(std::shared_ptr<RouterPort> router, double nowMs, double windowMin, QString etDate, double minute,
                                                               double openMs) {
    std::optional<OJson> quote;
    try {
        // source.streamQuotes?.([MARKET_REF]) 然后 ?.[MARKET_REF]
        const OJson r = co_await router->streamQuotes({kMarketRef});
        if (const OJson* q = js::prop(&r, kMarketRef)) quote = *q;
    } catch (...) {
        quote.reset();  // 大盘只是参照:取不到不该拖累个股这一轮
    }
    const OJson* qp = quote ? &*quote : nullptr;
    const std::optional<double> last = positiveOf(js::prop(qp, u"last"_s));
    if (!last) co_return std::nullopt;
    if (!marketRef_ || marketRef_->date != etDate) {
        marketRef_ = MarketRef{etDate, std::nullopt, std::nullopt, std::nullopt, std::nullopt};
        marketSamples_.clear();
    }
    MarketRef& ref = *marketRef_;
    if (minute < 0) co_return std::nullopt;  // 开盘前:只是昨天的收盘
    const double tradedMs = positiveOf(js::prop(qp, u"last_trade_at"_s)).value_or(0) * 1000;
    if (ref.last && *last != *ref.last) ref.changedAt = nowMs;
    ref.last = last;
    if (!ref.tickedAt) {
        if (!ref.first) ref.first = last;
        if (tradedMs >= openMs || *last != *ref.first) {
            ref.tickedAt = nowMs;
            ref.changedAt = nowMs;
            marketSamples_.clear();
        }
    }
    if (!ref.tickedAt) co_return std::nullopt;
    if (nowMs - std::max(ref.changedAt ? *ref.changedAt : *ref.tickedAt, tradedMs) > kQuoteStaleMs) co_return std::nullopt;
    marketSamples_ = an::pushSample(marketSamples_, an::Sample{nowMs, std::nullopt, last});
    const OJson* change = js::prop(qp, u"change_pct"_s);
    an::MarketMove move;
    move.change_pct = (js::isNum(change) && std::isfinite(change->n)) ? std::optional<double>(change->n) : std::nullopt;
    move.ret_window_pct = an::windowReturnPct(marketSamples_, nowMs, windowMin);
    co_return move;
}

// ---------------------------------------------------------------- 今天开出来没有
AnomalyService::DayOpenResult AnomalyService::dayOpenOf(const QString& symbol, const an::VolumeSnapshot& snap, const QString& etDate, double minute, double openMs) {
    auto it = dayOpens_.find(symbol);
    if (it == dayOpens_.end() || it->second.date != etDate) {
        dayOpens_[symbol] = DayOpen{etDate, false, std::nullopt, std::nullopt, false, std::nullopt};
        it = dayOpens_.find(symbol);
    }
    DayOpen& st = it->second;
    const std::optional<double> tickOpen = positiveOf(snap.open);
    if (minute < 0) {
        st.watchedBefore = true;
        st.staleOpen = tickOpen;
        return {false, std::nullopt};
    }
    const std::optional<double> last = positiveOf(snap.last);
    if (!st.firstLast) st.firstLast = last;
    const std::optional<double> official = (st.watchedBefore && tickOpen && tickOpen != st.staleOpen) ? tickOpen : std::nullopt;
    if (!st.opened) {
        const std::optional<double> tradedAt = positiveOf(snap.last_trade_at);
        const bool traded = tradedAt && *tradedAt * 1000 >= openMs;
        const bool moved = last && st.firstLast && *last != *st.firstLast;
        if (official || traded || moved || (!st.watchedBefore && !tradedAt)) {
            st.opened = true;
            st.open = st.watchedBefore ? last : std::nullopt;
        }
    }
    if (official) st.open = official;
    return {st.opened, st.open};
}

// ---------------------------------------------------------------- 循环
void AnomalyService::schedule(int gen, double intervalMs, double delay) {
    timer_ = rt().setTimeout(static_cast<int>(delay), [this, gen, intervalMs] { util::detach(loop(gen, intervalMs)); });
}

Task<> AnomalyService::loop(int gen, double intervalMs) {
    const double t0 = util::dateNow();
    try {
        (void)co_await tickOnce();
    } catch (...) {
        // .catch(() => undefined)
    }
    if (gen != gen_ || !loop_.running) co_return;
    // 下一轮在这一轮结束之后排:慢了就紧接着跑,不叠两轮;快了就补足到一个节拍
    schedule(gen, intervalMs, std::max(0.0, intervalMs - (util::dateNow() - t0)));
}

void AnomalyService::start(double intervalMs) {
    if (loop_.running) return;
    const int gen = ++gen_;
    loop_.running = true;
    loop_.interval_ms = intervalMs;
    schedule(gen, intervalMs, 0);
}

void AnomalyService::stop() {
    gen_ += 1;
    loop_.running = false;
    if (timer_) rt().clearTimeout(*timer_);
    timer_.reset();
}

// ---------------------------------------------------------------- 一轮
Task<OJson> AnomalyService::runAfter(Task<> prev, std::optional<double> nowMs) {
    co_await prev;  // 链上的 Promise 都带了 .catch,不会失败
    co_return co_await tickInner(nowMs ? *nowMs : domain::nowEt().epochMs);
}

Task<OJson> AnomalyService::tickOnce(std::optional<double> nowMs) {
    Task<> prev = chain_;
    Task<OJson> run = runAfter(prev, nowMs);
    util::Deferred<> next;
    chain_ = next.task();
    // anomalyChain = run.catch(() => undefined):成败都放行下一轮
    run.onDone([next]() mutable { next.resolve(); });
    return run;
}

Task<OJson> AnomalyService::tickInner(double nowMs) {
    const double t0 = util::dateNow();
    const QString prevError = loop_.last_error;
    auto out = std::make_shared<OJson>(js::object({{u"events"_s, js::array()}, {u"evaluated"_s, js::array()}, {u"skipped"_s, js::S(QString())}, {u"levels"_s, js::Null()}, {u"touch"_s, js::Null()}}));
    std::exception_ptr failure;
    try {
        co_await tickBody(nowMs, out);
    } catch (...) {
        failure = std::current_exception();
    }
    if (failure) loop_.last_error = svc1::slice(excMessage(failure), 200);
    // finally
    loop_.ticks = loop_.ticks + 1;
    loop_.last_at = util::isoString(util::dateNow());
    loop_.last_ms = util::dateNow() - t0;
    // 报错只在"变了"的那一轮记一行 stderr
    const QString error = loop_.last_error;
    if (!error.isEmpty() && error != prevError) log(u"[anomaly] "_s + error);
    co_return *out;
}

QList<OJson> AnomalyService::enabledStocks() {
    QList<OJson> out;
    for (const OJson& s : store().listQualityStocks())
        if (js::truthy(s.get(u"enabled"_s))) out.append(s);
    return out;
}

void AnomalyService::dropMarket() {
    marketSamples_.clear();
    marketRef_.reset();
    loop_.market_ref.reset();
}

Task<> AnomalyService::tickBody(double nowMs, std::shared_ptr<OJson> out) {
    const std::shared_ptr<RouterPort> router = routerPort();
    if (!router || !router->hasSessions()) {
        // 断开之后内存里那份指标就是旧的了:留着界面会把上一次的价当成此刻的
        qualityMetrics_.clear();
        qualitySamples_.clear();
        dropMarket();
        out->set(u"skipped"_s, js::S(u"未连接券商"_s));
        loop_.last_error.clear();
        co_return;
    }

    const domain::EtNow et = domain::etNowFromEpoch(nowMs);
    const double sessionMinutes = settings().early_close_days.contains(et.date) ? 210 : 390;
    const double minute = (et.seconds - 9.5 * 3600) / 60;
    // 周末 / 假日整天都不在时段内
    const bool inWindow = settings().isTradingDay(et.date) && minute >= -kAnomalyWarmupMinutes && minute < sessionMinutes + kAnomalyTailMinutes;
    // 「盯价位」开着就该有价位:捎带算 1 只
    const std::optional<QString> levels = co_await alerts_.tickLevels(nowMs, inWindow);
    out->set(u"levels"_s, levels ? js::S(*levels) : js::Null());
    // 价位这一轮没干活,才轮到碰均线的底账
    if (!levels) {
        const std::optional<QString> touch = co_await alerts_.tickTouch(nowMs, inWindow);
        out->set(u"touch"_s, touch ? js::S(*touch) : js::Null());
    } else {
        out->set(u"touch"_s, js::Null());
    }

    const std::shared_ptr<Svc1Router> source = std::dynamic_pointer_cast<Svc1Router>(router);
    if (!source || !source->supportsVolumeQuotes()) {
        qualityMetrics_.clear();
        qualitySamples_.clear();
        dropMarket();
        out->set(u"skipped"_s, js::S(u"当前券商不支持"_s));
        loop_.last_error.clear();
        co_return;
    }
    const QList<OJson> enabled = enabledStocks();
    if (enabled.isEmpty()) {
        // 全停了 / 全删了:量能流一条不留,别占着行情线路
        source->releaseVolumeStreams({});
        qualitySamples_.clear();
        dropMarket();
        qualityMetrics_.clear();
        loop_.delayed = false;
        loop_.last_error.clear();
        out->set(u"skipped"_s, js::S(u"没有启用的优质股"_s));
        co_return;
    }

    // 收盘之后、开盘之前、非交易日:一条也不判,量能流全撤
    if (!inWindow) {
        try {
            source->releaseVolumeStreams({});
        } catch (...) {
            // 撤流失败不影响下一轮
        }
        qualitySamples_.clear();
        dropMarket();
        loop_.last_error.clear();
        out->set(u"skipped"_s, js::S(u"不在交易时段"_s));
        co_return;
    }
    QStringList symbols;
    for (const OJson& s : enabled) symbols.append(js::str(s.get(u"symbol"_s)));
    OJson quotes;
    std::exception_ptr quoteFailure;
    try {
        quotes = co_await source->volumeQuotes(symbols);
    } catch (...) {
        quoteFailure = std::current_exception();
    }
    if (quoteFailure) {
        loop_.last_error = u"取行情失败:"_s + svc1::slice(excMessage(quoteFailure), 200);
        co_return;
    }
    if (quotes.type == OJson::Null) quotes = js::object();  // ?? {}
    try {
        source->releaseVolumeStreams(symbols);
    } catch (...) {
        // 撤流失败不影响这一轮的判定
    }

    const an::Config config = this->config();
    // 今天 09:30 那一刻(美东)
    const double openMs = nowMs - minute * 60'000;
    const std::optional<an::MarketMove> market = co_await marketMove(router, nowMs, config.window_min, et.date, minute, openMs);
    // 读没读到只在真在判的时候说(常规时段里)
    if (minute >= 0 && minute < sessionMinutes) loop_.market_ref = market.has_value();
    else loop_.market_ref.reset();
    // 等行情那一两秒里界面可能删了 / 停了某只股:按最新的库来
    const QList<OJson> latest = enabledStocks();
    const QString at = util::isoString(nowMs);
    QStringList errors;
    bool delayed = false;
    for (const OJson& stock : latest) {
        const QString symbol = js::str(stock.get(u"symbol"_s));
        const OJson* snap = js::prop(&quotes, symbol);
        if (!snap) continue;
        try {
            if (js::truthy(js::propStrict(snap, u"error"_s))) {
                // 流被拒 / 标的认不出:最后那点数是旧的,拿它判异动会误报
                qualityMetrics_[symbol] = MetricsHit{std::nullopt, at, js::str(js::prop(snap, u"error"_s))};
                continue;
            }
            an::VolumeSnapshot vs = snapshotOf(snap);
            std::vector<an::Sample>& stored = qualitySamples_[symbol];
            const std::vector<an::Sample> samples = an::pushSample(stored, an::Sample{nowMs, vs.volume, vs.last});
            qualitySamples_[symbol] = samples;
            // 刚订上的流:第一轮一律只算指标
            const bool fresh = samples.size() < 2;
            // 成交时间戳很久没动:流被别处撤掉、或者交易所临时休市
            std::optional<double> lastTradeAt;
            if (vs.last_trade_at && std::isfinite(*vs.last_trade_at)) lastTradeAt = *vs.last_trade_at * 1000;
            const double staleMs = lastTradeAt ? nowMs - *lastTradeAt : 0;
            const bool stale = lastTradeAt && staleMs > kQuoteStaleMs;
            // 延迟行情看到的是 15 分钟前的量价:时钟跟着往回拨
            const bool delayedTrue = vs.delayed == true;
            const double effMinute = delayedTrue ? minute - kDelayedShiftMinutes : minute;
            const DayOpenResult dayOpen = dayOpenOf(symbol, vs, et.date, effMinute, openMs);
            // 流里的开盘价开盘前是昨天的:只给认出来是今天的那个
            vs.open = dayOpen.open;
            an::EvalArgs a;
            a.symbol = symbol;
            a.snap = vs;
            a.samples = samples;
            const std::optional<OJson> storedState = storedAnomalyState(stock.get(u"states"_s), et.date);
            a.state = storedState ? &*storedState : nullptr;
            a.nowMs = nowMs;
            a.etDate = et.date;
            a.minute = effMinute;
            a.sessionMinutes = sessionMinutes;
            a.config = config;
            a.suppress = fresh || stale;
            // 延迟行情的股看到的是 15 分钟前的自己,大盘是此刻的:两段对不上,不带
            a.market = delayedTrue ? std::nullopt : market;
            a.opened = dayOpen.opened;
            const OJson result = an::evaluateAnomalies(a);
            const OJson* metrics = result.get(u"metrics"_s);
            const OJson* events = result.get(u"events"_s);
            const OJson* resultState = result.get(u"state"_s);
            qualityMetrics_[symbol] = MetricsHit{
                metrics ? std::optional<OJson>(*metrics) : std::nullopt, at,
                stale ? std::optional<QString>(u"行情已停更 "_s + util::jsNumberToString(std::floor(staleMs / 60000 + 0.5)) + u" 分钟,本轮不判"_s) : std::nullopt};
            if (js::truthy(js::prop(metrics, u"delayed"_s)) || js::truthy(js::prop(snap, u"delayed"_s))) delayed = true;
            if (!events->items.isEmpty() || stableJson(resultState) != stableJson(stock.get(u"states"_s))) {
                // [...(stock["events"] ?? []), ...result.events].slice(-50)
                QList<OJson> all;
                if (const OJson* old = stock.get(u"events"_s); !js::nullish(old)) all = old->items;
                all.append(events->items);
                const qsizetype from = std::max<qsizetype>(0, all.size() - 50);
                store().updateQualityStock(js::str(stock.get(u"id"_s)), js::object({{u"states"_s, *resultState}, {u"events"_s, js::array(all.mid(from))}}));
            }
            OJson* outEvents = js::propMut(out.get(), u"events"_s);
            outEvents->items.append(events->items);
            js::propMut(out.get(), u"evaluated"_s)->items.append(js::S(symbol));
        } catch (...) {
            // 一只股出错不能拖垮其它股
            errors.append(symbol + u":"_s + svc1::slice(excMessage(std::current_exception()), 120));
        }
    }
    // 删掉 / 停用的股:样本与指标一起丢,不留在内存里
    QSet<QString> live;
    for (const OJson& s : latest) live.insert(js::str(s.get(u"symbol"_s)));
    for (auto it = qualitySamples_.begin(); it != qualitySamples_.end();) it = live.contains(it->first) ? std::next(it) : qualitySamples_.erase(it);
    for (auto it = qualityMetrics_.begin(); it != qualityMetrics_.end();) it = live.contains(it->first) ? std::next(it) : qualityMetrics_.erase(it);
    for (auto it = dayOpens_.begin(); it != dayOpens_.end();) it = live.contains(it->first) ? std::next(it) : dayOpens_.erase(it);
    loop_.delayed = delayed;
    loop_.last_error = svc1::slice(errors.join(u";"_s), 300);
    // 只推给界面,不走 notifier;信号成绩单照记
    const OJson& events = *out->get(u"events"_s);
    if (!events.items.isEmpty()) {
        QList<OJson> sigs;
        for (const OJson& e : events.items) sigs.append(analysis::signal_outcomes::signalFromAnomaly(e));
        store().signalLog().log(sigs);
        emitEvent(u"anomaly"_s, js::object({{u"events"_s, events}}));
    }
}

// ---------------------------------------------------------------- 状态 / 配置 / 监控
std::optional<OJson> AnomalyService::storedAnomalyState(const OJson* raw, const QString& etDate) {
    if (!raw || raw->type != OJson::Object || raw->fields.isEmpty()) return std::nullopt;
    const OJson* date = js::prop(raw, u"date"_s);
    if (js::isStr(date) && date->s != etDate) return std::nullopt;
    return an::coerceState(raw, etDate).toJson();
}

an::Config AnomalyService::config() {
    const OJson raw = store().getPref(kQualityConfigPref);
    if (raw.type == OJson::Null) return an::defaultConfig();
    try {
        return an::normalizeAnomalyConfig(&raw, an::defaultConfig());
    } catch (...) {
        return an::defaultConfig();
    }
}

OJson AnomalyService::monitor() {
    const LoopState& s = loop_;
    const std::shared_ptr<RouterPort> router = routerPort();
    const bool connected = router && router->hasSessions();
    bool supported;
    if (router) {
        const std::shared_ptr<Svc1Router> source = std::dynamic_pointer_cast<Svc1Router>(router);
        supported = source && source->supportsVolumeQuotes();
    } else {
        supported = settings().broker.provider != u"futu";
    }
    const QString session = anomalySessionOf(settings().marketStatus(domain::nowEt()));
    QString note;
    if (!connected) note = u"未连接券商"_s;
    else if (!supported) note = u"当前券商(富途)暂不支持异动监控"_s;
    else if (session == u"closed") note = u"休市:开盘后开始检测"_s;
    else if (session == u"pre") note = u"盘前:开盘后开始检测"_s;
    else if (session == u"post") note = u"盘后:今日检测已结束"_s;
    else if (s.delayed) note = u"延迟行情:提醒会晚约 15 分钟"_s;
    return js::object({{u"running"_s, js::B(s.running)},
                       {u"interval_ms"_s, js::N(s.interval_ms)},
                       {u"ticks"_s, js::N(s.ticks)},
                       {u"last_at"_s, s.last_at ? js::S(*s.last_at) : js::Null()},
                       {u"last_ms"_s, js::NOrNull(s.last_ms)},
                       {u"last_error"_s, js::S(s.last_error)},
                       {u"session"_s, js::S(session)},
                       {u"connected"_s, js::B(connected)},
                       {u"supported"_s, js::B(supported)},
                       {u"note"_s, js::S(note)},
                       {u"market_ref"_s, s.market_ref ? js::B(*s.market_ref) : js::Null()}});
}

std::optional<AnomalyService::MetricsHit> AnomalyService::metricsOf(const QString& symbol) const {
    const auto it = qualityMetrics_.find(symbol);
    if (it == qualityMetrics_.end()) return std::nullopt;
    return it->second;
}

void AnomalyService::forget(const QString& symbol) {
    qualitySamples_.erase(symbol);
    qualityMetrics_.erase(symbol);
    dayOpens_.erase(symbol);
}

}  // namespace ibkr::orchestrate
