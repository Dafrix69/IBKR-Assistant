/** 持仓追踪的出场细则:到点平仓、分批止盈、标的止损的确认、止损按可成交价判、推峰值要连续两轮、止损类的追价节奏
 * (docs/features/tracker.md「出场细则」)。
 *
 * 盯三层:纯函数(trackerExits.ts 与 tracker.evaluate 的两个可选价)、接进引擎(engine/exits.ts + pollTrackers)、
 * RPC(界面的原样载荷:字符串、'' = 不设、strict schema)。假券商只记下收到的单,不连任何真东西。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { etNowFromEpoch, setClock } from "../src/config.js";
import { TradingEngine } from "../src/engine.js";
import { TrackExits } from "../src/engine/exits.js";
import * as fx from "../src/flyexit.js";
import { Notifier } from "../src/notify.js";
import { isStopLike } from "../src/protections.js";
import { pyRound } from "../src/py.js";
import { RpcServer } from "../src/rpc.js";
import { TradeStore } from "../src/store.js";
import * as tk from "../src/tracker.js";
import * as ex from "../src/trackerExits.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");
const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

const EXPIRY = "20260910";
const SIG = 20;
const NOON_MS = Date.parse("2026-09-10T12:00:00-04:00");
const at = (plusMs = 0) => etNowFromEpoch(NOON_MS + plusMs);
const SEC = 1000, MIN = 60_000;

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

/** 以 4.50 买入的 7725/7750/7775 看涨蝶 lots 组,三条腿按标的 spot、σ=20 定价。 */
function flyAt(spot: number, lots = 1): Rec[] {
  return [legRow(7725, lots, spot, 800), legRow(7750, -2 * lots, spot, 200), legRow(7775, lots, spot, 50)];
}

const bagOf = (rows: Rec[]): Rec => tk.withCombos(rows).find((r) => r["sec_type"] === "BAG")!;
const midOf = (rows: Rec[]): number => Number(bagOf(rows)["market_price"]);
const halfSpread = (mid: number): number => Math.min(0.2, mid / 2);

/** 平掉多头蝶立刻能成交的价:两翼按买价卖、中心按卖价买回。 */
function naturalOf(rows: Rec[]): number {
  const [a, b, c] = rows.map((r) => Number(r["market_price"]));
  return pyRound((a! - halfSpread(a!)) - 2 * (b! + halfSpread(b!)) + (c! - halfSpread(c!)), 4);
}

class FakeRouter {
  SUPPORTS_HOSTED_CLOSE = true;
  SUPPORTS_NATIVE_CONDITIONS = true;
  BROKER = "ibkr";
  placed: Rec[] = [];
  modified: Rec[] = [];
  sent: Rec[] = [];
  quotes = true;
  private nextId = 800;
  private nextOrder = 990;

  constructor(public rows: Rec[], public spot: number | null) {}

