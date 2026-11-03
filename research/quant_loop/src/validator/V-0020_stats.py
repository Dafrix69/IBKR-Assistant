"""V-0020 stats on validator's own prints (TRAIN ONLY).
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0020_stats.py
"""
import numpy as np
import pandas as pd
from scipy.stats import trim_mean

T = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/validator/V-0020_tables"
HI, SEG = pd.Timestamp("2025-11-01"), pd.Timestamp("2025-05-01")
p = pd.read_parquet(f"{T}/prints_train.parquet")
p = p[p.date < HI]                                                    # time wall
p["D_v"] = (p.v_ref - p.v_trade) * 100
p["D_own"] = (p.v_own - p.v_trade) * 100
p["D_own_last"] = (p.v_own_last - p.v_trade) * 100
p["D_pre"] = (p.v_pre - p.v_trade) * 100
p["D_m"] = (p.v_m - p.v_trade) * 100
p["F"] = (p.v_ref - p.v_own) * 100
p["F_pre"] = (p.v_pre - p.v_own) * 100
p["P_own"] = p.p_own * 100
p["k_own"] = (p.v_trade - p.v_own).abs() / p.h_own
p["k_ch"] = (p.v_trade - p.v_ref).abs() / p.h_ch
p["k_sell"] = (p.v_own - p.v_trade) / p.h_own
p["k_sell_pre"] = (p.v_pre - p.v_trade) / p.h_own
p["slip"] = (p.v_trade - p.v_own).abs()
p["inband"] = (p.v_trade >= p.v_bid - 1e-9) & (p.v_trade <= p.v_ask + 1e-9)
SEED = 20261102


def tm(x):
    x = np.asarray(x, float); x = x[np.isfinite(x)]
    return trim_mean(x, 0.1) if len(x) else np.nan


def daily(df, c):
    return df.groupby("date")[c].apply(tm).dropna()


def est(df, c, B=10000):
    v = daily(df, c).values
    rng = np.random.default_rng(SEED)
    bs = np.array([tm(v[rng.integers(0, len(v), len(v))]) for _ in range(B)])
    s1 = tm(daily(df[df.date < SEG], c).values); s2 = tm(daily(df[df.date >= SEG], c).values)
    return tm(v), np.percentile(bs, 2.5), np.percentile(bs, 97.5), s1, s2, np.median(v)


print(f"prints {len(p)} days {p.date.nunique()} per day {len(p)/p.date.nunique():.0f}  call {np.mean(p.cp=='C'):.3f}"
      f"  inband {p.inband.mean():.4f}  ITM {p.itm.mean():.3f}  pre coverage {p.v_pre.notna().mean():.3f}")
print(f"H_own mean {p.h_own.mean():.4f} med {p.h_own.median():.4f} day-trim {tm(daily(p,'h_own').values):.4f}"
      f"  |slip| med {p.slip.median():.4f} share 0 {np.mean(p.slip<1e-9):.3f}"
      f"  own first!=last share {np.mean(np.abs(p.v_own-p.v_own_last)>1e-9):.4f}")
R = {}
for c in ["D_v", "D_own", "D_own_last", "D_pre", "D_m", "F", "F_pre", "P_own", "k_own", "k_ch", "k_sell", "k_sell_pre"]:
    R[c] = est(p, c)
    e, lo, hi, s1, s2, md = R[c]
    print(f"{c:11s} {e:+.4f} [{lo:+.4f}, {hi:+.4f}] seg {s1:+.4f}/{s2:+.4f} day-med {md:+.4f}")
D = R["D_v"][0]
print("gates: 1", R["D_v"][1] > 0, " 2", R["D_v"][3] > 0 and R["D_v"][4] > 0,
      " 3", abs(R["P_own"][0]) < D / 2, " 4", abs(R["F"][0]) < D / 4, f"(|F| {abs(R['F'][0]):.3f} vs D/4 {D/4:.3f})")
