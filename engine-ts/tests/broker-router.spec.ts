/** BrokerRouter 行为测试:FakeIbSession 注入,离线,不碰网络。
 * 覆盖 Python 版散在 test_prompts_store_broker / test_fixes_batch* 的路由与下单要点。 */
import { describe, expect, it } from "vitest";

import {
  BrokerError, BrokerRouter, IbContract, IbSession, OrderIntent, TickerData, buildOrderIntent,
} from "../src/broker.js";
import { ParsedOrderSchema } from "../src/models.js";
import type { ApprovedOrder } from "../src/validator.js";
import { nowEt } from "../src/config.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");
const gb = loadGolden("broker");
const gv = loadGolden("validator");

function ticker(over: Partial<TickerData> = {}): TickerData {
  return {
    bid: NaN, ask: NaN, last: null, close: null, bidSize: null, askSize: null,
    marketPrice: null, modelGreeks: null, ...over,
  };
}

class FakeIbSession implements IbSession {
  connected = true;
  managed: string[];
  qualifyMode: "ok" | "fail" | "hang" = "ok";
  tickers = new Map<string, TickerData>();
  placed: Array<[IbContract, OrderIntent]> = [];
  marketDataTypes: number[] = [];
  cancelled: string[] = [];
  openOrderIds: number[] = [];
  cancelledOrders: number[] = [];
  private connectivityCb: ((code: number) => void) | null = null;

  constructor(managed: string[]) {
    this.managed = managed;
  }

  isConnected(): boolean {
    return this.connected;
  }
  disconnect(): void {
    this.connected = false;
  }
  managedAccounts(): string[] {
    return this.managed;
  }
  async qualifyContracts(contracts: IbContract[], _timeoutMs: number): Promise<void> {
    if (this.qualifyMode === "hang") throw new Error("timeout");
    for (const c of contracts) c.conId = this.qualifyMode === "ok" ? 1000 + c.symbol.length : 0;
  }
  reqMarketDataType(type: number): void {
    this.marketDataTypes.push(type);
  }
  subscribeTicker(contract: IbContract): { read(): TickerData } {
    const key = `${contract.symbol}|${contract.strike ?? ""}|${contract.right ?? ""}`;
    return { read: () => this.tickers.get(key) ?? ticker() };
  }
  cancelTicker(contract: IbContract): void {
    this.cancelled.push(contract.symbol);
  }
  async settle(_ms: number): Promise<void> {
    this.settles += 1;
    for (const [key, [after, data]] of this.arriveAfter) if (this.settles >= after) this.tickers.set(key, data);
    if (this.errorOnSettle && this.errorOnSettle[0] === this.settles) {
      const [, code, msg] = this.errorOnSettle;
      for (const cb of this.errorCbs) cb(7, code, msg);
    }
  }
  /** 记下每次历史数据请求的参数,给 historicalBars 的回归断言用。 */
  histRequests: Array<Record<string, any>> = [];
  /** 日期 → 收盘价;按请求的 durationStr 从今天倒推着给。 */
  histBars: Array<Record<string, any>> = [];
  async historicalData(_contract: IbContract, req: Record<string, any>): Promise<any[]> {
    this.histRequests.push(req);
    return this.histBars;
  }
  async secDefOptParams(): Promise<never[]> {
    return [];
  }
  async mktDepth(): Promise<{ bids: never[]; asks: never[] }> {
    return { bids: [], asks: [] };
  }
  async placeOrder(contract: IbContract, order: OrderIntent) {
    this.placed.push([contract, order]);
    return { orderId: 42, permId: 990042, status: "Submitted" };
  }
  async openTrades() {
    return this.openOrderIds.map((id) => ({
      orderId: id,
      cancel: () => this.cancelledOrders.push(id),
    }));
  }
  async portfolio(): Promise<never[]> {
    return [];
  }
  async positions(): Promise<never[]> {
    return [];
  }
  onConnectivity(cb: (code: number) => void): void {
    this.connectivityCb = cb;
  }
  errorCbs: Array<(reqId: number, code: number, message: string) => void> = [];
  settles = 0;
  /** 第几次 settle 时回哪个错误码(模拟 TWS 在等盘口期间回 101 / 10167)。 */
  errorOnSettle: [number, number, string] | null = null;
  /** 第几次 settle 后哪些 ticker 才有盘口(模拟首笔 tick 迟到)。 */
  arriveAfter = new Map<string, [number, TickerData]>();
  onError(cb: (reqId: number, code: number, message: string) => void): void {
    this.errorCbs.push(cb);
  }
  offError(cb: (reqId: number, code: number, message: string) => void): void {
    this.errorCbs = this.errorCbs.filter((f) => f !== cb);
  }
  fireConnectivity(code: number): void {
    this.connectivityCb?.(code);
  }
}

