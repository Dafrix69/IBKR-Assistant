/** 「标的目标价 → 预计价位 / 预估收益」:正股、单腿期权、蝶式与价差走同一条路。
 *
 * 这条路上会赔钱的地方有三个,每一个都在下面钉死:
 *  1. σ 从哪来。翼外反解是双根,拿错一个,算出来的钱差一倍。
 *  2. 目标价随时间走。同一个 7740,上午和尾盘不是一个价——设一次定死就是错的。
 *  3. 组合托管单的方向与净价符号。签错一次,"收 12.35"就变成"付 12.35"。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { etNowFromEpoch, setClock } from "../src/config.js";
import { BrokerRouter } from "../src/broker.js";
import { TradingEngine } from "../src/engine.js";
import * as fx from "../src/flyexit.js";
import { Notifier } from "../src/notify.js";
import { TradeStore } from "../src/store.js";
import * as tk from "../src/tracker.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");

type Rec = Record<string, any>;

const EXPIRY = "20260910";
/** 用户口径的那只蝶:7750 中心、25 点翼宽(「25 cm」),即 7725/7750/7775。 */
const STRIKES = [7725, 7750, 7775];

function bagContract(ratios = [1, -2, 1], right = "C", strikes = STRIKES): Rec {
  return {
    secType: "BAG", symbol: "SPX", exchange: "SMART", currency: "USD", multiplier: "100",
    combo_strategy: "BUTTERFLY",
    legs: strikes.map((strike, i) => ({
      lastTradeDateOrContractMonth: EXPIRY, strike, right, ratio: ratios[i],
    })),
  };
}

const PROFILE = tk.flyProfileOf(bagContract())!;

function comboPosition(qty = 1, avgCost = 450.0, price: number | null = 4.5): tk.Position {
  return tk.makePosition({
    account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: qty,
    avg_cost: avgCost, multiplier: 100.0, market_price: price,
  });
}

// ---------------------------------------------------------------- 几何识别
describe("flyProfileOf:认得出蝶,认不出就回 null", () => {
  it("买入看涨蝶 → 下翼/中心/上翼/翼宽/方向", () => {
    expect(PROFILE).toEqual({
      lower: 7725, center: 7750, upper: 7775, width: 25, right: "C", action: "BUY",
    });
  });

  it("卖出的蝶认得出来,但方向是 SELL", () => {
    expect(tk.flyProfileOf(bagContract([-1, 2, -1]))!.action).toBe("SELL");
  });

  it("看跌蝶", () => {
    expect(tk.flyProfileOf(bagContract([1, -2, 1], "P"))!.right).toBe("P");
  });

  for (const [why, contract] of [
    ["比例不是 1/−2/1", bagContract([1, -3, 1])],
    ["上下翼不等距", bagContract([1, -2, 1], "C", [7725, 7750, 7800])],
    ["看涨看跌混着", { ...bagContract(), legs: bagContract().legs.map((l: Rec, i: number) => ({ ...l, right: i === 1 ? "P" : "C" })) }],
    ["两条腿(价差不是蝶)", { ...bagContract(), legs: bagContract().legs.slice(0, 2) }],
    ["缺行权价", { ...bagContract(), legs: bagContract().legs.map((l: Rec) => ({ ...l, strike: null })) }],
    ["不是 BAG", { secType: "OPT", strike: 7750 }],
  ] as Array<[string, Rec]>) {
    it(`认不出就回 null:${why}`, () => {
      expect(tk.flyProfileOf(contract)).toBeNull();
    });
  }
});

// ---------------------------------------------------------------- 反解 σ
describe("反解 σ", () => {
  it("翼内:蝶价反解自洽(算回去还原原价)", () => {
    for (const [s, sigma] of [[7735, 15], [7745, 20], [7750, 25], [7760, 30]] as Array<[number, number]>) {
      const price = fx.modelPrice(PROFILE, s, sigma);
      const back = fx.impliedSigmaFly(PROFILE, s, price);
      // σ 差在千分之一以内:modelPrice 收到 4 位小数,那点取整由 σ 吸收,与钱无关
      expect(back, `S=${s} σ=${sigma}`).toBeCloseTo(sigma, 2);
      // 真正要紧的是价格能原样还原——挂出去的限价就是这个数
      expect(fx.modelPrice(PROFILE, s, back!), `还原价 S=${s}`).toBeCloseTo(price, 3);
    }
  });

  it("翼外一律拒绝反解:同一个蝶价对应两个 σ", () => {
    // 标的 7720、蝶价 4.50:σ≈19.5 与 σ≈42.6 都对得上(峰值在 σ≈28、蝶价 5.04),
    // 拿它们算到 7740 分别是 10.20 和 5.54——差出近一倍,所以绝不能从两个根里猜一个。
    expect(fx.modelPrice(PROFILE, 7720, 19.49)).toBeCloseTo(4.5, 2);
    expect(fx.modelPrice(PROFILE, 7720, 42.64)).toBeCloseTo(4.5, 2);
    expect(fx.modelPrice(PROFILE, 7740, 19.49)).toBeCloseTo(10.2, 1);
    expect(fx.modelPrice(PROFILE, 7740, 42.64)).toBeCloseTo(5.54, 1);
    // 峰值:两根之所以存在,就是因为这条曲线先升后降
    expect(fx.modelPrice(PROFILE, 7720, 28.06)).toBeGreaterThan(fx.modelPrice(PROFILE, 7720, 19.49));
    expect(fx.modelPrice(PROFILE, 7720, 28.06)).toBeGreaterThan(fx.modelPrice(PROFILE, 7720, 42.64));
    expect(fx.impliedSigmaFly(PROFILE, 7720, 4.5)).toBeNull();
    expect(fx.impliedSigmaFly(PROFILE, 7800, 2.0)).toBeNull();
  });

  it("蝶价高于内在价值:模型还原不了,不硬解", () => {
    // 翼内的蝶价上限就是内在价值(σ→0 那一头);比它还贵说明模型对不上市场
    expect(fx.impliedSigmaFly(PROFILE, 7740, 15.0 + 0.5)).toBeNull();
    expect(fx.impliedSigmaFly(PROFILE, 7740, 0)).toBeNull();
  });

  it("单腿反解:vega 恒正,根唯一,任何位置都解得出", () => {
    for (const [s, k, sigma, right] of [
      [7720, 7750, 30, "C"], [7760, 7750, 20, "C"], [7720, 7750, 25, "P"],
    ] as Array<[number, number, number, string]>) {
      const price = right === "P" ? fx.bachelierPut(s, k, sigma) : fx.bachelierCall(s, k, sigma);
      expect(fx.impliedSigmaLeg(s, k, price, right), `${right} S=${s}`).toBeCloseTo(sigma, 3);
    }
  });

  it("看跌平价关系", () => {
    expect(fx.bachelierPut(7720, 7750, 30)).toBeCloseTo(fx.bachelierCall(7720, 7750, 30) + 30, 9);
  });
});

