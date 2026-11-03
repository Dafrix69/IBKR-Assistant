"""P-0020 analysis (spec 3.2-3.7, gates 5.1).
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0020_analyze.py train
"""
import os
import sys
import numpy as np
import pandas as pd
from scipy.stats import trim_mean

T = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/proposer/P-0020_tables"
SPLIT = pd.Timestamp("2025-11-01")
SEG = pd.Timestamp("2025-05-01")
which = sys.argv[1] if len(sys.argv) > 1 else "train"
assert which == "train"
p = pd.read_parquet(os.path.join(T, f"prints_{which}.parquet"))
p = p[p.date < SPLIT]                                            # time wall (first step after reading)

p["D_v"] = (p.v_ref - p.v_trade) * 100
p["D_own"] = (p.v_own - p.v_trade) * 100
p["F"] = (p.v_ref - p.v_own) * 100
p["P_own"] = p.p_own * 100
p["k_own"] = (p.v_trade - p.v_own).abs() / p.h_own
p["k_ch"] = (p.v_trade - p.v_ref).abs() / p.h_ch
p["k_sell"] = (p.v_own - p.v_trade) / p.h_own
p["slip"] = (p.v_trade - p.v_own).abs()
p["inband"] = (p.v_trade >= p.v_bid - 1e-9) & (p.v_trade <= p.v_ask + 1e-9)
h = p.ts.dt.hour * 60 + p.ts.dt.minute
p["tod"] = np.where(h < 720, "10-12", np.where(h < 840, "12-14", "14-15:30"))
p["wb"] = np.where(p.w == 10, "10", np.where(p.w == 15, "15", "20-25"))
p["sz"] = np.where(p["size"] <= 2, "1-2", ">=3")
p["mny"] = np.where(p.itm, "ITM", "OTM")
rng = np.random.default_rng(20)


def tm(x):
    x = np.asarray(x, float)
    x = x[~np.isnan(x)]
    return trim_mean(x, 0.1) if len(x) else np.nan


def daily(df, col):
    return df.groupby("date")[col].apply(tm).dropna()


def stat(df, col, boot=True):
    dv = daily(df, col)
    est = tm(dv.values)
    if not boot:
        return est, np.nan, np.nan, len(dv)
    v = dv.values
    bs = np.array([tm(v[rng.integers(0, len(v), len(v))]) for _ in range(10000 if len(v) else 0)])
    return est, np.percentile(bs, 2.5), np.percentile(bs, 97.5), len(dv)


def seg(df, col):
    return tm(daily(df[df.date < SEG], col).values), tm(daily(df[df.date >= SEG], col).values)


print(f"prints {len(p)}  days {p.date.nunique()}  per day {len(p)/p.date.nunique():.0f}")
print(f"call {np.mean(p.r=='C'):.3f}  w10/15/20-25 {np.mean(p.wb=='10'):.3f}/{np.mean(p.wb=='15'):.3f}/{np.mean(p.wb=='20-25'):.3f}"
      f"  ITM {p.itm.mean():.3f}  size1-2 {np.mean(p.sz=='1-2'):.3f}  inband {p.inband.mean():.3f}  placebo cov {p.P_own.notna().mean():.3f}")
print("H_own mean / median (pts)", round(p.h_own.mean(), 4), round(p.h_own.median(), 4),
      " Hbar_own (day trimmed)", round(tm(daily(p, 'h_own').values), 4), " H_ch", round(tm(daily(p, 'h_ch').values), 4))
print("|slip| median pts", p.slip.median(), " share slip==0", round(np.mean(p.slip < 1e-9), 3))
print()
print("== gate quantities (day 10% trimmed, USD/spread, bootstrap 10,000, seed 20) ==")
res = {}
for col in ["D_v", "D_own", "F", "P_own"]:
    rng = np.random.default_rng(20)
    e, lo, hi, n = stat(p, col)
    s1, s2 = seg(p, col)
    res[col] = (e, lo, hi, s1, s2)
    print(f"{col:6s} {e:+.3f} [{lo:+.3f}, {hi:+.3f}]  seg {s1:+.3f} / {s2:+.3f}  day-median {daily(p,col).median():+.3f}  ndays {n}")
D = res["D_v"][0]
g1 = res["D_v"][1] > 0
g2 = res["D_v"][3] > 0 and res["D_v"][4] > 0
g3 = abs(res["P_own"][0]) < D / 2
g4 = abs(res["F"][0]) < D / 4
print(f"GATES 1 {g1}  2 {g2}  3 |P_own|<D/2 {g3} ({abs(res['P_own'][0]):.3f} vs {D/2:.3f})  4 |F|<D/4 {g4} ({abs(res['F'][0]):.3f} vs {D/4:.3f})")
print()
print("== k (unsigned) ==")
for col in ["k_own", "k_ch"]:
    rng = np.random.default_rng(20)
    e, lo, hi, n = stat(p, col)
    s1, s2 = seg(p, col)
    q = p[col].replace(np.inf, np.nan).dropna()
    print(f"{col} {e:.3f} [{lo:.3f}, {hi:.3f}] seg {s1:.3f}/{s2:.3f}  print median {q.median():.3f} P25 {q.quantile(.25):.3f} P75 {q.quantile(.75):.3f}")
print()
print("== strata (day trimmed; D_v, D_own, F, P_own, k_own, k_ch, k_sell; n prints) ==")
for name in ["wb", "tod", "r", "sz", "mny", "inband"]:
    for lev, g in p.groupby(name):
        vals = [tm(daily(g, c).values) for c in ["D_v", "D_own", "F", "P_own", "k_own", "k_ch", "k_sell"]]
        hb = tm(daily(g, "h_own").values)
        print(f"{name:6s} {str(lev):9s} n {len(g):8d}  " + "  ".join(f"{v:+.3f}" for v in vals) + f"  H {hb:.3f}")
print()
print("== seller-signed k vs user calibration (spec 3.6) ==")
for lab, g in [("all", p), ("1-lot 10-14", p[(p["size"] == 1) & (p.tod != "14-15:30")])]:
    k = g.k_sell
    print(f"{lab:12s} n {len(g)}  k_sell median {k.median():+.3f} mean {k.mean():+.3f} trimmed-day {tm(daily(g,'k_sell').values):+.3f}"
          f"  share k<=0 {np.mean(k<=0):.3f} <=0.25 {np.mean(k<=0.25):.3f} <=0.5 {np.mean(k<=0.5):.3f} <=1 {np.mean(k<=1):.3f}"
          f"  | buyer k median {(-k).median():+.3f}")
Hb = tm(daily(p, "h_own").values)
print()
print(f"conversion: Hbar_own {Hb:.4f}  k_open_credit ~ {0.20 + D/(100*Hb):.3f}  k_buyback ~ {0.20 - D/(100*Hb):.3f}")
