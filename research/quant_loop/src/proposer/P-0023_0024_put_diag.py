"""Descriptive follow-up (after the pre-registered main cells were seen): why Q5 puts look rich.
Put-call IV gap (implied borrow proxy) by quintile and the per-stock-cycle call+put sum (= delta-hedged
short straddle, net hedge). Training only: entry and exit < 2023-10-31 (first step after reading)."""
import os, sys, runpy
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__))
WALL = pd.Timestamp("2023-10-31")
S = runpy.run_path(os.path.join(HERE, "P-0023_0024_stats.py"), run_name="lib")
T = S["T"]; T = T[(T["E"] < WALL) & (T["M"] < WALL)]
T = T.copy(); T["wk"] = S["week"](T["E"])
weeks_all = pd.date_range(T["wk"].min(), T["wk"].max(), freq="7D"); idx = S["boot_idx"](len(weeks_all))
for sig in ("ivol", "vov"):
    Q = S["assign"](T, sig, 5)
    c = Q[(Q.right == "C") & (Q.status == "ok")].set_index(["pool", "M", "sym"])
    p = Q[(Q.right == "P") & (Q.status == "ok")].set_index(["pool", "M", "sym"])
    j = c.join(p[["pnl_k0", "pnl_k05", "pnl_k1", "iv0", "K", "delta0"]], rsuffix="_p", how="inner")
    j["gap"] = j["iv0_p"] - j["iv0"]
    j["str_k05"] = j["pnl_k05"] + j["pnl_k05_p"]; j["str_k0"] = j["pnl_k0"] + j["pnl_k0_p"]; j["str_k1"] = j["pnl_k1"] + j["pnl_k1_p"]
    j = j.reset_index()
    print(f"== {sig}: put IV - call IV at entry (same cycle, nearest-ATM strikes), and short straddle = call + put ==")
    for qq in range(1, 6):
        g = j[j.q == qq]
        d = g.rename(columns={"str_k05": "x"}); ci, pv = S["boot_ci"](d, "x", weeks_all, idx)
        print(f"  Q{qq}: n {len(g):3d} median IV gap {g.gap.median():+.3f} (mean {g.gap.mean():+.3f}) | call k0.5 {g.pnl_k05.mean():+.3f} put k0.5 {g.pnl_k05_p.mean():+.3f} "
              f"| straddle k0 {g.str_k0.mean():+.3f} k0.5 {g.str_k05.mean():+.3f} [{ci[0]:+.2f},{ci[1]:+.2f}] k1 {g.str_k1.mean():+.3f} med {g.str_k05.median():+.3f}")
    g = j[j.q == 5]
    print("  Q5 straddle k0.5 by pool: " + " ".join(f"{k}:{v:+.2f}(n{n})" for (k, v), n in zip(g.groupby('pool').str_k05.mean().items(), g.groupby('pool').size())))
    print(f"  corr(put k0.5, IV gap) all quintiles {j.pnl_k05_p.corr(j.gap):+.2f}; Q5 put k0.5 when gap<=median {g[g.gap<=g.gap.median()].pnl_k05_p.mean():+.3f} vs > median {g[g.gap>g.gap.median()].pnl_k05_p.mean():+.3f}")
