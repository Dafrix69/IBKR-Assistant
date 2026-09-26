/** 执行损耗(execQuality.ts):触发时的持仓现价 vs 实际成交均价。 */
import { describe, expect, it } from "vitest";

import { executionCost, executionRow } from "../src/execQuality.js";
import type { CloseTrace, TraceRecord } from "../src/execQuality.js";

const NOW = Date.parse("2026-09-26T20:00:00Z");
const ALL = { scope: "all" as const, kind: "all" as const, days: null, now: NOW };

function rec(secType: string, action: string, fill: number | null, fills: Array<{ qty: number; sec_type?: string }>, paper = false): TraceRecord {
  return {
    contract: { secType },
    order: { action, quantity: 1 },
    account: { is_paper: paper },
    ibkr: { avg_fill_price: fill, fills },
  };
}

function trace(at: string, mark: number | null, record: TraceRecord | null, path: CloseTrace["path"] = "auto_close"): CloseTrace {
  return { at, path, symbol: "SPX", state: "stop_loss", mark, record };
}

describe("一笔:让出去多少", () => {
  it("平多头的蝶:触发时 4.00,成交 3.70 → 每份让 0.30,组合只数 BAG 行,乘 100", () => {
    const row = executionRow(trace("2026-09-25T15:00:00Z", 4.0,
      rec("BAG", "SELL", 3.7, [{ qty: 2, sec_type: "BAG" }, { qty: 2, sec_type: "OPT" }, { qty: 4, sec_type: "OPT" }, { qty: 2, sec_type: "OPT" }])));
    expect(row).toMatchObject({ qty: 2, cost_usd: 60, cost_pct: 7.5, side: "SELL", sec_type: "BAG" });
  });

  it("平空头的股票:触发时 100,买回 100.2 → 让 0.2 × 股数;成交比触发价好是负的", () => {
    expect(executionRow(trace("2026-09-25T15:00:00Z", 100, rec("STK", "BUY", 100.2, [{ qty: 50 }])))).toMatchObject({ cost_usd: 10, cost_pct: 0.2 });
    expect(executionRow(trace("2026-09-25T15:00:00Z", 100, rec("STK", "SELL", 100.5, [{ qty: 10 }])))).toMatchObject({ cost_usd: -5 });
  });

  it("算不出的回 null:老痕没触发价、单没成交、找不到单", () => {
    expect(executionRow(trace("2026-09-25T15:00:00Z", null, rec("STK", "SELL", 10, [{ qty: 1 }])))).toBeNull();
    expect(executionRow(trace("2026-09-25T15:00:00Z", 10, rec("STK", "SELL", null, [])))).toBeNull();
    expect(executionRow(trace("2026-09-25T15:00:00Z", 10, null))).toBeNull();
  });
});

describe("汇总", () => {
  const traces = [
    trace("2026-09-20T15:00:00Z", 4.0, rec("BAG", "SELL", 3.8, [{ qty: 1, sec_type: "BAG" }])), // 20 美元,5%
    trace("2026-09-24T15:00:00Z", 2.0, rec("BAG", "SELL", 1.8, [{ qty: 1, sec_type: "BAG" }]), "hosted_sweep"), // 20,10%
    trace("2026-09-25T15:00:00Z", 100, rec("STK", "SELL", 99.9, [{ qty: 100 }], true)), // 10,0.1%
    trace("2026-09-25T16:00:00Z", null, null), // 老痕
  ];

  it("中位数、平均、按合约类型分;新的在前;算不出的数成 missing", () => {
    const c = executionCost(traces, ALL);
    expect(c).toMatchObject({ samples: 3, missing: 1, total_usd: 50, avg_usd: 16.67, median_pct: 5, avg_pct: 5.03 });
    expect(c.by_sec_type.map((g) => [g.sec_type, g.samples, g.median_pct])).toEqual([["BAG", 2, 7.5], ["STK", 1, 0.1]]);
    expect(c.rows.map((r) => r.at)).toEqual(["2026-09-25T15:00:00Z", "2026-09-24T15:00:00Z", "2026-09-20T15:00:00Z"]);
  });

  it("范围、品种、天数和账本同一套筛法", () => {
    expect(executionCost(traces, { ...ALL, scope: "paper" }).samples).toBe(1);
    expect(executionCost(traces, { ...ALL, kind: "butterfly" }).samples).toBe(2);
    expect(executionCost(traces, { ...ALL, days: 3 }).samples).toBe(2);
  });

  it("什么都没有:全是 null,不编", () => {
    expect(executionCost([], ALL)).toEqual({
      samples: 0, missing: 0, total_usd: null, avg_usd: null, median_pct: null, avg_pct: null, by_sec_type: [], rows: [],
    });
  });
});
