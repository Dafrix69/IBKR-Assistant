/** 组合(蝴蝶)的到价自动平仓:从轮询到真的发出那张 BAG 单(与 Python test_combo_close.py 同构)。
 *
 * 纯函数层(腿反转、限价、闸门、分档)由黄金对拍逐字段锁住;这里盯的是**集成**——
 * 串起来跑一遍 pollTrackers,因为串起来才会暴露只有真机才碰得到的那类问题。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { etNowFromEpoch } from "../src/config.js";
import { TradingEngine } from "../src/engine.js";
import * as fx from "../src/flyexit.js";
import { Notifier } from "../src/notify.js";
import { TradeStore } from "../src/store.js";
import * as tk from "../src/tracker.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");
type Rec = Record<string, any>;

const EXPIRY = "20260901";
const STRIKES = [7600.0, 7615.0, 7630.0];
/** 每条腿的成本(含乘数)。净成本 = 300 − 2×200 + 325 = 225,即 D = 2.25。 */
const LEG_COSTS = [300.0, 200.0, 325.0];
/** 盘中的一刻;不给的话 pollTrackers 用真实当下,半夜跑测试全被"休市"拦掉。 */
const NOON = etNowFromEpoch(Date.parse("2026-08-14T10:32:00-04:00"));
const LATE = etNowFromEpoch(Date.parse("2026-08-14T15:30:00-04:00"));
/** 美东 01:10:正股表判休市,SPX 期权却在隔夜段里 */
const OVERNIGHT = etNowFromEpoch(Date.parse("2026-09-04T01:10:00-04:00"));
const SPXW_HOURS = "20260903:1915-20260904:0825;20260904:0830-20260904:1500;20260905:CLOSED";
const SPXW_LIQUID = "20260904:0830-20260904:1500;20260905:CLOSED";

function legRow(strike: number, qty: number, cost: number, price: number | null, account = "模拟"): Rec {
  const contract = {
    secType: "OPT", symbol: "SPX", lastTradeDateOrContractMonth: EXPIRY,
    strike, right: "P", multiplier: "100",
  };
  const ident = tk.legOf(contract);
  return {
    key: tk.makeKey(account, "SPX", "OPT", ident), account, symbol: "SPX", sec_type: "OPT",
    leg: ident, label: tk.positionLabel("SPX", "OPT", contract), quantity: qty,
    avg_cost: cost, multiplier: 100.0, currency: "USD", market_price: price,
    market_value: null, unrealized_pnl: null, contract,
  };
}

function butterflyLegs(prices: Array<number | null> = [1.20, 0.90, 0.70], account = "模拟"): Rec[] {
  return [
    legRow(STRIKES[0]!, 1.0, LEG_COSTS[0]!, prices[0]!, account),
    legRow(STRIKES[1]!, -2.0, LEG_COSTS[1]!, prices[1]!, account),
    legRow(STRIKES[2]!, 1.0, LEG_COSTS[2]!, prices[2]!, account),
  ];
}

class FakeRouter {
  SUPPORTS_HOSTED_CLOSE = false;
  SUPPORTS_NATIVE_CONDITIONS = false;
  BROKER = "ibkr";
  placed: Rec[] = [];
  hoursCalls = 0;

  constructor(public rows: Rec[], private hours: [string, string, string] | null = null) {}

  async positions(): Promise<Rec[]> { return [...this.rows]; }
  async indexPrice(): Promise<number | null> { return null; }
  async legQuotes(): Promise<any[]> { return []; }
  async cancelAllOpen(): Promise<number> { return 0; }
  sessions(): unknown[] { return []; }

  async contractHours(): Promise<[string, string, string] | null> {
    this.hoursCalls += 1;
    return this.hours;
  }

  /** 同步读缓存(真 router 由轮询/预热填);校验链路不是 async,只能读这个。 */
  cachedContractHours(): [string, string, string] | null {
    return this.hours;
  }

  async place(recordId: string, approved: Rec): Promise<Rec> {
    this.placed.push(approved);
    return { record_id: recordId, order_id: 900 + this.placed.length, perm_id: null,
             status: "Submitted", limit_price: null, detail: {} };
  }
}

function buildEngine(rows: Rec[], policies: Rec = {}, hours: [string, string, string] | null = null) {
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-combo-"));
  const settings = makeSettings(g.base_config, {
    policies: { auto_execute: true, ...policies },
    storage: { db_path: path.join(dir, "combo.db") },
  });
  const router = new FakeRouter(rows, hours);
  const engine = new TradingEngine({
    settings, parser: {} as any, store: new TradeStore(settings.db_path),
    notifier: new Notifier(false), router: router as any,
  });
  return { engine, router, settings };
}

