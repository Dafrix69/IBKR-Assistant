/** 编排:输入 → 解析 → 硬校验 → 下单 → 落库 → 通知(对应 Python engine.py,§1)。
 *
 * 顺序是有意的:任何一步失败都必须在"发单"之前结束。下单只在最后一步发生,
 * 且要同时满足:校验通过、熔断未触发、auto_execute=true、账户允许。
 */
import type { AccountConfig, EtNow, Settings } from "./config.js";
import { etNowFromEpoch, hoursStatus, nowEt } from "./config.js";
import {
  BrokerError, PendingTrigger, PlacementResult, autoMidLimit, comboMidPrice, shouldFire,
  strikeWidth,
} from "./broker.js";
import { KillSwitch } from "./killswitch.js";
import { LLMError, LLMResponse } from "./providers.js";
import { buildSnapshot, extractSymbols } from "./market.js";
import type { ParsedOrder, Rejection } from "./models.js";
import { ContractSpecSchema, parseLlmPayload } from "./models.js";
import { LOCAL_MODEL, looksLikeShorthand, shorthandSymbols, tryParseShorthand } from "./shorthand.js";
import { publicIndexPrice } from "./macro.js";
import { fingerprint as promptFingerprint } from "./prompts.js";
import { Notifier } from "./notify.js";
import type { PromptBundle } from "./prompts.js";
import { fingerprint, loadPromptBundle, renderUser } from "./prompts.js";
import { TradeStore, redactAccount } from "./store.js";
import * as tk from "./tracker.js";
import type { ApprovedOrder, RejectedOrder } from "./validator.js";
import { EXTENDED_STATUSES, Validator, primaryCode, rejectionMessage } from "./validator.js";
import { finiteOrNull, fmtF, pyRound } from "./py.js";
import * as path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

type Rec = Record<string, any>;

export interface EngineResult {
  submitted: Rec[];
  queued: Rec[];
  validated_only: Rec[];
  rejections: Rec[];
  warnings: string[];
  llm: Rec | null;
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
  private readonly orderIndex = new Map<number, string>();
  private readonly finalized = new Set<string>();
  // 竞态缓冲:placeOrder 后、_index_placement 前,回报可能已经推过来。
  // 先攒着,建好映射再重放——直接丢就是"快速成交永远停在 Submitted"。
  private readonly unmatchedEvents: Array<[string, any, any, any]> = [];
  /** 券商托管单的对账缓存:track_id → {kind: 托管单信息};orderId → [track_id, kind]。
   * 真相永远在券商那边——重启后由 adoptHosted() 按 orderRef 认领重建。 */
  private readonly hosted = new Map<string, Map<string, Rec>>();
  private readonly hostedIndex = new Map<number, [string, string]>();
  private hostedAdopted = false;
  /** 「标的目标价」上一轮算出来的预计价位:track_id → 每股/每张/每组净价。
   * 某一轮拿不到标的现价或蝶价时沿用它,而不是把目标价当成"没设"——那会让
   * syncHosted 把已经挂在券商侧的限价单撤掉,一次行情抖动就丢掉保护。
   * 不落库:重启后托管单本身由 adoptHosted 按 orderRef 认领回来,价格就在单子上。 */
  private readonly flyMark = new Map<string, number>();
  /** 被券商拒掉的托管单:track_id|kind → {到期时刻, 原因}。退避期内不重挂也不再改价,
   * 免得每秒刷一张拒单;原因照实交给界面。 */
  private readonly hostedRetryAt = new Map<string, { at: number; reason: string }>();
  /** 比 placeOrder 返回还早到的订单错误:orderId → [错误码, 原文, 时刻]。挂单登记完再对上,
   * 否则那条错误落不到任何人头上,缓存里就一直当这张单在站岗。 */
  private readonly earlyOrderErrors = new Map<number, [number, string, number]>();
  /** 速记解析的公开源现价注入点(测试替身用;null = macro.publicIndexPrice)。 */
  publicPriceFn: ((symbol: string) => Promise<number | null>) | null = null;
  /** 最近一次解析预热的句柄(仅测试等待用;业务代码永不 await 它)。 */
  prewarmPromise: Promise<void> | null = null;

