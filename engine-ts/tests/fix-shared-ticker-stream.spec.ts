/** 同一个合约的行情流被两处共用时,一处撤订阅不能让另一处拿着冻住的最后一帧继续判断(2026-09-28)。
 *
 * 会话层的行情流按 合约 + generic ticks 缓存,没有"谁在用"的账。`legQuotes`(AUTO_MID 定价,现订现撤)
 * 订的腿如果正好是持仓里的腿,拿到的是盯盘那条常驻流;它用完 `cancelTicker` 一撤,盯盘手里的句柄还在、
 * 读到的却是撤掉那一刻的盘口,而且不报错——组合净价从此不动,止损 / 跟踪止盈 / 追价平仓都按旧价判断。
 * 给同一只蝶加仓、开一只共用一两个行权价的相邻蝶,都会踩到。盘口页(`orderBook`)对持仓正股是同一回事。
 *
 * 另一条:缓存键以前不带交易类。SPX(月度,AM 结算)与 SPXW 在 20260917 这样的日子同一到期日 /
 * 行权价 / 看涨看跌都存在,后订的那张读到的是先订那张的盘口。
 *
 * 现有的假会话(broker-router / fix-tracker-quotes)不带缓存,测不出这件事。这里会话层用真的 ibSession.ts,
 * 底下垫一个假的 @stoqey/ib(tests/fakeTws.ts):撤掉的订阅不再收 tick,和真的一样。全部离线。
 */
import { describe, expect, it } from "vitest";

import type { IbContract } from "../src/broker.js";
import { createIbApiNextSession, tickerKey } from "../src/ibSession.js";
import type { ContractSpec } from "../src/models.js";
import * as tk from "../src/tracker.js";
import { CFG, EXPIRY, FakeTws, connect, optionLeg, positions, priceOf } from "./fakeTws.js";
import type { Row } from "./fakeTws.js";

/** 一只看涨蝶的开仓指令(买 1 / 卖 2 / 买 1);交易类不写,和模型解析出来的一样 */
function flyOrder(strikes: [number, number, number], tradingClass?: string, expiry = EXPIRY): ContractSpec {
  const leg = (strike: number, action: "BUY" | "SELL", ratio: number): Row => ({
    action, ratio, lastTradeDateOrContractMonth: expiry, strike, right: "C", multiplier: "100",
    ...(tradingClass ? { tradingClass } : {}),
  });
  return {
    secType: "BAG", symbol: "SPX", exchange: "SMART", currency: "USD",
    legs: [leg(strikes[0], "BUY", 1), leg(strikes[1], "SELL", 2), leg(strikes[2], "BUY", 1)],
  } as unknown as ContractSpec;
}

const bagPrice = (rows: Row[]): unknown =>
  tk.withCombos(rows).find((r) => r["sec_type"] === "BAG")?.["market_price"];

/** 持有 7700/7725/7750 看涨蝶,三条腿各有盘口 */
function holdFly(tws: FakeTws): void {
  tws.held = [optionLeg(tws, 7700, 1), optionLeg(tws, 7725, -2), optionLeg(tws, 7750, 1)];
  tws.book.set(tws.conId("SPX", EXPIRY, 7700, "C", "SPXW"), { bid: 30, ask: 30.4 });
  tws.book.set(tws.conId("SPX", EXPIRY, 7725, "C", "SPXW"), { bid: 14, ask: 14.2 });
  tws.book.set(tws.conId("SPX", EXPIRY, 7750, "C", "SPXW"), { bid: 5, ask: 5.2 });
  tws.book.set(tws.conId("SPX", EXPIRY, 7775, "C", "SPXW"), { bid: 1.5, ask: 1.7 });
}

/** 行情动了:三条持仓腿都换了价 */
function moveMarket(tws: FakeTws): void {
  tws.book.set(tws.conId("SPX", EXPIRY, 7700, "C", "SPXW"), { bid: 40, ask: 40.4 });
  tws.book.set(tws.conId("SPX", EXPIRY, 7725, "C", "SPXW"), { bid: 22, ask: 22.2 });
  tws.book.set(tws.conId("SPX", EXPIRY, 7750, "C", "SPXW"), { bid: 9, ask: 9.2 });
}

