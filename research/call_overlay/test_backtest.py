"""Known-answer checks. Run: ../spx_fly/.venv/bin/python test_backtest.py"""
import numpy as np, pandas as pd
import backtest as b

# 1. delta recovered from a BS price equals the BS delta (S=100, K=105, T=4d, sigma=80%)
S, T, sig = 100.0, 4 / 365, 0.8
K = np.array([95.0, 100.0, 105.0, 110.0])
px = b.bs_call(S, K, T, sig)
d1 = (np.log(S / K) + (b.R + 0.5 * sig**2) * T) / (sig * np.sqrt(T))
want = b._ncdf(d1)
got = b.call_delta(S, K, T, px)
assert np.allclose(got, want, atol=1e-4), (got, want)

# 2. variant A picks the strike nearest 0.25 delta and the first long strike >= Ks + 5% S
strikes = np.arange(90, 131, 1.0)
mid = b.bs_call(S, strikes, T, sig)
chain = pd.DataFrame(dict(strike=strikes, bid=mid - 0.05, ask=mid + 0.05)).clip(lower=0)
s, l = b.pick(chain, S, T, "A", 0.05)
dl = b.call_delta(S, strikes, T, mid)
assert s.strike == strikes[np.argmin(np.abs(np.where((dl >= .2) & (dl <= .3), dl, 9) - 0.25))]
assert l.strike == s.strike + 5

# 3. variant B never picks an ITM short
s, l = b.pick(chain, S, T, "B", 0.05)
assert s.strike >= S

# 4. take profit: credit 1.00 at k=0; spread mid falls to 0.20 on day 2 -> closed at the 0.25 limit, P&L 75 - 4*0.65
days = pd.to_datetime(["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-09"])
exp = days[-1]
mids = {days[0]: (2.0, 1.0), days[1]: (1.5, 0.9), days[2]: (0.5, 0.3)}  # (short, long) mids
rows = [dict(date=d, exp=exp, strike=K, bid=m, ask=m, S=100.0) for d, (ms, ml) in mids.items() for K, m in ((100.0, ms), (105.0, ml))]
df = pd.DataFrame(rows)
spot = pd.Series([100.0, 100.0, 100.0, 100.0], index=days)
orig = b.pick
b.pick = lambda chain, S, T, v, w: tuple(chain[chain.strike == K].assign(mid=lambda x: (x.bid + x.ask) / 2, delta=0.25).iloc[0] for K in (100.0, 105.0))
tr, _ = b.simulate("X", df, spot, "A", 0.05, 0.0, None, 2.0, tp=0.75)
assert len(tr) == 1 and tr[0]["reason"] == "take_profit" and tr[0]["exit"] == days[2].date(), tr
assert abs(tr[0]["pnl"] - (75 - 4 * 0.65)) < 1e-9, tr[0]["pnl"]
tr, _ = b.simulate("X", df, spot, "A", 0.05, 0.0, None, 2.0)  # no tp -> held to expiry, S=100 -> worthless
assert tr[0]["reason"] == "expiry" and abs(tr[0]["pnl"] - (100 - 2 * 0.65)) < 1e-9, tr
b.pick = orig
print("ok")
