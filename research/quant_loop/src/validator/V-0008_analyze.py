"""V-0008 analysis on my own day table. TRAINING PERIOD ONLY.
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0008_analyze.py
"""
import os
import numpy as np
import pandas as pd
from scipy.stats import spearmanr

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "V-0008_tables")
WALL = pd.Timestamp("2024-11-01")
d = pd.read_parquet(f"{OUT}/days.parquet")
d = d.loc[d.date < WALL]                                         # time wall
d = d.loc[d["drop"] == ""]
d = d.loc[d.ret_prev > -0.01].copy()
assert (pd.to_datetime(d.src) < d.date).all()
print("n", len(d), "max lag days", (d.date - pd.to_datetime(d.src)).dt.days.max(),
      "lag>3 days:", int(((d.date - pd.to_datetime(d.src)).dt.days > 3).sum()))
CUT1, CUT2 = 0.9118, 0.9821
d["st"] = np.where(d.s <= CUT1, "L", np.where(d.s <= CUT2, "H" if False else "M", "H"))
d["x"] = (d.settle - d.S).abs() / d.I
d["mom"] = (d.S - d.O).abs() / d.I
d["it"] = pd.cut(d.I, [-1, 10.6, 14.25, 1e9], labels=["iL", "iM", "iH"])
d["yr"] = d.date.dt.year
d["FE"] = d.I / d.vix_prev
print("states", d.st.value_counts().to_dict(), "own I cuts on 509:", d.I.quantile([1/3, 2/3]).round(2).tolist())
rng = np.random.default_rng(20261101)


def cellstats(h):
    L, H = h.loc[h.st == "L", "x"], h.loc[h.st == "H", "x"]
    return np.array([(L <= .5).mean() - (H <= .5).mean(), (H > 1.5).mean() - (L > 1.5).mean(), H.mean() - L.mean(), len(L), len(H)])


def M(g, minn=3):
    parts = []
    skipped = []
    for it, h in g.groupby("it", observed=True):
        a = cellstats(h)
        if a[3] < minn or a[4] < minn:
            skipped.append(str(it)); continue
        parts.append(a)
    if not parts:
        return dict(Mc=np.nan, Mt=np.nan, Mx=np.nan, nL=0, nH=0, skip=",".join(skipped))
    a = np.array(parts)
    return dict(Mc=a[:, 0].mean(), Mt=a[:, 1].mean(), Mx=a[:, 2].mean(), nL=int(a[:, 3].sum()), nH=int(a[:, 4].sum()),
                skip=",".join(skipped))


rows = []
r = M(d); b = pd.DataFrame([M(d.iloc[rng.integers(0, len(d), len(d))]) for _ in range(2000)])
r.update({k + "_ci": tuple(b[k].quantile([.025, .975]).round(3)) for k in ("Mc", "Mt", "Mx")})
rows.append(dict(cell="all", n=len(d), **r))
for y, g in d.groupby("yr"):
    rows.append(dict(cell=f"year {y}", n=len(g), **M(g)))
for it, g in d.groupby("it", observed=True):
    a = cellstats(g)
    rows.append(dict(cell=f"I {it}", n=len(g), Mc=a[0], Mt=a[1], Mx=a[2], nL=int(a[3]), nH=int(a[4])))
med = d.mom.median()
for lab, g in ((f"mom_hi", d[d.mom > med]), ("mom_lo", d[d.mom <= med])):
    rows.append(dict(cell=lab, n=len(g), **M(g)))
d["mon"] = d.date.dt.to_period("M")
sg = d.groupby("mon").apply(lambda g: np.median(g.settle - g.F) > 0)
d["seg"] = d.mon.map(sg).map({True: "up", False: "down"})
for lab, g in d.groupby("seg"):
    rows.append(dict(cell=f"seg {lab}", n=len(g), **M(g)))
