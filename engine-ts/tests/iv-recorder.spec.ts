/** 当日到期期权 IV 的记录(services/ivRecorder.ts + ivSamples.ts)。
 *
 * 它在后台自己跑、自己订行情,所以要钉的是"什么时候不许动":没连券商、不在常规时段、关掉之后,一条行情都不订。
 * 再就是记下来的东西能不能用:同一个行权价一整天不换(引擎重启也不换)、坏的行不连累别的、只有行情没有账号。
 * 全部离线:券商与会话是假的,时钟是钉住的,样本写在临时目录里。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setClock } from "../src/config.js";
import type { IbContract, TickerData } from "../src/ibTypes.js";
import { IvSampleStore } from "../src/ivSamples.js";
import type { IvSample } from "../src/ivSamples.js";
import { RpcServer } from "../src/rpc.js";
import { IvRecorderService } from "../src/services/ivRecorder.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

/** 2026-09-28 是周一;九月是夏令时 */
const at = (hhmm: string, day = "2026-09-28"): number => Date.parse(`${day}T${hhmm}:00-04:00`);

class FakeSession {
  subscribed: string[] = [];
  cancelled: string[] = [];
  accounts = ["DU7654321"];
  /** 行权价 → tick;没登记的给默认盘口 */
  ticks: Record<number, Partial<TickerData>> = {};
  dead = false;
  isConnected(): boolean { return true; }
  managedAccounts(): string[] { return this.accounts; }
  async qualifyContracts(contracts: IbContract[]): Promise<void> {
    for (const c of contracts) c.conId = 900000 + Number(c.strike) * 2 + (c.right === "C" ? 1 : 0);
  }
  reqMarketDataType(): void { /* 不关心 */ }
  subscribeTicker(c: IbContract, generic = ""): { read(): TickerData } {
    this.subscribed.push(`${c.symbol} ${c.lastTradeDateOrContractMonth} ${c.strike}${c.right} ${c.tradingClass} #${generic}`);
    const base = this.dead
      ? { bid: NaN, ask: NaN, modelGreeks: null, error: null }
      : { bid: 2.0, ask: 2.2, modelGreeks: { gamma: null, impliedVol: 0.15 + Number(c.strike) / 1e6 }, error: null };
    return { read: () => ({ ...base, ...this.ticks[Number(c.strike)] }) as TickerData };
  }
  cancelTicker(c: IbContract, generic?: string): void { this.cancelled.push(`${c.strike}${c.right}#${generic ?? "*"}`); }
  async settle(): Promise<void> { /* 假时钟:不等 */ }
}

class FakeRouter {
  session = new FakeSession();
  spot: number | null = 7718.4;
  info: Rec | null = { price: 7718.4, source: "index", note: "" };
  sessions(): unknown[] { return [this.session]; }
  connectedNames(): string[] { return ["paper"]; }
  marketSession(): FakeSession { return this.session; }
  async indexPrice(): Promise<number | null> { return this.spot; }
  spotInfo(): Rec | null { return this.info; }
}

const servers: RpcServer[] = [];
const dirs: string[] = [];

function make(opts: { connected?: boolean; config?: Rec } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-iv-rec-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") }, ...opts.config }));
  const s = new RpcServer(settingsPath, () => undefined);
  const router = new FakeRouter();
  if (opts.connected ?? true) s.router = router as never;
  servers.push(s);
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  const store = new IvSampleStore(path.join(dir, "fly-iv"));
  return { s, rec: s.ivRecorder, router, call, store, dir };
}

