"""外部大模型接入层。

原本只支持 Anthropic。这里抽出一层 backend,多加一种「OpenAI 兼容」的接法——
国内多数模型服务(DeepSeek、通义、Kimi、智谱…)都暴露 OpenAI 兼容端点,
有了它用户就能在界面上自己接,而不必改代码。

两条底线不因换供应商而放松:

  * **发出去的仍然只有 S2 级数据**(指令原文 + 时间 + 行情快照 + 别名表/限额),
    §9.1 的数据分级和供应商是谁无关;
  * **输出仍然要过 schema**。能用 json_schema 就用;供应商只支持 json_object 时
    自动降级,并把 schema 塞进系统提示词——降级会记在返回里,界面要显示出来,
    因为这直接影响解析可靠性。
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from .config import LLMConfig
from .keychain import get_secret
from .prompts import PromptBundle

# 界面上的供应商目录。models 只是预设,用户可以填任意模型名。
PROVIDERS: Dict[str, Dict[str, Any]] = {
    "anthropic": {
        "label": "Anthropic(Claude)",
        "default_model": "claude-opus-5",
        "models": ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
        "supports_effort": True,
        "supports_temperature": False,   # Opus 5 / Sonnet 5 起已移除采样参数
        "needs_base_url": False,
        "default_base_url": "",
        "key_hint": "sk-ant-...",
        "docs": "https://platform.claude.com/",
    },
    "openai_compatible": {
        "label": "OpenAI 兼容端点",
        "default_model": "",
        "models": [
            "deepseek-chat",
            "deepseek-reasoner",
            "qwen-max",
            "moonshot-v1-128k",
            "glm-4-plus",
            "gpt-4o",
        ],
        "supports_effort": False,
        "supports_temperature": True,
        "needs_base_url": True,
        "default_base_url": "https://api.deepseek.com/v1",
        "key_hint": "sk-...",
        "docs": "填你的服务商给的 base_url,通常以 /v1 结尾",
    },
}


class LLMError(RuntimeError):
    pass


@dataclass
class LLMResponse:
    text: str
    model: str
    prompt_version: str
    prompt_fingerprint: str
    latency_ms: int
    usage: Dict[str, Any] = field(default_factory=dict)
    structured_mode: str = "json_schema"   # json_schema | json_object | none

    def payload(self) -> Dict[str, Any]:
        try:
            return json.loads(self.text)
        except json.JSONDecodeError as exc:
            raise LLMError("模型输出不是合法 JSON:%s" % exc) from exc


def provider_catalog() -> List[Dict[str, Any]]:
    return [{"key": key, **{k: v for k, v in meta.items()}} for key, meta in PROVIDERS.items()]


def validate_base_url(url: str) -> str:
    """§9.4:强制 TLS。只给本机放行 http,方便自建代理调试。"""
    url = (url or "").strip().rstrip("/")
    if not url:
        raise LLMError("OpenAI 兼容端点必须填 base_url")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise LLMError("base_url 必须以 http(s):// 开头")
    host = (parsed.hostname or "").lower()
    if parsed.scheme == "http" and host not in ("127.0.0.1", "localhost", "::1"):
        raise LLMError("非本机地址必须用 https(§9.4 强制 TLS),收到:%s" % url)
    return url


def resolve_api_key(config: LLMConfig, explicit: Optional[str] = None) -> str:
    if explicit:
        return explicit
    key = get_secret(config.keychain_service, config.keychain_account)
    if not key:
        raise LLMError(
            "Keychain 里没有 %s 的 API Key(service=%s, account=%s)。"
            "请在界面「大模型」面板里填写并保存。"
            % (config.provider, config.keychain_service, config.keychain_account)
        )
    return key


# ======================================================================
# Anthropic
# ======================================================================
_NO_SAMPLING_PREFIXES = (
    "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7",
    "claude-sonnet-5", "claude-fable-5", "claude-mythos-5",
)


def supports_sampling_params(model: str) -> bool:
    return not any(model.startswith(p) for p in _NO_SAMPLING_PREFIXES)


class AnthropicParser:
    """官方 SDK + structured outputs(API 层就按 schema 约束输出)。"""

    provider = "anthropic"

    def __init__(self, config: LLMConfig, api_key: Optional[str] = None):
        self.config = config
        self._api_key = api_key
        self._client = None

    def _ensure_client(self):
        if self._client is None:
            try:
                import anthropic
            except ImportError as exc:  # pragma: no cover
                raise LLMError("未安装 anthropic SDK:pip install anthropic") from exc
            self._client = anthropic.Anthropic(
                api_key=resolve_api_key(self.config, self._api_key),
                timeout=self.config.timeout_s,
                max_retries=2,
            )
        return self._client

    def _request_kwargs(self, system: str, messages: List[Dict[str, Any]], schema: Dict[str, Any]):
        kwargs: Dict[str, Any] = {
            "model": self.config.model,
            "max_tokens": self.config.max_tokens,
            "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            "messages": messages,
            "output_config": {
                "format": {"type": "json_schema", "schema": schema},
                "effort": self.config.effort,
            },
        }
        if self.config.temperature is not None and supports_sampling_params(self.config.model):
            kwargs["temperature"] = self.config.temperature
        return kwargs

    def parse(self, bundle: PromptBundle, user_message: str) -> LLMResponse:
        from .models import ParseResult
        from .schema import structured_output_schema

        client = self._ensure_client()
        messages = _fewshot_messages(bundle, cache_last=True)
        messages.append({"role": "user", "content": user_message})

        started = time.monotonic()
        try:
            response = client.messages.create(
                **self._request_kwargs(bundle.system_text, messages, structured_output_schema(ParseResult))
            )
        except Exception as exc:  # noqa: BLE001
            raise LLMError("调用 Anthropic 失败:%s: %s" % (type(exc).__name__, exc)) from exc
        latency_ms = int((time.monotonic() - started) * 1000)

        stop_reason = getattr(response, "stop_reason", None)
        if stop_reason == "refusal":
            raise LLMError("模型以安全策略拒绝了本次解析,已中止,不会下单。")
        if stop_reason == "max_tokens":
            raise LLMError("模型输出被 max_tokens 截断,JSON 不完整,已中止。请提高 max_tokens。")

        text = "".join(
            b.text for b in response.content if getattr(b, "type", None) == "text"
        )
        if not text.strip():
            raise LLMError("模型返回空内容。")

        return LLMResponse(
            text=text,
            model=getattr(response, "model", self.config.model),
            prompt_version=bundle.version,
            prompt_fingerprint=bundle.fingerprint,
            latency_ms=latency_ms,
            usage=_anthropic_usage(getattr(response, "usage", None)),
        )

    def complete_json(self, system: str, user: str, schema: Dict[str, Any]) -> Dict[str, Any]:
        """单轮小任务(如板块选股):不带交易少样本,只按给定 schema 要 JSON。"""
        client = self._ensure_client()
        try:
            response = client.messages.create(
                model=self.config.model,
                max_tokens=self.config.max_tokens,
                system=system,
                messages=[{"role": "user", "content": user}],
                output_config={
                    "format": {"type": "json_schema", "schema": schema},
                    "effort": self.config.effort,
                },
            )
        except Exception as exc:  # noqa: BLE001
            raise LLMError(_friendly_api_error(exc)) from exc
        if getattr(response, "stop_reason", None) == "max_tokens":
            raise LLMError("模型输出被 max_tokens 截断,已中止。请提高 max_tokens。")
        text = "".join(b.text for b in response.content if getattr(b, "type", None) == "text")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise LLMError("模型输出不是合法 JSON:%s" % exc) from exc

    def test(self, api_key: Optional[str] = None) -> Dict[str, Any]:
        probe = LLMConfig(**{**self.config.__dict__, "max_tokens": 1024})
        client_parser = AnthropicParser(probe, api_key or self._api_key)
        client = client_parser._ensure_client()
        started = time.monotonic()
        try:
            response = client.messages.create(
                model=probe.model,
                max_tokens=1024,
                messages=[{"role": "user", "content": "回复 JSON:{\"ok\": true}"}],
                output_config={"format": {"type": "json_schema", "schema": _PING_SCHEMA}},
            )
        except Exception as exc:  # noqa: BLE001
            raise LLMError(_friendly_api_error(exc)) from exc
        latency_ms = int((time.monotonic() - started) * 1000)
        text = "".join(b.text for b in response.content if getattr(b, "type", None) == "text")
        return {
            "ok": True,
            "model": getattr(response, "model", probe.model),
            "latency_ms": latency_ms,
            "structured_mode": "json_schema",
            "usage": _anthropic_usage(getattr(response, "usage", None)),
            "sample": text[:200],
        }


def _anthropic_usage(usage: Any) -> Dict[str, Any]:
    if usage is None:
        return {}
    out = {}
    for key in ("input_tokens", "output_tokens",
                "cache_creation_input_tokens", "cache_read_input_tokens"):
        value = getattr(usage, key, None)
        if value is not None:
            out[key] = value
    return out


# ======================================================================
# OpenAI 兼容
# ======================================================================
class OpenAICompatibleParser:
    """走 /chat/completions 的通用实现,不引入新依赖(标准库 urllib + 默认证书校验)。"""

    provider = "openai_compatible"

    def __init__(self, config: LLMConfig, api_key: Optional[str] = None):
        self.config = config
        self._api_key = api_key
        self.base_url = validate_base_url(config.base_url)

    def parse(self, bundle: PromptBundle, user_message: str) -> LLMResponse:
        from .models import ParseResult
        from .schema import structured_output_schema

        schema = structured_output_schema(ParseResult)
        messages = [{"role": "system", "content": bundle.system_text}]
        for pair in bundle.fewshot:
            messages.append({"role": "user", "content": pair.user})
            messages.append(
                {"role": "assistant", "content": json.dumps(pair.assistant, ensure_ascii=False)}
            )
        messages.append({"role": "user", "content": user_message})

        started = time.monotonic()
        data, mode = self._complete(messages, schema)
        latency_ms = int((time.monotonic() - started) * 1000)

        choice = (data.get("choices") or [{}])[0]
        finish = choice.get("finish_reason")
        if finish == "length":
            raise LLMError("模型输出被 max_tokens 截断,JSON 不完整,已中止。请提高 max_tokens。")
        if finish == "content_filter":
            raise LLMError("模型以内容策略拒绝了本次解析,已中止,不会下单。")
        text = ((choice.get("message") or {}).get("content") or "").strip()
        if not text:
            raise LLMError("模型返回空内容。")

        return LLMResponse(
            text=_strip_code_fence(text),
            model=data.get("model", self.config.model),
            prompt_version=bundle.version,
            prompt_fingerprint=bundle.fingerprint,
            latency_ms=latency_ms,
            usage=_openai_usage(data.get("usage")),
            structured_mode=mode,
        )

    def _complete(self, messages, schema):
        """先试 json_schema;端点不认再退到 json_object,并把 schema 写进系统提示词。"""
        body = {
            "model": self.config.model,
            "messages": messages,
            "max_tokens": self.config.max_tokens,
            "temperature": self.config.temperature if self.config.temperature is not None else 0,
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "parse_result", "strict": True, "schema": schema},
            },
        }
        try:
            return self._post("/chat/completions", body), "json_schema"
        except LLMError as exc:
            if "400" not in str(exc) and "response_format" not in str(exc):
                raise
        fallback = list(messages)
        fallback[0] = {
            "role": "system",
            "content": fallback[0]["content"]
            + "\n\n# 输出必须严格符合以下 JSON Schema\n"
            + json.dumps(schema, ensure_ascii=False),
        }
        body["messages"] = fallback
        body["response_format"] = {"type": "json_object"}
        return self._post("/chat/completions", body), "json_object"

    def _post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        request = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer %s" % resolve_api_key(self.config, self._api_key),
                "User-Agent": "dafri-trading/0.1",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.config.timeout_s) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            raise LLMError("HTTP %d:%s" % (exc.code, detail)) from exc
        except urllib.error.URLError as exc:
            raise LLMError("无法连接 %s:%s" % (self.base_url, exc.reason)) from exc
        except json.JSONDecodeError as exc:
            raise LLMError("端点返回的不是 JSON:%s" % exc) from exc

    def complete_json(self, system: str, user: str, schema: Dict[str, Any]) -> Dict[str, Any]:
        """单轮小任务(如板块选股):不带交易少样本,只按给定 schema 要 JSON。"""
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        data, _mode = self._complete(messages, schema)
        choice = (data.get("choices") or [{}])[0]
        if choice.get("finish_reason") == "length":
            raise LLMError("模型输出被 max_tokens 截断,已中止。请提高 max_tokens。")
        text = _strip_code_fence(((choice.get("message") or {}).get("content") or "").strip())
        if not text:
            raise LLMError("模型返回空内容。")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise LLMError("模型输出不是合法 JSON:%s" % exc) from exc

    def test(self, api_key: Optional[str] = None) -> Dict[str, Any]:
        probe = OpenAICompatibleParser(self.config, api_key or self._api_key)
        messages = [
            {"role": "system", "content": "你只输出 JSON。"},
            {"role": "user", "content": '回复 {"ok": true}'},
        ]
        started = time.monotonic()
        data, mode = probe._complete(messages, _PING_SCHEMA)
        latency_ms = int((time.monotonic() - started) * 1000)
        choice = (data.get("choices") or [{}])[0]
        return {
            "ok": True,
            "model": data.get("model", self.config.model),
            "latency_ms": latency_ms,
            "structured_mode": mode,
            "usage": _openai_usage(data.get("usage")),
            "sample": ((choice.get("message") or {}).get("content") or "")[:200],
        }


def _openai_usage(usage: Any) -> Dict[str, Any]:
    if not isinstance(usage, dict):
        return {}
    return {
        "input_tokens": usage.get("prompt_tokens"),
        "output_tokens": usage.get("completion_tokens"),
    }


def _strip_code_fence(text: str) -> str:
    """有些兼容端点会把 JSON 包在 ```json 里,即便要求了 json_object。"""
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    body = stripped.split("\n", 1)[-1]
    if body.rstrip().endswith("```"):
        body = body.rstrip()[:-3]
    return body.strip()


