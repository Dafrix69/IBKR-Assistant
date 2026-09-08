"""生成 TS 重写用的黄金对拍数据(阶段 0)。

对每个纯函数模块,在固定输入下调用 Python 实现,把 (输入, 输出) 全精度序列化
到 ../engine-ts/baseline/golden/*.json。TS 侧逐条断言,浮点用 1e-9 相对容差。

只调用纯函数,不联网、不碰券商、不下单。
"""
from __future__ import annotations

import json
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
OUT = ROOT.parent / "engine-ts" / "baseline" / "golden"
OUT.mkdir(parents=True, exist_ok=True)

from ibkr_agent import alerts, backtest, market, optionwall, priceaction, research, screener, tracker  # noqa: E402
from ibkr_agent import config as cfg_mod  # noqa: E402
from ibkr_agent.config import ET, Settings, _from_dict  # noqa: E402
from ibkr_agent.models import parse_llm_payload  # noqa: E402
from ibkr_agent.prompts import PromptError, load_prompt_bundle, render_user  # noqa: E402
from ibkr_agent.schema import parse_schema_for_prompt  # noqa: E402
from ibkr_agent.validator import RecentOrder, Validator, order_signature  # noqa: E402
from ibkr_agent.models import ParsedOrder  # noqa: E402

# 与 tests/conftest.py 一致的基准配置
BASE_CONFIG = {
    "prompt_version": "v1.8.0",
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
        {"alias": "模拟", "account_id": "DU7654321", "is_paper": True, "connection": "paper", "default": True},
        {"alias": "主账户", "account_id": "U1234567", "is_paper": False, "connection": "live"},
    ],
    "symbol_aliases": {"苹果": "AAPL", "英伟达": "NVDA", "特斯拉": "TSLA"},
    "index_symbols": {
        "SPX": {"exchange": "CBOE", "daily_trading_class": "SPXW", "monthly_trading_class": "SPX"}
    },
    "market_holidays": ["2026-09-07"],
    "early_close_days": ["2026-11-27"],
}

NOW = datetime(2026, 8, 14, 10, 32, tzinfo=ET)  # 周五盘中,与测试一致


def deep_update(base, overrides):
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            deep_update(base[key], value)
        else:
            base[key] = value
    return base


def make_settings(**overrides) -> Settings:
    import copy

    raw = copy.deepcopy(BASE_CONFIG)
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(raw.get(key), dict):
            raw[key] = deep_update(dict(raw[key]), value)
        else:
            raw[key] = value
    return _from_dict(raw)


def stock_order(**overrides):
    order = {
        "intent_summary": "限价 230 买入 100 股 AAPL",
        "contract": {"secType": "STK", "symbol": "AAPL", "exchange": "SMART", "currency": "USD"},
        "execution_type": "IMMEDIATE",
        "trigger": None,
        "account": "DEFAULT",
        "order": {
            "action": "BUY", "orderType": "LMT", "totalQuantity": 100,
            "price_mode": "EXPLICIT", "lmtPrice": 230.0, "tif": "DAY", "outsideRth": False,
        },
        "reason": "回调到位",
        "confidence": 0.99,
        "warnings": [],
    }
    return deep_update(order, overrides)


def spread_order(**overrides):
    order = {
        "intent_summary": "SPX 涨到 7500 时买入 1 张 7520/7550 看涨借方价差",
        "contract": {
            "secType": "BAG", "symbol": "SPX", "exchange": "SMART", "currency": "USD",
            "combo_strategy": "VERTICAL",
            "legs": [
                {"action": "BUY", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
                 "strike": 7520.0, "right": "C", "tradingClass": "SPXW"},
                {"action": "SELL", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
                 "strike": 7550.0, "right": "C", "tradingClass": "SPXW"},
            ],
        },
        "execution_type": "CONDITIONAL",
        "trigger": {"type": "PRICE", "symbol": "SPX", "secType": "IND", "operator": ">=", "value": 7500.0},
        "account": "DEFAULT",
        "order": {
            "action": "BUY", "orderType": "LMT", "totalQuantity": 1,
            "price_mode": "AUTO_MID", "lmtPrice": None, "tif": "DAY", "outsideRth": False,
        },
        "reason": "突破 7500 整数关口后追动能",
        "confidence": 0.96,
        "warnings": [],
    }
    return deep_update(order, overrides)


def butterfly_order(**overrides):
    order = {
        "intent_summary": "SPX 涨到 7500 时买入 1 张 7500/7520/7540 看涨蝴蝶",
        "contract": {
            "secType": "BAG", "symbol": "SPX", "exchange": "SMART", "currency": "USD",
            "combo_strategy": "BUTTERFLY",
            "legs": [
                {"action": "BUY", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
                 "strike": 7500.0, "right": "C", "tradingClass": "SPXW"},
                {"action": "SELL", "ratio": 2, "lastTradeDateOrContractMonth": "20260814",
                 "strike": 7520.0, "right": "C", "tradingClass": "SPXW"},
                {"action": "BUY", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
                 "strike": 7540.0, "right": "C", "tradingClass": "SPXW"},
            ],
        },
        "execution_type": "CONDITIONAL",
        "trigger": {"type": "PRICE", "symbol": "SPX", "secType": "IND", "operator": ">=", "value": 7500.0},
        "account": "DEFAULT",
        "order": {
            "action": "BUY", "orderType": "LMT", "totalQuantity": 1,
            "price_mode": "AUTO_MID", "lmtPrice": None, "tif": "DAY", "outsideRth": False,
        },
        "reason": "预期钉住 7520",
        "confidence": 0.95,
        "warnings": [],
    }
    return deep_update(order, overrides)


def condor_order(**overrides):
    order = {
        "intent_summary": "卖出 2 张 SPX 7200/7250/7650/7700 铁鹰",
        "contract": {
            "secType": "BAG", "symbol": "SPX", "exchange": "SMART", "currency": "USD",
            "combo_strategy": "IRON_CONDOR",
            "legs": [
                {"action": "BUY", "ratio": 1, "lastTradeDateOrContractMonth": "20260918",
                 "strike": 7200.0, "right": "P", "tradingClass": "SPX"},
                {"action": "SELL", "ratio": 1, "lastTradeDateOrContractMonth": "20260918",
                 "strike": 7250.0, "right": "P", "tradingClass": "SPX"},
                {"action": "SELL", "ratio": 1, "lastTradeDateOrContractMonth": "20260918",
                 "strike": 7650.0, "right": "C", "tradingClass": "SPX"},
                {"action": "BUY", "ratio": 1, "lastTradeDateOrContractMonth": "20260918",
                 "strike": 7700.0, "right": "C", "tradingClass": "SPX"},
            ],
        },
        "execution_type": "IMMEDIATE",
        "trigger": None,
        "account": "DEFAULT",
        "order": {
            "action": "SELL", "orderType": "LMT", "totalQuantity": 2,
            "price_mode": "EXPLICIT", "lmtPrice": 12.0, "tif": "GTC", "outsideRth": False,
        },
        "reason": "预计区间震荡",
        "confidence": 0.96,
        "warnings": [],
    }
    return deep_update(order, overrides)


def option_order(**overrides):
    order = {
        "intent_summary": "限价 5.5 买入 2 张 NVDA 20260821 180 Call",
        "contract": {
            "secType": "OPT", "symbol": "NVDA", "exchange": "SMART", "currency": "USD",
            "lastTradeDateOrContractMonth": "20260821", "strike": 180.0, "right": "C",
            "multiplier": "100",
        },
        "execution_type": "IMMEDIATE",
        "trigger": None,
        "account": "DEFAULT",
        "order": {
            "action": "BUY", "orderType": "LMT", "totalQuantity": 2,
            "price_mode": "EXPLICIT", "lmtPrice": 5.5, "tif": "DAY", "outsideRth": False,
        },
        "reason": "财报前布局",
        "confidence": 0.97,
        "warnings": [],
    }
    return deep_update(order, overrides)


def dump(name: str, payload) -> None:
    path = OUT / ("%s.json" % name)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print("golden: %s (%d bytes)" % (path.name, path.stat().st_size))


# ================================================================ validator
def gen_validator():
    snapshot = {"SPX": 7462.35, "AAPL": 229.4, "NVDA": 181.2}

    cases = []

    def case(name, payload, *, settings_over=None, now=NOW, snap=snapshot, recents=None):
        settings = make_settings(**(settings_over or {}))
        try:
            order = ParsedOrder.model_validate(payload)
        except Exception as exc:  # noqa: BLE001 - 模型层就挂:记录为 model_error
            cases.append({
                "name": name, "payload": payload, "settings_over": settings_over,
                "now": now.isoformat(), "snapshot": snap,
                "recents": recents, "model_error": True,
            })
            return
        recent_objs = [
            RecentOrder(signature=r["signature"], quantity=r["quantity"],
                        created_at=datetime.fromisoformat(r["created_at"]))
            for r in (recents or [])
        ]
        v = Validator(settings, now, snap, recent_objs)
        issues, approved = v.validate_one(order)
        out = {
            "issues": [{"code": i.code, "message": i.message} for i in issues],
            "signature": order_signature(order, order.account),
        }
        if approved is not None:
            out["approved"] = {
                "notional": approved.notional,
                "signature": approved.signature,
                "warnings": approved.warnings,
                "account_id": approved.account_id,
            }
            # tradingClass 复核可能改写合约
            out["contract_trading_class"] = order.contract.tradingClass
            out["leg_trading_classes"] = [l.tradingClass for l in (order.contract.legs or [])]
        cases.append({
            "name": name, "payload": payload, "settings_over": settings_over,
            "now": now.isoformat(), "snapshot": snap, "recents": recents, "expect": out,
        })

    case("stock_ok", stock_order())
    case("low_confidence", stock_order(confidence=0.5))
    case("unknown_account", stock_order(account="不存在"))
    case("live_disabled", stock_order(account="主账户"))
    case("live_enabled", stock_order(account="主账户"),
         settings_over={"policies": {"allow_live_trading": True}})
    case("expired_contract", option_order(contract={"lastTradeDateOrContractMonth": "20250102"}))
    case("weekend_expiry", option_order(contract={"lastTradeDateOrContractMonth": "20260815"}))
    case("holiday_expiry", option_order(contract={"lastTradeDateOrContractMonth": "20260907"}))
    # 指数 tradingClass 复核:20260918 是第三个周五 → SPX;20260814 是普通周五 → SPXW
    case("tclass_monthly_fix", condor_order(contract={"legs": [
        {"action": "BUY", "ratio": 1, "lastTradeDateOrContractMonth": "20260918",
         "strike": 7200.0, "right": "P", "tradingClass": "SPXW"},
        {"action": "SELL", "ratio": 1, "lastTradeDateOrContractMonth": "20260918",
         "strike": 7250.0, "right": "P", "tradingClass": "SPX"},
        {"action": "SELL", "ratio": 1, "lastTradeDateOrContractMonth": "20260918",
         "strike": 7650.0, "right": "C", "tradingClass": "SPX"},
        {"action": "BUY", "ratio": 1, "lastTradeDateOrContractMonth": "20260918",
         "strike": 7700.0, "right": "C", "tradingClass": "SPX"},
    ]}))
    case("vertical_ok", spread_order())
    case("vertical_mixed_right", spread_order(contract={"legs": [
        {"action": "BUY", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
         "strike": 7520.0, "right": "C", "tradingClass": "SPXW"},
        {"action": "SELL", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
         "strike": 7550.0, "right": "P", "tradingClass": "SPXW"},
    ]}))
    case("vertical_diff_expiry", spread_order(contract={"legs": [
        {"action": "BUY", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
         "strike": 7520.0, "right": "C", "tradingClass": "SPXW"},
        {"action": "SELL", "ratio": 1, "lastTradeDateOrContractMonth": "20260821",
         "strike": 7550.0, "right": "C", "tradingClass": "SPXW"},
    ]}))
    case("vertical_debit_wrong_way", spread_order(contract={"legs": [
        {"action": "BUY", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
         "strike": 7550.0, "right": "C", "tradingClass": "SPXW"},
        {"action": "SELL", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
         "strike": 7520.0, "right": "C", "tradingClass": "SPXW"},
    ]}))
    case("vertical_premium_over_width", spread_order(order={
        "price_mode": "EXPLICIT", "lmtPrice": 45.0}))
    case("butterfly_ok", butterfly_order())
    case("butterfly_unequal_wings", butterfly_order(contract={"legs": [
        {"action": "BUY", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
         "strike": 7500.0, "right": "C", "tradingClass": "SPXW"},
        {"action": "SELL", "ratio": 2, "lastTradeDateOrContractMonth": "20260814",
         "strike": 7520.0, "right": "C", "tradingClass": "SPXW"},
        {"action": "BUY", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
         "strike": 7550.0, "right": "C", "tradingClass": "SPXW"},
    ]}))
    case("condor_ok", condor_order())
    case("condor_buy_rejected", condor_order(order={"action": "BUY"}))
    # 触发复核
    case("trigger_no_snapshot", spread_order(), snap={})
    case("trigger_no_snapshot_lenient", spread_order(), snap={},
         settings_over={"policies": {"require_trigger_price_verification": False}})
    case("trigger_gap_too_small", spread_order(trigger={"value": 7462.4}))
    case("trigger_wrong_operator", spread_order(trigger={"operator": "<="}))
    # 限额
    case("stock_notional_over", stock_order(order={"totalQuantity": 300}))
    case("option_sell_call_rejected", option_order(order={"action": "SELL"}))
    case("option_sell_put_cash_secured", option_order(
        contract={"right": "P"}, order={"action": "SELL", "totalQuantity": 2}))
    case("option_sell_put_over_limit", option_order(
        contract={"right": "P", "strike": 400.0},
        order={"action": "SELL", "totalQuantity": 10, "lmtPrice": 3.0}))
    case("option_buy_mkt_unpriceable", option_order(order={
        "orderType": "MKT", "lmtPrice": None, "price_mode": "EXPLICIT"}))
    case("option_contracts_over", option_order(order={"totalQuantity": 11, "lmtPrice": 0.5}))
    # 限额只在本地校验(提示词 v1.8.0):压测里模型自己算限额误拒的四条,校验层按 5000 USD / 5 张放行;真超限的拦
    tight = {"limits": {"max_order_notional": 5_000.0, "max_option_contracts": 5}}
    case("tight_nvda_two_calls_ok", option_order(), settings_over=tight)  # 2 × 100 × 5.5 = 1100
    case("tight_spy_put_ok", option_order(
        intent_summary="限价 3 买入 1 张 SPY 20260814 560 Put",
        contract={"symbol": "SPY", "strike": 560.0, "right": "P",
                  "lastTradeDateOrContractMonth": "20260814"},
        order={"totalQuantity": 1, "lmtPrice": 3.0}), settings_over=tight)  # 1 × 100 × 3 = 300
    case("tight_condor_4800_ok", condor_order(
        intent_summary="卖出 1 张 SPX 今天 7300/7350/7700/7750 铁鹰,收权利金不低于 2",
        contract={"legs": [
        {"action": "BUY", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
         "strike": 7300.0, "right": "P", "tradingClass": "SPXW"},
        {"action": "SELL", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
         "strike": 7350.0, "right": "P", "tradingClass": "SPXW"},
        {"action": "SELL", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
         "strike": 7700.0, "right": "C", "tradingClass": "SPXW"},
        {"action": "BUY", "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
         "strike": 7750.0, "right": "C", "tradingClass": "SPXW"},
    ]}, order={"totalQuantity": 1, "lmtPrice": 2.0, "tif": "DAY"}), settings_over=tight)  # (50 − 2) × 100 = 4800
    case("tight_call_spread_auto_mid_ok", spread_order(), settings_over=tight)  # 宽度 30 × 100 = 3000
    case("tight_stock_23000_over", stock_order(), settings_over=tight)  # 100 × 230 = 23000 → 拦
    case("tight_mkt_1000_shares_over", stock_order(
        contract={"symbol": "MSFT"},
        order={"orderType": "MKT", "lmtPrice": None, "totalQuantity": 1000}),
        settings_over=tight)  # 无参考价,超 200 股 → 拦
    case("tight_six_contracts_over", option_order(order={"totalQuantity": 6, "lmtPrice": 0.5}),
         settings_over=tight)  # 敞口 300 不超,张数 6 > 5 → 拦
    case("notional_only_six_contracts_ok", option_order(order={"totalQuantity": 6, "lmtPrice": 0.5}),
         settings_over={"limits": {"max_order_notional": 5_000.0}})  # 张数上限回落到基准 10(不是引擎默认 5)→ 放行:钉住合并语义
    case("tight_mkt_ref_22940_over", stock_order(order={"orderType": "MKT", "lmtPrice": None}),
         settings_over=tight)  # 市价单有快照:229.4 × 100 = 22940 → 按金额拦,不是按股数
    case("tight_mkt_ref_20_ok", stock_order(order={"orderType": "MKT", "lmtPrice": None, "totalQuantity": 20}),
         settings_over=tight)  # 20 × 229.4 = 4588 → 放行
    case("tight_mkt_ref_300_over", stock_order(order={"orderType": "MKT", "lmtPrice": None, "totalQuantity": 300}),
         settings_over=tight)  # 68820 → 金额消息;200 股上限只在无参考价时生效
    case("tight_condor_sell_two_7600_over", condor_order(), settings_over=tight)  # 2 × (50 − 12) × 100 = 7600 → 拦
    case("stock_mkt_no_ref_over_shares", stock_order(
        contract={"symbol": "ZZZZ"},
        order={"orderType": "MKT", "lmtPrice": None, "totalQuantity": 300}))
    case("stock_mkt_no_ref_ok", stock_order(
        contract={"symbol": "ZZZZ"},
        order={"orderType": "MKT", "lmtPrice": None, "totalQuantity": 100}))
    case("bag_auto_mid_width_bound", spread_order(order={"totalQuantity": 20}))
    # 时段
    weekend = datetime(2026, 8, 15, 11, 0, tzinfo=ET)
    case("closed_immediate_mkt", stock_order(order={"orderType": "MKT", "lmtPrice": None}), now=weekend)
    case("closed_immediate_lmt_warn", stock_order(), now=weekend)
    case("closed_conditional_queue", spread_order(), now=weekend)
    case("closed_reject_all", stock_order(), now=weekend,
         settings_over={"policies": {"closed_market_policy": "reject_all"}})
    premarket = datetime(2026, 8, 14, 8, 0, tzinfo=ET)
    case("premarket_mkt_outside_rth", stock_order(order={
        "orderType": "MKT", "lmtPrice": None, "outsideRth": True}), now=premarket)
    case("premarket_lmt_wait", stock_order(), now=premarket)
    case("early_close_after", stock_order(), now=datetime(2026, 11, 27, 14, 0, tzinfo=ET))
    # 防抖
    sig = order_signature(ParsedOrder.model_validate(stock_order()), "DEFAULT")
    case("dup_recent_window", stock_order(), recents=[
        {"signature": sig, "quantity": 100.0, "created_at": (NOW - timedelta(minutes=5)).isoformat()}])
    case("dup_outside_window", stock_order(), recents=[
        {"signature": sig, "quantity": 100.0, "created_at": (NOW - timedelta(minutes=25)).isoformat()}])
    case("dup_qty_tolerance", stock_order(order={"totalQuantity": 110}), recents=[
        {"signature": sig, "quantity": 100.0, "created_at": (NOW - timedelta(minutes=5)).isoformat()}])
    case("no_reason_warn", stock_order(reason=""))

    # validate_all:批内重复 + 超量
    settings = make_settings()
    orders = [ParsedOrder.model_validate(stock_order()) for _ in range(2)]
    orders += [ParsedOrder.model_validate(option_order()) for _ in range(5)]
    outcome = Validator(settings, NOW, snapshot, []).validate_all(orders)
    batch = {
        "payloads": [stock_order() for _ in range(2)] + [option_order() for _ in range(5)],
        "now": NOW.isoformat(), "snapshot": snapshot,
        "approved": [
            {"notional": a.notional, "signature": a.signature, "warnings": a.warnings}
            for a in outcome.approved
        ],
        "rejected": [
            {"codes": [i.code for i in r.issues], "message": r.message()}
            for r in outcome.rejected
        ],
    }
    dump("validator", {"base_config": BASE_CONFIG, "cases": cases, "batch": batch})


