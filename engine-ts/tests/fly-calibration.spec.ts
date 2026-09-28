/** 蝴蝶测算的 IV 模型怎么从历史数据里估出来(flyCalibration.ts),以及随软件带的那一份(flyIvModel.ts)。
 *
 * 校准出来的参数要进定价,算错了就是算错钱,所以估计方法本身要钉住:拿**已知答案的合成数据**喂进去,
 * 估出来的要对得上。全部离线——真数据不进仓库,也不进测试。
 *
 *  1. 日内方差分布:合成数据按给定的份额造,估回来的份额要对;高波动的那几天不许说了算(先按当天的隐含水平归一)。
 *  2. IV 的反应:按给定的 a、b、c 造,最小二乘要估得回来;样本外 R² 是拿前一段的系数去算后一段。
 *  3. 数据不齐的那几天(半日市、缺口)不要;样本太少直接拒,不给一份靠不住的参数。
 *  4. 随软件带的那一份:形状对、量级对、样本外比"IV 不变"强——重新校准之后这几条仍然要成立。
 *  5. 自己攒的期权 IV:同样拿已知答案的合成样本喂进去,日内走法与反应都要估得回来;不够就拒;
 *     估出来不比指数那一份强,不换。
 */
import { describe, expect, it } from "vitest";

import {
  calibrate, fitFromSamples, fitResponse, gridOf, halfHourWeights, ownDriftAt, ownIsBetter, predict, remainingShare, residualSd,
  rSquared, sessions, varianceShares,
  HALF_HOURS, HOURS, OPEN_MINUTE, OWN_GRID_POINTS, OWN_MIN_DAYS, QUARTILE, U_MAX,
} from "../src/flyCalibration.js";
import type { Bar, OwnFit, OwnSample, ResponseRow } from "../src/flyCalibration.js";
import { FLY_IV_MODEL } from "../src/flyIvModel.js";
import { ET, wallToEpoch, weekdayOfDate } from "../src/tz.js";

// ---- 可复现的随机数 --------------------------------------------------------
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s + 0.5) / 4294967296;
  };
}
function normal(next: () => number): number {
  return Math.sqrt(-2 * Math.log(next())) * Math.cos(2 * Math.PI * next());
}

const sec = (date: string, minute: number): number => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return wallToEpoch({ year: y, month: m, day: d, hour: Math.floor(minute / 60), minute: minute % 60, second: 0 }, ET) / 1000;
};

