#include "shell/records_rules.h"

#include "shell/jsvalue.h"
#include "shell/order_rules.h"
#include "shell/track_rules.h"
#include "shell/trade_rules.h"

#include <QDateTime>

#include <algorithm>
#include <cmath>

namespace ibkr::shell::records {

using namespace Qt::StringLiterals;
using track::fmtExpiry;
using track::fmtMoney;

namespace {

bool isUndef(const QJsonValue& v) { return v.isUndefined(); }
/// a ?? b
QJsonValue coalesce(const QJsonValue& a, const QJsonValue& b) { return a.isUndefined() || a.isNull() ? b : a; }
/// String(x || '')
QString orEmpty(const QJsonValue& v) { return jsTruthy(v) ? jsString(v) : QString(); }

struct Filter {
    QString key;
    QString label;
};
const QList<Filter>& filters() {
    static const QList<Filter> f{{u"all"_s, u"全部"_s},     {u"filled"_s, u"已成交"_s}, {u"live"_s, u"进行中"_s}, {u"stale"_s, u"去向不明"_s},
                                 {u"draft"_s, u"未发送"_s}, {u"rejected"_s, u"被拒"_s}, {u"failed"_s, u"出错"_s}};
    return f;
}

const QStringList& buckets() {
    static const QStringList b{u"filled"_s, u"working"_s, u"draft"_s, u"failed"_s, u"halted"_s, u"stale"_s, u"closed"_s};
    return b;
}

const QHash<QString, QString>& secTypeLabel() {
    static const QHash<QString, QString> m{{u"STK"_s, u"股票"_s}, {u"OPT"_s, u"期权"_s}, {u"BAG"_s, u"组合(多腿)"_s}, {u"IND"_s, u"指数"_s}};
    return m;
}
const QHash<QString, QString>& orderTypeLabel() {
    static const QHash<QString, QString> m{{u"MKT"_s, u"市价单"_s}, {u"LMT"_s, u"限价单"_s}, {u"STP"_s, u"止损单"_s}, {u"STP LMT"_s, u"止损限价单"_s}, {u"TRAIL"_s, u"跟踪止损单"_s}};
    return m;
}
const QHash<QString, QString>& priceModeLabel() {
    static const QHash<QString, QString> m{{u"EXPLICIT"_s, u"指定价格"_s}, {u"AUTO_MID"_s, u"盘口中间价(AUTO_MID)"_s}};
    return m;
}
const QHash<QString, QString>& tifLabel() {
    static const QHash<QString, QString> m{{u"DAY"_s, u"当日有效"_s}, {u"GTC"_s, u"撤销前有效"_s}};
    return m;
}
const QHash<QString, QString>& comboLabel() {
    static const QHash<QString, QString> m{{u"VERTICAL"_s, u"垂直价差"_s}, {u"BUTTERFLY"_s, u"蝴蝶"_s}, {u"IRON_CONDOR"_s, u"铁鹰"_s}};
    return m;
}
const QHash<QString, QString>& actionLabelMap() {
    static const QHash<QString, QString> m{{u"BUY"_s, u"买入"_s}, {u"SELL"_s, u"卖出"_s}};
    return m;
}

/// labels.ts 的 say:空(null / undefined / '')是 null,查不到照原样
QJsonValue say(const QHash<QString, QString>& map, const QJsonValue& v) {
    if (v.isUndefined() || v.isNull() || v == QJsonValue(u""_s)) return QJsonValue::Null;
    const QString key = jsString(v);
    return map.value(key, key);
}

int localeCompare(const QCollator* c, const QString& a, const QString& b) {
    const int r = c ? c->compare(a, b) : a.compare(b);
    return r < 0 ? -1 : r > 0 ? 1 : 0;
}

}  // namespace

QString fmtTime(const QJsonValue& iso, const QTimeZone& zone) {
    if (!jsTruthy(iso)) return u"—"_s;
    const QString text = jsString(iso);
    const double ms = jsDateParse(text, zone);
    if (std::isnan(ms)) return text;
    const QDateTime d = QDateTime::fromMSecsSinceEpoch(qint64(ms), zone);
    return d.toString(u"yyyy/M/d HH:mm:ss"_s);
}

QStringList filterKeys() {
    QStringList out;
    for (const Filter& f : filters()) out << f.key;
    return out;
}

bool matchFilter(const QString& key, const QJsonObject& r) {
    const QJsonValue f = r.value("final_status"_L1);
    const QJsonValue s = r.value("status"_L1);
    const bool final = jsTruthy(f);
    if (key == u"filled") return f == QJsonValue(u"filled"_s) || f == QJsonValue(u"partially_filled"_s);
    if (key == u"live") return !final && s != QJsonValue(u"ValidatedOnly"_s) && s != QJsonValue(u"NotAtBroker"_s);
    if (key == u"stale") return !final && s == QJsonValue(u"NotAtBroker"_s);
    if (key == u"draft") return !final && s == QJsonValue(u"ValidatedOnly"_s);
    if (key == u"rejected") return orEmpty(f).startsWith(u"rejected");
    if (key == u"failed") return f == QJsonValue(u"ibkr_error"_s) || f == QJsonValue(u"halted_by_breaker"_s);
    return true;
}

Sort nextSort(const Sort& current, const QString& key) {
    if (current.key != key || current.order.isEmpty()) return {key, u"ascend"_s};
    if (current.order == u"ascend") return {key, u"descend"_s};
    return {key, QString()};
}

QJsonObject pageModel(const PageInput& in) {
    // 关键词过滤之后的集合:每档的条数与分段条都按它数(否则筛选条会承诺一些点不出来的结果)
    const QString k = jsTrim(in.keyword).toLower();
    QList<QJsonObject> byKeyword;
    for (const QJsonValue& v : in.records) {
        const QJsonObject r = v.toObject();
        bool hit = k.isEmpty();
        for (const char* field : {"symbol", "reason", "final_status", "intent_summary", "raw_instruction", "account"}) {
            if (hit) break;
            const QJsonValue f = r.value(QLatin1StringView(field));
            if (jsTruthy(f) && jsString(f).toLower().contains(k)) hit = true;
        }
        if (hit) byKeyword << r;
    }

    // 去向分段条 + 图例
    QJsonValue mix = QJsonValue::Null;
    if (!byKeyword.isEmpty()) {
        QHash<QString, int> count;
        for (const QJsonObject& r : byKeyword) ++count[orders::statusBucket(r)];
        QJsonArray parts, legend;
        for (const QString& b : buckets()) {
            const int n = count.value(b);
            if (!n) continue;
            const QString tint = orders::bucketTint(b), label = orders::bucketLabel(b);
            parts.append(QJsonObject{{u"key"_s, b}, {u"grow"_s, n}, {u"tint"_s, tint}, {u"title"_s, u"%1 %2"_s.arg(label).arg(n)}});
            legend.append(QJsonObject{{u"key"_s, b}, {u"tint"_s, tint}, {u"label"_s, label}, {u"count"_s, n}});
        }
        mix = QJsonObject{{u"parts"_s, parts}, {u"legend"_s, legend}};
    }

    // 筛选条:没有的档位先拦住(全部除外)
    QString active = u"all"_s;
    for (const Filter& f : filters()) if (f.key == in.filter) active = f.key;
    QJsonArray filterModel;
    for (const Filter& f : filters()) {
        int n = 0;
        for (const QJsonObject& r : byKeyword) n += matchFilter(f.key, r) ? 1 : 0;
        filterModel.append(QJsonObject{{u"key"_s, f.key}, {u"label"_s, f.label}, {u"count"_s, n}, {u"disabled"_s, f.key != u"all" && !n},
                                       {u"selected"_s, f.key == active}});
    }

    QList<QJsonObject> rows;
    for (const QJsonObject& r : byKeyword) if (matchFilter(active, r)) rows << r;
    // 表头排序:antd 先按 sorter 比,降序取反;比不出先后的照原来的次序(稳定排序)
    const auto keyOf = [&](const QJsonObject& r) -> QString {
        if (in.sort.key == u"final_status") return orders::statusLabel(r, u"进行中"_s);
        return orEmpty(r.value(in.sort.key));
    };
    if (!in.sort.order.isEmpty() && (in.sort.key == u"created_at" || in.sort.key == u"symbol" || in.sort.key == u"final_status")) {
        const int sign = in.sort.order == u"descend" ? -1 : 1;
        std::stable_sort(rows.begin(), rows.end(), [&](const QJsonObject& a, const QJsonObject& b) {
            return sign * localeCompare(in.collator, keyOf(a), keyOf(b)) < 0;
        });
    }

    QJsonArray rowModel;
    for (const QJsonObject& r : rows) {
        const QJsonValue action = r.value("action"_L1);
        const QString symbol = (jsTruthy(r.value("symbol"_L1)) ? jsString(r.value("symbol"_L1)) : u"—"_s).left(5);
        const QJsonValue text = jsTruthy(r.value("intent_summary"_L1)) ? r.value("intent_summary"_L1) : r.value("raw_instruction"_L1);
        const QJsonValue notional = r.value("notional_estimate"_L1);
        QJsonObject row{
            {u"id"_s, jsString(r.value("id"_L1))},
            {u"time"_s, orders::fmtTimeShort(r.value("created_at"_L1), in.nowMs, in.zone)},
            {u"timeTitle"_s, fmtTime(r.value("created_at"_L1), in.zone)},
            {u"symbol"_s, symbol},
            {u"symbolLong"_s, symbol.size() > 4},
            {u"symbolTint"_s, action == QJsonValue(u"SELL"_s) ? u"down"_s : action == QJsonValue(u"BUY"_s) ? u"up"_s : u"gray"_s},
            {u"symbolLink"_s, jsTruthy(r.value("symbol"_L1)) ? jsString(r.value("symbol"_L1)) : QString()},
            {u"side"_s, jsTruthy(action) ? QJsonValue(actionLabelMap().value(jsString(action), jsString(action))) : QJsonValue::Null},
            {u"buy"_s, action == QJsonValue(u"BUY"_s)},
            {u"intent"_s, jsTruthy(text) ? jsString(text) : QString()},
            {u"reason"_s, orEmpty(r.value("reason"_L1))},
            {u"account"_s, jsTruthy(r.value("account"_L1)) ? QJsonValue(u"%1 %2"_s.arg(jsString(r.value("account"_L1)), orEmpty(r.value("account_masked"_L1))))
                                                         : QJsonValue::Null},
            {u"paper"_s, jsTruthy(r.value("is_paper"_L1))},
            {u"amount"_s, jsTruthy(notional) ? u"≈ "_s + fmtMoney(notional) : QString()},
            {u"status"_s, orders::statusLabel(r, u"进行中"_s)},
            {u"statusTint"_s, orders::bucketTint(orders::statusBucket(r))},
            {u"open"_s, !in.openId.isEmpty() && jsString(r.value("id"_L1)) == in.openId},
        };
        rowModel.append(row);
    }

    const auto column = [&](const QString& key, const QString& title, bool sortable) {
        return QJsonObject{{u"key"_s, key}, {u"title"_s, title}, {u"sortable"_s, sortable}, {u"order"_s, sortable && in.sort.key == key ? in.sort.order : QString()}};
    };
    return {
        {u"title"_s, u"交易记录"_s},
        {u"mix"_s, mix},
        {u"filters"_s, filterModel},
        {u"error"_s, in.error.isEmpty() ? QString() : u"读取失败:"_s + in.error},
        {u"compact"_s, in.compact},
        {u"columns"_s, QJsonArray{column(u"created_at"_s, u"时间"_s, true), column(u"symbol"_s, u"标的"_s, true), column(u"intent_summary"_s, u"意图"_s, false),
                                  column(u"account"_s, u"账户"_s, false), column(u"notional_estimate"_s, u"金额"_s, false), column(u"final_status"_s, u"状态"_s, true)}},
        {u"rows"_s, rowModel},
        {u"empty"_s, !in.keyword.isEmpty() || active != u"all" ? u"没有符合条件的记录。"_s : u"暂无记录。"_s},
    };
}

QJsonValue ticketFromRecord(const QJsonValue& contractV, const QJsonValue& orderV, const QJsonValue& triggerV) {
    const QJsonObject c = contractV.toObject(), o = orderV.toObject(), t = triggerV.toObject();
    if (!jsTruthy(c.value("symbol"_L1)) || !jsTruthy(o.value("action"_L1)) || !jsTruthy(o.value("totalQuantity"_L1))) return QJsonValue::Null;
    QJsonArray legs;
    const QJsonValue legsV = c.value("legs"_L1);
    for (const QJsonValue& lv : legsV.toArray()) {
        if (!jsTruthy(lv)) continue;
        const QJsonObject l = lv.toObject();
        const QJsonValue right = l.value("right"_L1);
        if (!std::isfinite(jsNumber(l.value("strike"_L1))) || (right != QJsonValue(u"C"_s) && right != QJsonValue(u"P"_s))) continue;
        QJsonObject leg;
        if (!isUndef(l.value("action"_L1))) leg.insert(u"action"_s, l.value("action"_L1));
        const double ratio = jsNumber(l.value("ratio"_L1));
        leg.insert(u"ratio"_s, std::isnan(ratio) || ratio == 0 ? 1.0 : ratio);
        leg.insert(u"strike"_s, jsNumber(l.value("strike"_L1)));
        leg.insert(u"right"_s, right);
        legs.append(leg);
    }
    QJsonObject ticket;
    const auto put = [&](const QString& key, const QJsonValue& v) { if (!isUndef(v)) ticket.insert(key, v); };
    put(u"sec_type"_s, c.value("secType"_L1));
    ticket.insert(u"symbol"_s, c.value("symbol"_L1));
    ticket.insert(u"action"_s, o.value("action"_L1));
    ticket.insert(u"quantity"_s, jsNumber(o.value("totalQuantity"_L1)));
    put(u"order_type"_s, o.value("orderType"_L1));
    put(u"price_mode"_s, o.value("price_mode"_L1));
    ticket.insert(u"limit_price"_s, coalesce(o.value("lmtPrice"_L1), QJsonValue::Null));
    ticket.insert(u"aux_price"_s, coalesce(o.value("auxPrice"_L1), QJsonValue::Null));
    ticket.insert(u"trailing_percent"_s, coalesce(o.value("trailingPercent"_L1), QJsonValue::Null));
    put(u"tif"_s, o.value("tif"_L1));
    const QJsonValue firstLegExpiry = legsV.isArray() ? legsV.toArray().at(0).toObject().value("lastTradeDateOrContractMonth"_L1) : QJsonValue(QJsonValue::Undefined);
    ticket.insert(u"expiry"_s, coalesce(c.value("lastTradeDateOrContractMonth"_L1), coalesce(firstLegExpiry, QJsonValue::Null)));
    const QJsonValue strike = c.value("strike"_L1);
    ticket.insert(u"strike"_s, strike.isUndefined() || strike.isNull() ? QJsonValue(QJsonValue::Null) : QJsonValue(jsNumber(strike)));
    ticket.insert(u"right"_s, coalesce(c.value("right"_L1), QJsonValue::Null));
    ticket.insert(u"combo_strategy"_s, coalesce(c.value("combo_strategy"_L1), QJsonValue::Null));
    ticket.insert(u"legs"_s, legs);
    if (jsTruthy(t.value("symbol"_L1))) {
        QJsonObject trig{{u"symbol"_s, t.value("symbol"_L1)}};
        if (!isUndef(t.value("operator"_L1))) trig.insert(u"operator"_s, t.value("operator"_L1));
        if (!isUndef(t.value("value"_L1))) trig.insert(u"value"_s, t.value("value"_L1));
        ticket.insert(u"trigger"_s, trig);
    } else {
        ticket.insert(u"trigger"_s, QJsonValue::Null);
    }
    return ticket;
}

QJsonObject detailModel(const DetailInput& in) {
    if (in.state == u"loading") return {{u"state"_s, in.state}};
    if (in.state == u"gone") return {{u"state"_s, in.state}, {u"empty"_s, u"这条记录已经不在了"_s}};
    if (in.state != u"ok") return {{u"state"_s, u"error"_s}, {u"empty"_s, u"读取失败:"_s + in.error}};

    const QJsonObject record = in.record.toQJson().toObject();
    const auto obj = [&](const char* key) { return jsTruthy(record.value(QLatin1StringView(key))) ? record.value(QLatin1StringView(key)).toObject() : QJsonObject(); };
    const QJsonObject c = obj("contract"), o = obj("order"), ib = obj("ibkr"), llm = obj("llm"), input = obj("input"), account = obj("account");
    const QJsonValue ticket = ticketFromRecord(c, o, record.value("trigger"_L1));

    // 头:「NVDA · 买入 2」
    const QString act = jsString(coalesce(o.value("action"_L1), u""_s));
    const QString actText = actionLabelMap().contains(act) ? actionLabelMap().value(act) : orEmpty(o.value("action"_L1));
    const QString title = u"%1 · %2 %3"_s.arg(orEmpty(c.value("symbol"_L1)).isEmpty() ? u"—"_s : jsString(c.value("symbol"_L1)), actText,
                                              jsString(coalesce(o.value("totalQuantity"_L1), u""_s)));

    // 小节:空的行不画,空的小节整个不画
    QJsonArray sections;
    const auto section = [&](const QString& name, const QList<QPair<QString, QJsonValue>>& rows) {
        QJsonArray live;
        for (const auto& [k, v] : rows) {
            if (v.isUndefined() || v.isNull() || v == QJsonValue(u""_s)) continue;
            live.append(QJsonArray{k, jsString(v)});
        }
        if (!live.isEmpty()) sections.append(QJsonObject{{u"title"_s, name}, {u"rows"_s, live}});
    };
    const QJsonValue right = c.value("right"_L1);
    const QJsonValue legs = c.value("legs"_L1);
    const QJsonValue outsideRth = o.value("outsideRth"_L1);
    const auto money = [](const QJsonValue& v) { return v.isUndefined() || v.isNull() ? QJsonValue(QJsonValue::Null) : QJsonValue(fmtMoney(v)); };
    const QJsonValue usage = llm.value("usage"_L1);
    section(u"这笔单"_s, {{u"意图"_s, llm.value("intent_summary"_L1)},
                          {u"原指令"_s, input.value("raw_instruction"_L1)},
                          {u"理由"_s, input.value("reason"_L1)},
                          {u"账户"_s, jsTrim(u"%1 %2"_s.arg(orEmpty(account.value("alias"_L1)), orEmpty(account.value("account_masked"_L1))))},
                          {u"提交时间"_s, fmtTime(record.value("created_at"_L1), in.zone)}});
    const std::optional<QString> expiry = fmtExpiry(c.value("lastTradeDateOrContractMonth"_L1));
    section(u"合约"_s, {{u"类型"_s, say(secTypeLabel(), c.value("secType"_L1))},
                        {u"标的"_s, c.value("symbol"_L1)},
                        {u"到期日"_s, expiry ? QJsonValue(*expiry) : QJsonValue(QJsonValue::Null)},
                        {u"行权价"_s, c.value("strike"_L1)},
                        {u"方向"_s, right == QJsonValue(u"C"_s) ? QJsonValue(u"看涨 Call"_s) : right == QJsonValue(u"P"_s) ? QJsonValue(u"看跌 Put"_s) : QJsonValue::Null},
                        {u"组合"_s, say(comboLabel(), c.value("combo_strategy"_L1))},
                        {u"腿数"_s, legs.isArray() ? QJsonValue(legs.toArray().size()) : QJsonValue::Null}});
    section(u"订单"_s, {{u"买卖"_s, say(actionLabelMap(), o.value("action"_L1))},
                        {u"类型"_s, say(orderTypeLabel(), o.value("orderType"_L1))},
                        {u"数量"_s, o.value("totalQuantity"_L1)},
                        {u"限价"_s, o.value("lmtPrice"_L1)},
                        {u"触发价"_s, o.value("auxPrice"_L1)},
                        {u"定价方式"_s, say(priceModeLabel(), o.value("price_mode"_L1))},
                        {u"有效期"_s, say(tifLabel(), o.value("tif"_L1))},
                        {u"盘前盘后"_s, outsideRth.isUndefined() ? QJsonValue::Null : QJsonValue(jsTruthy(outsideRth) ? u"允许"_s : u"不允许"_s)},
                        {u"券商单号"_s, ib.value("order_id"_L1)}});
    section(u"成交"_s, {{u"均价"_s, money(ib.value("avg_fill_price"_L1))},
                        {u"手续费"_s, money(ib.value("total_commission"_L1))},
                        {u"已实现盈亏"_s, money(ib.value("realized_pnl"_L1))}});
    const QJsonObject u = usage.toObject();
    const auto tokens = [](const QJsonValue& v) { return v.isUndefined() || v.isNull() ? u"?"_s : jsString(v); };
    section(u"模型"_s, {{u"模型"_s, llm.value("model"_L1)},
                        {u"提示词版本"_s, llm.value("prompt_version"_L1)},
                        {u"置信度"_s, llm.value("confidence"_L1)},
                        {u"token"_s, jsTruthy(usage) ? QJsonValue(u"入 %1 / 出 %2"_s.arg(tokens(u.value("input_tokens"_L1)), tokens(u.value("output_tokens"_L1)))) : QJsonValue::Null}});

    QJsonArray timeline;
    for (const QJsonValue& sv : ib.value("status_timeline"_L1).toArray()) {
        const QJsonObject step = sv.toObject();
        const QString status = orEmpty(step.value("status"_L1));
        const QString label = orders::liveStatusLabel(status);
        timeline.append(QJsonObject{{u"label"_s, !label.isEmpty() ? label : !status.isEmpty() ? status : u"—"_s}, {u"at"_s, fmtTime(step.value("at"_L1), in.zone)}});
    }

    QJsonValue fills = QJsonValue::Null;
    const QJsonArray fillList = ib.value("fills"_L1).toArray();
    if (!fillList.isEmpty()) {
        QJsonArray rows;
        const auto dash = [](const QJsonValue& v, bool money) {
            if (v.isUndefined() || v.isNull()) return u"—"_s;
            return money ? fmtMoney(v) : jsString(v);
        };
        for (const QJsonValue& fv : fillList) {
            const QJsonObject f = fv.toObject();
            rows.append(QJsonObject{{u"key"_s, jsTruthy(f.value("exec_id"_L1)) ? jsString(f.value("exec_id"_L1)) : u"%1-%2"_s.arg(jsString(f.value("time"_L1)), jsString(f.value("price"_L1)))},
                                    {u"time"_s, orders::fmtTimeShort(f.value("time"_L1), in.nowMs, in.zone)},
                                    {u"qty"_s, dash(f.value("qty"_L1), false)},
                                    {u"price"_s, dash(f.value("price"_L1), true)},
                                    {u"commission"_s, dash(f.value("commission"_L1), true)}});
        }
        fills = QJsonObject{{u"title"_s, u"成交明细(%1 笔)"_s.arg(fillList.size())}, {u"rows"_s, rows}};
    }

    QJsonArray warnings;
    for (const QJsonValue& w : record.value("post_warnings"_L1).toArray()) warnings.append(orEmpty(w.toObject().value("message"_L1)));

    return {
        {u"state"_s, u"ok"_s},
        {u"id"_s, jsString(coalesce(record.value("id"_L1), u""_s))},
        {u"title"_s, title},
        {u"status"_s, orders::statusLabel(record, u"进行中"_s)},
        {u"statusTint"_s, orders::bucketTint(orders::statusBucket(record))},
        {u"review"_s, c.value("combo_strategy"_L1) == QJsonValue(u"BUTTERFLY"_s)},
        {u"ticket"_s, ticket.isObject() ? QJsonValue(trade::ticketModel(ticket.toObject())) : QJsonValue::Null},
        {u"stageCurrent"_s, orders::stageCurrent(record)},
        {u"errorDetail"_s, jsTruthy(record.value("error_detail"_L1)) ? jsString(record.value("error_detail"_L1)) : QString()},
        {u"sections"_s, sections},
        {u"timeline"_s, timeline},
        {u"fills"_s, fills},
        {u"warnings"_s, warnings},
        {u"raw"_s, stringifyOJson(in.record, 2)},
    };
}

QStringList pageTexts(const QJsonObject& p, const QJsonObject& d) {
    QStringList out{p.value("title"_L1).toString(), u"舒适"_s, u"紧凑"_s, u"导出"_s};
    if (p.value("mix"_L1).isObject())
        for (const QJsonValue& l : p.value("mix"_L1).toObject().value("legend"_L1).toArray())
            out << l.toObject().value("label"_L1).toString() << QString::number(l.toObject().value("count"_L1).toInt());
    for (const QJsonValue& f : p.value("filters"_L1).toArray())
        out << f.toObject().value("label"_L1).toString() << QString::number(f.toObject().value("count"_L1).toInt());
    if (!p.value("error"_L1).toString().isEmpty()) out << p.value("error"_L1).toString();
    for (const QJsonValue& c : p.value("columns"_L1).toArray()) out << c.toObject().value("title"_L1).toString();
    const QJsonArray rows = p.value("rows"_L1).toArray();
    if (rows.isEmpty()) out << p.value("empty"_L1).toString();
    for (const QJsonValue& rv : rows) {
        const QJsonObject r = rv.toObject();
        out << r.value("time"_L1).toString() << r.value("symbol"_L1).toString();
        if (r.value("side"_L1).isString()) out << r.value("side"_L1).toString();
        for (const char* k : {"intent", "reason"}) if (!r.value(QLatin1StringView(k)).toString().isEmpty()) out << r.value(QLatin1StringView(k)).toString();
        if (r.value("account"_L1).isString()) out << r.value("account"_L1).toString();
        if (!r.value("amount"_L1).toString().isEmpty()) out << r.value("amount"_L1).toString();
        out << r.value("status"_L1).toString();
    }
    if (d.isEmpty()) return out;
    if (d.value("state"_L1) != QJsonValue(u"ok"_s)) {
        if (d.value("empty"_L1).isString()) out << d.value("empty"_L1).toString();
        return out;
    }
    out << d.value("title"_L1).toString() << d.value("status"_L1).toString();
    if (d.value("review"_L1).toBool()) out << u"分析这笔交易"_s;
    out << u"收起"_s;
    if (d.value("ticket"_L1).isObject()) {
        trade::ticketTexts(d.value("ticket"_L1).toObject(), out);
        out << u"校验"_s << u"提交"_s << u"成交"_s;
    }
    if (!d.value("errorDetail"_L1).toString().isEmpty()) out << u"失败原因"_s << d.value("errorDetail"_L1).toString();
    for (const QJsonValue& sv : d.value("sections"_L1).toArray()) {
        out << sv.toObject().value("title"_L1).toString();
        for (const QJsonValue& row : sv.toObject().value("rows"_L1).toArray()) out << row[0].toString() << row[1].toString();
    }
    const QJsonArray timeline = d.value("timeline"_L1).toArray();
    if (!timeline.isEmpty()) {
        out << u"状态时间线"_s;
        for (const QJsonValue& t : timeline) out << t.toObject().value("label"_L1).toString() << t.toObject().value("at"_L1).toString();
    }
    if (d.value("fills"_L1).isObject()) {
        const QJsonObject f = d.value("fills"_L1).toObject();
        out << f.value("title"_L1).toString() << u"时间"_s << u"数量"_s << u"价格"_s << u"手续费"_s;
        for (const QJsonValue& rv : f.value("rows"_L1).toArray()) {
            const QJsonObject r = rv.toObject();
            out << r.value("time"_L1).toString() << r.value("qty"_L1).toString() << r.value("price"_L1).toString() << r.value("commission"_L1).toString();
        }
    }
    for (const QJsonValue& w : d.value("warnings"_L1).toArray()) {
        out << u"提醒"_s;
        if (!w.toString().isEmpty()) out << w.toString();
    }
    out << u"原始记录(JSON)"_s;
    return out;
}

}  // namespace ibkr::shell::records
