"""JSON-RPC sidecar(§10.1)。Electron 那一侧的所有能力都从这里过,闸门要有测试。"""
from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from conftest import BASE_CONFIG, stock_order
from ibkr_agent.rpc import RpcServer


@pytest.fixture
def server(tmp_path):
    config = dict(BASE_CONFIG)
    config["storage"] = {"db_path": str(tmp_path / "trades.db")}
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
    return RpcServer(path, stdout=io.StringIO(), stdin=io.StringIO())


def call(server: RpcServer, method: str, params=None):
    server._handle({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})
    lines = [json.loads(l) for l in server.stdout.getvalue().splitlines() if l.strip()]
    server.stdout.seek(0)
    server.stdout.truncate()
    return [m for m in lines if m.get("id") == 1][-1]


def events(server: RpcServer):
    return [
        json.loads(l)["params"]["event"]
        for l in server.stdout.getvalue().splitlines()
        if l.strip() and json.loads(l).get("method") == "event"
    ]


def test_unknown_method_is_rejected(server):
    response = call(server, "shell.exec")
    assert response["error"]["code"] == -32601


def test_status_reports_the_three_gates(server):
    result = call(server, "system.status")["result"]
    assert result["auto_execute"] is False
    assert result["allow_live_trading"] is False
    assert result["breaker"]["engaged"] is False
    assert result["market_status"] in {"盘前", "盘中", "盘后", "休市"}
    assert result["prompt_version"] == "v1.8.0"


def test_accounts_are_masked_over_the_wire(server):
    """§9.3:真实账号不该整个送到界面。"""
    accounts = call(server, "system.status")["result"]["accounts"]
    aliases = {a["alias"]: a for a in accounts}
    assert aliases["模拟"]["account_masked"] == "DU***321"
    assert all("account_id" not in a for a in accounts)


# ---- 想法备忘 -----------------------------------------------------------
def test_idea_roundtrip_with_symbol_tags(server):
    added = call(server, "ideas.add", {"text": "AXTI 周五尾盘买入"})["result"]["idea"]
    assert added["status"] == "active"
    assert "AXTI" in added["symbols"]

    ideas = call(server, "ideas.list", {"status": "active"})["result"]["ideas"]
    assert [i["id"] for i in ideas] == [added["id"]]

    updated = call(server, "ideas.update", {"id": added["id"], "status": "done"})["result"]
    assert updated["status"] == "done"
    assert call(server, "ideas.list", {"status": "active"})["result"]["ideas"] == []
    assert call(server, "ideas.list", {})["result"]["ideas"][0]["status"] == "done"


def test_idea_analyze_stores_result_with_fake_llm(server, monkeypatch):
    added = call(server, "ideas.add", {"text": "AXTI 周五尾盘买入"})["result"]["idea"]
    assert added["analysis"] is None

    class FakeParser:
        def complete_json(self, system, user, schema):
            assert "AXTI 周五尾盘买入" in user
            assert "当前美东时间" in user
            return {
                "summary": "押注 AXT 周五尾盘动量",
                "thesis": "半导体材料需求回暖",
                "checks": ["确认 AXTI 流动性", "查财报日期"],
                "risks": ["小盘股滑点大"],
                "suggestion": "改写为:周五 15:50 后限价买入 AXTI 100 股",
            }

    import ibkr_agent.rpc as rpc_mod

    monkeypatch.setattr(rpc_mod, "build_parser", lambda cfg: FakeParser())
    idea = call(server, "ideas.analyze", {"id": added["id"]})["result"]["idea"]
    assert idea["analysis"]["summary"].startswith("押注")
    assert idea["analysis"]["model"]  # 记录了用哪个模型分析的

    # 分析结果持久化:重新 list 还在
    listed = call(server, "ideas.list", {})["result"]["ideas"][0]
    assert listed["analysis"]["checks"] == ["确认 AXTI 流动性", "查财报日期"]


def test_idea_digest_summarizes_archived_ideas_and_persists(server, monkeypatch):
    """归档不是丢弃:攒起来的想法要能一键总结成知识,总结本身也落库可回看。"""
    first = call(server, "ideas.add", {"text": "AXTI 周五尾盘买入"})["result"]["idea"]
    second = call(server, "ideas.add", {"text": "NVDA 回调到 120 日均线低吸"})["result"]["idea"]
    call(server, "ideas.update", {"id": first["id"], "status": "archived"})
    call(server, "ideas.update", {"id": second["id"], "status": "archived"})

    class FakeParser:
        def complete_json(self, system, user, schema):
            # 两条想法都要在场,且按时间从早到晚
            assert user.index("AXTI") < user.index("NVDA")
            assert "已归档" in user
            return {
                "summary": "偏好尾盘动量与均线低吸",
                "themes": ["半导体(2 条)"],
                "lessons": ["想法都带了明确价位条件"],
                "patterns": ["具体可执行"],
                "actions": ["给 NVDA 建一个 120 日均线价位警告"],
            }

    import ibkr_agent.rpc as rpc_mod

    monkeypatch.setattr(rpc_mod, "build_parser", lambda cfg: FakeParser())
    digest = call(server, "ideas.digest", {})["result"]["digest"]
    assert digest["digest"]["summary"].startswith("偏好")
    assert digest["idea_count"] == 2
    assert digest["digest"]["model"]      # 记录了用哪个模型总结的

    # 总结历史落库:重新 list 还在,最新的在前
    listed = call(server, "ideas.digests", {})["result"]["digests"]
    assert len(listed) == 1
    assert listed[0]["digest"]["summary"].startswith("偏好")
    assert listed[0]["idea_ids"] == [first["id"], second["id"]] or \
        set(listed[0]["idea_ids"]) == {first["id"], second["id"]}


def test_idea_digest_refuses_when_nothing_is_archived(server):
    call(server, "ideas.add", {"text": "还在进行中的想法"})
    response = call(server, "ideas.digest", {})
    assert response["error"]["code"] == -32602
    assert "归档" in response["error"]["message"]
    assert call(server, "ideas.digest", {"scope": "nope"})["error"]["code"] == -32602


def test_idea_symbols_never_fall_back_to_spx(server):
    """想法没提标的就是没提:不能兜底 SPX,否则分析会拿错行情。"""
    idea = call(server, "ideas.add", {"text": "感觉市场情绪过热,要谨慎"})["result"]["idea"]
    assert idea["symbols"] == []
    lowercase = call(server, "ideas.add", {"text": "axti上周五尾盘买入"})["result"]["idea"]
    assert lowercase["symbols"] == ["AXTI"]


def test_idea_analyze_reextracts_and_heals_stale_symbols(server, monkeypatch):
    """老想法存了错误标签(曾被兜底成 SPX):分析时按原文重抽并自愈。"""
    added = call(server, "ideas.add", {"text": "axti上周五尾盘买入"})["result"]["idea"]
    server.engine.store.set_idea_symbols(added["id"], ["SPX"])   # 模拟历史坏数据

    class FakeParser:
        def complete_json(self, system, user, schema):
            assert "AXTI" in user and "SPX 现价" not in user
            return {"summary": "s", "thesis": "", "checks": [], "risks": [], "suggestion": ""}

    import ibkr_agent.rpc as rpc_mod

    monkeypatch.setattr(rpc_mod, "build_parser", lambda cfg: FakeParser())
    idea = call(server, "ideas.analyze", {"id": added["id"]})["result"]["idea"]
    assert idea["symbols"] == ["AXTI"]
    assert idea["analysis"]["symbol"] == "AXTI"


