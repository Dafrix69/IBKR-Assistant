/** 跟踪止损 / 利润回撤的全天演练:一整天(美东 04:00–20:00)每 20 秒一轮,走真的节拍入口 trackerTickOnce。
 *
 * 纯函数层(evaluate 的方向、峰值、阈值)别处测得很细;这里要回答的是用户那句「确保一定能触发」——
 * 串起来跑一整天,中间把全天运行真会碰上的事全插进去:
 *  · TWS 断线(读持仓报错)——这段时间引擎什么都看不见,不许误停追踪,更不许发单;
 *  · 某个账户的会话没连上(实盘那台 TWS 晚开 / 重连中)——它的持仓不在列表里,不等于平仓了;
 *  · 某只股拿不到现价——这一轮不判断;
 *  · 引擎实例中途重建(改配置、重连券商都会)——峰值在库里,重建后接着跟,不从现价重新起算。
 *
 * 期望值由测试里一份**独立写的参考模型**给出(只用"看得见的那几轮"推峰值、判触发),
 * 与引擎逐条对:每条追踪恰好触发一次、就在参考模型说的那一轮、方向与数量都对。
 * 价格路径用固定种子生成,多个种子各跑一遍。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { etNowFromEpoch } from "../src/config.js";
import { TradingEngine } from "../src/engine.js";
import { Notifier } from "../src/notify.js";
import { TradeStore } from "../src/store.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");
type Rec = Record<string, any>;

/** 2026-08-14 是周五、非假日:04:00 盘前 → 09:30 盘中 → 16:00 盘后 → 20:00 休市 */
const DAY_START = Date.parse("2026-08-14T04:00:00-04:00");
const STEP_MS = 20_000;
const TICKS = (16 * 3600 * 1000) / STEP_MS; // 2880 轮

interface Spec {
  symbol: string;
  account: "模拟" | "主账户";
  qty: number;
  avg: number;
  start: number;
  targets: Rec;
  /** 独立参考:给定峰值与现价,这一轮该不该触发 */
  fires: (peak: number, price: number) => boolean;
}

const SPECS: Spec[] = [
  { symbol: "AAA", account: "模拟", qty: 100, avg: 50, start: 50, targets: { trail_pct: 3 },
    fires: (pk, p) => p <= pk * 0.97 },
  { symbol: "BBB", account: "模拟", qty: -50, avg: 80, start: 80, targets: { trail_pct: 2 },
    fires: (pk, p) => p >= pk * 1.02 },
  { symbol: "CCC", account: "模拟", qty: 200, avg: 100, start: 100, targets: { profit_drawdown_pct: 30 },
    fires: (pk, p) => (pk - 100) > 0 && (p - 100) <= (pk - 100) * 0.7 },
  { symbol: "DDD", account: "模拟", qty: 10, avg: 30, start: 30, targets: { stop_loss: 27, trail_pct: 5 },
    fires: (pk, p) => p <= Math.max(27, pk * 0.95) },
  // 实盘账户那台 TWS 有一段没连上(见 uncovered):那段时间它的持仓不在列表里
  { symbol: "EEE", account: "主账户", qty: 100, avg: 20, start: 20, targets: { trail_pct: 4 },
    fires: (pk, p) => p <= pk * 0.96 },
  // 空头利润回撤:跌了才赚,涨回去吐掉 40% 利润就平
  { symbol: "FFF", account: "模拟", qty: -300, avg: 40, start: 40, targets: { profit_drawdown_pct: 40 },
    fires: (pk, p) => (40 - pk) > 0 && (40 - p) <= (40 - pk) * 0.6 },
];

/** mulberry32:固定种子的伪随机数,路径可复现 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 一只股的全天路径:先顺着持仓方向走一段(攒出峰值与利润),再反转,一路带噪声、偶尔跳一下。两位小数。
 *  顺势那段的长度随种子变,所以触发时刻会落在盘前、盘中、盘后各处。 */
function pricePath(spec: Spec, seed: number): number[] {
  const r = rng(seed);
  const favourable = spec.qty > 0 ? 1 : -1;
  const trendTicks = 150 + Math.floor(r() * 1800);
  const out: number[] = [];
  let p = spec.start;
  for (let i = 0; i < TICKS; i += 1) {
    const drift = favourable * (i < trendTicks ? 0.0005 : -0.0005);
    const jump = r() < 0.004 ? (r() - 0.5) * 0.06 : 0;
    p = Math.max(0.5, p * (1 + drift + (r() - 0.5) * 0.004 + jump));
    out.push(Math.round(p * 100) / 100);
  }
  return out;
}

