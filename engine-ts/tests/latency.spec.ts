/** 时延优化专项:conId 缓存、组合腿批量确认、解析预热。
 *
 * 这些优化的正确性标准只有一条:**少打往返,但打出去的每一发都和原来一样**。
 * 测试计数 qualifyContracts 的调用次数与批量大小——次数错了是慢,批错了是错单。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { BrokerRouter } from "../src/broker.js";
import type { IbContract } from "../src/broker.js";
import { TradingEngine } from "../src/engine.js";
import { Notifier } from "../src/notify.js";
import { TradeStore } from "../src/store.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");

class CountingSession {
  connected = true;
  qualifyCalls: IbContract[][] = [];

  isConnected() { return this.connected; }
  disconnect() { this.connected = false; }
  managedAccounts() { return ["DU7654321", "U1234567"]; }
  async qualifyContracts(contracts: IbContract[], _timeout: number): Promise<void> {
    this.qualifyCalls.push([...contracts]);
    for (const c of contracts) c.conId = 9000 + Number(c.strike ?? 1);
  }
  reqMarketDataType(_t: number): void {}
  subscribeTicker() { return { read: () => ({ last: 7745.2, close: 7700, marketPrice: 7745.2 } as any) }; }
  cancelTicker(): void {}
  async settle(_ms: number): Promise<void> {}
  async historicalData() { return []; }
  async secDefOptParams() { return []; }
  async mktDepth() { return { bids: [], asks: [] }; }
  async placeOrder(_c: IbContract, _o: any) { return { orderId: 42, permId: 990042, status: "Submitted" }; }
  async openTrades() { return []; }
  async portfolio() { return []; }
  async positions() { return []; }
  onConnectivity(_cb: (code: number) => void): void {}
}

function routerWith(session: CountingSession): BrokerRouter {
  const settings = makeSettings(g.base_config);
  return new BrokerRouter(settings, async () => session as any);
}

const FLY: any = {
  secType: "BAG", symbol: "SPX", exchange: "SMART", currency: "USD",
  combo_strategy: "BUTTERFLY",
  legs: [
    { action: "BUY", ratio: 1, lastTradeDateOrContractMonth: "20260814", strike: 7600, right: "P", tradingClass: "SPXW", multiplier: "100" },
    { action: "SELL", ratio: 2, lastTradeDateOrContractMonth: "20260814", strike: 7615, right: "P", tradingClass: "SPXW", multiplier: "100" },
    { action: "BUY", ratio: 1, lastTradeDateOrContractMonth: "20260814", strike: 7630, right: "P", tradingClass: "SPXW", multiplier: "100" },
  ],
};

describe("latency: conId 缓存与批量确认", () => {
  it("组合三条腿一次批量确认;第二次同合约零往返", async () => {
    const session = new CountingSession();
    const router = routerWith(session);
    const account = router.settings.accountByAlias("模拟")!;

    const bag = await router.qualify(FLY, account);
    expect(session.qualifyCalls).toHaveLength(1);       // 一次批量,不是三次串行
    expect(session.qualifyCalls[0]).toHaveLength(3);
    expect((bag.comboLegs ?? []).map((l: any) => l.conId)).toEqual([16600, 16615, 16630]);

    const again = await router.qualify(FLY, account);
    expect(session.qualifyCalls).toHaveLength(1);       // 全部命中缓存:零往返
    expect((again.comboLegs ?? []).map((l: any) => l.conId)).toEqual([16600, 16615, 16630]);
  });

  it("单合约确认第二次也走缓存", async () => {
    const session = new CountingSession();
    const router = routerWith(session);
    const account = router.settings.accountByAlias("模拟")!;
    const stk: any = { secType: "STK", symbol: "AAPL", exchange: "SMART", currency: "USD" };
    await router.qualify(stk, account);
    await router.qualify(stk, account);
    expect(session.qualifyCalls).toHaveLength(1);
  });
});

describe("latency: 解析预热", () => {
  it("validated-only 后台 qualify,发送时组合腿零往返", async () => {
    const session = new CountingSession();
    const router = routerWith(session);
    const dir = mkdtempSync(path.join(tmpdir(), "dafri-latency-"));
    const settings = makeSettings(g.base_config, {
      storage: { db_path: path.join(dir, "lat.db") },
    });
    const engine = new TradingEngine({
      settings, parser: {} as any, store: new TradeStore(settings.db_path),
      notifier: new Notifier(false), router: router as any,
    });
    engine.publicPriceFn = async () => null; // 快照走注入,不出网

    const FRIDAY = { epochMs: 0, date: "2026-08-14", minutes: 632, seconds: 0 };
    const result = await engine.handleInstruction(
      "1.8 挂15蝴蝶 15CM", "manual", FRIDAY as any, { SPX: 7745.2 },
    );
    expect(result.validated_only).toHaveLength(1);
    await engine.prewarmPromise;                        // 业务代码不 await,测试等一下
    expect(session.qualifyCalls).toHaveLength(1);       // 预热已把三条腿批量确认

    // 模拟「发送」那一下:qualify 全命中缓存,零往返
    const account = router.settings.accountByAlias("模拟")!;
    const order = engine.store.getRecord(String(result.validated_only[0]!.record_id))!;
    await router.qualify(order.contract as any, account);
    expect(session.qualifyCalls).toHaveLength(1);
  });
});
