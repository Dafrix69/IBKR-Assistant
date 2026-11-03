"""P-0012 post-hoc report item: wings left unsold at the 14:00 exit (bid == 0). TRAINING ONLY."""
import os
import pandas as pd
R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0012_tables")
TRAIN_END = pd.Timestamp("2024-11-01")
df = pd.read_csv(f"{OUT}/days.csv", parse_dates=["date"])
df = df[df.date < TRAIN_END]                           # TIME WALL
df = df[df.ok.fillna(False).astype(bool) & ~df.event & (df.xmin1400 == 0)]
res = []
for _, r in df.iterrows():
    ch = pd.read_parquet(f"{R}/data/clean/chain_{r.date:%Y%m%d}.parquet", columns=["strike", "right", "ts", "bid", "flag_bad"])
    ch = ch[ch.ts < TRAIN_END]                         # TIME WALL (per file)
    q = ch[(ch.ts == r.date + pd.Timedelta(hours=14)) & ~ch.flag_bad].set_index(["strike", "right"])
    kept = sum(float(q.loc[k, "bid"]) <= 0 for k in [(r.K + r.w, "C"), (r.K - r.w, "P")])
    res.append((r.pnt, kept))
x = pd.DataFrame(res, columns=["pnt", "kept"])
print(x.groupby("pnt").kept.agg(["count", "mean", lambda s: (s > 0).mean()]))
