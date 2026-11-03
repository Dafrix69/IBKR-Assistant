"""P-0012 training-period analysis. Reads P-0012_tables/days.csv (built by P-0012_build.py).
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0012_analyze.py
"""
import os
import numpy as np
import pandas as pd

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0012_tables")
TRAIN_END = pd.Timestamp("2024-11-01")
df = pd.read_csv(f"{OUT}/days.csv", parse_dates=["date"])
df = df[df.date < TRAIN_END]                           # TIME WALL
rng = np.random.default_rng(12)
NB = 10000

df = df[df.ok.fillna(False).astype(bool)].copy()
df["M"] = (df.V10 - df.V1400) / df.I10
df["M13"] = (df.V10 - df.V1300) / df.I10
df["M15"] = (df.V10 - df.V1500) / df.I10
df["A"] = df.H - df.M
df["m"] = (df.S14 - df.S10).abs() / df.I10
df["D"] = 1 - (df.I14 / df.I10) ** 2
df["mid_usd"] = df.M * df.I10 * 100
df["cost"] = df.mid_usd - df.pnl_x1400                 # round-trip spread (k .20 twice) + fees, on 14:00 exits
df["yr"] = df.date.dt.year
P = df[df.pnt & ~df.event]
C = df[~df.pnt & ~df.event]
lines = []
pr = lambda *a: lines.append(" ".join(str(x) for x in a))


def boot_mean(x):
    x = np.asarray(x.dropna(), float)
    if len(x) < 3:
        return np.nan, np.nan
    bs = x[rng.integers(0, len(x), (NB, len(x)))].mean(1)
    return np.percentile(bs, 2.5), np.percentile(bs, 97.5)


def boot_diff(a, b):
    a = np.asarray(a.dropna(), float); b = np.asarray(b.dropna(), float)
    if len(a) < 3 or len(b) < 3:
        return np.nan, np.nan, np.nan
    bs = a[rng.integers(0, len(a), (NB, len(a)))].mean(1) - b[rng.integers(0, len(b), (NB, len(b)))].mean(1)
    return a.mean() - b.mean(), np.percentile(bs, 2.5), np.percentile(bs, 97.5)


def ols(y, X):
    X = np.column_stack([np.ones(len(y))] + X)
    beta = np.linalg.lstsq(X, y, rcond=None)[0]
    e = y - X @ beta
    n, k = X.shape
    XtXi = np.linalg.inv(X.T @ X)
    V = XtXi @ (X.T * e ** 2) @ X @ XtXi * n / (n - k)
    return beta, np.sqrt(np.diag(V))


def f(x, d=3):
    return f"{x:+.{d}f}" if pd.notna(x) else "nan"


pr(f"n ok {len(df)}; PNT non-event {len(P)} (Mon {int((P.wd==0).sum())}); control {len(C)}")
pr(f"M missing (no 14:00 mid for some leg): PNT {int(P.M.isna().sum())}, control {int(C.M.isna().sum())}")
pr(f"exit timing PNT: 14:00 exact {int((P.xmin1400==0).sum())}, 14:01-14:10 {int((P.xmin1400>0).sum())}, held {int((P.xmin1400<0).sum())}")
pr(f"exit timing control: exact {int((C.xmin1400==0).sum())}, delayed {int((C.xmin1400>0).sum())}, held {int((C.xmin1400<0).sum())}")
pr(f"median I10 PNT/C {P.I10.median():.2f}/{C.I10.median():.2f}; median w {P.w.median():.0f}/{C.w.median():.0f}")
pr("")
pr("== M test (units of I10, mid, no costs) ==")
for nm, col in (("M (10->14)", "M"), ("H (10->settle)", "H"), ("A (14->settle)", "A"), ("M13 (10->13, report)", "M13"), ("M15 (10->15, report)", "M15")):
    g, lo, hi = boot_diff(P[col], C[col])
    pr(f"{nm}: PNT {P[col].mean():+.4f}  C {C[col].mean():+.4f}  G {f(g,4)} [{f(lo,4)}, {f(hi,4)}]")
