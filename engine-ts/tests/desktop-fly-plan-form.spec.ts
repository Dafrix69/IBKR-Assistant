/** 蝴蝶测算的表单(desktop/renderer-react/src/lib/flyPlanForm.ts):输入框里的字符串 → 引擎要的入参,以及「写进指令」。
 *
 * 钉三件事:
 *  1. 空着的格子不带(交给引擎定),绝不变成 0 送出去;送出去的入参过得了引擎那份 strict 的 schema。
 *  2. 「写进指令」写出来的那句话,本地速记解析出来的必须是**测算的那一只蝶**——行权价、看涨看跌、张数、权利金一样不差。
 *     测算的是一只、下单的是另一只,比没有这个按钮更糟。
 *  3. 快捷时刻从美东的此刻起算,不越过收盘。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { etNowFromEpoch } from "../src/config.js";
import { FlyPlanParamsSchema } from "../src/contract/schema/options.js";
import type { FlyPlanResult } from "../src/contract/options.js";
import { tryParseShorthand } from "../src/shorthand.js";

const SRC = path.resolve(__dirname, "..", "..", "desktop", "renderer-react", "src");
type Form = Record<string, string>;
const mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(SRC, "lib", "flyPlanForm.ts")).href)) as unknown as {
  EMPTY_FORM: Form;
  formProblems(f: Form): string[];
  toParams(f: Form): Record<string, unknown>;
  instructionFor(r: FlyPlanResult, todayEt: string): string;
  etClock(nowMs: number): { date: string; minutes: number };
  minutesFromNow(nowMs: number, ahead: number): string;
  hhmm(minutes: number): string;
  signedUsd(v: number): string;
  signedPct(v: number, digits?: number): string;
  pct(v: number, digits?: number): string;
};

const form = (over: Form = {}): Form => ({ ...mod.EMPTY_FORM, center: "7750", targetSpot: "7745", targetTime: "14:30", ...over });

describe("发出去之前的检查", () => {
  it("只填了必填的三样:没有问题", () => {
    expect(mod.formProblems(form())).toEqual([]);
  });

  it("空表单:说缺的是哪几样", () => {
    expect(mod.formProblems(mod.EMPTY_FORM)).toEqual(["中心行权价还没填", "目标点位还没填", "到达时刻还没填"]);
  });

  it("不是数字、范围不对、时刻写法不对:逐项说", () => {
    expect(mod.formProblems(form({ center: "abc" }))).toEqual(["中心行权价不是数字"]);
    expect(mod.formProblems(form({ center: "20", width: "25" }))).toEqual(["中心行权价要大于翼宽"]);
    expect(mod.formProblems(form({ width: "0" }))).toContain("翼宽要大于 0");
    expect(mod.formProblems(form({ quantity: "1.5" }))).toEqual(["张数要是不小于 1 的整数"]);
    expect(mod.formProblems(form({ cost: "25" }))).toEqual(["成本不应该超过翼宽"]);
    expect(mod.formProblems(form({ cost: "-1" }))).toEqual(["成本要大于 0"]);
    expect(mod.formProblems(form({ iv: "0" }))).toEqual(["IV要在 0 到 500% 之间"]);
    expect(mod.formProblems(form({ targetTime: "2点半" }))).toEqual(["到达时刻要写成 HH:MM(美东时间)"]);
    expect(mod.formProblems(form({ targetTime: "24:10" }))).toEqual(["到达时刻要写成 HH:MM(美东时间)"]);
    expect(mod.formProblems(form({ targetDate: "9/28" }))).toEqual(["目标日期要写成 YYYY-MM-DD"]);
    expect(mod.formProblems(form({ expiry: "20260928" }))).toEqual(["到期日要写成 YYYY-MM-DD"]);
  });

  it("IV 选了「自己填」:变化必须填,而且不能小于 −100%", () => {
    expect(mod.formProblems(form({ ivMode: "shift" }))).toEqual(["IV 变化还没填"]);
    expect(mod.formProblems(form({ ivMode: "shift", ivShiftPct: "-100" }))).toEqual(["IV 变化不能小于 −100%"]);
    expect(mod.formProblems(form({ ivMode: "shift", ivShiftPct: "-30" }))).toEqual([]);
    // 没选「自己填」时那一格里留着什么都不管
    expect(mod.formProblems(form({ ivMode: "auto", ivShiftPct: "abc" }))).toEqual([]);
  });
});

describe("表单 → 入参", () => {
  it("空着的格子不带,交给引擎定;绝不变成 0", () => {
    const params = mod.toParams(form({ quantity: "" }));
    expect(params).toEqual({ center: 7750, width: 25, target_spot: 7745, target_time: "14:30", iv_mode: "auto" });
    expect(FlyPlanParamsSchema.safeParse(params).success).toBe(true);
  });

  it("填了的转成数字;到期日转成 YYYYMMDD;看涨看跌照带", () => {
    const params = mod.toParams(form({
      right: "P", quantity: "3", cost: " 1.85 ", targetDate: "2026-09-29", expiry: "2026-09-30", spot: "7720.5", iv: "18",
      ivMode: "shift", ivShiftPct: "30",
    }));
    expect(params).toEqual({
      center: 7750, width: 25, target_spot: 7745, target_time: "14:30", iv_mode: "shift", iv_shift_pct: 30,
      right: "P", quantity: 3, cost: 1.85, target_date: "2026-09-29", expiry: "20260930", spot: 7720.5, iv: 18,
    });
    expect(FlyPlanParamsSchema.safeParse(params).success).toBe(true);
  });

  it("没选「自己填」:IV 变化那一格不带(带了引擎也不看,但别让人以为它起了作用)", () => {
    expect(mod.toParams(form({ ivMode: "flat", ivShiftPct: "30" }))).not.toHaveProperty("iv_shift_pct");
  });
});

describe("写进指令", () => {
  const result = (over: Partial<FlyPlanResult> = {}): FlyPlanResult => ({
    symbol: "SPX", expiry: "20260928", trading_class: "SPXW", right: "C", lower: 7725, center: 7750, upper: 7775, width: 25,
    quantity: 2, multiplier: 100, cost: 1.85, ...over,
  } as FlyPlanResult);
  /** 2026-09-28 周一,美东 10:00 */
  const MONDAY = etNowFromEpoch(Date.parse("2026-09-28T10:00:00-04:00"));
  const parse = (text: string) => tryParseShorthand(text, { SPX: 7720 }, MONDAY);

  it("当日到期:本地速记认得,解析出来的就是测算的那一只——行权价、方向、张数、权利金", () => {
    const text = mod.instructionFor(result(), "2026-09-28");
    expect(text).toBe("SPX 7750蝴蝶 25cm 看涨 2张 1.85");
    const order = parse(text)!["orders"][0];
    expect(order["contract"]["legs"].map((l: Record<string, unknown>) => [l["action"], l["ratio"], l["strike"], l["right"], l["lastTradeDateOrContractMonth"], l["tradingClass"]])).toEqual([
      ["BUY", 1, 7725, "C", "20260928", "SPXW"], ["SELL", 2, 7750, "C", "20260928", "SPXW"], ["BUY", 1, 7775, "C", "20260928", "SPXW"],
    ]);
    expect(order["order"]).toMatchObject({ action: "BUY", orderType: "LMT", totalQuantity: 2, lmtPrice: 1.85, price_mode: "EXPLICIT", tif: "DAY" });
  });

  it("看跌蝶、整数权利金、一张:同样对得上", () => {
    const text = mod.instructionFor(result({ right: "P", lower: 7675, center: 7700, upper: 7725, quantity: 1, cost: 2 }), "2026-09-28");
    expect(text).toBe("SPX 7700蝴蝶 25cm 看跌 1张 2");
    const order = parse(text)!["orders"][0];
    expect(order["contract"]["legs"].map((l: Record<string, unknown>) => [l["strike"], l["right"]])).toEqual([[7675, "P"], [7700, "P"], [7725, "P"]]);
    expect(order["order"]).toMatchObject({ totalQuantity: 1, lmtPrice: 2 });
  });

  it("下一个交易日到期:写「明天」;周五测算周一到期的也是「明天」(速记只跳周末)", () => {
    const text = mod.instructionFor(result({ expiry: "20260929" }), "2026-09-28");
    expect(text).toBe("SPX 明天 7750蝴蝶 25cm 看涨 2张 1.85");
    expect(parse(text)!["orders"][0]["contract"]["legs"][0]["lastTradeDateOrContractMonth"]).toBe("20260929");
    expect(mod.instructionFor(result({ expiry: "20261005" }), "2026-10-02")).toBe("SPX 明天 7750蝴蝶 25cm 看涨 2张 1.85");
  });

  it("别的到期日:写明日期与三个行权价,本地速记不接(交给大模型),不会被当成当日到期", () => {
    const text = mod.instructionFor(result({ expiry: "20261002" }), "2026-09-28");
    expect(text).toBe("买入 2 张 SPX 2026-10-02 到期的 7725/7750/7775 看涨蝴蝶,权利金不超过 1.85");
    expect(parse(text)).toBeNull();
  });
});

