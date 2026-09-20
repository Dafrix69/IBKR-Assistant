/** 盯盘节拍器(追踪止盈 / 标的目标价的调度)。
 *
 * 以前节拍器在界面里:窗口一最小化 Chromium 就节流定时器,止损与秒级调价跟着停摆;而且它和下单
 * 挤同一条严格顺序的交易道、排低优先级。现在节拍器在引擎里,这里钉死它的几条规矩:
 *  1. 一轮没跑完绝不开下一轮(慢了就紧接着跑,不叠);
 *  2. 一轮只读一次持仓,判触发和托管对账用同一份;
 *  3. 任何异常都不许让节拍器停下,读不到持仓就跳过这一轮;
 *  4. 和「立即平仓 / 改追踪」共用一把锁——一轮正要发平仓单时插进来就是双重平仓;
 *  5. 引擎实例重建时旧循环必须停掉,不能两个循环同时对账托管单。
 */
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { TradingEngine } from "../src/engine.js";
import { Notifier } from "../src/notify.js";
import { RpcServer } from "../src/rpc.js";
import { TradeStore } from "../src/store.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");
const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class SlowRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  positionCalls = 0;
  inFlight = 0;
  maxInFlight = 0;
  delayMs = 0;
  fail = false;
  constructor(public rows: Rec[]) {}
  async positions(): Promise<Rec[]> {
    this.positionCalls += 1;
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs) await sleep(this.delayMs);
      if (this.fail) throw new Error("读不到持仓:TWS 在 8 秒内没有推送持仓");
      return [...this.rows];
    } finally {
      this.inFlight -= 1;
    }
  }
  async indexPrice(): Promise<number | null> { return null; }
  async placeHosted(): Promise<Rec> { return { order_id: 1, perm_id: null, status: "PreSubmitted" }; }
  async modifyHosted(): Promise<boolean> { return true; }
  async cancelHosted(_id?: number): Promise<boolean> { return true; }
  async listHostedOpen(): Promise<Rec[]> { return []; }
  async legQuotes(): Promise<any[]> { return []; }
  async place(): Promise<any> { throw new Error("not used"); }
  async cancelAllOpen(): Promise<number> { return 0; }
  async contractHours(): Promise<null> { return null; }
  cachedContractHours(): null { return null; }
  sessions(): unknown[] { return [{}]; }
}

function stockRow(): Rec {
  return {
    key: "模拟|NVDA|STK", account: "模拟", symbol: "NVDA", sec_type: "STK", quantity: 100,
    avg_cost: 180, multiplier: 1, currency: "USD", market_price: 220, market_value: 22000,
    unrealized_pnl: 4000, contract: { secType: "STK", symbol: "NVDA", exchange: "SMART", currency: "USD" },
  };
}

function build(router: SlowRouter): TradingEngine {
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-loop-"));
  const settings = makeSettings(g.base_config, {
    policies: { auto_execute: true }, storage: { db_path: path.join(dir, "loop.db") },
  });
  const engine = new TradingEngine({
    settings, parser: {} as any, store: new TradeStore(settings.db_path),
    notifier: new Notifier(false), router: router as any,
  });
  engine.store.addTrack({
    account: "模拟", symbol: "NVDA", sec_type: "STK",
    contract: { secType: "STK", symbol: "NVDA", exchange: "SMART", currency: "USD" },
    targets: { spot_target: 260 }, auto_close: { enabled: true, host_at_broker: true }, peak: 220,
  });
  return engine;
}

const engines: TradingEngine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.stopTrackerLoop();
});

