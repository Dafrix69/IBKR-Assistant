/** 盯盘节拍器的心跳摘要(2026-09-26 从 engine.ts 搬出,函数体未改)。
 *
 * 节拍器的状态由引擎自己维护(TradingEngine.trackerLoop);这里只把它折成给 system.status 与界面看的那几格。
 */
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
  };
}
