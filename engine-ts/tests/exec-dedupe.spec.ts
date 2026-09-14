/** 成交 / 佣金回报去重:同一 exec_id 只落一次库、只弹一次「成交回报」。
 *
 * 交易分析同步成交(router.executions → reqExecutions)时,TWS 会把当天的 execDetails / commissionReport
 * 在实时回报的同两个事件上整批重推。2026-09-10 模拟盘 #89(SPX 7660/7680/7700 看涨蝶):4 条成交、
 * 3 条佣金,10:00 实时来一次,10:11:37、10:16:44 同步成交时各重来一次——每次都又落库、又通知。
 *
 * 两道闸:ibSession 的 execForwarder(本会话同一 execId 只转一次)和引擎按 exec_id 的集合
 * (会话重建后前一道是空的,靠它兜底)。这里数的是 record_events 里真正写进去的行,
 * 不看 getRecord 折叠后的结果——读侧去重掩盖不了写侧的重复。 */
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TradingEngine } from "../src/engine.js";
import { execForwarder } from "../src/ibSession.js";
import { Notifier } from "../src/notify.js";
import { TradeStore } from "../src/store.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("config");
type Rec = Record<string, any>;

const ORDER_ID = 89;
const PERM_ID = 5550089;
const ACCOUNT = "DU1234567";
const LIVE_TIME = "20260910-10:00:01";               // 实时推送的时间格式
const REPLAY_TIME = "20260910 05:00:01 US/Central";  // reqExecutions 回应的时间格式

const leg = (strike: number): Rec => ({
  secType: "OPT", symbol: "SPX", lastTradeDateOrContractMonth: "20260910", strike, right: "C", tradingClass: "SPXW",
});
/** #89 一次成交 TWS 推的:BAG 净价一行 + 每条腿一行(同一 permId),佣金回报只给腿。
 * exec_id 取自 #89;哪个 exec_id 对哪一行、佣金数额是随手配的,去重不看这些。
 * [execId, 成交合约, 方向, 数量, 价格, 佣金(null = 这一行没有佣金回报)] */
const FLY_89: Array<[string, Rec, string, number, number, number | null]> = [
  ["00020057.6aa22ebf.01.01", { secType: "BAG", symbol: "SPX" }, "BOT", 1, 3.55, null],
  ["00020057.6aa22ebf.02.01", leg(7660), "BOT", 1, 11.0, 1.1],
  ["00020057.6aa22ebf.03.01", leg(7680), "SLD", 2, 4.5, 2.2],
  ["00020057.6aa22ebf.04.01", leg(7700), "BOT", 1, 1.55, 1.1],
];
const LEG_COMMISSION = 1.1 + 2.2 + 1.1;

/** IbSession 替身:回报走真的 execForwarder——和 createIbApiNextSession 挂在底层事件上的是同一段。 */
function fakeSession() {
  const fillCbs: Array<(trade: any, fill: any) => void> = [];
  const commissionCbs: Array<(trade: any, fill: any, report: any) => void> = [];
  const fwd = execForwarder(fillCbs, commissionCbs);
  return {
    onOrderStatus: (_cb: unknown): void => undefined,
    onFill: (cb: (trade: any, fill: any) => void): void => { fillCbs.push(cb); },
    onCommission: (cb: (trade: any, fill: any, report: any) => void): void => { commissionCbs.push(cb); },
    /** TWS 推一遍 #89:reqId −1 = 实时成交,别的 = reqExecutions 的回应 */
    push(reqId: number, time: string): void {
      for (const [execId, contract, side, shares, price, commission] of FLY_89) {
        fwd.onExecDetails(reqId, contract, {
          execId, time, side, shares, price, orderId: ORDER_ID, permId: PERM_ID, acctNumber: ACCOUNT,
        });
        if (commission !== null) fwd.onCommissionReport({ execId, commission, currency: "USD", realizedPNL: undefined });
      }
    },
  };
}

/** record_events 里这条记录每种事件写了几行(另开只读连接,直接数库)。 */
function rawEventCounts(dbPath: string, recordId: string): Record<string, number> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT kind, COUNT(*) AS n FROM record_events WHERE record_id=? GROUP BY kind")
      .all(recordId) as Array<{ kind: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  } finally {
    db.close();
  }
}

function buildEngine(indexed = true) {
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-exec-"));
  const settings = makeSettings(g.base_config, { storage: { db_path: path.join(dir, "exec.db") } });
  const notifier = new Notifier(false);
  const engine = new TradingEngine({
    settings, parser: {} as any, store: new TradeStore(settings.db_path), notifier, router: null,
  });
  const recordId = engine.store.createRecord(engine.baseRecord("买 1 张 SPX 7660/7680/7700 看涨蝶", "test", null));
  // ibSession.placeOrder 回的 permId 是 null,真机上只按 orderId 登记
  const index = (): void => (engine as any).indexPlacement(recordId, {
    record_id: recordId, order_id: ORDER_ID, perm_id: null, status: "Submitted", limit_price: null, detail: {},
  });
  if (indexed) index();
  return {
    engine, recordId, index,
    events: () => rawEventCounts(settings.db_path, recordId),
    fillAlerts: () => notifier.history.filter(([title]) => title === "成交回报").length,
  };
}

