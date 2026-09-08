/** 阶段 4:providers(移植自 Python test_providers.py)。
 * 换供应商不能把安全边界一起换掉。全部离线:假端点注入,不打网络。 */
import { describe, expect, it } from "vitest";

import type { LLMConfig } from "../src/config.js";
import { deleteSecret, getSecret, isSupported, setSecret } from "../src/keychain.js";
import { loadPromptBundle } from "../src/prompts.js";
import * as providers from "../src/providers.js";
import { loadGolden, makeSettings } from "./util.js";

const g = loadGolden("prompts");

function compatConfig(over: Partial<LLMConfig> = {}): LLMConfig {
  return {
    provider: "openai_compatible",
    model: "deepseek-chat",
    effort: "high",
    temperature: 0.0,
    base_url: "https://api.deepseek.com/v1",
    max_tokens: 8000,
    timeout_s: 60.0,
    keychain_service: "dafri-llm-api-key",
    keychain_account: "openai_compatible",
    ...over,
  };
}

function anthropicConfig(over: Partial<LLMConfig> = {}): LLMConfig {
  return {
    provider: "anthropic",
    model: "claude-opus-5",
    effort: "high",
    temperature: null,
    base_url: "",
    max_tokens: 8000,
    timeout_s: 60.0,
    keychain_service: "dafri-llm-api-key",
    keychain_account: "anthropic",
    ...over,
  };
}

// ---- base_url 校验(§9.4 强制 TLS)---------------------------------------
describe("providers: base_url", () => {
  it("https 接受并归一化(去尾斜杠)", () => {
    expect(providers.validateBaseUrl("https://api.deepseek.com/v1/")).toBe(
      "https://api.deepseek.com/v1",
    );
  });
  it("公网 http 拒绝", () => {
    expect(() => providers.validateBaseUrl("http://api.example.com/v1")).toThrowError(/必须用 https/);
  });
  it("本机 http 放行(自建代理调试)", () => {
    expect(providers.validateBaseUrl("http://127.0.0.1:8000/v1")).toBe("http://127.0.0.1:8000/v1");
    expect(providers.validateBaseUrl("http://localhost:8000/v1")).toBe("http://localhost:8000/v1");
  });
  it("空的或没有协议的拒绝", () => {
    for (const bad of ["", "   ", "api.example.com/v1"]) {
      expect(() => providers.validateBaseUrl(bad), bad).toThrowError(providers.LLMError);
    }
  });
});

// ---- 供应商目录与工厂 -----------------------------------------------------
describe("providers: 目录与工厂", () => {
  it("目录暴露界面需要的字段", () => {
    const catalog = Object.fromEntries(providers.providerCatalog().map((p) => [p["key"], p]));
    expect(Object.keys(catalog).sort()).toEqual(["anthropic", "openai_compatible"]);
    for (const meta of Object.values(catalog)) {
      for (const key of ["label", "models", "needs_base_url", "supports_effort", "supports_temperature"]) {
        expect(key in (meta as object)).toBe(true);
      }
    }
    expect((catalog["anthropic"] as any).supports_effort).toBe(true);
    expect((catalog["anthropic"] as any).supports_temperature).toBe(false); // Opus 5 起已移除采样参数
    expect((catalog["openai_compatible"] as any).needs_base_url).toBe(true);
  });

  it("工厂按 provider 选后端;未知供应商拒绝", () => {
    expect(providers.buildParser(anthropicConfig())).toBeInstanceOf(providers.AnthropicParser);
    expect(providers.buildParser(compatConfig())).toBeInstanceOf(providers.OpenAICompatibleParser);
    expect(() =>
      providers.buildParser(anthropicConfig({ provider: "telepathy", model: "x" })),
    ).toThrowError(/未知的模型供应商/);
  });

  it("采样参数按模型闸门", () => {
    expect(providers.supportsSamplingParams("claude-opus-5")).toBe(false);
    expect(providers.supportsSamplingParams("claude-fable-5")).toBe(false);
    expect(providers.supportsSamplingParams("claude-haiku-4-5")).toBe(true);
  });

  it("Anthropic 请求参数:cache_control / effort / temperature 闸门", () => {
    const parser = new providers.AnthropicParser(anthropicConfig({ temperature: 0.5 }));
    const kwargs = parser.requestKwargs("SYS", [{ role: "user", content: "hi" }], { type: "object" });
    expect((kwargs["system"] as any)[0].cache_control).toEqual({ type: "ephemeral" });
    expect((kwargs["output_config"] as any).effort).toBe("high");
    expect((kwargs["output_config"] as any).format.type).toBe("json_schema");
    // claude-opus-5 不支持采样参数:即使配置里填了 temperature 也不发
    expect("temperature" in kwargs).toBe(false);
    const parser2 = new providers.AnthropicParser(
      anthropicConfig({ model: "claude-haiku-4-5", temperature: 0.5 }),
    );
    const kwargs2 = parser2.requestKwargs("SYS", [], {});
    expect(kwargs2["temperature"]).toBe(0.5);
  });
});

// ---- OpenAI 兼容:结构化输出降级 -------------------------------------------
class FakeCompatible extends providers.OpenAICompatibleParser {
  bodies: Array<Record<string, unknown>> = [];
  poster: ((body: Record<string, unknown>) => Record<string, unknown>) | null = null;

