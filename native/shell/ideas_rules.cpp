#include "shell/ideas_rules.h"

#include "shell/jsvalue.h"
#include "shell/order_rules.h"
#include "shell/records_rules.h"
#include "shell/trade_rules.h"

namespace ibkr::shell::ideas {

using namespace Qt::StringLiterals;

namespace {

QString S(const QJsonValue& v) { return jsString(v); }
bool T(const QJsonValue& v) { return jsTruthy(v); }
bool has(const QJsonValue& v) { return !v.isNull() && !v.isUndefined(); }
QJsonArray arr(const QJsonValue& v) { return v.isArray() ? v.toArray() : QJsonArray{}; }

QString statusLabel(const QJsonValue& s) {
    const QString k = s.toString();
    if (k == u"active") return u"进行中"_s;
    if (k == u"done") return u"已完成"_s;
    if (k == u"archived") return u"已归档"_s;
    return S(s);
}
QString matchLabel(const QJsonValue& m) {
    const QString k = m.toString();
    if (k == u"symbol") return u"标的命中"_s;
    if (k == u"text") return u"原文命中"_s;
    if (k == u"semantic") return u"语义相近"_s;
    if (k == u"recent") return u"近期"_s;
    return u"undefined"_s;
}

/// BulletList:没有或空就不画;否则一行标题 + 一个列表
void bullets(QJsonArray& sections, const QString& title, const QJsonValue& items, const std::function<QString(const QJsonValue&)>& text = {}) {
    const QJsonArray a = arr(items);
    if (a.isEmpty()) return;
    QJsonArray out;
    for (const QJsonValue& v : a) out.append(text ? text(v) : S(v));
    sections.append(QJsonObject{{u"title"_s, title}, {u"items"_s, out}});
}

QJsonObject timeItem(const QString& prefix, const QJsonValue& iso, const PageInput& in) {
    return {{u"text"_s, prefix + orders::fmtTimeShort(iso, in.nowMs, in.zone)}, {u"title"_s, records::fmtTime(iso, in.zone)}};
}

/// 行情事实(代码计算)与 AI 叙事分开标注
QJsonObject analysisModel(const QJsonObject& a, const PageInput& in) {
    QJsonArray facts;
    const QJsonValue brief = a.value("brief"_L1);
    if (T(brief) && !T(brief[u"error"_s])) {
        static const QList<std::tuple<const char*, QString, QString>> labels{
            {"last", u"现价"_s, QString()}, {"chg_1d_pct", u"1日"_s, u"%"_s}, {"chg_20d_pct", u"20日"_s, u"%"_s}, {"chg_60d_pct", u"60日"_s, u"%"_s},
            {"rsi14", u"RSI14"_s, QString()}, {"vs_sma50_pct", u"对50日线"_s, u"%"_s}, {"vs_sma200_pct", u"对200日线"_s, u"%"_s},
            {"vol20_annual_pct", u"年化波动"_s, u"%"_s}, {"from_52w_high_pct", u"距52周高"_s, u"%"_s}};
        QStringList parts;
        for (const auto& [key, label, unit] : labels) {
            const QJsonValue v = brief[QLatin1StringView(key)];
            if (has(v)) parts << u"%1 %2%3"_s.arg(label, S(v), unit);
        }
        if (!parts.isEmpty()) facts.append(u"%1 行情(代码计算):%2"_s.arg(T(a.value("symbol"_L1)) ? S(a.value("symbol"_L1)) : QString(), parts.join(u" · "_s)));
        const QJsonValue anchor = brief[u"anchor"_s];
        if (T(anchor)) {
            const QJsonValue chg = anchor[u"chg_from_anchor_pct"_s];
            facts.append(u"价格锚点:%1 = %2%3"_s.arg(S(anchor[u"label"_s]), S(anchor[u"price"_s]),
                                                  has(chg) ? u" · 现价较锚点 %1%2%"_s.arg(jsNumber(chg) >= 0 ? u"+"_s : QString(), S(chg)) : QString()));
        }
    } else if (T(brief) && T(brief[u"error"_s])) {
        facts.append(u"行情获取失败:"_s + S(brief[u"error"_s]));
    } else if (T(a.value("symbol"_L1))) {
        facts.append(u"分析时未连接券商网关,无行情情报"_s);
    }
    QJsonArray sections;
    bullets(sections, u"下单前先核实:"_s, a.value("checks"_L1));
    bullets(sections, u"风险:"_s, a.value("risks"_L1));
    QJsonArray meta;
    if (T(a.value("model"_L1))) meta.append(QJsonObject{{u"text"_s, u"模型 "_s + S(a.value("model"_L1))}});
    if (T(a.value("analyzed_at"_L1))) meta.append(timeItem(u"分析于 "_s, a.value("analyzed_at"_L1), in));
    meta.append(QJsonObject{{u"text"_s, u"仅供参考,不构成投资建议"_s}});
    return {{u"title"_s, u"AI 分析 · "_s + (T(a.value("summary"_L1)) ? S(a.value("summary"_L1)) : QString())},
            {u"facts"_s, facts},
            {u"thesis"_s, T(a.value("thesis"_L1)) ? u"逻辑:"_s + S(a.value("thesis"_L1)) : QString()},
            {u"sections"_s, sections},
            {u"suggestion"_s, T(a.value("suggestion"_L1)) ? u"建议:"_s + S(a.value("suggestion"_L1)) : QString()},
            {u"meta"_s, meta}};
}

}  // namespace

QJsonObject pageModel(const PageInput& in) {
    QJsonObject page{{u"filter"_s, in.filter}, {u"query"_s, in.query}, {u"withTrades"_s, in.withTrades}, {u"digesting"_s, in.digesting},
                     {u"digestButton"_s, in.digesting ? u"总结中…"_s : !in.query.isEmpty() ? u"按检索总结"_s : u"总结知识"_s}};
    // 最新一次知识总结
    if (!in.digests.isEmpty()) {
        const QJsonObject latest = in.digests.first().toObject();
        const QJsonObject d = latest.value("digest"_L1).toObject();
        QJsonArray sections;
        bullets(sections, u"反复出现的主题:"_s, d.value("themes"_L1));
        bullets(sections, u"经验教训:"_s, d.value("lessons"_L1));
        bullets(sections, u"想法质量的规律:"_s, d.value("patterns"_L1));
        bullets(sections, u"下一步:"_s, d.value("actions"_L1));
        bullets(sections, u"对照的交易(引擎从真实成交算出):"_s, latest.value("trades"_L1), [](const QJsonValue& t) { return trade::tradeFactText(t.toObject()); });
        QJsonArray meta{QJsonObject{{u"text"_s, u"基于 %1 条想法"_s.arg(S(latest.value("idea_count"_L1)))}}};
        if (T(latest.value("trades"_L1))) meta.append(QJsonObject{{u"text"_s, u"附带 %1 笔交易结果"_s.arg(arr(latest.value("trades"_L1)).size())}});
        const QJsonValue focus = latest.value("focus"_L1);
        if (T(focus)) {
            QStringList words;
            if (T(focus[u"q"_s])) words << S(focus[u"q"_s]);
            for (const QJsonValue& s : arr(focus[u"symbols"_s]))
                if (T(s)) words << S(s);
            meta.append(QJsonObject{{u"text"_s, u"检索:"_s + words.join(u' ')}});
        }
        if (T(d.value("model"_L1))) meta.append(QJsonObject{{u"text"_s, u"模型 "_s + S(d.value("model"_L1))}});
        meta.append(timeItem(u"总结于 "_s, latest.value("created_at"_L1), in));
        if (in.digests.size() > 1) meta.append(QJsonObject{{u"text"_s, u"共 %1 次总结,新的在上"_s.arg(in.digests.size())}});
        meta.append(QJsonObject{{u"text"_s, u"仅供复盘参考,不构成投资建议"_s}});
        page[u"digest"_s] = QJsonObject{{u"title"_s, u"知识总结 · "_s + (T(d.value("summary"_L1)) ? S(d.value("summary"_L1)) : QString())},
                                        {u"sections"_s, sections}, {u"meta"_s, meta}};
    } else {
        page[u"digest"_s] = QJsonValue::Null;
    }
    // 列表
    QJsonArray cards;
    if (!in.loadError.isEmpty()) {
        page[u"empty"_s] = u"读取失败:"_s + in.loadError;
    } else if (in.ideas.isEmpty()) {
        page[u"empty"_s] = !in.query.isEmpty() ? u"没有命中「%1」的想法。"_s.arg(in.query) : in.filter == u"active" ? u"还没有进行中的想法。"_s : u"还没有想法。"_s;
    } else {
        page[u"empty"_s] = QString();
        for (const QJsonValue& v : in.ideas) {
            const QJsonObject idea = v.toObject();
            const QString id = S(idea.value("id"_L1));
            const QString status = idea.value("status"_L1).toString();
            QStringList syms;
            // Array.prototype.join:null / undefined 写成空串
            for (const QJsonValue& s : arr(idea.value("symbols"_L1))) syms << (has(s) ? S(s) : QString());
            QJsonArray meta{QJsonObject{{u"text"_s, orders::fmtTimeShort(idea.value("created_at"_L1), in.nowMs, in.zone)}, {u"title"_s, records::fmtTime(idea.value("created_at"_L1), in.zone)}}};
            const QJsonArray by = arr(in.matched.value(id));
            if (!by.isEmpty()) {
                QStringList labels;
                for (const QJsonValue& m : by) labels << matchLabel(m);
                meta.append(QJsonObject{{u"text"_s, labels.join(u" · "_s)}});
            }
            const bool analyzing = in.analyzing.contains(id);
            const QJsonValue analysis = idea.value("analysis"_L1);
            cards.append(QJsonObject{
                {u"id"_s, id},
                {u"title"_s, syms.join(u" · "_s).isEmpty() ? u"想法"_s : syms.join(u" · "_s)},
                {u"status"_s, statusLabel(idea.value("status"_L1))},
                {u"statusTint"_s, status == u"active" ? u"pending"_s : status == u"done" ? u"filled"_s : u"rejected"_s},
                {u"text"_s, S(idea.value("text"_L1))},
                {u"meta"_s, meta},
                {u"analysis"_s, T(analysis) ? QJsonValue(analysisModel(analysis.toObject(), in)) : QJsonValue(QJsonValue::Null)},
                {u"active"_s, status == u"active"},
                {u"analyzing"_s, analyzing},
                {u"analyzeLabel"_s, analyzing ? u"分析中…"_s : T(analysis) ? u"AI 重新分析"_s : u"AI 分析"_s},
            });
        }
    }
    page[u"cards"_s] = cards;
    return page;
}

namespace {

void sectionTexts(QStringList& t, const QJsonValue& sections) {
    for (const QJsonValue& s : sections.toArray()) {
        t << s[u"title"_s].toString();
        for (const QJsonValue& i : s[u"items"_s].toArray()) t << i.toString();
    }
}
void metaTexts(QStringList& t, const QJsonValue& meta) {
    for (const QJsonValue& m : meta.toArray()) t << m[u"text"_s].toString();
}

}  // namespace

QStringList pageTexts(const QJsonObject& page) {
    QStringList t{u"想法"_s, u"随手记,不解析、不下单"_s, u"记下"_s, u"「AI 分析」和「发到解析」是什么"_s, u"进行中"_s, u"全部"_s, u"附带交易结果"_s,
                  page[u"digestButton"_s].toString()};
    if (page[u"digest"_s].isObject()) {
        t << page[u"digest"_s][u"title"_s].toString();
        sectionTexts(t, page[u"digest"_s][u"sections"_s]);
        metaTexts(t, page[u"digest"_s][u"meta"_s]);
    }
    if (!page[u"empty"_s].toString().isEmpty()) t << page[u"empty"_s].toString();
    for (const QJsonValue& c : page[u"cards"_s].toArray()) {
        t << c[u"title"_s].toString() << c[u"status"_s].toString() << c[u"text"_s].toString();
        metaTexts(t, c[u"meta"_s]);
        if (c[u"analysis"_s].isObject()) {
            const QJsonValue a = c[u"analysis"_s];
            t << a[u"title"_s].toString();
            for (const QJsonValue& f : a[u"facts"_s].toArray()) t << f.toString();
            if (!a[u"thesis"_s].toString().isEmpty()) t << a[u"thesis"_s].toString();
            sectionTexts(t, a[u"sections"_s]);
            if (!a[u"suggestion"_s].toString().isEmpty()) t << a[u"suggestion"_s].toString();
            metaTexts(t, a[u"meta"_s]);
        }
        if (c[u"active"_s].toBool()) t << c[u"analyzeLabel"_s].toString() << u"发到解析"_s << u"完成"_s << u"归档"_s;
        else t << u"恢复为进行中"_s;
    }
    return t;
}

}  // namespace ibkr::shell::ideas
