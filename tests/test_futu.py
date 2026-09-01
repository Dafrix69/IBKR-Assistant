"""富途 OpenD 接入。

这条通道存在的理由是"IBKR 用不了的时候还有出路",所以测试的重点不是"能不能连上"
(那要真的 OpenD),而是**接错时能不能当场拒绝**:
  * 组合单在富途拆不出来 → 必须拒,不能偷偷拆成单腿建裸头寸;
  * 实盘没解锁 → 必须拒,不能等富途回一个看不懂的错误码;
  * 账号不是富途格式、连接不是富途连接 → 必须拒,不能把单发进错误会话;
  * 回报要真的能落库,否则"自动记录每笔交易"在富途这边就是空话。

全部离线:富途 SDK 用假模块替身,不需要装 futu-api,也不需要跑着 OpenD。
"""
from __future__ import annotations

import io
import json
import socket
import sys

import pytest

from conftest import BASE_CONFIG, make_settings, option_order, spread_order, stock_order
from ibkr_agent import futu, futu_broker
from ibkr_agent.broker import BrokerError
from ibkr_agent.config import _from_dict
from ibkr_agent.futu_broker import FutuRouter
from ibkr_agent.rpc import RpcServer
from ibkr_agent.validator import Validator


# ======================================================================
# 假的 futu SDK
# ======================================================================
class _Const(str):
    """既能当常量比较,又能当字符串读——足够替身用。"""


class _Enum:
    def __init__(self, **values):
        for key, value in values.items():
            setattr(self, key, _Const(value))


class FakeQuoteCtx:
    def __init__(self, script):
        self.script = script
        self.subscribed = []
        self.unsubscribed = []
        self.closed = False

    def get_global_state(self):
        return 0, self.script.get("global_state", {})

    def subscribe(self, codes, subtypes, **kwargs):
        self.subscribed.append((tuple(codes), tuple(str(s) for s in subtypes)))
        return self.script.get("subscribe", (0, ""))

    def unsubscribe(self, codes, subtypes, **kwargs):
        self.unsubscribed.append((tuple(codes), tuple(str(s) for s in subtypes)))
        return 0, ""

    def unsubscribe_all(self):
        return 0, ""

    def get_market_snapshot(self, codes):
        # 真机对指数一律回「暂不支持美股指数」——不是权限,是能力缺口
        if any(".." in c for c in codes):
            return -1, "暂不支持美股指数"
        rows = [r for r in self.script.get("snapshot", []) if r["code"] in set(codes)]
        return 0, rows

    def get_stock_quote(self, codes):
        rows = [r for r in self.script.get("quote", []) if r["code"] in set(codes)]
        return 0, rows

    def get_order_book(self, code, num=10):
        return 0, self.script.get("book", {}).get(code, {"Bid": [], "Ask": []})

    def get_option_chain(self, code, start=None, end=None, option_type=None):
        rows = self.script.get("chain", [])
        if option_type is not None:
            want = "CALL" if str(option_type) == "CALL" else "PUT"
            rows = [r for r in rows if r["option_type"] == want]
        return 0, rows

    def get_option_expiration_date(self, code):
        return 0, self.script.get("expiries", [])

    def get_stock_basicinfo(self, market, sec_type):
        return 0, self.script.get("basicinfo", [])

    def request_history_kline(self, **kwargs):
        return 0, self.script.get("kline", []), None

    def close(self):
        self.closed = True


class FakeTradeCtx:
    def __init__(self, script):
        self.script = script
        self.placed = []
        self.cancelled = []
        self.unlock_calls = []
        self.closed = False

    def get_acc_list(self):
        # 真机列名里有 trd_env,而且它决定了 acc_id 属于模拟还是实盘
        envs = self.script.get("acc_envs", {})
        return 0, [
            {"acc_id": a, "trd_env": envs.get(a, "SIMULATE"), "acc_type": "MARGIN"}
            for a in self.script.get("accounts", [])
        ]

    def unlock_trade(self, password_md5=None, **kwargs):
        self.unlock_calls.append(password_md5)
        return self.script.get("unlock", (0, ""))

    def place_order(self, **kwargs):
        self.placed.append(kwargs)
        return self.script.get(
            "place", (0, [{"order_id": "OID-1", "order_status": "SUBMITTED"}])
        )

    def order_list_query(self, **kwargs):
        return 0, self.script.get("orders", [])

    def deal_list_query(self, **kwargs):
        # 富途模拟盘会回一句「模拟交易不支持成交查询」(真机实测)
        if self.script.get("deals_unsupported"):
            return -1, "模拟交易不支持成交查询"
        return 0, self.script.get("deals", [])

    def modify_order(self, op, order_id, qty, price, **kwargs):
        self.cancelled.append(order_id)
        return 0, ""

    def close(self):
        self.closed = True


class FakeFutu:
    RET_OK = 0

    def __init__(self, script=None):
        self.script = script or {}
        self.quote = FakeQuoteCtx(self.script)
        self.trade = FakeTradeCtx(self.script)
        self.TrdMarket = _Enum(US="US", HK="HK", CN="CN")
        self.SecurityFirm = _Enum(FUTUSECURITIES="FUTUSECURITIES", FUTUINC="FUTUINC")
        self.TrdEnv = _Enum(SIMULATE="SIMULATE", REAL="REAL")
        self.TrdSide = _Enum(BUY="BUY", SELL="SELL")
        self.OrderType = _Enum(
            NORMAL="NORMAL", MARKET="MARKET", STOP="STOP", STOP_LIMIT="STOP_LIMIT",
            TRAILING_STOP="TRAILING_STOP",
        )
        self.TimeInForce = _Enum(DAY="DAY", GTC="GTC")
        self.TrailType = _Enum(RATIO="RATIO", AMOUNT="AMOUNT")
        self.ModifyOrderOp = _Enum(CANCEL="CANCEL")
        self.SubType = _Enum(QUOTE="QUOTE", ORDER_BOOK="ORDER_BOOK")
        self.OptionType = _Enum(CALL="CALL", PUT="PUT", ALL="ALL")
        self.KLType = _Enum(K_1M="K_1M", K_5M="K_5M", K_15M="K_15M", K_30M="K_30M",
                            K_60M="K_60M", K_DAY="K_DAY")
        self.AuType = _Enum(QFQ="QFQ")
        self.Market = _Enum(US="US")
        self.SecurityType = _Enum(IDX="IDX")

    def OpenQuoteContext(self, host=None, port=None):
        return self.quote

    def OpenSecTradeContext(self, **kwargs):
        return self.trade


FUTU_CONFIG = dict(
    BASE_CONFIG,
    broker={"provider": "futu", "futu": {"symbol_map": {"SPX": "US.SPX"}}},
    connections={
        "paper": {"host": "127.0.0.1", "port": 7497, "client_id": 11},
        "live": {"host": "127.0.0.1", "port": 7496, "client_id": 12},
        "opend": {"broker": "futu", "host": "127.0.0.1", "port": 11111},
    },
    accounts=[
        {"alias": "富途模拟", "account_id": "8801234", "is_paper": True,
         "connection": "opend", "default": True},
        {"alias": "富途实盘", "account_id": "8809999", "is_paper": False, "connection": "opend"},
    ],
)


