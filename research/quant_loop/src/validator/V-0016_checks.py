"""V-0016 extra checks: minute rank without closing-session minutes; extreme cells (one-cell means); stale-quote anatomy.
    research/spx_fly/.venv/bin/python research/quant_loop/src/validator/V-0016_checks.py
"""
import numpy as np, pandas as pd, sys
sys.path.insert(0, "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/validator")
R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
V = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/quant_loop/src/validator"
WALL = pd.Timestamp("2025-11-01")
c = pd.read_parquet(f"{V}/V-0016_tables/cells.parquet"); c = c[c.date < WALL]
cal = pd.read_parquet(f"{R}/data/clean/calendar.parquet"); cal = cal[cal.index < WALL]
ev = pd.read_csv(f"{V}/V-0015_events.csv"); au = pd.read_csv(f"{V}/V-0001_auctions.csv")
fomc = set(cal.index[cal.fomc]); auc = set(pd.to_datetime(au.auction_date))
c["base"] = c.date.map(cal.spx_ret_prev) > -0.01
c["event"] = [(h == 13 and (d in auc or d in fomc)) or (h == 15 and d in fomc) for d, h in zip(c.date, c.hour)]
c["G"] = 0.2 * (c.HA - c.HB) * 100
blind = c[(c.minute == 0) & c.base & ~c.event & c.hour.isin([13, 15])]
keys = blind[["date", "hour"]]
pl = c.merge(keys, on=["date", "hour"])
pl = pl[pl.minute.between(3, 57) & ~((pl.hour == 15) & (pl.minute >= 50))]
dm = lambda g: g.dropna(subset=["G"]).groupby("date").G.mean()
obs = dm(blind)
st = pl.groupby("minute").apply(lambda g: pd.Series({"mean": dm(g).mean(), "median": dm(g).median()}))
print("minute rank without 15:50-15:57 (minutes 3..57, incl :15 :30 :45):")
for k in ("mean", "median"):
    print(f"  {k}: hour {obs.agg(k):+.3f}; minutes >= hour: {int((st[k] >= obs.agg(k)).sum())} of {len(st)};"
          f" top: {st[k].sort_values(ascending=False).head(4).round(3).to_dict()}")
st2 = st.drop([15, 30, 45])
print(f"  excluding :15/:30/:45 too: median minutes >= hour {int((st2['median'] >= obs.median()).sum())} of {len(st2)}")
plac = c[(c.minute == 37) & c.base & c.hour.isin([13, 15])]
for nm, g, drop in (("main blind", blind, "2025-04-14"), ("placebo :37", plac, "2025-10-14")):
    v = dm(g); print(f"  {nm}: mean {v.mean():+.3f}; without {drop}: {v.drop(pd.Timestamp(drop)).mean():+.3f};"
                     f" without 2025-04 (whole month): {v[(v.index < '2025-04-01') | (v.index >= '2025-05-01')].mean():+.3f}")
print(c[(c.date == "2025-10-14") & (c.hour == 15) & (c.minute == 37)][["S", "K", "w", "HA", "HB", "medB", "okB", "ageA", "ageB"]].to_string())

# anatomy of 2025-10-14 15:37 window B: per-second leg half-spreads and quote ages
from importlib import import_module
bmod = import_module("V-0016_build")
d = bmod.read_tape(f"{R}/data/raw/SPXW/trade_quote_dte0/2025/20251014.csv.gz")
book = bmod.Book(d)
row = c[(c.date == "2025-10-14") & (c.hour == 15) & (c.minute == 37)].iloc[0]
K, w = row.K, row.w
legs = [(K - w, "P"), (K, "P"), (K, "C"), (K + w, "C")]
t0 = pd.Timestamp("2025-10-14 15:37").value
pts = t0 + ((np.arange(85, 121, 5) + 0.5) * bmod.NS).astype(np.int64)
for l in legs:
    h, a = book.half(l, pts)
    print(f"  leg {l}: half-spread {np.round(h, 2).tolist()}  age s {np.round(a, 1).tolist()}")
