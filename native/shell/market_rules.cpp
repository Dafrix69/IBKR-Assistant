#include "shell/market_rules.h"

#include "shell/jsvalue.h"
#include "shell/track_rules.h"

#include <QJsonDocument>
#include <QRegularExpression>

#include <algorithm>
#include <cmath>

namespace ibkr::shell::market {

using namespace Qt::StringLiterals;

namespace {

/// 模板串里的 ${x}
QString S(const QJsonValue& v) { return jsString(v); }
bool T(const QJsonValue& v) { return jsTruthy(v); }
double N(const QJsonValue& v) { return jsNumber(v); }
/// x != null(undefined 与 null 都算没有)
bool has(const QJsonValue& v) { return !v.isNull() && !v.isUndefined(); }
/// (v || []) 当数组
QJsonArray arr(const QJsonValue& v) { return v.isArray() ? v.toArray() : QJsonArray{}; }
QString signedText(const QJsonValue& n) { return (N(n) > 0 ? u"+"_s : QString()) + S(n); }
QString side(const QJsonValue& n) { return N(n) > 0 ? u"up"_s : N(n) < 0 ? u"down"_s : u"flat"_s; }
/// StatTile 的 tone:pos / neg / 空
QString tileTone(double n) { return n > 0 ? u"pos"_s : n < 0 ? u"neg"_s : QString(); }

QString biasTone(const QString& bias) {
    if (bias == u"bullish" || bias == u"lean_bull") return u"ok"_s;
    if (bias == u"bearish" || bias == u"lean_bear") return u"bad"_s;
    if (bias == u"neutral") return u"warn"_s;
    return u"info"_s;
}
double biasSign(const QString& bias) {
    if (bias == u"bullish" || bias == u"lean_bull") return 1;
    if (bias == u"bearish" || bias == u"lean_bear") return -1;
    return 0;
}
QString sideLabel(const QJsonValue& s) {
    const QString k = s.toString();
    if (k == u"bull") return u"看涨"_s;
    if (k == u"bear") return u"看跌"_s;
    if (k == u"neutral") return u"中性"_s;
    return u"undefined"_s;
}
QString agreementLabel(const QJsonValue& state) {
    const QString k = state.toString();
    if (k == u"aligned") return u"与本周期同向"_s;
    if (k == u"conflict") return u"与本周期相反"_s;
    if (k == u"unclear") return u"谈不上顺逆"_s;
    return u"—"_s;
}
/// 'x'.slice(11)
QString slice11(const QString& s) { return s.size() > 11 ? s.mid(11) : QString(); }

QJsonArray strings(const QStringList& l) {
    QJsonArray a;
    for (const QString& s : l) a.append(s);
    return a;
}

/// SubScores + FormingNote + Readout:结论那张卡片
QJsonObject verdict(const QJsonObject& r) {
    QJsonObject v;
    v[u"tone"_s] = biasTone(r[u"bias"_s].toString());
    v[u"title"_s] = u"%1 %2 · %3"_s.arg(S(r[u"symbol"_s]), S(r[u"timeframe_label"_s]), S(r[u"bias_label"_s]));
    v[u"score"_s] = signedText(r[u"score"_s]);
    v[u"side"_s] = side(r[u"score"_s]);
    v[u"meta"_s] = u"打分区间 −100 ~ +100 · 置信度 "_s + S(r[u"confidence"_s]);
    // 三个子分 + 高周期(没有子分整块不画)
    const QJsonArray subs = arr(r[u"sub_scores"_s]);
    QJsonArray tiles;
    if (!subs.isEmpty()) {
        for (const QJsonValue& s : subs) {
            const QString label = T(s[u"mixed"_s]) ? u"%1 · 组内多空都有"_s.arg(S(s[u"label"_s])) : S(s[u"label"_s]);
            tiles.append(QJsonObject{{u"label"_s, label}, {u"value"_s, u"%1 / %2"_s.arg(signedText(s[u"score"_s]), S(s[u"max"_s]))}, {u"tone"_s, tileTone(N(s[u"score"_s]))}});
        }
        const QJsonValue htf = r[u"htf"_s];
        const bool hasHtf = T(htf);
        tiles.append(QJsonObject{
            {u"label"_s, hasHtf ? u"高周期 %1 · %2"_s.arg(S(htf[u"timeframe_label"_s]), agreementLabel(r[u"agreement"_s].isObject() ? r[u"agreement"_s][u"state"_s] : QJsonValue())) : u"高周期"_s},
            {u"value"_s, hasHtf ? S(htf[u"bias_label"_s]) : u"没有可对照的"_s},
            {u"tone"_s, tileTone(hasHtf ? biasSign(htf[u"bias"_s].toString()) : 0)}});
        v[u"subsMeta"_s] = u"结构 = 摆动结构 + 最近一次突破 + 均线排列;位置 = 区间位置 + 贴近关键位;确认 = 扫单 + 形态 + 量能。三个数各自相加、互不抵消;总分是它们的和、再夹在 ±100 之内;高周期只并排看,不进总分。"_s;
    }
    v[u"subs"_s] = tiles;
    // 正在形成的那一根
    const QJsonValue f = r[u"forming"_s];
    if (T(f)) {
        const QString closesAt = S(f[u"closes_at"_s]);
        const QString at = T(f[u"closes_at"_s]) ? (slice11(closesAt).isEmpty() ? closesAt : slice11(closesAt)) : QString();
        const QString waiting = f[u"waiting"_s].toString();
        const QString why = waiting == u"delayed" ? u"行情是延迟的(晚 15–20 分钟),它的数据可能还没到齐"_s
                          : waiting == u"unknown" ? u"还说不准这个标的的行情是不是延迟的,先按延迟对待"_s
                                                  : QString();
        const QString title = T(f[u"waiting"_s])
                                  ? u"数据未到齐:%1 那根按钟点 %2 已经走完,%3;现价 %4"_s.arg(S(f[u"time"_s]), at, why, S(f[u"close"_s]))
                                  : u"正在形成:%1 那根(%2),现价 %3"_s.arg(S(f[u"time"_s]), at.isEmpty() ? u"还没收盘"_s : at + u" 收盘"_s, S(f[u"close"_s]));
        QStringList hints;
        for (const QJsonValue& h : arr(f[u"hints"_s])) hints << u"未确认 · "_s + S(h);
        v[u"forming"_s] = QJsonObject{{u"title"_s, title},
                                      {u"body"_s, u"下面的分数、结构事件、扫单与形态只算到 %1 那根收盘;这一根%2之前不进判定。"_s.arg(S(r[u"closed_bar"_s]), T(f[u"waiting"_s]) ? u"数据到齐"_s : u"走完"_s)},
                                      {u"hints"_s, strings(hints)}};
    } else {
        v[u"forming"_s] = QJsonValue::Null;
    }
    // readout:首句与拆不开的行原样,「字段:结论」拆成两列
    static const QRegularExpression pair(u"^([^:：]{1,12})[:：]\\s*(.+)\\z"_s, QRegularExpression::UseUnicodePropertiesOption);
    QJsonArray prose, pairs;
    const QJsonArray lines = arr(r[u"readout"_s]);
    for (qsizetype i = 0; i < lines.size(); ++i) {
        const QString line = S(lines[i]);
        const auto m = pair.match(line);
        if (i == 0 || !m.hasMatch()) prose.append(line);
        else pairs.append(QJsonArray{jsTrim(m.captured(1)), jsTrim(m.captured(2))});
    }
    v[u"prose"_s] = prose;
    v[u"pairs"_s] = pairs;
    return v;
}

QJsonObject evidenceRow(const QJsonValue& e) {
    return {{u"label"_s, S(e[u"label"_s])}, {u"detail"_s, S(e[u"detail"_s])}, {u"weight"_s, signedText(e[u"weight"_s])}, {u"side"_s, side(e[u"weight"_s])}};
}

/// 判断依据:按子分分组,每组一个小计;没有子分就平铺
QJsonObject evidence(const QJsonObject& r) {
    const QJsonArray ev = arr(r[u"evidence"_s]);
    const QJsonArray subs = arr(r[u"sub_scores"_s]);
    QJsonObject out;
    QJsonArray groups, rows;
    if (!subs.isEmpty()) {
        for (const QJsonValue& s : subs) {
            QJsonArray items;
            for (const QJsonValue& e : ev)
                if (e[u"group"_s] == s[u"key"_s]) items.append(evidenceRow(e));
            groups.append(QJsonObject{{u"key"_s, S(s[u"key"_s])}, {u"label"_s, S(s[u"label"_s])}, {u"mixed"_s, T(s[u"mixed"_s])},
                                      {u"score"_s, u"%1 / %2"_s.arg(signedText(s[u"score"_s]), S(s[u"max"_s]))}, {u"side"_s, side(s[u"score"_s])}, {u"rows"_s, items}});
        }
    } else {
        for (const QJsonValue& e : ev) rows.append(evidenceRow(e));
    }
    out[u"groups"_s] = groups;
    out[u"rows"_s] = rows;
    return out;
}

QJsonObject structure(const QJsonObject& r) {
    QJsonObject out;
    out[u"title"_s] = u"结构:"_s + S(r[u"trend_label"_s]);
    const QJsonArray swings = arr(r[u"swings"_s]);
    QStringList sw;
    for (const QJsonValue& s : swings) sw << u"%1@%2"_s.arg(S(s[u"label"_s]), S(s[u"price"_s]));
    out[u"swings"_s] = swings.isEmpty() ? QString() : u"摆动序列(旧→新):"_s + sw.join(u" → "_s);
    const QJsonArray events = arr(r[u"events"_s]);
    QJsonArray ev;
    for (qsizetype i = std::max<qsizetype>(0, events.size() - 3); i < events.size(); ++i)
        ev.append((events[i][u"kind"_s] == u"CHoCH"_s ? u"⚠ "_s : QString()) + S(events[i][u"text"_s]));
    out[u"events"_s] = ev;
    QJsonArray levels;
    for (const QJsonValue& l : arr(r[u"levels"_s])) {
        const bool res = l[u"side"_s] == u"resistance"_s;
        const double d = N(l[u"distance_pct"_s]);
        levels.append(QJsonObject{{u"label"_s, res ? u"阻力"_s : u"支撑"_s}, {u"tint"_s, res ? u"rejected"_s : u"filled"_s}, {u"price"_s, S(l[u"price"_s])},
                                  {u"meta"_s, u"%1 次触碰 · %2 个摆动点 · 距收盘 %3%4%"_s.arg(S(l[u"touches"_s]), S(l[u"swings"_s]), d > 0 ? u"+"_s : QString(), S(l[u"distance_pct"_s]))}});
    }
    out[u"levels"_s] = levels;
    return out;
}

QJsonArray flow(const QJsonObject& r) {
    QJsonArray rows;
    for (const QJsonValue& g : arr(r[u"fvgs"_s]))
        rows.append(u"未回补 FVG(%1)%2 ~ %3,%4 留下,已回补 %5%"_s.arg(sideLabel(g[u"side"_s]), S(g[u"bottom"_s]), S(g[u"top"_s]), S(g[u"time"_s]), S(g[u"filled_pct"_s])));
    if (T(r[u"order_block"_s])) {
        const QJsonValue ob = r[u"order_block"_s];
        rows.append(u"订单块(%1)%2 ~ %3,%4,%5"_s.arg(sideLabel(ob[u"side"_s]), S(ob[u"bottom"_s]), S(ob[u"top"_s]), S(ob[u"time"_s]), T(ob[u"mitigated"_s]) ? u"已被回踩"_s : u"尚未回踩"_s));
    }
    for (const QJsonValue& s : arr(r[u"sweeps"_s])) rows.append(S(s[u"text"_s]));
    for (const QJsonValue& e : arr(r[u"equal_levels"_s])) rows.append(S(e[u"text"_s]));
    for (const QJsonValue& p : arr(r[u"patterns"_s])) {
        if (!(N(p[u"bars_ago"_s]) <= 2)) continue;
        const QString t = S(p[u"time"_s]);
        rows.append(u"%1(%2 那根):%3"_s.arg(S(p[u"name"_s]), slice11(t).isEmpty() ? t : slice11(t), S(p[u"note"_s])));
    }
    if (rows.isEmpty()) rows.append(u"这一段没有留下未回补缺口、扫单或明显形态。"_s);
    return rows;
}

QJsonArray plan(const QJsonObject& r) {
    QJsonArray rows;
    const QJsonValue p = r[u"plan"_s];
    if (!p.isObject()) return rows;
    if (T(p[u"confirm"_s])) rows.append(u"确认条件:"_s + S(p[u"confirm"_s]));
    if (p[u"invalidation"_s].isObject() && T(p[u"invalidation"_s][u"why"_s])) rows.append(u"失效条件:"_s + S(p[u"invalidation"_s][u"why"_s]));
    for (const QJsonValue& w : arr(p[u"watch"_s])) rows.append(u"观察点:"_s + S(w));
    if (T(p[u"atr_note"_s])) rows.append(S(p[u"atr_note"_s]));
    return rows;
}

QJsonValue htfCard(const QJsonObject& r) {
    const QJsonValue h = r[u"htf"_s];
    if (!T(h)) return QJsonValue::Null;
    const QJsonValue agreement = r[u"agreement"_s];
    const QString state = agreement.isObject() ? agreement[u"state"_s].toString() : QString();
    QJsonArray rows;
    rows.append(S(h[u"trend_label"_s]) + (T(h[u"closed_bar"_s]) ? u"(算到 %1 那根收盘)"_s.arg(S(h[u"closed_bar"_s])) : QString()));
    if (T(h[u"last_event"_s])) rows.append(S(h[u"last_event"_s]));
    rows.append(u"支撑 %1 / 阻力 %2"_s.arg(has(h[u"support"_s]) ? S(h[u"support"_s]) : u"该样本内无"_s, has(h[u"resistance"_s]) ? S(h[u"resistance"_s]) : u"该样本内无"_s));
    if (agreement.isObject() && T(agreement[u"text"_s])) rows.append(S(agreement[u"text"_s]));
    return QJsonObject{{u"tone"_s, state == u"aligned" ? u"ok"_s : state == u"conflict" ? u"bad"_s : u"warn"_s},
                       {u"title"_s, u"高周期 %1:%2"_s.arg(S(h[u"timeframe_label"_s]), S(h[u"bias_label"_s]))}, {u"rows"_s, rows}};
}

QJsonObject aiCard(const QJsonValue& comment, bool commenting) {
    QJsonObject out{{u"button"_s, commenting ? u"解读中…"_s : T(comment) ? u"重新解读"_s : u"AI 解读"_s}, {u"loading"_s, commenting}};
    if (!T(comment)) {
        out[u"comment"_s] = QJsonValue::Null;
        return out;
    }
    QJsonArray watch, risks;
    for (const QJsonValue& w : arr(comment[u"watch"_s])) watch.append(S(w));
    for (const QJsonValue& w : arr(comment[u"risks"_s])) risks.append(S(w));
    out[u"comment"_s] = QJsonObject{{u"summary"_s, S(comment[u"summary"_s])}, {u"reading"_s, T(comment[u"reading"_s]) ? S(comment[u"reading"_s]) : QString()},
                                    {u"watch"_s, watch}, {u"risks"_s, risks},
                                    {u"meta"_s, u"模型 %1 · 仅供研究参考,不构成投资建议"_s.arg(T(comment[u"model"_s]) ? S(comment[u"model"_s]) : u"—"_s)}};
    return out;
}

}  // namespace

QString freshness(const QJsonObject& r) {
    QStringList parts{u"最后一根 %1%2"_s.arg(S(r[u"last_bar"_s]), T(r[u"forming"_s]) ? u"(正在形成)"_s : QString())};
    if (has(r[u"age_seconds"_s])) {
        const double mins = jsRound(N(r[u"age_seconds"_s]) / 60);
        parts << (mins < 1 ? u"刚刚"_s : u"%1 分钟前"_s.arg(jsNumberToString(mins)));
    }
    parts << u"%1%2 根"_s.arg(T(r[u"forming"_s]) ? u"已收盘 "_s : QString(), S(r[u"bar_count"_s]));
    // 盘外那一段从哪来:个股自己的;指数按期货推算的;指数推不出来就只有常规时段
    if (!T(r[u"rth"_s])) {
        const QString off = r[u"off_hours"_s].toString();
        if (off == u"proxy") {
            const QJsonValue fut = r[u"proxy"_s].isObject() ? r[u"proxy"_s][u"futures"_s] : QJsonValue();
            parts << u"盘外按 %1 推算"_s.arg(T(fut) ? S(fut) : u"期货"_s);
        } else if (off == u"stock") {
            parts << (T(r[u"overnight"_s]) ? u"含盘前盘后与夜盘"_s : u"含盘前盘后"_s);
        } else {
            parts << u"指数只有常规时段"_s;
        }
    }
    if (T(r[u"cached"_s])) parts << u"引擎缓存"_s;
    return parts.join(u" · "_s);
}

QStringList readSymbols(const QString& raw) {
    const QJsonDocument doc = QJsonDocument::fromJson((raw.isEmpty() ? u"[]"_s : raw).toUtf8());
    QStringList out;
    if (!doc.isArray()) return out;
    for (const QJsonValue& v : doc.array()) out << S(v);
    return out;
}

QJsonObject bookBody(const QJsonValue& cell, bool loading) {
    if (!T(cell)) return {{u"kind"_s, u"none"_s}, {u"text"_s, loading ? u"正在读取盘口…"_s : u"点「刷新」读取盘口。"_s}};
    if (cell.isObject() && cell.toObject().contains(u"error"_s)) return {{u"kind"_s, u"error"_s}, {u"text"_s, S(cell[u"error"_s])}};
    const QJsonValue l1 = cell[u"l1"_s], liq = cell[u"liquidity"_s];
    QJsonArray meta;
    if (has(l1[u"last"_s])) meta.append(u"最新 "_s + track::fmtMoney(l1[u"last"_s]));
    if (has(l1[u"spread"_s])) meta.append(u"价差 %1(%2 bps)"_s.arg(S(l1[u"spread"_s]), S(l1[u"spread_bps"_s])));
    if (T(liq[u"spread_grade"_s])) meta.append(u"流动性 "_s + S(liq[u"spread_grade"_s]));
    if (has(liq[u"bid_depth"_s])) meta.append(u"深度 买%1 / 卖%2"_s.arg(S(liq[u"bid_depth"_s]), S(liq[u"ask_depth"_s])));
    if (has(liq[u"imbalance_pct"_s])) {
        const double imb = N(liq[u"imbalance_pct"_s]);
        meta.append(u"失衡 %1 %2%%3"_s.arg(imb >= 0 ? u"买盘厚"_s : u"卖盘厚"_s, jsNumberToString(std::abs(imb)), T(liq[u"l1_only"_s]) ? u"(仅一档)"_s : QString()));
    }
    const auto quote = [&](const QString& name, const QString& price, const QString& size) {
        return u"%1 %2%3"_s.arg(name, has(l1[price]) ? track::fmtMoney(l1[price]) : u"—"_s, T(l1[size]) ? u" ×"_s + S(l1[size]) : QString());
    };
    QJsonObject out{{u"kind"_s, u"ok"_s}, {u"meta"_s, meta}, {u"bid"_s, quote(u"买一"_s, u"bid"_s, u"bid_size"_s)}, {u"ask"_s, quote(u"卖一"_s, u"ask"_s, u"ask_size"_s)}};
    const QJsonArray bids = arr(cell[u"bids"_s]), asks = arr(cell[u"asks"_s]);
    const auto ladder = [](const QJsonArray& levels) {
        QJsonArray rows;
        double maxSize = 1;
        for (qsizetype i = 0; i < std::min<qsizetype>(5, levels.size()); ++i) maxSize = std::max(maxSize, N(levels[i][u"size"_s]));
        for (qsizetype i = 0; i < std::min<qsizetype>(5, levels.size()); ++i)
            rows.append(QJsonObject{{u"price"_s, track::fmtMoney(levels[i][u"price"_s])}, {u"size"_s, S(levels[i][u"size"_s])},
                                    {u"pct"_s, std::max(N(levels[i][u"size"_s]) / maxSize * 100, 2.0)}});
        return rows;
    };
    out[u"depth"_s] = bids.isEmpty() && asks.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(QJsonObject{{u"bids"_s, ladder(bids)}, {u"asks"_s, ladder(asks)}});
    out[u"note"_s] = T(cell[u"note"_s]) ? S(cell[u"note"_s]) : QString();
    return out;
}

// { freshness, symbol, timeframe, rth, timeframes: [{ key, label }], tfLabel, introOpen, legendOpen,
//   result: { state: error | loading | empty | ok, text },
//   pa: { verdict, chart: { title, show }, book: { symbol, title, loading, followed, body }, evidence, structure, flow, plan, htf, warnings, ai } (ok 时),
//   books: { count, refreshAllDisabled, primerOpen, cards: [{ symbol, loading, body }] } }
QJsonObject pageModel(const PageInput& in) {
    QJsonObject page;
    const QJsonObject r = in.data.toObject();
    const bool hasData = T(in.data);
    page[u"loading"_s] = in.loading;
    page[u"freshness"_s] = in.loading ? u"读取中…"_s : hasData ? freshness(r) : QString();
    page[u"symbol"_s] = in.symbol;
    page[u"timeframe"_s] = in.timeframe;
    page[u"rth"_s] = in.rth;
    page[u"timeframes"_s] = in.timeframes;
    QString tfLabel;
    for (const QJsonValue& t : in.timeframes)
        if (t[u"key"_s].toString() == in.timeframe) tfLabel = S(t[u"label"_s]);
    page[u"tfLabel"_s] = tfLabel;
    page[u"introOpen"_s] = in.introOpen.value_or(false);
    page[u"legendOpen"_s] = in.legendOpen.value_or(false);

    if (!in.error.isEmpty()) page[u"result"_s] = QJsonObject{{u"state"_s, u"error"_s}, {u"text"_s, in.error}};
    else if (!hasData) page[u"result"_s] = in.loading ? QJsonObject{{u"state"_s, u"loading"_s}, {u"text"_s, u"正在取 K 线…"_s}} : QJsonObject{{u"state"_s, u"empty"_s}, {u"text"_s, u"输入标的后点「分析」。"_s}};
    else page[u"result"_s] = QJsonObject{{u"state"_s, u"ok"_s}, {u"text"_s, QString()}};

    if (in.error.isEmpty() && hasData) {
        const QString shown = T(r[u"symbol"_s]) ? S(r[u"symbol"_s]) : QString();
        QJsonArray warnings;
        for (const QJsonValue& w : arr(r[u"warnings"_s])) warnings.append(S(w));
        page[u"pa"_s] = QJsonObject{
            {u"verdict"_s, verdict(r)},
            {u"chart"_s, QJsonObject{{u"title"_s, u"K 线(%1)"_s.arg(S(r[u"timeframe_label"_s]))}, {u"show"_s, !arr(r[u"bars"_s]).isEmpty()}}},
            {u"book"_s, QJsonObject{{u"symbol"_s, shown}, {u"title"_s, u"盘口 · "_s + shown}, {u"loading"_s, in.bookLoading.contains(shown)},
                                    {u"followed"_s, in.books.contains(shown)}, {u"body"_s, bookBody(in.bookData.value(shown), in.bookLoading.contains(shown))}}},
            {u"evidence"_s, evidence(r)},
            {u"structure"_s, structure(r)},
            {u"flow"_s, flow(r)},
            {u"plan"_s, plan(r)},
            {u"htf"_s, htfCard(r)},
            {u"warnings"_s, warnings},
            {u"ai"_s, aiCard(in.comment, in.commenting)},
        };
    }

    QJsonArray cards;
    for (const QString& s : in.books)
        cards.append(QJsonObject{{u"symbol"_s, s}, {u"loading"_s, in.bookLoading.contains(s)}, {u"body"_s, bookBody(in.bookData.value(s), in.bookLoading.contains(s))}});
    page[u"books"_s] = QJsonObject{{u"count"_s, int(in.books.size())}, {u"refreshAllDisabled"_s, in.books.isEmpty()},
                                   {u"primerOpen"_s, in.bookPrimerOpen.value_or(in.books.isEmpty())}, {u"cards"_s, cards}};
    return page;
}

namespace {

void bodyTexts(QStringList& t, const QJsonObject& b) {
    if (b[u"kind"_s] != u"ok"_s) {
        t << b[u"text"_s].toString();
        return;
    }
    for (const QJsonValue& m : b[u"meta"_s].toArray()) t << m.toString();
    t << b[u"bid"_s].toString() << b[u"ask"_s].toString();
    if (b[u"depth"_s].isObject()) {
        for (const auto& [title, key] : {std::pair{u"买盘"_s, u"bids"_s}, std::pair{u"卖盘"_s, u"asks"_s}}) {
            t << title;
            for (const QJsonValue& row : b[u"depth"_s][key].toArray()) t << row[u"price"_s].toString() << row[u"size"_s].toString();
        }
    }
    if (!b[u"note"_s].toString().isEmpty()) t << b[u"note"_s].toString();
}

void list(QStringList& t, const QJsonValue& a) {
    for (const QJsonValue& v : a.toArray()) t << v.toString();
}

}  // namespace

namespace {

// 参考资料里的那几段(<strong> 拆开的,照 DOM 一段一段)
const QStringList& introTexts() {
    static const QStringList t{
        u"K 线走 TWS 历史数据接口,需行情权限;个股与 ETF 的夜盘(IBKR 的隔夜交易时段,美东 20:00–04:00)是向券商另要一次接在盘后后面;指数(SPX)只在常规时段计算,盘外那几段按期货(ES)减基差推算、和蝴蝶测算里标「期货推算」的现价同一个口径(顶栏行情带那一格夜里停在昨收),图上用灰色竖带标出,不是指数本身;仅延迟权限也能出图,数据晚 15–20 分钟,判定会退到数据确定到齐的那一根; 新鲜度见标题右侧,行情停了超 30 分钟会告警。方向判断"_s,
        u"全部由规则计算、只用已收盘的 K 线"_s,
        u"(正在形成的那一根只作提示), 权重公开在「判断依据」里; 「AI 解读」只叙述这些事实,不看图。图下面是同一标的的盘口,只读展示、不参与定价与下单, 无 Level 2 订阅时只有一档;指数没有盘口,看对应 ETF。已连网关时 K 线与盘口每 20 秒自动刷新。"_s,
        u"仅供研究参考,不接下单链路。"_s};
    return t;
}
const QStringList& legendTexts() {
    static const QStringList t{
        u"蜡烛按涨跌着色(可在「设置 → 涨跌配色」切换红涨绿跌);量能柱同色,按 95 分位归一化,开盘第一根巨量不会把其余压成一条线。"_s,
        u"MA5 / MA10 / MA20 是引擎算的收盘价简单均线,只作图,不进打分;左上角显示最后一根(或光标所在那根)的均线值。"_s,
        u"虚线是关键位:支撑用涨色、阻力用跌色;价格标签放在右侧价格轴上,挤在一起时会被推开并画引线回到真实价位。"_s,
        u"半透明色块是未回补的 FVG(缺口),灰色虚线框是订单块;它们从产生那根 K 线画到最后一根,不铺到轴上。"_s,
        u"点 + 小字是最近的摆动点(HH / HL / LH / LL);蓝色点线是现价。鼠标悬停显示十字光标与那一根的开高低收量。"_s,
        u"最后一根还没走完时,它上面有一条标着「形成中」的竖线(延迟行情下数据还没到齐的标「未到齐」):这一根照常画,但不进任何判定。"_s,
        u"滚轮缩放、按住拖动平移,拖价格轴或时间轴也能缩放;双击轴复位。每 20 秒的自动刷新不会把缩放到的位置刷掉。"_s};
    return t;
}
/// 读盘常识:三张卡片,每张 { title, 段落(<strong> 拆开) }
const QList<std::pair<QString, QStringList>>& bookPrimerTexts() {
    static const QList<std::pair<QString, QStringList>> t{
        {u"订单簿是什么"_s, {u"未成交限价单按价格聚合:买单从高到低,卖单从低到高。买一与卖一之差是"_s, u"价差"_s, u",各价位挂单量是"_s, u"深度"_s, u"。一档(L1)只看买一/卖一;Level 2 看多档,需单独订阅。"_s}},
        {u"怎么读"_s, {u"价差窄、深度厚 = 流动性好、滑点小;价差宽、深度薄时大单会吃穿多档。某价位的异常大单可能是支撑/压力,也可能是随时撤掉的诱导单:挂单不等于成交。盘前盘后深度明显变薄。"_s}},
        {u"对本系统的意义"_s, {u"AUTO_MID 按盘口中间价 ±滑点上限定价:价差 10 美分的票,上限 0.10 合理;价差 2 美元的期权组合则可能永远不成交。下条件单前先看价差,再定净权利金上限或滑点。期权盘口普遍比正股宽一个数量级。"_s}}};
    return t;
}

}  // namespace

QStringList pageTexts(const QJsonObject& page) {
    QStringList t{u"行情"_s};
    if (!page[u"freshness"_s].toString().isEmpty()) t << page[u"freshness"_s].toString();
    if (!page[u"tfLabel"_s].toString().isEmpty()) t << page[u"tfLabel"_s].toString();
    t << u"分析"_s << u"只看正常交易时段"_s << u"默认含盘前盘后,个股与 ETF 还接上夜盘(美东 20:00–04:00),指数的盘外按期货推算;打开只取 09:30–16:00"_s;
    t << u"数据来源与判断方式"_s;
    if (page[u"introOpen"_s].toBool()) t << introTexts();
    const QJsonObject res = page[u"result"_s].toObject();
    if (res[u"state"_s] != u"ok"_s) {
        t << res[u"text"_s].toString();
    } else {
        const QJsonObject pa = page[u"pa"_s].toObject();
        const QJsonObject v = pa[u"verdict"_s].toObject();
        t << v[u"title"_s].toString() << v[u"score"_s].toString() << v[u"meta"_s].toString();
        for (const QJsonValue& s : v[u"subs"_s].toArray()) t << s[u"label"_s].toString() << s[u"value"_s].toString();
        if (v.contains(u"subsMeta"_s)) t << v[u"subsMeta"_s].toString();
        if (v[u"forming"_s].isObject()) {
            t << v[u"forming"_s][u"title"_s].toString() << v[u"forming"_s][u"body"_s].toString();
            list(t, v[u"forming"_s][u"hints"_s]);
        }
        list(t, v[u"prose"_s]);
        for (const QJsonValue& p : v[u"pairs"_s].toArray()) t << p[0].toString() << p[1].toString();
        t << pa[u"chart"_s][u"title"_s].toString();
        const QJsonObject book = pa[u"book"_s].toObject();
        t << book[u"title"_s].toString() << u"刷新"_s << (book[u"followed"_s].toBool() ? u"已关注"_s : u"加入关注"_s);
        bodyTexts(t, book[u"body"_s].toObject());
        t << u"判断依据(正 = 看涨)"_s;
        const auto rows = [&](const QJsonValue& a) {
            for (const QJsonValue& e : a.toArray()) t << e[u"label"_s].toString() << e[u"detail"_s].toString() << e[u"weight"_s].toString();
        };
        for (const QJsonValue& g : pa[u"evidence"_s][u"groups"_s].toArray()) {
            t << g[u"label"_s].toString();
            if (g[u"mixed"_s].toBool()) t << u"这一组里多空都有"_s;
            t << g[u"score"_s].toString();
            rows(g[u"rows"_s]);
        }
        rows(pa[u"evidence"_s][u"rows"_s]);
        t << u"权重是手定的、固定在引擎里,没有按历史表现校过;不认同某条,可以从它那一组里减去再看。"_s;
        const QJsonObject st = pa[u"structure"_s].toObject();
        t << st[u"title"_s].toString();
        if (!st[u"swings"_s].toString().isEmpty()) t << st[u"swings"_s].toString();
        list(t, st[u"events"_s]);
        for (const QJsonValue& l : st[u"levels"_s].toArray()) t << l[u"label"_s].toString() << l[u"price"_s].toString() << l[u"meta"_s].toString();
        t << u"流动性与形态"_s;
        list(t, pa[u"flow"_s]);
        t << u"关键价位"_s;
        list(t, pa[u"plan"_s]);
        t << u"以上只是价位与条件,不是建议;本页不接下单链路,仅供研究参考。"_s;
        if (pa[u"htf"_s].isObject()) {
            t << pa[u"htf"_s][u"title"_s].toString();
            list(t, pa[u"htf"_s][u"rows"_s]);
        }
        if (!pa[u"warnings"_s].toArray().isEmpty()) {
            t << u"这次分析的局限"_s;
            list(t, pa[u"warnings"_s]);
        }
        const QJsonObject ai = pa[u"ai"_s].toObject();
        t << u"AI 解读(可选)"_s << ai[u"button"_s].toString() << u"模型只拿到上面算好的事实,看不到原始 K 线;它只负责把事实串成叙述。"_s;
        if (ai[u"comment"_s].isObject()) {
            const QJsonObject c = ai[u"comment"_s].toObject();
            t << c[u"summary"_s].toString();
            if (!c[u"reading"_s].toString().isEmpty()) t << c[u"reading"_s].toString();
            if (!c[u"watch"_s].toArray().isEmpty()) {
                t << u"盯:"_s;
                list(t, c[u"watch"_s]);
            }
            if (!c[u"risks"_s].toArray().isEmpty()) {
                t << u"可能错在:"_s;
                list(t, c[u"risks"_s]);
            }
            t << c[u"meta"_s].toString();
        }
    }
    t << u"图上画的是什么"_s;
    if (page[u"legendOpen"_s].toBool()) t << legendTexts();

    const QJsonObject books = page[u"books"_s].toObject();
    t << u"关注的盘口"_s << QString::number(books[u"count"_s].toInt()) << u"添加"_s << u"全部刷新"_s;
    const QJsonArray cards = books[u"cards"_s].toArray();
    if (cards.isEmpty()) t << u"还没有关注的盘口。上面加一个,或在正在看的那张盘口上点「加入关注」。"_s;
    for (const QJsonValue& c : cards) {
        t << c[u"symbol"_s].toString() << (c[u"loading"_s].toBool() ? u"读取中…"_s : u"刷新"_s) << u"移除"_s;
        bodyTexts(t, c[u"body"_s].toObject());
    }
    t << u"读盘常识"_s;
    if (books[u"primerOpen"_s].toBool())
        for (const auto& [title, paras] : bookPrimerTexts()) t << title << paras;
    return t;
}

}  // namespace ibkr::shell::market
