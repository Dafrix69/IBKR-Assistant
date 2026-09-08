"""券商成交明细 → 蝴蝶交易记录(ibtrades),以及 broker_fills 的累积存储。全部脱机。"""
from __future__ import annotations

from ibkr_agent import ibtrades as ibt
from ibkr_agent.store import TradeStore

ACCOUNTS = [{"alias": "主账户", "account_id": "U18051177", "is_paper": False},
            {"alias": "模拟", "account_id": "DUR075261", "is_paper": True}]


def fill(exec_id, time, side, shares, price, *, perm=256406619, sec="OPT", strike=None,
         right="C", expiry="20260903", account="U18051177", commission=None):
    contract = {"secType": sec, "symbol": "SPX", "currency": "USD", "exchange": "CBOE",
                "expiry": expiry if sec != "BAG" else "", "strike": strike, "right": right,
                "tradingClass": "SPXW" if sec != "BAG" else "", "multiplier": "100", "conId": 1}
    return {"exec_id": exec_id, "time": time, "account_id": account, "side": side, "shares": shares,
            "price": price, "order_id": 0, "perm_id": perm, "order_ref": "", "commission": commission,
            "contract": contract}


T = "2026-09-03T14:03:34+00:00"


def long_call_fly():
    """真机样子:1 条 BAG 行 + 3 条腿行,同一 permId。"""
    return [
        fill("bag", T, "BOT", 1, 2.25, sec="BAG"),
        fill("e1", T, "BOT", 1, 0.22, strike=7760),
        fill("e2", T, "SLD", 2, 0.82, strike=7740),
        fill("e3", T, "BOT", 1, 3.67, strike=7720),
    ]


def test_bag_plus_legs_becomes_one_long_butterfly():
    recs = ibt.group_butterflies(long_call_fly(), ACCOUNTS)
    assert len(recs) == 1
    r = recs[0]
    assert r["id"] == "ib:256406619" and r["source"] == "ibkr"
    assert r["order"]["action"] == "BUY" and r["order"]["totalQuantity"] == 1
    assert [l["strike"] for l in r["contract"]["legs"]] == [7720, 7740, 7760]
    assert [l["ratio"] for l in r["contract"]["legs"]] == [1, 2, 1]
    assert [l["action"] for l in r["contract"]["legs"]] == ["BUY", "SELL", "BUY"]
    assert r["ibkr"]["avg_fill_price"] == 2.25            # 净价优先用 BAG 行
    assert r["ibkr"]["fills"][0]["exec_id"] == "bag"
    assert r["account"]["alias"] == "主账户" and r["account"]["is_paper"] is False
    assert r["final_status"] == "filled" and r["created_at"] == T
    assert "买入 1 张 SPX 7720/7740/7760 看涨蝴蝶(翼宽 20)@ 2.25" == r["llm"]["intent_summary"]


def test_legs_only_computes_the_net_premium_from_the_legs():
    rows = [f for f in long_call_fly() if f["exec_id"] != "bag"]
    r = ibt.group_butterflies(rows, ACCOUNTS)[0]
    assert r["ibkr"]["avg_fill_price"] == 2.25           # 0.22 + 3.67 - 2*0.82
    assert r["ibkr"]["fills"][0]["exec_id"] == "(合成)"


def test_short_put_butterfly_from_the_other_day():
    rows = [
        fill("b", "2026-09-02T17:16:06+00:00", "SLD", 1, 2.85, sec="BAG", perm=392673899),
        fill("1", "2026-09-02T17:16:06+00:00", "BOT", 2, 0.72, strike=7635, right="P", expiry="20260902", perm=392673899),
        fill("2", "2026-09-02T17:16:06+00:00", "SLD", 1, 4.02, strike=7660, right="P", expiry="20260902", perm=392673899),
        fill("3", "2026-09-02T17:16:06+00:00", "SLD", 1, 0.27, strike=7610, right="P", expiry="20260902", perm=392673899),
    ]
    r = ibt.group_butterflies(rows, ACCOUNTS)[0]
    assert r["order"]["action"] == "SELL"
    assert [l["action"] for l in r["contract"]["legs"]] == ["SELL", "BUY", "SELL"]
    assert r["ibkr"]["avg_fill_price"] == 2.85 and r["expiry"] == "2026-09-02"
    assert "卖出 1 张 SPX 7610/7635/7660 看跌蝴蝶(翼宽 25)@ 2.85" == r["llm"]["intent_summary"]