beforeEach(() => setClock(at("10:00")));
afterEach(() => {
  setClock(null);
  for (const s of servers.splice(0)) {
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

describe("记一笔", () => {
  it("连着 IBKR、在常规时段里:围着锚取一圈行权价,锚以下看跌、以上看涨、锚上两样都记", async () => {
    const { rec, router, store } = make();
    const sample = (await rec.tickOnce(at("10:00")))!;
    expect(sample).toMatchObject({
      t: at("10:00"), symbol: "SPX", expiry: "20260928", trading_class: "SPXW", spot: 7718.4, spot_source: "quote", by: "loop", anchor: 7720,
    });
    expect(sample.legs.map((l) => `${l.strike}${l.right}`)).toEqual([
      "7645P", "7670P", "7695P", "7710P", "7720P", "7720C", "7730C", "7745C", "7770C", "7795C",
    ]);
    expect(sample.legs[0]).toEqual({ strike: 7645, right: "P", bid: 2.0, ask: 2.2, iv: 0.15 + 7645 / 1e6 });
    // 订的是自己的流(带 generic ticks),按 SPXW、当日到期
    expect(router.session.subscribed).toHaveLength(10);
    expect(router.session.subscribed[0]).toBe("SPX 20260928 7645P SPXW #106");
    expect(store.read("2026-09-28")).toEqual([sample]);
  });

  it("五分钟一笔:没到时候不记、也不订行情", async () => {
    const { rec, router, store } = make();
    await rec.tickOnce(at("10:00"));
    expect(await rec.tickOnce(at("10:03"))).toBeNull();
    expect(router.session.subscribed).toHaveLength(10);
    expect(await rec.tickOnce(at("10:05"))).not.toBeNull();
    expect(store.read("2026-09-28").map((s) => s.t)).toEqual([at("10:00"), at("10:05")]);
  });

  it("行权价一整天不换:标的走了,锚还是开盘后第一笔定的那个", async () => {
    const { rec, router } = make();
    await rec.tickOnce(at("10:00"));
    router.spot = 7731;
    const later = (await rec.tickOnce(at("10:05")))!;
    expect(later.anchor).toBe(7720);
    expect(later.legs.map((l) => `${l.strike}${l.right}`)).toEqual([
      "7645P", "7670P", "7695P", "7710P", "7720P", "7720C", "7730C", "7745C", "7770C", "7795C",
    ]);
  });

  it("标的走远了(离锚 20 点以上):原来那一圈照记,再添一对跟着现价的平值", async () => {
    const { rec, router } = make();
    await rec.tickOnce(at("10:00"));
    router.spot = 7683.2;
    const later = (await rec.tickOnce(at("11:00")))!;
    expect(later.legs.map((l) => `${l.strike}${l.right}`)).toEqual([
      "7645P", "7670P", "7695P", "7710P", "7720P", "7720C", "7730C", "7745C", "7770C", "7795C", "7685P", "7685C",
    ]);
  });

  it("引擎重启过:锚从今天已经记下的样本里接着用,不拿此刻的现价另起一个", async () => {
    const first = make();
    await first.rec.tickOnce(at("10:00"));
    // 另一个引擎实例,同一个数据目录
    const again = new IvRecorderService(first.s, first.s.flyPlanner.marks);
    first.router.spot = 7752;
    const sample = (await again.tickOnce(at("12:00")))!;
    expect(sample.anchor).toBe(7720);
  });

  it("新的一天:重新定锚,落在那一天的文件里", async () => {
    const { rec, router, store } = make();
    await rec.tickOnce(at("15:55"));
    router.spot = 7760.9;
    const next = (await rec.tickOnce(at("09:35", "2026-09-29")))!;
    expect(next).toMatchObject({ anchor: 7760, expiry: "20260929" });
    expect(store.dates()).toEqual(["2026-09-28", "2026-09-29"]);
  });

  it("夜盘按期货推算的现价也记,来源标出来", async () => {
    // 常规时段里不会走到期货那一路;这里只钉"来源照实写"
    const { rec, router } = make();
    router.info = { price: 7718.4, source: "futures", note: "按 ESZ6 推算" };
    expect((await rec.tickOnce(at("10:00")))!.spot_source).toBe("futures");
  });
});

describe("什么时候不记", () => {
  const cases: Array<[string, (m: ReturnType<typeof make>) => void, number, string]> = [
    ["没连券商", (m) => { m.s.router = null; }, at("10:00"), "没连券商"],
    ["开盘之前", () => undefined, at("09:00"), "不在常规交易时段"],
    ["收盘之后", () => undefined, at("16:00"), "不在常规交易时段"],
    ["周末", () => undefined, at("11:00", "2026-09-27"), "不在常规交易时段"],
    ["休市日(配置里的)", () => undefined, Date.parse("2026-09-07T11:00:00-04:00"), "不在常规交易时段"],
    ["提前收盘日 13:00 之后", () => undefined, Date.parse("2026-11-27T13:30:00-05:00"), "不在常规交易时段"],
    ["现价是昨收", (m) => { m.router.info = { source: "index_stale", note: "" }; }, at("10:00"), "拿不到现价"],
    ["拿不到现价", (m) => { m.router.spot = null; }, at("10:00"), "拿不到现价"],
  ];
  for (const [name, arrange, when, why] of cases) {
    it(`${name}:不订行情、不写文件,原因说得出来`, async () => {
      const m = make();
      arrange(m);
      expect(await m.rec.tickOnce(when)).toBeNull();
      expect(m.router.session.subscribed).toEqual([]);
      expect(m.store.dates()).toEqual([]);
      expect(m.rec.status().idle_reason).toBe(why);
    });
  }

  it("富途连接:期权行情只从 IBKR 取", async () => {
    const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
    const m = make({ config: { broker: { provider: "futu" }, connections: { ...base.connections, opend: { broker: "futu", host: "127.0.0.1", port: 11111, client_id: 1 } } } });
    expect(await m.rec.tickOnce(at("10:00"))).toBeNull();
    expect(m.router.session.subscribed).toEqual([]);
    expect(m.rec.status().idle_reason).toBe("期权行情只从 IBKR 取");
  });

  it("一条行情都没来(订阅被拒):不写空样本,把 TWS 的原话带出来;五分钟之后才再试", async () => {
    const m = make();
    m.router.session.dead = true;
    for (const k of [7645, 7670, 7695, 7710, 7720, 7730, 7745, 7770, 7795]) m.router.session.ticks[k] = { error: "10197 No market data during competing live session" };
    expect(await m.rec.tickOnce(at("10:00"))).toBeNull();
    expect(m.store.dates()).toEqual([]);
    expect(m.rec.status().idle_reason).toBe("行情订阅被拒:10197 No market data during competing live session");
    const before = m.router.session.subscribed.length;
    await m.rec.tickOnce(at("10:01"));
    expect(m.router.session.subscribed.length).toBe(before);
  });

  it("出了错:吞掉、记下来,下一轮照常", async () => {
    const m = make();
    m.router.indexPrice = async () => { throw new Error("TWS 断了"); };
    expect(await m.rec.tickOnce(at("10:00"))).toBeNull();
    expect(m.rec.status()).toMatchObject({ last_error: "TWS 断了", idle_reason: "上一轮出错了" });
    m.router.indexPrice = async () => 7718.4;
    expect(await m.rec.tickOnce(at("10:05"))).not.toBeNull();
    expect(m.rec.status()).toMatchObject({ last_error: "", idle_reason: "" });
  });
});

describe("开关", () => {
  it("默认开着;关掉之后不订任何行情,已经攒下的不删;再打开接着记", async () => {
    const m = make();
    expect(m.rec.status().enabled).toBe(true);
    await m.rec.tickOnce(at("10:00"));
    const off = (await m.call("options.iv_recorder_set", { enabled: false }))["result"];
    expect(off).toMatchObject({ enabled: false, idle_reason: "已关闭", days: 1, samples: 1 });
    const before = m.router.session.subscribed.length;
    expect(await m.rec.tickOnce(at("10:05"))).toBeNull();
    expect(m.router.session.subscribed.length).toBe(before);
    expect(m.store.read("2026-09-28")).toHaveLength(1);
    await m.call("options.iv_recorder_set", { enabled: true });
    expect(await m.rec.tickOnce(at("10:10"))).not.toBeNull();
  });

  it("开关存在库的偏好表里:换一个引擎实例还记得", async () => {
    const m = make();
    await m.call("options.iv_recorder_set", { enabled: false });
    expect(new IvRecorderService(m.s, m.s.flyPlanner.marks).enabled()).toBe(false);
  });

  it("入参:只认布尔;不认识的键当场拒", async () => {
    const m = make();
    expect((await m.call("options.iv_recorder_set", {}))["error"]).toEqual({ code: -32602, message: "options.iv_recorder_set 的参数不对:缺少 enabled" });
    expect((await m.call("options.iv_recorder_set", { enabled: "yes" }))["error"]["code"]).toBe(-32602);
    expect((await m.call("options.iv_recorder_set", { enabled: true, interval: 1 }))["error"]["message"]).toMatch(/有不认识的键:interval/);
  });
});

describe("状态", () => {
  it("攒了多少天、多少笔、从哪天到哪天、存在哪", async () => {
    const m = make();
    expect((await m.call("options.iv_recorder"))["result"]).toEqual({
      enabled: true, running: false, symbol: "SPX", interval_seconds: 300, dir: path.join(m.dir, "fly-iv"),
      days: 0, samples: 0, first_date: null, last_date: null, last_at: null, idle_reason: "", last_error: "",
    });
    await m.rec.tickOnce(at("10:00"));
    await m.rec.tickOnce(at("10:05"));
    await m.rec.tickOnce(at("09:40", "2026-09-29"));
    expect((await m.call("options.iv_recorder"))["result"]).toMatchObject({
      days: 2, samples: 3, first_date: "2026-09-28", last_date: "2026-09-29", last_at: new Date(at("09:40", "2026-09-29")).toISOString(),
    });
  });

  it("排在本地道上;不是敏感方法(不发单、不改配置)", () => {
    expect(RpcServer.LOCAL_METHODS.has("options.iv_recorder")).toBe(true);
    expect(RpcServer.LOCAL_METHODS.has("options.iv_recorder_set")).toBe(true);
  });

  it("循环:start 之后在跑,stop 之后停;重复 start 不会起两条", () => {
    const m = make();
    m.rec.start(60_000);
    m.rec.start(60_000);
    expect(m.rec.status().running).toBe(true);
    m.rec.stop();
    expect(m.rec.status().running).toBe(false);
  });
});

describe("测算读行情时顺带记一笔", () => {
  const ASK = { center: 7750, width: 25, target_spot: 7745, target_time: "14:00", cost: 2 };
  const plan = async (m: ReturnType<typeof make>, extra: Rec = {}) => m.s.handle({ jsonrpc: "2.0", id: 1, method: "options.fly_plan", params: { ...ASK, ...extra } });

  it("当日到期、现价与 IV 都是券商来的:记下那三条腿", async () => {
    const m = make();
    expect((await plan(m))["result"]["iv"]["source"]).toBe("ibkr");
    const [sample] = m.store.read("2026-09-28");
    expect(sample).toMatchObject({ by: "plan", symbol: "SPX", expiry: "20260928", spot: 7718.4, t: at("10:00") });
    expect(sample!.legs.map((l) => `${l.strike}${l.right}`)).toEqual(["7725C", "7750C", "7775C"]);
    expect(sample!.anchor).toBeUndefined();
  });

  it("开着自动刷新是十秒一次:同一只蝶一分钟最多记一笔;换一只蝶另算", async () => {
    const m = make();
    await plan(m);
    setClock(at("10:00") + 10_000);
    await plan(m);
    await plan(m, { center: 7700, target_spot: 7705 });
    setClock(at("10:01") + 1_000);
    await plan(m);
    expect(m.store.read("2026-09-28").map((s) => s.legs[1]!.strike)).toEqual([7750, 7700, 7750]);
  });

  it("现价是手动给的、不是当日到期、IV 一条都没有、记录关着:不记", async () => {
    const m = make();
    await plan(m, { spot: 7720 });
    await plan(m, { expiry: "20260930" });
    m.router.session.ticks = { 7725: { modelGreeks: null }, 7750: { modelGreeks: null }, 7775: { modelGreeks: null } };
    expect((await plan(m))["result"]["iv"]["source"]).toBe("quote");
    expect(m.store.dates()).toEqual([]);
    m.router.session.ticks = {};
    await m.call("options.iv_recorder_set", { enabled: false });
    await plan(m, { center: 7800, target_spot: 7790 });
    expect(m.store.dates()).toEqual([]);
  });

  it("记不下来(目录写不进去)不连累测算:结果照出", async () => {
    const m = make();
    fs.writeFileSync(path.join(m.dir, "fly-iv"), "占着这个名字的是一个文件");
    expect((await plan(m))["result"]["target"]["spot"]).toBe(7745);
    expect(m.rec.status().last_error).not.toBe("");
  });
});

describe("样本文件", () => {
  const sample = (t: number, extra: Partial<IvSample> = {}): IvSample => ({
    t, symbol: "SPX", expiry: "20260928", trading_class: "SPXW", spot: 7718.4, spot_source: "quote", by: "loop", anchor: 7720,
    legs: [{ strike: 7720, right: "C", bid: 9.8, ask: 10.0, iv: 0.158 }, { strike: 7720, right: "P", bid: 11.4, ask: 11.6, iv: 0.159 }],
    ...extra,
  });
  const tmp = (): IvSampleStore => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-iv-store-"));
    dirs.push(dir);
    return new IvSampleStore(path.join(dir, "fly-iv"));
  };

  it("一天一个文件(按美东日期),一行一笔,只追加", () => {
    const store = tmp();
    expect(store.dates()).toEqual([]);
    store.append(sample(at("10:00")));
    store.append(sample(at("10:05")));
    // 北京时间 09-29 凌晨 03:50 还是美东 09-28 的 15:50
    store.append(sample(Date.parse("2026-09-29T03:50:00+08:00")));
    store.append(sample(at("09:35", "2026-09-29")));
    expect(store.dates()).toEqual(["2026-09-28", "2026-09-29"]);
    expect(store.read("2026-09-28").map((s) => s.t)).toEqual([at("10:00"), at("10:05"), at("15:50")]);
    const lines = fs.readFileSync(path.join(store.dir, "2026-09-28.jsonl"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual(sample(at("10:00")));
  });

  it("坏的行(断电时写了半行、形状不对)跳过,别的照用", () => {
    const store = tmp();
    store.append(sample(at("10:00")));
    fs.appendFileSync(path.join(store.dir, "2026-09-28.jsonl"), '{"t":17906\n{"t":"昨天","legs":[]}\n{"t":1,"symbol":"SPX","expiry":"x","spot":-1,"legs":[]}\n\n');
    store.append(sample(at("10:05")));
    expect(store.read("2026-09-28").map((s) => s.t)).toEqual([at("10:00"), at("10:05")]);
    expect(store.days()).toEqual([{ date: "2026-09-28", samples: 2, bytes: fs.statSync(path.join(store.dir, "2026-09-28.jsonl")).size }]);
  });

  it("里面只有行情:没有账号、没有别名", () => {
    const store = tmp();
    store.append(sample(at("10:00")));
    const text = fs.readFileSync(path.join(store.dir, "2026-09-28.jsonl"), "utf-8");
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["anchor", "by", "expiry", "legs", "spot", "spot_source", "symbol", "t", "trading_class"]);
    expect(text).not.toMatch(/DU\d|U\d{6}|account|模拟|主账户/);
  });

  it("只留最近若干天;别的文件不碰", () => {
    const store = tmp();
    for (const day of ["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28"]) store.append(sample(at("10:00", day)));
    fs.writeFileSync(path.join(store.dir, "notes.txt"), "不是样本");
    expect(store.prune(3)).toBe(2);
    expect(store.dates()).toEqual(["2026-09-24", "2026-09-25", "2026-09-28"]);
    expect(fs.existsSync(path.join(store.dir, "notes.txt"))).toBe(true);
    expect(store.prune(3)).toBe(0);
  });

  it("文件只有自己读得到", () => {
    if (process.platform === "win32") return;
    const store = tmp();
    store.append(sample(at("10:00")));
    expect(fs.statSync(path.join(store.dir, "2026-09-28.jsonl")).mode & 0o077).toBe(0);
  });
});
