"""宏观行情带与订单簿流动性指标。全部离线,不打外网。"""
from __future__ import annotations

import json
import time

import pytest

from ibkr_agent import macro
from ibkr_agent.broker import book_liquidity


# ---- 订单簿流动性 --------------------------------------------------------
def test_liquidity_grades_spread_and_depth():
    book = {
        "l1": {"bid": 100.0, "ask": 100.02, "spread": 0.02, "spread_bps": 2.0},
        "bids": [{"price": 100.0, "size": 300}, {"price": 99.99, "size": 200}],
        "asks": [{"price": 100.02, "size": 100}],
    }
    liq = book_liquidity(book)
    assert liq["spread_grade"] == "很好"
    assert liq["bid_depth"] == 500 and liq["ask_depth"] == 100
    assert liq["levels"] == 2
    assert liq["imbalance_pct"] == pytest.approx(66.7, abs=0.1)   # 买盘明显更厚


def test_liquidity_grade_thresholds():
    def grade(bps):
        return book_liquidity({"l1": {"spread_bps": bps}})["spread_grade"]

    assert grade(3) == "很好"
    assert grade(15) == "尚可"
    assert grade(40) == "偏宽"
    assert grade(200) == "很宽"


def test_liquidity_falls_back_to_l1_sizes_without_depth():
    liq = book_liquidity({"l1": {"bid_size": 100, "ask_size": 300}, "bids": [], "asks": []})
    assert liq["imbalance_pct"] == pytest.approx(-50.0)   # 卖盘厚
    assert liq["l1_only"] is True


def test_liquidity_is_empty_without_any_quote():
    assert book_liquidity({"l1": {}, "bids": [], "asks": []}) == {}


# ---- 宏观行情带 ----------------------------------------------------------
def _fake_payload(price, prev):
    return json.dumps(
        {"chart": {"result": [{"meta": {"regularMarketPrice": price, "chartPreviousClose": prev}}]}}
    ).encode("utf-8")


class _FakeResponse:
    def __init__(self, body):
        self.body = body

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _FakeRouter:
    """只实现 macro 用到的两个方法。quotes 决定哪些 ETF「有实时权限」。"""

    def __init__(self, quotes):
        self.quotes = quotes
        self.asked = None

    def sessions(self):
        return ["session"]

    def stream_quotes(self, symbols):
        self.asked = list(symbols)
        return {s: q for s, q in self.quotes.items() if s in symbols}


def test_macro_board_parses_and_caches(monkeypatch):
    macro._CACHE.clear()
    calls = {"n": 0}

    def fake_urlopen(request, timeout=None):
        calls["n"] += 1
        return _FakeResponse(_fake_payload(100.0, 80.0))

    monkeypatch.setattr(macro.urllib.request, "urlopen", fake_urlopen)
    board = macro.macro_board()
    assert len(board["rows"]) == len(macro.MACRO_SYMBOLS)
    assert board["rows"][0]["last"] == 100.0
    assert board["rows"][0]["change_pct"] == pytest.approx(25.0)
    assert all(r["source"] == "public" for r in board["rows"])   # 没 router 就全走公开源

    first_calls = calls["n"]
    again = macro.macro_board()
    assert all(r.get("cached") for r in again["rows"])
    assert calls["n"] == first_calls                              # 60 秒内不重复请求


def test_macro_board_keeps_last_good_data_when_offline(monkeypatch):
    macro._CACHE.clear()
    monkeypatch.setattr(
        macro.urllib.request, "urlopen", lambda *a, **k: _FakeResponse(_fake_payload(50.0, 50.0))
    )
    macro.macro_board(force=True)

    def boom(*args, **kwargs):
        raise OSError("network unreachable")

    monkeypatch.setattr(macro.urllib.request, "urlopen", boom)
    board = macro.macro_board(force=True)
    # 断网时保留上次数据并逐格标记陈旧,而不是整条闪成「—」
    assert all(r.get("stale") is True for r in board["rows"])
    assert board["rows"][0]["last"] == 50.0


