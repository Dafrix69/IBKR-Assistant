"""Black–Scholes helpers (no dividends). Vectorised IV by bisection on the mid."""
import numpy as np
from scipy.special import ndtr

R = 0.043


def price(S, K, T, sig, call):
    S, K, T, sig = map(lambda x: np.asarray(x, float), (S, K, T, sig))
    v = sig * np.sqrt(T)
    d1 = (np.log(S / K) + (R + 0.5 * sig ** 2) * T) / v
    d2 = d1 - v
    c = S * ndtr(d1) - K * np.exp(-R * T) * ndtr(d2)
    return np.where(call, c, c - S + K * np.exp(-R * T))


def delta(S, K, T, sig, call):
    S, K, T, sig = map(lambda x: np.asarray(x, float), (S, K, T, sig))
    d1 = (np.log(S / K) + (R + 0.5 * sig ** 2) * T) / (sig * np.sqrt(T))
    return np.where(call, ndtr(d1), ndtr(d1) - 1.0)


def iv(S, K, T, px, call, lo=0.01, hi=10.0, n=60):
    """NaN where px is outside (intrinsic, upper bound) — unpriceable quote."""
    S, K, T, px = map(lambda x: np.asarray(x, float), (S, K, T, px))
    call = np.asarray(call, bool)
    a = np.full(px.shape, lo); b = np.full(px.shape, hi)
    for _ in range(n):
        m = 0.5 * (a + b)
        over = price(S, K, T, m, call) > px
        b = np.where(over, m, b); a = np.where(over, a, m)
    sig = 0.5 * (a + b)
    ok = (price(S, K, T, lo, call) < px) & (price(S, K, T, hi, call) > px)
    return np.where(ok, sig, np.nan)
