/** 连着却不来盘口的行情流要重订(2026-09-29 真机)。
 *
 * 那天美东 13:24 连接断了 5 秒又连回来,之后 IV 记录里所有腿的盘口都是空的、模型 IV 一连三笔一模一样。
 * 会话层在断开时把每条流清空,重连后靠 @stoqey/ib 自己按原 reqId 重订;常驻订阅那几处(持仓腿、持仓正股、
 * 测算的流)只在句柄读到 error 时才重订。TWS 重订了却一直不给的流不报错,就永远是空的:盯盘每一轮都是
 * 「拿不到现价,本轮不判断」,跟踪止损、利润回撤永远不触发。不断线、流自己没了动静的,读到的是冻住的最后一个价。
 * 那天的根因是电脑合盖睡着了(docs/journal/stale-streams-after-sleep.md),这里钉的是"醒来 / 重连之后没恢复"那一半。
 *
 * 第一段用**真的** IBApiNext(只把最底下的 socket 控制器换成假的),钉住库在重连时到底做了什么;第二段是真的会话 +
 * 真的路由 + 假的 TWS(tests/fakeTws.ts);第三段是测算那批流(optionMarks.ts)。全部离线。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrokerRouter } from "../src/broker.js";
import { HeldStreams, quoteSilenceMs, silenceLimitMs } from "../src/heldStreams.js";
import type { IbContract, IbSession, TickerData, TickerHandle } from "../src/ibTypes.js";
import { OptionMarkStreams } from "../src/optionMarks.js";
import type { OptionLegSpec } from "../src/optionMarks.js";
import { LIVE_ACCOUNT, realSession } from "./fakeController.js";
import type { Emitter } from "./fakeController.js";
import { ACCOUNT, EXPIRY, FakeTws, connect, optionLeg, positions, priceOf } from "./fakeTws.js";
import type { Held } from "./fakeTws.js";

/** 2026-09-29 是周二;九月是夏令时 */
const et = (hhmm: string, day = "2026-09-29"): number => Date.parse(`${day}T${hhmm}:00-04:00`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(et("13:20"));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true); // 重订的日志;要看的那一条用 stderrLines() 接
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// 第一段:真的 IBApiNext
// ---------------------------------------------------------------------------------------------

/** 真的 IBApiNext + 假的 Controller:见 tests/fakeController.ts */

const LEG: IbContract = {
  secType: "OPT", symbol: "SPX", exchange: "SMART", currency: "USD", lastTradeDateOrContractMonth: "20260929",
  strike: 7610, right: "P", tradingClass: "SPXW", conId: 880001,
};

/** TWS 的几种回话(tickPrice 的 field:1 买 2 卖 9 昨收;tickOptionComputation 的 13 = 模型) */
const quote = (tws: Emitter, reqId: number, bid: number, ask: number): void => {
  tws.emit("tickPrice", reqId, 1, bid, {});
  tws.emit("tickPrice", reqId, 2, ask, {});
};
const modelIv = (tws: Emitter, reqId: number, iv: number): void => {
  tws.emit("tickOptionComputation", reqId, 13, 0, iv, -0.05, 0.4, 0, 0.001, 0.1, -0.3, 7659.31);
};

