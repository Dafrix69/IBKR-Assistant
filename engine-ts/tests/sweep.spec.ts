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
function flyAt(spot: number): Rec[] {
  return [legRow(7725, 1, spot, 800), legRow(7750, -2, spot, 200), legRow(7775, 1, spot, 50)];
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

function build(opts: { targets: Rec; host?: boolean; peak?: number | null; spot?: number }) {
  const spot = opts.spot ?? 7720;
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-sweep-"));
  const settings = makeSettings(g.base_config, {
    policies: { auto_execute: true },
    storage: { db_path: path.join(dir, "sweep.db") },
  });
  const router = new SweepRouter(flyAt(spot), spot);
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
    expect(engine.store.getTrack(track["id"])!["fired_state"]).toBe("take_profit");
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

  it("任何一条腿没有有效买卖价(缺、非正、倒挂)→ null,不拿半边报价凑数", () => {
    expect(tk.naturalClosePrice(long, fly, { ...book, "7775C": { bid: null, ask: 0.1 } })).toBeNull();
    expect(tk.naturalClosePrice(long, fly, { ...book, "7775C": { bid: 0, ask: 0.1 } })).toBeNull();
    expect(tk.naturalClosePrice(long, fly, { ...book, "7750C": { bid: 0.8, ask: 0.7 } })).toBeNull();
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
