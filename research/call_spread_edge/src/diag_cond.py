"""Training-period conditioning of hedged short-option P&L. Exploration only; every split printed counts as a variant.
Run: ../spx_fly/.venv/bin/python src/diag_cond.py > out/diag_cond.txt"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stats import block_boot_ci, trimmed
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PERIOD_END = pd.Timestamp("2025-11-01")
t = pd.read_csv(os.path.join(HERE, "out", "diag_trades.csv"), parse_dates=["entry", "exp"])
t = t[t.exp < PERIOD_END]
t = t[t.hedge == "daily"]
t["ivrv"] = t.atm_iv / t.rv20
t["term"] = t.atm_iv / t.next_atm_iv          # >1: front month richer (event inside the front expiry)
t["ivfwd"] = t.iv - t.rv_fwd                  # ex post, for interpretation only — never a signal
VARS = ["ivrv", "term", "skew25", "ret5", "atm_iv"]
NV = 0
for bucket in ("wk", "3w"):
    for right, tg in (("C", [0.15, 0.25, 0.35]), ("P", [-0.25, -0.10])):
        g0 = t[(t.bucket == bucket) & (t.right == right) & (t.tgt.isin(tg))]
        for v in VARS:
            g = g0.dropna(subset=[v]).copy()
            # tercile cut points from the pooled training sample (fixed numbers, written out)
            q = g.drop_duplicates(["sym", "entry"])[v].quantile([1 / 3, 2 / 3]).values
            g["bin"] = np.digitize(g[v], q)
            print(f"-- {bucket} {right} {tg} by {v} (cuts {q[0]:.3f}, {q[1]:.3f}) --")
            for k in (0.0, 0.5):
                gk = g[g.k == k]
                line = []
                for b in range(3):
                    gb = gk[gk.bin == b]
                    wk = gb.groupby("entry").pnl_pct.mean().sort_index()
                    lo, hi = block_boot_ci(wk.values, n=2000)
                    line.append(f"T{b+1}: n {len(gb):4d} mean {gb.pnl_pct.mean():+.3f} [{lo:+.2f},{hi:+.2f}] med {gb.pnl_pct.median():+.3f} trim {trimmed(gb.pnl_pct):+.3f} syms+ {(gb.groupby('sym').pnl_pct.mean() > 0).sum():2d}")
                    NV += 1
                print(f"  k={k}: " + " | ".join(line))
print(f"\nvariants printed (cells): {NV}")
