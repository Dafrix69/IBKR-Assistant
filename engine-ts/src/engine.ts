/** 编排:输入 → 解析 → 硬校验 → 下单 → 落库 → 通知(对应 Python engine.py,§1)。
 *
 * 顺序是有意的:任何一步失败都必须在"发单"之前结束。下单只在最后一步发生,
 * 且要同时满足:校验通过、熔断未触发、auto_execute=true、账户允许。
 */
import type { AccountConfig, EtNow, Settings } from "./config.js";
import { hoursStatus, nowEt } from "./config.js";
import type { PositionRow } from "./contract/positions.js";
import type {
  InstructionLlm, InstructionOrder, InstructionRejection, OrderTicket,
} from "./contract/instruction.js";
import type { TrackerHeartbeat } from "./contract/system.js";
import type { TrackFired, TrackerPollTick, TrackerSyncHostedTick } from "./contract/trackerloop.js";
import {
  BrokerError, PendingTrigger, PlacementResult, autoMidLimit, comboMidPrice, shouldFire,
  strikeWidth,
} from "./broker.js";
import { KillSwitch } from "./killswitch.js";
import { LLMError, LLMResponse } from "./providers.js";
import { extractSymbols } from "./market.js";
import type { ParsedOrder, Rejection } from "./models.js";
import { multiplierValue, parseLlmPayload } from "./models.js";
import { LOCAL_MODEL, looksLikeShorthand, shorthandSymbols, tryParseShorthand } from "./shorthand.js";
import { publicIndexPrice } from "./macro.js";
import { fingerprint as promptFingerprint } from "./prompts.js";
import { Notifier } from "./notify.js";
import type { PromptBundle } from "./prompts.js";
import { fingerprint, loadPromptBundle, renderUser } from "./prompts.js";
import {
  NO_PROTECTION, evaluateProtections, needsPnlEvents, protectionBlock, protectionsEnabled, protectionsSince,
} from "./protections.js";
import type { ProtectionState } from "./protections.js";
import { TradeStore, redactAccount } from "./store.js";
import { nowIsoSecondsEt } from "./engine/clock.js";
import { HostedOrders } from "./engine/hosted.js";
import { IbCallbacks } from "./engine/callbacks.js";
import { Reconciler } from "./engine/reconcile.js";
import * as tk from "./tracker.js";
import type { ApprovedOrder, RejectedOrder } from "./validator.js";
import { EXTENDED_STATUSES, Validator, primaryCode, rejectionMessage } from "./validator.js";
import { finiteOrNull, fmtF, pyG, pyRound } from "./py.js";
import * as path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

type Rec = Record<string, any>;

export interface EngineResult {
  submitted: InstructionOrder[];
  queued: InstructionOrder[];
  validated_only: InstructionOrder[];
  rejections: InstructionRejection[];
  warnings: string[];
  llm: InstructionLlm | null;
}

const emptyResult = (): EngineResult => ({
  submitted: [], queued: [], validated_only: [], rejections: [], warnings: [], llm: null,
});

/** 引擎依赖的解析器面(providers 的 parse 即符合)。 */
export interface ParserLike {
  parse(bundle: PromptBundle, userMessage: string): Promise<LLMResponse>;
}

/** 引擎依赖的 router 面(BrokerRouter / FutuRouter 都符合;测试注入假实现)。 */
export interface RouterLike {
  BROKER?: string;
  SUPPORTS_NATIVE_CONDITIONS?: boolean;
  sessionHook?: unknown;
  indexPrice(symbol: string): Promise<number | null>;
  /** 最近一次 indexPrice 的来源(官方指数 / 期货推算);没有就是 null。 */
  spotInfo?(symbol: string): Rec | null;
  legQuotes(contract: any, account: AccountConfig): Promise<any[]>;
  place(recordId: string, approved: ApprovedOrder, limitOverride?: number | null): Promise<PlacementResult>;
  positions(): Promise<Rec[]>;
  cancelAllOpen(): Promise<number>;
  sessions(): unknown[];
  quoteCapability?(symbol: string): string | null;
  pollOrderUpdates?(): Promise<Array<[string, any, any]>>;
  /** 券商托管的止盈/止损(仅 IBKR 的 router 有;富途没有可同形托管的 GTC+OCA)。 */
  SUPPORTS_HOSTED_CLOSE?: boolean;
  placeHosted?(
    account: AccountConfig, contractSpec: any, item: tk.HostedOrderPlan,
    ocaGroup: string, orderRef: string,
  ): Promise<{ order_id: number | null; perm_id: number | null; status: string }>;
  modifyHosted?(orderId: number, item: tk.HostedOrderPlan): Promise<boolean>;
  cancelHosted?(orderId: number): Promise<boolean>;
  listHostedOpen?(refPrefix?: string): Promise<Rec[]>;
  /** 持仓期权腿此刻的买卖价(按持仓 key),算「立刻成交价」用;常驻订阅,每秒调得起。 */
  optionQuotes?(rows: Rec[]): Promise<Record<string, { bid: number | null; ask: number | null }>>;
}

/**
 * 把界面/命令行传来的账户别名列表清洗成去重后的有效别名。
 * 别名表外的名字直接抛错——这是用户勾选出来的,不该静默丢掉;RPC 层会把它变成 -32602。
 */
export function resolveFanoutAccounts(settings: Settings, accounts?: string[] | null): string[] {
  if (!accounts || !accounts.length) return [];
  const seen: string[] = [];
  for (const raw of accounts) {
    const alias = String(raw).trim();
    if (!alias || seen.includes(alias)) continue;
    if (alias === "DEFAULT" || settings.accountByAlias(alias) === null) {
      throw new Error(
        `账户别名 '${alias}' 不在别名表中(可用:${settings.aliasList().join("、") || "(未配置)"})。`,
      );
    }
    seen.push(alias);
  }
  return seen;
}

/**
 * 按勾选账户复制未指定账户的订单;返回 [新订单列表, 给用户看的说明或 null]。
 * - 勾了 1 个账户:DEFAULT 订单改指向它(相当于"这次默认发到这个账户")。
 * - 勾了 N 个账户:DEFAULT 订单变 N 份,顺序为 账户1 的所有订单、账户2 的所有订单……
 *   重复防抖的指纹含账户别名,同一笔订单发到两个账户不会被互相当成重复。
 * - 指令里明确写了账户别名的订单原样保留,不复制:用户说了算。
 */
export function fanOutOrders(
  orders: ParsedOrder[], accounts: string[],
): [ParsedOrder[], string | null] {
  if (!accounts.length) return [[...orders], null];
  const defaults = orders.filter((o) => o.account === "DEFAULT");
  const explicit = orders.filter((o) => o.account !== "DEFAULT");
  const expanded: ParsedOrder[] = [];
  for (const alias of accounts) {
    for (const order of defaults) expanded.push({ ...order, account: alias });
  }
  expanded.push(...explicit);
  if (accounts.length === 1 || !defaults.length) return [expanded, null];
  const note =
    `已按勾选账户同时发单:${accounts.join("、")}(每笔订单各 ${accounts.length} 份,各自独立校验与记录)`;
  return [expanded, note];
}

/** 一笔已通过校验的订单压成界面能直接画的样子(方向 / 数量 / 价 / 合约要素 / 各腿 / 触发条件)。 */
export function orderTicket(parsed: ParsedOrder): OrderTicket {
  const c = parsed.contract;
  const o = parsed.order;
  return {
    sec_type: c.secType,
    symbol: c.symbol,
    action: o.action,
    quantity: o.totalQuantity,
    order_type: o.orderType,
    price_mode: o.price_mode,
    limit_price: o.lmtPrice,
    aux_price: o.auxPrice,
    trailing_percent: o.trailingPercent,
    tif: o.tif,
    expiry: c.lastTradeDateOrContractMonth ?? c.legs?.[0]?.lastTradeDateOrContractMonth ?? null,
    strike: c.strike,
    right: c.right,
    multiplier: multiplierValue(c),
    combo_strategy: c.combo_strategy,
    legs: (c.legs ?? []).map((leg) => ({ action: leg.action, ratio: leg.ratio, strike: leg.strike, right: leg.right })),
    trigger: parsed.trigger
      ? { symbol: parsed.trigger.symbol, operator: parsed.trigger.operator, value: parsed.trigger.value }
      : null,
  };
}

export class TradingEngine {
  settings: Settings;
  readonly parser: ParserLike;
  readonly store: TradeStore;
  readonly notifier: Notifier;
  readonly killswitch: KillSwitch;
  router: RouterLike | null;
  readonly bundle: PromptBundle;
  pendingTriggers: PendingTrigger[] = [];
  // 券商 orderId / permId → 记录 id,回报进来才知道该往哪条记录上追加
  /** 券商 orderId / permId → 记录 id。托管单那一块也要读它(见 engine/hosted.ts 的 HostedHost) */
  readonly orderIndex = new Map<number, string>();
  /** 已经落过终态的记录 id。对账那一块也要读它(见 engine/reconcile.ts 的 ReconcileHost) */
  readonly finalized = new Set<string>();
  // 竞态缓冲:placeOrder 后、_index_placement 前,回报可能已经推过来。
  // 先攒着,建好映射再重放——直接丢就是"快速成交永远停在 Submitted"。
  // 不加 private:回报落库整块在 engine/callbacks.ts,这几样是它和引擎共用的账(CallbackHost)。
  readonly unmatchedEvents: Array<[string, any, any, any]> = [];
  /** 已落库的成交 / 佣金 exec_id(见 onExecDetails)。只放内存就够:orderIndex 也只在本进程里建,
   * 重启后旧单的回报本来就对不上记录、不会落库。 */
  readonly seenFills = new Set<string>();
  readonly seenCommissions = new Set<string>();
  /** 券商托管单的对账缓存:track_id → {kind: 托管单信息};orderId → [track_id, kind]。
   * 真相永远在券商那边——重启后由 adoptHosted() 按 orderRef 认领重建。 */
  /** 券商托管的止盈/止损单(整块在 engine/hosted.ts);它自己管 hosted / hostedIndex 那几样状态。
   *  不加 private:engine/callbacks.ts 落库前要先让它过一手(CallbackHost)。 */
  readonly hostedOrders = new HostedOrders(this);
  /** 执行对账(整块在 engine/reconcile.ts) */
  private readonly reconciler = new Reconciler(this);
  /** 券商回报 → 落库(整块在 engine/callbacks.ts) */
  private readonly callbacks = new IbCallbacks(this);
  /** 「标的目标价」上一轮算出来的预计价位:track_id → 每股/每张/每组净价。
   * 某一轮拿不到标的现价或蝶价时沿用它,而不是把目标价当成"没设"——那会让
   * syncHosted 把已经挂在券商侧的限价单撤掉,一次行情抖动就丢掉保护。
   * 不落库:重启后托管单本身由 adoptHosted 按 orderRef 认领回来,价格就在单子上。 */
  private readonly flyMark = new Map<string, number>();