function addComboTrack(engine: TradingEngine, rows: Rec[], targets: Rec, account = "模拟"): Rec {
  const fly = tk.withCombos(rows).find((r) => r["sec_type"] === "BAG")!;
  return engine.store.addTrack({
    account, symbol: "SPX", sec_type: "BAG", leg: fly["leg"],
    contract: fly["contract"], targets,
    auto_close: { enabled: true, order_type: "MKT", slippage_pct: 5.0 },
    peak: null,
  });
}

describe("组合平仓:从轮询到发单", () => {
  it("止盈到价 → 发出腿方向全部反转的 BAG 限价单", async () => {
    const rows = butterflyLegs([1.20, 0.90, 0.70]);          // 净价 0.10
    const { engine, router } = buildEngine(rows);
    addComboTrack(engine, rows, { take_profit: 0.05 });

    const out = await engine.pollTrackers(NOON);
    expect(out["fired"], JSON.stringify(out)).toHaveLength(1);
    expect(out["blocked"]).toEqual([]);

    const order = router.placed[0]!["order"];
    expect(order.contract.secType).toBe("BAG");
    expect(order.contract.combo_strategy).toBe("BUTTERFLY");
    expect(order.contract.legs.map((l: Rec) => [l.action, l.ratio, l.strike])).toEqual([
      ["SELL", 1, 7600.0], ["BUY", 2, 7615.0], ["SELL", 1, 7630.0],
    ]);
    expect(order.order.action).toBe("SELL");
    expect(order.order.orderType).toBe("LMT");    // 组合绝不发市价单
    expect(order.order.totalQuantity).toBe(1);
  });

  it("分档回撤驱动出场,理由里写的是当时那一档", async () => {
    const rows = butterflyLegs([3.00, 0.30, 3.50]);          // 净价 5.90
    const { engine, router } = buildEngine(rows);
    const track = addComboTrack(engine, rows, {
      profit_drawdown_tiers: fx.drawdownTiers(null),
      profit_drawdown_late: fx.drawdownLate(null),
    });
    engine.store.updateTrack(track["id"], { peak: 8.0 });

    const out = await engine.pollTrackers(NOON);
    expect(out["fired"], JSON.stringify(out)).toHaveLength(1);
    expect(out["fired"][0].state).toBe(tk.STATE_PROFIT_TRAIL);
    expect(out["fired"][0].reason).toContain("阈值 30%");
    expect(router.placed).toHaveLength(1);
  });

  it("尾盘档位减半:同一价位盘中不动、15:00 之后就该走", async () => {
    const rows = butterflyLegs([3.00, 0.25, 4.50]);          // 净价 7.00
    const targets = {
      profit_drawdown_tiers: fx.drawdownTiers(null),
      profit_drawdown_late: fx.drawdownLate(null),
    };
    const a = buildEngine(rows);
    const t1 = addComboTrack(a.engine, rows, targets);
    a.engine.store.updateTrack(t1["id"], { peak: 8.0 });
    expect((await a.engine.pollTrackers(NOON))["fired"]).toEqual([]);   // 7.00 > 6.275

    const b = buildEngine(rows);
    const t2 = addComboTrack(b.engine, rows, targets);
    b.engine.store.updateTrack(t2["id"], { peak: 8.0 });
    const out = await b.engine.pollTrackers(LATE);                     // 7.00 < 7.1375
    expect(out["fired"], JSON.stringify(out)).toHaveLength(1);
    expect(out["fired"][0].reason).toContain("阈值 15%");
  });

  it("实盘账户没开 allow_combo_live 就发不出去", async () => {
    const rows = butterflyLegs([1.20, 0.90, 0.70], "主账户");
    const a = buildEngine(rows, { allow_live_trading: true });
    addComboTrack(a.engine, rows, { take_profit: 0.05 }, "主账户");
    const out = await a.engine.pollTrackers(NOON);
    expect(out["fired"]).toEqual([]);
    expect(a.router.placed).toEqual([]);
    expect(out["blocked"][0].blockers).toContain(tk.BLOCK_COMBO_LIVE);

    const b = buildEngine(rows, { allow_live_trading: true, allow_combo_live: true });
    addComboTrack(b.engine, rows, { take_profit: 0.05 }, "主账户");
    expect((await b.engine.pollTrackers(NOON))["fired"]).toHaveLength(1);
  });

  it("发过一次就落闩", async () => {
    const rows = butterflyLegs([1.20, 0.90, 0.70]);
    const { engine, router } = buildEngine(rows);
    addComboTrack(engine, rows, { take_profit: 0.05 });
    expect((await engine.pollTrackers(NOON))["fired"]).toHaveLength(1);
    expect((await engine.pollTrackers(NOON))["fired"]).toEqual([]);
    expect(router.placed).toHaveLength(1);
  });

  it("任何一条腿没报价就不判断、更不发单", async () => {
    const rows = butterflyLegs([1.20, null, 0.70]);
    const { engine, router } = buildEngine(rows);
    addComboTrack(engine, rows, { take_profit: 0.05 });
    const out = await engine.pollTrackers(NOON);
    expect(out["fired"]).toEqual([]);
    expect(router.placed).toEqual([]);
    expect(out["rows"][0].state).toBe(tk.STATE_HOLDING);
  });

  it("隔夜:正股表说休市,但 SPX 期权在隔夜段里,照样能平", async () => {
    const rows = butterflyLegs([1.20, 0.90, 0.70]);
    const { engine, router, settings } = buildEngine(
      rows, {}, [SPXW_HOURS, SPXW_LIQUID, "US/Central"]);
    expect(settings.marketStatus(OVERNIGHT)).toBe("休市");   // 先确认正股表确实这么说
    addComboTrack(engine, rows, { take_profit: 0.05 });

    const out = await engine.pollTrackers(OVERNIGHT);
    expect(out["fired"], JSON.stringify(out)).toHaveLength(1);
    expect(router.hoursCalls).toBeGreaterThanOrEqual(1);
    expect(router.placed[0]!["order"].order.outsideRth).toBe(true);
  });

  it("合约说 CLOSED 就是不能交易", async () => {
    const rows = butterflyLegs([1.20, 0.90, 0.70]);
    const { engine, router } = buildEngine(
      rows, {}, ["20260905:CLOSED;20260906:CLOSED", "", "US/Central"]);
    addComboTrack(engine, rows, { take_profit: 0.05 });
    const out = await engine.pollTrackers(OVERNIGHT);
    expect(out["fired"]).toEqual([]);
    expect(router.placed).toEqual([]);
    expect(out["blocked"][0].blockers[0]).toContain("当前时段不能交易");
  });

  it("查不到时段就退回正股表", async () => {
    const rows = butterflyLegs([1.20, 0.90, 0.70]);
    const { engine } = buildEngine(rows, {}, null);
    addComboTrack(engine, rows, { take_profit: 0.05 });
    expect((await engine.pollTrackers(OVERNIGHT))["fired"]).toEqual([]);   // 正股表:休市
    expect((await engine.pollTrackers(NOON))["fired"]).toHaveLength(1);    // 正股表:盘中
  });
});

