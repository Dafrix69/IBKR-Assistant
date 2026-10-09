/** Discord 跟单的判定规则、配置段、日志表(docs/features/follow.md)。全部离线:不连 Discord、不碰券商。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { withCombos } from "../src/combos.js";
import type { FollowConfig, FollowEntry, FollowQuote } from "../src/contract/follow.js";
import { PARAMS_SCHEMAS } from "../src/contract/schema/index.js";
import type { Track } from "../src/contract/tracker.js";
import { orderLegId } from "../src/engine/closing.js";
import {
  FOLLOW_TRACK_NOTE, PENDING_MISS_ROUNDS, RELATIVE_CENTER_MAX_POINTS, creditWorstCaseUsd, decide, flyTrackParams, followQuote, leaderPrice,
  orderText, outcomeOf, pendingLastDay, pendingTracksOf, pendingVerdict, relativeCenterProblem, remainderVerdict, trackExitsText, triage, whyUnparsed,
  worstCaseUsd,
} from "../src/follow.js";
import type { FollowGates, PendingFacts } from "../src/follow.js";
import { parseLlmPayload } from "../src/models.js";
import { makeKey } from "../src/positions.js";
import { tryParseShorthand } from "../src/shorthand.js";
import { TradeStore } from "../src/store.js";
import { clockMinutes } from "../src/trackerExits.js";
import { loadGolden, makeSettings } from "./util.js";

const gc = loadGolden("config");
const CHANNEL = "1100000000000000001";
const FRIEND = "220000000000000002";
const NOW = Date.UTC(2026, 7, 14, 14, 32, 0); // 美东周五 10:32
const FRIDAY = { epochMs: NOW, date: "2026-08-14", minutes: 10 * 60 + 32, seconds: (10 * 60 + 32) * 60 };

function cfg(patch: Partial<FollowConfig> = {}): FollowConfig {
  return {
    enabled: true, channel_id: CHANNEL, author_ids: [FRIEND], accounts: [],
    max_age_seconds: 30, max_orders_per_day: 3, max_risk_usd: 300, local_inbox: false, local_channel: "",
    track_fly: false, track_exit_at: "", ...patch,
  };
}

const OPEN: FollowGates = { breaker: null, autoExecute: true, connected: true };
const fly = (text: string): unknown => tryParseShorthand(text, { SPX: 6907.35 }, FRIDAY);

describe("follow: triage(不取行情的那一步)", () => {
  const message = (patch: Record<string, unknown> = {}) => ({
    channel_id: CHANNEL, author_id: FRIEND, content: "1.8 挂15蝴蝶 15CM", sentAtMs: NOW - 2000, ...patch,
  });

  it("信任的人在配置的频道发了一条新鲜的蝴蝶单 → 去解析", () => {
    expect(triage(cfg(), message(), NOW)).toEqual({ kind: "parse" });
  });

  it("别的频道、没配频道 → 不看", () => {
    expect(triage(cfg(), message({ channel_id: "1100000000000000009" }), NOW).kind).toBe("other_channel");
    expect(triage(cfg({ channel_id: "" }), message({ channel_id: "" }), NOW).kind).toBe("other_channel");
  });

  it("本地收件的消息:开关开着才看,信任名单里是显示名", () => {
    const local = message({ channel_id: "local", author_id: "local:老王" });
    expect(triage(cfg({ local_inbox: true, author_ids: ["local:老王"] }), local, NOW)).toEqual({ kind: "parse" });
    expect(triage(cfg({ local_inbox: true }), local, NOW).kind).toBe("untrusted");
    expect(triage(cfg({ local_inbox: false, author_ids: ["local:老王"] }), local, NOW).kind).toBe("other_channel");
    // 本地收件开着不等于 bot 那条路放宽:别的频道照样不看
    expect(triage(cfg({ local_inbox: true }), message({ channel_id: "1100000000000000009" }), NOW).kind).toBe("other_channel");
  });

  it("不在信任名单里的人,哪怕写的是一模一样的单 → 不跟", () => {
    expect(triage(cfg(), message({ author_id: "330000000000000003" }), NOW).kind).toBe("untrusted");
    expect(triage(cfg({ author_ids: [] }), message(), NOW).kind).toBe("untrusted");
  });

  it("信任的人说的不像单子 → 闲聊;光提到「蝴蝶」两个字的评论也是闲聊", () => {
    expect(triage(cfg(), message({ content: "今天感觉要大跌" }), NOW).kind).toBe("chatter");
    for (const content of ["@everyone 蝴蝶先走一下", "@everyone 蝴蝶止损了哦", "@everyone 蝴蝶和收租都可以走了", "@everyone 止盈"]) {
      expect(triage(cfg(), message({ content }), NOW).kind, content).toBe("chatter");
    }
  });

  it("带 @everyone 的单子照样认;贷方价差、没写方向的价差都算有单子的骨架(后者去解析、落成没接住)", () => {
    for (const content of ["@everyone 20蝴蝶 25cm 挂个4.5试试", "@everyone 00 95 bull put 试下 -2 -2.5", "@everyone 75 70 -2 试一下"]) {
      expect(triage(cfg(), message({ content }), NOW).kind, content).toBe("parse");
    }
  });

  it("orderText:摘掉提及,别的原样", () => {
    expect(orderText("@everyone 20蝴蝶 25cm 挂个4.5试试")).toBe("20蝴蝶 25cm 挂个4.5试试");
    expect(orderText("少挂点 @everyone")).toBe("少挂点");
    expect(orderText("<@123456789012345678> <@&223456789012345678> @here 7770 7775 bear call -2 <#323456789012345678>")).toBe("7770 7775 bear call -2");
    expect(orderText("@everyoneelse 不是提及")).toBe("@everyoneelse 不是提及");
  });

  it("按消息自己的时刻算新鲜度:正好在线上跟,过线不跟", () => {
    expect(triage(cfg(), message({ sentAtMs: NOW - 30_000 }), NOW).kind).toBe("parse");
    const stale = triage(cfg(), message({ sentAtMs: NOW - 31_000 }), NOW);
    expect(stale.kind).toBe("stale");
    expect(stale.kind === "stale" && stale.detail).toContain("31 秒");
  });

  it("本机时钟比 Discord 慢(消息像是来自未来)照样跟", () => {
    expect(triage(cfg(), message({ sentAtMs: NOW + 5000 }), NOW).kind).toBe("parse");
  });
});

describe("follow: decide(解析完之后)", () => {
  it("一张带权利金上限的买入蝴蝶,闸门都开着 → 发", () => {
    const d = decide(cfg(), fly("1.8 挂15蝴蝶 15CM"), OPEN, 0);
    expect(d.outcome).toBe("send");
    expect(d.summary).toContain("6900/6915/6930");
  });

  it("本地速记没接住 → 不交给大模型,不发", () => {
    const d = decide(cfg(), null, OPEN, 0);
    expect(d.outcome).toBe("unparsed");
    expect(d.detail).toContain("不交给大模型");
  });

  it("本地速记自己拒的(周末默认当日到期)→ 原话带出来", () => {
    const weekend = tryParseShorthand("1.8 挂15蝴蝶 15CM", { SPX: 6907.35 }, { ...FRIDAY, date: "2026-08-15" });
    const d = decide(cfg(), weekend, OPEN, 0);
    expect(d.outcome).toBe("rejected");
    expect(d.detail).toContain("不是交易日");
  });

  it("形状不是恰好一张买入蝴蝶 → 不发", () => {
    const payload = fly("1.8 挂15蝴蝶 15CM") as { orders: Array<Record<string, any>> };
    expect(decide(cfg(), { orders: [payload.orders[0], payload.orders[0]], rejections: [] }, OPEN, 0).outcome).toBe("unparsed");
    const sell = structuredClone(payload);
    sell.orders[0]!["order"]["action"] = "SELL";
    expect(decide(cfg(), sell, OPEN, 0).outcome).toBe("unparsed");
    const vertical = structuredClone(payload);
    vertical.orders[0]!["contract"]["combo_strategy"] = "VERTICAL";
    expect(decide(cfg(), vertical, OPEN, 0).outcome).toBe("unparsed");
  });

  it("单笔风险:张数 × 100 × 权利金;正好在线上发,过线不发", () => {
    expect(worstCaseUsd({ quantity: 2, premium: 1.5, wing: 15 })).toBe(300);
    expect(decide(cfg(), fly("1.5 挂15蝴蝶 15CM 2张"), OPEN, 0).outcome).toBe("send");
    const over = decide(cfg(), fly("1.6 挂15蝴蝶 15CM 2张"), OPEN, 0);
    expect(over.outcome).toBe("capped");
    expect(over.detail).toContain("$320");
    expect(over.detail).toContain("$300");
  });

  it("没写权利金的不跟:对方常把价格放在下一条消息里,软件不替人按中间价定价——上限调得再高也不跟", () => {
    const d = decide(cfg(), fly("15蝴蝶 15CM"), OPEN, 0);
    expect(d.outcome).toBe("unparsed");
    expect(d.detail).toContain("没写权利金上限");
    expect(d.summary).toContain("6900/6915/6930");
    expect(decide(cfg({ max_risk_usd: 100000 }), fly("15蝴蝶 15CM"), OPEN, 0).outcome).toBe("unparsed");
    // 只观察时也照实说"没接住",不记成"只观察"
    expect(decide(cfg({ enabled: false }), fly("15蝴蝶 15CM"), OPEN, 0).outcome).toBe("unparsed");
  });

  it("贷方价差:最坏亏损 = 张数 × 100 ×(宽度 − 收到的权利金);正好在线上发,过线不发", () => {
    expect(creditWorstCaseUsd({ quantity: 1, credit: 2.5, width: 5 })).toBe(250);
    expect(creditWorstCaseUsd({ quantity: 2, credit: 2, width: 5 })).toBe(600);
    const spread = (text: string): unknown => tryParseShorthand(text, { SPX: 6907.35 }, FRIDAY);
    const ok = decide(cfg(), spread("6920 6925 bear call 挂个-2-2.5"), OPEN, 0);
    expect(ok.outcome).toBe("send");
    expect(ok.summary).toContain("6920/6925 看涨贷方价差");
    expect(decide(cfg(), spread("6920 6925 bear call -2"), OPEN, 0).outcome).toBe("send"); // 300,正好在线上
    const over = decide(cfg(), spread("2张 6920 6925 bear call -2.5"), OPEN, 0);
    expect(over.outcome).toBe("capped");
    expect(over.detail).toContain("$500");
    expect(over.detail).toContain("宽 5 点 − 收 2.5");
    const observed = decide(cfg({ enabled: false }), spread("00 95 bull put 试下 -2 -2.5"), OPEN, 0);
    expect(observed.outcome).toBe("observed");
    expect(observed.detail).toContain("$250");
  });

  it("形状不对的价差不跟:借方的、没写价格的、收的比宽度多的", () => {
    const base = tryParseShorthand("6920 6925 bear call -2.5", { SPX: 6907.35 }, FRIDAY) as { orders: Array<Record<string, any>> };
    const debit = structuredClone(base);
    debit.orders[0]!["order"]["action"] = "BUY";
    expect(decide(cfg(), debit, OPEN, 0).outcome).toBe("unparsed");
    const noPrice = structuredClone(base);
    noPrice.orders[0]!["order"]["lmtPrice"] = null;
    expect(decide(cfg(), noPrice, OPEN, 0).outcome).toBe("unparsed");
    const tooMuch = structuredClone(base);
    tooMuch.orders[0]!["order"]["lmtPrice"] = 5;
    expect(decide(cfg(), tooMuch, OPEN, 0).outcome).toBe("unparsed");
  });

  it("whyUnparsed:像价差却没写方向的,说出差的是哪一样;别的回 null", () => {
    expect(whyUnparsed("75 70 -2 试一下")).toContain("bull put 还是 bear call");
    expect(whyUnparsed("可以挂单下 7860 7865 -2 -2.5")).toContain("方向猜不得");
    expect(whyUnparsed("2块1尝试下 7650 10CM彩票")).toBeNull();
    expect(whyUnparsed("00 95 bull put 试下")).toBeNull();
  });

  it("跟单开关关着 → 只观察;超了单笔上限的照样说超了", () => {
    const d = decide(cfg({ enabled: false }), fly("1.8 挂15蝴蝶 15CM"), OPEN, 0);
    expect(d.outcome).toBe("observed");
    expect(d.detail).toContain("$180");
    expect(decide(cfg({ enabled: false }), fly("1.6 挂15蝴蝶 15CM 2张"), OPEN, 0).outcome).toBe("capped");
  });

  it("闸门和手动发单是同一套:熔断、自动执行没开、没连券商都不发", () => {
    const payload = fly("1.8 挂15蝴蝶 15CM");
    const broken = decide(cfg(), payload, { ...OPEN, breaker: "连续 3 次下单失败" }, 0);
    expect(broken.outcome).toBe("blocked");
    expect(broken.detail).toContain("连续 3 次下单失败");
    expect(decide(cfg(), payload, { ...OPEN, autoExecute: false }, 0).detail).toContain("允许自动执行");
    expect(decide(cfg(), payload, { ...OPEN, connected: false }, 0).detail).toContain("没有连接券商");
  });

  it("每天几单:到了上限不发", () => {
    const payload = fly("1.8 挂15蝴蝶 15CM");
    expect(decide(cfg(), payload, OPEN, 2).outcome).toBe("send");
    const capped = decide(cfg(), payload, OPEN, 3);
    expect(capped.outcome).toBe("capped");
    expect(capped.detail).toContain("每天 3 单");
  });
});

describe("follow: outcomeOf(引擎的四个桶 → 这条信号的下场)", () => {
  const order = (record_id: string, account: string) => ({ record_id, account, intent_summary: "", notional: 0, ticket: {} as never });
  const empty = { submitted: [], queued: [], validated_only: [], rejections: [], warnings: [] };

  it("有一笔发出去就算已跟单,另一个账户被拒写进说明", () => {
    const out = outcomeOf({
      ...empty, submitted: [order("r1", "模拟")],
      rejections: [{ source: "validator", code: "LIVE_TRADING_DISABLED", message: "实盘账户下单没有打开" }],
    });
    expect(out.outcome).toBe("sent");
    expect(out.record_ids).toEqual(["r1"]);
    expect(out.detail).toContain("模拟");
    expect(out.detail).toContain("实盘账户下单没有打开");
  });

  it("进了软件盯盘队列也算发出", () => {
    expect(outcomeOf({ ...empty, queued: [order("r2", "模拟")] }).outcome).toBe("sent");
  });

  it("只过了校验 → 没有发出;全被拒 → 带第一条原因", () => {
    const held = outcomeOf({ ...empty, validated_only: [order("r3", "模拟")] });
    expect(held.outcome).toBe("held");
    expect(held.record_ids).toEqual(["r3"]);
    const rejected = outcomeOf({
      ...empty, rejections: [{ source: "validator", code: "DUPLICATE_ORDER", message: "疑似重复下单", record_id: "r4" }],
    });
    expect(rejected).toEqual({ outcome: "rejected", detail: "疑似重复下单", record_ids: ["r4"] });
    expect(outcomeOf(empty).detail).toBe("没有产生订单");
  });
});

describe("follow: 配置段", () => {
  it("不写这一段 = 关着、不连 Discord", () => {
    expect(makeSettings(gc.base_config).follow).toEqual({
      enabled: false, channel_id: "", author_ids: [], accounts: [],
      max_age_seconds: 30, max_orders_per_day: 3, max_risk_usd: 300, local_inbox: false, local_channel: "",
      track_fly: false, track_exit_at: "",
    });
  });

  it("成交后自动建追踪:默认关;到点平仓的钟点掐头去尾存下,空着 = 不设;开关不是布尔当场报", () => {
    const on = makeSettings(gc.base_config, { follow: { track_fly: true, track_exit_at: " 15:45 " } }).follow;
    expect(on.track_fly).toBe(true);
    expect(on.track_exit_at).toBe("15:45");
    expect(makeSettings(gc.base_config, { follow: { track_exit_at: "" } }).follow.track_exit_at).toBe("");
    expect(makeSettings(gc.base_config, { follow: { track_exit_at: "   " } }).follow.track_exit_at).toBe("");
    expect(() => makeSettings(gc.base_config, { follow: { track_fly: "true" } })).toThrow(/follow\.track_fly 必须是 true\/false/);
    for (const bad of [1545, true, ["15:45"]]) {
      expect(() => makeSettings(gc.base_config, { follow: { track_exit_at: bad } }), String(bad)).toThrow(/follow\.track_exit_at 必须是美东时间的 HH:MM/);
    }
  });

  it("到点平仓的钟点:配置这一层认的写法,和持仓追踪认的(trackerExits.clockMinutes)一个不多、一个不少", () => {
    // 配置在地基层,引不到分析层的 clockMinutes,所以照着写了一份;两边哪天走了样,填得进配置的钟点到建追踪那一刻才被拒,那只蝶就没有追踪
    const samples = [
      "15:45", "9:30", "09:30", "0:00", "00:00", "23:59", "3:05", " 15:45 ",
      "24:00", "12:60", "1545", "15:4", "15:455", "115:45", "15:45 ET", "15：45", "ab:cd", "-1:30", "15:45:00", "１５:４５", "15.45",
    ];
    for (const text of samples) {
      let accepted = true;
      try {
        makeSettings(gc.base_config, { follow: { track_exit_at: text } });
      } catch {
        accepted = false;
      }
      expect(accepted, JSON.stringify(text)).toBe(clockMinutes(text) !== null);
    }
    // 空串是"不设",配置认、clockMinutes 不认——建追踪时空串不会走到它那里
    expect(clockMinutes("")).toBeNull();
  });

  it("本地收件的频道名:掐头去尾存下;不是字符串、带换行、超过 100 字的当场报", () => {
    expect(makeSettings(gc.base_config, { follow: { local_channel: "  charlie的策略 " } }).follow.local_channel).toBe("charlie的策略");
    expect(makeSettings(gc.base_config, { follow: { local_channel: "x".repeat(100) } }).follow.local_channel).toHaveLength(100);
    for (const bad of [7, ["charlie"], "a\nb", "x".repeat(101)]) {
      expect(() => makeSettings(gc.base_config, { follow: { local_channel: bad } }), String(bad)).toThrow(/follow\.local_channel 必须是不超过 100 字、不含换行的频道名/);
    }
  });

  it("信任名单里可以是本地收件的显示名(local:名字);带换行、空名字、太长的不行", () => {
    expect(makeSettings(gc.base_config, { follow: { author_ids: [FRIEND, "local:Charlie 老王"] } }).follow.author_ids).toEqual([FRIEND, "local:Charlie 老王"]);
    for (const bad of ["local:", "local:a\nb", `local:${"x".repeat(81)}`, "Charlie"]) {
      expect(() => makeSettings(gc.base_config, { follow: { author_ids: [bad] } }), bad).toThrow(/follow\.author_ids\[0\] 必须是带引号的 Discord ID/);
    }
  });

  it("ID 必须是带引号的一串数字:写成数字会丢精度,当场报", () => {
    expect(() => makeSettings(gc.base_config, { follow: { channel_id: Number(CHANNEL) } })).toThrow(/follow\.channel_id 必须是带引号的 Discord ID/);
    expect(() => makeSettings(gc.base_config, { follow: { author_ids: ["friend"] } })).toThrow(/follow\.author_ids\[0\]/);
    expect(() => makeSettings(gc.base_config, { follow: { author_ids: FRIEND } })).toThrow(/follow\.author_ids 必须是数组/);
  });

  it("不认识的键、越界的数、不是布尔的开关都当场报", () => {
    expect(() => makeSettings(gc.base_config, { follow: { enable: true } })).toThrow("follow 里有未知配置项:enable");
    expect(() => makeSettings(gc.base_config, { follow: { enabled: "true" } })).toThrow(/follow\.enabled 必须是 true\/false/);
    expect(() => makeSettings(gc.base_config, { follow: { max_age_seconds: 0 } })).toThrow(/follow\.max_age_seconds 不能小于 1/);
    expect(() => makeSettings(gc.base_config, { follow: { max_orders_per_day: 101 } })).toThrow(/follow\.max_orders_per_day 不能大于 100/);
    expect(() => makeSettings(gc.base_config, { follow: { max_risk_usd: 0 } })).toThrow(/follow\.max_risk_usd 不能小于 1\.0/);
  });

  it("重复的 ID 与别名去重;开着却没填频道 / 认不出的别名不算配置错(引擎照常起)", () => {
    const s = makeSettings(gc.base_config, {
      follow: { enabled: true, author_ids: [FRIEND, FRIEND], accounts: ["模拟", "模拟", "改过名的账户"] },
    });
    expect(s.follow.author_ids).toEqual([FRIEND]);
    expect(s.follow.accounts).toEqual(["模拟", "改过名的账户"]);
    expect(s.follow.channel_id).toBe("");
  });
});

describe("follow: 日志表", () => {
  function store(): TradeStore {
    return new TradeStore(path.join(mkdtempSync(path.join(tmpdir(), "dafri-follow-log-")), "f.db"));
  }
  const entry = (patch: Partial<FollowEntry> = {}): FollowEntry => ({
    at: "2026-08-14T14:32:00+00:00", message_id: "1400000000000000001", author_id: FRIEND, author_name: "老王",
    text: "1.8 挂15蝴蝶 15CM", outcome: "sent", detail: "已发出 1 笔(模拟)", summary: "买入 1 张…", record_ids: ["r1"], ...patch,
  });

  it("同一条消息只落一次", () => {
    const s = store();
    expect(s.follow.has("1400000000000000001")).toBe(false);
    expect(s.follow.add(entry())).toBe(true);
    expect(s.follow.has("1400000000000000001")).toBe(true);
    expect(s.follow.add(entry({ outcome: "rejected" }))).toBe(false);
    expect(s.follow.recent()).toEqual([entry()]);
  });

  it("今天跟了几单只数发出去的、只数起点之后的", () => {
    const s = store();
    s.follow.add(entry({ message_id: "1400000000000000001", at: "2026-08-14T03:59:59+00:00" })); // 美东前一天
    s.follow.add(entry({ message_id: "1400000000000000002", at: "2026-08-14T04:00:00+00:00" }));
    s.follow.add(entry({ message_id: "1400000000000000003", at: "2026-08-14T15:00:00+00:00", outcome: "observed" }));
    s.follow.add(entry({ message_id: "1400000000000000004", at: "2026-08-14T15:01:00+00:00" }));
    expect(s.follow.sentSince("2026-08-14T04:00:00+00:00")).toBe(2);
    expect(s.follow.recent(2).map((e) => e.message_id)).toEqual(["1400000000000000004", "1400000000000000003"]);
  });

  it("只增不改:库层面就拒绝改和删", () => {
    const s = store();
    s.follow.add(entry());
    const db = (s as unknown as { db: { prepare(sql: string): { run(): unknown } } }).db;
    expect(() => db.prepare("UPDATE follow_log SET outcome = 'observed'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM follow_log").run()).toThrow(/append-only/);
  });

  const QUOTE: FollowQuote = { side: "debit", leader: 1.8, mid: 1.95, natural: 2.1, lag_s: 4, paper: true };

  it("盘口另存一张表、按消息接上:没取到的那几条读出来和以前一字不差(没有 quote 这个键)", () => {
    const s = store();
    s.follow.add(entry());
    s.follow.add(entry({ message_id: "1400000000000000002", outcome: "observed", record_ids: [] }));
    expect(s.follow.addQuote("1400000000000000001", "2026-08-14T14:32:05+00:00", QUOTE)).toBe(true);
    const [second, first] = s.follow.recent();
    expect(first).toEqual({ ...entry(), quote: QUOTE });
    expect(second).toEqual(entry({ message_id: "1400000000000000002", outcome: "observed", record_ids: [] }));
    expect(Object.keys(second!)).not.toContain("quote");
    // 「今天跟了几单」不受这张表影响
    expect(s.follow.sentSince("2026-08-14T00:00:00+00:00")).toBe(1);
  });

  it("一条消息只记第一次盘口;没有日志的消息、不是正经数的不记;这张表同样只增不改", () => {
    const s = store();
    s.follow.add(entry());
    expect(s.follow.addQuote("1400000000000000009", "2026-08-14T14:32:05+00:00", QUOTE)).toBe(false);
    expect(s.follow.addQuote("1400000000000000001", "2026-08-14T14:32:05+00:00", { ...QUOTE, mid: Number.NaN })).toBe(false);
    expect(s.follow.addQuote("1400000000000000001", "2026-08-14T14:32:05+00:00", QUOTE)).toBe(true);
    expect(s.follow.addQuote("1400000000000000001", "2026-08-14T14:33:00+00:00", { ...QUOTE, mid: 9 })).toBe(false);
    expect(s.follow.recent()[0]!.quote).toEqual(QUOTE);
    const db = (s as unknown as { db: { prepare(sql: string): { run(): unknown } } }).db;
    expect(() => db.prepare("UPDATE follow_quotes SET mid = 9").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM follow_quotes").run()).toThrow(/append-only/);
  });

  it("老库(只有日志表、没有盘口表)打开就补上,原来的日志照读;不用动库的结构版本号", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "dafri-follow-old-")), "f.db");
    const old = new TradeStore(file);
    old.follow.add(entry());
    old.rawExec("DROP TRIGGER follow_quotes_no_update");
    old.rawExec("DROP TRIGGER follow_quotes_no_delete");
    old.rawExec("DROP TABLE follow_quotes");
    old.close();
    const again = new TradeStore(file);
    expect(again.follow.recent()).toEqual([entry()]);
    expect(again.follow.addQuote("1400000000000000001", "2026-08-14T14:32:05+00:00", QUOTE)).toBe(true);
    again.close();
  });
});

describe("follow: 延迟的代价(对方写的价对着此刻的盘口)", () => {
  const order = (text: string) => parseLlmPayload(fly(text)).orders[0]!;

  it("对方写的价:买入蝴蝶是付的,贷方价差是收的;别的结构、没写价的没有可比的价", () => {
    const butterfly = order("1.8 挂15蝴蝶 15CM");
    expect(leaderPrice(butterfly.contract, butterfly.order)).toEqual({ side: "debit", price: 1.8 });
    const spread = order("6920 6925 bear call 挂个-2-2.5");
    expect(leaderPrice(spread.contract, spread.order)).toEqual({ side: "credit", price: 2.5 });
    expect(leaderPrice(butterfly.contract, { ...butterfly.order, lmtPrice: null })).toBeNull();
    expect(leaderPrice(butterfly.contract, { ...butterfly.order, action: "SELL" })).toBeNull(); // 卖出的蝴蝶不跟
    expect(leaderPrice(spread.contract, { ...spread.order, action: "BUY" })).toBeNull();        // 借方价差不跟
    expect(leaderPrice({ combo_strategy: "IRON_CONDOR" }, { action: "SELL", lmtPrice: 2 })).toBeNull();
  });

  it("带符号的净价换成和对方同一个方向的正数:蝴蝶照抄,贷方价差取相反数", () => {
    expect(followQuote({ side: "debit", price: 2.5 }, { mid: 2.8, natural: 3.05 }, 6_400, false))
      .toEqual({ side: "debit", leader: 2.5, mid: 2.8, natural: 3.05, lag_s: 6, paper: false });
    expect(followQuote({ side: "credit", price: 2.5 }, { mid: -2.3, natural: -2.1 }, 2_600, true))
      .toEqual({ side: "credit", leader: 2.5, mid: 2.3, natural: 2.1, lag_s: 3, paper: true });
  });

  it("中间价的方向和这张单对不上(盘口是坏的)不记;立刻成交的价照实记,哪怕贷方价差立刻卖一分钱都收不到", () => {
    expect(followQuote({ side: "debit", price: 2.5 }, { mid: -0.1, natural: 0.3 }, 1000, false)).toBeNull();
    expect(followQuote({ side: "debit", price: 2.5 }, { mid: 0, natural: 0.3 }, 1000, false)).toBeNull();
    expect(followQuote({ side: "credit", price: 2.5 }, { mid: 0.2, natural: 0.6 }, 1000, false)).toBeNull();
    expect(followQuote({ side: "credit", price: 2.5 }, { mid: -0.4, natural: 0.3 }, 1000, false)).toMatchObject({ mid: 0.4, natural: -0.3 });
    expect(followQuote({ side: "debit", price: 2.5 }, { mid: Number.NaN, natural: 3 }, 1000, false)).toBeNull();
    // 本机时钟比消息的时刻还早(时钟偏慢):隔了多久记 0,不记成负数
    expect(followQuote({ side: "debit", price: 2.5 }, { mid: 2.8, natural: 3 }, -800, false)!.lag_s).toBe(0);
  });
});

describe("follow: 跟进来的蝴蝶成交后建追踪(纯函数那一半)", () => {
  const LEG = "20260814|+1x6900C,-2x6915C,+1x6930C";
  const KEY = makeKey("模拟", "SPX", "BAG", LEG);
  const leg = (strike: number, quantity: number, avgCost: number): Record<string, unknown> => ({
    key: makeKey("模拟", "SPX", "OPT", `20260814|${strike}|C`), account: "模拟", symbol: "SPX", sec_type: "OPT",
    leg: `20260814|${strike}|C`, quantity, multiplier: 100, currency: "USD", avg_cost: avgCost, market_price: null,
    contract: { secType: "OPT", symbol: "SPX", lastTradeDateOrContractMonth: "20260814", strike, right: "C", multiplier: "100", tradingClass: "SPXW" },
  });

  it("订单的腿身份 = 它开出来的那条组合持仓行的 leg:1 张与 3 张的蝴蝶都对得上,看跌蝶也一样", () => {
    const one = parseLlmPayload(fly("1.8 挂15蝴蝶 15CM")).orders[0]!;
    expect(orderLegId(one)).toBe(LEG);
    for (const lots of [1, 3]) {
      const rows = withCombos([leg(6900, lots, 2000), leg(6915, -2 * lots, 1100), leg(6930, lots, 380)]);
      const bag = rows.find((r) => r["sec_type"] === "BAG")!;
      expect(bag["leg"], `${lots} 张`).toBe(LEG);
      expect(bag["key"]).toBe(KEY);
      expect(bag["quantity"]).toBe(lots);
    }
    const puts = parseLlmPayload(tryParseShorthand("SPX 6890蝴蝶 15cm put 1.8", { SPX: 6907.35 }, FRIDAY)).orders[0]!;
    const put = (strike: number, quantity: number): Record<string, unknown> => ({
      ...leg(strike, quantity, 500), key: makeKey("模拟", "SPX", "OPT", `20260814|${strike}|P`), leg: `20260814|${strike}|P`,
      contract: { secType: "OPT", symbol: "SPX", lastTradeDateOrContractMonth: "20260814", strike, right: "P", multiplier: "100" },
    });
    const strikes = puts.contract.legs!.map((l) => l.strike);
    expect(puts.contract.legs!.every((l) => l.right === "P")).toBe(true);
    const bag = withCombos([put(strikes[0]!, 2), put(strikes[1]!, -4), put(strikes[2]!, 2)]).find((r) => r["sec_type"] === "BAG")!;
    expect(bag["leg"]).toBe(orderLegId(puts));
  });

  it("交给 tracker.add 的入参:和界面那张表单勾「蝶式预设」「到价自动平仓」时发的逐键相同,只多钟点与备注", () => {
    expect(flyTrackParams(KEY, "")).toEqual({
      key: KEY,
      take_profit: "", stop_loss: "", trail_pct: "",
      profit_drawdown_pct: "", profit_drawdown_preset: "fly", profit_drawdown_arm_pct: "",
      spot_target: "", spot_stop_below: "", spot_stop_above: "",
      auto_close: true, order_type: "LMT", host_at_broker: false,
      exit_at: "", spot_stop_confirm_s: "", take_profit_tiers: "", stop_basis: "mid",
      note: FOLLOW_TRACK_NOTE,
    });
    expect(flyTrackParams(KEY, " 15:45 ").exit_at).toBe("15:45");
    // tracker.add 的入参 schema 是 strict 的:多一个它不认识的键,这里就会红
    expect(PARAMS_SCHEMAS["tracker.add"].safeParse(flyTrackParams(KEY, "15:45")).success).toBe(true);
  });

  it("界面那张表单的默认值没有走样(蝶式预设 + 自动平仓、别的不动):拿它的源码对一遍", async () => {
    const { readFileSync } = await import("node:fs");
    const { pathToFileURL } = await import("node:url");
    const lib = path.resolve(__dirname, "..", "..", "desktop", "renderer-react", "src", "lib");
    const exits = (await import(/* @vite-ignore */ pathToFileURL(path.join(lib, "trackExitForm.ts")).href)) as unknown as {
      emptyExitFields: unknown; exitSpec(f: unknown, derivative: boolean): Record<string, unknown>;
    };
    // 出场细则那一组:表单一样没动、持仓是组合时拼出来的键
    const spec = JSON.parse(JSON.stringify(exits.exitSpec(exits.emptyExitFields, true))) as Record<string, unknown>;
    const mine = flyTrackParams(KEY, "") as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(spec)) expect(mine[k], k).toEqual(v);
    // 表单主体:这几行是 TrackForm.start() 里拼载荷的原话;它们改了,这里的入参要跟着核对
    const form = readFileSync(path.join(lib, "TrackForm.tsx"), "utf-8");
    for (const line of [
      "take_profit: hasSpotTarget ? '' : str(tp),", "stop_loss: str(sl),", "trail_pct: str(trail),",
      "profit_drawdown_pct: tiers ? '' : str(profitDd),", "profit_drawdown_preset: tiers ? 'fly' : undefined,",
      "profit_drawdown_arm_pct: tiers || profitDd == null ? '' : str(ddArm),", "spot_target: str(spotTarget),",
      "spot_stop_below: str(stopBelow),", "spot_stop_above: str(stopAbove),",
      "close_fraction_pct: str(fraction) || undefined,", "chase_max_pct: str(chaseMax) || undefined,",
      "auto_close: auto,", "order_type: orderType,", "host_at_broker: hostOn,", "...exitSpec(exits, derivative),",
      "useState<'MKT' | 'LMT'>(isCombo ? 'LMT' : 'MKT')",
    ]) expect(form, line).toContain(line);
    // 载荷里一共就这些键:表单多拼了一个,这里要跟着决定给什么值。平仓比例与追价上限两格默认空着(undefined,过 JSON 就没有这个键),
    // 这里同样不带;备注是这里多出来的
    const body = form.slice(form.indexOf("const spec: TrackerAddSpec = {"), form.indexOf("const problems = exitProblems"));
    const keys = [...body.matchAll(/^\s{6}([a-z_]+):/gm)].map((m) => String(m[1]));
    expect([...keys, ...Object.keys(spec)].sort()).toEqual(
      [...Object.keys(mine).filter((k) => k !== "note"), "close_fraction_pct", "chase_max_pct"].sort(),
    );
  });

  const NOON = Date.UTC(2026, 7, 14, 16, 0, 0); // 美东周五 12:00
  const item = { leg: LEG, at_ms: NOON };
  const facts = (patch: Partial<PendingFacts> = {}): PendingFacts => ({
    nowMs: NOON + 3000, filled: true, final: true, held: true, track: "none", misses: 0, ...patch,
  });

  it("先要有成交的证据再看持仓:单子还挂着时,账户里本来就有的一模一样的蝶不套追踪", () => {
    expect(pendingVerdict(item, facts({ filled: false, final: false, held: true }))).toBe("wait");
    expect(pendingVerdict(item, facts({ filled: false, final: false, held: false }))).toBe("wait");
    // 单子走完了、一张都没成交(撤了、被拒、失效):没有可追踪的
    expect(pendingVerdict(item, facts({ filled: false, final: true, held: true }))).toBe("unfilled");
  });

  it("成交了:有持仓就建(部分成交、单子还挂着也建);读不到持仓先等", () => {
    expect(pendingVerdict(item, facts())).toBe("create");
    expect(pendingVerdict(item, facts({ final: false }))).toBe("create");
    expect(pendingVerdict(item, facts({ held: null }))).toBe("wait");
  });

  it("成交了却找不到持仓:单子还挂着就等;走完了也先等几轮(回报比持仓早一拍),连续几轮都没有才说认不出", () => {
    expect(pendingVerdict(item, facts({ held: false, final: false, misses: 99 }))).toBe("wait");
    expect(pendingVerdict(item, facts({ held: false, misses: PENDING_MISS_ROUNDS - 1 }))).toBe("wait");
    expect(pendingVerdict(item, facts({ held: false, misses: PENDING_MISS_ROUNDS }))).toBe("no_position");
  });

  it("这只蝶上已经有追踪:在盯的沿用;停用 / 触发过的旧追踪挡着,照实说", () => {
    expect(pendingVerdict(item, facts({ track: "active" }))).toBe("covered");
    expect(pendingVerdict(item, facts({ track: "idle" }))).toBe("idle_track");
  });

  it("等到哪一天:当天到期的蝶等到当天;夜盘里下的次日到期的蝶多等一天;再往后不等", () => {
    expect(pendingLastDay(item)).toBe("2026-08-14");
    const dayEnd = Date.UTC(2026, 7, 15, 3, 59, 0);   // 美东 08-14 23:59
    expect(pendingVerdict(item, facts({ nowMs: dayEnd, filled: false, final: false }))).toBe("wait");
    expect(pendingVerdict(item, facts({ nowMs: dayEnd + 60_000, filled: false, final: false }))).toBe("expired");
    expect(pendingVerdict(item, facts({ nowMs: dayEnd + 60_000 }))).toBe("expired"); // 隔了日,哪怕有成交也不再建
    // 美东 08-13 21:00(夜盘)下的 08-14 到期的蝶:等到 08-14 结束
    const overnight = { leg: LEG, at_ms: Date.UTC(2026, 7, 14, 1, 0, 0) };
    expect(pendingLastDay(overnight)).toBe("2026-08-14");
    expect(pendingVerdict(overnight, facts({ nowMs: NOON, filled: false, final: false }))).toBe("wait");
    // 到期日更远的也只多等一天:当日有效的单最晚在下一个常规时段收盘时失效
    expect(pendingLastDay({ leg: "20260918|+1x6900C,-2x6915C,+1x6930C", at_ms: NOON })).toBe("2026-08-15");
    expect(pendingLastDay({ leg: "乱写的", at_ms: NOON })).toBe("2026-08-14");
  });

  it("从库里读回来的那一份:形状不对的条目丢掉,不是数组当没有", () => {
    const good = { record_id: "r1", message_id: "m1", account: "模拟", symbol: "SPX", leg: LEG, summary: "买入 1 张…", at_ms: NOON };
    expect(pendingTracksOf([good, { ...good, record_id: "" }, { ...good, at_ms: "昨天" }, null, "x", { ...good, leg: 7 }])).toEqual([good]);
    expect(pendingTracksOf(null)).toEqual([]);
    expect(pendingTracksOf({ 0: good })).toEqual([]);
    // 追踪已经有着落的那种带着当时的成交条数;这个数不像样就当它还在等建追踪
    expect(pendingTracksOf([{ ...good, settled_fills: 4 }])).toEqual([{ ...good, settled_fills: 4 }]);
    expect(pendingTracksOf([{ ...good, settled_fills: "4" }, { ...good, settled_fills: -1 }])).toEqual([good, good]);
  });

  it("部分成交就建了追踪的单:走完之前接着看;后来又成交而追踪已经触发过(或停了、被删了),要说", () => {
    const settled = { ...item, settled_fills: 4 };
    const now = { nowMs: NOON + 60_000, final: false, fills: 4, track: "active" as const };
    expect(remainderVerdict(settled, now)).toBe("wait");
    expect(remainderVerdict(settled, { ...now, track: "idle" })).toBe("wait");            // 追踪触发了,但这张单没有新的成交:没什么要说
    expect(remainderVerdict(settled, { ...now, fills: 8 })).toBe("absorbed");               // 又成交了,追踪还在盯
    expect(remainderVerdict(settled, { ...now, fills: 8, track: "idle" })).toBe("late_fill");
    expect(remainderVerdict(settled, { ...now, fills: 8, track: "none" })).toBe("late_fill");
    expect(remainderVerdict(settled, { ...now, final: true })).toBe("done");
    expect(remainderVerdict(settled, { ...now, final: true, fills: 8 })).toBe("done");      // 走完了,追踪在盯:不用再看
    // 最后那一下才成交、追踪早就触发过:单子走完了也要说
    expect(remainderVerdict(settled, { ...now, final: true, fills: 8, track: "idle" })).toBe("late_fill");
    expect(remainderVerdict(settled, { ...now, nowMs: Date.UTC(2026, 7, 15, 4, 1, 0) })).toBe("done"); // 隔了日
  });

  it("建好的追踪带着什么,照追踪行里的数说:起算线、档位、尾盘收紧、到点平仓、是不是自动平仓", () => {
    const track = (targets: Track["targets"], auto: Track["auto_close"] = { enabled: true }): Pick<Track, "targets" | "auto_close"> => ({ targets, auto_close: auto });
    const preset = {
      profit_drawdown_tiers: [{ above: 0, pct: 40 }, { above: 1.111111, pct: 30 }, { above: 3, pct: 20 }],
      profit_drawdown_arm: 0.555556, profit_drawdown_late: { after: "15:00", factor: 0.5 },
    };
    expect(trackExitsText(track(preset), NOON)).toBe(
      "蝶式预设:浮盈到过成本的 55.6% 起算,从峰值回撤 40 / 30 / 20% 就平,美东 15:00 之后阈值乘 0.5;到价由软件自动发平仓单",
    );
    const today = Date.UTC(2026, 7, 14, 19, 45, 0); // 美东 08-14 15:45
    expect(trackExitsText(track({ ...preset, exit_at: "15:45", exit_at_ms: today }), NOON)).toContain(";到点平仓:美东 15:45;");
    // 建的时候今天的 15:45 已经过了:落在明天,写明是哪一天
    expect(trackExitsText(track({ exit_at: "15:45", exit_at_ms: today + 86_400_000 }), today + 60_000))
      .toBe("到点平仓:美东 08-15 15:45(今天的这个钟点已经过了);到价由软件自动发平仓单");
    expect(trackExitsText(track({}, { enabled: false }), NOON)).toBe("只提醒,不自动平仓");
  });
});


