/** 确认凭据(desktop/confirm-grants.js):把"用户在原生确认框里点了确认"和"放行这一次调用"绑在一起。
 *
 * 钉的是:哪些调用要凭据;凭据绑着内容,内容变了不放行;用一次作废、过期作废;
 * 一次调用要几张就得几张都在,差一张不白烧已有的;主进程真的在转给引擎之前核销了它。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const DESKTOP = path.resolve(__dirname, "..", "..", "desktop");
const require = createRequire(import.meta.url);

interface Need { purpose: string; binding: Record<string, unknown> }
interface Book {
  issue(purpose: string, binding: unknown, now?: number): void;
  consume(purpose: string, binding: unknown, now?: number): boolean;
  consumeAll(needs: Need[], now?: number): string[];
}
interface Grants {
  PURPOSES: Record<string, string>;
  TTL_MS: number;
  GrantBook: new (opts?: { ttlMs?: number }) => Book;
  requiredGrants(method: string, params: unknown, current?: unknown): Need[];
  loosenedLimits(patch: unknown, current: unknown): { key: string; label: string; from: number; to: number }[];
  normalizeBinding(purpose: string, binding: unknown): Record<string, unknown>;
  canonical(value: unknown): string;
  followBinding(cfg: unknown): Record<string, unknown>;
  followWidened(next: unknown, now: unknown): boolean;
  followConfirmText(binding: Record<string, unknown>, accounts: unknown[]): { live: boolean; detail: string };
}
const g = require(path.join(DESKTOP, "confirm-grants.js")) as Grants;

const CURRENT = {
  policies: { auto_execute: false, allow_live_trading: false },
  limits: { max_order_notional: 5000, max_option_contracts: 5, max_mkt_shares: 200, max_spread_slippage: 0.1, min_confidence: 0.9, duplicate_window_minutes: 10, max_orders_per_input: 5 },
};

describe("哪些调用要凭据", () => {
  it("发单要;只解析不要", () => {
    expect(g.requiredGrants("instruction.submit", { text: "买 AAPL 100", execute: true, accounts: ["模拟"] })).toEqual([
      { purpose: "instruction.submit", binding: { text: "买 AAPL 100", accounts: ["模拟"] } },
    ]);
    expect(g.requiredGrants("instruction.submit", { text: "买 AAPL 100", execute: false, accounts: ["模拟"] })).toEqual([]);
  });

  it("立即平仓要;建追踪只在授权发单时要", () => {
    expect(g.requiredGrants("tracker.close_now", { id: "t1" })).toEqual([{ purpose: "tracker.close_now", binding: { id: "t1" } }]);
    expect(g.requiredGrants("tracker.add", { key: "k", stop_loss: "95", auto_close: false, host_at_broker: false })).toEqual([]);
    const spec = { key: "k", stop_loss: "95", auto_close: true, order_type: "LMT", host_at_broker: false };
    expect(g.requiredGrants("tracker.add", spec)).toEqual([{ purpose: "tracker.add", binding: spec }]);
  });

  it("打开闸门:从关到开才要,一个闸门一张;已经开着的、往关了改的不要", () => {
    const patch = { policies: { auto_execute: true, allow_live_trading: true, require_trigger_price_verification: true } };
    expect(g.requiredGrants("settings.patch", { patch }, CURRENT).map((n) => n.purpose)).toEqual(["gate.auto_execute", "gate.allow_live_trading"]);
    const on = { ...CURRENT, policies: { ...CURRENT.policies, auto_execute: true } };
    expect(g.requiredGrants("settings.patch", { patch }, on).map((n) => n.purpose)).toEqual(["gate.allow_live_trading"]);
    expect(g.requiredGrants("settings.patch", { patch: { policies: { auto_execute: false } } }, on)).toEqual([]);
  });

  it("现在的设置读不到:按闸门是关着的算(宁可多问一次)", () => {
    expect(g.requiredGrants("settings.patch", { patch: { policies: { auto_execute: true } } }, null).map((n) => n.purpose)).toEqual(["gate.auto_execute"]);
  });

  it("放宽限额要,只绑放宽了的那几项;收紧、不变的不要", () => {
    const needs = g.requiredGrants("settings.patch", {
      patch: { limits: { max_order_notional: 50000, max_option_contracts: 5, max_mkt_shares: 100, min_confidence: 0.8, duplicate_window_minutes: 0 } },
    }, CURRENT);
    expect(needs).toEqual([{
      purpose: "limits.loosen",
      binding: { limits: { duplicate_window_minutes: 0, max_order_notional: 50000, min_confidence: 0.8 } },
    }]);
    expect(g.requiredGrants("settings.patch", { patch: { limits: { max_order_notional: 1000, min_confidence: 0.95 } } }, CURRENT)).toEqual([]);
    expect(g.requiredGrants("settings.patch", { patch: { limits: { ...CURRENT.limits } } }, CURRENT)).toEqual([]);
  });

  it("loosenedLimits:带上从多少到多少,给确认框用", () => {
    expect(g.loosenedLimits({ max_order_notional: 50000 }, CURRENT.limits)).toEqual([
      { key: "max_order_notional", label: "单笔名义金额上限(USD)", from: 5000, to: 50000 },
    ]);
  });

  it("只读的、熔断、删追踪不要", () => {
    for (const m of ["system.status", "breaker.halt", "breaker.resume", "tracker.delete", "tracker.update", "records.list", "llm.patch"]) {
      expect(g.requiredGrants(m, { id: "x" }, CURRENT), m).toEqual([]);
    }
  });
});

describe("Discord 跟单:打开与放宽要凭据", () => {
  const OFF = { enabled: false, channel_id: "", author_ids: [], accounts: [], max_age_seconds: 30, max_orders_per_day: 3, max_risk_usd: 300 };
  const ON = { ...OFF, enabled: true, channel_id: "1100000000000000001", author_ids: ["220000000000000002"], accounts: ["模拟", "主账户"] };
  const needs = (follow: Record<string, unknown>, now: Record<string, unknown> | null) =>
    g.requiredGrants("settings.patch", { patch: { follow } }, now === null ? null : { ...CURRENT, follow: now });

  it("从关到开:要,绑的是补丁落下去之后的整份(信任谁、哪个频道、哪些账户、三个上限)", () => {
    expect(needs({ enabled: true, channel_id: ON.channel_id, author_ids: ON.author_ids }, OFF)).toEqual([{
      purpose: "gate.follow",
      binding: { channel_id: ON.channel_id, author_ids: ON.author_ids, accounts: [], max_age_seconds: 30, max_orders_per_day: 3, max_risk_usd: 300, local_inbox: false, local_channel: "" },
    }]);
  });

  it("现在的配置读不到:按关着的算(宁可多问一次)", () => {
    expect(needs({ ...ON }, null).map((n) => n.purpose)).toEqual(["gate.follow"]);
  });

  it("关掉、只观察时改配置、开着时原样再存:不要", () => {
    expect(needs({ enabled: false }, ON)).toEqual([]);
    expect(needs({ channel_id: "1100000000000000009", author_ids: ["330000000000000003"], max_risk_usd: 9999 }, OFF)).toEqual([]);
    expect(needs({ ...ON }, ON)).toEqual([]);
  });

  it("开着时往松了改:换频道、多信任一个人、调大任何一个上限,都要", () => {
    expect(needs({ channel_id: "1100000000000000009" }, ON)).toHaveLength(1);
    expect(needs({ author_ids: [...ON.author_ids, "330000000000000003"] }, ON)).toHaveLength(1);
    expect(needs({ author_ids: ["330000000000000003"] }, ON)).toHaveLength(1); // 换了一个人,不是少了一个人
    for (const key of ["max_age_seconds", "max_orders_per_day", "max_risk_usd"] as const) {
      expect(needs({ [key]: ON[key] + 1 }, ON), key).toHaveLength(1);
    }
  });

  it("本地收件:开着时多开它要确认(多了一个消息来源),关掉它不要;只靠它、不填频道也能开", () => {
    expect(needs({ local_inbox: true }, ON)).toHaveLength(1);
    expect(needs({ local_inbox: false }, { ...ON, local_inbox: true })).toEqual([]);
    const localOnly = needs({ enabled: true, channel_id: "", author_ids: ["local:Charlie"], local_inbox: true }, OFF);
    expect(localOnly).toHaveLength(1);
    expect(localOnly[0]!.binding).toMatchObject({ channel_id: "", author_ids: ["local:Charlie"], local_inbox: true });
  });

  it("本地收件读哪个频道:开着时填上、换一个要确认(换了消息来源);清空、原样再存、本地收件关着时改不要", () => {
    const local = { ...ON, local_inbox: true, local_channel: "charlie的策略" };
    expect(needs({ local_channel: "charlie的策略" }, { ...ON, local_inbox: true })).toHaveLength(1);
    expect(needs({ local_channel: "别的频道" }, local)).toHaveLength(1);
    expect(needs({ local_channel: "别的频道" }, local)[0]!.binding).toMatchObject({ local_inbox: true, local_channel: "别的频道" });
    expect(needs({ local_channel: "" }, local)).toEqual([]);
    expect(needs({ local_channel: " charlie的策略 " }, local)).toEqual([]);
    expect(needs({ local_channel: "别的频道" }, ON)).toEqual([]);
  });

  it("开着时往紧了改:少信任一个人、调小上限、少发一个账户,不要", () => {
    const two = { ...ON, author_ids: [...ON.author_ids, "330000000000000003"] };
    expect(needs({ author_ids: ON.author_ids }, two)).toEqual([]);
    expect(needs({ max_risk_usd: 100, max_orders_per_day: 1, max_age_seconds: 10 }, ON)).toEqual([]);
    expect(needs({ accounts: ["模拟"] }, ON)).toEqual([]);
  });

  it("账户:多一个、换一个、清空(= 改发默认账户)都算换了下单出口,要", () => {
    const one = { ...ON, accounts: ["模拟"] };
    expect(needs({ accounts: ["模拟", "主账户"] }, one)).toHaveLength(1);
    expect(needs({ accounts: ["主账户"] }, one)).toHaveLength(1);
    expect(needs({ accounts: [] }, one)).toHaveLength(1);
    expect(needs({ accounts: ["模拟"] }, { ...ON, accounts: [] })).toHaveLength(1);
  });

  it("补丁里的数不是数:按放宽了算", () => {
    expect(needs({ max_risk_usd: "很多" }, ON)).toHaveLength(1);
  });

  it("确认的是一份,存的是另一份:不放行;名单的先后不影响", async () => {
    const book = new g.GrantBook();
    const shown = { ...ON, author_ids: ["330000000000000003", "220000000000000002"], accounts: ["主账户", "模拟"] };
    book.issue("gate.follow", shown);
    // 存的时候多塞了一个人
    expect(book.consumeAll(needs({ ...shown, author_ids: [...shown.author_ids, "440000000000000004"] }, OFF))).toEqual(["打开 Discord 自动跟单"]);
    // 原样(名单顺序反过来):放行,用一次作废
    const same = needs({ ...shown, author_ids: [...shown.author_ids].reverse(), accounts: [...shown.accounts].reverse() }, OFF);
    expect(book.consumeAll(same)).toEqual([]);
    expect(book.consumeAll(same)).toEqual(["打开 Discord 自动跟单"]);
  });

  it("界面表单拼出来的那一份(lib/followForm.ts)和主进程按补丁算的,指纹相同", async () => {
    const form = (await import(/* @vite-ignore */ pathToFileURL(path.join(DESKTOP, "renderer-react", "src", "lib", "followForm.ts")).href)) as unknown as {
      toForm(cfg: unknown): Record<string, unknown>;
      toConfig(form: Record<string, unknown>): Record<string, unknown>;
    };
    const next = form.toConfig({ ...form.toForm(ON), maxRisk: 500 });
    const book = new g.GrantBook();
    book.issue("gate.follow", next); // 界面递给确认框的 binding
    expect(book.consumeAll(needs(next, ON))).toEqual([]); // 界面随后 patchSettings({ follow: next })
  });

  it("确认框上的字:信任谁、哪个频道、发到哪些账户(纸面还是实盘)、三个上限;含实盘时标出来", () => {
    const accounts = [{ alias: "模拟", is_paper: true, default: true }, { alias: "主账户", is_paper: false, default: false }];
    const both = g.followConfirmText(g.followBinding(ON), accounts);
    expect(both.live).toBe(true);
    expect(both.detail).toContain("频道 ID:1100000000000000001");
    expect(both.detail).toContain("信任的发送者 ID:220000000000000002");
    expect(both.detail).toContain("主账户(实盘)、模拟(纸面)");
    expect(both.detail).toContain("每单最坏亏损上限:$300(每个账户各发一份、各算各的)");
    expect(both.detail).toContain("每天最多跟:3 单");
    expect(both.detail).toContain("超过 30 秒不跟");
    expect(both.detail).toContain("账号被盗");
    // 没点名账户:写明是默认账户,它是纸面的就不算含实盘
    const dflt = g.followConfirmText(g.followBinding({ ...ON, accounts: [] }), accounts);
    expect(dflt.live).toBe(false);
    expect(dflt.detail).toContain("发到账户:模拟(纸面) —— 默认账户");
    // 引擎没答话(账户表是空的):类别未知,按含实盘提醒
    const unknown = g.followConfirmText(g.followBinding(ON), []);
    expect(unknown.live).toBe(true);
    expect(unknown.detail).toContain("类别未知");
  });

  it("确认框上的字:本地收件开着时写明读哪个频道、由谁读", () => {
    const accounts = [{ alias: "模拟", is_paper: true, default: true }];
    expect(g.followConfirmText(g.followBinding(ON), accounts).detail).not.toContain("读哪个频道");
    const named = g.followConfirmText(g.followBinding({ ...ON, local_inbox: true, local_channel: "charlie的策略" }), accounts).detail;
    expect(named).toContain("读哪个频道:窗口标题里带「charlie的策略」的那个,由软件自己读");
    const manual = g.followConfirmText(g.followBinding({ ...ON, local_inbox: true }), accounts).detail;
    expect(manual).toContain("读哪个频道:(没有填,软件不自己读;读哪个频道由你运行的脚本定)");
  });
});

