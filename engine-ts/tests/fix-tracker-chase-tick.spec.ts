/** 追价平仓的跳动(2026-09-27 审计 T5):单腿期权 3 元以下 0.05、3 元及以上 0.10。
 *
 * chaseLimit 以前按**自然价**那一档的跳动取整。空头买回从 2.90 往上追,会越过 3 元:按 0.05 取整挂出
 * 3.05、3.15——SPX 期权 3 元以上的跳动是 0.10,IBKR 以 110 拒掉这次改单。回报那一路又把改单被拒
 * 当成整张单没了,不再追、提醒"持仓可能还在",而那张单其实还挂在上一次被接受的价上。
 * 盯的是:追出来的每一个价都在它自己那一档的跳动上、只朝成交方向动、组合(0.05)不受影响。
 */
import { describe, expect, it } from "vitest";

import * as tk from "../src/tracker.js";

const single = (qty: number): tk.Position =>
  tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "OPT", quantity: qty, avg_cost: 300, multiplier: 100 });
const auto = tk.makeAutoClose({});

/** SPX 单腿期权的合法价:3 元以下 0.05 的整数倍,3 元及以上 0.10 的整数倍 */
function onTick(price: number): boolean {
  const tick = price >= 3 - 1e-9 ? 0.1 : 0.05;
  return Math.abs(price / tick - Math.round(price / tick)) < 1e-6;
}

function walk(position: tk.Position, natural: number, rounds: number): number[] {
  const out: number[] = [];
  let prev: number | null = null;
  for (let r = 0; r < rounds; r++) {
    prev = tk.chaseLimit(position, natural, prev, r, auto);
    out.push(prev);
  }
  return out;
}

describe("空头买回从 2.90 往上追,越过 3 元", () => {
  it("逐轮的价:先等两轮,之后每轮让一跳;越过 3 元改按 0.10 取整(朝成交方向,向上)", () => {
    expect(walk(single(-1), 2.9, 9)).toEqual([2.9, 2.9, 2.9, 2.95, 3, 3.1, 3.1, 3.2, 3.2]);
  });

  it("每一个价都在自己那一档的跳动上,且只升不降", () => {
    const seq = walk(single(-1), 2.9, 12);
    for (const p of seq) expect(onTick(p), `${p}`).toBe(true);
    for (let i = 1; i < seq.length; i++) expect(seq[i]!).toBeGreaterThanOrEqual(seq[i - 1]!);
  });

  it("chaseFloor(试算里「最多让到」)同样在跳动上", () => {
    expect(onTick(tk.chaseFloor(single(-1), 2.9, auto))).toBe(true);
  });
});

describe("性质:单腿期权自然价 2.50–3.50 的任意一轮都在合法跳动上", () => {
  it("多头卖出、空头买回都成立", () => {
    for (const qty of [1, -1]) {
      for (let cents = 250; cents <= 350; cents += 1) {
        const natural = cents / 100;
        for (let r = 0; r < 40; r++) {
          const p = tk.chaseLimit(single(qty), natural, null, r, auto);
          expect(onTick(p), `qty ${qty} natural ${natural} round ${r} → ${p}`).toBe(true);
        }
      }
    }
  });
});

describe("没越过 3 元的照旧", () => {
  it("多头从 3.10 往下追:3.10 → 3.00 → 2.90(本来就都在跳动上)", () => {
    expect(walk(single(1), 3.1, 6)).toEqual([3.1, 3.1, 3.1, 3, 2.9, 2.8]);
  });

  it("组合一律 0.05,不看价位", () => {
    const bag = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: -1, avg_cost: 300, multiplier: 100 });
    expect(walk(bag, 2.9, 7)).toEqual([2.9, 2.9, 2.9, 2.95, 3, 3.05, 3.1]);
  });
});