function makeRouter(
  sessions: Record<string, FakeIbSession>,
  settingsOver: Record<string, any> = {},
): [BrokerRouter, Record<string, FakeIbSession>] {
  const settings = makeSettings(g.base_config, settingsOver);
  const router = new BrokerRouter(settings, async (cfg) => {
    const byPort: Record<number, string> = { 7497: "paper", 7496: "live" };
    const name = byPort[cfg.port];
    const session = name ? sessions[name] : undefined;
    if (!session) throw new Error(`no fake session for port ${cfg.port}`);
    return session;
  });
  return [router, sessions];
}

function approvedStock(settings = makeSettings(g.base_config)): ApprovedOrder {
  const order = ParsedOrderSchema.parse(gv.cases.find((c: any) => c.name === "stock_ok").payload);
  return {
    order,
    account: settings.accounts[0]!,
    notional: 23000,
    signature: "DEFAULT|BUY|STK|AAPL",
    warnings: [],
  };
}

function approvedSpread(explicitLimit: number | null = null): ApprovedOrder {
  const payload = structuredClone(gv.cases.find((c: any) => c.name === "vertical_ok").payload);
  if (explicitLimit !== null) {
    payload.order.price_mode = "EXPLICIT";
    payload.order.lmtPrice = explicitLimit;
  }
  const order = ParsedOrderSchema.parse(payload);
  const settings = makeSettings(g.base_config);
  return {
    order, account: settings.accounts[0]!, notional: 3000,
    signature: "sig-spread", warnings: [],
  };
}

describe("BrokerRouter: 路由", () => {
  it("按 managedAccounts 实测路由;配置连接对不上时自动改道", async () => {
    const [router] = makeRouter({
      paper: new FakeIbSession(["U1234567"]), // 模拟连接上登着实盘账号
      live: new FakeIbSession(["DU7654321"]), // 实盘连接上登着模拟账号
    });
    const settings = router.settings;
    const session = await router.forAccount(settings.accounts[0]!); // 模拟 → DU7654321
    expect((session as FakeIbSession).managed).toEqual(["DU7654321"]); // 改道到 live
  });

  it("哪条连接都不管这个账户 → 明确拒绝", async () => {
    const [router] = makeRouter({
      paper: new FakeIbSession(["DU0000009"]),
      live: new FakeIbSession(["U0000009"]),
    });
    await expect(router.forAccount(router.settings.accounts[0]!)).rejects.toThrowError(
      /找不到对应会话/,
    );
  });

  it("会话没报账户列表时只对配置指定的连接放行", async () => {
    const [router] = makeRouter({
      paper: new FakeIbSession([]),
      live: new FakeIbSession([]),
    });
    const session = await router.forAccount(router.settings.accounts[0]!);
    expect(session).toBeDefined(); // paper 是配置指定的连接 → 放行
  });
});

