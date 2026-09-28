/** options.fly_plan 从 RPC 进来的这一段:入参过 schema、现价与三条腿的行情从券商取、没连券商时靠手动给的数离线算。
 *
 * 纯计算在 fly-plan.spec,取行情的那一层在 option-marks.spec;这里钉的是接线:问券商要的是哪几张合约、
 * 夜盘拿到昨收时不算、富途连接下不取期权行情、错误码与文案。全部离线:券商与会话是假的,时钟钉在 2026-09-28 10:00 美东。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setClock } from "../src/config.js";
import type { IbContract, TickerData } from "../src/ibTypes.js";
import { RpcServer } from "../src/rpc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

const NOW = Date.parse("2026-09-28T10:00:00-04:00");

class FakeSession {
  subscribed: string[] = [];
  ticks: Record<number, Partial<TickerData>> = {
    7725: { bid: 5.6, ask: 5.8, modelGreeks: { gamma: null, impliedVol: 0.16 } },
    7750: { bid: 1.5, ask: 1.7, modelGreeks: { gamma: null, impliedVol: 0.15 } },
    7775: { bid: 0.25, ask: 0.35, modelGreeks: { gamma: null, impliedVol: 0.145 } },
  };
  accounts = ["DU7654321"];
  types: number[] = [];
  isConnected(): boolean { return true; }
  managedAccounts(): string[] { return this.accounts; }
  async qualifyContracts(contracts: IbContract[]): Promise<void> {
    for (const c of contracts) c.conId = 900000 + Number(c.strike);
  }
  reqMarketDataType(type: number): void { this.types.push(type); }
  subscribeTicker(c: IbContract, generic = ""): { read(): TickerData } {
    this.subscribed.push(`${c.symbol} ${c.lastTradeDateOrContractMonth} ${c.strike}${c.right} ${c.tradingClass} ${c.exchange} #${generic}`);
    return { read: () => ({ bid: NaN, ask: NaN, modelGreeks: null, error: null, ...this.ticks[Number(c.strike)] }) as TickerData };
  }
  cancelTicker(): void { /* 留着的流在用例结束时由 close() 撤 */ }
  async settle(): Promise<void> { /* 假时钟:不等 */ }
}

class FakeRouter {
  session = new FakeSession();
  spot: number | null = 7720;
  info: Rec | null = { price: 7720, source: "index", note: "" };
  askedSpot: string[] = [];
  sessions(): unknown[] { return [this.session]; }
  connectedNames(): string[] { return ["paper"]; }
  marketSession(): FakeSession { return this.session; }
  async indexPrice(symbol: string): Promise<number | null> {
    this.askedSpot.push(symbol);
    return this.spot;
  }
  spotInfo(): Rec | null { return this.info; }
}

const servers: RpcServer[] = [];
const dirs: string[] = [];

function makeServer(opts: { connected?: boolean; config?: Rec } = {}): { s: RpcServer; router: FakeRouter; call: (p?: Rec) => Promise<Rec> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-fly-rpc-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") }, ...opts.config }));
  const s = new RpcServer(settingsPath, () => undefined);
  const router = new FakeRouter();
  if (opts.connected ?? true) s.router = router as never;
  servers.push(s);
  const call = async (params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "options.fly_plan", params })));
  return { s, router, call };
}

const ASK = { center: 7750, width: 25, target_spot: 7745, target_time: "14:00", cost: 2 };