  sessions(): unknown[] { return [{}]; }
  connectedNames(): string[] { return ["paper"]; }
  async positions(): Promise<Rec[]> { return this.rows.map((r) => ({ ...r })); }
  async indexPrice(): Promise<number | null> { return this.spot; }
  spotInfo(): Rec | null { return { price: this.spot, source: "index", note: "" }; }
  async optionQuotes(rows: Rec[]): Promise<Record<string, { bid: number | null; ask: number | null }>> {
    return Object.fromEntries(rows.map((r) => {
      const mid = r["market_price"];
      if (!this.quotes || mid === null || mid === undefined) return [r["key"], { bid: null, ask: null }];
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
  async cancelHosted(): Promise<boolean> { return true; }
  async listHostedOpen(): Promise<Rec[]> { return []; }
  async place(recordId: string, approved: Rec): Promise<Rec> {
    this.sent.push(approved);
    this.nextOrder += 1;
    return { record_id: recordId, order_id: this.nextOrder, perm_id: null, status: "Submitted", limit_price: null, detail: {} };
  }
  async legQuotes(): Promise<any[]> { return []; }
  async cancelAllOpen(): Promise<number> { return 0; }
  async contractHours(): Promise<null> { return null; }
  cachedContractHours(): null { return null; }
}

function build(opts: { targets: Rec; auto?: Rec; spot?: number; lots?: number; peak?: number | null }) {
  const spot = opts.spot ?? 7720;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-exits-"));
  dirs.push(dir);
  const settings = makeSettings(g.base_config, {
    policies: { auto_execute: true },
    storage: { db_path: path.join(dir, "exits.db") },
  });
  const router = new FakeRouter(flyAt(spot, opts.lots ?? 1), spot);
  const notes: string[] = [];
  const notifier = new Notifier(false);
  notifier.warning = (message: string): void => { notes.push(message); };
  notifier.notify = (title: string, body: string): void => { notes.push(`${title}|${body}`); };
  const engine = new TradingEngine({
    settings, parser: {} as any, store: new TradeStore(settings.db_path), notifier, router: router as any,
  });
  const held = bagOf(router.rows);
  const track = engine.store.addTrack({
    account: "模拟", symbol: "SPX", sec_type: held["sec_type"], leg: held["leg"], contract: held["contract"],
    targets: tk.makeTargets(opts.targets),
    auto_close: { enabled: true, order_type: "LMT", host_at_broker: false, close_fraction_pct: 100, ...(opts.auto ?? {}) },
    peak: opts.peak ?? null,
  });
  const move = (to: number, lots = opts.lots ?? 1): void => { router.rows = flyAt(to, lots); router.spot = to; };
  return { engine, router, track, notes, move };
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

// ---------------------------------------------------------------- 1. 纯函数
describe("到点平仓:钟点 → 时刻(纯函数)", () => {
  it("钟点写得不对:null", () => {
    for (const bad of ["", "1545", "25:00", "12:60", "abc", "12:5"]) expect(ex.clockMinutes(bad)).toBeNull();
    expect(ex.clockMinutes("9:30")).toBe(570);
    expect(ex.clockMinutes(" 15:45 ")).toBe(945);
    expect(ex.nextOccurrenceMs("25:00", NOON_MS)).toBeNull();
  });

  it("今天还没到:今天的那一刻;正好是这个钟点或已经过了:明天的", () => {
    expect(ex.nextOccurrenceMs("15:45", NOON_MS)).toBe(Date.parse("2026-09-10T15:45:00-04:00"));
    expect(ex.nextOccurrenceMs("12:00", NOON_MS)).toBe(Date.parse("2026-09-11T12:00:00-04:00"));
    expect(ex.nextOccurrenceMs("09:30", NOON_MS)).toBe(Date.parse("2026-09-11T09:30:00-04:00"));
  });

  it("夜盘 21:00 设 03:00:是今晚过了零点的那个 03:00,不会因为 21:00 晚于 03:00 当场触发", () => {
    const night = Date.parse("2026-09-10T21:00:00-04:00");
    const due = ex.nextOccurrenceMs("03:00", night)!;
    expect(due).toBe(Date.parse("2026-09-11T03:00:00-04:00"));
    const targets = tk.makeTargets({ exit_at: "03:00", exit_at_ms: due });
    expect(ex.timeExitDue(targets, night)).toBe(false);
    expect(ex.timeExitDue(targets, due - 1)).toBe(false);
    expect(ex.timeExitDue(targets, due)).toBe(true);
  });

  it("跨冬令时切换的那一晚:按美东的钟点算,不是加 24 小时", () => {
    // 2026-11-01 02:00 美东拨回 01:00;10-31 12:00(夏令时)设「明天 09:30」
    const before = Date.parse("2026-10-31T12:00:00-04:00");
    expect(ex.nextOccurrenceMs("09:30", before)).toBe(Date.parse("2026-11-01T09:30:00-05:00"));
  });

  it("没设:永远不到点;并进结论时只在持有中才生效", () => {
    const none = tk.makeTargets({ stop_loss: 1 });
    expect(ex.timeExitDue(none, NOON_MS * 2)).toBe(false);
    const due = tk.makeTargets({ exit_at: "12:00", exit_at_ms: NOON_MS });
    const holding = { state: "holding", reason: "" };
    expect(ex.withTimeExit(holding, due, NOON_MS)).toEqual({ state: "time_exit", reason: "到点平仓:已到美东 12:00" });
    expect(ex.withTimeExit(holding, due, NOON_MS - 1)).toBe(holding);
    // 止损 / 止盈在同一轮触发:听它们的,那一句原因更具体
    const stopped = { state: "stop_loss", reason: "止损触发" };
    expect(ex.withTimeExit(stopped, due, NOON_MS)).toBe(stopped);
    // 拿不到现价的那一轮也算:到点就是到点
    expect(ex.withTimeExit({ state: "holding", reason: "拿不到现价,本轮不判断" }, due, NOON_MS).state).toBe("time_exit");
  });
});

describe("分批止盈:校验与触发(纯函数)", () => {
  const T = (...pairs: Array<[number, number]>) => pairs.map(([price, fraction_pct]) => ({ price, fraction_pct }));

  it("说得通的档位:null", () => {
    expect(ex.tiersIssue(null, true, 4)).toBeNull();
    expect(ex.tiersIssue([], true, 4)).toBeNull();
    expect(ex.tiersIssue(T([6, 34], [9, 50]), true, 4)).toBeNull();
    expect(ex.tiersIssue(T([3, 50], [2, 100]), false, 4)).toBeNull(); // 空头:一档比一档低
    expect(ex.tiersIssue(T([6, 34]), true, null)).toBeNull();          // 拿不到现价:不核对方向
  });

  it("说不通的:一句人话", () => {
    expect(ex.tiersIssue(T([6, 0]), true, 4)).toBe("分批止盈第 1 档的比例要在 0(不含)到 100 之间。");
    expect(ex.tiersIssue(T([6, 101]), true, 4)).toMatch(/第 1 档的比例/);
    expect(ex.tiersIssue(T([-1, 50]), true, 4)).toBe("分批止盈第 1 档的价要是正数。");
    expect(ex.tiersIssue(T([6, 34], [6, 50]), true, 4)).toMatch(/^分批止盈各档的价要一档比一档高/);
    expect(ex.tiersIssue(T([6, 34], [9, 50]), false, 12)).toMatch(/^分批止盈各档的价要一档比一档低/);
    expect(ex.tiersIssue(T([3.5, 34]), true, 4)).toBe(
      "分批止盈第 1 档要高于现价(现价 4.0000,你填了 3.5)——填在下方会立刻触发。",
    );
    expect(ex.tiersIssue(T([1, 1], [2, 1], [3, 1], [4, 1], [5, 1]), true, 0.5)).toBe("分批止盈最多 4 档。");
  });

  it("到了哪一档:还没做的里最靠前、到了价的那一档;没到 / 没价:-1", () => {
    const tiers = T([6, 34], [9, 50]);
    expect(ex.dueTier(tiers, true, 5.9)).toBe(-1);
    expect(ex.dueTier(tiers, true, 6)).toBe(0);
    expect(ex.dueTier(tiers, true, 9.5)).toBe(0); // 一步跳过两档:先做第一档,它成交了下一轮才轮到第二档
    expect(ex.dueTier(tiers, true, null)).toBe(-1);
    expect(ex.dueTier(null, true, 9)).toBe(-1);
  });

  it("做完的跳过;有一档在等成交时一档都不触发", () => {
    const done = ex.markTier(T([6, 34], [9, 50]), 0, { done: true });
    expect(ex.dueTier(done, true, 6.5)).toBe(-1);
    expect(ex.dueTier(done, true, 9)).toBe(1);
    const waiting = ex.markTier(T([6, 34], [9, 50]), 0, { pending: true });
    expect(ex.pendingTier(waiting)).toBe(0);
    expect(ex.dueTier(waiting, true, 9.5)).toBe(-1);
    // markTier 不改传进来的那一份;给空的 patch = 把两个标记都摘掉
    expect(ex.pendingTier(ex.markTier(waiting, 0, {}))).toBe(-1);
    expect(waiting[0]).toEqual({ price: 6, fraction_pct: 34, pending: true });
  });

  it("并进结论:只在持有中生效,带上是第几档", () => {
    const targets = tk.makeTargets({ take_profit_tiers: T([6, 34], [9, 50]) });
    const holding = { state: "holding", reason: "", price: 6.2 };
    expect(ex.withTier(holding, targets, true)).toEqual({
      state: "take_profit", price: 6.2, tier: 0, reason: "分批止盈第 1 档:现价 6.2000 涨到 6,平 34%",
    });
    const stopped = { state: "stop_loss", reason: "止损触发", price: 6.2 };
    expect(ex.withTier(stopped, targets, true)).toBe(stopped);
    expect(ex.withTier({ ...holding, price: 5 }, targets, true).state).toBe("holding");
  });
});

describe("止损类的追价节奏(纯函数)", () => {
  const position = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: 450, multiplier: 100 });

  it("没另填:止损和止盈同一套(先等 2 轮、每轮 1 跳、上限 chase_max_pct)", () => {
    const auto = tk.makeAutoClose({ chase_max_pct: 10 });
    expect(ex.chaseProfile(auto, "stop_loss")).toEqual({ grace: 2, step: 1, maxPct: 10 });
    expect(ex.chaseProfile(auto, "take_profit")).toEqual({ grace: 2, step: 1, maxPct: 10 });
    for (const rounds of [0, 1, 2, 3, 5, 99]) {
      expect(tk.chaseLimit(position, 4, null, rounds, auto, "stop_loss")).toBe(tk.chaseLimit(position, 4, null, rounds, auto));
    }
  });

  it("另填了:只对止损类(止损、利润回撤,带 sweep: 前缀的也认)生效,止盈、到点、手动不变", () => {
    const auto = tk.makeAutoClose({ chase_max_pct: 10, stop_chase_grace: 0, stop_chase_step: 2, stop_chase_max_pct: 25 });
    for (const reason of ["stop_loss", "profit_trail", "sweep:stop_loss"]) {
      expect(ex.chaseProfile(auto, reason)).toEqual({ grace: 0, step: 2, maxPct: 25 });
    }
    for (const reason of ["take_profit", "time_exit", "manual", null, undefined]) {
      expect(ex.chaseProfile(auto, reason)).toEqual({ grace: 2, step: 1, maxPct: 10 });
    }
    // 立刻成交价 4.00:第 1 轮止损已经让了 2 跳,止盈还在原地;让满是 25%(1.00)对 10%(0.40)
    expect(tk.chaseLimit(position, 4, null, 1, auto, "stop_loss")).toBe(3.9);
    expect(tk.chaseLimit(position, 4, null, 1, auto, "take_profit")).toBe(4);
    expect(tk.chaseFloor(position, 4, auto, "stop_loss")).toBe(3);
    expect(tk.chaseFloor(position, 4, auto, "take_profit")).toBe(3.6);
    expect(tk.chaseFloor(position, 4, auto)).toBe(3.6);
  });

  it("只填了其中一项:别的仍用默认", () => {
    const auto = tk.makeAutoClose({ chase_max_pct: 10, stop_chase_step: 3 });
    expect(ex.chaseProfile(auto, "stop_loss")).toEqual({ grace: 2, step: 3, maxPct: 10 });
  });
});

describe("标的止损价的确认(纯函数)", () => {
  const row = (spot: number | null, hit: "below" | "above" | null): Rec =>
    ({ below: 7700, above: 7790, spot, spot_note: "", hit, reason: hit ? "标的止损触发" : "" });

  it("没设确认秒数:原样返回,不计时(触线即算)", () => {
    const hit = row(7698, "below") as tk.SpotStop;
    for (const s of [null, undefined, 0]) expect(ex.confirmSpotStop(hit, s, null, NOON_MS)).toEqual([hit, null]);
  });

  it("越线:从这一刻起计时,待够了才算;界面看得见待了多久", () => {
    const hit = row(7698, "below") as tk.SpotStop;
    const [first, c1] = ex.confirmSpotStop(hit, 3, null, NOON_MS);
    expect(first.hit).toBeNull();
    expect(first.pending).toEqual({ side: "below", held_s: 0, need_s: 3 });
    expect(first.reason).toBe("标的已跌破 7700,持续 0 秒,满 3 秒才平");
    const [second, c2] = ex.confirmSpotStop(hit, 3, c1, NOON_MS + 2 * SEC);
    expect(second.hit).toBeNull();
    expect(second.pending!.held_s).toBe(2);
    expect(c2).toEqual(c1);
    const [third] = ex.confirmSpotStop(hit, 3, c2, NOON_MS + 3 * SEC);
    expect(third).toBe(hit);
  });

  it("回到线内:计时清掉;换了一侧:从头数;拿不到现价:计时留着", () => {
    const below = row(7698, "below") as tk.SpotStop;
    const [, clock] = ex.confirmSpotStop(below, 3, null, NOON_MS);
    expect(ex.confirmSpotStop(row(7705, null) as tk.SpotStop, 3, clock, NOON_MS + SEC)[1]).toBeNull();
    const [flipped, c2] = ex.confirmSpotStop(row(7791, "above") as tk.SpotStop, 3, clock, NOON_MS + 5 * SEC);
    expect(flipped.hit).toBeNull();
    expect(c2).toEqual({ side: "above", sinceMs: NOON_MS + 5 * SEC });
    const blind = row(null, null) as tk.SpotStop;
    expect(ex.confirmSpotStop(blind, 3, clock, NOON_MS + SEC)).toEqual([blind, clock]);
  });
});

describe("evaluate:止损类与峰值各用各的价(纯函数)", () => {
  const position = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: 450, multiplier: 100 });

  it("不给可选项:和以前一个字不差", () => {
    const targets = tk.makeTargets({ stop_loss: 3, take_profit: 8 });
    expect(tk.evaluate(position, targets, 3.5, 5, null, {})).toEqual(tk.evaluate(position, targets, 3.5, 5));
    expect("stop_price" in tk.evaluate(position, targets, 3.5, 5)).toBe(false);
  });

  it("止损看可成交价:中间价还在线上、可成交价已经到线,触发;原因里写的是可成交价", () => {
    const targets = tk.makeTargets({ stop_loss: 3 });
    expect(tk.evaluate(position, targets, 3.4, null).state).toBe(tk.STATE_HOLDING);
    const out = tk.evaluate(position, targets, 3.4, null, null, { stopPrice: 2.95 });
    expect(out.state).toBe(tk.STATE_STOP_LOSS);
    expect(out.reason).toBe("止损触发:可成交价 2.9500 跌破 3.0000");
    expect(out.price).toBe(3.4);        // 现价与盈亏仍按中间价报
    expect(out.stop_price).toBe(2.95);
  });

  it("这一轮拿不到可成交价:止损类不判,止盈照判", () => {
    const targets = tk.makeTargets({ stop_loss: 3, take_profit: 8 });
    expect(tk.evaluate(position, targets, 2.5, null, null, { stopPrice: null }).state).toBe(tk.STATE_HOLDING);
    expect(tk.evaluate(position, targets, 8.2, null, null, { stopPrice: null }).state).toBe(tk.STATE_TAKE_PROFIT);
  });

  it("峰值按给的那个价推;给 null 这一轮不推", () => {
    const targets = tk.makeTargets({ trail_pct: 20 });
    expect(tk.evaluate(position, targets, 6, 5, null, { peakPrice: 5.5 }).peak).toBe(5.5);
    expect(tk.evaluate(position, targets, 6, 5, null, { peakPrice: null }).peak).toBe(5);
    expect(tk.evaluate(position, targets, 6, 5).peak).toBe(6);
  });
});

describe("推峰值用的价:打开了「连续两轮确认」的期权与组合才要两轮(engine/exits.ts)", () => {
  const exits = (): TrackExits => new TrackExits({ store: {} as any, notifier: {} as any });
  const fly = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: 1, avg_cost: 450, multiplier: 100 });
  const short = tk.makePosition({ account: "模拟", symbol: "SPX", sec_type: "BAG", quantity: -1, avg_cost: 250, multiplier: 100 });
  const stock = tk.makePosition({ account: "模拟", symbol: "BE", sec_type: "STK", quantity: 100, avg_cost: 100 });

