/** AUTO_MID 的另一种让价:按盘口价差的一份(limits.auto_mid_spread_share),不按固定金额(纯函数)。
 *
 * 固定让 0.10 美元对 0.30 的蝶是三分之一、对 12 块的价差不到百分之一,同一个数两头都不合适。这里让的是
 * 「中间价到立刻成交的价」那一段的一份:份额是用户填的(0–1),盘口宽就多让、盘口窄就少让。
 * 符号约定与 broker.autoMidLimit 相同:正数 = 借方(付权利金),负数 = 贷方(收权利金)。
 */
import { BrokerError, DEFAULT_COMBO_TICK, alignTickDown, alignTickUp, comboMidPrice, legMid } from "./broker.js";
import type { LegQuote } from "./broker.js";
import { fmtF, pyRound } from "./py.js";

/** 立刻成交的净价:要买的腿按卖价、要卖的腿按买价。带符号,和 comboMidPrice 同一个约定;它不会比中间价更有利。 */
export function comboNaturalPrice(legs: LegQuote[]): number {
  if (!legs.length) throw new BrokerError("没有腿报价,无法计算立刻成交的价");
  let net = 0.0;
  for (const leg of legs) {
    legMid(leg); // 坏盘口(缺一边、倒挂)在这里抛,和中间价同一道守卫
    net += leg.action === "BUY" ? leg.ask * leg.ratio : -leg.bid * leg.ratio;
  }
  return pyRound(net, 4);
}

/**
 * 限价 = 中间价 + share ×(立刻成交的价 − 中间价),按跳动朝成交方向取整。
 * share = 0 就是挂在中间价上,1 就是直接挂到立刻成交的价。借方不超过结构宽度,贷方必须仍为负数,
 * 腿方向与订单方向对不上时拒绝——和 autoMidLimit 同样的三道检查。
 */
export function autoMidShareLimit(
  legs: LegQuote[], action: string, share: number, strikeWidthValue: number | null = null, tick = DEFAULT_COMBO_TICK,
): number {
  if (!(share >= 0 && share <= 1)) throw new BrokerError(`让价的份额要在 0 到 1 之间(收到 ${share})`);
  const mid = comboMidPrice(legs);
  if (action === "SELL" && mid >= 0) {
    throw new BrokerError(
      `贷方组合的净中间价应为负(收权利金),实际为 ${fmtF(mid, 4)}——腿方向与订单方向不一致,拒绝定价以免反向建仓。`,
    );
  }
  if (action === "BUY" && mid <= 0) {
    throw new BrokerError(
      `借方组合的净中间价应为正(付权利金),实际为 ${fmtF(mid, 4)}——腿方向与订单方向不一致,拒绝定价以免反向建仓。`,
    );
  }
  const natural = comboNaturalPrice(legs);
  let limit = alignTickUp(mid + share * (natural - mid), tick);
  if (action === "BUY") {
    if (strikeWidthValue !== null) limit = Math.min(limit, alignTickDown(strikeWidthValue, tick));
    if (limit <= 0) throw new BrokerError(`计算出的买入限价 ${fmtF(limit, 4)} 非正,拒绝下单`);
  } else if (limit >= 0) {
    throw new BrokerError(`贷方限价 ${fmtF(limit, 4)} 已不再为负(让价吃光了权利金),拒绝下单`);
  }
  return pyRound(limit, 4);
}
