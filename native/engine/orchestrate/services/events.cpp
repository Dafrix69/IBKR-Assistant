#include "orchestrate/services/events.h"

#include "analysis/cross_market.h"
#include "analysis/econ_calendar.h"
#include "orchestrate/services/public_fetch.h"
#include "orchestrate/services/svc_util.h"
#include "util/js_runtime.h"
#include "util/jsformat.h"
#include "util/jsnum.h"
#include "util/jsobj.h"
#include "util/rpc_error.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using util::OJson;
using util::RpcError;
using util::Task;
namespace js = util::js;
namespace ec = analysis::econ_calendar;
namespace cm = analysis::cross_market;

namespace {

/// String.prototype.trim:去掉 JS 的空白与行终止符(含 U+FEFF)
QString jsTrim(const QString& s) {
    qsizetype a = 0, b = s.size();
    while (a < b && util::isJsWhitespace(s[a])) ++a;
    while (b > a && util::isJsWhitespace(s[b - 1])) --b;
    return s.mid(a, b - a);
}

}  // namespace

/// Number.prototype.toString(radix) 对非负有限数:V8 DoubleToRadixCString 的算法(整数部分、到该双精度能分辨的位数为止的小数部分,最后一位按偶数舍入)
QString toRadixString(double value, int radix) {
    static const char chars[] = "0123456789abcdefghijklmnopqrstuvwxyz";
    double integer = std::floor(value);
    double fraction = value - integer;
    double delta = 0.5 * (std::nextafter(value, std::numeric_limits<double>::infinity()) - value);
    delta = std::max(std::nextafter(0.0, 1.0), delta);
    QByteArray frac;  // 小数点之后的位
    if (fraction >= delta) {
        do {
            fraction *= radix;
            delta *= radix;
            const int digit = static_cast<int>(fraction);
            frac.append(chars[digit]);
            fraction -= digit;
            if (fraction > 0.5 || (fraction == 0.5 && (digit & 1))) {
                if (fraction + delta > 1) {
                    // 进位:回头改已经写下的位
                    while (true) {
                        if (frac.isEmpty()) {
                            integer += 1;
                            break;
                        }
                        const char c = frac.back();
                        frac.chop(1);
                        const int d = c > '9' ? (c - 'a' + 10) : (c - '0');
                        if (d + 1 < radix) {
                            frac.append(chars[d + 1]);
                            break;
                        }
                    }
                    break;
                }
            }
        } while (fraction >= delta);
    }
    // 整数部分:用 double 的取余与相减一位位往下取(2^57 以内与 Electron 41 的 V8 逐位一致,对拍实测;更大的数 V8 会把低位补零,规则没复现——id 只用 Date.now() 与 [0,1) 的随机数,碰不到)
    QByteArray ints;
    do {
        const double remainder = std::fmod(integer, radix);
        ints.prepend(chars[static_cast<int>(remainder)]);
        integer = (integer - remainder) / radix;
    } while (integer > 0);
    return QString::fromLatin1(frac.isEmpty() ? ints : ints + '.' + frac);
}

namespace {

double lingerCustom() { return js::num(js::prop(&ec::lingerMinTable(), u"custom"_s)); }

}  // namespace

EventsService::EventsService(SvcHost& host) : SvcBase(host) {
    nowFn = [] { return util::dateNow(); };
    fetcher = [](const QString& url, double timeoutMs) { return publicFetch(url, timeoutMs, u"dafri-trading/0.2 (event calendar)"_s, u"日历源"_s); };
}

// ---- 口径 ----------------------------------------------------------------
OJson EventsService::config() {
    try {
        const OJson raw = store().getPref(kConfigPref);
        return ec::normalizeEventsConfig(&raw);
    } catch (...) {
        return ec::defaultEventsConfig();  // 手改坏了的偏好按默认
    }
}

OJson EventsService::setConfig(const OJson& input) {
    // 界面一次只改一两项:在当前生效的那份上合并,不是在默认值上
    const OJson current = config();
    const OJson cfg = ec::normalizeEventsConfig(&input, current);
    store().setPref(kConfigPref, &cfg);
    const OJson detail = js::object({{u"config"_s, cfg}});
    store().audit(u"ui"_s, u"events_config"_s, &detail);
    return cfg;
}

