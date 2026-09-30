/** 盯盘停过(engine/wakeGuard.ts):合盖睡着、维护唤醒、醒后先不判断、一整段停完只报一次。
 *
 * 钉的是:
 *  1. 墙钟两轮之间超过 30 秒才算停摆;墙钟减单调时钟分得开"睡着了"与"卡住了",只有睡着的要等连接稳住;
 *  2. 醒后等券商连接连续稳住 20 秒,连接一变就重新计时,最长 2 分钟;
 *  3. 2026-09-29 那一下午原样回放(12:58 合盖、每 15 分钟一次几秒的维护唤醒、13:24 醒来那次断线重连、16:40 开盖):
 *     维护唤醒里一轮都不判断,开盖一分钟后只报一次;
 *  4. 接进引擎:等的那几轮持仓照读、不判触发、不推峰值——醒来那一笔旧价 / 拼出来的净价不会变成一次假的跟踪止损。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { etNowFromEpoch } from "../src/config.js";
import type { Track } from "../src/contract/tracker.js";
import { TradingEngine } from "../src/engine.js";
import {
  GAP_MS, HOLD_REASON, QUIET_MS, SETTLE_MAX_MS, SETTLE_MS, WakeGuard, durationText, episodeNotice, linkOf,
  liveTracksOf, reportWake, spanText,
} from "../src/engine/wakeGuard.js";
import type { LiveTracks, WakeSample, WakeStep } from "../src/engine/wakeGuard.js";
import { Notifier } from "../src/notify.js";
import { TradeStore } from "../src/store.js";
import { loadGolden, makeSettings } from "./util.js";

type Rec = Record<string, any>;
const ONE: LiveTracks = { total: 1, hosted: 0, symbols: ["SPX"] };
const NONE: LiveTracks = { total: 0, hosted: 0, symbols: [] };
const et = (hms: string): number => Date.parse(`2026-09-29T${hms}-04:00`);

/** 一个假的时钟:墙钟与单调时钟一起走(醒着),或者只有墙钟走(睡着)。 */
class Clock {
  wall: number;
  mono = 1_000;
  link = "live";
  live: LiveTracks = ONE;
  constructor(start: number) { this.wall = start; }
  awake(ms: number): void { this.wall += ms; this.mono += ms; }
  asleep(ms: number): void { this.wall += ms; }
  sample(): WakeSample { return { wall: this.wall, mono: this.mono, link: this.link, live: this.live }; }
}

/** 按 1 秒一轮跑 n 轮,返回每一轮的结论 */
function run(g: WakeGuard, c: Clock, n: number): WakeStep[] {
  const out: WakeStep[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(g.step(c.sample()));
    c.awake(1_000);
  }
  return out;
}