# ================================================================ tracker
def gen_tracker():
    from ibkr_agent import flyexit as fx

    # 分档来自 flyexit(唯一事实源),实盘这边只是换个基准:浮盈/成本 = 浮盈/D
    FLY_TIERS = fx.drawdown_tiers(None)
    FLY_LATE = fx.drawdown_late(None)

    positions = {
        "long_stock": {"account": "模拟", "symbol": "AAPL", "sec_type": "STK",
                       "quantity": 100.0, "avg_cost": 220.0, "multiplier": 1.0},
        "short_stock": {"account": "模拟", "symbol": "TSLA", "sec_type": "STK",
                        "quantity": -50.0, "avg_cost": 250.0, "multiplier": 1.0},
        "long_option": {"account": "模拟", "symbol": "NVDA", "sec_type": "OPT",
                        "quantity": 2.0, "avg_cost": 550.0, "multiplier": 100.0},
        "broker_pnl": {"account": "模拟", "symbol": "SPY", "sec_type": "STK",
                       "quantity": 10.0, "avg_cost": 500.0, "multiplier": 1.0,
                       "market_price": 510.0, "market_value": 5100.0, "unrealized_pnl": 99.5},
        # 借方蝶:D=2.25、1 组、乘数 100(9-03 那张单的形状)
        "long_fly": {"account": "模拟", "symbol": "SPX", "sec_type": "BAG",
                     "quantity": 1.0, "avg_cost": 225.0, "multiplier": 100.0},
        # 贷方鹰:收 2.00、1 组 → 记为空头
        "short_condor": {"account": "模拟", "symbol": "SPX", "sec_type": "BAG",
                         "quantity": -1.0, "avg_cost": 200.0, "multiplier": 100.0},
    }

    def P(name):
        return tracker.Position(**positions[name])

    unrealized_cases = [
        {"position": "long_stock", "price": 230.0},
        {"position": "long_stock", "price": None},
        {"position": "short_stock", "price": 240.0},
        {"position": "short_stock", "price": 260.0},
        {"position": "long_option", "price": 6.5},
        {"position": "broker_pnl", "price": 505.0},
    ]
    for c in unrealized_cases:
        c["expect"] = tracker.unrealized(P(c["position"]), c["price"])

    validate_cases = [
        {"position": "long_stock", "targets": {}, "price": 230.0},
        {"position": "long_stock", "targets": {"take_profit": 250.0, "stop_loss": 210.0}, "price": 230.0},
        {"position": "long_stock", "targets": {"take_profit": 210.0}, "price": 230.0},
        {"position": "long_stock", "targets": {"stop_loss": 250.0}, "price": 230.0},
        {"position": "long_stock", "targets": {"take_profit": 250.0, "stop_loss": 260.0}, "price": None},
        {"position": "short_stock", "targets": {"take_profit": 230.0, "stop_loss": 270.0}, "price": 250.0},
        {"position": "short_stock", "targets": {"take_profit": 270.0}, "price": 250.0},
        {"position": "short_stock", "targets": {"stop_loss": 240.0}, "price": 250.0},
        {"position": "long_stock", "targets": {"trail_pct": 150.0}, "price": 230.0},
        {"position": "long_stock", "targets": {"take_profit": -5.0}, "price": 230.0},
        {"position": "long_stock", "targets": {"trail_pct": 5.0}, "price": None},
        {"position": "long_stock", "targets": {"profit_drawdown_pct": 30.0}, "price": 230.0},
        {"position": "long_stock", "targets": {"profit_drawdown_pct": 100.0}, "price": 230.0},
    ]
    for c in validate_cases:
        try:
            tracker.validate(P(c["position"]), tracker.Targets(**c["targets"]), c["price"])
            c["expect"] = {"ok": True}
        except tracker.TrackerError as exc:
            c["expect"] = {"ok": False, "error": str(exc)}

    peak_cases = [
        {"position": "long_stock", "price": 240.0, "peak": 235.0},
        {"position": "long_stock", "price": 230.0, "peak": 235.0},
        {"position": "short_stock", "price": 240.0, "peak": 245.0},
        {"position": "short_stock", "price": 250.0, "peak": 245.0},
        {"position": "long_stock", "price": None, "peak": 235.0},
        {"position": "long_stock", "price": 240.0, "peak": None},
    ]
    for c in peak_cases:
        c["expect"] = tracker.advance_peak(P(c["position"]), c["price"], c["peak"])

    trail_cases = [
        {"position": "long_stock", "peak": 240.0, "trail_pct": 5.0},
        {"position": "short_stock", "peak": 230.0, "trail_pct": 4.0},
        {"position": "long_stock", "peak": None, "trail_pct": 5.0},
    ]
    for c in trail_cases:
        c["expect"] = tracker.trail_stop_price(P(c["position"]), c["peak"], c["trail_pct"])

    evaluate_cases = [
        {"position": "long_stock", "targets": {"take_profit": 250.0, "stop_loss": 210.0},
         "price": 251.0, "peak": None},
        {"position": "long_stock", "targets": {"take_profit": 250.0, "stop_loss": 210.0},
         "price": 209.0, "peak": None},
        # 跳空同时满足两边 → 止损优先
        {"position": "long_stock", "targets": {"take_profit": 250.0, "stop_loss": 260.0},
         "price": 300.0, "peak": None},
        {"position": "long_stock", "targets": {"trail_pct": 5.0}, "price": 228.0, "peak": 240.0},
        {"position": "long_stock", "targets": {"trail_pct": 5.0, "stop_loss": 220.0},
         "price": 236.0, "peak": 250.0},
        {"position": "short_stock", "targets": {"take_profit": 230.0}, "price": 229.0, "peak": None},
        {"position": "short_stock", "targets": {"trail_pct": 4.0}, "price": 240.0, "peak": 230.0},
        {"position": "long_stock", "targets": {"take_profit": 250.0}, "price": None, "peak": 235.0},
        # 利润回撤追踪:峰值 260(利润 4000),现价 240(利润 2000),回撤 50% > 30% → 触发
        {"position": "long_stock", "targets": {"profit_drawdown_pct": 30.0},
         "price": 240.0, "peak": 260.0},
        {"position": "long_stock", "targets": {"profit_drawdown_pct": 30.0},
         "price": 255.0, "peak": 260.0},
        {"position": "long_stock", "targets": {"profit_drawdown_pct": 30.0},
         "price": 180.0, "peak": 190.0},
        {"position": "short_stock", "targets": {"profit_drawdown_pct": 30.0},
         "price": 235.0, "peak": 200.0},
        {"position": "long_stock", "targets": {"profit_drawdown_pct": 30.0, "stop_loss": 190.0},
         "price": 185.0, "peak": 260.0},
        # 分档回撤(flyexit 那套 40/30/20,按浮盈/成本换档)
        {"position": "long_fly", "targets": {"profit_drawdown_tiers": FLY_TIERS},
         "price": 5.70, "peak": 8.00},                      # 2.56×D → 40% 档,正好触发
        {"position": "long_fly", "targets": {"profit_drawdown_tiers": FLY_TIERS},
         "price": 6.50, "peak": 8.00},                      # 同峰值只回撤 26% → 继续持有
        {"position": "long_fly", "targets": {"profit_drawdown_tiers": FLY_TIERS},
         "price": 10.00, "peak": 12.00},                    # 4.33×D → 20% 档
        {"position": "long_fly", "targets": {"profit_drawdown_tiers": FLY_TIERS},
         "price": 2.60, "peak": 3.00},                      # 0.33×D → 40% 档
        # 尾盘减半:同样的峰值,15:00 之后阈值 30→15
        {"position": "long_fly",
         "targets": {"profit_drawdown_tiers": FLY_TIERS, "profit_drawdown_late": FLY_LATE},
         "price": 5.90, "peak": 7.50, "minute": 14 * 60 + 59},
        {"position": "long_fly",
         "targets": {"profit_drawdown_tiers": FLY_TIERS, "profit_drawdown_late": FLY_LATE},
         "price": 5.90, "peak": 7.50, "minute": 15 * 60},
        # 贷方组合:倍数按"赚到的 / 当初收的权利金"算
        {"position": "short_condor", "targets": {"profit_drawdown_tiers": FLY_TIERS},
         "price": 1.20, "peak": 0.40},
        # 分档与固定值并存时分档优先;两个都没配 → 不判利润回撤
        {"position": "long_fly",
         "targets": {"profit_drawdown_pct": 90.0, "profit_drawdown_tiers": FLY_TIERS},
         "price": 5.70, "peak": 8.00},
        {"position": "long_fly", "targets": {}, "price": 5.70, "peak": 8.00},
    ]
    for c in evaluate_cases:
        c["expect"] = tracker.evaluate(P(c["position"]), tracker.Targets(**c["targets"]),
                                       c["price"], c["peak"], minute=c.get("minute"))

    # 分档阈值本身(纯函数,基准 = 浮盈/|成本|)
    threshold_cases = []
    for peak_profit, basis, minute in ((75.0, 225.0, None), (225.0, 225.0, None), (525.0, 225.0, None),
                                       (775.0, 225.0, None), (525.0, 225.0, 15 * 60),
                                       (525.0, -200.0, None), (0.0, 225.0, None)):
        for name, tg in (("tiers", {"profit_drawdown_tiers": FLY_TIERS}),
                         ("tiers_late", {"profit_drawdown_tiers": FLY_TIERS,
                                         "profit_drawdown_late": FLY_LATE}),
                         ("flat", {"profit_drawdown_pct": 25.0}),
                         ("none", {})):
            threshold_cases.append({
                "targets": name, "profit_peak": peak_profit, "basis": basis, "minute": minute,
                "expect": tracker.drawdown_threshold(tracker.Targets(**tg), peak_profit, basis, minute),
            })
    threshold_targets = {
        "tiers": {"profit_drawdown_tiers": FLY_TIERS},
        "tiers_late": {"profit_drawdown_tiers": FLY_TIERS, "profit_drawdown_late": FLY_LATE},
        "flat": {"profit_drawdown_pct": 25.0},
        "none": {},
    }

    blocker_cases = [
        {"auto": {"enabled": True}, "position": "long_stock", "account_is_paper": True,
         "auto_execute": True, "allow_live_trading": False, "breaker_engaged": False,
         "market_status": "盘中", "outside_rth": False, "already_fired": False},
        {"auto": {"enabled": False}, "position": "long_stock", "account_is_paper": False,
         "auto_execute": False, "allow_live_trading": False, "breaker_engaged": True,
         "market_status": "盘前", "outside_rth": False, "already_fired": True},
        {"auto": {"enabled": True}, "position": "long_stock", "account_is_paper": True,
         "auto_execute": True, "allow_live_trading": False, "breaker_engaged": False,
         "market_status": "盘前", "outside_rth": True, "already_fired": False},
        # 组合:纸面随便跑,实盘要另开 allow_combo_live(单腿不受这道闸约束)
        {"auto": {"enabled": True}, "position": "long_fly", "account_is_paper": True,
         "auto_execute": True, "allow_live_trading": True, "breaker_engaged": False,
         "market_status": "盘中", "outside_rth": False, "already_fired": False},
        {"auto": {"enabled": True}, "position": "long_fly", "account_is_paper": False,
         "auto_execute": True, "allow_live_trading": True, "breaker_engaged": False,
         "market_status": "盘中", "outside_rth": False, "already_fired": False},
        {"auto": {"enabled": True}, "position": "long_fly", "account_is_paper": False,
         "auto_execute": True, "allow_live_trading": True, "breaker_engaged": False,
         "market_status": "盘中", "outside_rth": False, "already_fired": False,
         "combo_live_ok": True},
        {"auto": {"enabled": True}, "position": "long_option", "account_is_paper": False,
         "auto_execute": True, "allow_live_trading": True, "breaker_engaged": False,
         "market_status": "盘中", "outside_rth": False, "already_fired": False},
    ]
    for c in blocker_cases:
        c["expect"] = tracker.close_blockers(
            auto=tracker.AutoClose(**c["auto"]), position=P(c["position"]),
            account_is_paper=c["account_is_paper"], auto_execute=c["auto_execute"],
            allow_live_trading=c["allow_live_trading"], breaker_engaged=c["breaker_engaged"],
            market_status=c["market_status"], outside_rth=c["outside_rth"],
            already_fired=c["already_fired"], combo_live_ok=c.get("combo_live_ok", False))

    limit_cases = [
        {"position": "long_stock", "price": 230.0, "slippage_pct": 0.3},
        {"position": "short_stock", "price": 250.0, "slippage_pct": 0.5},
        {"position": "long_stock", "price": None, "slippage_pct": 0.3},
        {"position": "long_stock", "price": 0.02, "slippage_pct": 90.0},
    ]
    for c in limit_cases:
        c["expect"] = tracker.close_limit_price(P(c["position"]), c["price"], c["slippage_pct"])

    # 组合平仓:腿方向全部反转,比例取绝对值
    fly_contract = {
        "secType": "BAG", "symbol": "SPX", "exchange": "SMART", "currency": "USD",
        "multiplier": "100", "combo_strategy": "BUTTERFLY", "label": "买入看跌蝶 7600/7615/7630",
        "legs": [
            {"lastTradeDateOrContractMonth": "20260901", "strike": 7600.0, "right": "P", "ratio": 1.0},
            {"lastTradeDateOrContractMonth": "20260901", "strike": 7615.0, "right": "P", "ratio": -2.0},
            {"lastTradeDateOrContractMonth": "20260901", "strike": 7630.0, "right": "P", "ratio": 1.0},
        ],
    }
    condor_contract = {
        "secType": "BAG", "symbol": "SPX", "exchange": "SMART", "currency": "USD",
        "multiplier": "100", "combo_strategy": "IRON_CONDOR", "label": "铁鹰",
        "legs": [
            {"lastTradeDateOrContractMonth": "20260901", "strike": 7500.0, "right": "P", "ratio": 1.0},
            {"lastTradeDateOrContractMonth": "20260901", "strike": 7550.0, "right": "P", "ratio": -1.0},
            {"lastTradeDateOrContractMonth": "20260901", "strike": 7700.0, "right": "C", "ratio": -1.0},
            {"lastTradeDateOrContractMonth": "20260901", "strike": 7750.0, "right": "C", "ratio": 1.0},
        ],
    }
    close_bag_cases = [{"name": "butterfly", "contract": fly_contract},
                       {"name": "condor", "contract": condor_contract}]
    for c in close_bag_cases:
        c["expect"] = tracker.close_bag_contract(c["contract"])
    close_bag_errors = []
    for name, bad in (
        ("no_legs", {"secType": "BAG", "symbol": "SPX", "legs": []}),
        ("ratio_3", {"secType": "BAG", "symbol": "SPX", "legs": [
            {"lastTradeDateOrContractMonth": "20260901", "strike": 7500.0, "right": "P", "ratio": 3.0}]}),
        ("ratio_zero", {"secType": "BAG", "symbol": "SPX", "legs": [
            {"lastTradeDateOrContractMonth": "20260901", "strike": 7500.0, "right": "P", "ratio": 0}]}),
        ("no_strike", {"secType": "BAG", "symbol": "SPX", "legs": [
            {"lastTradeDateOrContractMonth": "20260901", "strike": None, "right": "P", "ratio": 1.0}]}),
    ):
        try:
            tracker.close_bag_contract(bad)
            close_bag_errors.append({"name": name, "contract": bad, "error": None})
        except tracker.TrackerError as exc:
            close_bag_errors.append({"name": name, "contract": bad, "error": str(exc)})

    contract = {"secType": "STK", "symbol": "AAPL", "exchange": "SMART", "currency": "USD"}
    build_cases = [
        {"position": "long_stock", "auto": {"enabled": True, "order_type": "MKT"},
         "price": 230.0, "state": "take_profit"},
        {"position": "short_stock", "auto": {"enabled": True, "order_type": "LMT", "slippage_pct": 0.5},
         "price": 250.0, "state": "stop_loss"},
        # 部分平仓:50% 向下取整;利润回撤文案
        {"position": "long_stock", "auto": {"enabled": True, "order_type": "MKT",
                                              "close_fraction_pct": 50.0},
         "price": 240.0, "state": "profit_trail"},
        # 盘外:市价自动转限价 + outsideRth;限价照旧但带盘外标志;盘中不受影响
        {"position": "long_stock", "auto": {"enabled": True, "order_type": "MKT"},
         "price": 230.0, "state": "take_profit", "market_status": "盘前"},
        {"position": "short_stock", "auto": {"enabled": True, "order_type": "LMT", "slippage_pct": 0.5},
         "price": 250.0, "state": "stop_loss", "market_status": "盘后"},
        {"position": "long_stock", "auto": {"enabled": True, "order_type": "MKT"},
         "price": 230.0, "state": "take_profit", "market_status": "休市"},
    ]
    for c in build_cases:
        c["expect"] = tracker.build_close_order(
            P(c["position"]), tracker.AutoClose(**c["auto"]), c["price"], c["state"], contract,
            market_status=c.get("market_status", "盘中"))

    # 组合平仓单:MKT 一律转 LMT;借方蝶卖出、贷方鹰买回
    build_bag_cases = [
        {"position": "long_fly", "auto": {"enabled": True, "order_type": "MKT"},
         "price": 5.75, "state": "profit_trail", "contract": "fly"},
        {"position": "long_fly", "auto": {"enabled": True, "order_type": "LMT", "slippage_pct": 5.0},
         "price": 5.75, "state": "profit_trail", "contract": "fly"},
        {"position": "short_condor", "auto": {"enabled": True, "order_type": "LMT", "slippage_pct": 5.0},
         "price": 1.40, "state": "stop_loss", "contract": "condor"},
        {"position": "long_fly", "auto": {"enabled": True, "order_type": "MKT"},
         "price": 5.75, "state": "take_profit", "contract": "fly", "market_status": "盘后"},
    ]
    bag_contracts = {"fly": fly_contract, "condor": condor_contract}
    for c in build_bag_cases:
        c["expect"] = tracker.build_close_order(
            P(c["position"]), tracker.AutoClose(**c["auto"]), c["price"], c["state"],
            bag_contracts[c["contract"]], market_status=c.get("market_status", "盘中"))
    bag_no_price = {"position": "long_fly", "auto": {"enabled": True, "order_type": "MKT"},
                    "price": None, "state": "profit_trail", "contract": "fly"}
    try:
        tracker.build_close_order(P("long_fly"), tracker.AutoClose(enabled=True, order_type="MKT"),
                                  None, "profit_trail", fly_contract)
    except tracker.TrackerError as exc:
        bag_no_price["error"] = str(exc)
    build_error_extended = {"position": "long_stock",
                            "auto": {"enabled": True, "order_type": "MKT"}, "price": None,
                            "state": "stop_loss", "market_status": "盘前"}
    try:
        tracker.build_close_order(P(build_error_extended["position"]),
                                  tracker.AutoClose(**build_error_extended["auto"]), None,
                                  "stop_loss", contract, market_status="盘前")
    except tracker.TrackerError as exc:
        build_error_extended["error"] = str(exc)
    lmt_no_price = {"position": "long_stock",
                    "auto": {"enabled": True, "order_type": "LMT"}, "price": None, "state": "stop_loss"}
    try:
        tracker.build_close_order(P(lmt_no_price["position"]),
                                  tracker.AutoClose(**lmt_no_price["auto"]), None, "stop_loss", contract)
    except tracker.TrackerError as exc:
        lmt_no_price["error"] = str(exc)

    # 券商托管:利润回撤 → 停损价换算,与 hosted_plan 的完整订单清单
    ptrail_cases = [
        {"position": "long_stock", "peak": 260.0, "dd": 30.0},     # 220+40×0.7=248
        {"position": "long_stock", "peak": 215.0, "dd": 30.0},     # 峰值没过成本 → None
        {"position": "short_stock", "peak": 200.0, "dd": 30.0},    # 250−50×0.7=215
        {"position": "short_stock", "peak": 260.0, "dd": 30.0},    # 空头峰值高于成本 → None
        {"position": "long_option", "peak": 8.0, "dd": 50.0},      # 5.5+2.5×0.5=6.75
        {"position": "long_stock", "peak": None, "dd": 30.0},
        {"position": "long_stock", "peak": 260.0, "dd": None},
    ]
    for c in ptrail_cases:
        c["expect"] = tracker.profit_trail_stop_price(P(c["position"]), c["peak"], c["dd"])

    plan_cases = [
        {"position": "long_stock",
         "targets": {"take_profit": 250.0, "stop_loss": 200.0},
         "auto": {"enabled": True, "host_at_broker": True}, "peak": 230.0},
        {"position": "long_stock",
         "targets": {"take_profit": 250.0, "trail_pct": 5.0, "profit_drawdown_pct": 30.0},
         "auto": {"enabled": True, "host_at_broker": True, "close_fraction_pct": 50.0},
         "peak": 260.0},
        {"position": "short_stock",
         "targets": {"stop_loss": 270.0, "profit_drawdown_pct": 30.0},
         "auto": {"enabled": True, "host_at_broker": True}, "peak": 200.0},
        {"position": "long_option",
         "targets": {"take_profit": 9.876543, "profit_drawdown_pct": 50.0},
         "auto": {"enabled": True, "host_at_broker": True}, "peak": 8.0},
        # 托管没开 → 空清单
        {"position": "long_stock", "targets": {"take_profit": 250.0},
         "auto": {"enabled": True}, "peak": 230.0},
    ]
    for c in plan_cases:
        c["expect"] = tracker.hosted_plan(
            P(c["position"]), tracker.Targets(**c["targets"]),
            tracker.AutoClose(**c["auto"]), c["peak"])

    needs_update_cases = [
        {"current": {"quantity": 100, "aux_price": 236.0}, "desired": {"quantity": 100, "aux_price": 236.004}},
        {"current": {"quantity": 100, "aux_price": 236.0}, "desired": {"quantity": 100, "aux_price": 236.01}},
        {"current": {"quantity": 100, "aux_price": 236.0}, "desired": {"quantity": 50, "aux_price": 236.0}},
        {"current": {"quantity": 100, "aux_price": 236.0}, "desired": {"quantity": 100, "aux_price": None}},
        {"current": {"quantity": 100, "lmt_price": 250.0}, "desired": {"quantity": 100, "lmt_price": 250.0}},
    ]
    for c in needs_update_cases:
        c["expect"] = tracker.hosted_needs_update(c["current"], c["desired"])

    # 期权腿身份 + 组合识别(蝴蝶三条腿都是 SPX 的 OPT,key 必须带腿)
    def leg_row(account, symbol, expiry, strike, right, qty, cost, mv=None, pnl=None):
        contract = {"secType": "OPT", "symbol": symbol, "lastTradeDateOrContractMonth": expiry,
                    "strike": strike, "right": right, "multiplier": "100"}
        ident = tracker.leg_of(contract)
        return {"key": tracker.position_key(account, symbol, "OPT", ident), "account": account,
                "symbol": symbol, "sec_type": "OPT", "leg": ident,
                "label": tracker.position_label(symbol, "OPT", contract), "quantity": qty,
                "avg_cost": cost, "multiplier": 100.0, "currency": "USD", "market_price": None,
                "market_value": mv, "unrealized_pnl": pnl, "contract": contract}

    stock_row = {"key": tracker.position_key("模拟", "AAPL", "STK"), "account": "模拟", "symbol": "AAPL",
                 "sec_type": "STK", "leg": "", "label": "AAPL", "quantity": 100.0, "avg_cost": 220.0,
                 "multiplier": 1.0, "currency": "USD", "market_price": None, "market_value": None,
                 "unrealized_pnl": None, "contract": {"secType": "STK", "symbol": "AAPL"}}
    leg_sets = {
        "butterfly": [leg_row("模拟", "SPX", "20260901", 7630.0, "P", 1.0, 50.0, 40.0, -10.0),
                      leg_row("模拟", "SPX", "20260901", 7600.0, "P", 1.0, 30.0, 35.0, 5.0),
                      leg_row("模拟", "SPX", "20260901", 7615.0, "P", -2.0, 40.0, -70.0, 10.0), stock_row],
        "vertical": [leg_row("模拟", "NVDA", "20260918", 180.0, "C", 2.0, 500.0),
                     leg_row("模拟", "NVDA", "20260918", 190.0, "C", -2.0, 200.0)],
        "condor": [leg_row("模拟", "SPX", "20260901", 7500.0, "P", 1.0, 10.0),
                   leg_row("模拟", "SPX", "20260901", 7550.0, "P", -1.0, 20.0),
                   leg_row("模拟", "SPX", "20260901", 7700.0, "C", -1.0, 20.0),
                   leg_row("模拟", "SPX", "20260901", 7750.0, "C", 1.0, 10.0)],
        "iron_fly": [leg_row("模拟", "SPX", "20260901", 7550.0, "P", 1.0, 10.0),
                     leg_row("模拟", "SPX", "20260901", 7600.0, "P", -1.0, 20.0),
                     leg_row("模拟", "SPX", "20260901", 7600.0, "C", -1.0, 20.0),
                     leg_row("模拟", "SPX", "20260901", 7650.0, "C", 1.0, 10.0)],
        "custom": [leg_row("模拟", "SPX", "20260901", 7500.0, "P", 1.0, 10.0),
                   leg_row("模拟", "SPX", "20260901", 7550.0, "P", 3.0, 20.0)],
        # 同一到期日的多张组合必须各算各的(2026-09-04 纸面实测:一张看跌蝶 + 一张看涨蝶
        # 被揉成"组合(6 腿)",净价/成本/盈亏全混在一起,平仓单也拼不出来)
        "two_flies_mixed_right": [
            leg_row("模拟", "SPX", "20260904", 7595.0, "P", 1.0, 36.54),
            leg_row("模拟", "SPX", "20260904", 7620.0, "P", -2.0, 43.81),
            leg_row("模拟", "SPX", "20260904", 7645.0, "P", 1.0, 86.54),
            leg_row("模拟", "SPX", "20260904", 7800.0, "C", 1.0, 256.63),
            leg_row("模拟", "SPX", "20260904", 7820.0, "C", -2.0, 108.72),
            leg_row("模拟", "SPX", "20260904", 7840.0, "C", 1.0, 61.54)],
        "two_flies_same_right": [
            leg_row("模拟", "SPX", "20260904", 7595.0, "P", 1.0, 30.0),
            leg_row("模拟", "SPX", "20260904", 7620.0, "P", -2.0, 40.0),
            leg_row("模拟", "SPX", "20260904", 7645.0, "P", 1.0, 50.0),
            leg_row("模拟", "SPX", "20260904", 7800.0, "P", 1.0, 20.0),
            leg_row("模拟", "SPX", "20260904", 7820.0, "P", -2.0, 30.0),
            leg_row("模拟", "SPX", "20260904", 7840.0, "P", 1.0, 40.0)],
        # 一张蝶 + 认不出的两条腿:能认的先认,剩下整块留 custom
        "fly_plus_leftovers": [
            leg_row("模拟", "SPX", "20260901", 7500.0, "P", 1.0, 10.0),
            leg_row("模拟", "SPX", "20260901", 7520.0, "P", -2.0, 10.0),
            leg_row("模拟", "SPX", "20260901", 7540.0, "P", 1.0, 10.0),
            leg_row("模拟", "SPX", "20260901", 7900.0, "P", 3.0, 10.0),
            leg_row("模拟", "SPX", "20260901", 7950.0, "P", 7.0, 10.0)],
        "single_and_split": [leg_row("模拟", "SPX", "20260901", 7600.0, "P", 1.0, 10.0),
                             leg_row("模拟", "SPX", "20260902", 7615.0, "P", -1.0, 10.0)],
    }
    group_cases = [{"name": name, "rows": rows, "expect": tracker.group_legs(rows)}
                   for name, rows in leg_sets.items()]
    # 结构切分本身(纯函数):同一桶里的腿怎么被切成独立组合
    split_cases = []
    for name, rows in leg_sets.items():
        opts = sorted([r for r in rows if r["sec_type"] == "OPT"],
                      key=lambda r: (float((r.get("contract") or {}).get("strike") or 0.0),
                                     str((r.get("contract") or {}).get("right") or "")))
        if len(opts) < 2:
            continue
        chunks = tracker.split_structures(opts)
        split_cases.append({
            "name": name,
            # 自带完整腿数据:不同用例里同一个 key 可能对应不同数量,靠全局查表会串
            "rows": opts,
            "expect": [[r["key"] for r in chunk] for chunk in chunks],
            "shapes": [tracker.shape_of(chunk) for chunk in chunks],
        })
    # 组合虚拟行:给几条腿配上现价,组合价/成本/方向都要逐字段一致
    priced = {}
    for name, rows in leg_sets.items():
        rows = [dict(r) for r in rows]
        for r, price in zip(rows, (0.35, 0.35, 0.40, 6.0, 1.2, 1.2, 0.5)):
            if r["sec_type"] == "OPT":
                r["market_price"] = price
        priced[name] = rows
    priced["vertical_no_quote"] = [dict(r) for r in leg_sets["vertical"]]
    priced["vertical_no_quote"][0]["market_price"] = 6.0
    combo_row_cases = [{"name": name, "rows": rows, "expect": tracker.with_combos(rows)}
                       for name, rows in priced.items()]
    label_cases = [
        {"symbol": "SPX", "sec_type": "OPT",
         "contract": {"secType": "OPT", "lastTradeDateOrContractMonth": "20260901", "strike": 7615.0, "right": "P"}},
        {"symbol": "NVDA", "sec_type": "OPT",
         "contract": {"secType": "OPT", "lastTradeDateOrContractMonth": "20260918", "strike": 182.5, "right": "C"}},
        {"symbol": "AAPL", "sec_type": "STK", "contract": {"secType": "STK"}},
    ]
    for c in label_cases:
        c["leg"] = tracker.leg_of(c["contract"])
        c["label"] = tracker.position_label(c["symbol"], c["sec_type"], c["contract"])
        c["key"] = tracker.position_key("模拟", c["symbol"], c["sec_type"], c["leg"])
    track_key_cases = [
        {"track": {"account": "模拟", "symbol": "AAPL", "sec_type": "STK"}},
        {"track": {"account": "模拟", "symbol": "SPX", "sec_type": "OPT", "leg": "20260901|7615|P"}},
        {"track": {"account": "模拟", "symbol": "SPX", "sec_type": "OPT"}},
    ]
    for c in track_key_cases:
        c["expect"] = tracker.track_key(c["track"])

    # RPC 层的分档参数清洗(两侧同一份规则:preset / 自列档位 / 各种拒绝)
    from ibkr_agent import rpc as rpc_mod
    tier_param_cases = []
    for name, params in (
        ("preset_fly", {"profit_drawdown_preset": "fly"}),
        ("preset_case_insensitive", {"profit_drawdown_preset": "FLY"}),
        ("empty", {}),
        ("explicit_null", {"profit_drawdown_tiers": None}),
        ("custom", {"profit_drawdown_tiers": [{"above": 0, "pct": 50}, {"above": 2, "pct": 25}]}),
        ("custom_with_late", {"profit_drawdown_tiers": [{"above": 0, "pct": 35}],
                              "profit_drawdown_late": {"after": "15:30", "factor": 0.4}}),
        ("late_without_tiers", {"profit_drawdown_late": {"after": "15:30", "factor": 0.4}}),
        ("bad_not_list", {"profit_drawdown_tiers": {"above": 0, "pct": 30}}),
        ("bad_empty_list", {"profit_drawdown_tiers": []}),
        ("bad_item", {"profit_drawdown_tiers": [1, 2]}),
        ("bad_missing", {"profit_drawdown_tiers": [{"above": 0}]}),
        ("bad_negative_above", {"profit_drawdown_tiers": [{"above": -1, "pct": 30}]}),
        ("bad_pct_zero", {"profit_drawdown_tiers": [{"above": 0, "pct": 0}]}),
        ("bad_pct_over", {"profit_drawdown_tiers": [{"above": 0, "pct": 101}]}),
        ("bad_factor", {"profit_drawdown_tiers": [{"above": 0, "pct": 30}],
                        "profit_drawdown_late": {"after": "15:00", "factor": 2}}),
    ):
        case = {"name": name, "params": params}
        try:
            tiers, late = rpc_mod._drawdown_tiers(params)
            case["expect"] = {"tiers": tiers, "late": late}
        except rpc_mod.RpcError as exc:
            case["error"] = {"code": exc.code, "message": exc.message}
        tier_param_cases.append(case)

    dump("tracker", {
        "positions": positions,
        "drawdown_tiers_params": tier_param_cases,
        "group_legs": group_cases,
        "split_structures": split_cases,
        "with_combos": combo_row_cases,
        "legs": label_cases,
        "track_key": track_key_cases,
        "unrealized": unrealized_cases,
        "validate": validate_cases,
        "advance_peak": peak_cases,
        "trail_stop": trail_cases,
        "evaluate": evaluate_cases,
        "drawdown_threshold": threshold_cases,
        "drawdown_threshold_targets": threshold_targets,
        "fly_tiers": {"tiers": FLY_TIERS, "late": FLY_LATE},
        "close_blockers": blocker_cases,
        "close_bag_contract": close_bag_cases,
        "close_bag_contract_errors": close_bag_errors,
        "build_close_order_bag": build_bag_cases,
        "build_close_order_bag_error": bag_no_price,
        "close_limit_price": limit_cases,
        "build_close_order": build_cases,
        "build_close_order_error": lmt_no_price,
        "build_close_order_error_extended": build_error_extended,
        "close_side": {"long_stock": tracker.close_side(P("long_stock")),
                       "short_stock": tracker.close_side(P("short_stock"))},
        "profit_trail_stop": ptrail_cases,
        "hosted_plan": plan_cases,
        "hosted_needs_update": needs_update_cases,
    })


