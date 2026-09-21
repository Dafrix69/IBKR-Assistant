/** 异动监控的量能流:当日量 / 90 日均量 / 30 日历史波动率 / 近几分钟量,全部来自同一条行情流。
 *
 * 钉住三件事:
 *  1. applyTicks 认得这些 tick(实时与 DELAYED_* 两套号),延迟标记跟着 LAST 的出处走;
 *  2. 行情流的缓存键带 generic ticks——顶栏宏观带先订了同一只股(不带 generic),异动监控再订拿到的
 *     不能是那条没有均量的流;cancelTicker 不传 generic 撤全部变体(期权链靠它不漏撤),传了只撤那一条;
 *  3. BrokerRouter.volumeQuotes / releaseVolumeStreams:常驻、认不出的不反复重试、被拒的按退避重订、
 *     移出追踪的流当场撤掉;盘口页用完即撤时不许误伤同一只股的量能流。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  type Sub = {
    contract: Record<string, unknown>;
    generic: string;
    next: (u: unknown) => void;
    error: (e: unknown) => void;
    closed: boolean;
  };
  const subs: Sub[] = [];
  class FakeApiNext {
    constructor(_opts: unknown) {}
    connect(_clientId: number): void {}
    disconnect(): void {}
    async getManagedAccounts(): Promise<string[]> {
      return ["DU7654321"];
    }
    setMarketDataType(_type: number): void {}
    getMarketData(contract: Record<string, unknown>, generic: string) {
      return {
        subscribe(obs: { next: (u: unknown) => void; error: (e: unknown) => void }) {
          const sub: Sub = { contract, generic, next: obs.next, error: obs.error, closed: false };
          subs.push(sub);
          return { unsubscribe: () => { sub.closed = true; } };
        },
      };
    }
  }
  return { subs, FakeApiNext };
});

// 只替换连接类:tick 枚举表用库里真的那张,名字拼错了这里就能测出来
vi.mock("@stoqey/ib", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  IBApiNext: fake.FakeApiNext,
}));

import { IBApiTickType } from "@stoqey/ib";

import { BrokerRouter } from "../src/broker.js";
import { stockContract } from "../src/ibContracts.js";
import type { IbContract, IbSession, TickerData, TickerHandle } from "../src/broker.js";
import { FutuRouter } from "../src/futuBroker.js";
import { applyTicks, createIbApiNextSession, tickerKey } from "../src/ibSession.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");
const MOD = { IBApiTickType };
const T = IBApiTickType as unknown as Record<string, number>;

/** IBApiNext 推过来的形状:all 是 tick 号 → { value } 的 Map。 */
function update(values: Record<string, number | undefined>): { all: Map<number, { value: number | undefined }> } {
  const all = new Map<number, { value: number | undefined }>();
  for (const [name, value] of Object.entries(values)) {
    const id = T[name];
    if (id === undefined) throw new Error(`库里没有 tick ${name}`);
    all.set(id, { value });
  }
  return { all };
}

function blank(): TickerData {
  return {
    bid: NaN, ask: NaN, last: null, close: null, bidSize: null, askSize: null,
    marketPrice: null, modelGreeks: null, error: null,
  };
}

