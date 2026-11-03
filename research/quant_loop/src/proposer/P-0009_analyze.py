"""P-0009 analysis. TRAINING PERIOD ONLY.
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0009_analyze.py
"""
import os
import numpy as np
import pandas as pd

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0009_tables")
TRAIN_END = pd.Timestamp("2024-11-01")
df = pd.read_csv(f"{OUT}/legs_all.csv", parse_dates=["date"])
df = df[df.date < TRAIN_END]                           # TIME WALL
rng = np.random.default_rng(20261101)
lines = []
P = lambda *a: (print(*a), lines.append(" ".join(str(x) for x in a)))


def boot(x, n=4000):
    x = np.asarray(x, float); x = x[~np.isnan(x)]
    if len(x) < 3:
        return np.nan, np.nan
    m = rng.choice(x, (n, len(x))).mean(1)
    return np.percentile(m, 2.5), np.percentile(m, 97.5)


def paired(sub, side, t1="14:00", t0="10:30", fomc_ok=False):
    a = sub[(sub.side == side) & sub.ok]
    if not fomc_ok:
        a = a[~a.fomc]
    x = a[a.time == t1].set_index("date"); y = a[a.time == t0].set_index("date")
    j = x.join(y, lsuffix="_1", rsuffix="_0", how="inner")
    return j


def summ(j, tag):
    dd = (j.d_1 - j.d_0); gg = j.g_1 - j.g_0; pp = j.pnl_1 - j.pnl_0
    return {"cell": tag, "n": len(j), "n_D": int(dd.notna().sum()), "D": dd.mean(), "D_lo": boot(dd)[0], "D_hi": boot(dd)[1],
            "G": gg.mean(), "dPnL": pp.mean(), "dPnL_lo": boot(pp)[0], "dPnL_hi": boot(pp)[1],
            "dPnL_k05": (j.pnl_k05_1 - j.pnl_k05_0).mean(), "dPnL_k0": (j.pnl_k0_1 - j.pnl_k0_0).mean(),
            "pnl14": j.pnl_1.mean(), "pnl1030": j.pnl_0.mean(), "win14": (j.pnl_1 > 0).mean(), "win1030": (j.pnl_0 > 0).mean(),
            "dist14": j.dist_I_1.median(), "dist1030": j.dist_I_0.median()}


jc, jp = paired(df, "C"), paired(df, "P")
res = [summ(jc, "call"), summ(jp, "put")]
D2 = (res[0]["D"] + res[1]["D"]) / 2; G2 = (res[0]["G"] + res[1]["G"]) / 2
P("== main (FOMC excluded), 14:00 - 10:30 paired")
for r in res:
    P({k: (round(v, 4) if isinstance(v, float) else v) for k, v in r.items()})
P("D_2", round(D2, 4), "G_2", round(G2, 4))

# month labels: union of paired days, sign of monthly median settle - F_10:30
days = sorted(set(jc.index) | set(jp.index))
lab = df[(df.time == "10:30") & df.date.isin(days)].drop_duplicates("date").set_index("date")
lab["m"] = lab.index.to_period("M"); lab["x"] = lab.settle - lab.F
mlab = lab.groupby("m").x.median().apply(lambda v: "up" if v > 0 else "down")
cells = []
def seg(name, fc, fp):
    rc, rp = summ(jc[fc(jc)], "call"), summ(jp[fp(jp)], "put")
    cells.append({"cell": name, "n_call": rc["n"], "n_put": rp["n"], "D_call": rc["D"], "D_put": rp["D"],
                  "D_2": (rc["D"] + rp["D"]) / 2, "G_2": (rc["G"] + rp["G"]) / 2,
                  "dPnL_call": rc["dPnL"], "dPnL_put": rp["dPnL"]})
seg("all", lambda j: j.index == j.index, lambda j: j.index == j.index)
for s in ("down", "up"):
    f = lambda j, s=s: j.index.to_period("M").map(mlab).values == s
    seg(f"month_{s}", f, f)
for y in (2022, 2023, 2024):
    f = lambda j, y=y: j.index.year == y
    seg(f"y{y}", f, f)
i1030 = df[(df.time == "10:30")].drop_duplicates("date").set_index("date").I
c1, c2 = i1030.quantile([1/3, 2/3])
P("I_10:30 tercile cuts", round(c1, 2), round(c2, 2))
for nm, lo, hi in (("I_low", -1, c1), ("I_mid", c1, c2), ("I_high", c2, 1e9)):
    f = lambda j, lo=lo, hi=hi: (j.I_0 > lo) & (j.I_0 <= hi)
    seg(nm, f, f)
seg("prevdrop<=-1%", lambda j: j.spx_ret_prev_0 <= -0.01, lambda j: j.spx_ret_prev_0 <= -0.01)
cdf = pd.DataFrame(cells); cdf.to_csv(f"{OUT}/cells.csv", index=False)
P("== cells"); P(cdf.round(4).to_string(index=False))

# monotonicity: 12:00, 13:00 vs 10:30
P("== monotonicity (two-sided avg d diff vs 10:30) and per-time unpaired")
mono = []
for t in ("12:00", "13:00", "14:00"):
    a, b = paired(df, "C", t1=t), paired(df, "P", t1=t)
    da, db = (a.d_1 - a.d_0).mean(), (b.d_1 - b.d_0).mean()
    mono.append({"time": t, "n_call": len(a), "n_put": len(b), "D_call": da, "D_put": db, "D_2": (da + db) / 2,
                 "dPnL_call": (a.pnl_1 - a.pnl_0).mean(), "dPnL_put": (b.pnl_1 - b.pnl_0).mean()})
mdf = pd.DataFrame(mono); mdf.to_csv(f"{OUT}/monotone.csv", index=False); P(mdf.round(4).to_string(index=False))
un = df[df.ok & ~df.fomc].groupby(["side", "time"]).agg(n=("pnl", "size"), pnl=("pnl", "mean"), win=("pnl", lambda x: (x > 0).mean()),
                                                     d=("d", "mean"), g=("g", "mean"), dist_I=("dist_I", "median"))
un.to_csv(f"{OUT}/unpaired.csv"); P(un.round(4).to_string())
# FOMC included
P("== FOMC included")
for s in ("C", "P"):
    P(s, {k: (round(v, 4) if isinstance(v, float) else v) for k, v in summ(paired(df, s, fomc_ok=True), s).items() if k in ("n", "D", "G", "dPnL")})
# by-year pnl
yr = []
for s, j in (("call", jc), ("put", jp)):
    for y, g in j.groupby(j.index.year):
        yr.append({"side": s, "year": y, "n": len(g), "pnl14": g.pnl_1.mean(), "pnl1030": g.pnl_0.mean(), "dPnL": (g.pnl_1 - g.pnl_0).mean(),
                   "win14": (g.pnl_1 > 0).mean(), "win1030": (g.pnl_0 > 0).mean()})
ydf = pd.DataFrame(yr); ydf.to_csv(f"{OUT}/pnl_by_year.csv", index=False); P(ydf.round(3).to_string(index=False))
P("sd paired pnl diff call", round((jc.pnl_1 - jc.pnl_0).std(), 1), "corr", round(jc.pnl_1.corr(jc.pnl_0), 3))
open(f"{OUT}/summary.txt", "w").write("\n".join(lines) + "\n")