describe("BrokerRouter: qualify 与死锁防护", () => {
  it("qualify 超时 → stalled 提示而不是无限挂", async () => {
    const fake = new FakeIbSession(["DU7654321"]);
    fake.qualifyMode = "hang";
    const [router] = makeRouter({ paper: fake, live: new FakeIbSession([]) });
    const approved = approvedStock(router.settings);
    await expect(router.place("rec-1", approved)).rejects.toThrowError(/没有响应合约确认请求/);
  });

  it("上游 1100 断开时 stalled 信息指向 TWS 重连(test_qualify_times_out…)", async () => {
    const fake = new FakeIbSession(["DU7654321"]);
    const [router] = makeRouter({ paper: fake, live: new FakeIbSession([]) });
    await router.connect("paper");
    fake.fireConnectivity(1100);
    expect(router.upstreamOk).toBe(false);
    fake.qualifyMode = "hang";
    await expect(router.place("rec-1", approvedStock(router.settings))).rejects.toThrowError(
      /错误 1100/,
    );
    fake.fireConnectivity(1102);
    expect(router.upstreamOk).toBe(true);
  });

  it("确认不了的合约被拦下", async () => {
    const fake = new FakeIbSession(["DU7654321"]);
    fake.qualifyMode = "fail";
    const [router] = makeRouter({ paper: fake, live: new FakeIbSession([]) });
    await expect(router.place("rec-1", approvedStock(router.settings))).rejects.toThrowError(
      /无法确认该合约/,
    );
  });
});

describe("BrokerRouter: 下单", () => {
  it("股票单带 orderRef(幂等标识)与账户", async () => {
    const fake = new FakeIbSession(["DU7654321"]);
    const [router] = makeRouter({ paper: fake, live: new FakeIbSession([]) });
    const result = await router.place("rec-abc", approvedStock(router.settings));
    expect(result.order_id).toBe(42);
    expect(result.status).toBe("Submitted");
    const [contract, order] = fake.placed[0]!;
    expect(contract.secType).toBe("STK");
    expect(order.orderRef).toBe("rec-abc");
    expect(order.account).toBe("DU7654321");
    expect(order.lmtPrice).toBe(230.0);
  });

  it("显式价格的条件单挂原生 PriceCondition(方式 A)", async () => {
    const fake = new FakeIbSession(["DU7654321"]);
    const [router] = makeRouter({ paper: fake, live: new FakeIbSession([]) });
    const approved = approvedSpread(15.0);
    const result = await router.place("rec-cond", approved);
    const [contract, order] = fake.placed[0]!;
    // BAG 一律以 BUY 提交
    expect(contract.secType).toBe("BAG");
    expect(order.action).toBe("BUY");
    expect(order.conditions!.length).toBe(1);
    expect(order.conditions![0]!["isMore"]).toBe(true);
    expect(order.conditions![0]!["price"]).toBe(7500.0);
    expect(order.conditionsCancelOrder).toBe(false);
    expect(result.limit_price).toBe(15.0);
  });

  it("贷方 BAG 的限价取负(bag_signed_limit 语义)", async () => {
    const fake = new FakeIbSession(["DU7654321"]);
    const [router] = makeRouter({ paper: fake, live: new FakeIbSession([]) });
    const payload = structuredClone(gv.cases.find((c: any) => c.name === "condor_ok").payload);
    const order = ParsedOrderSchema.parse(payload);
    const approved: ApprovedOrder = {
      order, account: router.settings.accounts[0]!, notional: 7600,
      signature: "sig-condor", warnings: [],
    };
    await router.place("rec-credit", approved);
    const [, sent] = fake.placed[0]!;
    expect(sent.action).toBe("BUY"); // SELL 的铁鹰也以 BUY 提交
    expect(sent.lmtPrice).toBe(-12.0); // 贷方限价取负
  });

  it("AUTO_MID 的 limit_override 原样透传(已是带符号净价)", async () => {
    const fake = new FakeIbSession(["DU7654321"]);
    const [router] = makeRouter({ paper: fake, live: new FakeIbSession([]) });
    await router.place("rec-mid", approvedSpread(), 7.95);
    expect(fake.placed[0]![1].lmtPrice).toBe(7.95);
  });

  it("cancelAllOpen 撤掉全部未成交单", async () => {
    const fake = new FakeIbSession(["DU7654321"]);
    fake.openOrderIds = [7, 8, 9];
    const [router] = makeRouter({ paper: fake, live: new FakeIbSession([]) });
    await router.connect("paper");
    expect(await router.cancelAllOpen()).toBe(3);
    expect(fake.cancelledOrders).toEqual([7, 8, 9]);
  });
});

