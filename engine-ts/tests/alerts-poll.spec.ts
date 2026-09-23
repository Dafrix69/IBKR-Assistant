/** alerts.poll:盯价位那一轮。价一次取齐(MarketDataService.spotsOf),不再逐只各等一拍。
 * 2026-09-23 日志:23 只在盯,alerts.poll 稳定 3.5 秒(每只 streamQuotes 各 settle 150 ms),占着交易道。全部离线。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { RpcServer } from "../src/rpc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

class FakeRouter {
  batches: string[][] = [];
  indexCalls: string[] = [];
  /** 一次问多只时抛错(模拟批量那一下出事);单只照常 */
  failBatch = false;
  quotes: Record<string, number> = { AAA: 101, BBB: 50 };
  sessions(): unknown[] {
    return [{}];
  }
  connectedNames(): string[] {
    return ["paper"];
  }
  async streamQuotes(symbols: string[]): Promise<Record<string, Rec>> {
    this.batches.push([...symbols]);
    if (this.failBatch && symbols.length > 1) throw new Error("行情线路满了");
    const out: Record<string, Rec> = {};
    for (const s of symbols) if (this.quotes[s] !== undefined) out[s] = { last: this.quotes[s] };
    return out;
  }
  async indexPrice(symbol: string): Promise<number | null> {
    this.indexCalls.push(symbol);
    return 7700;
  }
}

const servers: RpcServer[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.anomaly.stop();
    s.engineBuilt?.stopTrackerLoop();
  }
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上 sqlite 句柄可能还占着 */
    }
  }
});

function makeServer(): { s: RpcServer; router: FakeRouter; call: (m: string, p?: Rec) => Promise<Rec> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-alerts-poll-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
  const s = new RpcServer(settingsPath, () => undefined);
  void s.engine; // 先建引擎(那时还没 router,不起盯盘节拍器),再挂假 router
  servers.push(s);
  const router = new FakeRouter();
  s.router = router as never;
  const store = s.engine.store;
  // AAA 上次 99、价位 100:这一轮到 101 → 上穿;BBB、CCC、SPX 只是在盯。DDD 关了、EEE 没价位:都不问价
  for (const [symbol, last, enabled, levels] of [
    ["AAA", 99, true, [100]], ["BBB", 49, true, [60]], ["CCC", 10, true, [20]], ["SPX", 7690, true, [7800]],
    ["DDD", 5, false, [6]], ["EEE", 5, true, []],
  ] as Array<[string, number, boolean, number[]]>) {
    const w = store.addWatch(symbol);
    store.updateWatch(w["id"], {
      enabled, last_price: last,
      levels: levels.map((price) => ({ price, label: `${price} 整数关口`, source: "round", kind: "pivot" })),
    });
  }
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { s, router, call };
}

describe("alerts.poll", () => {
  it("非指数的价一次取齐(只问一次);指数走 indexPrice;关了的、没价位的不问", async () => {
    const { router, call } = makeServer();
    const r = (await call("alerts.poll"))["result"];
    expect(router.batches).toEqual([["AAA", "BBB", "CCC"]]);
    expect(router.indexCalls).toEqual(["SPX"]);
    expect(r["checked"]).toEqual([
      { symbol: "AAA", price: 101 }, { symbol: "BBB", price: 50 }, { symbol: "CCC", price: null }, { symbol: "SPX", price: 7700 },
    ]);
  });

  it("穿越照报;取不到价的那只这一轮不检查、不动它的状态", async () => {
    const { s, call } = makeServer();
    const r = (await call("alerts.poll"))["result"];
    expect(r["fired"].map((e: Rec) => [e["symbol"], e["direction"]])).toEqual([["AAA", "up"]]);
    const byName = Object.fromEntries(s.engine.store.listWatches().map((w) => [w["symbol"], w]));
    expect(byName["AAA"]!["last_price"]).toBe(101);
    expect(byName["CCC"]!["last_price"]).toBe(10);
  });

  it("批量那一下抛错:退回逐只问,单只的价照样拿到", async () => {
    const { router, call } = makeServer();
    router.failBatch = true;
    const r = (await call("alerts.poll"))["result"];
    expect(router.batches).toEqual([["AAA", "BBB", "CCC"], ["AAA"], ["BBB"], ["CCC"]]);
    expect(r["checked"].map((c: Rec) => c["price"])).toEqual([101, 50, null, 7700]);
  });
});
