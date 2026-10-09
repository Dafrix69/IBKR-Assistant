/** 信号成绩单:signal_log(只增不改)、signalOutcomes.ts 的打分、review.signals。全部离线。 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { BrokerError } from "../src/broker.js";
import { setClock } from "../src/config.js";
import type { SignalEntry } from "../src/contract/signals.js";
import { RpcServer } from "../src/rpc.js";
import {
  BASELINE_BARS, MIN_WINDOWS, baselineReturn, closeEpoch, entryIndex, entrySessionStart, independentWindows, overlapT, scoreSignals,
  signalFromAnomaly, signalFromLeader, signalFromPa, signalFromWatchEvent, signalReturns, tThreshold, windowBlocks,
} from "../src/signalOutcomes.js";
import type { DailyClose, Observation } from "../src/signalOutcomes.js";
import { TradeStore } from "../src/store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;
const dirs: string[] = [];
const servers: RpcServer[] = [];
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

/** 工作日日线,收盘由 f(第几根) 给。 */
function daily(count: number, f: (i: number) => number, from = "2026-01-05"): DailyClose[] {
  const out: DailyClose[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); out.length < count; t += 86_400_000) {
    const d = new Date(t).getUTCDay();
    if (d === 0 || d === 6) continue;
    out.push({ date: new Date(t).toISOString().slice(0, 10), close: f(out.length) });
  }
  return out;
}

/** 美东那天 11:00 发的信号(冬令时 16:00 UTC;测试里的日期都在冬令时或用 at 明写)。 */
const sig = (date: string, over: Partial<SignalEntry> = {}): SignalEntry => ({
  at: `${date}T16:00:00.000Z`, source: "cross", symbol: "AAA", expect: "up", price: null, label: "x", ...over,
});

