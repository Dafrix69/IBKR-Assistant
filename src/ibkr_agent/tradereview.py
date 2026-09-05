"""交易复盘:一张蝴蝶 + 标的在开仓/平仓前后的 K 线 → 结构、盈亏区间、走势统计与规则化结论。

全部是纯函数,不碰券商、不碰存储:RPC 层把交易记录、同标的的其它记录和 K 线喂进来,
这里只负责"算"和"说"。结论怎么来的每一条都能在 `stats` 里对上数——和 K 线 PA 一样,
判断由代码算,不由模型猜。

几条口径,写在最前面免得算错:
* **标的价格用 K 线收盘价**,开仓/平仓时点对齐到"该时刻或之前最后一根 K 线"。
  时间戳全系统按美东,K 线的 `time` 也是美东字符串,比较前先把成交时间换到美东。
* **理论价值 = 到期内在价值**(蝴蝶的"帐篷")。持有期间的期权真实价格拿不到,
  所以"持有期间最好的时刻"说的是"若在那一刻到期",是下界,不是当时能卖到的价。
* **盈亏平衡与最大盈亏按成交均价算**,没成交就用限价并明确标注"估算"。
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence

from .config import ET

LOOKBACK_BARS = 40      # 开仓前给多少根 K 线看背景
LOOKAHEAD_BARS = 20     # 平仓/到期后再给多少根
MAX_WINDOW = 240        # 回给界面的 K 线上限
PRE_TREND_BARS = 20     # "开仓前走势"看多少根
POST_ENTRY_BARS = 6     # "开仓后短期走势"看多少根

KIND_CLOSED = "closed"
KIND_EXPIRED = "expired"
KIND_OPEN = "open"


class ReviewError(ValueError):
    pass


# ----------------------------------------------------------------------
# 结构
# ----------------------------------------------------------------------
def _num(value: Any) -> Optional[float]:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def fmt_expiry(raw: Any) -> str:
    s = str(raw or "")
    if re.fullmatch(r"\d{8}", s):
        return "%s-%s-%s" % (s[:4], s[4:6], s[6:8])
    return s


def butterfly_profile(record: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """从交易记录里认出一张蝴蝶;不是蝴蝶就回 None,不猜。"""
    contract = record.get("contract") or {}
    if contract.get("secType") != "BAG":
        return None
    legs = list(contract.get("legs") or [])
    if len(legs) != 3:
        return None
    rows = []
    for leg in legs:
        strike = _num(leg.get("strike"))
        if strike is None:
            return None
        rows.append((strike, int(leg.get("ratio") or 1), str(leg.get("action") or ""), leg))
    rows.sort(key=lambda r: r[0])
    (k1, r1, a1, l1), (k2, r2, a2, l2), (k3, r3, a3, l3) = rows
    if (r1, r2, r3) != (1, 2, 1) or a1 != a3 or a2 == a1:
        return None
    rights = {str(l.get("right") or "") for l in (l1, l2, l3)}
    expiries = {str(l.get("lastTradeDateOrContractMonth") or "") for l in (l1, l2, l3)}
    if len(rights) != 1 or len(expiries) != 1:
        return None

    order = record.get("order") or {}
    ibkr = record.get("ibkr") or {}
    action = str(order.get("action") or "BUY").upper()
    fill = _num(ibkr.get("avg_fill_price"))
    limit = _num(order.get("lmtPrice"))
    debit = fill if fill is not None else limit
    qty = int(_num(order.get("totalQuantity")) or 1)
    multiplier = _num(contract.get("multiplier")) or _num(l1.get("multiplier")) or 100.0
    right = rights.pop()
    expiry_raw = expiries.pop()
    return {
        "symbol": str(contract.get("symbol") or ""),
        "right": right,
        "right_label": "看跌" if right == "P" else "看涨",
        "expiry": fmt_expiry(expiry_raw),
        "expiry_raw": expiry_raw,
        "lower": k1, "center": k2, "upper": k3,
        "width": round(k2 - k1, 4),
        "width_upper": round(k3 - k2, 4),
        "symmetric": abs((k2 - k1) - (k3 - k2)) < 1e-9,
        "action": action,
        "qty": qty,
        "multiplier": multiplier,
        "debit": debit,
        "price_estimated": fill is None,
        "trading_class": str(l1.get("tradingClass") or ""),
    }


def same_butterfly(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    return (a["symbol"] == b["symbol"] and a["right"] == b["right"] and a["expiry_raw"] == b["expiry_raw"]
            and a["lower"] == b["lower"] and a["center"] == b["center"] and a["upper"] == b["upper"])


def payoff_per_unit(profile: Dict[str, Any], s: float) -> float:
    """到期内在价值(每单位标的,不含乘数):多头蝴蝶的帐篷。"""
    k1, k2, k3 = profile["lower"], profile["center"], profile["upper"]
    if profile["right"] == "P":
        v = max(k1 - s, 0.0) - 2 * max(k2 - s, 0.0) + max(k3 - s, 0.0)
    else:
        v = max(s - k1, 0.0) - 2 * max(s - k2, 0.0) + max(s - k3, 0.0)
    return round(v, 4)


def pnl_at(profile: Dict[str, Any], s: float) -> Optional[float]:
    """到期时若标的在 s,这笔交易的盈亏(美元,含乘数与张数)。没有成交价就算不出。"""
    debit = profile.get("debit")
    if debit is None:
        return None
    sign = 1.0 if profile["action"] == "BUY" else -1.0
    return round(sign * (payoff_per_unit(profile, s) - debit) * profile["multiplier"] * profile["qty"], 2)


def zone(profile: Dict[str, Any]) -> Dict[str, Any]:
    """盈亏平衡点与最大盈亏。空头蝴蝶盈亏正好反过来,区间边界不变。"""
    debit = profile.get("debit")
    mult, qty = profile["multiplier"], profile["qty"]
    if debit is None:
        return {"lower_be": None, "upper_be": None, "max_profit": None, "max_loss": None,
                "known": False}
    width = min(profile["width"], profile["width_upper"])
    tent = (width - debit) * mult * qty
    premium = debit * mult * qty
    long = profile["action"] == "BUY"
    return {
        "lower_be": round(profile["lower"] + debit, 4),
        "upper_be": round(profile["upper"] - debit, 4),
        "max_profit": round(tent if long else premium, 2),
        "max_loss": round(premium if long else tent, 2),
        "known": True,
    }


# ----------------------------------------------------------------------
# 时间
# ----------------------------------------------------------------------
def parse_when(value: Any) -> Optional[datetime]:
    """成交时间 / 记录时间 → aware datetime。

    三种形态都要接:ISO 带时区(记录的 created_at、ib_insync 的 exec.time)、
    IBKR 原样的 '20260903 09:52:10'(按美东理解——全系统的钟)、以及 K 线那种
    'YYYY-MM-DD HH:MM'(同样美东)。解析不了回 None,由调用方决定是否退到别的时间。
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=ET)
    s = str(value).strip()
    if not s:
        return None
    try:
        m = re.fullmatch(r"(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})", s)
        if m:
            y, mo, d, h, mi, se = (int(x) for x in m.groups())
            return datetime(y, mo, d, h, mi, se, tzinfo=ET)
        m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?", s)
        if m:
            y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
            h = int(m.group(4) or 0)
            mi = int(m.group(5) or 0)
            se = int(m.group(6) or 0)
            return datetime(y, mo, d, h, mi, se, tzinfo=ET)
        out = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return out if out.tzinfo else out.replace(tzinfo=ET)


