"""策略回测(纯计算,离线可单测)。

刻意保持朴素与透明:日线、收盘出信号、当日收盘价成交、全仓进出、无杠杆、
默认不计交易成本(可设单边成本)。结果只用于研究参考,不接任何下单链路。

已知局限(界面上要说清楚):收盘成交忽略了滑点与开盘跳空;单标的全仓不含
仓位管理;参数是拍脑袋的默认值——回测收益高不代表未来有效,过拟合比亏损
更会骗人。
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, timedelta
from math import erf, log, sqrt
from typing import Any, Dict, List, Optional, Sequence, Tuple


class BacktestError(ValueError):
    pass


@dataclass(frozen=True)
class Bar:
    date: str          # YYYY-MM-DD
    open: float
    high: float
    low: float
    close: float


# 策略目录:label 给界面,params 是默认参数(全部可被用户覆盖),
# param_labels 是参数在界面上的名字——不给的话界面只能显示 fast / buy_below
# 这种内部标识符,用户得自己猜哪个是买入线。参数名是策略定义的一部分,
# 所以和策略写在一起,而不是散到界面里去维护。
STRATEGIES: Dict[str, Dict[str, Any]] = {
    "buy_hold": {
        "label": "买入持有",
        "desc": "第一天买入,一直持有到区间结束。是所有策略的基准。",
        "params": {},
        "param_labels": {},
    },
    "sma_cross": {
        "label": "均线交叉",
        "desc": "快线上穿慢线持有,下穿空仓。",
        "params": {"fast": 10, "slow": 50},
        "param_labels": {"fast": "快线周期(日)", "slow": "慢线周期(日)"},
    },
    "rsi": {
        "label": "RSI 超卖买入",
        "desc": "RSI 跌破买入线建仓,升破卖出线离场。",
        "params": {"period": 14, "buy_below": 30, "sell_above": 70},
        "param_labels": {
            "period": "RSI 周期(日)",
            "buy_below": "跌破这个值买入",
            "sell_above": "升破这个值卖出",
        },
    },
    "breakout": {
        "label": "N 日突破",
        "desc": "收盘创 N 日新高买入,跌破 M 日低点离场(唐奇安通道)。",
        "params": {"entry": 20, "exit": 10},
        "param_labels": {"entry": "入场:创 N 日新高", "exit": "出场:跌破 M 日低点"},
    },
    "custom": {
        "label": "自定义(多条件)",
        "desc": "自己搭条件:全部入场条件同时满足时买入,全部出场条件同时满足时卖出。",
        "params": {},
        "param_labels": {},
    },
}

_MAX_PARAM = 250  # 参数窗口上限,防止把整段行情当 warmup


def run_backtest(
    bars: Sequence[Bar],
    strategy: str,
    params: Optional[Dict[str, Any]] = None,
    rules: Optional[Dict[str, Any]] = None,
    instrument: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if strategy not in STRATEGIES:
        raise BacktestError("未知策略:%s(可选:%s)" % (strategy, "、".join(STRATEGIES)))
    if len(bars) < 5:
        raise BacktestError("区间内只有 %d 根日线,数据太少无法回测" % len(bars))

    if strategy == "custom":
        if not rules or not rules.get("entry"):
            raise BacktestError("自定义策略至少需要一条入场条件")
        positions = _custom_positions(bars, rules)
        used_params: Dict[str, Any] = {}
    else:
        merged = dict(STRATEGIES[strategy]["params"])
        for key, value in (params or {}).items():
            if key not in merged:
                raise BacktestError("策略 %s 没有参数 %s" % (strategy, key))
            try:
                value = float(value)
            except (TypeError, ValueError):
                raise BacktestError("参数 %s 必须是数字" % key)
            if not (0 < value <= _MAX_PARAM if key not in ("buy_below", "sell_above") else 0 < value < 100):
                raise BacktestError("参数 %s 超出合理范围:%s" % (key, value))
            merged[key] = int(value) if key in ("fast", "slow", "period", "entry", "exit") else value
        positions = _positions(bars, strategy, merged)
        used_params = merged

    inst = dict(instrument or {})
    inst.setdefault("type", "stock")
    if inst["type"] == "stock":
        result = _evaluate(bars, positions, strategy, used_params)
    else:
        result = _evaluate_options(bars, positions, strategy, used_params, inst)
    if rules:
        result["rules"] = rules
    result["instrument"] = inst
    return result


# ---------------------------------------------------------------- 信号
def _positions(bars: Sequence[Bar], strategy: str, p: Dict[str, Any]) -> List[int]:
    closes = [b.close for b in bars]
    n = len(bars)

    if strategy == "buy_hold":
        return [1] * n

    if strategy == "sma_cross":
        fast, slow = p["fast"], p["slow"]
        if fast >= slow:
            raise BacktestError("快线周期必须小于慢线周期(当前 %d/%d)" % (fast, slow))
        sma_f, sma_s = _sma(closes, fast), _sma(closes, slow)
        return [
            1 if sma_f[i] is not None and sma_s[i] is not None and sma_f[i] > sma_s[i] else 0
            for i in range(n)
        ]

    if strategy == "rsi":
        rsi = _rsi(closes, p["period"])
        buy_below, sell_above = float(p["buy_below"]), float(p["sell_above"])
        if buy_below >= sell_above:
            raise BacktestError("RSI 买入线必须低于卖出线")
        out, holding = [], False
        for value in rsi:
            if value is None:
                out.append(0)
                continue
            if not holding and value < buy_below:
                holding = True
            elif holding and value > sell_above:
                holding = False
            out.append(1 if holding else 0)
        return out

    # breakout
    entry_n, exit_n = p["entry"], p["exit"]
    out, holding = [], False
    for i, bar in enumerate(bars):
        if i < entry_n:
            out.append(0)
            continue
        if not holding:
            if bar.close > max(b.high for b in bars[i - entry_n:i]):
                holding = True
        else:
            lookback = bars[max(0, i - exit_n):i]
            if lookback and bar.close < min(b.low for b in lookback):
                holding = False
        out.append(1 if holding else 0)
    return out


# ---------------------------------------------------------------- 自定义条件
def _custom_positions(bars: Sequence[Bar], rules: Dict[str, Any]) -> List[int]:
    entry = [_cond_series(bars, c) for c in rules["entry"]]
    exit_ = [_cond_series(bars, c) for c in rules.get("exit") or []]
    out: List[int] = []
    holding = False
    for i in range(len(bars)):
        if not holding and all(c[i] for c in entry):
            holding = True
        elif holding and exit_ and all(c[i] for c in exit_):
            holding = False
        out.append(1 if holding else 0)
    return out


def _cond_series(bars: Sequence[Bar], cond: Dict[str, Any]) -> List[bool]:
    left = _operand_series(bars, cond.get("left") or {})
    right = _operand_series(bars, cond.get("right") or {})
    op = cond.get("op")
    n = len(bars)
    out: List[bool] = []
    for i in range(n):
        l, r = left[i], right[i]
        if l is None or r is None:
            out.append(False)
            continue
        if op == ">":
            out.append(l > r)
        elif op == "<":
            out.append(l < r)
        elif op == ">=":
            out.append(l >= r)
        elif op == "<=":
            out.append(l <= r)
        elif op in ("cross_up", "cross_down"):
            pl, pr = (left[i - 1], right[i - 1]) if i > 0 else (None, None)
            if pl is None or pr is None:
                out.append(False)
            elif op == "cross_up":
                out.append(pl <= pr and l > r)
            else:
                out.append(pl >= pr and l < r)
        else:
            raise BacktestError("未知比较符:%r" % op)
    return out


def _operand_series(bars: Sequence[Bar], operand: Dict[str, Any]) -> List[Optional[float]]:
    n = len(bars)
    if operand.get("kind") == "const":
        try:
            value = float(operand.get("value"))
        except (TypeError, ValueError):
            raise BacktestError("常数操作数缺少数值")
        return [value] * n

    name = operand.get("name")
    period = int(operand.get("period") or 0)
    if name in ("sma", "ema", "rsi", "highest", "lowest", "change_pct"):
        if not (0 < period <= _MAX_PARAM):
            raise BacktestError("指标 %s 的 period 超出范围:%s" % (name, period))

    closes = [b.close for b in bars]
    if name == "close":
        return list(closes)
    if name == "open":
        return [b.open for b in bars]
    if name == "high":
        return [b.high for b in bars]
    if name == "low":
        return [b.low for b in bars]
    if name == "sma":
        return _sma(closes, period)
    if name == "ema":
        return _ema(closes, period)
    if name == "rsi":
        return _rsi(closes, period)
    if name == "highest":   # 前 N 日最高(不含当日,突破判断的惯例)
        return [
            max(b.high for b in bars[i - period:i]) if i >= period else None for i in range(n)
        ]
    if name == "lowest":
        return [
            min(b.low for b in bars[i - period:i]) if i >= period else None for i in range(n)
        ]
    if name == "change_pct":
        return [
            (closes[i] / closes[i - period] - 1.0) * 100.0 if i >= period else None
            for i in range(n)
        ]
    if name == "macd_hist":
        return _macd_hist(closes)
    raise BacktestError("未知指标:%r" % name)


def _macd_hist(closes: List[float]) -> List[Optional[float]]:
    """MACD 柱(12/26/9):>0 即快线在信号线上方;金叉 = 柱 cross_up 0。"""
    n = len(closes)
    e12, e26 = _ema(closes, 12), _ema(closes, 26)
    line = [
        (a - b) if (a is not None and b is not None) else None for a, b in zip(e12, e26)
    ]
    first = next((i for i, v in enumerate(line) if v is not None), None)
    out: List[Optional[float]] = [None] * n
    if first is None:
        return out
    sub = [v for v in line[first:] if v is not None]
    signal = _ema(sub, 9)
    for j, sig in enumerate(signal):
        if sig is not None:
            out[first + j] = sub[j] - sig
    return out


def _ema(values: List[float], window: int) -> List[Optional[float]]:
    out: List[Optional[float]] = [None] * len(values)
    if len(values) < window:
        return out
    alpha = 2.0 / (window + 1.0)
    ema = sum(values[:window]) / window
    out[window - 1] = ema
    for i in range(window, len(values)):
        ema = values[i] * alpha + ema * (1.0 - alpha)
        out[i] = ema
    return out


def _sma(values: List[float], window: int) -> List[Optional[float]]:
    out: List[Optional[float]] = []
    acc = 0.0
    for i, v in enumerate(values):
        acc += v
        if i >= window:
            acc -= values[i - window]
        out.append(acc / window if i >= window - 1 else None)
    return out


def _rsi(closes: List[float], period: int) -> List[Optional[float]]:
    """Wilder 平滑 RSI。前 period 根无值。"""
    out: List[Optional[float]] = [None] * len(closes)
    if len(closes) <= period:
        return out
    gains = losses = 0.0
    for i in range(1, period + 1):
        change = closes[i] - closes[i - 1]
        gains += max(change, 0.0)
        losses += max(-change, 0.0)
    avg_gain, avg_loss = gains / period, losses / period
    out[period] = _rsi_value(avg_gain, avg_loss)
    for i in range(period + 1, len(closes)):
        change = closes[i] - closes[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(change, 0.0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-change, 0.0)) / period
        out[i] = _rsi_value(avg_gain, avg_loss)
    return out


def _rsi_value(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        return 100.0
    return 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)


# ---------------------------------------------------------------- 期权模拟
# 数据约束:已到期期权拿不到历史行情,这里用标的走势 + Black-Scholes 理论价模拟:
# 入场按近 20 日已实现波动率定价(r=0,无偏度),持仓逐日按模型估值,到期按内在
# 价值结算;出场信号触发时按模型价平仓;到期时若信号仍在,次日以新行权价续仓。
# 这是研究级近似——真实期权有隐波溢价、偏度和买卖价差,结果只能看相对优劣。

OPTION_TYPES = {
    "call": "买入看涨",
    "put": "买入看跌",
    "call_spread": "看涨借方价差",
    "put_spread": "看跌借方价差",
    "butterfly": "买入蝴蝶",
}


def _evaluate_options(
    bars: Sequence[Bar], positions: List[int], strategy: str,
    params: Dict[str, Any], inst: Dict[str, Any],
) -> Dict[str, Any]:
    if inst["type"] not in OPTION_TYPES:
        raise BacktestError("未知交易品种:%s" % inst["type"])
    # 注意用 is None 判缺省:0 是非法值,不能被 `or 默认值` 吞掉
    dte = int(inst["dte"]) if inst.get("dte") is not None else 30
    offset_pct = float(inst["offset_pct"]) if inst.get("offset_pct") is not None else 0.0
    width_pct = float(inst["width_pct"]) if inst.get("width_pct") is not None else 2.0
    risk = (float(inst["risk_pct"]) if inst.get("risk_pct") is not None else 10.0) / 100.0
    if not (1 <= dte <= 365):
        raise BacktestError("到期天数 dte 必须在 1~365")
    if not (0 < risk <= 1):
        raise BacktestError("单笔投入占比必须在 0~100%")
    if not (0 < width_pct <= 20) or abs(offset_pct) > 30:
        raise BacktestError("行权价偏移/宽度超出合理范围")

    n = len(bars)
    closes = [b.close for b in bars]
    dates = [_d(b.date) for b in bars]

    cash = 1.0                      # 已结算净值
    equity: List[float] = []
    bench: List[float] = [1.0]
    holding: Optional[Dict[str, Any]] = None
    trades: List[Dict[str, Any]] = []
    held_bars = 0

    def close_position(i: int, proceeds: float, why: str) -> None:
        nonlocal cash, holding
        ret = proceeds / holding["cost"] - 1.0
        cash *= 1.0 + risk * ret
        trades.append({
            "entry_date": bars[holding["entry_i"]].date,
            "exit_date": bars[i].date,
            "entry_price": round(holding["cost"], 4),
            "exit_price": round(proceeds, 4),
            "return_pct": round(ret * 100, 2),
            "closed": True,
            "exit_reason": why,
        })
        holding = None

    def open_position(i: int) -> None:
        nonlocal holding
        s0 = closes[i]
        sigma = _realized_vol(closes[: i + 1])
        legs = _option_legs(inst["type"], s0, offset_pct, width_pct)
        cost = _structure_value(legs, s0, dte / 365.0, sigma)
        if cost <= 0:
            return  # 理论上借方结构恒为正,防御除零
        holding = {
            "entry_i": i, "legs": legs, "cost": cost, "sigma": sigma,
            "expiry": dates[i] + timedelta(days=dte),
        }

    for i in range(n):
        if i > 0:
            bench.append(bench[-1] * closes[i] / closes[i - 1])

        if holding is not None:
            expired = dates[i] >= holding["expiry"]
            t_left = max((holding["expiry"] - dates[i]).days, 0) / 365.0
            if expired:
                close_position(i, _structure_value(holding["legs"], closes[i], 0.0, holding["sigma"]), "expiry")
                if positions[i] == 1:
                    open_position(i)   # 信号仍在 → 以新行权价续仓
            elif positions[i] == 0:
                close_position(i, _structure_value(holding["legs"], closes[i], t_left, holding["sigma"]), "signal")
        if holding is None and positions[i] == 1:
            open_position(i)

        if holding is not None:
            held_bars += 1
            t_left = max((holding["expiry"] - dates[i]).days, 0) / 365.0
            value = _structure_value(holding["legs"], closes[i], t_left, holding["sigma"])
            equity.append(cash * (1.0 + risk * (value / holding["cost"] - 1.0)))
        else:
            equity.append(cash)

    if holding is not None:
        t_left = max((holding["expiry"] - dates[-1]).days, 0) / 365.0
        value = _structure_value(holding["legs"], closes[-1], t_left, holding["sigma"])
        trades.append({
            "entry_date": bars[holding["entry_i"]].date,
            "exit_date": None,
            "entry_price": round(holding["cost"], 4),
            "exit_price": round(value, 4),
            "return_pct": round((value / holding["cost"] - 1.0) * 100, 2),
            "closed": False,
            "exit_reason": "open",
        })

    closed = [t for t in trades if t["closed"]]
    wins = [t for t in trades if t["return_pct"] > 0]
    days = max((dates[-1] - dates[0]).days, 1)
    final = equity[-1]

    return {
        "strategy": strategy,
        "params": params,
        "bars": n,
        "start": bars[0].date,
        "end": bars[-1].date,
        "total_return_pct": round((final - 1.0) * 100, 2),
        "buy_hold_return_pct": round((bench[-1] - 1.0) * 100, 2),
        "annualized_pct": round((final ** (365.0 / days) - 1.0) * 100, 2) if final > 0 else -100.0,
        "max_drawdown_pct": round(_max_drawdown(equity) * 100, 2),
        "trades": len(trades),
        "closed_trades": len(closed),
        "win_rate_pct": round(len(wins) / len(trades) * 100, 1) if trades else None,
        "exposure_pct": round(held_bars / n * 100, 1),
        "trade_list": trades[-100:],
        "curve": _sample_curve(bars, equity, bench),
    }


def _option_legs(
    inst_type: str, s0: float, offset_pct: float, width_pct: float
) -> List[Tuple[int, str, float]]:
    k = s0 * (1.0 + offset_pct / 100.0)
    w = s0 * width_pct / 100.0
    if inst_type == "call":
        return [(1, "C", k)]
    if inst_type == "put":
        return [(1, "P", k)]
    if inst_type == "call_spread":
        return [(1, "C", k), (-1, "C", k + w)]
    if inst_type == "put_spread":
        return [(1, "P", k), (-1, "P", k - w)]
    return [(1, "C", k - w), (-2, "C", k), (1, "C", k + w)]  # butterfly


def _structure_value(legs: List[Tuple[int, str, float]], s: float, t: float, sigma: float) -> float:
    return sum(ratio * _bs_price(s, strike, t, sigma, right) for ratio, right, strike in legs)


def _bs_price(s: float, k: float, t: float, sigma: float, right: str) -> float:
    """Black-Scholes(r=0,无股息)。t<=0 时退化为内在价值。"""
    if t <= 0 or sigma <= 0:
        return max(s - k, 0.0) if right == "C" else max(k - s, 0.0)
    d1 = (log(s / k) + 0.5 * sigma * sigma * t) / (sigma * sqrt(t))
    d2 = d1 - sigma * sqrt(t)
    cdf = lambda x: 0.5 * (1.0 + erf(x / sqrt(2.0)))  # noqa: E731
    if right == "C":
        return s * cdf(d1) - k * cdf(d2)
    return k * cdf(-d2) - s * cdf(-d1)


def _realized_vol(closes: Sequence[float], window: int = 20) -> float:
    """近 window 日已实现波动率(年化),数据不足给保守默认值。"""
    tail = list(closes[-(window + 1):])
    if len(tail) < 6:
        return 0.25
    rets = [log(tail[i] / tail[i - 1]) for i in range(1, len(tail)) if tail[i - 1] > 0]
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / max(len(rets) - 1, 1)
    return min(max(sqrt(var * 252.0), 0.05), 2.0)


# ---------------------------------------------------------------- 结算
def _evaluate(
    bars: Sequence[Bar], positions: List[int], strategy: str, params: Dict[str, Any]
) -> Dict[str, Any]:
    n = len(bars)
    equity = [1.0]
    bench = [1.0]
    for i in range(1, n):
        ret = bars[i].close / bars[i - 1].close
        equity.append(equity[-1] * (ret if positions[i - 1] == 1 else 1.0))
        bench.append(bench[-1] * ret)

    trades: List[Dict[str, Any]] = []
    entry_idx: Optional[int] = None
    for i in range(n):
        if positions[i] == 1 and entry_idx is None:
            entry_idx = i
        elif positions[i] == 0 and entry_idx is not None:
            trades.append(_trade(bars, entry_idx, i, closed=True))
            entry_idx = None
    if entry_idx is not None:
        trades.append(_trade(bars, entry_idx, n - 1, closed=False))

    closed = [t for t in trades if t["closed"]]
    wins = [t for t in trades if t["return_pct"] > 0]

    days = max((_d(bars[-1].date) - _d(bars[0].date)).days, 1)
    total = equity[-1] - 1.0
    annualized = (equity[-1] ** (365.0 / days) - 1.0) if equity[-1] > 0 else -1.0

    return {
        "strategy": strategy,
        "params": params,
        "bars": n,
        "start": bars[0].date,
        "end": bars[-1].date,
        "total_return_pct": round(total * 100, 2),
        "buy_hold_return_pct": round((bench[-1] - 1.0) * 100, 2),
        "annualized_pct": round(annualized * 100, 2),
        "max_drawdown_pct": round(_max_drawdown(equity) * 100, 2),
        "trades": len(trades),
        "closed_trades": len(closed),
        "win_rate_pct": round(len(wins) / len(trades) * 100, 1) if trades else None,
        "exposure_pct": round(sum(positions) / n * 100, 1),
        "trade_list": trades[-100:],
        "curve": _sample_curve(bars, equity, bench),
    }


def _trade(bars: Sequence[Bar], entry: int, exit_: int, closed: bool) -> Dict[str, Any]:
    entry_px, exit_px = bars[entry].close, bars[exit_].close
    return {
        "entry_date": bars[entry].date,
        "exit_date": bars[exit_].date if closed else None,
        "entry_price": entry_px,
        "exit_price": exit_px,
        "return_pct": round((exit_px / entry_px - 1.0) * 100, 2),
        "closed": closed,
    }


def _max_drawdown(equity: List[float]) -> float:
    peak, worst = equity[0], 0.0
    for value in equity:
        peak = max(peak, value)
        worst = min(worst, value / peak - 1.0)
    return worst


def _sample_curve(
    bars: Sequence[Bar], equity: List[float], bench: List[float], max_points: int = 300
) -> List[Dict[str, Any]]:
    n = len(bars)
    step = max(1, math.ceil(n / max_points))
    idx = list(range(0, n, step))
    if idx[-1] != n - 1:
        idx.append(n - 1)
    return [
        {"date": bars[i].date, "equity": round(equity[i], 4), "bench": round(bench[i], 4)}
        for i in idx
    ]


def _d(raw: str) -> date:
    return date(int(raw[:4]), int(raw[5:7]), int(raw[8:10]))
