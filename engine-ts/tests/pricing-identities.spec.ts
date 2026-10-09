/** 定价函数的**已知答案**:不靠快照、不靠参数,靠恒等式。
 *
 * 黄金基线只能发现"和上次不一样",证明不了"是对的"——它的期望值最初来自 Python 参考实现,现在由这份代码自己重生成。
 * 这里的每一条都有独立于实现的正确答案:平价关系、σ → 0 退化成内在价值、蝶价出不了 [0, 翼宽]、反解回得去。
 * 哪一条红了,就是定价错了,和基线有没有更新无关。
 */
import { describe, expect, it } from "vitest";

import { comboNaturalPrice } from "../src/autoMid.js";
import { comboMidPrice } from "../src/broker.js";
import * as fx from "../src/flyexit.js";
import { FLY_IV_MODEL } from "../src/flyIvModel.js";
import { remainingShare } from "../src/flyCalibration.js";
import { EM_FACTOR, expectedMove } from "../src/playbook.js";
import * as tk from "../src/tracker.js";

const SPOTS = [7600, 7700, 7725, 7740, 7750, 7760, 7775, 7800, 7900];
const SIGMAS = [0.5, 5, 20, 36, 80, 200];
const FLY = { lower: 7725, center: 7750, upper: 7775, width: 25, right: "C", action: "BUY" };

describe("Bachelier 单腿", () => {
  it("平价关系:看涨 − 看跌 = 标的 − 行权价(任何 σ)", () => {
    for (const s of SPOTS) {
      for (const sigma of SIGMAS) {
        expect(fx.bachelierCall(s, 7750, sigma) - fx.bachelierPut(s, 7750, sigma)).toBeCloseTo(s - 7750, 9);
      }
    }
  });

  it("σ → 0 退化成内在价值;σ = 0 正好是内在价值", () => {
    for (const s of SPOTS) {
      expect(fx.bachelierCall(s, 7750, 0)).toBe(Math.max(s - 7750, 0));
      expect(fx.bachelierPut(s, 7750, 0)).toBe(Math.max(7750 - s, 0));
      expect(fx.bachelierCall(s, 7750, 1e-6)).toBeCloseTo(Math.max(s - 7750, 0), 5);
    }
  });

  it("平值:看涨 = 看跌 = σ ÷ √(2π)", () => {
    for (const sigma of SIGMAS) {
      expect(fx.bachelierCall(7750, 7750, sigma)).toBeCloseTo(sigma / Math.sqrt(2 * Math.PI), 9);
      expect(fx.bachelierPut(7750, 7750, sigma)).toBeCloseTo(sigma / Math.sqrt(2 * Math.PI), 9);
    }
  });

  it("不低于内在价值;对 σ 单调不减;对标的:看涨不减、看跌不增", () => {
    for (const s of SPOTS) {
      let prev = -Infinity;
      for (const sigma of SIGMAS) {
        const c = fx.bachelierCall(s, 7750, sigma);
        expect(c).toBeGreaterThanOrEqual(Math.max(s - 7750, 0) - 1e-9);
        expect(c).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = c;
      }
    }
    for (const sigma of SIGMAS) {
      for (let i = 1; i < SPOTS.length; i += 1) {
        expect(fx.bachelierCall(SPOTS[i]!, 7750, sigma)).toBeGreaterThanOrEqual(fx.bachelierCall(SPOTS[i - 1]!, 7750, sigma) - 1e-9);
        expect(fx.bachelierPut(SPOTS[i]!, 7750, sigma)).toBeLessThanOrEqual(fx.bachelierPut(SPOTS[i - 1]!, 7750, sigma) + 1e-9);
      }
    }
  });

  it("反解:拿模型价解回去,得到原来的 σ(看涨看跌、实值虚值都一样)", () => {
    for (const s of [7700, 7750, 7790]) {
      for (const sigma of [5, 20, 80]) {
        for (const right of ["C", "P"]) {
          const price = fx.legValue(right, s, 7750, sigma);
          const intrinsic = right === "C" ? Math.max(s - 7750, 0) : Math.max(7750 - s, 0);
          // 离行权价八个 σ 开外:时间价值落在浮点精度以下,价格里已经没有 σ 的信息,解出来的数没有意义——
          // 这种价在市场上不存在(最小跳动 0.05),不在这条恒等式的范围里
          if (price - intrinsic < 1e-6) continue;
          expect(fx.impliedSigmaLeg(s, 7750, price, right)).toBeCloseTo(sigma, 4);
        }
      }
    }
  });

  it("没有价、价不是正数:不解", () => {
    expect(fx.impliedSigmaLeg(7750, 7750, 0, "C")).toBeNull();
    expect(fx.impliedSigmaLeg(7750, 7750, Number.NaN, "C")).toBeNull();
    // 低于内在价值的价没有任何 σ 能给出
    expect(fx.impliedSigmaLeg(7800, 7750, 40, "C")).toBeNull();
  });
});

