"""提示词装配(§2/§3)、append-only 落库(§6/§9.6)、下单纯计算(§8)。"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta

import pytest

from conftest import make_settings
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
    assert "50000" in bundle.system_text  # 限额已注入
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


def test_fingerprint_changes_with_limits(settings):
    other = make_settings(limits={"max_order_notional": 999.0})
    assert load_prompt_bundle(settings).fingerprint != load_prompt_bundle(other).fingerprint


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
    assert auto_mid_limit(8.0, "SELL", 0.10) == pytest.approx(7.90)
    # 数学上限:借方净权利金不可能超过行权价差
    assert auto_mid_limit(29.99, "BUY", 0.50, strike_width=30.0) == pytest.approx(30.0)


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
    store.create_record(fresh)
    stale = _record()
    stale["created_at"] = (now - timedelta(hours=2)).isoformat()
    store.create_record(stale)

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
