/** SPX 日内剧本的编排(services/playbook.ts + playbookLog.ts)。
 *
 * 它在后台自己跑、自己订行情,所以要钉的是:哪一条区间在哪个时刻取、写进哪一天的底账;没赶上的怎么补、补不到怎么说;
 * 什么时候一条行情都不许订;事件报一次、重启之后不重报。全部离线:券商与会话是假的,时钟是钉住的。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setClock } from "../src/config.js";
import type { IbContract, RawBar, TickerData } from "../src/ibTypes.js";
import { EM_FACTOR } from "../src/playbook.js";
import { PlaybookLog } from "../src/playbookLog.js";
import { RpcServer } from "../src/rpc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

/** 2026-09-28 是周一;九月是夏令时 */
const at = (hhmm: string, day = "2026-09-28"): number => Date.parse(`${day}T${hhmm}:00-04:00`);

class FakeSession {
  subscribed: string[] = [];
  history: string[] = [];
  accounts = ["DU7654321"];
  /** "行权价+方向" → 盘口;没登记的给默认 */
  ticks: Record<string, Partial<TickerData>> = {};
  /** "合约|YYYY-MM-DD HH:MM" → 那根分钟线的开盘价 */
  minutes: Record<string, number> = {};
  isConnected(): boolean { return true; }
  managedAccounts(): string[] { return this.accounts; }
  async qualifyContracts(contracts: IbContract[]): Promise<void> {
    for (const c of contracts) c.conId = c.secType === "IND" ? 416904 : 900000 + Number(c.strike) * 2 + (c.right === "C" ? 1 : 0);
  }
  reqMarketDataType(): void { /* 不关心 */ }
  subscribeTicker(c: IbContract, generic = ""): { read(): TickerData } {
    this.subscribed.push(`${c.lastTradeDateOrContractMonth} ${c.strike}${c.right} ${c.tradingClass} #${generic}`);
    const base = { bid: 9.9, ask: 10.1, modelGreeks: { gamma: null, impliedVol: 0.15 }, error: null };
    return { read: () => ({ ...base, ...this.ticks[`${c.strike}${c.right}`] }) as TickerData };
  }
  cancelTicker(): void { /* 不关心 */ }
  async settle(): Promise<void> { /* 假时钟:不等 */ }
  async historicalData(c: IbContract, opts: Rec): Promise<RawBar[]> {
    const name = c.secType === "IND" ? "SPX" : `${c.lastTradeDateOrContractMonth} ${c.strike}${c.right}`;
    this.history.push(`${name} ${opts["whatToShow"]} ${opts["endDateTime"]}`);
    return Object.entries(this.minutes)
      .filter(([key]) => key.startsWith(`${name}|`))
      .map(([key, open]) => {
        const stamp = key.split("|")[1] ?? "";
        return { date: `${stamp.slice(0, 10).replace(/-/g, "")} ${stamp.slice(11)}:00 US/Eastern`, open, high: open, low: open, close: open };
      });
  }
}

class FakeRouter {
  session = new FakeSession();
  spot: number | null = 7718.4;
  source = "index";
  /** 日线收盘:日期 → 价 */
  closes: Record<string, number> = { "2026-09-25": 7701.2, "2026-09-28": 7733.3 };
  chainCalls = 0;
  /** 每次取链时要的档数、点数范围与点名的交易类 */
  chainAsked: Array<{ width: number; span: number | null; prefer: string }> = [];
  /** 问过几次指数现价 */
  indexCalls = 0;
  /** 券商随链带回来的:要订几档、这一段里链上一共几档 */
  chainMeta: Rec = {};
  chainRows: Rec[] = [
    { strike: 7700, right: "P", oi: 4000, volume: 100, gamma: 0.004, iv: 0.15 },
    { strike: 7710, right: "P", oi: 9000, volume: 300, gamma: 0.006, iv: 0.15 },
    { strike: 7720, right: "C", oi: 1000, volume: 50, gamma: 0.007, iv: 0.15 },
    { strike: 7720, right: "P", oi: 800, volume: 50, gamma: 0.007, iv: 0.15 },
    { strike: 7730, right: "C", oi: 6000, volume: 200, gamma: 0.006, iv: 0.15 },
    { strike: 7745, right: "C", oi: 7000, volume: 200, gamma: 0.004, iv: 0.15 },
  ];
  sessions(): unknown[] { return [this.session]; }
  connectedNames(): string[] { return ["paper"]; }
  marketSession(): FakeSession { return this.session; }
  async indexPrice(): Promise<number | null> {
    this.indexCalls += 1;
    return this.spot;
  }
  spotInfo(): Rec { return { price: this.spot, source: this.source, note: "" }; }
  async historicalBars(_symbol: string, start: string, end: string): Promise<Rec[]> {
    return Object.entries(this.closes).filter(([d]) => start <= d && d <= end).map(([date, close]) => ({ date, close }));
  }
  async optionChain(_symbol: string, expiry: string, width: number, span: number | null, prefer = ""): Promise<Rec> {
    this.chainCalls += 1;
    this.chainAsked.push({ width, span, prefer });
    return {
      rows: this.chainRows, spot: this.spot, expiry, multiplier: 100, expiries: [expiry], spot_source: "quote", trading_class: "SPXW", ...this.chainMeta,
    };
  }
}

const servers: RpcServer[] = [];
const dirs: string[] = [];

function make(opts: { connected?: boolean; dir?: string } = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "dafri-playbook-"));
  if (!opts.dir) dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
  const out: Rec[] = [];
  const s = new RpcServer(settingsPath, (line) => out.push(JSON.parse(line)));
  const router = new FakeRouter();
  if (opts.connected ?? true) s.router = router as never;
  servers.push(s);
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  const pushed = (): Rec[] => out.filter((m) => m["method"] === "event" && m["params"]["event"] === "playbook").map((m) => m["params"]["data"]);
  /** 把钟拨到那一刻再走一轮;plusSeconds = 那一分钟里的第几秒 */
  const tick = async (hhmm: string, day = "2026-09-28", plusSeconds = 0) => {
    const when = at(hhmm, day) + plusSeconds * 1000;
    setClock(when);
    return s.playbook.tickOnce(when);
  };
  return { s, pb: s.playbook, router, call, tick, pushed, log: new PlaybookLog(path.join(dir, "playbook")), dir };
}