// ---------------------------------------------------------------- 结构识别
describe("structureOf:正股、单腿、组合都认得出", () => {
  it("正股:没有腿,目标价就是它自己", () => {
    const st = tk.structureOf("STK", { secType: "STK", symbol: "NVDA" })!;
    expect(st.kind).toBe("stock");
    expect(st.legs).toEqual([]);
  });

  it("单腿期权", () => {
    const st = tk.structureOf("OPT", { secType: "OPT", strike: 7750, right: "C" })!;
    expect(st.kind).toBe("option");
    expect(st.legs).toEqual([{ strike: 7750, right: "C", ratio: 1 }]);
  });

  it("组合:带符号比例照搬,蝶另外认出几何", () => {
    const st = tk.structureOf("BAG", bagContract())!;
    expect(st.kind).toBe("combo");
    expect(st.legs.map((l) => l.ratio)).toEqual([1, -2, 1]);
    expect(st.fly).toEqual(PROFILE);
  });

  it("认不出蝶的组合照样能定价,只是没有蝶式那套约束", () => {
    const vertical = { ...bagContract(), legs: bagContract().legs.slice(0, 2) };
    const st = tk.structureOf("BAG", vertical)!;
    expect(st.kind).toBe("combo");
    expect(st.fly).toBeNull();
  });

  it("缺行权价 / 认不出的类型 → null", () => {
    expect(tk.structureOf("OPT", { secType: "OPT", right: "C" })).toBeNull();
    expect(tk.structureOf("BAG", { secType: "BAG", legs: [] })).toBeNull();
    expect(tk.structureOf("CASH", {})).toBeNull();
  });
});

// ---------------------------------------------------------------- 三级退让
const FLY_STRUCT = tk.structureOf("BAG", bagContract())!;

/** 组合腿报价按 legPriceKey 索引。 */
function legPrices(center: number | null): Record<string, number | null> {
  return { "7725C": null, "7750C": center, "7775C": null };
}

describe("spotTarget:σ 三个来源,依次退让,并如实报出来", () => {
  const base = {
    structure: FLY_STRUCT, position: comboPosition(), spotTarget: 7740, minute: 660,
    legPrices: legPrices(null),
  };

  it("翼内 → 用净价反解(net),且在目标价 = 现价时收敛到现价本身", () => {
    const spot = 7745;
    const markPrice = fx.modelPrice(PROFILE, spot, 20);
    const st = tk.spotTarget({ ...base, spot, markPrice, legPrices: legPrices(3.0) });
    expect(st.sigma_source).toBe("net");
    expect(st.sigma).toBeCloseTo(20, 2);
    // 自洽:问「标的到 7745(就是现在这里)值多少」,答案必须就是现价
    const same = tk.spotTarget({ ...base, spotTarget: spot, spot, markPrice, legPrices: legPrices(3.0) });
    expect(same.price).toBeCloseTo(markPrice, 3);
  });

  it("翼外 → 退到最贴近平值那条腿反解(leg)", () => {
    const legPrice = fx.bachelierCall(7720, 7750, 28);
    const st = tk.spotTarget({ ...base, spot: 7720, markPrice: 4.5, legPrices: legPrices(legPrice) });
    expect(st.sigma_source).toBe("leg");
    expect(st.sigma).toBeCloseTo(28, 2);
  });

  it("两条都拿不到 → 退到时钟 σ(EM×√剩余方差),来源标成 clock", () => {
    const st = tk.spotTarget({ ...base, spot: 7720, markPrice: null });
    expect(st.sigma_source).toBe("clock");
    expect(st.sigma).toBeCloseTo(fx.sigmaRemaining(36, 660), 4);
  });

  it("连标的现价都没有 → 也还能按时钟给个数,但绝不冒充市场价", () => {
    const st = tk.spotTarget({ ...base, spot: null, markPrice: 4.5, legPrices: legPrices(8.0) });
    expect(st.sigma_source).toBe("clock");
    expect(st.spot).toBeNull();
  });

  it("没有时刻、也没有行情 → 老实说算不出来", () => {
    const st = tk.spotTarget({ ...base, minute: null, spot: null, markPrice: null });
    expect(st.price).toBeNull();
    expect(st.reason).toContain("算不出");
  });
});

