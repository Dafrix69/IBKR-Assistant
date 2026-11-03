"""V-0009: I-tercile, prev-drop and monotonicity cells (gates 4, 6). TRAINING PERIOD ONLY.
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0009_cells.py
"""
import os
import numpy as np
import pandas as pd
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0009_tables")
WALL = pd.Timestamp("2024-11-01")
c = pd.read_parquet(f"{OUT}/candidates.parquet"); c = c[c.date < WALL]              # TIME WALL
sp = pd.read_csv(f"{OUT}/spec_picks.csv", parse_dates=["date"]); sp = sp[sp.date < WALL]  # TIME WALL
L = []
def P(*a):
    s = " ".join(str(x) for x in a); print(s); L.append(s)
s = sp[~sp.fomc]
def paired(side, t1):
    a = s[s.side == side]
    j = a[a.time == t1].set_index("date").join(a[a.time == "10:30"].set_index("date"), lsuffix="_1", rsuffix="_0", how="inner")
    j["dd"] = j.d_1 - j.d_0; j["pp"] = j.p20_min_1 - j.p20_min_0
    return j
# I at 10:30 per day: one value per date from the candidate table (all non-half train days with 0DTE)
i1030 = c[(c.time == "10:30") & c.has_0dte].drop_duplicates("date").set_index("date").I
c1, c2 = i1030.quantile([1/3, 2/3]); P("I_10:30 tercile cuts (all train 0DTE days incl FOMC)", round(c1, 2), round(c2, 2))
jc, jp = paired("C", "14:00"), paired("P", "14:00")
for nm, lo, hi in (("I_low", -1, c1), ("I_mid", c1, c2), ("I_high", c2, 1e9)):
    a = jc[(jc.I_0 > lo) & (jc.I_0 <= hi)]; b = jp[(jp.I_0 > lo) & (jp.I_0 <= hi)]
    P(nm, "n", len(a), len(b), "D_call", round(a.dd.mean(), 4), "D_put", round(b.dd.mean(), 4), "D_2", round((a.dd.mean() + b.dd.mean()) / 2, 4),
      "dPnL c/p", round(a.pp.mean(), 1), round(b.pp.mean(), 1))
a = jc[jc.spx_ret_prev_0 <= -0.01]; b = jp[jp.spx_ret_prev_0 <= -0.01]
P("prevdrop<=-1%", "n", len(a), len(b), "D_call", round(a.dd.mean(), 4), "D_put", round(b.dd.mean(), 4), "dPnL c/p", round(a.pp.mean(), 1), round(b.pp.mean(), 1))
for t in ("12:00", "13:00", "14:00"):
    a, b = paired("C", t), paired("P", t)
    P("mono", t, "n", len(a), len(b), "D_call", round(a.dd.mean(), 4), "D_put", round(b.dd.mean(), 4), "D_2", round((a.dd.mean() + b.dd.mean()) / 2, 4),
      "dPnL c/p", round(a.pp.mean(), 1), round(b.pp.mean(), 1))
open(f"{OUT}/cells.txt", "w").write("\n".join(L) + "\n")
