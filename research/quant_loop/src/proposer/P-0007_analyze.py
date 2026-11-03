"""P-0007 analysis, TRAINING PERIOD ONLY. Reads P-0007_tables/days_all.csv (from P-0007_build.py).
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0007_analyze.py
"""
import os
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0007_tables")
TRAIN_END = pd.Timestamp("2024-11-01")

df = pd.read_csv(f"{OUT}/days_all.csv", parse_dates=["date"])
df = df[df.date < TRAIN_END]                           # TIME WALL
cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
cal = cal[cal.index < TRAIN_END]                       # TIME WALL

rng = np.random.default_rng(20261101)
def boot(x, n=4000):
    x = np.asarray(x, float); x = x[~np.isnan(x)]
    if len(x) < 5: return (np.nan, np.nan)
    m = rng.choice(x, (n, len(x))).mean(1)
    return tuple(np.percentile(m, [2.5, 97.5]).round(3))

drops = df["drop"].fillna("").value_counts().to_dict()
d = df[df["drop"].fillna("") == ""].copy()
d = d.join(cal[["spx_ret_prev", "fomc"]], on="date")
d = d[~(d.spx_ret_prev <= -0.01)]                      # baseline skip
d["year"] = d.date.dt.year
d["sf"] = d.settle - d.F
d["ym"] = d.date.dt.to_period("M")
d["seg"] = np.where(d.ym.map(d.groupby("ym").sf.median()) > 0, "up", "down")
d["moved"] = d.Ks != d.K0
d["hitK"] = (d.settle - d.Ks).abs() <= 2.5
d["hitM"] = (d.settle - (2 * d.S - d.Ks)).abs() <= 2.5
d["m1"] = d.hitK.astype(float) - d.hitM.astype(float)
d["m1pl"] = ((d.settle - d.Kmin).abs() <= 2.5).astype(float) - ((d.settle - (2 * d.S - d.Kmin)).abs() <= 2.5).astype(float)
d["m1d"] = d.m1 - d.m1pl
d["m2"] = np.sign(d.Ks - d.S) * (d.settle - d.S) / d.I
d["side"] = np.where(d.Ks > d.S, "above", "below")
d["openrel"] = np.where(np.sign(d.Ks - d.S) == np.sign(d.O - d.S), "toward_open", "away_open")
d["round25"] = (d.Ks % 25 == 0)
d["conc"] = d.oi_max / d.oi_med.replace(0, np.nan)
for t in ("", "_k05", "_k0"):
    d[f"D{t}"] = d[f"R{t}"] - d[f"R0{t}"]

L = []; P = L.append
mv = d[d.moved]
P(f"drops {drops}; baseline days {len(d)}; oi_ok {d.oi_ok.mean():.3f}; moved {d.moved.mean():.3f} (n {len(mv)}); "
  f"K* round25 share among moved {mv.round25.mean():.3f}; |K*-K0| dist {mv.eval('abs(Ks-K0)').value_counts().to_dict()}")
P(f"base rate P(|settle-K0|<=2.5) all days {((d.settle-d.K0).abs()<=2.5).mean():.3f}")
P(f"R0 (baseline put fly) n {len(d)} win {(d.R0>0).mean():.3f} ev {d.R0.mean():.1f}; R win {(d.R>0).mean():.3f} ev {d.R.mean():.1f}")

def mrow(g, name):
    return {"cell": name, "n": len(g), "hitK": g.hitK.mean(), "hitM": g.hitM.mean(), "M1": g.m1.mean(),
            "M1_ci": boot(g.m1), "M1_pl": g.m1pl.mean(), "M1-M1pl": g.m1d.mean(), "M1d_ci": boot(g.m1d),
            "M2": g.m2.mean(), "M2_ci": boot(g.m2), "D_moved": g.D.mean(), "D_ci": boot(g.D)}

rows = [mrow(mv, "ALL moved")]
for col in ("year", "side", "openrel", "seg", "round25"):
    for k, g in mv.groupby(col):
        rows.append(mrow(g, f"{col}={k}"))
for (a, b), g in mv.groupby(["side", "openrel"]):
    rows.append(mrow(g, f"side={a}&{b}"))
mv = mv.assign(ctier=pd.qcut(mv.conc, 3, labels=["c1", "c2", "c3"]))
for k, g in mv.groupby("ctier", observed=True):
    rows.append(mrow(g, f"conc={k} (diag)"))
for k, g in mv.groupby(mv.fomc.astype(bool)):
    rows.append(mrow(g, f"fomc={k}"))
mt = pd.DataFrame(rows)
mt.to_csv(f"{OUT}/m_cells.csv", index=False)
pd.set_option("display.width", 250)
P("M on moved days:\n" + mt.round(3).to_string(index=False))

def drow(g, name):
    return {"cell": name, "n": len(g), "D": g.D.mean(), "D_ci": boot(g.D), "D_k05": g.D_k05.mean(), "D_k0": g.D_k0.mean(),
            "R": g.R.mean(), "R0": g.R0.mean(), "winR": (g.R > 0).mean(), "winR0": (g.R0 > 0).mean()}
drs = [drow(d, "ALL baseline days")]
for col in ("year", "seg"):
    for k, g in d.groupby(col):
        drs.append(drow(g, f"{col}={k}"))
drs.append(drow(d[~d.fomc.astype(bool)], "no FOMC"))
dt = pd.DataFrame(drs)
dt.to_csv(f"{OUT}/delta.csv", index=False)
P("Delta = R - R0 (USD/day, all baseline days):\n" + dt.round(3).to_string(index=False))
P(f"Delta sd per day {d.D.std():.1f}; on moved days {d[d.moved].D.std():.1f}")
P("toward/away open share among moved: " + str(d[d.moved].openrel.value_counts().to_dict()))
open(f"{OUT}/summary.txt", "w").write("\n".join(L) + "\n")
print("\n".join(L))
