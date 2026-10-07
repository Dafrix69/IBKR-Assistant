/** Discord 跟单的服务:一条频道消息从判定到发单的那一趟,以及 Discord 连接的起停。
 *
 * 全部离线:消息直接喂给 onMessage,引擎是真的(校验、落库都走),券商是假的(只记下发了什么),
 * Discord 的 socket 与凭证库都是假的。
 */
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setClock } from "../src/config.js";
import type { FollowConfig } from "../src/contract/follow.js";
import type { DiscordMessage, SocketLike } from "../src/discordGateway.js";
import { TradingEngine } from "../src/engine.js";
import { Notifier } from "../src/notify.js";
import { LLMResponse } from "../src/providers.js";
import { useSecretBackend } from "../src/secrets.js";
import { FOLLOW_KEYCHAIN_ACCOUNT, FOLLOW_KEYCHAIN_SERVICE, FollowService, refuseModelWhileFollowing } from "../src/services/follow.js";
import type { ServiceHost } from "../src/services/host.js";
import { TradeStore } from "../src/store.js";
import { loadGolden, makeSettings } from "./util.js";

const gc = loadGolden("config");
const CHANNEL = "1100000000000000001";
const FRIEND = "220000000000000002";
const STRANGER = "330000000000000003";
const NOW = Date.UTC(2026, 7, 14, 14, 32, 0); // 美东周五 10:32,常规时段

class FakeRouter {
  placed: Array<{ recordId: string; approved: any }> = [];
  BROKER = "ibkr";
  connected = true;
  /** 每个标的依次给出的现价;用完了之后一直给最后一个 */
  prices: Record<string, Array<number | null>> = { SPX: [6907.35] };
  asked: string[] = [];
  sessions(): unknown[] { return this.connected ? [{}] : []; }
  async indexPrice(symbol: string): Promise<number | null> {
    this.asked.push(symbol);
    const queue = this.prices[symbol] ?? [null];
    return queue.length > 1 ? queue.shift()! : queue[0] ?? null;
  }
  async place(recordId: string, approved: any, limitOverride: number | null = null) {
    this.placed.push({ recordId, approved });
    return { record_id: recordId, order_id: 1024 + this.placed.length, perm_id: 7788, status: "Submitted", limit_price: limitOverride, detail: {} };
  }
  async legQuotes() { return []; }
  async positions() { return []; }
}

let serial = 0;
/** 一条频道消息;ageMs = 它是多久之前发的。 */
function message(content: string, patch: { author?: string; channel?: string; ageMs?: number; id?: string } = {}): DiscordMessage {
  const sentAtMs = NOW - (patch.ageMs ?? 1000);
  serial += 1;
  return {
    id: patch.id ?? String(((BigInt(sentAtMs) - 1420070400000n) << 22n) + BigInt(serial)),
    channel_id: patch.channel ?? CHANNEL,
    author_id: patch.author ?? FRIEND,
    author_name: patch.author === STRANGER ? "路人" : "老王",
    content,
    sentAtMs,
  };
}

function build(follow: Partial<FollowConfig> = {}, policies: Record<string, unknown> = { auto_execute: true }) {
  const dir = mkdtempSync(path.join(tmpdir(), "dafri-follow-"));
  const settings = makeSettings(gc.base_config, {
    storage: { db_path: path.join(dir, "f.db") },
    policies,
    follow: { enabled: true, channel_id: CHANNEL, author_ids: [FRIEND], ...follow },
  });
  const modelCalls: string[] = [];
  // 大模型要是被叫到,就回一张"买 100 股 AAPL":跟单路径上它一旦出场,测试里就会多出一张不该有的单
  const parser = refuseModelWhileFollowing({
    async parse(_bundle: unknown, userMessage: string): Promise<LLMResponse> {
      modelCalls.push(userMessage);
      return new LLMResponse(JSON.stringify({
        orders: [{
          intent_summary: "限价 230 买入 100 股 AAPL",
          contract: { secType: "STK", symbol: "AAPL", exchange: "SMART", currency: "USD" },
          execution_type: "IMMEDIATE", trigger: null, account: "DEFAULT",
          order: { action: "BUY", orderType: "LMT", totalQuantity: 100, price_mode: "EXPLICIT", lmtPrice: 230.0, tif: "DAY", outsideRth: false },
          reason: "模型编的", confidence: 0.99, warnings: [],
        }],
        rejections: [],
      }), "claude-opus-5", "v", "f", 42);
    },
  });
  const router = new FakeRouter();
  const notes: Array<[string, string, string]> = [];
  const engine = new TradingEngine({
    settings, parser: parser as any, store: new TradeStore(settings.db_path),
    notifier: new Notifier(false, [(title, subtitle, body) => notes.push([title, subtitle, body])]), router: router as any,
  });
  engine.publicPriceFn = async () => null;
  const events: Array<[string, Record<string, any>]> = [];
  const host = {
    settings, router: router as any, engine,
    emit: (event: string, payload: Record<string, any>) => { events.push([event, payload]); },
  };
  const service = new FollowService(host as ServiceHost);
  const log = () => engine.store.follow.recent(50);
  return { service, engine, router, host, events, notes, modelCalls, log };
}