describe("follow: 「N蝴蝶」在百位边上说不清,不跟", () => {
  const parse = (text: string, spot: number): unknown => tryParseShorthand(text, { SPX: spot }, FRIDAY);

  it("现价 7690 时「00蝴蝶」按百位算成 7600,离现价 90 点——说的多半是 7700:不跟,说明里写了算成什么、怎么改", () => {
    const problem = relativeCenterProblem(parse("00蝴蝶 20CM 3.6", 7690), 7690);
    expect(problem).not.toBeNull();
    expect(problem!.detail).toContain("中心 7600");
    expect(problem!.detail).toContain("有 90 点");
    expect(problem!.detail).toContain("7700蝴蝶");
    expect(problem!.summary).toContain("7580/7600/7620");
  });

  it("阈值:离现价不到 50 点的照跟,正好 50 点(两个百位一样近)不跟", () => {
    expect(RELATIVE_CENTER_MAX_POINTS).toBe(50);
    expect(relativeCenterProblem(parse("00蝴蝶 20CM 3.6", 7649.9), 7649.9)).toBeNull();
    expect(relativeCenterProblem(parse("00蝴蝶 20CM 3.6", 7650), 7650)).not.toBeNull();
    expect(relativeCenterProblem(parse("50蝴蝶 20CM 3.6", 7690), 7690)).toBeNull(); // 7650,离 40 点
    expect(relativeCenterProblem(parse("20蝴蝶 25cm 挂个4.5试试", 7619), 7619)).toBeNull();
  });

  it("不是蝴蝶、现价不是数:不管(判定那一步自有说法)", () => {
    expect(relativeCenterProblem(null, 7690)).toBeNull();
    expect(relativeCenterProblem({ orders: [] }, 7690)).toBeNull();
    expect(relativeCenterProblem(parse("00蝴蝶 20CM 3.6", 7690), Number.NaN)).toBeNull();
  });
});