describe("BrokerRouter: 盘口定价", () => {
  it("纸面账户退延迟盘口取腿报价;NaN 归零交给守卫", async () => {
    const fake = new FakeIbSession(["DU7654321"]);
    fake.tickers.set("SPX|7520|C", ticker({ bid: 12.4, ask: 12.8 }));
    // 7550C 没数据 → NaN → 归零
    const [router] = makeRouter({ paper: fake, live: new FakeIbSession([]) });
    const approved = approvedSpread();
    const quotes = await router.legQuotes(approved.order.contract, approved.account as any);
    expect(quotes[0]).toEqual({ action: "BUY", ratio: 1, bid: 12.4, ask: 12.8 });
    expect(quotes[1]).toEqual({ action: "SELL", ratio: 1, bid: 0.0, ask: 0.0 });
    // 延迟盘口开了又切回实时
    expect(fake.marketDataTypes[0]).toBe(3);
    expect(fake.marketDataTypes[fake.marketDataTypes.length - 1]).toBe(1);
    // 每条订阅用完都要撤,否则漏行情线路
    expect(fake.cancelled).toEqual(["SPX", "SPX"]);
    expect(fake.errorCbs).toEqual([]);
  });

  it("各腿一起轮询:等待上限是全部腿合计,不是每腿", async () => {
    const fake = new FakeIbSession(["DU7654321"]);
    fake.arriveAfter.set("SPX|7520|C", [1, ticker({ bid: 12.4, ask: 12.8 })]);
    fake.arriveAfter.set("SPX|7550|C", [3, ticker({ bid: 4.0, ask: 4.2 })]);
    const [router] = makeRouter({ paper: fake, live: new FakeIbSession([]) });
    const approved = approvedSpread();
    const quotes = await router.legQuotes(approved.order.contract, approved.account as any);
    expect(quotes.map((q) => q.bid)).toEqual([12.4, 4.0]);
    expect(fake.settles).toBe(3);   // 串行实现会是 1 + 3 = 4
  });

  it("盘口一直不来:合计只等 4 秒,零值交给守卫", async () => {
    const fake = new FakeIbSession(["DU7654321"]);
    const [router] = makeRouter({ paper: fake, live: new FakeIbSession([]) });
    const approved = approvedSpread();
    const quotes = await router.legQuotes(approved.order.contract, approved.account as any);
    expect(fake.settles).toBe(BrokerRouter.QUOTE_WAIT_MS / 250);
    expect(quotes.every((q) => q.bid === 0 && q.ask === 0)).toBe(true);
    expect(fake.cancelled.length).toBe(2);
  });

  it("等盘口期间 TWS 回 101:翻译成「行情线路已用完」", async () => {
    const fake = new FakeIbSession(["DU7654321"]);
    fake.errorOnSettle = [2, 101, "Max number of tickers has been reached"];
    const [router] = makeRouter({ paper: fake, live: new FakeIbSession([]) });
    const approved = approvedSpread();
    await expect(router.legQuotes(approved.order.contract, approved.account as any))
      .rejects.toThrow(/行情线路已用完.*101/);
    expect(fake.cancelled.length).toBe(2);
    expect(fake.marketDataTypes[fake.marketDataTypes.length - 1]).toBe(1);
    expect(fake.errorCbs).toEqual([]);
  });

  it("没有订阅(10167)翻译成订阅指引;无关错误码不改变行为", async () => {
    const fake = new FakeIbSession(["DU7654321"]);
    fake.errorOnSettle = [1, 10167, "Requested market data is not subscribed"];
    const [router] = makeRouter({ paper: fake, live: new FakeIbSession([]) });
    const approved = approvedSpread();
    await expect(router.legQuotes(approved.order.contract, approved.account as any))
      .rejects.toThrow(/没有 SPX 的行情订阅.*10167/);

    const quiet = new FakeIbSession(["DU7654321"]);
    quiet.errorOnSettle = [1, 2104, "Market data farm connection is OK"];
    const [router2] = makeRouter({ paper: quiet, live: new FakeIbSession([]) });
    const quotes = await router2.legQuotes(approved.order.contract, approved.account as any);
    expect(quotes.every((q) => q.bid === 0)).toBe(true);
  });

  it("盘口齐了就不因顺带收到的错误码拒单", async () => {
    const fake = new FakeIbSession(["DU7654321"]);
    fake.tickers.set("SPX|7520|C", ticker({ bid: 12.4, ask: 12.8 }));
    fake.tickers.set("SPX|7550|C", ticker({ bid: 4.0, ask: 4.2 }));
    fake.errorOnSettle = [1, 10167, "partly"];
    const [router] = makeRouter({ paper: fake, live: new FakeIbSession([]) });
    const approved = approvedSpread();
    const quotes = await router.legQuotes(approved.order.contract, approved.account as any);
    expect(quotes.every((q) => q.bid > 0)).toBe(true);
  });
});