// ---------------------------------------------------------------- applyTicks
describe("applyTicks:量能字段", () => {
  it("实时:当日量 / 均量 / 历史波动率 / 高低开 / 近 3·5·10 分钟量 / 最后成交时间都落到 TickerData", () => {
    const data = blank();
    applyTicks(MOD, data, update({
      LAST: 101.5, CLOSE: 100, OPEN: 99.8, HIGH: 102.2, LOW: 99.1,
      VOLUME: 7_930_000, AVG_VOLUME: 6_100_000, OPTION_HISTORICAL_VOL: 0.319,
      SHORT_TERM_VOLUME_3_MIN: 41_000, SHORT_TERM_VOLUME_5_MIN: 70_000, SHORT_TERM_VOLUME_10_MIN: 150_000,
      LAST_TIMESTAMP: 1_789_138_800,
    }));
    expect(data).toMatchObject({
      last: 101.5, close: 100, open: 99.8, high: 102.2, low: 99.1,
      volume: 7_930_000, avgVolume: 6_100_000, histVol: 0.319,
      vol3m: 41_000, vol5m: 70_000, vol10m: 150_000, lastTradeAt: 1_789_138_800,
      delayed: false, marketPrice: 101.5,
    });
  });

  it("延迟行情(DELAYED_*):照样取到量价,并标记 delayed", () => {
    const data = blank();
    applyTicks(MOD, data, update({
      DELAYED_LAST: 55.2, DELAYED_CLOSE: 50, DELAYED_OPEN: 51, DELAYED_HIGH: 56, DELAYED_LOW: 50.5,
      DELAYED_VOLUME: 1_200_000, DELAYED_LAST_TIMESTAMP: 1_789_138_000,
    }));
    expect(data).toMatchObject({
      last: 55.2, close: 50, open: 51, high: 56, low: 50.5, volume: 1_200_000,
      lastTradeAt: 1_789_138_000, delayed: true,
    });
  });

  it("实时与延迟同时在:实时优先,不算延迟", () => {
    const data = blank();
    applyTicks(MOD, data, update({ LAST: 10, DELAYED_LAST: 9, VOLUME: 500, DELAYED_VOLUME: 400 }));
    expect(data.last).toBe(10);
    expect(data.volume).toBe(500);
    expect(data.delayed).toBe(false);
  });

  it("没到的 tick 不清掉已有值;转不成数字的时间戳(value 为 undefined)不写成 NaN", () => {
    const data = blank();
    applyTicks(MOD, data, update({ LAST: 10, AVG_VOLUME: 6_000_000, LAST_TIMESTAMP: 1_789_138_800 }));
    applyTicks(MOD, data, update({ LAST: 10.5, LAST_TIMESTAMP: undefined }));
    expect(data.avgVolume).toBe(6_000_000);
    expect(data.last).toBe(10.5);
    expect(data.lastTradeAt).toBe(1_789_138_800);
  });
});

// ---------------------------------------------------------------- 缓存键 / 撤订阅变体
describe("IbSession:行情流按 合约 + generic ticks 缓存", () => {
  afterEach(() => {
    fake.subs.splice(0);
  });

  async function session(): Promise<IbSession> {
    return createIbApiNextSession({ host: "127.0.0.1", port: 7497, clientId: 11, readonly: true });
  }

  it("缓存键:不带 generic 就是合约本身,带了加 #generic", () => {
    const aapl = stockContract("AAPL");
    expect(tickerKey(aapl)).toBe("STK|AAPL|||");
    expect(tickerKey(aapl, "165,104,595")).toBe("STK|AAPL|||#165,104,595");
  });

  it("宏观带先订了同一只股,量能流另起一条,各自拿到各自的 tick", async () => {
    const s = await session();
    const plain = s.subscribeTicker(stockContract("AAPL"));
    const again = s.subscribeTicker(stockContract("AAPL"));
    const vol = s.subscribeTicker(stockContract("AAPL"), "165,104,595");
    expect(fake.subs.map((x) => x.generic)).toEqual(["", "165,104,595"]); // 同一变体订第二次读缓存
    fake.subs[1]!.next(update({ LAST: 200, AVG_VOLUME: 50_000_000 }));
    fake.subs[0]!.next(update({ LAST: 199.9 }));
    expect(vol.read().avgVolume).toBe(50_000_000);
    expect(plain.read().avgVolume).toBeNull();
    expect(again.read().last).toBe(199.9);
  });

  it("cancelTicker 传 generic 只撤那一条;不传撤掉这个合约的所有变体", async () => {
    const s = await session();
    const aapl = stockContract("AAPL");
    s.subscribeTicker(aapl);
    s.subscribeTicker(aapl, "165,104,595");
    s.subscribeTicker(stockContract("AAPLX")); // 前缀相同的别的合约不能被连带撤掉
    s.cancelTicker(aapl, "165,104,595");
    expect(fake.subs.map((x) => x.closed)).toEqual([false, true, false]);
    s.subscribeTicker(aapl); // 不带 generic 的那条还在缓存里,不重订
    expect(fake.subs).toHaveLength(3);

    const opt: IbContract = {
      secType: "OPT", symbol: "SPX", exchange: "SMART", currency: "USD",
      lastTradeDateOrContractMonth: "20260918", strike: 6500, right: "C",
    };
    s.subscribeTicker(opt, "100,101,106"); // 期权链:带 generic 订、不带 generic 撤
    s.subscribeTicker(opt);
    s.cancelTicker(opt);
    expect(fake.subs.slice(3).map((x) => x.closed)).toEqual([true, true]);
    s.cancelTicker(aapl, "");
    expect(fake.subs.map((x) => x.closed)).toEqual([true, true, false, true, true]);
  });

  it("某一条变体被拒:只摘掉那一条,下次订重新发请求", async () => {
    const s = await session();
    const aapl = stockContract("AAPL");
    s.subscribeTicker(aapl);
    const vol = s.subscribeTicker(aapl, "165,104,595");
    fake.subs[1]!.error({ code: 10197, message: "No market data during competing live session" });
    expect(vol.read().error).toMatch(/10197/);
    s.subscribeTicker(aapl, "165,104,595");
    s.subscribeTicker(aapl);
    expect(fake.subs.map((x) => x.generic)).toEqual(["", "165,104,595", "165,104,595"]);
  });
});

