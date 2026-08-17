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

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .config import AccountConfig, Settings
from .models import ContractSpec, OrderSpec, ParsedOrder, TriggerSpec
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
        if self.bid <= 0 or self.ask <= 0 or self.ask < self.bid:
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


def auto_mid_limit(
    net_mid: float, action: str, slippage: float, strike_width: Optional[float] = None
) -> float:
    """把中间价转成可下单限价:买入向上让 slippage,卖出向下让 slippage。

    借方价差再叠一道数学上限——净权利金不可能超过行权价差(§5.3a)。
    """
    if slippage < 0:
        raise BrokerError("滑点上限不能为负")
    limit = net_mid + slippage if action == "BUY" else net_mid - slippage
    if action == "BUY":
        if strike_width is not None:
            limit = min(limit, strike_width)
        if limit <= 0:
            raise BrokerError("计算出的买入限价 %.4f 非正,拒绝下单" % limit)
    else:
        if limit <= 0:
            raise BrokerError("计算出的卖出限价 %.4f 非正,拒绝下单" % limit)
    return round(limit, 4)


def strike_width(contract: ContractSpec) -> Optional[float]:
    legs = contract.legs or []
    if len(legs) != 2:
        return None
    return abs(legs[0].strike - legs[1].strike)


def price_condition_spec(trigger: TriggerSpec) -> Dict[str, Any]:
    """把 trigger 描述成 ib_insync PriceCondition 需要的参数(纯数据,便于断言)。"""
    return {
        "symbol": trigger.symbol,
        "secType": trigger.secType,
        "isMore": trigger.operator == ">=",
        "price": trigger.value,
    }


