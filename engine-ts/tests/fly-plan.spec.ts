/** 蝴蝶测算的纯计算(flyPlan.ts):「标的在某个时刻走到某个点位」时这只蝶值多少、赚多少。
 *
 * 这里会算错钱的地方,每一处都钉一条:
 *  1. 定价口径。和持仓追踪的「标的目标价」必须是同一套——开仓前测算出来的数,开仓后追踪给的不能是另一个。
 *  2. IV 从哪来。三档依次退让,缺一条腿就整档不用;手动给的不锚定。
 *  3. IV 会变。时段与走势两份,参数是校准出来的(flyIvModel.ts):跌则 IV 升、涨则 IV 降。这里钉的是"参数怎么用",
 *     所以给一份固定的模型——重新校准之后参数会变,这些用例不该跟着红。校准本身在 fly-calibration.spec。
 *  4. 锚定随时间收敛。到期那一刻只能是内在价值,模型和盘口差多少都不许带进去。
 *  5. 日程。提前收盘日 13:00 到期;收盘之后默认算下一个交易日。
 */
import { describe, expect, it } from "vitest";

import { remainingShare } from "../src/flyCalibration.js";
import type { FlyIvModel } from "../src/flyCalibration.js";
import { legValue } from "../src/flyexit.js";
import {
  FlyPlanError, IV_FACTOR_MAX, ivResponse, markKey, planFly, planSchedule, sameSession, seasonalFactor,
} from "../src/flyPlan.js";
import type { FlyPlanInput, LegMark } from "../src/flyPlan.js";
import { ibkrLegSigmas } from "../src/ivPricing.js";
import * as tk from "../src/tracker.js";
import { weekdayOfDate } from "../src/tz.js";

const YEAR_MS = 365 * 24 * 3600 * 1000;
/** 2026-09-28 是周一。九月是夏令时,美东 = UTC−4 */
const at = (hhmm: string, day = "2026-09-28"): number => Date.parse(`${day}T${hhmm}:00-04:00`);
const NOW = at("10:00"), CLOSE = at("16:00");

/** 一份固定的模型(数字取整过,和随软件带的那份同一个量级) */
const MODEL: FlyIvModel = {
  version: "2026-09-28", source: "测试", proxy: "VIX1D", period: { from: "2023-12-11", to: "2026-09-25" }, days: 692,
  variance_weights: [0.15, 0.12, 0.095, 0.08, 0.06, 0.05, 0.06, 0.05, 0.06, 0.06, 0.06, 0.055, 0.1],
  realized_to_implied: 0.83,
  response: { a: -0.01, b: -0.1, c: 0.025 },
  response_long: { a: -0.005, b: -0.06, c: 0.013, days: 9 },
  resid_k: 0.16,
  resid_move: { base: 0.9, slope: 0.2 },
  own: null,
  fit: {
    rows: 19376, r2_in: 0.34, r2_out: 0.32, r2_out_flat: -0.01, coverage_half: 0.5,
    train: { from: "2023-12-11", to: "2025-11-19", days: 484 }, test: { from: "2025-11-20", to: "2026-09-25", days: 208 },
  },
};
const minuteOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const rv = (hhmm: string): number => remainingShare(MODEL.variance_weights, minuteOf(hhmm));

/** 用户口径的那只蝶:7750 中心、25 点翼宽,7725 / 7750 / 7775 看涨 */
const STRIKES = [7725, 7750, 7775];
const IVS: Record<string, number> = { "7725": 0.16, "7750": 0.15, "7775": 0.145 };

/** 市场自己的 IV 比 IBKR 的模型 IV 高一点:盘口拿它造,模型价和中间价就差一小截——锚定测的就是这一截 */
const MARKET_IVS: Record<string, number> = { "7725": 0.172, "7750": 0.162, "7775": 0.157 };
const round2 = (v: number): number => Math.round(v * 100) / 100;
const LEG_MID: Record<string, number> = Object.fromEntries(STRIKES.map((k) => [
  String(k), round2(legValue("C", 7720, k, 7720 * MARKET_IVS[String(k)]! * Math.sqrt((CLOSE - NOW) / YEAR_MS))),
]));

function marks(over: Partial<Record<string, Partial<LegMark>>> = {}): Record<string, LegMark> {
  const base: Record<string, LegMark> = Object.fromEntries(STRIKES.map((k) => [
    String(k), { bid: round2(LEG_MID[String(k)]! - 0.1), ask: round2(LEG_MID[String(k)]! + 0.1), iv: IVS[String(k)]! },
  ]));
  for (const [k, v] of Object.entries(over)) base[k] = { ...base[k]!, ...v };
  return base;
}

function input(over: Partial<FlyPlanInput> = {}): FlyPlanInput {
  return {
    symbol: "SPX", expiry: "20260928", tradingClass: "SPXW", right: "C", center: 7750, width: 25,
    quantity: 1, multiplier: 100, spot: 7720, spotSource: "quote", spotNote: "",
    nowMs: NOW, expiryMs: CLOSE, targetMs: at("14:00"), targetSpot: 7745,
    marks: marks(), cost: 2.0, ivInput: null, ivMode: "flat", ivShiftPct: null, timelineMs: [], model: MODEL,
    ...over,
  };
}

