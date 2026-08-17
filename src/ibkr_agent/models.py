"""解析结果的严格 schema(设计文档 §2 / §5.1)。

原则:LLM 的输出永远是不可信输入。这里用 pydantic 做第一道结构校验,
`extra="forbid"` 让任何多余字段直接失败——宁可整条拒绝,绝不带着不认识的
字段往下走。语义/算术层面的复核在 validator.py,不在这里。
"""
from __future__ import annotations

import re
from datetime import date
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SecType = Literal["STK", "OPT", "BAG"]
Right = Literal["C", "P"]
Action = Literal["BUY", "SELL"]
OrderType = Literal["LMT", "MKT", "STP", "STP LMT", "TRAIL"]
PriceMode = Literal["EXPLICIT", "AUTO_MID"]
Tif = Literal["DAY", "GTC"]
ExecutionType = Literal["IMMEDIATE", "CONDITIONAL"]
TriggerSecType = Literal["IND", "STK"]
Operator = Literal[">=", "<="]

RejectionCode = Literal[
    "MISSING_QUANTITY",
    "MISSING_PRICE",
    "AMBIGUOUS_SYMBOL",
    "INCOMPLETE_OPTION",
    "AMBIGUOUS_TRIGGER",
    "UNKNOWN_ACCOUNT",
    "EXCEEDS_LIMIT",
    "UNSUPPORTED",
    "UNCLEAR",
]

_SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,11}$")
_EXPIRY_RE = re.compile(r"^\d{8}$")


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


def _check_expiry(value: str) -> str:
    if not _EXPIRY_RE.match(value):
        raise ValueError("到期日必须是 YYYYMMDD 8 位数字")
    try:
        date(int(value[:4]), int(value[4:6]), int(value[6:8]))
    except ValueError as exc:  # 20260231 之类
        raise ValueError("到期日不是合法日期: %s" % value) from exc
    return value


class Leg(Strict):
    """垂直价差的一条腿。标的与 currency 继承自父 contract。"""

    action: Action
    ratio: int = Field(ge=1, le=1, description="目前只支持 1:1 价差")
    lastTradeDateOrContractMonth: str
    strike: float = Field(gt=0)
    right: Right
    tradingClass: Optional[str] = None
    multiplier: str = "100"

    _v_expiry = field_validator("lastTradeDateOrContractMonth")(_check_expiry)


class ContractSpec(Strict):
    secType: SecType
    symbol: str
    exchange: str = "SMART"
    currency: Literal["USD"] = "USD"

    # 仅 secType="OPT"
    lastTradeDateOrContractMonth: Optional[str] = None
    strike: Optional[float] = Field(default=None, gt=0)
    right: Optional[Right] = None
    multiplier: str = "100"
    tradingClass: Optional[str] = None

    # 仅 secType="BAG"
    combo_strategy: Optional[Literal["VERTICAL"]] = None
    legs: Optional[List[Leg]] = None

    @field_validator("symbol")
    @classmethod
    def _symbol_shape(cls, v: str) -> str:
        v = v.strip().upper()
        if not _SYMBOL_RE.match(v):
            raise ValueError("标的代码必须是大写字母/数字组成的 ticker: %r" % v)
        return v

    @field_validator("lastTradeDateOrContractMonth")
    @classmethod
    def _expiry(cls, v: Optional[str]) -> Optional[str]:
        return None if v is None else _check_expiry(v)

    @model_validator(mode="after")
    def _shape_by_sectype(self) -> "ContractSpec":
        opt_fields = (self.lastTradeDateOrContractMonth, self.strike, self.right)
        if self.secType == "STK":
            if any(f is not None for f in opt_fields) or self.legs or self.combo_strategy:
                raise ValueError("STK 合约不得携带期权/组合字段")
        elif self.secType == "OPT":
            if any(f is None for f in opt_fields):
                raise ValueError("期权四要素缺失(到期日/行权价/Call-Put)")
            if self.legs or self.combo_strategy:
                raise ValueError("单腿期权不得携带 legs/combo_strategy")
        else:  # BAG
            if any(f is not None for f in opt_fields):
                raise ValueError("BAG 合约的期权要素必须写在 legs 里")
            if self.combo_strategy != "VERTICAL":
                raise ValueError("目前仅支持 combo_strategy=VERTICAL")
            if not self.legs or len(self.legs) != 2:
                raise ValueError("垂直价差必须正好两条腿")
        return self

    @property
    def multiplier_value(self) -> float:
        try:
            return float(self.multiplier)
        except (TypeError, ValueError):
            return 100.0


class TriggerSpec(Strict):
    type: Literal["PRICE"] = "PRICE"
    symbol: str
    secType: TriggerSecType
    operator: Operator
    value: float = Field(gt=0)

    @field_validator("symbol")
    @classmethod
    def _symbol_shape(cls, v: str) -> str:
        v = v.strip().upper()
        if not _SYMBOL_RE.match(v):
            raise ValueError("触发标的必须是 ticker: %r" % v)
        return v