def futu_settings(**overrides):
    raw = json.loads(json.dumps(FUTU_CONFIG))
    raw.update(overrides)
    return _from_dict(raw)


@pytest.fixture
def fake(monkeypatch):
    """把富途 SDK 换成替身。整套测试因此完全离线。"""
    mod = FakeFutu(
        {
            "accounts": ["8801234", "8809999"],
            # 模拟账号和实盘账号在富途是两个不同的 acc_id,各自属于一个 trd_env
            "acc_envs": {"8801234": "SIMULATE", "8809999": "REAL"},
            "global_state": {"server_ver": 900, "qot_logined": 1, "trd_logined": 1},
        }
    )
    monkeypatch.setattr(futu_broker, "_futu", lambda: mod)
    monkeypatch.setattr(futu, "_futu", lambda: mod)
    monkeypatch.setattr(futu_broker, "probe_port", lambda *a, **k: {"open": True, "latency_ms": 1, "error": None})
    monkeypatch.setattr(FutuRouter, "_SUB_SETTLE", 0.0)
    return mod


@pytest.fixture
def router(fake):
    r = FutuRouter(futu_settings())
    r.connect("opend")
    return r


def approve(settings, payload, moment):
    from ibkr_agent.models import parse_llm_payload

    parsed = parse_llm_payload({"orders": [payload], "rejections": []})
    outcome = Validator(settings, moment, snapshot={"AAPL": 230.0, "NVDA": 180.0, "SPX": 7462.0}).validate_all(
        parsed.orders
    )
    assert outcome.approved, [r.message for r in outcome.rejected]
    return outcome.approved[0]


# ======================================================================
# 配置层
# ======================================================================
def test_connections_are_split_by_broker():
    settings = futu_settings()
    assert sorted(settings.connections_for("ibkr")) == ["live", "paper"]
    assert sorted(settings.connections_for("futu")) == ["opend"]
    # 不传参数 = 生效的那一家
    assert sorted(settings.connections_for()) == ["opend"]


def test_futu_connection_defaults_to_opend_port():
    """省略 port 时不能落到 IBKR 的 7497——那会连上另一个程序还看不出错。"""
    settings = _from_dict(
        dict(FUTU_CONFIG, connections={"opend": {"broker": "futu", "host": "127.0.0.1"}})
    )
    assert settings.connections["opend"].port == 11111


def test_switching_broker_without_a_connection_is_rejected():
    with pytest.raises(ValueError, match="没有任何 broker"):
        _from_dict(
            dict(
                BASE_CONFIG,
                broker={"provider": "futu"},
            )
        )


def test_unknown_broker_is_rejected():
    with pytest.raises(ValueError, match="broker"):
        _from_dict(dict(BASE_CONFIG, connections={"x": {"broker": "tiger", "port": 1}}))


def test_existing_config_without_broker_block_still_loads():
    """老配置没有 broker 块,必须原样按 IBKR 跑——升级不该要求先改配置。"""
    settings = make_settings()
    assert settings.broker.provider == "ibkr"
    assert sorted(settings.connections_for("ibkr")) == ["live", "paper"]


# ======================================================================
# 检测与诊断
# ======================================================================
def test_scan_covers_opend_ports_and_marks_configured():
    ports = {p["port"]: p for p in futu.scan_ports(futu_settings())}
    assert 11111 in ports and 22222 in ports
    assert ports[11111]["configured_as"] == "opend"
    # IBKR 的端口不该出现在富途的扫描里
    assert 7497 not in ports


def test_scan_includes_non_standard_futu_port():
    settings = _from_dict(
        dict(FUTU_CONFIG, connections={"opend": {"broker": "futu", "port": 11555}})
    )
    ports = {p["port"]: p for p in futu.scan_ports(settings)}
    assert ports[11555]["configured_as"] == "opend"


def test_diagnose_on_closed_port_gives_a_next_step():
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    port = server.getsockname()[1]
    server.close()
    settings = _from_dict(
        dict(FUTU_CONFIG, connections={"opend": {"broker": "futu", "port": port}})
    )
    result = futu.diagnose(settings, "opend")
    assert result["connected"] is False
    assert result["port_open"] is False
    assert "OpenD" in result["hint"]


def test_diagnose_rejects_unknown_connection():
    with pytest.raises(ValueError, match="未定义的连接"):
        futu.diagnose(futu_settings(), "nope")


def test_diagnose_reports_alias_mismatch(fake, monkeypatch):
    """别名配错的账号不会在下单时报错,只会静默落到错误账户——必须在这里拦。"""
    monkeypatch.setattr(futu, "probe_port", lambda *a, **k: {"open": True, "latency_ms": 1, "error": None})
    fake.script["accounts"] = ["8801234"]          # 实盘账号其实不在这个 OpenD 上
    result = futu.diagnose(futu_settings(), "opend")
    assert result["connected"] is True
    assert result["qot_logined"] is True
    assert "富途实盘" in result["error"]


def test_diagnose_flags_opend_not_logged_in(fake, monkeypatch):
    monkeypatch.setattr(futu, "probe_port", lambda *a, **k: {"open": True, "latency_ms": 1, "error": None})
    fake.script["global_state"] = {"server_ver": 900, "qot_logined": 0, "trd_logined": 0}
    result = futu.diagnose(futu_settings(), "opend")
    assert result["qot_logined"] is False
    assert "未登录" in result["error"]


def test_missing_sdk_is_explained_not_raised():
    detail = futu.explain_connect_error(futu.FutuUnavailable("未安装 futu-api"), 11111, True)
    assert detail["code"] == "sdk_missing"
    assert "futu-api" in detail["reason"]


def test_guide_shows_the_configured_port():
    steps = futu.connection_guide(futu_settings())
    assert any("11111" in s["detail"] for s in steps)


def test_quiet_stdout_restores_the_handle():
    """stdout 只跑协议。借走之后必须还回来,否则 RPC 的回包会写到 stderr 里。"""
    original = sys.stdout
    with futu.quiet_stdout():
        assert sys.stdout is sys.stderr
    assert sys.stdout is original


def test_quiet_stdout_restores_even_on_error():
    original = sys.stdout
    with pytest.raises(RuntimeError):
        with futu.quiet_stdout():
            raise RuntimeError("boom")
    assert sys.stdout is original


# ======================================================================
# 纯函数
# ======================================================================
def test_date_conversions_round_trip():
    assert futu_broker._futu_date("20260821") == "2026-08-21"
    assert futu_broker._plain_date("2026-08-21") == "20260821"
    assert futu_broker._futu_date("2026-08-21") == "2026-08-21"   # 已经是富途格式就原样