# ================================================================ priceaction
def _synth_bars(seed: int, n: int, start_price: float, drift: float, vol: float):
    rng = random.Random(seed)
    bars = []
    day = datetime(2026, 8, 12, 9, 30)
    t = day
    price = start_price
    for i in range(n):
        o = price
        move = rng.gauss(drift, vol)
        c = max(o * (1 + move), 0.5)
        hi = max(o, c) * (1 + abs(rng.gauss(0, vol / 2)))
        lo = min(o, c) * (1 - abs(rng.gauss(0, vol / 2)))
        volu = round(abs(rng.gauss(1_000_000, 300_000)))
        bars.append({"time": t.strftime("%Y-%m-%d %H:%M"), "open": round(o, 4),
                     "high": round(hi, 4), "low": round(lo, 4), "close": round(c, 4),
                     "volume": float(volu)})
        price = c
        t += timedelta(minutes=5)
        if t.hour >= 16:
            day = day + timedelta(days=1)
            t = day
    return bars


def gen_priceaction():
    now = datetime(2026, 8, 14, 15, 55, tzinfo=ET)
    series = {
        "uptrend": _synth_bars(7, 160, 100.0, 0.0015, 0.004),
        "downtrend": _synth_bars(11, 160, 250.0, -0.0015, 0.004),
        "range": _synth_bars(23, 160, 50.0, 0.0, 0.003),
        "short": _synth_bars(5, 20, 80.0, 0.0, 0.003),
    }
    cases = []
    for name, rows in series.items():
        entry = {"name": name, "rows": rows, "symbol": name.upper(), "timeframe": "5m",
                 "now": now.isoformat(), "extended_hours": name == "uptrend"}
        try:
            result = priceaction.analyze(rows, symbol=name.upper(), timeframe="5m",
                                         now=now, extended_hours=entry["extended_hours"])
            entry["expect"] = result
            entry["facts_text"] = priceaction.facts_text(result)
            entry["htf_summary"] = priceaction.htf_summary(result)
        except priceaction.PriceActionError as exc:
            entry["error"] = str(exc)
        cases.append(entry)

    up = priceaction.analyze(series["uptrend"], symbol="UP", timeframe="5m", now=now)
    down = priceaction.analyze(series["downtrend"], symbol="DN", timeframe="5m", now=now)
    agreements = [
        {"a": "uptrend", "b": "downtrend",
         "expect": priceaction.agreement(up, priceaction.htf_summary(down))},
        {"a": "uptrend", "b": "uptrend",
         "expect": priceaction.agreement(up, priceaction.htf_summary(up))},
        {"a": "uptrend", "b": None, "expect": priceaction.agreement(up, None)},
    ]
    dump("priceaction", {"cases": cases, "agreement": agreements,
                         "timeframes": priceaction.TIMEFRAMES})


