"""回测纯计算(backtest.py)。全部离线合成数据,不需要 TWS。"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from ibkr_agent.backtest import (
    Bar, BacktestError, STRATEGIES, _bs_price, _macd_hist, run_backtest,
)


def make_bars(closes, start="2026-01-02"):
    day = date.fromisoformat(start)
    bars = []
    for close in closes:
        # 跳过周末,贴近真实日线
        while day.weekday() >= 5:
            day += timedelta(days=1)
        bars.append(Bar(date=day.isoformat(), open=close, high=close * 1.01,
                        low=close * 0.99, close=close))
        day += timedelta(days=1)
    return bars


def test_buy_hold_matches_price_change():
    bars = make_bars([100, 102, 101, 110, 120])
    result = run_backtest(bars, "buy_hold")
    assert result["total_return_pct"] == pytest.approx(20.0)
    assert result["total_return_pct"] == result["buy_hold_return_pct"]
    assert result["exposure_pct"] == 100.0
    assert result["trades"] == 1 and not result["trade_list"][0]["closed"]


def test_max_drawdown_captures_the_valley():
    bars = make_bars([100, 110, 120, 60, 90])
    result = run_backtest(bars, "buy_hold")
    assert result["max_drawdown_pct"] == pytest.approx(-50.0)


def test_sma_cross_goes_flat_in_downtrend():
    # 前段上涨让快线在慢线上方,后段崩盘应触发下穿离场
    closes = [100 + i for i in range(30)] + [130 - 3 * i for i in range(30)]
    bars = make_bars(closes)
    result = run_backtest(bars, "sma_cross", {"fast": 5, "slow": 20})
    assert result["trades"] >= 1
    # 崩盘段大部分时间应该空仓,策略回撤好于满仓基准
    assert result["max_drawdown_pct"] > result["buy_hold_return_pct"]


def test_sma_params_must_be_ordered():
    bars = make_bars([100] * 60)
    with pytest.raises(BacktestError, match="快线周期必须小于慢线"):
        run_backtest(bars, "sma_cross", {"fast": 50, "slow": 10})


def test_rsi_buys_the_dip_and_sells_the_rip():
    # 横盘后急跌逼低 RSI → 低位建仓;V 型反弹逼高 RSI → 高位离场,首笔应盈利
    closes = [100.0] * 8 + [94.0, 90.0, 86.0] + [90.0 + 4 * i for i in range(12)]
    bars = make_bars(closes)
    result = run_backtest(bars, "rsi", {"period": 5, "buy_below": 30, "sell_above": 70})
    assert result["closed_trades"] >= 1
    first = next(t for t in result["trade_list"] if t["closed"])
    assert first["return_pct"] > 0


def test_breakout_enters_on_new_high():
    closes = [100] * 25 + [101, 105, 110, 118, 126]
    bars = make_bars(closes)
    result = run_backtest(bars, "breakout", {"entry": 20, "exit": 10})
    assert result["trades"] == 1
    assert result["total_return_pct"] > 0


def test_unknown_strategy_and_param_rejected():
    bars = make_bars([100] * 10)
    with pytest.raises(BacktestError, match="未知策略"):
        run_backtest(bars, "martingale")
    with pytest.raises(BacktestError, match="没有参数"):
        run_backtest(bars, "sma_cross", {"leverage": 10})
    with pytest.raises(BacktestError, match="必须是数字"):
        run_backtest(bars, "sma_cross", {"fast": "快"})


def test_too_few_bars_rejected():
    with pytest.raises(BacktestError, match="数据太少"):
        run_backtest(make_bars([100, 101]), "buy_hold")


def test_curve_is_downsampled_and_anchored():
    bars = make_bars(list(range(100, 1100)))
    result = run_backtest(bars, "buy_hold")
    assert len(result["curve"]) <= 301
    assert result["curve"][0]["date"] == bars[0].date
    assert result["curve"][-1]["date"] == bars[-1].date
    assert result["curve"][0]["equity"] == 1.0


def test_strategy_catalog_shape():
    for meta in STRATEGIES.values():
        assert meta["label"] and "params" in meta


# ---- 自定义多条件 --------------------------------------------------------
def _cond(left, op, right):
    return {"left": left, "op": op, "right": right}


def _ind(name, period=None):
    out = {"kind": "indicator", "name": name}
    if period:
        out["period"] = period
    return out


def _const(value):
    return {"kind": "const", "value": value}


def test_custom_rules_replicate_sma_cross():
    closes = [100 + i for i in range(30)] + [130 - 3 * i for i in range(30)]
    bars = make_bars(closes)
    preset = run_backtest(bars, "sma_cross", {"fast": 5, "slow": 20})
    custom = run_backtest(
        bars, "custom",
        rules={
            "entry": [_cond(_ind("sma", 5), ">", _ind("sma", 20))],
            "exit": [_cond(_ind("sma", 5), "<", _ind("sma", 20))],
        },
    )
    assert custom["total_return_pct"] == pytest.approx(preset["total_return_pct"])


def test_custom_multi_condition_is_conjunction():
    # 两个条件:RSI 超卖 且 收盘价高于常数——第二条永不满足,应全程空仓
    bars = make_bars([100.0] * 8 + [94.0, 90.0, 86.0] + [90.0 + 4 * i for i in range(12)])
    result = run_backtest(
        bars, "custom",
        rules={
            "entry": [
                _cond(_ind("rsi", 5), "<", _const(30)),
                _cond(_ind("close"), ">", _const(99999)),
            ],
            "exit": [],
        },
    )
    assert result["trades"] == 0
    assert result["exposure_pct"] == 0.0


def test_custom_cross_up_fires_once_per_crossing():
    closes = [110 - i for i in range(15)] + [96 + 2 * i for i in range(15)]
    bars = make_bars(closes)
    result = run_backtest(
        bars, "custom",
        rules={"entry": [_cond(_ind("close"), "cross_up", _ind("sma", 10))], "exit": []},
    )
    assert result["trades"] == 1
    assert not result["trade_list"][0]["closed"]  # 没有出场条件 → 持有到最后


def test_custom_without_entry_rejected():
    bars = make_bars([100.0] * 20)
    with pytest.raises(BacktestError, match="至少需要一条入场条件"):
        run_backtest(bars, "custom", rules={"entry": []})


# ---- 期权模拟 ------------------------------------------------------------
def test_bs_price_degenerates_to_intrinsic_at_expiry():
    assert _bs_price(110, 100, 0.0, 0.3, "C") == pytest.approx(10.0)
    assert _bs_price(90, 100, 0.0, 0.3, "P") == pytest.approx(10.0)
    assert _bs_price(90, 100, 0.0, 0.3, "C") == 0.0
    # 有时间价值时,期权价高于内在价值
    assert _bs_price(100, 100, 0.25, 0.3, "C") > 0


def test_call_option_profits_when_underlying_rallies():
    closes = [100.0] * 25 + [100.0 + 2 * i for i in range(1, 21)]
    bars = make_bars(closes)
    rules = {"entry": [_cond(_ind("close"), ">", _const(101))], "exit": []}
    stock = run_backtest(bars, "custom", rules=rules)
    option = run_backtest(
        bars, "custom", rules=rules,
        instrument={"type": "call", "dte": 60, "offset_pct": 0, "risk_pct": 10},
    )
    assert option["total_return_pct"] > 0
    # 期权杠杆:10% 投入下的收益仍应可观;正股基准也应为正
    assert stock["total_return_pct"] > 0
    assert option["instrument"]["type"] == "call"


def test_put_option_loses_when_underlying_rallies():
    closes = [100.0] * 25 + [100.0 + 2 * i for i in range(1, 21)]
    bars = make_bars(closes)
    rules = {"entry": [_cond(_ind("close"), ">", _const(101))], "exit": []}
    result = run_backtest(
        bars, "custom", rules=rules,
        instrument={"type": "put", "dte": 60, "offset_pct": 0, "risk_pct": 10},
    )
    assert result["total_return_pct"] < 0
    # 借方结构 + 10% 投入:最差也就亏掉投入部分
    assert result["total_return_pct"] > -10.5


def test_option_rolls_at_expiry_when_signal_persists():
    closes = [100.0] * 25 + [100.0 + 0.2 * i for i in range(1, 41)]
    bars = make_bars(closes)
    rules = {"entry": [_cond(_ind("close"), ">", _const(100.1))], "exit": []}
    result = run_backtest(
        bars, "custom", rules=rules,
        instrument={"type": "call", "dte": 14, "offset_pct": 0, "risk_pct": 5},
    )
    # 40 根日线、DTE 14:到期后信号仍在,应发生续仓 → 多笔交易
    assert result["trades"] >= 2
    assert any(t.get("exit_reason") == "expiry" for t in result["trade_list"])


def test_option_instrument_validation():
    bars = make_bars([100.0] * 30)
    rules = {"entry": [_cond(_ind("close"), ">", _const(0))], "exit": []}
    with pytest.raises(BacktestError, match="到期天数"):
        run_backtest(bars, "custom", rules=rules, instrument={"type": "call", "dte": 0})
    with pytest.raises(BacktestError, match="未知交易品种"):
        run_backtest(bars, "custom", rules=rules, instrument={"type": "warrant"})


def test_macd_hist_flips_sign_across_trend_change():
    # MACD 柱反映的是动能变化:下跌转上涨后为正,上涨转下跌后为负
    up_turn = [150.0 - i for i in range(50)] + [100.0 + 2 * i for i in range(50)]
    assert any(v is not None and v > 0 for v in _macd_hist(up_turn)[55:80])
    down_turn = [100.0 + i for i in range(50)] + [150.0 - 2 * i for i in range(50)]
    assert any(v is not None and v < 0 for v in _macd_hist(down_turn)[55:80])


def test_custom_change_pct_dip_buying():
    closes = [100.0] * 10 + [88.0] + [88.0 + 3 * i for i in range(10)]
    bars = make_bars(closes)
    result = run_backtest(
        bars, "custom",
        rules={"entry": [_cond(_ind("change_pct", 5), "<", _const(-10))], "exit": []},
    )
    assert result["trades"] == 1
    assert result["total_return_pct"] > 0