// 指令里的腿写不写交易类都要对:不写的那种,第一次定价时合约确认会把 SPXW 填上(和持仓腿同一个键),
// 第二次起走 conId 缓存、交易类留空(另一个键,自己一条流)。
describe.each([
  ["腿不写交易类", undefined],
  ["腿写明 SPXW", "SPXW"],
])("legQuotes 与持仓盯盘共用一条腿(%s):定价用完撤订阅,盯盘的价不能冻住", (_name, cls) => {
  const order = (strikes: [number, number, number]): ContractSpec => flyOrder(strikes, cls);

  it("对照:不定价时,持仓腿的价跟着行情走", async () => {
    const tws = new FakeTws();
    holdFly(tws);
    const { router } = await connect(tws);
    expect(priceOf(await positions(router), 7725)).toBe(14.1);
    moveMarket(tws);
    const rows = await positions(router);
    expect(priceOf(rows, 7725)).toBe(22.1);
    expect(bagPrice(rows)).toBe(5.1); // 40.2 − 2 × 22.1 + 9.1
  });

  it("开一只共用两条腿的相邻蝶(7725/7750/7775):定价之后,原来那只蝶的腿价与净价照常更新", async () => {
    const tws = new FakeTws();
    holdFly(tws);
    const { router, account } = await connect(tws);
    const before = await positions(router);
    expect(bagPrice(before)).toBe(7.1); // 30.2 − 2 × 14.1 + 5.1

    const quotes = await router.legQuotes(order([7725, 7750, 7775]), account);
    expect(quotes.map((q) => [q.bid, q.ask])).toEqual([[14, 14.2], [5, 5.2], [1.5, 1.7]]);

    moveMarket(tws);
    const after = await positions(router);
    expect(priceOf(after, 7700)).toBe(40.2); // 没共用的腿
    expect(priceOf(after, 7725)).toBe(22.1); // 共用的腿:以前停在 14.1
    expect(priceOf(after, 7750)).toBe(9.1);  // 共用的腿:以前停在 5.1
    expect(bagPrice(after)).toBe(5.1);       // 以前是 40.2 − 2 × 14.1 + 5.1 = 17.1
  });

  it("给同一只蝶加仓(三条腿全共用):追价平仓读的买卖价也照常更新", async () => {
    const tws = new FakeTws();
    holdFly(tws);
    const { router, account } = await connect(tws);
    await positions(router);
    await router.legQuotes(order([7700, 7725, 7750]), account);

    moveMarket(tws);
    const rows = await positions(router);
    expect(bagPrice(rows)).toBe(5.1);
    const quotes = await router.optionQuotes(rows);
    const byStrike = (strike: number): unknown =>
      quotes[String(rows.find((r) => (r["contract"] as Row | undefined)?.["strike"] === strike)?.["key"])];
    expect(byStrike(7700)).toEqual({ bid: 40, ask: 40.4 });
    expect(byStrike(7725)).toEqual({ bid: 22, ask: 22.2 });
    expect(byStrike(7750)).toEqual({ bid: 9, ask: 9.2 });
  });

  it("连着定价两次(第二次合约确认走缓存),中间和之后的盯盘都拿得到新价", async () => {
    const tws = new FakeTws();
    holdFly(tws);
    const { router, account } = await connect(tws);
    await positions(router);
    await router.legQuotes(order([7725, 7750, 7775]), account);
    await router.legQuotes(order([7725, 7750, 7775]), account);
    moveMarket(tws);
    expect(bagPrice(await positions(router))).toBe(5.1);
    const again = await router.legQuotes(order([7725, 7750, 7775]), account);
    expect(again[0]).toMatchObject({ bid: 22, ask: 22.2 });
    tws.book.set(tws.conId("SPX", EXPIRY, 7725, "C", "SPXW"), { bid: 25, ask: 25.2 });
    expect(priceOf(await positions(router), 7725)).toBe(25.1);
  });

  it("盯盘的节拍器在定价途中插进来一轮(它不走交易道):定价照样拿到盘口,之后盯盘照样拿到新价", async () => {
    const tws = new FakeTws();
    holdFly(tws);
    const { router, account, session } = await connect(tws);
    await positions(router);
    // 上一次定价刚撤掉共用的腿,盯盘还没来得及重订,下一次定价就开始了
    await router.legQuotes(order([7725, 7750, 7775]), account);
    let polled: Row[] | null = null;
    session.settle = async () => {
      tws.pump();
      if (polled !== null) return;
      polled = [];
      polled = await positions(router); // 定价等盘口的那 250 毫秒里,节拍器跑了一轮
    };
    moveMarket(tws);
    const quotes = await router.legQuotes(order([7725, 7750, 7775]), account);
    expect(quotes.map((q) => [q.bid, q.ask])).toEqual([[22, 22.2], [9, 9.2], [1.5, 1.7]]);
    expect(bagPrice(polled ?? [])).toBe(5.1);

    tws.book.set(tws.conId("SPX", EXPIRY, 7725, "C", "SPXW"), { bid: 25, ask: 25.2 });
    expect(priceOf(await positions(router), 7725)).toBe(25.1);
    expect(tws.open(tws.conId("SPX", EXPIRY, 7775, "C", "SPXW"))).toHaveLength(0);
  });

  it("行情线路不漏:定价只为自己订的那条腿(7775)用完就撤,持仓腿各占一条", async () => {
    const tws = new FakeTws();
    holdFly(tws);
    const { router, account } = await connect(tws);
    await positions(router);
    await router.legQuotes(order([7725, 7750, 7775]), account);
    await positions(router);
    expect(tws.open(tws.conId("SPX", EXPIRY, 7775, "C", "SPXW"))).toHaveLength(0);
    for (const strike of [7700, 7725, 7750]) {
      expect(tws.open(tws.conId("SPX", EXPIRY, strike, "C", "SPXW")), `${strike}C`).toHaveLength(1);
    }
  });
});