# ================================================================ optionwall
def gen_optionwall():
    now = datetime(2026, 8, 14, 10, 32, tzinfo=ET)
    rng = random.Random(99)
    spot = 452.6

    def chain(with_greeks: bool):
        rows = []
        for k in range(400, 505, 5):
            dist = abs(k - spot) / spot
            call_oi = round(max(rng.gauss(8000 * (1 - dist * 6), 1500), 0))
            put_oi = round(max(rng.gauss(9000 * (1 - dist * 5), 1500), 0))
            call_vol = round(max(rng.gauss(5000 * (1 - dist * 8), 1200), 0))
            put_vol = round(max(rng.gauss(5200 * (1 - dist * 7), 1200), 0))
            iv = round(0.18 + dist * 0.6 + rng.random() * 0.01, 4) if with_greeks else None
            row_c = {"strike": float(k), "right": "C", "oi": call_oi, "volume": call_vol}
            row_p = {"strike": float(k), "right": "P", "oi": put_oi, "volume": put_vol}
            if with_greeks:
                row_c["iv"] = iv
                row_p["iv"] = iv
                if k % 10 == 0:
                    row_c["gamma"] = round(0.002 + rng.random() * 0.002, 6)
                    row_p["gamma"] = round(0.002 + rng.random() * 0.002, 6)
            rows.append(row_c)
            rows.append(row_p)
        return rows

    cases = []
    for name, expiry, greeks in (
        ("monthly", "20260918", True),
        ("zero_dte", "20260814", True),
        ("no_greeks", "20260918", False),
    ):
        rows = chain(greeks)
        entry = {"name": name, "rows": rows, "spot": spot, "expiry": expiry,
                 "symbol": "SPY", "now": now.isoformat()}
        result = optionwall.analyze(rows, spot, expiry=expiry, symbol="SPY", now=now)
        entry["expect"] = result
        entry["levels_for_pa"] = optionwall.levels_for_pa(result)
        cases.append(entry)

    errors = []
    try:
        optionwall.analyze(chain(True), 0.0, expiry="20260918", now=now)
    except optionwall.OptionWallError as exc:
        errors.append({"name": "no_spot", "error": str(exc)})
    try:
        optionwall.analyze(chain(True)[:6], spot, expiry="20260918", now=now)
    except optionwall.OptionWallError as exc:
        errors.append({"name": "few_strikes", "error": str(exc)})

    gamma_cases = [
        {"spot": 452.6, "strike": 450.0, "t": 0.1, "sigma": 0.2},
        {"spot": 452.6, "strike": 500.0, "t": 0.002, "sigma": 0.35},
        {"spot": 452.6, "strike": 450.0, "t": 0.0, "sigma": 0.2},
        {"spot": 0.0, "strike": 450.0, "t": 0.1, "sigma": 0.2},
    ]
    for c in gamma_cases:
        c["expect"] = optionwall.bs_gamma(c["spot"], c["strike"], c["t"], c["sigma"])
    tte_cases = [
        {"expiry": "20260918", "now": now.isoformat()},
        {"expiry": "20260814", "now": now.isoformat()},
        {"expiry": "bogus", "now": now.isoformat()},
        {"expiry": "20260231", "now": now.isoformat()},
    ]
    for c in tte_cases:
        c["expect"] = optionwall.years_to_expiry(c["expiry"], datetime.fromisoformat(c["now"]))
    dump("optionwall", {"cases": cases, "errors": errors,
                        "bs_gamma": gamma_cases, "years_to_expiry": tte_cases})


# ================================================================ backtest
def gen_backtest():
    rng = random.Random(2024)
    bars = []
    day = datetime(2025, 6, 2)
    price = 100.0
    for i in range(320):
        while day.weekday() >= 5:
            day += timedelta(days=1)
        o = price
        c = max(o * (1 + rng.gauss(0.0006, 0.015)), 1.0)
        hi = max(o, c) * (1 + abs(rng.gauss(0, 0.006)))
        lo = min(o, c) * (1 - abs(rng.gauss(0, 0.006)))
        bars.append({"date": day.strftime("%Y-%m-%d"), "open": round(o, 4),
                     "high": round(hi, 4), "low": round(lo, 4), "close": round(c, 4)})
        price = c
        day += timedelta(days=1)

    def B():
        return [backtest.Bar(**b) for b in bars]

    cases = []

    def case(name, strategy, params=None, rules=None, instrument=None):
        entry = {"name": name, "strategy": strategy, "params": params,
                 "rules": rules, "instrument": instrument}
        try:
            entry["expect"] = backtest.run_backtest(B(), strategy, params, rules, instrument)
        except backtest.BacktestError as exc:
            entry["error"] = str(exc)
        cases.append(entry)

    case("buy_hold", "buy_hold")
    case("sma_cross", "sma_cross", {"fast": 10, "slow": 50})
    case("sma_bad_params", "sma_cross", {"fast": 50, "slow": 10})
    case("rsi", "rsi", {"period": 14, "buy_below": 30, "sell_above": 70})
    case("breakout", "breakout", {"entry": 20, "exit": 10})
    case("unknown", "nope")
    case("custom_macd", "custom", rules={
        "entry": [{"left": {"kind": "indicator", "name": "macd_hist"},
                   "op": "cross_up", "right": {"kind": "const", "value": 0.0}}],
        "exit": [{"left": {"kind": "indicator", "name": "macd_hist"},
                  "op": "cross_down", "right": {"kind": "const", "value": 0.0}}],
    })
    case("custom_sma_close", "custom", rules={
        "entry": [{"left": {"kind": "indicator", "name": "close"},
                   "op": ">", "right": {"kind": "indicator", "name": "sma", "period": 20}},
                  {"left": {"kind": "indicator", "name": "rsi", "period": 14},
                   "op": "<", "right": {"kind": "const", "value": 70.0}}],
        "exit": [{"left": {"kind": "indicator", "name": "close"},
                  "op": "<", "right": {"kind": "indicator", "name": "lowest", "period": 10}}],
    })
    case("option_call", "sma_cross", {"fast": 10, "slow": 50},
         instrument={"type": "call", "dte": 30, "offset_pct": 0.0, "width_pct": 2.0, "risk_pct": 10.0})
    case("option_spread", "breakout", {"entry": 20, "exit": 10},
         instrument={"type": "call_spread", "dte": 45, "offset_pct": 1.0, "width_pct": 3.0,
                     "risk_pct": 15.0})
    case("option_butterfly", "rsi", {"period": 14, "buy_below": 35, "sell_above": 65},
         instrument={"type": "butterfly", "dte": 21, "offset_pct": 0.0, "width_pct": 2.0,
                     "risk_pct": 8.0})
    dump("backtest", {"bars": bars, "cases": cases, "strategies": backtest.STRATEGIES})


