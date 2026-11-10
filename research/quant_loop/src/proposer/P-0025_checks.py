"""Data checks required by PROTOCOL (B-pools): >35% day jumps + strike-grid replacement,
whole-grid shifts (special dividends: off-0.5-grid strikes appear), zero closes.
Plus signal coverage / membership diagnostics (no holding-period returns)."""
import os
import numpy as np
import pandas as pd

CUTOFF = pd.Timestamp("2023-10-31")
HERE = os.path.dirname(os.path.abspath(__file__))
d = pd.read_parquet(os.path.join(HERE, "P-0025_cache", "daily.parquet"))
d = d[d.date < CUTOFF]  # time wall: first statement after reading
d = d.sort_values(["pool", "sym", "date"])
known = pd.read_csv(os.path.join(HERE, "..", "..", "data", "pools_defects.csv"), dtype={"pool": str})

print("zero / missing close rows:")
z = d[~(d.px > 0)]
print(z[["pool", "sym", "date", "nstrk"]].to_string())

g = d.groupby(["pool", "sym"])
d["lr"] = np.log(d.px / g.px.shift(1))
d["gap"] = (d.date - g.date.shift(1)).dt.days
d["off_prev"] = g.offgrid.shift(1)
flag = d[(d.lr.abs() > np.log(1.35)) | (d.kept < 0.6) | ((d.offgrid - d.off_prev) > 0.2)]
print("\nflags (|jump|>35%, grid kept<0.6, off-grid share +0.2):")
print(flag[["pool", "sym", "date", "px", "lr", "gap", "kept", "offgrid", "off_prev", "nstrk"]].to_string())
print("\nknown defects (training pools):")
print(known[known.pool < "2023"].to_string())

print("\ncoverage by pool:")
print(d.groupby("pool").agg(rows=("sym", "size"), vs=("vs", lambda x: x.notna().mean()),
                            vs_n=("vs_n", "median"), c21=("c21", lambda x: x.notna().mean()),
                            p21=("p21", lambda x: x.notna().mean())).to_string())
print("\nsignal distribution:")
print(d[["vs", "c21", "p21"]].describe().to_string())