describe("盯盘节拍器", () => {
  it("一轮只读一次持仓:判触发与托管对账用同一份", async () => {
    const router = new SlowRouter([stockRow()]);
    const engine = build(router);
    await engine.trackerTickOnce();
    expect(router.positionCalls).toBe(1);
    expect(engine.trackerLoop["poll"].rows).toHaveLength(1);
    expect(engine.trackerLoop["hosted"].hosted).toHaveLength(1);
  });

  it("一轮比节拍还慢:紧接着跑下一轮,但绝不两轮叠在一起", async () => {
    const router = new SlowRouter([stockRow()]);
    router.delayMs = 120; // 比节拍(40ms)慢得多
    const engine = build(router);
    engines.push(engine);
    engine.startTrackerLoop(40);
    await sleep(700);
    engine.stopTrackerLoop();
    expect(router.maxInFlight).toBe(1);
    expect(Number(engine.trackerLoop["ticks"])).toBeGreaterThanOrEqual(3);
  });

  it("读不到持仓:这一轮跳过、报出原因,节拍器照跑,追踪不被误停", async () => {
    const router = new SlowRouter([stockRow()]);
    router.fail = true;
    const engine = build(router);
    engines.push(engine);
    engine.startTrackerLoop(30);
    await sleep(200);
    expect(engine.trackerHeartbeat()["last_error"]).toContain("读不到持仓");
    expect(engine.trackerHeartbeat()["running"]).toBe(true);
    const ticksWhileFailing = Number(engine.trackerLoop["ticks"]);
    expect(ticksWhileFailing).toBeGreaterThanOrEqual(2);
    expect(engine.store.listTracks()[0]!["enabled"]).toBeTruthy();

    router.fail = false; // 恢复后下一轮就正常
    await sleep(150);
    expect(engine.trackerHeartbeat()["last_error"]).toBe("");
  });

  it("「立即平仓」这类操作和一轮盯盘互斥:等这一轮做完才轮到它", async () => {
    const router = new SlowRouter([stockRow()]);
    router.delayMs = 150;
    const engine = build(router);
    const order: string[] = [];
    // 记录点放在临界区里面:这一轮读持仓的开始与结束
    const orig = router.positions.bind(router);
    router.positions = async () => {
      order.push("tick: 读持仓开始");
      const rows = await orig();
      order.push("tick: 读持仓结束");
      return rows;
    };
    const tick = engine.trackerTickOnce();
    await sleep(20); // 这一轮已经进锁、正在读持仓
    const other = engine.withTrackerLock(async () => { order.push("close_now"); });
    await Promise.all([tick, other]);
    expect(order).toEqual(["tick: 读持仓开始", "tick: 读持仓结束", "close_now"]);
  });

  it("心跳:每轮计时,慢了记一次", async () => {
    const router = new SlowRouter([stockRow()]);
    router.delayMs = TradingEngine.TRACKER_SLOW_MS + 50;
    const engine = build(router);
    await engine.trackerTickOnce();
    const hb = engine.trackerHeartbeat();
    expect(hb["last_ms"]).toBeGreaterThanOrEqual(TradingEngine.TRACKER_SLOW_MS);
    expect(hb["slow_ticks"]).toBe(1);
  }, 10_000);
});

describe("只解析不执行,不许动共享配置", () => {
  it("解析那一刻 auto_execute 仍是原值;托管单不被撤(2026-09-10 真机:解析时临时改配置,节拍器撤光了托管单)", async () => {
    const router = new SlowRouter([stockRow()]);
    const engine = build(router);
    await engine.trackerTickOnce(); // 先把托管单挂上
    const cancelled: number[] = [];
    router.cancelHosted = async (id: number) => { cancelled.push(id); return true; };

    let seenDuringParse: boolean | null = null;
    (engine as any).parser = {
      parse: async () => {
        seenDuringParse = engine.settings.policies.auto_execute;
        await engine.trackerTickOnce(); // 解析的这一两秒里,节拍器照常跑了一轮
        throw new Error("stub parser:不需要真的解析");
      },
    };
    await engine.handleInstruction("买入 NVDA 1股 limit 200", "manual", null, { NVDA: 220 }, ["模拟"], true)
      .catch(() => undefined);
    expect(seenDuringParse).toBe(true);
    expect(cancelled).toEqual([]);
  });
});

describe("RPC 层:节拍器跟着引擎实例走", () => {
  function server(): RpcServer {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-loop-rpc-"));
    const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
    return new RpcServer(settingsPath, () => undefined);
  }

  it("连着券商时一建引擎就起节拍器;引擎重建(改配置 / 重连)时旧循环先停掉", async () => {
    const s = server();
    (s as any).router = new SlowRouter([]);
    const first = s.engine;
    expect(first.trackerLoop["running"]).toBe(true);
    (s as any).dropEngine();
    expect(first.trackerLoop["running"]).toBe(false);   // 旧的停了
    const second = s.engine;
    expect(second).not.toBe(first);
    expect(second.trackerLoop["running"]).toBe(true);    // 新的起了
    second.stopTrackerLoop();
  });

  it("instruction.submit 只解析时不改共享配置(真机那次的出事路径)", async () => {
    const s = server();
    (s as any).settings.policies.auto_execute = true;
    (s as any).router = new SlowRouter([]);
    const engine = s.engine;
    engine.stopTrackerLoop();
    let seen: boolean | null = null;
    (engine as any).parser = {
      parse: async () => {
        seen = engine.settings.policies.auto_execute;
        throw new Error("stub parser");
      },
    };
    await s.domains.trading.instructionSubmit({ text: "买入 NVDA 1股 limit 200", execute: false }).catch(() => undefined);
    expect(seen).toBe(true);
    expect(engine.settings.policies.auto_execute).toBe(true);
  });

  it("没连券商就不起节拍器,tracker.poll 就地算一次", async () => {
    const s = server();
    const out = await s.domains.tracker.trackerPoll();
    expect(s.engine.trackerLoop["running"]).toBe(false);
    expect(out["rows"]).toEqual([]);
  });
});
