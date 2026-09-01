"""价位警告(alerts.py)。纯计算 + 状态机,全部离线。

这个模块最容易坏在两头:要么该报的不报,要么一个价位报到刷屏。
所以防抖的用例比触发的用例还多。
"""
from __future__ import annotations

import pytest

from ibkr_agent.alerts import (
    DEFAULT_COOLDOWN, AlertError, AlertLevel, LevelState, build_levels, describe,
    evaluate, level_key, round_levels,
)


def wall(**over):
    base = {
        "days_to_expiry": 0.3,
        "call_wall": {"strike": 45.0}, "put_wall": {"strike": 38.0},
        "call_vol_wall": {"strike": 43.0}, "put_vol_wall": {"strike": 39.0},
        "max_pain": {"strike": 41.0}, "gamma_flip": 40.5,
    }
    base.update(over)
    return base


def run(levels, prices, start_ts=0.0, tick=60.0, **kw):
    """把一串价格喂进状态机,返回所有触发事件。"""
    states, prev, events = {}, None, []
    for i, price in enumerate(prices):
        fired, states = evaluate(levels, states, prev, price, start_ts + i * tick, **kw)
        events += fired
        prev = price
    return events


# ---------------------------------------------------------------- 整数关口
def test_round_levels_bracket_the_spot():
    """IREN 41 块 → 上下最近的 5 整数倍是 40 和 45。"""
    assert round_levels(41.0, 5.0) == [40.0, 45.0]
    assert round_levels(6043.0, 5.0) == [6040.0, 6045.0]


def test_round_levels_skip_the_spot_when_it_sits_exactly_on_one():
    """现价正好是 40 时,40 这个警报会立刻触发,毫无意义 —— 改取上下各一档。"""
    assert round_levels(40.0, 5.0) == [35.0, 45.0]


def test_round_step_is_configurable():
    assert round_levels(207.3, 10.0) == [200.0, 210.0]
    assert round_levels(41.4, 1.0) == [41.0, 42.0]
    # 步长 1 时 41.0 正好落在关口上,走"上下各一档"那条分支
    assert round_levels(41.0, 1.0) == [40.0, 42.0]


# ---------------------------------------------------------------- 价位生成
def test_levels_combine_walls_and_round_numbers():
    levels = build_levels(41.0, wall(), step=5.0)
    prices = [l.price for l in levels]
    assert 45.0 in prices and 38.0 in prices          # 墙
    assert 40.0 in prices                              # 整数关口
    assert prices == sorted(prices)                    # 升序,界面直接画


def test_a_wall_sitting_on_a_round_number_is_reported_once():
    """墙落在整数关口上是常事(它们本来就互相吸引)。
    不合并的话同一个价位会报两次——「报两次」和「报错」在使用上是一回事。"""
    levels = build_levels(41.0, wall(call_wall={"strike": 45.0}), step=5.0)
    at_45 = [l for l in levels if abs(l.price - 45.0) < 0.01]
    assert len(at_45) == 1
    assert "持仓墙" in at_45[0].label and "整数关口" in at_45[0].label
    assert at_45[0].source == "call_wall"              # 价位以墙为准,不是关口


def test_levels_without_a_wall_still_give_the_round_numbers():
    """还没算出期权墙(没连 TWS / 没有链)时,整数关口照样能用。"""
    prices = [l.price for l in build_levels(41.0, None, step=5.0)]
    assert prices == [40.0, 45.0]


def test_build_levels_needs_a_spot():
    with pytest.raises(AlertError):
        build_levels(0.0, wall())


def test_zero_dte_lets_the_volume_wall_win_a_merge():
    """0DTE 的 OI 是隔夜存量,成交量墙才反映今天的流。

    两种墙贴在一起(43.00 与 43.02)要并成一个时,留谁的价位取决于到期日:
    当天到期留成交墙,其余到期留持仓墙。
    """
    close = wall(call_vol_wall={"strike": 43.0}, call_wall={"strike": 43.02})

    same_day = build_levels(41.0, close | {"days_to_expiry": 0.2}, step=5.0)
    winner = next(l for l in same_day if abs(l.price - 43.0) < 0.2)
    assert winner.source == "call_vol_wall" and winner.price == 43.0

    later = build_levels(41.0, close | {"days_to_expiry": 25.0}, step=5.0)
    winner = next(l for l in later if abs(l.price - 43.0) < 0.2)
    assert winner.source == "call_wall" and winner.price == 43.02
    # 两个来源都指着这个位,标签要都留着
    assert "成交墙" in winner.label and "持仓墙" in winner.label