  /** 解析预热:validated-only 的合约后台 qualify 一遍,发单那一下零往返。 */
  private prewarm(approved: ApprovedOrder): void {
    const router = this.router as (RouterLike & { qualify?: Function }) | null;
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

      const summary: Rec = {
        record_id: recordId,
        intent_summary: approved.order.intent_summary,
        account: approved.account.alias,
        notional: pyRound(approved.notional, 2),
      };

      if (dryRun || !this.settings.policies.auto_execute) {
        this.store.appendEvent(recordId, "status", { status: "ValidatedOnly" });
        this.notifier.warning(
          dryRun
            ? `已通过校验(只解析,未发送):${approved.order.intent_summary}`
            : `已通过校验但未发送(auto_execute=false):${approved.order.intent_summary}`,
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
    for (const pending of [...this.pendingTriggers]) {
      if (pending.fired) continue;
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
  trackerHeartbeat(): Rec {
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
  private async applySpotTarget(
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
  async pollTrackers(moment?: EtNow | null, rows?: Rec[] | null): Promise<Rec> {
    const at = moment ?? nowEt();
    const out: Rec = { rows: [], fired: [], blocked: [] };
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
      const result = tk.evaluate(position, targets, raw["market_price"], track["peak"] ?? null,
        at.minutes);

      // 峰值只在变了的时候写
      if (result.peak !== null && result.peak !== track["peak"]) {
        this.store.updateTrack(track["id"], { peak: result.peak });
      }

      const row = { ...track, ...result, position: raw };
      if (spotTargetRow !== null) (row as Rec)["spot_target"] = spotTargetRow;
      out["rows"].push(row);

      if (!track["enabled"] || result.state === tk.STATE_HOLDING) continue;

      const auto = tk.makeAutoClose(track["auto_close"] ?? {});
      if (auto.host_at_broker && this.router.SUPPORTS_HOSTED_CLOSE) {
        // 触发与执行都归券商托管单(syncHosted 那条路)。这里若再发一次
        // 平仓,就是托管单 + 软件单各平一次——双重平仓等于反向开仓。
        (row as Rec)["hosted"] = true;
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

      const fired = await this.closePosition(track, position, auto, result, marketStatus);
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

  accountIsPaper(alias: string): boolean {
    const account = this.settings.accountByAlias(alias);
    return account ? Boolean(account.is_paper) : true;
  }

  /** 真的把平仓单发出去,并且先落闩再发。 */
  async closePosition(
    track: Rec, position: tk.Position, auto: tk.AutoClose, result: Rec, marketStatus?: string | null,
  ): Promise<Rec | null> {
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
    this.killswitch.recordSuccess("broker");
    this.notifier.notify(
      "自动平仓已发出",
      `${track["symbol"]}:${result["reason"]}`,
      redactAccount(account.account_id),
    );
    return {
      id: track["id"], symbol: track["symbol"], state: result["state"],
      record_id: recordId, reason: result["reason"], order_id: placement.order_id,
    };
  }

  // ---- 券商托管的止盈/止损:对账循环 -----------------------------------
  /** 把"追踪设置"和"券商侧挂着的托管单"对齐(挂缺的、改变了的、撤多余的)。
   *
   * 由界面按秒驱动。软件盯盘怕的三件事——轮询漏插针、软件必须开着、我们
   * 这头行情延迟——托管单都不怕:触发发生在券商服务器的实时行情上。 */
  async syncHosted(rows?: Rec[] | null): Promise<Rec> {
    const out: Rec = { hosted: [], blocked: [], quote_maybe_delayed: false };
    const router = this.router;
    if (router === null || !router.SUPPORTS_HOSTED_CLOSE) return out;
    const tracks = this.store.listTracks();
    const wantsHosting = tracks.some((t) => Boolean((t["auto_close"] ?? {})["host_at_broker"]));
    if (!wantsHosting && this.hosted.size === 0) return out;
    if (!this.hostedAdopted) await this.adoptHosted();

    let positions: Record<string, Rec>;
    try {
      positions = Object.fromEntries(
        tk.withCombos(rows ?? (await router.positions()) ?? []).map((p) => [p["key"], p]),
      );
    } catch (exc) {
      // 读不到持仓不该炸掉对账
      this.store.audit("engine", "hosted_positions_failed", {
        error: String((exc as Error).message).slice(0, 300),
      });
      return out;
    }

    const breaker = this.killswitch.state();
    const alive = new Set<string>();
    for (const track of tracks) {
      const tid = String(track["id"]);
      const auto = tk.makeAutoClose(track["auto_close"] ?? {});
      if (!auto.host_at_broker) {
        await this.cancelHostedTrack(tid, "托管已关闭");
        continue;
      }
      if (this.accountIsPaper(track["account"])) {
        // 模拟账户常拿延迟行情:动态调整可能滞后(且只会偏松,不会偏紧),
        // 托管单本身仍由券商实时触发——把这件事告诉界面。
        out["quote_maybe_delayed"] = true;
      }
      const key = tk.trackKey(track);
      const raw = positions[key];
      if (raw === undefined) {
        await this.cancelHostedTrack(tid, "持仓已不存在");
        continue;
      }
      const position = tk.makePosition({
        account: raw["account"], symbol: raw["symbol"], sec_type: raw["sec_type"],
        quantity: raw["quantity"], avg_cost: raw["avg_cost"], multiplier: raw["multiplier"],
        currency: raw["currency"], market_price: raw["market_price"],
        market_value: raw["market_value"], unrealized_pnl: raw["unrealized_pnl"],
      });
      // 托管单只是挂着,不是立刻成交——时段闸门不适用,其余闸门照过:
      // 挂单也是发单,授权(auto_execute/实盘开关)与熔断一个都不能少。
      const blockers = tk.closeBlockers({
        auto,
        position,
        accountIsPaper: this.accountIsPaper(track["account"]),
        autoExecute: this.settings.policies.auto_execute,
        allowLiveTrading: this.settings.policies.allow_live_trading,
        breakerEngaged: breaker.engaged,
        marketStatus: "盘中",
        alreadyFired: Boolean(track["fired_at"]),
        comboLiveOk: this.settings.policies.allow_combo_live,
      });
      if (blockers.length) {
        await this.cancelHostedTrack(tid, blockers.join("、"));
        out["blocked"].push({ id: tid, symbol: track["symbol"], blockers });
        continue;
      }

      const peak = tk.advancePeak(position, raw["market_price"], track["peak"] ?? null);
      if (peak !== null && peak !== track["peak"]) {
        this.store.updateTrack(tid, { peak });
      }
      // 标的目标价:这一轮的止盈价现算。托管单的价格因此**一秒一变**——
      // 插针那一下扫过来时,挂着的限价必须已经是当时的合理价。
      const [targets, , hold] = await this.applySpotTarget(
        track, raw, position, tk.makeTargets(track["targets"] ?? {}), positions, nowEt(),
      );
      const plan = tk.hostedPlan(position, targets, auto, peak);
      alive.add(tid);
      if (!this.hosted.has(tid)) this.hosted.set(tid, new Map());
      const current = this.hosted.get(tid)!;
      const desired = new Set(plan.map((item) => item.kind));
      // 只守不挂的这一轮,止盈单"不在计划里"不等于"该撤":撤掉一张站岗的单比停在旧价危险得多
      if (hold) desired.add(tk.HOSTED_KIND_TP);
      for (const kind of [...current.keys()].filter((k) => !desired.has(k))) {
        await this.cancelHostedOne(tid, kind, "该目标已移除");
      }
      const oca = `dafri-trk-${tid.slice(0, 8)}`;
      for (const item of plan) {
        const cur = current.get(item.kind);
        const retry = this.hostedRetryAt.get(`${tid}|${item.kind}`);
        if (cur === undefined && retry !== undefined) {
          if (retry.at > Date.now()) {
            // 刚被券商拒过:退避期内不重挂,把原因交给界面
            out["blocked"].push({ id: tid, symbol: track["symbol"], blockers: [`托管单被券商拒绝,没有挂上:${retry.reason}`] });
            continue;
          }
          this.hostedRetryAt.delete(`${tid}|${item.kind}`);
        }
        try {
          if (cur === undefined) {
            await this.placeHostedOne(track, item, oca);
          } else if (tk.hostedNeedsUpdate(cur, item)) {
            if (retry !== undefined && retry.at > Date.now()) {
              // 改价刚被拒:原单还在原价,退避期内不再改
              out["blocked"].push({ id: tid, symbol: track["symbol"], blockers: [`托管单改价被券商拒绝,仍挂在 ${cur["lmt_price"] ?? cur["aux_price"]}:${retry.reason}`] });
            } else {
              if (retry !== undefined) this.hostedRetryAt.delete(`${tid}|${item.kind}`);
              await this.modifyHostedOne(track, cur, item);
            }
          }
        } catch (exc) {
          // 单张失败不拖垮整轮
          this.store.audit("engine", "hosted_place_failed", {
            track: tid, kind: item.kind, error: String((exc as Error).message).slice(0, 300),
          });
          this.killswitch.recordFailure((exc as Error).message, "broker");
        }
      }
      const entries = this.hosted.get(tid) ?? new Map<string, Rec>();
      out["hosted"].push({
        id: tid,
        symbol: track["symbol"],
        orders: [...entries.values()].map((v) => ({
          kind: v["kind"], label: v["label"], quantity: v["quantity"],
          lmt_price: v["lmt_price"] ?? null, aux_price: v["aux_price"] ?? null,
          trailing_percent: v["trailing_percent"] ?? null, order_id: v["order_id"] ?? null,
        })),
      });
    }

    const known = new Set(tracks.map((t) => String(t["id"])));
    for (const tid of [...this.hosted.keys()]) {
      if (!alive.has(tid) && !known.has(tid)) {
        await this.cancelHostedTrack(tid, "追踪已删除");
      }
    }
    return out;
  }

  /**
   * 托管单收到订单级错误:**在这一刻就定**,依据是我们刚对这张单做了什么——
   *  · 202 已撤单:单子没了,摘掉;
   *  · 刚挂的单被拒:券商那边根本没有这张单,摘掉、退避、报原因;
   *  · 改价被拒:原单还在、还是原价,缓存恢复成上一次被接受的价,退避期内不再改。
   * 2026-09-10 真机:托管止盈单吃了 10311 被拒,IBKR 没推 Cancelled,缓存却一直当它在站岗——
   * 券商那边 0 张单,界面上照样显示「已托管」。
   */
  private hostedOnError(orderId: number, code: number, message: string): void {
    const where = this.hostedIndex.get(orderId);
    if (!where) return;
    const [tid, kind] = where;
    const entry = this.hosted.get(tid)?.get(kind);
    if (entry === undefined) return;
    const reason = `IBKR ${code}: ${message}`;
    const track = this.store.getTrack(tid);
    const symbol = track ? track["symbol"] : "?";
    if (code !== 202 && entry["pending"] === "modify" && entry["accepted"]) {
      Object.assign(entry, entry["accepted"] as Rec, { pending: null });
      this.hostedRetryAt.set(`${tid}|${kind}`, { at: Date.now() + 60_000, reason });
      this.notifier.warning(`${symbol} 的托管单改价被券商拒绝,仍挂在原价:${reason}`);
      return;
    }
    this.dropHostedEntry(tid, kind);
    if (code !== 202) {
      this.hostedRetryAt.set(`${tid}|${kind}`, { at: Date.now() + 60_000, reason });
      this.store.audit("engine", "hosted_rejected", { track: tid, kind, order_id: orderId, reason });
      this.notifier.warning(`${symbol} 的托管单被券商拒绝,没有挂上:${reason}`);
    }
  }

  /** 重启后按 orderRef 认领券商侧还挂着的托管单——先认领再对账,
   * 否则同一追踪会被再挂一遍。 */
  private async adoptHosted(): Promise<void> {
    const lister = this.router?.listHostedOpen;
    if (typeof lister !== "function") {
      this.hostedAdopted = true;
      return;
    }
    let rows: Rec[];
    try {
      rows = await lister.call(this.router);
    } catch (exc) {
      // 下一轮再试
      this.store.audit("engine", "hosted_adopt_failed", {
        error: String((exc as Error).message).slice(0, 300),
      });
      return;
    }
    // 同一个"追踪 + 单型"在券商那边有多张:以前的 bug(重启认领落空、解析时临时改配置)
    // 留下的重复单。只认单号最新的那一张,其余当场撤掉——两张止盈卖单挂在 3 股持仓上,
    // 一起成交就是反向开仓(2026-09-10 真机:BE 同时挂着 #82 与 #86)。
    const byRef = new Map<string, Rec[]>();
    for (const row of rows) {
      const ref = String(row["order_ref"] ?? "");
      if (!ref.startsWith("trk:")) continue;
      if (!byRef.has(ref)) byRef.set(ref, []);
      byRef.get(ref)!.push(row);
    }
    const keep = new Set<Rec>();
    for (const [ref, group] of byRef) {
      group.sort((a, b) => Number(b["order_id"] ?? 0) - Number(a["order_id"] ?? 0));
      keep.add(group[0]!);
      for (const dup of group.slice(1)) {
        const orderId = Number(dup["order_id"] ?? 0);
        if (!orderId) continue;
        try {
          await this.router!.cancelHosted!(orderId);
          this.store.audit("engine", "hosted_duplicate_cancelled", { order_ref: ref, order_id: orderId, kept: group[0]!["order_id"] });
          this.notifier.warning(`撤掉了一张重复的托管单 #${orderId}(同一追踪只留 #${group[0]!["order_id"]})`);
        } catch (exc) {
          this.store.audit("engine", "hosted_duplicate_cancel_failed", {
            order_ref: ref, order_id: orderId, error: String((exc as Error).message).slice(0, 200),
          });
        }
      }
    }
    for (const row of rows) {
      if (!keep.has(row)) continue;
      const parts = String(row["order_ref"] ?? "").split(":");
      if (parts.length !== 3 || parts[0] !== "trk") continue;
      const [, tid, kind] = parts as [string, string, string];
      const entry: Rec = {
        kind,
        label: tk.HOSTED_LABELS[kind] ?? kind,
        order_id: row["order_id"] ?? null,
        record_id: null,
        quantity: row["quantity"] ?? null,
        lmt_price: row["lmt_price"] ?? null,
        aux_price: row["aux_price"] ?? null,
        trailing_percent: row["trailing_percent"] ?? null,
      };
      if (!this.hosted.has(tid)) this.hosted.set(tid, new Map());
      this.hosted.get(tid)!.set(kind, entry);
      if (row["order_id"]) this.hostedIndex.set(Number(row["order_id"]), [tid, kind]);
    }
    this.hostedAdopted = true;
    if (rows.length) this.store.audit("engine", "hosted_adopted", { count: rows.length });
  }

  private async placeHostedOne(track: Rec, item: tk.HostedOrderPlan, oca: string): Promise<void> {
    const account = this.settings.accountByAlias(track["account"]);
    if (account === null) throw new BrokerError(`账户别名 ${track["account"]} 已不存在。`);
    // 持仓行里的合约不能原样下单,和到价自动平仓走同一个 closeContract——两条路必须拼出
    // 同一张单,否则"核对过的"就只是其中一条:
    //  · 正股:TWS 报回来的是 exchange=NYSE/NASDAQ,原样发出去就是直连交易所,API 预防设置
    //    回 10311「该委托单将直接传递至 NYSE」拒单(2026-09-10 真机:托管止盈单就这么没挂上);
    //    closeContract 收敛成四要素走 SMART。
    //  · 组合:每条腿方向全部反转(持仓 +1/−2/+1 → 平仓 SELL 1 / BUY 2 / SELL 1)。
    const contractSpec = ContractSpecSchema.parse(tk.closeContract((track["contract"] ?? {}) as Rec));
    const ref = `trk:${track["id"]}:${item.kind}`;
    const record: Rec = {
      ...this.baseRecord(
        `${item.label}:${item.action} ${item.quantity} ${track["symbol"]}(GTC,挂在券商服务器)`,
        "tracker", null,
      ),
      account: { alias: account.alias, account_id: account.account_id, is_paper: account.is_paper },
      contract: { ...(track["contract"] ?? {}) },
      order: {
        action: item.action, order_type: item.order_type, quantity: item.quantity,
        lmt_price: item.lmt_price, aux_price: item.aux_price,
        trailing_percent: item.trailing_percent,
      },
      execution_type: "HOSTED",
      signature: ref,
    };
    const recordId = this.store.createRecord(record);

    const result = await this.router!.placeHosted!(account, contractSpec, item, oca, ref);
    const entry: Rec = { ...item, order_id: result.order_id, record_id: recordId, pending: "place" };
    if (!this.hosted.has(String(track["id"]))) this.hosted.set(String(track["id"]), new Map());
    this.hosted.get(String(track["id"]))!.set(item.kind, entry);
    if (result.order_id) {
      this.hostedIndex.set(Number(result.order_id), [String(track["id"]), item.kind]);
      this.orderIndex.set(Number(result.order_id), recordId);
    }
    if (result.perm_id) this.orderIndex.set(Number(result.perm_id), recordId);
    this.store.appendEvent(recordId, "status", {
      status: result.status, order_id: result.order_id,
    });
    const early = result.order_id ? this.earlyOrderErrors.get(Number(result.order_id)) : undefined;
    if (early !== undefined) {
      // 错误比下单返回还早到:现在对上,和晚到的走同一条路
      this.earlyOrderErrors.delete(Number(result.order_id));
      this.onIbError(result.order_id, early[0], early[1]);
      return;
    }
    this.killswitch.recordSuccess("broker");
    this.notifier.notify("托管单已挂出", `${track["symbol"]}:${item.label}`);
  }

  private async modifyHostedOne(track: Rec, current: Rec, item: tk.HostedOrderPlan): Promise<void> {
    const orderId = current["order_id"];
    if (!orderId) return;
    // 改价被拒时券商那边还是这一版:先记下来,拒了就恢复成它(见 hostedOnError)
    current["accepted"] = {
      quantity: current["quantity"], lmt_price: current["lmt_price"], aux_price: current["aux_price"],
      trailing_percent: current["trailing_percent"], label: current["label"],
    };
    current["pending"] = "modify";
    const ok = await this.router!.modifyHosted!(Number(orderId), item);
    if (!ok) {
      // 券商侧已经不认识这张单(成交/撤销竞态):丢掉缓存,下一轮重挂
      this.dropHostedEntry(String(track["id"]), String(current["kind"]));
      return;
    }
    const recordId = current["record_id"];
    if (recordId) {
      this.store.appendEvent(String(recordId), "status", {
        status: "Adjusted",
        lmt_price: item.lmt_price,
        aux_price: item.aux_price,
        quantity: item.quantity,
      });
    }
    current["quantity"] = item.quantity;
    current["lmt_price"] = item.lmt_price;
    current["aux_price"] = item.aux_price;
    current["trailing_percent"] = item.trailing_percent;
    current["label"] = item.label;
  }

  private async cancelHostedTrack(trackId: string, reason: string): Promise<void> {
    const entries = this.hosted.get(trackId);
    if (!entries) return;
    for (const kind of [...entries.keys()]) {
      await this.cancelHostedOne(trackId, kind, reason);
    }
  }

  private async cancelHostedOne(trackId: string, kind: string, reason: string): Promise<void> {
    const entry = this.hosted.get(trackId)?.get(kind);
    if (entry === undefined) return;
    const orderId = entry["order_id"];
    if (orderId) {
      try {
        await this.router!.cancelHosted!(Number(orderId));
      } catch (exc) {
        // 撤单失败要让人知道,但不炸循环
        this.store.audit("engine", "hosted_cancel_failed", {
          track: trackId, kind, error: String((exc as Error).message).slice(0, 300),
        });
        return;
      }
    }
    const recordId = entry["record_id"];
    if (recordId) {
      this.store.appendEvent(String(recordId), "status", { status: "Cancelled", reason });
    }
    this.dropHostedEntry(trackId, kind);
  }

  private dropHostedEntry(trackId: string, kind: string): void {
    const entries = this.hosted.get(trackId);
    if (entries?.has(kind)) {
      const orderId = entries.get(kind)!["order_id"];
      if (orderId) this.hostedIndex.delete(Number(orderId));
      entries.delete(kind);
    }
    if (entries !== undefined && entries.size === 0) this.hosted.delete(trackId);
  }

  /** 托管单成交 → 追踪落闩时,kind 映射回软件盯盘同一套触发状态。 */
  private static readonly HOSTED_FIRED_STATE: Record<string, string> = {
    tp: "take_profit", sl: "stop_loss", trail: "stop_loss", ptrail: "profit_trail",
  };

  /** 托管单的终态处理:成交 → 追踪落闩;撤销 → 丢缓存。
   * OCA 的兄弟单由券商自动撤,撤单回报走同一条路清理缓存。 */
  private hostedOnStatus(trade: any): void {
    const orderId = trade?.order?.orderId;
    if (!orderId || !this.hostedIndex.has(Number(orderId))) return;
    const [tid, kind] = this.hostedIndex.get(Number(orderId))!;
    const status = String(trade?.orderStatus?.status ?? "");
    if (status === "Filled") {
      const entry = this.hosted.get(tid)?.get(kind) ?? {};
      this.store.updateTrack(tid, {
        fired_at: nowIsoSecondsEt(),
        fired_state: TradingEngine.HOSTED_FIRED_STATE[kind] ?? kind,
        fired_record: entry["record_id"] ?? "",
        enabled: false,
      });
      const track = this.store.getTrack(tid);
      const symbol = track ? track["symbol"] : "?";
      this.notifier.notify("托管单已成交", `${symbol}:${entry["label"] ?? kind}`);
      // 整组落闩:OCA 兄弟单券商会自己撤,这里直接清缓存
      for (const k of [...(this.hosted.get(tid)?.keys() ?? [])]) {
        this.dropHostedEntry(tid, k);
      }
    } else if (["Cancelled", "ApiCancelled", "Inactive"].includes(status)) {
      this.dropHostedEntry(tid, kind);
    } else if (["Submitted", "PreSubmitted"].includes(status)) {
      // 券商接受了这一版(新挂的或改过价的):之后再来的错误就不是"刚才那一下被拒"
      const entry = this.hosted.get(tid)?.get(kind);
      if (entry) entry["pending"] = null;
    }
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

  // ---- 券商回报 → 落库(§6 status_timeline / fills)----------------------
  private indexPlacement(recordId: string, placement: PlacementResult): void {
    for (const key of [placement.perm_id, placement.order_id]) {
      if (key) this.orderIndex.set(Number(key), recordId);
    }
    this.replayUnmatched();
  }

  private replayUnmatched(): void {
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
    if (TradingEngine.IB_MARKET_DATA_CODES.has(code)) return; // 行情订阅的错误,不是订单的
    const message = String(errorString ?? "");
    const informational = code >= TradingEngine.IB_INFO_MIN && code < TradingEngine.IB_INFO_MAX;
    const recordId = this.orderIndex.get(req);
    if (recordId === undefined) {
      // 错误比 placeOrder 返回还早:先记下,挂单登记完再对上(见 placeHostedOne)
      if (!informational && !TradingEngine.IB_WARNING_CODES.has(code)) {
        this.earlyOrderErrors.set(req, [code, message, Date.now()]);
        for (const [id, [, , at]] of this.earlyOrderErrors) {
          if (Date.now() - at > 60_000) this.earlyOrderErrors.delete(id);
        }
      }
      return;
    }
    if (informational || TradingEngine.IB_WARNING_CODES.has(code)) {
      this.store.appendEvent(recordId, "warning", { message: `IBKR ${code}: ${message}` });
      if (!informational) this.notifier.warning(`IBKR ${code}: ${message}`);
      return;
    }
    const final = code === 202 ? "cancelled" : "ibkr_error";
    if (this.hostedIndex.has(req)) this.hostedOnError(req, code, message);
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
    this.hostedOnStatus(trade);
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
    let final = TradingEngine.TERMINAL_IB_STATUS[status];
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
    this.store.appendEvent(recordId, "fill", {
      exec_id: execution.execId ?? "",
      time: String(execution.time ?? ""),
      price: Number(execution.price ?? 0) || 0,
      qty: Number(execution.shares ?? 0) || 0,
      commission: 0.0,
    });
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
    this.store.appendEvent(recordId, "commission", {
      exec_id: report?.execId ?? "",
      commission: Number(report?.commission ?? 0) || 0,
      realized_pnl: report?.realizedPNL ?? null,
    });
  }

  /** §9.7 全局熔断:停新单 + 撤未成交单。 */
  async halt(reason: string): Promise<Rec> {
    const state = this.killswitch.engage(reason);
    const cancelled = this.router ? await this.router.cancelAllOpen() : 0;
    this.pendingTriggers.length = 0;
    // 托管单也被 cancelAllOpen 撤掉了,缓存跟着清;熔断解除后由对账循环
    // 按闸门决定要不要重挂(熔断未解除时闸门会拦住)。
    this.hosted.clear();
    this.hostedIndex.clear();
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

function nowIsoSecondsEt(): string {
  // Python 版用 now_et().isoformat(timespec="seconds");这里给出等价的 ET 时刻串
  const now = etNowFromEpoch(Date.now());
  return new Date(now.epochMs).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export { fingerprint };
