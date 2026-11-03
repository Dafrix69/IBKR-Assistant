"""P-0004 analysis (TRAINING ONLY): implied-anchored vs credit-anchored short leg, 14:00, held to settle.

    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0004_analyze.py
Needs P-0004_build.py output. Writes P-0004_tables/*.csv and prints everything quoted in the spec.
"""
import os
import numpy as np
import pandas as pd

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
CLEAN = os.path.join(R, "data/clean")
T = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0004_tables")
TRAIN_END = pd.Timestamp("2024-11-01")
K, K5 = 0.20, 0.50
M = {("bear_call", 10): 0.15, ("bear_call", 15): 0.41, ("bull_put", 10): 0.05, ("bull_put", 15): 0.32}
SEED, NB = 20261030, 2000

cand = pd.read_parquet(os.path.join(T, "cand.parquet"))
cand = cand[cand.date < TRAIN_END]                                   # TIME WALL: training only
days = pd.read_parquet(os.path.join(T, "days.parquet"))
days = days[days.date < TRAIN_END]                                   # TIME WALL: training only
cal = pd.read_parquet(os.path.join(CLEAN, "calendar.parquet"))
cal = cal[cal.index < TRAIN_END]                                     # TIME WALL: training only

# --- outcomes ---
cand = cand.merge(cal[["settle", "spx_ret_prev"]], left_on="date", right_index=True, how="inner")
sgn = np.where(cand.side == "bear_call", 1.0, -1.0)
cand["loss"] = np.clip(sgn * (cand.settle - cand.k_short), 0, cand.width)
cand["pnl"] = (cand.credit - K * cand.H - cand.loss) * 100 - cand.fee
cand["pnl_k05"] = (cand.credit - K5 * cand.H - cand.loss) * 100 - cand.fee
cand["win"] = cand.pnl > 0
cand = cand.merge(days[["date", "I"]], on="date")
cuts = days.I.quantile([1 / 3, 2 / 3]).values                        # training tercile cut points
cand["Iq"] = pd.cut(cand.I, [-np.inf, cuts[0], cuts[1], np.inf], labels=["low", "mid", "high"])
cand["year"] = cand.date.dt.year

# --- the two rules ---
cand["g_cr"] = (cand.credit - 3.5).abs()
cr = cand.loc[cand.groupby(["date", "side", "width"]).g_cr.idxmin()]
parts = []
for (s, w), m in M.items():
    x = cand[(cand.side == s) & (cand.width == w)].copy()
    x["g_im"] = (x.dist_I - m).abs()
    parts.append(x.loc[x.groupby("date").g_im.idxmin()])
im = pd.concat(parts)
key = ["date", "side", "width"]
cols = ["k_short", "credit", "dist_I", "pnl", "pnl_k05", "win"]
P = im[key + cols + ["I", "Iq", "year", "spx_ret_prev"]].merge(cr[key + cols], on=key, suffixes=("_im", "_cr"))
P["d"] = P.pnl_im - P.pnl_cr
P["d05"] = P.pnl_k05_im - P.pnl_k05_cr
P["diff"] = P.k_short_im != P.k_short_cr
P["inband"] = (P.credit_cr >= 3) & (P.credit_cr <= 4)
P.to_parquet(os.path.join(T, "paired.parquet"), index=False)

rng = np.random.default_rng(SEED)
def boot_mean(v):
    v = np.asarray(v, float)
    if len(v) < 5:
        return np.nan, np.nan
    b = rng.choice(v, (NB, len(v))).mean(1)
    return np.percentile(b, 2.5), np.percentile(b, 97.5)

def row(g, col="d"):
    lo, hi = boot_mean(g[col])
    return pd.Series({"n": len(g), "frac_diff": g["diff"].mean() if "diff" in g else np.nan,
                      "D": g[col].mean(), "lo": lo, "hi": hi})

# daily average over the four cells (only days with all four cells)
day4 = P.groupby("date").filter(lambda g: len(g) == 4)
D = day4.groupby("date").agg(d=("d", "mean"), d05=("d05", "mean"), Iq=("Iq", "first"), year=("year", "first"),
                             diff=("diff", "mean"), ret_prev=("spx_ret_prev", "first"))
