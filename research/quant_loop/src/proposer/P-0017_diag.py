"""P-0017 diag (written AFTER the judged cells were seen; report only).
Decomposes the bucket-hedged signed markout into: chain pre-drift, attached-vs-chain displacement at trade, post drift."""
import sys
import numpy as np
import pandas as pd
sys.path.insert(0, "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/proposer")
import importlib
A = importlib.import_module("P-0017_analyze")
SPLIT = pd.Timestamp("2025-11-01")

p = A.load("train")
p = p[p.date < SPLIT]                                            # time wall
p["bkey"] = p.struct + "|" + p.K.astype(str) + "|" + p.w.astype(str) + "|" + p.win.astype(str)
s = A.sign(p)
u = (p.ts - p.ts.dt.floor("min")).dt.total_seconds().values / 60
interp = p.pi_ch0 + u * (p.pi_1 - p.pi_ch0)                      # chain mid interpolated to the trade second
parts = {
    "pre  : pi_ch0 - pi_pre": (p.pi_ch0 - p.pi_pre).values,
    "disp : pi0 - pi_ch0 (attached vs chain minute)": (p.pi0 - p.pi_ch0).values,
    "dispI: pi0 - chain interp to trade second": (p.pi0 - interp).values,
    "trade vs chain interp (E_chain, unhedged sign)": (p.pi_trade - interp).values,
    "post : pi_5 - pi_ch0": (p.pi_5 - p.pi_ch0).values,
    "post : pi_5 - interp": (p.pi_5 - interp).values,
    "post : pi_15 - interp": (p.pi_15 - interp).values,
    "total: pi_5 - pi0 (= I_5)": (p.pi_5 - p.pi0).values,
}
for k, y in parts.items():
    A.summ(A.day_values(p, y, s), k, ci=False)
# displacement by size of |dev|
for lo, hi in ((0.05, 0.10), (0.10, 0.20), (0.20, 9)):
    m = ((np.abs(p.dev) >= lo - 1e-9) & (np.abs(p.dev) < hi - 1e-9)).values
    A.summ(A.day_values(p[m], (p.pi0 - interp).values[m], s[m]), f"dispI |dev| in [{lo},{hi})", ci=False)
    A.summ(A.day_values(p[m], (p.pi_5 - interp).values[m], s[m]), f"post5-interp |dev| in [{lo},{hi})", ci=False)
# unsigned-print check: is the attached mid of exact-mid prints also off the chain?
m0 = np.abs(p.dev) < 1e-9
d0 = (p.pi0 - interp)[m0] * 100
print(f"exact-mid prints: |pi0 - interp| mean {np.nanmean(np.abs(d0)):.2f} USD; signed prints: "
      f"{np.nanmean(np.abs((p.pi0 - interp)[s != 0] * 100)):.2f}")
# CIs for the reference-independent post-trade drift (start = chain mid interpolated to the trade second)
for tau in (1, 5, 15):
    y = (p[f"pi_{tau}"] - interp).values if tau > 1 else (p.pi_1 - interp).values
    A.summ(A.day_values(p, y, s), f"CI post{tau} - interp", ci=True)
# systematic offset? unsigned, all prints, pi0 - interp (USD)
d = ((p.pi0 - interp) * 100).dropna()
print(f"ALL prints pi0 - interp: mean {d.mean():+.2f} median {d.median():+.2f} |mean| {d.abs().mean():.2f} USD; "
      f"by struct mean: {((p.pi0 - interp) * 100).groupby(p.struct).mean().round(2).to_dict()}")
for k, m in (("s=+1", s == 1), ("s=-1", s == -1), ("mid", s == 0)):
    print(f"  {k}: pi0-interp mean {np.nanmean((p.pi0 - interp)[m] * 100):+.2f}  trade-interp mean {np.nanmean((p.pi_trade - interp)[m] * 100):+.2f}")
