#include "util/awake_clock.h"

#if defined(Q_OS_WIN)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <time.h>
#endif

namespace ibkr::util {

qint64 awakeMicros() {
#if defined(Q_OS_WIN)
    ULONGLONG hundredNs = 0;
    QueryUnbiasedInterruptTime(&hundredNs);
    return static_cast<qint64>(hundredNs / 10);
#elif defined(Q_OS_MACOS)
    return static_cast<qint64>(clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000);
#else
    timespec ts{};
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return static_cast<qint64>(ts.tv_sec) * 1'000'000 + ts.tv_nsec / 1000;
#endif
}

}  // namespace ibkr::util
