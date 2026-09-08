/** 外部大模型接入层(对应 Python providers.py)。
 *
 * 换供应商不放松两条底线:发出去的仍然只有 S2 级数据;输出仍然要过 schema。
 * 能用 json_schema 就用;端点只支持 json_object 时自动降级并把 schema 塞进
 * 系统提示词,降级记在返回里(界面要显示,它直接影响解析可靠性)。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { LLMConfig } from "./config.js";
import { LLMError } from "./config.js";
import { getSecret } from "./keychain.js";
import type { FewShotPair, PromptBundle } from "./prompts.js";
import { fingerprint } from "./prompts.js";

export { LLMError };
export { validateBaseUrl } from "./config.js";

// 界面上的供应商目录。models 只是预设,用户可以填任意模型名。
export const PROVIDERS: Record<string, Record<string, unknown>> = {
  anthropic: {
    label: "Anthropic(Claude)",
    default_model: "claude-opus-5",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    supports_effort: true,
    supports_temperature: false, // Opus 5 / Sonnet 5 起已移除采样参数
    needs_base_url: false,
    default_base_url: "",
    key_hint: "sk-ant-...",
    docs: "https://platform.claude.com/",
  },
  openai_compatible: {
    label: "OpenAI 兼容端点",
    default_model: "",
    models: [
      "deepseek-chat", "deepseek-reasoner", "qwen-max", "moonshot-v1-128k", "glm-4-plus", "gpt-4o",
    ],
    supports_effort: false,
    supports_temperature: true,
    needs_base_url: true,
    default_base_url: "https://api.deepseek.com/v1",
    key_hint: "sk-...",
    docs: "填你的服务商给的 base_url,通常以 /v1 结尾",
  },
};

export class LLMResponse {
  constructor(
    public readonly text: string,
    public readonly model: string,
    public readonly prompt_version: string,
    public readonly prompt_fingerprint: string,
    public readonly latency_ms: number,
    public readonly usage: Record<string, unknown> = {},
    public readonly structured_mode: string = "json_schema", // json_schema | json_object | none
  ) {}

  payload(): Record<string, unknown> {
    try {
      return JSON.parse(this.text);
    } catch (exc) {
      throw new LLMError(`模型输出不是合法 JSON:${(exc as Error).message}`);
    }
  }
}

export function providerCatalog(): Array<Record<string, unknown>> {
  return Object.entries(PROVIDERS).map(([key, meta]) => ({ key, ...meta }));
}

export function resolveApiKey(config: LLMConfig, explicit?: string | null): string {
  if (explicit) return explicit;
  const key = getSecret(config.keychain_service, config.keychain_account);
  if (!key) {
    throw new LLMError(
      `Keychain 里没有 ${config.provider} 的 API Key` +
      `(service=${config.keychain_service}, account=${config.keychain_account})。` +
      "请在界面「大模型」面板里填写并保存。",
    );
  }
  return key;
}

// ---------------------------------------------------------------- schema 资产
// ParseResult 等 schema 以 Python 版 pydantic 的输出为准(资产化,黄金对拍钉住);
// models 变更时重跑 trade/scripts 里的导出。src/ 与 dist/src/ 两种布局都要能找到。
const ASSET_DIR = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "baseline", "llm");
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "baseline", "llm");
})();

const schemaCache = new Map<string, Record<string, unknown>>();

export function loadSchemaAsset(name: string): Record<string, unknown> {
  let cached = schemaCache.get(name);
  if (!cached) {
    cached = JSON.parse(fs.readFileSync(path.join(ASSET_DIR, `${name}_schema.json`), "utf-8"));
    schemaCache.set(name, cached!);
  }
  return structuredClone(cached!);
}

/** 解析结果的 JSON Schema(默认 ParseResult)。 */
export function structuredOutputSchema(name = "parse_result"): Record<string, unknown> {
  return loadSchemaAsset(name);
}

