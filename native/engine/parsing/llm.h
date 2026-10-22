// llm.ts:LLM 调用层的对外入口(只做转出,保持引擎与测试的 include 路径稳定)。实现在 parsing/providers,HTTP 在 parsing/sdk_http。
#pragma once

#include "parsing/providers.h"

namespace ibkr::parsing::llm {

using providers::AnthropicParser;
using providers::buildParser;
using providers::friendlyApiError;
using providers::LLMError;
using providers::LLMResponse;
using providers::OpenAICompatibleParser;
using providers::providerCatalog;
using providers::providersTable;
using providers::resolveApiKey;
using providers::stripCodeFence;
using providers::structuredOutputSchema;
using providers::supportsSamplingParams;
using providers::validateBaseUrl;

}  // namespace ibkr::parsing::llm
