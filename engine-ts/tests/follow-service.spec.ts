/** Discord 跟单的服务:一条频道消息从判定到发单的那一趟、处理完之后记的那一次盘口、跟进去的蝴蝶成交后建追踪,以及 Discord 连接的起停。
 *
 * 全部离线:消息直接喂给 onMessage,引擎是真的(校验、落库、成交回报都走),券商是假的(只记下发了什么),
 * Discord 的 socket 与凭证库都是假的。
 */
import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrokerError } from "../src/broker.js";
import { setClock } from "../src/config.js";
import type { FollowConfig } from "../src/contract/follow.js";
import type { Track, TrackerAddParams } from "../src/contract/tracker.js";
import type { DiscordMessage, SocketLike } from "../src/discordGateway.js";
import { TradingEngine } from "../src/engine.js";
import { FOLLOW_TRACK_NOTE, PENDING_MISS_ROUNDS, flyTrackParams } from "../src/follow.js";
import type { ReaderChild } from "../src/followReader.js";
import { Notifier } from "../src/notify.js";
import { OptionMarkStreams } from "../src/optionMarks.js";
import { makeKey } from "../src/positions.js";
import { LLMResponse } from "../src/providers.js";
import { RpcServer } from "../src/rpc.js";
import { RpcError } from "../src/rpcError.js";
import { useSecretBackend } from "../src/secrets.js";
import { FOLLOW_KEYCHAIN_ACCOUNT, FOLLOW_KEYCHAIN_SERVICE, FollowService, refuseModelWhileFollowing } from "../src/services/follow.js";
import type { ServiceHost } from "../src/services/host.js";
import { TradeStore } from "../src/store.js";
import { ET, stampAt } from "../src/tz.js";
import { FakeTws, connect, optionLeg, positions as twsPositions } from "./fakeTws.js";
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
    const n = this.placed.length;
    return { record_id: recordId, order_id: 1024 + n, perm_id: 7700 + n, status: "Submitted", limit_price: limitOverride, detail: {} };
  }
  /** 引擎给没写价的组合定价用的那条路(现订现撤):跟单不许走它,被叫到就记一笔 */
  legQuoteCalls = 0;
  async legQuotes() { this.legQuoteCalls += 1; return []; }
  /** 账户里的持仓(券商那一层的样子:一条腿一行) */
  rows: Array<Record<string, unknown>> = [];
  positionsFail = false;
  positionReads = 0;
  async positions() {
    this.positionReads += 1;
    if (this.positionsFail) throw new BrokerError("TWS 断了,读不到持仓");
    return this.rows.map((r) => ({ ...r }));
  }
  /** 取盘口用的那条会话:只用到它管着哪些账号(DU… = 纸面) */
  managed = ["DU7654321"];
  marketSession() { return { managedAccounts: () => this.managed }; }
}

/** 假的行情流:按行权价给盘口,记下每次是在发了几张单之后读的。 */
class FakeMarks {
  calls: Array<{ strikes: number[]; delayedOk: boolean; placedBefore: number }> = [];
  book: Record<number, { bid: number | null; ask: number | null }> = {
    6900: { bid: 19.9, ask: 20.3 }, 6915: { bid: 10.9, ask: 11.1 }, 6930: { bid: 3.7, ask: 3.9 },
    6920: { bid: 9.0, ask: 9.4 }, 6925: { bid: 6.8, ask: 7.2 },
  };
  fail: Error | null = null;
  /** 卡住不回(TWS 迟迟不给盘口):放行之前 read 一直不落定 */
  gate: Promise<void> | null = null;
  constructor(private readonly router: FakeRouter) {}
  async read(_session: unknown, legs: Array<{ strike: number; right: string }>, delayedOk: boolean) {
    this.calls.push({ strikes: legs.map((l) => l.strike), delayedOk, placedBefore: this.router.placed.length });
    if (this.gate !== null) await this.gate;
    if (this.fail !== null) throw this.fail;
    return legs.map((l) => ({
      strike: l.strike, right: l.right, bid: this.book[l.strike]?.bid ?? null, ask: this.book[l.strike]?.ask ?? null, iv: null, error: null,
    }));
  }
}

const EXPIRY = "20260814";
const FLY_LEG = `${EXPIRY}|+1x6900C,-2x6915C,+1x6930C`;
const FLY_KEY = makeKey("模拟", "SPX", "BAG", FLY_LEG);
/** 一条期权腿的持仓行 */
const legRow = (strike: number, quantity: number, avgCost: number, price: number, account = "模拟"): Record<string, unknown> => ({
  key: makeKey(account, "SPX", "OPT", `${EXPIRY}|${strike}|C`), account, symbol: "SPX", sec_type: "OPT", leg: `${EXPIRY}|${strike}|C`,
  label: `SPX ${strike}C`, quantity, multiplier: 100, currency: "USD", avg_cost: avgCost, market_price: price, market_value: null, unrealized_pnl: null,
  contract: { secType: "OPT", symbol: "SPX", lastTradeDateOrContractMonth: EXPIRY, strike, right: "C", multiplier: "100", tradingClass: "SPXW", exchange: "SMART" },
});
/** 6900/6915/6930 看涨蝶 lots 张的三条腿(每组净成本 $180,净价 1.90) */
const flyRows = (lots = 1, account = "模拟"): Array<Record<string, unknown>> =>
  [legRow(6900, lots, 2000, 20.1, account), legRow(6915, -2 * lots, 1100, 11.0, account), legRow(6930, lots, 380, 3.8, account)];

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

function build(
  follow: Partial<FollowConfig> = {}, policies: Record<string, unknown> = { auto_execute: true }, routerOverride: unknown = null,
) {
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
    notifier: new Notifier(false, [(title, subtitle, body) => notes.push([title, subtitle, body])]), router: (routerOverride ?? router) as any,
  });
  engine.publicPriceFn = async () => null;
  const events: Array<[string, Record<string, any>]> = [];
  const host = {
    settings, router: (routerOverride ?? router) as any, engine,
    emit: (event: string, payload: Record<string, any>) => { events.push([event, payload]); },
  };
  const service = new FollowService(host as ServiceHost);
  const log = () => engine.store.follow.recent(50);
  return { service, engine, router, host, events, notes, modelCalls, log };
}

/** 接上假的行情流与假的建追踪通道(真应用里这一步在 rpc/server.ts)。addTrack 记下收到的入参,回一条像样的追踪行。 */
function wire(built: ReturnType<typeof build>) {
  const marks = new FakeMarks(built.router);
  const added: TrackerAddParams[] = [];
  const control: { fail: Error | null } = { fail: null };
  built.service.attach({
    marks: marks as never,
    addTrack: async (params) => {
      added.push(params);
      if (control.fail !== null) throw control.fail;
      const track: Track = {
        id: `t${added.length}`, created_at: "", updated_at: "", account: "模拟", symbol: "SPX", sec_type: "BAG", leg: FLY_LEG, contract: {},
        targets: {
          profit_drawdown_tiers: [{ above: 0, pct: 40 }, { above: 1.111111, pct: 30 }, { above: 3, pct: 20 }],
          profit_drawdown_arm: 0.555556, profit_drawdown_late: { after: "15:00", factor: 0.5 },
          exit_at: params.exit_at || null, exit_at_ms: params.exit_at ? Date.UTC(2026, 7, 14, 19, 45, 0) : null,
        },
        auto_close: { enabled: params.auto_close === true }, enabled: true, peak: null, fired_at: null, fired_state: "", fired_record: "",
        note: params.note ?? "",
      };
      return { track };
    },
  });
  return { marks, added, control };
}

