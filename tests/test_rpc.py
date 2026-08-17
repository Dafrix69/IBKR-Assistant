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
    assert result["prompt_version"] == "v1.0.0"


def test_accounts_are_masked_over_the_wire(server):
    """§9.3:真实账号不该整个送到界面。"""
    accounts = call(server, "system.status")["result"]["accounts"]
    aliases = {a["alias"]: a for a in accounts}
    assert aliases["模拟"]["account_masked"] == "DU***321"
    assert all("account_id" not in a for a in accounts)


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
