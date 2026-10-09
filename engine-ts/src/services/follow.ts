/** Discord 跟单(docs/features/follow.md):bot 读一个频道,信任的人发的蝴蝶速记不经确认直接走发单链路。
 *
 * 这里管五件事:两个来源的起停(Gateway 连接:配了频道、凭证库里有 token 才连;本地收件:开关开着就盯文件,
 * 填了频道名还把读窗口的程序拉起来)、每条消息从判定到发单的那一趟、处理完之后记一次盘口(延迟的代价)、
 * 跟进去的蝴蝶成交之后建追踪、给界面的状态。
 * 规则在 follow.ts(纯函数),协议在 discordGateway.ts,收件文件在 followInbox.ts,读窗口的程序在 followReader.ts。
 * 两个来源的消息走同一条路:信任名单、上限、只观察,一样不少。
 *
 * 几条规矩:
 * * **发单走引擎的同一条路**(`handleInstruction`,channel = "discord"):校验、限额、重复单、保护规则、熔断、落库一样不少;
 *   跟单自己的上限(单笔风险、每日单数、消息新鲜度)是在它前面多加的,不是替代。
 * * **大模型在这条路上不出场。** 先在这里用本地速记解析一遍,接住了才交给引擎;引擎自己还会再解析一遍,
 *   那一遍万一没接住(两遍之间现价取不到了),`refuseModelWhileFollowing` 把大模型调用当场拒掉——
 *   别人写的一句话不许交给模型"理解一下"再直接发单。
 * * **只观察也是全程在跑**:跟单开关关着时照样连、照样解析、照样记日志,只是一张单都不发。
 * * 消息一条一条处理(排队):两条挨着来的单子不并发进引擎,重复单检查才看得见前一条。
 * * 出了错吞掉、记日志,连接与后面的消息不受影响。
 * * **记盘口排在发单之后、不占消息的队**:它只是记一笔,取不到就不记,任何情况下都不该让一张单晚发一毫秒。
 *   行情走蝴蝶测算那批自己的流(optionMarks.ts),不碰盯盘的流——引擎定价用的 legQuotes 是现订现撤,
 *   撤的可能正是持仓那条腿的常驻流,盯盘那一轮就得重订、多等一秒半。
 * * **建追踪不在这里写规则**:成交之后调的是装配时接进来的 tracker.add 那条路,入参和界面那张表单发的逐键相同。
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { comboNaturalPrice } from "../autoMid.js";
import { BrokerError, comboMidPrice } from "../broker.js";
import type { LegQuote } from "../broker.js";
import { withCombos } from "../combos.js";
import { nowEt } from "../config.js";
import type {
  FollowConfig, FollowEntry, FollowInboxState, FollowLink, FollowOutcome, FollowReaderState, FollowSeen, FollowStatus,
} from "../contract/follow.js";
import type { InstructionOrder } from "../contract/instruction.js";
import type { PositionRow } from "../contract/positions.js";
import type { Track, TrackerAddParams } from "../contract/tracker.js";
import { DiscordGateway } from "../discordGateway.js";
import type { DiscordMessage, GatewayOptions, GatewayPhase } from "../discordGateway.js";
import { resolveFanoutAccounts } from "../engine.js";
import { orderLegId } from "../engine/closing.js";
import { tryLocalShorthand } from "../engine/localShorthand.js";
import {
  decide, flyTrackParams, followQuote, leaderPrice, orderText, outcomeOf, pendingTracksOf, pendingVerdict, relativeCenterProblem,
  remainderVerdict, trackExitsText, triage, whyUnparsed,
} from "../follow.js";
import type { LeaderPrice, PendingFacts, PendingTrack } from "../follow.js";
import { FollowInbox, LOCAL_CHANNEL, inboxPath } from "../followInbox.js";
import type { InboxOptions } from "../followInbox.js";
import { FOLLOW_TEXT_MAX } from "../followLog.js";
import { FollowReader, readerProgram } from "../followReader.js";
import type { ReaderOptions } from "../followReader.js";
import { silenceLimitMs } from "../heldStreams.js";
import type { IbSession } from "../ibTypes.js";
import { ContractSpecSchema, OrderSpecSchema } from "../models.js";
import type { ContractSpec } from "../models.js";
import { OptionMarksError } from "../optionMarks.js";
import type { OptionMarkStreams } from "../optionMarks.js";
import { makeKey } from "../positions.js";
import { etDayStart } from "../protections.js";
import { RpcError } from "../rpcError.js";
import { readSecret, secretExists, writeSecret } from "../secrets.js";
import { LOCAL_MODEL } from "../shorthand.js";
import type { ShorthandMeta } from "../shorthand.js";
import { utcIso } from "../tz.js";
import { ServiceBase } from "./host.js";

/** bot token 在系统凭证库里的位置。 */
export const FOLLOW_KEYCHAIN_SERVICE = "dafri-discord-bot";
export const FOLLOW_KEYCHAIN_ACCOUNT = "token";

/** 记着频道里最近多少条消息(只在内存里)。 */
const SEEN_MAX = 30;
/** 处理过的消息 ID 记多少个(进程内去重;跨重启的去重在库里)。 */
const HANDLED_MAX = 2000;
/** 在等成交之后建追踪的蝴蝶存在偏好表的哪个键下。 */
const PENDING_PREF = "follow.pending_tracks";
/** 有蝴蝶在等的时候,隔多久核对一轮(成交了没有、持仓出来了没有)。只是核对的节拍,不进任何判断。 */
const TRACK_POLL_MS = 3_000;
/** 建追踪那一下不是因为入参被拒而失败(读持仓那一瞬间断了线之类),最多再试几轮;之后说清楚、不再试。 */
const TRACK_ADD_ATTEMPTS = 10;

