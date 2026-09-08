/** RPC 三条道:本地道即来即答、读道并发、交易道严格顺序。
 *
 * 2026-09-08 用户反馈"移除板块成分股太慢":删一行只是一次 SQLite 写,却排在 sectors.quotes / pa.analyze
 * 这类等网络的请求后面。单线程不是瓶颈,"一次只处理一个"才是。 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { RpcServer } from "../src/rpc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeServer(): { server: RpcServer; chunks: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-lanes-"));
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
  const chunks: string[] = [];
  const server = new RpcServer(settingsPath, (line) => { chunks.push(line); });
  return { server, chunks };
}

/** 用假处理器替换方法表:只看调度,不碰券商。 */
function stub(server: RpcServer, table: Record<string, () => Promise<unknown> | unknown>): void {
  (server as any).methods = () => table;
}

async function run(server: RpcServer, chunks: string[], requests: Array<Record<string, unknown>>): Promise<Array<{ id: unknown; at: number }>> {
  const input = new PassThrough();
  const t0 = performance.now();
  const timed: Array<{ id: unknown; at: number }> = [];
  const origOut = (server as any).out as (line: string) => void;
  (server as any).out = (line: string) => {
    origOut(line);
    const m = JSON.parse(line);
    if (m["method"] !== "event") timed.push({ id: m["id"], at: performance.now() - t0 });
  };
  const done = server.serve(input);
  input.write(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
  input.end();
  await done;
  return timed;
}

describe("rpc serve: 三条道", () => {
  it("本地方法不等前面慢的读请求;交易道也不被读道挡住", async () => {
    const { server, chunks } = makeServer();
    // 时长留足余量:全量测试并行跑时机器很忙,只比"数量级",不比毫秒
    stub(server, {
      "pa.analyze": async () => { await sleep(500); return { lane: "read" }; },
      "instruction.submit": async () => { await sleep(60); return { lane: "serial" }; },
      "sectors.remove_stock": () => ({ lane: "local" }),
    });
    const timed = await run(server, chunks, [
      { jsonrpc: "2.0", id: 1, method: "pa.analyze", params: {} },
      { jsonrpc: "2.0", id: 2, method: "instruction.submit", params: {} },
      { jsonrpc: "2.0", id: 3, method: "sectors.remove_stock", params: {} },
    ]);
    expect(timed.map((t) => t.id)).toEqual([3, 2, 1]);
    const at = Object.fromEntries(timed.map((t) => [String(t.id), t.at]));
    expect(at["3"]).toBeLessThan(250);  // 本地道:不等 500 ms 的读
    expect(at["2"]).toBeLessThan(350);  // 交易道:只等自己的 60 ms,不等读
  });

  it("读道并发:两个 400 ms 的读请求一起跑完,不是串行 800 ms", async () => {
    const { server, chunks } = makeServer();
    stub(server, {
      "pa.analyze": async () => { await sleep(400); return {}; },
      "book.snapshot": async () => { await sleep(400); return {}; },
    });
    const timed = await run(server, chunks, [
      { jsonrpc: "2.0", id: 1, method: "pa.analyze", params: {} },
      { jsonrpc: "2.0", id: 2, method: "book.snapshot", params: {} },
    ]);
    expect(timed).toHaveLength(2);
    expect(Math.max(...timed.map((t) => t.at))).toBeLessThan(700);
  });

  it("交易道仍然严格顺序,用户请求插到轮询前面;EOF 后等所有在途请求答完才退出", async () => {
    const { server, chunks } = makeServer();
    const order: string[] = [];
    stub(server, {
      "pending.poll": async () => { order.push("poll"); await sleep(20); return {}; },
      "instruction.submit": async () => { order.push("submit"); await sleep(20); return {}; },
      "pa.analyze": async () => { await sleep(80); order.push("read-done"); return {}; },
    });
    const timed = await run(server, chunks, [
      { jsonrpc: "2.0", id: 1, method: "pa.analyze", params: {} },
      { jsonrpc: "2.0", id: 2, method: "pending.poll", params: {} },
      { jsonrpc: "2.0", id: 3, method: "instruction.submit", params: {} },
    ]);
    expect(order).toEqual(["submit", "poll", "read-done"]);
    expect(timed.map((t) => t.id).sort()).toEqual([1, 2, 3]); // 三个都答了,serve 没有提前退出
  });
});
