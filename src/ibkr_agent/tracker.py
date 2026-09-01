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
from typing import Any, Dict, Optional

# 触发状态。holding = 还在持有,两个 hit 是到价了。
STATE_HOLDING = "holding"
STATE_TAKE_PROFIT = "take_profit"
STATE_STOP_LOSS = "stop_loss"


class TrackerError(ValueError):
    """设置不合法。用 ValueError 是为了让 RPC 层统一按"参数错误"回。"""


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

    @property
    def is_long(self) -> bool:
        return self.quantity > 0

    @property
    def key(self) -> str:
        """同一个账户里同一个合约只该有一条持仓。"""
        return "%s|%s|%s" % (self.account, self.symbol, self.sec_type)


@dataclass
class Targets:
    """用户设的止盈止损。三项都可以不填,不填就是不管那一头。"""

    take_profit: Optional[float] = None      # 价格
    stop_loss: Optional[float] = None        # 价格
    trail_pct: Optional[float] = None        # 跟踪止损:从最有利价回撤这么多个百分点

    def as_dict(self) -> Dict[str, Any]:
        return {
            "take_profit": self.take_profit,
            "stop_loss": self.stop_loss,
            "trail_pct": self.trail_pct,
        }

    @property
    def empty(self) -> bool:
        return self.take_profit is None and self.stop_loss is None and self.trail_pct is None


def _finite(value) -> Optional[float]:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


# ----------------------------------------------------------------------
# 盈亏
# ----------------------------------------------------------------------
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

    if hit_stop:
        out["state"] = STATE_STOP_LOSS
        which = "跟踪止损" if (trail is not None and stop == trail) else "止损"
        out["reason"] = "%s触发:现价 %.4f %s %.4f" % (
            which, price, "跌破" if long else "涨破", stop
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

    def as_dict(self) -> Dict[str, Any]:
        return {
            "enabled": self.enabled,
            "order_type": self.order_type,
            "slippage_pct": self.slippage_pct,
        }


#: 自动平仓被挡住的原因。写成常量是因为界面和测试都要认它们。
BLOCK_DISABLED = "该持仓没有开启自动平仓"
BLOCK_AUTO_EXECUTE = "全局 auto_execute 未打开"
BLOCK_LIVE = "实盘账户需要先打开 allow_live_trading"
BLOCK_BREAKER = "已熔断,不再发出任何新单"
BLOCK_MARKET = "当前时段不能交易"
BLOCK_ALREADY = "这个追踪已经触发过一次,不重复发单"
BLOCK_QTY = "持仓数量为 0,没有可平的头寸"


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
    if breaker_engaged:
        blocked.append(BLOCK_BREAKER)
    tradable = {"盘中"} | ({"盘前", "盘后"} if outside_rth else set())
    if market_status not in tradable:
        blocked.append("%s(当前:%s)" % (BLOCK_MARKET, market_status))
    return blocked


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
    return round(max(out, 0.01), 4)


def build_close_order(
    position: Position,
    auto: AutoClose,
    price: Optional[float],
    state: str,
    contract: Dict[str, Any],
) -> Dict[str, Any]:
    """构造平仓单的载荷(给 models.ParsedOrder 用的 dict)。

    数量**取持仓的绝对值,一股不多**:多平一股就从平仓变成了反向开仓,而那是
    用户完全没有授权过的事。
    """
    qty = int(abs(position.quantity))
    if qty <= 0:
        raise TrackerError("持仓数量为 0,没有可平的头寸。")

    side = close_side(position)
    why = "止盈" if state == STATE_TAKE_PROFIT else "止损"
    order: Dict[str, Any] = {
        "action": side,
        "orderType": auto.order_type,
        "totalQuantity": qty,
        "price_mode": "EXPLICIT",
        "tif": "DAY",
        "outsideRth": False,
    }
    if auto.order_type == "LMT":
        limit = close_limit_price(position, price, auto.slippage_pct)
        if limit is None:
            raise TrackerError("拿不到现价,限价平仓算不出限价——拒绝下单。")
        order["lmtPrice"] = limit

    return {
        "intent_summary": "%s平仓:%s %d %s(%s)" % (
            why, "卖出" if side == "SELL" else "买入", qty, position.symbol,
            "市价" if auto.order_type == "MKT" else "限价 %s" % order.get("lmtPrice"),
        ),
        "contract": contract,
        "execution_type": "IMMEDIATE",
        "trigger": None,
        "account": position.account,
        "order": order,
        "reason": "持仓追踪%s触发,自动平仓" % why,
        "confidence": 1.0,          # 不是模型解析出来的,是规则算出来的
        "warnings": [],
    }
