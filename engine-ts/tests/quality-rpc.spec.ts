/** 优质股追踪 + 异动监控的 RPC 层。
 *
 * 用户原话:「增加优质股票追踪功能,股票出现异常波动,比如放量时,直接弹窗提醒」。这里钉住引擎这一侧:
 *  1. quality.* 全在本地道(同步 SQLite + 读内存),CRUD 与校验、上限 30 只、阈值校验;
 *  2. 异动循环在引擎里跑:盘中放量 → 推 "anomaly" 事件、档位落库;同档不重报;重启不重报;换日重置;
 *  3. 休市 / 盘前只算指标不报(周末按钟点落在 09:30–16:00 也不能报);
 *  4. 没连券商 / 富途不支持时给一句人话;取行情抛异常循环照跑;一轮没跑完绝不开下一轮;
 *  5. 只推给界面,不走 notifier(那会在 macOS 另弹一次系统通知)。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ANOMALY_CONFIG } from "../src/anomaly.js";
import { setClock } from "../src/config.js";
import { RpcServer } from "../src/rpc.js";

type Rec = Record<string, any>;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 2026-09-11(周五,交易日)美东 11:00 = 开盘后第 90 分钟。 */
const ET_1100 = Date.parse("2026-09-11T11:00:00-04:00");
const ET_1055 = Date.parse("2026-09-11T10:55:00-04:00");
const ET_PRE = Date.parse("2026-09-11T08:00:00-04:00");
const ET_POST = Date.parse("2026-09-11T17:00:00-04:00");
const SAT_1100 = Date.parse("2026-09-12T11:00:00-04:00");
const MON_1100 = Date.parse("2026-09-14T11:00:00-04:00");

class FakeVolumeRouter {
  BROKER = "ibkr";
  SUPPORTS_VOLUME_QUOTES = true;
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  upstreamOk = true;
  quotes: Record<string, Rec> = {};
  calls: string[][] = [];
  released: string[][] = [];
  fail: Error | null = null;
  delayMs = 0;
  inFlight = 0;
  maxInFlight = 0;
  sessions(): unknown[] {
    return [{}];
  }
  connectedNames(): string[] {
    return ["paper"];
  }
  async volumeQuotes(symbols: string[]): Promise<Record<string, Rec>> {
    this.calls.push([...symbols]);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs) await sleep(this.delayMs);
      if (this.fail) throw this.fail;
      const out: Record<string, Rec> = {};
      for (const s of symbols) if (this.quotes[s]) out[s] = { ...this.quotes[s] };
      return out;
    } finally {
      this.inFlight -= 1;
    }
  }
  releaseVolumeStreams(keep: string[]): number {
    this.released.push([...keep]);
    return 0;
  }
}

/** RKLB:昨收 44、现价 48(+9.09%);90 日均量 1000 万、此刻当日量 1200 万——11:00 常态该走完 37.9%,量比 ≈ 3.2×。 */
function quote(over: Rec = {}): Rec {
  return {
    last: 48, close: 44, open: 44.5, high: 48.5, low: 44.2, volume: 12_000_000, avg_volume: 10_000_000,
    hist_vol: null, vol_3m: null, vol_5m: null, vol_10m: null, delayed: false, last_trade_at: null, ...over,
  };
}

const servers: RpcServer[] = [];
const dirs: string[] = [];

function makeServer(dir?: string): { s: RpcServer; chunks: string[]; dir: string } {
  const root = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "dafri-quality-"));
  if (!dir) dirs.push(root);
  const settingsPath = path.join(root, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
    fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(root, "t.db") } }));
  }
  const chunks: string[] = [];
  const s = new RpcServer(settingsPath, (line) => { chunks.push(line); });
  void s.engine; // 先建引擎(那时还没 router,不起盯盘节拍器),再挂假 router
  servers.push(s);
  return { s, chunks, dir: root };
}

function withRouter(router: object = new FakeVolumeRouter()): { s: RpcServer; chunks: string[]; router: FakeVolumeRouter; dir: string } {
  const { s, chunks, dir } = makeServer();
  (s as any).router = router;
  return { s, chunks, router: router as FakeVolumeRouter, dir };
}