pr("")
pr("== EV_m (PNT morning segment, USD/day) ==")
for sfx, lab in (("", "k0.20"), ("_k0", "k0"), ("_k05", "k0.5")):
    x = P[f"pnl_x1400{sfx}"]; lo, hi = boot_mean(x)
    y = C[f"pnl_x1400{sfx}"]
    pr(f"{lab}: EV_m {x.mean():+.1f} [{lo:+.1f}, {hi:+.1f}] win {100*(x>0).mean():.1f}%  | control {y.mean():+.1f} win {100*(y>0).mean():.1f}%  | dEV {x.mean()-y.mean():+.1f}")
x = P.pnl_x1400
pr(f"sd {x.std():.0f}; mid USD PNT {P.mid_usd.mean():+.1f} control {C.mid_usd.mean():+.1f}; round-trip cost PNT {P.cost.mean():.1f} control {C.cost.mean():.1f}")
cum = x.cumsum(); pr(f"cum {x.sum():+.0f}; max DD {(cum - cum.cummax()).min():.0f}")
pr(f"hold-to-settle PNT (P-0011 口径) k0.20 {P.pnl_hold.mean():+.1f}; control {C.pnl_hold.mean():+.1f}")
for tag in ("1300", "1500"):
    pr(f"exit {tag} (report): EV_m {P[f'pnl_x{tag}'].mean():+.1f}  control {C[f'pnl_x{tag}'].mean():+.1f}")
pr("")
pr("== by year ==")
for y in (2022, 2023, 2024):
    p, c = P[P.yr == y], C[C.yr == y]
    g = boot_diff(p.M, c.M)
    pr(f"{y}: n {len(p)}/{len(c)}  M {p.M.mean():+.4f}/{c.M.mean():+.4f} G_M {f(g[0],4)} [{f(g[1],3)}, {f(g[2],3)}]  EV_m {p.pnl_x1400.mean():+.1f}  control {c.pnl_x1400.mean():+.1f}")
pr("")
pr("== I10/S terciles (train cuts on PNT u control) ==")
pc = pd.concat([P, C]); r = pc.I10 / pc.S10
q1, q2 = np.quantile(r, [1/3, 2/3]); pr(f"cuts {q1:.5f} {q2:.5f}")
for nm, lo_, hi_ in (("low", -1, q1), ("mid", q1, q2), ("high", q2, 9)):
    p = P[(P.I10/P.S10 > lo_) & (P.I10/P.S10 <= hi_)]; c = C[(C.I10/C.S10 > lo_) & (C.I10/C.S10 <= hi_)]
    g = boot_diff(p.M, c.M)
    pr(f"{nm}: n {len(p)}/{len(c)} G_M {f(g[0],4)} [{f(g[1],3)}, {f(g[2],3)}] EV_m {p.pnl_x1400.mean():+.1f} control {c.pnl_x1400.mean():+.1f}")
pr("")
pr("== sign halves ==")
for nm, sp, sc in (("settle>F10", P.settle > P.F10, C.settle > C.F10), ("settle<=F10", P.settle <= P.F10, C.settle <= C.F10),
                   ("S14>S10", P.S14 > P.S10, C.S14 > C.S10), ("S14<=S10", P.S14 <= P.S10, C.S14 <= C.S10)):
    p, c = P[sp], C[sc]; g = boot_diff(p.M, c.M)
    pr(f"{nm}: n {len(p)}/{len(c)} G_M {f(g[0],4)} [{f(g[1],3)}, {f(g[2],3)}] EV_m {p.pnl_x1400.mean():+.1f}")
