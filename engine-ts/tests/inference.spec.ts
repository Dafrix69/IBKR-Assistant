/** 区间与检验(inference.ts):每个函数对着教科书上查得到的数。全部离线。 */
import { describe, expect, it } from "vitest";

import {
  clusteredDiffInterval, clusteredMeanInterval, clusteredWilsonInterval, incompleteBeta, logGamma, mannWhitneyZ, meanInterval, medianInterval,
  proportionDiffInterval, tCdf, tQuantile, welchInterval, wilsonInterval, Z95,
} from "../src/inference.js";
import type { Clustered } from "../src/inference.js";

/** t 密度从 0 积到 t(辛普森),给 tCdf 当一个不走 β 函数的对照。 */
function tCdfByIntegration(t: number, df: number): number {
  const pdf = (x: number): number =>
    (Math.exp(logGamma((df + 1) / 2) - logGamma(df / 2)) / Math.sqrt(df * Math.PI)) * (1 + (x * x) / df) ** (-(df + 1) / 2);
  const n = 20_000;
  const h = t / n;
  let acc = pdf(0) + pdf(t);
  for (let i = 1; i < n; i += 1) acc += (i % 2 ? 4 : 2) * pdf(i * h);
  return 0.5 + (acc * h) / 3;
}

describe("t 分布", () => {
  it("分位数对得上 t 表(双侧 95% 与 99%)", () => {
    const table: Array<[number, number]> = [[1, 12.7062], [2, 4.3027], [4, 2.7764], [9, 2.2622], [30, 2.0423], [120, 1.9799]];
    for (const [df, want] of table) expect(tQuantile(0.975, df)).toBeCloseTo(want, 4);
    expect(tQuantile(0.995, 10)).toBeCloseTo(3.1693, 4);
    expect(tQuantile(0.975, 1e6)).toBeCloseTo(Z95, 4); // 自由度很大时就是正态
    expect(tQuantile(0.025, 9)).toBeCloseTo(-2.2622, 4);
    expect(tQuantile(0.5, 3)).toBe(0);
  });

  it("累积概率:对称、和数值积分一致,自由度可以不是整数(Welch 的自由度就不是)", () => {
    expect(tCdf(0, 7)).toBe(0.5);
    expect(tCdf(2, 10)).toBeCloseTo(0.963306, 6);
    for (const [t, df] of [[1.3, 2.5], [3.1, 5.882], [0.4, 47.3]] as const) {
      expect(tCdf(t, df)).toBeCloseTo(tCdfByIntegration(t, df), 9);
      expect(tCdf(-t, df)).toBeCloseTo(1 - tCdf(t, df), 12);
      expect(tCdf(tQuantile(0.9, df), df)).toBeCloseTo(0.9, 10);
    }
  });

  it("底下的两块:ln Γ 与不完全 β", () => {
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12);
    expect(logGamma(10)).toBeCloseTo(Math.log(362_880), 10);
    expect(incompleteBeta(0.5, 2, 2)).toBeCloseTo(0.5, 12); // 对称
    expect(incompleteBeta(0.25, 1, 1)).toBeCloseTo(0.25, 12); // a = b = 1 是均匀分布
    expect([incompleteBeta(0, 2, 3), incompleteBeta(1, 2, 3)]).toEqual([0, 1]);
  });
});

