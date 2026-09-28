/** 发单之前先留痕(store.markSubmitIntent):发到一半进程被杀,这张单不能从对账和重复单防抖眼前消失。
 *
 * 事故形状:记录在发单之前建好,第一条状态回报却要等券商回话之后才落。桌面端重启引擎、退出应用、
 * 心跳判死,都会在任意时刻结束引擎进程——正好落在 `await router.place(...)` 中间时,单已经到了券商,
 * 库里这条记录一条状态都没有。对账(listWorkingRecords)与重复单防抖(recentOrders)只认"有过状态回报"的记录:
 * 重启后没人认领这张单,用户看界面上没有,照原样再发一次,也不会被提醒重复——双倍仓位。
 *
 * 这里用"place 永远不回来"模拟进程在发单途中被杀,然后用同一个库另起一个引擎(= 重启)。全部离线。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { EtNow } from "../src/config.js";
import { TradingEngine } from "../src/engine.js";
import { Notifier } from "../src/notify.js";
import { LLMResponse } from "../src/providers.js";
import { TradeStore } from "../src/store.js";
import { loadGolden, makeSettings } from "./util.js";

const gc = loadGolden("config");
const FRIDAY: EtNow = { epochMs: 0, date: "2026-08-14", minutes: 10 * 60 + 32, seconds: 0 };
type Rec = Record<string, any>;

const ORDER = {
  intent_summary: "限价 230 买入 100 股 AAPL",
  contract: { secType: "STK", symbol: "AAPL", exchange: "SMART", currency: "USD" },
  execution_type: "IMMEDIATE",
  trigger: null,
  account: "DEFAULT",
  order: {
    action: "BUY", orderType: "LMT", totalQuantity: 100,
    price_mode: "EXPLICIT", lmtPrice: 230.0, tif: "DAY", outsideRth: false,
  },
  reason: "回调到位",
  confidence: 0.99,
  warnings: [],
};

class Router {
  BROKER = "ibkr";
  SUPPORTS_NATIVE_CONDITIONS = true;
  openRows: Rec[] = [];
  /** 发单那一刻库里是什么样子(由测试填) */
  onPlace: (recordId: string) => void = () => undefined;
  hang = false;
  placed: string[] = [];
  indexPrice(): number | null { return null; }
  async legQuotes(): Promise<unknown[]> { return []; }
  async positions(): Promise<Rec[]> { return []; }
  async listOpenOrdersDetailed(): Promise<Rec[]> { return [...this.openRows]; }
  async listHostedOpen(): Promise<Rec[]> { return []; }
  async cancelAllOpen(): Promise<number> { return 0; }
  sessions(): unknown[] { return []; }
  place(recordId: string): Promise<Rec> {
    this.placed.push(recordId);
    this.onPlace(recordId);
    if (this.hang) return new Promise(() => undefined); // 进程在这里被杀:永远等不到券商回话
    return Promise.resolve({ record_id: recordId, order_id: 1024, perm_id: 7788, status: "Submitted", limit_price: null, detail: {} });
  }
}

function build(dbPath?: string, policies: Rec = { auto_execute: true }) {
  const file = dbPath ?? path.join(mkdtempSync(path.join(tmpdir(), "dafri-intent-")), "i.db");
  const settings = makeSettings(gc.base_config, { storage: { db_path: file }, policies });
  const parser = {
    async parse(): Promise<LLMResponse> {
      return new LLMResponse(JSON.stringify({ orders: [ORDER], rejections: [] }), "claude-opus-5", "v", "f", 42);
    },
  };
  const router = new Router();
  const engine = new TradingEngine({
    settings, parser: parser as any, store: new TradeStore(file), notifier: new Notifier(false), router: router as any,
  });
  return { engine, router, file, settings };
}

const kinds = (store: TradeStore, recordId: string): string[] =>
  (store as unknown as { db: { prepare(sql: string): { all(id: string): Array<{ kind: string }> } } })
    .db.prepare("SELECT kind FROM record_events WHERE record_id = ? ORDER BY seq").all(recordId).map((r) => r.kind);

