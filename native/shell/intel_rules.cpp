#include "shell/intel_rules.h"

#include "shell/jsvalue.h"

#include <QDateTime>
#include <QRegularExpression>

#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::shell::intel {

const QHash<QString, QString>& kindLabel() {
    static const QHash<QString, QString> m{{u"message"_s, u"消息"_s}, {u"signal"_s, u"信号"_s}, {u"event"_s, u"事件"_s}, {u"order"_s, u"单子"_s}, {u"idea"_s, u"想法"_s}};
    return m;
}
const QHash<QString, QString>& kindIcon() {
    static const QHash<QString, QString> m{{u"message"_s, u"sf-antenna"_s}, {u"signal"_s, u"sf-bell"_s}, {u"event"_s, u"sf-clock"_s}, {u"order"_s, u"sf-paperplane"_s}, {u"idea"_s, u"sf-bulb"_s}};
    return m;
}
const QHash<QString, QString>& kindTint() {
    static const QHash<QString, QString> m{{u"message"_s, u"blue"_s}, {u"signal"_s, u"orange"_s}, {u"event"_s, u"purple"_s}, {u"order"_s, u"green"_s}, {u"idea"_s, u"yellow"_s}};
    return m;
}
const QStringList& kindOrder() {
    static const QStringList l{u"message"_s, u"signal"_s, u"event"_s, u"order"_s, u"idea"_s};
    return l;
}

QString sourceLabel(const QString& kind, const QString& source) {
    static const QHash<QString, QHash<QString, QString>> m{
        {u"signal"_s, {{u"cross"_s, u"价位穿越"_s}, {u"touch"_s, u"碰均线"_s}, {u"spike"_s, u"急涨急跌"_s}, {u"day_move"_s, u"大涨大跌"_s}, {u"rvol"_s, u"全天放量"_s},
                       {u"burst"_s, u"窗口放量"_s}, {u"leaders"_s, u"强势股"_s}, {u"pa"_s, u"K线 PA"_s}}},
        {u"event"_s, {{u"cpi"_s, u"CPI"_s}, {u"ppi"_s, u"PPI"_s}, {u"nfp"_s, u"非农"_s}, {u"fomc"_s, u"FOMC"_s}, {u"fomc_minutes"_s, u"会议纪要"_s}, {u"pce"_s, u"PCE"_s},
                      {u"gdp"_s, u"GDP"_s}, {u"retail"_s, u"零售"_s}, {u"claims"_s, u"初请"_s}, {u"fed_speech"_s, u"美联储讲话"_s}, {u"ism"_s, u"ISM"_s},
                      {u"other"_s, u"宏观"_s}, {u"custom"_s, u"自己记的"_s}, {u"cross"_s, u"跨市场"_s}}},
        {u"idea"_s, {{u"active"_s, u"进行中"_s}, {u"done"_s, u"已完成"_s}, {u"archived"_s, u"已归档"_s}}},
    };
    return m.value(kind).value(source, source);
}

