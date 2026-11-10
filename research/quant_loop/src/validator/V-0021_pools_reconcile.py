"""V-0021-pools step 3: trade-by-trade reconciliation against the proposer's out/univ_diag_trades*.csv
(read only AFTER my report.txt was written).
The proposer's rows are the SELLER's view (phase-1 diagnosis). Buyer k0 = -seller k0 - 2 × stock cost:
  static: stock cost = 5bp·h0·(S0+S_T)/S0·100   (my own h0, S0, S_T)
  daily : stock cost = C/S0·100                   (proposer's own column C = hedge turnover cost per share)
Only k0 can be mirrored this way (seller pays -k·hs, buyer +k·hs from the same quote, so k0.5/k1 follow from hs).
Proposer rows are first restricted to the pool entry window. Output: V-0021_pools_tables/reconcile.txt
"""
import os
import numpy as np, pandas as pd
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
TD = os.path.join(HERE, "V-0021_pools_tables")
OUTP = os.path.join(HERE, "..", "..", "..", "call_spread_edge", "out")
spec = importlib.util.spec_from_file_location("bd", os.path.join(HERE, "V-0021_pools_build.py"))
bd = importlib.util.module_from_spec(spec); spec.loader.exec_module(bd)
t = pd.read_parquet(os.path.join(TD, "trades.parquet"))
t = t[t.tgt == 0.35]
L = []
for pool in bd.cc.POOLS:
    f = os.path.join(OUTP, "univ_diag_trades.csv" if pool == "20241031" else f"univ_diag_trades_{pool}.csv")
    o = pd.read_csv(f, usecols=["sym", "entry", "bucket", "exp", "right", "tgt", "K", "k", "hedge", "pnl_pct", "S0", "C"],
                    parse_dates=["entry", "exp"])
    o = o[(o.bucket == "3w") & (o.right == "C") & (o.tgt == 0.35) & (o.k == 0)]
    o = o[(o.entry >= pd.Timestamp(pool)) & (o.entry < bd.WEND[pool])]
    st = o[o.hedge == "static"].set_index(["sym", "entry"])
    dy = o[o.hedge == "daily"].set_index(["sym", "entry"])
    m = t[t.pool == pool].set_index(["sym", "entry"])
    only_me = m.index.difference(st.index); only_pr = st.index.difference(m.index)
    com = m.index.intersection(st.index)
    mm = m.loc[com]
    cost = 5e-4 * mm.h0 * (mm.S0 + mm.ST) / mm.S0 * 100
    ds = (mm["sta_k0"] - (-st.loc[com, "pnl_pct"] - 2 * cost)).abs()
    dK = int((mm.K != st.loc[com, "K"]).sum()); dE = int((mm.exp != st.loc[com, "exp"]).sum())
    comd = com.intersection(dy.index)
    dd = m.loc[comd, "dyn_k0"] - (-dy.loc[comd, "pnl_pct"] - 2 * dy.loc[comd, "C"] / dy.loc[comd, "S0"] * 100)
    L.append(f"== {pool}: mine {len(m)}, proposer (in window) {len(st)}, common {len(com)}; strike differs {dK}, expiry differs {dE}; "
             f"static k0 max|diff| {ds.max():.1e}; daily k0 |diff|>0.01pp {(dd.abs() > 0.01).sum()} (mean diff {dd.mean():+.4f}, max {dd.abs().max():.2f})")
    if len(only_me):
        L.append("   only mine: " + "; ".join(f"{s} {e.date()} (sta_k0.5 {m.loc[(s, e), 'sta_k0.5']:+.2f})" for s, e in only_me))
    if len(only_pr):
        L.append("   only proposer: " + "; ".join(f"{s} {e.date()}->{st.loc[(s, e), 'exp'].date()}" for s, e in only_pr))
    big = dd[dd.abs() > 0.01].sort_values()
    if len(big):
        L.append("   daily diffs: " + "; ".join(f"{s} {e.date()} {v:+.2f}" for (s, e), v in big.items()))
open(os.path.join(TD, "reconcile.txt"), "w").write("\n".join(L) + "\n")
print("\n".join(L))
