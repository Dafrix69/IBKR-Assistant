"""第一批高危修复的回归测试(对应 docs/reports/code-audit-report.md 的 C3/C6/C7/C9/C10)。

每个测试名都写清楚它锁住的是哪个已修复的缺陷,防止回归。
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone

import pytest

from conftest import make_settings, option_order, stock_order
from ibkr_agent.broker import BrokerError, LegQuote, auto_mid_limit, combo_mid_price
from ibkr_agent.config import ET
from ibkr_agent.engine import TradingEngine
from ibkr_agent.killswitch import KillSwitch
from ibkr_agent.llm import LLMResponse
from ibkr_agent.models import parse_llm_payload
from ibkr_agent.notify import Notifier
from ibkr_agent.store import TradeStore
from ibkr_agent.validator import Validator


# ======================================================================
# C6 熔断计数:解析成功绝不能清掉券商失败的账
# ======================================================================
def test_parse_success_does_not_reset_broker_failure_count(tmp_path):
    switch = KillSwitch(tmp_path / "breaker.json", threshold=3)
    assert switch.record_failure("下单失败 1", kind="broker") is None
    assert switch.record_failure("下单失败 2", kind="broker") is None
    switch.record_success(kind="parse")  # 修复前:这里会把计数清零
    engaged = switch.record_failure("下单失败 3", kind="broker")
    assert engaged is not None and engaged.engaged
    assert switch.is_engaged()


def test_broker_success_resets_broker_count_and_parse_counts_separately(tmp_path):
    switch = KillSwitch(tmp_path / "breaker.json", threshold=3)
    switch.record_failure("x", kind="broker")
    switch.record_failure("x", kind="broker")
    switch.record_success(kind="broker")
    assert switch.state().consecutive_failures == 0
    # 解析失败自己累计,同样能触发熔断
    switch.record_failure("p", kind="parse")
    switch.record_failure("p", kind="parse")
    engaged = switch.record_failure("p", kind="parse")
    assert engaged is not None and engaged.engaged


def test_breaker_engages_across_instructions_when_every_placement_fails(settings, now):
    """端到端:每条指令解析都成功、下单都失败——3 条指令后必须熔断。

    修复前:每次解析成功都会清零计数器,这个场景永远不熔断。
    """

    class OkParser:
        def parse(self, bundle, user_message):
            payload = {"orders": [stock_order()], "rejections": []}
            return LLMResponse(
                text=json.dumps(payload, ensure_ascii=False),
                model="m", prompt_version=bundle.version,
                prompt_fingerprint=bundle.fingerprint, latency_ms=1, usage={},
            )

    class FailingRouter:
        def index_price(self, symbol):
            return None

        def place(self, record_id, approved, limit_override=None):
            raise BrokerError("模拟:IBKR 连续拒单")

        def cancel_all_open(self):
            return 0

    live = make_settings(
        policies={"auto_execute": True}, storage={"db_path": str(settings.db_path)}
    )
    engine = TradingEngine(
        live, parser=OkParser(), store=TradeStore(settings.db_path),
        notifier=Notifier(enabled=False), router=FailingRouter(),
    )
    for _ in range(3):
        engine.handle_instruction("买入 AAPL 100股 limit 230", moment=now)
    assert engine.killswitch.is_engaged()


# ======================================================================
# C7 批内熔断:熔断触发后,同一批剩余订单不能再发
# ======================================================================
def test_mid_batch_engagement_stops_remaining_orders(settings, now):
    class TwoOrderParser:
        def parse(self, bundle, user_message):
            payload = {
                "orders": [
                    stock_order(),
                    stock_order(
                        intent_summary="限价 500 买入 50 股 MSFT",
                        contract={"symbol": "MSFT"},
                        order={"totalQuantity": 50, "lmtPrice": 500.0},
                    ),
                ],
                "rejections": [],
            }
            return LLMResponse(
                text=json.dumps(payload, ensure_ascii=False),
                model="m", prompt_version=bundle.version,
                prompt_fingerprint=bundle.fingerprint, latency_ms=1, usage={},
            )

    class FirstFailsRouter:
        def __init__(self):
            self.attempts = 0

        def index_price(self, symbol):
            return None

        def place(self, record_id, approved, limit_override=None):
            self.attempts += 1
            raise BrokerError("模拟拒单")

        def cancel_all_open(self):
            return 0

    live = make_settings(
        policies={"auto_execute": True, "consecutive_failure_breaker": 1},
        storage={"db_path": str(settings.db_path)},
    )
    router = FirstFailsRouter()
    engine = TradingEngine(
        live, parser=TwoOrderParser(), store=TradeStore(settings.db_path),
        notifier=Notifier(enabled=False), router=router,
    )
    result = engine.handle_instruction("买入 AAPL 和 MSFT", moment=now)

    # 第一笔失败即熔断(threshold=1),第二笔绝不能再碰券商
    assert router.attempts == 1
    assert engine.killswitch.is_engaged()
    codes = [r["code"] for r in result.rejections]
    assert "IBKR_ERROR" in codes and "BREAKER_ENGAGED" in codes
    halted = [r for r in result.rejections if r["code"] == "BREAKER_ENGAGED"]
    record = engine.store.get_record(halted[0]["record_id"])
    assert record["final_status"] == "halted_by_breaker"


def test_fire_pending_is_blocked_while_breaker_engaged(settings, now):
    """C4 的熔断部分:条件单触发时必须复查熔断状态。"""
    from conftest import spread_order

    class OneSpreadParser:
        def parse(self, bundle, user_message):
            payload = {"orders": [spread_order()], "rejections": []}
            return LLMResponse(
                text=json.dumps(payload, ensure_ascii=False),
                model="m", prompt_version=bundle.version,
                prompt_fingerprint=bundle.fingerprint, latency_ms=1, usage={},
            )

    class QuoteRouter:
        def __init__(self):
            self.placed = []

        def index_price(self, symbol):
            return 7462.35

        def place(self, record_id, approved, limit_override=None):
            from ibkr_agent.broker import PlacementResult

            self.placed.append(record_id)
            return PlacementResult(record_id=record_id, order_id=1, perm_id=2)

        def leg_quotes(self, contract, account):
            return [LegQuote("BUY", 1, 12.0, 13.0), LegQuote("SELL", 1, 4.0, 5.0)]

        def cancel_all_open(self):
            return 0

    live = make_settings(
        policies={"auto_execute": True}, storage={"db_path": str(settings.db_path)}
    )
    router = QuoteRouter()
    engine = TradingEngine(
        live, parser=OneSpreadParser(), store=TradeStore(settings.db_path),
        notifier=Notifier(enabled=False), router=router,
    )
    engine.handle_instruction("spx到7500开一张 call spread", moment=now)
    assert len(engine.pending_triggers) == 1

    engine.killswitch.engage("手动暂停")
    assert engine.fire_pending({"SPX": 7501.0}) == []   # 修复前:这里会照样下单
    assert router.placed == []


# ======================================================================
# C9 去重时区:+08:00 机器上的记录必须能挡住美东时间下的重复单
# ======================================================================
def test_duplicate_window_survives_mixed_timezones(tmp_path):
    store = TradeStore(tmp_path / "t.db")
    now_et = datetime(2026, 8, 14, 10, 32, tzinfo=ET)

    record = {
        "input": {"raw_instruction": "买入 AAPL", "reason": "", "input_channel": "manual"},
        "llm": {"prompt_version": "v1"},
        "account": {"account_id": "DU7654321", "alias": "模拟", "is_paper": True},
        "contract": {"symbol": "AAPL", "secType": "STK"},
        "order": {"totalQuantity": 100, "action": "BUY"},
        "signature": "模拟|BUY|STK|AAPL",
        # 同一时刻的上海本机时间戳(UTC+8):10:32 ET == 22:32 +08:00
        "created_at": (now_et - timedelta(minutes=2)).astimezone(
            timezone(timedelta(hours=8))
        ).isoformat(),
    }
    store.append_event(store.create_record(record), "status", {"status": "Submitted"})

    recent = store.recent_orders(10, now_et)
    assert len(recent) == 1, "2 分钟前的 +08:00 记录必须落在 10 分钟窗口内(修复前为 0)"

    # 窗口外的旧记录不应出现
    old = {k: v for k, v in record.items() if k != "id"}
    old["created_at"] = (now_et - timedelta(hours=3)).astimezone(
        timezone(timedelta(hours=8))
    ).isoformat()
    store.append_event(store.create_record(old), "status", {"status": "Submitted"})
    assert len(store.recent_orders(10, now_et)) == 1


def test_store_now_iso_is_utc(tmp_path):
    store = TradeStore(tmp_path / "t.db")
    record_id = store.create_record(
        {
            "input": {"raw_instruction": "x", "reason": "", "input_channel": "manual"},
            "llm": {"prompt_version": "v1"},
            "account": {"account_id": "DU1", "alias": "模拟", "is_paper": True},
            "contract": {"symbol": "AAPL", "secType": "STK"},
            "order": {"totalQuantity": 1, "action": "BUY"},
            "signature": "s",
        }
    )
    row = store._conn.execute(
        "SELECT created_at FROM trade_records WHERE id=?", (record_id,)
    ).fetchone()
    parsed = datetime.fromisoformat(row["created_at"])
    assert parsed.utcoffset() == timedelta(0)


# ======================================================================
# C10 NaN 报价:必须在定价层就拦下,不能变成 lmtPrice=NaN 的废单
# ======================================================================
def test_nan_quotes_are_rejected_by_leg_mid():
    nan = float("nan")
    with pytest.raises(BrokerError, match="盘口不可用"):
        _ = LegQuote("BUY", 1, bid=nan, ask=13.0).mid
    with pytest.raises(BrokerError, match="盘口不可用"):
        _ = LegQuote("BUY", 1, bid=12.0, ask=nan).mid
    with pytest.raises(BrokerError, match="盘口不可用"):
        combo_mid_price([LegQuote("BUY", 1, bid=nan, ask=nan)])


def test_auto_mid_limit_rejects_non_finite_mid():
    for bad in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(BrokerError):
            auto_mid_limit(bad, "BUY", 0.10, strike_width=30.0)


def test_finite_quote_helper_neutralizes_nan():
    from ibkr_agent.broker import _clean_price, _finite_quote

    assert _finite_quote(float("nan")) == 0.0
    assert _finite_quote(None) == 0.0
    assert _finite_quote(12.5) == 12.5
    assert _clean_price(float("nan")) is None
    assert _clean_price(-1.0) is None
    assert _clean_price(101.5) == 101.5


# ======================================================================
# C3 裸卖期权:风险敞口不能按权利金计
# ======================================================================
def _validator(now, **limit_overrides):
    settings = make_settings(limits=limit_overrides) if limit_overrides else make_settings()
    return Validator(settings, now, snapshot={"NVDA": 178.0})


def test_naked_short_call_is_rejected(now):
    payload = {
        "orders": [
            option_order(
                intent_summary="卖出 2 张 NVDA call",
                order={"action": "SELL", "lmtPrice": 5.5},
            )
        ],
        "rejections": [],
    }
    parsed = parse_llm_payload(payload)
    outcome = _validator(now).validate_all(parsed.orders)
    assert not outcome.approved
    assert outcome.rejected[0].primary_code == "UNSUPPORTED"
    assert "无上限" in outcome.rejected[0].message()


def test_short_put_exposure_uses_strike_not_premium(now):
    # 180 行权价 × 100 × 3 张 = 54,000 > 50,000 上限 → 必须拦下
    # (修复前按权利金 5.5 × 100 × 3 = 1,650 计,轻松放行)
    payload = {
        "orders": [
            option_order(
                intent_summary="卖出 3 张 NVDA 180 put",
                contract={"right": "P"},
                order={"action": "SELL", "totalQuantity": 3, "lmtPrice": 5.5},
            )
        ],
        "rejections": [],
    }
    parsed = parse_llm_payload(payload)
    outcome = _validator(now).validate_all(parsed.orders)
    assert not outcome.approved
    assert outcome.rejected[0].primary_code == "EXCEEDS_LIMIT"


def test_small_cash_secured_put_still_passes(now):
    # 1 张 180 put:敞口 18,000 < 50,000 → 放行,且敞口按行权价口径记账
    payload = {
        "orders": [
            option_order(
                intent_summary="卖出 1 张 NVDA 180 put",
                contract={"right": "P"},
                order={"action": "SELL", "totalQuantity": 1, "lmtPrice": 5.5},
            )
        ],
        "rejections": [],
    }
    parsed = parse_llm_payload(payload)
    outcome = _validator(now).validate_all(parsed.orders)
    assert len(outcome.approved) == 1
    assert outcome.approved[0].notional == pytest.approx(18_000.0)


def test_long_option_premium_math_unchanged(now):
    payload = {"orders": [option_order()], "rejections": []}
    parsed = parse_llm_payload(payload)
    outcome = _validator(now).validate_all(parsed.orders)
    assert len(outcome.approved) == 1
    assert outcome.approved[0].notional == pytest.approx(2 * 100 * 5.5)