def test_too_many_levels_are_trimmed_to_the_nearest_ones():
    big = wall(call_wall={"strike": 900.0}, put_wall={"strike": 1.0})
    levels = build_levels(41.0, big, step=0.5, max_levels=4)
    assert len(levels) == 4


# ---------------------------------------------------------------- 触发
def test_crossing_a_level_fires_once():
    levels = [AlertLevel(40.0, "整数关口 40", "round", "pivot")]
    events = run(levels, [41.0, 40.5, 39.8])
    assert len(events) == 1
    assert events[0]["direction"] == "down"
    assert "下破" in events[0]["text"]


def test_the_first_reading_never_fires():
    """一打开页面就把现价附近的价位全报一遍,是最讨人厌的实现。"""
    levels = [AlertLevel(40.0, "整数关口 40", "round", "pivot")]
    assert run(levels, [40.0]) == []


def test_approaching_without_crossing_does_not_fire():
    levels = [AlertLevel(40.0, "整数关口 40", "round", "pivot")]
    assert run(levels, [41.0, 40.3, 40.1, 40.2]) == []


def test_upward_crossing_is_labelled_as_such():
    levels = [AlertLevel(45.0, "上方持仓墙", "call_wall", "resistance")]
    events = run(levels, [43.0, 44.0, 45.6])
    assert len(events) == 1 and events[0]["direction"] == "up"
    assert "上穿" in events[0]["text"]


# ---------------------------------------------------------------- 防抖
def test_oscillating_around_a_level_does_not_spam():
    """价格在 40 附近来回蹭,朴素实现能报几十次。报到第三次人就不看了。"""
    levels = [AlertLevel(40.0, "整数关口 40", "round", "pivot")]
    prices = [41.0] + [39.95, 40.05] * 20
    events = run(levels, prices)
    assert len(events) == 1


def test_it_rearms_after_price_leaves_the_band_and_the_cooldown_passes():
    levels = [AlertLevel(40.0, "整数关口 40", "round", "pivot")]
    # 跌破 → 走远(离开 band)→ 等过冷却 → 再涨回来穿一次
    prices = [41.0, 39.5, 38.0, 39.5, 40.5]
    events = run(levels, prices, tick=DEFAULT_COOLDOWN + 1)
    assert len(events) == 2
    assert [e["direction"] for e in events] == ["down", "up"]


def test_cooldown_blocks_a_second_alert_even_after_price_travels_far():
    """走远了但冷却还没过,仍然不报 —— 冷却是防"band 边缘反复进出"的兜底。"""
    levels = [AlertLevel(40.0, "整数关口 40", "round", "pivot")]
    events = run(levels, [41.0, 39.5, 38.0, 39.5, 40.5], tick=1.0)
    assert len(events) == 1


def test_states_for_removed_levels_are_dropped():
    """价位会随行情重算,老状态留着只会越攒越多。"""
    old = [AlertLevel(40.0, "a", "round", "pivot"), AlertLevel(45.0, "b", "round", "pivot")]
    _, states = evaluate(old, {}, 41.0, 41.2, 0.0)
    assert len(states) == 2
    _, states = evaluate(old[:1], states, 41.2, 41.3, 1.0)
    assert list(states) == [level_key(old[0])]


def test_each_level_keeps_its_own_state():
    """一个价位报过之后落防,不该连累旁边那个。"""
    levels = [AlertLevel(40.0, "四十", "round", "pivot"),
              AlertLevel(45.0, "四五", "round", "pivot")]
    events = run(levels, [41.0, 39.0, 46.0])
    assert {e["price"] for e in events} == {40.0, 45.0}


# ---------------------------------------------------------------- 展示
def test_describe_shows_distance_from_spot():
    lines = describe(build_levels(41.0, None, step=5.0), 41.0)
    assert any("40" in l and "-2.4" in l for l in lines)