# joint bootstrap F/D_own
dv = pd.concat([daily(p, "F"), daily(p, "D_own"), daily(p, "D_v")], axis=1).dropna().values
rng = np.random.default_rng(SEED)
r = []
for _ in range(5000):
    i = rng.integers(0, len(dv), len(dv)); r.append(tm(dv[i, 0]) / tm(dv[i, 2]))
print(f"F/D_v {tm(dv[:,0])/tm(dv[:,2]):+.2f} [{np.percentile(r,2.5):+.2f}, {np.percentile(r,97.5):+.2f}]")
print("by year D_v / D_own / F:")
for y, g in p.groupby(p.date.dt.year):
    print(" ", y, g.date.nunique(), " ".join(f"{tm(daily(g,c).values):+.3f}" for c in ["D_v", "D_own", "F", "k_own"]))
q = p.k_own.replace(np.inf, np.nan).dropna()
print(f"k_own print median {q.median():.3f} P25 {q.quantile(.25):.3f} P75 {q.quantile(.75):.3f} mean {q.mean():.3f}")
print()
print("strata: D_v D_own D_pre F P_own k_own k_ch k_sell Hbar")
p["wb"] = np.where(p.w == 10, "10", np.where(p.w == 15, "15", "20-25"))
h = p.ts.dt.hour * 60 + p.ts.dt.minute
p["tod"] = np.where(h < 720, "10-12", np.where(h < 840, "12-14", "14-15:30"))
p["sz"] = np.where(p.q <= 2, "1-2", ">=3")
p["mny"] = np.where(p.itm, "ITM", "OTM")
for nm in ["wb", "tod", "cp", "sz", "mny"]:
    for lev, g in p.groupby(nm):
        print(f"{nm:4s} {lev:9s} {len(g):8d} " + " ".join(f"{tm(daily(g,c).values):+.3f}" for c in
              ["D_v", "D_own", "D_pre", "F", "P_own", "k_own", "k_ch", "k_sell"]) + f" {tm(daily(g,'h_own').values):.3f}")
print()
print("k_sell distribution (own NBBO / pre NBBO):")
for lab, g in [("all", p), ("1-lot 10-14", p[(p.q == 1) & (h < 840)])]:
    for c in ["k_sell", "k_sell_pre"]:
        k = g[c].dropna()
        print(f" {lab:12s} {c:10s} n {len(k)} med {k.median():+.3f} mean {k.mean():+.3f} P10 {k.quantile(.1):+.3f} P90 {k.quantile(.9):+.3f}"
              f" <=0 {np.mean(k<=0):.3f} <=.25 {np.mean(k<=.25):.3f} <=.5 {np.mean(k<=.5):.3f} <=1 {np.mean(k<=1):.3f}"
              f"  =0 {np.mean(np.abs(k)<1e-9):.3f} >0 {np.mean(k>1e-9):.3f} <0 {np.mean(k<-1e-9):.3f}")
# where does the trade sit relative to own V NBBO
x = (p.v_trade - p.v_own)
print(f"trade vs V_own: above {np.mean(x>1e-9):.3f} at {np.mean(np.abs(x)<1e-9):.3f} below {np.mean(x<-1e-9):.3f}")
# grid: V_own on .025 half tick vs on .05 grid
odd = (np.round(p.v_own * 1000).astype(int) % 50) != 0
for lab, g in [("V_own off 0.05 grid", p[odd]), ("V_own on 0.05 grid", p[~odd])]:
    xx = g.v_trade - g.v_own
    print(f" {lab}: share {len(g)/len(p):.3f} D_own {tm(daily(g,'D_own').values):+.3f} up {np.mean(xx>1e-9):.3f} down {np.mean(xx<-1e-9):.3f} k_own {tm(daily(g,'k_own').values):.3f}")
Hb = tm(daily(p, "h_own").values)
for c in ["D_v", "D_own"]:
    print(f"conversion via {c}: k_open_credit {0.20 + R[c][0]/(100*Hb):.3f} k_buyback {0.20 - R[c][0]/(100*Hb):.3f}  (H {Hb:.4f})")
print(f"USD per spread: k_own*H*100 = {R['k_own'][0]*Hb*100:.2f}; 0.05 k diff = {0.05*Hb*100:.2f}")
