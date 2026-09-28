/** 平掉的持仓不能一直占着行情线路(2026-09-28)。
 *
 * 盯盘给每条持仓期权腿、每只持仓正股各留一条常驻订阅(`BrokerRouter` 的 `optionStreams` / `stockStreams`)。
 * 以前只在句柄读到 `error`、或者断开连接时才清:腿平掉了,订阅还在。IBKR 的行情线路大约 100 条,
 * 漏光之后 TWS 对新请求回 101,所有报价都是 NaN(2026-09-04 纸面账户见过,见 `legQuotes` 上面的注释)。
 * 做 0DTE 蝶的一天开平几十只、一只三条腿,漏到重连为止。
 *
 * 反过来的那一半一样要钉住:**读不到持仓 ≠ 平仓了**(docs/features/tracker.md)。读不到的那一轮一条都不能撤。
 *
 * 会话层用真的 ibSession.ts、路由用真的 BrokerRouter,底下垫假的 @stoqey/ib(tests/fakeTws.ts)。全部离线。
 */
import { describe, expect, it } from "vitest";

import { BrokerRouter } from "../src/broker.js";
import type { IbContract } from "../src/broker.js";
import { createIbApiNextSession } from "../src/ibSession.js";
import { loadGolden, makeSettings } from "./util.js";
import { ACCOUNT, CFG, EXPIRY, FakeTws, connect, optionLeg, positions, priceOf } from "./fakeTws.js";
import type { Held } from "./fakeTws.js";

const LIVE_ACCOUNT = "U1234567"; // 配置里的「主账户」

const optId = (tws: FakeTws, strike: number): number => tws.conId("SPX", EXPIRY, strike, "C", "SPXW");

/** 一只看涨蝶的三条腿(买 1 / 卖 2 / 买 1),各有盘口 */
function fly(tws: FakeTws, center: number, width = 25): Held[] {
  const legs = [optionLeg(tws, center - width, 1), optionLeg(tws, center, -2), optionLeg(tws, center + width, 1)];
  for (const [i, leg] of legs.entries()) {
    tws.book.set(Number(leg.contract["conId"]), { bid: 30 - 12 * i, ask: 30.4 - 12 * i });
  }
  return legs;
}

function stock(tws: FakeTws, symbol: string, last: number, account?: string): Held {
  const conId = tws.conId(symbol);
  tws.book.set(conId, { bid: last - 0.1, ask: last + 0.1, last });
  return { pos: 100, avgCost: 20, contract: { conId, symbol, secType: "STK" }, ...(account ? { account } : {}) };
}

