/** 底层 IBApi 事件 → 引擎期望的 ib_insync 同形对象。
 *
 * 2026-09-08 模拟盘实测:单子成交了,记录永远停在 Submitted——原来 ibSession 只订阅了 IBApiNext 的
 * getOpenOrders(推的是 OpenOrdersUpdate 集合),成交回调 fillCbs 从没被调用过。现在直接挂在
 * orderStatus / execDetails / commissionReport 三个事件上,这里钉住转换后的形状。 */
import { describe, expect, it } from "vitest";

import { fillFromExecDetails, tradeFromOrderStatus } from "../src/ibSession.js";

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
});
