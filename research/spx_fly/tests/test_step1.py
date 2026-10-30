"""Known-answer tests for fills.py and load_clean.py. Offline, synthetic data.

    .venv/bin/python tests/test_step1.py
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
import fills
import load_clean as L

CFG = L.CFG["fills"]


def approx(a, b, tol=1e-9):
    assert abs(a - b) < tol, (a, b)


def test_fill_price():
    approx(fills.fill_price(1, 1.0, 1.2, 0.0), 1.1)
    approx(fills.fill_price(1, 1.0, 1.2, 0.25), 1.125)
    approx(fills.fill_price(1, 1.0, 1.2, 1.0), 1.2)
    approx(fills.fill_price(-1, 1.0, 1.2, 0.5), 1.05)
    approx(fills.fill_price(-1, 1.0, 1.2, 1.0), 1.0)


def test_leg_fee_tiers():
    # 0.65 + 0.45 + 0.14 + 0.03
    approx(float(fills.leg_fee(2.0, CFG)), 1.27)
    # premium exactly 1.00 is the upper exchange tier
    approx(float(fills.leg_fee(1.0, CFG)), 1.27)
    # 0.65 + 0.36 + 0.14 + 0.03
    approx(float(fills.leg_fee(0.5, CFG)), 1.18)
    # 0.25 + 0.36 + 0.14 + 0.03
    approx(float(fills.leg_fee(0.04, CFG)), 0.78)
    approx(float(fills.leg_fee(0.05, CFG)), 1.03)
    approx(float(fills.leg_fee(0.10, CFG)), 1.18)


def test_fly_cost_and_settle():
    strikes, sides, qtys = fills.fly_legs(6000, 25)
    assert strikes == [5975, 6000, 6025] and sides == [1, -1, 1] and qtys == [1, 2, 1]
    bids, asks = [1.0, 5.0, 12.0], [1.2, 5.2, 12.4]
    # mid: 1.1 - 10.2 + 12.2 = 3.1 points
    fee_mid = 4 * 1.27                                        # every leg premium >= 1
    approx(fills.combo_cost(sides, qtys, bids, asks, 0.0, CFG), 310 + fee_mid)
    # k=1: pays ask on longs, gets bid on shorts: 1.2 - 10 + 12.4 = 3.6
    approx(fills.combo_cost(sides, qtys, bids, asks, 1.0, CFG), 360 + 4 * 1.27)
    approx(fills.fly_settle_value(6000, 6000, 25), 25)
    approx(fills.fly_settle_value(6010, 6000, 25), 15)
    approx(fills.fly_settle_value(5970, 6000, 25), 0)


def test_spot_is_known_at_its_minute():
    bars = pd.DataFrame({"ts": pd.to_datetime(["2025-01-02 09:30", "2025-01-02 09:31", "2025-01-02 09:32"]),
                         "open": [100.0, 101.0, 102.0], "close": [101.5, 102.5, 103.5]})
    s = L.spot_from_bars(bars).set_index("ts").spot
    approx(s[pd.Timestamp("2025-01-02 09:30")], 100.0)        # open of the first bar
    approx(s[pd.Timestamp("2025-01-02 09:31")], 101.5)        # close of the 09:30 bar
    approx(s[pd.Timestamp("2025-01-02 09:32")], 102.5)
    assert pd.Timestamp("2025-01-02 09:33") not in s.index


def test_opex():
    td = pd.bdate_range("2026-01-01", "2026-12-31")
    td = td[~td.isin(pd.to_datetime(["2026-06-19", "2026-04-03"]))]
    ox = L.opex_days(td)
    assert pd.Timestamp("2026-06-18") in ox and ox[pd.Timestamp("2026-06-18")] is True   # Juneteenth is the third Friday
    assert pd.Timestamp("2026-06-19") not in ox
    assert ox[pd.Timestamp("2026-07-17")] is False
    assert ox[pd.Timestamp("2026-09-18")] is True
    assert len(ox) == 12


def test_flags():
    df = pd.DataFrame({"bid": [1.0, 0.0, 0.0, 2.0, 0.10, 0.0],
                       "ask": [1.1, 0.0, 3.0, 1.0, 0.50, 0.20]})
    df["mid"] = (df.bid + df.ask) / 2
    f = L.flag_quotes(df, {"max_spread_to_mid": 1.0, "bid0_ask_max": 1.0})
    assert f.flag_bad.tolist() == [False, True, True, True, True, False]
    assert f.flag_no_quote.tolist()[1] and f.flag_bid0_ask_big.tolist()[2]
    assert f.flag_crossed.tolist()[3] and f.flag_wide.tolist()[4]


def test_session_cut():
    ts = pd.Series(pd.to_datetime(["2024-11-29 12:59", "2024-11-29 13:00", "2024-11-29 16:00"]))
    assert L.session_cut(ts, pd.Timestamp("2024-11-29"), "13:00").tolist() == [True, False, False]
    assert L.session_cut(ts, pd.Timestamp("2024-11-29"), "16:00").tolist() == [True, True, False]


if __name__ == "__main__":
    n = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
            n += 1
    print(n, "tests passed")
