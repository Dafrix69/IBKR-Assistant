/** 跨市场跟跌套利(crossMarket.ts):美股大跌而韩股 / A 股的美股 ETF 没同步跌 → 开盘补跌 → P0 提醒。全部离线。
 *
 * 钉住:
 *  1. 窗口:从这一天美股开盘 09:30 起(盘中就报)到 A 股开盘后一小时;周五的挂到周一开盘(周末里也在窗口里);
 *     两个市场的开盘取同一个日历日的早上;下一次开盘的算法(周末顺延、开盘后一小时宽限)。
 *  2. 判定:差 = ETF − 指数;跌的时候 ETF 少跌 ≥ lag_pct 才算没跟;跟上了(差小、或跌得更多)不报;量不到 ETF 的那个市场跳过;
 *     两个市场只要一个没跟就报,挂在没跟的市场里最早开的那个上;涨那一侧对称。
 *  3. 事件的样子:标题带指数与 ETF 的涨跌,note 带差了几个点与可做的 ETF,cross 里有逐市场的明细。
 */
import { describe, expect, it } from "vitest";

import { CROSS_SYMBOLS, crossWindow, evaluateCrossMarket, nextOpen, usSessionStart } from "../src/crossMarket.js";

const MIN = 60_000;
const KR = "+09:00";
const CN = "+08:00";
const CFG = { pct: 1.5, lag_pct: 1 };

function quotes(over: Record<string, number | null> = {}): Record<string, { symbol: string; last: number | null; change_pct: number | null }> {
  const base: Record<string, number | null> = { EWY: -0.4, KORU: -1.3, ASHR: -2.6, FXI: -2.4, KWEB: -3.1, YINN: -7.4, ...over };
  const out: Record<string, { symbol: string; last: number | null; change_pct: number | null }> = {};
  for (const [symbol, pct] of Object.entries(base)) out[symbol] = { symbol, last: 50, change_pct: pct };
  return out;
}

const iso = (t: number | undefined): string => (t === undefined ? "" : new Date(t).toISOString());

describe("窗口与下一次开盘", () => {
  it("下一次开盘:当天还没到就是当天,过了就是明天,周末顺延到周一;开盘后一小时内的宽限", () => {
    expect(nextOpen(Date.parse("2026-10-14T12:00:00+09:00"), KR, "09:00")).toBe(Date.parse("2026-10-15T09:00:00+09:00"));
    expect(nextOpen(Date.parse("2026-10-14T08:00:00+09:00"), KR, "09:00")).toBe(Date.parse("2026-10-14T09:00:00+09:00"));
    expect(nextOpen(Date.parse("2026-10-17T10:00:00+09:00"), KR, "09:00")).toBe(Date.parse("2026-10-19T09:00:00+09:00"));
    expect(nextOpen(Date.parse("2026-10-14T09:30:00+08:00"), CN, "09:30", 60 * MIN)).toBe(Date.parse("2026-10-14T09:30:00+08:00"));
  });

  it("对应的美股交易日开盘:A 股周四早上开盘对应周三 09:30 美东;周一早上对应上周五", () => {
    expect(iso(usSessionStart(Date.parse("2026-10-15T09:30:00+08:00")))).toBe(iso(Date.parse("2026-10-14T09:30:00-04:00")));
    expect(iso(usSessionStart(Date.parse("2026-10-19T09:30:00+08:00")))).toBe(iso(Date.parse("2026-10-16T09:30:00-04:00")));
    // 冬令时:A 股开盘是美东 20:30,照样是同一个美东日
    expect(iso(usSessionStart(Date.parse("2026-11-12T09:30:00+08:00")))).toBe(iso(Date.parse("2026-11-11T09:30:00-05:00")));
  });

  it("周三从 09:30 美东起在窗口里(盘中就报),09:00 还不在;A 股开了一个多小时就不在了", () => {
    const w = crossWindow(Date.parse("2026-10-14T11:00:00-04:00"));
    expect(w?.opens.map((o) => `${o.key}@${iso(o.at)}`)).toEqual(["kr@2026-10-15T00:00:00.000Z", "cn@2026-10-15T01:30:00.000Z"]);
    expect(iso(w?.start)).toBe(iso(Date.parse("2026-10-14T09:30:00-04:00")));
    expect(crossWindow(Date.parse("2026-10-14T09:00:00-04:00"))).toBeNull();
    expect(crossWindow(Date.parse("2026-10-14T22:00:00-04:00"))?.first).toBe(Date.parse("2026-10-15T09:00:00+09:00"));
    expect(crossWindow(Date.parse("2026-10-14T23:00:00-04:00"))).toBeNull();
  });

  it("韩股刚开、A 股还没开的那半小时:两个开盘仍是同一天早上的", () => {
    const w = crossWindow(Date.parse("2026-10-14T20:40:00-04:00"));
    expect(w?.opens.map((o) => iso(o.at))).toEqual(["2026-10-15T00:00:00.000Z", "2026-10-15T01:30:00.000Z"]);
  });

  it("周五的挂到周一开盘:周五盘中、周六都在窗口里,起点是周五 09:30", () => {
    const fri = crossWindow(Date.parse("2026-10-16T15:30:00-04:00"));
    expect(fri?.opens.map((o) => iso(o.at))).toEqual(["2026-10-19T00:00:00.000Z", "2026-10-19T01:30:00.000Z"]);
    expect(iso(fri?.start)).toBe(iso(Date.parse("2026-10-16T09:30:00-04:00")));
    expect(crossWindow(Date.parse("2026-10-17T10:00:00-04:00"))).not.toBeNull();
    expect(crossWindow(Date.parse("2026-10-18T23:00:00-04:00"))).toBeNull(); // 周一 A 股开了一个多小时(美东周日 22:30 之后)
  });

  it("要报价的 ETF 清单写死在代码里", () => {
    expect([...CROSS_SYMBOLS]).toEqual(["EWY", "KORU", "ASHR", "FXI", "KWEB", "YINN"]);
  });
});

