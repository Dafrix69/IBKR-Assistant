// 从别的线程把一件事交给某个 QObject 所在的线程去做。**跨线程投递一律走这里**,不直接调 QMetaObject::invokeMethod。
//
// 为什么要单独一处:Qt 的投递队列本身是加了锁的,可是 Homebrew 与 aqt 装的 QtCore 都没有 ThreadSanitizer 插桩,
// TSan 看不见那把锁,会把交过去的数据(lambda 里捕获的东西)报成数据竞争。TSan 编法(IBKR_TSAN)下这里
// 两边各拿一下一把 TSan 看得见的锁,把先后关系摆在明面上;别的编法里就是一句 invokeMethod,不多一把锁。
// 以后界面线程与引擎线程之间的交接也走它,省得每处各补一把。
#pragma once

#include <QMetaObject>
#include <QObject>

#include <utility>

#if IBKR_TSAN
#include <mutex>
#endif

namespace ibkr::util {

#if IBKR_TSAN
/// 只在 TSan 编法里存在:见上面
std::mutex& tsanHandoffMutex();
#endif

/// 在 context 所在的线程里、下一轮事件循环执行 f。context 要活到 f 执行完(Qt 在 context 销毁时丢掉没执行的)
template <typename F>
void postQueued(QObject* context, F&& f) {
#if IBKR_TSAN
    const std::lock_guard sent(tsanHandoffMutex());
    QMetaObject::invokeMethod(context, [f = std::forward<F>(f)]() mutable {
        { const std::lock_guard received(tsanHandoffMutex()); }
        f();
    }, Qt::QueuedConnection);
#else
    QMetaObject::invokeMethod(context, std::forward<F>(f), Qt::QueuedConnection);
#endif
}

}  // namespace ibkr::util
