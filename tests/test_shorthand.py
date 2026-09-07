"""本地速记解析:固定蝴蝶行话跳过大模型,微秒级出单。

这条路径**绕过了大模型**直接构单,所以红线只有一条:绝不猜。测试盯两头:

  * 命中:语义与用户逐条确认的行话严格一致(百位+N 的中心、十位个位定方向、
    cm=翼宽、孤立数字=权利金、挂=当日限价),payload 与 LLM 同形、过 schema;
  * 回落:任何多余成分、任何拿不准的数字、任何缺现价的场景 → None,
    交给大模型——半懂不懂地本地下单,比慢一秒危险一万倍。
"""
from __future__ import annotations

from datetime import datetime

import pytest

from conftest import ET, make_settings
from ibkr_agent.models import parse_llm_payload
from ibkr_agent.shorthand import LOCAL_MODEL, try_parse_shorthand


FRIDAY = datetime(2026, 8, 14, 10, 32, tzinfo=ET)


def parse(text, snapshot=None, moment=FRIDAY):
    return try_parse_shorthand(text, snapshot or {}, moment)


def only_order(payload):
    assert payload is not None
    assert payload["rejections"] == []
    assert len(payload["orders"]) == 1
    return payload["orders"][0]


# ======================================================================
# 命中:用户的原话
# ======================================================================
def test_headline_shorthand_call_side():
    # SPX 6907.35:十位个位 7.35 < 15 → 中心 6915 在上方 → 看涨
    order = only_order(parse("1.8 挂15蝴蝶 15CM", {"SPX": 6907.35}))
    contract = order["contract"]
    assert contract["symbol"] == "SPX"
    assert contract["combo_strategy"] == "BUTTERFLY"
    assert [l["strike"] for l in contract["legs"]] == [6900.0, 6915.0, 6930.0]
    assert [l["action"] for l in contract["legs"]] == ["BUY", "SELL", "BUY"]
    assert [l["ratio"] for l in contract["legs"]] == [1, 2, 1]
    assert {l["right"] for l in contract["legs"]} == {"C"}
    assert {l["tradingClass"] for l in contract["legs"]} == {"SPXW"}
    assert {l["lastTradeDateOrContractMonth"] for l in contract["legs"]} == {"20260814"}
    assert order["order"] == {
        "action": "BUY", "orderType": "LMT", "totalQuantity": 1,
        "price_mode": "EXPLICIT", "lmtPrice": 1.8, "tif": "DAY", "outsideRth": False,
    }
    assert "中心 6915 高于现价 6907.35,推断为看涨蝴蝶" in order["warnings"]
    assert any("默认 1 张" in w for w in order["warnings"])
    assert any("默认当日到期" in w for w in order["warnings"])


def test_headline_shorthand_put_side():
    # SPX 6992.1:十位个位 92.1 > 15 → 中心 6915 在下方 → 看跌
    order = only_order(parse("1.8 挂15蝴蝶 15CM", {"SPX": 6992.1}))
    assert {l["right"] for l in order["contract"]["legs"]} == {"P"}
    assert [l["strike"] for l in order["contract"]["legs"]] == [6900.0, 6915.0, 6930.0]
    assert "中心 6915 低于现价 6992.1,推断为看跌蝴蝶" in order["warnings"]


def test_absolute_center_with_premium():
    order = only_order(parse("7520的20cm蝴蝶 2.5", {"SPX": 7462.35}))
    assert [l["strike"] for l in order["contract"]["legs"]] == [7500.0, 7520.0, 7540.0]
    assert {l["right"] for l in order["contract"]["legs"]} == {"C"}
    assert order["order"]["lmtPrice"] == 2.5


def test_explicit_put_without_premium_uses_auto_mid():
    order = only_order(parse("7520的20cm看跌蝴蝶", {"SPX": 7462.35}))
    assert {l["right"] for l in order["contract"]["legs"]} == {"P"}  # 明说压过推断
    assert order["order"]["price_mode"] == "AUTO_MID"
    assert order["order"]["lmtPrice"] is None
    assert any("AUTO_MID" in w for w in order["warnings"])


def test_quantity_and_ticker_tokens():
    order = only_order(parse("3张 7520的20cm蝴蝶 2.5", {"SPX": 7462.35}))
    assert order["order"]["totalQuantity"] == 3
    assert not any("默认 1 张" in w for w in order["warnings"])

    order = only_order(parse("ndx 21020的30cm蝴蝶 5", {"NDX": 20988.0}))
    assert order["contract"]["symbol"] == "NDX"
    assert "tradingClass" not in order["contract"]["legs"][0]  # SPXW 只属于 SPX


