#include "shell/intel_page_rules.h"

#include "shell/intel_rules.h"
#include "shell/jsvalue.h"
#include "shell/track_rules.h"

#include <QDateTime>
#include <QRegularExpression>

#include <algorithm>
#include <cmath>

namespace ibkr::shell::intel {

using namespace Qt::StringLiterals;

namespace {

QString S(const QJsonValue& v) { return jsString(v); }
double N(const QJsonValue& v) { return jsNumber(v); }
bool T(const QJsonValue& v) { return jsTruthy(v); }
bool has(const QJsonValue& v) { return !v.isUndefined() && !v.isNull(); }
QJsonArray arr(const QJsonValue& v) { return v.toArray(); }
QStringList strs(const QJsonValue& v) {
    QStringList out;
    for (const QJsonValue& x : v.toArray()) out << S(x);
    return out;
}

/// toLocaleString('zh-CN', { hour12: false }):2026/10/16 03:30:00(年月日不补零,时分秒补零)
QString zhDateTime(double ms, const QTimeZone& tz) {
    const QDateTime t = QDateTime::fromMSecsSinceEpoch(qint64(ms), tz);
    return u"%1/%2/%3 %4"_s.arg(t.date().year()).arg(t.date().month()).arg(t.date().day()).arg(t.time().toString(u"HH:mm:ss"_s));
}

/// 数字的 en-US 写法,最多两位小数(toLocaleString('en-US', { maximumFractionDigits: 2 }))
QString enUs2(double v) {
    QString s = jsToFixed(v, 2);
    if (s.contains(u'.')) {
        while (s.endsWith(u'0')) s.chop(1);
        if (s.endsWith(u'.')) s.chop(1);
    }
    const bool neg = s.startsWith(u'-');
    if (neg) s.remove(0, 1);
    const qsizetype dot = s.indexOf(u'.');
    QString whole = dot < 0 ? s : s.left(dot);
    const QString frac = dot < 0 ? QString() : s.mid(dot);
    for (qsizetype i = whole.size() - 3; i > 0; i -= 3) whole.insert(i, u',');
    return (neg ? u"-"_s : QString()) + whole + frac;
}

const QHash<QString, QString>& outcomeLabel() {
    static const QHash<QString, QString> m{{u"sent"_s, u"已跟单"_s},     {u"held"_s, u"没有发出"_s},     {u"observed"_s, u"只观察"_s},
                                           {u"stale"_s, u"太旧"_s},       {u"unparsed"_s, u"没接住"_s},   {u"capped"_s, u"超上限"_s},
                                           {u"blocked"_s, u"闸门关着"_s}, {u"rejected"_s, u"被拒"_s}};
    return m;
}
/// followForm 的 outcomeTone → Pill 的颜色
QString outcomeTint(const QString& o) { return o == u"sent" ? u"green"_s : o == u"observed" ? u"gray"_s : o == u"rejected" ? u"red"_s : u"orange"_s; }

QJsonObject rowModel(const QJsonValue& item, double now, const QString& current, const QTimeZone& tz) {
    const QString kind = S(item[u"kind"_s]);
    const QStringList held = strs(item[u"held"_s]);
    QJsonArray syms;
    for (const QString& s : strs(item[u"symbols"_s]))
        syms.append(QJsonObject{{u"text"_s, s}, {u"symbol"_s, s}, {u"held"_s, held.contains(s)}, {u"current"_s, s == current}, {u"guess"_s, false},
                                {u"tip"_s, held.contains(s) ? u"%1:持仓中,点开档案"_s.arg(s) : u"点开 %1 的档案"_s.arg(s)}});
    for (const QString& s : strs(item[u"guesses"_s]))
        syms.append(QJsonObject{{u"text"_s, s + u"?"_s}, {u"symbol"_s, s}, {u"held"_s, false}, {u"current"_s, false}, {u"guess"_s, true},
                                {u"tip"_s, u"像代码,但不在持仓、股票池、板块、提醒里:只作参考,点了照样能查"_s}});
    QJsonObject row{{u"key"_s, S(item[u"id"_s])},
                    {u"kind"_s, kind},
                    {u"kindLabel"_s, kindLabel().value(kind)},
                    {u"icon"_s, kindIcon().value(kind)},
                    {u"tint"_s, kindTint().value(kind)},
                    {u"tone"_s, S(item[u"tone"_s])},
                    {u"held"_s, !held.isEmpty()},
                    {u"source"_s, sourceLabel(kind, S(item[u"source"_s]))},
                    {u"trusted"_s, T(item[u"trusted"_s])},
                    {u"syms"_s, syms},
                    {u"time"_s, relTime(N(item[u"at"_s]), now, tz)},
                    {u"timeTip"_s, zhDateTime(N(item[u"at"_s]), tz)},
                    {u"title"_s, S(item[u"title"_s])}};
    const QString body = has(item[u"body"_s]) ? S(item[u"body"_s]) : QString();
    const QJsonValue move = item[u"move"_s];
    const QString outcome = has(item[u"outcome"_s]) ? S(item[u"outcome"_s]) : QString();
    const QString instruction = has(item[u"instruction"_s]) ? S(item[u"instruction"_s]) : QString();
    if (!body.isEmpty() || move.isObject() || !outcome.isEmpty()) {
        QJsonObject foot;
        if (!outcome.isEmpty()) foot[u"outcome"_s] = QJsonObject{{u"label"_s, outcomeLabel().value(outcome)}, {u"tint"_s, outcomeTint(outcome)}};
        if (move.isObject()) foot[u"move"_s] = QJsonObject{{u"text"_s, moveText(move.toObject())}, {u"tone"_s, moveTone(move)}};
        // 消息的说明是跟单结果那一句(「只观察:能发…」):冒号前的已经在 Pill 上了,只留后半句;想法的说明不摆
        if (!body.isEmpty() && kind != u"message" && kind != u"idea") foot[u"body"_s] = body;
        if (!body.isEmpty() && kind == u"message" && !outcome.isEmpty()) foot[u"body"_s] = QString(body).remove(QRegularExpression(u"^[^:]*:"_s));
        if (!instruction.isEmpty()) foot[u"instruction"_s] = instruction;
        row[u"foot"_s] = foot;
    }
    return row;
}

}  // namespace

QString modKey() {
#ifdef Q_OS_MACOS
    return u"⌘"_s;
#else
    return u"Ctrl+"_s;
#endif
}

QJsonObject timelineModel(const QJsonArray& items, double now, const QString& current, const QString& empty, const QTimeZone& tz) {
    if (items.isEmpty()) return {{u"empty"_s, empty.isNull() ? u"还没有可看的消息、信号或事件"_s : empty}};
    QJsonArray groups;
    for (const QJsonValue& g : groupByDay(items, now, tz)) {
        QJsonArray rows;
        for (const QJsonValue& item : g[u"items"_s].toArray()) rows.append(rowModel(item, now, current, tz));
        groups.append(QJsonObject{{u"label"_s, g[u"label"_s]}, {u"count"_s, rows.size()}, {u"rows"_s, rows}});
    }
    return {{u"groups"_s, groups}};
}

QStringList timelineTexts(const QJsonObject& timeline) {
    if (timeline.contains(u"empty"_s)) return {timeline[u"empty"_s].toString()};
    QStringList t;
    for (const QJsonValue& g : timeline[u"groups"_s].toArray()) {
        t << g[u"label"_s].toString() << QString::number(g[u"count"_s].toInt());
        for (const QJsonValue& r : g[u"rows"_s].toArray()) {
            t << r[u"kindLabel"_s].toString() << r[u"source"_s].toString();
            for (const QJsonValue& s : r[u"syms"_s].toArray()) t << s[u"text"_s].toString();
            t << r[u"time"_s].toString() << r[u"title"_s].toString();
            const QJsonObject f = r[u"foot"_s].toObject();
            if (f.contains(u"outcome"_s)) t << f[u"outcome"_s][u"label"_s].toString();
            if (f.contains(u"move"_s)) t << f[u"move"_s][u"text"_s].toString();
            if (f.contains(u"body"_s)) t << f[u"body"_s].toString();
            if (f.contains(u"instruction"_s)) t << u"写进指令框"_s;
        }
    }
    return t;
}

// { modKey, loading, notices: [{ tone, title, text }], kinds: [{ value, label }], kind, heldOnly, query, count, hot: [{ symbol, n, held }],
//   timeline: null(读着)| { empty } | { groups } }
QJsonObject pageModel(const QJsonObject& state, const QString& query, bool connected, double nowMs, const QTimeZone& tz) {
    const QJsonValue feed = state[u"feed"_s];
    QJsonObject page{{u"modKey"_s, modKey()}, {u"loading"_s, state[u"loading"_s].toBool()}, {u"heldOnly"_s, state[u"heldOnly"_s].toBool()}, {u"query"_s, query}};
    QJsonArray notices;
    if (!connected)
        notices.append(QJsonObject{{u"tone"_s, u"info"_s}, {u"title"_s, u"没连券商"_s}, {u"text"_s, u"时间线照常;消息上\"此刻的价\"、档案里的持仓与现价要连上之后才有。"_s}});
    if (T(state[u"feedError"_s])) notices.append(QJsonObject{{u"tone"_s, u"warn"_s}, {u"title"_s, u"时间线没读到"_s}, {u"text"_s, S(state[u"feedError"_s])}});
    page[u"notices"_s] = notices;
    QJsonArray kinds{QJsonObject{{u"value"_s, u"all"_s}, {u"label"_s, u"全部"_s}}};
    for (const QString& k : kindOrder()) kinds.append(QJsonObject{{u"value"_s, k}, {u"label"_s, kindLabel().value(k)}});
    page[u"kinds"_s] = kinds;
    const QJsonArray picked = state[u"kinds"_s].toArray();
    page[u"kind"_s] = picked.size() == 1 ? picked.first().toString() : u"all"_s;
    const QJsonArray all = arr(feed[u"items"_s]);
    const QJsonArray items = filterItems(all, {}, false, query);
    page[u"count"_s] = feed.isObject() ? u"%1 条 · 共记 %2 条消息"_s.arg(items.size()).arg(S(feed[u"total_messages"_s])) : QString();
    page[u"hot"_s] = hotSymbols(all);
    const double now = feed.isObject() && has(feed[u"at"_s]) ? N(feed[u"at"_s]) : nowMs;
    if (!feed.isObject() && !T(state[u"feedError"_s])) page[u"timeline"_s] = QJsonValue::Null;
    else page[u"timeline"_s] = timelineModel(items, now, QString(), query.isEmpty() ? QString() : u"没有含「%1」的"_s.arg(query), tz);
    return page;
}

QStringList pageTexts(const QJsonObject& page) {
    QStringList t{u"情报"_s, u"查标的 "_s + page[u"modKey"_s].toString() + u"K"_s, u"刷新"_s, u"消息、信号、事件、单子、想法按标的串成一条线;点标的看它的档案"_s};
    for (const QJsonValue& n : page[u"notices"_s].toArray()) t << n[u"title"_s].toString() << n[u"text"_s].toString();
    for (const QJsonValue& k : page[u"kinds"_s].toArray()) t << k[u"label"_s].toString();
    t << u"只看持仓相关"_s;
    if (!page[u"count"_s].toString().isEmpty()) t << page[u"count"_s].toString();
    const QJsonArray hot = page[u"hot"_s].toArray();
    if (!hot.isEmpty()) t << u"常被提到"_s;
    for (const QJsonValue& h : hot) t << h[u"symbol"_s].toString() << QString::number(h[u"n"_s].toInt());
    if (page[u"timeline"_s].isObject()) t << timelineTexts(page[u"timeline"_s].toObject());
    return t;
}

namespace {

const QHash<QString, QString>& signalLabel() {
    static const QHash<QString, QString> m{{u"cross"_s, u"价位穿越"_s}, {u"touch"_s, u"碰均线"_s},   {u"spike"_s, u"急涨急跌"_s}, {u"day_move"_s, u"大涨大跌"_s},
                                           {u"rvol"_s, u"全天放量"_s},  {u"burst"_s, u"窗口放量"_s}, {u"leaders"_s, u"强势股"_s}, {u"pa"_s, u"K线 PA"_s}};
    return m;
}
const QHash<QString, QString>& quoteSource() {
    static const QHash<QString, QString> m{{u"index"_s, u"指数"_s}, {u"futures"_s, u"期货推算"_s}, {u"index_stale"_s, u"上一个收盘"_s}, {u"quote"_s, u"实时"_s}, {u"daily_close"_s, u"日线收盘"_s}};
    return m;
}
QJsonObject pill(const QString& text, const QString& tint, bool dot = false, const QString& tip = QString()) {
    return {{u"text"_s, text}, {u"tint"_s, tint}, {u"dot"_s, dot}, {u"tip"_s, tip}};
}
QJsonObject section(const QString& title, int count, const QJsonArray& rows, const QString& kind = u"list"_s) {
    return {{u"title"_s, title}, {u"count"_s, count}, {u"rows"_s, rows}, {u"kind"_s, kind}};
}
QJsonObject li(const QString& k, const QJsonValue& v = QJsonValue(), const QString& cls = QString()) {
    QJsonObject o{{u"k"_s, k}, {u"cls"_s, cls}};
    if (!v.isUndefined()) o[u"v"_s] = v;
    return o;
}

}  // namespace

// { symbol, loading, error, ready, head: { price, dir, change, source, pills }, sections: [{ title, count, kind: list | levels, rows }], timeline }
QJsonObject dossierModel(const QJsonObject& dossier, const QTimeZone& tz) {
    const QString symbol = dossier[u"symbol"_s].toString();
    QJsonObject m{{u"symbol"_s, symbol}, {u"loading"_s, dossier[u"loading"_s].toBool()}, {u"error"_s, T(dossier[u"error"_s]) ? S(dossier[u"error"_s]) : QString()}};
    const QJsonValue d = dossier[u"data"_s];
    m[u"ready"_s] = d.isObject();
    if (!d.isObject()) return m;
    const double now = N(d[u"at"_s]);
    const QJsonValue q = d[u"quote"_s];
    const QJsonValue chg = q[u"change_pct"_s];
    const QString dir = !has(chg) || N(chg) == 0 ? QString() : N(chg) > 0 ? u"up"_s : u"down"_s;
    QJsonArray pills;
    if (T(d[u"held"_s])) pills.append(pill(u"持仓中"_s, u"blue"_s, true));
    for (const QString& s : strs(d[u"sectors"_s])) pills.append(pill(s, u"gray"_s));
    if (T(d[u"watch"_s][u"enabled"_s])) pills.append(pill(u"盯价位"_s, u"teal"_s));
    if (T(d[u"quality"_s][u"enabled"_s])) pills.append(pill(u"盯异动"_s, u"orange"_s));
    if (T(d[u"mentions_7d"_s])) pills.append(pill(u"7 天被提到 %1 次"_s.arg(S(d[u"mentions_7d"_s])), u"purple"_s));
    for (const QJsonValue& s : arr(d[u"signals"_s]))
        pills.append(pill(u"%1 ×%2"_s.arg(signalLabel().value(S(s[u"source"_s]), S(s[u"source"_s])), S(s[u"n"_s])), u"gray"_s, false,
                          u"最近 90 天;最近一条 "_s + zhDateTime(QDateTime::fromString(S(s[u"last_at"_s]), Qt::ISODateWithMs).toMSecsSinceEpoch(), tz)));
    m[u"head"_s] = QJsonObject{{u"price"_s, q.isObject() ? enUs2(N(q[u"price"_s])) : u"—"_s},
                               {u"dir"_s, dir},
                               {u"change"_s, has(chg) ? (N(chg) > 0 ? u"+"_s : QString()) + jsToFixed(N(chg), 2) + u"%"_s : QString()},
                               {u"source"_s, q.isObject() ? quoteSource().value(S(q[u"source"_s]), S(q[u"source"_s])) : T(d[u"connected"_s]) ? u"没有在订这只的行情"_s : u"没连券商"_s},
                               {u"pills"_s, pills}};
    QJsonArray sections;
    if (const QJsonArray ps = arr(d[u"positions"_s]); !ps.isEmpty()) {
        QJsonArray rows;
        for (const QJsonValue& p : ps) {
            const double qty = N(p[u"quantity"_s]);
            const bool stk = S(p[u"sec_type"_s]) == u"STK";
            const double mult = T(p[u"multiplier"_s]) ? N(p[u"multiplier"_s]) : 1;
            const QJsonValue pnl = p[u"unrealized_pnl"_s], pct = p[u"unrealized_pct"_s];
            QJsonObject pnlCell;
            if (!has(pnl)) pnlCell = {{u"text"_s, u"—"_s}, {u"cls"_s, u"muted"_s}};
            else {
                const double v = N(pnl);
                const QString sign = v > 0 ? u"+"_s : QString();
                pnlCell = {{u"text"_s, sign + track::fmtMoney(pnl)}, {u"cls"_s, v == 0 ? u"muted"_s : v > 0 ? u"pnl-up"_s : u"pnl-down"_s},
                           {u"pct"_s, has(pct) ? u" "_s + sign + jsToFixed(N(pct), 2) + u"%"_s : QString()}};
            }
            rows.append(QJsonObject{{u"k"_s, T(p[u"label"_s]) ? S(p[u"label"_s]) : track::legLabel(S(p[u"symbol"_s]), S(p[u"sec_type"_s]), p[u"contract"_s].toObject())},
                                    {u"v"_s, u"%1 %2 · 均价 %3 ·"_s.arg(qty > 0 ? u"多"_s : u"空"_s, jsNumberToString(std::abs(qty)),
                                                                     track::fmtMoney(QJsonValue(stk ? N(p[u"avg_cost"_s]) : N(p[u"avg_cost"_s]) / mult)))},
                                    {u"pnl"_s, pnlCell}, {u"cls"_s, QString()}});
        }
        sections.append(section(u"持仓"_s, int(ps.size()), rows));
    }
    if (const QJsonArray ts = arr(d[u"tracks"_s]); !ts.isEmpty()) {
        QJsonArray rows;
        for (const QJsonValue& t : ts) {
            const QString v = T(t[u"fired_state"_s])  ? u"已触发 "_s + S(t[u"fired_state"_s])
                              : T(t[u"enabled"_s])    ? (T(t[u"auto_close"_s][u"enabled"_s]) ? u"盯着,到价自动平"_s : u"盯着,只提醒"_s)
                                                      : u"暂停"_s;
            rows.append(li(track::legLabel(S(t[u"symbol"_s]), S(t[u"sec_type"_s]), t[u"contract"_s].toObject()) + u" · "_s + S(t[u"account"_s]), v));
        }
        sections.append(section(u"追踪"_s, int(ts.size()), rows));
    }
    if (const QJsonArray ws = arr(d[u"working"_s]); !ws.isEmpty()) {
        QJsonArray rows;
        for (const QJsonValue& w : ws) rows.append(li(T(w[u"summary"_s]) ? S(w[u"summary"_s]) : S(w[u"id"_s]), u"%1 · %2"_s.arg(S(w[u"status"_s]), S(w[u"account"_s]))));
        sections.append(section(u"在途单"_s, int(ws.size()), rows));
    }
    if (const QJsonArray es = arr(d[u"events"_s]); !es.isEmpty()) {
        QJsonArray rows;
        for (qsizetype i = 0; i < std::min<qsizetype>(es.size(), 6); ++i) {
            const QJsonValue e = es[i];
            rows.append(li(S(e[u"title"_s]), u"美东 %1 %2 · %3"_s.arg(S(e[u"date_et"_s]).mid(5), S(e[u"time_et"_s]), relTime(N(e[u"at"_s]), now, tz)), S(e[u"impact"_s])));
        }
        sections.append(section(u"接下来的事"_s, int(es.size()), rows));
    }
    if (const QJsonArray ls = arr(d[u"watch"_s][u"levels"_s]); d[u"watch"_s].isObject() && !ls.isEmpty()) {
        QList<QJsonValue> sorted(ls.begin(), ls.end());
        std::stable_sort(sorted.begin(), sorted.end(), [](const QJsonValue& a, const QJsonValue& b) { return N(b[u"price"_s]) < N(a[u"price"_s]); });
        QJsonArray rows;
        for (qsizetype i = 0; i < std::min<qsizetype>(sorted.size(), 10); ++i)
            rows.append(QJsonObject{{u"text"_s, u"%1 %2"_s.arg(S(sorted[i][u"label"_s]), S(sorted[i][u"price"_s]))}, {u"kind"_s, S(sorted[i][u"kind"_s])}, {u"tip"_s, S(sorted[i][u"label"_s])}});
        sections.append(section(u"价位"_s, int(ls.size()), rows, u"levels"_s));
    }
    if (const QJsonArray qs = arr(d[u"quality"_s][u"events"_s]); d[u"quality"_s].isObject() && !qs.isEmpty()) {
        QJsonArray rows;
        for (qsizetype i = qs.size() - 1, n = 0; i >= 0 && n < 5; --i, ++n) rows.append(li(S(qs[i][u"title"_s]), relTime(N(qs[i][u"at"_s]) * 1000, now, tz)));
        sections.append(section(u"最近异动"_s, int(qs.size()), rows));
    }
    if (const QJsonArray is = arr(d[u"ideas"_s]); !is.isEmpty()) {
        QJsonArray rows;
        for (qsizetype i = 0; i < std::min<qsizetype>(is.size(), 5); ++i) rows.append(li(S(is[i][u"text"_s]), QJsonValue(), u"wrap"_s));
        sections.append(section(u"想法"_s, int(is.size()), rows));
    }
    m[u"sections"_s] = sections;
    const QJsonArray timeline = arr(d[u"timeline"_s]);
    m[u"timelineCount"_s] = timeline.size();
    m[u"timeline"_s] = timelineModel(timeline, now, symbol, u"还没有关于 %1 的消息、信号或单子"_s.arg(symbol), tz);
    return m;
}

namespace {
/// SectionTitle 的数是 AntD Badge:每一位数是一段(滚动数字)
QStringList badge(int n) {
    QStringList out;
    for (const QChar c : QString::number(n)) out << QString(c);
    return out;
}
}  // namespace

QStringList dossierTexts(const QJsonObject& m) {
    QStringList t{m[u"symbol"_s].toString(), u"档案"_s, u"刷新"_s, u"K 线"_s, u"写指令"_s};
    if (!m[u"error"_s].toString().isEmpty()) t << u"没读到档案"_s << m[u"error"_s].toString();
    if (!m[u"ready"_s].toBool()) return t;
    const QJsonObject h = m[u"head"_s].toObject();
    t << h[u"price"_s].toString();
    if (!h[u"change"_s].toString().isEmpty()) t << h[u"change"_s].toString();
    t << h[u"source"_s].toString();
    for (const QJsonValue& p : h[u"pills"_s].toArray()) t << p[u"text"_s].toString();
    for (const QJsonValue& s : m[u"sections"_s].toArray()) {
        t << s[u"title"_s].toString() << badge(s[u"count"_s].toInt());
        for (const QJsonValue& r : s[u"rows"_s].toArray()) {
            if (s[u"kind"_s].toString() == u"levels") {
                t << r[u"text"_s].toString();
                continue;
            }
            t << r[u"k"_s].toString();
            if (r.toObject().contains(u"v"_s)) t << r[u"v"_s].toString();
            if (r[u"pnl"_s].isObject()) {
                t << r[u"pnl"_s][u"text"_s].toString();
                if (!r[u"pnl"_s][u"pct"_s].toString().isEmpty()) t << r[u"pnl"_s][u"pct"_s].toString();
            }
        }
    }
    t << u"时间线"_s << badge(m[u"timelineCount"_s].toInt());
    t << timelineTexts(m[u"timeline"_s].toObject());
    return t;
}

// { modKey, text, symbol(认出来的代码,空 = 认不出), warn, hint, held: [代码], recent: [代码] }
QJsonObject lookupModel(const QJsonObject& state, const QString& text) {
    const std::optional<QString> symbol = lookupSymbol(text);
    const bool typed = !jsTrim(text).isEmpty();
    const bool bad = typed && !symbol;
    QJsonArray held;
    for (const QJsonValue& s : arr(state[u"feed"_s][u"held"_s])) held.append(S(s));
    return {{u"modKey"_s, modKey()},
            {u"text"_s, text},
            {u"symbol"_s, symbol.value_or(QString())},
            {u"warn"_s, bad},
            {u"hint"_s, bad ? u"写代码(字母开头,最多 10 位);中文名在消息里会自动认出来。"_s
                            : u"回车打开档案:持仓、追踪、价位、异动、事件、提到它的消息,一页看完。%1K 随时打开。"_s.arg(modKey())},
            {u"held"_s, held},
            {u"recent"_s, state[u"recent"_s].toArray()}};
}

QStringList lookupTexts(const QJsonObject& m) {
    QStringList t{u"查标的"_s, m[u"hint"_s].toString()};
    if (!m[u"held"_s].toArray().isEmpty()) {
        t << u"持仓"_s;
        for (const QJsonValue& s : m[u"held"_s].toArray()) t << s.toString();
    }
    if (!m[u"recent"_s].toArray().isEmpty()) {
        t << u"最近"_s;
        for (const QJsonValue& s : m[u"recent"_s].toArray()) t << s.toString();
    }
    return t;
}

}  // namespace ibkr::shell::intel