describe("凭据", () => {
  it("点了确认才有;内容一样才放行;用一次就没了", () => {
    const book = new g.GrantBook();
    const binding = { text: "买 AAPL 100 股", accounts: ["模拟"] };
    expect(book.consume("instruction.submit", binding)).toBe(false);
    book.issue("instruction.submit", binding);
    expect(book.consume("instruction.submit", binding)).toBe(true);
    expect(book.consume("instruction.submit", binding)).toBe(false);
  });

  it("确认的是一句话,发的是另一句:不放行,而且那张凭据还在(给原来那句用)", () => {
    const book = new g.GrantBook();
    book.issue("instruction.submit", { text: "买 AAPL 1 股", accounts: ["模拟"] });
    expect(book.consume("instruction.submit", { text: "买 TSLA 1000 股", accounts: ["模拟"] })).toBe(false);
    expect(book.consume("instruction.submit", { text: "买 AAPL 1 股", accounts: ["主账户"] })).toBe(false);
    expect(book.consume("instruction.submit", { text: "买 AAPL 1 股", accounts: ["模拟", "主账户"] })).toBe(false);
    expect(book.consume("instruction.submit", { text: "买 AAPL 1 股", accounts: ["模拟"] })).toBe(true);
  });

  it("用途不通用:平仓的凭据发不了单", () => {
    const book = new g.GrantBook();
    book.issue("tracker.close_now", { id: "t1" });
    expect(book.consume("instruction.submit", { id: "t1" })).toBe(false);
    expect(book.consume("tracker.close_now", { id: "t2" })).toBe(false);
    expect(book.consume("tracker.close_now", { id: "t1" })).toBe(true);
  });

  it("一分钟过期", () => {
    const book = new g.GrantBook();
    const t0 = 1_000_000;
    book.issue("tracker.close_now", { id: "t1" }, t0);
    expect(book.consume("tracker.close_now", { id: "t1" }, t0 + g.TTL_MS + 1)).toBe(false);
    book.issue("tracker.close_now", { id: "t1" }, t0);
    expect(book.consume("tracker.close_now", { id: "t1" }, t0 + g.TTL_MS - 1)).toBe(true);
  });

  it("未知用途发不出凭据(界面不能自己起名字)", () => {
    const book = new g.GrantBook();
    expect(() => book.issue("anything.goes", {})).toThrow(/未知的确认用途/);
    expect(() => book.issue("toString", {})).toThrow(/未知的确认用途/);
  });

  it("键的先后、undefined 的键不影响:界面拼的 spec 和主进程收到的入参是同一份内容", () => {
    const book = new g.GrantBook();
    book.issue("tracker.add", { key: "k", auto_close: true, stop_loss: "95", close_fraction_pct: undefined });
    expect(book.consume("tracker.add", { stop_loss: "95", key: "k", auto_close: true })).toBe(true);
    book.issue("tracker.add", { key: "k", auto_close: true, stop_loss: "95" });
    expect(book.consume("tracker.add", { key: "k", auto_close: true, stop_loss: "90" })).toBe(false);
  });

  it("consumeAll:差一张就整个拒,已有的不白烧;齐了一起核销", () => {
    const book = new g.GrantBook();
    const needs = g.requiredGrants("settings.patch", { patch: { policies: { auto_execute: true, allow_live_trading: true } } }, CURRENT);
    book.issue("gate.auto_execute", {});
    expect(book.consumeAll(needs)).toEqual(["允许实盘账户下单"]);
    book.issue("gate.allow_live_trading", {});
    expect(book.consumeAll(needs)).toEqual([]);
    expect(book.consumeAll(needs)).toEqual(["打开自动执行", "允许实盘账户下单"]);
  });

  it("整条路走一遍:界面确认框绑的 binding → 主进程按入参算的 binding,指纹相同", () => {
    const book = new g.GrantBook();
    // 界面:dafri.confirm({ purpose, binding: { text, accounts } }) → 主进程 issue
    book.issue("instruction.submit", { text: "1.8 挂15蝴蝶 15CM", accounts: ["模拟", "主账户"] });
    // 界面:dafri.submit(text, true, accounts) → preload 拼入参 → 主进程摘掉 __confirmed 后算
    const clean = { text: "1.8 挂15蝴蝶 15CM", execute: true, accounts: ["模拟", "主账户"] };
    expect(book.consumeAll(g.requiredGrants("instruction.submit", clean))).toEqual([]);
  });
});

