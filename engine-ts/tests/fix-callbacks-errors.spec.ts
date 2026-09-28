/** 错误通道上的一条错误,什么时候才能宣判一张单(engine/callbacks.ts onIbError)。
 *
 * 2026-09-27 审出两件事:
 *  · IB 的错误只带 reqId,而历史数据 / 合约查询的请求号和订单号在同一条数轴上(IBApiNext 的请求号从 1 数起)。
 *    一条 162「历史数据超频」只要和一张活着的托管止盈单同号,那张单就被当成"被拒":缓存摘掉、记录落
 *    ibkr_error、60 秒后再挂一张——原来那张还在券商那边挂着,从此没人管它。
 *  · 改价被拒(追价平仓那张单、托管单)时原单还按上一次被接受的价挂着,可追价那一路把它当成"单子没了":
 *    不追了、记录落终态、提醒"已失效,持仓可能还在"——用户照着手动再平一次,两张一起成交就是反向开仓。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EtNow } from "../src/config.js";
import { etNowFromEpoch } from "../src/config.js";
import { TradingEngine } from "../src/engine.js";
import { IbCallbacks } from "../src/engine/callbacks.js";
import * as fx from "../src/flyexit.js";
import { Notifier } from "../src/notify.js";
import { LLMResponse } from "../src/providers.js";
import { pyRound } from "../src/py.js";
import { TradeStore } from "../src/store.js";
import * as tk from "../src/tracker.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");
type Rec = Record<string, any>;

afterEach(() => {
  vi.useRealTimers();
});

function tmpDb(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "dafri-fixcb-")), name);
}

// ---------------------------------------------------------------- 托管单(正股)
class HostedRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  placed: Rec[] = [];
  modified: Rec[] = [];
  cancelled: number[] = [];
  private nextId = 500;
  constructor(public rows: Rec[]) {}
  async positions(): Promise<Rec[]> { return this.rows; }
  async placeHosted(_a: Rec, _c: Rec, item: Rec, oca: string, ref: string): Promise<Rec> {
    this.nextId += 1;
    this.placed.push({ item: { ...item }, oca, ref, order_id: this.nextId });
    return { order_id: this.nextId, perm_id: null, status: "PreSubmitted" };
  }
  async modifyHosted(orderId: number, item: Rec): Promise<boolean> { this.modified.push({ order_id: orderId, item: { ...item } }); return true; }
  async cancelHosted(orderId: number): Promise<boolean> { this.cancelled.push(orderId); return true; }
  async listHostedOpen(): Promise<Rec[]> { return []; }
  async indexPrice(): Promise<number | null> { return null; }
  async legQuotes(): Promise<any[]> { return []; }
  async place(): Promise<any> { throw new Error("not used"); }
  async cancelAllOpen(): Promise<number> { return 0; }
  sessions(): unknown[] { return []; }
}

function nvda(): Rec {
  const row: Rec = {
    account: "模拟", symbol: "NVDA", sec_type: "STK", quantity: 100.0, avg_cost: 180.0, multiplier: 1.0, currency: "USD",
    market_price: 220.0, market_value: 22000.0, unrealized_pnl: 4000.0,
    contract: { secType: "STK", symbol: "NVDA", exchange: "SMART", currency: "USD" },
  };
  row["key"] = `${row["account"]}|${row["symbol"]}|${row["sec_type"]}`;
  return row;
}

function hostedEngine(): { engine: TradingEngine; router: HostedRouter; tid: string } {
  const settings = makeSettings(g.base_config, { policies: { auto_execute: true }, storage: { db_path: tmpDb("h.db") } });
  const router = new HostedRouter([nvda()]);
  const engine = new TradingEngine({
    settings, parser: {} as any, store: new TradeStore(settings.db_path), notifier: new Notifier(false), router: router as any,
  });
  const track = engine.store.addTrack({
    account: "模拟", symbol: "NVDA", sec_type: "STK", contract: { secType: "STK", symbol: "NVDA", exchange: "SMART", currency: "USD" },
    targets: { take_profit: 250.0, stop_loss: 160.0 }, auto_close: { enabled: true, host_at_broker: true }, peak: 220.0,
  });
  return { engine, router, tid: String(track["id"]) };
}

function lastWarning(engine: TradingEngine, recordId: string): string {
  const warnings = (engine.store.getRecord(recordId)!["post_warnings"] ?? []) as Rec[];
  return String(warnings.at(-1)?.["message"] ?? "");
}

describe("数据请求的错误码撞上订单号:不宣判那张单", () => {
  it("162 历史数据超频与活着的托管止盈单同号 → 不摘、不落终态、之后也不再挂一张", async () => {
    const { engine, router, tid } = hostedEngine();
    await engine.syncHosted();
    const tp = router.placed[0]!["order_id"] as number;
    engine.onOrderStatus({ order: { orderId: tp }, orderStatus: { status: "Submitted", filled: 0, remaining: 100 } });
    const recordId = engine.orderIndex.get(tp)!;

    engine.onIbError(tp, 162, "Historical Market Data Service error message:Pacing violation");
    expect(engine.hostedOrders.tpEntry(tid)?.["order_id"]).toBe(tp);
    expect(engine.store.getRecord(recordId)!["final_status"]).toBeNull();
    expect(lastWarning(engine, recordId)).toContain("IBKR 162");

    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ["Date"] });
    await engine.syncHosted();
    expect(router.placed).toHaveLength(2); // 还是最初那两张(止盈 + 止损),没有第三张
  });

  it("早到的数据请求错误不留给下一张同号的单", async () => {
    const { engine, router, tid } = hostedEngine();
    engine.onIbError(501, 162, "HMDS query returned no data");
    engine.onIbError(502, 200, "No security definition has been found for the request");
    await engine.syncHosted();
    expect(router.placed.map((p) => p["order_id"])).toEqual([501, 502]);
    expect(engine.hostedOrders.tpEntry(tid)?.["order_id"]).toBe(501);
    const out = await engine.syncHosted();
    expect(out.blocked).toEqual([]);
    expect(out.hosted[0]!.orders.map((o) => o.kind).sort()).toEqual(["sl", "tp"]);
  });

  it("200 查不到合约(合约查询天天报)与在途的普通单同号 → 只记警告,不落终态", async () => {
    const { engine, id } = await submittedAapl();
    // 这张单早就挂出去了(超出发单后的判定窗口):此刻来的 200 是撞了号的数据请求
    engine.sentOrders.set(1024, { at: Date.now() - 60_000, kind: "place" });
    engine.onIbError(1024, 200, "No security definition has been found for the request");
    expect(engine.store.getRecord(id)!["final_status"]).toBeNull();
    expect(lastWarning(engine, id)).toContain("IBKR 200");
    // 真的订单错误照旧落终态(别把过滤写宽了)
    engine.onIbError(1024, 201, "Order rejected - insufficient margin");
    expect(engine.store.getRecord(id)!["final_status"]).toBe("ibkr_error");
  });

  it("刚发出的单紧跟着来 200:那是在回这张单(合约无效),照常落终态", async () => {
    const { engine, id } = await submittedAapl();
    engine.onIbError(1024, 200, "No security definition has been found for the request");
    expect(engine.store.getRecord(id)!["final_status"]).toBe("ibkr_error");
  });
});

// ---------------------------------------------------------------- 普通单(与 ib-error-codes 同一张)
const FRIDAY: EtNow = { epochMs: 0, date: "2026-08-14", minutes: 10 * 60 + 32, seconds: 0 };
const AAPL = {
  intent_summary: "限价 230 买入 100 股 AAPL",
  contract: { secType: "STK", symbol: "AAPL", exchange: "SMART", currency: "USD" },
  execution_type: "IMMEDIATE", trigger: null, account: "DEFAULT",
  order: { action: "BUY", orderType: "LMT", totalQuantity: 100, price_mode: "EXPLICIT", lmtPrice: 230.0, tif: "DAY", outsideRth: false },
  reason: "回调到位", confidence: 0.99, warnings: [],
};

async function submittedAapl(): Promise<{ engine: TradingEngine; id: string }> {
  const settings = makeSettings(g.base_config, { storage: { db_path: tmpDb("e.db") }, policies: { auto_execute: true } });
  const parser = {
    async parse(): Promise<LLMResponse> {
      return new LLMResponse(JSON.stringify({ orders: [AAPL], rejections: [] }), "claude-opus-5", "v", "f", 42);
    },
  };
  const router = {
    BROKER: "ibkr",
    indexPrice: () => null,
    async place(recordId: string) {
      return { record_id: recordId, order_id: 1024, perm_id: 7788, status: "Submitted", limit_price: null, detail: {} };
    },
    async legQuotes() { return []; },
  };
  const engine = new TradingEngine({
    settings, parser: parser as any, store: new TradeStore(settings.db_path), notifier: new Notifier(false), router: router as any,
  });
  const result = await engine.handleInstruction("买入 AAPL 100股 limit 230", "manual", FRIDAY, {}, []);
  expect(result.submitted).toHaveLength(1);
  return { engine, id: result.submitted[0]!.record_id as string };
}

// ---------------------------------------------------------------- 发单账本(宿主接上之后)
function ledgerHost() {
  const store = new TradeStore(tmpDb("l.db"));
  const hostedErrors: Array<[number, number]> = [];
  const chaseStatuses: string[] = [];
  const chaseRestored: number[] = [];
  const host = {
    store,
    notifier: new Notifier(false),
    orderIndex: new Map<number, string>(),
    finalized: new Set<string>(),
    seenFills: new Set<string>(),
    seenCommissions: new Set<string>(),
    unmatchedEvents: [] as Array<[string, any, any, any]>,
    earlyOrderErrors: new Map<number, [number, string, number]>(),
    hostedOrders: {
      handleError(orderId: number, code: number): boolean { hostedErrors.push([orderId, code]); return false; },
      onStatus(): void { /* 不涉及 */ },
    },
    closeChaseIndex: new Map<number, string>(),
    closeChaseOnStatus(trade: Rec): void { chaseStatuses.push(String(trade["orderStatus"]["status"])); },
    closeChaseModifyRejected(orderId: number): void { chaseRestored.push(orderId); },
    sentOrders: new Map<number, { at: number; kind: "place" | "modify" | "cancel" }>(),
  };
  const record = (orderId: number): string => {
    const id = store.createRecord({ contract: { secType: "STK", symbol: "AAPL" }, order: { totalQuantity: 100 } });
    store.appendEvent(id, "status", { status: "Submitted", order_id: orderId });
    host.orderIndex.set(orderId, id);
    return id;
  };
  return { host, callbacks: new IbCallbacks(host), record, hostedErrors, chaseStatuses, chaseRestored };
}

