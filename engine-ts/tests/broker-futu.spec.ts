/** FutuRouter 行为测试(移植自 Python test_futu.py 的券商层部分)。
 * FakeFutu 桥注入,离线;真机三结论(指数闸门 / 模拟盘合成成交 / trd_env 核对)全覆盖。 */
import { describe, expect, it } from "vitest";

import { BrokerError } from "../src/broker.js";
import type { FutuBridge, FutuQuoteCtx, FutuRet, FutuTradeCtx } from "../src/futuBridge.js";
import { FUTU_ENUMS } from "../src/futuBridge.js";
import { FutuRouter, ReportEvent } from "../src/futuBroker.js";
import { ParsedOrderSchema } from "../src/models.js";
import type { ApprovedOrder } from "../src/validator.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");
const gv = loadGolden("validator");

const OK = FUTU_ENUMS.RET_OK;
const ERR = -1;

class FakeQuoteCtx implements FutuQuoteCtx {
  subscribed: Array<[string[], string[]]> = [];
  unsubscribed: Array<[string[], string[]]> = [];
  snapshots: Record<string, Record<string, unknown>> = {};
  chain: Array<Record<string, unknown>> = [];
  expiries: Array<Record<string, unknown>> = [];
  history: Array<Record<string, unknown>> = [];
  historyError: string | null = null;
  book: Record<string, unknown> = { Bid: [[41.18, 300, 3]], Ask: [[41.22, 200, 2]] };
  optionPermissionError: string | null = null;
  closed = false;

  get_global_state(): [FutuRet, Record<string, unknown>] {
    return [OK, { server_ver: "900", qot_logined: "1", trd_logined: "1", timestamp: "1755000000" }];
  }
  subscribe(codes: string[], subtypes: string[]): [FutuRet, unknown] {
    this.subscribed.push([codes, subtypes]);
    return [OK, null];
  }
  unsubscribe(codes: string[], subtypes: string[]): [FutuRet, unknown] {
    this.unsubscribed.push([codes, subtypes]);
    return [OK, null];
  }
  unsubscribe_all(): void {
    /* noop */
  }
  get_market_snapshot(codes: string[]): [FutuRet, Array<Record<string, unknown>>] {
    return [OK, codes.map((c) => ({ code: c, ...(this.snapshots[c] ?? {}) }))];
  }
  get_stock_quote(codes: string[]): [FutuRet, Array<Record<string, unknown>>] {
    return this.get_market_snapshot(codes);
  }
  get_order_book(_code: string, _num: number): [FutuRet, Record<string, unknown>] {
    return [OK, this.book];
  }
  request_history_kline(_opts: Record<string, unknown>): [FutuRet, Array<Record<string, unknown>>, unknown] {
    if (this.historyError) return [ERR, [{ msg: this.historyError }] as any, null];
    return [OK, this.history, null];
  }
  get_option_expiration_date(_code: string): [FutuRet, Array<Record<string, unknown>>] {
    if (this.optionPermissionError) return [ERR, this.optionPermissionError as any];
    return [OK, this.expiries];
  }
  get_option_chain(_opts: Record<string, unknown>): [FutuRet, Array<Record<string, unknown>>] {
    return [OK, this.chain];
  }
  get_stock_basicinfo(_market: string, _secType: string): [FutuRet, Array<Record<string, unknown>>] {
    return [OK, [{ code: "US..SPX" }, { code: "US..NDX" }]];
  }
  close(): void {
    this.closed = true;
  }
}

class FakeTradeCtx implements FutuTradeCtx {
  accList: Array<Record<string, unknown>> = [
    { acc_id: "7654321", trd_env: "SIMULATE" },
    { acc_id: "7654322", trd_env: "REAL" },
  ];
  placeCalls: Array<Record<string, unknown>> = [];
  placeResult: [FutuRet, unknown] = [OK, [{ order_id: "FT001", order_status: "SUBMITTED" }]];
  orderRows: Array<Record<string, unknown>> = [];
  dealRows: Array<Record<string, unknown>> = [];
  dealError: string | null = null;
  unlockCalls: string[] = [];
  unlockResult: [FutuRet, unknown] = [OK, null];
  cancelled: string[] = [];

