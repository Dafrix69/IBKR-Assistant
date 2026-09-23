/** 强势股筛选(leaders.ts + screener.leaders):趋势模板、VCP、RS 评级、派发日。K 线是按折线造的,全部离线。 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { BrokerRouter } from "../src/broker.js";
import type { DailyBarIn } from "../src/leaders.js";
import {
  cleanDaily, contractions, detectVcp, distributionDays, marketRegime, ratings, rsScore, screenLeaders,
} from "../src/leaders.js";
import { RpcServer } from "../src/rpc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

/** 按顶点折线插值出每根收盘;高低点 = 收盘 ±0.5%。第 i 根的日期从 2025-06-02 起按日历日数(测试不看星期)。 */
function series(points: Array<[number, number]>, volume: (i: number) => number = () => 1_000_000): DailyBarIn[] {
  const out: DailyBarIn[] = [];
  const last = points[points.length - 1]![0];
  for (let i = 0; i <= last; i += 1) {
    const k = points.findIndex(([at]) => at >= i);
    const [x1, y1] = points[k]!;
    const [x0, y0] = k > 0 ? points[k - 1]! : points[k]!;
    const close = x1 === x0 ? y1 : y0 + ((y1 - y0) * (i - x0)) / (x1 - x0);
    const date = new Date(Date.UTC(2025, 5, 2) + i * 86_400_000).toISOString().slice(0, 10);
    out.push({ date, open: close, high: close * 1.005, low: close * 0.995, close, volume: volume(i) });
  }
  return out;
}

// 教科书的第二阶段 + VCP:230 根从 50 涨到 120,然后三次收缩 20.8% → 11.1% → 5.7%,最后一次缩量,收在枢轴下方 2% 附近
const VCP_POINTS: Array<[number, number]> = [[0, 50], [230, 120], [245, 96], [260, 118], [270, 106], [280, 116], [287, 110.5], [299, 114]];
const dryVolume = (i: number): number => (i > 280 ? 500_000 : 1_000_000);
const LEADER = series(VCP_POINTS, dryVolume);
// 一路往下的:300 根从 120 跌到 60
const LAGGARD = series([[0, 120], [299, 60]]);
// 基准:300 根从 400 涨到 480,量恒定(没有派发日)
const BENCH = series([[0, 400], [299, 480]]);

describe("VCP", () => {
  it("三次收缩一次比一次浅、最后一次缩量,收在枢轴下方 5% 以内 → 临近枢轴", () => {
    const v = detectVcp(cleanDaily(LEADER));
    expect(v).toMatchObject({ found: true, depths: [20.8, 11.1, 5.7], pivot: 116.58, status: "near_pivot", volume_dryup: true, base_bars: 70 });
    expect(v.distance_pct).toBe(-2.21);
  });

  it("越过枢轴:量 ≥ 50 日均量 1.4 倍是放量突破,不够是量不够", () => {
    const pts: Array<[number, number]> = [...VCP_POINTS.slice(0, -1), [299, 118]];
    const loud = detectVcp(cleanDaily(series(pts, (i) => (i === 299 ? 2_000_000 : dryVolume(i)))));
    expect(loud.status).toBe("breakout");
    const quiet = detectVcp(cleanDaily(series(pts, dryVolume)));
    expect(quiet.status).toBe("weak_breakout");
    expect(quiet.reason).toContain("量只有 50 日均量的");
  });

  it("成形但最后一次收缩没缩量:照样列出,结论里直说", () => {
    const loud = screenLeaders([{ symbol: "LOUD", bars: series(VCP_POINTS) }], BENCH, "SPY").rows[0]!;
    expect(loud.vcp).toMatchObject({ found: true, volume_dryup: false });
    expect(loud.verdict).toBe("趋势模板 8/8 · 第二阶段 · VCP 离枢轴 116.58 还有 2.21%(最后一次收缩没缩量)");
  });

  it("回撤没有一次比一次浅 → 不成形,说清楚为什么", () => {
    const bars = cleanDaily(series([[0, 50], [230, 120], [245, 110], [260, 118], [275, 96], [290, 115], [299, 114]]));
    const v = detectVcp(bars);
    expect(v.found).toBe(false);
    expect(v.reason).toContain("没有一次比一次浅");
  });

  it("还贴着新高 → 没有基底;后面的高点更高时,前一段并进去", () => {
    expect(detectVcp(cleanDaily(series([[0, 50], [299, 120]]))).reason).toBe("还贴着新高,没有形成基底");
    // 230 顶 120 → 回到 100 → 反弹到 110 → 回到 104 → 反弹到 115(高于 110)→ 回到 108:110 那个高点并掉
    const { depths } = contractions(cleanDaily(series([[0, 50], [230, 120], [240, 100], [250, 110], [255, 104], [265, 115], [280, 108], [299, 112]])), 230);
    expect(depths).toEqual([17.5, 7]); // 高低点是收盘 ±0.5%:120.6 → 99.5、115.58 → 107.46
  });
});

