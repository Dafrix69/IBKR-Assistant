/** 「接入 → Discord 跟单」表单的纯逻辑(desktop/renderer-react/src/lib/followForm.ts)。
 *
 * 钉的是"存不存得了、存出去的是什么":空着的上限不许变成 0 送出去;打开之前必须有频道、有信任的人;
 * 表单拼出来的那一份引擎的配置校验认。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { fromDict } from "../src/config.js";

const SRC = path.resolve(__dirname, "..", "..", "desktop", "renderer-react", "src");
type Form = Record<string, any>;
const mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(SRC, "lib", "followForm.ts")).href)) as unknown as {
  DISCORD_ID: RegExp;
  toForm(cfg: unknown): Form;
  formProblems(f: Form): string[];
  toConfig(f: Form): Record<string, unknown>;
  isDirty(f: Form, saved: unknown): boolean;
  addAuthor(f: Form, id: string): Form;
  readerText(reader: { state: string; title: string | null; error: string | null }, channel: string): { tone: string; text: string };
  OUTCOME_LABEL: Record<string, string>;
  outcomeTone(outcome: string): string;
};

const BASE = JSON.parse(readFileSync(path.resolve(__dirname, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
const SAVED = fromDict(BASE).follow;
const CHANNEL = "1100000000000000001";
const FRIEND = "220000000000000002";

describe("保存前的检查", () => {
  it("引擎默认的那一份:没有问题,也没有未保存的修改", () => {
    const form = mod.toForm(SAVED);
    expect(mod.formProblems(form)).toEqual([]);
    expect(mod.isDirty(form, SAVED)).toBe(false);
    expect(mod.toConfig(form)).toEqual(SAVED);
  });

  it("打开之前必须有频道、有信任的人", () => {
    const form = { ...mod.toForm(SAVED), enabled: true };
    expect(mod.formProblems(form)).toEqual(["打开自动跟单之前要先填频道 ID,或者打开本地收件", "打开自动跟单之前至少要信任一个发送者"]);
    // 本地收件开着就不必有频道;信任名单里可以是 local:显示名
    const local = { ...form, localInbox: true, authorIds: ["local:Charlie"] };
    expect(mod.formProblems(local)).toEqual([]);
    expect(mod.toConfig(local)).toMatchObject({ enabled: true, channel_id: "", author_ids: ["local:Charlie"], local_inbox: true });
    expect(mod.isDirty(local, SAVED)).toBe(true);
    expect(mod.addAuthor(form, "local:老王").authorIds).toEqual(["local:老王"]);
    expect(mod.addAuthor(form, "local:")).toBe(form);
    expect(mod.formProblems({ ...form, channelId: CHANNEL, authorIds: [FRIEND] })).toEqual([]);
  });

  it("频道 ID 不是一串数字:说清楚去哪里复制", () => {
    expect(mod.formProblems({ ...mod.toForm(SAVED), channelId: "#spx-flies" })[0]).toContain("复制频道 ID");
    expect(mod.formProblems({ ...mod.toForm(SAVED), channelId: `  ${CHANNEL} ` })).toEqual([]);
  });

  it("上限空着不让存(空着 = null,Number(null) 是 0);越界、不是整数也不让", () => {
    const form = mod.toForm(SAVED);
    expect(mod.formProblems({ ...form, maxRisk: null })).toEqual(["「每单最坏亏损上限」不能空着"]);
    expect(mod.formProblems({ ...form, perDay: null, maxAge: null })).toHaveLength(2);
    expect(mod.formProblems({ ...form, maxRisk: 0 })[0]).toContain("1 以上");
    expect(mod.formProblems({ ...form, perDay: 101 })[0]).toContain("1–100");
    expect(mod.formProblems({ ...form, maxAge: 601 })[0]).toContain("1–600");
    expect(mod.formProblems({ ...form, perDay: 2.5 })[0]).toContain("整数");
    expect(mod.formProblems({ ...form, maxRisk: 250.5 })).toEqual([]);
  });
});

describe("拼出要存的那一份", () => {
  it("引擎的配置校验认它,读回来一个字不差", () => {
    const form = { ...mod.toForm(SAVED), enabled: true, channelId: ` ${CHANNEL} `, authorIds: [FRIEND, FRIEND], accounts: ["模拟"], maxRisk: 500 };
    const next = mod.toConfig(form);
    expect(next).toEqual({
      enabled: true, channel_id: CHANNEL, author_ids: [FRIEND], accounts: ["模拟"],
      max_age_seconds: 30, max_orders_per_day: 3, max_risk_usd: 500, local_inbox: false, local_channel: "",
    });
    expect(fromDict({ ...BASE, follow: next }).follow).toEqual(next);
  });

  it("本地收件的频道名:掐头去尾存下,改了算改过;太长、带换行不让存", () => {
    const form = { ...mod.toForm(SAVED), localInbox: true, localChannel: "  charlie的策略 " };
    expect(mod.formProblems(form)).toEqual([]);
    const next = mod.toConfig(form);
    expect(next).toMatchObject({ local_inbox: true, local_channel: "charlie的策略" });
    expect(fromDict({ ...BASE, follow: next }).follow).toEqual(next);
    expect(mod.isDirty(form, SAVED)).toBe(true);
    expect(mod.isDirty({ ...mod.toForm(next), localChannel: " charlie的策略" }, next)).toBe(false);
    expect(mod.isDirty({ ...mod.toForm(next), localChannel: "别的频道" }, next)).toBe(true);
    expect(mod.formProblems({ ...form, localChannel: "x".repeat(101) })).toEqual(["本地收件的频道名最多 100 字,不能换行"]);
    expect(mod.formProblems({ ...form, localChannel: "a\nb" })).toEqual(["本地收件的频道名最多 100 字,不能换行"]);
  });

  it("改过没有:名单只看内容,不看先后", () => {
    const saved = { ...SAVED, author_ids: [FRIEND, "330000000000000003"] };
    const form = mod.toForm(saved);
    expect(mod.isDirty({ ...form, authorIds: ["330000000000000003", FRIEND] }, saved)).toBe(false);
    expect(mod.isDirty({ ...form, authorIds: [FRIEND] }, saved)).toBe(true);
    expect(mod.isDirty({ ...form, maxRisk: 301 }, saved)).toBe(true);
    expect(mod.isDirty(form, null)).toBe(false);
  });

  it("加信任的人:形状不对、已经在里面的不加", () => {
    const form = mod.toForm(SAVED);
    expect(mod.addAuthor(form, "老王")).toBe(form);
    const one = mod.addAuthor(form, ` ${FRIEND} `);
    expect(one["authorIds"]).toEqual([FRIEND]);
    expect(mod.addAuthor(one, FRIEND)).toBe(one);
  });

  it("ID 的口径和引擎的 config.ts 是同一条正则", () => {
    const config = readFileSync(path.resolve(__dirname, "..", "src", "config.ts"), "utf-8");
    expect(config).toContain(`const DISCORD_ID = ${String(mod.DISCORD_ID)};`);
  });
});

describe("下场的标签", () => {
  it("引擎契约里的每一种下场都有标签;只有发出去的是绿的", () => {
    const contract = readFileSync(path.resolve(__dirname, "..", "src", "contract", "follow.ts"), "utf-8");
    const line = contract.slice(contract.indexOf("export type FollowOutcome ="));
    const outcomes = [...line.slice(0, line.indexOf(";")).matchAll(/"([a-z]+)"/g)].map((m) => String(m[1]));
    expect(outcomes.length).toBe(8);
    expect(Object.keys(mod.OUTCOME_LABEL).sort()).toEqual([...outcomes].sort());
    expect(outcomes.filter((o) => mod.outcomeTone(o) === "success")).toEqual(["sent"]);
    expect(mod.outcomeTone("observed")).toBe("default");
  });
});

describe("「读窗口」那一行", () => {
  const view = (state: string, extra: { title?: string; error?: string } = {}) =>
    mod.readerText({ state, title: extra.title ?? null, error: extra.error ?? null }, "charlie的策略");

  it("只有真的在读才是「在读」;每一种没在读都说清该做什么", () => {
    expect(view("reading", { title: "#charlie的策略 | 某服务器 - Discord" })).toMatchObject({ tone: "ok" });
    expect(view("reading", { title: "#charlie的策略 | 某服务器 - Discord" }).text).toContain("#charlie的策略 | 某服务器 - Discord");
    expect(view("waiting").text).toContain("没有窗口停在「charlie的策略」");
    expect(view("no_list").text).toContain("--force-renderer-accessibility");
    expect(view("no_discord").text).toContain("Discord 没在运行");
    expect(view("untrusted").text).toContain("辅助功能");
    expect(view("failed", { error: "读窗口的程序退出了(退出码 1),1 秒后重新启动" }).text).toBe("读窗口的程序退出了(退出码 1),1 秒后重新启动");
    for (const state of ["waiting", "no_list", "no_discord", "untrusted", "failed"]) expect(view(state).tone, state).not.toBe("ok");
    for (const state of ["waiting", "no_list", "no_discord", "untrusted"]) expect(view(state).text, state).toMatch(/^没在读/);
  });

  it("不自己读窗口的三种:关着、没填频道名、这一份软件没带程序——后两种提醒要自己运行脚本", () => {
    expect(view("off")).toEqual({ tone: "info", text: "关着" });
    expect(view("no_channel").text).toContain("自己运行脚本");
    expect(view("unavailable").text).toContain("自己运行脚本");
  });
});
