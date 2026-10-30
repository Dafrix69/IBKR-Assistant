"""Known-answer tests for fly_grid.py. Offline, synthetic quotes.

    .venv/bin/python tests/test_step3.py
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
import fly_grid as Y
import fills

KS = Y.KS
K, W = 6000.0, 25


def book_with_value(values, half=0.1):
    """Put fly book whose mid value by minute is `values`: wings fixed, body moves."""
    n = Y.N_MIN
    v = np.array(values, float)
    low = np.full(n, 2.0)
    up = np.full(n, 40.0)
    body = (low + up - v) / 2
    mk = lambda m: (m - half, m + half)
    return {(K - W, "P"): mk(low), (K, "P"): mk(body), (K + W, "P"): mk(up)}


def approx(a, b, tol=1e-9):
    assert abs(a - b) < tol, (a, b)


def run(values, rule, settle=6000.0, entry="10:00"):
    r = Y.simulate(book_with_value(values), pd.Timestamp("2025-01-02"), entry, K, W, "put_fly", settle, {"x": rule})
    return r[0]


def base(v0=10.0):
    return np.full(Y.N_MIN, v0)


def test_minute_of():
    assert Y.minute_of("09:30") == 0 and Y.minute_of("10:00") == 30 and Y.minute_of("15:59") == 389


def test_hold_settles_at_payoff_without_exit_cost():
    r = run(base(), {}, settle=6010.0)
    assert r["reason"] == "settle" and r["exit_value"] == 15.0
    # H at entry = (0.1 + 2*0.1 + 0.1) = 0.4
    fee = float((np.array([1, 2, 1]) * fills.leg_fee(np.array([2.0, 16.0, 40.0]), Y.F)).sum())
    approx(r["pnl_k0.0"], (15 - 10) * 100 - fee)
    approx(r["pnl_k0.5"], (15 - 10 - 0.2) * 100 - fee)


def test_tp_fills_on_the_next_minute():
    v = base(); e = Y.minute_of("10:00")
    v[e + 5] = 20.0        # trigger at e+5
    v[e + 6] = 18.0        # the fill must be this later quote, not 20
    r = run(v, {"tp": 2})
    assert r["reason"] == "tp" and r["exit_min"] == e + 6
    approx(r["exit_value"], 18.0)


def test_sl_and_max_excursions():
    v = base(); e = Y.minute_of("10:00")
    v[e + 2] = 14.0; v[e + 3] = 5.0; v[e + 4] = 4.0
    r = run(v, {"sl": 0.5})
    assert r["reason"] == "sl" and r["exit_min"] == e + 4
    approx(r["max_up"], 4.0); approx(r["max_dn"], -6.0)


def test_time_stop_fills_at_that_minute():
    v = base(); t = Y.minute_of("14:00")
    v[t] = 12.0
    r = run(v, {"time": "14:00"})
    assert r["reason"] == "time" and r["exit_min"] == t
    approx(r["exit_value"], 12.0)


def test_time_before_entry_is_skipped():
    r = Y.simulate(book_with_value(base()), pd.Timestamp("2025-01-02"), "14:00", K, W, "put_fly", 6000.0, {"x": {"time": "14:00"}})
    assert r == []


def test_nan_blocks_a_check():
    v = base(); e = Y.minute_of("10:00")
    book = book_with_value(v)
    b, a = book[(K, "P")]
    b, a = b.copy(), a.copy()
    b[e + 1] = np.nan; a[e + 1] = np.nan
    book[(K, "P")] = (b, a)
    r = Y.simulate(book, pd.Timestamp("2025-01-02"), "10:00", K, W, "put_fly", 6000.0, {"x": {"time": "10:01"}})
    assert r[0]["exit_min"] == e + 2                          # scheduled minute unusable, next quote


def test_iron_fly_equals_put_fly_under_parity():
    """Quotes built from parity with zero spread: same value, same payoff."""
    F0 = 6000.0
    n = Y.N_MIN
    book = {}
    pv = {K - W: 2.0, K: 12.0, K + W: 34.0}
    for s, p in pv.items():
        c = p + F0 - s
        book[(s, "P")] = (np.full(n, p), np.full(n, p))
        book[(s, "C")] = (np.full(n, c), np.full(n, c))
    pf = Y.simulate(book, pd.Timestamp("2025-01-02"), "10:00", K, W, "put_fly", 6010.0, {"x": {}})[0]
    cf = Y.simulate(book, pd.Timestamp("2025-01-02"), "10:00", K, W, "call_fly", 6010.0, {"x": {}})[0]
    ifl = Y.simulate(book, pd.Timestamp("2025-01-02"), "10:00", K, W, "iron_fly", 6010.0, {"x": {}})[0]
    approx(pf["cost"], 12.0, 1e-9); approx(cf["cost"], 12.0, 1e-9); approx(ifl["cost"], 12.0, 1e-9)
    assert pf["exit_value"] == cf["exit_value"] == ifl["exit_value"] == 15.0


def test_windows_do_not_overlap_and_train_precedes_valid():
    wf = {"train_months": 12, "valid_months": 3, "step_months": 3}
    w = list(Y.windows(pd.Timestamp("2022-05-02"), pd.Timestamp("2026-10-29"), wf))
    assert w[0][1] == pd.Timestamp("2023-05-01")
    assert all(a[2] == b[1] for a, b in zip(w, w[1:]))
    assert all(t < v < e for t, v, e in w)
    assert len(w) == 14 and w[-1][1] == pd.Timestamp("2026-08-01")


def test_select_needs_floor():
    rows = []
    for rule, a, b in (("good", 50.0, 10.0), ("better_but_fragile", 90.0, -5.0)):
        for _ in range(5):
            rows.append({"entry": "12:00", "width": 25, "structure": "put_fly", "rule": rule, "cost": 10.0,
                         "pnl_k0.25": a, "pnl_k0.5": b})
    t = pd.DataFrame(rows)
    wf = {"rank_k": 0.25, "floor_k": 0.5}
    best, _ = Y.select(t, wf)
    assert best[3] == "good"
    t2 = t[t.rule == "better_but_fragile"]
    assert Y.select(t2, wf)[0] is None


if __name__ == "__main__":
    n = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
            n += 1
    print(n, "tests passed")
