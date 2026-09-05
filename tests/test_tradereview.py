"""交易复盘(tradereview):蝴蝶结构识别、盈亏区间、开/平仓定位与规则化结论。全部脱机。"""
from __future__ import annotations

from datetime import datetime

import pytest

from ibkr_agent import tradereview as tr
from ibkr_agent.config import ET


def leg(action, ratio, strike, right="P", expiry="20260812"):
    return {"action": action, "ratio": ratio, "strike": strike, "right": right,
            "lastTradeDateOrContractMonth": expiry, "tradingClass": "SPXW", "multiplier": "100"}


def fly_record(rid="r1", action="BUY", fill=1.75, limit=1.8, created="2026-08-12T14:35:00+00:00",
               fill_time="2026-08-12 14:36:10+00:00", strikes=(7600, 7615, 7630), right="P"):
    inner = "SELL" if action == "BUY" else "BUY"
    rec = {
        "id": rid, "created_at": created,
        "contract": {"secType": "BAG", "symbol": "SPX", "multiplier": "100", "combo_strategy": "BUTTERFLY",
                     "legs": [leg(action, 1, strikes[0], right), leg(inner, 2, strikes[1], right),
                              leg(action, 1, strikes[2], right)]},
        "order": {"action": action, "totalQuantity": 1, "lmtPrice": limit},
        "ibkr": {"avg_fill_price": fill, "fills": []},
        "final_status": "filled" if fill is not None else None,
    }
    if fill is not None:
        rec["ibkr"]["fills"] = [{"time": fill_time, "price": fill, "qty": 1}]
    return rec


def flat_bars(start_price, n=120, step=0.0, day="2026-08-12"):
    """从 09:30 起每 5 分钟一根到 16:00,再翻到下一天;收盘价线性变化,好把统计算得明明白白。"""
    from datetime import date, timedelta

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


NOW = datetime(2026, 8, 14, 12, 0, tzinfo=ET)


# ---- 结构 ---------------------------------------------------------------
def test_profile_recognises_a_long_put_butterfly():
    p = tr.butterfly_profile(fly_record())
    assert (p["lower"], p["center"], p["upper"], p["width"]) == (7600, 7615, 7630, 15)
    assert p["right"] == "P" and p["expiry"] == "2026-08-12"
    assert p["debit"] == 1.75 and p["price_estimated"] is False


def test_profile_rejects_non_butterflies():
    assert tr.butterfly_profile({"contract": {"secType": "STK", "symbol": "AAPL"}}) is None
    rec = fly_record()
    rec["contract"]["legs"][1]["ratio"] = 1        # 1:1:1 不是蝴蝶
    assert tr.butterfly_profile(rec) is None
    rec = fly_record()
    rec["contract"]["legs"][2]["right"] = "C"      # 混方向
    assert tr.butterfly_profile(rec) is None


def test_unfilled_record_falls_back_to_limit_and_is_marked_estimated():
    p = tr.butterfly_profile(fly_record(fill=None))
    assert p["debit"] == 1.8 and p["price_estimated"] is True


def test_payoff_is_the_tent_and_zone_uses_the_debit():
    p = tr.butterfly_profile(fly_record())
    assert tr.payoff_per_unit(p, 7615) == 15
    assert tr.payoff_per_unit(p, 7600) == 0 and tr.payoff_per_unit(p, 7630) == 0
    assert tr.payoff_per_unit(p, 7700) == 0 and tr.payoff_per_unit(p, 7500) == 0
    z = tr.zone(p)
    assert (z["lower_be"], z["upper_be"]) == (7601.75, 7628.25)
    assert (z["max_profit"], z["max_loss"]) == (1325.0, 175.0)
    assert tr.pnl_at(p, 7615) == 1325.0 and tr.pnl_at(p, 7700) == -175.0


def test_short_butterfly_flips_the_pnl_but_not_the_zone():
    p = tr.butterfly_profile(fly_record(action="SELL"))
    z = tr.zone(p)
    assert (z["max_profit"], z["max_loss"]) == (175.0, 1325.0)
    assert tr.pnl_at(p, 7615) == -1325.0 and tr.pnl_at(p, 7700) == 175.0


# ---- 时间 ---------------------------------------------------------------
def test_parse_when_accepts_the_three_shapes():
    iso = tr.parse_when("2026-08-12T14:36:10+00:00")
    assert iso.astimezone(ET).strftime("%H:%M") == "10:36"
    raw = tr.parse_when("20260812 10:36:10")           # IBKR 原样,按美东
    assert raw.strftime("%H:%M") == "10:36" and raw.tzinfo is not None
    bar = tr.parse_when("2026-08-12 10:35")
    assert bar.strftime("%Y-%m-%d %H:%M") == "2026-08-12 10:35"
    assert tr.parse_when("garbage") is None


def test_index_at_aligns_to_the_last_bar_at_or_before():
    bars = flat_bars(7600, n=10)
    when = tr.parse_when("2026-08-12 09:47")
    assert tr.index_at(bars, when, daily=False) == 3      # 09:45
    assert tr.index_at(bars, tr.parse_when("2026-08-12 09:00"), daily=False) is None


