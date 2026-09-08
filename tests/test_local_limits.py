"""限额只在本地校验(提示词 v1.8.0)。

2026-09-07 的解析链路压测里,提示词第 6 条让模型自己按限额估算敞口并拒绝,29 条大模型路径里 4 条合规单被
模型算错拒掉(理由里自己写着"实际未超限,可执行")。定下来的原则:能本地校验的都不交给模型。这里三件事:
(1)v1.8.0 提示词与发给模型的 schema 都不再让模型管限额;(2)模型现在会原样交出来的那四条,校验层按压测同样的
紧限额放行;(3)真超限的(金额 / 张数 / 无参考价的市价单股数)校验层照拦,市价单有快照时按快照算金额。
黄金样例 validator.tight_* / notional_only_* 是同一组用例,TS 侧对拍。
"""
from __future__ import annotations

import json
import re
from typing import get_args

import pytest

from conftest import condor_order, make_settings, option_order, spread_order, stock_order
from ibkr_agent.models import ParsedOrder, RejectionCode, parse_llm_payload
from ibkr_agent.prompts import load_prompt_bundle, render_user
from ibkr_agent.schema import parse_schema_for_prompt
from ibkr_agent.validator import Validator

# 压测用的限额:5000 USD / 5 张 / 市价单 200 股
TIGHT = {"max_order_notional": 5_000.0, "max_option_contracts": 5, "max_mkt_shares": 200}
SNAPSHOT = {"SPX": 7462.35, "AAPL": 229.4, "NVDA": 181.2}
INSTRUCTION = "买入 AAPL 100股 limit 230"


def run(payload, now, limits=TIGHT):
    order = ParsedOrder.model_validate(payload)
    return Validator(make_settings(limits=limits), now, SNAPSHOT, []).validate_one(order)


def codes(issues):
    return [i.code for i in issues]


def prompt_code_table(system_text):
    """rejections 结构里那行 "code": "A" | "B" … 才是模型照着抄的代码表。"""
    lines = [l for l in system_text.splitlines() if l.lstrip().startswith('"code":')]
    assert len(lines) == 1, lines
    return set(re.findall(r'"([A-Z_]+)"', lines[0].split(":", 1)[1]))


def sent_codes(version):
    return parse_schema_for_prompt(version)["$defs"]["Rejection"]["properties"]["code"]["enum"]


# ---- 提示词与 schema:限额、合约存在性不归模型 ------------------------------
def test_v180_prompt_no_longer_asks_model_to_enforce_limits(settings):
    bundle = load_prompt_bundle(settings)
    assert bundle.version == "v1.8.0"
    assert "限额不归你判断" in bundle.system_text
    assert prompt_code_table(bundle.system_text) == set(get_args(RejectionCode)) - {"EXCEEDS_LIMIT"}
    for pair in bundle.fewshot:
        assert "生效限额" not in pair.user
        assert "最大亏损" not in json.dumps(pair.assistant, ensure_ascii=False)  # 模型不再自己算敞口


def test_v180_prompt_is_invariant_to_limits(settings, now):
    """限额不进提示词:换一套限额,系统提示词与用户消息逐字节不变;v1.7.0 则随限额变。"""
    other = make_settings(limits={"max_order_notional": 12_345.0, "max_option_contracts": 7, "max_mkt_shares": 33})
    a, b = load_prompt_bundle(settings), load_prompt_bundle(other)
    assert a.system_text == b.system_text
    assert render_user(a, settings, INSTRUCTION, now) == render_user(b, other, INSTRUCTION, now)
    assert "生效限额" not in render_user(a, settings, INSTRUCTION, now)

    legacy = load_prompt_bundle(make_settings(prompt_version="v1.7.0"))
    legacy_other = load_prompt_bundle(make_settings(prompt_version="v1.7.0", limits={"max_order_notional": 12_345.0}))
    assert legacy.system_text != legacy_other.system_text
    assert prompt_code_table(legacy.system_text) == set(get_args(RejectionCode))


def test_schema_sent_to_model_follows_the_prompt_version():
    """发给模型的 enum 也不再列 EXCEEDS_LIMIT(json_object 降级时它会被写进系统提示词);老版本照旧。"""
    assert set(sent_codes("v1.8.0")) == set(get_args(RejectionCode)) - {"EXCEEDS_LIMIT"}
    assert "EXCEEDS_LIMIT" in sent_codes("v1.7.0")
    assert "EXCEEDS_LIMIT" in sent_codes("v1.0.0")