QString relTime(double at, double now, const QTimeZone& tz) {
    const double d = now - at;
    const double abs = std::fabs(d);
    const bool after = d < 0;
    if (abs < 60'000) return after ? u"马上"_s : u"刚刚"_s;
    if (abs < 3'600'000) return u"%1 分钟%2"_s.arg(jsNumberToString(jsRound(abs / 60'000)), after ? u"后"_s : u"前"_s);
    if (abs < 24 * 3'600'000.0) return u"%1 小时%2"_s.arg(jsNumberToString(jsRound(abs / 3'600'000)), after ? u"后"_s : u"前"_s);
    return QDateTime::fromMSecsSinceEpoch(qint64(at), tz).toString(u"MM-dd HH:mm"_s);
}

QString fmtPrice(double v) {
    static const QRegularExpression zeros(u"\\.0+\\z"_s);
    return (std::fabs(v) >= 1000 ? jsToFixed(v, 1) : jsToFixed(v, 2)).remove(zeros);
}

QString moveText(const QJsonObject& move) {
    const QString then = u"%1 提到时 %2"_s.arg(move.value("symbol"_L1).toString(), fmtPrice(move.value("then"_L1).toDouble()));
    if (move.value("now"_L1).isNull() || move.value("pct"_L1).isNull()) return then;
    const double pct = move.value("pct"_L1).toDouble();
    return u"%1 → 此刻 %2(%3%4%)"_s.arg(then, fmtPrice(move.value("now"_L1).toDouble()), pct > 0 ? u"+"_s : QString(), jsToFixed(pct, 2));
}

QString moveTone(const QJsonValue& move) {
    if (!move.isObject()) return {};
    const QJsonValue pct = move[u"pct"];
    if (pct.isNull() || pct.toDouble() == 0) return {};
    return pct.toDouble() > 0 ? u"up"_s : u"down"_s;
}

namespace {
QStringList strings(const QJsonValue& v) {
    QStringList out;
    for (const QJsonValue& s : v.toArray()) out << s.toString();
    return out;
}
QDate localDay(double t, const QTimeZone& tz) { return QDateTime::fromMSecsSinceEpoch(qint64(t), tz).date(); }
}  // namespace

QJsonArray filterItems(const QJsonArray& items, const QStringList& kinds, bool heldOnly, const QString& query) {
    const QString q = jsTrim(query).toLower();
    QJsonArray out;
    for (const QJsonValue& v : items) {
        const QJsonObject i = v.toObject();
        if (!kinds.isEmpty() && !kinds.contains(i.value("kind"_L1).toString())) continue;
        if (heldOnly && i.value("held"_L1).toArray().isEmpty()) continue;
        const QStringList symbols = strings(i.value("symbols"_L1));
        const bool match = q.isEmpty() || std::any_of(symbols.begin(), symbols.end(), [&q](const QString& s) { return s.toLower() == q; }) ||
                           u"%1 %2 %3 %4"_s.arg(i.value("title"_L1).toString(), i.value("body"_L1).toString(), i.value("source"_L1).toString(), symbols.join(u' ')).toLower().contains(q);
        if (match) out.append(i);
    }
    return out;
}

QJsonArray groupByDay(const QJsonArray& items, double now, const QTimeZone& tz) {
    static const QStringList weekdays{u"周一"_s, u"周二"_s, u"周三"_s, u"周四"_s, u"周五"_s, u"周六"_s, u"周日"_s};
    const QDate today = localDay(now, tz);
    QJsonArray out;
    QString lastLabel;
    QJsonArray lastItems;
    const auto flush = [&] {
        if (!lastLabel.isNull()) out.append(QJsonObject{{u"label"_s, lastLabel}, {u"items"_s, lastItems}});
    };
    for (const QJsonValue& v : items) {
        const QDate day = localDay(v[u"at"].toDouble(), tz);
        // 昨天 / 明天按"现在 ± 24 小时"那一刻落在哪天(toDateString 的口径;夏令时换时那天和日历差一天时照它)
        const QString label = day == today ? u"今天"_s
                              : day == localDay(now - 24 * 3'600'000.0, tz) ? u"昨天"_s
                              : day == localDay(now + 24 * 3'600'000.0, tz) ? u"明天"_s
                                                                            : u"%1月%2日%3"_s.arg(day.month()).arg(day.day()).arg(weekdays.at(day.dayOfWeek() - 1));
        if (label == lastLabel) {
            lastItems.append(v);
            continue;
        }
        flush();
        lastLabel = label;
        lastItems = QJsonArray{v};
    }
    flush();
    return out;
}

QJsonArray hotSymbols(const QJsonArray& items, int max) {
    struct Count {
        QString symbol;
        int n = 0;
        bool held = false;
    };
    QList<Count> counts;  // 插入顺序与 Map 一样:先见到的在前
    for (const QJsonValue& v : items) {
        const QStringList held = strings(v[u"held"]);
        for (const QString& s : strings(v[u"symbols"])) {
            auto it = std::find_if(counts.begin(), counts.end(), [&s](const Count& c) { return c.symbol == s; });
            if (it == counts.end()) it = counts.insert(counts.end(), Count{s});
            it->n += 1;
            if (held.contains(s)) it->held = true;
        }
    }
    // localeCompare:代码只有大写字母、数字与点,ICU 的次序(标点 < 数字 < 字母)与按码位比一样
    std::stable_sort(counts.begin(), counts.end(), [](const Count& a, const Count& b) { return a.n != b.n ? a.n > b.n : a.symbol < b.symbol; });
    QJsonArray out;
    for (qsizetype i = 0; i < counts.size() && i < max; ++i) out.append(QJsonObject{{u"symbol"_s, counts[i].symbol}, {u"n"_s, counts[i].n}, {u"held"_s, counts[i].held}});
    return out;
}

bool isHeldMention(const QJsonValue& data) {
    if (!data.isObject()) return false;
    const QJsonObject d = data.toObject();
    return d.value("message_id"_L1).isString() && !d.value("symbols"_L1).toArray().isEmpty() && d.value("text"_L1).isString();
}

QJsonObject heldMentionPopup(const QJsonObject& m, double now) {
    const QStringList symbols = strings(m.value("symbols"_L1));
    const QString symbol = symbols.value(0);
    const QJsonValue price = m.value("prices"_L1).toObject().value(symbol);
    const QString author = m.value("author_name"_L1).toString();
    const QString body = u"%1:%2%3"_s.arg(author.isEmpty() ? u"频道"_s : author, m.value("text"_L1).toString(),
                                         price.isDouble() ? u"(当时 %1 %2)"_s.arg(symbol, fmtPrice(price.toDouble())) : QString());
    const QJsonValue at = m.value("at"_L1);
    return {
        {u"id"_s, u"intel:"_s + m.value("message_id"_L1).toString()},
        {u"kind"_s, u"event"_s},
        {u"symbol"_s, symbol},
        {u"title"_s, symbols.join(u"、"_s) + u" 被提到(持仓)"_s},
        {u"body"_s, body.left(230)},
        {u"tone"_s, u"info"_s},
        {u"at"_s, at.isDouble() && std::isfinite(at.toDouble()) ? at.toDouble() : now},
        {u"page"_s, u"intel"_s},
    };
}

std::optional<QString> lookupSymbol(const QString& raw) {
    static const QRegularExpression dollar(u"^\\$"_s);
    static const QRegularExpression shape(u"^[A-Z][A-Z0-9.]{0,9}\\z"_s);
    const QString s = jsTrim(raw).remove(dollar).toUpper();
    if (shape.match(s).hasMatch()) return s;
    return std::nullopt;
}

}  // namespace ibkr::shell::intel
