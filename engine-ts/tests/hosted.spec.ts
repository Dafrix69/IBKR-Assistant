/** 券商托管的止盈/止损:engine.syncHosted 的对账循环(与 Python test_hosted.py 同构)。
 *
 * 托管单是真单——挂错、漏挂、重复挂、成交后不落闩,每一样都是真金白银的事故。
 * 盯的是:挂(orderRef/OCA)、改(峰值棘轮)、撤(闸门/持仓消失)、
 * 闩(成交落闩)、认领(重启不重挂)、分工(软件盯盘只算不发)。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TradingEngine } from "../src/engine.js";
import { Notifier } from "../src/notify.js";
import { BLOCK_AUTO_EXECUTE } from "../src/tracker.js";
import { TradeStore } from "../src/store.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");

type Rec = Record<string, any>;

class FakeHostedRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  rows: Rec[];
  placed: Rec[] = [];
  modified: Rec[] = [];
  cancelled: number[] = [];
  openRows: Rec[] = [];
  private nextId = 500;

  constructor(rows: Rec[] = []) {
    this.rows = rows;
  }

  async positions(): Promise<Rec[]> {
    return this.rows;
  }

  async placeHosted(account: Rec, _contract: Rec, item: Rec, oca: string, ref: string): Promise<Rec> {
    this.nextId += 1;
    this.placed.push({ item: { ...item }, oca, ref, account: account.alias, order_id: this.nextId });
    return { order_id: this.nextId, perm_id: null, status: "PreSubmitted" };
  }

  async modifyHosted(orderId: number, item: Rec): Promise<boolean> {
    this.modified.push({ order_id: orderId, item: { ...item } });
    return true;
  }

  async cancelHosted(orderId: number): Promise<boolean> {
    this.cancelled.push(orderId);
    return true;
  }

  async listHostedOpen(): Promise<Rec[]> {
    return [...this.openRows];
  }

  // RouterLike 其余面(本测试不会走到)
  async indexPrice(): Promise<number | null> { return null; }
  async legQuotes(): Promise<any[]> { return []; }
  async place(): Promise<any> { throw new Error("not used"); }
  async cancelAllOpen(): Promise<number> { return 0; }
  sessions(): unknown[] { return []; }
}

function positionRow(over: Rec = {}): Rec {
  const base: Rec = {
    account: "模拟", symbol: "NVDA", sec_type: "STK", quantity: 100.0,
    avg_cost: 180.0, multiplier: 1.0, currency: "USD",
    market_price: 220.0, market_value: 22000.0, unrealized_pnl: 4000.0,
    contract: { secType: "STK", symbol: "NVDA", exchange: "SMART", currency: "USD" },
    ...over,
  };
  base.key = `${base.account}|${base.symbol}|${base.sec_type}`;
  return base;
}

function hostedEngine(router: any, autoExecute = true): TradingEngine {
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-hosted-"));
  const settings = makeSettings(g.base_config, {
    policies: { auto_execute: autoExecute },
    storage: { db_path: path.join(dir, "hosted.db") },
  });
  return new TradingEngine({
    settings,
    parser: {} as any,
    store: new TradeStore(settings.db_path),
    notifier: new Notifier(false),
    router,
  });
}

function addHostedTrack(engine: TradingEngine, over: Rec = {}): Rec {
  return engine.store.addTrack({
    account: "模拟", symbol: "NVDA", sec_type: "STK",
    contract: { secType: "STK", symbol: "NVDA", exchange: "SMART", currency: "USD" },
    targets: { take_profit: 250.0, stop_loss: 160.0 },
    auto_close: { enabled: true, host_at_broker: true },
    peak: 220.0,
    ...over,
  });
}

function filledTrade(orderId: number): Rec {
  return {
    order: { orderId, permId: null },
    orderStatus: { status: "Filled", filled: 100, remaining: 0 },
    contract: { symbol: "NVDA" },
  };
}

// ----------------------------------------------------------------------
describe("hosted: 托管单被券商拒绝(2026-09-10 真机:10311 被拒却一直显示已托管)", () => {
  it("挂单被拒、券商那边没有这张单 → 摘掉缓存、退避期内不重挂、把原因报给界面", async () => {
    const router = new FakeHostedRouter([positionRow()]);
    const engine = hostedEngine(router);
    addHostedTrack(engine, { targets: { take_profit: 250.0 } });

    await engine.syncHosted();
    expect(router.placed).toHaveLength(1);
    const orderId = router.placed[0]!.order_id;

    engine.onIbError(orderId, 10311, "该委托单将直接传递至NYSE");
    router.openRows = []; // 券商侧:这张单根本没挂上
    const out = await engine.syncHosted();
    expect(out.hosted[0]?.orders ?? []).toEqual([]);            // 不再冒充"已托管"
    expect(router.placed).toHaveLength(1);                      // 退避期内不重挂
    expect(JSON.stringify(out.blocked)).toContain("10311");     // 原因交给界面
  });

  it("认领时同一追踪同一单型有两张(旧 bug 留下的重复)→ 留单号最新的,撤掉其余", async () => {
    const router = new FakeHostedRouter([positionRow()]);
    const engine = hostedEngine(router);
    const track = addHostedTrack(engine, { targets: { take_profit: 250.0 } });
    const ref = `trk:${track.id}:tp`;
    router.openRows = [
      { order_ref: ref, order_id: 82, quantity: 100, lmt_price: 250, aux_price: null, trailing_percent: null },
      { order_ref: ref, order_id: 86, quantity: 100, lmt_price: 250, aux_price: null, trailing_percent: null },
    ];
    const out = await engine.syncHosted();
    expect(router.cancelled).toEqual([82]);
    expect(router.placed).toEqual([]);                          // 不再挂第三张
    expect(out.hosted[0]!.orders.map((o: Rec) => o.order_id)).toEqual([86]);
  });

  it("改价被拒 → 原单还在原价:恢复缓存成上一版,退避期内不改也不重挂", async () => {
    const router = new FakeHostedRouter([positionRow()]);
    const engine = hostedEngine(router);
    const track = addHostedTrack(engine, { targets: { take_profit: 250.0 } });

    await engine.syncHosted();
    const first = router.placed[0]!;
    engine.store.updateTrack(track.id, { targets: { take_profit: 260.0 } });
    await engine.syncHosted();                                   // 触发一次改价
    expect(router.modified).toHaveLength(1);
    engine.onIbError(first.order_id, 110, "价格不符合最小价格变动");

    const out = await engine.syncHosted();
    expect(router.placed).toHaveLength(1);                       // 没有第二张
    expect(router.modified).toHaveLength(1);                     // 退避期内不再改
    expect(out.hosted[0]!.orders[0]!.lmt_price).toBe(250.0);     // 缓存 = 券商那边真实的价
    expect(JSON.stringify(out.blocked)).toContain("改价被券商拒绝");
  });
});

// ----------------------------------------------------------------------
describe("hosted: syncHosted 对账循环", () => {
  it("挂出的每一张托管单都带 orderRef 与 OCA 组,并各留一条记录", async () => {
    const router = new FakeHostedRouter([positionRow()]);
    const engine = hostedEngine(router);
    const track = addHostedTrack(engine);

    const out = await engine.syncHosted();
    expect(router.placed.map((p) => p.item.kind)).toEqual(["tp", "sl"]);
    expect(new Set(router.placed.map((p) => p.ref))).toEqual(
      new Set([`trk:${track.id}:tp`, `trk:${track.id}:sl`]),
    );
    expect(new Set(router.placed.map((p) => p.oca))).toEqual(
      new Set([`dafri-trk-${String(track.id).slice(0, 8)}`]),
    );
    expect(out.hosted).toHaveLength(1);
    expect(engine.store.listRecords(10)).toHaveLength(2);
  });

  it("峰值前进 → 利润回撤停损价棘轮上移(改单);回落不动", async () => {
    const row = positionRow();
    const router = new FakeHostedRouter([row]);
    const engine = hostedEngine(router);
    addHostedTrack(engine, { targets: { profit_drawdown_pct: 30.0 }, peak: 260.0 });

    await engine.syncHosted();
    expect(router.placed[0]!.item.kind).toBe("ptrail");
    expect(router.placed[0]!.item.aux_price).toBe(236.0); // 180 + 80×0.7

    row.market_price = 280.0;
    await engine.syncHosted();
    expect(router.placed).toHaveLength(1);
    expect(router.modified.at(-1)!.item.aux_price).toBe(250.0); // 180 + 100×0.7

    row.market_price = 270.0; // 回落:峰值只朝有利方向走
    await engine.syncHosted();
    expect(router.modified).toHaveLength(1);
  });

  it("重启后授权被关掉:认领旧单 → 闸门落下 → 撤回", async () => {
    const router = new FakeHostedRouter([positionRow()]);
    const engine = hostedEngine(router);
    addHostedTrack(engine);
    await engine.syncHosted();
    expect(router.placed).toHaveLength(2);

    router.openRows = router.placed.map((p) => ({
      order_ref: p.ref, order_id: p.order_id, account: "DU7654321",
      action: p.item.action, order_type: p.item.order_type,
      quantity: p.item.quantity, lmt_price: p.item.lmt_price,
      aux_price: p.item.aux_price, trailing_percent: p.item.trailing_percent,
      status: "PreSubmitted",
    }));
    // 同一个库,auto_execute=false 的新引擎(相当于重启后授权被撤)
    const settings2 = makeSettings(g.base_config, {
      policies: { auto_execute: false },
      storage: { db_path: engine.settings.db_path },
    });
    const engine2 = new TradingEngine({
      settings: settings2, parser: {} as any,
      store: new TradeStore(settings2.db_path),
      notifier: new Notifier(false), router: router as any,
    });
    const out = await engine2.syncHosted();
    expect([...router.cancelled].sort()).toEqual(router.placed.map((p) => p.order_id).sort());
    expect(out.blocked.length).toBeGreaterThan(0);
    // 对着常量比,不对着文案比:这句话是给用户看的,改了措辞不该让这条断言失效
    expect(String(out.blocked[0]!.blockers[0])).toBe(BLOCK_AUTO_EXECUTE);
  });

  it("托管单成交 → 追踪落闩,缓存清空", async () => {
    const router = new FakeHostedRouter([positionRow()]);
    const engine = hostedEngine(router);
    const track = addHostedTrack(engine);
    await engine.syncHosted();
    const tpOrderId = router.placed[0]!.order_id;

    engine.onOrderStatus(filledTrade(tpOrderId));
    const after = engine.store.getTrack(String(track.id))!;
    expect(after.enabled).toBeFalsy();
    expect(after.fired_state).toBe("take_profit");
    const out = await engine.syncHosted();
    expect(out.hosted).toEqual([]);
    expect(router.placed).toHaveLength(2);
  });

  it("重启认领:价格没变就既不重挂也不改", async () => {
    const router = new FakeHostedRouter([positionRow()]);
    const engine = hostedEngine(router);
    const track = addHostedTrack(engine);
    router.openRows = [
      { order_ref: `trk:${track.id}:tp`, order_id: 901, account: "DU7654321",
        action: "SELL", order_type: "LMT", quantity: 100.0,
        lmt_price: 250.0, aux_price: null, trailing_percent: null, status: "PreSubmitted" },
      { order_ref: `trk:${track.id}:sl`, order_id: 902, account: "DU7654321",
        action: "SELL", order_type: "STP", quantity: 100.0,
        lmt_price: null, aux_price: 160.0, trailing_percent: null, status: "PreSubmitted" },
    ];

    const out = await engine.syncHosted();
    expect(router.placed).toEqual([]);
    expect(router.modified).toEqual([]);
    expect(new Set(out.hosted[0]!.orders.map((o) => o.order_id))).toEqual(new Set([901, 902]));
  });

  it("持仓消失 → 撤掉全部托管单", async () => {
    const router = new FakeHostedRouter([positionRow()]);
    const engine = hostedEngine(router);
    addHostedTrack(engine);
    await engine.syncHosted();
    router.rows = [];
    await engine.syncHosted();
    expect([...router.cancelled].sort()).toEqual(router.placed.map((p) => p.order_id).sort());
  });

  it("托管开启时,软件盯盘那条路只算不发", async () => {
    // 现价已越过止盈价:软件若发单就是和托管单各平一次
    const router = new FakeHostedRouter([positionRow({ market_price: 260.0 })]);
    const engine = hostedEngine(router);
    addHostedTrack(engine);

    const out = await engine.pollTrackers();
    expect(out.fired).toEqual([]);
    expect(out.rows[0]!.hosted).toBe(true);
    expect(out.rows[0]!.state).toBe("take_profit"); // 算还是要算,给界面看
  });

  it("router 不支持托管 → 整体空转", async () => {
    const engine = hostedEngine({ SUPPORTS_HOSTED_CLOSE: false });
    addHostedTrack(engine);
    expect(await engine.syncHosted()).toEqual({
      hosted: [], blocked: [], quote_maybe_delayed: false,
    });
  });
});