describe("buildOrderIntent", () => {
  const spec = (over: Record<string, unknown>) =>
    ParsedOrderSchema.parse(
      structuredClone(
        (() => {
          const p = structuredClone(gv.cases.find((c: any) => c.name === "stock_ok").payload);
          Object.assign(p.order, over);
          return p;
        })(),
      ),
    ).order;

  it("覆盖全部订单类型;缺价的限价单当场报错", () => {
    expect(buildOrderIntent(spec({}), "DU1").lmtPrice).toBe(230.0);
    expect(buildOrderIntent(spec({ orderType: "MKT", lmtPrice: null }), "DU1").lmtPrice).toBeNull();
    const stp = buildOrderIntent(spec({ orderType: "STP", lmtPrice: null, auxPrice: 210.0 }), "DU1");
    expect(stp.auxPrice).toBe(210.0);
    const trail = buildOrderIntent(
      spec({ orderType: "TRAIL", lmtPrice: null, trailingPercent: 5.0 }), "DU1",
    );
    expect(trail.trailingPercent).toBe(5.0);
    const lmtNoPrice = { ...spec({}), lmtPrice: null };
    expect(() => buildOrderIntent(lmtNoPrice, "DU1")).toThrowError(/限价单缺少限价/);
  });

  it("golden 场景的 strike_width 输入照常可用", () => {
    expect(gb.strike_width.length).toBeGreaterThan(0);
  });
});

describe("BrokerRouter.positions:只列别名表内账户的实际持仓", () => {
  it("账号取自持仓项;别名表之外的账户跳过;蝴蝶三条腿都保留", async () => {
    const [router, sessions] = makeRouter({ paper: new FakeIbSession(["DU7654321"]) });
    await router.forAccount(router.settings.accounts[0]!); // 模拟 → DU7654321
    const leg = (strike: number, position: number, avgCost: number) => ({
      account: "DU7654321", position, avgCost,
      contract: { symbol: "SPX", secType: "OPT", lastTradeDateOrContractMonth: "20260901", strike, right: "P", multiplier: "100" },
    });
    sessions["paper"]!.positions = async () => [
      { account: "DU7654321", position: 100, avgCost: 220, contract: { symbol: "AAPL", secType: "STK" } },
      { account: "U9999999", position: 50, avgCost: 250, contract: { symbol: "TSLA", secType: "STK" } },
      leg(7600, 1, 50), leg(7615, -2, 40), leg(7630, 1, 30),
    ] as any;
    (router as any).fillPositionPrices = async () => undefined;

    const rows = await router.positions();
    expect(rows.map((r) => `${r["account"]}|${r["symbol"]}`)).toEqual([
      "模拟|AAPL", "模拟|SPX", "模拟|SPX", "模拟|SPX",
    ]);
    expect(new Set(rows.map((r) => r["key"])).size).toBe(4);
    expect(rows.filter((r) => r["sec_type"] === "OPT").map((r) => r["label"]).sort()).toEqual([
      "SPX 7600P 2026-09-01", "SPX 7615P 2026-09-01", "SPX 7630P 2026-09-01",
    ]);
  });
});

