/** 执行对账:重启 / 重连之后,把券商那边的真相搬回库里(engine.reconcileOrders)。
 *
 * 引擎一重建,orderIndex 就是空的:普通单与条件单的后续回报认不出记录,只会进 unmatchedEvents
 * 然后被挤掉,那条记录永远停在 Submitted。托管单有 adoptHosted、追价平仓单有 adoptCloseChase,
 * 这里补的是剩下那一类。
 *
 * 盯的是四件事:认领(券商侧还挂着)、补录(断线期间成交了)、留痕(去向不明,**不落终态**)、
 * 克制(刚发出去的单、本进程还在盯的条件单,一律不动)。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TradingEngine } from "../src/engine.js";
import { Notifier } from "../src/notify.js";
import { TradeStore } from "../src/store.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");

type Rec = Record<string, any>;

const NOW = Date.parse("2026-09-18T10:30:00-04:00");
/** 宽限期之外(默认 2 分钟),对账才会碰它。 */
const OLD = new Date(NOW - 10 * 60_000).toISOString();

class FakeRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  openRows: Rec[] = [];
  listCalls = 0;

  async listOpenOrdersDetailed(): Promise<Rec[]> {
    this.listCalls += 1;
    return [...this.openRows];
  }

  async positions(): Promise<Rec[]> { return []; }
  async listHostedOpen(): Promise<Rec[]> { return []; }
  async place(): Promise<any> { throw new Error("not used"); }
  async cancelAllOpen(): Promise<number> { return 0; }
  sessions(): unknown[] { return []; }
}

function buildEngine(router: FakeRouter) {
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-reconcile-"));
  const settings = makeSettings(g.base_config, { storage: { db_path: path.join(dir, "reconcile.db") } });
  const notifier = new Notifier(false);
  const engine = new TradingEngine({
    settings, parser: {} as any, store: new TradeStore(settings.db_path), notifier, router: router as any,
  });
  return { engine, notifier };
}

/** 一条"发出去了、还没有终态"的记录(= listWorkingRecords 认的在途单)。 */
function workingRecord(engine: TradingEngine, over: Rec = {}): string {
  const recordId = engine.store.createRecord({
    created_at: OLD,
    contract: { secType: "STK", symbol: "AAPL" },
    order: { totalQuantity: 100 },
    ...over,
  });
  engine.store.appendEvent(recordId, "status", { status: String(over["status"] ?? "Submitted") });
  return recordId;
}

function openRow(recordId: string, over: Rec = {}): Rec {
  return {
    order_ref: recordId, order_id: 777, perm_id: 9001, account: "DU1",
    action: "BUY", order_type: "LMT", quantity: 100, lmt_price: 230.0,
    status: "Submitted", sec_type: "STK", ...over,
  };
}

function fillRow(recordId: string, over: Rec = {}): Rec {
  return {
    exec_id: `exec-${Math.random().toString(16).slice(2)}`,
    time: "2026-09-18T13:31:00+00:00", account_id: "DU1", side: "BOT",
    shares: 100, price: 230.0, order_id: 777, perm_id: 9001,
    order_ref: recordId, commission: 1.0,
    contract: { secType: "STK", symbol: "AAPL" },
    ...over,
  };
}

function statuses(engine: TradingEngine, recordId: string): string[] {
  const record = engine.store.getRecord(recordId)!;
  return (record["ibkr"]["status_timeline"] as Rec[]).map((s) => String(s["status"] ?? ""));
}