def et_key(when: datetime, daily: bool) -> str:
    """把时刻换成能和 K 线 time 字符串直接比大小的键。"""
    local = when.astimezone(ET)
    return local.strftime("%Y-%m-%d") if daily else local.strftime("%Y-%m-%d %H:%M")


def entry_of(record: Dict[str, Any]) -> Dict[str, Any]:
    fills = list((record.get("ibkr") or {}).get("fills") or [])
    times = [t for t in (parse_when(f.get("time")) for f in fills) if t is not None]
    if times:
        return {"time": min(times), "estimated": False}
    created = parse_when(record.get("created_at"))
    if created is None:
        raise ReviewError("这条记录既没有成交时间也没有提交时间,无法定位开仓时刻。")
    return {"time": created, "estimated": True}


def find_exit(profile: Dict[str, Any], entry_time: datetime, others: Sequence[Dict[str, Any]],
              exclude_id: Any) -> Optional[Dict[str, Any]]:
    """在其它记录里找同一张蝴蝶的反向成交单——那就是平仓。"""
    best = None
    for other in others:
        if other.get("id") == exclude_id:
            continue
        p = butterfly_profile(other)
        if p is None or not same_butterfly(p, profile) or p["action"] == profile["action"]:
            continue
        ibkr = other.get("ibkr") or {}
        fill = _num(ibkr.get("avg_fill_price"))
        if fill is None and other.get("final_status") != "filled":
            continue
        times = [t for t in (parse_when(f.get("time")) for f in (ibkr.get("fills") or [])) if t]
        when = min(times) if times else parse_when(other.get("created_at"))
        if when is None or when < entry_time:
            continue
        if best is None or when < best["time"]:
            best = {"time": when, "price": fill, "record_id": other.get("id"), "estimated": fill is None}
    return best


