/** Discord 跟单(docs/features/follow.md):bot 读一个频道,信任的人发的蝴蝶速记不经确认直接走发单链路。
 *
 * 这里管三件事:两个来源的起停(Gateway 连接:配了频道、凭证库里有 token 才连;本地收件:开关开着就盯文件)、
 * 每条消息从判定到发单的那一趟、给界面的状态。规则在 follow.ts(纯函数),协议在 discordGateway.ts,收件文件在 followInbox.ts。
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
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { nowEt } from "../config.js";
import type { FollowConfig, FollowEntry, FollowInboxState, FollowLink, FollowOutcome, FollowSeen, FollowStatus } from "../contract/follow.js";
import { DiscordGateway } from "../discordGateway.js";
import type { DiscordMessage, GatewayOptions, GatewayPhase } from "../discordGateway.js";
import { resolveFanoutAccounts } from "../engine.js";
import { tryLocalShorthand } from "../engine/localShorthand.js";
import { decide, outcomeOf, relativeCenterProblem, triage } from "../follow.js";
import { FollowInbox, LOCAL_CHANNEL, inboxPath } from "../followInbox.js";
import type { InboxOptions } from "../followInbox.js";
import { FOLLOW_TEXT_MAX } from "../followLog.js";
import { etDayStart } from "../protections.js";
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

  private gateway: DiscordGateway | null = null;
  private inbox: FollowInbox | null = null;
  private started = false;
  private link: FollowLink = { state: "off", bot: null, error: null, channel_known: null };
  private readonly seen: FollowSeen[] = [];
  private readonly handled = new Set<string>();
  /** 消息排队处理 */
  private chain: Promise<void> = Promise.resolve();
  /** 起停排队:配置重载和重存 token 可能挨着来 */
  private syncChain: Promise<void> = Promise.resolve();

  // ---- 连接的起停 ------------------------------------------------------
  /** 引擎真正的入口里调一次;没调过它,sync 什么都不做(测试里直接起的 server 不许去连 Discord)。 */
  start(): void {
    this.started = true;
    void this.sync();
  }

  stop(): void {
    this.started = false;
    this.dropGateway();
    this.dropInbox();
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

  /** 现在就读一次收件文件(测试用)。返回的 promise 在读到的消息都处理完之后落定。 */
  pollInbox(): Promise<void> {
    this.inbox?.poll();
    return this.chain;
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
    const text = message.content.normalize("NFKC").trim();
    if (stale !== null) return this.finish(message, { outcome: "stale", detail: stale, summary: "", record_ids: [] });

    const cfg = this.settings.follow;
    const at = nowEt();
    const snap: Record<string, number> = {};
    const meta: ShorthandMeta = { relativeCenter: false };
    const payload: unknown = await tryLocalShorthand(engine, text, snap, at, meta);
    // 「N蝴蝶」是"现价的百位 + N":现价在两个百位之间时说不清是哪个。手动下单有人看摘要,跟单没有——不跟。
    // 放在判定之前:只观察时也要照实说"这条跟不了",不能记成"只观察"让人以为打开之后会跟上
    const edge = meta.relativeCenter ? relativeCenterProblem(payload, snap[parsedSymbol(payload) ?? ""] ?? Number.NaN) : null;
    if (edge !== null) return this.finish(message, { outcome: "unparsed", detail: edge.detail, summary: edge.summary, record_ids: [] });
    const router = this.router;
    const breaker = engine.killswitch.state();
    const decision = decide(cfg, payload, {
      breaker: breaker.engaged ? String(breaker.reason ?? "") : null,
      autoExecute: this.settings.policies.auto_execute,
      connected: router !== null && router.sessions().length > 0,
    }, this.sentToday());
    if (decision.outcome !== "send") {
      return this.finish(message, { outcome: decision.outcome, detail: decision.detail, summary: decision.summary, record_ids: [] });
    }

    let accounts: string[];
    try {
      accounts = resolveFanoutAccounts(this.settings, cfg.accounts);
    } catch (exc) {
      return this.finish(message, { outcome: "blocked", detail: (exc as Error).message, summary: decision.summary, record_ids: [] });
    }
    // 这一遍必须拿到了标的现价:速记靠它核对"中心离现价太远 = 多半写错了",手动下单时这一步有人看着,跟单没有
    const symbol = parsedSymbol(payload);
    if (symbol === null || snap[symbol] === undefined) {
      return this.finish(message, {
        outcome: "unparsed", summary: decision.summary, record_ids: [],
        detail: "拿不到这张单的标的现价,没法核对中心与方向,没有发单",
      });
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
      return this.finish(message, { ...outcomeOf(result), summary: placed?.intent_summary ?? decision.summary });
    } catch (exc) {
      const detail = exc instanceof FollowLocalOnlyError ? exc.message : `发单过程出错:${(exc as Error).message}`;
      return this.finish(message, {
        outcome: exc instanceof FollowLocalOnlyError ? "unparsed" : "rejected", detail, summary: decision.summary, record_ids: [],
      });
    }
  }

  private finish(
    message: DiscordMessage,
    result: { outcome: FollowOutcome; detail: string; summary: string; record_ids: string[] },
  ): void {
    const entry: FollowEntry = {
      at: utcIso(Math.floor(nowEt().epochMs / 1000) * 1000),
      message_id: message.id,
      author_id: message.author_id,
      author_name: message.author_name.slice(0, 80),
      text: message.content.slice(0, FOLLOW_TEXT_MAX),
      ...result,
    };
    const store = this.engine.store;
    if (!store.follow.add(entry)) return;
    store.audit("engine", "follow_signal", {
      message: entry.message_id, author: entry.author_id, outcome: entry.outcome, records: entry.record_ids,
    });
    this.emit("follow", { kind: "signal", entry });
    this.notify(
      `Discord 跟单:${OUTCOME_LABEL[entry.outcome]}`,
      `${entry.summary || entry.text}${entry.detail ? ` —— ${entry.detail}` : ""}`,
      entry.author_name,
    );
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
    };
  }
}

/** 速记产出里那张单的标的;形状不对回 null。 */
function parsedSymbol(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const orders = (payload as { orders?: unknown }).orders;
  if (!Array.isArray(orders) || orders.length !== 1) return null;
  const contract = (orders[0] as { contract?: { symbol?: unknown } } | null)?.contract;
  return typeof contract?.symbol === "string" && contract.symbol ? contract.symbol : null;
}