// ----------------------------------------------------------------------
describe("对账 ①:券商侧还挂着的单,按 orderRef 认领回来", () => {
  it("重建 orderId → 记录的索引:认领之后的状态回报能落到记录上,而不是掉进缓冲", async () => {
    const router = new FakeRouter();
    const { engine } = buildEngine(router);
    const recordId = workingRecord(engine);
    router.openRows = [openRow(recordId)];

    // 认领之前:回报认不出记录(orderIndex 是空的),记录上什么都不会多
    engine.onOrderStatus({ order: { orderId: 777 }, orderStatus: { status: "PreSubmitted" } });
    expect(statuses(engine, recordId)).toEqual(["Submitted"]);

    const out = await engine.reconcileOrders(NOW);
    expect(out.adopted).toBe(1);

    // 认领之后:同一张单的成交回报落到记录上,终态也跟着落
    engine.onOrderStatus({
      order: { orderId: 777 }, orderStatus: { status: "Filled", filled: 100, remaining: 0 },
    });
    const record = engine.store.getRecord(recordId)!;
    expect(record["final_status"]).toBe("filled");
  });

  it("每分钟一轮的对账不重复记事件:已经在索引里的单,第二轮什么都不加", async () => {
    const router = new FakeRouter();
    const { engine } = buildEngine(router);
    const recordId = workingRecord(engine);
    router.openRows = [openRow(recordId)];

    expect((await engine.reconcileOrders(NOW)).adopted).toBe(1);
    expect((await engine.reconcileOrders(NOW + 60_000)).adopted).toBe(0);
    expect(statuses(engine, recordId)).toEqual(["Submitted", "Submitted"]); // 认领那一条,仅此一条
  });

  it("托管单(trk: 前缀)不归这里管——adoptHosted 自己有一套认领与去重", async () => {
    const router = new FakeRouter();
    const { engine } = buildEngine(router);
    const recordId = workingRecord(engine);
    router.openRows = [openRow(recordId, { order_ref: "trk:abc:tp" })];

    const out = await engine.reconcileOrders(NOW);
    expect(out.adopted).toBe(0);
    expect(out.unknown).toBe(1); // 这条记录在券商侧确实找不到了
  });
});

describe("对账 ②:券商侧没有、成交表里有——断线期间成交了", () => {
  it("补录成交事件并落 filled 终态", async () => {
    const router = new FakeRouter();
    const { engine, notifier } = buildEngine(router);
    const recordId = workingRecord(engine);
    engine.store.rememberFills([fillRow(recordId)]);

    const out = await engine.reconcileOrders(NOW);
    expect(out.filled).toBe(1);

    const record = engine.store.getRecord(recordId)!;
    expect(record["final_status"]).toBe("filled");
    expect(record["ibkr"]["fills"]).toHaveLength(1);
    expect(record["ibkr"]["avg_fill_price"]).toBeCloseTo(230.0, 9);
    expect(notifier.history.some(([, , body]) => String(body).includes("断线期间已经成交"))).toBe(true);
  });

  it("只成交了一半 → 不落终态(部分成交的去向由用户定),但成交照样补录", async () => {
    const router = new FakeRouter();
    const { engine } = buildEngine(router);
    const recordId = workingRecord(engine);
    engine.store.rememberFills([fillRow(recordId, { shares: 40 })]);

    const out = await engine.reconcileOrders(NOW);
    expect(out.filled).toBe(0);
    const record = engine.store.getRecord(recordId)!;
    expect(record["final_status"] ?? null).toBeNull();
    expect(record["ibkr"]["fills"]).toHaveLength(1);
  });

  it("组合单只认 BAG 行:腿加起来是份数的好几倍,拿它判填满会把没成交的单标成已成交", async () => {
    const router = new FakeRouter();
    const { engine } = buildEngine(router);
    const recordId = workingRecord(engine, {
      contract: { secType: "BAG", symbol: "SPX" }, order: { totalQuantity: 2 },
    });
    // 1 条 BAG 行(1 份)+ 3 条腿(各 1、2、1 份):腿加起来 4 份,BAG 行只有 1 份
    engine.store.rememberFills([
      fillRow(recordId, { shares: 1, contract: { secType: "BAG", symbol: "SPX" } }),
      fillRow(recordId, { shares: 1, contract: { secType: "OPT", symbol: "SPX" } }),
      fillRow(recordId, { shares: 2, contract: { secType: "OPT", symbol: "SPX" } }),
      fillRow(recordId, { shares: 1, contract: { secType: "OPT", symbol: "SPX" } }),
    ]);

    const out = await engine.reconcileOrders(NOW);
    expect(out.filled).toBe(0); // 2 份只成交了 1 份
    expect(engine.store.getRecord(recordId)!["final_status"] ?? null).toBeNull();
  });
});

