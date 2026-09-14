/** 追价平仓:托管单挂着的同时,引擎照样盯止损类目标和"标的到了没有";一触发就把**那张托管单**
 * 改到立刻成交的价(各腿买卖价合成的自然价),没成交每轮再追,直到持仓没了。
 *
 * 2026-09-10 真机暴露的两件事:
 *  · 组合一开托管,利润回撤就被禁了——引擎整个让给券商那张止盈单,止损类目标没人盯;
 *  · 标的真到了目标价,托管单挂在中间价口径的模型价上,夜盘组合 3.10 / 4.25,那张单照样挂着。
 * 盯的是:触发了改的是同一张单(不多出第二张平仓单)、价是立刻能成交的、拿不到报价不乱改、
 * 成交后记真正的触发原因、没开托管时平仓单也挂在立刻成交价上。
 */
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { etNowFromEpoch } from "../src/config.js";
import { TradingEngine } from "../src/engine.js";
import * as fx from "../src/flyexit.js";
import { Notifier } from "../src/notify.js";
import { pyRound } from "../src/py.js";
import { RpcServer } from "../src/rpc.js";
import { TradeStore } from "../src/store.js";
import * as tk from "../src/tracker.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");
const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

const EXPIRY = "20260910";
const SIG = 20;
const NOON = etNowFromEpoch(Date.parse("2026-09-10T12:00:00-04:00"));

function legRow(strike: number, qty: number, spot: number, avgCost: number): Rec {
  const contract = {
    secType: "OPT", symbol: "SPX", lastTradeDateOrContractMonth: EXPIRY,
    strike, right: "C", multiplier: "100",
  };
  const ident = tk.legOf(contract);
  return {
    key: tk.makeKey("模拟", "SPX", "OPT", ident), account: "模拟", symbol: "SPX", sec_type: "OPT",
    leg: ident, quantity: qty, avg_cost: avgCost, multiplier: 100.0, currency: "USD",
    market_price: pyRound(fx.bachelierCall(spot, strike, SIG), 4),
    market_value: null, unrealized_pnl: null, contract,
  };
}

/** 以 4.50 买入的 7725/7750/7775 看涨蝶(每组成本 800 − 2×200 + 50 = 450),三条腿按标的 spot、σ=20 定价。 */
function flyAt(spot: number, lots = 1): Rec[] {
  return [legRow(7725, lots, spot, 800), legRow(7750, -2 * lots, spot, 200), legRow(7775, lots, spot, 50)];
}

/** 多头按跳动向下取整 */
function down(price: number, tick = 0.05): number {
  return pyRound(Math.floor(price / tick + 1e-9) * tick, 4);
}

/** 每条腿的买卖价 = 中间价 ∓ min(0.2, 中间价/2)。 */
function halfSpread(mid: number): number {
  return Math.min(0.2, mid / 2);
}

/** 平掉多头蝶立刻能成交的价:两翼按买价卖、中心按卖价买回。 */
function naturalOf(rows: Rec[]): number {
  const [a, b, c] = rows.map((r) => Number(r["market_price"]));
  return (a! - halfSpread(a!)) - 2 * (b! + halfSpread(b!)) + (c! - halfSpread(c!));
}

class SweepRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  placed: Rec[] = [];
  modified: Rec[] = [];
  cancelled: number[] = [];
  sent: Rec[] = [];
  quotesOn = true;
  private nextId = 800;

  constructor(public rows: Rec[], public spot: number | null) {}

  async positions(): Promise<Rec[]> { return [...this.rows]; }
  async indexPrice(): Promise<number | null> { return this.spot; }
  async optionQuotes(rows: Rec[]): Promise<Record<string, { bid: number | null; ask: number | null }>> {
    return Object.fromEntries(rows.map((r) => {
      const mid = r["market_price"];
      if (!this.quotesOn || mid === null || mid === undefined) return [r["key"], { bid: null, ask: null }];
      const s = halfSpread(Number(mid));
      return [r["key"], { bid: Number(mid) - s, ask: Number(mid) + s }];
    }));
  }
  async placeHosted(_account: Rec, contract: Rec, item: Rec, oca: string, ref: string): Promise<Rec> {
    this.nextId += 1;
    this.placed.push({ contract, item: { ...item }, oca, ref, order_id: this.nextId });
    return { order_id: this.nextId, perm_id: null, status: "PreSubmitted" };
  }
  async modifyHosted(orderId: number, item: Rec): Promise<boolean> {
    this.modified.push({ order_id: orderId, item: { ...item } });
    return true;
  }
  async cancelHosted(orderId: number): Promise<boolean> { this.cancelled.push(orderId); return true; }
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

function build(opts: { targets: Rec; host?: boolean; peak?: number | null; spot?: number; lots?: number }) {
  const spot = opts.spot ?? 7720;
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-sweep-"));
  const settings = makeSettings(g.base_config, {
    policies: { auto_execute: true },
    storage: { db_path: path.join(dir, "sweep.db") },
  });
  const router = new SweepRouter(flyAt(spot, opts.lots ?? 1), spot);
  const engine = new TradingEngine({
    settings, parser: {} as any, store: new TradeStore(settings.db_path),
    notifier: new Notifier(false), router: router as any,
  });
  const combo = tk.withCombos(router.rows).find((r) => r["sec_type"] === "BAG")!;
  const track = engine.store.addTrack({
    account: "模拟", symbol: "SPX", sec_type: "BAG", leg: combo["leg"], contract: combo["contract"],
    targets: opts.targets,
    auto_close: { enabled: true, order_type: "LMT", host_at_broker: opts.host ?? true, close_fraction_pct: 100 },
    peak: opts.peak ?? null,
  });
  return { engine, router, track, combo };
}