def test_partial_fills_are_weighted_and_earliest_time_wins():
    rows = [
        fill("e1a", "2026-09-03T14:03:34+00:00", "BOT", 1, 0.20, strike=7760, perm=7),
        fill("e1b", "2026-09-03T14:03:30+00:00", "BOT", 1, 0.24, strike=7760, perm=7),
        fill("e2", "2026-09-03T14:03:34+00:00", "SLD", 4, 0.82, strike=7740, perm=7),
        fill("e3", "2026-09-03T14:03:34+00:00", "BOT", 2, 3.67, strike=7720, perm=7),
    ]
    r = ibt.group_butterflies(rows, ACCOUNTS)[0]
    assert r["order"]["totalQuantity"] == 2
    assert r["created_at"] == "2026-09-03T14:03:30+00:00"
    assert r["contract"]["legs"][2]["fill_price"] == 0.22      # (0.20+0.24)/2
    assert r["ibkr"]["avg_fill_price"] == 2.25


def test_non_butterflies_and_other_orders_are_ignored():
    rows = long_call_fly()
    rows[1]["perm_id"] = 999                     # 一条腿属于别的订单 → 剩两腿,不是蝴蝶
    assert ibt.group_butterflies(rows, ACCOUNTS) == []
    spread = [fill("s1", T, "BOT", 1, 1.0, strike=7700, perm=5), fill("s2", T, "SLD", 1, 0.5, strike=7720, perm=5)]
    assert ibt.group_butterflies(spread, ACCOUNTS) == []
    stock = [{"exec_id": "x", "time": T, "account_id": "U18051177", "side": "BOT", "shares": 1, "price": 326,
              "perm_id": 3, "contract": {"secType": "STK", "symbol": "AAPL"}}]
    assert ibt.group_butterflies(stock, ACCOUNTS) == []


def test_unmapped_account_is_kept_but_masked():
    rows = [dict(f, account_id="U99999999") for f in long_call_fly()]
    r = ibt.group_butterflies(rows, ACCOUNTS)[0]
    assert r["account"]["alias"] == "未配置账户 U9***999" and r["account"]["is_paper"] is False
    paper = [dict(f, account_id="DU1234567") for f in long_call_fly()]
    assert ibt.group_butterflies(paper, ACCOUNTS)[0]["account"]["is_paper"] is True


def test_records_sort_by_time_and_commissions_add_up():
    rows = long_call_fly() + [
        fill("b2", "2026-09-02T17:16:06+00:00", "SLD", 1, 2.85, sec="BAG", perm=1),
        fill("21", "2026-09-02T17:16:06+00:00", "BOT", 2, 0.72, strike=7635, right="P", expiry="20260902", perm=1, commission=1.1),
        fill("22", "2026-09-02T17:16:06+00:00", "SLD", 1, 4.02, strike=7660, right="P", expiry="20260902", perm=1, commission=0.55),
        fill("23", "2026-09-02T17:16:06+00:00", "SLD", 1, 0.27, strike=7610, right="P", expiry="20260902", perm=1, commission=0.55),
    ]
    recs = ibt.group_butterflies(rows, ACCOUNTS)
    assert [r["id"] for r in recs] == ["ib:1", "ib:256406619"]
    assert recs[0]["ibkr"]["total_commission"] == 2.2
    assert recs[1]["ibkr"]["total_commission"] is None


# ---- 存储:成交只增不改,按 exec_id 去重 ------------------------------------
def test_store_remembers_fills_once(tmp_path):
    store = TradeStore(tmp_path / "t.db")
    rows = long_call_fly()
    assert store.remember_fills(rows) == 4
    assert store.remember_fills(rows) == 0                # 同一批再来一次:一条都不重复
    rows2 = [fill("new", "2026-09-04T14:00:00+00:00", "BOT", 1, 1.0, strike=7800, perm=8)]
    assert store.remember_fills(rows2) == 1
    kept = store.list_fills()
    assert [f["exec_id"] for f in kept][-1] == "new"       # 按时间升序
    assert len(kept) == 5 and kept[0]["contract"]["secType"] == "BAG"
    store.close()