/** 下场是这几种的信号才记盘口:解析出了恰好一张写明价格的单。没接住的、太旧的没有可比的价。 */
const QUOTED_OUTCOMES: ReadonlySet<FollowOutcome> = new Set(["sent", "held", "observed", "capped", "blocked", "rejected"]);

/** 一条信号里那张单:合约(取盘口、认持仓用)与对方写的价。 */
interface Signal {
  contract: ContractSpec;
  leader: LeaderPrice;
}

/** 装配时接进来的两样(rpc/server.ts):服务自己够不着 handler,行情流要和蝴蝶测算共用同一批。 */
export interface FollowWiring {
  /** tracker.add 的那个 handler:建追踪只走这一条路,和界面点出来的是同一条 */
  addTrack: (params: TrackerAddParams) => Promise<{ track: Track }>;
  /** 蝴蝶测算 / IV 记录共用的那批行情流(不碰盯盘的流) */
  marks: Pick<OptionMarkStreams, "read">;
}

const OUTCOME_LABEL: Record<FollowOutcome, string> = {
  sent: "已跟单",
  held: "没有发出",
  observed: "只观察",
  stale: "太旧,没跟",
  unparsed: "没接住,没跟",
  capped: "超上限,没跟",
  blocked: "闸门关着,没跟",
  rejected: "被拒",
};

/** 正在跟单的那一趟(从交给引擎到引擎返回)。 */
const followScope = new AsyncLocalStorage<true>();

/** 跟单那一趟里有人想调大模型。 */
export class FollowLocalOnlyError extends Error {}

/**
 * 给引擎的解析器加一道闸:跟单那一趟里调 `parse` 当场拒(抛的不是 LLMError,引擎不计解析失败、不碰熔断,原样抛回这里)。
 * 手动指令不在那一趟里,不受影响——两条路可以同时在跑,所以闸认的是调用链(AsyncLocalStorage),不是一个共享的开关。
 */
export function refuseModelWhileFollowing<T extends object>(parser: T): T {
  const target = parser as Record<string, unknown>;
  const original = target["parse"];
  if (typeof original !== "function") return parser;
  target["parse"] = (...args: unknown[]): unknown => {
    if (followScope.getStore() === true) {
      return Promise.reject(new FollowLocalOnlyError("跟单只认本地速记,这一条没有被完整接住,没有交给大模型"));
    }
    return (original as (...a: unknown[]) => unknown).apply(parser, args);
  };
  return parser;
}

export class FollowService extends ServiceBase {
  /** 怎么开 Gateway(测试注入假 socket) */
  gatewayOptions: GatewayOptions = {};
  /** 本地收件多久读一次文件(测试调短) */
  inboxOptions: InboxOptions = {};
  /** 读窗口的程序在哪、怎么起(测试注入);program 不给 = 看宿主给的环境变量 */
  readerOptions: ReaderOptions & { program?: string | null } = {};
  /** 建追踪走哪条路、盘口从哪批行情流取(见 attach);没接上 = 不建追踪、不记盘口 */
  private wiring: FollowWiring | null = null;

  private gateway: DiscordGateway | null = null;
  private inbox: FollowInbox | null = null;
  private reader: FollowReader | null = null;
  private started = false;
  private link: FollowLink = { state: "off", bot: null, error: null, channel_known: null };
  private readonly seen: FollowSeen[] = [];
  private readonly handled = new Set<string>();
  /** 消息排队处理 */
  private chain: Promise<void> = Promise.resolve();
  /** 起停排队:配置重载和重存 token 可能挨着来 */
  private syncChain: Promise<void> = Promise.resolve();
  /** 发单之后在后台做的事(记盘口):不占消息的队,这里只是让人等得到它们落定 */
  private readonly background = new Set<Promise<void>>();
  /** 核对在等的蝴蝶:同一时刻只跑一轮 */
  private trackRun: Promise<void> = Promise.resolve();
  private trackTimer: ReturnType<typeof setTimeout> | null = null;
  /** 记录 id → 单子走完之后已经连续几轮在持仓里找不到那只蝶 / 建追踪已经失败了几次(只在内存里,重启后从头数) */
  private readonly trackMisses = new Map<string, number>();
  private readonly trackFailures = new Map<string, number>();

  /** 装配(rpc/server.ts 调一次;测试注入假的)。 */
  attach(wiring: FollowWiring): void {
    this.wiring = wiring;
  }

  // ---- 连接的起停 ------------------------------------------------------
  /** 引擎真正的入口里调一次;没调过它,sync 什么都不做(测试里直接起的 server 不许去连 Discord)。 */
  start(): void {
    this.started = true;
    void this.sync();
    // 上次退出时还在等成交的蝴蝶存在库里:起来之后接着核对(没有在等的,这一轮之后就不再跑)
    this.armTrackTimer();
  }

  stop(): void {
    this.started = false;
    this.dropGateway();
    this.dropInbox();
    this.dropReader();
    if (this.trackTimer !== null) clearTimeout(this.trackTimer);
    this.trackTimer = null;
  }

  /**
   * 让连接和配置对上:没配频道 → 不连;配了 → 凭证库里有 token 就连。已经连着就不动(频道与信任名单是每条消息现读的)。
   * `restart`:丢掉现在的连接重来(重存了 token、或者在 Developer Portal 改好了设置之后点「重新连接」)。
   */
  sync(restart = false): Promise<void> {
    this.syncChain = this.syncChain.then(() => this.syncOnce(restart)).catch((exc: unknown) => {
      this.setLink({ state: "failed", error: `跟单连接没有起来:${(exc as Error).message}` });
    });
    return this.syncChain;
  }