def test_idea_analyze_collects_symbol_brief_when_connected(server, monkeypatch):
    """连接 TWS 时:先用代码算标的情报,注入提示词并随分析一起落库。"""
    added = call(server, "ideas.add", {"text": "NVDA 回调到位,考虑低吸"})["result"]["idea"]
    assert added["symbols"] == ["NVDA"]

    class FakeRouter:
        def sessions(self):
            return [object()]

        def historical_bars(self, symbol, start, end):
            assert symbol == "NVDA"
            from datetime import date, timedelta
            day, bars = date(2026, 1, 5), []
            for i in range(80):
                while day.weekday() >= 5:
                    day += timedelta(days=1)
                close = 200.0 + i
                bars.append({"date": day.isoformat(), "open": close, "high": close + 2,
                             "low": close - 2, "close": close})
                day += timedelta(days=1)
            return bars

    class FakeParser:
        def complete_json(self, system, user, schema):
            assert "标的行情情报" in user and "现价 279.0" in user   # 情报进了提示词
            assert "自营交易员" in system
            return {"summary": "顺势想法,但已贴近高点", "thesis": "t", "checks": [],
                    "risks": ["追高风险"], "suggestion": "等回踩 50 日线"}

    import ibkr_agent.rpc as rpc_mod

    server.router = FakeRouter()
    monkeypatch.setattr(rpc_mod, "build_parser", lambda cfg: FakeParser())
    idea = call(server, "ideas.analyze", {"id": added["id"]})["result"]["idea"]
    assert idea["analysis"]["symbol"] == "NVDA"
    assert idea["analysis"]["brief"]["last"] == 279.0
    assert idea["analysis"]["brief"]["vs_sma50_pct"] > 0
    server.router = None


def test_idea_analyze_rejects_bad_llm_output(server, monkeypatch):
    added = call(server, "ideas.add", {"text": "看多黄金"})["result"]["idea"]

    class BadParser:
        def complete_json(self, system, user, schema):
            return {"wrong_field": True}

    import ibkr_agent.rpc as rpc_mod

    monkeypatch.setattr(rpc_mod, "build_parser", lambda cfg: BadParser())
    assert call(server, "ideas.analyze", {"id": added["id"]})["error"]["code"] == -32011
    assert call(server, "ideas.list", {})["result"]["ideas"][0]["analysis"] is None


def test_sector_lifecycle_with_fake_llm_picker(server, monkeypatch):
    added = call(server, "sectors.add", {"name": "AI 算力"})["result"]["sector"]
    assert added["stocks"] == []
    assert call(server, "sectors.add", {"name": "AI 算力"})["error"]["code"] == -32602  # 重名

    class FakeParser:
        def complete_json(self, system, user, schema):
            assert "AI 算力" in user
            return {
                "stocks": [
                    {"symbol": "nvda", "company": "英伟达", "reason": "GPU 龙头"},
                    {"symbol": "NVDA", "company": "重复条目", "reason": "应被去重"},
                    {"symbol": "AVGO", "company": "博通", "reason": "定制 ASIC"},
                ]
            }

    import ibkr_agent.rpc as rpc_mod

    monkeypatch.setattr(rpc_mod, "build_parser", lambda cfg: FakeParser())
    sector = call(server, "sectors.pick", {"id": added["id"]})["result"]["sector"]
    assert [s["symbol"] for s in sector["stocks"]] == ["NVDA", "AVGO"]  # 大写化 + 去重

    sectors = call(server, "sectors.list")["result"]["sectors"]
    assert len(sectors) == 1

    # 引擎未连 TWS:报价接口如实说没连,不报错
    quotes = call(server, "sectors.quotes")["result"]
    assert quotes["connected"] is False and quotes["quotes"] == {}

    assert call(server, "sectors.delete", {"id": added["id"]})["result"]["deleted"] == added["id"]
    assert call(server, "sectors.list")["result"]["sectors"] == []


def test_sector_manual_stock_add_and_remove(server):
    added = call(server, "sectors.add", {"name": "光模块"})["result"]["sector"]

    sector = call(server, "sectors.add_stock", {"id": added["id"], "symbol": "anet"})["result"]["sector"]
    assert sector["stocks"][0]["symbol"] == "ANET"  # 自动大写
    assert sector["stocks"][0]["reason"] == "手动添加"

    # 重复添加与非法代码都拒绝
    assert call(server, "sectors.add_stock", {"id": added["id"], "symbol": "ANET"})["error"]["code"] == -32602
    assert call(server, "sectors.add_stock", {"id": added["id"], "symbol": "买入100股"})["error"]["code"] == -32602

    sector = call(server, "sectors.remove_stock", {"id": added["id"], "symbol": "ANET"})["result"]["sector"]
    assert sector["stocks"] == []
    assert call(server, "sectors.remove_stock", {"id": added["id"], "symbol": "ANET"})["error"]["code"] == -32602


def test_sector_pick_rejects_bad_llm_output(server, monkeypatch):
    added = call(server, "sectors.add", {"name": "减肥药"})["result"]["sector"]

    class BadParser:
        def complete_json(self, system, user, schema):
            return {"stocks": [{"symbol": "买入 100 股;rm -rf", "company": "", "reason": ""}]}

    import ibkr_agent.rpc as rpc_mod

    monkeypatch.setattr(rpc_mod, "build_parser", lambda cfg: BadParser())
    response = call(server, "sectors.pick", {"id": added["id"]})
    assert response["error"]["code"] == -32010  # ticker 形状复验拦下
    assert call(server, "sectors.list")["result"]["sectors"][0]["stocks"] == []  # 没落库


def test_backtest_strategies_catalog(server):
    strategies = call(server, "backtest.strategies")["result"]["strategies"]
    keys = {s["key"] for s in strategies}
    assert {"buy_hold", "sma_cross", "rsi", "breakout"} <= keys


def test_backtest_parse_rules_via_fake_llm(server, monkeypatch):
    class FakeParser:
        def complete_json(self, system, user, schema):
            assert "RSI" in user
            return {
                "entry": [
                    {"left": {"kind": "indicator", "name": "rsi", "period": 14},
                     "op": "<", "right": {"kind": "const", "value": 30}},
                ],
                "exit": [],
            }

    import ibkr_agent.rpc as rpc_mod

    monkeypatch.setattr(rpc_mod, "build_parser", lambda cfg: FakeParser())
    rules = call(server, "backtest.parse_rules", {"text": "RSI跌破30买入"})["result"]["rules"]
    assert rules["entry"][0]["op"] == "<"

    class BadParser:
        def complete_json(self, system, user, schema):
            return {"entry": [{"left": {"kind": "indicator", "name": "magic"}, "op": ">",
                              "right": {"kind": "const", "value": 1}}], "exit": []}

    monkeypatch.setattr(rpc_mod, "build_parser", lambda cfg: BadParser())
    assert call(server, "backtest.parse_rules", {"text": "玄学指标"})["error"]["code"] == -32013


