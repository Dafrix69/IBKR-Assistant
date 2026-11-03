"""V-0011 analysis. Same code for both phases; tertile cut points always from the training file.
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0011_analyze.py train
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0011_analyze.py test   # run ONCE

FROZEN TEST METRIC LIST (written 2026-11-01 before days_test.csv existed):
 main  : n PNT / control / all non-PNT; x10 means; G_x (PNT - non-event control) with 95% CI from 10,000
         resamples of each group separately; G_x vs all non-PNT; EV_PNT (k0.20) + bootstrap CI; win rate + Wilson;
         EV_control; dEV + CI; c from OLS D ~ m + PNT (HC1); raw D diff; x_m, x_a, L diffs; PNT max drawdown.
 vs baseline A (protocol): EV_PNT - baseline A test EV (+100, 61.0%); paired PNT-day fly - baseline A (k0.25 panel);
         win rate - 61.0 pp; correlation with baseline A same day.
 cells : year (2024-11~12 / 2025 / 2026 in test); I10/S train tertiles; settle-S10 sign halves; drop PNT best 5;
         k 0 / k 0.5; wing -5 / +5 (neighbour step); pure Monday vs post-holiday; incl-event version;
         control without Thursday (report); placebo Tue - Wed; each weekday x and EV (all ok days incl events vs rest);
         10:30 entry x and fly; 09:35 x.
 multiple comparisons: permutation of PNT label within PNT u control, 2000 shuffles, two-sided p for G_x and dEV.
 descriptive (post hoc, labelled): P(|settle-S10| <= 0.6 I10), P(|settle-S10| <= 12.5).
 Friday-close 1DTE short iron fly: V-0011_friday.py, report only.
"""
import os, sys
import numpy as np
import pandas as pd

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0011_tables")
WALL = pd.Timestamp("2024-11-01")
PHASE = sys.argv[1] if len(sys.argv) > 1 else "train"
B = 10000
rng = np.random.default_rng(1101)


def prep(df):
    df = df.copy()
    df["year"] = df.date.dt.year
    df["wd"] = df.date.dt.day_of_week
    df["event"] = df[["fomc", "cpi", "nfp", "pce"]].astype(bool).any(axis=1)
    df["pnt"] = df.gap >= 2                                       # NaN gap (first calendar day) -> False
    for t in ("0935", "1000", "1030"):
        df["x" + t] = (df.settle - df["S" + t]).abs() / df["I" + t]
    df["D"] = 1 - (df.I1400 / df.I1000) ** 2
    df["m"] = (df.S1400 - df.S1000).abs() / df.I1000
    mv = df.I1000 ** 2 - df.I1400 ** 2
    df["x_m"] = np.where(mv > 0, (df.S1400 - df.S1000).abs() / np.sqrt(mv.clip(lower=1e-12)), np.nan)
    df["x_a"] = (df.settle - df.S1400).abs() / df.I1400
    df["L"] = (df.I0935 / df.S0935) / (df.vix_prev_close / 100 / np.sqrt(252))
    df["IS"] = df.I1000 / df.S1000
    df["up"] = df.settle > df.S1000
    df["in06"] = (df.settle - df.S1000).abs() <= 0.6 * df.I1000
    df["in125"] = (df.settle - df.S1000).abs() <= 12.5
    df["pnl"] = df.pnl1000_k20
    return df


tr = prep(pd.read_csv(f"{OUT}/days_train.csv", parse_dates=["date"]))
tr = tr[tr.date < WALL]
cut = tr[tr.why1000 == "ok"].IS.quantile([1 / 3, 2 / 3]).values  # training cut points
if PHASE == "train":
    df = tr
else:
    df = prep(pd.read_csv(f"{OUT}/days_test.csv", parse_dates=["date"]))
    df = df[df.date >= WALL]
df["Iterc"] = np.digitize(df.IS, cut)

ok = df[df.why1000 == "ok"].copy()
P = ok[ok.pnt & ~ok.event]; C = ok[~ok.pnt & ~ok.event]; A = ok[~ok.pnt]
L = []
def say(s=""):
    print(s); L.append(str(s))