/** 可复现的随机数(mulberry32)与标准正态。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const normal = (u: () => number): number => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());

describe("事件 → 信号", () => {
  it("穿越押顺势;碰均线押反弹(从上方回踩押涨);价用这一轮的现价", () => {
    const base = { symbol: "NVDA", price: 180, label: "MA20", source: "ma20", kind: "support" as const, from: 181, to: 179.5, at: 1_790_000_000, text: "" };
    expect(signalFromWatchEvent({ ...base, direction: "up" })).toMatchObject({ source: "cross", expect: "up", price: 179.5 });
    expect(signalFromWatchEvent({ ...base, direction: "down", trigger: "touch" })).toMatchObject({ source: "touch", expect: "up" });
    expect(signalFromWatchEvent({ ...base, direction: "up", trigger: "touch" })).toMatchObject({ source: "touch", expect: "down" });
  });

  it("急涨急跌、大涨大跌押顺势;放量不带方向", () => {
    const base = { id: "x", at: 1_790_000_000, symbol: "AAA", value: 3, threshold: 2, tier: null, sigma: null, price: 10, change_pct: null, basis: "fixed", title: "急跌", text: "" };
    expect(signalFromAnomaly({ ...base, kind: "spike", direction: "down" })).toMatchObject({ source: "spike", expect: "down", label: "急跌" });
    expect(signalFromAnomaly({ ...base, kind: "rvol", direction: "up" })).toMatchObject({ source: "rvol", expect: null });
  });

  it("强势股新入选押涨;K线 PA 押它读出的方向(偏多也算),中性不记,周期进小类", () => {
    const at = Date.parse("2026-01-05T16:00:00Z");
    expect(signalFromLeader({ symbol: "LEAD", close: 114, verdict: "趋势模板 8/8 · 第二阶段" }, at)).toEqual({
      at: "2026-01-05T16:00:00.000Z", source: "leaders", symbol: "LEAD", expect: "up", price: 114, label: "趋势模板 8/8 · 第二阶段",
    });
    const pa = { symbol: "SPX", timeframe: "5m", timeframe_label: "5 分钟", last: 6900.5, score: 32, bias: "lean_bull", bias_label: "偏多" };
    expect(signalFromPa(pa, at)).toEqual({
      at: "2026-01-05T16:00:00.000Z", source: "pa", symbol: "SPX", expect: "up", price: 6900.5, label: "5 分钟 偏多(32)", variant: "5m",
    });
    expect(signalFromPa({ ...pa, score: -60, bias: "bearish", bias_label: "看跌" }, at)).toMatchObject({ expect: "down", label: "5 分钟 看跌(-60)" });
    expect(signalFromPa({ ...pa, score: 3, bias: "neutral", bias_label: "中性 / 观望" }, at)).toBeNull();
  });

  it("K线 PA 只记一次的那一段:从上一个收盘起算——和打分时进场落在哪一根是同一条界线", () => {
    const weekdays = (d: string): boolean => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()) && d !== "2026-01-19";
    const start = (iso: string, early?: ReadonlySet<string>): string => entrySessionStart(Date.parse(iso), weekdays, early);
    const thursdayClose = "2026-01-08T21:00:00.000Z"; // 冬令时 16:00 = 21:00Z
    // 周四 21:00(收盘后)、周五 02:00、周五 11:00:进场都是周五收盘,同一段
    expect(start("2026-01-09T02:00:00Z")).toBe(thursdayClose);
    expect(start("2026-01-09T07:00:00Z")).toBe(thursdayClose);
    expect(start("2026-01-09T16:00:00Z")).toBe(thursdayClose);
    expect(start("2026-01-09T20:59:59Z")).toBe(thursdayClose);
    // 周五正好 16:00 起是下一段(进场是周一);周末、周一盘前都还在这一段
    expect(start("2026-01-09T21:00:00Z")).toBe("2026-01-09T21:00:00.000Z");
    expect(start("2026-01-11T15:00:00Z")).toBe("2026-01-09T21:00:00.000Z");
    expect(start("2026-01-12T13:00:00Z")).toBe("2026-01-09T21:00:00.000Z");
    // 周一休市(2026-01-19):周二盘前还是上周五收盘那一段
    expect(start("2026-01-20T13:00:00Z")).toBe("2026-01-16T21:00:00.000Z");
    // 提前收盘日 13:00 就换段;夏令时的 16:00 是 20:00Z
    expect(start("2026-01-08T19:00:00Z", new Set(["2026-01-08"]))).toBe("2026-01-08T18:00:00.000Z");
    expect(start("2026-07-07T03:00:00Z")).toBe("2026-07-06T20:00:00.000Z");
    expect(closeEpoch("2026-07-06")).toBe(Date.parse("2026-07-06T20:00:00Z"));
    // 和 entryIndex 对得上:一段的起点那一刻发的信号,进场是下一根;前一秒发的还是当天那根
    const bars = daily(10, (i) => 100 + i); // 2026-01-05 起
    expect(entryIndex(bars, Date.parse(thursdayClose))).toBe(4);
    expect(entryIndex(bars, Date.parse(thursdayClose) - 1000)).toBe(3);
  });
});

describe("一条信号的收益", () => {
  const bars = daily(30, (i) => 100 + i); // 每天涨 1;bars[0] 是 2026-01-05(周一)

  it("盘中发的:从当天收盘进场,到之后第 k 个交易日的收盘;押跌的反号;不带方向给绝对涨跌", () => {
    const s = sig(bars[0]!.date);
    expect(entryIndex(bars, Date.parse(s.at))).toBe(0);
    expect(signalReturns(s, bars)).toEqual([1, 5, 20]);
    expect(signalReturns({ ...s, expect: "down" }, bars)).toEqual([-1, -5, -20]);
    expect(signalReturns({ ...s, expect: null }, daily(30, (i) => 100 - i))[0]).toBe(1);
  });

  it("发出时的价不进计算:之后拆股、分红把整段日线重标了,收益一个数都不变", () => {
    const s = sig(bars[0]!.date, { price: 100.4 });
    const split = bars.map((b) => ({ ...b, close: b.close / 4 })); // 一拆四之后取回来的复权日线
    expect(signalReturns(s, split)).toEqual(signalReturns({ ...s, price: null }, bars));
    expect(signalReturns({ ...s, price: 9999 }, bars)).toEqual([1, 5, 20]);
  });

  it("收盘之后、周末发的:从下一个交易日的收盘进场——之前那个收盘在信号前面,不能当进场价", () => {
    // 2026-01-05 美东 17:00(22:00Z):当天已经收盘,进场是周二那根
    expect(entryIndex(bars, Date.parse("2026-01-05T22:00:00Z"))).toBe(1);
    expect(signalReturns(sig("x", { at: "2026-01-05T22:00:00.000Z" }), bars)[0]).toBeCloseTo((102 / 101 - 1) * 100, 4);
    // 正好 16:00 算收盘之后;15:59 还算盘中
    expect(entryIndex(bars, Date.parse("2026-01-05T21:00:00Z"))).toBe(1);
    expect(entryIndex(bars, Date.parse("2026-01-05T20:59:00Z"))).toBe(0);
    // 2026-01-10 是周六:进场是下周一(第 5 根),第 1 天是周二
    expect(entryIndex(bars, Date.parse("2026-01-10T16:00:00Z"))).toBe(5);
    expect(signalReturns(sig("2026-01-10"), bars)[0]).toBeCloseTo((106 / 105 - 1) * 100, 4);
    // 盘前(美东 08:00)发的:当天那根
    expect(entryIndex(bars, Date.parse("2026-01-06T13:00:00Z"))).toBe(1);
  });

  it("提前收盘日 13:00 之后发的算收盘之后", () => {
    const early = new Set([bars[3]!.date]);
    const at = Date.parse(`${bars[3]!.date}T19:00:00Z`); // 美东 14:00
    expect(entryIndex(bars, at, early)).toBe(4);
    expect(entryIndex(bars, at, new Set())).toBe(3);
  });

  it("日线没覆盖到信号那天、之后还没有收盘、持有期没走完:都是空", () => {
    expect(entryIndex(bars, Date.parse("2025-12-01T16:00:00Z"))).toBe(-1);
    expect(signalReturns(sig("2025-12-01"), bars)).toEqual([null, null, null]);
    expect(entryIndex(bars, Date.parse(`${bars[29]!.date}T22:00:00Z`))).toBe(-1); // 最后一根收盘之后
    expect(signalReturns(sig(bars[25]!.date), bars)).toEqual([expect.any(Number), null, null]);
  });
});

describe("基线:只用信号之前的日线", () => {
  // 前 300 根每天 +0.1%;之后每天 +2%
  const bars = daily(340, (i) => (i <= 300 ? 100 * 1.001 ** i : 100 * 1.001 ** 300 * 1.02 ** (i - 300)));

  it("进场那根之前的 250 个持有期的平均;之后涨成什么样都不影响它", () => {
    const b = baselineReturn(bars, 300, 5, false);
    expect(b).toBeCloseTo((1.001 ** 5 - 1) * 100, 8);
    const crashed = bars.map((x, i) => (i >= 300 ? { ...x, close: x.close * 0.5 } : x));
    expect(baselineReturn(crashed, 300, 5, false)).toBe(b); // 进场那根与之后的,一根都没用到
    // 往后挪 10 根,窗口里才开始有那段 +2%
    expect(baselineReturn(bars, 310, 5, false)!).toBeGreaterThan(b! + 0.1);
  });

  it("之前的日线不够 250 + k 根:没有基线,不拿短一截的凑", () => {
    expect(baselineReturn(bars, BASELINE_BARS + 5, 5, false)).not.toBeNull();
    expect(baselineReturn(bars, BASELINE_BARS + 4, 5, false)).toBeNull();
    expect(baselineReturn(bars, 260, 20, false)).toBeNull();
  });

  it("不带方向的取平均绝对涨跌", () => {
    const zig = daily(300, (i) => (i % 2 ? 110 : 100));
    expect(baselineReturn(zig, 290, 1, false)).toBeCloseTo((10 - 100 / 11) / 2, 6);
    expect(baselineReturn(zig, 290, 1, true)).toBeCloseTo((10 + 100 / 11) / 2, 6);
  });
});

describe("t 值:每一段互不重叠的持有期一票", () => {
  /** 普通的 t(不取整):对照用。 */
  const plainT = (xs: number[]): number => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
    return (m / sd) * Math.sqrt(xs.length);
  };
  const classic = (xs: number[]): number => Math.round(plainT(xs) * 100) / 100;
  const xs = [1.2, -0.4, 2.1, 0.3, 1.5, -0.9, 0.8, 1.9, 0.2, 1.1];
  const avg = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;

  it("互不重叠的持有期有几段:同一天的算一段,挨着的并成一段", () => {
    expect(independentWindows([3, 3, 3, 3], 1)).toBe(1);
    expect(independentWindows([0, 1, 2, 3, 4], 5)).toBe(1);
    expect(independentWindows([0, 1, 2, 3, 4, 5], 5)).toBe(2);
    expect(independentWindows([10, 0, 5, 7], 5)).toBe(3);
    expect(independentWindows([], 5)).toBe(0);
    // 每个进场日属于第几段:离这一段第一天满 k 天才开下一段
    expect(windowBlocks([0, 1, 4, 5, 6, 9, 10, 30], 5)).toEqual([0, 0, 0, 1, 1, 1, 2, 3]);
  });

  it("互不重叠时就是普通的 t,均值就是算术平均", () => {
    const obs = xs.map((excess, i) => ({ day: i * 5, excess }));
    const out = overlapT(obs, 5);
    expect(out).toMatchObject({ t: classic(xs), independent: 10, flat: false });
    expect(out.mean).toBeCloseTo(avg(xs), 12);
  });

  it("同一条信号记十遍(同一天同样的涨跌),结果不变;当成独立样本的 t 会涨成 √10 倍", () => {
    const once = xs.map((excess, i) => ({ day: i * 5, excess }));
    const tenfold = once.flatMap((o) => Array.from({ length: 10 }, () => o));
    expect(overlapT(tenfold, 5).t).toBe(overlapT(once, 5).t);
    expect(overlapT(tenfold, 5).mean).toBeCloseTo(overlapT(once, 5).mean!, 12);
    expect(classic(tenfold.map((o) => o.excess))).toBeGreaterThan(3 * classic(xs));
  });

  it("一天里发了一大批的那一天只有一票:19 个各发一条的日子(合计为 0)加上一天 24 条 +3,不是「好」", () => {
    // 按条数平均:均值 72 / 43 = 1.67,那一天自己定了均值、在方差里又几乎不占分量 → 2.13(过线)。按段:20 段里只有 1 段是 +3
    const quiet = Array.from({ length: 19 }, (_, i) => ({ day: i * 5, excess: i === 18 ? 0 : i % 2 ? -1 : 1 }));
    const big = (count: number, x: number): Observation[] => Array.from({ length: count }, () => ({ day: 95, excess: x }));
    const dayMeans = [...quiet.map((o) => o.excess), 3];
    // 手算:20 个进场日的平均是 9 个 +1、9 个 −1、1 个 0、1 个 +3 → 均值 0.15;离差平方和 27 − 20 × 0.15² = 26.55;
    // 标准误 √(26.55 / 19 / 20) = 0.2643;t = 0.15 / 0.2643 = 0.57
    const want = 0.57;
    expect(classic(dayMeans)).toBe(want);
    const out = overlapT([...quiet, ...big(24, 3)], 5);
    expect(out).toMatchObject({ t: want, independent: 20, flat: false });
    expect(out.mean).toBeCloseTo(0.15, 12);
    // 那一天发 1 条还是 100 条,结果一样;方向反过来只是变号
    for (const count of [1, 5, 100]) expect(overlapT([...quiet, ...big(count, 3)], 5).t).toBe(want);
    expect(overlapT([...quiet, ...big(24, -3)], 5).t).toBe(-want);
    expect(classic([...quiet, ...big(24, 3)].map((o) => o.excess))).toBeGreaterThan(5); // 当成 43 个独立样本
  });

  it("连着发了一阵的那一段也只有一票:19 个孤立的日子加上连着 20 天每天 24 条(持有 20 天),和那一段只发一条一样", () => {
    const quiet = Array.from({ length: 19 }, (_, i) => ({ day: i * 40, excess: i === 18 ? 0 : i % 2 ? -1 : 1 }));
    const run = Array.from({ length: 20 }, (_, d) => Array.from({ length: 24 }, () => ({ day: 760 + d, excess: 3 }))).flat();
    const want = classic([...quiet.map((o) => o.excess), 3]);
    expect(overlapT([...quiet, ...run], 20)).toMatchObject({ t: want, independent: 20 });
    expect(overlapT([...quiet, { day: 760, excess: 3 }], 20).t).toBe(want);
  });

  it("和照着定义逐对硬算的一致:进场日并成一条、每段一票,相距不到 k 天的每一对带着票数求和,乘 G / (G − 1)", () => {
    const u = rng(42);
    for (const k of [1, 5, 20]) {
      const obs: Observation[] = Array.from({ length: 150 }, () => ({ day: Math.floor(u() * 160), excess: normal(u) + 0.3 }));
      // 进场日并成一条
      const dayList = [...new Set(obs.map((o) => o.day))].sort((a, b) => a - b);
      const dayMean = dayList.map((d) => avg(obs.filter((o) => o.day === d).map((o) => o.excess)));
      // 排段:离这一段第一天满 k 天开下一段
      const blockOf: number[] = [];
      let anchor = -Infinity;
      for (const d of dayList) {
        if (d - anchor >= k) { anchor = d; blockOf.push((blockOf[blockOf.length - 1] ?? -1) + 1); } else blockOf.push(blockOf[blockOf.length - 1]!);
      }
      const g = blockOf[blockOf.length - 1]! + 1;
      const w = blockOf.map((b) => 1 / (g * blockOf.filter((x) => x === b).length));
      const m = dayMean.reduce((a, x, i) => a + w[i]! * x, 0);
      let sum = 0;
      for (const [i, di] of dayList.entries()) for (const [j, dj] of dayList.entries()) {
        if (Math.abs(di - dj) < k) sum += w[i]! * (dayMean[i]! - m) * w[j]! * (dayMean[j]! - m);
      }
      const want = Math.round((m / Math.sqrt(sum * (g / (g - 1)))) * 100) / 100;
      const out = overlapT(obs, k);
      expect(out).toMatchObject({ t: want, independent: g, flat: false });
      expect(out.mean).toBeCloseTo(m, 12);
      expect(g).toBe(independentWindows(obs.map((o) => o.day), k));
    }
  });

  it("不到 5 段互不重叠的持有期不算 t;每条都一样是 flat", () => {
    expect(overlapT(xs.map((excess, i) => ({ day: i, excess })), 5)).toMatchObject({ t: null, independent: 2, flat: false });
    expect(overlapT(xs.map((_, i) => ({ day: i * 5, excess: 0.7 })), 5)).toMatchObject({ t: null, independent: 10, flat: true });
    expect(overlapT([], 5)).toEqual({ t: null, mean: null, independent: 0, flat: false });
  });

  describe("|t| 的门槛", () => {
    /** P(|T| ≥ x),自由度 df:把 t 密度换元成 cos^(df−1)θ 之后用辛普森公式数值积分(和实现里的有限和是两条路)。 */
    function tTail(x: number, df: number): number {
      const simpson = (from: number, to: number): number => {
        const n = 20_000, h = (to - from) / n;
        let acc = 0;
        for (let i = 0; i <= n; i += 1) acc += Math.cos(from + i * h) ** (df - 1) * (i === 0 || i === n ? 1 : i % 2 ? 4 : 2);
        return (acc * h) / 3;
      };
      return simpson(Math.atan(x / Math.sqrt(df)), Math.PI / 2) / simpson(0, Math.PI / 2);
    }
    const LEVEL = 0.0455002639; // 正态下 |z| ≥ 2

    it("刚满 20 段:一类 2.14、两类 2.48、八类 3.12;段数越多越接近 2", () => {
      expect([1, 2, 8].map((m) => tThreshold(m, 20))).toEqual([2.14, 2.48, 3.12]);
      expect([1, 2, 8].map((m) => tThreshold(m, 30))).toEqual([2.09, 2.41, 2.99]);
      expect(tThreshold(1, 61)).toBe(2.04);
      expect(tThreshold(1, 5000)).toBe(2);
      expect(tThreshold(0, 20)).toBe(2.14); // 一类都没有:按一类算
      expect(tThreshold(1, 5)).toBe(2.87); // 自由度 4
    });

    it("取出来的门槛确实把尾概率压在 4.55% / m(独立的数值积分核对)", () => {
      for (const [m, windows] of [[1, 20], [2, 20], [8, 20], [1, 21], [3, 30], [5, 61], [1, 6]] as const) {
        const thr = tThreshold(m, windows);
        // 取整到两位:真值落在 thr ± 0.005 里
        expect(tTail(thr - 0.005, windows - 1)).toBeGreaterThanOrEqual(LEVEL / m);
        expect(tTail(thr + 0.005, windows - 1)).toBeLessThanOrEqual(LEVEL / m);
      }
    });
  });

  describe("没有真本事的信号,过线的比例(名义 4.55%)", () => {
    /** 每个进场日之后 k 天的收益之和(第 d 天进场 → 第 d+1 … d+k 天),共 `days` 个。 */
    const forward = (rets: number[], k: number, days: number): number[] => {
      const out: number[] = [];
      let acc = 0;
      for (let i = 1; i <= k; i += 1) acc += rets[i] ?? 0;
      for (let d = 0; d < days; d += 1) {
        out.push(acc);
        acc += (rets[d + k + 1] ?? 0) - (rets[d + 1] ?? 0);
      }
      return out;
    };
    /** `symbols` 只两两相关 `rho` 的标的的日收益(独立同分布、没有任何可预测的东西)。 */
    const world = (u: () => number, symbols: number, rho: number, length: number): number[][] => {
      const market = Array.from({ length }, () => normal(u));
      return Array.from({ length: symbols }, () => market.map((m) => Math.sqrt(rho) * m + Math.sqrt(1 - rho) * normal(u)));
    };
    /** 跑 `runs` 遍:按段数取门槛之后过线的比例,和当成独立样本、门槛 2 的比例。 */
    function rates(seed: number, k: number, runs: number, design: (u: () => number) => Observation[]): { robust: number; naive: number; windows: number } {
      const u = rng(seed);
      const bar = new Map<number, number>();
      let robust = 0, naive = 0, windows = 0;
      for (let r = 0; r < runs; r += 1) {
        const obs = design(u);
        const out = overlapT(obs, k);
        windows = out.independent;
        if (!bar.has(windows)) bar.set(windows, tThreshold(1, windows));
        if (out.t !== null && Math.abs(out.t) >= (bar.get(windows) ?? Infinity)) robust += 1;
        if (Math.abs(plainT(obs.map((o) => o.excess))) >= 2) naive += 1;
      }
      return { robust: robust / runs, naive: naive / runs, windows };
    }
    /** 每只标的每天一条。 */
    const everyDay = (symbols: number, rho: number, k: number, days: number) => (u: () => number): Observation[] =>
      world(u, symbols, rho, days + k + 1).flatMap((rets) => forward(rets, k, days).map((excess, day) => ({ day, excess })));
    /**
     * `quiet` 个孤立的日子各一条(彼此隔 2k 天,持有期互不重叠:k 天收益之和就是 N(0, k),直接抽),
     * 然后连着 `run` 天、`symbols` 只标的天天都发。
     */
    const quietThenRun = (quiet: number, run: number, symbols: number, rho: number, k: number) => (u: () => number): Observation[] => {
      const obs: Observation[] = Array.from({ length: quiet }, (_, j) => ({ day: j * 2 * k, excess: Math.sqrt(k) * normal(u) }));
      const start = quiet * 2 * k;
      for (const rets of world(u, symbols, rho, run + k + 1)) {
        for (const [d, excess] of forward(rets, k, run).entries()) obs.push({ day: start + d, excess });
      }
      return obs;
    };
    const near = (rate: number): void => {
      expect(rate).toBeGreaterThan(0.03);
      expect(rate).toBeLessThan(0.065);
    };

    it("一只标的每天一条,持有 5 天,100 天(20 段)", () => {
      const r = rates(101, 5, 6000, everyDay(1, 0, 5, 100));
      expect(r.windows).toBe(20);
      near(r.robust);
      expect(r.naive).toBeGreaterThan(0.3);
    });

    it("8 只两两相关 0.5 的标的每天各一条,持有 5 天,100 天(800 条,20 段)", () => {
      const r = rates(102, 5, 3000, everyDay(8, 0.5, 5, 100));
      expect(r.windows).toBe(20);
      near(r.robust);
      expect(r.naive).toBeGreaterThan(0.55);
    });

    it("一只标的每天一条,持有 20 天,400 天(20 段)", () => {
      const r = rates(103, 20, 3000, everyDay(1, 0, 20, 400));
      expect(r.windows).toBe(20);
      near(r.robust);
      expect(r.naive).toBeGreaterThan(0.5);
    });

    it("19 个孤立的日子,加上一天里 24 只相关 0.6 的标的一起发(全市场大跌那种)", () => {
      const r = rates(104, 5, 6000, quietThenRun(19, 1, 24, 0.6, 5));
      expect(r.windows).toBe(20);
      near(r.robust);
      expect(r.naive).toBeGreaterThan(0.3);
    });

    it("19 个孤立的日子,加上连着 10 天 24 只标的天天发(持有 5 天)", () => {
      const r = rates(105, 5, 3000, quietThenRun(19, 10, 24, 0.5, 5));
      expect(r.windows).toBe(21);
      near(r.robust);
      expect(r.naive).toBeGreaterThan(0.5);
    });

    it("同时判八类(每类都刚满 20 段):至少有一类碰巧过线的比例也在名义水平附近", () => {
      const bar = tThreshold(8, 20);
      expect(bar).toBe(3.12);
      const family = (seed: number, runs: number, design: (u: () => number) => Observation[]): number => {
        const u = rng(seed);
        let any = 0;
        for (let r = 0; r < runs; r += 1) {
          let hit = false;
          for (let type = 0; type < 8; type += 1) {
            const t = overlapT(design(u), 5).t;
            if (t !== null && Math.abs(t) >= bar) hit = true;
          }
          if (hit) any += 1;
        }
        return any / runs;
      };
      // 持有期互不重叠(每 5 天一条):这时 t 分布是精确的
      const apart = family(107, 3000, (u) => Array.from({ length: 20 }, (_, i) => ({ day: i * 5, excess: normal(u) })));
      near(apart);
      // 每天一条、持有期层层重叠:方差是估出来的,尾巴略厚
      const daily = family(108, 2000, everyDay(1, 0, 5, 100));
      expect(daily).toBeGreaterThan(0.03);
      expect(daily).toBeLessThan(0.085);
    });

    it("19 个孤立的日子,加上连着 20 天 24 只标的天天发(持有 20 天)", () => {
      const r = rates(106, 20, 2000, quietThenRun(19, 20, 24, 0.5, 20));
      expect(r.windows).toBe(20);
      near(r.robust);
      expect(r.naive).toBeGreaterThan(0.5);
    });
  });
});