describe("spotTarget:说不通的目标价当场拒", () => {
  const base = {
    structure: FLY_STRUCT, position: comboPosition(), spot: 7740, markPrice: 8.0,
    legPrices: legPrices(5.0), minute: 660,
  };

  for (const target of [7775, 7800, 7725, 7700]) {
    it(`目标价 ${target} 在两翼之外:照样算得出一个正的价(到期前翼外不是零)`, () => {
      const st = tk.spotTarget({ ...base, spotTarget: target });
      expect(st.reason).toBe("");
      expect(st.price!).toBeGreaterThan(0);
      // 标的现在 7740 在翼内,到翼外只会更不值钱——这种由 validateSpotTarget 的"立刻成交"拦下
      expect(st.price!).toBeLessThan(base.markPrice);
    });
  }

  it("卖出的蝶不支持", () => {
    const sold = tk.structureOf("BAG", bagContract([-1, 2, -1]))!;
    const st = tk.spotTarget({ ...base, spotTarget: 7740, structure: sold });
    expect(st.price).toBeNull();
    expect(st.reason).toContain("借方");
  });

  it("目标价不是正数", () => {
    expect(tk.spotTarget({ ...base, spotTarget: 0 }).reason).toContain("正数");
  });
});

// ---------------------------------------------------------------- 翼外的蝶
/**
 * 用户的例子(2026-09-10):SPX 在 7700,开了 7720/7740/7760 的看涨蝶(20 cm),看 7715 的看涨墙
 * 会在那儿插针回落——这个软件要帮他吃到 7700→7715 这一段。蝶开在翼外、标的往翼靠一步它就涨一截,
 * 所以目标价必须能填在翼外,而且要按**当时实际的**波动率算。
 */
describe("翼外的蝶:按每条腿当时的波动率算,标的往翼靠它就涨", () => {
  const strikes = [7720, 7740, 7760];
  const contract = bagContract([1, -2, 1], "C", strikes);
  const fly = tk.structureOf("BAG", contract)!;
  // 当时实际的波动率:每条腿各不相同(偏斜),越往上越低
  const SIG: Record<string, number> = { "7720C": 16, "7740C": 14.5, "7760C": 13.5 };
  const quotes = (spot: number): Record<string, number> =>
    Object.fromEntries(strikes.map((k) => [`${k}C`, fx.bachelierCall(spot, k, SIG[`${k}C`]!)]));
  const markAt = (spot: number): number => {
    const q = quotes(spot);
    return q["7720C"]! - 2 * q["7740C"]! + q["7760C"]!;
  };
  const at = (spot: number) => ({
    structure: fly, position: comboPosition(1, 60, markAt(spot)), spot,
    markPrice: markAt(spot), legPrices: quotes(spot), minute: 840,
  });

  it("标的到 7715 时这只蝶值多少:每条腿用自己的 σ 在 7715 重估(smile)", () => {
    const st = tk.spotTarget({ ...at(7700), spotTarget: 7715 });
    expect(st.reason).toBe("");
    expect(st.sigma_source).toBe("smile");
    expect(st.leg_sigmas).toEqual({ "7720C": 16, "7740C": 14.5, "7760C": 13.5 });
    const expected = fx.bachelierCall(7715, 7720, 16) - 2 * fx.bachelierCall(7715, 7740, 14.5)
      + fx.bachelierCall(7715, 7760, 13.5);
    expect(st.price).toBeCloseTo(expected, 3);
    expect(st.sigma).toBe(16); // 报最贴近目标价那条腿的
    // 7700 → 7715 这一段,蝶价翻好几倍——这正是翼外开蝶要吃的
    expect(st.price! / markAt(7700)).toBeGreaterThan(3);
    expect(st.pnl!).toBeGreaterThan(0);
  });

  it("自洽:目标价就填现价,算出来的就是现价", () => {
    expect(tk.spotTarget({ ...at(7700), spotTarget: 7700 }).price).toBeCloseTo(markAt(7700), 3);
  });

  it("翼外蝶价反解仍是双根、仍然不猜;smile 根本不走那条路", () => {
    expect(fx.impliedSigmaFly(fly.fly!, 7700, markAt(7700))).toBeNull();
    expect(tk.spotTarget({ ...at(7700), spotTarget: 7715 }).sigma_source).toBe("smile");
  });

  it("标的穿过下翼时来源不换,挂单价不跳", () => {
    const below = tk.spotTarget({ ...at(7719.5), spotTarget: 7735 });
    const above = tk.spotTarget({ ...at(7720.5), spotTarget: 7735 });
    expect([below.sigma_source, above.sigma_source]).toEqual(["smile", "smile"]);
    expect(Math.abs(below.price! - above.price!)).toBeLessThan(0.01);
  });

  it("时间过去,同一个 7715 值得越来越少(翼外只剩时间价值)——所以必须每轮重算", () => {
    const early = tk.spotTarget({ ...at(7700), spotTarget: 7715 }).price!;
    const q = Object.fromEntries(strikes.map((k) => [`${k}C`, fx.bachelierCall(7700, k, SIG[`${k}C`]! / 2)]));
    const late = tk.spotTarget({ ...at(7700), legPrices: q, spotTarget: 7715 }).price!;
    expect(late).toBeLessThan(early);
  });

  it("设置时放行:翼外、但比现价更有利", () => {
    const st = tk.validateSpotTarget({ ...at(7700), contract, spotTarget: 7715 });
    expect(st.price!).toBeGreaterThan(markAt(7700));
  });

  it("往反方向填(离蝶更远)→ 拒,并告诉他往中心靠", () => {
    expect(() => tk.validateSpotTarget({ ...at(7700), contract, spotTarget: 7690 }))
      .toThrow(/立刻成交[\s\S]*往中心 7740 靠/);
  });

  it("试算时就给出那句话(不等点确认才被拒);有利的目标价没有这句", () => {
    const bad = tk.spotTarget({ ...at(7700), spotTarget: 7690 });
    expect(tk.fillsNowMessage(at(7700).position, fly, bad, markAt(7700))).toMatch(/立刻成交[\s\S]*往中心 7740 靠/);
    const good = tk.spotTarget({ ...at(7700), spotTarget: 7715 });
    expect(tk.fillsNowMessage(at(7700).position, fly, good, markAt(7700))).toBe("");
  });

  it("有一条腿没报价 → 不拿别的腿去填,退到最近腿那一档并标出来", () => {
    const st = tk.spotTarget({ ...at(7700), legPrices: { ...quotes(7700), "7760C": null }, spotTarget: 7715 });
    expect(st.sigma_source).toBe("leg");
    expect(st.sigma).toBeCloseTo(16, 3); // 最贴近平值的 7720C
    expect(st.leg_sigmas).toBeUndefined();
  });

  it("翼内、各腿报价齐全时也走 smile(不再是 net)", () => {
    const st = tk.spotTarget({ ...at(7735), spotTarget: 7740 });
    expect(st.sigma_source).toBe("smile");
  });
});

