/** 期权墙的纯计算(optionwall.ts)里不靠快照就能说对错的那几样:墙怎么挑、gamma 那几个数互不矛盾、缺数据读成「不知道」、
 * 到期时刻认不认开盘结算。黄金基线(golden-analysis.spec)只钉「没变」,这里钉「对」。
 */
import { describe, expect, it } from "vitest";

import { analyze, bsGamma, bsGexAt, gammaFlip, gexAt, gexSignConflict, toRows, yearsToExpiry } from "../src/optionwall.js";
import type { OptionRow } from "../src/optionwall.js";

const NOW = Date.parse("2026-09-01T10:00:00-04:00");
const EXPIRY = "20261001"; // 30 天又 6 小时之后
const T = yearsToExpiry(EXPIRY, NOW);

type Raw = { strike: number; right: "C" | "P"; oi?: number; volume?: number; gamma?: number | null; iv?: number | null };
const row = (r: Raw): Record<string, unknown> => ({ oi: 0, volume: 0, gamma: null, iv: 0.2, ...r });
/** 五档都有 IV(够算翻转位),未平仓量只给点名的那几行 */
const chain = (named: Raw[], strikes = [90, 95, 100, 105, 110]): Array<Record<string, unknown>> => {
  const out: Array<Record<string, unknown>> = [];
  for (const strike of strikes) {
    for (const right of ["C", "P"] as const) {
      out.push(row(named.find((n) => n.strike === strike && n.right === right) ?? { strike, right }));
    }
  }
  return out;
};

describe("墙:某一侧最大的那一档", () => {
  it("一样大的取离现价近的,和行的先后次序无关", () => {
    const raw = chain([
      { strike: 105, right: "C", oi: 500 }, { strike: 110, right: "C", oi: 500 },
      { strike: 90, right: "P", oi: 700 }, { strike: 95, right: "P", oi: 700 },
    ]);
    for (const rows of [raw, [...raw].reverse()]) {
      const wall = analyze(rows, 101, EXPIRY, "XYZ", 100, NOW);
      expect(wall.call_wall).toMatchObject({ strike: 105, size: 500 });
      expect(wall.put_wall).toMatchObject({ strike: 95, size: 700 });
    }
  });

  it("正好在现价上的那一档两边都不算:它不在头顶也不在脚下", () => {
    const raw = chain([
      { strike: 100, right: "C", oi: 9000, volume: 900 }, { strike: 100, right: "P", oi: 8000, volume: 800 },
      { strike: 105, right: "C", oi: 300, volume: 30 }, { strike: 95, right: "P", oi: 200, volume: 20 },
    ]);
    const wall = analyze(raw, 100, EXPIRY, "XYZ", 100, NOW);
    expect(wall.call_wall?.strike).toBe(105);
    expect(wall.put_wall?.strike).toBe(95);
    expect(wall.call_vol_wall?.strike).toBe(105);
    expect(wall.put_vol_wall?.strike).toBe(95);
    // 现价挪开一点,它就是那一侧的墙
    expect(analyze(raw, 99.5, EXPIRY, "XYZ", 100, NOW).call_wall?.strike).toBe(100);
    expect(analyze(raw, 100.5, EXPIRY, "XYZ", 100, NOW).put_wall?.strike).toBe(100);
  });

  it("那一侧没有未平仓量就没有墙", () => {
    const wall = analyze(chain([{ strike: 105, right: "C", oi: 10 }]), 100.2, EXPIRY, "XYZ", 100, NOW);
    expect(wall.put_wall).toBeNull();
  });
});

