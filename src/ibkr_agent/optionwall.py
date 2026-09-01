"""期权墙(持仓量墙 / Gamma 敞口 / 最大痛点)—— 纯计算,离线可单测。

和 priceaction 是互补的两条腿:PA 从**价格自己走出来的结构**读关键位,这里从
**期权持仓的分布**读关键位。两边指向同一个价位,那个位才是真有人守;只有一边
指着,那多半是巧合。

三个口径,含义完全不同,界面上必须分开摆:

  持仓量墙 OI    某个行权价上未平仓合约最多的地方。**OI 是隔夜数据**——
                 OCC 每天开盘前公布一次,盘中看到的是昨收的存量,不含今天的流。
  成交量墙       今天真正成交在哪些行权价上。0DTE 必须看这个:当日到期的合约
                 绝大多数当天开当天平,OI 根本来不及反映。
  Gamma 敞口     GEX,把 OI 换算成"标的每动 1%,做市商要对冲多少钱"。
                 净 GEX 为正 = 做市商多头 gamma,涨了卖、跌了买,**压波动**;
                 为负 = 空头 gamma,涨了追、跌了砍,**放大波动**。

**GEX 的符号约定是一个假设,不是事实。** 这里用最主流的那个:假定做市商
**多头 call、空头 put**(散户买 put 对冲、卖 call 增强收益)。真实的做市商
持仓没人看得到,换个假设结论可能反过来。用它判断"波动会被压住还是被放大",
比用它判断方向靠谱得多。

最大痛点 Max Pain 是所有未平仓期权内在价值之和最小的那个行权价。它常被说成
"到期会被拉到那儿",这个因果**没有可靠证据**;把它当成一个参考位,别当成预言。

只读研究模块:不接下单链路、不参与定价,结论不构成投资建议。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from math import exp, log, pi, sqrt
from typing import Any, Dict, List, Optional, Sequence

MULTIPLIER = 100.0        # 美股期权标准合约乘数
MIN_STRIKES = 5           # 少于这么多行权价不出结论:画不出分布,谈"墙"是编的
_MIN_T = 1.0 / (365.0 * 24.0)   # 到期日 T 的下限(1 小时),否则 0DTE 的 gamma 会炸


class OptionWallError(ValueError):
    pass


@dataclass(frozen=True)
class OptionRow:
    """链上的一条。oi / volume 缺失按 0,gamma / iv 缺失按 None —— 不猜。"""

    strike: float
    right: str                      # 'C' | 'P'
    oi: float = 0.0
    volume: float = 0.0
    gamma: Optional[float] = None   # 券商给的模型 gamma,优先用
    iv: Optional[float] = None


def to_rows(raw: Sequence[Dict[str, Any]]) -> List[OptionRow]:
    out: List[OptionRow] = []
    for item in raw:
        right = str(item.get("right") or "").upper()[:1]
        if right not in ("C", "P"):
            continue
        try:
            strike = float(item["strike"])
        except (KeyError, TypeError, ValueError):
            continue
        if strike <= 0:
            continue
        out.append(
            OptionRow(
                strike=strike,
                right=right,
                oi=max(float(item.get("oi") or 0.0), 0.0),
                volume=max(float(item.get("volume") or 0.0), 0.0),
                gamma=_opt_float(item.get("gamma")),
                iv=_opt_float(item.get("iv")),
            )
        )
    return out


def _opt_float(value) -> Optional[float]:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if (v == v and v > 0) else None      # 排除 NaN 与非正值


# ---------------------------------------------------------------- Gamma
def bs_gamma(spot: float, strike: float, t: float, sigma: float) -> float:
    """Black-Scholes gamma(r=0,无股息)。券商没给模型 gamma 时的兜底。

    gamma = φ(d1) / (S·σ·√T)。T 有下限:当日到期时 T→0 会让 gamma 发散到无穷,
    那不是信息,是除零。
    """
    t = max(t, _MIN_T)
    if spot <= 0 or strike <= 0 or sigma <= 0:
        return 0.0
    d1 = (log(spot / strike) + 0.5 * sigma * sigma * t) / (sigma * sqrt(t))
    pdf = exp(-0.5 * d1 * d1) / sqrt(2.0 * pi)
    return pdf / (spot * sigma * sqrt(t))


def years_to_expiry(expiry: str, now: Optional[datetime] = None) -> float:
    """'YYYYMMDD' → 距到期的年数。当日到期按当天收盘(美东 16:00)估。"""
    if not expiry or len(expiry) != 8 or not expiry.isdigit():
        return _MIN_T
    try:
        day = date(int(expiry[:4]), int(expiry[4:6]), int(expiry[6:8]))
    except ValueError:
        return _MIN_T
    moment = now or datetime.now()
    close = datetime(day.year, day.month, day.day, 16, 0)
    if moment.tzinfo is not None:
        close = close.replace(tzinfo=moment.tzinfo)
    return max((close - moment).total_seconds() / (365.0 * 24 * 3600.0), _MIN_T)


# ---------------------------------------------------------------- 汇总
def _by_strike(rows: Sequence[OptionRow]) -> Dict[float, Dict[str, float]]:
    grid: Dict[float, Dict[str, float]] = {}
    for row in rows:
        cell = grid.setdefault(
            row.strike, {"call_oi": 0.0, "put_oi": 0.0, "call_vol": 0.0, "put_vol": 0.0}
        )
        if row.right == "C":
            cell["call_oi"] += row.oi
            cell["call_vol"] += row.volume
        else:
            cell["put_oi"] += row.oi
            cell["put_vol"] += row.volume
    return grid


def _wall(grid: Dict[float, Dict[str, float]], field: str, spot: float, side: str):
    """某一侧上量最大的行权价。side='above' 找阻力,'below' 找支撑。"""
    candidates = [
        (strike, cell[field])
        for strike, cell in grid.items()
        if (strike >= spot if side == "above" else strike <= spot) and cell[field] > 0
    ]
    if not candidates:
        return None
    strike, size = max(candidates, key=lambda kv: kv[1])
    return {
        "strike": strike,
        "size": round(size, 1),
        "distance_pct": round((strike / spot - 1.0) * 100.0, 2) if spot else None,
    }


def max_pain(grid: Dict[float, Dict[str, float]], multiplier: float = MULTIPLIER):
    """所有未平仓期权内在价值之和最小的行权价。

    注意这是个**统计量,不是预言**:"到期会被拉到最大痛点"这个因果没有可靠
    证据。当成一个参考位看,别当成方向。
    """
    strikes = sorted(grid)
    if len(strikes) < MIN_STRIKES:
        return None
    best = None
    for target in strikes:
        pain = 0.0
        for strike, cell in grid.items():
            pain += cell["call_oi"] * max(target - strike, 0.0)
            pain += cell["put_oi"] * max(strike - target, 0.0)
        pain *= multiplier
        if best is None or pain < best[1]:
            best = (target, pain)
    return {"strike": best[0], "pain": round(best[1], 0)}


def net_gex_at(
    rows: Sequence[OptionRow], spot: float, t: float, multiplier: float = MULTIPLIER,
    at_current_spot: bool = False,
) -> float:
    """标的在 spot 时的净 gamma 敞口(美元 / 每 1% 波动)。

    符号约定见模块开头:假定做市商多头 call、空头 put。这是**假设**,不是事实。

    at_current_spot 决定 gamma 从哪来,这个区分不能省:
      * True —— spot 就是当前现价,优先用券商给的模型 gamma(它含偏度、股息、
        利率,比这里的 r=0 无偏度 BS 准);
      * False —— 在**别的**价位上做假设推演(画 gamma 曲线、找翻转位),
        券商那个 gamma 是在现价算的,拿到别的价位用就是错的,必须重算。
    """
    total = 0.0
    for row in rows:
        if at_current_spot and row.gamma is not None:
            gamma = row.gamma
        elif row.iv:
            gamma = bs_gamma(spot, row.strike, t, row.iv)
        else:
            continue                      # 既没 IV 也没可用的模型 gamma,跳过,不猜
        sign = 1.0 if row.right == "C" else -1.0
        total += sign * gamma * row.oi * multiplier * spot * spot * 0.01
    return total


def gamma_flip(
    rows: Sequence[OptionRow], strikes: Sequence[float], t: float,
    multiplier: float = MULTIPLIER,
):
    """净 GEX 由负转正的价位。跨不过零就返回 None —— 不外推。"""
    usable = [r for r in rows if r.iv]
    if len(usable) < MIN_STRIKES or len(strikes) < 2:
        return None

    profile = [(k, net_gex_at(usable, k, t, multiplier)) for k in sorted(strikes) if k > 0]
    for (k0, g0), (k1, g1) in zip(profile, profile[1:]):
        if (g0 <= 0 <= g1) or (g0 >= 0 >= g1):
            if g1 == g0:
                return round(k0, 2)
            # 两点之间线性插值,比直接取端点更接近真实过零点
            return round(k0 + (k1 - k0) * (0.0 - g0) / (g1 - g0), 2)
    return None


# ---------------------------------------------------------------- 总装
def analyze(
    raw: Sequence[Dict[str, Any]],
    spot: float,
    expiry: str = "",
    symbol: str = "",
    multiplier: float = MULTIPLIER,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """一条期权链 + 现价 → 完整的墙分析。纯函数。"""
    rows = to_rows(raw)
    if spot <= 0:
        raise OptionWallError("缺少标的现价,无法判断墙在现价上方还是下方。")
    grid = _by_strike(rows)
    if len(grid) < MIN_STRIKES:
        raise OptionWallError(
            "只有 %d 个行权价的数据(至少需要 %d 个),画不出分布。"
            "可能是行权价范围取得太窄,或该到期日的链没有报价。" % (len(grid), MIN_STRIKES)
        )

    t = years_to_expiry(expiry, now)
    strikes = sorted(grid)

    per_strike: List[Dict[str, Any]] = []
    for strike in strikes:
        cell = grid[strike]
        at_strike = [r for r in rows if r.strike == strike]
        per_strike.append(
            {
                "strike": strike,
                "call_oi": round(cell["call_oi"], 1),
                "put_oi": round(cell["put_oi"], 1),
                "call_vol": round(cell["call_vol"], 1),
                "put_vol": round(cell["put_vol"], 1),
                "net_gex": round(net_gex_at(at_strike, spot, t, multiplier, at_current_spot=True), 0),
            }
        )

    total_call_oi = sum(c["call_oi"] for c in grid.values())
    total_put_oi = sum(c["put_oi"] for c in grid.values())
    total_call_vol = sum(c["call_vol"] for c in grid.values())
    total_put_vol = sum(c["put_vol"] for c in grid.values())
    net_gex = net_gex_at(rows, spot, t, multiplier, at_current_spot=True)

    result: Dict[str, Any] = {
        "symbol": symbol,
        "expiry": expiry,
        "spot": round(spot, 4),
        "multiplier": multiplier,
        "strike_count": len(grid),
        "days_to_expiry": round(t * 365.0, 3),
        "strikes": per_strike,
        "call_wall": _wall(grid, "call_oi", spot, "above"),
        "put_wall": _wall(grid, "put_oi", spot, "below"),
        "call_vol_wall": _wall(grid, "call_vol", spot, "above"),
        "put_vol_wall": _wall(grid, "put_vol", spot, "below"),
        "max_pain": max_pain(grid, multiplier),
        "net_gex": round(net_gex, 0),
        "gamma_flip": gamma_flip(rows, strikes, t, multiplier),
        "regime": "positive" if net_gex >= 0 else "negative",
        "total_call_oi": round(total_call_oi, 1),
        "total_put_oi": round(total_put_oi, 1),
        "pc_ratio_oi": round(total_put_oi / total_call_oi, 3) if total_call_oi else None,
        "pc_ratio_volume": round(total_put_vol / total_call_vol, 3) if total_call_vol else None,
        "has_greeks": any(r.iv for r in rows),
    }
    result["warnings"] = _warnings(result, rows)
    result["readout"] = _readout(result)
    return result


def _warnings(result: Dict[str, Any], rows: Sequence[OptionRow]) -> List[str]:
    out: List[str] = [
        "OI 是隔夜存量:OCC 每天开盘前公布一次,盘中看到的不含当天的流。",
        "GEX 的符号建立在「做市商多头 call、空头 put」这个假设上——真实持仓没人看得到,"
        "换个假设结论可能反过来。它适合判断波动会被压住还是放大,不适合判断方向。",
    ]
    if result["days_to_expiry"] <= 1.0:
        out.append(
            "当日/次日到期:0DTE 合约绝大多数当天开当天平,**OI 墙基本没有参考价值**,"
            "请以成交量墙为准。"
        )
    if not result["has_greeks"]:
        out.append("没拿到隐含波动率,gamma 只能用券商给的模型值或直接缺失,gamma 翻转位不可用。")
    if result["max_pain"]:
        out.append("最大痛点只是个统计量;「到期会被拉到那儿」这个因果没有可靠证据。")
    total_oi = result["total_call_oi"] + result["total_put_oi"]
    if total_oi <= 0:
        out.append("整条链的持仓量都是 0——多半是没有行情权限,或这个到期日还没开始交易。")
    return out


def _readout(result: Dict[str, Any]) -> List[str]:
    """给人看的结论。全部由上面算好的字段拼成,不引入新判断。"""
    spot = result["spot"]
    zero_day = result["days_to_expiry"] <= 1.0
    lines = [
        "%s %s:现价 %s,链上 %d 个行权价,距到期 %.2f 天。"
        % (result["symbol"] or "标的", result["expiry"] or "(未指定到期)",
           spot, result["strike_count"], result["days_to_expiry"]),
    ]

    def describe(wall, label):
        if not wall:
            return None
        return "%s %s(%s 张,距现价 %+.2f%%)" % (
            label, wall["strike"], wall["size"], wall["distance_pct"])

    oi_parts = [p for p in (describe(result["call_wall"], "上方 Call 墙"),
                            describe(result["put_wall"], "下方 Put 墙")) if p]
    if oi_parts:
        lines.append("持仓量墙:%s。%s" % (";".join(oi_parts),
                                          "(0DTE 下参考价值有限)" if zero_day else ""))

    vol_parts = [p for p in (describe(result["call_vol_wall"], "上方成交墙"),
                             describe(result["put_vol_wall"], "下方成交墙")) if p]
    if vol_parts:
        lines.append("成交量墙(今日真实流向):%s。" % ";".join(vol_parts))

    gex = result["net_gex"]
    lines.append(
        "净 GEX %s(%s):做市商%s gamma,倾向于%s。"
        % (
            _money(gex),
            "正" if result["regime"] == "positive" else "负",
            "多头" if result["regime"] == "positive" else "空头",
            "涨了卖、跌了买,压住波动" if result["regime"] == "positive"
            else "涨了追、跌了砍,放大波动",
        )
    )
    if result["gamma_flip"] is not None:
        side = "上方" if result["gamma_flip"] > spot else "下方"
        lines.append(
            "Gamma 翻转位 %s(现价%s):越过它,压波动与放大波动的性质会掉个个儿。"
            % (result["gamma_flip"], side)
        )
    if result["max_pain"]:
        pain = result["max_pain"]["strike"]
        lines.append(
            "最大痛点 %s(距现价 %+.2f%%)——参考位,不是预言。"
            % (pain, (pain / spot - 1.0) * 100.0 if spot else 0.0)
        )
    if result["pc_ratio_oi"] is not None:
        lines.append(
            "Put/Call 比:持仓 %.2f%s。"
            % (result["pc_ratio_oi"],
               ",成交 %.2f" % result["pc_ratio_volume"]
               if result["pc_ratio_volume"] is not None else "")
        )
    return lines


def _money(value: float) -> str:
    sign = "-" if value < 0 else ""
    v = abs(value)
    if v >= 1e9:
        return "%s%.2f B" % (sign, v / 1e9)
    if v >= 1e6:
        return "%s%.1f M" % (sign, v / 1e6)
    if v >= 1e3:
        return "%s%.0f K" % (sign, v / 1e3)
    return "%s%.0f" % (sign, v)


def levels_for_pa(result: Dict[str, Any]) -> List[Dict[str, Any]]:
    """把墙折成一组价位,好和 PA 算出的支撑阻力对照。

    两边指向同一个价位,那个位才是真有人守;只有一边指着,多半是巧合。
    """
    out: List[Dict[str, Any]] = []
    zero_day = result.get("days_to_expiry", 99) <= 1.0

    def add(wall, kind: str, note: str) -> None:
        if wall:
            out.append({"price": wall["strike"], "kind": kind, "note": note,
                        "distance_pct": wall["distance_pct"]})

    # 0DTE 下成交量墙才有意义,所以把它排在前面
    if zero_day:
        add(result.get("call_vol_wall"), "resistance", "今日成交最密的上方行权价")
        add(result.get("put_vol_wall"), "support", "今日成交最密的下方行权价")
    add(result.get("call_wall"), "resistance", "持仓量最大的上方行权价")
    add(result.get("put_wall"), "support", "持仓量最大的下方行权价")
    if result.get("max_pain"):
        out.append({"price": result["max_pain"]["strike"], "kind": "pivot",
                    "note": "最大痛点(统计量,非预言)", "distance_pct": None})
    if result.get("gamma_flip") is not None:
        out.append({"price": result["gamma_flip"], "kind": "pivot",
                    "note": "Gamma 翻转位", "distance_pct": None})
    return out
