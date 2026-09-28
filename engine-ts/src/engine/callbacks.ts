/** 券商回报 → 落库(§6 status_timeline / fills)。
 *
 * 2026-09-20 从 engine.ts 搬出来(函数体逐字未改)。搬的是**回报进来之后怎么落库**;
 * 怎么把回调挂上去(wireSession / attachListeners)、以及下单侧要用的 indexPlacement / brokerCode 留在 engine.ts。
 *
 * 两条纪律写在代码里:成交与佣金按 exec_id 只落第一条(券商会重推,翻倍就是账不平);
 * 认不出记录的回报先攒着(unmatchedEvents),等 orderIndex 建好再重放——直接丢就是「快速成交永远停在 Submitted」。
 * 第三条(2026-09-27):错误通道上的一条错误只带 reqId,宣判一张单之前先问清它是不是冲这张单来的(见 onIbError)。
 */
import type { Notifier } from "../notify.js";
import { redactAccount, type TradeStore } from "../store.js";

/** 托管单那一路,错误与状态回报都要先过它一手(整块在 engine/hosted.ts)。
 *  这里只写回报用得着的那两只手,不引 HostedOrders 本身——两块互不认识。 */
export interface CallbackHostedOrders {
  handleError(orderId: number, code: number, message: string): boolean;
  onStatus(trade: any): void;
}

/** 本会话自己对一张单发出去的最近一个动作(见 CallbackHost.sentOrders)。 */
export interface SentOrder {
  /** 发出的时刻(毫秒) */
  at: number;
  kind: "place" | "modify" | "cancel";
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
  /** 追价平仓单的改价被拒:把追价缓存里的限价恢复成上一次被券商接受的那一版(可选;没实现就只提醒)。 */
  closeChaseModifyRejected?(orderId: number): void;
  /**
   * 本会话自己发出过的订单:orderId → 最近一次下单 / 改单 / 撤单。错误通道只带 reqId,而行情、历史数据、
   * 合约查询的请求号和订单号在同一条数轴上(IBApiNext 的请求号从 1 数起),光凭"orderIndex 里有这个号"
   * 分不清这条错误冲着谁来。有了这本账,只有本会话真发过的号才能被一条错误宣判;没发过的(上个会话留下、
   * 对账认领回来的)只记警告。宿主还没接这本账(undefined)时按旧口径:认得出记录就算。
   */
  readonly sentOrders?: ReadonlyMap<number, SentOrder>;
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
  /**
   * 只会来自数据请求的错误码:历史 K 线 / 逐笔(162 165 166 366 10187 10314)、实时 bar(420 10225)、
   * 实时更新断开(10182)、延迟行情也没有(10186)、基本面(430)。
   *
   * 和行情订阅同一个道理,但这些以前没进上面那张表,于是配得上记录时直接落终态:K 线、价位提醒、交易分析
   * 都在拉历史数据,IBKR 15 秒内同样的请求算超频(162)。2026-09-27 审出:一条 162 与一张活着的托管止盈单
   * 同号,那张单被判成"被拒"——缓存摘掉、记录落 ibkr_error、60 秒后又挂一张,原来那张还在券商那边挂着,
   * 从此没人改价、也没人撤。
   */
  private static readonly IB_DATA_REQUEST_CODES: ReadonlySet<number> = new Set([
    162, 165, 166, 366, 420, 430, 10182, 10186, 10187, 10225, 10314,
  ]);
  /**
   * 两边都会报的码:200 查不到合约、321 请求校验不过。合约确认 / 期权链 / 交易时段这些查询天天报 200;
   * 订单上只在合约失效、TWS 开着「API 只读」这类时候才见到。所以只有本会话**刚**对这个号发过单
   * (AMBIGUOUS_WINDOW_MS 内,见 CallbackHost.sentOrders)才当成订单的错误;宿主没接发单账本时一律不宣判。
   */
  private static readonly IB_AMBIGUOUS_CODES: ReadonlySet<number> = new Set([200, 321]);
  // IBKR 对一张单的校验错误(查不到合约、请求不合法)在一秒内就回;窗口开得越宽,撞号的数据请求错误就越容易被当成订单被拒
  private static readonly AMBIGUOUS_WINDOW_MS = 10_000;
  /**
   * 券商回绝的只是我们这一下改单 / 撤单,理由是这张单已经走完了:104 已成交不能改、161 不在可撤状态、
   * 10148 撤不掉(已成交 / 已撤)。单子的去向由状态回报定——错误先到、落了 ibkr_error,紧跟着的 Filled
   * 就再也落不上去(finalized 只认第一次)。
   */
  private static readonly IB_REFUSED_ONLY_CODES: ReadonlySet<number> = new Set([104, 161, 10148]);
  /** 追价平仓单改价被拒的提醒:同一张单一分钟最多一次。追价每秒改一次价,被拒也可能每秒来一条。 */
  private static readonly CHASE_REFUSAL_NOTIFY_MS = 60_000;
  private readonly chaseRefusalNotifiedAt = new Map<number, number>();

