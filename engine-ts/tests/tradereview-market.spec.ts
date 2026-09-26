/** "曾有的机会"改用组合的真实中间价说。
 *
 * 2026-09-26 之前卡片上写的是「若当时到期理论盈利 +411.00(内在价值口径,是下界)」——2026-09-25 那张
 * SPX 7700/7720/7740 看跌蝶(3.15 买入,12:34 以 4.05 平仓 +90)。可 12:23 标的离中心 12.74 点、离收盘三个半小时,
 * 盘面中间价只有 4.65:内在价值在这时是**卖不到**的上沿,不是下界。下面的分钟线是 review.analyze 的 fly_series 原样。
 */
import { describe, expect, it } from "vitest";

import * as tr from "../src/tradereview.js";

type Rec = Record<string, any>;

const TAPE: Array<[string, number]> = [
  ["12:15", 3.3], ["12:16", 3.05], ["12:17", 3.75], ["12:18", 4.25], ["12:19", 4.1], ["12:20", 4.65],
  ["12:21", 4.45], ["12:22", 4.7], ["12:23", 4.65], ["12:24", 4.7], ["12:25", 4.5], ["12:26", 3.55],
  ["12:33", 3.0], ["12:34", 4.35], ["12:35", 4.0],
];
const BARS = TAPE.map(([t, close]) => ({ time: `2026-09-25 ${t}`, close }));

function result(over: { action?: string; pnl?: number | null; findings?: Rec[] } = {}): Rec {
  return {
    profile: { action: over.action ?? "BUY", debit: 3.15, multiplier: 100, qty: 1 },
    outcome: { kind: "closed", time_et: "2026-09-25 12:34", pnl: over.pnl === undefined ? 90 : over.pnl },
    stats: { best_theoretical: { pnl: 411, time: "2026-09-25 12:23", underlying: 7732.74 } },
    findings: over.findings ?? [
      { tone: "warn", title: "曾有的机会", text: "内在价值那一句" },
      { tone: "good", title: "平仓", text: "12:34 以 4.05 平仓" },
    ],
  };
}

describe("marketOpportunity", () => {
  it("09-25 那一笔:持有期间最高中间价 4.70(+155),不是 +411;平仓那一分钟之后的 4.35 不算", () => {
    const r = result();
    tr.marketOpportunity(r, BARS, "2026-09-25 12:16");
    expect(r["stats"]["best_market"]).toEqual({ time: "2026-09-25 12:22", mid: 4.7, pnl: 155 });
    const f = r["findings"][0];
    expect(f).toMatchObject({ tone: "warn", title: "曾有的机会" });
    expect(f["text"]).toBe(
      "持有期间组合中间价最高 4.7(2026-09-25 12:22),按它平仓 +155.00;最终结果 +90.00。"
      + "按到期内在价值算的 +411.00(2026-09-25 12:23 标的到 7732.74)是若当时到期的数,离到期还有时间时卖不到。",
    );
    expect(f["text"]).not.toContain("下界");
  });

  it("平仓不比最高中间价差:改成好消息,不再说错过了什么", () => {
    const r = result({ pnl: 160 });
    tr.marketOpportunity(r, BARS, "2026-09-25 12:16");
    expect(r["findings"][0]["tone"]).toBe("good");
    expect(r["findings"][0]["text"]).toContain("最终结果 +160.00 不比它差");
  });

  it("内在价值那条没出(没比结果好),盘面上却真有过更好的浮盈:补一条,排在「平仓」之前", () => {
    const r = result({ findings: [{ tone: "good", title: "平仓", text: "…" }, { tone: "good", title: "方向", text: "…" }] });
    tr.marketOpportunity(r, BARS, "2026-09-25 12:16");
    expect(r["findings"].map((f: Rec) => f["title"])).toEqual(["曾有的机会", "平仓", "方向"]);
  });

  it("没有组合分钟线、卖出的蝶、持仓中:一个字都不动", () => {
    for (const [r, bars] of [
      [result(), []],
      [result({ action: "SELL" }), BARS],
      [{ ...result(), outcome: { kind: "open", time_et: null, pnl: null } }, BARS],
    ] as Array<[Rec, Rec[]]>) {
      const before = JSON.stringify(r);
      tr.marketOpportunity(r, bars, "2026-09-25 12:16");
      expect(JSON.stringify(r)).toBe(before);
    }
  });
});
