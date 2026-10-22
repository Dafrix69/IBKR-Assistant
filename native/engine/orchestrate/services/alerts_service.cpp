#include "orchestrate/services/alerts_service.h"

#include "analysis/signal_outcomes.h"
#include "orchestrate/services/svc1_util.h"
#include "util/error.h"
#include "util/jsformat.h"
#include "util/jsvalue.h"
#include "util/py.h"
#include "util/rpc_error.h"
#include "util/tz.h"

#include <QSet>

#include <cmath>
#include <limits>

namespace ibkr::orchestrate {

using namespace Qt::StringLiterals;
using util::OJson;
using util::Task;
namespace js = util::js;
namespace al = analysis::alerts;
namespace mt = analysis::ma_touch;
using svc1::excMessage;

namespace {

/// 步长:0 = 自动,正数 = 固定步长(上限同 store.addWatch)。数字串也认。raw 空 = undefined
double stepOrRaise(const OJson* raw) {
    // typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw
    const bool numeric = raw && raw->type == OJson::String && !util::jsTrim(raw->s).isEmpty();
    const OJson* num = raw;
    OJson converted;
    if (numeric) {
        converted = OJson::number(util::jsStringToNumber(raw->s));
        num = &converted;
    }
    if (!js::isNum(num) || !(num->n >= 0 && num->n <= 1000)) throw util::RpcError(-32602, u"整数关口步长必须在 0~1000 之间(0 = 自动)"_s);
    return num->n;
}

/// 库里读回来的一个价位:运行时逐项兜底(老库、手改过的行)
al::AlertLevel storedLevel(const OJson& l) {
    al::AlertLevel out;
    out.price = js::num(js::prop(&l, u"price"_s));
    out.label = js::strOr(js::prop(&l, u"label"_s), QString());
    out.source = js::strOr(js::prop(&l, u"source"_s), u"round"_s);
    const OJson* kind = js::prop(&l, u"kind"_s);
    out.kind = (js::isStr(kind) && (kind->s == u"resistance" || kind->s == u"support")) ? kind->s : u"pivot"_s;
    out.priority = 0;
    const OJson* ma = js::prop(&l, u"ma"_s);
    if (js::truthy(ma)) {
        const double period = js::num(js::prop(ma, u"period"_s)), priorSum = js::num(js::prop(ma, u"prior_sum"_s));
        if (std::isfinite(period) && std::isfinite(priorSum)) out.ma = al::MaRef{period, priorSum};
    }
    return out;
}

/// 均线价位的收盘和以碰均线的底账为准——只要底账是上一个交易日收盘的(as_of = prevDay)。
const OJson* bookLineFor(const OJson* book, const QString& prevDay, double period) {
    if (!js::truthy(book)) return nullptr;
    const OJson* asOf = js::prop(book, u"as_of"_s);
    if (!(js::isStr(asOf) && asOf->s == prevDay)) return nullptr;
    const OJson* lines = js::propStrict(book, u"lines"_s);
    if (!js::isArr(lines)) return nullptr;
    for (const OJson& x : lines->items) {
        const OJson* p = js::prop(&x, u"period"_s);
        if (js::isNum(p) && p->n == period) return &x;
    }
    return nullptr;
}

std::vector<al::AlertLevel> withBookSums(std::vector<al::AlertLevel> levels, const OJson* book, const QString& prevDay) {
    if (!js::truthy(book)) return levels;
    const OJson* asOf = js::prop(book, u"as_of"_s);
    if (!(js::isStr(asOf) && asOf->s == prevDay)) return levels;
    for (al::AlertLevel& l : levels) {
        if (!l.ma) continue;
        if (const OJson* line = bookLineFor(book, prevDay, l.ma->period)) l.ma = al::MaRef{l.ma->period, js::num(js::prop(line, u"prior_sum"_s))};
    }
    return levels;
}

/// 同上,作用在库里读回来的原样价位(WatchLevel 的 JSON)上:ma 换成 {period, prior_sum}(位置不动)
QList<OJson> withBookSumsRaw(const QList<OJson>& levels, const OJson* book, const QString& prevDay) {
    QList<OJson> out = levels;
    if (!js::truthy(book)) return out;
    const OJson* asOf = js::prop(book, u"as_of"_s);
    if (!(js::isStr(asOf) && asOf->s == prevDay)) return out;
    for (OJson& l : out) {
        const OJson* ma = js::prop(&l, u"ma"_s);
        if (!js::truthy(ma)) continue;
        const OJson* periodV = js::prop(ma, u"period"_s);
        const OJson* line = js::isNum(periodV) ? bookLineFor(book, prevDay, periodV->n) : nullptr;
        if (line) l.set(u"ma"_s, js::object({{u"period"_s, js::copyOrNull(periodV)}, {u"prior_sum"_s, js::copyOrNull(js::prop(line, u"prior_sum"_s))}}));
    }
    return out;
}

/// 库里读回来的一个价位状态;待确认的那一笔四样都对才带着(收盘那两样成对才带)
OJson storedState(const OJson& v) {
    const OJson* armed = js::propStrict(&v, u"armed"_s);
    const OJson* firedAt = js::prop(&v, u"last_fired_at"_s);
    OJson out = js::object({{u"armed"_s, js::B(js::nullish(armed) ? true : js::truthy(armed))}, {u"last_fired_at"_s, js::nullish(firedAt) ? js::Null() : *firedAt}});
    const OJson* p = js::prop(&v, u"pending"_s);
    if (js::truthy(p)) {
        const OJson* direction = js::prop(p, u"direction"_s);
        const OJson *from = js::prop(p, u"from"_s), *at = js::prop(p, u"at"_s), *minute = js::prop(p, u"minute"_s);
        if (js::isStr(direction) && (direction->s == u"up" || direction->s == u"down") && svc1::finiteNum(from) && svc1::finiteNum(at) && svc1::finiteNum(minute)) {
            OJson pending = js::object({{u"direction"_s, *direction}, {u"from"_s, *from}, {u"at"_s, *at}, {u"minute"_s, *minute}});
            const OJson *close = js::prop(p, u"close"_s), *closeAt = js::prop(p, u"close_at"_s);
            if (svc1::finiteNum(close) && svc1::finiteNum(closeAt)) {
                pending.set(u"close"_s, *close);
                pending.set(u"close_at"_s, *closeAt);
            }
            out.set(u"pending"_s, pending);
        }
    }
    return out;
}

OJson arrayOf(const QList<OJson>& rows) { return js::array(rows); }

}  // namespace

// ---------------------------------------------------------------- 重算价位
Task<OJson> AlertsService::refresh(OJson params, std::optional<double> nowMsOpt) {
    const double nowMs = nowMsOpt.value_or(domain::nowEt().epochMs);

    const std::optional<OJson> watchOpt = store().getWatch(js::strOr(params.get(u"id"_s), QString()));
    if (!watchOpt) throw util::RpcError(-32602, u"没有这个警告"_s);
    const OJson& watch = *watchOpt;
    const QString symbol = js::str(watch.get(u"symbol"_s));
    // String(params["expiry"] ?? watch["expiry"] ?? "").trim() || null
    const OJson* expiryRaw = !js::nullish(params.get(u"expiry"_s)) ? params.get(u"expiry"_s) : watch.get(u"expiry"_s);
    const QString expiryText = util::jsTrim(js::strOr(expiryRaw, QString()));
    const std::optional<QString> expiry = expiryText.isEmpty() ? std::nullopt : std::optional<QString>(expiryText);
    // 顺带改步长(0 = 自动):现价都取不到的那一次什么都不写,步长也不该先改掉
    const double step = !params.get(u"step"_s) ? js::num(watch.get(u"step"_s)) : stepOrRaise(params.get(u"step"_s));

    std::optional<OJson> wall;
    std::optional<QString> wallError;
    double spot = std::numeric_limits<double>::quiet_NaN();
    std::exception_ptr wallFailure;
    try {
        OJson w = co_await market_.wallFor(symbol, expiry);
        const OJson* s = w.get(u"spot"_s);
        spot = js::isNum(s) ? s->n : std::numeric_limits<double>::quiet_NaN();
        wall = std::move(w);
    } catch (...) {
        wallFailure = std::current_exception();
    }
    if (wallFailure) {
        // exc instanceof RpcError ? exc.message : String(exc.message).slice(0, 300)
        wallError = svc1::slice(excMessage(wallFailure), 300);
        wall.reset();
        const std::optional<double> fallback = co_await market_.spotOf(symbol);
        if (!fallback || *fallback == 0 || std::isnan(*fallback)) {
            throw util::RpcError(-32017, u"拿不到 %1 的现价,警告无法设置。%2"_s.arg(symbol, *wallError));
        }
        spot = *fallback;
    }

    // 趋势位(均线/52周高低点):历史 K 线拿不到时按老规矩降级继续,原因带回界面
    std::optional<OJson> history;
    std::optional<QString> historyError;
    std::exception_ptr historyFailure;
    try {
        history = arrayOf(co_await market_.dailyHistory(symbol));
    } catch (...) {
        historyFailure = std::current_exception();
    }
    if (historyFailure) historyError = svc1::slice(excMessage(historyFailure), 300);

    // 今天(美东)那根日线不算完整日线:和碰均线的底账(saveTouchBook)用同一天,两边的收盘和才是同一个数
    const QString today = domain::nowEt().date;
    const std::vector<al::AlertLevel> levels = al::buildLevels(spot, wall ? &*wall : nullptr, step, al::kDefaultMergePct, al::kMaxLevels, history ? &*history : nullptr, today);
    OJson levelDicts = js::array();
    for (const al::AlertLevel& l : levels) levelDicts.items.append(l.dict());
    const OJson* wallExpiry = wall ? wall->get(u"expiry"_s) : nullptr;
    const double stamp = nowMs - std::fmod(nowMs, 1000.0);
    store().updateWatch(js::str(watch.get(u"id"_s)),
                        js::object({{u"step"_s, js::N(step)},
                                    {u"levels"_s, levelDicts},
                                    {u"wall"_s, wall ? *wall : js::Null()},
                                    {u"expiry"_s, js::nullish(wallExpiry) ? js::S(QString()) : *wallExpiry},
                                    {u"last_price"_s, js::N(spot)},
                                    {u"levels_at"_s, js::S(util::utcIso(stamp))}}));
    // 日线已经在手上了,碰均线的底账顺手算掉,不再为它单独拉一次
    if (history) saveTouchBook(js::str(watch.get(u"id"_s)), *history, today);
    const std::optional<OJson> latest = store().getWatch(js::str(watch.get(u"id"_s)));
    co_return js::object({{u"watch"_s, latest ? *latest : js::Null()},
                          {u"wall_error"_s, wallError ? js::S(*wallError) : js::Null()},
                          {u"history_error"_s, historyError ? js::S(*historyError) : js::Null()},
                          {u"trend"_s, history ? al::trendSnapshot(&*history, spot, al::defaultMaPeriods(), al::kExtremeWindow, today) : js::Null()}});
}

// ---------------------------------------------------------------- 价位自动算
bool AlertsService::needsLevels(const OJson& watch, double nowMs, double openMs) {
    if (!js::truthy(watch.get(u"enabled"_s))) return false;
    const auto tried = levelTried_.constFind(js::str(watch.get(u"symbol"_s)));
    if (tried != levelTried_.constEnd() && nowMs - *tried < kLevelsBackoffMs) return false;
    // !(watch["levels"] ?? []).length
    const OJson* levels = watch.get(u"levels"_s);
    if (js::nullish(levels) ? true : !(svc1::lengthOf(levels) != 0)) return true;
    // 旧价位等开盘再重算。休市日 openMs 是无穷大,整天都在这里拦下
    if (nowMs < openMs) return false;
    const double at = util::jsDateParse(js::str(watch.get(u"levels_at"_s)));
    return !std::isfinite(at) || at < openMs;
}

Task<std::optional<QString>> AlertsService::tickLevels(double nowMs, bool inWindow) {
    const auto router = routerPort();
    if (!inWindow || !router || !router->hasSessions()) co_return std::nullopt;
    const domain::EtNow et = domain::etNowFromEpoch(nowMs);
    // 今天美东 09:30 那一刻。周末、假日异动循环不在时段内,走不到这里;万一走到,休市日没有开盘:有价位的一律不重算
    const double openMs = settings().isTradingDay(et.date) ? nowMs - (et.seconds - 9.5 * 3600) * 1000 : std::numeric_limits<double>::infinity();
    std::optional<OJson> picked;
    for (const OJson& w : store().listWatches()) {
        if (needsLevels(w, nowMs, openMs)) {
            picked = w;
            break;
        }
    }
    if (!picked) co_return std::nullopt;
    const QString symbol = js::str(picked->get(u"symbol"_s));
    // 成功失败都先记一次:失败的那只退避 10 分钟再试,不能每 5 秒去打一次期权链
    levelTried_.insert(symbol, nowMs);
    std::exception_ptr failure;
    OJson out;
    try {
        out = co_await refresh(js::object({{u"id"_s, js::copyOrNull(picked->get(u"id"_s))}}), nowMs);
    } catch (...) {
        failure = std::current_exception();
    }
    if (failure) {
        levelNotes_.insert(symbol, util::errText(failure));
    } else {
        // 墙 / 日线取不到时价位照给(只是少了那部分),原因留着给界面显示
        QStringList parts;
        for (const QString& k : {u"wall_error"_s, u"history_error"_s}) {
            const OJson* v = out.get(k);
            if (js::truthy(v)) parts.append(js::str(v));
        }
        const QString note = parts.join(u";"_s);
        if (!note.isEmpty()) levelNotes_.insert(symbol, svc1::slice(note, 200));
        else levelNotes_.remove(symbol);
    }
    co_return symbol;
}

std::optional<QString> AlertsService::levelsStatusOf(const QString& symbol) {
    std::optional<OJson> found;
    for (const OJson& w : store().listWatches()) {
        if (js::str(w.get(u"symbol"_s)) == symbol) {
            found = w;
            break;
        }
    }
    if (!found) return std::nullopt;
    const auto note = levelNotes_.constFind(symbol);
    if (note != levelNotes_.constEnd() && !note->isEmpty()) return u"error:"_s + *note;
    const OJson* levels = found->get(u"levels"_s);
    return (js::nullish(levels) ? false : svc1::lengthOf(levels) != 0) ? u"ok"_s : u"pending"_s;
}

// ---------------------------------------------------------------- 穿越:确认方式
QString AlertsService::crossConfirm() {
    const OJson pref = store().getPref(kCrossConfirmPref);
    return (pref.type == OJson::String && pref.s == u"bar_close") ? u"bar_close"_s : u"immediate"_s;
}

QString AlertsService::prevDay(const QString& date) {
    return mt::prevTradingDay(date, [this](const QString& d) { return settings().isTradingDay(d); });
}

Task<QList<OJson>> AlertsService::listWatches() {
    const QString prev = prevDay(domain::nowEt().date);
    QList<OJson> out;
    for (const OJson& w : store().listWatches()) {
        const OJson* spot = w.get(u"last_price"_s);
        const OJson* levelsV = w.get(u"levels"_s);
        // !spot || !w["levels"].some((l) => l["ma"])
        bool anyMa = false;
        if (js::truthy(spot)) {
            if (!js::isArr(levelsV)) throw util::JsError(u"Cannot read properties of undefined (reading 'some')"_s);
            for (const OJson& l : levelsV->items) {
                if (js::truthy(js::propStrict(&l, u"ma"_s))) {
                    anyMa = true;
                    break;
                }
            }
        }
        if (!js::truthy(spot) || !anyMa) {
            out.append(w);
            continue;
        }
        const QList<OJson> levels = withBookSumsRaw(levelsV->items, w.get(u"touch"_s), prev);
        OJson mapped = js::array();
        for (const OJson& l : levels) {
            if (js::truthy(js::prop(&l, u"ma"_s))) {
                OJson copy = l;
                copy.set(u"price"_s, js::N(util::pyRound(al::levelPriceAt(al::AlertLevel::fromJson(l), js::num(spot)), 4)));
                mapped.items.append(copy);
            } else {
                mapped.items.append(l);
            }
        }
        OJson row = w;
        row.set(u"levels"_s, mapped);
        out.append(row);
    }
    co_return out;
}

// ---------------------------------------------------------------- 短期内反复碰均线
mt::Config AlertsService::touchConfig() {
    const OJson raw = store().getPref(kTouchConfigPref);
    if (raw.type == OJson::Null) return mt::defaultConfig();
    try {
        return mt::normalizeTouchConfig(&raw, mt::defaultConfig());
    } catch (...) {
        return mt::defaultConfig();
    }
}

void AlertsService::touchConfigChanged() { touchTried_.clear(); }

void AlertsService::saveTouchBook(const QString& watchId, const OJson& history, const QString& today) {
    const std::optional<OJson> latest = store().getWatch(watchId);
    if (!latest) return;  // 算的途中被删了
    const OJson* touch = latest->get(u"touch"_s);
    const OJson* firedPrev = js::truthy(touch) ? js::prop(touch, u"fired"_s) : nullptr;
    const OJson fallback = js::object();
    const std::optional<mt::TouchBook> book = mt::buildTouchBook(&history, today, touchConfig(), js::nullish(firedPrev) ? &fallback : firedPrev);
    store().updateWatch(watchId, js::object({{u"touch"_s, book ? book->toJson() : js::Null()}}));
}

Task<std::optional<QString>> AlertsService::tickTouch(double nowMs, bool inWindow) {
    const auto router = routerPort();
    if (!inWindow || !router || !router->hasSessions()) co_return std::nullopt;
    const mt::Config config = touchConfig();
    if (!config.enabled) co_return std::nullopt;
    const domain::EtNow et = domain::etNowFromEpoch(nowMs);
    if (!settings().isTradingDay(et.date)) co_return std::nullopt;  // 周末不算:下个交易日盘前再算
    const QString prev = prevDay(et.date);
    std::optional<OJson> picked;
    for (const OJson& w : store().listWatches()) {
        if (!js::truthy(w.get(u"enabled"_s))) continue;
        const OJson* touch = w.get(u"touch"_s);
        if (js::truthy(touch)) {
            const mt::TouchBook book = mt::TouchBook::fromJson(*touch);
            if (mt::bookUsable(&book, config, prev)) continue;
        }
        const auto tried = touchTried_.constFind(js::str(w.get(u"symbol"_s)));
        if (tried == touchTried_.constEnd() || nowMs - *tried >= kTouchBackoffMs) {
            picked = w;
            break;
        }
    }
    if (!picked) co_return std::nullopt;
    const QString symbol = js::str(picked->get(u"symbol"_s));
    touchTried_.insert(symbol, nowMs);
    try {
        const OJson history = arrayOf(co_await market_.dailyHistory(symbol));
        saveTouchBook(js::str(picked->get(u"id"_s)), history, et.date);
    } catch (...) {
        // 日线拿不到:这只今天不判碰均线,半小时后再试。价位那边的降级原因照旧由 refresh 报
    }
    co_return symbol;
}

std::optional<AlertsService::TouchSession> AlertsService::touchSession() {
    const mt::Config config = touchConfig();
    if (!config.enabled) return std::nullopt;
    const domain::EtNow et = domain::nowEt();
    if (!settings().isTradingDay(et.date)) return std::nullopt;
    const double close = settings().early_close_days.contains(et.date) ? 13 * 3600 : 16 * 3600;
    if (et.seconds < 9.5 * 3600 || et.seconds >= close) return std::nullopt;
    return TouchSession{config, et.date, prevDay(et.date)};
}

AlertsService::TouchResult AlertsService::touchEvents(const OJson& watch, double price, const QList<OJson>& crossings, const TouchSession& session, double at,
                                                      const OJson* bookRaw) {
    const QString symbol = js::str(watch.get(u"symbol"_s));
    const auto prev = sessionPrices_.constFind(symbol);
    std::optional<double> prevPrice;
    if (prev != sessionPrices_.constEnd() && prev->date == session.today) prevPrice = prev->price;
    sessionPrices_.insert(symbol, SessionPrice{session.today, price});
    std::optional<mt::TouchBook> book;
    if (js::truthy(bookRaw)) book = mt::TouchBook::fromJson(*bookRaw);
    if (!mt::bookUsable(book ? &*book : nullptr, session.config, session.prevDay)) return {crossings, std::nullopt};
    const mt::Evaluation ev = mt::evaluateTouches(*book, session.config, price, prevPrice, session.today);
    if (ev.hits.empty()) return {crossings, std::nullopt};
    QSet<QString> merged;
    for (const mt::TouchHit& h : ev.hits) merged.insert(u"ma"_s + util::jsNumberToString(h.period));
    QList<OJson> touches;
    for (const mt::TouchHit& h : ev.hits) {
        touches.append(js::object({{u"symbol"_s, js::S(symbol)},
                                   {u"trigger"_s, js::S(u"touch"_s)},
                                   {u"price"_s, js::N(h.ma)},
                                   {u"label"_s, js::S(h.label)},
                                   {u"source"_s, js::S(u"ma"_s + util::jsNumberToString(h.period))},
                                   {u"kind"_s, js::S(h.side == u"above" ? u"support"_s : u"resistance"_s)},
                                   {u"direction"_s, js::S(h.direction)},
                                   {u"from"_s, js::N(util::pyRound(prevPrice.value_or(price), 4))},
                                   {u"to"_s, js::N(util::pyRound(price, 4))},
                                   {u"at"_s, js::N(at)},
                                   {u"text"_s, js::S(h.text)}}));
    }
    QList<OJson> events;
    for (const OJson& c : crossings) {
        const OJson* source = c.get(u"source"_s);
        if (!(js::isStr(source) && merged.contains(source->s))) events.append(c);
    }
    events.append(touches);
    OJson merged2 = *bookRaw;  // {...book, fired}
    merged2.set(u"fired"_s, ev.fired);
    return {events, merged2};
}

// ---------------------------------------------------------------- 盯穿越
Task<OJson> AlertsService::poll() {
    QList<OJson> fired;
    OJson checked = js::array();
    QList<OJson> watching;
    for (const OJson& w : store().listWatches()) {
        if (js::truthy(w.get(u"enabled"_s)) && svc1::lengthOf(w.get(u"levels"_s)) != 0) watching.append(w);
    }
    // 一轮的价一次取齐(quotesOf):逐只取每只要等一拍,23 只就是 3.5 秒占着交易道
    QStringList symbols;
    for (const OJson& w : watching) symbols.append(js::str(w.get(u"symbol"_s)));
    const std::map<QString, std::optional<SpotQuote>> quotes = co_await market_.quotesOf(symbols);
    const std::optional<TouchSession> session = touchSession();
    // 这一轮的时刻:事件的 at、冷却、"那一分钟收完没有"、上一笔接不接得上,用的是同一个钟
    const domain::EtNow now = domain::nowEt();
    const double nowTs = now.epochMs / 1000;
    const QString confirm = crossConfirm();
    const QString prev = prevDay(now.date);
    for (const OJson& listed : watching) {
        const QString symbol = js::str(listed.get(u"symbol"_s));
        const auto qi = quotes.find(symbol);
        const SpotQuote* quote = (qi != quotes.end() && qi->second) ? &*qi->second : nullptr;
        if (!quote) {
            checked.items.append(js::object({{u"symbol"_s, js::S(symbol)}, {u"price"_s, js::Null()}}));
            continue;
        }
        const double price = quote->price;
        // 盯单现读一次:前面等行情那一下,价位可能刚被重算、底账可能刚换成今天的,盯单也可能被删了。从这里到写回之间没有 await
        const std::optional<OJson> watchOpt = store().getWatch(js::str(listed.get(u"id"_s)));
        if (!watchOpt || svc1::lengthOf(watchOpt->get(u"levels"_s)) == 0) continue;
        const OJson& watch = *watchOpt;

        const OJson* book = watch.get(u"touch"_s);
        std::vector<al::AlertLevel> levels;
        for (const OJson& l : watch.get(u"levels"_s)->items) levels.push_back(storedLevel(l));
        levels = withBookSums(std::move(levels), book, prev);
        OJson states = js::object();
        if (const OJson* st = watch.get(u"states"_s); !js::nullish(st)) {
            for (const auto& [k, v] : st->fields) states.set(k, storedState(v));
        }
        // 这个价属于哪一段:券商给了最后成交的时刻就按那一刻认,没给按此刻认;指数再加价的出处
        const domain::EtNow when = quote->tradedAt ? domain::etNowFromEpoch(*quote->tradedAt * 1000) : now;
        const QString label = u"%1|%2%3"_s.arg(when.date, settings().marketStatus(when), quote->source.isEmpty() ? QString() : u"|"_s + quote->source);
        // 上一笔接得上、而且是这一段里的真价才比穿越;否则这一笔只登记(alerts.linkSample)
        std::optional<al::PriceSample> lastSample;
        if (const auto ls = lastSamples_.constFind(symbol); ls != lastSamples_.constEnd()) lastSample = *ls;
        al::PriceSample incoming;
        incoming.at = nowTs;
        incoming.price = price;
        incoming.session = label;
        incoming.tradedAt = quote->tradedAt;
        const al::Linked linked = al::linkSample(lastSample, incoming);
        lastSamples_.insert(symbol, linked.sample);
        auto [crossings, nextStates] = al::evaluate(levels, states, linked.prevPrice, price, nowTs, al::kDefaultBandPct, al::kDefaultCooldown, confirm);
        const OJson* historyV = watch.get(u"events"_s);
        QList<OJson> history = js::nullish(historyV) ? QList<OJson>() : historyV->items;
        QList<OJson> events;
        for (const OJson& c : crossings) {
            OJson e = c;
            e.set(u"symbol"_s, js::S(symbol));
            e.set(u"trigger"_s, js::S(u"cross"_s));
            events.append(e);
        }
        std::optional<OJson> touchBook;
        // 碰均线同样只拿坐实了的价判:开盘那一笔还没进来时手上是盘前的价,它贴着均线不等于今天碰到了
        if (session && linked.sample.settled) {
            TouchResult tr = touchEvents(watch, price, events, *session, nowTs, book);
            events = std::move(tr.events);
            touchBook = std::move(tr.book);
        }
        // 碰均线在容差以内就报了,价格往往几轮之后才真穿过那条线:把那条线的穿越落防(等确认的那一笔一起作废)
        QSet<QString> touched;
        for (const OJson& e : events) {
            const OJson* trig = e.get(u"trigger"_s);
            if (js::isStr(trig) && trig->s == u"touch") touched.insert(js::str(e.get(u"source"_s)));
        }
        for (const al::AlertLevel& level : levels) {
            if (touched.contains(level.source)) nextStates.set(al::levelKey(level), js::object({{u"armed"_s, js::B(false)}, {u"last_fired_at"_s, js::N(nowTs)}}));
        }
        for (const OJson& event : events) {
            // 只进通知流(订单看板下面那条),不走系统通知:穿越的"弹"由桌面端的置顶弹窗负责
            const OJson* trig = event.get(u"trigger"_s);
            const bool isTouch = js::isStr(trig) && trig->s == u"touch";
            const QString title = isTouch ? u"%1 反复碰 %2"_s.arg(symbol, js::str(event.get(u"label"_s)))
                                          : u"%1 %2"_s.arg(symbol, (js::isStr(event.get(u"direction"_s)) && event.get(u"direction"_s)->s == u"up") ? u"上穿"_s : u"下破"_s);
            eng().notify(title, js::str(event.get(u"text"_s)), QString(), false);
        }
        // 现价走出了上下两个整数关口之间:这一对跟着换(刚穿过的那个留着,状态按键原样带着)
        std::vector<al::AlertLevel> rawLevels;
        for (const OJson& l : watch.get(u"levels"_s)->items) rawLevels.push_back(al::AlertLevel::fromJson(l));
        const auto rerounded = al::reroundLevels(rawLevels, price, js::num(watch.get(u"step"_s)));
        if (rerounded) {
            QSet<QString> keep;
            for (const al::AlertLevel& l : *rerounded) keep.insert(al::levelKey(l));
            for (const QString& key : js::keys(&nextStates)) {
                if (!keep.contains(key)) nextStates.remove(key);
            }
        }
        // [...history, ...events].slice(-50)
        QList<OJson> all = history;
        all.append(events);
        if (all.size() > 50) all = all.mid(all.size() - 50);
        OJson fields = js::object({{u"last_price"_s, js::N(price)}, {u"states"_s, nextStates}, {u"events"_s, js::array(all)}});
        if (rerounded) {
            OJson lv = js::array();
            for (const al::AlertLevel& l : *rerounded) lv.items.append(l.dict());
            fields.set(u"levels"_s, lv);
        }
        if (touchBook) fields.set(u"touch"_s, *touchBook);
        store().updateWatch(js::str(watch.get(u"id"_s)), fields);
        fired.append(events);
        checked.items.append(js::object({{u"symbol"_s, js::S(symbol)}, {u"price"_s, js::N(price)}}));
    }

    if (!fired.isEmpty()) {
        // 每条发出去的都记一笔,之后按 1 / 5 / 20 天的走势打分(信号成绩单,signalOutcomes.ts)
        QList<OJson> signalRows;
        for (const OJson& e : fired) signalRows.append(analysis::signal_outcomes::signalFromWatchEvent(e));
        store().signalLog().log(signalRows);
        emitEvent(u"alerts"_s, js::object({{u"events"_s, js::array(fired)}}));
    }
    co_return js::object({{u"fired"_s, js::array(fired)}, {u"checked"_s, checked}});
}

// ---------------------------------------------------------------- 持仓追踪的联动
void AlertsService::forget(const QString& symbol) {
    levelTried_.remove(symbol);
    levelNotes_.remove(symbol);
    touchTried_.remove(symbol);
    sessionPrices_.remove(symbol);
    lastSamples_.remove(symbol);
}

std::optional<QString> AlertsService::adoptForTrack(const QString& symbol) {
    const QString sym = util::jsTrim(symbol).toUpper();
    if (sym.isEmpty()) return std::nullopt;
    const QList<OJson> watches = store().listWatches();
    for (const OJson& w : watches) {
        if (js::str(w.get(u"symbol"_s)) == sym) return std::nullopt;
    }
    if (watches.size() >= kMaxWatch) {
        return u"价位已达 %1 只上限,没有为 %2 算关键价位:在「板块」页关掉几只不看的,再点追踪卡片上的「算关键价位」。"_s.arg(kMaxWatch).arg(sym);
    }
    try {
        store().addWatch(sym, 0, kOriginTracker);
    } catch (...) {
        return u"没有为 %1 算关键价位:%2"_s.arg(sym, util::errText(std::current_exception()));
    }
    levelTried_.remove(sym);  // 刚被删过又建回来的:别让退避把它拦上 10 分钟
    const OJson detail = js::object({{u"symbol"_s, js::S(sym)}, {u"by"_s, js::S(kOriginTracker)}});
    store().audit(u"engine"_s, u"alert_watch_adopt"_s, &detail);
    return std::nullopt;
}

QStringList AlertsService::adoptTracked(const QStringList& symbols) {
    if (trackedAdopted_) return {};
    trackedAdopted_ = true;
    QStringList notes;
    QSet<QString> seen;
    for (const QString& raw : symbols) {
        const QString sym = util::jsTrim(raw).toUpper();
        if (sym.isEmpty() || seen.contains(sym)) continue;
        seen.insert(sym);
        if (const auto note = adoptForTrack(sym)) notes.append(*note);
    }
    return notes;
}

QStringList AlertsService::releaseForTrack(const QSet<QString>& tracked) {
    const QStringList poolList = store().symbolsInSectors();
    const QSet<QString> inPool(poolList.begin(), poolList.end());
    QStringList dropped;
    for (const OJson& watch : store().listWatches()) {
        if (js::strOr(watch.get(u"origin"_s), QString()) != kOriginTracker) continue;
        const QString sym = js::str(watch.get(u"symbol"_s));
        if (tracked.contains(sym)) continue;
        if (inPool.contains(sym)) {
            store().updateWatch(js::str(watch.get(u"id"_s)), js::object({{u"origin"_s, js::S(QString())}}));
            continue;
        }
        store().deleteWatch(js::str(watch.get(u"id"_s)));
        forget(sym);
        dropped.append(sym);
    }
    if (!dropped.isEmpty()) {
        const OJson detail = js::object({{u"symbols"_s, js::strings(dropped)}});
        store().audit(u"engine"_s, u"alert_watch_release"_s, &detail);
    }
    return dropped;
}

}  // namespace ibkr::orchestrate
