"""期权腿身份与组合识别(tracker.py)+ 追踪表迁移(store.py)。

一只蝴蝶三条腿都是同一个 symbol/secType:key 不带腿身份,聚合时互相覆盖,
界面只剩最后一条,追踪与自动平仓会认错腿——错了会平掉不该平的腿。
"""
from __future__ import annotations

import sqlite3

import pytest

from ibkr_agent import tracker as tk
from ibkr_agent.store import TradeStore


def leg(account, symbol, expiry, strike, right, qty, cost=100.0, mv=None, pnl=None):
    contract = {"secType": "OPT", "symbol": symbol, "lastTradeDateOrContractMonth": expiry,
                "strike": strike, "right": right, "multiplier": "100"}
    ident = tk.leg_of(contract)
    return {
        "key": tk.position_key(account, symbol, "OPT", ident), "account": account, "symbol": symbol,
        "sec_type": "OPT", "leg": ident, "label": tk.position_label(symbol, "OPT", contract),
        "quantity": qty, "avg_cost": cost, "multiplier": 100.0, "currency": "USD",
        "market_price": None, "market_value": mv, "unrealized_pnl": pnl, "contract": contract,
    }


def stock(account, symbol, qty):
    return {"key": tk.position_key(account, symbol, "STK"), "account": account, "symbol": symbol,
            "sec_type": "STK", "leg": "", "label": symbol, "quantity": qty, "avg_cost": 10.0,
            "multiplier": 1.0, "currency": "USD", "market_price": None, "market_value": None,
            "unrealized_pnl": None, "contract": {"secType": "STK", "symbol": symbol}}


# ---------------------------------------------------------------- 身份
def test_option_legs_get_distinct_keys_and_stock_keys_are_unchanged():
    a = leg("模拟", "SPX", "20260901", 7600.0, "P", 1)
    b = leg("模拟", "SPX", "20260901", 7615.0, "P", -2)
    assert a["key"] != b["key"]
    assert a["key"] == "模拟|SPX|OPT|20260901|7600|P"
    assert stock("模拟", "AAPL", 100)["key"] == "模拟|AAPL|STK"      # 老追踪记录照常匹配
    assert tk.leg_of({"secType": "STK", "symbol": "AAPL"}) == ""


def test_position_label_reads_like_a_ticket():
    c = {"secType": "OPT", "lastTradeDateOrContractMonth": "20260901", "strike": 7615.0, "right": "P"}
    assert tk.position_label("SPX", "OPT", c) == "SPX 7615P 2026-09-01"
    assert tk.position_label("AAPL", "STK", {}) == "AAPL"


def test_track_key_treats_legacy_rows_as_stock():
    assert tk.track_key({"account": "模拟", "symbol": "AAPL", "sec_type": "STK"}) == "模拟|AAPL|STK"
    assert tk.track_key({"account": "模拟", "symbol": "SPX", "sec_type": "OPT",
                         "leg": "20260901|7615|P"}) == "模拟|SPX|OPT|20260901|7615|P"


# ---------------------------------------------------------------- 组合识别
def test_butterfly_is_recognised_from_its_three_legs():
    rows = [
        leg("模拟", "SPX", "20260901", 7630.0, "P", 1, cost=50.0, mv=40.0, pnl=-10.0),
        leg("模拟", "SPX", "20260901", 7600.0, "P", 1, cost=30.0, mv=35.0, pnl=5.0),
        leg("模拟", "SPX", "20260901", 7615.0, "P", -2, cost=40.0, mv=-70.0, pnl=10.0),
        stock("模拟", "AAPL", 100),
    ]
    combos = tk.group_legs(rows)
    assert len(combos) == 1
    fly = combos[0]
    assert fly["kind"] == "butterfly" and fly["quantity"] == 1.0
    assert fly["label"] == "买入看跌蝴蝶 7600/7615/7630"
    assert fly["legs"] == [rows[1]["key"], rows[2]["key"], rows[0]["key"]]   # 按行权价排序
    assert fly["market_value"] == 5.0 and fly["unrealized_pnl"] == 5.0
    assert fly["net_cost"] == 30.0 + 50.0 - 80.0