  /** 订单级 errorEvent → 终态落库(110 价格档位、201 保证金、203 无权限只走这条路)。
   *
   * 错误通道只带一个 reqId,它可能是订单号,也可能是撞了号的某个数据请求。所以一条错误要宣判一张单,
   * 得先过三道:错误码可能属于订单(mayConcernOrder)、这张单是本会话发的(sentOrders)、它回绝的不只是
   * 我们刚才那一下改单 / 撤单(refusesRequestOnly)。过不了的只在记录上留一句话,不落终态——终态不可逆,
   * 判错了后面的成交回报全接不上;而单子真没了,状态回报与对账都还会说。 */
  onIbError(reqId: unknown, errorCode: unknown, errorString: unknown): void {
    const code = Math.trunc(Number(errorCode));
    const req = Math.trunc(Number(reqId));
    if (!Number.isFinite(code) || !Number.isFinite(req)) return;
    if (req <= 0) return; // 系统级消息,与具体订单无关
    if (IbCallbacks.IB_MARKET_DATA_CODES.has(code)) return; // 行情订阅的错误,不是订单的
    const message = String(errorString ?? "");
    const informational = code >= IbCallbacks.IB_INFO_MIN && code < IbCallbacks.IB_INFO_MAX;
    const recordId = this.orderIndex.get(req);
    if (!this.mayConcernOrder(req, code)) {
      // 撞了号的数据请求:同号的那张单(若有)什么事都没有。留一句话备查;不宣判,也不留给下一张同号的单
      if (recordId !== undefined) {
        this.store.appendEvent(recordId, "warning", {
          message: `IBKR ${code}: ${message}(同号的数据请求报的错,与这张单无关,不作终态)`,
        });
      }
      return;
    }
    if (recordId === undefined) {
      if (informational || IbCallbacks.IB_WARNING_CODES.has(code)) return;
      if (this.sentRecently(req)) {
        // 没有记录、可我们刚改过 / 撤过它:重启后认领回来的托管单。改价被拒要交给托管那一路,
        // 它分得清是改价被拒(原单原价还在)还是单子没了——以前这条只会进 earlyOrderErrors 然后过期
        this.hostedOrders.handleError(req, code, message);
        return;
      }
      // 错误比 placeOrder 返回还早:先记下,挂单登记完再对上(见 placeHostedOne)
      this.earlyOrderErrors.set(req, [code, message, Date.now()]);
      for (const [id, [, , at]] of this.earlyOrderErrors) {
        if (Date.now() - at > 60_000) this.earlyOrderErrors.delete(id);
      }
      return;
    }
    if (informational || IbCallbacks.IB_WARNING_CODES.has(code)) {
      this.store.appendEvent(recordId, "warning", { message: `IBKR ${code}: ${message}` });
      if (!informational) this.notifier.warning(`IBKR ${code}: ${message}`);
      return;
    }
    const sent = this.host.sentOrders;
    if (sent !== undefined && !sent.has(req)) {
      // 不是本会话发出去的单(上个会话留下、对账认领回来的):这条错误未必冲它来,更不是在回我们哪一下。
      // 只记一句话、提醒一声;它真没了,状态回报与对账会说
      this.store.appendEvent(recordId, "warning", {
        message: `IBKR ${code}: ${message}(这张单不是本会话发出的,不作终态)`,
      });
      this.notifier.warning(`IBKR ${code}: ${message}`);
      return;
    }
    if (this.refusesRequestOnly(recordId, code)) {
      // 回绝的只是刚才那一下改单 / 撤单:原单还按上一次被接受的价挂着(或已经成交,等状态回报)。
      // 托管那一路自己会把缓存恢复成上一版、退避;追价平仓单不摘、下一轮接着追;记录不落终态
      this.hostedOrders.handleError(req, code, message);
      this.store.appendEvent(recordId, "warning", {
        message: `IBKR ${code}: ${message}(改单 / 撤单被拒,原单仍在,不作终态)`,
      });
      if (this.closeChaseIndex.has(req)) {
        this.host.closeChaseModifyRejected?.(req);
        this.warnChaseRefused(req, code, message);
      }
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

  /** 这个错误码可能是冲着一张订单来的吗(见 IB_DATA_REQUEST_CODES / IB_AMBIGUOUS_CODES)。 */
  private mayConcernOrder(req: number, code: number): boolean {
    if (IbCallbacks.IB_DATA_REQUEST_CODES.has(code)) return false;
    if (IbCallbacks.IB_AMBIGUOUS_CODES.has(code)) return this.sentRecently(req);
    return true;
  }

  /** 本会话在 AMBIGUOUS_WINDOW_MS 之内对这个号发过单 / 改单 / 撤单。宿主没接发单账本 → false。 */
  private sentRecently(req: number): boolean {
    const sent = this.host.sentOrders?.get(req);
    return sent !== undefined && Date.now() - sent.at <= IbCallbacks.AMBIGUOUS_WINDOW_MS;
  }

  /**
   * 这条错误回绝的只是我们刚才那一下改单 / 撤单,单子本身还在(或去向由状态回报定)。
   *
   * 证据只看这张单自己的时间线:最后一条状态是我们写的 Adjusted(改价发出去了、券商还没回话),这时来的错误
   * 就是在回这一下改价。IBKR 改价被拒时原单原价照挂——托管那一路一直是这么处理的(hosted.onError),
   * 追价平仓那张单以前却当成"单子没了":不追了、落终态、提醒"已失效",用户照着再手动平一次,两张一起成交
   * 就是反向开仓(2026-09-27 审出)。202 已撤、135 找不到这张单:单子确实不在了,不算。
   */
  private refusesRequestOnly(recordId: string, code: number): boolean {
    if (code === 202 || code === 135) return false;
    if (IbCallbacks.IB_REFUSED_ONLY_CODES.has(code)) return true;
    const timeline: unknown = this.store.getRecord(recordId)?.["ibkr"]?.["status_timeline"];
    if (!Array.isArray(timeline) || !timeline.length) return false;
    const last: unknown = timeline[timeline.length - 1];
    return typeof last === "object" && last !== null && (last as { status?: unknown }).status === "Adjusted";
  }

  /** 追价平仓单改价被拒:说清楚单子还在、还在追(同一张单一分钟最多提醒一次)。 */
  private warnChaseRefused(orderId: number, code: number, message: string): void {
    const now = Date.now();
    const last = this.chaseRefusalNotifiedAt.get(orderId);
    if (last !== undefined && now - last < IbCallbacks.CHASE_REFUSAL_NOTIFY_MS) return;
    this.chaseRefusalNotifiedAt.set(orderId, now);
    this.notifier.warning(
      `追价平仓单改价被券商拒绝(IBKR ${code}: ${message}),原单仍按上一次被接受的价挂着,下一轮按最新买卖价接着改。`,
    );
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
