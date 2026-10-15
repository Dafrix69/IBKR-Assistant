/** 持仓追踪 × 价位提醒的联动,以及正股止损的两处修正(docs/features/tracker.md「关键价位」「正股的止损」)。
 *
 * 钉四件事:
 *  1. 追踪什么就盯什么的价位:tracker.add 给标的建一条盯单(origin = tracker),已经在盯的不动;到了上限追踪照建、只提醒;
 *     第一次列追踪时给已有的追踪补上;追踪删掉之后,只因为追踪才盯着、又不在股票池里的那条跟着删,在池子里的交给池子管;
 *  2. 正股的止损确认:止损价 / 跟踪止损越线之后要连续待够秒数才平,回到线内从头数,拿不到现价计时留着;
 *     入参规矩:正股要先有止损价或跟踪止损,托管时不收;
 *  3. 正股的备用现价走报价流,只认成交价:报价流里没有成交价时这一轮不判,**不拿昨收冒充现价**;
 *  4. 个股期权的标的止损同样走报价流(指数照旧走 indexPrice,夜盘要期货推算)。
 *
 * 假券商只记下收到的单,不连任何真东西。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { etNowFromEpoch, setClock } from "../src/config.js";
import { TradingEngine } from "../src/engine.js";
import { stockSpot, underlyingSpot } from "../src/engine/spotStop.js";
import { Notifier } from "../src/notify.js";
import { RpcServer } from "../src/rpc.js";
import { AlertsService } from "../src/services/alerts.js";
import { TradeStore } from "../src/store.js";
import * as tk from "../src/tracker.js";
import { confirmStockStop } from "../src/trackerExits.js";
import { loadGolden, makeSettings } from "./util.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const g = loadGolden("config");
type Rec = Record<string, any>;

/** 2026-09-11(周五,交易日)美东 12:00,盘中。 */
const NOON = Date.parse("2026-09-11T12:00:00-04:00");
const SEC = 1000;

/** 模拟账户里 100 股 BE:成本 100,现价 120。 */
const stock = (over: Rec = {}): Rec => ({
  key: tk.makeKey("模拟", "BE", "STK"), account: "模拟", symbol: "BE", sec_type: "STK", leg: "", quantity: 100,
  avg_cost: 100, multiplier: 1, currency: "USD", market_price: 120, market_value: 12000, unrealized_pnl: 2000,
  contract: { secType: "STK", symbol: "BE" }, ...over,
});
const KEY = stock()["key"] as string;

/** 界面拼出来的 tracker.add 载荷原样:数值是字符串,'' = 不设 */
const ui = (over: Rec): Rec => ({
  key: KEY, take_profit: "", stop_loss: "", trail_pct: "", profit_drawdown_pct: "", spot_target: "",
  auto_close: false, order_type: "MKT", host_at_broker: false, ...over,
});

class FakeRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  sent: Rec[] = [];
  /** 报价流:代码 → 最后成交价(不给 = 这一路没有成交价) */
  quotes: Record<string, number> = {};
  /** indexPrice 的读价退路里有昨收:这里故意给一个昨收,看谁还在拿它当现价 */
  close = 99;
  indexCalls: string[] = [];
  private nextOrder = 990;
  constructor(public rows: Rec[]) {}
  sessions(): unknown[] { return [{}]; }
  connectedNames(): string[] { return ["paper"]; }
  async positions(): Promise<Rec[]> { return this.rows.map((r) => ({ ...r })); }
  async indexPrice(symbol: string): Promise<number | null> {
    this.indexCalls.push(symbol);
    return this.close;
  }
  spotInfo(): Rec | null { return null; }
  async streamQuotes(symbols: string[]): Promise<Record<string, Rec>> {
    return Object.fromEntries(symbols.filter((s) => this.quotes[s] !== undefined).map((s) => [s, { last: this.quotes[s] }]));
  }
  async optionQuotes(): Promise<Rec> { return {}; }
  async listHostedOpen(): Promise<Rec[]> { return []; }
  async place(recordId: string, approved: Rec): Promise<Rec> {
    this.sent.push(approved);
    this.nextOrder += 1;
    return { record_id: recordId, order_id: this.nextOrder, perm_id: null, status: "Submitted", limit_price: null, detail: {} };
  }
  async legQuotes(): Promise<unknown[]> { return []; }
  async cancelAllOpen(): Promise<number> { return 0; }
  async contractHours(): Promise<null> { return null; }
  cachedContractHours(): null { return null; }
}