  private async syncOnce(restart: boolean): Promise<void> {
    if (!this.started) return;
    this.syncInbox();
    this.syncReader();
    if (!this.settings.follow.channel_id) {
      this.dropGateway();
      this.setLink({ state: "off", bot: null, error: null });
      return;
    }
    if (this.gateway !== null && !restart) return;
    this.dropGateway();
    if (!(await secretExists(FOLLOW_KEYCHAIN_SERVICE, FOLLOW_KEYCHAIN_ACCOUNT))) {
      this.setLink({ state: "no_token", bot: null, error: null });
      return;
    }
    // 取 token 可能弹系统对话框问人(secrets.ts 有时限);超时与被拒都是一句人话,原样给界面
    const token = await readSecret(FOLLOW_KEYCHAIN_SERVICE, FOLLOW_KEYCHAIN_ACCOUNT);
    if (!this.started || !this.settings.follow.channel_id) return;
    if (!token) {
      this.setLink({ state: "no_token", bot: null, error: null });
      return;
    }
    const gateway = new DiscordGateway(token, {
      onMessage: (message) => {
        if (this.gateway === gateway) this.onMessage(message);
      },
      onPhase: (phase, error) => {
        if (this.gateway === gateway) this.onPhase(phase, error);
      },
    }, this.gatewayOptions);
    this.gateway = gateway;
    gateway.start();
  }

  private dropGateway(): void {
    const old = this.gateway;
    this.gateway = null;
    old?.stop();
  }

  /** 本地收件:开着就盯文件(路径跟着交易库走),关了就停。和 Discord 连接互不影响。 */
  private syncInbox(): void {
    const want = this.settings.follow.local_inbox ? inboxPath(this.settings.db_path) : null;
    if (this.inbox !== null && this.inbox.path === want) return;
    this.dropInbox();
    if (want === null) return;
    const inbox = new FollowInbox(want, {
      onMessage: (message) => {
        if (this.inbox === inbox) void this.onMessage(message);
      },
      onError: (error) => {
        if (this.inbox !== inbox) return;
        process.stderr.write(`[follow] 本地收件:${error}\n`);
        this.emit("follow", { kind: "inbox" });
      },
    }, this.inboxOptions);
    this.inbox = inbox;
    inbox.start();
    this.emit("follow", { kind: "inbox" });
  }

  private dropInbox(): void {
    const old = this.inbox;
    this.inbox = null;
    old?.stop();
  }

  /**
   * 读窗口的程序:本地收件开着、填了频道名、这台机器上有这个程序,就拉起来看着;频道名或收件文件换了就换一个。
   * 它只往收件文件里写,消息照旧由上面的 inbox 读进来——它没起来、起不来,手动运行的脚本照样管用。
   */
  private syncReader(): void {
    const cfg = this.settings.follow;
    const program = cfg.local_inbox && cfg.local_channel ? this.readerProgramPath() : null;
    const out = inboxPath(this.settings.db_path);
    const old = this.reader;
    if (old !== null && old.program === program && old.channel === cfg.local_channel && old.out === out) return;
    this.dropReader();
    if (program === null) return;
    const reader = new FollowReader(program, cfg.local_channel, out, {
      onStatus: () => {
        if (this.reader === reader) this.emit("follow", { kind: "inbox" });
      },
    }, this.readerOptions);
    this.reader = reader;
    reader.start();
    this.emit("follow", { kind: "inbox" });
  }

  private dropReader(): void {
    const old = this.reader;
    this.reader = null;
    old?.stop();
  }

  private readerProgramPath(): string | null {
    return this.readerOptions.program !== undefined ? this.readerOptions.program : readerProgram();
  }

  private readerView(): FollowReaderState {
    const cfg = this.settings.follow;
    if (!cfg.local_inbox) return { state: "off", title: null, error: null };
    if (!cfg.local_channel) return { state: "no_channel", title: null, error: null };
    const reader = this.reader;
    if (reader !== null) return reader.view;
    // 引擎还没真正起来(started 之前)也落在这里:说"还在起"不如照实说有没有这个程序
    return { state: this.readerProgramPath() === null ? "unavailable" : "starting", title: null, error: null };
  }

  /** 现在就读一次收件文件(测试用)。返回的 promise 在读到的消息都处理完之后落定。 */
  pollInbox(): Promise<void> {
    this.inbox?.poll();
    return this.chain;
  }

  /** 排着队的消息、以及它们之后在后台做的事(记盘口)都落定(测试用)。 */
  async settled(): Promise<void> {
    await this.chain;
    while (this.background.size) await Promise.all([...this.background]);
  }

  private inboxView(): FollowInboxState {
    const inbox = this.inbox;
    return {
      enabled: this.settings.follow.local_inbox,
      path: inboxPath(this.settings.db_path),
      watching: inbox !== null && inbox.watching,
      last_at: inbox?.lastAt ?? null,
      received: inbox?.received ?? 0,
      error: inbox?.error ?? null,
      reader: this.readerView(),
    };
  }

  private onPhase(phase: GatewayPhase, error: string | null): void {
    if (phase === "stopped") return;
    if (phase === "ready") {
      this.setLink({ state: "ready", bot: this.gateway?.bot ?? null, error: null });
      return;
    }
    if (phase === "failed") {
      this.setLink({ state: "failed", error });
      // 连不上了而且不会自己好:人不在这一页也得知道
      this.notify("Discord 跟单停了", error ?? "连接失败");
      return;
    }
    // 重连途中留着上一次的问题说明,连上了才清
    this.setLink({ state: "connecting", error: error ?? this.link.error });
  }

  private setLink(patch: Partial<FollowLink>): void {
    const next = { ...this.link, ...patch };
    const changed = next.state !== this.link.state || next.error !== this.link.error || next.bot !== this.link.bot;
    this.link = next;
    if (changed) this.emit("follow", { kind: "link", link: this.linkView() });
  }

  private linkView(): FollowLink {
    const gateway = this.gateway;
    const channel = this.settings.follow.channel_id;
    return {
      ...this.link,
      channel_known: gateway !== null && this.link.state === "ready" && gateway.guildsSeen ? gateway.channels.has(channel) : null,
    };
  }

