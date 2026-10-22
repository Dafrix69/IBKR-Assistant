// 美股休市日与提前收盘日的内置日历(按 NYSE 的规则推算),engine-ts/src/marketCalendar.ts 逐句搬。
// 规则算得出来的十个假日 + 已经发生过的临时休市;周六的提前到周五、周日的顺延到周一,元旦落在周六不补休;
// 六月节从 2022 年起;提前收盘三种(感恩节次日、平安夜、7 月 3 日落在周一到周四时)。纯函数,不读时钟。
// 期望值:tests/fixtures/gen_market_calendar.mjs
#pragma once

#include <QStringList>

namespace ibkr::util {

inline constexpr int kCalendarFirstYear = 2000;
inline constexpr int kCalendarLastYear = 2060;

/// 复活节(公历,Meeus / Jones / Butcher)
QString easterSunday(int year);
/// 某一年的休市日(排好序、去了重)
QStringList nyseHolidays(int year);
/// 某一年提前到美东 13:00 收盘的日子
QStringList nyseEarlyCloses(int year);
struct BuiltinCalendar {
    QStringList holidays;
    QStringList earlyCloses;
};
/// 2000–2060 整段(算一次,之后复用)
const BuiltinCalendar& builtinCalendar();
/// 配置里的日期与内置日历取并集(去重、排序)
QStringList mergeCalendar(const QStringList& configured, const QStringList& builtin);

}  // namespace ibkr::util
