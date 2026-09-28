/** 引擎重建之后,券商回报还得落到**现在这个**引擎上。
 *
 * 2026-09-27 审出:settings.patch / llm.patch 走 ctx.reload() → dropEngine(),下一次用到时建一个新引擎,
 * 可会话上的回报监听是旧引擎挂的(闭包里是旧实例),会话又打着 _dafriWired 不许再挂——新引擎从此听不见:
 * 托管止损被拒,界面照样显示「已托管」;止盈成交了,追踪不落闩;部分成交的数量它也不知道。
 * 改完之后,在界面上动一下任何设置都不该让引擎变聋。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { RpcServer } from "../src/rpc.js";
import * as tk from "../src/tracker.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

/** 一条券商会话:只做回报那四个挂钩,记着挂了几次(不许重复挂)。 */
class FakeSession {
  status: Array<(trade: Rec) => void> = [];
  fill: Array<(trade: Rec, fill: Rec) => void> = [];
  commission: Array<(trade: Rec, fill: Rec, report: Rec) => void> = [];
  error: Array<(reqId: number, code: number, message: string) => void> = [];
  onOrderStatus(cb: (trade: Rec) => void): void { this.status.push(cb); }
  onFill(cb: (trade: Rec, fill: Rec) => void): void { this.fill.push(cb); }
  onCommission(cb: (trade: Rec, fill: Rec, report: Rec) => void): void { this.commission.push(cb); }
  onError(cb: (reqId: number, code: number, message: string) => void): void { this.error.push(cb); }
  emitStatus(orderId: number, status: string, filled = 0, remaining = 0): void {
    for (const cb of this.status) cb({ order: { orderId, permId: null }, orderStatus: { status, filled, remaining }, contract: { symbol: "BE" } });
  }
  emitError(reqId: number, code: number, message: string): void {
    for (const cb of this.error) cb(reqId, code, message);
  }
}

class FakeRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  sessionHook: ((session: unknown) => void) | null = null;
  live: FakeSession[] = [new FakeSession()];
  placed: Rec[] = [];
  cancelled: number[] = [];
  private nextId = 500;
  constructor(public rows: Rec[]) {}
  sessions(): unknown[] { return this.live; }
  connectedNames(): string[] { return ["paper"]; }
  /** broker.connect 连上一条新会话时做的事:交给 sessionHook 挂监听 */
  connectAnother(): FakeSession {
    const session = new FakeSession();
    this.live.push(session);
    this.sessionHook?.(session);
    return session;
  }
  async positions(): Promise<Rec[]> { return this.rows.map((r) => ({ ...r })); }
  async indexPrice(): Promise<number | null> { return null; }
  async optionQuotes(): Promise<Rec> { return {}; }
  /** 券商侧还挂着的托管单(没撤的都算):新引擎第一轮认领靠它 */
  async listHostedOpen(): Promise<Rec[]> {
    return this.placed.filter((p) => !this.cancelled.includes(p["order_id"] as number)).map((p) => ({
      order_ref: p["ref"], order_id: p["order_id"], perm_id: null, quantity: p["quantity"],
      lmt_price: p["lmt_price"], aux_price: p["aux_price"], trailing_percent: null,
    }));
  }
  async placeHosted(_account: Rec, _contract: Rec, item: Rec, oca: string, ref: string): Promise<Rec> {
    this.nextId += 1;
    this.placed.push({
      kind: item["kind"], oca, ref, order_id: this.nextId, quantity: item["quantity"],
      lmt_price: item["lmt_price"], aux_price: item["aux_price"],
    });
    return { order_id: this.nextId, perm_id: null, status: "PreSubmitted" };
  }
  async modifyHosted(): Promise<boolean> { return true; }
  async cancelHosted(orderId: number): Promise<boolean> { this.cancelled.push(orderId); return true; }
  async place(recordId: string): Promise<Rec> {
    return { record_id: recordId, order_id: 990, perm_id: null, status: "Submitted", limit_price: null, detail: {} };
  }
  async legQuotes(): Promise<unknown[]> { return []; }
  async cancelAllOpen(): Promise<number> { return 0; }
  async contractHours(): Promise<null> { return null; }
  cachedContractHours(): null { return null; }
}

const stock = (): Rec => ({
  key: tk.makeKey("模拟", "BE", "STK"), account: "模拟", symbol: "BE", sec_type: "STK", leg: "", quantity: 100,
  avg_cost: 100, multiplier: 1, currency: "USD", market_price: 120, market_value: 12000, unrealized_pnl: 2000,
  contract: { secType: "STK", symbol: "BE", exchange: "SMART", currency: "USD" },
});

const servers: RpcServer[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) {
    s.anomaly.stop();
    s.engineBuilt?.stopTrackerLoop();
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** 连上券商之后的样子:brokerLink.connectNow 做的就是 dropEngine → engine.attachListeners()。 */
function connected(): { s: RpcServer; router: FakeRouter; session: FakeSession } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-rewire-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    ...base, policies: { ...base.policies, auto_execute: true }, storage: { db_path: path.join(dir, "t.db") },
  }));
  const s = new RpcServer(settingsPath, () => undefined);
  servers.push(s);
  const router = new FakeRouter([stock()]);
  s.router = router as never;
  s.dropEngine();
  s.engine.stopTrackerLoop(); // 节拍由测试自己一轮一轮地推,免得和计时器抢
  expect(s.engine.attachListeners()).toBe(1);
  return { s, router, session: router.live[0]! };
}