def test_payload_passes_the_llm_schema():
    payload = parse("1.8 挂15蝴蝶 15CM", {"SPX": 6907.35})
    parsed = parse_llm_payload(payload)
    assert len(parsed.orders) == 1 and not parsed.schema_errors
    assert parsed.orders[0].contract.combo_strategy == "BUTTERFLY"


# ======================================================================
# 回落:任何拿不准都交给大模型
# ======================================================================
@pytest.mark.parametrize("text", [
    "spx涨到7500时 7520的20cm蝴蝶",        # 触发条件:本地不接
    "卖出7520的20cm蝴蝶 2.5",              # 卖蝴蝶:让大模型按 UNSUPPORTED 拒
    "1.8 挂15蝴蝶",                        # 没有翼宽
    "1.8 2.5 挂15蝴蝶 15CM",               # 两个孤立数字:哪个是权利金说不清
    "20 挂15蝴蝶 15CM",                    # 权利金 ≥ 翼宽:必然读错了数
    "买入 AAPL 100股 limit 230",           # 不是蝴蝶
    "2000的15蝴蝶 15CM",                   # 两种中心写法同时出现
    "1.8 挂15蝴蝶 15CM 顺便提醒我喝水",     # 有消费不掉的成分
])
def test_falls_back_to_llm(text):
    assert parse(text, {"SPX": 6907.35}) is None


def test_tail_center_without_spot_falls_back():
    assert parse("1.8 挂15蝴蝶 15CM", {}) is None


@pytest.mark.parametrize("text,reason", [
    ("7520的20cm蝴蝶 3.3,理由:突破回踩", "突破回踩"),
    ("1.8 挂15蝴蝶 15CM 理由:开盘冲高回落", "开盘冲高回落"),
    ("7520的20cm蝴蝶 3.3 理由 涨得太急", "涨得太急"),
])
def test_reason_suffix_is_kept_locally(text, reason):
    """v3:尾巴上的理由本地接住,原文进 reason;理由里的词(突破)不触发回落。"""
    payload = parse(text, {"SPX": 7462.35} if "7520" in text else {"SPX": 7745.2})
    assert payload is not None, text
    order = payload["orders"][0]
    assert order["reason"] == reason
    assert order["order"]["lmtPrice"] in (3.3, 1.8)
    assert "shorthand-v3" in order["warnings"][-1]


def test_weekend_rejects_locally():
    """周末不回落大模型:本地直接拒(毫秒级),而不是让大模型花 4 秒说"不是交易日"。"""
    saturday = datetime(2026, 8, 15, 10, 32, tzinfo=ET)
    out = parse("1.8 挂15蝴蝶 15CM", {"SPX": 6907.35}, saturday)
    assert out["orders"] == []
    assert out["rejections"][0]["code"] == "UNSUPPORTED"
    assert "周六" in out["rejections"][0]["message"]
    assert out["rejections"][0]["original_text"] == "1.8 挂15蝴蝶 15CM"


# ======================================================================
# 引擎集成:命中时完全不碰大模型
# ======================================================================
def test_engine_uses_local_parse_and_skips_llm(tmp_path):
    from test_engine import FakeParser, build_engine

    settings = make_settings(storage={"db_path": str(tmp_path / "sh.db")})
    engine = build_engine(settings, {"orders": [], "rejections": []})
    result = engine.handle_instruction(
        "1.8 挂15蝴蝶 15CM", moment=FRIDAY, snapshot={"SPX": 6907.35},
    )
    assert engine.parser.calls == []            # 大模型一次都没被调
    assert result.llm["model"] == LOCAL_MODEL
    assert result.llm["latency_ms"] == 0
    assert len(result.validated_only) == 1      # auto_execute=false → 只校验不发
    assert "6900/6915/6930" in result.validated_only[0]["intent_summary"]


def test_engine_falls_back_to_llm_when_not_shorthand(tmp_path):
    from conftest import stock_order
    from test_engine import build_engine

    settings = make_settings(storage={"db_path": str(tmp_path / "sh2.db")})
    engine = build_engine(settings, {"orders": [stock_order()], "rejections": []})
    result = engine.handle_instruction("买入 AAPL 100股 limit 230", moment=FRIDAY)
    assert len(engine.parser.calls) == 1        # 走的还是大模型
    assert result.llm["model"] == "claude-opus-5"


# ======================================================================
# 变体矩阵:每一种"用户可能这么写"的形态都钉死命中;每一种说不清的都钉死回落
# ======================================================================
SNAP = {"SPX": 6907.35, "NDX": 20988.0, "AAPL": 232.4}