def clean(a):
    a = np.asarray(a, float); return a[~np.isnan(a)]


def bmean(a):
    a = clean(a); i = rng.integers(0, len(a), (B, len(a)))
    return a.mean(), *np.percentile(a[i].mean(1), [2.5, 97.5])


def bdiff(a, b):
    a, b = clean(a), clean(b)
    if len(a) < 3 or len(b) < 3:
        return (np.nan,) * 3
    d = a[rng.integers(0, len(a), (B, len(a)))].mean(1) - b[rng.integers(0, len(b), (B, len(b)))].mean(1)
    return a.mean() - b.mean(), *np.percentile(d, [2.5, 97.5])


def wilson(k, n, z=1.959964):
    p = k / n; den = 1 + z * z / n; c = (p + z * z / (2 * n)) / den; h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return c - h, c + h


def f3(t, nd=3):
    return f"{t[0]:+.{nd}f} [{t[1]:+.{nd}f}, {t[2]:+.{nd}f}]"


def hc1(y, X):
    X = np.column_stack([np.ones(len(y))] + X); y = np.asarray(y, float)
    k = ~np.isnan(y) & ~np.isnan(X).any(1); X, y = X[k], y[k]
    XtXi = np.linalg.inv(X.T @ X); b = XtXi @ X.T @ y; e = y - X @ b; n, p = X.shape
    V = XtXi @ (X.T * e ** 2) @ X @ XtXi * n / (n - p)
    return b, np.sqrt(np.diag(V)), n


def mdd(s):
    c = s.cumsum(); return float((c - c.cummax()).min())


say(f"PHASE {PHASE}; days {len(df)}; fly-ok {len(ok)}; PNT non-event {len(P)}; control {len(C)}; all non-PNT {len(A)}; "
    f"PNT incl events {int(ok.pnt.sum())}; I tertile cuts (train) {cut.round(5).tolist()}")
say(f"skip reasons 10:00: {df.why1000.value_counts().to_dict()}; wing ask=0 among ok: {int(ok.wingask0_1000.sum())}")
say(f"x10 mean PNT {P.x1000.mean():.3f} (median {P.x1000.median():.3f}) control {C.x1000.mean():.3f} (median {C.x1000.median():.3f}) all non-PNT {A.x1000.mean():.3f}")
gx = bdiff(P.x1000, C.x1000); gxa = bdiff(P.x1000, A.x1000)
say(f"G_x vs non-event control {f3(gx)}; vs all non-PNT {f3(gxa)}")
ev = bmean(P.pnl); w = (P.pnl > 0).sum(); wl = wilson(w, len(P))
say(f"EV_PNT k0.20 {f3(ev,1)}; win {w}/{len(P)} = {w/len(P):.3f} Wilson [{wl[0]:.3f}, {wl[1]:.3f}]")
say(f"EV_control {C.pnl.mean():+.1f} win {(C.pnl>0).mean():.3f}; EV all non-PNT {A.pnl.mean():+.1f}")
dev = bdiff(P.pnl, C.pnl); say(f"dEV {f3(dev,1)}")
for kk in ("k0", "k50"):
    say(f"  {kk}: EV_PNT {P['pnl1000_'+kk].mean():+.1f}  dEV {P['pnl1000_'+kk].mean()-C['pnl1000_'+kk].mean():+.1f}")
for nm in ("_wm", "_wp"):
    p_, c_ = P[P['why1000'+nm] == 'ok'], C[C['why1000'+nm] == 'ok']
    say(f"  wing {nm} (w{'-5' if nm=='_wm' else '+5'}): n {len(p_)}/{len(c_)} EV_PNT {p_['pnl1000'+nm+'_k20'].mean():+.1f} "
        f"dEV {p_['pnl1000'+nm+'_k20'].mean()-c_['pnl1000'+nm+'_k20'].mean():+.1f}")