describe("成绩单", () => {
  // 平时每天 +0.1%;每个信号日的第二天跳涨 1.5%~2.5%(不一样大,t 才算得出来)。信号隔 8 个交易日一条,5 天的持有期互不重叠
  const signalDays = Array.from({ length: 30 }, (_, j) => 270 + j * 8);
  const jumps = new Map(signalDays.map((d, j) => [d + 1, 1.015 + (j % 5) * 0.0025]));
  let level = 100;
  const bars = daily(540, (i) => (level *= i === 0 ? 1 : jumps.get(i) ?? 1.001), "2024-01-01");
  const signals = signalDays.map((d) => sig(bars[d]!.date, { at: `${bars[d]!.date}T15:00:00.000Z` }));
  const book = new Map([["AAA", bars]]);

  it("押对的信号:5 天后比随手一天好,t 过线 → good", () => {
    const r = scoreSignals(signals, book, null);
    const g = r.groups[0]!;
    expect(g).toMatchObject({ source: "cross", variant: null, signals: 30, tone: "good" });
    expect(g.horizons.map((h) => h.horizon)).toEqual([1, 5, 20]);
    expect(g.horizons[1]).toMatchObject({ n: 30, independent: 30, hit_rate: 100 });
    expect(g.horizons[1]!.edge_pct).toBeGreaterThan(0);
    expect(g.horizons[1]!.t).toBeGreaterThanOrEqual(2);
    // 20 天的持有期隔 8 天一条就叠在一起了:30 条只有 10 段
    expect(g.horizons[2]).toMatchObject({ independent: 10 });
    // 30 段:门槛按自由度 29 的 t 取,结论里写明
    expect(r.t_threshold).toBe(2.09);
    expect(g.verdict).toMatch(/^5 天后押的方向比随手一天好 [\d.]+ 个百分点\(t = [\d.]+,\|t\| 过 2\.09 才算\)$/);
    expect(r.dropped).toEqual({ uncovered: 0, no_baseline: 0 });
  });

  it("反过来押就是 bad;取不到日线的标的列出来;之前日线不够的没有基线、不进成绩", () => {
    const flipped = signals.map((s) => ({ ...s, expect: "down" as const }));
    expect(scoreSignals(flipped, book, null).groups[0]!.tone).toBe("bad");
    const blind = scoreSignals([...signals, sig(bars[5]!.date, { symbol: "ZZZ" })], book, 30);
    expect(blind.missing_symbols).toEqual(["ZZZ"]);
    expect(blind.recent[0]).toMatchObject({ symbol: "ZZZ", returns: [null, null, null] });
    expect(blind.days).toBe(30);
    // 第 100 根发的:收益算得出,之前只有 100 根日线,没有基线
    const young = scoreSignals([...signals, sig(bars[100]!.date, { at: `${bars[100]!.date}T15:00:00.000Z` })], book, null);
    expect(young.groups[0]).toMatchObject({ signals: 31 });
    expect(young.groups[0]!.horizons[1]!.n).toBe(30);
    expect(young.recent[0]!.returns[1]).not.toBeNull();
    expect(young.notes.join("\n")).toContain("1 条信号之前的日线不够 255 根");
    expect(young.dropped).toEqual({ uncovered: 0, no_baseline: 1 });
  });

  it("比取到的日线还早的信号:数出来、说出来,不是无声无息地少了一条", () => {
    // 日线从 2024-01-01 起;2023 年发的两条在它前面(长的那段没取到、退回 420 天时就是这样)
    const old = [sig("2023-06-05"), sig("2023-12-29")];
    const r = scoreSignals([...old, ...signals], book, null);
    expect(r.dropped).toEqual({ uncovered: 2, no_baseline: 0 });
    expect(r.notes.join("\n")).toContain("2 条信号比取到的日线还早");
    expect(r.groups[0]).toMatchObject({ signals: 32 });
    expect(r.groups[0]!.horizons[1]).toMatchObject({ n: 30 });
    // 还没走完的不算在里面:最后一根之后才发的那条只是没到时候
    const late = scoreSignals([...signals, sig("x", { at: `${bars[539]!.date}T22:00:00.000Z` })], book, null);
    expect(late.dropped.uncovered).toBe(0);
    expect(late.notes.join("\n")).not.toContain("比取到的日线还早");
  });

  it("条数再多,互不重叠的持有期不到 20 段就不下结论", () => {
    // 19 段:差一段
    const few = scoreSignals(signals.slice(0, MIN_WINDOWS - 1), book, null).groups[0]!;
    expect(few).toMatchObject({ tone: "info" });
    expect(few.verdict).toBe("互不重叠的 5 天持有期只有 19 段,不到 20 段,先攒着,不下结论");
    // 同一天 40 条(一轮里反复穿同一批价位):40 条只是一段
    const burst = scoreSignals(Array.from({ length: 40 }, () => signals[3]!), book, null).groups[0]!;
    expect(burst.horizons[1]).toMatchObject({ n: 40, independent: 1, t: null });
    // 平均按段算:40 条同一天的就是那一天的数,和只发一条一样
    expect(burst.horizons[1]!.mean_pct).toBe(scoreSignals([signals[3]!], book, null).groups[0]!.horizons[1]!.mean_pct);
    expect(burst.tone).toBe("info");
    // 连着 40 个交易日每天一条:8 段
    const run = Array.from({ length: 40 }, (_, j) => sig(bars[300 + j]!.date, { at: `${bars[300 + j]!.date}T15:00:00.000Z` }));
    expect(scoreSignals(run, book, null).groups[0]!.horizons[1]).toMatchObject({ n: 40, independent: 8 });
  });

  it("同时够得上下结论的有两类:门槛再抬一档,结论里写明;没够数的那一类不占名额", () => {
    const spikes = signals.map((s) => ({ ...s, source: "spike" as const }));
    const touches = signals.slice(0, 5).map((s) => ({ ...s, source: "touch" as const }));
    const r = scoreSignals([...signals, ...spikes, ...touches], book, null);
    expect(r.t_threshold).toBe(2.41); // 两类、各 30 段
    expect(r.groups.map((g) => [g.source, g.tone])).toEqual([["cross", "good"], ["touch", "info"], ["spike", "good"]]);
    expect(r.groups[0]!.verdict).toContain("同时判 2 类,|t| 过 2.41 才算");
    expect(r.notes.join("\n")).toContain("同时给 2 类信号下结论,其中段数最少的一类有 30 段:|t| 要过 2.41");
    // 段数最少的那一类定自由度:spike 只剩 20 段时,两类的门槛都按 20 段算
    const mixed = scoreSignals([...signals, ...spikes.slice(0, 20)], book, null);
    expect(mixed.t_threshold).toBe(2.48);
    expect(scoreSignals(signals, book, null).groups[0]!.verdict).not.toContain("同时判");
    // 一类都还不够:给的是刚满 20 段时一类要过的数
    expect(scoreSignals(touches, book, null).t_threshold).toBe(2.14);
  });

  it("t 过了一类的门槛、没过两类的:单看是 good,两类一起判就分不出来", () => {
    // 20 段、每段的超额一大正一小负地摆:t 落在 2.14 与 2.48 之间
    const flat = daily(700, () => 100, "2023-01-02");
    const wobble = flat.map((b, i) => {
      const j = Math.floor((i - 300) / 8);
      const hit = i >= 300 && (i - 300) % 8 >= 1 && j < 20;
      return hit ? { ...b, close: 100 * (1 + (j % 2 ? 0.0082 : -0.0024)) } : b;
    });
    const mine = Array.from({ length: 20 }, (_, j) => sig("x", { at: `${wobble[300 + j * 8]!.date}T15:00:00.000Z` }));
    const alone = scoreSignals(mine, new Map([["AAA", wobble]]), null);
    const t = alone.groups[0]!.horizons[1]!.t!;
    expect(alone.t_threshold).toBe(2.14);
    expect(t).toBeGreaterThanOrEqual(2.14);
    expect(t).toBeLessThan(2.48);
    expect(alone.groups[0]!.tone).toBe("good");
    const both = scoreSignals([...mine, ...mine.map((s) => ({ ...s, source: "spike" as const }))], new Map([["AAA", wobble]]), null);
    expect(both.t_threshold).toBe(2.48);
    expect(both.groups[0]).toMatchObject({ tone: "warn" });
    expect(both.groups[0]!.verdict).toContain("分不出来");
  });

  it("过了 2、没过 20 段时的 2.14:分不出来(段数少的时候 2 不够)", () => {
    const flat = daily(700, () => 100, "2023-01-02");
    const wobble = flat.map((b, i) => {
      const j = Math.floor((i - 300) / 8);
      const hit = i >= 300 && (i - 300) % 8 >= 1 && j < 20;
      return hit ? { ...b, close: 100 * (1 + (j % 2 ? 0.0072 : -0.0024)) } : b;
    });
    const mine = Array.from({ length: 20 }, (_, j) => sig("x", { at: `${wobble[300 + j * 8]!.date}T15:00:00.000Z` }));
    const g = scoreSignals(mine, new Map([["AAA", wobble]]), null).groups[0]!;
    expect(g.horizons[1]!.t).toBe(2.1);
    expect(g).toMatchObject({ tone: "warn", verdict: "5 天后和随手一天分不出来(差 0.24 个百分点,t = 2.1,|t| 过 2.14 才算)" });
  });

  it("全市场一起动的那一天不会自己定结论:19 个各发一条的平日 + 一天 24 只一起发、第二天齐涨 3%", () => {
    // 24 只标的:平时不动;第 500 根之后那一天一起涨 3%。平日的信号发在不动的日子上(超额为 0)
    const flat = daily(560, () => 100, "2024-01-01");
    const jump = flat.map((b, i) => (i > 500 ? { ...b, close: 103 } : b));
    const names = Array.from({ length: 24 }, (_, i) => `S${i}`);
    const world = new Map(names.map((name) => [name, jump]));
    const quiet = Array.from({ length: 19 }, (_, j) => sig("x", { symbol: names[j % 24]!, source: "day_move", at: `${flat[280 + j * 10]!.date}T15:00:00.000Z` }));
    const selloff = names.map((symbol) => sig("x", { symbol, source: "day_move", at: `${flat[500]!.date}T15:00:00.000Z` }));
    const g = scoreSignals([...quiet, ...selloff], world, null).groups[0]!;
    // 20 段里 19 段是 0、1 段是 +3:均值 0.15,t = 1(按条数平均是 24 × 3 / 43 = 1.67,t 过 2)
    expect(g.horizons[1]).toMatchObject({ n: 43, independent: 20, mean_pct: 0.15, hit_rate: 5, baseline_pct: 0, edge_pct: 0.15, t: 1 });
    expect(g.tone).toBe("warn");
    // 那一天押反了也一样分不出来,不会变成「更差」
    const wrong = scoreSignals([...quiet, ...selloff.map((s) => ({ ...s, expect: "down" as const }))], world, null).groups[0]!;
    expect(wrong.horizons[1]).toMatchObject({ mean_pct: -0.15, t: -1 });
    expect(wrong.tone).toBe("warn");
  });

  it("K线 PA 按周期分开打分,周期从短到长排", () => {
    const pa = (variant: string, n: number): SignalEntry[] => signals.slice(0, n).map((s) => ({ ...s, source: "pa" as const, variant }));
    const r = scoreSignals([...pa("1d", 3), ...pa("5m", 2), ...signals.slice(0, 1)], book, null);
    expect(r.groups.map((g) => [g.source, g.variant, g.label, g.signals])).toEqual([
      ["cross", null, "价位穿越(押顺势)", 1],
      ["pa", "5m", "K线 PA(押读出的方向) · 5 分钟", 2],
      ["pa", "1d", "K线 PA(押读出的方向) · 日线", 3],
    ]);
  });

  it("同一天先押涨又押跌的两条,在收盘到收盘的口径下正好相抵", () => {
    const day = bars[400]!.date;
    const r = scoreSignals([
      sig("x", { at: `${day}T15:00:00.000Z`, expect: "up" }), sig("x", { at: `${day}T19:00:00.000Z`, expect: "down" }),
    ], book, null);
    const [up, down] = [r.recent[1]!.returns, r.recent[0]!.returns];
    expect(up.map((v, i) => v! + down[i]!)).toEqual([0, 0, 0]);
  });
});