describe("WakeGuard:认停摆", () => {
  it("每秒一轮、偶尔一轮慢到 25 秒:都不算停过", () => {
    const g = new WakeGuard();
    const c = new Clock(et("10:00:00"));
    const a = run(g, c, 100);
    c.awake(25_000); // 一轮卡在券商那头
    const b = run(g, c, 100);
    expect([...a, ...b].every((s) => s.gap === null && s.hold === "" && s.episode === null)).toBe(true);
  });

  it("合盖十分钟:算睡着了,醒来先不判断,连接稳住 20 秒后恢复", () => {
    const g = new WakeGuard();
    const c = new Clock(et("12:58:00"));
    run(g, c, 25);
    c.asleep(10 * 60_000);
    const [first, ...rest] = run(g, c, 25);
    expect(first!.gap).toMatchObject({ kind: "sleep", stopped_ms: 10 * 60_000 + 1_000 });
    expect(first!.gap!.asleep_ms).toBe(10 * 60_000);
    expect(first!.hold).toBe(HOLD_REASON);
    const released = rest.findIndex((s) => s.hold === "");
    expect(released + 1).toBe(SETTLE_MS / 1000); // 醒来那一轮算第 0 秒,第 20 秒那一轮恢复
    expect(rest[released]!.released).toEqual({ waited_ms: SETTLE_MS, steady: true });
    expect(rest.slice(released).every((s) => s.hold === "")).toBe(true);
  });

  it("醒来断线又重连:从连回来那一刻重新数 20 秒", () => {
    const g = new WakeGuard();
    const c = new Clock(et("13:20:00"));
    run(g, c, 5);
    c.asleep(15 * 60_000);
    run(g, c, 1); // 醒来那一秒,连接还是"连着"(TWS 自己还没发现)
    c.link = "";
    run(g, c, 5); // 断了 5 秒
    c.link = "live";
    const after = run(g, c, 30);
    expect(after.findIndex((s) => s.hold === "")).toBe(SETTLE_MS / 1000);
  });

  it("换了一组连接(实盘连回来、模拟盘还没)也重新数", () => {
    const g = new WakeGuard();
    const c = new Clock(et("13:20:00"));
    c.link = "live,paper";
    run(g, c, 5);
    c.asleep(15 * 60_000);
    run(g, c, 10);
    c.link = "live";
    const after = run(g, c, 30);
    expect(after.findIndex((s) => s.hold === "")).toBe(SETTLE_MS / 1000);
  });

  it("连接一直稳不住:最多等 2 分钟,之后照常判断", () => {
    const g = new WakeGuard();
    const c = new Clock(et("13:20:00"));
    run(g, c, 5);
    c.asleep(15 * 60_000);
    c.link = "";
    const steps = run(g, c, 200);
    const released = steps.findIndex((s) => s.hold === "");
    expect(released).toBe(SETTLE_MAX_MS / 1000);
    expect(steps[released]!.released).toEqual({ waited_ms: SETTLE_MAX_MS, steady: false });
  });

  it("卡住(墙钟与单调时钟一起走了 5 分钟):不等连接,一分钟后报一次「盯盘停了」", () => {
    const g = new WakeGuard();
    const c = new Clock(et("10:00:00"));
    run(g, c, 5);
    c.awake(5 * 60_000);
    const steps = run(g, c, 90);
    expect(steps[0]!.gap).toMatchObject({ kind: "stall", asleep_ms: 0 });
    expect(steps.every((s) => s.hold === "")).toBe(true);
    const ends = steps.filter((s) => s.episode !== null);
    expect(ends).toHaveLength(1);
    expect(steps.findIndex((s) => s.episode !== null)).toBe(QUIET_MS / 1000);
    expect(episodeNotice(ends[0]!.episode!)?.title).toBe("盯盘停了 5 分钟");
  });

  it("墙钟往回拨不算停摆", () => {
    const g = new WakeGuard();
    const c = new Clock(et("10:00:00"));
    run(g, c, 5);
    c.wall -= 3_600_000;
    expect(run(g, c, 5).every((s) => s.gap === null && s.hold === "")).toBe(true);
  });

  it("有意停掉的节拍器(pause)再起来不算停摆;没报完的那一段接着算", () => {
    const g = new WakeGuard();
    const c = new Clock(et("12:00:00"));
    run(g, c, 5);
    c.asleep(20 * 60_000);
    run(g, c, 10); // 醒了、在等
    g.pause();
    c.awake(3 * 60_000); // 引擎重建花了点时间(夸张一点)
    const steps = run(g, c, 70);
    expect(steps.every((s) => s.gap === null)).toBe(true);
    expect(steps[0]!.hold).toBe(""); // 连接稳住的时长早就够了
    expect(steps.filter((s) => s.episode !== null)).toHaveLength(1);
  });
});

