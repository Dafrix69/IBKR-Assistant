"""V-0028/0029 POST-HOC, REPORT-ONLY diagnostics on the trades written by the one-shot test (no rule re-run, no new
A-hist extraction). Not part of any PASS criterion."""
import os, numpy as np, pandas as pd
CA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0028_cache")
h1 = pd.read_parquet(os.path.join(CA, "test_h1.parquet")); h2 = pd.read_parquet(os.path.join(CA, "test_h2.parquet"))
print("2021-01-27 H1 k0.5:", round(h1.loc["2021-01-27", "k0.5"], 1), "| in H2:", pd.Timestamp("2021-01-27") in h2.index)
for lab, t, thr in (("H1 iron", h1, 2.0), ("H2", h2, 1.0)):
    keep = t[t.SH <= thr]
    print(f"{lab}: drop days with sum of half-spreads > {thr} pts: dropped {len(t) - len(keep)}; k0 {keep['k0.0'].mean():+.1f}, k0.5 {keep['k0.5'].mean():+.1f} (n {len(keep)})")
# H2: how much of the k0 loss does the sample-mean afternoon drift explain?  settle shifted by -mean drift
dr = (h2.settle - h2.spot).mean()
for shift_lab, sh in (("raw", 0.0), (f"settle - mean drift ({dr:+.2f})", dr)):
    s = h2.settle - sh
    k0 = ((h2.credit - np.clip(s - h2.K, 0, 15)) * 100 - h2.fee).mean()
    print(f"H2 k0 with {shift_lab}: {k0:+.1f}")
# H2 by year: drift vs loss
g = h2.assign(y=h2.index.year, drift=h2.settle - h2.spot, cr=h2.credit / 15, loss=np.clip(h2.settle - h2.K, 0, 15) / 15)
print(g.groupby("y")[["drift", "cr", "loss", "k0.5"]].mean().round(3).to_string())
# H1 by year mechanism
r = h1.assign(y=h1.index.year, cw=h1.credit / h1.w, pay=np.minimum((h1.settle - h1.K).abs(), h1.w) / h1.w)
print(r.groupby("y")[["I", "cw", "pay", "k0.0", "k0.5"]].mean().round(3).to_string())
# H1 by I tercile (A-hist own cuts, descriptive)
r["It"] = pd.qcut(r.I, 3, labels=["low", "mid", "high"])
print(r.groupby("It", observed=True).agg(n=("k0.5", "size"), I=("I", "median"), cw=("cw", "mean"), pay=("pay", "mean"), k0=("k0.0", "mean"), k05=("k0.5", "mean")).round(3).to_string())
