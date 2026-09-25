/** 会话说真话之后,引擎侧"读不到 ≠ 没有"的另外两处:托管单认领与执行对账。
 *
 * 追踪在账户读不到时不再被停掉(tracker-allday.spec)——这就把一条以前走不到的路露了出来:
 * 引擎重建那一刻某个账户的会话没连着,它在券商那边挂着的托管单认领不到;等会话连上,对账会当成
 * "没挂"再挂一张。两张平仓单各成交一次就是反向开仓。
 * 执行对账同理:断线时券商侧的未成交单一张都没读到,不能据此给在途单下"去向不明"的结论。
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

/** 券商那头:两个账户各自的持仓与挂着的单;哪个账户此刻读得到由测试拨 */
class TwoAccountRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  covered = new Set<string>(["主账户"]);
  held: Rec[] = [];
  /** 券商侧真实挂着的托管单(带 account 别名);listHostedOpen 只看得见读得到的账户那部分 */
  brokerOrders: Array<Rec & { account: string }> = [];
  placed: Rec[] = [];
  private nextId = 700;

  coveredAccounts(): Set<string> { return new Set(this.covered); }
  coveredAccountIds(): Set<string> {
    const ids: Record<string, string> = { 模拟: "DU7654321", 主账户: "U1234567" };
    return new Set([...this.covered].map((a) => ids[a]!));
  }
  async positions(): Promise<Rec[]> { return this.held.filter((r) => this.covered.has(r["account"])); }
  async listHostedOpen(): Promise<Rec[]> {
    return this.brokerOrders.filter((o) => this.covered.has(o.account)).map(({ account: _a, ...o }) => o);
  }
  async listOpenOrdersDetailed(): Promise<Rec[]> { return this.listHostedOpen(); }
  async placeHosted(account: Rec, _c: Rec, item: Rec, oca: string, ref: string): Promise<Rec> {
    this.nextId += 1;
    this.placed.push({ account: account.alias, kind: item["kind"], ref, oca, order_id: this.nextId });
    return { order_id: this.nextId, perm_id: null, status: "PreSubmitted" };
  }
  async modifyHosted(): Promise<boolean> { return true; }
  async cancelHosted(): Promise<boolean> { return true; }
  async indexPrice(): Promise<number | null> { return null; }
  async legQuotes(): Promise<any[]> { return []; }
  async place(): Promise<any> { throw new Error("not used"); }
  async cancelAllOpen(): Promise<number> { return 0; }
  sessions(): unknown[] { return [{}]; }
}

function build(router: TwoAccountRouter) {
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-linkeng-"));
  const settings = makeSettings(g.base_config, {
    policies: { auto_execute: true }, storage: { db_path: path.join(dir, "linkeng.db") },
  });
  const notes: string[] = [];
  const engine = new TradingEngine({
    settings, parser: {} as any, store: new TradeStore(settings.db_path),
    notifier: new Notifier(false, [(title, _s, body) => notes.push(`${title}|${body}`)]), router: router as any,
  });
  return { engine, notes };
}

const NVDA = { secType: "STK", symbol: "NVDA", exchange: "SMART", currency: "USD" };

describe("托管单认领:后连上的账户,券商侧已挂着的单要认回来,不许再挂一张", () => {
  it("引擎起来时模拟盘会话没连着 → 连上后先重新认领,不重挂", async () => {
    const router = new TwoAccountRouter();
    const { engine } = build(router);
    const track = engine.store.addTrack({
      account: "模拟", symbol: "NVDA", sec_type: "STK", contract: NVDA,
      targets: { take_profit: 250.0, stop_loss: 160.0 },
      auto_close: { enabled: true, host_at_broker: true }, peak: 220.0,
    });
    const tid = String(track["id"]);
    // 上一次运行时挂上去的那两张(OCA 一组),一直在券商服务器上
    router.brokerOrders = [
      { account: "模拟", order_ref: `trk:${tid}:tp`, order_id: 311, quantity: 100, lmt_price: 250.0, aux_price: null, trailing_percent: null },
      { account: "模拟", order_ref: `trk:${tid}:sl`, order_id: 312, quantity: 100, lmt_price: null, aux_price: 160.0, trailing_percent: null },
    ];
    router.held = [{
      key: "模拟|NVDA|STK", account: "模拟", symbol: "NVDA", sec_type: "STK", leg: "", quantity: 100,
      avg_cost: 180, multiplier: 1, currency: "USD", market_price: 220, market_value: null, unrealized_pnl: null,
      contract: NVDA,
    }];

    await engine.syncHosted(await router.positions()); // 模拟盘读不到:认领落空,这条追踪先不动
    expect(router.placed).toEqual([]);

    router.covered.add("模拟"); // 模拟盘的 TWS 连上了
    await engine.syncHosted(await router.positions());
    expect(router.placed, "券商侧已经挂着 #311 / #312,不许再挂").toEqual([]);
    const rows = (await engine.syncHosted(await router.positions()))["hosted"];
    expect(rows[0]!["orders"].map((o: Rec) => o["order_id"]).sort()).toEqual([311, 312]);
  });
});

describe("执行对账:读不到的账户,不下「去向不明」的结论", () => {
  const NOW = Date.parse("2026-09-18T10:30:00-04:00");
  const OLD = new Date(NOW - 10 * 60_000).toISOString();

  it("断线时券商侧一张单都没读到:模拟账户的在途单不标 NotAtBroker、不弹提醒;连上后再对", async () => {
    const router = new TwoAccountRouter();
    router.covered = new Set();
    const { engine, notes } = build(router);
    const recordId = engine.store.createRecord({
      created_at: OLD, account: { alias: "模拟", account_id: "DU7654321", is_paper: true },
      contract: { secType: "STK", symbol: "AAPL" }, order: { totalQuantity: 100 },
    });
    engine.store.appendEvent(recordId, "status", { status: "Submitted" });
    const statuses = () => (engine.store.getRecord(recordId)!["ibkr"]["status_timeline"] as Rec[]).map((s) => s["status"]);

    await engine.reconcileOrders(NOW);
    expect(statuses()).toEqual(["Submitted"]);
    expect(notes.filter((n) => n.includes("去向不明"))).toEqual([]);

    // 连上了,券商侧确实没有这张单、也没成交:这时才是真的去向不明
    router.covered = new Set(["模拟"]);
    await engine.reconcileOrders(NOW + 61_000);
    expect(statuses()).toEqual(["Submitted", "NotAtBroker"]);
  });
});