/** 一轮:先盯盘(判触发),再托管对账(挂 / 改单)——和引擎节拍器同一个顺序。 */
async function tick(engine: TradingEngine): Promise<Rec> {
  const poll = await engine.pollTrackers(NOON);
  await engine.syncHosted();
  return poll;
}

describe("前提:这只测试蝶是多头(借方)", () => {
  it("组合行:数量 +1、每组成本 4.50", () => {
    const combo = tk.withCombos(flyAt(7720)).find((r) => r["sec_type"] === "BAG")!;
    expect(combo["quantity"]).toBe(1);
    expect(combo["net_side"]).toBe("debit");
    expect(combo["avg_cost"]).toBe(450);
  });
});

describe("托管的组合:利润回撤由引擎盯,触发就把那张托管单改到立刻成交的价", () => {
  it("先挂着按目标价算的止盈单;利润回撤触发 → 同一张单改到自然价,不另发平仓单", async () => {
    // 峰值 4.60(还没回撤):第一轮只是按标的目标价挂止盈单
    const { engine, router, track } = build({ targets: { spot_target: 7740, profit_drawdown_pct: 40 }, peak: 4.6 });
    await tick(engine);
    expect(router.placed).toHaveLength(1);
    const orderId = router.placed[0]!.order_id;
    expect(router.placed[0]!.item.lmt_price).toBeGreaterThan(naturalOf(router.rows)); // 模型价在自然价之上

    // 峰值被推到 8.00 之后跌回来:利润回撤 40% 触发
    engine.store.updateTrack(track["id"], { peak: 8.0 });
    const poll = await tick(engine);
    expect((poll["fired"] as Rec[]).map((f) => f["state"])).toEqual(["sweep:profit_trail"]);
    expect(engine.store.getTrack(track["id"])!["fired_state"]).toBe("sweep:profit_trail");
    const natural = naturalOf(router.rows);
    const last = router.modified[router.modified.length - 1]!;
    expect(last.order_id).toBe(orderId);                                    // 改的是同一张
    expect(last.item.lmt_price).toBe(pyRound(Math.floor(natural / 0.05 + 1e-9) * 0.05, 4)); // 平多头向下取整
    expect(router.placed).toHaveLength(1);
    expect(router.sent).toEqual([]);                                         // 没有第二张平仓单
    expect(router.cancelled).toEqual([]);
  });

  it("一上来就已经触发:第一张就直接挂在立刻成交的价上", async () => {
    const { engine, router } = build({ targets: { spot_target: 7740, profit_drawdown_pct: 40 }, peak: 8.0 });
    const poll = await tick(engine);
    expect((poll["fired"] as Rec[]).map((f) => f["state"])).toEqual(["sweep:profit_trail"]);
    expect(router.placed).toHaveLength(1);
    const natural = naturalOf(router.rows);
    expect(router.placed[0]!.item.lmt_price).toBe(pyRound(Math.floor(natural / 0.05 + 1e-9) * 0.05, 4));
  });

  it("行情往下走,每轮按新的买卖价再追一次(还是同一张单)", async () => {
    const { engine, router } = build({ targets: { spot_target: 7740, profit_drawdown_pct: 40 }, peak: 8.0 });
    await tick(engine);
    const before = router.placed[0]!.item.lmt_price;
    router.rows = flyAt(7712);
    router.spot = 7712;
    await tick(engine);
    const after = router.modified[router.modified.length - 1]!;
    expect(after.item.lmt_price).toBeLessThan(before);
    expect(new Set(router.modified.map((m) => m.order_id)).size).toBe(1);
    expect(router.placed).toHaveLength(1);
  });

  it("拿不到腿的买卖价:这一轮不动那张单,更不改回模型价", async () => {
    const { engine, router } = build({ targets: { spot_target: 7740, profit_drawdown_pct: 40 }, peak: 8.0 });
    await tick(engine);
    await tick(engine);
    const count = router.modified.length;
    router.quotesOn = false;
    await tick(engine);
    await tick(engine);
    expect(router.modified).toHaveLength(count);
    expect(router.cancelled).toEqual([]);
  });

  it("追价单成交:追踪落闩,记的是利润回撤(不是笼统的托管止盈)", async () => {
    const { engine, router, track } = build({ targets: { spot_target: 7740, profit_drawdown_pct: 40 }, peak: 8.0 });
    await tick(engine);
    await tick(engine);
    engine.onOrderStatus({
      order: { orderId: router.placed[0]!.order_id, permId: null },
      orderStatus: { status: "Filled", filled: 1, remaining: 0 },
      contract: { symbol: "SPX" },
    });
    const after = engine.store.getTrack(track["id"])!;
    expect(after["fired_state"]).toBe("profit_trail");
    expect(Boolean(after["enabled"])).toBe(false);
  });

  it("没触发时照旧:止盈单挂在目标价算出的模型价上,不追", async () => {
    const { engine, router, track } = build({ targets: { spot_target: 7740, profit_drawdown_pct: 40 }, peak: 4.6 });
    await tick(engine);
    await tick(engine);
    expect(engine.store.getTrack(track["id"])!["fired_state"] || null).toBeNull();
    expect(router.placed).toHaveLength(1);
    expect(router.placed[0]!.item.lmt_price).toBeGreaterThan(naturalOf(router.rows)); // 模型价在自然价之上
  });
});