/** 发给模型的 ParseResult schema,随提示词版本走(对应 Python schema.parse_schema_for_prompt)。
 *  v1.8.0 起提示词让模型"不要输出 EXCEEDS_LIMIT",发出去的 enum 就不能再列它——json_object 降级时
 *  同一条系统消息里不能既说不要输出、又把它列成合法值。zod 模型保留该码(回滚 / 模型不听话时仍能解析)。 */
export function parseSchemaForPrompt(promptVersion: string): Record<string, unknown> {
  const schema = structuredClone(structuredOutputSchema());
  if (versionKey(promptVersion) >= versionKey("v1.8.0")) {
    const defs = schema["$defs"] as Record<string, any> | undefined;
    const code = defs?.["Rejection"]?.["properties"]?.["code"] as { enum?: unknown[] } | undefined;
    if (code && Array.isArray(code.enum)) code.enum = code.enum.filter((c) => c !== "EXCEEDS_LIMIT");
  }
  return schema;
}

function versionKey(version: string): number {
  const [a = 0, b = 0, c = 0] = ((version ?? "").match(/\d+/g) ?? []).slice(0, 3).map(Number);
  return a * 1_000_000 + b * 1_000 + c;
}

// ---------------------------------------------------------------- Anthropic
const NO_SAMPLING_PREFIXES = [
  "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7",
  "claude-sonnet-5", "claude-fable-5", "claude-mythos-5",
];

export function supportsSamplingParams(model: string): boolean {
  return !NO_SAMPLING_PREFIXES.some((p) => model.startsWith(p));
}

type Msg = Record<string, unknown>;

/** 官方 SDK + structured outputs(API 层就按 schema 约束输出)。 */
export class AnthropicParser {
  readonly provider = "anthropic";
  private client: any = null;

  constructor(
    readonly config: LLMConfig,
    private readonly apiKey: string | null = null,
  ) {}

  private async ensureClient(): Promise<any> {
    if (this.client === null) {
      let AnthropicMod: any;
      try {
        AnthropicMod = await import("@anthropic-ai/sdk");
      } catch (exc) {
        throw new LLMError("未安装 @anthropic-ai/sdk:npm install @anthropic-ai/sdk");
      }
      const Anthropic = AnthropicMod.default ?? AnthropicMod.Anthropic;
      this.client = new Anthropic({
        apiKey: resolveApiKey(this.config, this.apiKey),
        timeout: this.config.timeout_s * 1000,
        maxRetries: 2,
      });
    }
    return this.client;
  }

  requestKwargs(system: string, messages: Msg[], schema: Record<string, unknown>): Msg {
    const kwargs: Msg = {
      model: this.config.model,
      max_tokens: this.config.max_tokens,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
      output_config: {
        format: { type: "json_schema", schema },
        effort: this.config.effort,
      },
    };
    if (this.config.temperature !== null && supportsSamplingParams(this.config.model)) {
      kwargs["temperature"] = this.config.temperature;
    }
    return kwargs;
  }

