"""LLM 调用层的对外入口。

具体实现按供应商拆到了 providers.py(Anthropic / OpenAI 兼容),schema 处理在 schema.py。
这里只做转出,保持引擎与测试的 import 路径稳定。

与设计文档相比的两处修正(原因见 providers.py 与 README):
  1. 不再无条件发送 temperature=0——当前主力 Claude 模型已移除采样参数,发送会 400;
  2. 用 structured outputs 让 API 层就按 schema 约束输出,而不是只靠提示词里那句"只输出 JSON"。
"""
from __future__ import annotations

from typing import Any, Dict

from .models import ParseResult
from .providers import (  # noqa: F401 - 对外转出
    PROVIDERS,
    AnthropicParser,
    LLMError,
    LLMResponse,
    OpenAICompatibleParser,
    build_parser,
    provider_catalog,
    resolve_api_key,
    supports_sampling_params,
    validate_base_url,
)
from .schema import structured_output_schema as _schema_for


def structured_output_schema(model=ParseResult) -> Dict[str, Any]:
    """解析结果的 JSON Schema(默认就是 ParseResult)。"""
    return _schema_for(model)


__all__ = [
    "PROVIDERS",
    "AnthropicParser",
    "OpenAICompatibleParser",
    "LLMError",
    "LLMResponse",
    "build_parser",
    "provider_catalog",
    "resolve_api_key",
    "structured_output_schema",
    "supports_sampling_params",
    "validate_base_url",
]