function anomalyEmits(chunks: string[]): Rec[][] {
  return chunks
    .map((l) => JSON.parse(l) as Rec)
    .filter((m) => m["method"] === "event" && m["params"]["event"] === "anomaly")
    .map((m) => m["params"]["data"]["events"] as Rec[]);
}

async function call(s: RpcServer, method: string, params: Rec = {}): Promise<Rec> {
  return s.handle({ jsonrpc: "2.0", id: 1, method, params });
}

afterEach(() => {
  setClock(null);
  for (const s of servers.splice(0)) {
    s.stopAnomalyLoop();
    s.engine.stopTrackerLoop();
  }
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上 sqlite 句柄可能还占着 */
    }
  }
});

// ---------------------------------------------------------------- 本地道 + CRUD
describe("quality.*:本地道与增删改", () => {
  it("五个方法全在本地道(同步 SQLite + 读内存,不排在等网络的请求后面)", () => {
    for (const m of ["quality.list", "quality.add", "quality.update", "quality.remove", "quality.set_config"]) {
      expect(RpcServer.LOCAL_METHODS.has(m), m).toBe(true);
    }
  });

  it("加入 / 列表 / 改备注与启停 / 移除;各种不合法都回 -32602", async () => {
    const { s } = makeServer();
    const added = await call(s, "quality.add", { symbol: " rklb ", note: "小火箭,发射频率高" });
    const stock = added["result"]["stock"];
    expect(stock).toMatchObject({ symbol: "RKLB", note: "小火箭,发射频率高", enabled: 1, metrics: null, metrics_at: null });

    expect((await call(s, "quality.add", { symbol: "rklb" }))["error"]).toMatchObject({ code: -32602, message: "已经在追踪 RKLB 了" });
    expect((await call(s, "quality.add", { symbol: "1ABC" }))["error"]["code"]).toBe(-32602);
    expect((await call(s, "quality.add", { symbol: "" }))["error"]["code"]).toBe(-32602);
    expect((await call(s, "quality.add", { symbol: "SPX" }))["error"]).toMatchObject({ code: -32602 });

    const listed = (await call(s, "quality.list"))["result"];
    expect(listed["max"]).toBe(30);
    expect(listed["stocks"].map((r: Rec) => r["symbol"])).toEqual(["RKLB"]);
    expect(listed["config"]).toEqual(DEFAULT_ANOMALY_CONFIG);
    expect(Object.keys(listed["monitor"]).sort()).toEqual(
      ["connected", "interval_ms", "last_at", "last_error", "last_ms", "note", "running", "session", "supported", "ticks"],
    );

    const upd = (await call(s, "quality.update", { id: stock["id"], enabled: false, note: "先观察" }))["result"]["stock"];
    expect(upd).toMatchObject({ enabled: 0, note: "先观察", symbol: "RKLB" });
    expect((await call(s, "quality.update", { id: "nope", enabled: true }))["error"]["code"]).toBe(-32602);

    expect((await call(s, "quality.remove", { id: stock["id"] }))["result"]).toEqual({ deleted: stock["id"] });
    expect((await call(s, "quality.remove", { id: stock["id"] }))["error"]["code"]).toBe(-32602);
    expect((await call(s, "quality.list"))["result"]["stocks"]).toEqual([]);
  });

  it("最多追踪 30 只:第 31 只被拒", async () => {
    const { s } = makeServer();
    for (let i = 0; i < 30; i += 1) {
      const sym = `Q${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`;
      expect((await call(s, "quality.add", { symbol: sym }))["result"], sym).toBeTruthy();
    }
    expect((await call(s, "quality.add", { symbol: "ONEMORE" }))["error"]).toEqual({ code: -32602, message: "最多追踪 30 只" });
  });

  // 统一成股票池之后:成员身份由板块说了算,quality.add / quality.remove 只是那两个开关里的一个。
  // 桥和三份 mock 还在用这两个方法,内部必须走 pool.set_watch 同一段逻辑,不能各删各的。
  it("quality.add:不在任何板块的股先并进「自选」,再开「盯异动」这一个开关", async () => {
    const { s } = makeServer();
    const store = s.engine.store;
    s.qualityAdd({ symbol: "rklb", note: "小火箭" });
    const mine = store.listSectors().find((x) => String(x["name"]) === "自选")!;
    expect((mine["stocks"] as Rec[]).map((x) => x["symbol"])).toEqual(["RKLB"]);
    expect(store.listQualityStocks().map((q) => q["symbol"])).toEqual(["RKLB"]);
    expect(store.listQualityStocks()[0]!["note"]).toBe("小火箭"); // 备注不会被迁移的默认冲掉
    expect(store.listWatches()).toEqual([]); // 只开了异动那一个,不白占一个价位位子

    // 已经在别的板块里的股:不再建「自选」,也不重复登记
    const tech = (await call(s, "sectors.add", { name: "科技" }))["result"]["sector"];
    store.setSectorStocks(String(tech["id"]), [{ symbol: "NVDA", company: "", reason: "", tag: "" }]);
    s.qualityRemove({ id: String(store.listQualityStocks()[0]!["id"]) });
    s.qualityAdd({ symbol: "NVDA" });
    expect(store.listSectors().map((x) => x["name"])).toEqual(["自选", "科技"]);
    expect((store.listSectors().find((x) => x["name"] === "科技")!["stocks"] as Rec[]).map((x) => x["symbol"]))
      .toEqual(["NVDA"]);
  });

  it("quality.remove:只关掉「盯异动」,股还在池子里、盯价位不受影响", async () => {
    const { s } = makeServer();
    const store = s.engine.store;
    const sector = (await call(s, "sectors.add", { name: "科技" }))["result"]["sector"];
    const added = (await call(s, "sectors.add_stock", { id: sector["id"], symbol: "NVDA" }))["result"];
    expect(added["watch"]).toMatchObject({ price_on: true, anomaly_on: true });

    s.qualityRemove({ id: String(store.listQualityStocks()[0]!["id"]) });
    expect(store.listQualityStocks()).toEqual([]);
    expect(store.listWatches().map((w) => w["symbol"])).toEqual(["NVDA"]); // 价位还开着
    expect([...store.symbolsInSectors()]).toEqual(["NVDA"]); // 人还在池子里
    // 走的是同一段开关逻辑:审计里记的是 pool_watch_off
    const audit = (store.exportAll()["audit_log"] as Rec[]).filter((r) => r["action"] === "pool_watch_off");
    expect(audit.map((r) => JSON.parse(String(r["detail"])))).toEqual([{ symbol: "NVDA", which: "anomaly" }]);
  });

  it("set_config:在当前生效的那份上合并、落库;越界给中文信息;不是对象也拒", async () => {
    const { s } = makeServer();
    const one = (await call(s, "quality.set_config", { config: { burst_ratio: 6 } }))["result"]["config"];
    expect(one).toEqual({ ...DEFAULT_ANOMALY_CONFIG, burst_ratio: 6 });
    const two = (await call(s, "quality.set_config", { config: { window_min: 10 } }))["result"]["config"];
    expect(two).toMatchObject({ burst_ratio: 6, window_min: 10 });
    expect((await call(s, "quality.list"))["result"]["config"]).toMatchObject({ burst_ratio: 6, window_min: 10 });

    const bad = (await call(s, "quality.set_config", { config: { window_min: 7 } }))["error"];
    expect(bad["code"]).toBe(-32602);
    expect(bad["message"]).toMatch(/窗口/);
    expect((await call(s, "quality.set_config", { config: [1] }))["error"]["code"]).toBe(-32602);
    expect((await call(s, "quality.set_config", {}))["error"]["code"]).toBe(-32602);
    expect((await call(s, "quality.list"))["result"]["config"]).toMatchObject({ burst_ratio: 6, window_min: 10 });
  });
});

