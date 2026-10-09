/** 券商成交的后台同步(services/fillSync.ts)。
 *
 * 要钉的是那次真机上的事:TWS 设成东八区,北京时间 23:59:06 在 TWS 里手动买的一张蝴蝶,过了 0 点才打开交易分析去同步——
 * TWS 的"当天"已经翻篇,要不回来了。所以成交得在它发生的那几秒里落库,不能等人去点。
 * 再就是别把券商烦死:节流、同一时刻只发一次、券商不答不能把后面的同步堵住、断开重连之后先要一次。
 * 全部离线:券商与会话是假的,时刻是传进去的。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrokerError } from "../src/broker.js";
import { RpcServer } from "../src/rpc.js";
import { FillSyncService, holdingsFingerprint } from "../src/services/fillSync.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

const ACCT = "U1234567";
const SEC = 1000;

function fill(
  execId: string, symbol: string, secType: string, side: "BOT" | "SLD", shares: number, price: number, time: string, perm: number,
  option: Rec = {},
): Rec {
  return {
    account_id: ACCT, exec_id: execId, perm_id: perm, order_id: null, order_ref: "", side, shares, price, time, commission: 0,
    contract: { secType, symbol, currency: "USD", exchange: "SMART", conId: 1, ...option },
  };
}

const put = (strike: number): Rec => ({ expiry: "20261007", strike, right: "P", multiplier: "100", tradingClass: "SPXW" });

/** 21:50 买的股票,和 23:59:06 买的那张蝴蝶(1 条组合行 + 3 条腿)。时间是 UTC。 */
const STOCK = [
  fill("s1", "TTWO", "STK", "BOT", 5, 202.48, "2026-10-07T13:50:23+00:00", 11),
  fill("s2", "TTWO", "STK", "BOT", 15, 202.4795, "2026-10-07T13:50:23+00:00", 11),
];
const FLY = [
  fill("f0", "SPX", "BAG", "BOT", 1, 4.25, "2026-10-07T15:59:06+00:00", 22),
  fill("f1", "SPX", "OPT", "BOT", 1, 8.58, "2026-10-07T15:59:06+00:00", 22, put(7790)),
  fill("f2", "SPX", "OPT", "SLD", 2, 2.55, "2026-10-07T15:59:06+00:00", 22, put(7770)),
  fill("f3", "SPX", "OPT", "BOT", 1, 0.77, "2026-10-07T15:59:06+00:00", 22, put(7750)),
];

const held = (conId: number, position: number): Rec => ({ contract: { conId, account: ACCT }, position });

class FakeSession {
  holdings: Rec[] = [held(6478131, 20)];
  unreadable = false;
  async positions(): Promise<Rec[]> {
    if (this.unreadable) throw new Error("TWS 在 8 秒内没有推送持仓,本轮读不到持仓");
    return this.holdings;
  }
}

/** 会往回给 7 天的会话:past 是 TWS 的"前几天"里有的成交(券商那边的字段名);null = TWS 太老给不了。 */
class DeepSession extends FakeSession {
  past: Rec[] | null = [];
  deepAsked: number[] = [];
  deepFail: Error | null = null;
  async executionHistory(days: number): Promise<Rec[] | null> {
    this.deepAsked.push(days);
    if (this.deepFail) throw this.deepFail;
    return this.past;
  }
}

/** 券商那边的一笔成交(reqExecutions 回的样子),对应上面 fill() 的一行。 */
function detail(row: Rec): Rec {
  const c = row["contract"];
  const stamp = String(row["time"]).replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return {
    contract: {
      conId: c["conId"], symbol: c["symbol"], secType: c["secType"], lastTradeDateOrContractMonth: c["expiry"] ?? "", strike: c["strike"] ?? 0,
      right: c["right"], multiplier: Number(c["multiplier"] ?? 0), exchange: c["exchange"], currency: c["currency"], tradingClass: c["tradingClass"] ?? "",
    },
    execution: {
      execId: row["exec_id"], time: `${stamp.slice(0, 8)}-${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}`,
      acctNumber: row["account_id"], side: row["side"], shares: row["shares"], price: row["price"], permId: row["perm_id"], orderId: 0, orderRef: "",
    },
  };
}