def test_pick_timeframe_gets_finer_for_recent_trades():
    base = datetime(2026, 8, 14, 12, 0, tzinfo=ET)
    assert tr.pick_timeframe(datetime(2026, 8, 14, 10, 0, tzinfo=ET), base) == "1m"
    assert tr.pick_timeframe(datetime(2026, 8, 12, 10, 0, tzinfo=ET), base) == "5m"
    assert tr.pick_timeframe(datetime(2026, 8, 7, 10, 0, tzinfo=ET), base) == "15m"
    assert tr.pick_timeframe(datetime(2026, 7, 25, 10, 0, tzinfo=ET), base) == "1h"
    assert tr.pick_timeframe(datetime(2026, 6, 1, 10, 0, tzinfo=ET), base) == "1d"


# ---- 复盘 ---------------------------------------------------------------
def test_expired_inside_the_tent_is_a_win():
    bars = flat_bars(7640, n=80, step=-0.32)     # 一路跌向中心:16:00 那根 ≈ 7615
    r = tr.review(fly_record(), [], bars, "5m", NOW)
    assert r["outcome"]["kind"] == "expired"
    assert r["entry"]["bar_time"] == "2026-08-12 10:35"
    assert r["outcome"]["pnl"] > 0 and r["outcome"]["price"] == r["stats"]["settle_value"]
    assert r["stats"]["moved_toward_center"] is True
    titles = [f["title"] for f in r["findings"]]
    assert "到期" in titles and "方向" in titles
    assert any("方向判断正确" in f["text"] for f in r["findings"])
    kinds = [m["kind"] for m in r["series"]["markers"]]
    assert kinds == ["entry", "expiry"]
    assert {lv["kind"] for lv in r["series"]["levels"]} == {"lower", "center", "upper", "lower_be", "upper_be"}


def test_expired_outside_loses_the_premium():
    bars = flat_bars(7640, n=80, step=+1.0)      # 一路涨离中心
    r = tr.review(fly_record(), [], bars, "5m", NOW)
    assert r["outcome"]["pnl"] == -175.0 and r["outcome"]["pnl_pct"] == -100.0
    assert any(f["title"] == "方向" and f["tone"] == "bad" for f in r["findings"])


def test_closed_by_an_opposite_record_uses_that_fill():
    bars = flat_bars(7640, n=80, step=-0.5)
    opener = fly_record()
    closer = fly_record(rid="r2", action="SELL", fill=4.0, created="2026-08-12T16:00:00+00:00",
                        fill_time="2026-08-12 16:01:00+00:00")
    r = tr.review(opener, [opener, closer], bars, "5m", NOW)
    assert r["outcome"]["kind"] == "closed" and r["outcome"]["record_id"] == "r2"
    assert r["outcome"]["price"] == 4.0 and r["outcome"]["pnl"] == 225.0
    assert r["outcome"]["time_et"] == "2026-08-12 12:01"
    assert any(f["title"] == "平仓" and f["tone"] == "good" for f in r["findings"])


def test_still_open_reports_pnl_if_expired_now():
    bars = flat_bars(7640, n=40, step=-0.5)
    now = datetime(2026, 8, 12, 13, 0, tzinfo=ET)          # 到期日盘中
    r = tr.review(fly_record(), [], bars, "5m", now)
    assert r["outcome"]["kind"] == "open" and r["outcome"]["pnl"] is None
    assert r["outcome"]["pnl_if_expired_now"] is not None
    assert r["series"]["markers"][-1]["kind"] == "entry"


def test_missed_opportunity_is_called_out():
    """持有期间到过帐篷里,最后却归零——这条必须说出来。"""
    bars = flat_bars(7640, n=40, step=-1.0) + flat_bars(7600, n=40, step=+2.0)
    for i, b in enumerate(bars[40:], 40):        # 续上时间戳
        h, m = divmod(9 * 60 + 30 + i * 5, 60)
        b["time"] = "2026-08-12 %02d:%02d" % (h, m)
    r = tr.review(fly_record(), [], bars, "5m", NOW)
    assert r["stats"]["best_theoretical"]["pnl"] > 0
    assert any(f["title"] == "曾有的机会" for f in r["findings"])


def test_estimates_are_labelled_in_notes():
    bars = flat_bars(7640, n=80, step=-0.5)
    r = tr.review(fly_record(fill=None), [], bars, "5m", NOW)
    assert any("按限价估算" in n for n in r["notes"])
    assert any("按提交时间算" in n for n in r["notes"])
    assert r["entry"]["estimated"] is True


def test_errors_are_explicit():
    with pytest.raises(tr.ReviewError, match="不是蝴蝶"):
        tr.review({"contract": {"secType": "STK"}}, [], flat_bars(1), "5m", NOW)
    with pytest.raises(tr.ReviewError, match="没有覆盖到开仓时刻"):
        tr.review(fly_record(), [], flat_bars(7600, n=5), "5m", NOW)   # K 线只到 09:50


def test_window_is_capped_but_keeps_entry_and_exit():
    bars = flat_bars(7640, n=400, step=-0.1)
    r = tr.review(fly_record(), [], bars, "5m", NOW)
    win = r["series"]["bars"]
    assert len(win) <= tr.MAX_WINDOW
    times = {b["time"] for b in win}
    assert r["series"]["markers"][0]["time"] in times
    assert r["series"]["markers"][1]["time"] in times