// ---------------------------------------------------------------- 贷方组合的口径
describe("贷方组合:止盈价和现价在同一个口径上(每组净值的绝对值)", () => {
  // 卖 7750C、买 7775C 的看涨贷方价差:收权利金,标的往下走才赚
  const contract = bagContract([-1, 1], "C", [7750, 7775]);
  const structure = tk.structureOf("BAG", contract)!;
  const quotes = (spot: number): Record<string, number> => ({
    "7750C": fx.bachelierCall(spot, 7750, 20), "7775C": fx.bachelierCall(spot, 7775, 18),
  });
  const markAt = (spot: number): number => quotes(spot)["7750C"]! - quotes(spot)["7775C"]!;
  const short = tk.makePosition({
    account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: -1,
    avg_cost: 1000.0, multiplier: 100.0, market_price: markAt(7745),
  });
  const args = { position: short, contract, spot: 7745, markPrice: markAt(7745), legPrices: quotes(7745), minute: 660 };

  it("标的往下走 → 买回来更便宜:止盈价为正、低于现价,预估收益为正", () => {
    const st = tk.spotTarget({ ...args, structure, spotTarget: 7720 });
    expect(st.sigma_source).toBe("smile");
    expect(st.price!).toBeGreaterThan(0);
    expect(st.price).toBeCloseTo(markAt(7720), 3);
    expect(st.price!).toBeLessThan(markAt(7745));
    expect(st.pnl!).toBeGreaterThan(0);
    expect(tk.validateSpotTarget({ ...args, spotTarget: 7720 }).price).toBeCloseTo(markAt(7720), 3);
  });

  it("往上填 → 拒:挂上去会立刻成交", () => {
    expect(() => tk.validateSpotTarget({ ...args, spotTarget: 7760 })).toThrow(/立刻成交/);
  });
});

// ---------------------------------------------------------------- 正股与单腿
describe("正股:目标价就是价格,要的是预估收益", () => {
  const stk = tk.makePosition({
    account: "模拟", symbol: "NVDA", sec_type: "STK", quantity: 100,
    avg_cost: 180.0, multiplier: 1.0, market_price: 220.0,
  });
  const structure = tk.structureOf("STK", { secType: "STK", symbol: "NVDA" })!;

  it("不用波动率,也不受时刻影响", () => {
    const at = (minute: number) => tk.spotTarget({
      structure, position: stk, spotTarget: 250, spot: 220, markPrice: 220, minute,
    });
    expect(at(600).sigma_source).toBe("none");
    expect(at(600).sigma).toBeNull();
    expect(at(600).price).toBe(250);
    expect(at(945).price).toBe(250); // 每轮算出来都一样,所以正股不会反复改单
  });

  it("预估收益 = (目标价 − 成本) × 数量", () => {
    const st = tk.spotTarget({
      structure, position: stk, spotTarget: 250, spot: 220, markPrice: 220, minute: 600,
    });
    expect(st.pnl).toBe((250 - 180) * 100);
    expect(st.pnl_pct).toBeCloseTo(((250 - 180) / 180) * 100, 3);
  });

  it("空头正股:目标价在下方才是赚", () => {
    const short = tk.makePosition({
      account: "模拟", symbol: "NVDA", sec_type: "STK", quantity: -100,
      avg_cost: 180.0, multiplier: 1.0, market_price: 220.0,
    });
    const st = tk.spotTarget({
      structure, position: short, spotTarget: 150, spot: 220, markPrice: 220, minute: 600,
    });
    expect(st.pnl).toBe((150 - 180) * -100);
    expect(st.pnl).toBeGreaterThan(0);
  });
});