beforeEach(() => {
  setClock(NOW);
});
afterEach(() => {
  setClock(null);
  useSecretBackend(null);
});

describe("follow service: 「N蝴蝶」在百位边上", () => {
  it("现价 6990、「00蝴蝶」算成 6900(离 90 点):不发单,记成没接住并写明原因;写明完整中心的照跟", async () => {
    const { service, router, log } = build();
    router.prices["SPX"] = [6990];
    await service.onMessage(message("00蝴蝶 15CM 1.8"));
    expect(router.placed).toHaveLength(0);
    expect(log()[0]).toMatchObject({ outcome: "unparsed" });
    expect(log()[0]!.detail).toContain("中心 6900");
    expect(log()[0]!.detail).toContain("7000蝴蝶");
    await service.onMessage(message("7000蝴蝶 15CM 1.8"));
    expect(router.placed).toHaveLength(1);
    expect(log()[0]).toMatchObject({ outcome: "sent" });
  });

  it("只观察时也一样说「没接住」,不能记成「只观察」让人以为打开之后会跟上", async () => {
    const { service, router, log } = build({ enabled: false });
    router.prices["SPX"] = [6990];
    await service.onMessage(message("00蝴蝶 15CM 1.8"));
    expect(log()[0]).toMatchObject({ outcome: "unparsed" });
    expect(router.placed).toHaveLength(0);
  });

  it("现价 6907.35、「00蝴蝶」算成 6900(离 7 点):照跟", async () => {
    const { service, router, log } = build();
    await service.onMessage(message("00蝴蝶 15CM 1.8"));
    expect(router.placed).toHaveLength(1);
    expect(log()[0]).toMatchObject({ outcome: "sent" });
  });
});

describe("follow service: 本地收件", () => {
  const line = (content: string, key: string): string =>
    JSON.stringify({ v: 1, key, seen_at: new Date(NOW - 1000).toISOString(), channel: "charlie的策略", author: "老王", time_label: "22:31", content }) + "\n";

  it("开着本地收件、没填频道:不连 Discord,收件文件里信任的人的蝴蝶速记照样发单,来源记成 discord、发送者是显示名", async () => {
    const { service, host, router, log, modelCalls } = build({ channel_id: "", author_ids: ["local:老王"], local_inbox: true });
    service.start();
    await service.sync();
    let status = await service.status();
    expect(status.link.state).toBe("off");
    expect(status.inbox).toMatchObject({ enabled: true, watching: true, received: 0, error: null });
    expect(status.inbox.path).toBe(path.join(path.dirname(host.settings.db_path), "follow-inbox.jsonl"));
    appendFileSync(status.inbox.path, line("1.8 挂15蝴蝶 15CM", "m1"));
    await service.pollInbox();
    expect(router.placed).toHaveLength(1);
    expect(modelCalls).toEqual([]);
    expect(log()[0]).toMatchObject({ outcome: "sent", message_id: "local:m1", author_id: "local:老王", author_name: "老王" });
    status = await service.status();
    expect(status.inbox.received).toBe(1);
    expect(status.seen[0]).toMatchObject({ source: "local", author_id: "local:老王", trusted: true });
    service.stop();
    expect((await service.status()).inbox.watching).toBe(false);
  });

  it("关着本地收件:文件里有什么都不看;陌生显示名只进「最近看到的消息」", async () => {
    const { service, router, log } = build({ channel_id: "", author_ids: ["local:老王"], local_inbox: false });
    service.start();
    await service.sync();
    expect((await service.status()).inbox.watching).toBe(false);
    const { service: s2, router: r2, log: log2 } = build({ channel_id: "", author_ids: ["local:老王"], local_inbox: true });
    s2.start();
    await s2.sync();
    const file = (await s2.status()).inbox.path;
    appendFileSync(file, JSON.stringify({ v: 1, key: "x", seen_at: new Date(NOW - 1000).toISOString(), channel: "c", author: "路人", time_label: "", content: "1.8 挂15蝴蝶 15CM" }) + "\n");
    await s2.pollInbox();
    expect(r2.placed).toHaveLength(0);
    expect(log2()).toHaveLength(0);
    expect((await s2.status()).seen[0]).toMatchObject({ source: "local", author_id: "local:路人", trusted: false });
    s2.stop();
    service.stop();
    expect(router.placed).toHaveLength(0);
    expect(log()).toHaveLength(0);
  });
});

