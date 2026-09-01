"""第二批高危修复的回归测试(docs/优化审计报告.md 的 C1/C5/C8)。

C1 组合单方向语义:BAG 一律 BUY + 带符号净价,贷方绝不能被 IBKR 反转腿。
C5 触发单幂等:fire_pending 先落闩,任何异常都不允许下一轮重发同一笔。
C8 事件管线:早到的回报缓冲重放;errorEvent 拒单落终态;重连自动重挂监听。
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

import pytest

from conftest import make_settings, spread_order, stock_order
from ibkr_agent.broker import (
    BrokerError,
    LegQuote,
    PlacementResult,
    auto_mid_limit,
    bag_signed_limit,
    combo_mid_price,
)
from ibkr_agent.engine import TradingEngine
from ibkr_agent.llm import LLMResponse
from ibkr_agent.notify import Notifier
from ibkr_agent.store import TradeStore


class _Parser:
    def __init__(self, payload: Dict[str, Any]):
        self.payload = payload

    def parse(self, bundle, user_message: str) -> LLMResponse:
        return LLMResponse(
            text=json.dumps(self.payload, ensure_ascii=False),
            model="m", prompt_version=bundle.version,
            prompt_fingerprint=bundle.fingerprint, latency_ms=1, usage={},
        )


class _NS:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def _engine(settings, payload, router):
    return TradingEngine(
        settings, parser=_Parser(payload), store=TradeStore(settings.db_path),
        notifier=Notifier(enabled=False), router=router,
    )


# ======================================================================
# C1 组合单方向语义
# ======================================================================
def test_bag_signed_limit_credit_is_negative_buy():
    assert bag_signed_limit("SELL", 12.0) == -12.0     # 卖出铁鹰收 12 → BUY @ -12
    assert bag_signed_limit("BUY", 8.0) == 8.0
    assert bag_signed_limit("SELL", None) is None


def test_credit_combo_mid_is_negative_and_prices_correctly():
    # 贷方垂直价差:买高卖低 → 净收权利金,带符号净价为负
    legs = [
        LegQuote("BUY", 1, bid=1.0, ask=1.2),    # 保护腿 mid 1.1
        LegQuote("SELL", 1, bid=5.0, ask=5.2),   # 收权腿 mid 5.1
    ]
    mid = combo_mid_price(legs)
    assert mid == pytest.approx(-4.0)
    # 让价朝 0:少收 0.1,限价 -3.9(BUY @ -3.9 = 净收至少 3.9)
    assert auto_mid_limit(mid, "SELL", 0.10) == pytest.approx(-3.90)


def test_conditional_credit_spread_fires_with_negative_signed_limit(settings, now):
    """修复前:贷方组合的负中间价被 auto_mid_limit(SELL) 当'非正'拒绝,
    或以 SELL 提交导致 IBKR 反转腿方向。现在必须以带符号负净价成功触发。"""

    class Router:
        def __init__(self):
            self.placed: List[Any] = []

        def index_price(self, symbol):
            return 7462.35

        def place(self, record_id, approved, limit_override=None):
            self.placed.append((record_id, limit_override))
            return PlacementResult(record_id=record_id, order_id=11, perm_id=22)

        def leg_quotes(self, contract, account):
            return [
                LegQuote("BUY", 1, bid=1.0, ask=1.2),
                LegQuote("SELL", 1, bid=5.0, ask=5.2),
            ]

        def cancel_all_open(self):
            return 0

    # 贷方 put 价差:SPX 跌破 7400 时卖出 7300/7350 put spread(买低卖高)
    order = spread_order(
        intent_summary="SPX 跌破 7400 时卖出 1 张 7300/7350 put 贷方价差",
        contract={
            "legs": [
                {"action": "BUY", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
                 "strike": 7300.0, "right": "P", "tradingClass": "SPXW"},
                {"action": "SELL", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
                 "strike": 7350.0, "right": "P", "tradingClass": "SPXW"},
            ],
        },
        trigger={"type": "PRICE", "symbol": "SPX", "secType": "IND", "operator": "<=",
                 "value": 7400.0},
        order={"action": "SELL"},
    )
    live = make_settings(
        policies={"auto_execute": True}, storage={"db_path": str(settings.db_path)}
    )
    router = Router()
    engine = _engine(live, {"orders": [order], "rejections": []}, router)
    result = engine.handle_instruction("spx跌破7400卖出put价差", moment=now)
    assert len(result.queued) == 1

    fired = engine.fire_pending({"SPX": 7399.0})
    assert len(fired) == 1
    assert fired[0]["limit"] == pytest.approx(-3.90)
    assert router.placed[0][1] == pytest.approx(-3.90)


# ======================================================================
# C5 触发单幂等
# ======================================================================
def test_unexpected_exception_during_fire_never_refires(settings, now):
    class ExplodingRouter:
        def __init__(self):
            self.attempts = 0

        def index_price(self, symbol):
            return 7462.35

        def place(self, record_id, approved, limit_override=None):
            self.attempts += 1
            raise ConnectionResetError("TWS 连接在 placeOrder 后断开")  # 非 BrokerError

        def leg_quotes(self, contract, account):
            return [LegQuote("BUY", 1, 12.0, 13.0), LegQuote("SELL", 1, 4.0, 5.0)]

        def cancel_all_open(self):
            return 0

    live = make_settings(
        policies={"auto_execute": True}, storage={"db_path": str(settings.db_path)}
    )
    router = ExplodingRouter()
    engine = _engine(live, {"orders": [spread_order()], "rejections": []}, router)
    result = engine.handle_instruction("spx到7500开一张 call spread", moment=now)
    record_id = result.queued[0]["record_id"]

    # 修复前:非 BrokerError 异常向上抛,fired 仍为 False,下一轮重发 → 重复下单
    engine.fire_pending({"SPX": 7501.0})
    assert router.attempts == 1
    assert engine.pending_triggers == []          # 已落闩出队
    engine.fire_pending({"SPX": 7502.0})          # 再触发一轮
    assert router.attempts == 1                   # 绝不重发

    record = engine.store.get_record(record_id)
    assert record["final_status"] == "ibkr_error"
    assert "核对" in (record["error_detail"] or "")


# ======================================================================
# C8 事件管线
# ======================================================================
def test_events_arriving_before_index_are_replayed(settings, now):
    """模拟 ib.sleep 期间事件先于 _index_placement 到达:回报不能丢。"""

    class RaceRouter:
        engine: Optional[TradingEngine] = None

        def index_price(self, symbol):
            return None

        def place(self, record_id, approved, limit_override=None):
            # placeOrder 之后、place() 返回之前,事件循环推来了极速成交回报
            trade = _NS(
                order=_NS(permId=7788, orderId=1024),
                orderStatus=_NS(status="Filled", filled=100, remaining=0),
                contract=_NS(symbol="AAPL"),
            )
            fill = _NS(
                execution=_NS(execId="e-race", time="t", price=229.5, shares=100,
                              side="BOT", acctNumber="DU7654321")
            )
            self.engine._on_order_status(trade)      # 此刻映射尚未建立
            self.engine._on_exec_details(trade, fill)
            return PlacementResult(record_id=record_id, order_id=1024, perm_id=7788)

        def cancel_all_open(self):
            return 0

    live = make_settings(
        policies={"auto_execute": True}, storage={"db_path": str(settings.db_path)}
    )
    router = RaceRouter()
    engine = _engine(live, {"orders": [stock_order()], "rejections": []}, router)
    router.engine = engine

    result = engine.handle_instruction("买入 AAPL 100股 limit 230", moment=now)
    record = engine.store.get_record(result.submitted[0]["record_id"])
    # 修复前:这两条回报被静默丢弃,记录永远停在 Submitted、无成交
    assert record["final_status"] == "filled"
    assert len(record["ibkr"]["fills"]) == 1
    assert record["ibkr"]["avg_fill_price"] == pytest.approx(229.5)


def test_error_event_finalizes_rejected_order(settings, now):
    class Router:
        def index_price(self, symbol):
            return None

        def place(self, record_id, approved, limit_override=None):
            return PlacementResult(record_id=record_id, order_id=1024, perm_id=7788)

        def cancel_all_open(self):
            return 0

    live = make_settings(
        policies={"auto_execute": True}, storage={"db_path": str(settings.db_path)}
    )
    engine = _engine(live, {"orders": [stock_order()], "rejections": []}, Router())
    result = engine.handle_instruction("买入 AAPL 100股 limit 230", moment=now)
    record_id = result.submitted[0]["record_id"]

    # 信息类代码(行情农场状态)不许当拒单
    engine._on_ib_error(1024, 2104, "Market data farm connection is OK")
    assert engine.store.get_record(record_id)["final_status"] is None

    # 订单级拒单(201 保证金不足)必须落终态——修复前无人监听 errorEvent
    engine._on_ib_error(1024, 201, "Order rejected - insufficient margin")
    record = engine.store.get_record(record_id)
    assert record["final_status"] == "ibkr_error"
    assert "201" in (record["error_detail"] or "")

    # 与别的 client 无关的 reqId 不落库
    engine._on_ib_error(999999, 201, "someone else's order")


def test_reconnected_session_is_rewired_automatically(settings):
    class _Event:
        def __init__(self):
            self.handlers = []

        def __iadd__(self, fn):
            self.handlers.append(fn)
            return self

    def fake_ib():
        return _NS(
            orderStatusEvent=_Event(), execDetailsEvent=_Event(),
            commissionReportEvent=_Event(), errorEvent=_Event(),
        )

    class Router:
        def __init__(self):
            self.session_hook = None
            self._sessions: List[Any] = [fake_ib()]

        def sessions(self):
            return self._sessions

        def simulate_reconnect(self):
            """TWS 重启:connect() 建了一条全新会话并调用 session_hook。"""
            ib = fake_ib()
            self._sessions = [ib]
            if self.session_hook:
                self.session_hook(ib)
            return ib

    router = Router()
    engine = TradingEngine(
        settings, parser=_Parser({"orders": [], "rejections": []}),
        store=TradeStore(settings.db_path), notifier=Notifier(enabled=False), router=router,
    )
    assert engine.attach_listeners() == 1
    old = router.sessions()[0]
    assert getattr(old, "_dafri_wired", False)

    new_ib = router.simulate_reconnect()
    # 修复前:新会话没有任何监听,重连后的成交回报全部进黑洞
    assert getattr(new_ib, "_dafri_wired", False)
    assert engine._on_order_status in new_ib.orderStatusEvent.handlers
    assert engine._on_ib_error in new_ib.errorEvent.handlers
    # 幂等:同一会话不重复挂
    assert engine._wire_session(new_ib) is False
    assert len(new_ib.orderStatusEvent.handlers) == 1