/** 同一套换算,手算一遍:各腿 IV × factor → 点数 σ → Bachelier → 按 +1/−2/+1 加权 */
function model(s: number, atMs: number, ivs: Record<string, number>, spot = 7720, factor = 1): number {
  const legs = STRIKES.map((strike, i) => ({ strike, right: "C", ratio: [1, -2, 1][i]! }));
  const scaled = Object.fromEntries(Object.entries(ivs).map(([k, v]) => [k, v * factor]));
  const sig = ibkrLegSigmas(legs, spot, scaled, CLOSE, atMs, (l) => markKey(l.strike))!;
  return legs.reduce((acc, l) => acc + l.ratio * legValue(l.right, s, l.strike, sig[markKey(l.strike)]!), 0);
}
const MID = LEG_MID["7725"]! - 2 * LEG_MID["7750"]! + LEG_MID["7775"]!;

describe("定价", () => {
  it("手动 IV、IV 不变:目标时刻的价值就是这组 σ 在那一刻、那个点位的 Bachelier 净价,不锚定", () => {
    const flat = { "7725": 0.15, "7750": 0.15, "7775": 0.15 };
    const out = planFly(input({ ivInput: 0.15 }));
    expect(out.iv.source).toBe("input");
    expect(out.anchored).toBe(false);
    expect(out.target.value).toBeCloseTo(model(7745, at("14:00"), flat), 2);
    expect(out.instant.value).toBeCloseTo(model(7745, NOW, flat), 2);
    expect(out.model_now).toBeCloseTo(model(7720, NOW, flat), 2);
    expect(out.legs.map((l) => [l.strike, l.action, l.ratio, l.iv])).toEqual([
      [7725, "BUY", 1, 0.15], [7750, "SELL", 2, 0.15], [7775, "BUY", 1, 0.15],
    ]);
  });

  it("盈亏:每份净价差 × 乘数 × 张数;百分比相对成本", () => {
    const one = planFly(input({ ivInput: 0.15 }));
    const three = planFly(input({ ivInput: 0.15, quantity: 3 }));
    expect(one.target.pnl).toBeCloseTo((one.target.value - 2.0) * 100, 2);
    expect(three.target.pnl).toBeCloseTo(one.target.pnl * 3, 2);
    expect(one.target.pnl_pct).toBeCloseTo(((one.target.value - 2.0) / 2.0) * 100, 1);
    expect(three.max_loss).toBe(600);
    expect(three.max_profit).toBe((25 - 2) * 100 * 3);
    expect(one.expiry_breakeven).toEqual({ low: 7727, high: 7773 });
  });

  it("到期时停在目标点位:只剩内在价值;越接近到期,翼内的目标越值钱", () => {
    const out = planFly(input({ ivInput: 0.15, timelineMs: [at("11:00"), at("13:00"), at("15:30"), CLOSE] }));
    expect(out.at_expiry.value).toBe(20); // 7745 − 7725
    expect(out.at_expiry.pnl).toBe(1800);
    const values = out.timeline.map((t) => t.value);
    expect(out.timeline.map((t) => t.at)).toEqual(["11:00", "13:00", "14:00", "15:30", "16:00"]);
    expect(out.timeline.find((t) => t.is_target)?.at).toBe("14:00");
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(values[values.length - 1]).toBe(20);
  });

  it("看跌蝶:同样的行权价与 IV,净价和看涨蝶一样(平价关系),到期价值也一样", () => {
    const call = planFly(input({ ivInput: 0.15 }));
    const put = planFly(input({ ivInput: 0.15, right: "P" }));
    expect(put.target.value).toBeCloseTo(call.target.value, 2);
    expect(put.at_expiry.value).toBe(call.at_expiry.value);
    expect(put.legs.every((l) => l.right === "P")).toBe(true);
  });

  it("和持仓追踪的「标的目标价」同一个数:目标时刻就是此刻、IV 不变时,两边对得上", () => {
    const contract = {
      secType: "BAG", symbol: "SPX",
      legs: STRIKES.map((strike, i) => ({ lastTradeDateOrContractMonth: "20260928", strike, right: "C", ratio: [1, -2, 1][i] })),
    };
    const position = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: 200, multiplier: 100 });
    const st = tk.spotTarget({
      structure: tk.structureOf("BAG", contract)!, position, spotTarget: 7745, spot: 7720, markPrice: MID,
      legPrices: { "7725C": LEG_MID["7725"]!, "7750C": LEG_MID["7750"]!, "7775C": LEG_MID["7775"]! }, minute: 10 * 60,
      legIvs: { "7725C": IVS["7725"]!, "7750C": IVS["7750"]!, "7775C": IVS["7775"]! }, expiryMs: CLOSE, nowMs: NOW,
    });
    expect(st.sigma_source).toBe("ibkr");
    const out = planFly(input({ targetMs: NOW }));
    expect(out.iv.source).toBe("ibkr");
    expect(Math.abs(out.target.value - st.price!)).toBeLessThan(0.006);
    expect(out.instant.value).toBe(out.target.value);
    expect(out.move.sigmas).toBeNull(); // 没有时间可言:不谈急不急
  });
});

