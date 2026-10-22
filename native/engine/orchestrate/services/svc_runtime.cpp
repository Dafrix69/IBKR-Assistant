#include "orchestrate/services/svc_runtime.h"

#include "util/awake_clock.h"

#include <QRandomGenerator>
#include <QTimer>

#include <memory>
#include <unordered_map>

namespace ibkr::orchestrate {

util::Task<> SvcRuntime::sleep(int ms) {
    util::Deferred<> d;
    setTimeout(ms, [d]() mutable { d.resolve(); });
    return d.task();
}

namespace {

class QtRuntime : public SvcRuntime {
public:
    double perfMs() override { return double(util::awakeMicros()) / 1000.0; }
    int setTimeout(int ms, std::function<void()> fn) override {
        const int id = next_++;
        auto timer = std::make_unique<QTimer>();
        timer->setSingleShot(true);
        QTimer* raw = timer.get();
        timers_.emplace(id, std::move(timer));
        QObject::connect(raw, &QTimer::timeout, raw, [this, id, fn = std::move(fn)]() mutable {
            // 先摘掉再调:回调里 clearTimeout(自己) 与再设新的都安全
            auto owned = std::move(timers_[id]);
            timers_.erase(id);
            fn();
            owned.release()->deleteLater();
        });
        raw->start(ms);
        return id;
    }
    void clearTimeout(int id) override { drop(id); }
    int setInterval(int ms, std::function<void()> fn) override {
        const int id = next_++;
        auto timer = std::make_unique<QTimer>();
        QTimer* raw = timer.get();
        timers_.emplace(id, std::move(timer));
        QObject::connect(raw, &QTimer::timeout, raw, [fn = std::move(fn)]() { fn(); });
        raw->start(ms);
        return id;
    }
    void clearInterval(int id) override { drop(id); }
    double random() override { return QRandomGenerator::global()->generateDouble(); }

private:
    // 在它自己的 timeout 里被清掉也安全:deleteLater
    void drop(int id) {
        const auto it = timers_.find(id);
        if (it == timers_.end()) return;
        auto t = std::move(it->second);
        timers_.erase(it);
        t->stop();  // deleteLater 要等到下一轮事件循环:停不住的话这一轮里它还会再触发一次
        t.release()->deleteLater();
    }
    int next_ = 1;
    std::unordered_map<int, std::unique_ptr<QTimer>> timers_;
};

}  // namespace

SvcRuntime& qtRuntime() {
    static QtRuntime rt;
    return rt;
}

}  // namespace ibkr::orchestrate