const servers: RpcServer[] = [];
const dirs: string[] = [];

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

function makeServer(rows: Rec[] = [stock()]) {
  setClock(NOON);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-trk-levels-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
  const s = new RpcServer(settingsPath, () => undefined);
  const router = new FakeRouter(rows);
  s.router = router as never;
  servers.push(s);
  const warnings: string[] = [];
  s.engine.notifier.warning = (message: string): void => { warnings.push(message); };
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  const watchOf = (symbol: string): Rec | undefined => s.engine.store.listWatches().find((w) => w["symbol"] === symbol);
  return { s, router, call, warnings, watchOf };
}

// ---------------------------------------------------------------- 1. 追踪什么就盯什么的价位
describe("追踪 → 盯价位", () => {
  it("建追踪:标的多一条盯单,记着是追踪建的;删追踪:那条跟着删", async () => {
    const { call, watchOf } = makeServer();
    const out = await call("tracker.add", ui({ stop_loss: "95" }));
    expect(out["error"]).toBeUndefined();
    expect(watchOf("BE")).toMatchObject({ symbol: "BE", step: 0, enabled: true, origin: AlertsService.ORIGIN_TRACKER, levels: [] });
    // 界面列盯单时看得见它(价位条与弹窗都靠这一行)
    const listed = await call("alerts.list");
    expect((listed["result"]["watches"] as Rec[]).map((w) => [w["symbol"], w["origin"]])).toEqual([["BE", "tracker"]]);
    await call("tracker.delete", { id: out["result"]["track"]["id"] });
    expect(watchOf("BE")).toBeUndefined();
  });

  it("已经在盯的(股票池里开的):原样用,追踪删掉也不动它", async () => {
    const { s, call, watchOf } = makeServer();
    s.engine.store.addWatch("BE", 5);
    const out = await call("tracker.add", ui({ stop_loss: "95" }));
    expect(watchOf("BE")).toMatchObject({ step: 5, origin: "" });
    await call("tracker.delete", { id: out["result"]["track"]["id"] });
    expect(watchOf("BE")).toMatchObject({ step: 5, origin: "" });
  });

  it("追踪删掉时标的已经进了股票池:留着,改成由池子管(之后在板块页关掉才删)", async () => {
    const { s, call, watchOf } = makeServer();
    const out = await call("tracker.add", ui({ stop_loss: "95" }));
    const sector = s.engine.store.addSector("储能");
    s.engine.store.setSectorStocks(String(sector["id"]), [{ symbol: "BE", company: "", reason: "", tag: "" }]);
    await call("tracker.delete", { id: out["result"]["track"]["id"] });
    expect(watchOf("BE")).toMatchObject({ origin: "" });
  });

  it("同一标的还有别的追踪:不删", () => {
    const { s, watchOf } = makeServer();
    s.engine.store.addWatch("SPX", 0, AlertsService.ORIGIN_TRACKER);
    s.engine.store.addWatch("BE", 0, AlertsService.ORIGIN_TRACKER);
    expect(s.alerts.releaseForTrack(new Set(["SPX"]))).toEqual(["BE"]);
    expect(watchOf("SPX")).toBeDefined();
    expect(watchOf("BE")).toBeUndefined();
  });

  it("到了 30 只上限:追踪照建,只提醒一句为什么没盯价位", async () => {
    const { s, call, warnings, watchOf } = makeServer();
    for (let i = 0; i < AlertsService.MAX_WATCH; i += 1) s.engine.store.addWatch(`S${i}`);
    const out = await call("tracker.add", ui({ stop_loss: "95" }));
    expect(out["error"]).toBeUndefined();
    expect(watchOf("BE")).toBeUndefined();
    expect(warnings.join("\n")).toContain("价位已达 30 只上限,没有为 BE 算关键价位");
  });

  it("已有的追踪(这条联动之前建的):这次运行第一次列追踪时补上,只补一次", async () => {
    const { s, call, watchOf } = makeServer();
    s.engine.store.addTrack({
      account: "模拟", symbol: "BE", sec_type: "STK", leg: "", contract: { secType: "STK", symbol: "BE" },
      targets: tk.makeTargets({ stop_loss: 95 }), auto_close: {}, peak: null,
    });
    expect(watchOf("BE")).toBeUndefined();
    await call("tracker.list");
    expect(watchOf("BE")).toMatchObject({ origin: AlertsService.ORIGIN_TRACKER });
    // 同一次运行里人在板块页删掉了它:再列追踪不会又建回来
    s.engine.store.deleteWatch(String(watchOf("BE")!["id"]));
    await call("tracker.list");
    expect(watchOf("BE")).toBeUndefined();
  });

  it("表单上点「算关键价位」:alerts.create 带 origin = tracker;别的值一律当用户建的", async () => {
    const { call, watchOf } = makeServer();
    await call("alerts.create", { symbol: "be", origin: "tracker" });
    expect(watchOf("BE")).toMatchObject({ origin: "tracker" });
    await call("alerts.create", { symbol: "spy", origin: "whatever" });
    expect(watchOf("SPY")).toMatchObject({ origin: "" });
  });
});

