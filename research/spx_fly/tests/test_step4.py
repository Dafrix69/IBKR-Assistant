"""Known-answer tests for weekly_fly.py. Offline.

    .venv/bin/python tests/test_step4.py
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
import fetch_thetadata as X
import gex as G
import weekly_fly as W

D = [pd.Timestamp(d) for d in ("2025-01-06", "2025-01-07", "2025-01-08", "2025-01-09", "2025-01-10")]
EXP = D[-1]


def closes(vals):
    return dict(zip(D[:-1], vals))


def test_hold_settles():
    assert W.exit_for("hold", closes([5, 5, 5, 5]), D, EXP, 5.0) is None


def test_close_prior_uses_last_quoted_day():
    assert W.exit_for("close_prior", closes([5, 5, 5, np.nan]), D, EXP, 5.0) == D[2]


def test_tp_fills_next_close():
    assert W.exit_for("tp3", closes([5, 16, 9, 9]), D, EXP, 5.0, tp=3) == D[2]


def test_tp_on_last_close_settles():
    assert W.exit_for("tp3", closes([5, 5, 5, 16]), D, EXP, 5.0, tp=3) is None


def test_tp_now_fills_the_trigger_close():
    assert W.exit_for("tp3_now", closes([5, 16, 9, 9]), D, EXP, 5.0, tp=3) == D[1]
    assert W.exit_for("tp3_now", closes([5, 5, 5, 16]), D, EXP, 5.0, tp=3) == D[3]


def test_cross_fills_that_close_and_settles_on_expiry():
    assert W.exit_for("cross25", closes([5, 5, 5, 5]), D, EXP, 5.0, cross_day=D[1]) == D[1]
    assert W.exit_for("cross25", closes([5, np.nan, 5, 5]), D, EXP, 5.0, cross_day=D[1]) == D[2]
    assert W.exit_for("cross25", closes([5, 5, 5, 5]), D, EXP, 5.0, cross_day=EXP) is None
    assert W.exit_for("cross25", closes([5, 5, 5, 5]), D, EXP, 5.0, cross_day=None) is None


def test_first_cross():
    s = pd.Series([100.0, 110.0, 126.0, 90.0], index=pd.date_range("2025-01-06 10:00", periods=4, freq="min"))
    assert W.first_cross(s, 100.0, 25.0) == s.index[2]
    assert W.first_cross(s, 100.0, 50.0) is None


def test_put_greeks_finite_difference():
    F, K, T = 6000.0, 6000.0, 7 / 365
    vol = 0.15
    m = float(G.black_price(F, K, vol ** 2 * T, False))
    d, th = W.put_greeks(F, K, m, T)
    h = 0.5
    fd = (G.black_price(F + h, K, vol ** 2 * T, False) - G.black_price(F - h, K, vol ** 2 * T, False)) / (2 * h)
    assert abs(float(d) - float(fd)) < 1e-4
    dt = 0.01 / 365                                           # theta is per day, measured over 0.01 day
    fd_t = (G.black_price(F, K, vol ** 2 * (T - dt), False) - m) / 0.01
    assert abs(float(th) - float(fd_t)) < 0.01 * abs(float(fd_t))


def test_entries_pick_next_week_and_holiday_thursday():
    cal = pd.DataFrame({"half_day": [False, False, True]}, index=pd.to_datetime(["2026-04-10", "2026-06-12", "2026-11-27"]))
    exps = ["2026-04-14", "2026-04-17", "2026-06-16", "2026-06-18", "2026-12-04"]
    got = X.entries(cal, exps)
    # 06-19 is a holiday, so 06-12 maps to Thursday 06-18; the half-day Friday has no entry
    assert got == [(pd.Timestamp("2026-04-10"), pd.Timestamp("2026-04-17")), (pd.Timestamp("2026-06-12"), pd.Timestamp("2026-06-18"))]


if __name__ == "__main__":
    n = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
            n += 1
    print(n, "tests passed")