describe("follow service: 跟一单", () => {
  it("信任的人发的蝴蝶速记 → 不经确认发到券商,记录的来源是 discord,大模型没有出场", async () => {
    const { service, engine, router, log, modelCalls, notes, events } = build();
    await service.onMessage(message("1.8 挂15蝴蝶 15CM"));
    expect(router.placed).toHaveLength(1);
    const { approved } = router.placed[0]!;
    expect(approved.order.contract.combo_strategy).toBe("BUTTERFLY");
    expect(approved.order.contract.legs.map((l: any) => l.strike)).toEqual([6900, 6915, 6930]);
    expect(approved.order.order.lmtPrice).toBe(1.8);
    expect(approved.account.alias).toBe("模拟");
    expect(modelCalls).toEqual([]);

    const [entry] = log();
    expect(entry).toMatchObject({ outcome: "sent", author_id: FRIEND, author_name: "老王", text: "1.8 挂15蝴蝶 15CM" });
    expect(entry!.summary).toContain("6900/6915/6930");
    expect(entry!.record_ids).toEqual([router.placed[0]!.recordId]);
    const record = engine.store.getRecord(entry!.record_ids[0]!) as any;
    expect(record.input.input_channel).toBe("discord");
    expect(notes.some(([title]) => title === "Discord 跟单:已跟单")).toBe(true);
    expect(events.some(([event, payload]) => event === "follow" && payload["kind"] === "signal")).toBe(true);
  });

  it("配了两个账户就各发一份;实盘闸门没开的那一份被拒,写进说明", async () => {
    const { service, router, log } = build({ accounts: ["模拟", "主账户"] });
    await service.onMessage(message("1.8 挂15蝴蝶 15CM"));
    expect(router.placed.map((p) => p.approved.account.alias)).toEqual(["模拟"]);
    expect(log()[0]!.outcome).toBe("sent");
    expect(log()[0]!.detail).toContain("1 笔被拒");
  });

  it("同一条消息来两次(断线补发)只发一次", async () => {
    const { service, router, log } = build();
    const m = message("1.8 挂15蝴蝶 15CM");
    await Promise.all([service.onMessage(m), service.onMessage({ ...m })]);
    expect(router.placed).toHaveLength(1);
    expect(log()).toHaveLength(1);
  });

  it("库里已经处理过的消息(引擎重启之后又收到)不再发", async () => {
    const first = build();
    const m = message("1.8 挂15蝴蝶 15CM");
    await first.service.onMessage(m);
    // 换一个服务实例(进程内的去重表是空的),库还是那一个
    const again = new FollowService(first.host as ServiceHost);
    await again.onMessage(m);
    expect(first.router.placed).toHaveLength(1);
  });

  it("两条挨着来的单子排队处理:第二条看得见第一条(每日上限、重复单都靠这个)", async () => {
    const { service, router, log } = build({ max_orders_per_day: 1 });
    await Promise.all([service.onMessage(message("1.8 挂15蝴蝶 15CM")), service.onMessage(message("2 挂40蝴蝶 10CM"))]);
    expect(router.placed).toHaveLength(1);
    expect(log().map((e) => e.outcome)).toEqual(["capped", "sent"]);
    expect(log()[0]!.detail).toContain("每天 1 单");
  });
});

