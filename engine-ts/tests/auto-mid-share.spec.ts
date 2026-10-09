/** AUTO_MID 按盘口价差的一份让价(limits.auto_mid_spread_share,autoMid.ts):纯函数,以及引擎选哪一种算法。 */
import { describe, expect, it } from "vitest";

import { autoMidShareLimit, comboNaturalPrice } from "../src/autoMid.js";
import { BrokerError, autoMidLimit, comboMidPrice } from "../src/broker.js";
import type { LegQuote } from "../src/broker.js";

/** 买入蝶:两翼买、中心卖两张。中间价 4.00 − 2×2.00 + 0.60 = 0.60;立刻成交 4.10 − 2×1.90 + 0.70 = 1.00 */
const FLY: LegQuote[] = [
  { action: "BUY", ratio: 1, bid: 3.9, ask: 4.1 },
  { action: "SELL", ratio: 2, bid: 1.9, ask: 2.1 },
  { action: "BUY", ratio: 1, bid: 0.5, ask: 0.7 },
];
/** 卖出看涨价差:卖低买高。中间价 −3.00 + 1.00 = −2.00(收 2.00);立刻成交 −2.90 + 1.10 = −1.80(只收 1.80) */
const CREDIT: LegQuote[] = [
  { action: "SELL", ratio: 1, bid: 2.9, ask: 3.1 },
  { action: "BUY", ratio: 1, bid: 0.9, ask: 1.1 },
];

describe("立刻成交的净价", () => {
  it("要买的腿按卖价、要卖的腿按买价;不会比中间价更有利", () => {
    expect(comboNaturalPrice(FLY)).toBe(1);
    expect(comboMidPrice(FLY)).toBe(0.6);
    expect(comboNaturalPrice(CREDIT)).toBe(-1.8);
    expect(comboMidPrice(CREDIT)).toBe(-2);
  });

  it("坏盘口、没有腿:拒,和中间价同一道守卫", () => {
    expect(() => comboNaturalPrice([])).toThrow(BrokerError);
    expect(() => comboNaturalPrice([{ action: "BUY", ratio: 1, bid: 0, ask: 1 }])).toThrow(/盘口不可用/);
    expect(() => comboNaturalPrice([{ action: "BUY", ratio: 1, bid: 2, ask: 1 }])).toThrow(/盘口不可用/);
  });
});

describe("按价差的一份让价", () => {
  it("借方:0 = 中间价,1 = 立刻成交的价,中间按份额;朝成交方向取整到 0.05", () => {
    expect(autoMidShareLimit(FLY, "BUY", 0)).toBe(0.6);
    expect(autoMidShareLimit(FLY, "BUY", 1)).toBe(1);
    expect(autoMidShareLimit(FLY, "BUY", 0.5)).toBe(0.8);
    expect(autoMidShareLimit(FLY, "BUY", 0.3)).toBe(0.75); // 0.72 → 向上取到 0.75
  });

  it("贷方:让价 = 少收一点,限价仍是负数", () => {
    expect(autoMidShareLimit(CREDIT, "SELL", 0)).toBe(-2);
    expect(autoMidShareLimit(CREDIT, "SELL", 1)).toBe(-1.8);
    expect(autoMidShareLimit(CREDIT, "SELL", 0.5)).toBe(-1.9);
  });

  it("盘口越宽让得越多、越窄让得越少:同一个份额,固定金额做不到", () => {
    const tight: LegQuote[] = FLY.map((l) => ({ ...l, bid: (l.bid + l.ask) / 2 - 0.025, ask: (l.bid + l.ask) / 2 + 0.025 }));
    const wide = autoMidShareLimit(FLY, "BUY", 0.5) - comboMidPrice(FLY);
    const narrow = autoMidShareLimit(tight, "BUY", 0.5) - comboMidPrice(tight);
    expect(wide).toBeCloseTo(0.2, 9);
    expect(narrow).toBeCloseTo(0.05, 9);
    // 对照:固定让 0.10 两边都是 0.10
    expect(autoMidLimit(comboMidPrice(FLY), "BUY", 0.1) - comboMidPrice(FLY)).toBeCloseTo(0.1, 9);
  });

  it("借方不超过结构宽度;份额越界、腿方向和订单方向对不上:拒", () => {
    expect(autoMidShareLimit(FLY, "BUY", 1, 0.9)).toBe(0.9);
    expect(() => autoMidShareLimit(FLY, "BUY", 1.2)).toThrow(/份额要在 0 到 1 之间/);
    expect(() => autoMidShareLimit(FLY, "BUY", -0.1)).toThrow(BrokerError);
    expect(() => autoMidShareLimit(FLY, "SELL", 0.5)).toThrow(/贷方组合的净中间价应为负/);
    expect(() => autoMidShareLimit(CREDIT, "BUY", 0.5)).toThrow(/借方组合的净中间价应为正/);
  });

  it("贷方的让价把权利金吃光:拒", () => {
    const thin: LegQuote[] = [{ action: "SELL", ratio: 1, bid: 0.05, ask: 0.3 }, { action: "BUY", ratio: 1, bid: 0.05, ask: 0.15 }];
    expect(() => autoMidShareLimit(thin, "SELL", 1)).toThrow(/已不再为负/);
  });
});