describe("单腿期权:任何位置都解得出 σ", () => {
  const contract = { secType: "OPT", symbol: "SPX", strike: 7750, right: "C", multiplier: "100" };
  const structure = tk.structureOf("OPT", contract)!;
  const pos = tk.makePosition({
    account: "模拟", symbol: "SPX", sec_type: "OPT", quantity: 2,
    avg_cost: 400.0, multiplier: 100.0, market_price: 4.0,
  });

  it("用自己的报价反解(net),标的在哪儿都行", () => {
    for (const spot of [7700, 7750, 7800]) {
      const mark = fx.bachelierCall(spot, 7750, 25);
      const st = tk.spotTarget({ structure, position: pos, spotTarget: 7770, spot, markPrice: mark, minute: 660 });
      expect(st.sigma_source, `spot=${spot}`).toBe("net");
      expect(st.sigma, `spot=${spot}`).toBeCloseTo(25, 2);
    }
  });

  it("预估收益按每张成本 4.00 算(avg_cost 含乘数,只乘一次)", () => {
    const mark = fx.bachelierCall(7740, 7750, 20);
    const st = tk.spotTarget({ structure, position: pos, spotTarget: 7770, spot: 7740, markPrice: mark, minute: 660 });
    expect(st.price).toBeGreaterThan(mark);            // 涨到 7770 更值钱
    expect(st.pnl).toBeCloseTo((st.price! - 4.0) * 100 * 2, 2);
  });

  it("看跌腿:目标价往下才值钱", () => {
    const put = tk.structureOf("OPT", { ...contract, right: "P" })!;
    const mark = fx.bachelierPut(7750, 7750, 25);
    const down = tk.spotTarget({ structure: put, position: pos, spotTarget: 7700, spot: 7750, markPrice: mark, minute: 660 });
    const up = tk.spotTarget({ structure: put, position: pos, spotTarget: 7800, spot: 7750, markPrice: mark, minute: 660 });
    expect(down.price!).toBeGreaterThan(mark);
    expect(up.price!).toBeLessThan(mark);
  });
});

describe("垂直价差:认不出蝶也照样按比例加权定价", () => {
  const vertical = { ...bagContract(), legs: bagContract().legs.slice(0, 2) }; // +1x7725C -2x7750C

  it("净价 = Σ 比例 × 腿价", () => {
    const legs = [{ strike: 7725, right: "C", ratio: 1 }, { strike: 7750, right: "C", ratio: -2 }];
    expect(fx.structureValue(legs, 7740, 20)).toBeCloseTo(
      fx.bachelierCall(7740, 7725, 20) - 2 * fx.bachelierCall(7740, 7750, 20), 3,
    );
  });

  it("走 leg 档反解(净价对 σ 不保证单调,不硬解)", () => {
    const structure = tk.structureOf("BAG", vertical)!;
    const st = tk.spotTarget({
      structure, position: comboPosition(), spotTarget: 7740, spot: 7745,
      markPrice: 2.0, legPrices: { "7750C": fx.bachelierCall(7745, 7750, 22) }, minute: 660,
    });
    expect(st.sigma_source).toBe("leg");
    expect(st.sigma).toBeCloseTo(22, 2);
    expect(st.price).not.toBeNull();
  });
});

// ---------------------------------------------------------------- 每轮重算
describe("同一个标的目标价,时间过去就该值更多钱", () => {
  const base = {
    structure: FLY_STRUCT, position: comboPosition(), spotTarget: 7740, spot: 7720,
    markPrice: null, legPrices: legPrices(null),
  };

  it("时钟 σ 衰减 → 预计价位单调上行,收盘收敛到内在价值", () => {
    const prices = [600, 720, 840, 900, 930, 945].map(
      (minute) => tk.spotTarget({ ...base, minute }).price!,
    );
    for (let i = 1; i < prices.length; i += 1) {
      expect(prices[i]!, `第 ${i} 段`).toBeGreaterThan(prices[i - 1]!);
    }
    // 内在价值 = 翼宽 − |S−K| = 25 − 10 = 15,收盘时就是它
    expect(prices[prices.length - 1]!).toBeLessThan(15);
    expect(tk.spotTarget({ ...base, minute: fx.CLOSE_MIN }).price).toBeCloseTo(15, 6);
  });

  it("这正是它不能设一次定死的理由:早盘算出来的数到尾盘偏低一半以上", () => {
    const morning = tk.spotTarget({ ...base, minute: 600 }).price!;
    const late = tk.spotTarget({ ...base, minute: 945 }).price!;
    expect(late / morning).toBeGreaterThan(1.9);
  });
});

// ---------------------------------------------------------------- 设置时的校验
describe("validateSpotTarget", () => {
  const args = {
    position: comboPosition(),
    contract: bagContract(),
    spotTarget: 7740,
    spot: 7745,
    markPrice: fx.modelPrice(PROFILE, 7745, 20),
    legPrices: legPrices(null),
    minute: 660,
  };

  it("算得出、且高于现价 → 放行,并把这一刻的数交回去", () => {
    const st = tk.validateSpotTarget({ ...args, spotTarget: 7748 });
    expect(st.price).toBeGreaterThan(args.markPrice);
    expect(st.sigma_source).toBe("net");
  });

  it("目标价对应的价位不高于现价 → 拒:挂上去会立刻成交", () => {
    // 现在标的 7745(离中心 5),目标 7740(离中心 10)反而更远、更不值钱
    expect(() => tk.validateSpotTarget(args)).toThrow(/立刻成交/);
  });

  it("认不出结构 → 拒", () => {
    expect(() => tk.validateSpotTarget({ ...args, contract: { secType: "BAG", legs: [] } }))
      .toThrow(/认不出结构/);
  });

  it("标的在翼内、目标价填到翼外 → 拒,理由是到那儿蝶更便宜(不是「翼外归零」)", () => {
    expect(() => tk.validateSpotTarget({ ...args, spotTarget: 7790 })).toThrow(/立刻成交[\s\S]*往中心 7750 靠/);
  });

  it("正股多头把目标价填在现价下方 → 同样拒", () => {
    const stk = tk.makePosition({
      account: "模拟", symbol: "NVDA", sec_type: "STK", quantity: 100,
      avg_cost: 180.0, multiplier: 1.0, market_price: 220.0,
    });
    expect(() => tk.validateSpotTarget({
      position: stk, contract: { secType: "STK", symbol: "NVDA" }, spotTarget: 200,
      spot: 220, markPrice: 220, minute: 600,
    })).toThrow(/立刻成交/);
  });
});