describe("follow service: 不跟的那些", () => {
  it("只观察:解析、记日志、发通知,但一张单都不发,引擎里也没有记录", async () => {
    const { service, engine, router, log, notes } = build({ enabled: false });
    await service.onMessage(message("1.8 挂15蝴蝶 15CM"));
    expect(router.placed).toEqual([]);
    expect(log()[0]).toMatchObject({ outcome: "observed", record_ids: [] });
    expect(log()[0]!.summary).toContain("6900/6915/6930");
    expect(engine.store.listRecords(10)).toEqual([]);
    expect(notes.some(([title]) => title === "Discord 跟单:只观察")).toBe(true);
  });

  it("不信任的人写一模一样的单:不发、不落日志,只进「最近看到的消息」", async () => {
    const { service, router, log } = build();
    await service.onMessage(message("1.8 挂15蝴蝶 15CM", { author: STRANGER }));
    expect(router.placed).toEqual([]);
    expect(log()).toEqual([]);
    const status = await service.status();
    expect(status.seen[0]).toMatchObject({ author_id: STRANGER, author_name: "路人", trusted: false, text: "1.8 挂15蝴蝶 15CM" });
  });

  it("别的频道的消息连看都不看", async () => {
    const { service, router } = build();
    await service.onMessage(message("1.8 挂15蝴蝶 15CM", { channel: "1100000000000000009" }));
    expect(router.placed).toEqual([]);
    expect((await service.status()).seen).toEqual([]);
  });

  it("信任的人闲聊:不发、不落日志、不取行情", async () => {
    const { service, router, log } = build();
    await service.onMessage(message("今天感觉要大跌,大家小心"));
    expect(router.placed).toEqual([]);
    expect(router.asked).toEqual([]);
    expect(log()).toEqual([]);
  });

  it("太旧的消息(断线后补到的)不跟,但记一笔", async () => {
    const { service, router, log } = build();
    await service.onMessage(message("1.8 挂15蝴蝶 15CM", { ageMs: 5 * 60_000 }));
    expect(router.placed).toEqual([]);
    expect(router.asked).toEqual([]);
    expect(log()[0]).toMatchObject({ outcome: "stale" });
    expect(log()[0]!.detail).toContain("300 秒");
  });

  it("超过单笔风险上限不发", async () => {
    const { service, router, log } = build();
    await service.onMessage(message("1.6 挂15蝴蝶 15CM 2张"));
    expect(router.placed).toEqual([]);
    expect(log()[0]!.outcome).toBe("capped");
  });

  it("带了本地速记不认的成分(止损、条件……)不交给大模型猜", async () => {
    const { service, router, log, modelCalls } = build();
    await service.onMessage(message("1.8 挂15蝴蝶 15CM 跌破 6880 止损"));
    expect(router.placed).toEqual([]);
    expect(modelCalls).toEqual([]);
    expect(log()[0]!.outcome).toBe("unparsed");
  });

  it("闸门和手动发单同一套:自动执行没开、熔断、没连券商,都不发", async () => {
    const off = build({}, { auto_execute: false });
    await off.service.onMessage(message("1.8 挂15蝴蝶 15CM"));
    expect(off.log()[0]).toMatchObject({ outcome: "blocked" });
    expect(off.engine.store.listRecords(10)).toEqual([]);

    const tripped = build();
    tripped.engine.killswitch.engage("手动熔断");
    await tripped.service.onMessage(message("1.8 挂15蝴蝶 15CM"));
    expect(tripped.log()[0]!.detail).toContain("手动熔断");
    tripped.engine.killswitch.release("test");

    const offline = build();
    offline.router.connected = false;
    await offline.service.onMessage(message("1.8 挂15蝴蝶 15CM"));
    expect(offline.log()[0]!.detail).toContain("没有连接券商");
    expect([...off.router.placed, ...tripped.router.placed, ...offline.router.placed]).toEqual([]);
  });

  it("配置里的账户别名已经不存在:不发,说清是哪个别名", async () => {
    const { service, router, log } = build({ accounts: ["改过名的账户"] });
    await service.onMessage(message("1.8 挂15蝴蝶 15CM"));
    expect(router.placed).toEqual([]);
    expect(log()[0]).toMatchObject({ outcome: "blocked" });
    expect(log()[0]!.detail).toContain("改过名的账户");
  });

  it("拿不到现价时,写明了中心与方向的单也不跟(没人看着,不能跳过'中心离现价太远'这道核对)", async () => {
    const { service, router, log } = build();
    router.prices = { SPX: [null] };
    await service.onMessage(message("SPX 6915蝴蝶 15cm call 1.8"));
    expect(router.placed).toEqual([]);
    expect(log()[0]!.outcome).toBe("unparsed");
    expect(log()[0]!.detail).toContain("拿不到");
  });

  it("校验层拒的照样拒(张数超了软件的限额):跟单的上限是多加的一道,不是替代", async () => {
    const { service, engine, router, log, host } = build();
    host.settings.limits.max_option_contracts = 1;
    await service.onMessage(message("0.5 挂15蝴蝶 15CM 2张")); // 最坏亏 $100,没超跟单的单笔上限
    expect(router.placed).toEqual([]);
    expect(log()[0]!.outcome).toBe("rejected");
    expect(log()[0]!.detail).toContain("张");
    // 被拒的那条照常落在交易记录里(订单看板看得到)
    expect(engine.store.listRecords(10)).toHaveLength(1);
  });
});

