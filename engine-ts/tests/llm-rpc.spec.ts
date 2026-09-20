/** llm.* 在 RPC 这一层的特征测试:输入是界面(Access.tsx 的 collect())真实拼出来的载荷形状。
 *
 * golden-rpc 钉了 llm.catalog 的形状与 llm.patch 的两条(不认识的字段被拒 / 改个模型);这里补它没走到的:
 * 界面原样的载荷(切供应商时 keychain_account 跟着切——用错那把 key 是这个方法最不能出的事)、校验不过不写盘、
 * 以及 llm.test——它从来没被钉过,因为它要真打一次请求。这里起一个本机 http 服务当端点(127.0.0.1,不打外网;
 * base_url 校验对本机 http 放行),连通 / 连不上 / 带一把没保存的 key 先试,三条路都走一遍。
 * 先于契约迁移写成,迁的时候不改断言。不读也不写系统凭证库里的任何密钥:key_configured 只断言形状。
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { RpcServer } from "../src/rpc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Rec = Record<string, any>;

const servers: RpcServer[] = [];
const dirs: string[] = [];
const events: Array<[string, Rec]> = [];
let endpoint: { url: string; seen: Array<[string, string, Rec]>; close: () => Promise<void> } | null = null;

function makeServer(): { s: RpcServer; file: () => Rec; raw: () => string; call: (m: string, p?: Rec) => Promise<Rec> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dafri-llm-rpc-"));
  dirs.push(dir);
  const base = JSON.parse(fs.readFileSync(path.join(HERE, "..", "baseline", "rpc", "base_config.json"), "utf-8"));
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ ...base, storage: { db_path: path.join(dir, "t.db") } }));
  events.length = 0;
  // 引擎往外写的每一行都是一条 JSON-RPC 消息;事件是 { method: "event", params: { event, data } }
  const s = new RpcServer(settingsPath, (line: string) => {
    const msg = JSON.parse(line) as Rec;
    if (msg["method"] === "event") events.push([msg["params"]["event"], msg["params"]["data"]]);
  });
  servers.push(s);
  const raw = (): string => fs.readFileSync(settingsPath, "utf-8");
  const call = async (method: string, params: Rec = {}): Promise<Rec> =>
    s.handle(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  return { s, file: () => JSON.parse(raw()), raw, call };
}

/** 本机的假端点:OpenAI 兼容的 chat/completions。 */
async function fakeEndpoint(status = 200): Promise<NonNullable<typeof endpoint>> {
  const seen: Array<[string, string, Rec]> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push([req.url ?? "", String(req.headers["authorization"] ?? ""), JSON.parse(body || "{}")]);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(status === 200
        ? JSON.stringify({ model: "deepseek-chat", choices: [{ message: { content: '{"ok": true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4 } })
        : JSON.stringify({ error: { message: "Incorrect API key provided" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  endpoint = { url: `http://127.0.0.1:${port}/v1`, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  return endpoint;
}

afterEach(async () => {
  await endpoint?.close();
  endpoint = null;
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

const CURRENT_KEYS = ["base_url", "effort", "keychain_account", "keychain_service", "max_tokens", "model", "provider", "temperature", "timeout_s"];
const PROVIDER_KEYS = ["default_base_url", "default_model", "docs", "key", "key_hint", "label", "models", "needs_base_url", "supports_effort", "supports_temperature"];

describe("llm.catalog", () => {
  it("两家供应商的目录 + 当前配置 + 每家的 Key 配没配(只有真假,没有密钥本身)", async () => {
    const { call } = makeServer();
    const cat = (await call("llm.catalog"))["result"];
    expect(Object.keys(cat).sort()).toEqual(["current", "key_configured", "providers"]);
    expect(cat["providers"].map((p: Rec) => p["key"])).toEqual(["anthropic", "openai_compatible"]);
    for (const p of cat["providers"]) expect(Object.keys(p).sort()).toEqual(PROVIDER_KEYS);
    expect(cat["providers"][1]).toMatchObject({ needs_base_url: true, supports_effort: false, supports_temperature: true, default_base_url: "https://api.deepseek.com/v1" });
    expect(Object.keys(cat["current"]).sort()).toEqual(CURRENT_KEYS);
    expect(cat["current"]).toMatchObject({ provider: "anthropic", keychain_account: "anthropic" });
    expect(Object.keys(cat["key_configured"]).sort()).toEqual(["anthropic", "openai_compatible"]);
    for (const v of Object.values(cat["key_configured"])) expect(typeof v).toBe("boolean");
  });
});

describe("llm.patch:界面的载荷", () => {
  it("切到 OpenAI 兼容端点:keychain_account 跟着供应商切;回执就是新的目录;写进配置文件、推一条 llm 事件", async () => {
    const { s, call, file } = makeServer();
    // Access.tsx 的 collect():这家 needs_base_url、supports_temperature,不 supports_effort
    const llm = { provider: "openai_compatible", model: "deepseek-chat", max_tokens: 4096, timeout_s: 60, base_url: "https://api.deepseek.com/v1", temperature: 0.2 };
    const out = await call("llm.patch", { llm });
    expect(out["error"]).toBeUndefined();
    expect(out["result"]["current"]).toMatchObject({ ...llm, keychain_account: "openai_compatible" });
    expect(Object.keys(out["result"]).sort()).toEqual(["current", "key_configured", "providers"]);
    expect(file()["llm"]).toMatchObject({ ...llm, keychain_account: "openai_compatible" });
    expect(s.settings.llm.provider).toBe("openai_compatible"); // 引擎这头立刻生效,不是只改了文件
    expect(events.filter(([e]) => e === "llm")).toHaveLength(1);
    expect(events.find(([e]) => e === "llm")![1]).toEqual(out["result"]);
    expect((await call("llm.catalog"))["result"]).toEqual(out["result"]);
  });

  it("不换供应商只改模型:keychain_account 不动;temperature 给 null 是「不设」", async () => {
    const { call, file } = makeServer();
    const before = file()["llm"]["keychain_account"];
    const out = await call("llm.patch", { llm: { model: "claude-sonnet-5", max_tokens: 8000, timeout_s: 90, effort: "medium" } });
    expect(out["result"]["current"]).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5", max_tokens: 8000, timeout_s: 90, effort: "medium" });
    expect(file()["llm"]["keychain_account"]).toBe(before);
  });

  it("不认识的字段、不许从这里改的字段(keychain_*)、校验不过:原话,而且一个字都不写盘", async () => {
    const { call, raw } = makeServer();
    const before = raw();
    expect((await call("llm.patch", { llm: { bogus: 1 } }))["error"]).toEqual({ code: -32602, message: "不允许修改的字段:bogus" });
    expect((await call("llm.patch", { llm: { keychain_service: "别人的", model: "x", zzz: 1 } }))["error"]).toEqual({
      code: -32602, message: "不允许修改的字段:keychain_service、zzz",
    });
    const tooSmall = (await call("llm.patch", { llm: { max_tokens: 10 } }))["error"];
    expect(tooSmall["code"]).toBe(-32007);
    expect(tooSmall["message"]).toContain("配置校验失败,已回滚:");
    const noUrl = (await call("llm.patch", { llm: { provider: "openai_compatible", model: "deepseek-chat" } }))["error"];
    expect(noUrl["code"]).toBe(-32007);
    expect(raw()).toBe(before);
    expect(events.filter(([e]) => e === "llm")).toHaveLength(0);
  });
});

describe("llm.test:真打一次最小请求(本机假端点)", () => {
  const ui = (url: string, over: Rec = {}): Rec => ({
    llm: { provider: "openai_compatible", model: "deepseek-chat", max_tokens: 4096, timeout_s: 10, base_url: url, temperature: null, ...over },
    api_key: "sk-not-saved-yet",
  });

  it("连通:带一把没保存的 key 先试——用的就是这一把;回执是界面那张「连通」卡读的每一个键;配置文件不动", async () => {
    const { call, raw } = makeServer();
    const before = raw();
    const ep = await fakeEndpoint();
    const out = (await call("llm.test", ui(ep.url)))["result"];
    expect(Object.keys(out).sort()).toEqual(["latency_ms", "model", "ok", "provider", "sample", "structured_mode", "usage"]);
    expect(out).toMatchObject({ ok: true, model: "deepseek-chat", provider: "openai_compatible", sample: '{"ok": true}' });
    expect(typeof out["latency_ms"]).toBe("number");
    expect(["json_schema", "json_object"]).toContain(out["structured_mode"]);
    expect(out["usage"]).toMatchObject({ input_tokens: 12, output_tokens: 4 });
    expect(ep.seen[0]![0]).toBe("/v1/chat/completions");
    expect(ep.seen[0]![1]).toBe("Bearer sk-not-saved-yet");
    expect(ep.seen[0]![2]["model"]).toBe("deepseek-chat");
    expect(raw()).toBe(before); // 试一下不等于保存
  });

  it("端点回 401:不是 RPC 报错,是一张「测试失败」卡——ok: false + 一句人话,带上试的是哪家哪个模型", async () => {
    const { call } = makeServer();
    const ep = await fakeEndpoint(401);
    const out = await call("llm.test", ui(ep.url));
    expect(out["error"]).toBeUndefined();
    expect(Object.keys(out["result"]).sort()).toEqual(["error", "model", "ok", "provider"]);
    expect(out["result"]).toMatchObject({ ok: false, provider: "openai_compatible", model: "deepseek-chat" });
    expect(typeof out["result"]["error"]).toBe("string");
    expect(out["result"]["error"]).not.toContain("sk-"); // 报错里不回显 key
  });

  it("端点关着:同样是 ok: false,不是一句 fetch failed", async () => {
    const { call } = makeServer();
    const ep = await fakeEndpoint();
    await ep.close(); // 端口刚放掉,连上去就是拒绝
    const out = (await call("llm.test", ui(ep.url, { timeout_s: 5 })))["result"];
    expect(out["ok"]).toBe(false);
    expect(out["error"]).not.toBe("fetch failed");
    expect(out).toMatchObject({ provider: "openai_compatible", model: "deepseek-chat" });
  }, 20_000);

  it("override 里多带一个不认识的键:照常测通,它也不会跑到发给端点的请求里", async () => {
    const { call } = makeServer();
    const ep = await fakeEndpoint();
    const out = (await call("llm.test", { llm: { ...ui(ep.url)["llm"], 不认识的: 1 }, api_key: "sk-x" }))["result"];
    expect(out["ok"]).toBe(true);
    expect(JSON.stringify(ep.seen[0]![2])).not.toContain("不认识的");
  });
});
