#include "shell/order_rules.h"

#include "shell/jsvalue.h"
#include "shell/track_rules.h"

#include <QDateTime>
#include <QHash>

namespace ibkr::shell::orders {

using namespace Qt::StringLiterals;

namespace {

QString str(const QJsonValue& v) { return v.isNull() || v.isUndefined() ? QString() : jsString(v); }

const QHash<QString, QString>& finalLabel() {
    static const QHash<QString, QString> m{
        {u"filled"_s, u"已成交"_s}, {u"partially_filled"_s, u"部分成交"_s}, {u"cancelled"_s, u"已撤单"_s}, {u"expired_untriggered"_s, u"当日未触发"_s},
        {u"rejected_by_validator"_s, u"校验拒绝"_s}, {u"rejected_by_llm"_s, u"模型拒绝"_s}, {u"ibkr_error"_s, u"券商报错"_s}, {u"halted_by_breaker"_s, u"熔断拦下"_s},
    };
    return m;
}
const QHash<QString, QString>& liveLabel() {
    static const QHash<QString, QString> m{
        {u"ValidatedOnly"_s, u"仅校验未发送"_s}, {u"PendingSubmit"_s, u"待发送"_s}, {u"PreSubmitted"_s, u"已受理"_s}, {u"Submitted"_s, u"已挂单"_s},
        {u"ApiPending"_s, u"发送中"_s}, {u"PendingCancel"_s, u"撤单中"_s}, {u"Filled"_s, u"已成交"_s}, {u"Cancelled"_s, u"已撤单"_s}, {u"ApiCancelled"_s, u"已撤单"_s},
        {u"Inactive"_s, u"券商报错"_s}, {u"Unknown"_s, u"状态未知"_s}, {u"NotAtBroker"_s, u"去向不明(券商侧查无此单)"_s},
    };
    return m;
}

}  // namespace

QString statusBucket(const QJsonObject& r) {
    const QString f = str(r.value("final_status"_L1));
    if (f == u"filled") return u"filled"_s;
    if (f == u"halted_by_breaker") return u"halted"_s;
    if (f.startsWith(u"rejected") || f == u"ibkr_error") return u"failed"_s;
    if (f == u"cancelled" || f == u"expired_untriggered") return u"closed"_s;
    if (f == u"partially_filled") return u"working"_s;
    const QString s = str(r.value("status"_L1));
    // 通过校验却没发出去的单不是"在途";对账查不到的单也不是
    if (s == u"ValidatedOnly") return u"draft"_s;
    if (s == u"NotAtBroker") return u"stale"_s;
    if (s == u"Filled") return u"filled"_s;
    if (s == u"Inactive") return u"failed"_s;
    if (s == u"Cancelled" || s == u"ApiCancelled") return u"closed"_s;
    return u"working"_s;
}

QString bucketTint(const QString& b) {
    static const QHash<QString, QString> m{{u"filled"_s, u"green"_s}, {u"working"_s, u"blue"_s}, {u"failed"_s, u"red"_s}, {u"closed"_s, u"gray"_s},
                                           {u"halted"_s, u"orange"_s}, {u"draft"_s, u"gray"_s}, {u"stale"_s, u"yellow"_s}};
    return m.value(b);
}

QString bucketLabel(const QString& b) {
    static const QHash<QString, QString> m{{u"filled"_s, u"已成交"_s}, {u"working"_s, u"进行中"_s}, {u"failed"_s, u"被拒 / 出错"_s}, {u"closed"_s, u"已撤 / 未触发"_s},
                                           {u"halted"_s, u"熔断拦下"_s}, {u"draft"_s, u"仅校验未发送"_s}, {u"stale"_s, u"去向不明"_s}};
    return m.value(b);
}

QString statusLabel(const QJsonObject& r, const QString& fallback) {
    // record.final_status 为真(非空串)才算有终态
    const QJsonValue f = r.value("final_status"_L1);
    if (jsTruthy(f)) return finalLabel().value(jsString(f), jsString(f));
    const QJsonValue s = r.value("status"_L1);
    if (jsTruthy(s)) return liveLabel().value(jsString(s), jsString(s));
    return fallback;
}

int stageCurrent(const QJsonObject& r) {
    const QString bucket = statusBucket(r);
    const QString f = str(r.value("final_status"_L1));
    // 被校验 / 模型拒的停在第 0 步;券商报错、熔断停在提交;在途的停在成交之前;对账查不到的也停在「提交」
    if (bucket == u"filled") return 3;
    if (f.startsWith(u"rejected")) return 0;
    if (bucket == u"draft") return 1;
    if ((bucket == u"working" || bucket == u"stale") && jsTruthy(r.value("status"_L1))) return 2;
    return 1;
}

QString triggerOpLabel(const QJsonValue& op) {
    static const QHash<QString, QString> m{{u">="_s, u"≥"_s}, {u"<="_s, u"≤"_s}, {u">"_s, u">"_s}, {u"<"_s, u"<"_s}, {u"=="_s, u"="_s}};
    // TRIGGER_OP_LABEL[item.operator || ''] || item.operator:查不到照原样(null 不画)
    const QString key = jsTruthy(op) ? jsString(op) : QString();
    const auto it = m.constFind(key);
    return it != m.cend() ? *it : str(op);
}

QString liveStatusLabel(const QString& status) { return liveLabel().value(status); }

QString actionLabel(const QJsonValue& a) {
    static const QHash<QString, QString> m{{u"BUY"_s, u"买入"_s}, {u"SELL"_s, u"卖出"_s}};
    return m.value(jsString(a), jsString(a));
}

QString fmtTimeShort(const QJsonValue& iso, double nowMs, const QTimeZone& zone) {
    if (!jsTruthy(iso)) return u"—"_s;
    const QString text = jsString(iso);
    // dayjs(String(iso)):ISO 带时区按它,不带的按本机;读不出来照原样
    QDateTime d = QDateTime::fromString(text, Qt::ISODateWithMs);
    if (!d.isValid()) d = QDateTime::fromString(text, Qt::ISODate);
    if (!d.isValid()) return text;
    if (d.timeSpec() == Qt::LocalTime) d.setTimeZone(zone);
    const QDateTime local = d.toTimeZone(zone);
    const QDate today = QDateTime::fromMSecsSinceEpoch(qint64(nowMs), zone).date();
    return local.date() == today ? local.toString(u"HH:mm"_s) : local.toString(u"MM-dd HH:mm"_s);
}

QJsonObject boardModel(const BoardInput& in) {
    // 已提交 / 近期:有在途状态、没被拒的,最多 8 张
    QJsonArray live;
    for (const QJsonValue& v : in.records) {
        const QJsonObject r = v.toObject();
        if (jsTruthy(r.value("status"_L1)) && !jsTruthy(r.value("rejection"_L1))) live.append(r);
        if (live.size() == 8) break;
    }
    int working = 0, filled = 0, failed = 0;
    for (const QJsonValue& v : live) {
        const QString b = statusBucket(v.toObject());
        if (b == u"working") ++working;
        if (b == u"filled") ++filled;
    }
    for (const QJsonValue& v : in.records)
        if (statusBucket(v.toObject()) == u"failed") ++failed;

    QJsonObject pending{{u"count"_s, in.pending.size()}};
    if (jsTruthy(in.pendingError)) {
        pending.insert(u"empty"_s, u"读取失败:"_s + jsString(in.pendingError));
    } else if (in.pending.isEmpty()) {
        pending.insert(u"empty"_s, u"没有等待触发的条件单。"_s);
    } else {
        QJsonArray cards;
        for (const QJsonValue& v : in.pending) {
            const QJsonObject p = v.toObject();
            cards.append(QJsonObject{
                {u"key"_s, jsString(p.value("record_id"_L1))},
                {u"badge"_s, (jsTruthy(p.value("symbol"_L1)) ? jsString(p.value("symbol"_L1)) : QString()).left(5)},
                {u"title"_s, str(p.value("intent_summary"_L1))},
                {u"meta"_s, QJsonArray{u"账户 "_s + jsString(p.value("account"_L1)), u"入队 "_s + fmtTimeShort(p.value("created_at"_L1), in.nowMs, in.localZone)}},
                {u"triggerSymbol"_s, str(p.value("symbol"_L1))},
                {u"triggerOp"_s, triggerOpLabel(p.value("operator"_L1))},
                {u"triggerValue"_s, str(p.value("value"_L1))},
            });
        }
        pending.insert(u"cards"_s, cards);
    }
    QJsonObject recent{{u"count"_s, live.size()}};
    if (jsTruthy(in.recordsError)) {
        recent.insert(u"empty"_s, u"读取失败:"_s + jsString(in.recordsError));
    } else if (live.isEmpty()) {
        recent.insert(u"empty"_s, u"今天还没有提交过订单。"_s);
    } else {
        QJsonArray cards;
        for (const QJsonValue& v : live) {
            const QJsonObject r = v.toObject();
            const QString bucket = statusBucket(r);
            QJsonArray meta{u"%1 %2"_s.arg(str(r.value("quantity"_L1)), jsString(r.value("symbol"_L1))), u"账户 "_s + jsString(r.value("account"_L1))};
            QJsonValue strong;
            if (jsTruthy(r.value("avg_fill_price"_L1))) strong = u"均价 "_s + track::fmtMoney(r.value("avg_fill_price"_L1));
            const QJsonValue action = r.value("action"_L1);
            const QJsonValue summary = r.value("intent_summary"_L1);
            cards.append(QJsonObject{
                {u"key"_s, jsString(r.value("id"_L1))},
                {u"badge"_s, (jsTruthy(r.value("symbol"_L1)) ? jsString(r.value("symbol"_L1)) : QString()).left(5)},
                {u"badgeTint"_s, action == QJsonValue(u"SELL"_s) ? u"down"_s : u"up"_s},
                {u"title"_s, jsTruthy(summary) ? jsString(summary) : str(r.value("raw_instruction"_L1))},
                {u"meta"_s, meta},
                {u"strong"_s, strong},
                {u"side"_s, jsTruthy(action) ? QJsonValue(QJsonObject{{u"buy"_s, action == QJsonValue(u"BUY"_s)}, {u"text"_s, actionLabel(action)}}) : QJsonValue()},
                {u"stageCurrent"_s, stageCurrent(r)},
                {u"tint"_s, bucketTint(bucket)},
                {u"status"_s, statusLabel(r, u"—"_s)},
            });
        }
        recent.insert(u"cards"_s, cards);
    }
    return {
        {u"widgets"_s, QJsonArray{
                           QJsonObject{{u"icon"_s, u"sf-hourglass"_s}, {u"tint"_s, u"orange"_s}, {u"value"_s, in.pending.size()}, {u"label"_s, u"排队等待触发"_s}},
                           QJsonObject{{u"icon"_s, u"sf-paperplane"_s}, {u"tint"_s, u"blue"_s}, {u"value"_s, working}, {u"label"_s, u"在途"_s}},
                           QJsonObject{{u"icon"_s, u"sf-check"_s}, {u"tint"_s, u"green"_s}, {u"value"_s, filled}, {u"label"_s, u"已成交"_s}},
                           QJsonObject{{u"icon"_s, u"sf-xmark"_s}, {u"tint"_s, u"red"_s}, {u"value"_s, failed}, {u"label"_s, u"被拒 / 出错"_s}},
                       }},
        {u"pending"_s, pending},
        {u"live"_s, recent},
        {u"feed"_s, QJsonObject{{u"items"_s, in.feed}, {u"empty"_s, u"暂无通知"_s}}},
    };
}

QStringList boardTexts(const QJsonObject& m) {
    QStringList out{u"订单看板"_s, u"刷新"_s};
    for (const QJsonValue& w : m.value("widgets"_L1).toArray()) out << jsNumberToString(w[u"value"].toDouble()) << w[u"label"].toString();
    const QJsonObject p = m.value("pending"_L1).toObject();
    out << u"排队等待触发"_s << jsNumberToString(p.value("count"_L1).toDouble());
    if (p.value("empty"_L1).isString()) out << p.value("empty"_L1).toString();
    for (const QJsonValue& cv : p.value("cards"_L1).toArray()) {
        const QJsonObject c = cv.toObject();
        if (!c.value("badge"_L1).toString().isEmpty()) out << c.value("badge"_L1).toString();
        if (!c.value("title"_L1).toString().isEmpty()) out << c.value("title"_L1).toString();
        for (const QJsonValue& x : c.value("meta"_L1).toArray()) out << x.toString();
        // 「SPY ≥ <b>775</b>」:前半是一段字,数是另一段
        out << u"%1 %2 "_s.arg(c.value("triggerSymbol"_L1).toString(), c.value("triggerOp"_L1).toString());
        if (!c.value("triggerValue"_L1).toString().isEmpty()) out << c.value("triggerValue"_L1).toString();
        out << u"排队"_s << u"触发"_s << u"提交"_s << u"成交"_s;
    }
    const QJsonObject l = m.value("live"_L1).toObject();
    out << u"已提交 / 近期"_s << jsNumberToString(l.value("count"_L1).toDouble());
    if (l.value("empty"_L1).isString()) out << l.value("empty"_L1).toString();
    for (const QJsonValue& cv : l.value("cards"_L1).toArray()) {
        const QJsonObject c = cv.toObject();
        if (!c.value("badge"_L1).toString().isEmpty()) out << c.value("badge"_L1).toString();
        if (!c.value("title"_L1).toString().isEmpty()) out << c.value("title"_L1).toString();
        for (const QJsonValue& x : c.value("meta"_L1).toArray()) out << x.toString();
        if (c.value("strong"_L1).isString()) out << c.value("strong"_L1).toString();
        if (c.value("side"_L1).isObject()) out << c.value("side"_L1)[u"text"].toString();
        out << u"校验"_s << u"提交"_s << u"成交"_s << c.value("status"_L1).toString();
    }
    out << u"通知"_s;
    const QJsonArray feed = m.value("feed"_L1).toObject().value("items"_L1).toArray();
    if (feed.isEmpty()) out << u"暂无通知"_s;
    for (const QJsonValue& f : feed) out << f[u"at"].toString() << f[u"text"].toString();
    return out;
}

}  // namespace ibkr::shell::orders
