/** 持仓现价的两条口径(2026-09-27 审计 T4 与"正股昨收"那一条),走 BrokerRouter.positions() 的真实路径。
 *
 *  · 期权腿**买价为 0**(没人出价,0DTE 远翼临近收盘常见)时,以前 cleanPrice 把 0 当成"没报价",
 *    退到最新成交——那可能是几个小时前的价(早上成交在 1.85,此刻卖价 0.05)。组合现价因此被抬高一截,
 *    止损判断、峰值、反解波动率、托管止盈价都跟着错。卖价有效时,买价 0 就是一个真盘口:按 (0 + 卖价)/2 记。
 *    optionQuotes 同样把 0 交给 naturalClosePrice(它本来就认"要卖掉的腿买价为 0"),以前在这一步就变成 null,
 *    那条规则在真券商路径上从来没生效过。
 *  · 正股没有最新成交也没有买卖价时,以前退到**昨收**填进 market_price——和期权腿同一条规矩:
 *    昨收只给界面看(close_price),不进触发判断。
 */
import { describe, expect, it } from "vitest";

import { BrokerRouter } from "../src/broker.js";
import type { IbContract, IbSession, TickerData } from "../src/broker.js";
import * as tk from "../src/tracker.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");
type Row = Record<string, unknown>;

function ticker(over: Partial<TickerData> = {}): TickerData {
  return { bid: NaN, ask: NaN, last: null, close: null, bidSize: null, askSize: null, marketPrice: null, modelGreeks: null, ...over };
}

interface PositionItem { account: string; position: number; avgCost: number; contract: Record<string, unknown> }

/** 只实现 positions() 这条路要用到的那几样;行情按 代码|行权价|看涨看跌 取 */
class QuoteSession {
  tickers = new Map<string, TickerData>();
  items: PositionItem[] = [];
  isConnected(): boolean { return true; }
  disconnect(): void { /* 离线 */ }
  managedAccounts(): string[] { return ["DU7654321"]; }
  async qualifyContracts(contracts: IbContract[]): Promise<void> { for (const c of contracts) c.conId = 1000; }
  reqMarketDataType(): void { /* 离线 */ }
  subscribeTicker(contract: IbContract): { read(): TickerData } {
    const key = `${contract.symbol}|${contract.strike ?? ""}|${contract.right ?? ""}`;
    return { read: () => this.tickers.get(key) ?? ticker() };
  }
  cancelTicker(): void { /* 离线 */ }
  async settle(): Promise<void> { /* 离线 */ }
  async portfolio(): Promise<never[]> { return []; }
  async positions(): Promise<PositionItem[]> { return this.items; }
  onConnectivity(): void { /* 离线 */ }
  onError(): void { /* 离线 */ }
  offError(): void { /* 离线 */ }
}

async function rowsWith(items: PositionItem[], quotes: Record<string, TickerData>): Promise<[Row[], BrokerRouter]> {
  const session = new QuoteSession();
  session.items = items;
  for (const [k, v] of Object.entries(quotes)) session.tickers.set(k, v);
  const settings = makeSettings(g.base_config);
  const router = new BrokerRouter(settings, async () => session as unknown as IbSession);
  const account = settings.accounts[0];
  if (account === undefined) throw new Error("配置里没有账户");
  await router.forAccount(account);
  return [(await router.positions()) as unknown as Row[], router];
}

const leg = (strike: number, position: number, avgCost: number): PositionItem => ({
  account: "DU7654321", position, avgCost,
  contract: { symbol: "SPX", secType: "OPT", lastTradeDateOrContractMonth: "20260910", strike, right: "C", multiplier: "100" },
});
const priceOf = (rows: Row[], strike: number): unknown =>
  rows.find((r) => (r["contract"] as Row | undefined)?.["strike"] === strike)?.["market_price"];

