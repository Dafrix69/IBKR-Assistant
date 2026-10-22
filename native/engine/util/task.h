// 引擎里的 async / await:TS 版的 async 函数与 Promise 在这里是 C++20 协程 Task<T>。为什么不用回调:
//   · TS 的 `try { await … } catch (RpcError)` 一行对一行搬过来,异常(util::JsError)穿得过 co_await;回调做不到,
//     每个 await 都得手写一跳"错误结果",钱路径的代码就不再是逐行对得上的了;
//   · 界面那一半(native/shell)用回调,吃过"晚到的回包打到已经没了的对象上"那一类 bug;引擎不再引进来。
//
// 语义照 JS 的 Promise:
//   · 立刻开始跑(同 async 函数:第一次 await 之前的部分是同步执行的);
//   · 可以被好几个调用方同时 co_await(同一个 Promise 被 await 多次),都拿到同一个结果或同一个异常;Task 是可拷贝的句柄;
//   · 完成时直接接着跑等它的那些协程(相当于 JS 的微任务紧接着执行;差别:JS 对已经完成的 Promise 也要让一拍,这里不让)。
//
// 生命周期规则(评审按这条查):协程是活得比它所有 await 都长的对象的成员函数(引擎的单例、store),
// 或者 co_await 之后碰对象之前先查 QPointer。**不写按引用捕获局部变量的 lambda 协程。**
#pragma once

#include <QObject>
#include <QPointer>
#include <QTimer>

#include <coroutine>
#include <exception>
#include <functional>
#include <memory>
#include <optional>
#include <utility>
#include <vector>

namespace ibkr::util {

namespace detail {

// 完成时唤醒等它的协程、再调 onDone 回调。回调约定不抛(它们是清理与转交:withDeadline、detach、在途表的清理);
// 真抛了就当场终止——放它冒出去会落进正在结束的那个协程的 unhandled_exception,同一个 Task 既有值又有错,
// 后面的回调也都不调了(等它的人永远等下去)。终止比悄悄坏掉好查
inline void finishState(bool& done, std::vector<std::coroutine_handle<>>& waiters, std::vector<std::function<void()>>& callbacks) {
    done = true;
    auto w = std::move(waiters);
    auto c = std::move(callbacks);
    for (auto h : w) h.resume();
    for (auto& f : c) {
        try {
            f();
        } catch (...) {
            std::terminate();
        }
    }
}

template <class T>
struct State {
    std::optional<T> value;
    std::exception_ptr error;
    bool done = false;
    std::vector<std::coroutine_handle<>> waiters;
    std::vector<std::function<void()>> callbacks;
    void finish() { finishState(done, waiters, callbacks); }
};

template <>
struct State<void> {
    std::exception_ptr error;
    bool done = false;
    std::vector<std::coroutine_handle<>> waiters;
    std::vector<std::function<void()>> callbacks;
    void finish() { finishState(done, waiters, callbacks); }
};

}  // namespace detail

template <class T = void>
class Task {
public:
    using State = detail::State<T>;

    struct promise_type {
        std::shared_ptr<State> state = std::make_shared<State>();
        Task get_return_object() { return Task(state); }
        std::suspend_never initial_suspend() noexcept { return {}; }
        // 协程帧在结束时自己销毁;结果在共享的 state 里
        std::suspend_never final_suspend() noexcept { return {}; }
        void unhandled_exception() {
            state->error = std::current_exception();
            state->finish();
        }
        template <class U>
        void return_value(U&& v) {
            state->value.emplace(std::forward<U>(v));
            state->finish();
        }
    };

    Task() = default;
    explicit Task(std::shared_ptr<State> s) : state_(std::move(s)) {}

    bool done() const { return state_ && state_->done; }
    /// 是不是同一个 Promise(TS 的 ===)
    bool operator==(const Task& o) const { return state_ == o.state_; }
    /// 完成之后取结果(没完成或失败时抛)
    T result() const {
        if (state_->error) std::rethrow_exception(state_->error);
        return *state_->value;
    }
    std::exception_ptr error() const { return state_ ? state_->error : nullptr; }
    /// 完成时(成功或失败)调一下;已经完成的当场调
    void onDone(std::function<void()> f) const {
        if (state_->done) f();
        else state_->callbacks.push_back(std::move(f));
    }

    bool await_ready() const noexcept { return state_->done; }
    void await_suspend(std::coroutine_handle<> h) const { state_->waiters.push_back(h); }
    T await_resume() const { return result(); }