  it("正股:就是现价", () => {
    const e = exits();
    expect(e.peakMark("s", stock, 120)).toBe(120);
    expect(e.peakMark("s", stock, null)).toBeNull();
  });

  it("没打开(默认):就是这一轮的价,和加这一项之前一样", () => {
    const e = exits();
    const round = (price: number | null): number | null => { e.nextRound(); return e.peakMark("t", fly, price); };
    expect([round(5), round(7.9), round(null), round(5.2)]).toEqual([5, 7.9, null, 5.2]);
  });

  it("多头取两轮里低的那个:只出现一笔的高价抬不动峰值", () => {
    const e = exits();
    const round = (price: number | null): number | null => { e.nextRound(); return e.peakMark("t", fly, price, true); };
    expect(round(5)).toBeNull();     // 头一轮没有上一轮可比
    expect(round(5.1)).toBe(5);
    expect(round(7.9)).toBe(5.1);    // 一笔坏报价
    expect(round(5.2)).toBe(5.2);    // 落回来:峰值没被 7.9 碰过
    expect(round(6)).toBe(5.2);
    expect(round(6.1)).toBe(6);      // 连着两轮都在高位才算
  });

  it("空头取高的那个;中间一轮没有价,前后都不推", () => {
    const e = exits();
    const round = (price: number | null): number | null => { e.nextRound(); return e.peakMark("t", short, price, true); };
    round(2);
    expect(round(0.4)).toBe(2);
    expect(round(null)).toBeNull();
    expect(round(1.8)).toBeNull();
    expect(round(1.7)).toBe(1.8);
  });

  it("同一轮问第二次(托管对账):同一个答案,不拿这一轮的价和它自己比", () => {
    const e = exits();
    e.nextRound(); e.peakMark("t", fly, 5, true);
    e.nextRound();
    expect(e.peakMark("t", fly, 7.9, true)).toBe(5);
    expect(e.peakMark("t", fly, 7.9, true)).toBe(5);
  });
});

