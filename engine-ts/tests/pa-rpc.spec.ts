/** pa.* 在 RPC 这一层的特征测试:输入是界面(Market.tsx 的 K线 PA 那一段)真实发出来的载荷形状。
 *
 * 算法那一半由 golden-analysis 钉着(直接调 analyze);golden-rpc 钉了 pa.timeframes 的完整形状与 pa.analyze 的两句报错,
 * 但**跑成功**那条路要连券商拉 K 线,基线里走不到。这里补的是从 RPC 进来这一段:回执里界面读的每一个键、
 * 高周期背景拿不到时不毁掉整次分析、K 线缓存(cached 标记)、以及 pa.comment 把哪些事实交给模型、模型失败报什么。
 * 先于契约迁移写成,迁的时候不改断言。全部离线:券商与模型都是假的。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { BrokerError } from "../src/broker.js";
import { setClock } from "../src/config.js";
import { RpcServer } from "../src/rpc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

/** 2026-09-11(周五,交易日)美东 12:00,盘中。 */
const NOON = Date.parse("2026-09-11T12:00:00-04:00");

/** 5 分钟线:走一段上升结构(高点抬高、低点抬高),够 analyze 读出摆动点与 BOS。 */
function intraday(count = 240, step = 0.25): Rec[] {
  const out: Rec[] = [];
  let t = Date.parse("2026-09-11T09:30:00-04:00") - count * 300_000;
  for (let i = 0; i < count; i++, t += 300_000) {
    // 上行 + 小幅波动:制造一串抬高的摆动高低点
    const close = Math.round((100 + i * step + 3 * Math.sin(i / 7)) * 100) / 100;
    out.push({
      time: new Date(t).toISOString().slice(0, 19).replace("T", " "),
      open: close - 0.2, high: close + 0.6, low: close - 0.6, close, volume: 10_000 + i * 10,
    });
  }
  return out;
}

class FakeRouter {
  asked: Array<[string, string, boolean]> = [];
  failFor = new Set<string>();
  sessions(): unknown[] { return [{}]; }
  connectedNames(): string[] { return ["paper"]; }
  async intradayBars(symbol: string, timeframe: string, rth: boolean): Promise<Rec[]> {
    this.asked.push([symbol, timeframe, rth]);
    if (this.failFor.has(timeframe)) throw new BrokerError(`没有 ${symbol} 的 ${timeframe} 行情权限`);
    return intraday();
  }
}

class FakeParser {
  calls: Array<{ system: string; user: string; schema: Rec }> = [];
  reply: Rec | Error = { summary: "结构偏多", reading: "高点抬高,回踩不破。", watch: ["盯 108"], risks: ["假突破"] };
  async completeJson(system: string, user: string, schema: Rec): Promise<Rec> {
    this.calls.push({ system, user, schema });
    if (this.reply instanceof Error) throw this.reply;
    return structuredClone(this.reply);
  }
}

const servers: RpcServer[] = [];
const dirs: string[] = [];

function makeServer(opts: { connected?: boolean } = {}): { s: RpcServer; router: FakeRouter; parser: FakeParser; call: (m: string, p?: Rec) => Promise<Rec> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-pa-rpc-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
  const s = new RpcServer(settingsPath, () => undefined);
  const router = new FakeRouter();
  const parser = new FakeParser();
  if (opts.connected ?? true) s.router = router as never;
  s.parserFactory = () => parser;
  servers.push(s);
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { s, router, parser, call };
}

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

/** analyze 的回执里,界面画图与列表要读的键。 */
const PA_KEYS = [
  "age_seconds", "agreement", "atr", "bar_count", "bars", "bias", "bias_label", "cached", "confidence", "context",
  "equal_levels", "events", "evidence", "extended_hours", "fetched_at", "first_bar", "fvgs", "htf", "last", "last_bar",
  "levels", "ma", "order_block", "patterns", "plan", "readout", "rth", "score", "sweeps", "swing_strength", "swings",
  "symbol", "timeframe", "timeframe_label", "trend", "trend_label", "warnings",
];

