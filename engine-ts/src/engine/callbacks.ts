/** 券商回报 → 落库(§6 status_timeline / fills)。
 *
 * 2026-09-20 从 engine.ts 搬出来(函数体逐字未改)。搬的是**回报进来之后怎么落库**;
 * 怎么把回调挂上去(wireSession / attachListeners)、以及下单侧要用的 indexPlacement / brokerCode 留在 engine.ts。
 *
 * 两条纪律写在代码里:成交与佣金按 exec_id 只落第一条(券商会重推,翻倍就是账不平);
 * 认不出记录的回报先攒着(unmatchedEvents),等 orderIndex 建好再重放——直接丢就是「快速成交永远停在 Submitted」。
 */
import type { Notifier } from "../notify.js";
import { redactAccount, type TradeStore } from "../store.js";

/** 托管单那一路,错误与状态回报都要先过它一手(整块在 engine/hosted.ts)。
 *  这里只写回报用得着的那两只手,不引 HostedOrders 本身——两块互不认识。 */
export interface CallbackHostedOrders {
  handleError(orderId: number, code: number, message: string): boolean;
  onStatus(trade: any): void;
}

/** 回报落库这一块要用到的引擎那一面。每次用到都现取,不在构造时存拷贝。 */
export interface CallbackHost {
  readonly store: TradeStore;
  readonly notifier: Notifier;
  /** 券商 orderId / permId → 记录 id */
  readonly orderIndex: Map<number, string>;
  readonly finalized: Set<string>;
  readonly seenFills: Set<string>;
  readonly seenCommissions: Set<string>;
  /** 认不出记录的回报先攒在这儿 */
  readonly unmatchedEvents: Array<[string, any, any, any]>;
  readonly earlyOrderErrors: Map<number, [number, string, number]>;
  /** 托管单 / 追价平仓那两路要先过一手 */
  readonly hostedOrders: CallbackHostedOrders;
  /** 追价中的平仓单:orderId → track_id。只读一下在不在,改是下单侧的事 */
  readonly closeChaseIndex: ReadonlyMap<number, string>;
  closeChaseOnStatus(trade: any): void;
}

export class IbCallbacks {
  constructor(private readonly host: CallbackHost) {}

  private get store(): TradeStore { return this.host.store; }
  private get notifier(): Notifier { return this.host.notifier; }
  private get orderIndex(): Map<number, string> { return this.host.orderIndex; }
  private get finalized(): Set<string> { return this.host.finalized; }
  private get seenFills(): Set<string> { return this.host.seenFills; }
  private get seenCommissions(): Set<string> { return this.host.seenCommissions; }
  private get unmatchedEvents(): Array<[string, any, any, any]> { return this.host.unmatchedEvents; }
  private get earlyOrderErrors(): Map<number, [number, string, number]> { return this.host.earlyOrderErrors; }
  private get hostedOrders(): CallbackHostedOrders { return this.host.hostedOrders; }
  private get closeChaseIndex(): ReadonlyMap<number, string> { return this.host.closeChaseIndex; }
  private closeChaseOnStatus(trade: any): void { this.host.closeChaseOnStatus(trade); }
  /** 同上:对账重建 orderIndex 之后要把攒着的回报重放一遍 */
  replayUnmatched(): void {
    if (!this.unmatchedEvents.length) return;
    const stashed = [...this.unmatchedEvents];
    this.unmatchedEvents.length = 0;
    for (const [kind, trade, fill, report] of stashed) {
      if (this.recordFor(trade) === null) {
        this.unmatchedEvents.push([kind, trade, fill, report]);
        continue;
      }
      if (kind === "status") this.onOrderStatus(trade);
      else if (kind === "exec") this.onExecDetails(trade, fill);
      else if (kind === "commission") this.onCommission(trade, fill, report);
    }
    // 缓冲上限(与 Python deque(maxlen=200) 同语义)
    while (this.unmatchedEvents.length > 200) this.unmatchedEvents.shift();
  }

  private static readonly TERMINAL_IB_STATUS: Record<string, string> = {
    Filled: "filled",
    Cancelled: "cancelled",
    ApiCancelled: "cancelled",
    Inactive: "ibkr_error",
  };

