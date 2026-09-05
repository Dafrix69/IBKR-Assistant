"""IBKR 下单层(设计文档 §8)。

结构上刻意把"算什么"和"连什么"分开:
  * 纯函数(build_ib_order / combo_mid_price / auto_mid_limit / price_condition_spec)
    不碰网络,可以脱离 TWS 单测——这是下单路径上最容易算错的部分;
  * BrokerRouter 负责连接与路由:实盘/模拟是两条独立会话(§8.2a),
    别名→账号的映射早在 validator 里完成,这里只认 AccountConfig。

ib_insync 已停止维护,其维护分支 ib_async 需要 Python ≥3.10;两者 API 同名,
所以这里优先 import ib_async,回落 ib_insync,升级 Python 后无需改代码。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .config import AccountConfig, Settings, now_et
from .models import ContractSpec, OrderSpec, ParsedOrder, TriggerSpec
from .priceaction import MIN_BARS, TIMEFRAMES
from .validator import ApprovedOrder


class BrokerError(RuntimeError):
    pass


def _ib():
    """延迟导入,并优先使用维护中的 ib_async。"""
    try:
        import ib_async as mod  # type: ignore
        return mod
    except ImportError:
        pass
    try:
        import ib_insync as mod  # type: ignore
        return mod
    except ImportError as exc:  # pragma: no cover
        raise BrokerError("未安装 ib_async / ib_insync") from exc


# ======================================================================
# 纯计算部分(可单测)
# ======================================================================


@dataclass(frozen=True)
class LegQuote:
    action: str          # BUY / SELL
    ratio: int
    bid: float
    ask: float

    @property
    def mid(self) -> float:
        # NaN 在 <=、< 里全为 False,普通比较拦不住,必须显式 isfinite
        if (
            not math.isfinite(self.bid)
            or not math.isfinite(self.ask)
            or self.bid <= 0
            or self.ask <= 0
            or self.ask < self.bid
        ):
            raise BrokerError("盘口不可用(bid=%s ask=%s),拒绝用坏报价定价" % (self.bid, self.ask))
        return (self.bid + self.ask) / 2.0


def combo_mid_price(legs: Sequence[LegQuote]) -> float:
    """价差净价 = Σ(买腿中间价) - Σ(卖腿中间价)。正数=借方,负数=贷方。"""
    if not legs:
        raise BrokerError("没有腿报价,无法计算中间价")
    net = 0.0
    for leg in legs:
        sign = 1.0 if leg.action == "BUY" else -1.0
        net += sign * leg.mid * leg.ratio
    return round(net, 4)


def fill_row(fill) -> Optional[Dict[str, Any]]:
    """ib_insync 的 Fill → 本系统的成交行。时间统一成 UTC ISO;拿不到 execId 的行丢掉。"""
    from datetime import datetime as _dt, timezone as _tz

    execution = getattr(fill, "execution", None)
    contract = getattr(fill, "contract", None)
    if execution is None or contract is None:
        return None
    exec_id = str(getattr(execution, "execId", "") or "")
    if not exec_id:
        return None
    when = getattr(execution, "time", None)
    if isinstance(when, _dt):
        time_iso = (when.astimezone(_tz.utc) if when.tzinfo else when.replace(tzinfo=_tz.utc)).isoformat()
    else:
        time_iso = str(when or "")
    report = getattr(fill, "commissionReport", None)
    commission = _finite_quote(getattr(report, "commission", None)) if report is not None else None
    strike = _finite_quote(getattr(contract, "strike", None))
    return {
        "exec_id": exec_id,
        "time": time_iso,
        "account_id": str(getattr(execution, "acctNumber", "") or ""),
        "side": str(getattr(execution, "side", "") or ""),
        "shares": float(getattr(execution, "shares", 0) or 0),
        "price": float(getattr(execution, "price", 0) or 0),
        "order_id": int(getattr(execution, "orderId", 0) or 0) or None,
        "perm_id": int(getattr(execution, "permId", 0) or 0) or None,
        "order_ref": str(getattr(execution, "orderRef", "") or ""),
        "commission": commission,
        "contract": {
            "secType": str(getattr(contract, "secType", "") or ""),
            "symbol": str(getattr(contract, "symbol", "") or ""),
            "expiry": str(getattr(contract, "lastTradeDateOrContractMonth", "") or ""),
            "strike": strike or None,
            "right": str(getattr(contract, "right", "") or ""),
            "tradingClass": str(getattr(contract, "tradingClass", "") or ""),
            "multiplier": str(getattr(contract, "multiplier", "") or ""),
            "conId": int(getattr(contract, "conId", 0) or 0) or None,
            "currency": str(getattr(contract, "currency", "") or ""),
            "exchange": str(getattr(contract, "exchange", "") or ""),
        },
    }


#: 组合净价的最小跳动。IBKR 对 BAG 不给 contractDetails('BAG' isn't supported for
#: contract data request),但每条 SPX 期权腿实测 minTick=0.05,组合净价按同一档走。
#: 不对齐的后果是**下单当场被拒**:错误 110「价格不符合该合约的最小价格变动要求」——
#: 2026-09-04 实测,AUTO_MID 算出 0.1750(3.5 个 tick),IBKR 直接退单。
DEFAULT_COMBO_TICK = 0.05


def align_tick_up(value: float, tick: float = DEFAULT_COMBO_TICK) -> float:
    """把限价向上对齐到最小跳动的整数倍。

    统一向上,是因为 auto_mid_limit 的让价方向本来就是 `+slippage`(见下):借方多付一点、
    贷方少收一点,两边都朝**更容易成交**的方向。对齐后仍朝同一方向,不会把一张本来能成的
    单子改成挂着不动。
    """
    if not math.isfinite(value) or tick <= 0 or not math.isfinite(tick):
        return value
    # 减一点容差:已经对齐的值不该因为浮点误差被推到下一档(0.20/0.05 = 4.000000001 → 5)
    steps = math.ceil(value / tick - 1e-9)
    return round(steps * tick, 4)


def auto_mid_limit(
    net_mid: float, action: str, slippage: float, strike_width: Optional[float] = None,
    tick: float = DEFAULT_COMBO_TICK,
) -> float:
    """把带符号中间价转成 BAG(以 BUY 提交)可用的带符号限价。

    符号约定(与 combo_mid_price 一致,也是 IBKR BAG 的原生口径):
      正数 = 借方(付权利金),负数 = 贷方(收权利金)。
    BAG 一律以 BUY 提交(见 bag_signed_limit 的说明),BUY 限价的含义是
    "净价不高于 limit",所以无论借贷方,让价方向都是 +slippage(往 0 的
    方向让,即借方多付一点 / 贷方少收一点)。

    * action=BUY(借方):mid 应为正;上限再叠行权价差(净权利金不可能超过
      宽度,§5.3a);算出的限价 ≤0 说明报价与结构方向不符,拒绝。
    * action=SELL(贷方):mid 应为负(卖出收钱);算出的限价必须仍 <0,
      否则滑点已把权利金吃光,拒绝。mid 为正说明腿方向与订单方向不一致
      ——这正是修复前会反向建仓的场景,直接拒绝。
    """
    if slippage < 0:
        raise BrokerError("滑点上限不能为负")
    if not math.isfinite(net_mid):
        raise BrokerError("中间价不是有限数值(%s),拒绝定价" % net_mid)
    if action == "SELL" and net_mid >= 0:
        raise BrokerError(
            "贷方组合的净中间价应为负(收权利金),实际为 %.4f——腿方向与订单方向"
            "不一致,拒绝定价以免反向建仓。" % net_mid
        )
    if action == "BUY" and net_mid <= 0:
        raise BrokerError(
            "借方组合的净中间价应为正(付权利金),实际为 %.4f——腿方向与订单方向"
            "不一致,拒绝定价以免反向建仓。" % net_mid
        )
    limit = align_tick_up(net_mid + slippage, tick)
    if action == "BUY":
        if strike_width is not None:
            # 净权利金不可能超过翼宽(§5.3a)。夹回来之后再对齐一次,方向朝下——
            # 上限本身通常已经是整数点位,这一步只是防御。
            limit = min(limit, align_tick_down(strike_width, tick))
        if limit <= 0:
            raise BrokerError("计算出的买入限价 %.4f 非正,拒绝下单" % limit)
    else:
        if limit >= 0:
            raise BrokerError(
                "贷方限价 %.4f 已不再为负(滑点吃光了权利金),拒绝下单" % limit
            )
    return round(limit, 4)


def align_tick_down(value: float, tick: float = DEFAULT_COMBO_TICK) -> float:
    """向下对齐到最小跳动(只给上限夹取用,免得夹完又变成非法档位)。"""
    if not math.isfinite(value) or tick <= 0 or not math.isfinite(tick):
        return value
    steps = math.floor(value / tick + 1e-9)
    return round(steps * tick, 4)


def bag_signed_limit(action: str, user_limit: Optional[float]) -> Optional[float]:
    """把用户口径的组合限价转成 IBKR BAG 的带符号净价。

    IBKR 对 BAG 的语义:BUY 按每条腿声明的方向原样执行,SELL 则把每条腿
    **反转**。本系统的腿(ComboLeg.action)已经表达了真实持仓方向,所以
    BAG 必须一律以 BUY 提交——修复前"卖出铁鹰"用 action=SELL 提交,
    IBKR 会卖掉保护翼、买入收权腿,建出完全相反的风险结构。

    用户/LLM/校验层的口径保持不变:贷方结构 action=SELL + 正数权利金。
    转换只发生在这里:贷方限价取负(BUY @ -12 = 净收至少 12)。
    """
    if user_limit is None:
        return None
    return -user_limit if action == "SELL" else user_limit


def book_liquidity(book: Dict[str, Any]) -> Dict[str, Any]:
    """从盘口算流动性指标(纯计算,可单测)。

    spread_bps 分级参考美股正股的常见量级:≤5bp 很好、≤20bp 尚可、更宽要当心;
    imbalance = (买量−卖量)/(买量+卖量),正数买盘厚。**挂单可撤,失衡只是即时
    快照,不是方向预测**——界面上必须这么说,不能让它看起来像信号。
    """
    l1 = book.get("l1") or {}
    bids, asks = book.get("bids") or [], book.get("asks") or []
    out: Dict[str, Any] = {}

    spread_bps = l1.get("spread_bps")
    if spread_bps is not None:
        out["spread_bps"] = spread_bps
        out["spread_grade"] = (
            "很好" if spread_bps <= 5 else "尚可" if spread_bps <= 20
            else "偏宽" if spread_bps <= 60 else "很宽"
        )

    bid_depth = sum(float(x.get("size") or 0) for x in bids)
    ask_depth = sum(float(x.get("size") or 0) for x in asks)
    if bids or asks:
        out["bid_depth"] = round(bid_depth, 2)
        out["ask_depth"] = round(ask_depth, 2)
        out["levels"] = max(len(bids), len(asks))
        total = bid_depth + ask_depth
        if total > 0:
            out["imbalance_pct"] = round((bid_depth - ask_depth) / total * 100.0, 1)
    elif l1.get("bid_size") or l1.get("ask_size"):
        # 只有一档时也给个失衡度,标明样本只有 L1
        b, a = float(l1.get("bid_size") or 0), float(l1.get("ask_size") or 0)
        if b + a > 0:
            out["imbalance_pct"] = round((b - a) / (b + a) * 100.0, 1)
            out["l1_only"] = True
    return out


def _bars_error(symbol: str, label: str, exc: Exception) -> str:
    """把 IBKR 的取数报错翻译成"下一步该做什么"。

    行情权限是这条链路最常见的坑,而 IBKR 的原文(error 162 / 354)只会说
    "no market data permissions",不会告诉你去哪开。
    """
    text = str(exc)
    if "162" in text or "354" in text or "permission" in text.lower() or "subscri" in text.lower():
        return (
            "%s 没有 %s 的行情权限。IBKR 的历史数据同样要订阅,连延迟数据也要账户里"
            "先开通对应交易所。去 IBKR 账户管理 → Settings → User Settings → "
            "Market Data Subscriptions 里订阅该标的所属交易所(美股至少要一档 Level 1;"
            "SPX / VIX / RUT 这类指数属于 Cboe,要单独订阅)。原始报错:%s"
            % (symbol, label, text[:200])
        )
    return "获取 %s 的 %s K 线失败:%s" % (symbol, label, text[:300])


def bar_timestamp(value) -> str:
    """IBKR 的 bar.date 归一化成 'YYYY-MM-DD HH:MM'(日线为 'YYYY-MM-DD')。

    三种形态都要接:日内的 datetime、日线的 date,以及 ib_insync 没能解析、
    原样透出的字符串('20260819  09:35:00')。解析不了就原样返回——
    时间戳错了宁可在界面上显眼,也不要悄悄编一个。
    """
    from datetime import date as _date, datetime as _datetime

    from .config import ET

    if isinstance(value, _datetime):
        # ib_insync 给的是**交易所时区**的 aware datetime(SPX 在 Cboe → 美中,比美东慢一小时)。
        # 直接 strftime 会把 11:40 美中当成 11:40 美东,K 线看起来永远"落后一小时",
        # 新鲜度告警也跟着误报。全系统的钟是美东,先换过去再落成字符串。
        if value.tzinfo is not None:
            value = value.astimezone(ET)
        return value.strftime("%Y-%m-%d %H:%M")
    if isinstance(value, _date):
        return value.isoformat()

    text = str(value).strip()
    digits = text.replace("-", "").replace(":", "").split()
    # 原样透出的字符串可能带时区名('20260902 11:40:00 US/Central'):同样换成美东
    if len(digits) >= 3 and "/" in digits[2] and digits[0].isdigit() and digits[1][:6].isdigit():
        try:
            from zoneinfo import ZoneInfo

            stamp = _datetime.strptime(digits[0] + digits[1][:6], "%Y%m%d%H%M%S").replace(
                tzinfo=ZoneInfo(digits[2])
            )
            return stamp.astimezone(ET).strftime("%Y-%m-%d %H:%M")
        except Exception:  # noqa: BLE001 - 时区名认不出就走下面的老路径,不编
            pass
    if digits and len(digits[0]) == 8 and digits[0].isdigit():
        day = "%s-%s-%s" % (digits[0][:4], digits[0][4:6], digits[0][6:8])
        if len(digits) > 1 and len(digits[1]) >= 4 and digits[1][:6].isdigit():
            return "%s %s:%s" % (day, digits[1][:2], digits[1][2:4])
        return day
    return text


def redact_for_log(account_id: str) -> str:
    """日志里的账号一律掩码(§9.3),与 store.redact_account 同规则。"""
    return account_id[:2] + "***" + account_id[-3:] if len(account_id) > 5 else "***"


def _log_stderr(message: str) -> None:
    import sys

    try:
        print(message, file=sys.stderr, flush=True)
    except Exception:  # noqa: BLE001 - 日志失败绝不影响交易路径
        pass


def _clean_price(value) -> Optional[float]:
    """把 IBKR 的报价字段清洗成可用数字:NaN / 非正 / 非数字都归 None。"""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v) or v <= 0:
        return None
    return v


def _finite_quote(value) -> float:
    """定价链路用:None/NaN/inf 一律归 0(无报价),交给 LegQuote.mid 的守卫拦截。

    ib_insync 未收到行情时 ticker.bid/ask 是 float('nan'),而 NaN 在
    `x or 0.0`、`x <= 0` 里全都测不出来——它是真值且所有比较为 False,
    会一路穿过守卫变成 lmtPrice=NaN 的废单。必须显式 isfinite。
    """
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    return v if math.isfinite(v) else 0.0


#: 取盘口时值得告诉用户"为什么"的 IBKR 错误码。别的错误(连接农场通断 21xx 等)不归这里管。
#:   101   行情线路配额用完(默认约 100 条并发),新请求全部被拒——ticker 永远是 NaN
#:   354 / 10089 / 10090 / 10091 / 10167 / 10168   没有(实时或延迟)行情订阅
#:   10197 纸面账户与另一个会话争用行情
_MD_ERROR_CODES = frozenset({101, 354, 10089, 10090, 10091, 10167, 10168, 10197})


def _quote_error_message(symbol: str, errors: Sequence[tuple]) -> str:
    """把取盘口时 TWS 回的错误码翻译成"下一步做什么"。

    没有这一层时用户只能看到守卫那句"盘口不可用(bid=0.0 ask=0.0)",分不清是没订阅、
    线路用完还是行情源真的空——三种情况的处理方法完全不同。
    """
    codes = {int(c) for c, _ in errors}
    raw = "; ".join("%s: %s" % (c, str(m)[:120]) for c, m in errors[:3])
    if 101 in codes:
        return (
            "TWS 的行情线路已用完(IBKR 默认约 100 条并发),%s 的盘口请求被拒。"
            "顶栏「断开 TWS」再重连可立即释放全部线路;若反复出现,说明有订阅没撤。"
            "原始报错:%s" % (symbol, raw)
        )
    if 10197 in codes:
        return (
            "%s 的行情被另一个会话占用(IBKR 10197):同一账号同时登着别的 TWS/客户端时,"
            "行情只发给其中一个。关掉另一个再试。原始报错:%s" % (symbol, raw)
        )
    return (
        "该账户没有 %s 的行情订阅(实时和延迟都没有)。SPX / SPXW / VIX 属 Cboe 指数期权,"
        "要在 IBKR 账户管理 → Market Data Subscriptions 单独订阅;纸面账户还需在实盘账户里"
        "开启「与模拟账户共享行情」。原始报错:%s" % (symbol, raw)
    )


def strike_width(contract: ContractSpec) -> Optional[float]:
    """AUTO_MID 借方限价的数学上限:净权利金不可能超过这个宽度。

    垂直价差=行权价差;蝴蝶=翼宽。铁鹰是贷方结构(卖出收权利金),
    买方向的上限不适用,返回 None。
    """
    legs = sorted(contract.legs or [], key=lambda l: l.strike)
    if contract.combo_strategy == "BUTTERFLY" and len(legs) == 3:
        return legs[1].strike - legs[0].strike
    if len(legs) == 2:
        return abs(legs[0].strike - legs[1].strike)
    return None


def price_condition_spec(trigger: TriggerSpec) -> Dict[str, Any]:
    """把 trigger 描述成 ib_insync PriceCondition 需要的参数(纯数据,便于断言)。"""
    return {
        "symbol": trigger.symbol,
        "secType": trigger.secType,
        "isMore": trigger.operator == ">=",
        "price": trigger.value,
    }


def build_ib_order(
    spec: OrderSpec,
    account_id: str,
    limit_override: Optional[float] = None,
    action_override: Optional[str] = None,
):
    """按 orderType 构造 ib_insync Order。价格为空的组合在这里就报错,不留到 IBKR。

    action_override / limit_override 供 BAG 使用:组合单一律以 BUY 提交、
    贷方用带符号(负)净价,见 bag_signed_limit 的说明。
    """
    ib = _ib()
    action = action_override or spec.action
    limit_price = limit_override if limit_override is not None else spec.lmtPrice

    if spec.orderType == "MKT":
        order = ib.MarketOrder(action, spec.totalQuantity)
    elif spec.orderType == "LMT":
        if limit_price is None:
            raise BrokerError("限价单缺少限价(AUTO_MID 未定价?),拒绝下单")
        order = ib.LimitOrder(action, spec.totalQuantity, limit_price)
    elif spec.orderType == "STP":
        order = ib.StopOrder(action, spec.totalQuantity, spec.auxPrice)
    elif spec.orderType == "STP LMT":
        order = ib.StopLimitOrder(action, spec.totalQuantity, limit_price, spec.auxPrice)
    elif spec.orderType == "TRAIL":
        order = ib.Order(
            orderType="TRAIL", action=action, totalQuantity=spec.totalQuantity
        )
        if spec.trailingPercent is not None:
            order.trailingPercent = spec.trailingPercent
        else:
            order.auxPrice = spec.auxPrice
    else:  # pragma: no cover - Literal 已限制取值
        raise BrokerError("不支持的订单类型:%s" % spec.orderType)

    order.tif = spec.tif
    order.outsideRth = spec.outsideRth
    order.account = account_id
    order.transmit = True
    return order


# ======================================================================
# 连接与下单
# ======================================================================


@dataclass
class PendingTrigger:
    """方式 B:软件侧盯盘队列(AUTO_MID 定价必须走这条路,见 §8.1)。"""

    record_id: str
    approved: ApprovedOrder
    trigger: TriggerSpec
    created_at: str
    fired: bool = False

    def should_fire(self, price: float) -> bool:
        if self.trigger.operator == ">=":
            return price >= self.trigger.value
        return price <= self.trigger.value


@dataclass
class PlacementResult:
    record_id: str
    order_id: Optional[int] = None
    perm_id: Optional[int] = None
    status: str = "Submitted"
    limit_price: Optional[float] = None
    detail: Dict[str, Any] = field(default_factory=dict)


class BrokerRouter:
    """按账户别名把订单路由到对应的 TWS/Gateway 会话。"""

    #: 这个 router 说的是哪家券商的协议。配置里两家的连接混在一张表里,
    #: 所有查表的地方都必须先按它筛一遍——7497 和 11111 都能连上 TCP,
    #: 发错了只会表现为"握手一直超时",查不出原因。
    BROKER = "ibkr"
    #: 支持把触发条件挂在券商服务器上(§8.1 方式 A)。IBKR 支持,所以软件
    #: 掉线条件单依然有效;不支持的券商只能退到方式 B 的软件盯盘。
    SUPPORTS_NATIVE_CONDITIONS = True

    def __init__(self, settings: Settings):
        self.settings = settings
        self._connections: Dict[str, Any] = {}
        # 账户实际归属的连接缓存(账号 → 连接名)。TWS 同一时刻只有一个会话,
        # 用户在 TWS 里切换实盘/模拟登录后,静态的"账户→连接"配置就会过期,
        # for_account 会按 managedAccounts 实测改道并记在这里。
        self._account_route: Dict[str, str] = {}
        # 新会话建立时的回调(engine 用它挂订单回报监听)。
        # 没有它,TWS 重启后 connect() 悄悄换上的新 IB 对象不带任何监听,
        # 此后所有成交回报都进黑洞。
        self.session_hook: Optional[Any] = None
        # 常驻流式行情:symbol → ticker。宏观行情带要秒级刷新,不能每次都
        # reqMktData + sleep(2.5) —— 那样既慢又会把行情线路配额耗光。
        self._streams: Dict[str, Any] = {}
        # TWS 与 IBKR 服务器之间那一段是否通(错误 1100 断 / 1101、1102 恢复)。
        # 这段断了的时候本机到 TWS 的 socket 仍然活着、isConnected() 仍是 True,
        # 只能靠事件分辨——分辨不出来的后果见 _qualify_or_raise 的注释。
        self._upstream_ok = True
        # 托管单:orderId → (ib, trade)。改单必须拿着原 Order 对象同 id 重发,
        # 认领(list_hosted_open)和挂单(place_hosted)都会往这里登记。
        self._hosted_trades: Dict[int, Any] = {}
        # conId 缓存:IBKR 的 conId 是永久标识,同一合约不必反复 reqContractDetails。
        # 每省一次就是省一整个网络往返——"输入到下单"链路里最省得动的一段。
        self._conid_cache: Dict[str, int] = {}
        # 合约交易时段缓存:键是"标的|到期日",值是 (查询日, tradingHours, liquidHours, tzId)。
        # 追踪轮询每 8 秒一轮,不能每轮都 reqContractDetails;时段表一天只会变一次,
        # 按日缓存足够。
        self._hours_cache: Dict[str, tuple] = {}

    # ---- 连接 -----------------------------------------------------------
    @property
    def connections(self) -> Dict[str, Any]:
        """只看属于本券商的连接。"""
        return self.settings.connections_for(self.BROKER)

    def connect(self, connection_name: str):
        if connection_name in self._connections:
            conn = self._connections[connection_name]
            if conn.isConnected():
                return conn
        cfg = self.connections.get(connection_name)
        if cfg is None:
            raise BrokerError("未定义的连接:%s(这里只在 IBKR 连接里查找)" % connection_name)
        ib = _ib().IB()
        try:
            ib.connect(cfg.host, cfg.port, clientId=cfg.client_id, readonly=cfg.readonly)
        except Exception as exc:  # noqa: BLE001
            raise BrokerError(
                "连接 %s (%s:%d) 失败:%s。请确认 TWS/IB Gateway 已启动且开启了本机 API。"
                % (connection_name, cfg.host, cfg.port, exc)
            ) from exc
        self._upstream_ok = True
        ib.errorEvent += self._on_ib_connectivity
        self._connections[connection_name] = ib
        if self.session_hook is not None:
            try:
                self.session_hook(ib)
            except Exception:  # noqa: BLE001 - 挂监听失败不应阻断连接本身
                pass
        return ib

    def _on_ib_connectivity(self, reqId, errorCode, errorString, contract=None, *extra) -> None:
        """只盯 TWS↔IBKR 那一段的通断,别的错误一概不管(订单级错误在 engine 里)。"""
        if errorCode == 1100:
            self._upstream_ok = False
        elif errorCode in (1101, 1102):
            self._upstream_ok = True

    @property
    def upstream_ok(self) -> bool:
        return self._upstream_ok

    def disconnect_all(self) -> None:
        self._cancel_streams()
        for ib in self._connections.values():
            if ib.isConnected():
                ib.disconnect()
        self._connections.clear()
        self._account_route.clear()

    def _cancel_streams(self) -> None:
        """撤掉常驻订阅。不撤会一直占着行情线路配额(IBKR 默认约 100 条),
        泄漏累积到上限后 AUTO_MID 定价会在盘中开始拿不到报价。"""
        sessions = self.sessions()
        ib = sessions[0] if sessions else None
        if ib is not None:
            mod = _ib()
            for symbol, ticker in self._streams.items():
                try:
                    # 期权腿/指数流存的是 ticker,按它自己的合约撤;正股流按代码拼
                    contract = getattr(ticker, "contract", None)
                    ib.cancelMktData(contract if contract is not None else mod.Stock(symbol, "SMART", "USD"))
                except Exception:  # noqa: BLE001 - 撤不掉也不该拦住断开
                    pass
        self._streams.clear()

    def for_account(self, account: AccountConfig):
        """找到真正管理该账户的会话。

        TWS 同一时刻只登录一个账户(实盘或模拟)、只开一个端口;用户在 TWS
        里切换登录后,配置里静态的 账户→连接 映射就不再可信。这里按顺序实测:
        1) 上次实测成功的连接(缓存);2) 配置指定的连接;3) 其余已配置连接。
        谁的 managedAccounts 里真有这个账号就用谁——路由永远以会话实况为准,
        映射不上就拒绝,绝不把单子发进错误会话。
        """
        order: List[str] = []
        cached = self._account_route.get(account.account_id)
        connections = self.connections
        if cached and cached in connections:
            order.append(cached)
        if account.connection in connections and account.connection not in order:
            order.append(account.connection)
        order += [n for n in connections if n not in order]
        if not order:
            raise BrokerError(
                "账户 %s 绑的连接 %s 不是 IBKR 连接(当前券商接入:IBKR)。"
                "请在设置里把它改到一条 IBKR 连接,或把券商接入切回对应的那一家。"
                % (account.alias, account.connection)
            )

        failures: List[str] = []
        for name in order:
            try:
                ib = self.connect(name)
            except BrokerError as exc:
                failures.append(str(exc))
                continue
            managed = set(ib.managedAccounts() or [])
            if account.account_id in managed:
                if name != account.connection:
                    _log_stderr(
                        "[router] 账户 %s 实际由连接 %s 管理(配置写的是 %s),已自动改道"
                        % (redact_for_log(account.account_id), name, account.connection)
                    )
                self._account_route[account.account_id] = name
                return ib
            if not managed and name == account.connection:
                # 会话没报账户列表(个别版本连接初期为空):只对配置指定的连接放行
                return ib
            failures.append(
                "连接 %s 的会话不管理该账户(当前登录的可能是另一个账户)" % name
            )

        raise BrokerError(
            "账户 %s 在所有已配置连接上都找不到对应会话:%s。"
            "请确认 TWS 当前登录的就是这个账户,或核对配置端口。"
            % (account.alias, ";".join(failures) or "无可用连接")
        )

    # ---- 合约 -----------------------------------------------------------
    def qualify(self, contract: ContractSpec, account: AccountConfig):
        ib = self.for_account(account)
        mod = _ib()
        if contract.secType == "STK":
            target = mod.Stock(contract.symbol, contract.exchange, contract.currency)
            self._qualify_or_raise(ib, target)
            return target
        if contract.secType == "OPT":
            target = mod.Option(
                contract.symbol,
                contract.lastTradeDateOrContractMonth,
                contract.strike,
                contract.right,
                contract.exchange,
                currency=contract.currency,
                multiplier=contract.multiplier,
                tradingClass=contract.tradingClass or "",
            )
            self._qualify_or_raise(ib, target)
            return target
        return self._build_bag(ib, contract)

    @staticmethod
    def _conid_key(contract) -> str:
        return "|".join(str(getattr(contract, attr, "") or "") for attr in (
            "secType", "symbol", "lastTradeDateOrContractMonth", "strike",
            "right", "tradingClass", "exchange", "currency",
        ))

    def _build_bag(self, ib, contract: ContractSpec):
        mod = _ib()
        opts = [
            mod.Option(
                contract.symbol,
                leg.lastTradeDateOrContractMonth,
                leg.strike,
                leg.right,
                contract.exchange,
                currency=contract.currency,
                multiplier=leg.multiplier,
                tradingClass=leg.tradingClass or "",
            )
            for leg in contract.legs or []
        ]
        # 三条腿一次批量确认,而不是三个串行往返;缓存命中的腿连这一次都省掉
        need = []
        for opt in opts:
            hit = self._conid_cache.get(self._conid_key(opt))
            if hit:
                opt.conId = hit
            else:
                need.append(opt)
        if need:
            self._qualify_batch_or_raise(ib, need)
        combo_legs = [
            mod.ComboLeg(
                conId=opt.conId, ratio=leg.ratio, action=leg.action, exchange=contract.exchange
            )
            for opt, leg in zip(opts, contract.legs or [])
        ]
        return mod.Contract(
            secType="BAG",
            symbol=contract.symbol,
            currency=contract.currency,
            exchange=contract.exchange,
            comboLegs=combo_legs,
        )

    # qualifyContracts 是 ib_insync 里唯一**没有** timeout 参数的阻塞调用
    # (reqHistoricalData 自带 timeout=60)。这曾经把整个应用锁死过:
    # TWS 与 IBKR 上游断开(错误 1100)时本机 socket 还活着、isConnected() 仍是 True,
    # 于是请求发得出去却永远等不到回应;而 RPC 服务是串行的,一次这样的阻塞会让
    # 后面所有请求堵在管道里——连根本不碰券商的 system.status 都超时了 159 次,
    # 界面直接变砖。所以这里必须有硬超时,宁可报错也不能挂着。
    _QUALIFY_TIMEOUT = 12.0

    def _qualify_or_raise(self, ib, contract) -> None:
        key = self._conid_key(contract)
        hit = self._conid_cache.get(key)
        if hit:
            contract.conId = hit
            return
        self._qualify_batch_or_raise(ib, [contract])

    def _qualify_batch_or_raise(self, ib, contracts) -> None:
        """一次网络往返确认一批合约(qualifyContracts 本来就支持批量)。"""
        import asyncio

        # 键必须在 qualify 之前算:qualify 会原地改写合约字段(交易所归一等),
        # 事后算键与下次查询的"改写前"键对不上,缓存就永远 miss。
        keys = [self._conid_key(c) for c in contracts]
        try:
            qualified = ib.run(
                asyncio.wait_for(ib.qualifyContractsAsync(*contracts), self._QUALIFY_TIMEOUT)
            )
        except asyncio.TimeoutError:
            raise BrokerError(self._stalled_message()) from None
        for key, contract in zip(keys, contracts):
            if not qualified or not getattr(contract, "conId", 0):
                raise BrokerError(
                    "IBKR 无法确认该合约(%s),可能是代码拼错、到期日或行权价不存在。已拦截。"
                    % _describe(contract)
                )
            self._conid_cache[key] = contract.conId

    def _stalled_message(self) -> str:
        """TWS 没响应时,告诉用户下一步做什么,而不是甩一个超时。"""
        if not self._upstream_ok:
            return (
                "TWS 与 IBKR 服务器的连接已中断(错误 1100)。本机到 TWS 的连接还在,"
                "所以请求发得出去、但永远等不到回应。等 TWS 自己重连(它会一直重试),"
                "或检查网络后在「TWS 连接」面板重连引擎。"
            )
        return (
            "TWS 在 %.0f 秒内没有响应合约确认请求。常见原因:TWS 正弹着确认框等你点、"
            "或它与 IBKR 的连接刚断开。处理完再试。" % self._QUALIFY_TIMEOUT
        )

    # ---- 行情 -----------------------------------------------------------
    #: 组合各腿盘口最多等这么久——**所有腿合计**,不是每腿。三腿串行各等 4 秒就是 12 秒起步,
    #: 而在线路用完 / 没订阅这类"确定拿不到"的场景里,每一次解析都会把这 12 秒等满。
    _QUOTE_WAIT = 4.0

    def leg_quotes(self, contract: ContractSpec, account: AccountConfig) -> List[LegQuote]:
        """组合各腿的盘口(AUTO_MID 定价用)。

        行情订阅边界:**纸面账户**没有实时期权订阅时退到延迟盘口(type 3)——
        测试链路的可用性优先,反正不是真钱;**实盘账户绝不用延迟盘口定价**,
        拿不到实时报价就让 LegQuote.mid 的守卫拒单,这是刻意的。

        三件事这里必须一起做,少一件都出过事:
        1. 各腿**一起**订阅、一起轮询——首笔 tick 常常 >1 秒,串行等就是腿数 × 上限;
        2. 用完**立刻 cancelMktData**——不撤的订阅一直占着行情线路配额(约 100 条),
           一天反复解析几十次就把配额漏光,此后 TWS 对新请求回 101,所有腿永远 NaN,
           界面上只剩一句"盘口不可用"(2026-09-04 纸面账户实测);
        3. 接住取盘口期间 TWS 回的行情类错误码(101 / 354 / 10167 …),缺盘口时把原因
           翻译给用户,而不是让守卫那句通用报错兜底。
        """
        ib = self.for_account(account)
        mod = _ib()
        legs = list(contract.legs or [])
        if not legs:
            return []
        delayed_ok = account.is_paper
        opts = [
            mod.Option(
                contract.symbol,
                leg.lastTradeDateOrContractMonth,
                leg.strike,
                leg.right,
                contract.exchange,
                currency=contract.currency,
                multiplier=leg.multiplier,
                tradingClass=leg.tradingClass or "",
            )
            for leg in legs
        ]
        md_errors: List[tuple] = []

        def on_error(reqId, errorCode, errorString, *extra) -> None:
            try:
                code = int(errorCode)
            except (TypeError, ValueError):
                return
            if code in _MD_ERROR_CODES:
                md_errors.append((code, str(errorString or "")))

        # 与 TS 侧 session.onError?.() 同款:替身会话可以没有 errorEvent
        error_event = getattr(ib, "errorEvent", None)
        if error_event is not None:
            error_event += on_error
        tickers: List[Any] = []
        try:
            if delayed_ok:
                ib.reqMarketDataType(3)
            self._qualify_all_or_raise(ib, opts)
            tickers = [ib.reqMktData(opt, "", False, False) for opt in opts]
            # 轮询而不是固定等待:固定 sleep 会抢跑拿到 NaN,被守卫误判成"盘口不可用"。
            waited = 0.0
            while waited < self._QUOTE_WAIT:
                ib.sleep(0.25)
                waited += 0.25
                if all(_finite_quote(t.bid) > 0 and _finite_quote(t.ask) > 0 for t in tickers):
                    break
            quotes = [
                LegQuote(
                    action=leg.action,
                    ratio=leg.ratio,
                    # NaN(未收到行情)必须归零,让 LegQuote.mid 的守卫拦下来;
                    # `ticker.bid or 0.0` 拦不住 NaN——NaN 是真值。
                    bid=_finite_quote(t.bid),
                    ask=_finite_quote(t.ask),
                )
                for leg, t in zip(legs, tickers)
            ]
        finally:
            for opt in opts[: len(tickers)]:
                try:
                    ib.cancelMktData(opt)   # 不撤会一直占着行情线路配额
                except Exception:  # noqa: BLE001 - 撤订阅失败不该盖住真正的错误
                    pass
            if delayed_ok:
                ib.reqMarketDataType(1)
            if error_event is not None:
                try:
                    error_event -= on_error
                except Exception:  # noqa: BLE001
                    pass
        missing = [q for q in quotes if not (q.bid > 0 and q.ask > 0)]
        if missing and md_errors:
            raise BrokerError(_quote_error_message(contract.symbol, md_errors))
        return quotes

    def _qualify_all_or_raise(self, ib, contracts) -> None:
        """一批合约一次往返确认;命中 conId 缓存的不再问 TWS。"""
        pending = []
        for c in contracts:
            hit = self._conid_cache.get(self._conid_key(c))
            if hit:
                c.conId = hit
            else:
                pending.append(c)
        if pending:
            self._qualify_batch_or_raise(ib, pending)

    def quote_capability(self, symbol: str) -> Optional[str]:
        """这个标的本券商能不能报价?能就回 None,不能就回"为什么"。

        IBKR 什么都能报(前提是订阅到位,那是另一码事),所以恒回 None。
        富途那边会对美股指数回一句拒绝——见 FutuRouter.quote_capability。
        """
        return None

    def index_price(self, symbol: str) -> Optional[float]:
        cfg = self.settings.index_config(symbol)
        # 行情快照不挑账户:优先默认账户的连接,不可用(比如只登了实盘、
        # 默认账户却是模拟)就退到任何一条已连会话——报价谁来拉都一样。
        ib = None
        default = self.settings.default_account()
        if default is not None:
            try:
                ib = self.for_account(default)
            except BrokerError:
                ib = None
        if ib is None:
            sessions = self.sessions()
            ib = sessions[0] if sessions else None
        if ib is None:
            return None
        mod = _ib()
        target = (
            mod.Index(symbol, cfg.exchange) if cfg else mod.Stock(symbol, "SMART", "USD")
        )
        try:
            self._qualify_or_raise(ib, target)
        except BrokerError:
            return None
        # 常驻订阅:第一次要等首笔 tick,之后每次调用都是读缓存(百毫秒内)。
        # 快照是"输入到下单"链路的第一段,不能每单都重新订阅再干等一秒。
        stream_key = "idx:%s" % symbol
        cached = self._streams.get(stream_key)
        if cached is not None:
            price = self._poll_ticker(ib, cached, wait=0.25)
            if price is not None:
                return price
            self._streams.pop(stream_key, None)  # 常驻流断了数据:丢掉重订
        ticker = ib.reqMktData(target, "", False, False)
        price = self._poll_ticker(ib, ticker, wait=1.2)
        if price is not None:
            self._streams[stream_key] = ticker
            return price
        # 没有实时订阅(IBKR 10168)时退到 15 分钟延迟行情。只给方向复核的
        # 快照用——触发价与现价的差距远大于延迟窗口内的波动才有意义,过近
        # 会被 trigger_min_gap_bps 拦下。AUTO_MID 定价(leg_quotes)不走这里,
        # 绝不用延迟盘口给真单定价。
        ib.cancelMktData(target)
        try:
            ib.reqMarketDataType(3)
            ticker = ib.reqMktData(target, "", False, False)
            price = self._poll_ticker(ib, ticker, wait=2.0)
            if price is not None:
                self._streams[stream_key] = ticker
        finally:
            ib.reqMarketDataType(1)
        return price

    def stock_quotes(self, symbols: Sequence[str]) -> Dict[str, Dict[str, Optional[float]]]:
        """批量拉股票/ETF 报价,给「板块关注」页用;绝不用于订单定价。

        MarketDataType 3:有实时订阅的标的仍给实时,没订阅的自动退到
        15 分钟延迟——概览页要的是相对涨跌,延迟可接受。
        """
        sessions = self.sessions()
        ib = sessions[0] if sessions else None
        if ib is None:
            return {}
        mod = _ib()
        out: Dict[str, Dict[str, Optional[float]]] = {}
        try:
            ib.reqMarketDataType(3)
            tickers = {}
            for symbol in symbols:
                target = mod.Stock(symbol, "SMART", "USD")
                try:
                    self._qualify_or_raise(ib, target)
                except BrokerError:
                    out[symbol] = {"last": None, "close": None, "change_pct": None}
                    continue
                tickers[symbol] = ib.reqMktData(target, "", False, False)
            ib.sleep(2.5)
            for symbol, ticker in tickers.items():
                last = _clean_price(ticker.last) or _clean_price(ticker.marketPrice())
                close = _clean_price(ticker.close)
                change = None
                if last is not None and close:
                    change = round((last - close) / close * 100.0, 2)
                out[symbol] = {"last": last, "close": close, "change_pct": change}
        finally:
            ib.reqMarketDataType(1)
        return out

    def historical_bars(self, symbol: str, start: str, end: str) -> List[Dict[str, Any]]:
        """拉日线历史(回测用)。start/end 为 YYYY-MM-DD;返回按日期升序的 OHLC。

        用 ADJUSTED_LAST(前复权,分红拆股不产生假跳空);指数没有成交量
        概念,用 TRADES。历史数据请求不依赖实时行情订阅。
        """
        from datetime import date as _date, timedelta

        sessions = self.sessions()
        ib = sessions[0] if sessions else None
        if ib is None:
            raise BrokerError("引擎未连接 TWS,无法获取历史数据。请先在「TWS 连接」面板连接引擎。")

        mod = _ib()
        cfg = self.settings.index_config(symbol)
        target = mod.Index(symbol, cfg.exchange) if cfg else mod.Stock(symbol, "SMART", "USD")
        self._qualify_or_raise(ib, target)

        start_d = _date.fromisoformat(start)
        end_d = _date.fromisoformat(end)
        days = (end_d - start_d).days
        duration = "%d D" % (days + 5) if days <= 360 else "%d Y" % ((days // 365) + 1)
        end_dt = "" if end_d >= _date.today() else (end_d + timedelta(days=1)).strftime("%Y%m%d 00:00:00")

        try:
            raw = ib.reqHistoricalData(
                target,
                endDateTime=end_dt,
                durationStr=duration,
                barSizeSetting="1 day",
                whatToShow="TRADES" if cfg else "ADJUSTED_LAST",
                useRTH=True,
                formatDate=1,
            )
        except Exception as exc:  # noqa: BLE001
            raise BrokerError("获取 %s 历史数据失败:%s" % (symbol, exc)) from exc

        bars: List[Dict[str, Any]] = []
        for bar in raw or []:
            day = bar.date.isoformat() if hasattr(bar.date, "isoformat") else str(bar.date)
            day = day[:10]
            if start <= day <= end:
                bars.append(
                    {"date": day, "open": float(bar.open), "high": float(bar.high),
                     "low": float(bar.low), "close": float(bar.close)}
                )
        if not bars:
            raise BrokerError(
                "%s 在 %s ~ %s 内没有历史数据(标的代码是否正确?区间是否全是休市日?)"
                % (symbol, start, end)
            )
        return bars

    def stream_quotes(self, symbols: Sequence[str]) -> Dict[str, Dict[str, Any]]:
        """常驻流式报价:第一次调用建订阅,之后每次只读当前值。

        和 stock_quotes 的区别就是这个"常驻"——那个每次都 reqMktData + sleep(2.5),
        给概览页够用,但顶栏要秒级刷新就完全跑不动,而且反复订阅会把行情线路
        配额耗光。这里订阅一次留着,后面每次只花一次事件循环的时间去读。

        注意 ib_insync 的 ticker 只在事件循环被泵动时才更新,而 RPC 服务是同步的、
        平时阻塞在 stdin 上——所以读之前必须 sleep 一下把 socket 排空,否则拿到的
        永远是订阅那一刻的值。

        只用于展示。没有实时订阅的标的会一直是 NaN,调用方据此回落到公开数据源。
        """
        sessions = self.sessions()
        ib = sessions[0] if sessions else None
        if ib is None:
            return {}

        mod = _ib()
        fresh = False
        for symbol in symbols:
            if symbol in self._streams:
                continue
            target = mod.Stock(symbol, "SMART", "USD")
            try:
                self._qualify_or_raise(ib, target)
            except BrokerError:
                self._streams[symbol] = None      # 记下来,不用每次都重试 qualify
                continue
            self._streams[symbol] = ib.reqMktData(target, "", False, False)
            fresh = True

        # 新订阅要多等一拍才有第一笔数据;已有订阅只需把事件排空
        ib.sleep(1.5 if fresh else 0.15)

        out: Dict[str, Dict[str, Any]] = {}
        for symbol in symbols:
            ticker = self._streams.get(symbol)
            if ticker is None:
                continue
            last = _clean_price(ticker.last) or _clean_price(ticker.marketPrice())
            close = _clean_price(ticker.close)
            change = round((last - close) / close * 100.0, 2) if (last and close) else None
            if last is None:
                continue                          # 没订阅/没数据 → 交给公开源兜底
            out[symbol] = {"last": last, "close": close, "change_pct": change}
        return out

    def intraday_bars(
        self, symbol: str, timeframe: str, rth: bool = False
    ) -> List[Dict[str, Any]]:
        """按周期拉 K 线(PA 分析用),返回按时间升序的 OHLCV。

        与 historical_bars 有三处刻意不同,都是被 IBKR 接口逼出来的:
          * 日内周期只能用 TRADES —— ADJUSTED_LAST 仅支持日线,填错直接报错;
          * 日内 bar.date 是 datetime、日线是 date,统一成字符串再往上走,
            下游的 priceaction 只认字符串时间戳;
          * useRTH 交给调用方,**默认取全时段**。只取盘中的代价太大:收盘后
            整条 K 线就停在昨天 16:00,盘前那一段完全看不见,而隔夜和盘前
            恰恰是缺口与扫单最密集的地方。代价是盘前盘后成交稀薄的 K 线会让
            ATR 偏小、摆动点偏碎——所以 analyze() 在全时段模式下会额外给一条警告。

        **历史数据同样要行情权限**(这一点很容易记反):没订阅时 reqHistoricalData
        会直接回 error 162「No market data permissions」,而不是悄悄给延迟数据。
        所以这里先把行情类型切到 3(延迟),让没订阅的账户也能拿到 15 分钟延迟的
        K 线;有实时订阅的标的不受影响,仍然是实时的。用完必须切回 1,否则整个
        会话的流式行情都会变成延迟——AUTO_MID 是按盘口定价的,绝不能被拖下水。
        """
        spec = TIMEFRAMES.get(timeframe)
        if spec is None:
            raise BrokerError("未知 K 线周期:%s(可选:%s)" % (timeframe, "、".join(TIMEFRAMES)))

        sessions = self.sessions()
        ib = sessions[0] if sessions else None
        if ib is None:
            raise BrokerError("引擎未连接 TWS,无法获取 K 线。请先在「TWS 连接」面板连接引擎。")

        mod = _ib()
        cfg = self.settings.index_config(symbol)
        target = mod.Index(symbol, cfg.exchange) if cfg else mod.Stock(symbol, "SMART", "USD")
        self._qualify_or_raise(ib, target)

        daily = spec["bar_size"] == "1 day"
        show = "ADJUSTED_LAST" if (daily and cfg is None) else "TRADES"

        def pull(duration: str):
            return ib.reqHistoricalData(
                target,
                endDateTime="",
                durationStr=duration,
                barSizeSetting=spec["bar_size"],
                whatToShow=show,
                useRTH=bool(rth),
                formatDate=1,
            )

        try:
            ib.reqMarketDataType(3)      # 没订阅退延迟;有订阅仍是实时
            raw = pull(spec["duration"])
            # IBKR 的 durationStr 数的是**交易日**,而全时段口径下交易日在美东
            # 傍晚就翻篇——刚过那个边界时第一档只能拿到十几根。退一档再要一次。
            if len(raw or []) < MIN_BARS and spec.get("fallback"):
                raw = pull(spec["fallback"]) or raw
        except Exception as exc:  # noqa: BLE001
            raise BrokerError(_bars_error(symbol, spec["label"], exc)) from exc
        finally:
            ib.reqMarketDataType(1)

        bars: List[Dict[str, Any]] = []
        for bar in raw or []:
            bars.append(
                {
                    "time": bar_timestamp(bar.date),
                    "open": float(bar.open),
                    "high": float(bar.high),
                    "low": float(bar.low),
                    "close": float(bar.close),
                    # 指数没有成交量,IBKR 回 -1;归零免得被当成"缩量"读
                    "volume": max(float(getattr(bar, "volume", 0) or 0), 0.0),
                }
            )
        if not bars:
            raise BrokerError(
                "%s 没有返回 %s K 线(标的代码是否正确?是否刚好整段休市?)"
                % (symbol, spec["label"])
            )
        return bars

    # ---- 期权链(期权墙 / 警告用;只读,不进下单链路)-----------------------
    _CHAIN_MAX_WIDTH = 15        # 每侧最多取多少个行权价
    _CHAIN_WAIT = 4.0            # 等报价回来的秒数

    def option_expiries(self, symbol: str) -> Dict[str, Any]:
        """该标的可用的到期日与行权价网格。"""
        ib = self._market_session()
        mod = _ib()
        cfg = self.settings.index_config(symbol)
        under = mod.Index(symbol, cfg.exchange) if cfg else mod.Stock(symbol, "SMART", "USD")
        self._qualify_or_raise(ib, under)

        try:
            params = ib.reqSecDefOptParams(
                under.symbol, "", "IND" if cfg else "STK", under.conId
            )
        except Exception as exc:  # noqa: BLE001
            raise BrokerError("获取 %s 的期权链定义失败:%s" % (symbol, str(exc)[:200])) from exc
        if not params:
            raise BrokerError("%s 没有可用的期权链(标的是否有期权?)" % symbol)

        # 同一个标的会返回多组(不同交易所 / 不同 tradingClass),按配置挑:
        # SPX 的日到期是 SPXW、月到期是 SPX,挑错了拿到的是另一条链
        wanted = {cfg.daily_trading_class, cfg.monthly_trading_class} if cfg else set()
        chosen = [p for p in params if getattr(p, "tradingClass", None) in wanted] or list(params)
        expiries = sorted({e for p in chosen for e in (p.expirations or [])})
        strikes = sorted({float(k) for p in chosen for k in (p.strikes or [])})
        return {
            "symbol": symbol,
            "expiries": expiries,
            "strikes": strikes,
            "trading_classes": sorted({getattr(p, "tradingClass", "") for p in chosen}),
            "exchange": chosen[0].exchange if chosen else ("SMART" if not cfg else cfg.exchange),
        }

    def option_chain(
        self, symbol: str, expiry: Optional[str] = None, width: int = 10
    ) -> Dict[str, Any]:
        """现价附近若干档的期权报价(OI / 成交量 / IV / gamma)。

        只取现价附近:整条链动辄上千个合约,而 IBKR 的行情线路有配额(默认约
        100 条),一次性铺开会把配额吃干,连 AUTO_MID 定价都会跟着拿不到报价。
        离现价很远的行权价对"墙"也没有意义。
        """
        width = max(3, min(int(width), self._CHAIN_MAX_WIDTH))
        meta = self.option_expiries(symbol)
        if not meta["expiries"]:
            raise BrokerError("%s 没有可用的到期日" % symbol)
        target_expiry = expiry or meta["expiries"][0]
        if target_expiry not in meta["expiries"]:
            raise BrokerError(
                "%s 没有 %s 这个到期日。最近的几个:%s"
                % (symbol, target_expiry, "、".join(meta["expiries"][:5]))
            )

        spot = self.index_price(symbol)
        if not spot:
            raise BrokerError("拿不到 %s 的现价,无法判断该取哪些行权价。" % symbol)

        grid = meta["strikes"]
        if not grid:
            raise BrokerError("%s 的行权价网格为空" % symbol)
        nearest = min(range(len(grid)), key=lambda i: abs(grid[i] - spot))
        band = grid[max(0, nearest - width): nearest + width + 1]

        ib = self._market_session()
        mod = _ib()
        cfg = self.settings.index_config(symbol)
        trading_class = (meta["trading_classes"] or [""])[0]
        exchange = cfg.exchange if cfg else "SMART"

        contracts = []
        for strike in band:
            for right in ("C", "P"):
                contracts.append(
                    mod.Option(symbol, target_expiry, strike, right, exchange,
                               currency="USD", tradingClass=trading_class)
                )

        rows: List[Dict[str, Any]] = []
        tickers = []
        try:
            ib.reqMarketDataType(3)          # 没实时订阅退延迟;有订阅仍是实时
            # 批量 qualify:逐个发会把 12 秒的超时预算乘以合约数
            try:
                ib.run(
                    __import__("asyncio").wait_for(
                        ib.qualifyContractsAsync(*contracts), self._QUALIFY_TIMEOUT * 2
                    )
                )
            except Exception as exc:  # noqa: BLE001
                raise BrokerError(self._stalled_message()) from exc
            live = [c for c in contracts if getattr(c, "conId", 0)]
            if not live:
                raise BrokerError(
                    "%s %s 这条链一个合约都确认不了(到期日或行权价可能不存在)"
                    % (symbol, target_expiry)
                )
            # 100=成交量 101=持仓量 106=隐含波动率(带模型 greeks)
            tickers = [(c, ib.reqMktData(c, "100,101,106", False, False)) for c in live]
            ib.sleep(self._CHAIN_WAIT)
            for contract, ticker in tickers:
                greeks = getattr(ticker, "modelGreeks", None)
                oi = ticker.callOpenInterest if contract.right == "C" else ticker.putOpenInterest
                vol = ticker.callVolume if contract.right == "C" else ticker.putVolume
                rows.append(
                    {
                        "strike": float(contract.strike),
                        "right": contract.right,
                        "oi": _clean_price(oi) or 0.0,
                        "volume": _clean_price(vol) or 0.0,
                        "gamma": _clean_price(getattr(greeks, "gamma", None)) if greeks else None,
                        "iv": _clean_price(getattr(greeks, "impliedVol", None)) if greeks else None,
                    }
                )
        finally:
            ib.reqMarketDataType(1)
            for contract, _ in tickers:
                try:
                    ib.cancelMktData(contract)   # 不撤会一直占着行情线路配额
                except Exception:  # noqa: BLE001
                    pass

        return {
            "symbol": symbol, "expiry": target_expiry, "spot": spot,
            "expiries": meta["expiries"][:20], "rows": rows,
            "multiplier": 100.0, "strike_count": len(band),
        }

    def _market_session(self):
        sessions = self.sessions()
        if not sessions:
            raise BrokerError("引擎未连接 TWS。请先在「TWS 连接」面板连接引擎。")
        return sessions[0]

    def order_book(self, symbol: str, rows: int = 10) -> Dict[str, Any]:
        """一档盘口 + Level 2 深度(若账户有订阅)。只读展示,不参与定价与下单。"""
        sessions = self.sessions()
        ib = sessions[0] if sessions else None
        if ib is None:
            raise BrokerError("引擎未连接 TWS,无法读取盘口。请先在「TWS 连接」面板连接引擎。")
        cfg = self.settings.index_config(symbol)
        if cfg:
            raise BrokerError("指数本身没有订单簿(不是可交易合约),请查对应 ETF(如 SPY)或成分股。")

        mod = _ib()
        target = mod.Stock(symbol, "SMART", "USD")
        self._qualify_or_raise(ib, target)

        out: Dict[str, Any] = {"symbol": symbol, "l1": {}, "bids": [], "asks": [], "note": ""}

        try:
            ib.reqMarketDataType(3)   # 没实时订阅退延迟;有订阅仍是实时
            ticker = ib.reqMktData(target, "", False, False)
            ib.sleep(1.5)
            bid, ask = _clean_price(ticker.bid), _clean_price(ticker.ask)
            l1 = {
                "bid": bid,
                "ask": ask,
                "bid_size": _clean_price(float(ticker.bidSize)) if ticker.bidSize == ticker.bidSize else None,
                "ask_size": _clean_price(float(ticker.askSize)) if ticker.askSize == ticker.askSize else None,
                "last": _clean_price(ticker.last) or _clean_price(ticker.close),
            }
            if bid and ask and ask >= bid:
                mid = (bid + ask) / 2.0
                l1["spread"] = round(ask - bid, 4)
                l1["spread_bps"] = round((ask - bid) / mid * 10_000, 1) if mid else None
            out["l1"] = l1
        finally:
            ib.reqMarketDataType(1)
            # 用完即撤:不撤会一直占用行情线路配额(IBKR 默认约 100 条),
            # 泄漏累积到上限后 AUTO_MID 定价会在盘中开始拿不到报价
            try:
                ib.cancelMktData(target)
            except Exception:  # noqa: BLE001
                pass

        # Level 2 需要单独订阅(如 NASDAQ TotalView);拿不到就明说,不装深沉
        depth = None
        try:
            depth = ib.reqMktDepth(target, numRows=rows)
            ib.sleep(2.0)
            out["bids"] = [
                {"price": float(d.price), "size": float(d.size)} for d in (depth.domBids or [])
            ]
            out["asks"] = [
                {"price": float(d.price), "size": float(d.size)} for d in (depth.domAsks or [])
            ]
            if not out["bids"] and not out["asks"]:
                out["note"] = "未收到深度数据:Level 2 行情需要单独订阅(如 NASDAQ TotalView)。上方为一档盘口。"
        except Exception as exc:  # noqa: BLE001 - 深度失败不影响一档盘口
            out["note"] = "深度不可用(Level 2 需订阅):%s" % str(exc)[:200]
        finally:
            if depth is not None:
                try:
                    ib.cancelMktDepth(target)   # 深度订阅同时上限更低(3 起步),必须保证撤掉
                except Exception:  # noqa: BLE001
                    pass
        out["liquidity"] = book_liquidity(out)
        return out

    @staticmethod
    def _read_ticker(ticker) -> Optional[float]:
        for candidate in (ticker.last, ticker.close, ticker.marketPrice()):
            if candidate and candidate == candidate:  # 排除 NaN
                return float(candidate)
        return None

    @classmethod
    def _poll_ticker(cls, ib, ticker, wait: float = 1.0) -> Optional[float]:
        """轮询而不是死等:价格到了立刻返回,wait 只是上限。"""
        waited = 0.0
        while True:
            price = cls._read_ticker(ticker)
            if price is not None:
                return price
            if waited >= wait:
                return None
            ib.sleep(0.1)
            waited += 0.1

    @classmethod
    def _ticker_price(cls, ib, target, wait: float = 1.0) -> Optional[float]:
        return cls._poll_ticker(ib, ib.reqMktData(target, "", False, False), wait)

    # ---- 持仓 -----------------------------------------------------------
    def combo_bars(self, symbol: str, legs: Sequence[Dict[str, Any]], day: str,
                   bar_size: str = "1 min") -> List[Dict[str, Any]]:
        """一张组合(BAG)在某一天的分钟中间价——交易分析里的"蝶价走势"。

        IBKR 对组合合约支持历史数据(MIDPOINT),已到期的腿要带 includeExpired 才能
        qualify;拿的是 endDateTime 往前一整天(含前一晚的全球时段),调用方自己裁。
        """
        sessions = self.sessions()
        ib = sessions[0] if sessions else None
        if ib is None:
            raise BrokerError("引擎未连接 TWS,无法获取蝶价分钟线。请先在「TWS 连接」面板连接引擎。")
        from datetime import datetime as _dt, timezone as _tz

        from .config import ET

        mod = _ib()
        combo_legs = []
        for leg in legs:
            opt = mod.Option(
                symbol, str(leg.get("lastTradeDateOrContractMonth") or ""), float(leg.get("strike") or 0),
                str(leg.get("right") or ""), "SMART", currency="USD",
                tradingClass=str(leg.get("tradingClass") or ""),
            )
            opt.includeExpired = True
            self._qualify_or_raise(ib, opt)
            combo_legs.append(mod.ComboLeg(
                conId=opt.conId, ratio=int(leg.get("ratio") or 1),
                action=str(leg.get("action") or "BUY"), exchange="SMART",
            ))
        bag = mod.Contract(secType="BAG", symbol=symbol, exchange="SMART", currency="USD", comboLegs=combo_legs)
        y, m, d = (int(x) for x in str(day).split("-"))
        end = _dt(y, m, d, 16, 5, tzinfo=ET).astimezone(_tz.utc).strftime("%Y%m%d-%H:%M:%S")
        try:
            ib.reqMarketDataType(3)
            raw = ib.reqHistoricalData(
                bag, endDateTime=end, durationStr="1 D", barSizeSetting=bar_size,
                whatToShow="MIDPOINT", useRTH=False, formatDate=1,
            )
        except Exception as exc:  # noqa: BLE001
            raise BrokerError("获取 %s 组合分钟线失败:%s" % (symbol, exc)) from exc
        finally:
            ib.reqMarketDataType(1)
        return [
            {"time": bar_timestamp(b.date), "open": float(b.open), "high": float(b.high),
             "low": float(b.low), "close": float(b.close)}
            for b in (raw or [])
        ]

    def executions(self) -> List[Dict[str, Any]]:
        """本次 TWS 会话(当天)的逐笔成交,归一成本系统的形状,按时间升序。

        IBKR 的 API 只回当天的成交;要看更早的,只能靠每次拉到的都存进本地库
        (store.remember_fills)慢慢累积。一张组合单会回 1 条 BAG 行 + 每条腿一行,
        同一订单共用 permId——合成蝴蝶的活在 ibtrades 里做,这里只搬运。
        """
        out: Dict[str, Dict[str, Any]] = {}
        for ib in self.sessions():
            try:
                fills = list(ib.reqExecutions() or [])
            except Exception as exc:  # noqa: BLE001
                raise BrokerError("读取成交明细失败:%s" % exc) from exc
            for fill in fills:
                row = fill_row(fill)
                if row is not None and row["exec_id"] not in out:
                    out[row["exec_id"]] = row
        return sorted(out.values(), key=lambda r: (r["time"], r["exec_id"]))

    def contract_hours(self, row: Dict[str, Any], account) -> Optional[tuple]:
        """这条持仓所在合约的真实交易时段 (tradingHours, liquidHours, timeZoneId)。

        **为什么不能用 `Settings.market_status`**:那张表是照美股正股写的
        (4:00 盘前 / 9:30 盘中 / 16:00 盘后 / 20:00 休市)。SPX 期权不是这个时段——
        IBKR 报的 SPXW 是 `19:15–次日 08:25` 加 `08:30–15:00`(US/Central,即美东
        20:15–09:25 与 09:30–16:00)。拿正股的表去判期权,0DTE 蝶在隔夜那一整段会被
        当成"休市",追踪止盈整段不设防(2026-09-04 实测:美东 01:10 被判休市,而 IBKR
        说那时能交易)。

        组合(BAG)本身没有时段,取它第一条腿的——同一到期日的腿时段相同。
        查不到就回 None,让调用方退回正股那套,而不是把仓位卡死在"休市"。
        """
        sec_type = str(row.get("sec_type") or "")
        contract = row.get("contract") or {}
        if sec_type == "BAG":
            legs = contract.get("legs") or []
            if not legs:
                return None
            leg = legs[0]
            expiry = leg.get("lastTradeDateOrContractMonth")
            strike, right = leg.get("strike"), leg.get("right")
        elif sec_type in ("OPT", "FOP"):
            expiry = contract.get("lastTradeDateOrContractMonth")
            strike, right = contract.get("strike"), contract.get("right")
        else:
            return None
        if not expiry or strike in (None, "") or not right:
            return None

        key = "%s|%s" % (row.get("symbol"), expiry)
        today = now_et().date().isoformat()
        hit = self._hours_cache.get(key)
        if hit and hit[0] == today:
            return hit[1:]

        try:
            ib = self.for_account(account)
            mod = _ib()
            probe = mod.Option(str(row.get("symbol")), str(expiry), float(strike),
                               str(right)[:1].upper(), "SMART", currency="USD")
            details = ib.reqContractDetails(probe)
        except Exception:  # noqa: BLE001 - 查不到时段不该炸掉轮询,退回正股表即可
            return None
        if not details:
            return None
        d = details[0]
        out = (getattr(d, "tradingHours", "") or "", getattr(d, "liquidHours", "") or "",
               getattr(d, "timeZoneId", "") or "")
        self._hours_cache[key] = (today,) + out
        return out

    def positions(self) -> List[Dict[str, Any]]:
        """账户里现在拿着什么。

        优先用 `ib.portfolio()`——那里的 marketPrice / unrealizedPNL 是 TWS 自己
        算的,和你在 TWS 界面上看到的、以及月结单上的是同一个口径。拿它比我们
        自己乘一遍靠谱得多。

        拿不到就退到 `ib.positions()`(走 reqPositions,不需要账户更新订阅),
        价格另外取;连价格都取不到时**如实回 None**,让界面显示"—",
        而不是拿成本价冒充现价算出一个"盈亏为零"的假象。
        """
        out: Dict[str, Dict[str, Any]] = {}
        alias_of = {a.account_id: a.alias for a in self.settings.accounts}

        for ib in self.sessions():
            try:
                items = list(ib.portfolio() or [])
            except Exception:  # noqa: BLE001 - 没订阅账户更新时会空手而归
                items = []
            for item in items:
                # 账号在持仓项上(item.account),不在合约上——从合约取永远是空,
                # 结果是所有账户的仓都被记到默认账户名下
                row = self._position_row(
                    item.contract, item.position, alias_of, getattr(item, "account", "") or ""
                )
                if row is None:
                    continue
                row["avg_cost"] = _clean_price(item.averageCost) or 0.0
                row["market_price"] = _clean_price(item.marketPrice)
                row["market_value"] = _finite_quote(item.marketValue) or None
                # 大小写是 ib_insync 的坑:PortfolioItem 上是 unrealizedPNL(全大写),
                # 只有 PnL 那个类才是 unrealizedPnL。写错不会静默出错,而是 AttributeError
                # ——账户里一有持仓,整个 positions() 就炸,持仓列表与组合追踪全瘫。
                # 假 router 测不出来,只有连上带持仓的真账户才暴露(2026-09-04 纸面实测)。
                row["unrealized_pnl"] = _finite_quote(item.unrealizedPNL)
                out[row["key"]] = row

            try:
                raw = list(ib.positions() or [])
            except Exception:  # noqa: BLE001
                raw = []
            for pos in raw:
                row = self._position_row(
                    pos.contract, pos.position, alias_of, getattr(pos, "account", "") or ""
                )
                if row is None or row["key"] in out:
                    continue      # portfolio 已经给过更准的那份
                row["avg_cost"] = _clean_price(pos.avgCost) or 0.0
                out[row["key"]] = row

        rows = [r for r in out.values() if r["quantity"]]
        self._fill_position_prices(rows)
        return sorted(rows, key=lambda r: (r["account"], r["symbol"]))

    def _position_row(
        self, contract, quantity, alias_of, account: str = ""
    ) -> Optional[Dict[str, Any]]:
        """IBKR 的持仓行 → 本系统的形状。账号不在别名表里的一律跳过——
        LLM 指不到的账户,追踪也不该管,否则会出现"界面上有、下单时找不到"的洞;
        更糟的是别的账户的仓挂在这个账户名下,追踪的"实际持仓"就不是实际的了。"""
        account = account or getattr(contract, "account", "") or ""
        alias = alias_of.get(account)
        if alias is None:
            if account:
                # 券商报了账号但别名表里没有:不是本软件管的账户,不显示、不追踪。
                # 每个账号只提醒一次(持仓面板几秒刷一轮)。
                seen = getattr(self, "_unmapped_accounts", None)
                if seen is None:
                    seen = self._unmapped_accounts = set()
                if account not in seen:
                    seen.add(account)
                    _log_stderr(
                        "[ibkr] 账户 %s 不在配置的别名表里,它的持仓不显示、不追踪。"
                        "要管这个账户,把它加进 config/settings.json 的 accounts。"
                        % redact_for_log(account)
                    )
                return None
            # 券商没报账号(极少见)才退到默认账户——单账户是绝大多数情况
            default = self.settings.default_account()
            if default is None:
                return None
            alias = default.alias
        symbol = getattr(contract, "symbol", "") or ""
        if not symbol:
            return None
        sec_type = getattr(contract, "secType", "STK") or "STK"
        try:
            multiplier = float(getattr(contract, "multiplier", "") or 1)
        except (TypeError, ValueError):
            multiplier = 1.0
        from .tracker import leg_of, position_key, position_label

        spec = {
            "secType": sec_type,
            "symbol": symbol,
            "exchange": getattr(contract, "exchange", "") or "SMART",
            "currency": getattr(contract, "currency", "USD") or "USD",
            "lastTradeDateOrContractMonth":
                getattr(contract, "lastTradeDateOrContractMonth", "") or None,
            "strike": float(getattr(contract, "strike", 0) or 0) or None,
            "right": getattr(contract, "right", "") or None,
            "multiplier": str(int(multiplier)) if multiplier else "100",
            "tradingClass": getattr(contract, "tradingClass", "") or None,
        }
        # 期权按腿区分:一只蝴蝶三条腿都是同一个 symbol/secType,
        # key 不带腿身份就会互相覆盖,界面上只剩一条、追踪也会认错腿
        leg = leg_of(spec)
        return {
            "key": position_key(alias, symbol, sec_type, leg),
            "account": alias,
            "symbol": symbol,
            "sec_type": sec_type,
            "leg": leg,
            "label": position_label(symbol, sec_type, spec),
            "quantity": float(quantity or 0),
            "multiplier": multiplier,
            "currency": getattr(contract, "currency", "USD") or "USD",
            "avg_cost": 0.0,
            "market_price": None,
            "market_value": None,
            "unrealized_pnl": None,
            "contract": spec,
        }

    def _fill_position_prices(self, rows) -> None:
        """给还没有现价的持仓补报价。

        正股走批量快照;期权腿走**常驻订阅**(每条腿一条行情线路,订阅一次留着,
        之后每轮只读缓存)——持仓里的期权腿就那么几条,不会吃光配额;不订阅的话
        组合价格永远是"—",追踪也永远不触发。
        """
        need = [r["symbol"] for r in rows if r["market_price"] is None and r["sec_type"] == "STK"]
        if need:
            try:
                quotes = self.stock_quotes(sorted(set(need)))
            except BrokerError:
                quotes = {}
            for row in rows:
                quote = quotes.get(row["symbol"]) or {}
                if row["market_price"] is None and row["sec_type"] == "STK":
                    row["market_price"] = quote.get("last")
        self._fill_option_prices(rows)

    def _fill_option_prices(self, rows) -> None:
        """期权腿的现价:常驻 reqMktData,读中间价(没盘口时退到最新价/标记价)。"""
        legs = [r for r in rows if r["market_price"] is None and r["sec_type"] in ("OPT", "FOP")]
        if not legs:
            return
        sessions = self.sessions()
        ib = sessions[0] if sessions else None
        if ib is None:
            return
        mod = _ib()
        fresh = False
        for row in legs:
            key = "opt:%s" % row["key"]
            if key in self._streams:
                continue
            spec = row["contract"] or {}
            try:
                target = mod.Option(
                    row["symbol"], spec.get("lastTradeDateOrContractMonth") or "",
                    float(spec.get("strike") or 0.0), spec.get("right") or "",
                    spec.get("exchange") or "SMART", multiplier=spec.get("multiplier") or "100",
                    currency=spec.get("currency") or "USD",
                )
                if spec.get("tradingClass"):
                    target.tradingClass = spec["tradingClass"]
                self._qualify_or_raise(ib, target)
            except (BrokerError, Exception):  # noqa: BLE001 - 认不出的合约不反复重试
                self._streams[key] = None
                continue
            self._streams[key] = ib.reqMktData(target, "", False, False)
            fresh = True
        # 首次订阅要等第一笔 tick 落地;之后每轮只是从常驻订阅的缓存里读,泵一下事件
        # 循环就够。追踪轮询按秒跑,这里每多等 0.1 秒就是 10% 的占用,而 RPC 是单线程的
        # ——省下来的时间直接变成别的请求的响应速度。
        ib.sleep(1.5 if fresh else 0.05)
        for row in legs:
            ticker = self._streams.get("opt:%s" % row["key"])
            if ticker is None:
                continue
            bid, ask = _clean_price(ticker.bid), _clean_price(ticker.ask)
            if bid is not None and ask is not None and ask >= bid:
                row["market_price"] = round((bid + ask) / 2.0, 4)
            else:
                row["market_price"] = _clean_price(ticker.last) or _clean_price(ticker.marketPrice())

    # ---- 下单 -----------------------------------------------------------
    def place(
        self, record_id: str, approved: ApprovedOrder, limit_override: Optional[float] = None
    ) -> PlacementResult:
        parsed = approved.order
        ib = self.for_account(approved.account)
        contract = self.qualify(parsed.contract, approved.account)

        if parsed.contract.secType == "BAG":
            # BAG 一律以 BUY 提交:IBKR 对 BAG 的 SELL 会反转每条腿的方向,
            # 而我们的腿已经写的是真实持仓方向(见 bag_signed_limit)。
            if limit_override is not None:
                signed_limit = limit_override      # AUTO_MID 已是带符号净价
            else:
                signed_limit = bag_signed_limit(parsed.order.action, parsed.order.lmtPrice)
            order = build_ib_order(
                parsed.order, approved.account_id,
                limit_override=signed_limit, action_override="BUY",
            )
        else:
            order = build_ib_order(parsed.order, approved.account_id, limit_override)

        # 幂等标识:回报、对账、去重都能凭 orderRef 找回这条记录
        order.orderRef = record_id

        # 方式 A:用户给了明确价格的条件单,条件挂在 IBKR 服务器上,软件掉线也有效
        if parsed.trigger is not None and parsed.order.price_mode == "EXPLICIT":
            order.conditions = [self._price_condition(ib, parsed.trigger)]
            order.conditionsCancelOrder = False

        # orderId 在 placeOrder 返回时已确定;只泵 0.15 秒事件循环收早期状态,
        # 其余状态与成交由回报异步落库——为"也许能看到的状态"陪 0.5 秒不值得。
        trade = ib.placeOrder(contract, order)
        ib.sleep(0.15)
        return PlacementResult(
            record_id=record_id,
            order_id=getattr(trade.order, "orderId", None),
            perm_id=getattr(trade.order, "permId", None),
            status=getattr(trade.orderStatus, "status", "Submitted"),
            limit_price=getattr(order, "lmtPrice", None),
            detail={"account": approved.account_id},
        )

    def _price_condition(self, ib, trigger: TriggerSpec):
        mod = _ib()
        spec = price_condition_spec(trigger)
        cfg = self.settings.index_config(trigger.symbol)
        if trigger.secType == "IND":
            target = mod.Index(trigger.symbol, cfg.exchange if cfg else "CBOE")
        else:
            target = mod.Stock(trigger.symbol, "SMART", "USD")
        self._qualify_or_raise(ib, target)
        return mod.PriceCondition(
            conId=target.conId,
            exch=target.exchange,
            isMore=spec["isMore"],
            price=spec["price"],
        )

    # ---- 券商托管的止盈/止损(GTC + OCA,挂在 IBKR 服务器上)---------------
    #: 富途的 router 没有这套(OpenD 不给同形的 OCA/TRAIL),置 False。
    SUPPORTS_HOSTED_CLOSE = True

    def place_hosted(
        self,
        account: AccountConfig,
        contract_spec: ContractSpec,
        item: Dict[str, Any],
        oca_group: str,
        order_ref: str,
    ) -> Dict[str, Any]:
        """挂一张托管单。GTC:软件关掉它也站岗——这正是托管的意义。

        OCA 组内一张成交,券商自动撤其余,与软件盯盘"触发一次就落闩"同义。
        """
        mod = _ib()
        ib = self.for_account(account)
        contract = self.qualify(contract_spec, account)
        order = mod.Order(
            action=item["action"],
            orderType=item["order_type"],
            totalQuantity=item["quantity"],
        )
        if item.get("lmt_price") is not None:
            order.lmtPrice = item["lmt_price"]
        if item.get("aux_price") is not None:
            order.auxPrice = item["aux_price"]
        if item.get("trailing_percent") is not None:
            order.trailingPercent = item["trailing_percent"]
            # 用持久化峰值播种初始停损:重启不把已锁住的利润放开
            if item.get("trail_stop_seed") is not None:
                order.trailStopPrice = item["trail_stop_seed"]
        order.tif = "GTC"
        # 托管止盈/止损同样要全时段站岗:股票开盘外标志,盘前盘后也能触发成交。
        # 期权没有盘外交易(SPX 的全球时段另算),标志对它无意义,不打。
        order.outsideRth = (getattr(contract_spec, "secType", None) or "") == "STK"
        order.account = account.account_id
        order.orderRef = order_ref
        order.ocaGroup = oca_group
        order.ocaType = 1                     # 一张成交,整组撤销
        order.transmit = True
        trade = ib.placeOrder(contract, order)
        ib.sleep(0.15)
        order_id = getattr(trade.order, "orderId", None)
        if order_id:
            self._hosted_trades[int(order_id)] = (ib, trade)
        return {
            "order_id": order_id,
            "perm_id": getattr(trade.order, "permId", None),
            "status": getattr(trade.orderStatus, "status", "Submitted"),
        }

    def modify_hosted(self, order_id: int, item: Dict[str, Any]) -> bool:
        """改一张托管单的价格/数量(同 orderId 重发 = IBKR 的改单语义)。

        撤了重挂会留出一段没有保护的窗口,改单没有——所以必须是改,不是换。
        """
        entry = self._hosted_trades.get(int(order_id))
        if entry is None:
            return False
        ib, trade = entry
        order = trade.order
        order.totalQuantity = item["quantity"]
        if item.get("lmt_price") is not None:
            order.lmtPrice = item["lmt_price"]
        if item.get("aux_price") is not None:
            order.auxPrice = item["aux_price"]
        if item.get("trailing_percent") is not None:
            order.trailingPercent = item["trailing_percent"]
        ib.placeOrder(trade.contract, order)
        return True

    def cancel_hosted(self, order_id: int) -> bool:
        entry = self._hosted_trades.pop(int(order_id), None)
        if entry is None:
            return False
        ib, trade = entry
        ib.cancelOrder(trade.order)
        return True

    def list_hosted_open(self, ref_prefix: str = "trk:") -> List[Dict[str, Any]]:
        """从券商未成交单里认领托管单(orderRef 前缀匹配)。

        重启后的第一件事:先认领再对账,否则同一追踪会被再挂一遍。
        """
        rows: List[Dict[str, Any]] = []
        for ib in self._connections.values():
            if not ib.isConnected():
                continue
            for trade in ib.openTrades():
                ref = str(getattr(trade.order, "orderRef", "") or "")
                if not ref.startswith(ref_prefix):
                    continue
                order_id = getattr(trade.order, "orderId", None)
                if order_id:
                    self._hosted_trades[int(order_id)] = (ib, trade)
                rows.append({
                    "order_ref": ref,
                    "order_id": order_id,
                    "perm_id": getattr(trade.order, "permId", None),
                    "account": getattr(trade.order, "account", ""),
                    "action": getattr(trade.order, "action", ""),
                    "order_type": getattr(trade.order, "orderType", ""),
                    "quantity": float(getattr(trade.order, "totalQuantity", 0) or 0),
                    "lmt_price": _clean_price(getattr(trade.order, "lmtPrice", None)),
                    "aux_price": _clean_price(getattr(trade.order, "auxPrice", None)),
                    "trailing_percent": _clean_price(
                        getattr(trade.order, "trailingPercent", None)
                    ),
                    "status": getattr(trade.orderStatus, "status", ""),
                })
        return rows

    def sessions(self) -> List[Any]:
        """已建立的连接,供上层挂成交/状态回调。"""
        return [ib for ib in self._connections.values() if ib.isConnected()]

    def connected_names(self) -> List[str]:
        return sorted(name for name, ib in self._connections.items() if ib.isConnected())

    def cancel_all_open(self) -> int:
        """熔断用:撤掉全部未成交单(§9.7)。"""
        count = 0
        for ib in self._connections.values():
            if not ib.isConnected():
                continue
            for trade in ib.openTrades():
                ib.cancelOrder(trade.order)
                count += 1
        return count


def _describe(contract) -> str:
    parts = [getattr(contract, "symbol", "?"), getattr(contract, "secType", "?")]
    for attr in ("lastTradeDateOrContractMonth", "strike", "right", "tradingClass"):
        value = getattr(contract, attr, None)
        if value:
            parts.append(str(value))
    return " ".join(parts)
