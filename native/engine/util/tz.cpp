#include "util/tz.h"

#include "util/error.h"
#include "util/jsformat.h"

#include <QDateTime>
#include <QHash>
#include <QRegularExpression>
#include <QTimeZone>

#include <cmath>
#include <limits>

namespace ibkr::util {

using namespace Qt::StringLiterals;

namespace {

constexpr double kDay = 86'400'000.0;
const double kNaN = std::numeric_limits<double>::quiet_NaN();

/// 公历(前推)y-m-d 到 1970-01-01 的天数(Howard Hinnant 的 days_from_civil)
double daysFromCivil(double y, double m, double d) {
    y -= m <= 2 ? 1 : 0;
    const double era = std::floor(y / 400);
    const double yoe = y - era * 400;
    const double doy = std::floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    const double doe = yoe * 365 + std::floor(yoe / 4) - std::floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
}

struct Civil {
    double y, m, d;  // m 1–12
};
Civil civilFromDays(double z) {
    z += 719468;
    const double era = std::floor(z / 146097);
    const double doe = z - era * 146097;
    const double yoe = std::floor((doe - std::floor(doe / 1460) + std::floor(doe / 36524) - std::floor(doe / 146096)) / 365);
    const double y = yoe + era * 400;
    const double doy = doe - (365 * yoe + std::floor(yoe / 4) - std::floor(yoe / 100));
    const double mp = std::floor((5 * doy + 2) / 153);
    const double d = doy - std::floor((153 * mp + 2) / 5) + 1;
    const double m = mp + (mp < 10 ? 3 : -9);
    return {y + (m <= 2 ? 1 : 0), m, d};
}

/// ToIntegerOrInfinity 之后的 MakeTime / MakeDay / TimeClip(规范的 Date.UTC)
double toInt(double v) { return std::isnan(v) ? kNaN : std::trunc(v); }

QTimeZone zoneOf(const QString& tz) {
    static QHash<QString, QTimeZone> cache;
    auto it = cache.find(tz);
    if (it == cache.end()) it = cache.insert(tz, tz == u"UTC" ? QTimeZone(QTimeZone::UTC) : QTimeZone(tz.toUtf8()));
    return it.value();
}

/// Number("09") 一类:这里的格都是纯数字串
double num(const QString& s) { return jsStringToNumber(s); }

}  // namespace

double dateUtc(double year, double monthIndex, double day, double hour, double minute, double second) {
    double y = toInt(year);
    const double mi = toInt(monthIndex), d = toInt(day), h = toInt(hour), mn = toInt(minute), s = toInt(second);
    if (!std::isfinite(y) || !std::isfinite(mi) || !std::isfinite(d) || !std::isfinite(h) || !std::isfinite(mn) || !std::isfinite(s)) return kNaN;
    if (y >= 0 && y <= 99) y += 1900;
    const double ym = y + std::floor(mi / 12);
    const double mn12 = mi - std::floor(mi / 12) * 12;
    const double days = daysFromCivil(ym, mn12 + 1, 1) + d - 1;
    const double t = days * kDay + ((h * 60 + mn) * 60 + s) * 1000;
    return std::fabs(t) > 8.64e15 ? kNaN : t;
}

WallParts wallParts(double epochMs, const QString& tz) {
    const QTimeZone zone = zoneOf(tz);
    if (!zone.isValid()) throw JsError(u"Invalid time zone specified: %1"_s.arg(tz));
    if (!std::isfinite(epochMs) || std::fabs(epochMs) > 8.64e15) throw JsError(u"Invalid time value"_s);
    // Intl 按秒截(向 -∞):负的毫秒也一样
    const qint64 ms = static_cast<qint64>(std::floor(epochMs / 1000) * 1000);
    const QDateTime dt = QDateTime::fromMSecsSinceEpoch(ms, zone);
    const QDate date = dt.date();
    const QTime time = dt.time();
    return {double(date.year()), double(date.month()), double(date.day()), double(time.hour() % 24), double(time.minute()), double(time.second())};
}

double wallToEpoch(const WallParts& p, const QString& tz) {
    double guess = dateUtc(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    for (int i = 0; i < 3; ++i) {
        const WallParts w = wallParts(guess, tz);
        const double asUtc = dateUtc(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
        const double want = dateUtc(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
        const double diff = want - asUtc;
        if (diff == 0) return guess;
        guess += diff;
    }
    return guess;
}

std::optional<double> zonedEpoch(const WallParts& p, const QString& tz) {
    if (p.month < 1 || p.month > 12 || p.day < 1 || p.day > 31 || p.hour > 23 || p.minute > 59 || p.second > 59) return std::nullopt;
    try {
        const double epoch = wallToEpoch(p, tz);
        const WallParts back = wallParts(epoch, tz);
        return back.month == p.month && back.day == p.day ? std::optional<double>(epoch) : std::nullopt;
    } catch (const JsError&) {
        return std::nullopt;  // 时区名不认识
    }
}

std::optional<IbWall> ibWallTime(const QString& s) {
    static const QRegularExpression rt(u"^(\\d{4})(\\d{2})(\\d{2})-(\\d{2}):(\\d{2}):(\\d{2})\\z"_s);
    static const QRegularExpression rq(u"^(\\d{4})(\\d{2})(\\d{2})\\s+(\\d{2}):(\\d{2}):(\\d{2})(?:\\s+(\\S+))?\\z"_s);
    static const QHash<QString, QString> aliases{{u"US/Eastern"_s, u"America/New_York"_s}, {u"US/Central"_s, u"America/Chicago"_s},
                                                 {u"US/Mountain"_s, u"America/Denver"_s}, {u"US/Pacific"_s, u"America/Los_Angeles"_s}};
    QRegularExpressionMatch m = rt.match(s);
    QString tz = u"UTC"_s;
    if (!m.hasMatch()) {
        m = rq.match(s);
        if (!m.hasMatch()) return std::nullopt;
        tz = m.capturedLength(7) ? aliases.value(m.captured(7), m.captured(7)) : QString::fromUtf16(kET);
    }
    return IbWall{{num(m.captured(1)), num(m.captured(2)), num(m.captured(3)), num(m.captured(4)), num(m.captured(5)), num(m.captured(6))}, tz};
}

namespace {
/// "YYYY-MM-DD".split("-").map(Number):少格是 undefined → NaN
void ymd(const QString& s, double& y, double& m, double& d) {
    const QStringList parts = s.split(u'-');
    y = parts.size() > 0 ? num(parts[0]) : kNaN;
    m = parts.size() > 1 ? num(parts[1]) : kNaN;
    d = parts.size() > 2 ? num(parts[2]) : kNaN;
}
double utcDay(double t) { return std::floor(t / kDay); }
}  // namespace

double weekdayOfDate(const QString& dateStr) {
    double y, m, d;
    ymd(dateStr, y, m, d);
    const double t = dateUtc(y, m - 1, d);
    if (std::isnan(t)) return kNaN;
    const double dow = std::fmod(utcDay(t) + 4, 7);  // 1970-01-01 是周四
    const double getUTCDay = dow < 0 ? dow + 7 : dow;
    return std::fmod(getUTCDay + 6, 7);
}

QString pad2(double n) {
    const QString s = jsNumberToString(n);
    return s.size() >= 2 ? s : QString(2 - s.size(), u'0') + s;
}

QString dateStrAt(double epochMs, const QString& tz) {
    const WallParts p = wallParts(epochMs, tz);
    return jsNumberToString(p.year) + u'-' + pad2(p.month) + u'-' + pad2(p.day);
}

QString stampAt(double epochMs, const QString& tz) {
    const WallParts p = wallParts(epochMs, tz);
    return jsNumberToString(p.year) + u'-' + pad2(p.month) + u'-' + pad2(p.day) + u' ' + pad2(p.hour) + u':' + pad2(p.minute);
}

double dateOrdinal(const QString& dateStr) {
    double y, m, d;
    ymd(dateStr, y, m, d);
    return jsRound(dateUtc(y, m - 1, d) / kDay);
}

QString ordinalToDate(double ordinal) {
    const double t = ordinal * kDay;
    if (!std::isfinite(t) || std::fabs(t) > 8.64e15) return u"NaN-NaN-NaN"_s;
    const Civil c = civilFromDays(utcDay(t));
    return jsNumberToString(c.y) + u'-' + pad2(c.m) + u'-' + pad2(c.d);
}

bool isValidYmd(double year, double month, double day) {
    if (month < 1 || month > 12 || day < 1) return false;
    const double t = dateUtc(year, month - 1, day);
    if (std::isnan(t)) return false;
    const Civil c = civilFromDays(utcDay(t));
    return c.y == year && c.m - 1 == month - 1 && c.d == day;
}

QString isoString(double epochMs) {
    if (!std::isfinite(epochMs) || std::fabs(epochMs) > 8.64e15) throw JsError(u"Invalid time value"_s);
    const double t = std::trunc(epochMs);
    const Civil c = civilFromDays(utcDay(t));
    double rem = t - utcDay(t) * kDay;
    const int h = int(rem / 3600000);
    rem -= h * 3600000.0;
    const int mi = int(rem / 60000);
    rem -= mi * 60000.0;
    const int s = int(rem / 1000);
    const int ms = int(rem - s * 1000);
    QString year;
    if (c.y >= 0 && c.y <= 9999) year = QString::number(qint64(c.y)).rightJustified(4, u'0');
    else year = (c.y < 0 ? u"-"_s : u"+"_s) + QString::number(qint64(std::fabs(c.y))).rightJustified(6, u'0');
    return u"%1-%2-%3T%4:%5:%6.%7Z"_s.arg(year, pad2(c.m), pad2(c.d), pad2(h), pad2(mi), pad2(s), QString::number(ms).rightJustified(3, u'0'));
}

QString ibEndUtc(const QString& day, double hour, double minute) {
    double y, m, d;
    ymd(day, y, m, d);
    const double epoch = wallToEpoch({y, m, d, hour, minute, 0}, QString::fromUtf16(kET));
    QString s = isoString(epoch).left(19);
    return s.remove(u'-').replace(u'T', u'-');
}

QString utcIso(double epochMs) {
    const QString iso = isoString(epochMs);
    const QString base = iso.left(19);
    const double t = std::trunc(epochMs);
    double ms = std::fmod(t, 1000);
    if (ms < 0) ms += 1000;
    return ms != 0 ? base + u'.' + QString::number(qint64(ms)).rightJustified(3, u'0') + u"000+00:00"_s : base + u"+00:00"_s;
}

}  // namespace ibkr::util
