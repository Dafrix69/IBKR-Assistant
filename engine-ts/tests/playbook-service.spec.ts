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
  async indexPrice(): Promise<number | null> { return this.spot; }
  spotInfo(): Rec { return { price: this.spot, source: this.source, note: "" }; }
  async historicalBars(_symbol: string, start: string, end: string): Promise<Rec[]> {
    return Object.entries(this.closes).filter(([d]) => start <= d && d <= end).map(([date, close]) => ({ date, close }));
  }
  async optionChain(_symbol: string, expiry: string): Promise<Rec> {
    this.chainCalls += 1;
    return { rows: this.chainRows, spot: this.spot, expiry, multiplier: 100, expiries: [expiry], spot_source: "quote" };
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
  /** 把钟拨到那一刻再走一轮 */
  const tick = async (hhmm: string, day = "2026-09-28") => {
    setClock(at(hhmm, day));
    return s.playbook.tickOnce(at(hhmm, day));
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
    expect(m.router.session.subscribed).toEqual(["20260928 7720C SPXW #106", "20260928 7720P SPXW #106"]);
    expect(m.log.read("2026-09-28").map((r) => r.kind)).toEqual(["frame", "open"]);
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
    expect(m.log.read("2026-09-28").map((r) => r.kind)).toEqual(["frame", "open", "frame"]);
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
    expect(snap.accel?.strike).toBe(7710);
    expect(snap.accel?.net_gex).toBeLessThan(0);
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
    expect(snap.notes.sort()).toEqual(["昨日区间补不了:历史数据被挡了", "盘初区间补不了:历史数据被挡了"].sort());
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

  it("站上当前区间上沿:进 B2;下一格区间换了,状态与触发线不变", async () => {
    const m = withPrior();
    await m.tick("10:00");
    const b2 = 7718.4 + EM_FACTOR * 20;
    m.router.spot = 7745;
    const events = await m.tick("10:02");
    expect(events).toEqual([{ at: at("10:02"), kind: "enter", state: "B2", level: b2, price: 7745 }]);
    await m.tick("10:05");
    expect(m.pb.snapshot()).toMatchObject({ state: "B2", trigger: b2, lines: { b2: 7745 + EM_FACTOR * 20 } });
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
    again.router.spot = 7675; // 收回昨日下沿上方,但还在重启后那一格的当前上沿(7660 + 25.07)之下
    expect((await again.tick("10:04")).map((e) => e.kind)).toEqual(["invalid"]);
  });

  it("穿过加速档:推一条 accel,状态不变", async () => {
    const m = make();
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
      bands: { prior: null, open: null, current: null }, lines: { b2: null, b3: null }, events: [], notes: [],
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