# ================================================================ alerts
def gen_alerts():
    round_cases = [
        {"spot": 41.2, "step": 5.0}, {"spot": 40.0, "step": 5.0},
        {"spot": 452.6, "step": 5.0}, {"spot": 0.0, "step": 5.0},
        {"spot": 7462.35, "step": 25.0},
    ]
    for c in round_cases:
        c["expect"] = alerts.round_levels(c["spot"], c["step"])

    wall = {
        "days_to_expiry": 0.5,
        "call_wall": {"strike": 455.0}, "put_wall": {"strike": 445.0},
        "call_vol_wall": {"strike": 450.0}, "put_vol_wall": {"strike": 440.0},
        "max_pain": {"strike": 450.0}, "gamma_flip": 447.3,
    }
    wall_monthly = dict(wall, days_to_expiry=35.0)
    build_cases = [
        {"spot": 452.6, "wall": wall, "step": 5.0},
        {"spot": 452.6, "wall": wall_monthly, "step": 5.0},
        {"spot": 452.6, "wall": None, "step": 5.0},
        {"spot": 41.2, "wall": None, "step": 5.0},
    ]
    for c in build_cases:
        levels = alerts.build_levels(c["spot"], c["wall"], c["step"])
        c["expect"] = [l.as_dict() | {"priority": l.priority} for l in levels]
        c["describe"] = alerts.describe(levels, c["spot"])

    # 趋势位:均线 + 52 周高低点(自造日线,规律性数据便于人工校验)
    def daily(closes, low_dip=0.0, high_pop=0.0):
        return [
            {"date": "2026-01-%02d" % (i % 28 + 1), "open": c,
             "high": c * (1 + high_pop), "low": c * (1 - low_dip), "close": c}
            for i, c in enumerate(closes)
        ]

    rising = [40.0 + i * 0.1 for i in range(300)]
    flat_dip = [50.0] * 250
    flat_dip[10] = 42.0
    flat_dip[200] = 61.0
    trend_cases = [
        {"spot": 69.9, "bars": daily(rising)},
        {"spot": 50.0, "bars": daily(flat_dip, 0.01, 0.01)},
        {"spot": 34.0, "bars": daily([30.0 + i * 0.05 for i in range(80)])},
        {"spot": 30.0, "bars": daily([30.0] * 10)},
    ]
    for c in trend_cases:
        t_levels = alerts.trend_levels(c["bars"], c["spot"])
        c["expect"] = [l.as_dict() | {"priority": l.priority} for l in t_levels]
        c["snapshot"] = alerts.trend_snapshot(c["bars"], c["spot"])

    build_with_history = {"spot": 41.0, "step": 5.0, "bars": daily([40.0] * 300)}
    h_levels = alerts.build_levels(
        build_with_history["spot"], None, build_with_history["step"],
        history=build_with_history["bars"],
    )
    build_with_history["expect"] = [l.as_dict() | {"priority": l.priority} for l in h_levels]

    levels = alerts.build_levels(452.6, wall, 5.0)
    walk = [None, 449.0, 450.5, 449.8, 450.4, 452.0, 456.0, 452.0, 444.0, 447.0]
    t0 = 1_755_000_000.0
    states = {}
    prev = None
    steps = []
    for i, price in enumerate(walk):
        if price is None:
            prev = None
            continue
        events, states = alerts.evaluate(levels, states, prev, price, t0 + i * 60.0)
        steps.append({
            "price": price, "at": t0 + i * 60.0,
            "events": events,
            "states": {k: v.as_dict() for k, v in sorted(states.items())},
        })
        prev = price
    # 冷却:同一价位快速往返
    states2 = {}
    seq2 = [(449.0, 0.0), (450.5, 30.0), (449.0, 60.0), (450.5, 90.0), (449.0, 400.0), (450.5, 420.0)]
    steps2 = []
    prev2 = None
    for price, dt in seq2:
        events, states2 = alerts.evaluate(levels, states2, prev2, price, t0 + dt,
                                          band_pct=0.05, cooldown=300.0)
        steps2.append({"price": price, "at": t0 + dt, "events": events})
        prev2 = price
    dump("alerts", {
        "round_levels": round_cases, "build_levels": build_cases,
        "trend_levels": trend_cases, "build_with_history": build_with_history,
        "walk": {"wall": wall, "spot": 452.6, "step": 5.0, "prices": walk, "t0": t0,
                 "steps": steps},
        "cooldown_walk": {"seq": seq2, "band_pct": 0.05, "cooldown": 300.0, "steps": steps2},
    })


# ================================================================ market
def gen_market():
    settings = make_settings()
    texts = [
        "买入 AAPL 100股 limit 230,理由:回调到位",
        "苹果回调到 225 就买 200 股",
        "SPX涨到7500就买入7520/7550的call spread",
        "7520的20cm蝴蝶",
        "buy 100 shares of TSLA at market open",
        "英伟达和特斯拉各买一点",
        "买入be10股",
        "watch the spread on ON and BE",
        "25cm 蝴蝶,标的照旧",
        "IREN 41 块,步长 5",
    ]
    cases = []
    for text in texts:
        cases.append({
            "text": text,
            "default": market.extract_symbols(text, settings),
            "no_default": market.extract_symbols(text, settings, default_index=False),
        })
    extra = market.extract_symbols("苹果", settings, extra=["QQQ"])
    snapshot = market.build_snapshot(
        ["AAPL", "SPX", "FAIL", "NONE"],
        lambda s: {"AAPL": 229.4, "SPX": 7462.35}.get(s) if s != "FAIL" else 1 / 0,
        cached={"NONE": 12.5},
    )
    dump("market", {"base_config": BASE_CONFIG, "cases": cases,
                    "extra": extra, "snapshot": snapshot})


# ================================================================ research
def gen_research():
    rng = random.Random(31)
    bars = []
    day = datetime(2026, 2, 2)
    price = 180.0
    for i in range(300):
        while day.weekday() >= 5:
            day += timedelta(days=1)
        o = price
        c = max(o * (1 + rng.gauss(0.0004, 0.02)), 1.0)
        bars.append({"date": day.strftime("%Y-%m-%d"), "open": round(o, 4),
                     "high": round(max(o, c) * 1.004, 4), "low": round(min(o, c) * 0.996, 4),
                     "close": round(c, 4)})
        price = c
        day += timedelta(days=1)
    today = "2026-08-14"
    from datetime import date

    anchors = [
        "上周五尾盘买入了一些",
        "周三开盘追进去的",
        "昨天收盘看着不错",
        "前天的低点没接到",
        "就是想买,没提时间",
    ]
    anchor_cases = [
        {"text": t, "expect": research.resolve_anchor(t, bars, date.fromisoformat(today))}
        for t in anchors
    ]
    brief = research.symbol_brief(bars)
    dump("research", {
        "bars": bars, "today": today, "anchors": anchor_cases,
        "brief": brief,
        "brief_text": research.brief_text("AAPL", dict(brief)),
        "brief_text_none": research.brief_text(None, None),
        "brief_text_no_data": research.brief_text("AAPL", None),
        "brief_text_error": research.brief_text("AAPL", {"error": "timeout"}),
        "brief_text_anchor": research.brief_text(
            "AAPL", dict(brief, anchor=anchor_cases[0]["expect"])),
        "brief_short": research.symbol_brief(bars[:1]),
    })


# ================================================================ screener
def _daily_closes(closes, start="2026-01-05", volume=1_000_000.0, spread=0.01, seed=None):
    """把一串收盘价铺成日线(跳过周末);seed 给了就让高低点与成交量带点随机。"""
    from datetime import date as _date

    rng = random.Random(seed) if seed is not None else None
    day = _date.fromisoformat(start)
    bars = []
    for c in closes:
        while day.weekday() >= 5:
            day += timedelta(days=1)
        hi = c * (1 + spread * (1 + (rng.random() if rng else 0)))
        lo = c * (1 - spread * (1 + (rng.random() if rng else 0)))
        vol = volume * (0.5 + rng.random() * 1.5) if rng else volume
        bars.append({"date": day.isoformat(), "open": round(c * (1 + (rng.uniform(-0.004, 0.004) if rng else 0)), 4),
                     "high": round(hi, 4), "low": round(lo, 4), "close": round(c, 4), "volume": round(vol)})
        day += timedelta(days=1)
    return bars


def _walk_closes(seed, n, start=100.0, drift=0.0, vol=0.01):
    rng = random.Random(seed)
    closes, price = [], start
    for _ in range(n):
        price = max(price * (1 + rng.gauss(drift, vol)), 1.0)
        closes.append(round(price, 4))
    return closes


def _v_shape(seed, first_low=90.0, second_low=89.0, slow=25):
    closes = [100.0] * 30
    closes += [100.0 - (100.0 - first_low) * i / 5 for i in range(1, 6)]
    closes += [first_low + (98.0 - first_low) * i / 10 for i in range(1, 11)]
    closes += [98.0 - (98.0 - second_low) * i / slow for i in range(1, slow + 1)]
    closes += [second_low + 0.8, second_low + 1.5, second_low + 2.2]
    rng = random.Random(seed)
    return [round(c + rng.uniform(-0.03, 0.03), 4) for c in closes]


def gen_screener():
    # ---- RS 强度:成员含停牌缺日、历史过短、空数据、带错误、无标签
    bench = _daily_closes(_walk_closes(101, 300, 400.0, 0.0004, 0.01), seed=1)
    members = []
    for i, (sym, tag, seed, drift) in enumerate([
        ("NVDA", "芯片", 11, 0.002), ("AMD", "芯片", 12, 0.0005), ("VRT", "电力", 13, 0.001),
        ("ANET", "网络", 14, -0.0005), ("SMCI", "服务器", 15, -0.002),
    ]):
        bars = _daily_closes(_walk_closes(seed, 300, 50.0 + 10 * i, drift, 0.02), seed=seed)
        if sym == "AMD":
            del bars[-4]                                   # 停牌一天:基准要按日期对齐
        if sym == "SMCI":
            bars = bars[-40:]                              # 历史短:长区间没有
        members.append({"symbol": sym, "tag": tag, "company": sym.title(), "bars": bars})
    members.append({"symbol": "COHR", "tag": "光模块", "company": "Coherent", "bars": [], "error": "额度用完"})
    members.append({"symbol": "MU", "tag": "", "bars": _daily_closes(_walk_closes(16, 300, 80.0, 0.001, 0.02), seed=16)})
    rs_cases = [
        {"name": "spy", "members": members, "bench": bench, "benchmark": "SPY",
         "expect": screener.rs_strength(members, bench, "SPY")},
        {"name": "short_windows", "members": members[:2], "bench": bench, "benchmark": "QQQ",
         "windows": [5, 20], "expect": screener.rs_strength(members[:2], bench, "QQQ", (5, 20))},
        {"name": "no_bench", "members": members[:1], "bench": None, "benchmark": "SPY",
         "expect": screener.rs_strength(members[:1], None, "SPY")},
    ]

    # ---- 周线重采样
    weekly_daily = _daily_closes(_walk_closes(21, 60, 120.0, 0.0, 0.015), seed=21)
    weekly_daily.append({"date": "not-a-date", "open": 1, "high": 1, "low": 1, "close": 1})
    weekly = {"bars": weekly_daily, "expect": screener.resample_weekly(weekly_daily)}

    # ---- CD 背离
    cd_series = {
        "bull": _daily_closes(_v_shape(1), seed=31),
        "bull_deeper": _daily_closes(_v_shape(3, 90.0, 86.0), seed=32),
        "bear": _daily_closes([200.0 - (c - 100.0) for c in _v_shape(3)], seed=33),
        "stale": _daily_closes(_v_shape(4) + [100.0] * 20, seed=34),
        "confirmed": _daily_closes(_v_shape(5) + [99.0, 101.0, 103.0], seed=35),
        "failed": _daily_closes(_v_shape(5) + [99.0, 101.0, 103.0, 88.0], seed=36),
        "random": _daily_closes(_walk_closes(37, 200, 60.0, 0.0, 0.02), seed=37),
        "short": _daily_closes([100.0] * 30),
        "flat": _daily_closes([100.0] * 80),
    }
    cd_cases = []
    for name, bars in cd_series.items():
        for ma in (None, 30):
            kw = {"ma_period": ma}
            if name in ("stale", "confirmed", "failed"):
                kw["max_age"] = 40 if name == "stale" else 20
            cd_cases.append({"name": name, "bars": bars, "kw": kw,
                             "expect": screener.cd_divergence(bars, **kw)})

    infl_members = [
        {"symbol": "flat", "tag": "芯片", "frames": {"1d": cd_series["flat"], "1w": cd_series["flat"]}},
        {"symbol": "hit", "tag": "芯片", "frames": {"1d": cd_series["bull"], "1w": cd_series["flat"]}},
        {"symbol": "bear", "tag": "电力", "frames": {"1d": cd_series["bear"], "1w": cd_series["confirmed"]}},
        {"symbol": "broken", "tag": "", "frames": {}, "errors": {"1d": "额度用完", "1w": ""}},
    ]
    inflections = [
        {"members": infl_members, "timeframes": ["1d", "1w"], "ma_period": None,
         "expect": screener.screen_inflections(infl_members, ["1d", "1w"], None)},
        {"members": infl_members, "timeframes": ["1w", "1d"], "ma_period": 30,
         "expect": screener.screen_inflections(infl_members, ["1w", "1d"], 30)},
    ]

    # ---- 极值偏离
    base = _walk_closes(9, 200, vol=0.01)
    dev_series = {
        "calm": _daily_closes(base, seed=41),
        "spike": _daily_closes(base + [base[-1] * 1.25], seed=42),
        "crash": _daily_closes(base + [base[-1] * 0.75], seed=43),
        "gap": _daily_closes([100.0] * 30) + [{"date": "2026-03-02", "open": 110.0, "high": 112.0,
                                               "low": 108.0, "close": 108.0, "volume": 3_000_000.0}],
        "short": _daily_closes([100.0] * 10),
        "wild": _daily_closes(_walk_closes(44, 150, 20.0, 0.0, 0.05), seed=44),
    }
    dev_series["broken"] = [dict(b) for b in dev_series["calm"][:60]]
    dev_series["broken"][5]["close"] = None
    dev_series["broken"][6]["high"] = -1
    dev_cases = []
    for name, bars in dev_series.items():
        for kw in ({}, {"period": 5, "lookback": 20, "smooth": 1, "keep": 30},
                   {"period": 50, "lookback": 60, "z_extreme": 1.5}):
            dev_cases.append({"name": name, "bars": bars, "kw": kw,
                              "expect": screener.deviation_review(bars, **kw)})

    dump("screener", {
        "rs": rs_cases, "weekly": weekly, "cd": cd_cases, "inflections": inflections,
        "deviation": dev_cases,
        "constants": {"RS_WINDOWS": list(screener.RS_WINDOWS), "RS_BENCHMARKS": list(screener.RS_BENCHMARKS),
                      "UNTAGGED": screener.UNTAGGED, "MIN_CD_BARS": screener.MIN_CD_BARS},
    })


