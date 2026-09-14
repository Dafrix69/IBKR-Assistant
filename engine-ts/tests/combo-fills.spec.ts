/** 组合(BAG)单的成交折叠:均价只认 BAG 行,腿留在 fills 里给界面看;重推的同一笔成交只算一次。
 *
 * 2026-09-10 模拟盘 #89:买 1 张 SPX 7660/7680/7700 看涨蝶,净价 3.55 成交。IBKR 回了 1 条 BAG 行
 * (3.55 × 1)外加每条腿一行(7660C 11 × 1、7680C 4.5 × 2、7700C 1.55 × 1),记录却把四行按数量
 * 混算成 (3.55 + 9 + 11 + 1.55) / 5 = 5.02。同一天交易分析同步成交时,TWS 又把这几条成交和佣金
 * 整批重推了两遍,手续费跟着翻了三倍。这里用当天的真实数字把两件事钉住。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { fillRow } from "../src/broker.js";
import { TradingEngine } from "../src/engine.js";
import { fillFromExecDetails } from "../src/ibSession.js";
import { Notifier } from "../src/notify.js";
import { summarize } from "../src/rpc.js";
import { TradeStore } from "../src/store.js";
import { butterflyProfile } from "../src/tradereview.js";
import { loadGolden, makeSettings } from "./util.js";

const gc = loadGolden("config");
type Rec = Record<string, any>;

const ORDER_ID = 89;
const PERM_ID = 1249750212;
const EXPIRY = "20260910";

function optContract(strike: number, conId: number): Rec {
  return {
    secType: "OPT", symbol: "SPX", lastTradeDateOrContractMonth: EXPIRY, strike, right: "C",
    multiplier: "100", tradingClass: "SPXW", currency: "USD", exchange: "CBOE", conId,
  };
}
const BAG_CONTRACT: Rec = { secType: "BAG", symbol: "SPX", currency: "USD", exchange: "SMART", conId: 28812380 };

function execution(execId: string, side: string, shares: number, price: number, orderId = ORDER_ID, permId = PERM_ID): Rec {
  return {
    execId, time: "20260910-10:00:01", side, shares, price,
    acctNumber: "DU1234567", orderId, permId, cumQty: shares, avgPrice: price,
  };
}

/** #89 的四条 execDetails([合约, 成交]),顺序同 TWS 实推:先 BAG 行,再三条腿。 */
const FLY_EXECS: Array<[Rec, Rec]> = [
  [BAG_CONTRACT, execution("00020057.6aa22ebf.01.01", "BOT", 1, 3.55)],
  [optContract(7680, 800002), execution("00020057.6aa22ebf.02.01", "SLD", 2, 4.5)],
  [optContract(7660, 800001), execution("00020057.6aa22ebf.03.01", "BOT", 1, 11)],
  [optContract(7700, 800003), execution("00020057.6aa22ebf.04.01", "BOT", 1, 1.55)],
];
/** 佣金回报只有三条腿有,BAG 行没有(当天实测)。 */
const FLY_COMMISSIONS: Array<[string, number]> = [
  ["00020057.6aa22ebf.02.01", 2.56056],
  ["00020057.6aa22ebf.03.01", 1.63028],
  ["00020057.6aa22ebf.04.01", 1.63028],
];
const FLY_COMMISSION_TOTAL = 2.56056 + 1.63028 + 1.63028;

function flyLegs(actions: [string, string, string]): Rec[] {
  return [7660, 7680, 7700].map((strike, i) => ({
    action: actions[i], ratio: i === 1 ? 2 : 1, lastTradeDateOrContractMonth: EXPIRY, strike,
    right: "C", multiplier: "100", tradingClass: "SPXW",
  }));
}

function buildEngine(): TradingEngine {
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-bagfill-"));
  const settings = makeSettings(gc.base_config, { storage: { db_path: path.join(dir, "bag.db") } });
  return new TradingEngine({
    settings, parser: {} as any, store: new TradeStore(settings.db_path),
    notifier: new Notifier(false), router: null,
  });
}

/** 按引擎下单时的形状建一条 BAG 记录,并把 orderId / permId 挂进回报索引。 */
function placeFly(engine: TradingEngine, action: "BUY" | "SELL", legActions: [string, string, string],
                  orderId = ORDER_ID, permId = PERM_ID): string {
  const record = engine.baseRecord("7680 20cm 蝶", "manual", null);
  record["account"] = { alias: "模拟", account_id: "DU1234567", is_paper: true };
  record["contract"] = {
    secType: "BAG", symbol: "SPX", exchange: "SMART", currency: "USD",
    combo_strategy: "BUTTERFLY", multiplier: "100", legs: flyLegs(legActions),
  };
  record["order"] = { action, orderType: "LMT", totalQuantity: 1, price_mode: "AUTO_MID", tif: "DAY" };
  const recordId = engine.store.createRecord(record);
  (engine as any).indexPlacement(recordId, {
    record_id: recordId, order_id: orderId, perm_id: permId, status: "Submitted", limit_price: null, detail: {},
  });
  return recordId;
}

