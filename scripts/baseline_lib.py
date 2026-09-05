"""回测/校验基线的共享计算逻辑。

make_baseline.py 与 verify_baseline.py 都从这里取"重算一遍"的函数,保证两边
跑的是同一段代码。基线覆盖三块确定性的资金路径数学:

  * backtest.run_backtest —— 全部 5 类策略 + 期权模拟(bar 数据来自固定 fixture 文件)
  * validator.Validator   —— 5 类订单 fixture + 拒绝路径,冻结时钟 2026-08-14 10:32 ET
  * tracker               —— 持仓盈亏 / 止盈止损 / 平仓单构造

约束:本模块不允许出现 random、时钟读取、网络与任何券商连接。
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

from ibkr_agent import backtest as bt  # noqa: E402
from ibkr_agent import tracker as tk  # noqa: E402
from ibkr_agent.config import ET  # noqa: E402
from ibkr_agent.models import parse_llm_payload  # noqa: E402
from ibkr_agent.validator import Validator  # noqa: E402

import conftest  # noqa: E402  # tests/conftest.py:订单 fixture 与配置工厂

BARS_FIXTURE = ROOT / "baseline" / "bars_fixture.json"
BASELINE_FILE = ROOT / "baseline" / "run_0.json"

#: 与 tests/conftest.py 的 now fixture 一致:2026-08-14(周五)10:32 美东,盘中。
FROZEN_NOW = datetime(2026, 8, 14, 10, 32, tzinfo=ET)


# ---------------------------------------------------------------- bar 数据
def generate_fixture_bars() -> List[Dict[str, Any]]:
    """生成一次性写入 fixture 文件的合成日线(仅 make_baseline 调用)。

    纯确定性公式:趋势 + 两个周期分量 + sin 哈希伪噪声,跳过周末,520 根。
    生成后落盘,之后一切计算都以文件为准——文件才是"固定的历史数据"。
    """
    import math
    from datetime import date, timedelta

    bars: List[Dict[str, Any]] = []
    day = date(2020, 1, 2)
    i = 0
    while len(bars) < 520:
        if day.weekday() < 5:
            noise = math.sin(i * 12.9898) * 43758.5453
            noise = (noise - math.floor(noise)) * 2.0 - 1.0
            close = 100.0 * math.exp(
                0.0006 * i + 0.08 * math.sin(i / 37.0) + 0.05 * math.sin(i / 11.0 + 1.7)
                + 0.01 * noise
            )
            spread = abs(math.sin(i * 78.233)) * 0.02 + 0.002
            open_ = close * (1.0 + 0.5 * spread * math.sin(i * 3.7))
            high = max(open_, close) * (1.0 + spread)
            low = min(open_, close) * (1.0 - spread)
            bars.append({
                "date": day.isoformat(),
                "open": round(open_, 4),
                "high": round(high, 4),
                "low": round(low, 4),
                "close": round(close, 4),
            })
            i += 1
        day += timedelta(days=1)
    return bars


def load_bars() -> List[bt.Bar]:
    if not BARS_FIXTURE.exists():
        raise SystemExit("缺少 %s,先运行 scripts/make_baseline.py" % BARS_FIXTURE)
    raw = json.loads(BARS_FIXTURE.read_text(encoding="utf-8"))
    return [bt.Bar(**row) for row in raw]


# ---------------------------------------------------------------- 回测场景
#: (名字, strategy, params, rules, instrument)。覆盖全部策略、全部自定义指标
#: 与比较符的主要分支、以及期权模拟的 4 类结构。
BACKTEST_SCENARIOS: List[Dict[str, Any]] = [
    {"name": "buy_hold", "strategy": "buy_hold"},
    {"name": "sma_cross_default", "strategy": "sma_cross"},
    {"name": "sma_cross_5_20", "strategy": "sma_cross", "params": {"fast": 5, "slow": 20}},
    {"name": "rsi_default", "strategy": "rsi"},
    {"name": "breakout_default", "strategy": "breakout"},
    {
        "name": "custom_sma_cross",
        "strategy": "custom",
        "rules": {
            "entry": [{"left": {"kind": "indicator", "name": "close"}, "op": "cross_up",
                       "right": {"kind": "indicator", "name": "sma", "period": 20}}],
            "exit": [{"left": {"kind": "indicator", "name": "close"}, "op": "cross_down",
                      "right": {"kind": "indicator", "name": "sma", "period": 20}}],
        },
    },
    {
        "name": "custom_multi",
        "strategy": "custom",
        "rules": {
            "entry": [
                {"left": {"kind": "indicator", "name": "rsi", "period": 14}, "op": "<",
                 "right": {"kind": "const", "value": 45}},
                {"left": {"kind": "indicator", "name": "change_pct", "period": 5}, "op": "<",
                 "right": {"kind": "const", "value": 0}},
                {"left": {"kind": "indicator", "name": "macd_hist"}, "op": "<",
                 "right": {"kind": "const", "value": 0}},
            ],
            "exit": [{"left": {"kind": "indicator", "name": "ema", "period": 10}, "op": "cross_down",
                      "right": {"kind": "indicator", "name": "sma", "period": 30}}],
        },
    },
    {
        "name": "custom_donchian",
        "strategy": "custom",
        "rules": {
            "entry": [{"left": {"kind": "indicator", "name": "close"}, "op": ">",
                       "right": {"kind": "indicator", "name": "highest", "period": 20}}],
            "exit": [{"left": {"kind": "indicator", "name": "close"}, "op": "<",
                      "right": {"kind": "indicator", "name": "lowest", "period": 10}}],
        },
    },
    {"name": "opt_call_sma", "strategy": "sma_cross",
     "instrument": {"type": "call", "dte": 30, "risk_pct": 10}},
    {"name": "opt_call_spread_hold", "strategy": "buy_hold",
     "instrument": {"type": "call_spread", "dte": 30, "width_pct": 2.0}},
    {"name": "opt_put_spread_rsi", "strategy": "rsi",
     "instrument": {"type": "put_spread", "dte": 45, "offset_pct": -1.0, "width_pct": 3.0,
                    "risk_pct": 15}},
    {"name": "opt_butterfly_breakout", "strategy": "breakout",
     "instrument": {"type": "butterfly", "dte": 21, "width_pct": 2.5}},
]


def compute_backtests(bars: List[bt.Bar]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for sc in BACKTEST_SCENARIOS:
        out[sc["name"]] = bt.run_backtest(
            bars, sc["strategy"],
            params=sc.get("params"), rules=sc.get("rules"), instrument=sc.get("instrument"),
        )
    return out


# ---------------------------------------------------------------- validator
#: 现价快照:SPX 在 7500 触发价下方(方向正确、gap 远超 5bps),个股给到位。
SNAPSHOT = {"SPX": 7450.0, "AAPL": 231.0, "NVDA": 178.0}


def _validator_payloads() -> Dict[str, Dict[str, Any]]:
    return {
        "stock": conftest.stock_order(),
        "spread": conftest.spread_order(),
        "butterfly": conftest.butterfly_order(),
        "condor": conftest.condor_order(),
        "option": conftest.option_order(),
        "low_confidence": conftest.stock_order(confidence=0.5),
        "oversize_notional": conftest.stock_order(order={"totalQuantity": 10_000}),
    }


def compute_validator() -> Dict[str, Any]:
    settings = conftest.make_settings()
    out: Dict[str, Any] = {}
    payloads = _validator_payloads()

    for name, payload in payloads.items():
        parsed = parse_llm_payload({"orders": [payload], "rejections": []})
        validator = Validator(settings, FROZEN_NOW, snapshot=SNAPSHOT, recent_orders=[])
        outcome = validator.validate_all(parsed.orders)
        out[name] = {
            "parse_schema_errors": list(parsed.schema_errors),
            "parse_rejections": [r.model_dump(mode="json") for r in parsed.rejections],
            "approved": [
                {
                    "signature": a.signature,
                    "account_id": a.account_id,
                    "notional": a.notional,
                    "warnings": list(a.warnings),
                    "order": a.order.model_dump(mode="json"),
                }
                for a in outcome.approved
            ],
            "rejected": [
                {"codes": [i.code for i in r.issues], "message": r.message()}
                for r in outcome.rejected
            ],
        }

    # 批量路径:6 笔进,第 6 笔要被单次上限(5)拦下
    batch = [payloads[k] for k in ("stock", "spread", "butterfly", "condor", "option",
                                   "low_confidence")]
    parsed = parse_llm_payload({"orders": batch, "rejections": []})
    outcome = Validator(settings, FROZEN_NOW, snapshot=SNAPSHOT,
                        recent_orders=[]).validate_all(parsed.orders)
    out["batch_of_six"] = {
        "approved_signatures": [a.signature for a in outcome.approved],
        "rejected": [{"codes": [i.code for i in r.issues]} for r in outcome.rejected],
    }
    return out


# ---------------------------------------------------------------- tracker
_CONTRACT_STK = {"secType": "STK", "symbol": "AAPL", "exchange": "SMART", "currency": "USD"}


def compute_tracker() -> Dict[str, Any]:
    cases = {
        "long_stock": {
            "position": tk.Position("模拟", "AAPL", quantity=100, avg_cost=230.0),
            "targets": tk.Targets(take_profit=250.0, stop_loss=220.0, trail_pct=5.0),
            "prices": [230.0, 235.0, 245.0, 251.0, 240.0, 228.0, 219.0, None],
        },
        "short_stock": {
            "position": tk.Position("模拟", "XYZ", quantity=-50, avg_cost=100.0),
            "targets": tk.Targets(take_profit=90.0, stop_loss=110.0, trail_pct=3.0),
            "prices": [100.0, 96.0, 92.0, 89.0, 95.0, 104.0, 111.0],
        },
        "long_option": {
            "position": tk.Position("模拟", "NVDA", sec_type="OPT", quantity=2,
                                    avg_cost=550.0, multiplier=100.0),
            "targets": tk.Targets(take_profit=8.0, stop_loss=4.5),
            "prices": [5.5, 6.0, 7.5, 5.2, 4.4],
        },
        "trail_only": {
            "position": tk.Position("模拟", "TSLA", quantity=30, avg_cost=400.0),
            "targets": tk.Targets(trail_pct=4.0),
            "prices": [400.0, 420.0, 440.0, 425.0, 421.0],
        },
    }

    out: Dict[str, Any] = {}
    for name, case in cases.items():
        pos, targets = case["position"], case["targets"]
        steps: List[Dict[str, Any]] = []
        peak = None
        for price in case["prices"]:
            state = tk.evaluate(pos, targets, price, peak=peak)
            peak = state["peak"]
            steps.append(state)
        out[name] = {
            "cost_basis": tk.cost_basis(pos),
            "close_side": tk.close_side(pos),
            "steps": steps,
        }

    long_pos = cases["long_stock"]["position"]
    short_pos = cases["short_stock"]["position"]
    out["close_orders"] = {
        "long_mkt": tk.build_close_order(
            long_pos, tk.AutoClose(enabled=True, order_type="MKT"), 240.0,
            tk.STATE_TAKE_PROFIT, _CONTRACT_STK),
        "long_lmt": tk.build_close_order(
            long_pos, tk.AutoClose(enabled=True, order_type="LMT", slippage_pct=0.3), 240.0,
            tk.STATE_STOP_LOSS, _CONTRACT_STK),
        "short_lmt": tk.build_close_order(
            short_pos, tk.AutoClose(enabled=True, order_type="LMT", slippage_pct=0.5), 104.0,
            tk.STATE_STOP_LOSS, _CONTRACT_STK),
    }
    out["close_limit_prices"] = {
        "long_03": tk.close_limit_price(long_pos, 240.0, 0.3),
        "short_05": tk.close_limit_price(short_pos, 104.0, 0.5),
        "no_price": tk.close_limit_price(long_pos, None, 0.3),
    }
    out["close_blockers"] = {
        "all_clear": tk.close_blockers(
            auto=tk.AutoClose(enabled=True), position=long_pos, account_is_paper=True,
            auto_execute=True, allow_live_trading=False, breaker_engaged=False,
            market_status="盘中"),
        "everything_blocked": tk.close_blockers(
            auto=tk.AutoClose(enabled=False), position=tk.Position("模拟", "AAPL"),
            account_is_paper=False, auto_execute=False, allow_live_trading=False,
            breaker_engaged=True, market_status="已收盘", already_fired=True),
        "after_hours_allowed": tk.close_blockers(
            auto=tk.AutoClose(enabled=True), position=long_pos, account_is_paper=True,
            auto_execute=True, allow_live_trading=False, breaker_engaged=False,
            market_status="盘后", outside_rth=True),
    }
    return out


# ---------------------------------------------------------------- 汇总
def compute_baseline() -> Dict[str, Any]:
    """重算完整基线。所有输入都是固定的,输出必须逐字节可复现。"""
    result = {
        "backtest": compute_backtests(load_bars()),
        "validator": compute_validator(),
        "tracker": compute_tracker(),
    }
    # 经 JSON 往返归一化容器类型(tuple→list 等),与磁盘上的基线可直接深比较
    return json.loads(json.dumps(result, ensure_ascii=False))
