/** alerts.poll:盯价位那一轮。价一次取齐(MarketDataService.spotsOf),不再逐只各等一拍。
 * 2026-09-23 日志:23 只在盯,alerts.poll 稳定 3.5 秒(每只 streamQuotes 各 settle 150 ms),占着交易道。
 * 2026-09-25 起同一轮里还判「短期内反复碰均线」:底账由 tickTouch 从日线补,poll 只拿现价补今天。全部离线。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { setClock } from "../src/config.js";
import { RpcServer } from "../src/rpc.js";
import { AlertsService } from "../src/services/alerts.js";
import { NVDA } from "./nvdaDaily.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

class FakeRouter {
  batches: string[][] = [];
  indexCalls: string[] = [];
  /** 一次问多只时抛错(模拟批量那一下出事);单只照常 */
  failBatch = false;
  quotes: Record<string, number> = { AAA: 101, BBB: 50 };
  /** 日线:截到 end(券商盘中会把当天那根半截的一并给回来) */
  history: Record<string, Rec[]> = {};
  historyCalls: string[] = [];
  failHistory = false;
  async historicalBars(symbol: string, _start: string, end: string): Promise<Rec[]> {
    this.historyCalls.push(symbol);
    if (this.failHistory) throw new Error("没有历史数据权限");
    return (this.history[symbol] ?? []).filter((b) => String(b["date"]) <= end);
  }
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
  setClock(null);
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

function bareServer(): { s: RpcServer; router: FakeRouter; call: (m: string, p?: Rec) => Promise<Rec> } {
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
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { s, router, call };
}

