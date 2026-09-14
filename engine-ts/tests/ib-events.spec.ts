/** 底层 IBApi 事件 → 引擎期望的 ib_insync 同形对象。
 *
 * 2026-09-08 模拟盘实测:单子成交了,记录永远停在 Submitted——原来 ibSession 只订阅了 IBApiNext 的
 * getOpenOrders(推的是 OpenOrdersUpdate 集合),成交回调 fillCbs 从没被调用过。现在直接挂在
 * orderStatus / execDetails / commissionReport 三个事件上,这里钉住转换后的形状。 */
import { describe, expect, it } from "vitest";

import { execForwarder, fillFromExecDetails, tradeFromOrderStatus } from "../src/ibSession.js";

describe("IBApi 事件转换", () => {
  it("orderStatus → trade.order.{orderId,permId} + trade.orderStatus.{status,filled,remaining,avgFillPrice}", () => {
    const trade = tradeFromOrderStatus(76, "Filled", 3, 0, 318.65, 1234567, { symbol: "AAPL", secType: "STK" });
    expect(trade.order).toEqual({ orderId: 76, permId: 1234567 });
    expect(trade.orderStatus).toEqual({ status: "Filled", filled: 3, remaining: 0, avgFillPrice: 318.65 });
    expect(trade.contract).toEqual({ symbol: "AAPL", secType: "STK" });
  });

  it("permId 缺失或为 0 时记 null,引擎按 orderId 匹配", () => {
    const trade = tradeFromOrderStatus(76, "Submitted", 0, 3, 0, undefined, undefined);
    expect(trade.order).toEqual({ orderId: 76, permId: null });
    expect(trade.contract).toEqual({});
  });

  it("execDetails → [trade, fill]:fill.execution 带 execId/time/price/shares/side/acctNumber", () => {
    const execution = {
      execId: "0000e1a7.68bea7c8.01.01", time: "20260908 05:25:58", price: 318.6, shares: 3, side: "BOT",
      acctNumber: "DU1234567", orderId: 76, permId: 1234567, cumQty: 3, avgPrice: 318.6,
    };
    const [trade, fill] = fillFromExecDetails({ symbol: "AAPL", secType: "STK" }, execution);
    expect(trade.order).toEqual({ orderId: 76, permId: 1234567 });
    expect(trade.contract.symbol).toBe("AAPL");
    expect(fill.execution).toMatchObject({
      execId: "0000e1a7.68bea7c8.01.01", time: "20260908 05:25:58", price: 318.6, shares: 3, side: "BOT",
      acctNumber: "DU1234567",
    });
  });

  it("reqId = −1 是实时推送(live);别的 reqId 是 reqExecutions 的回应", () => {
    expect(fillFromExecDetails({}, { execId: "x" }, -1)[1].live).toBe(true);
    expect(fillFromExecDetails({}, { execId: "x" })[1].live).toBe(true);
    expect(fillFromExecDetails({}, { execId: "x" }, 7)[1].live).toBe(false);
  });
});

describe("execForwarder:同一 execId 本会话只转一次", () => {
  function wired() {
    const fills: Array<[any, any]> = [];
    const commissions: Array<[any, any]> = [];
    const fwd = execForwarder([(t, f) => fills.push([t, f])], [(t, _f, r) => commissions.push([t, r])]);
    return { fwd, fills, commissions };
  }
  const exec = (execId: string, time: string) => ({ execId, time, orderId: 89, permId: 5550089, shares: 1, price: 3.55 });

  it("实时成交与佣金照转;reqExecutions 重推同一笔(换了时间格式)成交和佣金都丢掉", () => {
    const { fwd, fills, commissions } = wired();
    fwd.onExecDetails(-1, { secType: "BAG", symbol: "SPX" }, exec("00020057.6aa22ebf.01.01", "20260910-10:00:01"));
    fwd.onCommissionReport({ execId: "00020057.6aa22ebf.01.01", commission: 1.1 });
    expect(fills).toHaveLength(1);
    expect(fills[0]![1].live).toBe(true);
    expect(commissions).toHaveLength(1);
    expect(commissions[0]![0].order).toEqual({ orderId: 89, permId: 5550089 });

    for (const reqId of [7, 9]) {
      fwd.onExecDetails(reqId, { secType: "BAG", symbol: "SPX" }, exec("00020057.6aa22ebf.01.01", "20260910 05:00:01 US/Central"));
      fwd.onCommissionReport({ execId: "00020057.6aa22ebf.01.01", commission: 1.1 });
    }
    expect(fills).toHaveLength(1);
    expect(commissions).toHaveLength(1);
  });

  it("没见过的 execId 从 reqExecutions 来(断线期间成交):照样转去补录,但标 live = false", () => {
    const { fwd, fills, commissions } = wired();
    fwd.onExecDetails(7, { secType: "OPT", symbol: "SPX" }, exec("00020057.6aa22ebf.02.01", "20260910 05:00:01 US/Central"));
    fwd.onCommissionReport({ execId: "00020057.6aa22ebf.02.01", commission: 1.1 });
    expect(fills).toHaveLength(1);
    expect(fills[0]![1].live).toBe(false);
    expect(commissions).toHaveLength(1);
  });

  it("佣金对不上本会话见过的成交就不转(不是这条连接的单)", () => {
    const { fwd, commissions } = wired();
    fwd.onCommissionReport({ execId: "别的客户端的成交", commission: 1.1 });
    expect(commissions).toEqual([]);
  });

  it("挂回调晚于 execForwarder 创建也收得到(ibSession 先建闸、engine 后 wireSession)", () => {
    const fillCbs: Array<(t: any, f: any) => void> = [];
    const fwd = execForwarder(fillCbs, []);
    const got: any[] = [];
    fillCbs.push((_t, f) => got.push(f));
    fwd.onExecDetails(-1, {}, exec("e-late", "20260910-10:00:01"));
    expect(got).toHaveLength(1);
  });
});
