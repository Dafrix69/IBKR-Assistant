/** 与 TWS 的通断:掉线要知道、要重连、掉线期间"读不到"绝不能被当成"没有"。
 *
 * 2026-09-26 排查全天运行时发现的:
 *  1. IBApiNext 没设 reconnectInterval(= 永不重连),而它收到 1100 / 2110(TWS 与 IBKR 服务器之间断了,
 *     每晚服务器重置都会来)会主动关掉本机到 TWS 的 socket。会话的 connected 标志又只在显式 disconnect()
 *     时才变 false——于是持仓快照与报价冻在断开那一刻,盯盘拿着一个不动的价判断,跟踪止损永远不会触发;
 *  2. 让会话说真话之后,BrokerRouter.positions() 只遍历"连着的"会话,全断了就回空列表——
 *     盯盘会判「持仓已不存在」停掉所有追踪、托管对账撤掉券商侧的止损单;
 *  3. 一个账户的 TWS 没开(模拟盘 7497 常常不开),它的持仓本来就不在列表里,同样会被判成平仓。
 *
 * 全部离线:会话层用假的 @stoqey/ib 模块,router 层用假会话。
 */
import { BehaviorSubject, Subject } from "rxjs";
import { describe, expect, it } from "vitest";

import { BrokerError, BrokerRouter } from "../src/broker.js";
import type { IbSession } from "../src/broker.js";
import { coveredAccounts, liveSessions } from "../src/ibLink.js";
import { IB_RECONNECT_MS, createIbApiNextSession } from "../src/ibSession.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");
type Rec = Record<string, any>;

const DISCONNECTED = 0, CONNECTING = 1, CONNECTED = 2;

/** 假的 IBApiNext:只实现会话层用到的那几样,连接状态由测试手动推。 */
class FakeApiNext {
  static last: FakeApiNext | null = null;
  static twsUp = true;
  readonly state = new BehaviorSubject<number>(DISCONNECTED);
  readonly errorSubject = new Subject<unknown>();
  readonly api = { on: () => undefined };
  mdTypes: number[] = [];
  disconnects = 0;
  posNext: ((u: unknown) => void) | null = null;
  mdNext: ((u: unknown) => void) | null = null;
  constructor(readonly opts: Rec) {
    FakeApiNext.last = this;
  }
  get connectionState(): BehaviorSubject<number> { return this.state; }
  connect(): void {
    this.state.next(CONNECTING);
    if (FakeApiNext.twsUp) this.state.next(CONNECTED);
  }
  disconnect(): void {
    this.disconnects += 1;
    this.state.next(DISCONNECTED);
  }
  getManagedAccounts(): Promise<string[]> {
    return FakeApiNext.twsUp ? Promise.resolve(["DU7654321"]) : Promise.reject(new Error("connect ECONNREFUSED"));
  }
  setMarketDataType(t: number): void { this.mdTypes.push(t); }
  getPositions() {
    return { subscribe: (o: Rec) => { this.posNext = o["next"]; return { unsubscribe: () => undefined }; } };
  }
  getMarketData() {
    return { subscribe: (o: Rec) => { this.mdNext = o["next"]; return { unsubscribe: () => undefined }; } };
  }
}

const FAKE_MOD = {
  IBApiNext: FakeApiNext,
  ConnectionState: { Disconnected: DISCONNECTED, Connecting: CONNECTING, Connected: CONNECTED },
  IBApiTickType: { BID: 1, ASK: 2, LAST: 4, CLOSE: 9 },
  EventName: {},
};
const CFG = { host: "127.0.0.1", port: 7497, clientId: 11, readonly: false };

async function openSession(): Promise<[IbSession, FakeApiNext]> {
  FakeApiNext.twsUp = true;
  const session = await createIbApiNextSession(CFG, { mod: FAKE_MOD });
  return [session, FakeApiNext.last!];
}

