/** alerts.poll:盯价位那一轮。价一次取齐(MarketDataService.spotsOf),不再逐只各等一拍。
 * 2026-09-23 日志:23 只在盯,alerts.poll 稳定 3.5 秒(每只 streamQuotes 各 settle 150 ms),占着交易道。
 * 2026-09-25 起同一轮里还判「短期内反复碰均线」:底账由 tickTouch 从日线补,poll 只拿现价补今天。全部离线。
 * 判穿越用的"上一笔"是引擎内存里紧挨着的那一轮(同一段、不超过冷却那么久),而且得是坐实了的这一段里的真价:
 * 隔夜跳空、引擎刚起来、断了很久之后,要先看到价动过一次(那一笔是基准)才开始比——钟过了 09:30、
 * 开盘那一笔还没进来时,手上的价还是盘前的,不能拿它当基准。
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
  /** 最后成交的时刻(秒)。给了才带在报价里——真券商那条报价路带不带,要看 broker.streamQuotes 转不转 */
  tradedAt: Record<string, number> = {};
  async streamQuotes(symbols: string[]): Promise<Record<string, Rec>> {
    this.batches.push([...symbols]);
    if (this.failBatch && symbols.length > 1) throw new Error("行情线路满了");
    const out: Record<string, Rec> = {};
    for (const s of symbols) {
      if (this.quotes[s] === undefined) continue;
      out[s] = { last: this.quotes[s], ...(this.tradedAt[s] !== undefined ? { last_trade_at: this.tradedAt[s] } : {}) };
    }
    return out;
  }
  /** 指数的价与它的出处(index = 官方指数,futures = 期货推算,index_stale = 推不出来时的上一个收盘) */
  index = { price: 7700, source: "index" };
  async indexPrice(symbol: string): Promise<number | null> {
    this.indexCalls.push(symbol);
    return this.index.price;
  }
  spotInfo(_symbol: string): Rec {
    return { price: this.index.price, source: this.index.source, note: "" };
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
  // AAA 价位 100、现价 101;BBB、CCC、SPX 只是在盯。DDD 关了、EEE 没价位:都不问价。
  // 这几只的现价都正好压在整数关口上(步长自动):poll 不会把手摆的这几个价位换成现价两侧的那一对
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
    const { s, router, call } = makeServer();
    setClock(Date.parse("2026-09-24T11:00:00-04:00")); // 两轮钉在同一个时段里:接不接得上要看钟
    // 引擎刚起来的第一轮只登记:库里的 last_price(99)不知道是什么时候的价;要先看到价动过一次,动过的那一笔才是基准
    router.quotes["AAA"] = 98;
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
    router.quotes["AAA"] = 99;
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
    router.quotes["AAA"] = 101;
    const r = (await call("alerts.poll"))["result"];
    expect(r["fired"].map((e: Rec) => [e["symbol"], e["direction"], e["from"], e["to"]])).toEqual([["AAA", "up", 99, 101]]);
    const byName = Object.fromEntries(s.engine.store.listWatches().map((w) => [w["symbol"], w]));
    expect(byName["AAA"]!["last_price"]).toBe(101);
    expect(byName["AAA"]!["states"]).toEqual({ "round@100.0000": { armed: false, last_fired_at: expect.any(Number) } });
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

/** 引擎刚起来(或断过)之后要先看到价动过一次才开始比、才判碰均线:先喂两笔不一样的价,第二笔就是坐实了的"上一笔"。 */
async function settle(
  t: { router: FakeRouter; call: (m: string, p?: Rec) => Promise<Rec> }, symbol: string, first: number, second: number,
): Promise<void> {
  t.router.quotes[symbol] = first;
  expect((await t.call("alerts.poll"))["result"]["fired"]).toEqual([]);
  t.router.quotes[symbol] = second;
  expect((await t.call("alerts.poll"))["result"]["fired"]).toEqual([]);
}

/** 盯着 NVDA 的一台引擎:日线是真实的 NVDA,只看 20 日线。步长给得大(整数关口在 200 / 300,碍不着 220 上下这些用例)。 */
async function touchServer(
  levels: Rec[] = [{ price: 300, label: "整数关口 300", source: "round", kind: "pivot" }],
  last = 219,
  step = 100,
) {
  const t = bareServer();
  t.router.history["NVDA"] = NVDA;
  const w = t.s.engine.store.addWatch("NVDA", step);
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
    // 价位是今天开盘后算的(levels_at = 09-24 10:00 ET),tickLevels 不挑它
    s.engine.store.updateWatch(id, { levels_at: "2026-09-24T14:00:00+00:00" });
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
    // 引擎刚起来的第一笔不判:它是不是这一段里的真价还不知道(开盘那一刻手上可能是盘前的价)。动过一次之后才判
    router.quotes["NVDA"] = 225;
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
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
    const t = await touchServer(levels, 219, 20); // 步长 20:220 是整数关口
    const { s, router, call } = t;
    await s.alerts.tickTouch(THU_1100, true);
    setClock(THU_1100);
    await settle(t, "NVDA", 218.5, 219); // 上一轮:离均线两块多,没碰
    router.quotes["NVDA"] = 222; // 这一轮跨过 220、221.5 两个价位,也碰到了均线
    const fired = (await call("alerts.poll"))["result"]["fired"] as Rec[];
    expect(fired.map((e) => [e["trigger"], e["source"]])).toEqual([["cross", "round"], ["touch", "ma20"]]);
  });

  it("碰均线先报(容差内、还没到线),几轮之后真穿过那条线:不再报一遍穿越", async () => {
    // 容差 0.3% 让碰均线在价格贴近时就报了;10 秒一轮,真穿过去往往是几轮之后的事,不是同一轮
    const levels = [{ price: 221.5, label: "20日均线", source: "ma20", kind: "support" }];
    const { s, router, call, watch } = await touchServer(levels, 220.9);
    await s.alerts.tickTouch(THU_1100, true);
    setClock(THU_1100);
    router.quotes["NVDA"] = 220.5; // 引擎刚起来的第一笔:只登记
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
    router.quotes["NVDA"] = 221.1; // 离盘中均线(≈221.73)0.63 < 0.665:碰到;还没到 221.5 那个价位
    expect(((await call("alerts.poll"))["result"]["fired"] as Rec[]).map((e) => e["trigger"])).toEqual(["touch"]);
    router.quotes["NVDA"] = 221.6; // 这一轮跨过了 221.5
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
    // 那条线的穿越是落防,不是删掉:离开够远、过了冷却照常重新上膛
    expect(watch()["states"]["ma20"]).toMatchObject({ armed: false });
  });

  it("谁认领是定死的:碰均线报了的那条线归它,成绩单只记一笔、押回头;没被认领的穿越押顺势", async () => {
    // 带着收盘和的 20 日线(和底账同一个数,盘中在 ≈221.7)+ 一个以墙为主、把 20 日线并进去的价位(来源是墙)
    const { s, router, call, watch } = await touchServer([], 219);
    await s.alerts.tickTouch(THU_1100, true);
    const prior = watch()["touch"]!.lines[0]!.prior_sum;
    s.engine.store.updateWatch(watch()["id"], {
      levels: [
        { price: 221.6, label: "上方持仓墙 + 20日均线", source: "call_wall", kind: "resistance" },
        { price: 221.7, label: "20日均线", source: "ma20", kind: "resistance", ma: { period: 20, prior_sum: prior } },
      ],
    });
    setClock(THU_1100);
    await settle({ router, call }, "NVDA", 218.5, 219);
    router.quotes["NVDA"] = 222; // 一轮里:穿过墙那个价位、穿过 20 日线、也是第 3 次碰 20 日线
    const fired = (await call("alerts.poll"))["result"]["fired"] as Rec[];
    // 20 日线的穿越归碰均线(并掉);墙那个价位认的是来源,不归它,照报
    expect(fired.map((e) => [e["trigger"], e["source"], e["direction"]])).toEqual([
      ["cross", "call_wall", "up"], ["touch", "ma20", "up"],
    ]);
    expect(s.engine.store.signals.list().map((x) => [x.source, x.label, x.expect])).toEqual([
      ["cross", "上方持仓墙 + 20日均线", "up"], // 顺势:穿过去的方向
      ["touch", "20日均线", "down"], // 回头:从下方反抽上来,押回到线下
    ]);
    expect(watch()["states"]["ma20"]).toMatchObject({ armed: false }); // 那条线的穿越落防,不会隔几轮再记一笔顺势

    // 碰均线不判的时候(这里是关掉)不认领:同一条线的穿越照自己的规矩报、押顺势
    const off = await touchServer([], 219);
    await off.call("alerts.set_touch_config", { config: { enabled: false } });
    off.s.engine.store.updateWatch(off.watch()["id"], {
      levels: [{ price: 221.7, label: "20日均线", source: "ma20", kind: "resistance", ma: { period: 20, prior_sum: prior } }],
    });
    setClock(THU_1100);
    await settle(off, "NVDA", 218.5, 219);
    off.router.quotes["NVDA"] = 222;
    const plain = (await off.call("alerts.poll"))["result"]["fired"] as Rec[];
    expect(plain.map((e) => [e["trigger"], e["source"], e["direction"]])).toEqual([["cross", "ma20", "up"]]);
    expect(off.s.engine.store.signals.list().map((x) => [x.source, x.expect])).toEqual([["cross", "up"]]);
  });

  it("开着 1 分钟收盘确认:碰均线认领了那条线,它等确认的那一笔穿越一起作废,下一分钟不补报", async () => {
    const { s, router, call, watch } = await touchServer([], 219);
    await call("alerts.set_touch_config", { config: {}, cross_confirm: "bar_close" });
    await s.alerts.tickTouch(THU_1100, true);
    const prior = watch()["touch"]!.lines[0]!.prior_sum;
    s.engine.store.updateWatch(watch()["id"], {
      levels: [{ price: 221.7, label: "20日均线", source: "ma20", kind: "resistance", ma: { period: 20, prior_sum: prior } }],
    });
    setClock(THU_1100);
    await settle({ router, call }, "NVDA", 218.5, 219);
    setClock(THU_1100 + 10_000);
    router.quotes["NVDA"] = 222; // 跨过了 20 日线:穿越记了一笔待确认;同一轮碰均线也报了
    const fired = (await call("alerts.poll"))["result"]["fired"] as Rec[];
    expect(fired.map((e) => e["trigger"])).toEqual(["touch"]);
    expect(watch()["states"]["ma20"]).toEqual({ armed: false, last_fired_at: (THU_1100 + 10_000) / 1000 });
    setClock(THU_1100 + 70_000); // 那一分钟收完了,价还在线上:没有待确认的了,不报
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
  });

  it("开盘后价位还没轮到重算:均线的穿越用底账里今天的收盘和,不用价位上那个旧的;底账旧了才用价位自己的", async () => {
    const { s, router, call, watch } = await touchServer([], 219);
    await call("alerts.set_touch_config", { config: { min_touches: 5 } }); // 碰均线凑不够次数,不认领:只看穿越
    await s.alerts.tickTouch(THU_1100, true);
    const fresh = watch()["touch"]!.lines[0]!.prior_sum; // 线在 fresh / 19 ≈ 221.76 与现价相遇
    const stale = fresh - 19 * 2; // 价位上那个和是昨天早上算的:线低了 2 块
    s.engine.store.updateWatch(watch()["id"], {
      levels: [{ price: 219.8, label: "20日均线", source: "ma20", kind: "support", ma: { period: 20, prior_sum: stale } }],
    });
    setClock(THU_1100);
    await settle({ router, call }, "NVDA", 220.8, 221);
    router.quotes["NVDA"] = 222.2; // 跨过今天的线(≈221.76);按旧的和算,两笔都在线上方,不算穿过
    const fired = (await call("alerts.poll"))["result"]["fired"] as Rec[];
    expect(fired.map((e) => [e["trigger"], e["source"], e["direction"]])).toEqual([["cross", "ma20", "up"]]);
    expect(fired[0]!["price"]).toBeCloseTo((fresh + 222.2) / 20, 4);
    const ma20 = async (): Promise<Rec> =>
      ((await call("alerts.list"))["result"]["watches"][0]["levels"] as Rec[]).find((l) => l["source"] === "ma20")!;
    expect((await ma20())["price"]).toBeCloseTo((fresh + 222.2) / 20, 4);

    // 第二天:底账还是 09-23 收盘的(旧了),用价位自己带的那个和
    setClock(ET("2026-09-25T11:00:00"));
    expect((await ma20())["price"]).toBeCloseTo((stale + 222.2) / 20, 4);
  });

  it("隔夜跳空跨过均线不算碰;同一个交易日两轮之间跨过才算", async () => {
    const { s, router, call } = await touchServer(undefined, 219); // 库里的 219 是昨天的价
    await s.alerts.tickTouch(THU_1100, true);
    setClock(ET("2026-09-24T09:31:00"));
    router.quotes["NVDA"] = 226; // 今天的第一笔:只登记
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
    router.quotes["NVDA"] = 225; // 动过了,是今天的真价。离均线 3 块多:没碰;和昨天的 219 之间跨过均线也不算
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
    router.quotes["NVDA"] = 219; // 这一轮和上一轮(225)之间跨过去了
    const fired = (await call("alerts.poll"))["result"]["fired"] as Rec[];
    expect(fired.map((e) => [e["trigger"], e["direction"], e["from"], e["to"]])).toEqual([["touch", "down", 225, 219]]);
  });

  it("钟到了 09:30、开盘那一笔还没进来:手上是盘前的价,贴着均线不算碰;开出来跳走了也不算两轮之间跨过", async () => {
    const { s, router, call, watch } = await touchServer(undefined, 219);
    await s.alerts.tickTouch(THU_1100, true);
    router.quotes["NVDA"] = 221.8; // 盘前最后一笔,正贴着 20 日线(≈221.76)
    setClock(ET("2026-09-24T09:29:50"));
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
    setClock(ET("2026-09-24T09:30:00")); // 常规时段的第一轮,价还是那一笔
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
    setClock(ET("2026-09-24T09:30:10"));
    router.quotes["NVDA"] = 219; // 开盘价:从 221.8 到 219 跨过了均线,但 221.8 不是今天常规时段里的价
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
    expect(watch()["touch"]!.fired).toEqual({});
    setClock(ET("2026-09-24T09:30:20"));
    router.quotes["NVDA"] = 221.9; // 这一轮是真的从线下反抽上来碰到了
    const fired = (await call("alerts.poll"))["result"]["fired"] as Rec[];
    expect(fired.map((e) => [e["trigger"], e["direction"], e["from"], e["to"]])).toEqual([["touch", "up", 219, 221.9]]);
  });

  it("盘前、盘后、底账是前天的:都不判", async () => {
    const t = await touchServer();
    const { s, call } = t;
    await s.alerts.tickTouch(THU_1100, true);
    // 每一段都先让价坐实(两笔不一样的价),第二笔正贴着均线:不判是因为时段 / 底账,不是因为第一笔只登记
    setClock(ET("2026-09-24T09:10:00"));
    await settle(t, "NVDA", 221.9, 222);
    setClock(ET("2026-09-24T16:05:00"));
    await settle(t, "NVDA", 221.9, 222);
    // 第二天盘中:底账还是 09-23 收盘的(tickTouch 还没轮到它),窗口错一天,宁可不判
    setClock(ET("2026-09-25T11:00:00"));
    await settle(t, "NVDA", 221.9, 222);
    // 对照:同样两笔放在 09-24 盘中就报
    const live = await touchServer();
    await live.s.alerts.tickTouch(THU_1100, true);
    setClock(THU_1100);
    live.router.quotes["NVDA"] = 221.9;
    await live.call("alerts.poll");
    live.router.quotes["NVDA"] = 222;
    expect(((await live.call("alerts.poll"))["result"]["fired"] as Rec[]).map((e) => e["trigger"])).toEqual(["touch"]);
    void call;
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

// ---------------------------------------------------------------- 上一笔接不上:只登记
/** 盯着 AAA 的一台引擎:整数关口步长 2(98 / 100 / 102…),现价由 router.quotes 给。 */
function gapServer(levels: number[] = [100, 102], symbol = "AAA") {
  const t = bareServer();
  const w = t.s.engine.store.addWatch(symbol, 2);
  const id = String(w["id"]);
  t.s.engine.store.updateWatch(id, {
    levels: levels.map((price) => ({ price, label: `整数关口 ${price}`, source: "round", kind: "pivot" })) as never,
  });
  /** tradedAt:这一笔是几点成交的(美东);不给 = 券商那条报价路没带成交时刻 */
  const poll = async (at: string, price: number, tradedAt?: string): Promise<Rec[]> => {
    setClock(ET(at));
    t.router.quotes[symbol] = price;
    if (tradedAt === undefined) delete t.router.tradedAt[symbol];
    else t.router.tradedAt[symbol] = ET(tradedAt) / 1000;
    return (await t.call("alerts.poll"))["result"]["fired"] as Rec[];
  };
  const crossed = (fired: Rec[]): Array<[number, string]> => fired.map((e) => [e["price"], e["direction"]]);
  return { ...t, id, poll, crossed, watch: () => t.s.engine.store.getWatch(id)! };
}

describe("穿越:跳空与久未取价之后只登记,要先看到价动过一次", () => {
  it("隔夜跳空越过价位不报成穿越(昨天收在 99.5,今天第一笔 103);之后真穿过去照报", async () => {
    const { poll, watch } = gapServer();
    expect(await poll("2026-09-23T15:59:40", 99.5)).toEqual([]);
    expect(await poll("2026-09-23T15:59:50", 99.4)).toEqual([]);
    // 应用关了一夜(或者开着:换了段)。今天开盘后的第一笔跳空到 103
    expect(await poll("2026-09-24T09:31:00", 103)).toEqual([]);
    expect(watch()["last_price"]).toBe(103);
    expect(Object.values(watch()["states"]).every((st) => st.armed)).toBe(true); // 没报过
    expect(await poll("2026-09-24T09:31:10", 103.2)).toEqual([]); // 动过了:这一笔是基准
    const fired = await poll("2026-09-24T09:31:20", 101.5);
    expect(fired.map((e) => [e["price"], e["direction"], e["from"], e["to"]])).toEqual([[102, "down", 103.2, 101.5]]);
  });

  it("钟过了 09:30、开盘那一笔还没进来:常规时段的第一轮拿到的还是盘前的价,不能拿它当基准把跳空报成穿越", async () => {
    const { poll, crossed } = gapServer();
    expect(await poll("2026-09-24T09:29:40", 99.5)).toEqual([]);
    expect(await poll("2026-09-24T09:29:50", 99.6)).toEqual([]);
    expect(await poll("2026-09-24T09:30:00", 99.6)).toEqual([]); // 钟到了盘中,价还是 09:29 那一笔
    expect(await poll("2026-09-24T09:30:10", 103)).toEqual([]); // 开盘价进来了:99.6 → 103 是跳空,不是「上穿 100、上穿 102」
    expect(crossed(await poll("2026-09-24T09:30:20", 101.5))).toEqual([[102, "down"]]); // 从这里起才比
  });

  it("常规时段的第一轮就已经是开盘价:同样只登记;停着不动(没开出来)的那几轮一直不算数", async () => {
    const { poll, crossed } = gapServer();
    expect(await poll("2026-09-24T09:29:50", 99.6)).toEqual([]);
    expect(await poll("2026-09-24T09:30:00", 103)).toEqual([]);
    expect(await poll("2026-09-24T09:30:10", 103)).toEqual([]);
    expect(await poll("2026-09-24T09:30:20", 103)).toEqual([]);
    expect(await poll("2026-09-24T09:30:30", 101.5)).toEqual([]); // 第一次动:它才是基准,不和不知道新旧的 103 比
    expect(crossed(await poll("2026-09-24T09:30:40", 99.5))).toEqual([[100, "down"]]);
  });

  it("隔得比冷却(5 分钟)还久:只登记,而且同样要先看到价动过一次;没超过的照常比", async () => {
    const { poll, crossed } = gapServer();
    expect(await poll("2026-09-24T10:00:00", 99.5)).toEqual([]);
    expect(await poll("2026-09-24T10:00:10", 99.6)).toEqual([]);
    // 断线 4 分钟回来:还算接得上
    expect(crossed(await poll("2026-09-24T10:04:00", 100.5))).toEqual([[100, "up"]]);
    // 电脑睡了半小时回来:第一笔可能还是睡之前留在流里的旧价
    expect(await poll("2026-09-24T10:34:00", 100.5)).toEqual([]);
    expect(await poll("2026-09-24T10:34:10", 103)).toEqual([]); // 新价到了:100.5 → 103 中间怎么走的不知道,不报
    expect(crossed(await poll("2026-09-24T10:34:20", 101))).toEqual([[102, "down"]]);
  });

  it("取不到价的那几轮不算一笔:恢复之后隔得久了同样只登记", async () => {
    const { router, call, poll } = gapServer();
    expect(await poll("2026-09-24T10:00:00", 99.5)).toEqual([]);
    expect(await poll("2026-09-24T10:00:10", 99.6)).toEqual([]);
    delete router.quotes["AAA"];
    setClock(ET("2026-09-24T10:03:00"));
    expect((await call("alerts.poll"))["result"]["checked"]).toEqual([{ symbol: "AAA", price: null }]);
    expect(await poll("2026-09-24T10:06:00", 103)).toEqual([]);
  });

  it("不盯了再盯:上一笔一起忘掉", async () => {
    const { s, poll } = gapServer();
    expect(await poll("2026-09-24T10:00:00", 99.5)).toEqual([]);
    expect(await poll("2026-09-24T10:00:10", 99.6)).toEqual([]);
    s.alerts.forget("AAA");
    expect(await poll("2026-09-24T10:00:20", 103)).toEqual([]); // 没忘的话这里是「上穿 100」
  });

  it("券商带了成交时刻:按成交的那一刻分段——开盘前的成交留在盘前那一段,开盘后的第一笔成交自己就是基准", async () => {
    const { poll, crossed } = gapServer();
    expect(await poll("2026-09-24T09:29:40", 99.5, "2026-09-24T09:29:38")).toEqual([]);
    expect(await poll("2026-09-24T09:29:50", 99.6, "2026-09-24T09:29:47")).toEqual([]);
    expect(await poll("2026-09-24T09:30:00", 99.6, "2026-09-24T09:29:47")).toEqual([]); // 钟到了盘中,成交还是盘前的
    expect(await poll("2026-09-24T09:30:10", 103, "2026-09-24T09:30:04")).toEqual([]); // 换段:跳空
    // 103 是常规时段里成交出来的价,不用再等它动一次
    expect(crossed(await poll("2026-09-24T09:30:20", 101.5, "2026-09-24T09:30:18"))).toEqual([[102, "down"]]);
  });

  it("券商带了成交时刻:收盘前后两轮之间真穿过去的,不因为取价的钟过了 16:00 就丢", async () => {
    const { poll, crossed } = gapServer();
    expect(await poll("2026-09-24T15:59:40", 99.5, "2026-09-24T15:59:38")).toEqual([]);
    expect(await poll("2026-09-24T15:59:50", 99.6, "2026-09-24T15:59:49")).toEqual([]);
    // 16:00:02 这一轮拿到的是 15:59:58 的成交:两笔都是盘中的价,照比
    expect(crossed(await poll("2026-09-24T16:00:02", 100.4, "2026-09-24T15:59:58"))).toEqual([[100, "up"]]);
    // 盘后的第一笔成交:换段,只登记
    expect(await poll("2026-09-24T16:00:12", 98.8, "2026-09-24T16:00:09")).toEqual([]);
    // 没带成交时刻的话,16:00:02 那一轮按取价的钟算成盘后,那次穿越就看不到了
    const blind = gapServer();
    await blind.poll("2026-09-24T15:59:40", 99.5);
    await blind.poll("2026-09-24T15:59:50", 99.6);
    expect(await blind.poll("2026-09-24T16:00:02", 100.4)).toEqual([]);
  });
});

describe("穿越:指数的价换了出处也是换段", () => {
  /** 盯着 SPX:整数关口 6700(步长 50)、6697 一个墙、6685 一条 Gamma 翻转位。价由 router.index 给。 */
  function spxServer() {
    const t = bareServer();
    const w = t.s.engine.store.addWatch("SPX", 50);
    const id = String(w["id"]);
    t.s.engine.store.updateWatch(id, {
      levels: [
        { price: 6685, label: "Gamma 翻转位", source: "gamma_flip", kind: "pivot" },
        { price: 6697, label: "下方持仓墙", source: "put_wall", kind: "support" },
        { price: 6700, label: "整数关口 6700", source: "round", kind: "pivot" },
      ],
    });
    const poll = async (at: string, price: number, source: string): Promise<Array<[number, string]>> => {
      setClock(ET(at));
      t.router.index = { price, source };
      return ((await t.call("alerts.poll"))["result"]["fired"] as Rec[]).map((e) => [e["price"], e["direction"]]);
    };
    return { ...t, poll };
  }

  it("09:30 从期货推算换成官方指数:换过来的第一笔、它第一次动的那一笔都只登记,之后才比", async () => {
    const { poll } = spxServer();
    expect(await poll("2026-09-24T09:29:40", 6650, "futures")).toEqual([]);
    expect(await poll("2026-09-24T09:29:50", 6651, "futures")).toEqual([]);
    // 官方指数的第一笔还是昨天收盘附近的数(成分股没开全),和期货推出来的 6651 不是一回事:不比
    expect(await poll("2026-09-24T09:30:00", 6701.3, "index")).toEqual([]);
    // 它动了,说明指数在常规时段里开始算了:这一笔是基准;6701.3 → 6694 不报「下破 6700 / 6697」
    expect(await poll("2026-09-24T09:30:10", 6694, "index")).toEqual([]);
    // 从这里起才比。指数开盘头一分钟是在追成分股陆续开出来的价,6694 → 6681 这一段照样会报——这一点数据里看不出来
    expect(await poll("2026-09-24T09:30:20", 6681, "index")).toEqual([[6685, "down"]]);
  });

  it("夜里期货推不出来、退回上一个收盘再推回来:两个数来回跳不是行情在走,不报", async () => {
    const { poll } = spxServer();
    expect(await poll("2026-09-24T02:00:00", 6650, "futures")).toEqual([]);
    expect(await poll("2026-09-24T02:00:10", 6651, "futures")).toEqual([]);
    expect(await poll("2026-09-24T02:00:20", 6701.3, "index_stale")).toEqual([]);
    expect(await poll("2026-09-24T02:00:30", 6701.3, "index_stale")).toEqual([]);
    expect(await poll("2026-09-24T02:00:40", 6652, "futures")).toEqual([]);
    expect(await poll("2026-09-24T02:00:50", 6653, "futures")).toEqual([]);
    // 期货那一段里自己的走法照常比
    expect(await poll("2026-09-24T02:01:00", 6690, "futures")).toEqual([[6685, "up"]]);
  });
});

// ---------------------------------------------------------------- 整数关口跟着现价换
describe("整数关口:现价走出上下两个关口之间,这一对跟着换", () => {
  it("NVDA 自动步长:130.4 时是 130 / 131;一路走到 134,每过一档报一次,最后盯着的是 134 / 135", async () => {
    const t = bareServer();
    setClock(ET("2026-09-24T09:31:00"));
    t.router.quotes["NVDA"] = 130.4;
    const w = t.s.engine.store.addWatch("NVDA"); // 新盯单:步长自动
    await t.call("alerts.refresh", { id: w["id"] });
    const levels = (): number[] => t.s.engine.store.getWatch(String(w["id"]))!["levels"].map((l) => l.price);
    expect(levels()).toEqual([130, 131]);
    const seen: number[] = [];
    let at = ET("2026-09-24T09:31:00");
    for (const price of [130.5, 130.8, 131.2, 131.6, 132.1, 132.7, 133.3, 133.8, 134.2]) {
      setClock((at += 10_000));
      t.router.quotes["NVDA"] = price;
      seen.push(...((await t.call("alerts.poll"))["result"]["fired"] as Rec[]).map((e) => e["price"] as number));
    }
    expect(seen).toEqual([131, 132, 133, 134]);
    expect(levels()).toEqual([134, 135]);
  });

  it("刚穿过的那个关口留在新的一对里,状态原样带着:马上蹭回来不重报;离开够远、过了冷却才再报", async () => {
    const { poll, crossed, watch } = gapServer([100, 102]);
    await poll("2026-09-24T10:00:00", 101.2);
    await poll("2026-09-24T10:00:10", 101.5);
    expect(crossed(await poll("2026-09-24T10:00:20", 102.1))).toEqual([[102, "up"]]);
    expect(watch()["levels"].map((l) => l.price)).toEqual([102, 104]);
    expect(watch()["states"]).toEqual({ "round@102.0000": { armed: false, last_fired_at: ET("2026-09-24T10:00:20") / 1000 } });
    expect(await poll("2026-09-24T10:00:30", 101.9)).toEqual([]); // 蹭回来:还在 102 的范围里,没上膛
    expect(watch()["levels"].map((l) => l.price)).toEqual([100, 102]);
    expect(watch()["states"]["round@102.0000"]).toMatchObject({ armed: false });
    expect(await poll("2026-09-24T10:00:40", 102.2)).toEqual([]);
    // 过了 5 分钟冷却、这一轮又离开了 ±0.3%:重新上膛,这一下穿回去照报
    expect(crossed(await poll("2026-09-24T10:05:30", 101.2))).toEqual([[102, "down"]]);
  });

  it("只换来源是整数关口的那几个:墙、均线原样;价位是重算出来的那一批(levels_at 不动)", async () => {
    const t = bareServer();
    const w = t.s.engine.store.addWatch("AAA", 2);
    const id = String(w["id"]);
    const wall = { price: 107, label: "上方持仓墙", source: "call_wall", kind: "resistance" };
    t.s.engine.store.updateWatch(id, {
      levels: [{ price: 100, label: "整数关口 100", source: "round", kind: "pivot" }, wall] as never,
      levels_at: "2026-09-24T13:31:00+00:00",
    });
    setClock(ET("2026-09-24T10:00:00"));
    t.router.quotes["AAA"] = 105.3;
    await t.call("alerts.poll");
    const got = t.s.engine.store.getWatch(id)!;
    expect(got["levels"]).toEqual([
      { price: 104, label: "整数关口 104", source: "round", kind: "pivot" },
      { price: 106, label: "整数关口 106", source: "round", kind: "pivot" },
      wall,
    ]);
    expect(got["levels_at"]).toBe("2026-09-24T13:31:00+00:00");
  });
});

// ---------------------------------------------------------------- 1 分钟收盘确认
describe("穿越:1 分钟收盘确认(可选,默认关)", () => {
  it("alerts.list 带着确认方式;只改它不动碰均线的口径;认不出来的值拒掉", async () => {
    const { s, call } = bareServer();
    expect((await call("alerts.list"))["result"]["cross_confirm"]).toBe("immediate");
    const ok = await call("alerts.set_touch_config", { config: {}, cross_confirm: "bar_close" });
    expect(ok["result"]["config"]["periods"]).toEqual([20, 60, 120, 200]);
    expect((await call("alerts.list"))["result"]["cross_confirm"]).toBe("bar_close");
    const audit = (s.engine.store.exportAll()["audit_log"] as Rec[]).map((r) => String(r["action"]));
    expect(audit).toContain("alert_cross_confirm");
    expect(audit).not.toContain("alert_touch_config");
    const bad = await call("alerts.set_touch_config", { config: { window_days: 12 }, cross_confirm: "3s" });
    expect(bad["error"]).toMatchObject({ code: -32602 });
    expect(String(bad["error"]["message"])).toContain("bar_close");
    const list = (await call("alerts.list"))["result"];
    expect([list["cross_confirm"], list["touch_config"]["window_days"]]).toEqual(["bar_close", 10]); // 一样都没落
    // 不带 cross_confirm 的老调用照旧只改碰均线
    await call("alerts.set_touch_config", { config: { window_days: 12 } });
    expect((await call("alerts.list"))["result"]["cross_confirm"]).toBe("bar_close");
  });

  it("打开之后:跨过那一刻不报,那一分钟收在线的另一侧才报;收回去的假突破不报", async () => {
    const { call, poll, watch } = gapServer([100]);
    await call("alerts.set_touch_config", { config: {}, cross_confirm: "bar_close" });
    expect(await poll("2026-09-24T10:00:00", 99.7)).toEqual([]);
    expect(await poll("2026-09-24T10:00:10", 99.8)).toEqual([]);
    expect(await poll("2026-09-24T10:00:20", 100.2)).toEqual([]);
    expect(watch()["states"]["round@100.0000"]!.pending).toMatchObject({ direction: "up", from: 99.8 });
    expect(await poll("2026-09-24T10:00:50", 100.4)).toEqual([]);
    const fired = await poll("2026-09-24T10:01:00", 100.5);
    expect(fired.map((e) => [e["direction"], e["from"], e["to"], e["text"]])).toEqual([
      ["up", 99.8, 100.4, "整数关口 100 上穿 100(1 分钟收盘 100.4 确认,现价 100.5)"],
    ]);
    expect(watch()["states"]["round@100.0000"]).toEqual({ armed: false, last_fired_at: ET("2026-09-24T10:01:00") / 1000 });

    const fake = gapServer([100]);
    await fake.call("alerts.set_touch_config", { config: {}, cross_confirm: "bar_close" });
    await fake.poll("2026-09-24T10:00:00", 99.7);
    await fake.poll("2026-09-24T10:00:10", 99.8);
    await fake.poll("2026-09-24T10:00:20", 100.2);
    await fake.poll("2026-09-24T10:00:50", 99.9);
    expect(await fake.poll("2026-09-24T10:01:00", 99.7)).toEqual([]);
    expect(fake.watch()["states"]["round@100.0000"]).toEqual({ armed: true, last_fired_at: null });
  });

  it("收盘前最后一分钟的突破:16:00 换了时段,那一分钟照样收得了盘、照样确认", async () => {
    const { call, poll } = gapServer([100]);
    await call("alerts.set_touch_config", { config: {}, cross_confirm: "bar_close" });
    await poll("2026-09-24T15:59:10", 99.7);
    await poll("2026-09-24T15:59:20", 99.8);
    expect(await poll("2026-09-24T15:59:30", 100.2)).toEqual([]);
    expect(await poll("2026-09-24T15:59:50", 100.6)).toEqual([]);
    const fired = await poll("2026-09-24T16:00:00", 100.5); // 盘后的第一轮:和上一笔接不上,但 15:59 那一分钟已经收在 100.6
    expect(fired.map((e) => e["text"])).toEqual(["整数关口 100 上穿 100(1 分钟收盘 100.6 确认,现价 100.5)"]);
  });

  it("取价稀(一分钟里只取到穿过的那一笔):不拿穿过的那一笔自己当收盘去确认", async () => {
    const { call, poll, watch } = gapServer([100]);
    await call("alerts.set_touch_config", { config: {}, cross_confirm: "bar_close" });
    await poll("2026-09-24T10:00:00", 99.7);
    await poll("2026-09-24T10:00:10", 99.8);
    expect(await poll("2026-09-24T10:00:20", 100.2)).toEqual([]);
    // 下一笔是 10:03:00,已经回到 99.1:以前会报「1 分钟收盘 100.2 确认,现价 99.1」
    expect(await poll("2026-09-24T10:03:00", 99.1)).toEqual([]);
    expect(await poll("2026-09-24T10:04:00", 99.0)).toEqual([]);
    expect(watch()["states"]["round@100.0000"]).toEqual({ armed: true, last_fired_at: null });
  });
});

// ---------------------------------------------------------------- 步长与均线价位
describe("alerts.refresh:步长与盘中的均线", () => {
  const NOW = "2026-09-24T11:00:00";

  it("新盯单的步长是自动(0):按现价分档;老盯单存的 5 不动,要它自动得明说", async () => {
    const { s, router, call } = bareServer();
    setClock(ET(NOW));
    router.quotes["NVDA"] = 219.4;
    const auto = s.engine.store.addWatch("NVDA");
    expect(auto["step"]).toBe(0);
    const first = (await call("alerts.refresh", { id: auto["id"] }))["result"];
    expect(first["watch"]["levels"].map((l: Rec) => l["price"])).toEqual([217.5, 220]); // 219.4 → 2.5 一档

    const old = s.engine.store.addWatch("AAA", 5); // 升级之前建的:库里就是 5
    router.quotes["AAA"] = 219.4;
    const kept = (await call("alerts.refresh", { id: old["id"] }))["result"]["watch"];
    expect([kept["step"], kept["levels"].map((l: Rec) => l["price"])]).toEqual([5, [215, 220]]);
    const switched = (await call("alerts.refresh", { id: old["id"], step: 0 }))["result"]["watch"];
    expect([switched["step"], switched["levels"].map((l: Rec) => l["price"])]).toEqual([0, [217.5, 220]]);
    const back = (await call("alerts.refresh", { id: old["id"], step: "10" }))["result"]["watch"];
    expect([back["step"], back["levels"].map((l: Rec) => l["price"])]).toEqual([10, [210, 220]]);
    for (const step of [-1, 1001, "abc"]) {
      const bad = await call("alerts.refresh", { id: old["id"], step });
      expect(bad["error"], String(step)).toMatchObject({ code: -32602, message: "整数关口步长必须在 0~1000 之间(0 = 自动)" });
    }
    expect(s.engine.store.getWatch(String(old["id"]))!["step"]).toBe(10);
  });

  it("没算成(现价都取不到)的那一次什么都不写:步长也不改,行上的选择框和库里对得上", async () => {
    const { s, router, call } = bareServer();
    setClock(ET(NOW));
    const w = s.engine.store.addWatch("AAA", 5);
    const id = String(w["id"]);
    router.quotes["AAA"] = 219.4;
    await call("alerts.refresh", { id });
    const before = s.engine.store.getWatch(id)!;
    delete router.quotes["AAA"]; // 行情断了
    const failed = await call("alerts.refresh", { id, step: 0 });
    expect(failed["error"]["code"]).toBe(-32017);
    const after = s.engine.store.getWatch(id)!;
    expect([after["step"], after["levels"], after["levels_at"]]).toEqual([5, before["levels"], before["levels_at"]]);
    // 行情回来再改:步长和按它算出来的价位一起落库
    router.quotes["AAA"] = 219.4;
    const ok = (await call("alerts.refresh", { id, step: 0 }))["result"]["watch"];
    expect([ok["step"], ok["levels"].map((l: Rec) => l["price"])]).toEqual([0, [217.5, 220]]);
  });

  it("均线价位带着收盘和,和同一次算出来的碰均线底账是同一个数;alerts.list 给的是按最近一次取价换算的值", async () => {
    const { s, router, call } = bareServer();
    setClock(ET(NOW));
    router.history["NVDA"] = NVDA;
    router.quotes["NVDA"] = 222;
    const w = s.engine.store.addWatch("NVDA");
    const out = (await call("alerts.refresh", { id: w["id"] }))["result"];
    const watch = out["watch"] as Rec;
    const ma20 = (watch["levels"] as Rec[]).find((l) => l["source"] === "ma20")!;
    const line = (watch["touch"]["lines"] as Rec[]).find((l) => l["period"] === 20)!;
    expect(ma20["ma"]).toEqual({ period: 20, prior_sum: line["prior_sum"] });
    expect(ma20["price"]).toBeCloseTo((line["prior_sum"] + 222) / 20, 4);
    expect(out["trend"]["ma20"]).toBe(ma20["price"]);

    // 价走到 226:库里那个价位还是 222 时算的;给界面的那份跟着现价
    router.quotes["NVDA"] = 226;
    await call("alerts.poll");
    const stored = s.engine.store.getWatch(String(w["id"]))!["levels"].find((l) => l.source === "ma20")!;
    expect(stored.price).toBe(ma20["price"]);
    const listed = ((await call("alerts.list"))["result"]["watches"][0]["levels"] as Rec[]).find((l) => l["source"] === "ma20")!;
    expect(listed["price"]).toBeCloseTo((line["prior_sum"] + 226) / 20, 4);
    expect(listed["ma"]).toEqual(ma20["ma"]);
  });

  it("均线今天换了价,昨天报过的那一次还记着:重算价位不把它的状态冲掉", async () => {
    const { s, router, call } = bareServer();
    setClock(ET(NOW));
    router.history["NVDA"] = NVDA;
    router.quotes["NVDA"] = 222;
    const w = s.engine.store.addWatch("NVDA");
    const id = String(w["id"]);
    await call("alerts.set_touch_config", { config: { enabled: false } }); // 只看穿越这条路
    await call("alerts.refresh", { id });
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
    router.quotes["NVDA"] = 222.1; // 动过一次:坐实
    expect((await call("alerts.poll"))["result"]["fired"]).toEqual([]);
    router.quotes["NVDA"] = 221.5; // 跨过 20 日线(≈221.75)
    const fired = (await call("alerts.poll"))["result"]["fired"] as Rec[];
    expect(fired.map((e) => [e["source"], e["direction"]])).toEqual([["ma20", "down"]]);
    expect(s.engine.store.getWatch(id)!["states"]["ma20"]).toMatchObject({ armed: false });
    // 换一个现价重算:均线的价变了,状态还在
    router.quotes["NVDA"] = 221.9;
    await call("alerts.refresh", { id });
    await call("alerts.poll");
    expect(s.engine.store.getWatch(id)!["states"]["ma20"]).toMatchObject({ armed: false });
  });
});
