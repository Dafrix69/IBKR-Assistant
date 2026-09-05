"""价格行为分析(priceaction.py)。全部离线合成数据,不需要 TWS。

重点不是"能算出结果",而是**该拒绝的时候拒绝、该分清的时候分清**:
影线穿透不能算突破、回补完的缺口不能还挂着、震荡里不能报出趋势。
这类模块最容易骗人的地方就是把噪音说成信号,所以反例比正例多。
"""
from __future__ import annotations

import json

import pytest

from ibkr_agent.broker import bar_timestamp
from ibkr_agent.priceaction import (
    MIN_BARS, PriceActionError, analyze, atr, bias_of, break_events, cluster_levels,
    detect_patterns, facts_text, find_fvgs, find_swings, find_sweeps, label_swings,
    read_trend, to_bars, zigzag,
)


def bars_from(closes, start_minute=570, day="2026-08-17"):
    """按收盘价序列造 K 线:上一根的收盘当这一根的开盘,影线固定 0.4。"""
    rows = []
    for i, close in enumerate(closes):
        open_ = closes[i - 1] if i else close
        minute = start_minute + i * 5
        rows.append(
            {
                "time": "%s %02d:%02d" % (day, minute // 60, minute % 60),
                "open": round(open_, 2),
                "high": round(max(open_, close) + 0.4, 2),
                "low": round(min(open_, close) - 0.4, 2),
                "close": round(close, 2),
                "volume": 1000.0,
            }
        )
    return rows


def wave(points, steps=10):
    """把几个转折价连成折线,得到一段有明确摆动结构的行情。"""
    closes = []
    for a, b in zip(points, points[1:]):
        for k in range(steps):
            closes.append(a + (b - a) * (k + 1) / steps)
    return [round(c, 2) for c in closes]


UPTREND = [100, 108, 104, 116, 110, 124, 118, 132]
DOWNTREND = [132, 124, 128, 116, 120, 108, 112, 100]
RANGE = [100, 110, 100, 110, 100, 110, 100, 110]


# ---------------------------------------------------------------- 结构
def test_swings_alternate_and_get_labelled():
    points = label_swings(zigzag(find_swings(to_bars(bars_from(wave(UPTREND))))))
    assert len(points) >= 4
    # 整理后必须严格高低交替,不允许出现两个相邻同向的点
    assert all(a.kind != b.kind for a, b in zip(points, points[1:]))
    # 一路抬高的行情里不该出现降低的标签(前两个点没有参照,标 H / L)
    labels = {s.label for s in points}
    assert "LH" not in labels and "LL" not in labels


def test_trend_reads_up_down_and_range():
    def trend_of(points):
        return read_trend(label_swings(zigzag(find_swings(to_bars(bars_from(wave(points)))))))["trend"]

    assert trend_of(UPTREND) == "up"
    assert trend_of(DOWNTREND) == "down"
    assert trend_of(RANGE) == "range"


def test_flat_series_has_no_swings():
    """全平的行情不该凭空生出摆动点——这是最容易漏的一类假信号。"""
    assert find_swings(to_bars(bars_from([100.0] * 40))) == []


def test_bos_continues_the_trend_and_the_first_reversal_is_a_choch():
    """上升途中每次上破都是延续(BOS);第一次下破才是性质改变(CHoCH)。"""
    bars = to_bars(bars_from(wave(UPTREND) + wave([132, 96])))
    points = label_swings(zigzag(find_swings(bars)))
    events = break_events(bars, points)
    ups = [e for e in events if e["direction"] == "up"]
    downs = [e for e in events if e["direction"] == "down"]
    assert ups and all(e["kind"] == "BOS" for e in ups)
    assert downs and downs[0]["kind"] == "CHoCH"


def test_break_needs_a_close_not_just_a_wick():
    """影线刺穿前高但收盘收回来 —— 不算突破,只算扫单。"""
    closes = wave([100, 112, 106])
    rows = bars_from(closes)
    peak = max(r["high"] for r in rows)
    # 追加一根:最高价远超前高,收盘却低于前高
    last = dict(rows[-1])
    last["time"] = "2026-08-17 15:55"
    last["open"] = rows[-1]["close"]
    last["high"] = peak + 3.0
    last["low"] = rows[-1]["close"] - 0.4
    last["close"] = rows[-1]["close"]
    rows.append(last)

    bars = to_bars(rows)
    points = label_swings(zigzag(find_swings(bars)))
    up_breaks = [e for e in break_events(bars, points) if e["index"] == len(bars) - 1]
    assert up_breaks == []

    sweeps = find_sweeps(bars, points, tol=atr(bars) * 0.35)
    assert sweeps and sweeps[-1]["direction"] == "bear"


# ---------------------------------------------------------------- 关键位
def test_levels_cluster_and_count_touches():
    bars = to_bars(bars_from(wave(RANGE)))
    points = label_swings(zigzag(find_swings(bars)))
    last = bars[-1].close
    levels = cluster_levels(bars, points, tol=atr(bars) * 0.35, last=last)
    assert levels
    for level in levels:
        assert level["touches"] >= 1
        assert level["side"] == ("resistance" if level["price"] > last else "support")
    # 区间行情反复试探同两个价位,至少有一条被摆动点多次确认
    assert max(l["swings"] for l in levels) >= 2


def test_filled_gaps_are_dropped():
    """跳空之后又被完全走回来的缺口,不该继续挂在图上。"""
    up = bars_from([100, 100.2, 100.1])
    up.append({"time": "2026-08-17 09:45", "open": 106.0, "high": 106.5,
               "low": 105.5, "close": 106.0, "volume": 1000.0})     # 向上跳空
    tail = bars_from([106, 104, 102, 99, 98], start_minute=600)      # 一路走回来填掉
    bars = to_bars(up + tail)
    # 一路向下走回来,那个向上的缺口必须消失(向下的新缺口是另一回事)
    assert [g for g in find_fvgs(bars, tol=0.05) if g["side"] == "bull"] == []


def test_unfilled_gap_survives_with_its_bounds():
    rows = bars_from([100, 100.2, 100.1])
    rows.append({"time": "2026-08-17 09:45", "open": 106.0, "high": 106.5,
                 "low": 105.5, "close": 106.2, "volume": 1000.0})
    rows += bars_from([106.3, 106.5, 107, 108], start_minute=600)
    gaps = find_fvgs(to_bars(rows), tol=0.05)
    assert gaps and gaps[-1]["side"] == "bull"
    assert gaps[-1]["bottom"] < gaps[-1]["top"]
    assert gaps[-1]["filled_pct"] < 90


# ---------------------------------------------------------------- 形态
def test_engulfing_and_inside_bar_are_detected():
    rows = [
        {"time": "2026-08-17 09:30", "open": 100, "high": 101, "low": 99, "close": 99.2, "volume": 1},
        {"time": "2026-08-17 09:35", "open": 99.0, "high": 101.5, "low": 98.8, "close": 101.2, "volume": 1},
        {"time": "2026-08-17 09:40", "open": 100.2, "high": 100.8, "low": 99.5, "close": 100.4, "volume": 1},
    ]
    names = {p["name"] for p in detect_patterns(to_bars(rows), atr_value=1.0)}
    assert "看涨吞没" in names
    assert "内包(inside bar)" in names


def test_hammer_needs_a_long_lower_wick():
    rows = [
        {"time": "2026-08-17 09:30", "open": 100, "high": 100.5, "low": 99.5, "close": 100, "volume": 1},
        {"time": "2026-08-17 09:35", "open": 100, "high": 100.3, "low": 96.0, "close": 100.1, "volume": 1},
    ]
    names = {p["name"] for p in detect_patterns(to_bars(rows), atr_value=1.0)}
    assert "长下影(锤子)" in names
    assert "长上影(射击之星)" not in names


def test_atr_tracks_the_true_range():
    rows = bars_from([100] * 20)
    # 每根的真实波幅固定 0.8(high/low 各偏 0.4),ATR 应当收敛到 0.8
    assert atr(to_bars(rows)) == pytest.approx(0.8, abs=0.01)


# ---------------------------------------------------------------- 总装
def test_analyze_refuses_when_there_are_too_few_bars():
    with pytest.raises(PriceActionError) as exc:
        analyze(bars_from([100 + i for i in range(MIN_BARS - 1)]), "TEST", "5m")
    assert "不足以读出结构" in str(exc.value)


def test_analyze_is_bullish_on_an_uptrend_and_bearish_on_a_downtrend():
    up = analyze(bars_from(wave(UPTREND)), "UP", "5m")
    down = analyze(bars_from(wave(DOWNTREND)), "DOWN", "5m")
    assert up["bias"] in ("bullish", "lean_bull") and up["score"] > 0
    assert down["bias"] in ("bearish", "lean_bear") and down["score"] < 0
    # 结论方向必须和证据的加权和一致,不能是另一套逻辑
    assert round(sum(e["weight"] for e in up["evidence"]), 1) == up["score"]


def test_extended_hours_carries_its_own_caveat():
    """全时段是默认,但盘前盘后成交稀薄会压小 ATR —— 这一点必须写在脸上。"""
    rows = bars_from(wave(UPTREND))
    full = analyze(rows, "X", "5m", extended_hours=True)
    rth_only = analyze(rows, "X", "5m", extended_hours=False)
    assert full["extended_hours"] is True
    assert any("盘前盘后" in w for w in full["warnings"])
    assert not any("盘前盘后" in w for w in rth_only["warnings"])
    # 警告之外,两者的结论必须完全一致:这个开关不该悄悄改变判断
    assert full["score"] == rth_only["score"]


def test_range_market_is_not_reported_as_a_trend():
    result = analyze(bars_from(wave(RANGE)), "RANGE", "5m")
    assert result["trend"] == "range"
    assert any("震荡" in w for w in result["warnings"])


def test_invalidation_points_at_the_last_swing_against_the_bias():
    result = analyze(bars_from(wave(UPTREND)), "UP", "5m")
    lows = [s for s in result["swings"] if s["kind"] == "low"]
    assert result["plan"]["invalidation"]["price"] == lows[-1]["price"]


def test_result_is_json_serialisable_and_carries_chart_bars():
    result = analyze(bars_from(wave(UPTREND)), "UP", "5m")
    assert json.loads(json.dumps(result, ensure_ascii=False))["symbol"] == "UP"
    assert result["bars"] and set(result["bars"][0]) == {"time", "open", "high", "low", "close", "volume"}


def test_bias_thresholds_are_symmetric():
    assert bias_of(60)["bias"] == "bullish" and bias_of(-60)["bias"] == "bearish"
    assert bias_of(20)["bias"] == "lean_bull" and bias_of(-20)["bias"] == "lean_bear"
    assert bias_of(0)["bias"] == "neutral"


def test_facts_text_gives_the_model_conclusions_not_raw_candles():
    """送进模型的必须是算好的事实。给它原始 OHLC 它就会自己"看图",而那没人能复核。"""
    result = analyze(bars_from(wave(UPTREND)), "UP", "5m")
    facts = facts_text(result)
    assert "软件判定" in facts and "结构" in facts
    assert "不要新造价格" in facts
    # 图用的那 140 根 K 线不该出现在提示词里
    assert facts.count("open") == 0 and len(facts) < 4000


# ---------------------------------------------------------------- 时间戳
def test_bar_timestamp_normalises_every_shape_ibkr_returns():
    from datetime import date, datetime

    assert bar_timestamp(datetime(2026, 8, 19, 9, 35)) == "2026-08-19 09:35"
    assert bar_timestamp(date(2026, 8, 19)) == "2026-08-19"
    assert bar_timestamp("20260819  09:35:00") == "2026-08-19 09:35"
    assert bar_timestamp("20260819") == "2026-08-19"
    assert bar_timestamp("看不懂的东西") == "看不懂的东西"   # 解析不了就原样透出,不编


def test_bar_timestamp_converts_exchange_timezone_to_eastern():
    """ib_insync 给的是交易所时区的 aware datetime(SPX 在 Cboe → 美中)。
    直接 strftime 会让 K 线"永远落后一小时",新鲜度告警误报——实测踩到的。"""
    from datetime import datetime, timezone, timedelta
    from zoneinfo import ZoneInfo

    central = datetime(2026, 9, 2, 11, 40, tzinfo=ZoneInfo("US/Central"))
    assert bar_timestamp(central) == "2026-09-02 12:40"
    assert bar_timestamp(datetime(2026, 9, 2, 16, 40, tzinfo=timezone.utc)) == "2026-09-02 12:40"
    assert bar_timestamp(datetime(2026, 9, 2, 11, 40, tzinfo=timezone(timedelta(hours=-5)))) == "2026-09-02 12:40"
    # 带时区名的原始字符串同样换算;没带时区的照旧当美东
    assert bar_timestamp("20260902 11:40:00 US/Central") == "2026-09-02 12:40"
    assert bar_timestamp("20260902 12:40:00 US/Eastern") == "2026-09-02 12:40"
    assert bar_timestamp("20260902 11:40:00") == "2026-09-02 11:40"
