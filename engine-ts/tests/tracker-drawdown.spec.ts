/** 利润回撤的激活线与最少回吐:实盘追踪和复盘回放必须是同一套闸。
 *
 * 2026-09-26 之前,「分档利润回撤(蝶式 40/30/20)」只把档位和尾盘收紧搬到了实盘,回放里另外两道闸没搬:
 * 蝶价到 1.3×D 才开始追(trail_arm)、回吐不足 0.20 点不触发(trail_floor)。于是实盘只要浮盈 > 0 就按 40% 算——
 * 浮盈只有几毛的时候,组合中间价随便晃一下就被扫出去。数值全部从 flyexit 取,这里不写死 0.3 / 0.2。
 */
import { describe, expect, it } from "vitest";

import * as fx from "../src/flyexit.js";
import { drawdownTiersOf } from "../src/rpc.js";
import * as tk from "../src/tracker.js";

/** 1 张蝶(组合按 1 份记):avg_cost 含乘数,315 = 3.15 × 100。 */
function fly(debit: number, quantity = 1): tk.Position {
  return tk.makePosition({
    account: "模拟", symbol: "SPX", sec_type: "BAG", quantity, avg_cost: debit * 100, multiplier: 100,
  });
}

const FLY = tk.makeTargets(drawdownTiersOf({ profit_drawdown_preset: "fly" }));
/** 加闸之前的样子:只有档位与尾盘收紧 */
const OLD = tk.makeTargets({ profit_drawdown_tiers: fx.drawdownTiers(null), profit_drawdown_late: fx.drawdownLate(null) });

/** 按顺序喂一串 [分钟, 价],峰值照实盘那样逐轮持久化;返回第一次触发的那一轮(没触发就是 null)。 */
function run(position: tk.Position, targets: tk.Targets, ticks: Array<[number, number]>) {
  let peak: number | null = null;
  for (const [minute, price] of ticks) {
    const out = tk.evaluate(position, targets, price, peak, minute);
    peak = out.peak;
    if (out.state === tk.STATE_PROFIT_TRAIL) return { minute, price, out };
  }
  return null;
}

const hm = (h: number, m: number): number => h * 60 + m;

describe("fly 预设的两道闸来自 flyexit", () => {
  it("激活线 = trail_arm − 1(浮盈倍数),最少回吐 = trail_floor(价格点)", () => {
    expect(FLY.profit_drawdown_arm).toBe(fx.drawdownArm(null));
    expect(FLY.profit_drawdown_arm).toBeCloseTo(fx.DEFAULTS["trail_arm"] - 1, 9);
    expect(FLY.profit_drawdown_floor).toBe(fx.DEFAULTS["trail_floor"]);
  });
});