describe("期权腿买价为 0:按单边盘口记,不退到几小时前的最新成交", () => {
  // 7700/7725/7750 看涨蝶,临近收盘:远翼没人出价,最新成交是早上的 1.85
  const fly = [leg(7700, 1, 1000), leg(7725, -2, 400), leg(7750, 1, 150)];
  const book = {
    "SPX|7700|C": ticker({ bid: 12, ask: 12.4, last: 12.1 }),
    "SPX|7725|C": ticker({ bid: 0.4, ask: 0.6, last: 0.55 }),
    "SPX|7750|C": ticker({ bid: 0, ask: 0.05, last: 1.85 }),
  };

  it("远翼现价 = (0 + 0.05)/2 = 0.025;组合现价随之是 11.225,不是 13.05", async () => {
    const [rows] = await rowsWith(fly, book);
    expect(priceOf(rows, 7750)).toBe(0.025);
    const bag = tk.withCombos(rows).find((r) => r["sec_type"] === "BAG");
    expect(bag?.["market_price"]).toBe(11.225);
  });

  it("optionQuotes 把买价 0 原样交出去:naturalClosePrice 按 0 卖远翼,算得出立刻成交价 10.80", async () => {
    const [rows, router] = await rowsWith(fly, book);
    const quotes = await router.optionQuotes(rows);
    const farWing = rows.find((r) => (r["contract"] as Row | undefined)?.["strike"] === 7750);
    expect(quotes[String(farWing?.["key"])]).toEqual({ bid: 0, ask: 0.05 });
    const all = tk.withCombos(rows);
    const bag = all.find((r) => r["sec_type"] === "BAG");
    if (bag === undefined) throw new Error("没有组合行");
    const structure = tk.structureOf("BAG", bag["contract"] as Record<string, unknown>);
    if (structure === null) throw new Error("认不出结构");
    const book2: Record<string, tk.LegBook> = {};
    for (const r of rows) {
      const c = r["contract"] as Row;
      book2[tk.legPriceKey({ strike: Number(c["strike"]), right: String(c["right"]) })] = quotes[String(r["key"])] ?? { bid: null, ask: null };
    }
    const position = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: 350, multiplier: 100 });
    expect(tk.naturalClosePrice(position, structure, book2)).toBe(10.8);
  });

  it("完全没有盘口(买卖价都没有)才退到最新成交", async () => {
    const [rows] = await rowsWith([leg(7750, 1, 150)], { "SPX|7750|C": ticker({ last: 1.85 }) });
    expect(priceOf(rows, 7750)).toBe(1.85);
  });

  it("卖价也没有(只有买价 0):不是盘口,照旧退到最新成交", async () => {
    const [rows] = await rowsWith([leg(7750, 1, 150)], { "SPX|7750|C": ticker({ bid: 0, last: 1.85 }) });
    expect(priceOf(rows, 7750)).toBe(1.85);
  });

  it("双边都有:仍是中间价", async () => {
    const [rows] = await rowsWith([leg(7700, 1, 1000)], { "SPX|7700|C": ticker({ bid: 12, ask: 12.4, last: 11 }) });
    expect(priceOf(rows, 7700)).toBe(12.2);
  });
});

describe("正股:昨收只给界面看,不填进 market_price", () => {
  const stock: PositionItem = { account: "DU7654321", position: 100, avgCost: 20, contract: { symbol: "BE", secType: "STK" } };

  it("只有昨收:market_price 为空、close_price = 昨收(追踪那边读作「拿不到现价,本轮不判断」)", async () => {
    const [rows] = await rowsWith([stock], { "BE||": ticker({ close: 30 }) });
    const row = rows.find((r) => r["symbol"] === "BE");
    expect(row?.["market_price"]).toBeNull();
    expect(row?.["close_price"]).toBe(30);
  });

  it("有最新成交:照旧用它", async () => {
    const [rows] = await rowsWith([stock], { "BE||": ticker({ last: 31, close: 30 }) });
    expect(rows.find((r) => r["symbol"] === "BE")?.["market_price"]).toBe(31);
  });

  it("只有买卖价:中间价", async () => {
    const [rows] = await rowsWith([stock], { "BE||": ticker({ bid: 30.9, ask: 31.1, close: 30 }) });
    expect(rows.find((r) => r["symbol"] === "BE")?.["market_price"]).toBe(31);
  });
});
