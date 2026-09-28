/** 蝴蝶测算取行情的那一层(optionMarks.ts):几条期权腿的盘口与 IBKR 的模型 IV。
 *
 * 最要紧的一条:**不许碰盯盘的流**。测算的腿常常就是持仓的腿,行情流又没有引用计数——这里订的必须是自己那一条
 * (带 generic ticks),撤的也只能是自己那一条。其余钉的是:留一分钟、热的时候即读、被拒的重订、纸面会话的延迟行情、
 * IV 比盘口晚到时等多久。全部离线:会话是假的,时钟是假的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IbContract, IbSession, TickerData, TickerHandle } from "../src/ibTypes.js";
import { OptionMarkStreams, OptionMarksError } from "../src/optionMarks.js";
import type { OptionLegSpec } from "../src/optionMarks.js";

type Tick = Partial<TickerData>;

class FakeSession {
  connected = true;
  log: string[] = [];
  /** 行权价 → 这条腿现在的 tick;没登记的给默认盘口 */
  ticks = new Map<number, Tick>();
  unknown = new Set<number>();
  qualifyTimesOut = false;
  settled = 0;
  onSettle: ((elapsed: number) => void) | null = null;

  isConnected(): boolean { return this.connected; }
  managedAccounts(): string[] { return ["DU7654321"]; }
  async qualifyContracts(contracts: IbContract[]): Promise<void> {
    this.log.push(`qualify:${contracts.map((c) => c.strike).join(",")}`);
    if (this.qualifyTimesOut) throw new Error("timeout");
    for (const c of contracts) c.conId = this.unknown.has(Number(c.strike)) ? 0 : 900000 + Number(c.strike);
  }
  reqMarketDataType(type: number): void { this.log.push(`type:${type}`); }
  subscribeTicker(contract: IbContract, generic = ""): TickerHandle {
    this.log.push(`sub:${contract.strike}${contract.right}#${generic}`);
    const strike = Number(contract.strike);
    // 被拒的流不会自己活过来:订的那一刻就带着 error 的,这个句柄之后一直读到它(和真会话一样)
    const dead = this.ticks.get(strike)?.error ?? null;
    if (dead) return { read: () => ({ bid: NaN, ask: NaN, modelGreeks: null, error: dead }) as TickerData };
    return { read: () => ({ bid: 1.0, ask: 1.2, modelGreeks: { gamma: null, impliedVol: 0.15 }, error: null, ...this.ticks.get(strike) }) as TickerData };
  }
  cancelTicker(contract: IbContract, generic?: string): void {
    this.log.push(`cancel:${contract.strike}${contract.right}#${generic ?? "*"}`);
  }
  async settle(ms: number): Promise<void> {
    this.settled += ms;
    this.onSettle?.(this.settled);
  }
  count(prefix: string): number { return this.log.filter((l) => l.startsWith(prefix)).length; }
  asSession(): IbSession { return this as unknown as IbSession; }
}

const leg = (strike: number, right = "C"): OptionLegSpec =>
  ({ symbol: "SPX", expiry: "20260928", strike, right, exchange: "SMART", tradingClass: "SPXW" });
const FLY = [leg(7725), leg(7750), leg(7775)];

let streams: OptionMarkStreams;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-09-28T14:00:00Z"));
  streams = new OptionMarkStreams();
});
afterEach(() => {
  streams.close();
  vi.useRealTimers();
});

describe("订的是自己的流", () => {
  it("带 generic ticks 订;读到盘口与模型 IV;合约先确认过", async () => {
    const s = new FakeSession();
    const got = await streams.read(s.asSession(), FLY, false);
    expect(got).toEqual([
      { strike: 7725, right: "C", bid: 1.0, ask: 1.2, iv: 0.15, error: null },
      { strike: 7750, right: "C", bid: 1.0, ask: 1.2, iv: 0.15, error: null },
      { strike: 7775, right: "C", bid: 1.0, ask: 1.2, iv: 0.15, error: null },
    ]);
    expect(s.log).toEqual(["qualify:7725,7750,7775", "sub:7725C#106", "sub:7750C#106", "sub:7775C#106"]);
  });

  it("从不裸撤:每一次撤都点名自己那条流——盯盘订的那条(不带 generic)碰不到", async () => {
    const s = new FakeSession();
    await streams.read(s.asSession(), FLY, false);
    await vi.advanceTimersByTimeAsync(OptionMarkStreams.IDLE_MS * 2);
    streams.close();
    const cancels = s.log.filter((l) => l.startsWith("cancel:"));
    expect(cancels).toEqual(["cancel:7725C#106", "cancel:7750C#106", "cancel:7775C#106"]);
    expect(s.log.some((l) => l.endsWith("#*") || l.endsWith("#"))).toBe(false);
  });
});

