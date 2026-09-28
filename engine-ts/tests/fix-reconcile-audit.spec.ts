/** 执行对账与已实现盈亏:2026-09-27 审计修的五处(H1 / H2 / H4 / M2 / M4)。
 *
 * 每一条都是"第一次接真券商才会冒出来"的那种错,离线只能靠这里钉住:
 *  · H1 托管单的记录(orderRef 是 trk:…,不是记录 id)被当成"券商侧没有",每分钟弹一次「去向不明」;
 *  · H2 应用关着时成交了的单,重启后被报成"也没查到它的成交"——对账从来没问过券商;
 *  · H4 同一笔成交的佣金回报在库里落了两次,日内亏损上限就按两倍算;
 *  · M2 券商那头的未成交单请求永远不回(会话被断开时),对账一直占着盯盘锁;
 *  · M4 宽限期按记录的创建时刻算,等了几个小时才触发的条件单一发出去就被当成失联。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PendingTrigger } from "../src/broker.js";
import { TradingEngine } from "../src/engine.js";
import { Notifier } from "../src/notify.js";
import { TradeStore } from "../src/store.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");

type EngineArgs = ConstructorParameters<typeof TradingEngine>[0];
type Row = Record<string, unknown>;

const MIN = 60_000;
/** 离线测试里的"现在":比真实时钟早,appendEvent 按真实时钟落的 at 在它之后(见 M4 那一组)。 */
const NOW = Date.parse("2026-09-18T10:30:00-04:00");
const OLD = new Date(NOW - 10 * MIN).toISOString();

class FakeRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  openRows: Row[] = [];
  listCalls = 0;
  /** 列未成交单时顺手做的事(模拟"对账等券商回话的那几百毫秒里,别处发了单")。 */
  duringList: (() => void) | null = null;

  async listOpenOrdersDetailed(): Promise<Row[]> {
    this.listCalls += 1;
    this.duringList?.();
    return [...this.openRows];
  }

  async positions(): Promise<Row[]> { return []; }
  async listHostedOpen(): Promise<Row[]> { return []; }
  async place(): Promise<never> { throw new Error("not used"); }
  async cancelAllOpen(): Promise<number> { return 0; }
  sessions(): unknown[] { return []; }
}

/** 带 executions()(= reqExecutions,当天的成交)的券商。 */
class ExecRouter extends FakeRouter {
  execRows: Row[] = [];
  execCalls = 0;
  execError: Error | null = null;

  async executions(): Promise<Row[]> {
    this.execCalls += 1;
    if (this.execError !== null) throw this.execError;
    return [...this.execRows];
  }
}

function buildEngine(router: FakeRouter, protections: Row = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-fix-reconcile-"));
  const settings = makeSettings(g.base_config, { storage: { db_path: path.join(dir, "r.db") }, protections });
  const notifier = new Notifier(false);
  const engine = new TradingEngine({
    settings,
    parser: {} as unknown as EngineArgs["parser"],
    store: new TradeStore(settings.db_path),
    notifier,
    router: router as unknown as EngineArgs["router"],
  });
  return { engine, notifier };
}

/** 按指定时刻落一条事件(appendEvent 只按真实时钟落,record_events 又是只增不改的)。 */
function appendEventAt(engine: TradingEngine, recordId: string, kind: string, payload: Row, atMs: number): void {
  engine.store.rawExec(
    "INSERT INTO record_events (record_id, at, kind, payload) VALUES (?,?,?,?)",
    [recordId, new Date(atMs).toISOString(), kind, JSON.stringify(payload)],
  );
}

function workingRecord(engine: TradingEngine, over: Row = {}, statusAtMs: number | null = null): string {
  const recordId = engine.store.createRecord({
    created_at: OLD, contract: { secType: "STK", symbol: "AAPL" }, order: { totalQuantity: 100 }, ...over,
  });
  const payload = { status: String(over["status"] ?? "Submitted") };
  if (statusAtMs === null) engine.store.appendEvent(recordId, "status", payload);
  else appendEventAt(engine, recordId, "status", payload, statusAtMs);
  return recordId;
}

/** 与 HostedOrders.placeHostedOne 落的同形:signature = orderRef = trk:<追踪>:<单型>,状态里带 order_id。 */
function hostedRecord(engine: TradingEngine, ref: string, orderId: number): string {
  const recordId = engine.store.createRecord({
    created_at: OLD,
    account: { alias: "主账户", account_id: "U1234567", is_paper: false },
    contract: { secType: "STK", symbol: "NVDA" },
    order: { action: "SELL", order_type: "STP", quantity: 100, aux_price: 180 },
    execution_type: "HOSTED",
    signature: ref,
  });
  engine.store.appendEvent(recordId, "status", { status: "Submitted", order_id: orderId });
  return recordId;
}