describe("IV 从哪来", () => {
  it("三条腿都有 IBKR 的模型 IV:用它,锚在盘口中间价上——在现价、此刻正好还原中间价", () => {
    const out = planFly(input({ targetSpot: 7720, targetMs: NOW }));
    expect(out.iv.source).toBe("ibkr");
    expect(out.anchored).toBe(true);
    // 买入的蝶:两翼按卖价买、中心按买价卖 = 中间价 + 0.1 × 4;反过来卖 = 中间价 − 0.4
    expect(out.market).toEqual({ bid: round2(MID - 0.4), mid: round2(MID), ask: round2(MID + 0.4) });
    expect(out.target.value).toBeCloseTo(MID, 2);
    expect(out.model_now).toBeCloseTo(model(7720, NOW, IVS), 2);
    expect(Math.abs(out.model_now - MID)).toBeGreaterThan(0.02); // 两边确实不一样,锚定才有东西可测
  });

  it("锚定的那截差随剩余时间收敛:目标时刻只带 √(剩余 / 现在的剩余) 那么多,到期时一点不带", () => {
    const out = planFly(input());
    const gap = MID - model(7720, NOW, IVS);
    const left = Math.sqrt((CLOSE - at("14:00")) / (CLOSE - NOW));
    expect(out.target.value).toBeCloseTo(model(7745, at("14:00"), IVS) + gap * left, 2);
    expect(out.at_expiry.value).toBe(20);
  });

  it("缺一条腿的 IV:整档不用,改按各腿盘口中间价反解——此刻的模型价就是中间价,不用锚", () => {
    const out = planFly(input({ marks: marks({ "7775": { iv: null } }) }));
    expect(out.iv.source).toBe("quote");
    expect(out.anchored).toBe(false);
    expect(out.model_now).toBeCloseTo(MID, 2);
    // 反解出来的 IV 各腿不同(偏斜),都是正常量级
    for (const leg of out.legs) expect(leg.iv).toBeGreaterThan(0.05);
    expect(new Set(out.legs.map((l) => l.iv)).size).toBe(3);
  });

  it("买价恰好为 0(远翼没人出价):卖价在就是真盘口,中间价按 (0 + 卖价) / 2", () => {
    const out = planFly(input({ marks: marks({ "7775": { bid: 0, ask: 0.1, iv: null } }) }));
    expect(out.iv.source).toBe("quote");
    expect(out.legs[2]).toMatchObject({ bid: 0, ask: 0.1, mid: 0.05 });
  });

  it("IV 和盘口都不全:不猜,说清楚原因并指到手动 IV", () => {
    const broken = marks({ "7775": { iv: null, bid: null } });
    expect(() => planFly(input({ marks: broken }))).toThrow(/拿不到这三条腿的 IV.*手动填/);
    expect(() => planFly(input({ marks: {} }))).toThrow(FlyPlanError);
    // 手动给了就能算,而且不看那份残缺的行情里的 IV
    expect(planFly(input({ marks: broken, ivInput: 0.2 })).iv).toMatchObject({ source: "input", now: 0.2 });
  });

  it("IBKR 的模型价和盘口差得多:照样锚,但要说一声", () => {
    const low = Object.fromEntries(Object.entries(marks()).map(([k, m]) => [k, { ...m, iv: m.iv! * 0.4 }]));
    const out = planFly(input({ marks: low }));
    expect(out.anchored).toBe(true);
    expect(out.warnings.join("\n")).toMatch(/模型价 .* 和盘口中间价 .* 差得不小/);
    expect(planFly(input()).warnings.join("\n")).not.toMatch(/差得不小/);
  });
});

describe("成本", () => {
  it("填了就用填的;没填用盘口中间价,并把「现在立刻买得到的价」说出来", () => {
    expect(planFly(input({ cost: 1.8 }))).toMatchObject({ cost: 1.8, cost_source: "input" });
    const mid = planFly(input({ cost: null }));
    expect(mid).toMatchObject({ cost: round2(MID), cost_source: "mid" });
    expect(mid.warnings.join("\n")).toContain(`成本按盘口中间价 ${round2(MID)} 算,现在立刻买得到的价是 ${round2(MID + 0.4)}`);
  });

  it("没有盘口也没填:用模型价,并明说它不是市场价", () => {
    const out = planFly(input({ cost: null, marks: {}, ivInput: 0.15 }));
    expect(out.cost_source).toBe("model");
    expect(out.cost).toBeCloseTo(out.model_now, 2);
    expect(out.market).toEqual({ bid: null, mid: null, ask: null });
    expect(out.warnings.join("\n")).toMatch(/没有盘口.*不是市场价/);
  });

  it("成本不小于翼宽、成本不是正数:当场拒", () => {
    expect(() => planFly(input({ cost: 25 }))).toThrow(/不小于翼宽/);
    expect(() => planFly(input({ cost: 0 }))).toThrow(/成本要是正数/);
  });
});

/** 10:00 时离现价最近那条腿(7725)的 IV 折回全天:剩余波动 ÷ √还剩几成 */
const DAY_SIGMA = (7720 * IVS["7725"]! * Math.sqrt((CLOSE - NOW) / YEAR_MS)) / Math.sqrt(rv("10:00"));