say(f"median I10 PNT {P.I1000.median():.2f} control {C.I1000.median():.2f}; median w PNT {P.w1000.median():.0f}; "
    f"median credit {P.credit1000.median():.2f}; pnl sd PNT {P.pnl.std():.0f} control {C.pnl.std():.0f}")
sub = pd.concat([P, C])
bt, se, n = hc1(sub.D.values, [sub.m.values, sub.pnt.astype(float).values])
say(f"Pred V: D PNT {P.D.mean():.4f} control {C.D.mean():.4f} raw {P.D.mean()-C.D.mean():+.4f}; "
    f"OLS c {bt[2]:+.4f} (HC1 se {se[2]:.4f}, t {bt[2]/se[2]:+.2f}, n {n}); b(m) {bt[1]:+.4f}")
say(f"Pred S: x_m {P.x_m.mean():.3f}/{C.x_m.mean():.3f} diff {f3(bdiff(P.x_m, C.x_m))}; "
    f"x_a {P.x_a.mean():.3f}/{C.x_a.mean():.3f} diff {f3(bdiff(P.x_a, C.x_a))}")
say(f"Pred L: {P.L.mean():.3f}/{C.L.mean():.3f} diff {f3(bdiff(P.L, C.L))}")
say(f"PNT max drawdown {mdd(P.sort_values('date').pnl):.0f}; control max drawdown {mdd(C.sort_values('date').pnl):.0f}; "
    f"PNT total {P.pnl.sum():.0f}")

# baseline A
j = P.dropna(subset=["baseA_k25"])
say(f"\n-- vs baseline A --")
say(f"PNT days with baseline A trade {len(j)}/{len(P)}; corr(fly, baseA) {j.pnl.corr(j.baseA_k25):+.2f}")
pd_ = bmean(j.pnl - j.baseA_k25)
say(f"paired PNT-day fly(k0.20) - baseA(k0.25 panel): {f3(pd_,1)}; baseA EV on these days {j.baseA_k25.mean():+.1f} win {(j.baseA_k25>0).mean():.3f}")
allA = df.dropna(subset=["baseA_k25"])
say(f"baseline A over all {PHASE} days in this file: n {len(allA)} EV {allA.baseA_k25.mean():+.1f} win {(allA.baseA_k25>0).mean():.3f}")
say(f"EV_PNT - baseline A headline: {ev[0]-allA.baseA_k25.mean():+.1f} USD; win - baseline {100*(w/len(P)-(allA.baseA_k25>0).mean()):+.1f} pp")
comb = allA.set_index("date").baseA_k25.copy()
add = P.set_index("date").pnl
both = comb.add(add, fill_value=0)
say(f"baseline A alone: total {comb.sum():.0f} sharpe/day {comb.mean()/comb.std():.3f} mdd {mdd(comb.sort_index()):.0f}; "
    f"A + PNT fly: total {both.sum():.0f} sharpe/day {both.mean()/both.std():.3f} mdd {mdd(both.sort_index()):.0f}")

# cells
rows = []
def cell(name, p, c, col="pnl", xcol="x1000"):
    g = bdiff(p[xcol], c[xcol])
    rows.append(dict(cell=name, n_pnt=len(p), n_ctl=len(c), x_pnt=p[xcol].mean(), x_ctl=c[xcol].mean(), G_x=g[0], G_lo=g[1],
                     G_hi=g[2], EV_pnt=p[col].mean(), EV_ctl=c[col].mean(), dEV=p[col].mean() - c[col].mean(),
                     win_pnt=(p[col] > 0).mean() if len(p) else np.nan, sum_pnt=p[col].sum()))
yrs = sorted(ok.year.unique())
for y in yrs:
    nm = f"year {y}" + (" (11-12)" if y == 2024 and PHASE == "test" else "")
    cell(nm, P[P.year == y], C[C.year == y])
for i, nm in enumerate(("I low", "I mid", "I high")):
    cell(nm, P[P.Iterc == i], C[C.Iterc == i])
