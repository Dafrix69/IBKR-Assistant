/** llm.*:大模型接入——供应商目录、当前配置、改配置、测连通。类型文件,不 import 任何东西。
 *
 * API Key 不在这里的任何一个返回里:它只在系统凭证库,界面能知道的只有"这一家配没配"(key_configured)。
 * llm.test 的入参可以带一把**还没保存**的 key 先试——它只经过这一跳,不落盘、不回显、不进日志。
 */

/** 配置文件里 llm 那一段(config.ts 的 LLMConfig 就是它,从这里转出)。 */
export interface LLMConfig {
  /** anthropic / openai_compatible */
  provider: string;
  model: string;
  /** 只有支持的供应商才看(supports_effort) */
  effort: string;
  /** null = 不设,用供应商默认;不支持采样参数的供应商不看 */
  temperature: number | null;
  /** 只有 needs_base_url 的供应商才要 */
  base_url: string;
  /** 至少 1000 */
  max_tokens: number;
  timeout_s: number;
  /** 凭证库里的服务名与账户名——是"去哪儿找那把 key",不是 key 本身。account 跟着 provider 走 */
  keychain_service: string;
  keychain_account: string;
}

/** 目录里的一家供应商:界面「大模型」面板照它摆表单。 */
export interface LlmProvider {
  key: string;
  label: string;
  default_model: string;
  /** 下拉里给的几个常用模型;界面另外允许手填 */
  models: string[];
  supports_effort: boolean;
  supports_temperature: boolean;
  needs_base_url: boolean;
  default_base_url: string;
  /** Key 输入框的占位提示(sk-ant-...) */
  key_hint: string;
  /** 一个链接,或一句怎么填 base_url 的话 */
  docs: string;
}

export interface LlmCatalog {
  providers: LlmProvider[];
  current: LLMConfig;
  /** 每家供应商的 Key 配没配(只查有没有,不解密) */
  key_configured: Record<string, boolean>;
}

/** 界面能改的七项;keychain_* 不许从这里改(切 provider 时引擎自己让 keychain_account 跟着切,免得用错那把 key)。 */
export type LlmPatch = Partial<Pick<LLMConfig, "provider" | "model" | "base_url" | "effort" | "temperature" | "max_tokens" | "timeout_s">>;

/**
 * 进 handler 时的样子:schema 只确认 llm 是个对象。哪几项能改由 handler 的白名单说(「不允许修改的字段:…」,golden-rpc 钉着),
 * 值对不对由 config.fromDict 说(「配置校验失败,已回滚:…」)——所以这里的值是 unknown:它们确实还没验过。界面照 LlmPatch 给。
 */
export type LlmPatchInput = { readonly [K in keyof LlmPatch]?: unknown } & { readonly [field: string]: unknown };

export interface LlmPatchParams {
  /** 不给 = 空补丁(等于只重新加载一遍配置) */
  llm?: LlmPatchInput;
}

export interface LlmTestParams {
  /** 在当前配置上临时盖几项再试(不保存);只认 LLMConfig 上有的键,别的不看 */
  llm?: LlmPatchInput;
  /** 一把还没保存的 key:给了就用它,不给用凭证库里那把 */
  api_key?: string;
}

/** 这一次请求用掉的 token。**数值由供应商的回包给**,两家的键不一样,读的一方按"可能没有"来读。 */
export interface LlmUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  /** Anthropic:提示词缓存的写入 / 命中 */
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** OpenAI 兼容端点(DeepSeek 这一类)报的缓存命中 / 未命中 */
  cache_hit_tokens?: number | null;
  cache_miss_tokens?: number | null;
}

/** 两家解析器的 test() 给的那一份:打通了才有。provider 由 handler 补(试的是哪一家,解析器自己不知道配置叫什么名)。 */
export interface LlmTestProbe {
  ok: true;
  /** 端点回报的模型名(可能和请求的不完全一样) */
  model: string;
  latency_ms: number;
  /** json_schema;端点不支持时降级成 json_object(提示词内嵌 schema,拒绝率可能升高——界面要提示) */
  structured_mode: string;
  usage: LlmUsage;
  /** 回包正文的前 200 字 */
  sample: string;
}

/**
 * llm.test 的回执。**测不通不是 RPC 报错**:是 ok: false + 一句人话(401 / 404 / 429 / 连不上各有各的说法),
 * 界面画成一张「测试失败」卡。按 ok 分两支。
 */
export type LlmTestResult =
  | (LlmTestProbe & { provider: string })
  | { ok: false; error: string; provider: string; model: string };
