// 时区换算(美东 / 北京),engine-ts/src/tz.ts 逐句搬。TS 版用 Intl 查表、墙钟→时刻按"先猜 UTC 再校正"迭代;
// 这里用 QTimeZone 查同一份 IANA 库,迭代与 Date.UTC 的进位(13 月、32 号会往后顺延)照原样,DST 空隙 / 重叠里的结果和 TS 一样。
// 时刻是毫秒(double,同 JS 的 number)。期望值:tests/fixtures/gen_tz.mjs
#pragma once

#include <QString>

#include <optional>

namespace ibkr::util {

inline constexpr char16_t kET[] = u"America/New_York";
inline constexpr char16_t kBJ[] = u"Asia/Shanghai";

struct WallParts {
    double year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;  // 月 1–12
    bool operator==(const WallParts&) const = default;
};

/// Date.UTC(year, monthIndex, day, hour, minute, second):各格可以越界,往上进位(同 JS);0–99 年按 1900 起
double dateUtc(double year, double monthIndex, double day = 1, double hour = 0, double minute = 0, double second = 0);
/// 某时刻在某时区的墙钟(到秒);时区不认识、时刻不是有限数时抛 JsError(同 Intl 的 RangeError)
WallParts wallParts(double epochMs, const QString& tz);
/// 墙钟(某时区)→ 时刻
double wallToEpoch(const WallParts& p, const QString& tz);
/// 带合法性检查:越界的月日时分秒、不存在的日期、不认识的时区都回空
std::optional<double> zonedEpoch(const WallParts& p, const QString& tz);
/// IBKR 成交时间(Execution.time)→ 墙钟 + 所在时区
struct IbWall {
    WallParts wall;
    QString tz;
};
std::optional<IbWall> ibWallTime(const QString& s);
/// 'YYYY-MM-DD' 的星期,周一 = 0 … 周日 = 6;读不出是 NaN
double weekdayOfDate(const QString& dateStr);
QString dateStrAt(double epochMs, const QString& tz);
QString stampAt(double epochMs, const QString& tz);
/// String(n).padStart(2, "0")
QString pad2(double n);
/// 'YYYY-MM-DD' → 自 1970-01-01 起的天数(读不出是 NaN)
double dateOrdinal(const QString& dateStr);
QString ordinalToDate(double ordinal);
bool isValidYmd(double year, double month, double day);
/// 美东某天某时刻 → IB historicalData 的 endDateTime(UTC,"yyyymmdd-HH:MM:SS")
QString ibEndUtc(const QString& day, double hour = 16, double minute = 5);
/// Python datetime.isoformat() 同形(UTC,+00:00 后缀;有毫秒时补到微秒)
QString utcIso(double epochMs);
/// new Date(ms).toISOString()(时刻不是有限数时抛 JsError "Invalid time value")
QString isoString(double epochMs);

}  // namespace ibkr::util