describe("follow service: 大模型在这条路上不出场", () => {
  it("引擎那一遍本地解析没接住(两遍之间现价取不到了):当场拒,不发单、不计解析失败", async () => {
    const { service, engine, router, log, modelCalls } = build({ max_risk_usd: 1000 });
    // 小写的 qqq:速记认它是标的,引擎抽标的时不认 → 引擎那一遍要重取现价;第二次取不到,看涨看跌就推断不出来
    router.prices = { QQQ: [600, null], SPX: [6907.35] };
    await service.onMessage(message("qqq 580的蝴蝶 5cm 1.2"));
    expect(router.asked.filter((s) => s === "QQQ")).toHaveLength(2);
    expect(modelCalls).toEqual([]);
    expect(router.placed).toEqual([]);
    expect(log()[0]!.outcome).toBe("unparsed");
    expect(log()[0]!.detail).toContain("没有交给大模型");
    expect(engine.killswitch.state().engaged).toBe(false);
    expect(engine.store.listRecords(10)).toEqual([]);
  });

  it("同一个引擎上,手动指令照旧走大模型", async () => {
    const { engine, modelCalls } = build();
    const result = await engine.handleInstruction("买入 AAPL 100股 limit 230", "manual", null, {}, null, true);
    expect(modelCalls).toHaveLength(1);
    expect(result.llm!.model).toBe("claude-opus-5");
  });
});