def test_bar_time_drops_seconds_and_collapses_daily():
    assert futu_broker._bar_time("2026-08-19 09:35:00", daily=False) == "2026-08-19 09:35"
    assert futu_broker._bar_time("2026-08-19 00:00:00", daily=True) == "2026-08-19"


def test_duration_days_pads_for_weekends():
    """IBKR 数交易日、富途数日历天。直接照搬会少三成数据。"""
    assert futu_broker._duration_days({"duration": "10 D"}) == 20
    assert futu_broker._duration_days({"duration": "1 Y"}) == 375


def test_iv_is_normalised_to_a_fraction():
    """富途给百分数、IBKR 给小数。不归一的话期权墙的 IV 会大 100 倍。"""
    assert futu_broker._iv({"option_implied_volatility": 32.5}) == 0.325
    assert futu_broker._iv({"implied_volatility": 0.28}) == 0.28
    assert futu_broker._iv({"option_implied_volatility": 0}) is None


def test_field_falls_back_across_column_names():
    assert futu_broker._field({"open_interest": 12}, "option_open_interest", "open_interest") == 12
    assert futu_broker._field({"x": "nan"}, "x") is None


def test_account_id_must_be_numeric():
    with pytest.raises(BrokerError, match="必须是数字"):
        futu_broker._acc_id("DU7654321")


def test_order_kwargs_cover_every_order_type(fake):
    from ibkr_agent.models import OrderSpec

    limit = OrderSpec(action="BUY", orderType="LMT", totalQuantity=1, lmtPrice=10.0)
    assert futu_broker._order_kwargs(fake, limit, 10.0)["order_type"] == "NORMAL"

    market = OrderSpec(action="BUY", orderType="MKT", totalQuantity=1)
    assert futu_broker._order_kwargs(fake, market, None)["order_type"] == "MARKET"

    stop = OrderSpec(action="SELL", orderType="STP", totalQuantity=1, auxPrice=9.0)
    assert futu_broker._order_kwargs(fake, stop, None)["aux_price"] == 9.0

    trail = OrderSpec(action="SELL", orderType="TRAIL", totalQuantity=1, trailingPercent=5.0)
    assert futu_broker._order_kwargs(fake, trail, None)["trail_type"] == "RATIO"


def test_limit_order_without_a_price_is_refused(fake):
    from ibkr_agent.models import OrderSpec

    spec = OrderSpec(action="BUY", orderType="LMT", totalQuantity=1, price_mode="AUTO_MID")
    with pytest.raises(BrokerError, match="缺少限价"):
        futu_broker._order_kwargs(fake, spec, None)


# ======================================================================
# 代码换算
# ======================================================================
def test_plain_stock_code(router):
    assert router.code("AAPL") == "US.AAPL"


def test_index_code_comes_from_the_override_map(router):
    assert router.code("SPX") == "US.SPX"


def test_index_code_is_resolved_against_futus_own_list(fake):
    """指数命名各家不一致。猜错不一定报错,可能拿到别的标的的价格——所以去实测。"""
    fake.script["basicinfo"] = [{"code": "US..SPX", "name": "S&P 500"}]
    settings = futu_settings(broker={"provider": "futu", "futu": {"symbol_map": {}}})
    r = FutuRouter(settings)
    r.connect("opend")
    assert r.code("SPX") == "US..SPX"


def test_unresolvable_index_names_the_fix(fake):
    fake.script["basicinfo"] = []
    settings = futu_settings(broker={"provider": "futu", "futu": {"symbol_map": {}}})
    r = FutuRouter(settings)
    r.connect("opend")
    with pytest.raises(BrokerError, match="symbol_map"):
        r.code("SPX")


def test_option_code_is_looked_up_not_guessed(router, fake):
    fake.script["chain"] = [
        {"code": "US.NVDA260821C180000", "strike_price": 180.0, "option_type": "CALL"},
        {"code": "US.NVDA260821C185000", "strike_price": 185.0, "option_type": "CALL"},
    ]
    assert router.option_code("NVDA", "20260821", 180.0, "C") == "US.NVDA260821C180000"


def test_missing_strike_is_intercepted(router, fake):
    fake.script["chain"] = [
        {"code": "US.NVDA260821C180000", "strike_price": 180.0, "option_type": "CALL"}
    ]
    with pytest.raises(BrokerError, match="已拦截"):
        router.option_code("NVDA", "20260821", 999.0, "C")


# ======================================================================
# 行情
# ======================================================================
def test_stock_quotes_compute_change_from_prev_close(router, fake):
    fake.script["snapshot"] = [
        {"code": "US.AAPL", "last_price": 230.0, "prev_close_price": 200.0}
    ]
    quotes = router.stock_quotes(["AAPL"])
    assert quotes["AAPL"]["change_pct"] == 15.0


def test_order_book_notes_that_depth_needs_lv2(router, fake):
    fake.script["book"] = {"US.AAPL": {"Bid": [(229.9, 300, 2)], "Ask": [(230.1, 250, 3)]}}
    fake.script["snapshot"] = [{"code": "US.AAPL", "last_price": 230.0}]
    book = router.order_book("AAPL")
    assert book["l1"]["bid"] == 229.9
    assert book["l1"]["spread"] == 0.2
    assert "LV2" in book["note"]
    assert book["liquidity"]["spread_bps"] > 0


def test_order_book_unsubscribes_after_use(router, fake):
    """不退订就一直占着订阅额度,占满后 AUTO_MID 定价会在盘中开始拿不到报价。"""
    fake.script["book"] = {"US.AAPL": {"Bid": [(229.9, 300, 2)], "Ask": [(230.1, 250, 3)]}}
    router.order_book("AAPL")
    assert (("US.AAPL",), ("ORDER_BOOK",)) in fake.quote.unsubscribed


def test_intraday_bars_reject_the_timeframe_futu_lacks(router):
    """富途没有 2 分钟线。宁可明说,也不拿 1 分钟线合成假 K 线。"""
    with pytest.raises(BrokerError, match="2 分钟"):
        router.intraday_bars("AAPL", "2m")


def test_historical_bars_are_sorted_and_clipped(router, fake):
    fake.script["kline"] = [
        {"time_key": "2026-08-19 00:00:00", "open": 2, "high": 3, "low": 1, "close": 2.5},
        {"time_key": "2026-08-18 00:00:00", "open": 1, "high": 2, "low": 0.5, "close": 1.5},
        {"time_key": "2026-09-01 00:00:00", "open": 9, "high": 9, "low": 9, "close": 9},
    ]
    bars = router.historical_bars("AAPL", "2026-08-18", "2026-08-19")
    assert [b["date"] for b in bars] == ["2026-08-18", "2026-08-19"]


def test_empty_history_explains_the_quota(router, fake):
    fake.script["kline"] = []
    with pytest.raises(BrokerError, match="额度"):
        router.historical_bars("AAPL", "2026-08-18", "2026-08-19")


def test_permission_errors_say_where_to_turn_it_on():
    assert "LV1" in futu_broker._quote_error("no right 没有行情权限")
    assert "额度" in futu_broker._quote_error("历史K线额度不足")