def test_model_side_exceeds_limit_still_parses_as_a_rejection():
    """模型不听话仍输出 EXCEEDS_LIMIT 时不炸:按模型侧拒绝原样透传(已知行为,界面上 source=llm 可见)。"""
    parsed = parse_llm_payload({"orders": [], "rejections": [
        {"original_text": "x", "code": "EXCEEDS_LIMIT", "message": "模型自己算的"}]})
    assert [r.code for r in parsed.rejections] == ["EXCEEDS_LIMIT"]


# ---- 校验层:模型误拒的四条放行,合并语义与快照口径 -----------------------------
def spy_put():
    return option_order(
        intent_summary="限价 3 买入 1 张 SPY 20260814 560 Put",
        contract={"symbol": "SPY", "strike": 560.0, "right": "P", "lastTradeDateOrContractMonth": "20260814"},
        order={"totalQuantity": 1, "lmtPrice": 3.0})


def condor_4800():
    """铁鹰:SPX 今天 7300/7350/7700/7750,收 2 块 → (50 − 2) × 100 = 4800。"""
    legs = [(7300.0, "P", "BUY"), (7350.0, "P", "SELL"), (7700.0, "C", "SELL"), (7750.0, "C", "BUY")]
    return condor_order(
        intent_summary="卖出 1 张 SPX 今天 7300/7350/7700/7750 铁鹰,收权利金不低于 2",
        contract={"legs": [
            {"action": action, "ratio": 1, "lastTradeDateOrContractMonth": "20260814",
             "strike": strike, "right": right, "tradingClass": "SPXW"}
            for strike, right, action in legs
        ]},
        order={"totalQuantity": 1, "lmtPrice": 2.0, "tif": "DAY"},
    )


def mkt(quantity, **contract):
    return stock_order(contract=contract, order={"orderType": "MKT", "lmtPrice": None, "totalQuantity": quantity})


@pytest.mark.parametrize("name,payload,limits,notional", [
    ("买2张英伟达周五180call 限价5.5 → 2 × 100 × 5.5", option_order(), TIGHT, 1_100.0),
    ("买 1 张 SPY 本周五 560 put,权利金不超过 3 → 1 × 100 × 3", spy_put(), TIGHT, 300.0),
    ("铁鹰:SPX 今天 7300/7350/7700/7750,收 2 块 → (50 − 2) × 100", condor_4800(), TIGHT, 4_800.0),
    ("spx到7500时,开一张今天的 7520 7550 call spread → 宽度 30 × 100", spread_order(), TIGHT, 3_000.0),
    ("市价买 20 股 AAPL,快照 229.4 → 20 × 229.4", mkt(20), TIGHT, 4_588.0),
    ("6 张 NVDA call @0.5,只收紧金额上限 → 张数上限回落到基准 10,不是引擎默认 5",
     option_order(order={"totalQuantity": 6, "lmtPrice": 0.5}), {"max_order_notional": 5_000.0}, 300.0),
])
def test_orders_the_model_wrongly_rejected_pass_local_limits(now, name, payload, limits, notional):
    issues, approved = run(payload, now, limits)
    assert codes(issues) == [], name
    assert approved is not None and approved.notional == pytest.approx(notional)


@pytest.mark.parametrize("name,payload,message_part", [
    ("买入 AAPL 100股 limit 230 → 23000 USD", stock_order(), "23000.00 USD"),
    ("买 1000 股 MSFT 市价 → 无参考价,按股数拦", mkt(1000, symbol="MSFT"), "超过市价单上限 200 股"),
    ("市价买 100 股 AAPL,快照 229.4 → 按快照算 22940 USD,不是按股数", mkt(100), "22940.00 USD"),
    ("市价买 300 股 AAPL,快照 229.4 → 68820 USD;200 股上限只在无参考价时生效", mkt(300), "68820.00 USD"),
    ("卖出 2 张铁鹰 7200/7250/7650/7700 收 12 → 2 × (50 − 12) × 100 = 7600 USD", condor_order(), "7600.00 USD"),
    ("6 张 NVDA call @0.5 → 敞口 300 不超,张数 6 > 5", option_order(order={"totalQuantity": 6, "lmtPrice": 0.5}),
     "6 张,超过上限 5 张"),
])
def test_truly_over_limit_orders_are_still_caught_locally(now, name, payload, message_part):
    issues, approved = run(payload, now)
    assert "EXCEEDS_LIMIT" in codes(issues), name
    assert approved is None
    assert any(message_part in i.message for i in issues), (name, [i.message for i in issues])