pd.set_option("display.width", 200)
out = {}
out["primary"] = pd.DataFrame({"all_k020": row(D), "all_k050": row(D, "d05")}).T
out["by_Iq"] = D.groupby("Iq", observed=True).apply(row)
out["by_year"] = D.groupby("year").apply(row)
out["by_year_Iq"] = D.groupby(["year", "Iq"], observed=True).apply(row)
out["skip_prev_drop"] = pd.DataFrame({"skip_prev<=-1%": row(D[~(D.ret_prev <= -0.01)])}).T
out["by_cell"] = P.groupby(["side", "width"]).apply(row)
out["by_cell_Iq"] = P.groupby(["side", "width", "Iq"], observed=True).apply(row)
out["by_cell_year"] = P.groupby(["side", "width", "year"]).apply(row)
out["by_side"] = P.groupby(["side", "date"]).d.mean().groupby("side").apply(lambda v: row(pd.DataFrame({"d": v})))
out["by_side_Iq"] = P.groupby(["side", "Iq", "date"], observed=True).d.mean().groupby(["side", "Iq"], observed=True).apply(
    lambda v: row(pd.DataFrame({"d": v}))).unstack()
out["inband_cell"] = P[P.inband].groupby(["side", "width"]).apply(row)
out["inband_days"] = pd.DataFrame({"inband_all": row(P[P.inband])}).T

def lvl(g, suf):
    return pd.Series({"n": len(g), "win": g["win" + suf].mean(), "ev": g["pnl" + suf].mean(),
                      "ev_k05": g["pnl_k05" + suf].mean(), "credit": g["credit" + suf].mean()})
out["levels"] = pd.concat({"implied": P.groupby(["side", "width"]).apply(lvl, "_im"),
                           "credit": P.groupby(["side", "width"]).apply(lvl, "_cr")}, axis=1)
out["levels_year"] = pd.concat({"implied": P.groupby(["side", "width", "year"]).apply(lambda g: g.pnl_im.mean()),
                                "credit": P.groupby(["side", "width", "year"]).apply(lambda g: g.pnl_cr.mean())}, axis=1)

# --- P3: which anchor makes the EV surface flat across I terciles ---
cand["cratio"] = cand.credit / cand.width
cand["dI_b"] = pd.cut(cand.dist_I, [-0.2, 0, 0.2, 0.4, 0.6, 0.8])
cand["cr_b"] = pd.cut(cand.cratio, [0.15, 0.25, 0.35, 0.45, 0.55])
p3 = []
for (s, w), g in cand.groupby(["side", "width"]):
    for name, b in (("dist_I", "dI_b"), ("credit_ratio", "cr_b")):
        # one row per day per bucket (mean over strikes in bucket) so days count once
        dd = g.groupby([b, "Iq", "date"], observed=True).pnl.mean().reset_index()
        t = dd.groupby([b, "Iq"], observed=True).pnl.agg(["mean", "size"]).unstack("Iq")
        ok = (t["size"] >= 30).all(axis=1)
        ev = t["mean"][ok]
        rng_ = (ev.max(axis=1) - ev.min(axis=1))
        p3.append({"side": s, "width": w, "anchor": name, "buckets": int(ok.sum()),
                   "mean_range_across_Iq": rng_.mean(), "sd_across_Iq": ev.std(axis=1).mean()})
        ev.round(1).assign(n_min=t["size"][ok].min(axis=1)).to_csv(os.path.join(T, f"p3_{s}_{w}_{name}.csv"))
out["p3"] = pd.DataFrame(p3).set_index(["side", "width", "anchor"])

# --- vs benchmark A (report only): 14:00 put fly, width ~ 2x implied, skip prev <= -1%, k 0.20 + $1 min ---
wp = pd.read_parquet(os.path.join(CLEAN, "winrate_panel.parquet"))
wp = wp[wp.date < TRAIN_END]                                         # TIME WALL: training only
b = wp[(wp.entry == "14:00") & (wp.structure == "put_fly")].copy()
b["gap"] = (b.w_over_implied - 2).abs()
b = b.loc[b.groupby("date").gap.idxmin()]
b["pnl20"] = b.pnl_k0 + (0.20 / 0.25) * (b.pnl - b.pnl_k0) - 2 * (1.00 - 0.65)
b = b.merge(cal[["spx_ret_prev", "half_day"]], left_on="date", right_index=True)
b = b[~b.half_day & ~(b.spx_ret_prev <= -0.01)].set_index("date")
four = day4.groupby("date").pnl_im.sum()
j = pd.concat([four.rename("spreads4_implied"), day4.groupby("date").pnl_cr.sum().rename("spreads4_credit"),
               b.pnl20.rename("benchA")], axis=1, join="inner")
out["vs_benchA"] = j.agg(["count", "mean", "std"]).T

for k, v in out.items():
    v.to_csv(os.path.join(T, f"{k}.csv"))
    print(f"\n=== {k} ===")
    print(v.round(3).to_string())
