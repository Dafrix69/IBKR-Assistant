"""V-0015 snapshot timing (validator-added after the test run; descriptive, does not enter the verdict).
Which instant does the chain_*.parquet row stamped t (quote_1m) represent?  For near-ATM 0DTE legs on a few
test-period days, compare chain (bid, ask) at t with the last NBBO attached to prints at instants t+offset.
"""
import os
import numpy as np
import pandas as pd
R = "/Users/dafrix/Developer/ibkr/work/datrix-qt/research/spx_fly"
DAYS = ["2025-02-19", "2025-11-19", "2026-02-18", "2026-04-08", "2026-05-20", "2025-06-11", "2026-03-11"]
OFFS = [-5, -1, -0.1, 0.0, 0.5, 1, 5, 30, 59.9]
res = []
for ds in DAYS:
    d = pd.Timestamp(ds)
    c = pd.read_parquet(os.path.join(R, f"data/clean/chain_{d:%Y%m%d}.parquet"), columns=["strike", "right", "ts", "bid", "ask"])
    x = pd.read_csv(os.path.join(R, f"data/raw/SPXW/trade_quote_dte0/{d.year}/{d:%Y%m%d}.csv.gz"),
                    usecols=["strike", "right", "trade_timestamp", "quote_timestamp", "bid", "ask"])
    x["qt"] = pd.to_datetime(x.quote_timestamp)
    x["r"] = x.right.str[0]
    x = x[(x.qt >= d + pd.Timedelta("13:30:00")) & (x.qt <= d + pd.Timedelta("14:31:00"))].sort_values("qt")
    sp = pd.read_parquet(os.path.join(R, "data/clean/spot.parquet"))
    S = float(sp[sp.ts == d + pd.Timedelta("14:00:00")].spot.iloc[0])
    Ks = [round(S / 5) * 5 + 5 * i for i in range(-2, 3)]
    for K in Ks:
        for r in "CP":
            q = x[(x.strike == K) & (x.r == r)]
            if len(q) < 50:
                continue
            ch = c[(c.strike == K) & (c.right == r) & (c.ts >= d + pd.Timedelta("13:30:00")) & (c.ts <= d + pd.Timedelta("14:30:00"))]
            for t, b, a in zip(ch.ts, ch.bid, ch.ask):
                row = {"date": ds, "K": K, "r": r, "t": t, "is1400": t.strftime("%H:%M") == "14:00"}
                for o in OFFS:
                    inst = t + pd.Timedelta(seconds=o)
                    i = q.qt.searchsorted(inst, side="right") - 1
                    if i < 0:
                        row[o] = np.nan
                        continue
                    row[o] = float(abs(q.bid.iloc[i] - b) < 1e-9 and abs(q.ask.iloc[i] - a) < 1e-9)
                res.append(row)
df = pd.DataFrame(res)
print("share of chain rows whose (bid, ask) equals the tick-attached NBBO last seen at t + offset (s):")
print(df[OFFS].mean().round(3).to_string())
print("\n14:00 rows only:")
print(df[df.is1400][OFFS].mean().round(3).to_string(), " n", int(df.is1400.sum()))