pr("")
pr("== robustness ==")
best = P.nlargest(5, "pnl_x1400")
pr(f"drop best 5: EV_m {P.drop(best.index).pnl_x1400.mean():+.1f}; best5 {list(best.date.dt.strftime('%Y-%m-%d'))} {list(best.pnl_x1400.round(0))}")
worst = P.nsmallest(5, "pnl_x1400"); pr(f"worst5 {list(worst.date.dt.strftime('%Y-%m-%d'))} {list(worst.pnl_x1400.round(0))}")
mon, hol = P[P.wd == 0], P[P.wd != 0]
pr(f"pure Monday n {len(mon)} EV_m {mon.pnl_x1400.mean():+.1f} M {mon.M.mean():+.4f}; post-holiday non-Mon n {len(hol)} EV_m {hol.pnl_x1400.mean():+.1f} M {hol.M.mean():+.4f}")
pr("")
pr("== placebo PNT+1 (vs control without PNT+1) ==")
PL, CR = C[C.pnt1], C[~C.pnt1]
g = boot_diff(PL.M, CR.M); pr(f"n {len(PL)}/{len(CR)} G_M {f(g[0],4)} [{f(g[1],3)}, {f(g[2],3)}] EV {PL.pnl_x1400.mean():+.1f} vs {CR.pnl_x1400.mean():+.1f}")
gP = boot_diff(P.M, C.M)[0]; pr(f"|placebo| {abs(g[0]):.4f} vs |G_M| {abs(gP):.4f}")
pr("")
pr("== weekday noise baseline (each weekday vs other non-PNT non-event days; Mon = PNT) ==")
for wd in range(1, 5):
    a, b_ = C[C.wd == wd], C[C.wd != wd]
    pr(f"wd {wd}: n {len(a)} G_M {a.M.mean()-b_.M.mean():+.4f} dEV {a.pnl_x1400.mean()-b_.pnl_x1400.mean():+.1f}")
pr("")
pr("== c and decomposition ==")
pc = pd.concat([P, C]).dropna(subset=["D", "m", "M"])
y = pc.D.values; pn = pc.pnt.astype(float).values; m = pc.m.values
for lab, X in (("D~m+PNT", [m, pn]), ("D~m+m2+PNT", [m, m**2, pn])):
    be, se = ols(y, X); pr(f"{lab}: c {be[-1]:+.4f} se {se[-1]:.4f} t {be[-1]/se[-1]:.2f} (n {len(y)})")
for lab, X in (("M~m+PNT", [m, pn]), ("M~m+m2+PNT", [m, m**2, pn])):
    be, se = ols(pc.M.values, X); pr(f"{lab}: PNT {be[-1]:+.4f} se {se[-1]:.4f} t {be[-1]/se[-1]:.2f}")
pr(f"m mean PNT {P.m.mean():.3f} control {C.m.mean():.3f}")
pr("")
pr("== cost gate ==")
pr(f"mid USD PNT {P.mid_usd.mean():+.1f} vs 1.5 x cost {1.5*P.cost.mean():.1f}")
pr("")
pr("== vs baseline A ==")
basedays = df[df.base_pnl.notna()]
inc = P.pnl_x1400.sum() / len(basedays)
pr(f"base days {len(basedays)}; increment per base day {inc:+.1f}")
both = P[P.base_pnl.notna()]
pr(f"corr with same-day base A (n {len(both)}): {np.corrcoef(both.pnl_x1400, both.base_pnl)[0,1]:+.3f}")
u = df[df.base_pnl.notna() | (df.pnt & ~df.event)].copy()
u["b"] = u.base_pnl.fillna(0); u["mm"] = np.where(u.pnt & ~u.event, u.pnl_x1400, 0)
for lab, s in (("base", u.b), ("base+morning", u.b + u.mm)):
    cu = s.cumsum(); pr(f"{lab}: total {s.sum():+.0f} daily sharpe {s.mean()/s.std():.3f} maxDD {(cu-cu.cummax()).min():.0f}")
open(f"{OUT}/summary.txt", "w").write("\n".join(lines) + "\n")
print("\n".join(lines))
