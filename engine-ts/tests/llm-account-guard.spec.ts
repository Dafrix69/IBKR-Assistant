/** 大模型外发的账号闸(providers.guardAccountIds):真实账号不进任何一次外发。
 *
 * 下单解析那条路一直有这道检查(prompts.ts);想法分析、AI 选股、行情解读、回测条件解析走 completeJson,
 * 以前没有——用户把账号写进一条想法里,原文就发给了大模型。隐私说明里写着"真实账号不会出现在发给大模型的内容里",
 * 这句话得对每一条外发的路都成立。离线:解析器是假的,不连任何端点。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { LLMError } from "../src/config.js";
import { guardAccountIds } from "../src/providers.js";
import { RpcServer } from "../src/rpc.js";

const ACCOUNTS = [
  { alias: "主账户", account_id: "U1234567" },
  { alias: "模拟", account_id: "DU7654321" },
  { alias: "占位", account_id: "DU0000000" },
  { alias: "富途占位", account_id: "0000000" },
];

function fake() {
  const sent: unknown[][] = [];
  return {
    sent,
    async completeJson(system: string, user: string, schema: object): Promise<object> {
      sent.push([system, user, schema]);
      return { ok: true };
    },
    async parse(bundle: { system_text: string }, userMessage: string): Promise<string> {
      sent.push([bundle.system_text, userMessage]);
      return "parsed";
    },
    async test(): Promise<object> {
      return { ok: true };
    },
  };
}

describe("账号闸", () => {
  it("没有账号的内容照常发出去,返回值原样", async () => {
    const parser = guardAccountIds(fake(), () => ACCOUNTS);
    expect(await parser.completeJson("你是选股助手", "半导体板块", {})).toEqual({ ok: true });
    expect(await parser.parse({ system_text: "系统提示词" }, "买入 AAPL 100 股")).toBe("parsed");
    expect(parser.sent).toHaveLength(2);
  });

  it("用户文字里有真实账号:这一次不发,说明为什么,只提别名", async () => {
    const parser = guardAccountIds(fake(), () => ACCOUNTS);
    const err = await parser.completeJson("你是复盘助手", "我在 U1234567 上做的这笔亏了", {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as Error).message).toMatch(/出现了真实账号\(别名 主账户\).*没有发出/);
    expect((err as Error).message).not.toContain("U1234567");
    expect(parser.sent).toHaveLength(0);
  });

  it("系统提示词里有也一样;下单解析那条路再查一遍", async () => {
    const parser = guardAccountIds(fake(), () => ACCOUNTS);
    await expect(parser.completeJson("账户 DU7654321 的持仓", "分析一下", {})).rejects.toThrow(/别名 模拟/);
    await expect(parser.parse({ system_text: "ok" }, "用 DU7654321 买 AAPL")).rejects.toThrow(/别名 模拟/);
    await expect(parser.parse({ system_text: "含 U1234567" }, "买 AAPL")).rejects.toThrow(/别名 主账户/);
    expect(parser.sent).toHaveLength(0);
  });

  it("示例配置里的占位账号不算:不然「10000000」这样的普通数字都发不出去", async () => {
    const parser = guardAccountIds(fake(), () => ACCOUNTS);
    await parser.completeJson("s", "市值 10000000 美元,代码 DU0000000 只是占位", {});
    expect(parser.sent).toHaveLength(1);
  });

  it("账号表每次现取:改了配置之后按新的查", async () => {
    let accounts = [{ alias: "旧", account_id: "U1111111" }];
    const parser = guardAccountIds(fake(), () => accounts);
    await parser.completeJson("s", "U2222222", {});
    accounts = [{ alias: "新", account_id: "U2222222" }];
    await expect(parser.completeJson("s", "U2222222", {})).rejects.toThrow(/别名 新/);
  });

  it("test()(接入页的连通性测试)不受影响", async () => {
    const parser = guardAccountIds(fake(), () => ACCOUNTS);
    expect(await parser.test()).toEqual({ ok: true });
  });
});

describe("引擎装配", () => {
  it("RpcServer 默认的解析器工厂带着账号闸", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dafri-guard-rpc-"));
    try {
      const base = JSON.parse(readFileSync(path.resolve(__dirname, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
      const settingsPath = path.join(dir, "settings.json");
      writeFileSync(settingsPath, JSON.stringify({
        ...base,
        storage: { db_path: path.join(dir, "t.db") },
        llm: { ...base.llm, provider: "openai_compatible", base_url: "http://127.0.0.1:9/v1", model: "x" },
      }));
      const server = new RpcServer(settingsPath, () => undefined);
      const real = server.settings.accounts.find((a) => !/^[A-Za-z]*0+$/.test(a.account_id));
      expect(real, "基线配置里要有一个不是占位的账号").toBeTruthy();
      const parser = server.parserFactory(server.settings.llm);
      // 在发任何请求之前就被挡下:端点是个连不上的地址,真发出去报的会是"连不上"
      await expect(parser.completeJson("s", `账号 ${real!.account_id}`, {})).rejects.toThrow(/出现了真实账号/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
