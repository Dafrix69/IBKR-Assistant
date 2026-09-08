"""扫描器(screener.py):RS 强度 / CD 背离拐点 / 极值偏离,全部离线。

三个功能都是"数字由代码算",所以测试要卡的是口径:RS 按日期对齐、背离要求
零轴同侧、z 分数按近段历史折——这些口径错了,界面上的数字看着像样但全是错的。
"""
from __future__ import annotations

import math
import random
from datetime import date, timedelta

from ibkr_agent.screener import (
    MIN_CD_BARS, UNTAGGED, cd_divergence, deviation_review, resample_weekly,
    rs_strength, screen_inflections,
)


def daily(closes, start="2026-01-05", volume=1_000_000.0, spread=0.01):
    """把一串收盘价铺成日线(跳过周末)。"""
    day = date.fromisoformat(start)
    bars = []
    for c in closes:
        while day.weekday() >= 5:
            day += timedelta(days=1)
        bars.append({"date": day.isoformat(), "open": c, "high": c * (1 + spread),
                     "low": c * (1 - spread), "close": c, "volume": volume})
        day += timedelta(days=1)
    return bars


def walk(seed, n, start=100.0, drift=0.0, vol=0.01):
    rng = random.Random(seed)
    closes, price = [], start
    for _ in range(n):
        price = max(price * (1 + rng.gauss(drift, vol)), 1.0)
        closes.append(round(price, 4))
    return closes


# ---------------------------------------------------------------- RS 强度
def test_rs_is_relative_return_against_benchmark():
    """股票 30 天涨 20%,基准涨 10% → RS = 1.2/1.1 − 1 ≈ +9.09%。"""
    stock = daily([100.0 * (1 + 0.2 * i / 30) for i in range(31)])
    bench = daily([400.0 * (1 + 0.1 * i / 30) for i in range(31)])
    result = rs_strength([{"symbol": "aaa", "tag": "芯片", "bars": stock}], bench, "SPY", (5, 20))
    row = result["rows"][0]
    assert row["symbol"] == "AAA" and row["rank"] == 1
    assert row["rs"]["20"]["ret_pct"] == round((stock[-1]["close"] / stock[-21]["close"] - 1) * 100, 2)
    r, b = stock[-1]["close"] / stock[-21]["close"], bench[-1]["close"] / bench[-21]["close"]
    assert row["rs"]["20"]["rs_pct"] == round((r / b - 1) * 100, 2)
    assert row["rs"]["20"]["beats"] is True
    assert "60" not in row["rs"]                      # 只有 31 根,60 日区间没有就是没有


def test_rs_aligns_benchmark_by_date_not_index():
    """成员停牌一天:基准仍按日期取值,不能因为下标错位把区间搞错。"""
    closes = [100.0 + i for i in range(30)]
    stock = daily(closes)
    del stock[-3]                                     # 中间少一天
    bench = daily([200.0 + 2 * i for i in range(30)])
    result = rs_strength([{"symbol": "AAA", "bars": stock}], bench, "SPY", (5,))
    row = result["rows"][0]
    start_date = stock[-6]["date"]
    b0 = next(b["close"] for b in bench if b["date"] == start_date)
    b1 = bench[-1]["close"]
    assert row["rs"]["5"]["bench_pct"] == round((b1 / b0 - 1) * 100, 2)


def test_rs_groups_by_tag_with_median_and_beats():
    bench = daily([100.0] * 40)                       # 基准走平:RS 就等于自身收益
    members = [
        {"symbol": "A", "tag": "芯片", "bars": daily([100.0] * 39 + [110.0])},
        {"symbol": "B", "tag": "芯片", "bars": daily([100.0] * 39 + [90.0])},
        {"symbol": "C", "tag": "芯片", "bars": daily([100.0] * 39 + [104.0])},
        {"symbol": "D", "tag": "", "bars": daily([100.0] * 39 + [101.0])},
        {"symbol": "E", "tag": "光模块", "bars": []},
    ]
    result = rs_strength(members, bench, "QQQ", (5,))
    tags = {t["tag"]: t for t in result["tags"]}
    assert tags["芯片"]["rs"]["5"] == {"median_pct": 4.0, "beats": 2, "total": 3}
    assert tags[UNTAGGED]["count"] == 1
    assert tags["光模块"]["score"] is None            # 没数据的标签不冒充有分
    assert result["tags"][0]["tag"] == "芯片"          # 有分的排前,分高的更前
    assert result["counted"] == 4 and result["total"] == 5
    ranks = [r["rank"] for r in result["rows"]]
    assert ranks == [1, 2, 3, 4, None]
    assert [r["symbol"] for r in result["rows"]][:2] == ["A", "C"]


