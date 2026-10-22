// 电脑醒着的时间:睡眠里不走的单调时钟。
//
// 为什么不用 QElapsedTimer / std::chrono::steady_clock:在 macOS 上它们是 CLOCK_MONOTONIC_RAW,
// **睡眠里照走**(2026-10-18 在这台机器上量过:开机以来它比 CLOCK_UPTIME_RAW 多了 234 小时,正好是睡掉的时间)。
// TS 引擎踩过同一个坑(libuv 的 hrtime 也是睡眠里照走的那一个,见 docs/journal/sleep-read-as-stall.md)。
// 拿它和墙钟比才认得出"这段时间电脑在睡":墙钟走了、它没走。
//
//   macOS    CLOCK_UPTIME_RAW(= mach_absolute_time)
//   Windows  QueryUnbiasedInterruptTime(睡眠与休眠不计)
//   Linux    CLOCK_MONOTONIC(挂起不计;计挂起的是 CLOCK_BOOTTIME)
#pragma once

#include <QtGlobal>

namespace ibkr::util {

/// 醒着的时间,微秒,起点不定(只拿来相减)
qint64 awakeMicros();

}  // namespace ibkr::util