rows.append(dict(cell="no FOMC", n=int((~d.fomc).sum()), **M(d[~d.fomc])))
m = pd.DataFrame(rows)
pd.set_option("display.width", 220)
print(m.round(3).to_string(index=False))
m.to_csv(f"{OUT}/m_cells.csv", index=False)
print("2022 with min-n 1 (rule off):", {k: round(v, 3) if isinstance(v, float) else v for k, v in M(d[d.yr == 2022], 1).items()})
print("2022 cells:\n", d[d.yr == 2022].groupby(["it", "st"], observed=True).size().unstack(fill_value=0))

# pnl
R = np.select([d.st == "L", d.st == "M"], [d.p_w3, d.p_w2], d.p_w15)
for tag in ("", "_k05", "_k0"):
    Rt = np.select([d.st == "L", d.st == "M"], [d[f"p_w3{tag}"], d[f"p_w2{tag}"]], d[f"p_w15{tag}"])
    for base in ("w2", "wB"):
        D = Rt - d[f"p_{base}{tag}"].values
        bs = np.array([D[rng.integers(0, len(D), len(D))].mean() for _ in range(4000)])
        print(f"k{tag or '0.20'} Delta vs {base}: {D.mean():.1f} [{np.quantile(bs,.025):.1f}, {np.quantile(bs,.975):.1f}]")
d["R"] = R; d["D"] = d.R - d.p_w2
print("sd daily D", round(d.D.std(), 1))
print(d.groupby("yr").agg(n=("D", "size"), D=("D", "mean"), R=("R", "mean"), R2=("p_w2", "mean"), B=("p_wB", "mean"),
      winR=("R", lambda s: (s > 0).mean()), winR2=("p_w2", lambda s: (s > 0).mean())).round(3))
print("totals R", round(d.R.mean(), 1), round((d.R > 0).mean(), 3), "R2", round(d.p_w2.mean(), 1), "B", round(d.p_wB.mean(), 1))
d["D3"] = d.p_w3 - d.p_w2; d["D15"] = d.p_w15 - d.p_w2
it = d.groupby("st")[["D3", "D15"]].mean()
print(it.round(1))
I1 = it.loc["L", "D3"] - it.loc["H", "D3"]; I2 = it.loc["H", "D15"] - it.loc["L", "D15"]
bI = []
for _ in range(2000):
    g = d.iloc[rng.integers(0, len(d), len(d))]; t = g.groupby("st")[["D3", "D15"]].mean()
    bI.append((t.loc["L", "D3"] - t.loc["H", "D3"], t.loc["H", "D15"] - t.loc["L", "D15"]))
bI = np.array(bI)
print(f"I1 {I1:.1f} [{np.quantile(bI[:,0],.025):.1f},{np.quantile(bI[:,0],.975):.1f}]  I2 {I2:.1f} [{np.quantile(bI[:,1],.025):.1f},{np.quantile(bI[:,1],.975):.1f}]")
print("within I tercile:\n", d.groupby(["it", "st"], observed=True)[["D3", "D15"]].mean().unstack().round(1))

# ---------- item 3: is "L-state x larger" the P-0006 low-implied level effect? ----------
print("\n=== item 3 ===")
print("mean x by I tercile:", d.groupby("it", observed=True).x.mean().round(3).to_dict())
print("mean I by I tercile x state:\n", d.groupby(["it", "st"], observed=True).I.mean().unstack().round(2))
print("mean x by I tercile x state:\n", d.groupby(["it", "st"], observed=True).x.mean().unstack().round(3))
print("spearman(s,x) all", round(spearmanr(d.s, d.x)[0], 3))
for k, g in d.groupby("it", observed=True):
    print(" ", k, "spearman(s,x)", round(spearmanr(g.s, g.x)[0], 3), "spearman(I,x)", round(spearmanr(g.I, g.x)[0], 3),
          "spearman(s,I)", round(spearmanr(g.s, g.I)[0], 3), "n", len(g))
# continuous control: x ~ log I (+ log FE) OLS, then H-L on residuals, stratified + raw
def ols_resid(y, X):
    X = np.column_stack([np.ones(len(y)), X]); beta = np.linalg.lstsq(X, y, rcond=None)[0]
    return y - X @ beta, beta