# ======================================================================
# 路由与下单
# ======================================================================
def test_account_on_an_ibkr_connection_is_refused(fake):
    """账户绑在 IBKR 连接上,却让富途 router 去发单 —— 必须当场拒绝。"""
    raw = json.loads(json.dumps(FUTU_CONFIG))
    raw["accounts"] = [
        {"alias": "模拟", "account_id": "8801234", "is_paper": True,
         "connection": "paper", "default": True}
    ]
    router = FutuRouter(_from_dict(raw))
    account = _from_dict(raw).accounts[0]
    with pytest.raises(BrokerError, match="不是富途连接"):
        router.for_account(account)


def test_account_not_managed_by_the_session_is_refused(fake, now):
    fake.script["accounts"] = ["9999999"]
    settings = futu_settings()
    router = FutuRouter(settings)
    with pytest.raises(BrokerError, match="找不到对应会话"):
        router.for_account(settings.accounts[0])


def test_stock_order_is_placed_with_the_record_id_as_remark(router, now):
    settings = futu_settings()
    approved = approve(settings, stock_order(), now)
    result = router.place("rec-1", approved)

    sent = router._sessions["opend"].trade_ctx.placed[-1]
    assert sent["code"] == "US.AAPL"
    assert sent["qty"] == 100
    assert sent["price"] == 230.0
    assert sent["trd_side"] == "BUY"
    assert sent["trd_env"] == "SIMULATE"
    assert sent["acc_id"] == 8801234
    assert sent["remark"] == "rec-1"
    assert result.detail["futu_order_id"] == "OID-1"
    assert result.status == "Submitted"


def test_option_order_resolves_the_contract_code(router, now, fake):
    fake.script["chain"] = [
        {"code": "US.NVDA260821C180000", "strike_price": 180.0, "option_type": "CALL"}
    ]
    approved = approve(futu_settings(), option_order(), now)
    router.place("rec-2", approved)
    assert router._sessions["opend"].trade_ctx.placed[-1]["code"] == "US.NVDA260821C180000"


def test_combo_orders_are_refused_not_split(router, now):
    """拆成单腿会建出裸头寸而不是价差。宁可拒绝,也不能悄悄换一种风险结构。"""
    approved = approve(futu_settings(), spread_order(execution_type="IMMEDIATE", trigger=None,
                                                     order={"price_mode": "EXPLICIT", "lmtPrice": 5.0}), now)
    with pytest.raises(BrokerError, match="腿风险"):
        router.place("rec-3", approved)


def test_live_orders_need_an_unlock_first(router, now):
    settings = futu_settings(
        policies=dict(BASE_CONFIG["policies"], allow_live_trading=True, auto_execute=True)
    )
    approved = approve(settings, stock_order(account="富途实盘"), now)
    with pytest.raises(BrokerError, match="交易解锁"):
        router.place("rec-4", approved)


def test_unlock_reads_the_password_from_the_keychain(router, monkeypatch, now):
    monkeypatch.setattr(futu_broker, "get_secret", lambda service, account: "d" * 32)
    result = router.unlock("opend")
    assert result["unlocked"] == ["opend"]
    assert router._sessions["opend"].trade_ctx.unlock_calls == ["d" * 32]

    settings = futu_settings(
        policies=dict(BASE_CONFIG["policies"], allow_live_trading=True, auto_execute=True)
    )
    approved = approve(settings, stock_order(account="富途实盘"), now)
    placed = router.place("rec-5", approved)
    assert placed.detail["account"] == "8809999"


def test_unlock_without_a_stored_password_says_so(router, monkeypatch):
    monkeypatch.setattr(futu_broker, "get_secret", lambda service, account: None)
    with pytest.raises(BrokerError, match="只能下模拟盘"):
        router.unlock("opend")


def test_cancel_all_open_touches_only_our_own_open_orders(router, fake, now):
    """熔断是"停掉这个软件的自动执行",不是替用户清空账户。

    富途会把这个账户下所有渠道的挂单都回给你,包括用户在富途客户端里手动挂的。
    IBKR 那边天然只看得到本 clientId 的单,这里必须靠跟踪表把范围对齐。
    """
    approved = approve(futu_settings(), stock_order(), now)
    router.place("rec-7", approved)          # 我们自己的单 → order_id = OID-1
    fake.script["orders"] = [
        {"order_id": "OID-1", "order_status": "SUBMITTED"},
        {"order_id": "MANUAL", "order_status": "SUBMITTED"},   # 用户在富途 App 里挂的
        {"order_id": "OID-1", "order_status": "FILLED_ALL"},   # 已成交的不该撤
    ]
    assert router.cancel_all_open() == 1
    assert router._sessions["opend"].trade_ctx.cancelled == ["OID-1"]


# ======================================================================
# 回报入库
# ======================================================================
def test_poll_reports_status_and_fills_into_the_store(router, now, tmp_path):
    from ibkr_agent.engine import TradingEngine
    from ibkr_agent.notify import Notifier
    from ibkr_agent.store import TradeStore

    settings = futu_settings(storage={"db_path": str(tmp_path / "t.db")})
    engine = TradingEngine(
        settings, parser=object(), store=TradeStore(settings.db_path),
        notifier=Notifier(enabled=False), router=router,
    )
    approved = approve(settings, stock_order(), now)
    record_id = engine.store.create_record(
        {"input": {"raw_instruction": "买 AAPL"}, "account": {"account_id": "8801234"},
         "contract": {"symbol": "AAPL"}, "order": {"totalQuantity": 100}}
    )
    placement = router.place(record_id, approved)
    engine._index_placement(record_id, placement)

    router._sessions["opend"].trade_ctx.script["orders"] = [
        {"order_id": "OID-1", "order_status": "FILLED_ALL", "qty": 100, "dealt_qty": 100}
    ]
    router._sessions["opend"].trade_ctx.script["deals"] = [
        {"deal_id": "D-1", "order_id": "OID-1", "price": 229.8, "qty": 100,
         "trd_side": "BUY", "create_time": "2026-08-19 10:00:00"}
    ]
    assert engine.sync_broker_orders() >= 2

    record = engine.store.get_record(record_id)
    assert [s["status"] for s in record["ibkr"]["status_timeline"]] == ["Filled"]
    assert record["ibkr"]["fills"][0]["price"] == 229.8
    assert record["ibkr"]["avg_fill_price"] == 229.8
    assert record["final_status"] == "filled"


def test_poll_does_not_repeat_unchanged_rows(router, now):
    settings = futu_settings()
    approved = approve(settings, stock_order(), now)
    router.place("rec-6", approved)
    trade_ctx = router._sessions["opend"].trade_ctx
    trade_ctx.script["orders"] = [
        {"order_id": "OID-1", "order_status": "SUBMITTED", "qty": 100, "dealt_qty": 0}
    ]
    assert len(router.poll_order_updates()) == 1
    assert router.poll_order_updates() == []          # 没变化就不该再落一次库