/** 券商回报:第 n 张单(从 1 数)成交了 qty 张;done = 这张单走完了(Filled)。走的是引擎真的回报入口。 */
function fill(engine: TradingEngine, n: number, qty: number, done: boolean): void {
  const order = { orderId: 1024 + n, permId: 7700 + n };
  engine.onExecDetails({ order }, { execution: { execId: `exec-${n}-${qty}-${done}`, price: 1.8, shares: qty }, contract: { secType: "BAG" } });
  if (done) engine.onOrderStatus({ order, orderStatus: { status: "Filled", filled: qty, remaining: 0 } });
}

/** 第 n 张单走完了(券商报 Filled),不带新的成交回报。 */
function engineDone(engine: TradingEngine, n: number): void {
  engine.onOrderStatus({ order: { orderId: 1024 + n, permId: 7700 + n }, orderStatus: { status: "Filled", filled: 2, remaining: 0 } });
}

const auditOf = (engine: TradingEngine, action: string): Array<Record<string, any>> =>
  (engine.store.exportAll()["audit_log"] as Array<Record<string, any>>).filter((row) => row["action"] === action);

beforeEach(() => {
  setClock(NOW);
});
afterEach(() => {
  setClock(null);
  useSecretBackend(null);
});

describe("follow service: 对方频道里真实的写法", () => {
  it("带 @everyone 的蝴蝶单照样跟;日志里记的是原文", async () => {
    const { service, router, log, modelCalls } = build();
    await service.onMessage(message("@everyone 1.8 挂15蝴蝶 15CM"));
    expect(router.placed).toHaveLength(1);
    expect(modelCalls).toEqual([]);
    expect(log()[0]).toMatchObject({ outcome: "sent", text: "@everyone 1.8 挂15蝴蝶 15CM" });
  });

  it("贷方价差:卖出的垂直价差发到券商,区间取收得多的一头,大模型没有出场", async () => {
    const { service, engine, router, log, modelCalls } = build();
    await service.onMessage(message("@everyone 6920 6925 bear call 挂个-2-2.5"));
    expect(router.placed).toHaveLength(1);
    const { approved } = router.placed[0]!;
    expect(approved.order.contract.combo_strategy).toBe("VERTICAL");
    expect(approved.order.contract.legs.map((l: any) => `${l.action} ${l.strike}${l.right}`)).toEqual(["BUY 6925C", "SELL 6920C"]);
    expect(approved.order.order).toMatchObject({ action: "SELL", lmtPrice: 2.5, price_mode: "EXPLICIT" });
    expect(modelCalls).toEqual([]);
    expect(log()[0]).toMatchObject({ outcome: "sent" });
    expect(log()[0]!.summary).toContain("6920/6925 看涨贷方价差");
    const record = engine.store.getRecord(log()[0]!.record_ids[0]!) as any;
    expect(record.input.input_channel).toBe("discord");
  });

  it("没写价格的蝴蝶(价格在下一条消息里):不发,记成没接住;下一条孤零零的价格是闲聊", async () => {
    const { service, router, log } = build({ max_risk_usd: 100000 });
    await service.onMessage(message("@everyone 15蝴蝶 15CM"));
    await service.onMessage(message("1.8"));
    expect(router.placed).toHaveLength(0);
    expect(log()).toHaveLength(1);
    expect(log()[0]).toMatchObject({ outcome: "unparsed" });
    expect(log()[0]!.detail).toContain("没写权利金上限");
  });

  it("光提到「蝴蝶」的评论:不发、不落日志、不通知", async () => {
    const { service, router, log, notes } = build();
    await service.onMessage(message("@everyone 蝴蝶先走一下"));
    await service.onMessage(message("@everyone 蝴蝶止损了哦"));
    expect(router.placed).toHaveLength(0);
    expect(log()).toHaveLength(0);
    expect(notes).toHaveLength(0);
  });

  it("没写方向的价差:不发,落成没接住并说出差的是哪一样", async () => {
    const { service, router, log } = build();
    await service.onMessage(message("@everyone 20 25可以挂个-2 -2.5"));
    expect(router.placed).toHaveLength(0);
    expect(log()[0]).toMatchObject({ outcome: "unparsed" });
    expect(log()[0]!.detail).toContain("bull put 还是 bear call");
  });
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

describe("follow service: 本地收件填了频道名,读窗口的程序跟着起停", () => {
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    killed = false;
    constructor(readonly program: string, readonly args: string[]) {
      super();
    }
    kill(): boolean {
      this.killed = true;
      return true;
    }
  }
  function withReader(follow: Partial<FollowConfig>, program: string | null = "/opt/discord-window-follow") {
    const built = build({ channel_id: "", author_ids: ["local:老王"], ...follow });
    const children: FakeChild[] = [];
    built.service.readerOptions = {
      program,
      spawn: (prog, args) => {
        const child = new FakeChild(prog, args);
        children.push(child);
        return child as unknown as ReaderChild;
      },
    };
    return { ...built, children };
  }
  const inboxEvents = (events: Array<[string, Record<string, any>]>): number => events.filter(([e, p]) => e === "follow" && p["kind"] === "inbox").length;

  it("本地收件开着、填了频道名:拉起来,参数是频道名与交易库旁边的收件文件;它报在读,界面就看到在读;引擎停它跟着停", async () => {
    const { service, host, events, children } = withReader({ local_inbox: true, local_channel: "老王的策略" });
    service.start();
    await service.sync();
    expect(children).toHaveLength(1);
    const out = path.join(path.dirname(host.settings.db_path), "follow-inbox.jsonl");
    expect(children[0]!.program).toBe("/opt/discord-window-follow");
    expect(children[0]!.args.slice(0, 5)).toEqual(["--channel", "老王的策略", "--out", out, "--supervised"]);
    expect((await service.status()).inbox.reader).toEqual({ state: "starting", title: null, error: null });
    const before = inboxEvents(events);
    children[0]!.stdout.emit("data", Buffer.from('{"state":"reading","title":"#老王的策略 | 示例 - Discord"}\n'));
    expect((await service.status()).inbox.reader).toEqual({ state: "reading", title: "#老王的策略 | 示例 - Discord", error: null });
    expect(inboxEvents(events)).toBe(before + 1);
    // 配置原样重载:不重启它
    await service.sync();
    expect(children).toHaveLength(1);
    service.stop();
    expect(children[0]!.killed).toBe(true);
  });

  it("换了频道名:旧的停掉、按新名字再起一个;清空:停掉,不再自己读", async () => {
    const { service, host, children } = withReader({ local_inbox: true, local_channel: "老王的策略" });
    service.start();
    await service.sync();
    host.settings.follow.local_channel = "另一个频道";
    await service.sync();
    expect(children).toHaveLength(2);
    expect(children[0]!.killed).toBe(true);
    expect(children[1]!.args[1]).toBe("另一个频道");
    host.settings.follow.local_channel = "";
    await service.sync();
    expect(children[1]!.killed).toBe(true);
    expect(children).toHaveLength(2);
    expect((await service.status()).inbox.reader.state).toBe("no_channel");
    // 收件文件照读:手动运行的脚本照样管用
    expect((await service.status()).inbox.watching).toBe(true);
    service.stop();
  });

  it("不自己读的三种情况各说各的:本地收件关着、没填频道名、这台机器上没有这个程序", async () => {
    const off = withReader({ local_inbox: false, local_channel: "老王的策略" });
    off.service.start();
    await off.service.sync();
    expect(off.children).toHaveLength(0);
    expect((await off.service.status()).inbox.reader.state).toBe("off");
    off.service.stop();

    const unnamed = withReader({ local_inbox: true });
    unnamed.service.start();
    await unnamed.service.sync();
    expect(unnamed.children).toHaveLength(0);
    expect((await unnamed.service.status()).inbox.reader.state).toBe("no_channel");
    unnamed.service.stop();

    const none = withReader({ local_inbox: true, local_channel: "老王的策略" }, null);
    none.service.start();
    await none.service.sync();
    expect(none.children).toHaveLength(0);
    expect((await none.service.status()).inbox).toMatchObject({ watching: true, reader: { state: "unavailable" } });
    none.service.stop();
  });

  it("引擎没有真正起来(没调过 start)时不拉起任何东西", async () => {
    const { service, children } = withReader({ local_inbox: true, local_channel: "老王的策略" });
    await service.sync();
    expect(children).toHaveLength(0);
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

describe("follow service: 延迟的代价(处理完之后记一次盘口)", () => {
  it("跟了一单:发单之后取一次盘口,和对方写的价一起记在这条信号上", async () => {
    const built = build();
    const { marks } = wire(built);
    await built.service.onMessage(message("1.8 挂15蝴蝶 15CM"));
    await built.service.settled();
    expect(built.router.placed).toHaveLength(1);
    // 6900/6915/6930:中间价 20.1 − 2 × 11.0 + 3.8 = 1.9;立刻成交要付 20.3 − 2 × 10.9 + 3.9 = 2.4;消息是 1 秒前发的
    expect(built.log()[0]).toMatchObject({
      outcome: "sent", quote: { side: "debit", leader: 1.8, mid: 1.9, natural: 2.4, lag_s: 1, paper: true },
    });
    expect(marks.calls).toEqual([{ strikes: [6900, 6915, 6930], delayedOk: true, placedBefore: 1 }]);
    // 不走引擎定价那条现订现撤的路(它撤的可能是盯盘的流)
    expect(built.router.legQuoteCalls).toBe(0);
    expect(built.events.some(([event, payload]) => event === "follow" && payload["kind"] === "quote")).toBe(true);
    expect((await built.service.status()).recent[0]!.quote).toMatchObject({ leader: 1.8, mid: 1.9 });
  });

  it("只观察的也记:一张单都没发,盘口照取", async () => {
    const built = build({ enabled: false });
    const { marks } = wire(built);
    await built.service.onMessage(message("1.8 挂15蝴蝶 15CM", { ageMs: 6400 }));
    await built.service.settled();
    expect(built.router.placed).toEqual([]);
    expect(built.log()[0]).toMatchObject({ outcome: "observed", quote: { side: "debit", leader: 1.8, mid: 1.9, natural: 2.4, lag_s: 6 } });
    expect(marks.calls).toHaveLength(1);
  });

  it("超上限、闸门关着的也记(解析出了恰好一张写明价格的单);没接住的、太旧的、闲聊不取盘口", async () => {
    const built = build();
    const { marks } = wire(built);
    await built.service.onMessage(message("1.6 挂15蝴蝶 15CM 2张"));            // 超上限
    built.engine.killswitch.engage("手动熔断");
    await built.service.onMessage(message("1.8 挂15蝴蝶 15CM"));                // 闸门关着
    built.engine.killswitch.release("test");
    await built.service.settled();
    expect(built.log().map((e) => [e.outcome, e.quote?.leader])).toEqual([["blocked", 1.8], ["capped", 1.6]]);
    const before = marks.calls.length;
    await built.service.onMessage(message("15蝴蝶 15CM"));                       // 没写价
    await built.service.onMessage(message("1.8 挂15蝴蝶 15CM 跌破 6880 止损"));  // 速记没接住
    await built.service.onMessage(message("1.8 挂15蝴蝶 15CM", { ageMs: 5 * 60_000 })); // 太旧
    await built.service.onMessage(message("蝴蝶先走一下"));                      // 闲聊
    await built.service.settled();
    expect(marks.calls).toHaveLength(before);
    expect(built.log().slice(0, 3).every((e) => e.quote === undefined)).toBe(true);
  });

  it("贷方价差:对方写的是收多少,中间价与立刻成交的价也换成「收多少」;实盘会话不标纸面", async () => {
    const built = build();
    const { marks } = wire(built);
    built.router.managed = ["U1234567"];
    await built.service.onMessage(message("@everyone 6920 6925 bear call 挂个-2-2.5"));
    await built.service.settled();
    // 买 6925C、卖 6920C:中间价 7.0 − 9.2 = −2.2(收 2.2);立刻成交 7.2 − 9.0 = −1.8(收 1.8)
    expect(built.log()[0]).toMatchObject({
      outcome: "sent", quote: { side: "credit", leader: 2.5, mid: 2.2, natural: 1.8, lag_s: 1, paper: false },
    });
    expect(marks.calls[0]).toMatchObject({ strikes: [6925, 6920], delayedOk: false });
  });

  it("盘口没取到(TWS 不答话、断了、有一条腿没有买价、出了意料之外的错):单子照发、日志原样、不多发一条通知", async () => {
    const failures: Array<(marks: FakeMarks) => void> = [
      (marks) => { marks.fail = new BrokerError("引擎未连接 TWS。"); },
      (marks) => { marks.fail = new Error("意料之外的错"); },
      (marks) => { marks.book[6930] = { bid: 0, ask: 0.05 }; },       // 远翼没人出价:拿它算出来的不是价
      (marks) => { marks.book[6915] = { bid: null, ask: null }; },
    ];
    for (const breakIt of failures) {
      const built = build();
      const { marks } = wire(built);
      breakIt(marks);
      await built.service.onMessage(message("1.8 挂15蝴蝶 15CM"));
      await built.service.settled();
      expect(built.router.placed).toHaveLength(1);
      expect(built.log()).toHaveLength(1);
      expect(built.log()[0]).toMatchObject({ outcome: "sent" });
      expect(built.log()[0]!.quote).toBeUndefined();
      expect(marks.calls).toHaveLength(1); // 不重试
      expect(built.notes.map(([title]) => title).filter((t) => t.startsWith("Discord 跟单"))).toEqual(["Discord 跟单:已跟单"]);
    }
  });

  it("没连券商、没接上行情流:不取,什么都不影响", async () => {
    const offline = build({ enabled: false });
    const { marks } = wire(offline);
    offline.router.connected = false;
    await offline.service.onMessage(message("1.8 挂15蝴蝶 15CM"));
    await offline.service.settled();
    expect(marks.calls).toEqual([]);
    expect(offline.log()[0]).toMatchObject({ outcome: "observed" });
    const unwired = build();
    await unwired.service.onMessage(message("1.8 挂15蝴蝶 15CM"));
    await unwired.service.settled();
    expect(unwired.log()[0]!.quote).toBeUndefined();
    expect(unwired.router.placed).toHaveLength(1);
  });

  it("取盘口不占消息的队:它卡着的时候,这一单早已发出,下一条消息照常处理、照常发单", async () => {
    const built = build();
    const { marks } = wire(built);
    let release: () => void = () => undefined;
    marks.gate = new Promise<void>((resolve) => { release = resolve; });
    await built.service.onMessage(message("1.8 挂15蝴蝶 15CM"));
    // 盘口还卡着:单子已经在券商那边了,日志也落了
    expect(built.router.placed).toHaveLength(1);
    expect(marks.calls).toEqual([{ strikes: [6900, 6915, 6930], delayedOk: true, placedBefore: 1 }]);
    expect(built.log()[0]).toMatchObject({ outcome: "sent" });
    expect(built.log()[0]!.quote).toBeUndefined();
    await built.service.onMessage(message("@everyone 6920 6925 bear call 挂个-2-2.5"));
    expect(built.router.placed).toHaveLength(2);
    expect(marks.calls[1]!.placedBefore).toBe(2);
    release();
    await built.service.settled();
    expect(built.log().map((e) => e.quote?.side)).toEqual(["credit", "debit"]);
  });

  it("行情走自己那批流:持仓腿的常驻订阅一条都没被撤,盯盘的价照常更新(真的会话 + 真的 OptionMarkStreams,底下是假 TWS)", async () => {
    const tws = new FakeTws();
    const conId = (strike: number): number => tws.conId("SPX", EXPIRY, strike, "C", "SPXW");
    tws.held = [optionLeg(tws, 6900, 1, "SPXW", EXPIRY), optionLeg(tws, 6915, -2, "SPXW", EXPIRY), optionLeg(tws, 6930, 1, "SPXW", EXPIRY)];
    tws.book.set(conId(6900), { bid: 19.9, ask: 20.3 });
    tws.book.set(conId(6915), { bid: 10.9, ask: 11.1 });
    tws.book.set(conId(6930), { bid: 3.7, ask: 3.9 });
    const real = await connect(tws);
    await twsPositions(real.router); // 盯盘那一头把三条腿的常驻行情订上了
    const held = (strike: number) => tws.open(conId(strike)).filter((sub) => sub.generic === "");
    expect([6900, 6915, 6930].map((k) => held(k).length)).toEqual([1, 1, 1]);

    // 跟单看到的 router:会话与持仓是真的那一份,现价给一个固定的数
    const hybrid = {
      BROKER: "ibkr", sessions: () => real.router.sessions(), marketSession: () => real.router.marketSession(),
      positions: () => real.router.positions(), indexPrice: async () => 6907.35,
    };
    const built = build({ enabled: false }, { auto_execute: true }, hybrid);
    const marks = new OptionMarkStreams();
    built.service.attach({ marks, addTrack: async () => { throw new Error("这条用例不建追踪"); } });
    await built.service.onMessage(message("1.8 挂15蝴蝶 15CM"));
    await built.service.settled();
    expect(built.log()[0]).toMatchObject({ outcome: "observed", quote: { side: "debit", leader: 1.8, mid: 1.9, natural: 2.4, paper: true } });
    // 盯盘那三条流还在(同一条订阅,没被撤过);取盘口用的是另外三条(带 generic ticks)
    expect([6900, 6915, 6930].map((k) => held(k).length)).toEqual([1, 1, 1]);
    expect([6900, 6915, 6930].map((k) => tws.open(conId(k)).filter((sub) => sub.generic !== "").length)).toEqual([1, 1, 1]);
    tws.book.set(conId(6915), { bid: 11.9, ask: 12.1 });
    const rows = await twsPositions(real.router);
    expect(rows.find((r) => (r["contract"] as Record<string, unknown>)["strike"] === 6915)?.["market_price"]).toBe(12);
    marks.close();
  });
});

describe("follow service: 跟进来的蝴蝶成交后自动建追踪(track_fly)", () => {
  const FLY = "1.8 挂15蝴蝶 15CM";
  const titles = (notes: Array<[string, string, string]>): string[] => notes.map(([title]) => title).filter((t) => t.startsWith("Discord 跟单"));

  it("默认关:跟了、成交了,也不登记、不建", async () => {
    const built = build();
    const { added } = wire(built);
    await built.service.onMessage(message(FLY));
    fill(built.engine, 1, 1, true);
    built.router.rows = flyRows();
    await built.service.trackTick();
    expect(added).toEqual([]);
    expect((await built.service.status()).tracks_pending).toBe(0);
    expect(built.log()[0]!.detail).not.toContain("追踪");
    expect(built.router.positionReads).toBe(0); // 没有在等的,连持仓都不读
  });

  it("开着:发出去的蝴蝶登记成「等成交」,日志里写明;没成交之前不建,账户里本来就有一模一样的蝶也不套", async () => {
    const built = build({ track_fly: true, track_exit_at: "15:45" });
    const { added } = wire(built);
    await built.service.onMessage(message(FLY));
    expect(built.log()[0]).toMatchObject({ outcome: "sent" });
    expect(built.log()[0]!.detail).toContain("成交后自动建持仓追踪(蝶式预设、到价自动平仓、美东 15:45 到点平仓)");
    expect((await built.service.status()).tracks_pending).toBe(1);
    // 这张单还挂着;账户里有一只一模一样、用户自己的蝶
    built.router.rows = flyRows();
    await built.service.trackTick();
    await built.service.trackTick();
    expect(added).toEqual([]);
    expect((await built.service.status()).tracks_pending).toBe(1);
  });

  it("成交回报到了、持仓出来了:建一条,入参就是界面那张表单发的那一份;建好了通知、留痕,不再等", async () => {
    const built = build({ track_fly: true, track_exit_at: "15:45" });
    const { added } = wire(built);
    const m = message(FLY);
    await built.service.onMessage(m);
    fill(built.engine, 1, 1, true);
    built.router.rows = flyRows();
    await built.service.trackTick();
    expect(added).toEqual([{
      key: FLY_KEY,
      take_profit: "", stop_loss: "", trail_pct: "",
      profit_drawdown_pct: "", profit_drawdown_preset: "fly", profit_drawdown_arm_pct: "",
      spot_target: "", spot_stop_below: "", spot_stop_above: "",
      auto_close: true, order_type: "LMT", host_at_broker: false,
      exit_at: "15:45", spot_stop_confirm_s: "", take_profit_tiers: "", stop_basis: "mid",
      note: "Discord 跟单自动建立",
    }]);
    expect(added[0]).toEqual(flyTrackParams(FLY_KEY, "15:45"));
    expect((await built.service.status()).tracks_pending).toBe(0);
    const note = built.notes.find(([title]) => title === "Discord 跟单:已建持仓追踪");
    expect(note![2]).toContain("6900/6915/6930");
    expect(note![2]).toContain("这只蝶现在持有 1 张,追踪管的是这一整份");
    expect(note![2]).toContain("蝶式预设:浮盈到过成本的 55.6% 起算,从峰值回撤 40 / 30 / 20% 就平");
    expect(note![2]).toContain("到点平仓:美东 15:45");
    expect(note![2]).toContain("到价由软件自动发平仓单");
    expect(note![2]).toContain("对方自己什么时候走,软件仍然不知道");
    const trail = auditOf(built.engine, "follow_track");
    expect(trail).toHaveLength(1);
    expect(JSON.parse(trail[0]!["detail"])).toMatchObject({
      message: m.id, record: built.router.placed[0]!.recordId, account: "模拟", symbol: "SPX", leg: FLY_LEG, track: "t1",
      targets: { exit_at: "15:45" }, auto_close: { enabled: true },
    });
    expect(built.events.some(([event, payload]) => event === "follow" && payload["kind"] === "track")).toBe(true);
    // 之后再核对多少轮都不会再建
    await built.service.trackTick();
    await built.service.trackTick();
    expect(added).toHaveLength(1);
  });

  it("部分成交、单子还挂着:已经有持仓了,当场建", async () => {
    const built = build({ track_fly: true, max_risk_usd: 1000 });
    const { added } = wire(built);
    await built.service.onMessage(message("0.5 挂15蝴蝶 15CM 2张"));
    expect(built.router.placed).toHaveLength(1);
    fill(built.engine, 1, 1, false); // 2 张成交了 1 张
    built.router.rows = flyRows(1);
    await built.service.trackTick();
    expect(added.map((p) => p.key)).toEqual([FLY_KEY]);
    expect(added[0]!.exit_at).toBe(""); // 没设钟点:和表单里空着一样,给空串
    expect((await built.service.status()).tracks_pending).toBe(0);
  });

  it("部分成交就建了追踪、剩下的后来也成交了:追踪还在盯就不用说什么,单子走完不再看", async () => {
    const built = build({ track_fly: true, max_risk_usd: 1000 });
    const { added } = wire(built);
    await built.service.onMessage(message("0.5 挂15蝴蝶 15CM 2张"));
    fill(built.engine, 1, 1, false);
    built.router.rows = flyRows(1);
    // 别的账户上同一只蝶的追踪不算数:追踪按「账户 + 标的 + 腿」认
    built.engine.store.addTrack({ account: "别的账户", symbol: "SPX", sec_type: "BAG", leg: FLY_LEG, contract: {}, targets: {}, auto_close: {}, peak: null, note: "" });
    await built.service.trackTick();
    expect(added).toHaveLength(1);
    const pending = () => built.engine.store.getPref("follow.pending_tracks") as Array<Record<string, unknown>>;
    expect(pending()).toHaveLength(1);                                   // 单子还挂着:留着看
    expect(pending()[0]).toMatchObject({ settled_fills: 1 });
    expect((await built.service.status()).tracks_pending).toBe(0);       // 界面上不算"在等成交"
    // 这条用例里建追踪的通道是假的,库里没有那条追踪;放一条真的、在盯的进去,当作刚才建的那条
    built.engine.store.addTrack({ account: "模拟", symbol: "SPX", sec_type: "BAG", leg: FLY_LEG, contract: {}, targets: {}, auto_close: { enabled: true }, peak: null, note: "" });
    const reads = built.router.positionReads;
    fill(built.engine, 1, 2, false);                                     // 又成交了一张,还没报 Filled
    await built.service.trackTick();
    expect(pending()[0]).toMatchObject({ settled_fills: 2 });
    engineDone(built.engine, 1);
    await built.service.trackTick();
    expect(pending()).toEqual([]);
    expect(added).toHaveLength(1);
    expect(built.router.positionReads).toBe(reads);                       // 这一段只看记录与追踪表,不读持仓
    expect(titles(built.notes)).toEqual(["Discord 跟单:已跟单", "Discord 跟单:已建持仓追踪"]);
  });

  it("部分成交就建了追踪、追踪触发平掉之后剩下的才成交:后成交的那部分没有人盯,说一次", async () => {
    const built = build({ track_fly: true, max_risk_usd: 1000 });
    wire(built);
    await built.service.onMessage(message("0.5 挂15蝴蝶 15CM 2张"));
    fill(built.engine, 1, 1, false);
    built.router.rows = flyRows(1);
    await built.service.trackTick();
    // 那条追踪后来触发、平掉了(已触发、停用,留在表里)
    const track = built.engine.store.addTrack({ account: "模拟", symbol: "SPX", sec_type: "BAG", leg: FLY_LEG, contract: {}, targets: {}, auto_close: { enabled: true }, peak: null, note: "" });
    built.engine.store.updateTrack(track.id, { enabled: false, fired_at: "2026-08-14T11:05:00", fired_state: "profit_trail" });
    await built.service.trackTick();
    expect(titles(built.notes)).toEqual(["Discord 跟单:已跟单", "Discord 跟单:已建持仓追踪"]); // 没有新的成交:没什么要说
    fill(built.engine, 1, 2, true);                                      // 剩下的那一张这时候成交了
    await built.service.trackTick();
    await built.service.trackTick();
    const late = built.notes.filter(([title]) => title === "Discord 跟单:后成交的部分没有追踪");
    expect(late).toHaveLength(1);
    expect(late[0]![2]).toContain("后成交的部分现在没有追踪在盯");
    expect(built.engine.store.getPref("follow.pending_tracks")).toEqual([]);
    expect(JSON.parse(auditOf(built.engine, "follow_track_dropped")[0]!["detail"])).toMatchObject({ reason: "late_fill" });
  });

  it("成交回报到了、持仓还没出来(回报早一拍):等;出来了再建", async () => {
    const built = build({ track_fly: true });
    const { added } = wire(built);
    await built.service.onMessage(message(FLY));
    fill(built.engine, 1, 1, true);
    await built.service.trackTick();
    expect(added).toEqual([]);
    expect((await built.service.status()).tracks_pending).toBe(1);
    built.router.rows = flyRows();
    await built.service.trackTick();
    expect(added).toHaveLength(1);
  });

  it("贷方价差:照跟,不登记、不建追踪,日志里写明平仓由自己管", async () => {
    const built = build({ track_fly: true });
    const { added } = wire(built);
    await built.service.onMessage(message("@everyone 6920 6925 bear call 挂个-2-2.5"));
    expect(built.router.placed).toHaveLength(1);
    expect(built.log()[0]).toMatchObject({ outcome: "sent" });
    expect(built.log()[0]!.detail).toContain("不是买入的蝴蝶,不自动建追踪,平仓由你自己管");
    expect((await built.service.status()).tracks_pending).toBe(0);
    fill(built.engine, 1, 1, true);
    await built.service.trackTick();
    expect(added).toEqual([]);
  });

  it("只观察、超上限、被拒的不登记", async () => {
    const built = build({ track_fly: true, enabled: false });
    wire(built);
    await built.service.onMessage(message(FLY));
    expect(built.log()[0]).toMatchObject({ outcome: "observed" });
    expect(built.log()[0]!.detail).not.toContain("追踪");
    expect((await built.service.status()).tracks_pending).toBe(0);
  });

  it("单子撤了(一张没成交):不建、不再等,也不为此提醒", async () => {
    const built = build({ track_fly: true });
    const { added } = wire(built);
    await built.service.onMessage(message(FLY));
    built.engine.onOrderStatus({ order: { orderId: 1025, permId: 7701 }, orderStatus: { status: "Cancelled", filled: 0, remaining: 1 } });
    built.router.rows = flyRows(); // 账户里碰巧有一只一样的:单子没成交过,不是它开出来的
    await built.service.trackTick();
    expect(added).toEqual([]);
    expect((await built.service.status()).tracks_pending).toBe(0);
    expect(titles(built.notes)).toEqual(["Discord 跟单:已跟单"]);
    expect(JSON.parse(auditOf(built.engine, "follow_track_dropped")[0]!["detail"])).toMatchObject({ reason: "unfilled", leg: FLY_LEG });
  });

  it("引擎重启(换一个服务实例、库还是那一个):在等的那只还在,成交之后照建", async () => {
    const built = build({ track_fly: true });
    wire(built);
    await built.service.onMessage(message(FLY));
    const again = new FollowService(built.host as ServiceHost);
    const added: TrackerAddParams[] = [];
    again.attach({ marks: new FakeMarks(built.router) as never, addTrack: async (params) => { added.push(params); return { track: { targets: {}, auto_close: { enabled: true }, id: "t9" } as Track }; } });
    expect((await again.status()).tracks_pending).toBe(1);
    fill(built.engine, 1, 1, true);
    built.router.rows = flyRows();
    await again.trackTick();
    expect(added.map((p) => p.key)).toEqual([FLY_KEY]);
    expect((await again.status()).tracks_pending).toBe(0);
    expect((await built.service.status()).tracks_pending).toBe(0);
  });

  it("读不到持仓(断线、这个账户的会话没连上):先等,不下结论;连回来再建", async () => {
    const built = build({ track_fly: true });
    const { added } = wire(built);
    await built.service.onMessage(message(FLY));
    fill(built.engine, 1, 1, true);
    built.router.rows = flyRows();
    built.router.positionsFail = true;
    for (let i = 0; i < PENDING_MISS_ROUNDS + 2; i += 1) await built.service.trackTick();
    expect(added).toEqual([]);
    expect((await built.service.status()).tracks_pending).toBe(1);
    built.router.positionsFail = false;
    (built.router as unknown as { coveredAccounts: () => Set<string> }).coveredAccounts = () => new Set(["主账户"]);
    await built.service.trackTick();
    expect(added).toEqual([]); // 「模拟」这个账户此刻读不到:持仓表里没有它不等于它没仓
    (built.router as unknown as { coveredAccounts: () => Set<string> }).coveredAccounts = () => new Set(["模拟", "主账户"]);
    await built.service.trackTick();
    expect(added).toHaveLength(1);
    expect(titles(built.notes)).toEqual(["Discord 跟单:已跟单", "Discord 跟单:已建持仓追踪"]);
  });

  it("tracker.add 拒了(入参校验那一类):说明原因,只说一次,不再试", async () => {
    const built = build({ track_fly: true });
    const { added, control } = wire(built);
    await built.service.onMessage(message(FLY));
    fill(built.engine, 1, 1, true);
    built.router.rows = flyRows();
    control.fail = new RpcError(-32602, "找不到这个持仓(可能刚刚被平掉了),请刷新持仓列表。");
    await built.service.trackTick();
    await built.service.trackTick();
    expect(added).toHaveLength(1);
    expect((await built.service.status()).tracks_pending).toBe(0);
    const failed = built.notes.filter(([title]) => title === "Discord 跟单:没有建追踪");
    expect(failed).toHaveLength(1);
    expect(failed[0]![2]).toContain("找不到这个持仓");
    expect(failed[0]![2]).toContain("现在没有追踪在盯");
    expect(auditOf(built.engine, "follow_track_failed")).toHaveLength(1);
    expect(auditOf(built.engine, "follow_track")).toEqual([]);
  });

  it("到点平仓的钟点对这只蝶已经用不上(tracker.add 因它而拒):追踪照建、不带到点平仓,通知里照实说", async () => {
    const built = build({ track_fly: true, track_exit_at: "15:45" });
    const marks = new FakeMarks(built.router);
    const added: TrackerAddParams[] = [];
    built.service.attach({
      marks: marks as never,
      addTrack: async (params) => {
        added.push(params);
        if (params.exit_at) throw new RpcError(-32602, "到点平仓「15:45」下一次到点是美东 08/15 15:45,而这份持仓 08/14 16:00 就到期了——那时它已经不在了。");
        return { track: { id: "t1", targets: { exit_at: null, exit_at_ms: null }, auto_close: { enabled: true } } as Track };
      },
    });
    await built.service.onMessage(message(FLY));
    fill(built.engine, 1, 1, true);
    built.router.rows = flyRows();
    await built.service.trackTick();
    expect(added.map((p) => p.exit_at)).toEqual(["15:45", ""]);
    expect({ ...added[1], exit_at: "15:45" }).toEqual(added[0]);            // 除了钟点,入参一字不差
    const made = built.notes.filter(([title]) => title === "Discord 跟单:已建持仓追踪");
    expect(made).toHaveLength(1);
    expect(made[0]![2]).toContain("美东 15:45 的到点平仓对这只蝶用不上");
    expect(built.notes.filter(([title]) => title === "Discord 跟单:没有建追踪")).toEqual([]);
    expect(auditOf(built.engine, "follow_track")).toHaveLength(1);
  });

  it("建的那一下断了线(不是入参的问题):下一轮再试,成了就建成;一直不成,试够了说清楚、不再试", async () => {
    const built = build({ track_fly: true });
    const { added, control } = wire(built);
    await built.service.onMessage(message(FLY));
    fill(built.engine, 1, 1, true);
    built.router.rows = flyRows();
    control.fail = new RpcError(-32018, "读取持仓需要 TWS / IB Gateway");
    await built.service.trackTick();
    expect((await built.service.status()).tracks_pending).toBe(1);
    expect(titles(built.notes)).toEqual(["Discord 跟单:已跟单"]);
    control.fail = null;
    await built.service.trackTick();
    expect(added).toHaveLength(2);
    expect(titles(built.notes)).toEqual(["Discord 跟单:已跟单", "Discord 跟单:已建持仓追踪"]);

    const stuck = build({ track_fly: true });
    const second = wire(stuck);
    await stuck.service.onMessage(message(FLY));
    fill(stuck.engine, 1, 1, true);
    stuck.router.rows = flyRows();
    second.control.fail = new Error("意料之外的错");
    for (let i = 0; i < 30; i += 1) await stuck.service.trackTick();
    expect(second.added).toHaveLength(10);
    expect((await stuck.service.status()).tracks_pending).toBe(0);
    const failed = stuck.notes.filter(([title]) => title === "Discord 跟单:没有建追踪");
    expect(failed).toHaveLength(1);
    expect(failed[0]![2]).toContain("试了 10 次都没建成(意料之外的错)");
  });

  it("这只蝶上已经有一条在盯的追踪:不另建,说明沿用它;同一只蝶连跟两次也只有一条", async () => {
    const built = build({ track_fly: true });
    const { added } = wire(built);
    built.engine.store.addTrack({
      account: "模拟", symbol: "SPX", sec_type: "BAG", leg: FLY_LEG, contract: {},
      targets: { stop_loss: 0.9 }, auto_close: { enabled: true }, peak: null, note: "自己设的",
    });
    await built.service.onMessage(message(FLY));
    fill(built.engine, 1, 1, true);
    built.router.rows = flyRows(2);
    await built.service.trackTick();
    expect(added).toEqual([]);
    expect((await built.service.status()).tracks_pending).toBe(0);
    const note = built.notes.find(([title]) => title === "Discord 跟单:沿用已有的追踪");
    expect(note![2]).toContain("没有另建");
    expect(note![2]).toContain("到价由软件自动发平仓单");
    expect(JSON.parse(auditOf(built.engine, "follow_track_dropped")[0]!["detail"])).toMatchObject({ reason: "covered" });
  });

  it("这只蝶上留着一条停用 / 触发过的旧追踪:建不了新的,照实说这一单没有追踪在盯,软件不替人删", async () => {
    const built = build({ track_fly: true });
    const { added } = wire(built);
    const old = built.engine.store.addTrack({
      account: "模拟", symbol: "SPX", sec_type: "BAG", leg: FLY_LEG, contract: {}, targets: {}, auto_close: { enabled: true }, peak: null, note: "",
    });
    built.engine.store.updateTrack(old.id, { enabled: false, fired_at: "2026-08-14T09:50:00", fired_state: "profit_trail" });
    await built.service.onMessage(message(FLY));
    fill(built.engine, 1, 1, true);
    built.router.rows = flyRows();
    await built.service.trackTick();
    expect(added).toEqual([]);
    expect(built.engine.store.listTracks()).toHaveLength(1); // 旧的那条还在,没被动过
    const note = built.notes.find(([title]) => title === "Discord 跟单:没有建追踪");
    expect(note![2]).toContain("旧追踪");
    expect(note![2]).toContain("现在没有追踪在盯");
    expect((await built.service.status()).tracks_pending).toBe(0);
  });

  it("成交了、单子也走完了,持仓里却一直找不到这只蝶(腿和别的持仓并在了一起,或者已经平掉):等几轮之后说清楚", async () => {
    const built = build({ track_fly: true });
    const { added } = wire(built);
    await built.service.onMessage(message(FLY));
    fill(built.engine, 1, 1, true);
    // 账户里还有一只 6915/6930/6945:四个行权价并在一起,认不成两只蝶
    built.router.rows = [legRow(6900, 1, 2000, 20.1), legRow(6915, -1, 1100, 11), legRow(6930, -1, 380, 3.8), legRow(6945, 1, 90, 0.9)];
    for (let i = 0; i < PENDING_MISS_ROUNDS - 1; i += 1) await built.service.trackTick();
    expect((await built.service.status()).tracks_pending).toBe(1);
    expect(titles(built.notes)).toEqual(["Discord 跟单:已跟单"]);
    await built.service.trackTick();
    expect(added).toEqual([]);
    expect((await built.service.status()).tracks_pending).toBe(0);
    expect(built.notes.find(([title]) => title === "Discord 跟单:没有建追踪")![2]).toContain("持仓里找不到这只蝶");
  });

  it("关掉自动跟单、或关掉这一项:在等的一律不建(收回授权不比给出难),说一声", async () => {
    for (const off of [{ enabled: false }, { track_fly: false }] as Array<Partial<FollowConfig>>) {
      const built = build({ track_fly: true });
      const { added } = wire(built);
      await built.service.onMessage(message(FLY));
      Object.assign(built.host.settings.follow, off);
      fill(built.engine, 1, 1, true);
      built.router.rows = flyRows();
      await built.service.trackTick();
      expect(added).toEqual([]);
      expect((await built.service.status()).tracks_pending).toBe(0);
      expect(built.notes.find(([title]) => title === "Discord 跟单:不再自动建追踪")![2]).toContain("1 只蝴蝶");
      expect(JSON.parse(auditOf(built.engine, "follow_track_dropped")[0]!["detail"])).toMatchObject({ reason: "switched_off" });
    }
  });

  it("隔了一天还没等到成交回报:不再等,说清楚之后成交也不会自动建", async () => {
    const built = build({ track_fly: true });
    const { added } = wire(built);
    await built.service.onMessage(message(FLY));
    setClock(NOW + 24 * 3600_000);
    built.router.rows = flyRows();
    await built.service.trackTick();
    expect(added).toEqual([]);
    expect((await built.service.status()).tracks_pending).toBe(0);
    expect(built.notes.find(([title]) => title === "Discord 跟单:没有建追踪")![2]).toContain("隔了一天");
  });

  it("引擎真正起来之后自己隔几秒核对一轮:有在等的才接着定时,建完就停;重启后起来的第一轮把上次留下的接上", async () => {
    useSecretBackend({ exists: async () => false, read: async () => null, write: async () => undefined });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const built = build({ track_fly: true });
      const { added } = wire(built);
      built.service.start();
      await built.service.sync();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(built.router.positionReads).toBe(0); // 没有在等的:第一轮看一眼库就不再跑,更不读持仓
      await built.service.onMessage(message(FLY));
      await built.service.settled();
      const quiet = built.events.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(built.router.positionReads).toBe(0);  // 单子还挂着、没有成交回报:只看它的记录,不读持仓
      expect(built.events.length).toBe(quiet);     // 名单没变:不写库、不惊动界面
      expect(added).toEqual([]);
      fill(built.engine, 1, 1, false);             // 成交了一部分,持仓还没出来
      await vi.advanceTimersByTimeAsync(7_000);
      expect(built.router.positionReads).toBeGreaterThanOrEqual(2); // 有成交了:一轮一轮地看持仓
      expect(added).toEqual([]);
      built.router.rows = flyRows();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(added).toHaveLength(1);
      const after = built.router.positionReads;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(built.router.positionReads).toBe(after); // 建完了:不再定时
      built.service.stop();

      // 另一条:登记之后软件退了;再起来(新的服务实例),不用等新消息,自己接着核对
      const first = build({ track_fly: true });
      wire(first);
      await first.service.onMessage(message(FLY));
      const again = new FollowService(first.host as ServiceHost);
      const later: TrackerAddParams[] = [];
      again.attach({ marks: new FakeMarks(first.router) as never, addTrack: async (params) => { later.push(params); return { track: { targets: {}, auto_close: { enabled: true }, id: "t9" } as Track }; } });
      fill(first.engine, 1, 1, true);
      first.router.rows = flyRows();
      again.start();
      await again.sync();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(later.map((p) => p.key)).toEqual([FLY_KEY]);
      again.stop();
      // 停了之后不再跑
      const idle = first.router.positionReads;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(first.router.positionReads).toBe(idle);
    } finally {
      vi.useRealTimers();
    }
  });

  it("发到两个账户:各登记各的,哪个账户成交了给哪个建", async () => {
    const built = build({ track_fly: true, accounts: ["模拟", "主账户"] }, { auto_execute: true, allow_live_trading: true });
    const { added } = wire(built);
    await built.service.onMessage(message(FLY));
    expect(built.router.placed.map((p) => p.approved.account.alias)).toEqual(["模拟", "主账户"]);
    expect((await built.service.status()).tracks_pending).toBe(2);
    fill(built.engine, 2, 1, true); // 只有主账户那张成交了
    built.router.rows = flyRows(1, "主账户");
    await built.service.trackTick();
    expect(added.map((p) => p.key)).toEqual([makeKey("主账户", "SPX", "BAG", FLY_LEG)]);
    expect((await built.service.status()).tracks_pending).toBe(1);
  });
});

describe("follow service: 建追踪走的是 tracker.add 的同一个 handler(真的 RpcServer)", () => {
  class RpcRouter {
    SUPPORTS_HOSTED_CLOSE = true;
    SUPPORTS_NATIVE_CONDITIONS = true;
    BROKER = "ibkr";
    upstreamOk = true;
    rows: Array<Record<string, unknown>> = [];
    placed: Array<Record<string, any>> = [];
    sessions(): unknown[] { return [{}]; }
    connectedNames(): string[] { return ["paper"]; }
    async positions() { return this.rows.map((r) => ({ ...r })); }
    async indexPrice(): Promise<number | null> { return 6907.35; }
    async optionQuotes(): Promise<Record<string, unknown>> { return {}; }
    async listHostedOpen(): Promise<unknown[]> { return []; }
    async place(recordId: string, approved: Record<string, any>) {
      this.placed.push(approved);
      return { record_id: recordId, order_id: 990, perm_id: null, status: "Submitted", limit_price: null, detail: {} };
    }
    async legQuotes(): Promise<unknown[]> { return []; }
    async cancelAllOpen(): Promise<number> { return 0; }
    async contractHours(): Promise<null> { return null; }
    cachedContractHours(): null { return null; }
  }
  const servers: RpcServer[] = [];
  const dirs: string[] = [];

  function server(follow: Record<string, unknown>) {
    const dir = mkdtempSync(path.join(tmpdir(), "dafri-follow-rpc-"));
    dirs.push(dir);
    const base = JSON.parse(readFileSync(path.resolve(__dirname, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
    const settingsPath = path.join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      ...base, policies: { ...base.policies, auto_execute: true }, storage: { db_path: path.join(dir, "t.db") }, follow,
    }));
    const s = new RpcServer(settingsPath, () => undefined);
    const router = new RpcRouter();
    s.router = router as never;
    servers.push(s);
    return { s, router };
  }

  afterEach(() => {
    for (const s of servers.splice(0)) {
      s.anomaly.stop();
      s.follow.stop();
      s.flyPlanner.marks.close();
      s.engineBuilt?.stopTrackerLoop();
    }
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* Windows 上 sqlite 句柄可能还占着 */
      }
    }
  });

  it("跟了一只 2 张的蝴蝶、成交之后:库里多出一条追踪,和在「持仓追踪」页用界面的载荷建出来的那条目标与平仓设置一字不差", async () => {
    const { s, router } = server({ enabled: true, channel_id: CHANNEL, author_ids: [FRIEND], max_risk_usd: 1000, track_fly: true, track_exit_at: "15:45" });
    await s.follow.onMessage(message("0.5 挂15蝴蝶 15CM 2张"));
    expect(router.placed).toHaveLength(1);
    expect((await s.follow.status()).tracks_pending).toBe(1);
    s.engine.onExecDetails({ order: { orderId: 990 } }, { execution: { execId: "x1", price: 0.5, shares: 2 }, contract: { secType: "BAG" } });
    s.engine.onOrderStatus({ order: { orderId: 990 }, orderStatus: { status: "Filled", filled: 2, remaining: 0 } });
    router.rows = flyRows(2);
    await s.follow.trackTick();

    const tracks = s.engine.store.listTracks();
    expect(tracks).toHaveLength(1);
    const track = tracks[0]!;
    expect(track).toMatchObject({ account: "模拟", symbol: "SPX", sec_type: "BAG", leg: FLY_LEG, enabled: true, note: FOLLOW_TRACK_NOTE, peak: 1.9 });
    // 每组成本 $180:$100 起算 = 0.555556 倍,$200 收紧 = 1.111111 倍(flyexit.drawdownUsdPreset)
    expect(track.targets).toMatchObject({
      take_profit: null, stop_loss: null, trail_pct: null, profit_drawdown_pct: null, spot_target: null,
      profit_drawdown_tiers: [{ above: 0, pct: 40 }, { above: 1.111111, pct: 30 }, { above: 3, pct: 20 }],
      profit_drawdown_arm: 0.555556, profit_drawdown_late: { after: "15:00", factor: 0.5 }, profit_drawdown_floor: 0.2,
      exit_at: "15:45", take_profit_tiers: null,
    });
    // 到点平仓换成了「下一次到美东 15:45」的那一刻(tracker.add 自己按本机时钟算的,这里只看它确实是个 15:45)
    const clockOf = (ms: unknown): string => stampAt(Number(ms), ET).slice(11);
    expect(clockOf(track.targets.exit_at_ms)).toBe("15:45");
    expect(track.auto_close).toMatchObject({ enabled: true, order_type: "LMT", host_at_broker: false, close_fraction_pct: 100, stop_basis: "mid" });
    expect((await s.follow.status()).tracks_pending).toBe(0);

    // 对照:另一份一样的持仓上,走 RPC、用界面那张表单的载荷(蝶式预设 + 自动平仓 + 15:45)建一条
    const other = server({});
    other.router.rows = flyRows(2);
    const ui = {
      key: FLY_KEY, take_profit: "", stop_loss: "", trail_pct: "", profit_drawdown_pct: "", profit_drawdown_preset: "fly",
      profit_drawdown_arm_pct: "", spot_target: "", spot_stop_below: "", spot_stop_above: "", auto_close: true, order_type: "LMT",
      host_at_broker: false, exit_at: "15:45", spot_stop_confirm_s: "", take_profit_tiers: "", stop_basis: "mid",
    };
    const reply = await other.s.handle({ jsonrpc: "2.0", id: 1, method: "tracker.add", params: ui });
    expect(reply["error"]).toBeUndefined();
    const byHand = reply["result"]["track"] as Track;
    const { exit_at_ms: mine, ...targets } = track.targets;
    const { exit_at_ms: theirs, ...targetsByHand } = byHand.targets;
    expect(targets).toEqual(targetsByHand);
    expect(clockOf(theirs)).toBe(clockOf(mine));
    expect(track.auto_close).toEqual(byHand.auto_close);
    expect(track.contract).toEqual(byHand.contract);
  });

  it("没设钟点、只有 1 张:同一条路,追踪不带到点平仓", async () => {
    const { s, router } = server({ enabled: true, channel_id: CHANNEL, author_ids: [FRIEND], track_fly: true });
    await s.follow.onMessage(message("1.8 挂15蝴蝶 15CM"));
    s.engine.onExecDetails({ order: { orderId: 990 } }, { execution: { execId: "x1", price: 1.8, shares: 1 }, contract: { secType: "BAG" } });
    router.rows = flyRows(1);
    await s.follow.trackTick();
    const [track] = s.engine.store.listTracks();
    expect(track).toMatchObject({ leg: FLY_LEG, note: FOLLOW_TRACK_NOTE });
    expect(track!.targets).toMatchObject({ exit_at: null, exit_at_ms: null, profit_drawdown_arm: 0.555556 });
    expect(track!.auto_close).toMatchObject({ enabled: true, order_type: "LMT" });
    // 第二轮:已经有这条在盯的追踪了,不会再建一条、也不报错
    await s.follow.trackTick();
    expect(s.engine.store.listTracks()).toHaveLength(1);
  });
});