def test_rs_survives_missing_benchmark():
    result = rs_strength([{"symbol": "A", "bars": daily([1.0] * 30)}], None, "SPY")
    assert result["rows"][0]["rs"] == {} and result["rows"][0]["score"] is None
    assert result["bench_bars"] == 0


# ---------------------------------------------------------------- 周线
def test_weekly_resample_uses_monday_weeks():
    closes = [float(i + 1) for i in range(12)]        # 2026-01-05 周一起,12 个交易日 = 2 周 + 2 天
    weeks = resample_weekly(daily(closes))
    assert len(weeks) == 3
    assert weeks[0]["time"] == "2026-01-09" and weeks[0]["open"] == 1.0 and weeks[0]["close"] == 5.0
    assert weeks[0]["high"] == 5.0 * 1.01 and weeks[0]["low"] == 1.0 * 0.99
    assert weeks[0]["volume"] == 5_000_000.0
    assert weeks[2]["time"] == "2026-01-20" and weeks[2]["close"] == 12.0


# ---------------------------------------------------------------- CD 背离
def v_shape(seed, first_low=90.0, second_low=89.0, slow=25):
    """急跌到第一个低点、反弹、再慢慢磨到第二个低点:动能衰减,DIF 抬高。

    second_low 比 first_low 低不多 → 底背离;低得多(慢磨也磨成了大跌)→ DIF 一起创新低,不算。
    """
    closes = [100.0] * 30
    closes += [100.0 - (100.0 - first_low) * i / 5 for i in range(1, 6)]          # 5 根急跌
    closes += [first_low + (98.0 - first_low) * i / 10 for i in range(1, 11)]      # 10 根反弹到 98
    closes += [98.0 - (98.0 - second_low) * i / slow for i in range(1, slow + 1)]  # 慢慢磨到第二低点
    closes += [second_low + 0.8, second_low + 1.5, second_low + 2.2]
    rng = random.Random(seed)
    return [round(c + rng.uniform(-0.03, 0.03), 4) for c in closes]


def test_bull_divergence_needs_lower_low_with_higher_dif():
    """第二个低点更低、但 DIF 抬高 → 底背离;两个低点都在零轴下。"""
    bars = daily(v_shape(1))
    result = cd_divergence(bars)
    assert result["signal"] == "bull" and result["label"] == "底背离"
    p1, p2 = result["pivots"]
    assert p2["price"] < p1["price"] and p2["dif"] > p1["dif"]
    assert p1["dif"] < 0 and p2["dif"] < 0
    assert result["price_gap_pct"] < 0 and result["dif_gap"] > 0
    assert result["confirm"] is None                  # 没要求右侧确认


def test_no_divergence_when_dif_also_makes_lower_low():
    """第二波跌得更凶(DIF 也更低)→ 只是趋势延续,不是背离。"""
    bars = daily(v_shape(3, 90.0, 86.0))
    result = cd_divergence(bars)
    assert result["signal"] is None
    assert "没有新的背离" in result["reason"]


def test_bear_divergence_is_mirror_image():
    closes = [200.0 - (c - 100.0) for c in v_shape(3)]
    result = cd_divergence(daily(closes))
    assert result["signal"] == "bear" and result["label"] == "顶背离"
    p1, p2 = result["pivots"]
    assert p2["price"] > p1["price"] and p2["dif"] < p1["dif"] and p1["dif"] > 0


def test_stale_divergence_is_dropped():
    """第二个低点之后又走了很久:信号陈旧,不再报。"""
    closes = v_shape(4) + [100.0] * 20
    assert cd_divergence(daily(closes))["signal"] is None
    assert cd_divergence(daily(closes), max_age=40)["signal"] == "bull"


def test_right_side_ma_confirmation_states():
    base = v_shape(5)
    waiting = cd_divergence(daily(base), ma_period=30)
    assert waiting["signal"] == "bull" and waiting["confirm"]["status"] == "waiting"
    assert waiting["confirm"]["ma"] == 30 and waiting["confirm"]["at"] is None

    confirmed = cd_divergence(daily(base + [99.0, 101.0, 103.0]), ma_period=30, max_age=20)
    assert confirmed["confirm"]["status"] == "confirmed"
    assert confirmed["confirm"]["age"] is not None and confirmed["confirm"]["at"]

    failed = cd_divergence(daily(base + [99.0, 101.0, 103.0, 88.0]), ma_period=30, max_age=20)
    assert failed["confirm"]["status"] == "failed"


