/** 信号成绩单:signal_log(只增不改)、signalOutcomes.ts 的打分、review.signals。全部离线。 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { SignalEntry } from "../src/contract/signals.js";
import { RpcServer } from "../src/rpc.js";
import {
  baselineReturn, MIN_SIGNALS, scoreSignals, signalFromAnomaly, signalFromWatchEvent, signalReturns,
} from "../src/signalOutcomes.js";
import type { DailyClose } from "../src/signalOutcomes.js";
import { TradeStore } from "../src/store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
const servers: RpcServer[] = [];
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

/** 美东那天 11:00 发的信号(冬令时 16:00 UTC)。 */
const sig = (date: string, over: Partial<SignalEntry> = {}): SignalEntry => ({
  at: `${date}T16:00:00.000Z`, source: "cross", symbol: "AAA", expect: "up", price: null, label: "x", ...over,
});

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
});

describe("一条信号的收益", () => {
  const bars = daily(30, (i) => 100 + i); // 每天涨 1

  it("发在交易日:用发出时的价作基准,第 k 个交易日收盘比;押跌的反号", () => {
    const s = sig(bars[0]!.date, { price: 100 });
    expect(signalReturns(s, bars)).toEqual([1, 5, 20]);
    expect(signalReturns({ ...s, expect: "down" }, bars)).toEqual([-1, -5, -20]);
  });

  it("没有价就用那天收盘;发在周末从之后第一个交易日数;没走完的是 null;不带方向给绝对涨跌", () => {
    expect(signalReturns(sig(bars[2]!.date), bars)[0]).toBeCloseTo(100 / 102, 4);
    // 2026-01-10 是周六:锚在周五(第 4 根),第 1 天是周一
    expect(signalReturns(sig("2026-01-10", { price: 104 }), bars)[0]).toBeCloseTo((105 / 104 - 1) * 100, 4);
    expect(signalReturns(sig("2026-01-10"), bars)).toEqual([null, null, null]); // 周末又没价:没有基准
    expect(signalReturns(sig(bars[25]!.date, { price: 125 }), bars)[2]).toBeNull();
    expect(signalReturns(sig(bars[0]!.date, { price: 100, expect: null }), daily(30, (i) => 100 - i))[0]).toBe(1);
  });

  it("基线:任意一天持有 k 天的平均", () => {
    expect(baselineReturn(daily(3, (i) => [100, 110, 99][i]!), 1, false)).toBeCloseTo((10 - 10) / 2, 6);
    expect(baselineReturn(daily(3, (i) => [100, 110, 99][i]!), 1, true)).toBeCloseTo(10, 6);
  });
});

describe("成绩单", () => {
  // 平时每天 +0.1%;每个信号日的第二天跳涨 1.5%~2.5%(不一样大,t 才算得出来)
  const signalDays = Array.from({ length: 30 }, (_, j) => 10 + j * 8);
  const jumps = new Map(signalDays.map((d, j) => [d + 1, 1.015 + (j % 5) * 0.0025]));
  let level = 100;
  const bars = daily(270, (i) => (level *= i === 0 ? 1 : jumps.get(i) ?? 1.001));
  const signals = signalDays.map((d) => sig(bars[d]!.date, { price: bars[d]!.close }));

  it("押对的信号:5 天后比随手一天好,t ≥ 2 → good", () => {
    const r = scoreSignals(signals, new Map([["AAA", bars]]), null);
    const g = r.groups[0]!;
    expect(g.source).toBe("cross");
    expect(g.signals).toBe(30);
    expect(g.horizons.map((h) => h.horizon)).toEqual([1, 5, 20]);
    expect(g.horizons[1]!.n).toBeGreaterThanOrEqual(MIN_SIGNALS);
    expect(g.horizons[1]!.hit_rate).toBe(100);
    expect(g.horizons[1]!.edge_pct).toBeGreaterThan(0);
    expect(g.tone).toBe("good");
    expect(g.horizons[1]!.t).toBeGreaterThanOrEqual(2);
  });

  it("反过来押就是 bad;太少不下结论;取不到日线的标的列出来", () => {
    const flipped = signals.map((s) => ({ ...s, expect: "down" as const }));
    expect(scoreSignals(flipped, new Map([["AAA", bars]]), null).groups[0]!.tone).toBe("bad");
    const few = scoreSignals(signals.slice(0, 5), new Map([["AAA", bars]]), null).groups[0]!;
    expect(few.tone).toBe("info");
    expect(few.verdict).toContain("不下结论");
    const blind = scoreSignals([...signals, sig(bars[5]!.date, { symbol: "ZZZ" })], new Map([["AAA", bars]]), 30);
    expect(blind.missing_symbols).toEqual(["ZZZ"]);
    expect(blind.recent[0]).toMatchObject({ symbol: "ZZZ", returns: [null, null, null] });
    expect(blind.days).toBe(30);
  });
});

describe("signal_log", () => {
  it("落了读得回来,按先后;只增不改;不认识的来源跳过", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-sig-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "t.db");
    const store = new TradeStore(dbPath);
    store.signals.log([sig("2026-01-05", { symbol: "aaa", price: 10 }), sig("2026-01-06", { source: "rvol", expect: null })]);
    expect(store.signals.list().map((s) => [s.symbol, s.source, s.expect, s.price])).toEqual([["AAA", "cross", "up", 10], ["AAA", "rvol", null, null]]);
    expect(store.signals.list("2026-01-06T00:00:00Z")).toHaveLength(1);
    const raw = new Database(dbPath);
    expect(() => raw.prepare("UPDATE signal_log SET price = 1").run()).toThrowError("append-only");
    expect(() => raw.prepare("DELETE FROM signal_log").run()).toThrowError("append-only");
    raw.prepare("INSERT INTO signal_log (at, source, symbol, expect, price, label) VALUES (?,?,?,?,?,?)").run("2026-01-07T00:00:00Z", "oops", "AAA", null, null, "");
    raw.close();
    expect(store.signals.list()).toHaveLength(2);
  });
});

describe("review.signals", () => {
  it("没连券商:成绩为空、标的列进 missing;天数照 review.performance 的规矩", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-sig-rpc-"));
    dirs.push(dir);
    const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
    const s = new RpcServer(settingsPath, () => undefined);
    servers.push(s);
    s.engine.store.signals.log([sig("2026-01-05", { price: 10 })]);
    const call = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> =>
      s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
    const r = (await call("review.signals"))["result"];
    expect(r).toMatchObject({ total: 1, missing_symbols: ["AAA"], days: null });
    expect(r["groups"][0]["horizons"][0]["n"]).toBe(0);
    expect((await call("review.signals", { days: 0 }))["error"]["message"]).toContain("1 到 3650");
    expect((await call("review.signals", { days: "7" }))["error"]["code"]).toBe(-32602);
  });
});