describe("宿主接上发单账本之后:只有本会话真发过的号才落终态", () => {
  it("上个会话留下、对账认领回来的单(账本里没有)→ 201 只记警告", () => {
    const { host, callbacks, record } = ledgerHost();
    const adopted = record(82);
    callbacks.onIbError(82, 201, "Order rejected - reason: margin");
    expect(host.store.getRecord(adopted)!["final_status"] ?? null).toBeNull();
    expect(JSON.stringify(host.store.getRecord(adopted))).toContain("IBKR 201");
  });

  it("本会话刚发的单 → 201 照旧落终态", () => {
    const { host, callbacks, record } = ledgerHost();
    const ours = record(90);
    host.sentOrders.set(90, { at: Date.now(), kind: "place" });
    callbacks.onIbError(90, 201, "Order rejected - reason: margin");
    expect(host.store.getRecord(ours)!["final_status"]).toBe("ibkr_error");
  });

  it("200 / 321:刚对这个号发过单才算订单的错误;发了很久的单同号,是别的请求撞上了", () => {
    const { host, callbacks, record } = ledgerHost();
    const fresh = record(91);
    const old = record(92);
    host.sentOrders.set(91, { at: Date.now() - 1_000, kind: "place" });
    host.sentOrders.set(92, { at: Date.now() - 5 * 60_000, kind: "place" });
    callbacks.onIbError(91, 321, "Error validating request: The API interface is currently in Read-Only mode.");
    callbacks.onIbError(92, 200, "No security definition has been found for the request");
    expect(host.store.getRecord(fresh)!["final_status"]).toBe("ibkr_error");
    expect(host.store.getRecord(old)!["final_status"] ?? null).toBeNull();
  });

  it("追价平仓单改价被拒 → 请宿主把追价缓存恢复成上一次被接受的限价,不当成单子没了", () => {
    const { host, callbacks, record, chaseStatuses, chaseRestored } = ledgerHost();
    const recordId = record(990);
    host.closeChaseIndex.set(990, "trk-1");
    host.sentOrders.set(990, { at: Date.now(), kind: "modify" });
    host.store.appendEvent(recordId, "status", { status: "Adjusted", lmt_price: 3.55 });
    callbacks.onIbError(990, 201, "Order rejected - reason: price exceeds the Percentage constraint");
    expect(chaseRestored).toEqual([990]);
    expect(chaseStatuses).toEqual([]);
    expect(host.store.getRecord(recordId)!["final_status"] ?? null).toBeNull();
  });

  it("认领回来的托管单(没有记录)刚被我们改过价 → 改价被拒要交给托管那一路", () => {
    const { host, callbacks, hostedErrors } = ledgerHost();
    host.sentOrders.set(86, { at: Date.now(), kind: "modify" });
    callbacks.onIbError(86, 110, "The price does not conform to the minimum price variation for this contract.");
    expect(hostedErrors).toEqual([[86, 110]]);
    expect(host.earlyOrderErrors.has(86)).toBe(false);
  });
});