describe("signal_log", () => {
  function tempDb(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-sig-"));
    dirs.push(dir);
    return path.join(dir, "t.db");
  }

  it("落了读得回来,按先后;只增不改;不认识的来源跳过;超过上限留最新的", () => {
    const dbPath = tempDb();
    const store = new TradeStore(dbPath);
    store.signals.log([sig("2026-01-05", { symbol: "aaa", price: 10 }), sig("2026-01-06", { source: "rvol", expect: null })]);
    expect(store.signals.list().map((s) => [s.symbol, s.source, s.expect, s.price, s.variant])).toEqual([
      ["AAA", "cross", "up", 10, null], ["AAA", "rvol", null, null, null],
    ]);
    expect(store.signals.list("2026-01-06T00:00:00Z")).toHaveLength(1);
    expect(store.signals.list(null, 1).map((s) => s.source)).toEqual(["rvol"]);
    const raw = new Database(dbPath);
    expect(() => raw.prepare("UPDATE signal_log SET price = 1").run()).toThrowError("append-only");
    expect(() => raw.prepare("DELETE FROM signal_log").run()).toThrowError("append-only");
    raw.prepare("INSERT INTO signal_log (at, source, symbol, expect, price, label) VALUES (?,?,?,?,?,?)").run("2026-01-07T00:00:00Z", "oops", "AAA", null, null, "");
    raw.close();
    expect(store.signals.list()).toHaveLength(2);
  });

  it("一天只记一次:同一来源、标的、方向、小类在这一天记过就不再记;换方向、换周期、换一天各记各的", () => {
    const store = new TradeStore(tempDb());
    const pa = (over: Partial<SignalEntry> = {}): SignalEntry => sig("2026-01-06", { source: "pa", symbol: "SPX", variant: "5m", ...over });
    const day = "2026-01-06T05:00:00.000Z";
    expect(store.signals.logOnce([pa()], day)).toBe(1);
    expect(store.signals.logOnce([pa({ at: "2026-01-06T18:00:00.000Z", label: "又读了一遍" })], day)).toBe(0);
    expect(store.signals.logOnce([pa({ expect: "down" }), pa({ variant: "1d" }), pa({ symbol: "NVDA" }), pa({ source: "leaders", variant: null })], day)).toBe(4);
    expect(store.signals.logOnce([pa({ source: "leaders", variant: null }), pa({ expect: "down" })], day)).toBe(0);
    // 同一批里重复的也只落一条
    expect(store.signals.logOnce([pa({ symbol: "QQQ" }), pa({ symbol: "QQQ" })], day)).toBe(1);
    // 第二天:这一天的起点往后挪了,昨天那条不算
    expect(store.signals.logOnce([pa({ at: "2026-01-07T16:00:00.000Z" })], "2026-01-07T05:00:00.000Z")).toBe(1);
    expect(store.signals.list().filter((s) => s.symbol === "SPX" && s.variant === "5m" && s.expect === "up")).toHaveLength(2);
    expect(store.signals.logOnce([], day)).toBe(0);
  });

  it("老库没有「小类」这一列:开库时补上,老行照常读、照常打分", () => {
    const dbPath = tempDb();
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE signal_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, source TEXT NOT NULL, symbol TEXT NOT NULL,
      expect TEXT, price REAL, label TEXT NOT NULL DEFAULT '')`);
    raw.prepare("INSERT INTO signal_log (at, source, symbol, expect, price, label) VALUES (?,?,?,?,?,?)").run("2026-01-05T16:00:00.000Z", "cross", "AAA", "up", 100.4, "MA20");
    raw.close();
    const store = new TradeStore(dbPath);
    const [old] = store.signals.list();
    expect(old).toEqual({ at: "2026-01-05T16:00:00.000Z", source: "cross", symbol: "AAA", expect: "up", price: 100.4, label: "MA20", variant: null });
    expect(signalReturns(old!, daily(30, (i) => 100 + i))).toEqual([1, 5, 20]);
    store.signals.log([sig("2026-01-06", { source: "pa", variant: "1d" })]);
    expect(store.signals.list()[1]).toMatchObject({ source: "pa", variant: "1d" });
    new TradeStore(dbPath); // 再开一次不重复加列
  });
});

describe("review.signals", () => {
  /** 2026-09-11(周五,交易日)。 */
  const at = (hhmm: string): number => Date.parse(`2026-09-11T${hhmm}:00-04:00`);

  /** 到 2026-09-11 为止的工作日日线,每天 +0.1%;今天那根带着"还没收盘"的现价。 */
  function history(count: number): Rec[] {
    const out: Rec[] = [];
    for (let t = Date.parse("2026-09-11T00:00:00Z"); out.length < count; t -= 86_400_000) {
      const d = new Date(t).getUTCDay();
      if (d === 0 || d === 6) continue;
      out.unshift({ date: new Date(t).toISOString().slice(0, 10) });
    }
    return out.map((b, i) => ({ ...b, open: 100, high: 100, low: 100, close: Math.round(100 * 1.001 ** i * 1e6) / 1e6, volume: 1 }));
  }

  class FakeRouter {
    asked: Array<[string, string, string]> = [];
    failLong = false;
    bars = history(900);
    sessions(): unknown[] { return [{}]; }
    connectedNames(): string[] { return ["paper"]; }
    async historicalBars(symbol: string, start: string, end: string): Promise<Rec[]> {
      this.asked.push([symbol, start, end]);
      if (symbol === "NOPE") throw new BrokerError("没有 NOPE 的行情权限");
      const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
      if (this.failLong && days > 420) throw new BrokerError("历史数据请求超频");
      return this.bars.filter((b) => start <= b["date"] && b["date"] <= end);
    }
  }

  function makeServer(connected = true): { s: RpcServer; router: FakeRouter; call: (m: string, p?: Rec) => Promise<Rec> } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-sig-rpc-"));
    dirs.push(dir);
    const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
    const s = new RpcServer(settingsPath, () => undefined);
    servers.push(s);
    const router = new FakeRouter();
    if (connected) s.router = router as never;
    const call = async (method: string, params: Rec = {}): Promise<Rec> =>
      s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
    return { s, router, call };
  }

  it("没连券商:成绩为空、标的列进 missing;天数照 review.performance 的规矩", async () => {
    const { s, call } = makeServer(false);
    s.engine.store.signals.log([sig("2026-01-05", { price: 10 })]);
    const r = (await call("review.signals"))["result"];
    expect(r).toMatchObject({ total: 1, missing_symbols: ["AAA"], days: null, t_threshold: 2.14, dropped: { uncovered: 0, no_baseline: 0 } });
    expect(r["groups"][0]["horizons"][0]).toMatchObject({ n: 0, independent: 0 });
    expect((await call("review.signals", { days: 0 }))["error"]["message"]).toContain("1 到 3650");
    expect((await call("review.signals", { days: "7" }))["error"]["code"]).toBe(-32602);
  });

  it("日线往回取到最早那条信号之前一整年;取不到的那只列出来,别的照算", async () => {
    setClock(at("12:00"));
    const { s, router, call } = makeServer();
    // 100 天前、昨天各一条;另一只取不到
    s.engine.store.signals.log([
      sig("x", { at: new Date(at("12:00") - 100 * 86_400_000).toISOString() }),
      sig("x", { at: new Date(at("12:00") - 86_400_000).toISOString() }),
      sig("x", { symbol: "NOPE", at: new Date(at("12:00") - 86_400_000).toISOString() }),
    ]);
    const r = (await call("review.signals"))["result"];
    expect(r["missing_symbols"]).toEqual(["NOPE"]);
    const asked = router.asked.find((a) => a[0] === "AAA")!;
    expect(asked[2]).toBe("2026-09-11");
    expect(asked[1]).toBe(new Date(Date.parse("2026-09-11T00:00:00Z") - (420 + 101) * 86_400_000).toISOString().slice(0, 10));
    // 100 天前那条:20 天的持有期走完了,而且之前有足够的日线算基线(每天 +0.1% → 没有超额)
    const h = r["groups"][0]["horizons"];
    expect(h.map((x: Rec) => x["n"])).toEqual([1, 1, 1]);
    expect(h[1]).toMatchObject({ mean_pct: 0.5, baseline_pct: 0.5, edge_pct: 0 });
  });

  /** 让日线缓存过期(TTL 用的是单调钟,测试里拨不动它)。 */
  const expireHistory = (s: RpcServer): void => (s.market as unknown as { histCache: Map<string, unknown> }).histCache.clear();

  it("最后一根日线要是它那天收盘之后取的才算数:盘中取的不算;合盖睡过收盘再醒来,手里那份还是盘中取的,照样不算", async () => {
    setClock(at("12:00"));
    const { s, router, call } = makeServer();
    s.engine.store.signals.log([sig("x", { at: new Date(Date.parse("2026-09-10T11:00:00-04:00")).toISOString() })]);
    const oneDay = async (): Promise<unknown> => (await call("review.signals"))["result"]["recent"][0]["returns"];
    expect(await oneDay()).toEqual([null, null, null]); // 12:00 取的:今天那根是半根
    // 钟点到了 18:00,但缓存按单调钟还没过期(电脑睡着时它不走):那一份仍是 12:00 取的
    setClock(at("18:00"));
    expect(await oneDay()).toEqual([null, null, null]);
    expect(router.asked).toHaveLength(1);
    // 缓存换新之后(收盘后取的):今天那根才是收盘
    expireHistory(s);
    expect(await oneDay()).toEqual([0.1, null, null]);
    expect(router.asked).toHaveLength(2);
  });

  it("正好收盘那一刻取的算数;昨天收盘前取的那份留到今天,昨天那根也不算收盘", async () => {
    const wednesdaySignal = sig("x", { at: new Date(Date.parse("2026-09-09T11:00:00-04:00")).toISOString() });
    // 周四 15:55 取的日线,最后一根是周四的半根
    setClock(Date.parse("2026-09-10T15:55:00-04:00"));
    const { s, call } = makeServer();
    s.engine.store.signals.log([wednesdaySignal]);
    const oneDay = async (): Promise<unknown> => (await call("review.signals"))["result"]["recent"][0]["returns"];
    expect(await oneDay()).toEqual([null, null, null]);
    // 合盖,周五早上打开:日期已经过了一天,可那一根是周四 15:55 的价,不是周四的收盘
    setClock(at("09:00"));
    expect(await oneDay()).toEqual([null, null, null]);
    expireHistory(s);
    expect(await oneDay()).toEqual([0.1, null, null]); // 周五取的:周四那根后面还有一根,是收了盘的

    setClock(Date.parse("2026-09-10T16:00:00-04:00"));
    const onTheBell = makeServer();
    onTheBell.s.engine.store.signals.log([wednesdaySignal]);
    expect((await onTheBell.call("review.signals"))["result"]["recent"][0]["returns"]).toEqual([0.1, null, null]);
  });

  it("更长的那段取不到(券商按超频拒了):退回平常那一段,收益照算", async () => {
    setClock(at("12:00"));
    const { s, router, call } = makeServer();
    router.failLong = true;
    s.engine.store.signals.log([sig("x", { at: new Date(at("12:00") - 30 * 86_400_000).toISOString() })]);
    const r = (await call("review.signals"))["result"];
    expect(router.asked.map((a) => a[0])).toEqual(["AAA", "AAA"]);
    expect(r["missing_symbols"]).toEqual([]);
    expect(r["recent"][0]["returns"][1]).toBe(0.501);
    expect(r["dropped"]).toEqual({ uncovered: 0, no_baseline: 0 });
  });

  it("退回平常那一段之后,比它还早的信号算不了:结果里数出来、说明里写明", async () => {
    setClock(at("12:00"));
    const { s, router, call } = makeServer();
    router.failLong = true;
    s.engine.store.signals.log([
      sig("x", { at: new Date(at("12:00") - 500 * 86_400_000).toISOString() }), // 420 天的日线够不着
      sig("x", { at: new Date(at("12:00") - 30 * 86_400_000).toISOString() }),
    ]);
    const r = (await call("review.signals"))["result"];
    expect(r["dropped"]).toEqual({ uncovered: 1, no_baseline: 0 });
    expect(r["notes"].join("\n")).toContain("1 条信号比取到的日线还早");
    expect(r["recent"].map((x: Rec) => x["returns"][1])).toEqual([0.501, null]);
    // 长的那段取得到时两条都有成绩
    router.failLong = false;
    expireHistory(s);
    const full = (await call("review.signals"))["result"];
    expect(full["dropped"]["uncovered"]).toBe(0);
    expect(full["recent"].map((x: Rec) => x["returns"][1])).toEqual([0.501, 0.501]);
  });

  it("dailyHistory:别人刚取过更长的一段,要 420 天的照样只拿到 420 天,不再打一次券商", async () => {
    setClock(at("12:00"));
    const { s, router } = makeServer();
    const long = await s.market.dailyHistory("AAA", 800);
    const usual = await s.market.dailyHistory("AAA");
    expect(router.asked).toHaveLength(1);
    expect(long.length).toBeGreaterThan(usual.length);
    expect(usual[0]!["date"] >= "2025-07-18").toBe(true); // 2026-09-11 往回 420 天
    expect(usual.at(-1)).toEqual(long.at(-1));
    // 反过来:缓存里只有 420 天的,要更长的就得重取
    const other = makeServer();
    await other.s.market.dailyHistory("AAA");
    await other.s.market.dailyHistory("AAA");
    expect(other.router.asked).toHaveLength(1);
    await other.s.market.dailyHistory("AAA", 800);
    expect(other.router.asked).toHaveLength(2);
  });
});
