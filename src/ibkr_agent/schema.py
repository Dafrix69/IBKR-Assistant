"""把 pydantic 模型转成各家 structured output 都能吃的 JSON Schema。

各家实现都不支持数值/长度约束(minimum、maxLength 之类),pydantic 又一定会生成它们。
这里统一剥掉——语义约束不是不要了,而是全部由 models.py 在本地复校验,
所以剥掉的是"给 API 看的那一份",不是"我们自己认的那一份"。
"""
from __future__ import annotations

import re
from typing import Any, Dict, Tuple, Type

from pydantic import BaseModel

UNSUPPORTED_KEYWORDS = (
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "uniqueItems",
)


def structured_output_schema(model: Type[BaseModel]) -> Dict[str, Any]:
    schema = model.model_json_schema()
    _strip(schema)
    return schema


def parse_schema_for_prompt(prompt_version: str) -> Dict[str, Any]:
    """发给模型的 ParseResult schema,随提示词版本走。

    v1.8.0 起限额只在校验层复算,提示词让模型"不要输出 EXCEEDS_LIMIT"——发出去的 enum 就不能再列它,
    否则 json_object 降级时同一条系统消息里既说不要输出、又把它列成合法值。pydantic 模型本身保留该码
    (v1.7.0 回滚、以及模型不听话时仍能解析),剥掉的只是"给 API 看的那一份"。
    """
    from .models import ParseResult

    schema = structured_output_schema(ParseResult)
    if _version_tuple(prompt_version) >= (1, 8, 0):
        code = schema.get("$defs", {}).get("Rejection", {}).get("properties", {}).get("code", {})
        if isinstance(code.get("enum"), list):
            code["enum"] = [c for c in code["enum"] if c != "EXCEEDS_LIMIT"]
    return schema


def _version_tuple(version: str) -> Tuple[int, ...]:
    digits = re.findall(r"\d+", version or "")
    return tuple(int(d) for d in digits[:3]) or (0,)


def _strip(node: Any) -> None:
    if isinstance(node, dict):
        for key in UNSUPPORTED_KEYWORDS:
            node.pop(key, None)
        if node.get("type") == "object" and "additionalProperties" not in node:
            node["additionalProperties"] = False
        for value in node.values():
            _strip(value)
    elif isinstance(node, list):
        for item in node:
            _strip(item)