describe("gamma 翻转位", () => {
  it("已知答案:看跌只在 K1、看涨只在 K2、张数与 IV 相同 → 翻转位 = √(K1·K2)·e^(−σ²T/2)", () => {
    const raw = chain([{ strike: 95, right: "P", oi: 1000 }, { strike: 105, right: "C", oi: 1000 }]);
    const expected = Math.sqrt(95 * 105) * Math.exp((-0.2 * 0.2 * T) / 2);
    for (const spot of [97, 99.9, 103]) {
      const wall = analyze(raw, spot, EXPIRY, "XYZ", 100, NOW);
      expect(wall.gamma_flip).toBeCloseTo(expected, 2);
      // 翻转位在现价哪一侧,和净 GEX 的正负是同一件事:翻转位之下看跌的 gamma 占上风
      expect(wall.regime).toBe(spot < expected ? "negative" : "positive");
    }
  });

  it("有好几处变号:给离现价最近的那个,不是最低的那个;哪个方向变号都算", () => {
    // 从低到高:95 看跌占优(负)→ 100 看涨占优(正)→ 105 看跌占优(负)→ 110 看涨占优(正)
    const raw = chain([
      { strike: 95, right: "P", oi: 4000, iv: 0.03 }, { strike: 100, right: "C", oi: 4000, iv: 0.03 },
      { strike: 105, right: "P", oi: 4000, iv: 0.03 }, { strike: 110, right: "C", oi: 4000, iv: 0.03 },
    ].map((r) => ({ ...r, right: r.right as "C" | "P" })));
    const rows = toRows(raw);
    const strikes = [90, 95, 100, 105, 110];
    const lowest = gammaFlip(rows, strikes, 96, T) ?? 0;
    const middle = gammaFlip(rows, strikes, 103.5, T) ?? 0;
    const highest = gammaFlip(rows, strikes, 108.5, T) ?? 0;
    expect(lowest).toBeGreaterThan(95);
    expect(lowest).toBeLessThan(100);
    expect(middle).toBeGreaterThan(100);
    expect(middle).toBeLessThan(105); // 这一处是由正转负:照样算
    expect(highest).toBeGreaterThan(105);
    expect(highest).toBeLessThan(110);
    // 每一处都真的是零点:两边的正负相反(结果四舍五入到分,所以隔两分看)
    for (const x of [lowest, middle, highest]) {
      expect(bsGexAt(rows, x - 0.02, T).net * bsGexAt(rows, x + 0.02, T).net).toBeLessThan(0);
    }
  });

  it("取到的行权价范围里不变号:null,不外推", () => {
    const raw = chain([{ strike: 100, right: "C", oi: 1000 }, { strike: 105, right: "C", oi: 1000 }]);
    expect(analyze(raw, 101, EXPIRY, "XYZ", 100, NOW)).toMatchObject({ gamma_flip: null, regime: "positive", net_gex_ratio: 1 });
  });

  it("券商的模型 gamma 与 BS 在现价处正负对不上:不给翻转位,并说明原因", () => {
    // BS 看:现价 99 在翻转位(约 99.7)之下,净额为负;券商给的模型 gamma 却让看涨那一行大得多 → 净额为正
    const named: Raw[] = [{ strike: 95, right: "P", oi: 1000 }, { strike: 105, right: "C", oi: 1000 }];
    const agree = analyze(chain(named), 99, EXPIRY, "XYZ", 100, NOW);
    expect(agree.regime).toBe("negative");
    expect(agree.gamma_flip).not.toBeNull();

    const tilted = chain(named.map((r) => (r.right === "C" ? { ...r, gamma: 0.5 } : r)));
    expect(gexSignConflict(toRows(tilted), 99, T)).toBe(true);
    const wall = analyze(tilted, 99, EXPIRY, "XYZ", 100, NOW);
    expect(wall.regime).toBe("positive");
    expect(wall.gamma_flip).toBeNull();
    expect(wall.warnings.some((w) => w.startsWith("gamma 翻转位不给"))).toBe(true);
    // 模型 gamma 只是把大小改了、没改正负:翻转位照给,还是 BS 那条曲线上的那个
    const scaled = chain(named.map((r) => ({ ...r, gamma: 1.5 * bsGamma(99, r.strike, T, 0.2) })));
    expect(analyze(scaled, 99, EXPIRY, "XYZ", 100, NOW).gamma_flip).toBe(agree.gamma_flip);
    // 曲线上本来就没有变号处(BS 看全是看涨),正负又对不上:没有翻转位是因为没有变号处,不写「对不上所以不给」
    const oneSided = chain([
      { strike: 100, right: "C", oi: 1000, gamma: 0.001 }, { strike: 100, right: "P", oi: 100, gamma: 0.05 },
      { strike: 105, right: "C", oi: 1000, gamma: 0.001 }, { strike: 105, right: "P", oi: 100, gamma: 0.05 },
    ]);
    const flat = analyze(oneSided, 100.2, EXPIRY, "XYZ", 100, NOW);
    expect(flat).toMatchObject({ regime: "negative", gamma_flip: null });
    expect(flat.warnings.some((w) => w.startsWith("gamma 翻转位不给"))).toBe(false);
  });
});