cell("settle>S10", P[P.up], C[C.up]); cell("settle<=S10", P[~P.up], C[~C.up])
cell("PNT drop best5", P.drop(P.nlargest(5, "pnl").index), C)
cell("pure Monday", P[P.wd == 0], C); cell("post-holiday (non-Monday)", P[P.wd != 0], C)
cell("incl events: PNT vs all non-PNT", ok[ok.pnt], A)
cell("control excl Thu (report)", P, C[C.wd != 3])
cell("k0.5", P, C, col="pnl1000_k50")
cell("placebo Tue vs Wed", C[C.wd == 1], C[C.wd == 2])
for d_, nm in enumerate(("Mon", "Tue", "Wed", "Thu", "Fri")):
    cell(f"weekday {nm} vs rest (all ok, incl events)", ok[ok.wd == d_], ok[ok.wd != d_])
cells = pd.DataFrame(rows); cells.to_csv(f"{OUT}/cells_{PHASE}.csv", index=False)
say("\n-- cells (G_x vs control; EV USD/day k0.20) --")
say(cells.round(3).to_string(index=False))

say("\n-- other entry times (non-event) --")
for t in ("0935", "1030"):
    p_, c_ = df[df.pnt & ~df.event], df[~df.pnt & ~df.event]
    say(f"x{t}: PNT {p_['x'+t].mean():.3f} (n {p_['x'+t].notna().sum()}) control {c_['x'+t].mean():.3f}  G {f3(bdiff(p_['x'+t], c_['x'+t]))}")
p2 = df[(df.why1030 == "ok") & df.pnt & ~df.event]; c2 = df[(df.why1030 == "ok") & ~df.pnt & ~df.event]
say(f"10:30 fly: EV_PNT {p2.pnl1030_k20.mean():+.1f} dEV {f3(bdiff(p2.pnl1030_k20, c2.pnl1030_k20),1)} (n {len(p2)}/{len(c2)}); "
    f"x1030 among ok: G {f3(bdiff(p2.x1030, c2.x1030))}")
say(f"\nbest 5 PNT: {[(str(a.date()), round(b)) for a, b in P.nlargest(5,'pnl')[['date','pnl']].values]}")
say(f"worst 5 PNT: {[(str(a.date()), round(b)) for a, b in P.nsmallest(5,'pnl')[['date','pnl']].values]}")
say(f"descriptive (post hoc): P(|settle-S10|<=0.6 I10) PNT {P.in06.mean():.3f} control {C.in06.mean():.3f}; "
    f"P(|settle-S10|<=12.5) PNT {P.in125.mean():.3f} control {C.in125.mean():.3f}")

# permutation of PNT label within PNT u control
pool = pd.concat([P, C]); xs = pool.x1000.values; ps = pool.pnl.values; nP = len(P)
obs_g = xs[:nP].mean() - xs[nP:].mean(); obs_d = ps[:nP].mean() - ps[nP:].mean()
pr = np.random.default_rng(2000)
G = np.empty(2000); Dd = np.empty(2000)
for i in range(2000):
    idx = pr.permutation(len(pool)); a, b = idx[:nP], idx[nP:]
    G[i] = xs[a].mean() - xs[b].mean(); Dd[i] = ps[a].mean() - ps[b].mean()
pg2 = (np.abs(G) >= abs(obs_g)).mean(); pd2 = (np.abs(Dd) >= abs(obs_d)).mean()
pg1 = (G <= obs_g).mean(); pd1 = (Dd >= obs_d).mean()
say(f"\npermutation (2000, PNT label within PNT u control): G_x {obs_g:+.3f} two-sided p {pg2:.4f} (one-sided {pg1:.4f}); "
    f"dEV {obs_d:+.1f} two-sided p {pd2:.4f} (one-sided {pd1:.4f}); x52 Bonferroni: {min(1,pg2*52):.3f} / {min(1,pd2*52):.3f}")
open(f"{OUT}/summary_{PHASE}.txt", "w").write("\n".join(L) + "\n")