// ---------------------------------------------------------------- 2. 接进引擎
describe("到点平仓:盯盘", () => {
  it("没到点不动;到点发出平仓单,记作 time_exit(不算止损)", async () => {
    const { engine, router, track } = build({ targets: { stop_loss: 1, exit_at: "12:30", exit_at_ms: NOON_MS + 30 * MIN } });
    expect((await engine.pollTrackers(at(29 * MIN))).fired).toEqual([]);
    expect(router.sent).toEqual([]);

    const poll = await engine.pollTrackers(at(30 * MIN));
    expect(poll.fired.map((f) => [f.state, f.reason])).toEqual([["time_exit", "到点平仓:已到美东 12:30"]]);
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0]!["order"].intent_summary).toMatch(/^到点平仓:卖出 1 SPX/);
    const after = engine.store.getTrack(track["id"])!;
    expect(after["fired_state"]).toBe("sweep:time_exit");
    expect(isStopLike(String(after["fired_state"]))).toBe(false);
    expect(engine.store.closeTraces().map((c) => c.state)).toEqual(["time_exit"]);

    // 只发一次
    await engine.pollTrackers(at(31 * MIN));
    expect(router.sent).toHaveLength(1);
  });

  it("同一轮止损也到了:记止损,那一句原因更具体", async () => {
    const { engine, router } = build({ targets: { stop_loss: 99, exit_at: "12:30", exit_at_ms: NOON_MS + 30 * MIN } });
    const poll = await engine.pollTrackers(at(30 * MIN));
    expect(poll.fired.map((f) => f.state)).toEqual(["stop_loss"]);
    expect(router.sent).toHaveLength(1);
  });

  it("到点那天没平掉(软件没开着 / 休市 / 被闸门挡着):过了那一天这一次作废,不补发;提醒一次,库里把时刻清掉", async () => {
    const { engine, router, track, notes } = build({ targets: { stop_loss: 1, exit_at: "12:30", exit_at_ms: NOON_MS + 30 * MIN } });
    const nextDay = 22 * 60 * MIN;                     // 第二天 10:00
    const poll = await engine.pollTrackers(at(nextDay));
    expect(poll.fired).toEqual([]);
    expect(poll.rows[0]!.state).toBe(tk.STATE_HOLDING);
    expect(router.sent).toEqual([]);
    expect(engine.store.getTrack(track["id"])!["targets"]).toMatchObject({ exit_at: "12:30", exit_at_ms: null });
    expect(notes.filter((n) => n.includes("到点平仓(美东 12:30)已经过期"))).toHaveLength(1);
    await engine.pollTrackers(at(nextDay + SEC));
    expect(notes.filter((n) => n.includes("已经过期"))).toHaveLength(1);
    // 止损照常管着
    router.rows = flyAt(7600);
    expect((await engine.pollTrackers(at(nextDay + 2 * SEC))).fired.map((f) => f.state)).toEqual(["stop_loss"]);
  });

  it("同一天里晚了(睡了一觉醒来、手动熔断解开):照发——还是同一天的这一次", async () => {
    const { engine, router } = build({ targets: { exit_at: "12:30", exit_at_ms: NOON_MS + 30 * MIN } });
    const poll = await engine.pollTrackers(at(3 * 60 * MIN));     // 15:00
    expect(poll.fired.map((f) => f.state)).toEqual(["time_exit"]);
    expect(router.sent).toHaveLength(1);
  });

  it("纯函数:到点只在那个美东日历日里算数;过了那一天是作废", () => {
    const t = tk.makeTargets({ exit_at: "23:30", exit_at_ms: NOON_MS + 11.5 * 60 * MIN });   // 当晚 23:30
    expect([ex.timeExitDue(t, NOON_MS), ex.timeExitLapsed(t, NOON_MS)]).toEqual([false, false]);
    expect([ex.timeExitDue(t, NOON_MS + 11.75 * 60 * MIN), ex.timeExitLapsed(t, NOON_MS + 11.75 * 60 * MIN)]).toEqual([true, false]);
    expect([ex.timeExitDue(t, NOON_MS + 12.5 * 60 * MIN), ex.timeExitLapsed(t, NOON_MS + 12.5 * 60 * MIN)]).toEqual([false, true]);   // 过了零点
    expect([ex.timeExitDue(tk.makeTargets({}), NOON_MS), ex.timeExitLapsed(tk.makeTargets({}), NOON_MS)]).toEqual([false, false]);
  });

  it("只提醒不平仓的追踪:到点提醒过一次之后,止损到了照样再提醒一次(不同的触发各说一次)", async () => {
    const { engine, router, notes } = build({
      targets: { stop_loss: 1, exit_at: "12:30", exit_at_ms: NOON_MS + 30 * MIN }, auto: { enabled: false },
    });
    await engine.pollTrackers(at(30 * MIN));
    await engine.pollTrackers(at(31 * MIN));
    expect(notes.filter((n) => n.includes("到点平仓") && n.includes("但没有平仓"))).toHaveLength(1);
    router.rows = flyAt(7600);
    await engine.pollTrackers(at(35 * MIN));
    await engine.pollTrackers(at(36 * MIN));
    expect(notes.filter((n) => n.includes("止损触发") && n.includes("但没有平仓"))).toHaveLength(1);
    expect(router.sent).toEqual([]);
  });

  it("托管的追踪:到点把组里的止盈单改到立刻成交的价,不另发平仓单", async () => {
    const { engine, router, track } = build({
      targets: { spot_target: 7740, exit_at: "12:30", exit_at_ms: NOON_MS + 30 * MIN }, auto: { host_at_broker: true },
    });
    await engine.pollTrackers(at());
    await engine.syncHosted();
    expect(router.placed).toHaveLength(1);
    const poll = await engine.pollTrackers(at(30 * MIN));
    await engine.syncHosted();
    expect(poll.fired.map((f) => f.state)).toEqual(["sweep:time_exit"]);
    expect(engine.store.getTrack(track["id"])!["fired_state"]).toBe("sweep:time_exit");
    expect(router.sent).toEqual([]);
    expect(router.modified[router.modified.length - 1]!.order_id).toBe(router.placed[0]!.order_id);
  });
});

describe("标的止损价的确认:盯盘", () => {
  it("越线先不平,行里写着待了多久;待够了才发单", async () => {
    const { engine, router, move } = build({ targets: { spot_stop_below: 7700, spot_stop_confirm_s: 3 } });
    await engine.pollTrackers(at());
    move(7698);
    const first = await engine.pollTrackers(at(1 * SEC));
    expect(first.fired).toEqual([]);
    expect(first.rows[0]!.spot_stop).toMatchObject({ hit: null, pending: { side: "below", held_s: 0, need_s: 3 } });
    expect((await engine.pollTrackers(at(3 * SEC))).fired).toEqual([]);
    const done = await engine.pollTrackers(at(4 * SEC));
    expect(done.fired.map((f) => f.reason)).toEqual(["标的止损触发:SPX 现价 7698.00 跌破 7700"]);
    expect(router.sent).toHaveLength(1);
  });

  it("中途回到线内:计时清掉,再越线从头数", async () => {
    const { engine, router, move } = build({ targets: { spot_stop_below: 7700, spot_stop_confirm_s: 3 } });
    move(7698);
    await engine.pollTrackers(at(0));
    await engine.pollTrackers(at(2 * SEC));
    move(7702);
    await engine.pollTrackers(at(3 * SEC));
    move(7698);
    await engine.pollTrackers(at(4 * SEC));
    await engine.pollTrackers(at(6 * SEC));   // 这一次越线只待了 2 秒
    expect(router.sent).toEqual([]);
    await engine.pollTrackers(at(7 * SEC));
    expect(router.sent).toHaveLength(1);
  });

  it("没设确认秒数:触线即算,和以前一样", async () => {
    const { engine, router } = build({ targets: { spot_stop_below: 7700 }, spot: 7698 });
    await engine.pollTrackers(at());
    expect(router.sent).toHaveLength(1);
  });
});

describe("止损按可成交价判:盯盘", () => {
  const rows = flyAt(7720);
  const mid = midOf(rows), natural = naturalOf(rows);
  /** 夹在可成交价与中间价之间的一条止损线 */
  const stop = pyRound((mid + natural) / 2, 2);

  it("这个假盘口里可成交价低于中间价(测试的前提)", () => {
    expect(natural).toBeLessThan(stop);
    expect(stop).toBeLessThan(mid);
  });

  it("按中间价判(默认):不触发", async () => {
    const { engine, router } = build({ targets: { stop_loss: stop } });
    const poll = await engine.pollTrackers(at());
    expect(poll.rows[0]!.state).toBe(tk.STATE_HOLDING);
    expect(poll.rows[0]!.stop_price).toBeUndefined();
    expect(router.sent).toEqual([]);
  });

  it("按可成交价判:触发,平仓单挂在同一个可成交价上", async () => {
    const { engine, router } = build({ targets: { stop_loss: stop }, auto: { stop_basis: "natural" } });
    const poll = await engine.pollTrackers(at());
    expect(poll.fired.map((f) => [f.state, f.reason])).toEqual([
      ["stop_loss", `止损触发:可成交价 ${natural.toFixed(4)} 跌破 ${stop.toFixed(4)}`],
    ]);
    expect(router.sent).toHaveLength(1);
  });

  it("这一轮拿不到各腿买卖价:退回中间价判——中间价没破线就不触发,行里标着是退回去的,峰值不推", async () => {
    const { engine, router, track } = build({ targets: { stop_loss: stop, trail_pct: 90 }, auto: { stop_basis: "natural" } });
    router.quotes = false;
    const poll = await engine.pollTrackers(at());
    expect(poll.rows[0]!.state).toBe(tk.STATE_HOLDING);
    expect(poll.rows[0]!.stop_price).toBe(mid);
    expect(poll.rows[0]!.stop_fallback).toBe(true);
    expect(engine.store.getTrack(track["id"])!["peak"]).toBeNull();   // 可成交价口径的峰值,不拿中间价去推
    expect(router.sent).toEqual([]);
  });

  it("腿一直没有报价、中间价自己也破了线:照样触发——不会因为盘口没了就瞎掉", async () => {
    const { engine, router } = build({ targets: { stop_loss: pyRound(mid + 1, 2) }, auto: { stop_basis: "natural" }, peak: null });
    router.quotes = false;
    const poll = await engine.pollTrackers(at());
    expect(poll.rows[0]!.state).toBe("stop_loss");
    expect(poll.rows[0]!.stop_fallback).toBe(true);
  });

  it("盘口宽到合成出来的可成交价不是正数:同样退回中间价,不是「这一轮不判」", async () => {
    const { engine, router } = build({ targets: { stop_loss: pyRound(mid + 1, 2) }, auto: { stop_basis: "natural" } });
    // 每条腿的买卖价差拉到 6 块:两翼按买价卖、中心按卖价买回,净价是负的
    router.optionQuotes = async (rows: Rec[]) => Object.fromEntries(rows.map((r) => [r["key"], { bid: Math.max(0, Number(r["market_price"]) - 3), ask: Number(r["market_price"]) + 3 }]));
    const poll = await engine.pollTrackers(at());
    expect(poll.rows[0]!.stop_fallback).toBe(true);
    expect(poll.rows[0]!.state).toBe("stop_loss");
  });

  it("峰值也按可成交价记", async () => {
    const { engine, track } = build({ targets: { trail_pct: 90 }, auto: { stop_basis: "natural" } });
    await engine.pollTrackers(at());
    expect(engine.store.getTrack(track["id"])!["peak"]).toBe(natural);
  });
});

