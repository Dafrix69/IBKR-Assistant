/** 组合的三处口径(2026-09-27 审计 T2):
 *
 *  · 铁蝶永远认不出来:同一行权价上看涨排在看跌前面(C < P),四条腿读成 P,C,P,C,落进「组合(4 腿)」;
 *  · 净值会穿过 0 的组合(断翼蝶、比例价差)按绝对值记现价:借方断翼蝶真值 −25,追踪读成 +25,
 *    止损永远不触发、止盈反而触发;贷方的反过来,赢钱的时候触发止损;
 *  · 拼不出平仓单的持仓(认不出结构的组合、FOP)照样能开自动平仓 / 托管——到价那一刻 schema 才拒,
 *    托管那一路每秒失败一次、三次就熔断。closeContractIssue 让上层在设置时就拒。
 */
import { describe, expect, it } from "vitest";

import { parseLlmPayload } from "../src/models.js";
import * as tk from "../src/tracker.js";

type Row = Record<string, unknown>;

function leg(strike: number, right: string, qty: number, avgCost: number, price: number | null, secType = "OPT"): Row {
  const contract = { secType, symbol: "SPX", lastTradeDateOrContractMonth: "20260910", strike, right, multiplier: "100" };
  const ident = tk.legOf(contract);
  return {
    key: tk.makeKey("模拟", "SPX", secType, ident), account: "模拟", symbol: "SPX", sec_type: secType, leg: ident,
    quantity: qty, avg_cost: avgCost, multiplier: 100, currency: "USD", market_price: price,
    market_value: null, unrealized_pnl: null, contract,
  };
}

const bagOf = (rows: Row[]): Row => {
  const bag = tk.withCombos(rows).find((r) => r["sec_type"] === "BAG");
  if (bag === undefined) throw new Error("没有组合行");
  return bag as Row;
};

const positionOf = (row: Row): tk.Position => tk.makePosition({
  account: String(row["account"]), symbol: String(row["symbol"]), sec_type: String(row["sec_type"]),
  quantity: Number(row["quantity"]), avg_cost: Number(row["avg_cost"]), multiplier: Number(row["multiplier"]),
  market_price: (row["market_price"] ?? null) as number | null,
});

/** 卖出的铁蝶:+1 7550P / −1 7600P / −1 7600C / +1 7650C,收 30。行的顺序故意打乱(券商给的就是乱的) */
const ironFly = (): Row[] => [
  leg(7600, "C", -1, 2000, 18), leg(7550, "P", 1, 500, 3), leg(7650, "C", 1, 500, 3), leg(7600, "P", -1, 2000, 18),
];

describe("铁蝶:同一行权价看跌排在看涨前面,认得出来", () => {
  it("groupLegs:kind = iron_butterfly、标签「铁蝶」、数量 1 组", () => {
    const [combo] = tk.groupLegs(ironFly());
    expect(combo?.["kind"]).toBe("iron_butterfly");
    expect(String(combo?.["label"])).toMatch(/^铁蝶 /);
    expect(combo?.["quantity"]).toBe(1);
  });

  it("组合行的 key 不变(腿身份仍按行权价、再按 C/P 字母序拼):已有的追踪照样认得出这份持仓", () => {
    expect(bagOf(ironFly())["key"]).toBe("模拟|SPX|BAG|20260910|+1x7550P,-1x7600C,-1x7600P,+1x7650C");
  });

  it("组合行能拼出通过 schema 的平仓单:每条腿反转、BAG 买回(贷方)", () => {
    const bag = bagOf(ironFly());
    expect(bag["net_side"]).toBe("credit");
    expect(tk.closeContractIssue(bag)).toBeNull();
    const payload = tk.buildCloseOrder(
      positionOf(bag), tk.makeAutoClose({ enabled: true, order_type: "LMT" }), 30, tk.STATE_STOP_LOSS,
      bag["contract"] as Record<string, unknown>, "盘中",
    );
    const parsed = parseLlmPayload({ orders: [payload], rejections: [] });
    expect(parsed.orders).toHaveLength(1);
    const order = parsed.orders[0];
    expect(order?.order.action).toBe("BUY");
    expect(order?.contract.legs?.map((l) => `${l.action} ${l.strike}${l.right}`).sort()).toEqual(
      ["BUY 7600C", "BUY 7600P", "SELL 7550P", "SELL 7650C"],
    );
  });
});