describe("净 GEX:现在是正是负,缺数据读成不知道", () => {
  it("现价处用券商的模型 gamma;没给的行用 BS", () => {
    const rows: OptionRow[] = [
      { strike: 100, right: "C", oi: 10, oiMissing: false, volume: 0, gamma: 0.02, iv: 0.2 },
      { strike: 100, right: "P", oi: 4, oiMissing: false, volume: 0, gamma: null, iv: 0.2 },
    ];
    const unit = 100 * 101 * 101 * 0.01;
    const gex = gexAt(rows, 101, T);
    expect(gex.net).toBeCloseTo((0.02 * 10 - bsGamma(101, 100, T, 0.2) * 4) * unit, 6);
    expect(gex.gross).toBeCloseTo((0.02 * 10 + bsGamma(101, 100, T, 0.2) * 4) * unit, 6);
    expect(gex.rows).toBe(2);
  });

  it("净额 ÷ 总量:只有看涨是 +1,只有看跌是 −1,正好抵消是 0(neutral)", () => {
    const only = (right: "C" | "P") => analyze(chain([{ strike: 100, right, oi: 500 }]), 100.5, EXPIRY, "XYZ", 100, NOW);
    expect(only("C")).toMatchObject({ regime: "positive", net_gex_ratio: 1 });
    expect(only("P")).toMatchObject({ regime: "negative", net_gex_ratio: -1 });
    const even = analyze(chain([{ strike: 100, right: "C", oi: 500 }, { strike: 100, right: "P", oi: 500 }]), 100.5, EXPIRY, "XYZ", 100, NOW);
    expect(even).toMatchObject({ regime: "neutral", net_gex: 0, net_gex_ratio: 0 });
    expect(even.gross_gex ?? 0).toBeGreaterThan(0);
    expect(even.readout.some((l) => l.startsWith("净 GEX 0:"))).toBe(true);
  });

  it("比例照实给,不设「多小算中性」的门槛:差一点点也有正负", () => {
    const wall = analyze(chain([{ strike: 100, right: "C", oi: 1000 }, { strike: 100, right: "P", oi: 990 }]), 100.5, EXPIRY, "XYZ", 100, NOW);
    expect(wall.regime).toBe("positive");
    expect(wall.net_gex_ratio).toBeCloseTo(10 / 1990, 4);
  });

  it("链上既没有 IV 也没有模型 gamma:unknown,净 GEX 是 null 不是 0,也不读成「正」", () => {
    const raw = chain([{ strike: 105, right: "C", oi: 800 }, { strike: 95, right: "P", oi: 900 }]).map((r) => ({ ...r, iv: null }));
    const wall = analyze(raw, 100.5, EXPIRY, "XYZ", 100, NOW);
    expect(wall).toMatchObject({ regime: "unknown", net_gex: null, gross_gex: null, net_gex_ratio: null, gamma_flip: null, has_greeks: false });
    expect(wall.readout.some((l) => l.includes("不知道"))).toBe(true);
    expect(wall.readout.some((l) => l.includes("做市商多头 gamma"))).toBe(false);
    // 墙与最大痛点不靠 gamma,照给
    expect(wall.call_wall?.strike).toBe(105);
    expect(wall.max_pain).not.toBeNull();
  });

  it("有 gamma、未平仓量全是 0:什么都没称出来,是不知道,不是「看涨看跌正好抵消」", () => {
    const raw = chain([]).map((r) => ({ ...r, gamma: 0.005, volume: 120 }));
    const wall = analyze(raw, 100.5, EXPIRY, "XYZ", 100, NOW);
    expect(wall).toMatchObject({ regime: "unknown", net_gex: null, gross_gex: null, net_gex_ratio: null, gamma_flip: null, oi_missing: 0 });
    expect(wall.readout.some((l) => l.includes("正好抵消"))).toBe(false);
    expect(wall.warnings.some((w) => w.startsWith("有 gamma,但没有未平仓量可称"))).toBe(true);
    expect(wall.strikes.every((s) => s.net_gex === 0)).toBe(true);
  });

  it("没等到未平仓量的行(oi 是 null)不当成 0 张:缺了几行数得出来、说得出来;全缺就是不知道", () => {
    const named: Raw[] = [{ strike: 105, right: "C", oi: 800 }, { strike: 95, right: "P", oi: 900 }, { strike: 100, right: "C", oi: 50 }];
    const partly = chain(named).map((r) => (r["strike"] === 105 ? { ...r, oi: null } : r));
    expect(toRows(partly).filter((r) => r.oiMissing)).toHaveLength(2);
    const wall = analyze(partly, 100.5, EXPIRY, "XYZ", 100, NOW);
    expect(wall.oi_missing).toBe(2);
    expect(wall.call_wall).toBeNull(); // 上方唯一有量的那一行没等到:不拿 0 去比
    expect(wall.regime).toBe("negative");
    expect(wall.warnings.some((w) => w.startsWith("有 2 行没等到未平仓量"))).toBe(true);

    const none = analyze(chain(named).map((r) => ({ ...r, oi: undefined })), 100.5, EXPIRY, "XYZ", 100, NOW);
    expect(none).toMatchObject({ regime: "unknown", net_gex: null, oi_missing: 10, call_wall: null, put_wall: null });
    // 到齐了的链:0
    expect(analyze(chain(named), 100.5, EXPIRY, "XYZ", 100, NOW).oi_missing).toBe(0);
  });

  it("只有模型 gamma、没有 IV:净 GEX 照算,翻转位算不出(标的挪到别处的 gamma 要靠 IV 重算)", () => {
    const raw = chain([{ strike: 105, right: "C", oi: 800, gamma: 0.01 }, { strike: 95, right: "P", oi: 900, gamma: 0.02 }])
      .map((r) => ({ ...r, iv: null }));
    const wall = analyze(raw, 100.5, EXPIRY, "XYZ", 100, NOW);
    expect(wall).toMatchObject({ regime: "negative", has_greeks: false, gamma_flip: null });
    expect(wall.net_gex).toBeCloseTo((0.01 * 800 - 0.02 * 900) * 100 * 100.5 * 100.5 * 0.01, -1);
  });

  it("读数那句话把假设写在数旁边", () => {
    const wall = analyze(chain([{ strike: 100, right: "P", oi: 500 }]), 100.5, EXPIRY, "XYZ", 100, NOW);
    const line = wall.readout.find((l) => l.startsWith("净 GEX")) ?? "";
    expect(line).toContain("按「做市商多头 call、空头 put」的假设");
    expect(line).toContain("净额占总 gamma 的 100.0%");
  });
});

