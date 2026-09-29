/** 执行对账:重启 / 重连之后,把券商那边的真相搬回库里。
 *
 * 2026-09-20 从 engine.ts 整块搬出来。**只认证据,不做推断**:去向不明的单只追加一条状态事件,
 * 不落终态——终态不可逆,由用户决定。2026-09-27 审计之后又收紧了一步:"去向不明"这句话
 * 必须是**刚问过券商**才说得出口(见 syncExecutions)。
 *
 * 它自己只管两样状态(上次对账的时刻、上次向券商要成交的时刻);别的从宿主现取。
 */
import type { Notifier } from "../notify.js";
import type { PendingTrigger } from "../broker.js";
import type { Rec, TradeStore, WorkingRecord } from "../store.js";

/** 对账这一块要用到的引擎那一面。每次用到都现取,不在构造时存拷贝。 */
export interface ReconcileHost {
  readonly store: TradeStore;
  readonly notifier: Notifier;
  readonly router: ReconcileRouter | null;
  /** 券商 orderId / permId → 记录 id */
  readonly orderIndex: Map<number, string>;
  /** 已经落过终态的记录 id */
  readonly finalized: Set<string>;
  /** 已经折进来的成交 exec_id */
  readonly seenFills: Set<string>;
  pendingTriggers: PendingTrigger[];
  /** 把攒着的、当时认不出记录的回报重放一遍 */
  replayUnmatched(): void;
}

export interface ReconcileRouter {
  [method: string]: any;
}

