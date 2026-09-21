/** 怎么拼一张 IB 合约:正股 / 指数 / 加密 / 期权,以及跟它们绑在一起的到期日与交易类选择。
 *
 * 2026-09-21 从 broker.ts 搬出来(函数体逐字未改)——CLAUDE.md 的体积预算里点名的那一件。
 * 这一层只认「合约长什么样」:不连券商、不读行情、不碰订单。
 * **刻意留在 broker.ts 的**:lastRthSession / contemporaneousBasis(时段与基差,是行情逻辑)、
 * parseIbTime / fillRow(回报解析,而且 fillRow 要用 broker.ts 的 finiteQuote)、readPriceFrom、isTimeout。
 */
import { pad2, weekdayOfDate } from "./tz.js";
import type { IbContract } from "./ibTypes.js";
// ---------------------------------------------------------------- 合约构造
export function stockContract(symbol: string, exchange = "SMART", currency = "USD"): IbContract {
  return { secType: "STK", symbol, exchange, currency, conId: 0 };
}

/** 某年某月的第三个星期五('YYYY-MM-DD')。股指期货与月度期权都在这天到期。 */
export function thirdFriday(year: number, month: number): string {
  const first = `${year}-${pad2(month)}-01`;
  const wd = weekdayOfDate(first); // 0 = 周一 … 4 = 周五
  const firstFriday = 1 + ((4 - wd + 7) % 7);
  return `${year}-${pad2(month)}-${pad2(firstFriday + 14)}`;
}

/**
 * 夜盘推算用哪一张季月期货('YYYYMM'):到期日(第三个星期五)**严格晚于**今天的最近季月。
 * 到期日当天就换下一张——那张 09:30 按开盘价结算,之后就不再跳了。
 */
export function frontQuarterly(dateStr: string): string {
  let year = Number(dateStr.slice(0, 4));
  let month = Number(dateStr.slice(5, 7));
  for (let i = 0; i < 8; i += 1) {
    if (month % 3 === 0 && thirdFriday(year, month) > dateStr) return `${year}${pad2(month)}`;
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  throw new Error(`算不出 ${dateStr} 之后的季月合约`);
}

export function indexContract(symbol: string, exchange: string): IbContract {
  return { secType: "IND", symbol, exchange, currency: "USD", conId: 0 };
}

/** 加密货币现货(IBKR 走 PAXOS,行情免订阅;2026-09-08 真机实测 BTC 两秒内到价)。 */
export function cryptoContract(symbol: string): IbContract {
  return { secType: "CRYPTO", symbol, exchange: "PAXOS", currency: "USD", conId: 0 };
}

/** 流式报价里的加密标记:`CRYPTO:BTC` → `BTC`;不是这个形状回 null。
 * 宏观带用它把比特币这一格接到 PAXOS 现货上;富途通道见到它直接跳过。 */
export function cryptoSymbol(symbol: string): string | null {
  const m = /^CRYPTO:([A-Z]{2,10})$/.exec((symbol ?? "").trim().toUpperCase());
  return m ? m[1]! : null;
}

/**
 * 流式报价的标的记号 → 合约。除了裸代码(正股/ETF)之外还认三种前缀:
 *
 *   `CRYPTO:BTC`         PAXOS 现货
 *   `CONTFUT:GC@COMEX`   连续期货(不用管换月;宏观带只是看个价)
 *   `IND:TNX@CBOE`       指数
 *
 * 商品这几格必须能写期货:拿 ETF 当替身会差一个量级——GLD 403 对黄金 4412、
 * BNO 58 对布伦特 99.9,用户看到的是个和标的毫无关系的数。
 */
export function streamContract(symbol: string): IbContract {
  const raw = (symbol ?? "").trim().toUpperCase();
  const crypto = cryptoSymbol(raw);
  if (crypto) return cryptoContract(crypto);
  const m = /^(CONTFUT|FUT|IND):([A-Z0-9]{1,12})@([A-Z]{2,12})$/.exec(raw);
  if (m) {
    return { secType: m[1]!, symbol: m[2]!, exchange: m[3]!, currency: "USD", conId: 0 };
  }
  return stockContract(raw);
}

/**
 * 从 secDefOptParams 返回的多条链里挑出该到期日真正所在的那条。
 *
 * 按字母序取第一个会两边都挑错,2026-09-09 对着真实 TWS 实测:
 *   · AAPL 的交易类是 ['2AAPL', 'AAPL'],'2AAPL' 是调整期权(只有一个到期日),
 *     用它建的合约整条链一个都确认不了;
 *   · SPX 的是 ['SPX', 'SPXW'],但 IBKR 把月度(AM 结算)记在第三个周五的**前一天**
 *     (20260917、20261015…),第三个周五当天只存在于 SPXW。
 *
 * 所以先按 "这个到期日在不在这条链上" 筛,再按 标的同名 → 配置里的月度/日到期类 →
 * 到期日最多的一条 排序。同名优先是关键:20260917 两条链都有,同名的 'SPX' 才是
 * 用户要的 AM 结算月度,挑 'SPXW' 会把结算方式悄悄换掉。
 */
export function pickTradingClass(
  symbol: string,
  cfg: { daily_trading_class: string; monthly_trading_class: string } | null,
  byClass: Record<string, { expiries?: string[]; strikes?: number[] }>,
  expiry: string,
): string {
  const names = Object.keys(byClass);
  if (!names.length) return "";
  const onExpiry = names.filter((n) => (byClass[n]!.expiries ?? []).includes(expiry));
  const pool = onExpiry.length ? onExpiry : names;
  const rank = (name: string): number => {
    if (name === symbol.toUpperCase()) return 0;
    if (cfg && name === cfg.monthly_trading_class) return 1;
    if (cfg && name === cfg.daily_trading_class) return 2;
    return 3;
  };
  return [...pool].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    // 同档看谁的到期日多:标准链总比调整期权那种只有一个到期日的长
    const n = (byClass[b]!.expiries ?? []).length - (byClass[a]!.expiries ?? []).length;
    return n !== 0 ? n : a.localeCompare(b);
  })[0]!;
}

export function optionContract(
  symbol: string, expiry: string, strike: number, right: string,
  exchange: string, currency = "USD", multiplier = "100", tradingClass = "",
): IbContract {
  return {
    secType: "OPT", symbol, exchange, currency,
    lastTradeDateOrContractMonth: expiry, strike, right, multiplier, tradingClass, conId: 0,
  };
}

export function describeContract(contract: IbContract): string {
  const parts = [contract.symbol || "?", contract.secType || "?"];
  for (const attr of ["lastTradeDateOrContractMonth", "strike", "right", "tradingClass"] as const) {
    const value = contract[attr];
    if (value) parts.push(String(value));
  }
  return parts.join(" ");
}