# ================================================================ config
def gen_config():
    settings = make_settings()
    status_cases = []
    for iso in [
        "2026-08-14T03:59:00-04:00", "2026-08-14T04:00:00-04:00", "2026-08-14T09:29:00-04:00",
        "2026-08-14T09:30:00-04:00", "2026-08-14T15:59:00-04:00", "2026-08-14T16:00:00-04:00",
        "2026-08-14T19:59:00-04:00", "2026-08-14T20:00:00-04:00", "2026-08-15T11:00:00-04:00",
        "2026-09-07T11:00:00-04:00", "2026-11-27T12:59:00-05:00", "2026-11-27T13:00:00-05:00",
    ]:
        status_cases.append({"now": iso,
                             "expect": settings.market_status(datetime.fromisoformat(iso))})

    # 合约自己的交易时段(IBKR contractDetails)。样本是 2026-09-04 纸面账户实测的
    # SPXW:US/Central 的「19:15–次日 08:25」+「08:30–15:00」,换成美东就是
    # 「20:15–次日 09:25 隔夜」+「09:30–16:00 常规」。正股那张表判不出隔夜段。
    SPXW_HOURS = "20260903:1915-20260904:0825;20260904:0830-20260904:1500;20260905:CLOSED"
    SPXW_LIQUID = "20260904:0830-20260904:1500;20260905:CLOSED"
    hours_cases = []
    for spec, liquid, tz, iso in [
        (SPXW_HOURS, SPXW_LIQUID, "US/Central", "2026-09-04T01:10:00-04:00"),   # 隔夜:能交易
        (SPXW_HOURS, SPXW_LIQUID, "US/Central", "2026-09-04T08:00:00-04:00"),
        (SPXW_HOURS, SPXW_LIQUID, "US/Central", "2026-09-04T09:24:00-04:00"),   # 隔夜段最后一分钟
        (SPXW_HOURS, SPXW_LIQUID, "US/Central", "2026-09-04T09:26:00-04:00"),   # 两段之间的缝
        (SPXW_HOURS, SPXW_LIQUID, "US/Central", "2026-09-04T09:40:00-04:00"),   # 常规
        (SPXW_HOURS, SPXW_LIQUID, "US/Central", "2026-09-04T15:59:00-04:00"),
        (SPXW_HOURS, SPXW_LIQUID, "US/Central", "2026-09-04T16:30:00-04:00"),   # 收盘后
        (SPXW_HOURS, SPXW_LIQUID, "US/Central", "2026-09-05T11:00:00-04:00"),   # 周六 CLOSED
        (SPXW_HOURS, "", "US/Central", "2026-09-04T01:10:00-04:00"),            # 没有流动性表
        ("", "", "US/Central", "2026-09-04T01:10:00-04:00"),                    # 没有时段表 → 空串
        (SPXW_HOURS, SPXW_LIQUID, "", "2026-09-04T01:10:00-04:00"),             # 没有时区 → 空串
        ("20260905:CLOSED;20260906:CLOSED", "", "US/Central", "2026-09-04T01:10:00-04:00"),
        ("垃圾;20260904:0830-20260904:1500", SPXW_LIQUID, "US/Central", "2026-09-04T09:40:00-04:00"),
    ]:
        moment = datetime.fromisoformat(iso)
        hours_cases.append({
            "spec": spec, "liquid": liquid, "tz": tz, "now": iso,
            "expect": cfg_mod.hours_status(spec, tz, moment, liquid),
            "stock_table": settings.market_status(moment),
        })
    parse_cases = [{"spec": spec, "expect": [[a.isoformat(), b.isoformat()]
                                             for a, b in cfg_mod.parse_trading_hours(spec)]}
                   for spec in (SPXW_HOURS, SPXW_LIQUID, "", "20260905:CLOSED",
                                "20260904:0830-1500", "乱七八糟", "20260904:1500-20260904:0830")]

    error_cases = []

    def err(name, overrides):
        try:
            make_settings(**overrides)
            error_cases.append({"name": name, "overrides": overrides, "error": None})
        except ValueError as exc:
            error_cases.append({"name": name, "overrides": overrides, "error": str(exc)})

    err("dup_alias", {"accounts": [
        {"alias": "模拟", "account_id": "DU1", "is_paper": True, "connection": "paper", "default": True},
        {"alias": "模拟", "account_id": "DU2", "is_paper": True, "connection": "paper"}]})
    err("alias_default_reserved", {"accounts": [
        {"alias": "DEFAULT", "account_id": "DU1", "is_paper": True, "connection": "paper", "default": True}]})
    err("two_defaults", {"accounts": [
        {"alias": "a", "account_id": "DU1", "is_paper": True, "connection": "paper", "default": True},
        {"alias": "b", "account_id": "DU2", "is_paper": True, "connection": "paper", "default": True}]})
    err("bad_host", {"connections": {"paper": {"host": "10.0.0.5", "port": 7497, "client_id": 11}}})
    err("orphan_connection", {"accounts": [
        {"alias": "a", "account_id": "DU1", "is_paper": True, "connection": "nope", "default": True}]})
    err("bad_policy", {"policies": {"closed_market_policy": "whatever"}})
    err("bad_effort", {"llm": {"effort": "ultra"}})
    err("bad_flag_string", {"policies": {"auto_execute": "true"}})
    err("bad_limit_low", {"limits": {"max_order_notional": 0.0}})
    err("unknown_limit_key", {"limits": {"max_notional": 5.0}})
    err("bad_broker", {"broker": {"provider": "schwab"}})
    err("bad_futu_market", {"broker": {"futu": {"trd_market": "JP"}}})
    err("broker_no_connection", {"broker": {"provider": "futu"}})
    err("bad_confidence", {"limits": {"min_confidence": 1.5}})

    dump("config", {
        "base_config": BASE_CONFIG,
        "market_status": status_cases,
        "hours_status": hours_cases,
        "parse_trading_hours": parse_cases,
        "errors": error_cases,
        "prompt_account_table": settings.prompt_account_table(),
        "prompt_symbol_table": settings.prompt_symbol_table(),
        "alias_list": settings.alias_list(),
        "account_by_alias": {
            "DEFAULT": settings.account_by_alias("DEFAULT").account_id,
            "主账户": settings.account_by_alias("主账户").account_id,
            "missing": None,
        },
        "connections_for_default": sorted(settings.connections_for()),
        "is_trading_day": {
            "2026-08-14": settings.is_trading_day(datetime(2026, 8, 14).date()),
            "2026-08-15": settings.is_trading_day(datetime(2026, 8, 15).date()),
            "2026-09-07": settings.is_trading_day(datetime(2026, 9, 7).date()),
        },
    })


# ================================================================ prompts
def gen_prompts():
    entries = []
    for version in sorted(p.name.split("_v")[1][:-3] for p in (ROOT.parent / "prompts").glob("system_v*.md")):
        v = "v" + version
        settings = make_settings(prompt_version=v)
        bundle = load_prompt_bundle(settings)
        user_text = render_user(bundle, settings, "买入 AAPL 100股 limit 230", NOW,
                                snapshot={"AAPL": 229.4, "SPX": 7462.35})
        import hashlib

        entries.append({
            "version": v,
            "fingerprint": bundle.fingerprint,
            "system_sha256": hashlib.sha256(bundle.system_text.encode("utf-8")).hexdigest(),
            "system_len": len(bundle.system_text),
            "user_sha256": hashlib.sha256(user_text.encode("utf-8")).hexdigest(),
            "user_len": len(user_text),
            "fewshot_count": len(bundle.fewshot),
            # 发给模型的 rejection 代码表随提示词版本走(v1.8.0 起不列 EXCEEDS_LIMIT)
            "rejection_codes_sent": parse_schema_for_prompt(v)["$defs"]["Rejection"]["properties"]["code"]["enum"],
        })
    # 账号泄漏自检:把账号塞进指令,渲染必须炸
    settings = make_settings()
    bundle = load_prompt_bundle(settings)
    leak = {"instruction": "转到 DU7654321 名下"}
    try:
        render_user(bundle, settings, leak["instruction"], NOW)
        leak["error"] = None
    except PromptError as exc:
        leak["error"] = str(exc)
    sample = render_user(bundle, settings, "买入 AAPL 100股 limit 230", NOW,
                         snapshot={"AAPL": 229.4, "SPX": 7462.35})
    dump("prompts", {
        "base_config": BASE_CONFIG,
        "now": NOW.isoformat(),
        "versions": entries,
        "leak_check": leak,
        "sample_user_text": sample,
        "sample_snapshot": {"AAPL": 229.4, "SPX": 7462.35},
    })


# ================================================================ models
def gen_models():
    cases = []

    def case(name, payload):
        entry = {"name": name, "payload": payload}
        try:
            result = parse_llm_payload(payload)
            entry["expect"] = {
                "orders": [o.model_dump() for o in result.orders],
                "rejection_codes": [r.code for r in result.rejections],
                "rejection_texts": [r.original_text for r in result.rejections],
                "schema_error_count": len(result.schema_errors),
            }
        except TypeError as exc:
            entry["type_error"] = str(exc)
        cases.append(entry)

    case("good_stock", {"orders": [stock_order()], "rejections": []})
    case("good_spread", {"orders": [spread_order()], "rejections": []})
    case("symbol_normalized", {"orders": [stock_order(contract={"symbol": " aapl "})], "rejections": []})
    case("bad_order_degrades", {"orders": [
        stock_order(),
        stock_order(order={"totalQuantity": -5}),
    ], "rejections": []})
    case("extra_field_rejected", {"orders": [
        deep_update(stock_order(), {"surprise": 1}),
    ], "rejections": []})
    case("missing_price", {"orders": [
        stock_order(order={"lmtPrice": None}),
    ], "rejections": []})
    case("auto_mid_on_stock", {"orders": [
        stock_order(order={"price_mode": "AUTO_MID", "lmtPrice": None}),
    ], "rejections": []})
    case("conditional_without_trigger", {"orders": [
        stock_order(execution_type="CONDITIONAL"),
    ], "rejections": []})
    case("immediate_with_trigger", {"orders": [
        stock_order(trigger={"type": "PRICE", "symbol": "AAPL", "secType": "STK",
                             "operator": ">=", "value": 231.0}),
    ], "rejections": []})
    case("butterfly_leg_count", {"orders": [
        butterfly_order(contract={"legs": butterfly_order()["contract"]["legs"][:2]}),
    ], "rejections": []})
    case("opt_missing_strike", {"orders": [
        option_order(contract={"strike": None}),
    ], "rejections": []})
    case("stk_with_option_fields", {"orders": [
        stock_order(contract={"lastTradeDateOrContractMonth": "20260821"}),
    ], "rejections": []})
    case("bad_expiry_date", {"orders": [
        option_order(contract={"lastTradeDateOrContractMonth": "20260231"}),
    ], "rejections": []})
    case("trail_both_params", {"orders": [
        stock_order(order={"orderType": "TRAIL", "lmtPrice": None,
                           "auxPrice": 210.0, "trailingPercent": 5.0}),
    ], "rejections": []})
    case("stp_ok", {"orders": [
        stock_order(order={"orderType": "STP", "lmtPrice": None, "auxPrice": 210.0}),
    ], "rejections": []})
    case("model_rejection_passthrough", {"orders": [], "rejections": [
        {"original_text": "买点什么", "code": "UNCLEAR", "message": "指令含糊"},
    ]})
    case("bad_rejection_degrades", {"orders": [], "rejections": [
        {"original_text": "x", "code": "NOT_A_CODE", "message": "?"},
    ]})
    case("unknown_top_level", {"orders": [], "rejections": [], "meta": {"x": 1}})
    case("orders_not_list", {"orders": "nope", "rejections": []})
    dump("models", {"cases": cases})



# ================================================================ shorthand
def gen_shorthand():
    """本地速记解析:命中的 payload 与回落的 None 都要两个实现逐字节一致。"""
    from ibkr_agent.shorthand import try_parse_shorthand

    cases = [
        # 用户原话:call 侧 / put 侧
        {"text": "1.8 挂15蝴蝶 15CM", "snapshot": {"SPX": 6907.35}},
        {"text": "1.8 挂15蝴蝶 15CM", "snapshot": {"SPX": 6992.1}},
        # 绝对中心 + 权利金 / 明示看跌 + AUTO_MID
        {"text": "7520的20cm蝴蝶 2.5", "snapshot": {"SPX": 7462.35}},
        {"text": "7520的20cm看跌蝴蝶", "snapshot": {"SPX": 7462.35}},
        # 张数 / 非 SPX 标的(无 tradingClass)/ GTC / 中心等于现价
        {"text": "3张 7520的20cm蝴蝶 2.5", "snapshot": {"SPX": 7462.35}},
        {"text": "ndx 21020的30cm蝴蝶 5", "snapshot": {"NDX": 20988.0}},
        {"text": "gtc 7520的20cm蝴蝶 2.5", "snapshot": {"SPX": 7462.35}},
        # 盘外标志:SPX 期权隔夜段能交易,但订单不带 outsideRth 会被 IBKR 挂到常规时段
        {"text": "盘外 7520的20cm蝴蝶 2.5", "snapshot": {"SPX": 7462.35}},
        {"text": "隔夜 7520的20cm蝴蝶", "snapshot": {"SPX": 7462.35}},
        {"text": "7520的20cm蝴蝶 夜盘 2.5", "snapshot": {"SPX": 7462.35}},
        {"text": "gtc 盘外 3张 7520的20cm蝴蝶 2.5", "snapshot": {"SPX": 7462.35}},
        {"text": "6915的15cm蝴蝶 1.8", "snapshot": {"SPX": 6915.0}},
        # 回落
        {"text": "spx涨到7500时 7520的20cm蝴蝶", "snapshot": {"SPX": 7462.35}},
        {"text": "卖出7520的20cm蝴蝶 2.5", "snapshot": {"SPX": 7462.35}},
        {"text": "1.8 2.5 挂15蝴蝶 15CM", "snapshot": {"SPX": 6907.35}},
        {"text": "20 挂15蝴蝶 15CM", "snapshot": {"SPX": 6907.35}},
        {"text": "1.8 挂15蝴蝶 15CM", "snapshot": {}},
        {"text": "买入 AAPL 100股 limit 230", "snapshot": {"SPX": 6907.35}},
        # v2 语法扩充:全角/紧贴 ticker/中文数量词/权利金说法/±点翼宽/口语前缀
        {"text": "1.8 挂15蝴蝶 15cm,", "snapshot": {"SPX": 6907.35}},
        {"text": "spx7400来个25cm蝴蝶 3.3", "snapshot": {"SPX": 7462.35}},
        {"text": "两张 7520的20cm蝴蝶 2.5", "snapshot": {"SPX": 7462.35}},
        {"text": "买一张 7520的20cm蝴蝶 2.5", "snapshot": {"SPX": 7462.35}},
        {"text": "十张 7520的20cm蝴蝶 2.5", "snapshot": {"SPX": 7462.35}},
        {"text": "7520的20cm蝴蝶 权利金不超过2", "snapshot": {"SPX": 7462.35}},
        {"text": "7520的蝴蝶 ±20点 2.5", "snapshot": {"SPX": 7462.35}},
        {"text": "帮我挂 7520的20cm蝴蝶 2.5", "snapshot": {"SPX": 7462.35}},
        {"text": "7515蝴蝶 15cm 1.8", "snapshot": {"SPX": 7462.35}},
        {"text": "12.5cm 6915的蝴蝶 1.8", "snapshot": {"SPX": 6907.35}},
        # v2 守卫:中心偏离现价 >20%(写漏标的)/两个行权价量级的数
        {"text": "230的5cm蝴蝶 看涨 1.2", "snapshot": {"SPX": 6907.35}},
        {"text": "7400 7500 20cm蝴蝶 2.5", "snapshot": {"SPX": 7462.35}},
        # v3:尾巴上的理由本地接住(原文进 reason;理由里的"突破"不再触发回落);空理由回落
        {"text": "7520的20cm蝴蝶 3.3,理由:突破回踩", "snapshot": {"SPX": 7462.35}},
        {"text": "1.8 挂15蝴蝶 15CM 理由:开盘冲高回落", "snapshot": {"SPX": 7745.2}},
        {"text": "7520的20cm蝴蝶 3.3 理由", "snapshot": {"SPX": 7462.35}},
        # 真实群聊语料(命中):尝试/块钱/彩票/挂个/明天的/尾数00
        {"text": "尝试下 1.8 挂15蝴蝶 15CM", "snapshot": {"SPX": 7745.2}},
        {"text": "开个明天的7830蝴蝶吧 30CM的 5块钱", "snapshot": {"SPX": 7745.2}},
        {"text": "看看7700蝴蝶 25CM 5块钱能不能挂进去", "snapshot": {"SPX": 7745.2}},
        {"text": "挂个45蝴蝶彩票吧 20CM的 3块钱", "snapshot": {"SPX": 7745.2}},
        {"text": "00蝴蝶 看看4.4 25cm", "snapshot": {"SPX": 7745.2}},
        # cm 行话不写「蝴蝶」也认(用户确认):结构照旧是 1:-2:1 蝴蝶
        {"text": "spx明天 7850 40cm 2.3", "snapshot": {"SPX": 7745.2}},
        {"text": "7850 40cm 2.3", "snapshot": {"SPX": 7745.2}},
        # 真实群聊语料(回落):杂散单字母/无锚尾数/没有中心/翼宽在别的消息里
        {"text": "7720蝴蝶 30CM 尝试下4.4 y", "snapshot": {"SPX": 7745.2}},
        {"text": "1.8 挂15 15cm", "snapshot": {"SPX": 7745.2}},
        {"text": "40cm 2.3", "snapshot": {"SPX": 7745.2}},
        {"text": "尝试下7730蝴蝶 4.4能不能接到", "snapshot": {"SPX": 7745.2}},
        {"text": "彩票考虑下135蝴蝶 或者135日历吧", "snapshot": {"SPX": 7745.2}},
    ]
    for c in cases:
        c["expect"] = try_parse_shorthand(c["text"], c["snapshot"], NOW)

    weekend = {"text": "1.8 挂15蝴蝶 15CM", "snapshot": {"SPX": 6907.35},
               "moment": "2026-08-15",
               "expect": try_parse_shorthand(
                   "1.8 挂15蝴蝶 15CM", {"SPX": 6907.35},
                   datetime(2026, 8, 15, 10, 32, tzinfo=ET))}
    dump("shorthand", {"now": "2026-08-14T10:32", "cases": cases, "weekend": weekend})


