/** 标的止损价:标的跌到 / 涨到某个价位就平,记作止损(docs/features/tracker.md「标的止损价」)。
 *
 * 盯四层:
 *  1. 纯函数——触线即算、拿不到标的现价不判、设置时把方向填反的拦下;
 *  2. 并进一轮结论的先后——止损优先于止盈,已经判成止损 / 利润回撤的不改写;
 *  3. 接进引擎——到了就发那张腿方向反转的平仓单(没托管)或把托管单改到立刻成交的价(托管),
 *     昨收、取价报错都当成"这一轮拿不到",不触发;
 *  4. RPC——界面的原样载荷(字符串、'' = 不设)、strict schema、改目标时一起给。
 *
 * 假券商只记下收到的单,不连任何真东西。
 */
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { etNowFromEpoch, setClock } from "../src/config.js";
import { TradingEngine } from "../src/engine.js";
import * as fx from "../src/flyexit.js";
import { Notifier } from "../src/notify.js";
import { isStopLike } from "../src/protections.js";
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
const NOON_MS = Date.parse("2026-09-10T12:00:00-04:00");
const NOON = etNowFromEpoch(NOON_MS);

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

/** 以 4.50 买入的 7725/7750/7775 看涨蝶,三条腿按标的 spot、σ=20 定价。 */
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

function down(price: number, tick = 0.05): number {
  return pyRound(Math.floor(price / tick + 1e-9) * tick, 4);
}

class SpotRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  placed: Rec[] = [];
  modified: Rec[] = [];
  cancelled: number[] = [];
  sent: Rec[] = [];
  /** 标的现价的来源:index = 官方指数;index_stale = 夜盘推算失败退回的昨收 */
  source = "index";
  indexFails = false;
  indexCalls = 0;
  private nextId = 800;

  constructor(public rows: Rec[], public spot: number | null) {}

  sessions(): unknown[] { return [{}]; }
  connectedNames(): string[] { return ["paper"]; }
  async positions(): Promise<Rec[]> { return this.rows.map((r) => ({ ...r })); }
  async indexPrice(): Promise<number | null> {
    this.indexCalls += 1;
    if (this.indexFails) throw new Error("行情请求超时");
    return this.spot;
  }
  spotInfo(): Rec | null {
    return this.source === "index"
      ? { price: this.spot, source: "index", note: "" }
      : { price: this.spot, source: this.source, note: "SPX 指数只在常规时段计算,这是上一个收盘价,不是现价" };
  }
  async optionQuotes(rows: Rec[]): Promise<Record<string, { bid: number | null; ask: number | null }>> {
    return Object.fromEntries(rows.map((r) => {
      const mid = r["market_price"];
      if (mid === null || mid === undefined) return [r["key"], { bid: null, ask: null }];
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
}

// ---------------------------------------------------------------- 1. 纯函数
describe("标的止损价:判定(纯函数)", () => {
  const T = (over: Rec) => tk.makeTargets(over);

  it("没设:回 null;老记录没有这两个键,读出来是 null", () => {
    expect(tk.spotStop(T({ stop_loss: 1 }), "SPX", 7700)).toBeNull();
    expect(tk.makeTargets({})).toMatchObject({ spot_stop_below: null, spot_stop_above: null });
    expect(tk.hasSpotStop(T({}))).toBe(false);
    expect(tk.hasSpotStop(T({ spot_stop_above: 7800 }))).toBe(true);
  });

  it("只设了标的止损价也算设了目标(不会被「至少要设一个」拒)", () => {
    expect(tk.targetsEmpty(T({}))).toBe(true);
    expect(tk.targetsEmpty(T({ spot_stop_below: 7700 }))).toBe(false);
    expect(tk.targetsEmpty(T({ spot_stop_above: 7800 }))).toBe(false);
  });

  it("跌到:线上方不触发;触线即算;跌穿也算", () => {
    const t = T({ spot_stop_below: 7700 });
    expect(tk.spotStop(t, "SPX", 7700.01)).toMatchObject({ below: 7700, above: null, spot: 7700.01, hit: null, reason: "" });
    expect(tk.spotStop(t, "SPX", 7700)!.hit).toBe("below");
    const hit = tk.spotStop(t, "SPX", 7688.5)!;
    expect(hit.hit).toBe("below");
    expect(hit.reason).toBe("标的止损触发:SPX 现价 7688.50 跌破 7700");
  });

  it("涨到:对称", () => {
    const t = T({ spot_stop_above: 7800 });
    expect(tk.spotStop(t, "SPX", 7799.99)!.hit).toBeNull();
    expect(tk.spotStop(t, "SPX", 7800)!.hit).toBe("above");
    expect(tk.spotStop(t, "SPX", 7812.25)!.reason).toBe("标的止损触发:SPX 现价 7812.25 涨破 7800");
  });

  it("两条都设:夹在中间不触发,出哪边报哪边", () => {
    const t = T({ spot_stop_below: 7700, spot_stop_above: 7800 });
    expect(tk.spotStop(t, "SPX", 7750)!.hit).toBeNull();
    expect(tk.spotStop(t, "SPX", 7699)!.hit).toBe("below");
    expect(tk.spotStop(t, "SPX", 7801)!.hit).toBe("above");
  });

  it("拿不到标的现价(null / 0 / NaN):不判,并说出原因——不能读成「还没到」", () => {
    const t = T({ spot_stop_below: 7700 });
    for (const spot of [null, 0, NaN, -1]) {
      const out = tk.spotStop(t, "SPX", spot)!;
      expect(out.hit, String(spot)).toBeNull();
      expect(out.spot).toBeNull();
      expect(out.reason).toBe("拿不到 SPX 的现价,标的止损这一轮不判断");
    }
  });

  it("现价的来历照抄(夜盘按期货推算的那句话)", () => {
    expect(tk.spotStop(T({ spot_stop_below: 7700 }), "SPX", 7720, "按 ESZ6 − 基差 12.5 推算")!.spot_note)
      .toBe("按 ESZ6 − 基差 12.5 推算");
  });
});

describe("标的止损价:设置时的校验", () => {
  const T = (over: Rec) => tk.makeTargets(over);

  it("说得通:回 null", () => {
    expect(tk.spotStopIssue(T({}), "BAG", "SPX", null)).toBeNull(); // 没设就不查,也不要现价
    expect(tk.spotStopIssue(T({ spot_stop_below: 7700 }), "BAG", "SPX", 7720)).toBeNull();
    expect(tk.spotStopIssue(T({ spot_stop_above: 7800 }), "OPT", "SPX", 7720)).toBeNull();
    expect(tk.spotStopIssue(T({ spot_stop_below: 7700, spot_stop_above: 7800 }), "BAG", "SPX", 7720)).toBeNull();
  });

  it("填在现价的另一侧:建好的下一秒就会触发,当场拒", () => {
    expect(tk.spotStopIssue(T({ spot_stop_below: 7730 }), "BAG", "SPX", 7720))
      .toBe("「标的跌到」的止损价要低于 SPX 现价(现价 7720.00,你填了 7730)——填在上方会立刻触发。");
    expect(tk.spotStopIssue(T({ spot_stop_below: 7720 }), "BAG", "SPX", 7720)).toMatch(/^「标的跌到」的止损价要低于/);
    expect(tk.spotStopIssue(T({ spot_stop_above: 7710 }), "BAG", "SPX", 7720))
      .toBe("「标的涨到」的止损价要高于 SPX 现价(现价 7720.00,你填了 7710)——填在下方会立刻触发。");
    expect(tk.spotStopIssue(T({ spot_stop_above: 7720 }), "BAG", "SPX", 7720)).toMatch(/^「标的涨到」的止损价要高于/);
  });

  it("拿不到标的现价:核对不了方向,不给设", () => {
    expect(tk.spotStopIssue(T({ spot_stop_below: 7700 }), "BAG", "SPX", null))
      .toBe("拿不到 SPX 的现价,核对不了标的止损价在现价的哪一侧——等行情来了再设。");
  });

  it("两条线填反、不是正数、正股:各有各的一句", () => {
    expect(tk.spotStopIssue(T({ spot_stop_below: 7800, spot_stop_above: 7700 }), "BAG", "SPX", 7750))
      .toBe("标的止损价的两条线填反了:「跌到」(7800)要低于「涨到」(7700)。");
    expect(tk.spotStopIssue(T({ spot_stop_below: 0 }), "BAG", "SPX", 7750)).toBe("标的止损价必须是正数。");
    expect(tk.spotStopIssue(T({ spot_stop_above: -5 }), "BAG", "SPX", 7750)).toBe("标的止损价必须是正数。");
    expect(tk.spotStopIssue(T({ spot_stop_above: Infinity }), "BAG", "SPX", 7750)).toBe("标的止损价必须是正数。");
    expect(tk.spotStopIssue(T({ spot_stop_below: 95 }), "STK", "BE", 120))
      .toBe("标的止损价只给期权与组合用:正股的标的就是它自己,直接填止损价。");
  });
});

// ---------------------------------------------------------------- 2. 并进一轮结论
describe("标的止损价:并进这一轮的结论(withSpotTriggers)", () => {
  const position = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: 450, multiplier: 100 });
  const targets = tk.makeTargets({ take_profit: 6, stop_loss: 2, spot_target: null, spot_stop_below: 7700 });
  const hit = tk.spotStop(targets, "SPX", 7699)!;
  const miss = tk.spotStop(targets, "SPX", 7720)!;

  it("持有中 + 标的越线 → 止损,原因是标的那一句", () => {
    const base = tk.evaluate(position, targets, 4.0);
    expect(base.state).toBe(tk.STATE_HOLDING);
    const out = tk.withSpotTriggers(base, "SPX", targets, null, hit);
    expect(out.state).toBe(tk.STATE_STOP_LOSS);
    expect(out.reason).toBe("标的止损触发:SPX 现价 7699.00 跌破 7700");
    expect(out.price).toBe(4.0); // 别的字段原样
  });

  it("止损优先于止盈:同一轮持仓价到了止盈、标的也越了止损线,记止损", () => {
    const base = tk.evaluate(position, targets, 6.5);
    expect(base.state).toBe(tk.STATE_TAKE_PROFIT);
    expect(tk.withSpotTriggers(base, "SPX", targets, null, hit).state).toBe(tk.STATE_STOP_LOSS);
  });

  it("已经判成止损 / 利润回撤的不改写:那一句原因更具体", () => {
    const stopped = tk.evaluate(position, targets, 1.5);
    expect(stopped.state).toBe(tk.STATE_STOP_LOSS);
    expect(tk.withSpotTriggers(stopped, "SPX", targets, null, hit)).toBe(stopped);
    const trail = { ...tk.evaluate(position, targets, 4.0), state: tk.STATE_PROFIT_TRAIL, reason: "利润回撤触发" };
    expect(tk.withSpotTriggers(trail, "SPX", targets, null, hit)).toBe(trail);
  });

  it("没越线、没设:结论原样", () => {
    const base = tk.evaluate(position, targets, 4.0);
    expect(tk.withSpotTriggers(base, "SPX", targets, null, miss)).toBe(base);
    expect(tk.withSpotTriggers(base, "SPX", targets, null, null)).toBe(base);
  });

  it("拿不到持仓现价的那一轮,标的越线照样算:平仓那一步自己去取各腿买卖价", () => {
    const blind = tk.evaluate(position, targets, null);
    expect(blind.reason).toBe("拿不到现价,本轮不判断");
    expect(tk.withSpotTriggers(blind, "SPX", targets, null, hit).state).toBe(tk.STATE_STOP_LOSS);
  });

  it("标的到了目标价的那一条照旧:持有中才改成止盈,话一个字没变", () => {
    const t = tk.makeTargets({ spot_target: 7740 });
    const reached = { spot_target: 7740, spot: 7741.5, reached: true } as tk.SpotTarget;
    const base = tk.evaluate(position, t, 4.0);
    const out = tk.withSpotTriggers(base, "SPX", t, reached, null);
    expect(out.state).toBe(tk.STATE_TAKE_PROFIT);
    expect(out.reason).toBe("SPX 到了目标价 7740(现价 7741.5)");
    // 两样同时成立(目标价与止损线都越过):止损在前
    const both = tk.withSpotTriggers(base, "SPX", t, reached, hit);
    expect(both.state).toBe(tk.STATE_STOP_LOSS);
  });
});

// ---------------------------------------------------------------- 3. 接进引擎
function build(opts: { targets: Rec; host?: boolean; spot?: number; rows?: Rec[]; autoClose?: boolean; track?: Rec }) {
  const spot = opts.spot ?? 7720;
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-spotstop-"));
  const settings = makeSettings(g.base_config, {
    policies: { auto_execute: true },
    storage: { db_path: path.join(dir, "spotstop.db") },
  });
  const router = new SpotRouter(opts.rows ?? flyAt(spot), spot);
  const warnings: string[] = [];
  const notifier = new Notifier(false);
  notifier.warning = (message: string): void => { warnings.push(message); };
  const engine = new TradingEngine({
    settings, parser: {} as any, store: new TradeStore(settings.db_path), notifier, router: router as any,
  });
  const held = opts.track ?? tk.withCombos(router.rows).find((r) => r["sec_type"] === "BAG")!;
  const track = engine.store.addTrack({
    account: "模拟", symbol: "SPX", sec_type: held["sec_type"], leg: held["leg"], contract: held["contract"],
    targets: opts.targets,
    auto_close: { enabled: opts.autoClose ?? true, order_type: "LMT", host_at_broker: opts.host ?? false, close_fraction_pct: 100 },
    peak: null,
  });
  return { engine, router, track, warnings };
}

/** 一轮:先盯盘(判触发),再托管对账(挂 / 改单)——和引擎节拍器同一个顺序。 */
async function tick(engine: TradingEngine): Promise<Rec> {
  const poll = await engine.pollTrackers(NOON);
  await engine.syncHosted();
  return poll;
}

describe("标的止损价:盯盘(没托管)", () => {
  it("标的还在线上:不发单,行里带着两条线与标的现价", async () => {
    const { engine, router } = build({ targets: { spot_stop_below: 7700 } });
    const poll = await engine.pollTrackers(NOON);
    expect(poll.fired).toEqual([]);
    expect(router.sent).toEqual([]);
    expect(poll.rows[0]!.state).toBe(tk.STATE_HOLDING);
    expect(poll.rows[0]!.spot_stop).toEqual({ below: 7700, above: null, spot: 7720, spot_note: "", hit: null, reason: "" });
  });

  it("标的跌破:发出腿方向全部反转的 BAG 限价单,挂在各腿买卖价算出的立刻成交价上,记作止损", async () => {
    const { engine, router, track } = build({ targets: { spot_stop_below: 7700 } });
    await engine.pollTrackers(NOON);
    router.rows = flyAt(7698);
    router.spot = 7698;
    const poll = await engine.pollTrackers(NOON);

    expect(poll.fired.map((f) => f.reason)).toEqual(["标的止损触发:SPX 现价 7698.00 跌破 7700"]);
    expect(router.sent).toHaveLength(1);
    const order = router.sent[0]!["order"];
    expect(order.contract.secType).toBe("BAG");
    expect(order.contract.legs.map((l: Rec) => [l.action, l.ratio, l.strike])).toEqual([
      ["SELL", 1, 7725], ["BUY", 2, 7750], ["SELL", 1, 7775],
    ]);
    expect(order.order.action).toBe("SELL");
    expect(order.order.orderType).toBe("LMT");
    expect(order.order.totalQuantity).toBe(1);
    // 限价 = 立刻成交价再让 0.3% 的滑点,朝成交方向取整
    expect(order.order.lmtPrice).toBe(down(naturalOf(router.rows) * (1 - 0.003)));

    // 先落闩:期权 / 组合的限价平仓单发出后追价,追完换回原因本身
    const after = engine.store.getTrack(track["id"])!;
    expect(after["fired_state"]).toBe("sweep:stop_loss");
    expect(after["enabled"]).toBe(false);
    // 平仓的那条只增的痕按止损记:保护规则的止损护栏数得到它
    const closes = engine.store.closeTraces();
    expect(closes.map((c) => [c.path, c.symbol, c.state])).toEqual([["auto_close", "SPX", "stop_loss"]]);
    expect(isStopLike(closes[0]!.state)).toBe(true);
    expect(isStopLike(String(after["fired_state"]))).toBe(true);
  });

  it("标的涨破上面那条线:同样平掉", async () => {
    const { engine, router } = build({ targets: { spot_stop_below: 7700, spot_stop_above: 7790 } });
    router.rows = flyAt(7791);
    router.spot = 7791;
    const poll = await engine.pollTrackers(NOON);
    expect(poll.fired.map((f) => f.reason)).toEqual(["标的止损触发:SPX 现价 7791.00 涨破 7790"]);
    expect(router.sent).toHaveLength(1);
  });

  it("触发只发一次:下一轮标的还在线外,不再发第二张", async () => {
    const { engine, router } = build({ targets: { spot_stop_below: 7700 }, spot: 7698 });
    await engine.pollTrackers(NOON);
    await engine.pollTrackers(NOON);
    await engine.pollTrackers(NOON);
    expect(router.sent).toHaveLength(1);
  });

  it("这一轮拿不到标的现价:不触发,行里说明没判", async () => {
    const { engine, router } = build({ targets: { spot_stop_below: 7700 } });
    router.spot = null;
    const poll = await engine.pollTrackers(NOON);
    expect(router.sent).toEqual([]);
    expect(poll.rows[0]!.spot_stop).toMatchObject({ spot: null, hit: null, reason: "拿不到 SPX 的现价,标的止损这一轮不判断" });
  });

  it("夜盘推算失败退回的昨收不算现价:哪怕它已经在线外也不触发", async () => {
    const { engine, router } = build({ targets: { spot_stop_below: 7700 } });
    router.spot = 7650;            // 昨收,早就在止损线下面
    router.source = "index_stale";
    const poll = await engine.pollTrackers(NOON);
    expect(router.sent).toEqual([]);
    expect(poll.rows[0]!.spot_stop).toMatchObject({ spot: null, hit: null });
  });

  it("取标的价报错:这一轮不判,盯盘不炸", async () => {
    const { engine, router } = build({ targets: { spot_stop_below: 7700 }, spot: 7698 });
    router.indexFails = true;
    const poll = await engine.pollTrackers(NOON);
    expect(router.sent).toEqual([]);
    expect(poll.rows).toHaveLength(1);
    expect(poll.rows[0]!.spot_stop).toMatchObject({ spot: null, hit: null });
    router.indexFails = false;     // 行情回来的那一轮照常平
    await engine.pollTrackers(NOON);
    expect(router.sent).toHaveLength(1);
  });

  it("没开自动平仓:到了只提醒一次,不发单", async () => {
    const { engine, router, track, warnings } = build({ targets: { spot_stop_below: 7700 }, spot: 7698, autoClose: false });
    const first = await engine.pollTrackers(NOON);
    await engine.pollTrackers(NOON);
    expect(router.sent).toEqual([]);
    expect(first.blocked.map((b) => b.reason)).toEqual(["标的止损触发:SPX 现价 7698.00 跌破 7700"]);
    expect(warnings).toEqual([`SPX 标的止损触发:SPX 现价 7698.00 跌破 7700,但没有平仓:${tk.BLOCK_DISABLED}`]);
    expect(engine.store.getTrack(track["id"])!["fired_state"]).toBe("blocked");
  });

  it("没设标的止损价的追踪:不为它多取一次标的价,行里也没有这一项", async () => {
    const { engine, router } = build({ targets: { stop_loss: 1.0 } });
    const poll = await engine.pollTrackers(NOON);
    expect(router.indexCalls).toBe(0);
    expect(poll.rows[0]!.spot_stop).toBeUndefined();
  });

  it("和标的目标价一起设:一轮只取一次标的价,止盈与止损看同一个数", async () => {
    const { engine, router } = build({ targets: { spot_target: 7740, spot_stop_below: 7700 } });
    const poll = await engine.pollTrackers(NOON);
    expect(router.indexCalls).toBe(1);
    expect(poll.rows[0]!.spot_stop!.spot).toBe(poll.rows[0]!.spot_target!.spot);
    expect(poll.fired).toEqual([]);
  });
});

describe("标的止损价:托管到券商的追踪", () => {
  it("组合:券商那边只有止盈单;标的跌破 → 把那张单改到立刻成交的价,不另发平仓单", async () => {
    const { engine, router, track } = build({ targets: { spot_target: 7740, spot_stop_below: 7700 }, host: true });
    await tick(engine);
    expect(router.placed).toHaveLength(1);
    const orderId = router.placed[0]!.order_id;

    router.rows = flyAt(7698);
    router.spot = 7698;
    const poll = await tick(engine);
    expect(poll.fired.map((f: Rec) => [f["state"], f["reason"]])).toEqual([
      ["sweep:stop_loss", "标的止损触发:SPX 现价 7698.00 跌破 7700"],
    ]);
    expect(engine.store.getTrack(track["id"])!["fired_state"]).toBe("sweep:stop_loss");
    const last = router.modified[router.modified.length - 1]!;
    expect(last.order_id).toBe(orderId);
    expect(last.item.lmt_price).toBe(down(naturalOf(router.rows)));
    expect(router.sent).toEqual([]);
    expect(router.cancelled).toEqual([]);
  });

  /** 单腿期权托管时,券商那边有一张看**期权价**的停损单(sl)。标的止损越线时期权价可能还没到那张单的触发价——
   *  「止损归券商那张单管」这句话对标的止损不成立:不追价的话,这条线就是设了没人管。 */
  const call = (price: number): Rec => ({ ...legRow(7750, 1, 7720, 800), market_price: price });

  it("单腿:券商侧挂着看期权价的停损单,标的越线照样追价(改组里的止盈单)", async () => {
    const row = call(8.5);
    const { engine, router, track } = build({
      targets: { take_profit: 20, stop_loss: 2, spot_stop_below: 7700 }, host: true, rows: [row], track: row,
    });
    await tick(engine);
    expect(router.placed.map((p) => p.item.kind).sort()).toEqual(["sl", "tp"]);
    const tpId = router.placed.find((p) => p.item.kind === "tp")!.order_id;

    router.spot = 7699; // 标的越线了,期权价还在 8.50:离那张 2.00 的停损单远着
    const poll = await tick(engine);
    expect(poll.fired.map((f: Rec) => f["state"])).toEqual(["sweep:stop_loss"]);
    expect(engine.store.getTrack(track["id"])!["fired_state"]).toBe("sweep:stop_loss");
    const last = router.modified[router.modified.length - 1]!;
    expect(last.order_id).toBe(tpId);
    expect(last.item.lmt_price).toBe(8.3); // 买价 8.30,3 元以上按 0.10 跳动
    expect(router.sent).toEqual([]);       // 不另发组外的平仓单
  });

  it("对照:期权价自己跌破固定止损,券商那张停损单负责,软件不追价", async () => {
    const row = call(8.5);
    const { engine, router } = build({
      targets: { take_profit: 20, stop_loss: 2, spot_stop_below: 7700 }, host: true, rows: [row], track: row,
    });
    await tick(engine);
    router.rows = [call(1.9)]; // 期权价到了 2.00 以下,标的还在线上
    const poll = await tick(engine);
    expect(poll.fired).toEqual([]);
    expect(router.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------- 4. RPC:界面的载荷
const servers: RpcServer[] = [];
const dirs: string[] = [];

function makeServer(rows: Rec[], spot: number | null): { s: RpcServer; router: SpotRouter; call: (m: string, p?: Rec) => Promise<Rec> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-spotstop-rpc-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
  const s = new RpcServer(settingsPath, () => undefined);
  const router = new SpotRouter(rows, spot);
  s.router = router as never;
  servers.push(s);
  // 过一遍 JSON:和真的 stdio 一样,undefined 的键在路上就没了
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { s, router, call };
}

afterEach(() => {
  setClock(null);
  for (const s of servers.splice(0)) {
    s.anomaly.stop();
    s.engineBuilt?.stopTrackerLoop();
  }
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上 sqlite 句柄可能还占着 */
    }
  }
});

describe("标的止损价:tracker.add / tracker.update(界面的原样载荷)", () => {
  const FLY_KEY = tk.withCombos(flyAt(7720)).find((r) => r["sec_type"] === "BAG")!["key"] as string;
  /** lib/TrackForm.tsx 的 start() 拼出来的载荷:数值都是字符串,'' = 不设 */
  const ui = (over: Rec): Rec => ({
    key: FLY_KEY, take_profit: "", stop_loss: "", trail_pct: "", profit_drawdown_pct: "", profit_drawdown_preset: undefined,
    profit_drawdown_arm_pct: "", spot_target: "", spot_stop_below: "", spot_stop_above: "",
    close_fraction_pct: undefined, chase_max_pct: undefined, auto_close: false, order_type: "LMT", host_at_broker: false, ...over,
  });

  it("'7700' / '':存成数字 7700 与 null;只填这一项就能建", async () => {
    setClock(NOON_MS);
    const { s, call } = makeServer(flyAt(7720), 7720);
    const out = await call("tracker.add", ui({ spot_stop_below: "7700" }));
    expect(out["error"]).toBeUndefined();
    const targets = out["result"]["track"]["targets"];
    expect(targets).toMatchObject({ spot_stop_below: 7700, spot_stop_above: null, stop_loss: null, take_profit: null, spot_target: null });
    expect(s.engine.store.getTrack(out["result"]["track"]["id"])!["targets"]).toEqual(targets);
  });

  it("两条都填:各进各的字段", async () => {
    const { call } = makeServer(flyAt(7720), 7720);
    const out = await call("tracker.add", ui({ spot_stop_below: "7700", spot_stop_above: "7790.5" }));
    expect(out["result"]["track"]["targets"]).toMatchObject({ spot_stop_below: 7700, spot_stop_above: 7790.5 });
  });

  it("填在现价另一侧 / 拿不到标的现价 / 不是数:当场拒,追踪不建", async () => {
    const { s, router, call } = makeServer(flyAt(7720), 7720);
    const errorOf = async (over: Rec): Promise<Rec> => (await call("tracker.add", ui(over)))["error"];
    expect(await errorOf({ spot_stop_below: "7730" })).toEqual({
      code: -32602, message: "「标的跌到」的止损价要低于 SPX 现价(现价 7720.00,你填了 7730)——填在上方会立刻触发。",
    });
    expect((await errorOf({ spot_stop_above: "7710" }))["message"]).toMatch(/^「标的涨到」的止损价要高于 SPX 现价/);
    expect((await errorOf({ spot_stop_below: "7790", spot_stop_above: "7700" }))["message"]).toMatch(/两条线填反了/);
    expect(await errorOf({ spot_stop_below: "abc" })).toEqual({ code: -32602, message: "不是有效数字:'abc'" });
    router.spot = null;
    expect(await errorOf({ spot_stop_below: "7700" })).toEqual({
      code: -32602, message: "拿不到 SPX 的现价,核对不了标的止损价在现价的哪一侧——等行情来了再设。",
    });
    router.spot = 7650;
    router.source = "index_stale"; // 昨收在线下方:拿它核对会放行一条当场触发的线,或拒掉一条对的
    expect((await errorOf({ spot_stop_below: "7600" }))["message"]).toMatch(/^拿不到 SPX 的现价/);
    expect(s.engine.store.listTracks()).toEqual([]);
  });

  it("正股:拒,让人直接填止损价", async () => {
    const stock: Rec = {
      key: tk.makeKey("模拟", "BE", "STK"), account: "模拟", symbol: "BE", sec_type: "STK", leg: "", quantity: 100,
      avg_cost: 100, multiplier: 1, currency: "USD", market_price: 120, market_value: 12000, unrealized_pnl: 2000,
      contract: { secType: "STK", symbol: "BE" },
    };
    const { call } = makeServer([stock], 120);
    const out = await call("tracker.add", ui({ key: stock["key"], spot_stop_below: "95", order_type: "MKT" }));
    expect(out["error"]).toEqual({ code: -32602, message: "标的止损价只给期权与组合用:正股的标的就是它自己,直接填止损价。" });
  });

  it("键名写错一个字母:strict schema 当场拒,不是追踪照建、止损没设上", async () => {
    const { call } = makeServer(flyAt(7720), 7720);
    const out = await call("tracker.add", { ...ui({}), stop_loss: "1", spot_stop_bellow: "7700" });
    expect(out["error"]["message"]).toMatch(/有不认识的键:spot_stop_bellow/);
  });

  it("改目标:和别的目标一样一起给;只给别的字段,标的止损价就被清掉", async () => {
    const { call } = makeServer(flyAt(7720), 7720);
    const id = (await call("tracker.add", ui({ spot_stop_below: "7700" })))["result"]["track"]["id"];
    const moved = await call("tracker.update", { id, spot_stop_below: "7705", spot_stop_above: "7795" });
    expect(moved["result"]["track"]["targets"]).toMatchObject({ spot_stop_below: 7705, spot_stop_above: 7795 });
    // 改的时候同样核对方向
    const wrong = await call("tracker.update", { id, spot_stop_below: "7725" });
    expect(wrong["error"]["message"]).toMatch(/^「标的跌到」的止损价要低于 SPX 现价/);
    const cleared = await call("tracker.update", { id, stop_loss: "1", spot_stop_below: "", spot_stop_above: "" });
    expect(cleared["result"]["track"]["targets"]).toMatchObject({ stop_loss: 1, spot_stop_below: null, spot_stop_above: null });
  });
});