  get_acc_list(): [FutuRet, Array<Record<string, unknown>>] {
    return [OK, this.accList];
  }
  unlock_trade(passwordMd5: string): [FutuRet, unknown] {
    this.unlockCalls.push(passwordMd5);
    return this.unlockResult;
  }
  place_order(opts: Record<string, unknown>): [FutuRet, any] {
    this.placeCalls.push(opts);
    return this.placeResult as [FutuRet, any];
  }
  order_list_query(): [FutuRet, Array<Record<string, unknown>>] {
    return [OK, this.orderRows];
  }
  deal_list_query(): [FutuRet, any] {
    if (this.dealError) return [ERR, this.dealError];
    return [OK, this.dealRows];
  }
  modify_order(_op: string, orderId: string): [FutuRet, unknown] {
    this.cancelled.push(orderId);
    return [OK, null];
  }
  position_list_query(): [FutuRet, Array<Record<string, unknown>>] {
    return [OK, []];
  }
  close(): void {
    /* noop */
  }
}

function fakeBridge(quote: FakeQuoteCtx, trade: FakeTradeCtx): FutuBridge {
  return {
    ...FUTU_ENUMS,
    makeQuoteCtx: () => quote,
    makeTradeCtx: () => trade,
  };
}

const FUTU_OVER = {
  broker: { provider: "futu" },
  connections: {
    opend: { broker: "futu", host: "127.0.0.1", port: 11111, client_id: 1 },
    paper: { host: "127.0.0.1", port: 7497, client_id: 11 },
    live: { host: "127.0.0.1", port: 7496, client_id: 12 },
  },
  accounts: [
    { alias: "富途模拟", account_id: "7654321", is_paper: true, connection: "opend", default: true },
    { alias: "富途实盘", account_id: "7654322", is_paper: false, connection: "opend" },
  ],
};

function makeRouter(
  over: Record<string, any> = {},
  secret: string | null = null,
): [FutuRouter, FakeQuoteCtx, FakeTradeCtx] {
  const quote = new FakeQuoteCtx();
  const trade = new FakeTradeCtx();
  const settings = makeSettings(g.base_config, { ...FUTU_OVER, ...over });
  const router = new FutuRouter(
    settings,
    fakeBridge(quote, trade),
    async () => ({ open: true, latency_ms: 1, error: null }),
    () => secret,
  );
  return [router, quote, trade];
}

function approvedStock(router: FutuRouter, accountIdx = 0): ApprovedOrder {
  const order = ParsedOrderSchema.parse(gv.cases.find((c: any) => c.name === "stock_ok").payload);
  return {
    order, account: router.settings.accounts[accountIdx]!,
    notional: 23000, signature: "sig", warnings: [],
  };
}

describe("FutuRouter: 代码换算(查,不猜)", () => {
  it("普通美股按 US.<代码> 拼", async () => {
    const [router] = makeRouter();
    await router.connect("opend");
    expect(await router.code("AAPL")).toBe("US.AAPL");
  });

  it("覆盖表优先", async () => {
    const [router] = makeRouter({ broker: { provider: "futu", futu: { symbol_map: { BRKB: "US.BRK.B" } } } });
    await router.connect("opend");
    expect(await router.code("BRKB")).toBe("US.BRK.B");
  });

  it("指数代码去富途的证券列表实测(US..SPX 双点)", async () => {
    const [router] = makeRouter();
    await router.connect("opend");
    expect(await router.code("SPX")).toBe("US..SPX");
  });

  it("查不到的指数点名怎么修", async () => {
    const [router] = makeRouter({
      index_symbols: {
        SPX: { exchange: "CBOE", daily_trading_class: "SPXW", monthly_trading_class: "SPX" },
        RUT: { exchange: "CBOE" },
      },
    });
    await router.connect("opend");
    await expect(router.code("RUT")).rejects.toThrowError(/symbol_map 里显式指定/);
  });

  it("期权代码用链反查;行权价不存在被拦截", async () => {
    const [router, quote] = makeRouter();
    await router.connect("opend");
    quote.chain = [
      { code: "US.AAPL260821C180000", strike_price: 180.0, option_type: "CALL" },
      { code: "US.AAPL260821C185000", strike_price: 185.0, option_type: "CALL" },
    ];
    expect(await router.optionCode("AAPL", "20260821", 180.0, "C")).toBe("US.AAPL260821C180000");
    await expect(router.optionCode("AAPL", "20260821", 999.0, "C")).rejects.toThrowError(
      /没有行权价/,
    );
  });
});

