/** RPC 的耗时分两段记(src/rpc/perfLog.ts):在道上排了多久、执行了多久。
 *
 * 2026-10-18 量 main.log 时,「慢请求」只有执行时长:一条慢请求是自己慢还是排在别人后面,只能猜
 * (docs/journal/sleep-read-as-stall.md)。钉的是:
 *  1. 分位数是最近秩,汇总写完清零,一个请求都没有不写;
 *  2. 慢请求那一行格式照旧(数字是执行时长),排队超过 100 ms 才补「排队 N ms」;
 *  3. 接进 serve:交易道上排在慢请求后面的那一个,记下来的排队时长就是前面那个执行的时长;EOF 时写一行 `[perf]`。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RpcServer } from "../src/rpc.js";
import { MAX_SAMPLES, RpcTimings, quantile, slowLine } from "../src/rpc/perfLog.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("分位数与慢请求那一行", () => {
  it("最近秩:十个样本的 p50 是第 5 个、p90 是第 9 个、p99 是第 10 个;没有样本是 0", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect([quantile(xs, 0.5), quantile(xs, 0.9), quantile(xs, 0.99)]).toEqual([5, 9, 10]);
    expect(quantile([], 0.5)).toBe(0);
  });

  it("格式照旧,数字是执行时长;排队超过 100 ms 才写出来;两段都不慢不写", () => {
    expect(slowLine("options.spot", 3, 12_001.4, 1000)).toBe("[rpc] 慢请求 options.spot 12001 ms");
    expect(slowLine("positions.list", 11_500, 40, 1000)).toBe("[rpc] 慢请求 positions.list 40 ms,排队 11500 ms");
    expect(slowLine("positions.list", 99, 1_200, 1000)).toBe("[rpc] 慢请求 positions.list 1200 ms");
    expect(slowLine("tracker.poll", 500, 500, 1000)).toBeNull();
  });
});

describe("RpcTimings", () => {
  it("一窗口的汇总:按方法、带道、两段各自的分位数;写完清零,空窗口不写", () => {
    const t = new RpcTimings(Date.parse("2026-10-18T00:00:00Z"));
    for (const ms of [10, 20, 30, 40, 12_000]) t.record("options.spot", "read", 1, ms);
    t.record("instruction.submit", "trade", 900, 50);
    const line = t.flush(Date.parse("2026-10-18T00:10:00Z"), { qualify: { timeouts: 1, skipped: 4, probes: 0 } });
    expect(line?.startsWith("[perf] ")).toBe(true);
    const body = JSON.parse(line!.slice("[perf] ".length));
    expect(body.window).toEqual({ from: "2026-10-18T00:00:00.000Z", to: "2026-10-18T00:10:00.000Z" });
    expect(body.methods["options.spot"]).toEqual({
      lane: "read", n: 5, run: { p50: 30, p90: 12_000, p99: 12_000, max: 12_000 }, wait: { p50: 1, p90: 1, p99: 1, max: 1 },
    });
    expect(body.methods["instruction.submit"].wait.max).toBe(900);
    expect(body.qualify).toEqual({ timeouts: 1, skipped: 4, probes: 0 });
    expect(t.flush()).toBeNull();
  });

  it("样本满了按蓄水池抽样,次数与最大值照记", () => {
    const t = new RpcTimings(0, () => 0.999_999);
    for (let i = 0; i < MAX_SAMPLES + 10; i += 1) t.record("pa.analyze", "read", 0, 1);
    t.record("pa.analyze", "read", 0, 99_000);
    const s = t.summary()["pa.analyze"]!;
    expect(s.n).toBe(MAX_SAMPLES + 11);
    expect(s.run.max).toBe(99_000);
  });
});

describe("接进 serve", () => {
  it("交易道上排在慢请求后面的那一个:记下来的排队时长 ≈ 前面那个的执行时长;EOF 写一行 [perf]", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-perf-"));
    const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
    const server = new RpcServer(settingsPath, () => undefined);
    (server as unknown as { methods: () => Record<string, () => Promise<unknown>> }).methods = () => ({
      "instruction.submit": async () => { await sleep(300); return {}; },
      "tracker.add": async () => { await sleep(5); return {}; },
    });
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    });

    const input = new PassThrough();
    const done = server.serve(input);
    input.write([
      { jsonrpc: "2.0", id: 1, method: "instruction.submit", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tracker.add", params: {} },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    input.end();
    await done;

    const perf = err.join("").split("\n").find((l) => l.startsWith("[perf] "));
    expect(perf, "EOF 时写一行汇总").toBeDefined();
    const methods = JSON.parse(perf!.slice("[perf] ".length)).methods;
    expect(methods["tracker.add"].lane).toBe("trade");
    expect(methods["tracker.add"].wait.max, "排在 300 ms 的那一个后面").toBeGreaterThanOrEqual(200);
    expect(methods["instruction.submit"].wait.max).toBeLessThan(200);
  });

  it("道的归属与调度表一致", () => {
    expect(RpcServer.laneOf("options.spot")).toBe("read");
    expect(RpcServer.laneOf("tracker.poll")).toBe("local");
    expect(RpcServer.laneOf("instruction.submit")).toBe("trade");
  });
});
