/** 几条期权腿此刻的盘口与 IBKR 的模型 IV(只读)。蝴蝶测算(services/flyPlanner.ts 的 planFor)与 IV 记录(services/ivRecorder.ts)用。
 *
 * 为什么不借 BrokerRouter.legQuotes 或持仓那批常驻流:
 *
 * * **不许碰盯盘的流。** 行情流按「合约 + generic ticks」缓存、没有引用计数(ibSession.tickerKey)。测算的腿很可能
 *   正好是持仓的腿(加仓、相邻的蝶共用行权价),和盯盘订同一条再撤掉,盯盘手里的句柄就停在最后一笔上不动了。
 *   所以这里带着自己的 generic ticks 订——那是另一条流——撤也只撤这一条。
 * * **IV 会变,测算要能跟着刷。** 现订现撤一次要等首笔 tick(一两秒到四秒);界面十秒刷一次的话大半时间都在等。
 *   订上之后留着,一分钟没人读才撤;留着的时候读是即时的。最多留 MAX_STREAMS 条,行情线路是有配额的(约 100 条)。
 *
 * 这一层只认合约与行情:拿不到的给 null,不编;要不要退到手动 IV 是上一层的事。
 */
import { describeContract, optionContract } from "./ibContracts.js";
import type { IbContract, IbSession, TickerHandle } from "./ibTypes.js";

export class OptionMarksError extends Error {}

export interface OptionLegSpec {
  symbol: string;
  /** YYYYMMDD */
  expiry: string;
  strike: number;
  right: string;
  exchange: string;
  tradingClass: string;
}

export interface OptionMark {
  strike: number;
  right: string;
  /** 买价恰好为 0 = 没人出价,照实给 0 */
  bid: number | null;
  ask: number | null;
  /** IBKR 的模型 IV(年化小数) */
  iv: number | null;
  /** 订阅被 TWS 拒掉时的原文(10197、354……) */
  error: string | null;
}

interface Stream { session: IbSession; contract: IbContract; handle: TickerHandle; usedAt: number }

function price(value: unknown): number | null {
  const v = Number(value);
  return value !== null && value !== undefined && Number.isFinite(v) && v > 0 ? v : null;
}

export class OptionMarkStreams {
  /** 106 = 期权隐含波动率。带上它只为了和不带 generic 的盯盘流、带 "100,101,106" 的期权链流分开 */
  static readonly TICKS = "106";
  static readonly IDLE_MS = 60_000;
  static readonly MAX_STREAMS = 24;
  static readonly QUOTE_WAIT_MS = 4_000;
  /** 盘口齐了之后再等模型 IV 多久:它比盘口晚一拍,但休市时根本不来,不能一直等 */
  static readonly IV_WAIT_MS = 1_500;
  static readonly QUALIFY_TIMEOUT_MS = 12_000;

  private readonly streams = new Map<string, Stream>();
  private readonly conIds = new Map<string, number>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  /** 同一时刻只跑一次:两次读交错的话,一边在等的流可能被另一边的清理撤掉 */
  read(session: IbSession, legs: OptionLegSpec[], delayedOk: boolean): Promise<OptionMark[]> {
    const run = this.tail.then(() => this.readNow(session, legs, delayedOk));
    this.tail = run.catch(() => undefined);
    return run;
  }

  get size(): number {
    return this.streams.size;
  }

  /** 撤掉所有还留着的流(引擎退出、券商断开重连时)。 */
  close(): void {
    for (const key of [...this.streams.keys()]) this.drop(key);
    this.stopSweeper();
  }

  private key(leg: OptionLegSpec): string {
    return `${leg.symbol}|${leg.expiry}|${leg.strike}|${leg.right}|${leg.tradingClass}`;
  }

  private drop(key: string): void {
    const s = this.streams.get(key);
    if (!s) return;
    this.streams.delete(key);
    try {
      s.session.cancelTicker(s.contract, OptionMarkStreams.TICKS);
    } catch {
      /* 会话已经断了:流跟着连接一起没了,没什么可撤的 */
    }
  }

  private sweep(now: number, keep: Set<string>): void {
    for (const [key, s] of this.streams) {
      if (keep.has(key)) continue;
      if (now - s.usedAt >= OptionMarkStreams.IDLE_MS || !s.session.isConnected()) this.drop(key);
    }
    // 还是太多:从最久没读的撤起
    const spare = [...this.streams.entries()].filter(([k]) => !keep.has(k)).sort((a, b) => a[1].usedAt - b[1].usedAt);
    while (this.streams.size > OptionMarkStreams.MAX_STREAMS && spare.length) this.drop(spare.shift()![0]);
    if (!this.streams.size) this.stopSweeper();
  }