  async parse(bundle: PromptBundle, userMessage: string): Promise<LLMResponse> {
    const client = await this.ensureClient();
    const messages = fewshotMessages(bundle, true);
    messages.push({ role: "user", content: userMessage });

    const started = performance.now();
    let response: any;
    try {
      response = await client.messages.create(
        this.requestKwargs(bundle.system_text, messages, parseSchemaForPrompt(bundle.version)),
      );
    } catch (exc) {
      throw new LLMError(
        `调用 Anthropic 失败:${(exc as Error).constructor.name}: ${(exc as Error).message}`,
      );
    }
    const latencyMs = Math.trunc(performance.now() - started);

    const stopReason = response?.stop_reason;
    if (stopReason === "refusal") {
      throw new LLMError("模型以安全策略拒绝了本次解析,已中止,不会下单。");
    }
    if (stopReason === "max_tokens") {
      throw new LLMError("模型输出被 max_tokens 截断,JSON 不完整,已中止。请提高 max_tokens。");
    }

    const text = (response?.content ?? [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("");
    if (!text.trim()) throw new LLMError("模型返回空内容。");

    return new LLMResponse(
      text,
      response?.model ?? this.config.model,
      bundle.version,
      fingerprint(bundle),
      latencyMs,
      anthropicUsage(response?.usage),
    );
  }

  /** 单轮小任务(如板块选股):不带交易少样本,只按给定 schema 要 JSON。 */
  async completeJson(
    system: string, user: string, schema: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const client = await this.ensureClient();
    let response: any;
    try {
      response = await client.messages.create({
        model: this.config.model,
        max_tokens: this.config.max_tokens,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { format: { type: "json_schema", schema }, effort: this.config.effort },
      });
    } catch (exc) {
      throw new LLMError(friendlyApiError(exc as Error));
    }
    if (response?.stop_reason === "max_tokens") {
      throw new LLMError("模型输出被 max_tokens 截断,已中止。请提高 max_tokens。");
    }
    const text = (response?.content ?? [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("");
    try {
      return JSON.parse(text);
    } catch (exc) {
      throw new LLMError(`模型输出不是合法 JSON:${(exc as Error).message}`);
    }
  }

  async test(apiKey?: string | null): Promise<Record<string, unknown>> {
    const probe = new AnthropicParser(
      { ...this.config, max_tokens: 1024 }, apiKey ?? this.apiKey,
    );
    const client = await probe.ensureClient();
    const started = performance.now();
    let response: any;
    try {
      response = await client.messages.create({
        model: probe.config.model,
        max_tokens: 1024,
        messages: [{ role: "user", content: '回复 JSON:{"ok": true}' }],
        output_config: { format: { type: "json_schema", schema: PING_SCHEMA } },
      });
    } catch (exc) {
      throw new LLMError(friendlyApiError(exc as Error));
    }
    const latencyMs = Math.trunc(performance.now() - started);
    const text = (response?.content ?? [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("");
    return {
      ok: true,
      model: response?.model ?? probe.config.model,
      latency_ms: latencyMs,
      structured_mode: "json_schema",
      usage: anthropicUsage(response?.usage),
      sample: text.slice(0, 200),
    };
  }
}

function anthropicUsage(usage: any): Record<string, unknown> {
  if (usage === null || usage === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const key of [
    "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
  ]) {
    if (usage[key] !== null && usage[key] !== undefined) out[key] = usage[key];
  }
  return out;
}

// ---------------------------------------------------------------- OpenAI 兼容
/** 走 /chat/completions 的通用实现(fetch + 默认证书校验)。 */
export class OpenAICompatibleParser {
  readonly provider = "openai_compatible";
  readonly baseUrl: string;

  /** 端点拒过 json_schema(HTTP 400)就记住:后面直接走 json_object,不再每次先撞一遍 400。 */
  private schemaRejected = false;

  constructor(
    readonly config: LLMConfig,
    protected readonly apiKey: string | null = null,
  ) {
    this.baseUrl = validateBaseUrlLocal(config.base_url);
  }

  async parse(bundle: PromptBundle, userMessage: string): Promise<LLMResponse> {
    const schema = parseSchemaForPrompt(bundle.version);
    const messages: Msg[] = [{ role: "system", content: bundle.system_text }];
    for (const pair of bundle.fewshot) {
      messages.push({ role: "user", content: pair.user });
      // 少样本 assistant 走浮点感知序列化,与 Python json.dumps 的字节一致
      messages.push({ role: "assistant", content: pyDumps(pair.assistantJ) });
    }
    messages.push({ role: "user", content: userMessage });

    const started = performance.now();
    const [data, mode] = await this.complete(messages, schema);
    const latencyMs = Math.trunc(performance.now() - started);

    const choice = (data["choices"] as Msg[] | undefined)?.[0] ?? {};
    const finish = choice["finish_reason"];
    if (finish === "length") {
      throw new LLMError("模型输出被 max_tokens 截断,JSON 不完整,已中止。请提高 max_tokens。");
    }
    if (finish === "content_filter") {
      throw new LLMError("模型以内容策略拒绝了本次解析,已中止,不会下单。");
    }
    const text = String(((choice["message"] as Msg) ?? {})["content"] ?? "").trim();
    if (!text) throw new LLMError("模型返回空内容。");

    return new LLMResponse(
      stripCodeFence(text),
      (data["model"] as string) ?? this.config.model,
      bundle.version,
      fingerprint(bundle),
      latencyMs,
      openaiUsage(data["usage"]),
      mode,
    );
  }

  /** 先试 json_schema;端点不认再退到 json_object,并把 schema 写进系统提示词。 */
  protected async complete(
    messages: Msg[], schema: Record<string, unknown>,
  ): Promise<[Msg, string]> {
    const body: Msg = {
      model: this.config.model,
      messages,
      max_tokens: this.config.max_tokens,
      temperature: this.config.temperature !== null ? this.config.temperature : 0,
      response_format: {
        type: "json_schema",
        json_schema: { name: "parse_result", strict: true, schema },
      },
    };
    if (!this.schemaRejected) {
      try {
        return [await this.post("/chat/completions", body), "json_schema"];
      } catch (exc) {
        if (!(exc instanceof LLMError)) throw exc;
        const msg = String(exc.message);
        if (!msg.includes("400") && !msg.includes("response_format")) throw exc;
        // 端点不认 json_schema:这一进程里不再试。实测 DeepSeek 每次都 400,不记住就每条指令多一个往返。
        this.schemaRejected = true;
      }
    }
    const fallback = [...messages];
    fallback[0] = {
      role: "system",
      content:
        String((fallback[0] as Msg)["content"]) +
        "\n\n# 输出必须严格符合以下 JSON Schema\n" +
        JSON.stringify(schema),
    };
    const body2: Msg = {
      model: this.config.model,
      messages: fallback,
      max_tokens: this.config.max_tokens,
      temperature: this.config.temperature !== null ? this.config.temperature : 0,
      response_format: { type: "json_object" },
    };
    return [await this.post("/chat/completions", body2), "json_object"];
  }

  protected async post(pathName: string, body: Msg): Promise<Msg> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout_s * 1000);
    let response: Response;
    try {
      response = await fetch(this.baseUrl + pathName, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resolveApiKey(this.config, this.apiKey)}`,
          "User-Agent": "dafri-trading/0.1",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (exc) {
      clearTimeout(timer);
      throw new LLMError(`无法连接 ${this.baseUrl}:${(exc as Error).message}`);
    }
    clearTimeout(timer);
    const raw = await response.text();
    if (!response.ok) {
      throw new LLMError(`HTTP ${response.status}:${raw.slice(0, 400)}`);
    }
    try {
      return JSON.parse(raw);
    } catch (exc) {
      throw new LLMError(`端点返回的不是 JSON:${(exc as Error).message}`);
    }
  }

  /** 单轮小任务:不带交易少样本,只按给定 schema 要 JSON。 */
  async completeJson(
    system: string, user: string, schema: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const messages: Msg[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    const [data] = await this.complete(messages, schema);
    const choice = (data["choices"] as Msg[] | undefined)?.[0] ?? {};
    if (choice["finish_reason"] === "length") {
      throw new LLMError("模型输出被 max_tokens 截断,已中止。请提高 max_tokens。");
    }
    const text = stripCodeFence(
      String(((choice["message"] as Msg) ?? {})["content"] ?? "").trim(),
    );
    if (!text) throw new LLMError("模型返回空内容。");
    try {
      return JSON.parse(text);
    } catch (exc) {
      throw new LLMError(`模型输出不是合法 JSON:${(exc as Error).message}`);
    }
  }

  async test(apiKey?: string | null): Promise<Record<string, unknown>> {
    const probe = new OpenAICompatibleParser(this.config, apiKey ?? this.apiKey);
    const messages: Msg[] = [
      { role: "system", content: "你只输出 JSON。" },
      { role: "user", content: '回复 {"ok": true}' },
    ];
    const started = performance.now();
    const [data, mode] = await probe.complete(messages, PING_SCHEMA);
    const latencyMs = Math.trunc(performance.now() - started);
    const choice = (data["choices"] as Msg[] | undefined)?.[0] ?? {};
    return {
      ok: true,
      model: (data["model"] as string) ?? this.config.model,
      latency_ms: latencyMs,
      structured_mode: mode,
      usage: openaiUsage(data["usage"]),
      sample: String(((choice["message"] as Msg) ?? {})["content"] ?? "").slice(0, 200),
    };
  }
}

function openaiUsage(usage: unknown): Record<string, unknown> {
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return {};
  const u = usage as Msg;
  return {
    input_tokens: u["prompt_tokens"] ?? null,
    output_tokens: u["completion_tokens"] ?? null,
    cache_hit_tokens: u["prompt_cache_hit_tokens"] ?? null,
    cache_miss_tokens: u["prompt_cache_miss_tokens"] ?? null,
  };
}

/** 有些兼容端点会把 JSON 包在 ```json 里,即便要求了 json_object。 */
export function stripCodeFence(text: string): string {
  const stripped = text.trim();
  if (!stripped.startsWith("```")) return stripped;
  const nl = stripped.indexOf("\n");
  let body = nl >= 0 ? stripped.slice(nl + 1) : stripped;
  if (body.trimEnd().endsWith("```")) {
    body = body.trimEnd().slice(0, -3);
  }
  return body.trim();
}

export const PING_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

export function friendlyApiError(exc: Error): string {
  const text = String(exc.message ?? exc);
  const name = exc.constructor.name;
  if (text.toLowerCase().includes("authentication") || text.includes("401") || name === "AuthenticationError") {
    return "API Key 无效或已失效(401)。请在「大模型」面板里重新填写。";
  }
  if (text.toLowerCase().includes("not_found") || text.includes("404")) {
    return "模型名不存在(404):请核对模型标识。";
  }
  if (text.toLowerCase().includes("rate_limit") || text.includes("429")) {
    return "触发限流(429),稍后再试。";
  }
  if (text.toLowerCase().includes("connection") || name === "APIConnectionError") {
    return "网络不通:检查出网白名单与代理设置。";
  }
  return `${name}: ${text}`;
}

// ----------------------------------------------------------------------
export function buildParser(
  config: LLMConfig, apiKey?: string | null,
): AnthropicParser | OpenAICompatibleParser {
  if (config.provider === "anthropic") return new AnthropicParser(config, apiKey ?? null);
  if (config.provider === "openai_compatible") {
    return new OpenAICompatibleParser(config, apiKey ?? null);
  }
  throw new LLMError(
    `未知的模型供应商:${config.provider}(可选:${Object.keys(PROVIDERS).join("、")})`,
  );
}

export function fewshotMessages(bundle: PromptBundle, cacheLast: boolean): Msg[] {
  const messages: Msg[] = [];
  bundle.fewshot.forEach((pair: FewShotPair, idx: number) => {
    messages.push({ role: "user", content: pair.user });
    const content: Msg = { type: "text", text: pyDumps(pair.assistantJ) };
    if (cacheLast && idx === bundle.fewshot.length - 1) {
      content["cache_control"] = { type: "ephemeral" };
    }
    messages.push({ role: "assistant", content: [content] });
  });
  return messages;
}

import { pyDumps } from "./pyjson.js";
import { validateBaseUrl as validateBaseUrlLocal } from "./config.js";