describe("蝴蝶", () => {
  it("蝶价出不了 [0, 翼宽];看涨蝶与看跌蝶同价", () => {
    for (const s of SPOTS) {
      for (const sigma of SIGMAS) {
        const call = fx.modelPrice(FLY, s, sigma);
        expect(call).toBeGreaterThanOrEqual(0);
        expect(call).toBeLessThanOrEqual(FLY.width + 1e-9);
        expect(fx.modelPrice({ ...FLY, right: "P" }, s, sigma)).toBeCloseTo(call, 3);
      }
    }
  });

  it("关于中心对称;中心处最值钱", () => {
    for (const sigma of SIGMAS) {
      for (const d of [5, 10, 20, 40]) {
        expect(fx.modelPrice(FLY, 7750 + d, sigma)).toBeCloseTo(fx.modelPrice(FLY, 7750 - d, sigma), 3);
        expect(fx.modelPrice(FLY, 7750, sigma)).toBeGreaterThanOrEqual(fx.modelPrice(FLY, 7750 + d, sigma) - 1e-4);
      }
    }
  });

  it("σ = 0:就是到期的内在价值——中心值翼宽、翼上与翼外归零、半翼值一半", () => {
    expect(fx.modelPrice(FLY, 7750, 0)).toBe(25);
    expect(fx.modelPrice(FLY, 7737.5, 0)).toBe(12.5);
    expect(fx.modelPrice(FLY, 7725, 0)).toBe(0);
    expect(fx.modelPrice(FLY, 7800, 0)).toBe(0);
  });

  it("按比例加权的通用写法和蝶式专用写法是同一个数", () => {
    const legs = [{ strike: 7725, right: "C", ratio: 1 }, { strike: 7750, right: "C", ratio: -2 }, { strike: 7775, right: "C", ratio: 1 }];
    for (const s of SPOTS) {
      for (const sigma of SIGMAS) expect(fx.structureValue(legs, s, sigma)).toBeCloseTo(fx.modelPrice(FLY, s, sigma), 3);
    }
  });

  it("中心处:蝶价对 σ 单调递减", () => {
    let prev = Infinity;
    for (const sigma of SIGMAS) {
      const price = fx.modelPrice(FLY, 7750, sigma);
      expect(price).toBeLessThanOrEqual(prev + 1e-9);
      prev = price;
    }
  });

  it("翼内靠近翼的地方:σ 小的时候蝶价先略高于内在价值再往下走——所以反解只认低于内在价值的价", () => {
    // 7735:离买入的下翼 10 点、离卖出的中心 15 点。σ 很小时,下翼那条腿的时间价值比两条中心腿的大
    const intrinsic = fx.modelPrice(FLY, 7735, 0);
    expect(intrinsic).toBe(10);
    expect(fx.modelPrice(FLY, 7735, 5)).toBeGreaterThan(intrinsic);
    expect(fx.modelPrice(FLY, 7735, 80)).toBeLessThan(intrinsic);
    // 低于内在价值的价:根唯一,解得回去
    for (const s of [7735, 7750, 7765]) {
      for (const sigma of [20, 36, 80]) {
        const price = fx.modelPrice(FLY, s, sigma);
        expect(price).toBeLessThan(fx.modelPrice(FLY, s, 0));
        expect(Number(fx.impliedSigmaFly(FLY, s, price))).toBeCloseTo(sigma, 1); // 蝶价本身取整到四位小数
      }
    }
    // 不低于内在价值的价:同一个价对应两个 σ(或一个都没有),不解
    expect(fx.impliedSigmaFly(FLY, 7735, 10)).toBeNull();
    expect(fx.impliedSigmaFly(FLY, 7735, fx.modelPrice(FLY, 7735, 5))).toBeNull();
  });

  it("翼上与翼外不解(同一个价对应两个 σ)", () => {
    expect(fx.impliedSigmaFly(FLY, 7720, 4.5)).toBeNull();
    expect(fx.impliedSigmaFly(FLY, 7775, 4.5)).toBeNull();
  });
});