describe("平掉的期权腿撤订阅", () => {
  it("蝶平掉之后,三条腿都不再占行情线路", async () => {
    const tws = new FakeTws();
    const legs = fly(tws, 7725);
    tws.held = legs;
    const { router } = await connect(tws);
    expect(priceOf(await positions(router), 7725)).toBe(18.2);
    expect(tws.lines()).toBe(3);

    tws.flatten(...legs);
    expect(await positions(router)).toEqual([]);
    for (const strike of [7700, 7725, 7750]) expect(tws.open(optId(tws, strike)), `${strike}C`).toHaveLength(0);
    expect(tws.lines()).toBe(0);
  });

  it("一天开平 40 只蝶(行权价各不相同):线路不往 100 条的额度上累积", async () => {
    const tws = new FakeTws();
    const { router } = await connect(tws);
    let peak = 0;
    for (let i = 0; i < 40; i += 1) {
      const legs = fly(tws, 6000 + 100 * i);
      tws.fill(...legs);
      expect(await positions(router)).toHaveLength(3);
      peak = Math.max(peak, tws.lines());
      tws.flatten(...legs);
      await positions(router);
    }
    expect(peak).toBe(3);        // 以前一路涨到 120
    expect(tws.lines()).toBe(0);
  });

  it("只平掉一只蝶:它的腿撤掉,另一只的订阅原样留着(不撤、不重订),价照常更新", async () => {
    const tws = new FakeTws();
    const near = fly(tws, 7725), far = fly(tws, 7900);
    tws.held = [...near, ...far];
    const { router } = await connect(tws);
    await positions(router);
    const kept = [7875, 7900, 7925].map((k) => tws.open(optId(tws, k))[0]);
    expect(tws.lines()).toBe(6);

    tws.flatten(...near);
    tws.book.set(optId(tws, 7900), { bid: 22, ask: 22.2 });
    const rows = await positions(router);
    expect(rows).toHaveLength(3);
    expect(priceOf(rows, 7900)).toBe(22.1);
    expect(tws.lines()).toBe(3);
    expect([7875, 7900, 7925].map((k) => tws.open(optId(tws, k))[0])).toEqual(kept);
    expect(tws.subs).toHaveLength(6); // 没有多订过
  });

  it("相邻的两只蝶共用行权价,平掉一只:共用的那条腿另一只还在用,不撤", async () => {
    const tws = new FakeTws();
    // 7700/7725/7750 与 7725/7750/7775:7725、7750 两张合约上各有两笔净下来的仓,TWS 按合约报一行
    const legs = [optionLeg(tws, 7700, 1), optionLeg(tws, 7725, -1), optionLeg(tws, 7750, -1), optionLeg(tws, 7775, 1)];
    for (const [i, leg] of legs.entries()) tws.book.set(Number(leg.contract["conId"]), { bid: 30 - 8 * i, ask: 30.4 - 8 * i });
    tws.held = legs;
    const { router } = await connect(tws);
    await positions(router);
    expect(tws.lines()).toBe(4);

    tws.flatten(legs[0]!, legs[3]!);
    const rows = await positions(router);
    expect(rows).toHaveLength(2);
    expect(priceOf(rows, 7725)).toBe(22.2);
    expect(tws.open(optId(tws, 7700))).toHaveLength(0);
    expect(tws.open(optId(tws, 7775))).toHaveLength(0);
    expect(tws.lines()).toBe(2);
  });

  it("平掉之后又开回同一只蝶:重新订上,价是现在的", async () => {
    const tws = new FakeTws();
    const legs = fly(tws, 7725);
    tws.held = legs;
    const { router } = await connect(tws);
    await positions(router);
    tws.flatten(...legs);
    await positions(router);
    expect(tws.lines()).toBe(0);

    tws.book.set(optId(tws, 7725), { bid: 25, ask: 25.2 });
    tws.fill(...legs);
    expect(priceOf(await positions(router), 7725)).toBe(25.1);
    expect(tws.lines()).toBe(3);
  });

  it("两个账户持有同一条腿,一个平了:另一个还在用的那条流不撤、不重订", async () => {
    const tws = new FakeTws();
    const mine = fly(tws, 7725);
    const theirs = fly(tws, 7725).map((leg) => ({ ...leg, account: LIVE_ACCOUNT }));
    tws.held = [...mine, ...theirs];
    const { router } = await connect(tws);
    expect(await positions(router)).toHaveLength(6);
    expect(tws.lines()).toBe(3); // 同一张合约一条流

    tws.flatten(...mine);
    tws.book.set(optId(tws, 7725), { bid: 22, ask: 22.2 });
    const rows = await positions(router);
    expect(rows.map((r) => r["account"])).toEqual(["主账户", "主账户", "主账户"]);
    expect(priceOf(rows, 7725)).toBe(22.1);
    expect(tws.lines()).toBe(3);
    expect(tws.subs).toHaveLength(3);

    tws.flatten(...theirs);
    await positions(router);
    expect(tws.lines()).toBe(0);
  });

  it("盯盘那条已经被别处撤掉了(句柄读到 error):平仓时不去撤同一个键上别人后来订的流", async () => {
    const tws = new FakeTws();
    const legs = fly(tws, 7725);
    tws.held = legs;
    const { router, session } = await connect(tws);
    await positions(router);

    // 定价这类现订现撤的:先把共用的那条撤了,接着又订上一条自己的(还在用)
    const leg: IbContract = {
      secType: "OPT", symbol: "SPX", exchange: "SMART", currency: "USD",
      lastTradeDateOrContractMonth: EXPIRY, strike: 7725, right: "C", multiplier: "100", tradingClass: "SPXW", conId: 0,
    };
    await session.qualifyContracts([leg], 1000);
    session.cancelTicker(leg);
    const theirs = session.subscribeTicker(leg);

    tws.flatten(...legs);
    await positions(router);
    expect(theirs.read().error).toBeNull();
    expect(tws.open(optId(tws, 7725))).toHaveLength(1);
    expect(tws.lines()).toBe(1); // 另外两条腿撤了
  });
});