def mx_resid(g, cols):
    e, beta = ols_resid(g.x.values, g[cols].values)
    gg = g.assign(x=e)
    return M(gg)["Mx"], (gg.loc[gg.st == "H", "x"].mean() - gg.loc[gg.st == "L", "x"].mean()), beta
d["lI"] = np.log(d.I); d["lFE"] = np.log(d.FE); d["lV"] = np.log(d.vix_prev)
for cols in (["lI"], ["lI", "lFE"], ["lV"], ["lI", "lV"]):
    pt, raw, beta = mx_resid(d, cols)
    bb = []
    for _ in range(2000):
        g = d.iloc[rng.integers(0, len(d), len(d))]
        bb.append(mx_resid(g, cols)[1])
    print(f"x resid on {cols}: beta {np.round(beta,3)}  strat Mx {pt:.3f}  raw H-L {raw:.3f} "
          f"[{np.quantile(bb,.025):.3f},{np.quantile(bb,.975):.3f}]")
    for k, g in d.groupby("it", observed=True):
        e, _ = ols_resid(g.x.values, g[cols].values)
        gg = g.assign(e=e)
        print(f"    {k}: resid H-L {gg.loc[gg.st=='H','e'].mean()-gg.loc[gg.st=='L','e'].mean():.3f}")
# OLS x ~ s + lI with bootstrap on s coefficient
def bs_coef(g, cols):
    X = np.column_stack([np.ones(len(g)), g[cols].values]); return np.linalg.lstsq(X, g.x.values, rcond=None)[0][1]
for cols in (["s"], ["s", "lI"], ["s", "lI", "lFE"], ["s", "lV"]):
    c0 = bs_coef(d, cols); bb = [bs_coef(d.iloc[rng.integers(0, len(d), len(d))], cols) for _ in range(2000)]
    print(f"x ~ {cols}: coef on s {c0:.3f} [{np.quantile(bb,.025):.3f},{np.quantile(bb,.975):.3f}]")
    for y, g in d.groupby("yr"):
        print(f"     {y}: {bs_coef(g, cols):.3f}")
# high-I x L cell
h = d[d.it == "iH"]
print("high-I L cell years:", h[h.st == "L"].yr.value_counts().sort_index().to_dict(),
      " H cell years:", h[h.st == "H"].yr.value_counts().sort_index().to_dict())
for y, g in h.groupby("yr"):
    L, H = g[g.st == "L"].x, g[g.st == "H"].x
    print(f"  high I {y}: nL {len(L)} nH {len(H)} Mx {H.mean()-L.mean() if len(L) and len(H) else np.nan:.3f}")
Lx = h[h.st == "L"].x.sort_values(ascending=False)
print("  high-I L top x:", Lx.head(6).round(2).tolist(), " median L", round(Lx.median(), 3), " median H", round(h[h.st == 'H'].x.median(), 3))
for k in (1, 3, 5):
    print(f"  drop top {k} L days: Mx {h[h.st=='H'].x.mean() - Lx.iloc[k:].mean():.3f}")
print("  high I P(x>1.5) L/H", round((h[h.st=='L'].x > 1.5).mean(), 3), round((h[h.st=='H'].x > 1.5).mean(), 3),
      " P(x<=.5) L/H", round((h[h.st=='L'].x <= .5).mean(), 3), round((h[h.st=='H'].x <= .5).mean(), 3))
# low-I tercile: the P-0006 open cell -- does s separate x there?
l = d[d.it == "iL"]
print("low I: mean x L/M/H", l.groupby("st").x.mean().round(3).to_dict(), "n", l.st.value_counts().to_dict())
# P-0006 level effect visible here? x by FE tercile within I tercile
d["fe_r"] = d.groupby("it", observed=True).FE.transform(lambda s: pd.qcut(s, 2, labels=["lo", "hi"]))
print("x by I tercile x FE half:\n", d.groupby(["it", "fe_r"], observed=True).x.mean().unstack().round(3))
d.to_csv(f"{OUT}/days_analyzed.csv", index=False)