describe("follow service: Discord 连接的起停", () => {
  class FakeSocket implements SocketLike {
    onmessage: ((data: string) => void) | null = null;
    onclose: ((code: number) => void) | null = null;
    sent: Array<Record<string, any>> = [];
    closed = false;
    send(data: string): void { this.sent.push(JSON.parse(data)); }
    close(): void { this.closed = true; }
  }

  function secrets(initial: Record<string, string> = {}) {
    const vault = new Map(Object.entries(initial));
    const reads: string[] = [];
    useSecretBackend({
      exists: async (service, account) => vault.has(`${service}/${account}`),
      read: async (service, account) => {
        reads.push(`${service}/${account}`);
        return vault.get(`${service}/${account}`) ?? null;
      },
      write: async (service, account, secret) => { vault.set(`${service}/${account}`, secret); },
    });
    return { vault, reads };
  }
  const KEY = `${FOLLOW_KEYCHAIN_SERVICE}/${FOLLOW_KEYCHAIN_ACCOUNT}`;

  function wired(follow: Partial<FollowConfig> = {}) {
    const built = build(follow);
    const sockets: FakeSocket[] = [];
    built.service.gatewayOptions = {
      open: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      random: () => 0.5,
    };
    return { ...built, sockets };
  }

  it("没调过 start 的服务什么都不连(测试里直接起的 server 不许去碰 Discord)", async () => {
    const { reads } = secrets({ [KEY]: "bot.token.value" });
    const { service, sockets } = wired();
    await service.sync();
    expect(sockets).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("没配频道:不连,也不去碰凭证库", async () => {
    const { reads } = secrets({ [KEY]: "bot.token.value" });
    const { service, sockets } = wired({ channel_id: "", enabled: false });
    service.start();
    await service.sync();
    expect(sockets).toEqual([]);
    expect(reads).toEqual([]);
    expect((await service.status()).link.state).toBe("off");
    service.stop();
  });

  it("配了频道但没存 token:说缺 token,不连", async () => {
    secrets();
    const { service, sockets } = wired();
    service.start();
    await service.sync();
    expect(sockets).toEqual([]);
    const status = await service.status();
    expect(status.link.state).toBe("no_token");
    expect(status.token_configured).toBe(false);
    service.stop();
  });

  it("有 token:连上之后递来的消息走完整的那一趟;频道在不在 bot 的服务器里看得出来", async () => {
    secrets({ [KEY]: "bot.token.value" });
    const { service, sockets, router, log } = wired();
    service.start();
    await service.sync();
    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    socket.onmessage!(JSON.stringify({ op: 10, d: { heartbeat_interval: 40_000 } }));
    expect(socket.sent[0]).toMatchObject({ op: 2, d: { token: "bot.token.value" } });
    socket.onmessage!(JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "s", resume_gateway_url: "wss://r", user: { username: "follow-bot" } } }));
    expect((await service.status()).link).toEqual({ state: "ready", bot: "follow-bot", error: null, channel_known: null });
    socket.onmessage!(JSON.stringify({ op: 0, t: "GUILD_CREATE", s: 2, d: { channels: [{ id: "1100000000000000009" }] } }));
    expect((await service.status()).link.channel_known).toBe(false);
    socket.onmessage!(JSON.stringify({ op: 0, t: "CHANNEL_CREATE", s: 3, d: { id: CHANNEL } }));
    expect((await service.status()).link.channel_known).toBe(true);

    const m = message("1.8 挂15蝴蝶 15CM");
    socket.onmessage!(JSON.stringify({
      op: 0, t: "MESSAGE_CREATE", s: 4,
      d: { id: m.id, channel_id: CHANNEL, type: 0, content: m.content, author: { id: FRIEND, username: "laowang" } },
    }));
    await service.onMessage(m); // 排在刚才那条后面;同一个 ID,不会再发一次,只是等队列走完
    expect(router.placed).toHaveLength(1);
    expect(log()[0]).toMatchObject({ outcome: "sent", author_name: "laowang" });
    const status = await service.status();
    expect(status.today).toEqual({ sent: 1, max: 3 });
    expect(status.seen[0]).toMatchObject({ author_id: FRIEND, trusted: true });
    service.stop();
    expect(socket.closed).toBe(true);
  });

  it("连不上而且重试没用(没开 intent):状态是 failed,发一条通知", async () => {
    secrets({ [KEY]: "bot.token.value" });
    const { service, sockets, notes } = wired();
    service.start();
    await service.sync();
    sockets[0]!.onclose!(4014);
    const status = await service.status();
    expect(status.link.state).toBe("failed");
    expect(status.link.error).toContain("Message Content Intent");
    expect(notes.some(([title]) => title === "Discord 跟单停了")).toBe(true);
    service.stop();
  });

  it("存 token:写进凭证库,丢掉旧连接用新的重连", async () => {
    const { vault } = secrets({ [KEY]: "old.token.value" });
    const { service, sockets, engine } = wired();
    service.start();
    await service.sync();
    await service.setToken("new.token.value");
    expect(vault.get(KEY)).toBe("new.token.value");
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.closed).toBe(true);
    sockets[1]!.onmessage!(JSON.stringify({ op: 10, d: { heartbeat_interval: 40_000 } }));
    expect(sockets[1]!.sent[0]).toMatchObject({ op: 2, d: { token: "new.token.value" } });
    // 审计里只记"存过",不记 token 本身
    const audit = JSON.stringify(engine.store.exportAll()["audit_log"]);
    expect(audit).toContain("follow_token_set");
    expect(audit).not.toContain("new.token.value");
    service.stop();
  });

  it("配置里把频道清掉:连接跟着断", async () => {
    secrets({ [KEY]: "bot.token.value" });
    const { service, sockets, host } = wired();
    service.start();
    await service.sync();
    expect(sockets).toHaveLength(1);
    host.settings = makeSettings(gc.base_config, { storage: { db_path: host.settings.db_path }, follow: { channel_id: "" } });
    await service.sync();
    expect(sockets[0]!.closed).toBe(true);
    expect((await service.status()).link.state).toBe("off");
    service.stop();
  });
});
