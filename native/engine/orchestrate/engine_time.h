// engine/*.ts 里的时钟与计时器:Date.now() 与 setTimeout。生产里是真的钟;测试(tests/engine_world.h)换成虚拟钟,
// 这样"等 10 秒不回""退避 60 秒"这类按时间走的钱路径行为能逐毫秒对拍。
//   · nowMs():Date.now() = util::dateNow()(测试用 util::setDateNowForTests 换)。
//   · TS 的 nowEt()(config.ts)读的是另一个钟(domain::nowMs,可由 domain::setClock 注入);两个钟测试里要一起拨。
//   · SetTimeout:`setTimeout(fn, ms)`。Promise.race 里的计时器在赛完之后 TS 会 clearTimeout,这里不撤——
//     迟到的计时器只碰共享的 Deferred(已经有结果了,什么都不做),没有生命周期问题。
#pragma once

#include "util/error.h"
#include "util/js_runtime.h"
#include "util/task.h"

#include <QString>
#include <QTimer>

#include <cmath>
#include <functional>

namespace ibkr::orchestrate {

inline double nowMs() { return util::dateNow(); }

/// setTimeout(fn, ms)
using SetTimeout = std::function<void(int ms, std::function<void()> fn)>;
inline SetTimeout defaultSetTimeout() {
    return [](int ms, std::function<void()> fn) { QTimer::singleShot(ms, std::move(fn)); };
}

/// Promise.race([work, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]):计时器先到抛 JsError(message)。
/// 超时只是这边不等了,work 照样跑完(它迟到的结果被吞掉)。hosted.ts 的 adoptHosted(10 秒放手)与下面的 withTimeout 都是它。
template <class T>
util::Task<T> raceTimeout(util::Task<T> work, int ms, const QString& message, const SetTimeout& setTimeout) {
    util::Deferred<T> d;
    setTimeout(ms, [d, message]() mutable { d.reject(util::JsError(message)); });
    work.onDone([d, work]() mutable {
        if (work.error()) d.reject(work.error());
        else if constexpr (std::is_void_v<T>) d.resolve();
        else d.resolve(work.result());
    });
    return d.task();
}

/// reconcile.ts 的 withTimeout:超时的话是 `${what}等了 ${Math.round(ms / 1000)} 秒没有回应`
template <class T>
util::Task<T> withTimeout(util::Task<T> work, int ms, const QString& what, const SetTimeout& setTimeout) {
    const QString message = what + QStringLiteral("等了 ") + QString::number(std::llround(ms / 1000.0)) + QStringLiteral(" 秒没有回应");
    return raceTimeout<T>(std::move(work), ms, message, setTimeout);
}

}  // namespace ibkr::orchestrate