// ---- 自定义事件 -------------------------------------------------------------
QList<EventsService::CustomRow> EventsService::customRows() {
    const OJson raw = store().getPref(kCustomPref);
    QList<CustomRow> out;
    if (!js::isArr(&raw)) return out;
    for (const OJson& item : raw.items) {
        if (!js::isObjectLike(&item) || item.type == OJson::Null) continue;
        const OJson *id = js::prop(&item, u"id"_s), *title = js::prop(&item, u"title"_s), *date = js::prop(&item, u"date_et"_s), *time = js::prop(&item, u"time_et"_s);
        if (!js::isStr(id) || !js::isStr(title) || !js::isStr(date) || !js::isStr(time)) continue;
        const OJson* note = js::prop(&item, u"note"_s);
        const OJson* impact = js::prop(&item, u"impact"_s);
        const OJson* linger = js::prop(&item, u"linger_min"_s);
        CustomRow r;
        r.id = id->s;
        r.title = title->s;
        r.date_et = date->s;
        r.time_et = time->s;
        r.note = js::isStr(note) ? note->s : QString();
        r.impact = js::isStr(impact) && impact->s == u"medium" ? u"medium"_s : u"high"_s;
        r.linger_min = js::isNum(linger) && std::isfinite(linger->n) ? linger->n : lingerCustom();
        out.append(r);
    }
    return out;
}

QList<OJson> EventsService::customEvents() {
    QList<OJson> out;
    for (const CustomRow& r : customRows()) {
        const std::optional<double> at = ec::etEpoch(r.date_et, r.time_et);
        if (!at) continue;
        const double stars = r.impact == u"medium" ? 3 : 4;
        OJson e = js::object({{u"id"_s, js::S(r.id)}, {u"kind"_s, js::S(u"custom"_s)}, {u"title"_s, js::S(r.title)}, {u"at"_s, js::N(*at)},
                              {u"date_et"_s, js::S(r.date_et)}, {u"time_et"_s, js::S(r.time_et)}, {u"stars"_s, js::N(stars)},
                              {u"impact"_s, js::S(ec::impactOfStars(stars))}, {u"source"_s, js::S(u"custom"_s)}, {u"linger_min"_s, js::N(r.linger_min)}});
        if (!r.note.isEmpty()) e.set(u"note"_s, js::S(r.note));
        out.append(e);
    }
    return out;
}

OJson EventsService::add(const AddParams& params) {
    const QString title = jsTrim(params.title).left(80);
    if (title.isEmpty()) throw RpcError(-32602, u"事件要有个名字"_s);
    const QString date = jsTrim(params.date_et);
    const QString time = jsTrim(params.time_et);
    const std::optional<double> at = ec::etEpoch(date, time);
    if (!at) throw RpcError(-32602, u"日期要写成 2026-10-14、钟点要写成美东的 08:30"_s);
    const double linger = params.linger_min ? *params.linger_min : lingerCustom();
    if (!std::isfinite(linger) || linger < 5 || linger > 24 * 60) throw RpcError(-32602, u"公布后挂多久要在 5 ~ 1440 分钟之间"_s);
    const QList<CustomRow> rows = customRows();
    if (rows.size() >= kMaxCustom) throw RpcError(-32602, u"自定义事件最多 %1 条,先删几条"_s.arg(kMaxCustom));
    const double nowMs = util::dateNow();
    const double rnd = rt().random();
    const QString id = u"custom:"_s + toRadixString(nowMs, 36) + toRadixString(rnd, 36).mid(2, 6);
    const auto rowJson = [](const CustomRow& r) {
        return js::object({{u"id"_s, js::S(r.id)}, {u"title"_s, js::S(r.title)}, {u"date_et"_s, js::S(r.date_et)}, {u"time_et"_s, js::S(r.time_et)},
                           {u"note"_s, js::S(r.note)}, {u"impact"_s, js::S(r.impact)}, {u"linger_min"_s, js::N(r.linger_min)}});
    };
    CustomRow row;
    row.id = id;
    row.title = title;
    row.date_et = date;
    row.time_et = time;
    row.note = jsTrim(params.note.value_or(QString())).left(200);
    row.impact = params.impact && *params.impact == u"medium" ? u"medium"_s : u"high"_s;
    row.linger_min = util::jsRound(linger);
    OJson all = js::array();
    for (const CustomRow& r : rows) all.items.append(rowJson(r));
    all.items.append(rowJson(row));
    store().setPref(kCustomPref, &all);
    const OJson detail = js::object({{u"id"_s, js::S(row.id)}, {u"title"_s, js::S(row.title)}, {u"date_et"_s, js::S(row.date_et)}, {u"time_et"_s, js::S(row.time_et)}});
    store().audit(u"ui"_s, u"events_add"_s, &detail);
    for (const OJson& e : customEvents())
        if (js::str(js::prop(&e, u"id"_s)) == row.id) return e;
    throw RpcError(-32603, u"事件没记上"_s);
}