describe("pa.timeframes", () => {
  it("七个周期 + 最小重取间隔;每项带中文名、秒数、对应的高周期", async () => {
    const { call } = makeServer({ connected: false });
    const r = (await call("pa.timeframes"))["result"];
    expect(Object.keys(r).sort()).toEqual(["min_interval", "timeframes"]);
    expect(r["timeframes"].map((t: Rec) => t["key"])).toEqual(["1m", "2m", "5m", "15m", "30m", "1h", "1d"]);
    for (const t of r["timeframes"]) expect(Object.keys(t).sort()).toEqual(["htf", "key", "label", "seconds"]);
    expect(r["timeframes"][2]).toEqual({ key: "5m", label: "5 分钟", seconds: 300, htf: "1h" });
    expect(r["timeframes"][6]["htf"]).toBeNull(); // 日线上面没有高周期了
    expect(typeof r["min_interval"]).toBe("number");
  });
});

describe("pa.analyze:界面的载荷", () => {
  it("回执的完整形状;代码规整过;默认全时段(rth = false),高周期背景一起给", async () => {
    setClock(NOON);
    const { call, router } = makeServer();
    const r = (await call("pa.analyze", { symbol: " spy ", timeframe: "5m" }))["result"];

    // 先要 5m,再要它的高周期 1h;都按全时段取
    expect(router.asked).toEqual([["SPY", "5m", false], ["SPY", "1h", false]]);
    expect(Object.keys(r).sort()).toEqual(PA_KEYS);
    expect(r).toMatchObject({ symbol: "SPY", timeframe: "5m", timeframe_label: "5 分钟", rth: false, cached: false, extended_hours: true });
    expect(r["fetched_at"]).toBe(new Date(NOON).toISOString());
    expect(r["bar_count"]).toBe(240);

    // 结构判定
    expect(["bullish", "lean_bull", "neutral", "lean_bear", "bearish"]).toContain(r["bias"]);
    expect(typeof r["bias_label"]).toBe("string");
    expect(typeof r["score"]).toBe("number");
    expect(r["confidence"]).toBeGreaterThanOrEqual(0);
    expect(r["confidence"]).toBeLessThanOrEqual(1);

    // 这份数据是一路抬高的:必有摆动点与 BOS 事件
    expect(r["swings"].length).toBeGreaterThan(0);
    expect(Object.keys(r["swings"][0]).sort()).toEqual(["index", "kind", "label", "price", "time"]);
    expect(r["events"].length).toBeGreaterThan(0);
    expect(Object.keys(r["events"][0]).sort()).toEqual(["close", "direction", "index", "kind", "level", "swing_time", "text", "time"]);
    expect(["BOS", "CHoCH"]).toContain(r["events"][0]["kind"]);

    // 关键位与环境
    expect(Object.keys(r["levels"][0]).sort()).toEqual(["distance_pct", "price", "side", "swings", "touches"]);
    expect(r["context"]).toMatchObject({ last: expect.any(Number), atr: expect.any(Number), range_bars: expect.any(Number) });

    // 画图用的 K 线与均线
    expect(r["bars"].length).toBeGreaterThan(0);
    expect(Object.keys(r["bars"][0]).sort()).toEqual(["close", "high", "low", "open", "time", "volume"]);
    expect(Object.keys(r["ma"]).length).toBeGreaterThan(0);
    for (const series of Object.values(r["ma"])) expect((series as unknown[]).length).toBe(r["bars"].length);

    // 计划与解读
    expect(r["plan"]).toMatchObject({ resistance: expect.anything(), support: expect.anything(), watch: expect.any(Array) });
    expect(typeof r["plan"]["confirm"]).toBe("string");
    expect(Array.isArray(r["readout"])).toBe(true);
    expect(r["readout"].length).toBeGreaterThan(0);
    expect(Array.isArray(r["warnings"])).toBe(true);
  });

  it("高周期:htf 是摘要不是全量;agreement 说低周期和它合不合", async () => {
    const { call } = makeServer();
    const r = (await call("pa.analyze", { symbol: "SPY", timeframe: "5m" }))["result"];
    expect(r["htf"]).not.toBeNull();
    // 摘要只有这几项(全量有三十几项)
    expect(Object.keys(r["htf"]).sort()).toEqual(["bias", "bias_label", "last_event", "resistance", "score", "support", "timeframe", "timeframe_label", "trend_label"]);
    expect(Object.keys(r["agreement"]).sort()).toEqual(["state", "text"]);
    expect(typeof r["agreement"]["text"]).toBe("string");
  });

  it("高周期拿不到:htf 是 null、agreement 照给——背景缺了不该毁掉整次分析", async () => {
    const { call, router } = makeServer();
    router.failFor.add("1h");
    const out = await call("pa.analyze", { symbol: "SPY", timeframe: "5m" });
    expect(out["error"]).toBeUndefined();
    expect(out["result"]["htf"]).toBeNull();
    expect(out["result"]["agreement"]["state"]).toBeDefined();
    expect(out["result"]["bias"]).toBeDefined();
  });

  it("日线没有高周期:htf 是 null,而且一次高周期都不去拉(1h 那一级会拉,拿它对照)", async () => {
    const { call, router } = makeServer();
    const r = (await call("pa.analyze", { symbol: "SPY", timeframe: "1d" }))["result"];
    expect(router.asked).toEqual([["SPY", "1d", false]]);
    expect(r["htf"]).toBeNull();
    expect(r["agreement"]).toEqual({ state: "unknown", text: "没有高周期数据可对照。" });

    // 对照组:1h 的高周期是 1d,会多拉一次,htf 也有内容
    const other = makeServer();
    const r2 = (await other.call("pa.analyze", { symbol: "SPY", timeframe: "1h" }))["result"];
    expect(other.router.asked).toEqual([["SPY", "1h", false], ["SPY", "1d", false]]);
    expect(r2["htf"]).not.toBeNull();
    expect(r2["agreement"]["state"]).not.toBe("unknown");
  });

  it("第二次同样的请求吃缓存(cached: true);连 force 也压不过 15 秒的最小重取间隔——那是 IBKR 的超频线,不是性能优化", async () => {
    const { call, router } = makeServer();
    await call("pa.analyze", { symbol: "SPY", timeframe: "5m" });
    const again = (await call("pa.analyze", { symbol: "SPY", timeframe: "5m" }))["result"];
    expect(again["cached"]).toBe(true);
    expect(router.asked).toHaveLength(2); // 5m 与 1h 各一次,没有再拉
    // force 把 TTL 降到 PA_MIN_INTERVAL(15 秒),但没降到 0:同一秒里连点两次,还是缓存
    const forced = (await call("pa.analyze", { symbol: "SPY", timeframe: "5m", force: true }))["result"];
    expect(forced["cached"]).toBe(true);
    expect(router.asked.filter(([, tf]) => tf === "5m")).toHaveLength(1);
    // 换个周期就是另一条缓存键,照拉
    await call("pa.analyze", { symbol: "SPY", timeframe: "15m" });
    expect(router.asked.filter(([, tf]) => tf === "15m")).toHaveLength(1);
  });

  it("rth: true 只看盘中;extended_hours 跟着反过来。给非布尔的真值照收(老 handler 是 Boolean(x),schema 不比它严)", async () => {
    const { call, router } = makeServer();
    const r = (await call("pa.analyze", { symbol: "SPY", timeframe: "5m", rth: true }))["result"];
    expect(router.asked[0]).toEqual(["SPY", "5m", true]);
    expect(r).toMatchObject({ rth: true, extended_hours: false });

    // 界面发的是布尔,但别的调用方给个真值字符串也照收
    const other = makeServer();
    const r2 = (await other.call("pa.analyze", { symbol: "SPY", timeframe: "5m", rth: "yes", force: 1 }))["result"];
    expect(other.router.asked[0]).toEqual(["SPY", "5m", true]);
    expect(r2).toMatchObject({ rth: true, extended_hours: false });
    // rth 给 null / 不给 = 全时段
    const third = makeServer();
    await third.call("pa.analyze", { symbol: "SPY", timeframe: "5m", rth: null });
    expect(third.router.asked[0]).toEqual(["SPY", "5m", false]);
  });

  it("代码 / 周期 / 没连券商 / K 线太少:原话(前两句 golden-rpc 钉着)", async () => {
    const { call, router } = makeServer();
    expect((await call("pa.analyze", { symbol: "bad$" }))["error"]).toEqual({ code: -32602, message: "标的代码不合法:'bad$'" });
    expect((await call("pa.analyze", { symbol: "SPY", timeframe: "7m" }))["error"]).toEqual({
      code: -32602, message: "未知 K 线周期:7m(可选:1m、2m、5m、15m、30m、1h、1d)",
    });
    const off = makeServer({ connected: false });
    expect((await off.call("pa.analyze", { symbol: "SPY" }))["error"]).toEqual({
      code: -32015, message: "实时 K 线需要TWS / IB Gateway:请先在「TWS 连接」面板连接引擎。",
    });
    // 券商报错 / K 线不够,都是 -32015 带原因
    router.failFor.add("5m");
    const err = (await call("pa.analyze", { symbol: "SPY", timeframe: "5m" }))["error"];
    expect(err["code"]).toBe(-32015);
    expect(err["message"]).toContain("没有 SPY 的 5m 行情权限");
  });
});