def test_ibkr_router_has_no_poll_hook_and_sync_is_a_no_op(settings, tmp_path):
    from ibkr_agent.broker import BrokerRouter
    from ibkr_agent.engine import TradingEngine
    from ibkr_agent.notify import Notifier
    from ibkr_agent.store import TradeStore

    engine = TradingEngine(
        settings, parser=object(), store=TradeStore(tmp_path / "t.db"),
        notifier=Notifier(enabled=False), router=BrokerRouter(settings),
    )
    assert engine.sync_broker_orders() == 0


def test_futu_sessions_are_skipped_by_the_ib_event_wiring(router, settings, tmp_path):
    """富途会话没有 ib_insync 的事件流。挂监听必须优雅跳过,不能抛 AttributeError。"""
    from ibkr_agent.engine import TradingEngine
    from ibkr_agent.notify import Notifier
    from ibkr_agent.store import TradeStore

    engine = TradingEngine(
        settings, parser=object(), store=TradeStore(tmp_path / "t.db"),
        notifier=Notifier(enabled=False), router=router,
    )
    assert engine.attach_listeners() == 0


# ======================================================================
# RPC
# ======================================================================
@pytest.fixture
def server(tmp_path):
    """只配了 IBKR 的服务器——大多数人升级上来就是这个状态。"""
    config = dict(BASE_CONFIG)
    config["storage"] = {"db_path": str(tmp_path / "trades.db")}
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
    return RpcServer(path, stdout=io.StringIO(), stdin=io.StringIO())


@pytest.fixture
def futu_server(tmp_path):
    """两家都配好、当前仍生效 IBKR 的服务器。"""
    config = json.loads(json.dumps(FUTU_CONFIG))
    config["broker"] = {"provider": "ibkr", "futu": {"symbol_map": {"SPX": "US.SPX"}}}
    config["accounts"] = [
        {"alias": "模拟", "account_id": "DU7654321", "is_paper": True,
         "connection": "paper", "default": True},
        {"alias": "富途模拟", "account_id": "8801234", "is_paper": True, "connection": "opend"},
    ]
    config["storage"] = {"db_path": str(tmp_path / "trades.db")}
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
    return RpcServer(path, stdout=io.StringIO(), stdin=io.StringIO())


def call(server, method, params=None):
    server._handle({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})
    lines = [json.loads(l) for l in server.stdout.getvalue().splitlines() if l.strip()]
    server.stdout.seek(0)
    server.stdout.truncate()
    return [m for m in lines if m.get("id") == 1][-1]


def test_catalog_lists_both_brokers_and_masks_accounts(server):
    result = call(server, "broker.catalog")["result"]
    assert result["current"] == "ibkr"
    keys = [p["key"] for p in result["providers"]]
    assert keys == ["ibkr", "futu"]
    ibkr = next(p for p in result["providers"] if p["key"] == "ibkr")
    assert {a["alias"] for a in ibkr["accounts"]} == {"模拟", "主账户"}
    assert all("account_id" not in a for a in ibkr["accounts"])


def test_select_refuses_to_write_connections_itself(server):
    """§9.6:账户与连接只允许人手动改配置文件,换券商不是绕过它的后门。

    但也别让人去猜字段名——报错里直接给出该抄的那段配置。
    """
    error = call(server, "broker.select", {"provider": "futu"})["error"]
    assert error["code"] == -32006
    assert "settings.json" in error["message"]
    assert '"broker": "futu"' in error["message"] and "11111" in error["message"]
    # 配置一个字都没动
    reloaded = json.loads(server.settings.source_path.read_text(encoding="utf-8"))
    assert "futu" not in reloaded.get("connections", {})
    assert call(server, "system.status")["result"]["broker_provider"] == "ibkr"


def test_catalog_hands_out_the_snippet_for_unconfigured_brokers(server):
    providers = {p["key"]: p for p in call(server, "broker.catalog")["result"]["providers"]}
    assert providers["ibkr"]["config_snippet"] is None
    assert "11111" in providers["futu"]["config_snippet"]


def test_select_switches_once_the_connection_exists(futu_server):
    result = call(futu_server, "broker.select", {"provider": "futu"})["result"]
    assert result["current"] == "futu"
    assert result["connections"] == ["opend"]
    # 只改 broker.provider 这一个字段,连接与账户原样不动
    reloaded = json.loads(futu_server.settings.source_path.read_text(encoding="utf-8"))
    assert reloaded["broker"]["provider"] == "futu"
    assert sorted(reloaded["connections"]) == ["live", "opend", "paper"]
    assert call(futu_server, "system.status")["result"]["broker_provider"] == "futu"


def test_select_rejects_an_unknown_broker(server):
    assert call(server, "broker.select", {"provider": "tiger"})["error"]["code"] == -32602


def test_futu_scan_only_reports_futu_ports(futu_server):
    call(futu_server, "broker.select", {"provider": "futu"})
    result = call(futu_server, "futu.scan")["result"]
    assert result["active"] is True
    assert {p["port"] for p in result["ports"]} >= {11111, 22222}
    assert result["guide"]


def test_futu_diagnose_without_a_futu_connection_says_so(server):
    assert call(server, "futu.diagnose")["error"]["code"] == -32602


def test_password_is_stored_as_md5_only(server, monkeypatch):
    saved = {}
    monkeypatch.setattr(
        "ibkr_agent.rpc.set_secret", lambda s, a, v: saved.update({"service": s, "account": a, "value": v})
    )
    assert call(server, "futu.set_password", {"password": "hunter2"})["result"]["ok"] is True
    assert saved["value"] == "2ab96390c7dbe3439de74d0c9b0b1767"   # md5("hunter2")
    assert saved["account"] == "futu"
    # 明文绝不能出现在审计流水里
    audits = json.dumps(server.engine.store.export_all(), ensure_ascii=False)
    assert "hunter2" not in audits and saved["value"] not in audits


def test_password_marked_as_md5_must_look_like_md5(server):
    error = call(server, "futu.set_password", {"password": "not-a-hash", "already_md5": True})
    assert error["error"]["code"] == -32602


def test_unlock_is_refused_while_ibkr_is_the_active_broker(server):
    assert call(server, "futu.unlock")["error"]["code"] == -32010


def test_connect_through_rpc_builds_the_futu_router(futu_server, fake, monkeypatch):
    """切换 → 连接 → 状态,一条完整的路。全系统只有 _make_router 知道连的是谁。"""
    monkeypatch.setattr(
        "ibkr_agent.futu_broker.probe_port",
        lambda *a, **k: {"open": True, "latency_ms": 1, "error": None},
    )
    call(futu_server, "broker.select", {"provider": "futu"})
    result = call(futu_server, "broker.connect")["result"]
    assert result["provider"] == "futu"
    assert result["connected"] == ["opend"]
    assert futu_server.router.BROKER == "futu"

    status = call(futu_server, "system.status")["result"]
    assert status["broker_provider"] == "futu"
    assert status["broker_connected"] is True