// ---------------------------------------------------------------- 托管限价单
describe("组合托管:只挂一张限价止盈单", () => {
  const auto = tk.makeAutoClose({ enabled: true, host_at_broker: true, order_type: "LMT" });

  it("BAG 只出 tp 一张,STP/TRAIL 一律不挂", () => {
    const plan = tk.hostedPlan(
      comboPosition(),
      tk.makeTargets({ take_profit: 12.37, stop_loss: 2.0, trail_pct: 30, profit_drawdown_pct: 40 }),
      auto, 9.0,
    );
    expect(plan.map((p) => p.kind)).toEqual([tk.HOSTED_KIND_TP]);
    expect(plan[0]!.order_type).toBe("LMT");
    expect(plan[0]!.action).toBe("SELL"); // 用户口径的方向;带符号净价在 broker 层换
  });

  it("限价按 0.05 对齐,且朝成交方向取整(平多头向下)", () => {
    const at = (tp: number) => tk.hostedPlan(comboPosition(), tk.makeTargets({ take_profit: tp }), auto, null)[0]!.lmt_price;
    expect(at(12.37)).toBe(12.35);
    expect(at(12.35)).toBe(12.35);
    expect(at(0.01)).toBe(0.05); // 不小于一个跳动
  });

  it("正股不受影响,还是老四张", () => {
    const stk = tk.makePosition({ account: "模拟", symbol: "NVDA", sec_type: "STK", quantity: 100, avg_cost: 100, multiplier: 1, market_price: 120 });
    const plan = tk.hostedPlan(stk, tk.makeTargets({ take_profit: 130, stop_loss: 90, trail_pct: 5, profit_drawdown_pct: 40 }), auto, 125);
    expect(plan.map((p) => p.kind)).toEqual([
      tk.HOSTED_KIND_TP, tk.HOSTED_KIND_SL, tk.HOSTED_KIND_TRAIL, tk.HOSTED_KIND_PTRAIL,
    ]);
  });

  it("价格变了一个跳动就要改单(秒级调价靠的就是这个判断)", () => {
    const mk = (tp: number) => tk.hostedPlan(comboPosition(), tk.makeTargets({ take_profit: tp }), auto, null)[0]!;
    expect(tk.hostedNeedsUpdate(mk(12.35), mk(12.40))).toBe(true);
    expect(tk.hostedNeedsUpdate(mk(12.35), mk(12.37))).toBe(false); // 都对齐到 12.35
  });
});

// ---------------------------------------------------------------- 目标与 Targets
describe("Targets 里的 spot_target", () => {
  it("只填标的目标价也算设了目标,不该被当成空", () => {
    expect(tk.targetsEmpty(tk.makeTargets({ spot_target: 7740 }))).toBe(false);
    expect(tk.targetsEmpty(tk.makeTargets({}))).toBe(true);
  });

  it("validate 不因为没填止盈价就拦下来", () => {
    expect(() => tk.validate(comboPosition(), tk.makeTargets({ spot_target: 7740 }), 4.5)).not.toThrow();
  });
});

// ---------------------------------------------------------------- 引擎串起来
/**
 * 集成:从"设了标的目标价"到"券商侧真挂着一张随时间调价的 BAG 限价单"。
 *
 * 纯函数上面已经钉过了,这里只盯串起来才会暴露的东西:合约拼成什么样、
 * 时间走了单子有没有跟着改、行情断了会不会把单子撤掉。
 */
class FlyRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  placed: Rec[] = [];
  modified: Rec[] = [];
  cancelled: number[] = [];
  spot: number | null = 7720;
  private nextId = 700;

  constructor(public rows: Rec[]) {}

  async positions(): Promise<Rec[]> { return [...this.rows]; }
  async indexPrice(): Promise<number | null> { return this.spot; }
  async placeHosted(account: Rec, contract: Rec, item: Rec, oca: string, ref: string): Promise<Rec> {
    this.nextId += 1;
    this.placed.push({ contract, item: { ...item }, oca, ref, order_id: this.nextId });
    return { order_id: this.nextId, perm_id: null, status: "PreSubmitted" };
  }
  async modifyHosted(orderId: number, item: Rec): Promise<boolean> {
    this.modified.push({ order_id: orderId, item: { ...item } });
    return true;
  }
  async cancelHosted(orderId: number): Promise<boolean> { this.cancelled.push(orderId); return true; }
  async listHostedOpen(): Promise<Rec[]> { return []; }
  async legQuotes(): Promise<any[]> { return []; }
  async place(): Promise<any> { throw new Error("not used"); }
  async cancelAllOpen(): Promise<number> { return 0; }
  async contractHours(): Promise<null> { return null; }
  cachedContractHours(): null { return null; }
  sessions(): unknown[] { return []; }
}

function legRow(strike: number, qty: number, price: number | null): Rec {
  const contract = {
    secType: "OPT", symbol: "SPX", lastTradeDateOrContractMonth: EXPIRY,
    strike, right: "C", multiplier: "100",
  };
  const ident = tk.legOf(contract);
  return {
    key: tk.makeKey("模拟", "SPX", "OPT", ident), account: "模拟", symbol: "SPX", sec_type: "OPT",
    leg: ident, quantity: qty, avg_cost: Math.abs(qty) * 100, multiplier: 100.0,
    currency: "USD", market_price: price, market_value: null, unrealized_pnl: null, contract,
  };
}

/** 三条腿凑出净价 4.50(1×6.00 − 2×3.00 + 1×4.50)。 */
function flyLegs(prices: [number, number, number] = [6.0, 3.0, 4.5]): Rec[] {
  return [
    legRow(STRIKES[0]!, 1.0, prices[0]),
    legRow(STRIKES[1]!, -2.0, prices[1]),
    legRow(STRIKES[2]!, 1.0, prices[2]),
  ];
}

