/** 一笔解析出来的订单是不是**只在减少**已有的持仓。
 *
 * 保护规则(接连止损、回撤、冷却、日内亏损上限)的承诺是"只挡新单、永不挡平仓"。持仓追踪发的平仓单
 * 本来就不过这道闸;可用户手敲的「卖出 AAPL 100 股 平仓」、买回空头、卖出持有的期权,引擎以前分不清
 * 是平仓还是开新仓,一律挡在保护期里——越是亏得多、保护规则越该生效的时候,人越平不掉仓(2026-09-27 审计)。
 *
 * 认准才放:每条腿都朝减仓的方向、数量不超过这个账户在这条腿上的持仓,才算平仓。任何一条腿对不上
 * (没有这条持仓、方向是加仓、数量超过持仓、合约认不出)一律回 false,照旧当新单——宁可多挡一笔,
 * 不能把开仓当平仓放过去。
 */
import type { ParsedOrder } from "../models.js";
import { legOf, makeKey } from "../positions.js";
import type { Rec } from "../store.js";

interface LegIntent {
  key: string;
  action: string;
  quantity: number;
}

/** 订单拆成"对哪条持仓做什么、做多少"。组合按 IBKR 的约定:整单 SELL 等于每条腿反过来做。 */
function legIntents(order: ParsedOrder, alias: string): LegIntent[] {
  const c = order.contract;
  const qty = order.order.totalQuantity;
  if (c.secType !== "BAG") {
    return [{ key: makeKey(alias, c.symbol, c.secType, legOf(c)), action: order.order.action, quantity: qty }];
  }
  const flip = order.order.action === "SELL";
  return (c.legs ?? []).map((leg) => ({
    key: makeKey(alias, c.symbol, "OPT", legOf({
      secType: "OPT", lastTradeDateOrContractMonth: leg.lastTradeDateOrContractMonth, strike: leg.strike, right: leg.right,
    })),
    action: flip ? (leg.action === "BUY" ? "SELL" : "BUY") : leg.action,
    quantity: qty * leg.ratio,
  }));
}

/** rows 是券商持仓行(每行带 key 与带符号的 quantity);alias 是订单要发往的账户别名。 */
export function reducesPositions(order: ParsedOrder, alias: string, rows: Rec[]): boolean {
  const held = new Map<string, number>();
  for (const row of rows) {
    const q = Number(row["quantity"] ?? 0);
    if (Number.isFinite(q)) held.set(String(row["key"] ?? ""), q);
  }
  const legs = legIntents(order, alias);
  if (!legs.length) return false;
  return legs.every(({ key, action, quantity }) => {
    const pos = held.get(key) ?? 0;
    if (action === "SELL") return pos > 0 && quantity <= pos;
    if (action === "BUY") return pos < 0 && quantity <= -pos;
    return false;
  });
}