def _all():
    gen_validator()
    gen_tradereview()
    gen_ibtrades()
    gen_flyexit()
    gen_tracker()
    gen_shorthand()
    gen_priceaction()
    gen_optionwall()
    gen_backtest()
    gen_alerts()
    gen_market()
    gen_research()
    gen_screener()
    gen_config()
    gen_prompts()
    gen_models()
    gen_broker()
    print("done")


# ================================================================ 0DTE 蝶式止盈策略
def gen_flyexit():
    from ibkr_agent import flyexit as fx

    PROFILE = {"symbol": "SPX", "right": "C", "lower": 7720.0, "center": 7740.0, "upper": 7760.0,
               "width": 20.0, "width_upper": 20.0, "action": "BUY", "qty": 3, "multiplier": 100.0, "debit": 6.0}

    def bars(closes, start="10:00", day="2026-09-03"):
        h, m = (int(x) for x in start.split(":"))
        out = []
        for c in closes:
            out.append({"time": "%s %02d:%02d" % (day, h, m), "open": c, "high": c + 0.5, "low": c - 0.5, "close": c})
            m += 1
            while m >= 60:
                h, m = h + 1, m - 60
        return out

    real = json.loads((OUT.parent / "sample-0903-bars.json").read_text(encoding="utf-8"))
    real_profile = dict(PROFILE, qty=1, debit=2.25)
    sw = fx.fmt_minute(fx.switch_minute(20.0, fx.params_from({"em": 36})))
    cases = [
        {"name": "real_0903_call_fly", "profile": real_profile, "entry": "2026-09-03 10:03", "spx": real["spx"],
         "fly": real["fly"], "params": {"em": 36}, "actual": {"kind": "closed", "price": 3.45, "pnl": 120.0}},
        {"name": "real_0903_model_only", "profile": real_profile, "entry": "2026-09-03 10:03", "spx": real["spx"],
         "fly": [], "params": {"em": 30}, "actual": None},
        {"name": "stage_a_thirds", "profile": PROFILE, "entry": "2026-09-03 10:00", "spx": bars([7740.0] * 300),
         "fly": bars([6.0, 7.0, 8.2, 9.0, 10.3] + [9.0] * 295), "params": None, "actual": None},
        {"name": "stop_price", "profile": PROFILE, "entry": "2026-09-03 10:00", "spx": bars([7740.0] * 10),
         "fly": bars([6.0, 5.0, 2.9, 2.0]), "params": None, "actual": None},
        {"name": "otm_entry", "profile": dict(PROFILE, debit=2.0), "entry": "2026-09-03 10:00",
         "spx": bars([7700.0, 7715.0, 7732.0, 7735.0]), "fly": bars([2.0, 2.2, 2.6, 2.7]), "params": None, "actual": None},
        {"name": "position_stop", "profile": PROFILE, "entry": "2026-09-03 10:00",
         "spx": bars([7740.0, 7740.0, 7760.0]), "fly": bars([6.0, 6.0, 4.0]), "params": None, "actual": None},
        {"name": "stage_b_cap_and_zone", "profile": PROFILE, "entry": "2026-09-03 14:00",
         "spx": bars([7740.0, 7740.0, 7752.0], "14:00"), "fly": bars([8.0, 8.0, 5.0], "14:00"), "params": None, "actual": None},
        {"name": "stage_b_trail", "profile": PROFILE, "entry": "2026-09-03 14:00",
         "spx": bars([7740.0] * 6, "14:00"), "fly": bars([6.0, 7.9, 9.0, 8.0, 6.7, 6.0], "14:00"), "params": None, "actual": None},
        {"name": "stage_c", "profile": PROFILE, "entry": "2026-09-03 " + sw,
         "spx": bars([7740.0, 7750.0, 7752.0], sw), "fly": bars([12.0, 9.0, 7.0], sw), "params": {"em": 36}, "actual": None},
        {"name": "settlement", "profile": dict(PROFILE, qty=1), "entry": "2026-09-03 15:56",
         "spx": bars([7745.0] * 6, "15:56"), "fly": [], "params": None, "actual": None},
        {"name": "short_not_applicable", "profile": dict(PROFILE, action="SELL"), "entry": "2026-09-03 10:00",
         "spx": bars([7740.0]), "fly": [], "params": None, "actual": None},
        {"name": "put_fly_custom_params", "profile": dict(PROFILE, right="P", debit=5.0), "entry": "2026-09-03 12:00",
         "spx": bars([7738.0, 7741.0, 7745.0, 7749.0, 7752.0], "12:00"), "fly": [],
         "params": {"em": 40, "tp1": 1.5, "tp2": 2.0, "cutoff_a": "13:30", "otm_band": 8}, "actual": {"kind": "expired", "price": 0.0, "pnl": -1500.0}},
        # v2.1 浮盈回撤追踪
        {"name": "real_0903_fixed_tiers", "profile": real_profile, "entry": "2026-09-03 10:03", "spx": real["spx"],
         "fly": real["fly"], "params": {"em": 36, "tp1": 1.35, "tp2": 1.7},
         "actual": {"kind": "closed", "price": 3.45, "pnl": 120.0}},
        {"name": "real_0903_three_lots", "profile": dict(real_profile, qty=3), "entry": "2026-09-03 10:03",
         "spx": real["spx"], "fly": real["fly"], "params": {"em": 36}, "actual": None},
        {"name": "trail_stage_a", "profile": dict(PROFILE, debit=2.25, qty=1), "entry": "2026-09-03 11:00",
         "spx": bars([7726.0, 7728.0, 7731.0, 7733.0, 7735.0, 7737.0, 7739.0, 7740.0, 7739.0, 7737.0, 7735.0, 7733.0], "11:00"),
         "fly": bars([2.25, 2.6, 3.3, 4.1, 5.0, 6.2, 7.2, 8.0, 7.4, 6.6, 6.2, 5.6], "11:00"),
         "params": None, "actual": None},
        {"name": "trail_floor_blocks_noise", "profile": dict(PROFILE, debit=2.25, qty=1), "entry": "2026-09-03 11:00",
         "spx": bars([7740.0] * 4, "11:00"), "fly": bars([2.25, 3.0, 2.85, 2.9], "11:00"), "params": None, "actual": None},
        {"name": "trail_late_halves", "profile": dict(PROFILE, debit=2.25, qty=1), "entry": "2026-09-03 15:00",
         "spx": bars([7740.0] * 5, "15:00"), "fly": bars([4.5, 5.0, 4.7, 4.6, 4.5], "15:00"),
         "params": {"em": 60}, "actual": None},     # EM 拉高把阶段 C 推后,好看清尾盘减半
        {"name": "otm_keeps_one_lot", "profile": dict(PROFILE, debit=2.0, qty=1), "entry": "2026-09-03 10:00",
         "spx": bars([7700.0, 7715.0, 7732.0, 7735.0]), "fly": bars([2.0, 2.2, 2.6, 2.7]), "params": None, "actual": None},
    ]
    for c in cases:
        c["expect"] = fx.plan(c["profile"], c["entry"], c["spx"], c["fly"], c["params"], c["actual"])
    minutes = [fx.minutes_of(t) for t in ("09:00", "09:30", "09:45", "10:30", "12:07", "13:30", "15:00", "15:30", "15:59", "16:00", "16:30")]
    dump("flyexit", {
        "cases": cases,
        "variance": [{"minute": m, "R": fx.remaining_variance(m), "sigma36": fx.sigma_remaining(36, m),
                      "phase_w25": fx.phase_at(m, 25.0, fx.params_from({"em": 36}))} for m in minutes],
        "switch": [{"width": w, "em": em, "expect": fx.switch_minute(w, fx.params_from({"em": em}))}
                   for w, em in ((25.0, 36), (25.0, 50), (40.0, 36), (20.0, 36), (10.0, 36))],
        "model": [{"s": s, "sigma": sg, "expect": fx.model_price(PROFILE, s, sg),
                   "put": fx.model_price(dict(PROFILE, right="P"), s, sg)}
                  for s, sg in ((7740, 36.0), (7740, 14.8), (7740, 0.0), (7700, 20.0), (7760, 5.0), (7731.5, 12.4187))],
        "params": [{"raw": r, "expect": fx.params_from(r)} for r in (
            None, {"em": "abc", "tp1": None, "stop": -1, "x": 3, "cutoff_a": "13:30"}, {"em": 42.5, "trail": 0.2},
            {"tp1": 1.35, "tp2": 1.7, "trail_late": "15:30", "trail_floor": 0.05})],
        "tranches": [{"qty": q, "expect": fx.tranche_sizes(q)} for q in (0, 1, 2, 3, 4, 7, 9)],
        "trail": [{"peak": pk, "d": d, "minute": fx.minutes_of(hhmm),
                   "pct": fx.trail_pct(pk, d, fx.minutes_of(hhmm), fx.params_from(None)),
                   "stop": fx.trail_stop(pk, d, fx.minutes_of(hhmm), fx.params_from(None))}
                  for pk, d, hhmm in ((0.5, 2.25, "11:00"), (2.0, 2.25, "11:00"), (3.0, 2.25, "11:00"),
                                      (5.75, 2.25, "11:00"), (7.0, 2.25, "11:00"), (5.75, 2.25, "15:30"),
                                      (0.0, 2.25, "11:00"), (12.0, 6.0, "14:59"), (12.0, 6.0, "15:00"))],
    })


# ================================================================ 券商成交 → 蝴蝶记录
def gen_ibtrades():
    from ibkr_agent import ibtrades as ibt

    accounts = [{"alias": "主账户", "account_id": "U18051177", "is_paper": False},
                {"alias": "模拟", "account_id": "DUR075261", "is_paper": True}]

    def fill(exec_id, time, side, shares, price, perm=256406619, sec="OPT", strike=None,
             right="C", expiry="20260903", account="U18051177", commission=None):
        contract = {"secType": sec, "symbol": "SPX", "currency": "USD", "exchange": "CBOE",
                    "expiry": expiry if sec != "BAG" else "", "strike": strike, "right": right,
                    "tradingClass": "SPXW" if sec != "BAG" else "", "multiplier": "100", "conId": 1}
        return {"exec_id": exec_id, "time": time, "account_id": account, "side": side, "shares": shares,
                "price": price, "order_id": 0, "perm_id": perm, "order_ref": "", "commission": commission,
                "contract": contract}

    T = "2026-09-03T14:03:34+00:00"
    long_fly = [fill("bag", T, "BOT", 1, 2.25, sec="BAG"), fill("e1", T, "BOT", 1, 0.22, strike=7760),
                fill("e2", T, "SLD", 2, 0.82, strike=7740), fill("e3", T, "BOT", 1, 3.67, strike=7720)]
    short_put = [
        fill("b", "2026-09-02T17:16:06+00:00", "SLD", 1, 2.85, sec="BAG", perm=392673899),
        fill("1", "2026-09-02T17:16:06+00:00", "BOT", 2, 0.72, strike=7635, right="P", expiry="20260902", perm=392673899, commission=1.1),
        fill("2", "2026-09-02T17:16:06+00:00", "SLD", 1, 4.02, strike=7660, right="P", expiry="20260902", perm=392673899, commission=0.55),
        fill("3", "2026-09-02T17:16:06+00:00", "SLD", 1, 0.27, strike=7610, right="P", expiry="20260902", perm=392673899, commission=0.55),
    ]
    partial = [
        fill("e1a", "2026-09-03T14:03:34+00:00", "BOT", 1, 0.20, strike=7760, perm=7),
        fill("e1b", "2026-09-03T14:03:30+00:00", "BOT", 1, 0.24, strike=7760, perm=7),
        fill("e2", "2026-09-03T14:03:34+00:00", "SLD", 4, 0.82, strike=7740, perm=7),
        fill("e3", "2026-09-03T14:03:34+00:00", "BOT", 2, 3.67, strike=7720, perm=7),
    ]
    broken = [dict(f) for f in long_fly]
    broken[1]["perm_id"] = 999
    unmapped = [dict(f, account_id="DU1234567") for f in long_fly]
    no_perm = [dict(f, perm_id=None, order_id=42) for f in long_fly]
    cases = [
        {"name": "bag_plus_legs", "fills": long_fly},
        {"name": "legs_only", "fills": [f for f in long_fly if f["exec_id"] != "bag"]},
        {"name": "short_put_with_commission", "fills": short_put},
        {"name": "partial_fills", "fills": partial},
        {"name": "mixed_two_orders", "fills": long_fly + short_put + partial},
        {"name": "broken_group", "fills": broken},
        {"name": "unmapped_paper_account", "fills": unmapped},
        {"name": "no_perm_id", "fills": no_perm},
        {"name": "spread_and_stock_ignored", "fills": [
            fill("s1", T, "BOT", 1, 1.0, strike=7700, perm=5), fill("s2", T, "SLD", 1, 0.5, strike=7720, perm=5),
            {"exec_id": "x", "time": T, "account_id": "U18051177", "side": "BOT", "shares": 1, "price": 326,
             "perm_id": 3, "contract": {"secType": "STK", "symbol": "AAPL"}}]},
    ]
    for c in cases:
        c["expect"] = ibt.group_butterflies(c["fills"], accounts)
    dump("ibtrades", {"accounts": accounts, "cases": cases,
                      "group_key": [{"fill": f, "expect": ibt.group_key(f)} for f in (long_fly[0], no_perm[0], {"exec_id": "zz"})]})