def test_vertical_and_iron_condor_and_unknown_shapes():
    vertical = tk.group_legs([
        leg("模拟", "NVDA", "20260918", 180.0, "C", 2), leg("模拟", "NVDA", "20260918", 190.0, "C", -2),
    ])
    assert vertical[0]["kind"] == "vertical" and vertical[0]["label"] == "看涨价差 180/190"

    condor = tk.group_legs([
        leg("模拟", "SPX", "20260901", 7500.0, "P", 1), leg("模拟", "SPX", "20260901", 7550.0, "P", -1),
        leg("模拟", "SPX", "20260901", 7700.0, "C", -1), leg("模拟", "SPX", "20260901", 7750.0, "C", 1),
    ])
    assert condor[0]["kind"] == "iron_condor" and condor[0]["right"] == ""

    odd = tk.group_legs([
        leg("模拟", "SPX", "20260901", 7500.0, "P", 1), leg("模拟", "SPX", "20260901", 7550.0, "P", 3),
    ])
    assert odd[0]["kind"] == "custom" and odd[0]["quantity"] is None    # 认不出来就不猜


def test_single_legs_and_different_expiries_do_not_form_a_combo():
    rows = [leg("模拟", "SPX", "20260901", 7600.0, "P", 1), leg("模拟", "SPX", "20260902", 7615.0, "P", -1)]
    assert tk.group_legs(rows) == []


