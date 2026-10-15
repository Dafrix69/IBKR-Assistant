/** 信息链路的 RPC 层(intel.*)与底账(messageLog.ts)。全部离线:券商是假的(持仓、报价),日历源是假的,消息直接喂。
 *
 * 钉住:
 *  1. 频道里的每一条消息经跟单服务递到信息链路:信任的人说的认标的、取已订着的价、落底账(同一条只落一次),提到持仓的标的推 held_mention;
 *     不信任的人说的不落盘(隐私说明)。
 *  2. intel.feed 合成一条线:消息(带跟单的下场、提到时与此刻的价)、信号、事件(宏观归指数,自定义按标题认)、单子、想法;
 *     按标的 / 种类 / 只看持仓 / 条数筛;没连券商时"此刻的价"是 null、照样给。
 *  3. intel.dossier:现价(指数走 indexPrice;不在订的票给日线收盘)、持仓、追踪、板块、价位、异动、想法、事件、信号条数、时间线。
 *  4. 底账只增不改;代码不合法当场拒。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { DiscordMessage } from "../src/discordGateway.js";
import { RpcServer } from "../src/rpc.js";
import { EventsService } from "../src/services/events.js";
import { IntelService } from "../src/services/intel.js";

type Rec = Record<string, any>;
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 2026-10-13(周二)美东 10:00 */
const NOW = Date.parse("2026-10-13T10:00:00-04:00");
const CHANNEL = "1100000000000000001";
const FRIEND = "220000000000000002";
const STRANGER = "330000000000000003";

const dirs: string[] = [];
const servers: RpcServer[] = [];

class FakeRouter {
  BROKER = "ibkr";
  connected = true;
  rows: Rec[];
  asked: string[][] = [];
  constructor(rows: Rec[]) { this.rows = rows; }
  sessions(): unknown[] { return this.connected ? [{}] : []; }
  async positions(): Promise<Rec[]> { return this.rows.map((r) => ({ ...r })); }
  async indexPrice(symbol: string): Promise<number | null> { return symbol === "SPX" ? 7700 : null; }
  spotInfo(): Rec { return { source: "index" }; }
  async streamQuotes(symbols: string[]): Promise<Record<string, Rec>> {
    this.asked.push([...symbols]);
    const out: Record<string, Rec> = {};
    for (const s of symbols) if (s === "NVDA") out[s] = { last: 185, close: 180, change: 2.78 };
    return out;
  }
  async historicalDaily(): Promise<Rec[]> { return []; }
}

const nvda = (): Rec => ({
  key: "模拟|NVDA|STK", account: "模拟", symbol: "NVDA", sec_type: "STK", leg: "", label: "NVDA", quantity: 100, multiplier: 1, currency: "USD",
  avg_cost: 180, market_price: 185, market_value: 18500, unrealized_pnl: 500, contract: { secType: "STK", symbol: "NVDA" },
});

function makeServer(opts: { rows?: Rec[]; connected?: boolean } = {}): { s: RpcServer; router: FakeRouter; intel: IntelService; events: EventsService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-intel-"));
  dirs.push(root);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(root, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    ...base, storage: { db_path: path.join(root, "t.db") }, follow: { enabled: false, channel_id: CHANNEL, author_ids: [FRIEND] },
  }));
  const s = new RpcServer(settingsPath, () => {});
  servers.push(s);
  const router = new FakeRouter(opts.rows ?? [nvda()]);
  router.connected = opts.connected ?? true;
  if (opts.connected !== false) s.router = router as never;
  // 日历源换成假的(不出网),信息链路换成同一个钟
  const events = new EventsService(s, async () => [], () => NOW);
  (s as unknown as { events: EventsService }).events = events;
  const intel = new IntelService(s, s.market, events, s.anomaly, () => NOW);
  (s as unknown as { intel: IntelService }).intel = intel;
  s.follow.onSeen = (message, trusted) => void intel.record(message, trusted);
  return { s, router, intel, events };
}

