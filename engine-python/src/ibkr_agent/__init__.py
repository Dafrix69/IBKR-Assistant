"""IBKR 交易指令解析引擎。

模块地图(对应设计文档章节):
    prompts.py    §2/§3  提示词装配与版本管理
    llm.py        §2/§11 LLM 调用(structured outputs)
    models.py     §5.1   输出 schema(第一道防线)
    validator.py  §5     软件层硬校验(第二道防线)
    broker.py     §8     ib_insync 下单、条件单、价差组合
    store.py      §6/§9.6 append-only 交易记录与审计
    engine.py     §1     全流程编排
    killswitch.py §9.7   全局熔断
"""
from .config import Settings, load_settings, now_et
from .engine import EngineResult, TradingEngine
from .models import ParsedOrder, ParseResult, parse_llm_payload
from .validator import ValidationOutcome, Validator

__version__ = "0.1.0"
__all__ = [
    "Settings",
    "load_settings",
    "now_et",
    "TradingEngine",
    "EngineResult",
    "ParsedOrder",
    "ParseResult",
    "parse_llm_payload",
    "Validator",
    "ValidationOutcome",
]
