"""leg_quotes:各腿并行订阅、用完即撤、接住行情类错误码。

2026-09-04 纸面账户实测的事故:一天反复解析几十次,每次 3 条腿的 reqMktData 都没撤,
行情线路配额漏光后 TWS 对新请求回 101,所有腿永远 NaN;界面只剩"盘口不可用",
且每次解析要等满 3 × 4 秒。这里把三件事都钉死。
"""
from __future__ import annotations

import math
from types import SimpleNamespace
from typing import Any, Dict, List

import pytest

from ibkr_agent import broker as broker_mod
from ibkr_agent.broker import BrokerError, BrokerRouter


class _Event:
    def __init__(self):
        self.handlers: List[Any] = []

    def __iadd__(self, fn):
        self.handlers.append(fn)
        return self

    def __isub__(self, fn):
        self.handlers.remove(fn)
        return self

    def emit(self, *args):
        for fn in list(self.handlers):
            fn(*args)


class _Ticker:
    def __init__(self):
        self.bid = math.nan
        self.ask = math.nan


class FakeIB:
    """tick 在第 `arrive_after` 次 sleep 之后到;`error_on_sleep` 指定在哪次 sleep 里回错误码。"""

    def __init__(self, arrive_after: Dict[str, int], error_on_sleep=None):
        self.arrive_after = arrive_after
        self.error_on_sleep = error_on_sleep   # (第几次 sleep, code, message)
        self.errorEvent = _Event()
        self.tickers: Dict[str, _Ticker] = {}
        self.subscribed: List[str] = []
        self.cancelled: List[str] = []
        self.market_data_types: List[int] = []
        self.sleeps = 0

    def reqMarketDataType(self, kind):
        self.market_data_types.append(kind)

    def reqMktData(self, opt, *_):
        self.subscribed.append(opt.key)
        t = _Ticker()
        self.tickers[opt.key] = t
        return t

    def cancelMktData(self, opt):
        self.cancelled.append(opt.key)

    def sleep(self, _secs):
        self.sleeps += 1
        for key, t in self.tickers.items():
            n = self.arrive_after.get(key)
            if n is not None and self.sleeps >= n:
                t.bid, t.ask = 1.0, 1.2
        if self.error_on_sleep and self.sleeps == self.error_on_sleep[0]:
            _, code, msg = self.error_on_sleep
            self.errorEvent.emit(7, code, msg, None)


class _Option:
    def __init__(self, symbol, expiry, strike, right, exchange, currency="USD", multiplier="100", tradingClass=""):
        self.symbol, self.strike, self.right = symbol, strike, right
        self.lastTradeDateOrContractMonth = expiry
        self.exchange, self.currency, self.multiplier, self.tradingClass = exchange, currency, multiplier, tradingClass
        self.conId = 0

    @property
    def key(self):
        return "%s|%s|%s" % (self.symbol, self.strike, self.right)


def _contract():
    leg = lambda strike, right, action: SimpleNamespace(  # noqa: E731
        lastTradeDateOrContractMonth="20260904", strike=strike, right=right,
        multiplier="100", tradingClass="SPXW", action=action, ratio=1,
    )
    return SimpleNamespace(
        symbol="SPX", exchange="SMART", currency="USD",
        legs=[leg(7680, "P", "BUY"), leg(7700, "P", "SELL"), leg(7720, "P", "BUY")],
    )


def _router(monkeypatch, ib: FakeIB, paper=True):
    router = BrokerRouter.__new__(BrokerRouter)
    router._conid_cache = {}
    router._upstream_ok = True
    monkeypatch.setattr(router, "for_account", lambda account: ib)
    monkeypatch.setattr(router, "_qualify_batch_or_raise", lambda ib_, contracts: [setattr(c, "conId", 1) for c in contracts])
    monkeypatch.setattr(broker_mod, "_ib", lambda: SimpleNamespace(Option=_Option))
    account = SimpleNamespace(account_id="DU1", is_paper=paper)
    return router, account


def test_legs_are_subscribed_together_and_cancelled(monkeypatch):
    # 三条腿分别在第 1 / 2 / 2 次轮询到齐:并行只要 2 次 sleep;串行(旧实现)要 1+2+2=5 次
    ib = FakeIB({"SPX|7680|P": 1, "SPX|7700|P": 2, "SPX|7720|P": 2})
    router, account = _router(monkeypatch, ib)

    quotes = router.leg_quotes(_contract(), account)

    assert [(q.action, q.bid, q.ask) for q in quotes] == [("BUY", 1.0, 1.2), ("SELL", 1.0, 1.2), ("BUY", 1.0, 1.2)]
    assert ib.sleeps == 2
    assert ib.subscribed == ["SPX|7680|P", "SPX|7700|P", "SPX|7720|P"]
    assert sorted(ib.cancelled) == sorted(ib.subscribed), "每条订阅都必须撤掉,否则漏线路"
    assert ib.market_data_types == [3, 1]
    assert ib.errorEvent.handlers == [], "临时错误监听用完要摘掉"