// ---------------------------------------------------------------- 改价被拒:原单还在
describe("改价被拒:原单还按上一次被接受的价挂着", () => {
  it("托管止盈单改价被拒 → 记录不落终态;之后真成交了记 filled", async () => {
    const { engine, router, tid } = hostedEngine();
    await engine.syncHosted();
    const tp = router.placed[0]!["order_id"] as number;
    engine.onOrderStatus({ order: { orderId: tp }, orderStatus: { status: "Submitted", filled: 0, remaining: 100 } });
    engine.store.updateTrack(tid, { targets: { take_profit: 251.0, stop_loss: 160.0 } });
    await engine.syncHosted(); // 改价 → 251
    expect(router.modified).toHaveLength(1);
    const recordId = engine.orderIndex.get(tp)!;

    engine.onIbError(tp, 110, "The price does not conform to the minimum price variation for this contract.");
    expect(engine.hostedOrders.tpEntry(tid)?.["lmt_price"]).toBe(250); // 托管那一路恢复成上一版
    expect(engine.store.getRecord(recordId)!["final_status"]).toBeNull();

    engine.onOrderStatus({ order: { orderId: tp }, orderStatus: { status: "Filled", filled: 100, remaining: 0 } });
    expect(engine.store.getRecord(recordId)!["final_status"]).toBe("filled");
  });

  it("追价平仓单改价被拒 → 接着追、不落终态、不提醒「已失效」", async () => {
    const { engine, router, track } = chaseEngine();
    await chaseUntilFirstModify(engine, router);
    const recordId = engine.orderIndex.get(990)!;

    engine.onIbError(990, 201, "Order rejected - reason: The price exceeds the Percentage constraint of 3%.");
    expect(engine.store.getRecord(recordId)!["final_status"]).toBeNull();
    expect(engine.store.getTrack(track["id"])!["fired_state"]).toBe("sweep:take_profit");
    expect(engine.notifier.history.some(([, , body]) => body.includes("已失效"))).toBe(false);
    expect(engine.notifier.history.some(([title, , body]) => `${title}${body}`.includes("改价被券商拒绝"))).toBe(true);

    const before = router.modified.length;
    await engine.pollTrackers(NOON);
    expect(router.modified.length).toBe(before + 1); // 还在追同一张单
    expect(router.modified.at(-1)!["order_id"]).toBe(990);
    expect(router.sent).toHaveLength(1);             // 没有第二张平仓单
  });

  it("追价平仓单改价时券商回「已成交,不能改」(104)→ 不判成 ibkr_error,等成交回报定终态", async () => {
    const { engine, router, track } = chaseEngine();
    await chaseUntilFirstModify(engine, router);
    const recordId = engine.orderIndex.get(990)!;
    engine.onIbError(990, 104, "Can't modify a filled order");
    expect(engine.store.getRecord(recordId)!["final_status"]).toBeNull();
    engine.onOrderStatus({ order: { orderId: 990, permId: null }, orderStatus: { status: "Filled", filled: 1, remaining: 0 }, contract: { symbol: "SPX" } });
    expect(engine.store.getRecord(recordId)!["final_status"]).toBe("filled");
    expect(engine.store.getTrack(track["id"])!["fired_state"]).toBe("take_profit");
  });

  it("发出去就被拒(还没改过价)→ 照旧:不追了、落终态、提醒持仓可能还在", async () => {
    const { engine, router, track } = chaseEngine();
    router.rows = flyAt(7741);
    router.spot = 7741;
    await engine.pollTrackers(NOON); // 发单
    const recordId = engine.orderIndex.get(990)!;
    engine.onIbError(990, 201, "Order rejected - reason: insufficient margin");
    expect(engine.store.getRecord(recordId)!["final_status"]).toBe("ibkr_error");
    expect(engine.store.getTrack(track["id"])!["fired_state"]).toBe("take_profit");
    expect(engine.notifier.history.some(([, , body]) => body.includes("已失效"))).toBe(true);
    await engine.pollTrackers(NOON);
    await engine.pollTrackers(NOON);
    await engine.pollTrackers(NOON);
    expect(router.modified).toEqual([]);
  });
});

