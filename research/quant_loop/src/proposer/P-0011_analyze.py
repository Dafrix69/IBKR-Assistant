"""P-0011 analysis. TRAINING PERIOD ONLY.
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0011_analyze.py
"""
import os
import numpy as np
import pandas as pd

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0011_tables")
TRAIN_END = pd.Timestamp("2024-11-01")
df = pd.read_csv(f"{OUT}/days.csv", parse_dates=["date"])
df = df[df.date < TRAIN_END]                           # TIME WALL

rng = np.random.default_rng(11)
B = 10000
df["year"] = df.date.dt.year
for t in ("0935", "1000", "1030", "1400"):
    pass
df["x0935"] = (df.settle - df.S0935).abs() / df.I0935
df["x1000"] = (df.settle - df.S1000).abs() / df.I1000
df["x1030"] = (df.settle - df.S1030).abs() / df.I1030
df["D"] = 1 - (df.I1400 / df.I1000) ** 2
df["m"] = (df.S1400 - df.S1000).abs() / df.I1000
mv = df.I1000 ** 2 - df.I1400 ** 2
df["x_m"] = np.where(mv > 0, (df.S1400 - df.S1000).abs() / np.sqrt(mv.clip(lower=1e-9)), np.nan)
df["x_a"] = (df.settle - df.S1400).abs() / df.I1400
df["L"] = (df.I0935 / df.S0935) / (df.vix_prev_close / 100 / np.sqrt(252))
df["IS"] = df.I1000 / df.S1000
df["up"] = df.settle > df.S1000

ok = df[df.ok1000 == True].copy()
cut = ok.IS.quantile([1 / 3, 2 / 3]).values
ok["Iterc"] = np.digitize(ok.IS, cut)  # 0 low 1 mid 2 high
P = ok[ok.pnt & ~ok.event]
C = ok[~ok.pnt & ~ok.event]
A = ok[~ok.pnt]

lines = []
def say(s=""):
    print(s); lines.append(s)