describe("净值会穿过 0 的组合:现价带符号,盈亏与触发方向正确", () => {
  // 7700/7725/7775 看涨断翼蝶 +1/−2/+1,借方 1.50;标的冲到 7800 之后真值 = 100.2 − 2×75.3 + 25.4 = −25
  const debitBwb = (p: [number, number, number]): Row[] => [
    leg(7700, "C", 1, 500, p[0]), leg(7725, "C", -2, 200, p[1]), leg(7775, "C", 1, 50, p[2]),
  ];

  it("借方断翼蝶跌成负值:现价 −25(不是 +25),亏 2650,止损触发、止盈不触发", () => {
    const bag = bagOf(debitBwb([100.2, 75.3, 25.4]));
    expect(bag["kind"]).toBe("custom");
    expect(bag["quantity"]).toBe(1);
    expect(bag["market_price"]).toBe(-25);
    const r = tk.evaluate(positionOf(bag), tk.makeTargets({ stop_loss: 0.75, take_profit: 3 }), Number(bag["market_price"]));
    expect(r.state).toBe(tk.STATE_STOP_LOSS);
    expect(r.unrealized_pnl).toBe(-2650);
  });

  it("值为正的时候与以前一样", () => {
    const bag = bagOf(debitBwb([6, 2.5, 0.4]));
    expect(bag["market_price"]).toBe(1.4);
  });

  // 同一只断翼蝶以贷方开:收 1.50;标的到 7725(最赚钱的地方),真值 26 − 12 + 0.5 = +14.5,平掉是**收** 14.5
  const creditBwb = (): Row[] => [leg(7700, "C", 1, 300, 26), leg(7725, "C", -2, 250, 6), leg(7775, "C", 1, 50, 0.5)];

  it("贷方断翼蝶赚钱时:平仓成本记 −14.5,盈 1600,止损不触发", () => {
    const bag = bagOf(creditBwb());
    expect(bag["net_side"]).toBe("credit");
    expect(bag["quantity"]).toBe(-1);
    expect(bag["market_price"]).toBe(-14.5);
    const r = tk.evaluate(positionOf(bag), tk.makeTargets({ stop_loss: 3 }), Number(bag["market_price"]));
    expect(r.state).toBe(tk.STATE_HOLDING);
    expect(r.unrealized_pnl).toBe(1600);
  });

  it("跟踪止损的峰值落到 0 以下:百分比回撤说不清,不给停损价、不触发", () => {
    const bag = bagOf(creditBwb());
    const pos = positionOf(bag);
    expect(tk.trailStopPrice(pos, -14.5, 20)).toBeNull();
    const r = tk.evaluate(pos, tk.makeTargets({ trail_pct: 20 }), -14.5, -14.5);
    expect(r.state).toBe(tk.STATE_HOLDING);
  });
});

describe("closeContractIssue:这份持仓拼不拼得出一张能过 schema 的平仓单", () => {
  it("标准结构、单腿期权、正股:null", () => {
    const fly = [leg(7600, "P", 1, 300, 3), leg(7615, "P", -2, 200, 2), leg(7630, "P", 1, 325, 3.3)];
    expect(tk.closeContractIssue(bagOf(fly))).toBeNull();
    expect(tk.closeContractIssue(leg(7600, "P", 1, 300, 3))).toBeNull();
    expect(tk.closeContractIssue({ contract: { secType: "STK", symbol: "BE", exchange: "NYSE", currency: "USD" } })).toBeNull();
  });

  it("认不出结构的组合(断翼蝶):给一句人话", () => {
    const bwb = [leg(7700, "C", 1, 500, 6), leg(7725, "C", -2, 200, 2.5), leg(7775, "C", 1, 50, 0.4)];
    expect(tk.closeContractIssue(bagOf(bwb))).toMatch(/认不出/);
  });

  it("腿比例不是 1 / 2 的组合:closeBagContract 的原话", () => {
    const odd = [leg(7500, "P", 1, 100, 1), leg(7550, "P", 3, 100, 1)];
    expect(tk.closeContractIssue(bagOf(odd))).toMatch(/不是 1 或 2/);
  });

  it("期货期权(FOP):下单 schema 不认这个类型", () => {
    expect(tk.closeContractIssue(leg(5000, "C", 1, 300, 3, "FOP"))).not.toBeNull();
  });

  it("没有合约:说清楚", () => {
    expect(tk.closeContractIssue({})).not.toBeNull();
    expect(tk.closeContractIssue(null)).not.toBeNull();
  });
});
