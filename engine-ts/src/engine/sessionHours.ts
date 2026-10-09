/** 一张单 / 一份持仓此刻面对的交易时段:合约自己的时段、盘外标志、时段预热。
 *
 * 从 engine.ts 搬出来(函数体未改,`this.` 换成宿主)。正股日历(settings.marketStatus)是照美股正股写的,
 * SPX 期权还有 20:15–次日 09:25 那一整段隔夜可交易时间;下单与平仓必须用同一张时段表,
 * 否则会出现"能平不能开"或反过来的结果。
 */
import type { AccountConfig, EtNow, Settings } from "../config.js";
import { hoursStatus } from "../config.js";
import type { ParsedOrder } from "../models.js";
import type { Rec } from "../store.js";
import { EXTENDED_STATUSES } from "../validator.js";

/** [交易时段, 流动时段, 时区]:reqContractDetails 回来的那三样 */
export type ContractHours = [string, string, string];

/** 时段这一块要用到的 router 那一面(只有 IBKR 的 router 有这两个方法)。 */
export interface HoursRouter {
  contractHours?(row: Rec, account: AccountConfig): Promise<ContractHours | null>;
  cachedContractHours?(symbol: string, expiry: string): ContractHours | null;
}

/** 每次用到都现取:配置会重载、券商会重连。 */
export interface HoursHost {
  readonly settings: Settings;
  readonly router: HoursRouter | null;
}

/** 合约此刻在盘外时段能交易时,自动给订单打上 outsideRth。
 *
 * 不打这个标志,IBKR 只会把单子挂着、等常规时段才送交易所(TWS 原话:"您的委托单在
 * 08:30:00 美国/中部前不会被下达交易所")。而 SPX 期权 20:15–次日 09:25 本来就能成交——
 * 在那个时段按下发送的人要的是现在就成交,不是等明早开盘。
 *
 * 两条不碰:市价单不自动打(盘外只收限价单,打上反而从"挂到开盘"变成"当场被拒");
 * 用户已经显式写了 outsideRth 的不动——显式永远压过自动。 */
export function autoOutsideRth(host: HoursHost, orders: ParsedOrder[], at: EtNow): ParsedOrder[] {
  if (!host.settings.policies.auto_outside_rth) return [...orders];
  return orders.map((order) => {
    const spec = order.order;
    const status = orderMarketStatus(host, order, at) ?? host.settings.marketStatus(at);
    if (!EXTENDED_STATUSES.includes(status) || spec.outsideRth || spec.orderType === "MKT") {
      return order;
    }
    return {
      ...order,
      order: { ...spec, outsideRth: true },
      warnings: [
        ...(order.warnings ?? []),
        `当前为${status},已自动打上盘外标志(outsideRth=true):不打的话这张单会挂着,` +
        "等常规时段才送交易所。不想在盘外成交就把 policies.auto_outside_rth 关掉。",
      ],
    };
  });
}

/** 把这批订单里期权/组合的合约时段问一遍,填进 router 的按日缓存。
 * 失败一律忽略:查不到时段只是退回正股日历,不该让整条下单链路失败。 */
export async function prewarmContractHours(host: HoursHost, orders: ParsedOrder[]): Promise<void> {
  const router = host.router;
  if (router === null || typeof router.contractHours !== "function") return;
  const seen = new Set<string>();
  for (const order of orders) {
    const contract = order.contract;
    const secType = String(contract?.secType ?? "");
    if (secType !== "OPT" && secType !== "FOP" && secType !== "BAG") continue;
    const legs = contract?.legs ?? [];
    const leg = secType === "BAG" ? legs[0] : contract;
    if (!leg?.lastTradeDateOrContractMonth) continue;
    const key = `${contract.symbol}|${leg.lastTradeDateOrContractMonth}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const account = host.settings.accountByAlias(String(order.account ?? "")) ??
      host.settings.defaultAccount();
    if (account === null) continue;
    const row = {
      account: account.alias, symbol: contract.symbol, sec_type: secType,
      contract: secType === "BAG"
        ? { secType: "BAG", symbol: contract.symbol, legs: [{
            lastTradeDateOrContractMonth: leg.lastTradeDateOrContractMonth,
            strike: leg.strike, right: leg.right, ratio: 1.0 }] }
        : { secType, symbol: contract.symbol,
            lastTradeDateOrContractMonth: contract.lastTradeDateOrContractMonth,
            strike: contract.strike, right: contract.right },
    };
    try {
      await router.contractHours(row, account);
    } catch {
      /* 查不到就退回正股表 */
    }
  }
}

/** 一张**待下单**的期权/组合此刻面对的时段(拿不到回 null,让校验退回正股表)。
 *
 * 和持仓那条路(marketStatusFor)同一个来源:合约自己的 tradingHours。下单与平仓
 * 用同一张时段表,否则会出现"能平不能开"或反过来的荒唐结果。
 *
 * 注意这是**同步**的:校验链路不是 async,所以只读已缓存的时段(轮询那条路每天
 * 会填上),没缓存就回 null 退回正股表——宁可保守,不为了一张单去阻塞校验。 */
export function orderMarketStatus(host: HoursHost, order: ParsedOrder, at: EtNow): string | null {
  const contract = order.contract;
  const secType = String(contract?.secType ?? "");
  if (secType !== "OPT" && secType !== "FOP" && secType !== "BAG") return null;
  const router = host.router;
  if (router === null || typeof router.cachedContractHours !== "function") return null;
  let expiry: string | null | undefined;
  let hours: ContractHours | null = null;
  if (secType === "BAG") {
    const legs = contract?.legs ?? [];
    if (!legs.length) return null;
    expiry = legs[0]?.lastTradeDateOrContractMonth;
  } else {
    expiry = contract?.lastTradeDateOrContractMonth;
  }
  try {
    hours = router.cachedContractHours(String(contract.symbol), String(expiry));
  } catch {
    return null;
  }
  if (!hours) return null;
  const status = hoursStatus(hours[0], hours[2], at.epochMs, hours[1]);
  // 与正股表一致时回 null:让 validator 用它自己那个,少一次无谓的分歧
  return !status || status === host.settings.marketStatus(at) ? null : status;
}

/** 这条持仓此刻能不能交易。期权/组合优先用合约的真实时段,拿不到就退回正股表。 */
export async function marketStatusFor(host: HoursHost, raw: Rec, at: EtNow): Promise<string> {
  const secType = String(raw["sec_type"] ?? "");
  if (secType !== "OPT" && secType !== "FOP" && secType !== "BAG") {
    return host.settings.marketStatus(at);
  }
  const router = host.router;
  if (router === null || typeof router.contractHours !== "function") return host.settings.marketStatus(at);
  const account = host.settings.accountByAlias(String(raw["account"] ?? ""));
  if (account === null) return host.settings.marketStatus(at);
  let hours: ContractHours | null = null;
  try {
    hours = await router.contractHours(raw, account);
  } catch {
    hours = null;                      // 查时段失败不该炸掉轮询
  }
  if (!hours) return host.settings.marketStatus(at);
  const [trading, liquid, tzId] = hours;
  return hoursStatus(trading, tzId, at.epochMs, liquid) || host.settings.marketStatus(at);
}