  // ---- token -----------------------------------------------------------
  async setToken(token: string): Promise<void> {
    await writeSecret(FOLLOW_KEYCHAIN_SERVICE, FOLLOW_KEYCHAIN_ACCOUNT, token);
    this.engine.store.audit("ui", "follow_token_set", { service: FOLLOW_KEYCHAIN_SERVICE });
    await this.sync(true);
  }

  // ---- 一条消息 ---------------------------------------------------------
  /** Gateway 递来的每一条消息从这里进(测试也从这里喂)。返回的 promise 在这条消息处理完之后落定。 */
  onMessage(message: DiscordMessage): Promise<void> {
    const cfg = this.settings.follow;
    const verdict = triage(cfg, message, nowEt().epochMs);
    if (verdict.kind === "other_channel") return Promise.resolve();
    this.remember(message, cfg);
    if (verdict.kind === "untrusted" || verdict.kind === "chatter") return Promise.resolve();
    // 已经在处理(或处理过)的同一条:不再处理,只把队列交回去,等的人等到它走完
    if (this.handled.has(message.id)) return this.chain;
    this.handled.add(message.id);
    if (this.handled.size > HANDLED_MAX) this.handled.delete(this.handled.values().next().value ?? "");
    const stale = verdict.kind === "stale" ? verdict.detail : null;
    this.chain = this.chain.then(() => this.process(message, stale)).catch((exc: unknown) => {
      process.stderr.write(`[follow] 处理消息 ${message.id} 出错:${String((exc as Error).stack ?? exc)}\n`);
    });
    return this.chain;
  }

  private remember(message: DiscordMessage, cfg: FollowConfig): void {
    this.seen.unshift({
      at: utcIso(Math.floor(message.sentAtMs / 1000) * 1000),
      source: message.channel_id === LOCAL_CHANNEL ? "local" : "discord",
      author_id: message.author_id,
      author_name: message.author_name.slice(0, 80),
      text: message.content.slice(0, FOLLOW_TEXT_MAX),
      trusted: cfg.author_ids.includes(message.author_id),
    });
    if (this.seen.length > SEEN_MAX) this.seen.length = SEEN_MAX;
    this.emit("follow", { kind: "seen" });
  }

  private async process(message: DiscordMessage, stale: string | null): Promise<void> {
    const engine = this.engine;
    if (engine.store.follow.has(message.id)) return;
    // 摘掉 @everyone 这类提及再解析;交给引擎的也是这一份,日志里记原文
    const text = orderText(message.content);
    if (stale !== null) return this.conclude(message, { outcome: "stale", detail: stale, summary: "", record_ids: [] }, null);

    const cfg = this.settings.follow;
    const at = nowEt();
    const snap: Record<string, number> = {};
    const meta: ShorthandMeta = { relativeCenter: false };
    const payload: unknown = await tryLocalShorthand(engine, text, snap, at, meta);
    // 「N蝴蝶」是"现价的百位 + N":现价在两个百位之间时说不清是哪个。手动下单有人看摘要,跟单没有——不跟。
    // 放在判定之前:只观察时也要照实说"这条跟不了",不能记成"只观察"让人以为打开之后会跟上
    const edge = meta.relativeCenter ? relativeCenterProblem(payload, snap[parsedSymbol(payload) ?? ""] ?? Number.NaN) : null;
    if (edge !== null) return this.conclude(message, { outcome: "unparsed", detail: edge.detail, summary: edge.summary, record_ids: [] }, null);
    const router = this.router;
    const breaker = engine.killswitch.state();
    const decision = decide(cfg, payload, {
      breaker: breaker.engaged ? String(breaker.reason ?? "") : null,
      autoExecute: this.settings.policies.auto_execute,
      connected: router !== null && router.sessions().length > 0,
    }, this.sentToday());
    if (decision.outcome !== "send") {
      // 整句没接住时,说得出差的是哪一样就说(没写方向的价差);说不出就用通用的那句
      const detail = payload === null ? whyUnparsed(text) ?? decision.detail : decision.detail;
      return this.conclude(message, { outcome: decision.outcome, detail, summary: decision.summary, record_ids: [] }, payload);
    }

    let accounts: string[];
    try {
      accounts = resolveFanoutAccounts(this.settings, cfg.accounts);
    } catch (exc) {
      return this.conclude(message, { outcome: "blocked", detail: (exc as Error).message, summary: decision.summary, record_ids: [] }, payload);
    }
    // 这一遍必须拿到了标的现价:速记靠它核对"中心离现价太远 = 多半写错了",手动下单时这一步有人看着,跟单没有
    const symbol = parsedSymbol(payload);
    if (symbol === null || snap[symbol] === undefined) {
      return this.conclude(message, {
        outcome: "unparsed", summary: decision.summary, record_ids: [],
        detail: "拿不到这张单的标的现价,没法核对中心与方向,没有发单",
      }, null);
    }

    try {
      // 同一句话、同一个时刻、同一份现价交给引擎:它那一遍本地解析通常得出同一张单。引擎只保留它自己从这句话里
      // 抽出来的标的的现价,别的会重取——所以两遍之间现价可能差一点(中心的百位、看涨看跌跟着现价走),以引擎那一遍为准,
      // 摘要也取它的;跟单的单笔上限只看张数、权利金与翼宽,不随现价变。引擎现取:解析那一下配置可能重载过
      const result = await followScope.run(true, () => this.engine.handleInstruction(text, "discord", at, snap, accounts, false));
      if (result.llm !== null && result.llm.model !== LOCAL_MODEL) {
        // 不该发生(上面那道闸会先拒):发生了就留痕
        this.engine.store.audit("engine", "follow_model_used", { message: message.id, model: result.llm.model });
      }
      const placed = [...result.submitted, ...result.queued, ...result.validated_only][0];
      // 从这里往下引擎已经返回:单子发出去了(或者没发),后面做什么都不会让它晚
      return this.conclude(message, { ...outcomeOf(result), summary: placed?.intent_summary ?? decision.summary }, payload, result.submitted);
    } catch (exc) {
      const detail = exc instanceof FollowLocalOnlyError ? exc.message : `发单过程出错:${(exc as Error).message}`;
      return this.conclude(message, {
        outcome: exc instanceof FollowLocalOnlyError ? "unparsed" : "rejected", detail, summary: decision.summary, record_ids: [],
      }, payload);
    }
  }