// ---------------------------------------------------------------- 追价平仓(没开托管的组合),同 sweep.spec
const EXPIRY = "20260910";
const NOON = etNowFromEpoch(Date.parse("2026-09-10T12:00:00-04:00"));

function legRow(strike: number, qty: number, spot: number, avgCost: number): Rec {
  const contract = { secType: "OPT", symbol: "SPX", lastTradeDateOrContractMonth: EXPIRY, strike, right: "C", multiplier: "100" };
  const ident = tk.legOf(contract);
  return {
    key: tk.makeKey("模拟", "SPX", "OPT", ident), account: "模拟", symbol: "SPX", sec_type: "OPT",
    leg: ident, quantity: qty, avg_cost: avgCost, multiplier: 100.0, currency: "USD",
    market_price: pyRound(fx.bachelierCall(spot, strike, 20), 4), market_value: null, unrealized_pnl: null, contract,
  };
}

function flyAt(spot: number): Rec[] {
  return [legRow(7725, 1, spot, 800), legRow(7750, -2, spot, 200), legRow(7775, 1, spot, 50)];
}

class ChaseRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  modified: Rec[] = [];
  sent: Rec[] = [];
  constructor(public rows: Rec[], public spot: number | null) {}
  async positions(): Promise<Rec[]> { return [...this.rows]; }
  async indexPrice(): Promise<number | null> { return this.spot; }
  async optionQuotes(rows: Rec[]): Promise<Record<string, { bid: number | null; ask: number | null }>> {
    return Object.fromEntries(rows.map((r) => {
      const mid = Number(r["market_price"]);
      const s = Math.min(0.2, mid / 2);
      return [r["key"], { bid: mid - s, ask: mid + s }];
    }));
  }
  async placeHosted(): Promise<Rec> { throw new Error("not used"); }
  async modifyHosted(orderId: number, item: Rec): Promise<boolean> { this.modified.push({ order_id: orderId, item: { ...item } }); return true; }
  async cancelHosted(): Promise<boolean> { return true; }
  async listHostedOpen(): Promise<Rec[]> { return []; }
  async place(recordId: string, approved: Rec): Promise<Rec> {
    this.sent.push(approved);
    return { record_id: recordId, order_id: 990, perm_id: null, status: "Submitted", limit_price: null, detail: {} };
  }
  async legQuotes(): Promise<any[]> { return []; }
  async cancelAllOpen(): Promise<number> { return 0; }
  async contractHours(): Promise<null> { return null; }
  cachedContractHours(): null { return null; }
  sessions(): unknown[] { return []; }
}