describe("FutuRouter: 指数闸门(真机结论①)", () => {
  it("涉及指数的行情一律拒绝,且不替用户换标的", async () => {
    const [router] = makeRouter();
    await router.connect("opend");
    const reason = router.quoteCapability("SPX")!;
    expect(reason).toContain("不支持美股指数");
    expect(reason).toContain("SPX→SPY");
    expect(reason).toContain("不会替你换标的");
    expect(router.quoteCapability("AAPL")).toBeNull();
    expect(await router.indexPrice("SPX")).toBeNull();
  });

  it("批量报价跳过指数,不给一行全 null", async () => {
    const [router, quote] = makeRouter();
    await router.connect("opend");
    quote.snapshots["US.AAPL"] = { last_price: 230.0, prev_close_price: 225.0 };
    const out = await router.stockQuotes(["AAPL", "SPX"]);
    expect(Object.keys(out)).toEqual(["AAPL"]);
    expect(out["AAPL"]!["last"]).toBe(230.0);
    expect(out["AAPL"]!["change_pct"]).toBeCloseTo(2.22, 2);
  });

  it("指数的期权链不被行情闸门挡住(缺的只是现价)", async () => {
    const [router, quote] = makeRouter();
    await router.connect("opend");
    quote.expiries = [{ strike_time: "2026-08-14" }];
    const meta = await router.optionExpiries("SPX");
    expect(meta["expiries"]).toEqual(["20260814"]);
  });

  it("期权权限错误直接说去哪开通,不反问", async () => {
    const [router, quote] = makeRouter();
    await router.connect("opend");
    quote.optionPermissionError = "无权限,no right to access option 期权";
    await expect(router.optionExpiries("AAPL")).rejects.toThrowError(/开通「美股期权行情」/);
  });
});

describe("FutuRouter: K 线与盘口", () => {
  it("2 分钟周期按设计拒绝,不拿 1 分钟合成", async () => {
    const [router] = makeRouter();
    await router.connect("opend");
    await expect(router.intradayBars("AAPL", "2m")).rejects.toThrowError(/最小档位是 1 分钟/);
  });

  it("日线历史按日期排序并按区间裁剪;空结果提到额度", async () => {
    const [router, quote] = makeRouter();
    await router.connect("opend");
    quote.history = [
      { time_key: "2026-08-13 00:00:00", open: 2, high: 3, low: 1, close: 2.5 },
      { time_key: "2026-08-11 00:00:00", open: 1, high: 2, low: 0.5, close: 1.5 },
      { time_key: "2026-09-01 00:00:00", open: 9, high: 9, low: 9, close: 9 }, // 区间外
    ];
    const bars = await router.historicalBars("AAPL", "2026-08-10", "2026-08-20");
    expect(bars.map((b) => b["date"])).toEqual(["2026-08-11", "2026-08-13"]);
    quote.history = [];
    await expect(router.historicalBars("AAPL", "2026-08-10", "2026-08-20")).rejects.toThrowError(
      /额度是否已用完/,
    );
  });

  it("盘口只有一档时注明需要 LV2,并且用完退订", async () => {
    const [router, quote] = makeRouter();
    await router.connect("opend");
    const book = await router.orderBook("AAPL");
    expect(book["note"]).toContain("LV2");
    expect(book["l1"]["bid"]).toBe(41.18);
    expect(book["l1"]["spread_bps"]).toBeGreaterThan(0);
    expect(quote.unsubscribed.length).toBe(1); // ORDER_BOOK 退订
    expect(quote.unsubscribed[0]![0]).toEqual(["US.AAPL"]);
  });
});