/** 这一天的事故表 */
const DISCONNECTS: Array<[number, number]> = [[700, 760], [1900, 1915]]; // TWS 断线:读持仓报错
const UNCOVERED: Array<[number, number]> = [[400, 520]];                  // 实盘那台 TWS 没连上
const NO_QUOTE: Record<string, Array<[number, number]>> = { AAA: [[1200, 1230]] }; // 拿不到现价
const REBUILD_AT = 1500;                                                  // 引擎实例重建
const inAny = (i: number, spans: Array<[number, number]>) => spans.some(([a, b]) => i >= a && i < b);

class AllDayRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  tick = 0;
  /** symbol → 这一轮的价;null = 拿不到 */
  prices: Record<string, number | null> = {};
  /** 已经平掉的:下一轮起不在持仓里 */
  closed = new Set<string>();
  placed: Array<{ tick: number; approved: Rec }> = [];
  constructor(private readonly specs: Spec[]) {}

  private down(): boolean { return inAny(this.tick, DISCONNECTS); }

  coveredAccounts(): Set<string> {
    if (this.down()) return new Set();
    return inAny(this.tick, UNCOVERED) ? new Set(["模拟"]) : new Set(["模拟", "主账户"]);
  }

  async positions(): Promise<Rec[]> {
    if (this.down()) throw new Error("与 TWS 的连接(paper、live)已断开,正在自动重连;这一轮读不到持仓");
    const covered = this.coveredAccounts();
    return this.specs
      .filter((s) => covered.has(s.account) && !this.closed.has(s.symbol))
      .map((s) => ({
        key: `${s.account}|${s.symbol}|STK`, account: s.account, symbol: s.symbol, sec_type: "STK", leg: "",
        quantity: s.qty, avg_cost: s.avg, multiplier: 1, currency: "USD",
        market_price: this.prices[s.symbol] ?? null, market_value: null, unrealized_pnl: null,
        contract: { secType: "STK", symbol: s.symbol, exchange: "SMART", currency: "USD" },
      }));
  }

  async place(recordId: string, approved: Rec): Promise<Rec> {
    this.placed.push({ tick: this.tick, approved });
    return { record_id: recordId, order_id: 5000 + this.placed.length, perm_id: null,
             status: "Submitted", limit_price: null, detail: {} };
  }

  async indexPrice(): Promise<number | null> { return null; } // 退到行情也拿不到
  async placeHosted(): Promise<Rec> { throw new Error("这些追踪没开托管"); }
  async modifyHosted(): Promise<boolean> { return true; }
  async cancelHosted(): Promise<boolean> { return true; }
  async listHostedOpen(): Promise<Rec[]> { return []; }
  async legQuotes(): Promise<any[]> { return []; }
  async cancelAllOpen(): Promise<number> { return 0; }
  async contractHours(): Promise<null> { return null; }
  cachedContractHours(): null { return null; }
  sessions(): unknown[] { return [{}]; }
}

/** 参考模型:只用引擎"看得见"的那几轮推峰值,返回每只股该触发的那一轮(没有就是 null) */
function expectedFires(paths: Record<string, number[]>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const spec of SPECS) {
    let peak: number | null = null;
    out[spec.symbol] = null;
    for (let i = 0; i < TICKS; i += 1) {
      if (inAny(i, DISCONNECTS)) continue;
      if (spec.account === "主账户" && inAny(i, UNCOVERED)) continue;
      if (inAny(i, NO_QUOTE[spec.symbol] ?? [])) continue;
      const p = paths[spec.symbol]![i]!;
      peak = peak === null ? p : spec.qty > 0 ? Math.max(peak, p) : Math.min(peak, p);
      if (spec.fires(peak, p)) {
        out[spec.symbol] = i;
        break;
      }
    }
  }
  return out;
}

function makeEngine(dbPath: string, router: AllDayRouter): TradingEngine {
  const settings = makeSettings(g.base_config, {
    policies: { auto_execute: true, allow_live_trading: true },
    storage: { db_path: dbPath },
  });
  return new TradingEngine({
    settings, parser: {} as any, store: new TradeStore(settings.db_path),
    notifier: new Notifier(false), router: router as any,
  });
}

