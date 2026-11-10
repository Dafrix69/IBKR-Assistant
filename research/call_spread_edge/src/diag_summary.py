"""Run: ../spx_fly/.venv/bin/python src/diag_summary.py > out/diag_summary.txt"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stats import block_boot_ci, trimmed
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PERIOD_END = pd.Timestamp("2025-11-01")
t = pd.read_csv(os.path.join(HERE, "out", "diag_trades.csv"), parse_dates=["entry", "exp"])
t = t[t.exp < PERIOD_END]
pd.set_option("display.width", 250, "display.max_columns", 30, "display.float_format", "{:.3f}".format)
rows = []
for key, g in t.groupby(["bucket", "right", "tgt", "hedge", "k"]):
    wk = g.groupby("entry").pnl_pct.mean().sort_index()
    lo, hi = block_boot_ci(wk.values)
    h1 = g[g.entry < "2025-05-01"].pnl_pct.mean(); h2 = g[g.entry >= "2025-05-01"].pnl_pct.mean()
    bysym = g.groupby("sym").pnl_pct.mean()
    rows.append(dict(zip(["bucket", "right", "tgt", "hedge", "k"], key), n=len(g), mean=g.pnl_pct.mean(), lo=lo, hi=hi,
                     median=g.pnl_pct.median(), trim=trimmed(g.pnl_pct), prem_mean=g.pnl_prem.mean(), prem_med=g.pnl_prem.median(),
                     h1=h1, h2=h2, pos_syms=int((bysym > 0).sum()), n_syms=len(bysym),
                     iv_minus_rv=(g.iv - g.rv_fwd).median(), hs_over_mid=(g.hs / g.mid).median()))
s = pd.DataFrame(rows)
s.to_csv(os.path.join(HERE, "out", "diag_cells.csv"), index=False)
print("pnl_pct = P&L of SHORT 1 option per 1 share of notional, % of S0; positive = selling earns. Training period only.\n")
for hedge in ("daily", "static", "none"):
    for k in (0.0, 0.5):
        print(f"== hedge={hedge} k={k} ==")
        print(s[(s.hedge == hedge) & (s.k == k)].drop(columns=["hedge", "k"]).to_string(index=False)); print()
