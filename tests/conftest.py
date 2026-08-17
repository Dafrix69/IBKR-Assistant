from __future__ import annotations

import copy
from datetime import datetime
from typing import Any, Dict

import pytest

from ibkr_agent.config import ET, _from_dict

BASE_CONFIG: Dict[str, Any] = {
    "prompt_version": "v1.0.0",
    "llm": {"model": "claude-opus-5", "effort": "high", "temperature": None},
    "limits": {
        "max_order_notional": 50_000.0,
        "max_option_contracts": 10,
        "max_mkt_shares": 200,
        "min_confidence": 0.9,
        "max_spread_slippage": 0.10,
        "max_orders_per_input": 5,
        "duplicate_window_minutes": 10,
        "duplicate_qty_tolerance": 0.2,
    },
    "policies": {
        "auto_execute": False,
        "allow_live_trading": False,
        "require_trigger_price_verification": True,
        "trigger_min_gap_bps": 5.0,
        "closed_market_policy": "reject_market_orders",
    },
    "connections": {
        "paper": {"host": "127.0.0.1", "port": 7497, "client_id": 11},
        "live": {"host": "127.0.0.1", "port": 7496, "client_id": 12},
    },
    "accounts": [
        {"alias": "模拟", "account_id": "DU7654321", "is_paper": True, "connection": "paper",
         "default": True},
        {"alias": "主账户", "account_id": "U1234567", "is_paper": False, "connection": "live"},
    ],
    "symbol_aliases": {"苹果": "AAPL", "英伟达": "NVDA", "特斯拉": "TSLA"},
    "index_symbols": {
        "SPX": {"exchange": "CBOE", "daily_trading_class": "SPXW", "monthly_trading_class": "SPX"}
    },
    "market_holidays": ["2026-09-07"],
    "early_close_days": [],
}


def make_settings(**overrides: Any):
    raw = copy.deepcopy(BASE_CONFIG)
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(raw.get(key), dict):
            raw[key].update(value)
        else:
            raw[key] = value
    return _from_dict(raw)


@pytest.fixture
def settings(tmp_path):
    cfg = make_settings(storage={"db_path": str(tmp_path / "trades.db")})
    return cfg


@pytest.fixture
def now():
    """2026-08-14(周五)10:32 美东 —— 与设计文档少样本假设一致,盘中。"""
    return datetime(2026, 8, 14, 10, 32, tzinfo=ET)


def stock_order(**overrides: Any) -> Dict[str, Any]:
    order = {
        "intent_summary": "限价 230 买入 100 股 AAPL",
        "contract": {"secType": "STK", "symbol": "AAPL", "exchange": "SMART", "currency": "USD"},
        "execution_type": "IMMEDIATE",
        "trigger": None,
        "account": "DEFAULT",
        "order": {
            "action": "BUY",
            "orderType": "LMT",
            "totalQuantity": 100,
            "price_mode": "EXPLICIT",
            "lmtPrice": 230.0,
            "tif": "DAY",
            "outsideRth": False,
        },
        "reason": "回调到位",
        "confidence": 0.99,
        "warnings": [],
    }
    return _deep_update(order, overrides)


def spread_order(**overrides: Any) -> Dict[str, Any]:
    order = {
        "intent_summary": "SPX 涨到 7500 时买入 1 张 7520/7550 看涨借方价差",
        "contract": {
            "secType": "BAG",
            "symbol": "SPX",
            "exchange": "SMART",
            "currency": "USD",
            "combo_strategy": "VERTICAL",
            "legs": [
                {"action": "BUY", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
                 "strike": 7520.0, "right": "C", "tradingClass": "SPXW"},
                {"action": "SELL", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
                 "strike": 7550.0, "right": "C", "tradingClass": "SPXW"},
            ],
        },
        "execution_type": "CONDITIONAL",
        "trigger": {"type": "PRICE", "symbol": "SPX", "secType": "IND", "operator": ">=",
                    "value": 7500.0},
        "account": "DEFAULT",
        "order": {
            "action": "BUY",
            "orderType": "LMT",
            "totalQuantity": 1,
            "price_mode": "AUTO_MID",
            "lmtPrice": None,
            "tif": "DAY",
            "outsideRth": False,
        },
        "reason": "突破 7500 整数关口后追动能",
        "confidence": 0.96,
        "warnings": [],
    }
    return _deep_update(order, overrides)


def option_order(**overrides: Any) -> Dict[str, Any]:
    order = {
        "intent_summary": "限价 5.5 买入 2 张 NVDA 20260821 180 Call",
        "contract": {
            "secType": "OPT",
            "symbol": "NVDA",
            "exchange": "SMART",
            "currency": "USD",
            "lastTradeDateOrContractMonth": "20260821",
            "strike": 180.0,
            "right": "C",
            "multiplier": "100",
        },
        "execution_type": "IMMEDIATE",
        "trigger": None,
        "account": "DEFAULT",
        "order": {
            "action": "BUY",
            "orderType": "LMT",
            "totalQuantity": 2,
            "price_mode": "EXPLICIT",
            "lmtPrice": 5.5,
            "tif": "DAY",
            "outsideRth": False,
        },
        "reason": "财报前布局",
        "confidence": 0.97,
        "warnings": [],
    }
    return _deep_update(order, overrides)


def _deep_update(base: Dict[str, Any], overrides: Dict[str, Any]) -> Dict[str, Any]:
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_update(base[key], value)
        else:
            base[key] = value
    return base
