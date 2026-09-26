/** IB 会话层的通断口径与日志小工具(从 broker.ts 分出来;broker.ts 原样转出,老的 import 路径不变)。
 *
 * 盯盘最怕的不是"读不到",是把"读不到"当成"没有":空持仓会让追踪判「持仓已不存在」自动停掉、
 * 让托管对账把券商侧的止损单撤掉。所以这里的两条口径都朝"宁可这一轮不判断"那一侧偏。
 */
import type { AccountConfig } from "./config.js";
import type { IbSession } from "./ibTypes.js";

/** 日志里的账号一律掩码(§9.3)。 */
export function redactForLog(accountId: string): string {
  return accountId.length > 5 ? `${accountId.slice(0, 2)}***${accountId.slice(-3)}` : "***";
}

export function logStderr(message: string): void {
  try {
    process.stderr.write(message + "\n");
  } catch {
    /* 日志失败绝不影响交易路径 */
  }
}

/**
 * 读持仓要用的会话:连着的那些。**一个都没连着就报错,不回空。**
 *
 * 以前 `sessions()` 只挑连着的,全断了就是空数组,读持仓照样"成功"地回一个空列表。
 * 之所以一直没出事,是因为会话从不说自己断了(见 ibSession 的 IB_RECONNECT_MS)——让它说真话之后,
 * 这里不拦,TWS 一重启所有追踪就会被停掉。
 */
export function liveSessions(
  sessions: Map<string, IbSession>, makeError: (message: string) => Error,
): IbSession[] {
  const all = [...sessions.entries()];
  const live = all.filter(([, s]) => s.isConnected()).map(([, s]) => s);
  if (live.length) return live;
  const names = all.map(([name]) => name).join("、");
  throw makeError(
    names ? `与 TWS 的连接(${names})已断开,正在自动重连;这一轮读不到持仓` : "还没有连上任何 TWS 会话,读不到持仓",
  );
}

/**
 * 此刻读得到持仓的账户(别名)。一个账户的会话断着、或者压根没连(比如模拟盘的 TWS 没开),
 * 它的持仓就**不会**出现在持仓列表里——这不等于它没仓,盯盘不能因此停掉它的追踪。
 *
 * 会话没报账户列表(极少见)时按配置写的连接认,与 BrokerRouter.sessionFor 的放行口径一致。
 */
export function coveredAccounts(
  accounts: AccountConfig[], sessions: Map<string, IbSession>,
): Set<string> {
  const out = new Set<string>();
  for (const [name, session] of sessions) {
    if (!session.isConnected()) continue;
    const managed = new Set(session.managedAccounts());
    for (const acct of accounts) {
      if (managed.has(acct.account_id) || (!managed.size && acct.connection === name)) out.add(acct.alias);
    }
  }
  return out;
}