_PING_SCHEMA = {
    "type": "object",
    "properties": {"ok": {"type": "boolean"}},
    "required": ["ok"],
    "additionalProperties": False,
}


def _friendly_api_error(exc: BaseException) -> str:
    text = str(exc)
    name = type(exc).__name__
    if "authentication" in text.lower() or "401" in text or name == "AuthenticationError":
        return "API Key 无效或已失效(401)。请在「大模型」面板里重新填写。"
    if "not_found" in text.lower() or "404" in text:
        return "模型名不存在(404):请核对模型标识。"
    if "rate_limit" in text.lower() or "429" in text:
        return "触发限流(429),稍后再试。"
    if "connection" in text.lower() or name == "APIConnectionError":
        return "网络不通:检查出网白名单与代理设置。"
    return "%s: %s" % (name, text)


# ======================================================================
def build_parser(config: LLMConfig, api_key: Optional[str] = None):
    if config.provider == "anthropic":
        return AnthropicParser(config, api_key)
    if config.provider == "openai_compatible":
        return OpenAICompatibleParser(config, api_key)
    raise LLMError("未知的模型供应商:%s(可选:%s)" % (config.provider, "、".join(PROVIDERS)))


def _fewshot_messages(bundle: PromptBundle, cache_last: bool) -> List[Dict[str, Any]]:
    messages: List[Dict[str, Any]] = []
    for idx, pair in enumerate(bundle.fewshot):
        messages.append({"role": "user", "content": pair.user})
        content: Dict[str, Any] = {
            "type": "text",
            "text": json.dumps(pair.assistant, ensure_ascii=False),
        }
        if cache_last and idx == len(bundle.fewshot) - 1:
            content["cache_control"] = {"type": "ephemeral"}
        messages.append({"role": "assistant", "content": [content]})
    return messages
