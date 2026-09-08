"""持仓追踪:盯住账户里的一个持仓,按用户设的止盈止损实时算盈亏、判触发。

这个模块**只算不发单**,而且全部是纯函数——盈亏和触发判断是这条链上最容易算错的
地方(方向搞反、乘数漏乘、空头的止盈止损上下颠倒),所以它必须能脱机单测到底。
真正碰券商的部分在 broker / futu_broker 里,真正下单的部分走 engine 那条老路。

三件事在这里定死:

1. **方向决定上下。** 多头的止盈在上、止损在下;空头正好相反。写反了不会报错,
   只会在开仓那一刻立刻触发——所以设置时就要拦,而不是等触发了才发现。
2. **乘数只乘一次。** IBKR 的 avgCost 对期权是**含乘数**的整张成本(5.50 的期权
   avgCost 是 550),所以成本一侧不能再乘;市值一侧要乘。两边口径不一致是这类
   代码最常见的 bug,这里用一个函数统一。
3. **跟踪止损跟的是"最有利价",不是最新价。** 峰值只朝有利方向走,回撤才触发。
   峰值必须持久化——不然重启一次,跟踪止损就退回到当前价重新起算,等于把已经
   锁住的利润又放开了。
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

# 触发状态。holding = 还在持有,两个 hit 是到价了。
STATE_HOLDING = "holding"
STATE_TAKE_PROFIT = "take_profit"
STATE_STOP_LOSS = "stop_loss"
STATE_PROFIT_TRAIL = "profit_trail"   # 利润从峰值回撤达到阈值


class TrackerError(ValueError):
    """设置不合法。用 ValueError 是为了让 RPC 层统一按"参数错误"回。"""


def position_key(account: str, symbol: str, sec_type: str, leg: str = "") -> str:
    """持仓/追踪的身份。

    正股:账户|代码|类型。期权还要带上腿身份(到期|行权价|方向)——一只蝴蝶三条腿
    都是 SPX 的 OPT,不带腿身份它们会在聚合时互相覆盖,界面上只剩最后一条,
    追踪与自动平仓也会认错腿。正股的 key 形状不变,老追踪记录照常匹配。
    """
    base = "%s|%s|%s" % (account, symbol, sec_type)
    return "%s|%s" % (base, leg) if leg else base


def _fmt_strike(strike: Any) -> str:
    try:
        value = float(strike)
    except (TypeError, ValueError):
        return ""
    return ("%.4f" % value).rstrip("0").rstrip(".")


def leg_of(contract: Optional[Dict[str, Any]]) -> str:
    """从合约里抽出腿身份:期权为 '到期|行权价|C/P',其余为空串。"""
    contract = contract or {}
    if (contract.get("secType") or "STK") not in ("OPT", "FOP"):
        return ""
    expiry = str(contract.get("lastTradeDateOrContractMonth") or "")[:8]
    right = str(contract.get("right") or "")[:1].upper()
    return "%s|%s|%s" % (expiry, _fmt_strike(contract.get("strike")), right)


def position_label(symbol: str, sec_type: str, contract: Optional[Dict[str, Any]]) -> str:
    """给人看的一行名字:正股就是代码;期权 'SPX 7615P 2026-09-01'。"""
    contract = contract or {}
    if sec_type not in ("OPT", "FOP"):
        return symbol
    expiry = str(contract.get("lastTradeDateOrContractMonth") or "")[:8]
    if len(expiry) == 8:
        expiry = "%s-%s-%s" % (expiry[:4], expiry[4:6], expiry[6:])
    right = str(contract.get("right") or "")[:1].upper()
    return " ".join(part for part in (symbol, _fmt_strike(contract.get("strike")) + right, expiry) if part.strip())


def track_key(track: Dict[str, Any]) -> str:
    """追踪记录 → 它盯的那条持仓的 key(老记录没有 leg 列时按正股处理)。"""
    return position_key(
        track["account"], track["symbol"], track.get("sec_type") or "STK", track.get("leg") or ""
    )


def _same(a: float, b: float) -> bool:
    return abs(a - b) <= 1e-6 * max(1.0, abs(a), abs(b))


def _leg_fields(legs: Sequence[Dict[str, Any]]):
    """(行权价, 方向, 数量) 三元组,识别形状都从这里取。"""
    strikes = [float((r.get("contract") or {}).get("strike") or 0.0) for r in legs]
    rights = [str((r.get("contract") or {}).get("right") or "")[:1].upper() for r in legs]
    qtys = [float(r.get("quantity") or 0.0) for r in legs]
    return strikes, rights, qtys


def shape_of(legs: Sequence[Dict[str, Any]]):
    """这几条腿(已按行权价排好序)构成什么标准结构?认不出回 None。

    返回 (kind, quantity)。规则刻意保守——认不出宁可不认,绝不猜:猜错的后果是
    净价、成本、盈亏全算在一个根本不存在的结构上。
    """
    strikes, rights, qtys = _leg_fields(legs)
    same_right = len(set(rights)) == 1
    if len(legs) == 2 and same_right and qtys[0] * qtys[1] < 0 and _same(abs(qtys[0]), abs(qtys[1])):
        return "vertical", abs(qtys[0])
    if (len(legs) == 3 and same_right and _same(strikes[1] - strikes[0], strikes[2] - strikes[1])
            and _same(qtys[0], qtys[2]) and _same(qtys[1], -2.0 * qtys[0]) and qtys[0] != 0):
        return "butterfly", abs(qtys[0])
    if (len(legs) == 4 and rights == ["P", "P", "C", "C"] and qtys[0] * qtys[1] < 0
            and qtys[2] * qtys[3] < 0 and _same(abs(qtys[0]), abs(qtys[1]))
            and _same(abs(qtys[2]), abs(qtys[3]))):
        kind = "iron_butterfly" if _same(strikes[1], strikes[2]) else "iron_condor"
        return kind, abs(qtys[0])
    return None


def split_structures(legs: Sequence[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    """把同一到期日的腿按结构切成若干**独立**组合。

    为什么必须切:IBKR 的持仓只给每条腿的净数量,不告诉你哪些腿属于同一张组合。
    同一天到期的两张蝶(哪怕一张看涨一张看跌)会挤在同一个桶里,不切开就成了
    "组合(6 腿)"——净价、成本、盈亏全混在一起,平仓单更是拼不出来
    (2026-09-04 实测:7595/7620/7645 看跌蝶 + 7800/7820/7840 看涨蝶被认成一个)。

    贪心:从行权价最低的腿开始,依次试 4 腿(铁鹰/铁蝶)、3 腿(蝶)、2 腿(价差),
    匹配上就消费掉再往后走。先试长的,免得把铁鹰的前两条腿当成一个价差。
    当前位置一个都匹配不上,就把**剩下的整块**交出去按"组合(N 腿)"处理——
    认不出是可以接受的,拆错不行。
    """
    out: List[List[Dict[str, Any]]] = []
    rest = list(legs)
    while len(rest) >= 2:
        for size in (4, 3, 2):
            if len(rest) >= size and shape_of(rest[:size]) is not None:
                out.append(rest[:size])
                rest = rest[size:]
                break
        else:
            break
    if rest:
        out.append(rest)
    return out or [list(legs)]


def group_legs(rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """把同一账户、同一标的、同一到期日的期权腿认成组合(蝴蝶/价差/铁鹰)。

    只做**识别与展示**,不改变任何一条腿的持仓行:追踪与平仓仍然按腿进行。
    同一到期日里可能同时挂着好几张组合,所以先按结构切开(见 split_structures),
    再逐个识别。识别规则刻意保守——认不出来的就叫"组合(N 腿)",绝不猜。
    """
    buckets: Dict[Any, List[Dict[str, Any]]] = {}
    for row in rows:
        if (row.get("sec_type") or "STK") not in ("OPT", "FOP"):
            continue
        contract = row.get("contract") or {}
        expiry = str(contract.get("lastTradeDateOrContractMonth") or "")[:8]
        buckets.setdefault((row["account"], row["symbol"], expiry), []).append(row)

    combos: List[Dict[str, Any]] = []
    for (account, symbol, expiry), bucket in sorted(buckets.items()):
        if len(bucket) < 2:
            continue
        bucket = sorted(
            bucket,
            key=lambda r: (float((r.get("contract") or {}).get("strike") or 0.0),
                           str((r.get("contract") or {}).get("right") or "")),
        )
        for legs in split_structures(bucket):
            if len(legs) < 2:
                continue
            strikes, rights, qtys = _leg_fields(legs)
            same_right = len(set(rights)) == 1
            right_name = {"C": "看涨", "P": "看跌"}.get(rights[0], "") if same_right else ""
            strike_text = "/".join(_fmt_strike(s) for s in strikes)

            shape = shape_of(legs)
            if shape is None:
                kind, quantity = "custom", None
                label = "组合(%d 腿) %s" % (len(legs), strike_text)
            else:
                kind, quantity = shape
                if kind == "vertical":
                    label = "%s价差 %s" % (right_name, strike_text)
                elif kind == "butterfly":
                    label = "%s%s蝴蝶 %s" % ("买入" if qtys[0] > 0 else "卖出", right_name, strike_text)
                else:
                    label = "%s %s" % ("铁蝶" if kind == "iron_butterfly" else "铁鹰", strike_text)

            values = [r.get("market_value") for r in legs]
            pnls = [r.get("unrealized_pnl") for r in legs]
            combos.append({
                "account": account, "symbol": symbol, "expiry": expiry,
                "right": rights[0] if same_right else "",
                "kind": kind, "label": label, "quantity": quantity,
                "net_cost": round(sum(q * float(r.get("avg_cost") or 0.0) for q, r in zip(qtys, legs)), 2),
                "market_value": round(sum(values), 2) if all(v is not None for v in values) else None,
                "unrealized_pnl": round(sum(pnls), 2) if all(p is not None for p in pnls) else None,
                "legs": [r["key"] for r in legs],
            })
    return combos


_COMBO_STRATEGY = {"butterfly": "BUTTERFLY", "vertical": "VERTICAL", "iron_condor": "IRON_CONDOR"}


def combo_row(combo: Dict[str, Any], rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """把一个组合折成**一条可追踪的虚拟持仓**——用户盯的是"这只蝴蝶值多少",不是三条腿各值多少。

    口径与单腿完全同一套,追踪/盈亏/触发逻辑一行不改:
      数量     N 组(蝴蝶 1 组 = +1/-2/+1 三张)。借方组合记为多头 +N,贷方组合记为空头 -N——
               贷方组合(铁鹰、卖出价差)收的权利金越缩水越赚,和空头一样"价格跌了才赚"。
      成本     每组净成本的绝对值(IBKR 口径,含乘数):Σ(腿比例 × 腿成本)。
      现价     每组净价的绝对值:Σ(腿比例 × 腿现价)。任何一条腿没现价就是 None——
               绝不拿半个数凑一个像模像样的组合价。
      市值/盈亏 直接累加券商报的各腿数字(对账口径)。
    虚拟行的 sec_type 是 BAG,key 带到期与腿签名;它不能自动平仓(平组合要发 BAG 单,
    这条路还没有真机核对),只做提醒——tracker_add 会拦。
    """
    by_key = {r["key"]: r for r in rows}
    legs = [by_key[k] for k in combo["legs"] if k in by_key]
    qtys = [float(r.get("quantity") or 0.0) for r in legs]
    units = combo.get("quantity")
    if not units:
        units = 1.0                     # 认不出形状的组合:按 1 组算,腿比例就是各腿数量
    ratios = [q / units for q in qtys]
    net_cost = sum(r_ * float(leg.get("avg_cost") or 0.0) for r_, leg in zip(ratios, legs))
    prices = [leg.get("market_price") for leg in legs]
    net_price = (
        sum(r_ * float(p) for r_, p in zip(ratios, prices))
        if all(p is not None for p in prices) and legs else None
    )
    long = net_cost >= 0
    contract = legs[0].get("contract") or {}
    multiplier = float(legs[0].get("multiplier") or 100.0) if legs else 100.0
    sig = ",".join(
        "%+gx%s%s" % (r_, _fmt_strike((leg.get("contract") or {}).get("strike")),
                      str((leg.get("contract") or {}).get("right") or "")[:1].upper())
        for r_, leg in zip(ratios, legs)
    )
    leg_id = "%s|%s" % (combo["expiry"], sig)
    return {
        "key": position_key(combo["account"], combo["symbol"], "BAG", leg_id),
        "account": combo["account"],
        "symbol": combo["symbol"],
        "sec_type": "BAG",
        "leg": leg_id,
        "label": combo["label"],
        "kind": combo["kind"],
        "quantity": units if long else -units,
        "multiplier": multiplier,
        "currency": legs[0].get("currency") if legs else "USD",
        "avg_cost": round(abs(net_cost), 4),
        "market_price": None if net_price is None else round(abs(net_price), 4),
        "net_side": "debit" if long else "credit",
        "market_value": combo.get("market_value"),
        "unrealized_pnl": combo.get("unrealized_pnl"),
        "legs": list(combo["legs"]),
        "ratios": ratios,
        "contract": {
            "secType": "BAG",
            "symbol": combo["symbol"],
            "exchange": contract.get("exchange") or "SMART",
            "currency": contract.get("currency") or "USD",
            "multiplier": str(int(multiplier)),
            "combo_strategy": _COMBO_STRATEGY.get(combo["kind"]),
            "label": combo["label"],
            "legs": [
                {
                    "lastTradeDateOrContractMonth": (leg.get("contract") or {}).get("lastTradeDateOrContractMonth"),
                    "strike": (leg.get("contract") or {}).get("strike"),
                    "right": (leg.get("contract") or {}).get("right"),
                    "ratio": r_,
                }
                for r_, leg in zip(ratios, legs)
            ],
        },
    }


def with_combos(rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """券商持仓行 + 组合虚拟行。所有按 key 找持仓的地方都该用这个,组合才追踪得到。"""
    rows = list(rows)
    return rows + [combo_row(c, rows) for c in group_legs(rows)]


@dataclass(frozen=True)
class Position:
    """账户里的一个持仓。数量为负表示空头。"""

    account: str                 # 别名,不是账号
    symbol: str
    sec_type: str = "STK"
    quantity: float = 0.0
    avg_cost: float = 0.0        # IBKR 口径:期权含乘数
    multiplier: float = 1.0
    currency: str = "USD"
    # 券商自己报的数(有就优先用,它才是对账口径)
    market_price: Optional[float] = None
    market_value: Optional[float] = None
    unrealized_pnl: Optional[float] = None
    leg: str = ""                # 期权腿身份(到期|行权价|方向),正股为空

    @property
    def is_long(self) -> bool:
        return self.quantity > 0

    @property
    def key(self) -> str:
        """同一个账户里同一个合约只该有一条持仓。"""
        return position_key(self.account, self.symbol, self.sec_type, self.leg)


@dataclass
class Targets:
    """用户设的止盈止损。三项都可以不填,不填就是不管那一头。"""

    take_profit: Optional[float] = None      # 价格
    stop_loss: Optional[float] = None        # 价格
    trail_pct: Optional[float] = None        # 跟踪止损:从最有利价回撤这么多个百分点
    # 利润回撤:当前利润比历史峰值利润低这么多个百分点(相对峰值的比例)时触发。
    # 峰值利润不用单独存:利润对价格单调,由已持久化的峰值价格换算即可,重启不丢。
    profit_drawdown_pct: Optional[float] = None
    # 分档回撤:按**浮盈相对成本的倍数**换档位。`profit_peak / |cost_basis|` 对期权组合
    # 恰好就是 flyexit 的"浮盈 / D"——两边同乘 数量×乘数 就约掉了,不必另传 D。
    # 形如 [{"above": 0, "pct": 40}, {"above": 1, "pct": 30}, {"above": 3, "pct": 20}]:
    # 取所有 above ≤ 当前倍数 里最高的那一档。不填就全程用 profit_drawdown_pct。
    profit_drawdown_tiers: Optional[List[Dict[str, Any]]] = None
    # 尾盘收紧:{"after": "15:00", "factor": 0.5}。0DTE 临近收盘时 σ_剩余 太小,
    # 同样幅度的回撤更可能是真的走坏了,不是噪声。
    profit_drawdown_late: Optional[Dict[str, Any]] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "take_profit": self.take_profit,
            "stop_loss": self.stop_loss,
            "trail_pct": self.trail_pct,
            "profit_drawdown_pct": self.profit_drawdown_pct,
            "profit_drawdown_tiers": self.profit_drawdown_tiers,
            "profit_drawdown_late": self.profit_drawdown_late,
        }

    @property
    def empty(self) -> bool:
        return (self.take_profit is None and self.stop_loss is None
                and self.trail_pct is None and self.profit_drawdown_pct is None
                and not self.profit_drawdown_tiers)


def _finite(value) -> Optional[float]:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


# ----------------------------------------------------------------------
# 盈亏
# ----------------------------------------------------------------------
def _minutes_of(hhmm: str) -> Optional[int]:
    try:
        h, m = str(hhmm).split(":")
        return int(h) * 60 + int(m)
    except (TypeError, ValueError):
        return None


def drawdown_threshold(
    targets: Targets,
    profit_peak: Optional[float],
    basis: Optional[float],
    minute: Optional[int] = None,
) -> Optional[float]:
    """此刻该用的利润回撤阈值(百分点)。没配分档就是那个固定值。

    分档按浮盈倍数 `profit_peak / |basis|` 选:取所有 above ≤ 当前倍数 里最高的一档。
    用绝对值是为了让贷方组合(记为空头、basis 为负)也说得通——那时倍数的含义是
    "赚到的 / 当初收的权利金"。
    """
    pct = _finite(targets.profit_drawdown_pct)
    tiers = targets.profit_drawdown_tiers or []
    peak = _finite(profit_peak)
    base = _finite(basis)
    if tiers and peak is not None and base:
        ratio = peak / abs(base)
        best_above: Optional[float] = None
        for tier in tiers:
            above = _finite((tier or {}).get("above"))
            tier_pct = _finite((tier or {}).get("pct"))
            if above is None or tier_pct is None or ratio < above:
                continue
            if best_above is None or above >= best_above:
                best_above, pct = above, tier_pct
    if pct is None:
        return None
    late = targets.profit_drawdown_late or {}
    after = _minutes_of(late.get("after")) if late.get("after") else None
    factor = _finite(late.get("factor"))
    if after is not None and factor is not None and minute is not None and minute >= after:
        pct *= factor
    return round(pct, 6)


def cost_basis(position: Position) -> float:
    """建仓总成本。

    **不乘乘数**:IBKR 的 avgCost 对期权已经是含乘数的整张成本(5.50 的期权
    avgCost 是 550)。这里再乘一次就会把成本放大一百倍,盈亏跟着全错。
    """
    return position.avg_cost * position.quantity


def market_value(position: Position, price: Optional[float]) -> Optional[float]:
    """当前市值。**这一侧要乘乘数**——报价是每股/每份的价格。"""
    price = _finite(price)
    if price is None:
        return None
    return price * (position.multiplier or 1.0) * position.quantity


def unrealized(position: Position, price: Optional[float]) -> Dict[str, Any]:
    """未实现盈亏。券商自己报了就用券商的——那才是对账口径。

    算不出来就老实回 None,绝不拿半个数凑一个看起来像模像样的盈亏。
    """
    basis = cost_basis(position)
    if position.unrealized_pnl is not None and _finite(position.unrealized_pnl) is not None:
        pnl = float(position.unrealized_pnl)
        source = "broker"
        value = _finite(position.market_value)
        if value is None:
            value = market_value(position, price)
    else:
        value = market_value(position, price)
        pnl = None if value is None else value - basis
        source = "computed"

    pct = None
    if pnl is not None and basis:
        # 空头的成本是负数,涨了反而亏——用绝对值做分母,百分比的符号跟着盈亏走
        pct = pnl / abs(basis) * 100.0

    return {
        "cost_basis": round(basis, 4),
        "market_value": None if value is None else round(value, 4),
        "unrealized_pnl": None if pnl is None else round(pnl, 4),
        "unrealized_pct": None if pct is None else round(pct, 3),
        "pnl_source": source,
    }


# ----------------------------------------------------------------------
# 设置校验
# ----------------------------------------------------------------------
def validate(position: Position, targets: Targets, price: Optional[float]) -> None:
    """设置时就把方向搞反的情况拦下来。

    多头的止盈填在现价下方、止损填在现价上方,提交那一刻就会立刻触发——
    等触发了才发现,已经晚了。所以在这里拒。
    """
    if targets.empty:
        raise TrackerError("至少要设一个:止盈价、止损价,或跟踪止损百分比。")
    if not position.quantity:
        raise TrackerError("这个持仓的数量是 0,没有可追踪的头寸。")

    for name, value in (("止盈价", targets.take_profit), ("止损价", targets.stop_loss)):
        if value is not None and (_finite(value) is None or value <= 0):
            raise TrackerError("%s必须是正数。" % name)
    if targets.trail_pct is not None:
        if _finite(targets.trail_pct) is None or not (0 < targets.trail_pct < 100):
            raise TrackerError("跟踪止损的回撤百分比要在 0 到 100 之间。")
    if targets.profit_drawdown_pct is not None:
        if (_finite(targets.profit_drawdown_pct) is None
                or not (0 < targets.profit_drawdown_pct < 100)):
            raise TrackerError("利润回撤的百分比要在 0 到 100 之间。")

    long = position.is_long
    tp, sl = targets.take_profit, targets.stop_loss

    # 排序检查放在取现价**之前**:止损和止盈的相对位置和现价无关,而行情断掉的
    # 时候恰恰是最需要它兜底的时候。放在后面的话它永远轮不到——现价已知时
    # "止损要低于现价"那条必然先命中,这条就成了死代码。
    if tp is not None and sl is not None:
        if long and sl >= tp:
            raise TrackerError("多头的止损价必须低于止盈价。")
        if not long and sl <= tp:
            raise TrackerError("空头的止损价必须高于止盈价。")

    price = _finite(price)
    if price is None:
        return          # 拿不到现价就不做方向校验,但也不假装校验过了

    if tp is not None:
        if long and tp <= price:
            raise TrackerError(
                "多头的止盈价要高于现价(现价 %.4f,你填了 %.4f)——填在下方会立刻触发。"
                % (price, tp)
            )
        if not long and tp >= price:
            raise TrackerError(
                "空头的止盈价要低于现价(现价 %.4f,你填了 %.4f)——空头是跌了才赚。"
                % (price, tp)
            )
    if sl is not None:
        if long and sl >= price:
            raise TrackerError(
                "多头的止损价要低于现价(现价 %.4f,你填了 %.4f)——填在上方会立刻触发。"
                % (price, sl)
            )
        if not long and sl <= price:
            raise TrackerError(
                "空头的止损价要高于现价(现价 %.4f,你填了 %.4f)。" % (price, sl)
            )


# ----------------------------------------------------------------------
# 跟踪止损
# ----------------------------------------------------------------------
def advance_peak(position: Position, price: Optional[float], peak: Optional[float]) -> Optional[float]:
    """把"最有利价"往前推。它只朝有利方向走,不回头。

    多头记最高价,空头记最低价。这个值必须存下来:重启后从当前价重新起算的话,
    已经锁住的那段利润就白锁了。
    """
    price = _finite(price)
    if price is None:
        return peak
    if peak is None:
        return price
    return max(peak, price) if position.is_long else min(peak, price)


def trail_stop_price(position: Position, peak: Optional[float], trail_pct: Optional[float]) -> Optional[float]:
    """跟踪止损当前落在哪个价位。"""
    peak = _finite(peak)
    pct = _finite(trail_pct)
    if peak is None or pct is None:
        return None
    ratio = pct / 100.0
    return peak * (1 - ratio) if position.is_long else peak * (1 + ratio)


# ----------------------------------------------------------------------
# 触发判断
# ----------------------------------------------------------------------
def evaluate(
    position: Position,
    targets: Targets,
    price: Optional[float],
    peak: Optional[float] = None,
    minute: Optional[int] = None,
) -> Dict[str, Any]:
    """现价 + 设置 + 峰值 → 当前状态。

    止损优先于止盈:同一个 tick 同时满足两边时(价格跳空穿过整个区间),按最坏的
    那一边算。宁可少赚,不可把一次跳空当成止盈。
    """
    price = _finite(price)
    peak = advance_peak(position, price, peak)
    trail = trail_stop_price(position, peak, targets.trail_pct)

    out: Dict[str, Any] = {
        "state": STATE_HOLDING,
        "price": price,
        "peak": peak,
        "trail_stop": None if trail is None else round(trail, 4),
        "reason": "",
    }
    out.update(unrealized(position, price))
    if price is None:
        out["state"] = STATE_HOLDING
        out["reason"] = "拿不到现价,本轮不判断"
        return out

    long = position.is_long
    # 有效止损 = 用户设的固定止损和跟踪止损里**更靠近现价**的那一个
    stops = [s for s in (targets.stop_loss, trail) if s is not None]
    stop = (max(stops) if long else min(stops)) if stops else None

    hit_stop = stop is not None and (price <= stop if long else price >= stop)
    hit_take = targets.take_profit is not None and (
        price >= targets.take_profit if long else price <= targets.take_profit
    )

    # 利润回撤:与当前利润同一口径(都按价格换算,不混用券商报的 pnl),
    # 峰值利润由峰值价格换算——利润对价格单调,所以这就是历史最高利润。
    profit_now = None
    profit_peak = None
    profit_dd = None
    hit_profit_trail = False
    threshold = None
    if (targets.profit_drawdown_pct is not None or targets.profit_drawdown_tiers) and peak is not None:
        basis = cost_basis(position)
        value_now = market_value(position, price)
        value_peak = market_value(position, peak)
        if value_now is not None and value_peak is not None:
            profit_now = value_now - basis
            profit_peak = value_peak - basis
            if profit_peak > 0:
                profit_dd = (1.0 - profit_now / profit_peak) * 100.0
                threshold = drawdown_threshold(targets, profit_peak, basis, minute)
                if threshold is not None:
                    hit_profit_trail = profit_now <= profit_peak * (1.0 - threshold / 100.0)
    out["profit_peak"] = None if profit_peak is None else round(profit_peak, 4)
    out["profit_drawdown_pct"] = None if profit_dd is None else round(profit_dd, 2)
    # 当前生效的档位:分档时每一轮都可能不一样,界面要能说清"现在让多少"
    out["profit_drawdown_threshold"] = None if threshold is None else round(threshold, 4)
    # 这一档对应的**价格**。百分比看不出紧迫感,"跌到 0.14 就平"才看得懂;
    # 分档时它会随档位跳变,所以每轮都要重算,不能在界面上按配置算一次了事。
    out["profit_trail_stop"] = (
        None if threshold is None else profit_trail_stop_price(position, peak, threshold)
    )

    if hit_stop:
        out["state"] = STATE_STOP_LOSS
        which = "跟踪止损" if (trail is not None and stop == trail) else "止损"
        out["reason"] = "%s触发:现价 %.4f %s %.4f" % (
            which, price, "跌破" if long else "涨破", stop
        )
    elif hit_profit_trail:
        out["state"] = STATE_PROFIT_TRAIL
        out["reason"] = "利润回撤触发:峰值利润 %.2f,当前 %.2f,回撤 %.1f%%(阈值 %.0f%%)" % (
            profit_peak, profit_now, profit_dd, threshold
        )
    elif hit_take:
        out["state"] = STATE_TAKE_PROFIT
        out["reason"] = "止盈触发:现价 %.4f %s %.4f" % (
            price, "涨到" if long else "跌到", targets.take_profit
        )

    out["stop_effective"] = None if stop is None else round(stop, 4)
    # 离触发还有多远,给界面画进度用
    out["to_take_profit_pct"] = _gap_pct(price, targets.take_profit)
    out["to_stop_pct"] = _gap_pct(price, stop)
    return out


def _gap_pct(price: Optional[float], target: Optional[float]) -> Optional[float]:
    price, target = _finite(price), _finite(target)
    if price is None or target is None or price == 0:
        return None
    return round((target / price - 1) * 100.0, 3)


def close_side(position: Position) -> str:
    """平掉这个持仓要下的方向。多头平仓是卖,空头平仓是买。"""
    return "SELL" if position.is_long else "BUY"


# ----------------------------------------------------------------------
# 到价自动平仓
# ----------------------------------------------------------------------
@dataclass
class AutoClose:
    """到价之后怎么平。

    默认关闭:打开它等于授权软件在你不在场时替你发单,这个决定应当是显式的。
    """

    enabled: bool = False
    order_type: str = "MKT"            # MKT 一定成交;LMT 控价但可能不成交
    slippage_pct: float = 0.3          # 仅 LMT:朝成交方向让这么多个百分点
    # 触发后平掉持仓的百分之多少。默认全平;设 50 即"卖出一半锁利"。
    # 部分平仓向下取整、至少 1 股/张、绝不超过持仓(见 build_close_order)。
    close_fraction_pct: float = 100.0
    # 把止盈/止损挂到券商服务器(GTC + OCA):软件关掉也生效。软件开着时,
    # 利润回撤等动态目标由引擎按秒调整托管单价格;关掉则停在最后一次调整。
    host_at_broker: bool = False

    def as_dict(self) -> Dict[str, Any]:
        return {
            "enabled": self.enabled,
            "order_type": self.order_type,
            "slippage_pct": self.slippage_pct,
            "close_fraction_pct": self.close_fraction_pct,
            "host_at_broker": self.host_at_broker,
        }


#: 自动平仓被挡住的原因。写成常量是因为界面和测试都要认它们。
BLOCK_DISABLED = "该持仓没有开启自动平仓"
BLOCK_AUTO_EXECUTE = "全局 auto_execute 未打开"
BLOCK_LIVE = "实盘账户需要先打开 allow_live_trading"
BLOCK_BREAKER = "已熔断,不再发出任何新单"
BLOCK_MARKET = "当前时段不能交易"
BLOCK_ALREADY = "这个追踪已经触发过一次,不重复发单"
BLOCK_QTY = "持仓数量为 0,没有可平的头寸"
BLOCK_COMBO_LIVE = "组合平仓单还没在实盘核对过,实盘账户需要先打开 allow_combo_live"


def close_blockers(
    *,
    auto: AutoClose,
    position: Position,
    account_is_paper: bool,
    auto_execute: bool,
    allow_live_trading: bool,
    breaker_engaged: bool,
    market_status: str,
    outside_rth: bool = False,
    already_fired: bool = False,
    combo_live_ok: bool = False,
) -> list:
    """自动平仓前要过的闸门。返回挡住它的所有原因,空列表表示可以发。

    **刻意不走 validator 那一套。** 那套闸门(单笔名义金额上限、期权张数上限、
    重复防抖、置信度)是为**开仓**设计的:它们限制的是"新增多少风险"。平仓是
    **减少**风险,拿开仓的限额去挡平仓,后果是持仓超过限额的人永远出不来——
    那比放开限额危险得多。

    所以这里只保留三类闸门:
      * 总开关(auto_execute / 每个追踪自己的 enabled)——授权问题;
      * 实盘闸门与熔断——安全问题;
      * 时段——现在能不能交易的客观事实。
    """
    blocked = []
    if not auto.enabled:
        blocked.append(BLOCK_DISABLED)
    if already_fired:
        blocked.append(BLOCK_ALREADY)
    if not position.quantity:
        blocked.append(BLOCK_QTY)
    if not auto_execute:
        blocked.append(BLOCK_AUTO_EXECUTE)
    if not account_is_paper and not allow_live_trading:
        blocked.append(BLOCK_LIVE)
    # 组合平仓要发 BAG 单,腿方向反转一步错就是反向建仓。纸面账户随便跑,实盘要另开
    # 一道闸——allow_live_trading 是"我允许这个软件碰实盘",不等于"我信任这条还没在
    # 真机上核对过的新路径"。核对通过之前,这两件事必须分开授权。
    if position.sec_type == "BAG" and not account_is_paper and not combo_live_ok:
        blocked.append(BLOCK_COMBO_LIVE)
    if breaker_engaged:
        blocked.append(BLOCK_BREAKER)
    tradable = {"盘中"} | (set(EXTENDED_SESSIONS) if outside_rth else set())
    if market_status not in tradable:
        blocked.append("%s(当前:%s)" % (BLOCK_MARKET, market_status))
    return blocked


def close_qty(position: Position, auto: AutoClose) -> int:
    """一次触发要平的数量。向下取整、至少 1 股/张、绝不超过持仓。"""
    qty_full = int(abs(position.quantity))
    if qty_full <= 0:
        raise TrackerError("持仓数量为 0,没有可平的头寸。")
    fraction = _finite(auto.close_fraction_pct)
    if fraction is None or not (0 < fraction <= 100):
        raise TrackerError("平仓比例要在 0(不含)到 100 之间。")
    if fraction >= 100:
        return qty_full
    return max(1, min(qty_full, int(qty_full * fraction / 100.0)))


def close_limit_price(
    position: Position, price: Optional[float], slippage_pct: float
) -> Optional[float]:
    """限价平仓的价格:朝**成交方向**让价。

    平多头是卖,要让低一点才卖得掉;平空头是买,要让高一点。让反了就是挂一张
    永远不会成交的单——而这张单存在的理由恰恰是"必须成交"。
    """
    price = _finite(price)
    pct = _finite(slippage_pct)
    if price is None or pct is None:
        return None
    ratio = abs(pct) / 100.0
    out = price * (1 - ratio) if position.is_long else price * (1 + ratio)
    # 对齐最小跳动:TWS 对不合跳动的限价直接拒单(错误 110),这张单就白发了。
    # 取整仍朝让价方向(卖向下、买向上),取整后只会更容易成交,不会更难。
    tick = close_tick(position)
    steps = math.floor(out / tick + 1e-9) if position.is_long else math.ceil(out / tick - 1e-9)
    out = steps * tick
    return round(max(out, tick), 4)


def close_contract(contract: Dict[str, Any]) -> Dict[str, Any]:
    """平仓单用的合约:股票只留四要素,走 SMART。

    持仓行里的合约是 TWS 报回来的样子(exchange=NASDAQ、tradingClass=NMS、multiplier="1"),
    原样拿去下单 TWS 会回 200「未找到证券定义」——模拟盘实测(2026-09-03)。期权腿保留
    到期/行权价/方向/tradingClass,那些是识别合约必需的;去掉值为 None 的字段。
    """
    sec_type = str(contract.get("secType") or "")
    if sec_type == "STK":
        return {
            "secType": "STK", "symbol": contract.get("symbol"),
            "exchange": "SMART", "currency": contract.get("currency") or "USD",
        }
    if sec_type == "BAG":
        return close_bag_contract(contract)
    return {k: v for k, v in contract.items() if v is not None}


def close_bag_contract(contract: Dict[str, Any]) -> Dict[str, Any]:
    """平组合的 BAG 合约:**每条腿的方向全部反转**,比例取绝对值。

    `combo_row` 存的 legs 里 ratio 是带符号的持仓比例(蝴蝶 +1/−2/+1)。平掉它要反着来:
    买入的腿卖掉、卖出的腿买回。腿的 action 才是真实方向——BAG 本身一律以 BUY 提交
    (见 broker.bag_signed_limit:IBKR 对 BAG 的 SELL 会把每条腿再反转一次,那就把
    保护翼卖了、收权腿买了,建出完全相反的结构)。

    比例只接受 1 或 2(Leg.ratio 的取值域,覆盖垂直价差/蝴蝶/铁鹰)。认不出的比例宁可
    报错也不猜:猜错的那张单会在券商侧变成一个谁也没打算持有的结构。
    """
    legs_in = contract.get("legs") or []
    if not legs_in:
        raise TrackerError("组合持仓没有腿信息,拼不出平仓的 BAG 合约。")
    legs: List[Dict[str, Any]] = []
    for leg in legs_in:
        ratio = _finite(leg.get("ratio"))
        if ratio is None or ratio == 0:
            raise TrackerError("组合的某条腿比例是 %r,认不出方向,拒绝拼平仓单。" % (leg.get("ratio"),))
        steps = int(round(abs(ratio)))
        if abs(abs(ratio) - steps) > 1e-6 or steps not in (1, 2):
            raise TrackerError(
                "组合的腿比例 %g 不是 1 或 2(只支持垂直价差/蝴蝶/铁鹰的标准比例),拒绝拼平仓单。"
                % ratio
            )
        for field in ("lastTradeDateOrContractMonth", "strike", "right"):
            if leg.get(field) in (None, ""):
                raise TrackerError("组合的某条腿缺少 %s,拼不出平仓的 BAG 合约。" % field)
        legs.append({
            "action": "SELL" if ratio > 0 else "BUY",       # 反转:持有买入腿 → 平仓卖出
            "ratio": steps,
            "lastTradeDateOrContractMonth": leg["lastTradeDateOrContractMonth"],
            "strike": float(leg["strike"]),
            "right": str(leg["right"])[:1].upper(),
            "multiplier": str(contract.get("multiplier") or "100"),
        })
    out: Dict[str, Any] = {
        "secType": "BAG",
        "symbol": contract.get("symbol"),
        "exchange": "SMART",
        "currency": contract.get("currency") or "USD",
        "legs": legs,
    }
    if contract.get("combo_strategy"):
        out["combo_strategy"] = contract["combo_strategy"]
    return out


def close_tick(position: Position) -> float:
    """平仓限价的最小跳动:股票 0.01;期权/组合保守取 0.05(对所有美股期权都合法)。"""
    return 0.01 if position.sec_type == "STK" else 0.05


#: 盘外时段:追踪照样盯、照样平,但交易所盘外只收限价单,平仓单在这些时段自动转限价并开盘外标志。
#: "盘外"来自**合约自己的**交易时段(见 config.hours_status):SPX 期权有 20:15–次日 09:25
#: 这一整段隔夜可交易时间,它既不是正股口径的"盘前"也不是"盘后",但一样只收限价单。
EXTENDED_SESSIONS = ("盘前", "盘后", "盘外")


def build_close_order(
    position: Position,
    auto: AutoClose,
    price: Optional[float],
    state: str,
    contract: Dict[str, Any],
    market_status: str = "盘中",
) -> Dict[str, Any]:
    """构造平仓单的载荷(给 models.ParsedOrder 用的 dict)。

    数量**取持仓的绝对值,一股不多**:多平一股就从平仓变成了反向开仓,而那是
    用户完全没有授权过的事。部分平仓(close_fraction_pct<100)向下取整、
    至少 1 股/张——取整只会让平得更少,永远不会更多。

    盘前/盘后(``market_status`` 在 EXTENDED_SESSIONS 里)追踪止盈同样要能平:
    交易所盘外不收市价单,所以市价平仓在这两个时段**自动转成限价单**(按
    slippage_pct 朝成交方向让价)并打上 outsideRth;拿不到现价算不出限价就拒绝,
    不能拿一张盘外根本不会成交的市价单冒充"已平仓"。
    """
    qty = close_qty(position, auto)
    qty_full = int(abs(position.quantity))
    side = close_side(position)
    why = {STATE_TAKE_PROFIT: "止盈", STATE_PROFIT_TRAIL: "利润回撤"}.get(state, "止损")
    extended = market_status in EXTENDED_SESSIONS
    # 组合一律不发市价单:BAG 的 MKT 会让每条腿各吃一次价差,0DTE 蝶的三条腿加起来
    # 能吃掉大半个净价。宁可挂一张让了滑点的限价单,也不把"成交价随缘"当成平仓。
    is_bag = position.sec_type == "BAG"
    order_type = "LMT" if ((extended or is_bag) and auto.order_type == "MKT") else auto.order_type
    order: Dict[str, Any] = {
        "action": side,
        "orderType": order_type,
        "totalQuantity": qty,
        "price_mode": "EXPLICIT",
        "tif": "DAY",
        "outsideRth": extended,
    }
    if order_type == "LMT":
        limit = close_limit_price(position, price, auto.slippage_pct)
        if limit is None:
            raise TrackerError(
                "组合只能限价平仓,但拿不到组合现价算不出限价——拒绝下单。" if is_bag
                else "盘外只能限价平仓,但拿不到现价算不出限价——拒绝下单。" if extended
                else "拿不到现价,限价平仓算不出限价——拒绝下单。"
            )
        order["lmtPrice"] = limit

    if order_type == "MKT":
        price_label = "市价"
    elif extended:
        price_label = "盘外限价 %s" % order.get("lmtPrice")
    else:
        price_label = "限价 %s" % order.get("lmtPrice")
    partial = "" if qty >= qty_full else ",平 %d/%d" % (qty, qty_full)
    return {
        "intent_summary": "%s平仓:%s %d %s(%s%s)" % (
            why, "卖出" if side == "SELL" else "买入", qty, position.symbol,
            price_label,
            partial,
        ),
        "contract": close_contract(contract),
        "execution_type": "IMMEDIATE",
        "trigger": None,
        "account": position.account,
        "order": order,
        "reason": "持仓追踪%s触发,自动平仓" % why,
        "confidence": 1.0,          # 不是模型解析出来的,是规则算出来的
        "warnings": [],
    }


# ----------------------------------------------------------------------
# 券商托管:把止盈/止损挂到券商服务器上
# ----------------------------------------------------------------------
# 软件盯盘的三个天生短板——轮询间隙漏插针、软件必须开着、我们这头的行情可能
# 是延迟的——托管单全部没有:触发发生在券商服务器的实时行情上。代价是动态
# 目标(利润回撤)券商表达不了,只能由引擎把它化成"随峰值棘轮移动的停损价",
# 按秒改托管单;软件关掉,调整停在最后一次,单子本身仍站岗。

HOSTED_KIND_TP = "tp"          # 止盈:GTC 限价单
HOSTED_KIND_SL = "sl"          # 止损:GTC 停损单
HOSTED_KIND_TRAIL = "trail"    # 价格跟踪止损:IBKR 原生 TRAIL 单
HOSTED_KIND_PTRAIL = "ptrail"  # 利润回撤:引擎按秒调整停损价的 STP 单

HOSTED_LABELS = {
    HOSTED_KIND_TP: "托管止盈",
    HOSTED_KIND_SL: "托管止损",
    HOSTED_KIND_TRAIL: "托管跟踪止损",
    HOSTED_KIND_PTRAIL: "利润回撤动态停损",
}


def _hosted_price(value: Optional[float]) -> Optional[float]:
    """托管单的价格统一收敛到 2 位小数(美股最小报价单位),且不小于 0.01。

    4 位小数的停损价会被 IBKR 以 110(价格档位不合法)拒掉——那张单存在的
    理由恰恰是"必须挂得上"。
    """
    value = _finite(value)
    if value is None:
        return None
    return round(max(value, 0.01), 2)


def profit_trail_stop_price(
    position: Position, peak: Optional[float], drawdown_pct: Optional[float]
) -> Optional[float]:
    """把"利润回撤 N%"换算成一个停损价。

    利润对价格是线性的:profit(p) = qty·mult·(p − c),c 为每股成本。
    多头触发条件 profit ≤ peak_profit·(1−d) 等价于 p ≤ c + (峰值−c)·(1−d);
    空头对称。峰值利润必须为正(峰值越过成本)才挂——和 evaluate() 的
    "从未盈利不触发"同一条规则,两条路径必须给出同一个触发价。
    """
    peak = _finite(peak)
    dd = _finite(drawdown_pct)
    if peak is None or dd is None or not (0 < dd < 100):
        return None
    mult = position.multiplier or 1.0
    cost = position.avg_cost / mult          # 每股成本(avg_cost 含乘数)
    keep = 1.0 - dd / 100.0
    if position.is_long:
        if peak <= cost:
            return None                       # 从未盈利,没有可回撤的利润
        return cost + (peak - cost) * keep
    if peak >= cost:
        return None
    return cost - (cost - peak) * keep


def hosted_plan(
    position: Position, targets: Targets, auto: AutoClose, peak: Optional[float]
) -> list:
    """要挂在券商侧的订单清单(纯函数,顺序固定:tp、sl、trail、ptrail)。

    同一追踪的所有托管单共用一个 OCA 组:一张成交,券商自动撤掉其余——
    与软件盯盘"触发一次就落闩"的语义一致。TRAIL 用持久化峰值播种初始停损,
    重启不把已锁住的利润放开。
    """
    if not auto.host_at_broker:
        return []
    qty = close_qty(position, auto)
    side = close_side(position)
    plan = []

    tp = _hosted_price(targets.take_profit)
    if tp is not None:
        plan.append({
            "kind": HOSTED_KIND_TP, "action": side, "order_type": "LMT",
            "quantity": qty, "lmt_price": tp, "aux_price": None,
            "trailing_percent": None, "trail_stop_seed": None,
            "label": "%s %s" % (HOSTED_LABELS[HOSTED_KIND_TP], tp),
        })
    sl = _hosted_price(targets.stop_loss)
    if sl is not None:
        plan.append({
            "kind": HOSTED_KIND_SL, "action": side, "order_type": "STP",
            "quantity": qty, "lmt_price": None, "aux_price": sl,
            "trailing_percent": None, "trail_stop_seed": None,
            "label": "%s %s" % (HOSTED_LABELS[HOSTED_KIND_SL], sl),
        })
    trail = _finite(targets.trail_pct)
    if trail is not None and 0 < trail < 100:
        seed = _hosted_price(trail_stop_price(position, peak, trail))
        plan.append({
            "kind": HOSTED_KIND_TRAIL, "action": side, "order_type": "TRAIL",
            "quantity": qty, "lmt_price": None, "aux_price": None,
            "trailing_percent": trail, "trail_stop_seed": seed,
            "label": "%s %s%%" % (HOSTED_LABELS[HOSTED_KIND_TRAIL], _fmt_pct(trail)),
        })
    pstop = _hosted_price(
        profit_trail_stop_price(position, peak, targets.profit_drawdown_pct)
    )
    if pstop is not None:
        plan.append({
            "kind": HOSTED_KIND_PTRAIL, "action": side, "order_type": "STP",
            "quantity": qty, "lmt_price": None, "aux_price": pstop,
            "trailing_percent": None, "trail_stop_seed": None,
            "label": "%s %s" % (HOSTED_LABELS[HOSTED_KIND_PTRAIL], pstop),
        })
    return plan


def _fmt_pct(value: float) -> str:
    return ("%g" % value)


def hosted_needs_update(current: Dict[str, Any], desired: Dict[str, Any]) -> bool:
    """托管单要不要改。只看会变的字段,阈值 0.01——1 美分以下的调整只是抖动。

    TRAIL 的 seed 只在挂单时用一次,券商侧自己棘轮,不参与比较。
    """
    if int(current.get("quantity") or 0) != int(desired.get("quantity") or 0):
        return True
    for key in ("lmt_price", "aux_price", "trailing_percent"):
        a, b = _finite(current.get(key)), _finite(desired.get(key))
        if (a is None) != (b is None):
            return True
        # 按"分"比较,不做浮点减法:0.01 的差在二进制里是 0.00999…,
        # 拿它和 0.01 比大小恰好在阈值上抖
        if a is not None and b is not None and round(a * 100) != round(b * 100):
            return True
    return False
