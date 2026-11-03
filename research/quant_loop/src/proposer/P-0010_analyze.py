"""P-0010 analysis. TRAINING PERIOD ONLY.
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0010_analyze.py
"""
import os
import numpy as np
import pandas as pd

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0010_tables")
TRAIN_END = pd.Timestamp("2024-11-01")
r = pd.read_csv(f"{OUT}/nights.csv", parse_dates=["D", "N"])
r = r[(r.D < TRAIN_END) & (r.N < TRAIN_END)]           # TIME WALL
r = r[(~r.half) & (r.skip.isna() | (r.skip == "")) & r.x_day.notna()].copy()
rng = np.random.default_rng(0)
B = 10000


def boot_mean(v):
    v = np.asarray(v, float); idx = rng.integers(0, len(v), (B, len(v)))
    m = v[idx].mean(1); return v.mean(), np.percentile(m, 2.5), np.percentile(m, 97.5)


r["x_full"] = (r.settle - r.F).abs() / r.I
r["dx"] = r.x_full - r.x_day
r["wk"] = r.nights >= 2
r["rs_on"] = ((r.S0 - r.F) / r.F) ** 2
r["rs_tot"] = ((r.settle - r.F) / r.F) ** 2
r["is_tot"] = (r.I / r.F) ** 2
r["is_on"] = r.is_tot - (r.I0 / r.S0) ** 2


def share(g, idx=None):
    if idx is not None:
        g = g.iloc[idx]
    return g.rs_on.sum() / g.rs_tot.sum() - g.is_on.sum() / g.is_tot.sum(), g.rs_on.sum() / g.rs_tot.sum(), g.is_on.sum() / g.is_tot.sum()


def boot_share(g):
    v = [share(g, rng.integers(0, len(g), len(g)))[0] for _ in range(4000)]
    d, sr, si = share(g)
    return d, np.percentile(v, 2.5), np.percentile(v, 97.5), sr, si


lines = []
def p(*a):
    s = " ".join(str(x) for x in a); print(s); lines.append(s)

p("n nights", len(r), "weekend", int(r.wk.sum()), "1-night", int((~r.wk).sum()))
P = boot_mean(r.dx); p("P = mean(x_full - x_day)", np.round(P, 4))
p("x_full mean", round(r.x_full.mean(), 4), "x_day mean", round(r.x_day.mean(), 4), "median x_full/x_day", round(r.x_full.median(), 3), round(r.x_day.median(), 3))
S = boot_share(r); p("s_real - s_imp", np.round(S[:3], 4), "s_real", round(S[3], 4), "s_imp", round(S[4], 4))
pn = boot_mean(r.pnl); p("iron fly pnl k0.20", np.round(pn, 1), "win", round((r.pnl > 0).mean(), 3),
                         "k0.5", round(r.pnl_k05.mean(), 1), "k0", round(r.pnl_k0.mean(), 1), "sd", round(r.pnl.std(), 0))
p("median w/I", round((r.w / r.I).median(), 2), "median I", round(r.I.median(), 1), "median credit pts", round(r.credit.median() / 100, 2), "median cost $ (k0.2 vs k0)", round((r.credit_k0 - r.credit + r.fees).median(), 1))

rows = []
def cell(name, g):
    if len(g) < 5:
        return
    rows.append(dict(cell=name, n=len(g), P=g.dx.mean(), x_full=g.x_full.mean(), x_day=g.x_day.mean(),
                     s_diff=share(g)[0], pnl=g.pnl.mean(), win=(g.pnl > 0).mean()))

cell("all", r)
for y, g in r.groupby(r.D.dt.year):
    cell(f"year {y}", g)
r["ip"] = r.I / r.F
qs = r.ip.quantile([1 / 3, 2 / 3]).values
r["iq"] = np.digitize(r.ip, qs)
for q, g in r.groupby("iq"):
    cell(f"I/F tercile {q}", g)
r["up"] = r.settle > r.F
cell("settle>F", r[r.up]); cell("settle<=F", r[~r.up])
r["sprr"] = r.atm_spr / r.I
m = r.sprr.median()
cell("spr/I low half", r[r.sprr <= m]); cell("spr/I high half", r[r.sprr > m])
cell("1-night", r[~r.wk]); cell("weekend", r[r.wk])
dow = r.D.dt.day_of_week
cell("Mon-night", r[(dow == 0) & ~r.wk]); cell("Tue-night", r[(dow == 1) & ~r.wk])
cell("Wed-night", r[(dow == 2) & ~r.wk]); cell("Thu-night", r[(dow == 3) & ~r.wk])
cell("ex events N", r[~r.evN]); cell("events N", r[r.evN])
cell("ex top5 pnl days", r.drop(r.pnl.nlargest(5).index))
t = pd.DataFrame(rows); t.to_csv(f"{OUT}/cells.csv", index=False)
p(t.round(3).to_string())

wk = boot_mean(r[r.wk].dx)[0] - boot_mean(r[~r.wk].dx)[0]
d_wk = [r[r.wk].dx.sample(frac=1, replace=True, random_state=i).mean() - r[~r.wk].dx.sample(frac=1, replace=True, random_state=10000 + i).mean() for i in range(2000)]
p("H2 P_weekend - P_1night", round(wk, 4), np.round(np.percentile(d_wk, [2.5, 97.5]), 4))
mon, tue = r[(dow == 0) & ~r.wk].dx.mean(), r[(dow == 1) & ~r.wk].dx.mean()
p("placebo P_Mon - P_Tue", round(mon - tue, 4))

bb = r.dropna(subset=["bench"])
p("bench overlap n", len(bb), "corr(pnl, bench)", round(bb[["pnl", "bench"]].corr().iloc[0, 1], 3))
day = r.set_index("N")[["pnl", "bench"]].fillna(0)
sh = lambda v: v.mean() / v.std() * np.sqrt(252)
p("Sharpe bench alone", round(sh(day.bench), 2), "bench+rule", round(sh(day.bench + day.pnl), 2), "rule alone", round(sh(day.pnl), 2))
eq = r.sort_values("N").pnl.cumsum(); p("max drawdown $", round((eq - eq.cummax()).min(), 0))
open(f"{OUT}/summary.txt", "w").write("\n".join(lines) + "\n")
