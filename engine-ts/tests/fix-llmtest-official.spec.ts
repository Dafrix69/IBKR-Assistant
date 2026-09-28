/** llm.test:换到只连自家官方端点的供应商(Anthropic 不读 base_url),可以用已保存的 Key 直接测。
 *
 * fix-llmtest-exfil.spec.ts 钉的是"已保存的 Key 只发往保存时的端点";它的代价是换了供应商就要把 Key 再填一遍。
 * 可 Anthropic 的客户端根本不读 base_url——那把 Key 只可能发往 Anthropic 自己的服务器,为"测一下"再填一遍没有安全收益。
 * 能指任意地址的 OpenAI 兼容端点照旧:换了端点必须现填。
 *
 * buildParser 换成假的:只记下拿到的配置与 Key,不出网。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const built = vi.hoisted(() => ({ calls: [] as Array<{ provider: string; base_url: string; key: string | null }> }));
vi.mock("../src/providers.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/providers.js")>();
  return {
    ...real,
    buildParser: (cfg: { provider: string; base_url: string; model: string }, key: string | null) => {
      built.calls.push({ provider: cfg.provider, base_url: cfg.base_url, key });
      return { test: async () => ({ ok: true, model: cfg.model, latency_ms: 1, usage: {}, structured_mode: "json_schema" }) };
    },
  };
});

import { RpcServer } from "../src/rpc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

function makeServer(llm: Rec): (method: string, params?: Rec) => Promise<Rec> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-llmtest-official-"));
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, llm, storage: { db_path: path.join(dir, "t.db") } }));
  const s = new RpcServer(settingsPath, () => undefined);
  return async (method, params = {}) => s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
}

const savedOpenAi: Rec = {
  provider: "openai_compatible", model: "deepseek-chat", base_url: "https://api.deepseek.com/v1",
  max_tokens: 4096, timeout_s: 10, keychain_service: "dafri-llm-api-key", keychain_account: "openai_compatible",
};

describe("llm.test:换到固定官方端点的供应商,不必重填 Key", () => {
  it("已保存的是 OpenAI 兼容,换 Anthropic 不带 Key:照测(用 Anthropic 那把),不拒", async () => {
    built.calls.length = 0;
    const call = makeServer(savedOpenAi);
    const out = await call("llm.test", { llm: { provider: "anthropic", model: "claude-opus-5" } });
    expect(out["error"]).toBeUndefined();
    expect(out["result"]).toMatchObject({ ok: true, provider: "anthropic" });
    expect(built.calls).toEqual([expect.objectContaining({ provider: "anthropic", key: null })]);
  });

  it("换到别的 OpenAI 兼容地址不带 Key:照旧拒,一次都不构造客户端", async () => {
    built.calls.length = 0;
    const call = makeServer({ ...savedOpenAi, provider: "anthropic", model: "claude-opus-5", base_url: "", keychain_account: "anthropic" });
    const out = await call("llm.test", { llm: { provider: "openai_compatible", model: "x", base_url: "https://evil.example/v1" } });
    expect(out["error"]?.["code"]).toBe(-32602);
    expect(built.calls).toEqual([]);
  });
});