async function readPositions(session: IbSession, api: FakeApiNext, rows: Array<[string, number]>) {
  const pending = session.positions();
  api.posNext?.({
    all: new Map([["DU7654321", rows.map(([symbol, pos], i) => ({ contract: { conId: i + 1, symbol }, pos, avgCost: 50 }))]]),
  });
  return pending;
}

describe("会话层:掉线要知道、要重连", () => {
  it("开了自动重连:IBApiNext 带着 reconnectInterval 建", async () => {
    const [, api] = await openSession();
    expect(IB_RECONNECT_MS).toBeGreaterThan(0);
    expect(api.opts["reconnectInterval"]).toBe(IB_RECONNECT_MS);
  });

  it("掉线:isConnected 说真话、持仓当场报错不干等、冻住的报价作废;重连回来补回行情类型基线", async () => {
    const [session, api] = await openSession();
    const links: boolean[] = [];
    session.onLink!((up) => links.push(up));
    session.setBaselineMarketDataType!(3);
    const held = await readPositions(session, api, [["AAA", 100]]);
    expect(held).toHaveLength(1);
    const ticker = session.subscribeTicker({ secType: "STK", symbol: "AAA", exchange: "SMART", currency: "USD" });
    api.mdNext?.({ all: new Map([[4, { value: 51.25 }]]) });
    expect(ticker.read().last).toBe(51.25);

    api.state.next(DISCONNECTED); // TWS 重启 / 1100 被库转成断开
    expect(session.isConnected()).toBe(false);
    expect(links).toEqual([false]);
    expect(ticker.read().last).toBeNull(); // 不拿断线前的价冒充现价
    const t0 = Date.now();
    await expect(session.positions()).rejects.toThrow(/断开/);
    expect(Date.now() - t0).toBeLessThan(500); // 不是等满 8 秒超时

    api.mdTypes = [];
    api.state.next(CONNECTING);
    api.state.next(CONNECTED); // 库按 reconnectInterval 自己连回来了
    expect(session.isConnected()).toBe(true);
    expect(links).toEqual([false, true]);
    expect(api.mdTypes).toEqual([3]); // 行情类型是 per-connection 的,重连后要补
    // 重连后第一份持仓是完整快照(库在 positionEnd 才推),按它重新建表
    const again = await readPositions(session, api, [["AAA", 100], ["BBB", -50]]);
    expect(again.map((p) => p.contract["symbol"]).sort()).toEqual(["AAA", "BBB"]);
  });

  it("首次连不上:把那个客户端关干净,不留一个在后台每 5 秒重连、占住 client id 的幽灵", async () => {
    FakeApiNext.twsUp = false;
    await expect(createIbApiNextSession(CFG, { mod: FAKE_MOD })).rejects.toThrow(/ECONNREFUSED/);
    expect(FakeApiNext.last!.disconnects).toBe(1);
  });

  it("显式断开不算掉线:不报 onLink", async () => {
    const [session] = await openSession();
    const links: boolean[] = [];
    session.onLink!((up) => links.push(up));
    await session.disconnect();
    expect(session.isConnected()).toBe(false);
    expect(links).toEqual([]);
  });
});

/** router 层的假会话:连没连着由测试直接拨。 */
class StubSession {
  connected = true;
  disconnects = 0;
  linkCbs: Array<(up: boolean) => void> = [];
  constructor(readonly managed: string[], readonly held: Rec[] = []) {}
  isConnected(): boolean { return this.connected; }
  disconnect(): void { this.connected = false; this.disconnects += 1; }
  managedAccounts(): string[] { return this.managed; }
  async portfolio(): Promise<Rec[]> { return []; }
  async positions(): Promise<Rec[]> { return this.held; }
  onConnectivity(): void { /* 不关心 */ }
  onLink(cb: (up: boolean) => void): void { this.linkCbs.push(cb); }
  reqMarketDataType(): void { /* 不关心 */ }
  setBaselineMarketDataType(): void { /* 不关心 */ }
  subscribeTicker() { return { read: () => ({ last: null, bid: NaN, ask: NaN, close: null }) }; }
  async settle(): Promise<void> { /* 不等 */ }
  async qualifyContracts(): Promise<void> { /* 不关心 */ }
}