describe("FutuRouter: 下单(真机结论③:trd_env 核对)", () => {
  it("股票单带 remark=record_id;BAG 直接拒", async () => {
    const [router, , trade] = makeRouter();
    const result = await router.place("rec-futu-1", approvedStock(router));
    expect(result.status).toBe("Submitted");
    expect(result.detail["futu_order_id"]).toBe("FT001");
    expect(trade.placeCalls[0]!["remark"]).toBe("rec-futu-1");
    expect(trade.placeCalls[0]!["code"]).toBe("US.AAPL");
    expect(trade.placeCalls[0]!["trd_env"]).toBe("SIMULATE");

    const spread = ParsedOrderSchema.parse(
      gv.cases.find((c: any) => c.name === "vertical_ok").payload,
    );
    const approved: ApprovedOrder = {
      order: spread, account: router.settings.accounts[0]!, notional: 1, signature: "s", warnings: [],
    };
    await expect(router.place("rec-bag", approved)).rejects.toThrowError(/不支持多腿组合单/);
  });

  it("is_paper 与富途报的 trd_env 不一致 → 当场拒", async () => {
    const [router, , trade] = makeRouter();
    trade.accList = [{ acc_id: "7654321", trd_env: "REAL" }]; // 配置写模拟,富途报实盘
    await expect(router.place("rec-env", approvedStock(router))).rejects.toThrowError(
      /is_paper 决定要不要过实盘闸门/,
    );
  });

  it("实盘未解锁拒单;解锁密码从注入的读取器来", async () => {
    const [router, , trade] = makeRouter({}, "d41d8cd98f00b204e9800998ecf8427e");
    await expect(router.place("rec-live", approvedStock(router, 1))).rejects.toThrowError(
      /尚未做交易解锁/,
    );
    const out = await router.unlock("opend");
    expect(out["unlocked"]).toEqual(["opend"]);
    expect(trade.unlockCalls).toEqual(["d41d8cd98f00b204e9800998ecf8427e"]);
    const result = await router.place("rec-live", approvedStock(router, 1));
    expect(result.detail["account"]).toBe("7654322");
  });

  it("没存密码时明说只有模拟盘可用", async () => {
    const [router] = makeRouter({}, null);
    await expect(router.unlock("opend")).rejects.toThrowError(/不解锁只能下模拟盘/);
  });

  it("绑在 IBKR 连接上的账户拒绝(跨券商绝不改道)", async () => {
    const [router] = makeRouter({
      accounts: [
        { alias: "富途模拟", account_id: "7654321", is_paper: true, connection: "opend", default: true },
        { alias: "错绑", account_id: "7654399", is_paper: true, connection: "paper" },
      ],
    });
    const approved = approvedStock(router, 1);
    await expect(router.place("rec-x", approved)).rejects.toThrowError(/不是富途连接/);
  });
});

