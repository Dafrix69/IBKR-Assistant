/** 按勾选账户同时发单:一条指令 → 每个勾选账户各一份订单,各自独立校验、落库、下单。
 *
 * 行为规格 = Python `tests/test_engine.py` 里的 test_fanout_* 五条。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { EtNow } from "../src/config.js";
import { TradingEngine, fanOutOrders, resolveFanoutAccounts } from "../src/engine.js";
import { Notifier } from "../src/notify.js";
import { LLMResponse } from "../src/providers.js";
import { TradeStore } from "../src/store.js";
import { loadGolden, makeSettings } from "./util.js";

const gc = loadGolden("config");
const FRIDAY: EtNow = { epochMs: 0, date: "2026-08-14", minutes: 10 * 60 + 32, seconds: 0 };

function stockOrder(overrides: Record<string, any> = {}): Record<string, any> {
  return {
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
    ...overrides,
  };
}

class FakeRouter {
  placed: Array<{ recordId: string; approved: any }> = [];
  BROKER = "ibkr";
  indexPrice(): number | null { return null; }
  async place(recordId: string, approved: any, limitOverride: number | null = null) {
    this.placed.push({ recordId, approved });
    return {
      record_id: recordId, order_id: 1024, perm_id: 7788, status: "Submitted",
      limit_price: limitOverride, detail: {},
    };
  }
  async legQuotes() { return []; }
}

function build(orders: Record<string, any>[], policies: Record<string, any> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-fanout-"));
  const settings = makeSettings(gc.base_config, {
    storage: { db_path: path.join(dir, "f.db") },
    policies,
  });
  const calls: string[] = [];
  const parser = {
    async parse(_bundle: any, userMessage: string): Promise<LLMResponse> {
      calls.push(userMessage);
      return new LLMResponse(
        JSON.stringify({ orders, rejections: [] }), "claude-opus-5", "v", "f", 42,
      );
    },
  };
  const router = new FakeRouter();
  const engine = new TradingEngine({
    settings, parser: parser as any, store: new TradeStore(settings.db_path),
    notifier: new Notifier(false), router: router as any,
  });
  return { engine, router, calls };
}

describe("fanout: 勾选账户同时发单", () => {
  it("勾两个账户 → 每笔各发一份,两条独立记录", async () => {
    const { engine, router } = build([stockOrder()], { auto_execute: true, allow_live_trading: true });
    const result = await engine.handleInstruction(
      "买入 AAPL 100股 limit 230", "manual", FRIDAY, {}, ["模拟", "主账户"],
    );
    expect(result.submitted.map((s) => s.account)).toEqual(["模拟", "主账户"]);
    expect(result.rejections).toEqual([]);
    expect(router.placed).toHaveLength(2);
    expect(new Set(router.placed.map((p) => p.approved.account.account_id)))
      .toEqual(new Set(["DU7654321", "U1234567"]));
    expect(result.warnings.some((w) => w.includes("同时发单"))).toBe(true);
    const aliases = engine.store.listRecords(10).map((r: any) => r.account.alias).sort();
    expect(aliases).toEqual(["主账户", "模拟"]);
  });

  it("实盘闸门按每一份单独生效", async () => {
    const { engine } = build([stockOrder()]);
    const result = await engine.handleInstruction(
      "买入 AAPL 100股 limit 230", "manual", FRIDAY, {}, ["模拟", "主账户"],
    );
    expect(result.validated_only.map((v) => v.account)).toEqual(["模拟"]);
    expect(result.rejections.map((r) => r.code)).toEqual(["LIVE_TRADING_DISABLED"]);
  });

  it("只勾一个账户 → DEFAULT 改指向它;指令里点名的账户原样保留", async () => {
    const { engine } = build([stockOrder(), stockOrder({ account: "主账户" })]);
    const result = await engine.handleInstruction(
      "买入 AAPL 100股 limit 230", "manual", FRIDAY, {}, ["模拟"],
    );
    expect(result.validated_only.map((v) => v.account)).toEqual(["模拟"]);
    expect(result.rejections.map((r) => r.code)).toEqual(["LIVE_TRADING_DISABLED"]);
    expect(result.warnings.some((w) => w.includes("同时发单"))).toBe(false);
  });

  it("单次输入上限按账户数放大:3 笔 × 2 账户 = 6 笔不被 5 拦住", async () => {
    const orders = ["AAPL", "MSFT", "NVDA"].map((sym) => stockOrder({
      intent_summary: `买 ${sym}`,
      contract: { secType: "STK", symbol: sym, exchange: "SMART", currency: "USD" },
    }));
    const { engine } = build(orders, { allow_live_trading: true });
    const result = await engine.handleInstruction("三笔不同的单", "manual", FRIDAY, {}, ["模拟", "主账户"]);
    expect(result.rejections.filter((r) => r.code === "EXCEEDS_LIMIT")).toEqual([]);
    expect(result.validated_only).toHaveLength(6);
  });

  it("别名表外的账户在调大模型之前就拒绝", async () => {
    const { engine, calls } = build([stockOrder()]);
    await expect(
      engine.handleInstruction("买入 AAPL 100股 limit 230", "manual", FRIDAY, {}, ["长线"]),
    ).rejects.toThrow("不在别名表中");
    expect(calls).toEqual([]);
  });

  it("纯函数:去重、DEFAULT 保留字、无 DEFAULT 订单时不出说明", () => {
    const settings = makeSettings(gc.base_config, {});
    expect(resolveFanoutAccounts(settings, ["模拟", "模拟", " 主账户 "])).toEqual(["模拟", "主账户"]);
    expect(() => resolveFanoutAccounts(settings, ["DEFAULT"])).toThrow();
    const explicit = stockOrder({ account: "主账户" }) as any;
    const [out, note] = fanOutOrders([explicit], ["模拟", "主账户"]);
    expect(out).toEqual([explicit]);
    expect(note).toBeNull();
  });
});