describe("托管的组合:标的真到了目标价,不等组合价追上来,直接追价平掉", () => {
  it("标的从 7720 走到 7741(目标 7740):改到立刻成交的价", async () => {
    const { engine, router, track } = build({ targets: { spot_target: 7740 } });
    await tick(engine);
    expect(router.placed).toHaveLength(1);
    const modelPrice = router.placed[0]!.item.lmt_price;

    router.rows = flyAt(7741);
    router.spot = 7741;
    const poll = await tick(engine);
    const row = (poll["rows"] as Rec[])[0]!;
    expect(row["spot_target"]["reached"]).toBe(true);
    expect(engine.store.getTrack(track["id"])!["fired_state"]).toBe("sweep:take_profit");

    await engine.syncHosted();
    const last = router.modified[router.modified.length - 1]!;
    expect(last.order_id).toBe(router.placed[0]!.order_id);
    const natural = naturalOf(router.rows);
    expect(last.item.lmt_price).toBe(pyRound(Math.floor(natural / 0.05 + 1e-9) * 0.05, 4));
    expect(last.item.lmt_price).not.toBe(modelPrice);
  });

  it("还没到(7730):不追,止盈单照旧每秒按模型价调", async () => {
    const { engine, router, track } = build({ targets: { spot_target: 7740 } });
    await tick(engine);
    router.rows = flyAt(7730);
    router.spot = 7730;
    const poll = await tick(engine);
    expect((poll["rows"] as Rec[])[0]!["spot_target"]["reached"]).toBe(false);
    expect(engine.store.getTrack(track["id"])!["fired_state"] || null).toBeNull();
  });
});

describe("没开托管:到价自动平仓的单子也挂在立刻成交价上", () => {
  it("标的到了目标价 → 发一张平仓 BAG 限价单,限价 = 自然价(让滑点、按跳动朝成交方向取整)", async () => {
    const { engine, router, track } = build({ targets: { spot_target: 7740 }, host: false });
    router.rows = flyAt(7741);
    router.spot = 7741;
    const poll = await engine.pollTrackers(NOON);
    expect((poll["fired"] as Rec[])).toHaveLength(1);
    expect(router.sent).toHaveLength(1);
    const lmt = router.sent[0]!.order.order.lmtPrice;
    const natural = naturalOf(router.rows);
    const position = tk.makePosition({
      account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: 450, multiplier: 100, market_price: 1,
    });
    expect(lmt).toBe(tk.closeLimitPrice(position, natural, 0.3));
    // 发出去只是开始:追踪落闩成 sweep:<原因>,之后每轮追那张单
    expect(engine.store.getTrack(track["id"])!["fired_state"]).toBe("sweep:take_profit");
  });

  it("发出去没成交:头两轮等在原价,之后每轮把同一张单再让一跳,成交后记回 take_profit", async () => {
    const { engine, router, track } = build({ targets: { spot_target: 7740 }, host: false });
    router.rows = flyAt(7741);
    router.spot = 7741;
    await engine.pollTrackers(NOON);                         // 发单(第 0 轮)
    expect(router.sent).toHaveLength(1);
    const placed = router.sent[0]!.order.order.lmtPrice as number;
    const natural = naturalOf(router.rows);
    await engine.pollTrackers(NOON);                         // 第 1 轮:自然价不比发单价更让,不改
    await engine.pollTrackers(NOON);                         // 第 2 轮
    expect(router.modified).toEqual([]);
    await engine.pollTrackers(NOON);                         // 第 3 轮:再让一跳
    expect(router.modified).toHaveLength(1);
    expect(router.modified[0]!.order_id).toBe(990);          // 改的是发出去的那张
    expect(router.modified[0]!.item.lmt_price).toBe(Math.min(placed, down(natural - 0.05)));
    expect(router.modified[0]!.item.quantity).toBe(1);
    await engine.pollTrackers(NOON);                         // 第 4 轮:再让一跳
    expect(router.modified).toHaveLength(2);
    expect(router.modified[1]!.item.lmt_price).toBeLessThan(router.modified[0]!.item.lmt_price);
    expect(router.sent).toHaveLength(1);                     // 始终没有第二张平仓单
    const poll = await engine.pollTrackers(NOON);
    const row = (poll["rows"] as Rec[])[0]!;
    expect(row["sweeping"]).toBe(true);
    expect(row["chase"]["rounds"]).toBeGreaterThanOrEqual(5);

    engine.onOrderStatus({ order: { orderId: 990, permId: null }, orderStatus: { status: "Filled", filled: 1, remaining: 0 }, contract: { symbol: "SPX" } });
    expect(engine.store.getTrack(track["id"])!["fired_state"]).toBe("take_profit");
    const count = router.modified.length;
    await engine.pollTrackers(NOON);
    expect(router.modified).toHaveLength(count);             // 成交后不再追
  });

  it("平仓单被撤 / 被拒:不再追,提醒持仓可能还在", async () => {
    const { engine, router, track } = build({ targets: { spot_target: 7740 }, host: false });
    router.rows = flyAt(7741);
    router.spot = 7741;
    await engine.pollTrackers(NOON);
    engine.onOrderStatus({ order: { orderId: 990, permId: null }, orderStatus: { status: "Cancelled", filled: 0, remaining: 1 }, contract: { symbol: "SPX" } });
    expect(engine.store.getTrack(track["id"])!["fired_state"]).toBe("take_profit");
    expect(engine.notifier.history.some(([, , body]) => body.includes("追价平仓单已撤销"))).toBe(true);
    for (let i = 0; i < 5; i += 1) await engine.pollTrackers(NOON);
    expect(router.modified).toEqual([]);
    expect(router.sent).toHaveLength(1);                     // 不重发:重复发单就是反向开仓的风险
  });

  it("正股不追(限价就是目标价本身)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dafri-sweep-"));
    const settings = makeSettings(g.base_config, { policies: { auto_execute: true }, storage: { db_path: path.join(dir, "s.db") } });
    const row = {
      key: tk.makeKey("模拟", "BE", "STK"), account: "模拟", symbol: "BE", sec_type: "STK", leg: "", quantity: 100,
      avg_cost: 100, multiplier: 1, currency: "USD", market_price: 120, market_value: 12000, unrealized_pnl: 2000,
      contract: { secType: "STK", symbol: "BE" },
    };
    const router = new SweepRouter([row], null);
    const engine = new TradingEngine({ settings, parser: {} as any, store: new TradeStore(settings.db_path), notifier: new Notifier(false), router: router as any });
    const track = engine.store.addTrack({
      account: "模拟", symbol: "BE", sec_type: "STK", contract: row.contract, targets: { take_profit: 110 },
      auto_close: { enabled: true, order_type: "LMT", close_fraction_pct: 100 },
    });
    await engine.pollTrackers(NOON);
    expect(router.sent).toHaveLength(1);
    expect(engine.store.getTrack(track["id"])!["fired_state"]).toBe("take_profit");
    await engine.pollTrackers(NOON);
    expect(router.modified).toEqual([]);
  });
});