HIT_VARIANTS = [
    "1.8挂15蝴蝶15CM",              # 紧凑无空格
    "1.8 挂 15 蝴蝶 15 cm",         # 松散空格
    "15CM 挂15蝴蝶 1.8",            # 任意语序
    "1.8 15蝴蝶 15cm",              # 不写「挂」
    "1.8 挂15蝴蝶 15cm,",           # 全角数字/标点(NFKC 归一)
    "7520 20cm蝴蝶 2.5",             # 中心不带「的」
    "spx7400来个25cm蝴蝶 3.3",       # 紧贴 ticker + 口语「来个」
    "7515蝴蝶 15cm 1.8",             # 4 位数直接贴蝴蝶 = 绝对中心
    "两张 7520的20cm蝴蝶 2.5",       # 中文数量词
    "买一张 7520的20cm蝴蝶 2.5",
    "十张 7520的20cm蝴蝶 2.5",
    "7520的20cm蝴蝶 权利金不超过2",  # 权利金完整说法
    "7520的20cm蝴蝶,权利金上限2.5",
    "7520的蝴蝶 翼宽20 2.5",         # 翼宽的其他写法
    "7520的蝴蝶 ±20点 2.5",
    "帮我挂 7520的20cm蝴蝶 2.5",     # 礼貌语前缀
    "开一张7520的20cm蝴蝶 2.5",
    "买2张7515蝴蝶15cm 1.8",
    "0DTE 7520的20cm蝴蝶 2.5",
    "12.5cm 6915的蝴蝶 1.8",         # 小数翼宽
]

MISS_VARIANTS = [
    "7400 7500 20cm蝴蝶 2.5",        # 两个行权价量级的数:说不清哪个是中心
    "230的5cm蝴蝶 看涨 1.2",         # 中心与 SPX 现价偏离 >20%:多半写漏了标的
    "230的5cm蝴蝶 1.2",
    "7520的20cm蝴蝶 3.3 理由",           # 「理由」后面是空的:说不清,交给大模型
]


@pytest.mark.parametrize("text", HIT_VARIANTS)
def test_variant_hits_locally(text):
    payload = parse(text, SNAP)
    assert payload is not None, text
    parsed = parse_llm_payload(payload)
    assert len(parsed.orders) == 1 and not parsed.schema_errors


@pytest.mark.parametrize("text", MISS_VARIANTS)
def test_variant_falls_back(text):
    assert parse(text, SNAP) is None


def test_variant_semantics_spotchecks():
    o = only_order(parse("两张 7520的20cm蝴蝶 2.5", SNAP))
    assert o["order"]["totalQuantity"] == 2
    o = only_order(parse("买一张 7520的20cm蝴蝶 2.5", SNAP))
    assert o["order"]["totalQuantity"] == 1
    assert not any("默认 1 张" in w for w in o["warnings"])  # 一张是明说的,不是默认
    o = only_order(parse("7520的20cm蝴蝶 权利金不超过2", SNAP))
    assert o["order"]["lmtPrice"] == 2.0
    o = only_order(parse("spx7400来个25cm蝴蝶 3.3", SNAP))
    assert [l["strike"] for l in o["contract"]["legs"]] == [7375.0, 7400.0, 7425.0]
    assert {l["right"] for l in o["contract"]["legs"]} == {"C"}
    o = only_order(parse("12.5cm 6915的蝴蝶 1.8", SNAP))
    assert [l["strike"] for l in o["contract"]["legs"]] == [6902.5, 6915.0, 6927.5]


# ======================================================================
# 真实群聊语料(用户提供):完整单条命中;信息残缺/含糊的单条必须回落
# ======================================================================
CORPUS_SNAP = {"SPX": 7745.2}

CORPUS_HITS = [
    "尝试下 1.8 挂15蝴蝶 15CM",              # 用户实际用法(带「尝试下」)
    "开个明天的7830蝴蝶吧 30CM的 5块钱",      # 明日到期 + 「块钱」权利金 + 语气词
    "看看7700蝴蝶 25CM 5块钱能不能挂进去",
    "试下7680蝴蝶 15CM 2块钱能不能进去",
    "挂个45蝴蝶彩票吧 20CM的 3块钱",          # 尾数中心 + 彩票 + 挂个
    "挂个45蝴蝶哦 15cm 看看1.5 彩票哦",
    "7720蝴蝶 30CM 尝试下4.4",
    "spx明天 7850 40cm 2.3",                  # 不写「蝴蝶」:cm 行话即蝴蝶(用户确认)
    "7850 40cm 2.3",
]