describe("平掉的持仓正股撤订阅", () => {
  it("正股平掉之后不再占行情线路", async () => {
    const tws = new FakeTws();
    const be = stock(tws, "BE", 31);
    tws.held = [be];
    const { router } = await connect(tws);
    expect((await positions(router))[0]?.["market_price"]).toBe(31);
    expect(tws.open(tws.conId("BE"))).toHaveLength(1);

    tws.flatten(be);
    expect(await positions(router)).toEqual([]);
    expect(tws.open(tws.conId("BE"))).toHaveLength(0);
  });

  it("两个账户都持有 BE,一个平了:流还留着", async () => {
    const tws = new FakeTws();
    const mine = stock(tws, "BE", 31), theirs = stock(tws, "BE", 31, LIVE_ACCOUNT);
    tws.held = [mine, theirs];
    const { router } = await connect(tws);
    await positions(router);
    tws.flatten(mine);
    tws.book.set(tws.conId("BE"), { bid: 27.9, ask: 28.1, last: 28 });
    expect((await positions(router)).map((r) => r["market_price"])).toEqual([28]);
    expect(tws.subs).toHaveLength(1);
    expect(tws.lines()).toBe(1);
  });

  it("只撤不带 generic 的那条:异动监控给同一只股订的量能流不受影响", async () => {
    const tws = new FakeTws();
    const be = stock(tws, "BE", 31);
    tws.held = [be];
    const { router } = await connect(tws);
    await positions(router);
    await router.volumeQuotes(["BE"]);
    expect(tws.open(tws.conId("BE")).map((s) => s.generic).sort()).toEqual(["", BrokerRouter.VOLUME_TICKS]);

    tws.flatten(be);
    await positions(router);
    expect(tws.open(tws.conId("BE")).map((s) => s.generic)).toEqual([BrokerRouter.VOLUME_TICKS]);
    tws.book.set(tws.conId("BE"), { bid: 27.9, ask: 28.1, last: 28 });
    expect((await router.volumeQuotes(["BE"]))["BE"]).toMatchObject({ last: 28 });
    expect((await router.volumeQuotes(["BE"]))["BE"]?.error).toBeUndefined();
  });

  it("顶栏行情带也在用这只股的流:平仓不撤它(行情带不会自己重订),行情带的价照常更新", async () => {
    const tws = new FakeTws();
    const be = stock(tws, "BE", 31);
    tws.held = [be];
    const { router } = await connect(tws);
    await positions(router);
    expect((await router.streamQuotes(["BE"]))["BE"]).toMatchObject({ last: 31 });

    tws.flatten(be);
    await positions(router);
    tws.book.set(tws.conId("BE"), { bid: 27.9, ask: 28.1, last: 28 });
    expect((await router.streamQuotes(["BE"]))["BE"]).toMatchObject({ last: 28 });
    expect(tws.open(tws.conId("BE"))).toHaveLength(1);
  });

  it("标的现价(indexPrice)也在用这只股的流:平仓不撤它", async () => {
    const tws = new FakeTws();
    const be = stock(tws, "BE", 31);
    tws.held = [be];
    const { router } = await connect(tws);
    await positions(router);
    expect(await router.indexPrice("BE")).toBe(31);

    tws.flatten(be);
    await positions(router);
    tws.book.set(tws.conId("BE"), { bid: 27.9, ask: 28.1, last: 28 });
    tws.pump(); // 流是热的时候 indexPrice 直接读缓存、不等行情,假 TWS 得自己推这一轮
    expect(await router.indexPrice("BE")).toBe(28);
    expect(tws.subs).toHaveLength(1); // 没撤过、没重订过
  });
});