beforeEach(() => setClock(NOW));
afterEach(() => {
  setClock(null);
  for (const s of servers.splice(0)) {
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

describe("连着 TWS", () => {
  it("现价问券商;三条腿按 SPXW、当日到期、SMART 订,带自己的 generic ticks;IV 用 IBKR 的", async () => {
    const { call, router } = makeServer();
    const out = (await call(ASK))["result"];
    expect(router.askedSpot).toEqual(["SPX"]);
    expect(router.session.subscribed).toEqual([
      "SPX 20260928 7725C SPXW SMART #106", "SPX 20260928 7750C SPXW SMART #106", "SPX 20260928 7775C SPXW SMART #106",
    ]);
    expect(out).toMatchObject({
      symbol: "SPX", expiry: "20260928", trading_class: "SPXW", right: "C", lower: 7725, center: 7750, upper: 7775,
      quantity: 1, multiplier: 100, spot: 7720, spot_source: "quote", cost: 2, cost_source: "input",
      now_at: "2026-09-28 10:00", expiry_at: "2026-09-28 16:00", anchored: true,
    });
    expect(out["iv"]).toMatchObject({ source: "ibkr", mode: "auto", now: 0.16 });
    expect(out["target"]).toMatchObject({ spot: 7745, at: "2026-09-28 14:00", hours_left: 2 });
    expect(out["legs"].map((l: Rec) => [l.strike, l.bid, l.ask, l.iv])).toEqual([
      [7725, 5.6, 5.8, 0.16], [7750, 1.5, 1.7, 0.15], [7775, 0.25, 0.35, 0.145],
    ]);
    expect(out["market"]).toEqual({ bid: 2.45, mid: 2.8, ask: 3.15 });
    // 时间线:今天此刻之后的每个半点,加上目标时刻
    expect(out["timeline"][0]["at"]).toBe("10:30");
    expect(out["timeline"].at(-1)["at"]).toBe("16:00");
    expect(out["timeline"].filter((t: Rec) => t.is_target).map((t: Rec) => t.at)).toEqual(["14:00"]);
    // 界面读的每一个键都在
    expect(Object.keys(out).sort()).toEqual([
      "anchored", "at_expiry", "breakeven", "center", "cost", "cost_source", "curve", "expiry", "expiry_at", "expiry_breakeven",
      "expiry_ms", "instant", "iv", "legs", "lower", "market", "max_loss", "max_profit", "model_now", "move", "multiplier",
      "now_at", "now_ms", "peak", "quantity", "right", "scenarios", "spot", "spot_note", "spot_source", "symbol", "target",
      "target_flat", "target_range", "timeline", "trading_class", "upper", "warnings", "width",
    ]);
    // IV 怎么变用的是随软件带的那份校准:样本、指数、样本外 R² 都带出来,界面照着说
    expect(out["iv"]["model"]).toMatchObject({ proxy: "VIX1D" });
    expect(out["iv"]["model"]["days"]).toBeGreaterThanOrEqual(250);
    expect(out["iv"]["range"]["low"]).toBeLessThan(out["iv"]["range"]["high"]);
    expect(out["target_range"]["low"]["pnl"]).toBeLessThanOrEqual(out["target"]["pnl"]);
    expect(out["target_range"]["high"]["pnl"]).toBeGreaterThanOrEqual(out["target"]["pnl"]);
  });

  it("没写看涨看跌:中心在现价上方按看涨,下方按看跌,并说出来(和本地速记同一条规则)", async () => {
    const { call } = makeServer();
    const up = (await call(ASK))["result"];
    expect(up["right"]).toBe("C");
    expect(up["warnings"].join("\n")).toContain("中心 7750 高于现价 7720,按看涨蝶算");
    const down = (await call({ ...ASK, center: 7700, target_spot: 7705, iv: 15 }))["result"];
    expect(down["right"]).toBe("P");
    expect((await call({ ...ASK, right: "put" }))["result"]["right"]).toBe("P");
    expect((await call({ ...ASK, right: "看涨" }))["result"]["warnings"].join("\n")).not.toContain("按看涨蝶算");
    expect((await call({ ...ASK, right: "X" }))["error"]).toEqual({ code: -32602, message: "看涨还是看跌要写成 C 或 P,收到「X」。" });
  });

  it("只管着纸面账户的会话:按类型 3 订(有实时给实时,没有给延迟);管着实盘账户的不切", async () => {
    const paper = makeServer();
    await paper.call(ASK);
    expect(paper.router.session.types).toEqual([3, 1]);
    const live = makeServer();
    live.router.session.accounts = ["U1234567"];
    await live.call(ASK);
    expect(live.router.session.types).toEqual([]);
  });

  it("夜盘按期货推算的现价:照算,来源标出来;推算失败拿到的是昨收:不算,请用户手动给", async () => {
    const fut = makeServer();
    fut.router.spot = 7731.5;
    fut.router.info = { price: 7731.5, source: "futures", note: "SPX 夜盘不计算,按 ESZ6 7760 − 基差 28.5 推算" };
    const out = (await fut.call(ASK))["result"];
    expect(out).toMatchObject({ spot: 7731.5, spot_source: "futures", spot_note: "SPX 夜盘不计算,按 ESZ6 7760 − 基差 28.5 推算" });

    const stale = makeServer();
    stale.router.info = { price: 7700, source: "index_stale", note: "SPX 指数只在常规时段计算,这是上一个收盘价,不是现价(期货推算没成功:期货还没报价)" };
    const err = (await stale.call(ASK))["error"];
    expect(err["code"]).toBe(-32017);
    expect(err["message"]).toMatch(/这是上一个收盘价,不是现价.*可以手动填上现价再算/);
    // 手动给了现价就不问券商要,照算
    expect((await stale.call({ ...ASK, spot: 7715 }))["result"]).toMatchObject({ spot: 7715, spot_source: "input" });
    expect(stale.router.askedSpot).toEqual(["SPX"]);
  });

  it("拿不到现价、腿的订阅被 TWS 拒:各说各的,都指到手动", async () => {
    const a = makeServer();
    a.router.spot = null;
    expect((await a.call(ASK))["error"]).toEqual({ code: -32017, message: "拿不到 SPX 的现价。可以手动填上现价再算。" });

    const b = makeServer();
    b.router.session.ticks[7750] = { error: "10197 No market data during competing live session" };
    const err = (await b.call(ASK))["error"];
    expect(err["code"]).toBe(-32017);
    expect(err["message"]).toBe("取不到 SPX 期权行情,TWS 拒了订阅:7750C 10197 No market data during competing live session。可以手动填上 IV 再算。");
    // 手动给了 IV:带着一句话接着算。成本已经填了的,不再催一遍
    const out = (await b.call({ ...ASK, iv: 15 }))["result"];
    expect(out["iv"]["source"]).toBe("input");
    expect(out["warnings"].join("\n")).toMatch(/TWS 拒了订阅/);
    expect(out["warnings"].join("\n")).not.toMatch(/成本请自己填/);
  });

  it("休市:IV 和盘口都不来,说清楚并指到手动 IV", async () => {
    const { call, router } = makeServer();
    router.session.ticks = {};
    const err = (await call(ASK))["error"];
    expect(err["code"]).toBe(-32602);
    expect(err["message"]).toMatch(/拿不到这三条腿的 IV/);
  });

  it("手动给了 IV,连着的时候盘口照取:成本不填就用盘口中间价", async () => {
    const { call } = makeServer();
    const out = (await call({ center: 7750, width: 25, target_spot: 7745, target_time: "14:00", iv: 18 }))["result"];
    expect(out["iv"]).toMatchObject({ source: "input", now: 0.18 });
    expect(out).toMatchObject({ cost: 2.8, cost_source: "mid", anchored: false });
  });
});

describe("没连券商", () => {
  it("现价与 IV 都手动给:离线照算", async () => {
    const { call } = makeServer({ connected: false });
    const out = (await call({ ...ASK, spot: 7720, iv: 15, iv_mode: "flat" }))["result"];
    expect(out).toMatchObject({ spot: 7720, spot_source: "input", cost: 2, anchored: false });
    expect(out["iv"]).toMatchObject({ source: "input", mode: "flat", now: 0.15, change_pct: 0 });
    expect(out["legs"].every((l: Rec) => l.bid === null && l.ask === null && l.iv === 0.15)).toBe(true);
    expect(out["at_expiry"]).toMatchObject({ value: 20, pnl: 1800 });
    expect(out["warnings"]).toContain("没连 TWS / IB Gateway,拿不到盘口与 IV。");
    // 成本没填:用的是模型价,两句都说
    const bare = (await call({ center: 7750, width: 25, target_spot: 7745, target_time: "14:00", spot: 7720, iv: 15 }))["result"];
    expect(bare["cost_source"]).toBe("model");
    expect(bare["warnings"]).toContain("没连 TWS / IB Gateway,拿不到盘口与 IV。成本请自己填,否则用的是模型价。");
  });

  it("缺一样:说缺的是哪一样", async () => {
    const { call } = makeServer({ connected: false });
    expect((await call(ASK))["error"]).toEqual({
      code: -32017, message: "没连 TWS / IB Gateway,拿不到现价:先去连接,或者手动填上现价与 IV 再算。",
    });
    expect((await call({ ...ASK, spot: 7720 }))["error"]).toEqual({
      code: -32017, message: "没连 TWS / IB Gateway,拿不到盘口与 IV。可以手动填上 IV 再算。",
    });
  });
});

describe("富途连接", () => {
  it("期权行情不从富途取:现价照问,IV 要手动给", async () => {
    const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
    const { call, router } = makeServer({
      config: {
        broker: { provider: "futu" },
        connections: { ...base.connections, opend: { broker: "futu", host: "127.0.0.1", port: 11111, client_id: 1 } },
      },
    });
    const err = (await call(ASK))["error"];
    expect(err).toEqual({ code: -32017, message: "蝴蝶测算的期权行情目前只从 IBKR 取。可以手动填上 IV 再算。" });
    expect(router.session.subscribed).toEqual([]);
    expect((await call({ ...ASK, iv: 15 }))["result"]["iv"]["source"]).toBe("input");
  });
});

describe("入参", () => {
  it("缺必填、类型不对、写错键名:schema 当场拒(strict)", async () => {
    const { call } = makeServer();
    expect((await call({ width: 25, target_spot: 7745, target_time: "14:00" }))["error"]).toEqual({
      code: -32602, message: "options.fly_plan 的参数不对:缺少 center",
    });
    expect((await call({ ...ASK, center: "7750" }))["error"]["message"]).toBe("options.fly_plan 的参数不对:center 应为 number,收到 string");
    expect((await call({ ...ASK, iv_shift: 30 }))["error"]["message"]).toMatch(/有不认识的键:iv_shift/);
    expect((await call({ ...ASK, iv_mode: "sticky" }))["error"]["code"]).toBe(-32602);
  });

  it("领域上的错是 -32602,带着那句人话", async () => {
    const { call } = makeServer();
    expect((await call({ ...ASK, target_time: "09:00" }))["error"]).toEqual({ code: -32602, message: "目标时刻已经过去了。" });
    expect((await call({ ...ASK, target_date: "2026-09-27" }))["error"]).toEqual({ code: -32602, message: "2026-09-27 不是交易日。" });
    expect((await call({ ...ASK, symbol: "sp x" }))["error"]).toEqual({ code: -32602, message: "标的代码不合法:'sp x'" });
    expect((await call({ ...ASK, cost: 30 }))["error"]["message"]).toMatch(/不小于翼宽/);
  });

  it("到期日晚于目标那一天;提前收盘日按 13:00 到期(日历来自配置 + 内置)", async () => {
    const { call } = makeServer();
    const later = (await call({ ...ASK, expiry: "20260930" }))["result"];
    expect(later).toMatchObject({ expiry: "20260930", expiry_at: "2026-09-30 16:00" });
    setClock(Date.parse("2026-11-27T10:00:00-05:00"));
    const early = (await call({ ...ASK, target_time: "12:00" }))["result"];
    expect(early["expiry_at"]).toBe("2026-11-27 13:00");
    expect(early["warnings"].join("\n")).toContain("2026-11-27 提前收盘,这只蝶按美东 13:00 到期算。");
  });

  it("排在读道上:开着自动刷新时不挡下单", () => {
    expect(RpcServer.READ_METHODS.has("options.fly_plan")).toBe(true);
  });
});
