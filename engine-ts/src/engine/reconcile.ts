/** 执行对账:重启 / 重连之后,把券商那边的真相搬回库里。
 *
 * 2026-09-20 从 engine.ts 整块搬出来(函数体逐字未改)。**只认证据,不做推断**:去向不明的单只追加一条状态事件,
 * 不落终态——终态不可逆,由用户决定。
 *
 * 它自己只管一样状态(上次对账的时刻);别的从宿主现取。
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
  // 托管单有 adoptHosted、追价平仓单有 adoptCloseChase,**普通单与条件单没有**——记录会永远
  // 停在 Submitted,库里没有终态,界面一直显示"进行中"。
  //
  // 对账只认证据,不做推断:
  //  ① 券商侧还挂着、orderRef 是记录 id 的 → 重建 orderIndex,重放缓冲里的事件;
  //  ② 券商侧没有、但成交表里按 orderRef 找得到成交且数量填满 → 补录成交事件 + 落 filled;
  //  ③ 其余去向不明的 → 只追加一条状态事件并提醒一次,**不落终态**。
  //     重启后没人盯的条件单就属于这一类:它确实已经没人管了,但终态不可逆,由用户决定。
  static readonly RECONCILE_EVERY_MS = 60_000;
  /** 刚发出去的单不对账:券商侧的未成交单列表有几百毫秒的滞后,新单会被当成"券商侧没有"。 */
  static readonly RECONCILE_GRACE_MS = 120_000;
  static readonly RECONCILE_MAX_AGE_DAYS = 7;
  private reconcileAt = 0;

  /** 下一轮盯盘就重新对账(接上新会话时调用:券商可能在断线期间成交或撤了单)。 */
  reconcileSoon(): void {
    this.reconcileAt = 0;
  }

  reconcileDue(nowMs = Date.now()): boolean {
    return nowMs - this.reconcileAt >= Reconciler.RECONCILE_EVERY_MS;
  }

  async reconcileOrders(nowMs = Date.now()): Promise<Rec> {
    const out: Rec = { adopted: 0, filled: 0, unknown: 0 };
    const lister = (this.router as unknown as Rec)?.["listOpenOrdersDetailed"];
    if (typeof lister !== "function") return out;
    this.reconcileAt = nowMs;
    let rows: Rec[];
    try {
      rows = (await lister.call(this.router)) ?? [];
    } catch (exc) {
      // 下一轮再试;这里失败不该影响盯盘
      this.store.audit("engine", "reconcile_failed", {
        error: String((exc as Error).message).slice(0, 300),
      });
      return out;
    }
    const openByRef = new Map<string, Rec>();
    for (const row of rows) {
      const ref = String(row["order_ref"] ?? "");
      if (!ref || ref.startsWith("trk:")) continue; // 托管单由 adoptHosted 认领
      openByRef.set(ref, row);
    }
    const working = this.store.listWorkingRecords(Reconciler.RECONCILE_MAX_AGE_DAYS, nowMs);
    for (const rec of working) {
      const open = openByRef.get(rec.id);
      if (open !== undefined) {
        if (this.adoptOpenOrder(rec.id, open)) out["adopted"] = Number(out["adopted"]) + 1;
        continue;
      }
      // 本进程还在盯的条件单没发到券商,不算失联;刚发出去的单也给券商一点滞后余量
      if (this.pendingTriggers.some((p) => p.record_id === rec.id)) continue;
      if (nowMs - rec.createdAtMs < Reconciler.RECONCILE_GRACE_MS) continue;
      if (this.settleFromFills(rec)) out["filled"] = Number(out["filled"]) + 1;
      else if (this.flagUnreconciled(rec)) out["unknown"] = Number(out["unknown"]) + 1;
    }
    this.replayUnmatched();
    if (out["adopted"] || out["filled"] || out["unknown"]) {
      this.store.audit("engine", "reconciled", { ...out });
    }
    return out;
  }

  /** ① 券商侧还挂着这张单:orderId / permId 都指回记录,后续回报就认得出了。
   * 返回"这次才认领到"(已经在索引里的不重复记事件——对账每分钟一轮)。 */
  private adoptOpenOrder(recordId: string, open: Rec): boolean {
    const orderId = Math.trunc(Number(open["order_id"] ?? 0)) || null;
    const permId = Math.trunc(Number(open["perm_id"] ?? 0)) || null;
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

  /** ② 券商侧没有这张单,但成交表里有它的成交:补录成交事件,数量填满才落 filled。
   * 组合单 IBKR 回 1 条 BAG 行 + 每条腿各一行,只认 BAG 行——腿加起来是数量的好几倍。 */
  private settleFromFills(rec: WorkingRecord): boolean {
    const fills = this.store.fillsByOrderRef(rec.id);
    if (!fills.length) return false;
    const isBag = fills.some((f) => String((f["contract"] ?? {})["secType"] ?? "") === "BAG");
    const counted = isBag
      ? fills.filter((f) => String((f["contract"] ?? {})["secType"] ?? "") === "BAG")
      : fills;
    const filledQty = counted.reduce((acc, f) => acc + (Number(f["shares"]) || 0), 0);
    // 回报认不出记录时被丢掉的成交,这里按 exec_id 补录(读侧还会再去一次重,见 foldEvents)
    const known = new Set(
      ((this.store.getRecord(rec.id)?.["ibkr"]?.["fills"] ?? []) as Rec[])
        .map((f) => String(f["exec_id"] ?? "")),
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
        con_id: Math.trunc(Number((fill["contract"] ?? {})["conId"] ?? 0)) || null,
      });
      this.seenFills.add(execId);
      for (const key of [fill["perm_id"], fill["order_id"]]) {
        const id = Math.trunc(Number(key ?? 0)) || null;
        if (id !== null) this.orderIndex.set(id, rec.id);
      }
    }
    // 差一点点算填满:数量是浮点,组合单的份数与腿数在券商侧也可能有舍入
    if (rec.quantity > 0 && filledQty + 1e-9 < rec.quantity) return false;
    if (this.finalized.has(rec.id)) return false;
    this.finalized.add(rec.id);
    this.store.setFinalStatus(rec.id, "filled");
    this.store.audit("engine", "reconcile_filled", {
      record: rec.id, quantity: rec.quantity, filled: filledQty,
    });
    this.notifier.warning(
      `对账:${rec.symbol} 的单子在断线期间已经成交(${filledQty}),记录已补上成交与终态。`,
    );
    return true;
  }

  /** ③ 去向不明:券商侧没有、成交表里也没有。只留痕 + 提醒一次,不落终态。 */
  private flagUnreconciled(rec: WorkingRecord): boolean {
    if (rec.lastStatus === Reconciler.STATUS_NOT_AT_BROKER) return false;
    this.store.appendEvent(rec.id, "status", {
      status: Reconciler.STATUS_NOT_AT_BROKER,
      source: "reconcile",
      was: rec.lastStatus,
    });
    this.store.audit("engine", "reconcile_missing", { record: rec.id, was: rec.lastStatus });
    const why =
      rec.lastStatus === "PendingTrigger"
        ? "软件重启后条件单不再被盯,要继续请重新提交"
        : "券商侧已经没有这张单,也没查到它的成交";
    this.notifier.warning(`对账:${rec.symbol} 的单子去向不明——${why}。`);
    return true;
  }

  /** 对账给"券商侧查不到"的记录打的状态。不是 IBKR 的状态词,也不是终态。 */
  static readonly STATUS_NOT_AT_BROKER = "NotAtBroker";
}