// ---------------------------------------------------------------- BrokerRouter.volumeQuotes
class VolSession implements IbSession {
  connected = true;
  qualifyMode: "ok" | "fail" | "hang" = "ok";
  qualifyCalls = 0;
  subscribed: Array<[string, string]> = [];
  cancelled: Array<[string, string | undefined]> = [];
  settles: number[] = [];
  /** 键:symbol#generic → 当前 tick */
  data = new Map<string, TickerData>();

  isConnected(): boolean {
    return this.connected;
  }
  disconnect(): void {
    this.connected = false;
  }
  managedAccounts(): string[] {
    return ["DU7654321"];
  }
  async qualifyContracts(contracts: IbContract[], _timeoutMs: number): Promise<void> {
    this.qualifyCalls += 1;
    if (this.qualifyMode === "hang") throw new Error("timeout");
    for (const c of contracts) c.conId = this.qualifyMode === "ok" ? 1000 + c.symbol.length : 0;
  }
  reqMarketDataType(_type: number): void {}
  subscribeTicker(contract: IbContract, genericTicks = ""): TickerHandle {
    this.subscribed.push([contract.symbol, genericTicks]);
    const key = `${contract.symbol}#${genericTicks}`;
    return { read: () => ({ ...(this.data.get(key) ?? blank()) }) };
  }
  cancelTicker(contract: IbContract, genericTicks?: string): void {
    this.cancelled.push([contract.symbol, genericTicks]);
  }
  async settle(ms: number): Promise<void> {
    this.settles.push(ms);
  }
  async historicalData(): Promise<never[]> {
    return [];
  }
  async secDefOptParams(): Promise<never[]> {
    return [];
  }
  async mktDepth(): Promise<{ bids: never[]; asks: never[] }> {
    return { bids: [], asks: [] };
  }
  async placeOrder(): Promise<{ orderId: number; permId: null; status: string }> {
    return { orderId: 1, permId: null, status: "Submitted" };
  }
  cancelOrder(_orderId: number): void {}
  async openTrades(): Promise<never[]> {
    return [];
  }
  async portfolio(): Promise<never[]> {
    return [];
  }
  async positions(): Promise<never[]> {
    return [];
  }
  onConnectivity(_cb: (code: number) => void): void {}
}

const VOL = BrokerRouter.VOLUME_TICKS;

async function connected(session = new VolSession()): Promise<[BrokerRouter, VolSession]> {
  const router = new BrokerRouter(makeSettings(g.base_config), async () => session);
  await router.connect("paper");
  return [router, session];
}

