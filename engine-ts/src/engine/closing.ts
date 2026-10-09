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
import { fmtStrike, legOf, makeKey } from "../positions.js";
import { pyG } from "../py.js";
import type { Rec } from "../store.js";

interface LegIntent {
  key: string;
  action: string;
  quantity: number;
}

/** 订单拆成"对哪条持仓做什么、做多少"。组合各腿写的就是**真实方向**:整单的 SELL 只表示贷方(收权利金)、
 * 管净价的符号,发给券商时一律以 BUY 提交、腿照原样(broker.place)。以前这里见 SELL 就把每条腿反过来,
 * 手敲的「卖出 7500/7520 call spread」平掉持有的借方价差时,两条腿都被读成加仓,保护期内照样被挡。 */
function legIntents(order: ParsedOrder, alias: string): LegIntent[] {
  const c = order.contract;
  const qty = order.order.totalQuantity;
  if (c.secType !== "BAG") {
    return [{ key: makeKey(alias, c.symbol, c.secType, legOf(c)), action: order.order.action, quantity: qty }];
  }
  return (c.legs ?? []).map((leg) => ({
    key: makeKey(alias, c.symbol, "OPT", legOf({
      secType: "OPT", lastTradeDateOrContractMonth: leg.lastTradeDateOrContractMonth, strike: leg.strike, right: leg.right,
    })),
    action: leg.action,
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

/**
 * 把一张已经认成减仓的单从持仓行里扣掉(就地改 rows 的 quantity)。同一批里的下一张单要对着扣过的持仓判:
 * 持有 2 组,一句话里「卖 2 组」「再卖 1 组」,第二张不是减仓,是反向开仓。
 */
export function applyReduction(order: ParsedOrder, alias: string, rows: Rec[]): void {
  const byKey = new Map(rows.map((row) => [String(row["key"] ?? ""), row]));
  for (const { key, action, quantity } of legIntents(order, alias)) {
    const row = byKey.get(key);
    if (row === undefined) continue;
    row["quantity"] = Number(row["quantity"] ?? 0) + (action === "SELL" ? -quantity : quantity);
  }
}

/**
 * 一张单开出来的那份持仓的腿身份,和持仓行 / 追踪行的 `leg` 同一种写法:正股空串、单腿「到期|行权价|C/P」、
 * 组合「到期|+1x7725C,-2x7750C,+1x7775C」(combos.comboRow 的拼法:腿按行权价、再按看涨看跌排)。
 * 保护规则的「同一个结构冷却」拿它和刚平掉的那份持仓比。
 */
export function orderLegId(order: Pick<ParsedOrder, "contract">): string {
  const c = order.contract;
  if (c.secType !== "BAG") return legOf(c);
  const legs = (c.legs ?? []).map((leg) => ({
    strike: Number(leg.strike), right: String(leg.right ?? "").slice(0, 1).toUpperCase(),
    ratio: (leg.action === "BUY" ? 1 : -1) * leg.ratio,
  }));
  legs.sort((a, b) => a.strike - b.strike || (a.right < b.right ? -1 : a.right > b.right ? 1 : 0));
  const expiry = String(c.legs?.[0]?.lastTradeDateOrContractMonth ?? "").slice(0, 8);
  return `${expiry}|${legs.map((l) => `${l.ratio >= 0 ? "+" : ""}${pyG(l.ratio)}x${fmtStrike(l.strike)}${l.right}`).join(",")}`;
}