describe("IV 会变:走势", () => {
  it("ln(乘数) = a + b·u + c·u²:跌则升、涨则降,走得越远越不对称", () => {
    const f = (u: number): number => ivResponse(MODEL, u, 0.25);
    expect(f(-1)).toBeCloseTo(Math.exp(-0.01 + 0.1 + 0.025), 9);
    expect(f(1)).toBeCloseTo(Math.exp(-0.01 - 0.1 + 0.025), 9);
    expect(f(-2)).toBeCloseTo(Math.exp(-0.01 + 0.2 + 0.1), 9);
    expect(f(-1)).toBeGreaterThan(1);
    expect(f(1)).toBeLessThan(1);
    // 同样的距离,跌的时候 IV 升的幅度大于涨的时候降的幅度
    expect(f(-2) - 1).toBeGreaterThan(1 - f(2));
    // 原地不动:拟合的截距,略小于 1
    expect(f(0)).toBeCloseTo(Math.exp(-0.01), 9);
  });

  it("u 夹在 ±4 以内(样本里再远的太少);乘数夹在 [1/3, 3];不是数的 u 当没有", () => {
    expect(ivResponse(MODEL, -9, 0.25)).toBe(ivResponse(MODEL, -4, 0.25));
    expect(ivResponse(MODEL, 9, 0.25)).toBe(ivResponse(MODEL, 4, 0.25));
    const wild: FlyIvModel = { ...MODEL, response: { a: 0, b: -1, c: 0 } };
    expect(ivResponse(wild, -4, 0.25)).toBe(IV_FACTOR_MAX);
    expect(ivResponse(wild, 4, 0.25)).toBeCloseTo(1 / IV_FACTOR_MAX, 9);
    expect(ivResponse(MODEL, Number.NaN, 0.25)).toBe(1);
  });

  it("期限:1 天以内用 1 天期的系数(不往更短外推);9 天以上用 9 天期的;之间按 ln(期限) 插值", () => {
    expect(ivResponse(MODEL, -1, 0.1)).toBe(ivResponse(MODEL, -1, 1));
    expect(ivResponse(MODEL, -1, 9)).toBeCloseTo(Math.exp(-0.005 + 0.06 + 0.013), 9);
    expect(ivResponse(MODEL, -1, 30)).toBe(ivResponse(MODEL, -1, 9));
    const mid = ivResponse(MODEL, -1, 3);
    expect(mid).toBeLessThan(ivResponse(MODEL, -1, 1));
    expect(mid).toBeGreaterThan(ivResponse(MODEL, -1, 9));
    const w = Math.log(3) / Math.log(9);
    expect(mid).toBeCloseTo(Math.exp((-0.01 + (0.005) * w) + (0.1 - 0.04 * w) + (0.025 - 0.012 * w)), 9);
    // 没有长一档的系数:什么期限都用 1 天期的
    expect(ivResponse({ ...MODEL, response_long: null }, -1, 30)).toBe(ivResponse(MODEL, -1, 1));
  });

  it("走了多远:全天标准差 = 期权自己的剩余波动 ÷ √还剩几成;u = 距离 ÷ 全天标准差,跌为负", () => {
    const up = planFly(input({ targetSpot: 7750, targetMs: at("10:30") }));
    expect(up.move.day_sigma).toBeCloseTo(DAY_SIGMA, 2);
    expect(up.move.day_sigmas).toBeCloseTo(30 / DAY_SIGMA, 2);
    expect(up.iv.now).toBe(IVS["7725"]);
    const down = planFly(input({ targetSpot: 7690, targetMs: at("10:30"), center: 7690, right: "P", marks: {}, ivInput: 0.16, cost: 3 }));
    expect(down.move).toMatchObject({ points: -30, direction: "down" });
    expect(down.move.day_sigmas).toBeCloseTo(-30 / DAY_SIGMA, 2);
  });

  it("这一段的几个标准差(急不急):全天标准差 × √(这一段占全天方差的份额)", () => {
    const out = planFly(input({ targetSpot: 7750, targetMs: at("10:30") }));
    const oneSigma = DAY_SIGMA * Math.sqrt(rv("10:00") - rv("10:30"));
    expect(out.move).toMatchObject({ points: 30, minutes: 30, direction: "up", pace: "sharp" });
    expect(out.move.one_sigma).toBeCloseTo(oneSigma, 2);
    expect(out.move.sigmas).toBeCloseTo(30 / oneSigma, 2);
  });

  it("涨到中心:IV 降,蝶比「IV 不变」算出来的贵;跌到中心:IV 升,蝶更便宜。两个数都给", () => {
    const up = planFly(input({ ivMode: "auto", targetSpot: 7750, targetMs: at("10:30") }));
    expect(up.iv.move_pct).toBeCloseTo((ivResponse(MODEL, 30 / DAY_SIGMA, 0.25) - 1) * 100, 1);
    expect(up.iv.move_pct).toBeLessThan(0);
    expect(up.target.value).toBeGreaterThan(up.target_flat.value);

    const put = { center: 7690, right: "P" as const, marks: {}, ivInput: 0.16, cost: 3 };
    const down = planFly(input({ ivMode: "auto", targetSpot: 7690, targetMs: at("10:30"), ...put }));
    expect(down.iv.move_pct).toBeGreaterThan(0);
    expect(down.target.value).toBeLessThan(down.target_flat.value);
    // 同样的距离,跌的那一边调得多
    expect(Math.abs(down.iv.move_pct)).toBeGreaterThan(Math.abs(up.iv.move_pct));
    // 「IV 不变」的那个数就是选了不变时的主结果
    const flat = planFly(input({ ivMode: "flat", targetSpot: 7750, targetMs: at("10:30") }));
    expect(up.target_flat).toEqual({ value: flat.target.value, pnl: flat.target.pnl, pnl_pct: flat.target.pnl_pct });
  });

  it("IV 的变化看的是走了多远,不是走得多急:隔日到期(没有时段那一份)时,早到晚到 IV 是同一个数", () => {
    const out = planFly(input({
      ivMode: "auto", expiry: "20260929", expiryMs: at("16:00", "2026-09-29"), targetSpot: 7750, targetMs: at("10:30"),
      timelineMs: [at("10:30"), at("12:00"), at("15:30")],
    }));
    expect(out.iv.seasonal_pct).toBe(0);
    expect(new Set(out.timeline.map((t) => t.iv)).size).toBe(1);
    expect(out.timeline.map((t) => t.at)).toEqual(["09-28 10:30", "09-28 12:00", "09-28 15:30"]);
    // 全天标准差:年化 IV 折成一个常规时段;反应按期限打折(1.25 天,在 1 天期与 9 天期之间)
    const daySigma = 7720 * IVS["7725"]! * Math.sqrt(MODEL.realized_to_implied / 252);
    expect(out.move.day_sigma).toBeCloseTo(daySigma, 2);
    expect(out.iv.move_pct).toBeCloseTo((ivResponse(MODEL, 30 / daySigma, 1.25) - 1) * 100, 1);
    expect(out.warnings.join("\n")).toMatch(/不是当日到期.*时段分布不适用.*按期限打了折/);
  });

  it("「现在就到」:没有时间可言,自动档也按 IV 不变算,没有区间", () => {
    const out = planFly(input({ ivMode: "auto", targetSpot: 7750, targetMs: NOW }));
    expect(out.iv).toMatchObject({ change_pct: 0, seasonal_pct: 0, move_pct: 0, range: null });
    expect(out.target_range).toBeNull();
    expect(out.target.value).toBe(out.target_flat.value);
  });
});

