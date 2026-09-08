"""扫描器 —— RS 强度 / 拐点筛选 / 极值偏离,全部纯计算,离线可单测。

三个功能都是对**股票池**(板块页里的成分股)做批量复盘,数字由代码算,
不经过大模型,也不接下单链路。

  RS 强度   多个时间区间内,把每只股与 SPY 或 QQQ 比:RS = (1+r股)/(1+r基准) − 1,
           也就是"跑赢基准多少"。再按成分股的**业务标签**汇总——同一板块里
           "芯片"与"数据中心"哪一条线更强,一眼看出来。

  拐点筛选  多个 K 线周期上找**左侧 CD 背离**:CD 指 MACD 的快线 DIF(EMA12 − EMA26)。
           价格创出更低的低点、DIF 却抬高(底背离),或价格创新高、DIF 却走低(顶背离)。
           这是左侧信号——拐点还没确认,所以可选**右侧均线确认**:背离之后收盘
           站上(跌破)指定均线才算确认。

  极值偏离  逐只复盘:所选周期内每根 K 线的**修正版买卖压力**(收盘在当根真实区间
           里的位置,含跳空、按相对成交量加权、再平滑)与**偏离程度**(收盘相对均线
           的偏离,折成近段历史的 z 分数)。z 分数到 ±2 就是极值——被拉得太远了。

只读研究模块:不发单、不改仓位。
"""
from __future__ import annotations

from math import sqrt
from typing import Any, Dict, List, Optional, Sequence

from .backtest import _ema, _sma

RS_WINDOWS = (5, 20, 60, 120, 250)   # 周 / 月 / 季 / 半年 / 年(交易日)
RS_WINDOW_LABELS = {5: "1周", 20: "1月", 60: "1季", 120: "半年", 250: "1年"}
RS_BENCHMARKS = ("SPY", "QQQ")
UNTAGGED = "未分类"

DEFAULT_PIVOT_STRENGTH = 3    # 摆动点:左右各这么多根都没更极端的价格
DEFAULT_MAX_SPAN = 60         # 构成背离的两个摆动点最多隔这么多根
DEFAULT_MAX_AGE = 12          # 第二个摆动点离最后一根不能超过这么多根,否则信号已陈旧
MIN_CD_BARS = 40              # EMA26 之外还要留出摆动点的余量

DEFAULT_DEV_PERIOD = 20       # 偏离用的均线周期
DEFAULT_DEV_LOOKBACK = 120    # 折 z 分数的历史长度
DEFAULT_PRESSURE_SMOOTH = 5   # 买卖压力的平滑周期
DEFAULT_Z_EXTREME = 2.0       # |z| 到这里算极值
DEFAULT_KEEP = 120            # 返回给界面画图的根数
MIN_Z_SAMPLES = 10            # 历史少于这么多根不折 z(样本太少的标准差没意义)
VOLUME_WEIGHT_CAP = 3.0       # 放量加权封顶,免得一根天量把整条曲线带偏
SIGNAL_LABEL = {"bull": "底背离", "bear": "顶背离"}


class ScreenerError(ValueError):
    pass


# ---------------------------------------------------------------- 公共小工具
def _bar_time(bar: Dict[str, Any]) -> str:
    return str(bar.get("date") or bar.get("time") or "")


