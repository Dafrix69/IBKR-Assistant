/** 执行损耗(execQuality.ts):触发时的持仓现价 vs 实际成交均价。 */
import { describe, expect, it } from "vitest";

import { executionCost, executionRow } from "../src/execQuality.js";
import type { CloseTrace, TraceRecord } from "../src/execQuality.js";

const NOW = Date.parse("2026-09-26T20:00:00Z");
const ALL = { scope: "all" as const, kind: "all" as const, days: null, now: NOW };

function rec(
  secType: string, action: string, fill: number | null, fills: Array<{ qty: number; sec_type?: string }>, paper = false, commission?: number,
): TraceRecord {
  return {
    contract: { secType },
    order: { action, quantity: 1 },
    account: { is_paper: paper },
    ibkr: { avg_fill_price: fill, fills, ...(commission === undefined ? {} : { total_commission: commission }) },
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

  it("让出只量滑点:佣金另记一栏,回报里没有就是 null,不并进让出", () => {
    const row = executionRow(trace("2026-09-25T15:00:00Z", 4.0, rec("BAG", "SELL", 3.7, [{ qty: 1, sec_type: "BAG" }], false, 5.6)));
    expect(row).toMatchObject({ cost_usd: 30, commission_usd: 5.6 });
    expect(executionRow(trace("2026-09-25T15:00:00Z", 100, rec("STK", "SELL", 99.9, [{ qty: 10 }])))?.commission_usd).toBeNull();
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

  it("美元合计与平均照算;百分比按合约类型分,混着两种时不给合在一起的中位数", () => {
    const c = executionCost(traces, ALL);
    // 股票的 0.1% 是占股价,蝶的 5% / 10% 是占权利金:合起来取中位数(以前是 5%)没有意义
    expect(c).toMatchObject({ samples: 3, paper: 1, missing: 1, total_usd: 50, avg_usd: 16.67, median_pct: null, avg_pct: null, commission_usd: null });
    expect(c.by_sec_type.map((g) => [g.sec_type, g.samples, g.paper, g.median_pct, g.median_ci])).toEqual([["BAG", 2, 0, 7.5, null], ["STK", 1, 1, 0.1, null]]);
    expect(c.rows.map((r) => r.at)).toEqual(["2026-09-25T15:00:00Z", "2026-09-24T15:00:00Z", "2026-09-20T15:00:00Z"]);
  });

  it("只有一种合约时才有整体的百分比", () => {
    expect(executionCost(traces, { ...ALL, kind: "butterfly" })).toMatchObject({ samples: 2, median_pct: 7.5, avg_pct: 7.5 });
  });

  it("中位数的区间:不到 6 笔定不出来(null);6 笔起给第 k 小到第 k 大", () => {
    const fly = (i: number, fill: number): CloseTrace =>
      trace(`2026-09-${String(10 + i).padStart(2, "0")}T15:00:00Z`, 4.0, rec("BAG", "SELL", fill, [{ qty: 1, sec_type: "BAG" }], false, 2.5));
    // 让出 2.5% 5% 7.5% 10% 12.5% 15%
    const six = [3.9, 3.8, 3.7, 3.6, 3.5, 3.4].map((f, i) => fly(i, f));
    expect(executionCost(six.slice(0, 5), ALL).by_sec_type[0]).toMatchObject({ samples: 5, median_pct: 7.5, median_ci: null });
    const c = executionCost(six, ALL);
    expect(c.by_sec_type[0]).toMatchObject({ samples: 6, median_pct: 8.75, median_ci: { lo: 2.5, hi: 15 } });
    expect(c.commission_usd).toBe(15); // 6 张 × 2.5,不在 total_usd 里
    expect(c.total_usd).toBe(210);
  });

  it("范围、品种、天数和账本同一套筛法", () => {
    expect(executionCost(traces, { ...ALL, scope: "paper" }).samples).toBe(1);
    expect(executionCost(traces, { ...ALL, kind: "butterfly" }).samples).toBe(2);
    expect(executionCost(traces, { ...ALL, days: 3 }).samples).toBe(2);
  });

  it("什么都没有:全是 null,不编", () => {
    expect(executionCost([], ALL)).toEqual({
      samples: 0, paper: 0, missing: 0, total_usd: null, avg_usd: null, commission_usd: null, median_pct: null, avg_pct: null, by_sec_type: [], rows: [],
    });
  });
});
