"""把 pydantic 模型转成各家 structured output 都能吃的 JSON Schema。

各家实现都不支持数值/长度约束(minimum、maxLength 之类),pydantic 又一定会生成它们。
这里统一剥掉——语义约束不是不要了,而是全部由 models.py 在本地复校验,
所以剥掉的是"给 API 看的那一份",不是"我们自己认的那一份"。
"""
from __future__ import annotations

from typing import Any, Dict, Type

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
