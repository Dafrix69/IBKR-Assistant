#include "util/earnings.h"
#include "util/market_calendar.h"
#include <QMap>
#include <QSet>
#include <cmath>
#include <functional>
using namespace Qt::StringLiterals;
namespace ibkr::util {
QJsonObject earningsView(const QJsonValue& raw, const QJsonArray& bars, QDate today) {
    QJsonArray records;
    std::function<void(const QJsonValue&)> visit = [&](const QJsonValue& v) {
        if (v.isArray()) { for (const auto& x : v.toArray()) visit(x); return; }
        if (!v.isObject()) return;
        const auto o = v.toObject();
        if (o["event_type"].toString() == "wshe_ed") {
            const auto data = o["data"];
            if (data.isArray()) for (const auto& x : data.toArray()) records.append(x);
            else if (data.isObject()) records.append(data);
            return;
        }
        for (const auto& x : o) if (x.isArray() || x.isObject()) visit(x);
    };
    visit(raw);
    QMap<QDate, QJsonObject> prices;
    for (const auto& v : bars) {
        const auto b = v.toObject(); const auto d = QDate::fromString(b["date"].toString().left(10), Qt::ISODate);
        if (d.isValid() && d < today) prices[d] = b; // exclude incomplete current session
    }
    auto trading = [](QDate d) { return d.dayOfWeek() <= 5 && !builtinCalendar().holidays.contains(d.toString(Qt::ISODate)); };
    auto next = [&](QDate d, int dir) { do { d = d.addDays(dir); } while (!trading(d)); return d; };
    auto pct = [](QJsonValue x, QJsonValue base) -> QJsonValue {
        const double a = x.toDouble(NAN), b = base.toDouble(NAN);
        return std::isfinite(a) && std::isfinite(b) && a > 0 && b > 0 ? QJsonValue((a/b-1)*100) : QJsonValue();
    };
    QMap<QString, QJsonObject> sorted;
    for (const auto& v : records) {
        const auto d = v.toObject(); const QString date = d["earnings_date"].toString().left(10);
        const QDate day = QDate::fromString(date, Qt::ISODate);
        if (!day.isValid()) continue;
        const QString timing = d["time_of_day"].toString(), status = d["wshe_earnings_date_status"].toString();
        QJsonObject row{{"date",date},{"days_until",int(today.daysTo(day))},{"timing",timing},{"status",status},{"quarter",d["quarter"]},
            {"gap",QJsonValue()},{"day1",QJsonValue()},{"day5",QJsonValue()}};
        QString missing;
        if (status != "CONFIRMED") missing = u"日期未确认，不计算历史反应"_s;
        else if (timing != "BEFORE MARKET" && timing != "AFTER MARKET") missing = u"发布时间未知或盘中，无法以日线隔离财报反应"_s;
        else if (day >= today) missing = u"等待财报后的完整交易日"_s;
        else {
            QDate first = timing == "AFTER MARKET" ? next(day,1) : day;
            if (!trading(first)) first = next(first,1);
            const QDate base = next(first,-1);
            QDate fifth = first; for (int i=1;i<5;++i) fifth=next(fifth,1);
            row["session"] = first.toString(Qt::ISODate);
            row["gap"] = pct(prices.value(first)["open"], prices.value(base)["close"]);
            row["day1"] = pct(prices.value(first)["close"], prices.value(base)["close"]);
            bool complete = true; for (QDate t=first;t<=fifth;t=next(t,1)) complete &= prices.contains(t);
            if (complete) row["day5"] = pct(prices.value(fifth)["close"], prices.value(base)["close"]);
            if (row["gap"].isNull() || row["day1"].isNull() || row["day5"].isNull()) missing = u"缺少对应完整交易日行情，缺项显示 —"_s;
        }
        row["missing"] = missing;
        sorted[date + timing + d["quarter"].toString()] = row;
    }
    QJsonArray history; QJsonValue upcoming;
    for (const auto& row : sorted) {
        const auto day=QDate::fromString(row["date"].toString(),Qt::ISODate);
        if (day>=today && upcoming.isNull()) upcoming=row;
    }
    for (auto it=sorted.cend();it!=sorted.cbegin();) {
        --it;
        if (QDate::fromString(it.value()["date"].toString(),Qt::ISODate)<today) history.append(it.value());
    }
    return {{"upcoming",upcoming},{"history",history},{"status",records.isEmpty()?"missing":"available"},
        {"message",records.isEmpty()?u"IBKR WSH 未返回财报日期；不代表没有财报"_s:QString()},
        {"basis",u"美东日期；相对财报前一交易日收盘。仅完整日线；未校正同期市场、拆股及分红影响。历史记录以 IBKR 实际返回为限。"_s}};
}
}