def test_too_few_bars_explains_itself():
    result = cd_divergence(daily([100.0] * (MIN_CD_BARS - 1)))
    assert result["signal"] is None and "不足" in result["reason"]
    assert result["bars"] == MIN_CD_BARS - 1


def test_screen_inflections_ranks_hits_and_counts_per_timeframe():
    bull = daily(v_shape(6))
    flat = daily([100.0] * 60)
    members = [
        {"symbol": "flat", "tag": "芯片", "frames": {"1d": flat, "1w": flat}},
        {"symbol": "hit", "tag": "芯片", "frames": {"1d": bull, "1w": flat}},
        {"symbol": "broken", "tag": "", "frames": {}, "errors": {"1d": "额度用完", "1w": ""}},
    ]
    result = screen_inflections(members, ["1d", "1w"], ma_period=None)
    assert [r["symbol"] for r in result["rows"]] == ["HIT", "BROKEN", "FLAT"]
    assert result["rows"][0]["hits"] == 1
    assert result["rows"][1]["signals"]["1d"] == {"error": "额度用完"}
    assert result["rows"][1]["signals"]["1w"]["signal"] is None   # 空错误串不算错误,照常算
    assert result["rows"][1]["tag"] == UNTAGGED
    assert result["per_timeframe"] == {"1d": {"bull": 1, "bear": 0, "confirmed": 0},
                                       "1w": {"bull": 0, "bear": 0, "confirmed": 0}}
    assert result["hit_count"] == 1 and result["total"] == 3 and result["ma_period"] is None


# ---------------------------------------------------------------- 极值偏离
def test_pressure_uses_true_range_and_volume_weight():
    """跳空高开后收在当根最低:按真实区间算是"从前收盘冲高回落",卖压该是负的。"""
    bars = daily([100.0] * 30, volume=1_000_000.0)
    bars.append({"date": "2026-03-02", "open": 110.0, "high": 112.0, "low": 108.0,
                 "close": 108.0, "volume": 3_000_000.0})
    result = deviation_review(bars, period=5, lookback=20, smooth=1)
    last = result["last"]
    # 真实区间 [100, 112],收 108 → 位置 (8/12)*2-1 = 0.333;对前 20 根均量放量 3 倍,加权 → 1.0
    assert last["buy_pct"] == round(8 / 12 * 100, 1)
    assert last["volume_ratio"] == 3.0
    assert last["pressure"] == round((8 / 12 * 2 - 1) * 3.0, 3)
    assert last["dev_pct"] == round((108.0 / ((100.0 * 4 + 108.0) / 5) - 1) * 100, 2)


def test_extreme_flags_follow_z_score():
    closes = walk(9, 200, vol=0.01)
    spike = closes + [closes[-1] * 1.25]              # 突然拉 25%:相对 1% 日波动是极值
    up = deviation_review(daily(spike), period=20, lookback=120)
    assert up["extreme"] == "overbought" and up["last"]["z"] >= 2.0
    assert "上方极值" in up["extreme_label"]
    assert any("上方极值" in line for line in up["readout"])

    crash = closes + [closes[-1] * 0.75]
    down = deviation_review(daily(crash), period=20, lookback=120)
    assert down["extreme"] == "oversold"

    calm = deviation_review(daily(closes), period=20, lookback=120)
    assert calm["extreme"] is None and calm["extreme_label"] == "偏离在常态区间"
    assert len(calm["series"]) == 120                 # 默认只回最后 120 根
    assert calm["window"]["dev_max"]["dev_pct"] >= calm["window"]["dev_min"]["dev_pct"]


def test_deviation_needs_enough_bars():
    result = deviation_review(daily([100.0] * 10), period=20)
    assert result["series"] == [] and result["last"] is None
    assert "不足" in result["readout"][0]


def test_deviation_skips_broken_bars():
    bars = daily([100.0] * 40)
    bars[5]["close"] = None
    bars[6]["high"] = -1
    result = deviation_review(bars, period=5, lookback=20)
    assert result["bars"] == 38