CORPUS_MISSES = [
    "00蝴蝶 看看4.4 有没有机会接",            # 翼宽写在下一条消息里:单条信息不全
    "尝试下7730蝴蝶 4.4能不能接到",
    "7720蝴蝶 30CM 尝试下4.4 y",             # 杂散单字母:不当 ticker
    "彩票考虑下135蝴蝶 或者135日历吧",        # 三位数个股行权价 + 日历:交给大模型
    "去抽个310蝴蝶吧 20CM",
    "1.8 挂15 15cm",                          # 尾数中心必须锚在「蝴蝶」上:15 太含糊
    "40cm 2.3",                               # 只有翼宽和权利金,没有中心
    "怕迈威尔爆炸的考虑 220 15cm蝴蝶",
    "@everyone 7720蝴蝶 30CM 尝试下4.4",     # 群聊原样转发
]


@pytest.mark.parametrize("text", CORPUS_HITS)
def test_corpus_hits_locally(text):
    payload = parse(text, CORPUS_SNAP)
    assert payload is not None, text
    parsed = parse_llm_payload(payload)
    assert len(parsed.orders) == 1 and not parsed.schema_errors


@pytest.mark.parametrize("text", CORPUS_MISSES)
def test_corpus_falls_back(text):
    assert parse(text, CORPUS_SNAP) is None


def test_corpus_semantics_spotchecks():
    # 「明天的」= 下一交易日:周五 → 下周一,合约与文案都要对
    o = only_order(parse("开个明天的7830蝴蝶吧 30CM的 5块钱", CORPUS_SNAP))
    assert {l["lastTradeDateOrContractMonth"] for l in o["contract"]["legs"]} == {"20260817"}
    assert "2026-08-17 到期" in o["intent_summary"]
    assert o["order"]["lmtPrice"] == 5.0
    # 「45蝴蝶」在 7745.2:中心 7745 低于现价 → 看跌
    o = only_order(parse("挂个45蝴蝶彩票吧 20CM的 3块钱", CORPUS_SNAP))
    assert [l["strike"] for l in o["contract"]["legs"]] == [7725.0, 7745.0, 7765.0]
    assert {l["right"] for l in o["contract"]["legs"]} == {"P"}
    # 「00蝴蝶」= 百位+0
    o = only_order(parse("00蝴蝶 看看4.4 25cm", CORPUS_SNAP))
    assert [l["strike"] for l in o["contract"]["legs"]] == [7675.0, 7700.0, 7725.0]
    # 不写「蝴蝶」的 cm 行话:结构照旧是 1:-2:1 蝴蝶,带专属 warning
    o = only_order(parse("spx明天 7850 40cm 2.3", CORPUS_SNAP))
    assert o["contract"]["combo_strategy"] == "BUTTERFLY"
    assert [l["strike"] for l in o["contract"]["legs"]] == [7810.0, 7850.0, 7890.0]
    assert {l["lastTradeDateOrContractMonth"] for l in o["contract"]["legs"]} == {"20260817"}
    assert o["order"]["lmtPrice"] == 2.3
    assert "未写「蝴蝶」,按 cm 行话默认为蝴蝶组合" in o["warnings"]


# ======================================================================
# 没连券商也要秒解:公开源现价兜底(用户实测暴露的缺口)
# ======================================================================
def test_engine_uses_public_spot_when_disconnected(tmp_path):
    from test_engine import build_engine

    settings = make_settings(storage={"db_path": str(tmp_path / "sh3.db")})
    engine = build_engine(settings, {"orders": [], "rejections": []})   # router=None
    engine.public_price_fn = lambda sym: 6907.35 if sym == "SPX" else None

    result = engine.handle_instruction("1.8 挂15蝴蝶 15CM", moment=FRIDAY)
    assert engine.parser.calls == []                 # 依旧没碰大模型
    assert result.llm["model"] == LOCAL_MODEL
    order = result.validated_only[0]
    assert "6900/6915/6930" in order["intent_summary"]
    # 公开源兜底必须留痕:延迟数据算出的中心要让用户当场核对
    record = engine.store.get_record(order["record_id"])
    assert any("公开数据源" in w for w in record["llm"]["warnings"])


def test_engine_falls_back_when_public_spot_unavailable(tmp_path):
    from test_engine import build_engine

    settings = make_settings(storage={"db_path": str(tmp_path / "sh4.db")})
    engine = build_engine(settings, {"orders": [], "rejections": []})
    engine.public_price_fn = lambda sym: None        # 公开源也取不到

    engine.handle_instruction("1.8 挂15蝴蝶 15CM", moment=FRIDAY)
    assert len(engine.parser.calls) == 1             # 老实回落大模型


def test_cboe_payload_parsing():
    from ibkr_agent.macro import cboe_last

    assert cboe_last({"data": {"current_price": 7656.7402}}) == 7656.7402
    assert cboe_last({"data": {"current_price": None, "close": 7650.0}}) == 7650.0
    assert cboe_last({"data": {}}) is None
    assert cboe_last({}) is None