describe("集成:标的目标价 → 券商侧一张会自己调价的限价单", () => {
  const NOON = etNowFromEpoch(Date.parse("2026-09-10T12:00:00-04:00"));
  const LATE = etNowFromEpoch(Date.parse("2026-09-10T15:30:00-04:00"));

  function build(rows: Rec[]) {
    const dir = mkdtempSync(path.join(tmpdir(), "dafri-fly-"));
    const settings = makeSettings(g.base_config, {
      policies: { auto_execute: true },
      storage: { db_path: path.join(dir, "fly.db") },
    });
    const router = new FlyRouter(rows);
    const engine = new TradingEngine({
      settings, parser: {} as any, store: new TradeStore(settings.db_path),
      notifier: new Notifier(false), router: router as any,
    });
    const combo = tk.withCombos(rows).find((r) => r["sec_type"] === "BAG")!;
    const track = engine.store.addTrack({
      account: "模拟", symbol: "SPX", sec_type: "BAG", leg: combo["leg"],
      contract: combo["contract"], targets: { spot_target: 7740 },
      auto_close: { enabled: true, order_type: "LMT", host_at_broker: true, close_fraction_pct: 100 },
      peak: null,
    });
    return { engine, router, track, combo };
  }

  it("挂出去的是腿方向全部反转的 BAG 限价单", async () => {
    const { engine, router } = build(flyLegs());
    await engine.syncHosted();
    expect(router.placed, JSON.stringify(router.cancelled)).toHaveLength(1);
    const { contract, item, ref } = router.placed[0]!;
    expect(contract.secType).toBe("BAG");
    expect(contract.legs.map((l: Rec) => [l.action, l.ratio, l.strike])).toEqual([
      ["SELL", 1, 7725], ["BUY", 2, 7750], ["SELL", 1, 7775],
    ]);
    expect(item.order_type).toBe("LMT");
    expect(item.kind).toBe("tp");
    expect(ref).toMatch(/^trk:.+:tp$/);
    // 限价对齐到 0.05(按分比,不做浮点取模),且是"标的到 7740 该值多少",不是现价 4.50
    expect(Math.round(item.lmt_price * 100) % 5).toBe(0);
    expect(item.lmt_price).toBeGreaterThan(4.5);
  });

  it("时间走了、蝶价涨了 → 同一个目标价对应更高的限价,改单而不是撤了重挂", async () => {
    // 标的 7745 在两翼之间,走净价反解那一档
    const { engine, router } = build(flyLegs([8.0, 3.0, 6.0])); // 净价 8.00
    router.spot = 7745;
    await engine.syncHosted();
    const first = router.placed[0]!.item.lmt_price;

    // 时间价值掉了一截:同一个标的位置上蝶价更贵 → 反解出更小的 σ → 到 7740 更值钱
    router.rows = flyLegs([9.0, 2.5, 6.0]); // 净价 10.00
    setClock(LATE.epochMs);
    try {
      await engine.syncHosted();
    } finally {
      setClock(null);
    }
    expect(router.placed).toHaveLength(1);   // 没有重挂
    expect(router.cancelled).toEqual([]);    // 更没有撤掉
    expect(router.modified.length).toBeGreaterThan(0);
    const latest = router.modified[router.modified.length - 1]!.item.lmt_price;
    expect(latest, `${first} → ${latest}`).toBeGreaterThan(first);
  });

  it("行情断了:停在最后一次市场价算出来的限价,绝不把已经站岗的单子撤掉", async () => {
    const { engine, router } = build(flyLegs([8.0, 3.0, 6.0]));
    router.spot = 7745;
    await engine.syncHosted();
    const first = router.placed[0]!.item.lmt_price;

    // 标的、组合净价、腿报价全没了:只剩模型默认波动率,那不该拿来改一张真单
    router.spot = null;
    router.rows = flyLegs([null as any, null as any, null as any]);
    await engine.syncHosted();
    await engine.syncHosted();
    expect(router.cancelled).toEqual([]);
    expect(router.placed).toHaveLength(1);
    for (const m of router.modified) expect(m.item.lmt_price).toBe(first);
  });

  it("从来没拿到过市场价:只守不挂——模型默认价没人同意过,不能拿它挂第一张单", async () => {
    const { engine, router } = build(flyLegs([null as any, null as any, null as any]));
    router.spot = null;
    const out = await engine.pollTrackers(NOON);
    const row = (out["rows"] as Rec[])[0]!["spot_target"];
    expect(row.sigma_source).toBe("clock");
    expect(row.held).toBe(true);
    expect(row.reason).toContain("先不挂单");
    await engine.syncHosted();
    expect(router.placed).toEqual([]);      // 不挂
    // 行情一来就按市场价挂
    router.spot = 7745;
    router.rows = flyLegs([8.0, 3.0, 6.0]);
    await engine.syncHosted();
    expect(router.placed).toHaveLength(1);
  });

  it("夜盘推算失败、退回的是昨收:当作没有现价,不拿十个小时前的数去反解", async () => {
    const { engine, router } = build(flyLegs([8.0, 3.0, 6.0]));
    router.spot = 7636.36;
    (router as any).spotInfo = () => ({ price: 7636.36, source: "index_stale", note: "昨收" });
    const out = await engine.pollTrackers(NOON);
    const row = (out["rows"] as Rec[])[0]!["spot_target"];
    expect(row.spot).toBeNull();
    expect(row.sigma_source).not.toBe("net"); // 没现价就反解不了净价
    await engine.syncHosted();
    expect(router.placed).toEqual([]);         // 也不拿模型价挂第一张
  });

  it("重启后认领回来的托管单:只守不挂的那几轮不许撤掉它", async () => {
    const { engine, router, track } = build(flyLegs([null as any, null as any, null as any]));
    router.spot = null;
    // 模拟重启:券商侧还挂着这张单,引擎内存里没有上一次的市场价
    (router as any).listHostedOpen = async () => [{
      order_ref: `trk:${track["id"]}:tp`, order_id: 901, quantity: 1,
      lmt_price: 9.5, aux_price: null, trailing_percent: null, sec_type: "BAG",
    }];
    await engine.syncHosted();
    await engine.syncHosted();
    expect(router.cancelled).toEqual([]);
    expect(router.placed).toEqual([]);
  });

  it("读不到持仓(推送卡住)≠ 持仓已不存在:不许停掉追踪、不许撤托管单", async () => {
    const { engine, router, track } = build(flyLegs([8.0, 3.0, 6.0]));
    router.spot = 7745;
    await engine.syncHosted();
    expect(router.placed).toHaveLength(1);

    // 2026-09-10 真机:持仓推送卡住,以前被当成空仓,BE 的追踪就这么被自动停用了
    router.positions = async () => { throw new Error("读不到持仓:TWS 在 8 秒内没有推送持仓"); };
    await engine.pollTrackers(NOON);
    await engine.syncHosted();
    expect(engine.store.getTrack(track["id"])!["enabled"]).toBeTruthy();
    expect(router.cancelled).toEqual([]);
  });

  it("软件盯盘那一路也拿得到这个数,并且写进行里给界面看", async () => {
    const { engine, router } = build(flyLegs());
    router.spot = 7745; // 翼内:走蝶价反解
    const out = await engine.pollTrackers(NOON);
    const row = (out["rows"] as Rec[])[0]!;
    expect(row["spot_target"]).toBeTruthy();
    expect(row["spot_target"].spot_target).toBe(7740);
    expect(row["spot_target"].sigma_source).toBe("net");
    expect(row["spot_target"].price).toBeGreaterThan(0);
    // 这一轮的止盈价就是它:离触发还有多远,界面按同一个数画
    expect(row["to_take_profit_pct"]).not.toBeNull();
  });
});

