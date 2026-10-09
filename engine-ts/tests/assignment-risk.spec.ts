/** 到期日空头腿的指派提醒(assignmentRisk.ts 纯函数 + services/assignmentWatch.ts)。
 *
 * 要钉的是"周一醒来账户里多了一手正股"之前的那一句话:哪几条腿、按现在的价到期后正股净变多少。
 * 以及不该说话的时候不说:指数期权(现金结算)、不是今天到期的、虚值的、已经说过的。全部离线。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { assignmentNotices, expiringOptionLegs, itmBy, noticeText } from "../src/assignmentRisk.js";
import { etNowFromEpoch, fromDict } from "../src/config.js";
import type { PositionRow } from "../src/contract/positions.js";
import { AssignmentWatchService } from "../src/services/assignmentWatch.js";
import type { ServiceHost } from "../src/services/host.js";

const BASE = JSON.parse(readFileSync(path.resolve(__dirname, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
const TODAY = "20261016";

function leg(symbol: string, strike: number, right: "C" | "P", quantity: number, expiry = TODAY, extra: Partial<PositionRow> = {}): PositionRow {
  return {
    key: `模拟|${symbol}|OPT|${expiry}${right}${strike}`, account: "模拟", symbol, sec_type: "OPT", leg: `${expiry}|${strike}${right}`,
    label: `${symbol} ${strike}${right}`, quantity, multiplier: 100, currency: "USD", avg_cost: 150, market_price: 1.5,
    market_value: null, unrealized_pnl: null,
    contract: { secType: "OPT", symbol, strike, right, lastTradeDateOrContractMonth: expiry },
    ...extra,
  };
}
const isIndex = (symbol: string): boolean => symbol === "SPX";

describe("哪些腿算数", () => {
  it("只要今天到期的实物交割期权腿:指数期权、别的到期日、正股、组合行、期货期权都不要", () => {
    const rows: PositionRow[] = [
      leg("AAPL", 230, "C", -2),
      leg("AAPL", 235, "C", 2),
      leg("AAPL", 230, "C", -1, "20261023"),
      leg("SPX", 6700, "P", -1),
      leg("AAPL", 230, "C", -1, TODAY, { sec_type: "FOP" }),
      leg("AAPL", 0, "C", -1, TODAY, { sec_type: "STK", contract: { secType: "STK", symbol: "AAPL" } }),
      leg("AAPL", 230, "C", -1, TODAY, { sec_type: "BAG" }),
      leg("AAPL", 230, "C", 0),
    ];
    const legs = expiringOptionLegs(rows, TODAY, isIndex);
    expect(legs.map((l) => [l.symbol, l.strike, l.right, l.quantity])).toEqual([["AAPL", 230, "C", -2], ["AAPL", 235, "C", 2]]);
  });

  it("到期日字段带着时间(IB 有时给 '20261016 16:00:00')也认;乘数缺了按 100", () => {
    const row = leg("AAPL", 230, "P", -1, TODAY, { multiplier: 0 });
    row.contract["lastTradeDateOrContractMonth"] = `${TODAY} 16:00:00 US/Eastern`;
    expect(expiringOptionLegs([row], TODAY, isIndex)).toMatchObject([{ strike: 230, right: "P", multiplier: 100 }]);
  });

  it("实值多少:看涨是现价 − 行权价,看跌反过来;平值与虚值是 0", () => {
    expect(itmBy({ strike: 230, right: "C" }, 231.4)).toBeCloseTo(1.4, 9);
    expect(itmBy({ strike: 230, right: "P" }, 228)).toBe(2);
    expect(itmBy({ strike: 230, right: "C" }, 230)).toBe(0);
    expect(itmBy({ strike: 230, right: "P" }, 231)).toBe(0);
  });
});

describe("该不该提醒、正股净变多少", () => {
  const legsOf = (rows: PositionRow[]) => expiringOptionLegs(rows, TODAY, isIndex);

  it("裸卖看涨在实值里:被指派卖出正股", () => {
    const [n] = assignmentNotices(legsOf([leg("AAPL", 230, "C", -2)]), { AAPL: 231.4 });
    expect(n).toMatchObject({ account: "模拟", symbol: "AAPL", spot: 231.4, net_shares: -200 });
    expect(n?.legs).toHaveLength(1);
    expect(noticeText(n!)).toContain("卖出 2 张 230C(实值 1.4)");
    expect(noticeText(n!)).toContain("净卖出 200 股");
  });

  it("卖出看跌在实值里:被指派买进正股", () => {
    const [n] = assignmentNotices(legsOf([leg("AAPL", 230, "P", -1)]), { AAPL: 228 });
    expect(n?.net_shares).toBe(100);
    expect(noticeText(n!)).toContain("净买进 100 股");
  });

  it("贷方价差只有空头腿在实值里(现价在两个行权价之间):净变动是整条空头腿", () => {
    // 卖 230C、买 235C,现价 232:空头腿被指派,多头腿作废
    const [n] = assignmentNotices(legsOf([leg("AAPL", 230, "C", -1), leg("AAPL", 235, "C", 1)]), { AAPL: 232 });
    expect(n?.legs.map((l) => l.strike)).toEqual([230]);
    expect(n?.net_shares).toBe(-100);
  });

  it("两条腿都在实值里:多头腿自动行权,两边相抵,仍然提醒(空头腿确实会被指派),写明净变动为 0", () => {
    const [n] = assignmentNotices(legsOf([leg("AAPL", 230, "C", -1), leg("AAPL", 235, "C", 1)]), { AAPL: 240 });
    expect(n?.net_shares).toBe(0);
    expect(noticeText(n!)).toContain("正股净变动为 0");
  });

  it("空头腿在虚值里、只有多头腿在实值里、只持有多头:都不提醒", () => {
    expect(assignmentNotices(legsOf([leg("AAPL", 230, "C", -1)]), { AAPL: 229 })).toEqual([]);
    expect(assignmentNotices(legsOf([leg("AAPL", 230, "C", 1)]), { AAPL: 240 })).toEqual([]);
    // 借方价差:买 230C、卖 235C,现价 232——空头腿虚值
    expect(assignmentNotices(legsOf([leg("AAPL", 230, "C", 1), leg("AAPL", 235, "C", -1)]), { AAPL: 232 })).toEqual([]);
  });

  it("拿不到现价:照样列出今天到期的空头腿,明说判断不了,不给净变动", () => {
    const [n] = assignmentNotices(legsOf([leg("AAPL", 230, "C", -1), leg("AAPL", 235, "C", 1)]), { AAPL: null });
    expect(n).toMatchObject({ spot: null, net_shares: null });
    expect(n?.legs.map((l) => l.strike)).toEqual([230]);
    expect(noticeText(n!)).toContain("拿不到正股现价");
  });

  it("两个账户、两只标的:各出各的", () => {
    const other = leg("AAPL", 230, "C", -1, TODAY, { account: "主账户", key: "主账户|AAPL|OPT|x" });
    const out = assignmentNotices(legsOf([leg("AAPL", 230, "C", -1), other, leg("TSLA", 400, "P", -3)]), { AAPL: 231, TSLA: 395 });
    expect(out.map((n) => [n.account, n.symbol, n.net_shares])).toEqual([["模拟", "AAPL", -100], ["主账户", "AAPL", -100], ["模拟", "TSLA", 300]]);
  });
});

describe("后台那一轮", () => {
  const at = (hhmm: string, date = "2026-10-16") => etNowFromEpoch(Date.parse(`${date}T${hhmm}:00-04:00`));

  function setup(rows: PositionRow[], quotes: Record<string, { last: number | null }> | Error) {
    const notes: string[] = [];
    const audits: Array<[string, unknown]> = [];
    const asked: string[][] = [];
    const settings = fromDict({ ...BASE, early_close_days: ["2026-11-27"] });
    const router = {
      connected: true,
      rows,
      sessions(): unknown[] { return this.connected ? [{}] : []; },
      async positions(): Promise<PositionRow[]> { return this.rows; },
      async streamQuotes(symbols: string[]): Promise<Record<string, { last: number | null }>> {
        asked.push(symbols);
        if (quotes instanceof Error) throw quotes;
        return quotes;
      },
    };
    const host = {
      settings, router,
      engine: { store: { audit: (_who: string, kind: string, detail: unknown) => audits.push([kind, detail]) }, notifier: { notify: (_t: string, body: string) => notes.push(body) } },
      emit: () => undefined,
    };
    return { service: new AssignmentWatchService(host as unknown as ServiceHost), notes, audits, asked, router };
  }

  it("收盘前 30 分钟才开始看;提前收盘日按 13:00 收", () => {
    const { service } = setup([], {});
    expect([service.inWindow(at("15:29")), service.inWindow(at("15:30")), service.inWindow(at("15:59")), service.inWindow(at("16:00"))]).toEqual([false, true, true, false]);
    const early = (hhmm: string) => etNowFromEpoch(Date.parse(`2026-11-27T${hhmm}:00-05:00`));
    expect([service.inWindow(early("12:29")), service.inWindow(early("12:30")), service.inWindow(early("13:00")), service.inWindow(early("15:45"))]).toEqual([false, true, false, false]);
  });

  it("时段里、空头腿在实值里:提醒一次,留一条审计;同一条腿下一轮不再说", async () => {
    const { service, notes, audits, asked } = setup([leg("AAPL", 230, "C", -2), leg("SPX", 6700, "P", -1)], { AAPL: { last: 231.4 } });
    expect(await service.tickOnce(at("15:31"))).toBe(1);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("AAPL");
    expect(audits).toMatchObject([["assignment_risk", { symbol: "AAPL", net_shares: -200 }]]);
    // 只问了有空头腿的实物交割标的,指数不问
    expect(asked).toEqual([["AAPL"]]);
    expect(await service.tickOnce(at("15:32"))).toBe(0);
    expect(notes).toHaveLength(1);
  });

  it("时段外不读持仓、不取价;没连券商不动", async () => {
    const { service, asked, router } = setup([leg("AAPL", 230, "C", -2)], { AAPL: { last: 231.4 } });
    expect(await service.tickOnce(at("11:00"))).toBe(0);
    router.connected = false;
    expect(await service.tickOnce(at("15:40"))).toBe(0);
    expect(asked).toEqual([]);
  });

  it("先是虚值、后来进了实值:进去的那一轮提醒", async () => {
    const quotes = { AAPL: { last: 229 as number | null } };
    const { service, notes } = setup([leg("AAPL", 230, "C", -1)], quotes);
    expect(await service.tickOnce(at("15:31"))).toBe(0);
    quotes.AAPL.last = 230.5;
    expect(await service.tickOnce(at("15:45"))).toBe(1);
    expect(notes[0]).toContain("实值 0.5");
  });

  it("取价失败:说一次「拿不到现价」;之后拿到了、在实值里,再说一次", async () => {
    const quotes: Record<string, { last: number | null }> = {};
    const { service, notes } = setup([leg("AAPL", 230, "C", -1)], quotes);
    expect(await service.tickOnce(at("15:31"))).toBe(1);
    expect(notes[0]).toContain("拿不到正股现价");
    expect(await service.tickOnce(at("15:32"))).toBe(0);
    quotes["AAPL"] = { last: 233 };
    expect(await service.tickOnce(at("15:33"))).toBe(1);
    expect(notes[1]).toContain("实值 3");
  });

  it("取价抛了错也不炸:按拿不到现价处理", async () => {
    const { service, notes } = setup([leg("AAPL", 230, "C", -1)], new Error("TWS 没回"));
    expect(await service.tickOnce(at("15:31"))).toBe(1);
    expect(notes[0]).toContain("拿不到正股现价");
  });

  it("没有今天到期的空头腿:不取价、不提醒", async () => {
    const { service, asked } = setup([leg("AAPL", 230, "C", 3), leg("AAPL", 230, "C", -1, "20261023")], { AAPL: { last: 250 } });
    expect(await service.tickOnce(at("15:31"))).toBe(0);
    expect(asked).toEqual([]);
  });
});