function chaseEngine(): { engine: TradingEngine; router: ChaseRouter; track: Rec } {
  const settings = makeSettings(g.base_config, { policies: { auto_execute: true }, storage: { db_path: tmpDb("c.db") } });
  const router = new ChaseRouter(flyAt(7720), 7720);
  const engine = new TradingEngine({
    settings, parser: {} as any, store: new TradeStore(settings.db_path), notifier: new Notifier(false), router: router as any,
  });
  const combo = tk.withCombos(router.rows).find((r) => r["sec_type"] === "BAG")!;
  const track = engine.store.addTrack({
    account: "模拟", symbol: "SPX", sec_type: "BAG", leg: combo["leg"], contract: combo["contract"],
    targets: { spot_target: 7740 },
    auto_close: { enabled: true, order_type: "LMT", host_at_broker: false, close_fraction_pct: 100 },
    peak: null,
  });
  return { engine, router, track };
}

/** 标的到了目标价 → 发平仓单;之后几轮没成交,追到第一次改价为止(sweep.spec 同一条路)。 */
async function chaseUntilFirstModify(engine: TradingEngine, router: ChaseRouter): Promise<void> {
  router.rows = flyAt(7741);
  router.spot = 7741;
  await engine.pollTrackers(NOON);
  engine.onOrderStatus({ order: { orderId: 990, permId: null }, orderStatus: { status: "Submitted", filled: 0, remaining: 1 }, contract: { symbol: "SPX" } });
  for (let i = 0; i < 6 && router.modified.length === 0; i += 1) await engine.pollTrackers(NOON);
  expect(router.modified).toHaveLength(1);
}