class FakeRouter {
  session = new FakeSession();
  connected = true;
  /** TWS 此刻愿意给的"当天"成交 */
  today: Rec[] = [...STOCK];
  asked = 0;
  fail: Error | null = null;
  hang = false;
  sessions(): unknown[] { return this.connected ? [this.session] : []; }
  connectedNames(): string[] { return this.connected ? ["live"] : []; }
  async executions(): Promise<Rec[]> {
    this.asked += 1;
    if (this.hang) return new Promise<Rec[]>(() => undefined);
    if (this.fail) throw this.fail;
    return this.today;
  }
}

const servers: RpcServer[] = [];
const dirs: string[] = [];

function make(): { s: RpcServer; router: FakeRouter; sync: FillSyncService; stored: () => number; audits: () => Rec[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-fill-sync-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    ...base,
    accounts: [{ alias: "主账户", account_id: ACCT, is_paper: false, connection: "live", default: true }],
    storage: { db_path: path.join(dir, "t.db") },
  }));
  const s = new RpcServer(settingsPath, () => undefined);
  const router = new FakeRouter();
  s.router = router as never;
  servers.push(s);
  return {
    s, router, sync: s.fillSync,
    stored: () => s.engine.store.countFills(),
    audits: () => (s.engine.store.exportAll()["audit_log"] as Rec[]).filter((a) => a["action"] === "fills_failed"),
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const s of servers.splice(0)) {
    s.fillSync.stop();
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

describe("持仓指纹", () => {
  it("只认账户、合约、数量;顺序无关,数量 0 的不算", () => {
    const a = holdingsFingerprint([held(1, 20), held(2, -3)]);
    expect(holdingsFingerprint([held(2, -3), held(1, 20)])).toBe(a);
    expect(holdingsFingerprint([held(1, 20), held(2, -3), held(9, 0)])).toBe(a);
    expect(holdingsFingerprint([held(1, 21), held(2, -3)])).not.toBe(a);
    expect(holdingsFingerprint([held(1, 20)])).not.toBe(a);
    expect(holdingsFingerprint([])).toBe("");
  });

  it("没有 conId 的按合约描述认;账户号在持仓项上也认", () => {
    const opt = (strike: number): Rec => ({
      account: ACCT, position: 1,
      contract: { symbol: "SPX", secType: "OPT", lastTradeDateOrContractMonth: "20261007", strike, right: "P" },
    });
    expect(holdingsFingerprint([opt(7750)])).toBe(`${ACCT}|SPX/OPT/20261007/7750/P|1`);
    expect(holdingsFingerprint([opt(7750)])).not.toBe(holdingsFingerprint([opt(7770)]));
  });
});

describe("后台同步:成交在发生的那几秒里落库", () => {
  it("那次真机上的事:午夜前 54 秒买的蝴蝶,不用打开交易分析也进了库;TWS 翻篇之后它还在", async () => {
    const { router, sync, stored } = make();
    // 刚连上:先要一次
    expect(await sync.tickOnce(0)).toBe(2);
    expect(stored()).toBe(2);
    // 持仓没变:不去烦券商
    expect(await sync.tickOnce(20 * SEC)).toBeNull();
    expect(router.asked).toBe(1);

    // 23:59:06 在 TWS 里手动买了一张蝴蝶:三条腿出现在持仓里,TWS 的当天成交里多了四行
    router.session.holdings = [held(6478131, 20), held(101, 1), held(102, -2), held(103, 1)];
    router.today = [...STOCK, ...FLY];
    expect(await sync.tickOnce(25 * SEC)).toBe(4);
    expect(stored()).toBe(6);

    // 0 点一过,TWS 的"当天"里什么都没有了。之后再怎么同步也加不进新的,但库里那四行还在
    router.today = [];
    expect(await sync.tickOnce(45 * SEC)).toBe(0);
    expect(await sync.sync(2 * 3600 * SEC)).toBe(0);
    expect(stored()).toBe(6);
  });

  it("持仓变了之后要两次:头一次要的时候,分几笔成交的后面几笔还没出来", async () => {
    const { router, sync, stored } = make();
    await sync.tickOnce(0);
    router.session.holdings = [held(6478131, 20), held(101, 1)];
    router.today = [...STOCK, FLY[1]!];
    expect(await sync.tickOnce(30 * SEC)).toBe(1);
    // 节流之内不发
    router.today = [...STOCK, ...FLY];
    expect(await sync.tickOnce(35 * SEC)).toBeNull();
    expect(router.asked).toBe(2);
    // 过了节流补第二次,把后面几笔带回来;之后持仓不变就不再要
    expect(await sync.tickOnce(46 * SEC)).toBe(3);
    expect(stored()).toBe(6);
    expect(await sync.tickOnce(70 * SEC)).toBeNull();
    expect(router.asked).toBe(3);
  });

  it("持仓没变也隔几分钟要一次:几秒内买进又卖出的,指纹看不出来", async () => {
    const { router, sync, stored } = make();
    await sync.tickOnce(0);
    router.today = [...STOCK, fill("d1", "NVO", "STK", "BOT", 10, 65, "2026-10-07T14:00:00+00:00", 31), fill("d2", "NVO", "STK", "SLD", 10, 65.2, "2026-10-07T14:00:03+00:00", 32)];
    expect(await sync.tickOnce(FillSyncService.EVERY_MS - SEC)).toBeNull();
    expect(await sync.tickOnce(FillSyncService.EVERY_MS)).toBe(2);
    expect(stored()).toBe(4);
  });

  it("持仓读不到的那几轮不当成变了,定时那一路照旧", async () => {
    const { router, sync } = make();
    await sync.tickOnce(0);
    router.session.unreadable = true;
    expect(await sync.tickOnce(30 * SEC)).toBeNull();
    expect(router.asked).toBe(1);
    expect(await sync.tickOnce(FillSyncService.EVERY_MS)).toBe(0);
    // 读回来了、和断之前一样:不算变
    router.session.unreadable = false;
    expect(await sync.tickOnce(FillSyncService.EVERY_MS + 30 * SEC)).toBeNull();
    expect(router.asked).toBe(2);
  });

  it("断开时不动;重连回来先要一次(断着的那段最可能漏成交)", async () => {
    const { router, sync, stored } = make();
    await sync.tickOnce(0);
    router.connected = false;
    expect(sync.available()).toBe(false);
    expect(await sync.tickOnce(60 * SEC)).toBeNull();
    expect(await sync.sync(61 * SEC)).toBeNull();
    expect(router.asked).toBe(1);

    router.connected = true;
    router.today = [...STOCK, ...FLY];
    expect(await sync.tickOnce(90 * SEC)).toBe(4);
    expect(stored()).toBe(6);
  });

  it("连接反复断开时不跟着一遍遍去要:节流不因为断开清零", async () => {
    const { router, sync } = make();
    await sync.tickOnce(0);
    for (let t = 2; t <= 12; t += 5) {
      router.connected = false;
      await sync.tickOnce(t * SEC);
      router.connected = true;
      expect(await sync.tickOnce((t + 1) * SEC)).toBeNull();
    }
    expect(router.asked).toBe(1);
    expect(await sync.tickOnce(16 * SEC)).toBe(0);
  });

  it("券商给不了成交(富途、没有 executions 的替身):什么都不做", async () => {
    const { s, sync } = make();
    s.router = { sessions: () => [{}], connectedNames: () => ["futu"] } as never;
    expect(sync.available()).toBe(false);
    expect(await sync.tickOnce(0)).toBeNull();
    expect(await sync.sync(0)).toBeNull();
  });
});

describe("向券商要成交:节流、不重发、不被堵住", () => {
  it("离上一次不到 15 秒不再要;同一时刻的两次只发一次,拿到同一个结果", async () => {
    const { router, sync } = make();
    const [a, b] = await Promise.all([sync.sync(0), sync.sync(0)]);
    expect([a, b]).toEqual([2, 2]);
    expect(router.asked).toBe(1);
    expect(await sync.sync(FillSyncService.MIN_GAP_MS - 1)).toBeNull();
    expect(router.asked).toBe(1);
    expect(await sync.sync(FillSyncService.MIN_GAP_MS)).toBe(0);
    expect(router.asked).toBe(2);
  });

  it("券商报错:这一次作罢、留一条痕,过了节流再来;同一句报错不反复留痕", async () => {
    const { router, sync, stored, audits } = make();
    router.fail = new BrokerError("读取成交明细失败:Not connected");
    expect(await sync.tickOnce(0)).toBeNull();
    expect(await sync.tickOnce(5 * SEC)).toBeNull(); // 还欠着,但在节流里
    expect(router.asked).toBe(1);
    expect(await sync.tickOnce(20 * SEC)).toBeNull();
    expect(router.asked).toBe(2);
    expect(audits().map((a) => JSON.parse(a["detail"])["error"])).toEqual(["读取成交明细失败:Not connected"]);

    router.fail = null;
    expect(await sync.tickOnce(40 * SEC)).toBe(2);
    expect(stored()).toBe(2);
    // 好了之后再坏,重新留痕
    router.fail = new BrokerError("读取成交明细失败:Not connected");
    expect(await sync.sync(60 * SEC)).toBeNull();
    expect(audits()).toHaveLength(2);
  });

  it("不是券商的错(程序错误)照样抛给调用方,不吞", async () => {
    const { router, sync } = make();
    router.fail = new TypeError("boom");
    await expect(sync.sync(0)).rejects.toThrow("boom");
    // 循环那一路不因为它停:下一轮照常
    router.fail = null;
    expect(await sync.tickOnce(20 * SEC)).toBe(2);
  });

  it("券商不答:等满时限就作罢,后面的同步不被它堵住", async () => {
    vi.useFakeTimers();
    const { router, sync, audits } = make();
    router.hang = true;
    const stuck = sync.sync(0);
    await vi.advanceTimersByTimeAsync(FillSyncService.BROKER_TIMEOUT_MS);
    expect(await stuck).toBeNull();
    expect(audits().map((a) => JSON.parse(a["detail"])["error"])).toEqual(["读取成交明细失败:券商等了 10 秒没有回应"]);

    router.hang = false;
    expect(await sync.sync(30 * SEC)).toBe(2);
  });
});

describe("往回要 7 天:当天那一问问不到的成交", () => {
  function deep(): ReturnType<typeof make> & { session: DeepSession; historyAudits: () => Rec[] } {
    const made = make();
    const session = new DeepSession();
    made.router.session = session;
    return {
      ...made, session,
      historyAudits: () => (made.s.engine.store.exportAll()["audit_log"] as Rec[]).filter((a) => a["action"] === "fills_history_failed"),
    };
  }

  it("软件没开着的时候买的蝴蝶,TWS 已经翻篇:刚连上那一趟往回要,它进了库,和当天要到的同一笔不重复存", async () => {
    const { router, sync, session, stored, s } = deep();
    // TWS 的"当天"里只剩股票的两笔;前几天里有那张蝴蝶,也有这两笔股票
    session.past = [...STOCK, ...FLY].map(detail);
    expect(await sync.tickOnce(0)).toBe(6);
    expect(session.deepAsked).toEqual([7]);
    expect(router.asked).toBe(1);
    expect(stored()).toBe(6);
    // 往回要到的行和当天要到的长得一样:蝴蝶照常合得出来
    const stock = s.engine.store.listFills().find((f: Rec) => f["exec_id"] === "s1");
    expect(stock).toMatchObject({ time: "2026-10-07T13:50:23+00:00", side: "BOT", shares: 5, price: 202.48, perm_id: 11 });
    const leg = s.engine.store.listFills().find((f: Rec) => f["exec_id"] === "f2");
    expect(leg).toMatchObject({ time: "2026-10-07T15:59:06+00:00", side: "SLD", shares: 2, contract: { secType: "OPT", strike: 7770, right: "P", expiry: "20261007" } });
  });

  it("平时每几分钟那一问不往回要;持仓变了的两趟、每小时一次才要", async () => {
    const { sync, session } = deep();
    await sync.tickOnce(0);
    expect(session.deepAsked).toHaveLength(1);
    await sync.tickOnce(5 * 60 * SEC);
    await sync.tickOnce(10 * 60 * SEC);
    expect(session.deepAsked).toHaveLength(1);
    // 持仓变了:接下来的两趟都往回要(成交正好卡在 TWS 午夜前后时,当天那一问问不到它)
    session.holdings = [held(6478131, 20), held(101, 1)];
    await sync.tickOnce(11 * 60 * SEC);
    await sync.tickOnce(11 * 60 * SEC + 20 * SEC);
    expect(session.deepAsked).toHaveLength(3);
    await sync.tickOnce(20 * 60 * SEC);
    expect(session.deepAsked).toHaveLength(3);
    // 离上一次往回要满一小时:跟着下一趟同步一起要
    await sync.tickOnce(72 * 60 * SEC);
    expect(session.deepAsked).toHaveLength(4);
  });

  it("往回要没要到:当天的照存,留一条痕,下一趟再要;同一句原因不反复留痕,要到了就清", async () => {
    const { sync, session, stored, historyAudits } = deep();
    session.deepFail = new Error("往回要成交的连接被 TWS 关了:326 Unable to connect as the client id is already in use.");
    expect(await sync.tickOnce(0)).toBe(2);
    expect(stored()).toBe(2);
    expect(historyAudits().map((a) => JSON.parse(a["detail"])["error"])).toEqual(["往回要成交的连接被 TWS 关了:326 Unable to connect as the client id is already in use."]);
    // 欠着的那一趟留着:下一次同步(5 分钟那一问)接着试,原因没变不再留痕
    await sync.tickOnce(5 * 60 * SEC);
    expect(session.deepAsked).toHaveLength(2);
    expect(historyAudits()).toHaveLength(1);
    session.deepFail = null;
    session.past = FLY.map(detail);
    expect(await sync.tickOnce(10 * 60 * SEC)).toBe(4);
    expect(stored()).toBe(6);
    // 要到了:不再每趟都要
    await sync.tickOnce(15 * 60 * SEC);
    expect(session.deepAsked).toHaveLength(3);
  });

  it("往回要一直不回话:等满时限作罢,当天的照存", async () => {
    vi.useFakeTimers();
    const { sync, session, stored, historyAudits } = deep();
    session.executionHistory = () => new Promise<Rec[] | null>(() => undefined);
    const pending = sync.tickOnce(0);
    await vi.advanceTimersByTimeAsync(FillSyncService.BROKER_TIMEOUT_MS);
    expect(await pending).toBe(2);
    expect(stored()).toBe(2);
    expect(historyAudits()).toHaveLength(1);
  });

  it("TWS 太老给不了:这次连接里不再试;重连之后再试一次", async () => {
    const { router, sync, session } = deep();
    session.past = null;
    await sync.tickOnce(0);
    session.holdings = [held(6478131, 20), held(101, 1)];
    await sync.tickOnce(60 * SEC);
    await sync.tickOnce(80 * SEC);
    await sync.tickOnce(3 * 3600 * SEC);
    expect(session.deepAsked).toHaveLength(1);
    router.connected = false;
    await sync.tickOnce(3 * 3600 * SEC + 20 * SEC);
    router.connected = true;
    await sync.tickOnce(3 * 3600 * SEC + 40 * SEC);
    expect(session.deepAsked).toHaveLength(2);
  });

  it("人点「同步成交」:这一趟连前 7 天的一起要;正赶上节流就记着,循环的下一趟补上", async () => {
    const { s, sync, session } = deep();
    const call = async (method: string): Promise<Rec> => s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} })));
    await sync.tickOnce(0);
    expect(session.deepAsked).toHaveLength(1);
    // 刚要过(15 秒之内):这一次不发,但记下了
    session.past = FLY.map(detail);
    expect((await call("review.candidates"))["result"]["synced"]).toBeNull();
    expect(session.deepAsked).toHaveLength(1);
    expect(await sync.tickOnce(20 * SEC)).toBe(4);
    expect(session.deepAsked).toHaveLength(2);
    // 过了节流再点:当场往回要
    await sync.tickOnce(60 * SEC);
    expect((await call("review.candidates"))["result"]["candidates"][0]).toMatchObject({ kind: "butterfly", symbol: "SPX", strikes: [7750, 7770, 7790] });
  });
});

describe("页面上的「同步成交」走的是同一路", () => {
  it("review.candidates:后台刚要过就不再要(synced 是 null),库里的照样列出来", async () => {
    const { s, router, sync } = make();
    const call = async (method: string, params: Rec = {}): Promise<Rec> =>
      s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
    router.today = [...STOCK, ...FLY];
    expect(await sync.tickOnce()).toBe(6);

    const r = (await call("review.candidates"))["result"];
    expect(router.asked).toBe(1);
    expect(r["synced"]).toBeNull();
    expect(r["ibkr_available"]).toBe(true);
    expect(r["fills_stored"]).toBe(6);
    // 那张蝴蝶合出来了,排在更早的股票前面
    expect(r["candidates"].map((c: Rec) => [c["kind"], c["symbol"], c["strikes"] ?? null, c["price"] ?? null])).toEqual([
      ["butterfly", "SPX", [7750, 7770, 7790], 4.25],
      ["stock", "TTWO", null, null],
    ]);
  });
});
