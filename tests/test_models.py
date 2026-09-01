"""schema 层(§5.1):结构不对就不该往下走。"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from conftest import butterfly_order, condor_order, option_order, spread_order, stock_order
from ibkr_agent.models import ParsedOrder, parse_llm_payload


def test_valid_orders_parse():
    for payload in (stock_order(), option_order(), spread_order()):
        ParsedOrder.model_validate(payload)


def test_limit_order_without_price_is_rejected():
    with pytest.raises(ValidationError, match="限价单缺少 lmtPrice"):
        ParsedOrder.model_validate(stock_order(order={"lmtPrice": None}))


def test_market_order_must_not_carry_limit_price():
    with pytest.raises(ValidationError, match="市价单不得带 lmtPrice"):
        ParsedOrder.model_validate(stock_order(order={"orderType": "MKT", "lmtPrice": 230.0}))


def test_auto_mid_only_allowed_for_spreads():
    """铁律 3 的唯一例外只给期权组合;股票和单腿期权缺价必须硬拒。"""
    with pytest.raises(ValidationError, match="AUTO_MID 仅适用于期权组合"):
        ParsedOrder.model_validate(
            stock_order(order={"price_mode": "AUTO_MID", "lmtPrice": None})
        )
    with pytest.raises(ValidationError, match="AUTO_MID 仅适用于期权组合"):
        ParsedOrder.model_validate(
            option_order(order={"price_mode": "AUTO_MID", "lmtPrice": None})
        )


def test_execution_type_must_match_trigger():
    with pytest.raises(ValidationError, match="CONDITIONAL 订单缺少 trigger"):
        ParsedOrder.model_validate(stock_order(execution_type="CONDITIONAL"))
    with pytest.raises(ValidationError, match="IMMEDIATE 订单不得带 trigger"):
        ParsedOrder.model_validate(
            stock_order(
                trigger={"type": "PRICE", "symbol": "SPX", "secType": "IND",
                         "operator": ">=", "value": 7500.0}
            )
        )


def test_option_requires_all_four_elements():
    with pytest.raises(ValidationError, match="期权四要素缺失"):
        ParsedOrder.model_validate(option_order(contract={"strike": None}))


def test_stock_must_not_carry_option_fields():
    with pytest.raises(ValidationError, match="STK 合约不得携带期权/组合字段"):
        ParsedOrder.model_validate(stock_order(contract={"strike": 230.0}))


def test_butterfly_and_condor_leg_counts_are_enforced():
    payload = butterfly_order()
    payload["contract"]["legs"] = payload["contract"]["legs"][:2]
    with pytest.raises(ValidationError, match="BUTTERFLY 必须正好 3 条腿"):
        ParsedOrder.model_validate(payload)

    payload = condor_order()
    payload["contract"]["legs"] = payload["contract"]["legs"][:3]
    with pytest.raises(ValidationError, match="IRON_CONDOR 必须正好 4 条腿"):
        ParsedOrder.model_validate(payload)


def test_unknown_combo_strategy_is_rejected():
    payload = spread_order()
    payload["contract"]["combo_strategy"] = "CALENDAR"
    with pytest.raises(ValidationError):
        ParsedOrder.model_validate(payload)


def test_leg_ratio_above_two_is_rejected():
    payload = butterfly_order()
    payload["contract"]["legs"][1]["ratio"] = 3
    with pytest.raises(ValidationError):
        ParsedOrder.model_validate(payload)


def test_extra_fields_are_forbidden():
    with pytest.raises(ValidationError):
        ParsedOrder.model_validate(stock_order(surprise="hello"))


def test_impossible_expiry_date_rejected():
    with pytest.raises(ValidationError, match="不是合法日期"):
        ParsedOrder.model_validate(option_order(contract={"lastTradeDateOrContractMonth": "20260231"}))


def test_trail_needs_exactly_one_of_aux_or_percent():
    with pytest.raises(ValidationError, match="TRAIL 必须且只能给"):
        ParsedOrder.model_validate(
            stock_order(order={"orderType": "TRAIL", "action": "SELL", "lmtPrice": None})
        )
    ParsedOrder.model_validate(
        stock_order(
            order={"orderType": "TRAIL", "action": "SELL", "lmtPrice": None, "trailingPercent": 5.0}
        )
    )


def test_bad_order_degrades_to_rejection_without_killing_the_batch():
    """一条输入里坏掉一单,不能连累其他可执行订单(§2 一)。"""
    payload = {
        "orders": [stock_order(), stock_order(order={"lmtPrice": None})],
        "rejections": [],
    }
    result = parse_llm_payload(payload)
    assert len(result.orders) == 1
    assert len(result.rejections) == 1
    assert result.rejections[0].code == "UNCLEAR"
    assert "orders[1]" in result.schema_errors[0]


def test_unknown_top_level_fields_are_reported():
    result = parse_llm_payload({"orders": [], "rejections": [], "note": "ignore me"})
    assert any("note" in err for err in result.schema_errors)