describe("主进程与界面的接线", () => {
  const main = readFileSync(path.join(DESKTOP, "main.js"), "utf-8");
  const handler = main.slice(main.indexOf("ipcMain.handle('rpc'"));
  const src = (f: string): string => readFileSync(path.join(DESKTOP, "renderer-react", "src", f), "utf-8");

  it("核销在转给引擎之前", () => {
    const check = handler.indexOf("grants.consumeAll(needs)");
    const forward = handler.indexOf("engine.call(method, clean");
    expect(check).toBeGreaterThan(-1);
    expect(forward).toBeGreaterThan(check);
  });

  it("凭据只在用户点了确认之后发,而且绑的是摆给人看的那一份", () => {
    const confirm = main.slice(main.indexOf("ipcMain.handle('confirm'"));
    expect(confirm).toMatch(/if \(ok && bound\) grants\.issue\(purpose, box\.binding\)/);
    expect(confirm.indexOf("grants.issue")).toBeGreaterThan(confirm.indexOf("dialog.showMessageBox"));
  });

  it("确认框默认按钮是「取消」", () => {
    const confirm = main.slice(main.indexOf("ipcMain.handle('confirm'"), main.indexOf("registerSupportIpc({"));
    expect(confirm).toMatch(/defaultId: 0,\s*cancelId: 0/);
  });

  it("界面上每个要凭据的调用之前都带着用途去确认", () => {
    expect(src("store/trade.ts")).toMatch(/purpose: 'instruction\.submit',\s*binding: \{ text: body, accounts \}/);
    expect(src("lib/TrackCard.tsx")).toMatch(/purpose: 'tracker\.close_now',\s*binding: \{ id: t\.id \}/);
    expect(src("lib/TrackForm.tsx").match(/purpose: 'tracker\.add',\s*binding: spec/g)).toHaveLength(2);
    expect(src("lib/FutuPanel.tsx")).toMatch(/purpose: 'broker\.select',\s*binding: \{ provider: provider\.key \}/);
    const settings = src("pages/Settings.tsx");
    for (const p of ["gate.auto_execute", "gate.allow_live_trading", "limits.loosen"]) expect(settings, p).toContain(`purpose: '${p}'`);
    expect(src("lib/FollowPanel.tsx")).toMatch(/purpose: 'gate\.follow',\s*binding: next/);
  });

  it("跟单的确认框:只是往紧了改时不弹框、不发凭据;框上的字出自 confirm-grants", () => {
    const text = main.slice(main.indexOf("async function boundConfirmText"), main.indexOf("const lines = [message, detail]"));
    expect(text).toMatch(/if \(!followWidened\(\{ \.\.\.binding, enabled: true \}, current\.follow\)\) return null;/);
    expect(text).toMatch(/followConfirmText\(binding, accounts\)/);
    // 这一支排在通用的 gate.* 之前(那一支不看 binding),也排在拼界面文字的那几行之前;
    // 界面递来的字一个都不上框,由 desktop-main.spec 把主进程真的跑起来核对
    expect(text.indexOf("purpose === 'gate.follow'")).toBeGreaterThan(-1);
    expect(text.indexOf("purpose === 'gate.follow'")).toBeLessThan(text.indexOf("purpose.startsWith('gate.')"));
  });

  it("界面认的用途和主进程那张表一致", () => {
    const bridge = src("bridge.ts");
    const block = bridge.slice(bridge.indexOf("export type ConfirmPurpose"), bridge.indexOf("export interface ConfirmOptions"));
    const inBridge = [...block.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]).sort();
    expect(inBridge).toEqual(Object.keys(g.PURPOSES).sort());
  });
});