  /**
   * 一条信号的收尾:落日志、发通知(finish),然后两件"之后的事"——
   * 发出去的蝴蝶登记成"等成交之后建追踪"(track_fly 开着时),以及在后台记一次盘口。
   * `payload` 是这里自己那一遍速记的产出;`submitted` 是引擎真发出去的那几笔(没走到发单就是空的)。
   */
  private conclude(
    message: DiscordMessage,
    result: { outcome: FollowOutcome; detail: string; summary: string; record_ids: string[] },
    payload: unknown,
    submitted: InstructionOrder[] = [],
  ): void {
    // 这两件事出了错只落一行日志:单子的下场已经定了,不能因为它们把一张发出去的单记成"出错"
    const quietly = <T>(what: string, fn: () => T): T | null => {
      try {
        return fn();
      } catch (exc) {
        process.stderr.write(`[follow] ${what}出错(不影响这条信号的下场):${String((exc as Error).message ?? exc)}\n`);
        return null;
      }
    };
    const tracking = result.outcome === "sent" ? quietly("登记待建的追踪", () => this.trackPlan(message, submitted)) : null;
    const entry = this.finish(message, tracking === null ? result : { ...result, detail: `${result.detail};${tracking.note}` });
    if (entry === null) return;
    if (tracking !== null && tracking.items.length) {
      quietly("登记待建的追踪", () => {
        this.savePending([...this.pendingList(), ...tracking.items]);
        this.armTrackTimer();
      });
    }
    if (!QUOTED_OUTCOMES.has(entry.outcome)) return;
    const signal = quietly("记盘口", () => this.signalFor(entry.record_ids, payload));
    if (signal !== null) this.later(() => this.recordQuote(message, signal));
  }

  private finish(
    message: DiscordMessage,
    result: { outcome: FollowOutcome; detail: string; summary: string; record_ids: string[] },
  ): FollowEntry | null {
    const entry: FollowEntry = {
      at: utcIso(Math.floor(nowEt().epochMs / 1000) * 1000),
      message_id: message.id,
      author_id: message.author_id,
      author_name: message.author_name.slice(0, 80),
      text: message.content.slice(0, FOLLOW_TEXT_MAX),
      ...result,
    };
    const store = this.engine.store;
    if (!store.follow.add(entry)) return null;
    store.audit("engine", "follow_signal", {
      message: entry.message_id, author: entry.author_id, outcome: entry.outcome, records: entry.record_ids,
    });
    this.emit("follow", { kind: "signal", entry });
    this.notify(
      `Discord 跟单:${OUTCOME_LABEL[entry.outcome]}`,
      `${entry.summary || entry.text}${entry.detail ? ` —— ${entry.detail}` : ""}`,
      entry.author_name,
    );
    return entry;
  }

  private notify(title: string, body: string, subtitle = ""): void {
    try {
      this.engine.notifier.notify(title, body, subtitle);
    } catch {
      /* 通知发不出去不该影响跟单本身 */
    }
  }

  /** 今天(美东)已经跟了几单:从日志里数,引擎重建、软件重启都不归零。 */
  private sentToday(): number {
    return this.engine.store.follow.sentSince(utcIso(etDayStart(nowEt().epochMs)));
  }

  // ---- 状态 -----------------------------------------------------------
  async status(): Promise<FollowStatus> {
    const cfg = this.settings.follow;
    return {
      config: { ...cfg, author_ids: [...cfg.author_ids], accounts: [...cfg.accounts] },
      token_configured: await secretExists(FOLLOW_KEYCHAIN_SERVICE, FOLLOW_KEYCHAIN_ACCOUNT),
      link: this.linkView(),
      today: { sent: this.sentToday(), max: cfg.max_orders_per_day },
      recent: this.engine.store.follow.recent(30),
      seen: this.seen.map((s) => ({ ...s, trusted: cfg.author_ids.includes(s.author_id) })),
      inbox: this.inboxView(),
      tracks_pending: this.pendingList().filter((item) => item.settled_fills === undefined).length,
    };
  }

  // ---- 延迟的代价:处理完之后记一次盘口 -----------------------------------
  /** 在后台跑一件事:不占消息的队,出什么错都只落一行日志。 */
  private later(task: () => Promise<void>): void {
    const run: Promise<void> = task()
      .catch((exc: unknown) => {
        process.stderr.write(`[follow] 记盘口出错(不影响跟单):${String((exc as Error).message ?? exc)}\n`);
      })
      .finally(() => {
        this.background.delete(run);
      });
    this.background.add(run);
  }

  /** 这条信号里的那张单。发出去的(或落了库的)以引擎那一遍为准,取它的交易记录;没落库的用这里自己解析的那一份。 */
  private signalFor(recordIds: string[], payload: unknown): Signal | null {
    for (const id of recordIds) {
      const signal = signalOf(this.engine.store.getRecord(id));
      if (signal !== null) return signal;
    }
    const orders = payload !== null && typeof payload === "object" ? (payload as { orders?: unknown }).orders : null;
    return Array.isArray(orders) && orders.length === 1 ? signalOf(orders[0]) : null;
  }