function tradingDays(from: string, count: number): string[] {
  const out: string[] = [];
  const day = new Date(`${from}T00:00:00Z`);
  while (out.length < count) {
    const iso = day.toISOString().slice(0, 10);
    if (weekdayOfDate(iso) < 5) out.push(iso);
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
}

const TRUE_HALF = [0.16, 0.12, 0.1, 0.08, 0.06, 0.05, 0.05, 0.05, 0.06, 0.06, 0.06, 0.05, 0.1];
const TRUE_HOUR = [0.28, 0.18, 0.11, 0.1, 0.12, 0.11, 0.1];
const TRUE = { a: 0, b: -0.1, c: 0 };
const TRUE_DRIFT = [0, 0.01, 0.05, 0.1, 0.15, 0.2, 0.24, 0.23];

/**
 * 合成一段历史:每天的隐含水平不同(有几天特别高),标的按给定的日内分布走,
 * IV 指数 = 开盘水平 × 自己的日内走法 × 对标的累计走势的反应 × 噪声。
 */
function synth(days: string[], seed: number, opts: { noise?: number; fineFrom?: number } = {}) {
  const next = rng(seed);
  const priceHourly: Bar[] = [], priceFine: Bar[] = [], ivHourly: Bar[] = [], ivLongHourly: Bar[] = [];
  days.forEach((date, n) => {
    const level = (n % 40 === 7 ? 45 : 11) + 6 * next(); // 偶尔来一个高波动日
    const sigmaDay = (level / 100) / Math.sqrt(252);
    let price = 600 + 50 * next(), cum = 0, iv = level, ivLong = level * 1.2;
    const fine = n >= (opts.fineFrom ?? days.length - 60);
    for (let h = 0; h < HOURS; h += 1) {
      const minute = OPEN_MINUTE + h * 60, open = price;
      const halves = h < HOURS - 1 ? [TRUE_HALF[2 * h]!, TRUE_HALF[2 * h + 1]!] : [TRUE_HALF[12]!];
      // 小时份额取 TRUE_HOUR,小时之内前后半小时按 TRUE_HALF 的比例分
      const total = halves.reduce((a, b) => a + b, 0);
      let step = minute;
      for (const half of halves) {
        const variance = sigmaDay ** 2 * TRUE_HOUR[h]! * (half / total);
        for (let k = 0; k < 6; k += 1) {
          const from = price;
          price *= Math.exp(Math.sqrt(variance / 6) * normal(next));
          if (fine) priceFine.push({ sec: sec(date, step), open: from, close: price });
          step += 5;
        }
      }
      priceHourly.push({ sec: sec(date, minute), open, close: price });
      cum = Math.log(price / priceHourly[priceHourly.length - 1 - h]!.open) / sigmaDay;
      const ivOpen = iv;
      iv = level * Math.exp(TRUE_DRIFT[h + 1]! + TRUE.b * cum + (opts.noise ?? 0.01) * normal(next));
      ivHourly.push({ sec: sec(date, minute), open: h === 0 ? level : ivOpen * 0.9, close: iv }); // 除第一根外开盘价故意造错:估计不许用它
      const longOpen = ivLong;
      ivLong = level * 1.2 * Math.exp(0.5 * TRUE.b * cum + 0.005 * normal(next));
      ivLongHourly.push({ sec: sec(date, minute), open: h === 0 ? level * 1.2 : longOpen, close: ivLong });
    }
  });
  return { priceHourly, priceFine, ivHourly, ivLongHourly };
}

const META = { source: "合成数据", proxy: "TEST1D", version: "2026-09-28" };

describe("K 线 → 每天一行", () => {
  const DAY = "2026-09-25";
  const hourly = (from: number, count: number): Bar[] =>
    Array.from({ length: count }, (_, i) => ({ sec: sec(DAY, from + i * 60), open: 100 + i, close: 101 + i }));

  it("只留常规时段;按美东日期分开;每天按时间排好", () => {
    const bars: Bar[] = [
      { sec: sec(DAY, 8 * 60), open: 1, close: 1 }, ...hourly(OPEN_MINUTE, HOURS).reverse(), { sec: sec(DAY, 16 * 60), open: 1, close: 1 },
      { sec: sec("2026-09-24", OPEN_MINUTE), open: 50, close: 51 },
    ];
    const s = sessions(bars);
    expect([...s.keys()].sort()).toEqual(["2026-09-24", "2026-09-25"]);
    expect(s.get(DAY)!.map((b) => b.minute)).toEqual([570, 630, 690, 750, 810, 870, 930]);
  });

  it("网格 = [开盘, 每根的收盘…]:只用第一根的开盘价", () => {
    expect(gridOf(sessions(hourly(OPEN_MINUTE, HOURS)).get(DAY), 60)).toEqual([100, 101, 102, 103, 104, 105, 106, 107]);
  });

  it("根数不齐、不是从 09:30 起、价格不是正数:这一天不要", () => {
    expect(gridOf(sessions(hourly(OPEN_MINUTE, 4)).get(DAY), 60)).toBeNull(); // 半日市
    expect(gridOf(sessions(hourly(OPEN_MINUTE + 60, 6)).get(DAY), 60)).toBeNull();
    expect(gridOf(undefined, 60)).toBeNull();
    const broken = hourly(OPEN_MINUTE, HOURS);
    broken[3] = { ...broken[3]!, close: 0 };
    expect(gridOf(sessions(broken).get(DAY), 60)).toBeNull();
    // 5 分钟线偶尔少一两根(收盘那一笔):照用;少得多就不要
    const fine = (count: number): Bar[] => Array.from({ length: count }, (_, i) => ({ sec: sec(DAY, OPEN_MINUTE + i * 5), open: 100, close: 100.1 }));
    expect(gridOf(sessions(fine(77)).get(DAY), 5)).toHaveLength(78);
    expect(gridOf(sessions(fine(70)).get(DAY), 5)).toBeNull();
  });
});

describe("日内方差分布", () => {
  it("合成数据按给定份额造:小时份额、半小时份额都估得回来", () => {
    const data = synth(tradingDays("2024-01-02", 600), 11);
    const model = calibrate({ ...data, ...META });
    const hours: number[] = [];
    for (let h = 0; h < 6; h += 1) hours.push(model.variance_weights[2 * h]! + model.variance_weights[2 * h + 1]!);
    hours.push(model.variance_weights[12]!);
    hours.forEach((v, i) => expect(Math.abs(v - TRUE_HOUR[i]!)).toBeLessThan(0.03));
    // 半小时的真值:所在小时的份额 × 它在那个小时里占的比例
    const truth = TRUE_HALF.map((w, i) => {
      if (i === 12) return TRUE_HOUR[6]!;
      const h = Math.floor(i / 2);
      return (TRUE_HOUR[h]! * w) / (TRUE_HALF[2 * h]! + TRUE_HALF[2 * h + 1]!);
    });
    model.variance_weights.forEach((v, i) => expect(Math.abs(v - truth[i]!)).toBeLessThan(0.03));
    expect(model.variance_weights).toHaveLength(HALF_HOURS);
    expect(model.variance_weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // 合成数据里实际方差就是按隐含水平造的
    expect(model.realized_to_implied).toBeGreaterThan(0.9);
    expect(model.realized_to_implied).toBeLessThan(1.1);
  });

  it("先按当天的隐含水平归一:一个波动四倍的日子不比平常日子多说一句话", () => {
    const calm = { date: "2026-01-05", minutes: [570, 630], grid: [100, 100.1, 100.1], level: 10 };
    // 同样的形状(全在第二个小时),波动大四倍、隐含水平也大四倍
    const wild = { date: "2026-01-06", minutes: [570, 630], grid: [100, 100, 100 * Math.exp(4 * Math.log(1.001))], level: 40 };
    const shares = varianceShares([calm, wild], 2, 60);
    expect(shares[0]).toBeCloseTo(0.5, 2);
    expect(shares[1]).toBeCloseTo(0.5, 2);
  });

  it("小时份额 × 小时之内的前后比例;最后那一桶本来就是半小时", () => {
    const fine = [3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 9].map((v) => v / 25);
    const out = halfHourWeights([0.4, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], fine);
    expect(out[0]).toBeCloseTo(0.3, 9);
    expect(out[1]).toBeCloseTo(0.1, 9);
    expect(out[11]).toBeCloseTo(0.075, 9);
    expect(out[12]).toBeCloseTo(0.1, 9);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(() => halfHourWeights([0.5, 0.5], fine)).toThrow(/个数不对/);
  });

  it("到某一分钟还剩几成:桶内按匀速走;开盘前是 1,收盘后是 0", () => {
    const w = [0.2, 0.1, ...new Array(10).fill(0.06), 0.1];
    expect(remainingShare(w, 9 * 60)).toBe(1);
    expect(remainingShare(w, OPEN_MINUTE)).toBe(1);
    expect(remainingShare(w, OPEN_MINUTE + 15)).toBeCloseTo(0.9, 9);
    expect(remainingShare(w, OPEN_MINUTE + 30)).toBeCloseTo(0.8, 9);
    expect(remainingShare(w, 15 * 60 + 45)).toBeCloseTo(0.05, 9);
    expect(remainingShare(w, 16 * 60)).toBe(0);
    expect(remainingShare(w, 17 * 60)).toBe(0);
  });
});

describe("IV 对走势的反应", () => {
  const rows = (n: number, beta: { a: number; b: number; c: number }, noise: number, seed: number): ResponseRow[] => {
    const next = rng(seed);
    return Array.from({ length: n }, (_, i) => {
      const u = 1.3 * normal(next);
      return { date: `d${Math.floor(i / 28)}`, u, share: 0.3, y: predict(beta, u) + noise * normal(next) };
    });
  };

  it("按给定的 a、b、c 造的数据:最小二乘估得回来", () => {
    const truth = { a: -0.01, b: -0.097, c: 0.025 };
    const fit = fitResponse(rows(8000, truth, 0.08, 3));
    expect(fit.a).toBeCloseTo(truth.a, 2);
    expect(fit.b).toBeCloseTo(truth.b, 2);
    expect(fit.c).toBeCloseTo(truth.c, 2);
  });

  it("没有噪声时 R² 是 1;「IV 不变」在有反应的数据上 R² 不是正的", () => {
    const truth = { a: 0, b: -0.1, c: 0.02 };
    const clean = rows(500, truth, 0, 5);
    expect(rSquared(clean, fitResponse(clean))).toBeCloseTo(1, 9);
    expect(rSquared(clean, null)).toBeLessThanOrEqual(0);
  });

  it("u 夹在 ±4:再远的样本按 4 算,不让几个极端日子把二次项带偏", () => {
    expect(U_MAX).toBe(4);
    const beta = { a: 0, b: -0.1, c: 0.02 };
    expect(predict(beta, -10)).toBe(predict(beta, -4));
    expect(predict(beta, 10)).toBe(predict(beta, 4));
  });

  it("样本太少、走势没有变化:拒,不给一份靠不住的系数", () => {
    expect(() => fitResponse(rows(10, { a: 0, b: -0.1, c: 0 }, 0.01, 1))).toThrow(/样本太少/);
    const still = Array.from({ length: 100 }, () => ({ date: "d", u: 0, share: 0.3, y: 0.01 }));
    expect(() => fitResponse(still)).toThrow(/没有变化/);
  });
});

describe("整套校准", () => {
  const days = tradingDays("2024-01-02", 600);
  const data = synth(days, 42);
  const model = calibrate({ ...data, ...META });

  it("样本的起止、天数、窗口数(每天 28 个)", () => {
    expect(model.period).toEqual({ from: days[0], to: days[599] });
    expect(model.days).toBe(600);
    expect(model.fit.rows).toBe(600 * 28);
    expect(model).toMatchObject({ source: "合成数据", proxy: "TEST1D", version: "2026-09-28" });
  });

  it("反应的斜率估得回来(合成数据里 b = −0.1);IV 指数自己的日内走法被减掉了,不算进反应里", () => {
    expect(Math.abs(model.response.b - TRUE.b)).toBeLessThan(0.02);
    expect(Math.abs(model.response.c)).toBeLessThan(0.01);
    expect(Math.abs(model.response.a)).toBeLessThan(0.01);
  });

  it("长一档期限的反应更弱(合成数据里是一半)", () => {
    expect(model.response_long).not.toBeNull();
    expect(model.response_long!.days).toBe(9);
    expect(Math.abs(model.response_long!.b - 0.5 * TRUE.b)).toBeLessThan(0.015);
    expect(calibrate({ ...data, ivLongHourly: undefined, ...META }).response_long).toBeNull();
  });

  it("前七成拟合、后三成检验:两段不重叠,样本外比「IV 不变」强", () => {
    expect(model.fit.train).toEqual({ from: days[0], to: days[419], days: 420 });
    expect(model.fit.test).toEqual({ from: days[420], to: days[599], days: 180 });
    expect(model.fit.r2_out).toBeGreaterThan(0.8);
    expect(model.fit.r2_out_flat).toBeLessThanOrEqual(0.01);
    expect(model.fit.r2_in).toBeGreaterThan(0.8);
  });

  it("噪声越大,残差越宽、R² 越低", () => {
    const noisy = calibrate({ ...synth(days, 42, { noise: 0.06 }), ...META });
    expect(noisy.resid_k).toBeGreaterThan(model.resid_k);
    expect(noisy.fit.r2_out).toBeLessThan(model.fit.r2_out);
  });

  it("「半数情况下」的区间名副其实:在样本里盖住的是一半上下", () => {
    expect(model.fit.coverage_half).toBeGreaterThan(0.42);
    expect(model.fit.coverage_half).toBeLessThan(0.58);
  });

  it("残差的宽度:√份额 × (base + slope·|u|);|u| 同样夹在 4 以内,倍数不会是负的", () => {
    const m = { resid_k: 0.16, resid_move: { base: 0.9, slope: 0.2 } };
    expect(residualSd(m, 0.25, 0)).toBeCloseTo(0.16 * 0.5 * 0.9, 9);
    expect(residualSd(m, 0.25, -2)).toBeCloseTo(0.16 * 0.5 * 1.3, 9);
    expect(residualSd(m, 0.25, 2)).toBe(residualSd(m, 0.25, -2));
    expect(residualSd(m, 0.25, 9)).toBe(residualSd(m, 0.25, 4));
    expect(residualSd(m, 0, 1)).toBe(0);
    expect(residualSd({ resid_k: 0.16, resid_move: { base: 0.5, slope: -1 } }, 0.25, 3)).toBeGreaterThan(0);
    expect(QUARTILE).toBeCloseTo(0.6745, 4);
  });

  it("IV 指数除第一根外的开盘价是错的(合成时故意造错):结果不受影响——只用收盘价", () => {
    const fixed = { ...data, ivHourly: data.ivHourly.map((b, i) => (i % HOURS === 0 ? b : { ...b, open: b.close })) };
    expect(calibrate({ ...fixed, ...META }).response).toEqual(model.response);
  });

  it("已经有半小时份额时直接给:不看 5 分钟线(分段核对时 5 分钟线盖不到那一段)", () => {
    const part = calibrate({ ...data, priceFine: [], fineShares: TRUE_HALF, ...META });
    expect(part.variance_weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(Math.abs(part.response.b - model.response.b)).toBeLessThan(1e-9);
  });

  it("数据不够:说清楚缺的是什么", () => {
    const few = synth(tradingDays("2026-01-05", 40), 1, { fineFrom: 0 });
    expect(() => calibrate({ ...few, ...META })).toThrow(/只有 40 天,不够校准/);
    expect(() => calibrate({ ...data, priceFine: data.priceFine.slice(0, 78 * 5), ...META })).toThrow(/5 分钟线只有 5 天可用/);
    expect(() => calibrate({ ...data, ivHourly: [], ...META })).toThrow(/只有 0 天/);
  });
});

describe("自己攒的当日到期期权 IV", () => {
  const WEIGHTS = TRUE_HALF.map((w, i) => {
    if (i === 12) return TRUE_HOUR[6]!;
    const h = Math.floor(i / 2);
    return (TRUE_HOUR[h]! * w) / (TRUE_HALF[2 * h]! + TRUE_HALF[2 * h + 1]!);
  });
  const MODEL = { variance_weights: WEIGHTS, response: { a: 0, b: -0.05, c: 0 } };
  const B = -0.15;
  const YEAR_MIN = 365 * 24 * 60;

  /**
   * 合成一段记录:五分钟一笔,09:35 到 15:55。每条腿的 IV = 全天标准差 × √(还剩几成 ÷ 剩余年数) × 偏斜 × exp(B·累计走势) × 噪声。
   * 前一项就是"没有消息时 IV 自己的日内走法";行权价一整天不换。
   */
  function record(days: string[], seed: number, opts: { noise?: number; b?: number } = {}): OwnSample[] {
    const next = rng(seed), out: OwnSample[] = [];
    for (const date of days) {
      const daySigma = 0.004 + 0.003 * next();
      let spot = 7700 + 100 * next();
      const open = spot, anchor = Math.round(spot / 5) * 5;
      const strikes = [-75, -50, -25, -10, 0, 10, 25, 50, 75].map((o) => anchor + o);
      for (let minute = OPEN_MINUTE + 5; minute < 16 * 60; minute += 5) {
        const share = remainingShare(WEIGHTS, minute - 5) - remainingShare(WEIGHTS, minute);
        spot *= Math.exp(daySigma * Math.sqrt(share) * normal(next));
        const level = daySigma * Math.sqrt(remainingShare(WEIGHTS, minute) / ((16 * 60 - minute) / YEAR_MIN));
        const cum = Math.log(spot / open) / daySigma;
        out.push({
          t: sec(date, minute) * 1000, spot, expiry: date.replace(/-/g, ""),
          legs: strikes.flatMap((strike) => {
            const iv = level * (1 + (anchor - strike) / 2000) * Math.exp((opts.b ?? B) * cum + (opts.noise ?? 0.01) * normal(next));
            return strike === anchor
              ? [{ strike, right: "P", iv }, { strike, right: "C", iv }]
              : [{ strike, right: strike < anchor ? "P" : "C", iv }];
          }),
        });
      }
    }
    return out;
  }
  /** 合成数据里 IV 自己的日内走法:ln √(还剩几成 ÷ 剩余时间),相对 10:00 */
  const truthDrift = (minute: number): number => {
    const level = (m: number): number => 0.5 * Math.log(remainingShare(WEIGHTS, m) / (16 * 60 - m));
    return level(minute) - level(10 * 60);
  };

  const days = tradingDays("2026-10-01", 80);
  const samples = record(days, 7);
  const own = fitFromSamples(samples, MODEL);

  it("样本的起止、天数;每天 12 个半小时点、两两成对", () => {
    expect(own.period).toEqual({ from: days[0], to: days[79] });
    expect(own.days).toBe(80);
    expect(own.rows).toBe(80 * ((OWN_GRID_POINTS * (OWN_GRID_POINTS - 1)) / 2));
    expect(own.drift).toHaveLength(OWN_GRID_POINTS);
    expect(own.drift[0]).toBe(0);
  });

  it("IV 自己的日内走法估得回来(合成数据里它就是 √(还剩几成 ÷ 剩余时间))", () => {
    for (let g = 1; g < OWN_GRID_POINTS; g += 1) {
      expect(Math.abs(own.drift[g]! - truthDrift(10 * 60 + g * 30))).toBeLessThan(0.03);
    }
  });

  it("对走势的反应估得回来(合成数据里 b = −0.15),样本外的 R² 高;比指数那一份(b = −0.05)强", () => {
    expect(Math.abs(own.response.b - B)).toBeLessThan(0.03);
    expect(Math.abs(own.response.c)).toBeLessThan(0.02);
    expect(own.fit.r2_out).toBeGreaterThan(0.7);
    expect(own.fit.r2_out).toBeGreaterThan(own.fit.r2_out_index);
    expect(own.fit.coverage_half).toBeGreaterThan(0.4);
    expect(own.fit.coverage_half).toBeLessThan(0.6);
    expect(ownIsBetter(own)).toBe(true);
  });

  it("估出来不比指数那一份强:不换", () => {
    // 期权的 IV 几乎全是噪声:自己这一份在留出的那一段上站不住
    const noisy = fitFromSamples(record(days, 9, { noise: 0.4, b: -0.02 }), { ...MODEL, response: { a: 0, b: -0.02, c: 0 } });
    expect(noisy.fit.r2_out).toBeLessThan(0.1);
    expect(ownIsBetter(noisy)).toBe(false);
    const tie: OwnFit = { ...own, fit: { ...own.fit, r2_out: 0.3, r2_out_index: 0.35 } };
    expect(ownIsBetter(tie)).toBe(false);
  });

  it("只认当日到期、常规时段里的样本;IV 不是正经数的腿不要", () => {
    const junk: OwnSample[] = [
      ...samples.slice(0, 50).map((s) => ({ ...s, expiry: "20270115" })), // 不是当日到期
      { ...samples[0]!, t: sec(days[0]!, 8 * 60) * 1000 }, // 开盘之前
      { ...samples[0]!, legs: samples[0]!.legs.map((l) => ({ ...l, iv: null })) },
      { ...samples[0]!, legs: samples[0]!.legs.map((l) => ({ ...l, iv: 9 })) },
    ];
    expect(fitFromSamples([...samples, ...junk], MODEL)).toEqual(own);
  });

  it("缺了几笔不要紧:每个半小时点取前后四分钟之内最近的那一笔", () => {
    const thinned = samples.filter((_, i) => i % 7 !== 3);
    const fit = fitFromSamples(thinned, MODEL);
    expect(fit.days).toBe(80);
    expect(Math.abs(fit.response.b - B)).toBeLessThan(0.03);
  });

  it("不够就拒:天数不够、一天里点太少", () => {
    expect(() => fitFromSamples(record(tradingDays("2026-10-01", OWN_MIN_DAYS - 1), 3), MODEL)).toThrow(/只有 39 天,不够\(至少 40 天\)/);
    // 每天只记了一个小时
    const short = samples.filter((s) => { const m = new Date(s.t).getUTCHours(); return m === 14; });
    expect(() => fitFromSamples(short, MODEL)).toThrow(/只有 0 天/);
    expect(() => fitFromSamples([], MODEL)).toThrow(/只有 0 天/);
  });

  it("日内走法取值:网格之间线性插值,两头之外取端点", () => {
    const d = { drift: [0, 0.1, 0.3] };
    expect(ownDriftAt(d, 9 * 60)).toBe(0);
    expect(ownDriftAt(d, 10 * 60)).toBe(0);
    expect(ownDriftAt(d, 10 * 60 + 15)).toBeCloseTo(0.05, 9);
    expect(ownDriftAt(d, 10 * 60 + 45)).toBeCloseTo(0.2, 9);
    expect(ownDriftAt(d, 11 * 60)).toBe(0.3);
    expect(ownDriftAt(d, 15 * 60)).toBe(0.3);
  });
});

describe("随软件带的那一份", () => {
  const m = FLY_IV_MODEL;

  it("形状:13 个半小时份额,都是正数,和为 1", () => {
    expect(m.variance_weights).toHaveLength(HALF_HOURS);
    for (const w of m.variance_weights) expect(w).toBeGreaterThan(0.01);
    expect(m.variance_weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("样本够长:至少一年的交易日;写明起止、来源、用的是哪个指数", () => {
    expect(m.days).toBeGreaterThanOrEqual(250);
    expect(m.period.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(m.period.to > m.period.from).toBe(true);
    expect(m.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(m.source.length).toBeGreaterThan(0);
    expect(m.proxy.length).toBeGreaterThan(0);
  });

  it("方向:跌则 IV 升(b < 0),走得越远越不对称(c > 0);长一档期限的反应更弱", () => {
    expect(m.response.b).toBeLessThan(0);
    expect(m.response.c).toBeGreaterThan(0);
    expect(Math.exp(predict(m.response, -2))).toBeGreaterThan(1.1);
    expect(Math.exp(predict(m.response, 1))).toBeLessThan(1);
    if (m.response_long) expect(Math.abs(m.response_long.b)).toBeLessThan(Math.abs(m.response.b));
  });

  it("检验:样本外的 R² 明显是正的,而且比「IV 不变」强——不然这份参数不该进定价", () => {
    expect(m.fit.r2_out).toBeGreaterThan(0.15);
    expect(m.fit.r2_out).toBeGreaterThan(m.fit.r2_out_flat + 0.1);
    expect(m.fit.test.from > m.fit.train.to).toBe(true);
  });

  it("区间名副其实:「半数情况下」在样本里盖住的是一半上下;走得越远残差越宽", () => {
    expect(m.fit.coverage_half).toBeGreaterThan(0.42);
    expect(m.fit.coverage_half).toBeLessThan(0.58);
    expect(m.resid_move.slope).toBeGreaterThan(0);
    expect(m.resid_move.base).toBeGreaterThan(0.5);
  });

  it("自己攒的那一份:要么还没有,要么过得了同样的底线", () => {
    if (m.own === null) return;
    expect(m.own.days).toBeGreaterThanOrEqual(OWN_MIN_DAYS);
    expect(m.own.drift).toHaveLength(OWN_GRID_POINTS);
    expect(ownIsBetter(m.own)).toBe(true);
    expect(m.own.response.b).toBeLessThan(0);
  });

  it("量级:残差宽度、实际与隐含之比都在说得通的范围里", () => {
    expect(m.resid_k).toBeGreaterThan(0.05);
    expect(m.resid_k).toBeLessThan(0.5);
    expect(m.realized_to_implied).toBeGreaterThan(0.3);
    expect(m.realized_to_implied).toBeLessThan(2);
  });
});