describe("BrokerRouter: 日线历史", () => {
  // IBKR 不接受 ADJUSTED_LAST 配非空 endDateTime(错误 321 "End date not supported with
  // adjusted last")。原来结束日在过去时会带上 endDateTime,于是 2024-01-01~2025-12-31
  // 这种正常回测区间直接取不到数;再叠上 todayIso 用 UTC 而 rpc 传的 end 是美东,
  // 美东 20:00 之后连 "拉到今天" 都会被误判成过去。两处都在这里钉住。
  const bar = (date: string, close: number) => ({ date, open: close, high: close, low: close, close });

  function routerWithBars(bars: Array<Record<string, any>>) {
    const [router, sessions] = makeRouter({
      paper: new FakeIbSession(["DU7654321"]),
      live: new FakeIbSession(["U1234567"]),
    });
    sessions["paper"]!.histBars = bars;
    sessions["live"]!.histBars = bars;
    return [router, sessions] as const;
  }

  it("正股的 endDateTime 永远为空,结束日在过去时本地切片", async () => {
    const [router, sessions] = routerWithBars([
      bar("2025-12-30", 10), bar("2025-12-31", 11), bar("2026-01-02", 12), bar("2026-06-01", 13),
    ]);
    await router.connect("paper");
    const bars = await router.historicalBars("AAPL", "2025-12-30", "2025-12-31");

    const req = sessions["paper"]!.histRequests.at(-1)!;
    expect(req["endDateTime"], "ADJUSTED_LAST 不能带 endDateTime").toBe("");
    expect(req["whatToShow"], "正股要前复权,不能为了带 endDateTime 退回 TRADES").toBe(
      "ADJUSTED_LAST",
    );
    // 结束日在过去 → 时长要一路覆盖到今天,否则切片切不出那一段。
    // 请求区间只有 2 天,拉取时长必须远大于它。
    const spanToToday = Math.round(
      (Date.parse(nowEt().date + "T00:00:00Z") - Date.parse("2025-12-30T00:00:00Z")) / 86_400_000,
    );
    expect(req["durationStr"]).toBe(`${spanToToday + 5} D`);
    expect(spanToToday).toBeGreaterThan(2);
    // 切片只留请求区间
    expect(bars.map((b) => b["date"])).toEqual(["2025-12-30", "2025-12-31"]);
  });

  it("结束日就是今天时不多取", async () => {
    const today = nowEt().date;
    const [router, sessions] = routerWithBars([bar(today, 20)]);
    await router.connect("paper");
    await router.historicalBars("AAPL", today, today);
    const req = sessions["paper"]!.histRequests.at(-1)!;
    expect(req["endDateTime"]).toBe("");
    expect(req["durationStr"]).toBe("5 D");
  });

  it("指数走 TRADES,同样不带 endDateTime", async () => {
    const [router, sessions] = routerWithBars([bar("2025-12-31", 7000)]);
    await router.connect("paper");
    await router.historicalBars("SPX", "2025-12-01", "2025-12-31");
    const req = sessions["paper"]!.histRequests.at(-1)!;
    expect(req["whatToShow"]).toBe("TRADES");
    expect(req["endDateTime"]).toBe("");
  });
});
