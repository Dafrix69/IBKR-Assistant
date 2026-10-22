#include "util/market_calendar.h"

#include <QDate>
#include <QSet>

#include <optional>

namespace ibkr::util {

using namespace Qt::StringLiterals;

namespace {

QString iso(int y, int m, int d) { return QDate(y, m, d).toString(u"yyyy-MM-dd"_s); }
/// 0 = 周日 … 6 = 周六(同 getUTCDay)
int weekday(int y, int m, int d) { return QDate(y, m, d).dayOfWeek() % 7; }
QString shift(const QString& date, int days) { return QDate::fromString(date, u"yyyy-MM-dd"_s).addDays(days).toString(u"yyyy-MM-dd"_s); }

QString nthWeekday(int year, int month, int dow, int n) {
    const int first = weekday(year, month, 1);
    return iso(year, month, 1 + ((dow - first + 7) % 7) + (n - 1) * 7);
}

QString lastWeekday(int year, int month, int dow) {
    const int lastDay = QDate(year, month, 1).daysInMonth();
    const int last = weekday(year, month, lastDay);
    return iso(year, month, lastDay - ((last - dow + 7) % 7));
}

std::optional<QString> observed(int year, int month, int day, bool saturdayShifts = true) {
    const int dow = weekday(year, month, day);
    const QString date = iso(year, month, day);
    if (dow == 6) return saturdayShifts ? std::optional<QString>(shift(date, -1)) : std::nullopt;
    if (dow == 0) return shift(date, 1);
    return date;
}

const QStringList kSpecialClosures{u"2001-09-11"_s, u"2001-09-12"_s, u"2001-09-13"_s, u"2001-09-14"_s,  // 9·11
                                   u"2004-06-11"_s,  // 里根国葬
                                   u"2007-01-02"_s,  // 福特国葬
                                   u"2012-10-29"_s, u"2012-10-30"_s,  // 飓风桑迪
                                   u"2018-12-05"_s,  // 老布什国葬
                                   u"2025-01-09"_s};  // 卡特国葬
constexpr int kJuneteenthSince = 2022;

QStringList uniqueSorted(const QStringList& in) {
    QStringList out;
    QSet<QString> seen;
    for (const QString& s : in)
        if (!seen.contains(s)) {
            seen.insert(s);
            out << s;
        }
    out.sort();  // 按 UTF-16 码元,同 JS 默认的 sort
    return out;
}

}  // namespace

QString easterSunday(int year) {
    const int a = year % 19, b = year / 100, c = year % 100, d = b / 4, e = b % 4, f = (b + 8) / 25, g = (b - f + 1) / 3;
    const int h = (19 * a + b - d - g + 15) % 30;
    const int i = c / 4, k = c % 4;
    const int l = (32 + 2 * e + 2 * i - h - k) % 7;
    const int m = (a + 11 * h + 22 * l) / 451;
    const int month = (h + l - 7 * m + 114) / 31;
    const int day = ((h + l - 7 * m + 114) % 31) + 1;
    return iso(year, month, day);
}

QStringList nyseHolidays(int year) {
    const std::optional<QString> list[] = {
        observed(year, 1, 1, false),  // 元旦:周六不补休
        nthWeekday(year, 1, 1, 3),  // 马丁·路德·金日
        nthWeekday(year, 2, 1, 3),  // 华盛顿诞辰
        shift(easterSunday(year), -2),  // 耶稣受难日
        lastWeekday(year, 5, 1),  // 阵亡将士纪念日
        year >= kJuneteenthSince ? observed(year, 6, 19) : std::nullopt,  // 六月节
        observed(year, 7, 4),  // 独立日
        nthWeekday(year, 9, 1, 1),  // 劳动节
        nthWeekday(year, 11, 4, 4),  // 感恩节
        observed(year, 12, 25),  // 圣诞节
    };
    QStringList dates;
    for (const auto& d : list)
        if (d) dates << *d;
    const QString prefix = QString::number(year) + u'-';
    for (const QString& d : kSpecialClosures)
        if (d.startsWith(prefix)) dates << d;
    return uniqueSorted(dates);
}

QStringList nyseEarlyCloses(int year) {
    const QStringList holidayList = nyseHolidays(year);
    const QSet<QString> holidays(holidayList.begin(), holidayList.end());
    const auto open = [&holidays](const QString& date) {
        const int dow = QDate::fromString(date, u"yyyy-MM-dd"_s).dayOfWeek() % 7;
        return dow != 0 && dow != 6 && !holidays.contains(date);
    };
    QStringList out;
    const QString july3 = iso(year, 7, 3);
    const int july3Dow = weekday(year, 7, 3);
    if (july3Dow >= 1 && july3Dow <= 4 && open(july3)) out << july3;
    const QString blackFriday = shift(nthWeekday(year, 11, 4, 4), 1);
    if (open(blackFriday)) out << blackFriday;
    const QString eve = iso(year, 12, 24);
    if (open(eve)) out << eve;
    out.sort();
    return out;
}

const BuiltinCalendar& builtinCalendar() {
    static const BuiltinCalendar cal = [] {
        BuiltinCalendar c;
        for (int y = kCalendarFirstYear; y <= kCalendarLastYear; ++y) {
            c.holidays << nyseHolidays(y);
            c.earlyCloses << nyseEarlyCloses(y);
        }
        return c;
    }();
    return cal;
}

QStringList mergeCalendar(const QStringList& configured, const QStringList& builtin) { return uniqueSorted(configured + builtin); }

}  // namespace ibkr::util