describe("判定", () => {
  const NOW = Date.parse("2026-10-14T11:30:00-04:00"); // 美股盘中

  it("美股 −2.5%,EWY 只跌 0.4%(差 2.1 点),ASHR 跌了 2.6%(跟上了):只报韩股,挂在韩股开盘上", () => {
    const e = evaluateCrossMarket(-2.5, quotes(), NOW, CFG);
    expect(e).not.toBeNull();
    expect(e!.id).toBe("cross:2026-10-14:down");
    expect(e!.kind).toBe("cross");
    expect(e!.title).toBe("美股 −2.5%,韩股 ETF 没跟跌:开盘可能补跌");
    expect(e!.at).toBe(Date.parse("2026-10-15T09:00:00+09:00"));
    expect(`${e!.date_et} ${e!.time_et}`).toBe("2026-10-14 20:00");
    expect(e!.linger_min).toBe(90 + 60); // 到 A 股开盘还有 90 分钟,再加一小时
    expect(e!.note).toContain("韩股 EWY −0.4%(差 2.1 点)");
    expect(e!.note).toContain("做空");
    expect(e!.note).toContain("EWY / KORU");
    expect(e!.cross).toMatchObject({ direction: "down", us_pct: -2.5 });
    expect(e!.cross?.markets.map((m) => `${m.key}:${m.symbol}:${m.etf_pct}:${m.gap}`)).toEqual(["kr:EWY:-0.4:2.1"]);
    expect(e!.cross?.markets[0]?.instruments.map((i) => `${i.symbol}=${i.change_pct}`)).toEqual(["EWY=-0.4", "KORU=-1.3"]);
  });

  it("两个市场都没跟:都报,挂在最早开的那个上,标题写两个名字", () => {
    const e = evaluateCrossMarket(-2.5, quotes({ ASHR: -0.9 }), NOW, CFG);
    expect(e?.title).toBe("美股 −2.5%,韩股 / A 股 ETF 没跟跌:开盘可能补跌");
    expect(e?.cross?.markets.map((m) => m.key)).toEqual(["kr", "cn"]);
    expect(e?.at).toBe(Date.parse("2026-10-15T09:00:00+09:00"));
    expect(e?.note).toContain("ASHR −0.9%(差 1.6 点)");
  });

  it("ETF 跟上了(差不到 1 点)、或跌得比指数还多:不报;美股没大动不报;量不到 ETF 的市场跳过", () => {
    expect(evaluateCrossMarket(-2.5, quotes({ EWY: -1.8 }), NOW, CFG)).toBeNull();
    expect(evaluateCrossMarket(-2.5, quotes({ EWY: -3.2 }), NOW, CFG)).toBeNull();
    expect(evaluateCrossMarket(-1.2, quotes(), NOW, CFG)).toBeNull();
    expect(evaluateCrossMarket(null, quotes(), NOW, CFG)).toBeNull();
    expect(evaluateCrossMarket(-2.5, quotes({ EWY: null }), NOW, CFG)).toBeNull();
    expect(evaluateCrossMarket(-2.5, quotes({ EWY: null, ASHR: -0.5 }), NOW, CFG)?.cross?.markets.map((m) => m.key)).toEqual(["cn"]);
  });

  it("涨那一侧对称:美股 +2.1% 而 EWY 只涨 0.3%,报没跟涨、做多", () => {
    const e = evaluateCrossMarket(2.1, quotes({ EWY: 0.3, ASHR: 2.0 }), NOW, CFG);
    expect(e?.title).toBe("美股 +2.1%,韩股 ETF 没跟涨:开盘可能补涨");
    expect(e?.id).toBe("cross:2026-10-14:up");
    expect(e?.note).toContain("做多");
    expect(e?.cross?.markets[0]?.gap).toBe(1.8);
  });

  it("不在窗口里一律不报,哪怕差得再多:美股开盘前、A 股开过一个多小时", () => {
    expect(evaluateCrossMarket(-4, quotes(), Date.parse("2026-10-14T09:00:00-04:00"), CFG)).toBeNull();
    expect(evaluateCrossMarket(-4, quotes(), Date.parse("2026-10-14T23:00:00-04:00"), CFG)).toBeNull();
  });
});