describe("推峰值要连续两轮:盯盘", () => {
  it("没打开(默认):每一轮的价都能推峰值,一笔高价之后回落就是一次跟踪止损——和以前一样", async () => {
    const { engine, track, move } = build({ targets: { trail_pct: 20 } });
    const high = midOf(flyAt(7745));
    await engine.pollTrackers(at(0));
    await engine.pollTrackers(at(SEC));
    move(7745);
    await engine.pollTrackers(at(2 * SEC));
    expect(engine.store.getTrack(track["id"])!["peak"]).toBe(high);
    move(7720);
    expect((await engine.pollTrackers(at(3 * SEC))).fired.map((f) => f.state)).toEqual(["stop_loss"]);
  });

  it("只出现一轮的高价不进峰值;连着两轮才进", async () => {
    const { engine, track, move } = build({ targets: { trail_pct: 90 }, auto: { peak_confirm: true } });
    const calm = midOf(flyAt(7720)), high = midOf(flyAt(7745));
    expect(high).toBeGreaterThan(calm);
    const peak = (): number | null => engine.store.getTrack(track["id"])!["peak"];

    await engine.pollTrackers(at(0));
    expect(peak()).toBeNull();          // 头一轮:还没有上一轮可比
    await engine.pollTrackers(at(SEC));
    expect(peak()).toBe(calm);
    move(7745);                          // 一轮高价
    await engine.pollTrackers(at(2 * SEC));
    expect(peak()).toBe(calm);
    move(7720);                          // 落回来
    await engine.pollTrackers(at(3 * SEC));
    expect(peak()).toBe(calm);
    move(7745);                          // 这一次连着两轮
    await engine.pollTrackers(at(4 * SEC));
    await engine.pollTrackers(at(5 * SEC));
    expect(peak()).toBe(high);
  });

  it("托管对账和盯盘同一轮:问到的是同一个价,不会把那一笔高价推进峰值", async () => {
    const { engine, track, move } = build({ targets: { spot_target: 7748, trail_pct: 90 }, auto: { host_at_broker: true, peak_confirm: true } });
    const calm = midOf(flyAt(7720));
    const round = async (plus: number): Promise<void> => {
      const rows = await (engine.router as any).positions();
      await engine.pollTrackers(at(plus), rows);
      await engine.syncHosted(rows);
    };
    await round(0);
    await round(SEC);
    move(7745);
    await round(2 * SEC);
    expect(engine.store.getTrack(track["id"])!["peak"]).toBe(calm);
  });
});