beforeEach(() => setClock(at("10:00")));
afterEach(() => {
  setClock(null);
  for (const s of servers.splice(0)) {
    s.playbook.stop();
    s.ivRecorder.stop();
    s.flyPlanner.marks.close();
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

describe("盘初与当前区间", () => {
  it("09:35 那一格:当场读平值跨式,一份记成盘初、一份记成当前,都落盘", async () => {
    const m = make();
    await m.tick("09:35");
    const snap = m.pb.snapshot();
    const em = EM_FACTOR * 20; // 两条腿的中间价都是 10
    expect(snap.bands.open).toEqual({
      at: at("09:35"), anchor: 7718.4, strike: 7720, expiry: "20260928", call: 10, put: 10, em, lower: 7718.4 - em, upper: 7718.4 + em, source: "live",
    });
    expect(snap.bands.current).toEqual(snap.bands.open);
    // 这一格两条是同一条,拼出来的今日区间也就是它;B2 的触发线是它的上沿
    expect(snap.bands.day).toEqual(snap.bands.open);
    expect(snap.lines.b2).toBe(7718.4 + em);
    expect(m.router.session.subscribed).toEqual(["20260928 7720C SPXW #106", "20260928 7720P SPXW #106"]);
    // 锚单独记一条(它不靠盘初那一条区间);状态变了(none → R)也落一条
    const records = m.log.read("2026-09-28");
    expect(records.map((r) => r.kind)).toEqual(["anchor", "frame", "open", "machine"]);
    expect(records[0]).toEqual({ kind: "anchor", anchor: { at: at("09:35"), price: 7718.4, source: "live" } });
    expect(records[3]).toEqual({ kind: "machine", machine: { at: at("09:35"), state: "R", trigger: null, since: at("09:35"), lost: null } });
    expect(snap).toMatchObject({ date: "2026-09-28", price: 7718.4, idle_reason: "", frame_seconds: 300 });
  });

  it("同一个五分钟格里不重取;到了下一格换当前区间,盘初那一条不动", async () => {
    const m = make();
    await m.tick("09:35");
    m.router.spot = 7731;
    await m.tick("09:38");
    expect(m.pb.snapshot().bands.current?.anchor).toBe(7718.4);
    await m.tick("09:40");
    const snap = m.pb.snapshot();
    expect(snap.bands.current).toMatchObject({ anchor: 7731, strike: 7730, at: at("09:40") });
    expect(snap.bands.open?.anchor).toBe(7718.4);
    const bands = m.log.read("2026-09-28").map((r) => r.kind).filter((k) => k === "frame" || k === "open" || k === "prior");
    expect(bands).toEqual(["frame", "open", "frame"]);
  });

  it("今日区间:锚一直是 09:35 那个价,半宽跟着最近一次取到的跨式走;每一格记的是取价时的现价,不是拼出来的那条", async () => {
    const m = make();
    await m.tick("09:35");
    m.router.spot = 7731;
    m.router.session.ticks = { "7730C": { bid: 7.9, ask: 8.1 }, "7730P": { bid: 7.9, ask: 8.1 } };
    await m.tick("09:40");
    const snap = m.pb.snapshot();
    const em = EM_FACTOR * 16;
    expect(snap.bands.current).toMatchObject({ anchor: 7731, strike: 7730, em, lower: 7731 - em, upper: 7731 + em });
    expect(snap.bands.day).toEqual({ ...snap.bands.current, anchor: 7718.4, lower: 7718.4 - em, upper: 7718.4 + em });
    expect(snap.lines.b2).toBe(7718.4 + em);
    const frames = m.log.read("2026-09-28").filter((r) => r.kind === "frame");
    expect(frames.map((r) => (r.kind === "frame" ? r.band.anchor : null))).toEqual([7718.4, 7731]); // 记的是取价时的现价,不是拼出来的那条
  });

  it("09:35 的指数价没赶上、也补不到:今日区间拼不出来,B2 判不了,原因在 notes 里", async () => {
    const m = make();
    await m.tick("10:00");
    m.router.spot = 7790; // 高出任何可能的上沿
    await m.tick("10:01");
    const snap = m.pb.snapshot();
    expect(snap.bands.current).not.toBeNull();
    expect(snap).toMatchObject({ bands: { open: null, day: null }, lines: { b2: null }, state: "none" });
    expect(snap.notes).toContain("今日区间的锚补不了:09:35 那一分钟没有指数的历史价");
  });

  it("09:35:00 之后头两拍里读到的现价才算 09:35 的价:迟了不拿它当锚,等那根分钟线走完取它的开盘价", async () => {
    const m = make();
    m.router.session.minutes = {
      "SPX|2026-09-28 09:35": 7700.0, "20260928 7700C|2026-09-28 09:35": 15, "20260928 7700P|2026-09-28 09:35": 13,
    };
    m.router.spot = 7712.3; // 离 09:35 那一笔已经走开 12 点
    await m.tick("09:35", "2026-09-28", 20); // 09:35:20 才第一次读到:那根分钟线还在走,先不取锚
    expect(m.pb.snapshot().bands).toMatchObject({ open: null, day: null, current: { anchor: 7712.3, source: "live" } });
    const indexAsked = (): string[] => m.router.session.history.filter((h) => h.startsWith("SPX"));
    expect(indexAsked()).toEqual([]);

    await m.tick("09:36");
    const snap = m.pb.snapshot();
    expect(snap.bands.open).toMatchObject({ at: at("09:35"), anchor: 7700, strike: 7700, call: 15, put: 13, source: "backfill" });
    expect(snap.bands.day).toMatchObject({ anchor: 7700, source: "backfill", upper: 7700 + EM_FACTOR * 20 });
    expect(indexAsked()).toEqual(["SPX TRADES 20260928-13:45:00"]);
    expect(m.log.read("2026-09-28").find((r) => r.kind === "anchor")).toEqual({
      kind: "anchor", anchor: { at: at("09:35"), price: 7700, source: "backfill" },
    });
  });

  it("两拍之内都算赶上:09:35:10 第一次读到,当场记成锚与盘初区间", async () => {
    const m = make();
    await m.tick("09:35", "2026-09-28", 10);
    const snap = m.pb.snapshot();
    expect(snap.bands.open).toMatchObject({ at: at("09:35") + 10_000, anchor: 7718.4, source: "live" });
    expect(m.router.session.history.filter((h) => h.startsWith("SPX"))).toEqual([]);
  });

  it("09:35:00 那一笔现价读到了、跨式缺一边:锚照记;盘初区间等分钟线补,不拿半分钟后的跨式顶替", async () => {
    const m = make();
    m.router.session.minutes = { "20260928 7720C|2026-09-28 09:35": 14, "20260928 7720P|2026-09-28 09:35": 12 };
    m.router.session.ticks["7720P"] = { bid: NaN, ask: NaN };
    await m.tick("09:35");
    expect(m.log.read("2026-09-28").map((r) => r.kind)).toEqual(["anchor"]);
    m.router.session.ticks = {};
    m.router.spot = 7721;
    await m.tick("09:35", "2026-09-28", 40); // 半分钟后重试,跨式有了
    let snap = m.pb.snapshot();
    expect(snap.bands.current).toMatchObject({ anchor: 7721, source: "live" });
    expect(snap.bands.open).toBeNull();
    expect(snap.bands.day).toMatchObject({ anchor: 7718.4, source: "live" }); // 锚是 09:35:00 那一笔,今日区间已经有了
    await m.tick("09:36");
    snap = m.pb.snapshot();
    expect(snap.bands.open).toMatchObject({ at: at("09:35"), anchor: 7718.4, strike: 7720, call: 14, put: 12, source: "backfill" });
    expect(m.router.session.history.every((h) => !h.startsWith("SPX"))).toBe(true); // 锚不用补
  });

  it("09:35 的指数分钟线有、跨式的分钟线没有:锚有了,今日区间与 B2 照判;盘初区间空着并写明原因", async () => {
    const m = make();
    m.router.session.minutes = { "SPX|2026-09-28 09:35": 7709.6 };
    m.router.spot = 7790;
    const events = await m.tick("10:00");
    const snap = m.pb.snapshot();
    const b2 = 7709.6 + EM_FACTOR * 20;
    expect(snap.bands).toMatchObject({ open: null, day: { anchor: 7709.6, upper: b2, source: "backfill" } });
    expect(snap.notes).toContain("盘初区间补不了:09:35 那一分钟没有平值跨式的历史价");
    expect(snap.notes.some((n) => n.startsWith("今日区间的锚"))).toBe(false);
    expect(events).toEqual([{ at: at("10:00"), kind: "enter", state: "B2", level: b2, price: 7790 }]);
    expect(snap).toMatchObject({ state: "B2", trigger: b2, t1: null }); // 没有盘初区间就没有 T1
  });

  it("开盘起就读指数现价(09:35 之前只读不用):取锚的时候这条流已经在跳了", async () => {
    const m = make();
    await m.tick("09:31");
    await m.tick("09:34");
    expect(m.router.indexCalls).toBe(2);
    expect(m.pb.snapshot()).toMatchObject({ idle_reason: "等 09:35 的盘初定价", price: null });
    expect(m.log.read("2026-09-28")).toEqual([]);
    await m.tick("09:29"); // 还没开盘:不读
    expect(m.router.indexCalls).toBe(2);
  });

  it("现价和昨收一分不差:分不清是不是指数那条流垫底的昨收,不当现价用——不取锚、不取区间、不判状态", async () => {
    const m = make();
    m.router.session.minutes = { "20260928 7700C|2026-09-25 16:10": 14, "20260928 7700P|2026-09-25 16:10": 12 };
    await m.tick("09:34"); // 昨日区间补上了:锚是昨收 7701.2
    m.router.spot = 7701.2;
    expect(await m.tick("09:35")).toEqual([]);
    expect(m.pb.snapshot()).toMatchObject({
      idle_reason: "现价和昨收一分不差:分不清是不是还没跳的昨收,等下一笔", price: null, bands: { open: null, current: null, day: null }, state: "none",
    });
    expect(m.router.session.subscribed).toEqual([]);
    m.router.spot = 7702.6; // 下一拍跳了:还在头两拍里,照常取锚
    await m.tick("09:35", "2026-09-28", 5);
    expect(m.pb.snapshot().bands.open).toMatchObject({ anchor: 7702.6, source: "live" });
  });

  it("09:35 之前只等,不订期权行情", async () => {
    const m = make();
    await m.tick("09:32");
    expect(m.pb.snapshot().idle_reason).toBe("等 09:35 的盘初定价");
    expect(m.router.session.subscribed).toEqual([]);
  });

  it("跨式缺一边的盘口:这一格不出区间,写明原因;半分钟后再试,不是每一轮都试", async () => {
    const m = make();
    m.router.session.ticks["7720P"] = { bid: NaN, ask: NaN };
    await m.tick("09:35");
    expect(m.pb.snapshot().bands.current).toBeNull();
    expect(m.pb.snapshot().notes).toContain("当前区间没取到:7720 的跨式没有完整的买卖价");
    const before = m.router.session.subscribed.length;
    m.router.session.ticks = {};
    setClock(at("09:35") + 10_000);
    await m.pb.tickOnce(at("09:35") + 10_000);
    expect(m.pb.snapshot().bands.current).toBeNull();
    setClock(at("09:35") + 40_000);
    await m.pb.tickOnce(at("09:35") + 40_000);
    expect(m.pb.snapshot().bands.current).not.toBeNull();
    expect(m.pb.snapshot().notes.filter((n) => n.startsWith("当前区间"))).toEqual([]);
    expect(m.router.session.subscribed.length).toBe(before); // 流还留着,没有重订
  });

  it("现价不是指数自己的报价(昨收、期货推算)就不动", async () => {
    const m = make();
    m.router.source = "index_stale";
    await m.tick("10:00");
    expect(m.pb.snapshot()).toMatchObject({ idle_reason: "拿不到现价", price: null });
  });
});

describe("期权墙与加速档", () => {
  it("换当前区间时顺手取一份当日到期的期权墙;加速档是区间里负 gamma 最大的行权价", async () => {
    const m = make();
    await m.tick("09:35");
    const snap = m.pb.snapshot();
    expect(m.router.chainCalls).toBe(1);
    expect(snap.wall).toMatchObject({ at: at("09:35"), expiry: "20260928", call_wall: { strike: 7745 }, put_wall: { strike: 7710 } });
    expect(snap.wall?.strikes.map((s) => s.strike)).toEqual([7700, 7710, 7720, 7730, 7745]);
    expect(snap.wall?.coverage).toEqual({ lower: 7700, upper: 7745, strikes: 5, grid_strikes: null, thinned: false });
    expect(snap.accel?.strike).toBe(7710);
    expect(snap.accel?.net_gex).toBeLessThan(0);
  });

  it("期权墙的窗口要盖住剧本的每一条线:档数还是上限那 15 档,点数范围是离现价最远那条线的距离", async () => {
    const m = make();
    m.router.session.minutes = { "20260928 7700C|2026-09-25 16:10": 14, "20260928 7700P|2026-09-25 16:10": 12 };
    await m.tick("09:35");
    // 只有盘初 / 当前 / 今日三条(同一条)时是它的半宽;昨日区间(7701.2 ± 32.59)补上了,最远的是它的下沿
    const [first] = m.router.chainAsked;
    expect(first?.width).toBe(15);
    expect(first?.span).toBeCloseTo(7718.4 - (7701.2 - EM_FACTOR * 26), 6);
    m.router.spot = 7760;
    await m.tick("09:40");
    expect(m.router.chainAsked[1]?.span).toBeCloseTo(7760 - (7701.2 - EM_FACTOR * 26), 6);
  });

  it("没有规则读的线不算进窗口:现价在昨日区间上沿之上很远,昨日上沿不把窗口撑宽", async () => {
    const m = make();
    m.router.closes["2026-09-25"] = 7601.2; // 昨收在 117 点之下:昨日区间 7568.6 – 7633.8
    m.router.session.minutes = { "20260928 7600C|2026-09-25 16:10": 14, "20260928 7600P|2026-09-25 16:10": 12 };
    await m.tick("09:35");
    expect(m.pb.snapshot().bands.prior).toMatchObject({ anchor: 7601.2 });
    // 最远的是昨日下沿(B3 的线);昨日上沿没有规则读,不参与
    expect(m.router.chainAsked[0]?.span).toBeCloseTo(7718.4 - (7601.2 - EM_FACTOR * 26), 6);
  });

  it("点名要日到期类:剧本看的是今天到期的那条链(月度合约记的那一天两条链都列着这个日期)", async () => {
    const m = make();
    await m.tick("09:35");
    expect(m.router.chainAsked[0]?.prefer).toBe("SPXW");
  });

  it("链是抽着取的(要订的档数比这一段里链上的少):快照里说得出来;个别档没回数不算抽", async () => {
    const m = make();
    m.router.chainMeta = { strike_count: 31, grid_count: 37 };
    await m.tick("09:35");
    const wall = m.pb.snapshot().wall;
    expect(wall?.coverage).toEqual({ lower: 7700, upper: 7745, strikes: 5, grid_strikes: 37, thinned: true });
    expect(wall?.warnings.some((w) => w.startsWith("行权价是抽着取的:7700–7745 这一段链上有 37 档"))).toBe(true);

    const full = make();
    full.router.chainMeta = { strike_count: 31, grid_count: 31 }; // 31 档都订了,只有 5 档回了数
    await full.tick("09:35");
    expect(full.pb.snapshot().wall?.coverage).toMatchObject({ strikes: 5, grid_strikes: 31, thinned: false });
    expect(full.pb.snapshot().wall?.warnings.some((w) => w.startsWith("行权价是抽着取的"))).toBe(false);
  });

  it("期权墙的缓存:一分钟里再要一份不比上一份宽的,不重取;要更宽的才重取;不给范围的是另一份", async () => {
    const m = make();
    await m.s.market.wallFor("SPX", "20260928", 15, 80);
    await m.s.market.wallFor("SPX", "20260928", 15, 60);
    expect(m.router.chainAsked).toEqual([{ width: 15, span: 80, prefer: "" }]);
    await m.s.market.wallFor("SPX", "20260928", 15, 120);
    expect(m.router.chainAsked.map((a) => a.span)).toEqual([80, 120]);
    await m.s.market.wallFor("SPX", "20260928", 15);
    await m.s.market.wallFor("SPX", "20260928", 15);
    expect(m.router.chainAsked.map((a) => a.span)).toEqual([80, 120, null]);
    // 点名了交易类的是另一条链,不和没点名的共用一份
    await m.s.market.wallFor("SPX", "20260928", 15, 80, "SPXW");
    expect(m.router.chainAsked[3]).toEqual({ width: 15, span: 80, prefer: "SPXW" });
  });

  it("gamma 环境带着净额占总量的比例;链上没有隐含波动率就是不知道,不是正也不是 0", async () => {
    const m = make();
    await m.tick("09:35");
    const wall = m.pb.snapshot().wall;
    // 看涨 1000×.007 + 6000×.006 + 7000×.004 = 71;看跌 4000×.004 + 9000×.006 + 800×.007 = 75.6
    expect(wall?.regime).toBe("negative");
    expect(wall?.net_gex_ratio).toBeCloseTo((71 - 75.6) / (71 + 75.6), 4);

    const blind = make();
    blind.router.chainRows = blind.router.chainRows.map((r) => ({ ...r, gamma: null, iv: null }));
    await blind.tick("09:35");
    expect(blind.pb.snapshot().wall).toMatchObject({ regime: "unknown", net_gex: null, net_gex_ratio: null, gamma_flip: null });
    expect(blind.pb.snapshot().accel).toBeNull();
  });

  it("有 gamma 但没等到未平仓量:也是不知道,不是「正好抵消」;缺了几行说得出来", async () => {
    const m = make();
    m.router.chainRows = m.router.chainRows.map((r) => ({ ...r, oi: null }));
    await m.tick("09:35");
    const wall = m.pb.snapshot().wall;
    expect(wall).toMatchObject({ regime: "unknown", net_gex: null, net_gex_ratio: null, oi_missing: 6, call_wall: null, put_wall: null });
    expect(wall?.warnings.some((w) => w.startsWith("有 6 行没等到未平仓量"))).toBe(true);

    const partly = make();
    partly.router.chainRows = partly.router.chainRows.map((r, i) => (i === 0 ? { ...r, oi: null } : r));
    await partly.tick("09:35");
    expect(partly.pb.snapshot().wall).toMatchObject({ oi_missing: 1, put_wall: { strike: 7710 } });
    expect(partly.pb.snapshot().wall?.regime).not.toBe("unknown");
  });

  it("期权墙取不到:区间照出,原因写进 notes", async () => {
    const m = make();
    m.router.optionChain = async () => { throw new Error("链没回来"); };
    await m.tick("09:35");
    const snap = m.pb.snapshot();
    expect(snap.bands.current).not.toBeNull();
    expect(snap.wall).toBeNull();
    expect(snap.accel).toBeNull();
    expect(snap.notes).toContain("期权墙没取到:链没回来");
  });
});

describe("昨日区间", () => {
  it("收盘后十分钟:取下一个交易日到期的平值跨式,锚是当天的收盘价,写进下一个交易日的底账", async () => {
    const m = make();
    await m.tick("16:10");
    expect(m.router.session.subscribed).toEqual(["20260929 7735C SPXW #106", "20260929 7735P SPXW #106"]);
    const [record] = m.log.read("2026-09-29");
    expect(record).toMatchObject({ kind: "prior", band: { at: at("16:10"), anchor: 7733.3, strike: 7735, expiry: "20260929", source: "live" } });
    expect(m.log.read("2026-09-28")).toEqual([]);
    // 窗口里再走几轮:只记一次
    await m.tick("16:12");
    expect(m.log.read("2026-09-29")).toHaveLength(1);
  });

  it("周五收盘后取的是下周一到期的", async () => {
    const m = make();
    m.router.closes["2026-10-02"] = 7760;
    await m.tick("16:10", "2026-10-02");
    expect(m.log.read("2026-10-05")[0]).toMatchObject({ kind: "prior", band: { expiry: "20261005", strike: 7760 } });
  });

  it("窗口之外的盘后不取", async () => {
    const m = make();
    await m.tick("16:05");
    await m.tick("16:20");
    expect(m.router.session.subscribed).toEqual([]);
    expect(m.log.dates()).toEqual([]);
  });

  it("第二天开着:昨日区间从底账里捡回来", async () => {
    const m = make();
    await m.tick("16:10");
    m.router.spot = 7740;
    await m.tick("09:35", "2026-09-29");
    const snap = m.pb.snapshot();
    expect(snap.bands.prior).toMatchObject({ anchor: 7733.3, strike: 7735, source: "live" });
    expect(snap.lines.b3).toBeCloseTo(7733.3 - EM_FACTOR * 20, 6);
    expect(m.router.session.history).toEqual([]); // 有了就不去补
  });
});

describe("没赶上的补", () => {
  it("昨天 16:10 没开着:拿那一分钟的历史中间价补,锚是昨天的收盘价,标成 backfill", async () => {
    const m = make();
    m.router.session.minutes = { "20260928 7700C|2026-09-25 16:10": 14, "20260928 7700P|2026-09-25 16:10": 12, "20260928 7700C|2026-09-25 16:11": 99 };
    await m.tick("10:00");
    const em = EM_FACTOR * 26;
    expect(m.pb.snapshot().bands.prior).toEqual({
      at: at("16:10", "2026-09-25"), anchor: 7701.2, strike: 7700, expiry: "20260928", call: 14, put: 12, em,
      lower: 7701.2 - em, upper: 7701.2 + em, source: "backfill",
    });
    expect(m.router.session.history.slice(0, 2)).toEqual([
      "20260928 7700C MIDPOINT 20260925-20:20:00", "20260928 7700P MIDPOINT 20260925-20:20:00",
    ]);
    expect(m.log.read("2026-09-28").some((r) => r.kind === "prior")).toBe(true);
  });

  it("那一分钟没有历史价:空着并写明原因,十分钟之内不再去要", async () => {
    const m = make();
    await m.tick("09:31");
    expect(m.pb.snapshot().bands.prior).toBeNull();
    expect(m.pb.snapshot().notes).toEqual(["昨日区间补不了:2026-09-25 16:10 那一分钟没有今天到期的平值跨式的历史价"]);
    const asked = m.router.session.history.length;
    await m.tick("09:33");
    expect(m.router.session.history.length).toBe(asked);
    await m.tick("09:42");
    expect(m.router.session.history.length).toBeGreaterThan(asked);
  });

  it("09:35 那一格没赶上:盘初区间拿 09:35 的指数分钟线与跨式中间价补;当前区间照常当场取", async () => {
    const m = make();
    m.router.session.minutes = {
      "SPX|2026-09-28 09:35": 7709.6, "20260928 7710C|2026-09-28 09:35": 15, "20260928 7710P|2026-09-28 09:35": 13,
    };
    await m.tick("10:00");
    const snap = m.pb.snapshot();
    expect(snap.bands.open).toMatchObject({ at: at("09:35"), anchor: 7709.6, strike: 7710, call: 15, put: 13, source: "backfill" });
    expect(snap.bands.current).toMatchObject({ at: at("10:00"), anchor: 7718.4, source: "live" });
    expect(m.router.session.history).toContain("SPX TRADES 20260928-13:45:00");
  });

  it("补历史价时出了错:写明原因,循环不停,当前区间照出", async () => {
    const m = make();
    m.router.session.historicalData = async () => { throw new Error("历史数据被挡了"); };
    await m.tick("10:00");
    const snap = m.pb.snapshot();
    // 锚补不了,盘初那一条就先不去要(它得围着锚)
    expect(snap.notes.sort()).toEqual(["昨日区间补不了:历史数据被挡了", "今日区间的锚补不了:历史数据被挡了"].sort());
    expect(snap.bands.current).not.toBeNull();
    expect(snap.last_error).toBe("");
  });
});

describe("状态与事件", () => {
  /** 昨日下沿 7701.2 − 32.59 ≈ 7668.6;当前上沿 = 现价 + 25.07 */
  const withPrior = () => {
    const m = make();
    m.router.session.minutes = { "20260928 7700C|2026-09-25 16:10": 14, "20260928 7700P|2026-09-25 16:10": 12 };
    return m;
  };

  it("两条线之间是 R,不推事件", async () => {
    const m = withPrior();
    expect(await m.tick("10:00")).toEqual([]);
    expect(m.pb.snapshot()).toMatchObject({ state: "R", trigger: null, t1: null, t2: null });
    expect(m.pushed()).toEqual([]);
  });

  it("跌破昨日下沿:进 B3,推给界面一次,落盘;目标位跟着出来", async () => {
    const m = withPrior();
    await m.tick("10:00");
    m.router.spot = 7660;
    const events = await m.tick("10:01");
    const b3 = 7701.2 - EM_FACTOR * 26;
    // 这一跌同时穿过了加速档 7710,两条一起报
    expect(events).toEqual([
      { at: at("10:01"), kind: "enter", state: "B3", level: b3, price: 7660 },
      { at: at("10:01"), kind: "accel", state: "B3", level: 7710, price: 7660 },
    ]);
    const pushed = m.pushed();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.["events"]).toEqual(events);
    expect(pushed[0]?.["snapshot"]).toMatchObject({ state: "B3", trigger: b3, since: at("10:01"), t1: null, t2: 7665 });
    expect(m.log.read("2026-09-28").filter((r) => r.kind === "event")).toHaveLength(2);
    await m.tick("10:02");
    expect(m.pushed()).toHaveLength(1);
  });

  it("站上今日区间上沿:取到新一格的那一笔才进 B2;之后上沿再收窄,状态与触发线不变", async () => {
    const m = withPrior();
    await m.tick("09:35"); // 锚 7718.4,上沿 7743.47
    m.router.spot = 7745;
    expect(await m.tick("09:37")).toEqual([]); // 格子中间站上去了:不判
    expect(m.pb.snapshot().state).toBe("R");
    const cheap = { bid: 7.9, ask: 8.1 };
    m.router.session.ticks = { "7745C": cheap, "7745P": cheap };
    const b2 = 7718.4 + EM_FACTOR * 16; // 09:40 那一格的上沿:7738.45
    expect(await m.tick("09:40")).toEqual([{ at: at("09:40"), kind: "enter", state: "B2", level: b2, price: 7745 }]);
    m.router.session.ticks = { "7745C": { bid: 5.9, ask: 6.1 }, "7745P": { bid: 5.9, ask: 6.1 } };
    expect(await m.tick("09:45")).toEqual([]);
    const snap = m.pb.snapshot();
    expect(snap).toMatchObject({ state: "B2", trigger: b2, since: at("09:40"), lines: { b2: 7718.4 + EM_FACTOR * 12 }, b2_lost: null });
    // 同一句话的另一面:09:35 的锚已经在「现价 ± 剩余预期波动」的下沿之下
    expect(snap.bands.current?.lower ?? 0).toBeGreaterThan(snap.bands.open?.anchor ?? Infinity);
    // T1 是盘初区间上沿:触发线随时间收窄,它在触发线前面
    expect(snap.t1).toBe(7718.4 + EM_FACTOR * 20);
  });

  it("现价贴着上沿上下各 1 点来回蹭半小时(每格跨式便宜 0.2):弹窗两条,不是每格两条", async () => {
    const m = make();
    await m.tick("09:35");
    let mid = 10;
    const seen: string[] = [];
    for (let minute = 0; minute < 30; minute += 1) {
      const hhmm = `10:${String(minute).padStart(2, "0")}`;
      if (minute % 5 === 0) mid -= 0.1;
      const leg = { bid: mid - 0.1, ask: mid + 0.1 };
      const edge = 7718.4 + EM_FACTOR * 2 * mid;
      for (const [second, offset] of [[0, 1], [30, -1]] as const) {
        m.router.spot = Math.round((edge + offset) * 100) / 100;
        const strike = Math.round(m.router.spot / 5) * 5;
        m.router.session.ticks = { [`${strike}C`]: leg, [`${strike}P`]: leg };
        seen.push(...(await m.tick(hhmm, "2026-09-28", second)).map((e) => `${hhmm} ${e.kind}:${e.state}`));
      }
    }
    // 10:00 那一格取到时在上沿之上 1 点 → 进;10:20 那一格取到时上沿已经降了 1 点,现价跟着降到了进入线之下 → 失效
    expect(seen).toEqual(["10:00 enter:B2", "10:20 invalid:B2"]);
    expect(m.pushed()).toHaveLength(2);
  });

  it("一格一格慢慢走上去也进得了 B2:锚不跟着现价走,不用在一格里走出一整个剩余预期波动", async () => {
    const m = withPrior();
    await m.tick("09:35"); // 锚 7718.4,上沿 7743.47
    const seen: string[] = [];
    for (const [hhmm, spot] of [["09:40", 7726], ["09:45", 7734], ["09:50", 7742], ["09:55", 7750]] as const) {
      m.router.spot = spot;
      seen.push(...(await m.tick(hhmm)).map((e) => `${hhmm} ${e.kind}:${e.state}`));
    }
    expect(seen).toEqual(["09:55 enter:B2"]);
    expect(m.pb.snapshot()).toMatchObject({ state: "B2", trigger: 7718.4 + EM_FACTOR * 20 });
    expect(m.pb.snapshot().bands.current?.anchor).toBe(7750); // 当前剩余那一条照旧围着现价
  });

  it("引擎在 B2 中途重启:接着判,不重报进入;失效、等着重新上膛、解开,每一步重启都接得上", async () => {
    const m = withPrior();
    await m.tick("09:35");
    const entry = 7718.4 + EM_FACTOR * 20; // 7743.47
    m.router.spot = 7745;
    expect((await m.tick("09:40")).map((e) => `${e.kind}:${e.state}`)).toEqual(["enter:B2"]);

    const cheap = { bid: 7.9, ask: 8.1 };
    const cheapAround = { "7745C": cheap, "7745P": cheap, "7740C": cheap, "7740P": cheap, "7735C": cheap, "7735P": cheap };
    const again = make({ dir: m.dir });
    again.router.spot = 7745;
    again.router.session.ticks = cheapAround;
    expect(await again.tick("09:45")).toEqual([]);
    const narrowed = 7718.4 + EM_FACTOR * 16; // 7738.45:重启后那一格取到的剩余预期波动小了
    expect(again.pb.snapshot()).toMatchObject({
      state: "B2", trigger: entry, since: at("09:40"), lines: { b2: narrowed }, bands: { open: { anchor: 7718.4 }, day: { anchor: 7718.4 } },
    });
    expect(again.pb.snapshot().events.map((e) => e.kind)).toEqual(["enter"]);

    again.router.spot = 7741; // 进入线之下、收窄后的上沿之上
    expect(await again.tick("09:46")).toEqual([]); // 格子中间:不判
    expect(again.pb.snapshot().state).toBe("B2");
    expect(await again.tick("09:50")).toEqual([{ at: at("09:50"), kind: "invalid", state: "B2", level: entry, price: 7741 }]);
    expect(again.pb.snapshot()).toMatchObject({ state: "R", trigger: null, b2_lost: entry });

    // 失效之后再重启一次:丢掉的那条线还记着,不抢着报进入
    const third = make({ dir: m.dir });
    third.router.spot = 7741;
    third.router.session.ticks = cheapAround;
    expect(await third.tick("09:51")).toEqual([]);
    expect(third.pb.snapshot()).toMatchObject({ state: "R", b2_lost: entry, since: at("09:50") });
    third.router.spot = 7737; // 取到新一格时在区间里:解开(这一下没有事件,靠落盘的状态记着)
    expect(await third.tick("09:55")).toEqual([]);
    expect(third.pb.snapshot().b2_lost).toBeNull();

    // 解开之后又重启:不会因为底账里最后一条事件是「B2 失效」就又锁上
    const fourth = make({ dir: m.dir });
    fourth.router.spot = 7740;
    fourth.router.session.ticks = cheapAround;
    expect(await fourth.tick("10:00")).toEqual([{ at: at("10:00"), kind: "enter", state: "B2", level: narrowed, price: 7740 }]);
    // 这一次是在收窄之后的上沿进的:盘初区间上沿在它前面,就是 T1
    expect(fourth.pb.snapshot()).toMatchObject({ state: "B2", trigger: narrowed, t1: entry });
  });

  it("静默期里没报出来的那一次进入也落了盘:重启之后还是那个状态,不是退回到最后一条报过的事件", async () => {
    const m = withPrior();
    await m.tick("10:00");
    const b3 = 7701.2 - EM_FACTOR * 26; // 7668.61
    m.router.spot = 7660;
    await m.tick("10:01"); // 进入 B3:报
    m.router.spot = 7675;
    await m.tick("10:02"); // 失效:报
    m.router.spot = 7662;
    expect((await m.tick("10:03")).filter((e) => e.kind !== "accel")).toEqual([]); // 又进去了:两分钟前刚报过,不报
    expect(m.pb.snapshot()).toMatchObject({ state: "B3", trigger: b3, since: at("10:03") });
    const logged = m.log.read("2026-09-28");
    expect(logged.filter((r) => r.kind === "event" && r.event.kind !== "accel").map((r) => (r.kind === "event" ? r.event.kind : ""))).toEqual(["enter", "invalid"]);
    expect(logged.filter((r) => r.kind === "machine").at(-1)).toEqual({
      kind: "machine", machine: { at: at("10:03"), state: "B3", trigger: b3, since: at("10:03"), lost: null },
    });

    const again = make({ dir: m.dir });
    again.router.spot = 7662;
    expect(await again.tick("10:04")).toEqual([]);
    expect(again.pb.snapshot()).toMatchObject({ state: "B3", trigger: b3, since: at("10:03") });
    again.router.spot = 7675; // 这一次失效离上一条报过的失效不到五分钟:状态照变,不报
    expect(await again.tick("10:05")).toEqual([]);
    expect(again.pb.snapshot().state).toBe("R");
  });

  it("引擎重启之后接着判:同一个「进入 B3」不重报,失效照报", async () => {
    const m = withPrior();
    await m.tick("10:00");
    m.router.spot = 7660;
    await m.tick("10:01");

    const again = make({ dir: m.dir });
    again.router.spot = 7660;
    expect(await again.tick("10:03")).toEqual([]);
    expect(again.pb.snapshot()).toMatchObject({ state: "B3", since: at("10:01") });
    expect(again.pb.snapshot().events.map((e) => e.kind)).toEqual(["enter", "accel"]);
    again.router.spot = 7675; // 收回昨日下沿上方(这一天没有盘初定价,B2 判不了)
    expect((await again.tick("10:04")).map((e) => e.kind)).toEqual(["invalid"]);
  });

  it("穿过加速档:推一条 accel,状态不变", async () => {
    const m = make();
    await m.tick("09:35");
    await m.tick("10:00"); // 加速档 7710,现价 7718.4 在上方
    m.router.spot = 7708;
    const events = await m.tick("10:01");
    expect(events).toEqual([{ at: at("10:01"), kind: "accel", state: "R", level: 7710, price: 7708 }]);
    expect(m.pb.snapshot().state).toBe("R");
  });
});

describe("什么时候不动", () => {
  it("没连券商、不是交易日、不在常规时段、生效券商不是 IBKR:各有各的原因,一条行情都不订", async () => {
    const off = make({ connected: false });
    await off.tick("10:00");
    expect(off.pb.snapshot().idle_reason).toBe("没连券商");

    const m = make();
    await m.tick("10:00", "2026-09-27"); // 周日
    expect(m.pb.snapshot().idle_reason).toBe("今天不是交易日");
    await m.tick("08:00");
    expect(m.pb.snapshot().idle_reason).toBe("不在常规交易时段");
    await m.tick("17:00");
    expect(m.pb.snapshot().idle_reason).toBe("不在常规交易时段");
    expect(m.router.session.subscribed).toEqual([]);
    expect(m.router.session.history).toEqual([]);
    expect(m.router.chainCalls).toBe(0);
  });

  it("关掉之后不订行情;开关过得了重启", async () => {
    const m = make();
    const offSnap = (await m.call("options.playbook_set", { enabled: false }))["result"];
    expect(offSnap).toMatchObject({ enabled: false, idle_reason: "已关闭" });
    await m.tick("10:00");
    expect(m.router.session.subscribed).toEqual([]);
    const again = make({ dir: m.dir });
    expect(again.pb.enabled()).toBe(false);
    await again.call("options.playbook_set", { enabled: true });
    await again.tick("10:00");
    expect(again.router.session.subscribed).toHaveLength(2);
  });

  it("一轮里抛了错:记进 last_error,下一轮照跑", async () => {
    const m = make();
    m.router.indexPrice = async () => { throw new Error("行情线路断了"); };
    await m.tick("10:00");
    expect(m.pb.snapshot()).toMatchObject({ idle_reason: "上一轮出错了", last_error: "行情线路断了" });
    m.router.indexPrice = async () => 7718.4;
    await m.tick("10:01");
    expect(m.pb.snapshot()).toMatchObject({ idle_reason: "", last_error: "" });
  });
});

describe("RPC", () => {
  it("options.playbook 给出此刻的样子;没连券商也答,不报错", async () => {
    const m = make({ connected: false });
    const res = (await m.call("options.playbook"))["result"];
    expect(res).toMatchObject({
      symbol: "SPX", date: "2026-09-28", enabled: true, running: false, price: null, state: "none",
      bands: { prior: null, open: null, current: null, day: null }, lines: { b2: null, b3: null }, b2_lost: null, events: [], notes: [],
    });
  });

  it("入参不对当场拒", async () => {
    const m = make();
    expect((await m.call("options.playbook_set", {}))["error"]).toEqual({ code: -32602, message: "options.playbook_set 的参数不对:缺少 enabled" });
    expect((await m.call("options.playbook_set", { enabled: true, frame: 1 }))["error"]["message"]).toMatch(/有不认识的键:frame/);
  });

  it("两个方法都走本地道:读的是循环留在内存里的那一份", () => {
    expect(RpcServer.LOCAL_METHODS.has("options.playbook")).toBe(true);
    expect(RpcServer.LOCAL_METHODS.has("options.playbook_set")).toBe(true);
  });
});

describe("底账", () => {
  it("坏的行跳过,别的照用", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-playbook-log-"));
    dirs.push(dir);
    const log = new PlaybookLog(dir);
    const band = { at: 1, anchor: 7700, strike: 7700, expiry: "20260928", call: 10, put: 10, em: 25, lower: 7675, upper: 7725, source: "live" as const };
    log.append("2026-09-28", { kind: "open", band });
    fs.appendFileSync(path.join(dir, "2026-09-28.jsonl"), "{\"kind\":\"frame\",\"band\":{\"at\":1}}\n{半行\n");
    log.append("2026-09-28", { kind: "event", event: { at: 2, kind: "enter", state: "B3", level: 7675, price: 7670 } });
    expect(log.read("2026-09-28").map((r) => r.kind)).toEqual(["open", "event"]);
    expect(log.read("2026-01-01")).toEqual([]);
  });

  it("老版本写的底账照样读得进来:当天的三条区间、事件、B2 的记忆都接得上", async () => {
    const m = make();
    // 这几行是改口径之前的引擎写的样子:frame 的锚是取价时的现价,事件的 level 是当时那条线
    const em = EM_FACTOR * 20;
    const old = (anchor: number, when: string) => ({
      at: at(when), anchor, strike: Math.round(anchor / 5) * 5, expiry: "20260928", call: 10, put: 10, em, lower: anchor - em, upper: anchor + em, source: "live",
    });
    fs.mkdirSync(m.log.dir, { recursive: true });
    fs.writeFileSync(path.join(m.log.dir, "2026-09-28.jsonl"), [
      { kind: "prior", band: { ...old(7701.2, "09:00"), at: at("16:10", "2026-09-25") } },
      { kind: "frame", band: old(7718.4, "09:35") },
      { kind: "open", band: old(7718.4, "09:35") },
      { kind: "frame", band: old(7740, "09:40") },
      { kind: "event", event: { at: at("09:41"), kind: "enter", state: "B2", level: 7765.07, price: 7766 } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");

    setClock(at("09:42"));
    expect(m.pb.snapshot()).toMatchObject({
      state: "B2", trigger: 7765.07, since: at("09:41"),
      bands: { prior: { anchor: 7701.2 }, open: { anchor: 7718.4 }, current: { anchor: 7740 }, day: { anchor: 7718.4, upper: 7718.4 + em } },
    });
    m.router.spot = 7767;
    expect(await m.tick("09:43")).toEqual([]); // 还在进入时那条线之上:接着是 B2,不重报
    expect(m.pb.snapshot()).toMatchObject({ state: "B2", trigger: 7765.07, bands: { current: { anchor: 7767 } } });
    m.router.spot = 7764;
    expect(await m.tick("09:44")).toEqual([]); // 格子中间跌回线下:等取到新一格再判
    expect((await m.tick("09:45")).map((e) => `${e.kind}:${e.state}:${e.level}`)).toEqual(["invalid:B2:7765.07"]);
    expect(m.router.session.history).toEqual([]); // 三条都在,锚从盘初那一条里认,不去补
  });

  it("不认识的记录种类、写坏的锚与状态都跳过;认识的四种照旧读得出来", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-playbook-log-"));
    dirs.push(dir);
    const log = new PlaybookLog(dir);
    log.append("2026-09-28", { kind: "anchor", anchor: { at: 1, price: 7718.4, source: "live" } });
    log.append("2026-09-28", { kind: "machine", machine: { at: 2, state: "B2", trigger: 7743.47, since: 2, lost: null } });
    fs.appendFileSync(path.join(dir, "2026-09-28.jsonl"), [
      { kind: "anchor", anchor: { at: 1, price: 0, source: "live" } },
      { kind: "machine", machine: { at: 2, state: "B9", trigger: null, since: null, lost: null } },
      { kind: "later-version-thing", x: 1 },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    expect(log.read("2026-09-28").map((r) => r.kind)).toEqual(["anchor", "machine"]);
  });

  it("只留最近的若干天", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-playbook-log-"));
    dirs.push(dir);
    const log = new PlaybookLog(dir);
    const band = { at: 1, anchor: 7700, strike: 7700, expiry: "x", call: 10, put: 10, em: 25, lower: 7675, upper: 7725, source: "live" as const };
    for (const d of ["2026-09-24", "2026-09-25", "2026-09-28"]) log.append(d, { kind: "open", band });
    expect(log.prune(2)).toBe(1);
    expect(log.dates()).toEqual(["2026-09-25", "2026-09-28"]);
  });
});