describe("价差与净价的符号", () => {
  it("借方看涨价差:价值在 [0, 宽度];σ = 0 时是内在价值", () => {
    const legs = [{ strike: 7500, right: "C", ratio: 1 }, { strike: 7520, right: "C", ratio: -1 }];
    for (const s of [7400, 7500, 7510, 7520, 7600]) {
      for (const sigma of SIGMAS) {
        const v = fx.structureValue(legs, s, sigma);
        expect(v).toBeGreaterThanOrEqual(-1e-9);
        expect(v).toBeLessThanOrEqual(20 + 1e-9);
      }
      expect(fx.structureValue(legs, s, 0)).toBe(Math.min(Math.max(s - 7500, 0), 20));
    }
  });

  it("贷方组合的净价是负的(收权利金);立刻成交的净价不会比中间价更有利", () => {
    const credit = [{ action: "SELL", ratio: 1, bid: 2.9, ask: 3.1 }, { action: "BUY", ratio: 1, bid: 0.9, ask: 1.1 }];
    expect(comboMidPrice(credit)).toBeLessThan(0);
    expect(comboNaturalPrice(credit)).toBeGreaterThanOrEqual(comboMidPrice(credit));
    const debit = credit.map((l) => ({ ...l, action: l.action === "BUY" ? "SELL" : "BUY" }));
    expect(comboMidPrice(debit)).toBe(-comboMidPrice(credit));
    expect(comboNaturalPrice(debit)).toBeGreaterThanOrEqual(comboMidPrice(debit));
  });

  it("平仓的立刻成交价不会高于中间价(多头)", () => {
    const position = tk.makePosition({ account: "a", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: 450, multiplier: 100 });
    const structure = tk.structureOf("BAG", { secType: "BAG", legs: [
      { strike: 7725, right: "C", ratio: 1 }, { strike: 7750, right: "C", ratio: -2 }, { strike: 7775, right: "C", ratio: 1 },
    ] })!;
    const book = { "7725C": { bid: 9.8, ask: 10.2 }, "7750C": { bid: 2.9, ask: 3.1 }, "7775C": { bid: 0.4, ask: 0.6 } };
    const mid = 10 - 2 * 3 + 0.5;
    const natural = tk.naturalClosePrice(position, structure, book)!;
    expect(natural).toBeCloseTo(9.8 - 2 * 3.1 + 0.4, 9);
    expect(natural).toBeLessThanOrEqual(mid);
  });
});

describe("时间与方差", () => {
  it("日内方差分布:各桶非负、和为 1;剩余方差从 1 单调降到 0", () => {
    const w = FLY_IV_MODEL.variance_weights;
    expect(w).toHaveLength(13);
    expect(w.every((v) => v >= 0)).toBe(true);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(fx.remainingVariance(9 * 60 + 30)).toBe(1);
    expect(fx.remainingVariance(16 * 60)).toBe(0);
    let prev = 1;
    for (let minute = 9 * 60 + 30; minute <= 16 * 60; minute += 1) {
      const r = fx.remainingVariance(minute);
      expect(r).toBeLessThanOrEqual(prev + 1e-9);
      prev = r;
      // 止盈策略那一份和蝴蝶测算那一份是同一张表
      expect(r).toBeCloseTo(remainingShare(w, minute), 6);
    }
  });

  it("剩余 σ = EM × √剩余方差:开盘就是 EM,收盘是 0", () => {
    expect(fx.sigmaRemaining(36, 9 * 60 + 30)).toBe(36);
    expect(fx.sigmaRemaining(36, 16 * 60)).toBe(0);
    expect(fx.sigmaRemaining(36, 12 * 60) ** 2).toBeCloseTo(36 ** 2 * fx.remainingVariance(12 * 60), 1);
  });

  it("预期波动 = 平值跨式 × √(π/2):正态分布下它正好是一个标准差", () => {
    expect(EM_FACTOR).toBeCloseTo(Math.sqrt(Math.PI / 2), 12);
    // 平值跨式的 Bachelier 价 = 2σ/√(2π),乘 √(π/2) 还原出 σ
    for (const sigma of SIGMAS) {
      const call = fx.bachelierCall(7750, 7750, sigma), put = fx.bachelierPut(7750, 7750, sigma);
      expect(expectedMove(call, put)).toBeCloseTo(sigma, 9);
    }
  });
});
