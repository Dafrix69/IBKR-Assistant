/** 盯盘节拍器的心跳摘要(2026-09-26 从 engine.ts 搬出,函数体未改)与每一轮的计时(LoopMeter,同样从 engine.ts 搬来)。
 *
 * 节拍器的状态由引擎自己维护(TradingEngine.trackerLoop);这里只把它折成给 system.status 与界面看的那几格。
 */
import { monitorEventLoopDelay } from "node:perf_hooks";

import type { TrackerHeartbeat } from "../contract/system.js";
import type { Rec } from "../store.js";

export function heartbeatOf(s: Rec): TrackerHeartbeat {
  const age = s["last_at"] ? Date.now() - Date.parse(String(s["last_at"])) : null;
  return {
    running: s["running"], interval_ms: s["interval_ms"], ticks: s["ticks"], slow_ticks: s["slow_ticks"],
    last_ms: s["last_ms"], max_ms: s["max_ms"], age_ms: age, last_error: s["last_error"],
    // 事件循环被同步代码占住的时长(毫秒):上一个节拍间隔里的最大值,与开机以来的最坏值。
    // 它高、而 last_ms 不高,说明节拍器没慢,是进程里别的事卡住了它
    event_loop_last_ms: s["lag_last_ms"] ?? null,
    event_loop_worst_ms: s["lag_worst_ms"] ?? null,
    // 电脑刚醒、这一轮不判断的原因(engine/wakeGuard.ts);在判断时是空串
    hold: String(s["hold"] ?? ""),
    live_tracks: Number(s["live_tracks"] ?? 0),
  };
}

/** 每一轮的计时,与引擎进程的事件循环延迟。节拍器是异步的,只有同步代码占住事件循环才会让它晚——
 * 慢了要分得清是"这一轮自己慢"还是"整个进程被别的事卡住"。 */
export class LoopMeter {
  private delay: ReturnType<typeof monitorEventLoopDelay> | null = null;

  start(): void {
    if (this.delay !== null) return;
    try {
      this.delay = monitorEventLoopDelay({ resolution: 20 });
      this.delay.enable();
    } catch {
      this.delay = null;
    }
  }

  stop(): void {
    this.delay?.disable();
    this.delay = null;
  }

  /** 一轮结束(t0 是这一轮开始的墙钟):轮数、用时、慢轮数,写进心跳的那几格。 */
  record(state: Rec, t0: number, slowMs: number): void {
    const ms = Date.now() - t0;
    // 事件循环延迟按"每一轮一个窗口"记:上一个节拍间隔里最长被占了多久。累计的最大值分不清是哪一下
    if (this.delay !== null) {
      const lag = Number.isFinite(this.delay.max) ? Math.round(this.delay.max / 1e6) : 0;
      state["lag_last_ms"] = lag;
      state["lag_worst_ms"] = Math.max(Number(state["lag_worst_ms"] ?? 0), lag);
      this.delay.reset();
    }
    state["ticks"] = Number(state["ticks"]) + 1;
    state["last_at"] = new Date().toISOString();
    state["last_ms"] = ms;
    state["max_ms"] = Math.max(Number(state["max_ms"]), ms);
    if (ms > slowMs) state["slow_ticks"] = Number(state["slow_ticks"]) + 1;
  }
}