  /**
   * 取一次这张单各腿的盘口,和对方写的价一起记下。只在连着 IBKR 时做;没连、盘口不全、TWS 不答话,一律不记、不重试、不提醒——
   * 它只是事后看"晚了这几秒值多少钱"的一笔记录。行情取自盯盘用的同一条会话(sessions 的第一条),所以"是不是纸面"说的是这条会话。
   */
  private async recordQuote(message: DiscordMessage, signal: Signal): Promise<void> {
    const wiring = this.wiring, router = this.router;
    if (wiring === null || router === null || !router.sessions().length || this.settings.broker.provider !== "ibkr") return;
    const market = (router as { marketSession?: () => IbSession }).marketSession;
    if (typeof market !== "function") return;
    const legs = signal.contract.legs ?? [];
    if (!legs.length) return;
    let quotes: LegQuote[];
    let paper: boolean;
    try {
      const session = market.call(router);
      const managed = session.managedAccounts();
      // 和蝴蝶测算同一个口径:这条会话管的全是纸面账号(DU…)才按"可以退到延迟行情"订
      paper = managed.length > 0 && managed.every((id) => id.startsWith("D"));
      const got = await wiring.marks.read(
        session,
        legs.map((leg) => ({
          symbol: signal.contract.symbol, expiry: leg.lastTradeDateOrContractMonth, strike: leg.strike, right: leg.right,
          exchange: signal.contract.exchange, tradingClass: leg.tradingClass ?? "",
        })),
        paper, silenceLimitMs(this.settings.marketStatus(nowEt())),
      );
      quotes = legs.map((leg, i) => ({
        action: leg.action, ratio: leg.ratio, bid: got[i]?.bid ?? Number.NaN, ask: got[i]?.ask ?? Number.NaN,
      }));
    } catch (exc) {
      // 没连上、TWS 没回合约确认:就是"取不到",不算出错
      if (exc instanceof BrokerError || exc instanceof OptionMarksError) return;
      throw exc;
    }
    const at = nowEt().epochMs;
    let signed: { mid: number; natural: number };
    try {
      signed = { mid: comboMidPrice(quotes), natural: comboNaturalPrice(quotes) };
    } catch (exc) {
      if (exc instanceof BrokerError) return; // 有一条腿没有买价或卖价:拿它算出来的不是价
      throw exc;
    }
    const quote = followQuote(signal.leader, signed, at - message.sentAtMs, paper);
    if (quote === null) return;
    if (this.engine.store.follow.addQuote(message.id, utcIso(Math.floor(at / 1000) * 1000), quote)) {
      this.emit("follow", { kind: "quote", message_id: message.id });
    }
  }

  // ---- 跟进来的蝴蝶:成交之后建追踪 ---------------------------------------
  /** 现在在等的那几只(每次从库里读:引擎会重建、软件会重启,内存里不留一份会过期的)。 */
  private pendingList(): PendingTrack[] {
    return pendingTracksOf(this.engine.store.getPref(PENDING_PREF));
  }

  private savePending(items: PendingTrack[]): void {
    this.engine.store.setPref(PENDING_PREF, items);
    const live = new Set(items.map((item) => item.record_id));
    for (const book of [this.trackMisses, this.trackFailures]) {
      for (const id of [...book.keys()]) if (!live.has(id)) book.delete(id);
    }
    this.emit("follow", { kind: "track" });
  }

  /**
   * 刚发出去的这几笔里,哪些要在成交之后建追踪,以及日志那一行该补哪句话。track_fly 关着回 null(什么都不补)。
   * 只管买入的蝴蝶;贷方价差照发、不建——蝶式预设不是给贷方结构定的,套上去的线没有意义。
   */
  private trackPlan(message: DiscordMessage, submitted: InstructionOrder[]): { items: PendingTrack[]; note: string } | null {
    const cfg = this.settings.follow;
    if (!cfg.track_fly || !submitted.length) return null;
    const items: PendingTrack[] = [];
    for (const order of submitted) {
      const signal = signalOf(this.engine.store.getRecord(order.record_id));
      if (signal === null || signal.leader.side !== "debit") continue;
      items.push({
        record_id: order.record_id, message_id: message.id, account: order.account, symbol: signal.contract.symbol,
        leg: orderLegId({ contract: signal.contract }), summary: order.intent_summary, at_ms: nowEt().epochMs,
      });
    }
    const note = items.length
      ? `成交后自动建持仓追踪(蝶式预设、到价自动平仓${cfg.track_exit_at ? `、美东 ${cfg.track_exit_at} 到点平仓` : ""})`
      : "这一单不是买入的蝴蝶,不自动建追踪,平仓由你自己管";
    return { items, note };
  }

  /** 有蝴蝶在等就定一个下一轮(只在引擎真正起来之后;测试里直接调 trackTick)。 */
  private armTrackTimer(): void {
    if (!this.started || this.trackTimer !== null) return;
    const timer = setTimeout(() => {
      this.trackTimer = null;
      void this.trackTick().then(() => {
        if (this.pendingCount() > 0) this.armTrackTimer();
      });
    }, TRACK_POLL_MS);
    timer.unref?.();
    this.trackTimer = timer;
  }

  private pendingCount(): number {
    try {
      return this.pendingList().length;
    } catch {
      return 0; // 库这一下读不了:不为核对追踪把别的拖下水,下一条跟单会重新定时
    }
  }

  /** 核对一轮在等的蝴蝶。返回的 promise 在这一轮走完之后落定;出了错只落一行日志。 */
  trackTick(): Promise<void> {
    this.trackRun = this.trackRun.then(() => this.trackOnce()).catch((exc: unknown) => {
      process.stderr.write(`[follow] 核对待建的追踪出错:${String((exc as Error).stack ?? exc)}\n`);
    });
    return this.trackRun;
  }

