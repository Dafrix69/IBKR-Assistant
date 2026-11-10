import numpy as np, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bs
S, T = 100.0, 20 / 365
K = np.array([80, 95, 100, 105, 130.0])
for call in (True, False):
    p = bs.price(S, K, T, 0.9, call)
    assert np.allclose(bs.iv(S, K, T, p, call), 0.9, atol=1e-6)
# put-call parity and delta relation
c, p = bs.price(S, K, T, .5, True), bs.price(S, K, T, .5, False)
assert np.allclose(c - p, S - K * np.exp(-bs.R * T))
assert np.allclose(bs.delta(S, K, T, .5, True) - bs.delta(S, K, T, .5, False), 1)
# a hedged short call under exactly BS dynamics with sigma_real = sigma_impl has ~zero mean P&L (Monte Carlo)
rng = np.random.default_rng(0); n, steps = 4000, 20; sig = 0.8; dt = T / steps; K0 = 105.0
Z = rng.standard_normal((n, steps)); Sp = S * np.exp(np.cumsum((bs.R - .5 * sig**2) * dt + sig * np.sqrt(dt) * Z, 1)); Sp = np.c_[np.full(n, S), Sp]
Ts = T - dt * np.arange(steps)
h = bs.delta(Sp[:, :-1], K0, Ts, sig, True)
prem = bs.price(S, K0, T, sig, True)
# financing: premium earns R, the hedge shares are bought with borrowed cash at R (same as diag.py)
pnl = prem * (1 + bs.R * T) - np.maximum(Sp[:, -1] - K0, 0) + np.sum(h * (np.diff(Sp, axis=1) - bs.R * Sp[:, :-1] * dt), 1)
se = pnl.std() / np.sqrt(n)
assert abs(pnl.mean()) < 3 * se and pnl.std() < 1.8, (pnl.mean(), se, pnl.std())
print("ok", round(pnl.mean(), 4), round(pnl.std(), 3))
