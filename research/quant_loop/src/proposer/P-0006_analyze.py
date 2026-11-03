"""P-0006 analysis, TRAINING PERIOD ONLY. Reads P-0006_tables/days_all.csv (from P-0006_shape.py).
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0006_analyze.py
"""
import os
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0006_tables")
TRAIN_END = pd.Timestamp("2024-11-01")
import sys
SUFFIX = "_ific" if len(sys.argv) > 1 and sys.argv[1] == "ific" else ""

df = pd.read_csv(f"{OUT}/days_all{SUFFIX}.csv", parse_dates=["date"])
df = df[df.date < TRAIN_END]                           # TIME WALL
cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
cal = cal[cal.index < TRAIN_END]                       # TIME WALL

rng = np.random.default_rng(20261101)
def boot(x, n=4000):
    x = np.asarray(x, float); x = x[~np.isnan(x)]
    if len(x) < 5: return (np.nan, np.nan)
    m = rng.choice(x, (n, len(x))).mean(1)
    return tuple(np.percentile(m, [2.5, 97.5]).round(1))

drops = df["drop"].fillna("").value_counts().to_dict()
d = df[df["drop"].fillna("") == ""].copy()
d = d.join(cal[["spx_ret_prev", "fomc"]], on="date")
d = d[~(d.spx_ret_prev <= -0.01)]                      # baseline skip
q1, q2 = d.FE.quantile([1/3, 2/3])
d["tier"] = np.where(d.FE <= q1, "L", np.where(d.FE <= q2, "M", "H"))
d["dIC"] = d.IC - d.IF
d["dIC_k05"] = d.IC_k05 - d.IF_k05
d["dIC_k0"] = d.IC_k0 - d.IF_k0
d["year"] = d.date.dt.year
d["R"] = np.where(d.tier == "L", d.IC, d.IF)
d["R_k05"] = np.where(d.tier == "L", d.IC_k05, d.IF_k05)
d["winIF"], d["winIC"], d["winPF"], d["winR"] = d.IF > 0, d.IC > 0, d.PF > 0, d.R > 0
wq1, wq2 = d.w_over_I.quantile([1/3, 2/3])
d["wtier"] = np.where(d.w_over_I <= wq1, "w1", np.where(d.w_over_I <= wq2, "w2", "w3"))
# month segmentation by median sign of settle - F at 14:00 (baseline days)
d["sf"] = d.settle - d.F
d["ym"] = d.date.dt.to_period("M")
msign = d.groupby("ym").sf.median()
d["seg"] = np.where(d.ym.map(msign) > 0, "up", "down")

lines = []
P = lines.append
P(f"drops {drops}; baseline days {len(d)}; FE tercile cuts q1={q1:.5f} q2={q2:.5f}; w/I cuts {wq1:.3f} {wq2:.3f}")
corr = d[["FE", "w_over_I", "I", "vix_prev"]].corr(method="spearman").round(3)
P("spearman:\n" + corr.to_string())

t = d.groupby("tier").agg(n=("G", "size"), FE=("FE", "median"), I=("I", "median"), w=("w", "mean"),
                          G=("G", "mean"), dIC=("dIC", "mean"), dIC_k05=("dIC_k05", "mean"),
                          IF=("IF", "mean"), IC=("IC", "mean"), PF=("PF", "mean"),
                          winIF=("winIF", "mean"), winIC=("winIC", "mean")).reindex(["L", "M", "H"])
t["G_ci"] = [boot(d[d.tier == k].G) for k in t.index]
t["dIC_ci"] = [boot(d[d.tier == k].dIC) for k in t.index]
P("by FE tier:\n" + t.round(2).to_string())
GH, GL = d[d.tier == "H"].G.values, d[d.tier == "L"].G.values
bs = [rng.choice(GH, len(GH)).mean() - rng.choice(GL, len(GL)).mean() for _ in range(4000)]
P(f"G_H - G_L = {GH.mean() - GL.mean():.1f}  CI {np.percentile(bs, [2.5, 97.5]).round(1)}")

y = d.groupby(["year", "tier"]).agg(n=("G", "size"), G=("G", "mean"), dIC=("dIC", "mean")).unstack("tier")
P("by year:\n" + y.round(1).to_string())
w = d[d.tier == "L"].groupby("wtier").agg(n=("dIC", "size"), dIC=("dIC", "mean"), G=("G", "mean"))
P("low tier within w/I terciles:\n" + w.round(1).to_string())
s = d[d.tier == "L"].groupby("seg").agg(n=("dIC", "size"), dIC=("dIC", "mean"), G=("G", "mean"))
P("low tier by settle-F month segment:\n" + s.round(1).to_string())
s2 = d.groupby(["seg", "tier"]).G.mean().unstack()
P("G by segment x tier:\n" + s2.round(1).to_string())
nf = d[~d.fomc.astype(bool)]
P(f"ex-FOMC: low n {int((nf.tier=='L').sum())} dIC {nf[nf.tier=='L'].dIC.mean():.1f}; G_H-G_L {nf[nf.tier=='H'].G.mean()-nf[nf.tier=='L'].G.mean():.1f}")
L = d[d.tier == "L"]
P(f"Delta_L k0.20 {L.dIC.mean():.1f} CI {boot(L.dIC)}; k0.5 {L.dIC_k05.mean():.1f}; k0 {L.dIC_k0.mean():.1f}; sd {L.dIC.std():.0f}")
summ = pd.DataFrame({
    "rule": ["PF (protocol baseline)", "IF every day (R0)", "R: IC on L, IF else", "IC every day"],
    "n": [len(d)] * 4,
    "win": [d.winPF.mean(), d.winIF.mean(), d.winR.mean(), d.winIC.mean()],
    "ev": [d.PF.mean(), d.IF.mean(), d.R.mean(), d.IC.mean()],
    "ev_k05": [d.PF_k05.mean(), d.IF_k05.mean(), d.R_k05.mean(), d.IC_k05.mean()],
})
P("rules:\n" + summ.round(3).to_string(index=False))
P(f"R - R0 per day {(d.R - d.IF).mean():.1f} CI {boot(d.R - d.IF)}")
open(f"{OUT}/summary{SUFFIX}.txt", "w").write("\n\n".join(lines))
t.to_csv(f"{OUT}/by_tier{SUFFIX}.csv"); y.to_csv(f"{OUT}/by_year{SUFFIX}.csv")
print("\n\n".join(lines))
