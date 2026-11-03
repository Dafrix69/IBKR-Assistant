"""V-0012 analysis. research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0012_analyze.py train|test
PRE-REGISTERED TEST METRICS (fixed before days_test.csv exists):
 n (PNT non-event / control non-event; exits exact/deferred/held; M missing), G_M + boot95, M_PNT, EV_m (k.20) + boot95,
 win + Wilson95, control EV, dEV, k0 / k0.5, by year (2024-11~12 report only; 2025, 2026 judged), I10/S high tercile
 (train cuts) G_M/EV_m + CI, settle-F10 halves, S14-S10 halves, drop best 5, placebo PNT+1 vs rest of control,
 weekday noise baseline (Tue..Fri vs other control), A diff (afternoon), H, M ~ m + PNT coefficient (HC1) [mechanism],
 + m^2 version, by-year coef, D ~ m + PNT (c), exits 13:00 / 15:00, w +/- 5, corr with baseline A, increment per
 baseline-A day, combined Sharpe / max DD, permutation (PNT labels within PNT u control, 2000 draws, n_PNT fixed,
 two-sided) for G_M, dEV, coef; kept-wing count and residual intrinsic contribution; spec vs proposer wing handling diffs.
"""
import os, sys
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0012_tables")
WALL = pd.Timestamp("2024-11-01")
PHASE = sys.argv[1] if len(sys.argv) > 1 else "train"
df = pd.read_csv(f"{OUT}/days_{PHASE}.csv", parse_dates=["date"])
df = df[df.date < WALL] if PHASE == "train" else df[df.date >= WALL]
rng = np.random.default_rng(20261101)
NB = 10000
L = []
pr = lambda *a: L.append(" ".join(str(x) for x in a))

df = df[df.ok.fillna(False).astype(bool)].copy()
df["M"] = (df.V10 - df.V1400) / df.I10
df["M13"] = (df.V10 - df.V1300) / df.I10
df["M15"] = (df.V10 - df.V1500) / df.I10
df["H"] = (df.V10 - df.pay) / df.I10
df["A"] = df.H - df.M
df["m"] = (df.S14 - df.S10).abs() / df.I10
df["D"] = 1 - (df.I14 / df.I10) ** 2
df["ev"] = df.x1400_k20
df["mid_usd"] = df.M * df.I10 * 100
df["yr"] = df.date.dt.year
P = df[df.pnt & ~df.event].copy()
C = df[~df.pnt & ~df.event].copy()


def wilson(k, n, z=1.96):
    p = k / n; d = 1 + z * z / n; c = p + z * z / (2 * n); h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return 100 * (c - h) / d, 100 * (c + h) / d


def bm(x):
    x = np.asarray(pd.Series(x).dropna(), float)
    if len(x) < 3: return np.nan, np.nan, np.nan
    b = x[rng.integers(0, len(x), (NB, len(x)))].mean(1)
    return x.mean(), np.percentile(b, 2.5), np.percentile(b, 97.5)


def bd(a, b):
    a = np.asarray(pd.Series(a).dropna(), float); b = np.asarray(pd.Series(b).dropna(), float)
    if len(a) < 3 or len(b) < 3: return np.nan, np.nan, np.nan
    s = a[rng.integers(0, len(a), (NB, len(a)))].mean(1) - b[rng.integers(0, len(b), (NB, len(b)))].mean(1)
    return a.mean() - b.mean(), np.percentile(s, 2.5), np.percentile(s, 97.5)


def ols(y, X):
    X = np.column_stack([np.ones(len(y))] + X)
    be = np.linalg.lstsq(X, y, rcond=None)[0]; e = y - X @ be; n, k = X.shape
    XtXi = np.linalg.inv(X.T @ X)
    V = XtXi @ (X.T * e ** 2) @ X @ XtXi * n / (n - k)
    return be, np.sqrt(np.diag(V))