describe("留一分钟", () => {
  it("热的时候再读:不重订、不再确认合约、读到的是最新的 tick", async () => {
    const s = new FakeSession();
    await streams.read(s.asSession(), FLY, false);
    s.ticks.set(7750, { bid: 5.0, ask: 5.4, modelGreeks: { gamma: null, impliedVol: 0.22 } });
    await vi.advanceTimersByTimeAsync(10_000);
    const again = await streams.read(s.asSession(), FLY, false);
    expect(again[1]).toMatchObject({ bid: 5.0, ask: 5.4, iv: 0.22 });
    expect(s.count("sub:")).toBe(3);
    expect(s.count("qualify:")).toBe(1);
    expect(s.count("cancel:")).toBe(0);
  });

  it("一直有人读就一直留着;一分钟没人读才撤", async () => {
    const s = new FakeSession();
    for (let i = 0; i < 5; i += 1) {
      await streams.read(s.asSession(), FLY, false);
      await vi.advanceTimersByTimeAsync(40_000);
    }
    expect(s.count("cancel:")).toBe(0);
    expect(streams.size).toBe(3);
    await vi.advanceTimersByTimeAsync(OptionMarkStreams.IDLE_MS + 30_000);
    expect(s.count("cancel:")).toBe(3);
    expect(streams.size).toBe(0);
  });

  it("换了一只蝶:共用的那条腿接着用,新腿才订;旧腿过了一分钟撤掉", async () => {
    const s = new FakeSession();
    await streams.read(s.asSession(), FLY, false);
    await vi.advanceTimersByTimeAsync(20_000);
    await streams.read(s.asSession(), [leg(7750), leg(7775), leg(7800)], false);
    expect(s.log.filter((l) => l.startsWith("sub:"))).toEqual(["sub:7725C#106", "sub:7750C#106", "sub:7775C#106", "sub:7800C#106"]);
    expect(s.log).toContain("qualify:7800"); // 确认过的合约不再确认
    await vi.advanceTimersByTimeAsync(45_000);
    await streams.read(s.asSession(), [leg(7750), leg(7775), leg(7800)], false);
    expect(s.log.filter((l) => l.startsWith("cancel:"))).toEqual(["cancel:7725C#106"]);
  });

  it("行情线路有配额:留着的流超过上限,从最久没读的撤起", async () => {
    const s = new FakeSession();
    const total = OptionMarkStreams.MAX_STREAMS + 6;
    for (let i = 0; i < total; i += 3) {
      await streams.read(s.asSession(), [leg(7000 + i * 5), leg(7005 + i * 5), leg(7010 + i * 5)], false);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(streams.size).toBeLessThanOrEqual(OptionMarkStreams.MAX_STREAMS + 3);
    expect(s.log.filter((l) => l.startsWith("cancel:"))[0]).toBe("cancel:7000C#106");
  });

  it("重连换了会话:旧会话上的流摘掉,在新会话上重订", async () => {
    const a = new FakeSession(), b = new FakeSession();
    await streams.read(a.asSession(), FLY, false);
    a.connected = false;
    await streams.read(b.asSession(), FLY, false);
    expect(b.count("sub:")).toBe(3);
    expect(a.count("cancel:")).toBe(3);
    expect(streams.size).toBe(3);
  });
});

describe("拿不到的时候", () => {
  it("没有盘口、没有 IV 的腿给 null,不编;买价恰好为 0 照实给 0", async () => {
    const s = new FakeSession();
    s.ticks.set(7725, { bid: NaN, ask: NaN, modelGreeks: null });
    s.ticks.set(7750, { bid: -1, ask: -1, modelGreeks: { gamma: null, impliedVol: null } });
    s.ticks.set(7775, { bid: 0, ask: 0.05 });
    const got = await streams.read(s.asSession(), FLY, false);
    expect(got[0]).toMatchObject({ bid: null, ask: null, iv: null });
    expect(got[1]).toMatchObject({ bid: null, ask: null, iv: null });
    expect(got[2]).toMatchObject({ bid: 0, ask: 0.05, iv: 0.15 });
    expect(s.settled).toBeLessThanOrEqual(OptionMarkStreams.QUOTE_WAIT_MS + 50); // 等到上限为止,不会一直等
  });

  it("订阅被 TWS 拒了:原文带出去;下一次读把那条摘掉重订", async () => {
    const s = new FakeSession();
    s.ticks.set(7750, { bid: NaN, ask: NaN, modelGreeks: null, error: "10197 No market data during competing live session" });
    const got = await streams.read(s.asSession(), FLY, false);
    expect(got[1]).toMatchObject({ ask: null, iv: null, error: "10197 No market data during competing live session" });
    expect(got[0]!.error).toBeNull();
    s.ticks.delete(7750);
    const again = await streams.read(s.asSession(), FLY, false);
    expect(again[1]).toMatchObject({ ask: 1.2, iv: 0.15, error: null });
    expect(s.log.filter((l) => l === "sub:7750C#106")).toHaveLength(2);
    expect(s.log.filter((l) => l === "cancel:7750C#106")).toHaveLength(1);
  });

  it("合约确认不了:说是哪一张;一条流都不订", async () => {
    const s = new FakeSession();
    s.unknown.add(7775);
    await expect(streams.read(s.asSession(), FLY, false)).rejects.toThrow(/IBKR 确认不了这张合约\(SPX OPT 20260928 7775 C SPXW\)/);
    await expect(streams.read(s.asSession(), FLY, false)).rejects.toBeInstanceOf(OptionMarksError);
    expect(s.count("sub:")).toBe(0);
  });

  it("TWS 不回应合约确认:说清楚是连接的事", async () => {
    const s = new FakeSession();
    s.qualifyTimesOut = true;
    await expect(streams.read(s.asSession(), FLY, false)).rejects.toThrow(/TWS 在 12 秒内没有回应合约确认请求/);
  });

  it("一次读失败不堵住下一次", async () => {
    const s = new FakeSession();
    s.unknown.add(7775);
    await expect(streams.read(s.asSession(), FLY, false)).rejects.toThrow();
    s.unknown.clear();
    expect(await streams.read(s.asSession(), FLY, false)).toHaveLength(3);
  });
});

describe("等多久", () => {
  it("盘口和 IV 都在:几乎不等", async () => {
    const s = new FakeSession();
    await streams.read(s.asSession(), FLY, false);
    expect(s.settled).toBeLessThanOrEqual(300);
  });

  it("盘口先到、IV 晚一拍:等到 IV 来", async () => {
    const s = new FakeSession();
    for (const k of [7725, 7750, 7775]) s.ticks.set(k, { modelGreeks: null });
    s.onSettle = (elapsed) => { if (elapsed >= 800) s.ticks.clear(); };
    const got = await streams.read(s.asSession(), FLY, false);
    expect(got.every((m) => m.iv === 0.15)).toBe(true);
    expect(s.settled).toBeLessThan(1_500);
  });

  it("IV 一直不来(休市):盘口齐了之后最多再等一秒半", async () => {
    const s = new FakeSession();
    for (const k of [7725, 7750, 7775]) s.ticks.set(k, { modelGreeks: null });
    const got = await streams.read(s.asSession(), FLY, false);
    expect(got.every((m) => m.iv === null && m.ask === 1.2)).toBe(true);
    expect(s.settled).toBeLessThanOrEqual(OptionMarkStreams.IV_WAIT_MS + 600);
  });
});

describe("纸面会话", () => {
  it("新订的时候切到类型 3,订完切回去;流是热的时候不切", async () => {
    const s = new FakeSession();
    await streams.read(s.asSession(), FLY, true);
    expect(s.log[1]).toBe("type:3");
    expect(s.log[s.log.length - 1]).toBe("type:1");
    const before = s.log.length;
    await streams.read(s.asSession(), FLY, true);
    expect(s.log.length).toBe(before);
  });

  it("实盘会话:绝不切到延迟行情", async () => {
    const s = new FakeSession();
    await streams.read(s.asSession(), FLY, false);
    expect(s.count("type:")).toBe(0);
  });
});

describe("排队", () => {
  it("两次读同时来:一前一后跑,流只订一遍", async () => {
    const s = new FakeSession();
    const [a, b] = await Promise.all([streams.read(s.asSession(), FLY, false), streams.read(s.asSession(), FLY, false)]);
    expect(a).toEqual(b);
    expect(s.count("sub:")).toBe(3);
  });
});
