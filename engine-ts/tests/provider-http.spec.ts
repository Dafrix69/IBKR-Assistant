/** OpenAI 兼容端点:真的走一遍 HTTP(官方 openai SDK)。
 *
 * golden-providers.spec.ts 里的假端点覆盖的是降级逻辑,post() 被整个替掉了;
 * 这里起一个本机 http 服务,把 SDK 那一段也钉住:URL 拼接、Authorization、
 * 状态码驱动的降级,以及换 SDK 换来的那件事——429 / 5xx 自动重试。
 * 全部离线:127.0.0.1,不打外网(base_url 校验对本机 http 放行)。 */
import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import type { LLMConfig } from "../src/config.js";
import { OpenAICompatibleParser } from "../src/providers.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

interface Stub {
  url: string;
  close: () => Promise<void>;
  /** 收到的请求:[路径, Authorization, 请求体] */
  seen: Array<[string, string, Record<string, any>]>;
}

let running: Stub | null = null;

async function stub(handler: Handler, fixedPort = 0): Promise<Stub> {
  const seen: Stub["seen"] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen.push([req.url ?? "", String(req.headers["authorization"] ?? ""), JSON.parse(raw || "{}")]);
      handler(req, res, raw);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(fixedPort, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  running = {
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  return running;
}

afterEach(async () => {
  await running?.close();
  running = null;
});

function ok(res: http.ServerResponse, content = '{"orders": [], "rejections": []}'): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    model: "deepseek-chat",
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 8 },
  }));
}

function parser(baseUrl: string, over: Partial<LLMConfig> = {}): OpenAICompatibleParser {
  return new OpenAICompatibleParser(
    {
      provider: "openai_compatible",
      model: "deepseek-chat",
      effort: "high",
      temperature: 0.0,
      base_url: baseUrl,
      max_tokens: 8000,
      timeout_s: 30.0,
      keychain_service: "dafri-llm-api-key",
      keychain_account: "openai_compatible",
      ...over,
    },
    "sk-test", // 显式传 key:不碰 Keychain
  );
}

const PING = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

describe("OpenAI 兼容:真 HTTP", () => {
  it("打到 base_url + /chat/completions,带 Bearer,usage 里的缓存字段原样透出", async () => {
    const s = await stub((_req, res) => ok(res, '{"ok": true}'));
    const result = await parser(s.url).test();
    expect(s.seen.length).toBe(1);
    expect(s.seen[0]![0]).toBe("/v1/chat/completions"); // 尾部 /v1 没有被吞掉
    expect(s.seen[0]![1]).toBe("Bearer sk-test");
    expect(result["structured_mode"]).toBe("json_schema");
    expect((result["usage"] as any).cache_hit_tokens).toBe(8);
  });

  it("端点回 400 → 按状态码降级到 json_object,同一进程里不再试 json_schema", async () => {
    const s = await stub((_req, res, _raw) => {
      const body = JSON.parse(_raw);
      if (body.response_format?.type === "json_schema") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "response_format json_schema not supported" } }));
        return;
      }
      ok(res, '{"ok": true}');
    });
    // 同一个 parser 实例问两次:降级状态记在实例上(引擎全程用同一个实例)
    const p = parser(s.url);
    expect(await p.completeJson("你只输出 JSON。", '回复 {"ok": true}', PING)).toEqual({ ok: true });
    expect(s.seen.length).toBe(2); // 撞一次 400,再发一次
    expect(s.seen[0]![2]["response_format"]["type"]).toBe("json_schema");
    expect(s.seen[1]![2]["response_format"]).toEqual({ type: "json_object" });

    await p.completeJson("你只输出 JSON。", '回复 {"ok": true}', PING);
    expect(s.seen.length).toBe(3); // 第二条指令直接走 json_object,没有再撞 400
    expect(s.seen[2]![2]["response_format"]).toEqual({ type: "json_object" });
  });

  it("5xx 自动重试后成功(手写 fetch 时代这里是一条指令白发)", async () => {
    let hits = 0;
    const s = await stub((_req, res) => {
      hits += 1;
      if (hits < 3) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "service unavailable" } }));
        return;
      }
      ok(res, '{"ok": true}');
    });
    const result = await parser(s.url).test();
    expect(hits).toBe(3); // 两次 503 + 一次成功,maxRetries=2
    expect(result["ok"]).toBe(true);
  }, 20_000);

  it("401 报人话,不把端点原始报文甩到界面上", async () => {
    const s = await stub((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Authentication Fails, Your api key is invalid" } }));
    });
    await expect(parser(s.url).test()).rejects.toThrowError(/API Key 无效或已失效/);
  });

  it("端点关着:报连不上,不是一句 fetch failed", async () => {
    const s = await stub((_req, res) => ok(res));
    const dead = parser(s.url);
    await running!.close();
    running = null;
    await expect(dead.test()).rejects.toThrowError(/无法连接|网络不通/);
    expect(s.seen.length).toBe(0);
  }, 20_000);
});

/** 一个此刻没人听的本机端口,端口号以 prefix 开头(42900–42999 这样的一百个里挑第一个占得上的)。 */
async function closedPort(prefix: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const port = Number(prefix) * 100 + i;
    const free = await new Promise<boolean>((resolve) => {
      const probe = http.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`${prefix}00–${prefix}99 没有一个空着的端口`);
}

describe("OpenAI 兼容:地址里的数字不是状态码", () => {
  // 没有状态码的错误只能看文字,而「无法连接 <base_url>:…」里带着地址。2026-09-28 CI 上红过一次:
  // 随机端口里正好有 429,「端点关着」那一条拿到的是「触发限流」。用户那边同样会撞上——LiteLLM 默认的端口就是 4000
  it.each([
    ["401", /网络不通/],
    ["404", /网络不通/],
    ["429", /网络不通/],
  ])("端口里带着 %s 的端点连不上:说的是网络不通,不是 Key 失效 / 模型不存在 / 限流", async (digits, expected) => {
    const port = await closedPort(digits);
    await expect(parser(`http://127.0.0.1:${port}/v1`).test()).rejects.toThrowError(expected);
  }, 20_000);

  it("端口里带着 400 的端点连不上:不当成「端点不认 json_schema」,恢复之后照样先用 json_schema", async () => {
    const port = await closedPort("400");
    const p = parser(`http://127.0.0.1:${port}/v1`);
    await expect(p.completeJson("你只输出 JSON。", '回复 {"ok": true}', PING)).rejects.toThrowError(/无法连接/);

    const s = await stub((_req, res) => ok(res, '{"ok": true}'), port);
    expect(await p.completeJson("你只输出 JSON。", '回复 {"ok": true}', PING)).toEqual({ ok: true });
    expect(s.seen.length).toBe(1);
    expect(s.seen[0]![2]["response_format"]["type"]).toBe("json_schema");
  }, 30_000);
});