# ---------------------------------------------------------------- 存储迁移
def _old_schema_db(path):
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE position_tracks (
            id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            account TEXT NOT NULL, symbol TEXT NOT NULL, sec_type TEXT NOT NULL DEFAULT 'STK',
            contract TEXT NOT NULL DEFAULT '{}', targets TEXT NOT NULL DEFAULT '{}',
            auto_close TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
            peak REAL, fired_at TEXT, fired_state TEXT NOT NULL DEFAULT '',
            fired_record TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
            UNIQUE(account, symbol, sec_type)
        );
        INSERT INTO position_tracks (id, created_at, updated_at, account, symbol, peak, note)
        VALUES ('t1', '2026-08-01T00:00:00+00:00', '2026-08-01T00:00:00+00:00', '模拟', 'AAPL', 245.5, '老记录');
        """
    )
    conn.commit()
    conn.close()


def test_store_migrates_old_track_table_and_keeps_rows(tmp_path):
    db = tmp_path / "old.db"
    _old_schema_db(db)
    store = TradeStore(db)
    rows = store.list_tracks()
    assert [r["id"] for r in rows] == ["t1"]
    assert rows[0]["leg"] == "" and rows[0]["peak"] == 245.5 and rows[0]["note"] == "老记录"
    # 迁移后能给同一标的的两条期权腿各建一条追踪
    a = store.add_track({"account": "模拟", "symbol": "SPX", "sec_type": "OPT", "leg": "20260901|7600|P"})
    b = store.add_track({"account": "模拟", "symbol": "SPX", "sec_type": "OPT", "leg": "20260901|7615|P"})
    assert a["id"] != b["id"]
    with pytest.raises(ValueError, match=r"已经在追踪 模拟 的 SPX 20260901\|7615\|P 了"):
        store.add_track({"account": "模拟", "symbol": "SPX", "sec_type": "OPT", "leg": "20260901|7615|P"})
    # 正股的重复约束不变
    with pytest.raises(ValueError, match="已经在追踪 模拟 的 AAPL 了"):
        store.add_track({"account": "模拟", "symbol": "AAPL"})
    store.close()
    # 再开一次不重复迁移
    again = TradeStore(db)
    assert len(again.list_tracks()) == 3
    again.close()


# ---------------------------------------------------------------- 组合虚拟行(整组追踪)
def test_butterfly_folds_into_one_trackable_row():
    """用户盯的是"这只蝴蝶值多少":三条腿折成一条 BAG 虚拟行,口径与单腿同一套。"""
    rows = [
        leg("模拟", "SPX", "20260901", 7600.0, "P", 1, cost=30.0, mv=35.0, pnl=5.0),
        leg("模拟", "SPX", "20260901", 7615.0, "P", -2, cost=40.0, mv=-70.0, pnl=10.0),
        leg("模拟", "SPX", "20260901", 7630.0, "P", 1, cost=50.0, mv=40.0, pnl=-10.0),
    ]
    rows[0]["market_price"], rows[1]["market_price"], rows[2]["market_price"] = 0.35, 0.35, 0.40
    out = tk.with_combos(rows)
    assert len(out) == 4 and out[:3] == rows                 # 腿行原样保留,组合行追加
    fly = out[3]
    assert fly["sec_type"] == "BAG" and fly["kind"] == "butterfly"
    assert fly["key"] == "模拟|SPX|BAG|20260901|+1x7600P,-2x7615P,+1x7630P"
    assert fly["quantity"] == 1.0 and fly["net_side"] == "debit"   # 借方组合 = 多头 1 组
    assert fly["avg_cost"] == 30.0 - 80.0 + 50.0                     # 每组净成本(含乘数)
    assert fly["market_price"] == round(0.35 - 0.70 + 0.40, 4)       # 每组净价
    assert fly["market_value"] == 5.0 and fly["unrealized_pnl"] == 5.0
    assert fly["contract"]["secType"] == "BAG" and fly["contract"]["combo_strategy"] == "BUTTERFLY"
    assert [l["ratio"] for l in fly["contract"]["legs"]] == [1.0, -2.0, 1.0]
    # 追踪器拿它当普通持仓算盈亏:成本 0、市值 0.05×100×1
    pos = tk.Position(account=fly["account"], symbol=fly["symbol"], sec_type="BAG",
                      quantity=fly["quantity"], avg_cost=fly["avg_cost"], multiplier=fly["multiplier"])
    assert tk.unrealized(pos, fly["market_price"])["market_value"] == 5.0


def test_credit_combo_is_a_short_with_positive_prices():
    """铁鹰收权利金:记为空头 -N 组、价格取绝对值——权利金缩水才是赚,和空头一样。"""
    rows = [
        leg("模拟", "SPX", "20260901", 7500.0, "P", 1, cost=100.0),
        leg("模拟", "SPX", "20260901", 7550.0, "P", -1, cost=200.0),
        leg("模拟", "SPX", "20260901", 7700.0, "C", -1, cost=200.0),
        leg("模拟", "SPX", "20260901", 7750.0, "C", 1, cost=100.0),
    ]
    for r, p in zip(rows, (0.5, 1.2, 1.2, 0.5)):
        r["market_price"] = p
    condor = tk.with_combos(rows)[-1]
    assert condor["kind"] == "iron_condor"
    assert condor["quantity"] == -1.0 and condor["net_side"] == "credit"
    assert condor["avg_cost"] == 200.0                # |100 - 200 - 200 + 100|
    assert condor["market_price"] == 1.4              # |0.5 - 1.2 - 1.2 + 0.5|
    pos = tk.Position(account="模拟", symbol="SPX", sec_type="BAG", quantity=-1.0,
                      avg_cost=200.0, multiplier=100.0)
    assert tk.unrealized(pos, 1.4)["unrealized_pnl"] == 60.0    # 收 2.00 现在值 1.40 → 赚 60


def test_combo_price_is_none_when_any_leg_has_no_quote():
    rows = [leg("模拟", "NVDA", "20260918", 180.0, "C", 2, cost=500.0),
            leg("模拟", "NVDA", "20260918", 190.0, "C", -2, cost=200.0)]
    rows[0]["market_price"] = 6.0                     # 另一条腿没现价
    spread = tk.with_combos(rows)[-1]
    assert spread["market_price"] is None and spread["quantity"] == 2.0
    assert spread["avg_cost"] == 300.0                # 每组:500 - 200


def test_unrecognised_combo_counts_as_one_unit_with_raw_ratios():
    rows = [leg("模拟", "SPX", "20260901", 7500.0, "P", 1, cost=10.0),
            leg("模拟", "SPX", "20260901", 7550.0, "P", 3, cost=20.0)]
    odd = tk.with_combos(rows)[-1]
    assert odd["kind"] == "custom" and odd["quantity"] == 1.0 and odd["ratios"] == [1.0, 3.0]


# ---------------------------------------------------------------- 组合平仓
def butterfly(prices=(1.20, 0.90, 0.70), qty=(1, -2, 1), costs=(30.0, 40.0, 50.0)):
    """一只买入的看跌蝶(借方,+1/−2/+1),带现价。"""
    rows = [leg("模拟", "SPX", "20260901", k, "P", q, cost=c)
            for k, q, c in zip((7600.0, 7615.0, 7630.0), qty, costs)]
    for row, p in zip(rows, prices):
        row["market_price"] = p
    return tk.with_combos(rows)[-1]


def position_of(row):
    return tk.Position(account=row["account"], symbol=row["symbol"], sec_type=row["sec_type"],
                       quantity=row["quantity"], avg_cost=row["avg_cost"],
                       multiplier=row["multiplier"], market_price=row["market_price"])


def test_closing_a_combo_reverses_every_leg():
    """平组合 = 反着做一遍:买入的腿卖掉、卖出的腿买回。方向错一步就是反向建仓。"""
    fly = butterfly()
    out = tk.close_bag_contract(fly["contract"])
    assert out["secType"] == "BAG" and out["exchange"] == "SMART"
    assert out["combo_strategy"] == "BUTTERFLY"
    assert [(l["action"], l["ratio"], l["strike"]) for l in out["legs"]] == [
        ("SELL", 1, 7600.0), ("BUY", 2, 7615.0), ("SELL", 1, 7630.0)]
    # close_contract 按 secType 分派到同一条路
    assert tk.close_contract(fly["contract"]) == out


def test_combo_close_order_passes_schema_and_submits_as_a_credit():
    """整条链路:虚拟行 → 平仓单 → schema → IBKR 的带符号净价。

    平掉借方蝶是**收**权利金,提交给 IBKR 的 BAG 净价必须是负数;正数意味着又付一次钱。
    """
    from ibkr_agent.broker import bag_signed_limit
    from ibkr_agent.models import parse_llm_payload

    fly = butterfly()
    payload = tk.build_close_order(position_of(fly), tk.AutoClose(enabled=True, order_type="LMT",
                                                                  slippage_pct=5.0),
                                   fly["market_price"], tk.STATE_PROFIT_TRAIL, fly["contract"])
    order = parse_llm_payload({"orders": [payload], "rejections": []}).orders[0]
    assert order.contract.secType == "BAG" and len(order.contract.legs) == 3
    assert order.order.action == "SELL"                      # 用户口径:卖出组合
    assert bag_signed_limit(order.order.action, order.order.lmtPrice) < 0    # IBKR 口径:贷方
    assert order.order.totalQuantity == 1


def test_combo_never_goes_out_as_a_market_order():
    """BAG 的市价单会让每条腿各吃一次价差,一律转限价。"""
    fly = butterfly()
    payload = tk.build_close_order(position_of(fly), tk.AutoClose(enabled=True, order_type="MKT"),
                                   fly["market_price"], tk.STATE_TAKE_PROFIT, fly["contract"])
    assert payload["order"]["orderType"] == "LMT" and payload["order"]["lmtPrice"] > 0
    # 拿不到组合现价就算不出限价,宁可不发
    with pytest.raises(tk.TrackerError, match="组合只能限价平仓"):
        tk.build_close_order(position_of(fly), tk.AutoClose(enabled=True, order_type="MKT"),
                             None, tk.STATE_TAKE_PROFIT, fly["contract"])


def test_credit_combo_closes_by_buying_back():
    """铁鹰是贷方(记为空头):平它是买回,限价要让高一点。"""
    rows = [leg("模拟", "SPX", "20260901", 7500.0, "P", 1, cost=50.0),
            leg("模拟", "SPX", "20260901", 7550.0, "P", -1, cost=120.0),
            leg("模拟", "SPX", "20260901", 7700.0, "C", -1, cost=120.0),
            leg("模拟", "SPX", "20260901", 7750.0, "C", 1, cost=50.0)]
    for row, p in zip(rows, (0.50, 1.20, 1.20, 0.50)):
        row["market_price"] = p
    condor = tk.with_combos(rows)[-1]
    assert condor["net_side"] == "credit" and condor["quantity"] == -1.0
    out = tk.close_bag_contract(condor["contract"])
    assert [(l["action"], l["strike"]) for l in out["legs"]] == [
        ("SELL", 7500.0), ("BUY", 7550.0), ("BUY", 7700.0), ("SELL", 7750.0)]
    payload = tk.build_close_order(position_of(condor), tk.AutoClose(enabled=True, order_type="LMT",
                                                                     slippage_pct=5.0),
                                   condor["market_price"], tk.STATE_STOP_LOSS, condor["contract"])
    assert payload["order"]["action"] == "BUY"                       # 买回
    assert payload["order"]["lmtPrice"] > condor["market_price"]     # 让高一点才买得到


def test_odd_combo_ratios_are_refused_rather_than_guessed():
    """认不出的比例宁可报错:猜错的那张单会在券商侧变成谁也没打算持有的结构。"""
    rows = [leg("模拟", "SPX", "20260901", 7500.0, "P", 1, cost=10.0),
            leg("模拟", "SPX", "20260901", 7550.0, "P", 3, cost=20.0)]
    odd = tk.with_combos(rows)[-1]
    with pytest.raises(tk.TrackerError, match="不是 1 或 2"):
        tk.close_bag_contract(odd["contract"])
    with pytest.raises(tk.TrackerError, match="没有腿信息"):
        tk.close_bag_contract({"secType": "BAG", "symbol": "SPX", "legs": []})


def test_combo_close_needs_its_own_live_switch():
    """allow_live_trading 是"允许碰实盘",不等于"信任这条还没真机核对的新路径"。"""
    fly = butterfly()
    pos = position_of(fly)
    common = dict(auto=tk.AutoClose(enabled=True), auto_execute=True, allow_live_trading=True,
                  breaker_engaged=False, market_status="盘中")
    assert tk.close_blockers(position=pos, account_is_paper=True, **common) == []   # 纸面随便跑
    live = tk.close_blockers(position=pos, account_is_paper=False, **common)
    assert live == [tk.BLOCK_COMBO_LIVE]
    assert tk.close_blockers(position=pos, account_is_paper=False, combo_live_ok=True, **common) == []
    # 单腿不受这道闸约束
    single = tk.Position(account="模拟", symbol="SPX", sec_type="OPT", quantity=1.0, avg_cost=100.0)
    assert tk.close_blockers(position=single, account_is_paper=False, **common) == []


# ---------------------------------------------------------------- 多组合切分
def test_two_butterflies_on_the_same_expiry_are_not_merged():
    """同一到期日的两张蝶必须各算各的,不能揉成一个 6 腿怪物。

    2026-09-04 纸面实测:账户里同时有 7595/7620/7645 看跌蝶和 7800/7820/7840 看涨蝶,
    界面显示的是「组合(6 腿)」——净价、成本、盈亏全混在一起,平仓单更是拼不出来。
    IBKR 的持仓只给每条腿的净数量,不告诉你哪些腿属于同一张组合,所以只能按结构切。
    """
    rows = [
        leg("模拟", "SPX", "20260904", 7595.0, "P", 1, cost=36.54),
        leg("模拟", "SPX", "20260904", 7620.0, "P", -2, cost=43.81),
        leg("模拟", "SPX", "20260904", 7645.0, "P", 1, cost=86.54),
        leg("模拟", "SPX", "20260904", 7800.0, "C", 1, cost=256.63),
        leg("模拟", "SPX", "20260904", 7820.0, "C", -2, cost=108.72),
        leg("模拟", "SPX", "20260904", 7840.0, "C", 1, cost=61.54),
    ]
    combos = tk.group_legs(rows)
    assert len(combos) == 2, [c["label"] for c in combos]
    assert [c["kind"] for c in combos] == ["butterfly", "butterfly"]
    assert combos[0]["label"] == "买入看跌蝴蝶 7595/7620/7645"
    assert combos[1]["label"] == "买入看涨蝴蝶 7800/7820/7840"
    assert all(c["quantity"] == 1.0 for c in combos)
    # 两条虚拟行,各自独立的 key 与成本
    fly_rows = [r for r in tk.with_combos(rows) if r["sec_type"] == "BAG"]
    assert len(fly_rows) == 2
    assert len({r["key"] for r in fly_rows}) == 2
    assert fly_rows[0]["avg_cost"] == round(abs(36.54 - 2 * 43.81 + 86.54), 4)


def test_two_butterflies_with_the_same_right_are_also_split():
    """两张同方向的蝶也要切开——不能靠 C/P 不同来区分。"""
    rows = [leg("模拟", "SPX", "20260904", k, "P", q, cost=c) for k, q, c in (
        (7595.0, 1, 30.0), (7620.0, -2, 40.0), (7645.0, 1, 50.0),
        (7800.0, 1, 20.0), (7820.0, -2, 30.0), (7840.0, 1, 40.0))]
    combos = tk.group_legs(rows)
    assert [c["kind"] for c in combos] == ["butterfly", "butterfly"]
    assert [c["quantity"] for c in combos] == [1.0, 1.0]


def test_a_single_iron_condor_is_not_split_into_two_verticals():
    """铁鹰是 4 条腿的一个结构,不能被拆成两个价差——先试长的形状就是为了这个。"""
    rows = [leg("模拟", "SPX", "20260901", k, r, q, cost=c) for k, r, q, c in (
        (7500.0, "P", 1, 50.0), (7550.0, "P", -1, 120.0),
        (7700.0, "C", -1, 120.0), (7750.0, "C", 1, 50.0))]
    combos = tk.group_legs(rows)
    assert len(combos) == 1 and combos[0]["kind"] == "iron_condor"


def test_unrecognisable_legs_stay_one_custom_combo():
    """认不出就整块留着叫「组合(N 腿)」——认不出可以接受,拆错不行。"""
    rows = [leg("模拟", "SPX", "20260901", k, "P", q, cost=10.0) for k, q in (
        (7500.0, 1), (7550.0, 3), (7600.0, 5))]
    combos = tk.group_legs(rows)
    assert len(combos) == 1 and combos[0]["kind"] == "custom"
    assert combos[0]["label"].startswith("组合(3 腿)")


def test_a_butterfly_followed_by_leftovers_keeps_both():
    """能认出的先认出来,剩下的整块留给 custom。"""
    rows = [leg("模拟", "SPX", "20260901", k, "P", q, cost=10.0) for k, q in (
        (7500.0, 1), (7520.0, -2), (7540.0, 1),      # 一张蝶
        (7900.0, 3), (7950.0, 7))]                   # 认不出的两条
    combos = tk.group_legs(rows)
    assert [c["kind"] for c in combos] == ["butterfly", "custom"]
    assert combos[1]["label"].startswith("组合(2 腿)")
