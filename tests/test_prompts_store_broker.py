"""提示词装配(§2/§3)、append-only 落库(§6/§9.6)、下单纯计算(§8)。"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta

import pytest

from conftest import BASE_CONFIG, make_settings, spread_order
from ibkr_agent.broker import LegQuote, auto_mid_limit, combo_mid_price, price_condition_spec
from ibkr_agent.config import ET
from ibkr_agent.llm import structured_output_schema, supports_sampling_params
from ibkr_agent.market import extract_symbols
from ibkr_agent.models import TriggerSpec
from ibkr_agent.prompts import PromptError, load_prompt_bundle, render_system, render_user
from ibkr_agent.store import TradeStore, redact_account


# ---- 提示词 -------------------------------------------------------------
def test_bundle_renders_without_leftover_placeholders(settings, now):
    bundle = load_prompt_bundle(settings)
    assert "{{" not in bundle.system_text
    assert "苹果=AAPL" in bundle.system_text
    assert "模拟=纸面测试账户(默认)" in bundle.system_text
    assert len(bundle.fewshot) >= 6


def test_real_account_ids_never_reach_the_prompt(settings, now):
    """§9.1 的硬架构约束:LLM 只见别名。"""
    bundle = load_prompt_bundle(settings)
    assert "DU7654321" not in bundle.system_text
    assert "U1234567" not in bundle.system_text

    user = render_user(bundle, settings, "买 100 股 AAPL", now)
    assert "DU7654321" not in user


def test_prompt_with_account_id_is_refused(settings):
    with pytest.raises(PromptError, match="真实账号"):
        render_system("账户表:DU7654321 {{SYMBOL_ALIAS_TABLE}}{{ACCOUNT_ALIAS_TABLE}}"
                      "{{MAX_ORDER_NOTIONAL}}{{MAX_OPTION_CONTRACTS}}{{MAX_MKT_SHARES}}", settings)


def test_missing_variable_is_refused(settings):
    with pytest.raises(PromptError, match="未替换的模板变量"):
        render_system("限额 {{MAX_ORDER_NOTIONAL}} 未知 {{SOMETHING_ELSE}}", settings)


def test_snapshot_line_present_only_when_there_is_data(settings, now):
    bundle = load_prompt_bundle(settings)
    with_snapshot = render_user(bundle, settings, "spx 到 7500", now, snapshot={"SPX": 7462.35})
    without = render_user(bundle, settings, "spx 到 7500", now)
    assert "相关行情快照:SPX 现价 7462.35" in with_snapshot
    assert "行情快照" not in without
    assert "2026-08-14 10:32" in with_snapshot
    assert "盘中" in with_snapshot


def test_fingerprint_tracks_what_the_model_sees(settings):
    """v1.8.0 起限额不进提示词(校验层复算):改限额不换指纹,改别名表才换;v1.7.0 照旧随限额变。"""
    tighter = make_settings(limits={"max_order_notional": 999.0})
    assert load_prompt_bundle(settings).fingerprint == load_prompt_bundle(tighter).fingerprint
    aliased = make_settings(symbol_aliases={"微软": "MSFT"})
    assert load_prompt_bundle(settings).fingerprint != load_prompt_bundle(aliased).fingerprint
    legacy = make_settings(prompt_version="v1.7.0")
    legacy_tighter = make_settings(prompt_version="v1.7.0", limits={"max_order_notional": 999.0})
    assert load_prompt_bundle(legacy).fingerprint != load_prompt_bundle(legacy_tighter).fingerprint


# ---- LLM 层的两个约定 ----------------------------------------------------
def test_sampling_params_gate():
    assert not supports_sampling_params("claude-opus-5")
    assert not supports_sampling_params("claude-sonnet-5")
    assert supports_sampling_params("claude-haiku-4-5")


def test_structured_output_schema_is_api_safe():
    schema = structured_output_schema()
    assert set(schema["properties"]) == {"orders", "rejections"}
    unsupported = {"minimum", "maximum", "exclusiveMinimum", "minLength", "pattern"}

    def walk(node):
        if isinstance(node, dict):
            assert not (set(node) & unsupported), "残留不支持的关键字:%s" % (set(node) & unsupported)
            if node.get("type") == "object":
                assert node.get("additionalProperties") is False
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(schema)


# ---- 行情标的抽取 --------------------------------------------------------
def test_extract_symbols_handles_mixed_language(settings):
    found = extract_symbols("spx到7500时,开一张今天的 7520 7550 call spread", settings)
    assert "SPX" in found
    assert "CALL" not in found

    found = extract_symbols("买入苹果 100 股,顺便看看 NVDA", settings)
    assert "AAPL" in found and "NVDA" in found


# ---- 账户路由:TWS 单会话、切换登录后自动改道 -----------------------------
class _FakeIB:
    def __init__(self, managed):
        self._managed = managed

    def isConnected(self):
        return True

    def managedAccounts(self):
        return self._managed

    def disconnect(self):
        pass


class _StalledIB:
    """TWS 收得到请求、但永远不回应 —— 上游(TWS↔IBKR)断开时的真实表现。"""

    async def qualifyContractsAsync(self, contract):
        import asyncio

        await asyncio.sleep(3600)

    def run(self, coro):
        import asyncio

        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()


def test_qualify_times_out_instead_of_wedging_the_whole_engine():
    """合约确认必须有硬超时。

    实测事故:TWS 与 IBKR 上游断开(错误 1100)后,本机 socket 仍然活着、
    isConnected() 仍是 True,于是请求发得出去却永远等不到回应。RPC 服务是
    串行的,这一次阻塞把后面所有请求都堵死——连根本不碰券商的 system.status
    都连续超时 159 次,界面直接变砖。所以宁可报错,绝不能挂着。
    """
    from types import SimpleNamespace

    from ibkr_agent.broker import BrokerError, BrokerRouter

    router = BrokerRouter(make_settings())
    router._QUALIFY_TIMEOUT = 0.05
    with pytest.raises(BrokerError) as exc:
        router._qualify_or_raise(_StalledIB(), SimpleNamespace(conId=0))
    assert "没有响应" in str(exc.value)


def test_stalled_message_names_the_upstream_break_when_that_is_the_cause():
    """错误 1100 之后要直说是上游断了,而不是甩一句超时让人去猜。"""
    from types import SimpleNamespace

    from ibkr_agent.broker import BrokerError, BrokerRouter

    router = BrokerRouter(make_settings())
    router._QUALIFY_TIMEOUT = 0.05
    assert router.upstream_ok is True
    router._on_ib_connectivity(-1, 1100, "connectivity lost")
    assert router.upstream_ok is False

    with pytest.raises(BrokerError) as exc:
        router._qualify_or_raise(_StalledIB(), SimpleNamespace(conId=0))
    assert "1100" in str(exc.value)

    router._on_ib_connectivity(-1, 1102, "connectivity restored")   # TWS 自己重连上了
    assert router.upstream_ok is True


class _BarsIB:
    """按 durationStr 返回不同根数的假 TWS,用来验证退档逻辑。"""

    def __init__(self, by_duration):
        self.by_duration = by_duration
        self.asked = []

    def isConnected(self):
        return True

    def reqMarketDataType(self, kind):
        pass

    async def qualifyContractsAsync(self, contract):
        contract.conId = 1
        return [contract]

    def run(self, coro):
        import asyncio

        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()

    def reqHistoricalData(self, contract, **kwargs):
        from types import SimpleNamespace

        duration = kwargs["durationStr"]
        self.asked.append(duration)
        count = self.by_duration.get(duration, 0)
        return [
            SimpleNamespace(date="2026-08-19 09:%02d:00" % i, open=1.0, high=1.2,
                            low=0.9, close=1.1, volume=10)
            for i in range(count)
        ]


def _bars_router(settings, ib):
    from ibkr_agent.broker import BrokerRouter

    router = BrokerRouter(settings)
    router._connections["paper"] = ib
    return router


def test_intraday_bars_falls_back_to_a_longer_window_when_history_is_thin():
    """IBKR 的 durationStr 数的是**交易日**,全时段口径下傍晚就翻篇——
    刚过那个边界时第一档只能拿到十几根。实测踩到过:根数 10→17 一路涨,
    每刷新一次多一根,全是实时新增的,没有任何历史。必须自动退一档。"""
    ib = _BarsIB({"2 D": 12, "4 D": 400})          # 第一档太少,退档才够
    router = _bars_router(make_settings(), ib)
    bars = router.intraday_bars("NVDA", "1m")
    assert ib.asked == ["2 D", "4 D"]              # 确实退了一档
    assert len(bars) == 400


def test_intraday_bars_does_not_retry_when_the_first_window_is_enough():
    """够了就别再要一次:IBKR 对历史请求有节流,多余的重取是白白消耗配额。"""
    ib = _BarsIB({"2 D": 380})
    router = _bars_router(make_settings(), ib)
    assert len(router.intraday_bars("NVDA", "1m")) == 380
    assert ib.asked == ["2 D"]


def _router_with_sessions(settings, sessions, dead=()):
    """sessions: 连接名 → 可管账号列表;dead: 连不上的连接名。"""
    from ibkr_agent.broker import BrokerError, BrokerRouter

    router = BrokerRouter(settings)

    def fake_connect(name):
        if name in dead:
            raise BrokerError("连接 %s 失败(端口未监听)" % name)
        if name not in router._connections:
            router._connections[name] = _FakeIB(sessions[name])
        return router._connections[name]

    router.connect = fake_connect
    return router


def test_account_routes_to_session_that_actually_manages_it(settings):
    """配置写 paper→7497,但 TWS 只开了 live 连接且登录的是模拟账户 → 自动改道。"""
    paper_account = settings.account_by_alias("模拟")
    router = _router_with_sessions(
        settings, {"live": ["DU7654321"]}, dead={"paper"}
    )
    ib = router.for_account(paper_account)
    assert ib.managedAccounts() == ["DU7654321"]
    assert router._account_route["DU7654321"] == "live"   # 路由被缓存


def test_account_rejected_when_no_session_manages_it(settings):
    """所有会话都不管这个账户(比如 TWS 登录的是另一个人)→ 拒绝而不是错发。"""
    from ibkr_agent.broker import BrokerError

    live_account = settings.account_by_alias("主账户")
    router = _router_with_sessions(
        settings, {"paper": ["DU7654321"], "live": ["U9999999"]}
    )
    with pytest.raises(BrokerError, match="找不到对应会话"):
        router.for_account(live_account)


def test_account_uses_configured_connection_when_it_matches(settings):
    paper_account = settings.account_by_alias("模拟")
    router = _router_with_sessions(
        settings, {"paper": ["DU7654321"], "live": ["U1234567"]}
    )
    ib = router.for_account(paper_account)
    assert ib.managedAccounts() == ["DU7654321"]


def test_empty_managed_list_only_trusted_on_configured_connection(settings):
    """会话不报账户列表时:配置指定的连接放行,扫描到的其他连接不放行。"""
    from ibkr_agent.broker import BrokerError

    paper_account = settings.account_by_alias("模拟")
    router = _router_with_sessions(settings, {"paper": [], "live": []})
    assert router.for_account(paper_account) is router._connections["paper"]

    router2 = _router_with_sessions(settings, {"live": []}, dead={"paper"})
    with pytest.raises(BrokerError, match="找不到对应会话"):
        router2.for_account(paper_account)


class _QuoteIB(_FakeIB):
    """带盘口的假会话:记录行情模式切换,验证纸面/实盘的延迟数据边界。"""

    def __init__(self, managed, bid=1.1, ask=1.3):
        super().__init__(managed)
        self.data_types = []
        self.bid, self.ask = bid, ask
        self.sleeps = 0

    def reqMarketDataType(self, kind):
        self.data_types.append(kind)

    def qualifyContracts(self, *contracts):   # 真实签名是 *contracts,批量确认一次往返
        for contract in contracts:
            contract.conId = 1
        return list(contracts)

    # 真实的 IB 对象既有同步也有 async 版本,合约确认走的是 async 那条
    # (它是库里唯一没有 timeout 参数的阻塞调用,必须能被 wait_for 掐断)。
    # 替身要跟着提供,否则测的就不是生产代码真正走的路径。
    async def qualifyContractsAsync(self, *contracts):
        return self.qualifyContracts(*contracts)

    def run(self, coro):
        import asyncio

        return asyncio.new_event_loop().run_until_complete(coro)

    def reqMktData(self, *args, **kwargs):
        from types import SimpleNamespace

        return SimpleNamespace(bid=self.bid, ask=self.ask)

    def sleep(self, seconds):
        self.sleeps += 1


def test_leg_quotes_delayed_fallback_only_for_paper(settings):
    from ibkr_agent.models import ParsedOrder

    contract = ParsedOrder.model_validate(spread_order()).contract
    paper = settings.account_by_alias("模拟")
    live = settings.account_by_alias("主账户")

    router = _router_with_sessions(settings, {"paper": ["DU7654321"], "live": ["U1234567"]})
    router._connections["paper"] = _QuoteIB(["DU7654321"])
    router._connections["live"] = _QuoteIB(["U1234567"])

    quotes = router.leg_quotes(contract, paper)
    assert len(quotes) == 2 and quotes[0].bid == 1.1
    assert router._connections["paper"].data_types == [3, 1]   # 纸面:延迟兜底,用完切回
    assert router._connections["paper"].sleeps == 1            # 各腿一起轮询,盘口有效即提前退出(串行时是每腿一次)

    router.leg_quotes(contract, live)
    assert router._connections["live"].data_types == []        # 实盘:绝不碰延迟数据


def test_extract_symbols_reads_lowercase_ticker_in_chinese_context(settings):
    """"买入be10股":紧贴中文/数字的小写拉丁串是 ticker,即使撞上英文停用词。"""
    assert "BE" in extract_symbols("买入be10股", settings)
    assert "ON" in extract_symbols("市价买入on20股", settings)
    # 纯英文句子里的同形单词不误伤
    english = extract_symbols("wait for the price to be on the low side", settings)
    assert "BE" not in english and "ON" not in english
    # 长英文单词的切片不是 ticker
    assert "MARKE" not in extract_symbols("place a market order", settings)


def test_extract_symbols_falls_back_to_spx_when_nothing_found(settings):
    """'7520的20cm蝴蝶'这类指令通篇没有 ticker,默认标的 SPX 的现价快照必须补上。"""
    assert extract_symbols("7520的20cm蝴蝶 2.5", settings) == ["SPX"]
    # 抽到了别的标的就不添乱
    assert "SPX" not in extract_symbols("市价买入 QQQ 10 股", settings)


# ---- 下单纯计算 ---------------------------------------------------------
def test_combo_mid_price_is_net_debit():
    legs = [
        LegQuote("BUY", 1, bid=12.0, ask=13.0),   # mid 12.5
        LegQuote("SELL", 1, bid=4.0, ask=5.0),    # mid 4.5
    ]
    assert combo_mid_price(legs) == pytest.approx(8.0)


def test_combo_mid_rejects_broken_quotes():
    with pytest.raises(Exception, match="盘口不可用"):
        combo_mid_price([LegQuote("BUY", 1, bid=0.0, ask=13.0)])


def test_auto_mid_limit_applies_slippage_and_width_cap():
    assert auto_mid_limit(8.0, "BUY", 0.10, strike_width=30.0) == pytest.approx(8.10)
    # 贷方(SELL)组合:净中间价为负(收权利金),让价方向朝 0(少收一点)。
    # BAG 一律以 BUY + 带符号净价提交(IBKR 对 BAG 的 SELL 会反转腿方向)。
    assert auto_mid_limit(-4.0, "SELL", 0.10) == pytest.approx(-3.90)
    # 数学上限:借方净权利金不可能超过行权价差
    assert auto_mid_limit(29.99, "BUY", 0.50, strike_width=30.0) == pytest.approx(30.0)
    # 方向不一致 = 修复前会反向建仓的场景,必须拒绝
    with pytest.raises(Exception, match="反向建仓"):
        auto_mid_limit(8.0, "SELL", 0.10)
    with pytest.raises(Exception, match="反向建仓"):
        auto_mid_limit(-4.0, "BUY", 0.10)


def test_price_condition_direction():
    up = TriggerSpec(symbol="SPX", secType="IND", operator=">=", value=7500.0)
    down = TriggerSpec(symbol="SPX", secType="IND", operator="<=", value=7400.0)
    assert price_condition_spec(up)["isMore"] is True
    assert price_condition_spec(down)["isMore"] is False


# ---- 落库 ---------------------------------------------------------------
def _record(signature="模拟|BUY|STK|AAPL", qty=100):
    return {
        "input": {"raw_instruction": "买入 AAPL 100股 limit 230", "reason": "回调",
                  "input_channel": "manual"},
        "llm": {"prompt_version": "v1.0.0"},
        "account": {"account_id": "DU7654321", "alias": "模拟", "is_paper": True},
        "contract": {"symbol": "AAPL", "secType": "STK"},
        "order": {"totalQuantity": qty, "action": "BUY"},
        "signature": signature,
    }


def test_validated_only_records_do_not_trigger_duplicate_debounce(tmp_path):
    """「先校验、再发送」是界面引导的流程:纯校验记录绝不能挡住随后的真发送。"""
    from datetime import datetime, timezone

    store = TradeStore(tmp_path / "t.db")
    now = datetime.now(timezone.utc)

    validated = store.create_record(_record())
    store.append_event(validated, "status", {"status": "ValidatedOnly"})
    assert store.recent_orders(10, now) == []   # 没出过手,不算已下单

    submitted = store.create_record(_record())
    store.append_event(submitted, "status", {"status": "Submitted", "order_id": 1})
    assert len(store.recent_orders(10, now)) == 1   # 真提交的才进防抖候选集

    queued = store.create_record(_record(signature="模拟|BUY|STK|TSLA"))
    store.append_event(queued, "status", {"status": "PendingTrigger"})
    signatures = {r.signature for r in store.recent_orders(10, now)}
    assert signatures == {"模拟|BUY|STK|AAPL", "模拟|BUY|STK|TSLA"}


def test_store_is_append_only(tmp_path):
    store = TradeStore(tmp_path / "t.db")
    record_id = store.create_record(_record())
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        store._conn.execute("UPDATE trade_records SET symbol='X' WHERE id=?", (record_id,))
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        store._conn.execute("DELETE FROM trade_records WHERE id=?", (record_id,))


def test_events_fold_into_the_section6_document(tmp_path):
    store = TradeStore(tmp_path / "t.db")
    record_id = store.create_record(_record())
    store.append_event(record_id, "status", {"status": "Submitted", "order_id": 1024, "perm_id": 7788})
    store.append_event(record_id, "fill", {"price": 229.87, "qty": 60, "commission": 0.6})
    store.append_event(record_id, "fill", {"price": 230.07, "qty": 40, "commission": 0.4})
    store.set_final_status(record_id, "filled")

    record = store.get_record(record_id)
    assert record["ibkr"]["order_id"] == 1024
    assert record["ibkr"]["perm_id"] == 7788
    assert len(record["ibkr"]["fills"]) == 2
    assert record["ibkr"]["avg_fill_price"] == pytest.approx(229.95)
    assert record["ibkr"]["total_commission"] == pytest.approx(1.0)
    assert record["final_status"] == "filled"
    assert record["input"]["raw_instruction"].startswith("买入 AAPL")


def test_unknown_final_status_is_refused(tmp_path):
    store = TradeStore(tmp_path / "t.db")
    record_id = store.create_record(_record())
    with pytest.raises(ValueError, match="未知终态"):
        store.set_final_status(record_id, "probably_fine")


def test_recent_orders_window(tmp_path):
    store = TradeStore(tmp_path / "t.db")
    now = datetime.now(tz=ET)
    fresh = _record()
    fresh["created_at"] = now.isoformat()
    store.append_event(store.create_record(fresh), "status", {"status": "Submitted"})
    stale = _record()
    stale["created_at"] = (now - timedelta(hours=2)).isoformat()
    store.append_event(store.create_record(stale), "status", {"status": "Submitted"})

    assert len(store.recent_orders(10, now)) == 1
    assert len(store.recent_orders(300, now)) == 2


def test_purge_requires_exact_confirmation(tmp_path):
    store = TradeStore(tmp_path / "t.db")
    store.create_record(_record())
    with pytest.raises(ValueError, match="确认口令"):
        store.purge_everything("yes")


def test_account_redaction():
    assert redact_account("DU7654321") == "DU***321"
    assert redact_account("") == ""


# ---------------------------------------------------------------- 配置里的 ~
def test_db_path_with_a_tilde_is_expanded_to_the_home_directory(tmp_path):
    """配置里的 `~/…` 必须展开成家目录,不能当成一个叫 `~` 的普通目录。

    不展开的后果不是报错,是**静悄悄写到别的地方**:TS 侧曾经把它当字面目录名,
    相对 cwd 建出一个叫 `~` 的文件夹(2026-09-04 实测:项目根目录下真的多出来一个,
    WAL 有 1.5MB)。同一份配置、两个库,切引擎时交易记录、追踪、想法全部"消失"。
    """
    import json
    from pathlib import Path

    from ibkr_agent.config import load_settings

    raw = json.loads(json.dumps(BASE_CONFIG))
    raw["storage"] = {"db_path": "~/Library/Application Support/dafri/trades.db"}
    cfg = tmp_path / "settings.json"
    cfg.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")

    settings = load_settings(cfg)
    assert "~" not in str(settings.db_path)
    assert settings.db_path == Path.home() / "Library/Application Support/dafri/trades.db"
    assert settings.db_path.is_absolute()

    # 绝对路径与相对路径都原样保留(只有开头的 ~ 才展开)
    for literal in (str(tmp_path / "a.db"), "data/b.db"):
        raw["storage"] = {"db_path": literal}
        cfg.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        assert str(load_settings(cfg).db_path) == str(Path(literal))


# ---------------------------------------------------------------- 最小价格变动
def test_auto_mid_limit_aligns_to_the_minimum_tick():
    """AUTO_MID 的限价必须落在合法档位上,否则 IBKR 当场退单(错误 110)。

    2026-09-04 纸面实测:一张 SPX 蝶的中间价 0.125 + 滑点 0.05 = 0.1750,那是 3.5 个 tick,
    IBKR 回「110 价格不符合该合约的最小价格变动要求」,单子根本没进订单簿。
    IBKR 对 BAG 不给 contractDetails,但每条 SPX 期权腿实测 minTick=0.05。
    """
    from ibkr_agent.broker import (DEFAULT_COMBO_TICK, align_tick_down, align_tick_up,
                                   auto_mid_limit)

    assert DEFAULT_COMBO_TICK == 0.05
    # 那次失败的定价:0.175 → 0.20
    assert auto_mid_limit(0.125, "BUY", 0.05, 10.0) == 0.2
    # 已经对齐的值不能被浮点误差推到下一档
    for v in (0.05, 0.10, 0.15, 0.20, 2.25, 12.35):
        assert align_tick_up(v) == v, v
    assert align_tick_up(0.1750) == 0.2
    assert align_tick_up(12.34) == 12.35
    assert align_tick_down(12.36) == 12.35

    # 贷方:限价是负数,同样向上对齐 = 少收一点 = 更容易成交
    credit = auto_mid_limit(-12.34, "SELL", 0.05)
    assert credit == -12.25 and credit % 0.05 == pytest.approx(0.0, abs=1e-9)

    # 借方仍受翼宽上限约束,且夹完之后依然是合法档位
    capped = auto_mid_limit(19.99, "BUY", 0.5, 20.0)
    assert capped == 20.0

    # 每个结果都必须是 tick 的整数倍——这条是这个测试真正要守的东西
    for mid, action, slip in ((0.125, "BUY", 0.05), (1.07, "BUY", 0.03), (3.33, "BUY", 0.1),
                              (-2.07, "SELL", 0.02), (-9.99, "SELL", 0.005)):
        out = auto_mid_limit(mid, action, slip)
        assert abs(round(out / 0.05) * 0.05 - out) < 1e-9, (mid, action, slip, out)
