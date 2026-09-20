/** screener.* 在 RPC 这一层的特征测试:输入是界面(Screener.tsx)真实发出来的载荷形状。
 *
 * 算法那一半由 golden-screener 钉着(直接调 rsStrength / screenInflections / deviationReview);golden-rpc 钉了入参的几句报错,
 * 但**跑成功**那条路要连券商拉 K 线,基线里走不到。这里补的就是那一段:板块成分股怎么取(单个 / 全部并集 / 去重)、
 * 某一只拉不到 K 线时这一行怎么降级(不是整次扫描失败)、日内请求的 40 个上限、以及回执里界面读的每一个键。
 * 先于契约迁移写成,迁的时候不改断言。全部离线:券商是假的。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { setClock } from "../src/config.js";
import { BrokerError } from "../src/broker.js";
import { RpcServer } from "../src/rpc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

/** 2026-09-11(周五,交易日)美东 12:00。 */
const NOON = Date.parse("2026-09-11T12:00:00-04:00");

/** 300 根日线:缓慢上行叠正弦,DIF 会来回穿零,均线偏离有起伏。drift 拉开不同标的的强弱。 */
function bars(count = 300, drift = 0.05, amp = 8): Rec[] {
  const out: Rec[] = [];
  let t = Date.parse("2025-01-02T00:00:00Z");
  for (; out.length < count; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day === 0 || day === 6) continue;
    const i = out.length;
    const close = Math.round((100 + amp * Math.sin(i / 11) + i * drift) * 100) / 100;
    out.push({
      time: new Date(t).toISOString().slice(0, 10),
      open: close - 0.3, high: close + 1.2, low: close - 1.1, close, volume: 1_000_000 + i * 1000,
    });
  }
  return out;
}

/** 按给定收盘价序列造日线(跳过周末)。 */
function fromCloses(closes: number[]): Rec[] {
  let t = Date.parse("2025-01-02T00:00:00Z");
  const out: Rec[] = [];
  for (const c of closes) {
    let d = new Date(t).getUTCDay();
    while (d === 0 || d === 6) { t += 86_400_000; d = new Date(t).getUTCDay(); }
    out.push({ time: new Date(t).toISOString().slice(0, 10), open: c - 0.2, high: c + 0.8, low: c - 0.8, close: c, volume: 1_000_000 });
    t += 86_400_000;
  }
  return out;
}

/** 底背离:价格创新低,但第二个谷跌得更缓 → DIF 抬高。最后拐头向上并站回 20 日线(确认成立)。 */
function bullDivergenceBars(): Rec[] {
  const closes: number[] = [];
  for (let i = 0; i < 60; i++) closes.push(100 - i * 0.1);
  for (let i = 0; i < 25; i++) closes.push(94 - i * 0.8);
  for (let i = 0; i < 25; i++) closes.push(74 + i * 0.7);
  for (let i = 0; i < 30; i++) closes.push(91 - i * 0.62);
  for (let i = 0; i < 8; i++) closes.push(72.4 + i * 1.2);
  return fromCloses(closes);
}

/** 尾部急涨 6 根:收盘远离均线,z 分数冲到 2 以上 → 上方极值。 */
function overboughtBars(): Rec[] {
  const out = bars(280);
  let c = out[out.length - 1]!["close"] as number;
  let t = Date.parse("2026-02-02T00:00:00Z");
  for (let i = 0; i < 6; i++) {
    c = Math.round(c * 1.035 * 100) / 100;
    t += 86_400_000;
    out.push({ time: new Date(t).toISOString().slice(0, 10), open: c - 0.3, high: c + 1.2, low: c - 1.1, close: c, volume: 3_000_000 });
  }
  return out;
}

class FakeRouter {
  askedDaily: string[] = [];
  askedIntraday: Array<[string, string]> = [];
  /** 这几只拉日线时抛 BrokerError */
  failDaily = new Set<string>();
  /** 给某只指定一份固定的日线(造背离 / 造极值用) */
  fixed: Record<string, Rec[]> = {};
  drift: Record<string, number> = {};
  sessions(): unknown[] { return [{}]; }
  connectedNames(): string[] { return ["paper"]; }
  async historicalBars(symbol: string): Promise<Rec[]> {
    this.askedDaily.push(symbol);
    if (this.failDaily.has(symbol)) throw new BrokerError(`没有 ${symbol} 的历史行情权限`);
    return this.fixed[symbol] ?? bars(300, this.drift[symbol] ?? 0.05);
  }
  async intradayBars(symbol: string, timeframe: string): Promise<Rec[]> {
    this.askedIntraday.push([symbol, timeframe]);
    return bars(200, 0.04);
  }
}