def boot_diff(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    a, b = a[~np.isnan(a)], b[~np.isnan(b)]
    if len(a) < 3 or len(b) < 3:
        return np.nan, np.nan, np.nan
    ia = rng.integers(0, len(a), (B, len(a))); ib = rng.integers(0, len(b), (B, len(b)))
    d = a[ia].mean(1) - b[ib].mean(1)
    return a.mean() - b.mean(), *np.percentile(d, [2.5, 97.5])


def boot_mean(a):
    a = np.asarray(a, float); a = a[~np.isnan(a)]
    i = rng.integers(0, len(a), (B, len(a)))
    return a.mean(), *np.percentile(a[i].mean(1), [2.5, 97.5])


def fmt(t, nd=3):
    return f"{t[0]:+.{nd}f} [{t[1]:+.{nd}f}, {t[2]:+.{nd}f}]"


def ols_hc1(y, X):
    X = np.column_stack([np.ones(len(y))] + X); y = np.asarray(y, float)
    m = ~np.isnan(y) & ~np.isnan(X).any(1); X, y = X[m], y[m]
    XtXi = np.linalg.inv(X.T @ X); beta = XtXi @ X.T @ y; e = y - X @ beta
    n, k = X.shape
    V = XtXi @ (X.T * e ** 2) @ X @ XtXi * n / (n - k)
    return beta, np.sqrt(np.diag(V)), n


say(f"n ok days {len(ok)}; PNT non-event {len(P)}; control {len(C)}; all non-PNT {len(A)}")
say(f"x1000 mean PNT {P.x1000.mean():.3f}  control {C.x1000.mean():.3f}  allnonPNT {A.x1000.mean():.3f}")
gx = boot_diff(P.x1000, C.x1000); say(f"G_x 10:00 (vs non-event control): {fmt(gx)}")
gxa = boot_diff(P.x1000, A.x1000); say(f"G_x 10:00 (vs all non-PNT): {fmt(gxa)}")
say(f"EV_PNT k0.20: {fmt(boot_mean(P.pnl1000),1)}  win {(P.pnl1000>0).mean():.3f}")
say(f"EV_control: {C.pnl1000.mean():.1f}  win {(C.pnl1000>0).mean():.3f}")
dev = boot_diff(P.pnl1000, C.pnl1000); say(f"dEV: {fmt(dev,1)}")
for s in ("_k0", "_k05"):
    say(f"  {s}: EV_PNT {P['pnl1000'+s].mean():.1f}  dEV {P['pnl1000'+s].mean()-C['pnl1000'+s].mean():.1f}")
say(f"median credit pts PNT {P.credit1000.median():.2f}, I {P.I1000.median():.2f}, w/I {(P.w1000/P.I1000).median():.2f}; "
    f"control I {C.I1000.median():.2f}; pnl sd PNT {P.pnl1000.std():.0f}")

# prediction V
sub = pd.concat([P, C])
beta, se, n = ols_hc1(sub.D.values, [sub.m.values, sub.pnt.astype(float).values])
say(f"Pred V: D mean PNT {P.D.mean():.4f} control {C.D.mean():.4f} raw diff {P.D.mean()-C.D.mean():+.4f}")
say(f"  OLS D ~ m + PNT (n {n}): c = {beta[2]:+.4f} (HC1 se {se[2]:.4f}, t {beta[2]/se[2]:+.2f}); b(m) {beta[1]:+.4f}")
say(f"Pred S: x_m PNT {P.x_m.mean():.3f} control {C.x_m.mean():.3f} diff {fmt(boot_diff(P.x_m, C.x_m))}")
say(f"        x_a PNT {P.x_a.mean():.3f} control {C.x_a.mean():.3f} diff {fmt(boot_diff(P.x_a, C.x_a))}")
say(f"Pred L: L PNT {P.L.mean():.3f} control {C.L.mean():.3f} diff {fmt(boot_diff(P.L, C.L))}")

say("\n-- gates / cells (G_x vs control, dEV) --")
rows = []
def cell(name, p, c):
    g = boot_diff(p.x1000, c.x1000)
    rows.append({"cell": name, "n_pnt": len(p), "n_ctl": len(c), "x_pnt": p.x1000.mean(), "x_ctl": c.x1000.mean(),
                 "G_x": g[0], "G_lo": g[1], "G_hi": g[2], "EV_pnt": p.pnl1000.mean(), "EV_ctl": c.pnl1000.mean(),
                 "dEV": p.pnl1000.mean() - c.pnl1000.mean(), "win_pnt": (p.pnl1000 > 0).mean()})
for y in (2022, 2023, 2024):
    cell(f"year {y}", P[P.year == y], C[C.year == y])
for i, nm in enumerate(("I low", "I mid", "I high")):
    cell(nm, P[P.Iterc == i], C[C.Iterc == i])
cell("settle>S10", P[P.up], C[C.up]); cell("settle<=S10", P[~P.up], C[~C.up])
best5 = P.nlargest(5, "pnl1000").index
cell("PNT drop best5", P.drop(best5), C)
cell("pure Monday (non-event)", P[P.wd == 0], C)
cell("PNT non-Monday", P[P.wd != 0], C)
cell("PNT incl events vs all non-PNT", ok[ok.pnt], A)
cell("control excl Thu (report)", P, C[C.wd != 3])
cell("placebo Tue vs Wed", C[C.wd == 1], C[C.wd == 2])
for wd, nm in enumerate(("Mon", "Tue", "Wed", "Thu", "Fri")):
    cell(f"weekday {nm} (all ok days, incl events) vs rest", ok[ok.wd == wd], ok[ok.wd != wd])
cells = pd.DataFrame(rows); cells.to_csv(f"{OUT}/cells.csv", index=False)
say(cells.round(3).to_string(index=False))

# 10:30 and 09:35 (x only, all days with quotes, non-event)
for t in ("0935", "1030"):
    p = df[df.pnt & ~df.event]; c = df[~df.pnt & ~df.event]
    say(f"x{t}: PNT {p['x'+t].mean():.3f} (n {p['x'+t].notna().sum()}) control {c['x'+t].mean():.3f}  G {fmt(boot_diff(p['x'+t], c['x'+t]))}")
p2 = df[(df.ok1030 == True) & df.pnt & ~df.event]; c2 = df[(df.ok1030 == True) & ~df.pnt & ~df.event]
say(f"10:30 fly: EV_PNT {p2.pnl1030.mean():.1f} dEV {p2.pnl1030.mean()-c2.pnl1030.mean():.1f} (n {len(p2)})")
yb = P.groupby("year").pnl1000.sum(); say(f"PNT pnl sum by year: {yb.round(0).to_dict()}")
j = P.dropna(subset=["base_pnl"])
say(f"corr(PNT 10:00 fly, baseline A same day) {j.pnl1000.corr(j.base_pnl):+.2f} (n {len(j)})")
say(f"best 5 PNT days: {P.nlargest(5,'pnl1000')[['date','pnl1000']].assign(date=lambda z: z.date.dt.date).values.tolist()}")
say(f"worst 5 PNT days: {P.nsmallest(5,'pnl1000')[['date','pnl1000']].assign(date=lambda z: z.date.dt.date).values.tolist()}")
cs = P.sort_values('date').pnl1000.cumsum(); say(f"PNT max drawdown {(cs - cs.cummax()).min():.0f}")

# gates
g = {r["cell"]: r for r in rows}
gates = {
    1: gx[0] >= 0,
    2: sum(g[f"year {y}"]["G_x"] < 0 for y in (2022, 2023, 2024)) < 2,
    3: g["I high"]["G_x"] >= 0,
    4: (abs(gx[0]) < 0.5 * abs(gxa[0])) or (np.sign(gx[0]) != np.sign(gxa[0])),
    5: g["settle>S10"]["G_x"] >= 0 or g["settle<=S10"]["G_x"] >= 0,
    6: (g["PNT drop best5"]["dEV"] <= 0) or (sum(g[f"year {y}"]["dEV"] > 0 for y in (2022, 2023, 2024)) < 2),
    7: P.pnl1000.mean() <= 0,
    8: beta[2] <= 0,
    9: abs(g["placebo Tue vs Wed"]["G_x"]) >= abs(gx[0]),
}
say(f"\nGATES triggered: {[k for k, v in gates.items() if v]}  (all: {gates})")
open(f"{OUT}/summary.txt", "w").write("\n".join(lines) + "\n")
