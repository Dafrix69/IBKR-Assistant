"""P-0012 post-hoc report item (written after the main analysis): m-controlled PNT effect on M by year. TRAINING ONLY."""
import os
import numpy as np
import pandas as pd
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0012_tables")
df = pd.read_csv(f"{OUT}/days.csv", parse_dates=["date"])
df = df[df.date < pd.Timestamp("2024-11-01")]          # TIME WALL
df = df[df.ok.fillna(False).astype(bool) & ~df.event].copy()
df["M"] = (df.V10 - df.V1400) / df.I10
df["m"] = (df.S14 - df.S10).abs() / df.I10
for y in (2022, 2023, 2024):
    g = df[df.date.dt.year == y]
    X = np.column_stack([np.ones(len(g)), g.m, g.pnt.astype(float)])
    b, *_ = np.linalg.lstsq(X, g.M.values, rcond=None)
    e = g.M.values - X @ b; XtXi = np.linalg.inv(X.T @ X)
    se = np.sqrt(np.diag(XtXi @ (X.T * e**2) @ X @ XtXi))
    print(y, len(g), f"PNT coef {b[2]:+.4f} se {se[2]:.4f}; m mean PNT {g[g.pnt].m.mean():.3f} C {g[~g.pnt].m.mean():.3f}")
