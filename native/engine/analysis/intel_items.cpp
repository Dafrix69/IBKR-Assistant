#include "analysis/intel_items.h"

#include "util/collate.h"
#include "util/intel_dateparse.h"
#include "util/jsformat.h"
#include "util/jsmath.h"
#include "util/jsobj.h"

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;
namespace jm = ibkr::util::jsmath;

namespace ibkr::analysis::intel_items {

namespace {
const OJson& table(std::initializer_list<std::pair<const char*, const char16_t*>> kv, OJson& holder) {
    holder = js::object();
    for (const auto& [k, v] : kv) holder.set(QString::fromLatin1(k), js::S(QString::fromUtf16(v)));
    return holder;
}
const OJson& signalTable() {
    static OJson h;
    static const OJson& t = table({{"cross", u"价位穿越"}, {"touch", u"反复碰均线"}, {"spike", u"急涨急跌"}, {"day_move", u"大涨大跌"}, {"rvol", u"全天放量"},
                                   {"burst", u"窗口放量"}, {"leaders", u"强势股新入选"}, {"pa", u"K线 PA"}},
                                  h);
    return t;
}
const OJson& statusTable() {
    static OJson h;
    static const OJson& t = table({{"filled", u"已成交"}, {"partially_filled", u"部分成交"}, {"cancelled", u"已撤单"}, {"expired_untriggered", u"未触发过期"},
                                   {"rejected_by_validator", u"校验拒绝"}, {"rejected_by_llm", u"模型拒绝"}, {"ibkr_error", u"券商报错"}, {"halted_by_breaker", u"熔断拦下"}},
                                  h);
    return t;
}
const OJson& outcomeTable() {
    static OJson h;
    static const OJson& t = table({{"sent", u"已跟单"}, {"held", u"没有发出"}, {"observed", u"只观察"}, {"stale", u"太旧,没跟"}, {"unparsed", u"没接住,没跟"},
                                   {"capped", u"超上限,没跟"}, {"blocked", u"闸门关着,没跟"}, {"rejected", u"被拒"}},
                                  h);
    return t;
}
/// 查表:键是 JS 的属性键(String(k));表里没有是 undefined
const OJson* lookup(const OJson& t, const OJson* key) { return t.get(js::str(key)); }

/// Date.parse(String(iso ?? "")),读不出是 0
double epoch(const OJson* iso, const QTimeZone& local) {
    const double t = util::v8DateParse(js::strOr(iso, QString()), local);
    return std::isfinite(t) ? t : 0;
}
bool isStr(const OJson* v, const char16_t* s) { return v && v->type == OJson::String && v->s == QStringView(s); }
const OJson* P(const OJson& o, const char* k) { return js::prop(&o, QString::fromLatin1(k)); }
QString S(const OJson& o, const char* k) { return js::str(P(o, k)); }
/// symbols.filter((s) => held.has(s))
OJson heldOf(const QList<OJson>& symbols, const QSet<QString>& held) {
    OJson out = js::array();
    for (const OJson& s : symbols)
        if (s.type == OJson::String && held.contains(s.s)) out.items << s;
    return out;
}
/// [...arr]
QList<OJson> spread(const OJson* v) { return js::isArr(v) ? v->items : QList<OJson>(); }
void setIfDefined(OJson& o, const QString& k, const OJson* v) {
    if (v) o.set(k, *v);
}
}  // namespace

std::optional<QString> outcomeLabel(const QString& outcome) {
    const OJson* v = outcomeTable().get(outcome);
    return v ? std::optional(v->s) : std::nullopt;
}

std::optional<QString> signalLabel(const QString& source) {
    const OJson* v = signalTable().get(source);
    return v ? std::optional(v->s) : std::nullopt;
}

OJson messageItem(const OJson& row, const OJson* verdict, const QSet<QString>& held, const OJson& now, const std::optional<QString>& instruction,
                  const QTimeZone& local) {
    const QList<OJson> symbols = spread(P(row, "symbols"));
    const OJson* prices = P(row, "prices");
    std::optional<OJson> move;
    if (!symbols.isEmpty()) {
        const OJson& first = symbols[0];
        const OJson* price = js::propStrict(prices, js::str(&first));
        if (js::isNum(price) && price->n > 0) {
            const double then = price->n;
            const OJson* got = js::prop(&now, js::str(&first));
            // cur 原样带进去;比较与算术按 JS 转数
            const bool has = !js::nullish(got);
            const double cur = has ? js::num(got) : 0;
            OJson pct = has && cur > 0 ? js::N(util::jsRound(((cur - then) / then) * 10000) / 100) : OJson::null();
            move = js::object({{u"symbol"_s, first}, {u"then"_s, js::N(then)}, {u"now"_s, has ? *got : OJson::null()}, {u"pct"_s, pct}});
        }
    }
    const bool hasVerdict = js::truthy(verdict);
    const OJson* outcome = hasVerdict ? js::prop(verdict, u"outcome"_s) : nullptr;
    QString tone = u"info"_s;
    if (hasVerdict) {
        if (isStr(outcome, u"sent")) tone = u"up"_s;
        else if (isStr(outcome, u"rejected") || isStr(outcome, u"blocked") || isStr(outcome, u"capped") || isStr(outcome, u"unparsed")) tone = u"warn"_s;
    }
    OJson item = js::object({
        {u"id"_s, js::S(u"message:"_s + S(row, "message_id"))},
        {u"kind"_s, js::S(u"message"_s)},
        {u"at"_s, js::N(epoch(P(row, "at"), local))},
        {u"symbols"_s, js::array(symbols)},
        {u"guesses"_s, js::array(spread(P(row, "guesses")))},
        {u"held"_s, heldOf(symbols, held)},
    });
    setIfDefined(item, u"title"_s, P(row, "text"));
    item.set(u"body"_s, js::S(hasVerdict ? js::str(lookup(outcomeTable(), outcome)) + u':' + js::str(js::prop(verdict, u"detail"_s)) : QString()));
    item.set(u"tone"_s, js::S(tone));
    setIfDefined(item, u"source"_s, js::truthy(P(row, "author_name")) ? P(row, "author_name") : P(row, "author_id"));  // a || b
    setIfDefined(item, u"trusted"_s, P(row, "trusted"));
    setIfDefined(item, u"ref"_s, P(row, "message_id"));
    if (move) item.set(u"move"_s, *move);
    if (hasVerdict) setIfDefined(item, u"outcome"_s, outcome);
    if (instruction && !instruction->isEmpty()) item.set(u"instruction"_s, js::S(*instruction));
    return item;
}

OJson signalItem(const OJson& entry, const QSet<QString>& held, const QTimeZone& local) {
    const OJson* source = P(entry, "source");
    const OJson* label = lookup(signalTable(), source);
    const OJson* expect = P(entry, "expect");
    const QString dir = isStr(expect, u"up") ? u"押涨"_s : isStr(expect, u"down") ? u"押跌"_s : u"不带方向"_s;
    const OJson* seq = P(entry, "seq");
    const OJson* symbol = P(entry, "symbol");
    const QString idPart = js::nullish(seq) ? S(entry, "at") + u':' + js::str(source) + u':' + js::str(symbol) : js::str(seq);
    const OJson* elabel = P(entry, "label");
    const OJson* variant = P(entry, "variant");
    const OJson* price = P(entry, "price");
    QString body = js::str(label);
    if (js::truthy(variant)) body += u' ' + js::str(variant);
    body += u" · "_s + dir;
    if (!(price && price->type == OJson::Null)) body += u" · 当时 "_s + js::str(price);
    const QList<OJson> symbols{js::copyOrNull(symbol)};
    OJson item = js::object({
        {u"id"_s, js::S(u"signal:"_s + idPart)},
        {u"kind"_s, js::S(u"signal"_s)},
        {u"at"_s, js::N(epoch(P(entry, "at"), local))},
        {u"symbols"_s, js::array({symbol ? *symbol : OJson::null()})},
        {u"guesses"_s, js::array()},
        {u"held"_s, heldOf(symbol ? symbols : QList<OJson>(), held)},
        {u"title"_s, js::S(js::str(symbol) + u' ' + js::str(js::truthy(elabel) ? elabel : label))},
        {u"body"_s, js::S(body)},
        {u"tone"_s, js::S(isStr(expect, u"up") ? u"up"_s : isStr(expect, u"down") ? u"down"_s : u"info"_s)},
    });
    setIfDefined(item, u"source"_s, source);
    item.set(u"ref"_s, js::S(js::nullish(seq) ? S(entry, "at") : js::str(seq)));
    return item;
}

OJson eventItem(const OJson& event, const QStringList& symbols, const QSet<QString>& held, double nowMs) {
    const OJson* items = P(event, "items");
    const OJson* fact = nullptr;
    if (js::isArr(items))
        for (const OJson& i : items->items)
            if (js::truthy(js::prop(&i, u"forecast"_s)) || js::truthy(js::prop(&i, u"previous"_s))) {
                fact = &i;
                break;
            }
    QStringList parts{u"美东 "_s + S(event, "date_et") + u' ' + S(event, "time_et")};
    const auto orDash = [](const OJson* v) { return js::truthy(v) ? js::str(v) : u"—"_s; };
    if (fact) parts << u"预期 "_s + orDash(js::prop(fact, u"forecast"_s)) + u" · 前值 "_s + orDash(js::prop(fact, u"previous"_s));
    if (js::truthy(P(event, "note"))) parts << S(event, "note");
    const double at = js::num(P(event, "at"));
    const bool upcoming = at > nowMs;
    QList<OJson> sym;
    for (const QString& s : symbols) sym << js::S(s);
    OJson item = js::object({
        {u"id"_s, js::S(u"event:"_s + S(event, "id"))},
        {u"kind"_s, js::S(u"event"_s)},
    });
    setIfDefined(item, u"at"_s, P(event, "at"));
    item.set(u"symbols"_s, js::array(sym));
    item.set(u"guesses"_s, js::array());
    item.set(u"held"_s, heldOf(sym, held));
    item.set(u"title"_s, js::S((upcoming ? u"将公布"_s : u"已公布"_s) + u':' + S(event, "title")));
    item.set(u"body"_s, js::S(parts.join(u" · "_s)));
    item.set(u"tone"_s, js::S(upcoming && isStr(P(event, "impact"), u"high") && at - nowMs < 24 * 3600'000 ? u"warn"_s : u"info"_s));
    setIfDefined(item, u"source"_s, P(event, "kind"));
    setIfDefined(item, u"ref"_s, P(event, "id"));
    return item;
}

OJson recordItem(const OJson& r, const QSet<QString>& held, const QTimeZone& local) {
    const OJson* fin = P(r, "final_status");
    const OJson* last = P(r, "last_status");
    QString status;
    if (js::truthy(fin)) {
        const OJson* l = lookup(statusTable(), fin);
        status = js::nullish(l) ? js::str(fin) : l->s;
    } else {
        status = js::truthy(last) ? u"在途:"_s + js::str(last) : u"仅校验"_s;
    }
    const OJson* avg = P(r, "avg_fill_price");
    const QString fill = js::num(P(r, "fills")) > 0 && !(avg && avg->type == OJson::Null) ? u" · 均价 "_s + js::str(avg) : QString();
    const QString via = isStr(P(r, "channel"), u"discord") ? u" · 跟单"_s : QString();
    const bool bad = !(fin && fin->type == OJson::Null) && !isStr(fin, u"filled") && !isStr(fin, u"partially_filled");
    const OJson* symbol = P(r, "symbol");
    const QList<OJson> symbols{js::copyOrNull(symbol)};
    OJson title;
    if (js::truthy(P(r, "intent_summary"))) title = *P(r, "intent_summary");
    else if (js::truthy(P(r, "raw_instruction"))) title = *P(r, "raw_instruction");
    else title = js::S(S(r, "action") + u' ' + js::str(symbol));
    OJson item = js::object({
        {u"id"_s, js::S(u"order:"_s + S(r, "id"))},
        {u"kind"_s, js::S(u"order"_s)},
        {u"at"_s, js::N(epoch(P(r, "created_at"), local))},
        {u"symbols"_s, js::array({symbol ? *symbol : OJson::null()})},
        {u"guesses"_s, js::array()},
        {u"held"_s, heldOf(symbol ? symbols : QList<OJson>(), held)},
        {u"title"_s, title},
        {u"body"_s, js::S(status + fill + via)},
        {u"tone"_s, js::S(bad ? u"warn"_s : isStr(P(r, "action"), u"SELL") ? u"down"_s : u"up"_s)},
    });
    setIfDefined(item, u"source"_s, P(r, "account"));
    setIfDefined(item, u"ref"_s, P(r, "id"));
    return item;
}

OJson ideaItem(const OJson& idea, const QStringList& symbols, const QSet<QString>& held, const QTimeZone& local) {
    const OJson* st = P(idea, "status");
    const QString status = isStr(st, u"done") ? u"已完成"_s : isStr(st, u"archived") ? u"已归档"_s : u"进行中"_s;
    QStringList all;
    for (const OJson& s : spread(P(idea, "symbols"))) {
        const QString u = s.s.toUpper();
        if (!all.contains(u)) all << u;
    }
    for (const QString& s : symbols)
        if (!all.contains(s)) all << s;
    QList<OJson> allJ;
    for (const QString& s : all) allJ << js::S(s);
    OJson item = js::object({
        {u"id"_s, js::S(u"idea:"_s + S(idea, "id"))},
        {u"kind"_s, js::S(u"idea"_s)},
        {u"at"_s, js::N(epoch(P(idea, "created_at"), local))},
        {u"symbols"_s, js::array(allJ)},
        {u"guesses"_s, js::array()},
        {u"held"_s, heldOf(allJ, held)},
        {u"title"_s, js::S(S(idea, "text").left(160))},
        {u"body"_s, js::S(status)},
        {u"tone"_s, js::S(u"info"_s)},
    });
    setIfDefined(item, u"source"_s, st);
    setIfDefined(item, u"ref"_s, P(idea, "id"));
    return item;
}

QList<OJson> mergeItems(const QList<QList<OJson>>& groups, const FeedFilter& filter) {
    const std::optional<QString> symbol = filter.symbol && !filter.symbol->isEmpty() ? std::optional(filter.symbol->toUpper()) : std::nullopt;
    const bool byKind = filter.kinds && !filter.kinds->isEmpty();
    QSet<QString> seen;
    QList<OJson> out;
    for (const QList<OJson>& group : groups) {
        for (const OJson& item : group) {
            const QString id = js::str(item.get(u"id"_s));
            if (seen.contains(id)) continue;
            if (byKind && !filter.kinds->contains(js::str(item.get(u"kind"_s)))) continue;
            if (symbol) {
                bool has = false;
                for (const OJson& s : spread(item.get(u"symbols"_s)))
                    if (s.type == OJson::String && s.s == *symbol) has = true;
                if (!has) continue;
            }
            if (filter.heldOnly && spread(item.get(u"held"_s)).isEmpty()) continue;
            if (filter.since && js::num(item.get(u"at"_s)) < *filter.since) continue;
            seen.insert(id);
            out << item;
        }
    }
    std::stable_sort(out.begin(), out.end(), [](const OJson& a, const OJson& b) {
        const double d = js::num(b.get(u"at"_s)) - js::num(a.get(u"at"_s));
        if (d != 0 && !std::isnan(d)) return d < 0;
        return util::localeCompare(js::str(a.get(u"id"_s)), js::str(b.get(u"id"_s))) < 0;
    });
    // slice(0, Math.max(1, limit)):NaN 当 0,小数向零取
    const double lim = jm::max(1, filter.limit);
    const double n = std::isnan(lim) ? 0 : std::trunc(lim);
    if (n < out.size()) out = out.mid(0, qsizetype(n));
    return out;
}

}  // namespace ibkr::analysis::intel_items