bool EventsService::remove(const QString& id) {
    const QList<CustomRow> rows = customRows();
    OJson rest = js::array();
    qsizetype kept = 0;
    for (const CustomRow& r : rows) {
        if (r.id == id) continue;
        ++kept;
        rest.items.append(js::object({{u"id"_s, js::S(r.id)}, {u"title"_s, js::S(r.title)}, {u"date_et"_s, js::S(r.date_et)}, {u"time_et"_s, js::S(r.time_et)},
                                      {u"note"_s, js::S(r.note)}, {u"impact"_s, js::S(r.impact)}, {u"linger_min"_s, js::N(r.linger_min)}}));
    }
    if (kept == rows.size()) return false;
    store().setPref(kCustomPref, &rest);
    const OJson detail = js::object({{u"id"_s, js::S(id)}});
    store().audit(u"ui"_s, u"events_remove"_s, &detail);
    return true;
}

// ---- 日历源 ----------------------------------------------------------------
bool EventsService::feedStale(double now) const {
    if (!feedAt_) return !feedTriedAt_ || now - *feedTriedAt_ >= kRetryMs;
    if (now - *feedAt_ < kFeedTtlMs) return false;
    return !feedTriedAt_ || now - *feedTriedAt_ >= kRetryMs;
}

Task<> EventsService::refreshFeed() {
    if (inflight_ && !inflight_->done()) co_return co_await Task<>(*inflight_);  // 单飞
    feedTriedAt_ = now();
    Task<> run = [](EventsService* self) -> Task<> {
        try {
            const OJson payload = co_await self->fetcher(kFeedUrl, kTimeoutMs);
            if (!js::isArr(&payload)) throw util::JsError(u"日历源返回的不是清单"_s);
            self->feedRows_ = ec::parseFeed(&payload);
            self->feedAt_ = self->now();
            self->feedError_.reset();
        } catch (...) {
            self->feedError_ = sliceUnits(errMessage(std::current_exception()), 200);
        }
    }(this);
    inflight_ = run;
    co_await run;
}

// ---- 跨市场跟跌套利 --------------------------------------------------------------
/// 美股当日涨跌从行情带那一路读(连着 TWS 是流式,否则公开源);ETF 的报价连着券商问券商,否则走公开源。都失败时原因记下来,不炸
Task<> EventsService::refreshCross(double nowArg, OJson config) {
    if (crossInflight_ && !crossInflight_->done()) co_return co_await Task<>(*crossInflight_);
    Task<> run = [](EventsService* self, double now, OJson config) -> Task<> {
        try {
            auto r = self->routerPort();
            const auto router = (r && r->hasSessions()) ? r : nullptr;
            // macroBoard 的 router 面是同步的:异步的流式报价先取好再交给它;取不到就这一轮走公开源
            OJson live = js::object();
            if (router) {
                try {
                    live = co_await router->streamQuotes(analysis::macro::liveTickers());
                } catch (...) {
                    live = js::object();
                }
            }
            analysis::macro::BoardOptions opts;
            opts.timeout = 4;
            if (router) opts.streamQuotes = [live](const QStringList&) { return live; };
            opts.fetcher = self->fetcher;
            opts.now = [self] { return self->now() / 1000; };
            const OJson board = co_await analysis::macro::macroBoard(opts);
            const OJson* spx = nullptr;
            for (const OJson& row : js::prop(&board, u"rows"_s)->items)
                if (js::str(js::prop(&row, u"key"_s)) == u"^GSPC") {
                    spx = &row;
                    break;
                }
            const OJson* pct = js::prop(spx, u"change_pct"_s);
            std::optional<double> usPct;
            if (!js::nullish(pct)) usPct = js::num(pct);
            OJson quotes = js::object();
            const auto copyQuotes = [&quotes](const OJson& got) {
                for (const QString& symbol : js::keys(&got)) {
                    const OJson* q = js::prop(&got, symbol);
                    OJson entry = js::object({{u"symbol"_s, js::S(symbol)}});
                    if (const OJson* l = js::prop(q, u"last"_s)) entry.set(u"last"_s, *l);
                    if (const OJson* c = js::prop(q, u"change_pct"_s)) entry.set(u"change_pct"_s, *c);
                    quotes.set(symbol, entry);
                }
            };
            if (router) {
                // 连着券商:router 是上面取到的那一个(TS 里同一个局部变量)
                copyQuotes(co_await router->stockQuotes(cm::crossSymbols()));
            } else {
                copyQuotes(co_await analysis::macro::publicQuotes(cm::crossSymbols(), 4, self->fetcher));
            }
            if (!usPct) {
                const OJson* err = js::prop(spx, u"error"_s);
                throw util::JsError(js::truthy(err) ? u"标普 500 的涨跌取不到:%1"_s.arg(js::str(err)) : u"标普 500 的涨跌取不到"_s);
            }
            QStringList missing;
            for (const QString& s : cm::crossSymbols()) {
                const OJson* c = js::prop(js::prop(&quotes, s), u"change_pct"_s);  // quotes[s]?.change_pct === null || === undefined
                if (!c || c->type == OJson::Null) missing.append(s);
            }
            self->crossEvent_ = cm::evaluateCrossMarket(usPct, quotes, now, cm::Cfg{js::num(js::prop(&config, u"cross_market_pct"_s)), js::num(js::prop(&config, u"cross_lag_pct"_s))});
            self->crossError_ = missing.isEmpty() ? std::nullopt : std::optional<QString>(u"这几只的报价取不到:%1"_s.arg(missing.join(u'、')));
        } catch (...) {
            self->crossError_ = sliceUnits(errMessage(std::current_exception()), 200);
        }
        self->crossAt_ = self->now();
    }(this, nowArg, std::move(config));
    crossInflight_ = run;
    co_await run;
}

