/** 夜盘用期货推算指数现价:选哪张合约、基差取哪一分钟、什么时候切换。
 *
 * SPX 只在常规时段计算,夜盘报的是昨收;期权却照常在跳。拿昨收去反解波动率、推断蝶的
 * 看涨看跌、挑行权价全是错的——所以这三件事必须钉死:
 *  1. 期货选到期日**严格晚于**今天的最近季月,到期日当天就换下一张;
 *  2. 基差用上一个常规时段**同一分钟**的两根 K 线相减,不是两个收盘价相减;
 *  3. 半日市、周末、节假日回到正确的那个收盘。
 */
import { describe, expect, it } from "vitest";

import { contemporaneousBasis, lastRthSession } from "../src/broker.js";
import { frontQuarterly, thirdFriday } from "../src/ibContracts.js";
import { etNowFromEpoch } from "../src/config.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");

describe("thirdFriday", () => {
  it.each([
    [2026, 9, "2026-09-18"], [2026, 12, "2026-12-18"], [2027, 3, "2027-03-19"],
    [2026, 5, "2026-05-15"], [2026, 1, "2026-01-16"],
  ])("%i-%i → %s", (y, m, expected) => {
    expect(thirdFriday(y, m)).toBe(expected);
  });
});

describe("frontQuarterly:到期日严格晚于今天的最近季月", () => {
  it.each([
    ["2026-09-10", "202609"], // 实测那天:ESU6,离到期 8 天
    ["2026-09-17", "202609"], // 到期前一天还用它
    ["2026-09-18", "202612"], // 到期日当天就换:09:30 按开盘价结算之后它不再跳
    ["2026-09-19", "202612"],
    ["2026-12-31", "202703"], // 跨年
    ["2026-01-02", "202603"],
  ])("%s → %s", (date, expected) => {
    expect(frontQuarterly(date)).toBe(expected);
  });
});

describe("lastRthSession:上一个已经收盘的常规时段", () => {
  const settings = makeSettings(g.base_config, {
    market_holidays: ["2026-09-07"],       // 劳动节(周一)
    early_close_days: ["2026-11-27"],      // 感恩节次日半日市
  });
  const at = (iso: string) => etNowFromEpoch(Date.parse(iso));

  it("夜里 02:10 → 前一个交易日的 16:00", () => {
    expect(lastRthSession(at("2026-09-10T02:10:00-04:00"), settings)).toEqual(["2026-09-09", 960]);
  });

  it("盘中 → 还是前一天(今天没收盘)", () => {
    expect(lastRthSession(at("2026-09-10T11:00:00-04:00"), settings)).toEqual(["2026-09-09", 960]);
  });

  it("当天收盘之后 → 就是今天", () => {
    expect(lastRthSession(at("2026-09-10T16:30:00-04:00"), settings)).toEqual(["2026-09-10", 960]);
  });

  it("周一凌晨 → 上周五", () => {
    expect(lastRthSession(at("2026-09-14T01:00:00-04:00"), settings)).toEqual(["2026-09-11", 960]);
  });

  it("节假日次日凌晨 → 跳过节假日回到上周五", () => {
    expect(lastRthSession(at("2026-09-08T01:00:00-04:00"), settings)).toEqual(["2026-09-04", 960]);
  });

  it("半日市收在 13:00,基差得取那一分钟", () => {
    expect(lastRthSession(at("2026-11-27T20:00:00-05:00"), settings)).toEqual(["2026-11-27", 780]);
  });
});

describe("contemporaneousBasis:同一分钟的两根 K 线", () => {
  it("取两边都有的最后那一分钟(2026-09-09 实测数据)", () => {
    const idx = [
      { time: "2026-09-09 15:58", close: 7638.1 },
      { time: "2026-09-09 15:59", close: 7637.7 },
    ];
    const fut = [
      { time: "2026-09-09 15:58", close: 7645.0 },
      { time: "2026-09-09 15:59", close: 7644.75 },
      { time: "2026-09-09 16:00", close: 7646.0 }, // 指数已收,期货还在跳:不能拿它
      { time: "2026-09-09 16:59", close: 7650.0 },
    ];
    const b = contemporaneousBasis(idx, fut)!;
    expect(b.time).toBe("2026-09-09 15:59");
    expect(b.basis).toBeCloseTo(7.05, 6);
  });

  it("最后一分钟期货没有 K 线 → 往前退到两边都有的那一分钟", () => {
    const idx = [
      { time: "15:58", close: 100 },
      { time: "15:59", close: 101 },
    ];
    const fut = [{ time: "15:58", close: 107 }];
    expect(contemporaneousBasis(idx, fut)!.basis).toBe(7);
  });

  it("一分钟都对不上 → null,不拿错开的价相减", () => {
    expect(contemporaneousBasis([{ time: "15:59", close: 100 }], [{ time: "16:59", close: 110 }])).toBeNull();
  });

  it("坏价(0 / NaN)不算数", () => {
    const idx = [{ time: "15:58", close: 100 }, { time: "15:59", close: 0 }];
    const fut = [{ time: "15:58", close: 107 }, { time: "15:59", close: Number.NaN }];
    expect(contemporaneousBasis(idx, fut)!.time).toBe("15:58");
  });
});
