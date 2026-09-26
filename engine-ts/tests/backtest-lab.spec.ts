/** 回测的成交成本与参数扫描(backtest.ts 的 cost、backtestLab.ts):纯计算,离线。 */
import { describe, expect, it } from "vitest";

import { BacktestError, runBacktest } from "../src/backtest.js";
import type { Bar } from "../src/backtest.js";
import { alignSeries, checkGrid, gridCombos, runSweep, spearman } from "../src/backtestLab.js";
import type { SweepInput } from "../src/backtestLab.js";

/** 缓慢上行叠一个正弦:均线会来回交叉。`phase` 让几只标的不完全一样。 */
function bars(count = 400, phase = 0, drift = 0.05): Bar[] {
  const out: Bar[] = [];
  let t = Date.parse("2024-01-02T00:00:00Z");
  for (; out.length < count; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day === 0 || day === 6) continue;
    const n = out.length;
    const close = Math.round((100 + 12 * Math.sin((n + phase) / 9) + n * drift) * 100) / 100;
    out.push({ date: new Date(t).toISOString().slice(0, 10), open: close - 0.3, high: close + 1.2, low: close - 1.1, close });
  }
  return out;
}

const STOCK = { type: "stock" as const, dte: 30, offset_pct: 0, width_pct: 2, risk_pct: 10 };
const input = (over: Partial<SweepInput> = {}): SweepInput => ({
  series: [{ symbol: "AAA", bars: bars() }],
  strategy: "sma_cross",
  grid: { fast: [5, 10, 20], slow: [20, 40, 60] },
  instrument: STOCK,
  costPct: 0,
  splitPct: 70,
  folds: 0,
  objective: "return",
  ...over,
});

describe("成交成本", () => {
  it("0 = 老口径,一位不差,且回执里没有 cost_pct 这个键", () => {
    const a = runBacktest(bars(), "sma_cross", { fast: 5, slow: 20 });
    const b = runBacktest(bars(), "sma_cross", { fast: 5, slow: 20 }, null, null, 0);
    expect(b).toEqual(a);
    expect("cost_pct" in b).toBe(false);
  });

  it("正股:每次换仓付一次,交易越多扣得越多;单笔收益按买卖各一次扣", () => {
    const gross = runBacktest(bars(), "sma_cross", { fast: 5, slow: 20 });
    const net = runBacktest(bars(), "sma_cross", { fast: 5, slow: 20 }, null, null, 0.5);
    expect(net.cost_pct).toBe(0.5);
    expect(net.total_return_pct).toBeLessThan(gross.total_return_pct);
    const g = gross.trade_list[0]!;
    const n = net.trade_list[0]!;
    expect(n.return_pct).toBeCloseTo(((1 + g.return_pct / 100) * 0.995 * 0.995 - 1) * 100, 1);
  });

  it("期权:开仓多付、平仓少收;超过 10% 当场拒", () => {
    const inst = { type: "call", dte: 30, offset_pct: 0, width_pct: 2, risk_pct: 10 };
    const gross = runBacktest(bars(), "sma_cross", { fast: 5, slow: 20 }, null, inst);
    const net = runBacktest(bars(), "sma_cross", { fast: 5, slow: 20 }, null, inst, 3);
    expect(net.total_return_pct).toBeLessThan(gross.total_return_pct);
    expect(() => runBacktest(bars(), "sma_cross", {}, null, null, 11)).toThrowError(BacktestError);
  });
});

describe("参数扫描", () => {
  it("网格展开成全部组合;不合法的组合(快线 ≥ 慢线)跳过并写明原因", () => {
    expect(gridCombos({ fast: [5, 10], slow: [20, 40] })).toEqual([
      { fast: 5, slow: 20 }, { fast: 5, slow: 40 }, { fast: 10, slow: 20 }, { fast: 10, slow: 40 },
    ]);
    const r = runSweep(input());
    expect(r.combos).toBe(9);
    expect(r.skipped.map((x) => x.params)).toEqual([{ fast: 20, slow: 20 }]);
    expect(r.skipped[0]!.reason).toContain("快线周期必须小于慢线周期");
    expect(r.rows).toHaveLength(8);
  });

  it("样本内挑、样本外看:按样本内得分排,带样本外名次;切分日在 70% 处", () => {
    const r = runSweep(input());
    const scores = r.rows.map((x) => x.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(r.best).toEqual(r.rows[0]);
    expect(r.split_date).toBe(bars()[280]!.date);
    expect(new Set(r.rows.map((x) => x.oos_rank))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(r.rank_corr).not.toBeNull();
    expect(r.notes.some((n) => n.includes("没扣成交成本"))).toBe(true);
  });

  it("多只标的:只用共同的交易日,得分取平均;notes 写明幸存者偏差", () => {
    const b = bars(400, 5).slice(10); // 少了前 10 天
    const r = runSweep(input({ series: [{ symbol: "AAA", bars: bars() }, { symbol: "BBB", bars: b }] }));
    expect(r.start).toBe(b[0]!.date);
    expect(r.symbols).toEqual(["AAA", "BBB"]);
    expect(r.notes.some((n) => n.includes("幸存者偏差"))).toBe(true);
    expect(alignSeries([{ symbol: "A", bars: bars(30) }, { symbol: "B", bars: bars(30).slice(5) }])[0]!.bars).toHaveLength(25);
  });

  it("滚动前推:每折只用之前的数据挑参数,测试段收益连乘", () => {
    const r = runSweep(input({ folds: 3 }));
    const wf = r.walk_forward!;
    expect(wf.folds).toHaveLength(3);
    for (const f of wf.folds) expect(f.train_end < f.test_start).toBe(true);
    const chained = wf.folds.reduce((acc, f) => acc * (1 + f.test_return_pct / 100), 1);
    expect(wf.total_return_pct).toBeCloseTo((chained - 1) * 100, 1);
  });

  it("Calmar 当标准:没有回撤时退回年化,不拿无穷大比", () => {
    const r = runSweep(input({ objective: "calmar" }));
    for (const row of r.rows) expect(row.score).toBe(Math.round((row.is.calmar ?? row.is.annualized_pct) * 10000) / 10000);
  });

  it("入参报人话:没参数的策略、不认识的参数、组合太多、比例与折数越界、数据太短", () => {
    expect(() => checkGrid("buy_hold", { x: [1] }, 1)).toThrowError("没有参数可扫");
    expect(() => checkGrid("sma_cross", { fastt: [1, 2] }, 1)).toThrowError("没有参数 fastt");
    expect(() => checkGrid("rsi", { period: [...Array(15).keys()].map((i) => i + 2), buy_below: [...Array(15).keys()].map((i) => i + 5) }, 1))
      .toThrowError("组合太多");
    expect(() => runSweep(input({ splitPct: 95 }))).toThrowError("50%~90%");
    expect(() => runSweep(input({ folds: 1 }))).toThrowError("2~6");
    expect(() => runSweep(input({ series: [{ symbol: "AAA", bars: bars(30) }] }))).toThrowError("切不出样本内外");
  });

  it("秩相关:完全一致 1、完全相反 -1、同分取平均秩、太少不算", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBe(-1);
    expect(spearman([1, 1, 2], [1, 1, 2])).toBe(1);
    expect(spearman([1, 2], [1, 2])).toBeNull();
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
  });
});