  private startSweeper(): void {
    if (this.sweeper !== null) return;
    this.sweeper = setInterval(() => this.sweep(Date.now(), new Set()), OptionMarkStreams.IDLE_MS / 2);
    this.sweeper.unref?.();
  }

  private stopSweeper(): void {
    if (this.sweeper === null) return;
    clearInterval(this.sweeper);
    this.sweeper = null;
  }

  private async qualify(session: IbSession, legs: OptionLegSpec[], contracts: IbContract[]): Promise<void> {
    const need: number[] = [];
    contracts.forEach((c, i) => {
      const hit = this.conIds.get(this.key(legs[i]!));
      if (hit) c.conId = hit;
      else need.push(i);
    });
    if (!need.length) return;
    try {
      await session.qualifyContracts(need.map((i) => contracts[i]!), OptionMarkStreams.QUALIFY_TIMEOUT_MS);
    } catch {
      throw new OptionMarksError(
        `TWS 在 ${OptionMarkStreams.QUALIFY_TIMEOUT_MS / 1000} 秒内没有回应合约确认请求。多半是 TWS 和 IBKR 服务器之间断了,` +
        "请看 TWS 窗口右下角的连接状态。",
      );
    }
    for (const i of need) {
      const c = contracts[i]!;
      if (!c.conId) {
        throw new OptionMarksError(
          `IBKR 确认不了这张合约(${describeContract(c)}):行权价或到期日可能不存在。`,
        );
      }
      this.conIds.set(this.key(legs[i]!), c.conId);
    }
  }

  private async readNow(session: IbSession, legs: OptionLegSpec[], delayedOk: boolean): Promise<OptionMark[]> {
    const keys = legs.map((leg) => this.key(leg));
    this.sweep(Date.now(), new Set(keys));
    const contracts = legs.map((leg) =>
      optionContract(leg.symbol, leg.expiry, leg.strike, leg.right, leg.exchange, "USD", "100", leg.tradingClass));

    // 换了会话(重连过)、或者被拒过的流不会自己活过来:摘掉重订
    keys.forEach((key) => {
      const s = this.streams.get(key);
      if (s && (s.session !== session || s.handle.read().error)) this.drop(key);
    });
    const fresh = keys.filter((key) => !this.streams.has(key));
    if (fresh.length) {
      await this.qualify(session, legs, contracts);
      // 纸面会话按类型 3 订(有实时给实时,没有给延迟),和 legQuotes 同一条规矩;实盘绝不拿延迟价
      if (delayedOk) session.reqMarketDataType(3);
    }
    try {
      keys.forEach((key, i) => {
        if (this.streams.has(key)) return;
        const contract = contracts[i]!;
        const handle = session.subscribeTicker(contract, OptionMarkStreams.TICKS);
        this.streams.set(key, { session, contract, handle, usedAt: Date.now() });
      });
      this.startSweeper();
      await this.waitFor(session, keys);
    } finally {
      if (fresh.length && delayedOk) session.reqMarketDataType(1);
    }

    return legs.map((leg, i) => {
      const s = this.streams.get(keys[i]!);
      const t = s?.handle.read();
      if (s) s.usedAt = Date.now();
      return {
        strike: leg.strike, right: leg.right,
        bid: t ? (t.bid === 0 ? 0 : price(t.bid)) : null,
        ask: t ? price(t.ask) : null,
        iv: t ? price(t.modelGreeks?.impliedVol) : null,
        error: t?.error ?? null,
      };
    });
  }

  /** 轮询而不是固定等待:固定 sleep 会抢跑拿到 NaN。流是热的时候第一轮就过 */
  private async waitFor(session: IbSession, keys: string[]): Promise<void> {
    const ticks = (): Array<ReturnType<TickerHandle["read"]>> =>
      keys.map((key) => this.streams.get(key)!.handle.read());
    const quoted = (): boolean => ticks().every((t) => t.error || (price(t.ask) !== null && (t.bid === 0 || price(t.bid) !== null)));
    const withIv = (): boolean => ticks().every((t) => t.error || price(t.modelGreeks?.impliedVol) !== null);
    let waited = 0, ivWaited = 0;
    await session.settle(50);
    while (waited < OptionMarkStreams.QUOTE_WAIT_MS) {
      if (quoted()) {
        if (withIv() || ivWaited >= OptionMarkStreams.IV_WAIT_MS) return;
        ivWaited += 250;
      }
      await session.settle(250);
      waited += 250;
    }
  }
}