def expiry_close(profile: Dict[str, Any]) -> datetime:
    """到期结算时刻:按收盘 16:00 美东(SPXW 等 PM 结算;AM 结算的月度合约会晚报几小时,不影响结论)。"""
    y, m, d = (int(x) for x in profile["expiry"].split("-"))
    return datetime(y, m, d, 16, 0, tzinfo=ET)


# ----------------------------------------------------------------------
# K 线定位与统计
# ----------------------------------------------------------------------
def _is_daily(bars: Sequence[Dict[str, Any]]) -> bool:
    return bool(bars) and len(str(bars[0].get("time") or bars[0].get("date") or "")) <= 10


def _bar_time(bar: Dict[str, Any]) -> str:
    return str(bar.get("time") or bar.get("date") or "")


def index_at(bars: Sequence[Dict[str, Any]], when: datetime, daily: bool) -> Optional[int]:
    """该时刻或之前最后一根 K 线的下标;时刻早于第一根就回 None。"""
    key = et_key(when, daily)
    out = None
    for i, bar in enumerate(bars):
        if _bar_time(bar) <= key:
            out = i
        else:
            break
    return out


def _closest(profile: Dict[str, Any], bars: Sequence[Dict[str, Any]], lo: int, hi: int):
    best = None
    for i in range(lo, hi + 1):
        c = _num(bars[i].get("close"))
        if c is None:
            continue
        d = abs(c - profile["center"])
        if best is None or d < best[0]:
            best = (d, i, c)
    return best


def _bar_seconds(timeframe: str, daily: bool) -> int:
    """一根 K 线跨多少秒:判断"最后一根之后"的开仓时刻算不算被覆盖。"""
    if daily:
        return 86400
    m = re.fullmatch(r"(\d+)([mhd])", str(timeframe or ""))
    if not m:
        return 300
    n, unit = int(m.group(1)), m.group(2)
    return n * {"m": 60, "h": 3600, "d": 86400}[unit]


def pick_timeframe(entry_time: datetime, now: datetime) -> str:
    """按交易离现在多远选周期:越近越细。日内周期受 IBKR 拉取窗口限制(见 TIMEFRAMES)。"""
    age = (now - entry_time).total_seconds() / 86400.0
    if age <= 1.5:
        return "1m"
    if age <= 4.5:
        return "5m"
    if age <= 9.5:
        return "15m"
    if age <= 28:
        return "1h"
    return "1d"