describe("IV 会变:时段", () => {
  it("当日到期:乘数 = √(剩余方差比 ÷ 剩余时间比),剩余方差按校准出来的分布", () => {
    const expected = (t: string): number => Math.sqrt((rv(t) / rv("10:00")) / ((CLOSE - at(t)) / (CLOSE - NOW)));
    for (const t of ["10:30", "12:00", "14:30", "15:30", "15:45"]) {
      expect(seasonalFactor(MODEL, NOW, at(t), CLOSE)).toBeCloseTo(expected(t), 9);
    }
    // 这份分布上午重:上午的乘数小于 1(波动掉得比钟点快),最后半小时重,尾盘回到 1 以上
    expect(seasonalFactor(MODEL, NOW, at("12:00"), CLOSE)).toBeLessThan(1);
    expect(seasonalFactor(MODEL, NOW, at("15:30"), CLOSE)).toBeGreaterThan(1);
  });

  it("换一份分布,乘数跟着变:分布是参数,不是写死的", () => {
    const flat: FlyIvModel = { ...MODEL, variance_weights: new Array(13).fill(1 / 13) };
    for (const t of ["11:00", "13:00", "15:30"]) expect(seasonalFactor(flat, NOW, at(t), CLOSE)).toBeCloseTo(1, 9);
  });

  it("此刻、到期那一刻、到期之后:1", () => {
    expect(seasonalFactor(MODEL, NOW, NOW, CLOSE)).toBe(1);
    expect(seasonalFactor(MODEL, NOW, CLOSE, CLOSE)).toBe(1);
    expect(seasonalFactor(MODEL, NOW, CLOSE + 1, CLOSE)).toBe(1);
  });

  it("隔日到期、提前收盘日(13:00 到期):那份日内分布对不上,不用", () => {
    expect(sameSession(NOW, CLOSE)).toBe(true);
    expect(sameSession(NOW, at("16:00", "2026-09-29"))).toBe(false);
    expect(sameSession(NOW, at("13:00"))).toBe(false);
    expect(seasonalFactor(MODEL, NOW, at("14:30"), at("16:00", "2026-09-29"))).toBe(1);
    expect(seasonalFactor(MODEL, NOW, at("12:00"), at("13:00"))).toBe(1);
  });

  it("盘前算当天的:开盘之前方差一点没走,时间却在走", () => {
    expect(seasonalFactor(MODEL, at("08:00"), at("09:30"), CLOSE)).toBeCloseTo(Math.sqrt(1 / (6.5 / 8)), 9);
  });

  it("自动档的合计 = 时段 × 走势;慢慢走到附近时只剩时段那一份在起作用", () => {
    const out = planFly(input({ ivMode: "auto", targetSpot: 7750, targetMs: at("14:30") }));
    const total = (1 + out.iv.seasonal_pct / 100) * (1 + out.iv.move_pct / 100);
    expect(out.iv.change_pct).toBeCloseTo((total - 1) * 100, 0);
    expect(out.iv.seasonal_pct).toBeCloseTo((seasonalFactor(MODEL, NOW, at("14:30"), CLOSE) - 1) * 100, 1);
    expect(out.iv.at_target).toBeCloseTo(out.iv.now * (1 + out.iv.change_pct / 100), 3);
  });

  it("自动档下,时间线上每一行用的是它自己那一刻的时段乘数", () => {
    const out = planFly(input({ ivMode: "auto", targetSpot: 7750, timelineMs: [at("10:30"), at("12:00"), at("15:30")] }));
    const response = ivResponse(MODEL, 30 / DAY_SIGMA, 0.25);
    for (const row of out.timeline) {
      expect(row.iv).toBeCloseTo(IVS["7725"]! * seasonalFactor(MODEL, NOW, row.epoch_ms, CLOSE) * response, 4);
    }
  });
});