  /** 比 placeOrder 返回还早到的订单错误:orderId → [错误码, 原文, 时刻]。挂单登记完再对上,
   * 否则那条错误落不到任何人头上,缓存里就一直当这张单在站岗。 */
  readonly earlyOrderErrors = new Map<number, [number, string, number]>();
  /** 没开托管、到价自动平仓发出去的那张限价单,发出后照样追价(见 chaseCloseOrder):
   * track_id → {order_id, record_id, action, quantity, label, rounds, limit};orderId → track_id。
   * 成交 / 撤销 / 被拒都从这里摘掉。重启后按记录 id(= orderRef)认领回来(adoptCloseChase)。 */
  private readonly closeChase = new Map<string, Rec>();
  /** 不加 private:engine/callbacks.ts 要看一眼被拒的单在不在追价中(CallbackHost) */
  readonly closeChaseIndex = new Map<number, string>();
  private closeChaseAdopted = false;
  /** 速记解析的公开源现价注入点(测试替身用;null = macro.publicIndexPrice)。 */
  publicPriceFn: ((symbol: string) => Promise<number | null>) | null = null;
  /** 最近一次解析预热的句柄(仅测试等待用;业务代码永不 await 它)。 */
  prewarmPromise: Promise<void> | null = null;

  /** 解析预热:validated-only 的合约后台 qualify 一遍,发单那一下零往返。 */
  private prewarm(approved: ApprovedOrder): void {
    const router = this.router as
      | (RouterLike & { qualify?: (contract: unknown, account: unknown) => Promise<unknown> })
      | null;
    if (!router || typeof router.qualify !== "function") return;
    this.prewarmPromise = (async () => {
      try {
        await router.qualify!(approved.order.contract, approved.account);
      } catch {
        /* 预热失败无害:发送时会正式再走一遍并给出真实报错 */
      }
    })();
  }

  constructor(args: {
    settings: Settings;
    parser: ParserLike;
    store?: TradeStore;
    notifier?: Notifier;
    killswitch?: KillSwitch;
    router?: RouterLike | null;
    bundle?: PromptBundle;
  }) {
    this.settings = args.settings;
    this.parser = args.parser;
    this.store = args.store ?? new TradeStore(args.settings.db_path);
    this.notifier = args.notifier ?? new Notifier();
    this.killswitch =
      args.killswitch ??
      new KillSwitch(
        path.join(path.dirname(args.settings.db_path), "breaker.json"),
        args.settings.policies.consecutive_failure_breaker,
      );
    this.router = args.router ?? null;
    this.bundle = args.bundle ?? loadPromptBundle(args.settings);
  }

  // ------------------------------------------------------------------
  /**
   * 解析一条指令并走完校验/执行。
   *
   * `accounts` 是用户在界面上勾选的目标账户别名。给了就把模型没有指定账户
   * (account="DEFAULT")的订单按别名逐个复制——勾两个账户,每笔订单就变成两笔,
   * 各自独立走校验、落库、下单;指令里明确点名账户的订单不受影响。
   * 不给或为空维持原行为(DEFAULT → 默认账户)。
   */
  async handleInstruction(
    instruction: string,
    channel = "manual",
    moment?: EtNow | null,
    snapshot?: Record<string, number> | null,
    accounts?: string[] | null,
    /** 只解析、只校验,不发单。**不许**靠临时改 settings.policies.auto_execute 来实现:那是全引擎
     * 共享的配置,盯盘节拍器同一时刻在读——解析那一两秒里它看到"自动执行已关闭",会把所有托管单
     * 撤掉,解析完又重挂一遍(2026-09-10 真机,节拍器挪进引擎后才暴露)。 */
    dryRun = false,
  ): Promise<EngineResult> {
    const result = emptyResult();
    const at = moment ?? nowEt();
    const targets = resolveFanoutAccounts(this.settings, accounts);

    const breaker = this.killswitch.state();
    if (breaker.engaged) {
      const message = `自动执行已熔断(${breaker.reason}),本条指令未解析。请在软件里手动解除后重试。`;
      this.notifier.breaker(message);
      result.warnings.push(message);
      return result;
    }

    let snap: Record<string, number> = { ...(snapshot ?? {}) };
    if (this.router !== null) {
      const symbols = extractSymbols(instruction, this.settings);
      snap = await buildSnapshotAsync(symbols, this.router, snap);
    }

    // 本地速记优先:用户的固定行话(如「1.8 挂15蝴蝶 15CM」)不必等大模型,
    // 微秒级出与 LLM 同形的 payload,走完全相同的校验与执行路径。
    // 本地解析抛任何异常都静默回落到 LLM——快是锦上添花,不能成为新的故障点。
    let localPayload: Rec | null = null;
    let shorthandNote: string | null = null;
    try {
      if (looksLikeShorthand(instruction)) {
        // 没连券商时快照里没有现价,「15蝴蝶」的中心算不出来——
        // 用宏观行情带同款公开源兜底(^GSPC 就是 SPX 本尊,分钟级延迟)。
        const fetchSpot = this.publicPriceFn ?? publicIndexPrice;
        for (const sym of shorthandSymbols(instruction)) {
          // 「50蝴蝶」没写标的,上面的快照抽不到 SPX:先问券商(夜盘走期货推算),拿不到才退公开源。
          // 以前直接退公开源——那也是指数本身,夜盘一样是昨收,拿它推断看涨看跌会翻转
          // (2026-09-10 02:40 真机:昨收 7636.36 推成看涨,ES 推算的真实现价 7658 该是看跌)。
          if ((snap[sym] === undefined || snap[sym] === null) && this.router !== null) {
            try {
              const price = await this.router.indexPrice(sym);
              if (price !== null) snap[sym] = price;
            } catch {
              /* 券商取价失败:照旧退公开源 */
            }
          }
          if (snap[sym] === undefined || snap[sym] === null) {
            const price = await fetchSpot(sym);
            if (price !== null) {
              snap[sym] = price;
              shorthandNote = "现价来自公开数据源(可能延迟数分钟),请核对中心行权价与方向";
            }
          }
          // 现价不是官方指数实时价时要说出来:推算的写明怎么推的,昨收的明说是昨收
          const info = this.router?.spotInfo?.(sym) ?? null;
          if (!shorthandNote && info?.["source"] === "futures") {
            shorthandNote = `现价 ${pyRound(Number(info["price"]), 2)}:${String(info["note"])}`;
          } else if (!shorthandNote && info?.["source"] === "index_stale") {
            shorthandNote = `${String(info["note"])}——请核对中心行权价与看涨看跌`;
          }
        }
      }
      localPayload = tryParseShorthand(instruction, snap, at);
      if (localPayload !== null && shorthandNote) {
        for (const item of localPayload["orders"] as Rec[]) {
          (item["warnings"] as string[]).push(shorthandNote);
        }
      }
    } catch {
      localPayload = null;
    }

    if (localPayload === null && looksLikeShorthand(instruction)) {
      // 观测点:哪条蝴蝶写法没被本地语法接住(落到大模型)。
      // 不影响任何行为,只为日后照着真实落网样本扩语法。
      this.store.audit("engine", "shorthand_fallback", { instruction: instruction.slice(0, 120) });
    }

    let response: LLMResponse;
    if (localPayload !== null) {
      response = new LLMResponse(
        JSON.stringify(localPayload), LOCAL_MODEL,
        this.bundle.version, promptFingerprint(this.bundle), 0, {}, "none",
      );
    } else {
      const userMessage = renderUser(this.bundle, this.settings, instruction, at, null, snap);
      try {
        response = await this.parser.parse(this.bundle, userMessage);
      } catch (exc) {
        if (!(exc instanceof LLMError)) throw exc;
      // 调用失败 = 这条指令被拒了,不是"提示"
        this.killswitch.recordFailure(exc.message, "parse");
        this.notifier.rejection("LLM_ERROR", exc.message);
        this.store.audit("engine", "llm_error", { instruction, error: exc.message });
        result.rejections.push({
          source: "engine", code: "LLM_ERROR", message: exc.message, original_text: instruction,
        });
        return result;
      }
    }

    result.llm = {
      model: response.model,
      prompt_version: response.prompt_version,
      prompt_fingerprint: response.prompt_fingerprint,
      latency_ms: response.latency_ms,
      usage: response.usage,
    };

    let parsed: ReturnType<typeof parseLlmPayload>;
    try {
      parsed = parseLlmPayload(response.payload());
    } catch (exc) {
      const message = (exc as Error).message;
      this.killswitch.recordFailure(message, "parse");
      this.notifier.rejection("BAD_PAYLOAD", message);
      this.store.audit("engine", "bad_payload", { error: message, raw: response.text.slice(0, 2000) });
      result.rejections.push({
        source: "engine", code: "BAD_PAYLOAD", message, original_text: instruction,
      });
      return result;
    }

    // 只清"解析失败"计数。券商失败计数必须等真正下单成功才清。
    this.killswitch.recordSuccess("parse");
    result.warnings.push(...parsed.schema_errors);

    // 1. 模型自己拒绝的片段:照样落库,拒绝率是要统计的指标(§11)
    for (const rejection of parsed.rejections) {
      this.recordRejection(instruction, channel, response, rejection, "rejected_by_llm");
      this.notifier.rejection(rejection.code, rejection.message);
      result.rejections.push({
        source: "llm", code: rejection.code, message: rejection.message,
        original_text: rejection.original_text,
      });
    }

    // 2. 软件层硬校验(先按勾选账户扇出:同一笔订单每个账户一份)
    const [orders, fanoutNote] = fanOutOrders(parsed.orders, targets);
    if (fanoutNote) {
      result.warnings.push(fanoutNote);
      this.store.audit("engine", "fanout", {
        accounts: [...targets], orders: parsed.orders.length, expanded: orders.length,
      });
    }
    // 先把期权/组合的合约时段问一遍(按天缓存,一天只有一次网络往返)。
    // 校验链路是同步的,读不到缓存就只能退回正股日历——而首次下单恰恰是缓存空的时候,
    // 那正是"隔夜下单被误告休市"发生的场景。所以在这里预热,而不是指望缓存碰巧有。
    await this.prewarmContractHours(orders);
    const priced = this.autoOutsideRth(orders, at);
    const validator = new Validator(
      this.settings,
      at,
      snap,
      this.store.recentOrders(this.settings.limits.duplicate_window_minutes, at.epochMs),
      (o) => this.orderMarketStatus(o, at),
    );
    const outcome = validator.validateAll(
      priced, this.settings.limits.max_orders_per_input * Math.max(1, targets.length),
    );

    for (const rejected of outcome.rejected) {
      this.recordValidatorRejection(instruction, channel, response, rejected);
      this.notifier.rejection(primaryCode(rejected), rejectionMessage(rejected));
      result.rejections.push({
        source: "validator",
        code: primaryCode(rejected),
        message: rejectionMessage(rejected),
        intent_summary: rejected.order.intent_summary,
      });
    }

    // 3. 通过的订单
    for (const approved of outcome.approved) {
      const recordId = this.recordApproved(instruction, channel, response, approved);
      for (const warning of approved.warnings) {
        this.notifier.warning(warning);
        this.store.appendEvent(recordId, "warning", { message: warning });
      }
      result.warnings.push(...approved.warnings);

      const summary: InstructionOrder = {
        record_id: recordId,
        intent_summary: approved.order.intent_summary,
        account: approved.account.alias,
        notional: pyRound(approved.notional, 2),
        // 界面画订单票据与到期损益图用的结构化摘要:只读展示,不回流到任何决策
        ticket: orderTicket(approved.order),
      };

      if (dryRun || !this.settings.policies.auto_execute) {
        this.store.appendEvent(recordId, "status", { status: "ValidatedOnly" });
        this.notifier.warning(
          dryRun
            ? `已通过校验(只解析,未发送):${approved.order.intent_summary}`
            : `已通过校验但未发送(自动执行未打开):${approved.order.intent_summary}`,
        );
        result.validated_only.push(summary);
        // 解析预热:后台把合约 qualify 一遍填 conId 缓存——用户下一步点
        // 「发送」时组合腿零往返。失败无害(发送时会正式再走一遍)。
        this.prewarm(approved);
        continue;
      }

      // 批内熔断:每笔发出前重查一次开关
      const breakerNow = this.killswitch.state();
      if (breakerNow.engaged) {
        this.store.setFinalStatus(recordId, "halted_by_breaker", breakerNow.reason);
        this.notifier.rejection(
          "BREAKER_ENGAGED",
          `熔断已触发,本批剩余订单未提交:${approved.order.intent_summary}`,
        );
        result.rejections.push({
          source: "engine", code: "BREAKER_ENGAGED",
          message: `熔断已触发,订单未提交(${breakerNow.reason})`, record_id: recordId,
        });
        continue;
      }

      // 保护规则:接连止损 / 回撤过大 / 同一标的刚平过仓。挡下的单停在"仅校验未发送",
      // 不落终态——保护期过了原样再发一次就行,不像熔断那样判死。
      const guard = protectionBlock(
        this.protectionState(), String(approved.order.contract.symbol ?? ""), Date.now(),
      );
      if (guard !== null) {
        this.store.appendEvent(recordId, "status", { status: "ValidatedOnly" });
        this.store.appendEvent(recordId, "warning", { message: `保护规则拦下:${guard}` });
        this.store.audit("engine", "protection_blocked", {
          record: recordId, symbol: approved.order.contract.symbol ?? "", reason: guard,
        });
        this.notifier.warning(`保护规则拦下,已通过校验但未发送:${guard}`);
        result.validated_only.push(summary);
        continue;
      }

      try {
        Object.assign(summary, await this.execute(recordId, approved));
      } catch (exc) {
        if (!(exc instanceof BrokerError)) throw exc;
        this.store.setFinalStatus(recordId, "ibkr_error", exc.message);
        const engaged = this.killswitch.recordFailure(exc.message, "broker");
        const code = this.brokerCode();
        this.notifier.rejection(code, exc.message);
        if (engaged) this.notifier.breaker(engaged.reason);
        result.rejections.push({
          source: "broker", code, message: exc.message, record_id: recordId,
        });
        continue;
      }

      if (summary["queued"]) {
        result.queued.push(summary);
      } else {
        // 真正把单发出去了才算"券商成功";仅进入盯盘队列不算。
        this.killswitch.recordSuccess("broker");
        result.submitted.push(summary);
      }
    }
    return result;
  }