// ---------------------------------------------------------------- 异动循环
describe("异动监控:一轮 anomalyTickOnce", () => {
  it("盘中放量 + 大涨:推 anomaly 事件、档位与事件落库;不走 notifier", async () => {
    const { s, chunks, router } = withRouter();
    const id = s.qualityAdd({ symbol: "RKLB" })["stock"]["id"];
    router.quotes["RKLB"] = quote();
    // 刚订上的流第一轮只算指标(tick 23 历史波动率常常第二轮才到),第二轮才判
    expect((await s.anomalyTickOnce(ET_1100 - 5000))["events"]).toEqual([]);
    const out = await s.anomalyTickOnce(ET_1100);
    const kinds = (out["events"] as Rec[]).map((e) => `${e["kind"]}:${e["tier"]}`).sort();
    expect(kinds).toEqual(["day_move:3", "rvol:3"]);
    const emits = anomalyEmits(chunks);
    expect(emits).toHaveLength(1);
    expect(emits[0]!.map((e) => e["symbol"])).toEqual(["RKLB", "RKLB"]);
    expect(emits[0]!.find((e) => e["kind"] === "rvol")!["title"]).toBe("RKLB 放量 3.2×");
    expect(chunks.some((l) => l.includes("\"notification\""))).toBe(false);

    const row = s.engine.store.getQualityStock(id)!;
    expect(row["states"]).toMatchObject({ date: "2026-09-11", rvol_fired: 3, day_up_fired: 3 });
    expect((row["events"] as Rec[]).map((e) => e["kind"]).sort()).toEqual(["day_move", "rvol"]);

    setClock(ET_1100);
    const listed = (await call(s, "quality.list"))["result"];
    const metrics = listed["stocks"][0]["metrics"];
    expect(metrics["rvol"]).toBeCloseTo(3.17, 1);
    expect(metrics["change_pct"]).toBeCloseTo(9.0909, 3);
    expect(listed["stocks"][0]["metrics_at"]).toBe(new Date(ET_1100).toISOString());
    expect(listed["monitor"]).toMatchObject({ connected: true, supported: true, session: "rth", note: "", ticks: 2 });
    expect(router.released).toEqual([["RKLB"], ["RKLB"]]);
  });

  it("同档不重报:下一轮还是 3 倍、还是 +9%,不推事件、不白写库", async () => {
    const { s, chunks, router } = withRouter();
    s.qualityAdd({ symbol: "RKLB" });
    router.quotes["RKLB"] = quote();
    await s.anomalyTickOnce(ET_1100 - 5000); // 热身轮
    await s.anomalyTickOnce(ET_1100);
    const spy = vi.spyOn(s.engine.store, "updateQualityStock");
    const again = await s.anomalyTickOnce(ET_1100 + 5000);
    expect(again["events"]).toEqual([]);
    expect(anomalyEmits(chunks)).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("重启(新 RpcServer 开同一个库)不把今天报过的再报一遍;换到下一个交易日重新起报", async () => {
    const first = withRouter();
    first.router.quotes["RKLB"] = quote();
    first.s.qualityAdd({ symbol: "RKLB" });
    await first.s.anomalyTickOnce(ET_1100 - 5000); // 热身轮
    await first.s.anomalyTickOnce(ET_1100);
    expect(anomalyEmits(first.chunks)).toHaveLength(1);

    const { s, chunks } = makeServer(first.dir);
    const router = new FakeVolumeRouter();
    router.quotes["RKLB"] = quote();
    (s as any).router = router;
    await s.anomalyTickOnce(ET_1100 + 55_000); // 新进程的热身轮
    const after = await s.anomalyTickOnce(ET_1100 + 60_000);
    expect(after["events"]).toEqual([]);
    expect(anomalyEmits(chunks)).toEqual([]);

    // 隔了一个周末,内存里的样本早过期了(只留 20 分钟):周一第一轮又是热身轮
    await s.anomalyTickOnce(MON_1100 - 5000);
    const monday = await s.anomalyTickOnce(MON_1100);
    expect((monday["events"] as Rec[]).map((e) => e["kind"]).sort()).toEqual(["day_move", "rvol"]);
    const row = s.engine.store.listQualityStocks()[0]!;
    expect(row["states"]["date"]).toBe("2026-09-14");
    expect(row["events"]).toHaveLength(4);
  });

  it("窗口放量:样本在轮与轮之间留在内存里,5 分钟前那一轮的当日量就是窗口起点", async () => {
    const { s, chunks, router } = withRouter();
    s.qualityAdd({ symbol: "RKLB" });
    // 10:55 → 11:00 每 30 秒一轮,量与价线性走:窗口里 10 步,不会被当成一笔大单
    for (let i = 0; i < 10; i += 1) {
      router.quotes["RKLB"] = quote({ last: 44 + 0.03 * i, close: 44, volume: 3_000_000 + 100_000 * i });
      expect((await s.anomalyTickOnce(ET_1055 + i * 30_000))["events"]).toEqual([]);
    }
    router.quotes["RKLB"] = quote({ last: 44.3, close: 44, volume: 4_000_000 });
    const out = await s.anomalyTickOnce(ET_1100);
    expect((out["events"] as Rec[]).map((e) => e["kind"])).toEqual(["burst"]);
    expect(out["events"][0]["title"]).toMatch(/^RKLB 5分钟放量 7\.6×$/);
    expect(out["events"][0]["direction"]).toBe("up");
    expect(anomalyEmits(chunks)).toHaveLength(1);
  });

  it("休市(周六 11:00)与盘前:只算指标不报;监控状态给出时段说明", async () => {
    const { s, chunks, router } = withRouter();
    s.qualityAdd({ symbol: "RKLB" });
    router.quotes["RKLB"] = quote();

    const sat = await s.anomalyTickOnce(SAT_1100);
    expect(sat["events"]).toEqual([]);
    setClock(SAT_1100);
    let listed = (await call(s, "quality.list"))["result"];
    // 非交易日当"已收盘":量比就是上一个交易日的全天值 1200 万 / 1000 万
    expect(listed["stocks"][0]["metrics"]["rvol"]).toBeCloseTo(1.2, 6);
    expect(listed["monitor"]).toMatchObject({ session: "closed", note: "休市:开盘后开始检测" });

    const pre = await s.anomalyTickOnce(ET_PRE);
    expect(pre["events"]).toEqual([]);
    setClock(ET_PRE);
    listed = (await call(s, "quality.list"))["result"];
    expect(listed["stocks"][0]["metrics"]).not.toBeNull();
    expect(listed["monitor"]).toMatchObject({ session: "pre", note: "盘前:开盘后开始检测" });

    setClock(ET_POST);
    listed = (await call(s, "quality.list"))["result"];
    expect(listed["monitor"]).toMatchObject({ session: "post", note: "盘后:今日检测已结束" });
    expect(anomalyEmits(chunks)).toEqual([]);
    expect(s.engine.store.listQualityStocks()[0]!["events"]).toEqual([]);
  });

  it("延迟行情:盘中照报,监控状态提示会晚约 15 分钟", async () => {
    const { s, router } = withRouter();
    s.qualityAdd({ symbol: "RKLB" });
    router.quotes["RKLB"] = quote({ delayed: true });
    await s.anomalyTickOnce(ET_1100);
    setClock(ET_1100);
    expect((await call(s, "quality.list"))["result"]["monitor"]["note"]).toBe("延迟行情:提醒会晚约 15 分钟");
  });

  it("行情带错误(认不出 / 流被拒):不判异动,原因带给界面", async () => {
    const { s, chunks, router } = withRouter();
    s.qualityAdd({ symbol: "ZZZZ" });
    router.quotes["ZZZZ"] = { ...quote({ last: null, close: null, volume: null, avg_volume: null }), error: "未知标的" };
    const out = await s.anomalyTickOnce(ET_1100);
    expect(out["events"]).toEqual([]);
    const row = (await call(s, "quality.list"))["result"]["stocks"][0];
    expect(row).toMatchObject({ metrics: null, quote_error: "未知标的" });
    expect(anomalyEmits(chunks)).toEqual([]);
  });

  // 2026-09-12 审出的三道"宁可少报"的闸
  it("行情停更 15 分钟(流被撤 / 临时休市):只算指标不报,原因带给界面", async () => {
    const { s, chunks, router } = withRouter();
    s.qualityAdd({ symbol: "RKLB" });
    router.quotes["RKLB"] = quote({ last_trade_at: (ET_1100 - 16 * 60_000) / 1000 });
    await s.anomalyTickOnce(ET_1100 - 5000);
    const out = await s.anomalyTickOnce(ET_1100);
    expect(out["events"]).toEqual([]);
    expect(anomalyEmits(chunks)).toEqual([]);
    setClock(ET_1100);
    const row = (await call(s, "quality.list"))["result"]["stocks"][0];
    expect(row["quote_error"]).toMatch(/行情已停更 1[56] 分钟/);
    expect(row["metrics"]["rvol"]).toBeCloseTo(3.17, 1); // 指标照给
    // 恢复成新鲜的成交时间:下一轮照常报
    router.quotes["RKLB"] = quote({ last_trade_at: (ET_1100 + 5000) / 1000 });
    const ok = await s.anomalyTickOnce(ET_1100 + 10_000);
    expect((ok["events"] as Rec[]).length).toBeGreaterThan(0);
  });

  it("延迟行情:时钟往回拨 15 分钟再判(开盘那格不会被当成十点的常态)", async () => {
    const { s, router } = withRouter();
    s.qualityAdd({ symbol: "RKLB" });
    // 钟点 09:52,延迟行情看到的是 09:37 的量:第 7 分钟,全天量比那道闸(09:45)还没开
    const et0952 = Date.parse("2026-09-11T09:52:00-04:00");
    router.quotes["RKLB"] = quote({ delayed: true });
    await s.anomalyTickOnce(et0952 - 5000);
    const late = (await s.anomalyTickOnce(et0952))["events"] as Rec[];
    expect(late.map((e) => e["kind"])).toEqual(["day_move"]); // 大涨照报,全天量比还没到开判的时刻
    // 同样的钟点、实时行情:第 22 分钟,量比那道闸已经开了
    const live = withRouter();
    live.s.qualityAdd({ symbol: "RKLB" });
    live.router.quotes["RKLB"] = quote();
    await live.s.anomalyTickOnce(et0952 - 5000);
    const now = (await live.s.anomalyTickOnce(et0952))["events"] as Rec[];
    expect(now.map((e) => e["kind"]).sort()).toEqual(["day_move", "rvol"]);
  });

  it("收盘之后 / 开盘之前:一轮也不取行情,量能流全撤——30 条线路不整夜占着", async () => {
    const { s, router } = withRouter();
    s.qualityAdd({ symbol: "RKLB" });
    router.quotes["RKLB"] = quote();
    const post = await s.anomalyTickOnce(Date.parse("2026-09-11T16:25:00-04:00"));
    expect(post["skipped"]).toBe("不在交易时段");
    expect(router.calls).toEqual([]);
    expect(router.released).toEqual([[]]);
    // 开盘前 10 分钟之内就开始订,样本先热起来
    const warm = await s.anomalyTickOnce(Date.parse("2026-09-11T09:25:00-04:00"));
    expect(warm["skipped"]).toBe("");
    expect(router.calls).toEqual([["RKLB"]]);
  });

  it("停用的股不取行情;全停了就把量能流全撤掉", async () => {
    const { s, router } = withRouter();
    const a = s.qualityAdd({ symbol: "RKLB" })["stock"];
    s.qualityAdd({ symbol: "UBER" });
    s.qualityUpdate({ id: a["id"], enabled: false });
    await s.anomalyTickOnce(ET_1100);
    expect(router.calls).toEqual([["UBER"]]);
    expect(router.released).toEqual([["UBER"]]);
    for (const row of s.engine.store.listQualityStocks()) s.qualityUpdate({ id: row["id"], enabled: false });
    const out = await s.anomalyTickOnce(ET_1100 + 5000);
    expect(router.calls).toHaveLength(1);
    expect(router.released).toEqual([["UBER"], []]);
    expect(out["skipped"]).toBeTruthy();
  });

  it("等行情那会儿界面删了这只股:不给已删的股报异动", async () => {
    const { s, chunks, router } = withRouter();
    const id = s.qualityAdd({ symbol: "RKLB" })["stock"]["id"];
    router.quotes["RKLB"] = quote();
    router.delayMs = 80;
    const pending = s.anomalyTickOnce(ET_1100);
    await sleep(20);
    s.qualityRemove({ id });
    const out = await pending;
    expect(out["events"]).toEqual([]);
    expect(anomalyEmits(chunks)).toEqual([]);
    expect((await call(s, "quality.list"))["result"]["stocks"]).toEqual([]);
  });

  it("没连券商 / 富途:不取行情,给一句人话", async () => {
    const { s } = makeServer();
    s.qualityAdd({ symbol: "RKLB" });
    const out = await s.anomalyTickOnce(ET_1100);
    expect(out["events"]).toEqual([]);
    let monitor = (await call(s, "quality.list"))["result"]["monitor"];
    expect(monitor).toMatchObject({ connected: false, note: "未连接券商", ticks: 1, last_error: "" });

    const futu = new FakeVolumeRouter();
    futu.BROKER = "futu";
    futu.SUPPORTS_VOLUME_QUOTES = false;
    (s as any).router = futu;
    await s.anomalyTickOnce(ET_1100);
    expect(futu.calls).toEqual([]);
    monitor = (await call(s, "quality.list"))["result"]["monitor"];
    expect(monitor).toMatchObject({ connected: true, supported: false, note: "当前券商(富途)暂不支持异动监控" });
  });

  it("取行情抛异常:记进 last_error,下一轮照跑、好了就清掉", async () => {
    const { s, router } = withRouter();
    s.qualityAdd({ symbol: "RKLB" });
    router.quotes["RKLB"] = quote();
    router.fail = new Error("TWS 在 12 秒内没有响应");
    await s.anomalyTickOnce(ET_1100);
    let monitor = (await call(s, "quality.list"))["result"]["monitor"];
    expect(monitor["last_error"]).toMatch(/取行情失败/);
    expect(monitor["ticks"]).toBe(1);
    router.fail = null;
    await s.anomalyTickOnce(ET_1100 + 5000); // 取到行情的第一轮是热身轮
    const ok = await s.anomalyTickOnce(ET_1100 + 10_000);
    expect(ok["events"]).toHaveLength(2);
    monitor = (await call(s, "quality.list"))["result"]["monitor"];
    expect(monitor).toMatchObject({ last_error: "", ticks: 3 });
  });
});

// ---------------------------------------------------------------- 循环调度
describe("异动监控:循环调度", () => {
  it("一轮比节拍还慢:紧接着跑下一轮,但绝不两轮叠在一起;停了就不再跑", async () => {
    const { s, router } = withRouter();
    s.qualityAdd({ symbol: "RKLB" });
    router.quotes["RKLB"] = quote();
    router.delayMs = 120;
    setClock(ET_1100); // 循环按引擎时钟判时段:收盘后本来就不取行情
    s.startAnomalyLoop(40);
    s.startAnomalyLoop(40); // 重复启动不起第二条循环
    await sleep(700);
    s.stopAnomalyLoop();
    expect(router.maxInFlight).toBe(1);
    expect(router.calls.length).toBeGreaterThanOrEqual(3);
    await sleep(200);
    const settled = router.calls.length;
    await sleep(200);
    expect(router.calls.length).toBe(settled);
  });

  it("取行情一直抛异常,循环照样一轮一轮跑", async () => {
    const { s, router } = withRouter();
    s.qualityAdd({ symbol: "RKLB" });
    router.fail = new Error("boom");
    setClock(ET_1100);
    s.startAnomalyLoop(20);
    await sleep(300);
    s.stopAnomalyLoop();
    const monitor = (await call(s, "quality.list"))["result"]["monitor"];
    expect(monitor["ticks"]).toBeGreaterThanOrEqual(3);
    expect(monitor["running"]).toBe(false);
    expect(monitor["last_error"]).toMatch(/boom/);
  });

  it("定时器 unref:引擎进程该退就退,不被异动循环吊着", () => {
    const { s } = makeServer();
    s.startAnomalyLoop(60_000);
    const timer = (s as any).anomalyTimer as { hasRef(): boolean } | null;
    expect(timer).not.toBeNull();
    expect(timer!.hasRef()).toBe(false);
    s.stopAnomalyLoop();
  });

  it("serve():ready 之后起循环,stdin 断了(EOF)就停", async () => {
    const { s, chunks } = makeServer();
    const input = new PassThrough();
    const done = s.serve(input);
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "quality.list", params: {} }) + String.fromCharCode(10));
    await sleep(50);
    input.end();
    await done;
    const reply = chunks.map((l) => JSON.parse(l) as Rec).find((m) => m["id"] === 7)!;
    expect(reply["result"]["monitor"]["running"]).toBe(true);
    const events = chunks.map((l) => JSON.parse(l) as Rec).filter((m) => m["method"] === "event");
    expect(events[0]!["params"]["event"]).toBe("ready");
    expect((await call(s, "quality.list"))["result"]["monitor"]["running"]).toBe(false);
  });
});