// ---------------------------------------------------------------- 2. 正股的止损确认
describe("正股的止损确认(纯函数)", () => {
  const held = (price: number | null) => ({ state: "stop_loss", price, reason: "止损触发:现价 94.0000 跌破 95.0000" });

  it("没设:原样", () => {
    const r = held(94);
    expect(confirmStockStop(r, true, null, null, NOON)).toEqual([r, null]);
    expect(confirmStockStop(r, true, 0, null, NOON)).toEqual([r, null]);
  });

  it("越线没待够:改回持有,写明待了几秒;待够了:止损", () => {
    const [first, clock] = confirmStockStop(held(94), true, 3, null, NOON);
    expect(first).toMatchObject({ state: "holding", stop_pending: { held_s: 0, need_s: 3 } });
    expect(first.reason).toBe("止损触发:现价 94.0000 跌破 95.0000,已持续 0 秒,满 3 秒才平");
    const [second, clock2] = confirmStockStop(held(94), true, 3, clock, NOON + 2 * SEC);
    expect(second).toMatchObject({ state: "holding", stop_pending: { held_s: 2, need_s: 3 } });
    const [third] = confirmStockStop(held(93.5), true, 3, clock2, NOON + 3 * SEC);
    expect(third.state).toBe("stop_loss");
  });

  it("回到线内:清零;拿不到现价:计时留着(没看见不等于回去了)", () => {
    const [, clock] = confirmStockStop(held(94), true, 3, null, NOON);
    expect(confirmStockStop({ state: "holding", price: 96, reason: "" }, true, 3, clock, NOON + SEC)[1]).toBeNull();
    expect(confirmStockStop({ state: "holding", price: null, reason: "拿不到现价" }, true, 3, clock, NOON + SEC)[1]).toBe(clock);
  });

  it("空头的止损在上方:计时记在上方那一侧", () => {
    const [out, clock] = confirmStockStop({ state: "stop_loss", price: 131, reason: "止损触发" }, false, 5, null, NOON);
    expect(out.state).toBe("holding");
    expect(clock).toEqual({ side: "above", sinceMs: NOON });
  });
});