    /// 已经有结果的 Task(Promise.resolve)
    static Task resolved(T v) {
        auto s = std::make_shared<State>();
        s->value.emplace(std::move(v));
        s->done = true;
        return Task(s);
    }

private:
    std::shared_ptr<State> state_;
};

template <>
class Task<void> {
public:
    using State = detail::State<void>;

    struct promise_type {
        std::shared_ptr<State> state = std::make_shared<State>();
        Task get_return_object() { return Task(state); }
        std::suspend_never initial_suspend() noexcept { return {}; }
        std::suspend_never final_suspend() noexcept { return {}; }
        void unhandled_exception() {
            state->error = std::current_exception();
            state->finish();
        }
        void return_void() { state->finish(); }
    };

    Task() = default;
    explicit Task(std::shared_ptr<State> s) : state_(std::move(s)) {}

    bool done() const { return state_ && state_->done; }
    bool operator==(const Task& o) const { return state_ == o.state_; }
    void result() const {
        if (state_->error) std::rethrow_exception(state_->error);
    }
    std::exception_ptr error() const { return state_ ? state_->error : nullptr; }
    void onDone(std::function<void()> f) const {
        if (state_->done) f();
        else state_->callbacks.push_back(std::move(f));
    }

    bool await_ready() const noexcept { return state_->done; }
    void await_suspend(std::coroutine_handle<> h) const { state_->waiters.push_back(h); }
    void await_resume() const { result(); }

    static Task resolved() {
        auto s = std::make_shared<State>();
        s->done = true;
        return Task(s);
    }

private:
    std::shared_ptr<State> state_;
};

/// new Promise((resolve, reject) => …):把回调式的接口接成可以 co_await 的 Task。只认第一次 resolve / reject
template <class T = void>
class Deferred {
public:
    Deferred() : state_(std::make_shared<typename Task<T>::State>()) {}
    Task<T> task() const { return Task<T>(state_); }
    bool settled() const { return state_->done; }
    template <class U = T>
    void resolve(U&& v) requires(!std::is_void_v<T>) {
        if (state_->done) return;
        state_->value.emplace(std::forward<U>(v));
        state_->finish();
    }
    void resolve() requires(std::is_void_v<T>) {
        if (state_->done) return;
        state_->finish();
    }
    void reject(std::exception_ptr e) {
        if (state_->done) return;
        state_->error = std::move(e);
        state_->finish();
    }
    template <class E>
    void reject(E&& e) {
        reject(std::make_exception_ptr(std::forward<E>(e)));
    }

private:
    std::shared_ptr<typename Task<T>::State> state_;
};

/// setTimeout 一样的等待:ms 毫秒之后接着跑。context 没了就永远不接着跑(协程帧随之泄漏一个,不碰已经释放的内存)
inline Task<> sleepMs(int ms, QObject* context = nullptr) {
    Deferred<> d;
    if (context) {
        QTimer::singleShot(ms, context, [d]() mutable { d.resolve(); });
    } else {
        QTimer::singleShot(ms, [d]() mutable { d.resolve(); });
    }
    return d.task();
}

/// 不等它的结果(fire and forget):失败就交给 onError(TS 里没被 await 的 Promise 的 unhandled rejection 进日志)
template <class T>
void detach(const Task<T>& task, std::function<void(std::exception_ptr)> onError = {}) {
    task.onDone([task, onError] {
        if (task.error() && onError) onError(task.error());
    });
}

/// TS secrets.ts 的 withDeadline:work 在 ms 毫秒内完成就交它的结果,否则抛 onTimeout() 给的异常;
/// **不撤** work——它照样跑完、写下自己的结果(只是这一次没人等它了)
template <class T, class MakeError>
Task<T> withDeadline(Task<T> work, int ms, MakeError onTimeout) {
    Deferred<T> d;
    // 计时器挂在一个守护对象上:work 先完成就删守护对象(计时器随之作废);到点先来就 reject。
    // 不用 shared_ptr<QTimer>:到点那一刻 reject 同步唤醒的协程若又同步让 work 完成,计时器会在自己的 timeout 还在发时被删掉
    auto* guard = new QObject;
    QTimer::singleShot(ms, guard, [d, onTimeout, guard]() mutable {
        d.reject(onTimeout());
        guard->deleteLater();
    });
    work.onDone([d, work, guard = QPointer<QObject>(guard)]() mutable {
        if (guard) guard->deleteLater();
        if (work.error()) d.reject(work.error());
        else if constexpr (std::is_void_v<T>) d.resolve();
        else d.resolve(work.result());
    });
    return d.task();
}

}  // namespace ibkr::util
