"""V-0022-pools: own scan for splits / contract adjustments / data defects (before any trade P&L is computed).
Flags per (pool, sym, day): |close jump| > 35% vs previous file; min put strike-retention over common expiries < 0.5;
close <= 0; close not unique in file; symbol name change; parity close off the file close by > 10%.
Run: research/spx_fly/.venv/bin/python src/validator/P-0022_pools_scan.py  -> P-0022_pools_cache/scan_flags.csv (git-ignored: contains daily closes)
"""
import os, sys
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from importlib import import_module
pc = import_module("P-0022_pools_cache")

rows = []
for pool in pc.POOLS:
    for sym in pc.universe(pool):
        c = pd.read_parquet(os.path.join(pc.OUT, pool, f"{sym}_check.parquet")).sort_values("date").reset_index(drop=True)
        c = c[c.rows > 0].reset_index(drop=True)
        s = c.S.where(c.S > 0, c.S_par)
        jump = s / s.shift() - 1
        prev_names = c.names.shift()
        for i, r in c.iterrows():
            why = []
            if i > 0 and abs(jump[i]) > 0.35: why.append(f"jump {jump[i]:+.0%}")
            if r.get("kept", 1) < 0.5: why.append(f"kept {r.kept:.2f} (w {r.kept_w:.2f}, n {r.n_common:.0f})")
            if r.S <= 0 or r.up_min <= 0: why.append(f"close<=0 (min {r.up_min}, par {r.S_par:.2f})")
            if r.up_n > 1: why.append(f"close not unique ({r.up_n}: {r.up_min}..{r.up_max})")
            if i > 0 and r.names != prev_names[i]: why.append(f"name {prev_names[i]} -> {r.names}")
            if r.S > 0 and np.isfinite(r.S_par) and abs(r.S_par / r.S - 1) > 0.10: why.append(f"parity {r.S_par:.2f} vs {r.S:.2f}")
            if why:
                rows.append(dict(pool=pool, sym=sym, date=r.date.date(), prev=c.date[i - 1].date() if i else None,
                                 S_prev=round(float(s[i - 1]), 3) if i else None, S=round(float(r.S), 3),
                                 kept=round(float(r.get("kept", np.nan)), 2), why="; ".join(why)))
f = pd.DataFrame(rows)
f.to_csv(os.path.join(pc.OUT, "scan_flags.csv"), index=False)
pd.set_option("display.width", 250); pd.set_option("display.max_colwidth", 90)
print(f.to_string())