/** 走 ibSession 的真实转换:execDetails → [trade, fill] → engine;commissionReport 同理。 */
function deliver(engine: TradingEngine, execs: Array<[Rec, Rec]>, commissions: Array<[string, number, number?]>): void {
  const trades = new Map<string, any>();
  for (const [contract, exec] of execs) {
    const [trade, fill] = fillFromExecDetails(contract, exec);
    trades.set(String(exec["execId"]), trade);
    engine.onExecDetails(trade, fill);
  }
  for (const [execId, commission, realizedPNL] of commissions) {
    engine.onCommission(trades.get(execId), null, { execId, commission, realizedPNL: realizedPNL ?? null });
  }
}

describe("组合单成交:均价只认 BAG 行", () => {
  it("#89:净价 3.55,不是四行混算的 5.02;腿仍留在 fills 里", () => {
    const engine = buildEngine();
    const rid = placeFly(engine, "BUY", ["BUY", "SELL", "BUY"]);
    deliver(engine, FLY_EXECS, FLY_COMMISSIONS);
    engine.onOrderStatus({ order: { orderId: ORDER_ID, permId: PERM_ID }, orderStatus: { status: "Filled", filled: 1, remaining: 0 } });

    const record = engine.store.getRecord(rid)!;
    const ib = record["ibkr"];
    expect(ib["avg_fill_price"]).toBeCloseTo(3.55, 9);
    expect(ib["fills"]).toHaveLength(4);
    // 每条成交都带上自己合约的 secType / conId,界面和折叠都凭它分 BAG 行与腿
    expect(ib["fills"].map((f: Rec) => [f["sec_type"], f["con_id"], f["price"], f["qty"]])).toEqual([
      ["BAG", 28812380, 3.55, 1],
      ["OPT", 800002, 4.5, 2],
      ["OPT", 800001, 11, 1],
      ["OPT", 800003, 1.55, 1],
    ]);
    expect(ib["total_commission"]).toBeCloseTo(FLY_COMMISSION_TOTAL, 9);
    expect(record["final_status"]).toBe("filled");

    // 下游:记录 API 与复盘拿到的都是 3.55
    expect(summarize(record)["avg_fill_price"]).toBeCloseTo(3.55, 9);
    const profile = butterflyProfile(record)!;
    expect(profile["debit"]).toBeCloseTo(3.55, 9);
    expect(profile["price_estimated"]).toBe(false);
  });

  it("TWS 整批重推(交易分析同步成交)不重复计:成交 4 条、手续费一份", () => {
    const engine = buildEngine();
    const rid = placeFly(engine, "BUY", ["BUY", "SELL", "BUY"]);
    // 当天实况:实时一遍,10:11 与 10:16 各重推一遍,时间换成了 reqExecutions 的格式
    deliver(engine, FLY_EXECS, FLY_COMMISSIONS);
    const replay = FLY_EXECS.map(([c, e]): [Rec, Rec] => [c, { ...e, time: "20260910 05:00:01 US/Central" }]);
    deliver(engine, replay, FLY_COMMISSIONS);
    deliver(engine, replay, FLY_COMMISSIONS);

    const record = engine.store.getRecord(rid)!;
    const ib = record["ibkr"];
    expect(ib["fills"]).toHaveLength(4);
    expect(ib["fills"].every((f: Rec) => f["time"] === "20260910-10:00:01")).toBe(true); // 先到的实时回报为准
    expect(record["commissions"]).toHaveLength(3);
    expect(ib["total_commission"]).toBeCloseTo(FLY_COMMISSION_TOTAL, 9);   // 不是 ×3 的 17.46
    expect(ib["avg_fill_price"]).toBeCloseTo(3.55, 9);
  });

  it("贷方组合(平仓卖蝶):BAG 以 BUY 提交、成交价为负,记录按正数口径给 3.00;已实现盈亏也不重复计", () => {
    const engine = buildEngine();
    // 追踪平仓发的单:腿方向全部反转、order.action=SELL,BAG 本身以 BUY + 负价提交
    const rid = placeFly(engine, "SELL", ["SELL", "BUY", "SELL"], 95, 1249750300);
    const exec = (seq: string, side: string, shares: number, price: number): Rec =>
      execution(`00020057.6aa23000.${seq}.01`, side, shares, price, 95, 1249750300);
    const execs: Array<[Rec, Rec]> = [
      [BAG_CONTRACT, exec("01", "BOT", 1, -3.0)],
      [optContract(7680, 800002), exec("02", "BOT", 2, 4.2)],
      [optContract(7660, 800001), exec("03", "SLD", 1, 10)],
      [optContract(7700, 800003), exec("04", "SLD", 1, 1.4)],
    ];
    const commissions: Array<[string, number, number]> = [
      ["00020057.6aa23000.02.01", 2.56056, -62.1],
      ["00020057.6aa23000.03.01", 1.63028, -101.6],
      ["00020057.6aa23000.04.01", 1.63028, -16.7],
    ];
    deliver(engine, execs, commissions);
    deliver(engine, execs, commissions); // 重推一遍

    const record = engine.store.getRecord(rid)!;
    const ib = record["ibkr"];
    expect(ib["avg_fill_price"]).toBeCloseTo(3.0, 9);
    expect(ib["fills"]).toHaveLength(4);
    expect(ib["total_commission"]).toBeCloseTo(FLY_COMMISSION_TOTAL, 9);
    expect(ib["realized_pnl"]).toBeCloseTo(-62.1 - 101.6 - 16.7, 9);
    expect(butterflyProfile(record)!["debit"]).toBeCloseTo(3.0, 9);
  });

  it("单腿合约(非 BAG)照旧按数量加权全部成交", () => {
    const engine = buildEngine();
    const record = engine.baseRecord("买 AAPL", "manual", null);
    record["contract"] = { secType: "STK", symbol: "AAPL" };
    record["order"] = { action: "BUY", orderType: "LMT", totalQuantity: 150, lmtPrice: 230 };
    const rid = engine.store.createRecord(record);
    (engine as any).indexPlacement(rid, { record_id: rid, order_id: 7, perm_id: 70, status: "Submitted", limit_price: null, detail: {} });
    const stk: Rec = { secType: "STK", symbol: "AAPL", conId: 265598 };
    deliver(engine, [
      [stk, execution("0000e1a7.1.01.01", "BOT", 100, 229.9, 7, 70)],
      [stk, execution("0000e1a7.1.02.01", "BOT", 50, 230.2, 7, 70)],
    ], [["0000e1a7.1.01.01", 1.0], ["0000e1a7.1.02.01", 0.5]]);

    const ib = engine.store.getRecord(rid)!["ibkr"];
    expect(ib["avg_fill_price"]).toBeCloseTo((229.9 * 100 + 230.2 * 50) / 150, 9);
    expect(ib["total_commission"]).toBeCloseTo(1.5, 9);
  });
});

