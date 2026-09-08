/** 黄金对拍:ibtrades(券商成交 → 蝴蝶记录)。样例由 ../engine-python/scripts/gen_golden.py 生成。 */
import { describe, expect, it } from "vitest";

import * as ibt from "../src/ibtrades.js";
import { expectSame, loadGolden } from "./util.js";

describe("golden: ibtrades", () => {
  const g = loadGolden("ibtrades");

  for (const c of g.cases) {
    it(`group_butterflies: ${c.name}`, () => {
      expectSame(ibt.groupButterflies(c.fills, g.accounts), c.expect, c.name);
    });
  }

  it("group_key", () => {
    for (const c of g.group_key) expect(ibt.groupKey(c.fill)).toBe(c.expect);
  });
});