describe("WakeGuard:2026-09-29 下午原样回放", () => {
  /** pmset 里的维护唤醒:[美东时刻, 醒了几秒]。13:24:11 那次醒 21 秒,其间 1 秒后断线、5 秒后重连 */
  const DARK_WAKES: Array<[string, number]> = [
    ["13:08:36", 3], ["13:24:11", 21], ["13:31:27", 5], ["13:46:41", 2], ["14:01:50", 4], ["14:16:58", 2],
    ["14:32:05", 3], ["14:47:12", 2], ["15:02:20", 6], ["15:16:53", 2], ["15:32:58", 2], ["15:48:03", 3],
    ["16:03:10", 2], ["16:18:18", 4], ["16:33:25", 2],
  ];

  it("维护唤醒里一轮都不判断;16:40 开盖一分钟后只报一次,时长、次数都对", () => {
    const g = new WakeGuard();
    const c = new Clock(et("12:57:00"));
    const steps: WakeStep[] = [];
    while (c.wall < et("12:58:25")) steps.push(...run(g, c, 1));
    let heldDuringDark = 0;
    let judgedDuringDark = 0;
    for (const [at, secs] of DARK_WAKES) {
      c.asleep(et(at) - c.wall);
      for (let s = 0; s < secs; s += 1) {
        if (at === "13:24:11") c.link = s >= 1 && s < 6 ? "" : "live";
        const step = g.step(c.sample());
        steps.push(step);
        if (step.hold) heldDuringDark += 1;
        else judgedDuringDark += 1;
        c.awake(1_000);
      }
    }
    c.asleep(et("16:40:00") - c.wall);
    const opened = run(g, c, 120);
    steps.push(...opened);

    expect(judgedDuringDark).toBe(0);
    expect(heldDuringDark).toBe(DARK_WAKES.reduce((n, [, s]) => n + s, 0));
    expect(opened.findIndex((s) => s.hold === "")).toBe(SETTLE_MS / 1000);
    const ends = steps.filter((s) => s.episode !== null);
    expect(ends).toHaveLength(1);
    expect(opened.findIndex((s) => s.episode !== null)).toBe(QUIET_MS / 1000);
    const ep = ends[0]!.episode!;
    expect(ep.kind).toBe("sleep");
    expect(ep.gaps).toBe(DARK_WAKES.length + 1);
    expect(ep.from).toBe(et("12:58:24"));
    expect(ep.to).toBe(et("16:40:00"));
    // 维护唤醒里醒着的总时长:每次醒 n 秒,最后一轮在第 n-1 秒开始
    expect(ep.awake_ms).toBe(DARK_WAKES.reduce((n, [, s]) => n + (s - 1) * 1000, 0));
    const notice = episodeNotice(ep)!;
    expect(notice.title).toBe("电脑睡了 3 小时 42 分,本机盯盘没有运行");
    expect(notice.body).toContain("美东 12:58–16:40,1 条追踪(SPX)没人盯");
    expect(notice.body).toContain("用电池时合盖");
  });
});

describe("给人看的话与留痕", () => {
  it("时长与起止(跨日带月日)", () => {
    expect(durationText(45_000)).toBe("45 秒");
    expect(durationText(12 * 60_000)).toBe("12 分钟");
    expect(durationText(3 * 3_600_000)).toBe("3 小时");
    expect(durationText(222 * 60_000)).toBe("3 小时 42 分");
    expect(spanText(et("12:58:24"), et("16:40:00"))).toBe("12:58–16:40");
    expect(spanText(et("15:50:00"), Date.parse("2026-09-30T08:10:00-04:00"))).toBe("09-29 15:50 – 09-30 08:10");
  });

  it("没有在盯的追踪:只写日志与审计,不弹通知;停得太短也不弹", () => {
    const logs: string[] = [];
    const audits: Array<[string, string, Rec]> = [];
    const notices: string[] = [];
    const store = { audit: (a: string, b: string, d: Rec) => { audits.push([a, b, d]); } };
    const notifier = { notify: (t: string) => { notices.push(t); } };
    for (const [live, asleepMs] of [[NONE, 30 * 60_000], [ONE, 45_000]] as const) {
      const g = new WakeGuard();
      const c = new Clock(et("12:00:00"));
      c.live = live;
      run(g, c, 3);
      c.asleep(asleepMs);
      for (const step of run(g, c, 70)) reportWake(step, store, notifier, (l) => logs.push(l));
    }
    expect(notices).toEqual([]);
    expect(audits.map(([actor, action]) => `${actor}/${action}`)).toEqual(["engine/monitor_gap", "engine/monitor_gap"]);
    expect(audits[0]![2]).toMatchObject({ kind: "sleep", live: 0, gaps: 1, asleep_s: 1800 });
    expect(logs.filter((l) => l.startsWith("[盯盘] 节拍停了"))).toHaveLength(2);
    expect(logs.filter((l) => l.startsWith("[盯盘] 醒后等了"))).toHaveLength(2);
    expect(logs.filter((l) => l.startsWith("[盯盘] 这一段停摆结束"))).toHaveLength(2);
  });

  it("在盯的追踪:启用且没触发的,加上正在追价的;托管的另数", () => {
    const t = (id: string, symbol: string, patch: Partial<Track>): Track => ({
      id, symbol, enabled: true, fired_at: null, auto_close: {}, ...patch,
    } as Track);
    const live = liveTracksOf([
      t("a", "SPX", {}),
      t("b", "SPX", { auto_close: { host_at_broker: true } }),
      t("c", "NVDA", { enabled: false }),
      t("d", "QQQ", { enabled: false, fired_at: "2026-09-29T10:00:00" }), // 触发了、平仓单还在追价
      t("e", "AAPL", { fired_at: "2026-09-29T10:00:00" }),
    ], (id) => id === "d");
    expect(live).toEqual({ total: 3, hosted: 1, symbols: ["SPX", "QQQ"] });
  });

  it("连接名:有 connectedNames 用它,没有就按连着的会话数", () => {
    expect(linkOf(null)).toBe("");
    expect(linkOf({ connectedNames: () => ["live", "paper"], sessions: () => [] })).toBe("live,paper");
    expect(linkOf({ sessions: () => [{}] })).toBe("1");
    expect(linkOf({ sessions: () => [] })).toBe("");
  });

  it("阈值之间的关系:维护唤醒醒着的时长 < QUIET_MS,醒后的等待 ≤ 上限", () => {
    expect(GAP_MS).toBeLessThan(QUIET_MS);
    expect(SETTLE_MS).toBeLessThan(SETTLE_MAX_MS);
    expect(21_000).toBeLessThan(QUIET_MS); // 09-29 最长的一次维护唤醒
  });
});

