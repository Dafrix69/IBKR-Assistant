"""P-0010 post-hoc decomposition of the pre-declared structure (not a variant). TRAINING PERIOD ONLY.
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0010_decomp.py
"""
import os
import numpy as np
import pandas as pd
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0010_tables")
TRAIN_END = pd.Timestamp("2024-11-01")
r = pd.read_csv(f"{OUT}/nights.csv", parse_dates=["D", "N"])
r = r[(r.D < TRAIN_END) & (r.N < TRAIN_END)]           # TIME WALL
r = r[(~r.half) & (r.skip.isna() | (r.skip == "")) & r.x_day.notna()].copy()
r["wk"] = r.nights >= 2
# overnight-segment ratio: realized |S0 - F| vs implied overnight straddle-equivalent
r["imp_on"] = np.sqrt(np.clip((r.I / r.F) ** 2 - (r.I0 / r.S0) ** 2, 0, None)) * r.F
r["x_on"] = (r.S0 - r.F).abs() / r.imp_on
# short straddle at mid vs wings
r["strad_mid"] = (r.I - (r.settle - r.K).abs()) * 100
r["wing_net"] = r.pnl_k0 + r.fees_k0 - r.strad_mid          # = -(wing cost) + wing payback, at mid, before fees
lines = []
for name, g in [("all", r), ("1-night", r[~r.wk]), ("weekend", r[r.wk])]:
    h = g[g.imp_on > 0]
    s = (f"{name}: n {len(g)} (imp_on>0: {len(h)}) x_on(mean|S0-F|/mean imp_on) {(h.S0 - h.F).abs().mean() / h.imp_on.mean():.3f} "
         f"median x_on {h.x_on.median():.3f} | short straddle mid $ {g.strad_mid.mean():.1f} wings net $ {g.wing_net.mean():.1f} "
         f"fees $ {g.fees_k0.mean():.1f} pnl_k0 {g.pnl_k0.mean():.1f} pnl_k0.2 {g.pnl.mean():.1f}")
    print(s); lines.append(s)
dow = r.D.dt.day_of_week
s = f"x_day: weekend(Mon session) {r[r.wk].x_day.mean():.3f} sd {r[r.wk].x_day.std():.3f} n {r.wk.sum()} | 1-night {r[~r.wk].x_day.mean():.3f} sd {r[~r.wk].x_day.std():.3f}"
print(s); lines.append(s)
open(f"{OUT}/decomp.txt", "w").write("\n".join(lines) + "\n")
