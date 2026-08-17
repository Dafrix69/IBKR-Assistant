"""外部大模型接入层。换供应商不能把安全边界一起换掉。"""
from __future__ import annotations

import json

import pytest

from conftest import make_settings
from ibkr_agent import providers
from ibkr_agent.config import LLMConfig
from ibkr_agent.llm import build_parser, structured_output_schema


# ---- base_url 校验(§9.4 强制 TLS)---------------------------------------
def test_https_base_url_accepted_and_normalised():
    assert providers.validate_base_url("https://api.deepseek.com/v1/") == "https://api.deepseek.com/v1"


def test_plain_http_to_the_internet_is_refused():
    with pytest.raises(providers.LLMError, match="必须用 https"):
        providers.validate_base_url("http://api.example.com/v1")


def test_localhost_http_is_allowed_for_self_hosted_proxies():
    assert providers.validate_base_url("http://127.0.0.1:8000/v1") == "http://127.0.0.1:8000/v1"
    assert providers.validate_base_url("http://localhost:8000/v1") == "http://localhost:8000/v1"


def test_empty_or_malformed_base_url_is_refused():
    for bad in ("", "   ", "api.example.com/v1"):
        with pytest.raises(providers.LLMError):
            providers.validate_base_url(bad)


# ---- 供应商目录与工厂 -----------------------------------------------------
def test_catalog_exposes_what_the_ui_needs():
    catalog = {p["key"]: p for p in providers.provider_catalog()}
    assert set(catalog) == {"anthropic", "openai_compatible"}
    for meta in catalog.values():
        for key in ("label", "models", "needs_base_url", "supports_effort", "supports_temperature"):
            assert key in meta
    assert catalog["anthropic"]["supports_effort"] is True
    assert catalog["anthropic"]["supports_temperature"] is False   # Opus 5 起已移除采样参数
    assert catalog["openai_compatible"]["needs_base_url"] is True


def test_factory_picks_the_right_backend():
    anthropic_cfg = LLMConfig(provider="anthropic", model="claude-opus-5")
    assert isinstance(build_parser(anthropic_cfg), providers.AnthropicParser)

    compatible = LLMConfig(
        provider="openai_compatible", model="deepseek-chat", base_url="https://api.deepseek.com/v1"
    )
    assert isinstance(build_parser(compatible), providers.OpenAICompatibleParser)


def test_unknown_provider_is_refused():
    with pytest.raises(providers.LLMError, match="未知的模型供应商"):
        build_parser(LLMConfig(provider="telepathy", model="x"))


def test_sampling_gate_still_applies_per_model():
    assert not providers.supports_sampling_params("claude-opus-5")
    assert providers.supports_sampling_params("claude-haiku-4-5")