  // ------------------------------------------------------------------
  private async execute(recordId: string, approved: ApprovedOrder): Promise<Rec> {
    if (this.router === null) throw new BrokerError("未接入券商连接(router=None),无法下单。");
    const parsed = approved.order;

    // 方式 B:①条件单 + AUTO_MID;②券商没有原生条件单(富途)——必须软件盯盘
    const nativeConditions = this.router.SUPPORTS_NATIVE_CONDITIONS ?? true;
    if (parsed.trigger !== null && (parsed.order.price_mode === "AUTO_MID" || !nativeConditions)) {
      // 进队列之前先问:这个触发标的,券商到底报不报得出价?
      const capability = this.router.quoteCapability;
      const reason = typeof capability === "function"
        ? capability.call(this.router, parsed.trigger.symbol)
        : null;
      if (reason) throw new BrokerError(reason);
      this.pendingTriggers.push({
        record_id: recordId,
        approved,
        trigger: parsed.trigger,
        created_at: localIsoSeconds(),
        fired: false,
      });
      this.store.appendEvent(recordId, "status", { status: "PendingTrigger" });
      this.notifier.warning(
        `已进入盯盘队列:${parsed.intent_summary}(软件必须保持运行,否则条件不会触发)`,
      );
      return { queued: true, mode: "software_watch" };
    }

    // 立即执行的 AUTO_MID 组合:现在就取盘口中间价定限价
    let limitOverride: number | null = null;
    if (parsed.order.price_mode === "AUTO_MID") {
      limitOverride = await this.priceAutoMid(approved);
      const note = approved.account.is_paper
        ? "(纸面账户:无实时期权订阅时按延迟盘口定价,成交价参考性有限)"
        : "";
      this.store.appendEvent(recordId, "warning", {
        message: `AUTO_MID 定价:盘口中间价 ± 滑点上限 → 限价 ${fmtF(limitOverride, 4)}${note}`,
      });
    }

    const placement = await this.router.place(recordId, approved, limitOverride);
    this.indexPlacement(recordId, placement);
    this.store.appendEvent(recordId, "status", {
      status: placement.status,
      order_id: placement.order_id,
      perm_id: placement.perm_id,
    });
    this.notifier.notify(
      "订单已提交", parsed.intent_summary, `账户 ${redactAccount(approved.account.account_id)}`,
    );
    return {
      queued: parsed.trigger !== null,
      mode: parsed.trigger !== null ? "ibkr_condition" : "immediate",
      order_id: placement.order_id,
      status: placement.status,
    };
  }

  /** 由盯盘循环驱动:条件满足就按中间价下单。先落闩再下单——宁可少发,不可重复。 */
  async firePending(prices: Record<string, number>): Promise<Rec[]> {
    const fired: Rec[] = [];
    // 触发时刻的熔断复查:条件单可能在校验后数小时才触发
    const breaker = this.killswitch.state();
    if (breaker.engaged) return fired;
    // 保护规则同理在触发这一刻复查。**排队的单不作废**:保护期内它继续排着,
    // 到点自己就能发——作废一张等了一上午的条件单,比晚发几分钟难受得多。
    const guard = this.protectionState();
    for (const pending of [...this.pendingTriggers]) {
      if (pending.fired) continue;
      const blocked = protectionBlock(
        guard, String(pending.approved.order.contract.symbol ?? ""), Date.now(),
      );
      if (blocked !== null) continue;
      const price = prices[pending.trigger.symbol];
      if (price === undefined || price === null || !shouldFire(pending, Number(price))) continue;
      pending.fired = true; // 先落闩
      let limit: number;
      let placement: PlacementResult;
      try {
        limit = await this.priceAutoMid(pending.approved);
        placement = await this.router!.place(pending.record_id, pending.approved, limit);
      } catch (exc) {
        if (exc instanceof BrokerError) {
          this.store.setFinalStatus(pending.record_id, "ibkr_error", exc.message);
          const engaged = this.killswitch.recordFailure(exc.message, "broker");
          this.notifier.rejection(this.brokerCode(), exc.message);
          if (engaged) {
            this.notifier.breaker(engaged.reason);
            break; // 熔断已挂起:本轮不再触发任何后续条件单
          }
          continue;
        }
        // 连接层/事件循环的意外异常。去哪核对要跟着生效的券商说。
        const where = this.router?.BROKER === "futu" ? "富途客户端" : "TWS";
        const detail =
          `触发下单过程中发生未知异常,订单可能已经到达券商,` +
          `请立即在${where}里核对未成交单:${(exc as Error).message}`;
        this.store.setFinalStatus(pending.record_id, "ibkr_error", detail);
        const engaged = this.killswitch.recordFailure((exc as Error).message, "broker");
        this.notifier.rejection(this.brokerCode(), detail);
        if (engaged) {
          this.notifier.breaker(engaged.reason);
          break;
        }
        continue;
      }
      this.killswitch.recordSuccess("broker");
      this.indexPlacement(pending.record_id, placement);
      this.store.appendEvent(pending.record_id, "trigger", {
        symbol: pending.trigger.symbol, price, limit,
      });
      this.store.appendEvent(pending.record_id, "status", {
        status: placement.status, order_id: placement.order_id, perm_id: placement.perm_id,
      });
      this.notifier.notify(
        "条件已触发",
        `${pending.trigger.symbol} 现价 ${fmtF(price, 4)},已按净价 ${fmtF(limit, 4)} 提交`,
      );
      fired.push({ record_id: pending.record_id, limit, price });
    }
    this.pendingTriggers = this.pendingTriggers.filter((p) => !p.fired);
    return fired;
  }

  /** AUTO_MID 定价:盘口中间价 ± 滑点上限(立即单与触发单共用)。 */
  private async priceAutoMid(approved: ApprovedOrder): Promise<number> {
    const contract = approved.order.contract;
    const quotes = await this.router!.legQuotes(contract, approved.account as AccountConfig);
    const mid = comboMidPrice(quotes);
    return autoMidLimit(
      mid, approved.order.order.action, this.settings.limits.max_spread_slippage,
      strikeWidth(contract),
    );
  }

  // ---- 盯盘调度:追踪止盈 / 标的目标价的节拍器 ------------------------------
  //
  // 以前节拍器在界面里(渲染进程的 setInterval,盯盘、托管对账各一个),而且两个请求在引擎的
  // 交易道上排**低优先级**。三个问题:
  //  · 窗口最小化或被遮住,Chromium 节流后台定时器(隐藏五分钟后最慢一分钟一次)——止损和
  //    秒级调价跟着停摆;
  //  · 和下单挤同一条严格顺序的道,一次慢请求(大模型解析几秒、真机上合约确认卡过 24 秒)
  //    期间,止损与调价全部排队;
  //  · 每秒读两遍持仓,两个循环各算各的。
  // 现在节拍器在引擎进程里:每秒一轮、绝不重叠;一轮只读一次持仓,先判触发(可能发平仓单)再
  // 对账托管单;和改追踪 / 立即平仓共用 trackerLock,绝不并发。界面只读结果。

