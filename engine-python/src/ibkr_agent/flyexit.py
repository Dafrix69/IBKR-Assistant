"""SPX 0DTE 多头蝶式止盈策略(用户文档 v2.0,2026-09-03)——点位、预计盈利与逐分钟回放。

全部是纯函数。v2.1 起止盈换成**浮盈回撤追踪**,不再用固定倍数档位:
* 任意时段:蝶价 ≥ trail_arm×D(默认 1.3)后开始记录浮盈高水位;浮盈从高水位回吐掉
  当前档位的比例就全清。文档 v2.0 只在阶段 B 追踪,v2.1 改为全天生效。
* 回撤比例按浮盈分档收紧——蝶式的盈利有硬天花板(最大值 = 翼宽 W),浮盈越大剩余上涨空间
  越小、下跌风险越大,所以越靠近天花板收得越紧:
  浮盈 < 1×D → 40%;1×D–3×D → 30%;> 3×D → 20%;15:00 之后一律再乘 0.5。
* 两道闸:回吐金额小于 trail_floor(默认 0.20 点,约一个组合价差)不触发,免得在 mid 噪声里被扫;
  阶段 C 的区间规则仍然优先于追踪(σ_剩余 太小时蝶价由内在价值决定,位置比价格干净)。
* 固定倍数档位(tp1/tp2)默认关闭。显式传 {"tp1": 1.35, "tp2": 1.7} 可以恢复 v2.0 的分批止盈,
  两者可以并存:固定档位先分批落袋,剩余仓位交给回撤追踪。
* 阶段 B(14:00 – σ_剩余 = W/1.6,约 15:25):|S−K| > 0.45W 全清;14:00 留仓压到 1/3(至少 1 张)。
* 阶段 C(σ_剩余 < W/1.6 – 结算):|S−K| < 0.45W 持到结算;0.45W–0.55W 清一半;> 0.55W 立即清残值。
* 任意时刻:蝶价 ≤ 0.5×D 止损;|S−K| > 0.8W 且剩余方差 > 30% 止损。
* σ_剩余 = EM × √R,R 按文档 §3 的半小时方差权重;EM 默认 36(文档 8/11 实测),可传入。

几条落地口径,文档没写死、这里必须定下来:
* **蝶价用组合分钟线的收盘(中间价)**;拿不到真实蝶价的分钟用 Bachelier 正态模型价(σ_剩余)补,
  并逐分钟标注 source=model。触发判断文档要求"按 bid",这里只有 mid——回放结果会略偏乐观,
  高水位尤其吃亏:mid 的瞬时虚高会把回撤线一起抬上去。trail_floor 就是为此留的余量。
* 回撤按**浮盈**(蝶价 − D)算,不是按蝶价算。同样叫"回撤 30%",两种口径能差出一倍以上的让利。
* 张数不足 3 张时"清 1/3"按 max(1, n//3) 张执行;1 张的单第一档就是全清。
* 回放只适用于**多头**蝶;空头蝶返回 applicable=False。
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence

# 文档 §3:09:30 起每半小时占全日方差的比例
VARIANCE_WEIGHTS = [0.15, 0.09, 0.07, 0.06, 0.05, 0.04, 0.04, 0.04, 0.05, 0.06, 0.07, 0.11, 0.17]
OPEN_MIN = 9 * 60 + 30
CLOSE_MIN = 16 * 60

DEFAULTS: Dict[str, Any] = {
    "em": 36.0,          # 当日 0DTE 隐含日内波动(点),文档要求每日从 ATM straddle 取
    "tp1": None,         # 固定档位第一档:蝶价 / D。默认关闭,传正数才启用
    "tp2": None,         # 固定档位第二档,同上
    "stop": 0.5,         # 止损:蝶价 / D
    "trail_arm": 1.3,    # 回撤追踪激活:蝶价 / D
    "trail": 0.30,       # 中档回撤比例(浮盈 1×D – 3×D)
    "trail_loose_below": 1.0,   # 浮盈低于这个倍数×D 时放宽到 trail_loose
    "trail_loose": 0.40,
    "trail_tight_at": 3.0,      # 浮盈达到这个倍数×D 时收紧到 trail_tight
    "trail_tight": 0.20,
    "trail_floor": 0.20, # 回吐金额低于这么多点不触发(约一个组合价差,躲 mid 噪声)
    "trail_late": "15:00",      # 这个钟点之后回撤比例乘 trail_late_factor
    "trail_late_factor": 0.5,
    "zone_hold": 0.45,   # |S−K| / W 临界线
    "zone_half": 0.55,
    "zone_stop": 0.8,
    "stop_var": 0.30,    # 位置止损附带条件:剩余方差 > 30%
    "cutoff_a": "14:00", # 阶段 A → B 的钟表时间
    "switch_k": 1.6,     # 阶段 B → C:σ_剩余 < W / switch_k
    "otm_band": 10.0,    # 远端 OTM 蝶(文档 §2.3):标的进入 K ± 这么多点就分批落袋
}


CLOCK_KEYS = ("cutoff_a", "trail_late")   # 取 "HH:MM" 而不是数字的参数


def params_from(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    out = dict(DEFAULTS)
    for key, value in (raw or {}).items():
        if key not in DEFAULTS or value is None:
            continue
        if key in CLOCK_KEYS:
            out[key] = str(value)
        else:
            try:
                v = float(value)
            except (TypeError, ValueError):
                continue
            if math.isfinite(v) and v > 0:
                out[key] = v
    return out


# ----------------------------------------------------------------------
# 时间与方差
# ----------------------------------------------------------------------
def minutes_of(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def remaining_variance(minute: int) -> float:
    """时刻(自零点起的分钟数)→ 剩余方差比例 R。半小时桶内线性插值;开盘前 1,收盘后 0。"""
    if minute <= OPEN_MIN:
        return 1.0
    if minute >= CLOSE_MIN:
        return 0.0
    elapsed = minute - OPEN_MIN
    bucket = elapsed // 30
    frac = (elapsed - bucket * 30) / 30.0
    used = sum(VARIANCE_WEIGHTS[:bucket]) + VARIANCE_WEIGHTS[bucket] * frac
    return round(max(0.0, min(1.0, 1.0 - used)), 6)


def sigma_remaining(em: float, minute: int) -> float:
    return round(em * math.sqrt(remaining_variance(minute)), 4)


def phase_at(minute: int, width: float, params: Dict[str, Any]) -> str:
    if minute < minutes_of(params["cutoff_a"]):
        return "A"
    if sigma_remaining(params["em"], minute) < width / params["switch_k"]:
        return "C"
    return "B"


def switch_minute(width: float, params: Dict[str, Any]) -> int:
    """阶段 C 从哪一分钟开始(σ_剩余 第一次低于 W/k)。"""
    threshold = width / params["switch_k"]
    for minute in range(OPEN_MIN, CLOSE_MIN + 1):
        if sigma_remaining(params["em"], minute) < threshold:
            return minute
    return CLOSE_MIN


def fmt_minute(minute: int) -> str:
    return "%02d:%02d" % divmod(minute, 60)


# ----------------------------------------------------------------------
# 回撤追踪
# ----------------------------------------------------------------------
def trail_pct(profit_peak: float, d: float, minute: int, params: Dict[str, Any]) -> float:
    """当前该用的回撤比例。浮盈越接近蝶式的天花板收得越紧,尾盘再收一道。"""
    if profit_peak < params["trail_loose_below"] * d:
        pct = params["trail_loose"]
    elif profit_peak >= params["trail_tight_at"] * d:
        pct = params["trail_tight"]
    else:
        pct = params["trail"]
    if minute >= minutes_of(params["trail_late"]):
        pct *= params["trail_late_factor"]
    return round(pct, 6)


def trail_stop(profit_peak: float, d: float, minute: int, params: Dict[str, Any]) -> float:
    """回撤触发价:浮盈高水位让掉当前档位比例之后剩下的蝶价。"""
    return round(d + profit_peak * (1.0 - trail_pct(profit_peak, d, minute, params)), 4)


def drawdown_tiers(raw: Optional[Dict[str, Any]] = None) -> List[Dict[str, float]]:
    """把这套分档导出成 tracker.Targets.profit_drawdown_tiers 的形状(百分点)。

    实盘那套按"浮盈 / 成本"选档,回放这套按"浮盈 / D"——对同一张组合是同一个数:
    浮盈 = (现价 − D) × 数量 × 乘数、成本 = D × 数量 × 乘数,两边同乘的部分约掉了。
    所以档位可以逐字搬过去,不必再传 D。这里是**唯一事实源**,实盘别另写一份。
    """
    p = params_from(raw)
    return [
        {"above": 0.0, "pct": round(p["trail_loose"] * 100, 4)},
        {"above": float(p["trail_loose_below"]), "pct": round(p["trail"] * 100, 4)},
        {"above": float(p["trail_tight_at"]), "pct": round(p["trail_tight"] * 100, 4)},
    ]


def drawdown_late(raw: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """尾盘收紧,导出成 tracker.Targets.profit_drawdown_late 的形状。"""
    p = params_from(raw)
    return {"after": p["trail_late"], "factor": float(p["trail_late_factor"])}


# ----------------------------------------------------------------------
# 模型价(Bachelier 正态,σ = σ_剩余)
# ----------------------------------------------------------------------
def _cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def bachelier_call(s: float, k: float, sigma: float) -> float:
    if sigma <= 1e-9:
        return max(s - k, 0.0)
    z = (s - k) / sigma
    return (s - k) * _cdf(z) + sigma * _pdf(z)


def model_price(profile: Dict[str, Any], s: float, sigma: float) -> float:
    """多头蝶的理论价(每单位标的,不含乘数)。看跌蝶按平价关系换算,对称翼时与看涨蝶同值。"""
    k1, k2, k3 = profile["lower"], profile["center"], profile["upper"]
    calls = bachelier_call(s, k1, sigma) - 2 * bachelier_call(s, k2, sigma) + bachelier_call(s, k3, sigma)
    if profile["right"] == "P":
        calls -= (s - k1) - 2 * (s - k2) + (s - k3)
    return round(max(calls, 0.0), 4)


# ----------------------------------------------------------------------
# 点位与区间
# ----------------------------------------------------------------------
def tranche_sizes(qty: int) -> List[int]:
    third = max(1, qty // 3) if qty > 0 else 0
    return [min(third, qty), min(third, max(qty - third, 0))]


def levels(profile: Dict[str, Any], params: Dict[str, Any]) -> List[Dict[str, Any]]:
    """蝶价图上的水平线:两档止盈、止损、回撤激活线,各带预计盈亏。"""
    d = profile.get("debit")
    if d is None:
        return []
    mult, qty = profile["multiplier"], profile["qty"]
    t1, t2 = tranche_sizes(qty)
    rows = [
        ("tp1", params["tp1"], "第一档止盈", t1),
        ("tp2", params["tp2"], "第二档止盈", t2),
        ("trail_arm", params["trail_arm"], "回撤追踪激活", 0),
        ("stop", params["stop"], "止损", qty),
    ]
    out = []
    for kind, mult_of_d, label, tranche in rows:
        if mult_of_d is None:   # 固定档位默认关闭,不画线也不占表格行
            continue
        price = round(d * mult_of_d, 4)
        per = round((price - d) * mult, 2)
        out.append({
            "kind": kind, "price": price, "mult_of_debit": mult_of_d, "label": label,
            "tranche_qty": tranche, "pnl_per_contract": per,
            "expected_pnl": round(per * tranche, 2) if tranche else None,
        })
    return out


def zones(profile: Dict[str, Any], params: Dict[str, Any]) -> List[Dict[str, Any]]:
    """标的图上的区间线:|S−K| 的三条临界线,各自对应的动作。"""
    k, w = profile["center"], profile["width"]
    return [
        {"kind": "hold", "half_width": round(params["zone_hold"] * w, 4),
         "low": round(k - params["zone_hold"] * w, 4), "high": round(k + params["zone_hold"] * w, 4),
         "label": "±%.2fW 临界线:阶段 B 出界全清、阶段 C 界内持到结算" % params["zone_hold"]},
        {"kind": "half", "half_width": round(params["zone_half"] * w, 4),
         "low": round(k - params["zone_half"] * w, 4), "high": round(k + params["zone_half"] * w, 4),
         "label": "±%.2fW:阶段 C 落在 0.45W–0.55W 清一半,更远立即清残值" % params["zone_half"]},
        {"kind": "stop", "half_width": round(params["zone_stop"] * w, 4),
         "low": round(k - params["zone_stop"] * w, 4), "high": round(k + params["zone_stop"] * w, 4),
         "label": "±%.2fW:剩余方差 > %d%% 时出界止损" % (params["zone_stop"], round(params["stop_var"] * 100))},
    ]


# ----------------------------------------------------------------------
# 逐分钟回放
# ----------------------------------------------------------------------
def _bar_close_map(bars: Sequence[Dict[str, Any]]) -> Dict[str, float]:
    out: Dict[str, float] = {}
    for b in bars:
        c = b.get("close")
        if c is None:
            continue
        try:
            out[str(b.get("time") or "")] = float(c)
        except (TypeError, ValueError):
            continue
    return out


def simulate(
    profile: Dict[str, Any],
    entry_bar_time: str,
    spx_bars: Sequence[Dict[str, Any]],
    fly_bars: Sequence[Dict[str, Any]],
    params: Dict[str, Any],
    actual: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """从开仓那根 K 线起,按策略逐分钟走到收盘/数据尽头。

    spx_bars / fly_bars:time 为美东 'YYYY-MM-DD HH:MM'。以 spx_bars 为时间轴,蝶价缺的分钟用模型价。
    actual:实际结局 {"kind","price","pnl","time_et"},只用于对比。
    """
    d = profile.get("debit")
    if profile["action"] != "BUY":
        return {"applicable": False, "reason": "该止盈策略只适用于多头蝶(买翼卖中心);这是一张卖出的蝶。"}
    if d is None:
        return {"applicable": False, "reason": "没有入场净权利金 D,策略的所有阈值都以 D 为基准,无法回放。"}
    qty = int(profile["qty"])
    mult = float(profile["multiplier"])
    k, w = profile["center"], profile["width"]
    fly_close = _bar_close_map(fly_bars)
    day = entry_bar_time[:10]

    timeline = [b for b in spx_bars if str(b.get("time") or "") >= entry_bar_time
                and str(b.get("time") or "")[:10] == day and b.get("close") is not None]
    if not timeline:
        return {"applicable": False, "reason": "开仓当天没有标的 K 线,无法回放。"}

    remaining = qty
    t1, t2 = tranche_sizes(qty)
    tp1_done = tp2_done = half_done = otm_done = False
    # 文档的位置止损说的是"出界":开仓时就在 0.8W 之外的远端 OTM 蝶(§2.3),
    # 位置止损从标的首次进入 0.8W 之后才生效,并额外启用"进入 K±10 分批落袋"。
    entry_s = float(timeline[0]["close"])
    entry_outside = abs(entry_s - k) > params["zone_stop"] * w
    inside_seen = not entry_outside
    profit_peak = 0.0
    armed = False
    events: List[Dict[str, Any]] = []
    series: List[Dict[str, Any]] = []
    entered_b = entered_c = False
    settled = False

    def sell(time: str, n: int, price: float, phase: str, rule: str, source: str) -> None:
        nonlocal remaining
        n = max(0, min(n, remaining))
        if n <= 0:
            return
        pnl = round((price - d) * mult * n, 2)
        events.append({"time": time, "phase": phase, "rule": rule, "qty": n, "price": round(price, 4),
                       "pnl": pnl, "source": source, "remaining": remaining - n})
        remaining -= n

    for bar in timeline:
        t = str(bar["time"])
        hhmm = t[11:16]
        minute = minutes_of(hhmm)
        if minute > CLOSE_MIN:
            break
        s = float(bar["close"])
        sigma = sigma_remaining(params["em"], minute)
        real = fly_close.get(t)
        price = real if real is not None else model_price(profile, s, sigma)
        source = "real" if real is not None else "model"
        dist = abs(s - k)
        phase = phase_at(minute, w, params)
        r = remaining_variance(minute)
        if remaining > 0:
            if not armed and price >= params["trail_arm"] * d:
                armed = True
            if armed:
                profit_peak = max(profit_peak, price - d)
        stop_line = trail_stop(profit_peak, d, minute, params) if armed else None
        series.append({"time": t, "price": round(price, 4), "source": source, "phase": phase,
                       "sigma_rem": sigma, "dist": round(dist, 4), "remaining": remaining,
                       "trail_stop": stop_line})
        if remaining <= 0:
            continue

        if minute >= CLOSE_MIN:
            settle = _intrinsic(profile, s)
            sell(t, remaining, settle, phase, "结算:按 16:00 标的 %.2f 的内在价值 %.2f" % (s, settle), "settle")
            settled = True
            break

        # 止损:任意时刻
        if price <= params["stop"] * d:
            sell(t, remaining, price, phase, "止损:蝶价 %.2f ≤ %.2f×D" % (price, params["stop"]), source)
            continue
        if dist <= params["zone_stop"] * w:
            inside_seen = True
        if inside_seen and dist > params["zone_stop"] * w and r > params["stop_var"]:
            sell(t, remaining, price, phase, "止损:|S−K| = %.1f > %.2fW 且剩余方差 %.0f%% > %.0f%%" % (
                dist, params["zone_stop"], r * 100, params["stop_var"] * 100), source)
            continue
        if entry_outside and not otm_done and dist <= params["otm_band"]:
            otm_done = True
            # 至少留 1 张:标的刚贴近中心正是蝶价要爆发的时刻,这里把仓位清空等于拿"分批落袋"
            # 顶掉了整套止盈。1 张的单在这一步不动,直接交给回撤追踪。
            otm_qty = min(t1, remaining - 1)
            if otm_qty > 0:
                sell(t, otm_qty, price, phase, "OTM 蝶:标的 %.2f 进入 K±%g,分批落袋 %d 张" % (
                    s, params["otm_band"], otm_qty), source)
            if remaining <= 0:
                continue

        # 回撤追踪:阶段 A/B 全天生效。位置信号一律优先于价格信号——蝶价回撤本来就是 |S−K| 扩大的
        # 影子,标的已经出界时按区间规则归因更干净;阶段 C 更是整段让给区间规则,σ_剩余 太小的时候
        # 蝶价由内在价值主导,再叠一层价格追踪只会被尾盘的 gamma 噪声反复扫。
        zone_takes_over = phase == "C" or (phase == "B" and dist > params["zone_hold"] * w)
        if armed and not zone_takes_over and profit_peak > 0:
            give_back = profit_peak - (price - d)
            pct = trail_pct(profit_peak, d, minute, params)
            if give_back >= profit_peak * pct and give_back >= params["trail_floor"]:
                sell(t, remaining, price, phase,
                     "回撤追踪:浮盈从高水位 %.2f 回吐 %.2f(%.0f%% 档,触发价 %.2f),清仓" % (
                         profit_peak, give_back, pct * 100, trail_stop(profit_peak, d, minute, params)), source)
                continue

        if phase == "A":
            if params["tp1"] is not None and not tp1_done and price >= params["tp1"] * d:
                tp1_done = True
                sell(t, t1, price, phase, "第一档:蝶价 %.2f ≥ %.2f×D,清 1/3" % (price, params["tp1"]), source)
            if (params["tp2"] is not None and remaining > 0 and not tp2_done
                    and price >= params["tp2"] * d):
                tp2_done = True
                sell(t, t2, price, phase, "第二档:蝶价 %.2f ≥ %.2f×D,再清 1/3" % (price, params["tp2"]), source)
            continue

        if phase == "B":
            if not entered_b:
                entered_b = True
                # 至少留 1 张:qty//3 对 1–2 张的单会算出 0,等于 14:00 硬性平仓,把阶段 B/C 全废掉。
                cap = max(1, qty // 3)
                if remaining > cap:
                    sell(t, remaining - cap, price, phase, "进入 14:00 过渡:留仓压到 1/3(%d 张)" % cap, source)
                    if remaining <= 0:
                        continue
            if dist > params["zone_hold"] * w:
                sell(t, remaining, price, phase, "阶段 B:|S−K| = %.1f > %.2fW,全清" % (dist, params["zone_hold"]), source)
            continue

        # 阶段 C
        if not entered_c:
            entered_c = True
        if dist > params["zone_half"] * w:
            sell(t, remaining, price, phase, "阶段 C:|S−K| = %.1f > %.2fW,立即清残值" % (dist, params["zone_half"]), source)
        elif dist >= params["zone_hold"] * w and not half_done:
            half_done = True
            sell(t, math.ceil(remaining / 2), price, phase, "阶段 C:|S−K| = %.1f 在 %.2fW–%.2fW,清一半" % (
                dist, params["zone_hold"], params["zone_half"]), source)
        # 界内:持到结算

    last = timeline[-1] if timeline else None
    if remaining > 0 and last is not None and not settled:
        s = float(last["close"])
        t = str(last["time"])
        if minutes_of(t[11:16]) >= CLOSE_MIN - 1:
            settle = _intrinsic(profile, s)
            sell(t, remaining, settle, "C", "结算:按收盘标的 %.2f 的内在价值 %.2f" % (s, settle), "settle")
        else:
            mark = series[-1]["price"] if series else d
            events.append({"time": t, "phase": phase_at(minutes_of(t[11:16]), w, params), "rule":
                           "数据到此为止,剩余 %d 张按最后蝶价 %.2f 估值(未平仓)" % (remaining, mark),
                           "qty": remaining, "price": round(mark, 4),
                           "pnl": round((mark - d) * mult * remaining, 2), "source": "mark", "remaining": remaining})
            remaining = 0

    strategy_pnl = round(sum(e["pnl"] for e in events), 2)
    hold_pnl = None
    if last is not None:
        hold_pnl = round((_intrinsic(profile, float(last["close"])) - d) * mult * qty, 2)
    actual_pnl = None if actual is None else actual.get("pnl")
    best_mid = max((p["price"] for p in series), default=None)
    return {
        "applicable": True,
        "entry_outside": entry_outside,
        "entry_dist": round(abs(entry_s - k), 4),
        "events": events,
        "series": series,
        "totals": {
            "strategy": strategy_pnl,
            "actual": actual_pnl,
            "hold_to_settle": hold_pnl,
            "best_mid": None if best_mid is None else round(best_mid, 4),
            "best_mid_pnl": None if best_mid is None else round((best_mid - d) * mult * qty, 2),
            "profit_peak": round(profit_peak, 4),
            "model_minutes": sum(1 for p in series if p["source"] == "model"),
            "real_minutes": sum(1 for p in series if p["source"] == "real"),
        },
    }


def _intrinsic(profile: Dict[str, Any], s: float) -> float:
    k1, k2, k3 = profile["lower"], profile["center"], profile["upper"]
    if profile["right"] == "P":
        v = max(k1 - s, 0.0) - 2 * max(k2 - s, 0.0) + max(k3 - s, 0.0)
    else:
        v = max(s - k1, 0.0) - 2 * max(s - k2, 0.0) + max(s - k3, 0.0)
    return round(v, 4)


# ----------------------------------------------------------------------
# 汇总:给 RPC / 界面用
# ----------------------------------------------------------------------
def plan(
    profile: Dict[str, Any],
    entry_bar_time: str,
    spx_bars: Sequence[Dict[str, Any]],
    fly_bars: Sequence[Dict[str, Any]],
    raw_params: Optional[Dict[str, Any]],
    actual: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    params = params_from(raw_params)
    w = profile["width"]
    sw = switch_minute(w, params)
    cutoff = minutes_of(params["cutoff_a"])
    out: Dict[str, Any] = {
        "params": params,
        "levels": levels(profile, params),
        "zones": zones(profile, params),
        "phases": {
            "a_until": fmt_minute(cutoff),
            "c_from": fmt_minute(sw),
            "sigma_at_switch": sigma_remaining(params["em"], sw),
            "threshold": round(w / params["switch_k"], 4),
            "em_at_open": params["em"],
            "wing_in_sigma": round(w / params["em"], 2) if params["em"] else None,
        },
        "notes": [
            "EM 取 %s 点(文档默认;应每日从 ATM straddle 取,EM = straddle × 0.85)" % ("%g" % params["em"]),
            "触发判断用组合分钟线的中间价,文档要求按 bid,回放结果略偏乐观",
            "止盈按浮盈回撤追踪:蝶价 ≥ %.2f×D 后记高水位,浮盈 < %g×D 让 %.0f%%、%g–%g×D 让 %.0f%%、"
            "≥ %g×D 让 %.0f%%,%s 之后再乘 %g;回吐不足 %g 点不触发。阶段 C 交给区间规则。" % (
                params["trail_arm"], params["trail_loose_below"], params["trail_loose"] * 100,
                params["trail_loose_below"], params["trail_tight_at"], params["trail"] * 100,
                params["trail_tight_at"], params["trail_tight"] * 100,
                params["trail_late"], params["trail_late_factor"], params["trail_floor"]),
        ],
    }
    if params["tp1"] is None and params["tp2"] is None:
        out["notes"].append("固定倍数档位已关闭(蝶价上限就是翼宽 %g,用 D 的倍数封顶会在 D 小的时候锁死出场);"
                            "要恢复 v2.0 的分批止盈,传 tp1 / tp2 即可" % w)
    sim = simulate(profile, entry_bar_time, spx_bars, fly_bars, params, actual)
    out["simulation"] = sim
    if sim.get("applicable") and sim["totals"]["model_minutes"]:
        out["notes"].append("有 %d 分钟没有真实蝶价,用 Bachelier 模型价(σ_剩余)补上,图上以虚线区分"
                            % sim["totals"]["model_minutes"])
    if sim.get("applicable") and sim.get("entry_outside"):
        out["notes"].append("开仓时 |S−K| = %s 点 > %.2fW:这是远端 OTM 蝶(文档 §2.3),位置止损从标的首次进入 "
                            "%.2fW 之后才生效,并按 OTM 规则在标的进入 K±%g 时分批落袋"
                            % ("%g" % sim["entry_dist"], params["zone_stop"], params["zone_stop"], params["otm_band"]))
    d = profile.get("debit")
    if d is not None and actual and actual.get("price") is not None and actual.get("kind") == "closed":
        out["actual_exit_mult"] = round(actual["price"] / d, 2) if d else None
    return out
