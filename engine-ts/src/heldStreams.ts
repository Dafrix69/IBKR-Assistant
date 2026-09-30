/** 持仓的常驻行情订阅的账:每条持仓期权腿、每只持仓正股各一条,订一次留着读(2026-09-28 从 broker.ts 分出来)。
 *
 * 这里管四件事:这条还能不能用(被拒、被撤、连着却太久没盘口)、订上并记下来、确认不了的合约不反复试、
 * **平掉的撤掉**。合约确认、行情类型、等首笔 tick、此刻算不算交易时段还在 BrokerRouter 的
 * ensureOptionStreams / fillPositionPrices 里。
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
import { logStderr } from "./ibLink.js";
import { tickerKey } from "./ibSession.js";
import type { IbContract, IbSession, TickerData, TickerHandle } from "./ibTypes.js";

/** handle 为 null = 合约确认不了,记下来不反复重试。session 是订它的那个会话:撤要撤在同一个会话上 */
export interface HeldStream { handle: TickerHandle | null; contract: IbContract | null; session?: IbSession }

/**
 * 连着却多久一笔盘口都没有,就当这条流死了(0 = 不判)。盘中半分钟:0DTE 的 SPX 期权、持仓正股盘中每秒都在跳,
 * 半分钟没动静不是清淡,是流断了(和期货常驻流同一条线,见 BrokerRouter.futStreams)。盘外 / 盘前 / 盘后成交稀,
 * 放宽到两分钟;休市不判,本来就不跳。判错的代价是一次撤订加重订,TWS 对新请求当场回一份现价。
 */
export function silenceLimitMs(status: string): number {
  if (status === "盘中") return 30_000;
  return status === "盘外" || status === "盘前" || status === "盘后" ? 120_000 : 0;
}

/** 这条流多久没来盘口(毫秒):从最近一笔盘口、或最近一次请求(订阅 / 重连后库重订)起算,取晚的那个。
 * 会话不报这两个时刻(测试替身)回 null:不知道就不判它死。 */
export function quoteSilenceMs(t: TickerData, now: number): number | null {
  const since = Math.max(t.quotedAt ?? 0, t.requestedAt ?? 0);
  return since > 0 ? now - since : null;
}

const alive = (t: TickerData, silentLimitMs: number, now: number): boolean =>
  !t.error && !(silentLimitMs > 0 && (quoteSilenceMs(t, now) ?? 0) >= silentLimitMs);

export class HeldStreams extends Map<string, HeldStream> {
  /** 正处在"太久没盘口 → 撤掉重订"里的键 → 这一段重订了几次。日志只在头一次和恢复时各写一行 */
  private readonly silent = new Map<string, number>();

  /** @param variant 出错重订之前撤哪一条:`""` 只撤不带 generic 的(正股),不给就撤这张合约的所有变体(期权腿) */
  constructor(private readonly variant?: string) {
    super();
  }

  /**
   * 这个键上有没有一条还能用的;回 false 就是要调用方重订。确认不了的合约(handle 为 null)算有,不重试。
   *
   * 两种流不会自己活过来,摘掉:
   * * 读到 error:被 TWS 拒了,或者被别处撤了;
   * * 连接还在、silentLimitMs 这么久一笔盘口都没有:断线重连之后库按原 reqId 重订了,TWS 却一直不给,
   *   句柄不报错、读到的永远是空盘口(2026-09-29 真机只来过一笔模型 IV)。这种只撤自己这一条。
   *
   * 同一条流还挂在别的键上、那边是好的(另一个账户持有同一条腿,那边这一轮刚重订过):不撤,让调用方
   * 重订时接到那一条上。撤了的话两个键每一轮互相撤掉对方刚订的,谁都读不到价。
   */
  usable(session: IbSession, key: string, silentLimitMs = 0, now = Date.now()): boolean {
    const existing = this.get(key);
    if (existing === undefined) return false;
    const { handle, contract } = existing;
    if (!handle) return true;
    const t = handle.read();
    const limit = session.isConnected() ? silentLimitMs : 0;
    if (alive(t, limit, now)) {
      this.recovered(key, t);
      return true;
    }
    this.delete(key);
    const stream = contract ? tickerKey(contract) : "";
    const shared = [...this.values()].some((s) =>
      s.session === session && s.handle && s.contract && tickerKey(s.contract) === stream && alive(s.handle.read(), limit, now));
    if (contract && !shared) {
      try {
        if (!t.error) session.cancelTicker(contract, "");
        else if (this.variant === undefined) session.cancelTicker(contract);
        else session.cancelTicker(contract, this.variant);
      } catch {
        /* 撤不掉也要重订 */
      }
    }
    if (!t.error) this.noteSilent(key, quoteSilenceMs(t, now) ?? 0);
    return false;
  }

  subscribe(session: IbSession, key: string, contract: IbContract): void {
    this.set(key, { handle: session.subscribeTicker(contract), contract, session });
  }

  /**
   * 这个键上备好一条能用的流(见 usable),回"是不是新订的":新订的要等首笔 tick。
   * @param target 要订的合约,只在需要重订时才拼
   * @param qualifies 合约确认;认不出回 false,记成 null 不反复重试
   */
  async ensure(
    session: IbSession, key: string, target: () => IbContract,
    qualifies: (contract: IbContract) => Promise<boolean>, silentLimitMs = 0,
  ): Promise<boolean> {
    if (this.usable(session, key, silentLimitMs)) return false;
    const contract = target();
    if (!(await qualifies(contract))) {
      this.set(key, { handle: null, contract: null });
      return false;
    }
    this.subscribe(session, key, contract);
    return true;
  }

  override clear(): void {
    this.silent.clear();
    super.clear();
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
      this.silent.delete(key);
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

  private noteSilent(key: string, silence: number): void {
    const times = (this.silent.get(key) ?? 0) + 1;
    this.silent.set(key, times);
    if (times === 1) logStderr(`[ibkr] 行情流 ${key}:连接还在,却 ${Math.round(silence / 1000)} 秒没来一笔盘口,撤掉重订`);
  }

  private recovered(key: string, t: TickerData): void {
    const times = this.silent.get(key);
    if (times === undefined || !t.quotedAt) return;
    this.silent.delete(key);
    logStderr(`[ibkr] 行情流 ${key}:重订 ${times} 次后盘口回来了`);
  }
}