  /** 追踪相关的一切改动(每一轮盯盘、建 / 改 / 删追踪、立即平仓)排成一队,绝不并发——
   * 一轮盯盘正要发平仓单时,「立即平仓」插进来就是双重平仓。 */
  private trackerChain: Promise<unknown> = Promise.resolve();
  /** RPC 层注入的共享锁:引擎实例会随连接 / 改配置重建,锁必须跨实例同一把,
   * 否则重建那一瞬间旧实例还在跑的那一轮和新实例的第一轮会重叠。 */
  sharedTrackerLock: (<T>(fn: () => Promise<T>) => Promise<T>) | null = null;

  withTrackerLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.sharedTrackerLock !== null) return this.sharedTrackerLock(fn);
    const run = this.trackerChain.then(fn, fn);
    this.trackerChain = run.then(() => undefined, () => undefined);
    return run;
  }

  static readonly TRACKER_TICK_MS = 1000;
  /** 一轮超过这个时长算"慢":比节拍还长,就意味着有一段时间没人盯。 */
  static readonly TRACKER_SLOW_MS = 1500;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  /** 节拍器的心跳:最近一轮的结果与计时。界面据此显示"盯盘每秒一轮、上一轮多少毫秒",
   * 太久没跳就当场告警——静默停摆比慢更危险。 */
  readonly trackerLoop: Rec = {
    running: false, interval_ms: TradingEngine.TRACKER_TICK_MS, ticks: 0, slow_ticks: 0,
    last_at: null, last_ms: null, max_ms: 0, last_error: "", poll: null, hosted: null,
  };
  /** 每轮结束的回调(RPC 层据此把触发 / 被拦推给界面)。 */
  onTrackerTick: ((poll: Rec, hosted: Rec) => void) | null = null;

  /** 引擎进程的事件循环延迟。节拍器是异步的,只有同步代码占住事件循环才会让它晚——
   * 慢了要分得清是"这一轮自己慢"还是"整个进程被别的事卡住"。 */
  private loopDelay: ReturnType<typeof monitorEventLoopDelay> | null = null;

  startTrackerLoop(intervalMs: number = TradingEngine.TRACKER_TICK_MS): void {
    if (this.tickTimer !== null) return;
    if (this.loopDelay === null) {
      try {
        this.loopDelay = monitorEventLoopDelay({ resolution: 20 });
        this.loopDelay.enable();
      } catch {
        this.loopDelay = null;
      }
    }
    this.trackerLoop["running"] = true;
    this.trackerLoop["interval_ms"] = intervalMs;
    const loop = async (): Promise<void> => {
      const t0 = Date.now();
      await this.trackerTickOnce();
      if (!this.trackerLoop["running"]) return;
      // 下一轮在这一轮结束之后排:慢了就紧接着跑,不会叠两轮;快了就补足到一个节拍
      this.tickTimer = setTimeout(() => void loop(), Math.max(0, intervalMs - (Date.now() - t0)));
    };
    this.tickTimer = setTimeout(() => void loop(), 0);
  }

  stopTrackerLoop(): void {
    this.trackerLoop["running"] = false;
    if (this.tickTimer !== null) clearTimeout(this.tickTimer);
    this.tickTimer = null;
    this.loopDelay?.disable();
    this.loopDelay = null;
  }

  /** 一轮盯盘:读一次持仓 → 判触发 → 托管对账。任何异常都不许让节拍器停下。 */
  async trackerTickOnce(moment?: EtNow | null): Promise<void> {
    const state = this.trackerLoop;
    const t0 = Date.now();
    try {
      await this.withTrackerLock(async () => {
        // 执行对账与盯盘无关(没有追踪也要对),但同用一把锁:它会改 orderIndex 与终态
        if (this.router !== null && this.reconcileDue(t0)) {
          try {
            await this.reconcileOrders(t0);
          } catch (exc) {
            // 对账炸了不该带倒盯盘:留痕即可,下一轮还会再来
            this.store.audit("engine", "reconcile_failed", {
              error: String((exc as Error).message).slice(0, 300),
            });
          }
        }
        if (this.router === null || !this.store.listTracks().length) {
          state["poll"] = { rows: [], fired: [], blocked: [] };
          state["hosted"] = { hosted: [], blocked: [], quote_maybe_delayed: false };
          state["last_error"] = "";
          return;
        }
        let rows: Rec[];
        try {
          rows = (await this.router.positions()) ?? [];
        } catch (exc) {
          // 读不到持仓:这一轮不判断、不对账——当成空仓会停掉追踪、撤掉托管单
          state["last_error"] = `读不到持仓:${String((exc as Error).message).slice(0, 200)}`;
          return;
        }
        const poll = await this.pollTrackers(moment ?? null, rows);
        const hosted = await this.syncHosted(rows);
        state["poll"] = poll;
        state["hosted"] = hosted;
        state["last_error"] = "";
        if (this.onTrackerTick !== null) {
          try {
            this.onTrackerTick(poll, hosted);
          } catch {
            /* 推送失败不影响盯盘 */
          }
        }
      });
    } catch (exc) {
      state["last_error"] = String((exc as Error).message).slice(0, 200);
      this.store.audit("engine", "tracker_tick_failed", { error: state["last_error"] });
    } finally {
      const ms = Date.now() - t0;
      // 事件循环延迟按"每一轮一个窗口"记:上一个节拍间隔里最长被占了多久。累计的最大值分不清是哪一下
      if (this.loopDelay !== null) {
        const lag = Number.isFinite(this.loopDelay.max) ? Math.round(this.loopDelay.max / 1e6) : 0;
        state["lag_last_ms"] = lag;
        state["lag_worst_ms"] = Math.max(Number(state["lag_worst_ms"] ?? 0), lag);
        this.loopDelay.reset();
      }
      state["ticks"] = Number(state["ticks"]) + 1;
      state["last_at"] = new Date().toISOString();
      state["last_ms"] = ms;
      state["max_ms"] = Math.max(Number(state["max_ms"]), ms);
      if (ms > TradingEngine.TRACKER_SLOW_MS) state["slow_ticks"] = Number(state["slow_ticks"]) + 1;
    }
  }

  /** 心跳摘要(不带每轮的明细),给 system.status 与界面用。 */
  trackerHeartbeat(): TrackerHeartbeat {
    const s = this.trackerLoop;
    const age = s["last_at"] ? Date.now() - Date.parse(String(s["last_at"])) : null;
    return {
      running: s["running"], interval_ms: s["interval_ms"], ticks: s["ticks"], slow_ticks: s["slow_ticks"],
      last_ms: s["last_ms"], max_ms: s["max_ms"], age_ms: age, last_error: s["last_error"],
      // 事件循环被同步代码占住的时长(毫秒):上一个节拍间隔里的最大值,与开机以来的最坏值。
      // 它高、而 last_ms 不高,说明节拍器没慢,是进程里别的事卡住了它
      event_loop_last_ms: s["lag_last_ms"] ?? null,
      event_loop_worst_ms: s["lag_worst_ms"] ?? null,
    };
  }

  // ---- 标的目标价 → 每轮重算的预计价位 -----------------------------------
  /**
   * 算这一轮的预计价位,并把它并进 targets.take_profit。正股、单腿期权、蝶式/价差
   * 走同一条路(tk.structureOf 认结构,tk.spotTarget 定价)。
   *
   * **每一轮都重算**,不缓存结果:同一个标的目标价,上午和尾盘对应的期权价差着一倍
   * (时间价值还剩多少)。盯盘和托管对账都是一秒一轮,所以这张限价单的价格也是一秒
   * 一变——插针那一下扫过来时,单子必须已经站在当时的合理价上,慢一步就是没成交。
   * (正股是例外:目标价就是价格,每轮算出来都一样,自然不会改单。)
   *
   * 标的现价走 indexPrice:第一次订阅之后是常驻流,每次调用读缓存(百毫秒内),
   * 一秒一轮压得住。
   */
  /** 托管单那一块也要调(见 engine/hosted.ts 的 HostedHost);引擎对外的方法表没变 */
  async applySpotTarget(
    track: Rec, raw: Rec, position: tk.Position, targets: tk.Targets,
    positions: Record<string, Rec>, at: EtNow,
  ): Promise<[tk.Targets, tk.SpotTarget | null, boolean]> {
    const target = finiteOrNull(targets.spot_target);
    if (target === null) return [targets, null, false];
    const structure = tk.structureOf(String(raw["sec_type"] ?? "STK"), raw["contract"] as Rec);
    if (structure === null) return [targets, null, false];

    let spot: number | null = null;
    if (structure.kind === "stock") {
      spot = (raw["market_price"] ?? null) as number | null; // 正股自己就是标的
    } else {
      try {
        spot = await this.router!.indexPrice(String(raw["symbol"]));
      } catch {
        spot = null; // 行情失败不该炸掉轮询;下面会退到上一轮的价
      }
    }
    // 组合各腿的报价:每条腿按自己的报价反解 σ(smile 档,翼内翼外都解得出);缺腿时退到净价/最近腿
    const legPrices: Record<string, number | null> = {};
    for (const legKey of (raw["legs"] ?? []) as string[]) {
      const leg = positions[legKey];
      if (leg === undefined) continue;
      const c = (leg["contract"] ?? {}) as Rec;
      const strike = finiteOrNull(c["strike"]);
      const right = String(c["right"] ?? "").slice(0, 1).toUpperCase();
      if (strike === null || !right) continue;
      legPrices[tk.legPriceKey({ strike, right })] = (leg["market_price"] ?? null) as number | null;
    }

    const info = structure.kind === "stock" ? null : this.router!.spotInfo?.(String(raw["symbol"])) ?? null;
    const spotNote = String(info?.["note"] ?? "");
    // 夜盘推算失败时 indexPrice 退回的是**昨收**:它不会动,拿它反解 σ 算出来的价全是错的。
    // 当作"没有现价"——宁可退到沿用上一次,也不拿一个十个小时前的数去挂单。
    if (info?.["source"] === "index_stale") spot = null;
    const st = tk.spotTarget({
      structure, position, spotTarget: target, spot,
      markPrice: (raw["market_price"] ?? null) as number | null,
      legPrices, minute: at.minutes, spotNote,
    });
    const tid = String(track["id"]);
    const last = this.flyMark.get(tid) ?? null;
    // 只有市场价算出来的数能拿去挂单或改单。clock 档是写死的 EM 算的模型默认值,
    // 拿它每秒推一张真单,等于按一个假数把止盈位往上抬;更不能拿它挂**第一张**单——
    // 那张单的价格用户没同意过(2026-09-10 真机:期货行情首笔 tick 要三四秒,
    // 冷启动那几轮只有 clock 可用)。
    if (st.price !== null && tk.MARKET_SIGMA_SOURCES.has(st.sigma_source)) {
      this.flyMark.set(tid, st.price);
      return [{ ...targets, take_profit: st.price }, st, false];
    }
    if (last !== null) {
      st.reason = st.reason || `这一轮没有市场价(${st.sigma_source === "clock" ? "只有模型默认波动率" : "算不出"}),停在最后一次市场价算出的 ${last}`;
      return [{ ...targets, take_profit: last }, st, false];
    }
    // 从来没拿到过市场价:只守不挂。不挂新单,也不撤已经挂着的(重启后认领回来的那张)
    st.held = true;
    st.reason = st.reason || "还没拿到市场报价,先不挂单;行情一来就按市场价挂";
    return [targets, st, true];
  }

  // ---- 持仓追踪:到价自动平仓 -------------------------------------------
  async pollTrackers(moment?: EtNow | null, rows?: Rec[] | null): Promise<TrackerPollTick> {
    const at = moment ?? nowEt();
    const out: TrackerPollTick = { rows: [], fired: [], blocked: [] };
    const tracks = this.store.listTracks();
    if (!tracks.length || this.router === null) return out;

    let positions: Record<string, Rec>;
    try {
      // 调度器一轮只读一次持仓,判触发和托管对账用同一份(见 trackerTickOnce)
      positions = Object.fromEntries(
        tk.withCombos(rows ?? (await this.router.positions()) ?? []).map((p) => [p["key"], p]),
      );
    } catch (exc) {
      // 读不到持仓不该炸掉轮询
      this.store.audit("engine", "positions_failed", { error: String((exc as Error).message).slice(0, 300) });
      return out;
    }

    if (!this.closeChaseAdopted) await this.adoptCloseChase(tracks);
    const breaker = this.killswitch.state();
    for (const track of tracks) {
      const key = tk.trackKey(track);
      const raw = positions[key];
      if (raw === undefined) {
        // 仓位已经不在了。停掉追踪但不删——用户要能看见"它为什么不再盯了"。
        if (track["enabled"]) {
          this.store.updateTrack(track["id"], { enabled: false });
          this.notifier.warning(`${track["symbol"]} 的持仓已不存在,追踪自动停止。`);
        }
        out["rows"].push({ ...track, state: "closed", reason: "持仓已不存在" });
        continue;
      }

      // 持仓行里的现价来自 TWS 的 portfolio 推送,盘前/盘后常常是空的——
      // 追踪要全时段有效,拿不到就退到行情接口再要一次(只对股票;
      // 期权腿的价格接口不同,拿不到就照实说"本轮不判断")。
      if ((raw["market_price"] ?? null) === null && raw["sec_type"] === "STK") {
        let fallback: number | null = null;
        try {
          fallback = await this.router.indexPrice(raw["symbol"]);
        } catch {
          fallback = null; // 行情失败不该炸掉轮询
        }
        if (fallback !== null) {
          raw["market_price"] = fallback;
          raw["price_source"] = "quote";
        }
      }

      const position = tk.makePosition({
        account: raw["account"], symbol: raw["symbol"], sec_type: raw["sec_type"],
        quantity: raw["quantity"], avg_cost: raw["avg_cost"], multiplier: raw["multiplier"],
        currency: raw["currency"], market_price: raw["market_price"],
        market_value: raw["market_value"], unrealized_pnl: raw["unrealized_pnl"],
      });
      // 标的目标价换算成这一轮的止盈价(每轮重算,见 applySpotTarget)
      const [targets, spotTargetRow] = await this.applySpotTarget(
        track, raw, position, tk.makeTargets(track["targets"] ?? {}), positions, at,
      );
      let result = tk.evaluate(position, targets, raw["market_price"], track["peak"] ?? null,
        at.minutes);
      // 标的真到了目标价。同一组 σ 下它和"持仓价 ≥ 目标价对应的价"是一回事,可行情口径不一致时
      // (退到最近腿 / 时钟 σ)两者会差一点——以标的本身为准:到了就是到了
      if (result.state === tk.STATE_HOLDING && spotTargetRow?.reached) {
        result = {
          ...result,
          state: tk.STATE_TAKE_PROFIT,
          reason: `${track["symbol"]} 到了目标价 ${pyG(Number(targets.spot_target))}(现价 ${spotTargetRow.spot})`,
        };
      }

      // 峰值只在变了的时候写
      if (result.peak !== null && result.peak !== track["peak"]) {
        this.store.updateTrack(track["id"], { peak: result.peak });
      }

      // raw 来自券商适配层(那一层的行是松散的 Rec);到了这里它就是界面读的那一行
      const row = { ...track, ...result, position: raw as PositionRow };
      if (spotTargetRow !== null) (row as Rec)["spot_target"] = spotTargetRow;
      out["rows"].push(row);

      const auto = tk.makeAutoClose(track["auto_close"] ?? {});
      // 没开托管、平仓单已经发出去的:每轮按最新买卖价追那张单,直到成交(或持仓没了)。
      // 追踪本身已经落闩、停用,不看 enabled——那张单是它发的,追完才算完
      if (this.closeChase.has(String(track["id"]))) {
        const info = await this.chaseCloseOrder(track, raw, position, positions, auto);
        (row as Rec)["sweeping"] = true;
        if (info !== null) (row as Rec)["chase"] = info;
        else out["blocked"].push({ id: track["id"], symbol: track["symbol"], blockers: ["正在追价平仓,但这一轮拿不到腿的买卖价,没改价"] });
        continue;
      }

      if (!track["enabled"] || result.state === tk.STATE_HOLDING) continue;

      if (auto.host_at_broker && this.router.SUPPORTS_HOSTED_CLOSE) {
        // 执行归券商托管单(syncHosted 那条路)。这里若再另发一张平仓单,就是托管单 + 软件单
        // 各平一次——双重平仓等于反向开仓。
        (row as Rec)["hosted"] = true;
        // 正股:止损 / 跟踪 / 利润回撤都有券商侧的单子站岗,止盈价就是目标价本身——全交给券商。
        // 组合与单腿期权不一样:止盈单挂在模型价(中间价口径)上,标的真到了目标价,买价也未必够得着;
        // 组合更是只有这一张单,止损类目标全靠引擎盯。这些情形引擎把**那张托管单**改到立刻成交的价、
        // 没成交就每秒再追(syncHosted)。改的始终是同一张单,不会多出第二张平仓单。
        const secType = String(raw["sec_type"] ?? "");
        const derivative = secType === "BAG" || secType === "OPT" || secType === "FOP";
        const stopLike = result.state !== tk.STATE_TAKE_PROFIT;
        const sweep = derivative && (Boolean(spotTargetRow?.reached) || (secType === "BAG" && stopLike));
        if (sweep && tk.sweepReason(track) === null && !track["fired_at"]) {
          const state = `${tk.SWEEP_PREFIX}${result.state}`;
          this.store.updateTrack(track["id"], { fired_at: nowIsoSecondsEt(), fired_state: state });
          this.store.audit("engine", "hosted_sweep", { track: track["id"], symbol: track["symbol"], state: result.state, reason: result.reason });
          this.notifier.notify(
            "追价平仓", `${track["symbol"]}:${result.reason}。托管单改到立刻成交的价,没成交就每秒再追`,
          );
          out["fired"].push({ id: track["id"], symbol: track["symbol"], state, reason: result.reason });
        }
        if (tk.sweepReason(this.store.getTrack(track["id"]) ?? track) !== null) {
          (row as Rec)["sweeping"] = true;
          // 托管对账在盯盘之后跑,这里给界面的是上一轮追到的价
          const tp = this.hostedOrders.tpEntry(String(track["id"]));
          if (tp && tp["chase_limit"] !== undefined) {
            (row as Rec)["chase"] = {
              rounds: tp["chase_rounds"] ?? 0, limit: tp["chase_limit"], natural: tp["chase_natural"] ?? null,
              floor: tp["chase_floor"] ?? null,
            };
          }
        }
        continue;
      }
      // 追踪止盈全时段有效:盘前/盘后照样平(平仓单会自动转盘外限价),只有休市才真的发不出去。
      // 期权/组合按**合约自己的**时段判——settings.marketStatus 是照美股正股写的,
      // SPX 期权还有 20:15–次日 09:25 那一整段隔夜可交易时间(见 broker.contractHours)。
      const marketStatus = await this.marketStatusFor(raw, at);
      const blockers = tk.closeBlockers({
        auto,
        position,
        accountIsPaper: this.accountIsPaper(track["account"]),
        autoExecute: this.settings.policies.auto_execute,
        allowLiveTrading: this.settings.policies.allow_live_trading,
        breakerEngaged: breaker.engaged,
        marketStatus,
        outsideRth: true,
        alreadyFired: Boolean(track["fired_at"]),
        comboLiveOk: this.settings.policies.allow_combo_live,
      });
      if (blockers.length) {
        // 到价了但发不出去,必须当场说。只提醒一次,不刷屏。
        if (!track["fired_state"]) {
          this.store.updateTrack(track["id"], { fired_state: "blocked" });
          this.notifier.warning(
            `${track["symbol"]} ${result.reason},但没有平仓:${blockers.join("、")}`,
          );
        }
        (row as Rec)["blocked"] = blockers;
        out["blocked"].push({
          id: track["id"], symbol: track["symbol"], reason: result.reason, blockers,
        });
        continue;
      }

      // 组合与期权的平仓单挂在各腿买卖价算出的立刻成交价上;拿不到才退回"现价让一点滑点"。
      // 夜盘蝶的买卖价差能有一块多,按中间价让 0.3% 挂出去的平仓单常常就那么挂着
      let closeResult: Rec = result;
      const secType = String(raw["sec_type"] ?? "");
      if (secType === "BAG" || secType === "OPT" || secType === "FOP") {
        const natural = await this.naturalCloseFor(raw, position, positions);
        if (natural !== null) closeResult = { ...result, price: natural };
      }
      const fired = await this.closePosition(track, position, auto, closeResult, marketStatus);
      if (fired) out["fired"].push(fired);
    }
    return out;
  }

  /** 合约此刻在盘外时段能交易时,自动给订单打上 outsideRth。
   *
   * 不打这个标志,IBKR 只会把单子挂着、等常规时段才送交易所(TWS 原话:"您的委托单在
   * 08:30:00 美国/中部前不会被下达交易所")。而 SPX 期权 20:15–次日 09:25 本来就能成交——
   * 在那个时段按下发送的人要的是现在就成交,不是等明早开盘。
   *
   * 两条不碰:市价单不自动打(盘外只收限价单,打上反而从"挂到开盘"变成"当场被拒");
   * 用户已经显式写了 outsideRth 的不动——显式永远压过自动。 */
  private autoOutsideRth(orders: ParsedOrder[], at: EtNow): ParsedOrder[] {
    if (!this.settings.policies.auto_outside_rth) return [...orders];
    return orders.map((order) => {
      const spec: any = (order as any).order;
      const status = this.orderMarketStatus(order, at) ?? this.settings.marketStatus(at);
      if (!EXTENDED_STATUSES.includes(status) || spec.outsideRth || spec.orderType === "MKT") {
        return order;
      }
      return {
        ...order,
        order: { ...spec, outsideRth: true },
        warnings: [
          ...((order as any).warnings ?? []),
          `当前为${status},已自动打上盘外标志(outsideRth=true):不打的话这张单会挂着,` +
          "等常规时段才送交易所。不想在盘外成交就把 policies.auto_outside_rth 关掉。",
        ],
      } as ParsedOrder;
    });
  }

  /** 把这批订单里期权/组合的合约时段问一遍,填进 router 的按日缓存。
   * 失败一律忽略:查不到时段只是退回正股日历,不该让整条下单链路失败。 */
  private async prewarmContractHours(orders: ParsedOrder[]): Promise<void> {
    const getter = (this.router as any)?.contractHours;
    if (typeof getter !== "function") return;
    const seen = new Set<string>();
    for (const order of orders) {
      const contract: any = (order as any).contract;
      const secType = String(contract?.secType ?? "");
      if (secType !== "OPT" && secType !== "FOP" && secType !== "BAG") continue;
      const legs = contract?.legs ?? [];
      const leg = secType === "BAG" ? legs[0] : contract;
      if (!leg?.lastTradeDateOrContractMonth) continue;
      const key = `${contract.symbol}|${leg.lastTradeDateOrContractMonth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const account = this.settings.accountByAlias(String(order.account ?? "")) ??
        this.settings.defaultAccount();
      if (account === null) continue;
      const row = {
        account: account.alias, symbol: contract.symbol, sec_type: secType,
        contract: secType === "BAG"
          ? { secType: "BAG", symbol: contract.symbol, legs: [{
              lastTradeDateOrContractMonth: leg.lastTradeDateOrContractMonth,
              strike: leg.strike, right: leg.right, ratio: 1.0 }] }
          : { secType, symbol: contract.symbol,
              lastTradeDateOrContractMonth: contract.lastTradeDateOrContractMonth,
              strike: contract.strike, right: contract.right },
      };
      try {
        await getter.call(this.router, row, account);
      } catch {
        /* 查不到就退回正股表 */
      }
    }
  }

  /** 一张**待下单**的期权/组合此刻面对的时段(拿不到回 null,让校验退回正股表)。
   *
   * 和持仓那条路(marketStatusFor)同一个来源:合约自己的 tradingHours。下单与平仓
   * 用同一张时段表,否则会出现"能平不能开"或反过来的荒唐结果。
   *
   * 注意这是**同步**的:校验链路不是 async,所以只读已缓存的时段(轮询那条路每天
   * 会填上),没缓存就回 null 退回正股表——宁可保守,不为了一张单去阻塞校验。 */
  private orderMarketStatus(order: ParsedOrder, at: EtNow): string | null {
    const contract: any = (order as any).contract;
    const secType = String(contract?.secType ?? "");
    if (secType !== "OPT" && secType !== "FOP" && secType !== "BAG") return null;
    const cached = (this.router as any)?.cachedContractHours;
    if (typeof cached !== "function") return null;
    let expiry: any, hours: [string, string, string] | null = null;
    if (secType === "BAG") {
      const legs = contract?.legs ?? [];
      if (!legs.length) return null;
      expiry = legs[0].lastTradeDateOrContractMonth;
    } else {
      expiry = contract?.lastTradeDateOrContractMonth;
    }
    try {
      hours = cached.call(this.router, String(contract.symbol), String(expiry));
    } catch {
      return null;
    }
    if (!hours) return null;
    const status = hoursStatus(hours[0], hours[2], at.epochMs, hours[1]);
    // 与正股表一致时回 null:让 validator 用它自己那个,少一次无谓的分歧
    return !status || status === this.settings.marketStatus(at) ? null : status;
  }

  /** 这条持仓此刻能不能交易。期权/组合优先用合约的真实时段,拿不到就退回正股表。 */
  private async marketStatusFor(raw: Rec, at: EtNow): Promise<string> {
    const secType = String(raw["sec_type"] ?? "");
    if (secType !== "OPT" && secType !== "FOP" && secType !== "BAG") {
      return this.settings.marketStatus(at);
    }
    const getter = (this.router as any)?.contractHours;
    if (typeof getter !== "function") return this.settings.marketStatus(at);
    const account = this.settings.accountByAlias(String(raw["account"] ?? ""));
    if (account === null) return this.settings.marketStatus(at);
    let hours: [string, string, string] | null = null;
    try {
      hours = await getter.call(this.router, raw, account);
    } catch {
      hours = null;                      // 查时段失败不该炸掉轮询
    }
    if (!hours) return this.settings.marketStatus(at);
    const [trading, liquid, tzId] = hours;
    return hoursStatus(trading, tzId, at.epochMs, liquid) || this.settings.marketStatus(at);
  }

  /**
   * 平掉这条持仓此刻「立刻能成交」的价(见 tk.naturalClosePrice)。组合取各腿的持仓行,单腿取它自己;
   * router 没有常驻期权报价、或任何一条腿没有有效买卖价,回 null。
   */
  async naturalCloseFor(
    raw: Rec, position: tk.Position, positions: Record<string, Rec>,
  ): Promise<number | null> {
    const quoter = this.router?.optionQuotes;
    if (typeof quoter !== "function") return null;
    const structure = tk.structureOf(String(raw["sec_type"] ?? "STK"), raw["contract"] as Rec);
    if (structure === null || structure.kind === "stock") return null;
    const legRows = structure.kind === "combo"
      ? ((raw["legs"] ?? []) as string[]).map((k) => positions[k]).filter((r): r is Rec => r !== undefined)
      : [raw];
    let quotes: Record<string, { bid: number | null; ask: number | null }>;
    try {
      quotes = await quoter.call(this.router, legRows);
    } catch {
      return null;
    }
    const book: Record<string, tk.LegBook> = {};
    for (const row of legRows) {
      const c = (row["contract"] ?? {}) as Rec;
      const strike = finiteOrNull(c["strike"]);
      const right = String(c["right"] ?? "").slice(0, 1).toUpperCase();
      if (strike === null || !right) continue;
      book[tk.legPriceKey({ strike, right })] = quotes[String(row["key"])] ?? { bid: null, ask: null };
    }
    return tk.naturalClosePrice(position, structure, book);
  }

  accountIsPaper(alias: string): boolean {
    const account = this.settings.accountByAlias(alias);
    return account ? Boolean(account.is_paper) : true;
  }

  /** 真的把平仓单发出去,并且先落闩再发。 */
  async closePosition(
    track: Rec, position: tk.Position, auto: tk.AutoClose, result: Rec, marketStatus?: string | null,
  ): Promise<TrackFired | null> {
    let payload: Rec;
    try {
      payload = tk.buildCloseOrder(
        position, auto, result["price"] ?? null, result["state"], track["contract"] ?? {},
        marketStatus ?? this.settings.marketStatus(nowEt()),
      );
    } catch (exc) {
      this.notifier.rejection("TRACKER_ERROR", `平仓单构造失败:${(exc as Error).message}`);
      return null;
    }
    let parsed: ReturnType<typeof parseLlmPayload>;
    try {
      parsed = parseLlmPayload({ orders: [payload], rejections: [] });
    } catch (exc) {
      this.notifier.rejection("TRACKER_ERROR", `平仓单构造失败:${(exc as Error).message}`);
      return null;
    }
    if (!parsed.orders.length) {
      this.notifier.rejection("TRACKER_ERROR", "平仓单没有通过 schema 校验,已放弃。");
      return null;
    }

    const account = this.settings.accountByAlias(track["account"]);
    if (account === null) {
      this.notifier.rejection("TRACKER_ERROR", `账户别名 ${track["account"]} 已不存在。`);
      return null;
    }

    const order = parsed.orders[0]!;
    const approved: ApprovedOrder = {
      order,
      account,
      notional:
        Math.abs(position.quantity) * (position.market_price ?? 0) * (position.multiplier || 1.0),
      signature: `tracker:${track["id"]}`,
      warnings: ["由持仓追踪自动发出,未经模型解析"],
    };
    const recordId = this.store.createRecord({
      ...this.baseRecord(payload["intent_summary"], "tracker", null),
      account: { alias: account.alias, account_id: account.account_id, is_paper: account.is_paper },
      contract: order.contract,
      order: order.order,
      execution_type: "IMMEDIATE",
      notional_estimate: approved.notional,
    });
    this.store.appendEvent(recordId, "warning", { message: result["reason"] });

    // 先落闩
    this.store.updateTrack(track["id"], {
      fired_at: nowIsoSecondsEt(),
      fired_state: result["state"],
      fired_record: recordId,
      enabled: false,
    });
    let placement: PlacementResult;
    try {
      placement = await this.router!.place(recordId, approved);
    } catch (exc) {
      const detail = `自动平仓下单失败:${(exc as Error).message}。请立刻手动核对持仓。`;
      this.store.setFinalStatus(recordId, "ibkr_error", detail);
      this.killswitch.recordFailure((exc as Error).message, "broker");
      this.notifier.rejection(this.brokerCode(), detail);
      return null;
    }

    this.indexPlacement(recordId, placement);
    this.store.appendEvent(recordId, "status", {
      status: placement.status, order_id: placement.order_id,
    });
    // 平仓留一条只增的痕:保护规则按它数"最近几次止损"、算同一只标的的冷却期(见 protections.ts)。
    // 追踪表的 fired_state 顶不了这个用——它就地更新,平第二次就把第一次盖掉了。
    this.store.audit("engine", "auto_close", {
      track: track["id"], symbol: track["symbol"], state: result["state"], record: recordId,
    });
    this.killswitch.recordSuccess("broker");
    // 期权 / 组合的限价平仓单发出去只是开始:挂在自然价上未必立刻成交,之后每轮按最新买卖价
    // 追那张单(chaseCloseOrder),成交后再把 fired_state 换回触发原因本身。改的始终是这一张,
    // 不会另发第二张。正股与市价单不追:正股限价就是目标价,市价单本来就立刻成交。
    const secType = String(order.contract.secType ?? "");
    const orderSpec: Rec = order.order as Rec;
    const chase = placement.order_id && orderSpec["orderType"] === "LMT"
      && (secType === "BAG" || secType === "OPT" || secType === "FOP")
      && typeof this.router?.modifyHosted === "function";
    if (chase) {
      const tid = String(track["id"]);
      const orderId = Number(placement.order_id);
      this.closeChase.set(tid, {
        order_id: orderId, record_id: recordId, action: orderSpec["action"],
        quantity: Number(orderSpec["totalQuantity"]), label: String(payload["intent_summary"] ?? "平仓"),
        // 发单这一轮算第 0 轮(和托管单第一次挂出同义),下一轮盯盘从第 1 轮接着数
        rounds: 1, limit: finiteOrNull(orderSpec["lmtPrice"]), natural: null, floor: null, warned: false,
      });
      this.closeChaseIndex.set(orderId, tid);
      this.store.updateTrack(tid, { fired_state: `${tk.SWEEP_PREFIX}${result["state"]}` });
    }
    this.notifier.notify(
      "自动平仓已发出",
      `${track["symbol"]}:${result["reason"]}${chase ? "。限价挂在立刻成交的价上,没成交每秒再追" : ""}`,
      redactAccount(account.account_id),
    );
    return {
      id: track["id"], symbol: track["symbol"], state: result["state"],
      record_id: recordId, reason: result["reason"], order_id: placement.order_id,
    };
  }

  /**
   * 追价平仓这一轮该挂的价:自然价(各腿买卖价合成)按 tk.chaseLimit 越等越让、只朝成交方向动。
   * 拿不到任何一条腿的买卖价回 null——这一轮不动那张单。
   */
  /** 同上 */
  async chaseQuote(
    raw: Rec, position: tk.Position, positions: Record<string, Rec>, auto: tk.AutoClose,
    prev: number | null, rounds: number,
  ): Promise<{ natural: number; limit: number; floor: number } | null> {
    const natural = await this.naturalCloseFor(raw, position, positions);
    if (natural === null) return null;
    return {
      natural,
      limit: tk.chaseLimit(position, natural, prev, rounds, auto),
      floor: tk.chaseFloor(position, natural, auto),
    };
  }

  /** 追了太久还没成交,提醒一次(不刷屏):人得知道该不该自己出手。 */
  /** 同上 */
  chaseWarnIfStuck(track: Rec, entry: Rec, limit: number, natural: number): void {
    if (entry["warned"] || Number(entry["rounds"] ?? 0) < tk.CHASE_WARN_ROUNDS) return;
    entry["warned"] = true;
    this.notifier.warning(
      `${track["symbol"]} 追价平仓 ${entry["rounds"]} 秒仍未成交:挂 ${pyG(limit)},此刻自然价 ${pyG(natural)}。`
      + "请留意持仓,必要时手动处理。",
    );
  }

  /** 没开托管的平仓单:每轮把它改到这一轮的追价(chaseQuote)。回这一轮的追价信息给界面;拿不到报价回 null。 */
  private async chaseCloseOrder(
    track: Rec, raw: Rec, position: tk.Position, positions: Record<string, Rec>, auto: tk.AutoClose,
  ): Promise<Rec | null> {
    const tid = String(track["id"]);
    const entry = this.closeChase.get(tid);
    if (entry === undefined) return null;
    const q = await this.chaseQuote(raw, position, positions, auto, entry["limit"] ?? null, Number(entry["rounds"] ?? 0));
    if (q === null) return null;
    entry["natural"] = q.natural;
    entry["floor"] = q.floor;
    const prev = finiteOrNull(entry["limit"]);
    if (prev === null || Math.round(prev * 100) !== Math.round(q.limit * 100)) {
      const item: tk.HostedOrderPlan = {
        kind: "close", action: String(entry["action"] ?? tk.closeSide(position)), order_type: "LMT",
        quantity: Number(entry["quantity"]), lmt_price: q.limit, aux_price: null,
        trailing_percent: null, trail_stop_seed: null, label: String(entry["label"]),
      };
      let ok = false;
      try {
        ok = await this.router!.modifyHosted!(Number(entry["order_id"]), item);
      } catch (exc) {
        this.store.audit("engine", "close_chase_failed", { track: tid, error: String((exc as Error).message).slice(0, 300) });
        this.killswitch.recordFailure((exc as Error).message, "broker");
        return { rounds: entry["rounds"], limit: prev, natural: q.natural, floor: q.floor };
      }
      if (!ok) {
        // 券商侧已经不认识这张单(成交 / 撤销的回报还在路上):不再追,回报到了自然落闩
        this.dropCloseChase(tid);
        return null;
      }
      entry["limit"] = q.limit;
      this.store.appendEvent(String(entry["record_id"]), "status", { status: "Adjusted", lmt_price: q.limit, quantity: item.quantity });
    }
    entry["rounds"] = Number(entry["rounds"] ?? 0) + 1;
    this.chaseWarnIfStuck(track, entry, q.limit, q.natural);
    return { rounds: entry["rounds"], limit: entry["limit"], natural: q.natural, floor: q.floor };
  }

  private dropCloseChase(tid: string): void {
    const entry = this.closeChase.get(tid);
    if (entry === undefined) return;
    this.closeChaseIndex.delete(Number(entry["order_id"]));
    this.closeChase.delete(tid);
  }

  /** 重启后认领还挂在券商侧的平仓单(orderRef = 记录 id),接着追。只做一次;认领不到就算了——
   * 那张单停在最后的价上,和托管单"软件关掉停在最后一次"同一语义。 */
  private async adoptCloseChase(tracks: Rec[]): Promise<void> {
    this.closeChaseAdopted = true;
    const lister = this.router?.listHostedOpen;
    if (typeof lister !== "function") return;
    for (const track of tracks) {
      const tid = String(track["id"]);
      const recordId = String(track["fired_record"] ?? "");
      if (tk.sweepReason(track) === null || !recordId || this.closeChase.has(tid)) continue;
      if (tk.makeAutoClose(track["auto_close"] ?? {}).host_at_broker) continue; // 托管的由 adoptHosted 认领
      let rows: Rec[];
      try {
        rows = await lister.call(this.router, recordId);
      } catch {
        continue;
      }
      const row = rows.find((r) => String(r["order_ref"] ?? "") === recordId && r["order_id"]);
      if (row === undefined) continue;
      const orderId = Number(row["order_id"]);
      this.closeChase.set(tid, {
        // 方向不取券商回的 action:BAG 一律以 BUY 提交,真实方向是"平掉这份持仓的那一侧",
        // 改单签净价要用它——追价那一轮按持仓现算(chaseCloseOrder)
        order_id: orderId, record_id: recordId, action: null, quantity: Number(row["quantity"]),
        label: `${track["symbol"]} 平仓(重启认领)`, rounds: 0, limit: finiteOrNull(row["lmt_price"]),
        natural: null, floor: null, warned: false,
      });
      this.closeChaseIndex.set(orderId, tid);
      this.orderIndex.set(orderId, recordId);
      if (row["perm_id"]) this.orderIndex.set(Number(row["perm_id"]), recordId);
      this.store.audit("engine", "close_chase_adopted", { track: tid, order_id: orderId });
    }
  }

  /** 追价平仓单的终态:成交 → 落闩记真正的触发原因;撤销 / 失效 → 摘掉并提醒(持仓还在)。
   *  不加 private:engine/callbacks.ts 的状态 / 错误回报都要先过这一手(CallbackHost)。 */
  closeChaseOnStatus(trade: any): void {
    const orderId = Number(trade?.order?.orderId ?? 0);
    const tid = orderId ? this.closeChaseIndex.get(orderId) : undefined;
    if (tid === undefined) return;
    const status = String(trade?.orderStatus?.status ?? "");
    const track = this.store.getTrack(tid);
    const reason = track ? tk.sweepReason(track) : null;
    if (status === "Filled") {
      this.dropCloseChase(tid);
      if (reason !== null) this.store.updateTrack(tid, { fired_state: reason });
      this.notifier.notify("追价平仓已成交", `${track?.["symbol"] ?? "?"}:${HostedOrders.STATE_LABEL[reason ?? ""] ?? reason ?? ""}`);
    } else if (["Cancelled", "ApiCancelled", "Inactive"].includes(status)) {
      this.dropCloseChase(tid);
      if (reason !== null) this.store.updateTrack(tid, { fired_state: reason });
      this.notifier.warning(`${track?.["symbol"] ?? "?"} 的追价平仓单已${status === "Inactive" ? "失效" : "撤销"},持仓可能还在,请手动核对。`);
    }
  }

  /**
   * 手动「立即平仓」落在一条已经有单在券商侧的追踪上(托管单、或正在追价的平仓单):不另发一张,
   * 把那张改成追价平仓——两张各平一次就是反向开仓。回 true 表示已经这么办了;false 表示没有现成的单,
   * 调用方照常发平仓单。
   */
  async sweepExisting(track: Rec, reason: string): Promise<boolean> {
    const tid = String(track["id"]);
    const hasHosted = this.hostedOrders.tpEntry(tid) !== undefined;
    if (!hasHosted && !this.closeChase.has(tid)) return false;
    if (tk.sweepReason(track) === null) {
      this.store.updateTrack(tid, { fired_at: nowIsoSecondsEt(), fired_state: `${tk.SWEEP_PREFIX}${tk.STATE_STOP_LOSS}` });
      this.store.audit("engine", "hosted_sweep", { track: tid, symbol: track["symbol"], state: tk.STATE_STOP_LOSS, reason });
      this.notifier.notify("追价平仓", `${track["symbol"]}:${reason}。现有的那张单改到立刻成交的价,没成交就每秒再追`);
    }
    return true;
  }

  // ---- 券商托管的止盈/止损:整块在 engine/hosted.ts ---------------------
  /** 把「追踪设置」和「券商侧挂着的托管单」对齐(挂缺的、改变了的、撤多余的)。由界面按秒驱动。 */
  async syncHosted(rows?: Rec[] | null): Promise<TrackerSyncHostedTick> {
    return this.hostedOrders.syncHosted(rows);
  }

  /** 收盘后清理当日未触发的条件单(tif=DAY 的语义,§8.2b)。 */
  expirePending(moment?: EtNow | null): number {
    const at = moment ?? nowEt();
    if (this.settings.marketStatus(at) !== "休市") return 0;
    let count = 0;
    for (const pending of this.pendingTriggers) {
      if (pending.approved.order.order.tif === "GTC") continue;
      this.store.setFinalStatus(pending.record_id, "expired_untriggered");
      this.notifier.warning(`条件单当日未触发,已失效:${pending.approved.order.intent_summary}`);
      pending.fired = true;
      count += 1;
    }
    this.pendingTriggers = this.pendingTriggers.filter((p) => !p.fired);
    return count;
  }

  // ---- 保护规则:比熔断细一档的自动执行暂停 --------------------------------
  //
  // 熔断管"软件坏了"(连续失败),这里管"今天不顺"(接连止损、回撤过大、刚平掉又要进)。
  // 规则从库里现算,到点自己过去,不写状态文件、不需要人工解除——见 protections.ts。
  //
  // **只挡新单,永不挡平仓**:持仓追踪发的平仓单走 closePosition,不经过这里;
  // 被挡下的单停在"仅校验未发送",不落终态,保护期过了还能再发。

  /** 现算一遍保护状态。窗口取开着的规则里最早的那个起点(protectionsSince),一次查库同时喂给各条。 */
  protectionState(nowMs = Date.now()): ProtectionState {
    const cfg = this.settings.protections;
    if (!protectionsEnabled(cfg)) return NO_PROTECTION;
    const sinceMs = protectionsSince(cfg, nowMs);
    try {
      return evaluateProtections(
        cfg,
        this.store.recentCloses(sinceMs, nowMs),
        needsPnlEvents(cfg) ? this.store.realizedPnlEvents(sinceMs, nowMs) : [],
        nowMs,
      );
    } catch (exc) {
      // 算不出来就放行:保护规则误拦是妨碍交易,而它本身避免不了任何已经发生的亏损
      this.store.audit("engine", "protections_failed", {
        error: String((exc as Error).message).slice(0, 300),
      });
      return NO_PROTECTION;
    }
  }

  // ---- 执行对账:整块在 engine/reconcile.ts -----------------------------
  /** 下一轮盯盘就重新对账(接上新会话时调用:券商可能在断线期间成交或撤了单)。 */
  reconcileSoon(): void {
    this.reconciler.reconcileSoon();
  }

  reconcileDue(nowMs = Date.now()): boolean {
    return this.reconciler.reconcileDue(nowMs);
  }

  async reconcileOrders(nowMs = Date.now()): Promise<Rec> {
    return this.reconciler.reconcileOrders(nowMs);
  }

  // ---- 券商回报 → 落库(§6 status_timeline / fills)----------------------
  private indexPlacement(recordId: string, placement: PlacementResult): void {
    for (const key of [placement.perm_id, placement.order_id]) {
      if (key) this.orderIndex.set(Number(key), recordId);
    }
    this.replayUnmatched();
  }

  /** 同上:对账重建 orderIndex 之后要把攒着的回报重放一遍 */
  replayUnmatched(): void {
    this.callbacks.replayUnmatched();
  }

  /** 给一条会话挂上全部回报监听(幂等)。富途会话没有事件流 → 直接放行。 */
  wireSession(session: any): boolean {
    if (session?._dafriWired) return false;
    if (typeof session?.onOrderStatus !== "function") return false;
    session.onOrderStatus((trade: any) => this.onOrderStatus(trade));
    if (typeof session.onFill === "function") {
      session.onFill((trade: any, fill: any) => this.onExecDetails(trade, fill));
    }
    if (typeof session.onCommission === "function") {
      session.onCommission((trade: any, fill: any, report: any) => this.onCommission(trade, fill, report));
    }
    if (typeof session.onError === "function") {
      session.onError((reqId: number, code: number, message: string) =>
        this.onIbError(reqId, code, message));
    }
    session._dafriWired = true;
    // 新会话 = 刚连上或券商重启后重连:断线那段时间里的成交与撤单只能靠对账搬回来
    this.reconcileSoon();
    return true;
  }

  /** 把每条连接的回报接到 append-only 存储上;并注册 session_hook,
   * 券商重启后新会话自动重新挂监听,而不是悄悄变成黑洞。 */
  attachListeners(): number {
    if (this.router === null) return 0;
    try {
      (this.router as any).sessionHook = (session: any) => this.wireSession(session);
    } catch {
      /* 测试替身可能不接受该属性 */
    }
    let attached = 0;
    const sessions = this.router.sessions?.() ?? [];
    for (const session of sessions) {
      if (this.wireSession(session)) attached += 1;
    }
    return attached;
  }

  /** 拒绝码里的券商名(用户可见:通知副标题、拒绝卡片标题)。 */
  brokerCode(): string {
    return this.router?.BROKER === "futu" ? "FUTU_ERROR" : "IBKR_ERROR";
  }

  /** 拉取式回报同步(富途没有事件流)。IBKR 的 router 没有这个方法 → 空转。 */
  async syncBrokerOrders(): Promise<number> {
    const puller = this.router?.pollOrderUpdates;
    if (typeof puller !== "function") return 0;
    let updates: Array<[string, any, any]>;
    try {
      updates = await puller.call(this.router);
    } catch (exc) {
      this.store.audit("engine", "poll_orders_failed", { error: (exc as Error).message });
      return 0;
    }
    let count = 0;
    for (const [kind, trade, fill] of updates) {
      if (kind === "status") this.onOrderStatus(trade);
      else if (kind === "fill") this.onExecDetails(trade, fill);
      else continue;
      count += 1;
    }
    return count;
  }

  // ---- 回报落库的那几只手都在 engine/callbacks.ts;这里只留挂回调时要用的转调 ----
  onIbError(reqId: unknown, errorCode: unknown, errorString: unknown): void {
    this.callbacks.onIbError(reqId, errorCode, errorString);
  }

  onOrderStatus(trade: any): void {
    this.callbacks.onOrderStatus(trade);
  }

  onExecDetails(trade: any, fill: any): void {
    this.callbacks.onExecDetails(trade, fill);
  }

  onCommission(trade: any, fill: any, report: any): void {
    this.callbacks.onCommission(trade, fill, report);
  }

  /** §9.7 全局熔断:停新单 + 撤未成交单。 */
  async halt(reason: string): Promise<Rec> {
    const state = this.killswitch.engage(reason);
    const cancelled = this.router ? await this.router.cancelAllOpen() : 0;
    this.pendingTriggers.length = 0;
    // 托管单也被 cancelAllOpen 撤掉了,缓存跟着清;熔断解除后由对账循环
    // 按闸门决定要不要重挂(熔断未解除时闸门会拦住)。
    this.hostedOrders.clear();
    this.store.audit("user", "halt", { reason, cancelled });
    this.notifier.breaker(`${reason}(已撤销 ${cancelled} 笔未成交单)`);
    return { engaged: state.engaged, cancelled };
  }

  // ---- 落库 -----------------------------------------------------------
  baseRecord(instruction: string, channel: string, response: LLMResponse | null): Rec {
    return {
      input: { raw_instruction: instruction, reason: "", input_channel: channel },
      llm: {
        model: response?.model ?? "",
        prompt_version: response?.prompt_version ?? "",
        prompt_fingerprint: response?.prompt_fingerprint ?? "",
        intent_summary: "",
        confidence: null,
        warnings: [],
        raw_response: response?.text ?? "",
        usage: response?.usage ?? {},
      },
      execution_type: null,
      trigger: null,
      triggered_at: null,
      account: {},
      contract: {},
      order: {},
      ibkr: {
        order_id: null, perm_id: null, status_timeline: [], fills: [],
        avg_fill_price: null, total_commission: null, realized_pnl: null,
      },
      final_status: null,
      error_detail: null,
      signature: "",
    };
  }

  private recordApproved(
    instruction: string, channel: string, response: LLMResponse, approved: ApprovedOrder,
  ): string {
    const order = approved.order;
    const record = this.baseRecord(instruction, channel, response);
    record["input"]["reason"] = order.reason;
    Object.assign(record["llm"], {
      intent_summary: order.intent_summary,
      confidence: order.confidence,
      warnings: approved.warnings,
    });
    record["execution_type"] = order.execution_type;
    record["trigger"] = order.trigger ? { ...order.trigger } : null;
    record["account"] = {
      alias: approved.account.alias,
      account_id: approved.account.account_id,
      is_paper: approved.account.is_paper,
    };
    record["contract"] = dumpExcludeNone(order.contract);
    record["order"] = dumpExcludeNone(order.order);
    record["notional_estimate"] = pyRound(approved.notional, 2);
    record["signature"] = approved.signature;
    return this.store.createRecord(record);
  }

  private recordRejection(
    instruction: string, channel: string, response: LLMResponse,
    rejection: Rejection, finalStatus: string,
  ): string {
    const record = this.baseRecord(instruction, channel, response);
    record["llm"]["intent_summary"] = rejection.original_text;
    record["rejection"] = { ...rejection };
    const recordId = this.store.createRecord(record);
    this.store.setFinalStatus(recordId, finalStatus, rejection.message);
    return recordId;
  }

  private recordValidatorRejection(
    instruction: string, channel: string, response: LLMResponse, rejected: RejectedOrder,
  ): string {
    const order = rejected.order;
    const record = this.baseRecord(instruction, channel, response);
    record["input"]["reason"] = order.reason;
    Object.assign(record["llm"], {
      intent_summary: order.intent_summary, confidence: order.confidence,
    });
    record["execution_type"] = order.execution_type;
    record["trigger"] = order.trigger ? { ...order.trigger } : null;
    record["contract"] = dumpExcludeNone(order.contract);
    record["order"] = dumpExcludeNone(order.order);
    record["rejection"] = {
      code: primaryCode(rejected),
      message: rejectionMessage(rejected),
      issues: rejected.issues.map((i) => ({ code: i.code, message: i.message })),
    };
    const recordId = this.store.createRecord(record);
    this.store.setFinalStatus(recordId, "rejected_by_validator", rejectionMessage(rejected));
    return recordId;
  }
}

/** model_dump(exclude_none=True) 的对应物:去掉 null 字段(嵌套 legs 一并处理)。 */
export function dumpExcludeNone(value: unknown): any {
  if (Array.isArray(value)) return value.map(dumpExcludeNone);
  if (value !== null && typeof value === "object") {
    const out: Rec = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      out[k] = dumpExcludeNone(v);
    }
    return out;
  }
  return value;
}

async function buildSnapshotAsync(
  symbols: string[], router: RouterLike, cached: Record<string, number>,
): Promise<Record<string, number>> {
  // market.buildSnapshot 是同步接口;router 是异步的,这里手动展开同一套语义
  const snapshot: Record<string, number> = {};
  for (const symbol of symbols) {
    if (symbol in cached) {
      snapshot[symbol] = Number(cached[symbol]);
      continue;
    }
    let price: number | null;
    try {
      price = await router.indexPrice(symbol);
    } catch {
      price = null; // 行情失败不阻断解析
    }
    if (price) snapshot[symbol] = Number(price);
  }
  return snapshot;
}

function localIsoSeconds(): string {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n: number): string => String(Math.abs(n)).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}

export { fingerprint };