describe("对账 ③:去向不明的单只留痕,不落终态", () => {
  it("券商侧没有、也没查到成交 → 记一条 NotAtBroker 并提醒,终态仍然是空的", async () => {
    const router = new FakeRouter();
    const { engine, notifier } = buildEngine(router);
    const recordId = workingRecord(engine);

    const out = await engine.reconcileOrders(NOW);
    expect(out.unknown).toBe(1);
    expect(statuses(engine, recordId)).toEqual(["Submitted", "NotAtBroker"]);
    expect(engine.store.getRecord(recordId)!["final_status"] ?? null).toBeNull();
    expect(notifier.history.some(([, , body]) => String(body).includes("去向不明"))).toBe(true);
  });

  it("第二轮不再重复记:状态已经是 NotAtBroker 就放过", async () => {
    const router = new FakeRouter();
    const { engine } = buildEngine(router);
    const recordId = workingRecord(engine);

    await engine.reconcileOrders(NOW);
    const out = await engine.reconcileOrders(NOW + 60_000);
    expect(out.unknown).toBe(0);
    expect(statuses(engine, recordId)).toEqual(["Submitted", "NotAtBroker"]);
  });

  it("重启后没人盯的条件单也走这条路:理由换成「重新提交」,但同样不作废它", async () => {
    const router = new FakeRouter();
    const { engine, notifier } = buildEngine(router);
    const recordId = workingRecord(engine, { status: "PendingTrigger" });

    await engine.reconcileOrders(NOW);
    expect(engine.store.getRecord(recordId)!["final_status"] ?? null).toBeNull();
    expect(notifier.history.some(([, , body]) => String(body).includes("重新提交"))).toBe(true);
  });
});

describe("对账的克制:该放过的一律不动", () => {
  it("刚发出去的单在宽限期内不动:券商侧的未成交单列表有滞后,否则新单会被当成失联", async () => {
    const router = new FakeRouter();
    const { engine } = buildEngine(router);
    const recordId = workingRecord(engine, { created_at: new Date(NOW - 10_000).toISOString() });

    const out = await engine.reconcileOrders(NOW);
    expect(out).toEqual({ adopted: 0, filled: 0, unknown: 0 });
    expect(statuses(engine, recordId)).toEqual(["Submitted"]);
  });

  it("本进程还在盯的条件单不算失联:它本来就没发到券商", async () => {
    const router = new FakeRouter();
    const { engine } = buildEngine(router);
    const recordId = workingRecord(engine, { status: "PendingTrigger" });
    engine.pendingTriggers.push({ record_id: recordId } as any);

    const out = await engine.reconcileOrders(NOW);
    expect(out.unknown).toBe(0);
    expect(statuses(engine, recordId)).toEqual(["PendingTrigger"]);
  });

  it("仅校验未发送的记录不是在途单:对账不碰它", async () => {
    const router = new FakeRouter();
    const { engine } = buildEngine(router);
    const recordId = engine.store.createRecord({
      created_at: OLD, contract: { secType: "STK", symbol: "AAPL" }, order: { totalQuantity: 100 },
    });
    engine.store.appendEvent(recordId, "status", { status: "ValidatedOnly" });

    const out = await engine.reconcileOrders(NOW);
    expect(out).toEqual({ adopted: 0, filled: 0, unknown: 0 });
  });

  it("已经有终态的记录不再对账", async () => {
    const router = new FakeRouter();
    const { engine } = buildEngine(router);
    const recordId = workingRecord(engine);
    engine.store.setFinalStatus(recordId, "cancelled");

    const out = await engine.reconcileOrders(NOW);
    expect(out).toEqual({ adopted: 0, filled: 0, unknown: 0 });
  });

  it("router 没有这个能力(富途)→ 空转,不报错", async () => {
    const { engine } = buildEngine({ BROKER: "futu" } as any);
    const recordId = workingRecord(engine);

    const out = await engine.reconcileOrders(NOW);
    expect(out).toEqual({ adopted: 0, filled: 0, unknown: 0 });
    expect(statuses(engine, recordId)).toEqual(["Submitted"]);
  });
});

describe("对账的节拍", () => {
  it("60 秒一轮;接上新会话就立刻安排下一轮(断线期间的成交只能靠它搬回来)", async () => {
    const router = new FakeRouter();
    const { engine } = buildEngine(router);

    expect(engine.reconcileDue(NOW)).toBe(true);
    await engine.reconcileOrders(NOW);
    expect(engine.reconcileDue(NOW + 30_000)).toBe(false);
    expect(engine.reconcileDue(NOW + 60_000)).toBe(true);

    await engine.reconcileOrders(NOW);
    expect(engine.reconcileDue(NOW + 1_000)).toBe(false);
    engine.wireSession({ onOrderStatus: () => undefined }); // 新会话 = 刚连上 / 券商重启后重连
    expect(engine.reconcileDue(NOW + 1_000)).toBe(true);
  });
});