function makeServer(): { s: RpcServer; router: FakeRouter; call: (m: string, p?: Rec) => Promise<Rec> } {
  const { s, router, call } = bareServer();
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

// ---------------------------------------------------------------- 短期内反复碰均线
const ET = (local: string): number => Date.parse(`${local}-04:00`);
const THU_1100 = ET("2026-09-24T11:00:00"); // NVDA 这天第 3 次碰 20 日线(09-10~11、09-17~18 之后)

/** 盯着 NVDA 的一台引擎:日线是真实的 NVDA,只看 20 日线。 */
async function touchServer(
  levels: Rec[] = [{ price: 300, label: "整数关口 300", source: "round", kind: "pivot" }],
  last = 219,
) {
  const t = bareServer();
  t.router.history["NVDA"] = NVDA;
  const w = t.s.engine.store.addWatch("NVDA");
  const id = String(w["id"]);
  t.s.engine.store.updateWatch(id, { last_price: last, levels: levels as never });
  const set = await t.call("alerts.set_touch_config", { config: { periods: [20] } });
  expect(set["result"]["config"]["periods"]).toEqual([20]);
  return { ...t, id, watch: () => t.s.engine.store.getWatch(id)! };
}

describe("碰均线:底账", () => {
  it("tickTouch 从日线补底账(当天那根半截的不用);补好了就不再拉", async () => {
    const { s, router, watch } = await touchServer();
    expect(await s.alerts.tickTouch(THU_1100, true)).toBe("NVDA");
    const book = watch()["touch"]!;
    expect(book.as_of).toBe("2026-09-23");
    expect(book.lines.map((l) => [l.period, l.episodes.map((e) => e.start)])).toEqual([
      [20, ["2026-09-10", "2026-09-17"]],
    ]);
    expect(await s.alerts.tickTouch(THU_1100 + 5000, true)).toBeNull();
    expect(router.historyCalls).toEqual(["NVDA"]);
  });

  it("异动那一轮里:价位这一步没干活才轮到它(一轮最多一次历史请求)", async () => {
    const { s, id } = await touchServer();
    // 价位是今天开盘后算的(updateWatch 盖的是真实时钟,这里钉成 09-24 10:00 ET),tickLevels 不挑它
    s.engine.store.rawExec("UPDATE alert_watches SET updated_at=? WHERE id=?", ["2026-09-24T14:00:00+00:00", id]);
    const out = await s.anomaly.tickOnce(THU_1100);
    expect(out["levels"]).toBeNull();
    expect(out["touch"]).toBe("NVDA");
  });

  it("日线拿不到:这只今天不判,半小时后再试;周末不拉;关掉就不拉", async () => {
    const { s, router, watch } = await touchServer();
    router.failHistory = true;
    expect(await s.alerts.tickTouch(THU_1100, true)).toBe("NVDA");
    expect(watch()["touch"]).toBeNull();
    expect(await s.alerts.tickTouch(THU_1100 + AlertsService.TOUCH_BACKOFF_MS - 1000, true)).toBeNull();
    router.failHistory = false;
    expect(await s.alerts.tickTouch(THU_1100 + AlertsService.TOUCH_BACKOFF_MS + 1000, true)).toBe("NVDA");
    expect(watch()["touch"]!.as_of).toBe("2026-09-23");

    const other = await touchServer();
    expect(await other.s.alerts.tickTouch(ET("2026-09-26T10:00:00"), true)).toBeNull(); // 周六
    await other.call("alerts.set_touch_config", { config: { enabled: false } });
    expect(await other.s.alerts.tickTouch(THU_1100, true)).toBeNull();
    expect(other.router.historyCalls).toEqual([]);
  });

  it("改了口径:底账对不上就重算,不等退避", async () => {
    const { s, call, watch } = await touchServer();
    await s.alerts.tickTouch(THU_1100, true);
    expect(watch()["touch"]!.window_days).toBe(10);
    await call("alerts.set_touch_config", { config: { window_days: 15 } });
    expect(await s.alerts.tickTouch(THU_1100 + 5000, true)).toBe("NVDA");
    expect(watch()["touch"]!.window_days).toBe(15);
  });
});

describe("碰均线:盘中", () => {
  it("09-24 第 3 次碰 20 日线:报一次、落库;再碰不重报", async () => {
    const { s, router, call, watch } = await touchServer();
    await s.alerts.tickTouch(THU_1100, true);
    setClock(THU_1100);
    router.quotes["NVDA"] = 222;
    const fired = (await call("alerts.poll"))["result"]["fired"] as Rec[];
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      symbol: "NVDA", trigger: "touch", source: "ma20", label: "20日均线", kind: "support", direction: "down",
    });
    expect(String(fired[0]!["text"])).toBe(
      "近 10 个交易日第 3 次碰 20日均线 221.77(之前 09-10~09-11、09-17~09-18,收盘有上有下;今天,现价 222.00)",
    );
    expect(watch()["touch"]!.fired).toEqual({ "20": "2026-09-24" });
    expect(watch()["events"].map((e) => e["trigger"])).toEqual(["touch"]);

    router.quotes["NVDA"] = 221.9;
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
  });

  it("同一条均线这一轮的穿越并进碰均线那一条,不说两遍;别的价位的穿越照报", async () => {
    const levels = [
      { price: 220, label: "整数关口 220", source: "round", kind: "pivot" },
      { price: 221.5, label: "20日均线", source: "ma20", kind: "support" },
    ];
    const { s, router, call } = await touchServer(levels, 219);
    await s.alerts.tickTouch(THU_1100, true);
    setClock(THU_1100);
    router.quotes["NVDA"] = 222;
    const fired = (await call("alerts.poll"))["result"]["fired"] as Rec[];
    expect(fired.map((e) => [e["trigger"], e["source"]])).toEqual([["cross", "round"], ["touch", "ma20"]]);
  });

  it("碰均线先报(容差内、还没到线),几轮之后真穿过那条线:不再报一遍穿越", async () => {
    // 容差 0.3% 让碰均线在价格贴近时就报了;10 秒一轮,真穿过去往往是几轮之后的事,不是同一轮
    const levels = [{ price: 221.5, label: "20日均线", source: "ma20", kind: "support" }];
    const { s, router, call, watch } = await touchServer(levels, 220.9);
    await s.alerts.tickTouch(THU_1100, true);
    setClock(THU_1100);
    router.quotes["NVDA"] = 221.1; // 离盘中均线(≈221.73)0.63 < 0.665:碰到;还没到 221.5 那个价位
    expect(((await call("alerts.poll"))["result"]["fired"] as Rec[]).map((e) => e["trigger"])).toEqual(["touch"]);
    router.quotes["NVDA"] = 221.6; // 这一轮跨过了 221.5
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
    // 那条线的穿越是落防,不是删掉:离开够远、过了冷却照常重新上膛
    expect(watch()["states"]["221.5000"]).toMatchObject({ armed: false });
  });

  it("隔夜跳空跨过均线不算碰;同一个交易日两轮之间跨过才算", async () => {
    const { s, router, call } = await touchServer(undefined, 219); // 库里的 219 是昨天的价
    await s.alerts.tickTouch(THU_1100, true);
    setClock(ET("2026-09-24T09:31:00"));
    router.quotes["NVDA"] = 225; // 离均线 3 块多:没碰;和昨天的 219 之间跨过均线也不算
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
    router.quotes["NVDA"] = 219; // 这一轮和上一轮(225)之间跨过去了
    const fired = (await call("alerts.poll"))["result"]["fired"] as Rec[];
    expect(fired.map((e) => [e["trigger"], e["direction"], e["from"], e["to"]])).toEqual([["touch", "down", 225, 219]]);
  });

  it("盘前、盘后、底账是前天的:都不判", async () => {
    const { s, router, call } = await touchServer();
    await s.alerts.tickTouch(THU_1100, true);
    router.quotes["NVDA"] = 222;
    setClock(ET("2026-09-24T09:10:00"));
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
    setClock(ET("2026-09-24T16:05:00"));
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
    // 第二天盘中:底账还是 09-23 收盘的(tickTouch 还没轮到它),窗口错一天,宁可不判
    setClock(ET("2026-09-25T11:00:00"));
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
  });
});

describe("碰均线:设置", () => {
  it("alerts.list 带着口径;改一两项在当前那份上合并;越界给中文原因、不落库", async () => {
    const { call } = bareServer();
    expect((await call("alerts.list"))["result"]["touch_config"]).toEqual({
      enabled: true, periods: [20, 60, 120, 200], window_days: 10, min_touches: 3, band_pct: 0.3,
    });
    const ok = await call("alerts.set_touch_config", { config: { periods: ["50", 20], window_days: "12" } });
    expect(ok["result"]["config"]).toEqual({ enabled: true, periods: [20, 50], window_days: 12, min_touches: 3, band_pct: 0.3 });
    const bad = await call("alerts.set_touch_config", { config: { window_days: 4 } });
    expect(bad["error"]).toMatchObject({
      code: -32602, message: "4 个交易日里最多只能分出 2 段触碰(连着几天贴着线只算一次),起报次数 3 永远凑不够",
    });
    expect((await call("alerts.set_touch_config", { config: "x" }))["error"]["code"]).toBe(-32602);
    expect((await call("alerts.list"))["result"]["touch_config"]["window_days"]).toBe(12);
  });
});