F = lambda t: f"{t[0]:+.4f} [{t[1]:+.3f}, {t[2]:+.3f}]"
U = lambda t: f"{t[0]:+.1f} [{t[1]:+.0f}, {t[2]:+.0f}]"

pr(f"PHASE {PHASE}; ok {len(df)}; PNT non-event {len(P)} (Mon {int((P.wd==0).sum())}); control {len(C)}")
for nm, g in (("PNT", P), ("control", C)):
    pr(f"{nm}: M missing {int(g.M.isna().sum())}; exit14 exact {int((g.xmin1400==0).sum())} deferred {int((g.xmin1400>0).sum())} held {int((g.xmin1400<0).sum())}; "
       f"prop-variant deferred {int((g.xmin1400_prop>0).sum())} held {int((g.xmin1400_prop<0).sum())}; days spec!=prop pnl {int((g.x1400_k20.round(4)!=g.x1400_prop_k20.round(4)).sum())}")
    pr(f"  kept wing days {int((g.kept1400>0).sum())} ({100*(g.kept1400>0).mean():.1f}%), mean resid intrinsic USD {g.resid1400.fillna(0).mean():+.1f}, days resid>0 {int((g.resid1400>0).sum())}")
pr(f"median I10 PNT/C {P.I10.median():.2f}/{C.I10.median():.2f}; median w {P.w.median():.0f}/{C.w.median():.0f}")
pr("")
for nm, col in (("M", "M"), ("H", "H"), ("A", "A"), ("M13", "M13"), ("M15", "M15")):
    pr(f"{nm}: PNT {P[col].mean():+.4f} C {C[col].mean():+.4f} G {F(bd(P[col], C[col]))}")
pr("")
for k in ("k20", "k0", "k50"):
    x, y = P[f"x1400_{k}"], C[f"x1400_{k}"]
    lo, hi = wilson((x > 0).sum(), len(x))
    pr(f"EV_m {k}: {U(bm(x))} win {100*(x>0).mean():.1f}% [{lo:.1f}, {hi:.1f}] | control {y.mean():+.1f} win {100*(y>0).mean():.1f}% | dEV {U(bd(x, y))}")
x = P.ev; cu = x.cumsum()
pr(f"sd {x.std():.0f}; cum {x.sum():+.0f}; maxDD {(cu-cu.cummax()).min():.0f}")
pr(f"mid USD (V10-V14)*100 PNT {P.mid_usd.mean():+.1f} C {C.mid_usd.mean():+.1f}")
pr(f"cost total (mid_usd - pnl k.20) PNT {(P.mid_usd-P.ev).mean():.1f} C {(C.mid_usd-C.ev).mean():.1f}; of which spread k.20 part PNT {(P.x1400_k0-P.ev).mean():.1f}")
pr(f"hold to settle k.20 PNT {P.hold_k20.mean():+.1f} C {C.hold_k20.mean():+.1f}")
for hh in ("1300", "1500"):
    pr(f"exit {hh}: EV_m {U(bm(P[f'x{hh}_k20']))} control {C[f'x{hh}_k20'].mean():+.1f}")
for tg, nm in (("_wm", "w-5"), ("_wp", "w+5")):
    p = P[P[f"ok{tg}"].fillna(False).astype(bool)]; c = C[C[f"ok{tg}"].fillna(False).astype(bool)]
    Mw = lambda g: (g[f"V10{tg}"] - g[f"V1400{tg}"]) / g.I10
    pr(f"{nm}: n {len(p)}/{len(c)} EV_m {U(bm(p[f'x1400{tg}_k20']))} control {c[f'x1400{tg}_k20'].mean():+.1f} G_M {F(bd(Mw(p), Mw(c)))}")
pr("")
pr("by year:")
for y in sorted(df.yr.unique()):
    for lab, sel in ((str(y), lambda g: g.yr == y),):
        pass