// ---- 接进引擎 ----------------------------------------------------------------

const g = loadGolden("config");
/** 2026-08-14 周五 10:00 美东:盘中 */
const TEN_AM = Date.parse("2026-08-14T10:00:00-04:00");

class OneStockRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  price = 50;
  placed: Rec[] = [];
  positionCalls = 0;
  async positions(): Promise<Rec[]> {
    this.positionCalls += 1;
    if (this.placed.length) return [];
    return [{
      key: "模拟|AAA|STK", account: "模拟", symbol: "AAA", sec_type: "STK", leg: "",
      quantity: 100, avg_cost: 50, multiplier: 1, currency: "USD",
      market_price: this.price, market_value: null, unrealized_pnl: null,
      contract: { secType: "STK", symbol: "AAA", exchange: "SMART", currency: "USD" },
    }];
  }
  async place(recordId: string, approved: Rec): Promise<Rec> {
    this.placed.push(approved);
    return { record_id: recordId, order_id: 5001, perm_id: null, status: "Submitted", limit_price: null, detail: {} };
  }
  async indexPrice(): Promise<number | null> { return null; }
  async placeHosted(): Promise<Rec> { throw new Error("没开托管"); }
  async modifyHosted(): Promise<boolean> { return true; }
  async cancelHosted(): Promise<boolean> { return true; }
  async listHostedOpen(): Promise<Rec[]> { return []; }
  async legQuotes(): Promise<unknown[]> { return []; }
  async cancelAllOpen(): Promise<number> { return 0; }
  async contractHours(): Promise<null> { return null; }
  cachedContractHours(): null { return null; }
  sessions(): unknown[] { return [{}]; }
}

/** 真的 WakeGuard,只把喂进去的时钟往后挪:asleep = 合上盖子睡了那么久(只挪墙钟),awake = 醒着过了那么久(两个一起挪) */
class ShiftedGuard extends WakeGuard {
  private wall = 0;
  private mono = 0;
  asleep(ms: number): void { this.wall += ms; }
  awake(ms: number): void { this.wall += ms; this.mono += ms; }
  override step(s: WakeSample): WakeStep {
    return super.step({ ...s, wall: s.wall + this.wall, mono: s.mono + this.mono });
  }
}

