"""硬校验层(§5)。这是"错了会亏钱"的路径,覆盖要比别处密。"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from conftest import make_settings, option_order, spread_order, stock_order
from ibkr_agent.config import ET
from ibkr_agent.models import ParsedOrder
from ibkr_agent.validator import RecentOrder, Validator, order_signature


def run(settings, now, payload, snapshot=None, recent=None):
    order = ParsedOrder.model_validate(payload)
    validator = Validator(settings, now, snapshot=snapshot, recent_orders=recent)
    return validator.validate_one(order)


def codes(issues):
    return [i.code for i in issues]


# ---- 置信度与账户 -------------------------------------------------------
def test_low_confidence_is_rejected_even_when_llm_approved(settings, now):
    issues, approved = run(settings, now, stock_order(confidence=0.89))
    assert approved is None
    assert "LOW_CONFIDENCE" in codes(issues)


def test_unknown_account_alias_rejected_with_available_list(settings, now):
    issues, approved = run(settings, now, stock_order(account="我儿子的账户"))
    assert approved is None
    assert "UNKNOWN_ACCOUNT" in codes(issues)
    assert "模拟" in issues[0].message


def test_default_alias_maps_to_default_account(settings, now):
    issues, approved = run(settings, now, stock_order())
    assert issues == []
    assert approved.account.alias == "模拟"
    assert approved.account_id == "DU7654321"


def test_live_account_blocked_until_explicitly_enabled(settings, now):
    issues, approved = run(settings, now, stock_order(account="主账户"))
    assert approved is None
    assert "LIVE_TRADING_DISABLED" in codes(issues)

    live_ok = make_settings(policies={"allow_live_trading": True})
    issues, approved = run(live_ok, now, stock_order(account="主账户"))
    assert issues == []
    assert approved.account.account_id == "U1234567"


# ---- 限额复算 -----------------------------------------------------------
def test_stock_notional_recomputed_and_capped(settings, now):
    tight = make_settings(limits={"max_order_notional": 1_000.0})
    issues, _ = run(tight, now, stock_order())  # 100 × 230 = 23,000
    assert "EXCEEDS_LIMIT" in codes(issues)
    assert "23000" in issues[0].message.replace(".00", "")


def test_option_notional_uses_multiplier(settings, now):
    tight = make_settings(limits={"max_order_notional": 1_000.0})
    issues, _ = run(tight, now, option_order())  # 2 × 100 × 5.5 = 1,100
    assert "EXCEEDS_LIMIT" in codes(issues)


def test_spread_notional_is_max_loss_not_premium(settings, now):
    """价差风险按行权价差算:1 × 100 × 30 = 3,000。"""
    _, approved = run(settings, now, spread_order(), snapshot={"SPX": 7462.35})
    assert approved.notional == pytest.approx(3_000.0)

    tight = make_settings(limits={"max_order_notional": 2_500.0})
    issues, _ = run(tight, now, spread_order(), snapshot={"SPX": 7462.35})
    assert "EXCEEDS_LIMIT" in codes(issues)


def test_option_contract_count_limit(settings, now):
    issues, _ = run(settings, now, option_order(order={"totalQuantity": 11}))
    assert "EXCEEDS_LIMIT" in codes(issues)


def test_unpriceable_market_option_is_rejected(settings, now):
    issues, _ = run(settings, now, option_order(order={"orderType": "MKT", "lmtPrice": None}))
    assert "UNPRICEABLE" in codes(issues)


def test_market_stock_without_reference_price_falls_back_to_share_cap(settings, now):
    payload = stock_order(order={"orderType": "MKT", "lmtPrice": None, "totalQuantity": 20})
    issues, approved = run(settings, now, payload)
    assert issues == []
    assert approved.notional == 0.0

    payload = stock_order(order={"orderType": "MKT", "lmtPrice": None, "totalQuantity": 500})
    issues, _ = run(settings, now, payload)
    assert "EXCEEDS_LIMIT" in codes(issues)


def test_market_stock_uses_snapshot_when_available(settings, now):
    payload = stock_order(order={"orderType": "MKT", "lmtPrice": None, "totalQuantity": 100})
    _, approved = run(settings, now, payload, snapshot={"AAPL": 230.0})
    assert approved.notional == pytest.approx(23_000.0)


def test_batch_size_cap(settings, now):
    orders = [ParsedOrder.model_validate(stock_order()) for _ in range(7)]
    # 让签名各不相同,避免被防抖规则先拦下
    for idx, order in enumerate(orders):
        order.order.totalQuantity = 10 + idx * 50
    outcome = Validator(settings, now).validate_all(orders)
    assert len(outcome.approved) == 5
    assert len(outcome.rejected) == 2
    assert outcome.rejected[0].primary_code == "EXCEEDS_LIMIT"


# ---- 价差结构 -----------------------------------------------------------
def test_spread_direction_recheck_catches_inverted_legs(settings, now):
    bad = spread_order()
    bad["contract"]["legs"][0]["strike"] = 7550.0  # 买高
    bad["contract"]["legs"][1]["strike"] = 7520.0  # 卖低 → 不是借方 call spread
    issues, _ = run(settings, now, bad, snapshot={"SPX": 7462.35})
    assert "BAD_SPREAD" in codes(issues)


def test_debit_put_spread_direction_is_buy_high_sell_low(settings, now):
    payload = spread_order()
    for leg in payload["contract"]["legs"]:
        leg["right"] = "P"
    payload["contract"]["legs"][0]["strike"] = 7550.0
    payload["contract"]["legs"][1]["strike"] = 7520.0
    payload["trigger"]["operator"] = "<="
    payload["trigger"]["value"] = 7400.0
    issues, _ = run(settings, now, payload, snapshot={"SPX": 7462.35})
    assert issues == []


def test_spread_legs_must_share_expiry(settings, now):
    payload = spread_order()
    payload["contract"]["legs"][1]["lastTradeDateOrContractMonth"] = "20260821"
    issues, _ = run(settings, now, payload, snapshot={"SPX": 7462.35})
    assert "BAD_SPREAD" in codes(issues)


def test_debit_premium_cannot_exceed_strike_width(settings, now):
    payload = spread_order(order={"price_mode": "EXPLICIT", "lmtPrice": 45.0})
    issues, _ = run(settings, now, payload, snapshot={"SPX": 7462.35})
    assert "BAD_SPREAD" in codes(issues)
    assert "行权价差" in issues[0].message


# ---- 触发条件 -----------------------------------------------------------
def test_trigger_direction_mismatch_is_caught(settings, now):
    payload = spread_order(trigger={"operator": "<="})  # 现价低于触发价却写成向下
    issues, _ = run(settings, now, payload, snapshot={"SPX": 7462.35})
    assert "TRIGGER_MISMATCH" in codes(issues)


def test_trigger_without_snapshot_rejected_by_policy(settings, now):
    issues, _ = run(settings, now, spread_order())
    assert "AMBIGUOUS_TRIGGER" in codes(issues)

    lenient = make_settings(policies={"require_trigger_price_verification": False})
    issues, approved = run(lenient, now, spread_order())
    assert issues == []
    assert any("未取得 SPX 现价" in w for w in approved.warnings)


def test_trigger_too_close_to_spot_is_ambiguous(settings, now):
    issues, _ = run(settings, now, spread_order(), snapshot={"SPX": 7499.9})
    assert "AMBIGUOUS_TRIGGER" in codes(issues)


def test_confirmed_trigger_direction_adds_audit_warning(settings, now):
    _, approved = run(settings, now, spread_order(), snapshot={"SPX": 7462.35})
    assert any("已复核" in w for w in approved.warnings)


# ---- 合约与日历 ---------------------------------------------------------
def test_expired_contract_rejected(settings, now):
    issues, _ = run(settings, now, option_order(contract={"lastTradeDateOrContractMonth": "20260810"}))
    assert "EXPIRED_CONTRACT" in codes(issues)


def test_non_trading_day_expiry_rejected(settings, now):
    # 2026-09-07 在配置里是休市日
    issues, _ = run(settings, now, option_order(contract={"lastTradeDateOrContractMonth": "20260907"}))
    assert "EXPIRED_CONTRACT" in codes(issues)


def test_index_trading_class_corrected_by_expiry(settings, now):
    """0DTE 的 SPX 必须是 SPXW;模型给错要在软件层纠正并留 warning(§8.3)。"""
    payload = spread_order()
    for leg in payload["contract"]["legs"]:
        leg["tradingClass"] = "SPX"
    issues, approved = run(settings, now, payload, snapshot={"SPX": 7462.35})
    assert issues == []
    assert all(leg.tradingClass == "SPXW" for leg in approved.order.contract.legs)
    assert any("tradingClass" in w for w in approved.warnings)


def test_third_friday_keeps_monthly_class(settings, now):
    payload = spread_order()
    for leg in payload["contract"]["legs"]:
        leg["lastTradeDateOrContractMonth"] = "20260918"  # 2026-09-18 是第三个周五
        leg["tradingClass"] = "SPX"
    _, approved = run(settings, now, payload, snapshot={"SPX": 7462.35})
    assert all(leg.tradingClass == "SPX" for leg in approved.order.contract.legs)


# ---- 交易时段 -----------------------------------------------------------
def test_market_order_rejected_when_closed(settings):
    closed = datetime(2026, 8, 15, 12, 0, tzinfo=ET)  # 周六
    payload = stock_order(order={"orderType": "MKT", "lmtPrice": None})
    issues, _ = run(settings, closed, payload)
    assert "MARKET_CLOSED" in codes(issues)


def test_limit_order_allowed_when_closed_with_warning(settings):
    closed = datetime(2026, 8, 15, 12, 0, tzinfo=ET)
    issues, approved = run(settings, closed, stock_order())
    assert issues == []
    assert any("休市" in w for w in approved.warnings)


def test_premarket_without_outside_rth_warns(settings):
    premarket = datetime(2026, 8, 14, 8, 0, tzinfo=ET)
    _, approved = run(settings, premarket, stock_order())
    assert any("盘前" in w for w in approved.warnings)


# ---- 防抖 ---------------------------------------------------------------
def test_duplicate_within_window_is_blocked(settings, now):
    payload = stock_order()
    signature = order_signature(ParsedOrder.model_validate(payload), "DEFAULT")
    recent = [RecentOrder(signature, 100.0, now - timedelta(minutes=3))]
    issues, _ = run(settings, now, payload, recent=recent)
    assert "DUPLICATE_ORDER" in codes(issues)


def test_duplicate_outside_window_is_allowed(settings, now):
    payload = stock_order()
    signature = order_signature(ParsedOrder.model_validate(payload), "DEFAULT")
    recent = [RecentOrder(signature, 100.0, now - timedelta(minutes=30))]
    issues, _ = run(settings, now, payload, recent=recent)
    assert issues == []


def test_duplicate_in_same_batch_is_blocked(settings, now):
    orders = [ParsedOrder.model_validate(stock_order()) for _ in range(2)]
    outcome = Validator(settings, now).validate_all(orders)
    assert len(outcome.approved) == 1
    assert outcome.rejected[0].primary_code == "DUPLICATE_ORDER"


def test_signature_distinguishes_direction_and_contract():
    buy = ParsedOrder.model_validate(stock_order())
    sell = ParsedOrder.model_validate(stock_order(order={"action": "SELL"}))
    assert order_signature(buy, "模拟") != order_signature(sell, "模拟")
    assert order_signature(buy, "模拟") != order_signature(buy, "主账户")


# ---- 其他 ---------------------------------------------------------------
def test_missing_reason_warns_but_does_not_block(settings, now):
    issues, approved = run(settings, now, stock_order(reason=""))
    assert issues == []
    assert any("未提供操作原因" in w for w in approved.warnings)