async function runDay(seed: number) {
  const paths: Record<string, number[]> = {};
  SPECS.forEach((s, k) => { paths[s.symbol] = pricePath(s, seed * 101 + k); });
  const router = new AllDayRouter(SPECS);
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "dafri-allday-")), "allday.db");
  let engine = makeEngine(dbPath, router);
  const ids: Record<string, string> = {};
  for (const s of SPECS) {
    ids[s.symbol] = String(engine.store.addTrack({
      account: s.account, symbol: s.symbol, sec_type: "STK",
      contract: { secType: "STK", symbol: s.symbol, exchange: "SMART", currency: "USD" },
      targets: s.targets, auto_close: { enabled: true, order_type: "MKT", slippage_pct: 0.5 }, peak: null,
    })["id"]);
  }
  const wronglyStopped: string[] = [];
  const errorsWhileDown: string[] = [];
  for (let i = 0; i < TICKS; i += 1) {
    router.tick = i;
    // 上一轮发出去的平仓单这一轮已经成交:仓没了
    for (const p of router.placed) router.closed.add(String(p.approved["order"]["contract"]["symbol"]));
    for (const s of SPECS) {
      router.prices[s.symbol] = inAny(i, NO_QUOTE[s.symbol] ?? []) ? null : paths[s.symbol]![i]!;
    }
    if (i === REBUILD_AT) {
      engine.stopTrackerLoop();
      engine = makeEngine(dbPath, router); // 同一个库,新实例:内存里什么都没带过来
    }
    await engine.trackerTickOnce(etNowFromEpoch(DAY_START + i * STEP_MS));
    if (inAny(i, DISCONNECTS)) errorsWhileDown.push(String(engine.trackerHeartbeat()["last_error"]));
    // 没触发、仓也还在的追踪,任何时候都不许被停掉
    for (const s of SPECS) {
      const t = engine.store.getTrack(ids[s.symbol]!)!;
      if (!t["fired_at"] && !router.closed.has(s.symbol) && !t["enabled"]) wronglyStopped.push(`${s.symbol}@${i}`);
    }
  }
  return { paths, router, engine, ids, wronglyStopped, errorsWhileDown, expected: expectedFires(paths) };
}

describe("跟踪止损 / 利润回撤:全天演练", () => {
  for (const seed of [1, 7, 42, 2026]) {
    it(`种子 ${seed}:每条追踪恰好在该触发的那一轮触发一次,断线 / 没连上 / 没报价 / 重建都不误停不误发`, async () => {
      const { router, engine, ids, wronglyStopped, errorsWhileDown, expected } = await runDay(seed);

      // 参考模型说该触发的,必须都触发;这组路径设计成每条都会触发——不然这条测试什么也没证明
      for (const s of SPECS) expect(expected[s.symbol], `${s.symbol} 这条路径一整天都没到价,换个路径`).not.toBeNull();

      const bySymbol = new Map<string, Array<{ tick: number; approved: Rec }>>();
      for (const p of router.placed) {
        const sym = String(p.approved["order"]["contract"]["symbol"]);
        bySymbol.set(sym, [...(bySymbol.get(sym) ?? []), p]);
      }
      for (const s of SPECS) {
        const sent = bySymbol.get(s.symbol) ?? [];
        expect(sent.map((p) => p.tick), `${s.symbol} 触发的轮次`).toEqual([expected[s.symbol]]);
        const order = sent[0]!.approved["order"]["order"];
        expect(order.action).toBe(s.qty > 0 ? "SELL" : "BUY");
        expect(order.totalQuantity).toBe(Math.abs(s.qty));
        // 断线那几轮一张单都不许发
        expect(inAny(sent[0]!.tick, DISCONNECTS)).toBe(false);
        const track = engine.store.getTrack(ids[s.symbol]!)!;
        expect(track["fired_at"]).toBeTruthy();
      }
      expect(wronglyStopped).toEqual([]);
      expect(errorsWhileDown.every((e) => e.includes("读不到持仓"))).toBe(true);
    }, 60_000);
  }

  it("断线期间价格穿过了止损:连回来的第一轮就平(跳空按最坏的那边算)", async () => {
    const spec = SPECS[0]!; // AAA 多头跟踪 3%
    // 涨到 59(峰值),断线那 20 轮里跌到 40——止损位 57.23 早就穿了,引擎一眼都没看见
    const prices = Array.from({ length: 40 }, (_, i) => (i < 10 ? 50 + i : 40));
    const router = new AllDayRouter([spec]);
    const engine = makeEngine(path.join(mkdtempSync(path.join(tmpdir(), "dafri-gap-")), "gap.db"), router);
    engine.store.addTrack({
      account: spec.account, symbol: spec.symbol, sec_type: "STK",
      contract: { secType: "STK", symbol: spec.symbol, exchange: "SMART", currency: "USD" },
      targets: spec.targets, auto_close: { enabled: true, order_type: "MKT" }, peak: null,
    });
    const down = (i: number) => i >= 10 && i < 30;
    router.positions = (async function (this: AllDayRouter) {
      if (down(this.tick - 1000)) throw new Error("读不到持仓:与 TWS 的连接已断开");
      return AllDayRouter.prototype.positions.call(this);
    }) as any;
    for (let i = 0; i < 40; i += 1) {
      router.tick = 1000 + i; // 避开全天事故表
      router.prices["AAA"] = prices[i]!;
      await engine.trackerTickOnce(etNowFromEpoch(DAY_START + (1000 + i) * STEP_MS));
      if (down(i)) expect(router.placed).toEqual([]);
    }
    expect(router.placed.map((p) => p.tick)).toEqual([1030]);
    expect(router.placed[0]!.approved["order"]["order"].action).toBe("SELL");
  });
});
