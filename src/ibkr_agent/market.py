"""行情快照的标的抽取(设计文档 §3 的"轻量正则预处理")。

作用只有一个:在调用解析引擎**之前**,先从指令里猜出可能被提到的标的,
把它们的现价拼进用户消息,好让模型判断触发方向(铁律 7a),也让 §5.3b 的
方向复核有据可依。这里宁可多抓几个(多拉一个报价没成本),也不要漏掉触发标的。
"""
from __future__ import annotations

import re
from typing import Dict, List, Mapping, Optional, Sequence

from .config import Settings

# 不能用 \b:Python 的 \w 含中文,"买入be10股"里 be 紧贴中文/数字时没有词边界,
# \b 版本永远匹配不到。改为裸匹配 + 手工检查两侧不是拉丁字母(排除长英文单词的切片)。
_TICKER_RE = re.compile(r"[A-Za-z]{1,5}")

# 常见英文词,避免把 "buy"/"call" 当成 ticker 去拉报价
_STOPWORDS = {
    "BUY", "SELL", "CALL", "PUT", "LMT", "MKT", "STP", "GTC", "DAY", "USD",
    "AT", "TO", "THE", "AND", "OR", "IF", "ON", "OF", "IN", "FOR", "WITH",
    "LIMIT", "MARKET", "STOP", "SPREAD", "OPEN", "CLOSE", "DTE", "ITM", "OTM",
    "A", "AN", "IS", "BE", "PM", "AM", "ET",
}


def extract_symbols(
    text: str,
    settings: Settings,
    extra: Optional[Sequence[str]] = None,
    default_index: bool = True,
) -> List[str]:
    """抽出指令里出现的候选标的:显式 ticker + 中文别名表命中 + 常驻指数。

    default_index=True 时,什么都抽不到就兜底 SPX——这是给交易指令用的
    (期权组合默认标的是 SPX,方向推断需要现价)。想法/备忘场景必须传 False:
    想法没提标的就是没提,兜底会把不相干的 SPX 行情塞进分析里误导人。
    """
    found: List[str] = []

    def add(symbol: str) -> None:
        symbol = symbol.upper()
        if symbol and symbol not in found:
            found.append(symbol)

    known = set(settings.symbol_aliases.values())
    for m in _TICKER_RE.finditer(text):
        start, end = m.start(), m.end()
        if (start > 0 and _is_latin(text[start - 1])) or (
            end < len(text) and _is_latin(text[end])
        ):
            continue  # 长英文单词的一部分,不是 ticker
        raw = m.group()
        token = raw.upper()
        # 中文语境判定:紧贴中文或数字的拉丁串按 ticker 对待("买入be10股"),
        # 停用词豁免也走这条——BE/ON/ALL 都是真实 ticker,只在纯英文句子里才当单词
        cjk_ctx = _cjk_adjacent(text, start, end)
        if token in _HARD_EXCLUDE:
            continue  # 用户行话/单位(如 '25cm'=翼宽),永远不是 ticker,豁免规则不适用
        if token in _STOPWORDS and not cjk_ctx:
            continue
        if token in settings.index_symbols or token in known:
            add(token)
        elif len(token) >= 2 and (raw.isupper() or cjk_ctx):
            add(token)

    for name, ticker in settings.symbol_aliases.items():
        if name and name in text:
            add(ticker)

    for symbol in settings.index_symbols:
        if symbol in text.upper():
            add(symbol)

    for symbol in extra or []:
        add(symbol)

    # 兜底:什么标的都没抽到时补 SPX——用户偏好里期权组合默认标的是 SPX
    # ('7520的20cm蝴蝶'这类指令通篇没有 ticker),没有现价快照就没法推断看涨看跌。
    if default_index and not found and "SPX" in settings.index_symbols:
        add("SPX")
    return found


# 即使紧贴中文/数字也绝不当 ticker 的记号:'25cm' 是本系统用户的翼宽行话
_HARD_EXCLUDE = {"CM"}


def _is_latin(ch: str) -> bool:
    return ch.isascii() and ch.isalpha()


def _cjk_adjacent(text: str, start: int, end: int) -> bool:
    before = text[start - 1] if start > 0 else ""
    after = text[end] if end < len(text) else ""

    def hit(ch: str) -> bool:
        return bool(ch) and ("一" <= ch <= "鿿" or ch.isdigit())

    return hit(before) or hit(after)


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
