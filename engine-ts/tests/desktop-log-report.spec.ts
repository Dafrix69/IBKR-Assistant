/** desktop/tools/log_report.js:从原始 main.log(和 pmset -g log)重算"慢在哪"。
 *
 * docs/journal/sleep-read-as-stall.md 里的数字由它算出来;这里用一段合成的日志钉住它怎么认每一种行:
 * 慢请求(新旧两种写法)、「节拍停了」的三种时长写法、主进程的睡眠 / 醒来、`[perf]` 汇总、pmset 的 Sleep → DarkWake。
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const lr = require("../../desktop/tools/log_report.js") as {
  durationMs(t: string): number;
  parseMainLog(t: string): { slow: Array<{ method: string; runMs: number; waitMs: number | null }>; stalls: unknown[]; power: unknown[]; perf: unknown[] };
  parsePmset(t: string): Array<{ from: number; to: number }>;
  report(p: unknown, extra?: Array<{ from: number; to: number; source: string }>): {
    sleeps: { power: number; pmset: number };
    slow: { total: number; methods: Record<string, { n: number; p50: number; at_timeout: number; at_timeout_in_sleep: number; in_sleep: number; wait_p90: number | null; at_timeout_by_day: Record<string, number> }> };
    stalls: { total: number; overlapping_sleep: number; said_awake_but_overlapping_sleep: number; not_overlapping: string[] };
    perf_lines: number;
  };
};

const LOG = [
  "[2026-10-17 01:44:54.803] [info]  [power] 系统睡眠,接着电源;在盯的追踪 0 条",
  "[2026-10-17 23:21:11.815] [info]  [engine] [盯盘] 节拍停了 16 分钟(美东 11:04:41–11:21:11,电脑没睡,是引擎被挂起或卡住了)",
  "[2026-10-17 23:35:02.234] [info]  [power] 系统醒来,睡了 21 小时 50 分",
  "[2026-10-17 23:40:00.000] [info]  [engine] [盯盘] 节拍停了 2 小时 8 分(美东 09:32:00–11:40:00,电脑没睡,是引擎被挂起或卡住了)",
  "[2026-10-17 23:41:00.000] [info]  [engine] [盯盘] 节拍停了 31 秒(美东 11:40:29–11:41:00,电脑没睡,是引擎被挂起或卡住了)",
  "[2026-10-12 21:40:00.000] [info]  [engine] [rpc] 慢请求 options.spot 12001 ms",
  "[2026-10-12 21:40:12.000] [info]  [engine] [rpc] 慢请求 options.spot 12003 ms",
  "[2026-10-12 21:40:20.000] [info]  [engine] [rpc] 慢请求 positions.list 40 ms,排队 11500 ms",
  "[2026-10-17 10:00:00.000] [info]  [engine] [rpc] 慢请求 macro.board 4122 ms",
  '[2026-10-18 01:00:00.000] [info]  [engine] [perf] {"window":{},"methods":{}}',
  "    at listOnTimeout (node:internal/timers:605:17)",
].join("\n");

describe("log_report", () => {
  it("时长的三种写法", () => {
    expect([lr.durationMs("31 秒"), lr.durationMs("16 分钟"), lr.durationMs("2 小时 8 分"), lr.durationMs("42 小时")])
      .toEqual([31_000, 960_000, 7_680_000, 151_200_000]);
    expect(lr.durationMs("很久")).toBe(0);
  });

  it("认得出每一种行;没有时间戳的行跳过", () => {
    const p = lr.parseMainLog(LOG);
    expect(p.slow.map((r) => [r.method, r.runMs, r.waitMs])).toEqual([
      ["options.spot", 12_001, null], ["options.spot", 12_003, null], ["positions.list", 40, 11_500], ["macro.board", 4122, null],
    ]);
    expect([p.stalls.length, p.power.length, p.perf.length]).toEqual([3, 2, 1]);
  });

  it("停摆区间和主进程记的睡眠重叠才算在睡;醒来之后的停摆不算", () => {
    const r = lr.report(lr.parseMainLog(LOG));
    expect(r.sleeps).toEqual({ power: 1, pmset: 0 });
    // 23:40 那一次停了 2 小时 8 分 → 从 21:32 起,和 01:44–23:35 的睡眠重叠;23:41 那 31 秒在醒来之后
    expect(r.stalls).toMatchObject({ total: 3, overlapping_sleep: 2, said_awake_but_overlapping_sleep: 2 });
    expect(r.stalls.not_overlapping).toHaveLength(1);
    expect(r.slow.methods["macro.board"]?.in_sleep).toBe(1);
    expect(r.slow.methods["options.spot"]).toMatchObject({ n: 2, at_timeout: 2, at_timeout_in_sleep: 0, at_timeout_by_day: { "2026-10-12": 2 } });
    expect(r.slow.methods["positions.list"]?.wait_p90).toBe(11_500);
    expect(r.perf_lines).toBe(1);
  });

  it("pmset:Sleep 到下一次 Wake / DarkWake 是一段;时区按行里写的算", () => {
    const pm = [
      "2026-10-12 17:24:43 +0800 Sleep               \tEntering Sleep state due to 'Idle Sleep':TCPKeepAlive=active Using AC (Charge:100%) 2 secs",
      "2026-10-12 17:28:22 +0800 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to RTC/Maintenance Using AC (Charge:100%) 5 secs",
      "2026-10-12 17:28:27 +0800 Assertions          \tPID 123(x) Released ...",
      "2026-10-12 17:28:31 +0800 Sleep               \tEntering DarkWake Sleep ...",
      "2026-10-12 21:32:55 +0800 Wake                \tDarkWake to FullWake from Deep Idle [CDNVA] : due to UserActivity Assertion",
    ].join("\n");
    const s = lr.parsePmset(pm);
    expect(s.map((x) => [new Date(x.from).toISOString(), new Date(x.to).toISOString()])).toEqual([
      ["2026-10-12T09:24:43.000Z", "2026-10-12T09:28:22.000Z"],
      ["2026-10-12T09:28:31.000Z", "2026-10-12T13:32:55.000Z"],
    ]);
  });
});