describe("盘口页与持仓正股共用一条流:看一眼盘口,持仓现价不能冻住", () => {
  it("orderBook 用完撤掉自己那条之后,持仓正股的现价照常更新", async () => {
    const tws = new FakeTws();
    const be = tws.conId("BE");
    tws.held = [{ pos: 100, avgCost: 20, contract: { conId: be, symbol: "BE", secType: "STK" } }];
    tws.book.set(be, { bid: 30.9, ask: 31.1, last: 31 });
    const { router, session } = await connect(tws);
    session.mktDepth = async () => ({ bids: [], asks: [] });
    expect((await positions(router))[0]?.["market_price"]).toBe(31);

    await router.orderBook("BE");
    tws.book.set(be, { bid: 27.9, ask: 28.1, last: 28 });
    expect((await positions(router))[0]?.["market_price"]).toBe(28); // 以前停在 31
    expect(tws.open(be)).toHaveLength(1);
  });
});

describe("盘口页与标的现价共用一条流:标的目标价拿来判断的现价不能冻住", () => {
  it("indexPrice 不看 error、只看有没有价:被撤掉之后读不到价,当场重订", async () => {
    const tws = new FakeTws();
    const aapl = tws.conId("AAPL");
    tws.book.set(aapl, { bid: 199.9, ask: 200.1, last: 200 });
    const { router, session } = await connect(tws);
    session.mktDepth = async () => ({ bids: [], asks: [] });
    expect(await router.indexPrice("AAPL")).toBe(200);

    await router.orderBook("AAPL");
    tws.book.set(aapl, { bid: 189.9, ask: 190.1, last: 190 });
    expect(await router.indexPrice("AAPL")).toBe(190); // 以前停在 200
    expect(tws.open(aapl)).toHaveLength(1);
  });
});

describe("会话层:被撤掉的流不拿最后一帧冒充现价", () => {
  const opt = (strike: number, tradingClass = "SPXW", expiry = EXPIRY): IbContract => ({
    secType: "OPT", symbol: "SPX", exchange: "SMART", currency: "USD",
    lastTradeDateOrContractMonth: expiry, strike, right: "C", multiplier: "100", tradingClass, conId: 0,
  });

  it("同一条流两个句柄,一处撤掉:另一个句柄读到的是空盘口 + error,不是撤掉那一刻的价", async () => {
    const tws = new FakeTws();
    const session = await createIbApiNextSession(CFG, { mod: tws.mod() });
    const leg = opt(7725);
    await session.qualifyContracts([leg], 1000);
    tws.book.set(leg.conId ?? 0, { bid: 14, ask: 14.2 });
    const tracker = session.subscribeTicker(leg);
    const pricing = session.subscribeTicker({ ...leg });
    tws.pump();
    expect(tracker.read()).toMatchObject({ bid: 14, ask: 14.2, error: null });

    session.cancelTicker(leg);
    expect(pricing.read().error).toBeTruthy();
    const stale = tracker.read();
    expect(stale.error).toBeTruthy();
    expect(Number.isNaN(stale.bid) && Number.isNaN(stale.ask)).toBe(true);
    expect(stale.last).toBeNull();

    // 重新订:新的一条流,新句柄正常;旧句柄不会活过来
    const fresh = session.subscribeTicker(leg);
    tws.book.set(leg.conId ?? 0, { bid: 22, ask: 22.2 });
    tws.pump();
    expect(fresh.read()).toMatchObject({ bid: 22, ask: 22.2, error: null });
    expect(tracker.read().error).toBeTruthy();
  });

  it("被 TWS 拒掉的流照旧:error 是 TWS 的原文", async () => {
    const tws = new FakeTws();
    let reject: ((e: unknown) => void) | null = null;
    const mod = tws.mod() as { IBApiNext: { prototype: Record<string, unknown> } };
    mod.IBApiNext.prototype["getMarketData"] = () => ({
      subscribe: (o: { error(e: unknown): void }) => {
        reject = o.error;
        return { unsubscribe: () => undefined };
      },
    });
    const session = await createIbApiNextSession(CFG, { mod });
    const handle = session.subscribeTicker(opt(7725));
    (reject as ((e: unknown) => void) | null)?.({ code: 10197, message: "No market data during competing live session" });
    expect(handle.read().error).toMatch(/^10197 /);
  });
});

