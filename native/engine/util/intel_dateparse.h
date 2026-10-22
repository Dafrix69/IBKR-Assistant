// Date.parse 的完整搬法(V8 14 的 src/date/dateparser*.{h,cc} 与 builtins-date.cc 的 ParseDateTimeString,逐段照抄):
// 先按 ES5 的 ISO 写法读,读不完的交给老的"Safari 兼容"读法——"2026-10-14 08:30"、"Oct 14 2026"、"2026/10/14"、"12"
// (= 2001-12-01)、"2026-02-30"(顺延到 3 月 2 日)、小写的 t / z、"-0400" 都认。util/jsvalue 的 jsDateParse 只认严格的 ISO,
// 日历源、消息底账这类外来的串碰上别的写法时两边不一样,所以 intel 组用这一份。
// 不带时区的按 local 换(V8 用 ICU 查本机时区;这里用 QTimeZone 查同一份 IANA 库)。
#pragma once

#include <QString>
#include <QTimeZone>

namespace ibkr::util {

/// 进程的本机时区(只查一次:QTimeZone::systemTimeZone() 每次都要重新构造,评审量过一次判定约 2 ms)
const QTimeZone& systemZone();

/// Date.parse(s);local = 进程的本机时区
double v8DateParse(const QString& s, const QTimeZone& local = systemZone());

}  // namespace ibkr::util