describe("IV 会变:说清楚是估的", () => {
  it("自动档:给出校准用的样本、样本外 R²、用的是哪个指数", () => {
    const out = planFly(input({ ivMode: "auto" }));
    expect(out.iv.model).toEqual({ version: "2026-09-28", period: "2023-12-11 → 2026-09-25", days: 692, proxy: "VIX1D", r2_out: 0.32, own: false });
    expect(planFly(input({ ivMode: "flat" })).iv.model).toBeNull();
    expect(planFly(input({ ivMode: "shift", ivShiftPct: 20 })).iv.model).toBeNull();
  });

  it("半数情况下的区间:残差的标准差 = k × √(这一段占全天方差的份额) × (0.9 + 0.2·|u|),上下各 0.6745 个标准差", () => {
    const out = planFly(input({ ivMode: "auto", targetSpot: 7750, targetMs: at("12:00") }));
    const sd = MODEL.resid_k * Math.sqrt(rv("10:00") - rv("12:00")) * (0.9 + 0.2 * (30 / DAY_SIGMA));
    const factor = out.iv.at_target / out.iv.now;
    expect(out.iv.range!.low).toBeCloseTo(IVS["7725"]! * factor * Math.exp(-0.6745 * sd), 3);
    expect(out.iv.range!.high).toBeCloseTo(IVS["7725"]! * factor * Math.exp(0.6745 * sd), 3);
    expect(out.target_range!.low.value).toBeLessThanOrEqual(out.target.value);
    expect(out.target_range!.high.value).toBeGreaterThanOrEqual(out.target.value);
    expect(out.target_range!.high.pnl).toBeGreaterThan(out.target_range!.low.pnl);
  });

  it("走得越久,区间越宽;走得越远,区间也越宽", () => {
    const width = (t: string, target = 7750): number => {
      const r = planFly(input({ ivMode: "auto", targetSpot: target, targetMs: at(t) })).iv.range!;
      return r.high / r.low;
    };
    expect(width("15:00")).toBeGreaterThan(width("12:00"));
    expect(width("12:00")).toBeGreaterThan(width("10:30"));
    expect(width("12:00", 7790)).toBeGreaterThan(width("12:00", 7750));
  });

  it("IV 不变、自己填:没有区间,时段与走势两份都是 0", () => {
    const flat = planFly(input({ ivMode: "flat" }));
    expect(flat.iv).toMatchObject({ change_pct: 0, seasonal_pct: 0, move_pct: 0, range: null });
    expect(flat.target_range).toBeNull();
    const shift = planFly(input({ ivMode: "shift", ivShiftPct: 20 }));
    expect(shift.iv).toMatchObject({ change_pct: 20, seasonal_pct: 0, move_pct: 0, range: null });
    expect(shift.target_range).toBeNull();
  });

  it("提醒:自动档把合计拆开说,并给出历史上的区间", () => {
    const out = planFly(input({ ivMode: "auto", targetSpot: 7750, targetMs: at("10:30") }));
    expect(out.warnings.join("\n")).toMatch(/到时的 IV 按 −.*% 算\(时段 −.*%,走势 −.*%\);历史上同样的走势之后,半数情况落在 −.*% ~ .*% 之间。/);
  });

  it("提醒:选了不变 / 自己填,而历史上这样的走势之后 IV 通常差得多(十个百分点以上),要说一声", () => {
    const put = { center: 7650, right: "P" as const, marks: {}, ivInput: 0.16, cost: 3 };
    const flat = planFly(input({ ivMode: "flat", targetSpot: 7650, targetMs: at("10:30"), ...put }));
    expect(flat.warnings.join("\n")).toMatch(/你选的是 IV 不变;按历史数据,这样的走势之后 IV 通常是 \+.*%。/);
    const shift = planFly(input({ ivMode: "shift", ivShiftPct: -20, targetSpot: 7650, targetMs: at("10:30"), ...put }));
    expect(shift.warnings.join("\n")).toMatch(/IV 按你填的 −20% 算;按历史数据,这样的走势之后 IV 通常是 \+.*%。/);
    // 差得不多:不提
    expect(planFly(input({ ivMode: "flat", targetSpot: 7725, targetMs: at("10:30") })).warnings.join("\n")).not.toMatch(/按历史数据/);
  });

  it("自己填 IV 变化:整只蝶各腿同乘;结果和情景表里那一档是同一个数", () => {
    const out = planFly(input({ ivMode: "shift", ivShiftPct: 50 }));
    expect(out.iv).toMatchObject({ mode: "shift", change_pct: 50 });
    expect(out.iv.at_target).toBeCloseTo(IVS["7725"]! * 1.5, 4);
    const row = out.scenarios.find((s) => s.iv_change_pct === 50)!;
    expect(row.value).toBe(out.target.value);
    expect(out.scenarios.filter((s) => s.current)).toEqual([row]);
    expect(() => planFly(input({ ivMode: "shift", ivShiftPct: -100 }))).toThrow(/不能小于 −100%/);
  });

  it("情景表:固定五档,主结果用的那一档按它自己的乘数算;目标在中心附近时 IV 越高蝶越便宜", () => {
    const flat = planFly(input({ targetSpot: 7750 }));
    expect(flat.scenarios.map((s) => s.iv_change_pct)).toEqual([-25, 0, 25, 50, 100]);
    const values = flat.scenarios.map((s) => s.value);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
    expect(flat.scenarios[1]).toMatchObject({ value: flat.target.value, current: true });

    // 主结果那一档和主结果是同一个数——不是拿取整后的百分比再算一遍
    const auto = planFly(input({ ivMode: "auto", targetSpot: 7750, targetMs: at("10:30") }));
    const mine = auto.scenarios.filter((s) => s.current);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ iv_change_pct: auto.iv.change_pct, value: auto.target.value, pnl: auto.target.pnl, iv: auto.iv.at_target });
    expect(auto.scenarios).toHaveLength(6);

    // 离固定档不到半个百分点:那一档让位,不摆两行几乎一样的
    const near = planFly(input({ ivMode: "shift", ivShiftPct: 25.3 }));
    expect(near.scenarios.map((s) => s.iv_change_pct)).toEqual([-25, 0, 25.3, 50, 100]);
  });
});