/** 券商那头的请求永远不回时放手。
 *
 * IBApiNext 的 getAllOpenOrders / getExecutionDetails 自己没有超时:会话在请求途中被断开(「断开」按钮、
 * 换连接),结束信号永远不来,promise 永远挂着。对账是在盯盘锁里跑的——挂住它就是挂住盯盘、「立即平仓」
 * 与熔断按钮,而且那把锁跨引擎实例共用,重连也救不回来(2026-09-27 审计 M2)。
 * 超时只是这边不等了,底下那个请求撤不回来;它迟到的结果由 Promise.race 吞掉,不会变成未处理的拒绝。 */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}等了 ${Math.round(ms / 1000)} 秒没有回应`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** ② 的结局:填满了(已落 filled),或者还没有——`filled` 是成交表里找到的数量(0 = 一条都没有),
 * `quantity` 是这张单的数量(0 = 说不清)。 */
type Settled = { kind: "filled" } | { kind: "open"; filled: number; quantity: number };

function idOf(value: unknown): number | null {
  return Math.trunc(Number(value ?? 0)) || null;
}

/** 托管单的记录:signature 就是它在券商那边的 orderRef(`trk:<追踪>:<单型>`),不是记录 id。 */
function isHosted(rec: WorkingRecord): boolean {
  return rec.signature.startsWith("trk:");
}

export class Reconciler {
  constructor(private readonly host: ReconcileHost) {}

  private get store(): TradeStore { return this.host.store; }
  private get notifier(): Notifier { return this.host.notifier; }
  private get router(): ReconcileRouter | null { return this.host.router; }
  private get orderIndex(): Map<number, string> { return this.host.orderIndex; }
  private get finalized(): Set<string> { return this.host.finalized; }
  private get seenFills(): Set<string> { return this.host.seenFills; }
  private get pendingTriggers(): PendingTrigger[] { return this.host.pendingTriggers; }
  private replayUnmatched(): void { this.host.replayUnmatched(); }
  // ---- 执行对账:重启 / 重连之后把券商那边的真相搬回库里 --------------------
  //
  // orderIndex 只在内存里(见 §"券商回报 → 落库"),引擎一重建就是空的:券商随后推的状态与成交
  // recordFor() 认不出记录,只能进 unmatchedEvents,那 200 条缓冲又只有下一次下单才重放。
  // 追价平仓单有 adoptCloseChase,托管单有 adoptHosted——但 adoptHosted 只认回托管单本身(hostedIndex),
  // **不认回它那条记录**;普通单与条件单更是两样都没有。记录会永远停在 Submitted,界面一直显示"进行中"。
  //
  // 对账只认证据,不做推断:
  //  ① 券商侧还挂着的 → 重建 orderIndex,重放缓冲里的事件。普通单按 orderRef = 记录 id 认;
  //     托管单按 orderRef = signature 认,同一 signature 的多条记录再按单号分(见 openRowFor);
  //  ② 券商侧没有、但成交表里找得到成交且数量填满 → 补录成交事件 + 落 filled;
  //  ③ 其余去向不明的 → 只追加一条状态事件并提醒一次,**不落终态**。
  //     重启后没人盯的条件单就属于这一类:它确实已经没人管了,但终态不可逆,由用户决定。
  static readonly RECONCILE_EVERY_MS = 60_000;
  /** 刚发出去的单不对账:券商侧的未成交单列表有几百毫秒的滞后,新单会被当成"券商侧没有"。 */
  static readonly RECONCILE_GRACE_MS = 120_000;
  static readonly RECONCILE_MAX_AGE_DAYS = 7;
  /** 向券商要东西(未成交单、当天成交)最多等这么久;不回就这一轮作罢,下一轮再来。 */
  static readonly BROKER_TIMEOUT_MS = 10_000;
  /** 向券商要当天成交的最短间隔。reqExecutions 回的是当天全部成交,不便宜;接上新会话时不受它限制。 */
  static readonly EXEC_SYNC_EVERY_MS = 5 * 60_000;
  private reconcileAt = 0;
  /** 上次向券商要当天成交的时刻。负无穷 = 进程刚起来 / 刚接上新会话,下一轮必须去问。 */
  private execSyncAt = Number.NEGATIVE_INFINITY;

  /** 下一轮盯盘就重新对账(接上新会话时调用:券商可能在断线期间成交或撤了单)。 */
  reconcileSoon(): void {
    this.reconcileAt = 0;
    this.execSyncAt = Number.NEGATIVE_INFINITY;
  }

  reconcileDue(nowMs = Date.now()): boolean {
    return nowMs - this.reconcileAt >= Reconciler.RECONCILE_EVERY_MS;
  }

  async reconcileOrders(nowMs = Date.now()): Promise<Rec> {
    const out: Rec = { adopted: 0, filled: 0, unknown: 0 };
    const lister = (this.router as unknown as Rec)?.["listOpenOrdersDetailed"];
    if (typeof lister !== "function") return out;
    this.reconcileAt = nowMs;
    // 等券商回话**之前**先记下本进程还在盯的条件单。等的那几百毫秒里条件单可能触发、发出、从队列里摘掉,
    // 而券商这次给的列表是发单之前的——拿发单之后的队列判,它就成了"券商侧没有"(审计 M4)
    const pendingAtStart = new Set(this.pendingTriggers.map((p) => p.record_id));
    let rows: Rec[];
    try {
      rows = (await withTimeout(
        Promise.resolve(lister.call(this.router)), Reconciler.BROKER_TIMEOUT_MS, "券商的未成交单列表",
      )) ?? [];
    } catch (exc) {
      // 下一轮再试;这里失败不该影响盯盘
      this.store.audit("engine", "reconcile_failed", {
        error: String((exc as Error).message).slice(0, 300),
      });
      return out;
    }
    const openByRef = new Map<string, Rec[]>();
    for (const row of rows) {
      const ref = String(row["order_ref"] ?? "");
      if (!ref) continue;
      openByRef.set(ref, [...(openByRef.get(ref) ?? []), row]);
    }
    const working = this.store.listWorkingRecords(Reconciler.RECONCILE_MAX_AGE_DAYS, nowMs);
    // 此刻读得到的账户号(router 说不清就是 null = 都当读得到)。会话断着 / 没连上的账户,券商侧的未成交单
    // 根本没读到——"券商侧没有"是假的,不能拿它下"去向不明"的结论(断一次线弹一串假警报)
    const covered: Set<string> | null = this.router?.["coveredAccountIds"]?.() ?? null;
    const claimed = new Set<Rec>();
    const missing: WorkingRecord[] = [];
    for (const rec of working) {
      const open = this.openRowFor(rec, openByRef, claimed);
      if (open !== null) {
        claimed.add(open);
        if (this.adoptOpenOrder(rec.id, open)) out["adopted"] = Number(out["adopted"]) + 1;
        continue;
      }
      if (covered !== null && rec.accountId && !covered.has(rec.accountId)) continue;
      // 本进程还在盯的条件单没发到券商,不算失联;刚发出去的单也给券商一点滞后余量
      if (pendingAtStart.has(rec.id) || this.pendingTriggers.some((p) => p.record_id === rec.id)) continue;
      if (this.withinGrace(rec, nowMs)) continue;
      if (this.settleFromFills(rec).kind === "filled") out["filled"] = Number(out["filled"]) + 1;
      else missing.push(rec);
    }
    // ③ 之前先问一遍券商当天的成交:本地成交表只有交易分析同步过才有,不问就说"没查到它的成交"是假话
    if (missing.length && (await this.syncExecutions(missing, nowMs))) {
      for (const rec of missing) {
        const settled = this.settleFromFills(rec);
        if (settled.kind === "filled") out["filled"] = Number(out["filled"]) + 1;
        else if (this.flagUnreconciled(rec, settled)) out["unknown"] = Number(out["unknown"]) + 1;
      }
    }
    this.replayUnmatched();
    if (out["adopted"] || out["filled"] || out["unknown"]) {
      this.store.audit("engine", "reconciled", { ...out });
    }
    return out;
  }

  /** 宽限期从"最后一次可能把单子发出去"算:记录创建、或最后一条状态回报,取晚的那个。
   * 只从创建时算的话,等了三个小时才触发的条件单一发出去,就被当成失联(审计 M4)。
   * 晚于这一轮 now 的状态回报不作数:那是等券商回话时落的,pendingAtStart 已经兜住;时钟不对的更不能拿来算。 */
  private withinGrace(rec: WorkingRecord, nowMs: number): boolean {
    const statusAt = rec.lastStatusAtMs !== null && rec.lastStatusAtMs <= nowMs ? rec.lastStatusAtMs : rec.createdAtMs;
    return nowMs - Math.max(rec.createdAtMs, statusAt) < Reconciler.RECONCILE_GRACE_MS;
  }

  /** 这条记录在券商侧挂着的那张单。
   *
   * 普通单与条件单的 orderRef 就是记录 id。托管单的 orderRef 是 `trk:<追踪>:<单型>`(= 记录的 signature),
   * 以前这里一律跳过 trk: 前缀,可托管单的记录照样在在途记录里——于是每张活着的托管单都被报成「去向不明」,
   * 每次改价追加一条 Adjusted 又把状态刷掉,下一轮再报一次,一分钟一条(审计 H1)。
   * 同一追踪同一单型可能留下多条记录(被拒后重挂、券商不认后重挂):按记录上留的单号认;没留单号的老数据
   * 认单号最新的那张(与 adoptHosted 去重时留哪张同一口径),已经被别的记录认走的不再给第二条。 */
  private openRowFor(rec: WorkingRecord, openByRef: Map<string, Rec[]>, claimed: Set<Rec>): Rec | null {
    const own = (openByRef.get(rec.id) ?? []).find((row) => !claimed.has(row));
    if (own !== undefined) return own;
    if (!isHosted(rec)) return null;
    const rows = (openByRef.get(rec.signature) ?? []).filter((row) => !claimed.has(row));
    if (!rows.length) return null;
    const ids = this.knownOrderIds(rec.id);
    if (ids.size) {
      return rows.find((row) => ids.has(idOf(row["order_id"]) ?? -1) || ids.has(idOf(row["perm_id"]) ?? -1)) ?? null;
    }
    return [...rows].sort((a, b) => (idOf(b["order_id"]) ?? 0) - (idOf(a["order_id"]) ?? 0))[0] ?? null;
  }

  /** 记录状态回报里留下的券商单号(挂单时落的 order_id、回报带的 perm_id)。 */
  private knownOrderIds(recordId: string): Set<number> {
    const ibkr = this.store.getRecord(recordId)?.["ibkr"] ?? {};
    const ids = new Set<number>();
    for (const key of ["order_id", "perm_id"]) {
      const id = idOf(ibkr[key]);
      if (id !== null) ids.add(id);
    }
    return ids;
  }

  /** ① 券商侧还挂着这张单:orderId / permId 都指回记录,后续回报就认得出了。
   * 返回"这次才认领到"(已经在索引里的不重复记事件——对账每分钟一轮)。 */
  private adoptOpenOrder(recordId: string, open: Rec): boolean {
    const orderId = idOf(open["order_id"]);
    const permId = idOf(open["perm_id"]);
    const known =
      (orderId !== null && this.orderIndex.has(orderId)) ||
      (permId !== null && this.orderIndex.has(permId));
    if (orderId !== null) this.orderIndex.set(orderId, recordId);
    if (permId !== null) this.orderIndex.set(permId, recordId);
    if (known) return false;
    this.store.appendEvent(recordId, "status", {
      status: String(open["status"] ?? "") || "Submitted",
      source: "reconcile",
      order_id: orderId,
      perm_id: permId,
    });
    this.store.audit("engine", "reconcile_adopted", {
      record: recordId, order_id: orderId, status: open["status"] ?? "",
    });
    return true;
  }

  /** 这条记录在成交表里的成交行。普通单按 orderRef = 记录 id;托管单的 orderRef 是整条追踪共用的
   * signature,同一追踪更早那几张单的成交也带着它——只认单号对得上的,单号都没留下的认不出,一条都不认。 */
  private fillsOf(rec: WorkingRecord): Rec[] {
    if (!isHosted(rec)) return this.store.fillsByOrderRef(rec.id);
    const ids = this.knownOrderIds(rec.id);
    if (!ids.size) return [];
    return this.store.fillsByOrderRef(rec.signature)
      .filter((f) => ids.has(idOf(f["order_id"]) ?? -1) || ids.has(idOf(f["perm_id"]) ?? -1));
  }

  /** ② 券商侧没有这张单,但成交表里有它的成交:补录成交事件,数量填满才落 filled。
   * 组合单 IBKR 回 1 条 BAG 行 + 每条腿各一行,只认 BAG 行——腿加起来是数量的好几倍。
   * 没落终态的也把找到了多少交出去(`filled` 为 0 = 一条成交都没有):③ 的提醒语要照实说。 */
  private settleFromFills(rec: WorkingRecord): Settled {
    const fills = this.fillsOf(rec);
    if (!fills.length) return { kind: "open", filled: 0, quantity: rec.quantity };
    const isBag = fills.some((f) => String((f["contract"] ?? {})["secType"] ?? "") === "BAG");
    const counted = isBag
      ? fills.filter((f) => String((f["contract"] ?? {})["secType"] ?? "") === "BAG")
      : fills;
    const filledQty = counted.reduce((acc, f) => acc + (Number(f["shares"]) || 0), 0);
    const record = this.store.getRecord(rec.id);
    // 回报认不出记录时被丢掉的成交,这里按 exec_id 补录(读侧还会再去一次重,见 foldEvents)
    const known = new Set(
      ((record?.["ibkr"]?.["fills"] ?? []) as Rec[]).map((f) => String(f["exec_id"] ?? "")),
    );
    for (const fill of fills) {
      const execId = String(fill["exec_id"] ?? "");
      if (!execId || known.has(execId)) continue;
      this.store.appendEvent(rec.id, "fill", {
        exec_id: execId,
        time: String(fill["time"] ?? ""),
        price: Number(fill["price"]) || 0,
        qty: Number(fill["shares"]) || 0,
        commission: Number(fill["commission"]) || 0,
        sec_type: String((fill["contract"] ?? {})["secType"] ?? "") || null,
        con_id: idOf((fill["contract"] ?? {})["conId"]),
      });
      this.seenFills.add(execId);
      for (const key of [fill["perm_id"], fill["order_id"]]) {
        const id = idOf(key);
        if (id !== null) this.orderIndex.set(id, rec.id);
      }
    }
    // 托管单的记录按 order.quantity 落(不是 totalQuantity),库里那一列是 0,从记录本身取
    const quantity = rec.quantity > 0 ? rec.quantity : Number(record?.["order"]?.["quantity"] ?? 0) || 0;
    // 差一点点算填满:数量是浮点,组合单的份数与腿数在券商侧也可能有舍入
    if (quantity > 0 && filledQty + 1e-9 < quantity) return { kind: "open", filled: filledQty, quantity };
    if (this.finalized.has(rec.id)) return { kind: "open", filled: filledQty, quantity };
    this.finalized.add(rec.id);
    this.store.setFinalStatus(rec.id, "filled");
    this.store.audit("engine", "reconcile_filled", {
      record: rec.id, quantity, filled: filledQty,
    });
    this.notifier.warning(
      `对账:${rec.symbol} 的单子在断线期间已经成交(${filledQty}),记录已补上成交与终态。`,
    );
    return { kind: "filled" };
  }

  /** ③ 之前先向券商要当天的成交,存进成交表。返回"这一轮能不能下去向不明的结论"。
   *
   * 本地成交表以前只有交易分析那一页同步时才写——应用关着时成交了的单,重启后被报成"券商侧已经没有这张单,
   * 也没查到它的成交",照着这句话重下一张就是双倍仓位(审计 H2)。所以:
   *  · router 能给成交(IBKR 的 executions = reqExecutions)就先问,问到了才下结论;
   *  · 问失败 / 超时 / 被节流 → 这一轮不下结论,留给下一轮(晚几分钟说,好过说错);
   *  · router 给不了成交(测试替身、别家券商)→ 照旧按本地成交表下结论。
   * 待定的记录全都已经标过 NotAtBroker 时不必去问(标记本来就只落一次),除非刚接上新会话——断线那段时间
   * 正是成交最可能漏掉的时候。券商只回**当天**的成交,更早成交的仍会落进 ③,提醒语里写明了。 */
  private async syncExecutions(missing: WorkingRecord[], nowMs: number): Promise<boolean> {
    const fetchFills = (this.router as unknown as Rec)?.["executions"];
    if (typeof fetchFills !== "function") return true;
    const fresh = this.execSyncAt === Number.NEGATIVE_INFINITY;
    if (!fresh && missing.every((rec) => rec.lastStatus === Reconciler.STATUS_NOT_AT_BROKER)) return true;
    if (!fresh && nowMs - this.execSyncAt < Reconciler.EXEC_SYNC_EVERY_MS) return false;
    this.execSyncAt = nowMs;
    try {
      const rows = (await withTimeout(
        Promise.resolve(fetchFills.call(this.router)), Reconciler.BROKER_TIMEOUT_MS, "券商的当天成交",
      )) ?? [];
      this.store.rememberFills(Array.isArray(rows) ? rows : []);
      return true;
    } catch (exc) {
      this.store.audit("engine", "reconcile_fills_failed", {
        error: String((exc as Error).message).slice(0, 300),
      });
      return false;
    }
  }

  /** ③ 去向不明:券商侧没有这张单,当天的成交也没有填满它。只留痕 + 提醒一次,不落终态。
   * 找到过一部分成交的(已在 ② 补录进记录)照实说成交了多少、剩下多少去向不明——这条压过下面按状态分的几句:
   * 有成交就说明单子发出去过,"当天的成交里也没有它""多半没有发出去"都是假话。 */
  private flagUnreconciled(rec: WorkingRecord, settled: { filled: number; quantity: number }): boolean {
    if (rec.lastStatus === Reconciler.STATUS_NOT_AT_BROKER) return false;
    const partial = settled.filled > 0 ? { filled: settled.filled, quantity: settled.quantity } : {};
    this.store.appendEvent(rec.id, "status", {
      status: Reconciler.STATUS_NOT_AT_BROKER,
      source: "reconcile",
      was: rec.lastStatus,
      ...partial,
    });
    this.store.audit("engine", "reconcile_missing", { record: rec.id, was: rec.lastStatus, ...partial });
    const why =
      settled.filled > 0
        ? `券商侧已经没有这张单,当天的成交里只找到 ${settled.filled}(共 ${settled.quantity}),已补录进记录;`
          + `剩下的 ${Math.max(0, settled.quantity - settled.filled)} 可能被撤了,也可能更早成交、券商不再回报`
          + "(请在 TWS 里核对后再决定是否补下剩下的部分)"
        : rec.lastStatus === "PendingTrigger"
          ? "软件重启后条件单不再被盯,要继续请重新提交"
          : rec.lastStatus === ""
            // 只留下了发单的痕、一条状态回报都没有:发到一半软件中断了(见 store.markSubmitIntent)
            ? "发单途中软件中断了,券商侧没有这张单,当天的成交里也没有它:它多半没有发出去(请在 TWS 里核对后再决定是否重下)"
            : "券商侧已经没有这张单,当天的成交里也没有它(更早成交的券商不再回报,请在 TWS 里核对后再决定是否重下)";
    this.notifier.warning(`对账:${rec.symbol} 的单子去向不明——${why}。`);
    return true;
  }

  /** 对账给"券商侧查不到"的记录打的状态。不是 IBKR 的状态词,也不是终态。 */
  static readonly STATUS_NOT_AT_BROKER = "NotAtBroker";
}
