/** 券商成交 → 本地成交表:引擎自己按节拍同步,不靠界面开着哪一页。
 *
 * TWS 的 reqExecutions 只回它自己那个"当天"的成交——按 TWS 登录时选的时区,过了午夜就翻篇
 * (交易日志里勾了前几天的,才连那几天一起回)。只在打开交易分析 / 绩效体检时才去要的话,TWS 设成东八区、
 * 美股盘中下的单,过了北京时间 0 点再打开页面就要不到了,那笔成交永远进不了库。
 * 所以:持仓一变就去要(成交必然改持仓,几秒内落库),没变也隔几分钟要一次兜底,刚连上 / 重连回来先要一次。
 * 页面上的「同步成交」也走这里,两路共用一道节流。
 *
 * 光这样还有一个洞:软件没开着、或者正好断着线的时候成交了,等连上已经过了 TWS 的午夜,"当天"里就没有它了。
 * 所以有几趟还要**往回要 7 天**(ibExecHistory.ts:另开一条只读连接,用带天数的新接口):刚连上、持仓变了、
 * 人点了「同步成交」、以及每小时一次。往回要是加上去的:它没要到(TWS 太老、连不上、超时),当天的照存,下一趟再要。
 * 富途没有同样形状的成交查询,这里对它什么都不做。
 */
import { BrokerError, fillRow } from "../broker.js";
import { ServiceBase } from "./host.js";

/** 会话报的一条持仓里,认"变没变"用得上的那几样(IBKR 的账户号挂在 contract.account 上)。 */
export interface HoldingLike {
  contract?: Record<string, unknown>;
  position?: unknown;
  account?: unknown;
}

/** 会话报的一笔成交:合约 + 成交,都是券商那边的字段名。 */
interface ExecutionLike {
  contract?: Record<string, unknown>;
  execution?: Record<string, unknown>;
}

/** 成交同步向券商要的两样。富途没有 executions;测试替身的会话可以不带 positions、不带 executionHistory。 */
interface FillSource {
  sessions(): Array<{
    positions?: () => Promise<HoldingLike[]>;
    executionHistory?: (days: number) => Promise<ExecutionLike[] | null>;
  }>;
  executions?: () => Promise<Array<Record<string, unknown>>>;
}
type ReadyFillSource = FillSource & { executions: NonNullable<FillSource["executions"]> };

/** 持仓指纹:哪个账户、哪张合约、多少数量。只用来认"变没变",不拿去算账。
 *  数量为 0 的不算:平掉的仓 TWS 有时留一条 0、重连之后又不给,两种都是"没有"。 */
