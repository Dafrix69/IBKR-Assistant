"""软件层硬校验(设计文档 §5)——第二道防线,全部用代码实现,不依赖 LLM。

这一层的立场:**LLM 的输出是不可信输入**。限额自己重算、方向自己复核、
账户自己映射、价差结构自己验。任何一条过不去就拦下来,拦下的理由要能直接
推送给用户看懂。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

#: 能交易、但交易所只收限价单的时段。"盘外"来自合约自己的交易时段
#: (config.hours_status):SPX 期权的隔夜段既不是正股口径的"盘前"也不是"盘后"。
#: 与 tracker.EXTENDED_SESSIONS 同一套语义,两边都改才不会一边放行一边拦。
EXTENDED_STATUSES = ("盘前", "盘后", "盘外")

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
        market_status_fn: Optional[Any] = None,
    ):
        self.settings = settings
        self.now_et = now_et
        self.snapshot = {k.upper(): float(v) for k, v in (snapshot or {}).items()}
        self.recent_orders = list(recent_orders or [])
        self.market_status = settings.market_status(now_et)
        # 按订单问一次"这个合约此刻能不能交易"。给 None 就退回上面那个全局值。
        # 存在的理由:`settings.market_status` 是照**美股正股**写的,而 SPX 期权
        # 还有 20:15–次日 09:25 这一整段隔夜可交易时间(IBKR 报的 SPXW 时段)。
        # 拿正股的表判期权,隔夜下单会被误告"当前休市,订单将挂到下一个交易时段",
        # 而那时它其实能成交。(2026-09-04 实测)
        self._market_status_fn = market_status_fn

    def status_for(self, order: ParsedOrder) -> str:
        """这一单此刻面对的时段。期权/组合优先用合约自己的,拿不到退回正股表。"""
        if self._market_status_fn is not None:
            try:
                got = self._market_status_fn(order)
            except Exception:  # noqa: BLE001 - 查时段失败不该让校验整个炸
                got = None
            if got:
                return str(got)
        return self.market_status

    # ------------------------------------------------------------------
    def validate_all(
        self, orders: Sequence[ParsedOrder], limit: Optional[int] = None
    ) -> ValidationOutcome:
        """逐条校验一批订单。

        ``limit`` 覆盖单次输入的订单上限:引擎按账户扇出后同一条输入会变成
        N 倍订单,上限也要按同样倍数放大,否则第二个账户的订单会被当成超额拦掉。
        """
        outcome = ValidationOutcome()
        limit = self.settings.limits.max_orders_per_input if limit is None else limit
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
        if contract.combo_strategy == "BUTTERFLY":
            return self._check_butterfly(contract, order)
        if contract.combo_strategy == "IRON_CONDOR":
            return self._check_iron_condor(contract, order)
        return self._check_vertical(contract, order)

    def _check_vertical(self, contract: ContractSpec, order: OrderSpec) -> List[ValidationIssue]:
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
        if buy.ratio != 1 or sell.ratio != 1:
            issues.append(ValidationIssue("BAD_SPREAD", "垂直价差只支持 1:1 比例。"))
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

    def _check_butterfly(self, contract: ContractSpec, order: OrderSpec) -> List[ValidationIssue]:
        """蝴蝶只支持买入(借方):买外翼 1:1、卖中腿 2,同权利、同到期、等翼距。

        只放行借方的原因:最大亏损被净权利金封死,风险形态与现有限额模型兼容;
        卖出蝴蝶收的权利金小、保证金规则复杂,不值得为它扩大受攻击面。
        """
        legs: List[Leg] = sorted(contract.legs or [], key=lambda l: l.strike)
        if len(legs) != 3:
            return [ValidationIssue("BAD_SPREAD", "蝴蝶必须正好三条腿。")]

        lo, mid, hi = legs
        issues: List[ValidationIssue] = []
        if order.action != "BUY":
            issues.append(
                ValidationIssue(
                    "BAD_SPREAD",
                    "仅支持买入(借方)蝴蝶:卖出蝴蝶的保证金与风险结构不在本系统支持范围内。",
                )
            )
        if len({l.right for l in legs}) != 1:
            issues.append(ValidationIssue("BAD_SPREAD", "蝴蝶三条腿必须同为 Call 或同为 Put。"))
        if len({l.lastTradeDateOrContractMonth for l in legs}) != 1:
            issues.append(ValidationIssue("BAD_SPREAD", "蝴蝶三条腿到期日必须相同。"))
        if len({l.strike for l in legs}) != 3:
            issues.append(ValidationIssue("BAD_SPREAD", "蝴蝶三条腿行权价必须互不相同。"))
        if lo.action != "BUY" or hi.action != "BUY" or mid.action != "SELL":
            issues.append(
                ValidationIssue("BAD_SPREAD", "买入蝴蝶的腿方向必须是:买最低价、卖中间价、买最高价。")
            )
        if lo.ratio != 1 or hi.ratio != 1 or mid.ratio != 2:
            issues.append(
                ValidationIssue("BAD_SPREAD", "蝴蝶比例必须是 1:-2:1(外翼各 1 张,中腿 2 张)。")
            )
        if issues:
            return issues

        wing_lo = mid.strike - lo.strike
        wing_hi = hi.strike - mid.strike
        if abs(wing_lo - wing_hi) > 0.01:
            return [
                ValidationIssue(
                    "BAD_SPREAD",
                    "蝴蝶两翼必须等距(当前 %.2f / %.2f)。不等翼(broken wing)结构不支持。"
                    % (wing_lo, wing_hi),
                )
            ]

        if order.price_mode == "EXPLICIT" and order.lmtPrice is not None:
            if order.lmtPrice > wing_lo:
                issues.append(
                    ValidationIssue(
                        "BAD_SPREAD",
                        "蝴蝶净权利金 %.2f 超过翼宽 %.2f,数学上不可能盈利。"
                        % (order.lmtPrice, wing_lo),
                    )
                )
        return issues

    def _check_iron_condor(self, contract: ContractSpec, order: OrderSpec) -> List[ValidationIssue]:
        """铁鹰只支持标准贷方结构:买外侧 Put、卖内侧 Put、卖内侧 Call、买外侧 Call。

        四腿 1:1、同到期、内侧行权价严格错开(内侧同价是铁蝶,不支持)。
        最大亏损 = 较宽一侧翼宽 - 收到的权利金,风险有界。
        """
        legs: List[Leg] = sorted(contract.legs or [], key=lambda l: l.strike)
        if len(legs) != 4:
            return [ValidationIssue("BAD_SPREAD", "铁鹰必须正好四条腿。")]

        issues: List[ValidationIssue] = []
        if order.action != "SELL":
            issues.append(
                ValidationIssue(
                    "BAD_SPREAD",
                    "仅支持卖出(贷方)铁鹰:收权利金、卖内侧买外翼。借方(反向)铁鹰不支持。",
                )
            )
        if len({l.lastTradeDateOrContractMonth for l in legs}) != 1:
            issues.append(ValidationIssue("BAD_SPREAD", "铁鹰四条腿到期日必须相同。"))
        if any(l.ratio != 1 for l in legs):
            issues.append(ValidationIssue("BAD_SPREAD", "铁鹰四条腿比例必须都是 1。"))
        if len({l.strike for l in legs}) != 4:
            issues.append(
                ValidationIssue(
                    "BAD_SPREAD",
                    "铁鹰四条腿行权价必须互不相同(内侧同价的铁蝶结构不支持)。",
                )
            )

        puts = sorted([l for l in legs if l.right == "P"], key=lambda l: l.strike)
        calls = sorted([l for l in legs if l.right == "C"], key=lambda l: l.strike)
        if len(puts) != 2 or len(calls) != 2:
            issues.append(ValidationIssue("BAD_SPREAD", "铁鹰必须由两条 Put 腿与两条 Call 腿组成。"))
        if issues:
            return issues

        if puts[-1].strike >= calls[0].strike:
            issues.append(
                ValidationIssue("BAD_SPREAD", "铁鹰的 Put 侧行权价必须整体低于 Call 侧。")
            )
        # 贷方结构:外翼是买入的保护腿,内侧是卖出的收权腿
        if puts[0].action != "BUY" or puts[1].action != "SELL":
            issues.append(
                ValidationIssue("BAD_SPREAD", "Put 侧腿方向不对:应买入低行权价、卖出高行权价。")
            )
        if calls[0].action != "SELL" or calls[1].action != "BUY":
            issues.append(
                ValidationIssue("BAD_SPREAD", "Call 侧腿方向不对:应卖出低行权价、买入高行权价。")
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
            width = _risk_width(contract)
            if spec.price_mode == "EXPLICIT" and spec.lmtPrice is not None:
                if spec.action == "BUY":
                    # 借方组合(买价差/蝴蝶)最大亏损 = 付出的净权利金
                    notional = qty * contract.multiplier_value * spec.lmtPrice
                else:
                    # 贷方组合(卖价差/铁鹰)最大亏损 = 宽度 - 收到的权利金
                    notional = qty * contract.multiplier_value * max(width - spec.lmtPrice, 0.0)
            else:
                # AUTO_MID:权利金未知,用结构宽度做最大亏损上界
                notional = qty * contract.multiplier_value * width
        elif contract.secType == "OPT":
            if spec.action == "SELL":
                # 裸卖期权的风险敞口不是"收到的权利金"。修复前按权利金计,
                # 卖 10 张 5.5 的 call 只算 5,500 敞口轻松过闸,真实风险无上限。
                if contract.right != "P":
                    return 0.0, [
                        ValidationIssue(
                            "UNSUPPORTED",
                            "裸卖 Call 的最大亏损无上限,且本系统无法核对你是否持有正股"
                            "(备兑)。单腿卖出 Call 不支持;备兑思路请直接在 TWS 操作,"
                            "或改用风险有界的贷方价差(卖出 call spread)。",
                        )
                    ]
                if not contract.strike or contract.strike <= 0:
                    return 0.0, [
                        ValidationIssue(
                            "UNPRICEABLE",
                            "卖出 Put 需要行权价才能按最坏情况(被行权接货)核算敞口,"
                            "当前合约缺少行权价,已拒绝。",
                        )
                    ]
                # 卖出 Put 按现金担保口径计敞口:行权价 × 乘数 × 张数(最坏情况全额接货)
                notional = qty * contract.multiplier_value * contract.strike
            else:
                # 买入期权:最大亏损 = 付出的权利金。
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
        status = self.status_for(order)
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

        if status in EXTENDED_STATUSES and not spec.outsideRth:
            # 光说"要等"没用——用户要的是知道怎么让它现在就走。IBKR 那边的原话是
            # "您的委托单在 …前不会被下达交易所",单子会一直挂着。
            warnings.append(
                "当前为%s,outsideRth=false:订单会挂着,到常规时段才送交易所。"
                "要在%s就成交,指令里加「盘外」或「隔夜」。" % (status, status)
            )
        if status in EXTENDED_STATUSES and spec.outsideRth and spec.orderType == "MKT":
            # 交易所盘外只接受限价单:盘外市价单物理上不会在盘外成交,
            # 只会挂到开盘——与"盘前成交"的意图直接矛盾,必须硬拒而不是警告。
            return [
                ValidationIssue(
                    "UNSUPPORTED",
                    "%s市价单不被交易所支持:盘外只接受限价单,市价单会一直等到开盘才成交,"
                    "与盘外成交的意图矛盾。请改写为盘外限价单,例如'盘前限价 X 买入…'。" % status,
                )
            ]
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
            parts += [
                leg.action,
                "%d" % leg.ratio,
                leg.lastTradeDateOrContractMonth,
                "%g" % leg.strike,
                leg.right,
            ]
    return "|".join(parts)


def _risk_width(contract: ContractSpec) -> float:
    """组合的最大亏损宽度(每张、每乘数单位),用于限额复算。

    垂直价差=行权价差;蝴蝶=翼宽(借方最大亏损 = 净权利金 ≤ 翼宽);
    铁鹰=较宽一侧翼宽(贷方最大亏损 = 宽翼 - 权利金 < 宽翼)。
    结构不合法时给 0——结构校验会先拦下,这里不重复报。
    """
    legs = sorted(contract.legs or [], key=lambda l: l.strike)
    strategy = contract.combo_strategy
    if strategy == "VERTICAL" and len(legs) == 2:
        return abs(legs[1].strike - legs[0].strike)
    if strategy == "BUTTERFLY" and len(legs) == 3:
        return legs[1].strike - legs[0].strike
    if strategy == "IRON_CONDOR" and len(legs) == 4:
        puts = sorted([l for l in legs if l.right == "P"], key=lambda l: l.strike)
        calls = sorted([l for l in legs if l.right == "C"], key=lambda l: l.strike)
        if len(puts) == 2 and len(calls) == 2:
            return max(puts[1].strike - puts[0].strike, calls[1].strike - calls[0].strike)
    return 0.0


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