describe("老记录(fill 事件没有 sec_type)", () => {
  /** 修复前落库的样子:同样四行,但 payload 里没有 sec_type / con_id。 */
  function legacyFly(store: TradeStore, recordId: string): void {
    for (const [, exec] of FLY_EXECS) {
      store.appendEvent(recordId, "fill", {
        exec_id: exec["execId"], time: exec["time"], price: exec["price"], qty: exec["shares"], commission: 0.0,
      });
    }
    for (const [execId, commission] of FLY_COMMISSIONS) {
      store.appendEvent(recordId, "commission", { exec_id: execId, commission, realized_pnl: null });
    }
  }

  it("broker_fills 里有这几笔(交易分析同步过):按 exec_id 补出 BAG 行,均价 3.55", () => {
    const engine = buildEngine();
    const rid = placeFly(engine, "BUY", ["BUY", "SELL", "BUY"]);
    legacyFly(engine.store, rid);
    engine.store.rememberFills(FLY_EXECS.map(([c, e]) => fillRow(c, e)!));

    const ib = engine.store.getRecord(rid)!["ibkr"];
    expect(ib["avg_fill_price"]).toBeCloseTo(3.55, 9);
    expect(ib["fills"]).toHaveLength(4);
    expect(ib["total_commission"]).toBeCloseTo(FLY_COMMISSION_TOTAL, 9);
  });

  it("查不到:认不出 BAG 行就不给均价(null),不输出腿价混出来的 5.02", () => {
    const engine = buildEngine();
    const rid = placeFly(engine, "BUY", ["BUY", "SELL", "BUY"]);
    legacyFly(engine.store, rid);

    const record = engine.store.getRecord(rid)!;
    expect(record["ibkr"]["avg_fill_price"]).toBeNull();
    expect(record["ibkr"]["fills"]).toHaveLength(4);                     // 明细照旧可看
    expect(butterflyProfile(record)!["price_estimated"]).toBe(true);   // 复盘退回限价并标"估算"
  });

  it("非 BAG 老记录不受影响(没有 exec_id 的也不去重)", () => {
    const store = buildEngine().store;
    const rid = store.createRecord({ contract: { secType: "STK", symbol: "AAPL" }, order: { totalQuantity: 200 } });
    store.appendEvent(rid, "fill", { qty: 100, price: 229.9, commission: 1.0 });
    store.appendEvent(rid, "fill", { qty: 100, price: 230.1, commission: 1.0 });
    const ib = store.getRecord(rid)!["ibkr"];
    expect(ib["fills"]).toHaveLength(2);
    expect(ib["avg_fill_price"]).toBeCloseTo(230.0, 9);
    expect(ib["total_commission"]).toBeCloseTo(2.0, 9);
  });
});
