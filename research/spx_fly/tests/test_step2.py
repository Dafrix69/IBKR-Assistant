"""Known-answer tests for gex.py. Offline, synthetic data.

    .venv/bin/python tests/test_step2.py
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
import gex as G


def approx(a, b, tol=1e-6):
    assert abs(a - b) < tol, (a, b)


def test_atm_straddle_textbook():
    # ATM straddle = 2 F (2 N(s/2) - 1), and about 0.7979 F s for small s
    F, s = 6000.0, 0.01
    x = float(G.black_straddle(F, F, s ** 2))
    approx(x, 0.7979 * F * s, 0.02)


def test_put_call_parity():
    c = float(G.black_price(6000, 6050, 0.0004, True))
    p = float(G.black_price(6000, 6050, 0.0004, False))
    approx(c - p, 6000 - 6050, 1e-8)


def test_solve_total_var_roundtrip():
    K = np.array([5900.0, 6000.0, 6100.0])
    w = np.array([0.0002, 0.0005, 0.001])
    px = G.black_straddle(6000.0, K, w)
    got = G.solve_total_var(px, lambda x: G.black_straddle(6000.0, K, x))
    assert np.allclose(got, w, atol=1e-9)


def test_solve_below_intrinsic_is_nan():
    got = G.solve_total_var(np.array([40.0]), lambda x: G.black_price(6000.0, 5900.0, x, True))
    assert np.isnan(got[0])                                   # intrinsic is 100


def test_gamma_matches_finite_difference():
    F, K, w, h = 6000.0, 6020.0, 0.0004, 0.5
    fd = (G.black_price(F + h, K, w, True) - 2 * G.black_price(F, K, w, True) + G.black_price(F - h, K, w, True)) / h ** 2
    approx(float(G.black_gamma(F, K, w)), float(fd), 1e-6)


def test_zero_gamma():
    lv = [90.0, 100.0, 110.0, 120.0]
    approx(G.zero_gamma(lv, [-3.0, -1.0, 1.0, 3.0], 112.0), 105.0)
    assert np.isnan(G.zero_gamma(lv, [1.0, 2.0, 3.0, 4.0], 100.0))
    # two crossings: the nearer one to spot wins
    approx(G.zero_gamma([0.0, 10.0, 20.0, 30.0], [-1.0, 1.0, 1.0, -1.0], 22.0), 25.0)


def test_walls():
    s = pd.Series({5900.0: -5.0, 5950.0: -9.0, 6000.0: 2.0, 6050.0: 7.0, 6100.0: 3.0, 6150.0: -8.0})
    assert G.walls(s, 6010.0) == (6050.0, 5950.0)


def test_gex_sign():
    # All call OI gives positive GEX, all put OI negative, same size at the same strike
    base = pd.DataFrame({"F_ratio": [1.0], "K": [6000.0], "iv": [0.15], "T": [0.1], "net_oi": [1000.0]})
    up = G.gex_at(base, 6000.0)
    dn = G.gex_at(base.assign(net_oi=-1000.0), 6000.0)
    assert up > 0
    approx(up, -dn)


def test_expiry_iv_recovers_flat_vol():
    F, T, vol = 6000.0, 0.05, 0.2
    w = vol ** 2 * T
    rows = []
    for K in np.arange(5500.0, 6501.0, 50.0):
        for right, is_call in (("CALL", True), ("PUT", False)):
            m = float(G.black_price(F, K, w, is_call))
            rows.append({"strike": K, "right": right, "bid": m, "ask": m, "mid": m})
    F2, strikes, iv = G.expiry_iv(pd.DataFrame(rows), F, T)
    approx(F2, F, 1e-6)
    assert np.allclose(iv, vol, atol=1e-5)


if __name__ == "__main__":
    n = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
            n += 1
    print(n, "tests passed")