describe("发单之前先留痕", () => {
  it("券商收到单的那一刻,库里已经认得这条记录:对账看得见,重复单防抖也看得见", async () => {
    const { engine, router } = build();
    const seen: { working: string[]; recent: number } = { working: [], recent: 0 };
    router.onPlace = (recordId) => {
      seen.working = engine.store.listWorkingRecords(7, Date.now()).map((r) => r.id);
      seen.recent = engine.store.recentOrders(10, Date.now()).length;
      expect(kinds(engine.store, recordId)).toContain("submit_intent");
    };
    const result = await engine.handleInstruction("买入 AAPL 100股 limit 230", "manual", FRIDAY, {}, ["模拟"]);
    expect(result.submitted).toHaveLength(1);
    expect(seen.working).toEqual([result.submitted[0]!.record_id]);
    expect(seen.recent).toBe(1);
  });

  it("读记录时这条痕是看不见的:状态时间线一字不多(黄金基线不用动)", async () => {
    const { engine } = build();
    const result = await engine.handleInstruction("买入 AAPL 100股 limit 230", "manual", FRIDAY, {}, ["模拟"]);
    const record = engine.store.getRecord(String(result.submitted[0]!.record_id))!;
    expect((record["ibkr"]["status_timeline"] as Rec[]).map((s) => s["status"])).toEqual(["Submitted"]);
    expect(JSON.stringify(record)).not.toContain("submit_intent");
  });

  it("只校验不发送的记录不留痕:它从没打算发出去", async () => {
    const { engine, router } = build(undefined, { auto_execute: false });
    const result = await engine.handleInstruction("买入 AAPL 100股 limit 230", "manual", FRIDAY, {}, ["模拟"]);
    expect(router.placed).toEqual([]);
    const recordId = String(result.validated_only[0]!.record_id);
    expect(kinds(engine.store, recordId)).not.toContain("submit_intent");
    expect(engine.store.listWorkingRecords(7, Date.now())).toEqual([]);
    expect(engine.store.recentOrders(10, Date.now())).toEqual([]);
  });
});

describe("发单途中进程被杀,重启之后", () => {
  /** 发到一半被杀:返回那条只有痕、没有状态的记录,和它所在的库。 */
  async function killedMidPlace(): Promise<{ file: string; recordId: string }> {
    const { engine, router, file } = build();
    router.hang = true;
    void engine.handleInstruction("买入 AAPL 100股 limit 230", "manual", FRIDAY, {}, ["模拟"]);
    for (let i = 0; i < 200 && !router.placed.length; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(router.placed).toHaveLength(1);
    const recordId = router.placed[0]!;
    // 留了痕,但一条状态回报都没有(校验阶段的提示可以有)
    expect(kinds(engine.store, recordId).filter((k) => k !== "warning")).toEqual(["submit_intent"]);
    engine.store.close(); // 进程没了
    return { file, recordId };
  }

  it("单已经到了券商:对账按 orderRef 认领回来,之后的成交回报落得到这条记录上", async () => {
    const { file, recordId } = await killedMidPlace();
    const { engine, router } = build(file);
    router.openRows = [{ order_ref: recordId, order_id: 1024, perm_id: 7788, status: "Submitted", account: "DU7654321" }];
    const out = await engine.reconcileOrders(Date.now() + 5 * 60_000);
    expect(out.adopted).toBe(1);
    engine.onOrderStatus({ order: { orderId: 1024 }, orderStatus: { status: "Filled", filled: 100, remaining: 0 } });
    expect(engine.store.getRecord(recordId)!["final_status"]).toBe("filled");
  });

  it("券商那边没有这张单:标「去向不明」、说清楚是发单途中中断的,不落终态", async () => {
    const { file, recordId } = await killedMidPlace();
    const { engine } = build(file);
    const notes: string[] = [];
    engine.notifier.sinks.push((_t, _s, body) => notes.push(body));
    const out = await engine.reconcileOrders(Date.now() + 5 * 60_000);
    expect(out.unknown).toBe(1);
    const record = engine.store.getRecord(recordId)!;
    expect((record["ibkr"]["status_timeline"] as Rec[]).map((s) => s["status"])).toEqual(["NotAtBroker"]);
    expect(record["final_status"]).toBeNull();
    expect(notes.join("\n")).toMatch(/发单途中软件中断了.*它多半没有发出去/);
  });

  it("还在宽限期里(刚重启):先不下结论", async () => {
    const { file } = await killedMidPlace();
    const { engine } = build(file);
    const out = await engine.reconcileOrders(Date.now() + 5_000);
    expect(out).toMatchObject({ adopted: 0, filled: 0, unknown: 0 });
  });

  it("照原样再发一次:重复单防抖认得出上一张(以前它根本看不见)", async () => {
    const { file } = await killedMidPlace();
    const { engine } = build(file);
    const recent = engine.store.recentOrders(10, Date.now());
    expect(recent).toHaveLength(1);
    expect(recent[0]!.quantity).toBe(100);
    // 防抖的时间窗按这一次指令的时刻算:给一个"现在"(交易时段照旧是周五盘中)
    const now: EtNow = { ...FRIDAY, epochMs: Date.now() };
    const result = await engine.handleInstruction("买入 AAPL 100股 limit 230", "manual", now, {}, ["模拟"]);
    expect(result.submitted).toEqual([]);
    expect(result.rejections.map((r) => r.code)).toEqual(["DUPLICATE_ORDER"]);
  });
});