describe("设置时:组合托管可以和止损、利润回撤一起设", () => {
  function server(router: SweepRouter): RpcServer {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-sweep-rpc-"));
    const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
    const s = new RpcServer(settingsPath, () => undefined);
    (s as any).router = router;
    return s;
  }

  function args(targets: Rec) {
    const router = new SweepRouter(flyAt(7720), 7720);
    const rows: Record<string, Rec> = Object.fromEntries(tk.withCombos(router.rows).map((r) => [r["key"], r]));
    const raw = Object.values(rows).find((r) => r["sec_type"] === "BAG")!;
    const position = tk.makePosition({
      account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: raw["quantity"], avg_cost: raw["avg_cost"],
      multiplier: 100, market_price: raw["market_price"],
    });
    const auto = tk.makeAutoClose({ enabled: true, host_at_broker: true, order_type: "LMT" });
    const s = server(router);
    return { call: () => (s as any).checkTargets(raw, rows, position, tk.makeTargets(targets), auto) };
  }

  it("标的目标价 + 利润回撤 + 止损 + 分档:放行", async () => {
    const { call } = args({
      spot_target: 7740, profit_drawdown_pct: 40, stop_loss: 2.0,
      profit_drawdown_tiers: [{ above: 0, pct: 40 }, { above: 1, pct: 30 }],
    });
    await expect(call()).resolves.toBeUndefined();
  });

  it("组合托管没填标的目标价:还是拒(托管的就是按它算的那张单)", async () => {
    const { call } = args({ profit_drawdown_pct: 40 });
    await expect(call()).rejects.toThrow(/要先填标的目标价/);
  });
});

