/** 黄金对拍:flyexit(0DTE 蝶式止盈策略)。样例由 ../engine-python/scripts/gen_golden.py 生成。 */
import { describe, expect, it } from "vitest";

import * as fx from "../src/flyexit.js";
import { expectSame, loadGolden } from "./util.js";

describe("golden: flyexit", () => {
  const g = loadGolden("flyexit");

  for (const c of g.cases) {
    it(`plan: ${c.name}`, () => {
      const out = fx.plan(c.profile, c.entry, c.spx, c.fly, c.params, c.actual);
      expectSame(out, c.expect, c.name);
    });
  }

  it("variance schedule / phases", () => {
    const params = fx.paramsFrom({ em: 36 });
    for (const v of g.variance) {
      expect(fx.remainingVariance(v.minute)).toBeCloseTo(v.R, 9);
      expect(fx.sigmaRemaining(36, v.minute)).toBeCloseTo(v.sigma36, 9);
      expect(fx.phaseAt(v.minute, 25.0, params)).toBe(v.phase_w25);
    }
    for (const c of g.switch) expect(fx.switchMinute(c.width, fx.paramsFrom({ em: c.em }))).toBe(c.expect);
  });

  it("model price", () => {
    const profile = g.cases[2].profile;
    for (const c of g.model) {
      expect(fx.modelPrice(profile, c.s, c.sigma)).toBeCloseTo(c.expect, 9);
      expect(fx.modelPrice({ ...profile, right: "P" }, c.s, c.sigma)).toBeCloseTo(c.put, 9);
    }
  });

  it("params / tranches", () => {
    for (const c of g.params) expectSame(fx.paramsFrom(c.raw), c.expect, "params");
    for (const c of g.tranches) expectSame(fx.trancheSizes(c.qty), c.expect, `tranches[${c.qty}]`);
  });

  it("trail tiers", () => {
    const params = fx.paramsFrom(null);
    for (const c of g.trail) {
      const where = `trail[peak=${c.peak} d=${c.d} @${c.minute}]`;
      expectSame(fx.trailPct(c.peak, c.d, c.minute, params), c.pct, where);
      expectSame(fx.trailStop(c.peak, c.d, c.minute, params), c.stop, where);
    }
  });
});