// ---------------------------------------------------------------- 净价符号
/**
 * 组合托管单发到 IBKR 那一层:action 与净价符号。
 *
 * BAG 必须以 BUY 提交(SELL 会把每条腿再反转一次);平掉借方蝶是**收**权利金,
 * 净价必须是负数。挂单时签了、改单时忘了签,第一次秒级调价就会把一张"收 12.35"
 * 改成"付 12.35"——所以两头都得验。
 */
describe("BAG 托管单:一律 BUY 提交,净价带符号", () => {
  const bagSpec = { secType: "BAG", symbol: "SPX", exchange: "SMART", currency: "USD", legs: [] };
  const account = { alias: "模拟", account_id: "DU111", is_paper: true } as any;

  /** 只替换掉要连 TWS 的两处,其余全走真实实现。 */
  class ProbeRouter extends BrokerRouter {
    sent: Rec[] = [];
    private readonly fakeSession = {
      placeOrder: async (_c: Rec, order: Rec) => {
        this.sent.push({ ...order });
        return { orderId: 4242, permId: null, status: "PreSubmitted" };
      },
    };
    override async forAccount(): Promise<any> { return this.fakeSession; }
    override async qualify(spec: any): Promise<any> { return { ...spec }; }
  }

  function probe() {
    const dir = mkdtempSync(path.join(tmpdir(), "dafri-bagsign-"));
    const settings = makeSettings(g.base_config, { storage: { db_path: path.join(dir, "s.db") } });
    return new ProbeRouter(settings);
  }

  const plan = (lmt: number) => tk.hostedPlan(
    comboPosition(),
    tk.makeTargets({ take_profit: lmt }),
    tk.makeAutoClose({ enabled: true, host_at_broker: true }),
    null,
  )[0]!;

  it("挂单:用户口径 SELL 12.35 → 提交 BUY,净价 −12.35", async () => {
    const router = probe();
    const item = plan(12.35);
    expect(item.action).toBe("SELL");           // 用户口径:平多头就是卖
    await router.placeHosted(account, bagSpec as any, item, "oca-1", "trk:x:tp");
    expect(router.sent[0]!.action).toBe("BUY"); // 发给 IBKR 的口径
    expect(router.sent[0]!.lmtPrice).toBe(-12.35);
    expect(router.sent[0]!.tif).toBe("GTC");
  });

  it("改价:符号照样带上,不会把收权利金改成付权利金", async () => {
    const router = probe();
    await router.placeHosted(account, bagSpec as any, plan(12.35), "oca-1", "trk:x:tp");
    const ok = await router.modifyHosted(4242, plan(13.60));
    expect(ok).toBe(true);
    const last = router.sent[router.sent.length - 1]!;
    expect(last.lmtPrice).toBe(-13.60);
    expect(last.action).toBe("BUY");
    expect(last.orderId).toBe(4242);            // 同 id 重发 = 改单,不是撤了重挂
  });

  it("正股不受影响:方向与限价照原样", async () => {
    const router = probe();
    const stk = tk.makePosition({
      account: "模拟", symbol: "NVDA", sec_type: "STK", quantity: 100,
      avg_cost: 180, multiplier: 1, market_price: 220,
    });
    const item = tk.hostedPlan(stk, tk.makeTargets({ take_profit: 250 }),
      tk.makeAutoClose({ enabled: true, host_at_broker: true }), null)[0]!;
    await router.placeHosted(account, { secType: "STK", symbol: "NVDA" } as any, item, "oca-2", "trk:y:tp");
    expect(router.sent[0]!.action).toBe("SELL");
    expect(router.sent[0]!.lmtPrice).toBe(250);
  });
});
