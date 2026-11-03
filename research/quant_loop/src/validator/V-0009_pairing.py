"""V-0009: why pairing moves the call-side gap; unpaired CIs. TRAINING PERIOD ONLY.
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0009_pairing.py
"""
import os
import numpy as np
import pandas as pd
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0009_tables")
WALL = pd.Timestamp("2024-11-01")
sp = pd.read_csv(f"{OUT}/spec_picks.csv", parse_dates=["date"]); sp = sp[sp.date < WALL]   # TIME WALL
c = pd.read_parquet(f"{OUT}/candidates.parquet"); c = c[c.date < WALL]                       # TIME WALL
rng = np.random.default_rng(90091)
L = []
def P(*a):
    s = " ".join(str(x) for x in a); print(s); L.append(s)
def diff_ci(x1, x0, n=5000):
    x1, x0 = np.asarray(x1), np.asarray(x0)
    b = x1[rng.integers(0, len(x1), (n, len(x1)))].mean(1) - x0[rng.integers(0, len(x0), (n, len(x0)))].mean(1)
    return round(x1.mean() - x0.mean(), 1), np.percentile(b, [2.5, 97.5]).round(1).tolist()
s = sp[~sp.fomc]
for side in ("C", "P"):
    a, b = s[(s.side == side) & (s.time == "14:00")], s[(s.side == side) & (s.time == "10:30")]
    P(side, "spec unpaired 14:00 - 10:30:", diff_ci(a.p20_min, b.p20_min), "n", len(a), len(b))
    only = b[~b.date.isin(a.date)]; both = b[b.date.isin(a.date)]
    P("   10:30 on days WITHOUT a 14:00 candidate: n", len(only), "pnl", round(only.p20_min.mean(), 1),
      "I_10:30 med", round(only.I.median(), 1), "settle-S_10:30 med", round((only.settle - only.S).median(), 1),
      "| with: n", len(both), "pnl", round(both.p20_min.mean(), 1), "I med", round(both.I.median(), 1),
      "settle-S med", round((both.settle - both.S).median(), 1))
ws = c[(c.side == "C") & (c.credit > 3) & (c.credit <= 4) & (c.dist >= -30) & (c.dist <= 80)]
P("WS口径 train 14:00 - 10:30 (trade-level, iid bootstrap):", diff_ci(ws[ws.time == "14:00"].p25_ws, ws[ws.time == "10:30"].p25_ws))
# published full-sample table (by_credit.csv, k .25): 10:30 n 1361 ev 17.168 ; 14:00 n 862 ev 37.734
for t, N, EV in (("10:30", 1361, 17.168), ("14:00", 862, 37.734)):
    g = ws[ws.time == t]; nt = N - len(g)
    P(f"inferred from published full-sample table minus train ({t}): rest n {nt} ev {(N*EV - len(g)*g.p25_ws.mean())/nt:.1f}")
open(f"{OUT}/pairing.txt", "w").write("\n".join(L) + "\n")

# decision-level comparison: every eligible day, no candidate = no trade = 0 USD (same day set for both times)
P("== per-eligible-day (no candidate -> 0), FOMC out, k .20 + min-leg; and unpaired D")
days = pd.Index(sorted(set(c[c.has_0dte & ~c.fomc].date)))
for side in ("C", "P"):
    v = {}
    for t in ("10:30", "14:00"):
        g = s[(s.side == side) & (s.time == t)].set_index("date").p20_min
        v[t] = g.reindex(days).fillna(0.0)
    dd = v["14:00"] - v["10:30"]
    b = dd.values[rng.integers(0, len(dd), (5000, len(dd)))].mean(1)
    yr = {y: round(x.mean(), 1) for y, x in dd.groupby(dd.index.year)}
    d1 = s[(s.side == side) & (s.time == "14:00")]; d0 = s[(s.side == side) & (s.time == "10:30")]
    dD = (d1.q_ramp - d1.ramp).mean() - (d0.q_ramp - d0.ramp).mean()
    P(side, "days", len(days), "per-day 14:00 - 10:30", round(dd.mean(), 1), np.percentile(b, [2.5, 97.5]).round(1).tolist(), "by year", yr,
      "| unpaired D", round(dD, 4))
open(f"{OUT}/pairing.txt", "w").write("\n".join(L) + "\n")