def test_switching_back_to_ibkr_drops_the_futu_session(futu_server, fake, monkeypatch):
    monkeypatch.setattr(
        "ibkr_agent.futu_broker.probe_port",
        lambda *a, **k: {"open": True, "latency_ms": 1, "error": None},
    )
    call(futu_server, "broker.select", {"provider": "futu"})
    call(futu_server, "broker.connect")
    assert futu_server.router is not None

    call(futu_server, "broker.select", {"provider": "ibkr"})
    # 旧会话必须真的断掉:留着一条半死的连接,状态栏会显示"已连接"而什么都发不出去
    assert futu_server.router is None
    assert fake.quote.closed and fake.trade.closed
    assert call(futu_server, "system.status")["result"]["broker_connected"] is False


def test_pending_poll_syncs_futu_reports_even_with_no_queue(futu_server, fake, monkeypatch):
    """盯盘队列是空的时候也要同步回报,否则富途下的单永远停在 Submitted。"""
    monkeypatch.setattr(
        "ibkr_agent.futu_broker.probe_port",
        lambda *a, **k: {"open": True, "latency_ms": 1, "error": None},
    )
    call(futu_server, "broker.select", {"provider": "futu"})
    call(futu_server, "broker.connect")
    assert call(futu_server, "pending.poll")["result"]["synced"] == 0


# ======================================================================
# 条件单:富途没有原生条件单,必须退到软件盯盘
# ======================================================================
def _engine_with(router, settings, tmp_path):
    from ibkr_agent.engine import TradingEngine
    from ibkr_agent.notify import Notifier
    from ibkr_agent.store import TradeStore

    return TradingEngine(
        settings, parser=object(), store=TradeStore(tmp_path / "t.db"),
        notifier=Notifier(enabled=False), router=router,
    )


def test_explicit_price_conditional_goes_to_the_watch_queue_on_futu(router, now, tmp_path):
    """IBKR 把条件挂在服务器上;富途没有这个能力。

    不分流的话,"涨到 7500 再买"会被当成普通单立刻发出去——触发价形同虚设,
    而且这个错误在成交回来之前完全看不出来。
    """
    settings = futu_settings(
        policies=dict(BASE_CONFIG["policies"], auto_execute=True)
    )
    engine = _engine_with(router, settings, tmp_path)
    payload = stock_order(
        execution_type="CONDITIONAL",
        trigger={"type": "PRICE", "symbol": "AAPL", "secType": "STK",
                 "operator": ">=", "value": 240.0},
    )
    approved = approve(settings, payload, now)
    record_id = engine.store.create_record({"contract": {"symbol": "AAPL"}, "order": {}})

    outcome = engine._execute(record_id, approved)
    assert outcome == {"queued": True, "mode": "software_watch"}
    assert router._sessions["opend"].trade_ctx.placed == []      # 一张单都没发出去
    assert [p.record_id for p in engine.pending_triggers] == [record_id]


def test_the_same_order_uses_ibkrs_native_condition(settings, now, tmp_path, monkeypatch):
    """对照组:IBKR 侧行为不变——条件挂在服务器上,软件掉线也有效。"""
    from ibkr_agent.broker import BrokerRouter, PlacementResult

    router = BrokerRouter(settings)
    sent = []

    def fake_place(self, rid, approved, limit=None):
        sent.append(rid)
        return PlacementResult(record_id=rid, order_id=1)

    monkeypatch.setattr(BrokerRouter, "place", fake_place)
    engine = _engine_with(router, settings, tmp_path)
    payload = stock_order(
        execution_type="CONDITIONAL",
        trigger={"type": "PRICE", "symbol": "AAPL", "secType": "STK",
                 "operator": ">=", "value": 240.0},
    )
    approved = approve(settings, payload, now)
    record_id = engine.store.create_record({"contract": {"symbol": "AAPL"}, "order": {}})

    outcome = engine._execute(record_id, approved)
    assert outcome["mode"] == "ibkr_condition"
    assert sent == [record_id]          # 单子发出去了,条件由 IBKR 服务器盯
    assert engine.pending_triggers == []


# ======================================================================
# 真机联调抓出来的几件事(futu-api 10.10 + 本机 OpenD 实测)
# ======================================================================
def test_futu_cannot_quote_us_indices_at_all(router):
    """富途 OpenAPI **不支持美股指数**——快照、订阅、K 线三条路都回
    「暂不支持美股指数」。这不是权限没开,是能力缺口。

    最阴的地方在于:指数代码在它的证券列表里查得到(US..SPX),所以代码解析
    会"成功",然后每次取数静默空手而归。必须前置成一次明确的拒绝。
    """
    assert router.quote_capability("AAPL") is None
    reason = router.quote_capability("SPX")
    assert reason and "不支持美股指数" in reason
    assert "SPY" in reason                      # 给出可选替代
    assert "不会替你换标的" in reason            # 但绝不替用户换

    assert router.index_price("SPX") is None    # 契约不变:取不到就回 None
    for call in (
        lambda: router.intraday_bars("SPX", "5m"),
        lambda: router.historical_bars("SPX", "2026-08-01", "2026-08-19"),
    ):
        with pytest.raises(BrokerError, match="不支持美股指数"):
            call()


def test_index_option_chain_is_not_blocked_by_the_quote_gate(router):
    """闸门管的是"标的本身的行情"。指数的**期权链**富途是支持的——实测
    US..SPX 回的是权限错误而不是「暂不支持」,所以这条路不能一起堵死。"""
    with pytest.raises(BrokerError) as excinfo:
        router.option_expiries("SPX")
    assert "不支持美股指数" not in str(excinfo.value)


def test_unwatchable_trigger_is_refused_instead_of_queued(router, now, tmp_path):
    """报不出价的标的绝不能进盯盘队列。

    进了队列就会一直等一个永远为 None 的价格——界面显示"正在盯盘",实际上
    什么都不会发生。这种静默失效比直接拒绝危险得多。
    """
    from ibkr_agent.engine import TradingEngine
    from ibkr_agent.notify import Notifier
    from ibkr_agent.store import TradeStore

    settings = futu_settings(policies=dict(BASE_CONFIG["policies"], auto_execute=True))
    engine = TradingEngine(
        settings, parser=object(), store=TradeStore(tmp_path / "t.db"),
        notifier=Notifier(enabled=False), router=router,
    )
    payload = stock_order(
        execution_type="CONDITIONAL",
        trigger={"type": "PRICE", "symbol": "SPX", "secType": "IND",
                 "operator": ">=", "value": 7500.0},
    )
    approved = approve(settings, payload, now)
    record_id = engine.store.create_record({"contract": {"symbol": "AAPL"}, "order": {}})

    with pytest.raises(BrokerError, match="不支持美股指数"):
        engine._execute(record_id, approved)
    assert engine.pending_triggers == []


def test_index_refusal_is_logged_once_not_every_tick(router, capsys):
    """盯盘循环几秒一轮。每轮都吼一遍会把日志淹掉,后面真正的错误就看不见了。"""
    for _ in range(5):
        router.index_price("SPX")
    lines = [l for l in capsys.readouterr().err.splitlines() if l.startswith("[futu]")]
    assert len(lines) == 1


