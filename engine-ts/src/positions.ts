/** 持仓的身份与名字(领域概念,不属于追踪器):
 *
 * 追踪器、券商适配层、交易记录都要用同一套 key 认同一条持仓,所以它们不能各自定义;
 * 也不能放在 tracker.ts 里——那样下单层就得 import 追踪器。这里只有纯函数与类型。
 */
import { fmtF } from "./py.js";

/** 持仓/追踪的身份(对应 Python position_key)。
 * 正股:账户|代码|类型;期权再带腿身份——一只蝴蝶三条腿都是 SPX 的 OPT,
 * 不带腿身份会在聚合时互相覆盖,追踪与自动平仓也会认错腿。 */
export function makeKey(account: string, symbol: string, secType: string, leg = ""): string {
  const base = `${account}|${symbol}|${secType}`;
  return leg ? `${base}|${leg}` : base;
}

export function fmtStrike(strike: unknown): string {
  const value = Number(strike);
  if (strike === null || strike === undefined || strike === "" || Number.isNaN(value)) return "";
  return fmtF(value, 4).replace(/0+$/, "").replace(/\.$/, "");
}

/** 从合约里抽出腿身份:期权为 '到期|行权价|C/P',其余为空串。 */
export function legOf(contract: Record<string, any> | null | undefined): string {
  const c = contract ?? {};
  const secType = String(c["secType"] ?? "STK") || "STK";
  if (secType !== "OPT" && secType !== "FOP") return "";
  const expiry = String(c["lastTradeDateOrContractMonth"] ?? "").slice(0, 8);
  const right = String(c["right"] ?? "").slice(0, 1).toUpperCase();
  return `${expiry}|${fmtStrike(c["strike"])}|${right}`;
}

/** 给人看的一行名字:正股就是代码;期权 'SPX 7615P 2026-09-01'。 */
export function positionLabel(
  symbol: string, secType: string, contract: Record<string, any> | null | undefined,
): string {
  const c = contract ?? {};
  if (secType !== "OPT" && secType !== "FOP") return symbol;
  let expiry = String(c["lastTradeDateOrContractMonth"] ?? "").slice(0, 8);
  if (expiry.length === 8) expiry = `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6)}`;
  const right = String(c["right"] ?? "").slice(0, 1).toUpperCase();
  return [symbol, fmtStrike(c["strike"]) + right, expiry].filter((p) => p.trim()).join(" ");
}

/** 托管到券商侧的一张单的计划(引擎算好,BrokerRouter 照着挂)。 */
export interface HostedOrderPlan {
  kind: string;
  action: string;
  order_type: string;
  quantity: number;
  lmt_price: number | null;
  aux_price: number | null;
  trailing_percent: number | null;
  trail_stop_seed: number | null;
  label: string;
  [key: string]: unknown;
}