describe("分批止盈:盯盘", () => {
  /** 3 组蝶;第一档夹在 7720 与 7735 的蝶价之间,第二档夹在 7735 与 7748 之间 */
  const m20 = midOf(flyAt(7720)), m35 = midOf(flyAt(7735)), m48 = midOf(flyAt(7748));
  const tier1 = pyRound((m20 + m35) / 2, 2), tier2 = pyRound((m35 + m48) / 2, 2);
  const tiers = [{ price: tier1, fraction_pct: 34 }, { price: tier2, fraction_pct: 50 }];
  const filled = (engine: TradingEngine, orderId: number): void =>
    engine.onOrderStatus({ order: { orderId }, orderStatus: { status: "Filled", filled: 1, remaining: 0 } });

  it("前提:三个蝶价一个比一个高", () => {
    expect(m20).toBeLessThan(tier1);
    expect(tier1).toBeLessThan(m35);
    expect(m35).toBeLessThan(tier2);
    expect(tier2).toBeLessThan(m48);
  });

  it("到第一档:平 34%(3 组里的 1 组),这一档记成在等成交,追踪落闩", async () => {
    const { engine, router, track, move } = build({ targets: { take_profit_tiers: tiers }, lots: 3 });
    expect((await engine.pollTrackers(at())).fired).toEqual([]);
    move(7735, 3);
    const poll = await engine.pollTrackers(at(SEC));
    expect(poll.fired.map((f) => f.state)).toEqual([tk.STATE_TAKE_PROFIT]);
    expect(poll.fired[0]!.reason).toMatch(/^分批止盈第 1 档:现价 .* 涨到 .*,平 34%$/);
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0]!["order"].order.totalQuantity).toBe(1);
    const after = engine.store.getTrack(track["id"])!;
    expect(after["enabled"]).toBe(false);
    expect(after["fired_state"]).toBe("sweep:take_profit");
    expect(after["targets"]["take_profit_tiers"]).toEqual([{ ...tiers[0], pending: true, pending_qty: 3 }, tiers[1]]);
  });

  it("这一档整张成交:划掉、解开闩,接着盯剩下的 2 组;到第二档平 50%(1 组)", async () => {
    const { engine, router, track, notes, move } = build({ targets: { take_profit_tiers: tiers }, lots: 3 });
    move(7735, 3);
    await engine.pollTrackers(at(SEC));
    filled(engine, 991);
    move(7735, 2);                                   // 持仓剩 2 组
    const rearm = await engine.pollTrackers(at(2 * SEC));
    expect(rearm.fired).toEqual([]);
    const live = engine.store.getTrack(track["id"])!;
    expect(live["enabled"]).toBe(true);
    expect(live["fired_at"]).toBeNull();
    expect(live["fired_state"]).toBe("");
    expect(live["targets"]["take_profit_tiers"]).toEqual([{ ...tiers[0], done: true }, tiers[1]]);
    expect(notes).toContain("分批止盈|SPX:第 1 档已成交,还有 1 档,剩下的仓接着盯");

    // 第一档已经做完:价还在它上面也不再触发
    expect((await engine.pollTrackers(at(3 * SEC))).fired).toEqual([]);
    expect(router.sent).toHaveLength(1);

    move(7748, 2);
    const second = await engine.pollTrackers(at(4 * SEC));
    expect(second.fired[0]!.reason).toMatch(/^分批止盈第 2 档/);
    expect(router.sent).toHaveLength(2);
    expect(router.sent[1]!["order"].order.totalQuantity).toBe(1);
  });

  it("平仓单被撤了:不解闩,这一档还在等——持仓和预想的不一样,由人看一眼", async () => {
    const { engine, router, track, move } = build({ targets: { take_profit_tiers: tiers }, lots: 3 });
    move(7735, 3);
    await engine.pollTrackers(at(SEC));
    engine.onOrderStatus({ order: { orderId: 991 }, orderStatus: { status: "Cancelled", filled: 0, remaining: 1 } });
    await engine.pollTrackers(at(2 * SEC));
    await engine.pollTrackers(at(3 * SEC));
    const after = engine.store.getTrack(track["id"])!;
    expect(after["enabled"]).toBe(false);
    expect(after["targets"]["take_profit_tiers"]?.[0]).toMatchObject({ pending: true });
    expect(router.sent).toHaveLength(1);
  });

  it("引擎重建之后也接得上:成交的终态在库里,新引擎下一轮照样解闩", async () => {
    const first = build({ targets: { take_profit_tiers: tiers }, lots: 3 });
    first.move(7735, 3);
    await first.engine.pollTrackers(at(SEC));
    filled(first.engine, 991);
    const engine = new TradingEngine({
      settings: first.engine.settings, parser: {} as any, store: first.engine.store,
      notifier: new Notifier(false), router: first.router as any,
    });
    first.move(7735, 2);
    await engine.pollTrackers(at(2 * SEC));
    expect(engine.store.getTrack(first.track["id"])!["enabled"]).toBe(true);
  });

  it("成交发生在引擎不在的时候(软件关着、断线重建):追踪还停在「追价平仓中」,新引擎照样认得、接着盯剩下的仓", async () => {
    const first = build({ targets: { take_profit_tiers: tiers, stop_loss: 1 }, lots: 3 });
    first.move(7735, 3);
    await first.engine.pollTrackers(at(SEC));
    const recordId = String(first.engine.store.getTrack(first.track["id"])!["fired_record"]);
    // 成交回报没有到过这个引擎:追踪的状态还是 sweep:take_profit。重启后执行对账把终态补进记录(这里直接写,对账做的就是这件事)
    first.engine.store.setFinalStatus(recordId, "filled");
    expect(first.engine.store.getTrack(first.track["id"])!["fired_state"]).toBe("sweep:take_profit");
    const engine = new TradingEngine({
      settings: first.engine.settings, parser: {} as any, store: first.engine.store,
      notifier: new Notifier(false), router: first.router as any,
    });
    first.move(7735, 2);
    await engine.pollTrackers(at(2 * SEC));
    const live = engine.store.getTrack(first.track["id"])!;
    expect(live["enabled"]).toBe(true);
    expect(live["fired_state"]).toBe("");
    expect(live["targets"]["take_profit_tiers"]?.[0]).toEqual({ ...tiers[0], done: true });
    // 剩下的 2 组止损照常:蝶价跌破 1 就平
    first.router.rows = flyAt(7600, 2);
    const stop = await engine.pollTrackers(at(3 * SEC));
    expect(stop.fired.map((f) => f.state)).toEqual(["stop_loss"]);
    expect(first.router.sent[first.router.sent.length - 1]!["order"].order.totalQuantity).toBe(2);
  });

  it("成交回报先到、持仓推送晚一拍:读到的持仓还没少之前不解闩——不然下一档按没减的数量去平,平过头就是反向开仓", async () => {
    const { engine, router, track, move } = build({ targets: { take_profit_tiers: [{ price: tier1, fraction_pct: 50 }, { price: tier2, fraction_pct: 100 }] }, lots: 4 });
    move(7748, 4);                                   // 一步冲过两档
    await engine.pollTrackers(at(SEC));
    expect(router.sent[0]!["order"].order.totalQuantity).toBe(2);
    filled(engine, 991);
    // 持仓这一轮还是 4 组(推送没到):不解闩、不发第二档
    await engine.pollTrackers(at(2 * SEC));
    expect(engine.store.getTrack(track["id"])!["enabled"]).toBe(false);
    expect(router.sent).toHaveLength(1);
    move(7748, 2);                                   // 推送到了:剩 2 组
    await engine.pollTrackers(at(3 * SEC));
    expect(engine.store.getTrack(track["id"])!["enabled"]).toBe(true);
    const second = await engine.pollTrackers(at(4 * SEC));
    expect(second.fired[0]!.reason).toMatch(/^分批止盈第 2 档/);
    expect(router.sent[1]!["order"].order.totalQuantity).toBe(2);   // 平的是剩下的 2 组,不是 4 组
  });

  it("1 组的仓:第一档至少平 1 组,就是全平,追踪到此为止", async () => {
    const { engine, router, track, move } = build({ targets: { take_profit_tiers: tiers } });
    move(7735);
    await engine.pollTrackers(at(SEC));
    expect(router.sent[0]!["order"].order.totalQuantity).toBe(1);
    filled(engine, 991);
    router.rows = [];
    const poll = await engine.pollTrackers(at(2 * SEC));
    expect(poll.rows[0]!.state).toBe("closed");
    expect(engine.store.getTrack(track["id"])!["enabled"]).toBe(false);
  });

  it("重新启用一条卡在「等成交」的追踪:那一档跟着解开", async () => {
    const { s, router, call } = makeServer(flyAt(7720, 3), 7720);
    const key = bagOf(router.rows)["key"];
    const id = (await call("tracker.add", ui(key, { take_profit_tiers: tiers.map((t) => ({ price: String(t.price), fraction_pct: String(t.fraction_pct) })), auto_close: true })))["result"]["track"]["id"];
    const stored = s.engine.store.getTrack(id)!;
    s.engine.store.updateTrack(id, {
      enabled: false, fired_at: "2026-09-10T12:00:01-04:00", fired_state: "take_profit",
      targets: { ...stored["targets"], take_profit_tiers: ex.markTier(stored["targets"]["take_profit_tiers"]!, 0, { pending: true }) },
    });
    const out = await call("tracker.update", { id, enabled: true });
    expect(out["result"]["track"]["targets"]["take_profit_tiers"][0]).toEqual({ price: tier1, fraction_pct: 34 });
    expect(out["result"]["track"]["fired_state"]).toBe("");
  });
});

// ---------------------------------------------------------------- 3. RPC:界面的载荷
function makeServer(rows: Rec[], spot: number | null): { s: RpcServer; router: FakeRouter; call: (m: string, p?: Rec) => Promise<Rec> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-exits-rpc-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
  const s = new RpcServer(settingsPath, () => undefined);
  const router = new FakeRouter(rows, spot);
  s.router = router as never;
  servers.push(s);
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { s, router, call };
}

/** lib/TrackForm.tsx 的 start() 拼出来的载荷:数值都是字符串,'' = 不设 */
const ui = (key: string, over: Rec): Rec => ({
  key, take_profit: "", stop_loss: "", trail_pct: "", profit_drawdown_pct: "", profit_drawdown_arm_pct: "", spot_target: "",
  spot_stop_below: "", spot_stop_above: "", spot_stop_confirm_s: "", exit_at: "", take_profit_tiers: "",
  auto_close: false, order_type: "LMT", host_at_broker: false, ...over,
});