def test_batch_quotes_skip_symbols_futu_cannot_serve(router, fake):
    fake.script["snapshot"] = [
        {"code": "US.AAPL", "last_price": 316.2, "prev_close_price": 310.0}
    ]
    quotes = router.stock_quotes(["AAPL", "SPX"])
    assert "AAPL" in quotes and "SPX" not in quotes


def test_simulated_account_fills_are_synthesised_from_the_order_row(router, now, tmp_path):
    """富途**模拟盘不支持成交查询**(真机回「模拟交易不支持成交查询」)。

    只落状态不落成交的话,"自动记录每笔交易"在纸面账户上就是半句空话——
    没有 fills[]、没有均价,复盘和对账都无从谈起。所以从订单行的
    dealt_qty / dealt_avg_price 合成,并显式标记它不是逐笔明细。
    """
    from ibkr_agent.engine import TradingEngine
    from ibkr_agent.notify import Notifier
    from ibkr_agent.store import TradeStore

    settings = futu_settings(storage={"db_path": str(tmp_path / "t.db")})
    engine = TradingEngine(
        settings, parser=object(), store=TradeStore(settings.db_path),
        notifier=Notifier(enabled=False), router=router,
    )
    approved = approve(settings, stock_order(), now)
    record_id = engine.store.create_record(
        {"account": {"account_id": "8801234"}, "contract": {"symbol": "AAPL"},
         "order": {"totalQuantity": 100}}
    )
    engine._index_placement(record_id, router.place(record_id, approved))

    trade_ctx = router._sessions["opend"].trade_ctx
    trade_ctx.script["deals_unsupported"] = True
    trade_ctx.script["orders"] = [
        {"order_id": "OID-1", "order_status": "FILLED_PART", "qty": 100,
         "dealt_qty": 40, "dealt_avg_price": 229.5, "trd_side": "BUY"}
    ]
    engine.sync_broker_orders()
    trade_ctx.script["orders"] = [
        {"order_id": "OID-1", "order_status": "FILLED_ALL", "qty": 100,
         "dealt_qty": 100, "dealt_avg_price": 229.8, "trd_side": "BUY"}
    ]
    engine.sync_broker_orders()

    record = engine.store.get_record(record_id)
    fills = record["ibkr"]["fills"]
    assert [f["qty"] for f in fills] == [40.0, 60.0]      # 只记增量,不重复计
    assert all("合成" in f["exec_id"] for f in fills)      # 显式标记,别当逐笔明细用
    assert record["final_status"] == "filled"


def test_deal_query_is_not_retried_once_known_unsupported(router, now):
    settings = futu_settings()
    approved = approve(settings, stock_order(), now)
    router.place("rec-9", approved)
    trade_ctx = router._sessions["opend"].trade_ctx
    trade_ctx.script["deals_unsupported"] = True
    trade_ctx.script["orders"] = [
        {"order_id": "OID-1", "order_status": "SUBMITTED", "qty": 100, "dealt_qty": 0}
    ]
    router.poll_order_updates()
    assert "8801234" in router._no_deal_query

    calls = []

    def spy(**kwargs):
        calls.append(kwargs)
        return 0, []

    trade_ctx.deal_list_query = spy
    router.poll_order_updates()
    assert calls == []                                   # 已知不支持就不再问


def test_real_accounts_still_use_the_real_deal_feed(router, now):
    """实盘支持逐笔成交,就该用真的,不该退化成合成。"""
    settings = futu_settings(
        policies=dict(BASE_CONFIG["policies"], allow_live_trading=True, auto_execute=True)
    )
    router._sessions["opend"].unlocked = True
    approved = approve(settings, stock_order(account="富途实盘"), now)
    router.place("rec-10", approved)
    trade_ctx = router._sessions["opend"].trade_ctx
    trade_ctx.script["orders"] = [
        {"order_id": "OID-1", "order_status": "FILLED_ALL", "qty": 100,
         "dealt_qty": 100, "dealt_avg_price": 229.8, "trd_side": "BUY"}
    ]
    trade_ctx.script["deals"] = [
        {"deal_id": "D-9", "order_id": "OID-1", "price": 229.81, "qty": 100,
         "trd_side": "BUY", "create_time": "2026-08-19 10:00:00"}
    ]
    kinds = [k for k, _, _ in router.poll_order_updates()]
    assert kinds.count("fill") == 1
    assert "8809999" not in router._no_deal_query


def test_paper_flag_must_match_futus_own_trd_env(router, now):
    """is_paper 是 allow_live_trading 那道闸的输入。

    把实盘账号标成模拟,实盘保护就整个失效了——所以以富途报的为准,不一致直接拒。
    """
    raw = json.loads(json.dumps(FUTU_CONFIG))
    raw["policies"] = dict(BASE_CONFIG["policies"], auto_execute=True)
    # 8809999 在富途那边是实盘,这里却标成模拟
    raw["accounts"] = [
        {"alias": "伪装成模拟", "account_id": "8809999", "is_paper": True,
         "connection": "opend", "default": True}
    ]
    settings = _from_dict(raw)
    approved = approve(settings, stock_order(), now)
    router.settings = settings
    with pytest.raises(BrokerError, match="is_paper"):
        router.place("rec-11", approved)


def test_diagnose_flags_the_env_mismatch_before_you_trade(fake, monkeypatch):
    monkeypatch.setattr(
        futu, "probe_port", lambda *a, **k: {"open": True, "latency_ms": 1, "error": None}
    )
    raw = json.loads(json.dumps(FUTU_CONFIG))
    raw["accounts"] = [
        {"alias": "伪装成模拟", "account_id": "8809999", "is_paper": True,
         "connection": "opend", "default": True}
    ]
    result = futu.diagnose(_from_dict(raw), "opend")
    assert result["connected"] is True
    assert "对不上" in result["error"] and "伪装成模拟" in result["error"]
    assert result["accounts"][0]["trd_env"] == "REAL"
    assert result["accounts"][0]["env_matches"] is False


def test_order_status_map_covers_the_whole_futu_enum():
    """漏一个状态就会被当成 Submitted,单子在界面上永远"在途"。"""
    real_enum = {
        "NONE", "UNSUBMITTED", "WAITING_SUBMIT", "SUBMITTING", "SUBMITTED",
        "FILLED_PART", "FILLED_ALL", "CANCELLING_PART", "CANCELLING_ALL",
        "CANCELLED_PART", "CANCELLED_ALL", "FAILED", "DISABLED", "DELETED",
        "FILL_CANCELLED", "SUBMIT_FAILED", "TIMEOUT",
    }
    assert real_enum <= set(futu_broker._ORDER_STATUS)
    assert "CANCELLING_ALL" not in futu_broker._OPEN_STATUS   # 正在撤的不再撤一次
    assert "UNSUBMITTED" in futu_broker._OPEN_STATUS


