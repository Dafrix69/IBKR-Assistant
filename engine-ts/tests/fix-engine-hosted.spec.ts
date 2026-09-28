/** 2026-09-27 审计修掉的那几件"保护在该在的时候不在"的事:熔断、托管单、立即平仓、保护规则。
 *
 * 每一条都是审计时用假券商跑出来的真实后果,这里把它们钉住:
 *  · 自动熔断(大模型超时三次)撤光券商侧的托管止损、停掉软件止损;
 *  · 挂托管单失败每秒重来,三秒把熔断打合上;
 *  · 对账途中另一条追踪的托管单成交,同一轮拿旧快照又给已平掉的仓挂一组单;
 *  · 券商撤了托管单,下一秒原样重挂,撤一次挂一次;
 *  · 托管止损被拒、价格穿过止损,引擎只是 continue——持仓没有任何保护却显示"已托管";
 *  · 「立即平仓」落在只挂着止损的托管追踪上,另发一张组外的平仓单(外加下一轮再挂一张止盈)= 一手多头三张卖单;
 *  · 上一张平仓单还挂着,再点「立即平仓」又发一张;
 *  · 保护规则把用户手敲的平仓单也挡在保护期里;券商侧止损成交不计入保护规则;
 *  · 扇出后按"上限 × 账户数"截单;熔断要排在一轮盯盘后面才合闸。
 * 全部离线:假券商只记下收到的单。
 */
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrokerError } from "../src/broker.js";
import type { EtNow } from "../src/config.js";
import { setClock } from "../src/config.js";
import { TradingEngine } from "../src/engine.js";
import { Notifier } from "../src/notify.js";
import { protectionBlock } from "../src/protections.js";
import { LLMError, LLMResponse } from "../src/providers.js";
import { RpcServer } from "../src/rpc.js";
import { TradeStore } from "../src/store.js";
import * as tk from "../src/tracker.js";
import { loadGolden, makeSettings } from "./util.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const g = loadGolden("config");
type Rec = Record<string, any>;

/** 2026-08-14(周五)美东 10:32,盘中。 */
const FRIDAY: EtNow = { epochMs: 0, date: "2026-08-14", minutes: 10 * 60 + 32, seconds: 0 };
/** 2026-09-11(周五,交易日)美东 12:00,盘中。 */
const NOON = Date.parse("2026-09-11T12:00:00-04:00");

afterEach(() => setClock(null));

class FakeRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  upstreamOk = true;
  placed: Rec[] = [];
  modified: Rec[] = [];
  cancelled: number[] = [];
  sent: Rec[] = [];
  placeAttempts = 0;
  failPlace: Error | null = null;
  onModify: ((orderId: number) => void) | null = null;
  private nextId = 500;

  constructor(public rows: Rec[] = []) {}

  sessions(): unknown[] { return [{}]; }
  connectedNames(): string[] { return ["paper"]; }
  async positions(): Promise<Rec[]> { return this.rows.map((r) => ({ ...r })); }
  async placeHosted(account: Rec, _contract: Rec, item: Rec, oca: string, ref: string): Promise<Rec> {
    this.placeAttempts += 1;
    if (this.failPlace) throw this.failPlace;
    this.nextId += 1;
    this.placed.push({ item: { ...item }, oca, ref, account: account.alias, order_id: this.nextId });
    return { order_id: this.nextId, perm_id: null, status: "PreSubmitted" };
  }
  async modifyHosted(orderId: number, item: Rec): Promise<boolean> {
    this.onModify?.(orderId);
    this.modified.push({ order_id: orderId, item: { ...item } });
    return true;
  }
  async cancelHosted(orderId: number): Promise<boolean> {
    this.cancelled.push(orderId);
    return true;
  }
  async listHostedOpen(): Promise<Rec[]> { return []; }
  async place(recordId: string, approved: Rec): Promise<Rec> {
    this.sent.push(approved);
    return { record_id: recordId, order_id: 990, perm_id: null, status: "Submitted", limit_price: null, detail: {} };
  }
  async indexPrice(): Promise<number | null> { return null; }
  async optionQuotes(): Promise<Rec> { return {}; }
  async legQuotes(): Promise<unknown[]> { return []; }
  async cancelAllOpen(): Promise<number> { return 0; }
  async contractHours(): Promise<null> { return null; }
  cachedContractHours(): null { return null; }
}

function stockRow(symbol = "NVDA", over: Rec = {}): Rec {
  return {
    key: tk.makeKey("模拟", symbol, "STK"), account: "模拟", symbol, sec_type: "STK", leg: "", quantity: 100,
    avg_cost: 180, multiplier: 1, currency: "USD", market_price: 220, market_value: 22000, unrealized_pnl: 4000,
    contract: { secType: "STK", symbol, exchange: "SMART", currency: "USD" }, ...over,
  };
}

