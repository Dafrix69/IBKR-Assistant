"""标的情报采集(想法分析用)。

原则与全项目一致:**数字由代码算,叙事才交给 LLM**。这里从日线算出趋势、
动能、波动率、位置等硬指标,拼成情报块注入分析提示词;模型拿到的是事实,
它负责的只是解读。任何一步失败都不阻断分析,只是少一块情报。
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

from .backtest import _macd_hist, _realized_vol, _rsi, _sma

_WEEKDAY_MAP = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}


def resolve_anchor(
    text: str, bars: List[Dict[str, Any]], today: date
) -> Optional[Dict[str, Any]]:
    """把想法里的相对时间('上周五尾盘''昨天收盘')解析成具体的价格锚点。

    "上周五尾盘买入"指的是上周五收盘那个价位,不是现价——锚点由代码算死,
    模型只负责围绕它评估(等回调到锚点,还是现价追高、已经错过多少)。
    解析不出时间引用就返回 None,绝不瞎猜。
    """
    if not bars:
        return None

    target: Optional[date] = None
    label = ""

    m = re.search(r"上周([一二三四五])", text)
    if m:
        wd = _WEEKDAY_MAP[m.group(1)]
        this_monday = today - timedelta(days=today.weekday())
        target = this_monday - timedelta(days=7) + timedelta(days=wd)
        label = "上周%s" % m.group(1)
    elif re.search(r"(?<!上)(?:本?周)([一二三四五])", text):
        m2 = re.search(r"(?<!上)(?:本?周)([一二三四五])", text)
        wd = _WEEKDAY_MAP[m2.group(1)]
        back = (today.weekday() - wd) % 7
        target = today - timedelta(days=back)
        label = "周%s" % m2.group(1)
    elif "前天" in text:
        target = today - timedelta(days=2)
        label = "前天"
    elif "昨天" in text or "昨日" in text:
        target = today - timedelta(days=1)
        label = "昨天"
    if target is None:
        return None

    bar = None
    for b in bars:                       # bars 升序:取 ≤ 目标日的最后一根
        if date.fromisoformat(b["date"]) <= target:
            bar = b
        else:
            break
    if bar is None:
        return None

    use_open = "开盘" in text
    price = float(bar["open" if use_open else "close"])
    last = float(bars[-1]["close"])
    return {
        "label": "%s(%s)%s" % (label, bar["date"], "开盘价" if use_open else "收盘价"),
        "date": bar["date"],
        "price": round(price, 2),
        "chg_from_anchor_pct": round((last / price - 1.0) * 100.0, 2) if price else None,
    }


def symbol_brief(bars: List[Dict[str, Any]]) -> Dict[str, Any]:
    """从日线(升序 OHLC dict)计算标的情报。数据不足的项直接省略。"""
    closes = [float(b["close"]) for b in bars]
    highs = [float(b["high"]) for b in bars]
    lows = [float(b["low"]) for b in bars]
    if len(closes) < 2:
        return {}

    last = closes[-1]
    out: Dict[str, Any] = {"last": round(last, 2), "bars": len(bars)}

    for n, key in ((1, "chg_1d_pct"), (5, "chg_5d_pct"), (20, "chg_20d_pct"), (60, "chg_60d_pct")):
        if len(closes) > n:
            out[key] = round((last / closes[-1 - n] - 1.0) * 100.0, 2)

    out["vol20_annual_pct"] = round(_realized_vol(closes) * 100.0, 1)

    rsi = _rsi(closes, 14)[-1] if len(closes) > 15 else None
    if rsi is not None:
        out["rsi14"] = round(rsi, 1)

    for window, key in ((50, "vs_sma50_pct"), (200, "vs_sma200_pct")):
        sma = _sma(closes, window)[-1] if len(closes) >= window else None
        if sma:
            out[key] = round((last / sma - 1.0) * 100.0, 2)

    macd = _macd_hist(closes)[-1] if len(closes) > 40 else None
    if macd is not None:
        out["macd_hist"] = round(macd, 3)

    lookback = min(len(bars), 252)
    hi, lo = max(highs[-lookback:]), min(lows[-lookback:])
    if hi:
        out["from_52w_high_pct"] = round((last / hi - 1.0) * 100.0, 2)
    if lo:
        out["from_52w_low_pct"] = round((last / lo - 1.0) * 100.0, 2)
    return out


def brief_text(symbol: Optional[str], brief: Optional[Dict[str, Any]]) -> str:
    """把情报拼成给模型看的中文块。没有数据时明说,让模型别装作看过行情。"""
    if not symbol:
        return "标的行情情报:(想法中未识别出标的,无行情数据)"
    if not brief:
        return "标的行情情报:(未连接券商网关或无法获取 %s 的行情数据)" % symbol
    if brief.get("error"):
        return "标的行情情报:(获取 %s 行情失败:%s)" % (symbol, brief["error"])

    lines = ["标的行情情报(%s,软件按日线计算,最新价可能有 15 分钟延迟):" % symbol]
    label_map = [
        ("last", "现价", ""),
        ("chg_1d_pct", "1日涨跌", "%"),
        ("chg_5d_pct", "5日涨跌", "%"),
        ("chg_20d_pct", "20日涨跌", "%"),
        ("chg_60d_pct", "60日涨跌", "%"),
        ("vol20_annual_pct", "20日已实现波动率(年化)", "%"),
        ("rsi14", "RSI(14)", ""),
        ("vs_sma50_pct", "相对50日均线", "%"),
        ("vs_sma200_pct", "相对200日均线", "%"),
        ("macd_hist", "MACD柱(12/26/9)", ""),
        ("from_52w_high_pct", "距52周最高", "%"),
        ("from_52w_low_pct", "距52周最低", "%"),
    ]
    parts = [
        "%s %s%s" % (label, brief[key], unit) for key, label, unit in label_map if key in brief
    ]
    lines.append(";".join(parts))

    anchor = brief.get("anchor")
    if anchor:
        lines.append(
            "价格锚点(按想法里的时间引用解析):%s = %s;现价较锚点 %+.2f%%。"
            "想法中的买入价指的是这个锚点价位,不是现价——请围绕锚点评估:"
            "按锚点算浮盈浮亏多少、现在追与等回调到锚点各意味着什么。"
            % (anchor["label"], anchor["price"], anchor.get("chg_from_anchor_pct") or 0.0)
        )
    return "\n".join(lines)