def test_macro_board_prefers_tws_and_falls_back_per_row(monkeypatch):
    """混合来源:有实时权限的走流式,没权限的那格单独回落公开源。"""
    macro._CACHE.clear()
    monkeypatch.setattr(
        macro.urllib.request, "urlopen", lambda *a, **k: _FakeResponse(_fake_payload(7.0, 7.0))
    )
    router = _FakeRouter({"SPY": {"last": 660.1, "close": 655.0, "change_pct": 0.78}})
    board = macro.macro_board(router=router, force=True)

    rows = {r["label"]: r for r in board["rows"]}
    assert rows["标普500"]["source"] == "tws"
    assert rows["标普500"]["instrument"] == "SPY"      # 读的是 ETF,必须标出来
    assert rows["标普500"]["last"] == 660.1
    assert rows["纳指100"]["source"] == "public"       # QQQ 没给报价 → 单独回落
    assert board["live_count"] == 1


def test_vix_and_10y_never_get_an_etf_stand_in():
    """VIXY 有 contango 损耗、TLT 与收益率反向 —— 这两格永远不许换 ETF。"""
    by_key = {s["key"]: s for s in macro.MACRO_SYMBOLS}
    assert by_key["^VIX"]["live"] is None
    assert by_key["^TNX"]["live"] is None
    assert "VIXY" not in macro.live_tickers() and "TLT" not in macro.live_tickers()


def test_macro_symbols_are_fixed_public_codes():
    """出网清单写死在软件里,界面无法注入任意符号。"""
    keys = {s["key"] for s in macro.MACRO_SYMBOLS}
    assert {"^TNX", "GC=F", "CL=F", "^VIX"} <= keys
    assert all(s["fmt"] in ("price", "pct", "plain") for s in macro.MACRO_SYMBOLS)


def test_macro_board_serves_stale_and_refreshes_in_background(monkeypatch):
    """周期轮询过期时旧值先给、后台刷新:公开源再慢也不能挡住引擎主循环——
    否则用户的「解析并校验」会排在行情带后面,毫秒级解析看起来要十几秒。"""
    import threading

    macro._CACHE.clear()
    gate = threading.Event()
    calls = {"n": 0}

    def fake_urlopen(request, timeout=None):
        calls["n"] += 1
        if calls["n"] > len(macro.MACRO_SYMBOLS):
            gate.wait(5.0)             # 第二轮请求故意挂住:主循环若等它,测试会卡住
            return _FakeResponse(_fake_payload(43.0, 41.0))
        return _FakeResponse(_fake_payload(42.0, 41.0))

    monkeypatch.setattr(macro.urllib.request, "urlopen", fake_urlopen)
    macro.macro_board()
    # 把缓存整体拨到"过期但没老到没用"
    for hit in macro._CACHE.values():
        hit["at"] -= macro._TTL_IDLE + 5

    second = macro.macro_board()
    assert second["rows"][0]["last"] == 42.0            # 旧值立刻返回
    assert second["rows"][0].get("refreshing") is True
    # 等后台线程都跑到挂住的那一步,再验证单飞:再打一次不会起第二批后台请求
    deadline = time.time() + 5.0
    while time.time() < deadline and calls["n"] < len(macro.MACRO_SYMBOLS) * 2:
        time.sleep(0.01)
    macro.macro_board()
    assert calls["n"] == len(macro.MACRO_SYMBOLS) * 2

    gate.set()
    deadline = time.time() + 5.0
    while time.time() < deadline and macro._INFLIGHT:
        time.sleep(0.01)
    third = macro.macro_board()
    assert third["rows"][0]["last"] == 43.0             # 后台取回的新值落到缓存


def test_public_index_price_serves_stale_and_refreshes_in_background(monkeypatch):
    macro._CACHE.clear()
    macro._CACHE["cboe:SPX"] = {"at": time.time() - 60.0, "row": {"last": 7600.0}}
    seen = {"n": 0}

    def slow(*args, **kwargs):
        seen["n"] += 1
        raise OSError("慢到超时")

    monkeypatch.setattr(macro.urllib.request, "urlopen", slow)
    t0 = time.perf_counter()
    assert macro.public_index_price("SPX") == 7600.0   # 60 秒前的旧值先给
    assert time.perf_counter() - t0 < 0.5
    deadline = time.time() + 5.0
    while time.time() < deadline and macro._INFLIGHT:
        time.sleep(0.01)
    assert seen["n"] == 1                               # 后台确实去取过一次