def _num(bar: Dict[str, Any], key: str) -> Optional[float]:
    value = bar.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _clean(bars: Optional[Sequence[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """只留 OHLC 齐全且为正数的 K 线,整根跳过缺数据的,不拿别的字段凑。"""
    out: List[Dict[str, Any]] = []
    for bar in bars or []:
        o, h, l, c = (_num(bar, k) for k in ("open", "high", "low", "close"))
        if o is None or h is None or l is None or c is None:
            continue
        if min(o, h, l, c) <= 0:
            continue
        v = _num(bar, "volume")
        out.append({"time": _bar_time(bar), "open": o, "high": max(h, o, c),
                    "low": min(l, o, c), "close": c, "volume": v if v is not None and v >= 0 else 0.0})
    return out


def resample_weekly(bars: Optional[Sequence[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """日线 → 周线(周一为一周之始)。time 取该周最后一个交易日,便于对回日线。"""
    from datetime import date

    weeks: List[Dict[str, Any]] = []
    current_key = None
    for bar in _clean(bars):
        try:
            day = date.fromisoformat(bar["time"][:10])
        except ValueError:
            continue
        key = day.toordinal() - day.weekday()
        if key != current_key:
            weeks.append(dict(bar))
            current_key = key
            continue
        last = weeks[-1]
        last["time"] = bar["time"]
        last["high"] = max(last["high"], bar["high"])
        last["low"] = min(last["low"], bar["low"])
        last["close"] = bar["close"]
        last["volume"] = last["volume"] + bar["volume"]
    return weeks


def _median(values: Sequence[float]) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    n = len(ordered)
    mid = n // 2
    if n % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


# ================================================================ RS 强度
def _close_at_or_before(times: Sequence[str], closes: Sequence[float], when: str) -> Optional[float]:
    """基准在某日(或之前最近一日)的收盘。两边的假期 / 停牌未必对齐,按日期找,不按下标。"""
    hit = None
    for t, c in zip(times, closes):
        if t <= when:
            hit = c
        else:
            break
    return hit


def rs_strength(
    members: Sequence[Dict[str, Any]],
    bench_bars: Optional[Sequence[Dict[str, Any]]],
    benchmark: str = "SPY",
    windows: Sequence[int] = RS_WINDOWS,
) -> Dict[str, Any]:
    """股票池成员对基准的相对强度,并按业务标签汇总。

    members 每项 {symbol, tag, bars, error?};bars 为按日期升序的日线。
    区间收益按各自的 K 线算,基准按**日期对齐**取值(成员停牌一天不该把基准的
    区间错开)。数据不够的区间直接省略,不用短区间冒充长区间。
    """
    bench = _clean(bench_bars)
    bench_times = [b["time"][:10] for b in bench]
    bench_closes = [b["close"] for b in bench]

    rows: List[Dict[str, Any]] = []
    for member in members:
        symbol = str(member.get("symbol") or "").upper()
        tag = str(member.get("tag") or "").strip() or UNTAGGED
        bars = _clean(member.get("bars"))
        closes = [b["close"] for b in bars]
        times = [b["time"][:10] for b in bars]
        row: Dict[str, Any] = {
            "symbol": symbol, "tag": tag, "company": str(member.get("company") or ""),
            "last": round(closes[-1], 2) if closes else None,
            "bars": len(closes), "rs": {}, "score": None, "rank": None,
            "error": member.get("error") or None,
        }
        values: List[float] = []
        for n in windows:
            if len(closes) <= n or not bench:
                continue
            b0 = _close_at_or_before(bench_times, bench_closes, times[-1 - n])
            b1 = _close_at_or_before(bench_times, bench_closes, times[-1])
            if not b0 or not b1 or closes[-1 - n] <= 0:
                continue
            ret = closes[-1] / closes[-1 - n] - 1.0
            bench_ret = b1 / b0 - 1.0
            rs = (1.0 + ret) / (1.0 + bench_ret) - 1.0
            row["rs"][str(n)] = {
                "ret_pct": round(ret * 100.0, 2),
                "bench_pct": round(bench_ret * 100.0, 2),
                "rs_pct": round(rs * 100.0, 2),
                "beats": rs > 0,
            }
            values.append(rs)
        if values:
            row["score"] = round(sum(values) / len(values) * 100.0, 2)
        rows.append(row)

    # 排名:有分的按分高低,没分的沉底;同分按代码,保证两套引擎顺序一致
    rows.sort(key=lambda r: (r["score"] is None, -(r["score"] or 0.0), r["symbol"]))
    rank = 0
    for row in rows:
        if row["score"] is not None:
            rank += 1
            row["rank"] = rank

    tags = _rs_by_tag(rows, windows)
    return {
        "benchmark": benchmark,
        "windows": [{"n": n, "label": RS_WINDOW_LABELS.get(n, "%d日" % n)} for n in windows],
        "rows": rows,
        "tags": tags,
        "counted": rank,
        "total": len(rows),
        "bench_bars": len(bench),
        "bench_last": round(bench_closes[-1], 2) if bench_closes else None,
    }


def _rs_by_tag(rows: Sequence[Dict[str, Any]], windows: Sequence[int]) -> List[Dict[str, Any]]:
    """按标签汇总:每个区间给中位数 RS 与跑赢家数。中位数比均值抗一只妖股。"""
    groups: Dict[str, List[Dict[str, Any]]] = {}
    order: List[str] = []
    for row in rows:
        if row["tag"] not in groups:
            groups[row["tag"]] = []
            order.append(row["tag"])
        groups[row["tag"]].append(row)

    out: List[Dict[str, Any]] = []
    for tag in order:
        members = groups[tag]
        entry: Dict[str, Any] = {"tag": tag, "count": len(members), "rs": {}, "score": None,
                                 "symbols": [m["symbol"] for m in members]}
        for n in windows:
            key = str(n)
            vals = [m["rs"][key]["rs_pct"] for m in members if key in m["rs"]]
            if not vals:
                continue
            entry["rs"][key] = {
                "median_pct": round(_median(vals), 2),
                "beats": sum(1 for v in vals if v > 0),
                "total": len(vals),
            }
        scores = [m["score"] for m in members if m["score"] is not None]
        if scores:
            entry["score"] = round(_median(scores), 2)
        out.append(entry)
    out.sort(key=lambda e: (e["score"] is None, -(e["score"] or 0.0), e["tag"]))
    return out


# ================================================================ 拐点筛选:CD 背离
def _dif(closes: Sequence[float]) -> List[Optional[float]]:
    e12, e26 = _ema(list(closes), 12), _ema(list(closes), 26)
    return [(a - b) if (a is not None and b is not None) else None for a, b in zip(e12, e26)]


def _pivots(values: Sequence[float], strength: int, low: bool) -> List[int]:
    """摆动点下标:左右各 strength 根里没有更极端的价格(左侧允许打平,右侧要求严格)。"""
    out: List[int] = []
    n = len(values)
    for i in range(strength, n - strength):
        v = values[i]
        ok = True
        for j in range(i - strength, i + strength + 1):
            if j == i:
                continue
            other = values[j]
            if low:
                if other < v or (j > i and other == v):
                    ok = False
                    break
            else:
                if other > v or (j > i and other == v):
                    ok = False
                    break
        if ok:
            out.append(i)
    return out


def _divergence(
    prices: Sequence[float], dif: Sequence[Optional[float]], pivots: Sequence[int],
    bull: bool, max_span: int, max_age: int,
) -> Optional[Dict[str, int]]:
    """最近一个摆动点与它之前(span 之内)的某个摆动点是否构成背离。取最近的那一对。"""
    if len(pivots) < 2:
        return None
    last = len(prices) - 1
    p2 = pivots[-1]
    if last - p2 > max_age or dif[p2] is None:
        return None
    for p1 in reversed(pivots[:-1]):
        if p2 - p1 > max_span:
            break
        d1, d2 = dif[p1], dif[p2]
        if d1 is None:
            continue
        if bull:
            hit = prices[p2] < prices[p1] and d2 > d1 and d1 < 0 and d2 < 0
        else:
            hit = prices[p2] > prices[p1] and d2 < d1 and d1 > 0 and d2 > 0
        if hit:
            return {"p1": p1, "p2": p2}
    return None


def _confirmation(
    closes: Sequence[float], ma: Sequence[Optional[float]], p2: int, bull: bool, period: int,
) -> Dict[str, Any]:
    """右侧确认:背离之后收盘穿越均线,且最后一根仍在均线那一侧。"""
    if ma[-1] is None:
        return {"ma": period, "status": "n/a", "at": None, "age": None}
    crossed = None
    for i in range(p2 + 1, len(closes)):
        prev_ma, cur_ma = ma[i - 1], ma[i]
        if prev_ma is None or cur_ma is None:
            continue
        if bull and closes[i - 1] <= prev_ma and closes[i] > cur_ma:
            crossed = i
        elif not bull and closes[i - 1] >= prev_ma and closes[i] < cur_ma:
            crossed = i
    holding = closes[-1] > ma[-1] if bull else closes[-1] < ma[-1]
    if crossed is not None and holding:
        status = "confirmed"
    elif crossed is not None:
        status = "failed"       # 穿过去又回来了:确认作废
    else:
        status = "waiting"
    return {"ma": period, "status": status, "at": crossed, "age": (len(closes) - 1 - crossed) if crossed is not None else None}


def cd_divergence(
    bars: Optional[Sequence[Dict[str, Any]]],
    ma_period: Optional[int] = None,
    strength: int = DEFAULT_PIVOT_STRENGTH,
    max_span: int = DEFAULT_MAX_SPAN,
    max_age: int = DEFAULT_MAX_AGE,
) -> Dict[str, Any]:
    """单个序列上的左侧 CD 背离。底背离看最低价的摆动低点,顶背离看最高价的摆动高点。

    经典口径:底背离要求两个低点的 DIF 都在零轴之下,顶背离都在零轴之上——
    零轴另一侧的"背离"多半只是趋势中的正常回调,不算。
    同时出现顶底背离(震荡市里会有)时取更新鲜的那个,一样新取底背离。
    """
    rows = _clean(bars)
    closes = [b["close"] for b in rows]
    out: Dict[str, Any] = {
        "signal": None, "label": "无", "bars": len(rows),
        "last": round(closes[-1], 4) if closes else None,
        "dif_last": None, "dif_side": None, "pivots": [], "age": None,
        "price_gap_pct": None, "dif_gap": None, "confirm": None, "reason": None,
    }
    if len(rows) < MIN_CD_BARS:
        out["reason"] = "K 线不足 %d 根,算不出 DIF 摆动点" % MIN_CD_BARS
        return out
    dif = _dif(closes)
    out["dif_last"] = round(dif[-1], 4) if dif[-1] is not None else None
    if dif[-1] is not None:
        out["dif_side"] = "above" if dif[-1] > 0 else ("below" if dif[-1] < 0 else "zero")

    lows = [b["low"] for b in rows]
    highs = [b["high"] for b in rows]
    bull = _divergence(lows, dif, _pivots(lows, strength, True), True, max_span, max_age)
    bear = _divergence(highs, dif, _pivots(highs, strength, False), False, max_span, max_age)
    last = len(rows) - 1
    pick, is_bull = None, False
    if bull and bear:
        is_bull = (last - bull["p2"]) <= (last - bear["p2"])
        pick = bull if is_bull else bear
    elif bull:
        pick, is_bull = bull, True
    elif bear:
        pick, is_bull = bear, False
    if pick is None:
        out["reason"] = "最近 %d 根内没有新的背离摆动点" % max_age
        return out

    prices = lows if is_bull else highs
    p1, p2 = pick["p1"], pick["p2"]
    out["signal"] = "bull" if is_bull else "bear"
    out["label"] = SIGNAL_LABEL[out["signal"]]
    out["pivots"] = [
        {"index": p, "time": rows[p]["time"], "price": round(prices[p], 4), "dif": round(dif[p], 4)}
        for p in (p1, p2)
    ]
    out["age"] = last - p2
    out["price_gap_pct"] = round((prices[p2] / prices[p1] - 1.0) * 100.0, 2)
    out["dif_gap"] = round(dif[p2] - dif[p1], 4)
    if ma_period:
        ma = _sma(closes, int(ma_period))
        confirm = _confirmation(closes, ma, p2, is_bull, int(ma_period))
        if confirm["at"] is not None:
            confirm["at"] = rows[confirm["at"]]["time"]
        out["confirm"] = confirm
    return out


def screen_inflections(
    members: Sequence[Dict[str, Any]],
    timeframes: Sequence[str],
    ma_period: Optional[int] = None,
    strength: int = DEFAULT_PIVOT_STRENGTH,
) -> Dict[str, Any]:
    """整个股票池 × 多个周期。members 每项 {symbol, tag, frames: {tf: bars}, errors: {tf: msg}}。

    命中数多的排前面;确认过的背离比还在等的值钱,同为一个命中时确认的排前。
    """
    rows: List[Dict[str, Any]] = []
    per_tf: Dict[str, Dict[str, int]] = {tf: {"bull": 0, "bear": 0, "confirmed": 0} for tf in timeframes}
    for member in members:
        frames = member.get("frames") or {}
        errors = member.get("errors") or {}
        row: Dict[str, Any] = {
            "symbol": str(member.get("symbol") or "").upper(),
            "tag": str(member.get("tag") or "").strip() or UNTAGGED,
            "company": str(member.get("company") or ""),
            "signals": {}, "hits": 0, "confirmed": 0,
        }
        for tf in timeframes:
            if tf in errors and errors[tf]:
                row["signals"][tf] = {"error": str(errors[tf])}
                continue
            result = cd_divergence(frames.get(tf), ma_period=ma_period, strength=strength)
            row["signals"][tf] = result
            if result["signal"]:
                row["hits"] += 1
                per_tf[tf][result["signal"]] += 1
                confirm = result.get("confirm")
                if confirm and confirm["status"] == "confirmed":
                    row["confirmed"] += 1
                    per_tf[tf]["confirmed"] += 1
        rows.append(row)
    rows.sort(key=lambda r: (-r["hits"], -r["confirmed"], r["symbol"]))
    return {
        "timeframes": list(timeframes),
        "ma_period": int(ma_period) if ma_period else None,
        "rows": rows,
        "per_timeframe": per_tf,
        "hit_count": sum(1 for r in rows if r["hits"]),
        "total": len(rows),
    }


# ================================================================ 极值偏离
def _stdev(values: Sequence[float]) -> Optional[float]:
    n = len(values)
    if n < 2:
        return None
    mean = sum(values) / n
    var = sum((v - mean) ** 2 for v in values) / (n - 1)
    return sqrt(var)


def deviation_review(
    bars: Optional[Sequence[Dict[str, Any]]],
    period: int = DEFAULT_DEV_PERIOD,
    lookback: int = DEFAULT_DEV_LOOKBACK,
    smooth: int = DEFAULT_PRESSURE_SMOOTH,
    z_extreme: float = DEFAULT_Z_EXTREME,
    keep: int = DEFAULT_KEEP,
) -> Dict[str, Any]:
    """逐根算修正版买卖压力与偏离程度,返回最后 keep 根给界面画图。

    买卖压力的"修正"有三处:
      * 区间用**真实区间**(把前收盘算进高低点),跳空高开低走这种也能量出卖压;
      * 按相对成交量加权(当根量 / 前 20 根均量,封顶 3 倍):放量的那根说话更算数;
      * 再做 EMA 平滑,单根噪音不算数。
    偏离用收盘对 period 日均线的百分比,再对近 lookback 根折 z 分数——
    同样是偏离 8%,对一只日常波动 1% 的股是极值,对一只日常波动 5% 的股不算。
    """
    rows = _clean(bars)
    n = len(rows)
    period = max(2, int(period))
    lookback = max(MIN_Z_SAMPLES, int(lookback))
    smooth = max(1, int(smooth))
    out: Dict[str, Any] = {
        "period": period, "lookback": lookback, "smooth": smooth, "z_extreme": z_extreme,
        "bars": n, "series": [], "last": None, "extreme": None, "extreme_label": "—",
        "window": None, "readout": [],
    }
    if n < period + 2:
        out["readout"] = ["K 线不足 %d 根,算不出 %d 周期均线" % (period + 2, period)]
        return out

    closes = [b["close"] for b in rows]
    volumes = [b["volume"] for b in rows]
    raw: List[float] = []
    ratios: List[Optional[float]] = []
    vol_ma = _sma(volumes, 20)
    for i, bar in enumerate(rows):
        prev_close = closes[i - 1] if i > 0 else bar["open"]
        hi = max(bar["high"], prev_close)
        lo = min(bar["low"], prev_close)
        rng = hi - lo
        position = ((bar["close"] - lo) / rng * 2.0 - 1.0) if rng > 0 else 0.0
        base = vol_ma[i - 1] if i > 0 else None      # 对"之前"的均量比,当根自己不算进常态
        ratio = (bar["volume"] / base) if (base is not None and base > 0) else None
        weight = min(ratio, VOLUME_WEIGHT_CAP) if ratio is not None else 1.0
        raw.append(position * weight)
        ratios.append(ratio)
    pressure = _ema(raw, smooth) if smooth > 1 else [v for v in raw]

    ma = _sma(closes, period)
    dev: List[Optional[float]] = [
        ((c / m - 1.0) * 100.0) if (m is not None and m > 0) else None for c, m in zip(closes, ma)
    ]

    start = max(0, n - int(keep))
    series: List[Dict[str, Any]] = []
    for i in range(start, n):
        z = None
        rank = None
        if dev[i] is not None:
            hist = [v for v in dev[max(0, i - lookback + 1): i + 1] if v is not None]
            if len(hist) >= MIN_Z_SAMPLES:
                sd = _stdev(hist)
                mean = sum(hist) / len(hist)
                if sd and sd > 0:
                    z = (dev[i] - mean) / sd
                rank = sum(1 for v in hist if v <= dev[i]) / len(hist) * 100.0
        bar = rows[i]
        prev_close = closes[i - 1] if i > 0 else bar["open"]
        hi, lo = max(bar["high"], prev_close), min(bar["low"], prev_close)
        buy_pct = ((bar["close"] - lo) / (hi - lo) * 100.0) if hi > lo else 50.0
        series.append({
            "time": bar["time"],
            "close": round(bar["close"], 4),
            "ma": round(ma[i], 4) if ma[i] is not None else None,
            "dev_pct": round(dev[i], 2) if dev[i] is not None else None,
            "z": round(z, 2) if z is not None else None,
            "rank_pct": round(rank, 1) if rank is not None else None,
            "pressure": round(pressure[i], 3) if pressure[i] is not None else None,
            "buy_pct": round(buy_pct, 1),
            "volume_ratio": round(ratios[i], 2) if ratios[i] is not None else None,
        })
    out["series"] = series
    last = series[-1]
    out["last"] = last

    if last["z"] is not None:
        if last["z"] >= z_extreme:
            out["extreme"], out["extreme_label"] = "overbought", "上方极值(超买)"
        elif last["z"] <= -z_extreme:
            out["extreme"], out["extreme_label"] = "oversold", "下方极值(超卖)"
        else:
            out["extreme_label"] = "偏离在常态区间"
    else:
        out["extreme_label"] = "历史不足,未折 z 分数"

    with_dev = [s for s in series if s["dev_pct"] is not None]
    with_pressure = [s for s in series if s["pressure"] is not None]
    if with_dev and with_pressure:
        dev_max = max(with_dev, key=lambda s: s["dev_pct"])
        dev_min = min(with_dev, key=lambda s: s["dev_pct"])
        pr_max = max(with_pressure, key=lambda s: s["pressure"])
        pr_min = min(with_pressure, key=lambda s: s["pressure"])
        out["window"] = {
            "dev_max": {"time": dev_max["time"], "dev_pct": dev_max["dev_pct"]},
            "dev_min": {"time": dev_min["time"], "dev_pct": dev_min["dev_pct"]},
            "pressure_max": {"time": pr_max["time"], "pressure": pr_max["pressure"]},
            "pressure_min": {"time": pr_min["time"], "pressure": pr_min["pressure"]},
        }
    out["readout"] = _dev_readout(out, series, z_extreme)
    return out


def _dev_readout(result: Dict[str, Any], series: Sequence[Dict[str, Any]], z_extreme: float) -> List[str]:
    """把数字翻成几句人话。只陈述算出来的事实,不给操作建议。"""
    last = result["last"]
    lines: List[str] = []
    if last["dev_pct"] is not None:
        side = "上方" if last["dev_pct"] >= 0 else "下方"
        line = "收盘在 %d 周期均线%s %.2f%%" % (result["period"], side, abs(last["dev_pct"]))
        if last["z"] is not None:
            line += ",折近 %d 根历史 z = %+.2f(分位 %.0f%%)" % (result["lookback"], last["z"], last["rank_pct"])
        lines.append(line + "。")
    if last["pressure"] is not None:
        if last["pressure"] > 0.3:
            tone = "买压占优"
        elif last["pressure"] < -0.3:
            tone = "卖压占优"
        else:
            tone = "买卖压力接近均衡"
        lines.append("修正版买卖压力 %+.3f(%s),最近一根收盘位于真实区间 %.0f%% 处。"
                     % (last["pressure"], tone, last["buy_pct"]))
    if result["extreme"] == "overbought":
        lines.append("偏离已到上方极值:z ≥ %.1f,历史上这种拉伸幅度很少见。" % z_extreme)
        if last["pressure"] is not None and last["pressure"] < 0:
            lines.append("拉得很高但买压转负——推升的力量在减弱,注意衰竭。")
    elif result["extreme"] == "oversold":
        lines.append("偏离已到下方极值:z ≤ -%.1f,历史上这种下杀幅度很少见。" % z_extreme)
        if last["pressure"] is not None and last["pressure"] > 0:
            lines.append("跌得很深但买压转正——抛压在衰竭,拐点常在这种位置出现。")
    window = result.get("window")
    if window:
        lines.append("本段(%d 根)偏离最大 %+.2f%%(%s),最小 %+.2f%%(%s)。" % (
            len(series), window["dev_max"]["dev_pct"], window["dev_max"]["time"],
            window["dev_min"]["dev_pct"], window["dev_min"]["time"]))
    return lines