describe("pa.comment", () => {
  it("回执是「分析 + 模型解读 + 用的哪个模型」;喂给模型的是算好的事实,不是原始 K 线", async () => {
    const { s, call, parser } = makeServer();
    const r = (await call("pa.comment", { symbol: "SPY", timeframe: "5m" }))["result"];
    expect(Object.keys(r).sort()).toEqual(["analysis", "comment", "model"]);
    expect(r["model"]).toBe(s.settings.llm.model);
    expect(r["analysis"]["symbol"]).toBe("SPY");
    expect(Object.keys(r["analysis"]).sort()).toEqual(PA_KEYS); // 和 pa.analyze 同一份
    expect(r["comment"]).toEqual({ summary: "结构偏多", reading: "高点抬高,回踩不破。", watch: ["盯 108"], risks: ["假突破"] });

    expect(parser.calls).toHaveLength(1);
    const user = parser.calls[0]!.user;
    expect(user).toContain("SPY");
    // 事实块里是算好的结论,不是一根根 K 线
    expect(user).not.toContain('"open"');
    expect(user).not.toContain("volume");
    expect(Object.keys(parser.calls[0]!.schema["properties"]).sort()).toEqual(["reading", "risks", "summary", "watch"]);
    // 提示词里明确不许它自己编价格
    expect(parser.calls[0]!.system).toContain("不要自行推算或臆造任何价格");
  });

  it("模型报错 / 回的不合 schema:-32016,原因带出来;分析本身不受影响", async () => {
    const { call, parser } = makeServer();
    parser.reply = new Error("429 限流");
    expect((await call("pa.comment", { symbol: "SPY", timeframe: "5m" }))["error"]).toEqual({ code: -32016, message: "AI 解读失败:429 限流" });
    parser.reply = { summary: "" };
    const bad = (await call("pa.comment", { symbol: "SPY", timeframe: "5m" }))["error"];
    expect(bad["code"]).toBe(-32016);
    expect(bad["message"]).toContain("AI 解读失败:");
    // 分析那一半照样能单独跑
    expect((await call("pa.analyze", { symbol: "SPY", timeframe: "5m" }))["error"]).toBeUndefined();
  });

  it("分析这一步就失败(没连券商):报的是分析那一句,不是 AI 解读失败", async () => {
    const { call } = makeServer({ connected: false });
    const err = (await call("pa.comment", { symbol: "SPY", timeframe: "5m" }))["error"];
    expect(err["code"]).toBe(-32015);
    expect(err["message"]).toContain("实时 K 线需要");
  });
});
