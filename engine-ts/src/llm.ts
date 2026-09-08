/** LLM 调用层的对外入口(对应 Python llm.py)。
 *
 * 具体实现在 providers.ts,schema 资产在 baseline/llm/。这里只做转出,
 * 保持引擎与测试的 import 路径稳定。
 */
export {
  AnthropicParser,
  LLMError,
  LLMResponse,
  OpenAICompatibleParser,
  PROVIDERS,
  buildParser,
  friendlyApiError,
  providerCatalog,
  resolveApiKey,
  stripCodeFence,
  structuredOutputSchema,
  supportsSamplingParams,
  validateBaseUrl,
} from "./providers.js";