segs = [("2022", lambda g: g.yr == 2022), ("2023", lambda g: g.yr == 2023), ("2024", lambda g: g.yr == 2024)] if PHASE == "train" else \
       [("2024-11~12", lambda g: g.yr == 2024), ("2025", lambda g: g.yr == 2025), ("2026", lambda g: g.yr == 2026)]
for lab, sel in segs:
    p, c = P[sel(P)], C[sel(C)]
    if len(p) < 3: continue
    pc = pd.concat([p, c]).dropna(subset=["M", "m"])
    be, se = ols(pc.M.values, [pc.m.values, pc.pnt.astype(float).values])
    pr(f"{lab}: n {len(p)}/{len(c)} G_M {F(bd(p.M, c.M))} EV_m {U(bm(p.ev))} win {100*(p.ev>0).mean():.1f}% control {c.ev.mean():+.1f} coef {be[-1]:+.4f} (t {be[-1]/se[-1]:.2f}) A diff {p.A.mean()-c.A.mean():+.4f}")
pr("")
if PHASE == "train":
    pc = pd.concat([P, C]); r = pc.I10 / pc.S10
    q1, q2 = np.quantile(r, [1/3, 2/3])
    open(f"{OUT}/cuts.txt", "w").write(f"{q1:.8f} {q2:.8f}\n")
q1, q2 = map(float, open(f"{OUT}/cuts.txt").read().split())
pr(f"I10/S cuts (train) {q1:.5f} {q2:.5f}")
for nm, lo_, hi_ in (("low", -1, q1), ("mid", q1, q2), ("high", q2, 9)):
    p = P[(P.I10/P.S10 > lo_) & (P.I10/P.S10 <= hi_)]; c = C[(C.I10/C.S10 > lo_) & (C.I10/C.S10 <= hi_)]
    pr(f"I {nm}: n {len(p)}/{len(c)} G_M {F(bd(p.M, c.M))} EV_m {U(bm(p.ev))} control {c.ev.mean():+.1f}")
pr("")
for nm, sp, sc in (("settle>F10", P.settle > P.F10, C.settle > C.F10), ("settle<=F10", P.settle <= P.F10, C.settle <= C.F10),
                   ("S14>S10", P.S14 > P.S10, C.S14 > C.S10), ("S14<=S10", P.S14 <= P.S10, C.S14 <= C.S10)):
    p, c = P[sp], C[sc]
    pr(f"{nm}: n {len(p)}/{len(c)} G_M {F(bd(p.M, c.M))} EV_m {p.ev.mean():+.1f} control {c.ev.mean():+.1f}")
pr("")
best = P.nlargest(5, "ev"); worst = P.nsmallest(5, "ev")
pr(f"drop best 5: EV_m {P.drop(best.index).ev.mean():+.1f}; G_M {P.drop(best.index).M.mean()-C.M.mean():+.4f}")
pr(f"best5 {list(best.date.dt.strftime('%Y-%m-%d'))} {list(best.ev.round(0))}")
pr(f"worst5 {list(worst.date.dt.strftime('%Y-%m-%d'))} {list(worst.ev.round(0))}")
mon, hol = P[P.wd == 0], P[P.wd != 0]
pr(f"pure Monday n {len(mon)} EV_m {mon.ev.mean():+.1f} M {mon.M.mean():+.4f}; post-holiday non-Mon n {len(hol)} EV_m {hol.ev.mean():+.1f} M {hol.M.mean():+.4f}")
if (P.xmin1400 != 0).any():
    dd = P[P.xmin1400 != 0]
    pr(f"PNT deferred/held days n {len(dd)} EV {dd.ev.mean():+.1f}; rest {P[P.xmin1400==0].ev.mean():+.1f}")
pr("")
PL, CR = C[C.pnt1], C[~C.pnt1]
gpl = bd(PL.M, CR.M); gm = bd(P.M, C.M)
pr(f"placebo PNT+1: n {len(PL)}/{len(CR)} G_M {F(gpl)} EV {PL.ev.mean():+.1f} vs {CR.ev.mean():+.1f}; |placebo| {abs(gpl[0]):.4f} vs |G_M| {abs(gm[0]):.4f}")
for wd in range(1, 5):
    a, b_ = C[C.wd == wd], C[C.wd != wd]
    pr(f"weekday {wd}: n {len(a)} G_M {a.M.mean()-b_.M.mean():+.4f} dEV {a.ev.mean()-b_.ev.mean():+.1f}")