describe("美东时间与快捷时刻", () => {
  it("此刻在美东是哪一天、第几分钟(夏令时与冬令时)", () => {
    expect(mod.etClock(Date.parse("2026-09-28T14:05:00Z"))).toEqual({ date: "2026-09-28", minutes: 10 * 60 + 5 });
    expect(mod.etClock(Date.parse("2026-12-01T14:05:00Z"))).toEqual({ date: "2026-12-01", minutes: 9 * 60 + 5 });
    // 北京时间的凌晨还是美东的前一天
    expect(mod.etClock(Date.parse("2026-09-29T01:30:00+08:00")).date).toBe("2026-09-28");
  });

  it("「N 分钟后」从美东的此刻起算,不越过收盘", () => {
    const now = Date.parse("2026-09-28T10:12:00-04:00");
    expect(mod.minutesFromNow(now, 30)).toBe("10:42");
    expect(mod.minutesFromNow(now, 120)).toBe("12:12");
    expect(mod.minutesFromNow(Date.parse("2026-09-28T15:20:00-04:00"), 60)).toBe("16:00");
    expect(mod.hhmm(9 * 60 + 5)).toBe("09:05");
  });
});

describe("给人看的数", () => {
  it("带符号的美元与百分比:负号用「−」,零不带符号", () => {
    expect(mod.signedUsd(1234.4)).toBe("+$1,234");
    expect(mod.signedUsd(-567)).toBe("−$567");
    expect(mod.signedUsd(0)).toBe("$0");
    expect(mod.signedPct(31.4, 0)).toBe("+31%");
    expect(mod.signedPct(-8.25)).toBe("−8.3%");
    expect(mod.pct(0.158)).toBe("15.8%");
  });
});