  constructor(
    config: LLMConfig,
    readonly schemaSupported: boolean,
  ) {
    super(config, "sk-test");
  }

  protected override async post(
    _path: string, body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.bodies.push(body);
    if (this.poster) return this.poster(body);
    if ((body["response_format"] as any).type === "json_schema" && !this.schemaSupported) {
      throw new providers.LLMError("HTTP 400:unsupported response_format");
    }
    return {
      model: body["model"],
      choices: [
        { message: { content: '{"orders": [], "rejections": []}' }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  }
}

describe("providers: OpenAI 兼容降级", () => {
  const settings = makeSettings(g.base_config);
  const bundle = loadPromptBundle(settings);

  it("json_schema 优先", async () => {
    const parser = new FakeCompatible(compatConfig(), true);
    const response = await parser.parse(bundle, "买入 AAPL 100股 limit 230");
    expect(response.structured_mode).toBe("json_schema");
    expect(parser.bodies.length).toBe(1);
    expect((parser.bodies[0]!["response_format"] as any).json_schema.strict).toBe(true);
  });

  it("端点不认 json_schema 时降级 json_object 并把 schema 写进系统提示词", async () => {
    const parser = new FakeCompatible(compatConfig(), false);
    const response = await parser.parse(bundle, "买入 AAPL 100股 limit 230");
    expect(response.structured_mode).toBe("json_object");
    expect(parser.bodies.length).toBe(2);
    const second = parser.bodies[1]!;
    expect(second["response_format"]).toEqual({ type: "json_object" });
    const system = (second["messages"] as any[])[0];
    expect(system.role).toBe("system");
    expect(system.content).toContain("JSON Schema");
    expect(system.content).toContain('"rejections"');
    expect(response.payload()).toEqual({ orders: [], rejections: [] });
  });

  it("截断的输出拒绝而不是解析", async () => {
    const parser = new FakeCompatible(compatConfig(), true);
    parser.poster = () => ({
      model: "x",
      choices: [{ message: { content: '{"orders": [' }, finish_reason: "length" }],
    });
    await expect(parser.parse(bundle, "买入 AAPL 100股")).rejects.toThrowError(/截断/);
  });

  it("content_filter 拒绝", async () => {
    const parser = new FakeCompatible(compatConfig(), true);
    parser.poster = () => ({
      model: "x",
      choices: [{ message: { content: "" }, finish_reason: "content_filter" }],
    });
    await expect(parser.parse(bundle, "买入 AAPL 100股")).rejects.toThrowError(/内容策略/);
  });

  it("少样本 assistant 的序列化与 Python json.dumps 逐字节一致", async () => {
    const parser = new FakeCompatible(compatConfig(), true);
    await parser.parse(bundle, "x");
    const messages = parser.bodies[0]!["messages"] as any[];
    const firstAssistant = messages.find((m) => m.role === "assistant");
    // Python 的分隔符是 ", " 与 ": ";浮点 7520.0 保留 .0
    expect(firstAssistant.content).toMatch(/"orders": \[/);
    if (firstAssistant.content.includes("7520")) {
      expect(firstAssistant.content).toContain("7520.0");
    }
  });

  it("代码围栏剥掉", () => {
    expect(providers.stripCodeFence('{"a": 1}')).toBe('{"a": 1}');
    expect(providers.stripCodeFence('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
    expect(providers.stripCodeFence('```\n{"a": 1}\n```')).toBe('{"a": 1}');
  });
});

// ---- schema 资产 -----------------------------------------------------------
describe("providers: schema 资产", () => {
  it("ParseResult schema 没有各家不认的关键字,对象都关了 additionalProperties", () => {
    const schema = providers.structuredOutputSchema();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node !== null && typeof node === "object") {
        const rec = node as Record<string, unknown>;
        for (const key of ["minimum", "maximum", "exclusiveMinimum", "minLength", "pattern",
                           "maxLength", "minItems", "maxItems"]) {
          expect(key in rec, key).toBe(false);
        }
        if (rec["type"] === "object") expect(rec["additionalProperties"]).toBe(false);
        Object.values(rec).forEach(walk);
      }
    };
    walk(schema);
    // 与 pydantic 的结构一致:$defs 六个模型都在
    expect(Object.keys((schema as any).$defs).sort()).toEqual([
      "ContractSpec", "Leg", "OrderSpec", "ParsedOrder", "Rejection", "TriggerSpec",
    ]);
  });

  it("五份 schema 资产都能加载", () => {
    for (const name of ["parse_result", "sector_picks", "idea_analysis", "pa_comment", "custom_rules"]) {
      const schema = providers.loadSchemaAsset(name);
      expect(schema["type"]).toBe("object");
    }
  });
});

// ---- keychain(仅当前平台可测的部分)---------------------------------------
describe("keychain: DPAPI 往返(Windows)", () => {
  it.runIf(process.platform === "win32")("set → get → delete 往返,与 Python 同一份密文文件", () => {
    expect(isSupported()).toBe(true);
    const service = "dafri-ts-test";
    const account = "roundtrip";
    setSecret(service, account, "s3cret-值");
    expect(getSecret(service, account)).toBe("s3cret-值");
    expect(deleteSecret(service, account)).toBe(true);
    expect(getSecret(service, account)).toBeNull();
    expect(deleteSecret(service, account)).toBe(false);
    expect(() => setSecret(service, account, "")).toThrowError("拒绝写入空密钥");
  });
});
