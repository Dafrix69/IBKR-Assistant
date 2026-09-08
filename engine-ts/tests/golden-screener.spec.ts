/** 黄金对拍:screener(RS 强度 / CD 背离拐点 / 极值偏离)。 */
import { describe, expect, it } from "vitest";

import * as sc from "../src/screener.js";
import { expectSame, loadGolden } from "./util.js";

describe("golden: screener", () => {
  const g = loadGolden("screener");

  it("constants", () => {
    expect([...sc.RS_WINDOWS]).toEqual(g.constants.RS_WINDOWS);
    expect([...sc.RS_BENCHMARKS]).toEqual(g.constants.RS_BENCHMARKS);
    expect(sc.UNTAGGED).toBe(g.constants.UNTAGGED);
    expect(sc.MIN_CD_BARS).toBe(g.constants.MIN_CD_BARS);
  });

  for (const c of g.rs) {
    it(`rs_strength[${c.name}]`, () => {
      const windows = c.windows ?? sc.RS_WINDOWS;
      expectSame(sc.rsStrength(c.members, c.bench, c.benchmark, windows), c.expect, `rs[${c.name}]`);
    });
  }

  it("resample_weekly", () => {
    expectSame(sc.resampleWeekly(g.weekly.bars), g.weekly.expect, "weekly");
  });

  g.cd.forEach((c: any, i: number) => {
    it(`cd_divergence[${c.name} ma=${c.kw.ma_period}]`, () => {
      const result = sc.cdDivergence(
        c.bars, c.kw.ma_period ?? null, sc.DEFAULT_PIVOT_STRENGTH, sc.DEFAULT_MAX_SPAN,
        c.kw.max_age ?? sc.DEFAULT_MAX_AGE,
      );
      expectSame(result, c.expect, `cd[${i}:${c.name}]`);
    });
  });

  g.inflections.forEach((c: any, i: number) => {
    it(`screen_inflections[${i}]`, () => {
      expectSame(
        sc.screenInflections(c.members, c.timeframes, c.ma_period ?? null), c.expect, `inflections[${i}]`,
      );
    });
  });

  g.deviation.forEach((c: any, i: number) => {
    it(`deviation_review[${c.name} ${JSON.stringify(c.kw)}]`, () => {
      const kw = c.kw;
      const result = sc.deviationReview(
        c.bars, kw.period ?? sc.DEFAULT_DEV_PERIOD, kw.lookback ?? sc.DEFAULT_DEV_LOOKBACK,
        kw.smooth ?? sc.DEFAULT_PRESSURE_SMOOTH, kw.z_extreme ?? sc.DEFAULT_Z_EXTREME,
        kw.keep ?? sc.DEFAULT_KEEP,
      );
      expectSame(result, c.expect, `deviation[${i}:${c.name}]`);
    });
  });
});