describe("naturalClosePrice:立刻能成交的价", () => {
  const long = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: 450, multiplier: 100, market_price: 4 });
  const fly = tk.structureOf("BAG", {
    secType: "BAG", legs: [7725, 7750, 7775].map((strike, i) => ({ strike, right: "C", ratio: [1, -2, 1][i] })),
  })!;
  const book = { "7725C": { bid: 5.5, ask: 5.9 }, "7750C": { bid: 0.5, ask: 0.7 }, "7775C": { bid: 0.05, ask: 0.1 } };

  it("多头蝶:两翼按买价卖、中心按卖价买回", () => {
    expect(tk.naturalClosePrice(long, fly, book)).toBeCloseTo(5.5 - 2 * 0.7 + 0.05, 6);
  });

  it("贷方价差(空头):按「平仓要付多少」给正数", () => {
    const short = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: -1, avg_cost: 300, multiplier: 100, market_price: 2 });
    const vertical = tk.structureOf("BAG", { secType: "BAG", legs: [{ strike: 7750, right: "C", ratio: -1 }, { strike: 7775, right: "C", ratio: 1 }] })!;
    // 买回 7750C 付卖价 0.7,卖掉 7775C 收买价 0.05 → 要付 0.65
    expect(tk.naturalClosePrice(short, vertical, book)).toBeCloseTo(0.65, 6);
  });

  it("单腿:多头卖在买价,空头买回在卖价", () => {
    const leg = tk.structureOf("OPT", { secType: "OPT", strike: 7725, right: "C" })!;
    const mk = (q: number) => tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "OPT", quantity: q, avg_cost: 500, multiplier: 100, market_price: 5.7 });
    expect(tk.naturalClosePrice(mk(1), leg, book)).toBe(5.5);
    expect(tk.naturalClosePrice(mk(-1), leg, book)).toBe(5.9);
  });

  it("任何一条腿没有有效买卖价(缺、卖价非正、倒挂)→ null,不拿半边报价凑数", () => {
    expect(tk.naturalClosePrice(long, fly, { ...book, "7775C": { bid: null, ask: 0.1 } })).toBeNull();
    expect(tk.naturalClosePrice(long, fly, { ...book, "7750C": { bid: 0, ask: 0 } })).toBeNull();   // 要买回的中心没卖价
    expect(tk.naturalClosePrice(long, fly, { ...book, "7750C": { bid: 0.8, ask: 0.7 } })).toBeNull();
  });

  it("要卖掉的远翼买价为 0:按 0 卖(贡献 0),不算没报价——远翼归零的蝶照样追得了价", () => {
    expect(tk.naturalClosePrice(long, fly, { ...book, "7775C": { bid: 0, ask: 0.1 } })).toBeCloseTo(5.5 - 2 * 0.7, 6);
    // 单腿多头买价为 0 就是没人要,不算能成交
    const leg = tk.structureOf("OPT", { secType: "OPT", strike: 7775, right: "C" })!;
    const one = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "OPT", quantity: 1, avg_cost: 50, multiplier: 100, market_price: 0.05 });
    expect(tk.naturalClosePrice(one, leg, { ...book, "7775C": { bid: 0, ask: 0.1 } })).toBeNull();
    // 平掉反而要付钱(两翼 0、中心还要买回)→ null
    expect(tk.naturalClosePrice(long, fly, { ...book, "7725C": { bid: 0, ask: 0.1 }, "7775C": { bid: 0, ask: 0.1 } })).toBeNull();
  });
});

describe("chaseLimit:越等越让、只朝成交方向动、让到上限为止", () => {
  const long = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: 450, multiplier: 100, market_price: 4 });
  const short = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: -1, avg_cost: 300, multiplier: 100, market_price: 2 });
  const auto = tk.makeAutoClose({ chase_max_pct: 10 });

  it("头 2 轮挂在自然价(按跳动朝成交方向取整)", () => {
    expect(tk.chaseLimit(long, 3.62, null, 0, auto)).toBe(3.6);
    expect(tk.chaseLimit(long, 3.62, null, 2, auto)).toBe(3.6);
    expect(tk.chaseLimit(short, 0.63, null, 1, auto)).toBe(0.65);
  });

  it("第 3 轮起每轮再让一跳", () => {
    expect(tk.chaseLimit(long, 3.6, null, 3, auto)).toBe(3.55);
    expect(tk.chaseLimit(long, 3.6, null, 5, auto)).toBe(3.45);
    expect(tk.chaseLimit(short, 0.65, null, 4, auto)).toBe(0.75);
  });

  it("让到 chase_max_pct 为止(至少两跳);试算的 chaseFloor 就是这个价", () => {
    // 3.60 的 10% = 0.36 → 7 跳 = 0.35
    expect(tk.chaseMaxSteps(long, 3.6, auto)).toBe(7);
    expect(tk.chaseLimit(long, 3.6, null, 100, auto)).toBe(3.25);
    expect(tk.chaseFloor(long, 3.6, auto)).toBe(3.25);
    // 便宜的组合按百分比不到一跳,也至少让两跳
    expect(tk.chaseMaxSteps(long, 0.4, auto)).toBe(2);
    expect(tk.chaseFloor(long, 0.4, auto)).toBe(0.3);
    // 上限设 0 也一样至少两跳
    expect(tk.chaseFloor(long, 3.6, tk.makeAutoClose({ chase_max_pct: 0 }))).toBe(3.5);
  });

  it("只朝成交方向动:买价抬上去了,不把挂着的卖单改回去;掉下去了顺着追", () => {
    expect(tk.chaseLimit(long, 3.9, 3.55, 5, auto)).toBe(3.55);   // 自然价 3.90 让 3 跳 = 3.75 > 3.55,不动
    expect(tk.chaseLimit(long, 3.3, 3.55, 5, auto)).toBe(3.15);   // 3.30 让 3 跳
    expect(tk.chaseLimit(short, 0.6, 0.75, 5, auto)).toBe(0.75);
    expect(tk.chaseLimit(short, 0.9, 0.75, 5, auto)).toBe(1.0);    // 0.90 的 10% 不到一跳 → 上限两跳
  });

  it("单腿期权 3 元以上按 0.10 跳", () => {
    const one = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "OPT", quantity: 1, avg_cost: 1200, multiplier: 100, market_price: 12 });
    expect(tk.chaseLimit(one, 12.37, null, 0, auto)).toBe(12.3);
    expect(tk.chaseLimit(one, 12.37, null, 4, auto)).toBe(12.1);
  });

  it("永远不低于一跳", () => {
    expect(tk.chaseLimit(long, 0.05, null, 50, auto)).toBe(0.05);
  });
});