let serial = 0;
function message(content: string, patch: { author?: string; ageMs?: number; id?: string; name?: string } = {}): DiscordMessage {
  const sentAtMs = NOW - (patch.ageMs ?? 60_000);
  serial += 1;
  return {
    id: patch.id ?? String(((BigInt(sentAtMs) - 1420070400000n) << 22n) + BigInt(serial)),
    channel_id: CHANNEL, author_id: patch.author ?? FRIEND, author_name: patch.name ?? (patch.author === STRANGER ? "路人" : "老王"), content, sentAtMs,
  };
}


afterEach(() => {
  for (const s of servers.splice(0)) s.engineBuilt?.stopTrackerLoop();
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上 sqlite 句柄可能还占着 */
    }
  }
});

/** 引擎推给界面的事件:RpcServer.emit 写到 out;这里截下来 */
function capture(s: RpcServer): Array<[string, Rec]> {
  const out: Array<[string, Rec]> = [];
  const original = s.emit.bind(s);
  s.emit = (event: string, payload: Rec) => { out.push([event, payload]); original(event, payload); };
  return out;
}

describe("消息落底账", () => {
  it("跟单服务看到的消息递到信息链路:认标的、取已订着的价、落底账;信任的人提到持仓的票推 held_mention", async () => {
    const { s, intel } = makeServer();
    const events = capture(s);
    await intel.record(message("@everyone 7700 7725 bear call -2 -2.5"), true);
    await intel.record(message("英伟达 要涨了 $AAPL 也看看 TQQQ 怎么样", { name: "老王" }), true);
    await intel.record(message("AAPL 不错", { author: STRANGER }), false); // 不信任的人说的不落盘(隐私说明)
    const rows = s.engine.store.messages.recent({ limit: 10 });
    expect(rows.map((r) => [r.symbols, r.guesses, r.trusted, r.prices])).toEqual([
      [["NVDA", "AAPL"], ["TQQQ"], true, { NVDA: 185 }],   // AAPL 没在订着:不另开行情线路,没有价
      [["SPX"], [], true, { SPX: 7700 }],
    ]);
    expect(rows[1]!.source).toBe("discord");
    const intelEvents = events.filter(([e]) => e === "intel").map(([, p]) => p);
    expect(intelEvents.map((p) => p["kind"])).toEqual(["message", "held_mention"]);
    expect(intelEvents[1]).toMatchObject({ symbols: ["NVDA"], author_name: "老王", prices: { NVDA: 185 } });
  });

  it("走跟单服务那条路也到:onMessage → onSeen → 底账;同一条消息只落一次", async () => {
    const { s } = makeServer();
    const m = message("今天 CPI 前先别开仓");
    await s.follow.onMessage(m);
    await s.follow.onMessage(m);
    for (let i = 0; i < 50 && s.engine.store.messages.count() === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(s.engine.store.messages.count()).toBe(1);
    await s.intel.record(m, true);
    expect(s.engine.store.messages.count()).toBe(1);
  });

  it("底账只增不改", async () => {
    const { s, intel } = makeServer();
    await intel.record(message("随便说说"), true);
    const db = (s.engine.store as unknown as { db: { prepare(sql: string): { run(): unknown } } }).db;
    expect(() => db.prepare("UPDATE message_log SET text = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM message_log").run()).toThrow(/append-only/);
  });
});

async function seed(s: RpcServer, intel: IntelService, events: EventsService): Promise<{ bearCall: DiscordMessage; nvdaMsg: DiscordMessage }> {
  const bearCall = message("@everyone 7700 7725 bear call -2 -2.5", { ageMs: 5 * 60_000 });
  const nvdaMsg = message("英伟达 今天看涨", { ageMs: 3 * 60_000 });
  await intel.record(bearCall, true);
  await intel.record(nvdaMsg, true);
  const store = s.engine.store;
  store.follow.add({
    at: new Date(NOW - 5 * 60_000).toISOString(), message_id: bearCall.id, author_id: FRIEND, author_name: "老王", text: bearCall.content,
    outcome: "observed", detail: "只观察:跟单开关关着", summary: "卖出 1 张 SPX 7700/7725 bear call", record_ids: [],
  });
  store.signals.log([{ at: new Date(NOW - 20 * 60_000).toISOString(), source: "cross", symbol: "NVDA", expect: "up", price: 184, label: "上穿 20日线" }]);
  store.signals.log([{ at: new Date(NOW - 25 * 60_000).toISOString(), source: "rvol", symbol: "TSLA", expect: null, price: 250, label: "全天放量 3×" }]);
  const filled = store.createRecord({
    created_at: new Date(NOW - 40 * 60_000).toISOString(),
    contract: { secType: "STK", symbol: "NVDA" }, order: { action: "BUY", totalQuantity: 100 }, account: { alias: "模拟", account_id: "DU1" },
    llm: { intent_summary: "限价 184 买入 100 股 NVDA" }, input: { raw_instruction: "英伟达 184 买 100 股", input_channel: "ui" },
  });
  store.appendEvent(filled, "status", { status: "Submitted" });
  store.appendEvent(filled, "fill", { exec_id: "e1", price: 184, qty: 100 });
  store.appendEvent(filled, "final", { final_status: "filled" });
  store.createRecord({
    created_at: new Date(NOW - 50 * 60_000).toISOString(),
    contract: { secType: "STK", symbol: "TSLA" }, order: { action: "SELL", totalQuantity: 10 }, account: { alias: "模拟", account_id: "DU1" },
    llm: { intent_summary: "市价卖出 10 股 TSLA" }, input: { raw_instruction: "特斯拉 市价卖 10 股", input_channel: "ui" },
  });
  store.addIdea("NVDA 回调到 180 想买", ["NVDA"]);
  store.addIdea("苹果 新机发布前观察", []);
  events.add({ title: "NVDA 财报", date_et: "2026-10-14", time_et: "16:05", note: "盘后" });
  return { bearCall, nvdaMsg };
}

describe("intel.feed", () => {
  it("合成一条线:消息带跟单的下场与提到时 / 此刻的价,信号、事件、单子、想法各一种;和持仓有关的标出来", async () => {
    const { s, intel, events } = makeServer();
    const { bearCall, nvdaMsg } = await seed(s, intel, events);
    const res = (await s.call("intel.feed", {})) as Rec;
    expect(res["held"]).toEqual(["NVDA"]);
    expect(res["connected"]).toBe(true);
    expect(res["total_messages"]).toBe(2);
    const items = res["items"] as Rec[];
    const byId = (id: string) => items.find((i) => i["id"] === id)!;
    // 新的在前
    expect(items.map((i) => i["at"])).toEqual([...items.map((i) => i["at"])].sort((a, b) => b - a));
    const m1 = byId(`message:${bearCall.id}`);
    expect(m1).toMatchObject({
      kind: "message", symbols: ["SPX"], held: [], source: "老王", trusted: true, outcome: "observed", instruction: "7700 7725 bear call -2 -2.5",
      move: { symbol: "SPX", then: 7700, now: 7700, pct: 0 }, tone: "info",
    });
    expect(m1["body"]).toContain("只观察");
    const m2 = byId(`message:${nvdaMsg.id}`);
    expect(m2).toMatchObject({ symbols: ["NVDA"], held: ["NVDA"], move: { symbol: "NVDA", then: 185, now: 185, pct: 0 } });
    expect("outcome" in m2).toBe(false);
    expect("instruction" in m2).toBe(false);
    const signal = items.find((i) => i["kind"] === "signal" && i["symbols"][0] === "NVDA")!;
    expect(signal).toMatchObject({ held: ["NVDA"], title: "NVDA 上穿 20日线", tone: "up", source: "cross" });
    expect(signal["body"]).toContain("价位穿越");
    const rvol = items.find((i) => i["kind"] === "signal" && i["symbols"][0] === "TSLA")!;
    expect(rvol).toMatchObject({ tone: "info", held: [] });
    const macro = items.filter((i) => i["kind"] === "event" && i["source"] !== "custom");
    expect(macro.map((i) => i["title"])).toEqual(["将公布:PPI(9月)", "将公布:CPI(9月)"]);
    expect(macro.every((i) => i["symbols"][0] === "SPX")).toBe(true);
    expect(macro[1]).toMatchObject({ tone: "warn" }); // 24 小时之内的高影响事件
    const custom = items.find((i) => i["kind"] === "event" && i["source"] === "custom")!;
    expect(custom).toMatchObject({ symbols: ["NVDA"], held: ["NVDA"], title: "将公布:NVDA 财报" });
    expect(custom["body"]).toContain("盘后");
    const order = items.find((i) => i["kind"] === "order" && i["symbols"][0] === "NVDA")!;
    expect(order).toMatchObject({ title: "限价 184 买入 100 股 NVDA", body: "已成交 · 均价 184", tone: "up", source: "模拟", held: ["NVDA"] });
    const sell = items.find((i) => i["kind"] === "order" && i["symbols"][0] === "TSLA")!;
    expect(sell).toMatchObject({ body: "仅校验", tone: "down" });
    const ideas = items.filter((i) => i["kind"] === "idea");
    expect(ideas.map((i) => i["symbols"])).toEqual(expect.arrayContaining([["NVDA"], ["AAPL"]])); // 「苹果」从原文里认出来
  });

  it("筛:按标的、按种类、只看持仓、条数", async () => {
    const { s, intel, events } = makeServer();
    await seed(s, intel, events);
    const spx = (await s.call("intel.feed", { symbol: "spx" })) as Rec;
    expect((spx["items"] as Rec[]).every((i) => (i["symbols"] as string[]).includes("SPX"))).toBe(true);
    expect((spx["items"] as Rec[]).map((i) => i["kind"]).sort()).toEqual(["event", "event", "message"]);
    const msgs = (await s.call("intel.feed", { kinds: ["message"] })) as Rec;
    expect((msgs["items"] as Rec[]).map((i) => i["kind"])).toEqual(["message", "message"]);
    const mine = (await s.call("intel.feed", { held_only: true })) as Rec;
    expect((mine["items"] as Rec[]).every((i) => (i["held"] as string[]).includes("NVDA"))).toBe(true);
    expect((mine["items"] as Rec[]).map((i) => i["kind"]).sort()).toEqual(["event", "idea", "message", "order", "signal"]);
    const two = (await s.call("intel.feed", { limit: 2 })) as Rec;
    expect((two["items"] as Rec[]).length).toBe(2);
    await expect(s.call("intel.feed", { symbol: "bad symbol" })).rejects.toMatchObject({ code: -32602, message: "股票代码不合法" });
  });

  it("没连券商:照样给时间线,持仓是空、此刻的价是 null", async () => {
    const { s, intel, events } = makeServer({ connected: false });
    await seed(s, intel, events);
    const res = (await s.call("intel.feed", {})) as Rec;
    expect(res["connected"]).toBe(false);
    expect(res["held"]).toEqual([]);
    const msg = (res["items"] as Rec[]).find((i) => i["kind"] === "message" && i["symbols"][0] === "NVDA")!;
    expect("move" in msg).toBe(false); // 没连券商时记底账也取不到价,所以连"提到时"都没有
    expect(msg["held"]).toEqual([]);
  });
});

describe("intel.dossier", () => {
  it("一只持仓的票:现价与涨跌、持仓、板块、价位、异动、想法、事件、信号条数、七天提到几次、时间线", async () => {
    const { s, intel, events } = makeServer();
    await seed(s, intel, events);
    const store = s.engine.store;
    const sector = store.addSector("半导体");
    store.setSectorStocks(sector.id, [{ symbol: "NVDA", tag: "" }]);
    // 股票池的两个开关:盯价位、盯异动(界面上走 pool.set_watch,这里直接写库)
    store.addWatch("NVDA", 5);
    store.addQualityStock("NVDA");
    const d = (await s.call("intel.dossier", { symbol: "nvda" })) as Rec;
    expect(d["symbol"]).toBe("NVDA");
    expect(d["held"]).toBe(true);
    expect(d["quote"]).toEqual({ price: 185, change_pct: null, source: "quote" }); // 异动循环没跑,没有较昨收的涨跌
    expect((d["positions"] as Rec[]).map((p) => p["quantity"])).toEqual([100]);
    expect(d["sectors"]).toEqual(["半导体"]);
    expect(d["watch"]).toMatchObject({ enabled: true });
    expect(d["quality"]).toMatchObject({ enabled: true, events: [] });
    expect((d["ideas"] as Rec[]).map((i) => i["text"])).toEqual(["NVDA 回调到 180 想买"]);
    expect((d["events"] as Rec[]).map((e) => e["title"])).toEqual(["NVDA 财报"]);
    expect(d["signals"]).toEqual([{ source: "cross", n: 1, last_at: new Date(NOW - 20 * 60_000).toISOString() }]);
    expect(d["mentions_7d"]).toBe(1);
    expect((d["timeline"] as Rec[]).every((i) => (i["symbols"] as string[]).includes("NVDA"))).toBe(true);
    expect((d["timeline"] as Rec[]).map((i) => i["kind"]).sort()).toEqual(["event", "idea", "message", "order", "signal"]);
  });

  it("指数:现价走 indexPrice,事件是全部宏观事件;没持仓的票给日线收盘、不另开行情;代码不合法当场拒", async () => {
    const { s, intel, events, router } = makeServer();
    await seed(s, intel, events);
    const spx = (await s.call("intel.dossier", { symbol: "SPX" })) as Rec;
    expect(spx["quote"]).toEqual({ price: 7700, change_pct: null, source: "index" });
    expect(spx["held"]).toBe(false);
    expect((spx["events"] as Rec[]).map((e) => e["title"])).toEqual(["CPI(9月)", "PPI(9月)"]);
    const asked = router.asked.length;
    const tsla = (await s.call("intel.dossier", { symbol: "TSLA" })) as Rec;
    expect(tsla["quote"]).toBeNull(); // 假券商没有日线;要紧的是没为它订行情
    expect(router.asked.length).toBe(asked);
    expect((tsla["timeline"] as Rec[]).map((i) => i["kind"]).sort()).toEqual(["order", "signal"]);
    await expect(s.call("intel.dossier", { symbol: "" })).rejects.toMatchObject({ code: -32602 });
  });

  it("没连券商:档案照给,只是没有现价与持仓", async () => {
    const { s, intel, events } = makeServer({ connected: false });
    await seed(s, intel, events);
    const d = (await s.call("intel.dossier", { symbol: "NVDA" })) as Rec;
    expect(d).toMatchObject({ quote: null, held: false, positions: [], connected: false });
    expect((d["timeline"] as Rec[]).length).toBeGreaterThan(0);
  });

  it("券商没报盈亏:有现价就按追踪器的口径本地算(和持仓追踪页一样),没现价照旧空着", async () => {
    const unpriced = { ...nvda(), key: "模拟|NVDA|OPT|x", sec_type: "OPT", market_price: null, market_value: null, unrealized_pnl: null };
    const { s } = makeServer({ rows: [{ ...nvda(), market_value: null, unrealized_pnl: null }, unpriced] });
    const d = (await s.call("intel.dossier", { symbol: "NVDA" })) as Rec;
    const [stock, option] = d["positions"] as Rec[];
    expect(stock).toMatchObject({ unrealized_pnl: 500, pnl_source: "computed" });
    expect(stock?.["unrealized_pct"]).toBeCloseTo(2.778, 3);
    expect(option).toMatchObject({ unrealized_pnl: null });
    expect(option?.["pnl_source"]).toBeUndefined();
  });
});