def test_backtest_run_rejects_bad_custom_rules_before_broker(server):
    spec = {
        "symbol": "NVDA", "start": "2026-01-01", "end": "2026-06-01", "strategy": "custom",
        "rules": {"entry": [{"left": {"kind": "indicator", "name": "sma"}, "op": ">",
                            "right": {"kind": "const", "value": 1}}], "exit": []},
    }
    response = call(server, "backtest.run", spec)  # sma 缺 period → 校验层先拦,不碰券商
    assert response["error"]["code"] == -32602
    assert "period" in response["error"]["message"]


def test_backtest_run_validates_before_touching_broker(server):
    ok = {"symbol": "NVDA", "start": "2026-01-01", "end": "2026-06-01", "strategy": "sma_cross"}
    assert call(server, "backtest.run", {**ok, "symbol": "买入;rm"})["error"]["code"] == -32602
    assert call(server, "backtest.run", {**ok, "start": "01/01/2026"})["error"]["code"] == -32602
    assert call(server, "backtest.run", {**ok, "start": "2026-07-01"})["error"]["code"] == -32602  # 起止倒置
    # 参数合法但引擎没连 TWS → 明确提示,而不是深处报错
    response = call(server, "backtest.run", ok)
    assert response["error"]["code"] == -32012
    assert "TWS" in response["error"]["message"]


