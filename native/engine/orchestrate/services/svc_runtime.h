// services/ 的时间与计时器缝。TS 的 service 直接用全局 setTimeout / setInterval / performance.now / Math.random,
// 测试靠把这几样换成虚拟钟(broker_world.mjs 那一套);C++ 没有全局可换,所以走这一个接口:真跑是 QTimer,测试换成虚拟钟。
//
// 与 TS 的对应与不同:
//   · performance.now() → perfMs():醒着的时间(util::awakeMicros),睡眠里不走——TS 的 performance.now 在 macOS 上走的是 libuv 的 hrtime,
//     睡眠里照走(docs/journal/sleep-read-as-stall.md),这里**有意不同**:fillSync 的节流与各缓存的 TTL 睡醒之后不该被一口气判成"过期了很久"。
//     (行为差别只在睡眠之后:TS 醒来会立刻再要一次成交/重取缓存,C++ 按醒着的时间算。两边都是"多取一次",没有钱路径上的后果。)
//   · Date.now() → util::dateNow()(测试用 setDateNowForTests 换)。
//   · timer.unref():没有对应——QTimer 不挂住进程。
//   · setInterval/setTimeout 回的是整数句柄(> 0);clear* 认得句柄,已经触发过的 / 清过的 / 0 都当没事(同 JS 的 clearTimeout)。
#pragma once

#include "util/error.h"
#include "util/task.h"

#include <functional>
#include <memory>

namespace ibkr::orchestrate {

class SvcRuntime {
public:
    virtual ~SvcRuntime() = default;
    /// performance.now()
    virtual double perfMs() = 0;
    virtual int setTimeout(int ms, std::function<void()> fn) = 0;
    virtual void clearTimeout(int id) = 0;
    virtual int setInterval(int ms, std::function<void()> fn) = 0;
    virtual void clearInterval(int id) = 0;
    /// Math.random()
    virtual double random() = 0;

    /// await new Promise((r) => setTimeout(r, ms))
    util::Task<> sleep(int ms);
};

/// 真跑用:QTimer。进程里一份
SvcRuntime& qtRuntime();

/// Promise.race([work, 到点就抛 makeError() 的那个]).finally(clearTimeout):work 先完成交它的结果,计时器先到抛错;**不撤** work
template <class T, class MakeError>
util::Task<T> raceTimeout(SvcRuntime& rt, util::Task<T> work, int ms, MakeError makeError) {
    util::Deferred<T> d;
    auto timer = std::make_shared<int>(0);
    *timer = rt.setTimeout(ms, [d, makeError]() mutable { d.reject(makeError()); });
    work.onDone([d, work, timer, &rt]() mutable {
        rt.clearTimeout(*timer);
        if (work.error()) d.reject(work.error());
        else if constexpr (std::is_void_v<T>) d.resolve();
        else d.resolve(work.result());
    });
    return d.task();
}

}  // namespace ibkr::orchestrate