  private stashUnmatched(kind: string, trade: any, fill: any = null, report: any = null): void {
    // 只攒带 orderId/permId 的回报——完全无主的没必要留
    const order = trade?.order;
    if (!order) return;
    if (order.permId || order.orderId) {
      this.unmatchedEvents.push([kind, trade, fill, report]);
      while (this.unmatchedEvents.length > 200) this.unmatchedEvents.shift();
    }
  }

  // IBKR 信息类代码:行情农场连接状态等,与订单成败无关
  private static readonly IB_INFO_MIN = 2100;
  private static readonly IB_INFO_MAX = 2200;
  /** 订单级"警告"码:IBKR 只是附一句话,订单仍然有效——399 委托单消息、404 股票待借入(订单挂起)。
   *  2026-09-08 模拟盘实测:收到 399「为了不与相关挂单交叉,您的委托单被拒」的卖单照样成交了;
   *  当成拒单会让记录停在 ibkr_error、后面的成交回报接不上。 */
  private static readonly IB_WARNING_CODES: ReadonlySet<number> = new Set([399, 404]);
  /**
   * 行情订阅的错误码,永远不属于某一张订单。
   *
   * IB 的订单 id 与请求 id 共用一个计数器,而 `errorEvent` 只给 reqId。行情订阅被拒(没权限、
   * 别处登录占着实时行情)时这里会收到一条 reqId > 0 的错误,配不上任何记录就被存进
   * `earlyOrderErrors` 留 60 秒——这 60 秒里发出去的单只要 id 撞上,就会被判成 ibkr_error 终态。
   * 异动监控每 60 秒重订一次被拒的流(最多 30 只),撞上的概率不再是理论值(2026-09-12 审出)。
   */
  private static readonly IB_MARKET_DATA_CODES: ReadonlySet<number> = new Set([
    101, 300, 309, 316, 317, 322, 354, 10089, 10090, 10091, 10167, 10168, 10185, 10197,
  ]);

  /** 订单级 errorEvent → 终态落库(110 价格档位、201 保证金、203 无权限只走这条路)。 */
  onIbError(reqId: unknown, errorCode: unknown, errorString: unknown): void {
    const code = Math.trunc(Number(errorCode));
    const req = Math.trunc(Number(reqId));
    if (!Number.isFinite(code) || !Number.isFinite(req)) return;
    if (req <= 0) return; // 系统级消息,与具体订单无关
    if (IbCallbacks.IB_MARKET_DATA_CODES.has(code)) return; // 行情订阅的错误,不是订单的
    const message = String(errorString ?? "");
    const informational = code >= IbCallbacks.IB_INFO_MIN && code < IbCallbacks.IB_INFO_MAX;
    const recordId = this.orderIndex.get(req);
    if (recordId === undefined) {
      // 错误比 placeOrder 返回还早:先记下,挂单登记完再对上(见 placeHostedOne)
      if (!informational && !IbCallbacks.IB_WARNING_CODES.has(code)) {
        this.earlyOrderErrors.set(req, [code, message, Date.now()]);
        for (const [id, [, , at]] of this.earlyOrderErrors) {
          if (Date.now() - at > 60_000) this.earlyOrderErrors.delete(id);
        }
      }
      return;
    }
    if (informational || IbCallbacks.IB_WARNING_CODES.has(code)) {
      this.store.appendEvent(recordId, "warning", { message: `IBKR ${code}: ${message}` });
      if (!informational) this.notifier.warning(`IBKR ${code}: ${message}`);
      return;
    }
    const final = code === 202 ? "cancelled" : "ibkr_error";
    this.hostedOrders.handleError(req, code, message);
    if (this.closeChaseIndex.has(req)) {
      // 追价中的平仓单被拒 / 被撤:不再追,持仓可能还在,和撤单回报走同一条路提醒
      this.closeChaseOnStatus({ order: { orderId: req }, orderStatus: { status: code === 202 ? "Cancelled" : "Inactive" } });
    }
    this.store.appendEvent(recordId, "status", { status: "Error", code, message });
    if (!this.finalized.has(recordId)) {
      this.finalized.add(recordId);
      this.store.setFinalStatus(recordId, final, `IBKR ${code}: ${message}`);
    }
    if (final === "ibkr_error") {
      this.notifier.rejection("IBKR_ERROR", `IBKR ${code}: ${message}`);
    }
  }

