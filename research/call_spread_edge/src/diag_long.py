"""Training period: the LONG side of the cells where short options lost most, with long-side costs
(buy at mid + k*half-spread, hedge cost paid again). Run: ../spx_fly/.venv/bin/python src/diag_long.py > out/diag_long.txt"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stats import block_boot_ci, trimmed
import bs
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PERIOD_END = pd.Timestamp("2025-11-01")
t = pd.read_csv(os.path.join(HERE, "out", "diag_trades.csv"), parse_dates=["entry", "exp"])
t = t[(t.exp < PERIOD_END) & (t.k == 0.0)]
for k in (0.0, 0.5, 1.0):
    t[f"long_k{k:g}"] = (t.payoff - (t.mid + k * t.hs) * (1 + bs.R * t.T0) - t.H - t.C) / t.S0 * 100
t["term"] = t.atm_iv / t.next_atm_iv


def show(name, g):
    print(f"== {name}  (n={len(g)}) ==")
    for k in (0.0, 0.5, 1.0):
        c = f"long_k{k:g}"
        wk = g.groupby("entry")[c].mean().sort_index(); lo, hi = block_boot_ci(wk.values, n=2000)
        h1 = g[g.entry < "2025-05-01"][c].mean(); h2 = g[g.entry >= "2025-05-01"][c].mean()
        bys = g.groupby("sym")[c].mean()
        print(f"  k={k}: mean {g[c].mean():+.3f} [{lo:+.2f},{hi:+.2f}] med {g[c].median():+.3f} trim2% {trimmed(g[c]):+.3f} "
              f"h1 {h1:+.3f} h2 {h2:+.3f} syms+ {(bys > 0).sum()}/{len(bys)}")
    bys = g.groupby("sym")["long_k0.5"].agg(["count", "mean", "sum"]).sort_values("sum")
    print("  by sym (k=0.5):", ", ".join(f"{s} {r['sum']:+.0f}" for s, r in bys.iterrows()))
    top = g.nlargest(5, "long_k0.5")[["sym", "entry", "tgt", "long_k0.5"]]
    tot = g["long_k0.5"].sum()
    print(f"  total {tot:+.1f}; top-5 trades sum {top['long_k0.5'].sum():+.1f}:", top.to_dict("records"))


for hedge in ("daily", "static"):
    d = t[t.hedge == hedge]
    show(f"{hedge}: long 3w calls 0.25/0.35", d[(d.bucket == "3w") & (d.right == "C") & d.tgt.isin([0.25, 0.35])])
    show(f"{hedge}: long weekly calls 0.15–0.35 when term > 1.126 (front richer)",
         d[(d.bucket == "wk") & (d.right == "C") & d.tgt.isin([0.15, 0.25, 0.35]) & (d.term > 1.126)])
    show(f"{hedge}: long weekly ATM call+put (straddle legs) when term > 1.126",
         d[(d.bucket == "wk") & (d.tgt.abs() == 0.5) & (d.term > 1.126)])
    show(f"{hedge}: long weekly ATM call+put, all weeks", d[(d.bucket == "wk") & (d.tgt.abs() == 0.5)])
    show(f"{hedge}: long 3w ATM call+put, all weeks", d[(d.bucket == "3w") & (d.tgt.abs() == 0.5)])
