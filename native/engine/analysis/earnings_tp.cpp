#include "analysis/earnings_tp.h"

#include <QDate>
#include <QDateTime>
#include <QTimeZone>

#include <cmath>

using namespace Qt::StringLiterals;

namespace ibkr::analysis::etp {

namespace {
QString iso(const QDate& d) { return d.toString(Qt::ISODate); }

std::optional<QDate> step(QDate d, int dir, const Calendar& cal) {
    // 日历里连着 30 天没有交易日 = 日历坏了,不死循环
    for (int i = 0; i < 30; ++i) {
        d = d.addDays(dir);
        if (cal.tradingDay(iso(d))) return d;
    }
    return std::nullopt;
}

double closeMs(const QDate& d, const Calendar& cal) {
    const QTime t = cal.earlyClose && cal.earlyClose(iso(d)) ? QTime(13, 0) : QTime(16, 0);
    return double(QDateTime(d, t, QTimeZone("America/New_York")).toMSecsSinceEpoch());
}
}  // namespace

Planned planWindow(const QString& date, const QString& timing, const Calendar& cal) {
    const QDate day = QDate::fromString(date.left(10), Qt::ISODate);
    if (!day.isValid()) return {std::nullopt, u"财报日期「%1」不是合法日期(要 YYYY-MM-DD)。"_s.arg(date)};
    if (timing != kAfter && timing != kBefore)
        return {std::nullopt, u"财报发布时段要是盘前或盘后:盘中发布或时段未知的,分不出哪一个收盘价是「财报前收盘」。"_s};
    if (!cal.tradingDay(iso(day))) return {std::nullopt, u"财报日 %1 不是交易日。"_s.arg(iso(day))};
    const std::optional<QDate> other = step(day, timing == kAfter ? 1 : -1, cal);
    if (!other) return {std::nullopt, u"交易日历里找不到 %1 前后的交易日。"_s.arg(iso(day))};
    Window w;
    w.date = iso(day);
    w.timing = timing;
    const QDate ref = timing == kAfter ? day : *other;
    const QDate react = timing == kAfter ? *other : day;
    w.refDate = iso(ref);
    w.reactDate = iso(react);
    w.startMs = closeMs(ref, cal);
    w.endMs = closeMs(react, cal);
    return {w, QString()};
}

QString stockSession(const QString& base, const QString& etDate, double etSeconds, const Calendar& cal) {
    if (base != u"休市") return base;
    const QDate day = QDate::fromString(etDate, Qt::ISODate);
    if (!day.isValid()) return base;
    // 夜盘 20:00 开、03:50 收,归到它后面那个交易日
    std::optional<QDate> owner;
    if (etSeconds >= 20 * 3600) owner = day.addDays(1);
    else if (etSeconds < 3 * 3600 + 50 * 60) owner = day;
    return owner && cal.tradingDay(iso(*owner)) ? kOvernight : base;
}

std::optional<double> targetPrice(bool isLong, double refClose, double pct) {
    if (!(std::isfinite(refClose) && refClose > 0) || !(std::isfinite(pct) && pct > 0)) return std::nullopt;
    const double t = refClose * (1 + (isLong ? pct : -pct) / 100.0);
    return t > 0 ? std::optional<double>(t) : std::nullopt;
}

std::optional<double> executable(bool isLong, std::optional<double> bid, std::optional<double> ask) {
    const auto ok = [](const std::optional<double>& v) { return v && std::isfinite(*v) && *v > 0; };
    if (!ok(bid) || !ok(ask) || *bid > *ask) return std::nullopt;
    return isLong ? bid : ask;
}

bool reached(bool isLong, double target, double exec) { return isLong ? exec >= target : exec <= target; }

std::optional<QString> pctIssue(double pct) {
    if (!std::isfinite(pct) || !(pct > 0 && pct <= 500)) return u"财报止盈的涨幅要在 0(不含)到 500 之间(百分比)。"_s;
    return std::nullopt;
}

QString timingLabel(const QString& timing) { return timing == kAfter ? u"盘后"_s : timing == kBefore ? u"盘前"_s : u"时段未知"_s; }

}  // namespace ibkr::analysis::etp
