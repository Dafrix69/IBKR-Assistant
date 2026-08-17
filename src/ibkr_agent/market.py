"""行情快照的标的抽取(设计文档 §3 的"轻量正则预处理")。

作用只有一个:在调用解析引擎**之前**,先从指令里猜出可能被提到的标的,
把它们的现价拼进用户消息,好让模型判断触发方向(铁律 7a),也让 §5.3b 的
方向复核有据可依。这里宁可多抓几个(多拉一个报价没成本),也不要漏掉触发标的。
"""
from __future__ import annotations

import re
from typing import Dict, List, Mapping, Optional, Sequence

from .config import Settings

_TICKER_RE = re.compile(r"\b[A-Za-z]{1,5}\b")

# 常见英文词,避免把 "buy"/"call" 当成 ticker 去拉报价
_STOPWORDS = {
    "BUY", "SELL", "CALL", "PUT", "LMT", "MKT", "STP", "GTC", "DAY", "USD",
    "AT", "TO", "THE", "AND", "OR", "IF", "ON", "OF", "IN", "FOR", "WITH",
    "LIMIT", "MARKET", "STOP", "SPREAD", "OPEN", "CLOSE", "DTE", "ITM", "OTM",
    "A", "AN", "IS", "BE", "PM", "AM", "ET",
}


def extract_symbols(text: str, settings: Settings, extra: Optional[Sequence[str]] = None) -> List[str]:
    """抽出指令里出现的候选标的:显式 ticker + 中文别名表命中 + 常驻指数。"""
    found: List[str] = []

    def add(symbol: str) -> None:
        symbol = symbol.upper()
        if symbol and symbol not in found:
            found.append(symbol)

    for match in _TICKER_RE.findall(text):
        token = match.upper()
        if token in _STOPWORDS:
            continue
        # 只认别名表里出现过的 ticker、指数、或长度 >=2 的全大写原样输入
        if token in settings.index_symbols or token in set(settings.symbol_aliases.values()):
            add(token)
        elif match.isupper() and len(token) >= 2:
            add(token)

    for name, ticker in settings.symbol_aliases.items():
        if name and name in text:
            add(ticker)

    for symbol in settings.index_symbols:
        if symbol in text.upper():
            add(symbol)

    for symbol in extra or []:
        add(symbol)
    return found


def build_snapshot(
    symbols: Sequence[str], price_lookup, cached: Optional[Mapping[str, float]] = None
) -> Dict[str, float]:
    """按抽出的标的拉现价。任何一个失败都只是少一行快照,不该中断解析。"""
    snapshot: Dict[str, float] = {}
    for symbol in symbols:
        if cached and symbol in cached:
            snapshot[symbol] = float(cached[symbol])
            continue
        try:
            price = price_lookup(symbol)
        except Exception:  # noqa: BLE001 - 行情失败不阻断解析,由 §5.3b 决定是否拒绝
            price = None
        if price:
            snapshot[symbol] = float(price)
    return snapshot
