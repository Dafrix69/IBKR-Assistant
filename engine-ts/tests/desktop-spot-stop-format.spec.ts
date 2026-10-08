/** 标的止损价在界面上的三句话(desktop/renderer-react/src/lib/spotStopFormat.ts):卡片摘要、盯盘那一行、确认框那一行。
 *
 * 钉三件事:
 *  1. 价位照人填的样子写(7700 不写成 7700.00,7790.5 不丢半点),没设的那一条不出现;
 *  2. 拿不到标的现价的那一轮照实说没判,不摆一个"还差多少"的旧数;
 *  3. 确认框那一行没设时是空串——拼进确认框不能多出一个空行或一句没头没尾的话。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..", "desktop", "renderer-react", "src");
interface View { below: number | null; above: number | null; spot: number | null; spot_note?: string; reason?: string }
const mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(SRC, "lib", "spotStopFormat.ts")).href)) as unknown as {
  spotStopSummary(below: number | null | undefined, above: number | null | undefined): string;
  spotStopLine(symbol: string, row: View): string;
  spotStopConfirmLine(symbol: string, below: number | null | undefined, above: number | null | undefined): string;
};

describe("卡片摘要", () => {
  it("设了哪条写哪条;老追踪没有这两个键(undefined)与 null 一样是没设", () => {
    expect(mod.spotStopSummary(7700, null)).toBe("标的止损 跌到 7700");
    expect(mod.spotStopSummary(null, 7790.5)).toBe("标的止损 涨到 7790.5");
    expect(mod.spotStopSummary(7700, 7790)).toBe("标的止损 跌到 7700 / 涨到 7790");
    expect(mod.spotStopSummary(null, null)).toBe("");
    expect(mod.spotStopSummary(undefined, undefined)).toBe("");
  });
});

describe("盯盘那一行", () => {
  it("标的现价与离每条线还差多少点", () => {
    expect(mod.spotStopLine("SPX", { below: 7700, above: null, spot: 7722.35 }))
      .toBe("标的止损:SPX 现价 7722.35,跌到 7700 就平(还差 22.35 点)");
    expect(mod.spotStopLine("SPX", { below: 7700, above: 7790, spot: 7722.35 }))
      .toBe("标的止损:SPX 现价 7722.35,跌到 7700 就平(还差 22.35 点),涨到 7790 就平(还差 67.65 点)");
  });

  it("夜盘按期货推算的现价:把来历带上", () => {
    expect(mod.spotStopLine("SPX", { below: null, above: 7790, spot: 7760, spot_note: "按 ESZ6 − 基差 12.5 推算" }))
      .toBe("标的止损:SPX 现价 7760.00,涨到 7790 就平(还差 30.00 点) · 按 ESZ6 − 基差 12.5 推算");
  });

  it("拿不到标的现价:说这一轮没判,不写「还差」", () => {
    expect(mod.spotStopLine("SPX", { below: 7700, above: null, spot: null, reason: "拿不到 SPX 的现价,标的止损这一轮不判断" }))
      .toBe("拿不到 SPX 的现价,标的止损这一轮不判断");
    expect(mod.spotStopLine("SPX", { below: 7700, above: null, spot: null })).toBe("拿不到 SPX 的现价,标的止损这一轮不判断");
  });
});

describe("确认框那一行", () => {
  it("写清两条线、看的是什么、谁在盯;以换行结尾", () => {
    expect(mod.spotStopConfirmLine("SPX", 7700, null))
      .toBe("标的止损:SPX 跌到 7700 就平,记作止损。只看标的现价,不看这份持仓值多少;软件开着时按秒盯。\n");
    expect(mod.spotStopConfirmLine("SPX", 7700, 7790)).toMatch(/^标的止损:SPX 跌到 7700、或涨到 7790 就平,记作止损。/);
  });

  it("没设:空串", () => {
    expect(mod.spotStopConfirmLine("SPX", null, null)).toBe("");
    expect(mod.spotStopConfirmLine("SPX", undefined, undefined)).toBe("");
  });
});