class FakeBarRouter:
    """只实现 PA 链路用到的两个方法,记下每次真正取数的调用。"""

    def __init__(self):
        self.calls = []

    def sessions(self):
        return ["session"]

    def intraday_bars(self, symbol, timeframe, rth=True):
        self.calls.append((symbol, timeframe, rth))
        base = 100.0 if timeframe != "1h" else 200.0
        rows = []
        for i in range(80):
            close = base + i * 0.5 + (2.0 if i % 7 == 0 else 0.0)
            open_ = rows[-1]["close"] if rows else close
            rows.append(
                {
                    "time": "2026-08-17 %02d:%02d" % (9 + (30 + i * 5) // 60, (30 + i * 5) % 60),
                    "open": open_, "high": max(open_, close) + 0.4,
                    "low": min(open_, close) - 0.4, "close": close, "volume": 1000.0,
                }
            )
        return rows


class _PriceRouter:
    """只喂现价的假 router,用来跑警告状态机。"""

    def __init__(self, price):
        self.price = price

    def sessions(self):
        return ["session"]

    def stream_quotes(self, symbols):
        return {s: {"last": self.price, "close": self.price, "change_pct": 0.0} for s in symbols}

    def option_chain(self, symbol, expiry=None, width=10):
        from ibkr_agent.broker import BrokerError

        raise BrokerError("%s 没有可用的期权链" % symbol)


def test_option_wall_validates_symbol_and_connection(server):
    assert call(server, "options.wall", {"symbol": "买入100股"})["error"]["code"] == -32602
    response = call(server, "options.wall", {"symbol": "IREN"})
    assert response["error"]["code"] == -32017
    assert "TWS" in response["error"]["message"]


def test_alert_watch_round_trip(server):
    assert call(server, "alerts.create", {"symbol": "买;rm -rf"})["error"]["code"] == -32602

    watch = call(server, "alerts.create", {"symbol": "iren", "step": 5})["result"]["watch"]
    assert watch["symbol"] == "IREN" and watch["step"] == 5.0
    assert call(server, "alerts.create", {"symbol": "IREN"})["error"]["code"] == -32602  # 重复

    assert [w["symbol"] for w in call(server, "alerts.list")["result"]["watches"]] == ["IREN"]
    assert call(server, "alerts.delete", {"id": watch["id"]})["result"]["deleted"] == watch["id"]
    assert call(server, "alerts.delete", {"id": watch["id"]})["error"]["code"] == -32602


def test_alert_refresh_falls_back_to_round_numbers_without_an_option_chain(server):
    """没有期权链(没连 TWS / 标的没期权)时,整数关口照样要能用 ——
    它不依赖期权数据,这时候直接失败就把功能废掉一半。"""
    server.router = _PriceRouter(41.0)
    watch = call(server, "alerts.create", {"symbol": "IREN", "step": 5})["result"]["watch"]
    result = call(server, "alerts.refresh", {"id": watch["id"]})["result"]
    refreshed = result["watch"]
    assert "期权链" in (result["wall_error"] or "")   # 降级可以,但不能悄悄降级
    prices = [l["price"] for l in refreshed["levels"]]
    assert prices == [40.0, 45.0]           # IREN 41 块 → 40 和 45
    assert refreshed["last_price"] == 41.0


class _HistoryRouter(_PriceRouter):
    """现价 + 日线历史都有的假 router,用来跑均线/52周位。"""

    def __init__(self, price, closes):
        super().__init__(price)
        self.closes = closes
        self.history_calls = 0

    def historical_bars(self, symbol, start, end):
        self.history_calls += 1
        return [
            {"date": "2026-01-01", "open": c, "high": c, "low": c, "close": c}
            for c in self.closes
        ]


def test_alert_refresh_adds_ma_and_52w_levels_from_daily_history(server):
    """用户预先选好标的,重算后价位里就有 60/120/200 日均线和 52 周高低点;
    之后 poll 到价穿过均线时会像其他价位一样自动通知。"""
    server.router = _HistoryRouter(41.0, [40.0 + i * 0.1 for i in range(300)])
    watch = call(server, "alerts.create", {"symbol": "IREN", "step": 5})["result"]["watch"]
    result = call(server, "alerts.refresh", {"id": watch["id"]})["result"]

    sources = {l["source"] for l in result["watch"]["levels"]}
    assert {"ma60", "ma120", "ma200", "low_52w", "high_52w"} <= sources
    assert result["history_error"] is None
    # 趋势摘要给界面:52 周低点是最后 250 根里的最低价,不是全历史
    assert result["trend"]["low_52w"] == 45.0
    assert result["trend"]["high_52w"] == 69.9

    # 日线历史有 TTL 缓存:紧接着再刷新不该再打一次券商
    call(server, "alerts.refresh", {"id": watch["id"]})
    assert server.router.history_calls == 1


def test_alert_refresh_degrades_loudly_when_history_is_unavailable(server):
    """拿不到日线(额度用完/没权限/券商不支持)时降级继续——
    整数关口照样能用,但失败原因必须带回界面,不能悄悄降级。"""
    server.router = _PriceRouter(41.0)   # 没有 historical_bars
    watch = call(server, "alerts.create", {"symbol": "IREN", "step": 5})["result"]["watch"]
    result = call(server, "alerts.refresh", {"id": watch["id"]})["result"]
    assert result["history_error"]
    assert result["trend"] is None
    assert [l["price"] for l in result["watch"]["levels"]] == [40.0, 45.0]


def test_alert_poll_fires_once_on_a_crossing_and_notifies(server):
    server.router = _PriceRouter(41.0)
    watch = call(server, "alerts.create", {"symbol": "IREN", "step": 5})["result"]["watch"]
    call(server, "alerts.refresh", {"id": watch["id"]})

    # 第一次只登记价格,不报警
    assert call(server, "alerts.poll")["result"]["fired"] == []

    server.router.price = 39.8                     # 跌破 40
    fired = call(server, "alerts.poll")["result"]["fired"]
    assert len(fired) == 1
    assert fired[0]["price"] == 40.0 and fired[0]["direction"] == "down"
    assert fired[0]["symbol"] == "IREN"

    # 在关口附近来回蹭不该刷屏
    for price in (40.05, 39.95, 40.02, 39.9):
        server.router.price = price
        assert call(server, "alerts.poll")["result"]["fired"] == []


def test_alert_poll_is_a_noop_without_any_watch(server):
    server.router = _PriceRouter(41.0)
    assert call(server, "alerts.poll")["result"] == {"fired": [], "checked": []}


def test_pa_timeframes_lists_the_catalog(server):
    result = call(server, "pa.timeframes")["result"]
    keys = {tf["key"] for tf in result["timeframes"]}
    assert {"1m", "5m", "1h", "1d"} <= keys
    assert result["min_interval"] >= 15   # IBKR 的相同历史请求节流下限


def test_pa_analyze_validates_before_touching_broker(server):
    assert call(server, "pa.analyze", {"symbol": "买入100股"})["error"]["code"] == -32602
    assert call(server, "pa.analyze", {"symbol": "NVDA", "timeframe": "7m"})["error"]["code"] == -32602
    response = call(server, "pa.analyze", {"symbol": "NVDA", "timeframe": "5m"})
    assert response["error"]["code"] == -32015
    assert "TWS" in response["error"]["message"]


def test_pa_analyze_returns_structure_and_higher_timeframe(server):
    server.router = FakeBarRouter()
    result = call(server, "pa.analyze", {"symbol": "NVDA", "timeframe": "5m"})["result"]
    assert result["symbol"] == "NVDA" and result["bias"] in {
        "bullish", "lean_bull", "neutral", "lean_bear", "bearish"
    }
    # 分数必须等于公开出来的证据之和,界面上那张表才可信
    assert round(sum(e["weight"] for e in result["evidence"]), 1) == result["score"]
    assert result["htf"]["timeframe"] == "1h"          # 5 分钟的高周期是 1 小时
    assert result["agreement"]["state"] in {"aligned", "conflict", "unclear", "unknown"}
    assert result["bars"] and "close" in result["bars"][0]


def test_every_timeframe_has_a_longer_fallback_window():
    """IBKR 的 durationStr 数的是交易日,全时段口径下傍晚就翻篇。
    第一档拿不到足够历史时必须有第二档可退,否则刚过边界那阵子页面是空的。"""
    from ibkr_agent.priceaction import TIMEFRAMES

    def days(text):
        n, unit = text.split()
        return int(n) * (365 if unit == "Y" else 1)

    for key, spec in TIMEFRAMES.items():
        assert spec.get("fallback"), "%s 没有 fallback 窗口" % key
        assert days(spec["fallback"]) > days(spec["duration"]), "%s 的 fallback 没更长" % key


def test_pa_analyze_defaults_to_the_full_session(server):
    """默认必须是全时段:只取盘中的话,收盘后 K 线会停在昨天 16:00。"""
    server.router = FakeBarRouter()
    result = call(server, "pa.analyze", {"symbol": "NVDA", "timeframe": "5m"})["result"]
    assert result["rth"] is False
    assert server.router.calls[0][2] is False        # 传给 broker 的就是 False
    assert any("盘前盘后" in w for w in result["warnings"])
    # 显式要求只看盘中时照办
    only = call(server, "pa.analyze", {"symbol": "NVDA", "timeframe": "5m", "rth": True})["result"]
    assert only["rth"] is True


def test_pa_analyze_throttles_repeat_requests(server):
    """IBKR 对 15 秒内的相同历史请求判超频;界面 20 秒自动刷新必须被引擎挡住。"""
    server.router = FakeBarRouter()
    spec = {"symbol": "NVDA", "timeframe": "5m"}
    first = call(server, "pa.analyze", spec)["result"]
    calls_after_first = len(server.router.calls)
    second = call(server, "pa.analyze", spec)["result"]
    assert second["cached"] is True
    assert first["cached"] is False
    assert len(server.router.calls) == calls_after_first    # 没有再真取一次
    # force 也压不到 0:下限就是 15 秒
    forced = call(server, "pa.analyze", {**spec, "force": True})["result"]
    assert forced["cached"] is True


def test_pa_comment_feeds_the_model_facts_not_raw_candles(server, monkeypatch):
    server.router = FakeBarRouter()
    seen = {}

    class FakeParser:
        def complete_json(self, system, user, schema):
            seen["system"], seen["user"] = system, user
            return {"summary": "顺势结构未破", "reading": "高点低点同步抬高。",
                    "watch": ["跌破前低看结构反转"], "risks": ["样本只有一天"]}

    import ibkr_agent.rpc as rpc_mod

    monkeypatch.setattr(rpc_mod, "build_parser", lambda cfg: FakeParser())
    result = call(server, "pa.comment", {"symbol": "NVDA", "timeframe": "5m"})["result"]
    assert result["comment"]["summary"] == "顺势结构未破"
    assert result["analysis"]["symbol"] == "NVDA"
    # 提示词里给的是算好的结论,不是让模型自己看的原始 K 线
    assert "软件判定" in seen["user"] and "\"open\"" not in seen["user"]
    assert "忽略" in seen["system"]        # 提示注入防线照旧


def test_pa_comment_reports_a_bad_model_answer_instead_of_raising(server, monkeypatch):
    server.router = FakeBarRouter()

    class BadParser:
        def complete_json(self, system, user, schema):
            return {"summary": "看多", "extra_field": "模型多嘴"}   # extra=forbid 必须拦下

    import ibkr_agent.rpc as rpc_mod

    monkeypatch.setattr(rpc_mod, "build_parser", lambda cfg: BadParser())
    assert call(server, "pa.comment", {"symbol": "NVDA"})["error"]["code"] == -32016


def test_order_book_validates_symbol_and_connection(server):
    assert call(server, "book.snapshot", {"symbol": "买入100股"})["error"]["code"] == -32602
    response = call(server, "book.snapshot", {"symbol": "NVDA"})
    assert response["error"]["code"] == -32014
    assert "TWS" in response["error"]["message"]


def test_idea_rejects_empty_text_and_bad_status(server):
    assert call(server, "ideas.add", {"text": "  "})["error"]["code"] == -32602
    added = call(server, "ideas.add", {"text": "留意 NVDA 财报"})["result"]["idea"]
    assert call(server, "ideas.update", {"id": added["id"], "status": "deleted"})["error"]["code"] == -32602
    assert call(server, "ideas.update", {"id": "no-such", "status": "done"})["error"]["code"] == -32602


def test_execute_blocked_when_auto_execute_is_off(server):
    response = call(server, "instruction.submit", {"text": "买入 AAPL 100股 limit 230", "execute": True})
    assert response["error"]["code"] == -32003


def test_execute_blocked_without_broker_connection(server, tmp_path):
    config = dict(BASE_CONFIG)
    config["storage"] = {"db_path": str(tmp_path / "t2.db")}
    config["policies"] = {**config["policies"], "auto_execute": True}
    path = tmp_path / "s2.json"
    path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
    srv = RpcServer(path, stdout=io.StringIO(), stdin=io.StringIO())

    response = call(srv, "instruction.submit", {"text": "买入 AAPL 100股 limit 230", "execute": True})
    assert response["error"]["code"] == -32004


def test_empty_instruction_is_rejected(server):
    assert call(server, "instruction.submit", {"text": "   "})["error"]["code"] == -32602


def test_settings_patch_updates_file_and_reloads(server):
    result = call(server, "settings.patch", {"patch": {"limits": {"max_order_notional": 1234.0}}})["result"]
    assert result["limits"]["max_order_notional"] == 1234.0
    on_disk = json.loads(Path(server.settings.source_path).read_text(encoding="utf-8"))
    assert on_disk["limits"]["max_order_notional"] == 1234.0
    assert server.settings.limits.max_order_notional == 1234.0


def test_settings_patch_cannot_touch_accounts_or_connections(server):
    for key in ("accounts", "connections"):
        response = call(server, "settings.patch", {"patch": {key: []}})
        assert response["error"]["code"] == -32006


def test_invalid_patch_is_rolled_back_before_touching_disk(server):
    before = Path(server.settings.source_path).read_text(encoding="utf-8")
    response = call(server, "settings.patch", {"patch": {"limits": {"max_order_notional": "很多钱"}}})
    assert response["error"]["code"] == -32007
    assert Path(server.settings.source_path).read_text(encoding="utf-8") == before


def test_breaker_roundtrip_emits_events(server):
    assert call(server, "breaker.halt", {"reason": "测试"})["result"]["engaged"] is True
    assert call(server, "breaker.state")["result"]["engaged"] is True
    assert call(server, "breaker.resume")["result"]["engaged"] is False


def test_dry_run_never_places_even_if_config_allows(server, monkeypatch):
    """execute=false 必须临时压掉 auto_execute,并在调用后还原。"""
    from dataclasses import replace

    from ibkr_agent.engine import TradingEngine
    from ibkr_agent.llm import LLMResponse
    from ibkr_agent.notify import Notifier
    from ibkr_agent.store import TradeStore
    from test_engine import FakeRouter  # 复用假券商连接

    class Parser:
        def parse(self, bundle, user_message):
            return LLMResponse(
                text=json.dumps({"orders": [stock_order()], "rejections": []}, ensure_ascii=False),
                model="claude-opus-5",
                prompt_version=bundle.version,
                prompt_fingerprint=bundle.fingerprint,
                latency_ms=1,
            )

    router = FakeRouter()
    server.settings = replace(
        server.settings, policies=replace(server.settings.policies, auto_execute=True)
    )
    server.router = router
    server._engine = TradingEngine(
        server.settings,
        parser=Parser(),
        store=TradeStore(server.settings.db_path),
        notifier=Notifier(enabled=False),
        router=router,
    )

    result = call(server, "instruction.submit", {"text": "买入 AAPL 100股 limit 230"})["result"]
    assert result["executed"] is False
    assert result["submitted"] == []
    assert len(result["validated_only"]) == 1
    assert router.placed == []
    # 调用后策略必须还原,不能把 auto_execute 永久关掉
    assert server._engine.settings.policies.auto_execute is True


def test_records_listing_masks_accounts(server):
    from ibkr_agent.store import TradeStore

    store = TradeStore(server.settings.db_path)
    store.create_record(
        {
            "input": {"raw_instruction": "买入 AAPL 100股", "reason": "测试"},
            "llm": {"intent_summary": "买入 100 股 AAPL"},
            "account": {"alias": "模拟", "account_id": "DU7654321", "is_paper": True},
            "contract": {"symbol": "AAPL", "secType": "STK"},
            "order": {"totalQuantity": 100, "action": "BUY"},
            "signature": "模拟|BUY|STK|AAPL",
        }
    )
    records = call(server, "records.list", {"limit": 5})["result"]["records"]
    assert records[0]["account_masked"] == "DU***321"
    assert "account_id" not in records[0]

    detail = call(server, "records.get", {"id": records[0]["id"]})["result"]["record"]
    assert detail["account"]["account_masked"] == "DU***321"
    assert "account_id" not in detail["account"]


def test_missing_record_returns_error(server):
    assert call(server, "records.get", {"id": "nope"})["error"]["code"] == -32005


# ---- 大模型面板 ---------------------------------------------------------
def test_llm_catalog_reports_providers_and_key_presence(server):
    result = call(server, "llm.catalog")["result"]
    assert {p["key"] for p in result["providers"]} == {"anthropic", "openai_compatible"}
    assert result["current"]["provider"] == "anthropic"
    assert set(result["key_configured"]) == {"anthropic", "openai_compatible"}
    # 只报有无,绝不回传密钥本身
    assert all(isinstance(v, bool) for v in result["key_configured"].values())
    assert "api_key" not in json.dumps(result)


def test_llm_patch_switches_provider_and_key_slot(server):
    result = call(
        server,
        "llm.patch",
        {"llm": {"provider": "openai_compatible", "model": "deepseek-chat",
                 "base_url": "https://api.deepseek.com/v1"}},
    )["result"]
    assert result["current"]["provider"] == "openai_compatible"
    assert result["current"]["keychain_account"] == "openai_compatible"   # 换供应商=换 key 槽
    on_disk = json.loads(Path(server.settings.source_path).read_text(encoding="utf-8"))
    assert on_disk["llm"]["base_url"] == "https://api.deepseek.com/v1"


def test_llm_patch_rejects_fields_outside_the_form(server):
    for bad in ("keychain_service", "keychain_account", "provider_secret"):
        response = call(server, "llm.patch", {"llm": {bad: "x"}})
        assert response["error"]["code"] == -32602


def test_llm_patch_rolls_back_an_invalid_endpoint(server):
    before = Path(server.settings.source_path).read_text(encoding="utf-8")
    response = call(
        server,
        "llm.patch",
        {"llm": {"provider": "openai_compatible", "model": "x", "base_url": "http://evil.example.com/v1"}},
    )
    assert response["error"]["code"] == -32007          # 友好的"已回滚",不是内部错误
    assert "https" in response["error"]["message"]
    assert Path(server.settings.source_path).read_text(encoding="utf-8") == before


def test_llm_test_reports_failure_instead_of_raising(server):
    """测试连接失败是要展示的结果,不该变成一个 RPC 异常。"""
    result = call(
        server,
        "llm.test",
        {"llm": {"provider": "openai_compatible", "model": "deepseek-chat",
                 "base_url": "https://127.0.0.1:9/v1"},
         "api_key": "sk-not-real"},
    )["result"]
    assert result["ok"] is False
    assert result["error"]
    assert result["provider"] == "openai_compatible"


# ---- 协议:优先级排队 ---------------------------------------------------
def test_serve_lets_user_requests_jump_ahead_of_periodic_polls(tmp_path):
    """引擎单线程顺序处理,但用户亲手发的请求要插到周期轮询前面——
    否则「解析并校验」排在 macro.board 后面,毫秒级本地解析看起来要十几秒。"""
    config = dict(BASE_CONFIG)
    config["storage"] = {"db_path": str(tmp_path / "trades.db")}
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")

    # 一口气喂进去:三条轮询在前,一条用户请求在后;末尾一条坏 JSON
    lines = [
        {"jsonrpc": "2.0", "id": 1, "method": "system.status", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "pending.poll", "params": {}},
        {"jsonrpc": "2.0", "id": 3, "method": "macro.board", "params": {}},
        {"jsonrpc": "2.0", "id": 4, "method": "records.list", "params": {"limit": 1}},
    ]
    stdin = io.StringIO("\n".join(json.dumps(l) for l in lines) + "\nnot json\n")
    server = RpcServer(path, stdout=io.StringIO(), stdin=stdin)

    import ibkr_agent.macro as macro_mod
    monkeypatch_urlopen = macro_mod.urllib.request.urlopen
    macro_mod.urllib.request.urlopen = lambda *a, **k: (_ for _ in ()).throw(OSError("offline"))
    try:
        server.serve()
    finally:
        macro_mod.urllib.request.urlopen = monkeypatch_urlopen

    responses = [json.loads(l) for l in server.stdout.getvalue().splitlines()
                 if l.strip() and "\"id\"" in l and json.loads(l).get("method") != "event"]
    order = [r.get("id") for r in responses]
    # 用户请求(4)先于三条轮询;坏 JSON 也在(id=None);轮询之间保持先来后到
    assert order[0] == 4
    assert [i for i in order if i in (1, 2, 3)] == [1, 2, 3]
    assert None in order


# ---- 持仓列表:组合虚拟行 + 本地算盈亏 ------------------------------------
class _PositionsRouter(_PriceRouter):
    """给 positions.list 用的假 router:返回券商持仓行(没报盈亏)。"""

    def __init__(self, rows):
        super().__init__(100.0)
        self.rows = rows

    def positions(self):
        return [dict(r) for r in self.rows]


def _opt_row(strike, qty, cost, price):
    from ibkr_agent import tracker as tk

    contract = {"secType": "OPT", "symbol": "SPX", "lastTradeDateOrContractMonth": "20260901",
                "strike": strike, "right": "P", "multiplier": "100"}
    leg = tk.leg_of(contract)
    return {"key": tk.position_key("模拟", "SPX", "OPT", leg), "account": "模拟", "symbol": "SPX",
            "sec_type": "OPT", "leg": leg, "label": tk.position_label("SPX", "OPT", contract),
            "quantity": qty, "avg_cost": cost, "multiplier": 100.0, "currency": "USD",
            "market_price": price, "market_value": None, "unrealized_pnl": None, "contract": contract}


def test_positions_list_adds_a_trackable_combo_row_and_computes_missing_pnl(server):
    """蝴蝶三条腿 → 多一条 BAG 虚拟行;券商没报盈亏的行本地按现价算并标 computed。"""
    server.router = _PositionsRouter([
        {"key": "模拟|GOOG|STK", "account": "模拟", "symbol": "GOOG", "sec_type": "STK", "leg": "",
         "label": "GOOG", "quantity": 20.0, "avg_cost": 341.62, "multiplier": 1.0, "currency": "USD",
         "market_price": 333.46, "market_value": None, "unrealized_pnl": None,
         "contract": {"secType": "STK", "symbol": "GOOG"}},
        _opt_row(7600.0, 1.0, 30.0, 0.35), _opt_row(7615.0, -2.0, 40.0, 0.35), _opt_row(7630.0, 1.0, 50.0, 0.40),
    ])
    rows = call(server, "positions.list")["result"]["positions"]
    by_type = {}
    for r in rows:
        by_type.setdefault(r["sec_type"], []).append(r)
    goog = by_type["STK"][0]
    assert goog["unrealized_pnl"] == pytest.approx((333.46 - 341.62) * 20, abs=1e-6)
    assert goog["pnl_source"] == "computed"
    fly = by_type["BAG"][0]
    assert fly["label"] == "买入看跌蝴蝶 7600/7615/7630" and fly["quantity"] == 1.0
    assert fly["market_price"] == pytest.approx(0.05) and fly["avg_cost"] == 0.0
    assert fly["unrealized_pnl"] == pytest.approx(5.0)        # 0.05 × 100 × 1 − 0
    assert fly["tracked"] is False

    # 整组追踪:止盈按组合净价。托管到券商仍然拦(组合的 GTC+OCA 没核对过),
    # 到价自动平仓已经打通——引擎盯盘、到价发反向腿的 BAG 限价单。
    denied = call(server, "tracker.add", {"key": fly["key"], "take_profit": 0.5, "host_at_broker": True})
    assert denied["error"]["code"] == -32602 and "托管到券商" in denied["error"]["message"]
    track = call(server, "tracker.add", {"key": fly["key"], "take_profit": 0.5, "auto_close": True})["result"]["track"]
    assert track["sec_type"] == "BAG" and track["leg"].startswith("20260901|")
    assert track["auto_close"]["enabled"] is True
    # 再读持仓:组合行标记已追踪
    rows = call(server, "positions.list")["result"]["positions"]
    assert [r["tracked"] for r in rows if r["sec_type"] == "BAG"] == [True]


def test_submit_accounts_param_is_validated(server):
    bad_alias = call(server, "instruction.submit", {"text": "买入 AAPL 100股 limit 230", "accounts": ["长线"]})
    assert bad_alias["error"]["code"] == -32602
    assert "长线" in bad_alias["error"]["message"]
    bad_type = call(server, "instruction.submit", {"text": "买入 AAPL 100股 limit 230", "accounts": "模拟"})
    assert bad_type["error"]["code"] == -32602


def test_submit_fans_out_to_selected_accounts(server, monkeypatch):
    from ibkr_agent import rpc as rpc_mod
    from ibkr_agent.llm import LLMResponse

    class FakeParser:
        def parse(self, bundle, user_message):
            return LLMResponse(
                text=json.dumps({"orders": [stock_order()], "rejections": []}, ensure_ascii=False),
                model="claude-opus-5",
                prompt_version=bundle.version,
                prompt_fingerprint=bundle.fingerprint,
                latency_ms=1,
            )

    monkeypatch.setattr(rpc_mod, "build_parser", lambda cfg: FakeParser())
    result = call(
        server, "instruction.submit",
        {"text": "买入 AAPL 100股 limit 230", "accounts": ["模拟", "主账户"]},
    )["result"]
    # 纸面那份通过校验(auto_execute=false → 只校验),实盘那份被 allow_live_trading 闸拦下
    assert [v["account"] for v in result["validated_only"]] == ["模拟"]
    assert [r["code"] for r in result["rejections"]] == ["LIVE_TRADING_DISABLED"]
    assert any("同时发单" in w for w in result["warnings"])
    status = call(server, "system.status", {})["result"]
    assert {a["alias"]: a["broker"] for a in status["accounts"]} == {"模拟": "ibkr", "主账户": "ibkr"}


# ---- 交易分析(蝴蝶复盘)-----------------------------------------------
def _store_butterfly(server, rid="fly-1"):
    from datetime import datetime, timezone

    legs = [
        {"action": "BUY", "ratio": 1, "strike": 7600, "right": "P", "lastTradeDateOrContractMonth": "20260812"},
        {"action": "SELL", "ratio": 2, "strike": 7615, "right": "P", "lastTradeDateOrContractMonth": "20260812"},
        {"action": "BUY", "ratio": 1, "strike": 7630, "right": "P", "lastTradeDateOrContractMonth": "20260812"},
    ]
    server.engine.store.create_record({
        "id": rid, "created_at": datetime(2026, 8, 12, 14, 35, tzinfo=timezone.utc).isoformat(),
        "contract": {"secType": "BAG", "symbol": "SPX", "multiplier": "100", "combo_strategy": "BUTTERFLY",
                     "legs": legs, "exchange": "SMART", "currency": "USD"},
        "order": {"action": "BUY", "totalQuantity": 1, "lmtPrice": 1.8, "orderType": "LMT"},
        "account": {"alias": "模拟", "account_id": "DU7654321", "is_paper": True},
        "llm": {"intent_summary": "买入 1 张 SPX 7600/7615/7630 看跌蝴蝶"},
        "input": {"raw_instruction": "1.8 挂15蝴蝶", "reason": "测试"},
        "execution_type": "IMMEDIATE",
    })


def test_review_candidates_lists_only_butterflies(server):
    _store_butterfly(server)
    server.engine.store.create_record({
        "id": "stk-1", "created_at": "2026-08-12T15:00:00+00:00",
        "contract": {"secType": "STK", "symbol": "AAPL", "exchange": "SMART", "currency": "USD"},
        "order": {"action": "BUY", "totalQuantity": 1, "orderType": "MKT"},
        "account": {"alias": "模拟", "account_id": "DU7654321", "is_paper": True},
        "llm": {"intent_summary": "买 AAPL"}, "input": {"raw_instruction": "买 AAPL"}, "execution_type": "IMMEDIATE",
    })
    # 默认只列券商真实成交的:本地没成交的记录不算数
    result = call(server, "review.candidates")["result"]
    assert result["candidates"] == [] and result["ibkr_available"] is False
    # 明确要求时才附上本地未成交的,并标 source=local
    result = call(server, "review.candidates", {"include_local": True})["result"]
    assert [c["id"] for c in result["candidates"]] == ["fly-1"]
    c = result["candidates"][0]
    assert c["source"] == "local"
    assert c["strikes"] == [7600, 7615, 7630] and c["width"] == 15 and c["right"] == "看跌"
    assert c["price"] == 1.8 and c["price_estimated"] is True and c["filled"] is False


class _FakeFillRouter:
    """只会报成交的假券商:交易分析从这里拉真实成交。"""

    def __init__(self, rows):
        self.rows = rows
        self.calls = 0

    def sessions(self):
        return [object()]

    def executions(self):
        self.calls += 1
        return self.rows


def _fly_fills():
    T = "2026-09-03T14:03:34+00:00"

    def fill(exec_id, side, shares, price, sec="OPT", strike=None):
        return {"exec_id": exec_id, "time": T, "account_id": "DU7654321", "side": side, "shares": shares,
                "price": price, "order_id": 0, "perm_id": 256406619, "order_ref": "", "commission": None,
                "contract": {"secType": sec, "symbol": "SPX", "currency": "USD", "exchange": "CBOE",
                             "expiry": "20260903" if sec != "BAG" else "", "strike": strike, "right": "C",
                             "tradingClass": "SPXW", "multiplier": "100", "conId": 1}}
    return [fill("bag", "BOT", 1, 2.25, sec="BAG"), fill("e1", "BOT", 1, 0.22, strike=7760),
            fill("e2", "SLD", 2, 0.82, strike=7740), fill("e3", "BOT", 1, 3.67, strike=7720)]


def test_review_candidates_come_from_broker_fills_and_accumulate(server):
    server.router = _FakeFillRouter(_fly_fills())
    result = call(server, "review.candidates")["result"]
    assert result["ibkr_available"] is True and result["synced"] == 4 and result["fills_stored"] == 4
    assert len(result["candidates"]) == 1
    c = result["candidates"][0]
    assert c["id"] == "ib:256406619" and c["source"] == "ibkr" and c["filled"] is True
    assert c["account"] == "模拟" and c["price"] == 2.25 and c["price_estimated"] is False
    assert c["strikes"] == [7720, 7740, 7760] and c["action"] == "BUY"
    # 券商断开后,库里累积的成交仍然列得出来
    server.router = None
    again = call(server, "review.candidates")["result"]
    assert [x["id"] for x in again["candidates"]] == ["ib:256406619"] and again["ibkr_available"] is False


def test_review_analyze_refuses_non_butterfly_and_needs_a_connection(server):
    _store_butterfly(server)
    server.engine.store.create_record({
        "id": "stk-2", "created_at": "2026-08-12T15:00:00+00:00",
        "contract": {"secType": "STK", "symbol": "AAPL", "exchange": "SMART", "currency": "USD"},
        "order": {"action": "BUY", "totalQuantity": 1, "orderType": "MKT"},
        "account": {"alias": "模拟", "account_id": "DU7654321", "is_paper": True},
        "llm": {"intent_summary": "买 AAPL"}, "input": {"raw_instruction": "买 AAPL"}, "execution_type": "IMMEDIATE",
    })
    assert call(server, "review.analyze", {"id": "nope"})["error"]["code"] == -32005
    assert call(server, "review.analyze", {"id": "stk-2"})["error"]["code"] == -32602
    bad_tf = call(server, "review.analyze", {"id": "fly-1", "timeframe": "3m"})["error"]
    assert bad_tf["code"] == -32602 and "未知 K 线周期" in bad_tf["message"]
    # 没连券商:明确要求连接,而不是拿空 K 线硬算
    no_conn = call(server, "review.analyze", {"id": "fly-1"})["error"]
    assert no_conn["code"] == -32015


# ---------------------------------------------------------------- 扫描器 + 业务标签
def test_sector_tag_can_be_set_and_cleared(server):
    sector = call(server, "sectors.add", {"name": "AI 算力"})["result"]["sector"]
    call(server, "sectors.add_stock", {"id": sector["id"], "symbol": "NVDA", "tag": "芯片"})
    call(server, "sectors.add_stock", {"id": sector["id"], "symbol": "VRT"})
    stocks = call(server, "sectors.list")["result"]["sectors"][0]["stocks"]
    assert {s["symbol"]: s["tag"] for s in stocks} == {"NVDA": "芯片", "VRT": ""}

    out = call(server, "sectors.set_tag", {"id": sector["id"], "symbol": "vrt", "tag": " 电力设备 "})
    assert [s["tag"] for s in out["result"]["sector"]["stocks"]] == ["芯片", "电力设备"]
    out = call(server, "sectors.set_tag", {"id": sector["id"], "symbol": "VRT", "tag": ""})
    assert [s["tag"] for s in out["result"]["sector"]["stocks"]] == ["芯片", ""]
    # 标签太长截到 12 字,不报错
    out = call(server, "sectors.set_tag", {"id": sector["id"], "symbol": "VRT", "tag": "一" * 30})
    assert out["result"]["sector"]["stocks"][1]["tag"] == "一" * 12

    assert call(server, "sectors.set_tag", {"id": sector["id"], "symbol": "AMD", "tag": "x"})["error"]["code"] == -32602
    assert call(server, "sectors.set_tag", {"id": "nope", "symbol": "NVDA", "tag": "x"})["error"]["code"] == -32602


def test_screener_validates_before_touching_the_broker(server):
    """参数错、股票池空,都该在连券商之前就拒;真要拉 K 线时没连接再报连接错。"""
    assert call(server, "screener.rs", {"benchmark": "IWM"})["error"]["code"] == -32602
    assert "股票池是空的" in call(server, "screener.rs", {"benchmark": "SPY"})["error"]["message"]
    assert call(server, "screener.rs", {"sector": "nope"})["error"]["code"] == -32602

    sector = call(server, "sectors.add", {"name": "AI 算力"})["result"]["sector"]
    call(server, "sectors.add_stock", {"id": sector["id"], "symbol": "NVDA", "tag": "芯片"})
    err = call(server, "screener.rs", {"sector": sector["id"], "benchmark": "qqq"})["error"]
    assert err["code"] == -32018 and "RS 强度扫描" in err["message"]

    assert call(server, "screener.inflection", {"timeframes": ["3m"]})["error"]["code"] == -32602
    assert call(server, "screener.inflection", {"timeframes": "1d"})["error"]["code"] == -32602
    assert call(server, "screener.inflection", {"ma_period": 1})["error"]["code"] == -32602
    assert call(server, "screener.inflection", {"ma_period": "abc"})["error"]["code"] == -32602
    err = call(server, "screener.inflection", {"sector": "all", "timeframes": ["1d", "1w", "1d"], "ma_period": 20})["error"]
    assert err["code"] == -32018 and "拐点筛选" in err["message"]

    assert call(server, "screener.deviation", {"symbol": "bad$"})["error"]["code"] == -32602
    assert call(server, "screener.deviation", {"symbol": "NVDA", "timeframe": "5m"})["error"]["code"] == -32602
    assert call(server, "screener.deviation", {"symbol": "NVDA", "period": 1})["error"]["code"] == -32602
    assert call(server, "screener.deviation", {"symbol": "NVDA", "z_extreme": 9})["error"]["code"] == -32602
    err = call(server, "screener.deviation", {"symbol": "NVDA", "timeframe": "1w"})["error"]
    assert err["code"] == -32018 and "极值偏离" in err["message"]


class _FakeRouter:
    """假券商:只提供扫描器要的三样——有会话、日线、日内 K 线。记下每次请求,好数节流与封顶。"""

    BROKER = "ibkr"
    upstream_ok = True

    def __init__(self, fail=()):
        self.fail = set(fail)
        self.calls = []

    def sessions(self):
        return [object()]

    def historical_bars(self, symbol, start, end):
        from ibkr_agent.broker import BrokerError

        self.calls.append(("daily", symbol))
        if symbol in self.fail:
            raise BrokerError("%s 历史 K 线额度用完" % symbol)
        import random
        from datetime import date, timedelta

        rng = random.Random(hash(symbol) % 1000)
        day, price, bars = date(2025, 6, 2), 100.0, []
        for _ in range(300):
            while day.weekday() >= 5:
                day += timedelta(days=1)
            price = max(price * (1 + rng.gauss(0.0005, 0.02)), 1.0)
            bars.append({"date": day.isoformat(), "open": price, "high": price * 1.01,
                         "low": price * 0.99, "close": price, "volume": 1e6})
            day += timedelta(days=1)
        return bars

    def intraday_bars(self, symbol, timeframe, rth=False):
        self.calls.append((timeframe, symbol))
        return [{"time": "2026-09-08 %02d:%02d" % (9 + i // 12, (i % 12) * 5), "open": 50 + i * 0.1,
                 "high": 50.6 + i * 0.1, "low": 49.6 + i * 0.1, "close": 50.2 + i * 0.1, "volume": 1000}
                for i in range(80)]


def _pool(server, symbols):
    sector = call(server, "sectors.add", {"name": "实测"})["result"]["sector"]
    for sym, tag in symbols:
        call(server, "sectors.add_stock", {"id": sector["id"], "symbol": sym, "tag": tag})
    return sector["id"]


def test_screener_rs_end_to_end_with_fake_broker(server):
    server.router = _FakeRouter(fail={"COHR"})
    sector_id = _pool(server, [("NVDA", "芯片"), ("AMD", "芯片"), ("COHR", "光模块"), ("VRT", "")])
    result = call(server, "screener.rs", {"sector": sector_id, "benchmark": "SPY"})["result"]
    assert result["sector"] == "实测" and result["benchmark"] == "SPY" and result["bench_bars"] == 300
    rows = {r["symbol"]: r for r in result["rows"]}
    assert rows["COHR"]["error"] and rows["COHR"]["score"] is None and rows["COHR"]["rank"] is None
    assert set(rows["NVDA"]["rs"]) == {"5", "20", "60", "120", "250"}
    assert rows["VRT"]["tag"] == "未分类"
    assert result["counted"] == 3 and result["total"] == 4
    assert {t["tag"] for t in result["tags"]} == {"芯片", "光模块", "未分类"}
    # 基准 + 四只 = 5 次日线请求;再扫一次全走缓存,一次都不多打
    assert len(server.router.calls) == 5
    call(server, "screener.rs", {"sector": "all", "benchmark": "QQQ"})
    # 只多了 QQQ 与上次失败的 COHR(失败不进缓存,下次要重试)
    assert len(server.router.calls) == 7


def test_screener_inflection_resamples_weekly_and_caps_intraday(server):
    server.router = _FakeRouter()
    server.SCREEN_INTRADAY_CAP = 3
    symbols = [("A%d" % i, "x") for i in range(5)]
    sector_id = _pool(server, symbols)
    result = call(server, "screener.inflection",
                  {"sector": sector_id, "timeframes": ["1w", "1d", "1h"], "ma_period": 20})["result"]
    assert result["timeframes"] == ["1w", "1d", "1h"] and result["ma_period"] == 20
    assert len(result["rows"]) == 5
    weekly = [r["signals"]["1w"]["bars"] for r in result["rows"]]
    assert all(55 <= n <= 65 for n in weekly)      # 300 个交易日 ≈ 60 周
    assert all(r["signals"]["1d"]["bars"] == 300 for r in result["rows"])
    hourly = [r["signals"]["1h"] for r in result["rows"]]
    assert sum(1 for h in hourly if "error" not in h) == 3
    assert all("已达上限" in h["error"] for h in hourly if "error" in h)
    # 周线由日线重采样,不另打券商:每只 1 次日线 + 最多 3 次日内
    assert sum(1 for c in server.router.calls if c[0] == "daily") == 5
    assert sum(1 for c in server.router.calls if c[0] == "1h") == 3


def test_screener_deviation_end_to_end(server):
    server.router = _FakeRouter()
    result = call(server, "screener.deviation", {"symbol": "nvda", "timeframe": "1w", "period": 5, "lookback": 20})["result"]
    assert result["symbol"] == "NVDA" and result["timeframe"] == "1w" and result["period"] == 5
    assert result["last"]["z"] is not None and len(result["series"]) <= 120
    assert result["readout"]
    intraday = call(server, "screener.deviation", {"symbol": "NVDA", "timeframe": "30m"})["result"]
    assert intraday["bars"] == 80 and intraday["series"][-1]["time"].startswith("2026-09-08")