def review(
    record: Dict[str, Any],
    others: Sequence[Dict[str, Any]],
    bars: Sequence[Dict[str, Any]],
    timeframe: str,
    now: datetime,
) -> Dict[str, Any]:
    """一张蝴蝶的完整复盘。bars 必须按时间升序,time 为美东字符串。"""
    profile = butterfly_profile(record)
    if profile is None:
        raise ReviewError("这条记录不是蝴蝶组合(需要 1:2:1 三腿、同到期、同方向)。")
    if not bars:
        raise ReviewError("没有 K 线,无法复盘。")
    daily = _is_daily(bars)
    z = zone(profile)
    notes: List[str] = []
    if profile["price_estimated"]:
        notes.append("这笔单没有成交均价,盈亏区间与最大盈亏按限价估算" if profile["debit"] is not None
                     else "这笔单没有成交价也没有限价,算不出盈亏区间与盈亏")

    entry = entry_of(record)
    if entry["estimated"]:
        notes.append("没有成交时间,开仓时刻按提交时间算")
    entry_idx = index_at(bars, entry["time"], daily)
    last_time = parse_when(_bar_time(bars[-1]))
    covered = entry_idx is not None and (
        last_time is None or entry["time"] <= last_time + timedelta(seconds=_bar_seconds(timeframe, daily))
    )
    if not covered:
        raise ReviewError("K 线窗口没有覆盖到开仓时刻(%s),换更长的周期再试。" % et_key(entry["time"], daily))

    # ---- 结局:平仓 / 到期 / 持仓中
    exit_rec = find_exit(profile, entry["time"], others, record.get("id"))
    last_idx = len(bars) - 1
    if exit_rec is not None:
        kind = KIND_CLOSED
        exit_time = exit_rec["time"]
        exit_idx = index_at(bars, exit_time, daily)
        if exit_idx is None or exit_idx < entry_idx:
            exit_idx = entry_idx
        if exit_rec["estimated"]:
            notes.append("平仓单没有成交均价,平仓价按记录估算不出,盈亏留空")
    elif now >= expiry_close(profile):
        kind = KIND_EXPIRED
        exit_time = expiry_close(profile)
        exit_idx = index_at(bars, exit_time, daily)
        if exit_idx is None or exit_idx < entry_idx:
            exit_idx = entry_idx
    else:
        kind = KIND_OPEN
        exit_time = None
        exit_idx = last_idx

    entry_close = _num(bars[entry_idx].get("close"))
    exit_close = _num(bars[exit_idx].get("close"))
    if entry_close is None or exit_close is None:
        raise ReviewError("K 线里有空收盘价,无法复盘。")

    # ---- 持有期统计
    hold = bars[entry_idx: exit_idx + 1]
    highs = [_num(b.get("high")) for b in hold]
    lows = [_num(b.get("low")) for b in hold]
    hi_val = max(h for h in highs if h is not None)
    lo_val = min(l for l in lows if l is not None)
    closest = _closest(profile, bars, entry_idx, exit_idx)
    farthest = max(
        ((abs(_num(b.get("close")) - profile["center"]), i) for i, b in enumerate(bars[entry_idx: exit_idx + 1], entry_idx)
         if _num(b.get("close")) is not None),
        key=lambda t: t[0],
    )
    in_zone = touched = 0
    if z["known"]:
        for b in hold:
            c, h, l = _num(b.get("close")), _num(b.get("high")), _num(b.get("low"))
            if c is not None and z["lower_be"] <= c <= z["upper_be"]:
                in_zone += 1
            if h is not None and l is not None and l <= z["upper_be"] and h >= z["lower_be"]:
                touched += 1
    best_pnl = None
    best_idx = None
    if z["known"]:
        for i in range(entry_idx, exit_idx + 1):
            c = _num(bars[i].get("close"))
            if c is None:
                continue
            p = pnl_at(profile, c)
            if best_pnl is None or (p is not None and p > best_pnl):
                best_pnl, best_idx = p, i

    pre_idx = max(entry_idx - PRE_TREND_BARS, 0)
    pre_close = _num(bars[pre_idx].get("close"))
    pre_move = None if (pre_close is None or pre_idx == entry_idx) else round(entry_close - pre_close, 4)
    post_idx = min(entry_idx + POST_ENTRY_BARS, exit_idx)
    post_close = _num(bars[post_idx].get("close"))
    post_move = None if (post_close is None or post_idx == entry_idx) else round(post_close - entry_close, 4)

    dist_entry = round(entry_close - profile["center"], 4)
    dist_exit = round(exit_close - profile["center"], 4)
    width = profile["width"] or 1.0

    # ---- 结局数字
    settle_value = payoff_per_unit(profile, exit_close)
    exit_price = exit_rec["price"] if (exit_rec is not None) else (settle_value if kind == KIND_EXPIRED else None)
    pnl = None
    pnl_pct = None
    if profile["debit"] is not None and exit_price is not None:
        sign = 1.0 if profile["action"] == "BUY" else -1.0
        pnl = round(sign * (exit_price - profile["debit"]) * profile["multiplier"] * profile["qty"], 2)
        basis = profile["debit"] * profile["multiplier"] * profile["qty"]
        pnl_pct = round(pnl / basis * 100.0, 1) if basis else None
    pnl_if_now = pnl_at(profile, exit_close) if kind == KIND_OPEN else None

    stats = {
        "entry_underlying": entry_close,
        "exit_underlying": exit_close,
        "move_points": round(exit_close - entry_close, 4),
        "dist_entry": dist_entry,
        "dist_entry_widths": round(dist_entry / width, 2),
        "dist_exit": dist_exit,
        "dist_exit_widths": round(dist_exit / width, 2),
        "moved_toward_center": abs(dist_exit) < abs(dist_entry),
        "hold_bars": len(hold),
        "hold_high": hi_val,
        "hold_low": lo_val,
        "closest": None if closest is None else {
            "price": closest[2], "distance": round(closest[0], 4), "time": _bar_time(bars[closest[1]]),
        },
        "farthest": {"distance": round(farthest[0], 4), "time": _bar_time(bars[farthest[1]])},
        "in_zone_bars": in_zone if z["known"] else None,
        "in_zone_ratio": round(in_zone / len(hold), 3) if (z["known"] and hold) else None,
        "touched_zone_bars": touched if z["known"] else None,
        "best_theoretical": None if best_idx is None else {
            "pnl": best_pnl, "time": _bar_time(bars[best_idx]), "underlying": _num(bars[best_idx].get("close")),
        },
        "pre_entry_move": pre_move,
        "pre_entry_bars": entry_idx - pre_idx,
        "post_entry_move": post_move,
        "post_entry_bars": post_idx - entry_idx,
        "settle_value": settle_value,
    }

    outcome = {
        "kind": kind,
        "time": None if exit_time is None else exit_time.astimezone(timezone.utc).isoformat(),
        "time_et": None if exit_time is None else et_key(exit_time, False),
        "price": exit_price,
        "underlying": exit_close,
        "pnl": pnl,
        "pnl_pct": pnl_pct,
        "pnl_if_expired_now": pnl_if_now,
        "record_id": None if exit_rec is None else exit_rec["record_id"],
    }
    entry_out = {
        "time": entry["time"].astimezone(timezone.utc).isoformat(),
        "time_et": et_key(entry["time"], False),
        "estimated": entry["estimated"],
        "price": profile["debit"],
        "price_estimated": profile["price_estimated"],
        "underlying": entry_close,
        "bar_time": _bar_time(bars[entry_idx]),
    }

    # ---- 图:窗口 + 标记 + 关键位
    lo_i = max(entry_idx - LOOKBACK_BARS, 0)
    hi_i = min(exit_idx + LOOKAHEAD_BARS, last_idx)
    window = list(bars[lo_i: hi_i + 1])
    if len(window) > MAX_WINDOW:
        # 保住开仓与结局两端,中间按步长抽稀
        step = math.ceil(len(window) / MAX_WINDOW)
        keep = [b for i, b in enumerate(window) if i % step == 0]
        for must in (entry_idx - lo_i, exit_idx - lo_i):
            if window[must] not in keep:
                keep.append(window[must])
        keep.sort(key=_bar_time)
        window = keep
    markers = [{"kind": "entry", "time": _bar_time(bars[entry_idx]), "price": entry_close}]
    if kind != KIND_OPEN:
        markers.append({"kind": "exit" if kind == KIND_CLOSED else "expiry",
                        "time": _bar_time(bars[exit_idx]), "price": exit_close})
    levels = [
        {"kind": "lower", "price": profile["lower"]},
        {"kind": "center", "price": profile["center"]},
        {"kind": "upper", "price": profile["upper"]},
    ]
    if z["known"]:
        levels.append({"kind": "lower_be", "price": z["lower_be"]})
        levels.append({"kind": "upper_be", "price": z["upper_be"]})

    findings = build_findings(profile, z, entry_out, outcome, stats)
    return {
        "profile": profile,
        "zone": z,
        "entry": entry_out,
        "outcome": outcome,
        "stats": stats,
        "findings": findings,
        "series": {"timeframe": timeframe, "daily": daily, "bars": window, "markers": markers, "levels": levels},
        "notes": notes,
        "reviewed_at": now.astimezone(timezone.utc).isoformat(),
    }