def test_wait_cap_is_total_not_per_leg(monkeypatch):
    ib = FakeIB({})   # 永远不来
    router, account = _router(monkeypatch, ib)

    quotes = router.leg_quotes(_contract(), account)

    assert ib.sleeps == int(BrokerRouter._QUOTE_WAIT / 0.25) == 16, "三腿合计 4 秒,不是 12 秒"
    assert all(q.bid == 0.0 and q.ask == 0.0 for q in quotes), "没错误码时仍交给守卫拦"
    assert sorted(ib.cancelled) == sorted(ib.subscribed)


def test_error_101_is_translated(monkeypatch):
    ib = FakeIB({}, error_on_sleep=(2, 101, "Max number of tickers has been reached"))
    router, account = _router(monkeypatch, ib)

    with pytest.raises(BrokerError) as exc:
        router.leg_quotes(_contract(), account)

    text = str(exc.value)
    assert "行情线路已用完" in text and "101" in text and "断开 TWS" in text
    assert sorted(ib.cancelled) == sorted(ib.subscribed)
    assert ib.market_data_types == [3, 1]


def test_subscription_error_is_translated(monkeypatch):
    ib = FakeIB({}, error_on_sleep=(1, 10167, "Requested market data is not subscribed"))
    router, account = _router(monkeypatch, ib)

    with pytest.raises(BrokerError) as exc:
        router.leg_quotes(_contract(), account)
    assert "没有 SPX 的行情订阅" in str(exc.value) and "10167" in str(exc.value)


def test_error_with_complete_quotes_is_ignored(monkeypatch):
    # 报价齐了就不该因为顺带收到的错误码拒单
    ib = FakeIB({"SPX|7680|P": 1, "SPX|7700|P": 1, "SPX|7720|P": 1},
                error_on_sleep=(1, 10167, "partly not subscribed"))
    router, account = _router(monkeypatch, ib)
    quotes = router.leg_quotes(_contract(), account)
    assert all(q.bid > 0 for q in quotes)


def test_unrelated_error_codes_do_not_change_behaviour(monkeypatch):
    ib = FakeIB({}, error_on_sleep=(1, 2104, "Market data farm connection is OK"))
    router, account = _router(monkeypatch, ib)
    quotes = router.leg_quotes(_contract(), account)
    assert all(q.bid == 0.0 for q in quotes)


def test_live_account_never_switches_to_delayed(monkeypatch):
    ib = FakeIB({"SPX|7680|P": 1, "SPX|7700|P": 1, "SPX|7720|P": 1})
    router, account = _router(monkeypatch, ib, paper=False)
    router.leg_quotes(_contract(), account)
    assert ib.market_data_types == []


def test_qualify_failure_still_restores_state(monkeypatch):
    ib = FakeIB({})
    router, account = _router(monkeypatch, ib)

    def boom(ib_, contracts):
        raise BrokerError("IBKR 无法确认该合约")

    monkeypatch.setattr(router, "_qualify_batch_or_raise", boom)
    with pytest.raises(BrokerError):
        router.leg_quotes(_contract(), account)
    assert ib.subscribed == [] and ib.cancelled == []
    assert ib.market_data_types == [3, 1]
    assert ib.errorEvent.handlers == []


def test_conid_cache_skips_qualified_legs(monkeypatch):
    ib = FakeIB({"SPX|7680|P": 1, "SPX|7700|P": 1, "SPX|7720|P": 1})
    router, account = _router(monkeypatch, ib)
    asked: List[int] = []
    def qualify(ib_, contracts):   # 和真实现一样:确认后写 conId 缓存
        asked.append(len(contracts))
        for c in contracts:
            c.conId = 9
            router._conid_cache[router._conid_key(c)] = 9

    monkeypatch.setattr(router, "_qualify_batch_or_raise", qualify)
    router.leg_quotes(_contract(), account)
    assert asked == [3], "第一次三条腿一次往返"
    router.leg_quotes(_contract(), account)
    assert asked == [3], "第二次全部命中 conId 缓存,不再问 TWS"
