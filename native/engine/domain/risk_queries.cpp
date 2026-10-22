#include "domain/risk_queries.h"

#include "util/jsobj.h"
#include "util/jsvalue.h"

#include <QHash>

#include <cmath>

using namespace Qt::StringLiterals;
using ibkr::util::OJson;
namespace js = ibkr::util::js;

namespace ibkr::domain {

namespace {
/// parse():JSON 读得出来、而且是对象(或数组)才要
std::optional<OJson> parseObj(const OJson* text) {
    if (!js::isStr(text)) return std::nullopt;
    auto v = js::parse(text->s);
    if (!v || !js::isObjectLike(&*v)) return std::nullopt;
    return v;
}
const OJson* col(const OJson& row, const char16_t* name) { return row.get(QString::fromUtf16(name)); }
double dateParse(const OJson* v) { return util::jsDateParse(js::str(v)); }
}  // namespace

QList<OJson> RiskQueries::recentOrderDetails(double windowMinutes, double nowMs) {
    const double windowMs = windowMinutes * 60'000;
    const QList<OJson> rows = db_.prepare(
                                     u"SELECT signature, quantity, created_at, record_json,"
                                     " (SELECT f.payload FROM record_events f WHERE f.record_id = t.id AND f.kind = 'final'"
                                     "   ORDER BY f.seq DESC LIMIT 1) AS final"
                                     " FROM trade_records t"
                                     " WHERE signature != ''"
                                     " AND EXISTS ("
                                     "   SELECT 1 FROM record_events e"
                                     "   WHERE e.record_id = t.id AND (e.kind = 'submit_intent'"
                                     "     OR (e.kind = 'status' AND e.payload NOT LIKE '%ValidatedOnly%'))"
                                     " )"
                                     " ORDER BY rowid DESC LIMIT 1000"_s)
                                  .all();
    QList<OJson> out;
    for (const OJson& row : rows) {
        // Date.parse:带偏移的 ISO 直接换算;naive 字符串按本机时区解释
        const double created = dateParse(col(row, u"created_at"));
        if (std::isnan(created)) continue;
        const double delta = nowMs - created;
        if (delta > windowMs || delta < -windowMs) continue;
        const auto record = parseObj(col(row, u"record_json"));
        const OJson* order = record ? js::prop(&*record, u"order"_s) : nullptr;
        const OJson* lmt = js::prop(js::nullish(order) ? nullptr : order, u"lmtPrice"_s);
        const double limit = js::num(lmt);
        const OJson* final = col(row, u"final");
        OJson finalStatus = OJson::null();
        if (!js::nullish(final)) {
            const auto f = parseObj(final);
            finalStatus = js::S(js::strOr(f ? js::prop(&*f, u"final_status"_s) : nullptr, QString()));
        }
        out << js::object({{u"signature"_s, js::copyOrNull(col(row, u"signature"))},
                           {u"quantity"_s, js::copyOrNull(col(row, u"quantity"))},
                           {u"createdAtMs"_s, js::N(created)},
                           {u"limitPrice"_s, js::nullish(lmt) || !std::isfinite(limit) ? js::Null() : js::N(limit)},
                           {u"finalStatus"_s, finalStatus}});
    }
    return out;
}

QList<OJson> RiskQueries::workingOrders(double sinceMs, double nowMs) {
    const QList<OJson> rows = db_.prepare(
                                     u"SELECT created_at, record_json FROM trade_records t"
                                     " WHERE signature != ''"
                                     " AND NOT EXISTS (SELECT 1 FROM record_events f WHERE f.record_id = t.id AND f.kind = 'final')"
                                     " AND EXISTS ("
                                     "   SELECT 1 FROM record_events e"
                                     "   WHERE e.record_id = t.id AND (e.kind = 'submit_intent'"
                                     "     OR (e.kind = 'status' AND e.payload NOT LIKE '%ValidatedOnly%'))"
                                     " )"
                                     " ORDER BY rowid DESC LIMIT 1000"_s)
                                  .all();
    QList<OJson> out;
    for (const OJson& row : rows) {
        const double created = dateParse(col(row, u"created_at"));
        if (std::isnan(created) || created < sinceMs || created > nowMs) continue;
        const auto record = parseObj(col(row, u"record_json"));
        const OJson* rec = record ? &*record : nullptr;
        const OJson* account = js::prop(rec, u"account"_s);
        const QString alias = js::strOr(js::prop(js::nullish(account) ? nullptr : account, u"alias"_s), QString());
        const OJson* contract = js::prop(rec, u"contract"_s);
        const OJson* order = js::prop(rec, u"order"_s);
        if (alias.isEmpty() || !js::isObjectLike(contract) || !js::isObjectLike(order)) continue;
        const double notional = js::num(js::prop(rec, u"notional_estimate"_s));
        out << js::object({{u"alias"_s, js::S(alias)}, {u"contract"_s, *contract}, {u"order"_s, *order}, {u"notional"_s, js::N(std::isfinite(notional) ? notional : 0)}});
    }
    return out;
}

QList<OJson> RiskQueries::dailyLossTrips(double sinceMs, double nowMs) {
    const QList<OJson> rows =
        db_.prepare(u"SELECT at, detail FROM audit_log WHERE actor='engine' AND action='daily_loss_trip' ORDER BY seq DESC LIMIT 200"_s).all();
    QList<OJson> out;
    for (const OJson& row : rows) {
        const double at = dateParse(col(row, u"at"));
        if (std::isnan(at) || at < sinceMs || at > nowMs) continue;
        const auto detail = parseObj(col(row, u"detail"));
        const OJson* d = detail ? &*detail : nullptr;
        const QString alias = js::strOr(js::prop(d, u"alias"_s), QString());
        const double untilMs = js::num(js::prop(d, u"until_ms"_s));
        if (!alias.isEmpty() && std::isfinite(untilMs))
            out << js::object({{u"alias"_s, js::S(alias)}, {u"reason"_s, js::S(js::strOr(js::prop(d, u"reason"_s), QString()))}, {u"untilMs"_s, js::N(untilMs)}});
    }
    return out;
}

QList<OJson> RiskQueries::recentOrders(double windowMinutes, double nowMs) {
    QList<OJson> out;
    for (const OJson& d : recentOrderDetails(windowMinutes, nowMs))
        out << js::object({{u"signature"_s, *d.get(u"signature"_s)}, {u"quantity"_s, *d.get(u"quantity"_s)}, {u"createdAtMs"_s, *d.get(u"createdAtMs"_s)}});
    return out;
}

QList<OJson> RiskQueries::recentCloses(double sinceMs, double nowMs) {
    const QList<OJson> rows = db_.prepare(
                                     u"SELECT at, detail FROM audit_log"
                                     " WHERE actor='engine' AND action IN ('auto_close','hosted_sweep','hosted_fill')"
                                     " ORDER BY seq DESC LIMIT 2000"_s)
                                  .all();
    QList<OJson> out;
    for (const OJson& row : rows) {
        const double at = dateParse(col(row, u"at"));
        if (std::isnan(at) || at <= sinceMs || at > nowMs) continue;
        const auto detail = parseObj(col(row, u"detail"));
        if (!detail) continue;
        const OJson* d = &*detail;
        out << js::object({{u"atMs"_s, js::N(at)},
                           {u"symbol"_s, js::S(js::strOr(js::prop(d, u"symbol"_s), QString()))},
                           {u"state"_s, js::S(js::strOr(js::prop(d, u"state"_s), QString()))},
                           {u"leg"_s, js::S(js::strOr(js::prop(d, u"leg"_s), QString()))}});
    }
    return out;
}

QList<OJson> RiskQueries::realizedPnlEvents(double sinceMs, double nowMs) {
    const QList<OJson> rows = db_.prepare(u"SELECT at, payload FROM record_events WHERE kind='commission' ORDER BY seq DESC LIMIT 2000"_s).all();
    QList<std::pair<double, double>> anonymous;
    // 行是新的在前:同一 exec_id 后读到的更早,覆盖下来,留下的就是先到的那条(Map 覆盖时位置不变)
    QStringList order;
    QHash<QString, std::pair<double, double>> firstByExec;
    for (const OJson& row : rows) {
        const double at = dateParse(col(row, u"at"));
        if (std::isnan(at)) continue;
        const auto payload = parseObj(col(row, u"payload"));
        if (!payload) continue;
        const std::pair<double, double> item{at, js::num(js::prop(&*payload, u"realized_pnl"_s))};
        const QString execId = js::strOr(js::prop(&*payload, u"exec_id"_s), QString());
        if (!execId.isEmpty()) {
            if (!firstByExec.contains(execId)) order << execId;
            firstByExec.insert(execId, item);
        } else {
            anonymous << item;
        }
    }
    QList<std::pair<double, double>> all = anonymous;
    for (const QString& k : order) all << firstByExec.value(k);
    QList<OJson> out;
    // IBKR 对开仓的佣金回报给一个哨兵大数(1.7976931348623157e308),不是真盈亏
    for (const auto& [atMs, pnl] : all)
        if (atMs > sinceMs && atMs <= nowMs && std::isfinite(pnl) && std::abs(pnl) < 1e307) out << js::object({{u"atMs"_s, js::N(atMs)}, {u"pnl"_s, js::N(pnl)}});
    return out;
}

}  // namespace ibkr::domain
