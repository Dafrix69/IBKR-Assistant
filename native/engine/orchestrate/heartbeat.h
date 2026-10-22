// engine/heartbeat.ts 逐句搬:盯盘节拍器的心跳摘要(heartbeatOf)与每一轮的计时(LoopMeter)。
// 状态是 JS 对象(OJson,键序同 TS);节拍器本身(TradingEngine.trackerLoop)在 engine.ts。
//
// LoopMeter 与 TS 的不同(Node 专有的东西没法搬):TS 用 perf_hooks.monitorEventLoopDelay({resolution: 20}) 量"事件循环被同步代码占住了多久"。
// C++ 引擎的 Qt 事件循环没有现成的这个直方图,这里把"上一个窗口里最长的延迟(纳秒,JS 的 histogram.max)"做成一个可换的来源 lagSource
// (取窗口最大值并清零,等于 delay.max + delay.reset());缺省没有来源,lag 两格不写——与 TS 里 monitorEventLoopDelay 抛错时 delay = null 同。
// engine.ts 的搬运者要量的话,给一个 20 ms 的 QTimer 采样器(记下每次触发比预定晚了多少)即可。
#pragma once

#include "util/ordered_json.h"

#include <functional>
#include <optional>

namespace ibkr::orchestrate {

/// {running, interval_ms, ticks, slow_ticks, last_ms, max_ms, age_ms, last_error, event_loop_last_ms, event_loop_worst_ms, hold, live_tracks}
util::OJson heartbeatOf(const util::OJson& state);

class LoopMeter {
public:
    /// 取走上一个窗口里事件循环延迟的最大值(纳秒)并清零;没有来源 = 空函数
    using LagSource = std::function<double()>;
    explicit LoopMeter(LagSource lagSource = {}) : lagSource_(std::move(lagSource)) {}

    /// 对应 TS 的 start():有来源才开始量(监视器起得来)。重复调用无害
    void start() { if (!started_) started_ = bool(lagSource_); }
    void stop() { started_ = false; }
    /// 一轮结束(t0 是这一轮开始的墙钟):轮数、用时、慢轮数,写进心跳的那几格。nowMs 缺省 = Date.now()
    void record(util::OJson& state, double t0, double slowMs) const;

private:
    LagSource lagSource_;
    bool started_ = false;
};

}  // namespace ibkr::orchestrate