async function patchSettings(s: RpcServer): Promise<void> {
  const out = await s.handle({ jsonrpc: "2.0", id: 1, method: "settings.patch", params: { patch: { limits: { max_order_notional: 60000 } } } });
  expect(out["error"]).toBeUndefined();
  s.engineBuilt?.stopTrackerLoop();
}

function addHostedTrack(s: RpcServer): string {
  const track = s.engine.store.addTrack({
    account: "模拟", symbol: "BE", sec_type: "STK", contract: { secType: "STK", symbol: "BE", exchange: "SMART", currency: "USD" },
    targets: { take_profit: 150, stop_loss: 90 }, auto_close: { enabled: true, host_at_broker: true }, peak: 120,
  });
  return String(track["id"]);
}

/** 一轮托管对账,和节拍器一样排在追踪锁里(节拍器若刚好在跑,等它跑完) */
async function sync(s: RpcServer): Promise<Rec> {
  return s.trackerLock(async () => s.engine.syncHosted()) as Promise<Rec>;
}

describe("改过设置之后,回报落到新引擎上", () => {
  it("托管止盈成交 → 新引擎落闩;托管止损被拒 → 新引擎摘掉、不再显示已托管", async () => {
    const { s, router, session } = connected();
    const before = s.engine;
    await patchSettings(s);
    const after = s.engine;
    expect(after).not.toBe(before);

    const tid = addHostedTrack(s);
    await sync(s);
    const tp = router.placed.find((p) => p["kind"] === "tp")!["order_id"] as number;
    const sl = router.placed.find((p) => p["kind"] === "sl")!["order_id"] as number;

    session.emitStatus(tp, "Submitted", 0, 100);
    session.emitError(sl, 201, "Order rejected - reason: insufficient margin");
    const tick = await sync(s);
    expect(tick["blocked"].map((b: Rec) => b["blockers"].join("")).join("")).toContain("托管单被券商拒绝");
    expect((tick["hosted"][0]["orders"] as Rec[]).map((o) => o["kind"])).toEqual(["tp"]);

    session.emitStatus(tp, "Filled", 100, 0);
    const track = s.engine.store.getTrack(tid)!;
    expect(track["fired_state"]).toBe("take_profit");
    expect(Boolean(track["enabled"])).toBe(false);
  });

  it("不重复挂监听:改设置、再 attachListeners,会话上还是一套回调", async () => {
    const { s, session } = connected();
    await patchSettings(s);
    await patchSettings(s);
    s.engine.attachListeners();
    expect(session.status).toHaveLength(1);
    expect(session.error).toHaveLength(1);
    expect(session.fill).toHaveLength(1);
    expect(session.commission).toHaveLength(1);
  });

  it("改设置之后才连上的会话(sessionHook)同样落到当前引擎", async () => {
    const { s, router } = connected();
    await patchSettings(s);
    const late = router.connectAnother();
    expect(late.status).toHaveLength(1);
    const tid = addHostedTrack(s);
    await sync(s);
    const tp = router.placed.find((p) => p["kind"] === "tp")!["order_id"] as number;
    late.emitStatus(tp, "Filled", 100, 0);
    expect(s.engine.store.getTrack(tid)!["fired_state"]).toBe("take_profit");
  });

  it("旧引擎发出去的普通单:改设置之后它的成交照样记到那条记录上", async () => {
    const { s, session } = connected();
    const old = s.engine;
    const recordId = old.store.createRecord({ contract: { secType: "STK", symbol: "BE" }, order: { totalQuantity: 100 } });
    old.store.appendEvent(recordId, "status", { status: "Submitted", order_id: 990 });
    old.orderIndex.set(990, recordId); // = indexPlacement
    await patchSettings(s);
    session.emitStatus(990, "Filled", 100, 0);
    expect(s.engine.store.getRecord(recordId)!["final_status"]).toBe("filled");
  });

  it("旧引擎挂的托管单:新引擎第一轮认领之前就成交了,追踪照样落闩(不会再挂一张)", async () => {
    const { s, router, session } = connected();
    const tid = addHostedTrack(s);
    await sync(s); // 旧引擎挂出止盈 / 止损
    const tp = router.placed.find((p) => p["kind"] === "tp")!["order_id"] as number;
    await patchSettings(s);
    session.emitStatus(tp, "Filled", 100, 0); // 新引擎还没跑过一轮
    expect(s.engine.store.getTrack(tid)!["fired_state"]).toBe("take_profit");
  });

  it("改设置之后节拍器立刻接着跑,不等界面下一次来要引擎", async () => {
    const { s } = connected();
    const out = await s.handle({ jsonrpc: "2.0", id: 1, method: "settings.patch", params: { patch: { limits: { max_order_notional: 60000 } } } });
    expect(out["error"]).toBeUndefined();
    expect(s.engineBuilt).not.toBeNull();
    expect(s.engineBuilt!.trackerLoop["running"]).toBe(true);
  });
});