describe("正股的止损确认:入参", () => {
  it("正股填了确认秒数和止损价:收下", async () => {
    const { call } = makeServer();
    const out = await call("tracker.add", ui({ stop_loss: "95", spot_stop_confirm_s: "3" }));
    expect(out["error"]).toBeUndefined();
    expect(out["result"]["track"]["targets"]).toMatchObject({ stop_loss: 95, spot_stop_confirm_s: 3 });
  });

  it("没有止损价也没有跟踪止损:拒", async () => {
    const { call } = makeServer();
    const out = await call("tracker.add", ui({ take_profit: "140", spot_stop_confirm_s: "3" }));
    expect(out["error"]).toMatchObject({ code: -32602, message: "正股的止损确认要先填止损价或跟踪止损。" });
  });

  it("托管到券商:拒(券商触线即发,软件等多久都拦不住)", async () => {
    const { call } = makeServer();
    const out = await call("tracker.add", ui({ stop_loss: "95", spot_stop_confirm_s: "3", auto_close: true, host_at_broker: true }));
    expect(out["error"]).toMatchObject({ code: -32602 });
    expect(out["error"]["message"]).toContain("托管到券商的止损由券商触线即发");
  });
});

// ---------------------------------------------------------------- 接进引擎
function buildEngine(targets: Rec, row: Rec = stock()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-trk-levels-eng-"));
  dirs.push(dir);
  const settings = makeSettings(g.base_config, { policies: { auto_execute: true }, storage: { db_path: path.join(dir, "e.db") } });
  const router = new FakeRouter([row]);
  const notifier = new Notifier(false);
  notifier.warning = (): void => undefined;
  notifier.notify = (): void => undefined;
  const engine = new TradingEngine({ settings, parser: {} as any, store: new TradeStore(settings.db_path), notifier, router: router as any });
  const track = engine.store.addTrack({
    account: "模拟", symbol: row["symbol"], sec_type: row["sec_type"], leg: row["leg"] ?? "", contract: row["contract"],
    targets: tk.makeTargets(targets), auto_close: { enabled: true, order_type: "MKT", host_at_broker: false, close_fraction_pct: 100 },
    peak: null,
  });
  return { engine, router, track };
}

describe("正股的止损确认:接进盯盘", () => {
  it("跌破止损线连着 3 秒才平;中途弹回线内从头数", async () => {
    const at = (ms: number) => etNowFromEpoch(NOON + ms);
    const { engine, router } = buildEngine({ stop_loss: 95, spot_stop_confirm_s: 3 });
    const mark = (p: number): void => { router.rows = [stock({ market_price: p })]; };
    mark(94.9);
    let poll = await engine.pollTrackers(at(0));
    expect(poll.fired).toEqual([]);
    expect(poll.rows[0]).toMatchObject({ state: "holding", stop_pending: { held_s: 0, need_s: 3 } });
    mark(95.2); // 一笔打穿又弹回:计时清零
    await engine.pollTrackers(at(1 * SEC));
    mark(94.8);
    await engine.pollTrackers(at(2 * SEC));
    poll = await engine.pollTrackers(at(4 * SEC));
    expect(poll.fired).toEqual([]); // 从 2 秒那一笔重新数,4 秒时才 2 秒
    poll = await engine.pollTrackers(at(5 * SEC));
    expect(poll.fired.map((f) => f.state)).toEqual(["stop_loss"]);
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0]!["order"]["order"]).toMatchObject({ action: "SELL", totalQuantity: 100 });
  });

  it("没设确认:一碰线就平(和以前一样)", async () => {
    const { engine, router } = buildEngine({ stop_loss: 95 });
    router.rows = [stock({ market_price: 94.9 })];
    const poll = await engine.pollTrackers(etNowFromEpoch(NOON));
    expect(poll.fired.map((f) => f.state)).toEqual(["stop_loss"]);
  });
});