def test_opend_timestamp_is_rendered_readable():
    """OpenD 回的是 unix 时间戳。原样显示是一串数字,没人看得懂。"""
    assert futu._readable_time("1787167285").startswith("2026-")
    assert futu._readable_time(None) is None
    assert futu._readable_time("不是数字") == "不是数字"


def test_security_firm_list_matches_the_sdk_enum():
    """少写一家,用那家券商的用户就会卡在配置校验上,而这跟安全边界无关。"""
    from ibkr_agent.config import _FUTU_FIRMS

    for firm in ("FUTUSECURITIES", "FUTUINC", "FUTUSG", "FUTUAU",
                 "FUTUCA", "FUTUJP", "FUTUMY"):
        assert firm in _FUTU_FIRMS


# ======================================================================
# 指数现价:从期权链自己反推(put-call parity)
# ======================================================================
def parity_chain(spot=7462.35, discount=0.996718, lo=7200, hi=7750, step=25, noise=0.0, seed=1):
    """造一条严格满足平价关系的链:C − P = S − K·D。"""
    import math
    import random

    rnd = random.Random(seed)
    rows, snap = [], []
    for k in range(lo, hi, step):
        c = max(spot - discount * k, 0.0) + 60.0 + rnd.uniform(-noise, noise)
        p = c - (spot - discount * k) + rnd.uniform(-noise, noise)
        if c <= 0 or p <= 0:
            continue
        for right, price in (("CALL", c), ("PUT", p)):
            code = "US.SPX%s%d" % (right[0], k)
            rows.append({"code": code, "strike_price": float(k), "option_type": right})
            snap.append({"code": code, "bid_price": price - 0.05, "ask_price": price + 0.05,
                         "last_price": price, "option_open_interest": 100, "volume": 10})
    assert math.isfinite(spot)
    return rows, snap


def test_parity_solver_is_exact_on_clean_quotes():
    """用的是恒等式不是估计:报价干净时应当精确还原现价**和**折现因子。"""
    import math

    spot, discount = 7462.35, math.exp(-0.04 * 30 / 365)
    pairs = []
    for k in range(7200, 7750, 25):
        c = max(spot - discount * k, 0.0) + 60.0
        p = c - (spot - discount * k)
        if c > 0 and p > 0:
            pairs.append((float(k), c, p))
    out = futu_broker.implied_spot(pairs)
    assert abs(out["spot"] - spot) < 1e-6
    assert abs(out["discount"] - discount) < 1e-6   # 返回值保留 6 位小数
    assert out["residual"] < 1e-6


def test_parity_solver_does_not_assume_zero_rates():
    """只看一个行权价、把折现因子当 1,在 SPX 上会差出二十几个点。"""
    import math

    spot, discount = 7462.35, math.exp(-0.04 * 30 / 365)
    k = 7400.0
    c = max(spot - discount * k, 0.0) + 60.0
    p = c - (spot - discount * k)
    naive = k + (c - p)                      # 天真做法:S ≈ K + C − P
    assert abs(naive - spot) > 20            # 差得够多,值得认真拟合
    pairs = [(float(x), max(spot - discount * x, 0.0) + 60.0,
              max(spot - discount * x, 0.0) + 60.0 - (spot - discount * x))
             for x in range(7300, 7600, 25)]
    assert abs(futu_broker.implied_spot(pairs)["spot"] - spot) < 1e-6


def test_parity_solver_refuses_dirty_quotes():
    """墙的位置全靠这个价。报价不干净时宁可拒绝,也不能给一个像模像样的错价。"""
    with pytest.raises(BrokerError, match="至少要"):
        futu_broker.implied_spot([(7400.0, 100.0, 50.0), (7425.0, 90.0, 60.0)])

    # 折现因子跑飞 = 拟合的根本不是平价关系(常见于混进了别的到期日)
    with pytest.raises(BrokerError, match="折现因子"):
        futu_broker.implied_spot(
            [(7000.0, 500.0, 10.0), (7100.0, 300.0, 20.0),
             (7200.0, 100.0, 30.0), (7300.0, 50.0, 40.0)]
        )


def test_parity_solver_rejects_noisy_chain_via_residual():
    import random

    rnd = random.Random(11)
    spot, discount = 7462.35, 0.9967
    pairs = []
    for k in range(7200, 7750, 25):
        c = max(spot - discount * k, 0.0) + 60.0
        p = c - (spot - discount * k) + rnd.uniform(-120, 120)   # 报价乱掉
        if c > 0 and p > 0:
            pairs.append((float(k), c, p))
    with pytest.raises(BrokerError):
        futu_broker.implied_spot(pairs)


def test_index_option_chain_derives_its_own_spot(router, fake):
    """富途拿不到指数现价,但指数**期权链**是支持的——现价由链自己反推。

    这条路打通之后,SPX 的期权墙在富途通道上才成立。
    """
    rows, snap = parity_chain()
    fake.script["expiries"] = [{"strike_time": "2026-09-18"}]
    fake.script["chain"] = rows
    fake.script["snapshot"] = snap

    chain = router.option_chain("SPX", "20260918", width=3)
    assert chain["spot_source"] == "parity"
    assert abs(chain["spot"] - 7462.35) < 0.5
    assert chain["rows"]
    # 挑出来的行权价应当围着反推出的现价
    strikes = sorted({r["strike"] for r in chain["rows"]})
    assert strikes[0] < chain["spot"] < strikes[-1]


def test_stock_option_chain_still_uses_the_real_quote(router, fake):
    """能直接问到现价的标的,绝不绕道去反推。"""
    rows, snap = parity_chain(spot=316.0, discount=0.999, lo=300, hi=332, step=2)
    fake.script["expiries"] = [{"strike_time": "2026-09-18"}]
    fake.script["chain"] = rows
    fake.script["snapshot"] = snap + [
        {"code": "US.AAPL", "last_price": 316.2, "prev_close_price": 310.0}
    ]
    chain = router.option_chain("AAPL", "20260918", width=3)
    assert chain["spot_source"] == "quote"
    assert chain["spot"] == 316.2


def test_option_mid_prefers_the_book_over_a_stale_print():
    """期权的最新成交可能是很久以前的一笔,拿它拟合会把残差撑大。"""
    assert futu_broker._option_mid({"bid_price": 10.0, "ask_price": 11.0, "last_price": 3.0}) == 10.5
    assert futu_broker._option_mid({"last_price": 3.0}) == 3.0
    assert futu_broker._option_mid({"bid_price": 0, "ask_price": 0, "last_price": 0}) is None


def test_option_permission_error_is_not_confused_with_stock_permission(router):
    """期权和股票是两份独立的行情权限。混着说,用户会去核对已经开好的那份。"""
    option = futu_broker._quote_error("无权限获取US.AAPL的行情，请检查美国市场期权行情权限")
    assert "美股期权行情" in option and "分开" in option
    stock = futu_broker._quote_error("无权限获取US.AAPL的行情，请检查美国市场行情权限")
    assert "LV1" in stock and "分开" not in stock