describe("IV 会变:攒够了自己的期权 IV", () => {
  /** 拿自己记下来的当日到期期权 IV 估的那一份(数字是编的,只为了和指数那一份分得开) */
  const OWN: FlyIvModel = {
    ...MODEL,
    own: {
      period: { from: "2026-10-01", to: "2027-01-29" }, days: 80, rows: 4200,
      response: { a: 0, b: -0.2, c: 0.04 },
      // 10:00 起每半小时一个点:上午微降,下午抬升
      drift: [0, -0.02, -0.03, -0.03, -0.02, 0, 0.03, 0.07, 0.12, 0.18, 0.26, 0.36],
      resid_k: 0.3, resid_move: { base: 1, slope: 0 },
      fit: { r2_in: 0.5, r2_out: 0.45, r2_out_index: 0.3, coverage_half: 0.5 },
    },
  };

  it("当日到期:走势用自己那一份的系数,时段用量出来的那条日内走法", () => {
    const out = planFly(input({ ivMode: "auto", model: OWN, targetSpot: 7750, targetMs: at("14:00") }));
    const u = 30 / DAY_SIGMA;
    expect(out.iv.move_pct).toBeCloseTo((Math.exp(-0.2 * u + 0.04 * u * u) - 1) * 100, 1);
    expect(out.iv.seasonal_pct).toBeCloseTo((Math.exp(0.12) - 1) * 100, 1);
    expect(seasonalFactor(OWN, NOW, at("14:15"), CLOSE)).toBeCloseTo(Math.exp(0.15), 9); // 网格之间线性插值
    expect(seasonalFactor(OWN, at("12:00"), at("14:00"), CLOSE)).toBeCloseTo(Math.exp(0.12 + 0.02), 9);
    expect(seasonalFactor(OWN, NOW, at("15:50"), CLOSE)).toBeCloseTo(Math.exp(0.36), 9); // 网格之外取端点
  });

  it("结果里写明是拿自己攒的数据估的:样本的起止、天数、样本外 R²", () => {
    const out = planFly(input({ ivMode: "auto", model: OWN }));
    expect(out.iv.model).toEqual({
      version: "2026-09-28", period: "2026-10-01 → 2027-01-29", days: 80, proxy: "自己攒的当日到期期权 IV", r2_out: 0.45, own: true,
    });
  });

  it("区间的宽度也用自己那一份的残差", () => {
    const mine = planFly(input({ ivMode: "auto", model: OWN, targetSpot: 7750, targetMs: at("12:00") })).iv;
    expect(mine.range!.high / mine.at_target).toBeCloseTo(Math.exp(0.6745 * 0.3 * Math.sqrt(rv("10:00") - rv("12:00"))), 2);
  });

  it("隔日到期的蝶:自己那一份只管当日到期,照旧用指数那一份(按期限打折)", () => {
    const next = { expiry: "20260929", expiryMs: at("16:00", "2026-09-29"), targetSpot: 7750, targetMs: at("10:30") };
    const a = planFly(input({ ivMode: "auto", model: OWN, ...next }));
    const b = planFly(input({ ivMode: "auto", model: MODEL, ...next }));
    expect(a.iv.change_pct).toBe(b.iv.change_pct);
    expect(a.iv.model).toMatchObject({ own: false, proxy: "VIX1D" });
  });
});

describe("盈亏曲线", () => {
  it("覆盖两翼、现价与目标点位;每一点三个时刻的价值都在 [0, 翼宽] 里;到期那条线就是内在价值", () => {
    const out = planFly(input());
    const spots = out.curve.map((p) => p.spot);
    expect(Math.min(...spots)).toBeLessThanOrEqual(7720 - 12.5);
    expect(Math.max(...spots)).toBeGreaterThanOrEqual(7775 + 12.5);
    expect(out.curve.length).toBeLessThanOrEqual(82);
    for (const p of out.curve) {
      for (const v of [p.now, p.target, p.expiry]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(25);
      }
      expect(p.expiry).toBeCloseTo(Math.max(0, 25 - Math.abs(p.spot - 7750)), 2);
    }
  });

  it("目标时刻最赚的位置在中心附近;盈亏平衡点一左一右把它夹在中间", () => {
    const out = planFly(input());
    expect(Math.abs(out.peak.spot - 7750)).toBeLessThanOrEqual(5);
    expect(out.peak.value).toBeGreaterThan(out.cost);
    expect(out.breakeven.low).toBeLessThan(out.peak.spot);
    expect(out.breakeven.high).toBeGreaterThan(out.peak.spot);
  });

  it("成本高到目标时刻怎么走都不赚:平衡点给 null,不编", () => {
    const out = planFly(input({ cost: 24, targetMs: at("10:30") }));
    expect(out.peak.value).toBeLessThan(24);
    expect(out.breakeven).toEqual({ low: null, high: null });
  });

  it("目标点位在翼外:说明到期归零", () => {
    const out = planFly(input({ targetSpot: 7790 }));
    expect(out.at_expiry.value).toBe(0);
    expect(out.at_expiry.pnl).toBe(-200);
    expect(out.warnings.join("\n")).toMatch(/目标点位在两翼之外/);
  });
});