function fillRow(orderRef: string, over: Row = {}): Row {
  return {
    exec_id: `exec-${Math.random().toString(16).slice(2)}`,
    time: "2026-09-18T13:31:00+00:00", account_id: "DU1", side: "BOT",
    shares: 100, price: 230.0, order_id: 777, perm_id: 9001,
    order_ref: orderRef, commission: 1.0,
    contract: { secType: "STK", symbol: "AAPL" },
    ...over,
  };
}

function statuses(engine: TradingEngine, recordId: string): string[] {
  const record = engine.store.getRecord(recordId);
  return ((record?.["ibkr"]?.["status_timeline"] ?? []) as Row[]).map((s) => String(s["status"] ?? ""));
}

function warnings(notifier: Notifier): string[] {
  return notifier.history.map(([, , body]) => String(body)).filter((b) => b.includes("去向不明"));
}

afterEach(() => {
  vi.useRealTimers();
});

// ----------------------------------------------------------------------
describe("H1 托管单的记录:按 signature(= orderRef)认,不当成去向不明", () => {
  it("同一进程里:托管单挂着、每轮改价追加 Adjusted,对账一轮都不报去向不明", async () => {
    const router = new FakeRouter();
    const { engine, notifier } = buildEngine(router);
    const recordId = hostedRecord(engine, "trk:T1:sl", 85);
    engine.orderIndex.set(85, recordId); // placeHostedOne 挂单时就登记了
    router.openRows = [{ order_ref: "trk:T1:sl", order_id: 85, perm_id: 111, status: "PreSubmitted", sec_type: "STK" }];

    for (let round = 0; round < 3; round += 1) {
      const out = await engine.reconcileOrders(NOW + round * MIN);
      expect(out["unknown"]).toBe(0);
      engine.store.appendEvent(recordId, "status", { status: "Adjusted", aux_price: 181 + round });
    }
    expect(statuses(engine, recordId)).not.toContain("NotAtBroker");
    expect(warnings(notifier)).toEqual([]);
  });

  it("重启之后:按 signature + order_id 认领回来,之后这张托管单的成交能落到记录上", async () => {
    const router = new FakeRouter();
    const { engine, notifier } = buildEngine(router);
    const recordId = hostedRecord(engine, "trk:T1:sl", 85);
    router.openRows = [{ order_ref: "trk:T1:sl", order_id: 85, perm_id: 111, status: "PreSubmitted", sec_type: "STK" }];

    const out = await engine.reconcileOrders(NOW);
    expect(out).toEqual({ adopted: 1, filled: 0, unknown: 0 });
    expect(warnings(notifier)).toEqual([]);

    engine.onOrderStatus({ order: { orderId: 85, permId: 111 }, orderStatus: { status: "Filled", filled: 100, remaining: 0 } });
    expect(engine.store.getRecord(recordId)?.["final_status"]).toBe("filled");
  });

  it("同一 signature 的旧记录不冒领:券商侧挂着的是新那张(order_id 对不上)", async () => {
    const router = new FakeRouter();
    const { engine } = buildEngine(router);
    const stale = hostedRecord(engine, "trk:T1:sl", 80);
    const live = hostedRecord(engine, "trk:T1:sl", 85);
    router.openRows = [{ order_ref: "trk:T1:sl", order_id: 85, perm_id: 111, status: "PreSubmitted", sec_type: "STK" }];

    const out = await engine.reconcileOrders(NOW);
    expect(out["adopted"]).toBe(1);
    expect(engine.orderIndex.get(85)).toBe(live);
    expect(statuses(engine, stale)).toEqual(["Submitted", "NotAtBroker"]); // 它那张确实不在了
  });

  it("托管单在断线期间成交了:成交表里按 orderRef + order_id 找到,补录并落 filled", async () => {
    const router = new FakeRouter();
    const { engine } = buildEngine(router);
    const recordId = hostedRecord(engine, "trk:T1:sl", 85);
    engine.store.rememberFills([
      fillRow("trk:T1:sl", { order_id: 85, perm_id: 111, contract: { secType: "STK", symbol: "NVDA" } }),
      // 同一追踪更早那张(order_id 80)的成交不算在它头上
      fillRow("trk:T1:sl", { order_id: 80, perm_id: 110, shares: 50, contract: { secType: "STK", symbol: "NVDA" } }),
    ]);

    const out = await engine.reconcileOrders(NOW);
    expect(out["filled"]).toBe(1);
    const record = engine.store.getRecord(recordId);
    expect(record?.["final_status"]).toBe("filled");
    expect(record?.["ibkr"]?.["fills"]).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------
describe("H2 券商侧没有的单:先问券商当天的成交,再下结论", () => {
  it("成交只在券商那边(本地成交表空着):对账自己去取,补录并落 filled,不报去向不明", async () => {
    const router = new ExecRouter();
    const { engine, notifier } = buildEngine(router);
    const recordId = workingRecord(engine);
    router.execRows = [fillRow(recordId)];

    const out = await engine.reconcileOrders(NOW);
    expect(router.execCalls).toBe(1);
    expect(out["filled"]).toBe(1);
    expect(engine.store.getRecord(recordId)?.["final_status"]).toBe("filled");
    expect(engine.store.fillsByOrderRef(recordId)).toHaveLength(1); // 顺手存进了成交表
    expect(warnings(notifier)).toEqual([]);
  });

  it("券商那边也没有成交 → 这时才报去向不明", async () => {
    const router = new ExecRouter();
    const { engine, notifier } = buildEngine(router);
    const recordId = workingRecord(engine);

    const out = await engine.reconcileOrders(NOW);
    expect(out["unknown"]).toBe(1);
    expect(statuses(engine, recordId)).toEqual(["Submitted", "NotAtBroker"]);
    expect(warnings(notifier)).toHaveLength(1);
  });

  it("取成交失败:这一轮不下结论(没问到就不说「也没查到它的成交」)", async () => {
    const router = new ExecRouter();
    router.execError = new Error("读取成交明细失败");
    const { engine, notifier } = buildEngine(router);
    const recordId = workingRecord(engine);

    const out = await engine.reconcileOrders(NOW);
    expect(out["unknown"]).toBe(0);
    expect(statuses(engine, recordId)).toEqual(["Submitted"]);
    expect(warnings(notifier)).toEqual([]);
  });

  it("取成交有节流:几分钟内不重复问;新冒出来的失联单等下一次问过再说", async () => {
    const router = new ExecRouter();
    const { engine } = buildEngine(router);
    const first = workingRecord(engine);
    await engine.reconcileOrders(NOW);
    expect(router.execCalls).toBe(1);
    expect(statuses(engine, first)).toEqual(["Submitted", "NotAtBroker"]);

    const second = workingRecord(engine);
    await engine.reconcileOrders(NOW + MIN);
    expect(router.execCalls).toBe(1);
    expect(statuses(engine, second)).toEqual(["Submitted"]);

    await engine.reconcileOrders(NOW + 6 * MIN);
    expect(router.execCalls).toBe(2);
    expect(statuses(engine, second)).toEqual(["Submitted", "NotAtBroker"]);
  });

  it("接上新会话(断线期间可能成交)就不受节流限制", async () => {
    const router = new ExecRouter();
    const { engine } = buildEngine(router);
    workingRecord(engine);
    await engine.reconcileOrders(NOW);
    engine.reconcileSoon();
    await engine.reconcileOrders(NOW + MIN);
    expect(router.execCalls).toBe(2);
  });
});

// ----------------------------------------------------------------------
describe("H4 已实现盈亏按 exec_id 去重:同一笔成交的佣金回报落两次,只算一次", () => {
  it("重复的佣金事件不翻倍,日内亏损上限不被假触发", () => {
    const router = new FakeRouter();
    const { engine } = buildEngine(router, { daily_loss: { enabled: true, max_loss_usd: 500 } });
    const recordId = workingRecord(engine);
    engine.store.appendEvent(recordId, "commission", { exec_id: "E1", commission: 1, realized_pnl: -300 });
    engine.store.appendEvent(recordId, "commission", { exec_id: "E1", commission: 1, realized_pnl: -300 });

    const now = Date.now() + 1000;
    expect(engine.store.realizedPnlEvents(now - 3_600_000, now).map((p) => p.pnl)).toEqual([-300]);
    expect(engine.protectionState(now).pause).toBeNull();
  });

  it("先到的那条为准:昨天落过的成交今天又被重推一遍,不算进今天", () => {
    const router = new FakeRouter();
    const { engine } = buildEngine(router);
    const recordId = workingRecord(engine);
    const now = Date.now();
    appendEventAt(engine, recordId, "commission", { exec_id: "E9", commission: 1, realized_pnl: -300 }, now - 30 * 3_600_000);
    engine.store.appendEvent(recordId, "commission", { exec_id: "E9", commission: 1, realized_pnl: -300 });

    expect(engine.store.realizedPnlEvents(now - 3_600_000, now + 1000)).toEqual([]);
  });

  it("没有 exec_id 的认不出是不是同一笔,照旧都算(与 foldEvents 同口径)", () => {
    const router = new FakeRouter();
    const { engine } = buildEngine(router);
    const recordId = workingRecord(engine);
    engine.store.appendEvent(recordId, "commission", { exec_id: "", commission: 1, realized_pnl: -10 });
    engine.store.appendEvent(recordId, "commission", { exec_id: "", commission: 1, realized_pnl: -10 });
    const now = Date.now() + 1000;
    expect(engine.store.realizedPnlEvents(now - 3_600_000, now)).toHaveLength(2);
  });
});

// ----------------------------------------------------------------------
describe("M2 券商那头的请求永远不回:对账超时放手,不占着盯盘锁", () => {
  it("未成交单列表一直不回 → 10 秒后这一轮作罢并留痕,下一轮再来", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const router = new FakeRouter();
    router.listOpenOrdersDetailed = () => new Promise<Row[]>(() => undefined);
    const { engine } = buildEngine(router);
    const recordId = workingRecord(engine);

    const pending = engine.reconcileOrders(NOW);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ adopted: 0, filled: 0, unknown: 0 });
    expect(statuses(engine, recordId)).toEqual(["Submitted"]);
    const failed = (engine.store.exportAll()["audit_log"] as Row[]).filter((a) => a["action"] === "reconcile_failed");
    expect(failed.length).toBeGreaterThan(0);
  });

  it("一轮盯盘(持着盯盘锁)不会被卡死:下一件排队的事照样轮得到", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const router = new FakeRouter();
    router.listOpenOrdersDetailed = () => new Promise<Row[]>(() => undefined);
    const { engine } = buildEngine(router);

    const tick = engine.trackerTickOnce();
    let next = false;
    const queued = engine.withTrackerLock(async () => { next = true; });
    await vi.advanceTimersByTimeAsync(10_000);
    await tick;
    await queued;
    expect(next).toBe(true);
  });

  it("取成交也一直不回 → 同样超时,且这一轮不报去向不明", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const router = new ExecRouter();
    router.executions = () => new Promise<Row[]>(() => undefined);
    const { engine, notifier } = buildEngine(router);
    const recordId = workingRecord(engine);

    const pending = engine.reconcileOrders(NOW);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ adopted: 0, filled: 0, unknown: 0 });
    expect(statuses(engine, recordId)).toEqual(["Submitted"]);
    expect(warnings(notifier)).toEqual([]);
  });
});