describe("读不到持仓 ≠ 平仓了:读不到的那一轮一条订阅都不撤", () => {
  it("读持仓报错(推送卡住):整轮报错,订阅原样;恢复之后价照常、没有重订过", async () => {
    const tws = new FakeTws();
    const legs = fly(tws, 7725);
    tws.held = [...legs, stock(tws, "BE", 31)];
    const { router, session } = await connect(tws);
    await positions(router);
    expect(tws.lines()).toBe(4);

    const read = session.positions;
    session.positions = async () => { throw new Error("TWS 在 8 秒内没有推送持仓,本轮读不到持仓"); };
    await expect(router.positions()).rejects.toThrow(/读不到持仓/);
    expect(tws.lines()).toBe(4);

    session.positions = read;
    tws.book.set(optId(tws, 7725), { bid: 22, ask: 22.2 });
    expect(priceOf(await positions(router), 7725)).toBe(22.1);
    expect(tws.lines()).toBe(4);
    expect(tws.subs).toHaveLength(4);
  });

  it("本机到 TWS 的连接断着:读持仓报错,订阅原样", async () => {
    const tws = new FakeTws();
    tws.held = fly(tws, 7725);
    const { router, session } = await connect(tws);
    await positions(router);

    session.isConnected = () => false;
    await expect(router.positions()).rejects.toThrow(/已断开/);
    expect(tws.lines()).toBe(3);
  });

  it("两条连接里有一条断着(它那个账户的仓这一轮看不见):看不见的仓不当成平了,一条都不撤", async () => {
    const tws = new FakeTws();
    tws.held = fly(tws, 7725);
    const other = new FakeTws();
    other.held = fly(tws, 7900).map((leg) => ({ ...leg, account: LIVE_ACCOUNT }));

    // 纸面连接管 ACCOUNT,实盘连接管主账户;持仓的行情流都订在第一条连着的会话(纸面)上
    const paper = await createIbApiNextSession(CFG, { mod: tws.mod() });
    paper.settle = async () => tws.pump();
    const live = await createIbApiNextSession({ ...CFG, port: 7496 }, { mod: other.mod() });
    live.settle = async () => other.pump();
    live.managedAccounts = () => [LIVE_ACCOUNT];
    const settings = makeSettings(loadGolden("config").base_config);
    const router = new BrokerRouter(settings, async (cfg) => (cfg.port === 7496 ? live : paper));
    await router.connect("paper");
    await router.connect("live");

    expect(await positions(router)).toHaveLength(6);
    const before = tws.lines();
    expect(before).toBe(6);

    live.isConnected = () => false;
    expect(await positions(router)).toHaveLength(3); // 主账户的仓这一轮看不见
    expect(tws.lines()).toBe(before);

    live.isConnected = () => true;
    expect(await positions(router)).toHaveLength(6);
    expect(tws.lines()).toBe(before);
    expect(tws.subs).toHaveLength(before);
  });
});

describe("对照:账户配置与假 TWS 对得上", () => {
  it("ACCOUNT 是配置里的纸面账户,LIVE_ACCOUNT 是主账户", () => {
    const settings = makeSettings(loadGolden("config").base_config);
    expect(settings.accounts.map((a) => [a.account_id, a.alias])).toEqual([[ACCOUNT, "模拟"], [LIVE_ACCOUNT, "主账户"]]);
  });
});
