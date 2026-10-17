/** TWS 不回合约确认时,只读的取数别每次各等满一个超时。
 *
 * 合约确认有硬超时(BrokerRouter.QUALIFY_TIMEOUT_MS,12 秒):TWS 与 IBKR 之间断着时本机端口还通,请求永远等不到回音。
 * 只读的取数是轮询来的——测算面板的现价两秒一次、K 线页、盘口——TWS 卡住的那几个小时里每一次都在确认上等满 12 秒
 * (2026-10-05 与 10-12 的 main.log:options.spot 1,004 次、pa.analyze 351 次正好 12 秒):两秒一刷的现价十二秒才回一次,
 * 每一路都一直占着读道(READ_CONCURRENCY,4 个)里的一个位置,TWS 也被同一个确认问了上千遍。
 * 别的读请求有没有因此排队,那时的日志看不出(只记了执行时长);现在排队另记,见 rpc/perfLog.ts。
 *
 *  · 按会话记,不按合约记:不回话的是 TWS,不是某一张合约。一次超时之后 QUALIFY_RETRY_MS 内,
 *    这条会话上缓存里没有的确认当场答"没回应",不发请求。
 *  · 到了间隔只放一路去试探:放行的那一刻就把间隔往后推,同时进来的不跟着排队等。
 *  · 回了话就清掉,认得出认不出都算回了话;只有超时才记。
 *  · 下单、托管单的触发条件、组合腿定价不受这道闸(wait = true):用户点了就去问,哪怕刚超时过。
 *    它们的结果照样记进来——下单路径问回来了,读的那几路也跟着恢复。
 *
 * 持仓的常驻行情流在这之上还有自己的一层间隔(heldStreams.ts 的 stalledUntil),口径同一个数。
 */
import type { IbContract, IbSession } from "./ibTypes.js";

/**
 * TWS 没回合约确认(超时)之后,隔多久再去确认一次。和盘中"这条流没动静就重订"的时限同一个数:
 * 行情不通时,半分钟试一次。试一次的代价是 TWS 还没好时白等一个确认超时(12 秒)。
 */
export const QUALIFY_RETRY_MS = 30_000;

/** 会话 → 上一次确认超时之后,到什么时候之前只读的确认不再发请求。有这一项 = 这个会话正卡着。 */
const stalledUntil = new WeakMap<IbSession, number>();

export interface QualifyGateStats {
  /** 确认等满了超时 */
  timeouts: number;
  /** 刚超时过,当场答"没回应"、没发请求 */
  skipped: number;
  /** 到了间隔放出去的那一路试探 */
  probes: number;
}

const stats: QualifyGateStats = { timeouts: 0, skipped: 0, probes: 0 };

/** 上次取走以来的计数,取完清零(RPC 层每十分钟写进 `[perf]` 那一行) */
export function takeQualifyGateStats(): QualifyGateStats {
  const out = { ...stats };
  stats.timeouts = 0;
  stats.skipped = 0;
  stats.probes = 0;
  return out;
}

export function isTimeout(exc: unknown): boolean {
  const msg = String((exc as Error)?.message ?? exc).toLowerCase();
  return msg.includes("timeout") || (exc as Error)?.name === "TimeoutError";
}

/**
 * 确认一批合约。回 "stalled" = TWS 没在时限内回话,或者刚超时过、这一次没轮到去试探;别的错照抛。
 * @param wait true = 刚超时过也照样去问(下单路径)
 */
export async function qualifyGated(
  session: IbSession, contracts: IbContract[], timeoutMs: number, wait: boolean, now: () => number = Date.now,
): Promise<"ok" | "stalled"> {
  if (!wait) {
    const until = stalledUntil.get(session);
    if (until !== undefined) {
      if (now() < until) {
        stats.skipped += 1;
        return "stalled";
      }
      stats.probes += 1;
      stalledUntil.set(session, now() + QUALIFY_RETRY_MS);
    }
  }
  try {
    await session.qualifyContracts(contracts, timeoutMs);
  } catch (exc) {
    if (isTimeout(exc)) {
      stats.timeouts += 1;
      stalledUntil.set(session, now() + QUALIFY_RETRY_MS);
      return "stalled";
    }
    stalledUntil.delete(session);
    throw exc;
  }
  stalledUntil.delete(session);
  return "ok";
}