// ----------------------------------------------------------------------
describe("M4 宽限期从最后一条状态回报算,不从记录创建时算", () => {
  it("等了三个小时的条件单刚触发、刚发出去:不当成失联", async () => {
    const router = new FakeRouter();
    const { engine, notifier } = buildEngine(router);
    const recordId = workingRecord(engine, {
      created_at: new Date(NOW - 3 * 3_600_000).toISOString(), status: "PendingTrigger",
    }, NOW - 3 * 3_600_000);
    appendEventAt(engine, recordId, "status", { status: "Submitted", order_id: 901 }, NOW - 30_000); // 触发、发出

    const out = await engine.reconcileOrders(NOW);
    expect(out["unknown"]).toBe(0);
    expect(warnings(notifier)).toEqual([]);
  });

  it("对账等券商回话的那一会儿,条件单触发发了出去(已从队列摘掉):也不当成失联", async () => {
    const router = new FakeRouter();
    const { engine, notifier } = buildEngine(router);
    const now = Date.now();
    const recordId = workingRecord(engine, {
      created_at: new Date(now - 3 * 3_600_000).toISOString(), status: "PendingTrigger",
    }, now - 3 * 3_600_000);
    engine.pendingTriggers.push({ record_id: recordId, fired: false } as unknown as PendingTrigger);
    router.duringList = () => {
      // firePending:发单 → 记状态 → 从队列里摘掉。券商这次给的列表是发单之前的
      engine.store.appendEvent(recordId, "status", { status: "Submitted", order_id: 902 });
      engine.pendingTriggers = [];
    };

    const out = await engine.reconcileOrders(now);
    expect(out["unknown"]).toBe(0);
    expect(warnings(notifier)).toEqual([]);
  });

  it("最后一条状态也是很久以前的 → 照常对账(宽限期不是豁免)", async () => {
    const router = new FakeRouter();
    const { engine } = buildEngine(router);
    const recordId = workingRecord(engine, { created_at: new Date(NOW - 3 * 3_600_000).toISOString() }, NOW - 3 * 3_600_000);

    const out = await engine.reconcileOrders(NOW);
    expect(out["unknown"]).toBe(1);
    expect(statuses(engine, recordId)).toEqual(["Submitted", "NotAtBroker"]);
  });
});