describe("时刻的先后", () => {
  it("目标时刻已经过去、在到期之后、到期日已经到期:各说各的", () => {
    expect(() => planFly(input({ targetMs: NOW - 60_000 }))).toThrow(/目标时刻已经过去了/);
    expect(() => planFly(input({ targetMs: CLOSE + 60_000 }))).toThrow(/在到期\(美东 2026-09-28 16:00\)之后/);
    expect(() => planFly(input({ nowMs: CLOSE, targetMs: CLOSE }))).toThrow(/已经到期了/);
  });

  it("结构上的错:翼宽、中心、张数、现价", () => {
    expect(() => planFly(input({ width: 0 }))).toThrow(/翼宽要是正数/);
    expect(() => planFly(input({ center: 20, width: 25 }))).toThrow(/中心行权价要大于翼宽/);
    expect(() => planFly(input({ quantity: 1.5 }))).toThrow(/张数/);
    expect(() => planFly(input({ spot: 0 }))).toThrow(/现价要是正数/);
    expect(() => planFly(input({ ivInput: 6 }))).toThrow(/IV 要在 0 到 500% 之间/);
  });

  it("时刻用美东写出来", () => {
    const out = planFly(input());
    expect(out).toMatchObject({ now_at: "2026-09-28 10:00", expiry_at: "2026-09-28 16:00" });
    expect(out.target).toMatchObject({ at: "2026-09-28 14:00", hours_left: 2, epoch_ms: at("14:00") });
  });
});

describe("日程:哪一天、几点、哪个到期日", () => {
  const HOLIDAYS = ["2026-11-26"];
  const EARLY = ["2026-11-27"];
  const calendar = {
    isTradingDay: (d: string) => weekdayOfDate(d) < 5 && !HOLIDAYS.includes(d),
    isEarlyClose: (d: string) => EARLY.includes(d),
  };
  const plan = (over: Record<string, unknown> = {}) =>
    planSchedule({ symbol: "SPX", tradingClass: "SPXW", targetTime: "14:30", nowMs: NOW, ...over }, calendar);

  it("什么都不给:今天、当日到期、16:00 结算;时间线是今天常规时段的每个半点", () => {
    const s = plan();
    expect(s).toMatchObject({ targetDate: "2026-09-28", targetMs: at("14:30"), expiry: "20260928", expiryMs: CLOSE, warnings: [] });
    expect(s.timelineMs).toHaveLength(14);
    expect(s.timelineMs[0]).toBe(at("09:30"));
    expect(s.timelineMs[13]).toBe(CLOSE);
  });

  it("今天已经收盘、周末:默认算下一个交易日,并说明", () => {
    const late = plan({ nowMs: at("16:30") });
    expect(late.targetDate).toBe("2026-09-29");
    expect(late.expiry).toBe("20260929");
    expect(late.warnings.join("\n")).toMatch(/按下一个交易日 2026-09-29 算/);
    expect(plan({ nowMs: at("11:00", "2026-10-03") }).targetDate).toBe("2026-10-05"); // 周六 → 周一
  });

  it("冬令时那一边也对:11 月的 14:30 是 UTC 19:30", () => {
    const s = plan({ targetDate: "2026-11-25", nowMs: Date.parse("2026-11-25T10:00:00-05:00") });
    expect(s.targetMs).toBe(Date.parse("2026-11-25T19:30:00Z"));
    expect(s.expiryMs).toBe(Date.parse("2026-11-25T21:00:00Z"));
  });

  it("提前收盘日:13:00 到期,时间线到 13:00 为止;目标时刻在那之后要提醒", () => {
    const s = plan({ targetDate: "2026-11-27", targetTime: "12:30", nowMs: Date.parse("2026-11-27T10:00:00-05:00") });
    expect(s.expiryMs).toBe(Date.parse("2026-11-27T13:00:00-05:00"));
    expect(s.warnings.join("\n")).toMatch(/2026-11-27 提前收盘,这只蝶按美东 13:00 到期算/);
    expect(s.timelineMs[s.timelineMs.length - 1]).toBe(s.expiryMs);
    const late = plan({ targetDate: "2026-11-27", targetTime: "14:30", nowMs: Date.parse("2026-11-27T10:00:00-05:00") });
    expect(late.warnings.join("\n")).toMatch(/不在常规交易时段里.*13:00/);
  });

  it("到期日可以晚于目标那一天(不是当日到期的蝶)", () => {
    const s = plan({ expiry: "20260930" });
    expect(s.targetDate).toBe("2026-09-28");
    expect(s.expiryMs).toBe(at("16:00", "2026-09-30"));
  });

  it("写法不对、不是交易日:当场拒,原样说出收到了什么", () => {
    expect(() => plan({ targetTime: "2点半" })).toThrow(/HH:MM.*收到「2点半」/);
    expect(() => plan({ targetTime: "25:00" })).toThrow(/HH:MM/);
    expect(() => plan({ targetDate: "2026/09/28" })).toThrow(/YYYY-MM-DD/);
    expect(() => plan({ targetDate: "2026-02-30" })).toThrow(/YYYY-MM-DD/);
    expect(() => plan({ targetDate: "2026-11-26" })).toThrow(/2026-11-26 不是交易日/);
    expect(() => plan({ expiry: "2026-09-28" })).toThrow(/YYYYMMDD/);
    expect(() => plan({ expiry: "20261003" })).toThrow(/2026-10-03 不是交易日/);
  });

  it("盘前、盘后的目标时刻:能算,但要提醒那时指数不报价", () => {
    expect(plan({ targetTime: "08:00" }).warnings.join("\n")).toMatch(/不在常规交易时段里\(美东 09:30–16:00\)/);
    expect(plan({ targetTime: "16:00" }).warnings).toEqual([]);
  });
});