  private recordFor(trade: any): string | null {
    for (const key of [trade?.order?.permId, trade?.order?.orderId]) {
      if (key && this.orderIndex.has(Number(key))) return this.orderIndex.get(Number(key))!;
    }
    return null;
  }

  onOrderStatus(trade: any): void {
    this.hostedOrders.onStatus(trade);
    this.closeChaseOnStatus(trade);
    const recordId = this.recordFor(trade);
    if (!recordId) {
      this.stashUnmatched("status", trade);
      return;
    }
    const status = String(trade?.orderStatus?.status ?? "");
    this.store.appendEvent(recordId, "status", {
      status,
      filled: trade?.orderStatus?.filled ?? null,
      remaining: trade?.orderStatus?.remaining ?? null,
    });
    let final = IbCallbacks.TERMINAL_IB_STATUS[status];
    if (final === "filled" && trade?.orderStatus?.remaining) final = "partially_filled";
    if (final && !this.finalized.has(recordId)) {
      this.finalized.add(recordId);
      this.store.setFinalStatus(recordId, final);
    }
  }

  onExecDetails(trade: any, fill: any): void {
    const recordId = this.recordFor(trade);
    if (!recordId) {
      this.stashUnmatched("exec", trade, fill);
      return;
    }
    const execution = fill?.execution;
    if (!execution) return;
    // 同一 exec_id 只落一次、只通知一次。交易分析同步成交(reqExecutions)时 TWS 会把当天的成交整批
    // 重推;ibSession 那道闸会话一重建就是空的,拦不住,这里兜底。没有 exec_id 的认不出是不是同一笔,照旧。
    const execId = String(execution.execId ?? "");
    if (execId && this.seenFills.has(execId)) return;
    // 这笔成交自己的合约:组合单 IBKR 会回 1 条 BAG 行 + 每条腿各一行,同一个 permId,
    // 只能靠 secType 分开(store 折叠均价时只认 BAG 行)。只取 fill.contract——
    // trade.contract 在 ib_insync 口径下是订单的合约,拿它兜底会把腿全标成 BAG。
    const contract = fill?.contract ?? {};
    this.store.appendEvent(recordId, "fill", {
      exec_id: execution.execId ?? "",
      time: String(execution.time ?? ""),
      price: Number(execution.price ?? 0) || 0,
      qty: Number(execution.shares ?? 0) || 0,
      commission: 0.0,
      sec_type: String(contract.secType ?? "") || null,
      con_id: Math.trunc(Number(contract.conId ?? 0)) || null,
    });
    if (execId) this.seenFills.add(execId);
    // live=false:reqExecutions 补回来的(断线期间成交、实时回报没收到)。只补录不通知——点开交易分析
    // 才冒出一条「成交回报」只会让人以为又成交了一笔;与 ib_insync 只给实时成交发 execDetailsEvent 同口径。
    if (fill?.live === false) return;
    this.notifier.fill(
      trade?.contract?.symbol ?? "?",
      execution.side ?? "?",
      Number(execution.shares ?? 0) || 0,
      Number(execution.price ?? 0) || 0,
      redactAccount(execution.acctNumber ?? ""),
    );
  }

  onCommission(trade: any, _fill: any, report: any): void {
    const recordId = this.recordFor(trade);
    if (!recordId) {
      this.stashUnmatched("commission", trade, _fill, report);
      return;
    }
    // 佣金回报跟着成交一起被重推,同样按 exec_id 只落第一条(手续费、已实现盈亏才不会翻倍)
    const execId = String(report?.execId ?? "");
    if (execId && this.seenCommissions.has(execId)) return;
    this.store.appendEvent(recordId, "commission", {
      exec_id: report?.execId ?? "",
      commission: Number(report?.commission ?? 0) || 0,
      realized_pnl: report?.realizedPNL ?? null,
    });
    if (execId) this.seenCommissions.add(execId);
  }
}