  private async trackOnce(): Promise<void> {
    const items = this.pendingList();
    if (!items.length) return;
    const cfg = this.settings.follow;
    if (!cfg.enabled || !cfg.track_fly) {
      // 授权收回了(跟单关了,或者这一项关了):在等的一律不建。关掉自动化不该比打开它难
      const waiting = items.filter((item) => item.settled_fills === undefined);
      for (const item of waiting) this.auditDropped(item, "switched_off");
      this.savePending([]);
      if (waiting.length) {
        this.notify(
          "Discord 跟单:不再自动建追踪",
          `自动跟单或「成交后自动建追踪」已经关掉:还在等成交的 ${waiting.length} 只蝴蝶,成交之后不会自动建追踪,平仓由你自己管。`,
        );
      }
      return;
    }
    const nowMs = nowEt().epochMs;
    const store = this.engine.store;
    const orders = new Map(items.map((item) => [item.record_id, orderFacts(store.getRecord(item.record_id))]));
    // 持仓只在有还没建追踪的单子成交了的时候才读:一张限价单可能挂上几个小时,这段时间里每几秒读一遍持仓没有用处
    const needRows = items.some((item) => item.settled_fills === undefined && orders.get(item.record_id)?.filled === true);
    const rows = needRows ? await this.positionRows() : null;
    const router = this.router;
    const covered = (router as { coveredAccounts?: () => Set<string> } | null)?.coveredAccounts?.() ?? null;
    const keep: PendingTrack[] = [];
    for (const item of items) {
      try {
        const order = orders.get(item.record_id) ?? { filled: false, final: true, fills: 0 };
        const next = await this.settleOne(item, order, cfg.track_exit_at, nowMs, rows, covered);
        if (next !== null) keep.push(next);
      } catch (exc) {
        // 这一只这一轮没看成(库这一下读不了之类):留着下一轮再看,别的照常
        process.stderr.write(`[follow] 核对待建的追踪 ${item.record_id} 出错:${String((exc as Error).message ?? exc)}\n`);
        keep.push(item);
      }
    }
    // 这一轮里又有新的蝴蝶登记进来(消息不等这里):留着它们。名单没变就不写库、不惊动界面
    const known = new Set(items.map((item) => item.record_id));
    const next = [...keep, ...this.pendingList().filter((item) => !known.has(item.record_id))];
    if (JSON.stringify(next) !== JSON.stringify(items)) this.savePending(next);
  }

  /**
   * 一只在等的蝶这一轮怎么办;回要留到下一轮的那一条(可能改过),不留回 null。
   * `order` 是它那张单此刻的样子,`rows` 是这一轮读到的持仓(没读、读不到是 null)。
   */
  private async settleOne(
    item: PendingTrack, order: OrderFacts, exitAt: string, nowMs: number, rows: PositionRow[] | null, covered: Set<string> | null,
  ): Promise<PendingTrack | null> {
    const store = this.engine.store;
    const key = makeKey(item.account, item.symbol, "BAG", item.leg);
    const existing = store.listTracks().find((t) => makeKey(t.account, t.symbol, t.sec_type || "STK", t.leg || "") === key);
    const track: PendingFacts["track"] = existing === undefined ? "none" : existing.enabled && !existing.fired_at ? "active" : "idle";
    // 追踪已经有了着落、单子还没走完:只看它后来有没有再成交
    if (item.settled_fills !== undefined) {
      const verdict = remainderVerdict(item, { nowMs, final: order.final, fills: order.fills, track });
      if (verdict === "wait") return item;
      if (verdict === "absorbed") return { ...item, settled_fills: order.fills };
      if (verdict === "late_fill") {
        this.auditDropped(item, verdict);
        this.notify(
          "Discord 跟单:后成交的部分没有追踪",
          `${item.summary} —— 这张单后来又有成交,而这只蝶上的追踪已经触发过(或已停用、被删掉):后成交的部分现在没有追踪在盯,请自己到「持仓追踪」里处理。`,
        );
      }
      return null;
    }
    const readable = rows !== null && (covered === null || covered.has(item.account));
    const row = readable ? (rows ?? []).find((r) => r.key === key && r.quantity > 0) : undefined;
    const held = readable ? row !== undefined : null;
    // 单子走完了、有成交,持仓里却没有:数着,连续几轮都这样才下结论;别的情形清零
    const misses = order.filled && order.final && held === false ? (this.trackMisses.get(item.record_id) ?? 0) + 1 : 0;
    this.trackMisses.set(item.record_id, misses);
    const verdict = pendingVerdict(item, { nowMs, filled: order.filled, final: order.final, held, misses, track });
    if (verdict === "wait") return item;
    // 追踪有了着落(建好了 / 沿用已有的)而单子还挂着:留着看它后来的成交
    const settled = order.final ? null : { ...item, settled_fills: order.fills };
    if (verdict === "create") {
      const outcome = await this.createTrack(item, key, exitAt, nowMs, row?.quantity ?? 0);
      return outcome === "retry" ? item : outcome === "created" ? settled : null;
    }
    this.auditDropped(item, verdict);
    const why = DROP_TEXT[verdict];
    if (verdict === "covered" && existing !== undefined) {
      this.notify("Discord 跟单:沿用已有的追踪", `${item.summary} —— ${why}(${trackExitsText(existing, nowMs)})`);
      return settled;
    }
    if (why) this.notify("Discord 跟单:没有建追踪", `${item.summary} —— ${why}`);
    return null;
  }

  /** 此刻的持仓行(带组合行);没连券商、读不到回 null——读不到不等于没有。读法和「持仓追踪」页那一头相同。 */
  private async positionRows(): Promise<PositionRow[] | null> {
    const router = this.router;
    if (router === null || !router.sessions().length) return null;
    try {
      return withCombos(await router.positions());
    } catch {
      return null;
    }
  }