describe("2026-09-25 SPX 7700/7720/7740 看跌蝶(3.15 买入):IBKR 组合分钟中间价", () => {
  // 12:16 开仓到 12:26,review.analyze 的 fly_series 收盘价原样抄下来
  const TAPE: Array<[number, number]> = [
    [hm(12, 16), 3.05], [hm(12, 17), 3.75], [hm(12, 18), 4.25], [hm(12, 19), 4.1], [hm(12, 20), 4.65],
    [hm(12, 21), 4.45], [hm(12, 22), 4.7], [hm(12, 23), 4.65], [hm(12, 24), 4.7], [hm(12, 25), 4.5],
    [hm(12, 26), 3.55],
  ];

  it("分钟收盘价上,加闸前后都在 12:26 以 3.55 触发:这一笔差别不在这里", () => {
    // 12:18 的 4.25 已经过了 1.3×D = 4.095,之后每一次回撤都比 0.20 大——两道闸都拦不住,也不该拦
    expect(run(fly(3.15), FLY, TAPE)).toMatchObject({ minute: hm(12, 26), price: 3.55 });
    expect(run(fly(3.15), OLD, TAPE)).toMatchObject({ minute: hm(12, 26), price: 3.55 });
  });

  it("12:24 的触发价和回放的 trailStop 是同一个数(4.08)", () => {
    let peak: number | null = null;
    let out: tk.EvaluateResult | null = null;
    for (const [minute, price] of TAPE.slice(0, 9)) {
      out = tk.evaluate(fly(3.15), FLY, price, peak, minute);
      peak = out.peak;
    }
    const params = fx.paramsFrom(null);
    expect(out!.profit_trail_stop).toBeCloseTo(fx.trailStop(4.7 - 3.15, 3.15, hm(12, 24), params), 9);
    expect(out!.profit_trail_stop).toBeCloseTo(4.08, 9);
  });

  it("开仓后一分钟里的噪声:浮盈 0.60 回吐到 0.30,加闸前就平了,现在不动", () => {
    // 3.75 离 1.3×D 还差一截,没激活;3.45 是 50% 的回撤——旧逻辑按 40% 档当场平掉,赚 30
    const noise: Array<[number, number]> = [[hm(12, 17), 3.75], [hm(12, 17), 3.45]];
    expect(run(fly(3.15), OLD, noise)).toMatchObject({ price: 3.45 });
    expect(run(fly(3.15), FLY, noise)).toBeNull();
    const out = tk.evaluate(fly(3.15), FLY, 3.45, 3.75, hm(12, 17));
    expect(out.profit_drawdown_threshold).toBeNull(); // 界面读作"未激活",不是"当前 40%"
    expect(out.profit_trail_stop).toBeNull();
  });
});

describe("最少回吐", () => {
  it("便宜的蝶(D = 1.00):峰值 1.40 时 40% 只让 0.16,不足 0.20 点——1.23 不动,1.20 才平", () => {
    const ticks: Array<[number, number]> = [[hm(11, 0), 1.4], [hm(11, 1), 1.23], [hm(11, 2), 1.2]];
    expect(run(fly(1.0), OLD, ticks)).toMatchObject({ price: 1.23 });
    expect(run(fly(1.0), FLY, ticks)).toMatchObject({ price: 1.2 });
    // 触发价取两个条件里离峰值更远的那个:min(1.00 + 0.40 × 0.6, 1.40 − 0.20)
    const out = tk.evaluate(fly(1.0), FLY, 1.3, 1.4, hm(11, 1));
    expect(out.profit_trail_stop).toBeCloseTo(1.2, 9);
  });

  it("空头(卖出收权利金,1.00 卖):跌到 0.60 是峰值,反弹 0.17 不动、0.20 才平;触发价对称", () => {
    const short = fly(1.0, -1);
    const ticks: Array<[number, number]> = [[hm(11, 0), 0.6], [hm(11, 1), 0.77], [hm(11, 2), 0.8]];
    expect(run(short, OLD, ticks)).toMatchObject({ price: 0.77 });
    expect(run(short, FLY, ticks)).toMatchObject({ price: 0.8 });
    const out = tk.evaluate(short, FLY, 0.7, 0.6, hm(11, 1));
    expect(out.profit_trail_stop).toBeCloseTo(0.8, 9);
  });

  it("没设这两道闸的追踪(自列档位、老记录):行为和原来一模一样", () => {
    const custom = tk.makeTargets(drawdownTiersOf({ profit_drawdown_tiers: [{ above: 0, pct: 40 }] }));
    expect(custom.profit_drawdown_arm).toBeNull();
    expect(custom.profit_drawdown_floor).toBeNull();
    const old = tk.makeTargets({ profit_drawdown_tiers: [{ above: 0, pct: 40 }] }); // 库里的老记录没有这两个键
    for (const t of [custom, old]) {
      expect(run(fly(1.0), t, [[hm(11, 0), 1.4], [hm(11, 1), 1.23]])).toMatchObject({ price: 1.23 });
      expect(tk.evaluate(fly(1.0), t, 1.3, 1.4, hm(11, 1)).profit_trail_stop).toBeCloseTo(1.24, 9);
    }
  });
});
