/**
 * 单笔风险预算(docs/features/risk-budget.md):一单占账户权益太多时给一句告警,**不拦单**。
 *
 * 限额(limits.max_order_notional)是一个固定金额,账户大了小了它都不变;冠军交易员说的是比例——单笔风险 0.5%–2%。
 * 这里把校验层已经算好的敞口(期权 / 组合 = 最坏亏损,股票 = 名义金额,见 validator.checkLimits)对账户权益算个比例。
 * 权益是人填的(settings.risk_budget.equity_usd),引擎不向券商要。平仓单不走校验层,也就不会被这里提醒。
 *
 * 纯函数,只认配置的形状(contract/settings.ts),和 protections.ts 一样放在 util。
 */
import type { RiskBudgetConfig } from "./contract/settings.js";

function money(v: number): string {
  return `$${v.toFixed(2)}`;
}

function pct(v: number): string {
  return `${Number((Math.round(v * 10 + 1e-9) / 10).toFixed(1))}%`;
}

/**
 * 超了回一句中文告警,没超 / 没开 / 没填这个账户的权益 / 敞口算不出来(0)回 null。
 * `exposure` 就是校验层的 notional:期权与组合是最坏亏损,股票是名义金额。
 */
export function riskBudgetWarning(
  cfg: RiskBudgetConfig, accountAlias: string, secType: string, exposure: number,
): string | null {
  if (!cfg.enabled || !(exposure > 0)) return null;
  const equity = cfg.equity_usd[accountAlias] ?? 0;
  if (!(equity > 0)) return null;
  const share = (exposure / equity) * 100;
  if (secType === "STK") {
    if (share <= cfg.max_position_pct) return null;
    return `单笔仓位:名义金额约 ${money(exposure)},占 ${accountAlias} 权益 ${money(equity)} 的 ${pct(share)},`
      + `超过你定的 ${pct(cfg.max_position_pct)}。最坏亏多少取决于止损——下单后记得在持仓追踪里设上(只提醒,不拦单)`;
  }
  if (share <= cfg.max_risk_pct) return null;
  return `单笔风险:最坏亏损约 ${money(exposure)},占 ${accountAlias} 权益 ${money(equity)} 的 ${pct(share)},`
    + `超过你定的 ${pct(cfg.max_risk_pct)}(只提醒,不拦单)`;
}
