/** 黄金对拍:tradereview(蝴蝶复盘)。样例由 ../engine-python/scripts/gen_golden.py 生成。 */
import { describe, expect, it } from "vitest";

import * as tr from "../src/tradereview.js";
import { expectSame, loadGolden } from "./util.js";

describe("golden: tradereview", () => {
  const g = loadGolden("tradereview");

  for (const c of g.cases) {
    it(`review: ${c.name}`, () => {
      const now = Date.parse(c.now);
      if (c.error !== undefined) {
        expect(() => tr.review(c.record, c.others, c.bars, c.timeframe, now)).toThrowError(c.error);
        return;
      }
      const out = tr.review(c.record, c.others, c.bars, c.timeframe, now);
      expectSame(out, c.expect, c.name);
    });
  }

  it("butterfly_profile", () => {
    for (const [i, c] of g.profiles.entries()) {
      expectSame(tr.butterflyProfile(c.record), c.expect, `profiles[${i}]`);
    }
  });

  it("parse_when", () => {
    for (const c of g.parse_when) {
      const out = tr.parseWhen(c.value);
      if (c.expect === null) expect(out, c.value).toBeNull();
      else expect(tr.utcIso(out!), c.value).toBe(c.expect);
    }
  });

  it("pick_timeframe", () => {
    for (const c of g.pick_timeframe) {
      expect(tr.pickTimeframe(Date.parse(c.entry), Date.parse(c.now))).toBe(c.expect);
    }
  });

  it("payoff / pnl_at", () => {
    const profile = tr.butterflyProfile(g.profiles[0].record)!;
    for (const c of g.payoff) {
      expect(tr.payoffPerUnit(profile, c.s)).toBeCloseTo(c.expect, 9);
      expect(tr.pnlAt(profile, c.s)).toBeCloseTo(c.pnl, 9);
    }
  });
});