describe("FutuRouter: 回报轮询(真机结论②:模拟盘合成成交)", () => {
  async function placed(): Promise<[FutuRouter, FakeQuoteCtx, FakeTradeCtx]> {
    const [router, quote, trade] = makeRouter();
    await router.place("rec-poll", approvedStock(router));
    return [router, quote, trade];
  }

  it("状态与成交包成 ib_insync 同形对象;不重复上报", async () => {
    const [router, , trade] = await placed();
    trade.orderRows = [
      { order_id: "FT001", order_status: "SUBMITTED", qty: 100, dealt_qty: 0 },
    ];
    trade.dealRows = [];
    let events = await router.pollOrderUpdates();
    const statusEvents = events.filter((e: ReportEvent) => e[0] === "status");
    expect(statusEvents.length).toBe(1);
    expect(statusEvents[0]![1].orderStatus.status).toBe("Submitted");
    // 同一状态第二轮不重复
    events = await router.pollOrderUpdates();
    expect(events.length).toBe(0);
    // 实盘路径:真实逐笔成交
    trade.orderRows = [{ order_id: "FT001", order_status: "FILLED_ALL", qty: 100, dealt_qty: 100 }];
    trade.dealRows = [
      { order_id: "FT001", deal_id: "D1", price: 229.9, qty: 100, trd_side: "BUY",
        create_time: "2026-08-14 10:35:00" },
    ];
    events = await router.pollOrderUpdates();
    const fills = events.filter((e: ReportEvent) => e[0] === "fill");
    expect(fills.length).toBe(1);
    expect(fills[0]![2]!.execution.execId).toBe("D1");
    expect(fills[0]![2]!.execution.price).toBe(229.9);
    const statuses = events.filter((e: ReportEvent) => e[0] === "status");
    expect(statuses[0]![1].orderStatus.status).toBe("Filled");
    // 成交去重
    events = await router.pollOrderUpdates();
    expect(events.filter((e: ReportEvent) => e[0] === "fill").length).toBe(0);
  });

  it("模拟盘查不到成交 → 认一次后不再问,改用订单行合成(带「合成」标记)", async () => {
    const [router, , trade] = await placed();
    trade.dealError = "模拟交易不支持成交查询";
    trade.orderRows = [
      { order_id: "FT001", order_status: "FILLED_PART", qty: 100, dealt_qty: 40,
        dealt_avg_price: 229.95, updated_time: "2026-08-14 10:36:00" },
    ];
    // 第一轮:deal 查询失败先被记住,同一轮的订单读取立刻开始合成(与 Python 顺序一致)
    let events = await router.pollOrderUpdates();
    let fills = events.filter((e) => e[0] === "fill");
    expect(fills.length).toBe(1);
    expect(fills[0]![2]!.execution.execId).toContain("(合成)");
    expect(fills[0]![2]!.execution.shares).toBe(40);
    expect(fills[0]![2]!.execution.price).toBe(229.95);
    // 第二轮:dealt 增量 → 只合成新增的那一段
    trade.orderRows = [
      { order_id: "FT001", order_status: "FILLED_ALL", qty: 100, dealt_qty: 100,
        dealt_avg_price: 229.97, updated_time: "2026-08-14 10:37:00" },
    ];
    events = await router.pollOrderUpdates();
    fills = events.filter((e) => e[0] === "fill");
    expect(fills.length).toBe(1);
    expect(fills[0]![2]!.execution.execId).toContain("(合成)");
    expect(fills[0]![2]!.execution.shares).toBe(60); // 只记本轮新增
    expect(fills[0]![2]!.execution.price).toBe(229.97);
  });
});

describe("FutuRouter: 熔断撤单", () => {
  it("只撤本引擎发出的未成交单,别人的不动", async () => {
    const [router, , trade] = makeRouter();
    await router.place("rec-c1", approvedStock(router));
    trade.orderRows = [
      { order_id: "FT001", order_status: "SUBMITTED", qty: 100, dealt_qty: 0 }, // 我们的
      { order_id: "MANUAL9", order_status: "SUBMITTED", qty: 5, dealt_qty: 0 }, // 用户手动挂的
      { order_id: "FT001-done", order_status: "FILLED_ALL", qty: 1, dealt_qty: 1 }, // 非在途
    ];
    const count = await router.cancelAllOpen();
    expect(count).toBe(1);
    expect(trade.cancelled).toEqual(["FT001"]);
  });
});

describe("FutuRouter: parity 反推接线", () => {
  it("指数期权链的现价由链反推,spot_source=parity", async () => {
    const [router, quote] = makeRouter();
    await router.connect("opend");
    quote.expiries = [{ strike_time: "2026-09-18" }];
    // 构造干净的平价链:S=7500, D=e^(-4%/12)
    const disc = Math.exp(-0.04 / 12);
    const chain: Array<Record<string, unknown>> = [];
    for (let k = 7300; k <= 7700; k += 25) {
      const put = Math.max(5, 30 + (k - 7500) * 0.4);
      const call = 7500 - k * disc + put;
      if (call <= 0) continue;
      chain.push({ code: `US.SPX${k}C`, strike_price: k, option_type: "CALL" });
      chain.push({ code: `US.SPX${k}P`, strike_price: k, option_type: "PUT" });
      quote.snapshots[`US.SPX${k}C`] = { bid_price: call - 0.01, ask_price: call + 0.01 };
      quote.snapshots[`US.SPX${k}P`] = { bid_price: put - 0.01, ask_price: put + 0.01 };
    }
    quote.chain = chain;
    const result = await router.optionChain("SPX", "20260918", 5);
    expect(result["spot_source"]).toBe("parity");
    expect(Math.abs((result["spot"] as number) - 7500)).toBeLessThan(0.5);
    expect((result["rows"] as unknown[]).length).toBeGreaterThan(0);
  });
});
