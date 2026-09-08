/** 黄金对拍:backtest(含 erf / BS 定价 / 期权模拟)。 */
import { describe, expect, it } from "vitest";

import { Bar, BacktestError, STRATEGIES, erf, runBacktest } from "../src/backtest.js";
import { expectSame, loadGolden } from "./util.js";

describe("golden: backtest", () => {
  const g = loadGolden("backtest");
  const bars: Bar[] = g.bars;

  it("strategies catalog", () => {
    expectSame(STRATEGIES, g.strategies, "STRATEGIES");
  });

  it("erf sanity", () => {
    // 与 Python math.erf 的抽样值(全精度 repr)
    expect(erf(0.2)).toBeCloseTo(0.2227025892104785, 15);
    expect(erf(1.0)).toBeCloseTo(0.8427007929497149, 15);
    expect(erf(2.5)).toBeCloseTo(0.999593047982555, 15);
    expect(erf(-1.3)).toBeCloseTo(-0.9340079449406524, 15);
    expect(erf(5.0)).toBeCloseTo(0.9999999999984626, 15);
  });

  for (const c of g.cases) {
    it(c.name, () => {
      if (c.error !== undefined) {
        expect(() => runBacktest(bars, c.strategy, c.params, c.rules, c.instrument))
          .toThrowError(BacktestError);
        try {
          runBacktest(bars, c.strategy, c.params, c.rules, c.instrument);
        } catch (exc) {
          expect((exc as Error).message).toBe(c.error);
        }
        return;
      }
      const result = runBacktest(bars, c.strategy, c.params, c.rules, c.instrument);
      expectSame(result, c.expect, c.name);
    });
  }
});
