/** desktop/tools/perf_snapshot.js:正在运行的应用每类进程多大、引擎起来到连上券商多久。
 *
 * 真的采样要在用户自己的终端里跑(沙箱不让跑 ps);这里用一段合成的 ps 输出钉住归类与汇总。
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const ps = require("../../desktop/tools/perf_snapshot.js") as {
  roleOf(command: string): string | null;
  parsePs(text: string): Array<{ pid: number; rssKb: number; cpu: number; role: string }>;
  summarize(samples: Array<Array<{ rssKb: number; cpu: number; role: string }>>): {
    samples: number; processes: Record<string, { count: number; rss_mb: { median: number; min: number; max: number } }>;
    total: { rss_mb: { median: number; min: number; max: number }; cpu_pct: { median: number } };
  };
  startupTimes(log: string): number[];
};

const APP = "/Users/u/Desktop/ibkr/IBKR-Assistant/desktop/dist/mac-arm64/IBKR-Assistant.app/Contents";
const PS = [
  `  501 204800  3.0 ${APP}/MacOS/IBKR-Assistant`,
  `  502 307200 12.5 ${APP}/Frameworks/IBKR-Assistant Helper (Renderer).app/Contents/MacOS/IBKR-Assistant Helper (Renderer) --type=renderer`,
  `  503 102400  1.0 ${APP}/Frameworks/IBKR-Assistant Helper (GPU).app/Contents/MacOS/IBKR-Assistant Helper (GPU) --type=gpu-process`,
  `  504  51200  0.0 ${APP}/Frameworks/IBKR-Assistant Helper.app/Contents/MacOS/IBKR-Assistant Helper --type=utility`,
  `  505 153600  2.0 ${APP}/MacOS/IBKR-Assistant ${APP}/Resources/engine-ts/dist/src/cli.js serve`,
  "  600  99999  9.9 /Applications/Safari.app/Contents/MacOS/Safari",
].join("\n");

describe("perf_snapshot", () => {
  it("按命令行归类:引擎先认(它和主进程是同一个可执行文件),别的应用不算", () => {
    expect(ps.parsePs(PS).map((r) => r.role)).toEqual(["main", "renderer", "gpu", "utility", "engine"]);
  });

  it("多次采样取中位数,另给最小与最大;合计是各类之和", () => {
    const one = ps.parsePs(PS);
    const bigger = one.map((r) => (r.role === "renderer" ? { ...r, rssKb: r.rssKb + 102_400 } : r));
    const s = ps.summarize([one, one, bigger]);
    expect(s.samples).toBe(3);
    expect(s.processes["renderer"]?.rss_mb).toEqual({ median: 300, min: 300, max: 400 });
    expect(s.processes["engine"]?.count).toBe(1);
    expect(s.total.rss_mb).toEqual({ median: 800, min: 800, max: 900 });
  });

  it("引擎起来到连上券商:每一次「启动引擎」配其后第一次「已连上」", () => {
    const log = [
      "[2026-10-15 18:56:35.192] [info]  [engine] [engine] 启动引擎(electron-as-node):…",
      "[2026-10-15 18:56:45.692] [info]  [engine] [link] 已连上:live",
      "[2026-10-15 18:57:00.000] [info]  [engine] [link] 已连上:paper",
      "[2026-10-16 09:00:00.000] [info]  [engine] [engine] 启动引擎(node):…",
      "[2026-10-16 09:00:12.000] [info]  [engine] [link] 已连上:live",
    ].join("\n");
    expect(ps.startupTimes(log)).toEqual([10_500, 12_000]);
  });
});