describe("出场细则:tracker.add / tracker.update(界面的原样载荷)", () => {
  const KEY = bagOf(flyAt(7720))["key"] as string;
  const errorOf = async (call: (m: string, p?: Rec) => Promise<Rec>, over: Rec): Promise<Rec> => (await call("tracker.add", ui(KEY, over)))["error"];

  it("'' = 不设:四个键都是 null,止损的口径是 mid,追价节奏三项是 null", async () => {
    const { call } = makeServer(flyAt(7720), 7720);
    const out = await call("tracker.add", ui(KEY, { stop_loss: "1" }));
    expect(out["result"]["track"]["targets"]).toMatchObject({
      exit_at: null, exit_at_ms: null, spot_stop_confirm_s: null, take_profit_tiers: null,
    });
    expect(out["result"]["track"]["auto_close"]).toMatchObject({
      stop_basis: "mid", stop_chase_grace: null, stop_chase_step: null, stop_chase_max_pct: null,
    });
  });

  it("到点平仓:只填这一项就能建;钟点换成下一次到这个钟点的时刻", async () => {
    setClock(NOON_MS);
    const { call } = makeServer(flyAt(7720), 7720);
    const out = await call("tracker.add", ui(KEY, { exit_at: "15:45" }));
    expect(out["error"]).toBeUndefined();
    expect(out["result"]["track"]["targets"]).toMatchObject({
      exit_at: "15:45", exit_at_ms: ex.nextOccurrenceMs("15:45", NOON_MS),
    });
    expect((await errorOf(makeServer(flyAt(7720), 7720).call, { exit_at: "1545" }))).toEqual({
      code: -32602, message: "到点平仓的时刻要写成美东时间的 HH:MM(如 15:45),收到「1545」。",
    });
  });

  it("确认秒数:存成数字;0 = 不设;没有标的止损价、超范围:拒", async () => {
    const { call } = makeServer(flyAt(7720), 7720);
    const ok = await call("tracker.add", ui(KEY, { spot_stop_below: "7700", spot_stop_confirm_s: "3" }));
    expect(ok["result"]["track"]["targets"]["spot_stop_confirm_s"]).toBe(3);
    const zero = makeServer(flyAt(7720), 7720);
    expect((await zero.call("tracker.add", ui(KEY, { spot_stop_below: "7700", spot_stop_confirm_s: "0" })))["result"]["track"]["targets"]["spot_stop_confirm_s"]).toBeNull();
    const other = makeServer(flyAt(7720), 7720);
    expect(await errorOf(other.call, { stop_loss: "1", spot_stop_confirm_s: "3" })).toEqual({
      code: -32602, message: "确认秒数是给标的止损价用的:先填「标的跌到」或「标的涨到」。",
    });
    expect((await errorOf(other.call, { spot_stop_below: "7700", spot_stop_confirm_s: "601" }))["message"]).toMatch(/确认秒数要在 0 到 600 之间/);
  });

  it("分批止盈:存成数字;方向不对、托管、形状不对:拒", async () => {
    const mid = midOf(flyAt(7720));
    const up = (n: number): string => String(pyRound(mid + n, 2));
    const { call } = makeServer(flyAt(7720, 3), 7720);
    const ok = await call("tracker.add", ui(KEY, { take_profit_tiers: [{ price: up(1), fraction_pct: "34" }, { price: up(2), fraction_pct: "50" }] }));
    expect(ok["result"]["track"]["targets"]["take_profit_tiers"]).toEqual([
      { price: Number(up(1)), fraction_pct: 34 }, { price: Number(up(2)), fraction_pct: 50 },
    ]);
    const bad = makeServer(flyAt(7720, 3), 7720);
    expect((await errorOf(bad.call, { take_profit_tiers: [{ price: String(pyRound(mid - 1, 2)), fraction_pct: "34" }] }))["message"]).toMatch(/^分批止盈第 1 档要高于现价/);
    expect((await errorOf(bad.call, { take_profit_tiers: [{ price: up(2), fraction_pct: "34" }, { price: up(1), fraction_pct: "50" }] }))["message"]).toMatch(/一档比一档高/);
    expect((await errorOf(bad.call, { take_profit_tiers: [{ price: up(1), fraction_pct: "" }] }))["message"]).toBe("分批止盈的 price 与 fraction_pct 都不能空");
    expect((await errorOf(bad.call, { take_profit_tiers: [{ price: up(1), fraction_pct: "34", extra: 1 }] }))["message"]).toMatch(/不认识的键/);
    expect((await errorOf(bad.call, {
      take_profit_tiers: [{ price: up(1), fraction_pct: "34" }], spot_target: "7740", auto_close: true, host_at_broker: true,
    }))["message"]).toMatch(/^分批止盈只支持软件盯盘/);
  });

  it("止损按可成交价判:存上;正股拒;止损价不在可成交价的保护一侧拒;峰值从可成交价起步", async () => {
    const rows = flyAt(7720);
    const mid = midOf(rows), natural = naturalOf(rows);
    const between = String(pyRound((mid + natural) / 2, 2));
    const { s, call } = makeServer(rows, 7720);
    expect((await errorOf(call, { stop_loss: between, stop_basis: "natural" }))["message"]).toMatch(/^止损按可成交价判:止损价 .* 不低于此刻立刻能成交的价/);
    expect((await errorOf(call, { stop_loss: "1", stop_basis: "bid" }))["message"]).toBe("stop_basis 只能是 mid 或 natural,收到「bid」");
    const ok = await call("tracker.add", ui(KEY, { stop_loss: "0.5", stop_basis: "natural" }));
    expect(ok["result"]["track"]["auto_close"]["stop_basis"]).toBe("natural");
    expect(s.engine.store.getTrack(ok["result"]["track"]["id"])!["peak"]).toBe(natural);

    const stock: Rec = {
      key: tk.makeKey("模拟", "BE", "STK"), account: "模拟", symbol: "BE", sec_type: "STK", leg: "", quantity: 100,
      avg_cost: 100, multiplier: 1, currency: "USD", market_price: 120, market_value: 12000, unrealized_pnl: 2000,
      contract: { secType: "STK", symbol: "BE" },
    };
    const other = makeServer([stock], 120);
    const refused = await other.call("tracker.add", ui(stock["key"], { stop_loss: "95", stop_basis: "natural", order_type: "MKT" }));
    expect(refused["error"]["message"]).toBe("「止损按可成交价判」只给期权与组合用:正股的现价就是成交价。");
  });

  it("改口径:目标不动,峰值按新口径从此刻起步", async () => {
    const rows = flyAt(7720);
    const { s, call } = makeServer(rows, 7720);
    const id = (await call("tracker.add", ui(KEY, { stop_loss: "0.5", trail_pct: "50" })))["result"]["track"]["id"];
    expect(s.engine.store.getTrack(id)!["peak"]).toBe(midOf(rows));
    const out = await call("tracker.update", { id, auto_close: { stop_basis: "natural" } });
    expect(out["error"]).toBeUndefined();
    expect(out["result"]["track"]["targets"]).toMatchObject({ stop_loss: 0.5, trail_pct: 50 });
    expect(out["result"]["track"]["peak"]).toBe(naturalOf(rows));
  });

  it("止损类的追价节奏:存上;范围不对拒;update 里给 null = 回到和止盈同一套", async () => {
    const { call } = makeServer(flyAt(7720), 7720);
    const ok = await call("tracker.add", ui(KEY, { stop_loss: "1", stop_chase_grace: "0", stop_chase_step: "2", stop_chase_max_pct: "25" }));
    expect(ok["result"]["track"]["auto_close"]).toMatchObject({ stop_chase_grace: 0, stop_chase_step: 2, stop_chase_max_pct: 25 });
    const id = ok["result"]["track"]["id"];
    const back = await call("tracker.update", { id, auto_close: { stop_chase_step: null } });
    expect(back["result"]["track"]["auto_close"]).toMatchObject({ stop_chase_grace: 0, stop_chase_step: null, stop_chase_max_pct: 25 });
    expect((await call("tracker.update", { id, auto_close: { stop_chase_step: 0 } }))["error"]["message"]).toMatch(/每轮让的跳数要是 1 到 20 之间的整数/);
    const other = makeServer(flyAt(7720), 7720);
    expect((await errorOf(other.call, { stop_loss: "1", stop_chase_grace: "1.5" }))["message"]).toMatch(/先等的轮数要是 0 到 60 之间的整数/);
    expect((await errorOf(other.call, { stop_loss: "1", stop_chase_max_pct: "101" }))["message"]).toMatch(/让价上限/);
  });

  it("峰值要连续两秒确认:默认关;勾了存上;正股拒;update 里能关掉", async () => {
    const { call } = makeServer(flyAt(7720), 7720);
    expect((await call("tracker.add", ui(KEY, { stop_loss: "1" })))["result"]["track"]["auto_close"]["peak_confirm"]).toBe(false);
    const on = makeServer(flyAt(7720), 7720);
    const ok = await on.call("tracker.add", ui(KEY, { trail_pct: "30", peak_confirm: true }));
    expect(ok["result"]["track"]["auto_close"]["peak_confirm"]).toBe(true);
    const off = await on.call("tracker.update", { id: ok["result"]["track"]["id"], auto_close: { peak_confirm: false } });
    expect(off["result"]["track"]["auto_close"]["peak_confirm"]).toBe(false);
    const stock: Rec = {
      key: tk.makeKey("模拟", "BE", "STK"), account: "模拟", symbol: "BE", sec_type: "STK", leg: "", quantity: 100,
      avg_cost: 100, multiplier: 1, currency: "USD", market_price: 120, market_value: 12000, unrealized_pnl: 2000,
      contract: { secType: "STK", symbol: "BE" },
    };
    const refused = await makeServer([stock], 120).call("tracker.add", ui(stock["key"], { trail_pct: "5", peak_confirm: true, order_type: "MKT" }));
    expect(refused["error"]["message"]).toBe("「峰值要连续两秒确认」只给期权与组合用:正股的现价不是几条腿拼出来的。");
  });

  it("止损按可成交价判:这条券商通道取不到各腿买卖价(富途)就不给设", async () => {
    const { router, call } = makeServer(flyAt(7720), 7720);
    (router as any).optionQuotes = undefined;
    expect((await errorOf(call, { stop_loss: "0.5", stop_basis: "natural" }))["message"]).toBe("这条券商通道取不到各腿的买卖价,用不了「止损按可成交价判」:改回按中间价判。");
  });

  it("到点平仓的时刻落在合约到期之后:拒——今天的钟点过了换算出来是明天,当日到期的蝶那时已经不在了", async () => {
    setClock(NOON_MS + 3.8 * 60 * MIN);                                       // 到期日 15:48
    const dated = flyAt(7720).map((r) => ({ ...r, contract: { ...r["contract"], tradingClass: "SPXW" } }));
    const { call } = makeServer(dated, 7720);
    const key = bagOf(dated)["key"] as string;
    const late = await call("tracker.add", ui(key, { exit_at: "15:45" }));
    expect(late["error"]["message"]).toMatch(/^到点平仓「15:45」下一次到点是美东 09\/11 15:45,而这份持仓 09\/10 16:00 就到期了/);
    // 把下午三点五十写成 3:50:换算出来是明天凌晨,同样拒
    expect((await call("tracker.add", ui(key, { exit_at: "3:50" })))["error"]["message"]).toMatch(/^到点平仓「3:50」/);
    // 还没到的钟点:照常
    expect((await call("tracker.add", ui(key, { exit_at: "15:55" })))["error"]).toBeUndefined();
  });

  it("恢复一条到点平仓已经触发过(或过期)的追踪:时刻换成下一次到这个钟点,不会一恢复就又到点", async () => {
    setClock(NOON_MS);
    const { s, call } = makeServer(flyAt(7720), 7720);
    const id = (await call("tracker.add", ui(KEY, { exit_at: "12:30" })))["result"]["track"]["id"];
    const stored = s.engine.store.getTrack(id)!;
    setClock(NOON_MS + 40 * MIN);                                              // 12:40:那一次已经触发过了
    s.engine.store.updateTrack(id, { enabled: false, fired_at: "2026-09-10T12:30:00-04:00", fired_state: "time_exit" });
    const out = await call("tracker.update", { id, enabled: true });
    expect(out["result"]["track"]["targets"]["exit_at_ms"]).toBe(ex.nextOccurrenceMs("12:30", NOON_MS + 40 * MIN));
    expect(out["result"]["track"]["targets"]["exit_at_ms"]).toBeGreaterThan(Number(stored["targets"]["exit_at_ms"]));
    // 过期作废的(时刻被清掉了)同理
    s.engine.store.updateTrack(id, { enabled: false, targets: { ...stored["targets"], exit_at_ms: null } });
    expect((await call("tracker.update", { id, enabled: true }))["result"]["track"]["targets"]["exit_at_ms"]).toBe(ex.nextOccurrenceMs("12:30", NOON_MS + 40 * MIN));
  });

  describe("分批止盈:恢复、改目标、立即平仓", () => {
    const mid = midOf(flyAt(7720));
    const up = (n: number): string => String(pyRound(mid + n, 2));
    const tiersUi = [{ price: up(1), fraction_pct: "34" }, { price: up(2), fraction_pct: "50" }];
    /** 建一条带两档的追踪,并把它摆成"第一档的平仓单已经发出"的样子;recordFinal 给那张单的终态(null = 还挂着) */
    async function pendingTier(recordFinal: string | null) {
      const { s, router, call } = makeServer(flyAt(7720, 3), 7720);
      const id = (await call("tracker.add", ui(KEY, { take_profit_tiers: tiersUi, stop_loss: "1", auto_close: true })))["result"]["track"]["id"] as string;
      const stored = s.engine.store.getTrack(id)!;
      const recordId = s.engine.store.createRecord({ input: { input_channel: "tracker" }, contract: {}, order: {} });
      if (recordFinal !== null) s.engine.store.setFinalStatus(recordId, recordFinal);
      s.engine.store.updateTrack(id, {
        enabled: false, fired_at: "2026-09-10T12:00:01-04:00", fired_state: "sweep:take_profit", fired_record: recordId,
        targets: { ...stored["targets"], take_profit_tiers: ex.markTier(stored["targets"]["take_profit_tiers"]!, 0, { pending: true, pending_qty: 3 }) },
      });
      return { s, router, call, id };
    }

    it("恢复:那张平仓单还没有终态 → 不许(它成交之后同一档会再平一次)", async () => {
      const { s, call, id } = await pendingTier(null);
      const out = await call("tracker.update", { id, enabled: true });
      expect(out["error"]["message"]).toMatch(/^分批止盈第 1 档的平仓单还没有终态,它可能还挂在券商那边/);
      expect(s.engine.store.getTrack(id)!["enabled"]).toBe(false);
    });

    it("恢复:那张单撤了 → 这一档解开,可以再触发;成交了 → 这一档算做完", async () => {
      const cancelled = await pendingTier("cancelled");
      const a = await cancelled.call("tracker.update", { id: cancelled.id, enabled: true });
      expect(a["result"]["track"]["targets"]["take_profit_tiers"][0]).toEqual({ price: Number(up(1)), fraction_pct: 34 });
      const filled = await pendingTier("filled");
      const b = await filled.call("tracker.update", { id: filled.id, enabled: true });
      expect(b["result"]["track"]["targets"]["take_profit_tiers"][0]).toEqual({ price: Number(up(1)), fraction_pct: 34, done: true });
    });

    it("有一档在等成交时不许改目标;立即平仓也照实说:那张单只有这一档的数量", async () => {
      const { call, id } = await pendingTier(null);
      const edit = await call("tracker.update", { id, stop_loss: "2", take_profit_tiers: tiersUi });
      expect(edit["error"]["message"]).toMatch(/^分批止盈有一档的平仓单还在等成交,这时不能改目标/);
      const close = await call("tracker.close_now", { id });
      expect(close["error"]["message"]).toMatch(/^分批止盈第 1 档的平仓单正在追价成交,它只平这一档的数量。等它成交/);
    });

    it("改目标而档位没变:做完的那一档照旧算做完;档位改了:从头来", async () => {
      const { s, call, id } = await pendingTier("filled");
      await call("tracker.update", { id, enabled: true });                    // 第一档做完,追踪接着盯
      const same = await call("tracker.update", { id, stop_loss: "2", take_profit_tiers: tiersUi });
      expect(same["error"]).toBeUndefined();
      expect(same["result"]["track"]["targets"]["stop_loss"]).toBe(2);
      expect(same["result"]["track"]["targets"]["take_profit_tiers"]).toEqual([
        { price: Number(up(1)), fraction_pct: 34, done: true }, { price: Number(up(2)), fraction_pct: 50 },
      ]);
      const changed = await call("tracker.update", { id, stop_loss: "2", take_profit_tiers: [{ price: up(1.5), fraction_pct: "34" }, { price: up(2), fraction_pct: "50" }] });
      expect(changed["result"]["track"]["targets"]["take_profit_tiers"]).toEqual([
        { price: Number(up(1.5)), fraction_pct: 34 }, { price: Number(up(2)), fraction_pct: 50 },
      ]);
      expect(s.engine.store.getTrack(id)!["enabled"]).toBe(true);
    });

    it("只改自动平仓设置把托管打开:带着分批止盈的追踪不许", async () => {
      const { call } = makeServer(flyAt(7720, 3), 7720);
      const id = (await call("tracker.add", ui(KEY, { take_profit_tiers: tiersUi, spot_stop_below: "7600", auto_close: true })))["result"]["track"]["id"];
      const out = await call("tracker.update", { id, auto_close: { host_at_broker: true } });
      expect(out["error"]["message"]).toMatch(/^分批止盈只支持软件盯盘/);
    });
  });

  it("键名写错一个字母:strict schema 当场拒", async () => {
    const { call } = makeServer(flyAt(7720), 7720);
    expect((await call("tracker.add", { ...ui(KEY, { stop_loss: "1" }), exit_att: "15:45" }))["error"]["message"]).toMatch(/有不认识的键:exit_att/);
  });
});