// ---------------------------------------------------------------- 3. 正股的备用现价不认昨收
describe("正股的备用现价", () => {
  it("持仓推送没有现价、报价流也没有成交价:这一轮不判,不拿昨收当现价", async () => {
    const { engine, router } = buildEngine({ stop_loss: 100 });
    router.rows = [stock({ market_price: null })];
    router.close = 99; // 以前退到 indexPrice,读价退路里的昨收 99 会让 100 的止损当场触发
    const poll = await engine.pollTrackers(etNowFromEpoch(NOON));
    expect(poll.fired).toEqual([]);
    expect(poll.rows[0]).toMatchObject({ state: "holding", reason: "拿不到现价,本轮不判断" });
    expect(router.indexCalls).toEqual([]);
  });

  it("报价流有成交价:拿它判", async () => {
    const { engine, router } = buildEngine({ stop_loss: 100 });
    router.rows = [stock({ market_price: null })];
    router.quotes = { BE: 99.5 };
    const poll = await engine.pollTrackers(etNowFromEpoch(NOON));
    expect(poll.fired.map((f) => f.state)).toEqual(["stop_loss"]);
  });

  it("stockSpot:只认成交价;报价流抛错是 null;没有报价流的券商退到 indexPrice", async () => {
    const router = new FakeRouter([]);
    expect(await stockSpot(router, "BE")).toBeNull();
    router.quotes = { BE: 120.5 };
    expect(await stockSpot(router, "BE")).toBe(120.5);
    router.streamQuotes = async () => { throw new Error("线路满了"); };
    expect(await stockSpot(router, "BE")).toBeNull();
    expect(await stockSpot({ indexPrice: async () => 7700 }, "SPX")).toBe(7700);
  });

  it("个股期权的标的走报价流,指数照旧走 indexPrice", async () => {
    const router = new FakeRouter([]);
    router.quotes = { AAPL: 231.2 };
    expect(await underlyingSpot(router, "AAPL", false)).toEqual({ spot: 231.2, note: "" });
    expect(router.indexCalls).toEqual([]);
    expect((await underlyingSpot(router, "SPX", true)).spot).toBe(99);
    expect(router.indexCalls).toEqual(["SPX"]);
  });
});

describe("股票池的一次性迁移不收追踪建的盯单", () => {
  it("升级上来的库(还没迁过)里已有追踪建的盯单:迁移不把它并进「自选」", async () => {
    const { s, call, watchOf } = makeServer();
    s.engine.store.addWatch("BE", 0, AlertsService.ORIGIN_TRACKER);
    s.engine.store.addWatch("SPY", 5);
    await call("alerts.list"); // 第一次读盯单时跑迁移
    expect([...s.engine.store.symbolsInSectors()]).toEqual(["SPY"]);
    expect(watchOf("BE")).toMatchObject({ origin: "tracker" });
  });
});

describe("个股期权的标的止损:接进盯盘", () => {
  const aaplCall = (): Rec => {
    const contract = { secType: "OPT", symbol: "AAPL", lastTradeDateOrContractMonth: "20260918", strike: 230, right: "C", multiplier: "100" };
    return {
      key: tk.makeKey("模拟", "AAPL", "OPT", tk.legOf(contract)), account: "模拟", symbol: "AAPL", sec_type: "OPT", leg: tk.legOf(contract),
      quantity: 2, avg_cost: 550, multiplier: 100, currency: "USD", market_price: 6.2, market_value: 1240, unrealized_pnl: 140, contract,
    };
  };

  it("报价流里没有 AAPL 的成交价:标的止损这一轮不判(以前退到昨收 99,200 的线当场就破了)", async () => {
    const { engine, router } = buildEngine({ spot_stop_below: 200 }, aaplCall());
    router.close = 99;
    let poll = await engine.pollTrackers(etNowFromEpoch(NOON));
    expect(poll.rows[0]!["spot_stop"]).toMatchObject({ spot: null, hit: null });
    expect(poll.rows[0]!["state"]).toBe("holding");
    expect(router.indexCalls).toEqual([]);
    router.quotes = { AAPL: 199.5 };
    poll = await engine.pollTrackers(etNowFromEpoch(NOON + SEC));
    expect(poll.rows[0]!["spot_stop"]).toMatchObject({ spot: 199.5, hit: "below" });
  });
});