export function holdingsFingerprint(items: HoldingLike[]): string {
  const keys: string[] = [];
  for (const item of items) {
    const quantity = Number(item.position) || 0;
    if (!quantity) continue;
    const c = item.contract ?? {};
    const what = c["conId"]
      ? String(c["conId"])
      : [c["symbol"], c["secType"], c["lastTradeDateOrContractMonth"], c["strike"], c["right"]].map((v) => String(v ?? "")).join("/");
    keys.push(`${String(item.account ?? c["account"] ?? "")}|${what}|${quantity}`);
  }
  return keys.sort().join(";");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BrokerError(`读取成交明细失败:券商等了 ${Math.round(ms / 1000)} 秒没有回应`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class FillSyncService extends ServiceBase {
  /** 多久看一眼持仓变没变 */
  static readonly TICK_MS = 5_000;
  /** 持仓没变也隔这么久要一次:几秒内买进又卖出的(指纹不变)、持仓没读到的那几轮,靠它兜底 */
  static readonly EVERY_MS = 5 * 60_000;
  /** 两次向券商要成交至少隔这么久:reqExecutions 回的是当天全部成交,TWS 还会把回报整批重推一遍 */
  static readonly MIN_GAP_MS = 15_000;
  /** 券商最多等这么久。不设的话一次不回,后面的同步全排在它后面 */
  static readonly BROKER_TIMEOUT_MS = 10_000;
  /** 持仓变了之后要几次:一张单可能分几笔陆续成交,头一次要的时候后面几笔还没出来 */
  static readonly AFTER_CHANGE = 2;
  /** 往回要几天:TWS 最多给 7 天 */
  static readonly HISTORY_DAYS = 7;
  /** 没有别的由头时,隔这么久往回要一次 */
  static readonly HISTORY_EVERY_MS = 60 * 60_000;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private gen = 0;
  private running = false;
  /** 上次向券商要成交的时刻(performance.now 的毫秒)。 */
  private lastAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<number | null> | null = null;
  /** 上次看到的持仓指纹;null = 这次连上之后还没读到过。 */
  private holdings: string | null = null;
  /** 还欠券商几次同步。刚起来 / 刚连上先欠一次:断着的那段时间正是成交最可能漏掉的时候。 */
  private owed = 1;
  private lastError = "";
  /** 还欠几趟"往回要 7 天"。刚起来 / 刚连上先欠一趟:没连着的那段时间里成交的,当天那一问可能已经问不到了。 */
  private deepOwed = 1;
  /** 上次往回要成了的时刻(performance.now 的毫秒)。 */
  private lastDeepAt = Number.NEGATIVE_INFINITY;
  /** 这次连上的 TWS 给不了(版本太老):重连之前不再试 */
  private historyOff = false;
  private lastHistoryError = "";

  private source(): ReadyFillSource | null {
    const router = this.router as unknown as FillSource | null;
    if (router === null || typeof router.executions !== "function" || !router.sessions().length) return null;
    return router as ReadyFillSource;
  }

  /** 券商连着,而且给得了成交(富途给不了)。 */
  available(): boolean {
    return this.source() !== null;
  }

  // ---- 循环 ----------------------------------------------------------------
  start(tickMs: number = FillSyncService.TICK_MS): void {
    if (this.running) return;
    const gen = ++this.gen;
    this.running = true;
    const schedule = (): void => {
      const timer = setTimeout(() => void loop(), tickMs);
      timer.unref?.(); // 界面关了引擎该退就退,不能被它吊着
      this.timer = timer;
    };
    const loop = async (): Promise<void> => {
      await this.tickOnce().catch(() => undefined);
      if (gen !== this.gen || !this.running) return;
      schedule();
    };
    schedule();
  }

  stop(): void {
    this.gen += 1;
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 循环的一轮:持仓变了、到点了、或者还欠着,就去要一次。返回这一轮新增了几笔;没去要是 null。 */
  async tickOnce(nowMs: number = performance.now()): Promise<number | null> {
    const source = this.source();
    if (source === null) {
      this.forget();
      return null;
    }
    const seen = await this.readHoldings(source);
    if (seen !== null && seen !== this.holdings) {
      // 连上之后头一回读到不算"变了":刚连上那一次已经欠着了
      if (this.holdings !== null) {
        this.owed = FillSyncService.AFTER_CHANGE;
        // 成交正好卡在 TWS 的午夜前后时,当天那一问问不到它:持仓变了的这几趟一并往回要
        this.deepOwed = FillSyncService.AFTER_CHANGE;
      }
      this.holdings = seen;
    }
    if (this.owed === 0 && nowMs - this.lastAt >= FillSyncService.EVERY_MS) this.owed = 1;
    if (this.deepOwed === 0 && nowMs - this.lastDeepAt >= FillSyncService.HISTORY_EVERY_MS) this.deepOwed = 1;
    return this.owed > 0 ? this.sync(nowMs) : null;
  }

  /** 向券商要一次成交,存进成交表(只增,按 exec_id 去重)。返回新增了几笔;
   *  没连、券商给不了、离上一次太近、券商没答上来,都是 null。正在要的那一次还没回来就等它,不另发一次。
   *  deep:这一趟连前 7 天的一起要(人点「同步成交」时)。正赶上节流就记着,循环的下一趟补上。 */
  sync(nowMs: number = performance.now(), deep = false): Promise<number | null> {
    if (deep) {
      this.deepOwed = Math.max(this.deepOwed, 1);
      this.owed = Math.max(this.owed, 1);
    }
    if (this.inflight !== null) return this.inflight;
    const source = this.source();
    if (source === null) {
      this.forget();
      return Promise.resolve(null);
    }
    if (nowMs - this.lastAt < FillSyncService.MIN_GAP_MS) return Promise.resolve(null);
    this.lastAt = nowMs;
    const run = this.pull(source, nowMs).finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private async pull(source: ReadyFillSource, nowMs: number): Promise<number | null> {
    try {
      const today = await withTimeout(source.executions(), FillSyncService.BROKER_TIMEOUT_MS);
      const rows = Array.isArray(today) ? today : [];
      if (this.deepOwed > 0 && !this.historyOff) rows.push(...(await this.history(source, nowMs)));
      const added = this.engine.store.rememberFills(rows);
      this.owed = Math.max(0, this.owed - 1);
      this.lastError = "";
      return added;
    } catch (exc) {
      if (!(exc instanceof BrokerError)) throw exc;
      // 还欠着,过了节流再来。同一句报错只留一条痕:券商卡住时这里十几秒就来一轮
      const error = String(exc.message).slice(0, 300);
      if (error !== this.lastError) this.engine.store.audit("engine", "fills_failed", { error });
      this.lastError = error;
      return null;
    }
  }

  /**
   * 往回要 7 天:每个会话另开一条只读连接去要,归一成和当天那一问同样的行(同一笔成交两边都回,存的时候按 exec_id 去重)。
   * 没要到不算这一趟失败:返回要到的那些(可能是空的),欠着的那一趟留着,下次同步再要;同一句原因只留一条痕。
   */
  private async history(source: FillSource, nowMs: number): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    let able = false;
    try {
      for (const session of source.sessions()) {
        if (typeof session.executionHistory !== "function") continue;
        const details = await withTimeout(session.executionHistory(FillSyncService.HISTORY_DAYS), FillSyncService.BROKER_TIMEOUT_MS);
        if (details === null) continue;
        able = true;
        for (const d of details) {
          const row = fillRow(d.contract ?? {}, d.execution ?? {});
          if (row !== null) rows.push(row);
        }
      }
    } catch (exc) {
      const error = String((exc as Error).message ?? exc).slice(0, 300);
      if (error !== this.lastHistoryError) this.engine.store.audit("engine", "fills_history_failed", { error });
      this.lastHistoryError = error;
      return rows;
    }
    // 没有一个会话给得了(TWS 太老,或者这种券商压根没有):这次连接里不再试,免得每一趟都白连一次
    if (!able) this.historyOff = true;
    this.deepOwed = Math.max(0, this.deepOwed - 1);
    this.lastDeepAt = nowMs;
    this.lastHistoryError = "";
    return rows;
  }

  /** 断开了:下次连上当成新的开始(先要一次,持仓重新认,也往回要一趟)。节流不清——连接反复断开时不跟着一遍遍去要。 */
  private forget(): void {
    this.holdings = null;
    this.owed = Math.max(this.owed, 1);
    this.deepOwed = Math.max(this.deepOwed, 1);
    this.historyOff = false;
  }

  /** 各会话的持仓指纹;读不到是 null。读不到 ≠ 没变,这一轮不拿它当由头。 */
  private async readHoldings(source: FillSource): Promise<string | null> {
    const items: HoldingLike[] = [];
    try {
      for (const session of source.sessions()) {
        if (typeof session.positions !== "function") return null;
        items.push(...(await session.positions()));
      }
    } catch {
      return null;
    }
    return holdingsFingerprint(items);
  }
}
