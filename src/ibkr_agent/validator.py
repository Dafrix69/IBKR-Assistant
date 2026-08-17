"""软件层硬校验(设计文档 §5)——第二道防线,全部用代码实现,不依赖 LLM。

这一层的立场:**LLM 的输出是不可信输入**。限额自己重算、方向自己复核、
账户自己映射、价差结构自己验。任何一条过不去就拦下来,拦下的理由要能直接
推送给用户看懂。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from .config import AccountConfig, Settings
from .models import ContractSpec, Leg, OrderSpec, ParsedOrder

# 校验层的拒绝码:包含提示词侧的码,另加只有软件层能发现的问题
VALIDATOR_CODES = {
    "LOW_CONFIDENCE",
    "UNKNOWN_ACCOUNT",
    "LIVE_TRADING_DISABLED",
    "EXCEEDS_LIMIT",
    "BAD_SPREAD",
    "TRIGGER_MISMATCH",
    "AMBIGUOUS_TRIGGER",
    "EXPIRED_CONTRACT",
    "MARKET_CLOSED",
    "DUPLICATE_ORDER",
    "UNSUPPORTED",
    "UNPRICEABLE",
}


@dataclass(frozen=True)
class ValidationIssue:
    code: str
    message: str


@dataclass
class RecentOrder:
    """来自落库记录的近期订单,用于重复防抖(§5.4)。"""

    signature: str
    quantity: float
    created_at: datetime


@dataclass
class ApprovedOrder:
    order: ParsedOrder
    account: AccountConfig
    notional: float
    signature: str
    warnings: List[str] = field(default_factory=list)

    @property
    def account_id(self) -> str:
        return self.account.account_id


@dataclass
class RejectedOrder:
    order: ParsedOrder
    issues: List[ValidationIssue]

    @property
    def primary_code(self) -> str:
        return self.issues[0].code if self.issues else "UNSUPPORTED"

    def message(self) -> str:
        # 两条腿常触发同一条问题(如同一个到期日),推给用户前去重
        seen: List[str] = []
        for issue in self.issues:
            if issue.message not in seen:
                seen.append(issue.message)
        return " / ".join(seen)


@dataclass
class ValidationOutcome:
    approved: List[ApprovedOrder] = field(default_factory=list)
    rejected: List[RejectedOrder] = field(default_factory=list)


class Validator:
    def __init__(
        self,
        settings: Settings,
        now_et: datetime,
        snapshot: Optional[Mapping[str, float]] = None,
        recent_orders: Optional[Sequence[RecentOrder]] = None,
    ):
        self.settings = settings
        self.now_et = now_et
        self.snapshot = {k.upper(): float(v) for k, v in (snapshot or {}).items()}
        self.recent_orders = list(recent_orders or [])
        self.market_status = settings.market_status(now_et)

    # ------------------------------------------------------------------
    def validate_all(self, orders: Sequence[ParsedOrder]) -> ValidationOutcome:
        outcome = ValidationOutcome()
        limit = self.settings.limits.max_orders_per_input
        seen_in_batch: Dict[str, float] = {}

        for index, order in enumerate(orders):
            if index >= limit:
                outcome.rejected.append(
                    RejectedOrder(
                        order,
                        [
                            ValidationIssue(
                                "EXCEEDS_LIMIT",
                                "单次输入最多解析 %d 笔订单,本条排在第 %d 位,已拦截。"
                                "请拆成多次提交。" % (limit, index + 1),
                            )
                        ],
                    )
                )
                continue

            issues, approved = self.validate_one(order, seen_in_batch)
            if issues or approved is None:
                outcome.rejected.append(RejectedOrder(order, issues))
            else:
                seen_in_batch[approved.signature] = float(order.order.totalQuantity)
                outcome.approved.append(approved)
        return outcome

    # ------------------------------------------------------------------
    def validate_one(
        self, order: ParsedOrder, seen_in_batch: Optional[Mapping[str, float]] = None
    ) -> Tuple[List[ValidationIssue], Optional[ApprovedOrder]]:
        issues: List[ValidationIssue] = []
        warnings: List[str] = []

        # 1. 置信度(§5.2:即使出现在 orders 里也要拦)
        min_conf = self.settings.limits.min_confidence
        if order.confidence < min_conf:
            issues.append(
                ValidationIssue(
                    "LOW_CONFIDENCE",
                    "解析置信度 %.2f 低于阈值 %.2f,按规则改判拒绝。请把指令写得更明确后重试。"
                    % (order.confidence, min_conf),
                )
            )

        # 2. 账户映射(别名 → 账号,只在软件层做)
        account = self.settings.account_by_alias(order.account)
        if account is None:
            aliases = "、".join(self.settings.alias_list()) or "(未配置)"
            issues.append(
                ValidationIssue(
                    "UNKNOWN_ACCOUNT",
                    "账户别名 %r 不在别名表中(可用:%s)。请改写指令或先在设置里添加别名。"
                    % (order.account, aliases),
                )
            )
        elif not account.is_paper and not self.settings.policies.allow_live_trading:
            issues.append(
                ValidationIssue(
                    "LIVE_TRADING_DISABLED",
                    "订单指向实盘账户 %s,但当前 allow_live_trading=false(默认关闭)。"
                    "请先在纸面账户跑够回归测试,再显式开启实盘。" % account.alias,
                )
            )

        # 3. 合约复核
        issues.extend(self._check_contract(order.contract, warnings))

        # 4. 价差结构复核(§5.3a)
        if order.contract.secType == "BAG":
            issues.extend(self._check_spread(order.contract, order.order))

        # 5. 触发方向复核(§5.3b)
        if order.trigger is not None:
            issues.extend(self._check_trigger(order, warnings))

        # 6. 限额复算(§5.2:不信任 LLM 的算术)
        notional, limit_issues = self._check_limits(order)
        issues.extend(limit_issues)

        # 7. 交易时段(§5.5)
        issues.extend(self._check_session(order, warnings))

        # 8. 重复防抖(§5.4)
        signature = order_signature(order, order.account)
        issues.extend(self._check_duplicate(order, signature, seen_in_batch or {}))

        # 9. 原因缺失只警告,不阻断(§2 铁律 8)
        if not order.reason.strip():
            warnings.append("未提供操作原因,建议补充以便复盘")

        if issues or account is None:
            return issues, None

        merged = list(order.warnings) + warnings
        return [], ApprovedOrder(
            order=order, account=account, notional=notional, signature=signature, warnings=merged
        )

    # ---- 合约 ---------------------------------------------------------
    def _check_contract(self, contract: ContractSpec, warnings: List[str]) -> List[ValidationIssue]:
        issues: List[ValidationIssue] = []
        expiries: List[str] = []
        if contract.lastTradeDateOrContractMonth:
            expiries.append(contract.lastTradeDateOrContractMonth)
        for leg in contract.legs or []:
            expiries.append(leg.lastTradeDateOrContractMonth)

        today = self.now_et.date()
        for raw in expiries:
            expiry = _parse_date(raw)
            if expiry < today:
                issues.append(
                    ValidationIssue(
                        "EXPIRED_CONTRACT",
                        "到期日 %s 已早于当前美东日期 %s,合约不存在。" % (raw, today.isoformat()),
                    )
                )
            elif not self.settings.is_trading_day(expiry):
                issues.append(
                    ValidationIssue(
                        "EXPIRED_CONTRACT",
                        "到期日 %s 不是交易日(周末或休市日),请确认后重写。" % raw,
                    )
                )

        # 指数期权的 tradingClass 按到期日复核(§8.3)
        index_cfg = self.settings.index_config(contract.symbol)
        if index_cfg and expiries:
            for leg_or_self, raw in _expiry_slots(contract):
                expiry = _parse_date(raw)
                expected = (
                    index_cfg.monthly_trading_class
                    if _is_third_friday(expiry)
                    else index_cfg.daily_trading_class
                )
                if not expected:
                    continue
                current = getattr(leg_or_self, "tradingClass", None)
                if current != expected:
                    warnings.append(
                        "%s %s 到期的 tradingClass 由 %r 复核为 %r(按到期日判定)"
                        % (contract.symbol, raw, current, expected)
                    )
                    leg_or_self.tradingClass = expected
        return issues

    # ---- 价差 ---------------------------------------------------------
    def _check_spread(self, contract: ContractSpec, order: OrderSpec) -> List[ValidationIssue]:
        legs: List[Leg] = list(contract.legs or [])
        if len(legs) != 2:
            return [ValidationIssue("BAD_SPREAD", "垂直价差必须正好两条腿。")]

        buys = [l for l in legs if l.action == "BUY"]
        sells = [l for l in legs if l.action == "SELL"]
        if len(buys) != 1 or len(sells) != 1:
            return [ValidationIssue("BAD_SPREAD", "垂直价差必须一买一卖各一条腿。")]

        buy, sell = buys[0], sells[0]
        issues: List[ValidationIssue] = []
        if buy.right != sell.right:
            issues.append(ValidationIssue("BAD_SPREAD", "两腿必须同为 Call 或同为 Put。"))
        if buy.lastTradeDateOrContractMonth != sell.lastTradeDateOrContractMonth:
            issues.append(ValidationIssue("BAD_SPREAD", "垂直价差两腿到期日必须相同。"))
        if buy.strike == sell.strike:
            issues.append(ValidationIssue("BAD_SPREAD", "两腿行权价不能相同。"))
        if buy.ratio != sell.ratio:
            issues.append(ValidationIssue("BAD_SPREAD", "目前只支持 1:1 比例。"))
        if issues:
            return issues

        # 方向复核:借方价差(BUY)买低卖高(call)/ 买高卖低(put),SELL 相反
        debit = order.action == "BUY"
        if buy.right == "C":
            ok = (buy.strike < sell.strike) if debit else (buy.strike > sell.strike)
        else:
            ok = (buy.strike > sell.strike) if debit else (buy.strike < sell.strike)
        if not ok:
            issues.append(
                ValidationIssue(
                    "BAD_SPREAD",
                    "%s %s spread 的腿方向不对:买 %.2f / 卖 %.2f 不构成该方向的垂直价差。"
                    % (
                        "买入(借方)" if debit else "卖出(贷方)",
                        "call" if buy.right == "C" else "put",
                        buy.strike,
                        sell.strike,
                    ),
                )
            )

        # AUTO_MID 的数学上限:净权利金不得超过行权价差
        if order.price_mode == "AUTO_MID" and order.lmtPrice is not None:
            issues.append(ValidationIssue("BAD_SPREAD", "AUTO_MID 时 lmtPrice 必须为空。"))
        if order.price_mode == "EXPLICIT" and order.lmtPrice is not None and debit:
            width = abs(buy.strike - sell.strike)
            if order.lmtPrice > width:
                issues.append(
                    ValidationIssue(
                        "BAD_SPREAD",
                        "借方价差净权利金 %.2f 超过行权价差 %.2f,数学上不可能盈利。"
                        % (order.lmtPrice, width),
                    )
                )
        return issues

    # ---- 触发条件 ------------------------------------------------------
    def _check_trigger(self, order: ParsedOrder, warnings: List[str]) -> List[ValidationIssue]:
        trigger = order.trigger
        assert trigger is not None
        price = self.snapshot.get(trigger.symbol)
        if price is None:
            if self.settings.policies.require_trigger_price_verification:
                return [
                    ValidationIssue(
                        "AMBIGUOUS_TRIGGER",
                        "缺少 %s 的现价快照,无法独立复核触发方向(%s %.4f),按策略拒绝。"
                        % (trigger.symbol, trigger.operator, trigger.value),
                    )
                ]
            warnings.append("未取得 %s 现价,触发方向未经软件层复核" % trigger.symbol)
            return []

        gap_bps = abs(price - trigger.value) / price * 10_000 if price else 0.0
        if gap_bps < self.settings.policies.trigger_min_gap_bps:
            return [
                ValidationIssue(
                    "AMBIGUOUS_TRIGGER",
                    "%s 现价 %.4f 与触发价 %.4f 相差仅 %.1f 个基点,方向不可靠,已拒绝。"
                    % (trigger.symbol, price, trigger.value, gap_bps),
                )
            ]

        expected = ">=" if price < trigger.value else "<="
        if trigger.operator != expected:
            return [
                ValidationIssue(
                    "TRIGGER_MISMATCH",
                    "触发方向判反了:%s 现价 %.4f %s 触发价 %.4f,应为 %s,模型给的是 %s。"
                    % (
                        trigger.symbol,
                        price,
                        "低于" if price < trigger.value else "高于",
                        trigger.value,
                        expected,
                        trigger.operator,
                    ),
                )
            ]
        warnings.append(
            "已复核:%s 现价 %.4f,触发条件 %s %.4f 方向一致"
            % (trigger.symbol, price, trigger.operator, trigger.value)
        )
        return []

    # ---- 限额 ---------------------------------------------------------
    def _check_limits(self, order: ParsedOrder) -> Tuple[float, List[ValidationIssue]]:
        limits = self.settings.limits
        contract, spec = order.contract, order.order
        qty = float(spec.totalQuantity)
        issues: List[ValidationIssue] = []

        if contract.secType == "BAG":
            legs = contract.legs or []
            width = abs(legs[0].strike - legs[1].strike) if len(legs) == 2 else 0.0
            notional = qty * contract.multiplier_value * width
        elif contract.secType == "OPT":
            # 注意:标的现价不是权利金,期权这里不做快照兜底
            premium = _reference_price(spec, None)
            if premium is None:
                return 0.0, [
                    ValidationIssue(
                        "UNPRICEABLE",
                        "单腿期权缺少可用于估算风险敞口的价格(权利金),无法核对限额,已拒绝。"
                        "请写明权利金上限,例如'权利金不超过 5.5'。",
                    )
                ]
            notional = qty * contract.multiplier_value * premium
        else:
            ref = _reference_price(spec, self.snapshot.get(contract.symbol))
            if ref is None:
                if qty > limits.max_mkt_shares:
                    return 0.0, [
                        ValidationIssue(
                            "EXCEEDS_LIMIT",
                            "无法估算市价单金额(指令与行情快照都没有参考价),股数 %d 超过市价单上限 %d 股。"
                            % (spec.totalQuantity, limits.max_mkt_shares),
                        )
                    ]
                return 0.0, []
            notional = qty * ref

        if notional > limits.max_order_notional:
            issues.append(
                ValidationIssue(
                    "EXCEEDS_LIMIT",
                    "本笔风险敞口约 %.2f USD,超过单笔上限 %.2f USD。"
                    % (notional, limits.max_order_notional),
                )
            )
        if contract.secType in ("OPT", "BAG") and spec.totalQuantity > limits.max_option_contracts:
            issues.append(
                ValidationIssue(
                    "EXCEEDS_LIMIT",
                    "期权/价差单笔 %d 张,超过上限 %d 张。"
                    % (spec.totalQuantity, limits.max_option_contracts),
                )
            )
        return notional, issues

    # ---- 交易时段 ------------------------------------------------------
    def _check_session(self, order: ParsedOrder, warnings: List[str]) -> List[ValidationIssue]:
        policy = self.settings.policies.closed_market_policy
        status = self.market_status
        spec = order.order

        if status == "休市":
            if order.execution_type == "CONDITIONAL":
                warnings.append("当前休市,条件单进入等待队列,开盘后才可能触发")
                return []
            if policy == "reject_all":
                return [ValidationIssue("MARKET_CLOSED", "当前休市,按策略拒绝所有直接执行型订单。")]
            if policy == "reject_market_orders" and spec.orderType == "MKT":
                return [
                    ValidationIssue(
                        "MARKET_CLOSED",
                        "当前休市,市价单会在开盘瞬间以未知价格成交,风险过大,已拒绝。"
                        "请改成限价单,例如'限价 230 买入'。",
                    )
                ]
            warnings.append("当前休市,订单将挂到下一个交易时段")
            return []

        if status in ("盘前", "盘后") and not spec.outsideRth:
            warnings.append("当前为%s,outsideRth=false,订单要等到常规时段才会成交" % status)
        if status in ("盘前", "盘后") and spec.outsideRth and spec.orderType == "MKT":
            warnings.append("%s市价单流动性差,滑点风险显著" % status)
        return []

    # ---- 重复防抖 ------------------------------------------------------
    def _check_duplicate(
        self, order: ParsedOrder, signature: str, seen_in_batch: Mapping[str, float]
    ) -> List[ValidationIssue]:
        limits = self.settings.limits
        qty = float(order.order.totalQuantity)

        if signature in seen_in_batch and _qty_close(
            qty, seen_in_batch[signature], limits.duplicate_qty_tolerance
        ):
            return [
                ValidationIssue(
                    "DUPLICATE_ORDER",
                    "同一条输入里出现了重复订单(%s),已拦截第二笔以防重复下单。" % signature,
                )
            ]

        window = timedelta(minutes=limits.duplicate_window_minutes)
        for recent in self.recent_orders:
            if recent.signature != signature:
                continue
            if self.now_et - _as_aware(recent.created_at, self.now_et) > window:
                continue
            if _qty_close(qty, recent.quantity, limits.duplicate_qty_tolerance):
                return [
                    ValidationIssue(
                        "DUPLICATE_ORDER",
                        "%d 分钟内已提交过高度相似的订单(%s,数量 %g),已拦截以防重复下单。"
                        "如确需再下一笔,请等待窗口结束或改变数量。"
                        % (limits.duplicate_window_minutes, signature, recent.quantity),
                    )
                ]
        return []


# ----------------------------------------------------------------------
def order_signature(order: ParsedOrder, account_alias: str) -> str:
    """用于防抖与审计的订单指纹:账户+方向+合约要素,不含数量与价格。"""
    contract = order.contract
    parts = [account_alias, order.order.action, contract.secType, contract.symbol]
    if contract.secType == "OPT":
        parts += [
            contract.lastTradeDateOrContractMonth or "",
            "%g" % (contract.strike or 0),
            contract.right or "",
        ]
    elif contract.secType == "BAG":
        for leg in sorted(contract.legs or [], key=lambda l: l.strike):
            parts += [leg.action, leg.lastTradeDateOrContractMonth, "%g" % leg.strike, leg.right]
    return "|".join(parts)


def _reference_price(spec: OrderSpec, snapshot_price: Optional[float]) -> Optional[float]:
    for candidate in (spec.lmtPrice, spec.auxPrice, snapshot_price):
        if candidate:
            return float(candidate)
    return None


def _qty_close(a: float, b: float, tolerance: float) -> bool:
    if a == b:
        return True
    base = max(abs(a), abs(b)) or 1.0
    return abs(a - b) / base <= tolerance


def _parse_date(raw: str) -> date:
    return date(int(raw[:4]), int(raw[4:6]), int(raw[6:8]))


def _is_third_friday(day: date) -> bool:
    if day.weekday() != 4:
        return False
    return 15 <= day.day <= 21


def _expiry_slots(contract: ContractSpec):
    if contract.lastTradeDateOrContractMonth:
        yield contract, contract.lastTradeDateOrContractMonth
    for leg in contract.legs or []:
        yield leg, leg.lastTradeDateOrContractMonth


def _as_aware(moment: datetime, reference: datetime) -> datetime:
    if moment.tzinfo is None and reference.tzinfo is not None:
        return moment.replace(tzinfo=reference.tzinfo)
    return moment
