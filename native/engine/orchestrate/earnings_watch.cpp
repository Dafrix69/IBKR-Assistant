#include "orchestrate/earnings_watch.h"

#include "orchestrate/engine_ports.h"
#include "orchestrate/engine_router.h"
#include "util/earnings.h"
#include "util/jsobj.h"

#include <QDate>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>

#include <cmath>
#include <exception>

using namespace Qt::StringLiterals;
namespace js = ibkr::util::js;
namespace etp = ibkr::analysis::etp;

namespace ibkr::orchestrate {

namespace {
using Rec = util::OJson;

QString px(double v) { return QString::number(v, 'f', 2); }
QString pctText(double v) { return QString::number(v, 'g', 6); }

std::optional<etp::Window> storedWindow(const Rec& e) {
    const auto start = js::finiteOrNull(js::prop(&e, u"start_ms"_s));
    const auto end = js::finiteOrNull(js::prop(&e, u"end_ms"_s));
    if (!start || !end) return std::nullopt;
    etp::Window w;
    w.date = js::strOr(js::prop(&e, u"date"_s), QString());
    w.timing = js::strOr(js::prop(&e, u"timing"_s), QString());
    w.refDate = js::strOr(js::prop(&e, u"ref_date"_s), QString());
    w.reactDate = js::strOr(js::prop(&e, u"react_date"_s), QString());
    w.startMs = *start;
    w.endMs = *end;
    return w;
}

void putWindow(Rec& e, const etp::Window& w) {
    e.set(u"date"_s, js::S(w.date));
    e.set(u"timing"_s, js::S(w.timing));
    e.set(u"ref_date"_s, js::S(w.refDate));
    e.set(u"react_date"_s, js::S(w.reactDate));
    e.set(u"start_ms"_s, js::N(w.startMs));
    e.set(u"end_ms"_s, js::N(w.endMs));
}

QString windowText(const etp::Window& w) { return u"财报 %1 %2"_s.arg(w.date, etp::timingLabel(w.timing)); }
}  // namespace

EarningsWatch::EarningsWatch(Host host) : host_(std::move(host)) {}

void EarningsWatch::warnOnce(const QString& key, const QString& message) {
    if (st_->warned.contains(key)) return;
    st_->warned.insert(key);
    if (host_.warn) host_.warn(message);
}

void EarningsWatch::save(const Rec& track, const Rec& e) {
    const Rec* stored = js::prop(&track, u"targets"_s);
    Rec targets = js::isObj(stored) ? *stored : js::object();
    targets.set(u"earnings_tp"_s, e);
    host_.saveTargets(js::str(js::prop(&track, u"id"_s)), targets);
}

util::Task<> EarningsWatch::fetchCalendar(std::shared_ptr<State> st, std::shared_ptr<EngineRouter> router, QString symbol, QString today, double nowMs) {
    std::optional<QJsonObject> view;
    QString error;
    try {
        const Rec raw = co_await router->earnings(symbol);
        view = util::earningsView(raw.toQJson(), QJsonArray(), QDate::fromString(today, Qt::ISODate));
    } catch (...) {
        error = jsx::errorMessage(std::current_exception());
    }
    CalEntry& e = st->cal[symbol];
    e.inFlight = false;
    if (view) {
        const auto parsed = util::parseOJson(QString::fromUtf8(QJsonDocument(*view).toJson(QJsonDocument::Compact)));
        e.view = parsed ? *parsed : js::object();
        e.fetchedAt = nowMs;
        e.error.clear();
    } else {
        e.error = error.isEmpty() ? u"没有回包"_s : error;
    }
}

util::Task<> EarningsWatch::fetchClose(std::shared_ptr<State> st, std::shared_ptr<EngineRouter> router, QString symbol, QString refDate) {
    std::optional<double> close;
    QString error;
    try {
        const QList<Rec> bars = co_await router->dailyBars(symbol, refDate, refDate);
        for (const Rec& b : bars) {
            if (js::strOr(js::prop(&b, u"date"_s), QString()).left(10) != refDate) continue;
            const auto c = js::finiteOrNull(js::prop(&b, u"close"_s));
            if (c && *c > 0) close = c;
        }
        if (!close) error = u"日线里没有 %1 这一天"_s.arg(refDate);
    } catch (...) {
        error = jsx::errorMessage(std::current_exception());
    }
    CloseEntry& e = st->close[symbol + u"|"_s + refDate];
    e.inFlight = false;
    e.close = close;
    e.error = error;
}

etp::Planned EarningsWatch::pick(const Rec& view, double nowMs) const {
    // 候选:最近一场已经过了日期的(盘后发的那一场,第二天还在窗口里)与下一场。先看早的
    QList<const Rec*> candidates;
    const Rec* history = js::prop(&view, u"history"_s);
    if (js::isArr(history) && !history->items.isEmpty()) candidates << &history->items.first();
    if (const Rec* up = js::prop(&view, u"upcoming"_s); js::isObj(up)) candidates << up;
    QString issue = js::strOr(js::prop(&view, u"message"_s), QString());
    if (issue.isEmpty()) issue = u"IBKR 财报日历里没有下一场财报的日期。"_s;
    for (const Rec* c : candidates) {
        const QString date = js::strOr(js::prop(c, u"date"_s), QString());
        const QString timing = js::strOr(js::prop(c, u"timing"_s), QString());
        const bool confirmed = js::strOr(js::prop(c, u"status"_s), QString()) == u"CONFIRMED";
        const etp::Planned p = etp::planWindow(date, timing, host_.calendar);
        if (p.window && p.window->endMs <= nowMs) continue;  // 已经过完的那一场
        if (!confirmed) return {std::nullopt, u"IBKR 财报日历里 %1 这一场的日期还没确认。"_s.arg(date)};
        return p;
    }
    return {std::nullopt, issue};
}

util::Task<std::optional<EarningsWatch::Step>> EarningsWatch::step(Rec track, Rec raw, tracker::Position position, domain::EtNow at, bool active, bool hosted) {
    const Rec* stored = js::prop(js::prop(&track, u"targets"_s), u"earnings_tp"_s);
    if (!js::isObj(stored) || position.sec_type != u"STK") co_return std::nullopt;
    Rec e = *stored;
    const auto pct = js::finiteOrNull(js::prop(&e, u"pct"_s));
    if (!pct) co_return std::nullopt;
    const QString tid = js::str(js::prop(&track, u"id"_s));
    const QString symbol = js::strOr(js::prop(&raw, u"symbol"_s), position.symbol);
    const bool lng = tracker::isLong(position);
    const double now = at.epochMs;
    const QString moveWord = lng ? u"涨"_s : u"跌"_s;

    Step out;
    const auto finish = [&](const QString& phase, const QString& reason) {
        Rec row = e;
        row.set(u"phase"_s, js::S(phase));
        row.set(u"reason"_s, js::S(reason));
        out.row = row;
        return out;
    };
    if (js::truthy(js::prop(&e, u"lapsed"_s))) co_return finish(u"lapsed"_s, u"财报止盈已过期:财报后第一个常规时段收盘前没有到价。"_s);
    if (!active) co_return finish(u"idle"_s, QString());

    const std::shared_ptr<EngineRouter> router = host_.router ? host_.router() : nullptr;
    const bool data = router && router->hasEarningsData();
    std::optional<etp::Window> window = storedWindow(e);
    const bool manual = js::truthy(js::prop(&e, u"manual"_s));

    // ---- 窗口:手填的建追踪时就排好了;没填的照 IBKR 财报日历排,开窗之前隔一阵核对一次(日期会改)
    if (!manual && (!window || now < window->startMs)) {
        if (!data) {
            if (!window) co_return finish(u"unresolved"_s, u"没有连着 IBKR,读不到财报日历;财报止盈还没生效。"_s);
        } else {
            CalEntry& cal = st_->cal[symbol];
            const bool stale = !cal.view || now - cal.fetchedAt >= refreshMs;
            if (stale && !cal.inFlight && now - cal.triedAt >= retryMs) {
                cal.inFlight = true;
                cal.triedAt = now;
                util::detach(fetchCalendar(st_, router, symbol, at.date, now));
            }
            if (cal.view) {
                const etp::Planned p = pick(*cal.view, now);
                if (p.window && (!window || window->date != p.window->date || window->timing != p.window->timing)) {
                    if (window)
                        warnOnce(tid + u"|moved|"_s + p.window->date + p.window->timing,
                                 u"%1 的财报日期变了:%2 → %3,财报止盈跟着改。"_s.arg(symbol, windowText(*window), windowText(*p.window)));
                    window = p.window;
                    putWindow(e, *window);
                    e.set(u"ref_close"_s, js::Null());
                    save(track, e);
                } else if (!p.window && !window) {
                    warnOnce(tid + u"|issue|"_s + p.issue, u"%1 的财报止盈还没生效:%2 可以在追踪里手填财报日与盘前 / 盘后。"_s.arg(symbol, p.issue));
                    co_return finish(u"unresolved"_s, p.issue + u"财报止盈还没生效,隔一阵会再查。"_s);
                }
            } else if (!window) {
                if (!cal.error.isEmpty()) {
                    warnOnce(tid + u"|cal|"_s + cal.error, u"%1 的财报日历读不到(%2),财报止盈还没生效。可以在追踪里手填财报日与盘前 / 盘后。"_s.arg(symbol, cal.error.left(120)));
                    co_return finish(u"unresolved"_s, u"读不到 IBKR 财报日历(%1);财报止盈还没生效,隔一阵会再试。"_s.arg(cal.error.left(120)));
                }
                co_return finish(u"resolving"_s, u"正在向 IBKR 查财报日期…"_s);
            }
        }
    }
    if (!window) co_return finish(u"unresolved"_s, u"财报日期还没定下来,财报止盈还没生效。"_s);

    const QString head = u"%1,比 %2 收盘%3 %4% 就平"_s.arg(windowText(*window), window->refDate, moveWord, pctText(*pct));
    if (now < window->startMs) co_return finish(u"waiting"_s, head + u";%1 收盘后开始盯。"_s.arg(window->refDate));
    if (now >= window->endMs) {
        e.set(u"lapsed"_s, js::B(true));
        save(track, e);
        warnOnce(tid + u"|lapsed"_s, u"%1 的财报止盈过期了:到 %2 收盘没有到价,这一项不再判。别的止盈止损照常。"_s.arg(symbol, window->reactDate));
        co_return finish(u"lapsed"_s, u"财报止盈已过期:财报后第一个常规时段收盘前没有到价。"_s);
    }

    // ---- 基准收盘价:基准日的日线收盘,取到就落库
    std::optional<double> refClose = js::finiteOrNull(js::prop(&e, u"ref_close"_s));
    if (!refClose) {
        if (!data) co_return finish(u"armed"_s, head + u";没有连着 IBKR,取不到 %1 的收盘价。"_s.arg(window->refDate));
        CloseEntry& ce = st_->close[symbol + u"|"_s + window->refDate];
        if (ce.close) {
            refClose = ce.close;
            e.set(u"ref_close"_s, js::N(*refClose));
            save(track, e);
        } else {
            if (!ce.inFlight && now >= window->startMs + closeDelayMs && now - ce.triedAt >= retryMs) {
                ce.inFlight = true;
                ce.triedAt = now;
                util::detach(fetchClose(st_, router, symbol, window->refDate));
            }
            co_return finish(u"armed"_s, head + (ce.error.isEmpty() ? u";正在取 %1 的收盘价。"_s.arg(window->refDate)
                                                                    : u";%1 的收盘价还没取到(%2),隔一阵再试。"_s.arg(window->refDate, ce.error.left(120))));
        }
    }
    const std::optional<double> target = etp::targetPrice(lng, *refClose, *pct);
    if (!target) co_return finish(u"armed"_s, head + u";算不出止盈价。"_s);
    e.set(u"target"_s, js::N(std::round(*target * 100) / 100));
    const QString line = u"%1(%2 收盘 %3 → %4)"_s.arg(head, window->refDate, px(*refClose), px(*target));

    // ---- 这一轮判不判
    const QString session = etp::stockSession(host_.baseStatus(at), at.date, at.seconds, host_.calendar);
    e.set(u"session"_s, js::S(session));
    if (session == u"休市") co_return finish(u"armed"_s, line + u";此刻休市,不判。"_s);
    out.overnight = session == etp::kOvernight;
    if (out.overnight && hosted) co_return finish(u"armed"_s, line + u";托管到券商的单不进夜盘,夜盘这一段不判,盘前接着盯。"_s);
    if (!data) co_return finish(u"armed"_s, line + u";没有连着 IBKR,读不到买卖价。"_s);
    Rec book;
    bool bookFailed = false;
    try {
        book = co_await router->stockBook(symbol, out.overnight);
    } catch (...) {
        bookFailed = true;
    }
    const std::optional<double> exec = bookFailed ? std::nullopt
                                                  : etp::executable(lng, js::finiteOrNull(js::prop(&book, u"bid"_s)), js::finiteOrNull(js::prop(&book, u"ask"_s)));
    const QString side = lng ? u"买价"_s : u"卖价"_s;
    if (!exec) co_return finish(u"armed"_s, line + u";%1拿不到买卖价,这一轮不判。"_s.arg(session));
    out.exec = exec;
    e.set(u"price"_s, js::N(*exec));
    out.hit = etp::reached(lng, *target, *exec);
    e.set(u"hit"_s, js::B(out.hit));
    if (out.hit)
        co_return finish(u"hit"_s, u"财报止盈:%1%2 %3 %4 止盈价 %5(%6 收盘 %7 %8 %9%)"_s
                                       .arg(session, side, px(*exec), lng ? u"≥"_s : u"≤"_s, px(*target))
                                       .arg(window->refDate, px(*refClose), moveWord, pctText(*pct)));
    co_return finish(u"armed"_s, line + u";%1%2 %3。"_s.arg(session, side, px(*exec)));
}

}  // namespace ibkr::orchestrate