describe("成交回报去重:reqExecutions 重推不再落库、不再通知", () => {
  it("#89 原样重放:实时一次 + 同步成交两次重推 → 4 条成交、3 条佣金各落一次,只弹 4 条成交回报", () => {
    const { engine, recordId, events, fillAlerts } = buildEngine();
    const session = fakeSession();
    engine.wireSession(session);

    session.push(-1, LIVE_TIME);         // 10:00 实时
    session.push(7, REPLAY_TIME);        // 10:11:37 打开交易分析
    session.push(9, REPLAY_TIME);        // 10:16:44 再同步一次

    expect(events()).toEqual({ fill: 4, commission: 3 });
    expect(fillAlerts()).toBe(4);
    const record = engine.store.getRecord(recordId)!;
    expect(record["ibkr"]["fills"].map((f: Rec) => f["time"])).toEqual(Array(4).fill(LIVE_TIME)); // 留的是实时那一版
    expect(record["ibkr"]["total_commission"]).toBeCloseTo(LEG_COMMISSION, 9);                    // 手续费不翻倍
  });

  it("会话重建(TWS 重连)后 ibSession 那道闸是空的,重推照转过来——引擎按 exec_id 兜底", () => {
    const { engine, events, fillAlerts } = buildEngine();
    const before = fakeSession();
    engine.wireSession(before);
    before.push(-1, LIVE_TIME);

    const after = fakeSession();        // router 重连后的新会话,sessionHook 会再 wire 一次
    engine.wireSession(after);
    after.push(7, REPLAY_TIME);
    after.push(9, REPLAY_TIME);

    expect(events()).toEqual({ fill: 4, commission: 3 });
    expect(fillAlerts()).toBe(4);
  });

  it("断线期间的成交(实时回报没收到)靠 reqExecutions 补录:落库一次,但不弹通知", () => {
    const { engine, recordId, events, fillAlerts } = buildEngine();
    const session = fakeSession();
    engine.wireSession(session);

    session.push(7, REPLAY_TIME);
    session.push(9, REPLAY_TIME);

    expect(events()).toEqual({ fill: 4, commission: 3 });
    expect(fillAlerts()).toBe(0);
    expect(engine.store.getRecord(recordId)!["ibkr"]["fills"]).toHaveLength(4);
  });

  it("回报比下单返回还早(先进缓冲),登记之前又被重推一次:登记后重放也只落一次", () => {
    const { engine, index, events, fillAlerts } = buildEngine(false);
    const before = fakeSession();
    const after = fakeSession();
    engine.wireSession(before);
    engine.wireSession(after);
    before.push(-1, LIVE_TIME);         // 对不上记录 → 进 unmatchedEvents
    after.push(7, REPLAY_TIME);         // 另一条会话的重推,同样进缓冲
    expect(events()).toEqual({});

    index();                            // indexPlacement → replayUnmatched

    expect(events()).toEqual({ fill: 4, commission: 3 });
    expect(fillAlerts()).toBe(4);       // 实时那一版先进缓冲,通知照发;重推那一版被去重
  });
});

describe("引擎直接收回报(不经 ibSession,例如富途拉取、测试替身)", () => {
  const trade = { order: { orderId: ORDER_ID, permId: PERM_ID }, contract: { symbol: "SPX" } };
  const fill = (execId: string) => ({
    execution: { execId, time: LIVE_TIME, price: 3.55, shares: 1, side: "BOT", acctNumber: ACCOUNT },
  });

  it("同一 exec_id 第二次 onExecDetails / onCommission:不落库、不通知", () => {
    const { engine, events, fillAlerts } = buildEngine();
    engine.onExecDetails(trade, fill("e-1"));
    engine.onExecDetails(trade, fill("e-1"));
    engine.onCommission(trade, null, { execId: "e-1", commission: 1.1 });
    engine.onCommission(trade, null, { execId: "e-1", commission: 1.1 });
    engine.onExecDetails(trade, fill("e-2"));

    expect(events()).toEqual({ fill: 2, commission: 1 });
    expect(fillAlerts()).toBe(2);
  });

  it("没有 live 标记的一律当实时,照旧通知(富途的成交只能靠拉取发现)", () => {
    const { engine, fillAlerts } = buildEngine();
    engine.onExecDetails(trade, fill("deal-1"));
    expect(fillAlerts()).toBe(1);
  });

  it("没有 exec_id 的认不出是不是同一笔,照旧每条都落(不能把它们并成一条)", () => {
    const { engine, events } = buildEngine();
    engine.onExecDetails(trade, fill(""));
    engine.onExecDetails(trade, fill(""));
    engine.onCommission(trade, null, { commission: 1.1 });
    engine.onCommission(trade, null, { commission: 1.1 });
    expect(events()).toEqual({ fill: 2, commission: 2 });
  });
});