describe("BrokerRouter.volumeQuotes:异动监控的常驻量能流", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("第一次按 generic 165,104,595 订并等首笔 tick;之后只读缓存", async () => {
    const [router, s] = await connected();
    expect(VOL).toBe("165,104,595");
    expect(router.SUPPORTS_VOLUME_QUOTES).toBe(true);
    s.data.set(`RKLB#${VOL}`, {
      ...blank(), last: 48.2, close: 44.5, open: 45, high: 49, low: 44.9, volume: 30_000_000,
      avgVolume: 18_000_000, histVol: 0.72, vol3m: 900_000, vol5m: 1_500_000, vol10m: 2_600_000,
      lastTradeAt: 1_789_138_800, delayed: false,
    });
    const first = await router.volumeQuotes(["RKLB"]);
    expect(s.subscribed).toEqual([["RKLB", VOL]]);
    expect(s.settles).toEqual([1500]);
    expect(first["RKLB"]).toEqual({
      last: 48.2, close: 44.5, open: 45, high: 49, low: 44.9, volume: 30_000_000, avg_volume: 18_000_000,
      hist_vol: 0.72, vol_3m: 900_000, vol_5m: 1_500_000, vol_10m: 2_600_000, delayed: false,
      last_trade_at: 1_789_138_800,
    });
    await router.volumeQuotes(["RKLB"]);
    expect(s.subscribed).toHaveLength(1);
    expect(s.qualifyCalls).toBe(1);
    expect(s.settles).toEqual([1500, 100]);
  });

  it("非有限 / 非正的量价一律 null;没有成交价就用中间价;延迟标记原样带出", async () => {
    const [router, s] = await connected();
    s.data.set(`UBER#${VOL}`, {
      ...blank(), bid: 80, ask: 80.2, last: null, marketPrice: 80.1, close: NaN, volume: 0,
      avgVolume: -1, histVol: Infinity, vol5m: NaN, delayed: true,
    });
    const out = await router.volumeQuotes(["UBER"]);
    expect(out["UBER"]).toMatchObject({
      last: 80.1, close: null, volume: null, avg_volume: null, hist_vol: null, vol_5m: null, delayed: true,
    });
  });

  it("认不出的标的:给 error「未知标的」,之后不再反复 qualify", async () => {
    const s = new VolSession();
    s.qualifyMode = "fail";
    const [router] = await connected(s);
    const out = await router.volumeQuotes(["ZZZZ"]);
    expect(out["ZZZZ"]).toMatchObject({ error: "未知标的", last: null, volume: null, avg_volume: null });
    await router.volumeQuotes(["ZZZZ"]);
    expect(s.qualifyCalls).toBe(1);
    expect(s.subscribed).toEqual([]);
  });

  it("合约确认超时不当成认不出:这一轮报原因、别的也不排队干等,过了退避期再试", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-11T15:00:00Z"));
    const s = new VolSession();
    s.qualifyMode = "hang";
    const [router] = await connected(s);
    const out = await router.volumeQuotes(["AAPL", "MSFT"]);
    expect(s.qualifyCalls).toBe(1);                 // 第一只超时,第二只不再去等
    expect(out["AAPL"]?.error).toMatch(/没有响应/);
    s.qualifyMode = "ok";
    await router.volumeQuotes(["AAPL", "MSFT"]);    // 退避期内:AAPL 不重试,MSFT 这一轮补上
    expect(s.subscribed).toEqual([["MSFT", VOL]]);
    vi.setSystemTime(new Date(Date.now() + BrokerRouter.VOLUME_RETRY_MS + 1));
    const later = await router.volumeQuotes(["AAPL", "MSFT"]);
    expect(s.subscribed).toEqual([["MSFT", VOL], ["AAPL", VOL]]);
    expect(later["AAPL"]?.error).toBeUndefined();
  });

  it("流被 TWS 拒了:撤掉那一条(只撤量能变体),报原因,退避期过了再重订", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-11T15:00:00Z"));
    const [router, s] = await connected();
    await router.volumeQuotes(["GOOG"]);
    s.data.set(`GOOG#${VOL}`, { ...blank(), last: 250, error: "10197 competing live session" });
    const out = await router.volumeQuotes(["GOOG"]);
    expect(s.cancelled).toEqual([["GOOG", VOL]]);
    expect(out["GOOG"]).toMatchObject({ error: "10197 competing live session", last: null });
    s.data.set(`GOOG#${VOL}`, { ...blank(), last: 251 });
    await router.volumeQuotes(["GOOG"]);
    expect(s.subscribed).toHaveLength(1);           // 退避期内不重订
    vi.setSystemTime(new Date(Date.now() + BrokerRouter.VOLUME_RETRY_MS + 1));
    const back = await router.volumeQuotes(["GOOG"]);
    expect(s.subscribed).toHaveLength(2);
    expect(back["GOOG"]).toMatchObject({ last: 251 });
    expect(back["GOOG"]?.error).toBeUndefined();
  });

  it("releaseVolumeStreams:不在 keep 里的流当场撤掉(按量能变体撤),返回撤了几条", async () => {
    const [router, s] = await connected();
    await router.volumeQuotes(["AAPL", "MSFT", "NVDA"]);
    expect(router.releaseVolumeStreams(["MSFT"])).toBe(2);
    expect(s.cancelled).toEqual([["AAPL", VOL], ["NVDA", VOL]]);
    expect(router.releaseVolumeStreams(["MSFT"])).toBe(0);
    await router.volumeQuotes(["AAPL"]);            // 撤掉的再要就重新订
    expect(s.subscribed.filter(([sym]) => sym === "AAPL")).toHaveLength(2);
    expect(router.releaseVolumeStreams([])).toBe(2);
  });

  it("断开连接时量能流一起撤掉", async () => {
    const [router, s] = await connected();
    await router.volumeQuotes(["AAPL"]);
    await router.disconnectAll();
    expect(s.cancelled).toContainEqual(["AAPL", VOL]);
  });

  it("没有会话:什么都不订,回空", async () => {
    const router = new BrokerRouter(makeSettings(g.base_config), async () => new VolSession());
    expect(await router.volumeQuotes(["AAPL"])).toEqual({});
  });

  it("盘口页用完即撤只撤它自己那条(不带 generic),不误伤同一只股的量能流", async () => {
    const [router, s] = await connected();
    await router.volumeQuotes(["AAPL"]);
    await router.orderBook("AAPL");
    expect(s.cancelled).toEqual([["AAPL", ""]]);
  });

  // 2026-09-12 审出:这条路(持仓 / 追踪 / 解析快照取正股现价)取不到价时会撤流。
  // 撤成"所有变体"的话,量能流跟着没了,句柄还在、读到的却是最后一帧,而且不报错——
  // volumeQuotes 只在出错或换会话时重订,那只股的量价就此冻住,界面上还一切正常。
  it("正股取价失败时只撤它自己那条,不把同一只股的量能流一起撤掉", async () => {
    const [router, s] = await connected();
    await router.volumeQuotes(["AAPL"]);
    const before = s.subscribed.length;
    // 没有任何 tick → 冷路径等不到价,退到延迟再试,最后放弃
    await router.indexPrice("AAPL");
    expect(s.cancelled.every(([, generic]) => generic === "")).toBe(true);
    expect(s.cancelled.some(([sym, generic]) => sym === "AAPL" && generic === undefined)).toBe(false);
    // 量能流还在:再取一次不会重新订
    await router.volumeQuotes(["AAPL"]);
    expect(s.subscribed.slice(before).filter(([, generic]) => generic === VOL)).toEqual([]);
  });

  it("富途:不支持,量能接口回空、撤流回 0", async () => {
    const futu = new FutuRouter(makeSettings(g.base_config));
    expect(futu.SUPPORTS_VOLUME_QUOTES).toBe(false);
    expect(await futu.volumeQuotes()).toEqual({});
    expect(futu.releaseVolumeStreams()).toBe(0);
  });
});
