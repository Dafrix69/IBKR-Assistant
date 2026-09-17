/** 保护规则:接连止损 / 回撤过大 / 同标的冷却,暂停自动执行(思路来自 freqtrade 的 Protections)。
 *
 * 盯的是三件事:
 *  · 规则本身算得对(窗口、阈值、到点自动解除、两条同时触发听更保守的);
 *  · 挡下来的单**不落终态**——保护期过了原样再发一次就行;
 *  · **永远不挡平仓**。保护期内持仓追踪照样发平仓单——挡住平仓等于让持仓裸奔。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { EtNow } from "../src/config.js";
import { fromDict } from "../src/config.js";
import { TradingEngine } from "../src/engine.js";
import { Notifier } from "../src/notify.js";
import * as tk from "../src/tracker.js";
import {
  evaluateProtections, isStopLike, protectionBlock, protectionsSummary,
  type ProtectionsConfig,
} from "../src/protections.js";
import { LLMResponse } from "../src/providers.js";
import { TradeStore } from "../src/store.js";
import { loadGolden, makeSettings } from "./util.js";

const gc = loadGolden("config");
const FRIDAY: EtNow = { epochMs: 0, date: "2026-08-14", minutes: 10 * 60 + 32, seconds: 0 };
const NOW = Date.parse("2026-09-18T14:00:00+00:00");
const MIN = 60_000;

type Rec = Record<string, any>;

function cfg(over: Rec = {}): ProtectionsConfig {
  return fromDict({ ...structuredClone(gc.base_config), protections: over }).protections;
}

function close(minutesAgo: number, state: string, symbol = "AAPL") {
  return { atMs: NOW - minutesAgo * MIN, symbol, state };
}

// ---------------------------------------------------------------- 规则本身
describe("止损护栏:窗口内止损够次数就暂停,到点自己解除", () => {
  const guard = { stoploss_guard: { enabled: true, lookback_minutes: 120, trigger_count: 3, pause_minutes: 60 } };

  it("窗口内 3 次止损 → 从最后一次算起停 60 分钟", () => {
    const closes = [close(100, "stop_loss"), close(60, "stop_loss"), close(30, "stop_loss")];
    const state = evaluateProtections(cfg(guard), closes, [], NOW);
    expect(state.pause?.rule).toBe("stoploss_guard");
    expect(state.pause?.untilMs).toBe(NOW - 30 * MIN + 60 * MIN);
    expect(protectionBlock(state, "AAPL", NOW)).toContain("止损 3 次");
  });

  it("差一次不算;窗口外的那次不算", () => {
    expect(evaluateProtections(cfg(guard), [close(10, "stop_loss"), close(5, "stop_loss")], [], NOW).pause).toBeNull();
    const old = [close(200, "stop_loss"), close(180, "stop_loss"), close(5, "stop_loss")];
    expect(evaluateProtections(cfg(guard), old, [], NOW).pause).toBeNull();
  });

  it("止盈不算——赚着钱离场不是「今天不顺」", () => {
    const wins = [close(30, "take_profit"), close(20, "take_profit"), close(10, "take_profit")];
    expect(evaluateProtections(cfg(guard), wins, [], NOW).pause).toBeNull();
  });

  it("跟踪止损与利润回撤算;追价平仓的 sweep: 前缀按后缀认", () => {
    expect(isStopLike("stop_loss")).toBe(true);
    expect(isStopLike("profit_trail")).toBe(true);
    expect(isStopLike("sweep:stop_loss")).toBe(true);
    expect(isStopLike("take_profit")).toBe(false);
    expect(isStopLike("sweep:take_profit")).toBe(false);
  });

  it("暂停到点自动解除:不写状态文件,也不用人工解除", () => {
    const closes = [close(200, "stop_loss"), close(190, "stop_loss"), close(185, "stop_loss")];
    const state = evaluateProtections(cfg({
      stoploss_guard: { enabled: true, lookback_minutes: 600, trigger_count: 3, pause_minutes: 60 },
    }), closes, [], NOW);
    expect(state.pause).toBeNull(); // 最后一次止损在 185 分钟前,60 分钟的暂停早过去了
  });

  it("关着就什么都不算", () => {
    const closes = [close(30, "stop_loss"), close(20, "stop_loss"), close(10, "stop_loss")];
    expect(evaluateProtections(cfg(), closes, [], NOW).pause).toBeNull();
  });
});

describe("回撤护栏:已实现盈亏从峰值回落够多就暂停", () => {
  const dd = { max_drawdown: { enabled: true, lookback_minutes: 1440, max_drawdown_usd: 500.0, pause_minutes: 120 } };

  it("赚 800 再亏 600 → 回撤 600 超阈值,从最低点算起停 120 分钟", () => {
    const pnl = [
      { atMs: NOW - 60 * MIN, pnl: 800 },
      { atMs: NOW - 30 * MIN, pnl: -400 },
      { atMs: NOW - 20 * MIN, pnl: -200 },
    ];
    const state = evaluateProtections(cfg(dd), [], pnl, NOW);
    expect(state.pause?.rule).toBe("max_drawdown");
    expect(state.pause?.untilMs).toBe(NOW - 20 * MIN + 120 * MIN);
    expect(state.pause?.reason).toContain("600.00");
  });

  it("一路亏但没有峰值可回撤:0 起步算,亏 600 就是回撤 600", () => {
    const pnl = [{ atMs: NOW - 10 * MIN, pnl: -600 }];
    expect(evaluateProtections(cfg(dd), [], pnl, NOW).pause?.rule).toBe("max_drawdown");
  });

  it("回撤没到阈值不动", () => {
    const pnl = [{ atMs: NOW - 60 * MIN, pnl: 800 }, { atMs: NOW - 30 * MIN, pnl: -300 }];
    expect(evaluateProtections(cfg(dd), [], pnl, NOW).pause).toBeNull();
  });
});

describe("冷却期:按标的算,不影响别的标的", () => {
  const cool = { cooldown: { enabled: true, minutes: 30 } };

  it("刚平过的那只挡住,别的放行", () => {
    const state = evaluateProtections(cfg(cool), [close(10, "take_profit", "AAPL")], [], NOW);
    expect(protectionBlock(state, "AAPL", NOW)).toContain("冷却");
    expect(protectionBlock(state, "NVDA", NOW)).toBeNull();
  });

  it("过了冷却期自己放行", () => {
    const state = evaluateProtections(cfg(cool), [close(31, "stop_loss", "AAPL")], [], NOW);
    expect(protectionBlock(state, "AAPL", NOW)).toBeNull();
  });

  it("同一只平了两次,按最近那次算", () => {
    const closes = [close(25, "stop_loss", "AAPL"), close(5, "take_profit", "AAPL")];
    const state = evaluateProtections(cfg(cool), closes, [], NOW);
    expect(state.cooldowns["AAPL"]?.untilMs).toBe(NOW - 5 * MIN + 30 * MIN);
  });
});

describe("两条规则同时触发", () => {
  it("听解除得最晚的那条:都说该停,就按更保守的来", () => {
    const both = {
      stoploss_guard: { enabled: true, lookback_minutes: 120, trigger_count: 2, pause_minutes: 30 },
      max_drawdown: { enabled: true, lookback_minutes: 1440, max_drawdown_usd: 100.0, pause_minutes: 240 },
    };
    const closes = [close(20, "stop_loss"), close(10, "stop_loss")];
    const pnl = [{ atMs: NOW - 10 * MIN, pnl: -300 }];
    const state = evaluateProtections(cfg(both), closes, pnl, NOW);
    expect(state.pause?.rule).toBe("max_drawdown");
  });

  it("给界面的摘要带上解除时刻与冷却中的标的", () => {
    const both = {
      stoploss_guard: { enabled: true, lookback_minutes: 120, trigger_count: 2, pause_minutes: 30 },
      cooldown: { enabled: true, minutes: 30 },
    };
    const closes = [close(20, "stop_loss", "AAPL"), close(10, "stop_loss", "NVDA")];
    const summary = protectionsSummary(evaluateProtections(cfg(both), closes, [], NOW), NOW);
    expect(summary["paused"]).toBe(true);
    expect(summary["rule"]).toBe("stoploss_guard");
    expect(summary["until_ms"]).toBe(NOW - 10 * MIN + 30 * MIN);
    expect((summary["cooldowns"] as Rec[]).map((c) => c["symbol"])).toEqual(["AAPL", "NVDA"]);
  });
});

// ---------------------------------------------------------------- 配置
describe("配置", () => {
  it("默认全关:老配置升级上来,行为一字不变", () => {
    const p = cfg();
    expect([p.stoploss_guard.enabled, p.max_drawdown.enabled, p.cooldown.enabled]).toEqual([false, false, false]);
    expect(p.stoploss_guard.trigger_count).toBe(3);
  });

  it("写错了当场报出来,不是默默按默认值跑", () => {
    expect(() => cfg({ stoploss_gaurd: { enabled: true } })).toThrow(/protections 里有未知配置项/);
    expect(() => cfg({ cooldown: { enabled: "true" } })).toThrow(/必须是 true\/false/);
    expect(() => cfg({ cooldown: { minutes: 0 } })).toThrow(/protections\.cooldown\.minutes/);
  });
});

// ---------------------------------------------------------------- 接进引擎
function stockOrder(over: Rec = {}): Rec {
  return {
    intent_summary: "限价 230 买入 100 股 AAPL",
    contract: { secType: "STK", symbol: "AAPL", exchange: "SMART", currency: "USD" },
    execution_type: "IMMEDIATE", trigger: null, account: "DEFAULT",
    order: {
      action: "BUY", orderType: "LMT", totalQuantity: 100,
      price_mode: "EXPLICIT", lmtPrice: 230.0, tif: "DAY", outsideRth: false,
    },
    reason: "回调到位", confidence: 0.99, warnings: [], ...over,
  };
}

class FakeRouter {
  placed: Array<{ recordId: string; approved: any }> = [];
  BROKER = "ibkr";
  SUPPORTS_HOSTED_CLOSE = false;
  SUPPORTS_NATIVE_CONDITIONS = true;
  indexPrice(): number | null { return null; }
  async place(recordId: string, approved: any, limitOverride: number | null = null) {
    this.placed.push({ recordId, approved });
    return {
      record_id: recordId, order_id: 1024, perm_id: 7788, status: "Submitted",
      limit_price: limitOverride, detail: {},
    };
  }
  async legQuotes() { return []; }
  async positions() { return []; }
}

function build(protections: Rec) {
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-protect-"));
  const settings = makeSettings(gc.base_config, {
    storage: { db_path: path.join(dir, "p.db") },
    policies: { auto_execute: true, allow_live_trading: true },
    protections,
  });
  const parser = {
    async parse(): Promise<LLMResponse> {
      return new LLMResponse(
        JSON.stringify({ orders: [stockOrder()], rejections: [] }), "claude-opus-5", "v", "f", 42,
      );
    },
  };
  const router = new FakeRouter();
  const engine = new TradingEngine({
    settings, parser: parser as any, store: new TradeStore(settings.db_path),
    notifier: new Notifier(false), router: router as any,
  });
  return { engine, router };
}

/** 往库里写 n 次止损平仓的痕(引擎平仓时写的就是这一条)。 */
function recordStops(engine: TradingEngine, n: number, symbol = "AAPL"): void {
  for (let i = 0; i < n; i += 1) {
    engine.store.audit("engine", "auto_close", { track: `t${i}`, symbol, state: "stop_loss" });
  }
}