function build(router: FakeRouter, over: Rec = {}): TradingEngine {
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-fix-hosted-"));
  const settings = makeSettings(g.base_config, {
    policies: { auto_execute: true },
    storage: { db_path: path.join(dir, "h.db") },
    ...over,
  });
  return new TradingEngine({
    settings, parser: {} as never, store: new TradeStore(settings.db_path), notifier: new Notifier(false), router: router as never,
  });
}

function track(engine: TradingEngine, over: Rec = {}): Rec {
  const symbol = String(over["symbol"] ?? "NVDA");
  return engine.store.addTrack({
    account: "模拟", symbol, sec_type: "STK",
    contract: { secType: "STK", symbol, exchange: "SMART", currency: "USD" },
    targets: { take_profit: 250, stop_loss: 160 },
    auto_close: { enabled: true, host_at_broker: true },
    peak: 220,
    ...over,
  });
}

const status = (orderId: number, s: string, filled = 0): Rec => ({
  order: { orderId, permId: null }, orderStatus: { status: s, filled, remaining: 100 - filled }, contract: { symbol: "NVDA" },
});

function tripAutomatically(engine: TradingEngine): void {
  for (let i = 0; i < 3; i++) engine.killswitch.recordFailure("大模型接口超时", "parse");
}

// ---------------------------------------------------------------------------------------------
describe("熔断:自动的只停新单,不拿掉已有的保护;手动的照旧全停", () => {
  it("自动熔断:券商侧的托管止盈止损原样留着,不撤、不改,界面知道为什么", async () => {
    const router = new FakeRouter([stockRow()]);
    const engine = build(router);
    track(engine);
    await engine.syncHosted();
    expect(router.placed.map((p) => p.item.kind)).toEqual(["tp", "sl"]);

    tripAutomatically(engine);
    expect(engine.killswitch.state()).toMatchObject({ engaged: true, auto: true });
    const out = await engine.syncHosted();
    expect(router.cancelled).toEqual([]);
    expect(router.modified).toEqual([]);
    expect(out.hosted[0]?.orders).toHaveLength(2);
    expect(JSON.stringify(out.blocked)).toContain("自动熔断");
  });

  it("手动熔断(人按了暂停):照旧撤掉托管单", async () => {
    const router = new FakeRouter([stockRow()]);
    const engine = build(router);
    track(engine);
    await engine.syncHosted();
    engine.killswitch.engage("用户在界面上按下暂停");
    expect(engine.killswitch.state().auto).toBe(false);
    await engine.syncHosted();
    expect(router.cancelled).toHaveLength(2);
  });

  it("自动熔断不挡软件止损:价格穿过止损照样平;手动熔断照旧不发", async () => {
    for (const manual of [false, true]) {
      const router = new FakeRouter([stockRow("NVDA", { market_price: 150, market_value: 15000 })]);
      const engine = build(router);
      track(engine, { targets: { stop_loss: 160 }, auto_close: { enabled: true } });
      if (manual) engine.killswitch.engage("用户在界面上按下暂停");
      else tripAutomatically(engine);
      setClock(NOON); // 盘中:时段闸门放行,拦不拦只看熔断
      const out = await engine.pollTrackers();
      expect(router.sent, manual ? "手动熔断" : "自动熔断").toHaveLength(manual ? 0 : 1);
      if (manual) expect(JSON.stringify(out.blocked)).toContain("熔断");
    }
  });

  it("解析接连失败把熔断打合上时,当场说一声(以前自动熔断是静默的)", async () => {
    const router = new FakeRouter([]);
    const engine = build(router);
    (engine as unknown as { parser: Rec }).parser = {
      async parse(): Promise<LLMResponse> { throw new LLMError("接口超时"); },
    };
    const spy = vi.spyOn(engine.notifier, "breaker");
    for (let i = 0; i < 3; i++) await engine.handleInstruction("买入 AAPL 10 股", "manual", FRIDAY, {});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain("自动熔断");
  });
});