describe("距到期多久:到期时刻的规则和持仓定价是同一份(ivPricing.expiryEpochMs)", () => {
  const morning = Date.parse("2026-09-18T08:00:00-04:00");
  const hours = (years: number): number => years * 365 * 24;

  it("日到期与个股:到期日美东 16:00", () => {
    expect(hours(yearsToExpiry("20260918", morning, "SPX", "SPXW"))).toBeCloseTo(8, 9);
    expect(hours(yearsToExpiry("20260918", morning, "AAPL", ""))).toBeCloseTo(8, 9);
    expect(hours(yearsToExpiry("20260918", morning))).toBeCloseTo(8, 9);
  });

  it("按开盘价结算的月度指数期权(交易类别和代码相同):合约上记的是最后交易日,下一个工作日 09:30 到期", () => {
    // 券商给月度类记的是第三个周五的前一个交易日(20260917,周四);它按周五的开盘价结算
    expect(hours(yearsToExpiry("20260917", morning, "SPX", "SPX"))).toBeCloseTo(1.5, 9);
    // 最后交易日当天早上:还有一整天加一个隔夜,不是"一开盘就到期"
    expect(hours(yearsToExpiry("20260917", Date.parse("2026-09-17T08:00:00-04:00"), "SPX", "SPX"))).toBeCloseTo(25.5, 9);
    // 同一条链走到 analyze:距到期的天数跟着变
    const raw = chain([{ strike: 100, right: "C", oi: 1 }]);
    expect(analyze(raw, 100.5, "20260917", "SPX", 100, morning, "SPX").days_to_expiry).toBeCloseTo(1.5 / 24, 2);
    expect(analyze(raw, 100.5, "20260918", "SPX", 100, morning, "SPXW").days_to_expiry).toBeCloseTo(8 / 24, 2);
  });

  it("这几个指数没给交易类别:认不出是哪一种,按 16:00", () => {
    expect(hours(yearsToExpiry("20260918", morning, "SPX", ""))).toBeCloseTo(8, 9);
  });

  it("过了到期时刻、日期写错:都落在下限上,不出负数", () => {
    const floor = 1 / (365 * 24);
    expect(yearsToExpiry("20260917", Date.parse("2026-09-18T12:00:00-04:00"), "SPX", "SPX")).toBe(floor);
    expect(yearsToExpiry("20260231", morning, "SPX", "SPXW")).toBe(floor);
    expect(yearsToExpiry("bogus", morning)).toBe(floor);
  });
});
