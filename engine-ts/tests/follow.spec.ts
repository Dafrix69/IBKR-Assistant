/** Discord 跟单的判定规则、配置段、日志表(docs/features/follow.md)。全部离线:不连 Discord、不碰券商。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { FollowConfig, FollowEntry } from "../src/contract/follow.js";
import { decide, outcomeOf, triage, worstCaseUsd } from "../src/follow.js";
import type { FollowGates } from "../src/follow.js";
import { tryParseShorthand } from "../src/shorthand.js";
import { TradeStore } from "../src/store.js";
import { loadGolden, makeSettings } from "./util.js";

const gc = loadGolden("config");
const CHANNEL = "1100000000000000001";
const FRIEND = "220000000000000002";
const NOW = Date.UTC(2026, 7, 14, 14, 32, 0); // 美东周五 10:32
const FRIDAY = { epochMs: NOW, date: "2026-08-14", minutes: 10 * 60 + 32, seconds: (10 * 60 + 32) * 60 };

function cfg(patch: Partial<FollowConfig> = {}): FollowConfig {
  return {
    enabled: true, channel_id: CHANNEL, author_ids: [FRIEND], accounts: [],
    max_age_seconds: 30, max_orders_per_day: 3, max_risk_usd: 300, local_inbox: false, ...patch,
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

  it("信任的人说的不像蝴蝶单 → 闲聊", () => {
    expect(triage(cfg(), message({ content: "今天感觉要大跌" }), NOW).kind).toBe("chatter");
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

  it("没写权利金的按翼宽算最坏亏损(和校验层给 AUTO_MID 组合定敞口同一个口径)", () => {
    expect(worstCaseUsd({ quantity: 1, premium: null, wing: 15 })).toBe(1500);
    const d = decide(cfg(), fly("15蝴蝶 15CM"), OPEN, 0);
    expect(d.outcome).toBe("capped");
    expect(d.detail).toContain("按翼宽算");
    expect(decide(cfg({ max_risk_usd: 1500 }), fly("15蝴蝶 15CM"), OPEN, 0).outcome).toBe("send");
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
      max_age_seconds: 30, max_orders_per_day: 3, max_risk_usd: 300, local_inbox: false,
    });
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
});