# ---- OpenAI 兼容:结构化输出降级 -------------------------------------------
class _FakeCompatible(providers.OpenAICompatibleParser):
    """记录请求体,并可指定 json_schema 是否被端点接受。"""

    def __init__(self, config, schema_supported: bool):
        super().__init__(config, api_key="sk-test")
        self.schema_supported = schema_supported
        self.bodies = []

    def _post(self, path, body):
        self.bodies.append(body)
        if body["response_format"]["type"] == "json_schema" and not self.schema_supported:
            raise providers.LLMError("HTTP 400:unsupported response_format")
        return {
            "model": body["model"],
            "choices": [{"message": {"content": '{"orders": [], "rejections": []}'},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        }


def _compat_config():
    return LLMConfig(
        provider="openai_compatible", model="deepseek-chat",
        base_url="https://api.deepseek.com/v1", temperature=0.0,
    )


def test_json_schema_is_preferred(settings):
    from ibkr_agent.prompts import load_prompt_bundle

    parser = _FakeCompatible(_compat_config(), schema_supported=True)
    response = parser.parse(load_prompt_bundle(settings), "买入 AAPL 100股 limit 230")
    assert response.structured_mode == "json_schema"
    assert len(parser.bodies) == 1
    assert parser.bodies[0]["response_format"]["json_schema"]["strict"] is True


def test_falls_back_to_json_object_and_inlines_the_schema(settings):
    """端点不认 json_schema 时降级,并把 schema 写进系统提示词,否则模型无从对齐。"""
    from ibkr_agent.prompts import load_prompt_bundle

    parser = _FakeCompatible(_compat_config(), schema_supported=False)
    response = parser.parse(load_prompt_bundle(settings), "买入 AAPL 100股 limit 230")

    assert response.structured_mode == "json_object"
    assert len(parser.bodies) == 2
    second = parser.bodies[1]
    assert second["response_format"] == {"type": "json_object"}
    system = second["messages"][0]
    assert system["role"] == "system"
    assert "JSON Schema" in system["content"]
    assert '"rejections"' in system["content"]
    # 降级后仍然是可解析的结果
    assert response.payload() == {"orders": [], "rejections": []}


def test_truncated_output_is_refused_not_parsed(settings):
    from ibkr_agent.prompts import load_prompt_bundle

    parser = _FakeCompatible(_compat_config(), schema_supported=True)
    parser._post = lambda path, body: {
        "model": "x",
        "choices": [{"message": {"content": '{"orders": ['}, "finish_reason": "length"}],
    }
    with pytest.raises(providers.LLMError, match="截断"):
        parser.parse(load_prompt_bundle(settings), "买入 AAPL 100股")


def test_content_filter_is_refused(settings):
    from ibkr_agent.prompts import load_prompt_bundle

    parser = _FakeCompatible(_compat_config(), schema_supported=True)
    parser._post = lambda path, body: {
        "model": "x",
        "choices": [{"message": {"content": ""}, "finish_reason": "content_filter"}],
    }
    with pytest.raises(providers.LLMError, match="内容策略"):
        parser.parse(load_prompt_bundle(settings), "买入 AAPL 100股")


@pytest.mark.parametrize(
    "raw,expected",
    [
        ('{"a": 1}', '{"a": 1}'),
        ('```json\n{"a": 1}\n```', '{"a": 1}'),
        ('```\n{"a": 1}\n```', '{"a": 1}'),
    ],
)
def test_code_fences_are_stripped(raw, expected):
    """有些兼容端点即使要求了 json_object 也会包一层 ```json。"""
    assert providers._strip_code_fence(raw) == expected


# ---- schema 仍然是各家都能吃的那一份 ---------------------------------------
def test_schema_has_no_unsupported_keywords():
    schema = structured_output_schema()
    def walk(node):
        if isinstance(node, dict):
            assert not (set(node) & set(providers.__dict__.get("_", {}) or {}))
            for key in ("minimum", "maximum", "exclusiveMinimum", "minLength", "pattern"):
                assert key not in node
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)
    walk(schema)


# ---- 配置层 -------------------------------------------------------------
def test_openai_compatible_requires_base_url():
    with pytest.raises(ValueError, match="base_url"):
        make_settings(llm={"provider": "openai_compatible", "model": "deepseek-chat"})


def test_unknown_provider_rejected_by_config():
    with pytest.raises(ValueError, match="llm.provider"):
        make_settings(llm={"provider": "telepathy", "model": "x"})


def test_keychain_account_follows_the_provider():
    """一个供应商一把 key,换供应商不会用错上一把。"""
    settings = make_settings(
        llm={"provider": "openai_compatible", "model": "deepseek-chat",
             "base_url": "https://api.deepseek.com/v1"}
    )
    assert settings.llm.keychain_account == "openai_compatible"
    assert make_settings().llm.keychain_account == "anthropic"


def test_empty_model_is_rejected():
    with pytest.raises(ValueError, match="llm.model 不能为空"):
        make_settings(llm={"provider": "openai_compatible", "model": "",
                           "base_url": "https://api.deepseek.com/v1"})