pr("")
pc = pd.concat([P, C]).dropna(subset=["D", "m", "M"])
pn = pc.pnt.astype(float).values; m = pc.m.values
for lab, y, X in (("D~m+PNT", pc.D.values, [m, pn]), ("D~m+m2+PNT", pc.D.values, [m, m**2, pn]),
                  ("M~m+PNT", pc.M.values, [m, pn]), ("M~m+m2+PNT", pc.M.values, [m, m**2, pn])):
    be, se = ols(y, X); pr(f"{lab}: PNT {be[-1]:+.4f} se {se[-1]:.4f} t {be[-1]/se[-1]:.2f} (n {len(y)})")
pr(f"m mean PNT {P.m.mean():.3f} C {C.m.mean():.3f}")
pr("")
# permutation
pcp = pd.concat([P, C]).dropna(subset=["M", "m"]).reset_index(drop=True)
lab = pcp.pnt.values.astype(bool); Mv = pcp.M.values; Ev = pcp.ev.values; mv = pcp.m.values
nP = lab.sum()
def stats(l):
    be, _ = ols(Mv, [mv, l.astype(float)])
    return Mv[l].mean() - Mv[~l].mean(), Ev[l].mean() - Ev[~l].mean(), be[-1]
obs = stats(lab)
prng = np.random.default_rng(7)
perm = np.array([stats(prng.permutation(lab)) for _ in range(2000)])
for i, nm in enumerate(("G_M", "dEV", "coef")):
    p2 = (1 + (np.abs(perm[:, i]) >= abs(obs[i])).sum()) / 2001
    pr(f"perm {nm}: obs {obs[i]:+.4f} two-sided p {p2:.4f}; x64 {min(1, 64*p2):.3f}")
pr("")
wp = pd.read_parquet(f"{R}/data/clean/winrate_panel.parquet")
wp = wp[wp.date < WALL] if PHASE == "train" else wp[wp.date >= WALL]
cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
b = wp[(wp.entry == "14:00") & (wp.structure == "put_fly")].copy()
b["dd"] = (b.w_over_implied - 2).abs()
b = b.sort_values(["date", "dd", "width"]).groupby("date").head(1)
b = b.merge(cal[["spx_ret_prev", "half_day"]], left_on="date", right_index=True)
b = b[~(b.spx_ret_prev <= -0.01) & ~b.half_day.astype(bool)]
pr(f"baseline A: n {len(b)} win {100*(b.pnl>0).mean():.1f}% EV {b.pnl.mean():+.1f}")
bb = b.set_index("date").pnl
both = P[P.date.isin(bb.index)]
pr(f"corr EV_m with same-day base A (n {len(both)}): {np.corrcoef(both.ev, bb.loc[both.date].values)[0,1]:+.3f}")
pr(f"increment per base day {P.ev.sum()/len(bb):+.1f}; morning win {100*(P.ev>0).mean():.1f}% vs base {100*(b.pnl>0).mean():.1f}%")
days = sorted(set(bb.index) | set(P.date))
s0 = pd.Series(0.0, index=days); s0.loc[bb.index] = bb.values
s1 = s0.copy(); s1.loc[P.date.values] += P.ev.values
for nm, s in (("base", s0), ("base+morning", s1)):
    cu = s.cumsum(); pr(f"{nm}: total {s.sum():+.0f} daily sharpe {s.mean()/s.std():.3f} maxDD {(cu-cu.cummax()).min():.0f}")
open(f"{OUT}/summary_{PHASE}.txt", "w").write("\n".join(L) + "\n")
print("\n".join(L))
