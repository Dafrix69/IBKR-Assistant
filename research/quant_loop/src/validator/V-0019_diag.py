"""V-0019 post-hoc diagnostic (validator, report only): own Pi NBBO mid - chain row m for combo prints in the first
0.5 s of the minute (chain row m ~ that half second, V-0015), per period. USD/package, day-level 10% trimmed."""
import os
import numpy as np
import pandas as pd
from scipy.stats import trim_mean
T = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0019_tables")
for which, lo, hi in (("train", "2024-10-30", "2025-11-01"), ("test", "2025-11-01", "2026-10-30")):
    p = pd.read_parquet(os.path.join(T, f"combos_{which}.parquet"))
    p = p[(p.date >= lo) & (p.date < hi)]                              # time wall
    hm = p.ts.dt.hour * 60 + p.ts.dt.minute
    p = p[(hm >= 585) & (hm < 930) & ((p.K - p.S).abs() <= 5) & (p.w >= 15) & (p.w < 80) & p.ch0.notna()]
    e = p[p.u * 60 < 0.5].assign(v=lambda x: (x.own - x.ch0) * 100, d=lambda x: (x.trade - x.ch0) * 100)
    for c in ("v", "d"):
        dv = e.groupby("date")[c].apply(lambda x: trim_mean(x.values, 0.1))
        print(which, {"v": "own - chain m (t<m+0.5s)", "d": "px - chain m (t<m+0.5s)"}[c], f"{trim_mean(dv.values, 0.1):+.2f}", "n", len(e), "days", len(dv))