function routerWith(sessions: Record<number, StubSession>): BrokerRouter {
  const settings = makeSettings(g.base_config);
  // 工厂按端口发会话:7497 = paper(模拟),7496 = live(主账户)
  return new BrokerRouter(settings, async (cfg) => {
    const s = sessions[cfg.port];
    if (s === undefined) throw new Error("connect ECONNREFUSED");
    s.connected = true;
    return s as unknown as IbSession;
  });
}

describe("router 层:读不到 ≠ 没有", () => {
  it("全断了:读持仓报错,不回空列表(空列表会停掉所有追踪、撤掉托管止损)", async () => {
    const paper = new StubSession(["DU7654321"], []);
    const router = routerWith({ 7497: paper });
    await router.connect("paper");
    expect(await router.positions()).toEqual([]); // 连着、真的没仓:空列表是对的
    paper.connected = false;
    await expect(router.positions()).rejects.toBeInstanceOf(BrokerError);
    await expect(router.positions()).rejects.toThrow(/断开/);
  });

  it("一个会话都没连上:同样报错", async () => {
    const router = routerWith({});
    await expect(router.positions()).rejects.toThrow(/没有连上/);
  });

  it("读得到哪些账户:只算连着的会话管的那几个", async () => {
    const paper = new StubSession(["DU7654321"]);
    const live = new StubSession(["U1234567"]);
    const router = routerWith({ 7497: paper, 7496: live });
    await router.connect("paper");
    expect([...router.coveredAccounts()]).toEqual(["模拟"]); // 实盘那台 TWS 还没连
    await router.connect("live");
    expect([...router.coveredAccounts()].sort()).toEqual(["主账户", "模拟"].sort());
    paper.connected = false;
    expect([...router.coveredAccounts()]).toEqual(["主账户"]);
  });

  it("重新连一条断着的连接:先把旧会话停掉,不让两个会话抢同一个 client id", async () => {
    const first = new StubSession(["DU7654321"]);
    const sessions: Record<number, StubSession> = { 7497: first };
    const router = routerWith(sessions);
    await router.connect("paper");
    first.connected = false;
    const second = new StubSession(["DU7654321"]);
    sessions[7497] = second;
    await router.connect("paper");
    expect(first.disconnects).toBe(1);
    expect(router.sessions()).toEqual([second]);
  });

  it("掉线 / 重连转给 linkHook,带着连接名", async () => {
    const paper = new StubSession(["DU7654321"]);
    const router = routerWith({ 7497: paper });
    const seen: Array<[string, boolean]> = [];
    router.linkHook = (name, up) => seen.push([name, up]);
    await router.connect("paper");
    for (const cb of paper.linkCbs) cb(false);
    for (const cb of paper.linkCbs) cb(true);
    expect(seen).toEqual([["paper", false], ["paper", true]]);
  });

  it("纯函数口径:liveSessions / coveredAccounts", () => {
    const up = new StubSession(["U1234567"]);
    const down = new StubSession(["DU7654321"]);
    down.connected = false;
    const map = new Map<string, IbSession>([["live", up as unknown as IbSession], ["paper", down as unknown as IbSession]]);
    expect(liveSessions(map, (m) => new Error(m))).toEqual([up]);
    const settings = makeSettings(g.base_config);
    expect([...coveredAccounts(settings.accounts, map)]).toEqual(["主账户"]);
    // 会话没报账户列表:按配置写的连接放行
    const bare = new Map<string, IbSession>([["paper", new StubSession([]) as unknown as IbSession]]);
    expect([...coveredAccounts(settings.accounts, bare)]).toEqual(["模拟"]);
  });
});