  /**
   * 建一条追踪。retry = 这一轮没建成、下一轮再试;refused = 建不了,已经说明原因,不再试。
   * 入参被拒(同一条 tracker.add 的校验)当场算 refused。`held` 是持仓里这只蝶现在有几张:追踪管的是整份持仓,
   * 账户里本来就有同一只蝶时比跟进来的多,通知里照实写。
   */
  private async createTrack(
    item: PendingTrack, key: string, exitAt: string, nowMs: number, held: number,
  ): Promise<"created" | "retry" | "refused"> {
    const store = this.engine.store;
    try {
      const add = this.wiring?.addTrack;
      if (add === undefined) throw new Error("建追踪的通道没有接上");
      // 到点平仓的钟点对这只蝶已经用不上(今天的已经过了,下一次落在它到期之后):tracker.add 会拒。这时追踪照建、只是不带到点平仓——
      // 因为一个用不上的钟点让整条追踪建不成,那份持仓就什么保护都没有了
      let dropped = "";
      const { track } = await add(flyTrackParams(key, exitAt)).catch((exc: unknown) => {
        if (!exitAt || !(exc instanceof RpcError) || exc.code !== -32602 || !exc.message.startsWith("到点平仓")) throw exc;
        dropped = `;美东 ${exitAt} 的到点平仓对这只蝶用不上(下一次到点已经在它到期之后),这条追踪没有带`;
        return add(flyTrackParams(key, ""));
      });
      const exits = `${trackExitsText(track, nowMs)}${dropped}`;
      store.audit("engine", "follow_track", {
        message: item.message_id, record: item.record_id, account: item.account, symbol: item.symbol, leg: item.leg,
        track: track.id, targets: track.targets, auto_close: track.auto_close,
      });
      this.notify(
        "Discord 跟单:已建持仓追踪",
        `${item.summary} —— 这只蝶现在持有 ${held} 张,追踪管的是这一整份:${exits}。对方自己什么时候走,软件仍然不知道。`,
      );
      return "created";
    } catch (exc) {
      const reason = String((exc as Error).message ?? exc);
      const refused = exc instanceof RpcError && exc.code === -32602;
      const failures = (this.trackFailures.get(item.record_id) ?? 0) + 1;
      this.trackFailures.set(item.record_id, failures);
      if (!refused && failures < TRACK_ADD_ATTEMPTS) return "retry";
      store.audit("engine", "follow_track_failed", { message: item.message_id, record: item.record_id, leg: item.leg, error: reason.slice(0, 300) });
      this.notify(
        "Discord 跟单:没有建追踪",
        `${item.summary} —— ${refused ? reason : `试了 ${failures} 次都没建成(${reason})`}。这只蝶现在没有追踪在盯,请自己到「持仓追踪」里设。`,
      );
      return "refused";
    }
  }

  private auditDropped(item: PendingTrack, reason: string): void {
    this.engine.store.audit("engine", "follow_track_dropped", {
      message: item.message_id, record: item.record_id, account: item.account, leg: item.leg, reason,
    });
  }
}

/** 不建追踪的几种下场各说什么(空串 = 不提醒:单子没成交,本来就没有持仓)。 */
const DROP_TEXT: Record<"expired" | "unfilled" | "covered" | "idle_track" | "no_position", string> = {
  unfilled: "",
  expired: "隔了一天仍没有等到这张单的成交回报,不再等;它之后成交的话不会自动建追踪,请自己到「持仓追踪」里设",
  covered: "这只蝶已经有一条在盯的追踪,没有另建:同一份持仓只能有一条,加进来的数量由它按触发那一刻的持仓一起平",
  idle_track: "同一只蝶上留着一条已停用(或已触发过)的旧追踪,同一份持仓只能有一条,软件不替你删。这一单现在没有追踪在盯:" +
    "请到「持仓追踪」删掉旧的再建,或重新启用它",
  no_position: "这张单成交了,但持仓里找不到这只蝶(已经平掉了,或者它的腿和同一到期日的别的持仓并在了一起),没有建追踪,请自己到「持仓追踪」里看",
};

/** 一条交易记录(或速记产出里的一张单)里的合约与对方写的价;不是跟单认的那两种、形状不对回 null。 */
function signalOf(item: unknown): Signal | null {
  if (item === null || typeof item !== "object") return null;
  const contract = ContractSpecSchema.safeParse((item as { contract?: unknown }).contract);
  const order = OrderSpecSchema.safeParse((item as { order?: unknown }).order);
  if (!contract.success || !order.success) return null;
  const leader = leaderPrice(contract.data, order.data);
  return leader === null ? null : { contract: contract.data, leader };
}

/** 一条交易记录此刻说的三件事:有没有成交过、走没走完、已经有几条成交回报(只增不减,用来认"后来又成交了")。 */
interface OrderFacts {
  filled: boolean;
  final: boolean;
  fills: number;
}

/** 记录读不到(库被换了)按"走完了、没成交"算:没有可等的。 */
function orderFacts(record: unknown): OrderFacts {
  if (record === null || typeof record !== "object") return { filled: false, final: true, fills: 0 };
  const status = (record as { final_status?: unknown }).final_status;
  const ibkr = (record as { ibkr?: { fills?: unknown; status_timeline?: unknown } }).ibkr;
  const fills = Array.isArray(ibkr?.fills) ? ibkr.fills.length : 0;
  const timeline: unknown[] = Array.isArray(ibkr?.status_timeline) ? ibkr.status_timeline : [];
  const reported = timeline.some((row) => row !== null && typeof row === "object" && (row as { status?: unknown }).status === "Filled");
  return {
    filled: fills > 0 || reported || status === "filled" || status === "partially_filled",
    final: typeof status === "string" && status !== "",
    fills,
  };
}

/** 速记产出里那张单的标的;形状不对回 null。 */
function parsedSymbol(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const orders = (payload as { orders?: unknown }).orders;
  if (!Array.isArray(orders) || orders.length !== 1) return null;
  const contract = (orders[0] as { contract?: { symbol?: unknown } } | null)?.contract;
  return typeof contract?.symbol === "string" && contract.symbol ? contract.symbol : null;
}
