"""V-0015 multiplicity (validator-added after the test run): Westfall-Young max-|z| permutation over the
label-dependent test-period cells, 2000 within-(year x weekday) shuffles of the day labels ('', minutes, beige_book).
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0015_maxT.py
"""
import sys
sys.argv = ["x", "test"]
import numpy as np
import pandas as pd
sys.path.insert(0, __file__.rsplit("/", 1)[0])
import importlib.util
spec = importlib.util.spec_from_file_location("vs", __file__.rsplit("/", 1)[0] + "/V-0015_stats.py")
vs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vs)          # applies the test-period wall on load

b = vs.base()
lab = pd.Series(b.etype.where(b.event, ""), index=b.index)
cells = {}
def piv(x, col): return vs.piv(x, col)
x = vs.table()
E = piv(x, "E"); P = piv(x, "pnl")
cells["G main"] = (E["14:00"] - E["13:55"], "any")
cells["G minutes"] = (E["14:00"] - E["13:55"], "minutes")
cells["G beige"] = (E["14:00"] - E["13:55"], "beige_book")
for a in ("13:54", "13:56", "13:58"):
    cells[f"G {a}"] = (E["14:00"] - E[a], "any")
cells["G 14:10-13:55"] = (E["14:10"] - E["13:55"], "any")
for nm, kw in (("cap1", dict(cap=1.0)), ("k05", dict(k=0.5)), ("put", dict(struct="put"))):
    xx = vs.table(**kw); EE = piv(xx, "E")
    cells[f"G {nm}"] = (EE["14:00"] - EE["13:55"], "any")
cells["dPnL"] = (P["13:55"] - P["14:00"], "any")
cells["pnl14"] = (P["14:00"], "any")
xx = x[x.ok].pivot_table(index="date", columns="entry", values="x")
cells["x1355"] = (xx["13:55"], "any")
f = vs.fix.copy(); f.loc[f.widest > 2.0, "H"] = np.nan
H = f.pivot_table(index="date", columns="off", values="H")
step = H[[5, 6]].mean(axis=1) - H[[0, 1, 2, 3, 4]].mean(axis=1)
cells["step"] = (step, "any"); cells["step minutes"] = (step, "minutes"); cells["step beige"] = (step, "beige_book")
cells["P_w"] = (H[0], "any")

strata = b.stratum.to_numpy()
idx = b.index
def stat(v, labels, typ):
    v = v.reindex(idx).to_numpy(float)
    ok = np.isfinite(v)
    tot, n = 0.0, 0
    for s in np.unique(strata):
        m = (strata == s) & ok
        L = labels[m]; vv = v[m]
        e = (L != "") if typ == "any" else (L == typ)
        c = L == ""
        if e.any() and c.any():
            tot += (vv[e] - vv[c].mean()).sum(); n += e.sum()
    return tot / n if n else np.nan
L0 = lab.to_numpy()
obs = {k: stat(v, L0, t) for k, (v, t) in cells.items()}
rng = np.random.default_rng(15015)
NP = 2000
perm = {k: np.empty(NP) for k in cells}
groups = [np.where(strata == s)[0] for s in np.unique(strata)]
for i in range(NP):
    L = L0.copy()
    for g in groups:
        L[g] = L0[g][rng.permutation(len(g))]
    for k, (v, t) in cells.items():
        perm[k][i] = stat(v, L, t)
z = {k: (perm[k] - perm[k].mean()) / perm[k].std() for k in cells}
zobs = {k: (obs[k] - perm[k].mean()) / perm[k].std() for k in cells}
mx = np.max(np.abs(np.vstack([z[k] for k in cells])), axis=0)
print(f"{len(cells)} label-dependent cells, {NP} stratified shuffles")
for k in cells:
    p_raw = (np.sum(np.abs(z[k]) >= abs(zobs[k])) + 1) / (NP + 1)
    p_adj = (np.sum(mx >= abs(zobs[k])) + 1) / (NP + 1)
    print(f"{k:<16} obs {obs[k]:+9.3f}  z {zobs[k]:+6.2f}  two-sided p {p_raw:.4f}  max-T adjusted p {p_adj:.4f}")

# one-sided (pre-declared sign: positive) max-T over the directional cells only
DIR = ["G main", "G minutes", "G beige", "G 13:54", "G 13:56", "G 13:58", "G cap1", "G k05", "G put",
       "step", "step minutes", "step beige"]
mx1 = np.max(np.vstack([z[k] for k in DIR]), axis=0)
print(f"\none-sided max-T over {len(DIR)} directional cells (G / step variants):")
for k in DIR:
    p1 = (np.sum(z[k] >= zobs[k]) + 1) / (NP + 1)
    pa = (np.sum(mx1 >= zobs[k]) + 1) / (NP + 1)
    print(f"{k:<16} z {zobs[k]:+6.2f}  one-sided p {p1:.4f}  max-T adjusted p {pa:.4f}")