describe("会话层(真的 IBApiNext):重连之后库做了什么", () => {
  it("TWS 断开(1100)→ 五秒后重连:库按原 reqId 重订,行情类型基线排在它前面", async () => {
    const { session, ctl, tws } = await realSession();
    session.subscribeTicker(LEG);
    const [reqId] = ctl.mktReqs();
    quote(tws, reqId!, 0.35, 0.4);
    ctl.sent = [];

    tws.emit("info", "Connectivity between IB and Trader Workstation has been lost.", 1100);
    expect(session.isConnected()).toBe(false);
    expect(ctl.sent).toEqual([]); // 断着的时候不发撤订阅
    await vi.advanceTimersByTimeAsync(5_000);
    expect(session.isConnected()).toBe(true);
    // reqId 在一条新连接上重用是合法的(TWS 的 reqId 按连接算);基线先于重订
    expect(ctl.sent.map((s) => s[0])).toEqual(["reqMarketDataType", "reqManagedAccts", "reqMktData"]);
    expect(ctl.mktReqs()).toEqual([reqId]);
  });

  it("重订了、TWS 只回一笔模型 IV:句柄不报错,盘口一直是空的——一小时后还是这样(09-29 的样子)", async () => {
    const { session, ctl, tws } = await realSession();
    const handle = session.subscribeTicker(LEG);
    const [reqId] = ctl.mktReqs();
    quote(tws, reqId!, 0.35, 0.4);
    modelIv(tws, reqId!, 0.2035);
    expect(handle.read()).toMatchObject({ bid: 0.35, ask: 0.4, error: null });

    tws.emit("info", "lost", 1100);
    await vi.advanceTimersByTimeAsync(5_000);
    modelIv(tws, reqId!, 0.2057);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const t = handle.read();
    expect(t.bid).toBeNaN();
    expect(t.ask).toBeNaN();
    expect(t.modelGreeks?.impliedVol).toBe(0.2057);
    expect(t.error).toBeNull(); // 常驻订阅那几处以前只认 error:这条永远不会被重订
    const held = new HeldStreams();
    held.set("opt:x", { handle, contract: LEG, session });
    expect(held.usable(session, "opt:x")).toBe(true); // 不给时限 = 老规矩:它算"能用"
  });

  it("时刻:订上 / 重连那一刻起算;只有盘口 tick 刷新 quotedAt,模型 IV 与昨收不算", async () => {
    const { session, ctl, tws } = await realSession();
    const t0 = Date.now();
    const handle = session.subscribeTicker(LEG);
    const [reqId] = ctl.mktReqs();
    expect(handle.read()).toMatchObject({ requestedAt: t0, quotedAt: null });

    vi.setSystemTime(t0 + 3_000);
    modelIv(tws, reqId!, 0.2);
    tws.emit("tickPrice", reqId, 9, 0.5, {}); // 昨收
    expect(handle.read().quotedAt).toBeNull();
    tws.emit("tickSize", reqId, 0, 12); // 买量也算
    expect(handle.read().quotedAt).toBe(t0 + 3_000);

    vi.setSystemTime(et("13:24"));
    tws.emit("info", "lost", 1100);
    expect(handle.read()).toMatchObject({ requestedAt: null, quotedAt: null }); // 断开:清空
    await vi.advanceTimersByTimeAsync(5_000);
    expect(handle.read()).toMatchObject({ requestedAt: et("13:24") + 5_000, quotedAt: null });
    expect(quoteSilenceMs(handle.read(), et("13:24") + 40_000)).toBe(35_000);
  });

  it("持仓的账本按时限重订:撤掉旧 reqId、换一个新的,盘口回来", async () => {
    const { session, ctl, tws } = await realSession();
    const held = new HeldStreams();
    const qualifies = async (): Promise<boolean> => true;
    expect(await held.ensure(session, "opt:leg", () => ({ ...LEG }), qualifies, 30_000)).toBe(true);
    const [first] = ctl.mktReqs();
    quote(tws, first!, 0.35, 0.4);

    tws.emit("info", "lost", 1100);
    await vi.advanceTimersByTimeAsync(5_000);
    modelIv(tws, first!, 0.2057); // TWS 只给这一笔
    ctl.sent = [];
    vi.setSystemTime(Date.now() + 29_000);
    expect(await held.ensure(session, "opt:leg", () => ({ ...LEG }), qualifies, 30_000)).toBe(false); // 没到时限
    vi.setSystemTime(Date.now() + 1_000);
    expect(await held.ensure(session, "opt:leg", () => ({ ...LEG }), qualifies, 30_000)).toBe(true);
    expect(ctl.sent.map((s) => s[0])).toEqual(["cancelMktData", "reqMktData"]);
    expect(ctl.sent[0]![1]).toBe(first);
    const second = Number(ctl.sent[1]![1]);
    expect(second).not.toBe(first);

    quote(tws, first!, 9.9, 9.9); // 旧 reqId 上迟到的 tick 没人收
    quote(tws, second, 0.3, 0.35);
    expect(held.get("opt:leg")!.handle!.read()).toMatchObject({ bid: 0.3, ask: 0.35, error: null });
    expect(await held.ensure(session, "opt:leg", () => ({ ...LEG }), qualifies, 30_000)).toBe(false);
  });

  it("断着的时候不判:重订了也发不出去,等库连回来自己重订", async () => {
    const { session, ctl, tws } = await realSession();
    const held = new HeldStreams();
    await held.ensure(session, "opt:leg", () => ({ ...LEG }), async () => true, 30_000);
    tws.emit("info", "lost", 1100);
    vi.setSystemTime(Date.now() + 10 * 60_000); // 连不上的十分钟(timers 不走:库还没开始重连)
    ctl.sent = [];
    expect(held.usable(session, "opt:leg", 30_000)).toBe(true);
    expect(ctl.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 第二段:真的会话 + 真的路由 + 假的 TWS
// ---------------------------------------------------------------------------------------------

const optId = (tws: FakeTws, strike: number): number => tws.conId("SPX", EXPIRY, strike, "C", "SPXW");

function fly(tws: FakeTws, center: number): Held[] {
  const legs = [optionLeg(tws, center - 25, 1), optionLeg(tws, center, -2), optionLeg(tws, center + 25, 1)];
  for (const [i, leg] of legs.entries()) tws.book.set(Number(leg.contract["conId"]), { bid: 30 - 12 * i, ask: 30.4 - 12 * i });
  return legs;
}

/** 此刻开着的订阅从此一笔 tick 都收不到了(TWS 那头这条流死了,不报错);之后新订的照常 */
function silence(tws: FakeTws): void {
  for (const sub of tws.subs) sub.next = () => undefined;
}

/** 捕获会话 / 账本写的日志 */
function stderrLines(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  return lines;
}

describe("持仓腿与持仓正股(真的会话 + 路由)", () => {
  it("盘中:流连着却半分钟没来盘口 → 撤掉重订,价回到现在的;没到半分钟不动", async () => {
    const tws = new FakeTws();
    tws.held = fly(tws, 7725);
    const { router } = await connect(tws);
    expect(priceOf(await positions(router), 7725)).toBe(18.2);
    silence(tws);
    tws.book.set(optId(tws, 7725), { bid: 22, ask: 22.2 });

    vi.setSystemTime(Date.now() + 29_000);
    expect(priceOf(await positions(router), 7725)).toBe(18.2); // 冻住的最后一个价:还没到时限
    expect(tws.subs).toHaveLength(3);

    vi.setSystemTime(Date.now() + 1_000);
    expect(priceOf(await positions(router), 7725)).toBe(22.1);
    expect(tws.subs).toHaveLength(6);
    expect(tws.lines()).toBe(3); // 旧的三条撤掉了
    expect(tws.subs.slice(3).map((s) => s.generic)).toEqual(["", "", ""]);
  });

  it("休市:再久没盘口也不重订(本来就不跳)", async () => {
    vi.setSystemTime(et("21:30"));
    const tws = new FakeTws();
    tws.held = fly(tws, 7725);
    const { router } = await connect(tws);
    await positions(router);
    silence(tws);
    vi.setSystemTime(Date.now() + 60 * 60_000);
    await positions(router);
    expect(tws.subs).toHaveLength(3);
  });

  it("盘后放宽到两分钟", async () => {
    vi.setSystemTime(et("16:30"));
    const tws = new FakeTws();
    const conId = tws.conId("BE");
    tws.book.set(conId, { bid: 30.9, ask: 31.1, last: 31 });
    tws.held = [{ pos: 100, avgCost: 20, contract: { conId, symbol: "BE", secType: "STK" } }];
    const { router } = await connect(tws);
    await positions(router);
    silence(tws);
    vi.setSystemTime(Date.now() + 90_000);
    await positions(router);
    expect(tws.subs).toHaveLength(1);
    vi.setSystemTime(Date.now() + 30_000);
    await positions(router);
    expect(tws.subs).toHaveLength(2);
  });

  it("正股同样;只撤不带 generic 的那条,异动监控的量能流不受影响", async () => {
    const tws = new FakeTws();
    const conId = tws.conId("BE");
    tws.book.set(conId, { bid: 30.9, ask: 31.1, last: 31 });
    tws.held = [{ pos: 100, avgCost: 20, contract: { conId, symbol: "BE", secType: "STK" } }];
    const { router } = await connect(tws);
    await positions(router);
    await router.volumeQuotes(["BE"]);
    silence(tws);
    tws.book.set(conId, { bid: 27.9, ask: 28.1, last: 28 });
    vi.setSystemTime(Date.now() + 31_000);
    expect((await positions(router)).map((r) => r["market_price"])).toEqual([28]);
    expect(tws.open(conId).map((s) => s.generic).sort()).toEqual(["", BrokerRouter.VOLUME_TICKS]);
    expect(tws.subs.filter((s) => s.generic === BrokerRouter.VOLUME_TICKS)).toHaveLength(1);
  });

  it("两个账户持有同一只蝶、流一起没了动静:每张合约只重订一次,之后两边读同一条,不互相撤", async () => {
    const tws = new FakeTws();
    tws.held = [...fly(tws, 7725), ...fly(tws, 7725).map((leg) => ({ ...leg, account: LIVE_ACCOUNT }))];
    const { router } = await connect(tws);
    await positions(router);
    expect(tws.subs).toHaveLength(3);
    silence(tws);
    tws.book.set(optId(tws, 7725), { bid: 22, ask: 22.2 });
    vi.setSystemTime(Date.now() + 31_000);
    for (let round = 0; round < 5; round += 1) {
      const rows = await positions(router);
      expect(rows.filter((r) => (r["contract"] as Record<string, unknown>)["strike"] === 7725).map((r) => r["market_price"]))
        .toEqual([22.1, 22.1]);
      vi.setSystemTime(Date.now() + 1_000);
    }
    expect(tws.subs).toHaveLength(6);
    expect(tws.lines()).toBe(3);
  });

  it("两个账户同一条腿、流被别处撤掉(句柄读到 error):重订一次就稳住,不再每一轮互相撤", async () => {
    const tws = new FakeTws();
    tws.held = [...fly(tws, 7725), ...fly(tws, 7725).map((leg) => ({ ...leg, account: LIVE_ACCOUNT }))];
    const { router, session } = await connect(tws);
    await positions(router);
    // 下单定价、盘口页这些临时订阅用完一撤,撤掉的正是盯盘那条(不传 generic = 所有变体)
    session.cancelTicker({ secType: "OPT", symbol: "SPX", exchange: "SMART", currency: "USD", lastTradeDateOrContractMonth: EXPIRY, strike: 7725, right: "C", tradingClass: "SPXW" });
    for (let round = 0; round < 5; round += 1) await positions(router);
    expect(tws.subs).toHaveLength(4);
    expect(tws.lines()).toBe(3);
    expect(priceOf(await positions(router), 7725)).toBe(18.2);
  });

  it("日志:一段没盘口只在头一次写一行,盘口回来再写一行", async () => {
    const tws = new FakeTws();
    const leg = optionLeg(tws, 7725, 1);
    tws.book.set(optId(tws, 7725), { bid: 18, ask: 18.4 });
    tws.held = [leg];
    const { router } = await connect(tws);
    await positions(router);
    const log = stderrLines();
    tws.book.delete(optId(tws, 7725)); // TWS 那头没行情:重订了也不来
    silence(tws);
    for (let round = 0; round < 3; round += 1) {
      vi.setSystemTime(Date.now() + 31_000);
      await positions(router);
    }
    expect(tws.subs).toHaveLength(4);
    expect(log.filter((l) => l.includes("撤掉重订"))).toHaveLength(1);
    expect(log[0]).toMatch(/^\[ibkr\] 行情流 opt:模拟\|SPX\|OPT\|.*连接还在,却 31 秒没来一笔盘口,撤掉重订$/);
    tws.book.set(optId(tws, 7725), { bid: 19, ask: 19.4 });
    vi.setSystemTime(Date.now() + 31_000);
    expect(priceOf(await positions(router), 7725)).toBe(19.2);
    await positions(router);
    expect(log.filter((l) => l.includes("盘口回来了"))).toEqual([expect.stringMatching(/重订 4 次后盘口回来了$/)]);
    expect(ACCOUNT).toBe("DU7654321"); // 日志里是别名「模拟」,不是账号
    expect(log.join("\n")).not.toContain(ACCOUNT);
  });
});

describe("时限", () => {
  it("盘中半分钟;盘外 / 盘前 / 盘后两分钟;休市与认不出的不判", () => {
    expect(silenceLimitMs("盘中")).toBe(30_000);
    for (const s of ["盘外", "盘前", "盘后"]) expect(silenceLimitMs(s)).toBe(120_000);
    for (const s of ["休市", ""]) expect(silenceLimitMs(s)).toBe(0);
  });

  it("没报时刻的会话(替身)不判:不知道就不当它死了", () => {
    const t = { bid: NaN, ask: NaN } as TickerData;
    expect(quoteSilenceMs(t, Date.now())).toBeNull();
    expect(quoteSilenceMs({ ...t, requestedAt: 1_000, quotedAt: 5_000 }, 9_000)).toBe(4_000);
    expect(quoteSilenceMs({ ...t, requestedAt: 8_000, quotedAt: 5_000 }, 9_000)).toBe(1_000); // 重连后重新起算
  });
});

// ---------------------------------------------------------------------------------------------
// 第三段:测算那批流(optionMarks.ts)
// ---------------------------------------------------------------------------------------------

/** 每次订阅是一条新流:订上那一刻有 requestedAt,live 为真时才来盘口 */
class MarksSession {
  connected = true;
  live = true;
  subs: string[] = [];
  cancels: string[] = [];
  isConnected(): boolean { return this.connected; }
  managedAccounts(): string[] { return [LIVE_ACCOUNT]; }
  async qualifyContracts(contracts: IbContract[]): Promise<void> {
    for (const c of contracts) c.conId = 900000 + Number(c.strike);
  }
  reqMarketDataType(): void { /* 实盘不切 */ }
  subscribeTicker(c: IbContract, generic = ""): TickerHandle {
    this.subs.push(`${c.strike}#${generic}`);
    const requestedAt = Date.now();
    const quoted = this.live ? { bid: 1.0, ask: 1.2, quotedAt: requestedAt } : { bid: NaN, ask: NaN, quotedAt: null };
    return { read: () => ({ ...quoted, requestedAt, modelGreeks: { gamma: null, impliedVol: 0.2 }, error: null }) as TickerData };
  }
  cancelTicker(c: IbContract, generic?: string): void { this.cancels.push(`${c.strike}#${generic ?? "*"}`); }
  async settle(ms: number): Promise<void> { vi.setSystemTime(Date.now() + ms); }
}

const markLeg = (strike: number): OptionLegSpec =>
  ({ symbol: "SPX", expiry: "20260929", strike, right: "P", exchange: "SMART", tradingClass: "SPXW" });

describe("测算那批流(optionMarks.ts)", () => {
  it("开着自动刷新、一直热着的流:连着却过了时限没盘口,下次读撤掉自己那条(#106)重订", async () => {
    const session = new MarksSession();
    const marks = new OptionMarkStreams();
    await marks.read(session as unknown as IbSession, [markLeg(7610)], false, 30_000);
    session.live = false; // 这之后新订的流也不来
    // 十秒一读,一直热着(闲一分钟才撤);第一条流在它订上之后的 30 秒到期
    for (let i = 0; i < 3; i += 1) {
      vi.setSystemTime(Date.now() + 10_000);
      await marks.read(session as unknown as IbSession, [markLeg(7610)], false, 30_000);
    }
    expect(session.subs).toEqual(["7610#106", "7610#106"]);
    expect(session.cancels).toEqual(["7610#106"]);
    marks.close();
  });

  it("不给时限照旧不判;断着的时候也不判", async () => {
    const session = new MarksSession();
    const marks = new OptionMarkStreams();
    session.live = false;
    await marks.read(session as unknown as IbSession, [markLeg(7610)], false);
    vi.setSystemTime(Date.now() + 50_000);
    await marks.read(session as unknown as IbSession, [markLeg(7610)], false);
    session.connected = false;
    vi.setSystemTime(Date.now() + 50_000);
    await marks.read(session as unknown as IbSession, [markLeg(7610)], false, 30_000);
    expect(session.subs).toEqual(["7610#106"]);
    marks.close();
  });
});
