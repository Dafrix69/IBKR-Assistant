"""价位警告 —— 纯计算 + 状态机,离线可单测。

给一个标的挑出**值得盯的价位**,再在价格穿过它们时报一次。价位有三个来源:

  期权墙   当天期权链上持仓/成交最密的行权价、最大痛点、gamma 翻转位。
           这些位置背后有真实的对冲需求,不是画出来的。
  趋势位   日线均线(60/120/200 日)与 52 周高低点。跌到年线、创 52 周新低,
           都是全市场共用的"历史低位"标尺——大量资金把它们当决策触发点,
           所以价格到这儿真的会有反应。
  整数关口 现价上下最近的 5 的整数倍(可调)。这类位置没有基本面理由,
           但挂单确实爱堆在整数上——IREN 41 块,40 就是这么一个位置。

**这个模块最难的不是"设警报",是"不要刷屏"。** 价格在 40 附近来回蹭一分钟,
朴素实现能报几十次,报到第三次人就不看了,警告也就废了。所以每个价位有自己的
状态机:穿过 → 报一次 → **落防(disarmed)** → 价格离开足够远才重新上膛。
再叠一层冷却时间兜底。

只读研究模块:只发通知,不下单、不改仓位。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from math import ceil, floor
from typing import Any, Dict, List, Optional, Sequence, Tuple

DEFAULT_STEP = 5.0        # 整数关口的步长(用户可改)
DEFAULT_MERGE_PCT = 0.15  # 两个价位相距小于现价的这个百分比就并成一个
DEFAULT_BAND_PCT = 0.30   # 落防后要离开价位这么远(占价位的百分比)才重新上膛
DEFAULT_COOLDOWN = 300.0  # 同一个价位两次报警的最小间隔(秒),兜底用
MAX_LEVELS = 24           # 一个标的最多盯这么多价位,再多就是噪音

DEFAULT_MA_PERIODS = (20, 60, 120, 200)  # 日线均线:20/60 是用户天天盯的,120 是季线,200 是全市场盯的
EXTREME_WINDOW = 250                 # 52 周 ≈ 250 个交易日
MIN_EXTREME_BARS = 20                # 历史太短时高低点没意义,干脆不给


class AlertError(ValueError):
    pass


@dataclass(frozen=True)
class AlertLevel:
    price: float
    label: str
    source: str      # call_wall / put_wall / call_vol_wall / put_vol_wall
                     # / max_pain / gamma_flip / round
    kind: str        # resistance / support / pivot
    priority: int = 0   # 合并时谁说了算,越大越可信(见 _wall_levels)

    def as_dict(self) -> Dict[str, Any]:
        return {"price": self.price, "label": self.label,
                "source": self.source, "kind": self.kind}


@dataclass
class LevelState:
    """一个价位的上膛状态。armed=False 表示刚报过,还没离开得够远。"""

    armed: bool = True
    last_fired_at: Optional[float] = None

    def as_dict(self) -> Dict[str, Any]:
        return {"armed": self.armed, "last_fired_at": self.last_fired_at}


# ---------------------------------------------------------------- 价位生成
def round_levels(spot: float, step: float = DEFAULT_STEP) -> List[float]:
    """现价上下最近的整数关口。

    现价正好落在关口上时,那个关口本身没有意义(警报会立刻触发),
    所以改取它上下各一档。
    """
    if spot <= 0 or step <= 0:
        return []
    below = floor(spot / step) * step
    above = ceil(spot / step) * step
    if abs(above - below) < 1e-9:                 # 现价正好在关口上
        return [round(below - step, 6), round(above + step, 6)]
    return [round(below, 6), round(above, 6)]


# 合并优先级。数字只在两个价位靠得太近、要并成一个时起作用:留谁的价、
# 谁的标签排前面。整数关口永远垫底——它没有任何持仓依据。
# 趋势位(均线/52周高低点)与弱墙同级:都是全市场看得见、但不带当天持仓
# 依据的位置。同级贴在一起时按价排序后靠前的赢(合并逻辑保留 previous)。
_PRIORITY_ROUND = 0
_PRIORITY_PIVOT = 1
_PRIORITY_WEAK_WALL = 2
_PRIORITY_TREND = 2
_PRIORITY_STRONG_WALL = 3


def _wall_levels(wall: Optional[Dict[str, Any]]) -> List[AlertLevel]:
    """把期权墙分析折成价位。

    0DTE 时成交量墙比持仓墙可信(OI 是隔夜存量,反映不了当天的流),
    其余到期日反过来。这个差别落在**合并优先级**上:两种墙贴在一起时,
    以更可信的那个的价位为准。
    """
    if not wall:
        return []
    out: List[AlertLevel] = []
    zero_day = (wall.get("days_to_expiry") or 99) <= 1.0
    vol_rank = _PRIORITY_STRONG_WALL if zero_day else _PRIORITY_WEAK_WALL
    oi_rank = _PRIORITY_WEAK_WALL if zero_day else _PRIORITY_STRONG_WALL

    def add(key: str, label: str, rank: int) -> None:
        entry = wall.get(key)
        if entry and entry.get("strike"):
            kind = "resistance" if "call" in key else "support"
            out.append(AlertLevel(float(entry["strike"]), label, key, kind, rank))

    add("call_vol_wall", "上方成交墙", vol_rank)
    add("put_vol_wall", "下方成交墙", vol_rank)
    add("call_wall", "上方持仓墙", oi_rank)
    add("put_wall", "下方持仓墙", oi_rank)

    if wall.get("max_pain"):
        out.append(AlertLevel(float(wall["max_pain"]["strike"]), "最大痛点",
                              "max_pain", "pivot", _PRIORITY_PIVOT))
    if wall.get("gamma_flip") is not None:
        out.append(AlertLevel(float(wall["gamma_flip"]), "Gamma 翻转位",
                              "gamma_flip", "pivot", _PRIORITY_PIVOT))
    return out


def _trend_kind(price: float, spot: float) -> str:
    """价位在现价下方是支撑,上方是阻力,正好贴着算 pivot。"""
    if price < spot:
        return "support"
    if price > spot:
        return "resistance"
    return "pivot"


def _bar_values(bars: Optional[Sequence[Dict[str, Any]]], key: str) -> List[float]:
    """按顺序取一列有效价格。缺了或非正数的整根跳过,不拿别的字段凑。"""
    out: List[float] = []
    for bar in bars or []:
        value = bar.get(key)
        if isinstance(value, (int, float)) and value > 0:
            out.append(float(value))
    return out


def trend_levels(
    bars: Optional[Sequence[Dict[str, Any]]],
    spot: float,
    ma_periods: Sequence[int] = DEFAULT_MA_PERIODS,
    extreme_window: int = EXTREME_WINDOW,
) -> List[AlertLevel]:
    """日线均线 + 52 周高低点 → 价位。bars 为按日期升序的前复权日 K。

    这些位置和期权墙一样"被全市场盯着":跌到年线、创 52 周新低,都是大量
    资金共用的历史低位标尺。均线用收盘价简单平均;高低点用最高/最低价——
    衡量"历史上到过哪儿"要用真实摸到过的价格,不是收盘价。

    数据不够就少给:均线凑不满周期的不算(拿 30 根算"60日均线"是撒谎);
    历史不足 52 周时高低点降级为"上市以来",标签也跟着改——降级可以,
    但不能假装是 52 周。
    """
    if not bars or spot is None or spot <= 0:
        return []
    out: List[AlertLevel] = []

    closes = _bar_values(bars, "close")
    for period in ma_periods:
        if len(closes) < period:
            continue
        ma = round(sum(closes[-period:]) / period, 4)
        if ma <= 0:
            continue
        out.append(AlertLevel(ma, "%d日均线" % period, "ma%d" % period,
                              _trend_kind(ma, spot), _PRIORITY_TREND))

    lows = _bar_values(bars, "low")
    highs = _bar_values(bars, "high")
    if len(lows) >= MIN_EXTREME_BARS and len(highs) >= MIN_EXTREME_BARS:
        full = len(lows) >= extreme_window and len(highs) >= extreme_window
        low = round(min(lows[-extreme_window:]), 4)
        high = round(max(highs[-extreme_window:]), 4)
        out.append(AlertLevel(low, "52周低点" if full else "历史低点", "low_52w",
                              _trend_kind(low, spot), _PRIORITY_TREND))
        out.append(AlertLevel(high, "52周高点" if full else "历史高点", "high_52w",
                              _trend_kind(high, spot), _PRIORITY_TREND))
    return out


def trend_snapshot(
    bars: Optional[Sequence[Dict[str, Any]]],
    spot: float,
    ma_periods: Sequence[int] = DEFAULT_MA_PERIODS,
    extreme_window: int = EXTREME_WINDOW,
) -> Optional[Dict[str, Any]]:
    """给界面看的趋势摘要:各均线值、52 周高低点、现价在一年区间里的位置。

    range_pos_pct 是"历史低位"的量化读数:0 = 贴着 52 周低点,100 = 贴着高点。
    """
    levels = trend_levels(bars, spot, ma_periods, extreme_window)
    if not levels:
        return None
    out: Dict[str, Any] = {level.source: level.price for level in levels}
    low, high = out.get("low_52w"), out.get("high_52w")
    if low is not None and high is not None and high > low:
        out["range_pos_pct"] = round((spot - low) / (high - low) * 100.0, 1)
    out["bars"] = len(_bar_values(bars, "close"))
    return out


def build_levels(
    spot: float,
    wall: Optional[Dict[str, Any]] = None,
    step: float = DEFAULT_STEP,
    merge_pct: float = DEFAULT_MERGE_PCT,
    max_levels: int = MAX_LEVELS,
    history: Optional[Sequence[Dict[str, Any]]] = None,
) -> List[AlertLevel]:
    """期权墙价位 + 趋势位 + 整数关口,去重合并后按价格升序返回。

    合并很重要:墙正好落在整数关口上是常事(它们本来就互相吸引),
    不合并的话同一个价位会报两次——而"报两次"和"报错"在使用上是一回事。
    """
    if spot <= 0:
        raise AlertError("缺少现价,无法生成价位。")

    levels = _wall_levels(wall)
    levels += trend_levels(history, spot)
    levels += [
        AlertLevel(price, "整数关口 %g" % price, "round", "pivot", _PRIORITY_ROUND)
        for price in round_levels(spot, step)
    ]

    tol = abs(spot) * merge_pct / 100.0
    merged: List[AlertLevel] = []
    for level in sorted(levels, key=lambda l: l.price):
        if merged and abs(level.price - merged[-1].price) <= tol:
            previous = merged[-1]
            # 以更可信的那个为准:墙压过整数关口,0DTE 下成交墙压过持仓墙。
            # 标签两个都留着,让人看得见这个位是被几件事同时指着的。
            winner, loser = (
                (previous, level) if previous.priority >= level.priority
                else (level, previous)
            )
            merged[-1] = AlertLevel(
                winner.price,
                "%s + %s" % (winner.label, loser.label),
                winner.source,
                winner.kind if winner.kind != "pivot" else loser.kind,
                winner.priority,
            )
            continue
        merged.append(level)

    # 超出上限时,留离现价最近的那些——远处的位轮不到今天用
    if len(merged) > max_levels:
        merged = sorted(merged, key=lambda l: abs(l.price - spot))[:max_levels]
    return sorted(merged, key=lambda l: l.price)


# ---------------------------------------------------------------- 状态机
def _band(price: float, band_pct: float) -> float:
    return abs(price) * band_pct / 100.0


def evaluate(
    levels: Sequence[AlertLevel],
    states: Dict[str, LevelState],
    prev_price: Optional[float],
    price: float,
    now_ts: float,
    band_pct: float = DEFAULT_BAND_PCT,
    cooldown: float = DEFAULT_COOLDOWN,
) -> Tuple[List[Dict[str, Any]], Dict[str, LevelState]]:
    """价格从 prev_price 走到 price,哪些价位该报警。

    报警条件是**穿过**,不是"接近":两次取价之间跨过了这个价位才算。
    穿过之后立刻落防,直到价格离开 band 之外才重新上膛;再加一层冷却时间,
    防的是价格恰好在 band 边缘反复进出的情况。

    第一次调用(prev_price 为 None)只登记价格,不报警——否则一打开页面
    就会把现价附近的价位全部报一遍。
    """
    events: List[Dict[str, Any]] = []
    out = dict(states)

    for level in levels:
        key = level_key(level)
        state = out.get(key) or LevelState()
        band = _band(level.price, band_pct)

        # 先看能不能重新上膛:离开得够远,而且过了冷却
        if not state.armed and abs(price - level.price) > band:
            cooled = (
                state.last_fired_at is None or now_ts - state.last_fired_at >= cooldown
            )
            if cooled:
                state = LevelState(armed=True, last_fired_at=state.last_fired_at)

        if prev_price is not None and state.armed:
            low, high = min(prev_price, price), max(prev_price, price)
            if low <= level.price <= high:
                direction = "up" if price >= prev_price else "down"
                events.append(
                    {
                        "price": level.price,
                        "label": level.label,
                        "source": level.source,
                        "kind": level.kind,
                        "direction": direction,
                        "from": round(prev_price, 4),
                        "to": round(price, 4),
                        "at": now_ts,
                        "text": "%s %s %s(现价 %s)"
                        % (level.label, "上穿" if direction == "up" else "下破",
                           _fmt(level.price), _fmt(price)),
                    }
                )
                state = LevelState(armed=False, last_fired_at=now_ts)

        out[key] = state

    # 价位重算之后老状态会变成孤儿,留着只会越攒越多
    valid = {level_key(l) for l in levels}
    return events, {k: v for k, v in out.items() if k in valid}


def level_key(level: AlertLevel) -> str:
    """状态字典的键。只用价格:墙的标签会随行情变,价格才是这个警报的身份。"""
    return "%.4f" % level.price


def _fmt(value: float) -> str:
    return ("%.4f" % value).rstrip("0").rstrip(".")


def describe(levels: Sequence[AlertLevel], spot: float) -> List[str]:
    """给人看的一句话清单,界面和通知都用它。"""
    out: List[str] = []
    for level in levels:
        gap = (level.price / spot - 1.0) * 100.0 if spot else 0.0
        out.append("%s %s(%+.2f%%)" % (_fmt(level.price), level.label, gap))
    return out
