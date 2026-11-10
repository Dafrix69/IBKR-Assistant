"""P-0019 review: sensitivity of gate 4 (|F| < D/4), composition of D_own, and decay, from the validator's stored
per-print table (V-0019_tables/combos_{train,test}.parquet; its test rows are checked against the raw tape on 10 days
by P-0019_spotcheck.py). No raw data is read here.

    research/spx_fly/.venv/bin/python research/quant_loop/src/reviewer/P-0019_gate4.py
"""
import os
import numpy as np
import pandas as pd
from scipy.stats import trim_mean

T = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/validator/V-0019_tables"
WIN = {"train": ("2024-10-30", "2025-11-01"), "test": ("2025-11-01", "2026-10-30")}


def load(which):
    lo, hi = map(pd.Timestamp, WIN[which])
    p = pd.read_parquet(os.path.join(T, f"combos_{which}.parquet"))
    p = p[(p.date >= lo) & (p.date < hi)]
    hm = p.ts.dt.hour * 60 + p.ts.dt.minute
    p = p[(hm >= 585) & (hm < 930) & (p.w >= 15) & (p.w < 80) & ((p.K - p.S).abs() <= 5) & p.ch0.notna() & p.ch1.notna()].copy()
    p["hm"] = hm
    ref = (1 - p.u) * p.ch0 + p.u * p.ch1
    p["D"] = (p.trade - ref) * 100
    p["D_own"] = (p.trade - p.own) * 100
    p["F"] = (p.own - ref) * 100
    p["Hown"] = (p.pia - p.pib) / 2 * 100
    return p


def two(p, col, t_in, t_out):
    f = (lambda x: np.median(x)) if t_in == "med" else (lambda x: trim_mean(x, t_in))
    g = (lambda x: np.median(x)) if t_out == "med" else (lambda x: trim_mean(x, t_out))
    return g(p.groupby("date")[col].apply(lambda x: f(x.values)).values)


te, tr = load("test"), load("train")
print("== gate 4 under other trims (test). spec = 10% within day and 10% across days ==")
print("within-day / across-day      D      F   D_own   |F|/D   gate4")
for ti, to in ((0.10, 0.10), (0.05, 0.05), (0.20, 0.20), (0.025, 0.025), (0.0, 0.0), (0.0, 0.10), (0.10, 0.0), (0.05, 0.10),
               (0.10, 0.05), (0.01, 0.01), ("med", "med"), ("med", 0.10)):
    D, F, Do = two(te, "D", ti, to), two(te, "F", ti, to), two(te, "D_own", ti, to)
    r = abs(F) / D if D else np.nan
    print(f"{str(ti):>6s} / {str(to):<6s}        {D:+6.2f} {F:+6.2f} {Do:+6.2f}   {r:5.3f}   {'pass' if r < 0.25 else 'FAIL'}")

print("\n== gate 4 by sub-period (test, spec trim) ==")
te["ym"] = te.date.dt.to_period("M")
for nm, sub in [("seg1 2025-11..2026-04", te[te.date < "2026-05-01"]), ("seg2 2026-05..", te[te.date >= "2026-05-01"]),
                ("2025-11..12", te[te.date < "2026-01-01"]), ("2026", te[te.date >= "2026-01-01"])]:
    D, F = two(sub, "D", .1, .1), two(sub, "F", .1, .1)
    print(f"{nm:24s} D {D:+.2f} F {F:+.2f} |F|/D {abs(F) / D:.3f} {'pass' if abs(F) / D < .25 else 'FAIL'}")
print("by month: ym, days, D, F, D_own, |F|/D")
nfail = 0
for ym, sub in te.groupby("ym"):
    D, F, Do = two(sub, "D", .1, .1), two(sub, "F", .1, .1), two(sub, "D_own", .1, .1)
    nfail += abs(F) / D >= .25
    print(f"  {ym} {sub.date.nunique():3d} {D:+.2f} {F:+.2f} {Do:+.2f} {abs(F) / D:.3f}")
print(f"months with |F|/D >= 1/4: {nfail} of {te.ym.nunique()}")

print("\n== gate 4 by time of day and by structure (test, spec trim) ==")
for nm, sub in [("09:45-12:00", te[te.hm < 720]), ("12:00-14:00", te[(te.hm >= 720) & (te.hm < 840)]), ("14:00-15:30", te[te.hm >= 840]),
                ("iron", te[te.struct == "iron"]), ("fly_C", te[te.struct == "fly_C"]), ("fly_P", te[te.struct == "fly_P"]),
                ("1 lot", te[te.lots == 1]), ("first 30 s of minute", te[te.u < .5]), ("last 30 s of minute", te[te.u >= .5])]:
    D, F, Do = two(sub, "D", .1, .1), two(sub, "F", .1, .1), two(sub, "D_own", .1, .1)
    print(f"{nm:22s} n {len(sub):7d} D {D:+.2f} F {F:+.2f} D_own {Do:+.2f} |F|/D {abs(F) / D:.3f} {'pass' if abs(F) / D < .25 else 'FAIL'}")

print("\n== what D_own is made of (print level): share and conditional size on each side of the own Pi mid ==")
for nm, p in (("train", tr), ("test", te)):
    up, dn, at = p.D_own > 0.5, p.D_own < -0.5, p.D_own.abs() <= 0.5
    ku, kd = (p.D_own / p.Hown)[up], (-p.D_own / p.Hown)[dn]
    print(f"{nm}: above {up.mean():.3f} (mean {p.D_own[up].mean():+.2f} USD, median {p.D_own[up].median():+.2f}, k mean {ku.mean():.3f} median {ku.median():.3f}) | "
          f"at {at.mean():.3f} | below {dn.mean():.3f} (mean {p.D_own[dn].mean():+.2f}, median {p.D_own[dn].median():+.2f}, k mean {kd.mean():.3f} median {kd.median():.3f})")
    print(f"   plain mean D_own {p.D_own.mean():+.2f} = {up.mean():.3f}*{p.D_own[up].mean():.2f} - {dn.mean():.3f}*{-p.D_own[dn].mean():.2f};"
          f" if both sides paid the same average distance, the count imbalance alone gives {(up.mean() - dn.mean()) * p.D_own[up | dn].abs().mean():+.2f}")
    print(f"   unsigned |D_own|/H_own: mean {(p.D_own.abs() / p.Hown).mean():.3f} median {(p.D_own.abs() / p.Hown).median():.3f};"
          f" signed D_own/H_own mean {(p.D_own / p.Hown).mean():+.3f}")

print("\n== decay of D_own and D_own/H_own (day-level trimmed) ==")
al = pd.concat([tr.assign(per="train"), te.assign(per="test")])
al["half"] = al.date.dt.year.astype(str) + np.where(al.date.dt.month <= 6, "H1", "H2")
al["rel"] = al.D_own / al.Hown
for h, sub in al.groupby("half"):
    print(f"  {h} days {sub.date.nunique():3d} D_own {two(sub, 'D_own', .1, .1):+.2f}  D {two(sub, 'D', .1, .1):+.2f}  D_own/H_own {two(sub, 'rel', .1, .1):+.3f}  H_own {two(sub, 'Hown', .1, .1):.1f}")
