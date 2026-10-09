/** K 线从券商出来的那一段(BrokerRouter.intradayBars + 真的会话层,底下是假的 TWS)。离线。
 *
 * 价格行为的判定只用已收盘的 K 线(priceaction.spec),有两件事要券商这一层配合:
 *  1. 这组 K 线出自实时档还是延迟档。历史数据的回包里没有这一项,只能从同一张合约的行情流上看:
 *     会话记着每张正股 / 指数的成交价最近一次出自哪一档(quoteDelayed),取 K 线时记在那组 K 线上(tagFeed)。
 *     只读、不为了问这一句去订流或撤流——同一张合约的流是各处共用的。
 *  2. 第一档时长取回来不到「最少根数 + 1」就改取长的那一档:分析要 30 根已收盘的,最后一根常常没走完。
 */
import { describe, expect, it } from "vitest";

import { BrokerRouter } from "../src/broker.js";
import type { IbSession } from "../src/broker.js";
import { indexContract, stockContract } from "../src/ibContracts.js";
import { createIbApiNextSession } from "../src/ibSession.js";
import { MIN_BARS, feedOf } from "../src/marketdata.js";
import { CFG, FakeTws, TICK } from "./fakeTws.js";
import type { LibBar } from "./fakeTws.js";
import { loadGolden, makeSettings } from "./util.js";

/** TWS 的延迟成交价 tick 号(实时的是 4)。 */
const DELAYED_LAST = 68;

async function connect(): Promise<{ tws: FakeTws; session: IbSession; router: BrokerRouter }> {
  const tws = new FakeTws();
  const session = await createIbApiNextSession(CFG, { mod: { ...tws.mod(), IBApiTickType: { ...TICK, DELAYED_LAST } } });
  session.settle = async () => tws.pump();
  const settings = makeSettings(loadGolden("config").base_config);
  const router = new BrokerRouter(settings, async () => session);
  await router.forAccount(settings.accounts[0]!);
  return { tws, session, router };
}

/** n 根 5 分钟线,TWS 的时间格式。 */
function libBars(n: number): LibBar[] {
  const out: LibBar[] = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(Date.UTC(2026, 7, 14, 9, 30) + i * 300_000).toISOString();
    out.push({ time: `${t.slice(0, 10).replace(/-/g, "")}  ${t.slice(11, 19)}`, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000 });
  }
  return out;
}

/** 给这张合约此刻开着的每条流推一笔成交价:实时档(tick 4)或延迟档(tick 68)。 */
function pushLast(tws: FakeTws, symbol: string, tick: number, price: number): void {
  for (const sub of tws.subs) {
    if (!sub.closed && sub.contract["symbol"] === symbol) sub.next({ all: new Map([[tick, { value: price }]]) });
  }
}

describe("这组 K 线出自哪一档行情", () => {
  it("会话还没见过这张合约的成交价:说不准;取 K 线不为了问这一句去占一条行情线路", async () => {
    const { tws, router } = await connect();
    tws.history.set("NVDA", libBars(40));
    const bars = await router.intradayBars("NVDA", "5m");
    expect(bars).toHaveLength(40);
    expect(bars[0]).toEqual({ time: "2026-08-14 09:30", open: 100, high: 101, low: 99, close: 100.5, volume: 1000 });
    expect(feedOf(bars)).toBe("unknown");
    expect(tws.lines()).toBe(0);
  });

  it("成交价出自延迟档的记成延迟,出自实时档的记成实时;各张合约各记各的", async () => {
    const { tws, session, router } = await connect();
    for (const symbol of ["NVDA", "AAPL"]) tws.history.set(symbol, libBars(40));
    session.subscribeTicker(stockContract("NVDA"));
    session.subscribeTicker(stockContract("AAPL"));
    pushLast(tws, "NVDA", DELAYED_LAST, 100);
    pushLast(tws, "AAPL", TICK.LAST, 200);
    expect(session.quoteDelayed?.(stockContract("NVDA"))).toBe(true);
    expect(session.quoteDelayed?.(stockContract("AAPL"))).toBe(false);
    expect(session.quoteDelayed?.(stockContract("MSFT"))).toBeNull();
    expect(feedOf(await router.intradayBars("NVDA", "5m"))).toBe("delayed");
    expect(feedOf(await router.intradayBars("AAPL", "5m"))).toBe("live");

    // 后来这张合约有了实时成交价(订阅补上了):跟着改
    pushLast(tws, "NVDA", TICK.LAST, 101);
    expect(feedOf(await router.intradayBars("NVDA", "5m"))).toBe("live");
  });

  it("流撤掉之后还记得(盘口是现订现撤的);指数认指数那张合约;只来过买卖价、没来过成交价的不算见过", async () => {
    const { tws, session, router } = await connect();
    tws.history.set("NVDA", libBars(40));
    tws.history.set("SPX", libBars(40));
    session.subscribeTicker(stockContract("NVDA"));
    pushLast(tws, "NVDA", DELAYED_LAST, 100);
    session.cancelTicker(stockContract("NVDA"), "");
    expect(tws.lines()).toBe(0);
    expect(feedOf(await router.intradayBars("NVDA", "5m"))).toBe("delayed");

    session.subscribeTicker(indexContract("SPX", "CBOE"));
    pushLast(tws, "SPX", TICK.BID, 7000);
    expect(feedOf(await router.intradayBars("SPX", "5m"))).toBe("unknown");
    pushLast(tws, "SPX", DELAYED_LAST, 7000);
    expect(feedOf(await router.intradayBars("SPX", "5m"))).toBe("delayed");
    // 期权的流不记:取 K 线的只有正股与指数
    const option = { secType: "OPT", symbol: "SPX", exchange: "SMART", currency: "USD", conId: 0, lastTradeDateOrContractMonth: "20260814", strike: 7000, right: "C" };
    session.subscribeTicker(option);
    pushLast(tws, "SPX", TICK.LAST, 12.5);
    expect(session.quoteDelayed?.(option)).toBeNull();
  });
});

describe("第一档时长不够就取长的那一档", () => {
  const requests = (tws: FakeTws, symbol: string): number => tws.histRequests.filter((r) => r.symbol === symbol).length;

  it.each([
    [MIN_BARS - 1, 2, "不到最少根数"],
    [MIN_BARS, 2, "正好最少根数:最后一根没走完的话,已收盘的只有 29 根,分析会拒掉"],
    [MIN_BARS + 1, 1, "多一根就够"],
  ])("取回 %i 根 → 一共问 %i 次(%s)", async (count, asked) => {
    const { tws, router } = await connect();
    tws.history.set("NVDA", libBars(count));
    expect(await router.intradayBars("NVDA", "5m")).toHaveLength(count);
    expect(requests(tws, "NVDA")).toBe(asked);
  });
});