describe("一组", () => {
  it("Wilson:5/10 → 23.7%–76.3%;贴着 0 或 1 也不出界", () => {
    const w = wilsonInterval(5, 10);
    expect([w?.lo, w?.hi].map((x) => Number(x?.toFixed(4)))).toEqual([0.2366, 0.7634]);
    expect(wilsonInterval(0, 6)?.hi).toBeCloseTo(0.3903, 4);
    expect(wilsonInterval(5, 5)).toMatchObject({ hi: 1 });
    expect(wilsonInterval(5, 5)?.lo).toBeCloseTo(0.5655, 4);
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it("平均数的 t 区间:1…5 → 3 ± 2.7764 × 0.7071", () => {
    const ci = meanInterval([1, 2, 3, 4, 5]);
    expect(ci?.mean).toBe(3);
    expect(ci?.lo).toBeCloseTo(1.0368, 4);
    expect(ci?.hi).toBeCloseTo(4.9632, 4);
    expect(meanInterval([7])).toBeNull();
  });

  it("中位数的精确区间:不到 6 个定不出 95%;6 个是最小到最大;10 个是第 2 到第 9;100 个是第 40 到第 61", () => {
    const seq = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
    expect(medianInterval(seq(5))).toBeNull();
    expect(medianInterval(seq(6))).toEqual({ lo: 1, hi: 6 });
    expect(medianInterval(seq(10))).toEqual({ lo: 2, hi: 9 });
    expect(medianInterval(seq(100))).toEqual({ lo: 40, hi: 61 });
    expect(medianInterval([9, 1, 5, 3, 7, 2, 8, 4, 10, 6])).toEqual({ lo: 2, hi: 9 }); // 不要求先排好
    expect(medianInterval([])).toBeNull();
  });
});

describe("两组", () => {
  it("Welch:[1…5] − [2,4,…,10] = −3,自由度 5.88,区间 −6.89 ~ +0.89(跨 0)", () => {
    const ci = welchInterval([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
    expect(ci?.diff).toBe(-3);
    // 标准误 √(0.5 + 2) = 1.5811;t(0.975, 5.882) = 2.4589
    expect(ci?.lo).toBeCloseTo(-3 - 2.4589 * 1.5811, 3);
    expect(ci?.hi).toBeCloseTo(-3 + 2.4589 * 1.5811, 3);
    expect(welchInterval([1], [2, 3])).toBeNull();
    // 置信水平收紧(Bonferroni 用):区间只会更宽
    const tight = welchInterval([1, 2, 3, 4, 5], [2, 4, 6, 8, 10], 0.995);
    expect((tight?.hi ?? 0) > (ci?.hi ?? 0)).toBe(true);
    // 两组都没有波动:差多少就是多少
    expect(welchInterval([5, 5, 5], [2, 2, 2])).toEqual({ diff: 3, lo: 3, hi: 3 });
  });

  it("Mann–Whitney:完全分开的 5 对 5 → z = −2.507;并列按平均秩并修正方差;全并列是 0", () => {
    expect(mannWhitneyZ([1, 2, 3, 4, 5], [6, 7, 8, 9, 10])).toBeCloseTo(-2.5067, 4);
    expect(mannWhitneyZ([6, 7, 8, 9, 10], [1, 2, 3, 4, 5])).toBeCloseTo(2.5067, 4);
    // 5 个 20 对 5 个 120:U = 0,方差 25/12 × (11 − 240/90) = 17.36 → (−12.5 + 0.5) / 4.1667
    expect(mannWhitneyZ([20, 20, 20, 20, 20], [120, 120, 120, 120, 120])).toBeCloseTo(-2.88, 4);
    expect(mannWhitneyZ([1, 1], [1, 1])).toBe(0);
    expect(mannWhitneyZ([], [1])).toBeNull();
    // 混进 NaN / 无穷:排不出秩,返回 null(而不是在数并列的那一圈里转不出来)
    expect(mannWhitneyZ([1, Number.NaN, 3], [2, 4])).toBeNull();
    expect(mannWhitneyZ([1, 2], [Number.POSITIVE_INFINITY])).toBeNull();
  });

  it("Newcombe:56/70 − 48/80 = 0.2,区间 0.0524 ~ 0.3339(Newcombe 1998 的例子)", () => {
    const ci = proportionDiffInterval(56, 70, 48, 80);
    expect(ci?.diff).toBeCloseTo(0.2, 12);
    expect(ci?.lo).toBeCloseTo(0.0524, 4);
    expect(ci?.hi).toBeCloseTo(0.3339, 4);
    expect(proportionDiffInterval(1, 0, 1, 2)).toBeNull();
  });
});

describe("成簇的观测:同一簇里的不当成几次独立的试验", () => {
  const each = (values: number[], prefix = "d"): Clustered[] => values.map((value, i) => ({ value, cluster: `${prefix}${i}` }));
  const days = (groups: number[][], prefix = "d"): Clustered[] =>
    groups.flatMap((g, i) => g.map((value) => ({ value, cluster: `${prefix}${i}` })));

  it("每簇一个观测时,和不分簇的三个函数逐位相同", () => {
    const a = [12, -7, 30, 4, -15, 22, 9];
    const b = [3, 45, -60, 18, 2];
    const m = clusteredMeanInterval(each(a));
    const plain = meanInterval(a);
    expect(m?.lo).toBeCloseTo(plain?.lo ?? 0, 10);
    expect(m?.hi).toBeCloseTo(plain?.hi ?? 0, 10);
    const d = clusteredDiffInterval(each(a, "a"), each(b, "b"));
    const welch = welchInterval(a, b);
    expect(d?.lo).toBeCloseTo(welch?.lo ?? 0, 10);
    expect(d?.hi).toBeCloseTo(welch?.hi ?? 0, 10);
    const hits = [true, false, true, true, false, false, true];
    expect(clusteredWilsonInterval(hits.map((hit, i) => ({ hit, cluster: `d${i}` })))).toEqual(wilsonInterval(4, 7));
  });

  it("平均数:三天 (10,20) (30) (40,50,60) → 平均 35,簇离差和 −40 / −5 / +45,方差 3/2 × 3650 / 36,t(2) = 4.3027", () => {
    const ci = clusteredMeanInterval(days([[10, 20], [30], [40, 50, 60]]));
    const half = 4.3027 * Math.sqrt((1.5 * 3650) / 36);
    expect(ci?.mean).toBe(35);
    expect(ci?.lo).toBeCloseTo(35 - half, 2);
    expect(ci?.hi).toBeCloseTo(35 + half, 2);
    // 比当成 6 个独立观测(±19.6)宽得多
    const naive = meanInterval([10, 20, 30, 40, 50, 60]);
    expect((ci?.hi ?? 0) - (ci?.lo ?? 0)).toBeGreaterThan(2 * ((naive?.hi ?? 0) - (naive?.lo ?? 0)));
  });

  it("簇内此消彼长(按簇算的方差更小)时不借它缩窄:不比当成独立的窄", () => {
    // 每天一赚一亏、合计都是 0:按簇的方差是 0,取大的那个 = 独立的 s²/N;自由度按簇数 − 1(更少),所以反而更宽
    const obs = days([[50, -50], [80, -80], [20, -20]]);
    const ci = clusteredMeanInterval(obs);
    const naive = meanInterval(obs.map((o) => o.value));
    expect((ci?.hi ?? 0) >= (naive?.hi ?? 0)).toBe(true);
    expect(ci?.mean).toBe(0);
  });

  it("全在一簇里:簇间的波动无从估起,平均数、两组之差、比例都返回 null;只有一个观测的比例照给", () => {
    expect(clusteredMeanInterval(days([[1, 2, 3, 4]]))).toBeNull();
    expect(clusteredDiffInterval(days([[1, 2, 3]], "a"), each([4, 5, 6], "b"))).toBeNull();
    expect(clusteredWilsonInterval([{ hit: true, cluster: "d" }, { hit: false, cluster: "d" }])).toBeNull();
    expect(clusteredWilsonInterval([{ hit: true, cluster: "d" }])).toEqual(wilsonInterval(1, 1));
    expect(clusteredWilsonInterval([])).toBeNull();
  });

  it("比例:同一天的结果一起赢一起输时,样本数按设计效应打折,区间比 Wilson(3, 6) 宽", () => {
    // 三天:(赢,赢) (输) (赢,输,输) → p = 0.5;簇离差和 +1 / −0.5 / −0.5 → 按簇 0.0625,独立 0.05 → 设计效应 1.25
    const obs = [[true, true], [false], [true, false, false]].flatMap((g, i) => g.map((hit) => ({ hit, cluster: `d${i}` })));
    const ci = clusteredWilsonInterval(obs);
    const want = wilsonInterval(3 / 1.25, 6 / 1.25);
    expect(ci?.lo).toBeCloseTo(want?.lo ?? 0, 10);
    expect(ci?.hi).toBeCloseTo(want?.hi ?? 0, 10);
    const plain = wilsonInterval(3, 6);
    expect((ci?.lo ?? 1) < (plain?.lo ?? 0) && (ci?.hi ?? 0) > (plain?.hi ?? 1)).toBe(true);
  });

  it("两组之差:两组同一天同涨同跌时不借它缩窄;此消彼长时照实变宽", () => {
    const a = days([[10], [30], [50], [70]]);
    const together = days([[0], [20], [40], [60]]); // 和 a 同一天、同涨同跌
    const against = days([[60], [40], [20], [0]]); // 和 a 同一天、此消彼长
    const apart = days([[0], [20], [40], [60]], "x"); // 不共簇:就是 Welch
    const welch = welchInterval([10, 30, 50, 70], [0, 20, 40, 60]);
    const width = (ci: { lo: number; hi: number } | null): number => (ci === null ? Number.NaN : ci.hi - ci.lo);
    expect(width(clusteredDiffInterval(a, apart))).toBeCloseTo(width(welch), 10);
    expect(width(clusteredDiffInterval(a, together))).toBeCloseTo(width(welch), 10);
    expect(width(clusteredDiffInterval(a, against))).toBeGreaterThan(width(welch) * 1.3);
    expect(clusteredDiffInterval(a, together)?.diff).toBe(10);
  });
});