const servers: RpcServer[] = [];
const dirs: string[] = [];

function makeServer(opts: { connected?: boolean } = {}): { s: RpcServer; router: FakeRouter; call: (m: string, p?: Rec) => Promise<Rec> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-scr-rpc-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
  const s = new RpcServer(settingsPath, () => undefined);
  const router = new FakeRouter();
  if (opts.connected ?? true) s.router = router as never;
  servers.push(s);
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { s, router, call };
}

/** 建两个板块:AI 算力(NVDA 芯片 / VRT 电力)、云(NVDA 重复出现一次 + MSFT)。 */
async function pool(call: (m: string, p?: Rec) => Promise<Rec>): Promise<{ ai: string; cloud: string }> {
  const ai = (await call("sectors.add", { name: "AI 算力" }))["result"]["sector"]["id"];
  await call("sectors.add_stock", { id: ai, symbol: "NVDA", company: "英伟达", tag: "芯片" });
  await call("sectors.add_stock", { id: ai, symbol: "VRT", company: "维谛", tag: "电力" });
  const cloud = (await call("sectors.add", { name: "云" }))["result"]["sector"]["id"];
  await call("sectors.add_stock", { id: cloud, symbol: "NVDA", company: "英伟达", tag: "芯片" });
  await call("sectors.add_stock", { id: cloud, symbol: "MSFT", company: "微软", tag: "软件" });
  return { ai, cloud };
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

describe("screener.rs", () => {
  it("回执的完整形状:每只一行(rs 按窗口)+ 按业务标签汇总 + 基准信息;名次按分数排,没分数的不排名", async () => {
    setClock(NOON);
    const { call, router } = makeServer();
    const { ai } = await pool(call);
    router.drift = { NVDA: 0.12, VRT: 0.02, SPY: 0.05 };
    const r = (await call("screener.rs", { sector: ai, benchmark: "spy" }))["result"];

    expect(Object.keys(r).sort()).toEqual(["bench_bars", "bench_last", "benchmark", "counted", "fetched_at", "rows", "sector", "tags", "total", "windows"]);
    expect(r).toMatchObject({ benchmark: "SPY", sector: "AI 算力", total: 2, counted: 2, bench_bars: 300 });
    expect(r["windows"]).toEqual([5, 20, 60, 120, 250].map((n) => ({ n, label: expect.any(String) })));
    // 强的那只排第一
    expect(r["rows"].map((x: Rec) => [x["symbol"], x["rank"]])).toEqual([["NVDA", 1], ["VRT", 2]]);
    const row = r["rows"][0];
    expect(Object.keys(row).sort()).toEqual(["bars", "company", "error", "last", "rank", "rs", "score", "symbol", "tag"]);
    expect(row).toMatchObject({ symbol: "NVDA", tag: "芯片", company: "英伟达", bars: 300, error: null });
    expect(Object.keys(row["rs"]).sort()).toEqual(["120", "20", "250", "5", "60"]);
    expect(Object.keys(row["rs"]["20"]).sort()).toEqual(["beats", "bench_pct", "ret_pct", "rs_pct"]);
    expect(row["rs"]["20"]["beats"]).toBe(true);
    // 标签汇总:每个标签一行,带中位数与"几只跑赢"
    expect(r["tags"].map((t: Rec) => t["tag"]).sort()).toEqual(["电力", "芯片"]);
    expect(Object.keys(r["tags"][0]).sort()).toEqual(["count", "rs", "score", "symbols", "tag"]);
    expect(Object.keys(r["tags"][0]["rs"]["20"]).sort()).toEqual(["beats", "median_pct", "total"]);
    expect(r["fetched_at"]).toBe(new Date(NOON).toISOString());
  });

  it("某一只拉不到 K 线:这一行 error 有话、bars 0、不参与排名;整次扫描照常出结果", async () => {
    const { call, router } = makeServer();
    const { ai } = await pool(call);
    router.failDaily.add("VRT");
    const r = (await call("screener.rs", { sector: ai }))["result"];
    expect(r["total"]).toBe(2);
    expect(r["counted"]).toBe(1);
    const vrt = r["rows"].find((x: Rec) => x["symbol"] === "VRT");
    expect(vrt).toMatchObject({ bars: 0, score: null, rank: null, last: null });
    expect(vrt["error"]).toContain("没有 VRT 的历史行情权限");
  });

  it("sector 不给 / all:所有板块的并集,同一只只出现一次(以先出现的板块为准)", async () => {
    const { call } = makeServer();
    await pool(call);
    const r = (await call("screener.rs", { sector: "all" }))["result"];
    expect(r["sector"]).toBe("全部板块");
    expect(r["rows"].map((x: Rec) => x["symbol"]).sort()).toEqual(["MSFT", "NVDA", "VRT"]);
    const bare = (await call("screener.rs", {}))["result"];
    expect(bare["sector"]).toBe("全部板块");
    expect(bare["benchmark"]).toBe("SPY"); // 默认基准
  });

  it("基准不认识、板块不存在、池子空的、没连券商:各自那句原话(前两句 golden-rpc 钉着)", async () => {
    const { call } = makeServer();
    expect((await call("screener.rs", { benchmark: "IWM" }))["error"]).toEqual({ code: -32602, message: "基准只能是 SPY / QQQ" });
    expect((await call("screener.rs", { sector: "nope" }))["error"]).toEqual({ code: -32602, message: "板块不存在:nope" });
    expect((await call("screener.rs", {}))["error"]).toEqual({ code: -32602, message: "股票池是空的:先在「板块」页加成分股" });
    const off = makeServer({ connected: false });
    await pool(off.call);
    expect((await off.call("screener.rs", {}))["error"]).toEqual({
      code: -32018, message: "RS 强度扫描需要TWS / IB Gateway:请先在「TWS 连接」面板连接引擎。",
    });
  });

  it("拿不到基准本身的日线:整次报 -32018(没有基准就没有相对强弱可言)", async () => {
    const { call, router } = makeServer();
    await pool(call);
    router.failDaily.add("QQQ");
    const err = (await call("screener.rs", { benchmark: "QQQ" }))["error"];
    expect(err["code"]).toBe(-32018);
    expect(err["message"]).toContain("拿不到基准 QQQ 的日线");
  });
});

describe("screener.inflection", () => {
  it("回执:每只一行 × 每个周期一份信号,外加每周期的计数;去重后的周期原样回", async () => {
    setClock(NOON);
    const { call } = makeServer();
    const { ai } = await pool(call);
    const r = (await call("screener.inflection", { sector: ai, timeframes: ["1d", "1w", "1d"], ma_period: 20 }))["result"];
    expect(Object.keys(r).sort()).toEqual(["fetched_at", "hit_count", "ma_period", "per_timeframe", "rows", "sector", "timeframes", "total"]);
    expect(r["timeframes"]).toEqual(["1d", "1w"]); // 去重,保序
    expect(r).toMatchObject({ sector: "AI 算力", total: 2, ma_period: 20 });
    expect(Object.keys(r["per_timeframe"]).sort()).toEqual(["1d", "1w"]);
    expect(Object.keys(r["per_timeframe"]["1d"]).sort()).toEqual(["bear", "bull", "confirmed"]);
    const row = r["rows"][0];
    expect(Object.keys(row).sort()).toEqual(["company", "confirmed", "hits", "signals", "symbol", "tag"]);
    const sig = row["signals"]["1d"];
    expect(Object.keys(sig).sort()).toEqual(["age", "bars", "confirm", "dif_gap", "dif_last", "dif_side", "label", "last", "pivots", "price_gap_pct", "reason", "signal"]);
    // 给了 ma_period 才有确认信息
    if (sig["signal"]) expect(Object.keys(sig["confirm"]).sort()).toEqual(["age", "at", "ma", "status"]);
  });

  it("真有底背离的一只:signal / pivots / 缺口都填上;给了 ma_period 才有确认信息,不给就是 null", async () => {
    const { call, router } = makeServer();
    const { ai } = await pool(call);
    router.fixed["NVDA"] = bullDivergenceBars();

    const withMa = (await call("screener.inflection", { sector: ai, timeframes: ["1d"], ma_period: 20 }))["result"];
    const hit = withMa["rows"].find((x: Rec) => x["symbol"] === "NVDA")["signals"]["1d"];
    expect(hit).toMatchObject({ signal: "bull", label: "底背离", reason: null });
    expect(hit["pivots"]).toHaveLength(2);
    expect(Object.keys(hit["pivots"][0]).sort()).toEqual(["dif", "index", "price", "time"]);
    // 第二个谷价格更低(创新低),DIF 却更高——这就是底背离
    expect(hit["price_gap_pct"]).toBeLessThan(0);
    expect(hit["dif_gap"]).toBeGreaterThan(0);
    expect(hit["confirm"]).toEqual({ ma: 20, status: "confirmed", at: expect.any(String), age: expect.any(Number) });
    expect(hit["confirm"]["at"]).toHaveLength(10); // 是那一根的日期,不是下标
    expect(withMa["hit_count"]).toBeGreaterThanOrEqual(1);
    expect(withMa["per_timeframe"]["1d"]["bull"]).toBeGreaterThanOrEqual(1);
    expect(withMa["per_timeframe"]["1d"]["confirmed"]).toBeGreaterThanOrEqual(1);

    // 同一份数据不给 ma_period:信号还在,但不编一个确认状态
    const noMa = (await call("screener.inflection", { sector: ai, timeframes: ["1d"] }))["result"];
    const same = noMa["rows"].find((x: Rec) => x["symbol"] === "NVDA")["signals"]["1d"];
    expect(same["signal"]).toBe("bull");
    expect(same["confirm"]).toBeNull();
    expect(noMa["ma_period"]).toBeNull();
    expect(noMa["per_timeframe"]["1d"]["confirmed"]).toBe(0);
  });

  it("日内周期有 40 个(标的×周期)的上限:超出的那些这一格记一句话,不是静默少算", async () => {
    const { call } = makeServer();
    const big = (await call("sectors.add", { name: "大池子" }))["result"]["sector"]["id"];
    for (let i = 0; i < 21; i++) {
      await call("sectors.add_stock", { id: big, symbol: `AA${String.fromCharCode(65 + i)}`, tag: "测试" });
    }
    const r = (await call("screener.inflection", { sector: big, timeframes: ["1h", "30m"] }))["result"];
    expect(r["total"]).toBe(21); // 21 × 2 = 42 > 40
    const notes: string[] = [];
    for (const row of r["rows"]) {
      for (const tf of ["1h", "30m"]) {
        const sig = row["signals"][tf];
        if (sig["error"]) notes.push(sig["error"]);
      }
    }
    expect(notes).toHaveLength(2);
    for (const n of notes) expect(n).toBe("本次日内请求已达上限 40,稍后再扫");
  });

  it("日线 / 周线不吃日内上限;周线是日线重采样来的(不另外问券商)", async () => {
    const { call, router } = makeServer();
    const { ai } = await pool(call);
    await call("screener.inflection", { sector: ai, timeframes: ["1d", "1w"] });
    expect(router.askedIntraday).toEqual([]);
    // 两只股各拉一次日线,1w 复用同一份(缓存)
    expect(router.askedDaily.sort()).toEqual(["NVDA", "VRT"]);
  });

  it("周期不认识 / 不是数组 / 均线周期越界:原话(前三句 golden-rpc 钉着)", async () => {
    const { call } = makeServer();
    await pool(call);
    expect((await call("screener.inflection", { timeframes: ["3m"] }))["error"]).toEqual({
      code: -32602, message: "未知周期:3m(可选:1w、1d、1h、30m、15m)",
    });
    expect((await call("screener.inflection", { timeframes: "1d" }))["error"]).toEqual({ code: -32602, message: "timeframes 要是非空数组" });
    expect((await call("screener.inflection", { timeframes: [] }))["error"]).toEqual({ code: -32602, message: "timeframes 要是非空数组" });
    expect((await call("screener.inflection", { ma_period: 1 }))["error"]).toEqual({ code: -32602, message: "确认均线周期要在 2~250 之间" });
    expect((await call("screener.inflection", { ma_period: "abc" }))["error"]).toEqual({ code: -32602, message: "整数参数不合法:'abc'" });
  });
});

describe("screener.deviation", () => {
  it("回执:序列 + 最后一根 + 极值判定 + 窗口极值 + 中文解读;代码与周期规整过", async () => {
    setClock(NOON);
    const { call } = makeServer();
    const r = (await call("screener.deviation", { symbol: " nvda ", timeframe: "1d" }))["result"];
    expect(Object.keys(r).sort()).toEqual(["bars", "extreme", "extreme_label", "fetched_at", "last", "lookback", "period", "readout", "series", "smooth", "symbol", "timeframe", "window", "z_extreme"]);
    expect(r).toMatchObject({ symbol: "NVDA", timeframe: "1d", period: 20, lookback: 120, smooth: 5, z_extreme: 2.0, bars: 300 });
    expect(r["series"]).toHaveLength(120); // DEFAULT_KEEP
    expect(Object.keys(r["series"][0]).sort()).toEqual(["buy_pct", "close", "dev_pct", "ma", "pressure", "rank_pct", "time", "volume_ratio", "z"]);
    expect(r["last"]).toEqual(r["series"][119]);
    // 这份数据是横着走的:偏离在常态区间
    expect(r["extreme"]).toBeNull();
    expect(r["extreme_label"]).toBe("偏离在常态区间");
    expect(Object.keys(r["window"]).sort()).toEqual(["dev_max", "dev_min", "pressure_max", "pressure_min"]);
    expect(Array.isArray(r["readout"])).toBe(true);
    expect(r["readout"].length).toBeGreaterThan(0);
  });

  it("尾部急涨:extreme 是 overbought,标签跟着它走;解读里说得出「上方极值」", async () => {
    const { call, router } = makeServer();
    router.fixed["NVDA"] = overboughtBars();
    const r = (await call("screener.deviation", { symbol: "NVDA" }))["result"];
    expect(r["extreme"]).toBe("overbought");
    expect(r["extreme_label"]).toBe("上方极值(超买)");
    expect(r["last"]["z"]).toBeGreaterThanOrEqual(r["z_extreme"]);
    expect(r["readout"].join(" ")).toContain("上方极值");
  });
  it("四个参数都能改;数字串照收", async () => {
    const { call } = makeServer();
    const r = (await call("screener.deviation", { symbol: "NVDA", period: "10", lookback: "60", smooth: "1", z_extreme: "1.5" }))["result"];
    expect(r).toMatchObject({ period: 10, lookback: 60, smooth: 1, z_extreme: 1.5 });
  });

  it("代码 / 周期 / 参数越界 / 没连券商:原话(前四句 golden-rpc 钉着)", async () => {
    const { call, router } = makeServer();
    expect((await call("screener.deviation", { symbol: "bad$" }))["error"]).toEqual({ code: -32602, message: "标的代码不合法:'bad$'" });
    expect((await call("screener.deviation", { symbol: "NVDA", timeframe: "5m" }))["error"]).toEqual({
      code: -32602, message: "未知周期:5m(可选:1w、1d、1h、30m、15m)",
    });
    expect((await call("screener.deviation", { symbol: "NVDA", period: 1 }))["error"]).toEqual({
      code: -32602, message: "参数越界:均线 2~250、历史 10~500、平滑 1~50",
    });
    expect((await call("screener.deviation", { symbol: "NVDA", z_extreme: 9 }))["error"]).toEqual({
      code: -32602, message: "极值阈值要在 0.5~5 个标准差之间",
    });
    const off = makeServer({ connected: false });
    expect((await off.call("screener.deviation", { symbol: "NVDA" }))["error"]).toEqual({
      code: -32018, message: "极值偏离需要TWS / IB Gateway:请先在「TWS 连接」面板连接引擎。",
    });
    // 拉不到 K 线:-32018 带原因
    router.failDaily.add("NVDA");
    const err = (await call("screener.deviation", { symbol: "NVDA" }))["error"];
    expect(err["code"]).toBe(-32018);
    expect(err["message"]).toContain("拿不到 NVDA 的 1d K 线");
  });
});
