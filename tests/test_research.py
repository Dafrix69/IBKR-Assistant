"""标的情报采集(research.py)。纯计算,离线可测。"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from ibkr_agent.research import brief_text, symbol_brief


def make_bars(closes, start="2025-06-02"):
    day = date.fromisoformat(start)
    bars = []
    for close in closes:
        while day.weekday() >= 5:
            day += timedelta(days=1)
        bars.append({"date": day.isoformat(), "open": close, "high": close * 1.02,
                     "low": close * 0.98, "close": close})
        day += timedelta(days=1)
    return bars


def test_brief_computes_trend_and_position_facts():
    closes = [100.0 + i * 0.5 for i in range(260)]  # 一年稳步上涨
    brief = symbol_brief(make_bars(closes))
    assert brief["last"] == 229.5
    assert brief["chg_1d_pct"] > 0
    assert brief["vs_sma50_pct"] > 0            # 价格在 50 日线上方
    assert brief["vs_sma200_pct"] > 0
    assert brief["from_52w_low_pct"] > 0
    assert -5 < brief["from_52w_high_pct"] <= 0  # 贴着高点
    assert 0 < brief["vol20_annual_pct"] < 50
    assert "rsi14" in brief and "macd_hist" in brief


def test_brief_handles_short_history():
    brief = symbol_brief(make_bars([100.0, 101.0, 99.0]))
    assert brief["last"] == 99.0
    assert "vs_sma200_pct" not in brief   # 数据不足的项省略而不是硬算
    assert symbol_brief(make_bars([100.0])) == {}


def test_anchor_resolves_last_friday_close():
    """"上周五尾盘买入":锚点 = 上周五收盘价,现价对锚点的涨跌由代码算死。"""
    from ibkr_agent.research import resolve_anchor

    # 2026-08-03(周一)起的日线;今天是周二 2026-08-18,上周五 = 08-14
    closes = [70.0 + i for i in range(12)]
    bars = make_bars(closes, start="2026-08-03")
    anchor = resolve_anchor("axti上周五尾盘买入", bars, date(2026, 8, 18))
    assert anchor is not None
    assert anchor["date"] == "2026-08-14"
    assert "上周五" in anchor["label"] and "收盘价" in anchor["label"]
    by_date = {b["date"]: b for b in bars}
    assert anchor["price"] == by_date["2026-08-14"]["close"]
    assert anchor["chg_from_anchor_pct"] == pytest.approx(
        (closes[-1] / by_date["2026-08-14"]["close"] - 1) * 100, abs=0.01
    )


def test_anchor_variants_and_absence():
    from ibkr_agent.research import resolve_anchor

    bars = make_bars([100.0] * 12, start="2026-08-03")
    today = date(2026, 8, 18)
    assert resolve_anchor("昨天收盘买入", bars, today)["date"] == "2026-08-17"
    assert "开盘价" in resolve_anchor("周一开盘追入", bars, today)["label"]
    assert resolve_anchor("看好长期趋势", bars, today) is None   # 没有时间引用不瞎猜


def test_brief_text_states_missing_data_plainly():
    assert "未识别出标的" in brief_text(None, None)
    # 文案按券商中立说:这段会进 LLM 上下文,也会显示在界面上,
    # 让富途用户看到"未连接 TWS"是错的指引
    assert "未连接券商网关" in brief_text("NVDA", None)
    assert "获取 NVDA 行情失败" in brief_text("NVDA", {"error": "超时"})
    text = brief_text("NVDA", {"last": 230.0, "rsi14": 55.0})
    assert "现价 230.0" in text and "RSI(14) 55.0" in text
