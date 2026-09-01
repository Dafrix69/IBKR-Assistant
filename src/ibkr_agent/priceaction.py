"""价格行为(Price Action)实时分析 —— 纯计算,离线可单测。

原则与全项目一致:**数字由代码算,叙事才交给 LLM**。这里从一段 K 线里读出
摆动结构、关键位、缺口与形态,每一条结论都能追溯到具体哪根 K 线、哪个价位;
界面上的「AI 解读」拿到的只是这里算好的事实,模型没有额外数据可编。

术语按主流 PA / SMC 口径:

  摆动点 swing   左右各 N 根都没更高/更低的分形高低点(最后 N 根天然未确认)
  结构 structure 摆动点序列 HH/HL/LH/LL,决定趋势
  BOS            顺着当前方向**收盘**突破前高/前低 —— 趋势延续
  CHoCH          逆着当前方向收盘突破 —— 性质改变,趋势可能反转
  扫单 sweep     影线刺穿前高/前低但收了回来 —— 常见的假突破/猎止损
  FVG            三根 K 线之间留下、尚未被回补的价格缺口
  订单块 OB      推动那次突破之前的最后一根反向 K 线

刻意一律用**收盘价**确认突破:盘中影线穿一下就当突破,是这类分析最常见的
自欺来源。影线穿透单独归到「扫单」,与真突破分开报。

只读研究模块:不接下单链路、不参与定价,结论不构成投资建议。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .backtest import _ema


class PriceActionError(ValueError):
    pass


# 周期表:key → IBKR 请求参数 + 展示用中文名 + 默认参照的高一级周期。
#
# duration 是**两档**的,这是被 IBKR 的语义坑出来的:`durationStr` 不是
# "往回数 N 天的 K 线",而是"往回数 N 个**交易日**",而全时段口径(useRTH=0)
# 下的交易日在美东傍晚就翻篇。结果是刚过那个边界时,"1 D" 只剩十几根——
# 实测踩到过:根数从 10 一路涨到 17,每刷新一次多一根,全是实时新增的,
# 没有任何历史。所以第一档就要给够,再不够就退到 fallback 重取一次。
TIMEFRAMES: Dict[str, Dict[str, Any]] = {
    "1m":  {"bar_size": "1 min",   "duration": "2 D",  "fallback": "4 D",  "seconds": 60,    "label": "1 分钟",  "htf": "15m"},
    "2m":  {"bar_size": "2 mins",  "duration": "3 D",  "fallback": "6 D",  "seconds": 120,   "label": "2 分钟",  "htf": "30m"},
    "5m":  {"bar_size": "5 mins",  "duration": "5 D",  "fallback": "10 D", "seconds": 300,   "label": "5 分钟",  "htf": "1h"},
    "15m": {"bar_size": "15 mins", "duration": "10 D", "fallback": "20 D", "seconds": 900,   "label": "15 分钟", "htf": "1h"},
    "30m": {"bar_size": "30 mins", "duration": "15 D", "fallback": "30 D", "seconds": 1800,  "label": "30 分钟", "htf": "1d"},
    "1h":  {"bar_size": "1 hour",  "duration": "30 D", "fallback": "60 D", "seconds": 3600,  "label": "1 小时",  "htf": "1d"},
    "1d":  {"bar_size": "1 day",   "duration": "1 Y",  "fallback": "2 Y",  "seconds": 86400, "label": "日线",    "htf": None},
}

MIN_BARS = 30          # 少于这个数量不出结论:摆动点都凑不齐两组,谈结构是编的
SWING_STRENGTH = 2     # 分形左右各看几根
CHART_BARS = 140       # 回给界面画图的 K 线根数

# 打分权重。全部摆在这里是有意的:结论怎么来的必须能被逐条质疑,
# 而不是藏在一串 if 里。正 = 看涨,负 = 看跌。
_W = {
    "trend": 30.0,      # 摆动结构方向
    "choch": 25.0,      # 最近一次性质改变
    "bos": 15.0,        # 最近一次顺势突破
    "position": 15.0,   # 收盘价在近段区间里的位置
    "ema": 12.0,        # 均线动能(PA 的辅助项,不喧宾夺主)
    "sweep": 15.0,      # 最近一次流动性扫单
    "pattern": 10.0,    # 最近几根 K 线形态
    "level": 8.0,       # 是否紧贴关键位
    "volume": 8.0,      # 最后一根的相对量能
}


# ---------------------------------------------------------------- 数据结构
@dataclass(frozen=True)
class PABar:
    time: str          # 'YYYY-MM-DD HH:MM'(日线为 'YYYY-MM-DD'),美东时间
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0

    @property
    def body(self) -> float:
        return abs(self.close - self.open)

    @property
    def span(self) -> float:
        return self.high - self.low

    @property
    def bullish(self) -> bool:
        return self.close > self.open


@dataclass(frozen=True)
class Swing:
    index: int
    time: str
    price: float
    kind: str          # 'high' | 'low'
    label: str = ""    # HH / HL / LH / LL

    def as_dict(self) -> Dict[str, Any]:
        return {"index": self.index, "time": self.time, "price": round(self.price, 4),
                "kind": self.kind, "label": self.label}


def to_bars(rows: Sequence[Dict[str, Any]]) -> List[PABar]:
    """把 broker / 测试给的 dict 序列转成 PABar。缺量按 0 计,不猜。"""
    bars: List[PABar] = []
    for row in rows:
        bars.append(
            PABar(
                time=str(row.get("time") or row.get("date") or ""),
                open=float(row["open"]),
                high=float(row["high"]),
                low=float(row["low"]),
                close=float(row["close"]),
                volume=float(row.get("volume") or 0.0),
            )
        )
    return bars


# ---------------------------------------------------------------- 波动尺度
def true_range(bar: PABar, prev: Optional[PABar]) -> float:
    if prev is None:
        return bar.span
    return max(bar.span, abs(bar.high - prev.close), abs(bar.low - prev.close))


def atr(bars: Sequence[PABar], period: int = 14) -> float:
    """ATR(简单平均版)。它是本模块所有「多大才算数」的统一尺子——容差、缺口
    下限、扫单穿透幅度都按它折算,所以换标的、换周期都不用改常数。"""
    if len(bars) < 2:
        return 0.0
    trs = [true_range(bars[i], bars[i - 1]) for i in range(1, len(bars))]
    tail = trs[-period:]
    return sum(tail) / len(tail) if tail else 0.0


# ---------------------------------------------------------------- 摆动结构
def find_swings(bars: Sequence[PABar], strength: int = SWING_STRENGTH) -> List[Swing]:
    """分形高低点。左侧严格、右侧允许相等:平顶只认第一根,避免同一个顶报两次。"""
    out: List[Swing] = []
    for i in range(strength, len(bars) - strength):
        left = bars[i - strength:i]
        right = bars[i + 1:i + 1 + strength]
        bar = bars[i]
        if bar.high > max(b.high for b in left) and bar.high >= max(b.high for b in right):
            out.append(Swing(i, bar.time, bar.high, "high"))
        if bar.low < min(b.low for b in left) and bar.low <= min(b.low for b in right):
            out.append(Swing(i, bar.time, bar.low, "low"))
    out.sort(key=lambda s: (s.index, 0 if s.kind == "high" else 1))
    return out


def zigzag(swings: Sequence[Swing]) -> List[Swing]:
    """整理成严格高低交替:相邻同向只留更极端的那个。"""
    out: List[Swing] = []
    for swing in swings:
        if not out:
            out.append(swing)
            continue
        last = out[-1]
        if last.kind != swing.kind:
            out.append(swing)
        elif (swing.price > last.price) if swing.kind == "high" else (swing.price < last.price):
            out[-1] = swing
    return out


def label_swings(points: Sequence[Swing]) -> List[Swing]:
    """给每个摆动点打 HH/HL/LH/LL。第一个高/低点没有参照,记 H/L。"""
    highs: List[float] = []
    lows: List[float] = []
    out: List[Swing] = []
    for swing in points:
        if swing.kind == "high":
            label = ("HH" if swing.price > highs[-1] else "LH") if highs else "H"
            highs.append(swing.price)
        else:
            label = ("HL" if swing.price > lows[-1] else "LL") if lows else "L"
            lows.append(swing.price)
        out.append(Swing(swing.index, swing.time, swing.price, swing.kind, label))
    return out


def read_trend(points: Sequence[Swing]) -> Dict[str, str]:
    highs = [s for s in points if s.kind == "high"]
    lows = [s for s in points if s.kind == "low"]
    if len(highs) < 2 or len(lows) < 2:
        return {"trend": "unknown", "label": "摆动点不足两组,结构尚未成形"}
    up = highs[-1].price > highs[-2].price and lows[-1].price > lows[-2].price
    down = highs[-1].price < highs[-2].price and lows[-1].price < lows[-2].price
    if up:
        return {"trend": "up", "label": "上升结构(高点抬高 + 低点抬高)"}
    if down:
        return {"trend": "down", "label": "下降结构(高点降低 + 低点降低)"}
    return {"trend": "range", "label": "震荡(高点与低点没有同向移动)"}


def break_events(
    bars: Sequence[PABar], points: Sequence[Swing], strength: int = SWING_STRENGTH,
    keep: int = 6,
) -> List[Dict[str, Any]]:
    """顺时间推进找收盘突破:同向记 BOS,反向记 CHoCH。

    两个刻意的约束,少了就会得到一堆假事件:
      * 摆动点要**延后 strength 根**才算被市场看到(分形本来就是滞后确认的);
      * 只拿「当时还在价格另一侧」的摆动点当参照,已经被越过的不再重复报。
    """
    confirmed: Dict[int, List[Swing]] = {}
    for swing in points:
        confirmed.setdefault(swing.index + strength, []).append(swing)

    events: List[Dict[str, Any]] = []
    direction: Optional[str] = None
    pending_high: Optional[Swing] = None
    pending_low: Optional[Swing] = None

    for i, bar in enumerate(bars):
        if pending_high is not None and bar.close > pending_high.price:
            kind = "BOS" if direction in (None, "up") else "CHoCH"
            direction = "up"
            events.append(_event(kind, "up", i, bar, pending_high))
            pending_high = None
        if pending_low is not None and bar.close < pending_low.price:
            kind = "BOS" if direction in (None, "down") else "CHoCH"
            direction = "down"
            events.append(_event(kind, "down", i, bar, pending_low))
            pending_low = None
        for swing in confirmed.get(i, []):
            if swing.kind == "high" and swing.price > bar.close:
                pending_high = swing
            elif swing.kind == "low" and swing.price < bar.close:
                pending_low = swing

    return events[-keep:]


def _event(kind: str, direction: str, index: int, bar: PABar, swing: Swing) -> Dict[str, Any]:
    return {
        "kind": kind,
        "direction": direction,
        "time": bar.time,
        "index": index,
        "level": round(swing.price, 4),
        "close": round(bar.close, 4),
        "swing_time": swing.time,
        "text": "%s %s:收盘 %s %s前%s %s"
        % (
            bar.time, kind, round(bar.close, 4),
            "上破" if direction == "up" else "下破",
            "高" if direction == "up" else "低",
            round(swing.price, 4),
        ),
    }


# ---------------------------------------------------------------- 关键位
def cluster_levels(
    bars: Sequence[PABar], points: Sequence[Swing], tol: float, last: float,
    per_side: int = 3,
) -> List[Dict[str, Any]]:
    """把邻近的摆动点并成一条关键位,再数有多少根 K 线在这条线上留过痕迹。

    触碰次数比「这里曾经是个高点」更能说明有效性:同一价位被反复试探过,
    才是市场记得住的位置。
    """
    prices = sorted(s.price for s in points)
    if not prices or tol <= 0 or not last:
        return []

    clusters: List[List[float]] = [[prices[0]]]
    for price in prices[1:]:
        if price - clusters[-1][-1] <= tol:
            clusters[-1].append(price)
        else:
            clusters.append([price])

    levels: List[Dict[str, Any]] = []
    for group in clusters:
        price = sum(group) / len(group)
        touches = sum(
            1 for b in bars if abs(b.high - price) <= tol or abs(b.low - price) <= tol
        )
        levels.append(
            {
                "price": round(price, 4),
                "swings": len(group),
                "touches": touches,
                "side": "resistance" if price > last else "support",
                "distance_pct": round((price / last - 1.0) * 100.0, 2),
            }
        )

    above = sorted([l for l in levels if l["side"] == "resistance"], key=lambda l: l["price"])
    below = sorted([l for l in levels if l["side"] == "support"], key=lambda l: -l["price"])
    # 从低到高排,界面直接顺着画;支撑在前、阻力在后
    return below[:per_side][::-1] + above[:per_side]


def find_fvgs(bars: Sequence[PABar], tol: float, keep: int = 4) -> List[Dict[str, Any]]:
    """未回补的 FVG。窄于 tol 的当噪音丢掉,已被走完的不再列。"""
    out: List[Dict[str, Any]] = []
    for i in range(1, len(bars) - 1):
        prev, nxt = bars[i - 1], bars[i + 1]
        if nxt.low > prev.high:
            bottom, top, side = prev.high, nxt.low, "bull"
        elif nxt.high < prev.low:
            bottom, top, side = nxt.high, prev.low, "bear"
        else:
            continue
        size = top - bottom
        if size < tol:
            continue

        rest = bars[i + 2:]
        if side == "bull":
            reached = min((b.low for b in rest), default=top)
            filled = (top - reached) / size
        else:
            reached = max((b.high for b in rest), default=bottom)
            filled = (reached - bottom) / size
        filled = min(max(filled, 0.0), 1.0)
        if filled >= 0.9:
            continue
        out.append(
            {
                "side": side,
                "time": bars[i].time,
                "bottom": round(bottom, 4),
                "top": round(top, 4),
                "filled_pct": round(filled * 100.0, 1),
            }
        )
    return out[-keep:]


def order_block(
    bars: Sequence[PABar], event: Optional[Dict[str, Any]], lookback: int = 25
) -> Optional[Dict[str, Any]]:
    """推动最近一次突破之前的最后一根反向 K 线,以及它是否已被回踩。"""
    if not event:
        return None
    end = event["index"]
    want_bullish = event["direction"] == "down"     # 下破之前找最后一根阳线
    for i in range(end, max(-1, end - lookback), -1):
        bar = bars[i]
        if bar.body > 0 and bar.bullish == want_bullish:
            after = bars[i + 2:]
            mitigated = any(b.low <= bar.high and b.high >= bar.low for b in after)
            return {
                "side": "bear" if want_bullish else "bull",
                "time": bar.time,
                "bottom": round(bar.low, 4),
                "top": round(bar.high, 4),
                "mitigated": mitigated,
            }
    return None


def find_sweeps(
    bars: Sequence[PABar], points: Sequence[Swing], tol: float,
    strength: int = SWING_STRENGTH, window: int = 40, keep: int = 3,
) -> List[Dict[str, Any]]:
    """影线刺穿前高/前低但收了回来 —— 止损被扫,常是反向行情的起点。"""
    out: List[Dict[str, Any]] = []
    for j in range(max(0, len(bars) - window), len(bars)):
        bar = bars[j]
        for swing in points:
            if swing.index + strength >= j or j - swing.index > 60:
                continue
            if swing.kind == "high" and bar.high > swing.price + tol and bar.close < swing.price:
                out.append(_sweep("bear", bar, j, swing))
                break
            if swing.kind == "low" and bar.low < swing.price - tol and bar.close > swing.price:
                out.append(_sweep("bull", bar, j, swing))
                break
    return out[-keep:]


def _sweep(direction: str, bar: PABar, index: int, swing: Swing) -> Dict[str, Any]:
    return {
        "direction": direction,
        "time": bar.time,
        "index": index,
        "level": round(swing.price, 4),
        "extreme": round(bar.high if direction == "bear" else bar.low, 4),
        "text": "%s:影线%s前%s %s 后收回%s方"
        % (
            bar.time,
            "上破" if direction == "bear" else "下破",
            "高" if direction == "bear" else "低",
            round(swing.price, 4),
            "下" if direction == "bear" else "上",
        ),
    }


def equal_levels(points: Sequence[Swing], tol: float) -> List[Dict[str, Any]]:
    """等高 / 等低:两个几乎同价的摆动点,那一侧大概率堆着一池止损。"""
    out: List[Dict[str, Any]] = []
    for kind in ("high", "low"):
        same = [s for s in points if s.kind == kind]
        for a, b in zip(same, same[1:]):
            if abs(a.price - b.price) <= tol * 0.6:
                price = round((a.price + b.price) / 2.0, 4)
                out.append(
                    {
                        "kind": kind,
                        "price": price,
                        "times": [a.time, b.time],
                        "text": "%s 附近有等%s(%s / %s),该价位%s方大概率堆着流动性"
                        % (price, "高" if kind == "high" else "低", a.time, b.time,
                           "上" if kind == "high" else "下"),
                    }
                )
    return out[-3:]


# ---------------------------------------------------------------- K 线形态
def detect_patterns(
    bars: Sequence[PABar], atr_value: float, count: int = 4
) -> List[Dict[str, Any]]:
    """只看最后几根:形态是即时信息,三十根之前的锤子线跟现在没关系。"""
    out: List[Dict[str, Any]] = []
    for i in range(max(1, len(bars) - count), len(bars)):
        bar, prev = bars[i], bars[i - 1]
        span = bar.span
        if span <= 0:
            continue
        body = bar.body
        upper = bar.high - max(bar.close, bar.open)
        lower = min(bar.close, bar.open) - bar.low
        hits: List[Tuple[str, str, str]] = []

        if body <= span * 0.1:
            hits.append(("十字星", "neutral", "开收几乎同价,多空拉锯"))
        # 影线按**振幅**折算,不按实体:教科书里的锤子实体常常接近十字星,
        # 用实体做分母会因为除数太小而把真正的针形 K 线判掉
        if lower >= span * 0.5 and upper <= span * 0.2 and body <= span * 0.4:
            hits.append(("长下影(锤子)", "bull", "下方被买回,卖压在低位被吸收"))
        if upper >= span * 0.5 and lower <= span * 0.2 and body <= span * 0.4:
            hits.append(("长上影(射击之星)", "bear", "上冲被打回,高位有抛压"))
        if bar.bullish and not prev.bullish and bar.close >= prev.open and bar.open <= prev.close:
            hits.append(("看涨吞没", "bull", "阳线整根吞掉前一根阴线实体"))
        if not bar.bullish and prev.bullish and bar.close <= prev.open and bar.open >= prev.close:
            hits.append(("看跌吞没", "bear", "阴线整根吞掉前一根阳线实体"))
        if bar.high < prev.high and bar.low > prev.low:
            hits.append(("内包(inside bar)", "neutral", "波动收敛,等一次突破定方向"))
        if bar.high > prev.high and bar.low < prev.low:
            hits.append(("外包(outside bar)", "neutral", "上下两边流动性都被扫,以收盘为准"))
        if atr_value > 0 and body >= span * 0.7 and span >= atr_value * 1.2:
            hits.append(
                ("大实体推动", "bull" if bar.bullish else "bear",
                 "单根振幅超过 1.2 倍 ATR 的方向性推动")
            )

        for name, direction, note in hits:
            out.append(
                {
                    "name": name, "direction": direction, "note": note,
                    "time": bar.time, "bars_ago": len(bars) - 1 - i,
                }
            )
    return out


# ---------------------------------------------------------------- 环境
def market_context(bars: Sequence[PABar], atr_value: float) -> Dict[str, Any]:
    closes = [b.close for b in bars]
    last = closes[-1]
    out: Dict[str, Any] = {
        "last": round(last, 4),
        "atr": round(atr_value, 4),
        "atr_pct": round(atr_value / last * 100.0, 2) if last else None,
        "change_pct": round((last / closes[0] - 1.0) * 100.0, 2) if closes[0] else None,
    }

    ema20 = _ema(closes, 20)[-1] if len(closes) >= 20 else None
    ema50 = _ema(closes, 50)[-1] if len(closes) >= 50 else None
    if ema20:
        out["ema20"] = round(ema20, 4)
        out["vs_ema20_pct"] = round((last / ema20 - 1.0) * 100.0, 2)
    if ema20 and ema50:
        out["ema50"] = round(ema50, 4)
        out["ema_stack"] = "多头排列" if ema20 > ema50 else "空头排列"

    window = min(len(bars), 60)
    hi = max(b.high for b in bars[-window:])
    lo = min(b.low for b in bars[-window:])
    out["range_high"], out["range_low"], out["range_bars"] = round(hi, 4), round(lo, 4), window
    out["range_pos_pct"] = round((last - lo) / (hi - lo) * 100.0, 1) if hi > lo else None

    vols = [b.volume for b in bars if b.volume > 0]
    if len(vols) >= 10 and bars[-1].volume > 0:
        avg = sum(vols[-20:]) / len(vols[-20:])
        out["rel_volume"] = round(bars[-1].volume / avg, 2) if avg else None

    day = bars[-1].time[:10]
    todays = [b for b in bars if b.time[:10] == day]
    if len(todays) >= 2:
        out["session"] = {
            "date": day, "bars": len(todays),
            "open": round(todays[0].open, 4),
            "high": round(max(b.high for b in todays), 4),
            "low": round(min(b.low for b in todays), 4),
        }
    return out


# ---------------------------------------------------------------- 打分
def _score(
    trend: Dict[str, str], events: List[Dict[str, Any]], ctx: Dict[str, Any],
    sweeps: List[Dict[str, Any]], patterns: List[Dict[str, Any]],
    levels: List[Dict[str, Any]], atr_value: float, last: float,
) -> Tuple[float, List[Dict[str, Any]]]:
    """各项证据加权求和。每条证据都带权重原样返回,方便在界面上逐条推翻。"""
    evidence: List[Dict[str, Any]] = []

    def add(label: str, detail: str, weight: float) -> None:
        evidence.append({"label": label, "detail": detail, "weight": round(weight, 1)})

    if trend["trend"] == "up":
        add("摆动结构", trend["label"], _W["trend"])
    elif trend["trend"] == "down":
        add("摆动结构", trend["label"], -_W["trend"])
    else:
        add("摆动结构", trend["label"], 0.0)

    if events:
        latest = events[-1]
        sign = 1.0 if latest["direction"] == "up" else -1.0
        weight = _W["choch"] if latest["kind"] == "CHoCH" else _W["bos"]
        add("最近一次结构事件", latest["text"], sign * weight)

    pos = ctx.get("range_pos_pct")
    if pos is not None:
        add(
            "区间位置",
            "收盘位于近 %d 根区间的 %.0f%%(%s ~ %s)"
            % (ctx["range_bars"], pos, ctx["range_low"], ctx["range_high"]),
            (pos / 50.0 - 1.0) * _W["position"],
        )

    if ctx.get("ema_stack"):
        bullish_stack = ctx["ema_stack"] == "多头排列"
        add(
            "均线动能",
            "EMA20 %s EMA50(%s),收盘相对 EMA20 %+.2f%%"
            % ("在上" if bullish_stack else "在下", ctx["ema_stack"], ctx.get("vs_ema20_pct") or 0.0),
            _W["ema"] * (1.0 if bullish_stack else -1.0),
        )

    if sweeps:
        latest_sweep = sweeps[-1]
        add(
            "流动性扫单",
            latest_sweep["text"],
            _W["sweep"] * (1.0 if latest_sweep["direction"] == "bull" else -1.0),
        )

    directional = [p for p in patterns if p["direction"] in ("bull", "bear")]
    if directional:
        newest = min(p["bars_ago"] for p in directional)
        fresh = [p for p in directional if p["bars_ago"] == newest]
        net = sum(1 if p["direction"] == "bull" else -1 for p in fresh)
        if net:
            add(
                "近端形态",
                "%s(%d 根之前)" % ("、".join(p["name"] for p in fresh), newest),
                _W["pattern"] * (1.0 if net > 0 else -1.0),
            )

    if atr_value > 0 and levels:
        near = min(levels, key=lambda l: abs(l["price"] - last))
        if abs(near["price"] - last) <= atr_value * 0.35:
            at_resistance = near["side"] == "resistance"
            add(
                "贴近关键位",
                "现价紧贴%s %s(%d 次触碰)"
                % ("阻力" if at_resistance else "支撑", near["price"], near["touches"]),
                -_W["level"] if at_resistance else _W["level"],
            )

    rel = ctx.get("rel_volume")
    if rel is not None and rel >= 1.5:
        up = (ctx.get("vs_ema20_pct") or 0.0) >= 0
        add(
            "量能",
            "最后一根量能是近 20 根均量的 %.2f 倍,价格%s均线" % (rel, "在" if up else "跌破"),
            _W["volume"] * (1.0 if up else -1.0),
        )

    score = sum(e["weight"] for e in evidence)
    return max(-100.0, min(100.0, score)), evidence


def bias_of(score: float) -> Dict[str, str]:
    if score >= 45:
        return {"bias": "bullish", "label": "看涨"}
    if score >= 18:
        return {"bias": "lean_bull", "label": "偏多"}
    if score <= -45:
        return {"bias": "bearish", "label": "看跌"}
    if score <= -18:
        return {"bias": "lean_bear", "label": "偏空"}
    return {"bias": "neutral", "label": "中性 / 观望"}


# ---------------------------------------------------------------- 总装
def analyze(
    rows: Sequence[Dict[str, Any]],
    symbol: str = "",
    timeframe: str = "",
    strength: int = SWING_STRENGTH,
    now: Optional[datetime] = None,
    extended_hours: bool = False,
) -> Dict[str, Any]:
    """一段 K 线 → 完整 PA 读盘结果。纯函数:同样的输入永远同样的输出。

    extended_hours 只影响警告文案:盘前盘后的 K 线成交稀薄,ATR 会被压小、
    摆动点会变碎。这不是拒绝的理由(缺口和扫单恰恰爱在那时候发生),
    但读的人得知道自己在看什么。
    """
    bars = to_bars(rows)
    if len(bars) < MIN_BARS:
        raise PriceActionError(
            "只有 %d 根 K 线,不足以读出结构(至少需要 %d 根)。"
            "换个更长的周期试试;如果这是刚开盘、K 线还在一根根长出来,过一会儿再看。"
            % (len(bars), MIN_BARS)
        )

    atr_value = atr(bars)
    last = bars[-1].close
    # 容差统一按 ATR 折算;ATR 退化成 0(整段全平)时退到价格的万分之五,避免除零
    tol = atr_value * 0.35 if atr_value > 0 else abs(last) * 0.0005

    points = label_swings(zigzag(find_swings(bars, strength)))
    trend = read_trend(points)
    events = break_events(bars, points, strength)
    levels = cluster_levels(bars, points, tol, last)
    gaps = find_fvgs(bars, tol)
    sweeps = find_sweeps(bars, points, tol, strength)
    patterns = detect_patterns(bars, atr_value)
    ctx = market_context(bars, atr_value)
    block = order_block(bars, events[-1] if events else None)
    equals = equal_levels(points, tol)

    score, evidence = _score(trend, events, ctx, sweeps, patterns, levels, atr_value, last)
    bias = bias_of(score)

    result: Dict[str, Any] = {
        "symbol": symbol,
        "timeframe": timeframe,
        "timeframe_label": (TIMEFRAMES.get(timeframe) or {}).get("label", timeframe),
        "bar_count": len(bars),
        "first_bar": bars[0].time,
        "last_bar": bars[-1].time,
        "last": round(last, 4),
        "atr": round(atr_value, 4),
        "swing_strength": strength,
        "score": round(score, 1),
        "bias": bias["bias"],
        "bias_label": bias["label"],
        "confidence": round(min(abs(score) / 70.0, 1.0), 2),
        "trend": trend["trend"],
        "trend_label": trend["label"],
        "swings": [s.as_dict() for s in points[-10:]],
        "events": events,
        "levels": levels,
        "fvgs": gaps,
        "order_block": block,
        "sweeps": sweeps,
        "equal_levels": equals,
        "patterns": patterns,
        "context": ctx,
        "evidence": evidence,
        "plan": _plan(bias["bias"], points, levels, gaps, block, atr_value, ctx),
        "bars": [
            {"time": b.time, "open": b.open, "high": b.high, "low": b.low,
             "close": b.close, "volume": b.volume}
            for b in bars[-CHART_BARS:]
        ],
    }
    result["extended_hours"] = extended_hours
    result["warnings"] = _warnings(result, now, extended_hours)
    result["readout"] = _readout(result)
    return result


def _plan(
    bias: str, points: Sequence[Swing], levels: List[Dict[str, Any]],
    gaps: List[Dict[str, Any]], block: Optional[Dict[str, Any]], atr_value: float,
    ctx: Dict[str, Any],
) -> Dict[str, Any]:
    """把结论落到具体价位:确认在哪、失效在哪、回踩看哪。

    只给价位与条件,不给方向性建议,更不给仓位——那是人的决定,也是这个
    只读模块该守住的边界。
    """
    resistance = next((l for l in levels if l["side"] == "resistance"), None)
    support = next((l for l in reversed(levels) if l["side"] == "support"), None)
    last_low = next((s for s in reversed(points) if s.kind == "low"), None)
    last_high = next((s for s in reversed(points) if s.kind == "high"), None)

    bullish = bias in ("bullish", "lean_bull")
    bearish = bias in ("bearish", "lean_bear")

    plan: Dict[str, Any] = {"resistance": resistance, "support": support, "watch": []}

    if bullish and resistance:
        plan["confirm"] = (
            "收盘站上 %s(最近阻力,%d 次触碰)才算突破成立;只有影线穿过按扫单处理"
            % (resistance["price"], resistance["touches"])
        )
    elif bullish:
        # 现价已在样本区间最高处,上方没有前高可参照——只能拿区间上沿当参照,
        # 并说清楚这不是「阻力」而是「无参照」,免得读成突破已完成
        plan["confirm"] = (
            "上方在这段样本里没有留下前高:现价已是近 %d 根的高位(区间上沿 %s),"
            "没有可参照的突破确认位,追高缺少结构依据"
            % (ctx.get("range_bars") or 0, ctx.get("range_high"))
        )
    elif bearish and support:
        plan["confirm"] = (
            "收盘跌破 %s(最近支撑,%d 次触碰)才算破位成立;只有影线穿过按扫单处理"
            % (support["price"], support["touches"])
        )
    elif bearish:
        plan["confirm"] = (
            "下方在这段样本里没有留下前低:现价已是近 %d 根的低位(区间下沿 %s),"
            "没有可参照的破位确认位"
            % (ctx.get("range_bars") or 0, ctx.get("range_low"))
        )
    else:
        edges = [str(l["price"]) for l in (support, resistance) if l]
        plan["confirm"] = (
            "区间 %s 之间来回,等某一端收盘突破再谈方向" % " ~ ".join(edges)
            if len(edges) == 2 else "结构未成形,等一次明确的收盘突破"
        )

    if bullish and last_low:
        plan["invalidation"] = {
            "price": round(last_low.price, 4),
            "why": "跌破最近摆动低点 %s(%s)则上升结构被破坏,看涨前提失效"
                   % (round(last_low.price, 4), last_low.time),
        }
    elif bearish and last_high:
        plan["invalidation"] = {
            "price": round(last_high.price, 4),
            "why": "站上最近摆动高点 %s(%s)则下降结构被破坏,看跌前提失效"
                   % (round(last_high.price, 4), last_high.time),
        }
    elif last_low and last_high:
        plan["invalidation"] = {
            "price": None,
            "why": "震荡中没有单一失效位;%s 与 %s 是这段区间的上下沿"
                   % (round(last_low.price, 4), round(last_high.price, 4)),
        }

    want = "bull" if bullish else ("bear" if bearish else None)
    if want:
        for gap in reversed(gaps):
            if gap["side"] == want:
                plan["watch"].append(
                    "未回补 FVG %s ~ %s(%s 留下,已回补 %.0f%%)——回踩到这里是顺势的观察点"
                    % (gap["bottom"], gap["top"], gap["time"], gap["filled_pct"])
                )
                break
        if block and block["side"] == want and not block["mitigated"]:
            plan["watch"].append(
                "订单块 %s ~ %s(%s 那根),尚未被回踩" % (block["bottom"], block["top"], block["time"])
            )
        near = support if bullish else resistance
        if near:
            plan["watch"].append(
                "关键位 %s(%d 次触碰,距现价 %+.2f%%)"
                % (near["price"], near["touches"], near["distance_pct"])
            )
    if atr_value > 0:
        plan["atr_note"] = "当前 ATR %s:小于这个幅度的价差属于日常噪音,别当成突破" % round(atr_value, 4)
    return plan


def _warnings(
    result: Dict[str, Any], now: Optional[datetime], extended_hours: bool = False
) -> List[str]:
    out: List[str] = []
    if extended_hours:
        out.append(
            "含盘前盘后:那几段成交稀薄,ATR 会偏小、摆动点会偏碎,"
            "跨隔夜的「缺口」多半只是没人交易,不是真跳空。"
        )
    if result["bar_count"] < 60:
        out.append("样本只有 %d 根 K 线,摆动结构的可靠性有限。" % result["bar_count"])
    if result["trend"] in ("range", "unknown"):
        out.append("结构未成形:震荡里做方向判断,胜率天然低于顺势。")
    if abs(result["score"]) < 18:
        out.append("多空证据接近抵消,这是「看不清」,不是「该进场」。")
    ctx = result["context"]
    if ctx.get("atr_pct") is not None and ctx["atr_pct"] < 0.05:
        out.append("波动率极低(ATR 仅占价格 %.2f%%),形态信号大概率是噪音。" % ctx["atr_pct"])

    age = bar_age_seconds(result["last_bar"], now)
    if age is not None:
        result["age_seconds"] = int(age)
        if age > 1800:
            out.append(
                "最后一根 K 线停在 %s,距现在 %d 分钟——可能是休市,也可能是行情延迟或订阅缺失。"
                % (result["last_bar"], int(age // 60))
            )
    return out


def bar_age_seconds(last_bar: str, now: Optional[datetime]) -> Optional[float]:
    if now is None:
        return None
    stamp = parse_bar_time(last_bar)
    if stamp is None:
        return None
    if now.tzinfo is not None and stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=now.tzinfo)
    return (now - stamp).total_seconds()


def parse_bar_time(raw: str) -> Optional[datetime]:
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt)
        except (ValueError, TypeError):
            continue
    return None


def _readout(result: Dict[str, Any]) -> List[str]:
    """给人看的读盘结论。全部由上面算好的字段拼成,不引入任何新判断。"""
    ctx = result["context"]
    lines = [
        "%s %s:现价 %s,%s(打分 %+.0f/100)。"
        % (result["symbol"] or "标的", result["timeframe_label"], result["last"],
           result["bias_label"], result["score"]),
        "结构:%s。" % result["trend_label"],
    ]
    if result["events"]:
        lines.append("最近结构事件:%s。" % result["events"][-1]["text"])
    if result["swings"]:
        lines.append("近端摆动序列:%s。" % "→".join(s["label"] for s in result["swings"][-5:]))
    if ctx.get("range_pos_pct") is not None:
        lines.append(
            "位置:近 %d 根区间 %s ~ %s,收盘落在 %.0f%% 处。"
            % (ctx["range_bars"], ctx["range_low"], ctx["range_high"], ctx["range_pos_pct"])
        )
    if result["sweeps"]:
        lines.append("流动性:%s。" % result["sweeps"][-1]["text"])
    fresh = [p for p in result["patterns"] if p["bars_ago"] <= 1]
    if fresh:
        lines.append("近端形态:%s。" % "、".join("%s(%s)" % (p["name"], p["note"]) for p in fresh[:3]))
    plan = result["plan"]
    if plan.get("confirm"):
        lines.append("确认条件:%s。" % plan["confirm"])
    if (plan.get("invalidation") or {}).get("why"):
        lines.append("失效条件:%s。" % plan["invalidation"]["why"])
    return lines


def facts_text(result: Dict[str, Any]) -> str:
    """把分析结果拼成给模型看的事实块。

    刻意只放**算好的数字与结论**,不放原始 K 线:给模型一堆 OHLC 它就会开始
    自己"看图",而它看图的结果没人能复核。这里给的每一行都可以在界面上
    找到对应的卡片,模型说错了一眼就能发现。
    """
    ctx = result.get("context") or {}
    plan = result.get("plan") or {}
    lines: List[str] = [
        "标的:%s;周期:%s;K 线 %d 根,最后一根 %s;现价 %s;ATR %s。"
        % (result.get("symbol") or "-", result.get("timeframe_label") or "-",
           result.get("bar_count") or 0, result.get("last_bar") or "-",
           result.get("last"), result.get("atr")),
        "软件判定:%s(打分 %+.0f/100);结构:%s。"
        % (result.get("bias_label"), result.get("score") or 0.0, result.get("trend_label")),
    ]
    if result.get("swings"):
        lines.append(
            "摆动序列(旧→新):%s。"
            % "、".join("%s@%s" % (s["label"], s["price"]) for s in result["swings"][-6:])
        )
    for event in (result.get("events") or [])[-3:]:
        lines.append("结构事件:%s。" % event["text"])
    if result.get("levels"):
        lines.append(
            "关键位:%s。"
            % ";".join(
                "%s %s(%d 次触碰,距现价 %+.2f%%)"
                % ("阻力" if l["side"] == "resistance" else "支撑",
                   l["price"], l["touches"], l["distance_pct"])
                for l in result["levels"]
            )
        )
    for gap in (result.get("fvgs") or [])[-2:]:
        lines.append(
            "未回补 FVG(%s):%s ~ %s,%s 留下,已回补 %.0f%%。"
            % ("看涨" if gap["side"] == "bull" else "看跌",
               gap["bottom"], gap["top"], gap["time"], gap["filled_pct"])
        )
    block_ = result.get("order_block")
    if block_:
        lines.append(
            "订单块(%s):%s ~ %s,%s;%s。"
            % ("看涨" if block_["side"] == "bull" else "看跌", block_["bottom"], block_["top"],
               block_["time"], "已被回踩" if block_["mitigated"] else "尚未回踩")
        )
    for sweep in (result.get("sweeps") or [])[-2:]:
        lines.append("流动性扫单:%s。" % sweep["text"])
    for eq in (result.get("equal_levels") or [])[-2:]:
        lines.append("等高/等低:%s。" % eq["text"])
    fresh = [p for p in (result.get("patterns") or []) if p["bars_ago"] <= 2]
    if fresh:
        lines.append(
            "近端 K 线形态:%s。"
            % ";".join("%s(%d 根前,%s)" % (p["name"], p["bars_ago"], p["note"]) for p in fresh)
        )
    if ctx.get("range_pos_pct") is not None:
        lines.append(
            "区间:近 %d 根 %s ~ %s,收盘在 %.0f%% 处;相对 EMA20 %s%%;%s。"
            % (ctx["range_bars"], ctx["range_low"], ctx["range_high"], ctx["range_pos_pct"],
               ctx.get("vs_ema20_pct"), ctx.get("ema_stack") or "均线数据不足")
        )
    if ctx.get("rel_volume") is not None:
        lines.append("量能:最后一根是近 20 根均量的 %.2f 倍。" % ctx["rel_volume"])
    if ctx.get("session"):
        session = ctx["session"]
        lines.append(
            "当日(%s):开 %s,高 %s,低 %s,已走 %d 根。"
            % (session["date"], session["open"], session["high"], session["low"], session["bars"])
        )
    higher = result.get("htf")
    if higher:
        lines.append(
            "高周期(%s):%s,%s;支撑 %s / 阻力 %s。%s"
            % (higher["timeframe_label"], higher["bias_label"], higher["trend_label"],
               higher.get("support") if higher.get("support") is not None else "该样本内无",
               higher.get("resistance") if higher.get("resistance") is not None else "该样本内无",
               (result.get("agreement") or {}).get("text") or "")
        )
    if plan.get("confirm"):
        lines.append("软件给的确认条件:%s。" % plan["confirm"])
    if (plan.get("invalidation") or {}).get("why"):
        lines.append("软件给的失效条件:%s。" % plan["invalidation"]["why"])
    for note in result.get("warnings") or []:
        lines.append("软件警告:%s" % note)
    lines.append("以上全部由软件按 K 线算出。请只解读,不要新造价格。")
    return "\n".join(lines)


def htf_summary(result: Dict[str, Any]) -> Dict[str, Any]:
    """高周期只取方向与关键位——低周期找入场,方向不该由低周期说了算。"""
    plan = result.get("plan") or {}
    return {
        "timeframe": result["timeframe"],
        "timeframe_label": result["timeframe_label"],
        "bias": result["bias"],
        "bias_label": result["bias_label"],
        "score": result["score"],
        "trend_label": result["trend_label"],
        "last_event": (result["events"] or [{}])[-1].get("text"),
        "resistance": (plan.get("resistance") or {}).get("price"),
        "support": (plan.get("support") or {}).get("price"),
    }


def agreement(primary: Dict[str, Any], higher: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """低周期与高周期是否同向。顺着高周期做和逆着高周期做,是两件事。"""
    if not higher:
        return {"state": "unknown", "text": "没有高周期数据可对照。"}

    def sign(bias: str) -> int:
        if bias in ("bullish", "lean_bull"):
            return 1
        if bias in ("bearish", "lean_bear"):
            return -1
        return 0

    a, b = sign(primary["bias"]), sign(higher["bias"])
    if a == 0 or b == 0:
        return {
            "state": "unclear",
            "text": "%s 方向不明,低周期信号缺少高周期背书。" % higher["timeframe_label"],
        }
    if a == b:
        return {
            "state": "aligned",
            "text": "与 %s(%s)同向,属于顺势。" % (higher["timeframe_label"], higher["bias_label"]),
        }
    return {
        "state": "conflict",
        "text": "与 %s(%s)相反,属于逆势——这类信号更容易被打回。"
                % (higher["timeframe_label"], higher["bias_label"]),
    }
