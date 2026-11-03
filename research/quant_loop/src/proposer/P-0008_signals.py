"""P-0008 pre-check, SIGNAL ONLY (no settle, no pnl). TRAINING PERIOD ONLY.
s_D = VIX9D close(D-1) / VIX close(D-1). Year composition of training terciles, Spearman with 14:00 I.
    research/spx_fly/.venv/bin/python research/quant_loop/src/proposer/P-0008_signals.py
"""
import os
import pandas as pd
from scipy.stats import spearmanr

R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
HERE = os.path.dirname(os.path.abspath(__file__))
TRAIN_END = pd.Timestamp("2024-11-01")

vt = pd.read_parquet(f"{R}/data/tws/vix_term_1d.parquet")
vt = vt[pd.to_datetime(vt.date) < TRAIN_END]                       # TIME WALL
vx = pd.read_parquet(f"{R}/data/tws/vix_1d.parquet")
vx = vx[pd.to_datetime(vx.date) < TRAIN_END]                       # TIME WALL
cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet")
cal = cal[cal.index < TRAIN_END]                                   # TIME WALL
# signal columns only from the P-0007 day table (I, open, 14:00 spot); outcome columns are not read
d7 = pd.read_csv(f"{HERE}/P-0007_tables/days_all.csv", usecols=["date", "drop", "S", "O", "I"], parse_dates=["date"])
d7 = d7[d7.date < TRAIN_END]                                       # TIME WALL

vt["date"] = pd.to_datetime(vt.date); vx["date"] = pd.to_datetime(vx.date)
v = vt.merge(vx[["date", "vix_close"]], on="date", how="inner").sort_values("date").set_index("date")
v["s"] = v.vix9d_close / v.vix_close
# value known for D = last close strictly before D
days = cal[(~cal.half_day) & cal.has_0dte].index
pos = v.index.searchsorted(days, side="left") - 1
sig = pd.DataFrame({"date": days, "s": v.s.values[pos], "src": v.index.values[pos]})
sig = sig.merge(cal[["spx_ret_prev"]], left_on="date", right_index=True)
df = d7[d7["drop"].isna() | (d7["drop"] == "")].merge(sig, on="date")
df = df[df.spx_ret_prev > -0.01]
df["mom"] = (df.S - df.O).abs() / df.I
print("n", len(df), "lag days max", (df.date - pd.to_datetime(df.src)).dt.days.max())
c1, c2 = df.s.quantile([1 / 3, 2 / 3])
df["st"] = pd.cut(df.s, [-1, c1, c2, 99], labels=["L", "M", "H"])
print("cuts", round(c1, 4), round(c2, 4), "describe", df.s.describe().round(3).to_dict())
print(pd.crosstab(df.st, df.date.dt.year, normalize="index").round(2))
print(pd.crosstab(df.st, df.date.dt.year))
print("spearman s~I", spearmanr(df.s, df.I)[0].round(3), " s~mom", spearmanr(df.s, df.mom)[0].round(3))
it = pd.qcut(df.I, 3, labels=["iL", "iM", "iH"])
print(pd.crosstab(it, df.st))
print("I cuts", df.I.quantile([1 / 3, 2 / 3]).round(2).tolist())
# diagnostic: relation to P-0006's FE = I / VIX prev close (signal only)
df = df.merge(cal[["vix_prev_close"]], left_on="date", right_index=True)
df["FE"] = df.I / df.vix_prev_close
print("spearman s~FE", round(spearmanr(df.s, df.FE)[0], 3), " s~VIXprev", round(spearmanr(df.s, df.vix_prev_close)[0], 3))
for k, g in df.groupby(it, observed=True):
    print(k, "s~FE within I tercile", round(spearmanr(g.s, g.FE)[0], 3), "n", len(g))