# ================================================================ 交易复盘(蝴蝶)
def gen_tradereview():
    from ibkr_agent import tradereview as tr
    from datetime import date

    def leg(action, ratio, strike, right="P", expiry="20260812"):
        return {"action": action, "ratio": ratio, "strike": strike, "right": right,
                "lastTradeDateOrContractMonth": expiry, "tradingClass": "SPXW", "multiplier": "100"}

    def fly(rid="r1", action="BUY", fill=1.75, limit=1.8, created="2026-08-12T14:35:00+00:00",
            fill_time="2026-08-12 14:36:10+00:00", strikes=(7600, 7615, 7630), right="P"):
        inner = "SELL" if action == "BUY" else "BUY"
        rec = {"id": rid, "created_at": created,
               "contract": {"secType": "BAG", "symbol": "SPX", "multiplier": "100", "combo_strategy": "BUTTERFLY",
                            "legs": [leg(action, 1, strikes[0], right), leg(inner, 2, strikes[1], right),
                                     leg(action, 1, strikes[2], right)]},
               "order": {"action": action, "totalQuantity": 1, "lmtPrice": limit},
               "ibkr": {"avg_fill_price": fill, "fills": []},
               "final_status": "filled" if fill is not None else None}
        if fill is not None:
            rec["ibkr"]["fills"] = [{"time": fill_time, "price": fill, "qty": 1}]
        return rec

    def flat(start_price, n=120, step=0.0, day="2026-08-12"):
        bars = []
        d = date.fromisoformat(day)
        h, m = 9, 30
        price = start_price
        for _ in range(n):
            bars.append({"time": "%s %02d:%02d" % (d.isoformat(), h, m), "open": price, "high": price + 1,
                         "low": price - 1, "close": price, "volume": 100.0})
            m += 5
            if m >= 60:
                h, m = h + 1, m - 60
            if (h, m) > (16, 0):
                d, h, m = d + timedelta(days=1), 9, 30
            price = round(price + step, 4)
        return bars

    now = datetime(2026, 8, 14, 12, 0, tzinfo=ET)
    noisy = _synth_bars(7, 300, 7660.0, -0.0002, 0.0008)
    wave = flat(7640, 40, -1.0) + flat(7600, 40, +2.0)
    for i, b in enumerate(wave[40:], 40):
        h, m = divmod(9 * 60 + 30 + i * 5, 60)
        b["time"] = "2026-08-12 %02d:%02d" % (h, m)
    closer = fly("r2", "SELL", 4.0, created="2026-08-12T16:00:00+00:00", fill_time="2026-08-12 16:01:00+00:00")
    daily_bars = [{"time": (date(2026, 7, 1) + timedelta(days=i)).isoformat(), "open": 7600 + i, "high": 7602 + i,
                   "low": 7598 + i, "close": 7600 + i, "volume": 0.0}
                  for i in range(60) if (date(2026, 7, 1) + timedelta(days=i)).weekday() < 5]
    cases = [
        {"name": "expired_win", "record": fly(), "others": [], "bars": flat(7640, 80, -0.32), "timeframe": "5m", "now": now.isoformat()},
        {"name": "expired_loss", "record": fly(), "others": [], "bars": flat(7640, 80, 1.0), "timeframe": "5m", "now": now.isoformat()},
        {"name": "closed", "record": fly(), "others": [fly(), closer], "bars": flat(7640, 80, -0.5), "timeframe": "5m", "now": now.isoformat()},
        {"name": "open", "record": fly(), "others": [], "bars": flat(7640, 40, -0.5), "timeframe": "5m",
         "now": datetime(2026, 8, 12, 13, 0, tzinfo=ET).isoformat()},
        {"name": "missed", "record": fly(), "others": [], "bars": wave, "timeframe": "5m", "now": now.isoformat()},
        {"name": "estimated", "record": fly(fill=None), "others": [], "bars": flat(7640, 80, -0.5), "timeframe": "5m", "now": now.isoformat()},
        {"name": "short_fly", "record": fly(action="SELL", fill=2.0), "others": [], "bars": flat(7640, 80, 1.0), "timeframe": "5m", "now": now.isoformat()},
        {"name": "call_fly_noisy", "record": fly(strikes=(7650, 7675, 7700), right="C", fill=3.2), "others": [], "bars": noisy, "timeframe": "5m", "now": now.isoformat()},
        {"name": "capped_window", "record": fly(), "others": [], "bars": flat(7640, 400, -0.1), "timeframe": "5m", "now": now.isoformat()},
        {"name": "err_not_fly", "record": {"id": "x", "contract": {"secType": "STK", "symbol": "AAPL"}}, "others": [], "bars": flat(1, 3), "timeframe": "5m", "now": now.isoformat()},
        {"name": "err_uncovered", "record": fly(), "others": [], "bars": flat(7600, 5), "timeframe": "5m", "now": now.isoformat()},
        {"name": "daily", "record": fly(), "others": [], "bars": daily_bars, "timeframe": "1d", "now": now.isoformat()},
    ]
    for c in cases:
        try:
            c["expect"] = tr.review(c["record"], c["others"], c["bars"],
                                    c["timeframe"], datetime.fromisoformat(c["now"]))
        except tr.ReviewError as exc:
            c["error"] = str(exc)
    profiles = [fly(), fly(fill=None), fly(action="SELL"), {"contract": {"secType": "STK"}}]
    bad = fly()
    bad["contract"]["legs"][1]["ratio"] = 1
    profiles.append(bad)
    whens = ["2026-08-12T14:36:10+00:00", "20260812 10:36:10", "2026-08-12 10:35", "2026-08-12", "garbage", ""]
    picks = ["2026-08-14T10:00:00-04:00", "2026-08-12T10:00:00-04:00", "2026-08-07T10:00:00-04:00",
             "2026-07-25T10:00:00-04:00", "2026-06-01T10:00:00-04:00"]
    fp = tr.butterfly_profile(fly())
    dump("tradereview", {
        "cases": cases,
        "profiles": [{"record": r, "expect": tr.butterfly_profile(r)} for r in profiles],
        "parse_when": [{"value": w, "expect": None if tr.parse_when(w) is None
                        else tr.parse_when(w).astimezone(timezone.utc).isoformat()} for w in whens],
        "pick_timeframe": [{"entry": e, "now": now.isoformat(),
                            "expect": tr.pick_timeframe(datetime.fromisoformat(e), now)} for e in picks],
        "payoff": [{"s": s, "expect": tr.payoff_per_unit(fp, s), "pnl": tr.pnl_at(fp, s)}
                   for s in (7500, 7600, 7605.5, 7615, 7620, 7630, 7700)],
    })


# ================================================================ broker 纯函数
def gen_broker():
    from ibkr_agent import broker, futu_broker
    from ibkr_agent.models import ParsedOrder

    # LegQuote.mid + combo_mid_price
    mid_cases = []
    for name, legs in [
        ("debit_call_spread", [("BUY", 1, 12.4, 12.8), ("SELL", 1, 5.1, 5.3)]),
        ("credit_condor", [("BUY", 1, 1.0, 1.2), ("SELL", 1, 3.0, 3.2),
                           ("SELL", 1, 2.8, 3.0), ("BUY", 1, 0.9, 1.1)]),
        ("butterfly", [("BUY", 1, 10.0, 10.4), ("SELL", 2, 6.0, 6.2), ("BUY", 1, 3.0, 3.2)]),
        ("bad_bid_zero", [("BUY", 1, 0.0, 5.0)]),
        ("bad_crossed", [("BUY", 1, 6.0, 5.0)]),
        ("bad_nan", [("BUY", 1, float("nan"), 5.0)]),
    ]:
        entry = {"name": name,
                 "legs": [[a, r, (None if b != b else b), (None if k != k else k)]
                          for a, r, b, k in legs]}
        try:
            entry["expect"] = broker.combo_mid_price(
                [broker.LegQuote(a, r, b, k) for a, r, b, k in legs]
            )
        except broker.BrokerError as exc:
            entry["error"] = str(exc)
        mid_cases.append(entry)

    # auto_mid_limit
    aml_cases = []
    for name, args in [
        ("debit_ok", (7.85, "BUY", 0.10, 30.0)),
        ("debit_capped_by_width", (29.98, "BUY", 0.10, 30.0)),
        ("credit_ok", (-12.6, "SELL", 0.10, None)),
        ("credit_eaten", (-0.05, "SELL", 0.10, None)),
        ("sell_positive_mid", (7.85, "SELL", 0.10, None)),
        ("buy_negative_mid", (-7.85, "BUY", 0.10, None)),
        ("negative_slippage", (7.85, "BUY", -0.1, None)),
        ("nan_mid", (float("nan"), "BUY", 0.1, None)),
        # 最小价格变动:结果必须落在 0.05 的整数倍上,否则 IBKR 110 当场退单
        # (2026-09-04 实测:0.125 + 0.05 = 0.1750 是 3.5 个 tick,被拒)
        ("tick_half_step", (0.125, "BUY", 0.05, 10.0)),
        ("tick_already_aligned", (0.15, "BUY", 0.05, 10.0)),
        ("tick_rounds_up", (2.32, "BUY", 0.01, 20.0)),
        ("tick_credit_rounds_toward_zero", (-12.34, "SELL", 0.05, None)),
        ("tick_credit_tiny_slippage", (-9.99, "SELL", 0.005, None)),
        ("tick_capped_width_stays_legal", (19.99, "BUY", 0.5, 20.0)),
    ]:
        entry = {"name": name, "args": [None if a != a else a for a in args[:1]] + list(args[1:])}
        entry["args"] = list(args)
        if isinstance(entry["args"][0], float) and entry["args"][0] != entry["args"][0]:
            entry["args"][0] = "nan"
        try:
            entry["expect"] = broker.auto_mid_limit(*args)
        except broker.BrokerError as exc:
            entry["error"] = str(exc)
        aml_cases.append(entry)

    # bag_signed_limit
    bsl = [
        {"action": "BUY", "limit": 7.9, "expect": broker.bag_signed_limit("BUY", 7.9)},
        {"action": "SELL", "limit": 12.0, "expect": broker.bag_signed_limit("SELL", 12.0)},
        {"action": "SELL", "limit": None, "expect": broker.bag_signed_limit("SELL", None)},
    ]

    # book_liquidity
    books = [
        {"name": "l2", "book": {"l1": {"spread_bps": 3.2, "bid_size": 5, "ask_size": 7},
                                 "bids": [{"size": 100}, {"size": 200}],
                                 "asks": [{"size": 50}, {"size": 60}, {"size": 40}]}},
        {"name": "l1_only", "book": {"l1": {"spread_bps": 25.0, "bid_size": 30, "ask_size": 10},
                                      "bids": [], "asks": []}},
        {"name": "wide", "book": {"l1": {"spread_bps": 80.0}, "bids": [], "asks": []}},
        {"name": "empty", "book": {"l1": {}, "bids": [], "asks": []}},
    ]
    for b in books:
        b["expect"] = broker.book_liquidity(b["book"])

    # strike_width / price_condition_spec / bar_timestamp
    sw_cases = []
    for name, payload in [
        ("vertical", spread_order()), ("butterfly", butterfly_order()), ("condor", condor_order()),
    ]:
        order = ParsedOrder.model_validate(payload)
        sw_cases.append({"name": name, "payload": payload,
                         "expect": broker.strike_width(order.contract)})
    trig = ParsedOrder.model_validate(spread_order()).trigger
    pcs = broker.price_condition_spec(trig)
    bt_cases = [
        {"raw": "20260819  09:35:00", "expect": broker.bar_timestamp("20260819  09:35:00")},
        {"raw": "20260819", "expect": broker.bar_timestamp("20260819")},
        {"raw": "2026-08-19 09:35:00", "expect": broker.bar_timestamp("2026-08-19 09:35:00")},
        {"raw": "garbage", "expect": broker.bar_timestamp("garbage")},
        # 交易所时区(SPX 在 Cboe → 美中)要换成美东;美东原样;没带时区当美东
        {"raw": "20260902 11:40:00 US/Central", "expect": broker.bar_timestamp("20260902 11:40:00 US/Central")},
        {"raw": "20260902 12:40:00 US/Eastern", "expect": broker.bar_timestamp("20260902 12:40:00 US/Eastern")},
        {"raw": "20260115 11:40:00 America/Chicago", "expect": broker.bar_timestamp("20260115 11:40:00 America/Chicago")},
        {"raw": "20260902 11:40:00", "expect": broker.bar_timestamp("20260902 11:40:00")},
    ]

    # implied_spot(put-call parity)
    import math as _math
    parity_cases = []
    spot_true, r, t = 7500.0, 0.04, 1.0 / 12.0
    disc = _math.exp(-r * t)
    pairs = []
    for k in range(7300, 7710, 25):
        cp = spot_true - k * disc
        put = max(5.0, 30.0 + (k - spot_true) * 0.4)
        call = cp + put
        if call <= 0:
            continue
        pairs.append([float(k), call, put])
    entry = {"name": "clean", "pairs": pairs,
             "expect": futu_broker.implied_spot([tuple(p) for p in pairs])}
    parity_cases.append(entry)
    dirty = [list(p) for p in pairs]
    dirty[3][1] += 80.0
    try:
        futu_broker.implied_spot([tuple(p) for p in dirty])
    except broker.BrokerError as exc:
        parity_cases.append({"name": "dirty", "pairs": dirty, "error": str(exc)})
    few = pairs[:3]
    try:
        futu_broker.implied_spot([tuple(p) for p in few])
    except broker.BrokerError as exc:
        parity_cases.append({"name": "few", "pairs": few, "error": str(exc)})
    flat = [[7500.0, 30.0, 25.0]] * 6
    try:
        futu_broker.implied_spot([tuple(p) for p in flat])
    except broker.BrokerError as exc:
        parity_cases.append({"name": "flat", "pairs": flat, "error": str(exc)})

    # futu 助手
    helpers = {
        "futu_date": [{"in": "20260814", "out": futu_broker._futu_date("20260814")},
                       {"in": "2026-08-14", "out": futu_broker._futu_date("2026-08-14")}],
        "plain_date": [{"in": "2026-08-14", "out": futu_broker._plain_date("2026-08-14")}],
        "bar_time": [
            {"in": ["2026-08-14 09:35:00", False], "out": futu_broker._bar_time("2026-08-14 09:35:00", False)},
            {"in": ["2026-08-14 09:35:00", True], "out": futu_broker._bar_time("2026-08-14 09:35:00", True)},
        ],
        "duration_days": [
            {"in": {"duration": "5 D"}, "out": futu_broker._duration_days({"duration": "5 D"})},
            {"in": {"duration": "1 Y"}, "out": futu_broker._duration_days({"duration": "1 Y"})},
            {"in": {"duration": "30 D"}, "out": futu_broker._duration_days({"duration": "30 D"})},
            {"in": {}, "out": futu_broker._duration_days({})},
        ],
        "iv": [
            {"in": 32.5, "out": futu_broker._iv({"option_implied_volatility": 32.5})},
            {"in": 0.32, "out": futu_broker._iv({"option_implied_volatility": 0.32})},
            {"in": None, "out": futu_broker._iv({})},
        ],
        "order_status_map": futu_broker._ORDER_STATUS,
        "open_status": list(futu_broker._OPEN_STATUS),
        "quote_error": [
            {"in": "没有权限:美股期权", "out": futu_broker._quote_error("没有权限:美股期权")},
            {"in": "no right to access", "out": futu_broker._quote_error("no right to access")},
            {"in": "历史K线额度不足", "out": futu_broker._quote_error("历史K线额度不足")},
            {"in": "别的错", "out": futu_broker._quote_error("别的错")},
        ],
        "bars_error": [
            {"in": "Error 162: no market data permissions",
             "out": broker._bars_error("SPX", "5 分钟", Exception("Error 162: no market data permissions"))},
            {"in": "boom", "out": broker._bars_error("AAPL", "日线", Exception("boom"))},
        ],
    }

    dump("broker", {
        "combo_mid": mid_cases, "auto_mid_limit": aml_cases, "bag_signed_limit": bsl,
        "combo_tick": broker.DEFAULT_COMBO_TICK,
        "align_tick": [{"value": v,
                        "up": broker.align_tick_up(v),
                        "down": broker.align_tick_down(v)}
                       for v in (0.0, 0.01, 0.05, 0.1, 0.125, 0.15, 0.1750, 0.2,
                                 2.25, 2.26, 12.34, 12.35, 19.99, 20.0, -0.05,
                                 -12.29, -12.34, -12.30)],
        "book_liquidity": books, "strike_width": sw_cases,
        "price_condition": {"trigger": spread_order()["trigger"], "expect": pcs},
        "bar_timestamp": bt_cases, "parity": parity_cases, "helpers": helpers,
    })

if __name__ == "__main__":
    _all()