describe("RS 评级与加权涨幅", () => {
  it("IBD 的权重:近 63 日 40%,126 / 189 / 252 日各 20%;不够 253 根是 null", () => {
    const closes = Array.from({ length: 253 }, (_, i) => 100 + i); // 252 根前是 100,最后是 352
    // r63 = 352/289 − 1、r126 = 352/226 − 1、r189 = 352/163 − 1、r252 = 352/100 − 1
    const want = (0.4 * (352 / 289 - 1) + 0.2 * (352 / 226 - 1) + 0.2 * (352 / 163 - 1) + 0.2 * (352 / 100 - 1)) * 100;
    expect(rsScore(closes)).toBeCloseTo(want, 2);
    expect(rsScore(closes.slice(1))).toBeNull();
  });

  it("池内百分位 1–99;没分数的不排;只有一只不排", () => {
    expect(ratings([10, 30, 20, null, 40])).toEqual([1, 66, 34, null, 99]);
    expect(ratings([10, null])).toEqual([null, null]);
  });
});

describe("趋势模板", () => {
  const r = screenLeaders([
    { symbol: "LEAD", tag: "芯片", bars: LEADER },
    { symbol: "LAG", bars: LAGGARD },
    { symbol: "BAD", bars: [], error: "No security definition" },
  ], BENCH, "SPY");
  const lead = r.rows.find((x) => x.symbol === "LEAD")!;

  it("第二阶段的股 8 条全过,排第一;一路下跌的一条都不过", () => {
    expect(lead.checks.map((c) => [c.key, c.ok])).toEqual([
      ["above_150_200", true], ["ma150_over_200", true], ["ma200_rising", true], ["ma50_over", true],
      ["above_50", true], ["above_low", true], ["near_high", true], ["rs_rating", true],
    ]);
    expect(lead).toMatchObject({ passed: 8, stage2: true });
    expect(lead.verdict).toBe("趋势模板 8/8 · 第二阶段 · VCP 离枢轴 116.58 还有 2.21%");
    expect(r.rows.map((x) => x.symbol)).toEqual(["LEAD", "LAG", "BAD"]);
    const lag = r.rows.find((x) => x.symbol === "LAG")!;
    expect(lag.passed).toBe(0);
    expect(lag.verdict).toContain("没过:价在 150 / 200 日线上、150 日线在 200 日线上 等");
  });

  it("池子不到 10 只:第 8 条只看跑赢基准,notes 里写明", () => {
    expect(lead.checks[7]?.label).toBe("加权涨幅跑赢基准");
    expect(r.rating_universe).toBe(2);
    expect(r.notes.some((n) => n.includes("不到 10 只"))).toBe(true);
  });

  it("拉不到日线的那一只自己带着错,不拖累别的", () => {
    expect(r.rows.find((x) => x.symbol === "BAD")).toMatchObject({ error: "No security definition", verdict: "拉不到日线", passed: 0, close: null });
    expect([r.total, r.stage2_count, r.vcp_count]).toEqual([3, 1, 1]);
  });

  it("日线不够一年:能判的照判,判不了的是 null,不当不及格", () => {
    const short = screenLeaders([{ symbol: "NEW", bars: LEADER.slice(-150) }], BENCH, "SPY").rows[0]!;
    const byKey = Object.fromEntries(short.checks.map((c) => [c.key, c.ok]));
    expect(byKey["above_150_200"]).toBeNull();
    expect(byKey["ma200_rising"]).toBeNull();
    expect(byKey["rs_rating"]).toBeNull();
    expect(short.stage2).toBe(false);
  });
});