// ---------------------------------------------------------------- 成交闭环
/** IBKR 对一张成交的 BAG 单会回:1 条 BAG 订单状态 + 每条腿一条成交。 */
function bagFillReports(orderId: number, permId = 7788) {
  const trade = {
    order: { permId, orderId },
    orderStatus: { status: "Filled", filled: 1, remaining: 0 },
    contract: { symbol: "SPX" },
  };
  const legs: Array<[string, string, number, number]> = [
    ["e-1", "SLD", 1.0, 1.20], ["e-2", "BOT", 2.0, 0.90], ["e-3", "SLD", 1.0, 0.70],
  ];
  const fills = legs.map(([execId, side, shares, price]) => ({
    execution: { execId, time: "2026-08-14T10:33:00", price, shares, side,
                 acctNumber: "DU7654321" },
  }));
  return { trade, fills };
}

describe("组合平仓:成交之后的收尾", () => {
  it("记录落终态、三条腿成交都入库、持仓没了就停止追踪", async () => {
    const rows = butterflyLegs([1.20, 0.90, 0.70]);
    const { engine, router } = buildEngine(rows);
    const track = addComboTrack(engine, rows, { take_profit: 0.05 });

    const fired = (await engine.pollTrackers(NOON))["fired"];
    expect(fired).toHaveLength(1);
    const recordId = fired[0].record_id;
    const orderId = fired[0].order_id;

    // 追踪已落闩:即使还没收到回报,也绝不会再发第二枪
    const afterFire = engine.store.getTrack(track["id"])!;
    expect(afterFire["fired_at"]).toBeTruthy();
    expect(afterFire["enabled"]).toBe(false);
    expect(afterFire["fired_state"]).toBe(tk.STATE_TAKE_PROFIT);

    const { trade, fills } = bagFillReports(orderId);
    (engine as any).indexPlacement(recordId, {
      record_id: recordId, order_id: orderId, perm_id: 7788, status: "Submitted",
      limit_price: null, detail: {},
    });
    for (const fill of fills) engine.onExecDetails(trade, fill);
    engine.onOrderStatus(trade);

    const record = engine.store.getRecord(recordId)!;
    expect(record["final_status"]).toBe("filled");
    expect(record["ibkr"].fills).toHaveLength(3);        // 三条腿各一条
    expect(new Set(record["ibkr"].fills.map((f: Rec) => f.exec_id)))
      .toEqual(new Set(["e-1", "e-2", "e-3"]));
    expect(record["contract"].secType).toBe("BAG");

    // 下一轮:腿都平掉了,持仓消失 → 追踪停止,且不会因为"找不到持仓"而发单
    router.rows = [];
    const out = await engine.pollTrackers(NOON);
    expect(out["fired"]).toEqual([]);
    expect(router.placed).toHaveLength(1);
    expect(out["rows"][0].state).toBe("closed");
    expect(engine.store.getTrack(track["id"])!["enabled"]).toBe(false);
  });

  it("部分成交不能记成 filled(腿不平衡是个谁也没打算持有的结构)", async () => {
    const rows = butterflyLegs([1.20, 0.90, 0.70]);
    const { engine } = buildEngine(rows);
    addComboTrack(engine, rows, { take_profit: 0.05 });
    const fired = (await engine.pollTrackers(NOON))["fired"][0];

    const trade = {
      order: { permId: 9001, orderId: fired.order_id },
      orderStatus: { status: "Filled", filled: 1, remaining: 1 },   // 还剩一组没成
      contract: { symbol: "SPX" },
    };
    (engine as any).indexPlacement(fired.record_id, {
      record_id: fired.record_id, order_id: fired.order_id, perm_id: 9001,
      status: "Submitted", limit_price: null, detail: {},
    });
    engine.onOrderStatus(trade);
    expect(engine.store.getRecord(fired.record_id)!["final_status"]).toBe("partially_filled");
  });
});