describe("reached:标的到了没有", () => {
  it("正股多头:现价 ≥ 目标价才算到", () => {
    const stk = tk.makePosition({ account: "模拟", symbol: "BE", sec_type: "STK", quantity: 3, avg_cost: 222, multiplier: 1, market_price: 264 });
    const s = tk.structureOf("STK", { secType: "STK" })!;
    expect(tk.spotTarget({ structure: s, position: stk, spotTarget: 281, spot: 264, markPrice: 264, minute: 600 }).reached).toBe(false);
    expect(tk.spotTarget({ structure: s, position: stk, spotTarget: 281, spot: 281.2, markPrice: 281.2, minute: 600 }).reached).toBe(true);
  });

  it("蝶:从下翼外往上走,到了目标价就算;越过中心只要还没到镜像点也算", () => {
    const fly = tk.structureOf("BAG", {
      secType: "BAG", legs: [7725, 7750, 7775].map((strike, i) => ({ strike, right: "C", ratio: [1, -2, 1][i] })),
    })!;
    const pos = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: 450, multiplier: 100, market_price: 4 });
    const at = (spot: number) => {
      const legPrices = Object.fromEntries([7725, 7750, 7775].map((k) => [`${k}C`, fx.bachelierCall(spot, k, SIG)]));
      const mark = legPrices["7725C"]! - 2 * legPrices["7750C"]! + legPrices["7775C"]!;
      return tk.spotTarget({ structure: fly, position: pos, spotTarget: 7740, spot, markPrice: mark, legPrices, minute: 600 });
    };
    expect(at(7720).reached).toBe(false);
    expect(at(7739).reached).toBe(false);
    expect(at(7740).reached).toBe(true);
    expect(at(7755).reached).toBe(true);   // 过了中心,离中心 5 点,比目标价(离中心 10 点)还值钱
    expect(at(7765).reached).toBe(false);  // 过了镜像点(7760),又不如目标价了
  });
});

describe("单腿期权的限价跳动:3 元以上 0.10", () => {
  const opt = (q: number) => tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "OPT", quantity: q, avg_cost: 1200, multiplier: 100, market_price: 12 });

  it("平仓限价:12.37 这种价对齐到 0.10(卖向下、买向上),3 元以下仍是 0.05", () => {
    expect(tk.closeLimitPrice(opt(1), 12.37, 0)).toBe(12.3);
    expect(tk.closeLimitPrice(opt(-1), 12.31, 0)).toBe(12.4);
    expect(tk.closeLimitPrice(opt(1), 2.37, 0)).toBe(2.35);
  });

  it("托管止盈限价同一条规矩;组合还是 0.05", () => {
    const auto = tk.makeAutoClose({ enabled: true, host_at_broker: true, order_type: "LMT" });
    const plan = tk.hostedPlan(opt(1), tk.makeTargets({ take_profit: 12.37 }), auto, null);
    expect(plan.find((p) => p.kind === tk.HOSTED_KIND_TP)!.lmt_price).toBe(12.3);
    const combo = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: 450, multiplier: 100, market_price: 4 });
    expect(tk.hostedPlan(combo, tk.makeTargets({ take_profit: 12.37 }), auto, null)[0]!.lmt_price).toBe(12.35);
  });
});