describe("缓存键带交易类:SPX(月度)与 SPXW 同一到期日 / 行权价 / 看涨看跌,各是各的流", () => {
  const DAY = "20260917"; // 两条链上都有这个到期日(见 pickTradingClass 的注释)
  const base7700 = (expiry: string): IbContract => ({
    secType: "OPT", symbol: "SPX", exchange: "SMART", currency: "USD",
    lastTradeDateOrContractMonth: expiry, strike: 7700, right: "C", multiplier: "100", conId: 0,
  });

  it("缓存键:写了交易类的期权带上它;没写的、正股的键不变", () => {
    const base: IbContract = {
      secType: "OPT", symbol: "SPX", exchange: "SMART", currency: "USD",
      lastTradeDateOrContractMonth: DAY, strike: 7700, right: "C",
    };
    expect(tickerKey(base)).toBe("OPT|SPX|20260917|7700|C");
    expect(tickerKey({ ...base, tradingClass: "" })).toBe("OPT|SPX|20260917|7700|C");
    expect(tickerKey({ ...base, tradingClass: "SPXW" })).not.toBe(tickerKey({ ...base, tradingClass: "SPX" }));
    expect(tickerKey({ ...base, tradingClass: "SPXW" }, "100,101,106").endsWith("#100,101,106")).toBe(true);
    // 正股的交易类(NMS 之类)只在真去确认过的那个对象上有,不进键:同一只股始终是同一条流
    const stock: IbContract = { secType: "STK", symbol: "AAPL", exchange: "SMART", currency: "USD" };
    expect(tickerKey({ ...stock, tradingClass: "NMS" })).toBe(tickerKey(stock));
  });

  it("撤订阅按自己的交易类撤:撤 SPX 那张不碰 SPXW 那张,带 generic 的变体跟着自己那张走", async () => {
    const tws = new FakeTws();
    const session = await createIbApiNextSession(CFG, { mod: tws.mod() });
    const spx: IbContract = { ...base7700(DAY), tradingClass: "SPX" };
    const spxw: IbContract = { ...base7700(DAY), tradingClass: "SPXW" };
    await session.qualifyContracts([spx, spxw], 1000);
    session.subscribeTicker(spx);
    session.subscribeTicker(spx, "100,101,106");
    const weekly = session.subscribeTicker(spxw);
    session.cancelTicker(spx);
    expect(tws.open(spx.conId ?? 0)).toHaveLength(0);
    expect(tws.open(spxw.conId ?? 0)).toHaveLength(1);
    expect(weekly.read().error).toBeNull();
  });

  it("持有 SPXW 的腿,给 SPX 月度的同一行权价定价:拿到的是 SPX 那张的盘口", async () => {
    const tws = new FakeTws();
    tws.held = [7700, 7725, 7750].map((k, i) => optionLeg(tws, k, i === 1 ? -2 : 1, "SPXW", DAY));
    for (const [i, strike] of [7700, 7725, 7750].entries()) {
      tws.book.set(tws.conId("SPX", DAY, strike, "C", "SPXW"), { bid: 10 + i, ask: 10.2 + i });
      tws.book.set(tws.conId("SPX", DAY, strike, "C", "SPX"), { bid: 50 + i, ask: 50.4 + i });
    }
    const { router, account } = await connect(tws);
    expect(priceOf(await positions(router), 7700)).toBe(10.1);

    const quotes = await router.legQuotes(flyOrder([7700, 7725, 7750], "SPX", DAY), account);
    expect(quotes.map((q) => q.bid)).toEqual([50, 51, 52]); // 以前是 SPXW 的 10 / 11 / 12

    tws.book.set(tws.conId("SPX", DAY, 7700, "C", "SPXW"), { bid: 12, ask: 12.2 });
    expect(priceOf(await positions(router), 7700)).toBe(12.1);
  });
});