# ----------------------------------------------------------------------
# 结论(规则化文字)
# ----------------------------------------------------------------------
def _pts(v: float) -> str:
    return ("%.2f" % v).rstrip("0").rstrip(".")


def _money(v: Optional[float]) -> str:
    if v is None:
        return "—"
    return ("%+.2f" % v) if v < 0 else ("+%.2f" % v)


def build_findings(profile, z, entry, outcome, stats) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    long = profile["action"] == "BUY"
    verb = "买入" if long else "卖出"
    what = "%s %s %s/%s/%s %s蝴蝶(翼宽 %s)" % (
        verb, profile["symbol"], _pts(profile["lower"]), _pts(profile["center"]), _pts(profile["upper"]),
        profile["right_label"], _pts(profile["width"]),
    )
    if z["known"]:
        out.append({"tone": "info", "title": "结构", "text":
            "%s,权利金 %s%s;到期盈利区 %s ~ %s,最大盈利 %s,最大亏损 %s。" % (
                what, _pts(profile["debit"]), "(估算)" if profile["price_estimated"] else "",
                _pts(z["lower_be"]), _pts(z["upper_be"]), "%.2f" % z["max_profit"], "%.2f" % z["max_loss"])})
    else:
        out.append({"tone": "info", "title": "结构", "text": what + ",没有成交价,盈亏区间未知。"})

    d = stats["dist_entry"]
    side = "上方" if d > 0 else "下方"
    need = ("下跌" if d > 0 else "上涨") if long else "远离中心"
    # 多头蝴蝶要标的朝中心走;空头正好相反
    favor = (lambda toward: toward) if long else (lambda toward: not toward)
    if abs(stats["dist_entry_widths"]) <= 0.5:
        pos = "开仓时标的 %s 就在中心附近(偏 %s %s 点),结构一开始就在帐篷里。" % (
            _pts(entry["underlying"]), side, _pts(abs(d)))
        tone = "good"
    elif abs(stats["dist_entry_widths"]) <= 2:
        pos = "开仓时标的 %s 在中心%s %s 点(%.1f 个翼宽),需要标的%s到区间内。" % (
            _pts(entry["underlying"]), side, _pts(abs(d)), abs(stats["dist_entry_widths"]), need)
        tone = "info"
    else:
        pos = "开仓时标的 %s 离中心 %s 点(%.1f 个翼宽),这是一张押方向的远端蝴蝶,靠标的%s才有价值。" % (
            _pts(entry["underlying"]), _pts(abs(d)), abs(stats["dist_entry_widths"]), need)
        tone = "warn"
    out.append({"tone": tone, "title": "开仓位置", "text": pos})

    if stats["pre_entry_move"] is not None:
        mv = stats["pre_entry_move"]
        toward = (mv < 0) == (d > 0)     # 开仓前的走势是否朝中心
        out.append({"tone": "good" if favor(toward) else "warn", "title": "开仓前走势",
                    "text": "开仓前 %d 根 K 线标的%s %s 点,%s。" % (
                        stats["pre_entry_bars"], "上涨" if mv > 0 else "下跌", _pts(abs(mv)),
                        "顺着蝴蝶要的方向" if favor(toward) else "与蝴蝶要的方向相反(逆势进场)")})
    if stats["post_entry_move"] is not None:
        mv = stats["post_entry_move"]
        toward = (mv < 0) == (d > 0)
        out.append({"tone": "good" if favor(toward) else "warn", "title": "开仓后走势",
                    "text": "开仓后 %d 根 K 线标的%s %s 点,%s。" % (
                        stats["post_entry_bars"], "上涨" if mv > 0 else "下跌", _pts(abs(mv)),
                        "朝中心走" if toward else "背离中心")})

    c = stats["closest"]
    if c is not None and stats["hold_bars"] > 1:
        text = "持有期间标的区间 %s ~ %s;最接近中心 %s(%s,距中心 %s 点)。" % (
            _pts(stats["hold_low"]), _pts(stats["hold_high"]), _pts(c["price"]), c["time"], _pts(c["distance"]))
        if stats["in_zone_ratio"] is not None:
            text += " 收盘落在盈利区内的 K 线 %d/%d(%.0f%%)。" % (
                stats["in_zone_bars"], stats["hold_bars"], stats["in_zone_ratio"] * 100)
        out.append({"tone": "info", "title": "持有期", "text": text})

    bt = stats["best_theoretical"]
    if bt is not None and bt["pnl"] is not None and bt["pnl"] > 0 and outcome["kind"] != KIND_OPEN:
        realized = outcome["pnl"]
        if realized is None or bt["pnl"] > realized:
            out.append({"tone": "warn", "title": "曾有的机会",
                        "text": "%s 标的到 %s,若当时到期理论盈利 %s(内在价值口径,是下界);最终结果 %s。" % (
                            bt["time"], _pts(bt["underlying"]), _money(bt["pnl"]), _money(realized))})

    k = outcome["kind"]
    if k == KIND_CLOSED:
        out.append({"tone": "good" if (outcome["pnl"] or 0) > 0 else "bad", "title": "平仓",
                    "text": "%s 以 %s 平仓,盈亏 %s(%s%%),平仓时标的 %s(距中心 %s 点)。" % (
                        outcome["time_et"], "—" if outcome["price"] is None else _pts(outcome["price"]),
                        _money(outcome["pnl"]), "—" if outcome["pnl_pct"] is None else "%.1f" % outcome["pnl_pct"],
                        _pts(outcome["underlying"]), _pts(abs(stats["dist_exit"])))})
    elif k == KIND_EXPIRED:
        inside = z["known"] and z["lower_be"] <= outcome["underlying"] <= z["upper_be"]
        out.append({"tone": "good" if (outcome["pnl"] or 0) > 0 else "bad", "title": "到期",
                    "text": "到期结算标的 %s,%s,结构价值 %s,盈亏 %s(%s%%)。" % (
                        _pts(outcome["underlying"]),
                        ("落在盈利区内" if inside else "落在盈利区外") if z["known"] else "盈利区未知",
                        _pts(stats["settle_value"]), _money(outcome["pnl"]),
                        "—" if outcome["pnl_pct"] is None else "%.1f" % outcome["pnl_pct"])})
    else:
        out.append({"tone": "info", "title": "持仓中",
                    "text": "尚未到期,最新标的 %s(距中心 %s 点),若此刻到期盈亏 %s。" % (
                        _pts(outcome["underlying"]), _pts(abs(stats["dist_exit"])), _money(outcome["pnl_if_expired_now"]))})

    if k != KIND_OPEN:
        if favor(stats["moved_toward_center"]):
            out.append({"tone": "good", "title": "方向", "text": "方向判断正确:标的从开仓到结局朝中心靠近了 %s 点。" % (
                _pts(abs(stats["dist_entry"]) - abs(stats["dist_exit"])))})
        else:
            out.append({"tone": "bad", "title": "方向", "text": "方向判断有误:标的从开仓到结局离中心更远了 %s 点。" % (
                _pts(abs(stats["dist_exit"]) - abs(stats["dist_entry"])))})
    return out