Task<EventsService::CrossResult> EventsService::cross(double nowArg, OJson config) {
    const bool inWindow = js::truthy(js::prop(&config, u"cross_market"_s)) && cm::crossWindow(nowArg).has_value();
    if (!inWindow) {
        crossEvent_ = OJson::null();
        co_return CrossResult{OJson::null(), js::object({{u"in_window"_s, js::B(false)}, {u"at"_s, js::NOrNull(crossAt_)}, {u"error"_s, js::Null()}})};
    }
    if (!crossAt_ || nowArg - *crossAt_ >= kCrossTtlMs) {
        // 还没判过、或上次没判出事:同步等这一次(有时限);判出过事的旧值先给、新值后台取——界面在窗口里一分钟问一次
        if (!crossAt_ || crossEvent_.type == OJson::Null) co_await refreshCross(nowArg, config);
        else util::detach(refreshCross(nowArg, config));
    }
    co_return CrossResult{crossEvent_, js::object({{u"in_window"_s, js::B(true)}, {u"at"_s, js::NOrNull(crossAt_)},
                                                    {u"error"_s, crossError_ ? js::S(*crossError_) : js::Null()}})};
}

// ---- 清单 ------------------------------------------------------------------
Task<OJson> EventsService::list(bool force) {
    const OJson cfg = config();
    const double nowMs = now();
    // 整个功能关着:一条都不给(界面上就什么都不挂),日历源也不拉
    if (!js::truthy(js::prop(&cfg, u"enabled"_s))) {
        co_return js::object({{u"events"_s, js::array()},
                              {u"cross"_s, js::Null()},
                              {u"cross_status"_s, js::object({{u"in_window"_s, js::B(false)}, {u"at"_s, js::Null()}, {u"error"_s, js::Null()}})},
                              {u"config"_s, cfg},
                              {u"feed"_s, js::object({{u"at"_s, js::NOrNull(feedAt_)}, {u"error"_s, js::Null()}, {u"count"_s, js::N(0)}})},
                              {u"at"_s, js::N(nowMs)}});
    }
    const bool feedOn = js::truthy(js::prop(&cfg, u"feed"_s));
    if (feedOn) {
        if (force || !feedAt_) {
            // 用户点了刷新、或从没拉到过:同步等这一次(有时限),让第一眼就有本周的事
            if (force || feedStale(nowMs)) co_await refreshFeed();
        } else if (feedStale(nowMs)) {
            util::detach(refreshFeed());  // 旧值先给,新值后台取
        }
    }
    const double from = nowMs - kLookbackMs;
    const double to = nowMs + kHorizonMs;
    const QList<OJson> feed = feedOn ? feedRows_ : QList<OJson>{};
    // 官方日程与日历源按「最低星级」筛;自己记的不筛——记下来就是要看的
    const double minStars = js::num(js::prop(&cfg, u"min_stars"_s));
    QList<OJson> events;
    for (const OJson& e : ec::mergeEvents(ec::builtinEvents(from, to), feed, customEvents())) {
        const double at = js::num(js::prop(&e, u"at"_s));
        if (at >= from && at <= to && (js::str(js::prop(&e, u"source"_s)) == u"custom" || js::num(js::prop(&e, u"stars"_s)) >= minStars)) events.append(e);
    }
    double feedCount = 0;
    for (const OJson& e : events)
        if (js::str(js::prop(&e, u"source"_s)) == u"feed") ++feedCount;
    const OJson status = js::object({{u"at"_s, js::NOrNull(feedAt_)}, {u"error"_s, feedOn && feedError_ ? js::S(*feedError_) : js::Null()}, {u"count"_s, js::N(feedCount)}});
    const CrossResult c = co_await cross(nowMs, cfg);
    co_return js::object({{u"events"_s, js::array(events)}, {u"cross"_s, c.event}, {u"cross_status"_s, c.status}, {u"config"_s, cfg}, {u"feed"_s, status}, {u"at"_s, js::N(nowMs)}});
}

}  // namespace ibkr::orchestrate