describe("接进引擎:挡新单,不挡平仓", () => {
  const guard = { stoploss_guard: { enabled: true, lookback_minutes: 120, trigger_count: 2, pause_minutes: 60 } };

  it("保护期内的新单停在「仅校验未发送」:没发出去,也没落终态", async () => {
    const { engine, router } = build(guard);
    recordStops(engine, 2);

    const result = await engine.handleInstruction("买入 AAPL 100股 limit 230", "manual", FRIDAY);
    expect(router.placed).toHaveLength(0);
    expect(result.validated_only).toHaveLength(1);

    const record = engine.store.listRecords(5)[0]!;
    expect(record["final_status"] ?? null).toBeNull();     // 不判死:保护期过了还能再发
    expect(JSON.stringify(record["post_warnings"])).toContain("保护规则拦下");
  });

  it("没触发保护时照常发单", async () => {
    const { engine, router } = build(guard);
    recordStops(engine, 1); // 差一次
    await engine.handleInstruction("买入 AAPL 100股 limit 230", "manual", FRIDAY);
    expect(router.placed).toHaveLength(1);
  });

  it("平仓不受保护规则约束——挡住平仓等于让持仓裸奔", async () => {
    const { engine, router } = build(guard);
    recordStops(engine, 5);
    expect(engine.protectionState().pause).not.toBeNull();

    const track = engine.store.addTrack({
      account: "模拟", symbol: "AAPL", sec_type: "STK",
      contract: { secType: "STK", symbol: "AAPL", exchange: "SMART", currency: "USD" },
      targets: { stop_loss: 160.0 }, auto_close: { enabled: true },
    });
    const position = tk.makePosition({
      account: "模拟", symbol: "AAPL", sec_type: "STK", quantity: 100, avg_cost: 180,
      multiplier: 1, market_price: 155, market_value: 15500, unrealized_pnl: -2500,
    });
    const fired = await engine.closePosition(
      track, position, tk.makeAutoClose({ enabled: true }),
      { state: tk.STATE_STOP_LOSS, price: 155, reason: "止损" }, "regular",
    );
    expect(fired).not.toBeNull();
    expect(router.placed).toHaveLength(1); // 平仓单照发
  });

  it("冷却中的标的挡住,别的标的照发", async () => {
    const { engine, router } = build({ cooldown: { enabled: true, minutes: 30 } });
    engine.store.audit("engine", "auto_close", { track: "t", symbol: "NVDA", state: "take_profit" });

    await engine.handleInstruction("买入 AAPL 100股 limit 230", "manual", FRIDAY);
    expect(router.placed).toHaveLength(1); // AAPL 不在冷却里
  });

  it("三条规则都关着 → 一次库都不查", async () => {
    const { engine } = build({});
    let queried = 0;
    const real = engine.store.recentCloses.bind(engine.store);
    engine.store.recentCloses = (...args: Parameters<typeof real>) => { queried += 1; return real(...args); };
    expect(engine.protectionState().pause).toBeNull();
    expect(queried).toBe(0);
  });
});