// ---------------------------------------------------------------------------------------------
describe("托管单挂不上:退避,不每秒重来", () => {
  it("券商报错:一分钟内不再挂;只算一次券商失败,不会三秒把熔断打合上", async () => {
    const router = new FakeRouter([stockRow()]);
    router.failPlace = new BrokerError("与 TWS 的连接中断");
    const engine = build(router);
    track(engine, { targets: { take_profit: 250 } });
    for (let i = 0; i < 5; i++) await engine.syncHosted();
    expect(router.placeAttempts).toBe(1);
    expect(engine.killswitch.state()).toMatchObject({ engaged: false, consecutive_failures: 1 });
  });

  it("拼不出平仓合约是我们这头的错:不去券商试,也不计入熔断", async () => {
    const router = new FakeRouter([stockRow()]);
    const engine = build(router);
    track(engine, { targets: { take_profit: 250 }, contract: { secType: "STK", symbol: "bad sym!" } });
    for (let i = 0; i < 5; i++) await engine.syncHosted();
    expect(router.placeAttempts).toBe(0);
    expect(engine.killswitch.state()).toMatchObject({ engaged: false, consecutive_failures: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
describe("对账途中券商回报改了追踪:不拿旧快照接着挂", () => {
  it("B 改价的空档里 A 的止盈单成交:同一轮不再给 A 挂新单", async () => {
    const router = new FakeRouter([stockRow("NVDA"), stockRow("AMD")]);
    const engine = build(router);
    const a = track(engine, { symbol: "NVDA", targets: { take_profit: 250 } });
    // A 更早建:listTracks 新的在前,这一轮先处理 B、再处理 A
    (engine.store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
      .prepare("UPDATE position_tracks SET created_at=? WHERE id=?").run("2026-01-01T00:00:00", a["id"]);
    const b = track(engine, { symbol: "AMD", targets: { take_profit: 250 } });
    await engine.syncHosted();
    const aTp = router.placed.find((p) => String(p.ref).startsWith(`trk:${a["id"]}:`));
    expect(aTp).toBeDefined();

    engine.store.updateTrack(b["id"], { targets: { take_profit: 260 } });
    router.onModify = () => engine.onOrderStatus(status(Number(aTp?.order_id), "Filled", 100));
    await engine.syncHosted();
    expect(router.placed.filter((p) => String(p.ref).startsWith(`trk:${a["id"]}:`))).toHaveLength(1);
    expect(engine.store.getTrack(a["id"])?.["fired_state"]).toBe("take_profit");
  });
});

// ---------------------------------------------------------------------------------------------
describe("券商撤了托管单:退避一分钟、说一声;我们自己撤的不算", () => {
  it("不是我们撤的:不马上原样重挂", async () => {
    const router = new FakeRouter([stockRow()]);
    const engine = build(router);
    track(engine, { targets: { take_profit: 250 } });
    await engine.syncHosted();
    const warn = vi.spyOn(engine.notifier, "warning");
    engine.onOrderStatus(status(Number(router.placed[0]?.order_id), "Cancelled"));
    const out = await engine.syncHosted();
    expect(router.placeAttempts).toBe(1);
    expect(JSON.stringify(out.blocked)).toContain("撤掉了这张托管单");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("撤掉了这张托管单"))).toBe(true);
  });

  it("我们自己撤的(目标删掉了)回报晚到:不进退避,目标加回来马上重挂", async () => {
    const router = new FakeRouter([stockRow()]);
    const engine = build(router);
    const t = track(engine, { targets: { take_profit: 250 } });
    await engine.syncHosted();
    const tpId = Number(router.placed[0]?.order_id);
    engine.store.updateTrack(t["id"], { targets: {} });
    await engine.syncHosted();
    expect(router.cancelled).toEqual([tpId]);
    engine.onOrderStatus(status(tpId, "Cancelled"));
    engine.store.updateTrack(t["id"], { targets: { take_profit: 250 } });
    await engine.syncHosted();
    expect(router.placed).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
describe("负责这个触发的托管单不在券商侧:引擎在同一个 OCA 组里追价平仓", () => {
  it("止损单被券商拒了、价格穿过止损:把组里的止盈单改到立刻成交的价,不另发组外的单", async () => {
    const router = new FakeRouter([stockRow()]);
    const engine = build(router);
    track(engine);
    await engine.syncHosted();
    const tp = router.placed.find((p) => p.item.kind === "tp");
    const sl = router.placed.find((p) => p.item.kind === "sl");
    engine.onIbError(sl?.order_id, 201, "Order rejected - reason: margin");

    router.rows = [stockRow("NVDA", { market_price: 150, market_value: 15000 })];
    const poll = await engine.pollTrackers(FRIDAY);
    expect(poll.fired.map((f) => f.state)).toEqual(["sweep:stop_loss"]);
    expect(router.sent).toEqual([]);

    await engine.syncHosted();
    // 现价 150 朝成交方向让 0.3% = 149.55;改的是组里原来那张止盈单
    expect(router.modified.at(-1)).toMatchObject({ order_id: tp?.order_id, item: { kind: "tp", lmt_price: 149.55 } });
    expect(router.sent).toEqual([]);
  });

  it("刚建的托管追踪、还没对过账:缓存里没单不等于没保护,不抢着追价", async () => {
    const router = new FakeRouter([stockRow("NVDA", { market_price: 150, market_value: 15000 })]);
    const engine = build(router);
    track(engine);
    const poll = await engine.pollTrackers(FRIDAY);
    expect(poll.fired).toEqual([]);
    expect(poll.rows[0]?.hosted).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe("券商侧止损成交计入保护规则", () => {
  it("托管止损成交 → 同一标的进入冷却", async () => {
    const router = new FakeRouter([stockRow()]);
    const engine = build(router, { protections: { cooldown: { enabled: true, minutes: 30 } } });
    track(engine, { targets: { stop_loss: 160 } });
    await engine.syncHosted();
    engine.onOrderStatus(status(Number(router.placed[0]?.order_id), "Filled", 100));
    expect(protectionBlock(engine.protectionState(), "NVDA", Date.now())).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
function order(over: Rec = {}): Rec {
  return {
    intent_summary: "限价 230 卖出 10 股 AAPL",
    contract: { secType: "STK", symbol: "AAPL", exchange: "SMART", currency: "USD" },
    execution_type: "IMMEDIATE", trigger: null, account: "DEFAULT",
    order: { action: "SELL", orderType: "LMT", totalQuantity: 10, price_mode: "EXPLICIT", lmtPrice: 230, tif: "DAY", outsideRth: false },
    reason: "", confidence: 0.99, warnings: [], ...over,
  };
}

function withParser(engine: TradingEngine, orders: Rec[]): void {
  (engine as unknown as { parser: Rec }).parser = {
    async parse(): Promise<LLMResponse> {
      return new LLMResponse(JSON.stringify({ orders, rejections: [] }), "claude-opus-5", "v", "f", 1);
    },
  };
}

describe("保护规则只挡新单、永不挡平仓:手敲的平仓单照发", () => {
  it("冷却期里:卖出持有的 AAPL 照发;再买 AAPL 挡下", async () => {
    const router = new FakeRouter([stockRow("AAPL", { market_price: 230 })]);
    const engine = build(router, { protections: { cooldown: { enabled: true, minutes: 30 } } });
    engine.store.audit("engine", "auto_close", { symbol: "AAPL", state: "stop_loss" });
    expect(protectionBlock(engine.protectionState(), "AAPL", Date.now())).not.toBeNull();

    withParser(engine, [order()]);
    const sell = await engine.handleInstruction("卖出 AAPL 10 股 平仓", "manual", FRIDAY, {}, ["模拟"]);
    expect(sell.submitted).toHaveLength(1);

    withParser(engine, [order({ intent_summary: "限价 230 买入 10 股 AAPL", order: { ...order()["order"], action: "BUY" } })]);
    const buy = await engine.handleInstruction("买入 AAPL 10 股", "manual", FRIDAY, {}, ["模拟"]);
    expect(buy.submitted).toEqual([]);
    expect(buy.validated_only).toHaveLength(1);
  });

  it("卖得比持仓多(平完还要开空):不算平仓,照旧挡", async () => {
    const router = new FakeRouter([stockRow("AAPL", { quantity: 5, market_price: 230 })]);
    const engine = build(router, { protections: { cooldown: { enabled: true, minutes: 30 } } });
    engine.store.audit("engine", "auto_close", { symbol: "AAPL", state: "stop_loss" });
    withParser(engine, [order()]);
    const out = await engine.handleInstruction("卖出 AAPL 10 股", "manual", FRIDAY, {}, ["模拟"]);
    expect(out.submitted).toEqual([]);
    expect(out.validated_only).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("单条输入的订单上限在扇出之前截", () => {
  it("6 笔进两个账户:两个账户各 5 笔,第 6 笔拦一次", async () => {
    const router = new FakeRouter([]);
    const engine = build(router, { policies: { auto_execute: false } });
    const symbols = ["AAPL", "MSFT", "AMZN", "META", "GOOG", "TSLA"];
    withParser(engine, symbols.map((s) => order({ intent_summary: `买入 10 股 ${s}`, contract: { secType: "STK", symbol: s, exchange: "SMART", currency: "USD" }, order: { ...order()["order"], action: "BUY" } })));
    const out = await engine.handleInstruction("一批", "manual", FRIDAY, {}, ["模拟", "主账户"]);
    const perAccount = (alias: string) => out.validated_only.filter((o) => o.account === alias).length;
    expect(perAccount("模拟")).toBe(5);
    expect(perAccount("主账户")).toBe(0 + out.validated_only.filter((o) => o.account === "主账户").length);
    const capped = out.rejections.filter((r) => r.code === "EXCEEDS_LIMIT");
    expect(capped).toHaveLength(1);
    expect(capped[0]?.message).toContain("第 6 位");
    expect(out.validated_only.every((o) => !String(o.intent_summary).includes("TSLA"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
class RpcRouter extends FakeRouter {}

const servers: RpcServer[] = [];
function makeServer(rows: Rec[]): { s: RpcServer; router: RpcRouter; call: (m: string, p?: Rec) => Promise<Rec> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-fix-rpc-"));
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    ...base, policies: { ...base.policies, auto_execute: true }, storage: { db_path: path.join(dir, "t.db") },
  }));
  const s = new RpcServer(settingsPath, () => undefined);
  const router = new RpcRouter(rows);
  s.router = router as never;
  servers.push(s);
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { s, router, call };
}

const ui = (over: Rec): Rec => ({
  key: tk.makeKey("模拟", "BE", "STK"), take_profit: "", stop_loss: "", trail_pct: "", profit_drawdown_pct: "",
  spot_target: "", auto_close: false, order_type: "MKT", host_at_broker: false, ...over,
});
const be = (): Rec => stockRow("BE", { avg_cost: 100, market_price: 120, market_value: 12000, unrealized_pnl: 2000 });

describe("立即平仓:放进托管单那一组,绝不另发一张组外的单", () => {
  it("只挂着止损的托管追踪:不发组外的单、不撤止损,在同一 OCA 组里挂一张立刻成交价的止盈单", async () => {
    setClock(NOON);
    const { call, router } = makeServer([be()]);
    const added = await call("tracker.add", ui({ stop_loss: "95", auto_close: true, host_at_broker: true }));
    expect(added["error"]).toBeUndefined();
    const id = added["result"]["track"]["id"];
    await call("tracker.reconcile");
    expect(router.placed.map((p) => p.item.kind)).toEqual(["sl"]);

    const out = await call("tracker.close_now", { id });
    expect(out["error"]).toBeUndefined();
    expect(router.sent).toEqual([]);
    expect(router.cancelled).toEqual([]);
    const tp = router.placed.find((p) => p.item.kind === "tp");
    // 现价 120 朝成交方向让 0.3% = 119.64,和止损同一个 OCA 组
    expect(tp).toMatchObject({ oca: router.placed[0]?.oca, item: { action: "SELL", lmt_price: 119.64 } });
    expect(out["result"]["fired"]["reason"]).toContain("一成交券商撤掉组里其余的单");

    // 下一轮对账不会再多挂一张
    await call("tracker.reconcile");
    expect(router.placed.filter((p) => p.item.kind === "tp")).toHaveLength(1);
  });

  it("上一张平仓单还挂着没有终态:再点拒绝,不发第二张", async () => {
    setClock(NOON);
    const { call, router } = makeServer([be()]);
    const id = (await call("tracker.add", ui({ stop_loss: "95" })))["result"]["track"]["id"];
    expect((await call("tracker.close_now", { id }))["error"]).toBeUndefined();
    expect(router.sent).toHaveLength(1);
    const err = (await call("tracker.close_now", { id }))["error"];
    expect(err["code"]).toBe(-32019);
    expect(err["message"]).toContain("还挂在券商侧");
    expect(router.sent).toHaveLength(1);
  });

  it("拼不出平仓单的结构:开自动平仓 / 托管当场拒,只能提醒", async () => {
    setClock(NOON);
    const odd = stockRow("BE", { avg_cost: 100, market_price: 120, contract: { secType: "STK", symbol: "b e!" } });
    const { call } = makeServer([odd]);
    const err = (await call("tracker.add", ui({ stop_loss: "95", auto_close: true })))["error"];
    expect(err?.["code"]).toBe(-32602);
    expect((await call("tracker.add", ui({ stop_loss: "95" })))["error"]).toBeUndefined();
  });
});

describe("熔断先合闸,再排队撤单", () => {
  it("一轮盯盘还占着锁:按下熔断那一刻闸就合上了,不等那一轮跑完", async () => {
    const { s, call } = makeServer([]);
    const engine = (s as unknown as { engine: TradingEngine }).engine;
    let release: () => void = () => undefined;
    const holding = engine.withTrackerLock(() => new Promise<void>((r) => { release = r; }));
    const halted = call("breaker.halt", { reason: "测试" });
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.killswitch.state()).toMatchObject({ engaged: true, auto: false });
    release();
    await holding;
    expect((await halted)["result"]).toMatchObject({ engaged: true });
  });
});