class OrderSpec(Strict):
    action: Action
    orderType: OrderType
    totalQuantity: int = Field(gt=0)
    price_mode: PriceMode = "EXPLICIT"
    lmtPrice: Optional[float] = Field(default=None, gt=0)
    auxPrice: Optional[float] = Field(default=None, gt=0)
    trailingPercent: Optional[float] = Field(default=None, gt=0, le=100)
    tif: Tif = "DAY"
    outsideRth: bool = False

    @model_validator(mode="after")
    def _price_fields(self) -> "OrderSpec":
        t = self.orderType
        if t == "MKT":
            if self.lmtPrice is not None:
                raise ValueError("市价单不得带 lmtPrice")
        elif t == "LMT":
            if self.price_mode == "EXPLICIT" and self.lmtPrice is None:
                raise ValueError("限价单缺少 lmtPrice(铁律 3)")
            if self.price_mode == "AUTO_MID" and self.lmtPrice is not None:
                raise ValueError("AUTO_MID 时 lmtPrice 必须为 null")
        elif t == "STP":
            if self.auxPrice is None:
                raise ValueError("止损单缺少 auxPrice 触发价")
            if self.lmtPrice is not None:
                raise ValueError("STP 不得带 lmtPrice,需要限价请用 STP LMT")
        elif t == "STP LMT":
            if self.auxPrice is None or self.lmtPrice is None:
                raise ValueError("STP LMT 需要同时给出 auxPrice 与 lmtPrice")
        elif t == "TRAIL":
            has_aux, has_pct = self.auxPrice is not None, self.trailingPercent is not None
            if has_aux == has_pct:
                raise ValueError("TRAIL 必须且只能给 auxPrice 或 trailingPercent 其一")

        if self.price_mode == "AUTO_MID" and t != "LMT":
            raise ValueError("AUTO_MID 只适用于 LMT")
        if self.trailingPercent is not None and t != "TRAIL":
            raise ValueError("trailingPercent 只适用于 TRAIL")
        return self


class ParsedOrder(Strict):
    intent_summary: str = Field(min_length=1)
    contract: ContractSpec
    execution_type: ExecutionType
    trigger: Optional[TriggerSpec] = None
    account: str = "DEFAULT"
    order: OrderSpec
    reason: str = ""
    confidence: float = Field(ge=0.0, le=1.0)
    warnings: List[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _cross_field(self) -> "ParsedOrder":
        # §2 铁律 7b:execution_type 与 trigger 必须一致
        if self.execution_type == "CONDITIONAL" and self.trigger is None:
            raise ValueError("CONDITIONAL 订单缺少 trigger")
        if self.execution_type == "IMMEDIATE" and self.trigger is not None:
            raise ValueError("IMMEDIATE 订单不得带 trigger")
        # §2 铁律 3:AUTO_MID 只有两腿价差可用
        if self.order.price_mode == "AUTO_MID" and self.contract.secType != "BAG":
            raise ValueError("AUTO_MID 仅适用于两腿价差(BAG),单腿期权与股票缺价必须拒绝")
        if not self.account.strip():
            raise ValueError("account 不得为空,未指定时应为 DEFAULT")
        return self

    @property
    def is_option_like(self) -> bool:
        return self.contract.secType in ("OPT", "BAG")


class Rejection(Strict):
    original_text: str
    code: RejectionCode
    message: str


class ParseResult(Strict):
    orders: List[ParsedOrder] = Field(default_factory=list)
    rejections: List[Rejection] = Field(default_factory=list)


def parse_llm_payload(payload: Dict[str, Any]) -> "LenientParseResult":
    """把 LLM 原始 dict 解析成结果对象。

    单条订单的结构错误不能牵连其他订单(§2 一、"每个订单独立解析"),
    因此这里逐条解析,失败的降级成 rejection 而不是抛异常。
    """
    if not isinstance(payload, dict):
        raise TypeError("LLM 输出不是 JSON 对象")

    orders: List[ParsedOrder] = []
    rejections: List[Rejection] = []
    schema_errors: List[str] = []

    raw_orders = payload.get("orders") or []
    if not isinstance(raw_orders, list):
        raise TypeError("orders 字段不是数组")
    for idx, raw in enumerate(raw_orders):
        try:
            orders.append(ParsedOrder.model_validate(raw))
        except Exception as exc:  # noqa: BLE001 - 任何解析失败都降级为拒绝
            detail = _brief(exc)
            schema_errors.append("orders[%d]: %s" % (idx, detail))
            rejections.append(
                Rejection(
                    original_text=_excerpt(raw),
                    code="UNCLEAR",
                    message="解析结果未通过软件层结构校验,已拦截(orders[%d]):%s。请把指令写得更明确后重试。"
                    % (idx, detail),
                )
            )

    raw_rejections = payload.get("rejections") or []
    if not isinstance(raw_rejections, list):
        raise TypeError("rejections 字段不是数组")
    for idx, raw in enumerate(raw_rejections):
        try:
            rejections.append(Rejection.model_validate(raw))
        except Exception as exc:  # noqa: BLE001
            schema_errors.append("rejections[%d]: %s" % (idx, _brief(exc)))
            rejections.append(
                Rejection(
                    original_text=_excerpt(raw),
                    code="UNCLEAR",
                    message="模型给出的拒绝条目本身格式不合法,已按拒绝处理。",
                )
            )

    unknown_top = sorted(set(payload) - {"orders", "rejections"})
    if unknown_top:
        schema_errors.append("顶层多余字段已忽略: %s" % ", ".join(unknown_top))

    return LenientParseResult(orders=orders, rejections=rejections, schema_errors=schema_errors)


class LenientParseResult(Strict):
    orders: List[ParsedOrder] = Field(default_factory=list)
    rejections: List[Rejection] = Field(default_factory=list)
    schema_errors: List[str] = Field(default_factory=list)


def _brief(exc: Exception) -> str:
    text = str(exc).replace("\n", " ")
    return text[:300]


def _excerpt(raw: Any) -> str:
    if isinstance(raw, dict):
        for key in ("intent_summary", "original_text", "symbol"):
            if isinstance(raw.get(key), str) and raw[key]:
                return raw[key][:200]
    return str(raw)[:200]