// ---------------------------------------------------------------- 自动盘外
function flyOrder(outsideRth = false, orderType = "LMT"): Rec {
  return {
    intent_summary: "买入 SPX 蝶",
    contract: {
      secType: "BAG", symbol: "SPX", exchange: "SMART", currency: "USD",
      combo_strategy: "BUTTERFLY", multiplier: "100",
      legs: [
        { action: "BUY", ratio: 1, lastTradeDateOrContractMonth: "20260904", strike: 7610, right: "P", multiplier: "100", tradingClass: "SPXW" },
        { action: "SELL", ratio: 2, lastTradeDateOrContractMonth: "20260904", strike: 7620, right: "P", multiplier: "100", tradingClass: "SPXW" },
        { action: "BUY", ratio: 1, lastTradeDateOrContractMonth: "20260904", strike: 7630, right: "P", multiplier: "100", tradingClass: "SPXW" },
      ],
    },
    execution_type: "IMMEDIATE", trigger: null, account: "模拟",
    order: {
      action: "BUY", orderType, totalQuantity: 1, price_mode: "EXPLICIT",
      lmtPrice: orderType === "LMT" ? 2.25 : null, tif: "DAY", outsideRth,
    },
    reason: "测试", confidence: 1.0, warnings: [],
  };
}

describe("盘外标志:该自动带上,不该逼人每次手写", () => {
  const HOURS: [string, string, string] = [SPXW_HOURS, SPXW_LIQUID, "US/Central"];

  it("合约能交易的盘外时段自动打上 outsideRth", () => {
    const { engine, settings } = buildEngine([], {}, HOURS);
    expect(settings.marketStatus(OVERNIGHT)).toBe("休市");        // 正股表这么说
    const out = (engine as any).autoOutsideRth([flyOrder(false)], OVERNIGHT);
    expect(out[0].order.outsideRth).toBe(true);
    expect(out[0].warnings.some((w: string) => w.includes("已自动打上盘外标志"))).toBe(true);

    // 显式写了的不动,也不重复加警告
    const explicit = (engine as any).autoOutsideRth([flyOrder(true)], OVERNIGHT);
    expect(explicit[0].order.outsideRth).toBe(true);
    expect(explicit[0].warnings.some((w: string) => w.includes("已自动打上盘外标志"))).toBe(false);

    // 市价单不自动打:盘外只收限价单,打上反而从"挂到开盘"变成"当场被拒"
    const mkt = (engine as any).autoOutsideRth([flyOrder(false, "MKT")], OVERNIGHT);
    expect(mkt[0].order.outsideRth).toBe(false);
  });

  it("可以关掉(盘外流动性薄,这个行为必须可控)", () => {
    const { engine } = buildEngine([], { auto_outside_rth: false }, HOURS);
    const out = (engine as any).autoOutsideRth([flyOrder(false)], OVERNIGHT);
    expect(out[0].order.outsideRth).toBe(false);
  });

  it("常规时段不乱打标志", () => {
    const { engine } = buildEngine([], {}, HOURS);
    const noon = etNowFromEpoch(Date.parse("2026-09-04T10:30:00-04:00"));
    const out = (engine as any).autoOutsideRth([flyOrder(false)], noon);
    expect(out[0].order.outsideRth).toBe(false);
  });
});
