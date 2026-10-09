/** 账户级的两样券商数据:当日盈亏(reqPnL)与净值(账户摘要)。只读,都是会话上的常驻订阅(ibSession.ts)。
 *
 * 单独一个文件而不是 BrokerRouter 的方法:它只要"哪条会话管着这个账号",用不到 router 的任何状态。
 * 两样都以美元计才给:账户的基础货币不是 USD 时,券商报的是基础货币的数,拿它去比美元的上限是错的——宁可不给,
 * 由调用方退回原来的口径(已实现盈亏 / 人填的权益)。
 */
import type { AccountPnl, IbSession } from "./ibTypes.js";

/** 盈亏多久没更新就不再当现在的数用。TWS 大约每秒推一次;一分钟没动静多半是订阅断了或 TWS 与服务器断开。 */
export const PNL_STALE_MS = 60_000;

function sessionOf(sessions: readonly IbSession[], accountId: string): IbSession | null {
  return sessions.find((s) => s.isConnected() && s.managedAccounts().includes(accountId)) ?? null;
}

/** 账户当日盈亏(美元,含已实现 + 未实现,含在 TWS 里手动做的单)。拿不到、太旧、不是美元:null。 */
export function accountDailyPnl(sessions: readonly IbSession[], accountId: string, nowMs: number): number | null {
  const pnl: AccountPnl | null = sessionOf(sessions, accountId)?.accountPnl?.(accountId) ?? null;
  if (pnl === null || pnl.daily === null || pnl.currency !== "USD") return null;
  return nowMs - pnl.atMs > PNL_STALE_MS ? null : pnl.daily;
}

/** 账户净值(美元)。拿不到、不是美元:null。 */
export function accountNetLiquidation(sessions: readonly IbSession[], accountId: string): number | null {
  const value = sessionOf(sessions, accountId)?.netLiquidation?.(accountId) ?? null;
  return value !== null && value.currency === "USD" && value.amount > 0 ? value.amount : null;
}
