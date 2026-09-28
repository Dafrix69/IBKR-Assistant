/** 持仓的常驻行情订阅的账:每条持仓期权腿、每只持仓正股各一条,订一次留着读(2026-09-28 从 broker.ts 分出来)。
 *
 * 这里只管三件事:这条还能不能用、订上并记下来、**平掉的撤掉**。合约确认、行情类型、等首笔 tick 还在
 * BrokerRouter 的 ensureOptionStreams / fillPositionPrices 里。
 *
 * 为什么要撤:IBKR 的行情线路大约 100 条,漏光之后 TWS 对新请求回 101,所有报价都是 NaN(2026-09-04 纸面账户
 * 见过)。以前这本账只在句柄读到 error、或者断开连接时才清,腿平掉了订阅还在——做 0DTE 蝶的一天开平几十只、
 * 一只三条腿,占到重连为止。
 *
 * 撤的时候朝"宁可多占一条"那一侧偏,因为会话层的流按合约缓存、不记谁在用(ibSession.tickerKey):
 *
 * * **只撤不带 generic 的那一条。** 异动监控的量能流、期权链、蝴蝶测算订的是同一张合约的别的变体,不碰。
 * * **别人还在用就只销账、不撤流。** 另一个账户也持有这张合约;顶栏行情带 / 标的现价也订着这只股
 *   (行情带被撤了不会自己重订,见 docs/journal/shared-ticker-stream.md)。
 * * **自己那条已经不在了就不撤。** 句柄读到 error = 被 TWS 拒了或者被别处撤了;这时候同一个键上如果有流,
 *   是别人后来订的。
 *
 * 读不到持仓 ≠ 平仓了:哪一轮能撤由调用方把关(BrokerRouter.releaseClosed),这里不判断。
 */
import { tickerKey } from "./ibSession.js";
import type { IbContract, IbSession, TickerHandle } from "./ibTypes.js";

/** handle 为 null = 合约确认不了,记下来不反复重试。session 是订它的那个会话:撤要撤在同一个会话上 */
export interface HeldStream { handle: TickerHandle | null; contract: IbContract | null; session?: IbSession }

export class HeldStreams extends Map<string, HeldStream> {
  /** @param variant 出错重订之前撤哪一条:`""` 只撤不带 generic 的(正股),不给就撤这张合约的所有变体(期权腿) */
  constructor(private readonly variant?: string) {
    super();
  }

  /** 这个键上有没有一条还能用的。读到 error 的流不会自己活过来:摘掉,回 false 让调用方重订。
   * 确认不了的合约(handle 为 null)算有,不重试。 */
  usable(session: IbSession, key: string): boolean {
    const existing = this.get(key);
    if (existing === undefined) return false;
    if (!existing.handle || !existing.handle.read().error) return true;
    if (existing.contract) {
      try {
        if (this.variant === undefined) session.cancelTicker(existing.contract);
        else session.cancelTicker(existing.contract, this.variant);
      } catch {
        /* 撤不掉也要重订 */
      }
    }
    this.delete(key);
    return false;
  }

  subscribe(session: IbSession, key: string, contract: IbContract): void {
    this.set(key, { handle: session.subscribeTicker(contract), contract, session });
  }

  /**
   * 撤掉不在 keep 里的(持仓里已经没有的),返回真的撤了几条线路。
   * @param sharedWith 这个键对应的合约,别处的常驻订阅手里的句柄(没有就不给);有一个还活着就不撤流
   */
  release(keep: Iterable<string>, sharedWith: (key: string) => Array<TickerHandle | null | undefined> = () => []): number {
    const keepSet = new Set(keep);
    let released = 0;
    for (const [key, gone] of [...this]) {
      if (keepSet.has(key)) continue;
      this.delete(key);
      const { handle, contract, session } = gone;
      if (!handle || !contract || !session || handle.read().error) continue;
      const stream = tickerKey(contract);
      const held = [...this.values()].some((s) => s.session === session && s.contract !== null && tickerKey(s.contract) === stream);
      if (held || sharedWith(key).some((h) => h && !h.read().error)) continue;
      try {
        session.cancelTicker(contract, "");
        released += 1;
      } catch {
        /* 会话已经断了:流跟着连接一起没了,没什么可撤的 */
      }
    }
    return released;
  }
}