describe("单腿期权的托管停损:按期权跳动对齐,朝离开市场的一侧取整", () => {
  const auto = tk.makeAutoClose({ enabled: true, host_at_broker: true, order_type: "LMT" });
  // 每张成本 12;多头峰值 15.13、空头峰值 8.13,都在盈利一侧
  const opt = (q: number, secType = "OPT", mark = 12) => tk.makePosition({
    account: "模拟", symbol: "SPX", sec_type: secType, quantity: q, avg_cost: 1200, multiplier: 100, market_price: mark,
  });
  const stops = (position: ReturnType<typeof tk.makePosition>, targets: Rec, peak: number | null) => {
    const plan = tk.hostedPlan(position, tk.makeTargets(targets), auto, peak);
    const of = (kind: string) => plan.find((p) => p.kind === kind);
    return {
      sl: of(tk.HOSTED_KIND_SL)?.aux_price,
      seed: of(tk.HOSTED_KIND_TRAIL)?.trail_stop_seed,
      ptrail: of(tk.HOSTED_KIND_PTRAIL)?.aux_price,
    };
  };

  it("多头的卖出停损向下取整:3 元以上 0.10、以下 0.05", () => {
    // 止损 6.75 → 6.7;TRAIL 种子 15.13×0.9 = 13.617 → 13.6;利润回撤 12 + 3.13×0.6 = 13.878 → 13.8
    expect(stops(opt(2), { stop_loss: 6.75, trail_pct: 10, profit_drawdown_pct: 40 }, 15.13))
      .toEqual({ sl: 6.7, seed: 13.6, ptrail: 13.8 });
    expect(stops(opt(2), { stop_loss: 2.37 }, null).sl).toBe(2.35);
  });

  it("空头的买入停损向上取整", () => {
    // 止损 16.37 → 16.4;TRAIL 种子 8.13×1.1 = 8.943 → 9;利润回撤 12 − 3.87×0.6 = 9.678 → 9.7
    expect(stops(opt(-2), { stop_loss: 16.37, trail_pct: 10, profit_drawdown_pct: 40 }, 8.13))
      .toEqual({ sl: 16.4, seed: 9, ptrail: 9.7 });
    expect(stops(opt(-2), { stop_loss: 2.37 }, null).sl).toBe(2.4);
  });

  it("已在跳动上的价原样不动;FOP 走同一条规矩", () => {
    expect(stops(opt(1), { stop_loss: 6.8 }, null).sl).toBe(6.8);
    expect(stops(opt(-1), { stop_loss: 6.8 }, null).sl).toBe(6.8);
    expect(stops(opt(1, "FOP"), { stop_loss: 6.75 }, null).sl).toBe(6.7);
    expect(stops(opt(-1, "FOP"), { stop_loss: 6.75 }, null).sl).toBe(6.8);
  });

  it("标签里显示的是对齐后的价", () => {
    const plan = tk.hostedPlan(opt(1), tk.makeTargets({ stop_loss: 6.75 }), auto, null);
    expect(plan[0]!.label).toBe("托管止损 6.7");
  });

  // 审查时复现过的:朝"更早触发"取整会把停损压到现价上,IBKR 当场触发、把该拿着的仓平掉
  it("刚转盈利时的利润回撤停损不会被取整推到现价上", () => {
    // 多头成本 12,现价 = 峰值 12.05,回撤 40%:原始 12.03 → 12.0(若向上取整就是 12.1,越过现价)
    expect(stops(opt(1, "OPT", 12.05), { profit_drawdown_pct: 40 }, 12.05).ptrail).toBe(12);
    // 现价 = 峰值 12.20:原始 12.12 → 12.1;回撤 10%、峰值 12.50:原始 12.45 → 12.4
    expect(stops(opt(1, "OPT", 12.2), { profit_drawdown_pct: 40 }, 12.2).ptrail).toBe(12.1);
    expect(stops(opt(1, "OPT", 12.5), { profit_drawdown_pct: 10 }, 12.5).ptrail).toBe(12.4);
    // 空头成本 12,现价 = 峰值 11.95:原始 11.97 → 12.0(若向下取整就是 11.9,越过现价)
    expect(stops(opt(-1, "OPT", 11.95), { profit_drawdown_pct: 40 }, 11.95).ptrail).toBe(12);
  });

  it("离现价不到一跳的止损、跟踪止损种子,取整后仍在保护一侧", () => {
    expect(stops(opt(1, "OPT", 6.75), { stop_loss: 6.72 }, null).sl).toBe(6.7); // 多头 6.72 → 6.7 < 6.75
    expect(stops(opt(-1, "OPT", 6.8), { stop_loss: 6.85 }, null).sl).toBe(6.9); // 空头 6.85 → 6.9 > 6.8
    expect(stops(opt(1, "OPT", 6.8), { trail_pct: 1 }, 6.8).seed).toBe(6.7); // 6.80×0.99 = 6.732 → 6.7 < 6.8
  });

  it("性质:原始停损在保护一侧,取整后绝不压到或越过现价", () => {
    let checked = 0;
    for (let markCents = 20; markCents <= 2500; markCents += 7) {
      const mark = markCents / 100;
      for (let gapCents = 1; gapCents <= 30; gapCents += 1) {
        const long = stops(opt(1, "OPT", mark), { stop_loss: mark - gapCents / 100 }, null).sl;
        const short = stops(opt(-1, "OPT", mark), { stop_loss: mark + gapCents / 100 }, null).sl;
        // 最低跳动以下(多头止损不到 0.05)没有合法价,那一段不在这条性质里
        if (mark - gapCents / 100 >= 0.05) expect(long!, `多头 现价 ${mark} 止损 ${mark - gapCents / 100}`).toBeLessThan(mark);
        expect(short!, `空头 现价 ${mark} 止损 ${mark + gapCents / 100}`).toBeGreaterThan(mark);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it("正股不变(仍是 2 位小数);组合仍只托管止盈", () => {
    const stk = tk.makePosition({ account: "模拟", symbol: "BE", sec_type: "STK", quantity: 100, avg_cost: 10, multiplier: 1, market_price: 12 });
    // 10 + 5.13×0.6 = 13.078 → 13.08;15.13×0.9 = 13.617 → 13.62
    expect(stops(stk, { stop_loss: 6.75, trail_pct: 10, profit_drawdown_pct: 40 }, 15.13))
      .toEqual({ sl: 6.75, seed: 13.62, ptrail: 13.08 });
    const combo = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: 450, multiplier: 100, market_price: 4 });
    const plan = tk.hostedPlan(combo, tk.makeTargets({ take_profit: 12.37, stop_loss: 6.75, trail_pct: 10, profit_drawdown_pct: 40 }), auto, 15.13);
    expect(plan.map((p) => p.kind)).toEqual([tk.HOSTED_KIND_TP]);
  });
});

describe("托管的组合追价:越等越让,只朝成交方向动,部分成交不缩量", () => {
  it("头两轮挂在自然价,第 3 轮起每轮再让一跳,让到上限就停", async () => {
    const { engine, router } = build({ targets: { spot_target: 7740, profit_drawdown_pct: 40 }, peak: 8.0 });
    const natural = naturalOf(router.rows);
    const position = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: 450, multiplier: 100, market_price: 4 });
    const auto = tk.makeAutoClose({ chase_max_pct: 10 });
    await tick(engine);                                   // 第 0 轮:挂在自然价
    expect(router.placed[0]!.item.lmt_price).toBe(down(natural));
    await tick(engine);                                   // 第 1、2 轮:不动
    await tick(engine);
    expect(router.modified).toEqual([]);
    await tick(engine);                                   // 第 3 轮:让一跳
    expect(router.modified).toHaveLength(1);
    expect(router.modified[0]!.item.lmt_price).toBe(down(natural - 0.05));
    await tick(engine);                                   // 第 4 轮:再让一跳
    expect(router.modified[1]!.item.lmt_price).toBe(down(natural - 0.10));
    for (let i = 0; i < 30; i += 1) await tick(engine);   // 让到上限
    const floor = tk.chaseFloor(position, natural, auto);
    const last = router.modified[router.modified.length - 1]!;
    expect(last.item.lmt_price).toBe(floor);
    expect(router.modified.length).toBe(tk.chaseMaxSteps(position, natural, auto)); // 到上限后不再改
    expect(new Set(router.modified.map((m) => m.order_id)).size).toBe(1);
    expect(router.placed).toHaveLength(1);
  });

  it("买价抬上去了,挂着的单不改回去;掉下去了顺着追", async () => {
    const { engine, router } = build({ targets: { spot_target: 7740, profit_drawdown_pct: 40 }, peak: 8.0 });
    for (let i = 0; i < 5; i += 1) await tick(engine);
    const before = router.modified[router.modified.length - 1]!.item.lmt_price;
    router.rows = flyAt(7735);                            // 蝶更值钱了
    router.spot = 7735;
    await tick(engine);
    await tick(engine);
    expect(router.modified[router.modified.length - 1]!.item.lmt_price).toBeLessThanOrEqual(before);
    router.rows = flyAt(7705);                            // 掉下去
    router.spot = 7705;
    await tick(engine);
    expect(router.modified[router.modified.length - 1]!.item.lmt_price).toBeLessThan(before);
  });

  it("追了 30 轮还没成交:提醒一次,不刷屏", async () => {
    const { engine, router } = build({ targets: { spot_target: 7740, profit_drawdown_pct: 40 }, peak: 8.0 });
    for (let i = 0; i < 29; i += 1) await tick(engine);
    const stuck = () => engine.notifier.history.filter(([, , body]) => body.includes("仍未成交")).length;
    expect(stuck()).toBe(0);
    for (let i = 0; i < 5; i += 1) await tick(engine);
    expect(stuck()).toBe(1);
    expect(router.placed).toHaveLength(1);
  });

  it("界面拿到追到哪了:轮数、挂的价、自然价、最多让到", async () => {
    const { engine } = build({ targets: { spot_target: 7740, profit_drawdown_pct: 40 }, peak: 8.0 });
    for (let i = 0; i < 4; i += 1) await tick(engine);
    const poll = await engine.pollTrackers(NOON);
    const row = (poll["rows"] as Rec[])[0]!;
    expect(row["sweeping"]).toBe(true);
    expect(row["chase"]["rounds"]).toBe(4);
    expect(row["chase"]["limit"]).toBeLessThan(row["chase"]["natural"]);
    expect(row["chase"]["floor"]).toBeLessThanOrEqual(row["chase"]["limit"]);
  });

  it("3 张的托管单成交 1 张:持仓剩 2,改单时总量仍是 3(不把剩下的再砍一截)", async () => {
    // 追价中(自然价随行情变,才会有改单)
    const { engine, router } = build({ targets: { spot_target: 7740, profit_drawdown_pct: 40 }, peak: 8.0, lots: 3 });
    await tick(engine);
    expect(router.placed[0]!.item.quantity).toBe(3);
    const orderId = router.placed[0]!.order_id;
    engine.onOrderStatus({ order: { orderId, permId: null }, orderStatus: { status: "Submitted", filled: 1, remaining: 2 }, contract: { symbol: "SPX" } });
    router.rows = flyAt(7712, 2);                         // 持仓剩 2 组,价也变了
    router.spot = 7712;
    await tick(engine);
    expect(router.modified.length).toBeGreaterThan(0);
    for (const m of router.modified) expect(m.item.quantity).toBe(3);
    // 用户在别处又手动平了 1 组(持仓剩 1):总量改成 1 + 已成交 1 = 2
    router.rows = flyAt(7712, 1);
    await tick(engine);
    expect(router.modified[router.modified.length - 1]!.item.quantity).toBe(2);
  });
});

describe("手动「立即平仓」落在已有单的追踪上:改那张追价,不另发", () => {
  it("托管中(还没触发):落闩成 sweep:stop_loss,下一轮把托管单改到自然价;没有第二张单", async () => {
    const { engine, router, track } = build({ targets: { spot_target: 7740 } });
    await tick(engine);
    expect(router.placed).toHaveLength(1);
    expect(await engine.sweepExisting(engine.store.getTrack(track["id"])!, "手动平仓")).toBe(true);
    expect(engine.store.getTrack(track["id"])!["fired_state"]).toBe("sweep:stop_loss");
    await tick(engine);
    const last = router.modified[router.modified.length - 1]!;
    expect(last.order_id).toBe(router.placed[0]!.order_id);
    expect(last.item.lmt_price).toBe(down(naturalOf(router.rows)));
    expect(router.sent).toEqual([]);
  });

  it("没有现成的单:回 false,照常发平仓单", async () => {
    const { engine, track } = build({ targets: { spot_target: 7740 }, host: false });
    expect(await engine.sweepExisting(track, "手动平仓")).toBe(false);
    expect(engine.store.getTrack(track["id"])!["fired_state"] || null).toBeNull();
  });
});