def build_ib_order(spec: OrderSpec, account_id: str, limit_override: Optional[float] = None):
    """按 orderType 构造 ib_insync Order。价格为空的组合在这里就报错,不留到 IBKR。"""
    ib = _ib()
    limit_price = limit_override if limit_override is not None else spec.lmtPrice

    if spec.orderType == "MKT":
        order = ib.MarketOrder(spec.action, spec.totalQuantity)
    elif spec.orderType == "LMT":
        if limit_price is None:
            raise BrokerError("限价单缺少限价(AUTO_MID 未定价?),拒绝下单")
        order = ib.LimitOrder(spec.action, spec.totalQuantity, limit_price)
    elif spec.orderType == "STP":
        order = ib.StopOrder(spec.action, spec.totalQuantity, spec.auxPrice)
    elif spec.orderType == "STP LMT":
        order = ib.StopLimitOrder(spec.action, spec.totalQuantity, limit_price, spec.auxPrice)
    elif spec.orderType == "TRAIL":
        order = ib.Order(
            orderType="TRAIL", action=spec.action, totalQuantity=spec.totalQuantity
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

    def __init__(self, settings: Settings):
        self.settings = settings
        self._connections: Dict[str, Any] = {}

    # ---- 连接 -----------------------------------------------------------
    def connect(self, connection_name: str):
        if connection_name in self._connections:
            conn = self._connections[connection_name]
            if conn.isConnected():
                return conn
        cfg = self.settings.connections.get(connection_name)
        if cfg is None:
            raise BrokerError("未定义的连接:%s" % connection_name)
        ib = _ib().IB()
        try:
            ib.connect(cfg.host, cfg.port, clientId=cfg.client_id, readonly=cfg.readonly)
        except Exception as exc:  # noqa: BLE001
            raise BrokerError(
                "连接 %s (%s:%d) 失败:%s。请确认 TWS/IB Gateway 已启动且开启了本机 API。"
                % (connection_name, cfg.host, cfg.port, exc)
            ) from exc
        self._connections[connection_name] = ib
        return ib

    def disconnect_all(self) -> None:
        for ib in self._connections.values():
            if ib.isConnected():
                ib.disconnect()
        self._connections.clear()

    def for_account(self, account: AccountConfig):
        ib = self.connect(account.connection)
        managed = set(ib.managedAccounts() or [])
        if managed and account.account_id not in managed:
            raise BrokerError(
                "账户 %s(%s)不在该会话可管理的账户列表中,拒绝下单以免落到错误账户。"
                % (account.alias, account.account_id)
            )
        return ib

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

    def _build_bag(self, ib, contract: ContractSpec):
        mod = _ib()
        combo_legs = []
        for leg in contract.legs or []:
            opt = mod.Option(
                contract.symbol,
                leg.lastTradeDateOrContractMonth,
                leg.strike,
                leg.right,
                contract.exchange,
                currency=contract.currency,
                multiplier=leg.multiplier,
                tradingClass=leg.tradingClass or "",
            )
            self._qualify_or_raise(ib, opt)
            combo_legs.append(
                mod.ComboLeg(
                    conId=opt.conId, ratio=leg.ratio, action=leg.action, exchange=contract.exchange
                )
            )
        return mod.Contract(
            secType="BAG",
            symbol=contract.symbol,
            currency=contract.currency,
            exchange=contract.exchange,
            comboLegs=combo_legs,
        )

    @staticmethod
    def _qualify_or_raise(ib, contract) -> None:
        qualified = ib.qualifyContracts(contract)
        if not qualified or not getattr(contract, "conId", 0):
            raise BrokerError(
                "IBKR 无法确认该合约(%s),可能是代码拼错、到期日或行权价不存在。已拦截。"
                % _describe(contract)
            )

    # ---- 行情 -----------------------------------------------------------
    def leg_quotes(self, contract: ContractSpec, account: AccountConfig) -> List[LegQuote]:
        ib = self.for_account(account)
        mod = _ib()
        quotes: List[LegQuote] = []
        for leg in contract.legs or []:
            opt = mod.Option(
                contract.symbol,
                leg.lastTradeDateOrContractMonth,
                leg.strike,
                leg.right,
                contract.exchange,
                currency=contract.currency,
                multiplier=leg.multiplier,
                tradingClass=leg.tradingClass or "",
            )
            self._qualify_or_raise(ib, opt)
            ticker = ib.reqMktData(opt, "", False, False)
            ib.sleep(1.0)
            quotes.append(
                LegQuote(action=leg.action, ratio=leg.ratio, bid=ticker.bid or 0.0, ask=ticker.ask or 0.0)
            )
        return quotes

    def index_price(self, symbol: str) -> Optional[float]:
        cfg = self.settings.index_config(symbol)
        default = self.settings.default_account()
        if default is None:
            return None
        ib = self.for_account(default)
        mod = _ib()
        target = (
            mod.Index(symbol, cfg.exchange) if cfg else mod.Stock(symbol, "SMART", "USD")
        )
        try:
            self._qualify_or_raise(ib, target)
        except BrokerError:
            return None
        ticker = ib.reqMktData(target, "", False, False)
        ib.sleep(1.0)
        for candidate in (ticker.last, ticker.close, ticker.marketPrice()):
            if candidate and candidate == candidate:  # 排除 NaN
                return float(candidate)
        return None

    # ---- 下单 -----------------------------------------------------------
    def place(
        self, record_id: str, approved: ApprovedOrder, limit_override: Optional[float] = None
    ) -> PlacementResult:
        parsed = approved.order
        ib = self.for_account(approved.account)
        contract = self.qualify(parsed.contract, approved.account)
        order = build_ib_order(parsed.order, approved.account_id, limit_override)

        # 方式 A:用户给了明确价格的条件单,条件挂在 IBKR 服务器上,软件掉线也有效
        if parsed.trigger is not None and parsed.order.price_mode == "EXPLICIT":
            order.conditions = [self._price_condition(ib, parsed.trigger)]
            order.conditionsCancelOrder = False

        trade = ib.placeOrder(contract, order)
        ib.sleep(0.5)
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