function build(): { engine: TradingEngine; router: OneStockRouter; guard: ShiftedGuard; trackId: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-wake-"));
  const settings = makeSettings(g.base_config, {
    policies: { auto_execute: true, allow_live_trading: true }, storage: { db_path: path.join(dir, "wake.db") },
  });
  const router = new OneStockRouter();
  const engine = new TradingEngine({
    settings, parser: {} as any, store: new TradeStore(settings.db_path),
    notifier: new Notifier(false), router: router as any,
  });
  const guard = new ShiftedGuard();
  engine.wakeGuard = guard;
  const trackId = String(engine.store.addTrack({
    account: "模拟", symbol: "AAA", sec_type: "STK",
    contract: { secType: "STK", symbol: "AAA", exchange: "SMART", currency: "USD" },
    targets: { trail_pct: 3 }, auto_close: { enabled: true, order_type: "MKT" }, peak: null,
  })["id"]);
  return { engine, router, guard, trackId };
}

const tick = (engine: TradingEngine, i: number): Promise<void> => engine.trackerTickOnce(etNowFromEpoch(TEN_AM + i * 1000));

describe("接进引擎:醒后那几轮", () => {
  it("对照:不睡的话,一笔 60 把峰值抬上去,接着 57 就触发了跟踪止损", async () => {
    const { engine, router } = build();
    await tick(engine, 0);
    router.price = 60;
    await tick(engine, 1);
    router.price = 57; // 60 × 0.97 = 58.2
    await tick(engine, 2);
    expect(router.placed).toHaveLength(1);
  });

  it("醒来那一笔 60 不推峰值、57 不触发;连接稳住 20 秒后按真价判断", async () => {
    const { engine, router, guard, trackId } = build();
    await tick(engine, 0);
    expect(engine.store.getTrack(trackId)?.peak).toBe(50);

    guard.asleep(10 * 60_000); // 合盖十分钟
    router.price = 60; // 醒来那一秒 TWS 给的旧盘口 / 新旧腿拼出来的价
    await tick(engine, 1);
    router.price = 57;
    await tick(engine, 2);
    const before = router.positionCalls;
    await tick(engine, 3);
    expect(router.positionCalls).toBe(before + 1); // 等的时候持仓照读:常驻行情流跟着续订
    expect(router.placed).toEqual([]);
    expect(engine.store.getTrack(trackId)?.peak).toBe(50);
    const rows = engine.trackerLoop["poll"]["rows"] as Rec[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: trackId, state: "holding", reason: HOLD_REASON });
    expect(rows[0]!["price"]).toBeUndefined(); // 这几轮的价不可信,不摆出来
    expect(engine.trackerHeartbeat()).toMatchObject({ hold: HOLD_REASON, live_tracks: 1, last_error: "" });

    guard.awake(SETTLE_MS); // 连接一直连着,稳住了
    await tick(engine, 4);
    expect(engine.trackerHeartbeat().hold).toBe("");
    expect(router.placed).toEqual([]); // 峰值 50,止损 48.5;57 不触发
    expect(engine.store.getTrack(trackId)?.peak).toBe(57);

    for (let i = 0; i < QUIET_MS / 20_000; i += 1) {
      guard.awake(20_000); // 一直醒着(一步挪 20 秒,不到算停摆的 30 秒)
      await tick(engine, 5 + i);
    }
    const notifier = engine.notifier;
    expect(notifier.history.map(([title]) => title)).toEqual(["电脑睡了 10 分钟,本机盯盘没有运行"]);
    const audits = (engine.store.exportAll()["audit_log"] as Rec[]).filter((a) => a["action"] === "monitor_gap");
    expect(audits).toHaveLength(1);
    expect(JSON.parse(String(audits[0]!["detail"]))).toMatchObject({ kind: "sleep", live: 1, symbols: ["AAA"], gaps: 1 });
  });

  it("节拍器是被停掉再起来的(引擎重建、断开):不算停摆", async () => {
    const { engine, router, guard } = build();
    await tick(engine, 0);
    engine.stopTrackerLoop();
    guard.asleep(10 * 60_000);
    router.price = 60;
    await tick(engine, 1);
    expect(engine.trackerHeartbeat().hold).toBe("");
    expect((engine.trackerLoop["poll"]["rows"] as Rec[])[0]).toMatchObject({ state: "holding", price: 60 });
  });
});