describe("大盘方向:派发日", () => {
  it("跌 ≥ 0.2% 且量比前一天大才算;之后涨回 5% 的作废", () => {
    const closes = [100, 100, 99.7, 99.9, 99.85, 100, 99, 99.5];
    const vols = [1, 1, 2, 1, 3, 1, 2, 1];
    const bars = cleanDaily(closes.map((c, i) => ({ date: `2026-09-0${i + 1}`, close: c, volume: vols[i]! * 1e6 })));
    // 第 3 根:跌 0.3%、放量 → 算;第 5 根:跌 0.05% → 不算;第 7 根:跌 1%、放量 → 算
    expect(distributionDays(bars)).toEqual(["2026-09-03", "2026-09-07"]);
    const recovered = cleanDaily([...closes, 106].map((c, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, close: c, volume: (vols[i] ?? 1) * 1e6 })));
    expect(distributionDays(recovered)).toEqual([]);
  });

  it("站在均线上、没有派发日 → 上升趋势;跌破 200 日线 → 调整中;数据不够 → unknown", () => {
    expect(marketRegime("SPY", BENCH)).toMatchObject({ state: "uptrend", label: "上升趋势", distribution_days: 0, ma200_rising: true });
    expect(marketRegime("SPY", series([[0, 480], [299, 400]])).state).toBe("correction");
    expect(marketRegime("SPY", BENCH.slice(0, 100)).state).toBe("unknown");
  });

  it("派发日累积到 4 个 → 承压", () => {
    // 上涨趋势里最后 20 根每 5 根一次放量小跌
    const bars = series([[0, 400], [299, 480]], (i) => (i > 278 && i % 5 === 0 ? 3_000_000 : 1_000_000))
      .map((b, i) => (i > 278 && i % 5 === 0 ? { ...b, close: Number(b.close) * 0.99 } : b));
    const m = marketRegime("SPY", bars);
    expect(m.distribution_days).toBe(4);
    expect(m.state).toBe("pressure");
  });
});

// ---------------------------------------------------------------- RPC

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

describe("screener.leaders:RPC", () => {
  function makeServer(connected: boolean): (m: string, p?: Rec) => Promise<Rec> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-leaders-"));
    dirs.push(dir);
    const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
    const s = new RpcServer(settingsPath, () => undefined);
    servers.push(s);
    if (connected) {
      const router = Object.create(BrokerRouter.prototype) as Rec;
      router["sessions"] = () => [{}];
      s.router = router as never;
      const data: Record<string, DailyBarIn[]> = { SPY: BENCH, LEAD: LEADER, LAG: LAGGARD };
      (s.market as unknown as Rec)["dailyHistory"] = async (sym: string) => {
        if (!data[sym]) throw new Error(`没有 ${sym}`);
        return data[sym];
      };
    }
    return async (method, params = {}) => s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  }

  it("按板块扫:大盘方向 + 每只一行,拉不到的那只带着原话", async () => {
    const call = makeServer(true);
    const sector = (await call("sectors.add", { name: "测试" }))["result"]["sector"];
    for (const symbol of ["LEAD", "LAG", "NOPE"]) await call("sectors.add_stock", { id: sector["id"], symbol });
    const r = (await call("screener.leaders", { sector: sector["id"] }))["result"];
    expect(r["market"]["state"]).toBe("uptrend");
    expect(r["rows"].map((x: Rec) => [x["symbol"], x["passed"]])).toEqual([["LEAD", 8], ["LAG", 0], ["NOPE", 0]]);
    expect(r["rows"][2]["error"]).toBe("没有 NOPE");
    expect(r["sector"]).toBe("测试");
  });

  it("基准不认识、池子空、没连券商:各报各的", async () => {
    const call = makeServer(false);
    expect((await call("screener.leaders", { benchmark: "IWM" }))["error"]["message"]).toBe("基准只能是 SPY / QQQ");
    expect((await call("screener.leaders", {}))["error"]["message"]).toContain("股票池是空的");
    const sector = (await call("sectors.add", { name: "测试" }))["result"]["sector"];
    await call("sectors.add_stock", { id: sector["id"], symbol: "LEAD" });
    expect((await call("screener.leaders", {}))["error"]["code"]).toBe(-32018);
  });
});
